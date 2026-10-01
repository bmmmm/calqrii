// Month grid math. Run: node test/calendar.test.mjs
import assert from 'node:assert/strict';
import { monthGrid } from '../calendar.js';
import { weekdayOf } from '../model.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };

eq(monthGrid(2026, 10)[0][0].date, '2026-09-28', 'October 2026 starts on Mon Sep 28');
eq(monthGrid(2026, 2)[0][0].date, '2026-01-26', 'February 2026 starts on Mon Jan 26');
eq(monthGrid(2026, 6)[0][0].date, '2026-06-01', 'June 2026 starts on a Monday itself');
for (let m = 1; m <= 12; m++) {
  for (const y of [2024, 2026, 2028, 2100]) {
    const g = monthGrid(y, m);
    eq(g.length * g[0].length, 42, `${y}-${m}: 42 cells`);
    ok(g.every((row) => row.length === 7), `${y}-${m}: rows of 7`);
    ok(g.every((row) => weekdayOf(row[0].date) === 'MO'), `${y}-${m}: column 0 is Monday`);
    const inMonth = g.flat().filter((c) => c.inMonth).length;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    eq(inMonth, days, `${y}-${m}: ${days} in-month cells`);
    ok(g.flat().every((c, i, a) => i === 0 || a[i - 1].date < c.date), `${y}-${m}: strictly increasing`);
  }
}
eq(monthGrid(2028, 2).flat().filter((c) => c.inMonth).length, 29, 'Feb 2028 has 29 in-month cells');
eq(monthGrid(2026, 10, 0)[0][0].date, '2026-09-27', 'weekStart 0 = Sunday');

{
  const g = monthGrid(202, 10);
  ok(g.flat().every((c) => /^0\d{3}-\d{2}-\d{2}$/.test(c.date)), 'a year below 1000 keeps four digits (typing a year passes through 0202)');
}

console.log(`calendar.test: ${checks} checks passed`);
