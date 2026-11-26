import { ROOT, assert, readFile, test } from "../../../tools/tests/contract-shared.ts";
import { derivePhotoPool, renderPhotosPage } from "../photos.ts";

test(
  "gallery images use existing responsive tiers and keep URLs deferred after twelve",
  { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" },
  async () => {
    const pool = derivePhotoPool(
      JSON.parse(await readFile(new URL("src/worker/photo-index.json", ROOT), "utf8")),
      JSON.parse(await readFile(new URL("public/images/hashes.json", ROOT), "utf8")),
    );
    const page = await renderPhotosPage(pool, {}).text();
    const images: Record<string, string | null>[] = [];
    await new HTMLRewriter()
      .on("img[data-gallery]", {
        element(e) {
          images.push(
            Object.fromEntries(
              ["src", "srcset", "data-src", "data-srcset", "data-photo-jpg", "sizes", "loading", "fetchpriority"].map((key) => [key, e.getAttribute(key)]),
            ),
          );
        },
      })
      .transform(new Response(page))
      .text();
    assert.ok(images.length > 100, "the real curated gallery must be exercised");
    for (const [i, image] of images.entries()) {
      assert.equal(image.sizes, i === 0 ? "400px" : "auto, 400px");
      assert.equal(image.loading, i === 0 ? "eager" : "lazy", "automatic sizes require native lazy loading");
      assert.match(image["data-photo-jpg"]!, /\.jpg$/);
      if (i >= 12) assert.equal(image.src, null, "offscreen tiles must expose no URL to the preload scanner");
      const candidates = image[i < 12 ? "srcset" : "data-srcset"]!;
      assert.match(candidates, /-400\.[a-f0-9]{8}\.avif 400w/);
      if (i === 0) assert.equal(candidates.split(",").length, 1, "the eager image keeps its existing 400px candidate at every density");
      else assert.match(candidates, /\.avif 600w/);
      assert.equal(image.fetchpriority, i === 0 ? "high" : i < 6 ? null : "low");
    }
    assert.equal((page.match(/<noscript><picture>/g) || []).length, images.length, "every photo retains AVIF/JPEG negotiation without scripting");
    assert.ok(page.indexOf('document.addEventListener("error"') < page.indexOf("<body"), "JPEG recovery must be installed before any tile parses");
  },
);
