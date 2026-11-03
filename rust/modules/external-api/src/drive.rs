//! WeldDrive's objects: `/v1/files` (metadata, plus `GET /:id/content` to
//! download the stored object), `/v1/folders` and the read-only `/v1/drive`
//! aggregations (`routes/v1/{files,folders,drive}/index.ts`), on the drive
//! sharing rules (`weldsuite_core_domain::drive_access`): a workspace key
//! sees what is not restricted, a user token what that person may open. An
//! item the caller cannot see is a 404.
//!
//! A file's `storagePath` / `fileKey` must be under this workspace's own
//! `workspaces/<id>/` prefix: checked on create, and again before a download.

use std::fmt::Write as _;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Extension, Path, RawQuery, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    FILE_CREATED, FILE_DELETED, FILE_UPDATED, FOLDER_CREATED, FOLDER_DELETED, FOLDER_UPDATED,
};
use weldsuite_core_domain::drive_access::{
    DriveAccessIndex, DriveFile, DriveRole, can_edit, container_role, file_role, folder_role,
    load_drive_access_for_user, visible_files, visible_folder_ids,
};
use weldsuite_core_domain::folders::check_folder_parent;
use weldsuite_kit::id::generate_id;
use weldsuite_ports::{DynFileStore, StorageBuckets, StoredObject};

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, field, like, no_content, now, ok, soft_delete,
    table_list_sql, text, with_updated,
};
use crate::list::{ListQuery, clamp_limit, list_page_mapped};
use crate::schemas::LIST_DRIVE_ALL;
use crate::schemas_gen::{
    CREATE_FILE, CREATE_FOLDER, LIST_FILES, LIST_FOLDERS, UPDATE_FILE, UPDATE_FOLDER,
};
use crate::session::{bad_request, forbidden, internal_with, not_found};
use crate::simple::scoped;
use crate::tables_gen::{FILES, FOLDERS};
use crate::zod;

type S = State<ExternalApiState>;
/// The test's buckets in conformance builds (`StorageBuckets`), else none.
type Buckets = Option<Extension<StorageBuckets>>;

/// Drive's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/files",
            scoped(get(list_files), "files:read").merge(scoped(post(create_file), "files:write")),
        )
        .route(
            "/files/{id}",
            scoped(get(get_file), "files:read").merge(scoped(
                patch(update_file).delete(delete_file),
                "files:write",
            )),
        )
        .route(
            "/files/{id}/content",
            scoped(get(file_content), "files:read"),
        )
        .route(
            "/folders",
            scoped(get(list_folders), "folders:read")
                .merge(scoped(post(create_folder), "folders:write")),
        )
        .route(
            "/folders/{id}",
            scoped(get(get_folder), "folders:read").merge(scoped(
                patch(update_folder).delete(delete_folder),
                "folders:write",
            )),
        )
        .route("/drive/all", scoped(get(drive_all), "drive:read"))
        .route("/drive/stats", scoped(get(drive_stats), "drive:read"))
}

const VIEW_ONLY: &str = "You can view this item but not change it";

/// A bucket, when the deployment (or the test) has it.
type Store = Option<Arc<dyn DynFileStore>>;

/// The private and public buckets for this request.
fn buckets(state: &ExternalApiState, request: Buckets) -> (Store, Store) {
    match request {
        Some(Extension(buckets)) => (buckets.private, buckets.public),
        // Without the private store (a conformance build, whose tests bring
        // their buckets) there is no file storage, as for a worker without
        // either binding.
        None => (
            state.files.clone(),
            state.files.as_ref().and(state.public_files.clone()),
        ),
    }
}

async fn access(caller: &Caller) -> Result<DriveAccessIndex, Fail> {
    Ok(load_drive_access_for_user(&caller.db, caller.session.user_id.as_deref()).await?)
}

/// `checkDestination(c, access, folderId)`: a refusal, unless the caller may
/// put an item in `folder_id` (none: My Drive).
fn check_destination(index: &DriveAccessIndex, folder_id: Option<&str>) -> Result<(), Fail> {
    let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Some(role) = container_role(index, Some(folder_id)) else {
        return Err(not_found("Folder", folder_id).into());
    };
    if can_edit(Some(role)) {
        Ok(())
    } else {
        Err(forbidden(VIEW_ONLY).into())
    }
}

/// `isOwnKey(c, key)`: one of this workspace's objects, keyed by the Clerk
/// org id or by `workspaces.id`.
fn is_own_key(caller: &Caller, key: &str) -> bool {
    let session = &caller.session;
    weldsuite_ports::is_safe_key(key)
        && workspace_of_key(key).is_some_and(|owner| {
            owner == session.workspace_id || session.clerk_org_id.as_deref() == Some(owner)
        })
}

/// `workspaceOfKey(key)`: `workspaces/<id>/…`'s id.
fn workspace_of_key(key: &str) -> Option<&str> {
    let mut parts = key.split('/');
    if parts.next() != Some("workspaces") {
        return None;
    }
    let id = parts.next()?;
    parts.next()?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

/// The visibility of `files t` as a list filter (`visibleFilesCondition`).
fn visibility(index: &DriveAccessIndex) -> Value {
    match visible_files(index) {
        None => json!({ "admin": true }),
        Some(visible) => json!({
            "admin": false,
            "user": visible.user_id,
            "shares": visible.file_share_ids,
            "granted": visible.granted_folder_ids,
            "open": visible.open_folder_ids,
        }),
    }
}

/// `visibleFilesCondition` on `files t`, from `$3->'visible'`.
macro_rules! visible_files_sql {
    () => {
        "(($3->'visible'->>'admin')::boolean or t.entity_type is not null \
          or ($3->'visible'->>'user' is not null and t.uploaded_by_id = $3->'visible'->>'user') \
          or t.id in (select jsonb_array_elements_text($3->'visible'->'shares')) \
          or t.folder_id in (select jsonb_array_elements_text($3->'visible'->'granted')) \
          or (t.general_access <> 'restricted' \
              and (t.folder_id is null or t.folder_id in (select jsonb_array_elements_text($3->'visible'->'open')))))"
    };
}

// ── files ────────────────────────────────────────────────────────────────────

/// The live file and the caller's rules, or the refusal (404 hidden, 403
/// view-only).
async fn open_file(
    caller: &Caller,
    id: &str,
    edit: bool,
) -> Result<(Value, DriveAccessIndex), Fail> {
    let Some(row) = FILES.find_live(&caller.db, id).await? else {
        return Err(not_found("File", id).into());
    };
    let index = access(caller).await?;
    let file = DriveFile::from_row(row);
    let role = file_role(&index, &file.r#ref);
    match role {
        None => Err(not_found("File", id).into()),
        Some(role) if edit && !can_edit(Some(role)) => Err(forbidden(VIEW_ONLY).into()),
        Some(_) => Ok((file.row, index)),
    }
}

const FILES_LIST: (&str, &str) = table_list_sql!(
    files,
    // `visibleFilesCondition` (as `visible_files_sql!`), then the filters.
    "t.deleted_at is null \
     and (($3->'visible'->>'admin')::boolean or t.entity_type is not null \
          or ($3->'visible'->>'user' is not null and t.uploaded_by_id = $3->'visible'->>'user') \
          or t.id in (select jsonb_array_elements_text($3->'visible'->'shares')) \
          or t.folder_id in (select jsonb_array_elements_text($3->'visible'->'granted')) \
          or (t.general_access <> 'restricted' \
              and (t.folder_id is null or t.folder_id in (select jsonb_array_elements_text($3->'visible'->'open'))))) \
     and ($3->>'search' is null or t.file_name like $3->>'search') \
     and ($3->>'type' is null or t.file_type = $3->>'type') \
     and ($3->>'folderId' is null or t.folder_id = $3->>'folderId')"
);

async fn list_files(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_FILES, raw.as_deref())?;
    let index = access(&caller).await?;
    let filters = json!({
        "visible": visibility(&index),
        "search": like(&q, "search"),
        "type": text(&q, "type"),
        "folderId": text(&q, "folderId"),
    });
    // The cursor is not read: `pageSize` rows of the first page.
    let query = ListQuery {
        cursor: None,
        limit: clamp_limit(q.get("pageSize").and_then(Value::as_f64)),
    };
    Ok(
        list_page_mapped(&caller.db, FILES_LIST, &query, &filters, |row| {
            FILES.js(row)
        })
        .await?,
    )
}

async fn get_file(caller: Caller, Path(id): Path<String>) -> Answer {
    let (row, _) = open_file(&caller, &id, false).await?;
    ok(row)
}

/// RFC 6266 filename, with an ASCII fallback for old clients.
fn content_disposition(file_name: &str) -> String {
    let mut ascii = String::new();
    let mut in_run = false;
    for c in file_name.chars() {
        if (' '..='~').contains(&c) {
            in_run = false;
            ascii.push(if c == '"' || c == '\\' { '_' } else { c });
        } else if !in_run {
            in_run = true;
            ascii.push('_');
        }
    }
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        encode_uri_component(file_name)
    )
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `getStoredObject(env, key)`: the private bucket first.
async fn get_stored(
    private: Option<&Arc<dyn DynFileStore>>,
    public: Option<&Arc<dyn DynFileStore>>,
    key: &str,
) -> Result<Option<StoredObject>, Fail> {
    for store in [private, public].into_iter().flatten() {
        match store.get_boxed(key).await {
            Ok(Some(object)) => return Ok(Some(object)),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "external-api: reading a stored file failed");
                return Err(crate::session::internal().into());
            }
        }
    }
    Ok(None)
}

/// `locateStoredObject(env, key)`: which bucket holds `key`, private first.
async fn locate(
    private: Option<&Arc<dyn DynFileStore>>,
    public: Option<&Arc<dyn DynFileStore>>,
    key: &str,
) -> Option<&'static str> {
    for (store, name) in [(private, "private"), (public, "public")] {
        if let Some(store) = store
            && matches!(store.head_boxed(key).await, Ok(Some(_)))
        {
            return Some(name);
        }
    }
    None
}

// Always an attachment, never cached, never sniffed: a file is not rendered
// inline from the API origin.
async fn file_content(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    request_buckets: Buckets,
) -> Answer {
    let (row, _) = open_file(&caller, &id, false).await?;
    let key = [row["fileKey"].as_str(), row["storagePath"].as_str()]
        .into_iter()
        .flatten()
        .find(|key| !key.is_empty())
        .map(str::to_owned);
    let Some(key) = key.filter(|key| is_own_key(&caller, key)) else {
        return Err(not_found("File content", &id).into());
    };
    let (private, public) = buckets(&state, request_buckets);
    if private.is_none() && public.is_none() {
        return Ok((
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(json!({
                "error": { "code": "STORAGE_UNAVAILABLE", "message": "File storage is not configured" }
            })),
        )
            .into_response());
    }
    let Some(object) = get_stored(private.as_ref(), public.as_ref(), &key).await? else {
        return Err(not_found("File content", &id).into());
    };
    let content_type = row["mimeType"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .or_else(|| object.info.content_type.clone())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let file_name = row["fileName"]
        .as_str()
        .filter(|n| !n.is_empty())
        .map_or_else(|| format!("file-{id}"), str::to_owned);
    let header =
        |value: &str| HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""));
    let mut response = Response::new(Body::from(object.bytes));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, header(&content_type));
    headers.insert(CONTENT_LENGTH, header(&object.info.size.to_string()));
    headers.insert(
        CONTENT_DISPOSITION,
        header(&content_disposition(&file_name)),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

async fn create_file(
    State(state): S,
    caller: Caller,
    request_buckets: Buckets,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_FILE, &headers, &body)?;
    let body = &parsed.body;
    let keys = [body.get("storagePath"), body.get("fileKey")];
    if keys
        .iter()
        .flatten()
        .any(|key| !key.as_str().is_some_and(|key| is_own_key(&caller, key)))
    {
        return Err(bad_request("storagePath / fileKey is not a file of this workspace").into());
    }
    let index = access(&caller).await?;
    check_destination(&index, body.get("folderId").and_then(Value::as_str))?;
    let id = generate_id("fil");
    let stamp = now();
    // The drive builds a keyed row's URL from its bucket: record where it is.
    let located = match body
        .get("fileKey")
        .or_else(|| body.get("storagePath"))
        .and_then(Value::as_str)
    {
        Some(key) => {
            let (private, public) = buckets(&state, request_buckets);
            locate(private.as_ref(), public.as_ref(), key).await
        }
        None => None,
    };
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert("bucket".into(), json!(located));
    values.insert("uploadedById".into(), json!(caller.session.user_id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = FILES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        FILE_CREATED,
        &id,
        json!({ "id": id, "name": field(&row, "fileName"), "folderId": field(&row, "folderId") }),
    );
    created(row)
}

async fn update_file(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_FILE, &headers, &body)?;
    let (row, index) = open_file(&caller, &id, true).await?;
    if let Some(folder) = parsed.body.get("folderId")
        && folder != &row["folderId"]
    {
        check_destination(&index, folder.as_str())?;
    }
    let row = FILES
        .patch(
            &caller.db,
            &id,
            &with_updated(&parsed.body, &now()),
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("File", &id))?;
    caller.publish(
        &state.events,
        FILE_UPDATED,
        &id,
        json!({ "id": id, "name": field(&row, "fileName"), "folderId": field(&row, "folderId") }),
    );
    ok(row)
}

async fn delete_file(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    open_file(&caller, &id, true).await?;
    let row = soft_delete(&caller.db, &FILES, &id)
        .await?
        .ok_or_else(|| not_found("File", &id))?;
    caller.publish(
        &state.events,
        FILE_DELETED,
        &id,
        json!({ "id": id, "name": field(&row, "fileName"), "folderId": field(&row, "folderId") }),
    );
    no_content()
}

// ── folders ──────────────────────────────────────────────────────────────────

/// The live folder and the caller's rules, or the refusal.
async fn open_folder(
    caller: &Caller,
    id: &str,
    edit: bool,
) -> Result<(Value, DriveAccessIndex), Fail> {
    let Some(row) = FOLDERS.find_live(&caller.db, id).await? else {
        return Err(not_found("Folder", id).into());
    };
    let index = access(caller).await?;
    let role: Option<DriveRole> = index
        .folders
        .get(id)
        .and_then(|folder| folder_role(&index, folder));
    match role {
        None => Err(not_found("Folder", id).into()),
        Some(role) if edit && !can_edit(Some(role)) => Err(forbidden(VIEW_ONLY).into()),
        Some(_) => Ok((row, index)),
    }
}

const FOLDERS_LIST: (&str, &str) = table_list_sql!(
    folders,
    "t.deleted_at is null \
     and t.id in (select jsonb_array_elements_text($3->'visible')) \
     and ($3->>'parentId' is null or t.parent_id = $3->>'parentId')"
);

/// `listWithCursor` without a cursor or limit: the first page of the default
/// size.
fn first_page() -> ListQuery {
    ListQuery {
        cursor: None,
        limit: clamp_limit(None),
    }
}

async fn list_folders(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_FOLDERS, raw.as_deref())?;
    let index = access(&caller).await?;
    let filters = json!({
        "visible": visible_folder_ids(&index),
        "parentId": text(&q, "parentId"),
    });
    Ok(
        list_page_mapped(&caller.db, FOLDERS_LIST, &first_page(), &filters, |row| {
            FOLDERS.js(row)
        })
        .await?,
    )
}

async fn get_folder(caller: Caller, Path(id): Path<String>) -> Answer {
    let (row, _) = open_folder(&caller, &id, false).await?;
    ok(row)
}

/// `checkFolderParent(db, folderId, parentId)`: a 400 when the parent is
/// gone, or the folder itself or one of its subfolders.
async fn check_parent(
    caller: &Caller,
    folder_id: Option<&str>,
    body: &Map<String, Value>,
) -> Result<(), Fail> {
    let parent = body.get("parentId").and_then(Value::as_str);
    match check_folder_parent(&caller.db, folder_id, parent).await? {
        Some(problem) => Err(bad_request(problem.message()).into()),
        None => Ok(()),
    }
}

async fn create_folder(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_FOLDER, &headers, &body)?;
    let body = &parsed.body;
    check_parent(&caller, None, body).await?;
    let index = access(&caller).await?;
    check_destination(&index, body.get("parentId").and_then(Value::as_str))?;
    let id = generate_id("fld");
    let stamp = now();
    let mut values = body.clone();
    values.insert("id".into(), json!(id));
    values.insert("createdById".into(), json!(caller.session.user_id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = FOLDERS
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        FOLDER_CREATED,
        &id,
        json!({ "id": id, "name": field(&row, "name"), "parentId": field(&row, "parentId") }),
    );
    created(row)
}

async fn update_folder(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_FOLDER, &headers, &body)?;
    let (row, index) = open_folder(&caller, &id, true).await?;
    // A parent inside the folder would cut it and its contents off.
    check_parent(&caller, Some(&id), &parsed.body).await?;
    if let Some(parent) = parsed.body.get("parentId")
        && parent != &row["parentId"]
    {
        check_destination(&index, parent.as_str())?;
    }
    let row = FOLDERS
        .patch(
            &caller.db,
            &id,
            &with_updated(&parsed.body, &now()),
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("Folder", &id))?;
    caller.publish(
        &state.events,
        FOLDER_UPDATED,
        &id,
        json!({ "id": id, "name": field(&row, "name"), "parentId": field(&row, "parentId") }),
    );
    ok(row)
}

async fn delete_folder(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    open_folder(&caller, &id, true).await?;
    let row = soft_delete(&caller.db, &FOLDERS, &id)
        .await?
        .ok_or_else(|| not_found("Folder", &id))?;
    caller.publish(
        &state.events,
        FOLDER_DELETED,
        &id,
        json!({ "id": id, "name": field(&row, "name"), "parentId": field(&row, "parentId") }),
    );
    no_content()
}

// ── drive ────────────────────────────────────────────────────────────────────

async fn drive_all(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_DRIVE_ALL, raw.as_deref())?;
    let result = async {
        let index = access(&caller).await?;
        let filters = json!({
            "visible": visibility(&index),
            "search": like(&q, "search"),
            "type": text(&q, "type"),
            "folderId": text(&q, "folderId"),
        });
        Ok::<_, Fail>(
            list_page_mapped(
                &caller.db,
                FILES_LIST,
                &crate::crud::list_query(&q),
                &filters,
                |row| FILES.js(row),
            )
            .await?,
        )
    }
    .await;
    result.map_err(|_| internal_with("Failed to fetch files").into())
}

const STATS_SQL: &str = concat!(
    "select t.file_type, count(*)::bigint from files t where t.deleted_at is null and ",
    visible_files_sql!(),
    " group by t.file_type"
);

async fn drive_stats(caller: Caller) -> Answer {
    let result = async {
        let index = access(&caller).await?;
        let filters = json!({ "visible": visibility(&index) });
        let rows: Vec<(String, i64)> = sqlx::query_as(STATS_SQL)
            .bind(Option::<String>::None)
            .bind(0_i64)
            .bind(&filters)
            .fetch_all(&caller.db)
            .await?;
        let mut by_type = Map::new();
        let mut total_files = 0_i64;
        for (file_type, total) in rows {
            by_type.insert(file_type, json!(total));
            total_files += total;
        }
        let visible = visible_folder_ids(&index);
        let total_folders: i64 = if visible.is_empty() {
            0
        } else {
            sqlx::query_scalar(
                "select count(*)::bigint from folders where deleted_at is null and id = any($1)",
            )
            .bind(&visible)
            .fetch_one(&caller.db)
            .await?
        };
        Ok::<_, Fail>(json!({
            "totalFiles": total_files,
            "totalFolders": total_folders,
            "byType": by_type,
        }))
    }
    .await;
    match result {
        Ok(stats) => ok(stats),
        Err(_) => Err(internal_with("Failed to get stats").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispositions_fall_back_to_ascii() {
        assert_eq!(
            content_disposition("report \"Q1\".pdf"),
            "attachment; filename=\"report _Q1_.pdf\"; filename*=UTF-8''report%20%22Q1%22.pdf"
        );
        assert_eq!(
            content_disposition("résumé.pdf"),
            "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
        );
    }

    #[test]
    fn keys_belong_to_a_workspace() {
        assert_eq!(
            workspace_of_key("workspaces/org_1/drive/x.pdf"),
            Some("org_1")
        );
        assert_eq!(workspace_of_key("workspaces/org_1"), None);
        assert_eq!(workspace_of_key("avatars/x.png"), None);
    }
}
