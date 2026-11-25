//! Document records (`services/docs.ts`) and versions (`services/versions.ts`):
//! a drive `files` row paired with a `docs` row. Only WeldDocs documents (a
//! row with a checkpoint key) are listed or opened; a row with `BlockNote`
//! `content` belongs to flow-api's `/api/documents`.

use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_schema::tenant::{doc_versions, docs, files, workspace_members};

/// The mime type of a WeldDocs file (`WELDDOC_MIME_TYPE`).
pub(crate) const WELDDOC_MIME_TYPE: &str = "application/vnd.weldsuite.doc+json";

/// A document with what drive access needs to know about its file.
#[derive(Debug, Clone)]
pub(crate) struct DocRecord {
    pub(crate) id: String,
    pub(crate) file_id: String,
    pub(crate) name: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) created_at: Value,
    pub(crate) updated_at: Value,
    pub(crate) created_by_id: Option<String>,
    pub(crate) updated_by_id: Option<String>,
    pub(crate) revision: Value,
    pub(crate) snapshot_key: Option<String>,
    pub(crate) file: DriveFileRef,
}

/// A `timestamp` as the `Date` Drizzle read it prints (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
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

/// The columns of a [`DocRecord`], on `docs` joined with `files`.
#[derive(Debug, FromQueryResult)]
struct DocRow {
    id: String,
    file_id: String,
    name: String,
    folder_id: Option<String>,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    created_by_id: Option<String>,
    updated_by_id: Option<String>,
    revision: i32,
    snapshot_key: Option<String>,
    general_access: String,
    entity_type: Option<String>,
}

impl DocRecord {
    fn from_row(row: DocRow) -> Self {
        Self {
            file: DriveFileRef {
                id: row.file_id.clone(),
                uploaded_by_id: row.created_by_id.clone(),
                folder_id: row.folder_id.clone(),
                general_access: DriveGeneralAccess::parse(&row.general_access),
                entity_type: row.entity_type,
            },
            id: row.id,
            file_id: row.file_id,
            name: row.name,
            folder_id: row.folder_id,
            created_at: Value::String(iso(row.created_at)),
            updated_at: Value::String(iso(row.updated_at)),
            created_by_id: row.created_by_id,
            updated_by_id: row.updated_by_id,
            revision: json!(row.revision),
            snapshot_key: row.snapshot_key,
        }
    }

    /// `toSummary(doc, role, mayEdit)`.
    pub(crate) fn summary(&self, role: DriveRole, may_edit: bool) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "folderId": self.folder_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "createdById": self.created_by_id,
            "updatedById": self.updated_by_id,
            "revision": self.revision,
            "role": role.as_str(),
            "canEdit": may_edit && matches!(role, DriveRole::Owner | DriveRole::Editor),
        })
    }

    /// `eventData(doc)`.
    pub(crate) fn event_data(&self) -> Value {
        json!({
            "id": self.id,
            "fileId": self.file_id,
            "name": self.name,
            "revision": self.revision,
            "updatedById": self.updated_by_id,
        })
    }

    /// The key of the document's checkpoint (`snapshotKeyOf`).
    pub(crate) fn snapshot_key_in(&self, workspace: &str) -> String {
        self.snapshot_key
            .clone()
            .unwrap_or_else(|| snapshot_key_for(workspace, &self.id))
    }

    /// `roomMeta(doc, workspaceId)`.
    pub(crate) fn room_meta(&self, workspace: &str) -> Value {
        json!({
            "workspaceId": workspace,
            "docId": self.id,
            "snapshotKey": self.snapshot_key_in(workspace),
        })
    }
}

/// The room of a document: one per document, named by workspace and id.
pub(crate) fn room_name(workspace: &str, doc_id: &str) -> String {
    format!("{workspace}:{doc_id}")
}

/// The key a document's checkpoints are written to (`snapshotKeyFor`).
pub(crate) fn snapshot_key_for(workspace: &str, doc_id: &str) -> String {
    format!("workspaces/{workspace}/docs/{doc_id}/document.json.gz")
}

/// Where a version's snapshot goes, next to the checkpoint (`versionKeyFor`).
pub(crate) fn version_key_for(doc_snapshot_key: &str, version_id: &str) -> String {
    let head = doc_snapshot_key
        .rfind('/')
        .map_or("", |slash| &doc_snapshot_key[..=slash]);
    format!("{head}versions/{version_id}.json.gz")
}

/// `join(files, eq(files.id, docs.fileId))`.
fn doc_file() -> RelationDef {
    docs::Entity::belongs_to(files::Entity)
        .from(docs::Column::FileId)
        .to(files::Column::Id)
        .into()
}

/// `greatest(d.updated_at, f.updated_at)`: when the document or its file
/// last changed.
fn changed() -> Expr {
    Func::greatest([
        Expr::col((docs::Entity, docs::Column::UpdatedAt)),
        Expr::col((files::Entity, files::Column::UpdatedAt)),
    ])
    .into()
}

/// The [`DocRow`] columns of `docs` joined with `files`.
fn doc_rows() -> Select<docs::Entity> {
    docs::Entity::find()
        .select_only()
        .columns([docs::Column::Id, docs::Column::FileId])
        .column_as(files::Column::FileName, "name")
        .column(files::Column::FolderId)
        .column(docs::Column::CreatedAt)
        .column_as(changed(), "updated_at")
        .column_as(files::Column::UploadedById, "created_by_id")
        .columns([
            docs::Column::UpdatedById,
            docs::Column::Revision,
            docs::Column::SnapshotKey,
        ])
        .columns([files::Column::GeneralAccess, files::Column::EntityType])
        .join(JoinType::InnerJoin, doc_file())
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

/// A WeldDocs document (one with a checkpoint) whose file is not trashed.
fn live() -> Condition {
    Condition::all()
        .add(docs::Column::SnapshotKey.is_not_null())
        .add(files::Column::DeletedAt.is_null())
}

/// The list's filters.
pub(crate) struct ListDocs {
    /// `None` for an admin.
    pub(crate) visible: Option<VisibleFiles>,
    /// The `ilike` pattern, already escaped and wrapped in `%`.
    pub(crate) search: Option<String>,
    pub(crate) limit: i64,
    pub(crate) offset: i64,
}

/// `listDocs`' filter on `docs` ⨝ `files`: a live document, visible on the
/// drive, matching the search.
fn listed(params: &ListDocs) -> Condition {
    let mut condition = live();
    if let Some(visible) = &params.visible {
        condition = condition.add(visible_condition(visible));
    }
    if let Some(search) = &params.search {
        condition = condition.add(files::Column::FileName.ilike(search));
    }
    condition
}

/// Documents not in the trash, most recently changed first (`listDocs`).
pub(crate) async fn list_docs(
    db: &PgPool,
    params: &ListDocs,
) -> Result<(Vec<DocRecord>, i64), DbErr> {
    let db = &orm(db);
    let filter = listed(params);
    let rows = doc_rows()
        .filter(filter.clone())
        .order_by_desc(changed())
        .order_by_desc(docs::Column::Id)
        .limit(rows_of(params.limit))
        .offset(rows_of(params.offset))
        .into_model::<DocRow>()
        .all(db)
        .await?;
    let total = docs::Entity::find()
        .join(JoinType::InnerJoin, doc_file())
        .filter(filter)
        .count(db)
        .await?;
    Ok((
        rows.into_iter().map(DocRecord::from_row).collect(),
        count_of(total),
    ))
}

/// A document not in the trash (`getDoc`).
pub(crate) async fn get_doc(db: &PgPool, id: &str) -> Result<Option<DocRecord>, DbErr> {
    let row = doc_rows()
        .filter(docs::Column::Id.eq(id))
        .filter(live())
        .into_model::<DocRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(DocRecord::from_row))
}

/// The `docs` row of a new document (`createDoc`, after its drive file).
pub(crate) async fn insert_doc(
    db: &PgPool,
    id: &str,
    file_id: &str,
    snapshot_key: &str,
    user_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    docs::Entity::insert(docs::ActiveModel {
        id: Set(id.to_owned()),
        file_id: Set(file_id.to_owned()),
        content: Set(None),
        snapshot_key: Set(Some(snapshot_key.to_owned())),
        revision: Set(0),
        snapshot_revision: Set(0),
        updated_by_id: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
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

/// A `doc_versions` row in the JSON Drizzle gave it (`to_jsonb`): the entity
/// serializes as Drizzle did.
fn version_json(row: doc_versions::Model) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

/// A `doc_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    doc_id: &str,
    version_id: &str,
) -> Result<Option<Value>, DbErr> {
    doc_versions::Entity::find()
        .filter(doc_versions::Column::DocId.eq(doc_id))
        .filter(doc_versions::Column::Id.eq(version_id))
        .one(&orm(db))
        .await?
        .map(version_json)
        .transpose()
}

/// `toVersion(row)`.
pub(crate) fn to_version(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "docId": row["docId"],
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
        "docId": row["docId"],
        "name": row["name"],
        "revision": row["revision"],
        "createdById": row["createdById"],
    })
}

/// A new version row (`insertVersion`).
pub(crate) struct NewVersion<'a> {
    pub(crate) id: &'a str,
    pub(crate) doc_id: &'a str,
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
    use doc_versions::Column;
    let mut insert = Query::insert();
    insert
        .into_table(doc_versions::Entity)
        .columns([
            Column::Id,
            Column::DocId,
            Column::Revision,
            Column::Name,
            Column::SnapshotKey,
            Column::Size,
            Column::CreatedById,
            Column::CreatedAt,
        ])
        .values([
            Expr::val(version.id),
            Expr::val(version.doc_id),
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
    version_json(doc_versions::Model::from_query_result(&row, "")?)
}

/// A page of a document's versions, newest first, after the version `after`
/// (`listVersions`); `None` when `after` is not one of its versions.
pub(crate) async fn list_versions(
    db: &PgPool,
    doc_id: &str,
    limit: i64,
    after: Option<&Value>,
) -> Result<Vec<Value>, DbErr> {
    use doc_versions::Column;
    let mut query = doc_versions::Entity::find().filter(Column::DocId.eq(doc_id));
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
    rows.into_iter().map(version_json).collect()
}

pub(crate) async fn count_versions(db: &PgPool, doc_id: &str) -> Result<i64, DbErr> {
    let count = doc_versions::Entity::find()
        .filter(doc_versions::Column::DocId.eq(doc_id))
        .count(&orm(db))
        .await?;
    Ok(count_of(count))
}

/// Renames a version (`renameVersion`).
pub(crate) async fn rename_version(
    db: &PgPool,
    doc_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, DbErr> {
    let rows = doc_versions::Entity::update_many()
        .col_expr(doc_versions::Column::Name, Expr::value(name))
        .filter(doc_versions::Column::DocId.eq(doc_id))
        .filter(doc_versions::Column::Id.eq(version_id))
        .exec_with_returning(&orm(db))
        .await?;
    rows.into_iter().next().map(version_json).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_the_worker() {
        assert_eq!(
            snapshot_key_for("org_1", "doc_1"),
            "workspaces/org_1/docs/doc_1/document.json.gz"
        );
        assert_eq!(
            version_key_for("workspaces/org_1/docs/doc_1/document.json.gz", "docv_2"),
            "workspaces/org_1/docs/doc_1/versions/docv_2.json.gz"
        );
        assert_eq!(version_key_for("plain", "v"), "versions/v.json.gz");
    }
}
