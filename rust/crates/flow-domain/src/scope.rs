//! Project scope rules (`@weldsuite/flow-domain/scope`): the scope statement
//! and the in and out of scope lists, and the shapes they take on the wire and
//! in entity events (design: weldflow-project-control.md).
//!
//! Every message returned here goes to the client as it is, so both backends
//! answer alike. Rows are read as `weldsuite_db::js_row` gives them.

use std::collections::HashMap;

use serde_json::{Value, json};

/// `SCOPE_LINK_TYPES`: what an out-of-scope item can point at.
pub const SCOPE_LINK_TYPES: [&str; 3] = ["decision", "change_request", "project"];

/// `SCOPE_MESSAGES`.
pub mod messages {
    pub const LINK_PAIR: &str = "linkType and linkId must be given together";
    pub const LINK_NOT_FOUND: &str = "The linked object was not found in this project";
}

/// What an out-of-scope item's link resolved to (`ScopeLinkTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeLinkTarget {
    pub link_type: &'static str,
    pub id: String,
    pub code: Option<String>,
    pub title: String,
    pub status: Option<String>,
}

fn text<'a>(item: &'a Value, key: &str) -> Option<&'a str> {
    item.get(key).and_then(Value::as_str)
}

/// `normalizeOutOfScope(items)`: an item as it is stored, every field present;
/// an empty reason is null, and the link id only goes with a link type.
pub fn normalize_out_of_scope(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            let link_type = text(item, "linkType");
            json!({
                "text": text(item, "text").unwrap_or_default(),
                "reason": text(item, "reason").filter(|reason| !reason.is_empty()),
                "linkType": link_type,
                "linkId": link_type.and_then(|_| text(item, "linkId")),
            })
        })
        .collect()
}

/// `outOfScopeLinkError(items)`: an item whose link is half given (the request's
/// items, before they are normalised).
pub fn out_of_scope_link_error(items: &[Value]) -> Option<&'static str> {
    // `!!item.linkType !== !!item.linkId`: null, absent and empty are all unset.
    let set = |item: &Value, key: &str| text(item, key).is_some_and(|value| !value.is_empty());
    items
        .iter()
        .any(|item| set(item, "linkType") != set(item, "linkId"))
        .then_some(messages::LINK_PAIR)
}

/// `scopeLinkKey(item)`: the `type:id` of an item's link.
pub fn scope_link_key(item: &Value) -> Option<String> {
    match (text(item, "linkType"), text(item, "linkId")) {
        (Some(link_type), Some(link_id)) if !link_type.is_empty() && !link_id.is_empty() => {
            Some(format!("{link_type}:{link_id}"))
        }
        _ => None,
    }
}

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `presentScope(projectId, row, targets)`: the scope as the routes answer it.
/// A project without a saved scope answers the empty one (`id` and the audit
/// fields null); a link left out of `targets` shows as null.
pub fn present_scope<S: std::hash::BuildHasher>(
    project_id: &str,
    row: Option<&Value>,
    targets: &HashMap<String, ScopeLinkTarget, S>,
) -> Value {
    let in_scope = row
        .and_then(|row| row.get("inScope"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let out_of_scope: Vec<Value> = row
        .and_then(|row| row.get("outOfScope"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let target = scope_link_key(item).and_then(|key| targets.get(&key));
                    json!({
                        "text": field(item, "text"),
                        "reason": field(item, "reason"),
                        "linkType": field(item, "linkType"),
                        "linkId": field(item, "linkId"),
                        "link": target.map(|target| json!({
                            "type": target.link_type,
                            "id": target.id,
                            "code": target.code,
                            "title": target.title,
                            "status": target.status,
                        })),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let of = |key: &str| row.map_or(Value::Null, |row| field(row, key));
    json!({
        "id": of("id"),
        "projectId": project_id,
        "statement": of("statement"),
        "inScope": in_scope,
        "outOfScope": out_of_scope,
        "createdBy": of("createdBy"),
        "updatedBy": of("updatedBy"),
        "createdAt": of("createdAt"),
        "updatedAt": of("updatedAt"),
    })
}

/// `scopeEventData(row)`.
pub fn scope_event_data(row: &Value) -> Value {
    let count = |key: &str| row.get(key).and_then(Value::as_array).map_or(0, Vec::len);
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "inScopeCount": count("inScope"),
        "outOfScopeCount": count("outOfScope"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_an_out_of_scope_item_with_every_field_and_wants_a_link_whole() {
        assert_eq!(
            normalize_out_of_scope(&[
                json!({ "text": "Reporting", "reason": "Release 2", "linkType": "decision", "linkId": "dec_1" }),
                json!({ "text": "Mobile app" }),
            ]),
            vec![
                json!({ "text": "Reporting", "reason": "Release 2", "linkType": "decision", "linkId": "dec_1" }),
                json!({ "text": "Mobile app", "reason": null, "linkType": null, "linkId": null }),
            ]
        );
        assert_eq!(
            out_of_scope_link_error(&[json!({ "text": "x", "linkType": "decision" })]),
            Some(messages::LINK_PAIR)
        );
        assert_eq!(
            out_of_scope_link_error(&[json!({ "text": "x", "linkId": "dec_1" })]),
            Some(messages::LINK_PAIR)
        );
        assert_eq!(
            out_of_scope_link_error(&[
                json!({ "text": "x", "linkType": "decision", "linkId": "dec_1" }),
                json!({ "text": "y" }),
            ]),
            None
        );
        assert_eq!(
            scope_link_key(&json!({ "linkType": "project", "linkId": "prj_2" })).as_deref(),
            Some("project:prj_2")
        );
        assert_eq!(
            scope_link_key(&json!({ "linkType": null, "linkId": null })),
            None
        );
    }

    #[test]
    fn answers_an_empty_scope_before_the_first_save() {
        assert_eq!(
            present_scope("prj_1", None, &HashMap::new()),
            json!({
                "id": null, "projectId": "prj_1", "statement": null, "inScope": [],
                "outOfScope": [], "createdBy": null, "updatedBy": null,
                "createdAt": null, "updatedAt": null,
            })
        );
    }

    #[test]
    fn shows_a_resolved_link_and_a_missing_one_as_null() {
        let row = json!({
            "id": "scope_1", "statement": "S", "inScope": ["a"],
            "outOfScope": [
                { "text": "Reporting", "reason": "R2", "linkType": "decision", "linkId": "dec_1" },
                { "text": "Gone", "reason": null, "linkType": "decision", "linkId": "dec_x" },
            ],
        });
        let mut targets = HashMap::new();
        targets.insert(
            "decision:dec_1".to_owned(),
            ScopeLinkTarget {
                link_type: "decision",
                id: "dec_1".into(),
                code: Some("DEC-3".into()),
                title: "Reporting out".into(),
                status: Some("decided".into()),
            },
        );
        let wire = present_scope("prj_1", Some(&row), &targets);
        assert_eq!(wire["outOfScope"][0]["link"]["code"], "DEC-3");
        assert_eq!(wire["outOfScope"][1]["link"], Value::Null);
        assert_eq!(scope_event_data(&row)["outOfScopeCount"], 2);
    }
}
