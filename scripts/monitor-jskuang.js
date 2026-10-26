#!/usr/bin/env node
/**
 * 極速匡進場監控器
 *
 * 監控清單（TradingView watchlist 頁籤）：極速匡、加密貨幣
 *
 * 進場條件（2026-10-25 v5，做多，兩組策略並行，先到先贏）：
 *
 * 【A：破底後由黑轉紅】
 *   1. 3D：最近 5 根內曾「連續收黑K 之後出一根紅K」（轉紅那根不必是當前這根）
 *   2. 1D：最近 10 根內曾「連續收紅K 且收盤逐根遞增、其中某根高點突破 MA 1，
 *      之後出一根黑K」，且後續「未曾」跌破那根黑K 的低點、也「未曾」漲過它的高點
 *   3. 3H：前一根收黑K，或（前一根為「紅吞」且當前收黑）
 *   4. 1H：當前為「紅吞」；否則往前找最近一根紅吞，當前低點不得跌破它的低點
 *   進場＝斐波那契 1、停損＝斐波那契 0，錨在「那根紅吞的前一根」
 *   （當前就是紅吞時即前一根；走回看分支時則是那根紅吞的前一根）
 *
 * 【B：突破後進場】
 *   1. 3D：當前為「紅吞」
 *   2. 1D：(當前紅吞 且 低點不低於前一根 且 高點過 MA 1) 或 (前 2 根以上皆為紅吞)
 *   3. 3H：當前不限型態（紅吞／收黑／收紅皆可），但低點不得跌破「前面
 *      最近一根紅吞」的低點
 *   4. 1H：當前為「紅吞」或自身收黑（擇一），用前一根拉斐波那契
 *   進場＝斐波那契 1（前一根高點），停損＝斐波那契 0（前一根低點）
 *
 *   兩組共用同一次圖表載入（分開跑會讓每輪時間加倍），A 先判、A 不過才判 B。
 *   停利一律是斐波那契四段 10.8 / 20.8 / 30.8 / 50.8，各 1/4 部位。
 *
 *   吞噬定義（見 isBullEngulf/isBearEngulf）：
 *     紅吞＝當前漲過前一根的高點且自身收紅
 *     黑吞＝當前跌破前一根的低點且自身收黑
 *     （不限定前一根的顏色）
 *

 *
 * 極速匡移除條件（僅極速匡頁籤，見 REMOVAL_ENABLED）：
 *   18D 當前 K棒為「黑吞」→ 自清單移除並通知。
 *   18D 一根要 18 個交易日，訊號極少但份量重；新上市幣對常常沒有足夠的
 *   18D 歷史，那種情況會回報讀取錯誤（進本輪摘要），不會當成「不用移除」。
 *
 * 自動下單（模擬交易「極速匡帳戶」，見 TRADING_ENABLED）：
 *   抓到進場信號就掛限價單 —— 價格全部來自條件 4 的斐波那契：
 *   進場在 0.7、停損在 0（黑K低點），停利四段 10.8/20.8/30.8/50.8 各 1/4 部位，
 *   單筆風險＝權益 2%；總資金虧損超過 20% 時自動降為 0.5%。
 *   保本階梯：價格觸及第 N 個停利點後，停損移到第 N−1 個停利點
 *   （N=1 時移到成本價），每輪檢查一次，只往上搬不往下退。
 *   9 小時（3 根 3H K 棒）沒成交就撤單。
 *   每筆都寫進 trades-jskuang.jsonl，同一根 K 棒不會重複下單。
 *
 * Telegram 通知：
 *   - 進場信號：每個符合的幣對各發一則（格式未變）
 *   - 每輪摘要：不論有無符合目標，每輪掃完都發一則（時間／清單與掃描數／結果）
 *   - 錯誤：讀清單失敗、掃描例外、致命錯誤各自發通知，不靜默吞掉。
 *     連線類的失敗會先自動重連一次（重挑 CDP 分頁）；救得回來就照常掃描，
 *     救不回來才通知，並附上診斷（crash／接錯分頁／TradingView 已關閉）。
 *   - 心跳：超過 間隔 + 5 分鐘 沒完成任何一輪掃描就發逾時告警
 *   於是「完全沒收到訊息」只剩一種解讀 —— 行程整個掛了。
 *
 * 用法：node scripts/monitor-jskuang.js [間隔分鐘數，預設 30]
 */

import { connect, disconnect, evaluate, evaluateAsync, getTargetInfo } from '../src/connection.js';
import { getOhlcv, getStudyValues } from '../src/core/data.js';
import { removeFromList } from '../src/core/watchlist.js';
import { tradeSignal, expireStaleOrders, trailStops, ORDER_TTL_MS, DRAWDOWN_TRIGGER, RISK_PCT_REDUCED } from './lib/jsk-trade.js';
import { drawEntryFib } from './lib/fib-draw.js';

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
const TF_SECONDS = { '60': 3600, '180': 10800, 'D': 86400, '3D': 259200, '18D': 1555200 };
// 切換後的沉澱時間（ms）。資料是否就緒改由 waitForChart 輪詢判定，
// 這裡只要讓 setSymbol/setResolution 有機會生效即可。
const SYMBOL_WAIT = 150;
const TF_WAIT = 100;
// 等待圖表載入資料的輪詢間隔與逾時（ms）
const POLL_INTERVAL = 200;
const LOAD_TIMEOUT = 8000;
// 指標值的等待逾時（ms）。原本 3 秒太緊：一輪要切換 39 個標的 × 3~4 個週期，
// 圖表持續重載，而每次輪詢的 getStudyValues 會走訪圖表上全部指標，負載下
// 單次就要好幾百毫秒 —— 3 秒只夠輪詢五到八次，慢的標的（新上市、資料沒快取）
// 來不及算完就被判成失敗，白白漏掉已經通過 1D 與 3H 條件的候選標的。
const MA_TIMEOUT_MS = 8000;
// 心跳：距離上次「掃描完成」超過 間隔 + 寬限 仍沒完成，就發逾時告警。
// 目的是讓「沒收到訊息」只剩一種解讀 —— 程式整個掛了。
const HEARTBEAT_GRACE_MIN = 5;
// 移除檢查的總開關。false = 只做進場判斷，不從清單移除任何標的。
// 2026-09-19 暫停、2026-10-25 隨著條件改為 18D 黑吞一併恢復
//（要再暫停就改回 false，或設環境變數 JSK_REMOVAL=off）。
const REMOVAL_ENABLED = process.env.JSK_REMOVAL
  ? process.env.JSK_REMOVAL.toLowerCase() === 'on'
  : true;
// 進場條件裡「連續收黑K／連續收紅K」至少要幾根。字面上「連續」就是 2 根
// 以上，調這個等於調整型態的嚴格程度。
const MIN_RUN = 2;
// 移除檢查要抓的 18D K 棒數（只需要當前與前一根，多抓一點確保間距對得上）
const REMOVAL_BARS_18D = 4;
// Telegram 發送逾時（ms）。Node fetch 預設不逾時，卡住會拖垮整輪。
const TG_TIMEOUT_MS = 10000;
// 自動下單總開關（模擬交易「極速匡帳戶」）。關掉就只發信號不下單。
// 2026-10-16 起啟用：抓到信號就掛限價單，進場＝3H紅吞前一根的高點，
// 停損＝該根低點，停利分 5R 與 10R 兩批，單筆風險 2% 權益。
const TRADING_ENABLED = process.env.JSK_TRADING
  ? process.env.JSK_TRADING.toLowerCase() === 'on'
  : true;

// 已通知記錄：避免同一根 K 棒重複通知（key = symbol+barTime）
const notified = new Set();
// 已通知移除的幣對（key = tvSym）。移除驗證失敗時避免每輪重發；
// 幣對確實離開清單後會清掉記錄，日後重新加回才會再通知。
const removeNotified = new Set();

// ─── 吞噬判斷（2026-10-25 使用者重新定義）────────────────
//
// 紅吞：當前 K 棒漲過「前一根黑K」的高點，且自身收紅。
// 黑吞：當前 K 棒跌破「前一根紅K」的低點，且自身收黑。
//
// 與更舊的版本相比，比的是「高低點」（含影線）而不是收盤價，也不是實體邊界。
//
// 2026-10-25 修正：原本還多要求「前一根必須是黑K／紅K」，那是把使用者原話
// 裡的「前根黑K」讀成了限制。實際上那只是描述典型情況 —— ERAUSDT 的 3D
// 前一根是紅K、當前高點 0.10182 過了前根的 0.08325 且收紅，使用者認定那
// 就是紅吞。拿掉顏色限制後，「連續紅吞」也才可能成立（B 的條件 2 用得到）。
function isBullEngulf(c, p) {
  return c.high > p.high       // 當前有漲過前一根的高點
    && c.close > c.open;       // 當前自身收紅
}
function isBearEngulf(c, p) {
  return c.low < p.low         // 當前有跌破前一根的低點
    && c.close < c.open;       // 當前自身收黑
}

// 往回找最近一根「紅吞」K 棒的索引（從 fromIdx 起往前，找不到回 -1）。
// 這根紅吞就是上漲趨勢的錨點：它的最低價被收盤跌破，等於結構被破壞。
function findLastBullEngulfIdx(bars, fromIdx) {
  for (let i = Math.min(fromIdx, bars.length - 1); i >= 1; i--) {
    if (isBullEngulf(bars[i], bars[i - 1])) return i;
  }
  return -1;
}

// 策略A 條件1 的回看視窗：轉紅那根要落在最近幾根 3D 之內。
const LOOKBACK_3D = 5;
// 策略A 條件2 的回看視窗：「出黑K」那根要落在最近幾根 1D 之內。
// 使用者只說「曾」沒給根數，取 10 天；黑K 之前的連續紅K 可以延伸到視窗之外。
const LOOKBACK_1D = 10;

// 在最近 lookback 根裡找「連續收黑K 之後出一根紅K」的型態。
// 轉紅那根不必是當前這根 —— 只要型態出現在視窗內就算數。
// 黑K 串可以延伸到視窗之外：視窗限制的是「多久以前轉紅的」，不是黑K 有多長。
// 回傳最近的一組 { redIdx, blackRun, agoBars }，找不到回 null。
function findBlackToRed(bars, lookback) {
  const start = Math.max(1, bars.length - lookback);
  for (let i = bars.length - 1; i >= start; i--) {
    if (!(bars[i].close > bars[i].open)) continue;      // 要是紅K
    let blackRun = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (bars[j].close < bars[j].open) blackRun++; else break;
    }
    if (blackRun >= MIN_RUN) return { redIdx: i, blackRun, agoBars: bars.length - 1 - i };
  }
  return null;
}

// 在最近 lookback 根裡找策略A 條件2 的型態：
//   連續收紅K（收盤遞增、其中某根高點過 MA）→ 出一根黑K
//   → 後續「未曾」跌破那根黑K 的低點，也「未曾」漲過那根黑K 的高點
//
// 那根黑K 是上升段裡的回檔，高低兩端都還沒被突破＝價格仍收在它的範圍內，
// 盤整還沒表態。進場點由更小週期（條件3、4）去抓轉折，等於在突破發生之前卡位。
// （這兩個判定都翻轉過：10-24 曾是「後續有跌破」，10-25 曾是「曾漲過高點」，
//  都與現在相反，見 git 紀錄。）
//
// 黑K 可以是當前這根 —— 還沒有後續 K 棒，兩邊自然都還沒被突破。
// 回傳最近成立的一組；不成立時 why 取「最近一根黑K 候選」卡在哪，卡關統計才有意義。
//
// 注意：maVal 是「現在」的 MA 值，拿去比對可能是好幾天前的紅K 高點。
// 資料視窗只給得到當下的指標值，要精確就得另外抓 MA 的歷史序列。
function findRedRunThenHold(bars, maVal, lookback) {
  const start = Math.max(1, bars.length - lookback);
  // why 給人看（帶實際數字），whyKey 給卡關統計用（同類要能累加，不能把價格
  // 寫進去 —— 每個標的的價格都不一樣，統計就會變成一堆 ×1 的單筆）。
  // 只記「最近那根黑K 候選」卡在哪；再往回的候選不覆寫它。
  let why = null, whyKey = null;
  const note = (msg, key) => { if (why === null) { why = msg; whyKey = key || msg; } };
  for (let k = bars.length - 1; k >= start; k--) {
    const black = bars[k];
    if (!(black.close < black.open)) continue;

    const redRun = [];
    for (let j = k - 1; j >= 0; j--) {
      if (bars[j].close > bars[j].open) redRun.unshift(bars[j]); else break;
    }
    if (redRun.length < MIN_RUN) { note(`連續紅K只有 ${redRun.length} 根`, `連續紅K不足 ${MIN_RUN} 根`); continue; }

    let ascending = true;
    for (let i = 1; i < redRun.length; i++) {
      if (!(redRun[i].close > redRun[i - 1].close)) { ascending = false; break; }
    }
    if (!ascending) { note('紅K收盤沒遞增'); continue; }

    if (!redRun.some(b => b.high > maVal)) { note('沒有任何紅K高點過MA'); continue; }

    let brokenIdx = -1;
    for (let j = k + 1; j < bars.length; j++) {
      if (bars[j].low < black.low) { brokenIdx = j; break; }
    }
    if (brokenIdx >= 0) {
      note(`後續跌破黑K低點 ${black.low}（${bars.length - 1 - brokenIdx}根前）`, '後續跌破黑K低點');
      continue;
    }

    let overIdx = -1;
    for (let j = k + 1; j < bars.length; j++) {
      if (bars[j].high > black.high) { overIdx = j; break; }
    }
    if (overIdx >= 0) {
      note(`後續漲過黑K高點 ${black.high}（${bars.length - 1 - overIdx}根前）`, '後續漲過黑K高點');
      continue;
    }

    return { ok: true, redRun, black, blackIdx: k,
             agoBars: bars.length - 1 - k, heldBars: bars.length - 1 - k };
  }
  const fallback = `前${lookback}根內沒有黑K`;
  return { ok: false, why: why || fallback, whyKey: whyKey || fallback };
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
    // Node 的 fetch 預設不逾時：TG 端卡住會讓整輪掃描一起吊死
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const json = await res.json();
    // 同時寫進主 log：只寫 stderr 的話 tail log 看不到，會誤判成行程死了
    if (!json.ok) {
      console.log(`  ⚠️  TG 發送失敗：${json.description}`);
      console.error('TG 發送失敗:', json.description);
    }
  } catch (e) {
    console.log(`  ⚠️  TG 通知錯誤：${e.message}`);
    console.error('TG 通知錯誤:', e.message);
  }
}

// ─── 連線健康檢查與自動重連 ────────────────────────
// CDP 連線活著不代表接的是圖表：TradingView 的 renderer crash 後，分頁會被
// 換成 error-view 錯誤畫面，連線照樣通、evaluate 照樣能跑，但 TradingViewApi
// 不存在、location.origin 變成 file://，於是每輪都卡在讀清單的 Failed to fetch。
// 「9222 還開著」因此完全不能當作健康指標。
async function chartHealth() {
  let url = '', title = '';
  try {
    const info = await getTargetInfo();
    url = info?.url || '';
    title = info?.title || '';
  } catch { /* 取不到分頁資訊就只靠下面的 API 探測 */ }
  let ok = false;
  try {
    ok = await evaluate(
      'typeof window.TradingViewApi !== "undefined" && !!window.TradingViewApi._activeChartWidgetWV'
    ) === true;
  } catch { ok = false; }
  return { ok, url, title };
}

// 把「連到的是什麼」翻成人看得懂的一句話，別讓使用者對著 Failed to fetch 猜
function diagnose({ url, title }) {
  // Electron 內部頁的 title/url 會塞一長串 URL-encoded 參數，截掉才看得懂
  const where = String(title || url).replace(/\?.*$/, '').slice(0, 60);
  if (/error-view|crashReason/i.test(url)) {
    return 'TradingView 圖表已 crash（分頁變成錯誤畫面），需要重啟 TradingView';
  }
  if (/^file:/i.test(url)) {
    return `連到的不是圖表分頁而是 TradingView 的外框視窗（${where}）`;
  }
  if (!url) return '取不到 CDP 分頁資訊，TradingView 可能已關閉';
  return `圖表 API 讀不到（目前分頁：${where}）`;
}

// 失敗時先重挑一次分頁再試：接錯分頁這種狀況重連就能救回來，
// 真的是 crash 則回報明確原因，由通知講給使用者聽。
async function tryReconnect() {
  try {
    await disconnect();
  } catch { /* 舊連線已經沒了就算了 */ }
  try {
    await connect();
  } catch (e) {
    return { ok: false, note: `重新連線失敗：${e.message}` };
  }
  const h = await chartHealth();
  return h.ok
    ? { ok: true, note: `已重新連線至 ${h.url}` }
    : { ok: false, note: diagnose(h) };
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

// 指標在不在圖表上 —— 只看 dataSources 的名稱，不管算出值了沒。
// getStudyValues 會把「資料視窗全是 ∅」的指標整個濾掉（data.js 的
// `if (Object.keys(values).length > 0)`），所以單靠它分不出「指標被移除了」
// 和「指標還在重算」，兩者都長成「找不到指標」。查不到清單時回 null。
async function studyOnChart(nameSubstr) {
  try {
    const names = await evaluate(`(function() {
      var sources = ${CHART_API}._chartWidget.model().model().dataSources();
      var out = [];
      for (var i = 0; i < sources.length; i++) {
        try {
          var m = sources[i].metaInfo && sources[i].metaInfo();
          if (m) out.push(m.description || m.shortDescription || '');
        } catch (e) {}
      }
      return out.filter(Boolean);
    })()`);
    if (!Array.isArray(names)) return null;
    return names.some(n => n.includes(nameSubstr));
  } catch {
    return null;
  }
}

// 指標值是在序列載入後才重算的，切換完當下常常還讀不到。
// 讀不到就當「條件不成立」會靜靜漏掉進場信號 —— 改成輪詢等，
// 真的等不到就丟錯，由每輪摘要回報，不當作已判斷過。
async function waitForMaValue(timeoutMs = MA_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sv = await getStudyValues();
    const study = sv?.studies?.find(st => st.name && st.name.includes(MA_STUDY_NAME));
    const val = parseStudyNum(study?.values?.[MA_VALUE_KEY]);
    if (Number.isFinite(val)) return val;
    if (Date.now() >= deadline) {
      // 讀不到值不等於指標不在：另外查一次名稱清單才講得出是哪一種，
      // 否則訊息會叫人去檢查一個明明就開著的指標。
      const onChart = await studyOnChart(MA_STUDY_NAME);
      const secs = Math.round(timeoutMs / 1000);
      if (onChart === true) {
        throw new Error(
          `「${MA_STUDY_NAME}」在圖表上，但 ${secs} 秒內沒算出 ${MA_VALUE_KEY}（指標重算較慢，下輪重試）`
        );
      }
      if (onChart === false) {
        throw new Error(`圖表上找不到「${MA_STUDY_NAME}」指標（需保持可見）`);
      }
      throw new Error(`讀不到「${MA_STUDY_NAME}」的 ${MA_VALUE_KEY}，且查不到圖表的指標清單`);
    }
    await sleep(POLL_INTERVAL);
  }
}

// ─── 讀取雲端自訂清單（權威來源）────────────────────
// 桌面版 widget 不會即時同步 API 的異動：移除成功後畫面仍留著舊的 row。
// 改以 REST 為準，否則下一輪會掃到已移除的殭屍標的並重複通知。
async function fetchCustomLists() {
  // 失敗不能回空陣列：那會讓「REST 掛了」和「沒有任何自訂清單」完全同形，
  // 接著退去讀 DOM、讀到 0 個標的，最後發出一則綠燈的「無符合目標」。
  const res = await evaluateAsync(`
    fetch(location.origin + '/api/v1/symbols_list/custom/', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(j) {
        return { ok: true, lists: Array.isArray(j)
          ? j.map(function(x) { return { id: x.id, name: x.name, symbols: x.symbols || [] }; })
          : [] };
      })
      .catch(function(e) { return { ok: false, error: String((e && e.message) || e) }; })
  `);
  if (!res || res.ok !== true) {
    throw new Error(`讀取雲端自訂清單失敗：${res?.error || 'CDP 無回應'}`);
  }
  return res.lists || [];
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

// ─── 檢查極速匡移除條件：18D 黑吞 ──────────
// 2026-10-25 使用者改版：原本是「3D 收盤跌破最後一次紅吞的最低價」，
// 現在改成最大週期的反轉訊號 —— 18D 當前 K 棒為黑吞就出清。
// 18D 一根要 18 個交易日，訊號極少但份量重。
async function checkRemoval18D(tvSym) {
  try {
    await switchTo(tvSym, '18D');
    const b = await waitForChart(tvSym, '18D', 2, REMOVAL_BARS_18D);
    const curr = b[b.length - 1];
    const prev = b[b.length - 2];
    if (isBearEngulf(curr, prev)) {
      // 附上判定依據的數字，讓通知可以直接被覆核，不必回頭開圖表對
      return {
        reason: '18D黑吞',
        detail: `${day(curr)} 收${curr.close}＜前根實體低${Math.min(prev.open, prev.close)}`,
      };
    }
    return null;
  } catch (e) {
    // 吞掉例外等於把「圖表載入失敗」當成「不用移除」，標的會靜靜留在清單裡。
    // 比照 checkEntry 回報錯誤，由本輪摘要交代。
    return { error: e.message || String(e) };
  }
}


// ─── 兩組策略的判定（純函式，不碰圖表）────────────────────
// 刻意不做 I/O：資料由呼叫端一次載入後傳進來，兩組共用，也才能單元測試。
// 回傳 { ok:true, signal } 或 { ok:false, stage, why }。

/** A：破底後由黑轉紅 */
function evalStrategyA({ bars3d, barsD, maVal, bars3h, bars1h }) {
  // 「前 5 根內曾連續收黑K後出一根紅K」—— 轉紅那根不必是當前這根，只要這個
  // 型態出現在最近 LOOKBACK_3D 根之內就算數。之前要求當前必須是紅K，等於
  // 只接受「剛好這一根轉紅」的瞬間，錯過就得等下一輪，大多數標的卡死在這關。
  const found = findBlackToRed(bars3d, LOOKBACK_3D);
  if (!found) {
    const tail = bars3d.slice(-LOOKBACK_3D).map(b => b.close > b.open ? '紅' : b.close < b.open ? '黑' : '平').join('');
    return { ok: false, stage: '1',
             why: `前${LOOKBACK_3D}根沒有連${MIN_RUN}黑轉紅（${tail}）`,
             whyKey: `前${LOOKBACK_3D}根沒有連${MIN_RUN}黑轉紅` };
  }
  const { blackRun, agoBars } = found;

  // 「曾連續收紅K、收盤遞增、某根高點過 MA 1，之後出一根黑K，後續未曾跌破
  // 這根黑K 的低點、也未曾漲過它的高點」。跟條件1 一樣用「曾」：黑K 不必是
  // 最近那根。高低兩端都還沒被突破＝價格仍收在那根黑K 的範圍內、盤整還沒表態。
  const d1 = findRedRunThenHold(barsD, maVal, LOOKBACK_1D);
  if (!d1.ok) return { ok: false, stage: '2', why: d1.why, whyKey: d1.whyKey };
  const { redRun, black: blackD, agoBars: blackAgo } = d1;

  // 條件3：前一根收黑 或（前一根是紅吞 且 當前收黑）。
  // 後者是「紅吞之後拉回一根黑K」—— 一樣是回檔，只是回檔那根出現在當前。
  const curr3h = bars3h[bars3h.length - 1];
  const prev3h = bars3h[bars3h.length - 2];
  const prevBlack3h = prev3h.close < prev3h.open;
  const prevEngulfCurrBlack3h = bars3h.length >= 3
    && isBullEngulf(prev3h, bars3h[bars3h.length - 3])
    && curr3h.close < curr3h.open;
  if (!prevBlack3h && !prevEngulfCurrBlack3h) {
    return { ok: false, stage: '3', why: '3H前一根不是黑K、也不是「前根紅吞+當前收黑」' };
  }

  // 條件4：當前紅吞 → 斐波那契錨在前一根；
  //        否則往前找最近一根紅吞，當前低點不得跌破它的低點，
  //        斐波那契錨在「那根紅吞的前一根」。
  // 兩個分支的錨點都是「紅吞的前一根」，差別只在那根紅吞是不是當前這根。
  const curr1h = bars1h[bars1h.length - 1];
  const prev1h = bars1h[bars1h.length - 2];
  let fibIdx1h, h1Signal;
  if (isBullEngulf(curr1h, prev1h)) {
    fibIdx1h = bars1h.length - 2;
    h1Signal = '1H紅吞';
  } else {
    const ei = findLastBullEngulfIdx(bars1h, bars1h.length - 2);
    if (ei < 1) {
      return { ok: false, stage: '4', why: `1H不是紅吞，往前${bars1h.length - 1}根也找不到紅吞` };
    }
    const anchor1h = bars1h[ei];
    if (!(curr1h.low >= anchor1h.low)) {
      return { ok: false, stage: '4', why: '1H跌破前波紅吞的低點',
               whyKey: '1H跌破前波紅吞的低點' };
    }
    fibIdx1h = ei - 1;
    h1Signal = `1H未破前波紅吞低點(${anchor1h.low})`;
  }
  const fib1h = bars1h[fibIdx1h];

  return { ok: true, signal: {
    strategy: 'A',
    price: curr1h.close, barTime: curr1h.time,
    d3Signal: agoBars === 0 ? `3D連${blackRun}黑轉紅` : `3D連${blackRun}黑轉紅（${agoBars}根前）`,
    d1Signal: `1D連${redRun.length}紅遞增過MA(${maVal})後轉黑（${blackAgo}根前，高${blackD.high}低${blackD.low}兩端皆未破）`,
    h3Signal: prevBlack3h ? '3H前根收黑' : '3H前根紅吞+當前收黑', h1Signal,
    fibBar: { high: fib1h.high, low: fib1h.low, time: fib1h.time },
    entryPrice: fib1h.high,     // 斐波那契 1
    stopPrice: fib1h.low,       // 斐波那契 0
  } };
}

/** B：突破後進場 */
function evalStrategyB({ bars3d, barsD, maVal, bars3h, bars1h }) {
  const curr3d = bars3d[bars3d.length - 1];
  const prev3d = bars3d[bars3d.length - 2];
  if (!isBullEngulf(curr3d, prev3d)) return { ok: false, stage: '1', why: '3D不是紅吞' };

  const currD = barsD[barsD.length - 1];
  const prevD = barsD[barsD.length - 2];
  // 型態 A：當前紅吞 + 低點不低於前一根 + 高點過 MA
  const d1a = isBullEngulf(currD, prevD) && currD.low >= prevD.low && currD.high > maVal;
  // 型態 B：前 2 根以上皆為紅吞。
  // 拿掉吞噬的顏色限制之後這個分支才可能成立 —— 先前要求「前一根是黑K」時，
  // 兩根相鄰的紅吞在邏輯上互相矛盾，這條路永遠走不到。
  let bullRun = 0;
  for (let i = barsD.length - 2; i >= 1; i--) {
    if (isBullEngulf(barsD[i], barsD[i - 1])) bullRun++; else break;
  }
  const d1b = bullRun >= MIN_RUN;
  if (!d1a && !d1b) {
    return { ok: false, stage: '2', why: isBullEngulf(currD, prevD)
      ? (currD.low >= prevD.low ? '1D高點沒過MA' : '1D低點比前一根低')
      : '1D不是紅吞且前面沒有連續紅吞' };
  }

  const curr3h = bars3h[bars3h.length - 1];
  // 當前這根是紅吞／收黑／收紅都可以（三者涵蓋所有 K 棒，等於不限型態），
  // 真正的要求只有一個：不能跌破「前面那根紅吞」的低點 —— 那根紅吞是突破
  // 結構的錨點，低點被破就代表突破失敗。
  const anchorIdx3h = findLastBullEngulfIdx(bars3h, bars3h.length - 2);
  if (anchorIdx3h < 0) return { ok: false, stage: '3', why: `3H前面${bars3h.length - 1}根內沒有紅吞` };
  const anchor3h = bars3h[anchorIdx3h];
  if (!(curr3h.low >= anchor3h.low)) return { ok: false, stage: '3', why: '3H跌破前面紅吞的低點' };

  // 當前紅吞 或 自身收黑，擇一即可；斐波那契錨在前一根（1=高點、0=低點）
  const curr1h = bars1h[bars1h.length - 1];
  const prev1h = bars1h[bars1h.length - 2];
  const engulf1h = isBullEngulf(curr1h, prev1h);
  const black1h = curr1h.close < curr1h.open;
  if (!engulf1h && !black1h) return { ok: false, stage: '4', why: '1H既不是紅吞、自身也不是黑K' };

  return { ok: true, signal: {
    strategy: 'B',
    price: curr1h.close, barTime: curr1h.time,
    d3Signal: '3D紅吞',
    d1Signal: d1a ? `1D紅吞不破前低且高點過MA(${maVal})` : `1D前${bullRun}根紅吞`,
    h3Signal: `未破前面紅吞低點(${anchor3h.low})`, h1Signal: engulf1h ? '1H紅吞' : '1H收黑',
    fibBar: { high: prev1h.high, low: prev1h.low, time: prev1h.time },
    entryPrice: prev1h.high,     // 斐波那契 1
    stopPrice: prev1h.low,       // 斐波那契 0
  } };
}

// 不通過時回報「卡在第幾關」，而不是單純的 null —— 一直盲調條件卻不知道
// 瓶頸在哪，等於在猜。每輪會把統計印出來並帶進 TG 摘要。
function rej(stage, why) { return { rejected: true, stage, why }; }

// ─── 檢查單一幣對的進場條件 ──────────────────────────
// tvSym 為完整格式，如 "OKX:ENAUSDT.P"
async function checkEntry(tvSym) {
  const displayName = tvSym.split(':').pop().replace('.P', '');
  try {
    // 四個週期各載入一次，兩組策略共用 —— 分開跑會讓每輪時間加倍
    await switchTo(tvSym, '3D');
    // 策略A 條件1 要回看 5 根找「黑轉紅」，再加上它前面的黑K 串，窗口要夠長
    const bars3d = await waitForChart(tvSym, '3D', 4, 12);
    await switchTF('D');
    // 策略A 條件2 要回看 10 根找「黑K」，再加上它前面的連續紅K，窗口要夠長
    const barsD = await waitForChart(tvSym, 'D', 4, 20);
    const maVal = await waitForMaValue();   // MA 必須在 1D 上讀
    await switchTF('180');
    // 策略B 條件3 要往回找「前面那根紅吞」，窗口太短會找不到而誤判，多抓一些
    const bars3h = await waitForChart(tvSym, '180', 3, 12);
    await switchTF('60');
    // 策略A 條件4 當前不是紅吞時要往回找「前波紅吞」，窗口太短會誤判成沒有
    const bars1h = await waitForChart(tvSym, '60', 3, 12);

    const data = { bars3d, barsD, maVal, bars3h, bars1h };
    const a = evalStrategyA(data);
    if (a.ok) return { symbol: tvSym, displayName, ...a.signal };
    const b = evalStrategyB(data);
    if (b.ok) return { symbol: tvSym, displayName, ...b.signal };

    // 兩組都不過：兩邊的卡關原因都回報，統計才看得出各自的瓶頸
    // whyKey 一定要一起帶出去 —— 漏掉的話卡關統計會退回用 why，價格就又
    // 回到統計的 key 裡，同一個原因被拆成一堆 ×1。
    return { rejected: true,
             a: { stage: a.stage, why: a.why, whyKey: a.whyKey },
             b: { stage: b.stage, why: b.why, whyKey: b.whyKey } };
  } catch (e) {
    // 單一幣對失敗不中斷整輪，但要記下來讓本輪摘要看得到，不靜默吞掉
    return { error: e.message || String(e) };
  }
}

// 錯誤通知統一走這裡，確保「發生什麼事」和「診斷」都講出來
async function failRound(reason, diagnosis) {
  console.error('  ❌', reason, diagnosis ? `｜${diagnosis}` : '');
  const lines = [`時間：${stamp()}`, esc(reason)];
  if (diagnosis) lines.push(`診斷：${esc(diagnosis)}`);
  lines.push(`本輪未執行，${INTERVAL_MIN} 分鐘後重試`);
  await notify('監控器掃描錯誤', lines.join('\n'), '❌');
  armHeartbeat();
}

// ─── 單次掃描 ────────────────────────────────────
async function runScan() {
  console.log(`\n[${now()}] ▶ 開始掃描清單（${WATCHLISTS.join('、')}）...`);
  let lists;
  try {
    lists = await fetchWatchlists(WATCHLISTS);
  } catch (e) {
    console.warn('  ⚠️  讀取清單失敗，嘗試重新連線:', e.message);
    const recovery = await tryReconnect();
    if (recovery.ok) {
      console.log(`  🔄 ${recovery.note}`);
      try {
        lists = await fetchWatchlists(WATCHLISTS);
        console.log('  ✅ 重新連線後讀取成功，本輪照常掃描');
      } catch (e2) {
        lists = null;
        await failRound(`讀取監控清單失敗（重連後仍失敗）：${e2.message}`, recovery.note);
      }
    } else {
      lists = null;
      await failRound(`讀取監控清單失敗：${e.message}`, recovery.note);
    }
    if (!lists) return;
  }

  // 清單讀到 0 個標的代表讀取管道壞了，不是「今天沒標的」。
  // 全空就當這輪失敗，否則會發出一則跟平靜盤勢一模一樣的綠燈摘要。
  const emptyLists = lists.filter(l => !l.symbols.length).map(l => l.list);
  if (emptyLists.length === lists.length) {
    const msg = `所有監控清單都讀到 0 個標的（${emptyLists.join('、')}）`;
    console.error('  ❌', msg);
    await notify(
      '監控器掃描錯誤',
      `時間：${stamp()}\n${esc(msg)}\n本輪未執行，${INTERVAL_MIN} 分鐘後重試`,
      '❌'
    );
    armHeartbeat();
    return;
  }
  if (emptyLists.length) console.warn(`  ⚠️  讀到 0 個標的的清單：${emptyLists.join('、')}`);

  // 已離開極速匡的幣對：清掉移除通知記錄，日後重新加回才會再通知。
  // 極速匡本身沒讀到時跳過，否則會清空記錄、下輪把整批移除通知重發一次。
  const jskList = lists.find(l => l.list === '極速匡');
  if (jskList?.symbols.length) {
    const jskSymbols = new Set(jskList.symbols);
    for (const s of removeNotified) if (!jskSymbols.has(s)) removeNotified.delete(s);
  }

  const signals = [];
  const rejections = new Map();   // 卡關統計：'條件2：紅K收盤沒遞增' → 次數
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
      // 移除條件僅適用極速匡：18D 黑吞 → 待移除，跳過進場檢查
      if (list === '極速匡' && REMOVAL_ENABLED) {
        const removal = await checkRemoval18D(tvSym);
        if (removal?.error) {
          // 移除狀態不明時不做進場判斷：寧可這輪跳過，也不要對一個
          // 可能該被移除的標的發進場信號
          errors.push(`${label}：移除檢查失敗 — ${removal.error}`);
          console.log(`⚠️  移除檢查失敗：${removal.error}`);
          continue;
        }
        if (removal) {
          removals.push({ tvSym, displayName: label, ...removal });
          console.log(`🗑 ${removal.reason} → 待移除（${removal.detail}）`);
          continue;
        }
      }
      scanned.add(tvSym);
      const result = await checkEntry(tvSym);
      if (result?.rejected) {
        for (const [tag, r] of [['A', result.a], ['B', result.b]]) {
          // 統計要用 whyKey（不含價格等各標的不同的數字），否則同一個原因會
          // 被拆成一堆 ×1，前五名全是單筆，等於沒有統計。
          const key = `${tag}條件${r.stage}：${r.whyKey || r.why}`;
          rejections.set(key, (rejections.get(key) || 0) + 1);
        }
        console.log('—');
      } else if (result?.error) {
        errors.push(`${label}：${result.error}`);
        console.log(`⚠️  ${result.error}`);
      } else if (result) {
        const key = `${tvSym}-${result.barTime}`;
        if (!notified.has(key)) {
          notified.add(key);
          console.log('🔔 進場信號！');
          // 下單要在這裡做：圖表現在還停在這個標的上，
          // 迴圈一往下走就會被切到下一個，訂單視窗會跟著換商品。
          let trade = null;
          // 兩組策略都明確給出 entryPrice / stopPrice，缺了就是判定端的 bug ——
          // 要吵出來，不能像之前那樣悄悄跳過下單（信號照發、單卻沒下）。
          if (TRADING_ENABLED && (result.entryPrice == null || result.stopPrice == null)) {
            trade = { ok: false, reason: '信號沒帶進場價或停損價' };
            console.warn('  ⚠️  下單失敗：信號沒帶進場價或停損價');
          } else if (TRADING_ENABLED) {
            try {
              trade = await tradeSignal({
                symbol: tvSym, fibBar: result.fibBar,
                entryPrice: result.entryPrice, stopPrice: result.stopPrice,
                variant: result.strategy, barTime: result.barTime,
              });
              if (trade.skipped) {
                console.log(`  ⏭ 不下單：${trade.reason}`);
              } else if (trade.ok) {
                const p2 = trade.plan;
                console.log(`  💰 已下單：進場 ${p2.entry} 停損 ${p2.stop} 數量 ${p2.qtyEach}×2 ` +
                  `風險 ${p2.actualRiskUSD} USD（${(p2.riskPct * 100).toFixed(2)}%` +
                  `${p2.riskReduced ? `，回撤 ${(p2.drawdown * 100).toFixed(1)}% 已降風險` : ''}）`);
                // 把這筆單的斐波那契畫到圖上。要趁現在 —— 圖表還停在這個標的，
                // 迴圈往下走就被切走了。畫失敗不影響這筆單，只記一行。
                if (result.fibBar) {
                  const fib = await drawEntryFib({
                    fibBar: result.fibBar, targets: p2.targets, tag: result.displayName,
                  });
                  console.log(fib.skipped ? `  📐 ${fib.reason}，不重複拉`
                    : fib.ok ? `  📐 已畫斐波那契（${fib.id}）`
                    : `  ⚠️  斐波那契沒畫成：${fib.reason}`);
                }
              } else {
                console.warn(`  ⚠️  下單失敗：${trade.reason || trade.entry?.orders?.map(o => o.step + ':' + o.detail).join('；')}`);
              }
            } catch (e) {
              trade = { ok: false, reason: e.message };
              console.error('  ⚠️  下單例外:', e.message);
            }
          }
          signals.push({ ...result, list, trade });
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

  // 卡關統計：由多到少，看得出該鬆哪一關
  const rejSorted = [...rejections.entries()].sort((a, b) => b[1] - a[1]);
  if (rejSorted.length) {
    console.log(`\n  📊 卡關統計：${rejSorted.map(([k, n]) => `${k} ×${n}`).join('、')}`);
  }

  if (signals.length > 0) {
    for (const s of signals) {
      const lines = [
        `${s.displayName}  @${s.price}`,
        `［策略${s.strategy}］${s.d3Signal} + ${s.d1Signal} + 3H${s.h3Signal} + ${s.h1Signal}`,
        `斐波那契錨點：黑K 高${s.fibBar.high} 低${s.fibBar.low}`,
      ];
      if (s.trade?.ok) {
        const p3 = s.trade.plan;
        lines.push(
          `進場 ${p3.entry}（限價等回踩，${Math.round(ORDER_TTL_MS / 3600000)}h 未成交取消）`,
          `停損 ${p3.stop}　R=${p3.R.toFixed(6)}`,
          `停利 ${p3.targets.map(t => `${t.multiple}R→${t.price}`).join('　')}`,
          `數量 ${p3.qtyEach} × 2 批　風險 ${p3.actualRiskUSD} USD` +
            `（${(p3.riskPct * 100).toFixed(2)}%，權益 ${p3.equity}）`
        );
        if (p3.riskReduced) {
          lines.push(`🛡 回撤 ${(p3.drawdown * 100).toFixed(1)}% 已超過 ${DRAWDOWN_TRIGGER * 100}%，單筆風險降為 ${RISK_PCT_REDUCED * 100}%`);
        }
        if (p3.capped) lines.push('⚠️ 數量受可用保證金上限壓縮');
      } else if (s.trade?.skipped) {
        lines.push(`（未下單：${esc(s.trade.reason)}）`);
      } else if (s.trade) {
        lines.push(`⚠️ 下單失敗：${esc(s.trade.reason || '見 log')}`);
      } else if (!TRADING_ENABLED) {
        lines.push('（自動下單已關閉）');
      }
      await notify(`${s.list}進場信號`, lines.join('\n'));
    }
    console.log(`\n  🔔 通知已發送：${signals.map(s => s.displayName).join(', ')}`);
  } else {
    console.log(`  無進場信號`);
  }

  // 保本階梯：價格到了第 N 個停利點，就把停損往上搬到第 N−1 階
  // （N=1 時搬到成本價）。放在下單之後跑，這輪剛成交的單也會一起檢查。
  let trailNote = null;
  if (TRADING_ENABLED) {
    try {
      const t = await trailStops();
      if (t.moved.length) {
        trailNote = t.moved
          .map(m => `${m.symbol.split(':').pop()} 停損→${m.newStop}（${m.breakeven ? '保本' : '鎖 ' + m.stage}）`)
          .join('\n');
        console.log(`  🛡 移動停損：${trailNote.split('\n').join('、')}`);
      }
      if (t.failed.length) {
        const f = t.failed.map(m => `${m.symbol.split(':').pop()}：${m.detail}`).join('\n');
        trailNote = (trailNote ? trailNote + '\n' : '') + `⚠️ 移動停損失敗：\n${f}`;
        console.warn(`  ⚠️  移動停損失敗：${f.split('\n').join('、')}`);
      }
    } catch (e) {
      trailNote = `移動停損檢查失敗：${e.message}`;
      console.error('  ⚠️ ', trailNote);
    }
  }

  // 掛超過 9 小時（3 根 3H K 棒）還沒成交的限價單要撤掉，
  // 否則信號早就失效了單還掛在那裡等。
  let expiredNote = null;
  if (TRADING_ENABLED) {
    try {
      const exp = await expireStaleOrders();
      if (exp.expired.length) {
        expiredNote = `已撤銷逾期掛單：${exp.expired.map(e => e.symbol.split(':').pop()).join('、')}`;
        console.log(`  ⌛ ${expiredNote}`);
      }
    } catch (e) {
      expiredNote = `逾期掛單檢查失敗：${e.message}`;
      console.error('  ⚠️ ', expiredNote);
    }
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
  if (rejSorted.length) {
    summary.push('卡關：' + esc(rejSorted.slice(0, 5).map(([k, n]) => `${k} ×${n}`).join('\n')));
  }
  if (!REMOVAL_ENABLED) summary.push('（3D 移除檢查暫停中）');
  if (!TRADING_ENABLED) summary.push('（自動下單已關閉）');
  if (trailNote) summary.push(esc(trailNote));
  if (expiredNote) summary.push(esc(expiredNote));
  if (emptyLists.length) summary.push(`⚠️ 讀到 0 個標的的清單：${esc(emptyLists.join('、'))}`);
  if (removalNote) summary.push(esc(removalNote));
  // 過半標的都失敗 → 多半不是個別標的的問題，查一下圖表還在不在
  if (errors.length && errors.length >= Math.max(3, scanned.size / 2)) {
    const h = await chartHealth();
    if (!h.ok) summary.push(`診斷：${esc(diagnose(h))}`);
  }
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
  console.log(`║  移除檢查：${REMOVAL_ENABLED ? '啟用' : '【暫停中】'}                   ║`);
  console.log(`║  自動下單：${TRADING_ENABLED ? '啟用（模擬帳戶）' : '關閉'}            ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('按 Ctrl+C 停止監控\n');

  await connect();
  const health = await chartHealth();
  if (!health.ok) {
    // 啟動就接錯分頁的話，與其跑一輪全錯，不如重連一次再不行就大聲停掉
    console.warn('⚠️  連到的分頁沒有圖表 API，嘗試重新連線...');
    const recovery = await tryReconnect();
    if (!recovery.ok) throw new Error(`無法連上 TradingView 圖表 — ${recovery.note}`);
    console.log(`🔄 ${recovery.note}`);
  }
  console.log('✅ 已連接 TradingView CDP（圖表 API 正常）\n');

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
