// Nominatim client tests with an injected fetch double. Run: node test/geocode.test.mjs
import assert from 'node:assert/strict';
import { NOMINATIM, MAX_RESULTS, nominatimUrl, fitLabel, mapResults, searchNominatim, GeoSearchError } from '../geocode.js';
import { LIMITS } from '../model.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const rejectsWith = async (p, code, m) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  ok(err instanceof GeoSearchError && err.code === code, `${m}: ${err && err.code}`);
  return err;
};

// URL
eq(nominatimUrl('Café & Bar, Münchner Freiheit 1', 'de'),
  'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=Caf%C3%A9+%26+Bar%2C+M%C3%BCnchner+Freiheit+1&accept-language=de', 'query encoded');
deq(new URL(nominatimUrl('a&q=evil', 'en')).searchParams.getAll('q'), ['a&q=evil'], 'no parameter injection');
eq(new URL(nominatimUrl('x', 'en')).origin, NOMINATIM, 'one origin');
eq(MAX_RESULTS, 5, 'five results');

// labels
eq(fitLabel('  Marienplatz,\tAltstadt \n München '), 'Marienplatz, Altstadt München', 'whitespace collapsed and trimmed');
{
  const parts = Array.from({ length: 30 }, (_, i) => `Part number ${i + 1}`);
  const long = parts.join(', ');
  const fitted = fitLabel(long);
  ok([...long].length > LIMITS.location, 'input exceeds the limit');
  ok([...fitted].length <= LIMITS.location, 'fitted label fits the Location limit');
  ok(fitted.startsWith('Part number 1, ') && !fitted.endsWith(','), 'trailing parts dropped at a comma boundary');
  ok(parts.includes(fitted.split(', ').at(-1)), 'ends on a whole part');
  eq(fitLabel('x'.repeat(250)), 'x'.repeat(LIMITS.location), 'a single oversized part is cut at the limit');
}

// results
const sample = [
  { place_id: 1, display_name: 'Marienplatz, Altstadt, Altstadt-Lehel, München, Bayern, 80331, Deutschland', lat: '48.1371079', lon: '11.5753822' },
  { place_id: 2, display_name: 'Marienplatz, Altstadt-Lehel, München, Bayern, 80331, Deutschland', lat: '48.1374', lon: '11.5755' },
  { place_id: 3, display_name: 'broken lat', lat: 'x', lon: '11.5' },
  { place_id: 4, display_name: 'out of range', lat: '95.0', lon: '11.5' },
  { place_id: 5, display_name: 'no lon', lat: '48.1' },
  null,
];
deq(mapResults(sample), [
  { label: 'Marienplatz, Altstadt, Altstadt-Lehel, München, Bayern, 80331, Deutschland', geo: '48.137108,11.575382' },
  { label: 'Marienplatz, Altstadt-Lehel, München, Bayern, 80331, Deutschland', geo: '48.1374,11.5755' },
], 'valid entries mapped and canonicalized, broken ones skipped');
eq(mapResults({}), null, 'an object is not a result list');
eq(mapResults('[]'), null, 'a string is not a result list');
deq(mapResults([]), [], 'no results is an empty list');
eq(mapResults(Array.from({ length: 7 }, (_, i) => ({ display_name: `P${i}`, lat: '48.1', lon: `11.${i}` }))).length, MAX_RESULTS, 'capped at MAX_RESULTS');

// searchNominatim with a recording fetch double
const recorder = (response) => {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(init) : response; };
  return { calls, impl };
};
const okResponse = { ok: true, status: 200, json: async () => sample };
{
  const { calls, impl } = recorder(okResponse);
  const results = await searchNominatim(' Marienplatz ', 'de', { fetchImpl: impl });
  eq(calls.length, 1, 'exactly one request');
  eq(calls[0].url, nominatimUrl('Marienplatz', 'de'), 'trimmed query in the URL');
  eq(calls[0].init.referrerPolicy, 'no-referrer-when-downgrade', 'the page URL identifies the application');
  eq(calls[0].init.credentials, 'omit', 'no credentials');
  eq(calls[0].init.cache, 'no-store', 'nothing cached by the browser');
  ok(!('headers' in calls[0].init), 'no custom headers (no preflight)');
  ok(calls[0].init.signal instanceof AbortSignal, 'an abort signal is passed');
  deq(results, mapResults(sample), 'results mapped');
}
{
  const { calls, impl } = recorder(okResponse);
  await rejectsWith(searchNominatim('   ', 'en', { fetchImpl: impl }), 'empty', 'blank query');
  eq(calls.length, 0, 'blank query sends nothing');
}
{
  const { impl } = recorder({ ok: false, status: 429, json: async () => [] });
  const err = await rejectsWith(searchNominatim('x', 'en', { fetchImpl: impl }), 'http', 'non-2xx');
  eq(err.status, 429, 'status carried');
}
{
  const hang = (init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const { impl } = recorder(hang);
  let watchdog;
  const race = Promise.race([
    searchNominatim('x', 'en', { fetchImpl: impl, timeoutMs: 20 }),
    new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('watchdog: no timeout fired')), 1000); }),
  ]);
  await rejectsWith(race, 'timeout', 'timeout aborts a hanging request');
  clearTimeout(watchdog);
}
{
  const hang = (init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  const { impl } = recorder(hang);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 10);
  await rejectsWith(searchNominatim('x', 'en', { fetchImpl: impl, signal: ctl.signal, timeoutMs: 500 }), 'aborted', 'the caller can abort');
}
{
  const { impl } = recorder(() => { throw new TypeError('Failed to fetch'); });
  await rejectsWith(searchNominatim('x', 'en', { fetchImpl: impl }), 'network', 'a rejected request is a network error');
}
{
  const { impl } = recorder({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  await rejectsWith(searchNominatim('x', 'en', { fetchImpl: impl }), 'bad_response', 'unparseable body');
  const { impl: impl2 } = recorder({ ok: true, status: 200, json: async () => ({}) });
  await rejectsWith(searchNominatim('x', 'en', { fetchImpl: impl2 }), 'bad_response', 'non-array body');
}
{
  const { impl } = recorder(okResponse);
  await searchNominatim('x', 'en', { fetchImpl: impl, timeoutMs: 60000 });
  eq(process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length, 0, 'the timeout timer is cleared after a response');
}

console.log(`geocode.test: ${checks} checks passed`);
