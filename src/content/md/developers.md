# Developers

Everything on aadhar.sh can be read from code. The endpoints are read-only,
need no key or signup, and production is the sandbox: there is nothing to
break.

- **OpenAPI 3.1**: <https://aadhar.sh/openapi.json>
- **MCP server**: <https://aadhar.sh/mcp> (card: <https://aadhar.sh/.well-known/mcp/server-card.json>)
- **API catalog**: <https://aadhar.sh/.well-known/api-catalog> (RFC 9727)
- **Site map for agents**: <https://aadhar.sh/llms.txt>
- **Authentication**: none

## Quickstart

Search the site, then read the page you found as Markdown:

```sh
curl 'https://aadhar.sh/search.json?q=fhe&limit=3'
curl -H 'Accept: text/markdown' https://aadhar.sh/lwe/fhe
```

Ask a question in plain language (NLWeb), as one JSON body:

```sh
curl 'https://aadhar.sh/ask?query=how+does+the+site+sign+requests&streaming=0'
```

See how a machine reads any public URL:

```sh
curl 'https://aadhar.sh/lens/fetch?url=example.com'
```

Find a Fuji film recipe in the photo archive:

```sh
curl 'https://aadhar.sh/photos/query.json?recipe=DR400&limit=5'
```

## Endpoints

- [/search.json](https://aadhar.sh/search.json?q=agents): lexical search over every public page.
- [/ask](https://aadhar.sh/ask?query=what+is+this+site&streaming=0): NLWeb natural-language search, ranked by a model, with extractive answers.
- [/photos/query.json](https://aadhar.sh/photos/query.json?limit=5) and [/images/manifest.json](https://aadhar.sh/images/manifest.json): the photo archive, its EXIF and recipes.
- [/lens/fetch](https://aadhar.sh/lens/fetch?url=example.com), [/lens/compare.json](https://aadhar.sh/lens/compare.json?left=example.com&right=aadhar.sh) and [/lens/census.json](https://aadhar.sh/lens/census.json): agent readiness for any URL, and a weekly census.
- [/rn/tracks](https://aadhar.sh/rn/tracks): the playlist playing right now.
- [/around/json](https://aadhar.sh/around/json) and [/around/changes.json](https://aadhar.sh/around/changes.json): a crawled neighborhood of venture firm homepages.
- [/coffee/availability.json](https://aadhar.sh/coffee/availability.json): open coffee slots in New York.
- [/ledger.json](https://aadhar.sh/ledger.json) and [/resume.json](https://aadhar.sh/resume.json): the AI-crawler ledger and a JSON Resume.

Every operation in [/openapi.json](https://aadhar.sh/openapi.json) has an
`operationId`, typed parameters and a response schema, so a client can turn it
into function-calling tools directly. The [MCP server](https://aadhar.sh/mcp)
exposes the same capabilities as tools.

## Limits

Lens inspections are limited to 30 a minute per caller, shared with the MCP
server, and comparisons to 4 a minute. Over the limit, those answer `429`.
`/ask` ranks 20 questions a minute per caller with its model, then falls back
to lexical ranking and says so in `_meta.ranking` instead of refusing. Please
cache what you read; most endpoints send a `Cache-Control` that says for how
long.

## Errors

Errors are JSON with at least an `error` sentence, and most add a `code`
token. A path that does not exist answers `404` in the format you ask for:
JSON for `Accept: application/json`, Markdown for `Accept: text/markdown`,
with the closest real pages.

```json
{
  "ok": false,
  "error": "/no-such-endpoint.json is not a page or endpoint on aadhar.sh.",
  "code": "not_found",
  "status": 404,
  "hint": "Every page is listed in /sitemap.xml, and every JSON endpoint in /openapi.json.",
  "docs": "https://aadhar.sh/developers"
}
```

## Pages as Markdown

Most pages answer `Accept: text/markdown` at their own URL, and static
documents also have a `.md` twin (`/garage/encoding` becomes
`/garage/encoding.md`). [/llms.txt](https://aadhar.sh/llms.txt) maps the site,
and [/llms-full.txt](https://aadhar.sh/llms-full.txt) inlines it.

## Questions

Write to coffee@aadhar.sh. How the site treats what you send is on
[/privacy](https://aadhar.sh/privacy).
