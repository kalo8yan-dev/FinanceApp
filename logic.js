/* FinanceApp – финансова логика (без интерфейс).
   Пренесена 1:1 от Python версията. Цялото състояние е един JSON обект,
   затова е лесно за запазване, копиране и синхронизация. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FinanceLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CASH = 'Текуща наличност';
  const TRADING = 'Трейдинг';
  const INVESTMENTS = 'Инвестиции';
  const SAVINGS = 'Спестявания';
  const ACCOUNTS = [CASH, TRADING, INVESTMENTS, SAVINGS];

  const EXPENSE = 'Разход';
  const INCOME = 'Приход';
  const TRANSFER = 'Вътрешен превод';
  const TYPES = [EXPENSE, INCOME, TRANSFER];

  const ST = {
    PROPOSED: 'Предложена',
    EXECUTED: 'Изпълнена',
    REJECTED: 'Отказана',
    OBSOLETE: 'Остаряла',
  };

  const MONTHS = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли',
    'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];

  const START_YEAR = 2026;
  const START_MONTH = 10;

  const SAVINGS_THRESHOLD = 200;
  const SAVINGS_TO_INVESTMENTS_SHARE = 0.5;
  const TRADING_MIN_FREE_AFTER_PROTECTION = 100;
  const TRADING_RETAINED_SHARE = 0.3;
  const TRADING_TO_CASH_SHARE = 0.2;

  // ---------- помощни ----------
  function money(v) {
    const n = Number(v) || 0;
    const sign = n < 0 ? -1 : 1;
    return sign * Math.round((Math.abs(n) + 1e-9) * 100) / 100 || 0;
  }

  function fmt(v) {
    return '€' + money(v).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  const monthOf = (date) => String(date).slice(0, 7);
  const nowIso = () => new Date().toISOString();

  function monthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return MONTHS[m - 1] + ' ' + y;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function toIsoDate(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return [`${month}-01`, `${month}-${pad(last)}`];
  }

  function defaultDateForMonth(month, today) {
    const t = toIsoDate(today || new Date());
    const [first, last] = monthBounds(month);
    if (t >= first && t <= last) return t;
    return first > t ? first : last;
  }

  function fmtDateTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function fmtDate(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${d}/${m}/${y}`;
  }

  // ---------- състояние ----------
  function emptyState() {
    return {
      v: 1,
      balances: {},
      transactions: [],
      recommendations: [],
      seq: { tx: 0, rec: 0 },
      meta: { updated_at: null },
    };
  }

  function validateState(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('Невалиден файл.');
    if (obj.v !== 1) throw new Error('Неподдържана версия на данните.');
    if (typeof obj.balances !== 'object' || !Array.isArray(obj.transactions) ||
        !Array.isArray(obj.recommendations)) {
      throw new Error('Файлът не прилича на данни от FinanceApp.');
    }
    const s = emptyState();
    s.balances = obj.balances;
    s.transactions = obj.transactions;
    s.recommendations = obj.recommendations;
    s.seq = {
      tx: Math.max(Number(obj.seq && obj.seq.tx) || 0, ...obj.transactions.map((t) => t.id || 0), 0),
      rec: Math.max(Number(obj.seq && obj.seq.rec) || 0, ...obj.recommendations.map((r) => r.id || 0), 0),
    };
    s.meta = obj.meta || { updated_at: null };
    return s;
  }

  function normalizeAccount(name) {
    return name === 'За ползване' ? CASH : name;
  }

  // ---------- трейдинг и спестявания ----------
  function tradingPlan(totalIn, cashIn, minimumIn) {
    const total = money(totalIn);
    const cash = money(cashIn);
    const minimum = money(minimumIn);

    if (total < 0 || cash < 0 || minimum < 0) {
      throw new Error('Сумите в трейдинг не могат да бъдат отрицателни.');
    }
    if (cash > total) {
      throw new Error('Свободните средства в трейдинг не могат да надвишават общата стойност.');
    }

    const active = money(total - cash);
    const needed = money(Math.max(0, minimum - active));
    const coversMinimum = total >= minimum;
    const freeAfter = money(cash - needed);
    const enoughFree = freeAfter >= TRADING_MIN_FREE_AFTER_PROTECTION;
    const allowed = coversMinimum && enoughFree;

    const plan = {
      allowed,
      active_capital: active,
      minimum_capital: minimum,
      capital_needed: needed,
      free_after_protection: freeAfter,
      covers_minimum: coversMinimum,
      enough_free_cash: enoughFree,
      distributable: 0,
      retained: 0,
      to_current_cash: 0,
      to_investments: 0,
      reason: '',
    };

    if (allowed) {
      const distributable = freeAfter;
      const retained = money(distributable * TRADING_RETAINED_SHARE);
      const toCash = money(distributable * TRADING_TO_CASH_SHARE);
      const toInv = money(distributable - retained - toCash); // остатък: без разлика от цент
      Object.assign(plan, {
        distributable,
        retained,
        to_current_cash: toCash,
        to_investments: toInv,
        reason: 'Минималният капитал е подсигурен и след него остават поне €100 свободни средства.',
      });
    } else {
      const reasons = [];
      if (!coversMinimum) {
        reasons.push(`Общият капитал (${fmt(total)}) не покрива минималния (${fmt(minimum)}).`);
      }
      if (!enoughFree) {
        reasons.push(`След подсигуряването на минимума остават ${fmt(freeAfter)} свободни, а са нужни поне €100.`);
      }
      plan.reason = reasons.join(' ');
    }
    return plan;
  }

  function savingsPlan(totalIn) {
    const total = money(totalIn);
    let transfer = 0;
    if (total >= SAVINGS_THRESHOLD) transfer = money(total * SAVINGS_TO_INVESTMENTS_SHARE);
    return {
      total,
      threshold_reached: total >= SAVINGS_THRESHOLD,
      transfer,
      remaining: money(total - transfer),
    };
  }

  function calculateMonthlyRecommendations(p) {
    if (p.opening_savings < 0 || p.monthly_leftover < 0) {
      throw new Error('Спестяванията не могат да бъдат отрицателни.');
    }
    const savings = savingsPlan(money(p.opening_savings) + money(p.monthly_leftover));
    const trading = tradingPlan(p.trading_total, p.trading_cash, p.minimum_trading_capital);
    const recs = [];

    if (savings.transfer > 0) {
      recs.push({
        key: 'savings_to_investments', category: 'savings',
        source: SAVINGS, destination: INVESTMENTS, amount: savings.transfer,
        reason: `Спестяванията са достигнали ${fmt(savings.total)} (праг €200): 50% се инвестират.`,
      });
    }
    if (trading.allowed) {
      if (trading.to_current_cash > 0) {
        recs.push({
          key: 'trading_to_cash', category: 'trading',
          source: TRADING, destination: CASH, amount: trading.to_current_cash,
          reason: '20% от разпределяемите средства.',
        });
      }
      if (trading.to_investments > 0) {
        recs.push({
          key: 'trading_to_investments', category: 'trading',
          source: TRADING, destination: INVESTMENTS, amount: trading.to_investments,
          reason: '50% от разпределяемите средства.',
        });
      }
    }
    return { recommendations: recs, savings, trading };
  }

  // ---------- баланси ----------
  function calculateBalances(balance, transactions, includeAdj) {
    if (includeAdj === undefined) includeAdj = true;
    let spending = 0, tTotal = 0, tCash = 0, inv = 0;

    if (balance) {
      spending = balance.spending || 0;
      tTotal = balance.trading_total || 0;
      tCash = balance.trading_cash || 0;
      inv = balance.investments || 0;
      if (includeAdj) {
        spending += balance.adj_spending || 0;
        tTotal += balance.adj_trading_total || 0;
        tCash += balance.adj_trading_cash || 0;
        inv += balance.adj_investments || 0;
      }
    }

    let income = 0, expenses = 0;

    for (const t of transactions) {
      const amount = Number(t.amount);
      if (t.type === INCOME) { spending += amount; income += amount; }
      else if (t.type === EXPENSE) { spending += amount; expenses += amount; }
      else if (t.type === TRANSFER) {
        const src = normalizeAccount(t.source);
        const dst = normalizeAccount(t.destination);
        if (!src || !dst || src === dst) continue;

        if (src === CASH) spending -= amount;
        else if (src === TRADING) { tTotal -= amount; tCash -= amount; }
        else if (src === INVESTMENTS) inv -= amount;

        if (dst === CASH) spending += amount;
        else if (dst === TRADING) { tTotal += amount; tCash += amount; }
        else if (dst === INVESTMENTS) inv += amount;
        // „Спестявания“ се смятат отделно (savingsPosition)
      }
    }

    return {
      spending: money(spending), trading_total: money(tTotal), trading_cash: money(tCash),
      investments: money(inv), income: money(income), expenses: money(expenses),
    };
  }

  function monthTransactions(S, month, includeDeleted) {
    return S.transactions
      .filter((t) => monthOf(t.date) === month && (includeDeleted || !t.is_deleted))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  }

  function savingsPosition(S, month, inclusive) {
    if (inclusive === undefined) inclusive = true;
    const inScope = (m) => (inclusive ? m <= month : m < month);

    let monthly = 0;
    for (const [m, b] of Object.entries(S.balances)) {
      if (inScope(m)) monthly += (b.monthly_savings || 0) + (b.adj_savings || 0);
    }

    let transfers = 0;
    for (const t of S.transactions) {
      if (t.is_deleted || t.type !== TRANSFER || !inScope(monthOf(t.date))) continue;
      if (t.destination === SAVINGS) transfers += Number(t.amount);
      else if (t.source === SAVINGS) transfers -= Number(t.amount);
    }
    return money(monthly + transfers);
  }

  /* Минимален трейдинг капитал: първият записан месец = общата стойност
     на трейдинг. За следващите: ако проверките са минали, новият минимум
     е сумата, която остава в трейдинг след разпределението. Ако
     препоръките за трейдинг са отказани или проверките не минават –
     минимумът не се променя. */
  function minimumTradingCapital(S, month) {
    const months = Object.keys(S.balances).filter((m) => m <= month).sort();
    if (!months.length) return 0;

    let minimum = money(S.balances[months[0]].trading_total);

    for (const m of months.filter((x) => x < month)) {
      const prev = S.balances[m];
      const plan = tradingPlan(prev.trading_total, prev.trading_cash, minimum);
      const rejected = S.recommendations.some(
        (r) => r.month === m && r.category === 'trading' && r.status === ST.REJECTED);

      if (plan.allowed && !rejected) {
        minimum = money(money(prev.trading_total) - plan.to_current_cash - plan.to_investments);
      }
    }
    return minimum;
  }

  function monthlyPlan(S, month) {
    const b = S.balances[month];
    if (!b) return null;
    return calculateMonthlyRecommendations({
      trading_total: b.trading_total,
      trading_cash: b.trading_cash,
      minimum_trading_capital: minimumTradingCapital(S, month),
      opening_savings: savingsPosition(S, month, false),
      monthly_leftover: b.monthly_savings || 0,
    });
  }

  function computeMonthState(S, month) {
    const balance = S.balances[month] || null;
    const transactions = monthTransactions(S, month, false);
    return {
      balance,
      transactions,
      all_transactions: monthTransactions(S, month, true),
      balances: calculateBalances(balance, transactions, true),
      savings_total: savingsPosition(S, month, true),
    };
  }

  function accountBalance(state, account) {
    account = normalizeAccount(account);
    if (account === CASH) return state.balances.spending;
    if (account === TRADING) return state.balances.trading_cash;
    if (account === INVESTMENTS) return state.balances.investments;
    if (account === SAVINGS) return state.savings_total;
    return 0;
  }

  // ---------- начални баланси ----------
  function saveOpeningBalances(S, month, v) {
    if (v.trading_cash > v.trading_total) {
      throw new Error('Свободните средства не могат да надвишават общата стойност на трейдинг акаунта.');
    }
    const old = S.balances[month] || {};
    S.balances[month] = Object.assign(
      { adj_spending: 0, adj_trading_total: 0, adj_trading_cash: 0, adj_investments: 0,
        adj_savings: 0, actuals_updated_at: null, created_at: nowIso() },
      old,
      {
        spending: money(v.spending), trading_total: money(v.trading_total),
        trading_cash: money(v.trading_cash), investments: money(v.investments),
        monthly_savings: money(v.monthly_savings),
      });
  }

  /* Нови месечни суми: записват се като корекция (въведено − изчислено),
     така че препоръките и минималният капитал (от началната снимка)
     не се променят, а транзакциите не се броят два пъти. */
  function saveActualAmounts(S, month, v) {
    if (v.trading_cash > v.trading_total) {
      throw new Error('Свободните средства не могат да надвишават общата стойност на трейдинг акаунта.');
    }
    const b = S.balances[month];
    if (!b) throw new Error('Първо въведи началните баланси за месеца.');

    const base = calculateBalances(b, monthTransactions(S, month, false), false);
    const baseSavings = savingsPosition(S, month, true) - (b.adj_savings || 0);

    b.adj_spending = money(v.spending - base.spending);
    b.adj_trading_total = money(v.trading_total - base.trading_total);
    b.adj_trading_cash = money(v.trading_cash - base.trading_cash);
    b.adj_investments = money(v.investments - base.investments);
    b.adj_savings = money(v.savings - baseSavings);
    b.actuals_updated_at = nowIso();
  }

  function actualsUpdatedAt(S, month) {
    const b = S.balances[month];
    return b && b.actuals_updated_at ? fmtDateTime(b.actuals_updated_at) : null;
  }

  function lastTransactionTime(S, month) {
    let best = null;
    for (const t of S.transactions) {
      if (t.is_deleted || monthOf(t.date) !== month) continue;
      if (!best || t.created_at > best) best = t.created_at;
    }
    return best ? fmtDateTime(best) : null;
  }

  // ---------- препоръки ----------
  const sameRec = (row, c) =>
    row.source === c.source && row.destination === c.destination &&
    Math.abs(row.amount - c.amount) < 0.005;

  function newRecId(S) { S.seq.rec += 1; return S.seq.rec; }
  function newTxId(S) { S.seq.tx += 1; return S.seq.tx; }

  function monthRecommendations(S, month) {
    return S.recommendations.filter((r) => r.month === month).sort((a, b) => a.id - b.id);
  }

  /* Идемпотентна синхронизация: повторно извикване със същите данни
     не променя нищо (връща false). */
  function syncRecommendations(S, month, computed) {
    const byKeyNew = {};
    computed.forEach((c) => { byKeyNew[c.key] = c; });

    const rows = S.recommendations
      .filter((r) => r.month === month && r.status !== ST.OBSOLETE)
      .sort((a, b) => a.id - b.id);
    const byKey = {};
    rows.forEach((r) => { (byKey[r.key] = byKey[r.key] || []).push(r); });

    let changed = false;
    const keys = new Set([...Object.keys(byKey), ...Object.keys(byKeyNew)]);

    for (const key of keys) {
      const keyRows = byKey[key] || [];
      const fresh = byKeyNew[key];
      const executed = keyRows.filter((r) => r.status === ST.EXECUTED);
      const rejected = keyRows.filter((r) => r.status === ST.REJECTED);
      const stillProposed = [];

      for (const row of keyRows) {
        if (row.status !== ST.PROPOSED) continue;
        if (!fresh || !sameRec(row, fresh)) {
          row.status = ST.OBSOLETE; row.updated_at = nowIso(); changed = true;
        } else stillProposed.push(row);
      }

      if (!fresh || executed.length || stillProposed.length) continue;
      if (rejected.length && sameRec(rejected[rejected.length - 1], fresh)) continue;

      S.recommendations.push({
        id: newRecId(S), month, key, category: fresh.category,
        source: fresh.source, destination: fresh.destination,
        amount: fresh.amount, reason: fresh.reason,
        status: ST.PROPOSED, transaction_id: null,
        created_at: nowIso(), updated_at: nowIso(),
      });
      changed = true;
    }
    return changed;
  }

  function changeRecommendationStatus(S, id, from, to) {
    const rec = S.recommendations.find((r) => r.id === id);
    if (!rec || rec.status !== from) return false;

    // най-много една активна (предложена/изпълнена) за месец+ключ
    if (to === ST.PROPOSED || to === ST.EXECUTED) {
      const clash = S.recommendations.some((r) => r.id !== id && r.month === rec.month &&
        r.key === rec.key && (r.status === ST.PROPOSED || r.status === ST.EXECUTED));
      if (clash) return false;
    }
    rec.status = to; rec.updated_at = nowIso();
    return true;
  }

  function executeRecommendation(S, id, dateIso) {
    const rec = S.recommendations.find((r) => r.id === id);
    if (!rec || rec.status !== ST.PROPOSED) return false;

    const description = `Препоръка: ${rec.source} → ${rec.destination}. ${rec.reason}`.trim();
    const txId = newTxId(S);

    S.transactions.push({
      id: txId, date: dateIso, description, amount: rec.amount, type: TRANSFER,
      source: rec.source, destination: rec.destination,
      created_at: nowIso(), is_deleted: false, recommendation_id: rec.id,
    });
    rec.status = ST.EXECUTED; rec.transaction_id = txId; rec.updated_at = nowIso();
    return true;
  }

  function confirmRecommendations(S, month, ids) {
    const messages = [];
    let done = 0;

    for (const id of ids) {
      const rec = S.recommendations.find((r) => r.id === id);
      if (!rec || rec.month !== month || rec.status !== ST.PROPOSED) continue;

      const available = accountBalance(computeMonthState(S, month), rec.source);
      if (rec.amount > available + 0.004) {
        messages.push(['error',
          `Недостатъчна наличност в „${rec.source}“ за превод от ${fmt(rec.amount)} (налични: ${fmt(available)}).`]);
        continue;
      }
      if (executeRecommendation(S, id, defaultDateForMonth(month))) done += 1;
    }
    if (done) messages.unshift(['success', `Записани реални трансфери: ${done}.`]);
    return messages;
  }

  // ---------- транзакции ----------
  function addTransaction(S, month, f) {
    const amount = money(f.amount);
    if (!f.type) throw new Error('Избери тип движение.');
    if (!(amount > 0)) throw new Error('Въведи сума, по-голяма от €0.00.');
    if (!f.date || monthOf(f.date) !== month) throw new Error('Датата трябва да е в избрания месец.');

    let source = null, destination = null;
    if (f.type === TRANSFER) {
      source = f.source; destination = f.destination;
      if (!ACCOUNTS.includes(source) || !ACCOUNTS.includes(destination) || source === destination) {
        throw new Error('Избери различни сметки за превода.');
      }
      const available = accountBalance(computeMonthState(S, month), source);
      if (amount > available + 0.004) {
        throw new Error(`Недостатъчна наличност в „${source}“. Налични са ${fmt(available)}.`);
      }
    }

    const text = (f.description || '').trim() || 'Без описание';
    S.transactions.push({
      id: newTxId(S), date: f.date, description: text,
      amount: f.type === EXPENSE ? -amount : amount, type: f.type,
      source, destination, created_at: nowIso(), is_deleted: false, recommendation_id: null,
    });
  }

  function editTransaction(S, id, f) {
    const t = S.transactions.find((x) => x.id === id);
    if (!t) throw new Error('Транзакцията не е намерена.');
    const amount = money(f.amount);
    if (!(amount > 0)) throw new Error('Въведи сума, по-голяма от €0.00.');
    if (!f.date || monthOf(f.date) !== monthOf(t.date)) throw new Error('Датата трябва да остане в същия месец.');

    let source = null, destination = null;
    if (f.type === TRANSFER) {
      source = f.source; destination = f.destination;
      if (!ACCOUNTS.includes(source) || !ACCOUNTS.includes(destination) || source === destination) {
        throw new Error('Избери различни сметки за превода.');
      }
    }
    t.date = f.date;
    t.type = f.type;
    t.amount = f.type === EXPENSE ? -amount : amount;
    t.description = (f.description || '').trim() || 'Без описание';
    t.source = source; t.destination = destination;
  }

  function softDeleteTransaction(S, id) {
    const t = S.transactions.find((x) => x.id === id);
    if (!t) return;
    t.is_deleted = true;
    // ако е създадена от препоръка – препоръката се връща в „Предложена“
    for (const r of S.recommendations) {
      if (r.transaction_id === id && r.status === ST.EXECUTED) {
        r.status = ST.PROPOSED; r.updated_at = nowIso();
      }
    }
  }

  function restoreTransaction(S, id) {
    const t = S.transactions.find((x) => x.id === id);
    if (!t) return false;

    if (t.recommendation_id != null) {
      const rec = S.recommendations.find((r) => r.id === t.recommendation_id);
      if (rec) {
        if (rec.status === ST.EXECUTED && rec.transaction_id !== id) return false;
        if (rec.status === ST.PROPOSED) {
          rec.status = ST.EXECUTED; rec.transaction_id = id; rec.updated_at = nowIso();
        }
      }
    }
    t.is_deleted = false;
    return true;
  }

  function resetData(S) {
    const fresh = emptyState();
    S.balances = fresh.balances;
    S.transactions = fresh.transactions;
    S.recommendations = fresh.recommendations;
    S.seq = fresh.seq;
  }

  return {
    CASH, TRADING, INVESTMENTS, SAVINGS, ACCOUNTS, EXPENSE, INCOME, TRANSFER, TYPES, ST, MONTHS,
    START_YEAR, START_MONTH,
    money, fmt, monthOf, monthLabel, monthBounds, defaultDateForMonth, toIsoDate,
    fmtDateTime, fmtDate, emptyState, validateState, normalizeAccount,
    tradingPlan, savingsPlan, calculateMonthlyRecommendations, calculateBalances,
    monthTransactions, savingsPosition, minimumTradingCapital, monthlyPlan,
    computeMonthState, accountBalance, saveOpeningBalances, saveActualAmounts,
    actualsUpdatedAt, lastTransactionTime, monthRecommendations, syncRecommendations,
    changeRecommendationStatus, executeRecommendation, confirmRecommendations,
    addTransaction, editTransaction, softDeleteTransaction, restoreTransaction, resetData,
  };
});
