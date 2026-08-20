// Which incumbent holds the remainder during a ramp step.
//
// A step names the WHOLE traffic split and wrangler accepts at most 2 versions,
// so when more than one incumbent is serving, one of them is dropped and its
// share goes to the survivor. This picks the survivor.
//
// It must be the LARGEST incumbent rather than whichever the API listed first.
// Handing the remainder to a version that was serving 10% moves most of
// production onto something nobody canaried, as a side effect of a step whose
// only purpose is changing one thing carefully.
//
// Measured 2026-08-20 on the arbitrary version: a canary step went from
// `863a5873 @ 10%, c649f1fc @ 90%` to `7634b9d8 @ 10%, 863a5873 @ 90%`. It put
// the new build at 10% as intended AND moved 90% of traffic to a version that
// had been serving 10% a minute before, silently. The `full` gate had refused an
// uncanaried version minutes earlier, so one step blocked that hazard on purpose
// while another waved it through by accident.
//
// The --rollback path has always sorted by percentage. This is the ramp path
// agreeing with its own neighbour rather than a new rule.

/** @param {{id: string, pct: number}[]} active @param {string} targetId */
export function remainderHolder(active, targetId) {
  const short = (id) => String(id).slice(0, 8);
  return active
    .filter((v) => short(v.id) !== short(targetId))
    .sort((a, b) => b.pct - a.pct)[0]?.id || null;
}
