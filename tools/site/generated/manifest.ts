// Generated from tools/site/crates/site-model; run bun run gen:manifest.
export type SiteManifest = { version: number, note: string, surfaces: Array<Surface>, };
export type Surface = { path: string, title: string, section: string, kind: SurfaceKind, description: string, hint: string, short?: string | null, note?: string | null, flags: SurfaceFlags, };
export type SurfaceKind = "content" | "page" | "section" | "utility";
export type SurfaceFlags = { run: boolean, taskbar: boolean, sitemap: boolean, gallery: boolean, agents: boolean, searchIndex: boolean, webmention: boolean, };
export type AgentSurface = { path: string, title: string, kind: SurfaceKind, description: string, };
export type GaragePage = { id: string, title: string, description: string, status: string, added?: string | null, editorial: Editorial, understanding: Understanding, bodyHtml: string, pageCss?: string | null, pageJs?: string | null, };
export type Editorial = { reader: string, problem: string, thesis: string, evidence: Array<string>, uncertainty: string, };
export type Understanding = { title?: string | null, intro?: string | null, questions: Array<Question>, };
export type Question = { q: string, options: Array<AnswerOption>, };
export type AnswerOption = { t: string, ok?: boolean | null, why: string, };
