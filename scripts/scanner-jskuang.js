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
 * 只收 BINGX 永續合約：加入清單時帶完整代號，避免 TradingView 搜尋
 * 自行挑成別家交易所。清單中已有同名幣對（不分交易所）則略過。
 * 確定加入的標的會發 Telegram 通知。
 *
 * 用法：node --env-file=.env scripts/scanner-jskuang.js
 */

import { connect, disconnect, evaluate, evaluateAsync, getClient } from '../src/connection.js';
import { getOhlcv } from '../src/core/data.js';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TG_TOKEN || !TG_CHAT_ID) {
  console.error('請設定環境變數 TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID');
  process.exit(1);
}

// 掃描結果要寫入的清單
const LIST_NAME = '極速匡';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// Desktop 版 watchlist 面板按鈕（中文 aria-label）
const WL_BTN = '[data-name="watchlists-button"]';
const ADD_BTN = '[data-name="add-symbol-button"]';
// 切換後等待資料載入的固定時間（ms）
const SYMBOL_WAIT = 700;
const TF_WAIT = 450;

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function ensureWatchlistOpen() {
  const opened = await evaluate(`(function() {
    var btn = document.querySelector('${WL_BTN}');
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
    return true;
  })()`);
  if (!opened) throw new Error('找不到 Watchlist 按鈕（請確認右側面板已啟用）');
  // 等待 add-symbol-button 出現
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ready = await evaluate(`!!document.querySelector('${ADD_BTN}')`);
    if (ready) return;
    await sleep(250);
  }
  throw new Error('Watchlist 面板未就緒');
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

// ─── 讀取清單現有幣對 ─────────────────────────────
// 以 REST 為準：桌面版 widget 不會同步 API 的異動，畫面上的 row 可能過期。
async function fetchListSymbols(listName) {
  return evaluateAsync(`
    fetch(location.origin + '/api/v1/symbols_list/custom/', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (!Array.isArray(j)) return null;
        for (var i = 0; i < j.length; i++) {
          if (j[i].name === ${JSON.stringify(listName)}) {
            return { id: j[i].id, symbols: j[i].symbols || [] };
          }
        }
        return null;
      })
      .catch(function() { return null; })
  `);
}

// 不分交易所比對：OKX:JUPUSDT.P 與 BINGX:JUPUSDT.P 視為同一個幣對
function bareTicker(symbol) {
  return symbol.split(':').pop().replace('.P', '').toUpperCase();
}

async function addSymbolToWatchlist(symbol) {
  const c = await getClient();
  await ensureWatchlistOpen();

  // 點擊 add-symbol-button
  const clicked = await evaluate(`(function() {
    var btn = document.querySelector('${ADD_BTN}');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (!clicked) throw new Error('無法點擊新增按鈕');
  await sleep(400);

  // 輸入完整代號（含 exchange 前綴）。只給裸 ticker 的話搜尋會自行挑
  // 交易所，同一個幣可能被加成 OKX / BINANCE 版本而非 BINGX。
  await c.Input.insertText({ text: symbol });   // BINGX:BTCUSDT.P
  await sleep(700);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await sleep(300);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(300);
}

async function addBulkToWatchlist(symbols) {
  let added = 0, failed = 0;
  for (const sym of symbols) {
    try {
      await addSymbolToWatchlist(sym);
      added++;
    } catch (err) {
      console.log(`   ⚠️  ${sym}: ${err.message}`);
      failed++;
    }
  }
  return { added, failed };
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

async function scanSymbol(tvSymbol) {
  try {
    await chartSetSymbol(tvSymbol);

    for (const { tf, label, signal } of TIMEFRAMES) {
      await chartSetTimeframe(tf);

      let bars;
      try {
        const result = await getOhlcv({ count: 3 });
        bars = result.bars;
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

  console.log('📋 取得 BingX USDT 永續合約清單...');
  const rawSymbols = await fetchBingxSymbols();
  const total = rawSymbols.length;
  console.log(`✅ 共 ${total} 個幣對（24h 漲幅前 20 名）\n`);
  console.log('💡 提示：請先在 TradingView 建立並切換至「極速匡」清單，符合幣對將加入該清單\n');
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

    const list = await fetchListSymbols(LIST_NAME);
    if (!list) {
      console.log(`\n⚠️  讀不到「${LIST_NAME}」清單，略過加入步驟`);
    } else {
      const existing = new Set(list.symbols.map(bareTicker));
      const toAdd = matched.filter(s => !existing.has(bareTicker(s)));
      const dup = matched.filter(s => existing.has(bareTicker(s)));

      if (dup.length) {
        console.log(`\n⏭  清單已有，略過 ${dup.length} 個：${dup.map(bareTicker).join(', ')}`);
      }

      if (!toAdd.length) {
        console.log(`\n   （符合的幣對清單中都已存在，無新增）`);
      } else {
        console.log(`\n📥 正在加入「${LIST_NAME}」...`);
        const wlResult = await addBulkToWatchlist(toAdd);
        console.log(`✅ 送出 ${wlResult.added} 個，失敗 ${wlResult.failed} 個`);

        // 以 REST 回讀確認：widget 的畫面不足以判斷是否真的寫進清單，
        // 只有確定加入的才通知，避免發出不存在的標的。
        const after = await fetchListSymbols(LIST_NAME);
        const confirmed = after ? toAdd.filter(s => after.symbols.includes(s)) : [];
        const unconfirmed = toAdd.filter(s => !confirmed.includes(s));

        if (confirmed.length) {
          await notify(
            `${LIST_NAME}新增標的`,
            confirmed.map(s => `${bareTicker(s)}（18D+3D+1D 紅吞 + 3H 吞噬）`).join('\n')
          );
          console.log(`🔔 已通知 TG：${confirmed.map(bareTicker).join(', ')}`);
        }
        if (unconfirmed.length) {
          console.log(`⚠️  未確認加入，不發通知：${unconfirmed.map(bareTicker).join(', ')}`);
        }
      }
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
