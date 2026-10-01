# calqrii

Calendar events as offline QR codes — a static page (German/English) that
runs in your browser (the optional address search is its only network
request).

Pick days in a month grid, describe an event (single, multi-day, or a
recurring series), and get one QR code per event. Each code carries one of
two payloads, chosen above the event list:

- **Calendar data** (default): the complete iCalendar (`VCALENDAR`/`VEVENT`)
  payload. A phone camera recognizes it as a calendar entry and offers "Add
  to calendar" — no server, no app, nothing to download, works offline.
- **Link to this page**: this page's URL with the event in its `#fragment`.
  Every camera app opens a URL; the scanning phone must be able to reach the
  page wherever it is hosted. It opens a read-only view of the event with
  "Add to calendar" (an `.ics` file), "Show QR" (the offline code, to pass
  on) and "Edit these events". A copied share link opens the same view.

A map position — a pasted OpenStreetMap, Google Maps or Apple Maps link, a
`geo:` URI, or plain "lat, lon" — becomes a `GEO` property in the calendar
data plus Apple's `X-APPLE-STRUCTURED-LOCATION` (what iOS and macOS Calendar
read for the map pin; reported by library authors, not yet confirmed on a
device here), and a "Map" link on the event. A position without a location
text gets its coordinates as the location text, so every calendar shows
something. "Search on OpenStreetMap" opens the
location text on openstreetmap.org to find it, and "Search address
(OpenStreetMap)" looks it up from the page (opt-in, see Privacy) and fills in
both the address and the position.

Every code asks for error-correction level L: at a given display size fewer,
larger modules read more reliably than extra redundancy (measured with
`BarcodeDetector` on 2026-10-01: L decoded at smaller sizes than M for 13 of
15 codes), and the encoder raises the level for free whenever the chosen
version has room.

An option puts all events into a single code. As calendar data it is
experimental: scanner libraries such as ZXing read only the first event from
such a code, and phone cameras are untested. As a link it carries every event
(up to the 2 953-byte limit, about eight typical events).

## Import (extra)

`import.html` turns an existing event list into calqrii links without typing:
choose a calendar file (`.ics` — what most club sites, Google Calendar,
Outlook and Nextcloud export) or paste the copied text of any event list (a
"Termine" page, a newsletter). Every line with a date becomes an event
(`05.10.2026 19:00 Grillfest`, `17.–18.10.2026 Hüttenwochenende`,
`12. Oktober 2026, 18.30 – 21 Uhr: Vortrag`, `October 3, 2026 7pm Party`);
lines without a date are the title, the location (`Ort:`/`Location:`) or
the description of the event above them. Tick the events you want — upcoming
ones are preselected, past ones hidden behind a toggle — and **Open in
calqrii** lands in the read-only view of the main page with QR codes, `.ics`
downloads, "Edit these events" and the share link; **Copy link** copies the
same link. Imported series are written as floating local time, like every
series here: a rule the editor cannot express (ordinal weekdays,
`BYMONTHDAY`, a start that moves to another day in your zone, …) is dropped
with a note rather than approximated; a series given in another zone or in
UTC keeps its rule but gets a note (after a daylight-saving change its times
can be an hour off) — unless that zone keeps your zone's offsets in the years the series runs
(up to next year, at most eleven); skipped, added or moved dates (`EXDATE`, `RDATE`,
`RECURRENCE-ID`) are not imported, with a note on the series; a series with
a `COUNT` above 999 or an interval above 99 is imported as a single event
with a note, and so is a rule with both `COUNT` and `UNTIL`. Windows zone
names from Outlook exports are mapped to IANA zones (Unicode CLDR table in
`tzmap.js`), `tzone://Microsoft/Utc` is read as UTC; only the display form `(UTC+01:00) …` and unknown names keep the
time as written, with a note. The page never uses the network (`connect-src
'none'`): the file and the text stay in the browser, the link carries the
chosen events in its `#fragment` — and, once opened, in the browser history.

## Privacy

Nothing is stored: no cookies, no local storage, no server of its own.
Nothing is sent anywhere either, with one opt-in exception: the **Search
address (OpenStreetMap)** button. The first time you press it on a visit the
page asks; if you continue, the text of the Location field (plus the page
language) goes to `nominatim.openstreetmap.org`, run by the OpenStreetMap
Foundation ([usage policy](https://operations.osmfoundation.org/policies/nominatim/),
[privacy policy](https://osmfoundation.org/wiki/Privacy_Policy)), which sees
your IP address and this page's address as referrer — never your events.
Results live in memory until you reload; the page never searches while you
type. The meta CSP allows exactly this one host in `connect-src`.

The only way to keep your events is the share link, which carries them in the
URL `#fragment` (browsers never send fragments in requests). It is still an
ordinary URL: in your history, and in clear text wherever you paste it. Since
2026-10-01 the fragment is compressed (`v=2`, deflate), which makes link QR
codes one to four versions smaller; older `v=1` links keep opening, and a
browser without `CompressionStream` (Safari before 16.4) writes `v=1` links
and says so when it meets a `v=2` one.

A link QR code is such a share link. The page that generates it sends
nothing; the phone that scans it requests this page from its host (for the
public copy, GitHub Pages sees an ordinary page request and the IP address,
never the events, which stay in the fragment and are decoded on the phone).
In the view the tab title — and so the history entry — shows the first
event's title. The "Search on OpenStreetMap" and "Map" links are ordinary
links: they open openstreetmap.org in a new tab with the location text or the
coordinates in the address, without a referrer, and only when you follow
them.

## Date rules

All-day events use `VALUE=DATE` with an exclusive end (the day after the last
day). Timed single events are written in UTC (`…Z`), converted from the time
zone your browser reports (a shared link carries the zone it was made in).
Timed recurring events are written as floating
local time (no `Z`), so a weekly 07:00 stays 07:00 across daylight-saving
changes. The `UID` is a hash of the event's content, so scanning the same
code twice updates rather than duplicates; on 2026-10-01 `INTERVAL=1` left
the `RRULE` line, which gave every recurring event a new UID once.

## Tested scanners

`npm run gate:browser` drives headless Chrome (macOS, where `BarcodeDetector`
is backed by Apple's Vision framework) over the page and decodes every
rendered code back byte for byte — the fixtures plus an event with emoji,
curly quotes and escaped characters, as calendar data and as links, single
and combined (last run 2026-10-01: 12 codes, 165–1 600 bytes, all exact).
What a phone's camera app does with the calendar payload is a device
question and is recorded here as it gets tested:

| Device / OS | Scanner | Single event | All-day | Series (RRULE) | Combined QR | Link QR → view | View: Add to calendar | Result |
|---|---|---|---|---|---|---|---|---|
| — | — | not yet tested | — | — | — | — | — | — |

## Development

Node ≥ 22, no dependencies.

```sh
npm test                                        # unit tests + web smoke gate
npm run gate:browser                            # headless Chrome: decode every rendered code (needs Chrome, Node ≥ 22)
python3 -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/
```

The pinned fixtures in `test/` (ICS bytes, UIDs, QR versions, masks) are the
specification; see `AGENTS.md` before changing the serializer.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). The bundled QR encoder
`qrcodegen.js` is by Project Nayuki under the MIT License, and the Windows
time-zone table `tzmap.js` is derived from Unicode CLDR data (Unicode License
v3); see [NOTICE](NOTICE).
