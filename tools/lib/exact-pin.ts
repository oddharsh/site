// An exact pin is the only shape the prose can be wrong ABOUT: a range names a
// set, and the doc states one number. Shared by tools/lib/dependency-docs.ts,
// tools/lib/lockfile-pins.ts and tools/lib/dependency-snapshot.ts, because two
// spellings of "exact pin" is the drift that would let one checker cover a
// declaration another silently skips.
//
// ITS OWN FILE because it imports nothing. dependency-snapshot.yml runs with a
// write token and no node_modules; reaching this through dependency-docs.ts
// pulled smol-toml, which bun then auto-installed from the registry.
export const EXACT_PIN = /^\d+\.\d+\.\d+[\w.-]*$/;
