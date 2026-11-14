//! What WeldAgent tools do with boards, in process
//! (`apps/workers/board-api/src/routes/internal/boards.ts`, the
//! `BoardsInternal` entrypoint the Global agent tools call).
//!
//! The operations the agent tools use of that entrypoint:
//!
//! | `op` | |
//! |---|---|
//! | `find` | boards the person can open (by name, or in a project) |
//! | `create` | a new empty board (in My Drive or a project) |
//! | `read` | a board as an `outline` or its `text` |
//! | `update` | rename |
//! | `add` | put a board spec on it (laid out by the board engine) |
//! | `edit` | change or remove elements by id |
//!
//! Every call acts for the person the agent works for: they see and change
//! only what their WeldDrive access and project membership allow, with the
//! `boards:*` permissions they hold now. Writes go through the board's room,
//! so everyone with the board open sees them arrive. `Err` is the message the
//! worker's error answer would carry.

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{BOARD_UPDATED, FILE_UPDATED};
use weldsuite_core_domain::drive_access::{DriveRole, load_drive_access_for_user, visible_files};
use weldsuite_core_domain::files::{Change, FileUpdate, UpdatedFile, update_file};
use weldsuite_db::{PgPool, ReadOnlyReason, TenantPermissionQueries, read_only_message};
use weldsuite_events::{EventContext, EventSource};
use weldsuite_permissions::{Permissions, resolve_effective_permissions};
use weldsuite_ports::collab::value_bytes;

use crate::records::{self, BoardRecord, BoardScope, ListBoards, room_name};
use crate::routes::{
    NewBoard, VIEW_ONLY, convert_in_place, drive_role, find_board, live_snapshot, project_access,
    save_new_board, writable_project,
};
use crate::{BoardState, Caller, Refusal, now};

/// Who an agent call acts for, and where.
#[derive(Debug, Clone, Copy)]
pub struct AgentScope<'a> {
    pub db: &'a PgPool,
    pub user_id: &'a str,
    /// The Clerk org id: room names and bucket keys use it.
    pub clerk_org_id: &'a str,
    /// `workspaces.id`.
    pub workspace_id: &'a str,
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

const DEFAULT_BOARD_NAME: &str = "Untitled board";

/// A board's address in the platform (`urlOf`).
fn url_of(board: &BoardRecord) -> String {
    match &board.project_id {
        Some(project) => format!("/weldflow/project/{project}/whiteboard/{}", board.id),
        None => format!("/weldboard/{}", board.id),
    }
}

/// `brief(board, role)`.
fn brief(board: &BoardRecord, role: DriveRole) -> Value {
    json!({
        "id": board.id, "name": board.name, "projectId": board.project_id,
        "createdAt": board.created_at, "updatedAt": board.updated_at,
        "updatedById": board.updated_by_id, "revision": board.revision,
        "role": role.as_str(), "legacy": board.legacy, "url": url_of(board),
    })
}

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

async fn caller_for(scope: &AgentScope<'_>, state: &BoardState) -> Result<Caller, String> {
    let queries = TenantPermissionQueries::new(scope.db.clone());
    let resolved = resolve_effective_permissions(&queries, scope.user_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[board/agent] resolving permissions failed");
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
        links: None,
        workspace_id: scope.workspace_id.to_owned(),
        ai: state.ai.clone(),
        master: state.master.clone(),
    })
}

/// The board to write to, converted first when it is an old WeldFlow
/// whiteboard (`writeTarget`): the `boards:update` permission, edit access.
async fn write_target(
    state: &BoardState,
    scope: &AgentScope<'_>,
    caller: &Caller,
    org: &str,
    id: &str,
) -> Result<BoardRecord, String> {
    if !caller.can("boards:update") {
        return Err("Forbidden".to_owned());
    }
    read_only_refusal(scope.read_only)?;
    let (board, role) = find_board(caller, id).await.map_err(|r| r.message())?;
    if !caller.may_edit(role) {
        return Err(VIEW_ONLY.to_owned());
    }
    if !board.legacy {
        return records::get_live_board(&caller.db, &board.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| Refusal::not_found("Board", id).message());
    }
    match convert_in_place(state, caller, org, &board).await {
        Ok(Some((converted, _))) => Ok(converted),
        Ok(None) => Err(Refusal::not_found("Board", id).message()),
        Err(refusal) => Err(refusal.message()),
    }
}

/// The room's `applyOps` on `op`: the revision after, or the refusal.
async fn commit(
    state: &BoardState,
    caller: &Caller,
    org: &str,
    board: &BoardRecord,
    op: &Value,
) -> Result<i64, String> {
    let result = caller
        .room(
            state,
            &room_name(org, &board.id),
            "applyOps",
            json!([board.room_meta(org), op, caller.user_id]),
        )
        .await
        .map_err(|r| r.message())?;
    if result["committed"] == json!(true) {
        Ok(result["revision"].as_i64().unwrap_or(0))
    } else {
        Err(format!(
            "The change was refused: {}",
            result["refused"].as_str().unwrap_or("unknown reason")
        ))
    }
}

fn now_ms() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default()
}

/// One agent operation, as the worker's internal route answers it.
///
/// # Errors
///
/// The refusal's message: no permission, an unknown or unreadable board, a
/// change the room refused.
#[allow(clippy::too_many_lines)] // the six routes
pub async fn agent_call(
    state: &BoardState,
    scope: &AgentScope<'_>,
    op: &str,
    board_id: Option<&str>,
    input: &Value,
) -> Result<Value, String> {
    let caller = caller_for(scope, state).await?;
    let org = scope.clerk_org_id;
    let refuse = |r: Refusal| r.message();
    let need = |key: &str| {
        if caller.can(key) {
            Ok(())
        } else {
            Err("Forbidden".to_owned())
        }
    };
    let board_arg = || board_id.ok_or_else(|| "A board id is required".to_owned());
    match op {
        "find" => {
            need("boards:read")?;
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id))
                .await
                .map_err(|e| e.to_string())?;
            let limit = input["limit"].as_i64().unwrap_or(20).clamp(1, 100);
            let (board_scope, project_write) = match input["projectId"].as_str() {
                Some(project_id) => {
                    let a = project_access(&caller, project_id).await.map_err(refuse)?;
                    if !a.may_access() {
                        return Err(Refusal::not_found("Project", project_id).message());
                    }
                    (
                        BoardScope::Project(project_id.to_owned()),
                        Some(a.can_write),
                    )
                }
                None => (BoardScope::Drive, None),
            };
            let visible = matches!(board_scope, BoardScope::Drive)
                .then(|| visible_files(&access))
                .flatten();
            let search = input["query"]
                .as_str()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(|q| format!("%{}%", escape_like(q)));
            let (rows, total) = records::list_boards(
                &caller.db,
                &ListBoards {
                    visible,
                    scope: board_scope,
                    search,
                    limit,
                    offset: 0,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            let boards: Vec<Value> = rows
                .iter()
                .map(|board| {
                    let base = drive_role(&access, board).unwrap_or(DriveRole::Viewer);
                    let write = match (&board.project_id, project_write) {
                        (Some(_), Some(write)) => write,
                        (Some(_), None) => false,
                        (None, _) => true,
                    };
                    brief(board, if write { base } else { DriveRole::Viewer })
                })
                .collect();
            let has_more = i64::try_from(rows.len()).unwrap_or(0) < total;
            Ok(json!({ "boards": boards, "total": total, "hasMore": has_more }))
        }
        "create" => {
            need("boards:create")?;
            read_only_refusal(scope.read_only)?;
            let project = match input["projectId"].as_str() {
                Some(project_id) => Some(
                    writable_project(&caller, project_id)
                        .await
                        .map_err(refuse)?,
                ),
                None => None,
            };
            let made = caller
                .engine(state, "newBoard", json!([null]))
                .await
                .map_err(refuse)?;
            let checkpoint = value_bytes(&made["checkpoint"])
                .ok_or_else(|| "Internal server error".to_owned())?;
            let name = input["name"]
                .as_str()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(DEFAULT_BOARD_NAME)
                .to_owned();
            let board = save_new_board(
                state,
                &caller,
                NewBoard {
                    org,
                    name,
                    folder: None,
                    project,
                    template_category: None,
                    checkpoint,
                },
            )
            .await
            .map_err(refuse)?;
            Ok(brief(&board, DriveRole::Owner))
        }
        "read" => {
            need("boards:read")?;
            let (board, role) = find_board(&caller, board_arg()?).await.map_err(refuse)?;
            let format = match input["format"].as_str() {
                Some("text") => "text",
                _ => "outline",
            };
            let limit = input["limit"].as_i64();
            let mut out = brief(&board, role);
            let read = if board.legacy {
                let old = records::legacy_elements(&caller.db, &board.id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| Refusal::not_found("Board", &board.id).message())?;
                caller
                    .engine(
                        state,
                        "readAs",
                        json!([{ "legacyJson": old.0 }, format, limit]),
                    )
                    .await
                    .map_err(refuse)?
            } else {
                let live = live_snapshot(state, &caller, org, &board)
                    .await
                    .map_err(refuse)?;
                out["revision"] = live["revision"].clone();
                caller
                    .engine(
                        state,
                        "readAs",
                        json!([{ "liveJson": live["json"] }, format, limit]),
                    )
                    .await
                    .map_err(refuse)?
            };
            if let (Some(into), Some(from)) = (out.as_object_mut(), read.as_object()) {
                into.extend(from.clone());
            }
            Ok(out)
        }
        "update" => {
            // A rename (the WeldFlow-elements form of the route is the deprecated API's).
            let name = input["name"]
                .as_str()
                .map(str::trim)
                .filter(|n| !n.is_empty());
            let Some(name) = name else {
                return Err("Send a name or elements".to_owned());
            };
            let before = write_target(state, scope, &caller, org, board_arg()?).await?;
            if before.name != name {
                match update_file(
                    &caller.db,
                    before.file_id(),
                    &FileUpdate {
                        file_name: Change::Set(name.to_owned()),
                        ..FileUpdate::default()
                    },
                    &now(),
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    UpdatedFile::Updated { .. } => {}
                    UpdatedFile::NameConflict => {
                        return Err("A file with this name already exists".to_owned());
                    }
                    UpdatedFile::NotFound => {
                        return Err(Refusal::not_found("Board", &before.id).message());
                    }
                }
            }
            let board = records::get_live_board(&caller.db, &before.id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| Refusal::not_found("Board", &before.id).message())?;
            let changes = json!({ "name": { "old": before.name, "new": board.name } });
            if before.name != board.name {
                let changes = changes.as_object().cloned().unwrap_or_default();
                caller.publish_changes(
                    state,
                    FILE_UPDATED,
                    board.file_id(),
                    &board.file_event_data(None),
                    changes.clone(),
                );
                caller.publish_changes(
                    state,
                    BOARD_UPDATED,
                    &board.id,
                    &board.event_data(),
                    changes,
                );
            }
            Ok(brief(&board, DriveRole::Editor))
        }
        "add" | "edit" => {
            let board = write_target(state, scope, &caller, org, board_arg()?).await?;
            let live = live_snapshot(state, &caller, org, &board)
                .await
                .map_err(refuse)?;
            let live_json = live["json"].clone();
            if op == "add" {
                let at = input
                    .get("at")
                    .filter(|a| !a.is_null())
                    .cloned()
                    .unwrap_or(Value::Null);
                let placed = caller
                    .engine(
                        state,
                        "place",
                        json!([live_json, input["spec"], caller.user_id, now_ms(), at]),
                    )
                    .await
                    .map_err(refuse)?;
                if placed["all"].as_array().is_none_or(Vec::is_empty) {
                    return Err("There is nothing to add".to_owned());
                }
                let revision = commit(state, &caller, org, &board, &placed["op"]).await?;
                Ok(json!({
                    "revision": revision, "elementIds": placed["ids"], "keys": placed["keys"],
                    "url": url_of(&board),
                }))
            } else {
                let edited = caller
                    .engine(state, "edit", json!([live_json, input["changes"]]))
                    .await
                    .map_err(refuse)?;
                if edited["op"].is_null() {
                    return Ok(json!({
                        "revision": live["revision"], "changed": [], "skipped": edited["skipped"],
                        "url": url_of(&board),
                    }));
                }
                let revision = commit(state, &caller, org, &board, &edited["op"]).await?;
                Ok(json!({
                    "revision": revision, "changed": edited["changed"], "skipped": edited["skipped"],
                    "url": url_of(&board),
                }))
            }
        }
        other => Err(format!("Unknown board operation {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_boards_address_follows_its_project() {
        let mut board = BoardRecord {
            id: "brd_1".into(),
            file_id: None,
            name: "B".into(),
            folder_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            created_by_id: None,
            updated_by_id: None,
            revision: 0,
            snapshot_key: None,
            project_id: None,
            template_category: None,
            legacy: false,
            file: None,
        };
        assert_eq!(url_of(&board), "/weldboard/brd_1");
        board.project_id = Some("prj_1".into());
        assert_eq!(url_of(&board), "/weldflow/project/prj_1/whiteboard/brd_1");
        assert_eq!(brief(&board, DriveRole::Editor)["role"], "editor");
    }

    #[test]
    fn like_patterns_are_literal() {
        assert_eq!(escape_like("a_b%"), "a\\_b\\%");
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
