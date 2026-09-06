#!/usr/bin/env node
/**
 * 極速匡進場監控器
 *
 * 監控清單（TradingView watchlist 頁籤）：極速匡、加密貨幣
 *
 * 進場條件（三者同時成立）：
 *   1. 1D：當前為「紅吞」，或前一根日K為「黑吞」/「收黑K」
 *   2. 3H：當前「紅吞」且前 5 根內曾出現「黑吞」（黑吞後轉紅吞），
 *      且收盤站上「7EMA_5MA」指標的 MA 線（MA 1）
 *   3. 最近 3 根 1H K棒收盤連續墊高（底底高）
 *
 * 極速匡移除條件（僅極速匡頁籤）：
 *   3D 當前或前一根 K棒為「黑吞」→ 自清單移除並通知
 *
 * 用法：node scripts/monitor-jskuang.js [間隔分鐘數，預設 30]
 */

import { connect, disconnect, evaluate, evaluateAsync } from '../src/connection.js';
import { getOhlcv, getStudyValues } from '../src/core/data.js';
import { remove as wlRemove } from '../src/core/watchlist.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TG_TOKEN || !TG_CHAT_ID) {
  console.error('請設定環境變數 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID');
  process.exit(1);
}

const INTERVAL_MIN = parseInt(process.argv[2] || '30', 10);
// 要監控的 watchlist 頁籤名稱（依 TradingView 清單按鈕的 aria-label）
const WATCHLISTS = ['極速匡', '加密貨幣'];
// 圖表上 EMA/MA 指標的名稱與要比對的 MA 線欄位（需保持指標可見）
const MA_STUDY_NAME = '7EMA_5MA';
const MA_VALUE_KEY = 'MA 1';
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const SYMBOL_WAIT = 700;
const TF_WAIT = 450;

// 已通知記錄：避免同一根 K 棒重複通知（key = symbol+barTime）
const notified = new Set();
// 已通知移除的幣對（key = tvSym）。移除驗證失敗時避免每輪重發；
// 幣對確實離開清單後會清掉記錄，日後重新加回才會再通知。
const removeNotified = new Set();

// ─── 吞噬判斷 ────────────────────────────────────
function isBullEngulf(c, p) {
  return c.close > c.open && c.close > Math.max(p.open, p.close);
}
function isBearEngulf(c, p) {
  return c.close < c.open && c.close < Math.min(p.open, p.close);
}

// 資料視窗的數值是格式化字串（可能含千分位逗號或 K/M/B 後綴）
function parseStudyNum(v) {
  if (v == null) return NaN;
  const m = String(v).replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if (!m) return NaN;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return parseFloat(m[1]) * mult;
}

let maStudyWarned = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function now() {
  return new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Telegram 通知 ────────────────────────────────
async function notify(title, message, emoji = '🚀') {
  try {
    const text = `${emoji} <b>${title}</b>\n${message}`;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const json = await res.json();
    if (!json.ok) console.error('TG 發送失敗:', json.description);
  } catch (e) {
    console.error('TG 通知錯誤:', e.message);
  }
}

// ─── 圖表切換（直接 evaluate，避免 waitForChartReady 卡住）───
async function switchTo(symbol, tf) {
  await evaluateAsync(`new Promise(r => {
    ${CHART_API}.setSymbol(${JSON.stringify(symbol)}, {});
    setTimeout(() => { ${CHART_API}.setResolution(${JSON.stringify(tf)}, {}); setTimeout(r, ${TF_WAIT}); }, ${SYMBOL_WAIT});
  })`);
}

async function switchTF(tf) {
  await evaluateAsync(`new Promise(r => {
    ${CHART_API}.setResolution(${JSON.stringify(tf)}, {}); setTimeout(r, ${TF_WAIT});
  })`);
}

// ─── 讀取雲端自訂清單（權威來源）────────────────────
// 桌面版 widget 不會即時同步 API 的異動：移除成功後畫面仍留著舊的 row。
// 改以 REST 為準，否則下一輪會掃到已移除的殭屍標的並重複通知。
async function fetchCustomLists() {
  const lists = await evaluateAsync(`
    fetch(location.origin + '/api/v1/symbols_list/custom/', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        return Array.isArray(j)
          ? j.map(function(x) { return { id: x.id, name: x.name, symbols: x.symbols || [] }; })
          : [];
      })
      .catch(function() { return []; })
  `);
  return lists || [];
}

// ─── 從 TradingView 讀取多個清單頁籤的幣對 ──────────
// 依序切換至每個頁籤讀取，讀完後切回原清單。
// 僅用於不在自訂清單 API 中的內建清單（例如「加密貨幣」）。
async function fetchWatchlistsFromDom(listNames) {
  const result = await evaluateAsync(`(async function() {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 確保 watchlist 面板開著
    var wlBtn = document.querySelector('[data-name="watchlists-button"]');
    if (wlBtn && wlBtn.getAttribute('aria-pressed') !== 'true') {
      wlBtn.click();
      await sleep(600);
    }

    function findListBtn(label) {
      var btns = document.querySelectorAll('button[aria-label]');
      for (var b of btns) {
        if (b.getAttribute('aria-label') === label) return b;
      }
      return null;
    }
    function getActiveLabel() {
      var btns = document.querySelectorAll('button[aria-pressed="true"]');
      for (var b of btns) {
        var al = b.getAttribute('aria-label') || '';
        if (al && al !== 'true') return al;
      }
      return null;
    }
    function readSymbols() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      var rows = panel ? panel.querySelectorAll('[data-symbol-full]') : [];
      var symbols = [], seen = {};
      for (var row of rows) {
        var s = row.getAttribute('data-symbol-full');
        if (s && !seen[s]) { seen[s] = true; symbols.push(s); }
      }
      return symbols;
    }

    var prevLabel = getActiveLabel();
    var names = ${JSON.stringify(listNames)};
    var lists = [], missing = [];

    for (var name of names) {
      var btn = findListBtn(name);
      if (!btn) { missing.push(name); continue; }
      if (btn.getAttribute('aria-pressed') !== 'true') {
        btn.click();
        await sleep(700);
      }
      lists.push({ list: name, symbols: readSymbols() });
    }

    // 切回原本清單
    if (prevLabel && getActiveLabel() !== prevLabel) {
      var prevBtn = findListBtn(prevLabel);
      if (prevBtn) { prevBtn.click(); await sleep(400); }
    }

    return { lists: lists, missing: missing };
  })()`);

  for (const name of result?.missing || []) {
    console.warn(`  ⚠️  找不到「${name}」清單頁籤，已跳過`);
  }
  return result?.lists || [];
}

// ─── 取得監控清單：自訂清單走 API，其餘退回讀 DOM ────
async function fetchWatchlists(listNames) {
  const custom = await fetchCustomLists();
  const lists = [];
  const domNames = [];
  for (const name of listNames) {
    const found = custom.find(l => l.name === name);
    if (found) lists.push({ list: name, symbols: found.symbols });
    else domNames.push(name);
  }
  if (domNames.length) lists.push(...await fetchWatchlistsFromDom(domNames));
  lists.sort((a, b) => listNames.indexOf(a.list) - listNames.indexOf(b.list));
  if (!lists.length) throw new Error('所有監控清單皆不存在或無法讀取');
  return lists;
}

// ─── 檢查極速匡移除條件：3D 當前或前一根黑吞 ──────────
async function checkRemoval3D(tvSym) {
  try {
    await switchTo(tvSym, '3D');
    const d3 = await getOhlcv({ count: 4 });
    if (!d3 || d3.bars.length < 3) return null;
    const b = d3.bars;
    const curr = b[b.length - 1], prev = b[b.length - 2], prev2 = b[b.length - 3];
    if (isBearEngulf(curr, prev)) return '3D黑吞';
    if (prev2 && isBearEngulf(prev, prev2)) return '3D前根黑吞';
    return null;
  } catch {
    return null;
  }
}

// ─── 切換至指定清單頁籤後移除幣對 ────────────────────
async function removeFromList(listName, symbols) {
  const activated = await evaluateAsync(`(async function() {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    var wlBtn = document.querySelector('[data-name="watchlists-button"]');
    if (wlBtn && wlBtn.getAttribute('aria-pressed') !== 'true') { wlBtn.click(); await sleep(600); }
    var btns = document.querySelectorAll('button[aria-label]');
    for (var b of btns) {
      if (b.getAttribute('aria-label') === ${JSON.stringify(listName)}) {
        if (b.getAttribute('aria-pressed') !== 'true') { b.click(); await sleep(700); }
        return true;
      }
    }
    return false;
  })()`);
  if (!activated) throw new Error(`找不到「${listName}」清單頁籤`);
  return wlRemove({ symbols });
}

// ─── 檢查單一幣對的進場條件 ──────────────────────────
// tvSym 為完整格式，如 "OKX:ENAUSDT.P"
async function checkEntry(tvSym) {
  const displayName = tvSym.split(':').pop().replace('.P', '');
  try {
    // 條件1：1D 當前紅吞，或前一根日K為黑吞/收黑K
    await switchTo(tvSym, 'D');
    const d1 = await getOhlcv({ count: 3 });
    if (!d1 || d1.bars.length < 2) return null;
    const dBars = d1.bars;
    const currD = dBars[dBars.length - 1];
    const prevD = dBars[dBars.length - 2];
    const prev2D = dBars[dBars.length - 3];
    let d1Signal = null;
    if (isBullEngulf(currD, prevD)) d1Signal = '紅吞';
    else if (prev2D && isBearEngulf(prevD, prev2D)) d1Signal = '前根黑吞';
    else if (prevD.close < prevD.open) d1Signal = '前根收黑K';
    if (!d1Signal) return null;

    // 條件2：切換至 3H，當前紅吞且前 5 根內曾出現黑吞（黑吞後轉紅吞）
    await switchTF('180');
    const h3 = await getOhlcv({ count: 7 });
    if (!h3 || h3.bars.length < 6) return null;
    const bars3h = h3.bars;

    const curr3h = bars3h[bars3h.length - 1];
    const prev3h = bars3h[bars3h.length - 2];
    if (!isBullEngulf(curr3h, prev3h)) return null;

    let hadBearEngulf = false;
    for (let i = 1; i <= 5; i++) {
      const c = bars3h[bars3h.length - 1 - i];
      const p = bars3h[bars3h.length - 2 - i];
      if (!c || !p) break;
      if (isBearEngulf(c, p)) { hadBearEngulf = true; break; }
    }
    if (!hadBearEngulf) return null;

    // 條件2b：3H 收盤需站上 EMA/MA 指標的 MA 線
    const sv = await getStudyValues();
    const maStudy = sv?.studies?.find(st => st.name && st.name.includes(MA_STUDY_NAME));
    if (!maStudy) {
      if (!maStudyWarned) {
        maStudyWarned = true;
        console.warn(`\n  ⚠️  圖表上找不到「${MA_STUDY_NAME}」指標，MA 條件無法判斷，將視為不符合`);
      }
      return null;
    }
    const maVal = parseStudyNum(maStudy.values?.[MA_VALUE_KEY]);
    if (!Number.isFinite(maVal) || curr3h.close <= maVal) return null;

    // 條件3：切換至 1H，取最近 3 根收盤連續墊高
    await switchTF('60');
    const h1 = await getOhlcv({ count: 4 });
    if (!h1 || h1.bars.length < 3) return null;
    const b = h1.bars;
    const h1_higher = b[b.length - 3].close < b[b.length - 2].close &&
      b[b.length - 2].close < b[b.length - 1].close;
    if (!h1_higher) return null;

    return { symbol: tvSym, displayName, price: curr3h.close, barTime: curr3h.time, d1Signal };
  } catch {
    return null;
  }
}

// ─── 單次掃描 ────────────────────────────────────
async function runScan() {
  console.log(`\n[${now()}] ▶ 開始掃描清單（${WATCHLISTS.join('、')}）...`);
  let lists;
  try {
    lists = await fetchWatchlists(WATCHLISTS);
  } catch (e) {
    console.error('  讀取清單失敗:', e.message);
    return;
  }

  // 已離開極速匡的幣對：清掉移除通知記錄，日後重新加回才會再通知
  const jskSymbols = new Set(lists.find(l => l.list === '極速匡')?.symbols || []);
  for (const s of removeNotified) if (!jskSymbols.has(s)) removeNotified.delete(s);

  const signals = [];
  const removals = [];
  const scanned = new Set(); // 同一輪跨清單去重：同幣對只掃一次
  for (const { list, symbols } of lists) {
    console.log(`  ── ${list}（${symbols.length} 個幣對）──`);
    for (const tvSym of symbols) {
      const label = tvSym.split(':').pop().replace('.P', '');
      process.stdout.write(`  ${label.padEnd(16)} `);
      if (scanned.has(tvSym)) {
        console.log('⏭ (其他清單已掃)');
        continue;
      }
      // 移除條件僅適用極速匡：3D 當前或前一根黑吞 → 待移除，跳過進場檢查
      if (list === '極速匡') {
        const removalReason = await checkRemoval3D(tvSym);
        if (removalReason) {
          removals.push({ tvSym, displayName: label, reason: removalReason });
          console.log(`🗑 ${removalReason} → 待移除`);
          continue;
        }
      }
      scanned.add(tvSym);
      const result = await checkEntry(tvSym);
      if (result) {
        const key = `${tvSym}-${result.barTime}`;
        if (!notified.has(key)) {
          notified.add(key);
          signals.push({ ...result, list });
          console.log('🔔 進場信號！');
        } else {
          console.log('✅ (已通知)');
        }
      } else {
        console.log('—');
      }
    }
  }

  if (removals.length > 0) {
    console.log(`\n  🗑 自極速匡移除：${removals.map(r => r.displayName).join(', ')}`);
    try {
      const res = await removeFromList('極速匡', removals.map(r => r.tvSym));
      // 只有真的移除成功才通知，否則每輪都會重掃到同一批幣對而重複發送。
      if (!res.verified) {
        console.warn('  ⚠️  移除未通過驗證，下次掃描將重試（不發通知）');
      } else {
        const fresh = removals.filter(r => !removeNotified.has(r.tvSym));
        if (fresh.length) {
          for (const r of fresh) removeNotified.add(r.tvSym);
          await notify(
            '極速匡移除訊號',
            fresh.map(r => `${r.displayName}（${r.reason}）`).join('\n'),
            '🗑'
          );
        }
      }
    } catch (e) {
      console.error('  ⚠️  移除失敗（下次掃描將重試）:', e.message);
    }
  }

  if (signals.length > 0) {
    for (const s of signals) {
      await notify(
        `${s.list}進場信號`,
        `${s.displayName}  @${s.price}\n1D${s.d1Signal} + 3H黑吞轉紅吞站上MA + 1H底底高`
      );
    }
    console.log(`\n  🔔 通知已發送：${signals.map(s => s.displayName).join(', ')}`);
  } else {
    console.log(`  無進場信號`);
  }
  console.log(`[${now()}] ◀ 掃描完成，下次 ${INTERVAL_MIN} 分鐘後`);
}

// ─── 主程式 ──────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        極速匡進場監控器                  ║');
  console.log(`║  監控清單：${WATCHLISTS.join('、')}            ║`);
  console.log(`║  掃描間隔：每 ${String(INTERVAL_MIN).padEnd(2)} 分鐘                  ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('按 Ctrl+C 停止監控\n');

  await connect();
  console.log('✅ 已連接 TradingView CDP\n');

  // 立即執行第一次
  await runScan();

  // 定時循環
  setInterval(runScan, INTERVAL_MIN * 60 * 1000);
}

main().catch(err => {
  console.error('\n❌ 監控器錯誤:', err.message);
  process.exit(1);
});
