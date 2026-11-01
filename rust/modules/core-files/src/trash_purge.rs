//! The 30-day purge of a trashed Drive file
//! (`apps/workers/app-api/src/workflows/trash-cleanup.ts`, the
//! `TrashCleanupWorkflow`): `DELETE /api/files/:id` starts it with a delay
//! of 30 days, and when it runs it deletes the file's objects and rows for
//! good, unless the file was restored or trashed again since (its
//! `deleted_at` no longer matches).

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_core_domain::files::list_document_snapshot_keys;
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, FileStores, Job, JobContext, JobError, StepRetry, step};

/// The job's name in the registry.
pub const TRASH_PURGE_JOB: &str = "core.trash-cleanup";

/// How long a trashed file stays in the trash.
pub const TRASH_RETENTION: Duration = Duration::from_hours(30 * 24);

/// What the job is started with: the Workflow's `TrashCleanupParams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurge {
    /// The Clerk org id (a job may wait a month; the id it was started with
    /// still resolves).
    pub workspace_id: String,
    pub file_id: String,
    pub file_key: String,
    /// When the file was trashed, as `toISOString()`: the guard.
    pub deleted_at: String,
    /// `deletedAt` + 30 days.
    pub purge_at: String,
}

/// The tenant database of a workspace, by its id or Clerk org id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// The job: register one per process (`JobRegistry::register`).
pub struct TrashPurgeJob {
    tenants: TenantDatabases,
    files: Option<FileStores>,
}

impl TrashPurgeJob {
    pub fn new(tenants: TenantDatabases, files: Option<FileStores>) -> Self {
        Self { tenants, files }
    }

    async fn purge(&self, job: &TrashPurge) -> Result<bool, JobError> {
        let db = (self.tenants)(job.workspace_id.clone())
            .await
            .map_err(JobError::failed)?;
        let deleted_at: Option<Option<String>> = sqlx::query_scalar(
            r#"select to_char(deleted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                 from files where id = $1 limit 1"#,
        )
        .bind(&job.file_id)
        .fetch_optional(&db)
        .await
        .map_err(JobError::failed)?;
        let Some(deleted_at) = deleted_at else {
            tracing::info!(file_id = job.file_id, "trash purge: file already deleted");
            return Ok(false);
        };
        // Restored (no `deleted_at`) or trashed again (another one): a newer
        // job, if any, handles it.
        if deleted_at.as_deref() != Some(job.deleted_at.as_str()) {
            tracing::info!(
                file_id = job.file_id,
                "trash purge: restored or trashed again"
            );
            return Ok(false);
        }
        // The file's object and the snapshots of the sheet or document backed
        // by it, listed while their rows exist and deleted before the rows,
        // so a retry finds them again.
        let mut keys: Vec<String> = Some(job.file_key.clone())
            .filter(|key| !key.is_empty())
            .into_iter()
            .collect();
        keys.extend(
            list_document_snapshot_keys(&db, std::slice::from_ref(&job.file_id))
                .await
                .map_err(JobError::failed)?,
        );
        self.delete_objects(&keys).await;
        for statement in [
            "delete from sheets where file_id = $1",
            "delete from document_versions where file_id = $1",
            "delete from docs where file_id = $1",
            "delete from files where id = $1",
        ] {
            sqlx::query(statement)
                .bind(&job.file_id)
                .execute(&db)
                .await
                .map_err(JobError::failed)?;
        }
        tracing::info!(file_id = job.file_id, "trash purge: file deleted for good");
        Ok(true)
    }

    /// `deleteStoredObjects(env, keys).catch(log)`: both buckets, failures
    /// logged.
    async fn delete_objects(&self, keys: &[String]) {
        let Some(stores) = &self.files else {
            return;
        };
        if keys.is_empty() {
            return;
        }
        let buckets = std::iter::once(&stores.private).chain(stores.public.as_ref());
        for bucket in buckets {
            if let Err(error) = bucket.delete_many_boxed(keys).await {
                tracing::error!(%error, "trash purge: deleting objects failed");
            }
        }
    }
}

impl Job for TrashPurgeJob {
    fn name(&self) -> &'static str {
        TRASH_PURGE_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let job: TrashPurge = serde_json::from_value(payload)?;
            // `step.do('delete-file', { retries: { limit: 3, delay: '5 seconds',
            // backoff: 'exponential' } }, …)`
            let retry = StepRetry::exponential(3, Duration::from_secs(5));
            let _deleted: bool = step(ctx, "delete-file", retry, || self.purge(&job)).await?;
            Ok(())
        })
    }
}
