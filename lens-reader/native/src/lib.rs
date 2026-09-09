//! Bounded native extraction. Metadata is the first stage; article extraction
//! and the runtime adapter will consume the same parser boundary.
use lol_html::{element, end_tag, text, HtmlRewriter, MemorySettings, Settings};
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    io::Read,
    rc::Rc,
};

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub input_bytes: usize,
    pub parser_bytes: usize,
    pub field_bytes: usize,
    pub entries: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_bytes: 2 * 1024 * 1024,
            parser_bytes: 1024 * 1024,
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
    InvalidLimits,
    Read,
    Parse,
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
    let decoded = html_escape::decode_html_entities(value);
    let mut result = String::new();
    *truncated |= append_bounded(&mut result, &decoded, cap);
    result
}

/// Reads fixed-size chunks. A failed extraction returns no partial result.
/// `parser_bytes` controls lol_html's accounted buffers, not total process RSS.
pub fn extract_metadata(mut input: impl Read, limits: Limits) -> Result<Metadata, ExtractError> {
    if limits.input_bytes == 0
        || limits.parser_bytes < 1024
        || limits.field_bytes == 0
        || limits.entries == 0
    {
        return Err(ExtractError::InvalidLimits);
    }
    let result = RefCell::new(Metadata {
        version: 1,
        title: String::new(),
        meta: Vec::new(),
        links: Vec::new(),
        input_bytes: 0,
        truncated: false,
    });
    let title_seen = RefCell::new(false);
    let title_truncated = Cell::new(false);
    let title_active = Rc::new(Cell::new(false));
    let settings = Settings::new()
        .with_memory_settings(
            MemorySettings::new().with_max_allowed_memory_usage(limits.parser_bytes),
        )
        .append_element_content_handler(element!("title", |el| {
            if !*title_seen.borrow() {
                *title_seen.borrow_mut() = true;
                title_active.set(true);
                let active = Rc::clone(&title_active);
                el.on_end_tag(end_tag!(move |_| {
                    active.set(false);
                    Ok(())
                }))?;
            }
            Ok(())
        }))
        .append_element_content_handler(text!("title", |chunk| {
            if title_active.get() && !title_truncated.get() {
                let mut r = result.borrow_mut();
                let truncated = append_bounded(&mut r.title, chunk.as_str(), limits.field_bytes);
                title_truncated.set(truncated);
                r.truncated |= truncated;
            }
            Ok(())
        }))
        .append_element_content_handler(element!("meta", |el| {
            let mut r = result.borrow_mut();
            if r.meta.len() + r.links.len() >= limits.entries {
                r.truncated = true;
                return Ok(());
            }
            if let (Some(name), Some(content)) = (
                el.get_attribute("name")
                    .or_else(|| el.get_attribute("property")),
                el.get_attribute("content"),
            ) {
                let name = field(&name, limits.field_bytes, &mut r.truncated);
                let content = field(&content, limits.field_bytes, &mut r.truncated);
                r.meta.push(Meta { name, content });
            }
            Ok(())
        }))
        .append_element_content_handler(element!("link", |el| {
            let mut r = result.borrow_mut();
            if r.meta.len() + r.links.len() >= limits.entries {
                r.truncated = true;
                return Ok(());
            }
            if let (Some(rel), Some(href)) = (el.get_attribute("rel"), el.get_attribute("href")) {
                let rel = field(&rel, limits.field_bytes, &mut r.truncated);
                let href = field(&href, limits.field_bytes, &mut r.truncated);
                r.links.push(Link { rel, href });
            }
            Ok(())
        }));
    let mut parser = HtmlRewriter::new(settings, |_: &[u8]| {});
    let mut buffer = [0u8; 8192];
    loop {
        let n = input.read(&mut buffer).map_err(|_| ExtractError::Read)?;
        if n == 0 {
            break;
        }
        let total = result
            .borrow()
            .input_bytes
            .checked_add(n)
            .ok_or(ExtractError::InputLimit)?;
        if total > limits.input_bytes {
            return Err(ExtractError::InputLimit);
        }
        result.borrow_mut().input_bytes = total;
        parser
            .write(&buffer[..n])
            .map_err(|_| ExtractError::Parse)?;
    }
    parser.end().map_err(|_| ExtractError::Parse)?;
    let mut result = result.into_inner();
    result.title = field(&result.title, limits.field_bytes, &mut result.truncated);
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
    fn parser_budget_refuses_an_oversized_token() {
        let html = format!("<meta name='description' content='{}'>", "a".repeat(32768));
        let limits = Limits {
            parser_bytes: 1024,
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
            Err(ExtractError::Parse)
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
