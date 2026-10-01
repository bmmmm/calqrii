// Month grid: pure grid math plus a renderer that builds DOM with
// createElement/textContent only. One delegated listener per container;
// the current options live in a WeakMap so re-rendering never re-binds.
import { addDays } from './model.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

function iso(d) {
  // Four-digit year: typing a year into a date field passes through 0202, which must stay a readable ISO date.
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 6 rows × 7 cells of { date, inMonth }; month is 1-based, weekStart 1 = Monday. */
export function monthGrid(year, month, weekStart = 1) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 7 - weekStart) % 7;
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const row = [];
    for (let c = 0; c < 7; c++) {
      const d = new Date(Date.UTC(year, month - 1, 1 - offset + r * 7 + c));
      row.push({ date: iso(d), inMonth: d.getUTCMonth() === month - 1 });
    }
    rows.push(row);
  }
  return rows;
}

const bound = new WeakMap();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function onClick(e) {
  const st = bound.get(e.currentTarget);
  const nav = e.target.closest('[data-nav]');
  if (nav) { st.opts.onNavigate(Number(nav.dataset.nav)); return; }
  const day = e.target.closest('[data-date]');
  if (day) st.opts.onSelect(day.dataset.date);
}

const KEY_DELTA = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function onKey(e) {
  const day = e.target.closest('[data-date]');
  const delta = KEY_DELTA[e.key];
  if (!day || delta === undefined) return;
  e.preventDefault();
  const target = addDays(day.dataset.date, delta);
  const container = e.currentTarget;
  const next = container.querySelector(`[data-date="${target}"]`);
  if (next) {
    day.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  } else {
    bound.get(container).opts.onNavigate(delta < 0 ? -1 : 1, target);
  }
}

/**
 * opts: { year, month, selected:Set, marked:Map<date,count>, today, range:[a,b]|null,
 *   lang, labels:{months, weekdays, prev, next, calendar}, focus, onSelect(date), onNavigate(delta, focusDate) }
 */
export function renderMonth(container, opts) {
  let st = bound.get(container);
  if (!st) {
    st = { opts };
    bound.set(container, st);
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKey);
  }
  st.opts = opts;
  const { year, month, selected, marked, today, range, lang, labels, focus } = opts;
  // A re-render replaces every node; remember what had focus so a keyboard
  // user does not land on <body> after toggling a day or paging a month.
  const active = document.activeElement;
  const refocus = focus ? `[data-date="${focus}"]`
    : container.contains(active) && active.dataset.date ? `[data-date="${active.dataset.date}"]`
    : container.contains(active) && active.dataset.nav ? `[data-nav="${active.dataset.nav}"]`
    : null;
  const grid = monthGrid(year, month);
  const long = new Intl.DateTimeFormat(lang, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  const nav = el('div', 'cal-nav');
  const prev = el('button', 'cal-prev', '‹');
  prev.type = 'button';
  prev.dataset.nav = '-1';
  prev.setAttribute('aria-label', labels.prev);
  const title = el('h2', 'cal-title', `${labels.months[month - 1]} ${year}`);
  title.setAttribute('aria-live', 'polite');
  const next = el('button', 'cal-next', '›');
  next.type = 'button';
  next.dataset.nav = '1';
  next.setAttribute('aria-label', labels.next);
  nav.append(prev, title, next);

  const table = el('table', 'cal-grid');
  table.setAttribute('role', 'grid');
  table.setAttribute('aria-label', labels.calendar);
  const thead = el('thead');
  const hrow = el('tr');
  for (const name of labels.weekdays) {
    const th = el('th', undefined, name);
    th.scope = 'col';
    hrow.append(th);
  }
  thead.append(hrow);
  const tbody = el('tbody');

  const inGrid = (date) => grid.some((row) => row.some((c) => c.date === date));
  let tabDate = focus && inGrid(focus) ? focus
    : [...selected].sort().find((d) => inGrid(d))
    || (inGrid(today) ? today : grid.flat().find((c) => c.inMonth).date);

  for (const row of grid) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      const b = el('button', 'cal-day', String(Number(cell.date.slice(8))));
      b.type = 'button';
      b.dataset.date = cell.date;
      const isSel = selected.has(cell.date);
      b.setAttribute('aria-pressed', String(isSel));
      const count = marked.get(cell.date) || 0;
      b.setAttribute('aria-label', long.format(new Date(cell.date + 'T00:00:00Z')) + (count ? ` (${count})` : ''));
      if (!cell.inMonth) b.classList.add('out');
      if (cell.date === today) b.classList.add('today');
      if (isSel) b.classList.add('selected');
      if (count) b.classList.add('marked');
      if (range && cell.date >= range[0] && cell.date <= range[1]) b.classList.add('in-range');
      b.tabIndex = cell.date === tabDate ? 0 : -1;
      td.append(b);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.replaceChildren(nav, table);
  const target = refocus ? container.querySelector(refocus) : null;
  if (target) {
    if (target.dataset.date) {
      for (const b of container.querySelectorAll('.cal-day')) b.tabIndex = -1;
      target.tabIndex = 0;
    }
    target.focus();
  }
}
