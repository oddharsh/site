import assert from "node:assert/strict";
import test from "node:test";
import garage from "../cf-garage/src/index.js";
import ask from "../lwe-ask/src/index.js";

for (const [name, worker, url] of [
  ["Cloudflare garage", garage, "https://aadhar.sh/garage/cf/counter"],
  ["LWE ask", ask, "https://aadhar.sh/lwe/ask"],
]) {
  test(`${name} adapter retires old clients explicitly`, async () => {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(url, { method }));
      assert.equal(response.status, 410);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error, "gone");
    }
    assert.equal((await worker.fetch(new Request(url, { method: "OPTIONS" }))).status, 204);
  });
}
