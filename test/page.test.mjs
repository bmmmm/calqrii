// Static markup against the model: option lists in index.html must mirror the
// constants they stand for. Run: node test/page.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DURATIONS, DEFAULT_DURATION, FREQS, ERROR_FIELDS } from '../model.js';

let checks = 0;
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

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

// repeat selects
deq(options(selectById('f-freq')).map((o) => attr(o, 'value')), [...FREQS, 'custom'], 'repeat options are FREQS plus custom');
deq(options(selectById('f-cfreq')).map((o) => attr(o, 'value')), FREQS.filter((f) => f !== 'none'), 'custom frequencies are FREQS without none');

// field errors: every field ERROR_FIELDS names is a data-field control whose aria-describedby points at one existing, hidden .field-error slot
const controls = [...html.matchAll(/<(input|textarea|fieldset)\b([^>]*\bdata-field="([^"]+)"[^>]*)>/g)].map((m) => ({ attrs: m[2], field: m[3] }));
deq([...new Set(controls.map((c) => c.field))].sort(), [...new Set(Object.values(ERROR_FIELDS).flat())].sort(), 'data-field controls are exactly the fields ERROR_FIELDS names');
const slots = new Set([...html.matchAll(/<p class="field-error" id="(err-[a-z]+)" hidden><\/p>/g)].map((m) => m[1]));
ok(slots.size >= 10, `field-error slots present (${slots.size})`);
for (const c of controls) {
  const tokens = (attr(c.attrs, 'aria-describedby') || '').split(/\s+/).filter((x) => x.startsWith('err-'));
  ok(tokens.length === 1 && slots.has(tokens[0]), `${c.field} names one existing error slot (${tokens})`);
}
ok(/id="f-geo"[^>]*aria-describedby="err-geo f-geo-hint"/.test(html), 'the geo field keeps its hint after the error slot');
ok(/<p id="payload-meter" class="note" hidden><\/p>\s*<p id="form-error"/.test(html), 'the payload meter sits right before the form error');

// navigation: "New event" buttons in both screens; "Start page" is a plain relative link (no script touches the address bar)
ok(/<button type="button" id="view-new" data-i18n="new_event">/.test(html) && /<button type="button" id="new-event" data-i18n="new_event" hidden>/.test(html), 'a New event button in the view and under the list');
deq([...html.matchAll(/<a id="(view-home|home-link)" class="button" href="([^"]*)"/g)].map((m) => [m[1], m[2]]), [['view-home', './'], ['home-link', './']], 'both Start page links point at the page itself');

console.log(`page.test: ${checks} checks passed`);
