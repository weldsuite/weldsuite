//! `PUT /api/projects/:id/tabs` (`routes/projects/index.ts`): which project
//! tabs are hidden, for the whole project, per non-admin role and per member.
//! Written whole into `settings.tabs`; the rule that applies it lives with
//! the client (`hiddenProjectTabs` in
//! `@weldsuite/app-api-client/schemas/project-tabs`). It shapes the tab bar
//! only: the data behind a tab is not gated by it.
//!
//! The checks run in TypeScript's order: permission, then the project (404),
//! then project access (403), then the body (400).

use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::PROJECT_UPDATED;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text};

use crate::project_schedule::{PROJECT_MANAGE_DENIED, find_live_project};
use crate::raid_body::{Body, IDENTIFIER, Reader, parse_body};
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

/// `tabId`: `z.string().min(1).max(40)`.
const TAB_ID: Text = Text::length(Some(1), Some(40));
/// `MAX_TAB_IDS`: the most tab ids one list may hold.
const MAX_TAB_IDS: usize = 50;
/// `MAX_TAB_MEMBERS`: the most members with their own list.
const MAX_TAB_MEMBERS: usize = 1000;

/// `tabList` at `key`: `z.array(tabId).max(50)`, required.
fn tab_list(r: &mut Reader<'_>, key: &'static str) {
    let list = r.issues.list(
        r.fields,
        key,
        Presence::Required,
        None,
        Some(MAX_TAB_IDS),
        |issues, item| issues.item_text(item, TAB_ID).map(Value::String),
    );
    r.keep(key, list);
}

/// `projectTabSettingsSchema`: `{ hidden, roles: { member, viewer }, members:
/// [{ userId, hidden }] }`, every object `.strict()`, every field required.
fn read_tabs(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    tab_list(&mut r, "hidden");
    let roles = r
        .issues
        .nested(r.fields, "roles", Presence::Required, |issues, fields| {
            let mut roles = Reader::over(issues, fields);
            tab_list(&mut roles, "member");
            tab_list(&mut roles, "viewer");
            Value::Object(roles.strict())
        });
    r.keep("roles", roles);
    let members = r.issues.list(
        r.fields,
        "members",
        Presence::Required,
        None,
        Some(MAX_TAB_MEMBERS),
        |issues, item| {
            let fields = issues.object(item)?;
            let mut member = Reader::over(issues, fields);
            member.text("userId", Presence::Required, IDENTIFIER);
            tab_list(&mut member, "hidden");
            Some(Value::Object(member.strict()))
        },
    );
    r.keep("members", members);
    Some(r.strict())
}

/// The list's strings without repeats, first one kept.
fn unique(list: Option<&Value>) -> Value {
    let mut seen = HashSet::new();
    let ids: Vec<Value> = list
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| seen.insert(*id))
        .map(|id| Value::String(id.to_owned()))
        .collect();
    Value::Array(ids)
}

/// `normalizeProjectTabSettings`: each list without repeats, and one entry
/// per member (the first one given).
fn normalize(body: &Body) -> Value {
    let mut seen = HashSet::new();
    let members: Vec<Value> = body
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let user_id = entry.get("userId")?.as_str()?;
            seen.insert(user_id.to_owned())
                .then(|| json!({ "userId": user_id, "hidden": unique(entry.get("hidden")) }))
        })
        .collect();
    let roles = body.get("roles");
    json!({
        "hidden": unique(body.get("hidden")),
        "roles": {
            "member": unique(roles.and_then(|r| r.get("member"))),
            "viewer": unique(roles.and_then(|r| r.get("viewer"))),
        },
        "members": members,
    })
}

pub(crate) async fn put_tabs(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let input = parse_body(&body, read_tabs)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_tabs(&state, &caller, &project_id, &project, &input).await,
        "Failed to update the project tabs",
    )
}

async fn write_tabs(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    project: &Value,
    input: &Body,
) -> Reply {
    let next = normalize(input);
    // A merge of this key only: the other settings keys are other features'.
    sqlx::query(
        "update projects set
             settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('tabs', $2::jsonb),
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(project_id)
    .bind(next.clone())
    .bind(crate::now())
    .execute(&caller.db)
    .await?;
    if let Value::Object(map) = project {
        caller.publish(
            state,
            PROJECT_UPDATED,
            project_id,
            &crate::projects::analytics_payload(map),
        );
    }
    Ok(Data(next).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `{ path, message }` details of the 400, or the read body.
    fn read(body: &Value) -> Result<Value, Value> {
        let mut issues = Issues::default();
        let out = read_tabs(&mut issues, body);
        match issues.finish() {
            Ok(()) => Ok(Value::Object(out.expect("a body without issues is read"))),
            Err(failed) => Err(Value::Array(
                failed
                    .issues()
                    .iter()
                    .map(|issue| {
                        let path = issue["path"]
                            .as_array()
                            .expect("a path")
                            .iter()
                            .map(|part| {
                                part.as_str()
                                    .map_or_else(|| part.to_string(), str::to_owned)
                            })
                            .collect::<Vec<_>>()
                            .join(".");
                        json!({ "path": path, "message": issue["message"] })
                    })
                    .collect(),
            )),
        }
    }

    fn one(path: &str, message: &str) -> Value {
        json!([{ "path": path, "message": message }])
    }

    fn whole() -> Value {
        json!({
            "hidden": ["raid"],
            "roles": { "member": [], "viewer": ["finance"] },
            "members": [{ "userId": "user_a", "hidden": [] }],
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut body = whole();
        body[key] = value;
        body
    }

    /// Zod 3's own answers for `projectTabSettingsSchema`.
    #[test]
    fn tabs_are_read_like_zod() {
        assert_eq!(read(&whole()), Ok(whole()));
        assert_eq!(
            read(&json!({ "hidden": [] })).expect_err("refused"),
            json!([
                { "path": "roles", "message": "Required" },
                { "path": "members", "message": "Required" },
            ])
        );
        assert_eq!(
            read(&with("hidden", json!("raid"))).expect_err("refused"),
            one("hidden", "Expected array, received string")
        );
        assert_eq!(
            read(&with("hidden", json!([""]))).expect_err("refused"),
            one("hidden.0", "String must contain at least 1 character(s)")
        );
        assert_eq!(
            read(&with("hidden", json!([5]))).expect_err("refused"),
            one("hidden.0", "Expected string, received number")
        );
        assert_eq!(
            read(&with(
                "roles",
                json!({ "member": [], "viewer": [], "owner": [] })
            ))
            .expect_err("refused"),
            one("roles", "Unrecognized key(s) in object: 'owner'")
        );
        assert_eq!(
            read(&with("members", json!([{ "userId": "user_a" }]))).expect_err("refused"),
            one("members.0.hidden", "Required")
        );
        assert_eq!(
            read(&with("extra", json!(true))).expect_err("refused"),
            one("", "Unrecognized key(s) in object: 'extra'")
        );
        let too_many: Vec<String> = (0..51).map(|i| format!("tab{i}")).collect();
        assert_eq!(
            read(&with("hidden", json!(too_many))).expect_err("refused"),
            one("hidden", "Array must contain at most 50 element(s)")
        );
    }

    #[test]
    fn normalize_drops_repeats_and_keeps_the_first_member_entry() {
        let body = read(&json!({
            "hidden": ["raid", "governance", "raid"],
            "roles": { "member": ["finance"], "viewer": ["finance", "timesheet", "finance"] },
            "members": [
                { "userId": "user_m", "hidden": ["analytics", "analytics"] },
                { "userId": "user_m", "hidden": ["files"] },
                { "userId": "user_v", "hidden": [] },
            ],
        }))
        .expect("valid");
        let Value::Object(body) = body else {
            panic!("an object")
        };
        assert_eq!(
            normalize(&body),
            json!({
                "hidden": ["raid", "governance"],
                "roles": { "member": ["finance"], "viewer": ["finance", "timesheet"] },
                "members": [
                    { "userId": "user_m", "hidden": ["analytics"] },
                    { "userId": "user_v", "hidden": [] },
                ],
            })
        );
    }

    #[test]
    fn a_missing_list_reads_as_empty() {
        assert_eq!(unique(None), json!([]));
    }
}
