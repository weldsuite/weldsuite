//! The purge of soft-deleted WeldFlow files (`cron/purge-deleted-files.ts`,
//! `weldsuite cron flow-file-purge`): once a project file, task attachment
//! or project document has been deleted for `RETENTION_DAYS`, its object
//! and then its row go. Only workspaces the `file_purge` due index lists
//! are opened (ADR DATA-008); the delete routes mark them due.

use std::sync::Arc;

use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_ports::DynFileStore;

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
) -> Result<Vec<String>, sqlx::Error> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select file_key, storage_path from project_files
         where (file_key = any($1) or storage_path = any($1)) and not (id = any($2))
         union all
         select file_key, storage_path from files
         where (file_key = any($1) or storage_path = any($1)) and not (id = any($3))",
    )
    .bind(candidates)
    .bind(project_file_ids)
    .bind(file_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .iter()
        .flat_map(|(key, path)| keys_of(key.as_deref(), path.as_deref()))
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
    cutoff: &str,
) -> Result<PurgeResult, String> {
    let batch: Vec<(String, Option<String>, String, bool)> = sqlx::query_as(
        "select id, file_key, storage_path, is_folder from project_files
         where deleted_at is not null and deleted_at < $1::timestamp limit $2",
    )
    .bind(cutoff)
    .bind(BATCH_SIZE)
    .fetch_all(db)
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
    sqlx::query("delete from project_files where id = any($1)")
        .bind(&ids)
        .execute(db)
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
    cutoff: &str,
) -> Result<PurgeResult, String> {
    let batch: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, file_key, storage_path from files
         where deleted_at is not null and deleted_at < $1::timestamp
           and entity_type in ('project', 'task')
         limit $2",
    )
    .bind(cutoff)
    .bind(BATCH_SIZE)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if batch.is_empty() {
        return Ok(PurgeResult::default());
    }
    let ids: Vec<String> = batch.iter().map(|r| r.0.clone()).collect();
    let candidates: Vec<String> = batch
        .iter()
        .flat_map(|r| keys_of(r.1.as_deref(), r.2.as_deref()))
        .collect();
    let referenced = still_referenced(db, &candidates, &[], &ids)
        .await
        .map_err(|e| e.to_string())?;
    let keys = deletable(candidates, &referenced);
    delete_objects(stores, &keys).await?;
    // Rows that reference files.id go first.
    for statement in [
        "delete from document_versions where file_id = any($1)",
        "delete from docs where file_id = any($1)",
        "delete from sheets where file_id = any($1)",
        "delete from whiteboards where file_id = any($1)",
        "delete from files where id = any($1)",
    ] {
        sqlx::query(statement)
            .bind(&ids)
            .execute(db)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(PurgeResult {
        rows: ids.len(),
        objects: keys.len(),
    })
}

/// `purgeDeletedFiles(db, store, cutoff)`: everything soft-deleted before
/// `cutoff`, up to `MAX_BATCHES` batches per table.
pub async fn purge_deleted_files(
    db: &PgPool,
    stores: &[Arc<dyn DynFileStore>],
    cutoff: OffsetDateTime,
) -> Result<PurgeResult, String> {
    let cutoff = weldsuite_events::iso_timestamp(cutoff);
    let mut total = PurgeResult::default();
    for table in 0..2 {
        for _ in 0..MAX_BATCHES {
            let done = if table == 0 {
                purge_project_files_batch(db, stores, &cutoff).await?
            } else {
                purge_files_batch(db, stores, &cutoff).await?
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
pub async fn next_purge_due_at(db: &PgPool) -> Result<Option<OffsetDateTime>, sqlx::Error> {
    let earliest: Option<String> = sqlx::query_scalar(
        "select to_jsonb(least(
             (select min(deleted_at) from project_files where deleted_at is not null),
             (select min(deleted_at) from files
              where deleted_at is not null and entity_type in ('project', 'task'))
         )) #>> '{}'",
    )
    .fetch_one(db)
    .await?;
    Ok(earliest
        .as_deref()
        .and_then(weldsuite_db::js_timestamp)
        .and_then(|at| {
            OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|at| at + time::Duration::days(RETENTION_DAYS)))
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
