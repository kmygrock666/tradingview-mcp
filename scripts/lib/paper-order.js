/**
 * TradingView 模擬交易（Paper Trading）下單 —— UI 自動化
 *
 * 沒有可用的 API：Paper Trading 的 REST（rest-demo.tradingview.com）從頁面
 * origin 打會被 CORS 擋，broker controller 又包在 webpack 閉包裡沒對外暴露。
 * 所以只能驅動訂單視窗，但每一步都回讀驗證，最後再用送出鍵的文字當總檢查
 * （它會完整顯示「買入 N SYMBOL @ PRICE 限價」），確認無誤才按下去。
 *
 * 危險前提：訂單視窗綁定「圖表當下的商品」。監控器每輪會切換數十個標的，
 * 下單途中被切走就會下到別的商品上 —— 因此送出前一定要再比對一次商品。
 */

import { evaluate, evaluateAsync } from '../../src/connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// 頁面端共用工具：找訂單視窗、設 React 受控 input、點文字按鈕
const PAGE_HELPERS = `
  function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }
  function ticket() {
    var submit = document.querySelector('[data-name="place-and-modify-button"]');
    if (!submit) return null;
    // 由送出鍵往上找視窗根節點（class 是 hash，不能寫死）
    var el = submit;
    for (var i = 0; i < 8 && el; i++, el = el.parentElement) {
      if (el.querySelector('input') && /市場|限價|停損/.test(el.textContent || '')) return el;
    }
    return submit.parentElement;
  }
  function setInput(inp, val) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, String(val));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function clickByText(root, text, exact) {
    var all = Array.prototype.slice.call((root || document).querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], div, span, li'));
    var hit = all.filter(function(e){
      if (e.offsetParent === null) return false;
      var t = (e.textContent || '').trim();
      return exact ? t === text : t.indexOf(text) >= 0;
    });
    // 取最內層（文字最短）那個，避免點到外層容器
    hit.sort(function(a, b){ return (a.textContent||'').length - (b.textContent||'').length; });
    if (!hit.length) return false;
    hit[0].click();
    return true;
  }
  // input 沒寫 type 屬性，CSS 的 [type="text"] 選不到；改用 DOM 預設值過濾
  function textInputs(root) {
    return Array.prototype.slice.call(root.querySelectorAll('input')).filter(function(i){ return i.type !== 'checkbox'; });
  }
  function chartSymbol() {
    try { return ${CHART_API}.symbol(); } catch (e) { return null; }
  }
`;

// 「出場水平」子面板：一張訂單可以帶多層出場，每層有自己的數量／停利／停損。
//
// 為什麼需要它：同一個商品的兩張 bracket 單成交後會被併成一個部位，兩個停利
// 會在合併時消失，只留下一個涵蓋全部數量的停損 —— 等於分批停利整個失效
// （2026-10-16 實測 ETH：0.559 的部位只剩 SL，兩個 TP 都不見了）。
const PAGE_EXIT_LEVELS = `
  function levelsPanel() {
    var c = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function(d){
      var t = d.innerText || '';
      return d.offsetParent !== null && /保護倉位大小/.test(t) && /捨棄/.test(t) && t.length < 2000;
    });
    c.sort(function(a, b){ return (a.innerText||'').length - (b.innerText||'').length; });
    return c[0] || null;
  }
  function clickAddLevel(root) {
    if (!root) return false;
    var hits = Array.prototype.slice.call(root.querySelectorAll('*')).filter(function(e){
      return e.offsetParent !== null && (e.textContent || '').trim() === '新增水平';
    });
    if (!hits.length) return false;
    var el = hits[hits.length - 1], r = el.getBoundingClientRect();
    ['mousedown','mouseup','click'].forEach(function(type){
      el.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window,
        clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
    });
    return true;
  }
  // 展開中的那層固定是三個欄位：單位 / 停利 / 停損
  async function setExpandedLevel(qty, tp, sl) {
    var pnl = levelsPanel();
    if (!pnl) return '面板不見了';
    var ins = Array.prototype.slice.call(pnl.querySelectorAll('input')).filter(function(i){ return i.type !== 'checkbox'; });
    if (ins.length < 3) return '展開中的水平只有 ' + ins.length + ' 個欄位';
    var tail = ins.slice(-3);
    setInput(tail[0], qty); await sleep(500);
    setInput(tail[1], tp);  await sleep(400);
    setInput(tail[2], sl);  await sleep(400);
    return null;
  }
  // 面板文字一律用換行切開再比對：這段程式會經過「JS 檔 → 樣板字串 → 頁面」
  // 三層字串，反斜線每層都會被吃掉一次，正則裡的 \\s、\\d 寫法極易悄悄失效。
  function panelLines() {
    var pnl = levelsPanel();
    if (!pnl) return [];
    return (pnl.innerText || '').split(String.fromCharCode(10))
      .map(function(s){ return s.trim(); }).filter(Boolean);
  }
  function protectionPct() {
    var lines = panelLines();
    var i = lines.indexOf('保護倉位大小');
    if (i < 0 || i + 1 >= lines.length) return NaN;
    return parseFloat(String(lines[i + 1]).replace('%', ''));
  }
  // 繼承來的那層涵蓋全部數量，留著會讓保護倉位大小變成 150%
  function deleteFullSizeLevel() {
    var pnl = levelsPanel();
    if (!pnl) return false;
    var rows = Array.prototype.slice.call(pnl.querySelectorAll('*')).filter(function(e){
      if (e.offsetParent === null) return false;
      var t = e.innerText || '';
      return t.length < 300 && t.indexOf('水平') === 0 && t.indexOf('TP ') >= 0;
    });
    rows.sort(function(a, b){ return (a.innerText||'').length - (b.innerText||'').length; });
    // 佔比 > 90% 的那層就是繼承來的全額層
    var target = rows.filter(function(e){
      var parts = (e.innerText || '').split(String.fromCharCode(10))
        .map(function(s){ return s.trim(); }).filter(Boolean);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].slice(-1) === '%' && parseFloat(parts[i]) > 90) return true;
      }
      return false;
    })[0];
    if (!target) return false;
    var btns = Array.prototype.slice.call(target.querySelectorAll('button, [role="button"]'))
      .filter(function(b){ return b.offsetParent !== null; });
    if (!btns.length) return false;
    var del = btns[btns.length - 1], r = del.getBoundingClientRect();
    ['mousedown','mouseup','click'].forEach(function(type){
      del.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window,
        clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
    });
    return true;
  }
  function clickLevelsConfirm() {
    var pnl = levelsPanel();
    if (!pnl) return false;
    var ok = Array.prototype.slice.call(pnl.querySelectorAll('button, [role="button"]'))
      .filter(function(b){ return b.offsetParent !== null && (b.textContent||'').trim() === '確認'; })[0];
    if (!ok) return false;
    ok.click();
    return true;
  }
`;

/** 圖表目前的商品 */
export async function currentSymbol() {
  return evaluate(`(function(){ try { return ${CHART_API}.symbol(); } catch(e) { return null; } })()`);
}

/**
 * 讀取模擬交易帳戶摘要（權益、可用資金…）。
 * 面板是「標籤、數值」交錯的文字節點，取含「權益」且最精簡的那個容器來解析。
 * 數值可能帶千分位逗號，負號是 U+2212（−）不是 ASCII 的 -。
 */
export async function accountSummary() {
  return evaluate(`(function(){
    var cands = Array.prototype.slice.call(document.querySelectorAll('div, span')).filter(function(e){
      return e.offsetParent !== null && /權益/.test(e.textContent || '') && (e.textContent || '').length < 300;
    });
    cands.sort(function(a, b){ return (a.textContent||'').length - (b.textContent||'').length; });
    var host = cands[cands.length - 1];
    if (!host) return { ok: false, reason: '找不到帳戶摘要（交易面板沒開？）' };
    var txt = (host.innerText || '').split('\\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var want = { '權益': 'equity', '可用資金': 'available', '帳戶餘額': 'balance',
                 '訂單保證金': 'orderMargin', '帳戶保證金': 'usedMargin' };
    var out = {};
    for (var i = 0; i < txt.length - 1; i++) {
      var k = want[txt[i]];
      if (!k) continue;
      var v = txt[i + 1].replace(/,/g, '').replace(/\\u2212/g, '-').replace(/[+]/g, '');
      if (/^-?[\\d.]+$/.test(v)) out[k] = parseFloat(v);
    }
    var acct = txt.filter(function(s){ return /帳戶$/.test(s); })[0] || null;
    if (out.equity == null) return { ok: false, reason: '讀不到權益', lines: txt.slice(0, 12) };
    return { ok: true, account: acct, equity: out.equity, available: out.available,
             balance: out.balance, orderMargin: out.orderMargin, usedMargin: out.usedMargin };
  })()`);
}

/**
 * 掛一張限價買單，附停損與停利。
 *
 * dryRun = true 時填完所有欄位、回傳預覽（含送出鍵文字），但不送出也不關閉，
 * 由呼叫端決定要不要 submit()。
 */
export async function placeLimitBracket({ symbol, qty, limitPrice, stopPrice, tpPrice, exits = null, dryRun = true }) {
  const payload = JSON.stringify({ symbol, qty, limitPrice, stopPrice, tpPrice, exits, dryRun });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_EXIT_LEVELS}
    var p = ${payload};
    var log = [];
    function fail(step, detail) { return { ok: false, step: step, detail: detail, log: log }; }

    // 0) 商品必須正確 —— 監控器隨時可能把圖表切走
    var sym = chartSymbol();
    if (sym !== p.symbol) return fail('symbol', '圖表在 ' + sym + '，預期 ' + p.symbol);
    log.push('商品正確：' + sym);

    // 1) 開啟訂單視窗
    if (!ticket()) {
      var buyBtn = document.querySelector('[data-name="buy-order-button"]');
      if (!buyBtn) return fail('open', '找不到買入按鈕');
      buyBtn.click();
      for (var i = 0; i < 20 && !ticket(); i++) await sleep(100);
      if (!ticket()) return fail('open', '訂單視窗沒出現');
    }
    log.push('訂單視窗已開啟');
    var t = ticket();

    // 2) 切到「限價」分頁
    var tab = Array.prototype.slice.call(t.querySelectorAll('[role="tab"], button'))
      .filter(function(b){ return (b.textContent||'').trim() === '限價'; })[0];
    if (!tab) return fail('limitTab', '找不到限價分頁');
    tab.click();
    await sleep(300);
    t = ticket();
    var activeTab = Array.prototype.slice.call(t.querySelectorAll('[role="tab"]'))
      .filter(function(x){ return x.getAttribute('aria-selected') === 'true'; })
      .map(function(x){ return (x.textContent||'').trim(); })[0];
    if (activeTab !== '限價') return fail('limitTab', '切換後分頁是「' + activeTab + '」');
    log.push('已切到限價');

    // 3) 數量輸入改成「單位」模式（預設是 USD保證金）。
    // 這一步沉默失敗過：以為切好了，其實欄位還是 USD保證金，1947 就被當成
    // 1947 USD 保證金 ×10 倍槓桿 ÷ 價格 = 十萬單位。所以切完一定要回讀確認。
    function qtyMode() {
      var tk = ticket();
      var b = Array.prototype.slice.call(tk.querySelectorAll('button'))
        .filter(function(x){
          var s = (x.textContent||'').trim();
          return x.getAttribute('role') !== 'tab' && s.length <= 8 && /^(USD保證金|%餘額|風險USD|風險 % 餘額|單位)$/.test(s);
        })[0];
      return b ? { btn: b, text: (b.textContent||'').trim() } : null;
    }
    var mode = qtyMode();
    if (!mode) return fail('qtyMode', '找不到數量類型按鈕');
    if (mode.text !== '單位') {
      mode.btn.click();
      await sleep(350);
      // 下拉選單渲染在 ticket 之外（portal），只在外面找才不會點到欄位旁邊的單位標籤
      var tk = ticket();
      var opts = Array.prototype.slice.call(document.querySelectorAll('div, span, li, button'))
        .filter(function(e){
          return e.offsetParent !== null && (e.textContent||'').trim() === '單位'
            && e.children.length === 0 && (!tk || !tk.contains(e));
        });
      if (!opts.length) return fail('qtyMode', '下拉選單裡找不到「單位」選項');
      opts[0].click();
      await sleep(350);
      var after = qtyMode();
      if (!after || after.text !== '單位') {
        return fail('qtyMode', '切換後數量類型仍是「' + (after ? after.text : '?') + '」');
      }
      log.push('數量模式 → 單位（已回讀確認）');
    } else {
      log.push('數量模式本來就是單位');
    }

    // 4) 填價格與數量
    t = ticket();
    var inputs = Array.prototype.slice.call(textInputs(t));
    if (inputs.length < 2) return fail('fields', '輸入欄位不足：' + inputs.length);
    setInput(inputs[0], p.limitPrice);   // 限價
    setInput(inputs[1], p.qty);          // 數量
    await sleep(200);
    log.push('限價 ' + p.limitPrice + '、數量 ' + p.qty);

    // 停利／停損的輸入模式預設不一定是「價格」：停損預設是「%餘額」，直接
    // 填 0.14 會被當成「賠 0.14% 權益」換算成 0.1493 的停損價 —— 畫面看起來
    // 完全正常，單子卻是錯的。所以切換後一定要回讀確認。
    function exitModeBtn(prefix) {
      var tk = ticket();
      var b = Array.prototype.slice.call(tk.querySelectorAll('button')).filter(function(x){
        return x.getAttribute('role') !== 'tab'
          && new RegExp('^' + prefix + '\\\\s*,').test((x.textContent || '').trim());
      })[0];
      return b ? { btn: b, text: (b.textContent || '').trim() } : null;
    }
    async function forcePriceMode(prefix) {
      var m = exitModeBtn(prefix);
      if (!m) return '找不到「' + prefix + '」的模式按鈕';
      if (/價格/.test(m.text)) return null;
      m.btn.click();
      await sleep(300);
      var tk = ticket();
      var opts = Array.prototype.slice.call(document.querySelectorAll('div, span, li, button')).filter(function(e){
        return e.offsetParent !== null && (e.textContent || '').trim() === '價格'
          && e.children.length === 0 && (!tk || !tk.contains(e));
      });
      if (!opts.length) return '「' + prefix + '」的下拉選單裡找不到「價格」';
      opts[0].click();
      await sleep(300);
      var after = exitModeBtn(prefix);
      if (!after || !/價格/.test(after.text)) {
        return '「' + prefix + '」切換後仍是「' + (after ? after.text : '?') + '」';
      }
      return null;
    }

    // 5) 開啟停利，模式確保是價格，再填值
    t = ticket();
    var checks = Array.prototype.slice.call(t.querySelectorAll('input[type="checkbox"]'));
    if (checks.length < 2) return fail('exits', '找不到停利/停損開關');
    if (!checks[0].checked) { checks[0].click(); await sleep(300); }
    var tpErr = await forcePriceMode('停利');
    if (tpErr) return fail('tpMode', tpErr);
    t = ticket();
    inputs = Array.prototype.slice.call(textInputs(t));
    setInput(inputs[2], p.tpPrice);
    await sleep(200);
    log.push('停利 ' + p.tpPrice + '（模式已確認為價格）');

    // 6) 開啟停損，模式確保是價格，再填值
    t = ticket();
    checks = Array.prototype.slice.call(t.querySelectorAll('input[type="checkbox"]'));
    if (!checks[1].checked) { checks[1].click(); await sleep(300); }
    var slErr = await forcePriceMode('停損');
    if (slErr) return fail('slMode', slErr);
    t = ticket();
    inputs = Array.prototype.slice.call(textInputs(t));
    setInput(inputs[3], p.stopPrice);
    await sleep(200);
    log.push('停損 ' + p.stopPrice + '（模式已確認為價格）');

    // 6.5) 分批出場：把這張單設成兩個「出場水平」，各半部位、不同停利。
    // 不能改用兩張單 —— 成交後會併成一個部位，停利會在合併時消失。
    if (p.exits && p.exits.length === 2) {
      if (!clickAddLevel(ticket())) return fail('levels', '找不到「新增水平」');
      await sleep(900);
      if (!levelsPanel()) return fail('levels', '出場水平面板沒開啟');

      // 新增出來的那層是展開的：先設成第二批
      var e2 = p.exits[1];
      var err2 = await setExpandedLevel(e2.qty, e2.tp, p.stopPrice);
      if (err2) return fail('levels', '第二批設定失敗：' + err2);
      log.push('水平：第二批 ' + e2.qty + ' @ ' + e2.tp);

      // 刪掉繼承來的全額層，否則保護倉位大小會變成 150%
      if (!deleteFullSizeLevel()) return fail('levels', '刪不掉繼承的全額水平');
      await sleep(700);

      // 再加一層，會自動吃下剩餘的 50%
      if (!clickAddLevel(levelsPanel())) return fail('levels', '第二次「新增水平」失敗');
      await sleep(900);
      var e1 = p.exits[0];
      var err1 = await setExpandedLevel(e1.qty, e1.tp, p.stopPrice);
      if (err1) return fail('levels', '第一批設定失敗：' + err1);
      log.push('水平：第一批 ' + e1.qty + ' @ ' + e1.tp);

      // 兩層加起來必須剛好蓋住整個部位，少了等於有一半沒出場計畫
      var pct = protectionPct();
      if (!(Math.abs(pct - 100) < 1)) return fail('levels', '保護倉位大小是 ' + pct + '%，不是 100%');
      // 收合的水平把價格寫在文字裡（還帶千分位逗號），展開中的那層在 input 裡，
      // 只查文字會把正確的單誤判成失敗（2026-10-16 DUSK 就是這樣被擋掉的）
      var joined = panelLines().join(' ').split(',').join('');
      var liveVals = Array.prototype.slice.call(levelsPanel().querySelectorAll('input'))
        .filter(function(i){ return i.type !== 'checkbox'; })
        .map(function(i){ return String(i.value).split(',').join(''); });
      function levelShown(v) {
        return joined.indexOf(String(v)) >= 0 || liveVals.indexOf(String(v)) >= 0;
      }
      if (!levelShown(e1.tp) || !levelShown(e2.tp)) {
        return fail('levels', '面板裡看不到兩個停利價（' + e1.tp + ' / ' + e2.tp + '）：' + joined.slice(0, 160));
      }
      log.push('保護倉位大小 ' + pct + '%');
      if (!clickLevelsConfirm()) return fail('levels', '找不到水平面板的「確認」');
      await sleep(1000);
    }

    // 7) 總檢查：送出鍵的文字會完整描述這張單
    t = ticket();
    var submit = t.querySelector('[data-name="place-and-modify-button"]');
    var preview = submit ? (submit.textContent||'').trim().replace(/\\s+/g, ' ') : null;
    var fields = Array.prototype.slice.call(textInputs(t)).map(function(i){ return i.value; });
    var symNow = chartSymbol();
    if (symNow !== p.symbol) return fail('symbolDrift', '填單途中圖表被切到 ' + symNow);

    if (!preview) return fail('preview', '讀不到送出鍵');

    // 這些核對乾跑時也要跑 —— 只在真送出前才驗的話，「填錯了」會拖到最後一刻才爆
    var bare = p.symbol.split(':').pop();
    if (preview.indexOf('限價') < 0) return fail('preview', '不是限價單（訂單類型被改掉？）：' + preview);
    if (preview.indexOf(bare) < 0) return fail('preview', '商品不符：' + preview);
    var qm = preview.match(/買入\\s*([\\d,.]+)/);
    var qtyShown = qm ? parseFloat(qm[1].replace(/,/g, '')) : NaN;
    if (!(Math.abs(qtyShown - p.qty) <= Math.max(1, p.qty * 0.01))) {
      return fail('preview', '數量不符：送出鍵顯示 ' + qtyShown + '，預期 ' + p.qty + '｜' + preview);
    }
    var pm = preview.match(/@\\s*([\\d,.]+)/);
    var priceShown = pm ? parseFloat(pm[1].replace(/,/g, '')) : NaN;
    if (!(Math.abs(priceShown - p.limitPrice) <= Math.max(1e-8, p.limitPrice * 0.001))) {
      return fail('preview', '限價不符：送出鍵顯示 ' + priceShown + '，預期 ' + p.limitPrice + '｜' + preview);
    }

    if (p.dryRun) return { ok: true, dryRun: true, preview: preview, fields: fields, log: log };

    submit.click();
    await sleep(800);
    return { ok: true, submitted: true, preview: preview, fields: fields, log: log,
             ticketClosed: !ticket() };
  })()`);
}

/**
 * 替「已經成交的部位」補上兩層出場水平。
 *
 * 用在舊方法留下的爛攤子：兩張 bracket 單成交後併成一個部位，只剩最後那張
 * 的停利（10R），5R 那層整個不見。這裡把部位改成 半倉@tp1 + 半倉@tp2。
 */
export async function fixPositionExits({ symbol, tp1, tp2, stopPrice }) {
  const payload = JSON.stringify({ symbol, tp1, tp2, stopPrice });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_EXIT_LEVELS}
    var p = ${payload};
    var log = [];
    function fail(step, detail) { return { ok: false, step: step, detail: detail, log: log }; }

    // 1) 切到持倉分頁，找到這個標的的那一列
    var tab = Array.prototype.slice.call(document.querySelectorAll('button'))
      .filter(function(b){ return b.offsetParent !== null && /^持倉/.test((b.textContent||'').trim()); })[0];
    if (!tab) return fail('tab', '找不到持倉分頁');
    tab.click();
    await sleep(700);

    // 一定要用含交易所前綴的完整代號：同一個幣可能同時有 OKX:SOLUSDT.P 與
    // BINANCE:SOLUSDT.P 兩個部位，只比對幣名會開到錯的那一個。
    var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
      var t = e.innerText || '';
      return e.offsetParent !== null && t.length < 300 && t.indexOf(p.symbol) >= 0 && /做多|做空/.test(t)
        && e.querySelector('[data-name="edit-settings-cell-button"]');
    });
    var rows = els.filter(function(e){ return !els.some(function(o){ return o !== e && e.contains(o); }); });
    if (!rows.length) return fail('row', '持倉裡找不到 ' + p.symbol);
    log.push('找到持倉：' + (rows[0].innerText || '').slice(0, 40).replace(/\\s+/g, ' '));

    // 2) 開啟該列的出場設定
    rows[0].querySelector('[data-name="edit-settings-cell-button"]').click();
    await sleep(1200);

    // 3) 進出場水平面板
    if (!clickAddLevel(document.body)) return fail('levels', '找不到「新增水平」');
    await sleep(1000);
    var pnl = levelsPanel();
    if (!pnl) return fail('levels', '出場水平面板沒開啟');

    // 4) 讀出部位數量，算出一半。
    // 數量必須是該商品「數量步長」的倍數，否則後端會拒絕修改持倉
    // （錯誤提示：「指定數量必須為該商品數量步長的倍數」），而且 UI 不會擋，
    // 不看 toast 就會以為成功。用顯示值的小數位去算，半倉才會落在合法刻度上。
    var lines = panelLines();
    var qtyLine = lines.filter(function(s){ return s.indexOf('買進') === 0 || s.indexOf('賣出') === 0; })[0] || '';
    var qtyToken = qtyLine.split(' ').filter(function(s){ return s && !isNaN(parseFloat(s.replace(/,/g, ''))); })[0];
    if (!qtyToken) return fail('qty', '讀不到部位數量：' + qtyLine.slice(0, 60));
    var posQty = parseFloat(qtyToken.replace(/,/g, ''));
    var decimals = (qtyToken.split('.')[1] || '').length;
    var halfStr = (posQty / 2).toFixed(decimals + 1);
    log.push('部位 ' + posQty + ' → 每批 ' + halfStr);

    // 5) 新增出來的層設成第一批（近端停利）
    var err = await setExpandedLevel(halfStr, p.tp1, p.stopPrice);
    if (err) return fail('levels', '設定第一批失敗：' + err);
    await sleep(600);
    log.push('第一批 ' + halfStr + ' @ ' + p.tp1);

    // 6) 刪掉涵蓋全部數量的原層（它不會自動讓出數量，留著會變成 150%）
    if (!deleteFullSizeLevel()) return fail('levels', '刪不掉全額水平');
    await sleep(800);

    // 7) 再加一層吃下剩餘 50%，設成第二批（遠端停利）
    if (!clickAddLevel(levelsPanel())) return fail('levels', '第二次新增水平失敗');
    await sleep(1000);
    var err2 = await setExpandedLevel(halfStr, p.tp2, p.stopPrice);
    if (err2) return fail('levels', '第二批失敗：' + err2);
    log.push('第二批 ' + halfStr + ' @ ' + p.tp2);

    var pct = protectionPct();
    if (!(Math.abs(pct - 100) < 1.5)) return fail('levels', '保護倉位大小 ' + pct + '%，不是 100%');
    // 收合的水平把價格寫在文字裡（帶千分位逗號），展開中的那層則是在 input 裡，
    // 只看其中一邊一定會漏，兩邊都要查。
    var joined = panelLines().join(' ').split(',').join('');
    var liveInputs = Array.prototype.slice.call(levelsPanel().querySelectorAll('input'))
      .filter(function(i){ return i.type !== 'checkbox'; })
      .map(function(i){ return String(i.value).split(',').join(''); });
    function shown(v) {
      return joined.indexOf(String(v)) >= 0 || liveInputs.indexOf(String(v)) >= 0;
    }
    if (!shown(p.tp1)) return fail('levels', '面板看不到第一批停利 ' + p.tp1);
    if (!shown(p.tp2)) return fail('levels', '面板看不到第二批停利 ' + p.tp2);
    log.push('保護倉位大小 ' + pct + '%');

    if (!clickLevelsConfirm()) return fail('levels', '找不到水平面板的確認');
    await sleep(1200);

    // 6) 部位編輯面板自己也要按一次確認才會送出
    var apply = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'))
      .filter(function(b){ return b.offsetParent !== null && /^(確認|修改|套用)$/.test((b.textContent||'').trim()); })[0];
    if (!apply) return fail('apply', '找不到部位編輯器的確認鈕');
    apply.click();
    await sleep(1500);

    // 7) 後端拒絕時只會跳一則 toast，不看就會把失敗當成功
    var toast = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
      var t = (e.innerText || '');
      return e.offsetParent !== null && t.length < 200 && /無法修改|錯誤|失敗|not a multiple|步長/.test(t);
    }).map(function(e){ return (e.innerText || '').replace(/\\s+/g, ' ').trim(); })[0];
    if (toast) return fail('rejected', '後端拒絕：' + toast.slice(0, 120));

    return { ok: true, log: log, posQty: posQty, half: halfStr };
  })()`);
}

/** 目前持倉（商品、方向、數量、均價） */
export async function listPositions() {
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    var tab = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
      return b.offsetParent !== null && (b.textContent||'').trim().indexOf('持倉') === 0;
    })[0];
    if (!tab) return { ok: false, reason: '找不到持倉分頁（交易面板沒開？）' };
    tab.click();
    await sleep(700);
    var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
      var t = e.innerText || '';
      return e.offsetParent !== null && t.length < 400 && t.indexOf(':') >= 0
        && (t.indexOf('做多') >= 0 || t.indexOf('做空') >= 0)
        && e.querySelector('[data-name="edit-settings-cell-button"]');
    });
    var rows = els.filter(function(e){ return !els.some(function(o){ return o !== e && e.contains(o); }); });
    return { ok: true, rows: rows.map(function(e){
      var cells = (e.innerText || '').split(String.fromCharCode(10)).join(String.fromCharCode(9))
        .split(String.fromCharCode(9)).map(function(s){ return s.trim(); }).filter(Boolean);
      return {
        symbol: cells.filter(function(c){ return c.indexOf(':') >= 0; })[0] || null,
        side: cells.filter(function(c){ return c === '做多' || c === '做空'; })[0] || null,
        cells: cells.slice(0, 8)
      };
    }) };
  })()`);
}

/**
 * 目前「真的還開著」的商品：有掛單或有持倉的。
 *
 * 防重複下單必須看這個，不能看帳本 —— 帳本記的是「當時下了單」，它永遠
 * 不會知道那筆單後來成交、停損、被取消了。2026-10-16 BTW 就是這樣：單子
 * 早在 18:52 停損出場，帳本仍寫著 placed，於是之後的新信號全被擋掉。
 */
export async function openExposure() {
  const [orders, positions] = await Promise.all([listOrders(), listPositions()]);
  const symbols = new Set();
  (orders.rows || []).forEach(r => { if (r.symbol && r.type) symbols.add(r.symbol); });
  (positions.rows || []).forEach(r => { if (r.symbol) symbols.add(r.symbol); });
  return {
    ok: (orders.ok !== false) && (positions.ok !== false),
    symbols: [...symbols],
    orderCount: orders.count || 0,
    positionCount: (positions.rows || []).length,
  };
}

/** 關閉訂單視窗（不送出） */
export async function closeTicket() {
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    var t = ticket();
    if (!t) return { closed: true, note: '本來就沒開' };
    var host = t;
    for (var n = 0; n < 6 && host; n++, host = host.parentElement) {
      var x = Array.prototype.slice.call(host.querySelectorAll('button, [role="button"]'))
        .filter(function(b){
          if (b.offsetParent === null) return false;
          var s = (b.getAttribute('aria-label')||'') + (b.getAttribute('data-name')||'') + (typeof b.className==='string'?b.className:'');
          return /close|關閉/i.test(s);
        })[0];
      if (x) { x.click(); await sleep(300); break; }
    }
    return { closed: !ticket() };
  })()`);
}

// 訂單分頁的列：外層容器也會符合條件，所以要濾掉「包著其他列」的那些
const PAGE_ORDER_ROWS = `
  function ordersTab() {
    return Array.prototype.slice.call(document.querySelectorAll('button, [role="tab"]'))
      .filter(function(b){ return b.offsetParent !== null && /^訂單/.test((b.textContent||'').trim()); })[0];
  }
  function orderRows() {
    var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
      if (e.offsetParent === null) return false;
      var t = e.innerText || '';
      return t.length < 300 && /:/.test(t) && /買入|賣出/.test(t) && /限價|停損|停利|市價/.test(t)
        && e.querySelectorAll('button, [role="button"]').length >= 1;
    });
    return els.filter(function(e){
      return !els.some(function(o){ return o !== e && e.contains(o); });
    });
  }
  function parseRow(e) {
    var cells = (e.innerText || '').split('\\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var num = function(s){ var v = parseFloat(String(s).replace(/,/g, '')); return isFinite(v) ? v : null; };
    // 「類型」和「數量」擠在同一個文字節點，中間用 tab 分隔：'限價\\t1,948'
    var tq = (cells.filter(function(c){ return /^(限價|停損|停利|市價)\\t/.test(c); })[0] || '').split('\\t');
    // 時間那一格同時含下單時間、訂單編號、到期時間、槓桿
    var meta = (cells.filter(function(c){ return /\\d{4}-\\d{2}-\\d{2}/.test(c); })[0] || '').split('\\t')
      .map(function(s){ return s.trim(); }).filter(Boolean);
    var prices = cells.filter(function(c){ return /^[\\d,.]+$/.test(c); }).map(num);
    return {
      symbol: (cells.filter(function(c){ return /:/.test(c); })[0] || null),
      side: (cells.filter(function(c){ return /^(買入|賣出)$/.test(c); })[0] || null),
      type: tq[0] || null,
      qty: tq[1] ? num(tq[1]) : null,
      status: (cells.filter(function(c){ return /^(運轉中|未啟用|已成交|已取消|被拒)$/.test(c); })[0] || null),
      placedAt: meta[0] || null,
      orderId: (meta.filter(function(s){ return /^\\d{6,}$/.test(s); })[0] || null),
      expiresAt: (meta.filter(function(s){ return /\\d{4}-\\d{2}-\\d{2}/.test(s); })[1] || null),
      prices: prices, cells: cells
    };
  }
`;

/** 目前掛單列表（會切到訂單分頁） */
export async function listOrders() {
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_ORDER_ROWS}
    var tab = ordersTab();
    if (!tab) return { ok: false, reason: '找不到訂單分頁（交易面板沒開？）' };
    tab.click();
    await sleep(500);
    var label = (tab.textContent || '').trim();
    var m = label.match(/(\\d+)/);
    return { ok: true, tabLabel: label, count: m ? parseInt(m[1], 10) : 0,
             rows: orderRows().map(parseRow) };
  })()`);
}

/**
 * 取消掛單。symbol 省略時取消全部。
 * 取消進場單時，TradingView 通常會連帶清掉它的停利/停損子單，所以會重複掃描
 * 直到沒有符合的列為止（最多 10 輪，避免 UI 卡住時無限迴圈）。
 */
export async function cancelOrders({ symbol = null } = {}) {
  const payload = JSON.stringify({ symbol });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_ORDER_ROWS}
    var p = ${payload};
    var tab = ordersTab();
    if (!tab) return { ok: false, reason: '找不到訂單分頁' };
    tab.click();
    await sleep(500);

    var bare = p.symbol ? p.symbol.split(':').pop() : null;
    var cancelled = [], notes = [];
    for (var round = 0; round < 10; round++) {
      var rows = orderRows().filter(function(e){
        return !bare || (e.innerText || '').indexOf(bare) >= 0;
      });
      if (!rows.length) break;
      var row = rows[0];
      var info = parseRow(row);
      // 操作欄的最後一顆按鈕是 ✕（前面那顆是編輯）
      var btns = Array.prototype.slice.call(row.querySelectorAll('button, [role="button"]'))
        .filter(function(b){ return b.offsetParent !== null; });
      if (!btns.length) { notes.push('某列找不到按鈕'); break; }
      btns[btns.length - 1].click();
      await sleep(600);
      // 可能跳確認框
      var confirm = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
        return b.offsetParent !== null && /^(確定|確認|是|取消訂單|OK)$/.test((b.textContent||'').trim());
      })[0];
      if (confirm) { confirm.click(); await sleep(600); }
      cancelled.push(info);
      // 這一列若還在，代表沒取消成功，別再空轉
      var still = orderRows().some(function(e){ return e === row; });
      if (still) { notes.push('有一列按了取消仍在：' + (info.symbol || '?')); break; }
    }
    var label = (ordersTab().textContent || '').trim();
    var m = label.match(/(\\d+)/);
    return { ok: true, cancelled: cancelled, notes: notes,
             remaining: m ? parseInt(m[1], 10) : 0, tabLabel: label };
  })()`);
}
