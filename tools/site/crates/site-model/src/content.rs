//! Authored explanatory content. The editorial and understanding records are
//! semantic data; existing experiment HTML/CSS/JS remains an explicit source
//! boundary until the native document compiler parses it.
use crate::ValidationError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GaragePage {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<String>,
    pub editorial: Editorial,
    pub understanding: Understanding,
    pub body_html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_js: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Editorial {
    pub reader: String,
    pub problem: String,
    pub thesis: String,
    pub evidence: Vec<String>,
    pub uncertainty: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Understanding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub q: String,
    pub options: Vec<AnswerOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(deny_unknown_fields)]
pub struct AnswerOption {
    pub t: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    pub why: String,
}

#[derive(Debug)]
pub struct ValidatedGaragePage(GaragePage);
impl ValidatedGaragePage {
    pub fn page(&self) -> &GaragePage {
        &self.0
    }
}

fn nonempty(value: &str, field: &str) -> Result<(), ValidationError> {
    if value.trim().is_empty() {
        return Err(ValidationError(format!("{field}: must be non-empty")));
    }
    Ok(())
}

impl GaragePage {
    pub fn validate(self) -> Result<ValidatedGaragePage, ValidationError> {
        if self.id.is_empty()
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || self.id.starts_with('-')
        {
            return Err(ValidationError(
                "page id must use lowercase letters, digits and hyphens".into(),
            ));
        }
        for (name, value) in [
            ("title", &self.title),
            ("description", &self.description),
            ("status", &self.status),
            ("bodyHtml", &self.body_html),
            ("editorial.reader", &self.editorial.reader),
            ("editorial.problem", &self.editorial.problem),
            ("editorial.thesis", &self.editorial.thesis),
            ("editorial.uncertainty", &self.editorial.uncertainty),
        ] {
            nonempty(value, name)?;
        }
        if let Some(date) = &self.added {
            let bytes = date.as_bytes();
            if bytes.len() != 10
                || bytes.iter().enumerate().any(|(i, c)| {
                    if i == 4 || i == 7 {
                        *c != b'-'
                    } else {
                        !c.is_ascii_digit()
                    }
                })
            {
                return Err(ValidationError("added: expected YYYY-MM-DD".into()));
            }
        }
        if self.editorial.evidence.is_empty() {
            return Err(ValidationError(
                "editorial.evidence: must contain evidence".into(),
            ));
        }
        for evidence in &self.editorial.evidence {
            nonempty(evidence, "editorial.evidence")?;
        }
        for (name, value) in [
            ("understanding.title", &self.understanding.title),
            ("understanding.intro", &self.understanding.intro),
        ] {
            if let Some(value) = value {
                nonempty(value, name)?;
            }
        }
        if !(3..=7).contains(&self.understanding.questions.len()) {
            return Err(ValidationError(
                "understanding.questions: expected 3 to 7 questions".into(),
            ));
        }
        for question in &self.understanding.questions {
            nonempty(&question.q, "question.q")?;
            if !(3..=6).contains(&question.options.len()) {
                return Err(ValidationError(
                    "question.options: expected 3 to 6 answers".into(),
                ));
            }
            if question
                .options
                .iter()
                .filter(|o| o.ok == Some(true))
                .count()
                != 1
            {
                return Err(ValidationError(
                    "question.options: expected exactly one correct answer".into(),
                ));
            }
            for option in &question.options {
                nonempty(&option.t, "option.t")?;
                nonempty(&option.why, "option.why")?;
            }
        }
        Ok(ValidatedGaragePage(self))
    }
}

pub fn typescript() -> String {
    let config = ts_rs::Config::default();
    [
        GaragePage::decl(&config),
        Editorial::decl(&config),
        Understanding::decl(&config),
        Question::decl(&config),
        AnswerOption::decl(&config),
    ]
    .iter()
    .map(|d| format!("export {d}\n"))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> GaragePage {
        serde_json::from_str(include_str!(
            "../../../../../pipelines/garage/specs/typed-config.json"
        ))
        .unwrap()
    }
    #[test]
    fn authored_pages_validate_without_losing_information() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../pipelines/garage/specs");
        let mut count = 0;
        for entry in std::fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let raw = std::fs::read_to_string(&path).unwrap();
                let page: GaragePage = serde_json::from_str(&raw).unwrap();
                let checked = page.validate().unwrap();
                assert_eq!(
                    serde_json::to_value(checked.page()).unwrap(),
                    serde_json::from_str::<serde_json::Value>(&raw).unwrap(),
                    "{}",
                    path.display()
                );
                count += 1;
            }
        }
        assert!(count >= 8, "lost the authored fixtures");
    }
    #[test]
    fn invalid_editorial_and_quiz_relationships_are_rejected() {
        let mut page = fixture();
        page.editorial.evidence.clear();
        assert!(page.validate().is_err());
        let mut page = fixture();
        page.understanding.questions.truncate(2);
        assert!(page.validate().is_err());
        let mut page = fixture();
        page.understanding.questions[0].options[0].ok = None;
        assert!(page.validate().is_err());
        let mut page = fixture();
        page.understanding.questions[0].options[1].ok = Some(true);
        assert!(page.validate().is_err());
        let mut page = fixture();
        page.id = "../elsewhere".into();
        assert!(page.validate().is_err());
        let mut page = fixture();
        page.title = "  ".into();
        assert!(page.validate().is_err());
    }
}
