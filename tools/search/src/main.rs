use site_search_compiler::{compile, INPUT_CAP};
use std::io::{Read, Write};
fn run() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((INPUT_CAP + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|e| e.to_string())?;
    let output = compile(&input)?;
    std::io::stdout()
        .lock()
        .write_all(&output)
        .map_err(|e| e.to_string())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("site-search-compiler: {error}");
        std::process::exit(1);
    }
}
