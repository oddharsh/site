// build-phases.ts: wall and CPU time per step of tools/build.ts.

export interface PhaseRow {
  name: string;
  wallMs: number;
  cpuMs: number;
}

export function phaseClock() {
  const rows: PhaseRow[] = [];
  let open: { name: string; t: number; cpu: NodeJS.CpuUsage } | null = {
    name: "startup",
    t: 0,
    cpu: { user: 0, system: 0 },
  };
  const close = () => {
    if (!open) return;
    const cpu = process.cpuUsage(open.cpu);
    rows.push({ name: open.name, wallMs: performance.now() - open.t, cpuMs: (cpu.user + cpu.system) / 1000 });
    open = null;
  };
  return {
    phase: (name: string) => {
      close();
      open = { name, t: performance.now(), cpu: process.cpuUsage() };
    },
    finish: (): PhaseRow[] => {
      close();
      return rows;
    },
  };
}

export function phaseSummary(rows: PhaseRow[], top = 5): string {
  const total = rows.reduce((t, r) => t + r.wallMs, 0);
  const slowest = [...rows].sort((a, b) => b.wallMs - a.wallMs).slice(0, top);
  const cell = (r: PhaseRow) => `${r.name} ${Math.round(r.wallMs)}ms (cpu ${Math.round(r.cpuMs)})`;
  return `phases: ${(total / 1000).toFixed(2)}s across ${rows.length}; slowest ${slowest.map(cell).join(", ")}`;
}
