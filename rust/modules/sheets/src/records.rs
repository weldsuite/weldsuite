//! Spreadsheet records (`services/sheets.ts`), versions (`services/versions.ts`)
//! and connected tables (`services/data-sources/sources.ts`): a drive `files`
//! row paired with a `sheets` row.

use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
    TransactionTrait,
};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_schema::tenant::{
    files, sheet_data_sources, sheet_versions, sheets, workspace_members,
};

/// The mime type of a WeldSheets file (`WELDSHEET_MIME_TYPE`).
pub(crate) const WELDSHEET_MIME_TYPE: &str = "application/vnd.weldsuite.spreadsheet";

/// `files.entity_type` of a WeldFlow project's files (`PROJECT_ENTITY`).
pub(crate) const PROJECT_ENTITY: &str = "project";

/// A spreadsheet with what drive access needs to know about its file.
#[derive(Debug, Clone)]
pub(crate) struct SheetRecord {
    pub(crate) id: String,
    pub(crate) file_id: String,
    pub(crate) name: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) created_at: Value,
    pub(crate) updated_at: Value,
    pub(crate) created_by_id: Option<String>,
    pub(crate) updated_by_id: Option<String>,
    pub(crate) snapshot_key: Option<String>,
    /// The WeldFlow project the sheet belongs to, or `None`.
    pub(crate) project_id: Option<String>,
    pub(crate) file: DriveFileRef,
}

/// A `timestamp` as the `Date` Drizzle read it prints (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// A row in the JSON Drizzle gave it (`to_jsonb`): the entity serializes as
/// Drizzle did.
fn js(row: impl serde::Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

/// A version's `toISOString()` stamp as the `timestamp` it names, as
/// Postgres reads `'…Z'::timestamp`.
fn timestamp_of(stamp: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(stamp, &time::format_description::well_known::Rfc3339)
        .map(utc_timestamp)
        .map_err(|error| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: {stamp:?} ({error})"
            ))
        })
}

/// A row count as the `count(*)::bigint` it was.
fn count_of(count: u64) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

/// A `limit` / `offset` as SeaQuery takes it (the routes never send a
/// negative one).
fn rows_of(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// `DriveFileRef` as the room and the engine take it.
pub(crate) fn file_ref_json(file: &DriveFileRef) -> Value {
    json!({
        "id": file.id,
        "uploadedById": file.uploaded_by_id,
        "folderId": file.folder_id,
        "generalAccess": file.general_access.as_str(),
        "entityType": file.entity_type,
    })
}

/// The project a file with this `entity_type` and `entity_id` belongs to.
fn project_of(entity_type: Option<&str>, entity_id: Option<String>) -> Option<String> {
    (entity_type == Some(PROJECT_ENTITY))
        .then_some(entity_id)
        .flatten()
}

/// The columns of a [`SheetRecord`], on `sheets` joined with `files`.
#[derive(Debug, FromQueryResult)]
struct SheetRow {
    id: String,
    file_id: String,
    name: String,
    folder_id: Option<String>,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    created_by_id: Option<String>,
    updated_by_id: Option<String>,
    snapshot_key: Option<String>,
    general_access: String,
    entity_type: Option<String>,
    entity_id: Option<String>,
}

impl SheetRecord {
    fn from_row(row: SheetRow) -> Self {
        let project_id = project_of(row.entity_type.as_deref(), row.entity_id);
        let file = DriveFileRef {
            id: row.file_id.clone(),
            uploaded_by_id: row.created_by_id.clone(),
            folder_id: row.folder_id.clone(),
            general_access: DriveGeneralAccess::parse(&row.general_access),
            entity_type: row.entity_type,
        };
        Self {
            id: row.id,
            name: row.name,
            folder_id: row.folder_id,
            created_at: Value::String(iso(row.created_at)),
            updated_at: Value::String(iso(row.updated_at)),
            created_by_id: row.created_by_id,
            updated_by_id: row.updated_by_id,
            snapshot_key: row.snapshot_key,
            project_id,
            file,
            file_id: row.file_id,
        }
    }

    /// `toSummary(sheet, role, mayEdit)`.
    pub(crate) fn summary(&self, role: DriveRole, may_edit: bool) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "folderId": self.folder_id,
            "projectId": self.project_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "createdById": self.created_by_id,
            "updatedById": self.updated_by_id,
            "role": role.as_str(),
            "canEdit": may_edit && matches!(role, DriveRole::Owner | DriveRole::Editor),
        })
    }

    /// `eventData(sheet)`.
    pub(crate) fn event_data(&self) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "updatedById": self.updated_by_id,
        })
    }

    /// The `file` event's data (`{ id, name, folderId, fileType }`).
    pub(crate) fn file_event_data(&self) -> Value {
        json!({
            "id": self.file_id,
            "name": self.name,
            "folderId": self.folder_id,
            "fileType": "spreadsheet",
        })
    }

    /// `roomMeta(sheet, workspaceId)`.
    pub(crate) fn room_meta(&self, workspace: &str) -> Value {
        json!({
            "workspaceId": workspace,
            "sheetId": self.id,
            "snapshotKey": self
                .snapshot_key
                .clone()
                .unwrap_or_else(|| snapshot_key_for(workspace, &self.id)),
        })
    }
}

/// The room of a sheet: one per sheet, named by workspace and id.
pub(crate) fn room_name(workspace: &str, sheet_id: &str) -> String {
    format!("{workspace}:{sheet_id}")
}

/// The key a sheet's checkpoints are written to (`snapshotKeyFor`).
pub(crate) fn snapshot_key_for(workspace: &str, sheet_id: &str) -> String {
    format!("workspaces/{workspace}/sheets/{sheet_id}/workbook.json.gz")
}

/// Where a version's snapshot goes, next to the checkpoint (`versionKeyFor`).
pub(crate) fn version_key_for(sheet_snapshot_key: &str, version_id: &str) -> String {
    let head = sheet_snapshot_key
        .rfind('/')
        .map_or("", |slash| &sheet_snapshot_key[..=slash]);
    format!("{head}versions/{version_id}.json.gz")
}

/// `join(files, eq(files.id, sheets.fileId))`.
fn sheet_file() -> RelationDef {
    sheets::Entity::belongs_to(files::Entity)
        .from(sheets::Column::FileId)
        .to(files::Column::Id)
        .into()
}

/// `greatest(s.updated_at, f.updated_at)`: when the sheet or its file last
/// changed.
fn changed() -> Expr {
    Func::greatest([
        Expr::col((sheets::Entity, sheets::Column::UpdatedAt)),
        Expr::col((files::Entity, files::Column::UpdatedAt)),
    ])
    .into()
}

/// The [`SheetRow`] columns of `sheets` joined with `files`.
fn sheet_rows() -> Select<sheets::Entity> {
    sheets::Entity::find()
        .select_only()
        .columns([sheets::Column::Id, sheets::Column::FileId])
        .column_as(files::Column::FileName, "name")
        .column(files::Column::FolderId)
        .column(sheets::Column::CreatedAt)
        .column_as(changed(), "updated_at")
        .column_as(files::Column::UploadedById, "created_by_id")
        .columns([sheets::Column::UpdatedById, sheets::Column::SnapshotKey])
        .columns([
            files::Column::GeneralAccess,
            files::Column::EntityType,
            files::Column::EntityId,
        ])
        .join(JoinType::InnerJoin, sheet_file())
}

/// `visibleFilesCondition`: a project's file, the caller's own, one shared
/// with them, one in a folder that grants them a role, or one open to the
/// workspace outside any folder or in an open one.
fn visible_condition(visible: &VisibleFiles) -> Condition {
    let mut any = Condition::any().add(files::Column::EntityType.is_not_null());
    if let Some(user_id) = &visible.user_id {
        any = any.add(files::Column::UploadedById.eq(user_id));
    }
    // `= any('{}')` matches nothing: an empty list adds no way in.
    if !visible.file_share_ids.is_empty() {
        any = any.add(files::Column::Id.is_in(&visible.file_share_ids));
    }
    if !visible.granted_folder_ids.is_empty() {
        any = any.add(files::Column::FolderId.is_in(&visible.granted_folder_ids));
    }
    let mut folder = Condition::any().add(files::Column::FolderId.is_null());
    if !visible.open_folder_ids.is_empty() {
        folder = folder.add(files::Column::FolderId.is_in(&visible.open_folder_ids));
    }
    any.add(
        Condition::all()
            .add(files::Column::GeneralAccess.ne("restricted"))
            .add(folder),
    )
}

/// The list's filters.
pub(crate) struct ListSheets {
    /// `None` for an admin, or for a project's sheets.
    pub(crate) visible: Option<VisibleFiles>,
    /// The `ilike` pattern, already escaped and wrapped in `%`.
    pub(crate) search: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) limit: i64,
    pub(crate) offset: i64,
}

/// `listSheets`' filter on `sheets` ⨝ `files`: not trashed, the project's
/// (or no project's), visible on the drive, matching the search.
fn listed(params: &ListSheets) -> Condition {
    let condition = Condition::all().add(files::Column::DeletedAt.is_null());
    let mut condition = match &params.project_id {
        None => condition.add(files::Column::EntityType.is_null()),
        Some(project_id) => condition
            .add(files::Column::EntityType.eq(PROJECT_ENTITY))
            .add(files::Column::EntityId.eq(project_id)),
    };
    if let Some(visible) = &params.visible {
        condition = condition.add(visible_condition(visible));
    }
    if let Some(search) = &params.search {
        condition = condition.add(files::Column::FileName.ilike(search));
    }
    condition
}

/// Sheets not in the trash, most recently changed first (`listSheets`).
pub(crate) async fn list_sheets(
    db: &PgPool,
    params: &ListSheets,
) -> Result<(Vec<SheetRecord>, i64), DbErr> {
    let db = &orm(db);
    let filter = listed(params);
    let rows = sheet_rows()
        .filter(filter.clone())
        .order_by_desc(changed())
        .order_by_desc(sheets::Column::Id)
        .limit(rows_of(params.limit))
        .offset(rows_of(params.offset))
        .into_model::<SheetRow>()
        .all(db)
        .await?;
    let total = sheets::Entity::find()
        .join(JoinType::InnerJoin, sheet_file())
        .filter(filter)
        .count(db)
        .await?;
    Ok((
        rows.into_iter().map(SheetRecord::from_row).collect(),
        count_of(total),
    ))
}

/// A sheet not in the trash (`getSheet`).
pub(crate) async fn get_sheet(db: &PgPool, id: &str) -> Result<Option<SheetRecord>, DbErr> {
    let row = sheet_rows()
        .filter(sheets::Column::Id.eq(id))
        .filter(files::Column::DeletedAt.is_null())
        .into_model::<SheetRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(SheetRecord::from_row))
}

/// A new `sheets` row at revision 0.
fn new_sheet(
    id: &str,
    file_id: &str,
    snapshot_key: &str,
    user_id: &str,
    now: PrimitiveDateTime,
) -> sheets::ActiveModel {
    sheets::ActiveModel {
        id: Set(id.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        file_id: Set(file_id.to_owned()),
        revision: Set(0),
        snapshot_key: Set(Some(snapshot_key.to_owned())),
        snapshot_revision: Set(0),
        updated_by_id: Set(Some(user_id.to_owned())),
    }
}

/// The `sheets` row of a new sheet (`createSheet`, after its drive file).
pub(crate) async fn insert_sheet(
    db: &PgPool,
    id: &str,
    file_id: &str,
    snapshot_key: &str,
    user_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    sheets::Entity::insert(new_sheet(id, file_id, snapshot_key, user_id, now))
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// A drive file with what importing or converting it needs (`getDriveFile`).
#[derive(Debug, Clone)]
pub(crate) struct DriveFileRecord {
    pub(crate) name: String,
    pub(crate) size: i64,
    /// Where its bytes are (`fileKey || storagePath`).
    pub(crate) key: String,
    /// Set when the file is itself a spreadsheet.
    pub(crate) weldsheet_id: Option<String>,
    pub(crate) project_id: Option<String>,
    pub(crate) file_type: String,
    pub(crate) file: DriveFileRef,
}

/// A drive file not in the trash (`getDriveFile`).
pub(crate) async fn get_drive_file(
    db: &PgPool,
    id: &str,
) -> Result<Option<DriveFileRecord>, DbErr> {
    let file = files::Entity::find_by_id(id.to_owned())
        .filter(files::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(file.map(|file| {
        let key = file
            .file_key
            .filter(|key| !key.is_empty())
            .unwrap_or(file.storage_path);
        let weldsheet_id = file
            .metadata
            .as_ref()
            .and_then(|metadata| metadata["weldsheetId"].as_str())
            .map(str::to_owned);
        DriveFileRecord {
            name: file.file_name,
            size: i64::from(file.file_size),
            key,
            weldsheet_id,
            project_id: project_of(file.entity_type.as_deref(), file.entity_id),
            file_type: file.file_type,
            file: DriveFileRef {
                id: file.id,
                uploaded_by_id: file.uploaded_by_id,
                folder_id: file.folder_id,
                general_access: DriveGeneralAccess::parse(&file.general_access),
                entity_type: file.entity_type,
            },
        }
    }))
}

/// Makes an existing drive file a spreadsheet, in place (`adoptFileAsSheet`):
/// both statements in one transaction, the insert only when the update just
/// made the file point at this sheet. `None` when someone else converted it
/// first.
pub(crate) struct AdoptFile<'a> {
    pub(crate) file_id: &'a str,
    pub(crate) sheet_id: &'a str,
    pub(crate) snapshot_key: &'a str,
    pub(crate) name: &'a str,
    pub(crate) snapshot_size: i64,
    pub(crate) user_id: &'a str,
    pub(crate) old_key: &'a str,
}

pub(crate) async fn adopt_file_as_sheet(
    db: &PgPool,
    params: &AdoptFile<'_>,
    at: OffsetDateTime,
) -> Result<Option<SheetRecord>, DbErr> {
    use files::Column;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let now = utc_timestamp(at);
    let converted = json!({
        "weldsheetId": params.sheet_id,
        "convertedFrom": { "key": params.old_key, "at": iso_timestamp(at) },
    });
    let metadata = || Expr::col((files::Entity, Column::Metadata));
    let tx = orm(db).begin().await?;
    let adopted = files::Entity::update_many()
        .col_expr(Column::FileName, Expr::value(params.name))
        .col_expr(Column::MimeType, Expr::value(WELDSHEET_MIME_TYPE))
        // Bound as the `bigint` it was; Postgres narrows it to the column.
        .col_expr(Column::FileSize, Expr::value(params.snapshot_size))
        .col_expr(Column::StoragePath, Expr::value(params.snapshot_key))
        .col_expr(Column::FileKey, Expr::value(params.snapshot_key))
        .col_expr(Column::Bucket, Expr::value("private"))
        .col_expr(Column::Url, Expr::value(Option::<String>::None))
        // `coalesce(metadata, '{}'::jsonb) || $6::jsonb`
        .col_expr(
            Column::Metadata,
            PgExpr::concat(
                Expr::from(Func::coalesce([metadata(), Expr::val(json!({}))])),
                Expr::val(converted),
            ),
        )
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(params.file_id))
        .filter(sea_orm::ExprTrait::is_null(PgExpr::cast_json_field(
            metadata(),
            "weldsheetId",
        )))
        .exec(&tx)
        .await?;
    // A fresh sheet id: only this update can have pointed the file at it.
    if adopted.rows_affected > 0 {
        sheets::Entity::insert(new_sheet(
            params.sheet_id,
            params.file_id,
            params.snapshot_key,
            params.user_id,
            now,
        ))
        .exec_without_returning(&tx)
        .await?;
    }
    tx.commit().await?;
    get_sheet(db, params.sheet_id).await
}

/// Display name and picture of a workspace member (`memberProfile`).
pub(crate) async fn member_profile(
    db: &PgPool,
    master: Option<&PgPool>,
    user_id: &str,
) -> Result<(Option<String>, Option<String>), DbErr> {
    use workspace_members::Column;
    let row: Option<(Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([Column::Name, Column::Email])
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (name, email) = row.unwrap_or_default();
    let name = name
        .filter(|name| !name.is_empty())
        .or(email.filter(|email| !email.is_empty()));
    // The avatar is the account picture, not the member row's copy.
    let picture = weldsuite_db::load_account_picture(master, user_id).await;
    Ok((name, picture))
}

// ── versions ────────────────────────────────────────────────────────────────

/// A `sheet_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    sheet_id: &str,
    version_id: &str,
) -> Result<Option<Value>, DbErr> {
    sheet_versions::Entity::find()
        .filter(sheet_versions::Column::SheetId.eq(sheet_id))
        .filter(sheet_versions::Column::Id.eq(version_id))
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

/// `toVersion(row)`.
pub(crate) fn to_version(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "sheetId": row["sheetId"],
        "revision": row["revision"],
        "name": row["name"],
        "size": row["size"],
        "createdAt": row["createdAt"],
        "createdById": row["createdById"],
    })
}

/// `versionEventData(row)`.
pub(crate) fn version_event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "sheetId": row["sheetId"],
        "name": row["name"],
        "revision": row["revision"],
        "createdById": row["createdById"],
    })
}

/// A new version row (`insertVersion`).
pub(crate) struct NewVersion<'a> {
    pub(crate) id: &'a str,
    pub(crate) sheet_id: &'a str,
    pub(crate) revision: &'a Value,
    pub(crate) name: Option<&'a str>,
    pub(crate) snapshot_key: &'a str,
    pub(crate) size: &'a Value,
    pub(crate) created_by_id: &'a str,
}

/// `($n::jsonb)::text::integer`: the room's JSON value as Postgres prints
/// it, cast to an integer there, so what it accepts and refuses is
/// Postgres's.
fn json_int(value: &Value) -> Expr {
    Func::cast_as(Func::cast_as(Expr::val(value.clone()), "text"), "integer").into()
}

pub(crate) async fn insert_version(
    db: &PgPool,
    version: &NewVersion<'_>,
    now: PrimitiveDateTime,
) -> Result<Value, DbErr> {
    use sheet_versions::Column;
    let mut insert = Query::insert();
    insert
        .into_table(sheet_versions::Entity)
        .columns([
            Column::Id,
            Column::SheetId,
            Column::Revision,
            Column::Name,
            Column::SnapshotKey,
            Column::Size,
            Column::CreatedById,
            Column::CreatedAt,
        ])
        .values([
            Expr::val(version.id),
            Expr::val(version.sheet_id),
            json_int(version.revision),
            Expr::val(version.name.map(str::to_owned)),
            Expr::val(version.snapshot_key),
            json_int(version.size),
            Expr::val(version.created_by_id),
            Expr::val(now),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .returning_all();
    let row = orm(db)
        .query_one(&insert)
        .await?
        .ok_or(DbErr::RecordNotInserted)?;
    js(sheet_versions::Model::from_query_result(&row, "")?)
}

/// A page of a sheet's versions, newest first, after the version `after`
/// (`listVersions`).
pub(crate) async fn list_versions(
    db: &PgPool,
    sheet_id: &str,
    limit: i64,
    after: Option<&Value>,
) -> Result<Vec<Value>, DbErr> {
    use sheet_versions::Column;
    let mut query = sheet_versions::Entity::find().filter(Column::SheetId.eq(sheet_id));
    if let Some(last) = after
        && let Some(stamp) = last["createdAt"].as_str()
    {
        let at = timestamp_of(stamp)?;
        let id = last["id"].as_str().map(str::to_owned);
        query = query.filter(
            Condition::any().add(Column::CreatedAt.lt(at)).add(
                Condition::all()
                    .add(Column::CreatedAt.eq(at))
                    .add(Column::Id.lt(id)),
            ),
        );
    }
    let rows = query
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(rows_of(limit.saturating_add(1)))
        .all(&orm(db))
        .await?;
    rows.into_iter().map(js).collect()
}

pub(crate) async fn count_versions(db: &PgPool, sheet_id: &str) -> Result<i64, DbErr> {
    let count = sheet_versions::Entity::find()
        .filter(sheet_versions::Column::SheetId.eq(sheet_id))
        .count(&orm(db))
        .await?;
    Ok(count_of(count))
}

/// Renames a version (`renameVersion`).
pub(crate) async fn rename_version(
    db: &PgPool,
    sheet_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, DbErr> {
    let rows = sheet_versions::Entity::update_many()
        .col_expr(sheet_versions::Column::Name, Expr::value(name))
        .filter(sheet_versions::Column::SheetId.eq(sheet_id))
        .filter(sheet_versions::Column::Id.eq(version_id))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(js).transpose()
}

// ── connected tables ────────────────────────────────────────────────────────

/// `toDataSource(row)`.
pub(crate) fn to_data_source(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "sheetId": row["sheetId"],
        "objectType": row["objectType"],
        "definition": row["definition"],
        "refresh": row["refresh"],
        "lastRefreshedAt": row["lastRefreshedAt"],
        "nextRefreshAt": row["nextRefreshAt"],
        "lastError": row["lastError"],
        "rowCount": row["rowCount"],
        "createdById": row["createdById"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// `dataSourceEventData(row)`.
pub(crate) fn data_source_event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "sheetId": row["sheetId"],
        "objectType": row["objectType"],
        "refresh": row["refresh"],
        "createdById": row["createdById"],
    })
}

/// When a scheduled refresh is next due after `from` (`nextRefreshAfter`):
/// an hour or a day on, or never for a manual one.
fn next_refresh_after(refresh: &str, from: PrimitiveDateTime) -> Option<PrimitiveDateTime> {
    match refresh {
        "hourly" => from.checked_add(Duration::hours(1)),
        "daily" => from.checked_add(Duration::hours(24)),
        _ => None,
    }
}

/// A new connected table (`insertDataSource`).
pub(crate) struct NewDataSource<'a> {
    pub(crate) id: &'a str,
    pub(crate) sheet_id: &'a str,
    pub(crate) object_type: &'a str,
    pub(crate) definition: &'a Value,
    pub(crate) refresh: &'a str,
    pub(crate) created_by_id: &'a str,
}

pub(crate) async fn insert_data_source(
    db: &PgPool,
    source: &NewDataSource<'_>,
    now: PrimitiveDateTime,
) -> Result<Value, DbErr> {
    let row = sheet_data_sources::Entity::insert(sheet_data_sources::ActiveModel {
        id: Set(source.id.to_owned()),
        sheet_id: Set(source.sheet_id.to_owned()),
        object_type: Set(source.object_type.to_owned()),
        definition: Set(source.definition.clone()),
        refresh: Set(source.refresh.to_owned()),
        created_by_id: Set(source.created_by_id.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        next_refresh_at: Set(next_refresh_after(source.refresh, now)),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    js(row)
}

pub(crate) async fn get_data_source(
    db: &PgPool,
    sheet_id: &str,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    sheet_data_sources::Entity::find()
        .filter(sheet_data_sources::Column::SheetId.eq(sheet_id))
        .filter(sheet_data_sources::Column::Id.eq(id))
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

/// A sheet's connected tables, oldest first (`listDataSources`).
pub(crate) async fn list_data_sources(db: &PgPool, sheet_id: &str) -> Result<Vec<Value>, DbErr> {
    let rows = sheet_data_sources::Entity::find()
        .filter(sheet_data_sources::Column::SheetId.eq(sheet_id))
        .order_by_asc(sheet_data_sources::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    rows.into_iter().map(js).collect()
}

/// `(extract(epoch from at) * 1000)::float8`, rounded half away from zero
/// as `f64::round` did: a `timestamp` as epoch milliseconds.
fn epoch_ms(at: PrimitiveDateTime) -> Option<i64> {
    let micros = at.assume_utc().unix_timestamp_nanos() / 1_000;
    let (ms, rest) = (micros / 1_000, micros % 1_000);
    let ms = if rest >= 500 {
        ms + 1
    } else if rest <= -500 {
        ms - 1
    } else {
        ms
    };
    i64::try_from(ms).ok()
}

/// The earliest scheduled refresh of a sheet's connected tables, as epoch ms (`nextDueAt`).
pub(crate) async fn next_due_at(db: &PgPool, sheet_id: &str) -> Result<Option<i64>, DbErr> {
    use sheet_data_sources::Column;
    let at: Option<Option<PrimitiveDateTime>> = sheet_data_sources::Entity::find()
        .select_only()
        .column(Column::NextRefreshAt)
        .filter(Column::SheetId.eq(sheet_id))
        .filter(Column::NextRefreshAt.is_not_null())
        .order_by_asc(Column::NextRefreshAt)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(at.flatten().and_then(epoch_ms))
}

/// What `updateDataSource` changes.
pub(crate) struct DataSourcePatch<'a> {
    pub(crate) definition: Option<&'a Value>,
    pub(crate) created_by_id: Option<&'a str>,
    pub(crate) refresh: Option<&'a str>,
}

pub(crate) async fn update_data_source(
    db: &PgPool,
    sheet_id: &str,
    id: &str,
    patch: &DataSourcePatch<'_>,
    now: PrimitiveDateTime,
) -> Result<Option<Value>, DbErr> {
    use sheet_data_sources::Column;
    let mut update = sheet_data_sources::Entity::update_many();
    if let Some(definition) = patch.definition {
        update = update.col_expr(Column::Definition, Expr::value(definition.clone()));
    }
    if let Some(created_by_id) = patch.created_by_id {
        update = update.col_expr(Column::CreatedById, Expr::value(created_by_id));
    }
    if let Some(refresh) = patch.refresh {
        update = update
            .col_expr(Column::Refresh, Expr::value(refresh))
            .col_expr(
                Column::NextRefreshAt,
                Expr::value(next_refresh_after(refresh, now)),
            );
    }
    let rows = update
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::SheetId.eq(sheet_id))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(js).transpose()
}

/// Records how a refresh went, and when the next scheduled one is due (`recordRefresh`).
pub(crate) async fn record_refresh(
    db: &PgPool,
    row: &Value,
    at: PrimitiveDateTime,
    row_count: i64,
    error: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    use sheet_data_sources::Column;
    let refresh = row["refresh"].as_str().unwrap_or_default();
    let mut update = sheet_data_sources::Entity::update_many()
        .col_expr(
            Column::NextRefreshAt,
            Expr::value(next_refresh_after(refresh, at)),
        )
        .col_expr(Column::LastError, Expr::value(error.map(str::to_owned)));
    // A failed refresh keeps when the last good one was, and its row count.
    if error.is_none() {
        update = update
            .col_expr(Column::LastRefreshedAt, Expr::value(at))
            .col_expr(
                Column::RowCount,
                Expr::value(i32::try_from(row_count).unwrap_or(i32::MAX)),
            );
    }
    let rows = update
        .filter(Column::Id.eq(row["id"].as_str().unwrap_or_default()))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(js).transpose()
}

pub(crate) async fn delete_data_source(
    db: &PgPool,
    sheet_id: &str,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let rows = sheet_data_sources::Entity::delete_many()
        .filter(sheet_data_sources::Column::SheetId.eq(sheet_id))
        .filter(sheet_data_sources::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(js).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_the_worker() {
        assert_eq!(
            snapshot_key_for("org_1", "sht_1"),
            "workspaces/org_1/sheets/sht_1/workbook.json.gz"
        );
        assert_eq!(
            version_key_for("workspaces/org_1/sheets/sht_1/workbook.json.gz", "shtv_2"),
            "workspaces/org_1/sheets/sht_1/versions/shtv_2.json.gz"
        );
        assert_eq!(room_name("org_1", "sht_1"), "org_1:sht_1");
    }

    #[test]
    fn epoch_ms_rounds_half_away_from_zero() {
        let at = time::macros::datetime!(2026-10-29 07:00:00.123_500);
        assert_eq!(epoch_ms(at), Some(1_793_257_200_124));
        let at = time::macros::datetime!(2026-10-29 07:00:00.123_499);
        assert_eq!(epoch_ms(at), Some(1_793_257_200_123));
    }
}
