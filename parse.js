// Import parsers for the "extra" page: an iCalendar file or the text of a
// web page's event list → normalized events (model.js). Pure functions, no
// DOM, no network. Everything unsupported degrades to a warning key the page
// shows next to the event, never to a silent change of meaning: a schedule
// the model cannot express exactly is dropped, not approximated.
import { normalizeEvent, validateEvent, isValidDate, isValidTime, addDays, compareDates, weekdayOf, presetRule, LIMITS, WEEKDAYS } from './model.js';
import { zonedToUtc } from './ics.js';
import { WINDOWS_TZ } from './tzmap.js';

const ICS_RE = /^\s*BEGIN:(VCALENDAR|VEVENT)/im;
export const MAX_INPUT_CHARS = 2_000_000; // parseInput reports `truncated` beyond this
const MAX_LINE_CHARS = 2000; // text lines are cut here: the trim regex is quadratic on long runs of punctuation
const URL_RE = /^https?:\/\/\S+$/;

/** 'ics' when the text is an iCalendar stream, 'text' otherwise, 'empty' for whitespace. */
export function detectKind(text) {
  if (typeof text !== 'string' || text.trim() === '') return 'empty';
  return ICS_RE.test(text) ? 'ics' : 'text';
}

// --- iCalendar

/** RFC 5545 §3.1 unfolding, then one entry per content line. */
function contentLines(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
}

// Date values never contain a colon; Outlook writes an unquoted TZID=tzone://Microsoft/Utc.
const DATE_PROPS = new Set(['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE', 'RDATE']);
const MS_UTC = 'tzone://Microsoft/Utc';

/** 'NAME;P=1;Q="a:b":value' → { name, params: { P: '1', Q: 'a:b' }, value } */
function parseLine(line) {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  if (DATE_PROPS.has(line.slice(0, i).split(';')[0].toUpperCase())) i = line.lastIndexOf(':');
  const head = line.slice(0, i).split(';');
  const params = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/** TEXT unescaping (§3.3.11): \n \N \, \; \\ */
export function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(?:\d{2})?(Z)?)?$/;

const dtfCache = new Map();
function wallClock(utcDate, tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    dtfCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(utcDate).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const sameCache = new Map();
/**
 * Whether zones a and b show the same wall clock at every hour of `year`
 * (UTC): "W. Europe Standard Time" → Europe/Berlin is the same as a page in
 * Europe/Vienna, CLDR's legacy Asia/Calcutta the same as Asia/Kolkata.
 */
function sameZone(a, b, year) {
  if (a === b) return true;
  const key = `${a}|${b}|${year}`;
  let same = sameCache.get(key);
  if (same === undefined) {
    wallClock(new Date(0), a); // fills dtfCache for both zones
    wallClock(new Date(0), b);
    const fa = dtfCache.get(a);
    const fb = dtfCache.get(b);
    const end = Date.UTC(year + 1, 0, 1);
    same = true;
    for (let t = Date.UTC(year, 0, 1); t < end && same; t += 3600000) same = fa.format(t) === fb.format(t);
    sameCache.set(key, same);
  }
  return same;
}

function isTz(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * DTSTART/DTEND value → { date, time, allDay, zone, shifted } as wall
 * clock in `tz`. UTC (Z) and TZID values are converted (`zone`: the source
 * zone, null when nothing was converted; `shifted`: the conversion moved the
 * calendar day); floating values stay as written. null when not a date.
 */
export function parseDateTime(value, params, tz, warnings) {
  const m = DT_RE.exec(value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidDate(date)) return null;
  if (m[4] === undefined || params.VALUE === 'DATE') return { date, time: '', allDay: true, zone: null, shifted: false };
  const time = `${m[4]}:${m[5]}`;
  if (!isValidTime(time)) return null;
  let wall = null;
  let src = null;
  if (m[6] === 'Z') {
    src = 'UTC';
    wall = wallClock(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])), tz);
  } else if (params.TZID && params.TZID !== tz) {
    const tzid = params.TZID === MS_UTC ? 'UTC' : WINDOWS_TZ[params.TZID] ?? params.TZID; // Outlook writes Windows names
    if (tzid !== tz) {
      if (isTz(tzid)) { src = tzid; wall = wallClock(zonedToUtc(date, time, tzid), tz); }
      else warnings.add('imp_warn_tz');
    }
  }
  if (!wall) return { date, time, allDay: false, zone: null, shifted: false };
  return { ...wall, allDay: false, zone: src, shifted: wall.date !== date };
}

/** DURATION (§3.3.6) → minutes; null when unsupported (weeks are fine, negative is not). */
export function parseDuration(value) {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim() === 'PT') return null;
  const [, w = 0, d = 0, h = 0, mi = 0] = m;
  return ((+w * 7 + +d) * 24 + +h) * 60 + +mi;
}

/** Plain decimal digits → number; null for anything else ('1e3', '0x10', ' 5', ''). */
const digits = (s) => (/^\d+$/.test(s) ? Number(s) : null);

const FREQ_MAP = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
const RRULE_KNOWN = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST']);

/**
 * RRULE → the model's recurrence, or null when the rule says something the
 * model cannot (ordinal BYDAY, BYMONTHDAY, BYSETPOS, …): the caller then drops
 * the rule and warns rather than importing a different schedule. 'range' when
 * the only obstacle is INTERVAL or COUNT beyond the editor's range (the
 * caller drops it too, with a more helpful note). A UTC UNTIL is read in `tz`.
 */
export function parseRrule(value, start, tz = 'UTC') {
  const parts = {};
  for (const p of value.split(';')) {
    const eq = p.indexOf('=');
    if (eq === -1) return null;
    parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  if (Object.keys(parts).some((k) => !RRULE_KNOWN.has(k))) return null;
  const freq = FREQ_MAP[parts.FREQ];
  if (!freq) return null;
  const interval = parts.INTERVAL === undefined ? 1 : digits(parts.INTERVAL);
  if (interval === null || interval < 1) return null;
  let range = interval > 99;
  let byDay = [];
  if (parts.BYDAY !== undefined) {
    if (freq !== 'weekly') return null;
    byDay = parts.BYDAY.split(',');
    if (!byDay.every((d) => WEEKDAYS.includes(d))) return null;
    byDay = WEEKDAYS.filter((d) => byDay.includes(d));
    if (!byDay.includes(weekdayOf(start))) return null;
  } else if (freq === 'weekly') {
    byDay = presetRule('weekly', start).byDay;
  }
  let count = null;
  let until = null;
  if (parts.COUNT !== undefined && parts.UNTIL !== undefined) return null; // RFC 5545 forbids both: which end was meant?
  if (parts.COUNT !== undefined) {
    count = digits(parts.COUNT);
    if (count === null || count < 1) return null;
    if (count > 999) range = true;
  } else if (parts.UNTIL !== undefined) {
    const m = DT_RE.exec(parts.UNTIL);
    if (!m) return null;
    until = m[6] === 'Z' ? wallClock(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])), tz).date : `${m[1]}-${m[2]}-${m[3]}`;
  }
  return range ? 'range' : { freq, interval, byDay, count, until };
}

/**
 * Every VEVENT of an iCalendar stream → [{ ev, warnings }] in file order. The
 * event is normalized but not validated (the page shows the errors). Times
 * are converted to `tz`, the zone the page will serialize them in; `today`
 * (YYYY-MM-DD) tells how far an open series runs (default: until the year after its start).
 */
export function parseIcs(text, { tz, today = null }) {
  const events = [];
  let cur = null;
  let depth = 0; // nested components (VALARM) inside the VEVENT are skipped
  for (const line of contentLines(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !cur) cur = { props: [], warnings: new Set() };
      else if (cur) depth++;
      continue;
    }
    if (p.name === 'END') {
      if (cur && depth > 0) depth--;
      else if (cur && p.value.toUpperCase() === 'VEVENT') { events.push(cur); cur = null; }
      continue;
    }
    if (cur && depth === 0) cur.props.push(p);
  }
  // A moved instance (RECURRENCE-ID) is exported as its own VEVENT with the
  // master's UID: the master still contains the original date, so both sides are flagged.
  const overridden = new Set();
  for (const e of events) {
    const uid = e.props.find((p) => p.name === 'UID');
    if (uid && e.props.some((p) => p.name === 'RECURRENCE-ID')) overridden.add(uid.value);
  }
  for (const e of events) {
    const uid = e.props.find((p) => p.name === 'UID');
    if (uid && overridden.has(uid.value)) e.warnings.add('imp_warn_exdate');
  }
  return events.map((e) => buildEvent(e, tz, today));
}

/** Text fields beyond the model's limits are cut, a non-http(s) URL dropped; both reported once. */
function bounded(partial, warnings) {
  for (const f of ['title', 'location', 'description']) {
    if ([...partial[f]].length > LIMITS[f]) { partial[f] = [...partial[f]].slice(0, LIMITS[f]).join(''); warnings.add('imp_warn_fields'); }
  }
  if (partial.url !== '' && !(URL_RE.test(partial.url) && partial.url.length <= LIMITS.url)) { partial.url = ''; warnings.add('imp_warn_fields'); }
  return partial;
}

/** Wall clock in `tz` plus `minutes`, added to the instant (so a DST change inside the span counts). */
function addMinutesZoned(date, time, minutes, tz) {
  return wallClock(new Date(zonedToUtc(date, time, tz).getTime() + minutes * 60000), tz);
}

const UNIT_DAYS = { daily: 1, weekly: 7, monthly: 31, yearly: 366 }; // upper bounds: a COUNT series' end is over-estimated

/**
 * Whether a series given in `zone` leaves `tz`'s wall clock in a year it runs: from its start through
 * its end (UNTIL, or estimated from COUNT), but no further than next year -- tz data knows no later
 * rules -- and at most the 11 years up to there (the cost: about 13 ms per new zone pair and year).
 */
function seriesDrifts(zone, tz, startDate, rec, today) {
  const startYear = +startDate.slice(0, 4);
  const nextYear = Math.max(startYear, today ? +today.slice(0, 4) : startYear) + 1;
  const end = rec.until ?? (rec.count ? addDays(startDate, rec.count * rec.interval * UNIT_DAYS[rec.freq]) : null);
  const last = end ? Math.min(+end.split('-')[0], nextYear) : nextYear;
  for (let y = Math.max(startYear, last - 10); y <= last; y++) if (!sameZone(zone, tz, y)) return true;
  return false;
}

function buildEvent({ props, warnings }, tz, today) {
  const first = (name) => props.find((p) => p.name === name);
  const text = (name) => { const p = first(name); return p ? unescapeText(p.value) : ''; };
  const startProp = first('DTSTART');
  const start = startProp ? parseDateTime(startProp.value, startProp.params, tz, warnings) : null;
  const partial = bounded({
    title: text('SUMMARY'),
    description: text('DESCRIPTION'),
    location: text('LOCATION'),
    url: first('URL') ? first('URL').value.trim() : '',
  }, warnings);
  const geo = first('GEO');
  if (geo) partial.geo = geo.value.replace(';', ',');
  if (start) {
    partial.allDay = start.allDay;
    partial.date = start.date;
    partial.startTime = start.time;
    const endProp = first('DTEND');
    const end = endProp ? parseDateTime(endProp.value, endProp.params, tz, warnings) : null;
    const dur = !endProp && first('DURATION') ? parseDuration(first('DURATION').value) : null;
    if (end) {
      // DTEND of an all-day event is exclusive: the day after the last day.
      partial.endDate = start.allDay ? addDays(end.date, -1) : end.date;
      partial.endTime = start.allDay ? '' : end.time;
    } else if (dur !== null && dur > 0) {
      if (start.allDay) partial.endDate = addDays(start.date, Math.max(0, Math.ceil(dur / 1440) - 1));
      else {
        const e = addMinutesZoned(start.date, start.time, dur, tz);
        partial.endDate = e.date;
        partial.endTime = e.time;
      }
    }
    if (partial.endDate && compareDates(partial.endDate, start.date) < 0) partial.endDate = start.date;
    const rrule = first('RRULE');
    if (rrule) {
      // A series is serialized floating (wall clock in tz). One given in another
      // zone keeps its wall clock only until the next DST change, and one whose
      // start moved to another calendar day would run on the wrong weekdays.
      const rec = start.shifted ? null : parseRrule(rrule.value, start.date, tz);
      if (rec && rec !== 'range') {
        partial.recurrence = rec;
        if (start.zone && seriesDrifts(start.zone, tz, start.date, rec, today)) warnings.add('imp_warn_series_tz');
      } else warnings.add(rec === 'range' ? 'imp_warn_rule_range' : 'imp_warn_rule');
      if (first('EXDATE') || first('RDATE')) warnings.add('imp_warn_exdate');
    }
  } else {
    warnings.add('imp_warn_start');
  }
  return { ev: normalizeEvent(partial), warnings: [...warnings] };
}

// --- plain text: a copied event list

const MONTHS = {
  jan: 1, feb: 2, mar: 3, 'mär': 3, mrz: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12,
};
const monthOf = (name) => MONTHS[name.toLowerCase().replace(/\.$/, '').slice(0, 3)] ?? null;
const pad2 = (n) => String(n).padStart(2, '0');
// A whole month name or its abbreviation in either language, nothing else: "Marktplatz 5",
// "Junkerweg 4" or "3. Marathon" must not read as dates. Longest form first, then a letter guard.
const WORD = String.raw`(?:januar|january|jan|februar|february|feb|märz|mär|mrz|march|mar|april|apr|mai|may|juni|june|jun|juli|july|jul|august|aug|september|sept|sep|oktober|okt|october|oct|november|nov|dezember|dez|december|dec)(?![a-zäöüß])`;
// Two digits that start a time: an hour 00–23, then ":00", ".30" (the chain ends there), " Uhr", or "-20 Uhr" /
// " bis 20 Uhr". "14.10.19.30 Chor" and the address "10.1.10.11" look alike; both read as a date, since a visible
// wrong event can be deselected and a dropped one is lost in the previous event's description.
const HOUR = String.raw`(?:[01]\d|2[0-3])(?::\d\d|\.\d\d(?![.\d])|\s*Uhr\b|\s*(?:[-–]|bis)\s*\d{1,2}(?:[:.]\d\d)?\s*Uhr\b)`;
// Every shape of a date; the alternation order decides which reading wins when two overlap.
const DATE_RE = new RegExp([
  String.raw`\b(\d{4})-(\d{2})-(\d{2})\b`,                       // 1-3   ISO
  // 4-6 D.M.(YYYY), never inside a dot chain ("10.1.10.11"). Two digits that start a time ("20.11. 18-20 Uhr",
  // "20.11.18:00") or go on ("1.2.10.11") are no year; without a year only such a time may follow at once, any
  // other digit ("Version 2.3.4.5") ends the match.
  String.raw`(?<!\d\.)\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|(?!${HOUR})\d{2}(?![.:]\d)))?(?!(?!${HOUR})\d)`,
  String.raw`\b(\d{1,2})\.\s*(${WORD})\.?(?:\s+(\d{4}))?(?!\d)`,  // 7-9   D. Monat (YYYY)
  String.raw`\b(${WORD})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?(?:\s+(\d{4}))?`, // 10-12 Month D(, YYYY)
].join('|'), 'gi');
const RANGE_SEP = String.raw`\s*(?:–|—|-|bis|to|through)\s*`;
const DAY_BEFORE_RE = new RegExp(String.raw`(\d{1,2})\.(?:\s?(\d{1,2})\.)?${RANGE_SEP}$`); // "17.–" or "17.10.–" right before the end date
// "18:30", "18.30 Uhr", "19 Uhr", "7pm"; the dotted form counts only on a line that says "Uhr" somewhere (else "12.50 Euro" would be a time).
const TIME_RE = new RegExp(String.raw`\b(\d{1,2})(?::(\d{2})|\.(\d{2}))\s*(?:Uhr|([ap])\.?m\b)?|\b(\d{1,2})\s*(?:Uhr|([ap])\.?m\b)`, 'gi');
const UHR_RE = /\bUhr\b/i;
// The gap between two dates or two times is a range only when it is nothing but a separator: "– Grillfest (Ausweichtermin 12.10.)" is not.
const GAP_RE = new RegExp(String.raw`^${RANGE_SEP}$`);
const GLUE_RE = /\b(?:Uhr|ab|um|am|vom|von|bis|to|at|from|on)\b/gi;
const WEEKDAY_RE = /\b(?:Mo|Di|Mi|Do|Fr|Sa|So|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\.?,?(?=\s|$)/gi;
const TRIM_RE = /^[\s,;:.–—\-|·•*()\[\]]+|[\s,;:–—\-|·•*(\[]+$/g;
const LOCATION_RE = /^(?:Ort|Wo|Treffpunkt|Location|Where|Venue)\s*:\s*(.+)$/i;
const PAST_GRACE_DAYS = 60; // a date without a year this far in the past means next year

/** All date tokens of a line: { index, end, year, month, day }, in order. */
function findDates(line) {
  const out = [];
  DATE_RE.lastIndex = 0;
  for (const m of line.matchAll(DATE_RE)) {
    let y = null; let mo; let d;
    if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if (m[4]) { d = +m[4]; mo = +m[5]; if (m[6]) y = m[6].length === 2 ? 2000 + +m[6] : +m[6]; }
    else if (m[7]) { d = +m[7]; mo = monthOf(m[8]); if (mo === null) continue; if (m[9]) y = +m[9]; }
    else { mo = monthOf(m[10]); if (mo === null) continue; d = +m[11]; if (m[12]) y = +m[12]; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    out.push({ index: m.index, end: m.index + m[0].length, year: y, month: mo, day: d });
  }
  return out;
}

function resolveYear(tok, today, warnings) {
  if (tok.year !== null) return tok.year;
  const y = Number(today.slice(0, 4));
  const guess = `${y}-${pad2(tok.month)}-${pad2(tok.day)}`;
  warnings.add('imp_warn_year');
  return isValidDate(guess) && compareDates(guess, addDays(today, -PAST_GRACE_DAYS)) < 0 ? y + 1 : y;
}

function isoOf(tok, year) {
  const s = `${year}-${pad2(tok.month)}-${pad2(tok.day)}`;
  return isValidDate(s) ? s : null;
}

/** Times of a line (dates already blanked): [{ index, end, time }] */
function findTimes(line, dottedOk = UHR_RE.test(line)) {
  const out = [];
  TIME_RE.lastIndex = 0;
  for (const m of line.matchAll(TIME_RE)) {
    if (m[3] !== undefined && !dottedOk) continue;
    let h = m[1] !== undefined ? +m[1] : +m[5];
    const mi = m[2] !== undefined ? +m[2] : m[3] !== undefined ? +m[3] : 0;
    const ampm = (m[4] || m[6] || '').toLowerCase();
    if (ampm === 'p' && h < 12) h += 12;
    else if (ampm === 'a' && h === 12) h = 0;
    if (h > 23 || mi > 59) continue;
    out.push({ index: m.index, end: m.index + m[0].length, time: `${pad2(h)}:${pad2(mi)}` });
  }
  return out;
}

const blank = (s, from, to) => s.slice(0, from) + ' '.repeat(to - from) + s.slice(to);
const isGap = (s) => s.trim() !== '' && GAP_RE.test(s);
// What may stand before a time that belongs to the date just before it: "(09:00)", ", 9 Uhr", "um 18:00".
const TIME_LEAD_RE = /^[\s,(]*(?:(?:um|ab|at|from)\s+)?\(?\s*$/i;
const TIME_CLOSE_RE = /^\s*\)/;

/**
 * "26.10.2026 (09:00) – 30.10.2026 (16:00)": one time right after the first
 * date, then only a separator, then the second date with its own time.
 * { startTime, endTime, end } (end: where the end time stops), or null.
 */
function timedSpan(line, first, second) {
  const dottedOk = UHR_RE.test(line);
  const gap = line.slice(first.end, second.index);
  const t1 = findTimes(gap, dottedOk)[0];
  if (!t1 || !TIME_LEAD_RE.test(gap.slice(0, t1.index))) return null;
  if (!isGap(gap.slice(t1.end).replace(TIME_CLOSE_RE, '').replace(WEEKDAY_RE, ' '))) return null; // "… bis Fr 30.10."
  const after = line.slice(second.end);
  const t2 = findTimes(after, dottedOk)[0];
  if (!t2 || !TIME_LEAD_RE.test(after.slice(0, t2.index))) return null;
  const close = TIME_CLOSE_RE.exec(after.slice(t2.end)); // "(16:00)": the parenthesis goes with the time, not the title
  return { startTime: t1.time, endTime: t2.time, end: second.end + t2.end + (close ? close[0].length : 0) };
}

/** The date line's own words after dates, times, weekdays and glue are removed. */
function titleOf(rest) {
  return rest.replace(WEEKDAY_RE, ' ').replace(GLUE_RE, ' ').replace(/\s+/g, ' ').replace(TRIM_RE, '').trim();
}

/**
 * Reads a date line: { date, endDate, startTime, endTime, allDay, title, warnings }
 * or null when the line holds no date. Exported for the tests.
 */
export function parseDateLine(line, today) {
  const dates = findDates(line);
  if (dates.length === 0) return null;
  const warnings = new Set();
  const first = dates[0];
  const second = dates[1];
  let rest = line;
  // "D.M. – D.M.YYYY": a start without a year takes the end's year (the one before it when the span crosses New Year).
  const plainRange = second && isGap(line.slice(first.end, second.index));
  const timed = second && !plainRange ? timedSpan(line, first, second) : null;
  const rangeToSecond = plainRange || timed !== null;
  let year;
  if (first.year === null && rangeToSecond && second.year !== null) {
    year = second.year;
    const s0 = isoOf(first, year);
    const e0 = isoOf(second, year);
    if (s0 && e0 && compareDates(s0, e0) > 0) year--;
  } else year = resolveYear(first, today, warnings);
  let date = isoOf(first, year);
  let endDate = date;
  rest = blank(rest, first.index, first.end);
  if (rangeToSecond) {
    let d2 = isoOf(second, second.year ?? year);
    // "30.12.–2.1.": an end without a year before a start in November or December is in January or February of
    // the next year; any other reversed end stays as written, and validation refuses it.
    if (d2 && date && second.year === null && compareDates(d2, date) < 0 && first.month >= 11 && second.month <= 2) d2 = isoOf(second, year + 1);
    if (d2) { endDate = d2; rest = blank(rest, first.end, second.end); }
  } else {
    // "17.–18.10.2026", "17. – 18. Oktober": the first token is the end, the day before it the start.
    const before = DAY_BEFORE_RE.exec(line.slice(0, first.index));
    if (before) {
      const month = before[2] ? +before[2] : first.month;
      const startIso = isoOf({ month, day: +before[1] }, year);
      if (startIso && date && compareDates(startIso, date) <= 0) {
        endDate = date;
        date = startIso;
        rest = blank(rest, first.index - before[0].length, first.index);
      }
    }
  }
  if (!date) return null; // an end before the start stays as written: validation refuses it, visibly
  let startTime = '';
  let endTime = '';
  const times = timed ? [] : findTimes(rest);
  if (timed) {
    startTime = timed.startTime;
    endTime = timed.endTime;
    rest = blank(rest, second.end, timed.end);
  } else if (times.length) {
    startTime = times[0].time;
    rest = blank(rest, times[0].index, times[0].end);
    const t2 = times[1];
    if (t2 && isGap(line.slice(times[0].end, t2.index))) {
      endTime = t2.time;
      rest = blank(rest, times[0].end, t2.end);
    }
  }
  return { date, endDate, startTime, endTime, allDay: startTime === '', title: titleOf(rest), warnings };
}

/** The most frequent number of lines between two date lines (the first one on a tie). */
function usualGap(anchors) {
  const counts = new Map();
  for (let k = 1; k < anchors.length; k++) {
    const g = anchors[k] - anchors[k - 1] - 1;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = null;
  for (const [g, n] of counts) if (best === null || n > counts.get(best)) best = g;
  return best;
}

/**
 * A copied event list → [{ ev, warnings }]. Every line with a date starts an
 * event; its other words are the title. Lines without a date belong to the
 * nearest date line: after it (title when the date line had none, "Ort:" as
 * the location, the rest as description) — or, when no date line carries a
 * title of its own and the list's shape says so (usualGap), the line before it.
 */
export function parseText(text, { today }) {
  const lines = text.split(/\r?\n/).map((l) => l.slice(0, MAX_LINE_CHARS).replace(/\s+/g, ' ').trim()).filter((l) => l !== '');
  const parsed = lines.map((l) => parseDateLine(l, today));
  const anchors = [];
  parsed.forEach((p, i) => { if (p) anchors.push(i); });
  if (anchors.length === 0) return [];
  const untitled = anchors.every((i) => parsed[i].title === '');
  // Title line before or after the date line, read from the shape: the usual gap between two date lines holds the
  // end of one event (as many lines as follow the last date line) and the start of the next. Titles stand before
  // when that start is at least one line and fits above the first date line (the rest there is a heading). A
  // heading above a title-after list ("Termine", then date, title, …) leaves no start: the gap is all event end.
  const lead = anchors[0];
  const tail = lines.length - 1 - anchors[anchors.length - 1];
  // A single date line has no gap to read: a line above it is its title, as before.
  const above = anchors.length > 1 ? usualGap(anchors) - tail : 0;
  const titleBefore = untitled && (anchors.length === 1 || (above > 0 && above <= lead));
  const items = [];
  anchors.forEach((i, k) => {
    const p = parsed[i];
    const next = anchors[k + 1] ?? lines.length;
    let title = p.title;
    const body = [];
    let location = '';
    if (titleBefore && i > 0 && !parsed[i - 1]) title = lines[i - 1];
    for (let j = i + 1; j < next; j++) {
      if (titleBefore && j === next - 1 && !parsed[j] && k + 1 < anchors.length) break; // that line titles the next event
      const loc = LOCATION_RE.exec(lines[j]);
      if (loc && location === '') { location = loc[1]; continue; }
      if (title === '') { title = lines[j]; continue; }
      body.push(lines[j]);
    }
    if (!titleBefore && k === 0 && title === '' && i > 0) title = lines[i - 1];
    const ev = normalizeEvent({
      title: title.slice(0, LIMITS.title),
      allDay: p.allDay,
      date: p.date,
      endDate: p.endDate,
      startTime: p.startTime,
      endTime: p.endTime,
      location: location.slice(0, LIMITS.location),
      description: body.join('\n').slice(0, LIMITS.description),
    });
    items.push({ ev, warnings: [...p.warnings] });
  });
  return items;
}

/**
 * Whatever was pasted or picked → { kind, items: [{ ev, warnings, errors, past }], truncated }.
 * `errors` are validateEvent keys (the page refuses to export those), `past`
 * marks events (and series) that ended before `today`; `truncated` says the
 * input was cut at MAX_INPUT_CHARS.
 */
export function parseInput(text, { tz, today }) {
  const kind = detectKind(text);
  const truncated = kind !== 'empty' && text.length > MAX_INPUT_CHARS;
  const src = truncated ? text.slice(0, MAX_INPUT_CHARS) : text;
  const raw = kind === 'ics' ? parseIcs(src, { tz, today }) : kind === 'text' ? parseText(src, { today }) : [];
  const items = raw.map(({ ev, warnings }, i) => {
    const e = { ...ev, id: i + 1 };
    const errors = validateEvent(e);
    const rec = e.recurrence;
    const ended = rec.freq === 'none' ? e.endDate : rec.until;
    const past = errors.length === 0 && ended !== null && compareDates(ended, today) < 0;
    return { ev: e, warnings, errors, past };
  });
  return { kind, items, truncated };
}
