//! The site's shared authored contracts. JSON remains the authored data; Rust
//! defines its shape and verifies relationships before projections are emitted.
pub mod content;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct SiteManifest {
    pub version: u32,
    pub note: String,
    pub surfaces: Vec<Surface>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub path: String,
    pub title: String,
    pub section: String,
    pub kind: SurfaceKind,
    pub description: String,
    pub hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub flags: SurfaceFlags,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceKind {
    Content,
    Page,
    Section,
    Utility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SurfaceFlags {
    pub run: bool,
    pub taskbar: bool,
    pub sitemap: bool,
    pub gallery: bool,
    pub agents: bool,
    pub search_index: bool,
    pub webmention: bool,
}

/// Only validated manifests may enter a generator. Keep the constructor private
/// so successful deserialization alone cannot skip relationship validation.
#[derive(Debug)]
pub struct ValidatedManifest(SiteManifest);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError(pub String);
impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ValidationError {}

impl SiteManifest {
    pub fn validate(self) -> Result<ValidatedManifest, ValidationError> {
        if self.version != 1 {
            return Err(ValidationError(format!(
                "unsupported manifest version {}",
                self.version
            )));
        }
        if self.surfaces.is_empty() {
            return Err(ValidationError("manifest contains no surfaces".into()));
        }
        let mut paths = HashSet::new();
        for s in &self.surfaces {
            let path = s.path.as_str();
            if !path.starts_with('/')
                || path.starts_with("//")
                || path.contains(['?', '#', '\\'])
                || path.chars().any(|c| c.is_whitespace() || c.is_control())
                || path.split('/').any(|p| p == "." || p == "..")
            {
                return Err(ValidationError(format!("invalid document path {path:?}")));
            }
            if !paths.insert(path) {
                return Err(ValidationError(format!("duplicate surface {path}")));
            }
            for (name, value) in [
                ("title", &s.title),
                ("section", &s.section),
                ("description", &s.description),
            ] {
                if value.trim().is_empty() {
                    return Err(ValidationError(format!("{path}: empty {name}")));
                }
            }
        }
        Ok(ValidatedManifest(self))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema, TS)]
pub struct AgentSurface<'a> {
    pub path: &'a str,
    pub title: &'a str,
    pub kind: SurfaceKind,
    pub description: &'a str,
}

impl ValidatedManifest {
    pub fn manifest(&self) -> &SiteManifest {
        &self.0
    }
    pub fn agent_surfaces(&self) -> Vec<AgentSurface<'_>> {
        self.0
            .surfaces
            .iter()
            .filter(|s| s.flags.agents)
            .map(|s| AgentSurface {
                path: &s.path,
                title: &s.title,
                kind: s.kind,
                description: &s.description,
            })
            .collect()
    }
    pub fn webmention_sections(&self) -> Vec<&str> {
        self.0
            .surfaces
            .iter()
            .filter(|s| s.flags.webmention && s.kind == SurfaceKind::Section)
            .map(|s| s.path.as_str())
            .collect()
    }
    pub fn webmention_paths(&self) -> Vec<&str> {
        self.0
            .surfaces
            .iter()
            .filter(|s| s.flags.webmention)
            .map(|s| s.path.as_str())
            .collect()
    }
}

/// Bindings are emitted explicitly, never by tests, so validation is read-only.
pub fn typescript() -> String {
    let config = ts_rs::Config::default();
    let declarations = [
        SiteManifest::decl(&config),
        Surface::decl(&config),
        SurfaceKind::decl(&config),
        SurfaceFlags::decl(&config),
        AgentSurface::decl(&config),
    ];
    let mut output =
        String::from("// Generated from tools/site/crates/site-model; run bun run gen:manifest.\n");
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&declaration);
        output.push('\n');
    }
    output.push_str(&content::typescript());
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authored() -> SiteManifest {
        serde_json::from_str(include_str!("../../../../../config/site-manifest.json")).unwrap()
    }
    #[test]
    fn repository_manifest_validates_and_roundtrips_without_losing_fields() {
        let source: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../config/site-manifest.json")).unwrap();
        let checked = authored().validate().unwrap();
        assert_eq!(serde_json::to_value(checked.manifest()).unwrap(), source);
        assert_eq!(
            checked.agent_surfaces().len(),
            checked
                .manifest()
                .surfaces
                .iter()
                .filter(|s| s.flags.agents)
                .count()
        );
    }
    #[test]
    fn duplicate_routes_and_unknown_versions_are_rejected() {
        let mut m = authored();
        m.surfaces.push(m.surfaces[0].clone());
        assert!(m.validate().unwrap_err().0.contains("duplicate"));
        let mut m = authored();
        m.version = 2;
        assert!(m.validate().unwrap_err().0.contains("version"));
    }
    #[test]
    fn routing_ambiguities_are_rejected() {
        for path in [
            "https://other.test",
            "//other.test",
            "/foo?q=x",
            "/foo#bar",
            "/foo/../bar",
            "/foo\\bar",
            "/foo bar",
        ] {
            let mut m = authored();
            m.surfaces[0].path = path.into();
            assert!(m.validate().is_err(), "accepted {path}");
        }
    }
    #[test]
    fn misspelled_fields_and_missing_flags_fail_deserialization() {
        let mut value = serde_json::to_value(authored()).unwrap();
        value["surfaces"][0]["flags"]["searchindex"] = true.into();
        assert!(serde_json::from_value::<SiteManifest>(value).is_err());
        let mut value = serde_json::to_value(authored()).unwrap();
        value["surfaces"][0]["flags"]
            .as_object_mut()
            .unwrap()
            .remove("searchIndex");
        assert!(serde_json::from_value::<SiteManifest>(value).is_err());
    }
}
