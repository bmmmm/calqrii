// RFC 5545 serializer: one VCALENDAR wrapper, VEVENTs with a content-hashed
// UID, CRLF line ends, 75-octet folding. Pure functions over normalized
// events (see model.js); the app passes `now` once per session and the
// time zone the times were entered in.
import { addDays, isGeo } from './model.js';

export const PRODID = '-//calqrii//calqrii//EN';
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * TEXT escaping (§3.3.11). Backslashes first, or the backslashes inserted
 * for `;` `,` and newlines would be doubled again. Control characters have
 * no escape and are dropped; TAB stays.
 */
export function escapeText(raw) {
  return String(raw)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Fold one logical line at 75 octets (§3.1) without cutting a UTF-8
 * sequence. A continuation line starts with one space that counts toward
 * its own budget, hence 74 payload octets from the second chunk on.
 */
export function foldLine(line) {
  const bytes = encoder.encode(line);
  if (bytes.length <= MAX_LINE_OCTETS) return line;
  const chunks = [];
  let start = 0;
  let limit = MAX_LINE_OCTETS;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
    limit = MAX_LINE_OCTETS - 1;
  }
  return chunks.join('\r\n ');
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
export function formatDate(iso) {
  return iso.replace(/-/g, '');
}

/** Date → 'YYYYMMDDTHHMMSSZ' */
export function formatUtcDateTime(d) {
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`
    + `T${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}Z`;
}

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    // hourCycle h23, not hour12:false — the latter can yield "24" at midnight.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset of `tz` at the instant `utcMs`, in ms (east positive). */
function tzOffsetMs(tz, utcMs) {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - utcMs;
}

/**
 * Wall-clock date + 'HH:MM' in `tz` → UTC instant. Two passes: the offset
 * at the wall time read as UTC, then the offset at the corrected instant.
 * In a DST gap the result is the instant one hour after the missing time;
 * in an overlap it is the later (standard-time) reading.
 */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm, 0);
  let t = wall - tzOffsetMs(tz, wall);
  t = wall - tzOffsetMs(tz, t);
  return new Date(t);
}

function floating(date, time) {
  return `${formatDate(date)}T${time.replace(':', '')}00`;
}

const FREQ_NAMES = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };

/** RRULE value (§3.3.10); '' when the event does not repeat. */
export function formatRrule(rec, { allDay }) {
  if (!rec || rec.freq === 'none') return '';
  const parts = [`FREQ=${FREQ_NAMES[rec.freq]}`, `INTERVAL=${rec.interval}`];
  if (rec.freq === 'weekly' && rec.byDay.length) parts.push(`BYDAY=${rec.byDay.join(',')}`);
  if (rec.count !== null) parts.push(`COUNT=${rec.count}`);
  else if (rec.until !== null) {
    parts.push(`UNTIL=${allDay ? formatDate(rec.until) : formatDate(rec.until) + 'T235959'}`);
  }
  return parts.join(';');
}

function urlValue(url) {
  const clean = String(url).replace(/[\x00-\x1F\x7F]/g, '');
  return /^https?:\/\//.test(clean) ? clean : '';
}

/** GEO value (§3.8.1.6): two FLOATs joined by ';'. '' unless canonical — guards unvalidated input. */
function geoValue(geo) {
  return isGeo(geo) ? geo.replace(',', ';') : '';
}

/**
 * The unfolded property lines DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION,
 * GEO, URL, RRULE. They are what the UID hashes, so their order is part of
 * the format.
 */
export function contentLines(ev, { tz }) {
  const lines = [];
  const repeats = ev.recurrence.freq !== 'none';
  if (ev.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDate(ev.date)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDate(addDays(ev.endDate, 1))}`);
  } else if (repeats) {
    // Floating: the wall-clock hour survives DST, which a UTC series does not.
    const start = floating(ev.date, ev.startTime);
    lines.push(`DTSTART:${start}`);
    if (ev.endTime !== '') {
      const end = floating(ev.endDate, ev.endTime);
      if (end !== start) lines.push(`DTEND:${end}`);
    }
  } else {
    const start = formatUtcDateTime(zonedToUtc(ev.date, ev.startTime, tz));
    lines.push(`DTSTART:${start}`);
    if (ev.endTime !== '') {
      const end = formatUtcDateTime(zonedToUtc(ev.endDate, ev.endTime, tz));
      if (end !== start) lines.push(`DTEND:${end}`);
    }
  }
  lines.push(`SUMMARY:${escapeText(ev.title)}`);
  if (ev.description !== '') lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  if (ev.location !== '') lines.push(`LOCATION:${escapeText(ev.location)}`);
  const geo = geoValue(ev.geo);
  if (geo) lines.push(`GEO:${geo}`);
  const url = urlValue(ev.url);
  if (url) lines.push(`URL:${url}`);
  const rrule = formatRrule(ev.recurrence, { allDay: ev.allDay });
  if (rrule) lines.push(`RRULE:${rrule}`);
  return lines;
}

/** FNV-1a 64 over the UTF-8 bytes; 16 lowercase hex digits. */
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** Content-derived UID: the same link yields the same UID, so a second scan updates instead of duplicating. */
export function uidFor(ev, { tz }) {
  return `${fnv1a64(encoder.encode(contentLines(ev, { tz }).join('\n')))}@calqrii`;
}

export function veventLines(ev, { now, tz }) {
  return [
    'BEGIN:VEVENT',
    `UID:${uidFor(ev, { tz })}`,
    `DTSTAMP:${formatUtcDateTime(now)}`,
    ...contentLines(ev, { tz }),
    'END:VEVENT',
  ];
}

function wrap(bodyLines) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, ...bodyLines, 'END:VCALENDAR'];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function serializeEvent(ev, opts) {
  return wrap(veventLines(ev, opts));
}

export function serializeCalendar(events, opts) {
  return wrap(events.flatMap((ev) => veventLines(ev, opts)));
}
