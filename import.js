// calqrii import page: a calendar file or a copied event list → a pick list →
// a share link that opens the chosen events in the main page (view, QR codes,
// .ics, editing). Same zero-storage contract as app.js: no storage, no
// history or address-bar writes, no network at all (scripts/web-smoke.mjs).
import { parseInput } from './parse.js';
import { linkFor, MAX_E_LENGTH } from './fragment.js';
import { STR } from './i18n.js';
import { osmMapUrl, LIMITS } from './model.js';

const PARSE_DELAY_MS = 150;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const state = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  kind: 'empty',
  items: [], // parseInput() items: { ev, warnings, errors, past }
  selected: new Set(), // ev.id
  showPast: false,
  link: '', // the share link of the selection, '' while none, pending or too long
  truncated: false,
};
let lang = 'en';
const t = () => STR[lang];
let els = null;
let parseTimer = 0;
let linkSeq = 0;

// --- i18n (the same mechanism as app.js, for this page's own elements)

function applyLang(code) {
  lang = STR[code] ? code : 'en';
  document.documentElement.lang = lang;
  document.title = t().imp_title;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const s = t()[el.dataset.i18n];
    if (typeof s === 'string') el.textContent = s;
  }
  $('lang-en').setAttribute('aria-pressed', String(lang === 'en'));
  $('lang-de').setAttribute('aria-pressed', String(lang === 'de'));
  $('lang-nav').setAttribute('aria-label', t().language);
  els.text.placeholder = t().imp_placeholder;
  render();
}

// --- parsing: whatever lands in the textarea, by file, drop or paste

function scheduleParse() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseNow, PARSE_DELAY_MS);
}

function parseNow() {
  clearTimeout(parseTimer);
  const { kind, items, truncated } = parseInput(els.text.value, { tz: state.tz, today: todayIso() });
  state.kind = kind;
  state.items = items;
  state.truncated = truncated;
  state.selected = new Set(items.filter((it) => it.errors.length === 0 && !it.past).map((it) => it.ev.id));
  state.showPast = false;
  render();
}

async function readFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { setStatus(t().imp_file_error, true); return; }
  try {
    els.text.value = await file.text();
  } catch {
    setStatus(t().imp_file_error, true);
    return;
  }
  parseNow();
}

function onDrop(e) {
  e.preventDefault();
  els.source.classList.remove('dragover');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) { readFile(file); return; }
  const text = e.dataTransfer ? e.dataTransfer.getData('text') : '';
  if (text) { els.text.value = text; parseNow(); }
}

function clearAll() {
  els.text.value = '';
  els.file.value = '';
  parseNow();
  els.text.focus();
}

// --- rendering

function setStatus(text, error = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', error);
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

function errorText(key) {
  const s = t()[key];
  if (typeof s === 'function') {
    const field = key.replace(/^err_/, '').replace(/_long$/, '');
    return s(LIMITS[field]);
  }
  return typeof s === 'string' ? s : key;
}

function showText(el, s) {
  el.textContent = s;
  el.hidden = s === '';
}

function selectableItems() {
  return state.items.filter((it) => it.errors.length === 0);
}

function renderList() {
  const nodes = [];
  for (const it of state.items) {
    const { ev } = it;
    if (it.past && !state.showPast) continue;
    const node = els.tplCard.content.cloneNode(true);
    const card = node.querySelector('.imp-card');
    const check = node.querySelector('.imp-check');
    check.dataset.id = String(ev.id);
    check.checked = state.selected.has(ev.id);
    check.disabled = it.errors.length > 0;
    card.classList.toggle('past', it.past);
    card.classList.toggle('invalid', it.errors.length > 0);
    card.classList.toggle('checked', check.checked);
    node.querySelector('.imp-title').textContent = ev.title || t().imp_untitled;
    showText(node.querySelector('.imp-when'), it.errors.length ? '' : whenText(ev) + (it.past ? ` · ${t().imp_past}` : ''));
    showText(node.querySelector('.imp-rec'), it.errors.length ? '' : t().rec_summary(ev.recurrence, t().weekday_codes));
    showText(node.querySelector('.imp-where'), ev.location || (osmMapUrl(ev.geo) ? ev.geo : ''));
    showText(node.querySelector('.imp-desc'), ev.description.length > 160 ? ev.description.slice(0, 157) + '…' : ev.description);
    showText(node.querySelector('.imp-warn'), it.warnings.map((w) => t()[w]).filter(Boolean).join(' '));
    showText(node.querySelector('.imp-err'), it.errors.length ? `${t().imp_invalid} ${it.errors.map(errorText).join(' ')}` : '');
    nodes.push(node);
  }
  els.list.replaceChildren(...nodes);
}

function render() {
  const n = state.items.length;
  const pastCount = state.items.filter((it) => it.past).length;
  els.clear.hidden = els.text.value === '';
  els.result.hidden = n === 0;
  els.bar.hidden = n === 0;
  if (state.kind === 'empty') setStatus('');
  else if (n === 0) setStatus(t().imp_none, true);
  else setStatus(t().imp_found(n, state.kind) + (state.truncated ? ' ' + t().imp_truncated : ''), state.truncated);
  els.pastRow.hidden = pastCount === 0;
  els.showPastLabel.textContent = t().imp_show_past(pastCount);
  els.showPast.checked = state.showPast;
  renderList();
  renderBar();
}

/** The link describes state.selected only; rendered as a plain <a href>, so opening it is an ordinary navigation. */
async function renderBar() {
  const seq = ++linkSeq;
  const chosen = selectableItems().filter((it) => state.selected.has(it.ev.id)).map((it) => it.ev);
  els.count.textContent = t().imp_selected(chosen.length);
  setLink('', ''); // never offer the previous selection's link while the new one is computed
  let note = '';
  let link = '';
  if (chosen.length > LIMITS.events) note = t().imp_too_many(LIMITS.events);
  else if (chosen.length > 0) {
    try {
      link = await linkFor(pageBase(), chosen, state.tz);
    } catch (e) {
      note = String(e && e.message ? e.message : e);
    }
    if (seq !== linkSeq) return; // a newer selection has its own link under way
    if (link.length - link.indexOf('#') > MAX_E_LENGTH) { note = t().link_too_long; link = ''; }
  }
  setLink(link, note);
}

function setLink(link, note) {
  state.link = link;
  if (link) els.open.href = link;
  else els.open.removeAttribute('href');
  els.open.setAttribute('aria-disabled', String(link === ''));
  els.copy.disabled = link === '';
  showText(els.linkNote, note);
}

/** The directory this page lives in: the main page is its index. */
function pageBase() {
  return location.origin + location.pathname.replace(/[^/]*$/, '');
}

async function copyLink() {
  if (!state.link) return;
  try {
    await navigator.clipboard.writeText(state.link);
    showText(els.linkNote, t().copied);
  } catch {
    showText(els.linkNote, `${t().copy_failed} ${state.link}`);
  }
}

// --- events

function onListChange(e) {
  const check = e.target.closest('.imp-check');
  if (!check) return;
  const id = Number(check.dataset.id);
  if (check.checked) state.selected.add(id);
  else state.selected.delete(id);
  check.closest('.imp-card').classList.toggle('checked', check.checked);
  renderBar();
}

function selectAll(on) {
  state.selected = new Set(on ? selectableItems().filter((it) => state.showPast || !it.past).map((it) => it.ev.id) : []);
  renderList();
  renderBar();
}

function init() {
  els = {
    source: $('imp-source'), file: $('imp-file'), text: $('imp-text'), clear: $('imp-clear'), status: $('imp-status'),
    result: $('imp-result'), list: $('imp-list'), all: $('imp-all'), none: $('imp-none'),
    pastRow: $('imp-past-row'), showPast: $('imp-show-past'), showPastLabel: $('imp-show-past-label'),
    bar: $('imp-bar'), count: $('imp-count'), open: $('imp-open'), copy: $('imp-copy'), linkNote: $('imp-link-note'),
    tplCard: $('tpl-imp-card'),
  };
  $('lang-en').addEventListener('click', () => applyLang('en'));
  $('lang-de').addEventListener('click', () => applyLang('de'));
  els.file.addEventListener('change', () => readFile(els.file.files && els.file.files[0]));
  els.text.addEventListener('input', scheduleParse);
  els.clear.addEventListener('click', clearAll);
  els.source.addEventListener('dragover', (e) => { e.preventDefault(); els.source.classList.add('dragover'); });
  els.source.addEventListener('dragleave', () => els.source.classList.remove('dragover'));
  els.source.addEventListener('drop', onDrop);
  // A file dropped elsewhere on the page must not navigate the browser to it.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  els.list.addEventListener('change', onListChange);
  els.all.addEventListener('click', () => selectAll(true));
  els.none.addEventListener('click', () => selectAll(false));
  els.showPast.addEventListener('change', () => { state.showPast = els.showPast.checked; renderList(); });
  els.copy.addEventListener('click', copyLink);
  els.open.addEventListener('click', (e) => { if (!state.link) e.preventDefault(); });
  applyLang((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en');
}

init();
