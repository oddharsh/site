# Coffee

Grab a coffee or a bagel in NYC. A small booking page: pick a slot, leave your
name and a note, and the request comes to me for a yes or no.

**This twin describes the booking process rather than mirroring the page,
because the open slots change.** They already ship as JSON, so read that rather
than scraping:

`https://aadhar.sh/coffee/availability.json`

## What availability answers

```json
{
  "available": true,
  "stale": false,
  "source": "live",
  "checkedAt": "2026-08-12T20:40:39.991Z",
  "ageSeconds": 0,
  "timezone": "America/New_York",
  "bookingUrl": "https://aadhar.sh/coffee",
  "slots": [ { "start": "...", "end": "..." } ]
}
```

`slots` carries ISO timestamps. `timezone` is the zone the slots were computed
in, and the page renders them in the visitor's own zone.

**Read `source` and `stale` before trusting `slots`.** Availability comes from a
private calendar feed through a last-good snapshot, so `source` says whether the
answer is `live`, a cached `fresh` copy, a `stale` one, or `none`.

## Booking is a request, not a reservation

Choosing a slot creates a PENDING booking and emails me. It is confirmed when I
approve it, and you get a calendar invite then. If I decline, you get a short
note back. A pending booking that I never answer expires on its own and releases
the slot.

So a successful POST means "asked", never "booked". It is a manual opt-in on my
side, and I will try to get back to you.

**Booking fails closed.** If the calendar snapshot is unavailable or older than
15 minutes, the page refuses the booking rather than write over an event it
cannot see. A 503 here means the calendar could not be read, which is the safe
answer rather than a broken one.

Email works too, and needs no slot: `coffee@aadhar.sh`.
