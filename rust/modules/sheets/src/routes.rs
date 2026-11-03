//! Spreadsheet routes (`routes/sheets/index.ts`, `access.ts` and `download.ts`).

use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    FILE_CREATED, FILE_DELETED, FILE_UPDATED, SHEET_CREATED, SHEET_DELETED, SHEET_UPDATED,
};
use weldsuite_catalogs::permission_keys::PROJECTS_SCOPE_ALL;
use weldsuite_core_domain::drive_access::{
    DriveRole, can_edit, container_role, file_role, load_drive_access_for_user, visible_files,
};
use weldsuite_core_domain::files::{
    Change, FileUpdate, NewFile, UpdatedFile, create_file, soft_delete_file, update_file,
};
use weldsuite_flow_domain::access::resolve_project_access;
use weldsuite_kit::validation::{Number, Presence, Text, js_number, js_trim};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_ports::collab::{bytes_value, value_bytes};
use weldsuite_ports::files::{PutOptions, get_stored};

use crate::records::{
    self, AdoptFile, DriveFileRecord, ListSheets, PROJECT_ENTITY, SheetRecord, WELDSHEET_MIME_TYPE,
    member_profile, room_name, snapshot_key_for,
};
use crate::{Caller, Refusal, SheetsState, answer, color_for, now, validate, validate_query};

pub(crate) const VIEW_ONLY: &str = "You can view this spreadsheet but not change it";
const DEFAULT_LIMIT: i64 = 50;
const UNTITLED: &str = "Untitled spreadsheet";
/// `SHEET_IMPORT_MAX_BYTES`.
const IMPORT_MAX_BYTES: f64 = 25.0 * 1024.0 * 1024.0;
/// Room for the multipart envelope around the largest file.
const MULTIPART_SLACK: f64 = 64.0 * 1024.0;
pub(crate) const XLSX_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const LOCALES: [&str; 2] = ["en", "nl"];

// ── access ──────────────────────────────────────────────────────────────────

/// `projectRole(c, projectId, role)`: a project's sheet follows the project.
pub(crate) async fn project_role(
    caller: &Caller,
    project_id: &str,
    role: DriveRole,
) -> Result<Option<DriveRole>, Refusal> {
    let access = resolve_project_access(
        &caller.db,
        Some(&caller.user_id),
        caller.can(PROJECTS_SCOPE_ALL),
        project_id,
    )
    .await?;
    if !access.may_access() {
        return Ok(None);
    }
    Ok(Some(if access.can_write {
        role
    } else {
        DriveRole::Viewer
    }))
}

/// The sheet with the caller's role on it, or the 404 (`findSheet`).
pub(crate) async fn find_sheet(
    caller: &Caller,
    id: &str,
) -> Result<(SheetRecord, DriveRole), Refusal> {
    let Some(sheet) = records::get_sheet(&caller.db, id).await? else {
        return Err(Refusal::not_found("Spreadsheet", id));
    };
    let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
    let mut role = file_role(&access, &sheet.file);
    if let (Some(project_id), Some(found)) = (sheet.project_id.as_deref(), role) {
        role = project_role(caller, project_id, found).await?;
    }
    match role {
        Some(role) => Ok((sheet, role)),
        None => Err(Refusal::not_found("Spreadsheet", id)),
    }
}

/// The sheet, if the caller may change it (`editableSheet`).
pub(crate) async fn editable_sheet(caller: &Caller, id: &str) -> Result<SheetRecord, Refusal> {
    let (sheet, role) = find_sheet(caller, id).await?;
    if !caller.may_edit(role) {
        return Err(Refusal::forbidden(VIEW_ONLY));
    }
    Ok(sheet)
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

/// A live project the caller may add work to (`writableProject`).
async fn writable_project(caller: &Caller, project_id: &str) -> Result<String, Refusal> {
    let scope_all = caller.can(PROJECTS_SCOPE_ALL);
    let access =
        resolve_project_access(&caller.db, Some(&caller.user_id), scope_all, project_id).await?;
    let live: Option<String> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(project_id)
            .fetch_optional(&caller.db)
            .await?;
    if live.is_none()
        || access.deleted
        || !(access.scope_all || access.is_manager || access.is_member)
    {
        return Err(Refusal::not_found("Project", project_id));
    }
    if !access.can_write {
        return Err(Refusal::forbidden(
            "You can view this project but not add to it",
        ));
    }
    Ok(project_id.to_owned())
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

/// JavaScript's `text.slice(0, n)`, in UTF-16 units.
fn js_slice(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let (search, limit, cursor, project_id) =
                validate_query(raw.as_deref(), |issues, query| {
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
                    let project_id =
                        issues.text(query, "projectId", Presence::Optional, Some(1), Some(255));
                    (
                        search.into_option(),
                        limit.into_option(),
                        cursor.into_option(),
                        project_id.into_option(),
                    )
                })?;
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
            let offset = cursor
                .as_deref()
                .map_or(0, |c| c.parse::<i64>().unwrap_or(i64::MAX));
            // A project's sheets are its members': the project decides, not the drive.
            let project_as = match project_id.as_deref() {
                Some(project_id) => {
                    match project_role(&caller, project_id, DriveRole::Editor).await? {
                        Some(role) => Some(role),
                        None => return Err(Refusal::not_found("Project", project_id)),
                    }
                }
                None => None,
            };
            let params = ListSheets {
                visible: if project_id.is_some() {
                    None
                } else {
                    visible_files(&access)
                },
                search: search
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("%{}%", escape_like(&s))),
                project_id,
                limit: limit.unwrap_or(DEFAULT_LIMIT),
                offset,
            };
            let (rows, total) = records::list_sheets(&caller.db, &params).await?;
            let may_edit = caller.may_update();
            let next = offset + i64::try_from(rows.len()).unwrap_or(0);
            let data = rows
                .iter()
                .map(|sheet| {
                    let role = project_as
                        .or_else(|| file_role(&access, &sheet.file))
                        .unwrap_or(DriveRole::Viewer);
                    sheet.summary(role, may_edit)
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

struct CreateBody {
    name: String,
    folder_id: Option<String>,
    first_tab_name: Option<String>,
    project_id: Option<String>,
    copy_from: Option<String>,
}

pub(crate) async fn create(
    State(state): State<SheetsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, body| CreateBody {
                name: issues
                    .text_with(
                        body,
                        "name",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(255)),
                    )
                    .into_option()
                    .unwrap_or_default(),
                folder_id: issues
                    .text(body, "folderId", Presence::Nullish, None, None)
                    .into_option(),
                first_tab_name: issues
                    .text_with(
                        body,
                        "firstTabName",
                        Presence::Optional,
                        Text::trimmed(Some(1), Some(100)),
                    )
                    .into_option(),
                project_id: issues
                    .text(body, "projectId", Presence::Optional, Some(1), Some(255))
                    .into_option(),
                copy_from: issues
                    .text(
                        body,
                        "copyFromSheetId",
                        Presence::Optional,
                        Some(1),
                        Some(255),
                    )
                    .into_option(),
            })?;
            let org = caller.org()?.to_owned();
            let project = match input.project_id.as_deref().filter(|p| !p.is_empty()) {
                Some(project_id) => Some(writable_project(&caller, project_id).await?),
                None => None,
            };
            let folder = if project.is_some() {
                None
            } else {
                editable_folder(&caller, input.folder_id.as_deref()).await?
            };
            let copy_json = match input.copy_from.as_deref().filter(|c| !c.is_empty()) {
                Some(source_id) => Some(live_json(&state, &caller, &org, source_id).await?),
                None => None,
            };
            let made = caller
                .engine(&state, "newSheet", json!([input.first_tab_name, copy_json]))
                .await?;
            let checkpoint = engine_checkpoint(&made)?;
            let sheet = save_new_sheet(
                &state,
                &caller,
                NewSheet {
                    org: &org,
                    name: input.name,
                    folder,
                    project,
                    checkpoint,
                },
            )
            .await?;
            Ok(Created(sheet.summary(DriveRole::Owner, caller.may_update())).into_response())
        }
        .await,
    )
}

/// Another sheet's workbook as its room holds it now, as JSON (`copyOf`'s read).
async fn live_json(
    state: &SheetsState,
    caller: &Caller,
    org: &str,
    source_id: &str,
) -> Result<String, Refusal> {
    let (source, _) = find_sheet(caller, source_id).await?;
    let live = caller
        .room(
            state,
            &room_name(org, &source.id),
            "snapshot",
            json!([source.room_meta(org)]),
        )
        .await?;
    Ok(live["json"].as_str().unwrap_or("null").to_owned())
}

/// The gzipped checkpoint an engine function made.
fn engine_checkpoint(made: &Value) -> Result<Vec<u8>, Refusal> {
    value_bytes(&made["checkpoint"]).ok_or_else(|| {
        tracing::error!("[sheets-api] the engine answered without a checkpoint");
        ApiError::internal().into()
    })
}

pub(crate) struct NewSheet<'a> {
    pub(crate) org: &'a str,
    pub(crate) name: String,
    pub(crate) folder: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) checkpoint: Vec<u8>,
}

/// Writes a checkpoint as `writeSnapshot` does; its size.
async fn write_checkpoint(
    state: &SheetsState,
    caller: &Caller,
    key: &str,
    checkpoint: Vec<u8>,
) -> Result<i64, Refusal> {
    let size = i64::try_from(checkpoint.len()).unwrap_or(i64::MAX);
    let files = caller.files(state)?;
    let options = PutOptions::content_type("application/gzip").with_metadata("revision", "0");
    files
        .private
        .put_boxed(key, checkpoint, &options)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[sheets-api] writing a checkpoint failed");
            Refusal::from(ApiError::internal())
        })?;
    Ok(size)
}

/// Stores a new sheet from its first checkpoint: the checkpoint first, so a
/// room never opens a sheet without one, then its drive file and row, and
/// reports both (`saveNewSheet`).
pub(crate) async fn save_new_sheet(
    state: &SheetsState,
    caller: &Caller,
    new: NewSheet<'_>,
) -> Result<SheetRecord, Refusal> {
    let sheet_id = generate_id("sht");
    let key = snapshot_key_for(new.org, &sheet_id);
    let size = write_checkpoint(state, caller, &key, new.checkpoint).await?;
    let now = now();
    let (entity_type, entity_id) = match new.project {
        Some(project) => (Some(PROJECT_ENTITY.to_owned()), Some(project)),
        None => (None, None),
    };
    let file = create_file(
        &caller.db,
        &NewFile {
            file_name: new.name.clone(),
            original_name: Some(new.name),
            mime_type: WELDSHEET_MIME_TYPE.to_owned(),
            file_size: size,
            file_type: Some("spreadsheet".to_owned()),
            storage_path: key.clone(),
            file_key: Some(key.clone()),
            bucket: Some("private".to_owned()),
            folder_id: new.folder,
            metadata: Some(json!({ "weldsheetId": sheet_id })),
            uploaded_by_id: caller.user_id.clone(),
            entity_type,
            entity_id,
            ..NewFile::default()
        },
        &now,
    )
    .await?;
    let file_id = file["id"].as_str().unwrap_or_default().to_owned();
    records::insert_sheet(&caller.db, &sheet_id, &file_id, &key, &caller.user_id, &now).await?;
    let Some(created) = records::get_sheet(&caller.db, &sheet_id).await? else {
        tracing::error!(sheet_id, "[sheets-api] a sheet vanished after insert");
        return Err(ApiError::internal().into());
    };
    let mut file_data = created.file_event_data();
    file_data["fileSize"] = json!(size);
    caller.publish(state, FILE_CREATED, &created.file_id, &file_data);
    caller.publish(state, SHEET_CREATED, &created.id, &created.event_data());
    Ok(created)
}

// ── POST /import ────────────────────────────────────────────────────────────

/// What an import reads (`ImportSource`).
struct ImportSource {
    bytes: Vec<u8>,
    file_name: String,
    name: Option<String>,
    folder_id: Option<String>,
    folder_asked: bool,
    locale: Option<String>,
}

fn too_large() -> Refusal {
    let mb = (IMPORT_MAX_BYTES / 1024.0 / 1024.0).round();
    ApiError::bad_request(format!("Files up to {mb} MB can be imported"))
        .with_details(json!({ "reason": "too_large" }))
        .into()
}

/// A field of the form as Hono's `parseBody` keeps it: the last one of a name.
enum FormValue {
    Text(String),
    File { name: String, bytes: Vec<u8> },
}

/// The form as Hono's `parseBody` reads it: the last field of each name.
async fn form_fields(headers: HeaderMap, body: Bytes) -> Result<Vec<(String, FormValue)>, Refusal> {
    let unreadable = |error: &dyn std::fmt::Display| {
        tracing::error!(%error, "[sheets-api] a multipart body does not read");
        Refusal::from(ApiError::internal())
    };
    let mut request = Request::new(Body::from(body));
    *request.headers_mut() = headers;
    let mut multipart = Multipart::from_request(request, &())
        .await
        .map_err(|error| unreadable(&error))?;
    let mut fields: Vec<(String, FormValue)> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| unreadable(&error))?
    {
        let key = field.name().unwrap_or_default().to_owned();
        let file_name = field.file_name().map(str::to_owned);
        let bytes = field.bytes().await.map_err(|error| unreadable(&error))?;
        let value = match file_name {
            Some(name) => FormValue::File {
                name,
                bytes: bytes.to_vec(),
            },
            None => FormValue::Text(String::from_utf8_lossy(&bytes).into_owned()),
        };
        fields.retain(|(k, _)| *k != key);
        fields.push((key, value));
    }
    Ok(fields)
}

/// An upload (`uploadSource`).
fn upload_source(mut form: Vec<(String, FormValue)>) -> Result<ImportSource, Refusal> {
    let text = |form: &[(String, FormValue)], key: &str| {
        form.iter().find_map(|(k, value)| match value {
            FormValue::Text(text) if k == key => Some(text.clone()),
            _ => None,
        })
    };
    let name = text(&form, "name")
        .map(|name| js_slice(js_trim(&name), 255))
        .unwrap_or_default();
    let folder_id = text(&form, "folderId").filter(|id| !id.is_empty());
    let locale = text(&form, "locale").filter(|locale| LOCALES.contains(&locale.as_str()));
    let file = form
        .iter()
        .position(|(k, value)| k == "file" && matches!(value, FormValue::File { .. }))
        .map(|at| form.swap_remove(at).1);
    let Some(FormValue::File {
        name: file_name,
        bytes,
    }) = file
    else {
        return Err(ApiError::bad_request("Add the file to import as \"file\"").into());
    };
    #[allow(clippy::cast_precision_loss)]
    if bytes.len() as f64 > IMPORT_MAX_BYTES {
        return Err(too_large());
    }
    Ok(ImportSource {
        bytes,
        file_name,
        name: (!name.is_empty()).then_some(name),
        folder_id,
        folder_asked: true,
        locale,
    })
}

/// `importDriveFileSchema.safeParse(body)`, refused with `error.flatten()`.
struct DriveImport {
    file_id: String,
    name: Option<String>,
    /// Absent, or set (to a folder or null).
    folder_id: Option<Option<String>>,
    locale: Option<String>,
}

fn drive_import(body: &Bytes) -> Result<DriveImport, Refusal> {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let mut issues = weldsuite_kit::validation::Issues::default();
    let read = issues.object(&parsed).map(|fields| {
        let file_id = issues
            .text(fields, "fileId", Presence::Required, Some(1), None)
            .into_option();
        let name = issues
            .text_with(
                fields,
                "name",
                Presence::Optional,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option();
        let folder_id = match issues.text(fields, "folderId", Presence::Nullish, None, None) {
            weldsuite_kit::validation::Field::Set(id) => Some(Some(id)),
            weldsuite_kit::validation::Field::Null => Some(None),
            weldsuite_kit::validation::Field::Absent => None,
        };
        let locale = issues
            .choice(fields, "locale", Presence::Optional, &LOCALES)
            .into_option();
        DriveImport {
            file_id: file_id.unwrap_or_default(),
            name,
            folder_id,
            locale,
        }
    });
    match (issues.finish(), read) {
        (Ok(()), Some(read)) => Ok(read),
        (Err(invalid), _) => Err(ApiError::bad_request(
            "Send a file, or the id of a WeldDrive file",
        )
        .with_details(invalid.flatten())
        .into()),
        (Ok(()), None) => Err(ApiError::internal().into()),
    }
}

/// `isWorkspaceObjectKey(key, workspaceId)`.
fn is_workspace_object_key(key: &str, workspace: &str) -> bool {
    if !weldsuite_ports::is_safe_key(key) {
        return false;
    }
    let mut parts = key.split('/');
    if parts.next() != Some("workspaces") {
        return false;
    }
    let owner = parts.next().unwrap_or_default();
    parts.next().is_some()
        && !owner.is_empty()
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && owner == workspace
}

/// A drive file's bytes from either bucket (`getStoredObject`).
async fn stored_bytes(
    state: &SheetsState,
    caller: &Caller,
    key: &str,
) -> Result<Option<Vec<u8>>, Refusal> {
    let files = caller.files(state)?;
    let object = get_stored(files.private.as_ref(), files.public.as_deref(), key)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[sheets-api] reading a drive file failed");
            Refusal::from(ApiError::internal())
        })?;
    Ok(object.map(|object| object.bytes))
}

async fn drive_source(
    state: &SheetsState,
    caller: &Caller,
    org: &str,
    input: DriveImport,
) -> Result<ImportSource, Refusal> {
    let file = records::get_drive_file(&caller.db, &input.file_id).await?;
    let role = match &file {
        Some(file) => {
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
            file_role(&access, &file.file)
        }
        None => None,
    };
    let (Some(file), Some(_)) = (file, role) else {
        return Err(Refusal::not_found("File", &input.file_id));
    };
    if file.weldsheet_id.is_some() {
        return Err(ApiError::bad_request("This file is already a spreadsheet")
            .with_details(json!({ "reason": "unsupported" }))
            .into());
    }
    #[allow(clippy::cast_precision_loss)]
    if file.size as f64 > IMPORT_MAX_BYTES {
        return Err(too_large());
    }
    // A row's key came from a client: never let it reach another workspace's objects.
    if file.key.is_empty() || !is_workspace_object_key(&file.key, org) {
        return Err(Refusal::not_found("File content", &input.file_id));
    }
    let Some(bytes) = stored_bytes(state, caller, &file.key).await? else {
        return Err(Refusal::not_found("File content", &input.file_id));
    };
    let asked = input.folder_id.is_some();
    Ok(ImportSource {
        bytes,
        file_name: file.name,
        name: input.name,
        folder_id: match input.folder_id {
            Some(folder) => folder,
            None => file.file.folder_id,
        },
        folder_asked: asked,
        locale: input.locale,
    })
}

/// The name of an imported sheet: asked for, or the file's without its extension.
fn import_name(source: &ImportSource) -> String {
    let base = match source.name.as_deref().filter(|n| !n.is_empty()) {
        Some(name) => name.to_owned(),
        None => match source.file_name.rfind('.') {
            Some(dot) if !source.file_name[dot + 1..].is_empty() => {
                source.file_name[..dot].to_owned()
            }
            _ => source.file_name.clone(),
        },
    };
    let name = js_slice(js_trim(&base), 255);
    if name.is_empty() {
        UNTITLED.to_owned()
    } else {
        name
    }
}

pub(crate) async fn import(
    State(state): State<SheetsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let length = headers
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .map_or(f64::NAN, js_number);
            if length > IMPORT_MAX_BYTES + MULTIPART_SLACK {
                return Err(too_large());
            }
            let multipart = headers
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("multipart/form-data"));
            let source = if multipart {
                upload_source(form_fields(headers, body).await?)?
            } else {
                let input = drive_import(&body)?;
                drive_source(&state, &caller, &org, input).await?
            };
            // The folder asked for (which must be editable), else the source's when it is.
            let folder = match editable_folder(&caller, source.folder_id.as_deref()).await {
                Ok(folder) => folder,
                Err(_) if !source.folder_asked => None,
                Err(refusal) => return Err(refusal),
            };
            let read = caller
                .engine(
                    &state,
                    "importFile",
                    json!([source.file_name, bytes_value(&source.bytes), source.locale]),
                )
                .await?;
            if read["ok"] != Value::Bool(true) {
                return Err(engine_refusal(&read));
            }
            let checkpoint = engine_checkpoint(&read)?;
            let name = import_name(&source);
            let sheet = save_new_sheet(
                &state,
                &caller,
                NewSheet {
                    org: &org,
                    name,
                    folder,
                    project: None,
                    checkpoint,
                },
            )
            .await?;
            Ok(Created(json!({
                "sheet": sheet.summary(DriveRole::Owner, caller.may_update()),
                "warnings": read["warnings"],
            }))
            .into_response())
        }
        .await,
    )
}

/// An engine's `{ ok: false, message, reason }` as the route's 400.
fn engine_refusal(read: &Value) -> Refusal {
    ApiError::bad_request(read["message"].as_str().unwrap_or_default())
        .with_details(json!({ "reason": read["reason"] }))
        .into()
}

// ── POST /convert ───────────────────────────────────────────────────────────

pub(crate) async fn convert(
    State(state): State<SheetsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (file_id, first_tab_name) = validate(&headers, &body, |issues, body| {
                let file_id = issues
                    .text(body, "fileId", Presence::Required, Some(1), Some(255))
                    .into_option();
                let first_tab_name = issues
                    .text_with(
                        body,
                        "firstTabName",
                        Presence::Optional,
                        Text::trimmed(Some(1), Some(100)),
                    )
                    .into_option();
                (file_id.unwrap_or_default(), first_tab_name)
            })?;
            let org = caller.org()?.to_owned();
            let file = records::get_drive_file(&caller.db, &file_id).await?;
            let Some(file) =
                file.filter(|f| f.project_id.is_some() && f.file_type == "spreadsheet")
            else {
                return Err(Refusal::not_found("Project sheet", &file_id));
            };
            let project_id = file.project_id.clone().unwrap_or_default();
            let access = load_drive_access_for_user(&caller.db, Some(&caller.user_id)).await?;
            let drive_role = file_role(&access, &file.file).unwrap_or(DriveRole::Viewer);
            let Some(role) = project_role(&caller, &project_id, drive_role).await? else {
                return Err(Refusal::not_found("Project sheet", &file_id));
            };
            let may_edit = caller.may_update();
            if let Some(sheet_id) = &file.weldsheet_id {
                return match records::get_sheet(&caller.db, sheet_id).await? {
                    Some(existing) => Ok(Data(existing.summary(role, may_edit)).into_response()),
                    None => Err(Refusal::not_found("Project sheet", &file_id)),
                };
            }
            let made = legacy_workbook(&state, &caller, &org, &file, first_tab_name).await?;
            let sheet_id = generate_id("sht");
            let key = snapshot_key_for(&org, &sheet_id);
            let size = write_checkpoint(&state, &caller, &key, made).await?;
            let name = {
                let trimmed = strip_xlsx(&file.name);
                let name = js_slice(js_trim(trimmed), 255);
                if name.is_empty() {
                    UNTITLED.to_owned()
                } else {
                    name
                }
            };
            let adopted = records::adopt_file_as_sheet(
                &caller.db,
                &AdoptFile {
                    file_id: &file_id,
                    sheet_id: &sheet_id,
                    snapshot_key: &key,
                    name: &name,
                    snapshot_size: size,
                    user_id: &caller.user_id,
                    old_key: &file.key,
                },
                &now(),
            )
            .await?;
            let Some(sheet) = adopted else {
                // Someone else converted it meanwhile: theirs it is.
                let files = caller.files(&state)?;
                if let Err(error) = files.private.delete_boxed(&key).await {
                    tracing::error!(%error, "[sheets-api] removing a lost conversion failed");
                    return Err(ApiError::internal().into());
                }
                let winner = records::get_drive_file(&caller.db, &file_id).await?;
                let existing = match winner.and_then(|w| w.weldsheet_id) {
                    Some(id) => records::get_sheet(&caller.db, &id).await?,
                    None => None,
                };
                return match existing {
                    Some(existing) => Ok(Data(existing.summary(role, may_edit)).into_response()),
                    None => Err(Refusal::not_found("Project sheet", &file_id)),
                };
            };
            let mut file_data = sheet.file_event_data();
            file_data["fileSize"] = json!(size);
            caller.publish(&state, FILE_UPDATED, &sheet.file_id, &file_data);
            caller.publish(&state, SHEET_CREATED, &sheet.id, &sheet.event_data());
            Ok(Created(sheet.summary(role, may_edit)).into_response())
        }
        .await,
    )
}

/// `name.replace(/\.xlsx$/i, '')`.
fn strip_xlsx(name: &str) -> &str {
    let cut = name.len().saturating_sub(5);
    match name.get(cut..) {
        Some(tail) if tail.eq_ignore_ascii_case(".xlsx") => &name[..cut],
        _ => name,
    }
}

/// What an old project sheet's file holds, as a checkpoint (`legacyWorkbook`).
async fn legacy_workbook(
    state: &SheetsState,
    caller: &Caller,
    org: &str,
    file: &DriveFileRecord,
    first_tab_name: Option<String>,
) -> Result<Vec<u8>, Refusal> {
    // A row's key came from a client: never let it reach another workspace's objects.
    let bytes = if !file.key.is_empty() && is_workspace_object_key(&file.key, org) {
        stored_bytes(state, caller, &file.key).await?
    } else {
        None
    };
    let made = caller
        .engine(
            state,
            "convertLegacy",
            json!([
                file.name,
                bytes.as_deref().map(bytes_value),
                first_tab_name.as_deref().unwrap_or("Sheet1"),
            ]),
        )
        .await?;
    if made["ok"] != Value::Bool(true) {
        return Err(engine_refusal(&made));
    }
    engine_checkpoint(&made)
}

// ── GET /:id/export ─────────────────────────────────────────────────────────

/// `attachment(fileName)`: an ASCII fallback name and the real one (RFC 6266).
pub(crate) fn attachment(file_name: &str) -> String {
    let ascii: String = file_name
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(b'"') => '\'',
            Ok(byte @ 0x20..=0x7e) => char::from(byte),
            _ => '_',
        })
        .collect();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        weldsuite_kit::cursor::encode_uri_component(file_name)
    )
}

/// A download's response, with the routes' headers.
pub(crate) fn download(bytes: Vec<u8>, content_type: &'static str, file_name: &str) -> Response {
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(value) = HeaderValue::from_str(&attachment(file_name)) {
        headers.insert(CONTENT_DISPOSITION, value);
    }
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(
        http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

pub(crate) async fn export(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (format, tab, locale) = validate_query(raw.as_deref(), |issues, query| {
                let format = issues.choice(query, "format", Presence::Optional, &["xlsx", "csv"]);
                let tab = issues.text(query, "tab", Presence::Optional, Some(1), Some(64));
                let locale = issues.choice(query, "locale", Presence::Optional, &LOCALES);
                (
                    format.into_option().unwrap_or_else(|| "xlsx".to_owned()),
                    tab.into_option(),
                    locale.into_option(),
                )
            })?;
            let org = caller.org()?.to_owned();
            let (sheet, _) = find_sheet(&caller, &id).await?;
            let mut request = Map::new();
            request.insert("format".into(), json!(format));
            if let Some(tab) = &tab {
                request.insert("tab".into(), json!(tab));
            }
            if let Some(locale) = &locale {
                request.insert("locale".into(), json!(locale));
            }
            let file = caller
                .room(
                    &state,
                    &room_name(&org, &sheet.id),
                    "exportFile",
                    json!([sheet.room_meta(&org), request]),
                )
                .await?;
            if file.is_null() {
                return Err(ApiError::not_found("Tab", tab.as_deref()).into());
            }
            let bytes = value_bytes(&file["bytes"]).unwrap_or_default();
            let file_name = match file["tabName"].as_str() {
                Some(tab_name) => format!("{} - {tab_name}.{format}", sheet.name),
                None => format!("{}.{format}", sheet.name),
            };
            let content_type = if format == "csv" {
                "text/csv; charset=utf-8"
            } else {
                XLSX_TYPE
            };
            Ok(download(bytes, content_type, &file_name))
        }
        .await,
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let (sheet, role) = find_sheet(&caller, &id).await?;
            Ok(Data(sheet.summary(role, caller.may_update())).into_response())
        }
        .await,
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let name = validate(&headers, &body, |issues, body| {
                issues
                    .text_with(
                        body,
                        "name",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(255)),
                    )
                    .into_option()
                    .unwrap_or_default()
            })?;
            let (found, role) = find_sheet(&caller, &id).await?;
            if !can_edit(Some(role)) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            let update = FileUpdate {
                file_name: Change::Set(name),
                ..FileUpdate::default()
            };
            match update_file(&caller.db, &found.file_id, &update, &now()).await? {
                UpdatedFile::Updated { .. } => {}
                UpdatedFile::NameConflict => {
                    return Err(ApiError::conflict(
                        "A file with this name already exists in this folder",
                    )
                    .into());
                }
                UpdatedFile::NotFound => return Err(Refusal::not_found("Spreadsheet", &found.id)),
            }
            let Some(sheet) = records::get_sheet(&caller.db, &found.id).await? else {
                return Err(Refusal::not_found("Spreadsheet", &found.id));
            };
            let changes = || {
                let mut changes = Map::new();
                changes.insert(
                    "name".into(),
                    json!({ "old": found.name, "new": sheet.name }),
                );
                changes
            };
            caller.publish_changes(
                &state,
                FILE_UPDATED,
                &sheet.file_id,
                &sheet.file_event_data(),
                changes(),
            );
            caller.publish_changes(
                &state,
                SHEET_UPDATED,
                &sheet.id,
                &sheet.event_data(),
                changes(),
            );
            Ok(Data(sheet.summary(role, true)).into_response())
        }
        .await,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let (sheet, role) = find_sheet(&caller, &id).await?;
            if !can_edit(Some(role)) {
                return Err(Refusal::forbidden(VIEW_ONLY));
            }
            if soft_delete_file(&caller.db, &sheet.file_id, &now())
                .await?
                .is_none()
            {
                return Err(Refusal::not_found("Spreadsheet", &sheet.id));
            }
            caller.publish(
                &state,
                FILE_DELETED,
                &sheet.file_id,
                &sheet.file_event_data(),
            );
            caller.publish(&state, SHEET_DELETED, &sheet.id, &sheet.event_data());
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── POST /:id/session ───────────────────────────────────────────────────────

pub(crate) async fn session(
    State(state): State<SheetsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let org = caller.org()?.to_owned();
            let (sheet, role) = find_sheet(&caller, &id).await?;
            // Edit (owner or editor with sheets:update), comment (anyone else
            // who may see it, with sheets:comment), or only view.
            let mode = if caller.may_edit(role) {
                "edit"
            } else if caller.may_comment() {
                "comment"
            } else {
                "view"
            };
            let (name, picture) = member_profile(&caller.db, &caller.user_id).await?;
            let color = color_for(&caller.user_id);
            let mut admission = sheet.room_meta(&org);
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
                    &room_name(&org, &sheet.id),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_name_the_file_twice() {
        assert_eq!(
            attachment("Budget.xlsx"),
            "attachment; filename=\"Budget.xlsx\"; filename*=UTF-8''Budget.xlsx"
        );
        assert_eq!(
            attachment("Budget - Blad 2.csv"),
            "attachment; filename=\"Budget - Blad 2.csv\"; filename*=UTF-8''Budget%20-%20Blad%202.csv"
        );
        assert_eq!(
            attachment("Café \"x\" 😀.xlsx"),
            "attachment; filename=\"Caf_ 'x' __.xlsx\"; filename*=UTF-8''Caf%C3%A9%20%22x%22%20%F0%9F%98%80.xlsx"
        );
    }

    #[test]
    fn names_follow_javascript() {
        assert_eq!(strip_xlsx("Tasks.XLSX"), "Tasks");
        assert_eq!(strip_xlsx("Tasks.csv"), "Tasks.csv");
        assert!(is_workspace_object_key(
            "workspaces/org_1/files/a.xlsx",
            "org_1"
        ));
        assert!(!is_workspace_object_key(
            "workspaces/org_2/files/a.xlsx",
            "org_1"
        ));
        assert!(!is_workspace_object_key("workspaces/org_1", "org_1"));
        let source = |name: Option<&str>, file: &str| ImportSource {
            bytes: Vec::new(),
            file_name: file.to_owned(),
            name: name.map(str::to_owned),
            folder_id: None,
            folder_asked: false,
            locale: None,
        };
        assert_eq!(
            import_name(&source(None, "Budget 2027.xlsx")),
            "Budget 2027"
        );
        assert_eq!(import_name(&source(Some("Prijzen"), "p.csv")), "Prijzen");
        assert_eq!(import_name(&source(None, ".xlsx")), UNTITLED);
        assert_eq!(import_name(&source(None, "noext")), "noext");
        assert_eq!(import_name(&source(None, "trailing.")), "trailing.");
    }
}
