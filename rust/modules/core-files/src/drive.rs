//! `/api/drive` (`routes/drive/index.ts` and `services/drive-aggregation.ts`):
//! the file feed across modules, its counters, "Shared with me", and the
//! trash.
//!
//! The feed pulls eight sources (Drive, project files, project documents,
//! whiteboards, mail attachments, call and meeting recordings, social media)
//! into one `UnifiedFile` shape. Drive files follow the WeldDrive rules and
//! mail attachments come from mailboxes the caller may open; the rest are
//! workspace-wide.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QuerySelect, Select,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    FILE_PURGED, FILE_RESTORED, FOLDER_PURGED, FOLDER_RESTORED,
};
use weldsuite_core_domain::drive_access::{
    DriveAccessIndex, DriveFileRef, DriveFolderRef, can_edit, file_role, folder_role,
};
use weldsuite_core_domain::drive_sharing::{
    list_shared_with_user, with_file_access, with_folder_access, with_share_fields,
};
use weldsuite_core_domain::{files as files_db, folders as folders_db};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_schema::tenant::enums::SocialMediaStatus;
use weldsuite_schema::tenant::{
    files, mail_accounts, mail_attachments, mail_messages, meeting_bot_sessions, project_documents,
    project_files, project_whiteboards, social_media, voip_calls,
};

use crate::search::{SearchType, build_result_url};
use crate::{
    Caller, CoreFilesState, Fail, answer, forbidden, json_response, not_found, now, ok,
    private_object_url, text, validate_query,
};

pub(crate) const DRIVE_VIEW_ONLY: &str = "You can view this item but not change it";
const DRIVE_FOLDER_HOLDS_LOCKED_FILES: &str = "This folder holds files you cannot change, so it cannot be deleted permanently. Their owners can move or delete them first";

// ── The unified shape ──────────────────────────────────────────────────────

/// Drive files a module stores for one of its records (WeldFlow sheets,
/// documents and boards).
const PROJECT_ENTITY_TYPES: [&str; 2] = ["project", "project_document"];

fn build_navigate_url(row: &Value) -> Option<String> {
    let entity_type = text(row, "entityType").filter(|t| !t.is_empty())?;
    let entity_id = text(row, "entityId").filter(|t| !t.is_empty())?;
    match entity_type {
        "crm_contact" => Some(build_result_url(SearchType::Contact, entity_id)),
        "crm_customer" => Some(build_result_url(SearchType::Customer, entity_id)),
        "project" => {
            let id = text(row, "id").filter(|id| !id.is_empty());
            let board = row["metadata"]["weldBoardId"].as_str();
            match (text(row, "fileType"), id, board) {
                (Some("spreadsheet"), Some(file_id), _) => {
                    Some(format!("/weldflow/project/{entity_id}/table/{file_id}"))
                }
                // A project's WeldBoard board opens on the project's whiteboard tab.
                (Some("whiteboard"), _, Some(board)) => {
                    Some(format!("/weldflow/project/{entity_id}/whiteboard/{board}"))
                }
                _ => Some(format!("/weldflow/project/{entity_id}/files")),
            }
        }
        "project_document" => row["metadata"]["projectId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|project| format!("/weldflow/project/{project}/documents")),
        "helpdesk_ticket" => Some(build_result_url(SearchType::Ticket, entity_id)),
        "mail_message" => Some(format!("/weldmail/unified/inbox/{entity_id}")),
        "social_post" => Some("/social".to_owned()),
        _ => None,
    }
}

/// A `WeldSheets` spreadsheet, `WeldDocs` document or `WeldBoard` board
/// opens in its editor.
fn weld_module_url(metadata: &Value) -> Option<String> {
    if let Some(sheet) = metadata["weldsheetId"].as_str() {
        return Some(format!("/weldsheets/{sheet}"));
    }
    if let Some(doc) = metadata["weldDocId"].as_str() {
        return Some(format!("/welddocs/{doc}"));
    }
    metadata["weldBoardId"]
        .as_str()
        .map(|board| format!("/weldboard/{board}"))
}

/// Extensions `guessFileType` reads as code.
const CODE: [&str; 17] = [
    "js", "ts", "py", "go", "rs", "java", "cpp", "c", "h", "css", "html", "json", "xml", "yaml",
    "yml", "sh", "sql",
];

fn guess_file_type(mime_type: Option<&str>, file_name: Option<&str>) -> &'static str {
    let Some(mime) = mime_type.filter(|m| !m.is_empty()) else {
        return "file";
    };
    let has = |needle: &str| mime.contains(needle);
    if mime.starts_with("image/") {
        return "image";
    }
    if mime.starts_with("video/") {
        return "video";
    }
    if mime.starts_with("audio/") {
        return "audio";
    }
    if mime == "application/pdf" {
        return "pdf";
    }
    if has("spreadsheet") || has("excel") || has("csv") {
        return "spreadsheet";
    }
    if has("presentation") || has("powerpoint") {
        return "presentation";
    }
    if has("document") || has("word") || has("text/") {
        return "document";
    }
    if has("zip") || has("rar") || has("tar") || has("gzip") {
        return "archive";
    }
    let ext = file_name
        .and_then(|name| name.rsplit('.').next())
        .map(str::to_lowercase);
    if ext.is_some_and(|ext| CODE.contains(&ext.as_str())) {
        return "code";
    }
    "file"
}

/// `a || b` over JSON strings.
fn or_text(value: &Value, fallback: &str) -> Value {
    match value.as_str() {
        Some(text) if !text.is_empty() => Value::String(text.to_owned()),
        _ => Value::String(fallback.to_owned()),
    }
}

/// Where a Drive row's URL comes from when it stores only a key.
pub(crate) struct UrlBases {
    /// `R2_PUBLIC_URL` without its trailing slashes.
    pub(crate) public: Option<String>,
    /// app-api's origin, for rows in the private bucket.
    pub(crate) origin: String,
}

impl UrlBases {
    pub(crate) fn of(caller: &Caller, state: &CoreFilesState) -> Self {
        Self {
            public: caller
                .public_files_url(state)
                .map(|url| url.trim_end_matches('/').to_owned()),
            origin: caller.origin.clone(),
        }
    }

    fn stored_url(&self, row: &Value) -> Value {
        let Some(key) = text(row, "fileKey").filter(|k| !k.is_empty()) else {
            return Value::Null;
        };
        if text(row, "bucket") == Some("private") {
            return json!(private_object_url(&self.origin, key));
        }
        match &self.public {
            Some(base) => json!(format!("{base}/{key}")),
            None => Value::Null,
        }
    }
}

/// Drive rows (with their access fields) as `UnifiedFile`s
/// (`normalizeGenericFiles`).
pub(crate) fn normalize_generic_files(rows: Vec<Value>, bases: &UrlBases) -> Vec<Value> {
    rows.into_iter()
        .map(|r| {
            let entity_type = text(&r, "entityType");
            let source_label = if entity_type.is_some_and(|t| PROJECT_ENTITY_TYPES.contains(&t)) {
                "Projects"
            } else {
                "My Drive"
            };
            let navigate = build_navigate_url(&r).or_else(|| weld_module_url(&r["metadata"]));
            let url = if r["url"].is_null() {
                bases.stored_url(&r)
            } else {
                r["url"].clone()
            };
            let mut out = json!({
                "id": r["id"],
                "name": r["fileName"],
                "fileType": or_text(&r["fileType"], "file"),
                "mimeType": r["mimeType"],
                "fileSize": r["fileSize"],
                "url": url,
                "thumbnailUrl": r["thumbnailUrl"],
                "source": "drive",
                "sourceLabel": source_label,
                "navigateTo": navigate,
                "folderId": r["folderId"],
                "isStarred": r["isStarred"],
                "createdAt": r["createdAt"],
                "updatedAt": r["updatedAt"],
                "uploadedById": r["uploadedById"],
                "isWeldDoc": r["metadata"]["welddoc"] == Value::Bool(true),
                "entityType": r["entityType"],
                "description": files_db::file_description(&r),
            });
            if let Value::Object(fields) = &mut out {
                for key in ["accessRole", "effectiveAccess"] {
                    if let Some(value) = r.get(key) {
                        fields.insert(key.to_owned(), value.clone());
                    }
                }
            }
            out
        })
        .collect()
}

fn unified(row: &Value, fields: Value) -> Value {
    let mut out = json!({
        "id": row["id"],
        "folderId": null,
        "isStarred": false,
        "createdAt": row["createdAt"],
        "uploadedById": null,
    });
    if let (Value::Object(out), Value::Object(fields)) = (&mut out, fields) {
        out.extend(fields);
    }
    out
}

fn normalize_project_files(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let navigate = text(r, "projectId")
                .filter(|p| !p.is_empty())
                .map(|p| format!("/weldflow/project/{p}/files"));
            unified(
                r,
                json!({
                    "name": r["fileName"], "fileType": or_text(&r["fileType"], "file"),
                    "mimeType": r["mimeType"], "fileSize": r["fileSize"], "url": r["url"],
                    "thumbnailUrl": r["thumbnailUrl"], "source": "projects", "sourceLabel": "Projects",
                    "navigateTo": navigate, "updatedAt": r["updatedAt"],
                    "uploadedById": r["uploadedById"],
                }),
            )
        })
        .collect()
}

fn project_document_mime_type(content_type: Option<&str>) -> &'static str {
    match content_type {
        Some("html") => "text/html",
        Some("markdown") => "text/markdown",
        _ => "application/json",
    }
}

fn normalize_project_documents(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let navigate = text(r, "projectId")
                .filter(|p| !p.is_empty())
                .map(|p| format!("/weldflow/project/{p}/documents"));
            let cover = match text(r, "coverImage") {
                Some(cover) if !cover.is_empty() => json!(cover),
                _ => Value::Null,
            };
            unified(
                r,
                json!({
                    "name": or_text(&r["title"], "Untitled Document"), "fileType": "rich-document",
                    "mimeType": project_document_mime_type(text(r, "contentType")),
                    "fileSize": null, "url": null, "thumbnailUrl": cover, "source": "documents",
                    "sourceLabel": "Documents", "navigateTo": navigate, "updatedAt": r["updatedAt"],
                }),
            )
        })
        .collect()
}

fn normalize_whiteboards(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let navigate = text(r, "projectId").filter(|p| !p.is_empty()).map(|p| {
                format!(
                    "/weldflow/project/{p}/whiteboard/{}",
                    text(r, "id").unwrap_or_default()
                )
            });
            unified(
                r,
                json!({
                    "name": or_text(&r["name"], "Untitled Whiteboard"), "fileType": "whiteboard",
                    "mimeType": null, "fileSize": null, "url": null, "thumbnailUrl": null,
                    "source": "whiteboards", "sourceLabel": "Whiteboards", "navigateTo": navigate,
                    "updatedAt": r["updatedAt"],
                }),
            )
        })
        .collect()
}

fn normalize_mail_attachments(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            unified(
                r,
                json!({
                    "name": or_text(&r["fileName"], "Attachment"),
                    "fileType": guess_file_type(text(r, "contentType"), text(r, "fileName")),
                    "mimeType": r["contentType"], "fileSize": r["size"], "url": r["downloadUrl"],
                    "thumbnailUrl": null, "source": "mail", "sourceLabel": "Mail",
                    "navigateTo": null, "updatedAt": null,
                }),
            )
        })
        .collect()
}

/// `date.toLocaleDateString()` as the Workers runtime prints it: `en-US` in
/// UTC, `10/29/2026`.
fn locale_date(iso: Option<&str>) -> String {
    let Some(iso) = iso else {
        return "Invalid Date".to_owned();
    };
    let parts: Vec<&str> = iso.get(..10).unwrap_or_default().split('-').collect();
    match parts.as_slice() {
        [year, month, day] => {
            let number = |part: &str| part.trim_start_matches('0').to_owned();
            format!("{}/{}/{year}", number(month), number(day))
        }
        _ => "Invalid Date".to_owned(),
    }
}

fn normalize_voip_recordings(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let direction = if text(r, "direction") == Some("inbound") {
                "Inbound"
            } else {
                "Outbound"
            };
            let name = format!(
                "Call Recording {direction} - {}",
                locale_date(text(r, "createdAt"))
            );
            unified(
                r,
                json!({
                    "name": name, "fileType": "recording", "mimeType": "audio/mpeg",
                    "fileSize": r["recordingFileSize"], "url": r["recordingStorageUrl"],
                    "thumbnailUrl": null, "source": "voip", "sourceLabel": "Call Intelligence",
                    "navigateTo": "/weldcrm/call-intelligence", "updatedAt": null,
                }),
            )
        })
        .collect()
}

fn normalize_meeting_recordings(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let fallback = format!("Meeting Recording - {}", locale_date(text(r, "createdAt")));
            unified(
                r,
                json!({
                    "name": or_text(&r["title"], &fallback), "fileType": "recording",
                    "mimeType": "video/mp4", "fileSize": r["recordingFileSize"],
                    "url": r["recordingStorageUrl"], "thumbnailUrl": null, "source": "meetings",
                    "sourceLabel": "Meeting Intelligence", "navigateTo": "/weldcrm/calls",
                    "updatedAt": null,
                }),
            )
        })
        .collect()
}

fn normalize_social_media(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let media_type = text(r, "mediaType");
            let file_type = match media_type {
                Some("gif") => "image".to_owned(),
                Some(t) if !t.is_empty() => t.to_owned(),
                _ => "file".to_owned(),
            };
            let fallback = format!(
                "Social Media {}",
                media_type.map_or_else(|| "null".to_owned(), str::to_owned)
            );
            unified(
                r,
                json!({
                    "name": or_text(&r["fileName"], &fallback), "fileType": file_type,
                    "mimeType": r["mimeType"], "fileSize": r["fileSize"], "url": r["url"],
                    "thumbnailUrl": r["thumbnailUrl"], "source": "social", "sourceLabel": "Social",
                    "navigateTo": null, "updatedAt": r["updatedAt"],
                }),
            )
        })
        .collect()
}

// ── The sources ────────────────────────────────────────────────────────────

/// Rows as Drizzle returned them (`to_jsonb`): each entity serializes as
/// Drizzle did.
async fn js_rows<E>(query: Select<E>, db: &DatabaseConnection) -> Result<Vec<Value>, DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize,
{
    query
        .all(db)
        .await?
        .into_iter()
        .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
        .collect()
}

/// How many rows a source has (`count(*)`).
async fn count<E>(query: Select<E>, db: &DatabaseConnection) -> Result<i64, DbErr>
where
    E: EntityTrait,
    E::Model: Sync,
{
    Ok(i64::try_from(query.count(db).await?).unwrap_or(i64::MAX))
}

/// Project files that are not folders.
fn project_file_rows() -> Select<project_files::Entity> {
    project_files::Entity::find()
        .filter(project_files::Column::DeletedAt.is_null())
        .filter(project_files::Column::IsFolder.eq(false))
}

fn project_document_rows() -> Select<project_documents::Entity> {
    project_documents::Entity::find().filter(project_documents::Column::DeletedAt.is_null())
}

fn whiteboard_rows() -> Select<project_whiteboards::Entity> {
    project_whiteboards::Entity::find().filter(project_whiteboards::Column::DeletedAt.is_null())
}

/// Calls with a recording.
fn voip_recording_rows() -> Select<voip_calls::Entity> {
    voip_calls::Entity::find().filter(voip_calls::Column::IsRecorded.eq(true))
}

/// Meeting bot sessions with a recording.
fn meeting_recording_rows() -> Select<meeting_bot_sessions::Entity> {
    meeting_bot_sessions::Entity::find()
        .filter(meeting_bot_sessions::Column::RecordingStorageUrl.is_not_null())
}

fn social_media_rows() -> Select<social_media::Entity> {
    social_media::Entity::find().filter(social_media::Column::Status.ne(SocialMediaStatus::Deleted))
}

// ── Mail attachment access ─────────────────────────────────────────────────

/// `isAdminOrOwner` (`@weldsuite/mail-domain/access`).
async fn is_admin_or_owner(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    weldsuite_core_domain::drive_access::is_workspace_admin(db, user_id).await
}

/// The live attachments of mailboxes `user_id` may open
/// (`accessibleMailAttachments` + `userAccessCondition`): shared ones, those
/// assigned to them, and for an admin those assigned to no one.
async fn mail_attachment_rows(
    db: &PgPool,
    user_id: &str,
) -> Result<Select<mail_attachments::Entity>, DbErr> {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let admin = is_admin_or_owner(db, user_id).await?;
    let assigned = || {
        Expr::col((
            mail_accounts::Entity,
            mail_accounts::Column::AssignedUserIds,
        ))
    };
    let mut access = Condition::any()
        .add(mail_accounts::Column::IsShared.eq(true))
        .add(PgExpr::contains(assigned(), Expr::val(json!([user_id]))));
    if admin {
        // `coalesce(assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)`
        access = access.add(sea_orm::ExprTrait::is_in(
            Expr::from(Func::coalesce([assigned(), Expr::val(json!([]))])),
            [json!([]), Value::Null],
        ));
    }
    Ok(mail_attachments::Entity::find()
        .join(
            JoinType::InnerJoin,
            mail_attachments::Entity::belongs_to(mail_messages::Entity)
                .from(mail_attachments::Column::MessageId)
                .to(mail_messages::Column::Id)
                .into(),
        )
        .join(
            JoinType::InnerJoin,
            mail_messages::Entity::belongs_to(mail_accounts::Entity)
                .from(mail_messages::Column::AccountId)
                .to(mail_accounts::Column::Id)
                .into(),
        )
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .filter(access))
}

// ── /all ───────────────────────────────────────────────────────────────────

/// Every source's files in the unified shape (`aggregateAllFiles`).
async fn aggregate_all_files(
    db: &PgPool,
    user_id: &str,
    source: Option<&str>,
    access: &DriveAccessIndex,
    bases: &UrlBases,
) -> Result<Vec<Value>, DbErr> {
    let wants = |s: &str| source.is_none_or(|source| source.is_empty() || source == s);
    let conn = &orm(db);
    let mut out = Vec::new();
    if wants("drive") {
        let drive = js_rows(
            files::Entity::find().filter(files::Column::DeletedAt.is_null()),
            conn,
        )
        .await?;
        out.extend(normalize_generic_files(
            with_file_access(access, drive),
            bases,
        ));
    }
    if wants("projects") {
        out.extend(normalize_project_files(
            &js_rows(project_file_rows(), conn).await?,
        ));
    }
    if wants("documents") {
        out.extend(normalize_project_documents(
            &js_rows(project_document_rows(), conn).await?,
        ));
    }
    if wants("whiteboards") {
        out.extend(normalize_whiteboards(
            &js_rows(whiteboard_rows(), conn).await?,
        ));
    }
    if wants("mail") {
        let rows = mail_attachment_rows(db, user_id).await?;
        out.extend(normalize_mail_attachments(&js_rows(rows, conn).await?));
    }
    if wants("voip") {
        out.extend(normalize_voip_recordings(
            &js_rows(voip_recording_rows(), conn).await?,
        ));
    }
    if wants("meetings") {
        out.extend(normalize_meeting_recordings(
            &js_rows(meeting_recording_rows(), conn).await?,
        ));
    }
    if wants("social") {
        out.extend(normalize_social_media(
            &js_rows(social_media_rows(), conn).await?,
        ));
    }
    Ok(out)
}

// ── In-memory pagination (`queryArray`) ────────────────────────────────────

/// What `queryArray` is asked for.
pub(crate) struct ArrayQuery<'a> {
    pub(crate) page: i64,
    pub(crate) page_size: i64,
    pub(crate) search: Option<&'a str>,
    pub(crate) sort_by: &'a str,
    pub(crate) descending: bool,
    /// `filters: { fileType }`.
    pub(crate) file_type: Option<&'a str>,
}

/// JavaScript's `String(value)` (`asText`) for what a unified row holds.
fn as_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// A character's place in the collation: spaces and punctuation, digits,
/// then letters, as ICU's root order puts them.
fn collation_class(c: char) -> u8 {
    if c.is_alphabetic() {
        2
    } else {
        u8::from(c.is_numeric())
    }
}

/// `a.localeCompare(b)` (ICU root collation), close enough for names and ISO
/// timestamps: letters compare without case first, then lower before upper.
fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = |s: &str| -> Vec<(u8, String)> {
        s.chars()
            .map(|c| (collation_class(c), c.to_lowercase().collect()))
            .collect()
    };
    primary(a).cmp(&primary(b)).then_with(|| {
        // Tertiary: lowercase sorts before uppercase.
        let case = |s: &str| -> Vec<bool> { s.chars().map(char::is_uppercase).collect() };
        case(a).cmp(&case(b))
    })
}

/// `compareSortValues`: nulls last ascending (first descending); strings by
/// collation, numbers by value; anything else is equal.
fn compare_sort_values(a: &Value, b: &Value, descending: bool) -> Ordering {
    let ordering = match (a, b) {
        (Value::Null, Value::Null) => return Ordering::Equal,
        (Value::Null, _) => Ordering::Greater,
        (_, Value::Null) => Ordering::Less,
        (Value::String(a), Value::String(b)) => locale_compare(a, b),
        (Value::Number(a), Value::Number(b)) => a
            .as_f64()
            .partial_cmp(&b.as_f64())
            .unwrap_or(Ordering::Equal),
        _ => return Ordering::Equal,
    };
    if descending {
        ordering.reverse()
    } else {
        ordering
    }
}

/// Search, filter, sort and page an array of unified rows (`queryArray`).
pub(crate) fn query_array(items: &[Value], query: &ArrayQuery<'_>) -> (Vec<Value>, Value) {
    let mut result: Vec<&Value> = items.iter().collect();
    if let Some(term) = query.search {
        let term = term.to_lowercase();
        let term = term.trim();
        if !term.is_empty() {
            result.retain(|item| {
                let value = &item["name"];
                !value.is_null() && as_text(value).to_lowercase().contains(term)
            });
        }
    }
    if let Some(file_type) = query.file_type.filter(|t| !t.is_empty()) {
        result.retain(|item| item["fileType"] == Value::String(file_type.to_owned()));
    }
    result.sort_by(|a, b| {
        compare_sort_values(
            a.get(query.sort_by).unwrap_or(&Value::Null),
            b.get(query.sort_by).unwrap_or(&Value::Null),
            query.descending,
        )
    });
    let total = i64::try_from(result.len()).unwrap_or(i64::MAX);
    let pages = if query.page_size > 0 {
        ((total + query.page_size - 1) / query.page_size).max(1)
    } else {
        1
    };
    let offset = usize::try_from((query.page - 1) * query.page_size).unwrap_or(0);
    let size = usize::try_from(query.page_size).unwrap_or(0);
    let page: Vec<Value> = result
        .into_iter()
        .skip(offset)
        .take(size)
        .cloned()
        .collect();
    let pagination = json!({
        "page": query.page,
        "pageSize": query.page_size,
        "totalCount": total,
        "totalPages": pages,
        "hasMore": query.page < pages,
    });
    (page, pagination)
}

/// The query of the list routes (`listFilesQuery` / `listAllFilesQuery`):
/// the fields both have, in schema order, with `extra` read where the schema
/// has them.
pub(crate) struct ListQuery {
    pub(crate) page: Option<i64>,
    pub(crate) page_size: Option<i64>,
    pub(crate) search: Option<String>,
    pub(crate) file_type: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) sort_by: Option<String>,
    pub(crate) sort_order: Option<String>,
}

pub(crate) fn read_list_query(issues: &mut Issues, q: &Map<String, Value>) -> ListQuery {
    let page = issues
        .whole_number(
            q,
            "page",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                ..Number::default()
            },
        )
        .into_option();
    let page_size = issues
        .whole_number(
            q,
            "pageSize",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(200.0),
                ..Number::default()
            },
        )
        .into_option();
    let mut string = |key: &str| {
        issues
            .text(q, key, Presence::Optional, None, None)
            .into_option()
    };
    let search = string("search");
    let file_type = string("type");
    let source = string("source");
    let sort_by = string("sortBy");
    let sort_order = issues
        .choice(q, "sortOrder", Presence::Optional, &["asc", "desc"])
        .into_option();
    ListQuery {
        page,
        page_size,
        search,
        file_type,
        source,
        sort_by,
        sort_order,
    }
}

impl ListQuery {
    pub(crate) fn array_query<'a>(&'a self, file_type: Option<&'a str>) -> ArrayQuery<'a> {
        ArrayQuery {
            page: self.page.unwrap_or(1),
            page_size: self.page_size.unwrap_or(30),
            search: self.search.as_deref(),
            sort_by: self.sort_by.as_deref().unwrap_or("createdAt"),
            descending: self.sort_order.as_deref() != Some("asc"),
            file_type,
        }
    }
}

pub(crate) async fn all(
    State(state): State<CoreFilesState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let q = match validate_query(query.as_deref(), read_list_query) {
        Ok(q) => q,
        Err(fail) => return answer(Err(fail), ""),
    };
    answer(
        async {
            let access = caller.drive_access().await?;
            let bases = UrlBases::of(&caller, &state);
            let user_id = caller.user_id.clone().unwrap_or_default();
            let all = aggregate_all_files(&caller.db, &user_id, q.source.as_deref(), &access, &bases)
                .await?;
            let (items, pagination) = query_array(&all, &q.array_query(q.file_type.as_deref()));
            let mut by_type: BTreeMap<String, i64> = BTreeMap::new();
            let mut by_source: BTreeMap<String, i64> = BTreeMap::new();
            for file in &all {
                *by_type.entry(as_text(&file["fileType"])).or_default() += 1;
                *by_source.entry(as_text(&file["source"])).or_default() += 1;
            }
            Ok(json_response(
                http::StatusCode::OK,
                json!({
                    "success": true,
                    "data": items,
                    "pagination": pagination,
                    "summary": { "totalFiles": all.len(), "byType": by_type, "bySource": by_source },
                }),
            ))
        }
        .await,
        "Failed to fetch files",
    )
}

// ── /stats ─────────────────────────────────────────────────────────────────

/// What the counters need of a Drive file (`jsonb_build_object` of these).
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriveStatRow {
    id: String,
    uploaded_by_id: Option<String>,
    folder_id: Option<String>,
    general_access: String,
    entity_type: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
}

/// The live Drive files, as the counters read them.
async fn drive_stat_rows(db: &DatabaseConnection) -> Result<Vec<Value>, DbErr> {
    use files::Column;
    files::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::UploadedById,
            Column::FolderId,
            Column::GeneralAccess,
            Column::EntityType,
            Column::CreatedAt,
        ])
        .filter(Column::DeletedAt.is_null())
        .into_model::<DriveStatRow>()
        .all(db)
        .await?
        .into_iter()
        .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
        .collect()
}

pub(crate) async fn stats(caller: Caller) -> Response {
    answer(
        async {
            let db = &caller.db;
            let conn = &orm(db);
            let user_id = caller.user_id.clone().unwrap_or_default();
            let access = caller.drive_access().await?;
            let drive_rows = drive_stat_rows(conn).await?;
            let projects = count(project_file_rows(), conn).await?;
            let documents = count(project_document_rows(), conn).await?;
            let whiteboards = count(whiteboard_rows(), conn).await?;
            let mail = count(mail_attachment_rows(db, &user_id).await?, conn).await?;
            let voip = count(voip_recording_rows(), conn).await?;
            let meetings = count(meeting_recording_rows(), conn).await?;
            let social = count(social_media_rows(), conn).await?;
            let visible = with_file_access(&access, drive_rows);
            let week_ago = OffsetDateTime::now_utc() - time::Duration::days(7);
            let week_ago = weldsuite_events::iso_timestamp(week_ago);
            // ISO timestamps with milliseconds compare as strings.
            let recent = visible
                .iter()
                .filter(|f| text(f, "createdAt").is_some_and(|at| at > week_ago.as_str()))
                .count();
            let drive = i64::try_from(visible.len()).unwrap_or(i64::MAX);
            ok(json!({
                "totalFiles": drive + projects + documents + whiteboards + mail + voip + meetings + social,
                "recentCount": recent,
                "bySource": {
                    "drive": drive, "projects": projects, "documents": documents,
                    "whiteboards": whiteboards, "mail": mail, "voip": voip,
                    "meetings": meetings, "social": social,
                },
            }))
        }
        .await,
        "Failed to get stats",
    )
}

// ── /shared ────────────────────────────────────────────────────────────────

pub(crate) async fn shared(State(state): State<CoreFilesState>, caller: Caller) -> Response {
    answer(
        async {
            let Some(user_id) = caller.user_id.clone() else {
                return Err(weldsuite_kit::ApiError::unauthorized().into());
            };
            let (shared_files, shared_folders) =
                list_shared_with_user(&caller.db, &user_id).await?;
            let access = caller.drive_access().await?;
            let file_shares: HashMap<&str, _> = shared_files
                .iter()
                .map(|s| (text(&s.row, "id").unwrap_or_default(), s))
                .collect();
            let folder_shares: HashMap<&str, _> = shared_folders
                .iter()
                .map(|s| (text(&s.row, "id").unwrap_or_default(), s))
                .collect();
            let bases = UrlBases::of(&caller, &state);
            let files: Vec<Value> = normalize_generic_files(
                with_file_access(
                    &access,
                    shared_files.iter().map(|s| s.row.clone()).collect(),
                ),
                &bases,
            )
            .into_iter()
            .map(|f| {
                let share = file_shares.get(text(&f, "id").unwrap_or_default()).copied();
                match share {
                    Some(share) => with_share_fields(f, share),
                    None => f,
                }
            })
            .collect();
            let folders: Vec<Value> = with_folder_access(
                &access,
                shared_folders.iter().map(|s| s.row.clone()).collect(),
            )
            .into_iter()
            .map(|f| {
                let share = folder_shares
                    .get(text(&f, "id").unwrap_or_default())
                    .copied();
                match share {
                    Some(share) => with_share_fields(f, share),
                    None => f,
                }
            })
            .collect();
            ok(json!({ "files": files, "folders": folders }))
        }
        .await,
        "Failed to list shared items",
    )
}

// ── The trash ──────────────────────────────────────────────────────────────

pub(crate) async fn trash(caller: Caller) -> Response {
    answer(
        async {
            let files = files_db::list_trashed_files(&caller.db).await?;
            let folders = folders_db::list_trashed_folders(&caller.db).await?;
            let access = caller.drive_access().await?;
            // What sits in a trashed folder is listed as that folder: it went
            // to the trash with it and comes back when the folder is restored.
            let trashed: HashSet<String> = folders
                .iter()
                .filter_map(|row| text(row, "id").map(str::to_owned))
                .collect();
            let outside = |row: &Value, parent: &str| {
                text(row, parent).is_none_or(|id| !trashed.contains(id))
            };
            let files: Vec<Value> = files
                .into_iter()
                .filter(|r| outside(r, "folderId"))
                .collect();
            let folders: Vec<Value> = folders
                .into_iter()
                .filter(|r| outside(r, "parentId"))
                .collect();
            ok(json!({
                "files": with_file_access(&access, files),
                "folders": with_folder_access(&access, folders),
            }))
        }
        .await,
        "Failed to list trash",
    )
}

/// The caller's role on a trashed item must be owner or editor: 404 when
/// they cannot see it, 403 when they only view it.
fn check_editable(
    role: Option<weldsuite_core_domain::drive_access::DriveRole>,
    resource: &str,
    id: &str,
) -> Result<(), Fail> {
    match role {
        None => Err(not_found(resource, id)),
        Some(role) if can_edit(Some(role)) => Ok(()),
        Some(_) => Err(forbidden(DRIVE_VIEW_ONLY)),
    }
}

pub(crate) async fn restore_file(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let Some(trashed) = files_db::trashed_file(&caller.db, &id).await? else {
                return Err(not_found("File", &id));
            };
            let access = caller.drive_access().await?;
            check_editable(
                file_role(&access, &DriveFileRef::from_row(&trashed)),
                "File",
                &id,
            )?;
            let Some(row) = files_db::restore_file(&caller.db, &id, &now()).await? else {
                return Err(not_found("File", &id));
            };
            caller.publish(
                &state,
                FILE_RESTORED,
                &id,
                &json!({ "id": id, "name": row["fileName"], "folderId": row["folderId"] }),
            );
            ok(json!({ "restored": true }))
        }
        .await,
        "Failed to restore file",
    )
}

pub(crate) async fn restore_folder(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let Some(trashed) = folders_db::trashed_folder(&caller.db, &id).await? else {
                return Err(not_found("Folder", &id));
            };
            let access = caller.drive_access().await?;
            check_editable(
                folder_role(&access, &DriveFolderRef::from_row(&trashed)),
                "Folder",
                &id,
            )?;
            let Some(row) = folders_db::restore_folder(&caller.db, &id, &now()).await? else {
                return Err(not_found("Folder", &id));
            };
            caller.publish(
                &state,
                FOLDER_RESTORED,
                &id,
                &json!({ "id": id, "name": row["name"], "parentId": row["parentId"] }),
            );
            ok(json!({ "restored": true }))
        }
        .await,
        "Failed to restore folder",
    )
}

/// `deleteStoredObjects(env, keys).catch(() => {})`: every key, from both
/// buckets; a failure is logged and ignored.
async fn delete_stored_objects(caller: &Caller, state: &CoreFilesState, keys: Vec<String>) {
    let mut seen = HashSet::new();
    let keys: Vec<String> = keys
        .into_iter()
        .filter(|key| !key.is_empty() && seen.insert(key.clone()))
        .collect();
    if keys.is_empty() {
        return;
    }
    let Some(stores) = caller.files(state) else {
        return;
    };
    if let Err(error) = stores.private.delete_many_boxed(&keys).await {
        tracing::warn!(%error, "drive: deleting purged objects failed");
        return;
    }
    if let Some(public) = &stores.public
        && let Err(error) = public.delete_many_boxed(&keys).await
    {
        tracing::warn!(%error, "drive: deleting purged objects failed");
    }
}

pub(crate) async fn purge_file(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let Some(trashed) = files_db::trashed_file(&caller.db, &id).await? else {
                return Err(not_found("File", &id));
            };
            let access = caller.drive_access().await?;
            check_editable(
                file_role(&access, &DriveFileRef::from_row(&trashed)),
                "File",
                &id,
            )?;
            let snapshot_keys =
                files_db::list_document_snapshot_keys(&caller.db, std::slice::from_ref(&id))
                    .await?;
            let Some(row) = files_db::purge_file(&caller.db, &id).await? else {
                return Err(not_found("File", &id));
            };
            let mut keys: Vec<String> = files_db::storage_key(&row)
                .map(str::to_owned)
                .into_iter()
                .collect();
            keys.extend(snapshot_keys);
            delete_stored_objects(&caller, &state, keys).await;
            caller.publish(
                &state,
                FILE_PURGED,
                &id,
                &json!({ "id": id, "name": row["fileName"] }),
            );
            ok(json!({ "deleted": true }))
        }
        .await,
        "Failed to permanently delete file",
    )
}

pub(crate) async fn purge_folder(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let Some(folder) = folders_db::trashed_folder(&caller.db, &id).await? else {
                return Err(not_found("Folder", &id));
            };
            // The folders trashed with it go too: restoring it would have
            // brought them back with it.
            let tree = folders_db::trashed_folder_tree(&caller.db, &id).await?;
            let tree_ids: Vec<String> = tree
                .iter()
                .filter_map(|f| text(f, "id").map(str::to_owned))
                .collect();
            let folder_files = folders_db::list_files_in_folders(&caller.db, &tree_ids).await?;
            let access = caller.drive_access().await?;
            check_editable(
                folder_role(&access, &DriveFolderRef::from_row(&folder)),
                "Folder",
                &id,
            )?;
            // The purge takes those folders and every file in them for good,
            // so not one the caller could not delete on its own.
            let locked_folder = tree.iter().any(|f| {
                text(f, "id") != Some(id.as_str())
                    && !can_edit(folder_role(&access, &DriveFolderRef::from_row(f)))
            });
            if locked_folder
                || folder_files
                    .iter()
                    .any(|f| !can_edit(file_role(&access, &DriveFileRef::from_row(f))))
            {
                return Err(forbidden(DRIVE_FOLDER_HOLDS_LOCKED_FILES));
            }
            if caller.files(&state).is_some() {
                let mut keys: Vec<String> = folder_files
                    .iter()
                    .filter_map(|f| files_db::storage_key(f).map(str::to_owned))
                    .collect();
                let ids: Vec<String> = folder_files
                    .iter()
                    .filter_map(|f| text(f, "id").map(str::to_owned))
                    .collect();
                keys.extend(files_db::list_document_snapshot_keys(&caller.db, &ids).await?);
                delete_stored_objects(&caller, &state, keys).await;
            }
            folders_db::purge_folder(&caller.db, &tree_ids).await?;
            caller.publish(
                &state,
                FOLDER_PURGED,
                &id,
                &json!({ "id": id, "name": folder["name"], "parentId": folder["parentId"] }),
            );
            ok(json!({ "deleted": true }))
        }
        .await,
        "Failed to permanently delete folder",
    )
}

pub(crate) async fn empty_trash(State(state): State<CoreFilesState>, caller: Caller) -> Response {
    answer(
        async {
            let db = &caller.db;
            let trashed_files = files_db::list_trashed_files(db).await?;
            let trashed_folders = folders_db::list_trashed_folders(db).await?;
            let access = caller.drive_access().await?;
            let editable_folders: Vec<String> = trashed_folders
                .iter()
                .filter(|f| can_edit(folder_role(&access, &DriveFolderRef::from_row(f))))
                .filter_map(|f| text(f, "id").map(str::to_owned))
                .collect();
            // A folder goes with its files: one holding a file the caller may
            // not change stays in the trash.
            let locked: HashSet<String> = folders_db::list_files_in_folders(db, &editable_folders)
                .await?
                .iter()
                .filter(|f| !can_edit(file_role(&access, &DriveFileRef::from_row(f))))
                .filter_map(|f| text(f, "folderId").map(str::to_owned))
                .collect();
            let file_ids: Vec<String> = trashed_files
                .iter()
                .filter(|f| can_edit(file_role(&access, &DriveFileRef::from_row(f))))
                .filter_map(|f| text(f, "id").map(str::to_owned))
                .collect();
            let folder_ids: Vec<String> = editable_folders
                .into_iter()
                .filter(|id| !locked.contains(id))
                .collect();
            if caller.files(&state).is_some() {
                let keys = folders_db::list_purged_file_keys(db, &file_ids, &folder_ids).await?;
                delete_stored_objects(&caller, &state, keys).await;
            }
            folders_db::purge_trashed(db, &file_ids, &folder_ids).await?;
            ok(json!({ "emptied": true }))
        }
        .await,
        "Failed to empty trash",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_types_and_dates() {
        assert_eq!(guess_file_type(Some("image/png"), None), "image");
        assert_eq!(guess_file_type(Some("text/csv"), None), "spreadsheet");
        assert_eq!(
            guess_file_type(Some("application/octet-stream"), Some("main.RS")),
            "code"
        );
        assert_eq!(guess_file_type(None, Some("a.rs")), "file");
        assert_eq!(locale_date(Some("2026-03-09T23:00:00.000Z")), "3/9/2026");
    }

    #[test]
    fn arrays_page_sort_and_search_like_query_array() {
        let items: Vec<Value> = ["b", "A", "c", "a"]
            .iter()
            .enumerate()
            .map(|(i, name)| json!({ "name": name, "createdAt": format!("2026-01-0{}T00:00:00.000Z", i + 1), "fileType": "file" }))
            .collect();
        let query = ArrayQuery {
            page: 1,
            page_size: 3,
            search: None,
            sort_by: "name",
            descending: false,
            file_type: None,
        };
        let (page, pagination) = query_array(&items, &query);
        let names: Vec<&str> = page.iter().filter_map(|i| i["name"].as_str()).collect();
        assert_eq!(names, ["a", "A", "b"]);
        assert_eq!(pagination["totalPages"], 2);
        assert_eq!(pagination["hasMore"], true);
        let searched = query_array(
            &items,
            &ArrayQuery {
                search: Some(" A "),
                sort_by: "createdAt",
                descending: true,
                ..query
            },
        );
        assert_eq!(searched.0.len(), 2);
        assert_eq!(searched.0[0]["name"], "a");
    }
}
