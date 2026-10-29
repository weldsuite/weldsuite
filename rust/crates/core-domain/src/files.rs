//! WeldDrive's file store (`packages/domains/core/src/files.ts`): the
//! `files` rows behind `/api/files` and the Drive trash. The object store
//! holds the bytes; a row holds the metadata and the storage key.
//!
//! Rows come back as Drizzle returns them ([`js_row`]): camelCase keys, ISO
//! timestamps. Timestamps the TypeScript sets with `new Date()` are passed in
//! as ISO strings, so one request writes one instant.

use serde_json::{Map, Value};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

/// Names compare case-insensitively: "Report.pdf" and "REPORT.PDF" in one
/// folder would overwrite each other once downloaded (`hasFileNameConflict`).
pub async fn has_file_name_conflict(
    db: &PgPool,
    file_name: &str,
    folder_id: Option<&str>,
    exclude_file_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
    // `folderId ? eq(...) : isNull(...)`: an empty id is My Drive too.
    let folder_id = folder_id.filter(|id| !id.is_empty());
    let found: Option<String> = sqlx::query_scalar(
        "select id from files
         where lower(file_name) = lower($1) and deleted_at is null
           and (case when $2::text is null then folder_id is null else folder_id = $2 end)
           and ($3::text is null or id <> $3)
         limit 1",
    )
    .bind(file_name)
    .bind(folder_id)
    .bind(exclude_file_id.filter(|id| !id.is_empty()))
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `name`, or `name (1).ext`, `name (2).ext`, … : the first one free in the
/// folder (`deduplicateFileName`).
pub async fn deduplicate_file_name(
    db: &PgPool,
    file_name: &str,
    folder_id: Option<&str>,
) -> Result<String, sqlx::Error> {
    if !has_file_name_conflict(db, file_name, folder_id, None).await? {
        return Ok(file_name.to_owned());
    }
    // `lastIndexOf('.') > 0`: a leading dot is part of the name.
    let (base, ext) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    };
    let mut n = 1u64;
    loop {
        let candidate = format!("{base} ({n}){ext}");
        if !has_file_name_conflict(db, &candidate, folder_id, None).await? {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// A `files` row by id, live or not.
async fn row_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(f) from files f where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// A live (not trashed) file by id.
pub async fn live_file(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The filters of `GET /api/files` (`ListFilesParams`).
#[derive(Debug, Clone, Default)]
pub struct ListFiles<'a> {
    pub folder_id: Option<&'a str>,
    pub root_only: bool,
    pub file_type: Option<&'a str>,
    pub entity_type: Option<&'a str>,
    pub entity_id: Option<&'a str>,
}

/// Live files, newest first (`listFiles`). Empty filters are no filter, as
/// the TypeScript's `if (params.type)`.
pub async fn list_files(db: &PgPool, params: &ListFiles<'_>) -> Result<Vec<Value>, sqlx::Error> {
    let some = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f
         where deleted_at is null
           and (case when $1::text is not null then folder_id = $1
                     when $2 then folder_id is null
                     else true end)
           and ($3::text is null or file_type = $3)
           and ($4::text is null or entity_type = $4)
           and ($5::text is null or entity_id = $5)
         order by created_at desc",
    )
    .bind(some(params.folder_id))
    .bind(params.root_only)
    .bind(some(params.file_type))
    .bind(some(params.entity_type))
    .bind(some(params.entity_id))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// What `createFile` stores (`CreateFileParams`), already validated.
#[derive(Debug, Clone, Default)]
pub struct NewFile {
    pub file_name: String,
    pub original_name: Option<String>,
    pub mime_type: String,
    pub file_size: i64,
    pub file_type: Option<String>,
    pub storage_path: String,
    pub file_key: Option<String>,
    pub bucket: Option<String>,
    pub url: Option<String>,
    pub thumbnail_url: Option<String>,
    pub folder_id: Option<String>,
    pub is_public: Option<bool>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub metadata: Option<Value>,
    pub uploaded_by_id: String,
}

/// `a || null`: JavaScript's falsy strings (empty) are no value.
fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// Insert a file under a name free in its folder (`createFile`).
pub async fn create_file(db: &PgPool, file: &NewFile, now: &str) -> Result<Value, sqlx::Error> {
    let folder_id = truthy(file.folder_id.as_ref());
    let unique_name = deduplicate_file_name(db, &file.file_name, folder_id).await?;
    let id = generate_id("fil");
    sqlx::query(
        "insert into files (id, file_name, original_name, mime_type, file_size, file_type,
                            storage_path, file_key, bucket, url, thumbnail_url, folder_id,
                            uploaded_by_id, is_public, entity_type, entity_id, metadata,
                            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                 $18::timestamp, $18::timestamp)",
    )
    .bind(&id)
    .bind(&unique_name)
    .bind(truthy(file.original_name.as_ref()).unwrap_or(&file.file_name))
    .bind(&file.mime_type)
    .bind(file.file_size)
    .bind(truthy(file.file_type.as_ref()).unwrap_or("file"))
    .bind(&file.storage_path)
    .bind(truthy(file.file_key.as_ref()))
    .bind(truthy(file.bucket.as_ref()))
    .bind(truthy(file.url.as_ref()))
    .bind(truthy(file.thumbnail_url.as_ref()))
    .bind(folder_id)
    .bind(&file.uploaded_by_id)
    .bind(file.is_public.unwrap_or(false))
    .bind(truthy(file.entity_type.as_ref()))
    .bind(truthy(file.entity_id.as_ref()))
    .bind(file.metadata.clone())
    .bind(now)
    .execute(db)
    .await?;
    Ok(row_by_id(db, &id).await?.unwrap_or(Value::Null))
}

/// A field of an update: left out, or set (to a value or null).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Change<T> {
    #[default]
    Keep,
    Set(T),
}

impl<T> Change<T> {
    pub fn is_set(&self) -> bool {
        matches!(self, Self::Set(_))
    }
}

/// What `updateFile` changes (`UpdateFileParams`).
#[derive(Debug, Clone, Default)]
pub struct FileUpdate {
    pub file_name: Change<String>,
    pub folder_id: Change<Option<String>>,
    pub is_starred: Change<bool>,
    pub is_public: Change<bool>,
    /// The Details panel description, kept in `metadata.description`; null
    /// or `""` clears it.
    pub description: Change<Option<String>>,
    pub general_access: Change<String>,
}

/// How `updateFile` ended.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdatedFile {
    Updated {
        row: Value,
        /// The row before the update, for the event's change list.
        previous: Value,
    },
    NotFound,
    NameConflict,
}

/// The description a file row carries in its metadata (`fileDescription`).
pub fn file_description(row: &Value) -> Option<&str> {
    row["metadata"]["description"]
        .as_str()
        .filter(|description| !description.is_empty())
}

/// Update a live file (`updateFile`).
pub async fn update_file(
    db: &PgPool,
    id: &str,
    update: &FileUpdate,
    now: &str,
) -> Result<UpdatedFile, sqlx::Error> {
    let Some(existing) = live_file(db, id).await? else {
        return Ok(UpdatedFile::NotFound);
    };
    if update.file_name.is_set() || update.folder_id.is_set() {
        let target_name = match &update.file_name {
            Change::Set(name) => name.as_str(),
            Change::Keep => existing["fileName"].as_str().unwrap_or_default(),
        };
        let target_folder = match &update.folder_id {
            Change::Set(folder) => folder.as_deref(),
            Change::Keep => existing["folderId"].as_str(),
        };
        if has_file_name_conflict(db, target_name, target_folder, Some(id)).await? {
            return Ok(UpdatedFile::NameConflict);
        }
    }
    let metadata = match &update.description {
        Change::Keep => None,
        Change::Set(description) => {
            let mut metadata = match &existing["metadata"] {
                Value::Object(fields) => fields.clone(),
                _ => Map::new(),
            };
            metadata.remove("description");
            if let Some(description) = description.as_ref().filter(|d| !d.is_empty()) {
                metadata.insert("description".to_owned(), Value::String(description.clone()));
            }
            Some(Value::Object(metadata))
        }
    };
    let (name_set, name) = match &update.file_name {
        Change::Set(name) => (true, Some(name.as_str())),
        Change::Keep => (false, None),
    };
    let (folder_set, folder) = match &update.folder_id {
        Change::Set(folder) => (true, folder.as_deref()),
        Change::Keep => (false, None),
    };
    let (starred_set, starred) = match update.is_starred {
        Change::Set(flag) => (true, flag),
        Change::Keep => (false, false),
    };
    let (public_set, public) = match update.is_public {
        Change::Set(flag) => (true, flag),
        Change::Keep => (false, false),
    };
    let (access_set, access) = match &update.general_access {
        Change::Set(access) => (true, Some(access.as_str())),
        Change::Keep => (false, None),
    };
    sqlx::query(
        "update files set
             updated_at = $2::timestamp,
             file_name = case when $3 then $4 else file_name end,
             folder_id = case when $5 then $6 else folder_id end,
             is_starred = case when $7 then $8 else is_starred end,
             is_public = case when $9 then $10 else is_public end,
             general_access = case when $11 then $12 else general_access end,
             metadata = case when $13 then $14 else metadata end
         where id = $1",
    )
    .bind(id)
    .bind(now)
    .bind(name_set)
    .bind(name)
    .bind(folder_set)
    .bind(folder)
    .bind(starred_set)
    .bind(starred)
    .bind(public_set)
    .bind(public)
    .bind(access_set)
    .bind(access)
    .bind(metadata.is_some())
    .bind(metadata)
    .execute(db)
    .await?;
    let row = row_by_id(db, id).await?.unwrap_or(Value::Null);
    Ok(UpdatedFile::Updated {
        row,
        previous: existing,
    })
}

/// Trash a live file; the row as it was, or `None` (`softDeleteFile`).
pub async fn soft_delete_file(
    db: &PgPool,
    id: &str,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    sqlx::query(
        "update files set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(Some(existing))
}

/// Record a new size after the content was overwritten (`touchFileSize`).
pub async fn touch_file_size(
    db: &PgPool,
    id: &str,
    file_size: i64,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query("update files set file_size = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(file_size)
        .bind(now)
        .execute(db)
        .await?;
    row_by_id(db, id).await
}

/// Flip a live file's star; the new value and the row with it (`toggleStar`).
pub async fn toggle_star(
    db: &PgPool,
    id: &str,
    now: &str,
) -> Result<Option<(bool, Value)>, sqlx::Error> {
    let Some(mut existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    let next = !existing["isStarred"].as_bool().unwrap_or(false);
    sqlx::query("update files set is_starred = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(next)
        .bind(now)
        .execute(db)
        .await?;
    existing["isStarred"] = Value::Bool(next);
    Ok(Some((next, existing)))
}

/// Flip the workspace-wide pin, recording who pinned it and when
/// (`togglePin`).
pub async fn toggle_pin(
    db: &PgPool,
    id: &str,
    user_id: &str,
    now: &str,
) -> Result<Option<(bool, Value)>, sqlx::Error> {
    let Some(mut existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    let next = !existing["isPinned"].as_bool().unwrap_or(false);
    sqlx::query(
        "update files set
             is_pinned = $2,
             pinned_at = case when $2 then $3::timestamp else null end,
             pinned_by = case when $2 then $4 else null end,
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(next)
    .bind(now)
    .bind(user_id)
    .execute(db)
    .await?;
    existing["isPinned"] = Value::Bool(next);
    Ok(Some((next, existing)))
}

/// How `moveFile` ended.
#[derive(Debug, Clone, PartialEq)]
pub enum MovedFile {
    Moved(Value),
    FileNotFound,
    FolderNotFound,
    NameConflict,
}

/// Move a live file into a live folder, or My Drive (`moveFile`).
pub async fn move_file(
    db: &PgPool,
    id: &str,
    folder_id: Option<&str>,
    now: &str,
) -> Result<MovedFile, sqlx::Error> {
    let Some(existing) = live_file(db, id).await? else {
        return Ok(MovedFile::FileNotFound);
    };
    if let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) {
        let folder: Option<String> = sqlx::query_scalar(
            "select id from folders where id = $1 and deleted_at is null limit 1",
        )
        .bind(folder_id)
        .fetch_optional(db)
        .await?;
        if folder.is_none() {
            return Ok(MovedFile::FolderNotFound);
        }
    }
    let name = existing["fileName"].as_str().unwrap_or_default();
    if has_file_name_conflict(db, name, folder_id, Some(id)).await? {
        return Ok(MovedFile::NameConflict);
    }
    sqlx::query("update files set folder_id = $2, updated_at = $3::timestamp where id = $1")
        .bind(id)
        .bind(folder_id)
        .bind(now)
        .execute(db)
        .await?;
    Ok(MovedFile::Moved(
        row_by_id(db, id).await?.unwrap_or(Value::Null),
    ))
}

// ── Trash ──────────────────────────────────────────────────────────────────

/// Trashed files, most recently trashed first (`listTrashedFiles`).
pub async fn list_trashed_files(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f where deleted_at is not null order by deleted_at desc",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// A trashed file by id (`getTrashedFile`).
pub async fn trashed_file(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f where id = $1 and deleted_at is not null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Take a file out of the trash; the row as it was (`restoreFile`).
pub async fn restore_file(db: &PgPool, id: &str, now: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(existing) = trashed_file(db, id).await? else {
        return Ok(None);
    };
    sqlx::query("update files set deleted_at = null, updated_at = $2::timestamp where id = $1")
        .bind(id)
        .bind(now)
        .execute(db)
        .await?;
    Ok(Some(existing))
}

/// The storage keys behind the spreadsheets and `WeldDocs` documents backed by
/// `file_ids`: each one's checkpoint, every saved version, and the `.xlsx` an
/// old project sheet was converted from (`listDocumentSnapshotKeys`). Purging
/// removes those rows, so list the keys first.
pub async fn list_document_snapshot_keys(
    db: &PgPool,
    file_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<Option<String>> = sqlx::query_scalar(
        "select key from (
             select 1 as part, snapshot_key as key from sheets where file_id = any($1)
             union all
             select 2, snapshot_key from docs where file_id = any($1)
             union all
             select 3, v.snapshot_key from doc_versions v join docs d on d.id = v.doc_id
              where d.file_id = any($1)
             union all
             select 4, v.snapshot_key from sheet_versions v join sheets s on s.id = v.sheet_id
              where s.file_id = any($1)
             union all
             select 5, metadata->'convertedFrom'->>'key' from files
              where id = any($1) and metadata->'convertedFrom'->>'key' is not null
         ) k order by part",
    )
    .bind(file_ids)
    .fetch_all(db)
    .await?;
    let mut seen = std::collections::HashSet::new();
    Ok(keys
        .into_iter()
        .flatten()
        .filter(|key| !key.is_empty() && seen.insert(key.clone()))
        .collect())
}

/// Delete a trashed file for good, with the spreadsheet or document rows
/// that reference it; the row as it was (`purgeFile`).
pub async fn purge_file(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let Some(existing) = trashed_file(db, id).await? else {
        return Ok(None);
    };
    sqlx::query("delete from sheets where file_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    sqlx::query("delete from document_versions where file_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    sqlx::query("delete from docs where file_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    sqlx::query("delete from files where id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(Some(existing))
}

/// A row's storage key: `fileKey || storagePath`.
pub fn storage_key(row: &Value) -> Option<&str> {
    [&row["fileKey"], &row["storagePath"]]
        .into_iter()
        .filter_map(Value::as_str)
        .find(|key| !key.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn descriptions_and_keys() {
        assert_eq!(
            file_description(&json!({ "metadata": { "description": "<p>x</p>" } })),
            Some("<p>x</p>")
        );
        assert_eq!(
            file_description(&json!({ "metadata": { "description": "" } })),
            None
        );
        assert_eq!(file_description(&json!({ "metadata": null })), None);
        assert_eq!(
            storage_key(&json!({ "fileKey": "", "storagePath": "a/b" })),
            Some("a/b")
        );
        assert_eq!(
            storage_key(&json!({ "fileKey": "k", "storagePath": "a/b" })),
            Some("k")
        );
        assert_eq!(
            storage_key(&json!({ "fileKey": null, "storagePath": "" })),
            None
        );
    }
}
