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
import { accountSummary, placeLimitBracket, listOrders, cancelOrders, closeTicket, openExposure, ensureTradingPanel, listPositions, rebuildPositionExits, setPositionSimpleExits } from './paper-order.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNAL = path.join(ROOT, 'trades-jskuang.jsonl');

export const STRATEGY_VERSION = 'v3.1';  // 進場條件版本，寫進帳本方便分開統計
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

/** 依數量級取合理的小數位，避免送出 1947.3333333 這種數字 */
function roundQty(q) {
  if (!isFinite(q) || q <= 0) return 0;
  if (q >= 1000) return Math.round(q);
  if (q >= 10) return Math.round(q * 100) / 100;
  if (q >= 1) return Math.round(q * 1000) / 1000;
  return Math.round(q * 1e6) / 1e6;
}

/** 價格小數位比照進場價，避免 0.1 + 5*0.01 = 0.15000000000000002 */
function roundPrice(p, ref) {
  const decimals = (String(ref).split('.')[1] || '').length || 8;
  return +p.toFixed(Math.min(decimals + 2, 10));
}

/**
 * 由「紅吞前一根」K 棒算出完整的下單計畫。
 * prevBar 需含 high / low。
 */
export function computePlan({ prevBar, fibBar, equity, available }) {
  // v3（2026-10-25）：價格全部由條件 4 的黑K 拉斐波那契決定 ——
  //   1 = 黑K 高點、0 = 黑K 低點，進場在 0.7、停損在 0、
  //   停利四段分別在 10.8 / 20.8 / 30.8 / 50.8。
  // 舊的 prevBar 介面（進場＝高點、停損＝低點）留著當後備。
  let entry, stop, targetPrices;
  if (fibBar) {
    const span = fibBar.high - fibBar.low;
    if (!(span > 0)) return { ok: false, reason: `斐波那契區間不是正數（高 ${fibBar.high} 低 ${fibBar.low}）` };
    const at = (lvl) => roundPrice(fibBar.low + lvl * span, fibBar.low);
    entry = at(FIB_ENTRY);
    stop = at(0);
    targetPrices = FIB_TARGETS.map(lvl => ({ multiple: lvl, price: at(lvl) }));
  } else {
    entry = prevBar.high;
    stop = prevBar.low;
    targetPrices = null;
  }
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

  const targets = targetPrices
    || TP_MULTIPLES.map(m => ({ multiple: m, price: roundPrice(entry + m * R, entry) }));

  const qtyEach = roundQty(qtyTotal / targets.length);
  if (qtyEach <= 0) return { ok: false, reason: `算出的數量是 0（風險 ${riskUSD} / R ${R}）` };

  return {
    ok: true, entry, stop, R, targets,
    qtyEach, qtyTotal: roundQty(qtyEach * targets.length),
    riskUSD, equity, capped,
    riskPct: risk.pct, drawdown: risk.drawdown, riskReduced: risk.reduced,
    // 實際風險：數量被保證金上限砍過的話會小於名目風險
    actualRiskUSD: +(roundQty(qtyEach * targets.length) * R).toFixed(2),
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
export async function placeSignalOrders({ symbol, plan, barTime, dryRun = false }) {
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
  if (!dryRun) {
    const live = await listOrders();
    orderIds = (live.rows || [])
      .filter(r => r.symbol && r.symbol.indexOf(symbol.split(':').pop()) >= 0 && r.type === '限價' && r.orderId)
      .map(r => r.orderId);
  }

  const entry = {
    ts: new Date().toISOString(), symbol, barTime,
    entry: plan.entry, stop: plan.stop, R: plan.R,
    targets: plan.targets, qtyEach: plan.qtyEach, qtyTotal: plan.qtyTotal,
    riskUSD: plan.riskUSD, actualRiskUSD: plan.actualRiskUSD, equity: plan.equity,
    riskPct: plan.riskPct, drawdown: plan.drawdown, riskReduced: plan.riskReduced,
    capped: plan.capped, dryRun, strategy: STRATEGY_VERSION,
    orders: results, orderIds,
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
  const trades = journal.filter(e => e.entry && !e.dryRun && e.status === 'placed');
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
export async function tradeSignal({ symbol, prevBar, fibBar = null, barTime, dryRun = false }) {
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

  const plan = computePlan({ prevBar, fibBar, equity: acct.equity, available: acct.available });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const entry = await placeSignalOrders({ symbol, plan, barTime, dryRun });
  return { ok: entry.status === 'placed', plan, entry };
}
