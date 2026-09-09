//! One component definition feeds native rendering and typed Worker code.
use serde_json::{Map, Value};

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Html,
}
enum Default {
    Required,
    Text(&'static str),
    EmptyHtml,
    Previous(&'static str),
}
struct Field {
    name: &'static str,
    kind: Kind,
    default: Default,
}
enum Part {
    Literal(&'static str),
    Value(&'static str),
    Prefix(&'static str),
}

const FIELDS: &[Field] = &[
    Field {
        name: "caption",
        kind: Kind::Text,
        default: Default::Required,
    },
    Field {
        name: "body",
        kind: Kind::Html,
        default: Default::EmptyHtml,
    },
    Field {
        name: "address",
        kind: Kind::Html,
        default: Default::EmptyHtml,
    },
    Field {
        name: "pane",
        kind: Kind::Html,
        default: Default::EmptyHtml,
    },
    Field {
        name: "titleClass",
        kind: Kind::Text,
        default: Default::Text(""),
    },
    Field {
        name: "windowClass",
        kind: Kind::Text,
        default: Default::Text(""),
    },
    Field {
        name: "contentClass",
        kind: Kind::Text,
        default: Default::Text(""),
    },
    Field {
        name: "windowAttrs",
        kind: Kind::Html,
        default: Default::EmptyHtml,
    },
    Field {
        name: "closeHref",
        kind: Kind::Text,
        default: Default::Text("/"),
    },
    Field {
        name: "closeTitle",
        kind: Kind::Text,
        default: Default::Text("back to aadhar.sh"),
    },
    Field {
        name: "closeLabel",
        kind: Kind::Text,
        default: Default::Previous("closeTitle"),
    },
];

const PARTS: &[Part] = &[
    Part::Literal("<div class=\"window"), Part::Prefix("windowClass"), Part::Literal("\""), Part::Prefix("windowAttrs"),
    Part::Literal(">\n  <div class=\"title-bar\">\n    <span class=\"title-text"), Part::Prefix("titleClass"),
    Part::Literal("\"><span class=\"icon\"></span>"), Part::Value("caption"),
    Part::Literal("</span>\n    <span class=\"controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span><a class=\"close\" href=\""),
    Part::Value("closeHref"), Part::Literal("\" title=\""), Part::Value("closeTitle"), Part::Literal("\" aria-label=\""),
    Part::Value("closeLabel"), Part::Literal("\"></a></span>\n  </div>"), Part::Value("address"), Part::Literal("\n  "),
    Part::Value("pane"), Part::Literal("<div class=\"content"), Part::Prefix("contentClass"), Part::Literal("\">\n"),
    Part::Value("body"), Part::Literal("\n  </div>\n</div>"),
];

#[derive(Clone)]
enum Slot {
    Text(String),
    Html(String),
    EmptyHtml,
}
fn escape(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}
fn field(name: &str) -> &'static Field {
    FIELDS
        .iter()
        .find(|f| f.name == name)
        .expect("declared component field")
}

/// Native render boundary. HTML slots are explicitly trusted authored markup,
/// just like the Worker's Html values; this function is not a sanitizer.
pub fn render_window(input: &Map<String, Value>) -> Result<String, String> {
    for key in input.keys() {
        if !FIELDS.iter().any(|f| f.name == key) {
            return Err(format!("unknown Window field: {key}"));
        }
    }
    let mut values: std::collections::BTreeMap<&str, Slot> = std::collections::BTreeMap::new();
    for f in FIELDS {
        let value = match input.get(f.name) {
            Some(Value::String(value)) => match f.kind {
                Kind::Text => Slot::Text(value.clone()),
                Kind::Html => Slot::Html(value.clone()),
            },
            Some(_) => return Err(format!("Window {} must be a string", f.name)),
            None => match f.default {
                Default::Required => return Err(format!("Window {} is required", f.name)),
                Default::Text(value) => Slot::Text(value.into()),
                Default::EmptyHtml => Slot::EmptyHtml,
                Default::Previous(name) => values.get(name).expect("earlier default field").clone(),
            },
        };
        values.insert(f.name, value);
    }
    let mut out = String::new();
    for part in PARTS {
        let (name, prefix) = match part {
            Part::Literal(value) => {
                out.push_str(value);
                continue;
            }
            Part::Value(name) => (name, false),
            Part::Prefix(name) => (name, true),
        };
        match &values[name] {
            Slot::EmptyHtml => {}
            Slot::Text(value) => {
                if prefix && !value.is_empty() {
                    out.push(' ');
                }
                out.push_str(&escape(value));
            }
            Slot::Html(value) => {
                if prefix {
                    out.push(' ');
                }
                out.push_str(value);
            }
        }
    }
    Ok(out)
}

/// Emit the existing tagged-template boundary, rather than a runtime interpreter.
pub fn typescript() -> String {
    let mut out = String::from("// Generated by tools/xp; run bun tools/gen-xp.ts. Do not edit.\nimport { EMPTY, Html, html } from \"../html.ts\";\n\nexport type WindowOptions = {\n");
    for f in FIELDS {
        out.push_str(&format!(
            "  {}{}: {};\n",
            f.name,
            if matches!(f.default, Default::Required) {
                ""
            } else {
                "?"
            },
            match f.kind {
                Kind::Text => "string",
                Kind::Html => "Html",
            }
        ));
    }
    out.push_str("};\n\nexport function Window({\n");
    for f in FIELDS {
        out.push_str(&format!("  {}", f.name));
        match f.default {
            Default::Required => {}
            Default::Text(value) => {
                out.push_str(&format!(" = {}", serde_json::to_string(value).unwrap()))
            }
            Default::EmptyHtml => out.push_str(" = EMPTY"),
            Default::Previous(name) => out.push_str(&format!(" = {name}")),
        }
        out.push_str(",\n");
    }
    out.push_str("}: WindowOptions): Html {\n  return html`");
    for part in PARTS {
        match part {
            Part::Literal(value) => out.push_str(
                &value
                    .replace('\\', "\\\\")
                    .replace('`', "\\`")
                    .replace("${", "\\${"),
            ),
            Part::Value(name) => out.push_str(&format!("${{{name}}}")),
            Part::Prefix(name) => match field(name).kind {
                Kind::Text => out.push_str(&format!("${{{name} ? \" \" + {name} : \"\"}}")),
                Kind::Html => out.push_str(&format!(
                    "${{{name} === EMPTY ? EMPTY : html` ${{{name}}}`}}"
                )),
            },
        }
    }
    out.push_str("`;\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_trusted_slots_are_distinct() {
        let input = serde_json::json!({"caption":"<&>","body":"<p>body</p>","closeTitle":"Custom"});
        let rendered = render_window(input.as_object().unwrap()).unwrap();
        assert!(rendered.contains("&lt;&amp;&gt;"));
        assert!(rendered.contains("<p>body</p>"));
        assert!(rendered.contains("aria-label=\"Custom\""));
        assert!(rendered.starts_with("<div class=\"window\">"));
    }
    #[test]
    fn native_boundary_refuses_unknown_missing_and_wrong_types() {
        for input in [
            serde_json::json!({}),
            serde_json::json!({"caption":null}),
            serde_json::json!({"caption":"x","extra":true}),
        ] {
            assert!(render_window(input.as_object().unwrap()).is_err());
        }
    }
}
