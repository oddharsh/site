// Generated from tools/site/crates/site-model; run bun run gen:manifest.
export type SiteManifest = { version: number, note: string, surfaces: Array<Surface>, };
export type Surface = { path: string, title: string, section: string, kind: SurfaceKind, description: string, hint: string, short?: string | null, note?: string | null, flags: SurfaceFlags, };
export type SurfaceKind = "content" | "page" | "section" | "utility";
export type SurfaceFlags = { run: boolean, taskbar: boolean, sitemap: boolean, gallery: boolean, agents: boolean, searchIndex: boolean, webmention: boolean, };
export type AgentSurface = { path: string, title: string, kind: SurfaceKind, description: string, };
