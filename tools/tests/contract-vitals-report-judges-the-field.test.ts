// ── vitals:report judges p75 against Core Web Vitals' own lines ─────────────
// The field reading is the one number here no lab produced, so the report
// that judges it has to hold its lines exactly: "good" at or under 2.5 s,
// 200 ms and 0.1, "poor" past 4 s, 500 ms and 0.25, and nothing judged on
// fewer views than a p75 can mean anything for.
import { assert, test } from "./contract-shared.ts";
import { MIN_VIEWS, judge, parseRows, report, show } from "../vitals-report.ts";

test("each metric is judged on its published lines, at the boundary values", () => {
  assert.equal(judge({ metric: "LCP", p75: 2500, views: 100 }), "good");
  assert.equal(judge({ metric: "LCP", p75: 2501, views: 100 }), "needs work");
  assert.equal(judge({ metric: "LCP", p75: 4001, views: 100 }), "poor");
  assert.equal(judge({ metric: "INP", p75: 200, views: 100 }), "good");
  assert.equal(judge({ metric: "INP", p75: 501, views: 100 }), "poor");
  assert.equal(judge({ metric: "CLS", p75: 0.1, views: 100 }), "good");
  assert.equal(judge({ metric: "CLS", p75: 0.11, views: 100 }), "needs work");
  assert.equal(judge({ metric: "CLS", p75: 0.26, views: 100 }), "poor");
});

test("a p75 over too few views is printed and never judged", () => {
  assert.equal(MIN_VIEWS, 20);
  assert.equal(judge({ metric: "LCP", p75: 9000, views: 19 }), "too few views");
  assert.equal(judge({ metric: "LCP", p75: 9000, views: 20 }), "poor");
});

test("the SQL API's rows are parsed once, and a row of another shape is dropped", () => {
  const body = {
    data: [
      { path: "/garage/horizon", metric: "LCP", p75: 1840.5, views: 212 },
      { path: "/garage/horizon", metric: "CLS", p75: 0.004, views: 150, version: "ab12cd34" },
      { path: "/garage/horizon", metric: "TTFB", p75: 90, views: 212 },
      { path: "/garage/horizon", metric: "INP", p75: "fast", views: 30 },
      "not a row",
    ],
  };
  assert.deepEqual(parseRows(body), [
    { path: "/garage/horizon", metric: "LCP", version: "", p75: 1840.5, views: 212 },
    { path: "/garage/horizon", metric: "CLS", version: "ab12cd34", p75: 0.004, views: 150 },
  ]);
  assert.throws(() => parseRows({ errors: ["denied"] }), /without a data array/);
});

test("the report prints one line per row and fails only on a judged row that is not good", () => {
  assert.equal(show({ metric: "LCP", p75: 1840.5 }), "1841 ms");
  assert.equal(show({ metric: "CLS", p75: 0.004 }), "0.004");
  const good = report([
    { path: "/garage/horizon", metric: "LCP", version: "", p75: 1840.5, views: 212 },
    { path: "/garage/horizon", metric: "INP", version: "", p75: 900, views: 3 },
  ]);
  assert.deepEqual(good.lines, [
    "ok    /garage/horizon              INP  p75   900 ms      3 views  too few views",
    "ok    /garage/horizon              LCP  p75  1841 ms    212 views  good",
  ]);
  assert.equal(good.failed, false);
  const slow = report([{ path: "/garage/horizon", metric: "INP", version: "ab12cd34", p75: 260, views: 40 }]);
  assert.deepEqual(slow.lines, ["FAIL  /garage/horizon @ab12cd34    INP  p75   260 ms     40 views  needs work"]);
  assert.equal(slow.failed, true);
});
