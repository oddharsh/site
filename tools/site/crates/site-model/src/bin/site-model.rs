use site_model::{AgentSurface, SiteManifest};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Projection<'a> {
    agent_surfaces: Vec<AgentSurface<'a>>,
    webmention_paths: Vec<&'a str>,
    webmention_sections: Vec<&'a str>,
}
use std::error::Error;
use std::io::{self, Write};

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let command = args
        .next()
        .ok_or("usage: site-model schema | page-schema | typescript | check <manifest> | project <manifest> | pages <spec>...")?;
    if command == "pages" {
        let paths: Vec<_> = args.collect();
        if paths.is_empty() {
            return Err("pages requires at least one spec path".into());
        }
        let mut checked = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for path in paths {
            let raw = std::fs::read_to_string(&path)?;
            let page = serde_json::from_str::<site_model::content::GaragePage>(&raw)?
                .validate()
                .map_err(|e| format!("{path}: {e}"))?;
            if !ids.insert(page.page().id.clone()) {
                return Err(format!("duplicate page {}", page.page().id).into());
            }
            checked.push(page);
        }
        serde_json::to_writer(
            io::stdout().lock(),
            &checked.iter().map(|p| p.page()).collect::<Vec<_>>(),
        )?;
        println!();
        return Ok(());
    }
    if command == "page-schema" {
        if args.next().is_some() {
            return Err("page-schema accepts no arguments".into());
        }
        serde_json::to_writer_pretty(
            io::stdout().lock(),
            &schemars::schema_for!(site_model::content::GaragePage),
        )?;
        println!();
        return Ok(());
    }
    if command == "typescript" {
        if args.next().is_some() {
            return Err("typescript accepts no arguments".into());
        }
        print!("{}", site_model::typescript());
        return Ok(());
    }
    if command == "schema" {
        if args.next().is_some() {
            return Err("schema accepts no arguments".into());
        }
        serde_json::to_writer_pretty(io::stdout().lock(), &schemars::schema_for!(SiteManifest))?;
        println!();
        return Ok(());
    }
    if command != "check" && command != "project" {
        return Err(format!("unknown command {command:?}").into());
    }
    let path = args.next().ok_or("a manifest path is required")?;
    if args.next().is_some() {
        return Err("unexpected extra argument".into());
    }
    let raw = std::fs::read_to_string(path)?;
    let checked = serde_json::from_str::<SiteManifest>(&raw)?.validate()?;
    if command == "check" {
        println!(
            "site-model: {} surfaces validated",
            checked.manifest().surfaces.len()
        );
    } else {
        let output = Projection {
            agent_surfaces: checked.agent_surfaces(),
            webmention_paths: checked.webmention_paths(),
            webmention_sections: checked.webmention_sections(),
        };
        let mut stdout = io::stdout().lock();
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
    }
    Ok(())
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("site-model: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
