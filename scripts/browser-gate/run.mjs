// Browser gate (Definition of done, item 3): the shipped page in headless
// Chrome, every rendered QR code decoded with BarcodeDetector and compared
// byte for byte with the text it claims to carry, in both payload modes and
// for the combined code; no request beyond the dev server, no console error
// or warning (CSP violations surface there), no uncaught exception.
//
// Not part of `npm test`: it needs Chrome on this machine (and outside a
// command sandbox) and Node ≥ 22 for the built-in WebSocket.
//
// Usage: node scripts/browser-gate/run.mjs [--sweep] [--out=<file.json>] [--keep]
//   --sweep  also records the scale/blur sweep and the ECC alternatives per
//            code (a report, not a gate; takes a few minutes)
//   --out    writes the raw results as JSON
//   --keep   leaves the dev server and Chrome running (debugging)
//   CHROME=<path> overrides the browser binary.
// Exit 1 on any failed check; the summary lists every code and its verdict.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTarget } from './cdp.mjs';
import { encodeFragment } from '../../fragment.js';
import { newEvent } from '../../model.js';
import { A, B, C, D } from '../../test/helpers/fixtures.mjs';

const here = new URL('.', import.meta.url);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SWEEP = process.argv.includes('--sweep');
const KEEP = process.argv.includes('--keep');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TZ = 'Europe/Berlin';
// The fixtures plus one event with 4-byte UTF-8, curly quotes, an en dash, ß and
// the escaped characters ; and newline — the charset and escaping probe.
const E = newEvent({
  title: 'Party 🎉 „Zitat“ – Café', date: '2026-11-05', startTime: '19:00', endTime: '23:00',
  location: 'Straße 1; Hof', description: 'Erste Zeile\nZweite Zeile, mit Komma',
});
const EVENTS = [A, B, C, D, E];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.on('error', bad);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error(`not reachable within ${ms} ms: ${url}`);
}

const children = [];
function start(cmd, args, label) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', () => {});
  p.on('error', (e) => { log(label, 'failed to start:', e.message); });
  children.push(p);
  return p;
}
let profile = null;
async function cleanup() {
  if (KEEP) return;
  for (const p of children) { try { p.kill(); } catch {} }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);

try {
  const httpPort = await freePort();
  const cdpPort = await freePort();
  const BASE = `http://127.0.0.1:${httpPort}/`;
  start('python3', ['-m', 'http.server', String(httpPort), '--bind', '127.0.0.1', '--directory', ROOT], 'http.server');
  await waitHttp(BASE + 'index.html', 5000);
  profile = await mkdtemp(join(tmpdir(), 'calqrii-gate-'));
  start(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', 'about:blank'], 'chrome');
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 10000);

  const fragment = await encodeFragment({ events: EVENTS, tz: TZ });
  const probeSrc = await readFile(new URL('probe.js', here), 'utf8');
  const t = await openTarget(cdpPort);
  const requests = [];
  const logEntries = [];
  const exceptions = [];
  let phase = 'load';
  t.on('Network.requestWillBeSent', (p) => requests.push({ url: p.request.url, type: p.type, phase }));
  t.on('Log.entryAdded', (p) => logEntries.push({ ...p.entry, phase }));
  t.on('Runtime.exceptionThrown', (p) => exceptions.push({ text: p.exceptionDetails.exception?.description || p.exceptionDetails.text, phase }));
  t.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') logEntries.push({ source: 'console', level: p.type, text: p.args.map((a) => a.value ?? a.description).join(' '), phase });
  });
  for (const d of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await t.send(d);
  await t.send('Network.setCacheDisabled', { cacheDisabled: true });
  await t.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  async function waitFor(expr, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await t.evaluate(expr).catch(() => false)) return true; await sleep(100); }
    return false;
  }
  // The Python dev server now and then resets a module load; a reload cures it.
  async function loadView() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      // a failed attempt leaves its net::ERR_CONNECTION_RESET in the log; only the attempt that loads is judged
      requests.length = 0; logEntries.length = 0; exceptions.length = 0;
      if (attempt === 1) await t.send('Page.navigate', { url: BASE + '#' + fragment });
      else await t.send('Page.reload', { ignoreCache: true });
      await sleep(300);
      if (await waitFor(`document.querySelectorAll('#view-list > li').length === ${EVENTS.length} && !document.querySelector('#view-section').hidden`)) return attempt;
      log('view not ready, retry', attempt);
    }
    throw new Error('page never reached the view screen');
  }
  ok(`view shows ${EVENTS.length} events (load attempts: ${await loadView()})`);

  // "New event" from the view: the form must be visible and focused once the (asynchronous) render is through
  phase = 'nav';
  await t.evaluate(`document.querySelector('#view-new').click(), true`);
  if (await waitFor(`!document.querySelector('#view-section').hidden === false && document.activeElement && document.activeElement.id === 'f-title'`, 2000)) ok('"New event" from the view shows the form and focuses the title');
  else fail(`"New event" from the view: form hidden=${await t.evaluate(`document.querySelector('form').hidden`)}, focus on ${await t.evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`)}`);

  await loadView();
  phase = 'editor';
  await t.evaluate(`document.querySelector('#view-edit').click(), true`);
  if (!await waitFor(`document.querySelectorAll('[data-qr-panel] .qr svg').length >= ${EVENTS.length}`)) throw new Error('editor codes not rendered');
  await t.evaluate(`(() => { const c = document.querySelector('#combined-toggle'); if (!c.checked) c.click(); return true; })()`);
  if (!await waitFor(`!!document.querySelector('#combined-panel .qr svg')`)) throw new Error('combined code not rendered');
  await t.evaluate(probeSrc);

  const self = await t.evaluate('__probe.selfTest()');
  if (self.genuine && self.mutatedTextFlagged && self.blankNoDetection) ok('probe self-test: genuine text matches, a changed byte is flagged, a blank canvas yields nothing');
  else fail(`probe self-test: ${JSON.stringify(self)}`);

  phase = 'probe';
  const results = { base: BASE, fragment, modes: {}, ecc: [] };
  for (const mode of ['ics', 'link']) {
    await t.evaluate(`(() => { const r = document.querySelector('#payload input[value="${mode}"]'); if (!r.checked) r.click(); return true; })()`);
    await sleep(200);
    if (!await waitFor(`document.querySelectorAll('[data-qr-panel] .qr svg').length >= ${EVENTS.length + 1}`)) throw new Error(`codes not rendered in ${mode} mode`);
    const panels = await t.evaluate(`__probe.probePanels({ sweep: ${SWEEP} })`);
    results.modes[mode] = panels;
    if (panels.length !== EVENTS.length + 1) fail(`${mode}: ${panels.length} codes rendered, expected ${EVENTS.length + 1}`);
    for (const p of panels) {
      const label = `${mode} ${p.where} "${p.title}" ${p.bytes} B v${p.version} ${p.ecc}`;
      if (p.roundTrip.ok && p.detections === 1) ok(`${label}: decodes byte for byte`);
      else fail(`${label}: ${JSON.stringify(p.roundTrip)} (detections: ${p.detections})`);
      if (!p.text.startsWith(mode === 'link' ? BASE + '#' : 'BEGIN:VCALENDAR\r\n')) fail(`${label}: text does not look like a ${mode} payload`);
    }
    if (SWEEP) {
      phase = 'sweep';
      for (const p of panels) {
        log('ECC alternatives', mode, p.where, p.title);
        results.ecc.push({ mode, where: p.where, title: p.title, ...(await t.evaluate(`__probe.eccAlternatives(${JSON.stringify(p.text)})`)) });
      }
      phase = 'probe';
    }
  }

  // import.html: a pasted list becomes a pick list, "Open in calqrii" lands in the view with exactly those events.
  phase = 'import';
  const IMPORT_TEXT = ['Termine', 'Sa, 05.10.2030, 19:00 Uhr', 'Grillfest am Vereinsheim', 'Ort: Vereinsheim, Am Sportplatz 3',
    '17.–18.10.2030', 'Hüttenwochenende', 'Mi 21.10.2030 18:30–20:00 Vorstandssitzung', 'Fr 12.09.2020 Sommerfest (vorbei)'].join('\n');
  const IMPORT_TITLES = ['Grillfest am Vereinsheim', 'Hüttenwochenende', 'Vorstandssitzung']; // the 2020 event is past: hidden and not selected
  // Boot check: applyLang() sets the placeholder, so an empty one means a module load was reset by the dev server.
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await t.send('Page.navigate', { url: BASE + 'import.html' });
    else await t.send('Page.reload', { ignoreCache: true });
    if (await waitFor(`!!document.querySelector('#imp-text') && document.querySelector('#imp-text').placeholder !== ''`)) break;
    if (attempt === 5) throw new Error('import page did not boot');
    log('import page not booted, retry', attempt);
  }
  await t.evaluate(`(() => { const ta = document.querySelector('#imp-text'); ta.value = ${JSON.stringify(IMPORT_TEXT)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  if (!await waitFor(`document.querySelectorAll('#imp-list > li').length === ${IMPORT_TITLES.length} && (document.querySelector('#imp-open').getAttribute('href') || '').startsWith(${JSON.stringify(BASE + '#')})`)) {
    fail(`import: ${await t.evaluate(`document.querySelectorAll('#imp-list > li').length`)} cards, link ${await t.evaluate(`document.querySelector('#imp-open').getAttribute('href')`)}`);
  } else {
    const cards = await t.evaluate(`[...document.querySelectorAll('.imp-title')].map((e) => e.textContent)`);
    if (JSON.stringify(cards) !== JSON.stringify(IMPORT_TITLES)) fail(`import cards: ${JSON.stringify(cards)}`);
    else ok(`import: ${cards.length} upcoming events listed from the pasted text, the past one hidden`);
    await t.evaluate(`document.querySelector('#imp-open').click(), true`);
    if (!await waitFor(`document.querySelectorAll('#view-list > li').length === ${IMPORT_TITLES.length} && !document.querySelector('#view-section').hidden`, 6000)) fail('import: "Open in calqrii" did not reach the view');
    else {
      const titles = await t.evaluate(`[...document.querySelectorAll('.view-title')].map((e) => e.textContent)`);
      const where = await t.evaluate(`document.querySelector('.view-where .where-text').textContent`);
      if (JSON.stringify(titles) !== JSON.stringify(IMPORT_TITLES) || where !== 'Vereinsheim, Am Sportplatz 3') fail(`import view: ${JSON.stringify(titles)}, where "${where}"`);
      else ok('import: the link opens the view with exactly the chosen events (titles and location intact)');
    }
  }

  phase = 'hygiene';
  const offOrigin = requests.filter((r) => !r.url.startsWith(BASE) && !r.url.startsWith('data:'));
  if (offOrigin.length) fail(`requests beyond the dev server: ${offOrigin.map((r) => r.url).join(', ')}`);
  else ok(`${requests.filter((r) => !r.url.startsWith('data:')).length} requests, all to ${BASE}`);
  const loud = logEntries.filter((e) => e.level === 'error' || e.level === 'warning');
  if (loud.length) fail(`console errors/warnings: ${loud.map((e) => e.text).join(' | ')}`);
  else ok('no console error or warning (no CSP violation)');
  if (exceptions.length) fail(`uncaught exceptions: ${exceptions.map((e) => e.text).join(' | ')}`);
  else ok('no uncaught exception');
  results.hygiene = { requests, logEntries, exceptions };
  if (OUT) { await writeFile(OUT, JSON.stringify(results, null, 1)); log('results written to', OUT); }
  await t.close();
} catch (e) {
  fail(`gate aborted: ${e.message}`);
} finally {
  await cleanup();
}
console.log(failures.length ? `browser gate: ${failures.length} failure(s)` : 'browser gate: all checks passed');
process.exit(failures.length ? 1 : 0);
