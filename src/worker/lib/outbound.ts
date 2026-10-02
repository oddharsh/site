// lib/outbound.ts: one read of somebody's URL, as AadharshBot or as a named
// unsigned probe.
//
// "Read this URL" used to be composed again at each call site: is the target
// this origin, and if so SELF_FETCH or ASSETS; otherwise walk redirects one hop
// at a time, validate each hop, ask robots.txt, sign for that hop's authority.
// Five readers each wrote that out (lens.ts twice, lib/doors.ts twice,
// cache-lint.ts), and a sixth restated only the predicate. This module is the
// one copy. Its interface is the request a caller wants made plus two choices
// it has to state out loud, `identity` and `maxHops`. Neither has a default.
//
// TWO ADAPTERS SIT BEHIND THE SEAM, and a test supplies a third:
//
//   self      this origin, dispatched in-process through env.SELF_FETCH (the
//             enhanced response) or env.ASSETS (the static fallback). Over the
//             network that request loops back into this Worker and Cloudflare
//             refuses it. Never signed, since nothing leaves the isolate; never
//             robots-gated, since the policy is our own; never redirect-walked.
//             A binding failure PROPAGATES. It is never authorization for an
//             unsigned network read.
//   network   everything else: fetchFollowingPublicRedirects over the global
//             fetch, validateLensTarget on every hop BEFORE the request, then
//             the identity's gate for that hop.
//   injected  env.OUTBOUND_TRANSPORT replaces the global fetch on the network
//             adapter and on the robots bootstrap (lib/botauth.ts). Nothing in
//             the Worker sets it. Validation, robots and signing still run in
//             front of it, so a fake network tests the policy, never around it.
//
// A REFUSAL IS A VALUE. A hop the URL policy rejects, a redirect chain past
// `maxHops`, and a robots.txt that says no each come back as `{ ok: false,
// reason, error }`, and the caller decides how its own surface says so. A
// FAULT still throws: no signing key, a dead binding, a network error, the
// deadline's TimeoutError, the platform's subrequest limit. Those are facts
// about the instrument, and callers already separate them from facts about
// the target.
//
// What is deliberately NOT here, because each differs per caller on purpose:
//   - the deadline. Callers build their own AbortSignal.timeout and pass it.
//   - the body cap. Callers read the response with their own ceiling.
//   - signedFetch (lib/botauth.ts), the network-only signed reader with
//     explicit redirect modes, and RN's `robots: "spotify-embed"` exception,
//     which stays an argument at RN's own call site.
//   - the robots bootstrap read itself (3s, 512 KiB, public redirects only).
//   - readers that never were AadharshBot: the image tools, the representation
//     vault's non-bot profiles, webmention verification, the cover proxy and
//     the lens-reader Worker call the redirect walker with their own policy.
import { botHeaders, botRequestHeaders, botRobotsPolicy, BotPolicyError } from "./botauth.ts";
import { CANONICAL_HOST } from "./const.ts";
import { fetchFollowingPublicRedirects, validateLensTarget } from "./public-fetch.ts";

// Who the request says it is. There is no default, so every call site names it.
//
//   aadharshbot     our User-Agent, a Web Bot Auth signature over each hop's
//                   own authority, and the robots gate (botRequestHeaders).
//                   `postQuantum: false` drops sig2 for a fan-out probe and
//                   leaves sig1 as it was; botauth.ts has the measurement.
//   unsigned-probe  the caller's headers verbatim, including whatever
//                   User-Agent it chose, and NO signature. /lens bot views use
//                   it to ask what a named crawler token receives. It still
//                   obeys AadharshBot's robots opt-out, because a diagnostic
//                   identity cannot be a back door around our own.
export type OutboundIdentity =
  | { as: "aadharshbot"; postQuantum?: boolean }
  | { as: "unsigned-probe" };

export type OutboundRequest = {
  method: "GET" | "POST";
  headers: HeadersInit;
  body?: string;
  signal?: AbortSignal;
  identity: OutboundIdentity;
  // Redirect hops allowed on the network adapter. 4 for a probe of a URL a
  // visitor typed; 20 where a reader keeps native fetch's allowance.
  maxHops: number;
};

export type OutboundRefusal =
  // validateLensTarget rejected hop `hop` (0 is the URL as given), the Location
  // did not parse, or the chain ran past maxHops. The request to `url` was
  // never made.
  | { ok: false; reason: "url-policy"; error: string; hop: number; url: string }
  // robots.txt disallows AadharshBot, or the policy could not be determined.
  // `cause` is the BotPolicyError a throwing caller would have seen.
  | { ok: false; reason: "robots"; error: string; cause: BotPolicyError };

export type OutboundRead =
  | { ok: true; via: "self" | "network"; response: Response; finalUrl: string; hops: number }
  | OutboundRefusal;

// The self adapter, or null when this env has no way to dispatch in-process.
// SELF_FETCH is route() itself; ASSETS is the pre-enhancement static tree.
export function selfAdapter(env): ((request: Request) => Promise<Response>) | null {
  if (env?.SELF_FETCH) return (request) => env.SELF_FETCH(request);
  if (env?.ASSETS) return (request) => env.ASSETS.fetch(request);
  return null;
}

// Does a read of this hostname stay in-process? True only for the canonical
// host AND an env that can dispatch, so a caller budgeting network work (the
// discovery board in lens.ts) and the reader below cannot disagree.
export function dispatchesToSelf(hostname, env): boolean {
  return String(hostname || "").toLowerCase() === CANONICAL_HOST && !!(env?.SELF_FETCH || env?.ASSETS);
}

export async function outboundRead(url: string, env, request: OutboundRequest): Promise<OutboundRead> {
  env = env || {};
  const { method, headers, body, signal, identity } = request;
  const withBody = body === undefined ? {} : { body };

  // An unparseable URL is not ours. It falls through to the network adapter,
  // whose hop-0 check refuses it as a value before any request.
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { /* not self */ }

  const self = dispatchesToSelf(hostname, env) ? selfAdapter(env) : null;
  if (self) {
    const selfHeaders = identity.as === "aadharshbot"
      ? await botHeaders(url, env, { headers, sign: false })
      : headers;
    const response = await self(new Request(url, { method, headers: selfHeaders, ...withBody }));
    return { ok: true, via: "self", response, finalUrl: url, hops: 0 };
  }

  let followed;
  try {
    followed = await fetchFollowingPublicRedirects(
      url,
      async (candidate) => {
        let hopHeaders = headers;
        if (identity.as === "aadharshbot") {
          // Signs first, so a missing key fails before any network activity,
          // then asks robots.txt for this hop's origin.
          hopHeaders = await botRequestHeaders(candidate, env, { headers, method, signal, postQuantum: identity.postQuantum });
        } else {
          const policy = await botRobotsPolicy(candidate, env, signal);
          if (!policy.ok) throw new BotPolicyError(policy);
        }
        return { method, headers: hopHeaders, ...withBody, signal, cf: { cacheTtl: 0 } };
      },
      (candidate) => validateLensTarget(candidate),
      request.maxHops,
      env.OUTBOUND_TRANSPORT,
    );
  } catch (error) {
    if (error instanceof BotPolicyError) return { ok: false, reason: "robots", error: error.message, cause: error };
    throw error;
  }
  if (!followed.ok) return { ok: false, reason: "url-policy", error: followed.error, hop: followed.blockedHop, url: followed.url };
  return { ok: true, via: "network", response: followed.response, finalUrl: followed.finalUrl, hops: followed.hops };
}
