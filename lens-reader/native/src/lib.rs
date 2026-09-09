//! Bounded HTML tree construction and metadata projection for native Lens.
mod tree;
use html5ever::{parse_document, tendril::TendrilSink, tree_builder::TreeBuilderOpts, ParseOpts};
use serde::Serialize;
use std::io::Read;
use tree::{Kind, Tree};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub nodes: usize,
    pub tree_bytes: usize,
    pub depth: usize,
    pub field_bytes: usize,
    pub entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 2 * 1024 * 1024,
            nodes: 65536,
            depth: 256,
            tree_bytes: 16 * 1024 * 1024,
            field_bytes: 4096,
            entries: 256,
        }
    }
}
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub version: u8,
    pub title: String,
    pub meta: Vec<Meta>,
    pub links: Vec<Link>,
    pub input_bytes: usize,
    pub truncated: bool,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Meta {
    pub name: String,
    pub content: String,
}
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Link {
    pub rel: String,
    pub href: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ExtractError {
    InputLimit,
    NodeLimit,
    TreeLimit,
    DepthLimit,
    InvalidLimits,
    Read,
}

fn append_bounded(target: &mut String, value: &str, cap: usize) -> bool {
    let available = cap.saturating_sub(target.len());
    let mut end = value.len().min(available);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    target.push_str(&value[..end]);
    end < value.len()
}
fn field(value: &str, cap: usize, truncated: &mut bool) -> String {
    let mut result = String::new();
    *truncated |= append_bounded(&mut result, value, cap);
    result
}

fn parse(mut input: impl Read, limits: Limits) -> Result<(Tree, usize), ExtractError> {
    if limits.input_bytes == 0
        || limits.nodes == 0
        || limits.depth == 0
        || limits.tree_bytes == 0
        || limits.field_bytes == 0
        || limits.entries == 0
    {
        return Err(ExtractError::InvalidLimits);
    }
    let tree = Tree::new(limits.tree_bytes, limits.depth);
    // The existing Reader parses noscript for lazy-image recovery. Scripting is
    // disabled for this parse too; no scripts are ever executed by either path.
    let opts = ParseOpts {
        tree_builder: TreeBuilderOpts {
            scripting_enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut parser = parse_document(tree.clone(), opts).from_utf8();
    let mut buffer = [0u8; 1024];
    let mut bytes = 0usize;
    loop {
        let n = input.read(&mut buffer).map_err(|_| ExtractError::Read)?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n).ok_or(ExtractError::InputLimit)?;
        if bytes > limits.input_bytes {
            return Err(ExtractError::InputLimit);
        }
        parser.process(buffer[..n].into());
        if tree.depth_exceeded.get() {
            return Err(ExtractError::DepthLimit);
        }
        if tree.exceeded.get() {
            return Err(ExtractError::TreeLimit);
        }
        if tree.nodes.borrow().len() > limits.nodes {
            return Err(ExtractError::NodeLimit);
        }
    }
    let tree = parser.finish();
    if tree.depth_exceeded.get() {
        return Err(ExtractError::DepthLimit);
    }
    if tree.exceeded.get() {
        return Err(ExtractError::TreeLimit);
    }
    if tree.nodes.borrow().len() > limits.nodes {
        return Err(ExtractError::NodeLimit);
    }
    Ok((tree, bytes))
}

/// Project active-document metadata from the tree. Template contents live in
/// separate fragments and are not traversed, matching the Reader's selectors.
/// Node budgets are checked between 1 KiB feeds and at EOF; one feed may
/// temporarily exceed the node limit. This is not a process RSS limit.
pub fn extract_metadata(input: impl Read, limits: Limits) -> Result<Metadata, ExtractError> {
    let (tree, input_bytes) = parse(input, limits)?;
    let nodes = tree.nodes.borrow();
    let mut result = Metadata {
        version: 1,
        title: String::new(),
        meta: vec![],
        links: vec![],
        input_bytes,
        truncated: false,
    };
    let mut title_seen = false;
    let mut stack = vec![0];
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
        match name.local.as_ref() {
            "title" if !title_seen => {
                title_seen = true;
                // Foreign (SVG) titles can contain elements: textContent
                // includes every descendant, not only immediate text nodes.
                let mut descendants: Vec<_> = node.children.iter().rev().copied().collect();
                while let Some(child) = descendants.pop() {
                    descendants.extend(nodes[child].children.iter().rev().copied());
                    if let Kind::Text(text) = &nodes[child].kind {
                        if append_bounded(&mut result.title, text, limits.field_bytes) {
                            result.truncated = true;
                            break;
                        }
                    }
                }
            }
            "meta" => {
                if let (Some(name), Some(content)) =
                    (attr("name").or_else(|| attr("property")), attr("content"))
                {
                    if result.meta.len() + result.links.len() >= limits.entries {
                        result.truncated = true;
                        continue;
                    }
                    result.meta.push(Meta {
                        name: field(name, limits.field_bytes, &mut result.truncated),
                        content: field(content, limits.field_bytes, &mut result.truncated),
                    });
                }
            }
            "link" => {
                if let (Some(rel), Some(href)) = (attr("rel"), attr("href")) {
                    if result.meta.len() + result.links.len() >= limits.entries {
                        result.truncated = true;
                        continue;
                    }
                    result.links.push(Link {
                        rel: field(rel, limits.field_bytes, &mut result.truncated),
                        href: field(href, limits.field_bytes, &mut result.truncated),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entities_and_first_title_are_preserved() {
        let html = r#"<title>Résumé &amp; tea</title><title>ignored</title><meta property="og:title" content="A &quot;quote&quot;"><link rel="canonical" href="/x?a=1&amp;b=2">"#;
        let result = extract_metadata(html.as_bytes(), Limits::default()).unwrap();
        assert_eq!(result.title, "Résumé & tea");
        assert_eq!(result.meta[0].content, "A \"quote\"");
        assert_eq!(result.links[0].href, "/x?a=1&b=2");
        assert!(!result.truncated);
    }
    struct Chunks<'a> {
        data: &'a [u8],
        size: usize,
    }
    #[test]
    fn foreign_title_includes_descendant_text_with_a_shared_limit() {
        let html = "<svg><title>A <span>雪 &amp; tea</span> end</title></svg>";
        let result = extract_metadata(html.as_bytes(), Limits::default()).unwrap();
        assert_eq!(result.title, "A 雪 & tea end");
        assert!(!result.truncated);
        let limited = extract_metadata(
            html.as_bytes(),
            Limits {
                field_bytes: 6,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(limited.title, "A 雪 ");
        assert!(limited.truncated);
    }
    impl Read for Chunks<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.data.len().min(self.size).min(buf.len());
            buf[..n].copy_from_slice(&self.data[..n]);
            self.data = &self.data[n..];
            Ok(n)
        }
    }
    #[test]
    fn chunk_boundaries_do_not_change_metadata() {
        let html = "<title>雪 &amp; résumé</title><meta name='description' content='snow &amp; tea'><script>\"<meta name='bad' content='bad'>\"</script>";
        let whole = extract_metadata(html.as_bytes(), Limits::default()).unwrap();
        for size in 1..=html.len() {
            let split = extract_metadata(
                Chunks {
                    data: html.as_bytes(),
                    size,
                },
                Limits::default(),
            )
            .unwrap();
            assert_eq!(split, whole, "chunk size {size}");
        }
        assert_eq!(whole.meta.len(), 1);
    }
    #[test]
    fn input_limit_refuses_partial_success() {
        let input = b"<title>valid</title>trailing";
        let limits = Limits {
            input_bytes: input.len() - 1,
            ..Limits::default()
        };
        assert_eq!(
            extract_metadata(&input[..], limits),
            Err(ExtractError::InputLimit)
        );
    }
    #[test]
    fn retained_fields_and_entries_are_bounded() {
        let input = "<title>雪雪雪</title><meta name='a' content='123456'><link rel='next' href='/a'><meta name='b' content='ignored'>";
        let result = extract_metadata(
            input.as_bytes(),
            Limits {
                field_bytes: 5,
                entries: 2,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.title, "雪");
        assert_eq!(result.meta[0].content, "12345");
        assert_eq!(result.meta.len() + result.links.len(), 2);
        assert!(result.truncated);
    }
    #[test]
    fn truncated_unicode_is_independent_of_chunk_boundaries() {
        let html = "<title>雪雪x</title>";
        let limits = Limits {
            field_bytes: 5,
            ..Limits::default()
        };
        let whole = extract_metadata(html.as_bytes(), limits).unwrap();
        assert_eq!(whole.title, "雪");
        for size in 1..=html.len() {
            assert_eq!(
                extract_metadata(
                    Chunks {
                        data: html.as_bytes(),
                        size
                    },
                    limits
                )
                .unwrap(),
                whole
            );
        }
    }
    #[test]
    fn node_budget_refuses_a_large_tree() {
        let html = "<p>x</p>".repeat(100);
        let limits = Limits {
            nodes: 10,
            ..Limits::default()
        };
        assert_eq!(
            extract_metadata(
                Chunks {
                    data: html.as_bytes(),
                    size: 16
                },
                limits
            ),
            Err(ExtractError::NodeLimit)
        );
    }
    #[test]
    fn retained_tree_budget_rejects_large_text_and_attributes() {
        let limits = Limits {
            tree_bytes: 1024,
            ..Limits::default()
        };
        for html in [
            format!("<p>{}</p>", "x".repeat(4096)),
            format!("<meta name='x' content='{}'>", "x".repeat(4096)),
        ] {
            assert_eq!(
                extract_metadata(html.as_bytes(), limits),
                Err(ExtractError::TreeLimit)
            );
        }
    }
    #[test]
    fn noscript_is_parsed_and_template_contents_are_inert() {
        let html = "<head><noscript><link rel='a' href='/visible'></noscript><template><meta name='bad' content='bad'><link rel='b' href='/inert'></template></head>";
        let result = extract_metadata(html.as_bytes(), Limits::default()).unwrap();
        assert_eq!(
            result.links,
            vec![Link {
                rel: "a".into(),
                href: "/visible".into()
            }]
        );
        assert!(result.meta.is_empty());
    }
    #[test]
    fn repaired_trees_keep_consistent_parent_links() {
        for html in [
            "<table>before<tr><td>inside</table>after",
            "<p><b>one<i>two</b>three</i>",
            "<template><table><p>x</template><p>outside",
            "<svg><foreignObject><p>x</p></foreignObject></svg>",
        ] {
            let (tree, _) = parse(html.as_bytes(), Limits::default()).unwrap();
            let nodes = tree.nodes.borrow();
            let mut references = vec![0usize; nodes.len()];
            for (parent, node) in nodes.iter().enumerate() {
                for &child in &node.children {
                    assert_eq!(nodes[child].parent, Some(parent));
                    references[child] += 1;
                }
            }
            assert!(references.iter().all(|&n| n <= 1));
            for (id, node) in nodes.iter().enumerate() {
                assert_eq!(references[id], usize::from(node.parent.is_some()));
            }
        }
    }
    #[test]
    fn deeply_nested_input_traverses_and_drops_without_recursion() {
        let html = format!(
            "{}<link rel='x' href='/found'>{}",
            "<div>".repeat(10000),
            "</div>".repeat(10000)
        );
        let result = extract_metadata(
            html.as_bytes(),
            Limits {
                depth: 20000,
                ..Limits::default()
            },
        )
        .unwrap();
        assert_eq!(result.links.len(), 1);
    }
    #[test]
    fn default_depth_budget_rejects_hostile_nesting() {
        let html = "<div>".repeat(10000);
        assert_eq!(
            extract_metadata(html.as_bytes(), Limits::default()),
            Err(ExtractError::DepthLimit)
        );
    }
    #[test]
    fn invalid_limits_and_read_errors_are_explicit() {
        assert_eq!(
            extract_metadata(
                &b""[..],
                Limits {
                    field_bytes: 0,
                    ..Limits::default()
                }
            ),
            Err(ExtractError::InvalidLimits)
        );
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("private details"))
            }
        }
        assert_eq!(
            extract_metadata(Broken, Limits::default()),
            Err(ExtractError::Read)
        );
    }
}
