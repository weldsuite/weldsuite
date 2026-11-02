//! Document routes (`routes/docs/index.ts` and `access.ts`).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    DOC_CREATED, DOC_DELETED, DOC_UPDATED, FILE_CREATED, FILE_DELETED, FILE_MOVED, FILE_UPDATED,
};
use weldsuite_core_domain::drive_access::{
    DriveRole, can_edit, container_role, file_role, load_drive_access_for_user, visible_files,
};
use weldsuite_core_domain::files::{
    Change, FileUpdate, NewFile, UpdatedFile, create_file, soft_delete_file, update_file,
};
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_ports::files::PutOptions;

use crate::records::{
    self, DocRecord, ListDocs, WELDDOC_MIME_TYPE, member_profile, room_name, snapshot_key_for,
};
use crate::{Caller, DocsState, Refusal, answer, color_for, now, validate, validate_query};

pub(crate) const VIEW_ONLY: &str = "You can view this document but not change it";
const DEFAULT_LIMIT: i64 = 50;
const DEFAULT_DOC_NAME: &str = "Untitled document";
/// `DOC_SNAPSHOT_MAX_BYTES`.
const SNAPSHOT_MAX_BYTES: f64 = 10.0 * 1024.0 * 1024.0;
/// Room for the JSON envelope around the largest snapshot.
const BODY_SLACK: f64 = 64.0 * 1024.0;
const TOO_LARGE: &str = "The document is too large to create";

/// The document with the caller's role on it, or the 404 (`findDoc`).
pub(crate) async fn find_doc(caller: &Caller, id: &str) -> Result<(DocRecord, DriveRole), Refusal> {
    let Some(doc) = records::get_doc(&caller.db, id).await? else {
        return Err(Refusal::not_found("Document", id));
    };
    let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
    match file_role(&access, &doc.file) {
        Some(role) => Ok((doc, role)),
        None => Err(Refusal::not_found("Document", id)),
    }
}

/// A folder the caller may add to (`None` for My Drive), or the refusal (`editableFolder`).
async fn editable_folder(
    caller: &Caller,
    folder_id: Option<&str>,
) -> Result<Option<String>, Refusal> {
    let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
    match container_role(&access, Some(folder_id)) {
        None => Err(Refusal::not_found("Folder", folder_id)),
        Some(role) if !can_edit(Some(role)) => Err(Refusal::forbidden(
            "You can view this folder but not add to it",
        )),
        Some(_) => Ok(Some(folder_id.to_owned())),
    }
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

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let (search, limit, cursor) = validate_query(raw.as_deref(), |issues, query| {
                let search = issues.text_with(
                    query,
                    "search",
                    Presence::Optional,
                    Text::trimmed(None, Some(255)),
                );
                let limit = issues.whole_number(
                    query,
                    "limit",
                    Presence::Optional,
                    Number {
                        coerce: true,
                        min: Some(1.0),
                        max: Some(200.0),
                        ..Number::default()
                    },
                );
                let cursor = issues.pattern(
                    query,
                    "cursor",
                    Presence::Optional,
                    None,
                    None,
                    |text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()),
                    "Invalid",
                );
                (
                    search.into_option(),
                    limit.into_option(),
                    cursor.into_option(),
                )
            })?;
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
            let offset = cursor
                .as_deref()
                .map_or(0, |c| c.parse::<i64>().unwrap_or(i64::MAX));
            let params = ListDocs {
                visible: visible_files(&access),
                search: search
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("%{}%", escape_like(&s))),
                limit: limit.unwrap_or(DEFAULT_LIMIT),
                offset,
            };
            let (rows, total) = records::list_docs(&caller.db, &params).await?;
            let may_edit = caller.may_update();
            let next = offset + i64::try_from(rows.len()).unwrap_or(0);
            let data = rows
                .iter()
                .map(|doc| {
                    doc.summary(
                        file_role(&access, &doc.file).unwrap_or(DriveRole::Viewer),
                        may_edit,
                    )
                })
                .collect();
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

/// `z.custom` of a document snapshot: an object with an integer `version`.
fn is_snapshot_like(value: &Value) -> bool {
    value
        .get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version.fract() == 0.0 && version.is_finite())
}

pub(crate) async fn create(
    State(state): State<DocsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, folder_id, snapshot) = validate(&headers, &body, |issues, body| {
                let name = issues.text_with(
                    body,
                    "name",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(255)),
                );
                let folder_id = issues.text(body, "folderId", Presence::Nullish, None, None);
                let snapshot = body.get("snapshot");
                if snapshot.is_some_and(|value| !is_snapshot_like(value)) {
                    // `z.custom` reports its issue as fatal.
                    issues.push_issue(
                        "snapshot",
                        json!({ "code": "custom", "fatal": true, "message": "Expected a document snapshot" }),
                    );
                }
                (name.into_option(), folder_id.into_option(), snapshot.is_some())
            })?;
            let org = caller.org()?.to_owned();
            let length = headers
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .map_or(f64::NAN, weldsuite_kit::validation::js_number);
            if length > SNAPSHOT_MAX_BYTES + BODY_SLACK {
                return Err(too_large());
            }
            let folder = editable_folder(&caller, folder_id.as_deref()).await?;
            // As the text the client sent: the engine keeps the snapshot's key order.
            let args = if snapshot {
                json!([raw_field(&body, "snapshot").unwrap_or_default()])
            } else {
                json!([])
            };
            let made = caller.engine(&state, "newDocument", args).await?;
            if made["ok"] != Value::Bool(true) {
                return Err(match made["reason"].as_str() {
                    Some("too_large") => too_large(),
                    _ => ApiError::bad_request("The snapshot is not a document")
                        .with_details(json!({ "reason": "invalid_snapshot" }))
                        .into(),
                });
            }
            let checkpoint = weldsuite_ports::collab::value_bytes(&made["checkpoint"])
                .ok_or_else(|| Refusal::from(ApiError::internal()))?;

            // The first checkpoint goes in before the rows, so a room never opens a document without one.
            let doc_id = generate_id("doc");
            let key = snapshot_key_for(&org, &doc_id);
            let size = i64::try_from(checkpoint.len()).unwrap_or(i64::MAX);
            let files = caller.files(&state).ok_or_else(|| Refusal::from(ApiError::internal()))?;
            let mut options = PutOptions::content_type("application/gzip");
            options = options.with_metadata("revision", "0");
            files
                .private
                .put_boxed(&key, checkpoint, &options)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "[docs-api] writing a checkpoint failed");
                    Refusal::from(ApiError::internal())
                })?;
            let name = name.unwrap_or_else(|| DEFAULT_DOC_NAME.to_owned());
            let now = now();
            let file = create_file(
                &caller.db,
                &NewFile {
                    file_name: name.clone(),
                    original_name: Some(name),
                    mime_type: WELDDOC_MIME_TYPE.to_owned(),
                    file_size: size,
                    file_type: Some("document".to_owned()),
                    storage_path: key.clone(),
                    file_key: Some(key.clone()),
                    bucket: Some("private".to_owned()),
                    folder_id: folder,
                    metadata: Some(json!({ "weldDocId": doc_id })),
                    uploaded_by_id: caller.user_id.clone(),
                    ..NewFile::default()
                },
                &now,
            )
            .await?;
            let file_id = file["id"].as_str().unwrap_or_default().to_owned();
            records::insert_doc(&caller.db, &doc_id, &file_id, &key, &caller.user_id, &now).await?;
            let Some(created) = records::get_doc(&caller.db, &doc_id).await? else {
                tracing::error!(doc_id, "[docs-api] a document vanished after insert");
                return Err(ApiError::internal().into());
            };
            caller.publish(
                &state,
                FILE_CREATED,
                &created.file_id,
                &json!({
                    "id": created.file_id,
                    "name": created.name,
                    "folderId": created.folder_id,
                    "fileType": "document",
                    "fileSize": size,
                }),
            );
            caller.publish(&state, DOC_CREATED, &created.id, &created.event_data());
            Ok(Created(created.summary(DriveRole::Owner, caller.may_update())).into_response())
        }
        .await,
    )
}

/// A top-level field of a JSON body as the text it was sent as.
fn raw_field(body: &[u8], key: &str) -> Option<String> {
    let fields: std::collections::HashMap<String, Box<serde_json::value::RawValue>> =
        serde_json::from_slice(body).ok()?;
    fields.get(key).map(|raw| raw.get().to_owned())
}

fn too_large() -> Refusal {
    ApiError::bad_request(TOO_LARGE)
        .with_details(json!({ "reason": "too_large" }))
        .into()
}

// ── GET /:id/snapshot ───────────────────────────────────────────────────────

pub(crate) async fn snapshot(
    State(state): State<DocsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let (doc, _) = find_doc(&caller, &id).await?;
            let live = caller
                .room(
                    &state,
                    &room_name(&org, &doc.id),
                    "snapshot",
                    json!([doc.room_meta(&org)]),
                )
                .await?;
            // The envelope of success(), around the snapshot's JSON as the room wrote it.
            let body = format!(
                r#"{{"data":{{"revision":{},"snapshot":{}}}}}"#,
                live["revision"],
                live["json"].as_str().unwrap_or("null")
            );
            let mut response = (StatusCode::OK, body).into_response();
            let headers = response.headers_mut();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            Ok(response)
        }
        .await,
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let (doc, role) = find_doc(&caller, &id).await?;
            Ok(Data(doc.summary(role, caller.may_update())).into_response())
        }
        .await,
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<DocsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, folder_id) = validate(&headers, &body, |issues, body| {
                let name = issues.text_with(
                    body,
                    "name",
                    Presence::Optional,
                    Text::trimmed(Some(1), Some(255)),
                );
                let folder_id = issues.text(body, "folderId", Presence::Nullish, None, None);
                // The refine sees what parsed: a key left out stays undefined.
                if !body.contains_key("name") && !body.contains_key("folderId") {
                    issues.custom_root("Send a name or a folder");
                }
                (name, folder_id)
            })?;
            let (doc, role) = find_doc(&caller, &id).await?;
            if !can_edit(Some(role)) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            // Moving out of a folder is an edit of the document; moving into one needs a say in that folder.
            let target = if folder_id.is_absent() {
                Change::Keep
            } else {
                Change::Set(editable_folder(&caller, folder_id.as_set().map(String::as_str)).await?)
            };
            let update = FileUpdate {
                file_name: name.into_option().map_or(Change::Keep, Change::Set),
                folder_id: target,
                ..FileUpdate::default()
            };
            let previous = match update_file(&caller.db, &doc.file_id, &update, &now()).await? {
                UpdatedFile::Updated { previous, .. } => previous,
                UpdatedFile::NameConflict => {
                    return Err(ApiError::conflict(
                        "A file with this name already exists in this folder",
                    )
                    .into());
                }
                UpdatedFile::NotFound => return Err(Refusal::not_found("Document", &doc.id)),
            };
            let Some(doc) = records::get_doc(&caller.db, &doc.id).await? else {
                return Err(Refusal::not_found("Document", &doc.id));
            };
            let previous_name = previous["fileName"].clone();
            let renamed = Value::String(doc.name.clone()) != previous_name;
            let moved = json!(doc.folder_id) != previous["folderId"];
            let file_data = json!({
                "id": doc.file_id,
                "name": doc.name,
                "folderId": doc.folder_id,
                "fileType": "document",
            });
            let name_change = || {
                let mut changes = Map::new();
                changes.insert(
                    "name".into(),
                    json!({ "old": previous_name, "new": doc.name }),
                );
                changes
            };
            if renamed {
                caller.publish_changes(
                    &state,
                    FILE_UPDATED,
                    &doc.file_id,
                    &file_data,
                    name_change(),
                );
            }
            if moved {
                caller.publish(&state, FILE_MOVED, &doc.file_id, &file_data);
            }
            if renamed {
                caller.publish_changes(
                    &state,
                    DOC_UPDATED,
                    &doc.id,
                    &doc.event_data(),
                    name_change(),
                );
            } else {
                caller.publish(&state, DOC_UPDATED, &doc.id, &doc.event_data());
            }
            Ok(Data(doc.summary(role, true)).into_response())
        }
        .await,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<DocsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let (doc, role) = find_doc(&caller, &id).await?;
            if !can_edit(Some(role)) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            if soft_delete_file(&caller.db, &doc.file_id, &now())
                .await?
                .is_none()
            {
                return Err(Refusal::not_found("Document", &doc.id));
            }
            caller.publish(
                &state,
                FILE_DELETED,
                &doc.file_id,
                &json!({
                    "id": doc.file_id,
                    "name": doc.name,
                    "folderId": doc.folder_id,
                    "fileType": "document",
                }),
            );
            caller.publish(&state, DOC_DELETED, &doc.id, &doc.event_data());
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── POST /:id/session ───────────────────────────────────────────────────────

pub(crate) async fn session(
    State(state): State<DocsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let (doc, role) = find_doc(&caller, &id).await?;
            // Edit (owner or editor with docs:update), comment (anyone else who
            // may see it, with docs:comment), or only view.
            let mode = if caller.may_edit(role) {
                "edit"
            } else if caller.may_comment() {
                "comment"
            } else {
                "view"
            };
            let (name, picture) = member_profile(&caller.db, &caller.user_id).await?;
            let color = color_for(&caller.user_id);
            let mut admission = doc.room_meta(&org);
            if let Value::Object(fields) = &mut admission {
                fields.insert("userId".into(), json!(caller.user_id));
                fields.insert("name".into(), json!(name.as_deref().unwrap_or("Unknown")));
                fields.insert("picture".into(), json!(picture));
                fields.insert("color".into(), json!(color));
                fields.insert("canEdit".into(), json!(mode == "edit"));
                fields.insert("canComment".into(), json!(mode == "comment"));
            }
            let ticket = caller
                .room(
                    &state,
                    &room_name(&org, &doc.id),
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
