//! Document records (`services/docs.ts`) and versions (`services/versions.ts`):
//! a drive `files` row paired with a `docs` row. Only WeldDocs documents (a
//! row with a checkpoint key) are listed or opened; a row with `BlockNote`
//! `content` belongs to flow-api's `/api/documents`.

use serde_json::{Value, json};
use weldsuite_core_domain::drive_access::{
    DriveFileRef, DriveGeneralAccess, DriveRole, VisibleFiles,
};
use weldsuite_db::{PgPool, js_row};

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

fn text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

impl DocRecord {
    fn from_row(row: Value) -> Self {
        let row = js_row(row);
        let id = text(&row, "id").unwrap_or_default();
        let file_id = text(&row, "fileId").unwrap_or_default();
        let folder_id = text(&row, "folderId");
        let created_by_id = text(&row, "createdById");
        Self {
            file: DriveFileRef {
                id: file_id.clone(),
                uploaded_by_id: created_by_id.clone(),
                folder_id: folder_id.clone(),
                general_access: DriveGeneralAccess::parse(
                    row["generalAccess"].as_str().unwrap_or_default(),
                ),
                entity_type: text(&row, "entityType"),
            },
            id,
            file_id,
            name: text(&row, "name").unwrap_or_default(),
            folder_id,
            created_at: row["createdAt"].clone(),
            updated_at: row["updatedAt"].clone(),
            created_by_id,
            updated_by_id: text(&row, "updatedById"),
            revision: row["revision"].clone(),
            snapshot_key: text(&row, "snapshotKey"),
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

/// The columns of a [`DocRecord`], on `docs d` joined with `files f`.
macro_rules! doc_columns {
    () => {
        "d.id, d.file_id, f.file_name as name, f.folder_id, d.created_at,
         greatest(d.updated_at, f.updated_at) as updated_at,
         f.uploaded_by_id as created_by_id, d.updated_by_id, d.revision, d.snapshot_key,
         f.general_access, f.entity_type"
    };
}

/// `visibleFilesCondition`, on `$1` (admin) … `$5` (open folders).
macro_rules! visible {
    () => {
        "($1::bool or f.entity_type is not null
          or ($2::text is not null and f.uploaded_by_id = $2)
          or f.id = any($3::text[]) or f.folder_id = any($4::text[])
          or (f.general_access <> 'restricted'
              and (f.folder_id is null or f.folder_id = any($5::text[]))))"
    };
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

/// Documents not in the trash, most recently changed first (`listDocs`).
pub(crate) async fn list_docs(
    db: &PgPool,
    params: &ListDocs,
) -> Result<(Vec<DocRecord>, i64), sqlx::Error> {
    let visible = params.visible.clone().unwrap_or_default();
    let admin = params.visible.is_none();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        doc_columns!(),
        " from docs d join files f on f.id = d.file_id
          where d.snapshot_key is not null and f.deleted_at is null and ",
        visible!(),
        " and ($6::text is null or f.file_name ilike $6)
          order by greatest(d.updated_at, f.updated_at) desc, d.id desc
          limit $7 offset $8) r
         order by r.updated_at desc, r.id desc"
    ))
    .bind(admin)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .bind(params.limit)
    .bind(params.offset)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from docs d join files f on f.id = d.file_id
          where d.snapshot_key is not null and f.deleted_at is null and ",
        visible!(),
        " and ($6::text is null or f.file_name ilike $6)"
    ))
    .bind(admin)
    .bind(&visible.user_id)
    .bind(&visible.file_share_ids)
    .bind(&visible.granted_folder_ids)
    .bind(&visible.open_folder_ids)
    .bind(&params.search)
    .fetch_one(db)
    .await?;
    Ok((rows.into_iter().map(DocRecord::from_row).collect(), total))
}

/// A document not in the trash (`getDoc`).
pub(crate) async fn get_doc(db: &PgPool, id: &str) -> Result<Option<DocRecord>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (select ",
        doc_columns!(),
        " from docs d join files f on f.id = d.file_id
          where d.id = $1 and d.snapshot_key is not null and f.deleted_at is null
          limit 1) r"
    ))
    .bind(id)
    .fetch_optional(db)
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
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into docs (id, file_id, content, snapshot_key, revision, snapshot_revision,
                           updated_by_id, created_at, updated_at)
         values ($1, $2, null, $3, 0, 0, $4, $5::timestamp, $5::timestamp)",
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

/// A `doc_versions` row as Drizzle returns it.
pub(crate) async fn get_version(
    db: &PgPool,
    doc_id: &str,
    version_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from doc_versions v where doc_id = $1 and id = $2 limit 1",
    )
    .bind(doc_id)
    .bind(version_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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

pub(crate) async fn insert_version(
    db: &PgPool,
    version: &NewVersion<'_>,
    now: &str,
) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(
        "insert into doc_versions (id, doc_id, revision, name, snapshot_key, size, created_by_id, created_at)
         values ($1, $2, ($3::jsonb)::text::integer, $4, $5, ($6::jsonb)::text::integer, $7, $8::timestamp)
         returning to_jsonb(doc_versions)",
    )
    .bind(version.id)
    .bind(version.doc_id)
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

/// A page of a document's versions, newest first, after the version `after`
/// (`listVersions`); `None` when `after` is not one of its versions.
pub(crate) async fn list_versions(
    db: &PgPool,
    doc_id: &str,
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
        "select to_jsonb(v) from doc_versions v
         where doc_id = $1
           and ($2::text is null
                or created_at < $2::timestamp
                or (created_at = $2::timestamp and id < $3))
         order by created_at desc, id desc
         limit $4",
    )
    .bind(doc_id)
    .bind(after_at)
    .bind(after_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

pub(crate) async fn count_versions(db: &PgPool, doc_id: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("select count(*)::bigint from doc_versions where doc_id = $1")
        .bind(doc_id)
        .fetch_one(db)
        .await
}

/// Renames a version (`renameVersion`).
pub(crate) async fn rename_version(
    db: &PgPool,
    doc_id: &str,
    version_id: &str,
    name: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update doc_versions set name = $3 where doc_id = $1 and id = $2
         returning to_jsonb(doc_versions)",
    )
    .bind(doc_id)
    .bind(version_id)
    .bind(name)
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
