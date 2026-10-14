// Which incumbent holds the remainder during a ramp step.

export function remainderHolder(active: { id: string; pct: number }[], targetId: string) {
  const short = (id) => String(id).slice(0, 8);
  return active
    .filter((v) => short(v.id) !== short(targetId))
    .sort((a, b) => b.pct - a.pct)[0]?.id || null;
}
