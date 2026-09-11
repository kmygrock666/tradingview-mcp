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
 * 極速匡移除條件（僅極速匡頁籤，任一成立即移除並通知）：
 *   1. 3D 當前或前一根 K棒為「黑吞」
 *   2. 3D 上漲結構被破壞：往回找最近一根「紅吞」K棒（上漲趨勢的錨點），
 *      當前收盤跌破該紅吞 K棒的最低價（含下影線）
 *
 * Telegram 通知：
 *   - 進場信號：每個符合的幣對各發一則（格式未變）
 *   - 每輪摘要：不論有無符合目標，每輪掃完都發一則（時間／清單與掃描數／結果）
 *   - 錯誤：讀清單失敗、掃描例外、致命錯誤各自發通知，不靜默吞掉
 *   - 心跳：超過 間隔 + 5 分鐘 沒完成任何一輪掃描就發逾時告警
 *   於是「完全沒收到訊息」只剩一種解讀 —— 行程整個掛了。
 *
 * 用法：node scripts/monitor-jskuang.js [間隔分鐘數，預設 30]
 */

import { connect, disconnect, evaluate, evaluateAsync } from '../src/connection.js';
import { getOhlcv, getStudyValues } from '../src/core/data.js';
import { removeFromList } from '../src/core/watchlist.js';

// 自動載入專案根目錄的 .env(已用 export 設定或檔案不存在時略過)
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}

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
// 主序列本身（K 棒的真正來源）。widget 的 symbol()/resolution() 會在資料
// 換好之前就先更新，只能拿它當「已下指令」看，不能當「資料已就緒」用。
const MAIN_SERIES = `${CHART_API}._chartWidget.model().mainSeries()`;
// 各週期的 K 棒間距（秒），用來確認讀到的序列真的是這個週期
const TF_SECONDS = { '60': 3600, '180': 10800, 'D': 86400, '3D': 259200 };
// 切換後的沉澱時間（ms）。資料是否就緒改由 waitForChart 輪詢判定，
// 這裡只要讓 setSymbol/setResolution 有機會生效即可。
const SYMBOL_WAIT = 150;
const TF_WAIT = 100;
// 等待圖表載入資料的輪詢間隔與逾時（ms）
const POLL_INTERVAL = 200;
const LOAD_TIMEOUT = 8000;
// 心跳：距離上次「掃描完成」超過 間隔 + 寬限 仍沒完成，就發逾時告警。
// 目的是讓「沒收到訊息」只剩一種解讀 —— 程式整個掛了。
const HEARTBEAT_GRACE_MIN = 5;
// 3D 移除條件往回看的 K 棒數：要夠長才找得到當作上漲錨點的那根紅吞
const REMOVAL_BARS_3D = 12;

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

// 往回找最近一根「紅吞」K 棒的索引（從 fromIdx 起往前，找不到回 -1）。
// 這根紅吞就是上漲趨勢的錨點：它的最低價被收盤跌破，等於結構被破壞。
function findLastBullEngulfIdx(bars, fromIdx) {
  for (let i = Math.min(fromIdx, bars.length - 1); i >= 1; i--) {
    if (isBullEngulf(bars[i], bars[i - 1])) return i;
  }
  return -1;
}

// 資料視窗的數值是格式化字串（可能含千分位逗號或 K/M/B 後綴）
function parseStudyNum(v) {
  if (v == null) return NaN;
  const m = String(v).replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if (!m) return NaN;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return parseFloat(m[1]) * mult;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function now() {
  return new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// K 棒時間 → MM/DD，用在移除依據裡標明是哪一根
function day(bar) {
  return new Date(bar.time * 1000).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
}

// 通知內文用的時間戳（含日期，方便在 TG 對照是哪一輪）
function stamp() {
  return new Date().toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ─── 心跳監看 ────────────────────────────────────
// 每次掃描完成後重新計時；逾時代表這一輪卡住了（CDP 沒回應、圖表切不動…）。
// 行程整個死掉時這個 timer 也跟著沒了 —— 那種情況靠「每輪都發」的沉默來判斷。
let heartbeatTimer = null;

function armHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const limitMin = INTERVAL_MIN + HEARTBEAT_GRACE_MIN;
  heartbeatTimer = setTimeout(async () => {
    console.error(`\n[${now()}] ⏰ 心跳逾時：已 ${limitMin} 分鐘沒有完成掃描`);
    await notify(
      '監控器心跳逾時',
      `時間：${stamp()}\n已超過 ${limitMin} 分鐘沒有完成任何一輪掃描\n可能卡在 CDP／圖表切換，請檢查監控器`,
      '⏰'
    );
  }, limitMin * 60 * 1000);
  heartbeatTimer.unref?.();
}

// parse_mode 是 HTML，錯誤訊息可能帶 < & 之類的字元，不跳脫會讓整則發送失敗
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// 輪詢等到「主序列本身」確實換成目標 symbol/TF 且 K 棒間距正確，才回傳資料。
//
// 兩層把關缺一不可：
//   1. 用 mainSeries 自己回報的 symbolInfo/interval，而不是 widget 的
//      symbol()/resolution() —— 後者在資料換好前就先更新了，照它判斷會
//      讀到上一個標的或上一個週期的 K 棒，卻以為是新的。
//   2. 再核對 K 棒間距等於該週期的秒數，序列還沒換掉就一定對不上。
//
// 這是「明明沒有黑吞卻被移出極速匡」的元凶：3D 檢查實際拿到的是上一輪
// 停留的 1H 序列，用它算吞噬等於在擲骰子。
async function waitForChart(symbol, tf, minBars, count, timeoutMs = LOAD_TIMEOUT) {
  const wantTf = tf === 'D' ? '1D' : tf;   // setResolution('D') 回報為 '1D'
  const wantSec = TF_SECONDS[tf];
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  let last = null;
  while (Date.now() < deadline) {
    const state = await evaluate(`(function() {
      try {
        var ms = ${MAIN_SERIES};
        var si = ms.symbolInfo();
        return { symbol: si && si.full_name, interval: ms.interval() };
      } catch (e) { return null; }
    })()`);
    last = state;
    if (state && state.symbol === symbol && state.interval === wantTf) {
      try {
        const result = await getOhlcv({ count });
        const bars = result?.bars || [];
        seen = bars.length;
        const spacingOk = bars.length >= 2 && (!wantSec || bars[1].time - bars[0].time === wantSec);
        if (seen >= minBars && spacingOk) return bars;
      } catch {
        // 資料尚未就緒，繼續等
      }
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(
    `${tf} 載入逾時（拿到 ${seen} 根，需要 ${minBars} 根；` +
    `序列為 ${last?.symbol ?? '?'} ${last?.interval ?? '?'}）`
  );
}

// 指標值是在序列載入後才重算的，切換完當下常常還讀不到。
// 讀不到就當「條件不成立」會靜靜漏掉進場信號 —— 改成輪詢等，
// 真的等不到就丟錯，由每輪摘要回報，不當作已判斷過。
async function waitForMaValue(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sv = await getStudyValues();
    const study = sv?.studies?.find(st => st.name && st.name.includes(MA_STUDY_NAME));
    const val = parseStudyNum(study?.values?.[MA_VALUE_KEY]);
    if (Number.isFinite(val)) return val;
    if (Date.now() >= deadline) {
      throw new Error(
        study
          ? `「${MA_STUDY_NAME}」的 ${MA_VALUE_KEY} 讀不到數值`
          : `圖表上找不到「${MA_STUDY_NAME}」指標（需保持可見）`
      );
    }
    await sleep(POLL_INTERVAL);
  }
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

// ─── 檢查極速匡移除條件：3D 黑吞，或跌破最近紅吞的最低價 ──────────
async function checkRemoval3D(tvSym) {
  try {
    await switchTo(tvSym, '3D');
    const b = await waitForChart(tvSym, '3D', 3, REMOVAL_BARS_3D);
    const curr = b[b.length - 1], prev = b[b.length - 2], prev2 = b[b.length - 3];
    // 附上判定依據的數字，讓通知可以直接被覆核，不必回頭開圖表對
    if (isBearEngulf(curr, prev)) {
      return {
        reason: '3D黑吞',
        detail: `${day(curr)} 收${curr.close}＜前根實體低${Math.min(prev.open, prev.close)}`,
      };
    }
    if (prev2 && isBearEngulf(prev, prev2)) {
      return {
        reason: '3D前根黑吞',
        detail: `${day(prev)} 收${prev.close}＜前根實體低${Math.min(prev2.open, prev2.close)}`,
      };
    }
    // 上漲結構被破壞：往回找最近一根紅吞（上漲趨勢的錨點），當前收盤跌破
    // 它的最低價（含下影線，不是實體低）就移除。從前一根起找：紅吞本身
    // 收盤必高於開盤，不可能跌破自己的低點。
    const anchorIdx = findLastBullEngulfIdx(b, b.length - 2);
    if (anchorIdx >= 0 && curr.close < b[anchorIdx].low) {
      const anchor = b[anchorIdx];
      return {
        reason: '3D跌破紅吞低',
        detail: `${day(curr)} 收${curr.close}＜${day(anchor)} 紅吞低${anchor.low}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}


// ─── 檢查單一幣對的進場條件 ──────────────────────────
// tvSym 為完整格式，如 "OKX:ENAUSDT.P"
async function checkEntry(tvSym) {
  const displayName = tvSym.split(':').pop().replace('.P', '');
  try {
    // 條件1：1D 當前紅吞，或前一根日K為黑吞/收黑K
    await switchTo(tvSym, 'D');
    const dBars = await waitForChart(tvSym, 'D', 2, 3);
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
    const bars3h = await waitForChart(tvSym, '180', 6, 7);

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
    const maVal = await waitForMaValue();
    if (curr3h.close <= maVal) return null;

    // 條件3：切換至 1H，取最近 3 根收盤連續墊高
    await switchTF('60');
    const b = await waitForChart(tvSym, '60', 3, 4);
    const h1_higher = b[b.length - 3].close < b[b.length - 2].close &&
      b[b.length - 2].close < b[b.length - 1].close;
    if (!h1_higher) return null;

    return { symbol: tvSym, displayName, price: curr3h.close, barTime: curr3h.time, d1Signal };
  } catch (e) {
    // 單一幣對失敗不中斷整輪，但要記下來讓本輪摘要看得到，不靜默吞掉
    return { error: e.message || String(e) };
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
    await notify(
      '監控器掃描錯誤',
      `時間：${stamp()}\n讀取監控清單失敗：${esc(e.message)}\n本輪未執行，${INTERVAL_MIN} 分鐘後重試`,
      '❌'
    );
    armHeartbeat();
    return;
  }

  // 已離開極速匡的幣對：清掉移除通知記錄，日後重新加回才會再通知
  const jskSymbols = new Set(lists.find(l => l.list === '極速匡')?.symbols || []);
  for (const s of removeNotified) if (!jskSymbols.has(s)) removeNotified.delete(s);

  const signals = [];
  const removals = [];
  const errors = [];         // 單一幣對的例外，彙總進本輪摘要
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
        const removal = await checkRemoval3D(tvSym);
        if (removal) {
          removals.push({ tvSym, displayName: label, ...removal });
          console.log(`🗑 ${removal.reason} → 待移除（${removal.detail}）`);
          continue;
        }
      }
      scanned.add(tvSym);
      const result = await checkEntry(tvSym);
      if (result?.error) {
        errors.push(`${label}：${result.error}`);
        console.log(`⚠️  ${result.error}`);
      } else if (result) {
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

  // 移除結果要進本輪摘要：標的、理由、判定依據都列出來，才能被覆核
  let removalNote = null;
  if (removals.length > 0) {
    console.log(`\n  🗑 自極速匡移除：${removals.map(r => r.displayName).join(', ')}`);
    try {
      const res = await removeFromList({ list: '極速匡', symbols: removals.map(r => r.tvSym) });
      // 只有真的移除成功才發專門的移除通知，否則每輪都會重掃到同一批幣對
      // 而重複發送。未成功的情況改由本輪摘要交代，不會靜悄悄。
      if (!res.verified) {
        removalNote = `移除未確認（下輪重試）：\n${removals.map(r => `${r.displayName}（${r.reason}：${r.detail}）`).join('\n')}`;
        console.warn('  ⚠️  移除未通過驗證，下次掃描將重試（不發專門通知，摘要會列出）');
      } else {
        removalNote = `已移除：\n${removals.map(r => `${r.displayName}（${r.reason}：${r.detail}）`).join('\n')}`;
        const fresh = removals.filter(r => !removeNotified.has(r.tvSym));
        if (fresh.length) {
          for (const r of fresh) removeNotified.add(r.tvSym);
          await notify(
            '極速匡移除訊號',
            fresh.map(r => `${r.displayName}（${r.reason}）\n　依據：${esc(r.detail)}`).join('\n'),
            '🗑'
          );
        }
      }
    } catch (e) {
      removalNote = `移除失敗（下輪重試）：${e.message}\n${removals.map(r => `${r.displayName}（${r.reason}：${r.detail}）`).join('\n')}`;
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

  // 每輪都回報一次，讓「沒收到訊息」只剩「監控器掛了」一種解讀
  const breakdown = lists.map(l => `${l.list} ${l.symbols.length}`).join('、');
  const summary = [
    `時間：${stamp()}`,
    `清單：${breakdown}（實掃 ${scanned.size} 個）`,
    signals.length > 0
      ? `結果：${signals.length} 個進場信號（另發個別通知）`
      : '結果：無符合目標',
  ];
  if (removalNote) summary.push(esc(removalNote));
  if (errors.length) {
    summary.push(`錯誤：${errors.length} 個`);
    summary.push(errors.slice(0, 5).map(esc).join('\n'));
    if (errors.length > 5) summary.push(`…另有 ${errors.length - 5} 個`);
  }
  await notify('極速匡掃描完成', summary.join('\n'), signals.length > 0 ? '📋' : '🟢');

  armHeartbeat();
  console.log(`[${now()}] ◀ 掃描完成，下次 ${INTERVAL_MIN} 分鐘後`);
}

// runScan 的例外不該讓監控器安靜地停擺：通知後照常等下一輪
async function safeScan() {
  try {
    await runScan();
  } catch (e) {
    console.error(`\n[${now()}] ❌ 掃描例外:`, e.message);
    await notify(
      '監控器掃描錯誤',
      `時間：${stamp()}\n本輪掃描中斷：${esc(e.message)}\n${INTERVAL_MIN} 分鐘後重試`,
      '❌'
    );
    armHeartbeat();
  }
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

  // 先起心跳：第一輪就卡住也要抓得到
  armHeartbeat();

  // 立即執行第一次
  await safeScan();

  // 定時循環
  setInterval(safeScan, INTERVAL_MIN * 60 * 1000);
}

main().catch(async err => {
  console.error('\n❌ 監控器錯誤:', err.message);
  await notify(
    '監控器已停止',
    `時間：${stamp()}\n致命錯誤：${esc(err.message)}\n監控器已結束，需要手動重啟`,
    '💀'
  );
  process.exit(1);
});
