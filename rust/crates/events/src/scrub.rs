//! `scrubSensitiveKeys` from `packages/core/db/src/lib/sensitive-columns.ts`:
//! ciphertext columns (TINs, SSNs, account numbers, provider credentials)
//! never ride the bus, at any depth.

use serde_json::Value;

/// Every sensitive property name across all tables (`ALL_SENSITIVE_KEYS`).
/// The golden test checks this against the TypeScript set.
pub const SENSITIVE_KEYS: &[&str] = &[
    "accountNumberEncrypted",
    "credentialsEncrypted",
    "fiscalCredentialsEncrypted",
    "imapCredentials",
    "recipientTinEncrypted",
    "salesTaxCredentialsEncrypted",
    "sensitiveEncrypted",
    "smtpCredentials",
    "ssnEncrypted",
];

/// Deeper than any row or payload nests (`MAX_SCRUB_DEPTH`); below it a
/// value is left as it is.
const MAX_DEPTH: usize = 24;

/// `value` without any sensitive key, at any depth up to the limit.
pub fn scrub_sensitive_keys(mut value: Value) -> Value {
    scrub(&mut value, 0);
    value
}

fn scrub(value: &mut Value, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                scrub(item, depth + 1);
            }
        }
        Value::Object(map) => {
            map.retain(|key, _| !SENSITIVE_KEYS.contains(&key.as_str()));
            for item in map.values_mut() {
                scrub(item, depth + 1);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn strips_nested_keys_and_stops_at_the_depth_limit() {
        let value = json!({
            "a": [{ "ssnEncrypted": 1, "b": 2 }],
            "smtpCredentials": {},
        });
        assert_eq!(scrub_sensitive_keys(value), json!({ "a": [{ "b": 2 }] }));

        let mut deep = json!({ "sensitiveEncrypted": "x" });
        for _ in 0..=MAX_DEPTH {
            deep = json!({ "n": deep });
        }
        assert_eq!(scrub_sensitive_keys(deep.clone()), deep, "past the limit");

        let mut shallow = json!({ "sensitiveEncrypted": "x" });
        let mut expected = json!({});
        for _ in 0..MAX_DEPTH {
            shallow = json!({ "n": shallow });
            expected = json!({ "n": expected });
        }
        assert_eq!(scrub_sensitive_keys(shallow), expected, "at the limit");
    }
}
