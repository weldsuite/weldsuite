//! Board routes (`routes/boards/index.ts` and `access.ts`).

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    BOARD_CREATED, BOARD_DELETED, BOARD_UPDATED, FILE_CREATED, FILE_DELETED, FILE_UPDATED,
    PROJECT_WHITEBOARD_DELETED, TASK_CREATED,
};
use weldsuite_catalogs::permission_keys::{
    BOARDS_CREATE, BOARDS_UPDATE, PROJECTS_SCOPE_ALL, TASKS_CREATE,
};
use weldsuite_core_domain::drive_access::{
    DriveAccessIndex, DriveRole, can_edit, container_role, file_role, load_drive_access_for_user,
    visible_files,
};
use weldsuite_core_domain::files::{
    Change, FileUpdate, NewFile, UpdatedFile, create_file, deduplicate_file_name, soft_delete_file,
    update_file,
};
use weldsuite_flow_domain::access::{ProjectAccess, member_project_ids, resolve_project_access};
use weldsuite_flow_domain::tasks::{CreateError, create_task};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_ports::collab::value_bytes;
use weldsuite_ports::files::PutOptions;

use crate::records::{
    self, BoardRecord, BoardScope, ConvertLegacy, ListBoards, NewBoardRow, PROJECT_ENTITY,
    WELDBOARD_MIME_TYPE, member_profile, room_name, snapshot_key_for, thumbnail_key_for,
};
use crate::{BoardState, Caller, Refusal, answer, color_for, now, validate, validate_query};

pub(crate) const VIEW_ONLY: &str = "You can view this board but not change it";
const DEFAULT_LIMIT: i64 = 50;
/// `DEFAULT_BOARD_NAME`.
const DEFAULT_BOARD_NAME: &str = "Untitled board";
/// `BOARD_SNAPSHOT_MAX_BYTES`: the longest import, in UTF-16 units.
const IMPORT_MAX: usize = 20 * 1024 * 1024;
const TEMPLATE_CATEGORIES: [&str; 6] = [
    "meetings",
    "ideation",
    "planning",
    "strategy",
    "diagramming",
    "other",
];
const IMPORT_FORMATS: [&str; 4] = ["excalidraw", "csv", "text", "weldboard"];
const AI_ACTIONS: [&str; 6] = [
    "mindmap",
    "diagram",
    "stickies",
    "cluster",
    "summarize",
    "ideas",
];

// ── access ──────────────────────────────────────────────────────────────────

/// `projectAccess(c, projectId)`.
pub(crate) async fn project_access(
    caller: &Caller,
    project_id: &str,
) -> Result<ProjectAccess, Refusal> {
    Ok(resolve_project_access(
        &caller.db,
        Some(&caller.user_id)
            .filter(|id| !id.is_empty())
            .map(String::as_str),
        caller.can(PROJECTS_SCOPE_ALL),
        project_id,
    )
    .await?)
}

/// `projectRole(c, projectId, role)`: a project's board follows the project.
pub(crate) async fn project_role(
    caller: &Caller,
    project_id: &str,
    role: DriveRole,
) -> Result<Option<DriveRole>, Refusal> {
    let access = project_access(caller, project_id).await?;
    if !access.may_access() {
        return Ok(None);
    }
    Ok(Some(if access.can_write {
        role
    } else {
        DriveRole::Viewer
    }))
}

/// The caller's role on a board given their drive access, before any
/// project narrowing (`driveRole`).
pub(crate) fn drive_role(access: &DriveAccessIndex, board: &BoardRecord) -> Option<DriveRole> {
    if let Some(role) = board.file.as_ref().and_then(|file| file_role(access, file)) {
        return Some(role);
    }
    if board.template_category.is_some() {
        return Some(DriveRole::Viewer);
    }
    // An old whiteboard has no file: the project alone decides.
    board.legacy.then_some(DriveRole::Editor)
}

pub(crate) async fn drive_access(caller: &Caller) -> Result<DriveAccessIndex, Refusal> {
    Ok(load_drive_access_for_user(
        &caller.db,
        Some(&caller.user_id)
            .filter(|id| !id.is_empty())
            .map(String::as_str),
    )
    .await?)
}

/// The board with the caller's role on it, or the 404 (`findBoard`).
pub(crate) async fn find_board(
    caller: &Caller,
    id: &str,
) -> Result<(BoardRecord, DriveRole), Refusal> {
    let Some(board) = records::get_board(&caller.db, id).await? else {
        return Err(Refusal::not_found("Board", id));
    };
    let access = drive_access(caller).await?;
    let mut role = drive_role(&access, &board);
    if let (Some(project_id), Some(found)) = (board.project_id.as_deref(), role) {
        role = project_role(caller, project_id, found).await?;
    }
    match role {
        Some(role) => Ok((board, role)),
        None => Err(Refusal::not_found("Board", id)),
    }
}

/// A converted board with the caller's role on it; an old whiteboard is a
/// 404 here (`findLiveBoard`).
pub(crate) async fn find_live_board(
    caller: &Caller,
    id: &str,
) -> Result<(BoardRecord, DriveRole), Refusal> {
    let (board, role) = find_board(caller, id).await?;
    if !board.is_live() {
        return Err(Refusal::not_found("Board", id));
    }
    Ok((board, role))
}

/// The converted board, if the caller may change it (`editableBoard`).
pub(crate) async fn editable_board(caller: &Caller, id: &str) -> Result<BoardRecord, Refusal> {
    let (board, role) = find_live_board(caller, id).await?;
    if !caller.may_edit(role) {
        return Err(Refusal::forbidden(VIEW_ONLY));
    }
    Ok(board)
}

/// A folder the caller may add to (`None` for My Drive), or the refusal (`editableFolder`).
async fn editable_folder(
    caller: &Caller,
    folder_id: Option<&str>,
) -> Result<Option<String>, Refusal> {
    let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let access = drive_access(caller).await?;
    match container_role(&access, Some(folder_id)) {
        None => Err(Refusal::not_found("Folder", folder_id)),
        Some(role) if !can_edit(Some(role)) => Err(Refusal::forbidden(
            "You can view this folder but not add to it",
        )),
        Some(_) => Ok(Some(folder_id.to_owned())),
    }
}

/// A live project the caller may add work to (`writableProject`).
pub(crate) async fn writable_project(caller: &Caller, project_id: &str) -> Result<String, Refusal> {
    let access = project_access(caller, project_id).await?;
    if !records::project_exists(&caller.db, project_id).await? || !access.may_access() {
        return Err(Refusal::not_found("Project", project_id));
    }
    if !access.can_write {
        return Err(Refusal::forbidden(
            "You can view this project but not add to it",
        ));
    }
    Ok(project_id.to_owned())
}

/// `accessibleProjectIds(db, userId, { scopeAll })`: `None` for every live project.
async fn accessible_project_ids(caller: &Caller) -> Result<Option<Vec<String>>, Refusal> {
    if caller.can(PROJECTS_SCOPE_ALL) {
        return Ok(None);
    }
    if caller.user_id.is_empty() {
        return Ok(Some(Vec::new()));
    }
    Ok(Some(member_project_ids(&caller.db, &caller.user_id).await?))
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

/// The board's live content as the room hands it over (`room.snapshot(meta)`):
/// `{ revision, json }`.
pub(crate) async fn live_snapshot(
    state: &BoardState,
    caller: &Caller,
    org: &str,
    board: &BoardRecord,
) -> Result<Value, Refusal> {
    caller
        .room(
            state,
            &room_name(org, &board.id),
            "snapshot",
            json!([board.room_meta(org)]),
        )
        .await
}

fn live_json(live: &Value) -> String {
    live["json"].as_str().unwrap_or("null").to_owned()
}

/// The gzipped checkpoint an engine function made.
fn engine_checkpoint(made: &Value) -> Result<Vec<u8>, Refusal> {
    value_bytes(&made["checkpoint"]).ok_or_else(|| {
        tracing::error!("[board-api] the engine answered without a checkpoint");
        ApiError::internal().into()
    })
}

/// Writes a checkpoint as `writeSnapshot` does (revision 0); its size, or
/// `None` when `create_only` and the key already held one.
async fn write_checkpoint(
    state: &BoardState,
    caller: &Caller,
    key: &str,
    checkpoint: Vec<u8>,
    create_only: bool,
) -> Result<Option<i64>, Refusal> {
    let size = i64::try_from(checkpoint.len()).unwrap_or(i64::MAX);
    let files = caller.files(state)?;
    let mut options = PutOptions::content_type("application/gzip").with_metadata("revision", "0");
    options.create_only = create_only;
    let stored = files
        .private
        .put_boxed(key, checkpoint, &options)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[board-api] writing a checkpoint failed");
            Refusal::from(ApiError::internal())
        })?;
    Ok(stored.map(|_| size))
}

// ── GET / ───────────────────────────────────────────────────────────────────

struct ListQuery {
    search: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
    project_id: Option<String>,
    projects: Option<String>,
    templates: Option<String>,
}

fn true_or_false(issues: &mut Issues, query: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .choice(query, key, Presence::Optional, &["true", "false"])
        .into_option()
}

#[allow(clippy::too_many_lines)] // the scopes and their roles, as the TypeScript route
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let q = validate_query(raw.as_deref(), |issues, query| ListQuery {
                search: issues
                    .text_with(
                        query,
                        "search",
                        Presence::Optional,
                        Text::trimmed(None, Some(255)),
                    )
                    .into_option(),
                limit: issues
                    .whole_number(
                        query,
                        "limit",
                        Presence::Optional,
                        Number {
                            coerce: true,
                            int: true,
                            min: Some(1.0),
                            max: Some(200.0),
                        },
                    )
                    .into_option(),
                cursor: issues
                    .pattern(
                        query,
                        "cursor",
                        Presence::Optional,
                        None,
                        None,
                        |text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
                        "Invalid",
                    )
                    .into_option(),
                project_id: issues
                    .text(query, "projectId", Presence::Optional, Some(1), Some(255))
                    .into_option(),
                projects: true_or_false(issues, query, "projects"),
                templates: true_or_false(issues, query, "templates"),
            })?;
            let access = drive_access(&caller).await?;
            let offset = q
                .cursor
                .as_deref()
                .map_or(0, |c| c.parse::<i64>().unwrap_or(i64::MAX));
            let may_edit = caller.may_update();

            // A project's boards are its members': the project decides, not the drive.
            let mut project_as: Option<DriveRole> = None;
            let scope = if let Some(project_id) = q.project_id.clone() {
                let Some(role) = project_role(&caller, &project_id, DriveRole::Editor).await?
                else {
                    return Err(Refusal::not_found("Project", &project_id));
                };
                project_as = Some(if role == DriveRole::Viewer {
                    DriveRole::Viewer
                } else {
                    DriveRole::Editor
                });
                BoardScope::Project(project_id)
            } else if q.projects.as_deref() == Some("true") {
                BoardScope::Projects(accessible_project_ids(&caller).await?)
            } else if q.templates.as_deref() == Some("true") {
                BoardScope::Templates
            } else {
                BoardScope::Drive
            };
            let projects_scope = matches!(scope, BoardScope::Projects(_));
            let params = ListBoards {
                // Templates are open to everyone; drive boards follow the drive's sharing.
                visible: if matches!(scope, BoardScope::Drive) {
                    visible_files(&access)
                } else {
                    None
                },
                scope,
                search: q
                    .search
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("%{}%", escape_like(&s))),
                limit: q.limit.unwrap_or(DEFAULT_LIMIT),
                offset,
            };
            let (rows, total) = records::list_boards(&caller.db, &params).await?;

            // Across projects, each board's role follows its own project.
            let mut project_roles: HashMap<String, DriveRole> = HashMap::new();
            if projects_scope {
                let mut seen = HashSet::new();
                for project_id in rows.iter().filter_map(|r| r.project_id.as_deref()) {
                    if !seen.insert(project_id) {
                        continue;
                    }
                    let a = project_access(&caller, project_id).await?;
                    if a.may_access() {
                        let role = if a.can_write {
                            DriveRole::Editor
                        } else {
                            DriveRole::Viewer
                        };
                        project_roles.insert(project_id.to_owned(), role);
                    }
                }
            }
            let data = rows
                .iter()
                .map(|board| {
                    let base = drive_role(&access, board).unwrap_or(DriveRole::Viewer);
                    let role = match board.project_id.as_deref() {
                        None => base,
                        Some(project_id) => {
                            let project =
                                project_as.or_else(|| project_roles.get(project_id).copied());
                            if project == Some(DriveRole::Editor) {
                                base
                            } else {
                                DriveRole::Viewer
                            }
                        }
                    };
                    board.summary(role, may_edit)
                })
                .collect();
            let next = offset.saturating_add(i64::try_from(rows.len()).unwrap_or(0));
            let has_more = next < total;
            Ok(List::new(
                data,
                Pagination::new(
                    u64::try_from(total).unwrap_or(0),
                    has_more,
                    has_more.then(|| next.to_string()),
                ),
            )
            .into_response())
        }
        .await,
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `z.custom` of a board snapshot: an object with an integer `version`.
fn is_snapshot_like(value: &Value) -> bool {
    value
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version.fract() == 0.0 && version.is_finite())
}

/// `z.object({ category: z.enum(TEMPLATE_CATEGORIES) })` at `template`.
fn template_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> Field<String> {
    match issues.nested(body, "template", presence, |issues, fields| {
        issues
            .choice(fields, "category", Presence::Required, &TEMPLATE_CATEGORIES)
            .into_option()
    }) {
        Field::Set(Some(category)) => Field::Set(category),
        Field::Set(None) | Field::Absent => Field::Absent,
        Field::Null => Field::Null,
    }
}

struct CreateBody {
    name: Option<String>,
    folder_id: Option<String>,
    project_id: Option<String>,
    snapshot: bool,
    from_board_id: Option<String>,
    template: Option<String>,
}

/// What a new board is saved as (`saveNewBoard`'s params).
pub(crate) struct NewBoard<'a> {
    pub(crate) org: &'a str,
    pub(crate) name: String,
    pub(crate) folder: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) template_category: Option<String>,
    pub(crate) checkpoint: Vec<u8>,
}

pub(crate) async fn create(
    State(state): State<BoardState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, body| {
                let name = issues
                    .text_with(
                        body,
                        "name",
                        Presence::Optional,
                        Text::trimmed(Some(1), Some(255)),
                    )
                    .into_option();
                let folder_id = issues
                    .text(body, "folderId", Presence::Nullish, None, None)
                    .into_option();
                let project_id = issues
                    .text(body, "projectId", Presence::Optional, Some(1), Some(255))
                    .into_option();
                let snapshot = body.get("snapshot");
                if snapshot.is_some_and(|value| !is_snapshot_like(value)) {
                    // `z.custom` reports its issue as fatal.
                    issues.push_issue(
                        "snapshot",
                        json!({ "code": "custom", "fatal": true, "message": "Expected a board snapshot" }),
                    );
                }
                let from_board_id = issues
                    .text(body, "fromBoardId", Presence::Optional, Some(1), Some(255))
                    .into_option();
                let template = template_field(issues, body, Presence::Optional).into_option();
                CreateBody {
                    name,
                    folder_id,
                    project_id,
                    snapshot: snapshot.is_some(),
                    from_board_id,
                    template,
                }
            })?;
            caller.user()?;
            let org = caller.org()?.to_owned();
            if caller.read_only {
                return Err(Refusal::forbidden("This workspace is read-only"));
            }
            if input.project_id.is_some() && input.template.is_some() {
                return Err(Refusal::bad_request(
                    "A project's board cannot be a workspace template",
                ));
            }
            let project = match input.project_id.as_deref() {
                Some(project_id) => Some(writable_project(&caller, project_id).await?),
                None => None,
            };
            let folder = if project.is_some() {
                None
            } else {
                editable_folder(&caller, input.folder_id.as_deref()).await?
            };

            let mut fallback_name = DEFAULT_BOARD_NAME.to_owned();
            let made = if let Some(source_id) = input.from_board_id.as_deref() {
                // A copy: another board as its room holds it now. Templates may be copied by anyone.
                let (source, _) = find_converted(&state, &caller, source_id, |_| true).await?;
                let live = live_snapshot(&state, &caller, &org, &source).await?;
                fallback_name.clone_from(&source.name);
                caller
                    .engine(&state, "copyBoard", json!([live_json(&live)]))
                    .await?
            } else if input.snapshot {
                // As the text the client sent: the engine keeps the snapshot's key order.
                let sent = raw_field(&body, "snapshot").unwrap_or_default();
                let made = caller.engine(&state, "newBoard", json!([sent])).await?;
                if made["ok"] != Value::Bool(true) {
                    return Err(Refusal::bad_request("That is not a board snapshot"));
                }
                made
            } else {
                caller.engine(&state, "newBoard", json!([null])).await?
            };
            let board = save_new_board(
                &state,
                &caller,
                NewBoard {
                    org: &org,
                    name: input.name.unwrap_or(fallback_name),
                    folder,
                    project,
                    template_category: input.template,
                    checkpoint: engine_checkpoint(&made)?,
                },
            )
            .await?;
            Ok(Created(board.summary(DriveRole::Owner, caller.may_update())).into_response())
        }
        .await,
    )
}

/// A top-level field of a JSON body as the text it was sent as.
fn raw_field(body: &[u8], key: &str) -> Option<String> {
    let fields: HashMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_slice(body).ok()?;
    fields.get(key).map(|raw| raw.get().to_owned())
}

/// Stores a new board from its first checkpoint: the checkpoint first, so a
/// room never opens a board without one, then its drive file and row, and
/// reports both (`saveNewBoard`).
pub(crate) async fn save_new_board(
    state: &BoardState,
    caller: &Caller,
    new: NewBoard<'_>,
) -> Result<BoardRecord, Refusal> {
    let board_id = generate_id("brd");
    let key = snapshot_key_for(new.org, &board_id);
    let size = write_checkpoint(state, caller, &key, new.checkpoint, false)
        .await?
        .unwrap_or(0);
    let (entity_type, entity_id, folder) = match new.project {
        Some(project) => (Some(PROJECT_ENTITY.to_owned()), Some(project), None),
        None => (None, None, new.folder),
    };
    let file = create_file(
        &caller.db,
        &NewFile {
            file_name: new.name.clone(),
            original_name: Some(new.name),
            mime_type: WELDBOARD_MIME_TYPE.to_owned(),
            file_size: size,
            file_type: Some(records::BOARD_FILE_TYPE.to_owned()),
            storage_path: key.clone(),
            file_key: Some(key.clone()),
            bucket: Some("private".to_owned()),
            folder_id: folder,
            metadata: Some(json!({ "weldBoardId": board_id })),
            uploaded_by_id: caller.user_id.clone(),
            entity_type,
            entity_id,
            ..NewFile::default()
        },
        &now(),
    )
    .await?;
    let file_id = file["id"].as_str().unwrap_or_default().to_owned();
    records::insert_board(
        &caller.db,
        &NewBoardRow {
            id: &board_id,
            file_id: &file_id,
            snapshot_key: &key,
            template_category: new.template_category.as_deref(),
            user_id: &caller.user_id,
        },
        &now(),
    )
    .await?;
    let Some(created) = records::get_live_board(&caller.db, &board_id).await? else {
        tracing::error!(board_id, "[board-api] a board vanished after insert");
        return Err(ApiError::internal().into());
    };
    caller.publish(
        state,
        FILE_CREATED,
        created.file_id(),
        &created.file_event_data(Some(size)),
    );
    caller.publish(state, BOARD_CREATED, &created.id, &created.event_data());
    Ok(created)
}

// ── POST /import ────────────────────────────────────────────────────────────

pub(crate) async fn import(
    State(state): State<BoardState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, format, content, folder_id, project_id) =
                validate(&headers, &body, |issues, body| {
                    let name = issues
                        .text_with(
                            body,
                            "name",
                            Presence::Required,
                            Text::trimmed(Some(1), Some(255)),
                        )
                        .into_option();
                    let format = issues
                        .choice(body, "format", Presence::Required, &IMPORT_FORMATS)
                        .into_option();
                    let content = issues
                        .text(
                            body,
                            "content",
                            Presence::Required,
                            Some(1),
                            Some(IMPORT_MAX),
                        )
                        .into_option();
                    let folder_id = issues
                        .text(body, "folderId", Presence::Nullish, None, None)
                        .into_option();
                    let project_id = issues
                        .text(body, "projectId", Presence::Optional, Some(1), Some(255))
                        .into_option();
                    (
                        name.unwrap_or_default(),
                        format.unwrap_or_default(),
                        content.unwrap_or_default(),
                        folder_id,
                        project_id,
                    )
                })?;
            caller.user()?;
            let org = caller.org()?.to_owned();
            if caller.read_only {
                return Err(Refusal::forbidden("This workspace is read-only"));
            }
            let project = match project_id.as_deref() {
                Some(project_id) => Some(writable_project(&caller, project_id).await?),
                None => None,
            };
            let folder = if project.is_some() {
                None
            } else {
                editable_folder(&caller, folder_id.as_deref()).await?
            };
            let read = caller
                .engine(&state, "importBoard", json!([format, content]))
                .await?;
            if read["ok"] != Value::Bool(true) {
                return Err(
                    ApiError::bad_request("This file could not be read as a board")
                        .with_details(json!({ "reason": "unreadable" }))
                        .into(),
                );
            }
            let board = save_new_board(
                &state,
                &caller,
                NewBoard {
                    org: &org,
                    name,
                    folder,
                    project,
                    template_category: None,
                    checkpoint: engine_checkpoint(&read)?,
                },
            )
            .await?;
            let mut summary = board.summary(DriveRole::Owner, caller.may_update());
            summary["skipped"] = read["skipped"].clone();
            Ok(Created(summary).into_response())
        }
        .await,
    )
}

// ── POST /convert ───────────────────────────────────────────────────────────

/// An old WeldFlow whiteboard made a board in place: same id, same project,
/// its elements converted (`convertInPlace`). A board someone else converted
/// meanwhile is returned as theirs (`created` false). `None` when it is gone.
pub(crate) async fn convert_in_place(
    state: &BoardState,
    caller: &Caller,
    org: &str,
    legacy: &BoardRecord,
) -> Result<Option<(BoardRecord, bool)>, Refusal> {
    let winner = || async {
        Ok::<_, Refusal>(
            records::get_live_board(&caller.db, &legacy.id)
                .await?
                .map(|board| (board, false)),
        )
    };
    let Some((elements, last_edited_by)) = records::legacy_elements(&caller.db, &legacy.id).await?
    else {
        return winner().await;
    };
    let made = caller
        .engine(
            state,
            "convertLegacy",
            json!([elements, last_edited_by.filter(|by| !by.is_empty())]),
        )
        .await?;
    let key = snapshot_key_for(org, &legacy.id);
    // Only when there is none yet: a board converted meanwhile may already
    // have checkpointed edits there.
    let size = write_checkpoint(state, caller, &key, engine_checkpoint(&made)?, true)
        .await?
        .unwrap_or(0);
    let file_name = deduplicate_file_name(&caller.db, &legacy.name, None).await?;
    let file_name = if file_name.is_empty() {
        legacy.name.clone()
    } else {
        file_name
    };
    let converted = records::convert_legacy(
        &caller.db,
        &ConvertLegacy {
            legacy,
            snapshot_key: &key,
            snapshot_size: size,
            user_id: &caller.user_id,
            file_name: &file_name,
        },
        &now(),
    )
    .await?;
    let Some(converted) = converted else {
        return winner().await;
    };
    caller.publish(
        state,
        FILE_CREATED,
        converted.file_id(),
        &converted.file_event_data(Some(size)),
    );
    caller.publish(state, BOARD_CREATED, &converted.id, &converted.event_data());
    Ok(Some((converted, true)))
}

/// A board with the caller's role on it, an old WeldFlow whiteboard
/// converted first (`findConverted`); `may_convert` says whether this caller
/// may trigger that.
pub(crate) async fn find_converted(
    state: &BoardState,
    caller: &Caller,
    id: &str,
    may_convert: impl FnOnce(DriveRole) -> bool,
) -> Result<(BoardRecord, DriveRole), Refusal> {
    let (board, role) = find_board(caller, id).await?;
    if !board.legacy {
        return find_live_board(caller, id).await;
    }
    caller.user()?;
    let org = caller.org()?.to_owned();
    if !may_convert(role) {
        return Err(Refusal::forbidden(VIEW_ONLY));
    }
    match convert_in_place(state, caller, &org, &board).await? {
        Some((converted, _)) => Ok((converted, role)),
        None => Err(Refusal::not_found("Board", id)),
    }
}

pub(crate) async fn convert(
    State(state): State<BoardState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let whiteboard_id = validate(&headers, &body, |issues, body| {
                issues
                    .text(body, "whiteboardId", Presence::Required, Some(1), Some(255))
                    .into_option()
                    .unwrap_or_default()
            })?;
            caller.user()?;
            let org = caller.org()?.to_owned();
            let (board, role) = find_board(&caller, &whiteboard_id).await?;
            let may_edit = caller.may_update();
            if !board.legacy {
                return Ok(Data(board.summary(role, may_edit)).into_response());
            }
            match convert_in_place(&state, &caller, &org, &board).await? {
                Some((converted, true)) => {
                    Ok(Created(converted.summary(role, may_edit)).into_response())
                }
                Some((converted, false)) => {
                    Ok(Data(converted.summary(role, may_edit)).into_response())
                }
                None => Err(Refusal::not_found("Board", &whiteboard_id)),
            }
        }
        .await,
    )
}

// ── POST /:id/tasks ─────────────────────────────────────────────────────────

/// Stickies (and cards, shapes, texts) made WeldFlow tasks in a project: one
/// task per element, from its text, and a task card where the element was.
pub(crate) async fn tasks(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (element_ids, project_id) = validate(&headers, &body, |issues, body| {
                let ids = issues
                    .list(body, "elementIds", Presence::Required, Some(1), Some(200), |issues, item| {
                        issues.item_text(item, Text::length(Some(1), Some(64)))
                    })
                    .into_option();
                let project_id = issues
                    .text(body, "projectId", Presence::Required, Some(1), Some(255))
                    .into_option();
                (ids.unwrap_or_default(), project_id.unwrap_or_default())
            })?;
            let user_id = caller.user()?.to_owned();
            let org = caller.org()?.to_owned();
            if !caller.can(TASKS_CREATE) {
                return Err(Refusal::forbidden("You may not create tasks"));
            }
            let board = editable_board(&caller, &id).await?;
            let project = writable_project(&caller, &project_id).await?;

            let meta = board.room_meta(&org);
            let name = room_name(&org, &board.id);
            let live = live_json(&live_snapshot(&state, &caller, &org, &board).await?);
            let picked = caller
                .engine(&state, "taskPlan", json!([live, element_ids]))
                .await?;
            let picked = picked.as_array().cloned().unwrap_or_default();
            if picked.is_empty() {
                return Err(Refusal::bad_request(
                    "None of these elements has text to make a task of",
                ));
            }
            let mut created = Vec::with_capacity(picked.len());
            let now_ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
            for pick in &picked {
                let mut fields = Map::new();
                fields.insert("title".into(), pick["title"].clone());
                if let Some(description) = pick.get("description") {
                    fields.insert("description".into(), description.clone());
                }
                let made = create_task(&caller.db, &fields, Some(&project), &user_id)
                    .await
                    .map_err(|error| match error {
                        CreateError::Database(error) => Refusal::Database(error),
                        CreateError::InvalidDate => Refusal::from(ApiError::internal()),
                    })?;
                let row = &made.row;
                caller.publish(
                    &state,
                    TASK_CREATED,
                    row["id"].as_str().unwrap_or_default(),
                    &json!({
                        "id": row["id"],
                        "title": row["title"],
                        "number": row["number"],
                        "status": row["status"],
                        "priority": row["priority"],
                        "projectId": row["projectId"],
                        "assigneeId": row["assigneeId"],
                    }),
                );
                created.push(json!({ "elementId": pick["elementId"], "taskId": row["id"] }));
            }
            let cards = caller
                .engine(
                    &state,
                    "taskCards",
                    json!([live, created, user_id, i64::try_from(now_ms).unwrap_or(0)]),
                )
                .await?;
            let result = caller
                .room(&state, &name, "applyOps", json!([meta, cards["op"], user_id]))
                .await?;
            // The tasks stand even when the board changed meanwhile; the stickies then simply stay.
            if result["committed"] != Value::Bool(true) {
                tracing::warn!(refused = %result["refused"], "[board-api/tasks] the task cards could not be placed");
            }
            Ok(Created(json!({ "created": created })).into_response())
        }
        .await,
    )
}

// ── POST /:id/ai ────────────────────────────────────────────────────────────

/// `boardAiSchema`, read: the action and the input the engine works from
/// (`{ action, prompt?, elementIds?, at?, locale? }`, as Zod parses it).
fn ai_input(issues: &mut Issues, body: &Map<String, Value>) -> (String, Value) {
    let action = issues
        .choice(body, "action", Presence::Required, &AI_ACTIONS)
        .into_option()
        .unwrap_or_default();
    let mut input = Map::new();
    input.insert("action".into(), json!(action));
    if let Some(prompt) = issues
        .text_with(
            body,
            "prompt",
            Presence::Optional,
            Text::trimmed(None, Some(4000)),
        )
        .into_option()
    {
        input.insert("prompt".into(), json!(prompt));
    }
    if let Some(ids) = issues
        .list(
            body,
            "elementIds",
            Presence::Optional,
            None,
            Some(500),
            |issues, item| issues.item_text(item, Text::length(Some(1), Some(64))),
        )
        .into_option()
    {
        input.insert("elementIds".into(), json!(ids));
    }
    let at = issues
        .nested(body, "at", Presence::Optional, |issues, fields| {
            let x = issues
                .number(fields, "x", Presence::Required, Number::default())
                .into_option();
            let y = issues
                .number(fields, "y", Presence::Required, Number::default())
                .into_option();
            json!({ "x": x, "y": y })
        })
        .into_option();
    if let Some(at) = at {
        input.insert("at".into(), at);
    }
    if let Some(locale) = issues
        .choice(
            body,
            "locale",
            Presence::Optional,
            &["en", "nl", "es", "fr"],
        )
        .into_option()
    {
        input.insert("locale".into(), json!(locale));
    }
    (action, Value::Object(input))
}

/// `POST /:id/ai` (`runBoardAi`): the engine's refusals and what to ask
/// (`aiPrepare`), 503 `AI_NOT_CONFIGURED` without AI, the credit gate, the
/// refusals after it, the model, then the engine's plan (`aiPlan`) committed
/// through the board's room. A summary writes nothing.
pub(crate) async fn ai(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (action, input) = validate(&headers, &body, ai_input)?;
            let user_id = caller.user()?.to_owned();
            let org = caller.org()?.to_owned();
            let writes = action != "summarize";
            if writes && !caller.can(BOARDS_UPDATE) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            let board = if writes {
                editable_board(&caller, &id).await?
            } else {
                find_live_board(&caller, &id).await?.0
            };
            let meta = board.room_meta(&org);
            let name = room_name(&org, &board.id);
            let live = live_json(&live_snapshot(&state, &caller, &org, &board).await?);
            let prepared = caller
                .engine(&state, "aiPrepare", json!([live, input]))
                .await?;
            if let Some(refused) = prepared.get("refused") {
                return Ok(crate::ai::refusal(refused));
            }
            let Some(ai) = caller.ai(&state) else {
                return Ok(crate::ai::not_configured());
            };
            let ask = &prepared["ask"];
            let call = crate::ai::call_for(
                &caller.workspace_id,
                &user_id,
                caller.db.clone(),
                caller.master(&state),
                &action,
                crate::ai::task_of(ask["task"].as_str().unwrap_or_default()),
            );
            if let Err(error) = ai.assert_credits(&call).await {
                return Ok(error.into_api_error().into_response());
            }
            if let Some(refused) = prepared.get("refusedAfterAi") {
                return Ok(crate::ai::refusal(refused));
            }
            let (answer, served) = match crate::ai::ask_model(&ai, &call, ask).await {
                Ok(answered) => answered,
                Err(error) => return Ok(crate::ai::request_failed(&error)),
            };
            let now_ms = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
            let plan = caller
                .engine(
                    &state,
                    "aiPlan",
                    json!([
                        live,
                        input,
                        answer,
                        user_id,
                        i64::try_from(now_ms).unwrap_or(0)
                    ]),
                )
                .await?;
            if let Some(refused) = plan.get("refused") {
                return Ok(crate::ai::refusal(refused));
            }
            if !plan["op"].is_null() {
                let result = caller
                    .room(
                        &state,
                        &name,
                        "applyOps",
                        json!([meta, plan["op"], user_id]),
                    )
                    .await?;
                if result["committed"] != Value::Bool(true) {
                    return Err(ApiError::conflict(
                        "The board changed while the AI was working. Try again.",
                    )
                    .into());
                }
            }
            let mut data = Map::new();
            data.insert("elementIds".into(), plan["elementIds"].clone());
            if let Some(text) = plan.get("text") {
                data.insert("text".into(), text.clone());
                data.insert(
                    "title".into(),
                    plan.get("title").cloned().unwrap_or(Value::Null),
                );
            }
            Ok(
                axum::Json(json!({ "data": data, "meta": { "ai": served.meta() } }))
                    .into_response(),
            )
        }
        .await,
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let (board, role) = find_board(&caller, &id).await?;
            Ok(Data(board.summary(role, caller.may_update())).into_response())
        }
        .await,
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, folder_id, template) = validate(&headers, &body, |issues, body| {
                let name = issues.text_with(
                    body,
                    "name",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(255)),
                );
                let folder_id = issues.text(body, "folderId", Presence::Nullish, None, None);
                let template = template_field(issues, body, Presence::Nullish);
                // The refine sees what parsed: a key left out stays undefined.
                if !body.contains_key("name")
                    && !body.contains_key("folderId")
                    && !body.contains_key("template")
                {
                    issues.custom_root("Send a name, a folder or a template setting");
                }
                (name, folder_id, template)
            })?;
            let read_only = caller.read_only;
            let writable = |role: DriveRole| can_edit(Some(role)) && !read_only;
            let (before, role) = find_converted(&state, &caller, &id, writable).await?;
            if !writable(role) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            if before.project_id.is_some() && (!folder_id.is_absent() || !template.is_absent()) {
                return Err(Refusal::bad_request(
                    "A project's board stays with the project: it cannot be moved or made a template",
                ));
            }
            if !template.is_absent() && !caller.can(BOARDS_CREATE) {
                return Err(Refusal::forbidden(
                    "You may not publish workspace templates",
                ));
            }
            if let Field::Set(folder) = &folder_id {
                editable_folder(&caller, Some(folder)).await?;
            }

            // `updateBoard`: the drive file's name and folder, then the template setting.
            if !name.is_absent() || !folder_id.is_absent() {
                let update = FileUpdate {
                    file_name: name.as_set().cloned().map_or(Change::Keep, Change::Set),
                    folder_id: match &folder_id {
                        Field::Absent => Change::Keep,
                        Field::Null => Change::Set(None),
                        Field::Set(folder) => Change::Set(Some(folder.clone())),
                    },
                    ..FileUpdate::default()
                };
                match update_file(&caller.db, before.file_id(), &update, &now()).await? {
                    UpdatedFile::Updated { .. } => {}
                    UpdatedFile::NameConflict => {
                        return Err(ApiError::conflict(
                            "A file with this name already exists in this folder",
                        )
                        .into());
                    }
                    UpdatedFile::NotFound => return Err(Refusal::not_found("Board", &before.id)),
                }
            }
            if !template.is_absent() {
                records::set_template(&caller.db, &before.id, template.as_set().map(String::as_str), &now())
                    .await?;
            }
            let Some(board) = records::get_live_board(&caller.db, &before.id).await? else {
                return Err(Refusal::not_found("Board", &before.id));
            };

            let mut changed = Map::new();
            if before.name != board.name {
                changed.insert("name".into(), json!({ "old": before.name, "new": board.name }));
            }
            if before.folder_id != board.folder_id {
                changed.insert(
                    "folderId".into(),
                    json!({ "old": before.folder_id, "new": board.folder_id }),
                );
            }
            if before.template_category != board.template_category {
                changed.insert(
                    "templateCategory".into(),
                    json!({ "old": before.template_category, "new": board.template_category }),
                );
            }
            if changed.contains_key("name") || changed.contains_key("folderId") {
                caller.publish_changes(
                    &state,
                    FILE_UPDATED,
                    board.file_id(),
                    &board.file_event_data(None),
                    changed.clone(),
                );
            }
            caller.publish_changes(&state, BOARD_UPDATED, &board.id, &board.event_data(), changed);
            Ok(Data(board.summary(role, true)).into_response())
        }
        .await,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let (board, role) = find_board(&caller, &id).await?;
            if !can_edit(Some(role)) || caller.read_only {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            if board.legacy {
                // An old WeldFlow whiteboard nobody opened since WeldBoard: deleted as WeldFlow did.
                if !records::trash_legacy(&caller.db, &board.id, &now()).await? {
                    return Err(Refusal::not_found("Board", &board.id));
                }
                caller.publish(
                    &state,
                    PROJECT_WHITEBOARD_DELETED,
                    &board.id,
                    &json!({ "id": board.id }),
                );
                return Ok(NoContent.into_response());
            }
            let Some(live) = records::get_live_board(&caller.db, &board.id).await? else {
                return Err(Refusal::not_found("Board", &board.id));
            };
            if soft_delete_file(&caller.db, live.file_id(), &now())
                .await?
                .is_none()
            {
                return Err(Refusal::not_found("Board", &board.id));
            }
            caller.publish(
                &state,
                FILE_DELETED,
                live.file_id(),
                &live.file_event_data(None),
            );
            caller.publish(&state, BOARD_DELETED, &live.id, &live.event_data());
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── POST /:id/session ───────────────────────────────────────────────────────

pub(crate) async fn session(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let user_id = caller.user()?.to_owned();
            let org = caller.org()?.to_owned();
            let (board, role) = find_live_board(&caller, &id).await?;
            let mode = caller.session_mode(role);
            let (name, picture) = member_profile(&caller.db, &user_id).await?;
            let color = color_for(&user_id);
            let mut admission = board.room_meta(&org);
            if let Value::Object(fields) = &mut admission {
                fields.insert("userId".into(), json!(user_id));
                fields.insert("name".into(), json!(name.as_deref().unwrap_or("Unknown")));
                fields.insert("picture".into(), json!(picture));
                fields.insert("color".into(), json!(color));
                fields.insert("canEdit".into(), json!(mode == "edit"));
                fields.insert("canComment".into(), json!(mode == "comment"));
            }
            let ticket = caller
                .room(
                    &state,
                    &room_name(&org, &board.id),
                    "admit",
                    json!([admission]),
                )
                .await?;
            Ok(Data(json!({
                "ticket": ticket,
                "canEdit": mode == "edit",
                "mode": mode,
                "color": color,
            }))
            .into_response())
        }
        .await,
    )
}

// ── GET /:id/snapshot ───────────────────────────────────────────────────────

pub(crate) async fn snapshot(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let (board, _) = find_live_board(&caller, &id).await?;
            let live = live_snapshot(&state, &caller, &org, &board).await?;
            // The room hands over JSON text; spliced in rather than parsed and re-encoded.
            let body = format!(
                r#"{{"data":{{"revision":{},"snapshot":{}}}}}"#,
                live["revision"],
                live["json"].as_str().unwrap_or("null")
            );
            let mut response = (StatusCode::OK, body).into_response();
            let headers = response.headers_mut();
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            Ok(response)
        }
        .await,
    )
}

// ── GET /:id/render ─────────────────────────────────────────────────────────

/// The live board as one SVG, for viewers that do not run the editor (the
/// WeldFlow mobile app).
pub(crate) async fn render(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let width = validate_query(raw.as_deref(), |issues, query| {
                issues
                    .whole_number(
                        query,
                        "width",
                        Presence::Optional,
                        Number {
                            coerce: true,
                            int: true,
                            min: Some(256.0),
                            max: Some(4096.0),
                        },
                    )
                    .into_option()
            })?;
            let org = caller.org()?.to_owned();
            let (board, _) = find_live_board(&caller, &id).await?;
            let live = live_snapshot(&state, &caller, &org, &board).await?;
            let drawn = caller
                .engine(
                    &state,
                    "render",
                    json!([live_json(&live), width.unwrap_or(2048)]),
                )
                .await?;
            Ok(Data(json!({
                "revision": live["revision"],
                "svg": drawn["svg"],
                "elements": drawn["elements"],
                "drawn": drawn["drawn"],
            }))
            .into_response())
        }
        .await,
    )
}

// ── GET /:id/thumbnail ──────────────────────────────────────────────────────

pub(crate) async fn thumbnail(
    State(state): State<BoardState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let (board, _) = find_live_board(&caller, &id).await?;
            let key = thumbnail_key_for(&board.snapshot_key_in(&org));
            let files = caller.files(&state)?;
            let object = files.private.get_boxed(&key).await.map_err(|error| {
                tracing::error!(%error, "[board-api] reading a thumbnail failed");
                Refusal::from(ApiError::internal())
            })?;
            let Some(object) = object else {
                return Err(Refusal::not_found("Thumbnail", &board.id));
            };
            let svg = String::from_utf8_lossy(&object.bytes).into_owned();
            let mut response =
                Data(json!({ "svg": svg, "revision": board.revision })).into_response();
            response.headers_mut().insert(
                CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=60"),
            );
            Ok(response)
        }
        .await,
    )
}
