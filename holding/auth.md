# Auth.md

Agent registration metadata for `aadhar.sh`.

This site exposes public, read-only resources for agents. Registration is
available for agents that want an explicit bearer credential and scope list, but
the credential does not unlock private account data: the current resources are
already public.

## Audience

Use this file if you are an agent or MCP client trying to understand how to
access public `aadhar.sh` resources, including:

- `https://aadhar.sh/serendipity/mcp`
- `https://aadhar.sh/rn/tracks`
- `https://aadhar.sh/images/manifest.json`
- `https://aadhar.sh/around/json`
- `https://aadhar.sh/around/changes.json`

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

The bearer credential is optional for today's public endpoints. If you send it,
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

## Outbound: AadharshBot

The site's own crawler, AadharshBot, authenticates itself on outbound requests
using Web Bot Auth (RFC 9421 HTTP Message Signatures plus the IETF Web Bot Auth
draft). Its Ed25519 public keys are published as a JWKS at
`https://aadhar.sh/.well-known/http-message-signatures-directory`. Details:
https://aadhar.sh/bot.

## Contact

Questions about access: coffee@aadhar.sh.
