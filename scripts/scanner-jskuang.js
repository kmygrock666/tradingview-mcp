#!/usr/bin/env node
/**
 * 極速匡策略掃描器
 *
 * 策略條件（2026-10-26 改版，兩條擇一）：
 *   一、當前 18D 為「紅吞」（高點過前一根且自身收紅）
 *   二、前一根收黑，但收盤沒有跌破「它前面最近那根紅吞」的實體低點
 *
 * 分支二看的是「收破」不是「觸及」，所以用收盤價比而不是最低點；紅吞自身收紅，
 * 實體低點就是它的開盤價。意思是回檔那根黑K 還守在前一波紅吞的實體之內，
 * 結構沒有被破壞 —— 跟分支一的「正在突破」互補，一個抓發動、一個抓守住。
 *
 * 這組與監控器的移除條件（18D 黑吞出清）成對：跌破出清、重新站穩再找回來。
 * （2026-10-25 的舊條件是「現價收復上一根 18D 黑K 的實體」，已汰換。）
 *
 * 只收 BINGX 永續合約，符合的幣對透過 REST 指名加入「極速匡」清單
 * （與目前開啟的頁籤無關，清單中已有的會被略過）。
 * 確定加入且通過驗證的標的會發 Telegram 通知。
 *
 * 用法：node --env-file=.env scripts/scanner-jskuang.js
 */

import { connect, disconnect, evaluate, evaluateAsync } from '../src/connection.js';
import { getOhlcv } from '../src/core/data.js';
import { addToList, findList } from '../src/core/watchlist.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TG_TOKEN || !TG_CHAT_ID) {
  console.error('請設定環境變數 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID');
  process.exit(1);
}

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
// 主序列本身（K 棒的真正來源）。widget 的 symbol()/resolution() 會在資料
// 換好之前就先更新，只能拿它當「已下指令」看，不能當「資料已就緒」用。
const MAIN_SERIES = `${CHART_API}._chartWidget.model().mainSeries()`;
// 各週期的 K 棒間距（秒），用來確認讀到的序列真的是這個週期
const TF_SECONDS = { '180': 10800, 'D': 86400, '3D': 259200, '18D': 1555200 };

// 符合幣對要加入的雲端清單名稱（透過 REST 指名加入，與目前開啟的頁籤無關）
const TARGET_LIST = '極速匡';
// 候選池：BingX USDT 永續「24 小時漲幅」排行取前幾名。
//
// 這道篩子跟判定條件（收復 18D 黑K 實體）其實沒有必然關係 —— 後者是中長期的
// 結構訊號，今天漲多少並不決定它成不成立。REZUSDT 2026-10-26 就是這樣漏掉的：
// 條件完全符合，但 24h 只漲 10.21%、在 665 個上漲合約裡排第 26，擠不進前 20。
// 2026-10-26 由 20 放寬到 35。每多一名大約多 1 秒掃描時間。
const TOP_N = 35;
// 每個標的要抓的 18D K 棒數。分支二要往回找錨點紅吞，不能只抓最近幾根。
const BARS_18D = 12;
// 切換後的沉澱時間（ms）。資料是否就緒改由 waitForChart 輪詢判定，
// 這裡只要讓 setSymbol/setResolution 有機會生效即可。
// 連續這麼多個標的讀不到資料就中止：CDP 卡住時每個標的都會「無資料」，
// 跑完整輪會印出「掃描完成、無符合幣對」，跟真的沒符合完全同形。
const MAX_CONSECUTIVE_FAILS = 5;
// Telegram 發送逾時（ms）。Node fetch 預設不逾時。
const TG_TIMEOUT_MS = 10000;
const SYMBOL_WAIT = 150;
const TF_WAIT = 100;
// 等待圖表載入資料的輪詢間隔與逾時（ms）
const POLL_INTERVAL = 200;
const LOAD_TIMEOUT = 8000;

// 只剩 18D 一個週期要檢查（原本是 18D/3D/1D/3H 四關）
const SCAN_TF = '18D';

/**
 * 上一根 18D 是黑K，且現價過了它的實體上緣（開盤價）。
 * 回傳 { pass, failedAt?, detail? }，detail 讓通知可以直接被覆核。
 */
// 紅吞：當前漲過前一根的高點且自身收紅（與監控器同一套定義，不限前一根顏色）
function isBullEngulf(c, p) {
  return c.high > p.high && c.close > c.open;
}
// 往回找最近一根紅吞的索引（從 fromIdx 起往前，找不到回 -1）
function findLastBullEngulfIdx(bars, fromIdx) {
  for (let i = Math.min(fromIdx, bars.length - 1); i >= 1; i--) {
    if (isBullEngulf(bars[i], bars[i - 1])) return i;
  }
  return -1;
}

/**
 * 掃描條件（2026-10-26 改版，兩條擇一）：
 *   一、當前 18D 為「紅吞」
 *   二、前一根收黑，但收盤沒有跌破「它前面最近那根紅吞」的實體低點
 *
 * 分支二看的是「收破」不是「觸及」，所以用收盤價比，不用最低點；紅吞自身收紅，
 * 實體低點就是它的開盤價。意思是回檔那根黑K 還守在前一波紅吞的實體之內，
 * 結構沒有被破壞。
 */
function checkReclaim(bars) {
  if (bars.length < 3) return { pass: false, failedAt: '資料不足' };
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // 分支一：當前紅吞
  if (isBullEngulf(curr, prev)) {
    return { pass: true, detail: `18D紅吞（高 ${curr.high} > 前根 ${prev.high}，收紅 ${curr.close}）` };
  }

  // 分支二：前一根收黑，且收盤守住前面那根紅吞的實體低點
  if (!(prev.close < prev.open)) {
    return { pass: false, failedAt: '非紅吞且前一根不是黑K' };
  }
  const ei = findLastBullEngulfIdx(bars, bars.length - 3);
  if (ei < 0) {
    return { pass: false, failedAt: '找不到錨點紅吞',
             detail: `前 ${bars.length - 2} 根內沒有紅吞` };
  }
  const anchor = bars[ei];
  const bodyLow = Math.min(anchor.open, anchor.close);   // 紅吞收紅，實體低點＝開盤
  if (!(prev.close >= bodyLow)) {
    return { pass: false, failedAt: '收破紅吞實體低點',
             detail: `前一根收 ${prev.close} < 紅吞實體低 ${bodyLow}` };
  }
  return { pass: true,
           detail: `前一根黑K 收 ${prev.close} 守住 ${bars.length - 1 - ei} 根前紅吞的實體低 ${bodyLow}` };
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// BINGX:JUPUSDT.P → JUPUSDT
function bareTicker(symbol) {
  return symbol.replace('BINGX:', '').replace('.P', '');
}

// ─── Telegram 通知 ────────────────────────────────
async function notify(title, message, emoji = '🆕') {
  try {
    const text = `${emoji} <b>${title}</b>\n${message}`;
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const json = await res.json();
    if (!json.ok) console.error('TG 發送失敗:', json.description);
  } catch (e) {
    console.error('TG 通知錯誤:', e.message);
  }
}

async function fetchBingxSymbols() {
  const res = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/ticker');
  if (!res.ok) throw new Error(`BingX API 回應失敗: HTTP ${res.status}`);
  const json = await res.json();
  const sorted = json.data
    .filter(c => c.symbol.endsWith('-USDT') && parseFloat(c.priceChangePercent) > 0)
    .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
    .slice(0, TOP_N);

  console.log(`📈 前 ${TOP_N} 名漲幅排行：`);
  sorted.forEach((c, i) => {
    const pct = parseFloat(c.priceChangePercent).toFixed(2);
    console.log(`   ${String(i+1).padStart(2)}. ${c.symbol.padEnd(16)} +${pct}%`);
  });
  console.log();

  return sorted.map(c => c.symbol.replace('-', ''));  // BTC-USDT → BTCUSDT
}

async function chartSetSymbol(symbol) {
  await evaluateAsync(`
    new Promise(function(resolve) {
      ${CHART_API}.setSymbol(${JSON.stringify(symbol)}, {});
      setTimeout(resolve, ${SYMBOL_WAIT});
    })
  `);
}

async function chartSetTimeframe(tf) {
  await evaluateAsync(`
    new Promise(function(resolve) {
      ${CHART_API}.setResolution(${JSON.stringify(tf)}, {});
      setTimeout(resolve, ${TF_WAIT});
    })
  `);
}

// 輪詢等待圖表確實切到目標 symbol/TF 且拿得到 K 棒，取代固定 sleep
async function waitForChart(symbol, tf, minBars = 2, timeoutMs = LOAD_TIMEOUT) {
  const wantTf = tf === 'D' ? '1D' : tf;   // setResolution('D') 回報為 '1D'
  const wantSec = TF_SECONDS[tf];
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  let last = null;
  while (Date.now() < deadline) {
    // 以主序列自己回報的 symbol/interval 為準，並核對 K 棒間距：widget 的
    // symbol()/resolution() 會在資料換好前就更新，照它判斷會拿到上一個
    // 標的或上一個週期的 K 棒，卻誤以為是新的。
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
        // 12 根：分支二要往回找「前一根黑K 之前最近的那根紅吞」當錨點，
        // 窗口太短會把「找不到錨點」誤報成條件不符
        const result = await getOhlcv({ count: BARS_18D });
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
    `載入逾時（拿到 ${seen} 根；序列為 ${last?.symbol ?? '?'} ${last?.interval ?? '?'}）`
  );
}

async function scanSymbol(tvSymbol) {
  try {
    await chartSetSymbol(tvSymbol);
    await chartSetTimeframe(SCAN_TF);

    let bars;
    try {
      // 至少 3 根：判定要用到當前、前一根，分支二還要再往前找錨點
      bars = await waitForChart(tvSymbol, SCAN_TF, 3);
    } catch {
      // 新上市幣對常常沒有足夠的 18D 歷史，這是資料問題不是條件不符
      return { pass: false, failedAt: SCAN_TF, reason: 'no_data' };
    }

    const r = checkReclaim(bars);
    if (!r.pass) return { pass: false, failedAt: r.failedAt, detail: r.detail };
    return { pass: true, detail: r.detail };
  } catch (err) {
    return { pass: false, failedAt: 'load', reason: err.message.slice(0, 60) };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        極速匡策略掃描器  v2.0            ║');
  console.log('║   現價突破上一根 18D 黑K 的實體上緣      ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('📡 連接 TradingView CDP...');
  await connect();
  console.log('✅ 已連接\n');

  // 先確認目標清單存在，避免掃完才發現無處可加
  if (!await findList({ name: TARGET_LIST })) {
    console.error(`❌ 找不到「${TARGET_LIST}」清單，請先在 TradingView 建立後再執行`);
    await disconnect();
    process.exit(1);
  }
  console.log(`✅ 已找到「${TARGET_LIST}」清單，符合幣對將自動加入（無需手動切換頁籤）\n`);

  console.log('📋 取得 BingX USDT 永續合約清單...');
  const rawSymbols = await fetchBingxSymbols();
  const total = rawSymbols.length;
  console.log(`✅ 共 ${total} 個幣對（24h 漲幅前 ${TOP_N} 名）\n`);
  console.log('─'.repeat(58));

  const matched = [];
  const failed = [];
  let consecutiveFails = 0;   // 連續讀不到資料的次數，用來中止整輪
  const startTime = Date.now();

  for (let i = 0; i < rawSymbols.length; i++) {
    const raw = rawSymbols[i];
    const tvSymbol = `BINGX:${raw}.P`;
    const idx = `[${String(i + 1).padStart(4)}/${total}]`;

    process.stdout.write(`${idx} ${raw.padEnd(14)} `);

    const result = await scanSymbol(tvSymbol);

    if (result.pass) {
      console.log('✅ 符合' + (result.detail ? '　' + result.detail : ''));
      matched.push(tvSymbol);
      consecutiveFails = 0;
    } else if (result.reason === 'no_data') {
      console.log(`⚠️  無資料(${result.failedAt})`);
      consecutiveFails++;
    } else if (result.reason) {
      console.log(`⚠️  ${result.reason}`);
      failed.push(raw);
      consecutiveFails++;
    } else {
      console.log(`❌ ${result.failedAt}`);
      consecutiveFails = 0;   // 條件不成立代表資料讀得到，管道是通的
    }

    // 熔斷：資料管道壞掉時要大聲失敗，不要跑完整輪假裝「無符合幣對」
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      throw new Error(
        `連續 ${consecutiveFails} 個標的讀不到資料，判定圖表／CDP 異常，已中止本輪掃描`
      );
    }

    // 每 20 個顯示進度與 ETA
    if ((i + 1) % 20 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed / (i + 1);
      const eta = formatTime(rate * (total - i - 1));
      console.log(`${'─'.repeat(58)}`);
      console.log(`     ⏱  已掃描 ${i + 1}/${total}，符合 ${matched.length} 個，預計剩餘 ${eta}`);
      console.log(`${'─'.repeat(58)}`);
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log('─'.repeat(58));
  console.log(`\n✅ 掃描完成！耗時 ${formatTime(elapsed)}`);
  console.log(`\n📌 符合幣對（${matched.length}/${total}）：`);

  if (matched.length > 0) {
    matched.forEach(s => console.log(`   • ${bareTicker(s)}`));

    console.log(`\n📥 正在加入「${TARGET_LIST}」清單...`);
    try {
      const r = await addToList({ list: TARGET_LIST, symbols: matched });
      const skippedNote = r.skipped.length ? `（另有 ${r.skipped.length} 個已在清單中）` : '';
      if (!r.added.length) {
        console.log(`✅ 全部 ${matched.length} 個已在清單中，無需加入`);
      } else if (r.verified) {
        console.log(`✅ 成功加入 ${r.added.length} 個${skippedNote}`);
      } else {
        console.log(`⚠️  已送出 ${r.added.length} 個，但驗證未確認：${r.missing.join(', ')}${skippedNote}`);
      }

      // 只通知確定寫進清單的標的，避免發出實際沒加成功的新增訊息
      const missing = new Set(r.missing || []);
      const confirmed = (r.added || []).filter(s => !missing.has(s));
      if (confirmed.length) {
        await notify(
          `${TARGET_LIST}新增標的`,
          confirmed.map(s => `${bareTicker(s)}（現價已收復 18D 黑K 實體）`).join('\n')
        );
        console.log(`🔔 已通知 TG：${confirmed.map(bareTicker).join(', ')}`);
      }
    } catch (err) {
      console.log(`❌ 加入清單失敗: ${err.message}`);
    }
  } else {
    console.log('   （目前無符合幣對）');
  }

  if (failed.length > 0) {
    console.log(`\n⚠️  載入失敗（${failed.length} 個，可能不在 BingX TradingView）：`);
    failed.slice(0, 10).forEach(s => console.log(`   • ${s}`));
    if (failed.length > 10) console.log(`   ... 及其他 ${failed.length - 10} 個`);
  }

  await disconnect();
  console.log('\n👋 掃描器結束');
}

main().catch(async err => {
  console.error('\n❌ 掃描器錯誤:', err.message);
  // 掃描器成功時會發 TG，失敗時沉默的話就無從分辨「沒符合」與「掛了」
  await notify('極速匡掃描器錯誤', `掃描中止：${err.message}`, '❌');
  process.exit(1);
});
