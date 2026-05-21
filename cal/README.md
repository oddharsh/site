# cal — coffee booking worker

cloudflare worker that replaces cal.com for `/coffee/` on aadhar.sh.

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
| availability source | public/secret iCal URL (Google or iCloud), fetched + parsed each request, edge-cached 5 min |
| outbound email | Resend (free 3k/mo) |
| approve/decline auth | HMAC-SHA256 signed URLs |
| weekly cleanup | Workers Cron Triggers |

Everything on the Cloudflare free tier at personal volume.

## setup

### 1. dependencies

```sh
cd cal
npm install            # installs wrangler
```

### 2. create the KV namespace

```sh
npx wrangler kv namespace create CAL_BOOKINGS
# wrangler prints a `id = "…"` line — paste it into wrangler.toml's
# [[kv_namespaces]] block, replacing REPLACE_WITH_KV_NAMESPACE_ID
```

### 3. set secrets

```sh
# the public/secret iCal URL of your calendar (read-only).
#   google: settings → "integrate calendar" → "secret address in iCal format"
#   icloud: cal app → calendar settings → publish → public iCal URL
npx wrangler secret put ICAL_URL

# resend.com API key — sign up free, verify aadhar.sh domain via DKIM
npx wrangler secret put RESEND_API_KEY

# HMAC signing secret — generate fresh, never share
openssl rand -hex 32 | npx wrangler secret put SIGNING_SECRET
```

### 4. configure vars (in `wrangler.toml`, under `[vars]`)

defaults are sensible. tune working hours, slot length, limits if needed.
all times use IANA timezone names so DST is handled automatically.

### 5. set up Resend

1. sign up at [resend.com](https://resend.com) (free)
2. add domain `aadhar.sh`
3. add the DNS records Resend gives you (DKIM + SPF) to Cloudflare DNS
4. wait for verification (~5 min)
5. confirm you can send from `noreply@aadhar.sh` and `coffee@aadhar.sh`

### 6. deploy

```sh
npx wrangler deploy
```

then in the Cloudflare dashboard:
- Workers → `cal-aadhar-sh` → Triggers → add custom domain `cal.aadhar.sh`
- DNS for aadhar.sh → confirm a CNAME `cal` → `cal-aadhar-sh.<your-account>.workers.dev` was auto-added

### 7. swap the site's coffee link

once `cal.aadhar.sh` is live, update `site/coffee/index.html` to point at it
instead of `cal.com/aadharsh/coffee`:

```diff
- <a href="https://cal.com/aadharsh/coffee" rel="external">cal.com/aadharsh/coffee</a>
+ <a href="https://cal.aadhar.sh">cal.aadhar.sh</a>
```

then in cal.com, decommission the event type (or pause it) so requests don't
get split between the two systems.

## smoke test

after deploy:

1. visit `https://cal.aadhar.sh` — should show available slots
2. book a slot using a throwaway email
3. check your inbox at `coffee@aadhar.sh` — you should get an approval request with two big buttons
4. click "approve" — should land on the confirmed page, requester should get an .ics invite within seconds
5. accept the .ics invite in the requester's mail app — should create the event on their calendar
6. confirm the event appears on your calendar (since you should have hit Accept in your own copy of the invite too)

## known limitations / fix-later

- **ICS parser doesn't expand VTIMEZONE / RRULE fully** — recurring events
  across DST boundaries may drift by ~1h for the boundary instance. fine for
  most personal calendars. fix: use a real ICS lib (ical.js) if it matters.
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
