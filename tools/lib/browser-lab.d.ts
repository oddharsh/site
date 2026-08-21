// browser-lab.d.ts — spec members the tools' browser-side code uses that
// TypeScript's lib.dom does not declare yet.
//
// These are NOT invented. `interactionId` and `durationThreshold` are Event
// Timing (w3c/event-timing), which is how INP is measured at all; a lab script
// that could not name them could not do its job. TS ships them in neither
// lib.dom nor @types/bun's DOM surface as of 2026-08-20.
//
// The `__inp*` members are inp-lab.mjs's own handle on the page, installed by a
// collector that runs INSIDE the browser and read back across the boundary.
// Declaring them beats a cast at each use: a cast would silence the reads, and
// this states what the page actually carries.

interface PerformanceEntry {
  /** Event Timing: groups the events belonging to one user interaction. 0 for non-interactions. */
  readonly interactionId?: number;
}

interface PerformanceObserverInit {
  /** Event Timing: floored at 16ms by the spec, so faster interactions emit nothing. */
  durationThreshold?: number;
}

interface Window {
  __inp?: { groups: Map<number, number>; visible: DocumentVisibilityState };
  __inpReset?: () => void;
  __inpRead?: () => { max: number | null; n: number; visible: DocumentVisibilityState };
}
