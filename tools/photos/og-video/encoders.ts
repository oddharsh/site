// encoders.ts: the AV1 encode compare.ts measured with and bake.ts ships with,
// in one place so the shipped file is the measured one.
//
// --tune-content=screen turns on palette mode and intra block copy, the two
// tools that make flat XP chrome and repeated text cheap; it's most of why AV1
// came out 2.7x under HEVC here. cpu-used 4 rather than 3: half the time, and
// the sweep's sizes held.
export const av1Flags = (cq: number): string[] => [
  "--quiet",
  "--good",
  "--cpu-used=4",
  "--end-usage=q",
  `--cq-level=${cq}`,
  "--tune-content=screen",
  "--threads=8",
  "--row-mt=1",
  "--kf-max-dist=600",
  "--webm",
];
