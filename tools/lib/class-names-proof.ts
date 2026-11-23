// The worker thread behind proveRename (class-names.ts): one census of the
// rewritten tree, checked against the census the plan came from. The census
// and map arrive by structured clone, which keeps their Maps and Sets.
//
// The handler is set before anything loads. spokeshave/classes awaits terser at
// its top level, and a static import holds the worker's body until that
// settles while the event loop runs: the job arrived in that window and was
// dropped with no handler to take it, so the proof never answered (gotcha 115).
import type { ClassCensus } from "spokeshave/classes";

type Job = { before: ClassCensus; after: Map<string, string>; map: Map<string, string>; floor: number };

self.onmessage = async (event: MessageEvent<Job>) => {
  const { before, after, map, floor } = event.data;
  try {
    const { assertClassIntegrity, censusClasses } = await import("spokeshave/classes");
    assertClassIntegrity(before, censusClasses(after, { publicDir: "public" }), map, floor);
    postMessage({ error: null });
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
