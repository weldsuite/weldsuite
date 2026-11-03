//! Spreadsheet records (`services/sheets.ts`), versions (`services/versions.ts`)
//! and connected tables (`services/data-sources/sources.ts`): a drive `files`
//! row paired with a `sheets` row.

use serde_json::{Value, json};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, js_row};

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

fn text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

/// What drive access needs from a file row with these camelCase columns.
fn file_ref(row: &Value, id: &str) -> DriveFileRef {
    DriveFileRef {
        id: id.to_owned(),
        uploaded_by_id: text(row, "uploadedById"),
        folder_id: text(row, "folderId"),
        general_access: DriveGeneralAccess::parse(
            row["generalAccess"].as_str().unwrap_or_default(),
        ),
        entity_type: text(row, "entityType"),
    }
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

/// The project a row with `entityType` and `entityId` belongs to.
fn project_of(row: &Value) -> Option<String> {
    (row["entityType"].as_str() == Some(PROJECT_ENTITY))
        .then(|| text(row, "entityId"))
        .flatten()
}

impl SheetRecord {
    fn from_row(row: Value) -> Self {
        let row = js_row(row);
        let file_id = text(&row, "fileId").unwrap_or_default();
        let mut file = file_ref(&row, &file_id);
        file.uploaded_by_id = text(&row, "createdById");
        Self {
            id: text(&row, "id").unwrap_or_default(),
            name: text(&row, "name").unwrap_or_default(),
            folder_id: text(&row, "folderId"),
            created_at: row["createdAt"].clone(),
            updated_at: row["updatedAt"].clone(),
            created_by_id: text(&row, "createdById"),
            updated_by_id: text(&row, "updatedById"),
            snapshot_key: text(&row, "snapshotKey"),
            project_id: project_of(&row),
            file,
            file_id,
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

/// The columns of a [`SheetRecord`], on `sheets s` joined with `files f`.
macro_rules! sheet_columns {
    () => {
        "s.id, s.file_id, f.file_name as name, f.folder_id, s.created_at,
         greatest(s.updated_at, f.updated_at) as updated_at,
         f.uploaded_by_id as created_by_id, s.updated_by_id, s.snapshot_key,
         f.general_access, f.entity_type, f.entity_id"
    };
}

/// `visibleFilesCondition`, on `$1` (no condition) … `$5` (open folders).
macro_rules! visible {
    () => {
        "($1::bool or f.entity_type is not null
          or ($2::text is not null and f.uploaded_by_id = $2)
          or f.id = any($3::text[]) or f.folder_id = any($4::text[])
          or (f.general_access <> 'restricted'
              and (f.folder_id is null or f.folder_id = any($5::text[]))))"
    };
}

/// `listSheets`' filter on `$6` (search), `$7` (project), and the drive.
macro_rules! listed {
    () => {
        concat!(
            "f.deleted_at is null
              and (case when $7::text is null then f.entity_type is null
                        else f.entity_type = 'project' and f.entity_id = $7 end)
              and ",
            visible!(),
            " and ($6::text is null or f.file_name ilike $6)"
        )
    };
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

/// Sheets not in the trash, most recently changed first (`listSheets`).
pub(crate) async fn list_sheets(
    db: &PgPool,
    params: &ListSheets,
) -> Result<(Vec<SheetRecord>, i64), sqlx::Error> {
    let visible = params.visible.clone().unwrap_or_default();
    let open = params.visible.is_none();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        sheet_columns!(),
        " from sheets s join files f on f.id = s.file_id where ",
        listed!(),
        " order by greatest(s.updated_at, f.updated_at) desc, s.id desc
          limit $8 offset $9) r
         order by r.updated_at desc, r.id desc"
    ))
    .bind(open)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .bind(&params.project_id)
    .bind(params.limit)
    .bind(params.offset)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from sheets s join files f on f.id = s.file_id where ",
        listed!()
    ))
    .bind(open)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .bind(&params.project_id)
    .fetch_one(db)
    .await?;
    Ok((rows.into_iter().map(SheetRecord::from_row).collect(), total))
}

/// A sheet not in the trash (`getSheet`).
pub(crate) async fn get_sheet(db: &PgPool, id: &str) -> Result<Option<SheetRecord>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        sheet_columns!(),
        " from sheets s join files f on f.id = s.file_id
          where s.id = $1 and f.deleted_at is null
          limit 1) r"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(SheetRecord::from_row))
}

/// The `sheets` row of a new sheet (`createSheet`, after its drive file).
pub(crate) async fn insert_sheet(
    db: &PgPool,
    id: &str,
    file_id: &str,
    snapshot_key: &str,
    user_id: &str,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into sheets (id, file_id, snapshot_key, revision, snapshot_revision,
                             updated_by_id, created_at, updated_at)
         values ($1, $2, $3, 0, 0, $4, $5::timestamp, $5::timestamp)",
    )
    .bind(id)
    .bind(file_id)
    .bind(snapshot_key)
    .bind(user_id)
    .bind(now)
    .execute(db)
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
) -> Result<Option<DriveFileRecord>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from (select id, file_name, file_size, file_key, storage_path,
                metadata, uploaded_by_id, folder_id, general_access, entity_type, entity_id,
                file_type
           from files where id = $1 and deleted_at is null limit 1) r",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| {
        let row = js_row(row);
        let key = text(&row, "fileKey")
            .filter(|key| !key.is_empty())
            .or_else(|| text(&row, "storagePath"))
            .unwrap_or_default();
        DriveFileRecord {
            name: text(&row, "fileName").unwrap_or_default(),
            size: row["fileSize"].as_i64().unwrap_or(0),
            key,
            weldsheet_id: row["metadata"]["weldsheetId"].as_str().map(str::to_owned),
            project_id: project_of(&row),
            file_type: text(&row, "fileType").unwrap_or_default(),
            file: file_ref(&row, row["id"].as_str().unwrap_or_default()),
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
    now: &str,
) -> Result<Option<SheetRecord>, sqlx::Error> {
    let converted = json!({
        "weldsheetId": params.sheet_id,
        "convertedFrom": { "key": params.old_key, "at": now },
    });
    let mut tx = db.begin().await?;
    sqlx::query(
        "update files set file_name = $2, mime_type = $3, file_size = $4, storage_path = $5,
                file_key = $5, bucket = 'private', url = null,
                metadata = coalesce(metadata, '{}'::jsonb) || $6::jsonb,
                updated_at = $7::timestamp
          where id = $1 and metadata->>'weldsheetId' is null",
    )
    .bind(params.file_id)
    .bind(params.name)
    .bind(WELDSHEET_MIME_TYPE)
    .bind(params.snapshot_size)
    .bind(params.snapshot_key)
    .bind(converted.to_string())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "insert into sheets (id, created_at, updated_at, file_id, revision, snapshot_key,
                             snapshot_revision, updated_by_id)
         select $2::varchar, $3::timestamp, $3::timestamp, f.id, 0, $4::varchar, 0, $5::varchar
           from files f where f.id = $1 and f.metadata->>'weldsheetId' = $2",
    )
    .bind(params.file_id)
    .bind(params.sheet_id)
    .bind(now)
    .bind(params.snapshot_key)
    .bind(params.user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    get_sheet(db, params.sheet_id).await
}

/// Display name and picture of a workspace member (`memberProfile`).
pub(crate) async fn member_profile(
    db: &PgPool,
    user_id: &str,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, email, picture from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (name, email, picture) = row.unwrap_or_default();
    let name = name
        .filter(|name| !name.is_empty())
        .or(email.filter(|email| !email.is_empty()));
    Ok((name, picture))
}

// ── versions ────────────────────────────────────────────────────────────────

/// A `sheet_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    sheet_id: &str,
    version_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from sheet_versions v where sheet_id = $1 and id = $2 limit 1",
    )
    .bind(sheet_id)
    .bind(version_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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

pub(crate) async fn insert_version(
    db: &PgPool,
    version: &NewVersion<'_>,
    now: &str,
) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(
        "insert into sheet_versions (id, sheet_id, revision, name, snapshot_key, size, created_by_id, created_at)
         values ($1, $2, ($3::jsonb)::text::integer, $4, $5, ($6::jsonb)::text::integer, $7, $8::timestamp)
         returning to_jsonb(sheet_versions)",
    )
    .bind(version.id)
    .bind(version.sheet_id)
    .bind(version.revision)
    .bind(version.name)
    .bind(version.snapshot_key)
    .bind(version.size)
    .bind(version.created_by_id)
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// A page of a sheet's versions, newest first, after the version `after`
/// (`listVersions`).
pub(crate) async fn list_versions(
    db: &PgPool,
    sheet_id: &str,
    limit: i64,
    after: Option<&Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (after_at, after_id) = after.map_or((None, None), |last| {
        (
            last["createdAt"].as_str().map(str::to_owned),
            last["id"].as_str().map(str::to_owned),
        )
    });
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from sheet_versions v
         where sheet_id = $1
           and ($2::text is null
                or created_at < $2::timestamp
                or (created_at = $2::timestamp and id < $3))
         order by created_at desc, id desc
         limit $4",
    )
    .bind(sheet_id)
    .bind(after_at)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

pub(crate) async fn count_versions(db: &PgPool, sheet_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*)::bigint from sheet_versions where sheet_id = $1")
        .bind(sheet_id)
        .fetch_one(db)
        .await
}

/// Renames a version (`renameVersion`).
pub(crate) async fn rename_version(
    db: &PgPool,
    sheet_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update sheet_versions set name = $3 where sheet_id = $1 and id = $2
         returning to_jsonb(sheet_versions)",
    )
    .bind(sheet_id)
    .bind(version_id)
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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

/// When a scheduled refresh is next due after `$n` (`nextRefreshAfter`), in SQL.
macro_rules! next_refresh {
    ($refresh:literal, $from:literal) => {
        concat!(
            "(case ",
            $refresh,
            " when 'hourly' then ",
            $from,
            "::timestamp + interval '1 hour' when 'daily' then ",
            $from,
            "::timestamp + interval '24 hours' else null end)"
        )
    };
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
    now: &str,
) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(concat!(
        "insert into sheet_data_sources (id, sheet_id, object_type, definition, refresh,
                                         created_by_id, created_at, updated_at, next_refresh_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::timestamp, $7::timestamp, ",
        next_refresh!("$5", "$7"),
        ")
         returning to_jsonb(sheet_data_sources)"
    ))
    .bind(source.id)
    .bind(source.sheet_id)
    .bind(source.object_type)
    .bind(source.definition.to_string())
    .bind(source.refresh)
    .bind(source.created_by_id)
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

pub(crate) async fn get_data_source(
    db: &PgPool,
    sheet_id: &str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from sheet_data_sources d where sheet_id = $1 and id = $2 limit 1",
    )
    .bind(sheet_id)
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// A sheet's connected tables, oldest first (`listDataSources`).
pub(crate) async fn list_data_sources(
    db: &PgPool,
    sheet_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from sheet_data_sources d where sheet_id = $1 order by created_at asc",
    )
    .bind(sheet_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// The earliest scheduled refresh of a sheet's connected tables, as epoch ms (`nextDueAt`).
pub(crate) async fn next_due_at(db: &PgPool, sheet_id: &str) -> Result<Option<i64>, sqlx::Error> {
    let at: Option<Option<f64>> = sqlx::query_scalar(
        "select (extract(epoch from next_refresh_at) * 1000)::float8 from sheet_data_sources
          where sheet_id = $1 and next_refresh_at is not null
          order by next_refresh_at asc limit 1",
    )
    .bind(sheet_id)
    .fetch_optional(db)
    .await?;
    #[allow(clippy::cast_possible_truncation)]
    Ok(at.flatten().map(|ms| ms.round() as i64))
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
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update sheet_data_sources set
            definition = coalesce($3::jsonb, definition),
            created_by_id = coalesce($4, created_by_id),
            refresh = coalesce($5, refresh),
            next_refresh_at = case when $5::text is null then next_refresh_at else ",
        next_refresh!("$5", "$6"),
        " end,
            updated_at = $6::timestamp
          where sheet_id = $1 and id = $2
          returning to_jsonb(sheet_data_sources)"
    ))
    .bind(sheet_id)
    .bind(id)
    .bind(patch.definition.map(Value::to_string))
    .bind(patch.created_by_id)
    .bind(patch.refresh)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Records how a refresh went, and when the next scheduled one is due (`recordRefresh`).
pub(crate) async fn record_refresh(
    db: &PgPool,
    row: &Value,
    at: &str,
    row_count: i64,
    error: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let updated: Option<Value> = sqlx::query_scalar(concat!(
        "update sheet_data_sources set
            next_refresh_at = ",
        next_refresh!("$2", "$3"),
        ",
            last_error = $4,
            last_refreshed_at = case when $4::text is null then $3::timestamp else last_refreshed_at end,
            row_count = case when $4::text is null then $5 else row_count end
          where id = $1
          returning to_jsonb(sheet_data_sources)"
    ))
    .bind(row["id"].as_str().unwrap_or_default())
    .bind(row["refresh"].as_str().unwrap_or_default())
    .bind(at)
    .bind(error)
    .bind(i32::try_from(row_count).unwrap_or(i32::MAX))
    .fetch_optional(db)
    .await?;
    Ok(updated.map(js_row))
}

pub(crate) async fn delete_data_source(
    db: &PgPool,
    sheet_id: &str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "delete from sheet_data_sources where sheet_id = $1 and id = $2
         returning to_jsonb(sheet_data_sources)",
    )
    .bind(sheet_id)
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
}
