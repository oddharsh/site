// ── llms.txt lists the API the code describes (tools/gen-llms-api.ts) ───────
// The JSON endpoint block in public/llms.txt is projected from
// src/worker/lib/public-api.ts, the descriptions /openapi.json and /developers
// are rendered from. llms.txt ships byte for byte, so the block is committed;
// this holds it equal to a fresh projection, so a changed description, cap or
// rate budget fails here until the generator is run.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { BEGIN, END, LLMS_PATH, endpointBlock, withEndpointBlock } from "./gen-llms-api.ts";
import { OPERATIONS } from "../src/worker/lib/public-api.ts";
import { LENS_BUDGETS } from "../src/worker/lens-pipeline.ts";

const llms = readFileSync(LLMS_PATH, "utf8");

test("the committed endpoint block is the generator's output", () => {
  assert.equal(llms.split(BEGIN).length, 2, "exactly one generated block");
  assert.equal(withEndpointBlock(llms), llms, "stale: run bun tools/gen-llms-api.ts");
});

test("the block lists every operation, with the code's numbers", () => {
  const block = endpointBlock();
  for (const op of OPERATIONS) assert.ok(block.includes(`(\`${op.operationId}\`)`), `${op.operationId} is listed`);
  assert.ok(block.includes(`Shares a ${LENS_BUDGETS.inspect.max} per minute`), "a rate budget reaches llms.txt from lens-pipeline.ts");
});

test("a hand edit inside the block is caught, and a lost marker throws", () => {
  const edited = llms.replace("(`searchSite`):", "(`searchSite`): HAND EDIT");
  assert.notEqual(withEndpointBlock(edited), edited, "the projection overwrites a hand edit, so the equality above fails on one");
  assert.throws(() => withEndpointBlock(llms.replace(END, "")), /markers are missing/);
});
