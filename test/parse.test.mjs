// Import parsers: iCalendar round trip through our own serializer, a foreign
// iCalendar file, and copied event lists. Run: node test/parse.test.mjs
import assert from 'node:assert/strict';
import { detectKind, parseIcs, parseText, parseInput, parseRrule, parseDuration, parseDateLine, unescapeText, MAX_INPUT_CHARS } from '../parse.js';
import { serializeCalendar } from '../ics.js';
import { newEvent } from '../model.js';
import { A, B, C, D, OPTS } from './helpers/fixtures.mjs';

let checks = 0;
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };
const TODAY = '2026-10-01';
const TZ = 'Europe/Berlin';
const strip = ({ id, ...ev }) => ev;

// --- detection
eq(detectKind(''), 'empty', 'empty');
eq(detectKind('  \n'), 'empty', 'whitespace is empty');
eq(detectKind('BEGIN:VCALENDAR\r\nVERSION:2.0'), 'ics', 'calendar stream');
eq(detectKind('Sa 05.10.2026 Grillfest'), 'text', 'plain text');
eq(detectKind('\n  begin:vevent\nDTSTART:20261005'), 'ics', 'leading blank line, indentation and lower case still read as a stream');

// --- round trip: what we write, we read back unchanged (UTC → Europe/Berlin, floating series, all-day exclusive end, GEO, URL)
{
  const items = parseIcs(serializeCalendar([A, B, C, D], OPTS), { tz: TZ });
  eq(items.length, 4, 'four events back');
  deq(items.map((i) => strip(i.ev)), [A, B, C, D].map(strip), 'round trip is exact');
  deq(items.flatMap((i) => i.warnings), [], 'no warnings on our own output');
}
// The same UTC file read in another zone shifts the wall clock, not the instant.
{
  const [a] = parseIcs(serializeCalendar([A], OPTS), { tz: 'America/New_York' });
  eq(a.ev.startTime, '12:30', 'UTC 16:30 is 12:30 in New York');
  eq(a.ev.endTime, '16:00', 'end converted too');
}

// --- a foreign file: TZID, VALUE=DATE, DURATION, folded and escaped text, VALARM, unsupported rule parts
const FOREIGN = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Some Club//Events 1.0//DE',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:1@club',
  'DTSTAMP:20260901T000000Z',
  'DTSTART;TZID=Europe/Berlin:20261005T190000',
  'DTEND;TZID=Europe/Berlin:20261005T213000',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'ACTION:DISPLAY',
  'END:VALARM',
  'SUMMARY:Mitgliederversammlung\\, Teil 1',
  'DESCRIPTION:Tagesordnung:\\n1. Bericht\\n2. Wahlen\\; Anträge bis Freitag. Dieser Te',
  ' xt ist über zwei Zeilen gefaltet.',
  'LOCATION:Vereinsheim\\, Raum 2',
  'GEO:50.73743;7.098207',
  'URL:https://club.example/mv',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:2@club',
  'DTSTART;VALUE=DATE:20261024',
  'DTEND;VALUE=DATE:20261026',
  'SUMMARY:Herbstfreizeit',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:3@club',
  'DTSTART:20261007T160000Z',
  'DURATION:PT1H30M',
  'SUMMARY:Training',
  'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=8;WKST=MO',
  'EXDATE:20261021T160000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:4@club',
  'DTSTART;TZID=Europe/Berlin:20261101T100000',
  'SUMMARY:Erster Sonntag',
  'RRULE:FREQ=MONTHLY;BYDAY=1SU',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:5@club',
  'DTSTART;TZID=America/Los_Angeles:20261110T180000',
  'DTEND;TZID=America/Los_Angeles:20261110T190000',
  'SUMMARY:Call',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:6@club',
  'DTSTART;TZID=Mars/Olympus:20261110T180000',
  'SUMMARY:Unknown zone',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:7@club',
  'DTSTART;TZID=America/Los_Angeles:20261110T180000',
  'SUMMARY:LA series',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:8@club',
  'DTSTART;TZID=Europe/Berlin:20261012T100000',
  'SUMMARY:Montagsrunde',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:8@club',
  'RECURRENCE-ID;TZID=Europe/Berlin:20261019T100000',
  'DTSTART;TZID=Europe/Berlin:20261020T100000',
  'SUMMARY:Montagsrunde (verschoben)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:9@club',
  'DTSTART;TZID=Europe/Berlin:20270328T013000',
  'DURATION:PT2H',
  'SUMMARY:Über die Zeitumstellung',
  'URL:webcal://club.example/feed',
  'DESCRIPTION:' + 'x'.repeat(8001),
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:10@club',
  'DTSTART:20261005T250000Z',
  'SUMMARY:Bad time',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:11@club',
  'DTSTART;VALUE=DATE:20261101',
  'DURATION:P3D',
  'SUMMARY:Drei Tage',
  'RDATE;VALUE=DATE:20261201',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:12@club',
  'DTSTART;TZID=Europe/Berlin:20261105T190000',
  'DTEND;TZID=Europe/Berlin:20261104T180000',
  'SUMMARY:Ende vor Anfang',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:13@club',
  'DTSTART;TZID=Europe/Berlin:20261005T070000',
  'SUMMARY:Daily for three years',
  'RRULE:FREQ=DAILY;COUNT=1095',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:14@club',
  'DTSTART;TZID=W. Europe Standard Time:20261105T190000',
  'SUMMARY:Outlook Berlin',
  'RRULE:FREQ=WEEKLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:15@club',
  'DTSTART;TZID=Pacific Standard Time:20261110T180000',
  'DTEND;TZID=Pacific Standard Time:20261110T190000',
  'SUMMARY:Outlook Pacific',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n') + '\r\n';
{
  const items = parseIcs(FOREIGN, { tz: TZ });
  eq(items.length, 16, 'sixteen events, the VALARM is not one');
  const [mv, frei, tr, first, call, mars, la, master, moved, dst, badTime, threeDays, endBefore, tooMany, winBerlin, winPacific] = items;
  deq(strip(mv.ev), strip(newEvent({
    title: 'Mitgliederversammlung, Teil 1', date: '2026-10-05', startTime: '19:00', endTime: '21:30',
    description: 'Tagesordnung:\n1. Bericht\n2. Wahlen; Anträge bis Friday. Dieser Text ist über zwei Zeilen gefaltet.'.replace('Friday', 'Freitag'),
    location: 'Vereinsheim, Raum 2', geo: '50.73743,7.098207', url: 'https://club.example/mv',
  })), 'TZID in the page zone, unescaped and unfolded text, GEO and URL');
  deq(mv.warnings, [], 'nothing to warn about');
  deq([frei.ev.allDay, frei.ev.date, frei.ev.endDate], [true, '2026-10-24', '2026-10-25'], 'all-day exclusive DTEND becomes the last day');
  deq([tr.ev.date, tr.ev.startTime, tr.ev.endTime], ['2026-10-07', '18:00', '19:30'], 'UTC start converted, DURATION applied');
  deq(tr.ev.recurrence, { freq: 'weekly', interval: 2, byDay: ['WE'], count: 8, until: null }, 'rule with WKST read');
  deq(tr.warnings, ['imp_warn_series_tz', 'imp_warn_exdate'], 'a UTC series is flagged (DST) and its EXDATE reported');
  eq(first.ev.recurrence.freq, 'none', 'ordinal BYDAY cannot be represented: rule dropped');
  deq(first.warnings, ['imp_warn_rule'], '… and reported');
  deq([call.ev.date, call.ev.startTime, call.ev.endTime], ['2026-11-11', '03:00', '04:00'], 'foreign TZID converted across midnight');
  deq([mars.ev.startTime, mars.warnings], ['18:00', ['imp_warn_tz']], 'unknown TZID: wall clock kept, warned');
  deq([la.ev.date, la.ev.startTime, la.ev.recurrence.freq, la.warnings], ['2026-11-11', '03:00', 'none', ['imp_warn_rule']], 'a weekly series whose start moves to another day in the page zone loses its rule (it would silently run on Wednesdays), with a note');
  deq([master.ev.recurrence.freq, master.warnings], ['weekly', ['imp_warn_exdate']], 'a master with a moved instance (RECURRENCE-ID) is flagged');
  deq([moved.ev.date, moved.ev.recurrence.freq, moved.warnings], ['2026-10-20', 'none', ['imp_warn_exdate']], 'the moved instance is a flagged single event');
  deq([dst.ev.startTime, dst.ev.endTime], ['01:30', '04:30'], 'DURATION is added to the instant: the DST gap counts');
  deq([dst.ev.url, [...dst.ev.description].length, dst.warnings], ['', 8000, ['imp_warn_fields']], 'webcal URL dropped and overlong description cut, reported once');
  deq([badTime.ev.date, badTime.warnings], ['', ['imp_warn_start']], 'an impossible time is no start');
  deq([threeDays.ev.allDay, threeDays.ev.endDate, threeDays.ev.recurrence.freq, threeDays.warnings], [true, '2026-11-03', 'yearly', ['imp_warn_exdate']], 'all-day DURATION P3D ends two days later; RDATE alone is reported');
  deq([endBefore.ev.endDate, endBefore.ev.endTime], ['2026-11-05', '18:00'], 'DTEND before DTSTART: the date is clamped (the time error is for validation)');
  deq([tooMany.ev.recurrence.freq, tooMany.warnings], ['none', ['imp_warn_rule_range']], 'a series beyond the editor range is dropped with its own reason, not clamped');
  deq([winBerlin.ev.date, winBerlin.ev.startTime, winBerlin.warnings], ['2026-11-05', '19:00', []], 'a Windows zone name that maps to the page zone: time as written, no warning (also for a series: not a foreign zone)');
  deq([winPacific.ev.date, winPacific.ev.startTime, winPacific.ev.endTime, winPacific.warnings], ['2026-11-11', '03:00', '04:00', []], 'a Windows zone name is converted like its IANA zone');
}
{
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', 'DTSTART;TZID=UTC:20261005T190000', 'SUMMARY:x', 'RRULE:FREQ=WEEKLY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  deq(parseIcs(ics, { tz: 'UTC' })[0].warnings, [], 'a TZID equal to the page zone is not foreign, even when it is also a Windows key (UTC)');
}
{
  // Zones are compared by their offsets over the year, not by name.
  const series = (dtstart) => ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u', dtstart, 'SUMMARY:x', 'RRULE:FREQ=WEEKLY', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const notes = (dtstart, tz) => parseIcs(series(dtstart), { tz })[0].warnings;
  deq(notes('DTSTART;TZID=W. Europe Standard Time:20261105T190000', 'Europe/Vienna'), [], 'Berlin series, Vienna page: same offsets all year, no zone note');
  deq(notes('DTSTART;TZID=India Standard Time:20261105T190000', 'Asia/Kolkata'), [], 'CLDR legacy Asia/Calcutta is the page zone Asia/Kolkata');
  deq(notes('DTSTART:20261105T190000Z', 'Etc/UTC'), [], 'a UTC series on a UTC page is not foreign');
  deq(notes('DTSTART;TZID=W. Europe Standard Time:20261105T190000', 'Europe/London'), ['imp_warn_series_tz'], 'same DST dates, other offset: still foreign');
  deq(notes('DTSTART;TZID=Europe/Berlin:20261105T190000', 'Africa/Lagos'), ['imp_warn_series_tz'], 'same winter offset, no DST on the page: foreign');
  const running = (dtstart, rule, tz) => parseInput(series(dtstart).replace('RRULE:FREQ=WEEKLY', rule), { tz, today: TODAY }).items[0].warnings;
  deq(running('DTSTART;TZID=Europe/Istanbul:20080107T190000', 'RRULE:FREQ=WEEKLY', 'Europe/Athens'), ['imp_warn_series_tz'], 'a series from 2008 still running: Istanbul left Athens\' offsets in 2016, so it drifts today');
  deq(running('DTSTART;TZID=America/Denver:20211231T190000', 'RRULE:FREQ=WEEKLY;UNTIL=20221231', 'America/Ciudad_Juarez'), ['imp_warn_series_tz'], 'a series starting in late December is compared in the years it runs, not only its start year');
  deq(running('DTSTART;TZID=America/Denver:20201231T190000', 'RRULE:FREQ=WEEKLY;UNTIL=20211231', 'America/Ciudad_Juarez'), [], '… and one that ended before the zones split gets no note');
  deq(running('DTSTART;TZID=America/Denver:20211231T190000', 'RRULE:FREQ=WEEKLY;UNTIL=20400101', 'America/Ciudad_Juarez'), ['imp_warn_series_tz'], 'a far UNTIL does not push the window past the years that already ran');
  deq(running('DTSTART;TZID=Europe/Istanbul:20080108T190000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'Europe/Athens'), [], 'a COUNT series is compared in the weeks it ran, not up to today');
  deq(running('DTSTART;TZID=Europe/Berlin:20260105T190000', 'RRULE:FREQ=YEARLY;INTERVAL=9;COUNT=999', 'Europe/London'), ['imp_warn_series_tz'], 'an estimated end beyond year 9999 (five-digit year) still ends the window at next year');
}
{
  const single = (dtstart) => parseIcs(['BEGIN:VEVENT', 'UID:u', dtstart, 'SUMMARY:x', 'END:VEVENT'].join('\r\n'), { tz: TZ })[0];
  const plain = single('DTSTART;TZID=tzone://Microsoft/Utc:20261105T190000');
  deq([plain.ev.date, plain.ev.startTime, plain.warnings], ['2026-11-05', '20:00', []], 'Outlook\'s unquoted TZID=tzone://Microsoft/Utc: the value is after the last colon, the zone is UTC');
  const quoted = single('DTSTART;TZID="tzone://Microsoft/Utc":20261105T190000');
  deq([quoted.ev.startTime, quoted.warnings], ['20:00', []], '… and quoted');
}
eq(unescapeText(String.raw`a\\b\;c\,d\ne\Nf`), 'a\\b;c,d\ne\nf', 'unescape all five');

// --- rules and durations in isolation
deq(parseRrule('FREQ=WEEKLY', '2026-10-05'), { freq: 'weekly', interval: 1, byDay: ['MO'], count: null, until: null }, 'weekly without BYDAY: the start weekday');
deq(parseRrule('FREQ=DAILY;UNTIL=20261231T225959Z', '2026-10-05', TZ), { freq: 'daily', interval: 1, byDay: [], count: null, until: '2026-12-31' }, 'UNTIL keeps its date');
eq(parseRrule('FREQ=DAILY;UNTIL=20261230T233000Z', '2026-12-01', TZ).until, '2026-12-31', 'a UTC UNTIL is read in the page zone: 23:30Z is already Dec 31 in Berlin');
eq(parseRrule('FREQ=DAILY;UNTIL=20261230', '2026-12-01', TZ).until, '2026-12-30', 'a date UNTIL stays');
eq(parseRrule('FREQ=DAILY;UNTIL=garbage', '2026-12-01', TZ), null, 'malformed UNTIL refuses the rule instead of making it endless');
eq(parseRrule('FREQ=DAILY;INTERVAL=0', '2026-10-05'), null, 'INTERVAL 0 refused');
eq(parseRrule('FREQ=DAILY;INTERVAL=100', '2026-10-05'), 'range', 'INTERVAL above the editor range: refused as range');
eq(parseRrule('FREQ=DAILY;COUNT=0', '2026-10-05'), null, 'COUNT 0 refused');
eq(parseRrule('FREQ=DAILY;COUNT=1000', '2026-10-05'), 'range', 'COUNT above the editor range: refused as range');
eq(parseRrule('FREQ=DAILY;COUNT=999', '2026-10-05').count, 999, 'COUNT at the editor limit is kept');
eq(parseRrule('FREQ=DAILY;COUNT=3;UNTIL=20261231', '2026-10-05'), null, 'COUNT and UNTIL together (RFC 5545 forbids it) is refused, not read as COUNT');
eq(parseRrule('FREQ=DAILY;COUNT=0x10', '2026-10-05'), null, 'COUNT in hex is no number');
eq(parseRrule('FREQ=DAILY;INTERVAL=1e3', '2026-10-05'), null, 'INTERVAL in exponent form is no number, not a range');
eq(parseRrule('FREQ=DAILY;INTERVAL=99', '2026-10-05').interval, 99, 'INTERVAL at the editor limit is kept');
eq(parseRrule('FREQ=WEEKLY;INTERVAL=100;BYDAY=1MO', '2026-10-05'), null, 'a range overrun next to an unsupported part is plainly unsupported');
eq(parseRrule('FREQ=WEEKLY;BYDAY=TU', '2026-10-05'), null, 'BYDAY without the start weekday is refused');
eq(parseRrule('FREQ=WEEKLY;BYDAY=1MO', '2026-10-05'), null, 'ordinal BYDAY is refused even in a weekly rule');
eq(parseRrule('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-05'), null, 'BYMONTHDAY unsupported');
eq(parseRrule('FREQ=HOURLY', '2026-10-05'), null, 'HOURLY unsupported');
eq(parseDuration('P1DT2H'), 1560, 'P1DT2H');
eq(parseDuration('PT45M'), 45, 'PT45M');
eq(parseDuration('P2W'), 20160, 'weeks');
eq(parseDuration('-PT1H'), null, 'negative unsupported');

// --- date lines
{
  const l = (s) => parseDateLine(s, TODAY);
  deq(l('Sa, 05.10.2026 19:00 Uhr Grillfest am Vereinsheim'), {
    date: '2026-10-05', endDate: '2026-10-05', startTime: '19:00', endTime: '', allDay: false, title: 'Grillfest Vereinsheim', warnings: new Set(),
  }, 'numeric date, time with Uhr, weekday and glue removed');
  eq(l('12. Oktober 2026, 18.30 – 21 Uhr: Vortrag').startTime, '18:30', 'dotted time before Uhr');
  eq(l('12. Oktober 2026, 18.30 – 21 Uhr: Vortrag').endTime, '21:00', 'whole-hour end');
  eq(l('12. Oktober 2026, 18.30 – 21 Uhr: Vortrag').title, 'Vortrag', 'title after the colon');
  deq([l('17.–18.10.2026 Hüttenwochenende').date, l('17.–18.10.2026 Hüttenwochenende').endDate], ['2026-10-17', '2026-10-18'], 'day range before the month');
  deq([l('17. – 19. Oktober 2026 Freizeit').date, l('17. – 19. Oktober 2026 Freizeit').endDate], ['2026-10-17', '2026-10-19'], 'day range with month name');
  deq([l('vom 28.12.2026 bis 02.01.2027 Ferien').date, l('vom 28.12.2026 bis 02.01.2027 Ferien').endDate], ['2026-12-28', '2027-01-02'], 'two full dates');
  eq(l('2026-11-03 Treffen').date, '2026-11-03', 'ISO date');
  eq(l('October 3, 2026 7pm Party').date, '2026-10-03', 'English month first');
  eq(l('Nov 7 Match').date, '2026-11-07', 'English month, no year: this year');
  const noYear = l('15.3. Frühjahrsputz');
  eq(noYear.date, '2027-03-15', 'past date without year rolls to next year');
  ok(noYear.warnings.has('imp_warn_year'), 'guessed year is reported');
  eq(l('Am 20.11. ab 19 Uhr Stammtisch').date, '2026-11-20', 'near-future date without year stays this year');
  eq(l('Am 20.11. ab 19 Uhr Stammtisch').startTime, '19:00', 'bare hour with Uhr');
  eq(l('Preis: 12.50 Euro für alle'), null, 'a price is not a date');
  deq([l('Sa 05.10.2026 Flohmarkt, Standgebühr 12.50 Euro').startTime, l('Sa 05.10.2026 Flohmarkt, Standgebühr 12.50 Euro').allDay], ['', true], 'a dotted number without "Uhr" on the line is no time');
  eq(l('Kein Datum hier, nur 20:00 Uhr'), null, 'a time alone is no event');
  eq(l('Fr 23.10.2026 20:15 Uhr, Halle 3').title, 'Halle 3', 'title after a trailing comma');
  eq(l('31.02.2026 Unmöglich'), null, 'invalid calendar date is refused');
  eq(l('Ort: Marktplatz 5'), null, 'a street name starting like a month is no date');
  eq(l('Treffpunkt Junkerweg 4'), null, 'nor "Jun" inside a word');
  eq(l('3. Marathon der Stadt'), null, 'nor "D. Mar…" inside a word');
  eq(l('12. März 2026 Lauf').date, '2026-03-12', 'the full month name still reads');
  eq(l('12. Mär. 2026 Lauf').date, '2026-03-12', 'the abbreviated month with a dot still reads');
  deq([l('Sa 05.10.2026 – Grillfest (Ausweichtermin 12.10.2026)').endDate, l('Sa 05.10.2026 – Grillfest (Ausweichtermin 12.10.2026)').title], ['2026-10-05', 'Grillfest (Ausweichtermin 12.10.2026)'], 'a dash followed by words is no date range');
  deq([l('05.10.2026 18:00 – Konzert, Ende ca. 22:00').endTime, l('05.10.2026 18:00 – Konzert, Ende ca. 22:00').title], ['', 'Konzert, Ende ca. 22:00'], 'a dash followed by words is no time range either');
  eq(l('01.09. Herbstputz').date, '2026-09-01', 'a date 30 days back without a year stays in this year');
  eq(l('15.7. Sommerfest').date, '2027-07-15', 'a date 78 days back without a year is next year');
  eq(l('Oct 3 12am Party').startTime, '00:00', '12am is midnight');
  eq(l('Oct 3 12pm Lunch').startTime, '12:00', '12pm is noon');
  eq(l('05.10.2026 Wanderung, Dauer 3 h').startTime, '', 'a bare "h" is no time unit');
  deq([l('20.–18.10.2026 Rückwärts').date, l('20.–18.10.2026 Rückwärts').endDate], ['2026-10-18', '2026-10-18'], 'a day range running backwards is ignored');
  deq([parseDateLine('28.12. – 02.01.2027 Ferien', '2027-03-01').date, parseDateLine('28.12. – 02.01.2027 Ferien', '2027-03-01').endDate], ['2026-12-28', '2027-01-02'], 'a span over New Year takes the end year minus one for the start');
  const t0 = performance.now();
  const long = parseText('05.10.2026 Lang ' + ' -'.repeat(30000) + ' Ende', { today: TODAY });
  ok(long.length === 1 && long[0].ev.title.length <= 2000 && performance.now() - t0 < 500, 'a line with 60 000 punctuation characters mid-line is cut (the trim regex is quadratic: 2.5 s at 40 000 uncut)');
}

// --- copied lists: title on the date line, or on the line after, or on the line before
{
  const after = [
    'Termine',
    'Sa, 05.10.2026, 19:00 Uhr',
    'Grillfest',
    'Ort: Vereinsheim',
    'Bitte Salate mitbringen.',
    '17.–18.10.2026',
    'Hüttenwochenende',
    '',
    'Mi 21.10.2026 18:30–20:00 Vorstandssitzung',
  ].join('\n');
  const items = parseText(after, { today: TODAY });
  eq(items.length, 3, 'three events');
  deq(strip(items[0].ev), strip(newEvent({ title: 'Grillfest', date: '2026-10-05', startTime: '19:00', location: 'Vereinsheim', description: 'Bitte Salate mitbringen.' })), 'title, location and description from the following lines');
  deq(strip(items[1].ev), strip(newEvent({ title: 'Hüttenwochenende', allDay: true, date: '2026-10-17', endDate: '2026-10-18' })), 'all-day span');
  deq(strip(items[2].ev), strip(newEvent({ title: 'Vorstandssitzung', date: '2026-10-21', startTime: '18:30', endTime: '20:00' })), 'inline title with time range');
}
{
  const before = ['Grillfest', '05.10.2026 19:00', 'Hüttenwochenende', '17.10.2026 – 18.10.2026', 'Vorstandssitzung', '21.10.2026 18:30'].join('\n');
  const items = parseText(before, { today: TODAY });
  deq(items.map((i) => i.ev.title), ['Grillfest', 'Hüttenwochenende', 'Vorstandssitzung'], 'title-before layout detected');
  deq(items.map((i) => i.ev.description), ['', '', ''], 'the next title is not this description');
}
deq(parseText('Nur Text ohne ein Datum.\nNoch eine Zeile.', { today: TODAY }), [], 'no date, no events');
{
  const items = parseText(['05.10.2026 Grillfest', 'Ort: Marktplatz 5', 'Mit Musik.'].join('\n'), { today: TODAY });
  deq([items.length, items[0].ev.location, items[0].ev.description], [1, 'Marktplatz 5', 'Mit Musik.'], '"Ort: Marktplatz 5" is the location, not a phantom event');
}

// --- parseInput: ids, errors, past
{
  const { kind, items } = parseInput('01.09.2026 Vergangen\n15.10.2026 Kommt noch\n16.10.2026', { tz: TZ, today: TODAY });
  eq(kind, 'text', 'kind');
  deq(items.map((i) => i.ev.id), [1, 2, 3], 'sequential ids');
  deq(items.map((i) => i.past), [true, false, false], 'past flag');
  deq(items[2].errors, ['err_title_required'], 'a date without any title is an error, not an event');
  eq(parseInput('', { tz: TZ, today: TODAY }).kind, 'empty', 'empty input');
  const ics = parseInput(serializeCalendar([C], OPTS), { tz: TZ, today: '2027-01-01' });
  eq(ics.kind, 'ics', 'ics detected');
  eq(ics.items[0].past, false, 'a series without an end is never past');
  eq(ics.truncated, false, 'not truncated');
  const ended = parseInput('BEGIN:VEVENT\nDTSTART;VALUE=DATE:20200101\nSUMMARY:Alt\nRRULE:FREQ=YEARLY;UNTIL=20210101\nEND:VEVENT', { tz: TZ, today: TODAY });
  eq(ended.items[0].past, true, 'a series that ended before today is past');
  const big = parseInput('A'.repeat(MAX_INPUT_CHARS) + '\n05.10.2026 Hidden', { tz: TZ, today: TODAY });
  deq([big.truncated, big.items.length], [true, 0], 'input beyond the cap is cut and reported');
}

console.log(`parse.test.mjs: ${checks} checks passed`);
