// Share-link codec tests. Run: node test/fragment.test.mjs
import assert from 'node:assert/strict';
import { encodeFragment, decodeFragment, linkFor, bytesToB64url, b64urlToBytes, LINK_VERSION } from '../fragment.js';
import { newEvent } from '../model.js';
import { A, B, C, B_FRAGMENT, PAGES_BASE } from './helpers/fixtures.mjs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const TZ = 'Europe/Berlin';
const strip = (ev) => { const { id, ...rest } = ev; return rest; };
const b64 = (obj) => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
const link = (obj, extra = '') => `v=1&tz=Europe%2FBerlin&e=${b64(obj)}${extra}`;
const bad = (raw, m) => { const r = decodeFragment(raw); ok(r.status === 'error' && r.code === 'bad_link', `${m}: ${JSON.stringify(r)}`); };

// round trip
const emoji = newEvent({ title: '🎂 Geburtstag Oma 🎉', date: '2026-11-03', startTime: '15:00', endTime: '17:30',
  description: 'Kuchen\nKerzen\n\nGeschenke', location: 'Bei Oma', url: 'https://ex.org/?a=1&b=2',
  recurrence: { freq: 'yearly', interval: 1, byDay: [], count: null, until: '2030-12-31' } });
const events = [A, B, C, emoji];
const frag = encodeFragment({ events, tz: TZ });
ok(!frag.startsWith('#'), 'no leading #');
const back = decodeFragment(frag);
eq(back.status, 'ok', 'decodes');
eq(back.tz, TZ, 'tz preserved');
deq(back.events.map(strip), events.map(strip), 'round trip deep-equal without id');

// pinned fixture B
eq(encodeFragment({ events: [B], tz: TZ }), B_FRAGMENT, 'pinned fragment for B');
eq(decodeFragment(B_FRAGMENT).status, 'ok', 'pinned fragment decodes');
ok(!B_FRAGMENT.split('&e=')[1].includes('='), 'e value has no =');
eq(encodeFragment({ events: [], tz: TZ }), '', 'empty → empty string');
eq(LINK_VERSION, '1', 'link version');

// links: one event per code; the fragment survives the URL parser unchanged
for (const ev of events) {
  const u = new URL(linkFor(PAGES_BASE, [ev], TZ));
  eq(u.origin + u.pathname, PAGES_BASE, 'link keeps the page base');
  const one = decodeFragment(u.hash.slice(1));
  ok(one.status === 'ok' && one.events.length === 1 && one.tz === TZ, `single-event link decodes (${ev.title})`);
  deq(strip(one.events[0]), strip(ev), `single-event link round-trips ${ev.title}`);
}
eq(linkFor(PAGES_BASE, events, TZ), PAGES_BASE + '#' + frag, 'multi-event link is base + # + fragment');

// key order is part of the format
const wire = JSON.parse(new TextDecoder().decode(b64urlToBytes(new URLSearchParams(frag).get('e'))));
deq(Object.keys(wire[0]), ['t', 'd', 's', 'e', 'l', 'n'], 'A wire keys in order');
deq(Object.keys(wire[3]), ['t', 'd', 's', 'e', 'l', 'n', 'u', 'r'], 'emoji wire keys in order');
deq(wire[2].r, { f: 'w', b: 'MOWE', c: 10 }, 'series wire form');
deq(wire[3].r, { f: 'y', x: '2030-12-31' }, 'until wire form');
ok(!('D' in wire[0]) && !('a' in wire[0]), 'defaults omitted');

// refusals
deq(decodeFragment(''), { status: 'empty' }, 'empty string');
deq(decodeFragment('editor'), { status: 'empty' }, 'unrelated anchor');
eq(decodeFragment(B_FRAGMENT.replace('v=1', 'v=2')).code, 'bad_version', 'v=2 → bad_version');
bad(B_FRAGMENT.replace('v=1', 'v=1.0'), 'v=1.0');
bad(B_FRAGMENT.replace('v=1', 'v=abc'), 'v=abc');
bad(B_FRAGMENT.replace('v=1', 'v=01'), 'v=01');
bad(B_FRAGMENT.replace('v=1&', ''), 'e without v');
bad(link([{ t: 'x', d: '2026-01-01' }]) + '$', 'e with $');
bad('v=1&tz=UTC&e=abcde', 'length ≡ 1 mod 4');
bad('v=1&tz=UTC&e=_w', 'e=_w is 0xFF, not UTF-8');
{
  // valid JSON shape around one invalid UTF-8 byte: only a fatal decoder refuses it
  const enc = new TextEncoder();
  const raw = new Uint8Array([...enc.encode('[{"t":"'), 0xff, ...enc.encode('","d":"2026-01-01","a":1}]')]);
  bad('v=1&tz=UTC&e=' + bytesToB64url(raw), 'invalid UTF-8 inside a JSON string');
}
bad('v=1&tz=UTC&e=', 'empty e');
bad(link({ t: 'x', d: '2026-01-01' }), 'object instead of array');
bad(link([]), 'empty array');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, zz: 1 }]), 'unknown key on an otherwise valid event');
bad(link([{ t: 'x', d: '2026-01-01', a: true }]), 'a:true');
bad(link([{ t: 'x', d: '2026-01-01', a: 2, s: '09:00' }]), 'a:2 on an otherwise valid timed event');
bad(link([{ t: 5, d: '2026-01-01' }]), 't:5');
bad(link([{ t: '', d: '2026-01-01', a: 1 }]), 'empty title');
bad(link([{ t: 'x', d: '2026-01-02', D: '2026-01-01', a: 1 }]), 'endDate before date');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'q' } }]), 'unknown freq');
bad(link([{ t: 'x', d: '2026-01-01', s: '09:00', r: { f: 'toString', c: 5 } }]), 'inherited property name as freq');
bad(link([{ t: 'x', d: '2026-01-01', s: '09:00', r: { f: 'constructor' } }]), 'constructor as freq');
// raw JSON: in an object literal __proto__ would set the prototype, not a key
bad('v=1&tz=UTC&e=' + bytesToB64url(new TextEncoder().encode('[{"t":"x","d":"2026-01-01","a":1,"__proto__":{"x":1}}]')), '__proto__ key');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, hasOwnProperty: 'y' }]), 'inherited property name as key');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'w', b: 'MOXX' } }]), 'bad byDay');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'd', c: 2, x: '2027-01-01' } }]), 'count and until');
bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: [] }]), 'r as array');
bad(link([{ t: 'x', d: '2026-01-01' }]), 'timed without start time');
bad(link(Array.from({ length: 201 }, () => ({ t: 'x', d: '2026-01-01', a: 1 }))), '201 events');
eq(decodeFragment(link(Array.from({ length: 200 }, () => ({ t: 'x', d: '2026-01-01', a: 1 })))).status, 'ok', '200 events');
bad('v=1&tz=UTC&e=' + 'A'.repeat(100004), 'e > 100k');
bad(B_FRAGMENT.replace('Europe%2FBerlin', 'Mars%2FOlympus'), 'tz=Mars/Olympus');
bad(B_FRAGMENT.replace('tz=Europe%2FBerlin&', ''), 'tz missing');
bad(B_FRAGMENT + '&e=' + b64([{ t: 'y', d: '2026-01-01', a: 1 }]), 'two e');
const detail = decodeFragment(link([{ t: 'x', d: '2026-01-01', a: 1 }, { t: '', d: '2026-01-01', a: 1 }]));
eq(detail.detail, '#1:err_title_required', 'detail names the event and rule');

// size
const ten = encodeFragment({ events: Array.from({ length: 10 }, () => B), tz: TZ });
ok(ten.length < 1500, `10 events under 1500 chars (${ten.length})`);

// base64url helpers
deq([...b64urlToBytes(bytesToB64url(new Uint8Array([0, 255, 254, 253, 62, 63])))], [0, 255, 254, 253, 62, 63], 'byte round trip');
eq(bytesToB64url(new Uint8Array([251, 255])), '-_8', 'url-safe alphabet');
const big = new Uint8Array(70000).map((_, i) => i % 251);
deq(b64urlToBytes(bytesToB64url(big)), big, 'chunked encoding above 0x8000 bytes');

console.log(`fragment.test: ${checks} checks passed`);
