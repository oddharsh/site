use lens_extract::{extract_metadata, Limits};
fn main() {
    match extract_metadata(std::io::stdin().lock(), Limits::default()) {
        Ok(result) => println!(
            "{}",
            serde_json::to_string(&result).expect("metadata serializes")
        ),
        Err(error) => {
            eprintln!("lens-extract: {error:?}");
            std::process::exit(1);
        }
    }
}
