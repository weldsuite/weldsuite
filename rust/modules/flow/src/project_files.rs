//! `/api/project-files` (`routes/project-files/index.ts`,
//! `services/project-files.ts`): a project's files and folders (`parentId`
//! nesting). A storage key from the client is only taken when the upload
//! flow issued it for this project and no other file uses it; a replaced
//! object is deleted. Deletes are soft; the purge sweep removes them after
//! 30 days (`file_purge` due index).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_FILE_CREATED, PROJECT_FILE_DELETED, PROJECT_FILE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::projects::{bindable, writable};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, now, outside, page, paged,
    reply, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const STORAGE_KEY_REJECTED: &str =
    "storagePath / fileKey must be an unused upload key of this project";

/// `WRITABLE_FILE_COLUMNS`.
const WRITABLE: [&str; 13] = [
    "fileName",
    "originalName",
    "mimeType",
    "fileSize",
    "storagePath",
    "fileKey",
    "url",
    "thumbnailUrl",
    "storageProvider",
    "fileType",
    "isPublic",
    "metadata",
    "parentId",
];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("files:read")))
        .route("/", post(create).route_layer(need("files:create")))
        .route("/folders", post(create_folder).route_layer(need("files:create")))
        .route("/{id}", get(detail).route_layer(need("files:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("files:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("files:delete")),
        )
        .with_state(state)
}

async fn file_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from project_files f
         where f.id = $1 and (not $2 or f.deleted_at is null) limit 1",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Why a parent folder is refused (`assertValidParent`).
enum ParentCheck {
    Ok,
    NotFound,
    CrossProject,
}

async fn check_parent(db: &PgPool, parent_id: &str, project_id: Option<&str>) -> Result<ParentCheck, sqlx::Error> {
    let parent: Option<(bool, Option<String>)> = sqlx::query_as(
        "select is_folder, project_id from project_files where id = $1 and deleted_at is null limit 1",
    )
    .bind(parent_id)
    .fetch_optional(db)
    .await?;
    let Some((true, parent_project)) = parent else {
        return Ok(ParentCheck::NotFound);
    };
    if let Some(project_id) = project_id.filter(|p| !p.is_empty())
        && parent_project.as_deref() != Some(project_id)
    {
        return Ok(ParentCheck::CrossProject);
    }
    Ok(ParentCheck::Ok)
}

/// Why `createProjectFolder` refused.
enum FolderError {
    Required,
    ParentNotFound,
    CrossProject,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for FolderError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `createProjectFolder`.
async fn create_project_folder(
    db: &PgPool,
    project_id: &str,
    name: &str,
    parent_id: Option<&str>,
    uploaded_by: Option<&str>,
) -> Result<Value, FolderError> {
    let id = generate_id("pfile");
    let name = weldsuite_kit::validation::js_trim(name);
    if name.is_empty() {
        return Err(FolderError::Required);
    }
    let parent_id = parent_id.filter(|p| !p.is_empty());
    if let Some(parent_id) = parent_id {
        let parent: Option<(bool, Option<String>)> = sqlx::query_as(
            "select is_folder, project_id from project_files where id = $1 and deleted_at is null limit 1",
        )
        .bind(parent_id)
        .fetch_optional(db)
        .await?;
        match parent {
            Some((true, parent_project)) if parent_project.as_deref() == Some(project_id) => {}
            Some((true, _)) => return Err(FolderError::CrossProject),
            _ => return Err(FolderError::ParentNotFound),
        }
    }
    sqlx::query(
        "insert into project_files
             (id, project_id, parent_id, file_name, original_name, mime_type, file_size,
              storage_path, storage_provider, file_type, is_folder, uploaded_by_id,
              created_at, updated_at)
         values ($1, $2, $3, $4, $4, 'inode/directory', 0, '', 'r2', 'folder', true, $5,
                 $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(project_id)
    .bind(parent_id)
    .bind(name)
    .bind(uploaded_by.filter(|u| !u.is_empty()))
    .bind(now())
    .execute(db)
    .await?;
    Ok(file_row(db, &id, false).await?.unwrap_or(Value::Null))
}

/// `isProjectUploadKey`: `workspaces/<org>/<folder>/project/<project>/<object>`,
/// the object either a name or `<timestamp>_<32 hex>/<name>`.
fn is_project_upload_key(key: &Value, workspace_id: Option<&str>, project_id: Option<&str>) -> bool {
    let (Some(key), Some(workspace_id), Some(project_id)) = (
        key.as_str(),
        workspace_id.filter(|w| !w.is_empty()),
        project_id.filter(|p| !p.is_empty()),
    ) else {
        return false;
    };
    let parts: Vec<&str> = key.split('/').collect();
    if parts.len() != 6 && parts.len() != 7 {
        return false;
    }
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return false;
    }
    if parts.len() == 7 && !is_unguessable_segment(parts[5]) {
        return false;
    }
    parts[0] == "workspaces" && parts[1] == workspace_id && parts[3] == "project" && parts[4] == project_id
}

/// `/^\d+_[0-9a-f]{32}$/`.
fn is_unguessable_segment(segment: &str) -> bool {
    let Some((digits, hex)) = segment.split_once('_') else {
        return false;
    };
    !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && hex.len() == 32
        && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Is `key` the object of a project file other than `except`?
async fn key_in_use(db: &PgPool, key: &str, except: Option<&str>) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from project_files
         where (storage_path = $1 or file_key = $1) and ($2::text is null or id <> $2) limit 1",
    )
    .bind(key)
    .bind(except)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `areStorageKeysAcceptable`: every key sent is one of the project's own
/// upload keys and no other file points at it (the row's current keys may
/// come back unchanged).
async fn keys_acceptable(
    db: &PgPool,
    data: &Map<String, Value>,
    workspace_id: Option<&str>,
    project_id: Option<&str>,
    existing: Option<(&str, &Value, &Value)>,
) -> Result<bool, sqlx::Error> {
    let mut sent: Vec<&Value> = Vec::new();
    for key in ["storagePath", "fileKey"] {
        if let Some(value) = data.get(key)
            && !sent.contains(&value)
        {
            sent.push(value);
        }
    }
    for key in sent {
        if let (Some(text), Some((_, path, file_key))) = (key.as_str(), existing)
            && (path.as_str() == Some(text) || file_key.as_str() == Some(text))
        {
            continue;
        }
        if !is_project_upload_key(key, workspace_id, project_id) {
            return Ok(false);
        }
        let text = key.as_str().unwrap_or_default();
        if key_in_use(db, text, existing.map(|(id, _, _)| id)).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn non_empty_key(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|v| !v.is_empty())
}

/// `replacedStorageKey`: the previous key to delete once the update lands.
fn replaced_key(existing: &Value, update: &Map<String, Value>) -> Option<String> {
    let pick = |key: &str| match update.get(key) {
        Some(value) => non_empty_key(Some(value)),
        None => non_empty_key(existing.get(key)),
    };
    let next = pick("fileKey").or_else(|| pick("storagePath"))?;
    let old = non_empty_key(existing.get("fileKey")).or_else(|| non_empty_key(existing.get("storagePath")))?;
    (old != next).then(|| old.to_owned())
}

/// `markFilePurgeDue`: the purge sweep looks at this workspace once the
/// retention window has passed. Best effort.
pub(crate) async fn mark_purge_due(state: &FlowState, caller: &Caller, deleted_at: time::OffsetDateTime) {
    if let Some(master) = caller.master(state) {
        weldsuite_db::due_index::mark_due(
            &master,
            crate::purge::FILE_PURGE_KIND,
            &caller.workspace_id,
            deleted_at + time::Duration::days(crate::purge::RETENTION_DAYS),
        )
        .await;
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_files(&caller, &q).await)
}

/// The list's `where`, each condition behind a flag (see [`list_files`]).
macro_rules! file_filters {
    () => {
        concat!(
            "($1::bool is not true or f.deleted_at is null)",
            " and ($2::text is null or f.project_id = $2)",
            " and ($3::text is null or f.uploaded_by_id = $3)",
            " and ($4::text is null or f.file_type = $4)",
            " and ($5::bool is not true or f.parent_id is null)",
            " and ($6::text is null or f.parent_id = $6)",
            " and ($7::bool is not true or f.is_folder = true)",
            " and ($8::bool is not true or ",
            in_accessible!("f.project_id", "$9", "$10"),
            ")"
        )
    };
}

#[allow(clippy::too_many_lines)]
async fn list_files(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    let limit = q
        .present("limit")
        .map_or(25, |raw| weldsuite_flow_domain::js::parse_int(raw).unwrap_or(25))
        .clamp(1, 500);
    let project_id = q.present("projectId").map(str::to_owned);
    let uploaded_by = q.present("uploadedById").map(str::to_owned);
    let file_type = q.present("fileType").map(str::to_owned);
    let (parent_null, parent_eq) = match q.get("parentId") {
        Some(parent) if q.get("all") != Some("true") => {
            if parent.is_empty() || parent == "root" {
                (true, None)
            } else {
                (false, Some(parent.to_owned()))
            }
        }
        _ => (false, None),
    };
    let folders_only = q.get("foldersOnly") == Some("true");
    let (scoped, all, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (false, true, Vec::new())
    } else {
        let (all, ids) = access_scope(caller).await?;
        (true, all, ids)
    };
    let mut cursor: Option<(bool, String, String)> = None;
    if let Some(at) = q.present("cursor") {
        let row: Option<(bool, String, Option<String>)> = sqlx::query_as(
            "select is_folder, id, to_jsonb(created_at) #>> '{}' from project_files where id = $1 limit 1",
        )
        .bind(at)
        .fetch_optional(db)
        .await?;
        if let Some((folder, id, created)) = row {
            let created = created
                .as_deref()
                .and_then(weldsuite_db::js_timestamp)
                .unwrap_or_default();
            cursor = Some((folder, created, id));
        }
    }
    // The conditions in TypeScript's order; with a cursor the count leaves
    // out the last one (`conditions.slice(0, -1)`): the cursor's own, or,
    // when its row is unknown, the last filter.
    let mut flags = [
        true,
        project_id.is_some(),
        uploaded_by.is_some(),
        file_type.is_some(),
        parent_null,
        parent_eq.is_some(),
        folders_only,
        scoped,
    ];
    let row_flags = flags;
    if q.present("cursor").is_some()
        && cursor.is_none()
        && let Some(last) = flags.iter().rposition(|on| *on)
    {
        flags[last] = false;
    }
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(f) from project_files f where ",
            file_filters!(),
            " and ($11::bool is null or f.is_folder < $11 or (f.is_folder = $11 and",
            " (f.created_at < $12::timestamp or (f.created_at = $12::timestamp and f.id < $13))))",
            " order by f.is_folder desc, f.created_at desc, f.id desc limit $14"
        ))
        .bind(row_flags[0])
        .bind(project_id.as_deref())
        .bind(uploaded_by.as_deref())
        .bind(file_type.as_deref())
        .bind(row_flags[4])
        .bind(parent_eq.as_deref())
        .bind(row_flags[6])
        .bind(row_flags[7])
        .bind(all)
        .bind(&ids)
        .bind(cursor.as_ref().map(|c| c.0))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(cursor.as_ref().map(|c| c.2.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
        let total: i64 = sqlx::query_scalar(concat!(
            "select count(*) from project_files f where ",
            file_filters!()
        ))
        .bind(flags[0])
        .bind(project_id.as_deref().filter(|_| flags[1]))
        .bind(uploaded_by.as_deref().filter(|_| flags[2]))
        .bind(file_type.as_deref().filter(|_| flags[3]))
        .bind(flags[4])
        .bind(parent_eq.as_deref().filter(|_| flags[5]))
        .bind(flags[6])
        .bind(flags[7])
        .bind(all)
        .bind(&ids)
        .fetch_one(db)
        .await?;
        let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list project files"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = file_row(&caller.db, &id, true).await? else {
                return Err(Refusal::not_found("Project file", &id));
            };
            if let Some(project) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch project file",
    )
}

// ── POST /folders ───────────────────────────────────────────────────────────

async fn create_folder(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Required, None, None);
        let name = issues.text_with(fields, "name", Presence::Required, Text::trimmed(Some(1), Some(500)));
        let parent = issues.text(fields, "parentId", Presence::Nullish, Some(1), None);
        (
            project_id.into_option().unwrap_or_default(),
            name.into_option().unwrap_or_default(),
            parent.into_option(),
        )
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let (project_id, name, parent_id) = input;
    match caller.can_write(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    let created = create_project_folder(
        &caller.db,
        &project_id,
        &name,
        parent_id.as_deref(),
        caller.user(),
    )
    .await;
    match created {
        Ok(row) => {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(
                &state,
                PROJECT_FILE_CREATED,
                &id,
                &json!({ "id": id, "projectId": project_id, "fileName": row["fileName"], "fileType": "folder" }),
            );
            Created(row).into_response()
        }
        Err(FolderError::ParentNotFound) => {
            ApiError::not_found("Parent folder", Some(parent_id.as_deref().unwrap_or_default()))
                .into_response()
        }
        Err(FolderError::CrossProject) => {
            ApiError::bad_request("Parent folder belongs to a different project").into_response()
        }
        Err(FolderError::Required) => {
            Refusal::Internal("Folder name is required".to_owned()).respond("Failed to create folder")
        }
        Err(FolderError::Database(error)) => Refusal::from(error).respond("Failed to create folder"),
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `createProjectFileSchema` (`.partial()` for a PATCH), passthrough.
fn read_file(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "projectId", required, None, None);
    issues.text(fields, "fileName", required, None, Some(500));
    issues.text(fields, "contentType", Presence::Optional, None, Some(255));
    issues.integer(fields, "size", Presence::Optional, None);
    issues.text(fields, "url", Presence::Optional, None, Some(2000));
    issues.text(fields, "storageKey", Presence::Optional, None, Some(500));
    issues.text(fields, "uploadedBy", Presence::Optional, None, None);
    issues.text(fields, "parentId", Presence::Nullish, Some(1), None);
    issues.boolean(fields, "isFolder", Presence::Optional);
    issues.text(fields, "fileType", Presence::Optional, None, Some(50));
    fields.clone()
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_file(issues, fields, false)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(project) = project_id.as_deref().filter(|p| !p.is_empty()) {
        match caller.can_write(project).await {
            Ok(true) => {}
            Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
            Err(error) => return outside(Err(error.into())),
        }
    }
    reply(
        create_file(&state, &caller, project_id, data).await,
        "Failed to create project file",
    )
}

async fn create_file(
    state: &FlowState,
    caller: &Caller,
    project_id: Option<String>,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let project = project_id.clone().unwrap_or_default();
    let uploaded_by = caller.user().map(str::to_owned).or_else(|| {
        data.get("uploadedById")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let parent_id = data
        .get("parentId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if weldsuite_flow_domain::js::truthy(data.get("isFolder"))
        || data.get("fileType").and_then(Value::as_str) == Some("folder")
    {
        let name = match (data.get("fileName"), data.get("name")) {
            (Some(Value::String(name)), _) => name.clone(),
            (Some(Value::Null) | None, Some(Value::String(name))) => name.clone(),
            _ => "Untitled folder".to_owned(),
        };
        let row = create_project_folder(db, &project, &name, parent_id.as_deref(), uploaded_by.as_deref())
            .await
            .map_err(|error| match error {
                FolderError::Database(error) => Refusal::Database(error),
                FolderError::Required => Refusal::Internal("Folder name is required".to_owned()),
                FolderError::ParentNotFound => Refusal::Internal("Parent folder not found".to_owned()),
                FolderError::CrossProject => {
                    Refusal::Internal("Parent folder belongs to a different project".to_owned())
                }
            })?;
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        caller.publish(
            state,
            PROJECT_FILE_CREATED,
            &id,
            &json!({ "id": id, "projectId": project_id, "fileName": row["fileName"], "fileType": "folder" }),
        );
        return Ok(Created(row).into_response());
    }
    if let Some(parent) = parent_id.as_deref().filter(|p| !p.is_empty()) {
        match check_parent(db, parent, project_id.as_deref()).await? {
            ParentCheck::Ok => {}
            ParentCheck::NotFound => return Err(Refusal::not_found("Parent folder", parent)),
            ParentCheck::CrossProject => {
                return Err(Refusal::bad_request(
                    "Cannot create a file under a folder from a different project",
                ));
            }
        }
    }
    let Ok(mut columns) = writable(&data, &WRITABLE, &[]) else {
        return Err(Refusal::Internal("unreachable".to_owned()));
    };
    if !keys_acceptable(db, &columns, caller.clerk_org_id.as_deref(), project_id.as_deref(), None).await? {
        return Err(Refusal::bad_request(STORAGE_KEY_REJECTED));
    }
    columns.insert("parentId".to_owned(), parent_id.map_or(Value::Null, Value::String));
    let id = generate_id("pfile");
    sqlx::query(concat!(
        "insert into project_files (id, project_id, uploaded_by_id, created_at, updated_at,",
        " parent_id, file_name, original_name, mime_type, file_size, storage_path, file_key, url,",
        " thumbnail_url, storage_provider, file_type, is_public, metadata)",
        " values ($2, $3, $4, $5::timestamp, $5::timestamp, ",
        val_text!("parentId", "null"),
        ", ",
        val_text!("fileName", "null"),
        ", ",
        val_text!("originalName", "null"),
        ", ",
        val_text!("mimeType", "null"),
        ", ",
        val_int!("fileSize", "null"),
        ", ",
        val_text!("storagePath", "null"),
        ", ",
        val_text!("fileKey", "null"),
        ", ",
        val_text!("url", "null"),
        ", ",
        val_text!("thumbnailUrl", "null"),
        ", ",
        val_text!("storageProvider", "'r2'"),
        ", ",
        val_text!("fileType", "'file'"),
        ", ",
        val_bool!("isPublic", "false"),
        ", ",
        val_json!("metadata", "null"),
        ")"
    ))
    .bind(bindable(&columns))
    .bind(&id)
    .bind(project_id.as_deref())
    .bind(uploaded_by.as_deref())
    .bind(now())
    .execute(db)
    .await?;
    let file_type = match data.get("fileType") {
        None | Some(Value::Null) => json!("file"),
        Some(file_type) => file_type.clone(),
    };
    caller.publish(
        state,
        PROJECT_FILE_CREATED,
        &id,
        &json!({ "id": id, "projectId": project_id, "fileName": data.get("fileName"), "fileType": file_type }),
    );
    Ok(Created(json!({ "id": id })).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_file(issues, fields, true)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        update_file(&state, &caller, &id, data).await,
        "Failed to update project file",
    )
}

/// `wouldCreateCycle`: may `folder_id` move under `new_parent`?
async fn would_create_cycle(db: &PgPool, folder_id: &str, new_parent: Option<&str>) -> Result<bool, sqlx::Error> {
    let Some(new_parent) = new_parent.filter(|p| !p.is_empty()) else {
        return Ok(false);
    };
    if new_parent == folder_id {
        return Ok(true);
    }
    let mut current = Some(new_parent.to_owned());
    let mut seen: Vec<String> = Vec::new();
    while let Some(at) = current.filter(|c| !c.is_empty()) {
        if at == folder_id || seen.contains(&at) {
            return Ok(true);
        }
        let parent: Option<Option<String>> = sqlx::query_scalar(
            "select parent_id from project_files where id = $1 and deleted_at is null limit 1",
        )
        .bind(&at)
        .fetch_optional(db)
        .await?;
        seen.push(at);
        current = parent.flatten();
    }
    Ok(false)
}

#[allow(clippy::too_many_lines)]
async fn update_file(state: &FlowState, caller: &Caller, id: &str, data: Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(existing) = file_row(db, id, true).await? else {
        return Err(Refusal::not_found("Project file", id));
    };
    let existing_project = existing["projectId"].as_str().map(str::to_owned);
    if let Some(project) = existing_project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    // `checkMoveTarget`.
    if let Some(parent) = data.get("parentId") {
        if existing["isFolder"] == json!(true)
            && would_create_cycle(db, id, parent.as_str()).await?
        {
            return Err(Refusal::bad_request(
                "Cannot move a folder into itself or one of its subfolders",
            ));
        }
        if let Some(parent) = parent.as_str().filter(|p| !p.is_empty()) {
            match check_parent(db, parent, existing_project.as_deref()).await? {
                ParentCheck::Ok => {}
                ParentCheck::NotFound => return Err(Refusal::not_found("Parent folder", parent)),
                ParentCheck::CrossProject => {
                    return Err(Refusal::bad_request("Cannot move across projects"));
                }
            }
        }
    }
    let Ok(update) = writable(&data, &WRITABLE, &[]) else {
        return Err(Refusal::Internal("unreachable".to_owned()));
    };
    let workspace = caller.clerk_org_id.as_deref();
    let current = (id, &existing["storagePath"], &existing["fileKey"]);
    if !keys_acceptable(db, &update, workspace, existing_project.as_deref(), Some(current)).await? {
        return Err(Refusal::bad_request(STORAGE_KEY_REJECTED));
    }
    let old_key = replaced_key(&existing, &update);
    sqlx::query(concat!(
        "update project_files set ",
        set_text!("fileName", "file_name"),
        ", ",
        set_text!("originalName", "original_name"),
        ", ",
        set_text!("mimeType", "mime_type"),
        ", ",
        set_int!("fileSize", "file_size"),
        ", ",
        set_text!("storagePath", "storage_path"),
        ", ",
        set_text!("fileKey", "file_key"),
        ", ",
        set_text!("url", "url"),
        ", ",
        set_text!("thumbnailUrl", "thumbnail_url"),
        ", ",
        set_text!("storageProvider", "storage_provider"),
        ", ",
        set_text!("fileType", "file_type"),
        ", ",
        set_bool!("isPublic", "is_public"),
        ", ",
        set_json!("metadata", "metadata"),
        ", ",
        set_text!("parentId", "parent_id"),
        ", updated_at = $3::timestamp where id = $2 and deleted_at is null"
    ))
    .bind(bindable(&update))
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    if let Some(old_key) = old_key {
        delete_replaced_object(state, caller, &old_key, workspace, existing_project.as_deref(), id).await;
    }
    let pick = |key: &str| match update.get(key) {
        None | Some(Value::Null) => existing[key].clone(),
        Some(value) => value.clone(),
    };
    caller.publish(
        state,
        PROJECT_FILE_UPDATED,
        id,
        &json!({
            "id": id,
            "projectId": existing["projectId"],
            "fileName": pick("fileName"),
            "fileType": pick("fileType"),
        }),
    );
    Ok(Data(json!({ "id": id })).into_response())
}

/// `deleteReplacedObject`: best effort, never fails the request.
async fn delete_replaced_object(
    state: &FlowState,
    caller: &Caller,
    key: &str,
    workspace: Option<&str>,
    project: Option<&str>,
    file_id: &str,
) {
    let buckets = caller.buckets(state);
    if buckets.private.is_none() && buckets.public.is_none() {
        return;
    }
    if !is_project_upload_key(&json!(key), workspace, project) {
        return;
    }
    match key_in_use(&caller.db, key, Some(file_id)).await {
        Ok(false) => {}
        Ok(true) => return,
        Err(error) => {
            tracing::error!(%error, key, "[flow-api/project-files] failed to delete replaced object");
            return;
        }
    }
    for store in [buckets.private, buckets.public].into_iter().flatten() {
        if let Err(error) = store.delete_boxed(key).await {
            tracing::error!(%error, key, "[flow-api/project-files] failed to delete replaced object");
        }
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(remove_file(&state, &caller, &id).await, "Failed to delete project file")
}

async fn remove_file(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let existing: Option<(Option<String>, bool)> = sqlx::query_as(
        "select project_id, is_folder from project_files where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((project, is_folder)) = existing else {
        return Err(Refusal::not_found("Project file", id));
    };
    if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    let now_at = time::OffsetDateTime::now_utc();
    let now = weldsuite_events::iso_timestamp(now_at);
    let deleted: Vec<String> = if is_folder {
        // `softDeleteProjectFolderCascade`: the folder and everything under it.
        let mut ids = vec![id.to_owned()];
        let mut frontier = vec![id.to_owned()];
        while !frontier.is_empty() {
            let children: Vec<String> = sqlx::query_scalar(
                "select id from project_files where parent_id = any($1) and deleted_at is null",
            )
            .bind(&frontier)
            .fetch_all(db)
            .await?;
            frontier = Vec::new();
            for child in children {
                if !ids.contains(&child) {
                    ids.push(child.clone());
                    frontier.push(child);
                }
            }
        }
        sqlx::query(
            "update project_files set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = any($1)",
        )
        .bind(&ids)
        .bind(&now)
        .execute(db)
        .await?;
        ids
    } else {
        sqlx::query(
            "update project_files set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(id)
        .bind(&now)
        .execute(db)
        .await?;
        vec![id.to_owned()]
    };
    mark_purge_due(state, caller, now_at).await;
    for deleted_id in deleted {
        caller.publish(state, PROJECT_FILE_DELETED, &deleted_id, &json!({ "id": deleted_id }));
    }
    Ok(NoContent.into_response())
}
