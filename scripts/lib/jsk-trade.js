/**
 * 極速匡策略的下單層：把 3H 紅吞信號換算成訂單，並記錄交易帳本。
 *
 * 進出規則（使用者 2026-10-16 定義）：
 *   進場價 = 紅吞「前一根」的最高價   ← 掛限價單等回踩，不追價
 *   停損價 = 紅吞「前一根」的最低價
 *   R      = 進場價 − 停損價
 *   停利   = 進場 + 5R 與 進場 + 10R 兩批，各半部位
 *   單筆風險 = 權益 × 2%
 *   限價單 9 小時（3 根 3H K 棒）內沒成交就取消
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { accountSummary, placeLimitBracket, listOrders, cancelOrders, closeTicket, openExposure } from './paper-order.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const JOURNAL = path.join(ROOT, 'trades-jskuang.jsonl');

export const RISK_PCT = 0.02;          // 單筆風險 = 權益的 2%
export const TP_MULTIPLES = [5, 10];   // 兩批停利
export const ORDER_TTL_MS = 9 * 3600 * 1000;  // 限價單有效期：3 根 3H K 棒
const LEVERAGE = 10;                   // 帳戶顯示 10x；用來估保證金夠不夠
const MARGIN_USE_CAP = 0.4;            // 單一信號最多動用 40% 可用資金
const MIN_AVAILABLE_PCT = 0.25;        // 可用資金低於權益的 25% 就不再開新倉

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
export function computePlan({ prevBar, equity, available }) {
  const entry = prevBar.high;
  const stop = prevBar.low;
  const R = entry - stop;
  if (!(R > 0)) return { ok: false, reason: `R 不是正數（高 ${entry} 低 ${stop}）` };

  const riskUSD = +(equity * RISK_PCT).toFixed(2);
  let qtyTotal = riskUSD / R;

  // 保證金夠不夠：名目 = 數量 × 進場價，保證金 ≈ 名目 / 槓桿
  const capNotional = (available || equity) * LEVERAGE * MARGIN_USE_CAP;
  let capped = false;
  if (qtyTotal * entry > capNotional) {
    qtyTotal = capNotional / entry;
    capped = true;
  }

  const qtyEach = roundQty(qtyTotal / TP_MULTIPLES.length);
  if (qtyEach <= 0) return { ok: false, reason: `算出的數量是 0（風險 ${riskUSD} / R ${R}）` };

  return {
    ok: true, entry, stop, R,
    targets: TP_MULTIPLES.map(m => ({ multiple: m, price: roundPrice(entry + m * R, entry) })),
    qtyEach, qtyTotal: roundQty(qtyEach * TP_MULTIPLES.length),
    riskUSD, equity, capped,
    // 實際風險：數量被保證金上限砍過的話會小於名目風險
    actualRiskUSD: +(roundQty(qtyEach * TP_MULTIPLES.length) * R).toFixed(2),
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
    capped: plan.capped, dryRun,
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
  const stale = journal.filter(e =>
    e.status === 'placed' && !e.dryRun && (now - new Date(e.ts).getTime()) > ttlMs);
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

/** 給監控器用的一條龍：算計畫 → 下單 → 回傳可直接寫進通知的摘要 */
export async function tradeSignal({ symbol, prevBar, barTime, dryRun = false }) {
  if (alreadyTraded(symbol, barTime)) {
    return { skipped: true, reason: '這根 K 棒已經下過單' };
  }
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

  const plan = computePlan({ prevBar, equity: acct.equity, available: acct.available });
  if (!plan.ok) return { ok: false, reason: plan.reason };

  const entry = await placeSignalOrders({ symbol, plan, barTime, dryRun });
  return { ok: entry.status === 'placed', plan, entry };
}
