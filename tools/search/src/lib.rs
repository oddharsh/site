//! Lossless corpus packing. Matching semantics belong to the query reader;
//! token boundaries here only share repeated source bytes across documents.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub const INPUT_CAP: usize = 16 * 1024 * 1024;
const MAGIC: &[u8] = b"SSIX\x01";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Corpus {
    pub version: u32,
    pub generated_at: String,
    pub records: Vec<Record>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub url: String,
    pub title: String,
    pub description: String,
    pub text: String,
    pub kind: Kind,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Page,
    Writing,
    Document,
    Utility,
}

fn integer(out: &mut Vec<u8>, mut value: usize) {
    while value >= 128 {
        out.push((value as u8 & 127) | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
fn string(out: &mut Vec<u8>, value: &str) {
    integer(out, value.len());
    out.extend_from_slice(value.as_bytes());
}

fn tokens(text: &str) -> impl Iterator<Item = &str> {
    // Non-word scalars are individual tokens: spaces and punctuation share
    // dictionary entries without altering whitespace, Unicode, or casing.
    let mut start = 0;
    std::iter::from_fn(move || {
        if start == text.len() {
            return None;
        }
        let tail = &text[start..];
        let first = tail.chars().next().expect("nonempty tail");
        let len = if first.is_alphanumeric() {
            tail.char_indices()
                .find(|(_, c)| !c.is_alphanumeric())
                .map_or(tail.len(), |(n, _)| n)
        } else {
            first.len_utf8()
        };
        let result = &text[start..start + len];
        start += len;
        Some(result)
    })
}

/// Emit a deterministic v1 corpus, with metadata and original text preserved.
/// No bytes are returned until the entire input has passed validation.
pub fn compile(input: &[u8]) -> Result<Vec<u8>, String> {
    if input.len() > INPUT_CAP {
        return Err("corpus exceeds 16 MiB".into());
    }
    let corpus: Corpus = serde_json::from_slice(input).map_err(|e| e.to_string())?;
    if corpus.version != 1 {
        return Err("unsupported corpus version".into());
    }
    let mut urls = HashSet::new();
    for record in &corpus.records {
        if !record.url.starts_with('/') || record.url.starts_with("//") || !urls.insert(&record.url)
        {
            return Err(format!("invalid or duplicate route: {}", record.url));
        }
    }
    let mut dictionary = Vec::new();
    let mut ids = HashMap::new();
    let mut documents = Vec::new();
    for record in &corpus.records {
        let mut document = Vec::new();
        let mut count = 0;
        for token in tokens(&record.text) {
            let id = *ids.entry(token).or_insert_with(|| {
                let id = dictionary.len();
                dictionary.push(token);
                id
            });
            integer(&mut document, id);
            count += 1;
        }
        documents.push((count, document));
    }
    let mut out = MAGIC.to_vec();
    string(&mut out, &corpus.generated_at);
    integer(&mut out, dictionary.len());
    for token in dictionary {
        string(&mut out, token);
    }
    integer(&mut out, corpus.records.len());
    for (record, (count, document)) in corpus.records.iter().zip(documents) {
        string(&mut out, &record.url);
        string(&mut out, &record.title);
        string(&mut out, &record.description);
        out.push(match record.kind {
            Kind::Page => 0,
            Kind::Writing => 1,
            Kind::Document => 2,
            Kind::Utility => 3,
        });
        integer(&mut out, count);
        out.extend(document);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokenization_is_lossless_for_all_text_classes() {
        for text in [
            "",
            "Snow 雪!\n\tTea",
            "e\u{301} Ελληνικά",
            "😀\u{200d}😀",
            "one  two\r\n",
        ] {
            assert_eq!(tokens(text).collect::<String>(), text);
        }
    }
    #[test]
    fn varints_cover_boundaries() {
        let mut out = Vec::new();
        for n in [0, 127, 128, 16383, 16384] {
            integer(&mut out, n);
        }
        assert_eq!(out, [0, 127, 128, 1, 255, 127, 128, 128, 1]);
    }
    #[test]
    fn invalid_contracts_are_rejected() {
        for input in [
            r#"{"version":2,"generatedAt":"","records":[]}"#,
            r#"{"version":1,"generatedAt":"","records":[],"extra":true}"#,
            r#"{"version":1,"generatedAt":"","records":[{"url":"//evil","title":"","description":"","text":"","kind":"page"}]}"#,
        ] {
            assert!(compile(input.as_bytes()).is_err());
        }
    }
    #[test]
    fn output_is_deterministic() {
        let input = br#"{"version":1,"generatedAt":"fixed","records":[{"url":"/","title":"Home","description":"","text":"One one One","kind":"page"}]}"#;
        assert_eq!(compile(input).unwrap(), compile(input).unwrap());
    }
}
