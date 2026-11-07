//! The parts of `@weldsuite/app-api-client/schemas/weldmerge` the routes
//! share, read as Zod 3 reads them (`weldsuite_kit::validation`).

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};

pub(crate) const ISSUE_STATUSES: [&str; 6] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
];
pub(crate) const ISSUE_SYNC_MODES: [&str; 3] = ["two_way", "import", "off"];
pub(crate) const PULL_REQUEST_VIEWS: [&str; 5] =
    ["needs_review", "mine", "open", "merged", "closed"];

/// Whether a field read since `from` made Zod abort the object (a wrong
/// type, enum, literal or union): its `.refine()` then never runs. A failed
/// `.min()`, `.regex()` or `.int()` only makes it dirty.
pub(crate) fn aborted(issues: &Issues, from: usize) -> bool {
    issues
        .issues_since(from)
        .iter()
        .any(|issue| match issue.get("code").and_then(Value::as_str) {
            Some("invalid_type") => {
                issue.get("expected").and_then(Value::as_str) != Some("integer")
            }
            Some("invalid_enum_value" | "invalid_union" | "invalid_literal") => true,
            _ => false,
        })
}

/// `.partial().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })`:
/// after the fields (`from` is where their issues start), when none of
/// `keys` came.
pub(crate) fn nothing_to_update(
    issues: &mut Issues,
    from: usize,
    fields: &Map<String, Value>,
    keys: &[&str],
) {
    if !aborted(issues, from) && !keys.iter().any(|key| fields.contains_key(*key)) {
        issues.custom_root("Nothing to update");
    }
}

fn regex_issue(issues: &mut Issues, key: &str, message: &str) {
    issues.issue_at(
        key,
        json!({ "validation": "regex", "code": "invalid_string", "message": message }),
    );
}

/// `mergeTeamKeySchema`: `z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, …)`.
pub(crate) fn team_key(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Field<String> {
    let trimmed = Text {
        trim: true,
        ..Text::default()
    };
    match issues.text_with(fields, "key", presence, trimmed) {
        Field::Set(text) => {
            let upper = text.to_uppercase();
            let ok = upper.len() >= 2
                && upper.len() <= 10
                && upper.bytes().next().is_some_and(|b| b.is_ascii_uppercase())
                && upper
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
            if ok {
                Field::Set(upper)
            } else {
                regex_issue(
                    issues,
                    "key",
                    "Use 2\u{2013}10 letters and digits, starting with a letter",
                );
                Field::Absent
            }
        }
        other => other,
    }
}

/// `colorSchema`: `z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #6e56cf')`.
pub(crate) fn color(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Field<String> {
    issues.pattern_with(
        fields,
        "color",
        presence,
        Text {
            trim: true,
            ..Text::default()
        },
        |text| {
            text.len() == 7
                && text.starts_with('#')
                && text.bytes().skip(1).all(|b| b.is_ascii_hexdigit())
        },
        "Use a hex colour like #6e56cf",
    )
}

/// `dateOnlySchema`: `z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')`.
pub(crate) fn date_only(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.pattern(
        fields,
        key,
        presence,
        None,
        None,
        |text| {
            let bytes = text.as_bytes();
            bytes.len() == 10
                && bytes[4] == b'-'
                && bytes[7] == b'-'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        },
        "Use YYYY-MM-DD",
    )
}

/// `prioritySchema` (`z.union([z.literal(0), …, z.literal(4)])`). Absent
/// reads as absent (the caller applies a default). An invalid value is
/// returned as the union's issue, which Zod settles after the body's
/// synchronous checks (`push_raw` it once every other field is read).
pub(crate) fn priority(
    issues: &Issues,
    fields: &Map<String, Value>,
) -> (Field<i64>, Option<Value>) {
    let value = fields.get("priority");
    let Some(value) = value else {
        return (Field::Absent, None);
    };
    if let Some(number) = value.as_f64()
        && [0.0, 1.0, 2.0, 3.0, 4.0].contains(&number)
    {
        #[allow(clippy::cast_possible_truncation)]
        return (Field::Set(number as i64), None);
    }
    let path = issues.path_of("priority");
    let errors: Vec<Value> = (0..=4)
        .map(|literal| {
            json!({
                "issues": [{
                    "received": value,
                    "code": "invalid_literal",
                    "expected": literal,
                    "path": path,
                    "message": format!("Invalid literal value, expected {literal}"),
                }],
                "name": "ZodError",
            })
        })
        .collect();
    let issue = json!({
        "code": "invalid_union",
        "unionErrors": errors,
        "path": path,
        "message": "Invalid input",
    });
    (Field::Absent, Some(issue))
}

/// JavaScript's `a >= b` on two strings (UTF-16 code units).
pub(crate) fn js_string_ge(a: &str, b: &str) -> bool {
    a.encode_utf16().ge(b.encode_utf16())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn read(body: &Value, f: impl FnOnce(&mut Issues, &Map<String, Value>)) -> Value {
        let mut issues = Issues::default();
        f(&mut issues, body.as_object().unwrap());
        match issues.finish() {
            Ok(()) => json!([]),
            Err(invalid) => Value::Array(invalid.issues().to_vec()),
        }
    }

    #[test]
    fn a_team_key_is_trimmed_and_upper_cased_before_its_pattern() {
        let mut issues = Issues::default();
        let body = json!({ "key": " plat " });
        let key = team_key(&mut issues, body.as_object().unwrap(), Presence::Required);
        assert_eq!(key, Field::Set("PLAT".to_owned()));
        let issues = read(&json!({ "key": "1ABC" }), |i, f| {
            team_key(i, f, Presence::Required);
        });
        assert_eq!(
            issues,
            json!([{ "validation": "regex", "code": "invalid_string", "message": "Use 2–10 letters and digits, starting with a letter", "path": ["key"] }])
        );
    }

    #[test]
    fn a_priority_outside_the_literals_is_a_union_of_literal_issues() {
        let issues = Issues::default();
        let body = json!({ "priority": 5 });
        let (field, issue) = priority(&issues, body.as_object().unwrap());
        assert_eq!(field, Field::Absent);
        let issue = issue.unwrap();
        assert_eq!(issue["code"], "invalid_union");
        assert_eq!(
            issue["unionErrors"][4]["issues"][0],
            json!({ "received": 5, "code": "invalid_literal", "expected": 4, "path": ["priority"], "message": "Invalid literal value, expected 4" })
        );
    }

    #[test]
    fn nothing_to_update_waits_for_a_clean_type_check() {
        let empty = read(&json!({ "other": 1 }), |i, f| {
            nothing_to_update(i, 0, f, &["name"]);
        });
        assert_eq!(
            empty,
            json!([{ "code": "custom", "message": "Nothing to update", "path": [] }])
        );
        let bad_type = read(&json!({ "name": 5 }), |i, f| {
            i.text(f, "name", Presence::Optional, Some(1), None);
            nothing_to_update(i, 0, f, &["name"]);
        });
        assert_eq!(bad_type.as_array().unwrap().len(), 1);
    }

    #[test]
    fn strings_compare_as_javascript_does() {
        assert!(js_string_ge("2026-11-15", "2026-11-02"));
        assert!(!js_string_ge("2026-11-15", "tomorrow"));
    }
}
