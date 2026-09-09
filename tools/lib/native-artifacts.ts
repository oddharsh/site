import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import type { Artifact, Plan } from "../site/generated/compiler.ts";

const execute = promisify(execFile);

// Cargo reports the actual executable even when CARGO_TARGET_DIR is overridden.
// Guessing target/release could execute an old binary after a successful rebuild.
export function compilerExecutable(stdout: string): string {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target?.name === "site-compiler" &&
        message.target?.kind?.includes("bin") && typeof message.executable === "string") {
      return message.executable;
    }
  }
  throw new Error("Cargo returned no site-compiler executable");
}

/** One native compiler instance for the build; all plans and outputs stay outside the served tree. */
export class NativeArtifacts {
  private ready?: Promise<string>;
  private batch = 0;
  private readonly sourceRoot: string;
  private readonly scratchRoot: string;
  private readonly cacheRoot: string;

  constructor(sourceRoot: string, scratchRoot: string, cacheRoot: string) {
    this.sourceRoot = resolve(sourceRoot);
    this.scratchRoot = resolve(scratchRoot);
    this.cacheRoot = resolve(cacheRoot);
  }

  private prepare(): Promise<string> {
    return this.ready ??= execute("cargo", [
      "build", "--quiet", "--release", "--locked", "--message-format=json", "--manifest-path", "tools/site/Cargo.toml", "-p", "site-compiler",
    ], { maxBuffer: 4 * 1024 * 1024 }).then(({ stdout }) => compilerExecutable(stdout));
  }

  async brotli(paths: string[]): Promise<Buffer[]> {
    if (!paths.length) return [];
    const binary = await this.prepare();
    const batchRoot = join(this.scratchRoot, String(this.batch++));
    await mkdir(batchRoot, { recursive: true });
    const plan: Plan = {
      version: 1,
      jobs: paths.map((path) => ({
        source: path, output: `${path}.br`, action: { kind: "brotli", quality: 11, window: 24 },
      })),
    };
    const planPath = join(batchRoot, "plan.json");
    const outputRoot = join(batchRoot, "outputs");
    await writeFile(planPath, JSON.stringify(plan));
    const { stdout } = await execute(binary, [planPath, this.sourceRoot, outputRoot, this.cacheRoot], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const records: Artifact[] = JSON.parse(stdout);
    if (records.length !== paths.length || records.some((record, i) => record.source !== paths[i] || record.output !== `${paths[i]}.br`)) {
      throw new Error("native compiler returned an incomplete or reordered batch");
    }
    await writeFile(join(batchRoot, "artifacts.json"), stdout);
    console.log(`native-brotli: ${records.filter((record) => record.cacheHit).length}/${records.length} cache hits`);
    return Promise.all(records.map((record) => readFile(join(outputRoot, record.output))));
  }
}
