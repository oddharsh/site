// ── security.txt expires at least 60 days out ──────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// RFC 9116 makes Expires mandatory, and a lapsed file tells a reporter its
// contacts are stale. Until 2026-10-17 the file lived in Cloudflare's dashboard
// (Security Center), served at the edge, so nothing in this tree knew the date.
// Now it is public/.well-known/security.txt, and this test is the watch: it
// fails on every PR from 60 days before Expires, which leaves two months to
// bump one line. It reads the clock on purpose. A test that passes forever is
// exactly the failure it replaces.
//
// infra.json's security-txt-from-repo edge check is the other half: this pins
// what the repo ships, that one pins that the edge serves it.
const FILE = "public/.well-known/security.txt";
const DAY_MS = 86_400_000;
const LEAD_DAYS = 60;

function fields(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+?)\s*$/.exec(line);
    if (!m || line.startsWith("#")) continue;
    const key = m[1].toLowerCase();
    out.set(key, [...(out.get(key) || []), m[2]]);
  }
  return out;
}

const text = await readFile(new URL(FILE, ROOT), "utf8");
const f = fields(text);

test(`${FILE} Expires is at least ${LEAD_DAYS} days out and under a year`, () => {
  const expires = f.get("expires") || [];
  assert.equal(expires.length, 1, "RFC 9116 §2.5.5: Expires MUST appear exactly once");
  // §2.5.5 wants the Internet Date/Time Format (RFC 3339), which Date.parse reads.
  assert.match(expires[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
  const days = (Date.parse(expires[0]) - Date.now()) / DAY_MS;
  assert.ok(days >= LEAD_DAYS,
    `${FILE} expires ${expires[0]}, ${Math.floor(days)} day(s) from now. Bump Expires (keep it under a year out) and deploy`);
  // §2.5.5 recommends under a year, so a far-future date cannot stand in for
  // the review this test exists to force.
  assert.ok(days <= 366, `${FILE} expires ${expires[0]}, more than a year out; RFC 9116 recommends less`);
});

test(`${FILE} carries Contact, Canonical and Policy, and each resolves here`, async () => {
  const contact = f.get("contact") || [];
  assert.ok(contact.length >= 1, "RFC 9116 §2.5.3: at least one Contact is required");
  assert.deepEqual(f.get("canonical"), ["https://aadhar.sh/.well-known/security.txt"]);

  // The Policy anchor has to exist on the page, or the link lands on the top of
  // /contact with nothing saying where the policy is.
  const policy = f.get("policy") || [];
  assert.deepEqual(policy, ["https://aadhar.sh/contact#security"]);
  const trust = await readFile(new URL("src/worker/trust.ts", ROOT), "utf8");
  assert.match(trust, /<h2 id="security">/, "/contact lost the #security anchor that Policy names");

  // The CAA iodef record reports refused issuance to a mailbox. It should be
  // the one this file names, or a CA's report goes somewhere nobody reads.
  const infra = JSON.parse(await readFile(new URL("config/infra.json", ROOT), "utf8"));
  const caa = infra.dns.find((r) => r.type === "CAA");
  const iodef = caa?.expect.map((v) => /^\d+ iodef "(.+)"$/.exec(v)?.[1]).filter(Boolean);
  assert.deepEqual(iodef, [contact[0]], "infra.json's CAA iodef and security.txt's first Contact disagree");
});
