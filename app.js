// calqrii web app: month grid → editor → events → one QR per event.
//
// Zero-storage contract: this file never touches a storage API, the network,
// the history or the address bar (scripts/web-smoke.mjs greps for that). The
// only state that can leave the page is a share link the user asks for, and
// it lives in the #fragment.
import { renderMonth } from './calendar.js';
import { serializeEvent, serializeCalendar } from './ics.js';
import { encodeFragment, decodeFragment } from './fragment.js';
import { qrSvg, utf8Length, QUIET_ZONE } from './qr.js';
import { STR } from './i18n.js';
import { expandDraft, isValidDate, weekdayOf, compareDates, addDays, LIMITS } from './model.js';

// One timestamp per page load: DTSTAMP must not drift between renders, or
// the QR of an unchanged event would change under the user's hands.
const SESSION_NOW = new Date();
const LINK_LONG_CHARS = 8000;
const MEMO_MAX = 200;
const UNDO_MS = 5000;
const MARK_SPAN_MAX_DAYS = 366;

const $ = (id) => document.getElementById(id);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const today = todayIso();
const state = {
  events: [],
  nextId: 1,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  view: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
  selected: new Set(),
  mode: 'each',
  editingId: null,
  combined: false,
  dirty: false,
  focus: null,
};
let lang = 'en';
const t = () => STR[lang];
let els = null;
let bannerTimer = 0;
const qrMemo = new Map(); // ics text → qrSvg() result, or { error, bytes }

// --- i18n

function applyLang(code) {
  lang = STR[code] ? code : 'en';
  document.documentElement.lang = lang;
  document.title = t().title;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const s = t()[el.dataset.i18n];
    if (typeof s === 'string') el.textContent = s;
  }
  for (const el of document.querySelectorAll('[data-wd]')) el.textContent = t().weekdays_short[Number(el.dataset.wd)];
  $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  $('lang-de').setAttribute('aria-pressed', String(lang === 'de'));
  $('lang-nav').setAttribute('aria-label', t().language);
  if (els) render();
}

// --- banner (role=status): replaces confirm()/alert(), which block automation

function showBanner(text, actions = [], { timeoutMs = 0, error = false } = {}) {
  clearTimeout(bannerTimer);
  const nodes = [document.createTextNode(text)];
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.addEventListener('click', () => { hideBanner(); a.onClick(); });
    nodes.push(b);
  }
  els.banner.replaceChildren(...nodes);
  els.banner.classList.toggle('error', error);
  els.banner.hidden = false;
  if (timeoutMs) bannerTimer = setTimeout(hideBanner, timeoutMs);
}

function hideBanner() {
  clearTimeout(bannerTimer);
  els.banner.hidden = true;
  els.banner.replaceChildren();
}

// --- editor

function readEditor() {
  const freq = els.freq.value;
  const ends = document.querySelector('input[name="f-ends"]:checked').value;
  return {
    title: els.title.value,
    allDay: els.allDay.checked,
    date: els.date.value,
    endDate: els.endDate.value,
    startTime: els.start.value,
    endTime: els.end.value,
    location: els.location.value,
    description: els.desc.value,
    url: els.url.value,
    recurrence: {
      freq,
      interval: els.interval.value,
      byDay: [...els.byDay.querySelectorAll('input:checked')].map((c) => c.value),
      // An empty number field under a ticked "after"/"on" must fail loudly,
      // not silently turn into "never".
      count: freq !== 'none' && ends === 'count' ? (els.count.value === '' ? NaN : Number(els.count.value)) : null,
      until: freq !== 'none' && ends === 'until' ? (els.until.value || 'invalid') : null,
    },
  };
}

function fillEditor(ev) {
  els.title.value = ev.title;
  els.allDay.checked = ev.allDay;
  els.date.value = ev.date;
  els.endDate.value = ev.endDate;
  els.start.value = ev.startTime;
  els.end.value = ev.endTime;
  els.location.value = ev.location;
  els.desc.value = ev.description;
  els.url.value = ev.url;
  const r = ev.recurrence;
  els.freq.value = r.freq;
  els.interval.value = String(r.interval);
  for (const c of els.byDay.querySelectorAll('input')) c.checked = r.byDay.includes(c.value);
  const ends = r.count !== null ? 'count' : r.until !== null ? 'until' : 'never';
  document.querySelector(`input[name="f-ends"][value="${ends}"]`).checked = true;
  els.count.value = r.count !== null ? String(r.count) : '10';
  els.until.value = r.until !== null ? r.until : '';
}

function resetEditor() {
  els.form.reset();
  els.date.value = today;
  els.endDate.value = today;
  els.interval.value = '1';
  els.count.value = '10';
  showFormErrors([]);
}

function showFormErrors(keys) {
  els.formError.textContent = keys.map((k) => t()[k] || k).join(' ');
  els.formError.hidden = keys.length === 0;
}

function selectedDays() {
  return [...state.selected].sort(compareDates);
}

function eachMode() {
  return state.editingId === null && state.selected.size >= 2 && state.mode === 'each';
}

/** Date fields follow the grid: one day → both, a span → min/max, "each" → blank + disabled. */
function syncDatesFromSelection() {
  const days = selectedDays();
  const each = eachMode();
  els.date.disabled = each;
  els.endDate.disabled = each;
  if (each) {
    els.date.value = '';
    els.endDate.value = '';
  } else if (days.length >= 1) {
    els.date.value = days[0];
    els.endDate.value = days[days.length - 1];
  } else if (els.date.value === '') {
    els.date.value = today;
    els.endDate.value = today;
  }
  ensureStartWeekday();
}

/** The grid follows the date fields: a typed date selects it. */
function syncSelectionFromDates() {
  const d = els.date.value;
  if (!isValidDate(d)) return;
  if (!isValidDate(els.endDate.value) || compareDates(els.endDate.value, d) < 0) els.endDate.value = d;
  const e = els.endDate.value;
  state.selected = new Set(e === d ? [d] : [d, e]);
  state.mode = 'span';
  state.view = { year: Number(d.slice(0, 4)), month: Number(d.slice(5, 7)) };
  ensureStartWeekday();
}

/** Weekly series: the start day's weekday is always ticked (validateEvent insists). */
function ensureStartWeekday() {
  if (els.freq.value !== 'weekly' || !isValidDate(els.date.value)) return;
  const wd = weekdayOf(els.date.value);
  const box = els.byDay.querySelector(`input[value="${wd}"]`);
  if (box && ![...els.byDay.querySelectorAll('input')].some((c) => c.checked && c.value === wd)) box.checked = true;
}

function sortEvents() {
  state.events.sort((a, b) => compareDates(a.date, b.date) || a.startTime.localeCompare(b.startTime) || a.id - b.id);
}

function submitEditor(e) {
  e.preventDefault();
  const editing = state.editingId !== null;
  const draft = readEditor();
  const mode = editing ? 'span' : state.mode;
  const { events, errors } = expandDraft(draft, selectedDays(), mode);
  if (errors.length) { showFormErrors(errors); return; }
  if (!editing && state.events.length + events.length > LIMITS.events) { showFormErrors(['err_too_many']); return; }
  showFormErrors([]);
  let firstId;
  if (editing) {
    const idx = state.events.findIndex((ev) => ev.id === state.editingId);
    events[0].id = state.editingId;
    state.events[idx] = events[0];
    firstId = events[0].id;
  } else {
    for (const ev of events) { ev.id = state.nextId++; state.events.push(ev); }
    firstId = events[0].id;
  }
  sortEvents();
  state.dirty = true;
  state.editingId = null;
  state.selected.clear();
  resetEditor();
  render();
  const panel = els.list.querySelector(`[data-id="${firstId}"]`);
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editEvent(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  state.editingId = id;
  fillEditor(ev);
  state.selected = new Set(ev.endDate !== ev.date ? [ev.date, ev.endDate] : [ev.date]);
  state.mode = 'span';
  state.view = { year: Number(ev.date.slice(0, 4)), month: Number(ev.date.slice(5, 7)) };
  showFormErrors([]);
  render();
  els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  els.title.focus();
}

function cancelEdit() {
  state.editingId = null;
  state.selected.clear();
  resetEditor();
  render();
}

function duplicateEvent(id) {
  const idx = state.events.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const src = state.events[idx];
  if (state.events.length >= LIMITS.events) { showBanner(t().err_too_many, [], { timeoutMs: UNDO_MS, error: true }); return; }
  const copy = { ...src, id: state.nextId++, recurrence: { ...src.recurrence, byDay: [...src.recurrence.byDay] } };
  state.events.splice(idx + 1, 0, copy);
  state.dirty = true;
  render();
}

function deleteEvent(id) {
  const idx = state.events.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const [removed] = state.events.splice(idx, 1);
  if (state.editingId === id) cancelEdit();
  state.dirty = true;
  render();
  showBanner(t().deleted, [{ label: t().undo, onClick: () => { state.events.splice(Math.min(idx, state.events.length), 0, removed); render(); } }], { timeoutMs: UNDO_MS });
}

// --- calendar

function onSelectDay(date) {
  if (state.selected.has(date)) state.selected.delete(date);
  else state.selected.add(date);
  syncDatesFromSelection();
  render();
}

function onNavigate(delta, focusDate) {
  let { year, month } = state.view;
  month += delta;
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }
  state.view = { year, month };
  state.focus = focusDate || null;
  renderCalendar();
}

function markedMap() {
  const map = new Map();
  const bump = (d) => map.set(d, (map.get(d) || 0) + 1);
  for (const ev of state.events) {
    if (ev.recurrence.freq !== 'none' || ev.endDate === ev.date) { bump(ev.date); continue; }
    let d = ev.date;
    for (let i = 0; i < MARK_SPAN_MAX_DAYS && compareDates(d, ev.endDate) <= 0; i++) { bump(d); d = addDays(d, 1); }
  }
  return map;
}

function renderCalendar() {
  const days = selectedDays();
  const range = !eachMode() && days.length >= 2 ? [days[0], days[days.length - 1]] : null;
  renderMonth(els.calendar, {
    year: state.view.year,
    month: state.view.month,
    selected: state.selected,
    marked: markedMap(),
    today,
    range,
    lang,
    labels: { months: t().months, weekdays: t().weekdays_short, prev: t().prev_month, next: t().next_month, calendar: t().calendar_label },
    focus: state.focus,
    onSelect: onSelectDay,
    onNavigate,
  });
  state.focus = null;
}

// --- rendering

function renderSelection() {
  const n = state.selected.size;
  els.selInfo.textContent = n === 0 ? t().sel_none : t().sel_count(n);
  els.clearSel.hidden = n === 0;
}

function renderEditorState() {
  const n = state.selected.size;
  const editing = state.editingId !== null;
  els.daysMode.hidden = editing || n < 2;
  document.querySelector(`input[name="days-mode"][value="${state.mode}"]`).checked = true;
  els.save.textContent = editing ? t().save : t().add_n(eachMode() ? n : 1);
  els.cancelEdit.hidden = !editing;
  const allDay = els.allDay.checked;
  els.start.hidden = allDay;
  els.end.hidden = allDay;
  if (allDay) { els.start.value = ''; els.end.value = ''; }
  const freq = els.freq.value;
  els.repOpts.hidden = freq === 'none';
  els.byDay.hidden = freq !== 'weekly';
  const interval = Number(els.interval.value) || 1;
  els.intervalUnit.textContent = freq === 'none' ? '' : t().f_interval_unit(freq, interval);
  els.repNote.hidden = allDay;
  const day = isValidDate(els.date.value) ? Number(els.date.value.slice(8)) : 0;
  els.repDayNote.hidden = !((freq === 'monthly' || freq === 'yearly') && day > 28);
}

function svgNode(text) {
  // Parsed as XML and inserted as a node, never assigned as an HTML string:
  // qr.js emits geometry only, but that invariant lives in another module.
  const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (root.nodeName !== 'svg' || root.querySelector('parsererror')) return null;
  return document.importNode(root, true);
}

function qrFor(ics) {
  let res = qrMemo.get(ics);
  if (!res) {
    try {
      res = qrSvg(ics);
    } catch (e) {
      res = { error: e && e.message === 'too_big' ? 'too_big' : String(e), bytes: utf8Length(ics) };
    }
    if (qrMemo.size >= MEMO_MAX) qrMemo.clear();
    qrMemo.set(ics, res);
  }
  return res;
}

/** Fills a [data-qr-panel] from the ICS text alone — it never reads the form. */
function renderQrPanel(panel, ics, title, stem) {
  const node = els.tplQr.content.cloneNode(true);
  const res = qrFor(ics);
  const qrEl = node.querySelector('.qr');
  const meta = node.querySelector('.qr-meta');
  const warn = node.querySelector('.qr-warn');
  const err = node.querySelector('.qr-error');
  const svg = res.error ? null : svgNode(res.svg);
  if (svg) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t().qr_alt(title));
    qrEl.replaceChildren(svg);
    meta.textContent = t().qr_meta(res.bytes, res.version, res.size, res.ecc);
    warn.textContent = t().qr_large;
    warn.hidden = !res.large;
  } else {
    qrEl.hidden = true;
    meta.hidden = true;
    err.textContent = res.error === 'too_big' ? t().qr_too_big(res.bytes) : res.error;
    err.hidden = false;
    for (const b of node.querySelectorAll('[data-act="svg"], [data-act="png"]')) b.disabled = true;
  }
  node.querySelector('[data-act="svg"]').textContent = t().dl_svg;
  node.querySelector('[data-act="png"]').textContent = t().dl_png;
  node.querySelector('[data-act="ics"]').textContent = t().dl_ics;
  node.querySelector('.show-ics').textContent = t().show_ics;
  node.querySelector('pre.ics').textContent = ics;
  panel.dataset.title = title;
  panel.dataset.stem = stem;
  panel.replaceChildren(node);
}

function whenText(ev) {
  const df = new Intl.DateTimeFormat(lang, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmt = (d) => df.format(new Date(d + 'T00:00:00Z'));
  if (ev.allDay) {
    return (ev.endDate === ev.date ? fmt(ev.date) : `${fmt(ev.date)} – ${fmt(ev.endDate)}`) + ` · ${t().when_allday}`;
  }
  if (ev.endDate === ev.date) return `${fmt(ev.date)}, ${ev.startTime}${ev.endTime ? '–' + ev.endTime : ''}`;
  return `${fmt(ev.date)}, ${ev.startTime} – ${fmt(ev.endDate)}, ${ev.endTime}`;
}

function recText(ev) {
  return t().rec_summary(ev.recurrence, t().weekday_codes);
}

/** calqrii-<date>-<ascii slug>, at most 40 characters, cut at a word boundary. */
function fileStem(ev) {
  const prefix = `calqrii-${ev.date}-`;
  const slug = ev.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let cut = slug.slice(0, 40 - prefix.length);
  if (cut.length < slug.length) {
    const i = cut.lastIndexOf('-');
    if (i > 0) cut = cut.slice(0, i);
  }
  cut = cut.replace(/-+$/, '');
  return prefix + (cut || 'event');
}

function renderList() {
  const opts = { now: SESSION_NOW, tz: state.tz };
  els.emptyList.hidden = state.events.length > 0;
  const items = [];
  for (const ev of state.events) {
    const node = els.tplEvent.content.cloneNode(true);
    const li = node.querySelector('li');
    li.dataset.id = String(ev.id);
    node.querySelector('.ev-title').textContent = ev.title;
    node.querySelector('.ev-when').textContent = whenText(ev);
    const rec = node.querySelector('.ev-rec');
    rec.textContent = recText(ev);
    rec.hidden = rec.textContent === '';
    const where = node.querySelector('.ev-where');
    where.textContent = ev.location;
    where.hidden = ev.location === '';
    renderQrPanel(node.querySelector('[data-qr-panel]'), serializeEvent(ev, opts), ev.title, fileStem(ev));
    node.querySelector('[data-ev="edit"]').textContent = t().edit;
    node.querySelector('[data-ev="duplicate"]').textContent = t().duplicate;
    node.querySelector('[data-ev="delete"]').textContent = t().delete;
    if (ev.id === state.editingId) li.querySelector('.event').classList.add('editing');
    items.push(node);
  }
  els.list.replaceChildren(...items);
}

function renderCombined() {
  const enough = state.events.length >= 2;
  els.combinedToggle.disabled = !enough;
  if (!enough) state.combined = false;
  els.combinedToggle.checked = state.combined;
  els.combinedPanel.hidden = !state.combined;
  const panel = els.combinedPanel.querySelector('[data-qr-panel]');
  if (state.combined) {
    renderQrPanel(panel, serializeCalendar(state.events, { now: SESSION_NOW, tz: state.tz }), t().combined_title, 'calqrii-all-events');
  } else {
    panel.replaceChildren();
  }
}

function renderShareInfo() {
  const any = state.events.length > 0;
  els.copyLink.disabled = !any;
  els.linkInfo.textContent = t().link_note + (any && shareURL().length > LINK_LONG_CHARS ? ' ' + t().link_long : '');
  els.tzInfo.textContent = t().tz_note(state.tz);
}

function render() {
  renderCalendar();
  renderSelection();
  renderEditorState();
  renderList();
  renderCombined();
  renderShareInfo();
}

// --- share link (fragment only; never written to the address bar)

/** Built from state.events, never from the form: the link must describe the QR codes on the page. */
function shareURL() {
  return location.origin + location.pathname + '#' + encodeFragment({ events: state.events, tz: state.tz });
}

function flash(button, text) {
  button.textContent = text;
  button.disabled = true;
  setTimeout(() => { button.textContent = t()[button.dataset.i18n]; button.disabled = false; }, 1500);
}

async function copyLink() {
  const url = shareURL();
  try {
    await navigator.clipboard.writeText(url);
    flash(els.copyLink, t().copied);
    state.dirty = false; // the user holds the only durable copy now
  } catch {
    showBanner(t().copy_failed + ' ' + url, [], { error: true });
  }
}

function applyLoaded(res) {
  state.events = res.events.map((ev) => ({ ...ev, id: state.nextId++ }));
  state.tz = res.tz;
  sortEvents();
  const first = state.events[0];
  state.view = { year: Number(first.date.slice(0, 4)), month: Number(first.date.slice(5, 7)) };
  state.dirty = false;
  state.editingId = null;
  state.selected.clear();
  state.combined = false;
  resetEditor();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (res.tz !== browserTz) showBanner(t().tz_foreign(res.tz));
  else hideBanner();
}

function loadFragment() {
  const res = decodeFragment(location.hash.slice(1));
  if (res.status === 'empty') return false;
  if (res.status === 'error') { showBanner(t()[res.code], [], { error: true }); return false; }
  applyLoaded(res);
  return true;
}

function onHashChange() {
  const res = decodeFragment(location.hash.slice(1));
  if (res.status === 'empty') return;
  if (res.status === 'error') { showBanner(t()[res.code], [], { error: true }); return; }
  if (state.events.length === 0) { applyLoaded(res); render(); return; }
  showBanner(t().replace_q, [
    { label: t().replace_yes, onClick: () => { applyLoaded(res); render(); } },
    { label: t().replace_no, onClick: () => {} },
  ]);
}

// --- downloads

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function qrPngBlob(qr, scale = 8) {
  const modules = qr.size + 2 * QUIET_ZONE;
  const dim = modules * scale;
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) ctx.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

function onQrAction(panel, act) {
  const ics = panel.querySelector('pre.ics').textContent;
  const stem = panel.dataset.stem;
  if (act === 'ics') { download(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), stem + '.ics'); return; }
  const res = qrMemo.get(ics);
  if (!res || res.error) return;
  if (act === 'svg') download(new Blob([res.svg], { type: 'image/svg+xml' }), stem + '.svg');
  else if (act === 'png') qrPngBlob(res.qr).then((b) => download(b, stem + '.png')).catch((e) => showBanner(String(e.message || e), [], { error: true }));
}

function onPanelClick(e) {
  const act = e.target.closest('[data-act]');
  if (act) { onQrAction(act.closest('[data-qr-panel]'), act.dataset.act); return; }
  const evb = e.target.closest('[data-ev]');
  if (!evb) return;
  const id = Number(evb.closest('li').dataset.id);
  if (evb.dataset.ev === 'edit') editEvent(id);
  else if (evb.dataset.ev === 'duplicate') duplicateEvent(id);
  else if (evb.dataset.ev === 'delete') deleteEvent(id);
}

// --- boot

function main() {
  els = {
    banner: $('banner'), calendar: $('calendar'), selInfo: $('sel-info'), clearSel: $('clear-sel'),
    form: $('editor'), title: $('f-title'), allDay: $('f-allday'), daysMode: $('days-mode'),
    date: $('f-date'), start: $('f-start'), endDate: $('f-end-date'), end: $('f-end'),
    freq: $('f-freq'), repOpts: $('rep-opts'), interval: $('f-interval'), intervalUnit: $('f-interval-unit'),
    byDay: $('f-byday'), count: $('f-count'), until: $('f-until'), repNote: $('rep-note'), repDayNote: $('rep-day-note'),
    location: $('f-location'), desc: $('f-desc'), url: $('f-url'), formError: $('form-error'),
    save: $('save'), cancelEdit: $('cancel-edit'), list: $('event-list'), emptyList: $('empty-list'),
    combinedToggle: $('combined-toggle'), combinedPanel: $('combined-panel'), copyLink: $('copy-link'),
    linkInfo: $('link-info'), tzInfo: $('tz-info'), tplEvent: $('tpl-event'), tplQr: $('tpl-qr'),
  };
  resetEditor();
  applyLang((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');
  $('lang-en').addEventListener('click', () => applyLang('en'));
  $('lang-de').addEventListener('click', () => applyLang('de'));

  els.clearSel.addEventListener('click', () => { state.selected.clear(); syncDatesFromSelection(); render(); });
  els.form.addEventListener('submit', submitEditor);
  els.cancelEdit.addEventListener('click', cancelEdit);
  els.allDay.addEventListener('change', renderEditorState);
  els.freq.addEventListener('change', () => { ensureStartWeekday(); renderEditorState(); });
  els.interval.addEventListener('input', renderEditorState);
  for (const el of [els.date, els.endDate]) el.addEventListener('change', () => { syncSelectionFromDates(); render(); });
  els.daysMode.addEventListener('change', (e) => {
    if (e.target.name === 'days-mode') { state.mode = e.target.value; syncDatesFromSelection(); render(); }
  });
  els.list.addEventListener('click', onPanelClick);
  els.combinedPanel.addEventListener('click', onPanelClick);
  els.combinedToggle.addEventListener('change', () => { state.combined = els.combinedToggle.checked; renderCombined(); });
  els.copyLink.addEventListener('click', copyLink);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && state.events.length) { e.preventDefault(); e.returnValue = ''; }
  });

  loadFragment();
  render();
}

main();
