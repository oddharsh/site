// Node's whitespace-preserving stripper keeps comments in readable JavaScript
// twins. Erase a batch in one process: loading Node's parser per island costs
// seconds across the client tree. Node is already required by the build.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function browserJavaScripts(sources: ReadonlyMap<string, string>): Map<string, string> {
  if (sources.size === 0) return new Map();
  const result = spawnSync("node", ["--disable-warning=ExperimentalWarning", fileURLToPath(new URL("./browser-source-node.ts", import.meta.url))],
  { input: JSON.stringify([...sources]), encoding: "utf8", maxBuffer: 8 << 20 });
  if (result.error || result.status !== 0) throw new Error(`browser TypeScript erasure failed: ${result.error?.message ?? result.stderr}`);
  return new Map(JSON.parse(result.stdout));
}

export function browserJavaScript(source: string, filename: string): string {
  return filename.endsWith(".ts") ? browserJavaScripts(new Map([[filename, source]])).get(filename)! : source;
}
