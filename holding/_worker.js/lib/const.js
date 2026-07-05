// lib/const.js — shared constants for the worker.
//
// First extracted module of the no-build reorg: proves wrangler/Cloudflare
// bundle the _worker.js/ directory's relative imports at deploy time, with no
// build step of our own.
//
// (THUMB_VERSION lived here until the content-hash migration finished: every
// thumbnail is now a /i/<stem>.<hash8> URL that names its own bytes, so the
// global ?v= bump ritual retired with the last legacy fallback.)

// canonical-host enforcement: any request that lands on the project's
// auto-generated pages.dev subdomain (aadhar-sh.pages.dev or any deploy-
// hash variant like 60bcf749.aadhar-sh.pages.dev) gets 301'd to the
// equivalent path on aadhar.sh. eliminates the duplicate public footprint
// while preserving the ability to deploy + serve as a Cloudflare Worker.
export const CANONICAL_HOST = "aadhar.sh";
