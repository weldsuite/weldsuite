//! One batch of moving a workspace's private Drive files out of the public
//! bucket (`apps/workers/app-api/src/services/private-storage-migration.ts`):
//! copy the object to the private bucket, point the row at its private URL,
//! then delete the public copy. The order makes a crash at any point safe to
//! run again.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{DynFileStore, PortError, PutOptions};

use super::PRIVATE_OBJECT_PATH;
use crate::{private_object_url, workspace_of_key};

/// Rows per call (`MIGRATION_BATCH_SIZE`).
pub(crate) const MIGRATION_BATCH_SIZE: i64 = 25;

/// Why a row failed: the database or a bucket.
#[derive(Debug)]
pub(crate) enum MigrationError {
    Database(sqlx::Error),
    Storage(PortError),
}

impl From<sqlx::Error> for MigrationError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PortError> for MigrationError {
    fn from(error: PortError) -> Self {
        Self::Storage(error)
    }
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "database: {error}"),
            Self::Storage(error) => write!(f, "storage: {error}"),
        }
    }
}

/// A row the batch moved: what `file:updated` carries, and its new URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdatedFile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) folder_id: Option<String>,
    pub(crate) file_type: String,
    pub(crate) url: String,
}

/// `MigrationBatchResult`.
#[derive(Debug, Default)]
pub(crate) struct MigrationBatch {
    moved: u64,
    repointed: u64,
    skipped: Vec<Value>,
    pub(crate) updated: Vec<UpdatedFile>,
    cursor: Option<String>,
}

impl MigrationBatch {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "moved": self.moved,
            "repointed": self.repointed,
            "skipped": self.skipped,
            "updated": self.updated.iter().map(|file| json!({
                "id": file.id, "name": file.name, "folderId": file.folder_id,
                "fileType": file.file_type, "url": file.url,
            })).collect::<Vec<_>>(),
            "cursor": self.cursor,
            "done": self.cursor.is_none(),
        })
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    file_key: Option<String>,
    storage_path: String,
    file_name: String,
    folder_id: Option<String>,
    file_type: String,
}

enum Outcome {
    Moved(String),
    Repointed(String),
    Skipped(&'static str),
}

/// The two buckets of a migration.
pub(crate) struct Buckets<'a> {
    pub(crate) public: &'a dyn DynFileStore,
    pub(crate) private: &'a dyn DynFileStore,
}

pub(crate) struct Batch<'a> {
    pub(crate) workspace_id: &'a str,
    pub(crate) api_origin: &'a str,
    pub(crate) cursor: Option<&'a str>,
    pub(crate) dry_run: bool,
}

/// `migratePrivateFilesBatch`.
pub(crate) async fn migrate_private_files_batch(
    db: &PgPool,
    buckets: &Buckets<'_>,
    batch: &Batch<'_>,
) -> Result<MigrationBatch, MigrationError> {
    // `params.cursor ? gt(files.id, cursor) : undefined`: '' is no cursor.
    let cursor = batch.cursor.filter(|cursor| !cursor.is_empty());
    let rows: Vec<Row> = sqlx::query_as(
        "select id, file_key, storage_path, file_name, folder_id, file_type
           from files
          where is_public = false
            and entity_type is null
            and (url is null or url not like $1)
            and ($2::text is null or id > $2)
          order by id asc
          limit $3",
    )
    .bind(format!("%{PRIVATE_OBJECT_PATH}%"))
    .bind(cursor)
    .bind(MIGRATION_BATCH_SIZE)
    .fetch_all(db)
    .await?;

    let mut result = MigrationBatch::default();
    for row in &rows {
        match migrate_row(db, buckets, batch, row).await? {
            Outcome::Skipped(reason) => {
                result
                    .skipped
                    .push(json!({ "id": row.id, "reason": reason }));
            }
            outcome => {
                let url = match outcome {
                    Outcome::Moved(url) => {
                        result.moved += 1;
                        url
                    }
                    Outcome::Repointed(url) => {
                        result.repointed += 1;
                        url
                    }
                    Outcome::Skipped(_) => unreachable!("handled above"),
                };
                if !batch.dry_run {
                    result.updated.push(UpdatedFile {
                        id: row.id.clone(),
                        name: row.file_name.clone(),
                        folder_id: row.folder_id.clone(),
                        file_type: row.file_type.clone(),
                        url,
                    });
                }
            }
        }
    }
    // Page by id, so skipped rows and dry runs still make progress.
    result.cursor = match rows.last() {
        Some(last) if i64::try_from(rows.len()).ok() == Some(MIGRATION_BATCH_SIZE) => {
            Some(last.id.clone())
        }
        _ => None,
    };
    Ok(result)
}

/// `migrateRow`: move one row's object and repoint the row, or say why not.
async fn migrate_row(
    db: &PgPool,
    buckets: &Buckets<'_>,
    batch: &Batch<'_>,
    row: &Row,
) -> Result<Outcome, MigrationError> {
    // `row.fileKey || row.storagePath`
    let key = row
        .file_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .unwrap_or(&row.storage_path);
    if key.is_empty() {
        return Ok(Outcome::Skipped("no-key"));
    }
    if workspace_of_key(key) != Some(batch.workspace_id) {
        return Ok(Outcome::Skipped("foreign-key"));
    }
    let already_private = buckets.private.head_boxed(key).await?.is_some();
    let public_object = if already_private {
        None
    } else {
        buckets.public.get_boxed(key).await?
    };
    if !already_private && public_object.is_none() {
        return Ok(Outcome::Skipped("missing-object"));
    }
    let url = private_object_url(batch.api_origin, key);
    let outcome = |url| {
        if already_private {
            Outcome::Repointed(url)
        } else {
            Outcome::Moved(url)
        }
    };
    if batch.dry_run {
        return Ok(outcome(url));
    }
    if let Some(object) = public_object {
        let mut metadata = object.info.metadata.clone();
        metadata.insert("filename".to_owned(), row.file_name.clone());
        let options = PutOptions {
            content_type: object.info.content_type.clone(),
            content_disposition: object.info.content_disposition.clone(),
            metadata,
            create_only: false,
        };
        buckets
            .private
            .put_boxed(key, object.bytes, &options)
            .await?;
    }
    sqlx::query("update files set url = $2, bucket = 'private' where id = $1")
        .bind(&row.id)
        .bind(&url)
        .execute(db)
        .await?;
    buckets.public.delete_boxed(key).await?;
    Ok(outcome(url))
}
