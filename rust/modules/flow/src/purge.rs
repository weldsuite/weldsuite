//! The purge of soft-deleted WeldFlow files (`cron/purge-deleted-files.ts`,
//! `weldsuite cron flow-file-purge`): once a project file, task attachment
//! or project document has been deleted for `RETENTION_DAYS`, its object
//! and then its row go. Only workspaces the `file_purge` due index lists
//! are opened (ADR DATA-008); the delete routes mark them due.

use std::sync::Arc;

use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use sqlx::PgPool;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_ports::DynFileStore;
use weldsuite_schema::tenant::{
    docs, document_versions, files, project_files, sheets, whiteboards,
};

use crate::import_tasks::TenantDatabases;

/// The due index kind.
pub const FILE_PURGE_KIND: &str = "file_purge";
/// How long a soft-deleted file stays restorable.
pub const RETENTION_DAYS: i64 = 30;
const BATCH_SIZE: i64 = 200;
const MAX_BATCHES: usize = 5;
/// A workspace that failed is retried after six hours.
const RETRY_AFTER_HOURS: i64 = 6;
/// How many due workspaces one tick opens at most.
const SWEEP_LIMIT: i64 = 500;

/// What a purge removed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PurgeResult {
    pub rows: usize,
    pub objects: usize,
}

/// One tick: the due-index sweep and what it purged.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FilePurgeTick {
    pub sweep: SweepResult,
    pub purged: PurgeResult,
}

fn keys_of(file_key: Option<&str>, storage_path: Option<&str>) -> Vec<String> {
    let mut keys = Vec::new();
    for key in [file_key, storage_path].into_iter().flatten() {
        if !key.is_empty() && !keys.iter().any(|k| k == key) {
            keys.push(key.to_owned());
        }
    }
    keys
}

/// Keys of `candidates` that a row outside the batch still points at.
async fn still_referenced(
    db: &PgPool,
    candidates: &[String],
    project_file_ids: &[String],
    file_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let db = &orm(db);
    // `not (id = any(ids))`: an empty list leaves nothing out.
    let mut in_project_files = project_files::Entity::find()
        .select_only()
        .columns([
            project_files::Column::FileKey,
            project_files::Column::StoragePath,
        ])
        .filter(
            Condition::any()
                .add(project_files::Column::FileKey.is_in(candidates))
                .add(project_files::Column::StoragePath.is_in(candidates)),
        );
    if !project_file_ids.is_empty() {
        in_project_files =
            in_project_files.filter(project_files::Column::Id.is_not_in(project_file_ids));
    }
    let mut rows: Vec<(Option<String>, String)> = in_project_files.into_tuple().all(db).await?;
    let mut in_files = files::Entity::find()
        .select_only()
        .columns([files::Column::FileKey, files::Column::StoragePath])
        .filter(
            Condition::any()
                .add(files::Column::FileKey.is_in(candidates))
                .add(files::Column::StoragePath.is_in(candidates)),
        );
    if !file_ids.is_empty() {
        in_files = in_files.filter(files::Column::Id.is_not_in(file_ids));
    }
    rows.extend(
        in_files
            .into_tuple::<(Option<String>, String)>()
            .all(db)
            .await?,
    );
    Ok(rows
        .iter()
        .flat_map(|(key, path)| keys_of(key.as_deref(), Some(path)))
        .collect())
}

async fn delete_objects(stores: &[Arc<dyn DynFileStore>], keys: &[String]) -> Result<(), String> {
    for chunk in keys.chunks(1000) {
        for store in stores {
            store
                .delete_many_boxed(chunk)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn deletable(candidates: Vec<String>, referenced: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for key in candidates {
        if !referenced.contains(&key) && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

async fn purge_project_files_batch(
    db: &PgPool,
    stores: &[Arc<dyn DynFileStore>],
    cutoff: PrimitiveDateTime,
) -> Result<PurgeResult, String> {
    use project_files::Column;
    let batch: Vec<(String, Option<String>, String, bool)> = project_files::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::FileKey,
            Column::StoragePath,
            Column::IsFolder,
        ])
        .filter(Column::DeletedAt.is_not_null())
        .filter(Column::DeletedAt.lt(cutoff))
        .limit(BATCH_SIZE.unsigned_abs())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|e| e.to_string())?;
    if batch.is_empty() {
        return Ok(PurgeResult::default());
    }
    let ids: Vec<String> = batch.iter().map(|r| r.0.clone()).collect();
    let candidates: Vec<String> = batch
        .iter()
        .filter(|r| !r.3)
        .flat_map(|r| keys_of(r.1.as_deref(), Some(&r.2)))
        .collect();
    let referenced = still_referenced(db, &candidates, &ids, &[])
        .await
        .map_err(|e| e.to_string())?;
    let keys = deletable(candidates, &referenced);
    delete_objects(stores, &keys).await?;
    project_files::Entity::delete_many()
        .filter(Column::Id.is_in(&ids))
        .exec(&orm(db))
        .await
        .map_err(|e| e.to_string())?;
    Ok(PurgeResult {
        rows: ids.len(),
        objects: keys.len(),
    })
}

async fn purge_files_batch(
    db: &PgPool,
    stores: &[Arc<dyn DynFileStore>],
    cutoff: PrimitiveDateTime,
) -> Result<PurgeResult, String> {
    let batch: Vec<(String, Option<String>, String)> = files::Entity::find()
        .select_only()
        .columns([
            files::Column::Id,
            files::Column::FileKey,
            files::Column::StoragePath,
        ])
        .filter(files::Column::DeletedAt.is_not_null())
        .filter(files::Column::DeletedAt.lt(cutoff))
        .filter(files::Column::EntityType.is_in(["project", "task"]))
        .limit(BATCH_SIZE.unsigned_abs())
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(|e| e.to_string())?;
    if batch.is_empty() {
        return Ok(PurgeResult::default());
    }
    let ids: Vec<String> = batch.iter().map(|r| r.0.clone()).collect();
    let candidates: Vec<String> = batch
        .iter()
        .flat_map(|r| keys_of(r.1.as_deref(), Some(&r.2)))
        .collect();
    let referenced = still_referenced(db, &candidates, &[], &ids)
        .await
        .map_err(|e| e.to_string())?;
    let keys = deletable(candidates, &referenced);
    delete_objects(stores, &keys).await?;
    // Rows that reference files.id go first.
    delete_file_rows(db, &ids)
        .await
        .map_err(|e| e.to_string())?;
    Ok(PurgeResult {
        rows: ids.len(),
        objects: keys.len(),
    })
}

/// The rows that reference the files, then the files.
async fn delete_file_rows(db: &PgPool, ids: &[String]) -> Result<(), DbErr> {
    let db = &orm(db);
    document_versions::Entity::delete_many()
        .filter(document_versions::Column::FileId.is_in(ids))
        .exec(db)
        .await?;
    docs::Entity::delete_many()
        .filter(docs::Column::FileId.is_in(ids))
        .exec(db)
        .await?;
    sheets::Entity::delete_many()
        .filter(sheets::Column::FileId.is_in(ids))
        .exec(db)
        .await?;
    whiteboards::Entity::delete_many()
        .filter(whiteboards::Column::FileId.is_in(ids))
        .exec(db)
        .await?;
    files::Entity::delete_many()
        .filter(files::Column::Id.is_in(ids))
        .exec(db)
        .await?;
    Ok(())
}

/// `purgeDeletedFiles(db, store, cutoff)`: everything soft-deleted before
/// `cutoff`, up to `MAX_BATCHES` batches per table.
pub async fn purge_deleted_files(
    db: &PgPool,
    stores: &[Arc<dyn DynFileStore>],
    cutoff: OffsetDateTime,
) -> Result<PurgeResult, String> {
    let cutoff = utc_timestamp(cutoff);
    let mut total = PurgeResult::default();
    for table in 0..2 {
        for _ in 0..MAX_BATCHES {
            let done = if table == 0 {
                purge_project_files_batch(db, stores, cutoff).await?
            } else {
                purge_files_batch(db, stores, cutoff).await?
            };
            total.rows += done.rows;
            total.objects += done.objects;
            if i64::try_from(done.rows).unwrap_or(0) < BATCH_SIZE {
                break;
            }
        }
    }
    Ok(total)
}

/// `nextPurgeDueAt`: when the earliest soft-deleted file reaches the end of
/// retention; `None` when nothing is left.
pub async fn next_purge_due_at(db: &PgPool) -> Result<Option<OffsetDateTime>, DbErr> {
    let db = &orm(db);
    let project_files: Option<Option<PrimitiveDateTime>> = project_files::Entity::find()
        .select_only()
        .column_as(project_files::Column::DeletedAt.min(), "earliest")
        .filter(project_files::Column::DeletedAt.is_not_null())
        .into_tuple()
        .one(db)
        .await?;
    let files: Option<Option<PrimitiveDateTime>> = files::Entity::find()
        .select_only()
        .column_as(files::Column::DeletedAt.min(), "earliest")
        .filter(files::Column::DeletedAt.is_not_null())
        .filter(files::Column::EntityType.is_in(["project", "task"]))
        .into_tuple()
        .one(db)
        .await?;
    // `least(…)` skips a null; the instant as JavaScript reads it back.
    let earliest = [project_files.flatten(), files.flatten()]
        .into_iter()
        .flatten()
        .min();
    Ok(earliest.map(|at| {
        utc_timestamp(at.assume_utc()).assume_utc() + time::Duration::days(RETENTION_DAYS)
    }))
}

/// One daily tick (`runDeletedFilesPurge`): the due workspaces of the master
/// database's index, each purged and re-scheduled.
pub async fn run_file_purge(
    master: &PgPool,
    tenants: &TenantDatabases,
    stores: &[Arc<dyn DynFileStore>],
    now: OffsetDateTime,
) -> FilePurgeTick {
    let mut purged = PurgeResult::default();
    if stores.is_empty() {
        tracing::warn!("[FilePurge] no object storage configured; skipping sweep");
        return FilePurgeTick::default();
    }
    let cutoff = now - time::Duration::days(RETENTION_DAYS);
    let total = std::sync::Mutex::new(PurgeResult::default());
    let sweep = run_sweep(
        master,
        FILE_PURGE_KIND,
        now,
        SWEEP_LIMIT,
        Some(time::Duration::hours(RETRY_AFTER_HOURS)),
        |workspace_id, _now| {
            let tenants = Arc::clone(tenants);
            let total = &total;
            async move {
                let db = tenants(workspace_id).await?;
                let done = purge_deleted_files(&db, stores, cutoff).await?;
                if let Ok(mut total) = total.lock() {
                    total.rows += done.rows;
                    total.objects += done.objects;
                }
                next_purge_due_at(&db).await.map_err(|e| e.to_string())
            }
        },
    )
    .await;
    if let Ok(total) = total.lock() {
        purged = *total;
    }
    if sweep.due > 0 || sweep.failed > 0 {
        tracing::info!(
            due = sweep.due,
            processed = sweep.processed,
            failed = sweep.failed,
            rows = purged.rows,
            objects = purged.objects,
            "[FilePurge] tick"
        );
    }
    FilePurgeTick { sweep, purged }
}
