import { ROOT, assert, readFile, test } from "../../../tools/tests/contract-shared.ts";
import { renderSystemRestore } from "../updates.ts";

test("System Restore reserves list height and pre-renders the newest detail to avoid CLS", async () => {
  const points = JSON.parse(await readFile(new URL("src/worker/checkpoints.json", ROOT), "utf8"));
  const html = await (await renderSystemRestore({ points, state: "ok" })).text();
  assert.match(html, /\.sr-list\{(?:[^}]*;)?height:308px/, "desktop .sr-list must reserve explicit height before hydration");
  assert.match(html, /@media \(max-width:560px\)\{[\s\S]*?\.sr-list\{(?:[^}]*;)?height:170px/, "phone .sr-list must reserve explicit height before hydration");
  const newest = points[points.length - 1];
  const detailMatch = /<div class="sr-detail" id="srDetail">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="sr-scrub">/.exec(html);
  assert.ok(detailMatch, "expected #srDetail container");
  assert.ok(detailMatch[1].includes(newest.version), "newest restore point must be pre-rendered inside #srDetail");
  assert.ok(detailMatch[1].includes('id="srGo"'), "initial detail must include the restore button before script runs");
});
