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
export async function placeLimitBracket({ symbol, qty, limitPrice, stopPrice, tpPrice, dryRun = true }) {
  const payload = JSON.stringify({ symbol, qty, limitPrice, stopPrice, tpPrice, dryRun });
  return evaluateAsync(`(async function(){
    ${PAGE_HELPERS}
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
      return t.length < 300 && /:/.test(t) && /買入|賣出/.test(t) && /限價|停損|市價/.test(t)
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
    var tq = (cells.filter(function(c){ return /^(限價|停損|市價)\\t/.test(c); })[0] || '').split('\\t');
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
