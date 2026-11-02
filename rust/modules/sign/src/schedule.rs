//! When a workspace next has lifecycle work (`packages/domains/sign/src/schedule.ts`):
//! a reminder to a signer whose turn it is, or an open request reaching its
//! expiry. The lifecycle sweep (`crate::sweep`) opens a tenant database only
//! when the master due index (kind `sign_lifecycle`) says so; write paths that
//! can bring new work forward (sending, the next signing group, a corrected
//! email) re-derive it with [`schedule_lifecycle`].
//!
//! Reminders (per request, defaults from `sign_settings`): the first
//! `reminderAfterDays` after the link was sent, then every `reminderEveryDays`
//! (or once more after `reminderAfterDays` when unset), at most
//! `reminderMaxCount` automatic ones, never at or after the expiry. A
//! reminder sent by hand moves the next automatic one a full interval on,
//! without counting towards the maximum.

use serde_json::Value;
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use weldsuite_db::js_row;

use crate::{SendContext, SignResult, text};

/// The due index kind of the lifecycle sweep.
pub(crate) const LIFECYCLE_KIND: &str = "sign_lifecycle";

/// Applied when a request has a reminder delay but no maximum.
pub(crate) const DEFAULT_REMINDER_MAX: i64 = 3;

/// A timestamp column as the row holds it (`toISOString()`).
pub(crate) fn timestamp(value: &Value) -> Option<OffsetDateTime> {
    value.as_str().and_then(|at| {
        OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok()
    })
}

/// A signer whose turn it is: emailed, not yet signed or declined.
pub(crate) fn is_current_signer(recipient: &Value) -> bool {
    text(recipient, "role") == "signer" && matches!(text(recipient, "status"), "sent" | "opened")
}

/// `n` days, as `n * DAY_MS`.
fn days(n: i64) -> Duration {
    Duration::days(n)
}

/// When this signer's next automatic reminder is due, or `None` when none is
/// left (`nextReminderAt`).
pub(crate) fn next_reminder_at(envelope: &Value, recipient: &Value) -> Option<OffsetDateTime> {
    if !is_current_signer(recipient) {
        return None;
    }
    let sent_at = timestamp(&recipient["sentAt"])?;
    // `!envelope.reminderAfterDays`: null and 0 both mean "no reminders".
    let after = envelope["reminderAfterDays"].as_i64().filter(|d| *d != 0)?;
    let max = envelope["reminderMaxCount"]
        .as_i64()
        .unwrap_or(DEFAULT_REMINDER_MAX);
    if recipient["remindersSent"].as_i64().unwrap_or(0) >= max {
        return None;
    }
    let first = sent_at + days(after);
    let mut at = first;
    if let Some(last) = timestamp(&recipient["lastRemindedAt"]) {
        let every = envelope["reminderEveryDays"].as_i64().unwrap_or(after);
        at = first.max(last + days(every));
    }
    if let Some(expires) = timestamp(&envelope["expiresAt"])
        && at >= expires
    {
        return None;
    }
    Some(at)
}

/// Open requests with their signers, for the sweep and for working out the
/// next due time (`openRequests`).
pub(crate) async fn open_requests(db: &PgPool) -> SignResult<Vec<(Value, Vec<Value>)>> {
    let envelopes: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_envelopes e
         where kind = 'envelope' and status in ('sent', 'in_progress') and deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    if envelopes.is_empty() {
        return Ok(Vec::new());
    }
    let envelopes: Vec<Value> = envelopes.into_iter().map(js_row).collect();
    let ids: Vec<String> = envelopes.iter().map(|e| text(e, "id").to_owned()).collect();
    let signers: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from sign_recipients r
         where envelope_id = any($1) and role = 'signer'",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let signers: Vec<Value> = signers.into_iter().map(js_row).collect();
    Ok(envelopes
        .into_iter()
        .map(|envelope| {
            let own = signers
                .iter()
                .filter(|s| s["envelopeId"] == envelope["id"])
                .cloned()
                .collect();
            (envelope, own)
        })
        .collect())
}

/// Everyone signed: the request waits for its signed PDF, which is the
/// finalize step's job. It neither expires nor needs reminders.
pub(crate) fn all_signed(signers: &[&Value]) -> bool {
    !signers.is_empty() && signers.iter().all(|s| s["status"] == "signed")
}

/// The earliest reminder or expiry among open requests, or `None` when there
/// is none (`nextLifecycleDueAt`).
pub(crate) async fn next_lifecycle_due_at(db: &PgPool) -> SignResult<Option<OffsetDateTime>> {
    let mut earliest: Option<OffsetDateTime> = None;
    let mut consider = |at: Option<OffsetDateTime>| {
        if let Some(at) = at
            && earliest.is_none_or(|e| at < e)
        {
            earliest = Some(at);
        }
    };
    for (envelope, signers) in open_requests(db).await? {
        let refs: Vec<&Value> = signers.iter().collect();
        if all_signed(&refs) {
            continue;
        }
        consider(timestamp(&envelope["expiresAt"]));
        for signer in &signers {
            consider(next_reminder_at(&envelope, signer));
        }
    }
    Ok(earliest)
}

/// Tell the lifecycle sweep when to look at this workspace next. Best effort
/// (`scheduleLifecycle`).
pub(crate) async fn schedule_lifecycle(ctx: &SendContext) {
    let db = ctx.db.clone();
    weldsuite_db::due_index::sync_due(&ctx.master, LIFECYCLE_KIND, &ctx.workspace_id, || async {
        next_lifecycle_due_at(&db)
            .await
            .map_err(|error| format!("{error:?}"))
    })
    .await;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn signer(sent: &str, last: Option<&str>, count: i64) -> Value {
        json!({ "role": "signer", "status": "sent", "sentAt": sent, "lastRemindedAt": last, "remindersSent": count })
    }

    #[test]
    fn reminders_follow_the_interval_and_the_maximum() {
        let envelope = json!({ "reminderAfterDays": 3, "reminderEveryDays": 2, "reminderMaxCount": 2, "expiresAt": "2026-11-20T00:00:00.000Z" });
        let first = next_reminder_at(&envelope, &signer("2026-11-01T09:00:00.000Z", None, 0));
        assert_eq!(first, timestamp(&json!("2026-11-04T09:00:00.000Z")));
        let second = next_reminder_at(
            &envelope,
            &signer(
                "2026-11-01T09:00:00.000Z",
                Some("2026-11-04T10:00:00.000Z"),
                1,
            ),
        );
        assert_eq!(second, timestamp(&json!("2026-11-06T10:00:00.000Z")));
        assert_eq!(
            next_reminder_at(&envelope, &signer("2026-11-01T09:00:00.000Z", None, 2)),
            None
        );
        // Never at or after the expiry.
        let late = json!({ "reminderAfterDays": 3, "expiresAt": "2026-11-04T09:00:00.000Z" });
        assert_eq!(
            next_reminder_at(&late, &signer("2026-11-01T09:00:00.000Z", None, 0)),
            None
        );
        // No delay, or not their turn: none.
        assert_eq!(
            next_reminder_at(
                &json!({ "reminderAfterDays": 0 }),
                &signer("2026-11-01T09:00:00.000Z", None, 0)
            ),
            None
        );
        let mut pending = signer("2026-11-01T09:00:00.000Z", None, 0);
        pending["status"] = json!("pending");
        assert_eq!(next_reminder_at(&envelope, &pending), None);
    }

    #[test]
    fn all_signed_needs_a_signer() {
        assert!(!all_signed(&[]));
        let signed = json!({ "status": "signed" });
        let open = json!({ "status": "opened" });
        assert!(all_signed(&[&signed]));
        assert!(!all_signed(&[&signed, &open]));
    }
}
