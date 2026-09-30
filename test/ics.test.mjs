// ICS serializer tests. Run: node test/ics.test.mjs
import assert from 'node:assert/strict';
import {
  escapeText, foldLine, formatRrule, zonedToUtc, formatUtcDateTime, uidFor,
  serializeEvent, serializeCalendar, veventLines, contentLines,
} from '../ics.js';
import { newEvent } from '../model.js';
import { OPTS, A, B, C, D, A_ICS, B_ICS, C_ICS, D_ICS, ABC_ICS, A_VEVENT, B_VEVENT, C_VEVENT, D_VEVENT } from './helpers/fixtures.mjs';

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s).length;
const physicalLines = (ics) => ics.split('\r\n').filter((l) => l !== '');
const unfold = (ics) => ics.replace(/\r\n /g, '');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++; };

// 1. fixtures byte for byte, byte counts, UIDs
eq(serializeEvent(A, OPTS), A_ICS, 'fixture A');
eq(serializeEvent(B, OPTS), B_ICS, 'fixture B');
eq(serializeEvent(C, OPTS), C_ICS, 'fixture C');
eq(bytes(A_ICS), 415, 'A is 415 bytes');
eq(bytes(B_ICS), 277, 'B is 277 bytes');
eq(bytes(C_ICS), 425, 'C is 425 bytes');
eq(uidFor(A, OPTS), '6db194cd5c7bbcc9@calqrii', 'UID A');
eq(uidFor(B, OPTS), '5c4978a00ff66a4f@calqrii', 'UID B');
eq(uidFor(C, OPTS), 'fb1bf38ddbe27857@calqrii', 'UID C');

// 1b. fixture D: a map position becomes GEO between LOCATION and URL, and is part of the UID
eq(serializeEvent(D, OPTS), D_ICS, 'fixture D');
eq(bytes(D_ICS), 463, 'D is 463 bytes (339 + the folded Apple location line)');
eq(uidFor(D, OPTS), '36d83bbefaf9ceb0@calqrii', 'UID D');
{
  const at = (prefix) => D_VEVENT.findIndex((l) => l.startsWith(prefix));
  ok(at('GEO:') === at('LOCATION:') + 1 && at('GEO:') === at('URL:') - 1, 'GEO sits right after LOCATION and before URL');
  eq(D_VEVENT[at('GEO:')], 'GEO:48.137154;11.576124', 'GEO joins the floats with a semicolon');
  eq(uidFor({ ...D, geo: '' }, OPTS), '40ebc0f190ee1aa2@calqrii', 'the UID changes without the position');
  const injected = serializeEvent({ ...D, geo: '48.1,11.5\r\nX-INJECTED:y' }, OPTS);
  ok(!injected.includes('GEO') && !injected.includes('X-INJECTED') && !injected.includes('X-APPLE'), 'a non-canonical position is dropped, never injected — no GEO, no Apple line');
  ok(!A_ICS.includes('GEO') && !A_ICS.includes('X-APPLE'), 'no GEO and no Apple line without a position');
}

// 1c. Apple's structured location: next to GEO, X-TITLE = LOCATION text, derived and therefore outside the UID hash
{
  const APPLE = String.raw`X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-APPLE-RADIUS=100;X-TITLE=Marienplatz 1\, 80331 München:geo:48.137154,11.576124`;
  const dLines = unfold(D_ICS).split('\r\n');
  eq(dLines.find((l) => l.startsWith('X-APPLE')), APPLE, 'the Apple line unfolds to X-TITLE with the escaped LOCATION text and a geo: URI');
  eq(dLines.indexOf('END:VEVENT') - dLines.findIndex((l) => l.startsWith('X-APPLE')), 1, 'the Apple line is the last property of the VEVENT');
  eq(uidFor(D, OPTS), '36d83bbefaf9ceb0@calqrii', 'the UID is the pre-Apple value: the line is not hashed');
  ok(!contentLines(D, OPTS).some((l) => l.startsWith('X-APPLE')), 'contentLines (the hashed set) carry no Apple line');
  const quoted = unfold(serializeEvent({ ...D, location: 'Raum 3: "Aula"' }, OPTS));
  ok(quoted.includes(String.raw`;X-TITLE="Raum 3: 'Aula'":geo:`), 'a colon puts X-TITLE in the RFC quoted form, a DQUOTE becomes an apostrophe');
  const apos = unfold(serializeEvent({ ...D, location: 'Café "Zentral"' }, OPTS));
  ok(apos.includes(String.raw`;X-TITLE=Café 'Zentral':geo:`), 'without a colon the value stays unquoted, the DQUOTE still becomes an apostrophe');
  const semi = unfold(serializeEvent({ ...D, location: 'Süd; Tisch 4\nHof' }, OPTS));
  ok(semi.includes(String.raw`;X-TITLE="Süd\; Tisch 4\nHof":geo:`), 'a semicolon would end the parameter for a strict parser: quoted, escapes kept');
  const comma = unfold(serializeEvent({ ...D, location: 'Platz 1, München' }, OPTS));
  ok(comma.includes(String.raw`;X-TITLE=Platz 1\, München:geo:`), "a comma stays in Apple's unquoted form (the one documented as working)");
  // a position without a text: the coordinates become the LOCATION text, so Apple and every other calendar show something
  const bare = unfold(serializeEvent({ ...D, location: '' }, OPTS));
  ok(bare.includes('\r\nLOCATION:' + String.raw`48.137154\, 11.576124` + '\r\n'), 'no text → LOCATION carries "lat, lon"');
  ok(bare.includes(String.raw`;X-TITLE=48.137154\, 11.576124:geo:48.137154,11.576124`), 'no text → X-TITLE carries the same coordinates');
  ok(uidFor({ ...D, location: '' }, OPTS) !== uidFor({ ...D, location: '', geo: '' }, OPTS), 'the synthesized LOCATION is hashed like a typed one');
  ok(!unfold(serializeEvent({ ...D, location: '', geo: '' }, OPTS)).includes('LOCATION'), 'no text and no position → no LOCATION');
}

// 2. folding: every physical line ≤ 75 octets; continuation = one space + ≤ 74
const stress = [
  newEvent({ title: 'ä'.repeat(300), date: '2026-01-01', allDay: true }),
  newEvent({ title: '🎉'.repeat(200), date: '2026-01-01', allDay: true }),
  newEvent({ title: '👩‍👩‍👧 '.repeat(50), date: '2026-01-01', allDay: true, description: '日本語のテキスト。'.repeat(40) }),
  newEvent({ title: 'x', date: '2026-01-01', allDay: true, description: '漢字'.repeat(120) + '\n' + 'ü'.repeat(80) }),
];
for (const ics of [A_ICS, B_ICS, C_ICS, D_ICS, ...stress.map((ev) => serializeEvent(ev, OPTS))]) {
  for (const line of physicalLines(ics)) {
    ok(bytes(line) <= 75, `line ≤ 75 octets: ${bytes(line)}`);
    if (line.startsWith(' ')) {
      ok(!line.startsWith('  ') || ics === C_ICS, 'continuation carries exactly one fold space');
      ok(bytes(line.slice(1)) <= 74, 'continuation payload ≤ 74 octets');
    }
  }
}

// 3. no cut sequences: every line decodes strictly; unfold restores the text
const strict = new TextDecoder('utf-8', { fatal: true });
const party = serializeEvent(newEvent({ title: '🎉'.repeat(40), date: '2026-01-01', allDay: true }), OPTS);
for (const line of physicalLines(party)) {
  ok(strict.decode(enc.encode(line)) === line, 'line is valid UTF-8');
  ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line), 'no lone surrogate');
}
ok(unfold(party).includes('\r\nSUMMARY:' + '🎉'.repeat(40) + '\r\n'), 'unfolded SUMMARY is exact');
for (const ev of stress) {
  const text = unfold(serializeEvent(ev, OPTS));
  ok(text.includes('SUMMARY:' + escapeText(ev.title)), 'stress SUMMARY survives fold/unfold');
}

// 4. foldLine edges
const l75 = 'SUMMARY:' + 'a'.repeat(67);
eq(bytes(l75), 75, 'edge line is 75 octets');
eq(foldLine(l75), l75, '75 octets stay unfolded');
eq(foldLine(l75 + 'b'), l75 + '\r\n b', '76 ASCII → 75 + fold + 1');
const umlauts = foldLine('SUMMARY:' + 'ä'.repeat(40));
const [first] = umlauts.split('\r\n ');
eq(bytes(first), 74, 'break falls on an even byte boundary (37 × ä)');
ok(!umlauts.includes('�'), 'no replacement characters');
ok(unfold(C_ICS).includes('Grundschule am Lindenplatz'), 'fixture C double space survives unfold');

// 5. escaping order (String.raw: in a JS literal '\;' is just ';')
eq(escapeText(';'), String.raw`\;`, 'semicolon escaped');
eq(escapeText(';').length, 2, 'escaped semicolon is two characters');
eq(escapeText(String.raw`a\;b`), String.raw`a\\\;b`, 'backslash first, then semicolon (three backslashes)');
eq(escapeText(String.raw`a\nb`), String.raw`a\\nb`, 'literal backslash-n stays a backslash and an n');
eq(escapeText('a\nb'), String.raw`a\nb`, 'real newline becomes backslash-n');
eq(escapeText('x\r\ny\rz'), String.raw`x\ny\nz`, 'CRLF and CR normalize');
eq(escapeText('a\u0000b\u0007c\u007f'), 'abc', 'control characters dropped');
eq(escapeText('a\tb'), 'a\tb', 'TAB stays');
eq(escapeText('a,b'), String.raw`a\,b`, 'comma escaped');

// 6. CRLF discipline
for (const ics of [A_ICS, B_ICS, C_ICS, ABC_ICS]) {
  ok(!/\r(?!\n)|(?<!\r)\n/.test(ics), 'no bare CR or LF');
  ok(ics.endsWith('END:VCALENDAR\r\n'), 'ends with END:VCALENDAR CRLF');
}

// 7. DTEND omitted when endTime is empty or equals DTSTART
const noEnd = serializeEvent(newEvent({ title: 't', date: '2026-10-02', startTime: '18:30' }), OPTS);
ok(!noEnd.includes('DTEND'), 'no DTEND without endTime');
const sameEnd = serializeEvent(newEvent({ title: 't', date: '2026-10-02', startTime: '18:30', endTime: '18:30' }), OPTS);
ok(!sameEnd.includes('DTEND'), 'no DTEND when equal to DTSTART');
ok(serializeEvent(A, OPTS).includes('DTEND:'), 'A has a DTEND');

// 8. all-day exclusive end across year and leap boundaries
ok(serializeEvent(newEvent({ title: 't', allDay: true, date: '2026-12-31' }), OPTS).includes('DTEND;VALUE=DATE:20270101'), 'Dec 31 → Jan 1');
ok(serializeEvent(newEvent({ title: 't', allDay: true, date: '2028-02-28' }), OPTS).includes('DTEND;VALUE=DATE:20280229'), 'leap day');
ok(serializeEvent(newEvent({ title: 't', allDay: true, date: '2026-10-03' }), OPTS).includes('DTSTART;VALUE=DATE:20261003\r\nDTEND;VALUE=DATE:20261004'), 'single all-day ends next day');

// 9. UTC conversion including DST edges
eq(formatUtcDateTime(zonedToUtc('2026-12-01', '18:30', 'Europe/Berlin')), '20261201T173000Z', 'Berlin winter');
eq(formatUtcDateTime(zonedToUtc('2026-03-29', '02:30', 'Europe/Berlin')), '20260329T013000Z', 'DST gap');
eq(formatUtcDateTime(zonedToUtc('2026-10-25', '02:30', 'Europe/Berlin')), '20261025T013000Z', 'DST overlap');
eq(formatUtcDateTime(zonedToUtc('2026-07-04', '09:00', 'America/New_York')), '20260704T130000Z', 'New York summer');
eq(formatUtcDateTime(zonedToUtc('2026-07-04', '09:00', 'UTC')), '20260704T090000Z', 'UTC identity');
eq(formatUtcDateTime(zonedToUtc('2026-01-01', '00:00', 'Pacific/Auckland')), '20251231T110000Z', 'date rolls back across midnight');

// 10. timed series are floating, also multi-day
const series = [C, newEvent({ title: 't', date: '2026-10-05', endDate: '2026-10-06', startTime: '20:00', endTime: '02:00',
  recurrence: { freq: 'weekly', interval: 1, byDay: ['MO'], count: 3, until: null } })];
for (const ev of series) {
  const ics = serializeEvent(ev, OPTS);
  ok(/^DTSTART:\d{8}T\d{6}\r$/m.test(ics), 'floating DTSTART');
  ok(!/^DTSTART:.*Z\r$/m.test(ics), 'no Z on a series');
}
ok(serializeEvent(series[1], OPTS).includes('DTEND:20261006T020000\r\n'), 'multi-day series DTEND on endDate');

// 11. formatRrule
const rec = (o) => ({ freq: 'none', interval: 1, byDay: [], count: null, until: null, ...o });
eq(formatRrule(rec({ freq: 'daily' }), { allDay: false }), 'FREQ=DAILY;INTERVAL=1', 'daily');
eq(formatRrule(rec({ freq: 'weekly', interval: 2, byDay: ['TU'], until: '2026-12-31' }), { allDay: false }),
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231T235959', 'weekly until timed');
eq(formatRrule(rec({ freq: 'monthly', until: '2027-06-30' }), { allDay: true }), 'FREQ=MONTHLY;INTERVAL=1;UNTIL=20270630', 'monthly until all-day');
eq(formatRrule(rec({ freq: 'yearly', count: 5 }), { allDay: false }), 'FREQ=YEARLY;INTERVAL=1;COUNT=5', 'yearly count');
eq(formatRrule(newEvent({ recurrence: rec({ freq: 'weekly', byDay: ['WE', 'MO'] }) }).recurrence, { allDay: false }),
  'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE', 'byDay sorted by normalize');
eq(formatRrule(rec({ freq: 'monthly', byDay: ['MO'] }), { allDay: false }), 'FREQ=MONTHLY;INTERVAL=1', 'byDay ignored outside weekly');
eq(formatRrule(rec({}), { allDay: false }), '', 'none → empty');
ok(!serializeEvent(A, OPTS).includes('RRULE'), 'no RRULE line without recurrence');

// 12. UID: deterministic, content-sensitive, independent of now
eq(uidFor(A, OPTS), uidFor(A, { ...OPTS, now: new Date('2030-01-01T00:00:00Z') }), 'UID ignores now');
ok(uidFor({ ...A, title: A.title + '!' }, OPTS) !== uidFor(A, OPTS), 'UID changes with the title');
ok(/^[0-9a-f]{16}@calqrii$/.test(uidFor(A, OPTS)), 'UID shape');
ok(serializeCalendar([A, B, C], OPTS).includes('UID:' + uidFor(A, OPTS)), 'same UID inside serializeCalendar');

// 13. two nows differ only in DTSTAMP
const later = serializeEvent(A, { ...OPTS, now: new Date('2026-09-28T08:15:30Z') });
const diff = A_ICS.split('\r\n').filter((l, i) => l !== later.split('\r\n')[i]);
eq(diff.length, 1, 'exactly one differing line');
ok(diff[0].startsWith('DTSTAMP:'), 'it is the DTSTAMP line');
ok(later.includes('DTSTAMP:20260928T081530Z'), 'new DTSTAMP value');

// 14. calendar wrapper once, bodies identical to the fixture inner parts
const abc = serializeCalendar([A, B, C], OPTS);
eq(abc, ABC_ICS, 'ABC fixture');
eq(bytes(abc), 963, 'ABC is 963 bytes');
eq((abc.match(/BEGIN:VCALENDAR/g) || []).length, 1, 'one BEGIN:VCALENDAR');
eq((abc.match(/END:VCALENDAR/g) || []).length, 1, 'one END:VCALENDAR');
eq((abc.match(/BEGIN:VEVENT/g) || []).length, 3, 'three VEVENTs');
for (const block of [A_VEVENT, B_VEVENT, C_VEVENT]) ok(abc.includes(block.join('\r\n')), 'VEVENT block present verbatim');
eq(veventLines(A, OPTS).length, A_VEVENT.length - 1, 'veventLines are the unfolded logical lines');
eq(contentLines(A, OPTS)[0], 'DTSTART:20261002T163000Z', 'contentLines start at DTSTART');

// 15. URL: raw, controls stripped, non-http dropped
const withUrl = serializeEvent(newEvent({ title: 't', date: '2026-01-01', allDay: true, url: 'https://ex.org/a,b;c' }), OPTS);
ok(withUrl.includes('URL:https://ex.org/a,b;c\r\n'), 'URL is not TEXT-escaped');
const js = serializeEvent(newEvent({ title: 't', date: '2026-01-01', allDay: true, url: 'javascript:alert(1)' }), OPTS);
ok(!js.includes('javascript'), 'javascript: URL never emitted');
const crlf = serializeEvent({ ...newEvent({ title: 't', date: '2026-01-01', allDay: true }), url: 'https://ex.org/a\r\nDESCRIPTION:x' }, OPTS);
ok(crlf.includes('URL:https://ex.org/aDESCRIPTION:x\r\n'), 'CR/LF stripped from URL, no line injection');

console.log(`ics.test: ${checks} checks passed`);
