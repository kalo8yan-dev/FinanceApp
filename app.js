/* FinanceApp – интерфейс. Логиката е във logic.js. */
(function () {
  'use strict';

  const L = FinanceLogic;
  const APP_VERSION = '1.0.0';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => Number(String(v == null ? '' : v).replace(',', '.')) || 0;
  const pad = (n) => String(n).padStart(2, '0');
  const val2 = (v) => L.money(v).toFixed(2);

  let S = L.emptyState();
  let deferredInstall = null;

  const today = new Date();
  const ui = {
    year: Math.max(today.getFullYear(), L.START_YEAR),
    month: today.getMonth() + 1,
    openingOpen: false,
    historyOpen: false,
    editingId: null,
    actualsOpen: false,
    recsFlash: [],
    tx: { type: '', source: L.CASH, destination: '', amount: '', description: '', date: '' },
    folder: { handle: null, state: 'none' }, // none | ok | needs-permission
    saveError: null,
  };

  // ---------- съхранение (IndexedDB) ----------
  let dbPromise = null;
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open('financeapp', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  async function kvGet(key) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  async function kvSet(key, value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  async function persist() {
    try {
      await kvSet('state', JSON.parse(JSON.stringify(S)));
      ui.saveError = null;
    } catch (e) {
      ui.saveError = 'Данните НЕ са записани: ' + (e && e.message ? e.message : e);
      toast(ui.saveError, 'err');
    }
  }

  async function commit() {
    S.meta.updated_at = new Date().toISOString();
    await persist();
    scheduleFolderBackup();
    render();
    if ($('#recsDlg').open) renderRecs();
  }

  // ---------- известия ----------
  let toastTimer = null;
  function toast(text, kind) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast show ' + (kind || 'ok');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'err' ? 6000 : 3000);
  }

  // ---------- избор на месец ----------
  function yearOptions() {
    const out = [];
    for (let y = L.START_YEAR; y <= Math.max(today.getFullYear(), L.START_YEAR); y++) out.push(y);
    return out;
  }
  function monthOptions(year) {
    const min = year === L.START_YEAR ? L.START_MONTH : 1;
    let max = year === today.getFullYear() ? Math.min(12, today.getMonth() + 2) : 12;
    max = Math.max(max, min);
    const out = [];
    for (let m = min; m <= max; m++) out.push(m);
    return out;
  }
  function clampMonth() {
    const opts = monthOptions(ui.year);
    if (!opts.includes(ui.month)) {
      ui.month = ui.year === today.getFullYear()
        ? Math.min(Math.max(today.getMonth() + 1, opts[0]), opts[opts.length - 1]) : opts[0];
    }
  }
  const curMonth = () => `${ui.year}-${pad(ui.month)}`;

  // ---------- изглед ----------
  function metric(label, value, delta) {
    const d = delta ? `<div class="delta ${delta.startsWith('-') ? 'neg' : 'pos'}">${esc(delta)}</div>` : '';
    return `<div class="metric"><div class="mlabel">${esc(label)}</div><div class="mvalue">${esc(value)}</div>${d}</div>`;
  }

  function numField(name, label, value, extra) {
    return `<label class="field">${esc(label)}
      <input type="number" name="${name}" min="0" step="0.01" inputmode="decimal" value="${esc(value)}" ${extra || ''}></label>`;
  }

  function accountSelect(name, value, exclude) {
    return `<select name="${name}">` + L.ACCOUNTS.filter((a) => a !== exclude)
      .map((a) => `<option ${a === value ? 'selected' : ''}>${esc(a)}</option>`).join('') + '</select>';
  }

  function typeDisplay(t) {
    if (t.type === L.TRANSFER) {
      return `Вътрешен превод<br><small>${esc(L.normalizeAccount(t.source) || '?')} → ${esc(L.normalizeAccount(t.destination) || '?')}</small>`;
    }
    return esc(t.type);
  }

  function historyHtml(st, month) {
    if (!st.all_transactions.length) return '<p class="muted">Няма записани транзакции за този месец.</p>';
    const [first, last] = L.monthBounds(month);

    return st.all_transactions.map((t) => {
      const cls = t.is_deleted ? 'deleted' : t.type === L.TRANSFER ? 'transfer' : t.type === L.EXPENSE ? 'expense' : 'income';
      const sign = t.amount >= 0 ? '+' : '';
      let editBox = '';

      if (ui.editingId === t.id && !t.is_deleted) {
        const f = { type: t.type, source: L.normalizeAccount(t.source) || L.CASH,
          destination: L.normalizeAccount(t.destination) || '' };
        const dest = L.ACCOUNTS.filter((a) => a !== f.source);
        if (!dest.includes(f.destination)) f.destination = dest[0];
        editBox = `<form class="editbox" data-form="tx-edit" data-id="${t.id}">
          <strong>Редактиране на транзакция №${t.id}</strong>
          <label class="field">Дата<input type="date" name="date" min="${first}" max="${last}" value="${t.date}" required></label>
          <label class="field">Тип движение<select name="type" data-edit-type="${t.id}">
            ${L.TYPES.map((x) => `<option ${x === t.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
          <div class="transfer-only" ${t.type === L.TRANSFER ? '' : 'hidden'}>
            <label class="field">От сметка ${accountSelect('source', f.source)}</label>
            <label class="field">Към сметка ${accountSelect('destination', f.destination)}</label>
          </div>
          ${numField('amount', 'Сума (€)', val2(Math.abs(t.amount)), 'required')}
          <label class="field">Описание<input type="text" name="description" value="${esc(t.description)}"></label>
          <div class="btnrow"><button class="btn primary" type="submit">Запази промените</button>
          <button class="btn" type="button" data-act="tx-cancel-edit">Отказ</button></div></form>`;
      }

      const actions = t.is_deleted
        ? `<span class="muted">Изтрита</span> <button class="icon" title="Възстанови" data-act="tx-restore" data-id="${t.id}">↩️</button>`
        : `<button class="icon" title="Редактирай" data-act="tx-edit" data-id="${t.id}">✏️</button>
           <button class="icon" title="Изтрий" data-act="tx-delete" data-id="${t.id}">🗑️</button>`;

      return `<div class="txrow ${cls}">
        <div class="txmain">
          <div class="txid">№${t.id}</div>
          <div class="txdate">${L.fmtDate(t.date)}</div>
          <div class="txtype">${typeDisplay(t)}</div>
          <div class="txdesc">${esc(t.description || '—')}</div>
          <div class="txamount">${sign}${t.amount.toFixed(2)}</div>
          <div class="txact">${actions}</div>
        </div>${editBox}</div>`;
    }).join('');
  }

  function exportReminder() {
    const hasData = Object.keys(S.balances).length || S.transactions.length;
    if (!hasData || ui.folder.state === 'ok') return '';
    const last = S.meta.last_export ? new Date(S.meta.last_export) : null;
    const days = last ? (Date.now() - last.getTime()) / 86400000 : Infinity;
    if (days < 7) return '';
    const when = last ? `Последното копие е отпреди ${Math.floor(days)} дни.` : 'Още не си правил копие на данните.';
    return `<div class="banner warn">⚠️ ${when} Данните са само на това устройство.
      <button class="btn small" data-act="export">Свали копие</button></div>`;
  }

  function render() {
    clampMonth();
    const month = curMonth();
    let plan = null, planErr = null;

    try { plan = L.monthlyPlan(S, month); } catch (e) { planErr = e.message; }
    if (plan && L.syncRecommendations(S, month, plan.recommendations)) persist();

    const recs = L.monthRecommendations(S, month);
    const pending = recs.filter((r) => r.status === L.ST.PROPOSED);
    const st = L.computeMonthState(S, month);
    const b = st.balance;
    const o = b || { spending: 0, trading_total: 0, trading_cash: 0, investments: 0, monthly_savings: 0 };
    const change = st.balances.spending - (b ? b.spending : 0);
    const lastTx = L.lastTransactionTime(S, month);
    const [first, last] = L.monthBounds(month);
    const tx = ui.tx;
    if (!tx.date || L.monthOf(tx.date) !== month) tx.date = L.defaultDateForMonth(month);
    const destOptions = L.ACCOUNTS.filter((a) => a !== tx.source);
    if (!destOptions.includes(tx.destination)) tx.destination = destOptions[0];

    const net = st.balances.income + st.balances.expenses;
    const netCls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';

    let minCap = '—';
    try { minCap = L.fmt(L.minimumTradingCapital(S, month)); } catch (e) { /* показва се грешката по-долу */ }

    $('#app').innerHTML = `
      <header class="top">
        <img src="favicon.png" alt="" width="36" height="36"><h1>FinanceApp</h1>
        <button class="icon big" data-act="settings" title="Настройки и копия">⚙️</button>
      </header>
      ${ui.saveError ? `<div class="banner err">${esc(ui.saveError)}</div>` : ''}
      ${exportReminder()}
      <div class="selectors">
        <label class="field">Месец <select id="selMonth">${monthOptions(ui.year).map((m) =>
          `<option value="${m}" ${m === ui.month ? 'selected' : ''}>${L.MONTHS[m - 1]}</option>`).join('')}</select></label>
        <label class="field">Година <select id="selYear">${yearOptions().map((y) =>
          `<option ${y === ui.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      </div>

      <div class="rowtop">
        <details id="openingDetails" ${ui.openingOpen ? 'open' : ''}>
          <summary>Начални баланси</summary>
          <p class="muted">Въведи наличностите си в началото на ${L.monthLabel(month)} и сумата, която е останала от месеца и се заделя като спестявания.</p>
          <form data-form="opening">
            ${numField('spending', 'За ползване (€)', val2(o.spending))}
            ${numField('trading_total', 'Трейдинг: обща стойност (€)', val2(o.trading_total))}
            ${numField('trading_cash', 'Трейдинг: свободни средства (€)', val2(o.trading_cash))}
            ${numField('investments', 'Инвестиции: обща стойност (€)', val2(o.investments))}
            ${numField('monthly_savings', 'Останали пари от месеца (€)', val2(o.monthly_savings))}
            <button class="btn primary" type="submit">Запази началните баланси</button>
          </form>
          <p class="muted">Минимален трейдинг капитал (изчислява се автоматично): ${esc(minCap)}</p>
        </details>
        <button class="btn recsbtn" data-act="recs">📋 Препоръки${pending.length ? ` (${pending.length})` : ''}</button>
      </div>
      ${planErr ? `<div class="banner err">${esc(planErr)}</div>` : ''}

      <hr><h2>Баланс за месец ${L.monthLabel(month)}</h2>
      ${b ? '' : '<div class="banner info">За този месец още няма начални баланси. Отвори „Начални баланси“ и ги въведи.</div>'}
      <div class="metrics">
        ${metric('За ползване', L.fmt(st.balances.spending), Math.abs(change) >= 0.005 ? (change >= 0 ? '+' : '') + change.toFixed(2) : '')}
        ${metric('Трейдинг: общо', L.fmt(st.balances.trading_total))}
        ${metric('Инвестиции: общо', L.fmt(st.balances.investments))}
        ${metric('Спестявания: общо', L.fmt(st.savings_total))}
      </div>
      ${b ? `<p class="muted">🕒 ${lastTx ? 'Последно обновено: ' + lastTx : 'Още няма въведени транзакции за този месец.'}</p>` : ''}

      <hr><h2>Ежедневни транзакции</h2>
      <form id="txForm" data-form="tx-new">
        <label class="field">Дата<input type="date" name="date" min="${first}" max="${last}" value="${tx.date}" required></label>
        <label class="field">Тип движение<select name="type">
          <option value="" ${tx.type ? '' : 'selected'}>Избери тип движение</option>
          ${L.TYPES.map((x) => `<option ${x === tx.type ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        ${tx.type === L.TRANSFER ? `
          <label class="field">От сметка ${accountSelect('source', tx.source)}</label>
          <label class="field">Към сметка ${accountSelect('destination', tx.destination, tx.source)}</label>` : ''}
        ${numField('amount', 'Сума (€)', tx.amount)}
        <label class="field">Описание*<input type="text" name="description" placeholder="Например: кафе или превод към инвестиции" value="${esc(tx.description)}"></label>
        <button class="btn primary" type="submit">Запази транзакцията</button>
      </form>

      <hr>
      <details id="historyDetails" ${ui.historyOpen ? 'open' : ''}>
        <summary>История на транзакциите</summary>
        ${historyHtml(st, month)}
      </details>

      <div class="metrics three">
        ${metric('Общо приходи', L.fmt(st.balances.income))}
        ${metric('Общо разходи', L.fmt(Math.abs(st.balances.expenses)))}
        <div class="metric"><div class="mlabel">Общо</div><div class="mvalue ${netCls}">€${net >= 0 ? '+' : ''}${net.toFixed(2)}</div></div>
      </div>
      <p class="muted foot">FinanceApp ${APP_VERSION}</p>`;

    // автоматично отваряне при нови непрегледани препоръки
    const sig = month + '|' + pending.map((r) => r.id).join(',');
    if (pending.length && sessionStorage.getItem('recsSig') !== sig && !$('#recsDlg').open) {
      sessionStorage.setItem('recsSig', sig);
      openRecs();
    }
  }

  // ---------- прозорец „Препоръки“ ----------
  function recLine(r) {
    return `${esc(r.source)} → ${esc(r.destination)} | ${L.fmt(r.amount)} | ${esc(r.reason)}`;
  }

  function actualsFormHtml(month) {
    const cur = L.computeMonthState(S, month);
    const when = L.actualsUpdatedAt(S, month);
    return `
      ${when ? `<div class="banner warn">✅ Вече обновено на ${when}. Ако запишеш отново, новите суми ще заменят въведените преди.</div>` : ''}
      <strong>Нови месечни суми (след разпределението)</strong>
      <p class="muted">Въведи реалните суми, които имаш сега, след като си направил разпределението. Те стават текущите баланси за месеца.</p>
      <form data-form="actuals">
        ${numField('spending', 'За ползване (€)', val2(Math.max(0, cur.balances.spending)))}
        ${numField('trading_total', 'Трейдинг: обща стойност (€)', val2(Math.max(0, cur.balances.trading_total)))}
        ${numField('trading_cash', 'Трейдинг: свободни средства (€)', val2(Math.max(0, cur.balances.trading_cash)))}
        ${numField('investments', 'Инвестиции: обща стойност (€)', val2(Math.max(0, cur.balances.investments)))}
        ${numField('savings', 'Спестявания: общо (€)', val2(Math.max(0, cur.savings_total)))}
        <div class="btnrow"><button class="btn primary" type="submit">Запази новите суми</button>
        <button class="btn" type="button" data-act="actuals-back">Назад към препоръките</button></div>
      </form>`;
  }

  function renderRecs() {
    const month = curMonth();
    const flash = ui.recsFlash; ui.recsFlash = [];
    let html = '<h2>Месечни препоръки</h2><h3>' + L.monthLabel(month) + '</h3>' +
      flash.map((f) => `<div class="banner ${f[0] === 'success' ? 'ok' : 'err'}">${esc(f[1])}</div>`).join('');

    let plan = null;
    try { plan = L.monthlyPlan(S, month); }
    catch (e) { $('#recsBody').innerHTML = html + `<div class="banner err">${esc(e.message)}</div>`; return; }

    if (!plan) {
      $('#recsBody').innerHTML = html + '<div class="banner info">За този месец още няма въведени начални баланси. Въведи ги в секцията „Начални баланси“.</div>';
      return;
    }
    if (ui.actualsOpen) { $('#recsBody').innerHTML = html + actualsFormHtml(month); return; }

    const sv = plan.savings, tr = plan.trading;
    const recs = L.monthRecommendations(S, month);
    const current = {}; plan.recommendations.forEach((r) => { current[r.key] = r; });

    html += `<strong>Спестявания</strong>
      <p>Спестявания преди трансфери: ${L.fmt(sv.total)}</p>
      <p class="muted">${sv.threshold_reached ? 'Прагът от €200 е достигнат: препоръчват се 50% към „Инвестиции“.' : 'Под €200 – не се препоръчва трансфер по това правило.'}</p>
      <strong>Трейдинг</strong>
      <div class="metrics four">
        ${metric('Активен капитал', L.fmt(tr.active_capital))}
        ${metric('Минимален капитал', L.fmt(tr.minimum_capital))}
        ${metric('Подсигуряване', L.fmt(tr.capital_needed))}
        ${metric('Свободни след него', L.fmt(tr.free_after_protection))}
      </div>
      ${tr.allowed
        ? `<div class="banner ok">Разпределението е разрешено. Върху ${L.fmt(tr.distributable)}: ${L.fmt(tr.retained)} (30%) остават в трейдинг, ${L.fmt(tr.to_current_cash)} (20%) към текуща наличност, ${L.fmt(tr.to_investments)} (50%) към инвестиции.</div>`
        : `<div class="banner warn">Разпределение от трейдинг не е разрешено. ${esc(tr.reason)}</div>`}
      <hr>`;

    const active = recs.filter((r) => r.status !== L.ST.OBSOLETE);
    if (!active.length) html += '<div class="banner info">Няма активни предложения за този месец.</div>';

    for (const r of recs) {
      if (r.status === L.ST.PROPOSED) {
        html += `<label class="rec"><input type="checkbox" class="rec-check" data-id="${r.id}"> ☐ ${recLine(r)}</label>`;
      } else if (r.status === L.ST.EXECUTED) {
        const n = current[r.key];
        html += `<div class="rec done">✅ <strong>Изпълнена</strong> · ${recLine(r)}</div>`;
        if (n && Math.abs(n.amount - r.amount) >= 0.005) {
          html += `<div class="muted">Забележка: при текущите начални данни препоръката би била ${L.fmt(n.amount)}.</div>`;
        }
      } else if (r.status === L.ST.REJECTED) {
        html += `<div class="rec rejected">🚫 <strong>Отказана</strong> · ${recLine(r)}
          <button class="btn small" data-act="rec-restore" data-id="${r.id}">Върни като предложена</button></div>`;
      }
    }

    if (recs.some((r) => r.status === L.ST.PROPOSED)) {
      html += `<div class="btnrow"><button class="btn primary" data-act="rec-confirm">✅ Потвърди, че са извършени</button>
        <button class="btn" data-act="rec-reject">🚫 Откажи отбелязаните</button></div>`;
    }

    const when = L.actualsUpdatedAt(S, month);
    html += `<p class="muted">${when ? '✅ Вече обновено на ' + when : 'Новите суми още не са въведени за този месец.'}</p>
      <button class="btn" data-act="rec-open-actuals">✏️ Въведи нови месечни суми</button>`;

    const obsolete = recs.filter((r) => r.status === L.ST.OBSOLETE);
    if (obsolete.length) {
      html += `<details><summary>Остарели предложения (${obsolete.length})</summary>
        <p class="muted">Тези предложения вече не съответстват на началните данни и няма да бъдат изпълнени.</p>
        ${obsolete.map((r) => `<div class="muted"><s>${recLine(r)}</s></div>`).join('')}</details>`;
    }
    $('#recsBody').innerHTML = html;
  }

  function openRecs() {
    ui.actualsOpen = false;
    renderRecs();
    const dlg = $('#recsDlg');
    if (!dlg.open) dlg.showModal();
  }

  // ---------- настройки, копия ----------
  function renderSettings() {
    const last = S.meta.last_export ? L.fmtDateTime(S.meta.last_export) : 'още няма';
    const folderSupported = 'showDirectoryPicker' in window;
    const fs = ui.folder.state;
    $('#settingsBody').innerHTML = `
      <h2>Настройки и копия</h2>
      <p class="muted">Версия ${APP_VERSION}. Данните се пазят на това устройство. ${ui.persisted === true ? 'Защитени от автоматично изчистване от браузъра.' : ''}</p>
      ${deferredInstall ? '<button class="btn primary" data-act="install">📲 Инсталирай приложението</button><hr>' : ''}
      <strong>Копие на данните</strong>
      <p class="muted">Последно свалено копие: ${last}</p>
      <div class="btnrow"><button class="btn" data-act="export">💾 Свали копие (.json)</button>
      <button class="btn" data-act="import-pick">📂 Зареди от копие…</button></div>
      <input type="file" id="importFile" accept=".json,application/json" hidden>
      <hr>
      <strong>Автоматично копие в папка (само компютър)</strong>
      ${folderSupported ? `
        <p class="muted">${fs === 'ok' ? '✅ Включено: при всяка промяна се записва finance_latest.json и дневно копие.'
          : fs === 'needs-permission' ? '⚠️ Папката е избрана, но трябва да потвърдиш достъп.' : 'Избери папка (напр. в Google Drive или OneDrive), където да се записват копията.'}</p>
        <div class="btnrow">
          ${fs === 'needs-permission' ? '<button class="btn primary" data-act="grant-folder">Разреши достъп</button>' : ''}
          <button class="btn" data-act="pick-folder">${fs === 'none' ? 'Избери папка…' : 'Смени папката…'}</button>
          ${fs !== 'none' ? '<button class="btn" data-act="forget-folder">Изключи</button>' : ''}
        </div>` : '<p class="muted">Този браузър не поддържа запис в папка. Използвай „Свали копие“.</p>'}
      <hr>
      <strong>Изчистване на данните</strong>
      <p class="muted">Изтрива всички баланси, транзакции и препоръки. Преди това автоматично се сваля копие.</p>
      <div class="btnrow"><input type="text" id="resetText" placeholder="Напиши ИЗЧИСТИ">
      <button class="btn danger" data-act="reset">🗑️ Изчисти данните</button></div>`;
  }

  function downloadJson() {
    const stamp = L.toIsoDate(new Date());
    const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `financeapp_${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    S.meta.last_export = new Date().toISOString();
    persist().then(() => { render(); if ($('#settingsDlg').open) renderSettings(); });
  }

  // ----- автоматично копие в папка (File System Access API, компютър) -----
  let folderTimer = null;
  async function refreshFolderState() {
    const h = ui.folder.handle;
    if (!h) { ui.folder.state = 'none'; return; }
    try {
      const p = await h.queryPermission({ mode: 'readwrite' });
      ui.folder.state = p === 'granted' ? 'ok' : 'needs-permission';
    } catch (e) { ui.folder.state = 'none'; }
  }
  function scheduleFolderBackup() {
    clearTimeout(folderTimer);
    folderTimer = setTimeout(writeFolderBackup, 1200);
  }
  async function writeFolderBackup() {
    const h = ui.folder.handle;
    if (!h) return;
    try {
      await refreshFolderState();
      if (ui.folder.state !== 'ok') return;
      const data = JSON.stringify(S);
      const write = async (name) => {
        const f = await h.getFileHandle(name, { create: true });
        const w = await f.createWritable();
        await w.write(data); await w.close();
      };
      await write('finance_latest.json');
      await write(`finance_daily_${L.toIsoDate(new Date())}.json`);
      const daily = [];
      for await (const [name] of h.entries()) if (/^finance_daily_.*\.json$/.test(name)) daily.push(name);
      daily.sort();
      for (const old of daily.slice(0, -30)) await h.removeEntry(old);
    } catch (e) { ui.folder.state = 'needs-permission'; }
  }

  // ---------- събития ----------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const id = Number(el.dataset.id);
    const month = curMonth();

    if (act === 'recs') openRecs();
    else if (act === 'settings') { renderSettings(); $('#settingsDlg').showModal(); }
    else if (act === 'close') el.closest('dialog').close();
    else if (act === 'export') downloadJson();
    else if (act === 'install' && deferredInstall) { deferredInstall.prompt(); deferredInstall = null; renderSettings(); }
    else if (act === 'import-pick') $('#importFile').click();
    else if (act === 'tx-edit') { ui.editingId = id; ui.historyOpen = true; render(); }
    else if (act === 'tx-cancel-edit') { ui.editingId = null; render(); }
    else if (act === 'tx-delete') {
      if (confirm(`Сигурен ли си, че искаш да изтриеш транзакция №${id}?`)) {
        L.softDeleteTransaction(S, id); toast('Транзакцията е изтрита.'); await commit();
      }
    } else if (act === 'tx-restore') {
      if (L.restoreTransaction(S, id)) { toast(`Транзакция №${id} е възстановена.`); await commit(); }
      else toast('Не може да се възстанови: препоръката вече е изпълнена с друга транзакция.', 'err');
    } else if (act === 'rec-confirm' || act === 'rec-reject') {
      const ids = [...document.querySelectorAll('.rec-check:checked')].map((c) => Number(c.dataset.id));
      if (!ids.length) { ui.recsFlash = [['error', 'Отбележи поне една препоръка.']]; renderRecs(); return; }
      if (act === 'rec-confirm') ui.recsFlash = L.confirmRecommendations(S, month, ids);
      else {
        ids.forEach((i) => L.changeRecommendationStatus(S, i, L.ST.PROPOSED, L.ST.REJECTED));
        ui.recsFlash = [['success', 'Избраните препоръки са отказани.']];
      }
      await commit();
    } else if (act === 'rec-restore') {
      if (L.changeRecommendationStatus(S, id, L.ST.REJECTED, L.ST.PROPOSED)) await commit();
      else { ui.recsFlash = [['error', 'Вече има активна препоръка със същите параметри.']]; renderRecs(); }
    } else if (act === 'rec-open-actuals') { ui.actualsOpen = true; renderRecs(); }
    else if (act === 'actuals-back') { ui.actualsOpen = false; renderRecs(); }
    else if (act === 'pick-folder') {
      try {
        const h = await window.showDirectoryPicker({ mode: 'readwrite' });
        ui.folder.handle = h; await kvSet('folder', h);
        await refreshFolderState(); await writeFolderBackup(); await refreshFolderState();
        toast('Папката за копия е избрана.'); renderSettings(); render();
      } catch (err) { /* отказ от потребителя */ }
    } else if (act === 'grant-folder') {
      try {
        await ui.folder.handle.requestPermission({ mode: 'readwrite' });
        await refreshFolderState(); await writeFolderBackup(); await refreshFolderState();
        renderSettings(); render();
      } catch (err) { toast('Достъпът не е разрешен.', 'err'); }
    } else if (act === 'forget-folder') {
      ui.folder.handle = null; ui.folder.state = 'none'; await kvSet('folder', null);
      renderSettings(); render();
    } else if (act === 'reset') {
      if ($('#resetText').value.trim().toUpperCase() !== 'ИЗЧИСТИ') { toast('За изчистване напиши ИЗЧИСТИ в полето.', 'err'); return; }
      downloadJson();
      L.resetData(S); sessionStorage.removeItem('recsSig');
      await commit(); $('#settingsDlg').close();
      toast('Данните са изчистени. Свалено е копие на старите.');
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.form;
    const fd = Object.fromEntries(new FormData(form).entries());
    const month = curMonth();

    try {
      if (kind === 'opening') {
        L.saveOpeningBalances(S, month, {
          spending: num(fd.spending), trading_total: num(fd.trading_total), trading_cash: num(fd.trading_cash),
          investments: num(fd.investments), monthly_savings: num(fd.monthly_savings) });
        toast('Началните баланси са запазени.');
      } else if (kind === 'tx-new') {
        L.addTransaction(S, month, { type: fd.type, amount: num(fd.amount), date: fd.date,
          description: fd.description, source: fd.source, destination: fd.destination });
        ui.tx = { type: '', source: L.CASH, destination: '', amount: '', description: '', date: '' };
        toast('Транзакцията е записана.');
      } else if (kind === 'tx-edit') {
        L.editTransaction(S, Number(form.dataset.id), { type: fd.type, amount: num(fd.amount), date: fd.date,
          description: fd.description, source: fd.source, destination: fd.destination });
        ui.editingId = null;
        toast('Транзакцията е актуализирана.');
      } else if (kind === 'actuals') {
        L.saveActualAmounts(S, month, { spending: num(fd.spending), trading_total: num(fd.trading_total),
          trading_cash: num(fd.trading_cash), investments: num(fd.investments), savings: num(fd.savings) });
        ui.actualsOpen = false;
        ui.recsFlash = [['success', 'Новите месечни суми са запазени.']];
      }
      await commit();
    } catch (err) {
      if (kind === 'actuals') { ui.recsFlash = [['error', err.message]]; renderRecs(); }
      else toast(err.message, 'err');
    }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'selMonth') { ui.month = Number(t.value); ui.editingId = null; ui.tx.date = ''; render(); }
    else if (t.id === 'selYear') { ui.year = Number(t.value); clampMonth(); ui.editingId = null; ui.tx.date = ''; render(); }
    else if (t.id === 'importFile' && t.files[0]) {
      try {
        const parsed = L.validateState(JSON.parse(await t.files[0].text()));
        if (!confirm('Текущите данни на това устройство ще бъдат ЗАМЕНЕНИ с данните от файла. Продължаваш ли?')) return;
        S = parsed; sessionStorage.removeItem('recsSig');
        await commit(); $('#settingsDlg').close(); toast('Данните са заредени.');
      } catch (err) { toast('Неуспешно зареждане: ' + err.message, 'err'); }
      t.value = '';
    } else if (t.closest('#txForm')) {
      const f = new FormData($('#txForm'));
      ui.tx.type = f.get('type') || ''; ui.tx.source = f.get('source') || ui.tx.source;
      ui.tx.destination = f.get('destination') || ui.tx.destination;
      ui.tx.date = f.get('date') || ui.tx.date;
      if (t.name === 'type' || t.name === 'source') render();
    } else if (t.dataset && t.dataset.editType) {
      const box = t.closest('form').querySelector('.transfer-only');
      if (box) box.hidden = t.value !== L.TRANSFER;
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.closest && t.closest('#txForm')) {
      if (t.name === 'amount') ui.tx.amount = t.value;
      if (t.name === 'description') ui.tx.description = t.value;
    }
  });

  document.addEventListener('toggle', (e) => {
    if (e.target.id === 'openingDetails') ui.openingOpen = e.target.open;
    if (e.target.id === 'historyDetails') ui.historyOpen = e.target.open;
  }, true);

  for (const id of ['recsDlg', 'settingsDlg']) {
    $('#' + id).addEventListener('click', (e) => { if (e.target.id === id) e.target.close(); });
  }

  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  window.addEventListener('appinstalled', () => { deferredInstall = null; });

  // ---------- старт ----------
  async function start() {
    try {
      const raw = await kvGet('state');
      if (raw) S = L.validateState(raw);
    } catch (e) {
      toast('Проблем при зареждане на данните: ' + e.message, 'err');
    }
    try { ui.folder.handle = (await kvGet('folder')) || null; await refreshFolderState(); } catch (e) { /* няма папка */ }
    try { if (navigator.storage && navigator.storage.persist) ui.persisted = await navigator.storage.persist(); } catch (e) { /* ок */ }

    clampMonth();
    render();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }
  start();
})();
