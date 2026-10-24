#!/usr/bin/env node
/**
 * 單一標的的進場條件診斷
 *
 * 監控器只會回報「卡在第幾關」就停下，這支則把四關全部跑完並附上實際數字，
 * 用來回答「這個標的到底差在哪、差多少」。判定邏輯與監控器同源：吞噬函式
 * 直接從 monitor-jskuang.js 的原始碼取出來，避免兩邊各寫一份而悄悄分岔。
 *
 * 用法：node scripts/diagnose-jskuang.js BINGX:DOSUSDT.P
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, disconnect, evaluate, evaluateAsync } from '../src/connection.js';
import { getOhlcv, getStudyValues } from '../src/core/data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const MAIN_SERIES = `${CHART_API}._chartWidget.model().mainSeries()`;
const TF_SECONDS = { '60': 3600, '180': 10800, 'D': 86400, '3D': 259200 };
const MIN_RUN = 2;
const MA_STUDY_NAME = '7EMA_5MA';
const MA_VALUE_KEY = 'MA 1';

// 吞噬判斷直接取自監控器原始碼，確保與線上邏輯一致
const src = fs.readFileSync(path.join(ROOT, 'scripts/monitor-jskuang.js'), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`取不到 ${name}`);
  return src.slice(i, src.indexOf('\n}', i) + 2);
};
const { isBullEngulf } = new Function(`${grab('isBullEngulf')}\n${grab('isBearEngulf')}\nreturn { isBullEngulf, isBearEngulf };`)();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadBars(symbol, tf, count) {
  await evaluateAsync(`new Promise(function(r){
    ${CHART_API}.setSymbol(${JSON.stringify(symbol)}, {});
    setTimeout(function(){ ${CHART_API}.setResolution(${JSON.stringify(tf)}, {}); setTimeout(r, 300); }, 400);
  })`);
  const want = tf === 'D' ? '1D' : tf;
  for (let i = 0; i < 50; i++) {
    const st = await evaluate(`(function(){ try {
      var ms = ${MAIN_SERIES}; var si = ms.symbolInfo();
      return { symbol: si && si.full_name, interval: ms.interval() };
    } catch(e) { return null; } })()`);
    if (st && st.symbol === symbol && st.interval === want) {
      const r = await getOhlcv({ count });
      const bars = r?.bars || [];
      const ok = bars.length >= 2 && (!TF_SECONDS[tf] || bars[1].time - bars[0].time === TF_SECONDS[tf]);
      if (ok) return bars;
    }
    await sleep(200);
  }
  throw new Error(`${tf} 載入逾時`);
}

async function readMa() {
  for (let i = 0; i < 25; i++) {
    const sv = await getStudyValues();
    const st = sv?.studies?.find(x => x.name && x.name.includes(MA_STUDY_NAME));
    const raw = st?.values?.[MA_VALUE_KEY];
    const v = raw == null ? NaN : parseFloat(String(raw).replace(/,/g, ''));
    if (Number.isFinite(v)) return v;
    await sleep(200);
  }
  return NaN;
}

const mark = (ok) => ok ? '✅' : '❌';
const color = (b) => b.close > b.open ? '紅' : b.close < b.open ? '黑' : '平';

async function main() {
  const symbol = process.argv[2] || 'BINGX:DOSUSDT.P';
  await connect();
  console.log(`\n═══ ${symbol} 進場條件診斷 ═══\n`);
  let passed = 0;

  // ── 條件1：3D 連續黑K 後出一根紅K ──
  const bars3d = await loadBars(symbol, '3D', 8);
  const curr3d = bars3d[bars3d.length - 1];
  let blackRun = 0;
  for (let i = bars3d.length - 2; i >= 0; i--) {
    if (bars3d[i].close < bars3d[i].open) blackRun++; else break;
  }
  const c1 = curr3d.close > curr3d.open && blackRun >= MIN_RUN;
  if (c1) passed++;
  console.log(`${mark(c1)} 條件1  3D 連續黑K ≥${MIN_RUN} 根後出紅K`);
  console.log(`         最近 ${bars3d.length} 根 3D：${bars3d.slice(-6).map(color).join(' ')}`);
  console.log(`         當前 開${curr3d.open} 收${curr3d.close}（${color(curr3d)}K）　之前連續黑K ${blackRun} 根`);
  if (!c1) {
    console.log(`         缺：${curr3d.close > curr3d.open ? `連續黑K 不足（要 ${MIN_RUN} 根，只有 ${blackRun}）` : '當前不是紅K'}`);
  }

  // ── 條件2：1D 連續紅K 遞增、某根過 MA，然後出黑K ──
  const barsD = await loadBars(symbol, 'D', 12);
  const ma = await readMa();
  const currD = barsD[barsD.length - 1];
  const redRun = [];
  for (let i = barsD.length - 2; i >= 0; i--) {
    const b = barsD[i];
    if (b.close > b.open) redRun.unshift(b); else break;
  }
  const ascending = redRun.every((b, i) => i === 0 || b.close > redRun[i - 1].close);
  const overMa = Number.isFinite(ma) && redRun.some(b => b.high > ma);
  const c2 = currD.close < currD.open && redRun.length >= MIN_RUN && ascending && overMa;
  if (c2) passed++;
  console.log(`\n${mark(c2)} 條件2  1D 連續紅K 遞增且某根高點過 MA 後出黑K`);
  console.log(`         最近 ${barsD.length} 根 1D：${barsD.slice(-8).map(color).join(' ')}`);
  console.log(`         當前 開${currD.open} 收${currD.close}（${color(currD)}K）　MA 1 = ${Number.isFinite(ma) ? ma : '讀不到'}`);
  console.log(`         連續紅K ${redRun.length} 根${redRun.length ? `：收盤 ${redRun.map(b => b.close).join(' → ')}` : ''}`);
  if (redRun.length) {
    console.log(`         收盤遞增 ${mark(ascending)}　有紅K 高點過 MA ${mark(overMa)}（最高 ${Math.max(...redRun.map(b => b.high))}）`);
  }

  // ── 條件3：3H 當前紅吞 ──
  const bars3h = await loadBars(symbol, '180', 6);
  const curr3h = bars3h[bars3h.length - 1];
  const prev3h = bars3h[bars3h.length - 2];
  const c3 = isBullEngulf(curr3h, prev3h);
  if (c3) passed++;
  console.log(`\n${mark(c3)} 條件3  3H 當前紅吞（前一根要是黑K、當前高點要過它、自身收紅）`);
  console.log(`         前一根 開${prev3h.open} 高${prev3h.high} 低${prev3h.low} 收${prev3h.close}（${color(prev3h)}K）`);
  console.log(`         當前   開${curr3h.open} 高${curr3h.high} 低${curr3h.low} 收${curr3h.close}（${color(curr3h)}K）`);
  console.log(`         前根是黑K ${mark(prev3h.close < prev3h.open)}　高點過前根 ${mark(curr3h.high > prev3h.high)}　自身收紅 ${mark(curr3h.close > curr3h.open)}`);
  if (c3) {
    console.log(`         → 進場 ${prev3h.open}（前根開盤）　停損 ${curr3h.low}（當前低點）`);
  }

  // ── 條件4：1H 收盤過前根實體上緣 ──
  const bars1h = await loadBars(symbol, '60', 4);
  const curr1h = bars1h[bars1h.length - 1];
  const prev1h = bars1h[bars1h.length - 2];
  const bodyTop = Math.max(prev1h.open, prev1h.close);
  const c4 = curr1h.close > bodyTop;
  if (c4) passed++;
  console.log(`\n${mark(c4)} 條件4  1H 收盤高於前一根實體上緣`);
  console.log(`         前一根實體上緣 ${bodyTop}　當前收盤 ${curr1h.close}　差 ${(curr1h.close - bodyTop).toFixed(8)}`);

  console.log(`\n═══ 結果：符合 ${passed} / 4 項 ═══`);
  if (passed < 4) {
    const miss = [!c1 && '1', !c2 && '2', !c3 && '3', !c4 && '4'].filter(Boolean);
    console.log(`差在條件 ${miss.join('、')}\n`);
  } else {
    console.log('四關全過 —— 監控器下一輪就會下單\n');
  }
  await disconnect();
}

main().catch(async (e) => {
  console.error('❌ 診斷失敗：', e.message);
  try { await disconnect(); } catch {}
  process.exit(1);
});
