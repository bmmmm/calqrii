// Model + i18n parity tests. Run: node test/model.test.mjs
import assert from 'node:assert/strict';
import {
  newEvent, normalizeEvent, validateEvent, expandDraft, isValidDate, isValidTime, addDays, weekdayOf, compareDates, LIMITS,
  DURATIONS, DEFAULT_DURATION, timeToMinutes, minutesToTime, addMinutes, spanMinutes, durationOption,
  presetRule, recurrencePreset, isGeo, parseGeo, osmMapUrl, osmSearchUrl,
} from '../model.js';
import { STR } from '../i18n.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const base = { title: 'T', date: '2026-10-05', startTime: '09:00' };
const errsOf = (partial) => validateEvent(newEvent({ ...base, ...partial }));
const has = (partial, key) => ok(errsOf(partial).includes(key), `${key} for ${JSON.stringify(partial)}`);
const lacks = (partial, key) => ok(!errsOf(partial).includes(key), `no ${key} for ${JSON.stringify(partial)}`);

// helpers
ok(isValidDate('2026-02-28') && !isValidDate('2026-02-30') && !isValidDate('2026-13-01') && !isValidDate('26-1-1'), 'isValidDate');
ok(isValidDate('2028-02-29') && !isValidDate('2027-02-29'), 'leap years');
ok(isValidTime('00:00') && isValidTime('23:59') && !isValidTime('24:00') && !isValidTime('9:00') && !isValidTime('12:60'), 'isValidTime');
eq(addDays('2026-12-31', 1), '2027-01-01', 'addDays across year');
eq(addDays('2026-03-01', -1), '2026-02-28', 'addDays backwards');
eq(weekdayOf('2026-10-05'), 'MO', 'Monday');
eq(weekdayOf('2026-10-04'), 'SU', 'Sunday');
eq(compareDates('2026-01-01', '2026-01-02'), -1, 'compareDates');

// duration helpers
const T = (date, startTime, endDate, endTime) => ({ date, startTime, endDate, endTime });
const D = '2026-10-05';
eq(timeToMinutes('09:30'), 570, 'timeToMinutes');
ok(timeToMinutes('00:00') === 0 && timeToMinutes('23:59') === 1439, 'timeToMinutes bounds');
ok(isNaN(timeToMinutes('24:00')) && isNaN(timeToMinutes('')), 'timeToMinutes refuses invalid');
eq(minutesToTime(570), '09:30', 'minutesToTime');
eq(minutesToTime(5), '00:05', 'minutesToTime pads');
eq(minutesToTime(1470), '00:30', 'minutesToTime wraps past midnight');
eq(minutesToTime(-15), '23:45', 'minutesToTime wraps negative');
deq(addMinutes(D, '09:00', 60), { date: D, time: '10:00' }, 'addMinutes same day');
deq(addMinutes(D, '23:30', 60), { date: '2026-10-06', time: '00:30' }, 'addMinutes carries the day');
deq(addMinutes(D, '12:30', 480), { date: D, time: '20:30' }, 'addMinutes 8 h stays on the day');
deq(addMinutes('2026-12-31', '23:45', 15), { date: '2027-01-01', time: '00:00' }, 'addMinutes exactly midnight → next day');
deq(addMinutes('', '23:30', 60), { date: '', time: '00:30' }, 'addMinutes keeps a blank date blank');
ok(addMinutes(D, '9:00', 60) === null && addMinutes(D, '09:00', NaN) === null, 'addMinutes refuses invalid input');
eq(spanMinutes(T(D, '09:00', D, '10:15')), 75, 'spanMinutes same day');
eq(spanMinutes(T(D, '23:30', '2026-10-06', '00:30')), 60, 'spanMinutes across midnight');
eq(spanMinutes(T('2026-12-31', '23:00', '2027-01-01', '01:00')), 120, 'spanMinutes across a year');
eq(spanMinutes(T('', '09:00', '', '10:00')), 60, 'spanMinutes: a blank endDate counts as the same day');
ok(isNaN(spanMinutes(T(D, '09:00', D, ''))), 'spanMinutes NaN without an end');
eq(durationOption(T(D, '', D, ''), '90'), '90', 'blank times keep the preset');
eq(durationOption(T(D, '', D, ''), 'custom'), String(DEFAULT_DURATION), 'blank times reset custom to the default');
eq(durationOption(T(D, '', '2026-10-07', ''), '60'), 'custom', 'blank times across days are custom');
eq(durationOption(T(D, '09:00', D, ''), '60'), 'custom', 'a start without an end is custom');
eq(durationOption(T(D, '09:00', D, '10:15'), 'custom'), '75', 'a matching span picks its preset');
eq(durationOption(T(D, '09:00', D, '10:10'), '60'), 'custom', 'an odd span is custom');
eq(durationOption(T(D, '23:30', '2026-10-06', '00:30'), 'custom'), '60', 'an overnight hour is the 60 preset');
eq(durationOption(T(D, '09:00', '2026-10-07', '10:00'), '60'), 'custom', 'a multi-day span never matches a preset');
deq(DURATIONS, [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480], 'duration presets');
eq(DEFAULT_DURATION, 60, 'default duration');

// validation: valid + invalid per rule
deq(errsOf({}), [], 'base draft is valid');
has({ title: '' }, 'err_title_required'); lacks({ title: 'x' }, 'err_title_required');
has({ title: 'a'.repeat(LIMITS.title + 1) }, 'err_too_long'); lacks({ title: 'ä'.repeat(LIMITS.title) }, 'err_too_long');
has({ description: 'a'.repeat(LIMITS.description + 1) }, 'err_too_long');
has({ date: '2026-02-30' }, 'err_date_invalid'); has({ endDate: 'nope' }, 'err_date_invalid'); lacks({}, 'err_date_invalid');
has({ startTime: '' }, 'err_time_required'); lacks({ startTime: '', allDay: true }, 'err_time_required');
has({ startTime: '25:00' }, 'err_time_invalid'); has({ endTime: '9:0' }, 'err_time_invalid'); lacks({ endTime: '10:00' }, 'err_time_invalid');
has({ endDate: '2026-10-06' }, 'err_end_time_required'); lacks({ endDate: '2026-10-06', endTime: '10:00' }, 'err_end_time_required');
lacks({ endDate: '2026-10-06', allDay: true }, 'err_end_time_required');
has({ endDate: '2026-10-04' }, 'err_end_before_start'); has({ endTime: '08:00' }, 'err_end_before_start');
lacks({ endTime: '09:00' }, 'err_end_before_start'); lacks({ endTime: '09:30' }, 'err_end_before_start');
has({ url: 'ex.org' }, 'err_url_invalid'); has({ url: 'https://ex.org/a b' }, 'err_url_invalid'); lacks({ url: 'https://ex.org/' }, 'err_url_invalid');
const rec = (o) => ({ recurrence: { freq: 'daily', interval: 1, byDay: [], count: null, until: null, ...o } });
has(rec({ interval: 0 }), 'err_interval'); has(rec({ interval: 100 }), 'err_interval'); has(rec({ interval: 1.5 }), 'err_interval'); lacks(rec({ interval: 99 }), 'err_interval');
has(rec({ count: 0 }), 'err_count'); has(rec({ count: 1000 }), 'err_count'); lacks(rec({ count: 999 }), 'err_count');
has(rec({ until: '2026-10-04' }), 'err_until_before_start'); lacks(rec({ until: '2026-10-05' }), 'err_until_before_start');
has(rec({ until: '2026-99-99' }), 'err_date_invalid');
has(rec({ count: 2, until: '2026-12-31' }), 'err_count_and_until'); lacks(rec({ count: 2 }), 'err_count_and_until');
has(rec({ freq: 'weekly' }), 'err_byday_empty'); lacks(rec({ freq: 'weekly', byDay: ['MO'] }), 'err_byday_empty');
has(rec({ freq: 'weekly', byDay: ['TU'] }), 'err_byday_start'); lacks(rec({ freq: 'weekly', byDay: ['TU', 'MO'] }), 'err_byday_start');
deq(newEvent({ ...base, ...rec({ freq: 'fortnightly' }) }).recurrence.freq, 'none', 'unknown freq normalizes to none');
deq(errsOf(rec({ freq: 'weekly', interval: 2, byDay: ['MO', 'WE'], count: 10 })), [], 'valid weekly series');
lacks({ startTime: '', allDay: true, endDate: '2026-10-04' }, 'err_time_required');
has({ startTime: '', allDay: true, endDate: '2026-10-04' }, 'err_end_before_start');

// normalizeEvent
const n = normalizeEvent({ title: '  Café ', date: '2026-10-05', allDay: true, startTime: '09:00', endTime: '10:00',
  recurrence: { freq: 'weekly', interval: '2', byDay: ['WE', 'MO', 'MO', 'XX'], count: '', until: '' } });
eq(n.title, 'Café', 'NFC + trim');
eq(n.endDate, '2026-10-05', 'endDate defaults to date');
eq(n.startTime + n.endTime, '', 'all-day clears times');
deq(n.recurrence, { freq: 'weekly', interval: 2, byDay: ['MO', 'WE'], count: null, until: null }, 'byDay dedupe + sort, numbers coerced');
const none = normalizeEvent({ title: 't', date: '2026-10-05', recurrence: { freq: 'none', interval: 5, byDay: ['MO'], count: 3, until: '2027-01-01' } });
deq(none.recurrence, { freq: 'none', interval: 1, byDay: [], count: null, until: null }, 'none resets the rule');
deq(normalizeEvent({ title: 't', date: '2026-10-05', recurrence: { freq: 'monthly', byDay: ['MO'] } }).recurrence.byDay, [], 'byDay only for weekly');
eq(newEvent().id, 0, 'newEvent id defaults to 0');
deq(Object.keys(newEvent()).sort(), ['allDay', 'date', 'description', 'endDate', 'endTime', 'geo', 'id', 'location', 'recurrence', 'startTime', 'title', 'url'], 'event shape');

// recurrence presets
const ruleOf = (o) => newEvent({ ...base, ...rec(o) }).recurrence;
deq(presetRule('weekly', '2026-10-07'), { interval: 1, byDay: ['WE'] }, 'weekly preset ticks the start weekday');
deq(presetRule('monthly', '2026-10-07'), { interval: 1, byDay: [] }, 'non-weekly presets carry no weekdays');
deq(presetRule('weekly', ''), { interval: 1, byDay: [] }, 'weekly preset without a date has no weekday');
for (let i = 0; i < 7; i++) {
  const d = addDays('2026-10-05', i);
  for (const f of ['daily', 'weekly', 'monthly', 'yearly']) {
    const ev = newEvent({ ...base, date: d, recurrence: { freq: f, ...presetRule(f, d), count: null, until: null } });
    deq(validateEvent(ev), [], `preset ${f} on ${d} is valid`);
    eq(recurrencePreset(ev.recurrence, d), f, `preset ${f} on ${d} round-trips`);
  }
}
eq(recurrencePreset(newEvent(base).recurrence, base.date), 'none', 'no rule shows none');
eq(recurrencePreset(ruleOf({ interval: 2 }), D), 'custom', 'interval 2 is custom');
eq(recurrencePreset(ruleOf({ freq: 'weekly', interval: 2, byDay: ['MO'] }), D), 'custom', 'weekly every 2 is custom');
eq(recurrencePreset(ruleOf({ freq: 'weekly', byDay: ['MO', 'WE'] }), D), 'custom', 'weekly on two days is custom');
eq(recurrencePreset(ruleOf({ freq: 'weekly', byDay: ['TU'] }), D), 'custom', 'weekly on another day is custom');
eq(recurrencePreset(ruleOf({ freq: 'weekly', byDay: ['MO'] }), ''), 'custom', 'weekly without a date is custom');
eq(recurrencePreset(ruleOf({ freq: 'yearly', count: 5 }), D), 'yearly', 'an end never forces custom');

// map position: parseGeo accepts
const M = '48.137154,11.576124';
const accepted = [
  ['48.137154, 11.576124', M, 'lat, lon'],
  [M, M, 'canonical is a fixed point'],
  ['48.137154 11.576124', M, 'space separated'],
  ['  -33.8688 ,  151.2093 ', '-33.8688,151.2093', 'negative, padded'],
  ['+48.1, +11.5', '48.1,11.5', 'plus signs dropped'],
  ['48.13715449, 11.57612451', '48.137154,11.576125', 'rounded to 6 decimals'],
  ['48.10000, 11.50', '48.1,11.5', 'trailing zeros dropped'],
  ['0.0000004,-0.0000004', '0,0', 'rounds to zero without -0'],
  ['geo:48.137154,11.576124', M, 'geo URI'],
  ['GEO:48.137154,11.576124;u=35', M, 'geo URI, upper case, uncertainty ignored'],
  ['geo:48.2,16.3,183', '48.2,16.3', 'geo URI altitude dropped'],
  ['geo:48.2,16.3;crs=wgs84;u=10', '48.2,16.3', 'geo URI crs=wgs84'],
  ['geo:48.2,16.3?z=17', '48.2,16.3', 'geo URI with a zoom query'],
  ['geo:0,0?q=48.137,11.576(Marienplatz)', '48.137,11.576', 'Android geo:0,0?q=pair(label) takes the pair'],
  ['https://www.openstreetmap.org/?mlat=48.1371540&mlon=11.5761240#map=17/48.13715/11.57612', M, 'OSM marker beats #map'],
  ['https://www.openstreetmap.org/#map=17/48.13715/11.57612', '48.13715,11.57612', 'OSM #map'],
  ['https://www.openstreetmap.org/#map=17/48.13715/11.57612&layers=N', '48.13715,11.57612', 'OSM #map with layers'],
  ['https://osm.org/?mlat=1&mlon=2', '1,2', 'osm.org short host'],
  ['https://www.google.com/maps/@48.1373932,11.5732598,17z', '48.137393,11.57326', 'Google @center'],
  ['https://www.google.de/maps/place/Marienplatz/@48.1373932,11.5732598,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d48.1373932!4d11.5754485', '48.137393,11.575449', 'Google place pin beats @center'],
  ['https://maps.google.com/?q=48.137,11.576', '48.137,11.576', 'Google q='],
  ['https://www.google.com/maps?ll=48.137,11.576&z=17', '48.137,11.576', 'Google ll='],
  ['https://www.google.com/maps/search/?api=1&query=48.137%2C11.576', '48.137,11.576', 'Google api=1 query'],
  ['https://maps.apple.com/?ll=48.137,11.576&q=Marienplatz', '48.137,11.576', 'Apple ll='],
  ['90.0000004, 0', '90,0', 'range checked after rounding'],
];
for (const [input, want, m] of accepted) eq(parseGeo(input), want, `parseGeo: ${m}`);
for (const [, g] of accepted) {
  ok(parseGeo(g) === g && isGeo(g) && parseGeo(osmMapUrl(g)) === g, `canonical ${g} is a fixed point, valid, and round-trips through the map link`);
}
// parseGeo rejects
for (const bad of ['', 'Marienplatz', '91, 0', '0, 180.5', '90.0000006, 0', '48,137154 11,576124', '48.1', '48.1, 11.5, 3',
  'geo:48.1', 'geo:1,2,3,4', 'geo:48.1,11.5;crs=utm', 'geo:0,0?q=Marienplatz',
  'https://example.com/?mlat=1&mlon=2', 'https://www.google.com/maps/@120.5,45.2,17z', 'https://maps.app.goo.gl/abc',
  'https://www.openstreetmap.org/#map=17/95/11', 'https://www.openstreetmap.org/?mlat=48.1#map=17/48/11',
  'https://www.google.com/maps?q=Marienplatz', 'https://www.openstreetmap.org/node/123',
  '1e1, 5', 'NaN, 0', 'Infinity, 0', '0x10, 5', 'javascript:alert(1)', null, 48.1, 'http://' + 'a'.repeat(5000)]) {
  eq(parseGeo(bad), null, `parseGeo rejects ${JSON.stringify(bad).slice(0, 60)}`);
}
// isGeo is the strict canonical check
for (const g of ['-90,-180', '90,180', '0,0', M]) ok(isGeo(g), `isGeo accepts ${g}`);
for (const g of ['-0,5', '0,-0', '48.1370,11', '048,1', '48.1371544,11', '48, 11', '48.137154;11.576124', '90.000001,0', '0,180.000001', '+48,11', 48, null]) {
  ok(!isGeo(g), `isGeo rejects ${JSON.stringify(g)}`);
}
eq(osmMapUrl(M), 'https://www.openstreetmap.org/?mlat=48.137154&mlon=11.576124#map=17/48.137154/11.576124', 'map link with marker');
eq(osmMapUrl('x'), '', 'no map link for junk');
eq(osmSearchUrl('Café & Bar, Münchner Freiheit 1'), 'https://www.openstreetmap.org/search?query=Caf%C3%A9%20%26%20Bar%2C%20M%C3%BCnchner%20Freiheit%201', 'search link encodes the text');
eq(osmSearchUrl('  '), 'https://www.openstreetmap.org/', 'blank text links to the site');
// geo in the model
eq(newEvent({ geo: 'geo:48.1,11.5' }).geo, '48.1,11.5', 'normalize canonicalizes a parseable position');
eq(newEvent({ geo: 'Marienplatz' }).geo, 'Marienplatz', 'unparseable input survives normalization');
has({ geo: 'Marienplatz' }, 'err_geo_invalid'); has({ geo: '91,0' }, 'err_geo_invalid');
lacks({ geo: '' }, 'err_geo_invalid'); lacks({ geo: '48.1,11.5' }, 'err_geo_invalid');
eq(newEvent().geo, '', 'geo defaults to empty');
ok(validateEvent({ ...newEvent(base), geo: '48.10,11.5' }).includes('err_geo_invalid'), 'validation is strict on a raw non-canonical value');

// expandDraft
const draft = newEvent({ title: 'T', startTime: '09:00', endTime: '10:00', date: '2026-10-05' });
const days = ['2026-10-07', '2026-10-05', '2026-10-09', '2026-10-05'];
const each = expandDraft(draft, days, 'each');
deq(each.errors, [], 'each: no errors');
eq(each.events.length, 3, 'each → 3 events');
deq(each.events.map((e) => e.date), ['2026-10-05', '2026-10-07', '2026-10-09'], 'each: sorted, deduped');
ok(each.events.every((e) => e.date === e.endDate), 'each: single-day copies');
const span = expandDraft(draft, days, 'span');
eq(span.events.length, 1, 'span → 1 event');
eq(span.events[0].date + '/' + span.events[0].endDate, '2026-10-05/2026-10-09', 'span from min to max');
deq(expandDraft({ ...draft, ...rec({ freq: 'daily' }) }, days, 'each').errors, ['err_each_repeat'], 'each + series refused');
eq(expandDraft({ ...draft, ...rec({ freq: 'daily' }) }, days, 'span').events.length, 1, 'span + series allowed');
eq(expandDraft(draft, ['2026-10-05'], 'each').events.length, 1, 'one day → draft as is');
eq(expandDraft(draft, [], 'each').events.length, 1, 'no day → draft as is');
deq(expandDraft({ ...draft, title: '' }, days, 'each'), { events: [], errors: ['err_title_required'] }, 'invalid draft → errors, no events');

// i18n parity: same keys, same types
const en = Object.keys(STR.en).sort();
const de = Object.keys(STR.de).sort();
deq(en, de, 'en and de have the same keys');
for (const k of en) eq(typeof STR.en[k], typeof STR.de[k], `same type for ${k}`);
ok(en.length > 60, 'string table is populated');
for (const k of ['err_title_required', 'err_too_long', 'err_date_invalid', 'err_time_required', 'err_time_invalid', 'err_end_time_required',
  'err_end_before_start', 'err_url_invalid', 'err_interval', 'err_count', 'err_until_before_start', 'err_count_and_until',
  'err_byday_empty', 'err_byday_start', 'err_each_repeat', 'err_geo_invalid']) {
  ok(typeof STR.en[k] === 'string' && typeof STR.de[k] === 'string', `error key ${k} translated`);
}
eq(STR.de.rec_summary({ freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], count: 10, until: null }, STR.de.weekday_codes), 'Jede Woche, am Mo, Mi, 10-mal', 'de summary');
eq(STR.en.rec_summary({ freq: 'monthly', interval: 2, byDay: [], count: null, until: '2027-06-30' }, STR.en.weekday_codes), 'Every 2 months, until 2027-06-30', 'en summary');
eq(STR.en.rec_summary({ freq: 'none', interval: 1, byDay: [], count: null, until: null }, {}), '', 'none summary is empty');
eq(STR.en.dur_label(75), '1 h 15 min', 'en duration label');
eq(STR.de.dur_label(75), '1 Std. 15 Min.', 'de duration label');
eq(STR.en.dur_label(45), '45 min', 'sub-hour label has no hour part');
eq(STR.de.dur_label(120), '2 Std.', 'whole hours have no minute part');

console.log(`model.test: ${checks} checks passed`);
