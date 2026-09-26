// Model + i18n parity tests. Run: node test/model.test.mjs
import assert from 'node:assert/strict';
import {
  newEvent, normalizeEvent, validateEvent, expandDraft, isValidDate, isValidTime, addDays, weekdayOf, compareDates, LIMITS,
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
deq(Object.keys(newEvent()).sort(), ['allDay', 'date', 'description', 'endDate', 'endTime', 'id', 'location', 'recurrence', 'startTime', 'title', 'url'], 'event shape');

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
  'err_byday_empty', 'err_byday_start', 'err_each_repeat']) {
  ok(typeof STR.en[k] === 'string' && typeof STR.de[k] === 'string', `error key ${k} translated`);
}
eq(STR.de.rec_summary({ freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], count: 10, until: null }, STR.de.weekday_codes), 'Jede Woche, am Mo, Mi, 10-mal', 'de summary');
eq(STR.en.rec_summary({ freq: 'monthly', interval: 2, byDay: [], count: null, until: '2027-06-30' }, STR.en.weekday_codes), 'Every 2 months, until 2027-06-30', 'en summary');
eq(STR.en.rec_summary({ freq: 'none', interval: 1, byDay: [], count: null, until: null }, {}), '', 'none summary is empty');

console.log(`model.test: ${checks} checks passed`);
