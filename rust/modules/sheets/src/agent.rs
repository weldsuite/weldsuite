//! What WeldAgent tools do with spreadsheets, in process
//! (`apps/workers/sheets-api/src/routes/internal/agent.ts`, the
//! `SheetsInternal` entrypoint the Global agent tools call).
//!
//! The same five operations as the worker's `/internal/agent/:workspaceId/sheets/*`:
//!
//! | `op` | |
//! |---|---|
//! | `find` | sheets the person can open, by name |
//! | `create` | a new sheet, optionally with values in its first tab |
//! | `tabs` | its tabs and the cells each uses |
//! | `read` | values and formulas of a range |
//! | `write` | values written from a range's top-left cell |
//!
//! Every call acts for the person the agent works for: they see and change
//! only what their WeldDrive access (and project membership) allows, with the
//! `sheets:*` permissions they hold now. Writes go through the sheet's room,
//! so everyone in the sheet sees them at once. `Err` is the message the
//! worker's error answer would carry.

use serde_json::{Value, json};
use weldsuite_core_domain::drive_access::{
    DriveRole, file_role, load_drive_access_for_user, visible_files,
};
use weldsuite_db::{PgPool, ReadOnlyReason, TenantPermissionQueries, read_only_message};
use weldsuite_events::{EventContext, EventSource};
use weldsuite_permissions::{Permissions, resolve_effective_permissions};

use crate::records::{self, ListSheets, room_name};
use crate::routes::{NewSheet, VIEW_ONLY, find_sheet, save_new_sheet};
use crate::{Caller, SheetsState};

/// Who an agent call acts for, and where.
#[derive(Debug, Clone, Copy)]
pub struct AgentScope<'a> {
    pub db: &'a PgPool,
    pub user_id: &'a str,
    /// The Clerk org id: room names and bucket keys use it.
    pub clerk_org_id: &'a str,
    /// Why the workspace may only be read, when it may (`readOnly` /
    /// `readOnlyReason` of the workspace context). Writes are refused with
    /// the gate's message; reads pass.
    pub read_only: Option<ReadOnlyReason>,
}

/// `readOnlyRefusal(c)`: the message a write gets in a read-only workspace.
fn read_only_refusal(read_only: Option<ReadOnlyReason>) -> Result<(), String> {
    match read_only {
        Some(reason) => Err(read_only_message(Some(reason)).to_owned()),
        None => Ok(()),
    }
}

/// Cells one write takes at most (`MAX_WRITE_CELLS`).
const MAX_WRITE_CELLS: usize = 50_000;

fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The person's permissions as they are now, for the same checks the routes make.
async fn caller_for(scope: &AgentScope<'_>) -> Result<Caller, String> {
    let queries = TenantPermissionQueries::new(scope.db.clone());
    let resolved = resolve_effective_permissions(&queries, scope.user_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[sheets/agent] resolving permissions failed");
            "Internal server error".to_owned()
        })?;
    Ok(Caller {
        db: scope.db.clone(),
        user_id: scope.user_id.to_owned(),
        permissions: Permissions::new(resolved, None, false, scope.user_id.to_owned()),
        events: EventContext::new(
            scope.clerk_org_id.to_owned(),
            scope.user_id.to_owned(),
            EventSource::Api,
        ),
        read_only: false,
        clerk_org_id: Some(scope.clerk_org_id.to_owned()),
        files: None,
        collab: None,
    })
}

fn cell_count(values: &Value) -> usize {
    values.as_array().map_or(0, |rows| {
        rows.iter().map(|r| r.as_array().map_or(0, Vec::len)).sum()
    })
}

/// One agent operation, as the worker's internal route answers it.
///
/// # Errors
///
/// The refusal's message: no permission, an unknown or unreadable sheet, a
/// range the room refused.
#[allow(clippy::too_many_lines)] // the five routes
pub async fn agent_call(
    state: &SheetsState,
    scope: &AgentScope<'_>,
    op: &str,
    sheet_id: Option<&str>,
    input: &Value,
) -> Result<Value, String> {
    let caller = caller_for(scope).await?;
    let org = scope.clerk_org_id;
    let refuse = |r: crate::Refusal| r.message();
    let need = |key: &str| {
        if caller.can(key) {
            Ok(())
        } else {
            Err("Forbidden".to_owned())
        }
    };
    let sheet_arg = || sheet_id.ok_or_else(|| "A spreadsheet id is required".to_owned());
    match op {
        "find" => {
            need("sheets:read")?;
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id))
                .await
                .map_err(|e| e.to_string())?;
            let limit = input["limit"].as_i64().unwrap_or(20).clamp(1, 50);
            let search = input["query"]
                .as_str()
                .filter(|q| !q.is_empty())
                .map(|q| format!("%{}%", escape_like(q.trim())));
            let (rows, _) = records::list_sheets(
                &caller.db,
                &ListSheets {
                    visible: visible_files(&access),
                    search,
                    project_id: None,
                    limit,
                    offset: 0,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            Ok(Value::Array(
                rows.iter()
                    .map(|s| {
                        json!({
                            "id": s.id, "name": s.name, "updatedAt": s.updated_at,
                            "role": file_role(&access, &s.file).unwrap_or(DriveRole::Viewer).as_str(),
                        })
                    })
                    .collect(),
            ))
        }
        "create" => {
            need("sheets:create")?;
            read_only_refusal(scope.read_only)?;
            let name = input["name"].as_str().unwrap_or_default().trim().to_owned();
            if name.is_empty() {
                return Err("name is required".to_owned());
            }
            let made = caller
                .engine(state, "newSheet", json!([Value::Null, Value::Null]))
                .await
                .map_err(refuse)?;
            let checkpoint = weldsuite_ports::collab::value_bytes(&made["checkpoint"])
                .ok_or_else(|| "Internal server error".to_owned())?;
            let sheet = save_new_sheet(
                state,
                &caller,
                NewSheet {
                    org,
                    name,
                    folder: None,
                    project: None,
                    checkpoint,
                },
            )
            .await
            .map_err(refuse)?;
            let room = room_name(org, &sheet.id);
            let meta = sheet.room_meta(org);
            let tabs = caller
                .room(state, &room, "tabs", json!([meta]))
                .await
                .map_err(refuse)?;
            let tab_id = tabs
                .as_array()
                .and_then(|t| t.first())
                .map(|t| t["id"].clone());
            if let Some(values) = input.get("values").filter(|v| cell_count(v) > 0) {
                if cell_count(values) > MAX_WRITE_CELLS {
                    return Err(format!("At most {MAX_WRITE_CELLS} cells per write"));
                }
                let wrote = caller
                    .room(
                        state,
                        &room,
                        "writeRange",
                        json!([meta, { "values": values, "userId": caller.user_id }]),
                    )
                    .await
                    .map_err(refuse)?;
                if wrote["ok"] == json!(false) {
                    return Err(wrote["error"]
                        .as_str()
                        .unwrap_or("The write failed")
                        .to_owned());
                }
            }
            Ok(json!({
                "id": sheet.id, "name": sheet.name, "tabId": tab_id,
                "url": format!("/weldsheets/{}", sheet.id),
            }))
        }
        "tabs" | "read" | "write" => {
            let (sheet, role) = find_sheet(&caller, sheet_arg()?).await.map_err(refuse)?;
            let meta = sheet.room_meta(org);
            let room = room_name(org, &sheet.id);
            match op {
                "tabs" => {
                    need("sheets:read")?;
                    let tabs = caller
                        .room(state, &room, "tabs", json!([meta]))
                        .await
                        .map_err(refuse)?;
                    Ok(json!({ "id": sheet.id, "name": sheet.name, "tabs": tabs }))
                }
                "read" => {
                    need("sheets:read")?;
                    let range = json!({ "tab": input["tab"], "range": input["range"] });
                    let answer = caller
                        .room(state, &room, "readRange", json!([meta, range]))
                        .await
                        .map_err(refuse)?;
                    ok_or_error(answer)
                }
                _ => {
                    read_only_refusal(scope.read_only)?;
                    if !caller.may_edit(role) {
                        return Err(VIEW_ONLY.to_owned());
                    }
                    if cell_count(&input["values"]) > MAX_WRITE_CELLS {
                        return Err(format!("At most {MAX_WRITE_CELLS} cells per write"));
                    }
                    let write = json!({
                        "tab": input["tab"], "range": input["range"], "values": input["values"],
                        "userId": caller.user_id,
                    });
                    let answer = caller
                        .room(state, &room, "writeRange", json!([meta, write]))
                        .await
                        .map_err(refuse)?;
                    ok_or_error(answer)
                }
            }
        }
        other => Err(format!("Unknown spreadsheet operation {other}")),
    }
}

/// The room's `{ ok: true, … }` answer as it is, or its `error` as a refusal.
fn ok_or_error(answer: Value) -> Result<Value, String> {
    if answer["ok"] == json!(false) {
        Err(answer["error"]
            .as_str()
            .unwrap_or("The request failed")
            .to_owned())
    } else {
        Ok(answer)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn cells_are_counted_across_rows() {
        assert_eq!(cell_count(&json!([[1, 2], [3]])), 3);
        assert_eq!(cell_count(&json!(null)), 0);
    }

    #[test]
    fn a_room_refusal_becomes_the_message() {
        assert_eq!(
            ok_or_error(json!({ "ok": true, "rows": [] })).unwrap()["rows"],
            json!([])
        );
        assert_eq!(
            ok_or_error(json!({ "ok": false, "error": "Bad range" })).unwrap_err(),
            "Bad range"
        );
    }

    #[test]
    fn like_patterns_are_literal() {
        assert_eq!(escape_like("50%_off"), "50\\%\\_off");
    }

    #[test]
    fn writes_are_refused_with_the_gates_words_in_a_read_only_workspace() {
        assert_eq!(read_only_refusal(None), Ok(()));
        for reason in [
            ReadOnlyReason::PartnerSuspended,
            ReadOnlyReason::LicenceInactive,
            ReadOnlyReason::DatabaseMove,
        ] {
            assert_eq!(
                read_only_refusal(Some(reason)),
                Err(read_only_message(Some(reason)).to_owned())
            );
        }
        let suspended = read_only_refusal(Some(ReadOnlyReason::PartnerSuspended));
        assert!(
            suspended
                .unwrap_err()
                .contains("account that manages it is suspended")
        );
        let moving = read_only_refusal(Some(ReadOnlyReason::DatabaseMove));
        assert!(
            moving
                .unwrap_err()
                .contains("being moved to a new database")
        );
    }
}
