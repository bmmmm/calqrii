# calqrii — agent instructions

Static page that turns calendar events into offline QR codes (iCalendar
payload, scanned straight into the phone's calendar) or into link codes that
open a read-only view of the events on this page. No build, no framework,
no runtime dependency; the only state that leaves the page is a `#fragment`
share link.

## Commands

```sh
npm test                                        # every test/*.test.mjs + scripts/web-smoke.mjs
node test/ics.test.mjs                          # one suite
python3 -m http.server 8765 --bind 127.0.0.1    # dev server (open http://127.0.0.1:8765/)
```

Node ≥ 20, nothing to install. `package.json` exists only for `"type": "module"`
and the test script.

## Map

- `index.html` · `style.css` · `app.js` (UI, ES module: editor screen and
  the read-only view for opened links) — the page.
- `calendar.js` — month grid (`monthGrid`, `renderMonth`), DOM via `createElement` only.
- `model.js` — event model, normalization, validation, `expandDraft`; pure
  helpers behind the duration select and the repeat presets.
- `ics.js` — RFC 5545 serializer: escaping, 75-octet folding, UTC/floating
  dates, RRULE, content-hashed UID.
- `fragment.js` — share-link codec `#v=1&tz=…&e=<base64url(JSON)>`; `linkFor`
  builds a share link or a link-mode QR text from a page base.
- `qr.js` — ECC policy, SVG path, PNG matrix; reads `globalThis.qrcodegen` lazily.
- `i18n.js` — `STR.en` / `STR.de`, key parity pinned by test.
- `qrcodegen.js` — Project Nayuki, vendored verbatim (sha256 in `NOTICE`).
- `test/*.test.mjs` — plain `node` + `node:assert/strict`; `test/helpers/load-qrcodegen.mjs`
  evaluates the classic script into `globalThis`; `test/page.test.mjs` pins
  the option lists in `index.html` against the model's constants.
- `scripts/web-smoke.mjs` — zero-storage / CSP / relative-asset gate over the
  shipped files; `.github/workflows/pages.yml` runs tests + smoke, then deploys.

Module graph: `app.js → calendar.js, ics.js, fragment.js, qr.js, i18n.js`;
`ics.js`, `fragment.js → model.js`. All imports static and relative (`./x.js`).

## Traps

- **Fixtures are the specification.** The pinned ICS strings, byte counts,
  UIDs, QR versions, masks and dark-module counts in `test/` were computed
  against this exact algorithm and the vendored library. If an implementation
  change makes one differ, find the cause (property order, escaping, folding)
  — never re-pin blindly.
- `qrcodegen.js` stays byte-identical to the hash in `NOTICE` (check with
  `shasum -a 256 qrcodegen.js`; no gate enforces it yet). The oracle test in
  `test/qr.test.mjs` proves the encoder still produces the pinned symbol.
- **Zero storage.** Never add storage APIs, network calls, writes to the
  address bar/history, HTML string sinks or external resources — the smoke
  gate greps for them and the meta CSP pins the rest.
- The smoke gate's §7 reads whole function bodies (`bodyOf` skips the
  parameter list) and demands an anchor per gated function; keep `.value`
  (also Intl's `formatToParts().value`), `$(` and `readEditor` out of
  `pageBase`, `shareURL`, `eventLink`, `renderQrPanel`, `renderList`,
  `renderCombined` and `renderView`. Every i18n key named by `index.html` or
  `app.js` must exist in `STR.en` (§9).
- In JS literals `'\;'` is just `;`. Escaping code and fixtures need the
  backslash doubled (`'\\;'`) or `String.raw`.
- The VEVENT property order feeds the UID hash; reordering changes every UID.
- Timed recurring events are serialized floating (no `Z`); single timed
  events in UTC. Changing that changes what scanners import across DST.

## Definition of done

1. `npm test` green (run it — don't assume).
2. Every new or changed check has been shown able to fail: one mutation per
   check, counted from the source, then reverted.
3. Browser run green: `BarcodeDetector` decode of every rendered QR, no CSP
   violations, no network beyond the shipped files. No script for it lives
   in the repo yet; the initial build drove headless Chrome over the DevTools
   protocol (see README "Tested scanners").
4. README "Tested scanners" table maintained when a device test happened.
