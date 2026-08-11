# Auth.md

Agent registration metadata for `aadhar.sh`.

This site exposes public resources and bounded utilities for agents. Image
processing is ephemeral, and the HTTP representation vault stores only
normalized observations and digests; it never stores raw uploads or page
bodies. Registration is
available for agents that want an explicit bearer credential and scope list, but
the credential does not unlock private account data: the current resources are
already public.

## Audience

Use this file if you are an agent or MCP client trying to understand how to
access public `aadhar.sh` resources, including:

- `https://aadhar.sh/serendipity/mcp`
- `https://aadhar.sh/mcp`
- `https://aadhar.sh/rn/tracks`
- `https://aadhar.sh/images/manifest.json`
- `https://aadhar.sh/around/json`
- `https://aadhar.sh/around/changes.json`
- `https://aadhar.sh/search.json?q=agents`
- `https://aadhar.sh/photos/query.json?q=car`
- `https://aadhar.sh/coffee/availability.json`

The site-level MCP also exposes ephemeral image inspection/transforms, exact
published-photo recipe matching, and representation capture/read/compare.

Every successful call to the site-level MCP returns a portable `_receipt` in
`structuredContent`. It records the responding origin and issue time, identifies
the MCP endpoint and tool, binds the request arguments and unreceipted result with
SHA-256 digests, and names the deployed Worker version. Production receipts are
signed with Ed25519; the receipt is returned to the caller and is not stored by
the server. Serendipity's separate MCP does not currently issue these receipts.

## Discovery

Fetch the OAuth Protected Resource Metadata:

```http
GET https://aadhar.sh/.well-known/oauth-protected-resource
```

Then fetch the advertised Authorization Server metadata:

```http
GET https://aadhar.sh/.well-known/oauth-authorization-server
```

The Authorization Server metadata includes an `agent_auth` block with the
registration URI, supported identity type, credential type, claim URI, and
revocation URI.

## Supported Registration Method

`aadhar.sh` currently supports anonymous agent registration only.

```http
POST https://aadhar.sh/agent/auth
Content-Type: application/json

{ "type": "anonymous" }
```

Successful responses issue a short-lived public bearer credential:

```json
{
  "registration_type": "anonymous",
  "credential_type": "bearer_token",
  "token_type": "Bearer",
  "scope": "public.read mcp.read rn.read photos.read around.read"
}
```

The bearer credential is optional for today's public endpoints and MCP tools. If you send it,
use the standard header form:

```http
Authorization: Bearer <access_token>
```

## Unsupported Methods

Identity assertion registration is not accepted yet. In particular, this site
does not currently accept ID-JAG or verified-email assertions for private user
delegation.

## Claim and Revocation

Anonymous public credentials do not require a human claim ceremony. The metadata
still publishes `claim_uri` so agents have a stable place to check that status:

```http
POST https://aadhar.sh/agent/auth/claim
```

Credential revocation is idempotent:

```http
POST https://aadhar.sh/oauth2/revoke
Content-Type: application/x-www-form-urlencoded

token=<access_token>&token_type_hint=access_token
```

Because the current public credentials are stateless and do not gate private
data, revocation returns success without revealing whether a token was known.

## Result Receipt Verification

The site-local receipt schema is published at:

```http
GET https://aadhar.sh/.well-known/result-receipt-v1.json
```

For a signed receipt, remove only `proof.signature`, canonicalize the remaining
object with RFC 8785, and verify the base64url signature. Accept only an Ed25519
key named under the site's canonical public key directory,
`https://aadhar.sh/.well-known/http-message-signatures-directory`; do not trust
an arbitrary key URL substituted by a receipt. The proof configuration itself
is signed, so changing its algorithm, key ID, status, or canonicalization label
invalidates the signature.

Recompute `provenance.requestDigest` over the JSON tool arguments and
`provenance.resultDigest` over `structuredContent` with `_receipt` removed. Both
use the lowercase `sha256:<hex>` form over RFC 8785 canonical JSON. Local
development has no signing secret by design and therefore emits an explicit
`proof.status: "unsigned"`; production configuration requires the signing key.

## Outbound: AadharshBot

The site's own crawler, AadharshBot, authenticates itself on outbound requests
using Web Bot Auth (RFC 9421 HTTP Message Signatures plus the IETF Web Bot Auth
draft). Its Ed25519 public keys are published as a JWKS at
`https://aadhar.sh/.well-known/http-message-signatures-directory`. Details:
https://aadhar.sh/bot.

## Contact

Questions about access: coffee@aadhar.sh.
