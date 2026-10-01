// The generated Windows → IANA table: every target is a zone this runtime knows
// (what a browser needs to convert with it), the file is shaped like the generator
// writes it (sorted, no duplicate key hiding behind a later one). Run: node test/tzmap.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WINDOWS_TZ } from '../tzmap.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

const keys = Object.keys(WINDOWS_TZ);
ok(keys.length >= 130, `at least 130 Windows zones (got ${keys.length})`);
ok(Object.isFrozen(WINDOWS_TZ), 'the table is frozen');
assert.deepEqual(keys, [...keys].sort(), 'keys are sorted, as the generator writes them'); checks++;

const source = readFileSync(new URL('../tzmap.js', import.meta.url), 'utf8');
const written = [...source.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]);
assert.equal(written.length, keys.length, 'no key is written twice (a later one would hide the first)'); checks++;

for (const [win, iana] of Object.entries(WINDOWS_TZ)) {
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: iana }), `${win} → ${iana} is a zone this runtime knows`); checks++;
}
assert.equal(WINDOWS_TZ['W. Europe Standard Time'], 'Europe/Berlin', 'the Outlook default for central Europe'); checks++;

console.log(`tzmap.test.mjs: ${checks} checks passed`);
