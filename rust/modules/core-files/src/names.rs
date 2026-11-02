//! Drive file and folder names (`packages/clients/core-api-client/src/schemas/files.ts`):
//! the characters a name may not hold, and the schema fields built on them.

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};

/// Path separators and the characters Windows and macOS reserve.
const RESERVED: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// The refinement's message (`A name can't contain ${RESERVED_DRIVE_NAME_CHARS}`).
const INVALID_NAME: &str = "A name can't contain / \\ : * ? \" < > |";

/// A control character as `charCodeAt(0) < 32` sees it.
fn is_control(c: char) -> bool {
    u32::from(c) < 32
}

/// True when `name` (already trimmed) is usable (`isValidDriveName`).
pub(crate) fn is_valid_drive_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    !name.contains(RESERVED) && !name.chars().any(is_control)
}

/// `String.prototype.trim()`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// An uploaded file's own name made usable: reserved and control characters
/// become `_`, surrounding whitespace goes (`sanitizeDriveName`).
pub(crate) fn sanitize_drive_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if RESERVED.contains(&c) || is_control(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let out = js_trim(&replaced);
    if out.is_empty() || out == "." || out == ".." {
        "untitled".to_owned()
    } else {
        out.to_owned()
    }
}

/// `driveNameSchema` with `presence`: a name typed by a person, trimmed,
/// 1 to 500 characters, reserved characters refused.
pub(crate) fn drive_name(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    let field = issues.text_with(body, key, presence, Text::trimmed(Some(1), Some(500)));
    // The refinement runs unless the type was wrong, after the length checks.
    if let Some(Value::String(raw)) = body.get(key) {
        let trimmed = js_trim(raw);
        if !is_valid_drive_name(trimmed) {
            issues.custom(key, INVALID_NAME);
            return Field::Absent;
        }
    }
    field
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_like_the_schema() {
        assert!(is_valid_drive_name("report.pdf"));
        assert!(!is_valid_drive_name("a/b"));
        assert!(!is_valid_drive_name("x:y?"));
        assert!(!is_valid_drive_name(".."));
        assert!(!is_valid_drive_name("tab\there"));
        assert_eq!(sanitize_drive_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(sanitize_drive_name("  .. "), "untitled");
        assert_eq!(sanitize_drive_name(" x\u{1}y "), "x_y");
    }
}
