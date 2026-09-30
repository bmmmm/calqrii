// Event model: defaults, normalization, validation and the draft expander.
// Pure data, no DOM. Everything the page holds lives in memory only.

/** @typedef {'MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU'} Weekday */
/** @typedef {{ freq:'none'|'daily'|'weekly'|'monthly'|'yearly', interval:number,
 *   byDay:Weekday[], count:number|null, until:string|null }} Recurrence */
/** @typedef {{ id:number, title:string, allDay:boolean, date:string, endDate:string,
 *   startTime:string, endTime:string, description:string, location:string, url:string,
 *   geo:string, recurrence:Recurrence }} CalEvent */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const FREQS = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
// Sanity caps (memory, share-link size), not QR limits: the QR code holds
// 2953 bytes in total and the editor's payload meter shows that budget live.
export const LIMITS = { title: 1000, location: 1000, description: 8000, url: 2000, events: 200 };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/\S+$/;
// Canonical 'lat,lon': ≤ 6 decimals, no trailing zeros, no leading zeros, no '+', no '-0'.
const GEO_NUM = String.raw`-?(?:0|[1-9]\d{0,2})(?:\.\d{0,5}[1-9])?`;
export const GEO_RE = new RegExp(String.raw`^(?!-0,)${GEO_NUM},(?!-0$)${GEO_NUM}$`);
const GEO_INPUT_MAX = 4096; // bounds parser work on pasted map URLs; not a stored-field limit

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

// --- duration: a UI derivative of start and end; the event keeps only the times

export const DURATIONS = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480];
export const DEFAULT_DURATION = 60;
const DAY_MIN = 1440;

/** Minutes since midnight for a valid 'HH:MM'; NaN otherwise. */
export function timeToMinutes(time) {
  return isValidTime(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;
}

/** 'HH:MM' for a minute count, wrapped into one day: 1470 → '00:30', -15 → '23:45'. */
export function minutesToTime(min) {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(m / 60), 2)}:${pad(m % 60, 2)}`;
}

/** Wall-clock start + minutes → { date, time }; the day carry moves the date; a blank date stays blank. */
export function addMinutes(date, time, minutes) {
  if (!isValidTime(time) || !Number.isInteger(minutes)) return null;
  const total = timeToMinutes(time) + minutes;
  return { date: isValidDate(date) ? addDays(date, Math.floor(total / DAY_MIN)) : date, time: minutesToTime(total) };
}

/**
 * Minutes from start to end of { date, startTime, endDate, endTime }. A blank
 * endDate counts as the same day (normalizeEvent defaults it to date); NaN
 * when a time or a given date is invalid.
 */
export function spanMinutes(ev) {
  const end = ev.endDate;
  const days = end === '' ? 0
    : isValidDate(ev.date) && isValidDate(end) ? Math.round((fromIso(end) - fromIso(ev.date)) / 86400000) : NaN;
  return days * DAY_MIN + timeToMinutes(ev.endTime) - timeToMinutes(ev.startTime);
}

/**
 * Value of the duration select for these fields: the matching preset or
 * 'custom'. Blank times on a single day carry no information: a preset
 * (`current`) stays, 'custom' falls back to the default.
 */
export function durationOption(ev, current) {
  const sameDay = ev.endDate === '' || ev.endDate === ev.date;
  if (ev.startTime === '' && ev.endTime === '' && sameDay) {
    return current && current !== 'custom' ? current : String(DEFAULT_DURATION);
  }
  const span = spanMinutes(ev);
  return DURATIONS.includes(span) ? String(span) : 'custom';
}

// --- map position: pasted map links, geo: URIs or "lat, lon" become one canonical 'lat,lon'

const NUM = String.raw`[+-]?\d{1,3}(?:\.\d+)?`; // no exponents, no leading-dot forms
const PAIR_RE = new RegExp(`^(${NUM})\\s*(?:,|\\s)\\s*(${NUM})$`);
const GEO_URI_RE = new RegExp(`^geo:(${NUM}),(${NUM})(?:,${NUM})?((?:;[^?]*)?)(?:\\?(.*))?$`, 'i');
const AT_RE = new RegExp(`/@(${NUM}),(${NUM})(?:,|/|$)`);
const PIN_RE = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/; // the place pin in a Google Maps data= segment
const OSM_HOSTS = new Set(['openstreetmap.org', 'www.openstreetmap.org', 'osm.org', 'www.osm.org']);
const GOOGLE_HOST_RE = /^(?:www\.|maps\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/;

/** Rounded to 6 decimals, range-checked after rounding, formatted without trailing zeros or '-0'. */
function pairFrom(lat, lon) {
  const la = Number(Number(lat).toFixed(6));
  const lo = Number(Number(lon).toFixed(6));
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return `${String(la)},${String(lo)}`;
}

function pairFromText(text) {
  const m = text === null ? null : PAIR_RE.exec(text.trim());
  return m ? pairFrom(m[1], m[2]) : null;
}

/** True for the canonical 'lat,lon' form within ±90 / ±180 — what the model stores and the wire carries. */
export function isGeo(s) {
  if (typeof s !== 'string' || !GEO_RE.test(s)) return false;
  const [lat, lon] = s.split(',').map(Number);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Canonical 'lat,lon' for a pasted "lat, lon" pair, a geo: URI (RFC 5870; a
 * q= pair wins over the coordinates, so Android's geo:0,0?q=… never becomes
 * 0,0), an OpenStreetMap link (marker mlat/mlon, else #map=z/lat/lon), a
 * Google Maps link (place pin, then q/ll/query, then @lat,lon) or an Apple
 * Maps ll=; null for anything else. Never swaps latitude and longitude.
 */
export function parseGeo(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '' || s.length > GEO_INPUT_MAX) return null;
  if (/^geo:/i.test(s)) {
    const m = GEO_URI_RE.exec(s);
    if (!m) return null;
    const crs = /;crs=([^;]+)/i.exec(m[3] || '');
    if (crs && crs[1].toLowerCase() !== 'wgs84') return null;
    if (m[4] !== undefined) {
      const q = new URLSearchParams(m[4]).get('q');
      if (q !== null) return pairFromText(q.replace(/\(.*\)$/, ''));
    }
    return pairFrom(m[1], m[2]);
  }
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const p = u.searchParams;
    if (OSM_HOSTS.has(host)) {
      if (p.has('mlat') || p.has('mlon')) return p.has('mlat') && p.has('mlon') ? pairFrom(p.get('mlat'), p.get('mlon')) : null;
      const parts = (new URLSearchParams(u.hash.slice(1)).get('map') || '').split('/');
      return parts.length === 3 ? pairFrom(parts[1], parts[2]) : null;
    }
    if (GOOGLE_HOST_RE.test(host)) {
      const pin = PIN_RE.exec(u.pathname);
      if (pin) return pairFrom(pin[1], pin[2]);
      for (const key of ['q', 'll', 'query']) if (p.has(key)) return pairFromText(p.get(key));
      const at = AT_RE.exec(u.pathname);
      return at ? pairFrom(at[1], at[2]) : null;
    }
    if (host === 'maps.apple.com') return pairFromText(p.get('ll'));
    return null;
  }
  return pairFromText(s);
}

/** OpenStreetMap with a marker at the position; '' unless `geo` is canonical. */
export function osmMapUrl(geo) {
  if (!isGeo(geo)) return '';
  const [lat, lon] = geo.split(',');
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

/** OpenStreetMap's search for a location text; the plain site when the text is blank. */
export function osmSearchUrl(text) {
  const q = String(text).trim();
  return q === '' ? 'https://www.openstreetmap.org/' : `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`;
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
    geo: parseGeo(str(src.geo)) ?? str(src.geo), // unparseable input survives so validateEvent can flag it
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
    geo: '',
    ...partial,
    recurrence: { freq: 'none', interval: 1, byDay: [], count: null, until: null, ...(partial.recurrence || {}) },
  });
}

const cp = (s) => [...s].length;

/**
 * The event field(s) each validateEvent key is about (the form marks them);
 * keys absent here concern the whole form. Length keys name a LIMITS key.
 */
export const ERROR_FIELDS = Object.freeze({
  err_title_required: ['title'], err_title_long: ['title'],
  err_date_invalid: ['date'], err_end_date_invalid: ['endDate'],
  err_time_required: ['startTime'], err_time_invalid: ['startTime'],
  err_end_time_invalid: ['endTime'], err_end_time_required: ['endTime'],
  err_end_before_start: ['endDate', 'endTime'],
  err_location_long: ['location'], err_description_long: ['description'],
  err_url_long: ['url'], err_url_invalid: ['url'], err_geo_invalid: ['geo'],
  err_interval: ['interval'], err_count: ['count'],
  err_until_invalid: ['until'], err_until_before_start: ['until'],
  err_byday_empty: ['byDay'], err_byday_start: ['byDay'],
});

/** Returns i18n error keys; [] means valid. Expects a normalized event. */
export function validateEvent(ev) {
  const errs = new Set();
  if (ev.title === '') errs.add('err_title_required');
  for (const field of ['title', 'location', 'description', 'url']) {
    if (cp(ev[field]) > LIMITS[field]) errs.add(`err_${field}_long`);
  }
  const dateOk = isValidDate(ev.date);
  const endOk = isValidDate(ev.endDate);
  if (!dateOk) errs.add('err_date_invalid');
  if (!endOk) errs.add('err_end_date_invalid');
  if (!ev.allDay) {
    if (ev.startTime === '') errs.add('err_time_required');
    else if (!isValidTime(ev.startTime)) errs.add('err_time_invalid');
    if (ev.endTime !== '' && !isValidTime(ev.endTime)) errs.add('err_end_time_invalid');
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
  if (ev.geo !== '' && !isGeo(ev.geo)) errs.add('err_geo_invalid');
  const rec = ev.recurrence;
  if (rec.freq !== 'none') {
    if (!Number.isInteger(rec.interval) || rec.interval < 1 || rec.interval > 99) errs.add('err_interval');
    if (rec.count !== null && (!Number.isInteger(rec.count) || rec.count < 1 || rec.count > 999)) errs.add('err_count');
    if (rec.until !== null) {
      if (!isValidDate(rec.until)) errs.add('err_until_invalid');
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

/** The rule a Repeat preset stands for: every 1 unit; weekly on the start date's weekday. */
export function presetRule(freq, date) {
  return { interval: 1, byDay: freq === 'weekly' && isValidDate(date) ? [weekdayOf(date)] : [] };
}

/**
 * Which Repeat option shows a stored (normalized) rule: 'none', a preset, or
 * 'custom' when it needs the custom block (interval > 1, or weekly on other
 * days than the start's). Count and until never force custom.
 */
export function recurrencePreset(rec, date) {
  if (rec.freq === 'none') return 'none';
  if (rec.interval !== 1) return 'custom';
  if (rec.freq === 'weekly' && (rec.byDay.length !== 1 || rec.byDay[0] !== weekdayOf(date))) return 'custom';
  return rec.freq;
}

/**
 * Turns the editor draft plus the selected days into events.
 * 0–1 selected days → the draft as is; 'span' → one event from the first to
 * the last day; 'each' → one single-day copy per selected day (no series: a
 * rule adds err_each_repeat, and the copies are still checked without it so
 * the other errors show at the same time).
 */
export function expandDraft(draft, selectedDates, mode) {
  const days = [...new Set(selectedDates)].filter(isValidDate).sort(compareDates);
  const base = normalizeEvent(draft);
  const errors = new Set();
  let drafts;
  if (days.length <= 1) {
    drafts = [base];
  } else if (mode === 'span') {
    drafts = [{ ...base, date: days[0], endDate: days[days.length - 1] }];
  } else {
    if (base.recurrence.freq !== 'none') errors.add('err_each_repeat');
    drafts = days.map((d) => ({ ...base, date: d, endDate: d, recurrence: { freq: 'none' } }));
  }
  const events = [];
  for (const d of drafts) {
    const ev = normalizeEvent(d);
    for (const e of validateEvent(ev)) errors.add(e);
    events.push(ev);
  }
  return errors.size ? { events: [], errors: [...errors] } : { events, errors: [] };
}
