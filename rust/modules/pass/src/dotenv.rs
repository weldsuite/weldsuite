//! `.env` parsing and rendering (`services/weldpass/dotenv.ts`): `export`
//! prefixes, quoted values with escapes, `#` comments, blank lines and CRLF.

use serde_json::{Value, json};

use crate::js::{self, JsRecord};

/// `isValidSecretKey`: `^[A-Za-z_]\w*$` and at most 255 characters.
pub(crate) fn is_valid_secret_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && js::utf16_len(key) <= 255
}

/// One line that could not be read as `KEY=value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Skipped {
    pub(crate) line: usize,
    pub(crate) reason: String,
}

impl Skipped {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "line": self.line, "reason": self.reason })
    }
}

/// `ParsedDotenv`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedDotenv {
    pub(crate) values: JsRecord,
    pub(crate) skipped: Vec<Skipped>,
}

/// `parseDotenv`.
pub(crate) fn parse_dotenv(input: &str) -> ParsedDotenv {
    let mut parsed = ParsedDotenv::default();
    // `input.split(/\r?\n/)`.
    let lines = input
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    for (index, raw) in lines.enumerate() {
        let line = js::trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let without_export = match line.strip_prefix("export ") {
            Some(rest) => js::trim(rest),
            None => line,
        };
        let Some(eq) = without_export.find('=') else {
            parsed.skipped.push(Skipped {
                line: index + 1,
                reason: "No \"=\" found".to_owned(),
            });
            continue;
        };
        let key = js::trim(&without_export[..eq]);
        if !is_valid_secret_key(key) {
            parsed.skipped.push(Skipped {
                line: index + 1,
                reason: format!(
                    "\"{}\" is not a valid variable name",
                    js::utf16_slice(key, 0, 40)
                ),
            });
            continue;
        }
        parsed
            .values
            .set(key, unquote(js::trim(&without_export[eq + 1..])));
    }
    parsed
}

fn unquote(value: &str) -> String {
    let units = js::utf16_len(value);
    if units >= 2 {
        let first = value.chars().next();
        let last = value.chars().next_back();
        if first == Some('"') && last == Some('"') {
            // Only double quotes expand escapes, as dotenv does.
            return value[1..value.len() - 1]
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t")
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
        }
        if first == Some('\'') && last == Some('\'') {
            return value[1..value.len() - 1].to_owned();
        }
    }
    // An inline comment ends an unquoted value only after whitespace:
    // `pass#word` is a password, ` # note` is a comment (`/\s#/`).
    let comment = value
        .char_indices()
        .zip(value.chars().skip(1))
        .find(|((_, c), next)| js::is_js_space(*c) && *next == '#')
        .map(|((index, _), _)| index);
    js::trim(comment.map_or(value, |index| &value[..index])).to_owned()
}

/// `renderDotenv`: sorted by UTF-16 code unit, quoted whenever needed.
pub(crate) fn render_dotenv(values: &JsRecord) -> String {
    let mut keys: Vec<&str> = values.keys().collect();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let lines: Vec<String> = keys
        .into_iter()
        .map(|key| {
            let value = values
                .entries()
                .find(|(k, _)| *k == key)
                .map_or("", |(_, v)| v);
            format!("{key}={}", quote_if_needed(value))
        })
        .collect();
    format!("{}\n", lines.join("\n"))
}

fn quote_if_needed(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_owned();
    }
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '@' | '-'));
    if plain {
        return value.to_owned();
    }
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r")
    )
}
