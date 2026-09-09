use lens_extract::{extract_document, extract_metadata, Limits};
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [] => extract_metadata(std::io::stdin().lock(), Limits::default())
            .map(|value| serde_json::to_string(&value).expect("metadata serializes")),
        [mode] if mode == "--document" => {
            extract_document(std::io::stdin().lock(), Limits::default())
                .map(|value| serde_json::to_string(&value).expect("document serializes"))
        }
        _ => {
            eprintln!("usage: lens-extract [--document]");
            std::process::exit(2);
        }
    };
    match result {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("lens-extract: {error:?}");
            std::process::exit(1);
        }
    }
}
