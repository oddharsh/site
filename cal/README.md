# cal — coffee booking module

Cloudflare Worker module that replaces cal.com for `/coffee/` on aadhar.sh.
The root `aadhar-sh` Worker dispatches this module; there is no separate Cal
deployment target.

## what it does

1. `GET /` renders a static booking page with the next ~14 days of free slots, computed from a public iCal feed of the host's real calendar
2. `POST /book` creates a pending booking in KV and emails the host with one-click signed approve/decline links
3. `GET /approve?t=…&sig=…` confirms the booking and emails the requester an .ics calendar invite
4. `GET /decline?t=…&sig=…` rejects the booking with a polite auto-reply
5. cron sweeps expired pending bookings weekly

## stack

| concern | how |
|---|---|
| public page + routing | Cloudflare Workers |
| pending booking store | Cloudflare KV |
| availability source | public/secret iCal URL (Google/iCloud), parsed into an SWR snapshot in KV (`cal:busy`): 5-min freshness, 2s upstream deadline, stale fallback so a slow/down feed never gates the page. Booking fails closed if the calendar can't be vouched for |
| GET page cache | edge-cached 30s (caches.default), invalidated on book/approve/decline; live `/slots` JSON stays uncached |
| outbound email | Resend (free 3k/mo) |
| approve/decline auth | HMAC-SHA256 signed URLs |
| weekly cleanup | Workers Cron Triggers |

Everything on the Cloudflare free tier at personal volume.

## development and configuration

Install from the repository root and run the module's suite:

```sh
bun install
bun run --filter cal-aadhar-sh test
```

`wrangler.test.toml` is a test-only fixture: `bun test` boots it through
wrangler's `createTestHarness` for the KV and Workflow bindings (see
`test/harness.ts`) while the route code runs in bun itself. Production bindings
and vars live in the root `wrangler.jsonc`; tune them there if the booking
policy changes. All times use IANA timezone names so DST is handled
automatically.

### production secrets

Set these on the root Worker (from the repository root):

```sh
# the public/secret iCal URL of your calendar (read-only)
bun run wrangler versions secret put -c wrangler.jsonc ICAL_URL

# resend.com API key — verify aadhar.sh via DKIM first
bun run wrangler versions secret put -c wrangler.jsonc RESEND_API_KEY

# HMAC signing secret — generate once and keep it stable
openssl rand -hex 32 | bun run wrangler versions secret put -c wrangler.jsonc SIGNING_SECRET
```

Set up Resend as usual: add `aadhar.sh`, publish its DKIM/SPF records in
Cloudflare DNS, and confirm `coffee@aadhar.sh` can send.

1. sign up at [resend.com](https://resend.com) (free)
2. add domain `aadhar.sh`
3. add the DNS records Resend gives you (DKIM + SPF) to Cloudflare DNS
4. wait for verification (~5 min)
5. confirm you can send from `noreply@aadhar.sh` and `coffee@aadhar.sh`

Production ships through merge → CI → `production` → Workers Builds. The root
config owns both `aadhar.sh/coffee*` and the legacy `cal.aadhar.sh/*` alias after
the route migration. Do not deploy from this package.

### Change or rotate production secrets

Run these commands from the repository root. They update secrets on the live
`aadhar-sh` Worker; they do not create a GitHub diff or require a code deploy.

`ICAL_URL` is the private read-only availability feed. It is not the same as
the optional unlisted work-calendar redirect (`WORK_CALENDAR_URL`):

```sh
# Google Calendar: create a new "secret address in iCal format" first.
bun run wrangler versions secret put -c wrangler.jsonc ICAL_URL
```

The calendar snapshot is normally freshened within five minutes. For an
immediate refresh, delete only the derived snapshot and check the live JSON:

```sh
BOOKINGS_NS="37acb65118fe485583a90a94cb89365e"
bun run wrangler kv key delete --namespace-id="$BOOKINGS_NS" "cal:busy" --remote
curl -fsS https://aadhar.sh/coffee/slots | jq .
```

To rotate the unlisted redirect, set its destination before its path segment:

```sh
bun run wrangler versions secret put -c wrangler.jsonc WORK_CALENDAR_URL
bun run wrangler versions secret put -c wrangler.jsonc WORK_CALENDAR_SLUG
curl -fsSI "https://cal.aadhar.sh/<new-slug>"
```

The destination must be an `https://calendar.app.google/...` URL. The old slug
should return `404` after the new slug is active; neither value belongs in
Git.

The random HMAC value is `SIGNING_SECRET`:

```sh
openssl rand -hex 32 | bun run wrangler versions secret put -c wrangler.jsonc SIGNING_SECRET
```

Rotating it invalidates all outstanding approval and decline links but does not
delete pending bookings. Handle those requests manually or let them expire
after `PENDING_TTL_DAYS`.

The public site link should point at the canonical path:

```diff
- <a href="https://cal.com/aadharsh/coffee" rel="external">cal.com/aadharsh/coffee</a>
+ <a href="https://aadhar.sh/coffee">aadhar.sh/coffee</a>
```

then in cal.com, decommission the event type (or pause it) so requests don't
get split between the two systems.

## smoke test

after the consolidated Worker deploy:

1. visit `https://aadhar.sh/coffee` — should show available slots
2. book a slot using a throwaway email
3. check your inbox at `coffee@aadhar.sh` — you should get an approval request with two big buttons
4. click "approve" — should land on the confirmed page, requester should get an .ics invite within seconds
5. accept the .ics invite in the requester's mail app — should create the event on their calendar
6. confirm the event appears on your calendar (since you should have hit Accept in your own copy of the invite too)

## known limitations / fix-later

- **ICS parser expands RRULE but not VTIMEZONE** — recurring events
  (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/COUNT/UNTIL/BYDAY, plus EXDATE)
  are expanded out to 120 days so a standing weekly meeting blocks every week, not
  just its first. Occurrences step in whole UTC days, so one that crosses a DST
  boundary can land ~1h off past the shift; that errs toward over-blocking (safe).
  An RRULE shape the parser can't read keeps the base occurrence rather than
  dropping the event. fix for the DST edge: a real ICS lib (ical.js) if it matters.
- **No reschedule flow** — booker has to email manually if they need to
  change. could add a `/reschedule` endpoint later.
- **No double-booking protection across rapid concurrent requests** — KV
  index is eventually consistent. at personal volume the race window is
  microscopic; upgrade to Durable Objects if it becomes real.
- **No verification of requester email** — anyone can put any address.
  worst case: bot bookings get auto-declined manually. mitigation: require
  email verification before /book accepts (TODO).
- **No timezone selection on the booking page** — slots displayed in host
  tz. visitor has to do mental math. could add a tz picker in v2.

each of these has a clear path to resolution; none of them are blocking for
v1. see `/lwe/booking/` on the site for the full project log.
