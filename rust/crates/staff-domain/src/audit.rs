//! Master `admin_audit_events`, as the admin console writes it
//! (`apps/web/admin/lib/audit.ts`): actor, target, a dotted action, the
//! outcome, the reason and what changed. The table has no foreign key to
//! `workspaces`, so the trail outlives a teardown (ADR SEC-009).

use sea_orm::{ConnectionTrait, DbErr, EntityTrait, Set};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_schema::master::admin_audit_events;

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

/// Writes a `success` row; inside the write's transaction (its
/// `weldsuite_db::OrmConn`), so the change and its row commit together.
pub async fn record_success<C: ConnectionTrait>(
    db: &C,
    entry: &AuditEntry<'_>,
) -> Result<(), DbErr> {
    insert(db, entry, "success", None).await
}

/// Writes a `failure` row for a write that was refused or failed after the
/// actor was known. Never fails: the refusal is what the caller reports.
pub async fn record_failure(master: &PgPool, entry: &AuditEntry<'_>, error: &str) {
    if let Err(db_error) = insert(&orm(master), entry, "failure", Some(error)).await {
        tracing::error!(%db_error, action = entry.action, "admin audit: recording a failure failed");
    }
}

async fn insert<C: ConnectionTrait>(
    db: &C,
    entry: &AuditEntry<'_>,
    outcome: &str,
    error: Option<&str>,
) -> Result<(), DbErr> {
    admin_audit_events::Entity::insert(admin_audit_events::ActiveModel {
        id: Set(generate_id("aae")),
        workspace_id: Set(entry.workspace_id.map(str::to_owned)),
        target_type: Set(entry.target_type.to_owned()),
        target_id: Set(entry.target_id.to_owned()),
        action: Set(entry.action.to_owned()),
        outcome: Set(outcome.to_owned()),
        actor_email: Set(entry.actor_email.to_owned()),
        actor_user_id: Set(Some(CLI_ACTOR_ID.to_owned())),
        reason: Set(entry.reason.map(str::to_owned)),
        details: Set(entry.details.clone()),
        error: Set(error.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await
    .map(|_| ())
}
