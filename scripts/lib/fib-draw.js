/**
 * 在圖上拉一條斐波那契，把這筆單的進場／停損／四段停利畫出來。
 *
 * 監控器本來只在記憶體裡算斐波那契，圖上看不到任何痕跡，人要核對就得自己
 * 重畫一次。這支負責把同一組數字畫到圖上，讓「程式算的」跟「眼睛看的」是
 * 同一條線。
 *
 * 錨點：1 = 黑K 高點、0 = 黑K 低點（跟 computePlan 用的是同一個 fibBar）。
 *
 * 兩個實作上的坑，改之前先看這裡：
 *   1. createMultipointShape 的 overrides 設不動 levelN 的 coeff —— 傳進去
 *      會被無視，讀回來還是預設的 0.236 / 0.382 …。層級只能在建立後用
 *      shape.setProperties() 改，而且必須整組陣列換
 *      （level3: [係數, 顏色, 顯示, 文字]）；點號鍵 'level3.coeff' 一樣無效。
 *   2. 兩個錨點都落在同一根 K 棒上（寬度為 0），不開 extendLines 就等於畫了
 *      一條看不見的線。
 *
 * 錨點對應已實測確認（2026-10-24，INITUSDT 1H）：第一個點是 1、第二個點是 0。
 * 把係數 2 的測試層畫出來，落點是 0.14991 ＝ 低 0.14217 + 2×區間 0.00387，
 * 跟 computePlan 的算法同一條式子。
 */
import { evaluate } from '../../src/connection.js';

const API = 'window.TradingViewApi._activeChartWidgetWV.value()';

const COLOR_STOP = '#F23645';    // fib 0：停損
const COLOR_ENTRY = '#2962FF';   // fib 1：進場
const COLOR_TARGET = '#089981';  // 各段停利

/** 單一層的屬性是四格陣列：[係數, 顏色, 是否顯示, 文字] */
function level(coeff, color, text) {
  return [coeff, color, true, text || ''];
}

/**
 * @param {{time:number, high:number, low:number}} fibBar 拉斐波那契的那根黑K
 * @param {Array<{multiple:number, price:number}>} targets 停利各段（只取 multiple）
 * @param {string} [tag] 寫在 0 / 1 兩條線上的說明文字前綴
 * @returns {Promise<{ok:boolean, id?:string, reason?:string}>}
 */
export async function drawEntryFib({ fibBar, targets = [], tag = '' }) {
  if (!fibBar || !(fibBar.high > fibBar.low)) {
    return { ok: false, reason: `斐波那契區間不合法（高 ${fibBar?.high} 低 ${fibBar?.low}）` };
  }

  // 層級表：0 與 1 固定，其餘照這筆單的停利倍數排
  const levels = [
    level(0, COLOR_STOP, tag ? `${tag} 停損` : '停損'),
    level(1, COLOR_ENTRY, tag ? `${tag} 進場` : '進場'),
    ...targets.map(t => level(t.multiple, COLOR_TARGET, `TP ${t.multiple}R`)),
  ];

  const props = {
    'trendline.visible': false,
    showCoeffs: true,
    showPrices: true,
    extendLines: true,       // 錨點同一根 K 棒，不延伸等於看不見
    coeffsAsPercents: false,
  };
  levels.forEach((lv, i) => { props[`level${i + 1}`] = lv; });
  // 用不到的層一律關掉，否則預設的 0.236 / 0.382 … 會混進來
  for (let i = levels.length + 1; i <= 24; i++) props[`level${i}`] = [0, '#787B86', false, ''];

  // 同一根 fibBar 之前畫過就先拆掉，避免同一個標的反覆出訊號時疊成一團。
  // 只刪「錨點完全相同的斐波那契」—— 使用者自己在圖上畫的東西不能動。
  await evaluate(`(function(){
    var api = ${API};
    api.getAllShapes().forEach(function(s){
      if (s.name !== 'fib_retracement') return;
      try {
        var pts = api.getShapeById(s.id).getPoints();
        if (pts.length === 2
          && pts[0].time === ${fibBar.time} && pts[1].time === ${fibBar.time}
          && Math.abs(pts[0].price - ${fibBar.high}) < 1e-12
          && Math.abs(pts[1].price - ${fibBar.low}) < 1e-12) api.removeEntity(s.id);
      } catch (e) {}
    });
  })()`);

  // 建立與設定必須分兩次送：createMultipointShape 回來時 shape 還沒進
  // getAllShapes()，同一段 script 裡接著找一定是空的。
  const before = await evaluate(`${API}.getAllShapes().map(function(s){ return s.id; })`);
  const made = await evaluate(`(function(){
    try {
      ${API}.createMultipointShape(
        [{ time: ${fibBar.time}, price: ${fibBar.high} },
         { time: ${fibBar.time}, price: ${fibBar.low} }],
        { shape: 'fib_retracement' }
      );
      return 'ok';
    } catch (e) { return 'ERR: ' + (e.message || String(e)); }
  })()`);
  if (made !== 'ok') return { ok: false, reason: String(made) };

  let id = null;
  for (let i = 0; i < 20 && !id; i++) {
    await new Promise(r => setTimeout(r, 150));
    const after = await evaluate(`${API}.getAllShapes().map(function(s){ return s.id; })`);
    id = (after || []).find(x => !(before || []).includes(x)) || null;
  }
  if (!id) return { ok: false, reason: '建立後等不到新的 shape' };

  const res = await evaluate(`(function(){
    try {
      var sh = ${API}.getShapeById(${JSON.stringify(id)});
      if (!sh) return { ok: false, reason: '取不到 shape' };
      sh.setProperties(${JSON.stringify(props)});
      // 讀回來確認係數真的進去了，不然就是 setProperties 又被無視了
      var p = sh.getProperties();
      var got = [];
      for (var i = 1; i <= ${levels.length}; i++) { got.push(p['level' + i][0]); }
      return { ok: true, id: ${JSON.stringify(id)}, coeffs: got };
    } catch (e) { return { ok: false, reason: e.message || String(e) }; }
  })()`);

  if (!res || !res.ok) return { ok: false, reason: res?.reason || '畫圖失敗' };

  const want = levels.map(l => l[0]);
  const bad = want.filter((w, i) => Math.abs(res.coeffs[i] - w) > 1e-9);
  if (bad.length) {
    return { ok: false, id: res.id, reason: `層級沒設進去（預期 ${want.join('/')}，實際 ${res.coeffs.join('/')}）` };
  }
  return { ok: true, id: res.id };
}

/** 清掉圖上所有繪圖（換標的前用，避免一路累積） */
export async function clearDrawings() {
  return evaluate(`(function(){
    var api = ${API};
    var n = 0;
    api.getAllShapes().forEach(function(s){ try { api.removeEntity(s.id); n++; } catch(e) {} });
    return n;
  })()`);
}
