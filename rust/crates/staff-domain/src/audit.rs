//! Master `admin_audit_events`, as the admin console writes it
//! (`apps/web/admin/lib/audit.ts`): actor, target, a dotted action, the
//! outcome, the reason and what changed. The table has no foreign key to
//! `workspaces`, so the trail outlives a teardown (ADR SEC-009).

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_kit::generate_id;

/// `actor_user_id` of a row written by `weldsuite admin`: the console writes
/// the admin's Clerk user id there; a command has no session, so this marks
/// where the change came from. The person is `actor_email`.
pub const CLI_ACTOR_ID: &str = "cli";

/// One audit row. `target_type` is `workspace` for app access and
/// `admin_user` for the roster.
#[derive(Debug, Clone)]
pub struct AuditEntry<'a> {
    pub workspace_id: Option<&'a str>,
    pub target_type: &'a str,
    pub target_id: &'a str,
    pub action: &'a str,
    pub actor_email: &'a str,
    pub reason: Option<&'a str>,
    pub details: Option<Value>,
}

/// Writes a `success` row; inside the write's transaction, so the change and
/// its row commit together.
pub async fn record_success<'e>(
    db: impl sqlx::PgExecutor<'e>,
    entry: &AuditEntry<'_>,
) -> Result<(), sqlx::Error> {
    insert(db, entry, "success", None).await
}

/// Writes a `failure` row for a write that was refused or failed after the
/// actor was known. Never fails: the refusal is what the caller reports.
pub async fn record_failure(master: &PgPool, entry: &AuditEntry<'_>, error: &str) {
    if let Err(db_error) = insert(master, entry, "failure", Some(error)).await {
        tracing::error!(%db_error, action = entry.action, "admin audit: recording a failure failed");
    }
}

async fn insert<'e>(
    db: impl sqlx::PgExecutor<'e>,
    entry: &AuditEntry<'_>,
    outcome: &str,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into admin_audit_events
             (id, workspace_id, target_type, target_id, action, outcome,
              actor_email, actor_user_id, reason, details, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(generate_id("aae"))
    .bind(entry.workspace_id)
    .bind(entry.target_type)
    .bind(entry.target_id)
    .bind(entry.action)
    .bind(outcome)
    .bind(entry.actor_email)
    .bind(CLI_ACTOR_ID)
    .bind(entry.reason)
    .bind(entry.details.clone())
    .bind(error)
    .execute(db)
    .await
    .map(|_| ())
}
