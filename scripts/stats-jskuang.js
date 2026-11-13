#!/usr/bin/env node
/**
 * 極速匡策略績效統計（純讀帳本，不碰圖表）
 *
 * 資料來源是帳本裡的 closed 紀錄 —— 由監控器每輪的 reconcileCloses() 從
 * TradingView「餘額歷史」寫回。在那之前要算績效只能臨時爬 UI，而那個清單是
 * 虛擬捲動的，捲到底也只拿得到最近幾天（2026-11-11 做分析時只撈到 4 天）。
 *
 * 同一筆交易會因為分批停利而有多次平倉，所以先依 ref（對應的下單紀錄）
 * 合併成「一筆交易」再算勝負 —— 不合併的話一筆賺錢的交易會被算成四筆。
 *
 * 用法：node scripts/stats-jskuang.js [起始日 YYYY-MM-DD]
 */

import { readJournal } from './lib/jsk-trade.js';

const since = process.argv[2] || null;
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d));

const journal = readJournal();
let closes = journal.filter(e => e.status === 'closed');
if (since) closes = closes.filter(e => e.ts >= since);

if (!closes.length) {
  console.log('帳本裡還沒有 closed 紀錄 —— 監控器每輪會自動寫入，先讓它跑一輪。');
  process.exit(0);
}

// 依 ref 合併（同一筆交易的分批出場算一筆）；配不到帳本的各自獨立
const byTrade = new Map();
for (const c of closes) {
  const key = c.ref || `孤兒:${c.closeKey}`;
  if (!byTrade.has(key)) {
    byTrade.set(key, { key, symbol: c.symbol, variant: c.variant, pnl: 0, legs: 0,
                       rSum: 0, rN: 0, first: c.ts, last: c.ts, orphan: !c.ref });
  }
  const t = byTrade.get(key);
  t.pnl += c.pnl; t.legs++;
  if (c.rMultiple != null) { t.rSum += c.rMultiple; t.rN++; }
  if (c.ts < t.first) t.first = c.ts;
  if (c.ts > t.last) t.last = c.ts;
}
const trades = [...byTrade.values()].sort((a, b) => a.pnl - b.pnl);

function stats(list, label) {
  if (!list.length) { console.log(`\n【${label}】 無資料`); return; }
  const wins = list.filter(x => x.pnl > 0);
  const losses = list.filter(x => x.pnl <= 0);
  const sum = list.reduce((a, x) => a + x.pnl, 0);
  const gw = wins.reduce((a, x) => a + x.pnl, 0);
  const gl = losses.reduce((a, x) => a + x.pnl, 0);
  console.log(`\n【${label}】 ${list.length} 筆交易`);
  console.log(`  勝率     ${(wins.length / list.length * 100).toFixed(1)}%  （贏 ${wins.length} / 輸 ${losses.length}）`);
  console.log(`  總損益   ${fmt(sum)} USD    平均每筆 ${fmt(sum / list.length)}`);
  if (wins.length)   console.log(`  平均獲利 ${fmt(gw / wins.length)}    最大 ${fmt(Math.max(...wins.map(x => x.pnl)))}`);
  if (losses.length) console.log(`  平均虧損 ${fmt(gl / losses.length)}    最大 ${fmt(Math.min(...losses.map(x => x.pnl)))}`);
  if (losses.length && gl !== 0) console.log(`  獲利因子 ${(gw / Math.abs(gl)).toFixed(2)}`);
  // 單一交易主導與否：少了最大贏家還剩多少
  if (wins.length) {
    const top = Math.max(...wins.map(x => x.pnl));
    console.log(`  扣掉最大贏家後 ${fmt(sum - top)} —— 最大一筆佔總獲利 ${(top / gw * 100).toFixed(0)}%`);
  }
}

console.log(`═══ 極速匡績效統計${since ? `（${since} 起）` : ''} ═══`);
console.log(`平倉事件 ${closes.length} 次，合併為 ${trades.length} 筆交易`);
console.log(`期間 ${closes.map(c => c.ts).sort()[0].slice(0, 10)} → ${closes.map(c => c.ts).sort().slice(-1)[0].slice(0, 10)}`);

console.log('\n逐筆（依損益排序）');
console.log('  商品              策略  批次  損益      平均R');
for (const t of trades) {
  console.log('  ' + t.symbol.split(':').pop().padEnd(16)
    + String(t.variant || (t.orphan ? '孤兒' : '?')).padEnd(6)
    + String(t.legs).padStart(3) + '  '
    + fmt(t.pnl).padStart(8) + '  '
    + (t.rN ? fmt(t.rSum / t.rN, 2).padStart(7) : '      —'));
}

stats(trades, '全部');
stats(trades.filter(t => t.variant === 'A'), '策略 A（破底後由黑轉紅）');
stats(trades.filter(t => t.variant === 'B'), '策略 B（突破後進場）');
const orphans = trades.filter(t => t.orphan);
if (orphans.length) console.log(`\n（另有 ${orphans.length} 筆配不到下單紀錄，已排除在 A／B 之外）`);
