use std::io::Read;
fn run() -> Result<String, String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode] if mode == "typescript" => Ok(site_xp::typescript()),
        [mode] if mode == "render" || mode == "render-batch" => {
            let mut input = String::new();
            std::io::stdin()
                .take(4 * 1024 * 1024 + 1)
                .read_to_string(&mut input)
                .map_err(|e| e.to_string())?;
            if input.len() > 4 * 1024 * 1024 {
                return Err("Window input exceeds 4 MiB".into());
            }
            let value: serde_json::Value =
                serde_json::from_str(&input).map_err(|e| e.to_string())?;
            if mode == "render-batch" {
                let values = value.as_array().ok_or("Window batch must be an array")?;
                let rendered: Result<Vec<_>, String> = values
                    .iter()
                    .map(|value| {
                        site_xp::render_window(
                            value.as_object().ok_or("Window input must be an object")?,
                        )
                    })
                    .collect();
                serde_json::to_string(&rendered?).map_err(|e| e.to_string())
            } else {
                site_xp::render_window(value.as_object().ok_or("Window input must be an object")?)
            }
        }
        _ => Err("usage: site-xp typescript|render|render-batch".into()),
    }
}
fn main() {
    match run() {
        Ok(output) => print!("{output}"),
        Err(error) => {
            eprintln!("site-xp: {error}");
            std::process::exit(1);
        }
    }
}
