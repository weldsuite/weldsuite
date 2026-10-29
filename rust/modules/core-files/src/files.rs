//! `/api/files` (`apps/workers/app-api/src/routes/files/index.ts`): WeldDrive's
//! file store. Permissions open the door; which files a caller sees, and
//! whether they may change them, follows the WeldDrive rules. A file the
//! caller cannot see is a 404.
//!
//! Entity events: `file:created | updated | deleted | moved | starred |
//! pinned | shared | unshared`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    FILE_CREATED, FILE_DELETED, FILE_MOVED, FILE_PINNED, FILE_SHARED, FILE_STARRED, FILE_UNSHARED,
    FILE_UPDATED,
};
use weldsuite_catalogs::permission_keys::FILES_UPDATE;
use weldsuite_core_domain::drive_access::{
    DriveAccessIndex, DriveFileRef, DriveGeneralAccess, DriveRole, can_edit, container_role,
    file_role, is_module_file, is_shareable_member,
};
use weldsuite_core_domain::drive_sharing::{
    DriveItem, NewShare, SharingTarget, describe_sharing, remove_share, upsert_share,
    with_file_access,
};
use weldsuite_core_domain::files::{
    self as files_db, Change, FileUpdate, ListFiles, MovedFile, NewFile, UpdatedFile,
};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_ports::{JobRequest, PutOptions};

use crate::trash_purge::{TRASH_PURGE_JOB, TRASH_RETENTION, TrashPurge};

use crate::drive::{DRIVE_VIEW_ONLY, UrlBases, normalize_generic_files, query_array};
use crate::names::{drive_name, sanitize_drive_name};
use crate::{
    Caller, CoreFilesState, Fail, answer, created, encode_uri_component, forbidden, json_response,
    not_found, now, ok, query_param, text, validate, validate_query,
};

const DRIVE_MODULE_FILE: &str =
    "This file belongs to a record in another module, which decides who can open it";
const NAME_CONFLICT: &str = "A file with this name already exists in this folder";

/// A live file and the caller's role on it.
pub(crate) struct OpenedFile {
    pub(crate) row: Value,
    pub(crate) access: DriveAccessIndex,
    pub(crate) role: DriveRole,
}

/// Load a live file and the caller's role on it; `edit` also needs owner or
/// editor. 404 when it is missing or hidden, 403 when only viewable
/// (`openFile`).
async fn open_file(caller: &Caller, id: &str, edit: bool) -> Result<OpenedFile, Fail> {
    let Some(row) = files_db::live_file(&caller.db, id).await? else {
        return Err(not_found("File", id));
    };
    let access = caller.drive_access().await?;
    let Some(role) = file_role(&access, &DriveFileRef::from_row(&row)) else {
        return Err(not_found("File", id));
    };
    if edit && !can_edit(Some(role)) {
        return Err(forbidden(DRIVE_VIEW_ONLY));
    }
    Ok(OpenedFile { row, access, role })
}

/// The refusal, unless the caller may put a file in `folder_id`
/// (`checkDestination`).
pub(crate) fn check_destination(
    access: &DriveAccessIndex,
    folder_id: Option<&str>,
) -> Result<(), Fail> {
    let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    match container_role(access, Some(folder_id)) {
        None => Err(not_found("Folder", folder_id)),
        Some(role) if can_edit(Some(role)) => Ok(()),
        Some(_) => Err(forbidden(DRIVE_VIEW_ONLY)),
    }
}

/// Who an opened file is open to, for the Share dialog (`fileSharing`).
async fn file_sharing(caller: &Caller, opened: &OpenedFile) -> Result<Value, Fail> {
    let row = &opened.row;
    let target = SharingTarget {
        item: DriveItem::File(text(row, "id").unwrap_or_default()),
        owner_id: text(row, "uploadedById"),
        general_access: DriveGeneralAccess::parse(text(row, "generalAccess").unwrap_or_default()),
        parent_id: text(row, "folderId"),
    };
    Ok(describe_sharing(&caller.db, &opened.access, target, opened.role).await?)
}

fn is_module_row(row: &Value) -> bool {
    is_module_file(text(row, "entityType"))
}

/// `tagsToSpaces`: every `<…>` tag (not a bare `<>`) becomes a space.
fn tags_to_spaces(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        let Some(gt) = rest[lt + 1..].find('>').map(|i| lt + 1 + i) else {
            break;
        };
        if gt == lt + 1 {
            out.push_str(&rest[..=gt]);
        } else {
            out.push_str(&rest[..lt]);
            out.push(' ');
        }
        rest = &rest[gt + 1..];
    }
    out.push_str(rest);
    out
}

/// The first `n` UTF-16 units of `text` (`slice(0, n)`).
fn utf16_prefix(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// The fields a file's activity shows as "from → to" (`trackedFileFields`).
fn tracked_file_fields(row: &Value) -> Map<String, Value> {
    let description = files_db::file_description(row).map(|description| {
        let spaced = tags_to_spaces(description);
        let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
        utf16_prefix(&collapsed, 200)
    });
    let mut fields = Map::new();
    fields.insert("name".to_owned(), row["fileName"].clone());
    fields.insert("isStarred".to_owned(), row["isStarred"].clone());
    fields.insert("isPublic".to_owned(), row["isPublic"].clone());
    fields.insert("generalAccess".to_owned(), row["generalAccess"].clone());
    fields.insert("description".to_owned(), json!(description));
    fields
}

/// `computeChanges(old, new)`: the keys whose JSON differs, or `None`.
fn compute_changes(
    old: &Map<String, Value>,
    new: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    let mut changes = Map::new();
    for (key, value) in new {
        let previous = old.get(key).unwrap_or(&Value::Null);
        if previous != value {
            changes.insert(key.clone(), json!({ "old": previous, "new": value }));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

// ── GET / ──────────────────────────────────────────────────────────────────

pub(crate) async fn list(
    State(state): State<CoreFilesState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let q = match validate_query(query.as_deref(), |issues, q| {
        let list = crate::drive::read_list_query(issues, q);
        let mut string = |key: &str| {
            issues
                .text(q, key, Presence::Optional, None, None)
                .into_option()
        };
        let folder_id = string("folderId");
        string("dateFrom");
        string("dateTo");
        let entity_type = string("entityType");
        let entity_id = string("entityId");
        (list, folder_id, entity_type, entity_id)
    }) {
        Ok(q) => q,
        Err(fail) => return answer(Err(fail), ""),
    };
    let (list, folder_id, entity_type, entity_id) = q;
    let root_only = query_param(query.as_deref(), "folderId").as_deref() == Some("");
    answer(
        async {
            let rows = files_db::list_files(
                &caller.db,
                &ListFiles {
                    folder_id: folder_id.as_deref(),
                    root_only,
                    file_type: list.file_type.as_deref(),
                    entity_type: entity_type.as_deref(),
                    entity_id: entity_id.as_deref(),
                },
            )
            .await?;
            let access = caller.drive_access().await?;
            let normalized = normalize_generic_files(
                with_file_access(&access, rows),
                &UrlBases::of(&caller, &state),
            );
            let (items, pagination) = query_array(&normalized, &list.array_query(None));
            Ok(json_response(
                StatusCode::OK,
                json!({ "success": true, "data": items, "pagination": pagination }),
            ))
        }
        .await,
        "Failed to list files",
    )
}

// ── GET /:id ───────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let opened = open_file(&caller, &id, false).await?;
            let row = with_file_access(&opened.access, vec![opened.row])
                .pop()
                .unwrap_or(Value::Null);
            ok(row)
        }
        .await,
        "Failed to fetch file",
    )
}

// ── POST / ─────────────────────────────────────────────────────────────────

/// `createFileSchema`.
fn read_new_file(issues: &mut Issues, body: &Map<String, Value>) -> NewFile {
    let string = |issues: &mut Issues, key: &str, presence: Presence| {
        issues.text(body, key, presence, None, None).into_option()
    };
    let file_name = issues
        .text_with(
            body,
            "fileName",
            Presence::Required,
            Text::trimmed(Some(1), Some(500)),
        )
        .into_option()
        .map(|name| sanitize_drive_name(&name))
        .unwrap_or_default();
    let original_name = string(issues, "originalName", Presence::Optional);
    let mime_type = issues
        .text(body, "mimeType", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let file_size = issues
        .whole_number(
            body,
            "fileSize",
            Presence::Required,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or_default();
    let file_type = string(issues, "fileType", Presence::Optional);
    let storage_path = issues
        .text(body, "storagePath", Presence::Required, Some(1), Some(1000))
        .into_option()
        .unwrap_or_default();
    let file_key = issues
        .text(body, "fileKey", Presence::Optional, Some(1), Some(1000))
        .into_option();
    let url = string(issues, "url", Presence::Optional);
    let thumbnail_url = string(issues, "thumbnailUrl", Presence::Optional);
    let folder_id = string(issues, "folderId", Presence::Nullish);
    let is_public = issues
        .boolean(body, "isPublic", Presence::Optional)
        .into_option();
    let entity_type = string(issues, "entityType", Presence::Optional);
    let entity_id = string(issues, "entityId", Presence::Nullish);
    let metadata = issues
        .nested(body, "metadata", Presence::Optional, |_, fields| {
            Value::Object(fields.clone())
        })
        .into_option();
    NewFile {
        file_name,
        original_name,
        mime_type,
        file_size,
        file_type,
        storage_path,
        file_key,
        bucket: None,
        url,
        thumbnail_url,
        folder_id,
        is_public,
        entity_type,
        entity_id,
        metadata,
        uploaded_by_id: String::new(),
    }
}

pub(crate) async fn create(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let mut file = validate(&headers, &body, read_new_file)?;
            let Some(user_id) = caller.user_id.clone() else {
                return Err(ApiError::unauthorized().into());
            };
            // The keys come from the client and the content routes serve by
            // key: they must be this workspace's uploads (TASK-620).
            let keys = [Some(&file.storage_path), file.file_key.as_ref()];
            if !keys.into_iter().flatten().all(|key| caller.owns_key(key)) {
                return Err(ApiError::bad_request(
                    "storagePath / fileKey is not a file of this workspace",
                )
                .into());
            }
            check_destination(&caller.drive_access().await?, file.folder_id.as_deref())?;
            // Record which bucket the object is actually in.
            let key = file
                .file_key
                .clone()
                .unwrap_or_else(|| file.storage_path.clone());
            file.bucket = locate(&caller, &state, &key).await?.map(str::to_owned);
            file.uploaded_by_id = user_id;
            let row = files_db::create_file(&caller.db, &file, &now()).await?;
            caller.publish(
                &state,
                FILE_CREATED,
                text(&row, "id").unwrap_or_default(),
                &json!({
                    "id": row["id"], "name": row["fileName"], "folderId": row["folderId"],
                    "fileType": row["fileType"], "fileSize": row["fileSize"],
                    "mimeType": row["mimeType"],
                }),
            );
            created(row)
        }
        .await,
        "Failed to create file",
    )
}

/// `locateStoredObject`: which bucket holds `key`, private first.
async fn locate(
    caller: &Caller,
    state: &CoreFilesState,
    key: &str,
) -> Result<Option<&'static str>, Fail> {
    let Some(stores) = caller.files(state) else {
        return Ok(None);
    };
    if stores.private.head_boxed(key).await?.is_some() {
        return Ok(Some("private"));
    }
    if let Some(public) = &stores.public
        && public.head_boxed(key).await?.is_some()
    {
        return Ok(Some("public"));
    }
    Ok(None)
}

// ── PATCH /:id ─────────────────────────────────────────────────────────────

/// `updateDriveFileSchema`.
fn read_file_update(issues: &mut Issues, body: &Map<String, Value>) -> FileUpdate {
    let change = |field: Field<String>| match field {
        Field::Set(value) => Change::Set(value),
        _ => Change::Keep,
    };
    let nullable = |field: Field<String>| match field {
        Field::Set(value) => Change::Set(Some(value)),
        Field::Null => Change::Set(None),
        Field::Absent => Change::Keep,
    };
    let file_name = change(drive_name(issues, body, "fileName", Presence::Optional));
    let folder_id = nullable(issues.text(body, "folderId", Presence::Nullish, None, None));
    let flag = |field: Field<bool>| match field {
        Field::Set(value) => Change::Set(value),
        _ => Change::Keep,
    };
    let is_starred = flag(issues.boolean(body, "isStarred", Presence::Optional));
    let is_public = flag(issues.boolean(body, "isPublic", Presence::Optional));
    let description =
        nullable(issues.text(body, "description", Presence::Nullish, None, Some(20000)));
    let general_access = change(issues.choice(
        body,
        "generalAccess",
        Presence::Optional,
        &["workspace_edit", "workspace_view", "restricted"],
    ));
    FileUpdate {
        file_name,
        folder_id,
        is_starred,
        is_public,
        description,
        general_access,
    }
}

pub(crate) async fn update(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let update = validate(&headers, &body, read_file_update)?;
            let opened = open_file(&caller, &id, true).await?;
            if let Change::Set(folder) = &update.folder_id
                && folder.as_deref() != text(&opened.row, "folderId")
            {
                check_destination(&opened.access, folder.as_deref())?;
            }
            if update.general_access.is_set() && is_module_row(&opened.row) {
                return Err(ApiError::bad_request(DRIVE_MODULE_FILE).into());
            }
            match files_db::update_file(&caller.db, &id, &update, &now()).await? {
                UpdatedFile::NotFound => Err(not_found("File", &id)),
                UpdatedFile::NameConflict => Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({ "success": false, "error": NAME_CONFLICT }),
                )),
                UpdatedFile::Updated { row, previous } => {
                    let changes = compute_changes(
                        &tracked_file_fields(&previous),
                        &tracked_file_fields(&row),
                    );
                    caller.publish_with_changes(
                        &state,
                        FILE_UPDATED,
                        text(&row, "id").unwrap_or_default(),
                        json!({
                            "id": row["id"], "name": row["fileName"], "folderId": row["folderId"],
                            "fileType": row["fileType"], "fileSize": row["fileSize"],
                        }),
                        changes,
                    );
                    ok(row)
                }
            }
        }
        .await,
        "Failed to update file",
    )
}

// ── DELETE /:id ────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    // The purge job carries the Clerk org id.
    let Some(org_id) = caller.clerk_org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    answer(
        async {
            open_file(&caller, &id, true).await?;
            let deleted_at = OffsetDateTime::now_utc();
            let deleted_text = iso_timestamp(deleted_at);
            let Some(row) = files_db::soft_delete_file(&caller.db, &id, &deleted_text).await?
            else {
                return Err(not_found("File", &id));
            };
            schedule_trash_purge(&state, &org_id, &id, &row, deleted_at).await;
            caller.publish(
                &state,
                FILE_DELETED,
                &id,
                &json!({
                    "id": id, "name": row["fileName"], "folderId": row["folderId"],
                    "fileType": row["fileType"], "fileSize": row["fileSize"],
                }),
            );
            ok(json!({ "deleted": true }))
        }
        .await,
        "Failed to delete file",
    )
}

/// Start the 30-day purge (`TRASH_CLEANUP.create(...)`): keyed by the file
/// and the moment it was trashed, so a restore and a second trash start a
/// new one and the old one finds `deleted_at` changed. A failure to start is
/// logged; the file stays in the trash until it is emptied.
async fn schedule_trash_purge(
    state: &CoreFilesState,
    org_id: &str,
    id: &str,
    row: &Value,
    deleted_at: OffsetDateTime,
) {
    let Some(jobs) = &state.storage.jobs else {
        return;
    };
    let purge_at = deleted_at + TRASH_RETENTION;
    let millis = deleted_at.unix_timestamp_nanos() / 1_000_000;
    let payload = TrashPurge {
        workspace_id: org_id.to_owned(),
        file_id: id.to_owned(),
        file_key: files_db::storage_key(row).unwrap_or_default().to_owned(),
        deleted_at: iso_timestamp(deleted_at),
        purge_at: iso_timestamp(purge_at),
    };
    let started = match JobRequest::new(TRASH_PURGE_JOB, format!("trash-{id}-{millis}"), &payload) {
        Ok(request) => jobs.start_boxed(request.with_delay(TRASH_RETENTION)).await,
        Err(error) => Err(error),
    };
    if let Err(error) = started {
        tracing::error!(%error, file_id = id, "files: scheduling the trash purge failed");
    }
}

// ── POST /:id/star, /:id/pin ───────────────────────────────────────────────

pub(crate) async fn star(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            open_file(&caller, &id, false).await?;
            let Some((starred, row)) = files_db::toggle_star(&caller.db, &id, &now()).await? else {
                return Err(not_found("File", &id));
            };
            caller.publish(
                &state,
                FILE_STARRED,
                &id,
                &json!({ "id": id, "name": row["fileName"], "folderId": row["folderId"] }),
            );
            ok(json!({ "isStarred": starred }))
        }
        .await,
        "Failed to toggle star",
    )
}

pub(crate) async fn pin(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let Some(user_id) = caller.user_id.clone() else {
        return ApiError::unauthorized().into_response();
    };
    answer(
        async {
            // The pin shows for the whole workspace, so it is a change to the file.
            open_file(&caller, &id, true).await?;
            let Some((pinned, row)) =
                files_db::toggle_pin(&caller.db, &id, &user_id, &now()).await?
            else {
                return Err(not_found("File", &id));
            };
            caller.publish(
                &state,
                FILE_PINNED,
                &id,
                &json!({
                    "id": id, "name": row["fileName"], "folderId": row["folderId"],
                    "isPinned": pinned,
                }),
            );
            ok(json!({ "isPinned": pinned }))
        }
        .await,
        "Failed to toggle pin",
    )
}

// ── GET|PUT /:id/content ───────────────────────────────────────────────────

/// Types stored and served as themselves (`INLINE_EXACT` in
/// `lib/storage-upload.ts`).
const INLINE_EXACT: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/pjpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "image/tiff",
    "image/heic",
    "image/heif",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "application/pdf",
    "application/rtf",
    "text/rtf",
    "application/msword",
    "application/epub+zip",
    "text/plain",
    "text/csv",
    "text/tab-separated-values",
    "text/markdown",
    "text/calendar",
    "text/vcard",
    "application/json",
    "application/zip",
    "application/x-zip-compressed",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-rar-compressed",
];

/// Families where every subtype is passive (`INLINE_PREFIXES`).
const INLINE_PREFIXES: &[&str] = &[
    "audio/",
    "video/",
    "application/vnd.openxmlformats-officedocument.",
    "application/vnd.oasis.opendocument.",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-word",
    "application/vnd.ms-outlook",
];

/// A plain `type/subtype` (`MEDIA_TYPE`).
fn is_media_type(base: &str) -> bool {
    let restricted = |part: &str| {
        let mut bytes = part.bytes();
        bytes
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && bytes
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+-".contains(&b))
    };
    match base.split_once('/') {
        Some((kind, subtype)) => restricted(kind) && restricted(subtype),
        None => false,
    }
}

/// How an object is stored and served, from the declared type
/// (`resolveStoredContent`): allowlisted types as themselves, anything else
/// as an attachment octet-stream.
pub(crate) fn resolve_stored_content(declared: &str) -> (String, bool) {
    let base = declared
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if is_media_type(&base)
        && (INLINE_EXACT.contains(&base.as_str())
            || INLINE_PREFIXES
                .iter()
                .any(|prefix| base.starts_with(prefix)))
    {
        return (base, false);
    }
    ("application/octet-stream".to_owned(), true)
}

fn header(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

pub(crate) async fn content(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let wants_download = query_param(query.as_deref(), "download").as_deref() == Some("1");
    answer(
        async {
            let opened = open_file(&caller, &id, false).await?;
            let row = &opened.row;
            let Some(stores) = caller.files(&state) else {
                return Err(ApiError::internal()
                    .with_message("Storage is not configured")
                    .into());
            };
            let Some(key) = files_db::storage_key(row) else {
                return Err(not_found("File content", &id));
            };
            // A row's key is client-supplied: never another tenant's objects.
            if !caller.owns_key(key) {
                return Err(not_found("File content", &id));
            }
            let Some(object) =
                weldsuite_ports::get_stored(&*stores.private, stores.public.as_deref(), key)
                    .await?
            else {
                return Err(not_found("File content", &id));
            };
            let declared = text(row, "mimeType")
                .filter(|m| !m.is_empty())
                .or(object
                    .info
                    .content_type
                    .as_deref()
                    .filter(|m| !m.is_empty()))
                .unwrap_or("application/octet-stream");
            let (content_type, attachment) = resolve_stored_content(declared);
            let size = object.bytes.len();
            let mut response = (StatusCode::OK, object.bytes).into_response();
            let headers = response.headers_mut();
            headers.insert(CONTENT_TYPE, header(&content_type));
            headers.insert(CONTENT_LENGTH, HeaderValue::from(size));
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
            headers.insert(
                http::header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            if attachment {
                headers.insert(CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
            }
            if wants_download {
                let name = text(row, "fileName")
                    .filter(|n| !n.is_empty())
                    .map_or_else(|| format!("file-{id}"), str::to_owned)
                    .replace('"', "");
                let disposition = format!(
                    "attachment; filename=\"{name}\"; filename*=UTF-8''{}",
                    encode_uri_component(&name)
                );
                headers.insert(CONTENT_DISPOSITION, header(&disposition));
            }
            Ok(response)
        }
        .await,
        "Failed to read file content",
    )
}

pub(crate) async fn write_content(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    answer(
        async {
            let opened = open_file(&caller, &id, true).await?;
            let row = &opened.row;
            let Some(stores) = caller.files(&state) else {
                return Err(ApiError::internal()
                    .with_message("Storage is not configured")
                    .into());
            };
            let Some(key) = files_db::storage_key(row).map(str::to_owned) else {
                return Err(ApiError::internal()
                    .with_message("File has no storage key")
                    .into());
            };
            if !caller.owns_key(&key) {
                return Err(not_found("File", &id));
            }
            let (content_type, _) = resolve_stored_content(
                text(row, "mimeType")
                    .filter(|m| !m.is_empty())
                    .unwrap_or("application/octet-stream"),
            );
            // Overwrite in whichever bucket holds the file, so an edit never
            // moves it (`putStoredObject`); a new key goes to the private one.
            let in_public = match &stores.public {
                Some(public) if stores.private.head_boxed(&key).await?.is_none() => {
                    public.head_boxed(&key).await?.is_some()
                }
                _ => false,
            };
            let target = match (&stores.public, in_public) {
                (Some(public), true) => public.clone(),
                _ => stores.private.clone(),
            };
            let size = body.len();
            target
                .put_boxed(&key, body.to_vec(), &PutOptions::content_type(content_type))
                .await?;
            let size = i64::try_from(size).unwrap_or(i64::MAX);
            let updated = files_db::touch_file_size(&caller.db, &id, size, &now()).await?;
            caller.publish(
                &state,
                FILE_UPDATED,
                &id,
                &json!({
                    "id": id, "name": row["fileName"], "folderId": row["folderId"],
                    "fileType": row["fileType"], "fileSize": size,
                }),
            );
            ok(updated.unwrap_or_else(|| row.clone()))
        }
        .await,
        "Failed to write file content",
    )
}

// ── POST /:id/move ─────────────────────────────────────────────────────────

pub(crate) async fn move_to(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let folder_id = validate(&headers, &body, |issues, body| {
                issues
                    .text(body, "folderId", Presence::Nullable, None, None)
                    .into_option()
            })?;
            let opened = open_file(&caller, &id, true).await?;
            check_destination(&opened.access, folder_id.as_deref())?;
            match files_db::move_file(&caller.db, &id, folder_id.as_deref(), &now()).await? {
                MovedFile::FileNotFound => Err(not_found("File", &id)),
                MovedFile::FolderNotFound => Err(not_found(
                    "Folder",
                    folder_id.as_deref().unwrap_or_default(),
                )),
                MovedFile::NameConflict => Ok(json_response(
                    StatusCode::CONFLICT,
                    json!({ "success": false, "error": NAME_CONFLICT }),
                )),
                MovedFile::Moved(row) => {
                    caller.publish(
                        &state,
                        FILE_MOVED,
                        &id,
                        &json!({ "id": id, "name": row["fileName"], "folderId": folder_id }),
                    );
                    ok(json!({ "moved": true, "folderId": folder_id }))
                }
            }
        }
        .await,
        "Failed to move file",
    )
}

// ── Sharing ────────────────────────────────────────────────────────────────

pub(crate) async fn sharing(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let opened = open_file(&caller, &id, false).await?;
            if is_module_row(&opened.row) {
                return Err(ApiError::bad_request(DRIVE_MODULE_FILE).into());
            }
            ok(file_sharing(&caller, &opened).await?)
        }
        .await,
        "Failed to load sharing",
    )
}

/// `shareDriveItemSchema`.
pub(crate) fn read_share_role(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .one_of(body, "role", &["viewer", "editor"])
        .unwrap_or_default()
}

pub(crate) async fn share(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path((id, target_user)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let role = validate(&headers, &body, read_share_role)?;
            let Some(user_id) = caller.user_id.clone() else {
                return Err(ApiError::unauthorized().into());
            };
            let opened = open_file(&caller, &id, true).await?;
            let row = &opened.row;
            if is_module_row(row) {
                return Err(ApiError::bad_request(DRIVE_MODULE_FILE).into());
            }
            if target_user == user_id {
                return Err(ApiError::bad_request("You cannot share a file with yourself").into());
            }
            if Some(target_user.as_str()) == text(row, "uploadedById") {
                return Err(
                    ApiError::bad_request("The owner already has access to this file").into(),
                );
            }
            if !is_shareable_member(&caller.db, &target_user).await? {
                return Err(ApiError::bad_request(
                    "Files can only be shared with active members of this workspace",
                )
                .into());
            }
            let previous = upsert_share(
                &caller.db,
                DriveItem::File(&id),
                NewShare {
                    user_id: &target_user,
                    role: &role,
                    shared_by: &user_id,
                    now: &now(),
                },
            )
            .await?;
            caller.publish(
                &state,
                FILE_SHARED,
                &id,
                &json!({
                    "id": id, "name": row["fileName"], "folderId": row["folderId"],
                    "userId": target_user, "role": role, "previousRole": previous,
                }),
            );
            ok(file_sharing(&caller, &opened).await?)
        }
        .await,
        "Failed to share file",
    )
}

pub(crate) async fn unshare(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path((id, target_user)): Path<(String, String)>,
) -> Response {
    let Some(user_id) = caller.user_id.clone() else {
        return ApiError::unauthorized().into_response();
    };
    answer(
        async {
            let leaving = target_user == user_id;
            let opened = open_file(&caller, &id, !leaving).await?;
            if !leaving && !caller.can(FILES_UPDATE) {
                return Err(forbidden("Missing permission: files:update"));
            }
            let Some(removed) =
                remove_share(&caller.db, DriveItem::File(&id), &target_user).await?
            else {
                return Err(not_found("Share", &target_user));
            };
            caller.publish(
                &state,
                FILE_UNSHARED,
                &id,
                &json!({
                    "id": id, "name": opened.row["fileName"], "folderId": opened.row["folderId"],
                    "userId": target_user, "role": removed,
                }),
            );
            let after = match open_file(&caller, &id, false).await {
                Ok(after) => file_sharing(&caller, &after).await?,
                Err(Fail::Response(_)) => Value::Null,
                Err(other) => return Err(other),
            };
            ok(after)
        }
        .await,
        "Failed to stop sharing file",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_content_like_the_allowlist() {
        assert_eq!(
            resolve_stored_content("text/plain; charset=utf-8"),
            ("text/plain".to_owned(), false)
        );
        assert_eq!(
            resolve_stored_content("video/MP4"),
            ("video/mp4".to_owned(), false)
        );
        assert_eq!(
            resolve_stored_content("text/html"),
            ("application/octet-stream".to_owned(), true)
        );
        assert_eq!(
            resolve_stored_content("image/svg+xml"),
            ("application/octet-stream".to_owned(), true)
        );
    }

    #[test]
    fn tracked_fields_and_changes() {
        assert_eq!(tags_to_spaces("<p>a</p><>b"), " a <>b");
        let old = tracked_file_fields(&json!({
            "fileName": "a.txt", "isStarred": false, "isPublic": false,
            "generalAccess": "workspace_edit", "metadata": null
        }));
        let new = tracked_file_fields(&json!({
            "fileName": "b.txt", "isStarred": false, "isPublic": false,
            "generalAccess": "workspace_edit",
            "metadata": { "description": "<p>Hello</p>\n<p>world</p>" }
        }));
        let changes = compute_changes(&old, &new).expect("changes");
        assert_eq!(changes["name"], json!({ "old": "a.txt", "new": "b.txt" }));
        assert_eq!(changes["description"]["new"], "Hello world");
        assert!(compute_changes(&old, &old).is_none());
    }
}
