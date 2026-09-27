// calqrii web app: month grid → editor → events → one QR per event; an opened
// link lands in a read-only view of its events first.
//
// Zero-storage contract: this file never touches a storage API, the history
// or the address bar, and uses the network only through geocode.js from the
// address-search click after consent (scripts/web-smoke.mjs pins all of it).
// The only state that can leave the page otherwise is a share link the user
// asks for, and it lives in the #fragment.
import { renderMonth } from './calendar.js';
import { serializeEvent, serializeCalendar } from './ics.js';
import { decodeFragment, linkFor } from './fragment.js';
import { qrSvg, utf8Length, QUIET_ZONE } from './qr.js';
import { STR } from './i18n.js';
import { searchNominatim } from './geocode.js';
import {
  expandDraft, normalizeEvent, isValidDate, isValidTime, weekdayOf, compareDates, addDays, addMinutes, durationOption,
  presetRule, recurrencePreset, parseGeo, osmMapUrl, osmSearchUrl, DEFAULT_DURATION, LIMITS,
} from './model.js';

// One timestamp per page load: DTSTAMP must not drift between renders, or
// the QR of an unchanged event would change under the user's hands.
const SESSION_NOW = new Date();
const LINK_LONG_CHARS = 8000;
const MEMO_MAX = 200;
const UNDO_MS = 5000;
const MARK_SPAN_MAX_DAYS = 366;
const GEO_MIN_GAP_MS = 1000; // Nominatim's usage policy: at most one request per second

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
  payload: 'ics', // 'ics' | 'link': what the QR codes carry
  screen: 'editor', // 'editor' | 'view': an opened link lands in the read-only view
  openQr: new Set(), // ids of view cards whose code is shown
  geoConsent: false, // address search allowed for this page load; never stored
  geoAbort: null,
  dirty: false,
  focus: null,
};
let lang = 'en';
const t = () => STR[lang];
let els = null;
let bannerTimer = 0;
const qrMemo = new Map(); // QR text → qrSvg() result, or { error, bytes }
const panelData = new WeakMap(); // [data-qr-panel] → { text, ics, stem }: what was rendered, for the download buttons
const icsOpts = () => ({ now: SESSION_NOW, tz: state.tz });
const geoMemo = new Map(); // lang + query → address results, for this page load only (the policy asks for a cache)

// --- i18n

function applyLang(code) {
  lang = STR[code] ? code : 'en';
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const s = t()[el.dataset.i18n];
    if (typeof s === 'string') el.textContent = s;
  }
  for (const el of document.querySelectorAll('[data-wd]')) el.textContent = t().weekdays_short[Number(el.dataset.wd)];
  for (const el of document.querySelectorAll('[data-dur]')) el.textContent = t().dur_label(Number(el.dataset.dur));
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t()[el.dataset.i18nAria]);
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

/** The frequency the form means: a preset, or the custom block's own select. */
function effectiveFreq() {
  return els.freq.value === 'custom' ? els.cfreq.value : els.freq.value;
}

function readEditor() {
  const custom = els.freq.value === 'custom';
  const freq = effectiveFreq();
  const ends = document.querySelector('input[name="f-ends"]:checked').value;
  // A preset stands for "every 1 unit, weekly on the start weekday"; only the
  // custom block reads its fields, so stale ticks under a preset never leak.
  const rule = custom
    ? { interval: els.interval.value, byDay: [...els.byDay.querySelectorAll('input:checked')].map((c) => c.value) }
    : presetRule(freq, els.date.value);
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
    geo: els.geo.value,
    recurrence: {
      freq,
      ...rule,
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
  els.duration.value = durationOption(ev, String(DEFAULT_DURATION));
  els.location.value = ev.location;
  els.desc.value = ev.description;
  els.url.value = ev.url;
  els.geo.value = ev.geo;
  syncOsmSearch();
  state.geoAbort?.abort(); // a reply for the previous form must not land under this one
  clearGeoResults();
  const r = ev.recurrence;
  els.freq.value = recurrencePreset(r, ev.date);
  els.cfreq.value = r.freq === 'none' ? 'weekly' : r.freq;
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
  els.duration.value = String(DEFAULT_DURATION);
  els.interval.value = '1';
  els.count.value = '10';
  syncOsmSearch();
  state.geoAbort?.abort();
  clearGeoResults();
  showFormErrors([]);
}

/** The OpenStreetMap search link follows the Location field: a plain link, nothing is sent unless it is followed. */
function syncOsmSearch() {
  els.osmSearch.href = osmSearchUrl(els.location.value);
}

// --- address search: the page's only network action, opt-in per page load

function onGeoSearch() {
  const query = els.location.value.trim();
  if (query === '') { showBanner(t().geo_empty, [], { timeoutMs: UNDO_MS, error: true }); return; }
  if (!state.geoConsent) {
    showBanner(t().geo_consent, [
      { label: t().geo_continue, onClick: () => { state.geoConsent = true; onGeoSearch(); } },
      { label: t().cancel, onClick: () => {} },
    ]);
    return;
  }
  if (els.geoSearch.disabled) return;
  const key = `${lang}\n${query}`;
  if (geoMemo.has(key)) { showGeoResults(geoMemo.get(key)); return; }
  const started = Date.now();
  state.geoAbort = new AbortController();
  els.geoSearch.disabled = true;
  els.geoSearch.textContent = t().geo_searching;
  searchNominatim(query, lang, { signal: state.geoAbort.signal })
    .then((results) => { geoMemo.set(key, results); showGeoResults(results); })
    .catch((e) => { if (e.code !== 'aborted') showBanner(geoErrorText(e), [], { error: true }); })
    .finally(() => {
      // Re-enabled no sooner than one second after the start: the rate limit.
      const left = Math.max(0, GEO_MIN_GAP_MS - (Date.now() - started));
      setTimeout(() => { els.geoSearch.disabled = false; els.geoSearch.textContent = t().geo_search; }, left);
    });
}

function showGeoResults(results) {
  if (results.length === 0) { clearGeoResults(); showBanner(t().geo_none, [], { timeoutMs: UNDO_MS }); return; }
  const items = results.map((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = r.label;
    b.addEventListener('click', () => chooseGeo(r));
    li.appendChild(b);
    return li;
  });
  els.geoList.replaceChildren(...items);
  els.geoResults.hidden = false;
}

function chooseGeo(r) {
  els.location.value = r.label;
  els.geo.value = r.geo;
  clearGeoResults();
  syncOsmSearch();
}

function clearGeoResults() {
  els.geoList.replaceChildren();
  els.geoResults.hidden = true;
}

function geoErrorText(e) {
  switch (e && e.code) {
    case 'http': return t().geo_err_http(e.status);
    case 'timeout': return t().geo_err_timeout;
    case 'bad_response': return t().geo_err_bad;
    case 'empty': return t().geo_empty;
    default: return t().geo_err_network;
  }
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
  // A span picked in the grid is re-read (→ "other"); one day or "each" carries the end along.
  const span = !each && days.length >= 2;
  if (span || !applyDuration()) syncDurationSelect();
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

/** Custom weekly rule: the start day's weekday is always ticked (validateEvent insists); presets derive it. */
function ensureStartWeekday() {
  if (els.freq.value !== 'custom' || els.cfreq.value !== 'weekly' || !isValidDate(els.date.value)) return;
  const wd = weekdayOf(els.date.value);
  const box = els.byDay.querySelector(`input[value="${wd}"]`);
  if (box && ![...els.byDay.querySelectorAll('input')].some((c) => c.checked && c.value === wd)) box.checked = true;
}

/**
 * Preset + valid start → end = start + duration; the end date follows unless
 * the date fields are blank ("each"). A selection of 2+ days shrinks to the
 * start day (expandDraft 'span' would take the end date from it). Returns
 * false when nothing was applied ("other", or no valid start).
 */
function applyDuration() {
  if (els.duration.value === 'custom' || !isValidTime(els.start.value)) return false;
  const date = eachMode() || !isValidDate(els.date.value) ? '' : els.date.value;
  const end = addMinutes(date, els.start.value, Number(els.duration.value));
  els.end.value = end.time;
  if (date !== '') {
    els.endDate.value = end.date;
    if (state.selected.size > 1) state.selected = new Set([date]); // a new Set: followStart() compares identity
  }
  return true;
}

/** The select re-reads the fields; all-day hides it, so its value is left alone. */
function syncDurationSelect() {
  if (els.allDay.checked) return;
  els.duration.value = durationOption(readEditor(), els.duration.value);
}

/** Start or duration changed: the end follows; render only if the selection shrank (no list re-render per keystroke). */
function followStart() {
  const sel = state.selected;
  applyDuration();
  if (state.selected !== sel) render();
}

function onDurationChange() {
  if (els.duration.value === 'custom') els.end.focus();
  else followStart();
}

function onFromDateChange() {
  syncSelectionFromDates();
  if (!applyDuration()) syncDurationSelect();
  render();
}

function onToDateChange() {
  syncSelectionFromDates();
  syncDurationSelect();
  render();
}

function onFreqChange() {
  const v = els.freq.value;
  if (v !== 'none' && v !== 'custom') els.cfreq.value = v; // "Custom…" then opens on the last preset
  ensureStartWeekday();
  renderEditorState();
}

/** Summary of the rule as the form stands; unfinished fields (NaN count, 'invalid' until) are left out. */
function repSummaryText() {
  const rec = normalizeEvent(readEditor()).recurrence;
  if (rec.freq === 'none' || !(Number.isInteger(rec.interval) && rec.interval >= 1)) return '';
  const clean = {
    ...rec,
    count: Number.isInteger(rec.count) && rec.count >= 1 ? rec.count : null,
    until: isValidDate(rec.until) ? rec.until : null,
  };
  return t().rec_summary(clean, t().weekday_codes);
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
  showBanner(t().deleted, [{ label: t().undo, onClick: () => undoDelete(removed) }], { timeoutMs: UNDO_MS });
}

function undoDelete(removed) {
  if (state.events.length >= LIMITS.events) { showBanner(t().err_too_many, [], { timeoutMs: UNDO_MS, error: true }); return; }
  state.events.push(removed);
  sortEvents();
  state.dirty = true;
  render();
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
  const each = eachMode();
  els.date.disabled = each;
  els.endDate.disabled = each;
  els.save.textContent = editing ? t().save : t().add_n(each ? n : 1);
  els.cancelEdit.hidden = !editing;
  const allDay = els.allDay.checked;
  els.start.hidden = allDay;
  els.end.hidden = allDay;
  els.durRow.hidden = allDay;
  if (allDay) { els.start.value = ''; els.end.value = ''; }
  const custom = els.freq.value === 'custom';
  const freq = effectiveFreq();
  els.repOpts.hidden = freq === 'none';
  els.repCustom.hidden = !custom;
  els.byDay.hidden = !(custom && freq === 'weekly');
  const interval = Number(els.interval.value) || 1;
  els.intervalUnit.textContent = freq === 'none' ? '' : t().f_interval_unit(freq, interval);
  els.repNote.hidden = allDay;
  const day = isValidDate(els.date.value) ? Number(els.date.value.slice(8)) : 0;
  els.repDayNote.hidden = !((freq === 'monthly' || freq === 'yearly') && day > 28);
  const summary = repSummaryText();
  els.repSummary.textContent = summary; // cleared, not just hidden: aria-describedby reads hidden text too
  els.repSummary.hidden = summary === '';
}

function svgNode(text) {
  // Parsed as XML and inserted as a node, never assigned as an HTML string:
  // qr.js emits geometry only, but that invariant lives in another module.
  const root = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (root.nodeName !== 'svg' || root.querySelector('parsererror')) return null;
  return document.importNode(root, true);
}

function qrFor(text) {
  let res = qrMemo.get(text);
  if (!res) {
    try {
      res = qrSvg(text);
    } catch (e) {
      res = { error: e && e.message === 'too_big' ? 'too_big' : String(e), bytes: utf8Length(text) };
    }
    if (qrMemo.size >= MEMO_MAX) qrMemo.clear();
    qrMemo.set(text, res);
  }
  return res;
}

/**
 * Fills a [data-qr-panel]: the code from `text`, the .ics download from `ics`,
 * the too-big message from `tooBig(bytes)`; `kind` ('ics' | 'link') only
 * labels what the code contains; `ev` (null for the combined code) feeds the
 * print sheet — it never reads the form.
 */
function renderQrPanel(panel, { text, ics, title, stem, kind = 'ics', tooBig, ev = null }) {
  const node = els.tplQr.content.cloneNode(true);
  const res = qrFor(text);
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
    err.textContent = res.error === 'too_big' ? tooBig(res.bytes) : res.error;
    err.hidden = false;
    for (const b of node.querySelectorAll('[data-act="svg"], [data-act="png"], [data-act="print"], [data-act="copy"]')) b.disabled = true;
  }
  node.querySelector('[data-act="svg"]').textContent = t().dl_svg;
  node.querySelector('[data-act="png"]').textContent = t().dl_png;
  node.querySelector('[data-act="ics"]').textContent = t().dl_ics;
  node.querySelector('[data-act="print"]').textContent = t().print_qr;
  node.querySelector('[data-act="copy"]').textContent = t().copy_qr;
  node.querySelector('.show-text').textContent = kind === 'link' ? t().show_link : t().show_ics;
  const pre = node.querySelector('pre.qr-text');
  pre.textContent = text;
  pre.classList.toggle('link', kind === 'link'); // a URL is one long line: wrap it
  panelData.set(panel, { text, ics, stem, kind, ev });
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

/** Location text plus a "Map" link when the event has a position; the paragraph hides when both are empty. */
function fillWhere(p, ev) {
  p.querySelector('.where-text').textContent = ev.location;
  const a = p.querySelector('.where-map');
  const mapUrl = osmMapUrl(ev.geo);
  a.hidden = mapUrl === '';
  if (mapUrl) {
    a.href = mapUrl;
    a.textContent = t().map_link;
    a.setAttribute('aria-label', t().map_aria(ev.title));
  }
  p.hidden = ev.location === '' && mapUrl === '';
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
  const opts = icsOpts();
  const link = state.payload === 'link';
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
    fillWhere(node.querySelector('.ev-where'), ev);
    const ics = serializeEvent(ev, opts);
    renderQrPanel(node.querySelector('[data-qr-panel]'), {
      text: link ? eventLink(ev) : ics, ics, title: ev.title, stem: fileStem(ev), kind: state.payload,
      tooBig: link ? t().qr_too_big_link : t().qr_too_big, ev,
    });
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
  const link = state.payload === 'link';
  els.combinedToggle.disabled = !enough;
  if (!enough) state.combined = false;
  els.combinedToggle.checked = state.combined;
  els.combinedPanel.hidden = !state.combined;
  // As calendar data the combined code is experimental (scanners read one event); as a link it carries them all.
  els.combinedLabel.textContent = link ? t().combined_label_link : t().combined_label;
  els.combinedNote.textContent = link ? t().combined_note_link : t().combined_note;
  els.combinedNote.classList.toggle('warn', !link);
  const panel = els.combinedPanel.querySelector('[data-qr-panel]');
  if (state.combined) {
    const ics = serializeCalendar(state.events, icsOpts());
    renderQrPanel(panel, { text: link ? shareURL() : ics, ics, title: t().combined_title, stem: 'calqrii-all-events', kind: state.payload, tooBig: t().qr_too_big_all });
  } else {
    panel.replaceChildren();
    panelData.delete(panel);
  }
}

function renderShareInfo() {
  const any = state.events.length > 0;
  els.copyLink.disabled = !any;
  els.linkInfo.textContent = t().link_note + (any && shareURL().length > LINK_LONG_CHARS ? ' ' + t().link_long : '');
  els.tzInfo.textContent = t().tz_note(state.tz);
}

function renderPayload() {
  // Set from state on every render: Firefox restores radio state across reloads, the page must not.
  els.payload.querySelector(`input[value="${state.payload}"]`).checked = true;
}

// --- view: the events of an opened link, read-only

function dateBadge(date) {
  // The i18n tables, not Intl parts: the names match the grid's, and no form field is read (gate §7).
  return {
    weekday: t().weekday_codes[weekdayOf(date)],
    day: String(Number(date.slice(8))),
    month: t().months[Number(date.slice(5, 7)) - 1].slice(0, 3),
  };
}

function showText(el, s) {
  el.textContent = s;
  el.hidden = s === '';
}

function renderView() {
  const items = [];
  for (const ev of state.events) {
    const node = els.tplViewCard.content.cloneNode(true);
    node.querySelector('li').dataset.id = String(ev.id);
    const badge = dateBadge(ev.date);
    node.querySelector('.db-wd').textContent = badge.weekday;
    node.querySelector('.db-day').textContent = badge.day;
    node.querySelector('.db-month').textContent = badge.month;
    node.querySelector('.view-title').textContent = ev.title;
    node.querySelector('.view-when').textContent = whenText(ev);
    showText(node.querySelector('.view-rec'), recText(ev));
    fillWhere(node.querySelector('.view-where'), ev);
    showText(node.querySelector('.view-desc'), ev.description);
    const urlP = node.querySelector('.view-url');
    urlP.hidden = !/^https?:\/\//.test(ev.url);
    if (!urlP.hidden) { const a = urlP.querySelector('a'); a.href = ev.url; a.textContent = ev.url; }
    node.querySelector('[data-view="add"]').textContent = t().view_add;
    const qrBtn = node.querySelector('[data-view="qr"]');
    const panel = node.querySelector('[data-qr-panel]');
    panel.id = `view-qr-${ev.id}`;
    qrBtn.setAttribute('aria-controls', panel.id);
    setViewQr(qrBtn, panel, ev, state.openQr.has(ev.id));
    items.push(node);
  }
  els.viewList.replaceChildren(...items);
  els.viewAddAll.hidden = state.events.length < 2;
}

/** The card's offline code, toggled in place so keyboard focus stays on the button. */
function setViewQr(btn, panel, ev, open) {
  btn.textContent = open ? t().view_hide_qr : t().view_show_qr;
  btn.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  if (open) {
    const ics = serializeEvent(ev, icsOpts());
    renderQrPanel(panel, { text: ics, ics, title: ev.title, stem: fileStem(ev), kind: 'ics', tooBig: t().qr_too_big, ev });
  } else {
    panel.replaceChildren();
    panelData.delete(panel);
  }
}

function editShared() {
  state.screen = 'editor';
  render();
  els.form.scrollIntoView({ block: 'start' });
}

function render() {
  const view = state.screen === 'view' && state.events.length > 0;
  els.viewSection.hidden = !view;
  for (const el of [els.calendarSection, els.form, els.eventsSection]) el.hidden = view;
  document.title = view ? `${state.events[0].title} · calqrii` : t().title;
  if (view) { renderView(); return; } // nothing else is visible; up to 200 hidden codes would be wasted work
  renderCalendar();
  renderSelection();
  renderEditorState();
  renderPayload();
  renderList();
  renderCombined();
  renderShareInfo();
}

// --- share link (fragment only; never written to the address bar)

/** Where this copy of the page lives — never a hard-coded origin (the page is self-hostable). */
function pageBase() {
  return location.origin + location.pathname;
}

/** Built from state.events, never from the form: the link must describe the QR codes on the page. */
function shareURL() {
  return linkFor(pageBase(), state.events, state.tz);
}

/** One event's own link: what a link-mode QR carries; it opens the page with exactly this event. */
function eventLink(ev) {
  return linkFor(pageBase(), [ev], state.tz);
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
  state.screen = 'view';
  state.openQr.clear();
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
  const load = () => { applyLoaded(res); render(); };
  // The view holds a link's events unedited, and the previous link is one Back away: replace without asking.
  if (state.events.length === 0 || state.screen === 'view') { load(); return; }
  showBanner(t().replace_q, [
    { label: t().replace_yes, onClick: load },
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

function downloadIcs(text, stem) {
  download(new Blob([text], { type: 'text/calendar;charset=utf-8' }), stem + '.ics');
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

function onQrAction(panel, act, button) {
  const data = panelData.get(panel);
  if (!data) return;
  if (act === 'ics') { downloadIcs(data.ics, data.stem); return; }
  if (act === 'print') { printPanel(panel); return; }
  if (act === 'copy') { copyPanel(panel, button); return; }
  const res = qrFor(data.text); // the memo may have been cleared since the panel was rendered
  if (res.error) return;
  if (act === 'svg') download(new Blob([res.svg], { type: 'image/svg+xml' }), data.stem + '.svg');
  else if (act === 'png') qrPngBlob(res.qr).then((b) => download(b, data.stem + '.png')).catch((e) => showBanner(String(e.message || e), [], { error: true }));
}

// --- print sheet and clipboard

/** Title, when, where, the code, a hint (and the URL for a link code) — from the panel's data, never the form. */
function fillPrintSheet(data) {
  const s = els.printSheet;
  s.querySelector('.ps-title').textContent = data.ev ? data.ev.title : t().combined_title;
  s.querySelector('.ps-when').textContent = data.ev ? whenText(data.ev) : '';
  s.querySelector('.ps-where').textContent = data.ev ? data.ev.location : '';
  const res = qrFor(data.text);
  const svg = res.error ? null : svgNode(res.svg);
  s.querySelector('.ps-qr').replaceChildren(...(svg ? [svg] : []));
  s.querySelector('.ps-hint').textContent = data.kind === 'link' ? t().print_hint_link : t().print_hint_ics;
  s.querySelector('.ps-link').textContent = data.kind === 'link' ? data.text : '';
}

function printPanel(panel) {
  const data = panelData.get(panel);
  if (!data) return;
  fillPrintSheet(data);
  document.body.classList.add('print-one'); // the print CSS shows only the sheet while this class is set
  window.print();
}

function clearPrintSheet() {
  document.body.classList.remove('print-one');
  for (const el of els.printSheet.children) el.replaceChildren();
}

async function copyPanel(panel, button) {
  const data = panelData.get(panel);
  if (!data) return;
  const res = qrFor(data.text);
  if (res.error) return;
  try {
    if (typeof ClipboardItem === 'undefined') throw new Error('no ClipboardItem');
    // The blob promise goes in as is: Safari requires write() to start inside the user gesture.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': qrPngBlob(res.qr) })]);
    flash(button, t().copied_qr);
  } catch {
    showBanner(t().copy_qr_failed, [], { error: true });
  }
}

function onPanelClick(e) {
  const act = e.target.closest('[data-act]');
  if (act) { onQrAction(act.closest('[data-qr-panel]'), act.dataset.act, act); return; }
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) {
    const li = viewBtn.closest('li');
    const ev = state.events.find((x) => x.id === Number(li.dataset.id));
    if (!ev) return;
    if (viewBtn.dataset.view === 'add') {
      downloadIcs(serializeEvent(ev, icsOpts()), fileStem(ev));
    } else if (viewBtn.dataset.view === 'qr') {
      const open = !state.openQr.has(ev.id);
      if (open) state.openQr.add(ev.id); else state.openQr.delete(ev.id);
      setViewQr(viewBtn, li.querySelector('[data-qr-panel]'), ev, open);
    }
    return;
  }
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
    duration: $('f-duration'), durRow: $('dur-row'),
    freq: $('f-freq'), cfreq: $('f-cfreq'), repOpts: $('rep-opts'), repCustom: $('rep-custom'), repSummary: $('rep-summary'),
    interval: $('f-interval'), intervalUnit: $('f-interval-unit'),
    byDay: $('f-byday'), count: $('f-count'), until: $('f-until'), repNote: $('rep-note'), repDayNote: $('rep-day-note'),
    location: $('f-location'), desc: $('f-desc'), url: $('f-url'), geo: $('f-geo'), osmSearch: $('osm-search'), formError: $('form-error'),
    geoSearch: $('geo-search'), geoResults: $('geo-results'), geoList: $('geo-list'),
    save: $('save'), cancelEdit: $('cancel-edit'), list: $('event-list'), emptyList: $('empty-list'),
    combinedToggle: $('combined-toggle'), combinedPanel: $('combined-panel'), copyLink: $('copy-link'),
    payload: $('payload'), combinedLabel: $('combined-label'), combinedNote: $('combined-note'),
    calendarSection: $('calendar-section'), eventsSection: $('events'), viewSection: $('view-section'),
    viewList: $('view-list'), viewAddAll: $('view-add-all'), viewEdit: $('view-edit'), tplViewCard: $('tpl-view-card'),
    printSheet: $('print-sheet'),
    linkInfo: $('link-info'), tzInfo: $('tz-info'), tplEvent: $('tpl-event'), tplQr: $('tpl-qr'),
  };
  resetEditor();
  applyLang((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');
  $('lang-en').addEventListener('click', () => applyLang('en'));
  $('lang-de').addEventListener('click', () => applyLang('de'));

  els.clearSel.addEventListener('click', () => { state.selected.clear(); syncDatesFromSelection(); render(); });
  els.form.addEventListener('submit', submitEditor);
  els.cancelEdit.addEventListener('click', cancelEdit);
  // Unticking "All day" leaves blank times: the select keeps its preset, or shows "other" across days.
  els.allDay.addEventListener('change', () => { syncDurationSelect(); renderEditorState(); });
  els.freq.addEventListener('change', onFreqChange);
  els.cfreq.addEventListener('change', () => { ensureStartWeekday(); renderEditorState(); });
  // Interval, weekday chips, "Ends" radios, count and until all feed the summary line.
  els.repOpts.addEventListener('input', renderEditorState);
  els.start.addEventListener('input', followStart);
  els.end.addEventListener('input', syncDurationSelect);
  els.duration.addEventListener('change', onDurationChange);
  els.date.addEventListener('change', onFromDateChange);
  els.endDate.addEventListener('change', onToDateChange);
  els.location.addEventListener('input', () => { syncOsmSearch(); clearGeoResults(); });
  els.geoSearch.addEventListener('click', onGeoSearch);
  // Show what was understood: a pasted map link turns into the canonical 'lat,lon'.
  els.geo.addEventListener('change', () => { const g = parseGeo(els.geo.value); if (g) els.geo.value = g; });
  els.daysMode.addEventListener('change', (e) => {
    if (e.target.name === 'days-mode') { state.mode = e.target.value; syncDatesFromSelection(); render(); }
  });
  els.list.addEventListener('click', onPanelClick);
  els.combinedPanel.addEventListener('click', onPanelClick);
  els.combinedToggle.addEventListener('change', () => { state.combined = els.combinedToggle.checked; renderCombined(); });
  els.payload.addEventListener('change', (e) => {
    if (e.target.name !== 'payload') return;
    state.payload = e.target.value === 'link' ? 'link' : 'ics';
    renderList();
    renderCombined();
  });
  els.copyLink.addEventListener('click', copyLink);
  els.viewList.addEventListener('click', onPanelClick);
  els.viewAddAll.addEventListener('click', () => downloadIcs(serializeCalendar(state.events, icsOpts()), 'calqrii-all-events'));
  els.viewEdit.addEventListener('click', editShared);
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('afterprint', clearPrintSheet);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && state.events.length) { e.preventDefault(); e.returnValue = ''; }
  });

  loadFragment();
  render();
}

main();
