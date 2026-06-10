# auth.md

Authentication at aadhar.sh: a short, honest map of the auth posture for agents
and humans. The short
version: the public agent surfaces need no credentials, and there is no OAuth
because there is no protected resource to gate.

## The Serendipity MCP server

`https://aadhar.sh/serendipity/mcp` is public, read-only, and unauthenticated.
Connect with any MCP client over the Streamable-HTTP transport and call its
tools. It serves only the data the website already shows in public, so no auth
is required and none is offered. See https://aadhar.sh/serendipity/mcp-info.

## Why there is no OAuth / OIDC

This site deliberately does not publish `oauth-authorization-server`,
`openid-configuration`, or `oauth-protected-resource` (RFC 9728) metadata. There
is no authorization server and no OAuth-protected resource here, so advertising
that machinery would be a dangling pointer: it would pass a scanner and then
break any agent that tried to use it. The same honesty rule keeps the `_a2a`
DNS-AID record unpublished, since there is no Agent2Agent server to answer it.

If a future endpoint here does require OAuth, this file and the matching
`/.well-known/` metadata will land together.

## Outbound: AadharshBot

The site's own crawler, AadharshBot, authenticates itself on outbound requests
using Web Bot Auth (RFC 9421 HTTP Message Signatures plus the IETF Web Bot Auth
draft). Its Ed25519 public keys are published as a JWKS at
`https://aadhar.sh/.well-known/http-message-signatures-directory`. Details:
https://aadhar.sh/bot.

## Contact

Questions about access: coffee@aadhar.sh.
