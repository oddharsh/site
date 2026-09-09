# cal — coffee booking module

The root site Worker serves this module at `/coffee`. Production bindings and
booking policy live in [wrangler.jsonc](../wrangler.jsonc).

## Booking flow

- `GET /coffee` renders slots from the host's iCal feed and existing booking holds.
  The page caches for 30 seconds; `/coffee/slots` reads availability on each request.
- `POST /coffee/book` requires a calendar snapshot no older than 15 minutes.
  A per-slot Durable Object claims the slot before its KV hold and approval email
  are created. Booking IDs remain 32 hexadecimal characters.
- Signed approve/decline links let the host decide. Approval sends an ICS invite;
  decline releases the hold and the Durable Object claim.
- Signed `/coffee/location` links let the host choose or update the venue.
  Confirmed bookings send an updated invite with an incremented sequence number.
- Each pending booking gets a `BookingWorkflow` expiry timer. After
  `PENDING_TTL_DAYS`, it releases the slot only if the booking is still pending.

`src/slots.ts` owns the slot calculation and public availability payload shared
by the JSON endpoint, terminal, and MCP tool. The Durable Object claim and KV
holds have separate jobs: exclusivity and availability listings, respectively.

## Development

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run --filter cal-aadhar-sh test
```

The suite runs route code in Bun and uses `wrangler.test.toml` for real local
KV and Workflow bindings. [test/harness.ts](test/harness.ts) explains that split;
[test/preload.ts](test/preload.ts) supplies the host shims. The cache shim always
misses, so these tests do not exercise the booking page's edge-cache hit path.

## Operations

`ICAL_URL`, `RESEND_API_KEY`, and `SIGNING_SECRET` belong to the root Worker.
Resend must verify the sending domain and allow the configured `HOST_EMAIL`.
Use the [secret rotation runbook](../docs/MAINTENANCE.md#rotate-cals-calendar-or-approval-secret)
for calendar changes, signing-key rotation, and the optional work-calendar redirect.
Use the [site release path](../docs/MAINTENANCE.md#cicd-release-path) to deploy.

After a deliberate booking smoke test, verify the host approval email, requester
invite, and calendar entry. The local suite intercepts email; it cannot establish
that Resend delivered a message or a calendar client accepted it.

## Limits

The ICS parser expands supported recurrence rules up to 120 days. Recurrences
step in UTC, so occurrences across a daylight-saving transition can be an hour
off. Unsupported recurrence shapes keep only their base occurrence; `VTIMEZONE`
blocks are not expanded. See [src/availability.ts](src/availability.ts).

Rescheduling requires contacting the host. Requester email addresses are checked
for syntax, but ownership is not verified. Slots display in the host timezone.
