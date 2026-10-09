// warm-icu.ts: load ICU in this process the way workerd's neighbours already
// have, before a CPU sample charges a route for it.
//
// ICU keeps its data per PROCESS. workerd runs a great many isolates in one
// process, so a Worker's fresh isolate finds ICU loaded by whoever came before.
// A fresh node process per sample (route-cpu and cpu-sweep both work that way)
// finds it cold, and charged the first date format, collation or number format
// in a request about 10 ms nobody pays in production. Measured 2026-10-09 under
// node 26.11, each first use inside a fresh worker-thread isolate, in a process
// that never touched ICU against one where another isolate had:
//
//   DateTimeFormat   9.51-9.83 ms   0.09-0.12 ms
//   localeCompare    6.50          0.03
//   toLocaleString   8.54          0.07   (number)
//   Segmenter        7.18          0.06   (word)
//
// So this runs each service once in a throwaway isolate and waits for it to
// exit, leaving this isolate's own state untouched: what the route pays for its
// own formatter objects and zones is still charged to it. It names no zone the
// site uses; a second zone measured 0.06 ms.
//
// It assumes every ICU service is warm in production, which a shared process
// all but guarantees for en-US. A route that reaches an unusual locale's data
// would pay a little more there than here.
import { Worker } from "node:worker_threads";

const WARM = `"b".localeCompare("a"); (1234.5).toLocaleString("en-US");
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(1);
new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", dateStyle: "full", timeStyle: "long" }).format(0);
new Date(0).toLocaleString("en-US"); [...new Intl.Segmenter("en", { granularity: "word" }).segment("a b")];
new Intl.PluralRules("en-US").select(1); new Intl.RelativeTimeFormat("en").format(1, "day");
new Intl.ListFormat("en").format(["a", "b"]); new Intl.DisplayNames("en", { type: "region" }).of("US");`;

export function warmIcu(): Promise<void> {
  return new Promise((done, fail) => {
    new Worker(WARM, { eval: true }).on("exit", () => done()).on("error", fail);
  });
}
