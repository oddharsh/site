// agent-representation.ts: what an `agents: true` surface owes a machine.

export type AgentSurface = { path: string; kind?: string; mimeType?: string; flags?: { agents?: boolean } };

export function agentRepresentation(surface: AgentSurface): string {
  return surface.mimeType && surface.mimeType !== "text/html" ? surface.mimeType : "text/markdown";
}

export function needsBuiltTwin(surface: AgentSurface): boolean {
  return !surface.mimeType || surface.mimeType === "text/html";
}

export function agentSurfaces<T extends AgentSurface>(surfaces: T[]): T[] {
  return surfaces.filter((s) => s.flags?.agents === true);
}
