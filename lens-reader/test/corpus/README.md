# Real-world parity corpus

Ten pages captured from the open web on 2026-08-23, stored Brotli'd
(3.69 MiB raw, 435 KiB compressed) and read by `test/dom-differential.test.mjs`
through `node:zlib`.

They exist because the repository's own 38 documents are one author's HTML and
agree with each other trivially. Every parity bug that survived the authored
corpus was caught here, and each capture is doing a specific job:

| capture | what it caught |
|---|---|
| `mdn` | SVG empty elements self-close (`<path />`), and `<title>` serializes raw |
| `nytimes` | the `class` attribute is a token set, so its value is trimmed, collapsed and deduplicated |
| `stripe` | `setAttributeNode` on an existing name removes and PREPENDS, where `setAttribute` updates in place |
| `wikipedia` | the same ordering rule, through Readability's `_hasSingleTagInsideElement` path |
| `github` | a trailing space inside `class` |
| `heroicons` | 329 inline `<svg>` elements, 172 KiB of SVG: the stress test for childless-SVG self-closing |
| `mdn-svg` | an SVG reference article, so the same rules run through the payload path and not only the tree |
| `danluu`, `hn`, `rustblog` | plain article pages that must not regress |

One SVG rule is deliberately NOT guarded here, and the reason generalises.
`tagName` on an SVG element is uppercased inside an HTML document, which the
first version of `src/dom.ts` got wrong. No capture can catch it: serialization
reads `localName`, and Readability only compares `tagName` against HTML names.
Reverting the fix passes all 48 documents and both byte-for-byte gates. The
control that does catch it is the direct oracle assertion at the end of
`dom-differential.test.mjs`. Before trusting a capture to guard a property, break
the property and check the capture goes red.

They are FROZEN fixtures rather than live fetches on purpose. A parity gate that
reaches the network is not a gate: it goes red when somebody else deploys, and it
cannot run in CI or offline.

To add one, keeping the capture identical to what the Reader lens would fetch:

```bash
curl -sSL --max-time 20 -A "AadharshBot/1.0 (+https://aadhar.sh/bot)" "$URL" \
  | node -e 'const z=require("zlib"),c=[];process.stdin.on("data",d=>c.push(d)).on("end",()=>process.stdout.write(z.brotliCompressSync(Buffer.concat(c),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}})))' \
  > test/corpus/<name>.html.br
```

Pick pages that are structurally unlike the ones already here. A ninth article
page buys nothing; an app shell, a page with heavy inline SVG, or one with
declarative shadow DOM buys a bug.
