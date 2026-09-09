//! One component definition feeds native rendering and typed Worker code.
use serde_json::{Map, Value};

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Html,
    Count,
    Rows(&'static Component),
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
    OrText(&'static str, &'static str),
}
struct Component {
    name: &'static str,
    fields: &'static [Field],
    parts: &'static [Part],
}

const WINDOW_FIELDS: &[Field] = &[
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

const WINDOW_PARTS: &[Part] = &[
    Part::Literal("<div class=\"window"), Part::Prefix("windowClass"), Part::Literal("\""), Part::Prefix("windowAttrs"),
    Part::Literal(">\n  <div class=\"title-bar\">\n    <span class=\"title-text"), Part::Prefix("titleClass"),
    Part::Literal("\"><span class=\"icon\"></span>"), Part::Value("caption"),
    Part::Literal("</span>\n    <span class=\"controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span><a class=\"close\" href=\""),
    Part::Value("closeHref"), Part::Literal("\" title=\""), Part::Value("closeTitle"), Part::Literal("\" aria-label=\""),
    Part::Value("closeLabel"), Part::Literal("\"></a></span>\n  </div>"), Part::Value("address"), Part::Literal("\n  "),
    Part::Value("pane"), Part::Literal("<div class=\"content"), Part::Prefix("contentClass"), Part::Literal("\">\n"),
    Part::Value("body"), Part::Literal("\n  </div>\n</div>"),
];

const WINDOW: Component = Component {
    name: "Window",
    fields: WINDOW_FIELDS,
    parts: WINDOW_PARTS,
};
const PROPERTY_ROW: Component = Component {
    name: "PropertyRow",
    fields: &[
        Field {
            name: "term",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "value",
            kind: Kind::Text,
            default: Default::Required,
        },
    ],
    parts: &[
        Part::Literal("<dt>"),
        Part::Value("term"),
        Part::Literal("</dt><dd>"),
        Part::Value("value"),
        Part::Literal("</dd>"),
    ],
};
const PROPERTY_SHEET: Component = Component {
    name: "PropertySheet",
    fields: &[Field {
        name: "rows",
        kind: Kind::Rows(&PROPERTY_ROW),
        default: Default::Required,
    }],
    parts: &[
        Part::Literal("<dl>"),
        Part::Value("rows"),
        Part::Literal("</dl>"),
    ],
};

const EXPLORER_ITEM: Component = Component {
    name: "ExplorerItem",
    fields: &[
        Field {
            name: "href",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "label",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "glyph",
            kind: Kind::Text,
            default: Default::Text(""),
        },
    ],
    parts: &[
        Part::Literal("<li><span class=\"axp-glyph\" aria-hidden=\"true\">"),
        Part::OrText("glyph", "›"),
        Part::Literal("</span><a href=\""),
        Part::Value("href"),
        Part::Literal("\">"),
        Part::Value("label"),
        Part::Literal("</a></li>"),
    ],
};
const EXPLORER_LIST: Component = Component {
    name: "ExplorerList",
    fields: &[Field {
        name: "items",
        kind: Kind::Rows(&EXPLORER_ITEM),
        default: Default::Required,
    }],
    parts: &[
        Part::Literal("<ul>"),
        Part::Value("items"),
        Part::Literal("</ul>"),
    ],
};

const TASKBAR_PIN: Component = Component {
    name: "TaskbarPin",
    fields: &[
        Field {
            name: "href",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "label",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "hint",
            kind: Kind::Text,
            default: Default::Required,
        },
        Field {
            name: "count",
            kind: Kind::Count,
            default: Default::Required,
        },
        Field {
            name: "icon",
            kind: Kind::Html,
            default: Default::Required,
        },
    ],
    parts: &[
        Part::Literal("<a class=\"axp-pin\" title=\""),
        Part::Value("hint"),
        Part::Literal("\" href=\""),
        Part::Value("href"),
        Part::Literal("\" data-count=\""),
        Part::Value("count"),
        Part::Literal("\"><span class=\"fav\" aria-hidden=\"true\">"),
        Part::Value("icon"),
        Part::Literal("</span><span class=\"lbl\">"),
        Part::Value("label"),
        Part::Literal("</span></a>"),
    ],
};
const TASKBAR: Component = Component { name: "Taskbar", fields: &[
    Field { name: "pins", kind: Kind::Html, default: Default::Required },
    Field { name: "tray", kind: Kind::Html, default: Default::Required },
], parts: &[
    Part::Literal("<div id=\"axp-taskbar\" role=\"navigation\" aria-label=\"taskbar\"><a id=\"axp-start\" href=\"/run\" aria-haspopup=\"dialog\" aria-expanded=\"false\"><span id=\"axp-cone\" aria-hidden=\"true\"></span>start<span class=\"axp-kbd\" aria-hidden=\"true\">⌘K</span></a><div id=\"axp-pins\">"),
    Part::Value("pins"), Part::Literal("</div><div id=\"axp-spacer\"></div>"), Part::Value("tray"), Part::Literal("</div>"),
] };

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
fn field(component: &'static Component, name: &str) -> &'static Field {
    component
        .fields
        .iter()
        .find(|f| f.name == name)
        .expect("declared component field")
}

/// Native render boundary. HTML slots are explicitly trusted authored markup,
/// just like the Worker's Html values; this function is not a sanitizer.
pub fn render_window(input: &Map<String, Value>) -> Result<String, String> {
    render(&WINDOW, input)
}
pub fn render_property_sheet(input: &Map<String, Value>) -> Result<String, String> {
    render(&PROPERTY_SHEET, input)
}
pub fn render_explorer_list(input: &Map<String, Value>) -> Result<String, String> {
    render(&EXPLORER_LIST, input)
}
pub fn render_taskbar(input: &Map<String, Value>) -> Result<String, String> {
    render(&TASKBAR, input)
}
pub fn render_taskbar_pin(input: &Map<String, Value>) -> Result<String, String> {
    render(&TASKBAR_PIN, input)
}
fn render(component: &'static Component, input: &Map<String, Value>) -> Result<String, String> {
    for key in input.keys() {
        if !component.fields.iter().any(|f| f.name == key) {
            return Err(format!("unknown {} field: {key}", component.name));
        }
    }
    let mut values: std::collections::BTreeMap<&str, Slot> = std::collections::BTreeMap::new();
    for f in component.fields {
        let value = match input.get(f.name) {
            Some(Value::Number(value)) if matches!(f.kind, Kind::Count) => {
                let number = value
                    .as_f64()
                    .ok_or("count must be a safe nonnegative integer")?;
                if !(0.0..=9_007_199_254_740_991.0).contains(&number) || number.fract() != 0.0 {
                    return Err("count must be a safe nonnegative integer".into());
                }
                Slot::Text((number as u64).to_string())
            }
            Some(Value::String(value)) if matches!(f.kind, Kind::Text | Kind::Html) => match f.kind
            {
                Kind::Text => Slot::Text(value.clone()),
                Kind::Html => Slot::Html(value.clone()),
                Kind::Rows(_) | Kind::Count => unreachable!("guard requires text or HTML"),
            },
            Some(Value::Array(rows)) if matches!(f.kind, Kind::Rows(_)) => {
                let Kind::Rows(row) = f.kind else {
                    unreachable!("guard requires rows")
                };
                let mut rendered = String::new();
                for value in rows {
                    rendered.push_str(&render(
                        row,
                        value.as_object().ok_or("property row must be an object")?,
                    )?);
                }
                Slot::Html(rendered)
            }
            Some(_) => return Err(format!("{} {} has the wrong type", component.name, f.name)),
            None => match f.default {
                Default::Required => {
                    return Err(format!("{} {} is required", component.name, f.name))
                }
                Default::Text(value) => Slot::Text(value.into()),
                Default::EmptyHtml => Slot::EmptyHtml,
                Default::Previous(name) => values.get(name).expect("earlier default field").clone(),
            },
        };
        values.insert(f.name, value);
    }
    let mut out = String::new();
    for part in component.parts {
        let (name, prefix) = match part {
            Part::OrText(name, fallback) => {
                let Slot::Text(value) = &values[name] else {
                    panic!("text fallback requires a text field")
                };
                out.push_str(&escape(if value.is_empty() { fallback } else { value }));
                continue;
            }
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
    module(&[&WINDOW])
}
pub fn property_sheet_typescript() -> String {
    module(&[&PROPERTY_ROW, &PROPERTY_SHEET])
}
pub fn explorer_list_typescript() -> String {
    module(&[&EXPLORER_ITEM, &EXPLORER_LIST])
}
pub fn taskbar_typescript() -> String {
    module(&[&TASKBAR_PIN, &TASKBAR])
}
fn module(components: &[&'static Component]) -> String {
    let empty = if components.iter().any(|c| {
        c.fields
            .iter()
            .any(|f| matches!(f.default, Default::EmptyHtml))
    }) {
        "EMPTY, "
    } else {
        ""
    };
    let mut out = format!("// Generated by tools/xp; run bun tools/gen-xp.ts. Do not edit.\nimport {{ {empty}Html, html }} from \"../html.ts\";\n\n");
    for (index, component) in components.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&typescript_component(component));
    }
    out
}
fn typescript_component(component: &'static Component) -> String {
    let mut out = format!("export type {}Options = {{\n", component.name);
    for f in component.fields {
        out.push_str(&format!(
            "  {}{}: {};\n",
            f.name,
            if matches!(f.default, Default::Required) {
                ""
            } else {
                "?"
            },
            match f.kind {
                Kind::Text => "string".to_string(),
                Kind::Count => "number".to_string(),
                Kind::Html => "Html".to_string(),
                Kind::Rows(row) => format!("{}Options[]", row.name),
            }
        ));
    }
    out.push_str(&format!("}};\n\nexport function {}({{\n", component.name));
    for f in component.fields {
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
    out.push_str(&format!("}}: {}Options): Html {{\n", component.name));
    for f in component.fields {
        if matches!(f.kind, Kind::Count) {
            out.push_str(&format!("  if (!Number.isSafeInteger({0}) || {0} < 0) throw new Error(\"count must be a safe nonnegative integer\");\n", f.name));
        }
    }
    out.push_str("  return html`");
    for part in component.parts {
        match part {
            Part::OrText(name, fallback) => out.push_str(&format!(
                "${{{name} || {}}}",
                serde_json::to_string(fallback).unwrap()
            )),
            Part::Literal(value) => out.push_str(
                &value
                    .replace('\\', "\\\\")
                    .replace('`', "\\`")
                    .replace("${", "\\${"),
            ),
            Part::Value(name) => match field(component, name).kind {
                Kind::Rows(row) => out.push_str(&format!("${{{name}.map({})}}", row.name)),
                _ => out.push_str(&format!("${{{name}}}")),
            },
            Part::Prefix(name) => match field(component, name).kind {
                Kind::Rows(_) | Kind::Count => panic!("row lists and counts cannot have a prefix"),
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
