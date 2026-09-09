use std::process::Command;

#[test]
fn schema_is_derived_from_the_same_contract_as_deserialization() {
    let output = Command::new(env!("CARGO_BIN_EXE_site-model"))
        .arg("schema")
        .output()
        .unwrap();
    assert!(output.status.success());
    let schema: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    let flags = &schema["$defs"]["SurfaceFlags"];
    assert!(flags["required"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("searchIndex")));
    assert_eq!(flags["additionalProperties"], false);
}

#[test]
fn projection_matches_the_authored_filter_and_preserves_order() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../config/site-manifest.json");
    let output = Command::new(env!("CARGO_BIN_EXE_site-model"))
        .arg("project")
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let projected: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let authored: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let expected: Vec<_> = authored["surfaces"].as_array().unwrap().iter()
        .filter(|s| s["flags"]["agents"] == true)
        .map(|s| serde_json::json!({"path":s["path"],"title":s["title"],"kind":s["kind"],"description":s["description"]})).collect();
    assert_eq!(projected["agentSurfaces"], serde_json::json!(expected));
}

#[test]
fn invalid_invocations_do_not_emit_a_partial_artifact() {
    for args in [
        vec!["unknown"],
        vec!["project"],
        vec!["schema", "unexpected"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_site-model"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn committed_bindings_and_schema_match_the_rust_contract() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for (command, file) in [
        ("typescript", "manifest.ts"),
        ("schema", "manifest.schema.json"),
        ("page-schema", "page.schema.json"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_site-model"))
            .arg(command)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stdout,
            std::fs::read(root.join("generated").join(file)).unwrap(),
            "{file} is stale; run bun run gen:manifest"
        );
    }
}

#[test]
fn page_batch_is_atomic_on_missing_or_duplicate_input() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../pipelines/garage/specs/typed-config.json");
    for last in [path.clone(), path.with_file_name("nonexistent.json")] {
        let output = Command::new(env!("CARGO_BIN_EXE_site-model"))
            .arg("pages")
            .arg(&path)
            .arg(last)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}
