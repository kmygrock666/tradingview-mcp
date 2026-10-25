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
const LOOKBACK_3D = 5;
const LOOKBACK_1D = 10;
const MA_STUDY_NAME = '7EMA_5MA';
const MA_VALUE_KEY = 'MA 1';

// 吞噬判斷直接取自監控器原始碼，確保與線上邏輯一致
const src = fs.readFileSync(path.join(ROOT, 'scripts/monitor-jskuang.js'), 'utf8').replace(/\r\n/g, '\n');
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`取不到 ${name}`);
  return src.slice(i, src.indexOf('\n}', i) + 2);
};
// findBlackToRed 用到 MIN_RUN，當參數餵進沙箱，不要在這裡另寫一份判定
const { isBullEngulf, findBlackToRed, findRedRunThenHold, findLastBullEngulfIdx } = new Function('MIN_RUN', `
${grab('isBullEngulf')}
${grab('isBearEngulf')}
${grab('findBlackToRed')}
${grab('findRedRunThenHold')}
${grab('findLastBullEngulfIdx')}
return { isBullEngulf, isBearEngulf, findBlackToRed, findRedRunThenHold, findLastBullEngulfIdx };`)(MIN_RUN);

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
  console.log(`\n═══ ${symbol} 策略A（破底後由黑轉紅）═══\n`);
  let passed = 0;

  // ── 條件1：最近 5 根 3D 內曾「連續黑K 後出一根紅K」──
  const bars3d = await loadBars(symbol, '3D', 12);
  const curr3d = bars3d[bars3d.length - 1];
  const btr = findBlackToRed(bars3d, LOOKBACK_3D);
  const c1 = !!btr;
  if (c1) passed++;
  console.log(`${mark(c1)} 條件1  最近 ${LOOKBACK_3D} 根 3D 內曾連續黑K ≥${MIN_RUN} 根後出一根紅K`);
  console.log(`         最近 ${bars3d.length} 根 3D：${bars3d.slice(-8).map(color).join(' ')}`);
  console.log(`         當前 開${curr3d.open} 收${curr3d.close}（${color(curr3d)}K）`);
  if (c1) {
    const red = bars3d[btr.redIdx];
    console.log(`         轉紅那根在 ${btr.agoBars} 根前（開${red.open} 收${red.close}），之前連續黑K ${btr.blackRun} 根`);
  } else {
    console.log(`         缺：視窗內每一根紅K 前面的連續黑K 都不足 ${MIN_RUN} 根，或視窗內根本沒有紅K`);
  }

  // ── 條件2：1D 連續紅K 遞增、某根過 MA，出黑K，後續未曾跌破那根黑K 低點 ──
  const barsD = await loadBars(symbol, 'D', 20);
  const ma = await readMa();
  const currD = barsD[barsD.length - 1];
  const d1 = findRedRunThenHold(barsD, ma, LOOKBACK_1D);
  const c2 = d1.ok;
  if (c2) passed++;
  console.log(`\n${mark(c2)} 條件2  最近 ${LOOKBACK_1D} 根 1D 內曾連續紅K 遞增且某根高點過 MA 後出黑K，且後續未跌破它的低點、曾漲過它的高點`);
  console.log(`         最近 ${barsD.length} 根 1D：${barsD.slice(-10).map(color).join(' ')}`);
  console.log(`         當前 開${currD.open} 收${currD.close}（${color(currD)}K）　MA 1 = ${Number.isFinite(ma) ? ma : '讀不到'}`);
  if (c2) {
    console.log(`         連續紅K ${d1.redRun.length} 根：收盤 ${d1.redRun.map(b => b.close).join(' → ')}（最高 ${Math.max(...d1.redRun.map(b => b.high))} > MA）`);
    console.log(`         黑K 在 ${d1.agoBars} 根前（開${d1.black.open} 收${d1.black.close} 高${d1.black.high} 低${d1.black.low}）`);
    console.log(`         之後都沒跌破低點 ${d1.black.low}，並在 ${d1.overAgo} 根前漲過高點 ${d1.black.high}`);
  } else {
    console.log(`         缺：${d1.why}（回報的是視窗內最近一根黑K 候選卡在哪）`);
  }

  // ── 條件3：3H 當前紅吞 或 前一根收黑K ──
  // 12 根：策略B 條件3 要往回找「前面最近一根紅吞」，窗口太短會誤判成沒有
  const bars3h = await loadBars(symbol, '180', 12);
  const curr3h = bars3h[bars3h.length - 1];
  const prev3h = bars3h[bars3h.length - 2];
  const engulf3h = isBullEngulf(curr3h, prev3h);
  const prevBlack3h = prev3h.close < prev3h.open;
  const c3 = engulf3h || prevBlack3h;
  if (c3) passed++;
  console.log(`\n${mark(c3)} 條件3  3H 當前紅吞 或 前一根收黑K（擇一即可）`);
  console.log(`         前一根 開${prev3h.open} 高${prev3h.high} 低${prev3h.low} 收${prev3h.close}（${color(prev3h)}K）`);
  console.log(`         當前   開${curr3h.open} 高${curr3h.high} 低${curr3h.low} 收${curr3h.close}（${color(curr3h)}K）`);
  console.log(`         當前紅吞 ${mark(engulf3h)}（高點過前根 ${mark(curr3h.high > prev3h.high)}　自身收紅 ${mark(curr3h.close > curr3h.open)}）　或　前一根收黑K ${mark(prevBlack3h)}`);

  // ── 條件4：1H 當前紅吞（不放寬）；進場停損由前一根的斐波那契決定 ──
  const bars1h = await loadBars(symbol, '60', 4);
  const curr1h = bars1h[bars1h.length - 1];
  const prev1h = bars1h[bars1h.length - 2];
  const engulf1h = isBullEngulf(curr1h, prev1h);
  const c4 = engulf1h;
  if (c4) passed++;
  console.log(`\n${mark(c4)} 條件4  1H 當前紅吞（這關不放寬）`);
  console.log(`         前一根 開${prev1h.open} 高${prev1h.high} 低${prev1h.low} 收${prev1h.close}（${color(prev1h)}K）`);
  console.log(`         當前   開${curr1h.open} 高${curr1h.high} 低${curr1h.low} 收${curr1h.close}（${color(curr1h)}K）`);
  console.log(`         高點過前根 ${mark(curr1h.high > prev1h.high)}　自身收紅 ${mark(curr1h.close > curr1h.open)}`);
  if (c4) {
    console.log(`         → 進場 ${prev1h.high}（斐波那契 1）　停損 ${prev1h.low}（斐波那契 0）`);
  }

  console.log(`\n═══ 策略A 結果：符合 ${passed} / 4 項 ═══`);
  if (passed < 4) {
    const miss = [!c1 && '1', !c2 && '2', !c3 && '3', !c4 && '4'].filter(Boolean);
    console.log(`差在條件 ${miss.join('、')}`);
  } else {
    console.log('四關全過 —— 監控器下一輪就會下單');
  }

  // ═══ 策略B：突破後進場 ═══
  // 跟策略A 共用上面已經載好的四個週期，不再重抓一次圖表。
  console.log(`\n═══ ${symbol} 策略B（突破後進場）═══\n`);
  let passedB = 0;

  // ── B條件1：3D 當前紅吞 ──
  const prev3d = bars3d[bars3d.length - 2];
  const b1 = isBullEngulf(curr3d, prev3d);
  if (b1) passedB++;
  console.log(`${mark(b1)} B條件1  3D 當前紅吞`);
  console.log(`         前一根 高${prev3d.high} 低${prev3d.low} 收${prev3d.close}（${color(prev3d)}K）`);
  console.log(`         當前   高${curr3d.high} 低${curr3d.low} 收${curr3d.close}（${color(curr3d)}K）`);
  console.log(`         高點過前根 ${mark(curr3d.high > prev3d.high)}　自身收紅 ${mark(curr3d.close > curr3d.open)}`);

  // ── B條件2：(當前紅吞 且 低點不低於前一根 且 高點過 MA) 或 (前 2 根以上皆紅吞) ──
  const prevD = barsD[barsD.length - 2];
  const dEngulf = isBullEngulf(currD, prevD);
  const dHoldLow = currD.low >= prevD.low;
  const dOverMa = Number.isFinite(ma) && currD.high > ma;
  const b2a = dEngulf && dHoldLow && dOverMa;
  let bullRun = 0;
  for (let i = barsD.length - 2; i >= 1; i--) {
    if (isBullEngulf(barsD[i], barsD[i - 1])) bullRun++; else break;
  }
  const b2b = bullRun >= MIN_RUN;
  const b2 = b2a || b2b;
  if (b2) passedB++;
  console.log(`\n${mark(b2)} B條件2  1D (當前紅吞 且 低點不低於前一根 且 高點過 MA 1) 或 (前 ${MIN_RUN} 根以上皆紅吞)`);
  console.log(`         型態一：當前紅吞 ${mark(dEngulf)}　低點不低於前根 ${mark(dHoldLow)}（${currD.low} vs ${prevD.low}）　高點過MA ${mark(dOverMa)}（${currD.high} vs ${ma}）`);
  console.log(`         型態二：往前連續紅吞 ${bullRun} 根（要 ≥${MIN_RUN}）${mark(b2b)}`);

  // ── B條件3：3H 低點不得跌破「前面最近一根紅吞」的低點 ──
  const anchorIdx = findLastBullEngulfIdx(bars3h, bars3h.length - 2);
  const anchor3h = anchorIdx >= 0 ? bars3h[anchorIdx] : null;
  const b3 = !!anchor3h && curr3h.low >= anchor3h.low;
  if (b3) passedB++;
  console.log(`\n${mark(b3)} B條件3  3H 當前不限型態，但低點不得跌破前面最近一根紅吞的低點`);
  if (!anchor3h) {
    console.log(`         前 ${bars3h.length - 1} 根內找不到紅吞 —— 沒有錨點可比`);
  } else {
    console.log(`         錨點紅吞在 ${bars3h.length - 1 - anchorIdx} 根前，低點 ${anchor3h.low}`);
    console.log(`         當前低點 ${curr3h.low}　差 ${(curr3h.low - anchor3h.low).toFixed(8)}`);
  }

  // ── B條件4：1H 當前紅吞 或 自身收黑 ──
  const black1h = curr1h.close < curr1h.open;
  const b4 = engulf1h || black1h;
  if (b4) passedB++;
  console.log(`\n${mark(b4)} B條件4  1H 當前紅吞 或 自身收黑（擇一即可，並用前一根拉斐波那契）`);
  console.log(`         前一根 高${prev1h.high} 低${prev1h.low} 收${prev1h.close}（${color(prev1h)}K）`);
  console.log(`         當前   高${curr1h.high} 低${curr1h.low} 收${curr1h.close}（${color(curr1h)}K）`);
  console.log(`         當前紅吞 ${mark(engulf1h)}　或　自身收黑 ${mark(black1h)}`);
  if (b4) {
    console.log(`         → 進場 ${prev1h.high}（斐波那契 1）　停損 ${prev1h.low}（斐波那契 0）`);
  }

  console.log(`\n═══ 策略B 結果：符合 ${passedB} / 4 項 ═══`);
  if (passedB < 4) {
    const missB = [!b1 && '1', !b2 && '2', !b3 && '3', !b4 && '4'].filter(Boolean);
    console.log(`差在條件 ${missB.join('、')}\n`);
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
