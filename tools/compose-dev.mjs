#!/usr/bin/env bun
// bun run dev  ->  composes .dev/public, then wrangler serves it
//
// The served tree is assembled from four source directories now, so `wrangler
// dev` can no longer point at one readable folder the way it pointed at www/.
// This restores that property rather than giving it up: it copies the source
// directories together with NO transforms, so local dev still serves the bytes
// you authored, unminified and with every comment intact. View Source is part
// of the product, and it should be part of development too.
//
// It is deliberately NOT build.mjs. That script minifies, content-hashes,
// precompresses, derives dictionaries and rewrites shell references, all of
// which are deploy concerns that make local iteration slower and the served
// bytes harder to read. The one thing dev needs is composition.
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = ".dev/public";

// Order matters only where two roots could supply the same path, which they do
// not today; it mirrors build.mjs so a future collision behaves the same way.
const ROOTS = ["public", "src/pages", "src/content", "src/client", "src/styles"];

await rm(".dev", { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const root of ROOTS) await cp(root, OUT, { recursive: true });

console.log(`composed ${OUT} from ${ROOTS.join(", ")} (readable, no transforms)`);
