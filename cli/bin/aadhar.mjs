#!/usr/bin/env node
import { run } from "../aadhar.mjs";

process.exitCode = await run(process.argv.slice(2), {
  fetch: globalThis.fetch,
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
});
