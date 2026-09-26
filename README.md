# calqrii

Calendar events as offline QR codes — a static page (German/English) that
runs entirely in your browser.

Pick days in a month grid, describe an event (single, multi-day, or a
recurring series), and get one QR code per event. The QR contains a complete
iCalendar (`VCALENDAR`/`VEVENT`) payload, so a phone camera recognizes it as
a calendar entry and offers "Add to calendar" — no server, no link, no app.

An experimental option puts all events into a single QR; most scanners
import only the first event from such a code, so it is marked as such.

## Privacy

Nothing is stored and nothing is sent anywhere: no server, no cookies, no
local storage. The only way to keep your events is the share link, which
carries them in the URL `#fragment` (browsers never send fragments in
requests). It is still an ordinary URL: in your history, and in clear text
wherever you paste it.

## Date rules

All-day events use `VALUE=DATE` with an exclusive end (the day after the last
day). Timed single events are written in UTC (`…Z`), converted from the time
zone your browser reports. Timed recurring events are written as floating
local time (no `Z`), so a weekly 07:00 stays 07:00 across daylight-saving
changes.

## Tested scanners

| Device / OS | Scanner | Single event | All-day | Series (RRULE) | Combined QR | Result |
|---|---|---|---|---|---|---|
| — | — | not yet tested | — | — | — | — |

## Development

Node ≥ 20, no dependencies.

```sh
npm test                                        # unit tests + web smoke gate
python3 -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/
```

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). The bundled QR encoder
`qrcodegen.js` is by Project Nayuki under the MIT License; see [NOTICE](NOTICE).
