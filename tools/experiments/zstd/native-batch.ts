// Experiment adapter. The production build does not import this module.
// To measure a complete build, use the documented throwaway-worktree procedure.
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
type Job = { bytes: Uint8Array; dictionary: Uint8Array };
const u32 = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
export async function zstdCompressDictionaryBatch(jobs: Job[]): Promise<Buffer[]> {
  if (!jobs.length) return [];
  const binary = process.env.SITE_ZSTD_EXPERIMENT_BIN;
  if (!binary) throw new Error('SITE_ZSTD_EXPERIMENT_BIN must name the compiled experiment helper');
  const dictionaries = new Map<string, { index: number; bytes: Uint8Array }>();
  const rows = jobs.map(job => {
    const hash = createHash('sha256').update(job.dictionary).digest('hex');
    let entry = dictionaries.get(hash);
    if (!entry) { entry = { index: dictionaries.size, bytes: job.dictionary }; dictionaries.set(hash, entry); }
    return [u32(entry.index), u32(job.bytes.length), job.bytes];
  });
  const input = Buffer.concat([u32(dictionaries.size), u32(jobs.length),
    ...[...dictionaries.values()].flatMap(({ bytes }) => [u32(bytes.length), bytes]), ...rows.flat()]);
  const result = spawnSync(binary, ['reuse', String(Math.min(8, availableParallelism(), jobs.length))], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native zstd exited ${String(result.status)}: ${String(result.stderr)}`);
  let offset = 0;
  const frames = jobs.map(() => {
    if (offset + 4 > result.stdout.length) throw new Error('missing native frame');
    const size = result.stdout.readUInt32LE(offset); offset += 4;
    if (size > result.stdout.length - offset) throw new Error('truncated native frame');
    const frame = result.stdout.subarray(offset, offset + size); offset += size;
    return frame;
  });
  if (offset !== result.stdout.length) throw new Error('trailing native data');
  return frames;
}
