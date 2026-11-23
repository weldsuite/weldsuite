//! WeldDrive's file store (`packages/domains/core/src/files.ts`): the
//! `files` rows behind `/api/files` and the Drive trash. The object store
//! holds the bytes; a row holds the metadata and the storage key.
//!
//! Rows come back as Drizzle returns them (the `files` entity): camelCase
//! keys, ISO timestamps. Timestamps the TypeScript sets with `new Date()` are
//! passed in as ISO strings, so one request writes one instant.

use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, JoinType,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    board_versions, doc_versions, docs, document_versions, files as files_table, sheet_versions,
    sheets, whiteboards,
};

/// A row as Drizzle returns it: the entity serializes as the TypeScript
/// route's JSON.
pub(crate) fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `$n::timestamptz` of a `toISOString()` the route wrote. A text Postgres
/// can't read is the failed cast (the route's 500).
pub(crate) fn timestamptz_of(iso: &str) -> Result<OffsetDateTime, DbErr> {
    OffsetDateTime::parse(iso, &Rfc3339).map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp with time zone: \"{iso}\""
        ))
    })
}

/// `$n::timestamp` of a `toISOString()` the route wrote: Postgres reads its
/// date and time and ignores the zone. A text Postgres can't read is the
/// failed cast (the route's 500).
pub(crate) fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    let at = OffsetDateTime::parse(iso, &Rfc3339).map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{iso}\""
        ))
    })?;
    Ok(PrimitiveDateTime::new(at.date(), at.time()))
}

/// Names compare case-insensitively: "Report.pdf" and "REPORT.PDF" in one
/// folder would overwrite each other once downloaded (`hasFileNameConflict`).
pub async fn has_file_name_conflict(
    db: &PgPool,
    file_name: &str,
    folder_id: Option<&str>,
    exclude_file_id: Option<&str>,
) -> Result<bool, DbErr> {
    // `folderId ? eq(...) : isNull(...)`: an empty id is My Drive too.
    let folder_id = folder_id.filter(|id| !id.is_empty());
    // `lower(file_name) = lower($1)`
    let mut condition = Condition::all()
        .add(sea_orm::ExprTrait::eq(
            Expr::expr(Func::lower(Expr::col(files_table::Column::FileName))),
            Func::lower(Expr::val(file_name)),
        ))
        .add(files_table::Column::DeletedAt.is_null())
        .add(match folder_id {
            Some(folder_id) => files_table::Column::FolderId.eq(folder_id),
            None => files_table::Column::FolderId.is_null(),
        });
    if let Some(exclude) = exclude_file_id.filter(|id| !id.is_empty()) {
        condition = condition.add(files_table::Column::Id.ne(exclude));
    }
    let found: Option<String> = files_table::Entity::find()
        .select_only()
        .column(files_table::Column::Id)
        .filter(condition)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `name`, or `name (1).ext`, `name (2).ext`, … : the first one free in the
/// folder (`deduplicateFileName`).
pub async fn deduplicate_file_name(
    db: &PgPool,
    file_name: &str,
    folder_id: Option<&str>,
) -> Result<String, DbErr> {
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

/// The first `files` row matching `condition`, as Drizzle returns it.
async fn file_row(db: &DatabaseConnection, condition: Condition) -> Result<Option<Value>, DbErr> {
    files_table::Entity::find()
        .filter(condition)
        .one(db)
        .await?
        .map(js)
        .transpose()
}

/// A `files` row by id, live or not.
async fn row_by_id(db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
    file_row(db, Condition::all().add(files_table::Column::Id.eq(id))).await
}

/// A live (not trashed) file by id.
pub async fn live_file(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    file_row(
        &orm(db),
        Condition::all()
            .add(files_table::Column::Id.eq(id))
            .add(files_table::Column::DeletedAt.is_null()),
    )
    .await
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
pub async fn list_files(db: &PgPool, params: &ListFiles<'_>) -> Result<Vec<Value>, DbErr> {
    let some = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    let mut condition = Condition::all().add(files_table::Column::DeletedAt.is_null());
    if let Some(folder_id) = some(params.folder_id) {
        condition = condition.add(files_table::Column::FolderId.eq(folder_id));
    } else if params.root_only {
        condition = condition.add(files_table::Column::FolderId.is_null());
    }
    if let Some(file_type) = some(params.file_type) {
        condition = condition.add(files_table::Column::FileType.eq(file_type));
    }
    if let Some(entity_type) = some(params.entity_type) {
        condition = condition.add(files_table::Column::EntityType.eq(entity_type));
    }
    if let Some(entity_id) = some(params.entity_id) {
        condition = condition.add(files_table::Column::EntityId.eq(entity_id));
    }
    files_table::Entity::find()
        .filter(condition)
        .order_by_desc(files_table::Column::CreatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect()
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

/// `file_size` as the `integer` column takes it: Postgres refuses a size
/// outside its range.
fn file_size(size: i64) -> Result<i32, DbErr> {
    i32::try_from(size).map_err(|_| DbErr::Custom("integer out of range".to_owned()))
}

/// Insert a file under a name free in its folder (`createFile`).
pub async fn create_file(db: &PgPool, file: &NewFile, now: &str) -> Result<Value, DbErr> {
    let folder_id = truthy(file.folder_id.as_ref());
    let unique_name = deduplicate_file_name(db, &file.file_name, folder_id).await?;
    let id = generate_id("fil");
    let text = |value: Option<&String>| truthy(value).map(str::to_owned);
    let now = timestamp_of(now)?;
    let db = orm(db);
    files_table::Entity::insert(files_table::ActiveModel {
        id: Set(id.clone()),
        file_name: Set(unique_name),
        original_name: Set(Some(
            truthy(file.original_name.as_ref())
                .unwrap_or(&file.file_name)
                .to_owned(),
        )),
        mime_type: Set(file.mime_type.clone()),
        file_size: Set(file_size(file.file_size)?),
        file_type: Set(truthy(file.file_type.as_ref()).unwrap_or("file").to_owned()),
        storage_path: Set(file.storage_path.clone()),
        file_key: Set(text(file.file_key.as_ref())),
        bucket: Set(text(file.bucket.as_ref())),
        url: Set(text(file.url.as_ref())),
        thumbnail_url: Set(text(file.thumbnail_url.as_ref())),
        folder_id: Set(folder_id.map(str::to_owned)),
        uploaded_by_id: Set(Some(file.uploaded_by_id.clone())),
        is_public: Set(file.is_public.unwrap_or(false)),
        entity_type: Set(text(file.entity_type.as_ref())),
        entity_id: Set(text(file.entity_id.as_ref())),
        metadata: Set(file.metadata.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(row_by_id(&db, &id).await?.unwrap_or(Value::Null))
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
) -> Result<UpdatedFile, DbErr> {
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
    let mut query = files_table::Entity::update_many().col_expr(
        files_table::Column::UpdatedAt,
        Expr::value(timestamp_of(now)?),
    );
    if let Change::Set(name) = &update.file_name {
        query = query.col_expr(files_table::Column::FileName, Expr::value(name.as_str()));
    }
    if let Change::Set(folder) = &update.folder_id {
        query = query.col_expr(files_table::Column::FolderId, Expr::value(folder.clone()));
    }
    if let Change::Set(starred) = update.is_starred {
        query = query.col_expr(files_table::Column::IsStarred, Expr::value(starred));
    }
    if let Change::Set(public) = update.is_public {
        query = query.col_expr(files_table::Column::IsPublic, Expr::value(public));
    }
    if let Change::Set(access) = &update.general_access {
        query = query.col_expr(
            files_table::Column::GeneralAccess,
            Expr::value(access.as_str()),
        );
    }
    if let Some(metadata) = metadata {
        query = query.col_expr(files_table::Column::Metadata, Expr::value(metadata));
    }
    let db = orm(db);
    query
        .filter(files_table::Column::Id.eq(id))
        .exec(&db)
        .await?;
    let row = row_by_id(&db, id).await?.unwrap_or(Value::Null);
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
) -> Result<Option<Value>, DbErr> {
    let Some(existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    let now = timestamp_of(now)?;
    files_table::Entity::update_many()
        .col_expr(files_table::Column::DeletedAt, Expr::value(now))
        .col_expr(files_table::Column::UpdatedAt, Expr::value(now))
        .filter(files_table::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(Some(existing))
}

/// Record a new size after the content was overwritten (`touchFileSize`).
pub async fn touch_file_size(
    db: &PgPool,
    id: &str,
    file_size: i64,
    now: &str,
) -> Result<Option<Value>, DbErr> {
    let db = orm(db);
    files_table::Entity::update_many()
        .col_expr(
            files_table::Column::FileSize,
            Expr::value(self::file_size(file_size)?),
        )
        .col_expr(files_table::Column::UpdatedAt, Expr::value(timestamp_of(now)?))
        .filter(files_table::Column::Id.eq(id))
        .exec(&db)
        .await?;
    row_by_id(&db, id).await
}

/// Flip a live file's star; the new value and the row with it (`toggleStar`).
pub async fn toggle_star(
    db: &PgPool,
    id: &str,
    now: &str,
) -> Result<Option<(bool, Value)>, DbErr> {
    let Some(mut existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    let next = !existing["isStarred"].as_bool().unwrap_or(false);
    files_table::Entity::update_many()
        .col_expr(files_table::Column::IsStarred, Expr::value(next))
        .col_expr(files_table::Column::UpdatedAt, Expr::value(timestamp_of(now)?))
        .filter(files_table::Column::Id.eq(id))
        .exec(&orm(db))
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
) -> Result<Option<(bool, Value)>, DbErr> {
    let Some(mut existing) = live_file(db, id).await? else {
        return Ok(None);
    };
    let next = !existing["isPinned"].as_bool().unwrap_or(false);
    let now = timestamp_of(now)?;
    files_table::Entity::update_many()
        .col_expr(files_table::Column::IsPinned, Expr::value(next))
        .col_expr(
            files_table::Column::PinnedAt,
            Expr::value(next.then_some(now)),
        )
        .col_expr(
            files_table::Column::PinnedBy,
            Expr::value(next.then(|| user_id.to_owned())),
        )
        .col_expr(files_table::Column::UpdatedAt, Expr::value(now))
        .filter(files_table::Column::Id.eq(id))
        .exec(&orm(db))
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
) -> Result<MovedFile, DbErr> {
    use weldsuite_schema::tenant::folders;

    let Some(existing) = live_file(db, id).await? else {
        return Ok(MovedFile::FileNotFound);
    };
    if let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) {
        let folder: Option<String> = folders::Entity::find()
            .select_only()
            .column(folders::Column::Id)
            .filter(folders::Column::Id.eq(folder_id))
            .filter(folders::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        if folder.is_none() {
            return Ok(MovedFile::FolderNotFound);
        }
    }
    let name = existing["fileName"].as_str().unwrap_or_default();
    if has_file_name_conflict(db, name, folder_id, Some(id)).await? {
        return Ok(MovedFile::NameConflict);
    }
    let db = orm(db);
    files_table::Entity::update_many()
        .col_expr(
            files_table::Column::FolderId,
            Expr::value(folder_id.map(str::to_owned)),
        )
        .col_expr(files_table::Column::UpdatedAt, Expr::value(timestamp_of(now)?))
        .filter(files_table::Column::Id.eq(id))
        .exec(&db)
        .await?;
    Ok(MovedFile::Moved(
        row_by_id(&db, id).await?.unwrap_or(Value::Null),
    ))
}

// ── Trash ──────────────────────────────────────────────────────────────────

/// Trashed files, most recently trashed first (`listTrashedFiles`).
pub async fn list_trashed_files(db: &PgPool) -> Result<Vec<Value>, DbErr> {
    files_table::Entity::find()
        .filter(files_table::Column::DeletedAt.is_not_null())
        .order_by_desc(files_table::Column::DeletedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect()
}

/// A trashed file by id (`getTrashedFile`).
pub async fn trashed_file(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    file_row(
        &orm(db),
        Condition::all()
            .add(files_table::Column::Id.eq(id))
            .add(files_table::Column::DeletedAt.is_not_null()),
    )
    .await
}

/// Take a file out of the trash; the row as it was (`restoreFile`).
pub async fn restore_file(db: &PgPool, id: &str, now: &str) -> Result<Option<Value>, DbErr> {
    let Some(existing) = trashed_file(db, id).await? else {
        return Ok(None);
    };
    files_table::Entity::update_many()
        .col_expr(
            files_table::Column::DeletedAt,
            Expr::value(None::<PrimitiveDateTime>),
        )
        .col_expr(files_table::Column::UpdatedAt, Expr::value(timestamp_of(now)?))
        .filter(files_table::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(Some(existing))
}

/// The storage keys behind the spreadsheets, `WeldDocs` documents and
/// `WeldBoard` boards backed by `file_ids`: each one's checkpoint, every saved
/// version, a board's thumbnail, and the `.xlsx` an old project sheet was
/// converted from (`listDocumentSnapshotKeys`). Purging removes those rows, so
/// list the keys first.
pub async fn list_document_snapshot_keys(
    db: &PgPool,
    file_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let db = orm(db);
    // The parts of the TypeScript's `union all`, in its order.
    let mut keys = Vec::new();
    keys.extend(sheet_keys(&db, file_ids).await?);
    keys.extend(doc_keys(&db, file_ids).await?);
    keys.extend(doc_version_keys(&db, file_ids).await?);
    keys.extend(sheet_version_keys(&db, file_ids).await?);
    keys.extend(converted_from_keys(&db, file_ids).await?);
    let boards = board_keys(&db, file_ids).await?;
    // `regexp_replace(snapshot_key, '[^/]*$', 'thumbnail.svg')`: the board's
    // thumbnail sits next to its checkpoint.
    let thumbnails: Vec<Option<String>> = boards
        .iter()
        .flatten()
        .map(|key| {
            let folder = key.rfind('/').map_or("", |slash| &key[..=slash]);
            Some(format!("{folder}thumbnail.svg"))
        })
        .collect();
    keys.extend(boards);
    keys.extend(thumbnails);
    keys.extend(board_version_keys(&db, file_ids).await?);
    let mut seen = std::collections::HashSet::new();
    Ok(keys
        .into_iter()
        .flatten()
        .filter(|key| !key.is_empty() && seen.insert(key.clone()))
        .collect())
}

/// `select snapshot_key from sheets where file_id = any($1)`.
async fn sheet_keys(db: &DatabaseConnection, file_ids: &[String]) -> Result<Vec<Option<String>>, DbErr> {
    sheets::Entity::find()
        .select_only()
        .column(sheets::Column::SnapshotKey)
        .filter(sheets::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// `select snapshot_key from docs where file_id = any($1)`.
async fn doc_keys(db: &DatabaseConnection, file_ids: &[String]) -> Result<Vec<Option<String>>, DbErr> {
    docs::Entity::find()
        .select_only()
        .column(docs::Column::SnapshotKey)
        .filter(docs::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// Every saved version of the documents.
async fn doc_version_keys(
    db: &DatabaseConnection,
    file_ids: &[String],
) -> Result<Vec<Option<String>>, DbErr> {
    doc_versions::Entity::find()
        .select_only()
        .column(doc_versions::Column::SnapshotKey)
        .join(
            JoinType::InnerJoin,
            doc_versions::Entity::belongs_to(docs::Entity)
                .from(doc_versions::Column::DocId)
                .to(docs::Column::Id)
                .into(),
        )
        .filter(docs::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// Every saved version of the spreadsheets.
async fn sheet_version_keys(
    db: &DatabaseConnection,
    file_ids: &[String],
) -> Result<Vec<Option<String>>, DbErr> {
    sheet_versions::Entity::find()
        .select_only()
        .column(sheet_versions::Column::SnapshotKey)
        .join(
            JoinType::InnerJoin,
            sheet_versions::Entity::belongs_to(sheets::Entity)
                .from(sheet_versions::Column::SheetId)
                .to(sheets::Column::Id)
                .into(),
        )
        .filter(sheets::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// The `.xlsx` an old project sheet was converted from:
/// `metadata->'convertedFrom'->>'key'`, where there is one.
async fn converted_from_keys(
    db: &DatabaseConnection,
    file_ids: &[String],
) -> Result<Vec<Option<String>>, DbErr> {
    let key = || {
        PgExpr::cast_json_field(
            PgExpr::get_json_field(Expr::col(files_table::Column::Metadata), "convertedFrom"),
            "key",
        )
    };
    files_table::Entity::find()
        .select_only()
        .column_as(key(), "key")
        .filter(files_table::Column::Id.is_in(file_ids))
        .filter(sea_orm::ExprTrait::is_not_null(key()))
        .into_tuple()
        .all(db)
        .await
}

/// `select snapshot_key from whiteboards where file_id = any($1)`.
async fn board_keys(db: &DatabaseConnection, file_ids: &[String]) -> Result<Vec<Option<String>>, DbErr> {
    whiteboards::Entity::find()
        .select_only()
        .column(whiteboards::Column::SnapshotKey)
        .filter(whiteboards::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// Every saved version of the boards.
async fn board_version_keys(
    db: &DatabaseConnection,
    file_ids: &[String],
) -> Result<Vec<Option<String>>, DbErr> {
    board_versions::Entity::find()
        .select_only()
        .column(board_versions::Column::SnapshotKey)
        .join(
            JoinType::InnerJoin,
            board_versions::Entity::belongs_to(whiteboards::Entity)
                .from(board_versions::Column::BoardId)
                .to(whiteboards::Column::Id)
                .into(),
        )
        .filter(whiteboards::Column::FileId.is_in(file_ids))
        .into_tuple()
        .all(db)
        .await
}

/// Delete a trashed file for good, with the spreadsheet, document or board
/// rows that reference it; the row as it was (`purgeFile`).
pub async fn purge_file(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let Some(existing) = trashed_file(db, id).await? else {
        return Ok(None);
    };
    let db = orm(db);
    sheets::Entity::delete_many()
        .filter(sheets::Column::FileId.eq(id))
        .exec(&db)
        .await?;
    whiteboards::Entity::delete_many()
        .filter(whiteboards::Column::FileId.eq(id))
        .exec(&db)
        .await?;
    document_versions::Entity::delete_many()
        .filter(document_versions::Column::FileId.eq(id))
        .exec(&db)
        .await?;
    docs::Entity::delete_many()
        .filter(docs::Column::FileId.eq(id))
        .exec(&db)
        .await?;
    files_table::Entity::delete_many()
        .filter(files_table::Column::Id.eq(id))
        .exec(&db)
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
