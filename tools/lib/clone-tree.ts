// clone-tree.ts: copy a whole directory tree with one clonefile(2) call.
//
// On APFS, clonefile() given a directory clones the hierarchy copy-on-write in
// a single system call. Staging public/ file by file cost about 0.4 ms of kernel
// time per file whatever the concurrency (998 files: 76 ms wall, 400 ms CPU on
// 2026-10-08); one clone of the same tree took 7.7 ms. Copy-on-write is what
// makes it safe where a hard link would not be: later build steps rewrite
// staged files in place, and a write to a clone never reaches the source.
//
// macOS under bun only, because the call comes through bun:ffi; it returns
// false anywhere else, and on any failure (another volume, an existing
// destination), so a caller falls back to copying. BUILD_CLONE=0 forces that
// fallback, which is how the two paths are compared byte for byte.

export async function cloneTree(src: string, dst: string): Promise<boolean> {
  if (process.platform !== "darwin" || !process.versions.bun || process.env.BUILD_CLONE === "0") return false;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      clonefile: { args: [FFIType.cstring, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
    });
    try {
      const path = (s: string) => ptr(Buffer.from(`${s}\0`));
      // flags 0: follow nothing special; a symlink inside the tree is cloned as a link
      return libc.symbols.clonefile(path(src), path(dst), 0) === 0;
    } finally {
      libc.close();
    }
  } catch {
    return false;
  }
}
