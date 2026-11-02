# Aadharsh Pannirselvam

resume@aadhar.sh · [aadhar.sh](https://aadhar.sh) · [aadhar.sh/lwe](https://aadhar.sh/lwe) · [github.com/oddharsh](https://github.com/oddharsh) · [@oddhash](https://x.com/oddhash)

Plain-text mirror of resume.pdf (the canonical copy). Structured data lives in resume.json.

I notice technology, take it apart to understand it, and write up what's inside. Obsessive about feel and performance: I live on beta and canary builds, give feedback, and lately ship the fixes. By day I invest in that frontier at Archetype, and the writing is part of that job; the rest of the time I tinker and play.

## Tinkering and Building with Technology

**Learning With Errors** · [aadhar.sh/lwe](https://aadhar.sh/lwe)
Builder & Writer · May 2026 to Present.

- Interactive technical explainers written as conversations: inline demos you can poke, a pop quiz at the end of each one. FHE, MPC, TEEs, UTF-8: hard things taught the way you'd actually pick them up, by taking them apart.
- Garage study: disassembled thumbnail encoding: AVIF vs JPEG vs jpegli at the byte level, bytes-per-pixel benchmarks from my own measurements, plus experiments in image optimization, minifiers, and dictionary-based content compressors.
- Among the first 10 solvers of Paradigm's Kryptos-style CTF puzzles, cracked with a group ideating constantly, AI in the loop. The Vigenère explainer above came out of that rabbit hole.

**Open-source contributor**
June 2026 to Present.

- Fixed the WebMCP standard on EmDash (a WordPress replacement) so hosted content is legible to AI agents, tracing the agent-readable web down to the protocol.
- Improved the JavaScript minifier on Bun and Oxc, taking apart how code gets smaller.
- [Found that workerd's zstd silently dropped its dictionary option, filed it, and wrote the fix, pricing it against production first: 21.9% off 13 pages at roughly 0.2 ms of CPU each.](https://github.com/cloudflare/workerd/pull/7106)
- More merged work in the same lanes: Compression Dictionary Transport in web-platform-tests and MDN, and image-codec PRs into jxl-rs (libjxl) and zenjpeg.
- Built houseguest, my personal software factory: a Claude Code plugin that makes my OSS contributions repeatable so PRs land mergeable, still being tweaked as I contribute more.
- Thinking hard about how OSS maintenance evolves as AI-generated issues and PRs get cheap: what happens to feedback loops, and whether canaries and nightlies become the review process. I run both constantly.

**Internal tooling** · shipped & maintained
Archetype.

- Surveyed agent frameworks, then built a firmwide Slack AI agent on DigitalOcean Kubernetes around an open-source, extensible base, folding in lessons from each framework and my own tools. Plus a 20-skill sidekick toolkit; people across the firm use both daily, and I maintain them from usage metrics, feedback, what people build, and security developments.

## Noticing, Learning About, and Advocating for Technology

**Archetype** · Principal, New York, NY
October 2023 to Present.

- [Wrote the 3-part "Privacy 2.0" series on privacy-enhancing technologies (TEEs, MPC, FHE, obfuscation), long-form research at the AI/crypto intersection that shaped the fund's applied-cryptography thesis.](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)
- Treated diligence as deep technical education: dug into parallel execution for distributed systems, eval design, model architectures, and audio processing for voice models. I learn the machinery first, then the market.
- Mapped the agent-readable web: evangelized agent payment rails, onchain agents, and app-chain design through hands-on work with open-source builders.
- Host and curate dinners and events gathering top technical people across cryptography, formal verification, and privacy, and have spoken on panels and MC'ed events in the space, including an Oxford-style debate on onchain agents.

**Galaxy** · Analyst, Ventures Team, New York, NY
Summers 2022 and 2023.

- Diligence on Mysten's Series A: benchmarked Sui's Move-based state concurrency model against Solana's parallelism and consensus protocol, applying broad distributed systems principles, and wrote internal directives on separated fee markets, applying game-theoretic principles and data.

## Education

**University of Chicago**
A.B. Economics, minor in Data Science, 3.81 · 2024.

## Skills & Current Puzzles

TypeScript, Python, SQL · Claude Code, Codex · Taking apart: image codecs, compression dictionaries, agent-readable web.
