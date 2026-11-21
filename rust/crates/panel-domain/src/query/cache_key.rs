//! The query cache key (`cache-key.ts`): sha256 of the parsed spec written
//! as JSON with sorted keys, under the workspace and project.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js;

/// `stableStringify`: JSON with object keys sorted (UTF-16 order), numbers
/// as JavaScript writes them, so equal specs hash equal whatever order a
/// client wrote them in.
pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_stable(value, &mut out);
    out
}

fn write_stable(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            // A JavaScript number is a double, whole or not.
            let float = number.as_f64().unwrap_or(f64::NAN);
            out.push_str(&if float.is_finite() {
                js::number_text(float)
            } else {
                "null".to_owned()
            });
        }
        Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_stable(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| js::compare_text(a.0, b.0));
            out.push('{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                write_stable(item, out);
            }
            out.push('}');
        }
    }
}

/// `specCacheKey`: `panel:q:<workspace>:<project>:<sha256 of the parsed spec>`.
pub fn spec_cache_key<S: Serialize + ?Sized>(
    workspace_id: &str,
    project_id: &str,
    spec: &S,
) -> String {
    let value = serde_json::to_value(spec).unwrap_or(Value::Null);
    let digest = Sha256::digest(stable_stringify(&value).as_bytes());
    let hex = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .concat();
    format!("panel:q:{workspace_id}:{project_id}:{hex}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn sorts_keys_and_writes_numbers_as_javascript() {
        assert_eq!(
            stable_stringify(
                &json!({ "b": null, "a": [1, { "d": 1.0, "c": 2.5 }], "é": "x\u{1}\"" })
            ),
            "{\"a\":[1,{\"c\":2.5,\"d\":1}],\"b\":null,\"é\":\"x\\u0001\\\"\"}"
        );
        assert_eq!(stable_stringify(&json!(1e21)), "1e+21");
    }

    #[test]
    fn keys_by_workspace_project_and_spec() {
        let a = spec_cache_key(
            "ws_1",
            "pnp_1",
            &json!({ "kind": "web", "limit": 10, "projectId": "pnp_1" }),
        );
        let b = spec_cache_key(
            "ws_1",
            "pnp_1",
            &json!({ "projectId": "pnp_1", "limit": 10, "kind": "web" }),
        );
        assert_eq!(a, b);
        assert!(a.starts_with("panel:q:ws_1:pnp_1:"));
        assert_eq!(a.len(), "panel:q:ws_1:pnp_1:".len() + 64);
        assert_ne!(
            spec_cache_key("ws_2", "pnp_1", &json!({ "kind": "web" })),
            spec_cache_key("ws_1", "pnp_1", &json!({ "kind": "web" }))
        );
    }
}
