//! Source control labels, using the Reader's selector, ordering and UTF-16 length rule.
use crate::tree::{Kind, Tree};
use std::collections::HashSet;

// ECMAScript trim whitespace differs from Rust's Unicode White_Space set.
fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// Retain at most 59 UTF-16 units plus pending whitespace. Very long leading or
// trailing whitespace never expands storage, and is discarded just as trim does.
#[derive(Default)]
struct Label {
    text: String,
    pending: String,
    units: usize,
    pending_units: usize,
    seen: bool,
    too_long: bool,
}
impl Label {
    fn push(&mut self, text: &str) {
        self.seen |= !text.is_empty();
        for c in text.chars() {
            if self.too_long {
                break;
            }
            if whitespace(c) {
                if self.units > 0 && self.pending_units < 60 {
                    self.pending.push(c);
                    self.pending_units += c.len_utf16();
                }
            } else {
                self.units += self.pending_units + c.len_utf16();
                if self.units >= 60 {
                    self.too_long = true;
                    break;
                }
                self.text.push_str(&self.pending);
                self.pending.clear();
                self.pending_units = 0;
                self.text.push(c);
            }
        }
    }
    fn finish(self) -> Option<String> {
        (!self.too_long && self.units > 3).then_some(self.text)
    }
}

pub(crate) fn collect(tree: &Tree, cap: usize) -> (Vec<String>, bool) {
    let nodes = tree.nodes.borrow();
    let mut stack = vec![0];
    let mut labels = Vec::new();
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        let node = &nodes[id];
        stack.extend(node.children.iter().rev().copied());
        let Kind::Element { name, attrs, .. } = &node.kind else {
            continue;
        };
        let attr = |key: &str| {
            attrs
                .iter()
                .find(|a| a.name.local.as_ref() == key)
                .map(|a| a.value.as_ref())
        };
        if name.local.as_ref() != "button"
            && attr("role") != Some("button")
            && !(name.local.as_ref() == "input"
                && matches!(attr("type"), Some("submit" | "button")))
        {
            continue;
        }
        let mut label = Label::default();
        let mut children: Vec<_> = node.children.iter().rev().copied().collect();
        while let Some(child) = children.pop() {
            children.extend(nodes[child].children.iter().rev().copied());
            if let Kind::Text(text) = &nodes[child].kind {
                label.push(text);
            }
            if label.too_long {
                break;
            }
        }
        if !label.seen {
            label.push(attr("value").unwrap_or(""));
        }
        if let Some(text) = label.finish() {
            if seen.contains(&text) {
                continue;
            }
            if labels.len() == cap {
                return (labels, true);
            }
            seen.insert(text.clone());
            labels.push(text);
        }
    }
    (labels, false)
}

#[cfg(test)]
mod tests {
    use crate::{extract_document, Limits};
    #[test]
    fn labels_preserve_reader_selection_order_and_utf16_rules() {
        let html = "<button> Open <b>file</b> </button><input type=submit value='Send now'><button>Open file</button><button value='Wrong fallback'> </button><div role=button>😀😀</div><template><button>Inert</button></template>";
        let result = extract_document(html.as_bytes(), Limits::default()).unwrap();
        assert_eq!(result.control_labels, ["Open file", "Send now", "😀😀"]);
        assert!(!result.controls_truncated);
    }
    #[test]
    fn whitespace_and_entry_limits_do_not_publish_invented_labels() {
        let html = format!(
            "<button>{}Okay{}</button><button>Next one</button>",
            " ".repeat(10000),
            " ".repeat(10000)
        );
        let result = extract_document(
            html.as_bytes(),
            Limits {
                entries: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.control_labels, ["Okay"]);
        assert!(result.controls_truncated);
        let html = format!(
            "<button>Okay{}more</button><button>{}</button>",
            " ".repeat(10000),
            "😀".repeat(30)
        );
        assert!(extract_document(html.as_bytes(), Limits::default())
            .unwrap()
            .control_labels
            .is_empty());
    }
}
