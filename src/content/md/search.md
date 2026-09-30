# Search aadhar.sh

Search the public pages, writing, garage notes and utility descriptions. The
page itself is a blank search form, so this twin says how to ask it a question
directly.

## Four doors, one ranking

- `https://aadhar.sh/search?q=<query>` is the form's own result page, in HTML.
- `https://aadhar.sh/search.json?q=<query>&limit=<n>` returns the same results
  as JSON: `{ query, total, returned, results }`, where each result carries
  `url`, `title`, `description`, `kind` and a `snippet`. `limit` defaults to 20
  and tops out at 50.
- `https://aadhar.sh/ask?query=<question>&streaming=0` answers a
  natural-language question in NLWeb's shape: a `url`, `name`, `score` (0 to
  100), `description` and a schema.org `schema_object` per match. Leave out
  `streaming=0` and it answers as an event stream, which is NLWeb's default.
- Over MCP at `https://aadhar.sh/mcp`, `search_site` takes `q` and `limit`, and
  `ask` takes a `query`.

All four rank the same corpus, `https://aadhar.sh/search-index.json`, which the
build writes from every public page. Retrieval is lexical: one distinctive word
usually beats a sentence, and nothing here writes an answer, so what comes back
is the passages that match.
