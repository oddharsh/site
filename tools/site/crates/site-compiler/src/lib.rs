//! Native artifact compilation. Cache keys include source bytes, the action and
//! the running compiler identity; persisted records verify their output digest.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Identity,
    Brotli { quality: u8, window: u8 },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Job {
    pub source: String,
    pub output: String,
    pub action: Action,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Plan {
    pub version: u32,
    pub jobs: Vec<Job>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub source: String,
    pub output: String,
    pub source_hash: String,
    pub output_hash: String,
    pub source_bytes: usize,
    pub output_bytes: usize,
    pub cache_hit: bool,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn relative_path(path: &str) -> io::Result<()> {
    if path.is_empty()
        || path.split('/').any(|part| part.is_empty())
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err(invalid(format!(
            "expected a relative artifact path: {path:?}"
        )));
    }
    Ok(())
}

impl Plan {
    pub fn validate(&self) -> io::Result<()> {
        if self.version != 1 {
            return Err(invalid("unsupported plan version"));
        }
        if self.jobs.is_empty() {
            return Err(invalid("empty compilation plan"));
        }
        let mut outputs = std::collections::HashSet::new();
        for job in &self.jobs {
            relative_path(&job.source)?;
            relative_path(&job.output)?;
            if !outputs.insert(&job.output) {
                return Err(invalid(format!("duplicate output {}", job.output)));
            }
            if let Action::Brotli { quality, window } = job.action {
                if quality > 11 || !(10..=24).contains(&window) {
                    return Err(invalid(
                        "Brotli requires quality 0..11 and an HTTP-compatible window 10..24",
                    ));
                }
            }
        }
        Ok(())
    }
}

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("artifact needs a parent directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".site-{}-{}.tmp",
        std::process::id(),
        TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        // Build artifacts are disposable. Atomic rename supplies complete-file
        // visibility; forcing durable storage per artifact would serialize the
        // warm path on disk latency.
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

// Read only regular files inside the supplied root. Inputs may be staged through
// links, but a link escaping the source root cannot become a compiled asset.
fn read_source(root: &Path, relative: &str) -> io::Result<Vec<u8>> {
    let path = root.join(relative).canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(invalid(format!(
            "source escapes root or is not a file: {relative}"
        )));
    }
    fs::read(path)
}

// Output paths are authored plan entries, but an existing symlink must never
// turn a write into one outside the compiler's output directory.
fn output_path(root: &Path, relative: &str) -> io::Result<std::path::PathBuf> {
    let mut path = root.to_path_buf();
    for part in Path::new(relative).components() {
        path.push(part);
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(invalid(format!("output contains a symlink: {relative}")));
        }
    }
    Ok(path)
}

fn encode(bytes: &[u8], action: Action) -> io::Result<Vec<u8>> {
    match action {
        Action::Identity => Ok(bytes.to_vec()),
        Action::Brotli { quality, window } => {
            let encoder = brotlic::BrotliEncoderOptions::new()
                .quality(brotlic::Quality::new(quality).map_err(io::Error::other)?)
                .window_size(brotlic::WindowSize::new(window).map_err(io::Error::other)?)
                .size_hint(
                    bytes
                        .len()
                        .try_into()
                        .map_err(|_| invalid("input exceeds Brotli size hint"))?,
                )
                .build()
                .map_err(io::Error::other)?;
            let mut output = brotlic::CompressorWriter::with_encoder(encoder, Vec::new());
            output.write_all(bytes)?;
            output.into_inner().map_err(io::Error::other)
        }
    }
}

fn compile_job(
    job: &Job,
    source_root: &Path,
    cache: &Path,
    compiler_id: &str,
) -> io::Result<(Artifact, Vec<u8>)> {
    let source = read_source(source_root, &job.source)?;
    let source_hash = digest(&source);
    let key = digest(&serde_json::to_vec(&(
        1_u8,
        compiler_id,
        &source_hash,
        job.action,
    ))?);
    let cache_path = cache.join(format!("{key}.bin"));
    let cached = match fs::read(&cache_path) {
        Ok(bytes) => (bytes.len() >= 32 && bytes[..32] == Sha256::digest(&bytes[32..])[..])
            .then(|| bytes[32..].to_vec()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let cache_hit = cached.is_some();
    let bytes = match cached {
        Some(bytes) => bytes,
        None => {
            let bytes = encode(&source, job.action)?;
            let mut entry = Sha256::digest(&bytes).to_vec();
            entry.extend_from_slice(&bytes);
            atomic_write(&cache_path, &entry)?;
            bytes
        }
    };
    let artifact = Artifact {
        source: job.source.clone(),
        output: job.output.clone(),
        source_hash,
        output_hash: digest(&bytes),
        source_bytes: source.len(),
        output_bytes: bytes.len(),
        cache_hit,
    };
    Ok((artifact, bytes))
}

/// Compile all jobs before publishing any output. A failed input or encoder
/// leaves existing outputs untouched. Each successful artifact replaces its old
/// version with an atomic rename. The returned records form the dependency graph.
pub fn compile(
    plan: &Plan,
    source_root: &Path,
    output_root: &Path,
    cache: &Path,
    compiler_id: &str,
) -> io::Result<Vec<Artifact>> {
    plan.validate()?;
    let source_root = source_root.canonicalize()?;
    fs::create_dir_all(output_root)?;
    let output_root = output_root.canonicalize()?;
    let destinations = plan
        .jobs
        .iter()
        .map(|job| output_path(&output_root, &job.output))
        .collect::<io::Result<Vec<_>>>()?;
    let workers = std::thread::available_parallelism()?
        .get()
        .min(8)
        .min(plan.jobs.len());
    let next = std::sync::atomic::AtomicUsize::new(0);
    let compiled = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                let source_root = &source_root;
                let next = &next;
                scope.spawn(move || {
                    let mut completed = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(job) = plan.jobs.get(index) else {
                            break;
                        };
                        completed.push((index, compile_job(job, source_root, cache, compiler_id)?));
                    }
                    Ok::<_, io::Error>(completed)
                })
            })
            .collect();
        let mut all = Vec::new();
        for handle in handles {
            all.extend(
                handle
                    .join()
                    .map_err(|_| io::Error::other("compiler worker panicked"))??,
            );
        }
        all.sort_unstable_by_key(|(index, _)| *index);
        Ok::<_, io::Error>(
            all.into_iter()
                .map(|(_, result)| result)
                .collect::<Vec<_>>(),
        )
    })?;
    let mut records = Vec::with_capacity(compiled.len());
    for ((record, bytes), destination) in compiled.into_iter().zip(destinations) {
        atomic_write(&destination, &bytes)?;
        records.push(record);
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "site-compiler-test-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("src")).unwrap();
            fs::write(path.join("src/a.txt"), "alpha alpha alpha ".repeat(100)).unwrap();
            fs::write(path.join("src/b.txt"), "beta beta beta ".repeat(100)).unwrap();
            Self(path)
        }
        fn run(&self, plan: &Plan, compiler: &str) -> io::Result<Vec<Artifact>> {
            compile(
                plan,
                &self.0.join("src"),
                &self.0.join("out"),
                &self.0.join("cache"),
                compiler,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn plan() -> Plan {
        Plan {
            version: 1,
            jobs: ["a", "b"]
                .map(|name| Job {
                    source: format!("{name}.txt"),
                    output: format!("{name}.txt.br"),
                    action: Action::Brotli {
                        quality: 4,
                        window: 24,
                    },
                })
                .into(),
        }
    }
    #[test]
    fn cold_warm_and_selective_rebuilds_roundtrip() {
        let f = Fixture::new();
        let plan = plan();
        assert!(f
            .run(&plan, "compiler-one")
            .unwrap()
            .iter()
            .all(|a| !a.cache_hit));
        assert!(f
            .run(&plan, "compiler-one")
            .unwrap()
            .iter()
            .all(|a| a.cache_hit));
        fs::write(f.0.join("src/a.txt"), "changed source").unwrap();
        let records = f.run(&plan, "compiler-one").unwrap();
        assert!(!records[0].cache_hit);
        assert!(records[1].cache_hit);
        for record in records {
            let mut bytes = Vec::new();
            brotli::BrotliDecompress(
                &mut fs::File::open(f.0.join("out").join(record.output)).unwrap(),
                &mut bytes,
            )
            .unwrap();
            assert_eq!(
                bytes,
                fs::read(f.0.join("src").join(record.source)).unwrap()
            );
        }
    }
    #[test]
    fn compiler_and_action_changes_invalidate_cached_work() {
        let f = Fixture::new();
        let mut plan = plan();
        f.run(&plan, "one").unwrap();
        assert!(f.run(&plan, "two").unwrap().iter().all(|a| !a.cache_hit));
        plan.jobs[0].action = Action::Identity;
        let records = f.run(&plan, "two").unwrap();
        assert!(!records[0].cache_hit);
        assert!(records[1].cache_hit);
        assert_eq!(
            fs::read(f.0.join("out/a.txt.br")).unwrap(),
            fs::read(f.0.join("src/a.txt")).unwrap()
        );
    }
    #[test]
    fn corrupt_cache_is_rebuilt_and_broken_inputs_do_not_publish() {
        let f = Fixture::new();
        let plan = plan();
        let first = f.run(&plan, "one").unwrap();
        for path in fs::read_dir(f.0.join("cache")).unwrap() {
            fs::write(path.unwrap().path(), b"corrupt").unwrap();
        }
        let second = f.run(&plan, "one").unwrap();
        assert!(second.iter().all(|a| !a.cache_hit));
        assert_eq!(first[0].output_hash, second[0].output_hash);
        let output = fs::read(f.0.join("out/a.txt.br")).unwrap();
        fs::write(f.0.join("src/a.txt"), "must not publish").unwrap();
        fs::remove_file(f.0.join("src/b.txt")).unwrap();
        assert!(f.run(&plan, "one").is_err());
        assert_eq!(fs::read(f.0.join("out/a.txt.br")).unwrap(), output);
    }
    #[test]
    fn malformed_plans_fail_before_any_writes() {
        let f = Fixture::new();
        for path in ["../outside", "/outside", "a/../b", "a//b", "a/", "a\\b"] {
            let mut plan = plan();
            plan.jobs[0].output = path.into();
            assert!(f.run(&plan, "one").is_err(), "accepted {path}");
        }
        let mut plan = plan();
        plan.jobs[1].output = plan.jobs[0].output.clone();
        assert!(f.run(&plan, "one").is_err());
        plan.jobs[0].action = Action::Brotli {
            quality: 12,
            window: 25,
        };
        assert!(f.run(&plan, "one").is_err());
        assert!(!f.0.join("out").exists());
    }
    #[cfg(unix)]
    #[test]
    fn output_symlinks_cannot_redirect_writes() {
        let f = Fixture::new();
        fs::create_dir(f.0.join("out")).unwrap();
        std::os::unix::fs::symlink(f.0.join("src/a.txt"), f.0.join("out/a.txt.br")).unwrap();
        let original = fs::read(f.0.join("src/a.txt")).unwrap();
        assert!(f.run(&plan(), "one").is_err());
        assert_eq!(fs::read(f.0.join("src/a.txt")).unwrap(), original);
    }
}
