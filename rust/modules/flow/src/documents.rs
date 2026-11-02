//! Documents from before `WeldDocs`: `/api/documents` (`routes/documents/`),
//! `/api/project-documents` and `/api/project-sheets`. A document's
//! `BlockNote` JSON lives in `docs`, paired 1:1 with a drive `files` row;
//! versions in `document_versions`. A `WeldDocs` row (`content` null or a
//! checkpoint key) reads as `content: []` and refuses writes with a 409.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{DOC_CREATED, DOC_UPDATED, FILE_CREATED};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, can_edit, container_role, file_role,
    load_drive_access_for_user,
};
use weldsuite_core_domain::files::{NewFile, create_file};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::PutOptions;

use crate::{Caller, FlowState, Refusal, Reply, forbidden, now, outside, reply, validate};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const DRIVE_VIEW_ONLY: &str = "You can view this item but not change it";
const WELDDOCS_ROW_MESSAGE: &str =
    "This document is edited in WeldDocs and cannot be changed through this endpoint";
const DOCUMENT_MIME: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DEFAULT_PUBLIC_URL: &str = "https://weldsuite-storage-test.weldsuite.org";
/// Ten minutes between automatic version snapshots.
const AUTO_SNAPSHOT_MINUTES: i64 = 10;

/// `buildEmptyDocx()`: the same 917-byte archive fflate writes (its entries'
/// times fixed), so the file row's size is TypeScript's.
const EMPTY_DOCX: &[u8] = include_bytes!("empty.docx");

pub(crate) fn documents_router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/",
            post(create_drive_document).route_layer(need("files:create")),
        )
        .route("/{file_id}", get(document).route_layer(need("files:read")))
        .route(
            "/{file_id}/content",
            put(save_content).route_layer(need("files:update")),
        )
        .route(
            "/{file_id}/versions",
            get(list_versions).route_layer(need("files:read")),
        )
        .route(
            "/{file_id}/versions",
            post(create_version).route_layer(need("files:update")),
        )
        .route(
            "/{file_id}/versions/{version_id}",
            get(version).route_layer(need("files:read")),
        )
        .route(
            "/{file_id}/versions/{version_id}/restore",
            post(restore_version).route_layer(need("files:update")),
        )
        .with_state(state)
}

pub(crate) fn project_documents_router<S, Q>(
    state: FlowState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{project_id}",
            get(list_project_documents).route_layer(need("projects:read")),
        )
        .route(
            "/{project_id}",
            post(create_project_document).route_layer(need("projects:update")),
        )
        .with_state(state)
}

pub(crate) fn project_sheets_router<S, Q>(
    state: FlowState,
    gate: &Arc<PermissionGate<Q>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{project_id}",
            get(list_project_sheets).route_layer(need("projects:read")),
        )
        .with_state(state)
}

/// `isWeldDocsRow`: `content` null or a checkpoint key.
fn is_welddocs_row(row: &Value) -> bool {
    row["content"].is_null() || !row["snapshotKey"].is_null()
}

async fn doc_by_file(db: &PgPool, file_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(d) from docs d where d.file_id = $1 limit 1")
            .bind(file_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

async fn doc_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(d) from docs d where d.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// `createDocForFile`.
async fn create_doc(
    db: &PgPool,
    file_id: &str,
    user_id: &str,
    content: &Value,
) -> Result<Value, sqlx::Error> {
    let id = generate_id("doc");
    sqlx::query(
        "insert into docs (id, file_id, content, updated_by_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5::timestamp, $5::timestamp)",
    )
    .bind(&id)
    .bind(file_id)
    .bind(content)
    .bind(user_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(doc_by_id(db, &id).await?.unwrap_or(Value::Null))
}

/// `upsertDocContent`: insert on the first save, else update.
async fn upsert_doc(
    db: &PgPool,
    file_id: &str,
    content: &Value,
    user_id: &str,
) -> Result<Value, Refusal> {
    let Some(existing) = doc_by_file(db, file_id).await? else {
        return Ok(create_doc(db, file_id, user_id, content).await?);
    };
    if is_welddocs_row(&existing) {
        return Err(Refusal::Internal(WELDDOCS_ROW_MESSAGE.to_owned()));
    }
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    sqlx::query(
        "update docs set content = $2, updated_by_id = $3, updated_at = $4::timestamp where id = $1",
    )
    .bind(&id)
    .bind(content)
    .bind(user_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(doc_by_id(db, &id).await?.unwrap_or(Value::Null))
}

/// `createVersion`.
async fn insert_version(
    db: &PgPool,
    file_id: &str,
    content: &Value,
    user_id: &str,
    label: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let id = generate_id("docver");
    sqlx::query(
        "insert into document_versions (id, file_id, content, label, created_by_id, created_at)
         values ($1, $2, $3, $4, $5, $6::timestamp)",
    )
    .bind(&id)
    .bind(file_id)
    .bind(content)
    .bind(label)
    .bind(user_id)
    .bind(now())
    .execute(db)
    .await?;
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(v) from document_versions v where v.id = $1 limit 1")
            .bind(&id)
            .fetch_optional(db)
            .await?;
    Ok(row.map_or(Value::Null, js_row))
}

/// `maybeAutoSnapshot`: a version unless one is less than ten minutes old.
async fn maybe_auto_snapshot(
    db: &PgPool,
    file_id: &str,
    content: &Value,
    user_id: &str,
) -> Result<(), sqlx::Error> {
    let cutoff = weldsuite_events::iso_timestamp(
        OffsetDateTime::now_utc() - time::Duration::minutes(AUTO_SNAPSHOT_MINUTES),
    );
    let recent: Option<String> = sqlx::query_scalar(
        "select id from document_versions where file_id = $1 and created_at > $2::timestamp limit 1",
    )
    .bind(file_id)
    .bind(&cutoff)
    .fetch_optional(db)
    .await?;
    if recent.is_none() {
        insert_version(db, file_id, content, user_id, None).await?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Read,
    Write,
}

/// `guardDocument`: project documents by project access, drive documents by
/// the WeldDrive rules (hidden is a 404). `None` lets the caller through.
async fn guard(
    caller: &Caller,
    file_id: &str,
    mode: Mode,
) -> Result<Option<Response>, sqlx::Error> {
    type FileRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let file: Option<FileRow> = sqlx::query_as(
        "select id, entity_type, entity_id, uploaded_by_id, folder_id, general_access
         from files where id = $1 limit 1",
    )
    .bind(file_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((id, entity_type, entity_id, uploaded_by, folder_id, general_access)) = file else {
        return Ok(None);
    };
    if entity_type.as_deref().is_none_or(str::is_empty) {
        let index = load_drive_access_for_user(&caller.db, caller.user()).await?;
        let role = file_role(
            &index,
            &DriveFileRef {
                id,
                uploaded_by_id: uploaded_by,
                folder_id,
                general_access: DriveGeneralAccess::parse(&general_access),
                entity_type,
            },
        );
        if role.is_none() {
            return Ok(Some(
                ApiError::not_found("Document", Some(file_id)).into_response(),
            ));
        }
        return Ok((mode == Mode::Write && !can_edit(role)).then(|| forbidden(DRIVE_VIEW_ONLY)));
    }
    let Some(project) = entity_id.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    if entity_type.as_deref() != Some("project") {
        return Ok(None);
    }
    Ok(match mode {
        Mode::Write => {
            (!caller.can_write(&project).await?).then(|| forbidden(PROJECT_WRITE_DENIED))
        }
        Mode::Read => (!caller.can_access(&project).await?).then(|| forbidden(PROJECT_DENIED)),
    })
}

/// The guard as a step: `Err` with the refusal.
async fn guarded(caller: &Caller, file_id: &str, mode: Mode) -> Result<(), Box<Response>> {
    match guard(caller, file_id, mode).await {
        Ok(None) => Ok(()),
        Ok(Some(denied)) => Err(Box::new(denied)),
        Err(error) => Err(Box::new(outside(Err(error.into())))),
    }
}

// ── GET /api/documents/:fileId ──────────────────────────────────────────────

async fn document(caller: Caller, Path(file_id): Path<String>) -> Response {
    if let Err(denied) = guarded(&caller, &file_id, Mode::Read).await {
        return *denied;
    }
    reply(
        async {
            let row = doc_by_file(&caller.db, &file_id).await?;
            let row = match row {
                Some(mut row) if is_welddocs_row(&row) => {
                    row["content"] = json!([]);
                    row
                }
                Some(row) => row,
                None => Value::Null,
            };
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to load document",
    )
}

// ── POST /api/documents, POST /api/project-documents/:projectId ─────────────

/// The new document's name and object key (`<name>.docx`, sanitised).
fn document_key(name: &str, clerk_org_id: &str, folder: &str) -> (String, String) {
    // Case-sensitive, as `name.endsWith('.docx')`.
    #[allow(clippy::case_sensitive_file_extension_comparisons)]
    let file_name = if name.ends_with(".docx") {
        name.to_owned()
    } else {
        format!("{name}.docx")
    };
    let sanitized: String = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let millis = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let key = format!("workspaces/{clerk_org_id}/documents/{folder}/{millis}_{sanitized}");
    (file_name, key)
}

/// Seeds the bucket with the empty .docx, files it and creates its `docs`
/// row, publishing both events. The file row.
#[allow(clippy::too_many_arguments)]
async fn file_document(
    state: &FlowState,
    caller: &Caller,
    user: &str,
    file_name: String,
    key: String,
    folder_id: Option<String>,
    entity: Option<(&str, &str)>,
) -> Reply {
    let db = &caller.db;
    if let Some(storage) = caller.buckets(state).public {
        storage
            .put_boxed(
                &key,
                EMPTY_DOCX.to_vec(),
                &PutOptions::content_type(DOCUMENT_MIME),
            )
            .await
            .map_err(|error| Refusal::Internal(error.to_string()))?;
    }
    let base = caller
        .env("R2_PUBLIC_URL")
        .filter(|url| !url.is_empty())
        .or_else(|| state.public_files_url.as_deref().map(str::to_owned))
        .unwrap_or_else(|| DEFAULT_PUBLIC_URL.to_owned());
    let row = create_file(
        db,
        &NewFile {
            file_name: file_name.clone(),
            original_name: Some(file_name),
            mime_type: DOCUMENT_MIME.to_owned(),
            file_size: i64::try_from(EMPTY_DOCX.len()).unwrap_or(0),
            file_type: Some("document".to_owned()),
            storage_path: key.clone(),
            file_key: Some(key.clone()),
            url: Some(format!("{base}/{key}")),
            folder_id,
            entity_type: entity.map(|(t, _)| t.to_owned()),
            entity_id: entity.map(|(_, id)| id.to_owned()),
            uploaded_by_id: user.to_owned(),
            ..NewFile::default()
        },
        &now(),
    )
    .await?;
    let file_id = row["id"].as_str().unwrap_or_default().to_owned();
    caller.publish(
        state,
        FILE_CREATED,
        &file_id,
        &json!({
            "id": file_id,
            "name": row["fileName"],
            "folderId": row["folderId"],
            "fileType": row["fileType"],
            "fileSize": row["fileSize"],
            "mimeType": row["mimeType"],
        }),
    );
    let doc = create_doc(db, &file_id, user, &json!([])).await?;
    let doc_id = doc["id"].as_str().unwrap_or_default().to_owned();
    caller.publish(
        state,
        DOC_CREATED,
        &doc_id,
        &json!({ "id": doc_id, "fileId": file_id, "updatedById": user }),
    );
    Ok(Created(row).into_response())
}

async fn create_drive_document(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let name = issues.text(fields, "name", Presence::Required, Some(1), Some(255));
        let folder = issues.text(fields, "folderId", Presence::Nullish, None, None);
        (name.into_option().unwrap_or_default(), folder.into_option())
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    let Some(clerk_org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let (name, folder_id) = input;
    let (file_name, key) = document_key(&name, &clerk_org_id, "drive");
    if let Some(folder) = folder_id.as_deref().filter(|f| !f.is_empty()) {
        let role = match load_drive_access_for_user(&caller.db, Some(&user)).await {
            Ok(index) => container_role(&index, Some(folder)),
            Err(error) => return outside(Err(error.into())),
        };
        if role.is_none() {
            return ApiError::not_found("Folder", Some(folder)).into_response();
        }
        if !can_edit(role) {
            return forbidden(DRIVE_VIEW_ONLY);
        }
    }
    reply(
        file_document(&state, &caller, &user, file_name, key, folder_id, None).await,
        "Failed to create document",
    )
}

async fn create_project_document(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let name = match validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "name", Presence::Required, Some(1), Some(255))
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(name) => name,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    let Some(clerk_org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let guard = async {
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let exists: Option<String> = sqlx::query_scalar(
            "select id from projects where id = $1 and deleted_at is null limit 1",
        )
        .bind(&project_id)
        .fetch_optional(&caller.db)
        .await?;
        if exists.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        Ok(())
    };
    if let Err(refusal) = guard.await {
        return outside(Err(refusal));
    }
    let (file_name, key) = document_key(&name, &clerk_org_id, &project_id);
    reply(
        file_document(
            &state,
            &caller,
            &user,
            file_name,
            key,
            None,
            Some(("project", &project_id)),
        )
        .await,
        "Failed to create project document",
    )
}

// ── GET /api/project-documents/:projectId, /api/project-sheets/:projectId ───

async fn list_project_documents(caller: Caller, Path(project_id): Path<String>) -> Response {
    match caller.can_access(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(f) from files f
         where f.entity_type = 'project' and f.entity_id = $1 and f.file_type = 'document'
           and f.deleted_at is null
         order by f.is_pinned desc, f.pinned_at desc, f.created_at desc",
    )
    .bind(&project_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list project documents"),
    }
}

async fn list_project_sheets(caller: Caller, Path(project_id): Path<String>) -> Response {
    match caller.can_access(&project_id).await {
        Ok(true) => {}
        Ok(false) => return forbidden(PROJECT_DENIED),
        Err(error) => return outside(Err(error.into())),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(f) from files f
         where f.entity_type = 'project' and f.entity_id = $1 and f.file_type = 'spreadsheet'
           and f.deleted_at is null
         order by f.created_at desc",
    )
    .bind(&project_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list project sheets"),
    }
}

// ── PUT /api/documents/:fileId/content ──────────────────────────────────────

async fn save_content(
    State(state): State<FlowState>,
    caller: Caller,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content = match validate(&headers, &body, |issues, fields| {
        issues
            .records(fields, "content", Presence::Required)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(content) => Value::Array(content),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    if let Err(denied) = guarded(&caller, &file_id, Mode::Write).await {
        return *denied;
    }
    reply(
        async {
            let db = &caller.db;
            let live: Option<String> = sqlx::query_scalar(
                "select id from files where id = $1 and deleted_at is null limit 1",
            )
            .bind(&file_id)
            .fetch_optional(db)
            .await?;
            if live.is_none() {
                return Err(Refusal::not_found("Document", &file_id));
            }
            if let Some(current) = doc_by_file(db, &file_id).await?
                && is_welddocs_row(&current)
            {
                return Err(Refusal::conflict(WELDDOCS_ROW_MESSAGE));
            }
            let row = upsert_doc(db, &file_id, &content, &user).await?;
            maybe_auto_snapshot(db, &file_id, &content, &user).await?;
            publish_doc_updated(&state, &caller, &row);
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to save document",
    )
}

fn publish_doc_updated(state: &FlowState, caller: &Caller, row: &Value) {
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(
        state,
        DOC_UPDATED,
        id,
        &json!({ "id": row["id"], "fileId": row["fileId"], "updatedById": row["updatedById"] }),
    );
}

// ── Versions ────────────────────────────────────────────────────────────────

async fn list_versions(caller: Caller, Path(file_id): Path<String>) -> Response {
    if let Err(denied) = guarded(&caller, &file_id, Mode::Read).await {
        return *denied;
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', v.id, 'fileId', v.file_id, 'label', v.label,
                'createdById', v.created_by_id, 'createdAt', v.created_at)
         from document_versions v where v.file_id = $1 order by v.created_at desc",
    )
    .bind(&file_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to list versions"),
    }
}

async fn create_version(
    caller: Caller,
    Path(file_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let label = match validate(&headers, &body, |issues, fields| {
        issues
            .text_with(
                fields,
                "label",
                Presence::Optional,
                Text::length(Some(1), Some(255)),
            )
            .into_option()
    }) {
        Ok(label) => label,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    if let Err(denied) = guarded(&caller, &file_id, Mode::Write).await {
        return *denied;
    }
    reply(
        async {
            let db = &caller.db;
            let Some(doc) = doc_by_file(db, &file_id).await? else {
                return Err(Refusal::not_found("Document", &file_id));
            };
            if is_welddocs_row(&doc) {
                return Err(Refusal::conflict(WELDDOCS_ROW_MESSAGE));
            }
            let content = match &doc["content"] {
                Value::Null => json!([]),
                content => content.clone(),
            };
            let row = insert_version(db, &file_id, &content, &user, label.as_deref()).await?;
            Ok(Created(row).into_response())
        }
        .await,
        "Failed to create version",
    )
}

async fn version_row(
    db: &PgPool,
    file_id: &str,
    version_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from document_versions v where v.id = $1 and v.file_id = $2 limit 1",
    )
    .bind(version_id)
    .bind(file_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn version(caller: Caller, Path((file_id, version_id)): Path<(String, String)>) -> Response {
    if let Err(denied) = guarded(&caller, &file_id, Mode::Read).await {
        return *denied;
    }
    reply(
        async {
            let Some(row) = version_row(&caller.db, &file_id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to load version",
    )
}

async fn restore_version(
    State(state): State<FlowState>,
    caller: Caller,
    Path((file_id, version_id)): Path<(String, String)>,
) -> Response {
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    if let Err(denied) = guarded(&caller, &file_id, Mode::Write).await {
        return *denied;
    }
    reply(
        async {
            let db = &caller.db;
            let Some(version) = version_row(db, &file_id, &version_id).await? else {
                return Err(Refusal::not_found("Version", &version_id));
            };
            // Snapshot what is about to be overwritten, so a restore can be undone.
            let current = doc_by_file(db, &file_id).await?;
            if let Some(current) = &current {
                if is_welddocs_row(current) {
                    return Err(Refusal::conflict(WELDDOCS_ROW_MESSAGE));
                }
                let content = match &current["content"] {
                    Value::Null => json!([]),
                    content => content.clone(),
                };
                insert_version(db, &file_id, &content, &user, None).await?;
            }
            let row = upsert_doc(db, &file_id, &version["content"], &user).await?;
            publish_doc_updated(&state, &caller, &row);
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to restore version",
    )
}
