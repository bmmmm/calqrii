// The three pinned events and their exact serializations. These strings are
// the specification: an implementation that differs is wrong until the
// cause (property order, escaping, folding) is understood.
import { newEvent } from '../../model.js';

export const OPTS = { now: new Date('2026-09-27T12:00:00Z'), tz: 'Europe/Berlin' };

export const A = newEvent({
  title: 'Grillfest bei Jörg, Müller & Söhne',
  date: '2026-10-02',
  startTime: '18:30',
  endTime: '22:00',
  location: 'Biergarten Süd; Tisch 4',
  description: 'Bitte Salate mitbringen.\nJörg übernimmt die Würstchen, Anna das Gemüse; Getränke gibt es vor Ort.',
});

export const B = newEvent({
  title: 'Hüttenwochenende',
  allDay: true,
  date: '2026-10-17',
  endDate: '2026-10-18',
  location: 'Berghütte am Brunnstein',
});

export const C = newEvent({
  title: 'Yoga im Park',
  date: '2026-10-05',
  startTime: '07:00',
  endTime: '08:00',
  location: 'Stadtpark, Wiese am Teich',
  description: 'Matte mitbringen. Bei Regen in der Turnhalle der Grundschule am Lindenplatz, Eingang Nord.',
  recurrence: { freq: 'weekly', interval: 1, byDay: ['MO', 'WE'], count: 10, until: null },
});

const ics = (lines) => lines.join('\r\n') + '\r\n';
const HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//calqrii//calqrii//EN'];

export const A_VEVENT = [
  'BEGIN:VEVENT',
  'UID:6db194cd5c7bbcc9@calqrii',
  'DTSTAMP:20260927T120000Z',
  'DTSTART:20261002T163000Z',
  'DTEND:20261002T200000Z',
  String.raw`SUMMARY:Grillfest bei Jörg\, Müller & Söhne`,
  String.raw`DESCRIPTION:Bitte Salate mitbringen.\nJörg übernimmt die Würstchen\, Ann`,
  String.raw` a das Gemüse\; Getränke gibt es vor Ort.`,
  String.raw`LOCATION:Biergarten Süd\; Tisch 4`,
  'END:VEVENT',
];
export const B_VEVENT = [
  'BEGIN:VEVENT',
  'UID:5c4978a00ff66a4f@calqrii',
  'DTSTAMP:20260927T120000Z',
  'DTSTART;VALUE=DATE:20261017',
  'DTEND;VALUE=DATE:20261019',
  'SUMMARY:Hüttenwochenende',
  'LOCATION:Berghütte am Brunnstein',
  'END:VEVENT',
];
export const C_VEVENT = [
  'BEGIN:VEVENT',
  'UID:fb1bf38ddbe27857@calqrii',
  'DTSTAMP:20260927T120000Z',
  'DTSTART:20261005T070000',
  'DTEND:20261005T080000',
  'SUMMARY:Yoga im Park',
  'DESCRIPTION:Matte mitbringen. Bei Regen in der Turnhalle der Grundschule am',
  String.raw`  Lindenplatz\, Eingang Nord.`,
  String.raw`LOCATION:Stadtpark\, Wiese am Teich`,
  'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=10',
  'END:VEVENT',
];

export const A_ICS = ics([...HEAD, ...A_VEVENT, 'END:VCALENDAR']);
export const B_ICS = ics([...HEAD, ...B_VEVENT, 'END:VCALENDAR']);
export const C_ICS = ics([...HEAD, ...C_VEVENT, 'END:VCALENDAR']);
export const ABC_ICS = ics([...HEAD, ...A_VEVENT, ...B_VEVENT, ...C_VEVENT, 'END:VCALENDAR']);

export const B_FRAGMENT = 'v=1&tz=Europe%2FBerlin&e=W3sidCI6IkjDvHR0ZW53b2NoZW5lbmRlIiwiZCI6IjIwMjYtMTAtMTciLCJEIjoiMjAyNi0xMC0xOCIsImEiOjEsImwiOiJCZXJnaMO8dHRlIGFtIEJydW5uc3RlaW4ifV0';
