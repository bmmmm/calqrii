// Share-link codec: '#v=2&tz=<zone>&e=<base64url(deflate-raw(JSON array))>'.
// Version 1 carried the JSON uncompressed; such links stay readable. The page
// never writes this to the address bar; it only builds the link on request
// and reads one on load. Decoding is all-or-nothing: any doubt → bad_link.
// Compression runs through the platform's CompressionStream, which is
// asynchronous — so are encodeFragment, linkFor and decodeFragment. A browser
// without it (Safari before 16.4, Chrome before 103) writes version-1 links and
// answers a version-2 link with 'bad_browser' instead of failing silently.
import { newEvent, validateEvent, isGeo, LIMITS } from './model.js';

export const LINK_VERSION = '2';
const READABLE_VERSIONS = ['1', LINK_VERSION];
export const MAX_E_LENGTH = 100000; // decodeFragment refuses longer payloads; the page must not hand out such a link
// Inflation stops as soon as the output passes this: the largest honest link (200 events at every text cap) stays well below it.
export const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
const INFLATE_SLICE = 1024; // compressed bytes per step; deflate expands at most ~1032:1, so a step adds at most ~1 MiB before the cap is checked again

const canDeflate = () => typeof CompressionStream === 'function';
const canInflate = () => typeof DecompressionStream === 'function';
const FREQ_CODE = { daily: 'd', weekly: 'w', monthly: 'm', yearly: 'y' };
const CODE_FREQ = { d: 'daily', w: 'weekly', m: 'monthly', y: 'yearly' };
// Wire keys in emission order; the order is part of the format.
const KEY_TYPES = { t: 'string', d: 'string', D: 'string', a: 'number', s: 'string', e: 'string', l: 'string', g: 'string', n: 'string', u: 'string', r: 'object' };
const REC_KEYS = ['f', 'i', 'b', 'c', 'x'];

export function bytesToB64url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Inflates at most `max` bytes; throws RangeError('inflate') as soon as the
 * output exceeds it. The input is fed in small slices so that a crafted
 * payload is abandoned after the first few, not inflated whole.
 */
async function inflateRaw(bytes, max) {
  let pos = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(pos, pos + INFLATE_SLICE));
      pos += INFLATE_SLICE;
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new RangeError('inflate'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function toWire(ev) {
  const w = { t: ev.title, d: ev.date };
  if (ev.endDate !== ev.date) w.D = ev.endDate;
  if (ev.allDay) w.a = 1;
  if (ev.startTime) w.s = ev.startTime;
  if (ev.endTime) w.e = ev.endTime;
  if (ev.location) w.l = ev.location;
  if (ev.geo) w.g = ev.geo;
  if (ev.description) w.n = ev.description;
  if (ev.url) w.u = ev.url;
  const r = ev.recurrence;
  if (r.freq !== 'none') {
    const rw = { f: FREQ_CODE[r.freq] };
    if (r.interval > 1) rw.i = r.interval;
    if (r.freq === 'weekly' && r.byDay.length) rw.b = r.byDay.join('');
    if (r.count !== null) rw.c = r.count;
    else if (r.until !== null) rw.x = r.until;
    w.r = rw;
  }
  return w;
}

/** '' when there is nothing to share; otherwise the fragment without '#'. */
export async function encodeFragment({ events, tz }) {
  if (!events || events.length === 0) return '';
  const bytes = new TextEncoder().encode(JSON.stringify(events.map(toWire)));
  const p = new URLSearchParams();
  p.set('v', canDeflate() ? LINK_VERSION : '1');
  p.set('tz', tz);
  p.set('e', bytesToB64url(canDeflate() ? await deflateRaw(bytes) : bytes));
  return p.toString();
}

/** `base` (origin + path, no '#') + '#' + the fragment of `events`: a share link, or a link-mode QR text. */
export async function linkFor(base, events, tz) {
  return base + '#' + await encodeFragment({ events, tz });
}

function isValidTz(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function fromWire(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return { error: 'type' };
  for (const k of Object.keys(w)) {
    if (!Object.hasOwn(KEY_TYPES, k)) return { error: 'key' };
    if (typeof w[k] !== KEY_TYPES[k] || w[k] === null) return { error: 'type' };
  }
  if (!('t' in w) || !('d' in w)) return { error: 'missing' };
  if ('a' in w && w.a !== 1) return { error: 'a' };
  // Strict: normalizeEvent would canonicalize '48.1370,11.5' and let it through.
  if ('g' in w && !isGeo(w.g)) return { error: 'g' };
  let recurrence;
  if ('r' in w) {
    const r = w.r;
    if (Array.isArray(r)) return { error: 'r' };
    for (const k of Object.keys(r)) if (!REC_KEYS.includes(k)) return { error: 'key' };
    if (!(typeof r.f === 'string' && Object.hasOwn(CODE_FREQ, r.f))) return { error: 'f' };
    if ('i' in r && !Number.isInteger(r.i)) return { error: 'i' };
    if ('b' in r && !(typeof r.b === 'string' && /^(MO|TU|WE|TH|FR|SA|SU)+$/.test(r.b))) return { error: 'b' };
    if ('c' in r && !Number.isInteger(r.c)) return { error: 'c' };
    if ('x' in r && typeof r.x !== 'string') return { error: 'x' };
    recurrence = {
      freq: CODE_FREQ[r.f],
      interval: 'i' in r ? r.i : 1,
      byDay: 'b' in r ? r.b.match(/.{2}/g) : [],
      count: 'c' in r ? r.c : null,
      until: 'x' in r ? r.x : null,
    };
  }
  const event = newEvent({
    title: w.t,
    date: w.d,
    endDate: 'D' in w ? w.D : w.d,
    allDay: w.a === 1,
    startTime: 's' in w ? w.s : '',
    endTime: 'e' in w ? w.e : '',
    location: 'l' in w ? w.l : '',
    description: 'n' in w ? w.n : '',
    url: 'u' in w ? w.u : '',
    geo: 'g' in w ? w.g : '',
    recurrence,
  });
  return { event };
}

/**
 * @returns {{status:'empty'} | {status:'ok', events:object[], tz:string}
 *   | {status:'error', code:'bad_version'|'bad_browser'|'bad_link', detail?:string}}
 */
export async function decodeFragment(raw) {
  const fail = (detail) => ({ status: 'error', code: 'bad_link', detail });
  if (typeof raw !== 'string' || raw === '') return { status: 'empty' };
  const p = new URLSearchParams(raw);
  if (!p.has('v') && !p.has('e')) return { status: 'empty' };
  const v = p.get('v');
  if (v === null || !/^[1-9]\d{0,3}$/.test(v)) return fail('v');
  if (!READABLE_VERSIONS.includes(v)) return { status: 'error', code: 'bad_version' };
  const es = p.getAll('e');
  if (es.length !== 1) return fail('e');
  const e = es[0];
  if (e.length > MAX_E_LENGTH || !/^[A-Za-z0-9_-]+$/.test(e)) return fail('e');
  const tz = p.get('tz');
  if (!isValidTz(tz)) return fail('tz');
  let bytes;
  try {
    bytes = b64urlToBytes(e);
  } catch {
    return fail('e');
  }
  if (v !== '1') {
    if (!canInflate()) return { status: 'error', code: 'bad_browser' };
    try {
      bytes = await inflateRaw(bytes, MAX_INFLATED_BYTES);
    } catch {
      return fail('inflate');
    }
  }
  let arr;
  try {
    arr = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('json');
  }
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > LIMITS.events) return fail('array');
  const events = [];
  for (let i = 0; i < arr.length; i++) {
    const r = fromWire(arr[i]);
    if (r.error) return fail(`#${i}:${r.error}`);
    const errs = validateEvent(r.event);
    if (errs.length) return fail(`#${i}:${errs[0]}`);
    events.push(r.event);
  }
  return { status: 'ok', events, tz };
}
