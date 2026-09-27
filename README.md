# calqrii

Calendar events as offline QR codes — a static page (German/English) that
runs entirely in your browser.

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

An option puts all events into a single code. As calendar data it is
experimental: scanner libraries such as ZXing read only the first event from
such a code, and phone cameras are untested. As a link it carries every event
(up to the 2 953-byte limit, about eight typical events).

## Privacy

Nothing is stored and nothing is sent anywhere: no server, no cookies, no
local storage. The only way to keep your events is the share link, which
carries them in the URL `#fragment` (browsers never send fragments in
requests). It is still an ordinary URL: in your history, and in clear text
wherever you paste it.

A link QR code is such a share link. The page that generates it sends
nothing; the phone that scans it requests this page from its host (for the
public copy, GitHub Pages sees an ordinary page request and the IP address,
never the events, which stay in the fragment and are decoded on the phone).
In the view the tab title — and so the history entry — shows the first
event's title.

## Date rules

All-day events use `VALUE=DATE` with an exclusive end (the day after the last
day). Timed single events are written in UTC (`…Z`), converted from the time
zone your browser reports (a shared link carries the zone it was made in).
Timed recurring events are written as floating
local time (no `Z`), so a weekly 07:00 stays 07:00 across daylight-saving
changes.

## Tested scanners

During the initial build (2026-09-27) a one-off headless-Chrome run (Chrome
153, macOS) decoded 16 rendered codes, including a 2 342-byte combined one,
back byte for byte with `BarcodeDetector`. That run is not part of the test
suite. What a phone's camera app does with the calendar payload is a device
question and is recorded here as it gets tested:

| Device / OS | Scanner | Single event | All-day | Series (RRULE) | Combined QR | Link QR → view | View: Add to calendar | Result |
|---|---|---|---|---|---|---|---|---|
| — | — | not yet tested | — | — | — | — | — | — |

## Development

Node ≥ 20, no dependencies.

```sh
npm test                                        # unit tests + web smoke gate
python3 -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/
```

The pinned fixtures in `test/` (ICS bytes, UIDs, QR versions, masks) are the
specification; see `AGENTS.md` before changing the serializer.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). The bundled QR encoder
`qrcodegen.js` is by Project Nayuki under the MIT License; see [NOTICE](NOTICE).
