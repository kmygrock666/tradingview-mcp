#!/usr/bin/env node
/**
 * 極速匡實驗績效對帳
 *
 * 帳本（trades-jskuang.jsonl）只記「下了什麼單」，不知道後來的結果；
 * 結果要去 TradingView 的「餘額歷史」拿 —— 那裡每一次平倉都寫明出場價、
 * 數量與持倉均價，而且我們的兩個出場水平會各記一筆，剛好對得上分批停利。
 *
 * 盈虧 = (出場價 − 持倉均價) × 數量
 * R倍數 = (出場價 − 持倉均價) ÷ R，R 取自帳本（進場 − 停損）
 *
 * 用法：node scripts/report-jskuang.js
 */

import { connect, disconnect, evaluateAsync } from '../src/connection.js';
import { ensureTradingPanel, accountSummary, listPositions } from './lib/paper-order.js';
import { readJournal, baseAsset } from './lib/jsk-trade.js';

/** 把「餘額歷史」的每一列敘述解析成平倉事件 */
function parseCloseLine(text) {
  // Close long position for symbol BINGX:ZAMAUSDT.P at price 0.07411 for 7821 units.
  // Position AVG Price was 0.075470, ...
  const m = text.match(
    /Close (long|short) position for symbol ([^\s]+) at price ([\d.]+) for ([\d.]+) units\.\s*Position AVG Price was ([\d.]+)/
  );
  if (!m) return null;
  const [, side, symbol, exit, qty, avg] = m;
  return {
    side, symbol,
    exit: parseFloat(exit),
    qty: parseFloat(qty),
    avg: parseFloat(avg),
    pnl: (parseFloat(exit) - parseFloat(avg)) * parseFloat(qty) * (side === 'long' ? 1 : -1),
  };
}

async function fetchCloses() {
  const raw = await evaluateAsync(`(async function(){
    function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    var tab = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
      return b.offsetParent !== null && (b.textContent||'').trim().indexOf('餘額歷史') === 0;
    })[0];
    if (!tab) return { ok: false, reason: '找不到餘額歷史分頁' };
    tab.click();
    await sleep(1500);
    // 時間範圍切到「全部」，否則只看得到最近的
    var all = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"], div')).filter(function(b){
      return b.offsetParent !== null && (b.textContent||'').trim() === '全部' && b.children.length === 0;
    })[0];
    if (all) { all.click(); await sleep(2000); }

    var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
      var t = e.innerText || '';
      return e.offsetParent !== null && t.indexOf('Close ') >= 0 && t.indexOf('position for symbol') >= 0 && t.length < 600;
    });
    var rows = els.filter(function(e){ return !els.some(function(o){ return o !== e && e.contains(o); }); });
    return { ok: true, lines: rows.map(function(e){ return (e.innerText || '').split(String.fromCharCode(10)).join(' '); }) };
  })()`);
  if (!raw.ok) throw new Error(raw.reason);
  return raw.lines.map(parseCloseLine).filter(Boolean);
}

function fmt(n, d = 2) {
  if (n == null || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

async function main() {
  await connect();
  const panel = await ensureTradingPanel();
  if (!panel.ok) throw new Error(`交易面板開不起來：${panel.action}`);

  const acct = await accountSummary();
  const positions = await listPositions();
  const closes = await fetchCloses();
  const journal = readJournal().filter(e => e.entry && !e.dryRun);

  // 用帳本補上 R（停損距離），好把盈虧換算成 R 倍數。
  // 同一個標的可能交易過多次，取進場價最接近持倉均價的那一筆。
  const withR = closes.map(c => {
    const cands = journal.filter(j => j.symbol === c.symbol);
    let best = null, bestDiff = Infinity;
    for (const j of cands) {
      const diff = Math.abs(j.entry - c.avg) / (c.avg || 1);
      if (diff < bestDiff) { bestDiff = diff; best = j; }
    }
    const R = best && bestDiff < 0.05 ? best.R : null;
    return { ...c, R, rMultiple: R ? (c.exit - c.avg) / R : null, journal: best };
  });

  // 我們的單子不在帳本裡的（例如使用者自己手動開的）另外標示
  const mine = withR.filter(c => c.journal);
  const others = withR.filter(c => !c.journal);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║            極速匡策略實驗 — 績效對帳                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const firstEquity = journal.length ? journal[0].equity : null;
  if (acct.ok) {
    console.log(`帳戶：${acct.account}`);
    console.log(`  起始權益 ${firstEquity ?? '?'} → 目前權益 ${acct.equity}` +
      (firstEquity ? `　(${fmt(acct.equity - firstEquity)} USD, ${fmt((acct.equity / firstEquity - 1) * 100)}%)` : ''));
    console.log(`  可用資金 ${acct.available}　已用保證金 ${acct.usedMargin}\n`);
  }

  console.log(`── 已出場（${mine.length} 筆，每個出場水平各算一筆）──`);
  console.log('  標的             均價        出場        數量         盈虧USD    R倍數');
  for (const c of mine) {
    console.log(`  ${c.symbol.split(':').pop().padEnd(16)} ${String(c.avg).padEnd(11)} ${String(c.exit).padEnd(11)} ` +
      `${String(c.qty).padEnd(12)} ${fmt(c.pnl).padStart(9)}  ${c.rMultiple != null ? fmt(c.rMultiple, 2).padStart(6) : '     —'}`);
  }

  const wins = mine.filter(c => c.pnl > 0);
  const losses = mine.filter(c => c.pnl <= 0);
  const total = mine.reduce((s, c) => s + c.pnl, 0);
  const rs = mine.filter(c => c.rMultiple != null).map(c => c.rMultiple);
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

  // 以「信號」為單位彙總：一個信號會拆成兩個出場水平，分開算會把勝率稀釋掉。
  // 同一標的可能交易多次，用持倉均價分組才不會把不同次的混在一起。
  const bySignal = new Map();
  for (const c of mine) {
    const key = `${c.symbol}@${c.avg}`;
    if (!bySignal.has(key)) {
      bySignal.set(key, { symbol: c.symbol, avg: c.avg, legs: 0, pnl: 0, qty: 0, R: c.R, journal: c.journal });
    }
    const g = bySignal.get(key);
    g.legs++; g.pnl += c.pnl; g.qty += c.qty;
  }
  const signals = [...bySignal.values()];
  // 只平掉一半的（例如 5R 中了、10R 還跑著）要標出來，否則會被當成已結束
  const stillOpen = new Set((positions.rows || []).map(r => r.symbol));
  signals.forEach(s => { s.partial = s.legs < 2 || stillOpen.has(s.symbol); });

  console.log(`\n── 以信號為單位（${signals.length} 個信號）──`);
  console.log('  標的             盈虧USD     R倍數   出場批數');
  for (const s of signals) {
    const r = s.R ? (s.pnl / (s.R * s.qty)) : null;
    console.log(`  ${s.symbol.split(':').pop().padEnd(16)} ${fmt(s.pnl).padStart(8)}  ${r != null ? fmt(r, 2).padStart(6) : '     —'}` +
      `   ${s.legs}/2${s.partial ? '（另一半仍進行中）' : ''}`);
  }
  const sWins = signals.filter(s => s.pnl > 0);
  console.log(`  勝率（信號）  ${(sWins.length / signals.length * 100).toFixed(1)}%　` +
    `平均每信號 ${fmt(signals.reduce((a, b) => a + b.pnl, 0) / signals.length)} USD`);

  console.log(`\n── 彙總 ──`);
  console.log(`  已出場筆數    ${mine.length}（獲利 ${wins.length}、虧損 ${losses.length}）`);
  console.log(`  勝率          ${mine.length ? (wins.length / mine.length * 100).toFixed(1) + '%' : '—'}`);
  console.log(`  已實現盈虧    ${fmt(total)} USD`);
  console.log(`  平均 R 倍數   ${avgR != null ? fmt(avgR, 2) : '—'}`);
  if (wins.length) console.log(`  最佳          ${wins.reduce((a,b)=>a.pnl>b.pnl?a:b).symbol.split(':').pop()} ${fmt(Math.max(...wins.map(w=>w.pnl)))} USD`);
  if (losses.length) console.log(`  最差          ${losses.reduce((a,b)=>a.pnl<b.pnl?a:b).symbol.split(':').pop()} ${fmt(Math.min(...losses.map(l=>l.pnl)))} USD`);

  // 進行中
  const open = (positions.rows || []).filter(r => r.symbol);
  const openMine = open.filter(r => journal.some(j => baseAsset(j.symbol) === baseAsset(r.symbol)));
  console.log(`\n── 進行中（${openMine.length} 個部位）──`);
  for (const r of openMine) {
    const j = journal.filter(x => x.symbol === r.symbol).slice(-1)[0];
    console.log(`  ${r.symbol.split(':').pop().padEnd(16)} ${(r.cells||[]).slice(2,4).join(' @ ')}` +
      (j ? `　目標 ${j.targets.map(t => t.multiple + 'R→' + t.price).join(' / ')}　停損 ${j.stop}` : ''));
  }

  if (others.length) {
    console.log(`\n── 非本實驗的出場（${others.length} 筆，帳本裡沒有對應的下單）──`);
    others.forEach(c => console.log(`  ${c.symbol.split(':').pop().padEnd(16)} ${fmt(c.pnl)} USD`));
  }

  // 下單失敗的記錄也要看得到，否則會以為每個信號都有進場
  const failed = readJournal().filter(e => e.status === 'failed');
  if (failed.length) {
    console.log(`\n── 下單失敗（${failed.length} 筆，信號有出現但沒進場）──`);
    failed.forEach(e => console.log(`  ${e.symbol.split(':').pop().padEnd(16)} ${e.ts.slice(5,16).replace('T',' ')}　${e.orders?.[0]?.step || ''}`));
  }

  await disconnect();
}

main().catch(async err => {
  console.error('❌ 對帳失敗：', err.message);
  try { await disconnect(); } catch {}
  process.exit(1);
});
