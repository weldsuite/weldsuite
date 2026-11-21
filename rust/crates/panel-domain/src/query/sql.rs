//! The only way a value gets into WeldPanel SQL (`sql.ts`). Basin SQL has no
//! bind parameters, so every literal goes through [`lit`] / [`num`] / [`ts`],
//! names and keys are checked against the collector's own patterns, and
//! anything unexpected is a [`PanelQueryError`] (a 400, never SQL).

use std::sync::LazyLock;

use regex::Regex;

use crate::js;
use crate::wire::{CUSTOM_EVENT_NAME, GROUP_TYPE, PROPERTY_KEY, SYSTEM_EVENT_NAME};

/// A spec the compiler refuses. The route answers 400 with the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelQueryError {
    pub message: String,
}

impl PanelQueryError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PanelQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PanelQueryError {}

impl From<crate::expression::NumberOutOfRange> for PanelQueryError {
    fn from(_: crate::expression::NumberOutOfRange) -> Self {
        Self::new("Number out of range")
    }
}

/// The compiler's result.
pub type QueryResult<T> = Result<T, PanelQueryError>;

/// A control character or backslash: written as a `chr(n)` piece.
fn special_in_literal(c: char) -> bool {
    matches!(c, '\u{1}'..='\u{1f}' | '\u{7f}' | '\\')
}

/// A string literal: single quotes doubled. A backslash or control
/// character becomes a `chr(n)` piece, `('CORP' || chr(92) || 'jdoe')`;
/// plain text stays a plain literal. NUL is refused.
pub fn lit(value: &str) -> QueryResult<String> {
    if value.contains('\0') {
        return Err(PanelQueryError::new(
            "Values cannot contain a null character",
        ));
    }
    if !value.chars().any(special_in_literal) {
        return Ok(quoted(value));
    }
    let mut pieces = Vec::new();
    let mut plain = String::new();
    for c in value.chars() {
        if special_in_literal(c) {
            if !plain.is_empty() {
                pieces.push(quoted(&plain));
                plain.clear();
            }
            pieces.push(format!("chr({})", u32::from(c)));
        } else {
            plain.push(c);
        }
    }
    if !plain.is_empty() {
        pieces.push(quoted(&plain));
    }
    Ok(format!("({})", pieces.join(" || ")))
}

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A finite number, as JavaScript prints it.
pub fn num(value: f64) -> QueryResult<String> {
    if !value.is_finite() {
        return Err(PanelQueryError::new("Expected a number"));
    }
    Ok(js::number_text(value))
}

/// A non-negative whole number for `LIMIT` and similar, at most `max`.
pub fn int(value: i64, max: i64) -> QueryResult<String> {
    if value < 0 || value > max {
        return Err(PanelQueryError::new(format!(
            "Expected a whole number from 0 to {max}"
        )));
    }
    Ok(value.to_string())
}

/// A UTC instant (epoch milliseconds) as a `TIMESTAMP '…'` literal, to the second.
pub fn ts(millis: i64) -> String {
    let iso = js::iso_string(millis);
    let head: String = iso.chars().take(19).collect();
    format!("TIMESTAMP '{}'", head.replacen('T', " ", 1))
}

/// True for a tracked event name (custom or `$` system).
pub fn is_event_name(name: &str) -> bool {
    CUSTOM_EVENT_NAME.is_match(name) || SYSTEM_EVENT_NAME.is_match(name)
}

/// An event name as a literal: a custom event or a `$` system event.
pub fn event_name(name: &str) -> QueryResult<String> {
    if !is_event_name(name) {
        return Err(PanelQueryError::new("Not a valid event name"));
    }
    lit(name)
}

/// A property key as a literal: a custom key or a `$` system key.
pub fn property_key(key: &str) -> QueryResult<String> {
    let bare = key.strip_prefix('$').unwrap_or(key);
    if !PROPERTY_KEY.is_match(bare) {
        return Err(PanelQueryError::new("Not a valid property key"));
    }
    lit(key)
}

/// `LIKE` pattern pieces: `!` is the escape character.
pub const LIKE_ESCAPE: &str = " ESCAPE '!'";

fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '!' | '%' | '_') {
            out.push('!');
        }
        out.push(c);
    }
    out
}

/// Orders text by UTF-16 code unit, locale-independent.
pub fn compare_text(a: &str, b: &str) -> std::cmp::Ordering {
    js::compare_text(a, b)
}

/// `'%value%'`, for case-insensitive contains (compare with `LOWER(expr)`).
pub fn like_contains(value: &str) -> QueryResult<String> {
    lit(&format!("%{}%", escape_like(&value.to_lowercase())))
}

/// A path pattern (`/products/*`): `*` matches any characters, the rest is literal.
pub fn like_pattern(pattern: &str) -> QueryResult<String> {
    let pieces: Vec<String> = pattern.split('*').map(escape_like).collect();
    lit(&pieces.join("%"))
}

/// `IN (…)` list of string literals.
pub fn in_list<S: AsRef<str>>(values: &[S]) -> QueryResult<String> {
    if values.is_empty() {
        return Err(PanelQueryError::new("Empty list"));
    }
    let items = values
        .iter()
        .map(|v| lit(v.as_ref()))
        .collect::<QueryResult<Vec<_>>>()?;
    Ok(format!("({})", items.join(", ")))
}

/// A group type (`company`), safe as part of an alias.
pub fn group_type(value: &str) -> QueryResult<&str> {
    if !GROUP_TYPE.is_match(value) {
        return Err(PanelQueryError::new("Not a valid group type"));
    }
    Ok(value)
}

/// An approximate percentile (0-1) of `expr`: DataFusion's
/// `approx_percentile_cont(expr, p)`.
pub fn percentile_sql(expr: &str, p: f64) -> QueryResult<String> {
    if !(p > 0.0 && p < 1.0) {
        return Err(PanelQueryError::new(
            "Expected a percentile between 0 and 1",
        ));
    }
    Ok(format!("approx_percentile_cont({expr}, {})", num(p)?))
}

static CUSTOM_EVENT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@(pnce_[A-Za-z0-9]{1,26})$").expect("a valid pattern"));
static COMPUTED_PROPERTY_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@(pncp_[A-Za-z0-9]{1,26})$").expect("a valid pattern"));

/// Which kind of reference [`ref_id_of`] reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    /// `@pnce_…`.
    CustomEvent,
    /// `@pncp_…`.
    ComputedProperty,
}

/// The row id inside a ref (`@pnce_ab12` → `pnce_ab12`), checked first.
pub fn ref_id_of(reference: &str, kind: RefKind) -> QueryResult<&str> {
    let pattern = match kind {
        RefKind::CustomEvent => &*CUSTOM_EVENT_ID,
        RefKind::ComputedProperty => &*COMPUTED_PROPERTY_ID,
    };
    pattern
        .captures(reference)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
        .ok_or_else(|| PanelQueryError::new("Not a valid reference"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_literals_without_backslashes() {
        assert_eq!(lit("it's").expect("lit"), "'it''s'");
        assert_eq!(
            lit("CORP\\jdoe").expect("lit"),
            "('CORP' || chr(92) || 'jdoe')"
        );
        assert_eq!(lit("\n").expect("lit"), "(chr(10))");
        assert_eq!(
            lit("a\u{7f}\u{1}b").expect("lit"),
            "('a' || chr(127) || chr(1) || 'b')"
        );
        assert!(lit("a\0").is_err());
    }

    #[test]
    fn prints_numbers_as_javascript() {
        for (value, text) in [
            (1.0, "1"),
            (-1.5, "-1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (-0.0, "0"),
        ] {
            assert_eq!(num(value).expect("num"), text);
        }
        assert!(num(f64::NAN).is_err());
    }

    #[test]
    fn writes_timestamps_to_the_second() {
        assert_eq!(ts(1_794_830_400_123), "TIMESTAMP '2026-11-16 12:00:00'");
    }

    #[test]
    fn escapes_like_patterns() {
        assert_eq!(like_pattern("/a_b/*").expect("like"), "'/a!_b/%'");
        assert_eq!(like_contains("50% OFF!").expect("like"), "'%50!% off!!%'");
    }
}
