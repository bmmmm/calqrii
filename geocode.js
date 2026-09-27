// Opt-in address search against OpenStreetMap's Nominatim. The only shipped
// module allowed to use the network and the only one that names its host
// (scripts/web-smoke.mjs pins both); app.js calls it only from the
// address-search click, after the user consented. No other URL in this file.
import { parseGeo, LIMITS } from './model.js';

export const NOMINATIM = 'https://nominatim.openstreetmap.org';
export const TIMEOUT_MS = 15000;
export const MAX_RESULTS = 5;

export class GeoSearchError extends Error {
  /** @param {'empty'|'network'|'http'|'timeout'|'aborted'|'bad_response'} code */
  constructor(code, status = 0) {
    super(code);
    this.name = 'GeoSearchError';
    this.code = code;
    this.status = status;
  }
}

/** The search URL; URLSearchParams encodes the query (space → '+', '&' → %26, UTF-8 percent-escapes). */
export function nominatimUrl(query, lang) {
  const p = new URLSearchParams({ format: 'jsonv2', limit: String(MAX_RESULTS), q: query, 'accept-language': lang });
  return `${NOMINATIM}/search?${p}`;
}

/**
 * A display name that fits the Location field: NFC, control characters →
 * space, whitespace collapsed, trailing ", "-parts dropped until it fits, a
 * single oversized part cut at the limit.
 */
export function fitLabel(name) {
  const cp = (s) => [...s].length;
  let s = String(name).normalize('NFC').replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  while (cp(s) > LIMITS.location && s.includes(', ')) s = s.slice(0, s.lastIndexOf(', ')).trim();
  if (cp(s) > LIMITS.location) s = [...s].slice(0, LIMITS.location).join('').trim();
  return s;
}

/** [{ label, geo }] from a jsonv2 array (at most MAX_RESULTS); null when the answer is not an array; broken entries are skipped. */
export function mapResults(json) {
  if (!Array.isArray(json)) return null;
  const out = [];
  for (const r of json) {
    if (!r || typeof r !== 'object' || typeof r.display_name !== 'string' || typeof r.lat !== 'string' || typeof r.lon !== 'string') continue;
    const geo = parseGeo(`${r.lat},${r.lon}`);
    const label = fitLabel(r.display_name);
    if (geo === null || label === '') continue;
    out.push({ label, geo });
    if (out.length === MAX_RESULTS) break;
  }
  return out;
}

/**
 * One GET to Nominatim. Rejects with a GeoSearchError: 'empty' (blank query,
 * no request), 'http' (with the status), 'bad_response', 'timeout', 'aborted'
 * (the caller's signal) or 'network'. No custom headers, so the request stays
 * a simple CORS request without a preflight.
 */
export async function searchNominatim(query, lang, { fetchImpl = fetch, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const q = String(query).trim();
  if (q === '') throw new GeoSearchError('empty');
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetchImpl(nominatimUrl(q, lang), {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        // The page's meta referrer is no-referrer, but Nominatim's usage policy wants the
        // application identified. The referrer never carries the fragment, so the page
        // URL (origin + path) goes out with this one request and nothing else does.
        referrerPolicy: 'no-referrer-when-downgrade',
        signal: ctl.signal,
      });
    } catch {
      if (timedOut) throw new GeoSearchError('timeout');
      if (signal && signal.aborted) throw new GeoSearchError('aborted');
      throw new GeoSearchError('network');
    }
    if (!res.ok) throw new GeoSearchError('http', res.status);
    let json;
    try { json = await res.json(); } catch { throw new GeoSearchError('bad_response'); }
    const results = mapResults(json);
    if (results === null) throw new GeoSearchError('bad_response');
    return results;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
