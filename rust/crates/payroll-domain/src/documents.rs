//! Printable payroll documents and generated files (`documents.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocumentField {
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emphasis: Option<bool>,
}

impl DocumentField {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
            emphasis: None,
        }
    }

    #[must_use]
    pub fn emphasised(mut self) -> Self {
        self.emphasis = Some(true);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentSection {
    Fields {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        fields: Vec<DocumentField>,
    },
    #[serde(rename_all = "camelCase")]
    Table {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        columns: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        align_right: Option<Vec<usize>>,
        rows: Vec<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        totals: Option<Vec<String>>,
    },
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        paragraphs: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    En,
    Nl,
}

impl Lang {
    pub fn is_nl(self) -> bool {
        self == Self::Nl
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Nl => "nl",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PayrollDocument {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub language: Lang,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Vec<String>>,
    pub sections: Vec<DocumentSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "crate::ordered::double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub watermark: Option<Option<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub file_name: String,
    pub content_type: String,
    pub content: String,
}

/// `money(cents, lang)` of the NL documents: `€ 1.234,56` / `€ 1,234.56`.
pub fn euro_text(cents: f64, lang: Lang) -> String {
    let text = crate::money::from_cents(cents.abs());
    let (whole, dec) = text.split_once('.').unwrap_or((text.as_str(), ""));
    let grouped = group_thousands(whole, if lang.is_nl() { '.' } else { ',' });
    format!(
        "{}€ {grouped}{}{dec}",
        if cents < 0.0 { "-" } else { "" },
        if lang.is_nl() { ',' } else { '.' }
    )
}

/// `whole.replace(/\B(?=(\d{3})+(?!\d))/g, sep)` on a run of digits.
pub fn group_thousands(digits: &str, sep: char) -> String {
    let chars: Vec<char> = digits.chars().collect();
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        let remaining = chars.len() - i;
        let prev_word = i > 0 && is_word(chars[i - 1]);
        let this_word = is_word(*c);
        // `\B`: between two word characters (or two non-word characters).
        let boundary = prev_word != this_word;
        if i > 0 && !boundary && remaining.is_multiple_of(3) && chars[i..].iter().all(char::is_ascii_digit) {
            out.push(sep);
        }
        out.push(*c);
    }
    out
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
