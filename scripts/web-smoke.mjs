#!/usr/bin/env node
// Gate over the shipped page: the zero-storage contract (no storage, no
// network, no address-bar writes, no HTML string sinks, no external
// resources), the meta CSP pinned directive by directive, no inline script
// or handlers, every referenced asset relative and present, the module graph
// closed over SHIPPED, pages.yml shipping every file, the share link and the
// QR panel derived from state only, the serializer importable, and every
// i18n key the page names present in the string table.
//
// Usage: node scripts/web-smoke.mjs   (exit 1 on any failure)
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHIPPED = ['index.html', 'style.css', 'app.js', 'calendar.js', 'ics.js', 'model.js', 'fragment.js', 'qr.js', 'i18n.js', 'qrcodegen.js'];
const EXTRA_SHIPPED = ['favicon.ico', '404.html', 'robots.txt', 'sitemap.xml', 'LICENSE', 'NOTICE'];

let failures = 0;
function fail(msg) { console.error('FAIL: ' + msg); failures++; }
function ok(msg) { console.log('ok   ' + msg); }
const read = (name) => readFileSync(join(root, name), 'utf8');

// --- 1. forbidden patterns over every shipped file
const forbidden = [
  [/localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore|serviceWorker|caches\./, 'storage API'],
  [/history\.(pushState|replaceState|go|back|forward)/, 'history write'],
  [/location\.(hash|href|search|pathname)\s*=(?!=)/, 'address bar write'],
  [/location\.(assign|replace|reload)\s*\(/, 'navigation call'],
  [/\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, 'network or dynamic import'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'code from strings'],
  [/innerHTML|outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(|createContextualFragment/, 'HTML string sink'],
  [/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i, 'external resource tag'],
  [/@import|url\(\s*["']?https?:/i, 'external stylesheet resource'],
];
for (const name of SHIPPED) {
  const src = read(name);
  const hits = forbidden.filter(([re]) => re.test(src)).map(([, what]) => what);
  if (hits.length) fail(`${name} violates the zero-storage contract: ${hits.join(', ')}`);
  else ok(`${name} names no storage, network, address-bar write, HTML sink or external resource`);
}

// --- 2. CSP pinned directive by directive (parsed the way a browser reads it:
// comments stripped, first mention wins, names case-insensitive, values as a set)
const html = read('index.html');
const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');
{
  const tag = htmlNoComments.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*?content="([^"]*)"/i);
  if (!tag) {
    fail('index.html: no Content-Security-Policy meta tag with a content attribute');
  } else {
    const norm = (v) => v.split(/\s+/).filter(Boolean).sort().join(' ');
    const got = new Map();
    for (const d of tag[1].split(';').map((s) => s.trim()).filter(Boolean)) {
      const [name, ...vals] = d.split(/\s+/);
      const key = name.toLowerCase();
      if (!got.has(key)) got.set(key, norm(vals.join(' ')));
    }
    const required = [
      ['default-src', "'none'"],
      ['script-src', "'self'"],
      ['style-src', "'self'"],
      ['img-src', "'self' data:"],
      ['connect-src', "'self'"],
      ['base-uri', "'none'"],
      ['form-action', "'none'"],
    ];
    const bad = required
      .filter(([k, v]) => got.get(k) !== norm(v))
      .map(([k, v]) => `${k} must be "${v}", got "${got.get(k) ?? '(absent)'}"`);
    if (bad.length) fail('index.html CSP: ' + bad.join('; '));
    else ok('index.html CSP pins ' + required.map(([k]) => k).join(', '));
  }
}

// --- 3. nothing inline: the CSP would block it silently
{
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>/i.test(htmlNoComments);
  const styleAttr = /\sstyle=/i.test(htmlNoComments);
  const handler = /\son\w+=/i.test(htmlNoComments);
  if (inlineScript) fail('index.html has an inline <script> without src');
  if (styleAttr) fail('index.html has a style= attribute');
  if (handler) fail('index.html has an on*= handler attribute');
  if (!inlineScript && !styleAttr && !handler) ok('index.html has no inline script, style attribute or handler attribute');
}

// --- 4. every src/href is relative (Pages serves under /calqrii/) and exists
{
  let count = 0;
  let bad = 0;
  for (const m of htmlNoComments.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // scheme: external link, not an asset
    count++;
    if (ref.startsWith('/')) { fail(`index.html references root-absolute ${ref}`); bad++; continue; }
    if (!existsSync(join(root, ref))) { fail(`index.html references missing file ${ref}`); bad++; }
  }
  if (count === 0) fail('index.html references no relative asset at all -- the gate has nothing to check');
  else if (!bad) ok(`index.html: ${count} relative asset references, all present`);
}

// --- 5. module graph: static relative imports only, closed over SHIPPED
{
  const seen = new Set(['index.html', 'style.css']);
  for (const m of htmlNoComments.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) seen.add(m[1]);
  const queue = ['app.js'];
  let bad = 0;
  while (queue.length) {
    const name = queue.shift();
    if (!SHIPPED.includes(name)) { fail(`${name} is imported but not in SHIPPED`); bad++; continue; }
    seen.add(name);
    for (const m of read(name).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith('./') || spec.includes('/', 2)) { fail(`${name} imports ${spec}: only ./x.js is allowed`); bad++; continue; }
      const dep = spec.slice(2);
      if (!seen.has(dep) && !queue.includes(dep)) queue.push(dep);
    }
  }
  const missing = SHIPPED.filter((n) => !seen.has(n));
  const extra = [...seen].filter((n) => !SHIPPED.includes(n));
  if (missing.length) { fail(`SHIPPED files never reached from index.html: ${missing.join(', ')}`); bad++; }
  if (extra.length) { fail(`files reached from index.html but not in SHIPPED: ${extra.join(', ')}`); bad++; }
  if (!bad) ok(`module graph from index.html is exactly SHIPPED (${SHIPPED.length} files)`);
}

// --- 6. pages.yml ships every file
{
  const yml = read('.github/workflows/pages.yml');
  const cp = yml.match(/\bcp\s+([\s\S]*?)\s+_site\/?\s*$/m);
  if (!cp) {
    fail('pages.yml: no "cp … _site" line');
  } else {
    const names = cp[1].split(/\s+/).filter(Boolean);
    const missing = [...SHIPPED, ...EXTRA_SHIPPED].filter((n) => !names.includes(n));
    if (missing.length) fail(`pages.yml cp line lacks: ${missing.join(', ')}`);
    else ok(`pages.yml copies all ${SHIPPED.length + EXTRA_SHIPPED.length} shipped files`);
  }
}

// --- 7. the link and the QR panel describe state, never the form
/** Source text of `function fn(...) {...}`; null when absent or unbalanced. */
function bodyOf(src, fn) {
  const start = src.indexOf(`function ${fn}(`);
  if (start === -1) return null;
  // Skip the parameter list first: a destructured parameter carries its own
  // '{', and counting from there would return the signature as the "body".
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  const open = src.indexOf('{', i);
  if (i >= src.length || open === -1) return null;
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
}
{
  const src = read('app.js');
  const formRead = [/\breadEditor\b|\.value\b|\$\(/, 'reads the form instead of state'];
  const literalOrigin = [/['"`]https?:|location\.href/, 'hard-codes an origin (the page is self-hostable)'];
  // Every gated body must contain anchors from its real body, so a body
  // extracted too short (or emptied) fails loudly instead of passing vacuously.
  const gated = [
    ['pageBase', ['location.origin + location.pathname'], [literalOrigin]],
    ['shareURL', ['linkFor(pageBase(), state.events, state.tz)'], [formRead, literalOrigin]],
    ['eventLink', ['linkFor(pageBase(), [ev], state.tz)'], [formRead, literalOrigin]],
    ['renderQrPanel', ['qrFor(text)', 'panelData.set('], [formRead]],
    ['renderList', ['eventLink(ev)'], [formRead]],
    ['renderCombined', ['shareURL()'], [formRead]],
    ['renderView', ['state.events'], [formRead]],
    ['fillPrintSheet', ['qrFor(data.text)'], [formRead]],
    ['printPanel', ['panelData.get('], [formRead]],
    ['copyPanel', ['panelData.get('], [formRead]],
  ];
  for (const [fn, anchors, forbids] of gated) {
    const body = bodyOf(src, fn);
    if (!body) { fail(`app.js: ${fn}() not found -- its gate has nothing to check`); continue; }
    const missing = anchors.filter((a) => !body.includes(a));
    const hits = forbids.filter(([re]) => re.test(body)).map(([, what]) => what);
    if (missing.length) fail(`app.js: ${fn}() lacks ${missing.map((a) => `"${a}"`).join(', ')}`);
    else if (hits.length) fail(`app.js: ${fn}() ${hits.join('; ')}`);
    else ok(`app.js ${fn}() keeps its anchors, ${forbids.includes(formRead) ? 'reads no form field' : 'names no origin'}`);
  }
}

// --- 8. the serializer imports and produces the pinned fixture
{
  const { serializeEvent } = await import('../ics.js');
  const { B, B_ICS, OPTS } = await import('../test/helpers/fixtures.mjs');
  const got = serializeEvent(B, OPTS);
  if (got !== B_ICS) fail('ics.js does not reproduce fixture B');
  else ok(`ics.js imports and reproduces fixture B (${Buffer.byteLength(got)} bytes)`);
}

// --- 9. every i18n key the page names exists: applyLang() skips unknown keys
// silently, so a typo would ship the English placeholder in the other language
{
  const { STR } = await import('../i18n.js');
  const names = new Set();
  for (const m of htmlNoComments.matchAll(/\bdata-i18n(?:-aria)?="([^"]+)"/g)) names.add(m[1]);
  for (const m of read('app.js').matchAll(/\bt\(\)\.([A-Za-z_]\w*)/g)) names.add(m[1]);
  if (names.size === 0) {
    fail('index.html and app.js name no i18n key at all -- the gate has nothing to check');
  } else {
    const missing = [...names].filter((k) => !Object.hasOwn(STR.en, k));
    if (missing.length) fail(`i18n keys named by the page but missing from STR.en: ${missing.join(', ')}`);
    else ok(`all ${names.size} i18n keys named by index.html and app.js exist`);
  }
}

process.exit(failures ? 1 : 0);
