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
