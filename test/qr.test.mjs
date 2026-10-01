// QR tests: a decoder-free oracle for the vendored library, pinned symbols
// for the fixtures, the ECC policy and the exact SVG geometry.
// Run: node test/qr.test.mjs
import assert from 'node:assert/strict';
import './helpers/load-qrcodegen.mjs';
import { encodeQr, eccFor, sizeTier, qrSvg, svgPathData, svgFromQr, utf8Length, QUIET_ZONE, HARD_LIMIT_BYTES } from '../qr.js';
import { serializeEvent, serializeCalendar } from '../ics.js';
import { linkFor } from '../fragment.js';
import { OPTS, A, B, C, PAGES_BASE, B_FRAGMENT_V2 } from './helpers/fixtures.mjs';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const deq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const { QrCode, QrSegment } = globalThis.qrcodegen;

// 1. oracle: byte-mode "HELLO WORLD" at level M, pinned in gymii against
// node-qrcode and libqrencode. Proves the vendored encoder without a decoder.
const HELLO_WORLD_M = [
  '111111101100101111111',
  '100000100001001000001',
  '101110100101001011101',
  '101110101001001011101',
  '101110101110101011101',
  '100000101001001000001',
  '111111101010101111111',
  '000000001001100000000',
  '100010111111011111001',
  '000100001011100001111',
  '001111110011011010010',
  '111110001100010000000',
  '111110101010101100110',
  '000000001010111101011',
  '111111101110101011010',
  '100000100101110110011',
  '101110101101011000110',
  '101110100100100011011',
  '101110100111000111000',
  '100000100001010000000',
  '111111101111111110101',
];
const hello = QrCode.encodeSegments([QrSegment.makeBytes(new TextEncoder().encode('HELLO WORLD'))], QrCode.Ecc.MEDIUM, 1, 40, -1, false);
eq(hello.size, 21, 'oracle is 21×21');
eq(hello.mask, 4, 'oracle mask 4');
const rows = [];
for (let y = 0; y < hello.size; y++) {
  let row = '';
  for (let x = 0; x < hello.size; x++) row += hello.getModule(x, y) ? '1' : '0';
  rows.push(row);
}
deq(rows, HELLO_WORLD_M, 'vendored library reproduces the pinned symbol');

// 2. pinned fixtures — re-pinned 2026-10-01 for the L-always ECC policy (was M below 1200 bytes), then for PRODID:calqrii and the dropped INTERVAL=1
const darkCount = (qr) => {
  let n = 0;
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) n++;
  return n;
};
const table = [
  ['A', serializeEvent(A, OPTS), 399, 13, 69, 'L', 5, 2394],
  ['B', serializeEvent(B, OPTS), 261, 10, 57, 'L', 3, 1588],
  ['C', serializeEvent(C, OPTS), 398, 13, 69, 'L', 4, 2412],
  ['A+B+C', serializeCalendar([A, B, C], OPTS), 936, 22, 105, 'L', 4, 5578],
  ['B link', PAGES_BASE + '#' + B_FRAGMENT_V2, 169, 8, 49, 'L', 2, 1232], // link-mode code: the page URL with B in the (v2, deflated) fragment
];
for (const [name, text, bytes, version, size, ecc, mask, dark] of table) {
  const r = encodeQr(text);
  eq(r.bytes, bytes, `${name} bytes`);
  eq(r.version, version, `${name} version`);
  eq(r.size, size, `${name} size`);
  eq(r.ecc, ecc, `${name} ecc`);
  eq(r.qr.mask, mask, `${name} mask`);
  eq(darkCount(r.qr), dark, `${name} dark modules`);
  eq(r.large, bytes > 500, `${name} large flag`);
}

// the live encoder is not pinned byte for byte (zlib builds pack differently); it must stay in the same version class
{
  const live = encodeQr(await linkFor(PAGES_BASE, [B], OPTS.tz));
  ok(live.version <= 8 && live.ecc === 'L', `live link for B fits v${live.version} ${live.ecc} (pinned text: v8)`);
}

// 3. ECC policy (L always, boost may raise it) and the hard cap
deq([0, 500, 1200, 1201, 2953].map(eccFor), ['LOW', 'LOW', 'LOW', 'LOW', 'LOW'], 'eccFor asks for L at every size');
assert.throws(() => eccFor(2954), (e) => e instanceof RangeError && e.message === 'too_big'); checks++;
const max = encodeQr('x'.repeat(HARD_LIMIT_BYTES));
eq(`${max.version}/${max.size}/${max.ecc}`, '40/177/L', '2953 bytes fit v40-L');
assert.throws(() => qrSvg('x'.repeat(2954)), (e) => e instanceof RangeError && e.message === 'too_big'); checks++;
eq(encodeQr('x'.repeat(415)).ecc, 'L', 'a fixture-sized text stays at L');
eq(`${encodeQr('a').version}/${encodeQr('a').ecc}`, '1/H', 'boostEcl raises the level when the version has room');
ok(encodeQr('x'.repeat(1201)).large && !encodeQr('x'.repeat(500)).large, 'large above 500 bytes');
eq(utf8Length('ä🎉'), 6, 'utf8Length counts bytes');
// the meter's tiers: the soft limit and the hard cap, nothing in between
deq([0, 500, 501, 1200, 1201, 2953, 2954].map(sizeTier), ['ok', 'ok', 'large', 'large', 'large', 'large', 'too_big'], 'sizeTier thresholds');

// 4. SVG geometry per fixture
const RUN = /M(\d+),(\d+)h(\d+)v1h-(\d+)z/g;
for (const [name, text] of table) {
  const { svg, qr, size } = qrSvg(text);
  const n = size + 2 * QUIET_ZONE;
  ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" '), `${name} svg root`);
  ok(svg.includes(`viewBox="0 0 ${n} ${n}"`), `${name} viewBox`);
  ok(svg.includes(`width="${8 * n}" height="${8 * n}"`), `${name} width/height`);
  ok(svg.includes(`<rect width="${n}" height="${n}" fill="#fff"/>`), `${name} background`);
  ok(!svg.includes('style=') && !svg.includes('<script'), `${name} no style/script`);
  const d = svg.match(/ d="([^"]*)"/)[1];
  eq(d, svgPathData(qr, QUIET_ZONE), `${name} path data`);
  const grid = Array.from({ length: n }, () => new Array(n).fill(false));
  let consumed = '';
  let sum = 0;
  let lastRow = -1;
  let lastEnd = -1;
  for (const m of d.matchAll(RUN)) {
    consumed += m[0];
    const [x, y, len, back] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    eq(len, back, `${name} run closes on itself`);
    if (y === lastRow) ok(x > lastEnd, `${name} runs are maximal (gap before x=${x})`);
    lastRow = y; lastEnd = x + len;
    for (let i = 0; i < len; i++) grid[y][x + i] = true;
    sum += len;
  }
  eq(consumed, d, `${name} path fully consumed by the run grammar`);
  eq(sum, darkCount(qr), `${name} Σ len = dark modules`);
  let mismatch = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inside = x >= QUIET_ZONE && y >= QUIET_ZONE && x < n - QUIET_ZONE && y < n - QUIET_ZONE;
      const want = inside ? qr.getModule(x - QUIET_ZONE, y - QUIET_ZONE) : false;
      if (grid[y][x] !== want) mismatch++;
    }
  }
  eq(mismatch, 0, `${name} matrix reconstruction matches getModule, quiet zone light`);
}
eq(svgFromQr(hello).match(/viewBox="0 0 (\d+) (\d+)"/)[1], '29', 'oracle svg is 21 + 8');

console.log(`qr.test: ${checks} checks passed`);
