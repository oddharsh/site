// The canary's browsers leg runs inside the official Playwright image, and its
// pull step refuses an image whose version differs from the installed
// playwright-core. That refusal only runs nightly. #1364 moved playwright-core
// to 1.64.1 and left the image on 1.63.0, so the leg failed before any probe
// on every night until the pin moved (gotcha 75). This holds the same
// equality at PR time, against package.json's exact pin, so the bump PR that
// moves one has to move both. tools/bump-deps.ts moves both on its own.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

const IMAGE = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/;

test("config/browser-image.json names the playwright-core version package.json pins", async () => {
  const { image } = JSON.parse(await readFile(new URL("config/browser-image.json", ROOT), "utf8"));
  const pin = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")).devDependencies?.["playwright-core"];
  assert.match(pin ?? "", /^\d+\.\d+\.\d+$/, "playwright-core must be an exact pin for the image to match it");
  const version = String(image).match(IMAGE)?.[1];
  assert.ok(version, "config/browser-image.json must pin the image by tag and digest");
  assert.equal(version, pin, `the playwright ${version} image is pinned, and package.json pins playwright-core ${pin}; move the tag and its digest together`);
});

// The bump branch is pushed by an App token with no workflows permission, so a
// second pin inside canary.yml would be one the bumper cannot move.
test("canary.yml reads the image from config/browser-image.json and pins none of its own", async () => {
  const yml = await readFile(new URL(".github/workflows/canary.yml", ROOT), "utf8");
  assert.ok(yml.includes('require("./config/browser-image.json")'));
  assert.equal(yml.includes("mcr.microsoft.com/playwright:"), false);
});

test("CONTROL: the pattern reads the version out of a pinned image and nothing else", () => {
  assert.equal(`mcr.microsoft.com/playwright:v1.63.0-noble@sha256:${"e".repeat(64)}`.match(IMAGE)?.[1], "1.63.0");
  assert.equal("mcr.microsoft.com/playwright:v1.63.0-noble".match(IMAGE), null, "a tag without a digest is not a pin");
});
