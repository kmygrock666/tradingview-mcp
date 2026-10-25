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
  // 頁面端關閉訂單視窗（清場用，避免殘留的視窗擋住後續點擊）
  async function closeTicketInPage() {
    var t = ticket();
    if (!t) return true;
    var host = t;
    for (var i = 0; i < 6 && host; i++, host = host.parentElement) {
      var x = Array.prototype.slice.call(host.querySelectorAll('button, [role="button"]')).filter(function(b){
        if (b.offsetParent === null) return false;
        var k = (b.getAttribute('aria-label') || '') + (b.getAttribute('data-name') || '')
          + (typeof b.className === 'string' ? b.className : '');
        return /close|關閉/i.test(k);
      })[0];
      if (x) { x.click(); await sleep(400); break; }
    }
    return !ticket();
  }
`;

// 「出場水平」子面板：一張訂單可以帶多層出場，每層有自己的數量／停利／停損。
//
// 為什麼需要它：同一個商品的兩張 bracket 單成交後會被併成一個部位，兩個停利
// 會在合併時消失，只留下一個涵蓋全部數量的停損 —— 等於分批停利整個失效
// （2026-10-16 實測 ETH：0.559 的部位只剩 SL，兩個 TP 都不見了）。
const PAGE_EXIT_LEVELS = `
  // 取「整個出場水平編輯器」的容器。
  //
  // 只取最小的那個會出事：在部位編輯器裡，展開中那層的欄位與部分水平列是
  // 最小容器的「兄弟節點」，於是 levelRows() 只看得到一部分，刪除指令就打在
  // 不完整的視野上 —— 2026-10-24 SOON/ZAMA 的停損沒被改到就是這樣來的
  // （以為刪了舊層，其實新舊都還在，保護倉位變成 200%）。
  // 作法：先找到最小的匹配容器，再往上爬，取仍在合理大小內的最外層。
  function levelsPanel() {
    var c = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function(d){
      var t = d.innerText || '';
      return d.offsetParent !== null && /保護倉位大小/.test(t) && /捨棄/.test(t) && t.length < 2000;
    });
    c.sort(function(a, b){ return (a.innerText||'').length - (b.innerText||'').length; });
    var base = c[0] || null;
    if (!base) return null;
    var best = base;
    for (var el = base.parentElement, i = 0; el && i < 5; el = el.parentElement, i++) {
      var t2 = el.innerText || '';
      if (t2.indexOf('捨棄') < 0 || t2.length > 3000) break;
      best = el;
    }
    return best;
  }
  // 部位編輯器的「簡易出場表單」：只有停利／停損兩格，沒有「保護倉位大小」。
  // 單層（或沒有停利）的部位開出來就是這個，levelsPanel() 找不到它。
  function simpleExitForm() {
    return Array.prototype.slice.call(document.querySelectorAll('div')).filter(function(d){
      var t = d.innerText || '';
      return d.offsetParent !== null && /捨棄/.test(t) && /退出/.test(t) && t.length < 5000;
    }).sort(function(a, b){ return (a.innerText||'').length - (b.innerText||'').length; })[0] || null;
  }
  // 「停利 ticks」「停損 價格」這類模式按鈕（取 host 裡最後一顆 —— 多層畫面
  // 上面還留著簡易表單那一組，展開中的那層在後面）
  function modeBtnIn(hostFn, prefix) {
    var host = hostFn();
    if (!host) return null;
    var hits = Array.prototype.slice.call(host.querySelectorAll('button')).filter(function(b){
      var t = (b.textContent || '').trim();
      return b.offsetParent !== null && t.indexOf(prefix) === 0 && t.length > prefix.length;
    });
    return hits.length ? hits[hits.length - 1] : null;
  }
  // 把某一側切成「價格」模式。
  //
  // 不切的話那一格是 ticks：填 0.04397 會被當成 0.04397 個 tick、四捨五入成 0，
  // 面板跟著掛上「停利必須高於當前bid」，那個錯誤狀態下連「新增水平」都點不動
  // —— 四層只會有兩層真的建出來（保護停在 150%）。
  // 下拉選單是渲染在 host 之外的，所以要排除 host 內部那顆顯示等值價格的
  // 「價格」按鈕 —— 點到它等於什麼都沒做。
  async function forcePriceModeIn(hostFn, prefix) {
    var m = modeBtnIn(hostFn, prefix);
    if (!m) return '找不到「' + prefix + '」的模式按鈕';
    if (/價格/.test(m.textContent || '')) return null;
    clickLike(m);
    await sleep(600);
    var host = hostFn();
    var opts = Array.prototype.slice.call(document.querySelectorAll('div,span,li,button')).filter(function(e){
      return e.offsetParent !== null && (e.textContent || '').trim() === '價格'
        && e.children.length === 0 && (!host || !host.contains(e));
    });
    if (!opts.length) return '「' + prefix + '」的下拉選單裡找不到「價格」';
    clickLike(opts[0]);
    await sleep(800);
    var after = modeBtnIn(hostFn, prefix);
    if (!after || !/價格/.test(after.textContent || '')) {
      return '「' + prefix + '」切換後仍是「' + (after ? (after.textContent||'').trim() : '?') + '」';
    }
    return null;
  }
  function forceSimplePriceMode(prefix) { return forcePriceModeIn(simpleExitForm, prefix); }
  // 用真的滑鼠事件點（有些元件不理會 el.click()）
  function clickLike(el) {
    var r = el.getBoundingClientRect();
    ['mousedown','mouseup','click'].forEach(function(type){
      el.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window,
        clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
    });
  }
  // 「新增水平」在整個畫面上的那一顆（部位編輯器的簡易表單階段還沒有面板容器
  // 可以當搜尋範圍，所以這裡從 document 找，取最後一顆＝最靠近操作中的那區）
  function findAddLevel() {
    var hits = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
      return e.offsetParent !== null && (e.textContent || '').trim() === '新增水平';
    });
    return hits.length ? hits[hits.length - 1] : null;
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
  // 展開中那層的三個欄位（單位 / 停利 / 停損）不一定在 levelsPanel() 選到的
  // 容器裡：訂單視窗的在裡面，部位編輯器的在外層兄弟節點。往上找到真的有
  // 欄位的那層容器為止，否則會回報「只有 0 個欄位」。
  function levelInputs() {
    var host = levelsPanel();
    for (var i = 0; i < 5 && host; i++, host = host.parentElement) {
      var ins = Array.prototype.slice.call(host.querySelectorAll('input'))
        .filter(function(x){ return x.type !== 'checkbox'; });
      if (ins.length >= 3) return ins;
    }
    return [];
  }
  async function setExpandedLevel(qty, tp, sl) {
    var pnl = levelsPanel();
    if (!pnl) return '面板不見了';
    // 展開中那層的停利／停損各自有模式，從訂單視窗進來時是「價格」，但從部位
    // 編輯器進來時會是 ticks。ticks 模式下填價格會被算成 0，那層就是無效的，
    // 而且連帶讓下一次「新增水平」失效 —— 要先切回價格。
    var tpMode = await forcePriceModeIn(levelsPanel, '停利');
    if (tpMode) return tpMode;
    var slMode = await forcePriceModeIn(levelsPanel, '停損');
    if (slMode) return slMode;
    var ins = levelInputs();
    if (ins.length < 3) return '展開中的水平只有 ' + ins.length + ' 個欄位';
    var tail = ins.slice(-3);
    setInput(tail[0], qty); await sleep(500);
    setInput(tail[1], tp);  await sleep(400);
    setInput(tail[2], sl);  await sleep(400);
    // 讀回來確認停利真的是我們填的價，不是被 ticks 模式吃掉變成別的數字
    var back = levelInputs().slice(-3);
    if (!back.length || Math.abs(parseFloat(back[1].value) - parseFloat(tp)) > Math.abs(tp) * 1e-6) {
      return '停利填不進去（欄位顯示 ' + (back[1] ? back[1].value : '?') + '，預期 ' + tp + '）';
    }
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
  // 面板上的價格有兩種樣貌：收合層寫在文字裡（2,631.62 帶逗號），展開層在
  // input 裡且補到商品精度（0.1598 → 0.15980）。字串比對兩邊都會失手，
  // 所以一律抓出所有數字再用數值比對。
  function panelNumbers() {
    var pnl = levelsPanel();
    if (!pnl) return [];
    var nums = [];
    panelLines().join(' ').split(',').join('').split(' ').forEach(function(tok){
      var n = parseFloat(tok);
      if (isFinite(n)) nums.push(n);
    });
    levelInputs().forEach(function(i){
      var n = parseFloat(String(i.value).split(',').join(''));
      if (isFinite(n)) nums.push(n);
    });
    return nums;
  }
  function levelShown(v) {
    var target = parseFloat(v);
    if (!isFinite(target)) return false;
    var tol = Math.max(1e-9, Math.abs(target) * 1e-6);
    return panelNumbers().some(function(n){ return Math.abs(n - target) <= tol; });
  }
  function panelDigest() {
    return panelLines().join(' ').slice(0, 160);
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

/**
 * 確保底部的模擬交易面板是開著且展開的。
 *
 * TradingView 重啟後面板不會自動展開，而帳戶、掛單、持倉全都只能從那裡讀 ——
 * 不先確保它開著，監控器會每筆都卡在「讀不到帳戶」。收合狀態用
 * toggle-maximize-button 展開；完全沒接經紀商時才需要走「交易 → Paper Trading」。
 */
export async function ensureTradingPanel() {
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    function hasAccountTabs() {
      return Array.prototype.slice.call(document.querySelectorAll('button')).some(function(b){
        return b.offsetParent !== null && (b.textContent || '').trim().indexOf('持倉') === 0;
      });
    }
    if (hasAccountTabs()) return { ok: true, action: 'already-open' };

    var steps = [];
    // 1) 面板只是被收合
    for (var i = 0; i < 2 && !hasAccountTabs(); i++) {
      var btn = document.querySelector('[data-name="toggle-maximize-button"]');
      if (!btn) break;
      btn.click();
      steps.push('展開面板');
      await sleep(1800);
    }
    if (hasAccountTabs()) return { ok: true, action: steps.join('→') };

    // 2) 面板整個沒開：點頂部的「交易」
    var trade = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]')).filter(function(b){
      return b.offsetParent !== null && (b.textContent || '').trim() === '交易';
    })[0];
    if (trade) { trade.click(); steps.push('點交易'); await sleep(2500); }
    if (hasAccountTabs()) return { ok: true, action: steps.join('→') };

    // 3) 跳出經紀商選單時選 Paper Trading
    var card = Array.prototype.slice.call(document.querySelectorAll('div')).filter(function(e){
      return e.offsetParent !== null && /Paper Trading/i.test(e.textContent || '') && (e.textContent || '').length < 60;
    })[0];
    if (card) {
      var r = card.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(k){
        card.dispatchEvent(new MouseEvent(k, { bubbles:true, cancelable:true, view:window,
          clientX: r.left + r.width/2, clientY: r.top + r.height/2 }));
      });
      steps.push('選 Paper Trading');
      await sleep(3000);
    }
    return { ok: hasAccountTabs(), action: steps.join('→') || '沒有可用的開啟方式' };
  })()`);
}

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
    // 不要用「停利, 」這種帶逗號的樣式去認按鈕：TradingView 改版後逗號就不見了
    // （2026-10-17 重啟後從「停利, 價格」變成「停利 價格」，整條下單路徑因此
    // 全面失效）。改用結構性特徵：分頁的文字正好等於「停損」，模式鈕則是
    // 「停損」後面還接著模式名稱。
    function exitModeBtn(prefix) {
      var tk = ticket();
      var b = Array.prototype.slice.call(tk.querySelectorAll('button')).filter(function(x){
        if (x.getAttribute('role') === 'tab') return false;
        var s = (x.textContent || '').trim();
        return s.indexOf(prefix) === 0 && s.length > prefix.length && s.length <= 14;
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
    if (p.exits && p.exits.length >= 2) {
      // N 層通用（v3 起停利有四段）：先加「最後一批」把面板叫出來，刪掉訂單
      // 視窗繼承的全額層，再由後往前把其餘各批補上。順序由後往前是因為新增
      // 的層一律加在最後面，這樣收尾時第一批才會排在最前面。
      if (!clickAddLevel(ticket())) return fail('levels', '找不到「新增水平」');
      await sleep(900);
      if (!levelsPanel()) return fail('levels', '出場水平面板沒開啟');

      var last = p.exits[p.exits.length - 1];
      var errLast = await setExpandedLevel(last.qty, last.tp, p.stopPrice);
      if (errLast) return fail('levels', '最後一批設定失敗：' + errLast);
      log.push('水平：第 ' + p.exits.length + ' 批 ' + last.qty + ' @ ' + last.tp);

      // 刪掉繼承來的全額層，否則保護倉位大小會爆表
      if (!deleteFullSizeLevel()) return fail('levels', '刪不掉繼承的全額水平');
      await sleep(700);

      for (var li = p.exits.length - 2; li >= 0; li--) {
        if (!clickAddLevel(levelsPanel())) return fail('levels', '第 ' + (li + 1) + ' 批新增水平失敗');
        await sleep(900);
        var ei = p.exits[li];
        var erri = await setExpandedLevel(ei.qty, ei.tp, p.stopPrice);
        if (erri) return fail('levels', '第 ' + (li + 1) + ' 批設定失敗：' + erri);
        log.push('水平：第 ' + (li + 1) + ' 批 ' + ei.qty + ' @ ' + ei.tp);
      }

      // 兩層加起來必須剛好蓋住整個部位，少了等於有一半沒出場計畫
      var pct = protectionPct();
      if (!(Math.abs(pct - 100) < 1)) return fail('levels', '保護倉位大小是 ' + pct + '%，不是 100%');
      // 收合的水平把價格寫在文字裡（帶千分位逗號），展開中的那層在 input 裡，
      // 而且會被補成該商品的價格精度（0.1598 → 0.15980）。字串比對兩種格式
      // 都會踩雷，一律改成「抓出所有數字，用數值比」。
      for (var vi = 0; vi < p.exits.length; vi++) {
        if (!levelShown(p.exits[vi].tp)) {
          return fail('levels', '面板裡看不到第 ' + (vi + 1) + ' 批停利 ' + p.exits[vi].tp + '：' + panelDigest());
        }
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
    if (!levelShown(p.tp1)) return fail('levels', '面板看不到第一批停利 ' + p.tp1 + '：' + panelDigest());
    if (!levelShown(p.tp2)) return fail('levels', '面板看不到第二批停利 ' + p.tp2 + '：' + panelDigest());
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
      // 一定要逐一讀 <td>，不能把整列的 innerText 切開再濾掉空字串：沒設停利
      // 的部位，停利那一格是空的，濾掉之後後面每一欄都左移一格 —— 最新價會
      // 讀成未實現損益。SKYAI（0.034 的幣）因此被當成 89.56，停損階梯算出
      // 10R、要把停損拉到市價之上，等於一掛上去就市價平倉。
      // （2026-10-25 發現，只因為出場水平面板打不開才沒真的執行。）
      var tds = Array.prototype.slice.call(e.children);
      var cells = tds.map(function(td){
        return (td.innerText || '').split(String.fromCharCode(10)).join(' ').trim();
      });
      // 欄位順序固定：[0]商品 [1]方向 [2]數量 [3]均價 [4]停利 [5]停損 [6]最新價 [7]未實現
      // 停利/停損在多層出場時顯示成「2個水平」，沒設定時是空字串。
      // 負數用的是 U+2212 MINUS SIGN（−）不是 ASCII 的 -，parseFloat 吃不下，
      // 所有虧損的未實現損益都會變成 null。千分位逗號也要先拿掉。
      var num = function(s){
        var v = parseFloat(String(s).replace(/,/g, '').replace(/−/g, '-'));
        return isFinite(v) ? v : null;
      };
      var lv = function(s){
        if (!s) return 0;                                    // 空＝這一側沒有出場計畫
        return s.indexOf('個水平') >= 0 ? parseInt(s, 10) : 1;
      };
      return {
        symbol: cells.filter(function(c){ return c.indexOf(':') >= 0; })[0] || null,
        side: cells.filter(function(c){ return c === '做多' || c === '做空'; })[0] || null,
        qty: num(cells[2]),
        avg: num(cells[3]),
        last: num(cells[6]),
        upnl: num(cells[7]),
        levels: lv(cells[4]),          // 停利側的層數；0 代表完全沒設停利
        stopLevels: lv(cells[5]),
        cells: cells.slice(0, 10)
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
  // 一定要循序：listOrders 會點「訂單」分頁、listPositions 會點「持倉」分頁，
  // 兩者共用同一個畫面。用 Promise.all 併發的話誰後點誰贏，另一個會讀到空的，
  // 未結清單就會缺一半 —— 2026-10-17 WIF/PHA/ZAMA 被重複下單就是這樣來的。
  const orders = await listOrders();
  const positions = await listPositions();
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

/**
 * 用新的停損價重建一個部位的出場水平（停利價與各批數量維持不變）。
 *
 * 收合的水平在 UI 上點不開 —— TradingView 只提供新增與刪除，沒有就地編輯。
 * 所以移動停損只能「全部刪掉再照原樣加回來」，差別只在停損價。
 *
 * levels: [{ tp }] 由呼叫端提供（順序＝水平順序），數量一律均分。
 */
export async function rebuildPositionExits({ symbol, levels, stopPrice, posQty = null }) {
  // 部位數量由呼叫端傳進來最可靠：部位編輯器的面板容器裡沒有數量標題
  // （訂單視窗的有，所以同一段讀法在那邊可以、在這邊不行）。
  const payload = JSON.stringify({ symbol, levels, stopPrice, posQty });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_EXIT_LEVELS}
    var p = ${payload};
    var log = [];
    // 失敗時一定要按「捨棄」：這個流程中途會把原本的水平全部刪掉，面板就這樣
    // 留著的話，畫面上是一個沒有出場計畫的半成品，還會擋住之後的所有操作。
    // 捨棄不會動到真正的部位（沒按確認就不生效）。
    function fail(step, detail) {
      try {
        var d = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
          return b.offsetParent !== null && (b.textContent || '').trim() === '捨棄';
        })[0];
        if (d) d.click();
      } catch (e) { /* 收不掉就算了，至少把錯誤回報出去 */ }
      return { ok: false, step: step, detail: detail, log: log };
    }

    // 先清場：上一次失敗可能留著下單視窗或編輯面板，不收掉會點錯東西
    for (var c = 0; c < 3; c++) {
      var leftover = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
        return b.offsetParent !== null && (b.textContent || '').trim() === '捨棄';
      })[0];
      if (!leftover) break;
      leftover.click();
      await sleep(600);
    }
    if (ticket()) { await closeTicketInPage(); }

    // 切到持倉分頁，而且要確認真的切過去了（訂單分頁也有 ✏，點錯會開成改單）
    function positionRows() {
      var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
        var t = e.innerText || '';
        return e.offsetParent !== null && t.length < 400 && /做多|做空/.test(t)
          && e.querySelector('[data-name="edit-settings-cell-button"]');
      });
      return els.filter(function(e){ return !els.some(function(o){ return o !== e && e.contains(o); }); });
    }
    var tab = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
      return b.offsetParent !== null && (b.textContent || '').trim().indexOf('持倉') === 0;
    })[0];
    if (!tab) return fail('tab', '找不到持倉分頁');
    tab.click();
    for (var w = 0; w < 20 && !positionRows().length; w++) await sleep(150);
    if (!positionRows().length) return fail('tab', '切到持倉後讀不到任何部位列');

    var rows = positionRows().filter(function(e){ return (e.innerText || '').indexOf(p.symbol) >= 0; });
    if (!rows.length) return fail('row', '持倉裡找不到 ' + p.symbol);
    rows[0].querySelector('[data-name="edit-settings-cell-button"]').click();
    // 面板出現的時間會隨部位數與負載變動，用輪詢不要寫死
    for (var w2 = 0; w2 < 30 && !levelsPanel(); w2++) await sleep(150);

    // 部位只有 1 層（或沒有停利）時，TradingView 開的是「簡易出場表單」——
    // 只有停利／停損兩格，沒有「新增水平」也沒有「保護倉位大小」，levelsPanel()
    // 自然找不到。SKYAI 的 10 筆 stop-move-failed 全是卡在這裡。
    // 要先把停利打開（停利欄旁邊那個無標籤的 icon 鈕），「新增水平」才會出現；
    // 按一次新增水平之後才切到多層畫面，下面整套流程才有東西可操作。
    var cameFromSimple = false;
    if (!levelsPanel()) {
      var simple = simpleExitForm();
      if (!simple) return fail('panel', '出場水平面板沒開啟，也找不到簡易出場表單');

      // 1) 打開停利（停利欄旁邊那顆無標籤的 icon 鈕，第一顆是停利側）
      var icons = Array.prototype.slice.call(simple.querySelectorAll('button')).filter(function(b){
        return b.offsetParent !== null && /iconButton/.test(String(b.className || ''));
      });
      if (!icons.length) return fail('panel', '簡易表單裡找不到啟用停利的按鈕');
      icons[0].click();
      await sleep(1200);

      // 2) 切成價格模式，並填一個有效的停利價（第一段目標）。
      //    打開停利時帶進來的預設值是舊的、低於市價，面板會卡在
      //    「停利必須高於當前bid」，那個錯誤狀態下「新增水平」點了沒反應。
      var modeErr = await forceSimplePriceMode('停利');
      if (modeErr) return fail('panel', modeErr);
      var sIns = Array.prototype.slice.call(simpleExitForm().querySelectorAll('input'))
        .filter(function(i){ return i.type !== 'checkbox'; });
      if (!sIns.length) return fail('panel', '簡易表單裡找不到停利輸入欄');
      setInput(sIns[0], p.levels[0].tp);
      await sleep(900);

      // 3) 這時才點得動「新增水平」，點完就切到多層畫面
      for (var w3 = 0; w3 < 20 && !findAddLevel(); w3++) await sleep(150);
      if (!findAddLevel()) return fail('panel', '啟用停利後仍沒出現「新增水平」');
      clickLike(findAddLevel());
      for (var w4 = 0; w4 < 40 && !levelsPanel(); w4++) await sleep(150);
      cameFromSimple = true;
      log.push('由簡易表單切換到多層畫面（停利先設為 ' + p.levels[0].tp + '）');
    }
    if (!levelsPanel()) return fail('panel', '出場水平面板沒開啟（等了 4.5 秒）');

    // 部位數量（決定每批數量，必須落在商品的數量步長上）
    var qtyToken = null;
    if (p.posQty != null) {
      qtyToken = String(p.posQty);
    } else {
      var lines = panelLines();
      var qtyLine = lines.filter(function(s){ return s.indexOf('多單') === 0 || s.indexOf('空單') === 0
        || s.indexOf('買進') === 0 || s.indexOf('賣出') === 0; })[0] || '';
      qtyToken = qtyLine.split(' ').filter(function(s){ return s && !isNaN(parseFloat(s.replace(/,/g, ''))); })[0];
    }
    if (!qtyToken) return fail('qty', '讀不到部位數量（呼叫端也沒提供 posQty）');
    var posQty = parseFloat(String(qtyToken).replace(/,/g, ''));
    var decimals = (String(qtyToken).split('.')[1] || '').length;
    // 小數位要跟部位數量一樣，不能多給一位：多的那位讓數量落在商品步長之外，
    // 欄位會悄悄退回預設值（不是報錯），四層就各自變成 12.5% 而不是 25%，
    // 保護倉位大小停在 50%。32032.032 ÷ 4 要寫成 8008.008，不是 8008.0080。
    var each = (posQty / p.levels.length).toFixed(decimals);
    log.push('部位 ' + posQty + ' → 每批 ' + each);

    // 收合的水平改不動，只能重建；但「先刪光再加」行不通 —— 刪到最後一層時
    // 面板會退回基本編輯器（沒有「保護倉位大小」），levelsPanel() 變成 null。
    // 所以改成「先加新的、再刪舊的」：中間會短暫顯示 200%，但沒按確認就不生效。
    function levelRows() {
      var pnl = levelsPanel();
      if (!pnl) return [];
      var rows = Array.prototype.slice.call(pnl.querySelectorAll('*')).filter(function(e){
        if (e.offsetParent === null) return false;
        var t = e.innerText || '';
        return t.length < 300 && t.indexOf('水平') === 0 && t.indexOf('TP ') >= 0;
      });
      // 只留最內層那些列，並照畫面順序排（舊的在前、新加的在後）
      return rows.filter(function(e){ return !rows.some(function(o){ return o !== e && e.contains(o); }); });
    }
    function deleteRow(row) {
      var btns = Array.prototype.slice.call(row.querySelectorAll('button, [role="button"]'))
        .filter(function(b){ return b.offsetParent !== null; });
      if (!btns.length) return false;
      var del = btns[btns.length - 1], rc = del.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(k){
        del.dispatchEvent(new MouseEvent(k, { bubbles:true, cancelable:true, view:window,
          clientX: rc.left + rc.width/2, clientY: rc.top + rc.height/2 }));
      });
      return true;
    }
    var origCount = levelRows().length;
    log.push('原有水平 ' + origCount + ' 層');

    // 從部位編輯器進來時，前置那次「新增水平」把原本的全額層切成
    // 99.99% + 0.01%。保護倉位大小一旦到 150%，面板就不再讓你新增 ——
    // 第 3、4 次點「新增水平」完全沒反應，setExpandedLevel 只是反覆覆寫同一層，
    // 四段停利最後只剩頭尾兩段。所以這條路要先把全額層刪掉再加。
    // （訂單視窗那條路不能這樣做：那裡只有一層，刪完面板會退回基本編輯器。）
    if (cameFromSimple) {
      if (!deleteFullSizeLevel()) return fail('delete', '刪不掉繼承的全額水平（前置後）');
      await sleep(900);
      log.push('先刪掉全額層：保護 ' + protectionPct() + '%');
    }

    // 照原本的停利價加上新的層，只有停損換成新的。
    //
    // TradingView 每個部位最多 4 層，滿了之後「新增水平」就靜靜地沒反應 ——
    // 不報錯、也不新增，setExpandedLevel 於是反覆覆寫同一層，四段停利最後
    // 只剩頭尾。所以每加一層都要確認保護倉位大小真的變大了；沒變大就表示
    // 名額被舊的殘層（例如前置切出來的 0.01% 碎片）佔著，刪掉一層再試一次。
    // 判斷「真的新增了一層」要在寫值之前做：新增成功時，原本展開的那層會收合，
    // 收合列數因此 +1。等到寫完值才發現沒新增就來不及了 —— setExpandedLevel
    // 已經把上一層的停利覆蓋掉，那一段目標價就永遠消失了。
    for (var i = 0; i < p.levels.length; i++) {
      var added = false;
      for (var attempt = 0; attempt < 2 && !added; attempt++) {
        if (!levelsPanel()) return fail('add', '面板不見了（第 ' + (i + 1) + ' 層）');
        var rowsBefore = levelRows().length;
        if (!clickAddLevel(levelsPanel())) return fail('add', '第 ' + (i + 1) + ' 層新增失敗');
        await sleep(900);
        if (levelRows().length > rowsBefore) { added = true; break; }

        // 沒加進去＝名額滿了（上限 4 層）。刪掉最前面那層殘層空出名額再試一次。
        // 這時還沒寫任何值，所以重試不會弄丟前一層的停利。
        var stale = levelRows()[0];
        if (attempt === 0 && stale && deleteRow(stale)) {
          await sleep(900);
          log.push('第 ' + (i + 1) + ' 層名額滿了，刪一層殘層後重試');
          continue;
        }
        return fail('add', '第 ' + (i + 1) + ' 層加不進去（收合列數停在 ' + rowsBefore + '）');
      }
      var err = await setExpandedLevel(each, p.levels[i].tp, p.stopPrice);
      if (err) return fail('set', '第 ' + (i + 1) + ' 層設定失敗：' + err);
      log.push('水平' + (i + 1) + ' ' + each + ' @ TP ' + p.levels[i].tp + ' / SL ' + p.stopPrice);
    }

    log.push('加完新層：共 ' + levelRows().length + ' 層、保護 ' + protectionPct() + '%');

    // 新的加好了，把原本那幾層刪掉（它們固定排在前面）。
    //
    // 結束條件看「保護倉位大小」不看列數：levelRows() 只認得收合且帶 TP 的列，
    // 展開中的那層、以及只有停損沒有停利的層都數不到，拿列數當門檻會提早跳出
    // ——「原有 1 層、加 4 層、結果數到 3 層」就是這樣來的，一層都沒刪就離開，
    // 保護停在 150%。百分比是面板自己算的，不受列數偵測的死角影響。
    var deleted = 0;
    for (var d2 = 0; d2 < origCount + p.levels.length + 3; d2++) {
      var pctNow = protectionPct();
      if (!isFinite(pctNow) || pctNow <= 100 + 1) break;
      var rowsNow = levelRows();
      if (!rowsNow.length) break;
      if (!deleteRow(rowsNow[0])) return fail('delete', '刪不掉舊水平（保護 ' + pctNow + '%）');
      deleted++;
      await sleep(900);
    }
    log.push('刪除 ' + deleted + ' 層後：共 ' + levelRows().length + ' 層、保護 ' + protectionPct() + '%');

    var pct = protectionPct();
    if (!(Math.abs(pct - 100) < 1.5)) {
      // 帶上面板實際內容，不然只看到一個百分比根本不知道哪幾層出了事
      return fail('pct', '保護倉位大小 ' + pct + '%，不是 100%｜' + panelLines().join(' / ').slice(0, 500));
    }
    if (!levelShown(p.stopPrice)) return fail('verify', '面板看不到新停損 ' + p.stopPrice + '：' + panelDigest());
    for (var j = 0; j < p.levels.length; j++) {
      if (!levelShown(p.levels[j].tp)) return fail('verify', '面板看不到停利 ' + p.levels[j].tp);
    }
    log.push('保護倉位大小 ' + pct + '%');

    if (!clickLevelsConfirm()) return fail('confirm', '找不到水平面板的確認');
    await sleep(1500);

    // 部位編輯器是兩層的：水平面板一個「確認」、外層編輯器還有一個。
    // 只按內層的話面板會收起來、看起來像成功，但部位其實原封不動
    // （SKYAI 第一次跑出 ok:true 卻還是沒有停利就是這樣）。
    for (var cf = 0; cf < 3; cf++) {
      var outer = Array.prototype.slice.call(document.querySelectorAll('button,[role="button"]'))
        .filter(function(b){ return b.offsetParent !== null && (b.textContent||'').trim() === '確認'; })[0];
      if (!outer) break;
      clickLike(outer);
      await sleep(1200);
    }

    // 後端拒絕只會跳 toast，不讀就會把失敗當成功（數量步長不合法是常見原因）
    var toast = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
      var t = (e.innerText || '');
      return e.offsetParent !== null && t.length < 200 && /無法修改|步長|not a multiple/.test(t);
    }).map(function(e){ return (e.innerText || '').replace(/\\s+/g, ' ').trim(); })[0];
    if (toast) return fail('rejected', '後端拒絕：' + toast.slice(0, 120));

    // 讀回持倉列確認真的掛上去了 —— 面板看起來對不等於後端接受了
    var applied = null;
    for (var vr = 0; vr < 20 && applied === null; vr++) {
      var prow = positionRows().filter(function(e){ return (e.innerText||'').indexOf(p.symbol) >= 0; })[0];
      if (prow) {
        var tds = Array.prototype.slice.call(prow.children).map(function(td){
          return (td.innerText || '').split(String.fromCharCode(10)).join(' ').trim(); });
        if (tds[4]) applied = tds[4];
      }
      if (applied === null) await sleep(300);
    }
    if (applied === null) return fail('verify', '確認後持倉列的停利欄仍是空的');
    log.push('持倉列停利欄：' + applied);

    return { ok: true, log: log, posQty: posQty, each: each, applied: applied };
  })()`);
}

/**
 * 直接改部位的停利／停損（基本編輯器，不走「出場水平」）。
 *
 * 部位只剩一層出場時這條路簡單得多：把水平刪光，面板就會退回基本編輯器，
 * 上面是單純的停利/停損價格欄位。多層出場的加加刪刪太不穩 —— 實測刪完
 * 保護倉位大小會從 100% 跳到 200%，順序與重算時機都不受控。
 *
 * 移動停損時部位幾乎都只剩一層（第一批已經在 5R 出場了），所以這是主力路徑。
 */
export async function setPositionSimpleExits({ symbol, tp, stopPrice, posQty = null }) {
  const payload = JSON.stringify({ symbol, tp, stopPrice, posQty });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
    ${PAGE_EXIT_LEVELS}
    var p = ${payload};
    var log = [];
    function fail(step, detail) {
      try {
        var d = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
          return b.offsetParent !== null && (b.textContent || '').trim() === '捨棄';
        })[0];
        if (d) d.click();
      } catch (e) {}
      return { ok: false, step: step, detail: detail, log: log };
    }

    // 清場 + 切到持倉分頁
    for (var c = 0; c < 3; c++) {
      var leftover = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
        return b.offsetParent !== null && (b.textContent || '').trim() === '捨棄';
      })[0];
      if (!leftover) break;
      leftover.click();
      await sleep(600);
    }
    if (ticket()) await closeTicketInPage();

    function positionRows() {
      var els = Array.prototype.slice.call(document.querySelectorAll('div, tr')).filter(function(e){
        var t = e.innerText || '';
        return e.offsetParent !== null && t.length < 400 && /做多|做空/.test(t)
          && e.querySelector('[data-name="edit-settings-cell-button"]');
      });
      return els.filter(function(e){ return !els.some(function(o){ return o !== e && e.contains(o); }); });
    }
    var tab = Array.prototype.slice.call(document.querySelectorAll('button')).filter(function(b){
      return b.offsetParent !== null && (b.textContent || '').trim().indexOf('持倉') === 0;
    })[0];
    if (!tab) return fail('tab', '找不到持倉分頁');
    tab.click();
    for (var w = 0; w < 20 && !positionRows().length; w++) await sleep(150);
    var rows = positionRows().filter(function(e){ return (e.innerText || '').indexOf(p.symbol) >= 0; });
    if (!rows.length) return fail('row', '持倉裡找不到 ' + p.symbol);
    rows[0].querySelector('[data-name="edit-settings-cell-button"]').click();
    await sleep(1500);

    // 把現有水平全部刪掉，讓面板退回基本編輯器
    for (var g = 0; g < 6; g++) {
      var pnl = levelsPanel();
      if (!pnl) break;                       // 已經是基本編輯器
      var rowsNow = Array.prototype.slice.call(pnl.querySelectorAll('*')).filter(function(e){
        if (e.offsetParent === null) return false;
        var t = e.innerText || '';
        return t.length < 300 && t.indexOf('水平') === 0 && t.indexOf('TP ') >= 0;
      });
      rowsNow = rowsNow.filter(function(e){ return !rowsNow.some(function(o){ return o !== e && e.contains(o); }); });
      if (!rowsNow.length) break;
      var btns = Array.prototype.slice.call(rowsNow[0].querySelectorAll('button, [role="button"]'))
        .filter(function(b){ return b.offsetParent !== null; });
      if (!btns.length) return fail('delete', '水平列裡沒有刪除鈕');
      var del = btns[btns.length - 1], rc = del.getBoundingClientRect();
      ['mousedown','mouseup','click'].forEach(function(k){
        del.dispatchEvent(new MouseEvent(k, { bubbles:true, cancelable:true, view:window,
          clientX: rc.left + rc.width/2, clientY: rc.top + rc.height/2 }));
      });
      await sleep(800);
    }
    log.push('已清掉出場水平，回到基本編輯器');

    // 基本編輯器的容器：用文字找會抓到「退出」那兩個字的標籤本身（len=2），
    // 改成從「確認」鈕往上爬，取第一個同時含欄位的祖先。
    function editor() {
      var ok = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]')).filter(function(b){
        return b.offsetParent !== null && /^(確認|修改|套用)$/.test((b.textContent || '').trim());
      })[0];
      if (!ok) return null;
      for (var el = ok.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
        var ins = Array.prototype.slice.call(el.querySelectorAll('input'))
          .filter(function(x){ return x.offsetParent !== null && x.type !== 'checkbox'; });
        if (ins.length >= 2) return el;
      }
      return null;
    }
    var ed = null;
    for (var w2 = 0; w2 < 20 && !(ed = editor()); w2++) await sleep(200);
    if (!ed) return fail('editor', '基本編輯器沒出現');

    // 兩個開關要打開（停利、停損），模式確保是價格
    var checks = Array.prototype.slice.call(ed.querySelectorAll('input[type="checkbox"]'));
    for (var k = 0; k < checks.length; k++) {
      if (!checks[k].checked) { checks[k].click(); await sleep(400); }
    }
    function modeBtn(prefix) {
      var e2 = editor();
      if (!e2) return null;
      var b = Array.prototype.slice.call(e2.querySelectorAll('button')).filter(function(x){
        if (x.getAttribute('role') === 'tab') return false;
        var s = (x.textContent || '').trim();
        return s.indexOf(prefix) === 0 && s.length > prefix.length && s.length <= 14;
      })[0];
      return b ? { btn: b, text: (b.textContent||'').trim() } : null;
    }
    async function forcePrice(prefix) {
      var m = modeBtn(prefix);
      if (!m) return '找不到「' + prefix + '」模式鈕';
      if (/價格/.test(m.text)) return null;
      m.btn.click();
      await sleep(300);
      var e3 = editor();
      var opts = Array.prototype.slice.call(document.querySelectorAll('div, span, li, button')).filter(function(x){
        return x.offsetParent !== null && (x.textContent || '').trim() === '價格'
          && x.children.length === 0 && (!e3 || !e3.contains(x));
      });
      if (!opts.length) return '「' + prefix + '」找不到價格選項';
      opts[0].click();
      await sleep(300);
      var after = modeBtn(prefix);
      return (after && /價格/.test(after.text)) ? null : '「' + prefix + '」切不到價格模式';
    }
    var e1 = await forcePrice('停利'); if (e1) return fail('tpMode', e1);
    var e2b = await forcePrice('停損'); if (e2b) return fail('slMode', e2b);

    var ins = Array.prototype.slice.call(editor().querySelectorAll('input'))
      .filter(function(i){ return i.type !== 'checkbox'; });
    if (ins.length < 2) return fail('fields', '基本編輯器只有 ' + ins.length + ' 個欄位');
    setInput(ins[0], p.tp);        await sleep(400);
    setInput(ins[1], p.stopPrice); await sleep(500);
    log.push('停利 ' + p.tp + '、停損 ' + p.stopPrice);

    var vals = Array.prototype.slice.call(editor().querySelectorAll('input'))
      .filter(function(i){ return i.type !== 'checkbox'; }).map(function(i){ return parseFloat(String(i.value).split(',').join('')); });
    var near = function(a, b){ return isFinite(a) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-5); };
    if (!vals.some(function(v){ return near(v, p.stopPrice); })) {
      return fail('verify', '停損欄位沒吃進去：' + JSON.stringify(vals));
    }

    var apply = Array.prototype.slice.call(document.querySelectorAll('button, [role="button"]'))
      .filter(function(b){ return b.offsetParent !== null && /^(確認|修改|套用)$/.test((b.textContent||'').trim()); })[0];
    if (!apply) return fail('confirm', '找不到確認鈕');
    apply.click();
    await sleep(1500);

    var toast = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(e){
      var t = (e.innerText || '');
      return e.offsetParent !== null && t.length < 200 && /無法修改|步長|not a multiple/.test(t);
    }).map(function(e){ return (e.innerText || '').replace(/\\s+/g, ' ').trim(); })[0];
    if (toast) return fail('rejected', '後端拒絕：' + toast.slice(0, 120));

    return { ok: true, log: log };
  })()`);
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
export async function cancelOrders({ symbol = null, orderIds = null } = {}) {
  const payload = JSON.stringify({ symbol, orderIds });
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
        var txt = e.innerText || '';
        if (bare && txt.indexOf(bare) < 0) return false;
        // 指定 orderIds 時只動這幾張：同一個商品可能同時有該保留的部位出場單
        // 和該取消的掛單，整批砍會把部位的停損一起砍掉。
        if (p.orderIds && p.orderIds.length) {
          return p.orderIds.some(function(id){ return txt.indexOf(String(id)) >= 0; });
        }
        return true;
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
