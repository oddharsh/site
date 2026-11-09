// A lazy value derived once per isolate, for the botauth signing keys, the D1
// DDL guards and the pixel-peeper manifest.
//
// The PROMISE is cached, so concurrent callers share one derivation rather than
// each starting their own before the first finishes. What a rejection does is
// the caller's explicit choice, because the sites disagree for good reasons:
//
// - "retry" forgets a rejected derivation, so the next call starts over. Right
//   when the failure is transient (an ASSETS read, a D1 hiccup).
// - "keep" caches the rejection like any other answer. Right when every input
//   is in the key, so a retry fails the same way (botauth's unparseable secret).
//
// `key` makes it a one-slot memo: a call whose key differs from the cached
// entry's (compared with ===) derives afresh and replaces it. Without `key`
// every call shares the first caller's derivation, whatever its arguments.
//
// Node-safe (gotcha 16): the contract suite imports it outside workerd.

export type FailurePolicy = "retry" | "keep";

export function isolateMemo<A extends unknown[], T>(
  derive: (...args: A) => Promise<T>,
  { onFailure, key }: { onFailure: FailurePolicy; key?: (...args: A) => unknown },
): (...args: A) => Promise<T> {
  let slot: { key: unknown; value: Promise<T> } | null = null;
  return (...args) => {
    const k = key?.(...args);
    if (slot && slot.key === k) return slot.value;
    // async wrapper so a derive that throws before its first await rejects
    // instead of throwing at the caller, and the policy below still applies
    const entry = { key: k, value: (async () => derive(...args))() };
    slot = entry;
    if (onFailure === "retry")
      entry.value.catch(() => {
        // only this entry: a newer key may already hold the slot
        if (slot === entry) slot = null;
      });
    return entry.value;
  };
}
