#!/usr/bin/env node
/**
 * 極速匡策略掃描器
 *
 * 策略條件（全部需同時成立）：
 *   18D 紅吞 + 3D 紅吞 + 1D 紅吞 + 3H (紅吞 or 黑吞)
 *
 * 紅吞：當前紅K實體棒最高點(close) > 前一根K棒實體棒最高點(max(o,c))
 * 黑吞：當前黑K實體棒最低點(close) < 前一根K棒實體棒最低點(min(o,c))
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

// 符合幣對要加入的雲端清單名稱（透過 REST 指名加入，與目前開啟的頁籤無關）
const TARGET_LIST = '極速匡';
// 切換後的沉澱時間（ms）。資料是否就緒改由 waitForChart 輪詢判定，
// 這裡只要讓 setSymbol/setResolution 有機會生效即可。
const SYMBOL_WAIT = 150;
const TF_WAIT = 100;
// 等待圖表載入資料的輪詢間隔與逾時（ms）
const POLL_INTERVAL = 200;
const LOAD_TIMEOUT = 8000;

const TIMEFRAMES = [
  { tf: '18D', label: '18D', signal: 'bull' },
  { tf: '3D',  label: '3D',  signal: 'bull' },
  { tf: 'D',   label: '1D',  signal: 'bull' },
  { tf: '180', label: '3H',  signal: 'both' },
];

// 紅吞：紅K且收盤突破前棒實體最高點
function isBullEngulf(curr, prev) {
  return curr.close > curr.open
    && curr.close > Math.max(prev.open, prev.close);
}

// 黑吞：黑K且收盤跌破前棒實體最低點
function isBearEngulf(curr, prev) {
  return curr.close < curr.open
    && curr.close < Math.min(prev.open, prev.close);
}

function checkSignal(bars, signal) {
  if (bars.length < 2) return false;
  const curr = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (signal === 'bull') return isBullEngulf(curr, prev);
  if (signal === 'both') return isBullEngulf(curr, prev) || isBearEngulf(curr, prev);
  return false;
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
    .slice(0, 20);

  console.log('📈 前 20 名漲幅排行：');
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
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const state = await evaluate(`(function() {
      var c = ${CHART_API};
      return { symbol: c.symbol(), resolution: c.resolution() };
    })()`);
    if (state && state.symbol === symbol && state.resolution === wantTf) {
      try {
        const result = await getOhlcv({ count: 3 });
        seen = result?.bars?.length || 0;
        if (seen >= minBars) return result.bars;
      } catch {
        // 資料尚未就緒，繼續等
      }
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`載入逾時（只拿到 ${seen} 根 K 棒）`);
}

async function scanSymbol(tvSymbol) {
  try {
    await chartSetSymbol(tvSymbol);

    for (const { tf, label, signal } of TIMEFRAMES) {
      await chartSetTimeframe(tf);

      let bars;
      try {
        bars = await waitForChart(tvSymbol, tf);
      } catch {
        return { pass: false, failedAt: label, reason: 'no_data' };
      }

      if (!checkSignal(bars, signal)) {
        return { pass: false, failedAt: label };
      }
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, failedAt: 'load', reason: err.message.slice(0, 60) };
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        極速匡策略掃描器  v1.0            ║');
  console.log('║  18D紅吞 + 3D紅吞 + 1D紅吞 + 3H紅/黑吞 ║');
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
  console.log(`✅ 共 ${total} 個幣對（24h 漲幅前 20 名）\n`);
  console.log('─'.repeat(58));

  const matched = [];
  const failed = [];
  const startTime = Date.now();

  for (let i = 0; i < rawSymbols.length; i++) {
    const raw = rawSymbols[i];
    const tvSymbol = `BINGX:${raw}.P`;
    const idx = `[${String(i + 1).padStart(4)}/${total}]`;

    process.stdout.write(`${idx} ${raw.padEnd(14)} `);

    const result = await scanSymbol(tvSymbol);

    if (result.pass) {
      console.log('✅ 符合');
      matched.push(tvSymbol);
    } else if (result.reason === 'no_data') {
      console.log(`⚠️  無資料(${result.failedAt})`);
    } else if (result.reason) {
      console.log(`⚠️  ${result.reason}`);
      failed.push(raw);
    } else {
      console.log(`❌ ${result.failedAt}`);
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
          confirmed.map(s => `${bareTicker(s)}（18D+3D+1D 紅吞 + 3H 吞噬）`).join('\n')
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

main().catch(err => {
  console.error('\n❌ 掃描器錯誤:', err.message);
  process.exit(1);
});
