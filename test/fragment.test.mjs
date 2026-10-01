// Share-link codec tests. Run: node test/fragment.test.mjs
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { encodeFragment, decodeFragment, linkFor, bytesToB64url, b64urlToBytes, LINK_VERSION, MAX_E_LENGTH, MAX_INFLATED_BYTES } from '../fragment.js';
import { newEvent, LIMITS } from '../model.js';
import { A, B, C, D, B_FRAGMENT, B_FRAGMENT_V2, D_FRAGMENT, PAGES_BASE } from './helpers/fixtures.mjs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const TZ = 'Europe/Berlin';
const strip = (ev) => { const { id, ...rest } = ev; return rest; };
const b64 = (obj) => bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
// Hand-built links use version 1 (uncompressed JSON): everything after inflation is the same parser, and the wire bytes stay readable here.
const link = (obj, extra = '') => `v=1&tz=Europe%2FBerlin&e=${b64(obj)}${extra}`;
const link2 = (obj) => `v=2&tz=Europe%2FBerlin&e=${bytesToB64url(deflateRawSync(JSON.stringify(obj)))}`;
const bad = async (raw, m, detail = null) => {
  const r = await decodeFragment(raw);
  ok(r.status === 'error' && r.code === 'bad_link' && (detail === null || r.detail === detail), `${m}: ${JSON.stringify(r)}`);
};

// round trip
const emoji = newEvent({ title: '🎂 Geburtstag Oma 🎉', date: '2026-11-03', startTime: '15:00', endTime: '17:30',
  description: 'Kuchen\nKerzen\n\nGeschenke', location: 'Bei Oma', url: 'https://ex.org/?a=1&b=2',
  recurrence: { freq: 'yearly', interval: 1, byDay: [], count: null, until: '2030-12-31' } });
const events = [A, B, C, emoji, D];
const frag = await encodeFragment({ events, tz: TZ });
ok(!frag.startsWith('#'), 'no leading #');
ok(frag.startsWith('v=2&tz=Europe%2FBerlin&e='), 'version 2, zone, payload');
const back = await decodeFragment(frag);
eq(back.status, 'ok', 'decodes');
eq(back.tz, TZ, 'tz preserved');
deq(back.events.map(strip), events.map(strip), 'round trip deep-equal without id');

// pinned fixtures: version 1 is read, version 2 is read and written
{
  const v1 = await decodeFragment(B_FRAGMENT);
  ok(v1.status === 'ok' && v1.tz === TZ, 'pinned v1 fragment for B decodes');
  deq(strip(v1.events[0]), strip(B), 'pinned v1 fragment for B yields B');
  const v2 = await decodeFragment(B_FRAGMENT_V2);
  ok(v2.status === 'ok' && v2.tz === TZ, 'pinned v2 fragment for B decodes');
  deq(strip(v2.events[0]), strip(B), 'pinned v2 fragment for B yields B');
  const mine = await encodeFragment({ events: [B], tz: TZ });
  deq(strip((await decodeFragment(mine)).events[0]), strip(B), 'freshly encoded B round-trips');
  ok(mine.length < B_FRAGMENT.length, `v2 is shorter than v1 for B (${mine.length} < ${B_FRAGMENT.length})`);
  ok(!mine.split('&e=')[1].includes('='), 'e value has no =');
  const big = await encodeFragment({ events: [A, C, emoji], tz: TZ });
  ok(big.length < new URLSearchParams(link([A, C, emoji].map((ev) => JSON.parse(JSON.stringify(ev))))).toString().length, 'compression pays off on text-heavy events');
}
eq(await encodeFragment({ events: [], tz: TZ }), '', 'empty → empty string');
eq(LINK_VERSION, '2', 'link version');

// links: one event per code; the fragment survives the URL parser unchanged
for (const ev of events) {
  const u = new URL(await linkFor(PAGES_BASE, [ev], TZ));
  eq(u.origin + u.pathname, PAGES_BASE, 'link keeps the page base');
  const one = await decodeFragment(u.hash.slice(1));
  ok(one.status === 'ok' && one.events.length === 1 && one.tz === TZ, `single-event link decodes (${ev.title})`);
  deq(strip(one.events[0]), strip(ev), `single-event link round-trips ${ev.title}`);
}
eq(await linkFor(PAGES_BASE, events, TZ), PAGES_BASE + '#' + frag, 'multi-event link is base + # + fragment');

// key order is part of the format
const wire = JSON.parse(inflateRawSync(b64urlToBytes(new URLSearchParams(frag).get('e'))).toString('utf8'));
deq(Object.keys(wire[0]), ['t', 'd', 's', 'e', 'l', 'n'], 'A wire keys in order');
deq(Object.keys(wire[3]), ['t', 'd', 's', 'e', 'l', 'n', 'u', 'r'], 'emoji wire keys in order');
deq(wire[2].r, { f: 'w', b: 'MOWE', c: 10 }, 'series wire form');
deq(wire[3].r, { f: 'y', x: '2030-12-31' }, 'until wire form');
ok(!('D' in wire[0]) && !('a' in wire[0]), 'defaults omitted');
deq(Object.keys(wire[4]), ['t', 'd', 's', 'e', 'l', 'g', 'u'], 'D wire keys in order: g after l');
deq(strip((await decodeFragment(D_FRAGMENT)).events[0]), strip(D), 'pinned v1 fragment for D yields D (GEO on the wire)');
ok(!('g' in wire[0]), 'no g without a position');
{
  const pos = await decodeFragment(link([{ t: 'x', d: '2026-01-01', a: 1, g: '48.137154,11.576124' }]));
  eq(pos.status === 'ok' && pos.events[0].geo, '48.137154,11.576124', 'canonical g decodes');
}
// g must be canonical on the wire: these would all pass after normalization, so fromWire refuses them first
for (const g of ['48.1370,11.576', '48.137, 11.576', 'geo:48.137,11.576', '48.1371544,11.576',
  'https://www.openstreetmap.org/?mlat=48.137&mlon=11.576', '-0,11.5', '91,0', '48.137;11.576', '']) {
  const r = await decodeFragment(link([{ t: 'x', d: '2026-01-01', a: 1, g }]));
  ok(r.status === 'error' && r.detail === '#0:g', `non-canonical g refused: ${JSON.stringify(g)} → ${JSON.stringify(r)}`);
}
for (const g of [48.137, null, ['48.1', '11.5']]) {
  const r = await decodeFragment(link([{ t: 'x', d: '2026-01-01', a: 1, g }]));
  ok(r.status === 'error' && r.detail === '#0:type', `g of the wrong type refused: ${JSON.stringify(g)}`);
}

// refusals
deq(await decodeFragment(''), { status: 'empty' }, 'empty string');
deq(await decodeFragment('editor'), { status: 'empty' }, 'unrelated anchor');
eq((await decodeFragment(B_FRAGMENT.replace('v=1', 'v=3'))).code, 'bad_version', 'v=3 → bad_version');
await bad(B_FRAGMENT.replace('v=1', 'v=2'), 'v=2 with uncompressed payload', 'inflate');
await bad(B_FRAGMENT_V2.replace('v=2', 'v=1'), 'v=1 with compressed payload', 'json');
{
  // the inflate cap: a few kilobytes that would unpack to twice the cap are refused unread, as 'inflate', not after parsing
  const bomb = 'v=2&tz=UTC&e=' + bytesToB64url(deflateRawSync(Buffer.alloc(2 * MAX_INFLATED_BYTES, 0x20)));
  ok(bomb.length < 20000, `bomb is small on the wire (${bomb.length})`);
  await bad(bomb, 'inflates beyond MAX_INFLATED_BYTES', 'inflate');
  const under = 'v=2&tz=UTC&e=' + bytesToB64url(deflateRawSync('[' + ' '.repeat(MAX_INFLATED_BYTES - 40) + '{"t":"x","d":"2026-01-01","a":1}]'));
  eq((await decodeFragment(under)).status, 'ok', 'just under the cap still decodes');
  eq((await decodeFragment(link2([{ t: 'x', d: '2026-01-01', a: 1 }]))).status, 'ok', 'a hand-built v2 link decodes');
}
await bad(B_FRAGMENT.replace('v=1', 'v=1.0'), 'v=1.0');
await bad(B_FRAGMENT.replace('v=1', 'v=abc'), 'v=abc');
await bad(B_FRAGMENT.replace('v=1', 'v=01'), 'v=01');
await bad(B_FRAGMENT.replace('v=1&', ''), 'e without v');
await bad(link([{ t: 'x', d: '2026-01-01' }]) + '$', 'e with $');
await bad('v=1&tz=UTC&e=abcde', 'length ≡ 1 mod 4');
await bad('v=1&tz=UTC&e=_w', 'e=_w is 0xFF, not UTF-8');
{
  // valid JSON shape around one invalid UTF-8 byte: only a fatal decoder refuses it
  const enc = new TextEncoder();
  const raw = new Uint8Array([...enc.encode('[{"t":"'), 0xff, ...enc.encode('","d":"2026-01-01","a":1}]')]);
  bad('v=1&tz=UTC&e=' + bytesToB64url(raw), 'invalid UTF-8 inside a JSON string');
}
await bad('v=1&tz=UTC&e=', 'empty e');
await bad(link({ t: 'x', d: '2026-01-01' }), 'object instead of array');
await bad(link([]), 'empty array');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, zz: 1 }]), 'unknown key on an otherwise valid event');
await bad(link([{ t: 'x', d: '2026-01-01', a: true }]), 'a:true');
await bad(link([{ t: 'x', d: '2026-01-01', a: 2, s: '09:00' }]), 'a:2 on an otherwise valid timed event');
await bad(link([{ t: 5, d: '2026-01-01' }]), 't:5');
await bad(link([{ t: '', d: '2026-01-01', a: 1 }]), 'empty title');
await bad(link([{ t: 'x', d: '2026-01-02', D: '2026-01-01', a: 1 }]), 'endDate before date');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'q' } }]), 'unknown freq');
await bad(link([{ t: 'x', d: '2026-01-01', s: '09:00', r: { f: 'toString', c: 5 } }]), 'inherited property name as freq');
await bad(link([{ t: 'x', d: '2026-01-01', s: '09:00', r: { f: 'constructor' } }]), 'constructor as freq');
// raw JSON: in an object literal __proto__ would set the prototype, not a key
await bad('v=1&tz=UTC&e=' + bytesToB64url(new TextEncoder().encode('[{"t":"x","d":"2026-01-01","a":1,"__proto__":{"x":1}}]')), '__proto__ key');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, hasOwnProperty: 'y' }]), 'inherited property name as key');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'w', b: 'MOXX' } }]), 'bad byDay');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: { f: 'd', c: 2, x: '2027-01-01' } }]), 'count and until');
await bad(link([{ t: 'x', d: '2026-01-01', a: 1, r: [] }]), 'r as array');
await bad(link([{ t: 'x', d: '2026-01-01' }]), 'timed without start time');
await bad(link(Array.from({ length: 201 }, () => ({ t: 'x', d: '2026-01-01', a: 1 }))), '201 events');
eq((await decodeFragment(link(Array.from({ length: 200 }, () => ({ t: 'x', d: '2026-01-01', a: 1 }))))).status, 'ok', '200 events');
await bad('v=1&tz=UTC&e=' + 'A'.repeat(100004), 'e > 100k');
eq(MAX_E_LENGTH, 100000, 'the refusal length is exported for the page (Copy link is disabled beyond it)');
{
  // the boundary on an otherwise valid v1 link (the length check runs before any inflation): nine events at the
  // description cap plus one sized so that e lands exactly on / just over the limit
  const full = { t: 'x', d: '2026-01-01', a: 1, n: 'd'.repeat(LIMITS.description) };
  const withDesc = (n) => link([...Array(9).fill(full), { t: 'x', d: '2026-01-01', a: 1, n: 'd'.repeat(n) }]);
  const eLen = (frag) => new URLSearchParams(frag).get('e').length;
  let n = 2000;
  while (eLen(withDesc(n)) < MAX_E_LENGTH) n++;
  const atLimit = withDesc(n);
  eq(eLen(atLimit), MAX_E_LENGTH, 'a fragment with e exactly at MAX_E_LENGTH exists');
  eq((await decodeFragment(atLimit)).status, 'ok', 'e at MAX_E_LENGTH still decodes');
  const over = withDesc(n + 3);
  ok(eLen(over) > MAX_E_LENGTH && eLen(over) <= MAX_E_LENGTH + 4, `e just over the limit (${eLen(over)})`);
  await bad(over, 'valid content, e just over MAX_E_LENGTH');
  await bad('v=2&tz=UTC&e=' + 'A'.repeat(MAX_E_LENGTH + 4), 'v2 e over the limit is refused before inflating', 'e');
}
await bad(B_FRAGMENT.replace('Europe%2FBerlin', 'Mars%2FOlympus'), 'tz=Mars/Olympus');
await bad(B_FRAGMENT.replace('tz=Europe%2FBerlin&', ''), 'tz missing');
await bad(B_FRAGMENT + '&e=' + b64([{ t: 'y', d: '2026-01-01', a: 1 }]), 'two e');
const detail = await decodeFragment(link([{ t: 'x', d: '2026-01-01', a: 1 }, { t: '', d: '2026-01-01', a: 1 }]));
eq(detail.detail, '#1:err_title_required', 'detail names the event and rule');

// size
const ten = await encodeFragment({ events: Array.from({ length: 10 }, () => B), tz: TZ });
ok(ten.length < 1500, `10 events under 1500 chars (${ten.length})`);

// base64url helpers
deq([...b64urlToBytes(bytesToB64url(new Uint8Array([0, 255, 254, 253, 62, 63])))], [0, 255, 254, 253, 62, 63], 'byte round trip');
eq(bytesToB64url(new Uint8Array([251, 255])), '-_8', 'url-safe alphabet');
const big = new Uint8Array(70000).map((_, i) => i % 251);
deq(b64urlToBytes(bytesToB64url(big)), big, 'chunked encoding above 0x8000 bytes');

console.log(`fragment.test: ${checks} checks passed`);
