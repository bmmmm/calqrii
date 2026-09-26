// Event model: defaults, normalization, validation and the draft expander.
// Pure data, no DOM. Everything the page holds lives in memory only.

/** @typedef {'MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU'} Weekday */
/** @typedef {{ freq:'none'|'daily'|'weekly'|'monthly'|'yearly', interval:number,
 *   byDay:Weekday[], count:number|null, until:string|null }} Recurrence */
/** @typedef {{ id:number, title:string, allDay:boolean, date:string, endDate:string,
 *   startTime:string, endTime:string, description:string, location:string, url:string,
 *   recurrence:Recurrence }} CalEvent */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const FREQS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
export const LIMITS = { title: 200, location: 200, description: 1000, url: 500, events: 200 };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/\S+$/;

export function isValidDate(s) {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Round-trip through Date.UTC: 2026-02-30 rolls over to March and is refused.
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

function toIso(t) {
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}`;
}

function fromIso(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date, n) {
  const t = fromIso(date);
  t.setUTCDate(t.getUTCDate() + n);
  return toIso(t);
}

/** Weekday code of an ISO date; column 0 of the grid is Monday. */
export function weekdayOf(date) {
  return WEEKDAYS[(fromIso(date).getUTCDay() + 6) % 7];
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const str = (v) => (typeof v === 'string' ? v : '').normalize('NFC').trim();

export function normalizeEvent(ev) {
  const src = ev || {};
  const rec = src.recurrence || {};
  const date = str(src.date);
  let endDate = str(src.endDate) || date;
  const allDay = src.allDay === true;
  const freq = FREQS.includes(rec.freq) ? rec.freq : 'none';
  const seen = new Set(Array.isArray(rec.byDay) ? rec.byDay : []);
  const byDay = freq === 'weekly' ? WEEKDAYS.filter((d) => seen.has(d)) : [];
  const out = {
    id: Number.isInteger(src.id) ? src.id : 0,
    title: str(src.title),
    allDay,
    date,
    endDate,
    startTime: allDay ? '' : str(src.startTime),
    endTime: allDay ? '' : str(src.endTime),
    description: str(src.description),
    location: str(src.location),
    url: str(src.url),
    recurrence: {
      freq,
      interval: freq === 'none' ? 1 : num(rec.interval, 1),
      byDay,
      count: freq === 'none' ? null : nullableNum(rec.count),
      until: freq === 'none' ? null : (str(rec.until) || null),
    },
  };
  return out;
}

function num(v, dflt) {
  return typeof v === 'number' ? v : (v === '' || v === null || v === undefined) ? dflt : Number(v);
}

function nullableNum(v) {
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : Number(v);
}

export function newEvent(partial = {}) {
  return normalizeEvent({
    id: 0,
    title: '',
    allDay: false,
    date: '',
    endDate: '',
    startTime: '',
    endTime: '',
    description: '',
    location: '',
    url: '',
    ...partial,
    recurrence: { freq: 'none', interval: 1, byDay: [], count: null, until: null, ...(partial.recurrence || {}) },
  });
}

const cp = (s) => [...s].length;

/** Returns i18n error keys; [] means valid. Expects a normalized event. */
export function validateEvent(ev) {
  const errs = new Set();
  if (ev.title === '') errs.add('err_title_required');
  if (cp(ev.title) > LIMITS.title || cp(ev.location) > LIMITS.location
    || cp(ev.description) > LIMITS.description || cp(ev.url) > LIMITS.url) errs.add('err_too_long');
  const dateOk = isValidDate(ev.date);
  const endOk = isValidDate(ev.endDate);
  if (!dateOk || !endOk) errs.add('err_date_invalid');
  if (!ev.allDay) {
    if (ev.startTime === '') errs.add('err_time_required');
    else if (!isValidTime(ev.startTime)) errs.add('err_time_invalid');
    if (ev.endTime !== '' && !isValidTime(ev.endTime)) errs.add('err_time_invalid');
  }
  if (dateOk && endOk) {
    const order = compareDates(ev.endDate, ev.date);
    if (order < 0) errs.add('err_end_before_start');
    if (!ev.allDay) {
      if (order > 0 && ev.endTime === '') errs.add('err_end_time_required');
      if (order === 0 && isValidTime(ev.startTime) && isValidTime(ev.endTime) && ev.endTime < ev.startTime) {
        errs.add('err_end_before_start');
      }
    }
  }
  if (ev.url !== '' && !URL_RE.test(ev.url)) errs.add('err_url_invalid');
  const rec = ev.recurrence;
  if (rec.freq !== 'none') {
    if (!Number.isInteger(rec.interval) || rec.interval < 1 || rec.interval > 99) errs.add('err_interval');
    if (rec.count !== null && (!Number.isInteger(rec.count) || rec.count < 1 || rec.count > 999)) errs.add('err_count');
    if (rec.until !== null) {
      if (!isValidDate(rec.until)) errs.add('err_date_invalid');
      else if (dateOk && compareDates(rec.until, ev.date) < 0) errs.add('err_until_before_start');
    }
    if (rec.count !== null && rec.until !== null) errs.add('err_count_and_until');
    if (rec.freq === 'weekly') {
      if (rec.byDay.length === 0) errs.add('err_byday_empty');
      // Clients disagree on whether DTSTART counts when its weekday is not in
      // BYDAY; refusing that shape keeps every scanner on the same schedule.
      else if (dateOk && !rec.byDay.includes(weekdayOf(ev.date))) errs.add('err_byday_start');
    }
  }
  return [...errs];
}

/**
 * Turns the editor draft plus the selected days into events.
 * 0–1 selected days → the draft as is; 'span' → one event from the first to
 * the last day; 'each' → one single-day copy per selected day (no series).
 */
export function expandDraft(draft, selectedDates, mode) {
  const days = [...new Set(selectedDates)].filter(isValidDate).sort(compareDates);
  const base = normalizeEvent(draft);
  let drafts;
  if (days.length <= 1) {
    drafts = [base];
  } else if (mode === 'span') {
    drafts = [{ ...base, date: days[0], endDate: days[days.length - 1] }];
  } else {
    if (base.recurrence.freq !== 'none') return { events: [], errors: ['err_each_repeat'] };
    drafts = days.map((d) => ({ ...base, date: d, endDate: d }));
  }
  const errors = new Set();
  const events = [];
  for (const d of drafts) {
    const ev = normalizeEvent(d);
    for (const e of validateEvent(ev)) errors.add(e);
    events.push(ev);
  }
  return errors.size ? { events: [], errors: [...errors] } : { events, errors: [] };
}
