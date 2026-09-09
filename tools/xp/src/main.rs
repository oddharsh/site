use std::io::Read;
fn run() -> Result<String, String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode] if mode == "typescript" => Ok(site_xp::typescript()),
        [mode] if mode == "typescript-property-sheet" => Ok(site_xp::property_sheet_typescript()),
        [mode] if mode == "typescript-explorer-list" => Ok(site_xp::explorer_list_typescript()),
        [mode] if mode == "typescript-taskbar" => Ok(site_xp::taskbar_typescript()),
        [mode] if mode == "render" || mode == "render-batch" || mode == "render-property-sheet-batch" || mode == "render-explorer-list-batch" || mode == "render-taskbar-batch" || mode == "render-taskbar-pin-batch" || mode == "render-taskbar-tray-batch" => {
            let mut input = String::new();
            std::io::stdin()
                .take(4 * 1024 * 1024 + 1)
                .read_to_string(&mut input)
                .map_err(|e| e.to_string())?;
            if input.len() > 4 * 1024 * 1024 {
                return Err("component input exceeds 4 MiB".into());
            }
            let value: serde_json::Value =
                serde_json::from_str(&input).map_err(|e| e.to_string())?;
            if mode.ends_with("-batch") {
                let values = value.as_array().ok_or("component batch must be an array")?;
                let rendered: Result<Vec<_>, String> = values
                    .iter()
                    .map(|value| {
                        let object = value.as_object().ok_or("component input must be an object")?;
                        if mode == "render-taskbar-tray-batch" { site_xp::render_taskbar_tray(object) }
                        else if mode == "render-taskbar-pin-batch" { site_xp::render_taskbar_pin(object) }
                        else if mode == "render-taskbar-batch" { site_xp::render_taskbar(object) }
                        else if mode == "render-explorer-list-batch" { site_xp::render_explorer_list(object) }
                        else if mode == "render-property-sheet-batch" { site_xp::render_property_sheet(object) }
                        else { site_xp::render_window(object) }
                    })
                    .collect();
                serde_json::to_string(&rendered?).map_err(|e| e.to_string())
            } else {
                site_xp::render_window(value.as_object().ok_or("Window input must be an object")?)
            }
        }
        _ => Err("usage: site-xp typescript|typescript-property-sheet|typescript-explorer-list|typescript-taskbar|render|render-batch|render-property-sheet-batch|render-explorer-list-batch|render-taskbar-batch|render-taskbar-pin-batch|render-taskbar-tray-batch".into()),
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
