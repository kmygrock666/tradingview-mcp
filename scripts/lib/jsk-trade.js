/**
 * 極速匡策略的下單層：把 3H 紅吞信號換算成訂單，並記錄交易帳本。
 *
 * 進出規則（使用者 2026-10-16 定義）：
 *   進場價 = 紅吞「前一根」的最高價   ← 掛限價單等回踩，不追價
 *   停損價 = 紅吞「前一根」的最低價
 *   R      = 進場價 − 停損價
 *   停利   = 進場 + 5R 與 進場 + 10R 兩批，各半部位
 *   單筆風險 = 權益 × 2%（總資金虧損 >20% 時降為 0.5%）
 *   限價單 9 小時（3 根 3H K 棒）內沒成交就取消
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { accountSummary, placeLimitBracket, listOrders, cancelOrders, closeTicket, openExposure, ensureTradingPanel, listPositions, rebuildPositionExits, setPositionSimpleExits, chartLastPrice } from './paper-order.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNAL = path.join(ROOT, 'trades-jskuang.jsonl');

export const STRATEGY_VERSION = 'v5';  // 進場條件版本，寫進帳本方便分開統計
export const RISK_PCT = 0.02;          // 單筆風險 = 權益的 2%
export const TP_MULTIPLES = [5, 10];   // 舊版（v2）的 R 倍數停利，fibBar 缺席時的後備
// ── v3 斐波那契定價（使用者 2026-10-25）──────────────────
// 錨點是條件 4 找到的那根 3H 黑K：1 = 黑K高點、0 = 黑K低點。
// 進場掛在 0.7，停損在 0（黑K低點），停利分四段。
export const FIB_ENTRY = 0.7;
export const FIB_TARGETS = [10.8, 20.8, 30.8, 50.8];
export const ORDER_TTL_MS = 9 * 3600 * 1000;  // 限價單有效期：3 根 3H K 棒
const LEVERAGE = 10;                   // 帳戶顯示 10x；用來估保證金夠不夠
const MARGIN_USE_CAP = 0.4;            // 單一信號最多動用 40% 可用資金
const MIN_AVAILABLE_PCT = 0.25;        // 可用資金低於權益的 25% 就不再開新倉

// ── 回撤降風險（使用者 2026-10-18 要求）──────────────────
// 總資金虧損超過 20% 就把單筆風險從 2% 調降到 0.5%，讓策略在逆風時
// 自動縮小部位，不必等人介入。基準是「實驗起始權益」，不是歷史最高點 ——
// 照字面的「總資金虧損」解釋；要改成以最高點計算把 INITIAL_EQUITY 換掉即可。
// 2026-10-24 進場條件改版（v2 回踩買進），舊策略的 206 筆已歸檔到
// trades-jskuang-v1-20261023.jsonl，基準權益重設為改版當下的數字，
// 回撤與風險分檔都從這裡重新起算（舊策略最終權益 973.75 → 492.13）。
export const INITIAL_EQUITY = 492.13;      // 2026-10-24 v2 起始權益
export const DRAWDOWN_TRIGGER = 0.20;      // 虧損超過 20%
export const RISK_PCT_REDUCED = 0.005;     // 觸發後的單筆風險

/** 依目前權益決定要用哪一檔風險 */
export function riskProfile(equity) {
  const drawdown = (INITIAL_EQUITY - equity) / INITIAL_EQUITY;
  const reduced = drawdown > DRAWDOWN_TRIGGER;
  return { pct: reduced ? RISK_PCT_REDUCED : RISK_PCT, drawdown, reduced };
}

/** OKX:SOLUSDT.P / BINANCE:SOLUSDT.P → SOL（判斷是不是同一個幣） */
export function baseAsset(symbol) {
  return String(symbol).split(':').pop().replace(/\.P$/, '').replace(/USDT$|USD$|PERP$/, '');
}

/**
 * 依數量級取合理的小數位，避免送出 1947.3333333 這種數字。
 *
 * 小量一律只留 2 位：數量必須落在商品的步長上，超過的位數會被後端靜默拒單 ——
 * 不報錯、畫面也沒提示，單就是不會出現。BNBUSDT 2026-10-26 連兩輪失敗就是
 * 這樣：每批 0.342382（舊版對 <1 的數量給 6 位），實測改成 0.34 就立刻掛上。
 *
 * 2 位是保守值：常見的步長 0.01 / 0.001 都整除得了。真的遇到步長 0.1 或整數的
 * 商品還是會被拒，但那時 placeSignalOrders 的落地驗證會把它記成 failed，
 * 不會再假報成功。
 */
function roundQty(q) {
  if (!isFinite(q) || q <= 0) return 0;
  if (q >= 1000) return Math.round(q);
  return Math.round(q * 100) / 100;
}

/**
 * 價格小數位比照同一商品的參考價，避免 0.1 + 5*0.01 = 0.15000000000000002。
 *
 * 位數只能「不超過」參考價，絕對不能加寬：參考價是這個商品的真實報價，
 * 它的位數就是商品精度的上限。之前這裡寫 decimals + 2，算出的停利
 * 0.258762（6 位）送進只吃 5 位的 ORDERUSDT，TradingView 自己截成
 * 0.25876，讀回驗證就永遠對不上、整張單卡死。位數取少不會出事 ——
 * 粗格上的價格一定也落在細格上。
 * 多個參考價時取最寬的那個，停利才不會被不必要地截粗。
 */
function roundPrice(p, ...refs) {
  // 整數報價（BTC 110000）就是 0 位，不能像以前那樣退回 8 位 —— 同樣會被截
  const decimals = Math.max(0, ...refs
    .filter(r => r != null && isFinite(r))
    .map(r => (String(r).split('.')[1] || '').length));
  return +p.toFixed(Math.min(decimals, 10));
}

/**
 * 由「紅吞前一根」K 棒算出完整的下單計畫。
 * prevBar 需含 high / low。
 */
export function computePlan({ prevBar, fibBar, entryPrice, stopPrice, equity, available }) {
  // v4.1（2026-10-25）：進場與停損改由條件 3 明確指定 ——
  //   進場＝3H 連續黑K 最後一根的開盤價、停損＝當前 3H K 棒的最低點。
  //   斐波那契（條件 3 的黑K）仍留著，負責四段停利的價位。
  if (entryPrice != null && stopPrice != null) {
    const span = fibBar ? fibBar.high - fibBar.low : null;
    const targetsExplicit = (span > 0)
      ? FIB_TARGETS.map(lvl => ({ multiple: lvl,
          price: roundPrice(fibBar.low + lvl * span, fibBar.low, fibBar.high, entryPrice, stopPrice) }))
      : null;
    return finishPlan({
      entry: entryPrice, stop: stopPrice, targetPrices: targetsExplicit, equity, available,
    });
  }
  return computePlanLegacy({ prevBar, fibBar, equity, available });
}

/** 舊的推導方式：有 fibBar 就用 0.7/0，否則用 prevBar 的高低點 */
function computePlanLegacy({ prevBar, fibBar, equity, available }) {
  // v3（2026-10-25）：價格全部由條件 4 的黑K 拉斐波那契決定 ——
  //   1 = 黑K 高點、0 = 黑K 低點，進場在 0.7、停損在 0、
  //   停利四段分別在 10.8 / 20.8 / 30.8 / 50.8。
  // 舊的 prevBar 介面（進場＝高點、停損＝低點）留著當後備。
  let entry, stop, targetPrices;
  if (fibBar) {
    const span = fibBar.high - fibBar.low;
    if (!(span > 0)) return { ok: false, reason: `斐波那契區間不是正數（高 ${fibBar.high} 低 ${fibBar.low}）` };
    const at = (lvl) => roundPrice(fibBar.low + lvl * span, fibBar.low, fibBar.high);
    entry = at(FIB_ENTRY);
    stop = at(0);
    targetPrices = FIB_TARGETS.map(lvl => ({ multiple: lvl, price: at(lvl) }));
  } else {
    entry = prevBar.high;
    stop = prevBar.low;
    targetPrices = null;
  }
  return finishPlan({ entry, stop, targetPrices, equity, available });
}

/** 共用的收尾：R、風險檔、數量、保證金上限、各批數量 */
function finishPlan({ entry, stop, targetPrices, equity, available }) {
  const R = entry - stop;
  if (!(R > 0)) return { ok: false, reason: `R 不是正數（進場 ${entry} 停損 ${stop}）` };

  const risk = riskProfile(equity);
  const riskUSD = +(equity * risk.pct).toFixed(2);
  let qtyTotal = riskUSD / R;

  // 保證金夠不夠：名目 = 數量 × 進場價，保證金 ≈ 名目 / 槓桿
  const capNotional = (available || equity) * LEVERAGE * MARGIN_USE_CAP;
  let capped = false;
  if (qtyTotal * entry > capNotional) {
    qtyTotal = capNotional / entry;
    capped = true;
  }

  // 停利價必須都在進場之上，否則送單一定被拒
  const targets = (targetPrices || TP_MULTIPLES.map(m => ({ multiple: m, price: roundPrice(entry + m * R, entry) })))
    .filter(t => t.price > entry);
  if (!targets.length) return { ok: false, reason: `所有停利價都不在進場價 ${entry} 之上` };

  // 每批數量：先用保守的 2 位；高價商品（BTC 這種 R 動輒幾百）在這個精度下
  // 會直接歸零，那時退到 3 位 —— 0.001 是高價幣常見的步長，仍然合法。
  // 寧可從粗到細逐步放寬，也不要一開始就給太多位數被後端靜默拒單。
  const rawEach = qtyTotal / targets.length;
  let qtyEach = roundQty(rawEach);
  if (qtyEach <= 0) qtyEach = Math.round(rawEach * 1000) / 1000;
  if (qtyEach <= 0) {
    return { ok: false,
             reason: `每批數量取到小數 3 位仍是 0（風險 ${riskUSD} USD / R ${R}，總量 ${rawEach.toFixed(8)}）` };
  }
  // 總量必須剛好等於每批 × 批數，不能再獨立四捨五入 —— 否則進場單的數量會跟
  // 四層出場加起來對不上（BTC 實測：每批 0.004、四層 0.016，總量卻被 roundQty
  // 進位成 0.02），保護倉位大小驗證過不了。toFixed 只是清掉浮點誤差。
  const exactTotal = +(qtyEach * targets.length).toFixed(6);

  return {
    ok: true, entry, stop, R, targets,
    qtyEach, qtyTotal: exactTotal,
    riskUSD, equity, capped,
    riskPct: risk.pct, drawdown: risk.drawdown, riskReduced: risk.reduced,
    // 實際風險：數量被保證金上限砍過的話會小於名目風險
    actualRiskUSD: +(exactTotal * R).toFixed(2),
  };
}

/** 讀交易帳本（JSONL，壞掉的行跳過不讓整份掛掉） */
export function readJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function appendJournal(entry) {
  fs.appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');
}

/** 同一根 K 棒的同一個標的只下一次單（監控器重啟也不會重複下） */
export function alreadyTraded(symbol, barTime) {
  return readJournal().some(e => e.symbol === symbol && e.barTime === barTime && e.status !== 'failed');
}

/**
 * 下一張限價單，帶兩個「出場水平」（各半部位，5R 與 10R）。
 *
 * 不能改用兩張各半的 bracket 單：同商品的兩張單成交後會被併成一個部位，
 * 兩個停利在合併時會消失，只剩一個涵蓋全部數量的停損 —— 分批停利等於沒做
 * （2026-10-16 實測 ETH：0.559 的部位只剩 SL）。
 */
export async function placeSignalOrders({ symbol, plan, barTime, variant = null, dryRun = false }) {
  const exits = plan.targets.map(t => ({ qty: plan.qtyEach, tp: t.price }));
  const r = await placeLimitBracket({
    symbol,
    qty: plan.qtyTotal,          // 一張單下總量，再由出場水平拆成兩半
    limitPrice: plan.entry,
    stopPrice: plan.stop,
    tpPrice: exits[0].tp,        // 水平1 會繼承這個值
    exits,
    dryRun,
  });
  const results = plan.targets.map((t, i) => ({
    leg: `${t.multiple}R`, tp: t.price, qty: plan.qtyEach,
    ok: !!r.ok, step: r.step || null, detail: r.detail || null,
    preview: i === 0 ? (r.preview || null) : null,
  }));
  if (!r.ok) await closeTicket();   // 失敗就把視窗收掉，別卡住下一次

  // 回填訂單編號，之後過期取消要靠它對帳
  let orderIds = [];
  let landed = null;
  if (!dryRun && r.ok) {
    // 送出鍵按下去不等於單進去了：placeLimitBracket 只看得到「畫面沒報錯」，
    // 後端可以靜默拒單（實測：做多的限價掛在市價之上，模擬盤什麼都不建立，
    // 畫面也沒有任何提示）。一定要讀回帳上實際狀態才算數。
    const bare = symbol.split(':').pop();
    const live = await listOrders();
    orderIds = (live.rows || [])
      .filter(x => x.symbol && x.symbol.indexOf(bare) >= 0 && x.type === '限價' && x.orderId)
      .map(x => x.orderId);
    if (orderIds.length) {
      landed = 'order';
    } else {
      // 限價單不在列上還有一種可能：立刻成交變成部位。那也算成功。
      const pos = await listPositions();
      const hit = (pos.rows || []).find(x => x.symbol && x.symbol.indexOf(bare) >= 0);
      landed = hit ? 'position' : null;
    }
    if (!landed) {
      const reason = '送出後帳上沒有這張單也沒有部位（後端靜默拒單）';
      results.forEach(x => { x.ok = false; x.step = x.step || 'notLanded'; x.detail = x.detail || reason; });
      await closeTicket();
    }
  }

  const entry = {
    ts: new Date().toISOString(), symbol, barTime,
    entry: plan.entry, stop: plan.stop, R: plan.R,
    targets: plan.targets, qtyEach: plan.qtyEach, qtyTotal: plan.qtyTotal,
    riskUSD: plan.riskUSD, actualRiskUSD: plan.actualRiskUSD, equity: plan.equity,
    riskPct: plan.riskPct, drawdown: plan.drawdown, riskReduced: plan.riskReduced,
    capped: plan.capped, dryRun, strategy: STRATEGY_VERSION, variant,
    orders: results, orderIds, landed,
    status: results.some(r => r.ok) ? 'placed' : 'failed',
  };
  appendJournal(entry);
  return entry;
}

/**
 * 取消掛超過 9 小時仍未成交的限價單。
 * 以帳本為準找出該過期的標的，再比對畫面上「運轉中」的限價單才動手，
 * 避免把已經成交的部位或手動下的單誤砍。
 */
export async function expireStaleOrders({ ttlMs = ORDER_TTL_MS, now = Date.now() } = {}) {
  const journal = readJournal();
  // 已經處理過的不要再處理：原紀錄的狀態永遠是 placed，不排除掉的話每一輪
  // 都會對同一批舊單再寫一次 closed-or-filled —— 206 筆交易因此長出三萬行。
  const resolved = new Set(
    journal.filter(e => e.ref && (e.status === 'expired' || e.status === 'closed-or-filled'))
      .map(e => e.ref)
  );
  const stale = journal.filter(e =>
    e.status === 'placed' && !e.dryRun && !resolved.has(e.ts)
    && (now - new Date(e.ts).getTime()) > ttlMs);
  if (!stale.length) return { expired: [], checked: 0 };

  const live = await listOrders();
  const working = (live.rows || []).filter(r => r.type === '限價' && r.status === '運轉中');
  const expired = [];
  for (const e of stale) {
    const bare = e.symbol.split(':').pop();
    const match = working.filter(r => (r.symbol || '').indexOf(bare) >= 0);
    if (!match.length) {
      // 已經成交或早就不在了 —— 標記起來，下輪不用再查
      appendJournal({ ts: new Date().toISOString(), ref: e.ts, symbol: e.symbol,
                      status: 'closed-or-filled', note: '過期檢查時已不在掛單列' });
      continue;
    }
    const res = await cancelOrders({ symbol: e.symbol });
    appendJournal({ ts: new Date().toISOString(), ref: e.ts, symbol: e.symbol,
                    status: 'expired', cancelled: res.cancelled?.length || 0,
                    hoursHeld: +((now - new Date(e.ts).getTime()) / 3600000).toFixed(1) });
    expired.push({ symbol: e.symbol, cancelled: res.cancelled?.length || 0 });
  }
  return { expired, checked: stale.length };
}

/**
 * 保本階梯：價格觸及第 N 個停利點後，把停損移到第 N−1 個停利點。
 * N=1（第一個停利點）時移到成本價，也就是「到 5R 先保本」。
 *
 * 寫成通用的：階梯直接由該筆的 targets 推導，所以日後把 TP_MULTIPLES
 * 加到三個以上，移動停損會自動照同一個規則跑，不用再改這裡。
 *
 * 停損只會往上移、不會往下退（往下移等於擴大風險）。每次移動都寫進帳本，
 * 下一輪才知道已經移到哪一階。
 */
export function stopLadderFor(trade, price, remainingQty = null) {
  const targets = trade.targets || [];
  let reached = 0;
  targets.forEach((t, i) => { if (price >= t.price) reached = i + 1; });

  // 只看現價會漏掉：監控器 30 分鐘才檢查一次，價格衝到 5R 讓停利成交、
  // 再跌回來，下次檢查就看不出曾經到價（ZAMA、SOON 都是這樣錯過的）。
  // 但「已經有幾批出場」是不會騙人的 —— 某一批出場就代表它的目標價被打到過。
  if (remainingQty != null && trade.qtyEach > 0) {
    const legsLeft = Math.round(remainingQty / trade.qtyEach);
    const legsExited = Math.max(0, targets.length - legsLeft);
    if (legsExited > reached) reached = Math.min(legsExited, targets.length);
  }

  if (!reached) return null;
  const newStop = reached === 1 ? trade.entry : targets[reached - 2].price;
  return {
    reached,
    stage: `${targets[reached - 1].multiple}R`,
    newStop,
    breakeven: reached === 1,
    // 移到哪一階（保本時是成本價），通知裡要講清楚鎖住了多少
    lockedAt: reached === 1 ? '成本價' : `${targets[reached - 2].multiple}R`,
  };
}

/** 帳本裡這筆單目前的停損（含先前移動過的紀錄） */
export function currentStopOf(trade, journal = readJournal()) {
  const moves = journal.filter(e => e.status === 'stop-moved' && e.ref === trade.ts);
  return moves.length ? moves[moves.length - 1].newStop : trade.stop;
}

export async function trailStops() {
  const journal = readJournal();
  // 原紀錄的 status 永遠停在 'placed'，取消或結束是另外一行用 ref 指回來。
  // 不排掉的話，早就被取消的單還會被當成「手上這個部位」拿來配對 ——
  // SKYAI 的 10/23 限價單在 17:34 就因逾時被取消，之後帳上那個來路不明的
  // 部位卻一直被配到它身上，用 v1 的 R 與目標價去搬停損。
  //
  // 只能排掉 'expired'（確定被我們取消，不會留下部位）。
  // 'closed-or-filled' 不能排：它的意思只是「限價單離開掛單列」，成交也算 ——
  // 真正成交的交易反而最需要移動停損。HAEDALUSDT 2026-10-26 就是這樣被漏掉：
  // 單成交了、第一段停利也出場了，停損卻一直停在原始價位沒搬上來。
  const resolved = new Set(
    journal.filter(e => e.ref && e.status === 'expired').map(e => e.ref)
  );
  const trades = journal.filter(e =>
    e.entry && !e.dryRun && e.status === 'placed' && !resolved.has(e.ts));
  const positions = await listPositions();
  const moved = [], failed = [];

  for (const pos of positions.rows || []) {
    if (!pos.symbol || pos.last == null) continue;
    // 同一個標的會交易很多次（八天內 206 筆裡不乏重複的幣），不能只取「最後
    // 一筆」—— 那常常是還沒成交的新單，目標價跟手上這個部位對不起來，階梯
    // 就永遠不會觸發。改用持倉均價去配對：進場價最接近的那筆才是這個部位。
    const cands = trades.filter(t => t.symbol === pos.symbol);
    let trade = null, bestDiff = Infinity;
    for (const c of cands) {
      const diff = Math.abs(c.entry - pos.avg) / (pos.avg || 1);
      if (diff < bestDiff) { bestDiff = diff; trade = c; }
    }
    // 差超過 5% 就不是同一筆，寧可不動也不要用錯的目標價去搬停損
    if (!trade || bestDiff > 0.05) continue;

    // 把剩餘數量也交給階梯判斷：某一批已出場＝那個目標價一定到過
    const ladder = stopLadderFor(trade, pos.last, pos.qty);
    if (!ladder) continue;
    const cur = currentStopOf(trade, journal);
    // 浮點數比較留一點容差，免得每輪都重做同一次移動
    if (!(ladder.newStop > cur * (1 + 1e-9))) continue;

    // 只重建「還沒出場」的那幾層：已經在 5R 停利的那半已經走了，
    // 照原本兩層去建會把剩下的部位再切一半、還掛上一個早就該消失的停利，
    // 驗證當然過不了（2026-10-24 SOON、ZAMA 第一次觸發就是卡在這裡）。
    const legsLeft = Math.round(pos.qty / trade.qtyEach);
    if (!(legsLeft >= 1)) continue;
    const remaining = trade.targets.slice(Math.max(0, trade.targets.length - legsLeft));

    // 只剩一層時走基本編輯器：水平的加刪順序不受控，能不碰就不碰
    const r = remaining.length === 1
      ? await setPositionSimpleExits({
          symbol: pos.symbol, tp: remaining[0].price, stopPrice: ladder.newStop, posQty: pos.qty,
        })
      : await rebuildPositionExits({
      symbol: pos.symbol,
      levels: remaining.map(t => ({ tp: t.price })),
      stopPrice: ladder.newStop,
      posQty: pos.qty,
    });
    // 「面板驗證通過」不等於「後端真的改了」：2026-10-24 第一次觸發時，UI
    // 全綠、帳本記成已移動，實際的停損單卻還停在原價，於是之後每輪都以為
    // 移過了而跳過。改成送出後回頭讀真正的停損單來確認。
    let verified = false, liveStop = null;
    if (r.ok) {
      const live = await listOrders();
      const stops = (live.rows || [])
        .filter(x => x.symbol === pos.symbol && x.type === '停損' && x.prices.length)
        .map(x => x.prices[0]);
      liveStop = stops.length ? Math.max(...stops) : null;
      verified = liveStop != null
        && Math.abs(liveStop - ladder.newStop) <= Math.max(1e-9, Math.abs(ladder.newStop) * 1e-4);
    }

    const record = {
      ts: new Date().toISOString(), ref: trade.ts, symbol: pos.symbol,
      status: r.ok && verified ? 'stop-moved' : 'stop-move-failed',
      verified, liveStop,
      price: pos.last, stage: ladder.stage, oldStop: cur, newStop: ladder.newStop,
      legsLeft, remainingTargets: remaining.map(t => t.price),
      breakeven: ladder.reached === 1,
      detail: r.ok ? (verified ? null : `面板通過但實際停損是 ${liveStop}，沒有套用`) : `${r.step}：${r.detail}`,
    };
    appendJournal(record);
    (record.status === 'stop-moved' ? moved : failed).push(record);
  }
  return { moved, failed, checked: (positions.rows || []).length };
}

/** 給監控器用的一條龍：算計畫 → 下單 → 回傳可直接寫進通知的摘要 */
export async function tradeSignal({ symbol, prevBar, fibBar = null, entryPrice = null, stopPrice = null, barTime, variant = null, dryRun = false }) {
  if (alreadyTraded(symbol, barTime)) {
    return { skipped: true, reason: '這根 K 棒已經下過單' };
  }
  // TradingView 重啟後交易面板不會自動展開，而帳戶與掛單都只能從那裡讀
  const panel = await ensureTradingPanel();
  if (!panel.ok) return { ok: false, reason: `交易面板開不起來（${panel.action}）` };

  const acct = await accountSummary();
  if (!acct.ok) return { ok: false, reason: `讀不到帳戶：${acct.reason}` };

  // 帳戶層級熔斷：computePlan 的上限是「單筆」的，擋不住多個信號累積。
  // 一輪出現五個信號就吃掉三分之一保證金，再下去會開始被拒單 ——
  // 而被拒的單在畫面上就只是「沒出現」，正是最難察覺的那種失敗。
  if (acct.available != null && acct.available < acct.equity * MIN_AVAILABLE_PCT) {
    return { skipped: true,
             reason: `可用資金 ${acct.available} 低於權益的 ${MIN_AVAILABLE_PCT * 100}%（${(acct.equity * MIN_AVAILABLE_PCT).toFixed(0)}），暫停開新倉` };
  }

  // 同一個幣在不同交易所會被當成兩個標的（OKX:SOLUSDT.P 與 BINANCE:SOLUSDT.P），
  // 各下一次就等於同一個幣押了兩倍風險。以「幣名」為準擋掉重複。
  //
  // 判斷依據一定要是帳戶的實際掛單與持倉，不能用帳本：帳本記的是「當時下了
  // 單」，不會知道那筆後來成交、停損或被取消。2026-10-16 BTW 就是這樣 ——
  // 17:12 進場、18:52 停損出場，帳本仍寫著 placed，於是 9 小時內的新信號
  // 全被擋掉，白白錯過重新進場的機會。
  const base = baseAsset(symbol);
  const live = await openExposure();
  if (!live.ok) return { ok: false, reason: '讀不到目前的掛單／持倉，為保險起見不下單' };
  const clash = live.symbols.find(s => baseAsset(s) === base);
  if (clash) {
    return { skipped: true, reason: `${base} 目前仍有未結部位或掛單（${clash}），不重複下` };
  }

  const plan = computePlan({ prevBar, fibBar, entryPrice, stopPrice, equity: acct.equity, available: acct.available });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  // 做多的限價掛在市價「之上」，模擬盤會靜默拒單 —— 什麼都不建立、畫面也沒有
  // 任何提示，送出鍵照樣可按。2026-10-26 TAUSDT 連著六輪「下單成功」卻查無此單
  // 就是這樣：進場 0.06177、市價 0.0582。實測把進場改到市價之下，同一套流程
  // 立刻正常掛上（含四段停利停損）。
  //
  // 這種訊號在策略上是合理的（突破後追價），只是這個模擬盤不收。先擋下來並講清楚
  // 原因，不要浪費一輪又留下一筆假的成交紀錄。
  if (!dryRun) {
    const last = await chartLastPrice();
    if (last != null && plan.entry > last) {
      return { skipped: true,
               reason: `進場價 ${plan.entry} 高於現價 ${last}（高 ${((plan.entry / last - 1) * 100).toFixed(1)}%），模擬盤會拒收這種限價單` };
    }
  }

  const entry = await placeSignalOrders({ symbol, plan, barTime, variant, dryRun });
  return { ok: entry.status === 'placed', plan, entry };
}
