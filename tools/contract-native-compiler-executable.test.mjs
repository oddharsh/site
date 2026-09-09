import { test } from "node:test";
import assert from "node:assert/strict";
import { compilerExecutable } from "./lib/native-artifacts.ts";

test("native build uses Cargo's executable, including a custom target directory", () => {
  const messages = [
    { reason: "compiler-artifact", target: { name: "site-compiler", kind: ["lib"] }, executable: null },
    { reason: "compiler-artifact", target: { name: "site-compiler", kind: ["bin"] }, executable: "/custom/target/release/site-compiler" },
    { reason: "build-finished", success: true },
  ].map((message) => JSON.stringify(message)).join("\n");
  assert.equal(compilerExecutable(messages), "/custom/target/release/site-compiler");
  for (const stdout of ["", "not json", JSON.stringify({ reason: "build-finished", success: true })]) {
    assert.throws(() => compilerExecutable(stdout));
  }
});
