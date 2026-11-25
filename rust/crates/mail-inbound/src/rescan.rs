//! `weldsuite cron mail-attachment-scan`: settles the attachments
//! [`crate::threats`] left pending because the scanner could not be reached.
//!
//! Only workspaces the due index lists (kind [`RESCAN_KIND`], marked by
//! [`crate::store`] when it quarantines a file) are opened, never every
//! tenant. Per workspace, the oldest pending files first, a batch at a time:
//!
//! - clean, or unreadable for the scanner: moved from the quarantine
//!   folder of the mail bucket to where attachments are served;
//! - infected: the quarantined copy is deleted, the row keeps the
//!   signature, and the message gets the `threats` entry and goes to Spam;
//! - the quarantined copy is gone: marked `error`, with nothing to serve;
//! - the scanner is still unreachable: the tick stops and the workspace
//!   comes due again later.

use std::sync::Arc;
use std::time::Duration;

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{self, DueRow};
use weldsuite_mail_domain::threats::attachment_threat_json;
use weldsuite_ports::{DynFileStore, PutOptions, VirusScanner};
use weldsuite_schema::tenant::{mail_attachments, mail_messages};

use crate::context::TenantDbs;
use crate::store::timestamp;
use crate::threats::AttachmentScan;

/// The due index kind.
pub const RESCAN_KIND: &str = "mail_attachment_scan";
/// How soon after delivery a pending file is first retried.
pub const FIRST_RETRY: Duration = Duration::from_mins(2);
/// How long to wait while the scanner stays unreachable.
pub const UNAVAILABLE_RETRY: Duration = Duration::from_mins(5);
/// Workspaces per tick.
const WORKSPACES_PER_TICK: i64 = 50;
/// Files per workspace per tick; more come due again a minute later.
const FILES_PER_BATCH: u64 = 100;

/// What the rescan talks to.
#[derive(Clone)]
pub struct RescanContext {
    pub master: PgPool,
    pub tenants: Arc<dyn TenantDbs>,
    pub scanner: Arc<dyn VirusScanner>,
    /// The mail bucket, where pending files wait.
    pub mail_storage: Arc<dyn DynFileStore>,
    /// `STORAGE`, where served attachments live.
    pub storage: Arc<dyn DynFileStore>,
    /// `R2_PUBLIC_URL`.
    pub public_url: Option<String>,
}

/// What one tick did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RescanReport {
    pub workspaces: usize,
    pub clean: usize,
    pub infected: usize,
    pub unscannable: usize,
    pub missing: usize,
    /// The scanner could not be reached; the tick stopped.
    pub scanner_unavailable: bool,
}

/// Why a workspace's batch stopped.
enum Stop {
    Unavailable,
    Failed(String),
}

/// One tick over the due workspaces.
pub async fn rescan_due(
    ctx: &RescanContext,
    now: OffsetDateTime,
) -> Result<RescanReport, sea_orm::DbErr> {
    let rows = due_index::list_due(&ctx.master, RESCAN_KIND, now, WORKSPACES_PER_TICK).await?;
    let mut report = RescanReport::default();
    for row in rows {
        report.workspaces += 1;
        let next = match rescan_workspace(ctx, &row, &mut report).await {
            Ok(true) => Some(now + Duration::from_mins(1)),
            Ok(false) => None,
            Err(Stop::Unavailable) => {
                report.scanner_unavailable = true;
                settle(ctx, &row, Some(now + UNAVAILABLE_RETRY)).await;
                break;
            }
            Err(Stop::Failed(error)) => {
                tracing::error!(workspace = %row.workspace_id, %error, "[Rescan] workspace failed");
                Some(now + UNAVAILABLE_RETRY)
            }
        };
        settle(ctx, &row, next).await;
    }
    Ok(report)
}

async fn settle(ctx: &RescanContext, row: &DueRow, next: Option<OffsetDateTime>) {
    if let Err(error) = due_index::settle(&ctx.master, RESCAN_KIND, row, next).await {
        tracing::warn!(workspace = %row.workspace_id, %error, "[Rescan] could not settle the due row");
    }
}

/// One batch of a workspace's pending files; whether some are left.
async fn rescan_workspace(
    ctx: &RescanContext,
    row: &DueRow,
    report: &mut RescanReport,
) -> Result<bool, Stop> {
    let db = ctx
        .tenants
        .tenant_db(&row.workspace_id)
        .await
        .map_err(|error| Stop::Failed(error.to_string()))?;
    let orm = weldsuite_db::orm(&db);
    let pending = || {
        mail_attachments::Entity::find()
            .filter(mail_attachments::Column::ScanStatus.eq("pending"))
            .filter(mail_attachments::Column::DeletedAt.is_null())
    };
    let batch = pending()
        .order_by_asc(mail_attachments::Column::CreatedAt)
        .limit(FILES_PER_BATCH)
        .all(&orm)
        .await
        .map_err(|error| Stop::Failed(error.to_string()))?;
    for attachment in batch {
        rescan_one(ctx, &db, &row.workspace_id, attachment, report).await?;
    }
    let left = pending()
        .count(&orm)
        .await
        .map_err(|error| Stop::Failed(error.to_string()))?;
    Ok(left > 0)
}

/// Where a pending file is served from once it is cleared: the folder the
/// store writes attachments to, under the quarantined copy's own name.
pub fn served_key(workspace_id: &str, message_id: &str, quarantine_key: &str) -> String {
    let name = quarantine_key.rsplit('/').next().unwrap_or("attachment");
    format!("workspaces/{workspace_id}/mail/attachments/{message_id}/{name}")
}

async fn rescan_one(
    ctx: &RescanContext,
    db: &PgPool,
    workspace_id: &str,
    attachment: mail_attachments::Model,
    report: &mut RescanReport,
) -> Result<(), Stop> {
    let failed = |error: String| Stop::Failed(error);
    let quarantined = attachment
        .storage_path
        .clone()
        .filter(|key| key.starts_with("mail/") && key.contains("/quarantine/"));
    let bytes = match &quarantined {
        Some(key) => ctx
            .mail_storage
            .get_boxed(key)
            .await
            .map_err(|error| failed(error.to_string()))?
            .map(|object| object.bytes),
        None => None,
    };
    let Some(bytes) = bytes else {
        tracing::warn!(attachment = %attachment.id, "[Rescan] quarantined copy missing; marked error");
        report.missing += 1;
        return settle_row(db, attachment, AttachmentScan::Unscannable, None).await;
    };
    let scan = match ctx.scanner.scan(&bytes).await {
        Ok(verdict) => AttachmentScan::from_verdict(verdict),
        Err(error) => {
            tracing::warn!(%error, "[Rescan] scanner still unreachable");
            return Err(Stop::Unavailable);
        }
    };
    let key = quarantined.unwrap_or_default();
    if let AttachmentScan::Infected { signature } = &scan {
        report.infected += 1;
        tracing::warn!(attachment = %attachment.id, signature, "[Rescan] infected");
        mark_message_dangerous(db, &attachment, signature).await?;
        if let Err(error) = ctx.mail_storage.delete_boxed(&key).await {
            tracing::warn!(%error, "[Rescan] could not delete the quarantined copy");
        }
        return settle_row(db, attachment, scan, None).await;
    }
    if scan == AttachmentScan::Unscannable {
        report.unscannable += 1;
    } else {
        report.clean += 1;
    }
    let served = served_key(workspace_id, &attachment.message_id, &key);
    let content_type = attachment
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    ctx.storage
        .put_boxed(&served, bytes, &PutOptions::content_type(content_type))
        .await
        .map_err(|error| failed(error.to_string()))?;
    let url = ctx
        .public_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .map_or_else(String::new, |base| format!("{base}/{served}"));
    settle_row(db, attachment, scan, Some((served, url))).await?;
    if let Err(error) = ctx.mail_storage.delete_boxed(&key).await {
        tracing::warn!(%error, "[Rescan] could not delete the quarantined copy");
    }
    Ok(())
}

/// The row's verdict; `served` is its new key and URL when it is served now.
async fn settle_row(
    db: &PgPool,
    attachment: mail_attachments::Model,
    scan: AttachmentScan,
    served: Option<(String, String)>,
) -> Result<(), Stop> {
    let now = timestamp(weldsuite_mail_domain::outbound::clock::now_ms());
    let mut row: mail_attachments::ActiveModel = attachment.into();
    row.scan_status = Set(scan.status().map(str::to_owned));
    row.scan_signature = Set(scan.signature().map(str::to_owned));
    row.scanned_at = Set(Some(now));
    row.updated_at = Set(now);
    let (key, url) = served.map_or((None, None), |(key, url)| (Some(key), Some(url)));
    row.storage_path = Set(key);
    row.download_url = Set(url);
    row.update(&weldsuite_db::orm(db))
        .await
        .map(|_| ())
        .map_err(|error| Stop::Failed(error.to_string()))
}

/// An infected file found after delivery: its message gets the `threats`
/// entry and goes to Spam, as it would have at delivery. The move is the
/// mailbox's own "move to Spam" (`labels::move_messages_to_location`): only
/// the other locations leave the labels, so stars, importance and the
/// reader's own labels stay, and a message already in the trash leaves it.
async fn mark_message_dangerous(
    db: &PgPool,
    attachment: &mail_attachments::Model,
    signature: &str,
) -> Result<(), Stop> {
    let orm = weldsuite_db::orm(db);
    let message = mail_messages::Entity::find_by_id(attachment.message_id.clone())
        .one(&orm)
        .await
        .map_err(|error| Stop::Failed(error.to_string()))?;
    let Some(message) = message else {
        return Ok(());
    };
    let mut threats = match message.threats.clone() {
        Some(Value::Array(list)) => list,
        _ => Vec::new(),
    };
    threats.push(attachment_threat_json(
        &attachment.file_name,
        Some(&attachment.id),
        signature,
    ));
    let now_ms = weldsuite_mail_domain::outbound::clock::now_ms();
    let id = message.id.clone();
    let mut row: mail_messages::ActiveModel = message.into();
    row.threats = Set(Some(Value::Array(threats)));
    row.updated_at = Set(timestamp(now_ms));
    row.update(&orm)
        .await
        .map_err(|error| Stop::Failed(error.to_string()))?;
    let now = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    weldsuite_mail_domain::labels::move_messages_to_location(db, &[id], "SPAM", now)
        .await
        .map(|_| ())
        .map_err(|error| Stop::Failed(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_keys() {
        assert_eq!(
            served_key(
                "ws_1",
                "msg_a",
                "mail/ws_1/acc_1/msg_a/quarantine/2_report.pdf"
            ),
            "workspaces/ws_1/mail/attachments/msg_a/2_report.pdf"
        );
    }
}
