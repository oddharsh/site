use std::io::{self, Write};
use std::path::Path;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err(
            "usage: site-compiler <plan.json> <source-root> <output-root> <cache-dir>".into(),
        );
    }
    let plan = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let compiler_id = site_compiler::digest(&std::fs::read(std::env::current_exe()?)?);
    let artifacts = site_compiler::compile(
        &plan,
        Path::new(&args[1]),
        Path::new(&args[2]),
        Path::new(&args[3]),
        &compiler_id,
    )?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &artifacts)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("site-compiler: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
