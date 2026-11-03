//! What the tools' Zod shapes compute in JavaScript (`src/args_gen.rs`
//! names them; `tools/generate.mts` prints each one's source).

use serde_json::Value;
use weldsuite_external_api::zod::Hook;

/// `queryBoolean` (`schemas/conversations.ts`): `"true"` and `"false"` read
/// as booleans, anything else passes as it is.
#[allow(clippy::unnecessary_wraps)] // the hook's signature
pub(crate) fn preprocess_search_conversations_unassigned(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) if text == "true" => Some(Value::Bool(true)),
        Some(Value::String(text)) if text == "false" => Some(Value::Bool(false)),
        other => other.cloned(),
    }
}

/// The characters a Drive name cannot hold (`RESERVED_NAME_CHARS`).
const RESERVED_NAME_CHARS: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// `sanitizeDriveName`: reserved and control characters become `_`, the name
/// is trimmed, and an empty or dot name is `untitled`.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn transform_create_file_file_name(value: Option<Value>) -> Option<Value> {
    let Some(Value::String(name)) = value else {
        return value;
    };
    let replaced: String = name
        .chars()
        .map(|ch| {
            if RESERVED_NAME_CHARS.contains(&ch) || (ch as u32) < 32 {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = replaced.trim();
    let out = if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "untitled"
    } else {
        trimmed
    };
    Some(Value::String(out.to_owned()))
}

/// `driveNameSchema`'s `isValidDriveName`.
pub(crate) fn refine_update_file_file_name(value: Option<&Value>, hook: &mut Hook) {
    let Some(Value::String(name)) = value else {
        return;
    };
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && !name
            .chars()
            .any(|ch| RESERVED_NAME_CHARS.contains(&ch) || (ch as u32) < 32);
    if !valid {
        hook.fail("A name can't contain / \\ : * ? \" < > |");
    }
}

/// WeldReach's `customFields`: at most 50.
pub(crate) fn refine_create_reach_prospect_custom_fields(value: Option<&Value>, hook: &mut Hook) {
    if let Some(Value::Object(fields)) = value
        && fields.len() > 50
    {
        hook.fail("At most 50 custom fields");
    }
}
