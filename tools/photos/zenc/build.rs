// build.rs — carry the zenjpeg pin into the binary as a compile-time constant.
//
// `zenc --version` has to name the ENCODER and not only this wrapper, because
// the wrapper is not what decides the bytes: zenc's own 0.1.0 has not moved
// since the crate was written, while dependabot bumps zenjpeg underneath it.
// config/tools.json records the pair as this tool's `recorded` version, on the
// same argument the avifenc entry there makes about aom.
//
// It reads Cargo.lock rather than Cargo.toml on purpose. The manifest states a
// requirement and the lock states what was actually linked, and the question a
// provenance record answers is the second one.
use std::{env, fs, path::Path};

fn main() {
    if env::var_os("CARGO_FEATURE_AVIF_MEMORY_EXPERIMENT").is_some() {
        build_avif_experiment();
    }
    let root = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let lock = Path::new(&root).join("Cargo.lock");
    println!("cargo:rerun-if-changed=Cargo.lock");

    // "unknown" rather than a panic: a missing lock should not stop the encoder
    // building. It is still loud, because config/tools.json's declared pattern
    // then fails to match and `bun run tools:check` reports the line verbatim,
    // which is that tier's rule for a pattern that has stopped reading anything.
    let version = fs::read_to_string(&lock)
        .ok()
        .and_then(|text| locked_version(&text, "zenjpeg"))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ZENJPEG_VERSION={version}");
}

fn build_avif_experiment() {
    use std::process::Command;
    let out = env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let source = "examples/avif-memory.c";
    println!("cargo:rerun-if-changed={source}");
    let flags = Command::new("pkg-config").args(["--cflags", "--libs", "libavif"])
        .output().expect("the AVIF experiment requires pkg-config and libavif development files");
    assert!(flags.status.success(), "pkg-config could not resolve libavif");
    let flags = String::from_utf8(flags.stdout).expect("pkg-config flags are UTF-8");
    let object = format!("{out}/avif-memory.o");
    let mut cc = Command::new("cc");
    cc.args(["-std=c11", "-O3", "-Wall", "-Wextra", "-Werror", "-c", source, "-o", &object]);
    for flag in flags.split_whitespace().filter(|f| f.starts_with("-I")) { cc.arg(flag); }
    assert!(cc.status().expect("run C compiler").success(), "compile AVIF adapter");
    assert!(Command::new("ar").args(["rcs", &format!("{out}/libavif_memory.a"), &object])
        .status().expect("run ar").success(), "archive AVIF adapter");
    println!("cargo:rustc-link-search=native={out}");
    println!("cargo:rustc-link-lib=static=avif_memory");
    for flag in flags.split_whitespace() {
        if let Some(path) = flag.strip_prefix("-L") { println!("cargo:rustc-link-search=native={path}"); }
        if let Some(name) = flag.strip_prefix("-l") { println!("cargo:rustc-link-lib={name}"); }
    }
}

/// The `version` of one `[[package]]` block in a Cargo.lock, by package name.
/// `version` always follows `name` inside a block, so a two-line state machine
/// is enough and no TOML parser has to join the build.
fn locked_version(lock: &str, package: &str) -> Option<String> {
    let name_line = format!("name = \"{package}\"");
    let mut inside = false;
    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            inside = false;
        } else if line == name_line {
            inside = true;
        } else if inside {
            if let Some(rest) = line.strip_prefix("version = \"") {
                return rest.strip_suffix('"').map(str::to_string);
            }
        }
    }
    None
}
