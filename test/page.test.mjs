// Static markup against the model: option lists in index.html must mirror the
// constants they stand for. Run: node test/page.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DURATIONS, DEFAULT_DURATION } from '../model.js';

let checks = 0;
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

/** Inner source of `<select id="…">`; the id must be the element's first attribute. */
function selectById(id) {
  const m = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(m, `select #${id} present`);
  return m[1];
}
const options = (src) => [...src.matchAll(/<option\b([^>]*)>/g)].map((m) => m[1]);
const attr = (opt, name) => { const m = opt.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };

// duration select
const dur = options(selectById('f-duration'));
deq(dur.map((o) => attr(o, 'value')), [...DURATIONS.map(String), 'custom'], 'duration options mirror DURATIONS plus custom');
deq(dur.filter((o) => /\bselected\b/.test(o)).map((o) => attr(o, 'value')), [String(DEFAULT_DURATION)], 'the default duration is preselected');
deq(dur.map((o) => attr(o, 'data-dur')).filter((v) => v !== null), DURATIONS.map(String), 'every preset carries data-dur for relabelling');

console.log(`page.test: ${checks} checks passed`);
