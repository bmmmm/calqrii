#!/usr/bin/env node
// Gate over the shipped pages (index.html, import.html): the zero-storage contract (no storage, no
// network outside geocode.js — one origin, click-only, after consent —, no
// address-bar writes, no HTML string sinks, no external resources), the meta
// CSP pinned directive by directive, no inline script
// or handlers, every referenced asset relative and present, the module graph
// closed over SHIPPED and pinned per page (PAGE_GRAPH), pages.yml shipping every file, the share link and the
// QR panel derived from state only, the serializer importable, and every
// i18n key the page names present in the string table.
//
// Usage: node scripts/web-smoke.mjs   (exit 1 on any failure)
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHIPPED = ['index.html', 'import.html', 'style.css', 'app.js', 'import.js', 'parse.js', 'calendar.js', 'ics.js', 'model.js', 'fragment.js', 'geocode.js', 'qr.js', 'i18n.js', 'tzmap.js', 'qrcodegen.js'];
// Every page and its module entry; §2–§5 run per page, the module graphs together must be exactly SHIPPED.
const PAGES = { 'index.html': 'app.js', 'import.html': 'import.js' };
// Each page's exact module set (entry, imports, classic scripts). A new import is a one-line change here.
const PAGE_GRAPH = {
  'index.html': ['app.js', 'calendar.js', 'ics.js', 'fragment.js', 'qr.js', 'i18n.js', 'geocode.js', 'model.js', 'qrcodegen.js'],
  'import.html': ['import.js', 'parse.js', 'fragment.js', 'i18n.js', 'model.js', 'ics.js', 'tzmap.js', 'qr.js', 'qrcodegen.js'],
};
const EXTRA_SHIPPED = ['favicon.ico', '404.html', 'robots.txt', 'sitemap.xml', 'LICENSE', 'NOTICE'];
// The one module allowed to use the network, and the one origin it may name.
const NETWORK_MODULE = 'geocode.js';
const NOMINATIM_ORIGIN = 'https://nominatim.openstreetmap.org';
// Only the page with the address search may connect anywhere; the import page connects nowhere.
const CONNECT_SRC = { 'index.html': `'self' ${NOMINATIM_ORIGIN}`, 'import.html': "'none'" };

let failures = 0;
function fail(msg) { console.error('FAIL: ' + msg); failures++; }
function ok(msg) { console.log('ok   ' + msg); }
const read = (name) => readFileSync(join(root, name), 'utf8');

// Whitespace and comments: what may stand between `import`/`from` and what follows it.
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;

// --- 1. forbidden patterns over every shipped file
const forbidden = [
  [/localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore|serviceWorker|caches\./, 'storage API'],
  [/history\.(pushState|replaceState|go|back|forward)/, 'history write'],
  [/location\.(hash|href|search|pathname)\s*=(?!=)/, 'address bar write'],
  [/location\.(assign|replace|reload)\s*\(/, 'navigation call'],
  [new RegExp(String.raw`\bimport${GAP}\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon`), 'network or dynamic import'],
  // The bare identifier, not just a call: `const f = fetch` would dodge /fetch\(/. Only NETWORK_MODULE may name it.
  [/\bfetch\b/, `fetch outside ${NETWORK_MODULE}`, (name) => name !== NETWORK_MODULE],
  [/\beval\s*\(|new\s+Function\s*\(/, 'code from strings'],
  [/innerHTML|outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(|createContextualFragment/, 'HTML string sink'],
  [/<(script|link|img|iframe)[^>]+(src|href)=["']https?:/i, 'external resource tag'],
  [/@import|url\(\s*["']?https?:/i, 'external stylesheet resource'],
];
for (const name of SHIPPED) {
  const src = read(name);
  const hits = forbidden.filter(([re, , applies = () => true]) => applies(name) && re.test(src)).map(([, what]) => what);
  if (hits.length) fail(`${name} violates the zero-storage contract: ${hits.join(', ')}`);
  else ok(`${name} names no storage, network, address-bar write, HTML sink or external resource`);
}

// --- 2. CSP pinned directive by directive (parsed the way a browser reads it:
// comments stripped, first mention wins, names case-insensitive, values as a set)
const stripComments = (name) => read(name).replace(/<!--[\s\S]*?-->/g, '');
for (const page of Object.keys(PAGES)) {
  const htmlNoComments = stripComments(page);
  const tag = htmlNoComments.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*?content="([^"]*)"/i);
  if (!tag) {
    fail(`${page}: no Content-Security-Policy meta tag with a content attribute`);
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
      ['connect-src', CONNECT_SRC[page]],
      ['base-uri', "'none'"],
      ['form-action', "'none'"],
    ];
    const bad = required
      .filter(([k, v]) => got.get(k) !== norm(v))
      .map(([k, v]) => `${k} must be "${v}", got "${got.get(k) ?? '(absent)'}"`);
    if (bad.length) fail(`${page} CSP: ` + bad.join('; '));
    else ok(`${page} CSP pins ` + required.map(([k]) => k).join(', '));
  }

  // --- 3. nothing inline: the CSP would block it silently
  const inlineScript = /<script(?![^>]*\ssrc=)[^>]*>/i.test(htmlNoComments);
  const styleAttr = /\sstyle=/i.test(htmlNoComments);
  const handler = /\son\w+=/i.test(htmlNoComments);
  if (inlineScript) fail(`${page} has an inline <script> without src`);
  if (styleAttr) fail(`${page} has a style= attribute`);
  if (handler) fail(`${page} has an on*= handler attribute`);
  if (!inlineScript && !styleAttr && !handler) ok(`${page} has no inline script, style attribute or handler attribute`);

  // --- 4. every src/href is relative (Pages serves under /calqrii/) and exists
  let count = 0;
  let badRefs = 0;
  for (const m of htmlNoComments.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue; // scheme: external link, not an asset
    count++;
    if (ref.startsWith('/')) { fail(`${page} references root-absolute ${ref}`); badRefs++; continue; }
    if (ref === './') continue; // the page's own directory: the start page
    if (!existsSync(join(root, ref))) { fail(`${page} references missing file ${ref}`); badRefs++; }
  }
  if (count === 0) fail(`${page} references no relative asset at all -- the gate has nothing to check`);
  else if (!badRefs) ok(`${page}: ${count} relative asset references, all present`);
}

// Specifiers of a module's static imports and re-exports, over-read on purpose (fail closed): `from '…'`
// anywhere, so no clause shape (a comment or `;` inside the braces, `as "x;y"`) can hide one, and a
// side-effect `import '…'` at a statement start (line start, after `;` `{` `}` `)` or a block comment);
// comments may stand before the specifier. The price: a string literal ending in the word `from`, or
// `; import '…'` inside a comment or string, fails with the file named -- reword it. Dynamic import()
// is §1's job.
// Two passes, united: a GAP can swallow a string that looks like a comment (and a live import behind it),
// so the plain reading without comments in the gap always runs too.
const IMPORT_RES = [
  /\bfrom\s*['"]([^'"]+)['"]|(?:^|[;{})]|\*\/)\s*import\s*['"]([^'"]+)['"]/gm,
  new RegExp(String.raw`\bfrom${GAP}['"]([^'"]+)['"]|(?:^|[;{})]|\*/)\s*import${GAP}['"]([^'"]+)['"]`, 'gm'),
];
function importSpecifiers(src) {
  return [...new Set(IMPORT_RES.flatMap((re) => [...src.matchAll(re)].map((m) => m[1] ?? m[2])))];
}

/**
 * The source with every comment blanked (newlines kept). Strings and templates are stepped over; regex
 * literals are not understood: a quote inside one makes the rest of its line read as a string, so a
 * commented-out import behind it on that line still counts as live (not caught, like HEAD before it).
 */
function blankComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (src.startsWith('//', i) || src.startsWith('/*', i)) {
      const close = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : src[i + 1] === '/' ? close : close + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// --- 5. module graph: static relative imports only, closed over SHIPPED, pinned per page
{
  const seen = new Set(['style.css', ...Object.keys(PAGES)]);
  let bad = 0;
  for (const [page, entry] of Object.entries(PAGES)) {
    const scripts = [...stripComments(page).matchAll(/<script\b[^>]*\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)].map((m) => m[1] ?? m[2] ?? m[3]);
    if (!scripts.includes(entry)) fail(`${page} does not load its entry ${entry}`);
    const reached = new Set(scripts);
    const queue = [...scripts]; // every script the page loads, not only its entry: a second module script brings its own imports
    while (queue.length) {
      const name = queue.shift();
      if (!SHIPPED.includes(name)) { fail(`${name} is imported but not in SHIPPED`); bad++; continue; }
      reached.add(name);
      const code = read(name);
      // An import read only from a comment (a commented-out line) would stand in for a real one in the pin.
      const live = new Set(importSpecifiers(blankComments(code)));
      for (const spec of importSpecifiers(code)) {
        if (!live.has(spec)) { fail(`${name}: ${JSON.stringify(spec.slice(0, 40))} is imported only inside a comment (or a comment confuses the reader) -- remove or reword it`); bad++; }
        if (!spec.startsWith('./') || spec.includes('/', 2)) { fail(`${name} imports ${JSON.stringify(spec.slice(0, 40))}: only ./x.js is allowed`); bad++; continue; }
        const dep = spec.slice(2);
        if (!reached.has(dep) && !queue.includes(dep)) queue.push(dep);
      }
    }
    for (const n of reached) seen.add(n);
    const want = [...PAGE_GRAPH[page]].sort();
    const got = [...reached].filter((n) => n.endsWith('.js')).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) { fail(`${page} module graph is ${got.join(', ')}; pinned: ${want.join(', ')}`); bad++; }
    else ok(`${page} loads exactly its pinned ${want.length} modules`);
  }
  const missing = SHIPPED.filter((n) => !seen.has(n));
  const extra = [...seen].filter((n) => !SHIPPED.includes(n));
  if (missing.length) { fail(`SHIPPED files never reached from a page: ${missing.join(', ')}`); bad++; }
  if (extra.length) { fail(`files reached from a page but not in SHIPPED: ${extra.join(', ')}`); bad++; }
  if (!bad) ok(`module graphs from ${Object.keys(PAGES).join(' and ')} cover exactly SHIPPED (${SHIPPED.length} files)`);
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
  const formRead = [/\breadEditor\b|\.value\b|\$\(|els\.text\b/, 'reads the form instead of state'];
  const literalOrigin = [/['"`]https?:|location\.href/, 'hard-codes an origin (the page is self-hostable)'];
  // Every gated body must contain anchors from its real body, so a body
  // extracted too short (or emptied) fails loudly instead of passing vacuously.
  const gated = [
    ['pageBase', ['location.origin + location.pathname'], [literalOrigin]],
    ['prepareLinks', ['linkFor(pageBase(), evs, state.tz)', 'state.events'], [formRead, literalOrigin]],
    ['shareURL', ['linkMemo.get(linkKey(state.events))'], [formRead, literalOrigin]],
    ['eventLink', ['linkMemo.get(linkKey([ev]))'], [formRead, literalOrigin]],
    ['renderQrPanel', ['qrFor(text)', 'panelData.set('], [formRead]],
    ['renderList', ['eventLink(ev)'], [formRead]],
    ['renderCombined', ['shareURL()'], [formRead]],
    ['renderView', ['state.events'], [formRead]],
    ['fillPrintSheet', ['qrFor(data.text)'], [formRead]],
    ['printPanel', ['panelData.get('], [formRead]],
    ['copyPanel', ['panelData.get('], [formRead]],
  ];
  // The import page builds its link the same way: from state, with the page's own directory as base.
  const importGated = [
    ['pageBase', ['location.origin + location.pathname'], [literalOrigin]],
    ['renderBar', ['linkFor(pageBase(), chosen, state.tz)', 'state.selected'], [formRead, literalOrigin]],
  ];
  for (const [file, list] of [['app.js', gated], ['import.js', importGated]]) {
    const code = read(file);
    for (const [fn, anchors, forbids] of list) {
      const body = bodyOf(code, fn);
      if (!body) { fail(`${file}: ${fn}() not found -- its gate has nothing to check`); continue; }
      const missing = anchors.filter((a) => !body.includes(a));
      const hits = forbids.filter(([re]) => re.test(body)).map(([, what]) => what);
      if (missing.length) fail(`${file}: ${fn}() lacks ${missing.map((a) => `"${a}"`).join(', ')}`);
      else if (hits.length) fail(`${file}: ${fn}() ${hits.join('; ')}`);
      else ok(`${file} ${fn}() keeps its anchors, ${forbids.includes(formRead) ? 'reads no form field' : 'names no origin'}`);
    }
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
  for (const [page, entry] of Object.entries(PAGES)) {
    for (const m of stripComments(page).matchAll(/\bdata-i18n(?:-aria)?="([^"]+)"/g)) names.add(m[1]);
    for (const m of read(entry).matchAll(/\bt\(\)\.([A-Za-z_]\w*)/g)) names.add(m[1]);
  }
  // Warning keys the parsers emit are shown through t()[key] and must exist too.
  for (const m of read('parse.js').matchAll(/'(imp_warn_\w+)'/g)) names.add(m[1]);
  if (names.size === 0) {
    fail('the pages name no i18n key at all -- the gate has nothing to check');
  } else {
    const missing = [...names].filter((k) => !Object.hasOwn(STR.en, k));
    if (missing.length) fail(`i18n keys named by the pages but missing from STR.en: ${missing.join(', ')}`);
    else ok(`all ${names.size} i18n keys named by the pages, their modules and parse.js exist`);
  }
}

// --- 10. the network: geocode.js only, one origin, called only from the address-search click after consent
{
  const geo = read(NETWORK_MODULE);
  const origins = [...geo.matchAll(/https?:\/\/[^\s'"`)/]+/g)].map((m) => m[0]);
  const foreign = origins.filter((o) => o !== NOMINATIM_ORIGIN);
  if (origins.length === 0) fail(`${NETWORK_MODULE} names no URL -- its gate has nothing to check`);
  else if (foreign.length) fail(`${NETWORK_MODULE} names ${foreign.join(', ')}; only ${NOMINATIM_ORIGIN} is allowed`);
  else ok(`${NETWORK_MODULE} names only ${NOMINATIM_ORIGIN}`);
  const fetchRefs = (geo.match(/\bfetch\b/g) || []).length;
  if (fetchRefs !== 1 || !/function searchNominatim\([^)]*\bfetchImpl\s*=\s*fetch\b/.test(geo)) {
    fail(`${NETWORK_MODULE}: fetch must appear exactly once, as searchNominatim's injectable default (found ${fetchRefs})`);
  } else ok(`${NETWORK_MODULE} reaches the network only through searchNominatim`);
  const leaks = SHIPPED.filter((n) => n.endsWith('.js') && n !== NETWORK_MODULE && read(n).includes('//nominatim.'));
  if (leaks.length) fail(`only ${NETWORK_MODULE} may name the Nominatim URL: ${leaks.join(', ')}`);
  else ok('no other shipped module names the Nominatim URL');

  const app = read('app.js');
  const body = bodyOf(app, 'onGeoSearch');
  if (!body) {
    fail('app.js: onGeoSearch() not found -- its gate has nothing to check');
  } else {
    const calls = (app.match(/\bsearchNominatim\s*\(/g) || []).length;
    const call = body.search(/\bsearchNominatim\s*\(/);
    const consent = body.indexOf('state.geoConsent');
    const outside = app.replace(body, '');
    const refs = (outside.match(/\bonGeoSearch\b/g) || []).length;
    if (calls !== 1 || call === -1) fail('app.js: searchNominatim( must appear exactly once, inside onGeoSearch()');
    else if (consent === -1 || consent > call) fail('app.js: onGeoSearch() must check state.geoConsent before searching');
    else if (refs !== 1 || !/\.addEventListener\(\s*'click'\s*,\s*onGeoSearch\s*\)/.test(outside)) fail("app.js: onGeoSearch must be bound once, to 'click', and called from nowhere else");
    else ok('app.js searches only from the address-search click, after consent');
  }
}

process.exit(failures ? 1 : 0);
