//! WeldForms' sweeps (`cron/sweeps.ts`), run by `weldsuite cron
//! forms-reminders` and `forms-digest` every 15 minutes:
//!
//! - `forms_reminders`: the automatic invitation reminders that are due (never
//!   after the form's close date, never once completed);
//! - `forms_digest`: the daily response digest, due at 08:00 UTC once a form
//!   with daily subscribers got a response.
//!
//! Neither wakes idle tenant databases (ADR DATA-008): the timing lives in
//! the master `workspace_due_index` (Global's schedule-index D1). Inviting,
//! reminding and submitting mark the workspace due; each tick reads the
//! index, opens the workspaces that are due, does their work and stores when
//! they are next due (or drops the row). There is nothing to seed: both kinds
//! are born with the first invitation or response.

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::FORM_INVITATION_SENT;

use crate::FormsState;
use crate::common::{Ctx, text};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use crate::invitations::{REMINDERS_KIND, event_data, send_due_reminders};
use crate::notify::{DIGEST_KIND, send_due_digests};

/// A workspace that failed (a database hiccup, a broken tenant) is retried after this.
const RETRY_AFTER: time::Duration = time::Duration::minutes(30);
/// Due rows one tick reads (`listDueWorkspaces`' default).
const LIMIT: i64 = 200;

fn ms(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default()
}

fn at(ms: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// `open(env, orgId)`: the workspace's context, by its `workspaces.id`.
async fn open(
    state: &FormsState,
    request: &http::Extensions,
    workspace_id: &str,
) -> Result<Ctx, String> {
    let Some(tenants) = state.tenants.as_ref() else {
        return Err("forms sweeps: no tenant resolver".to_owned());
    };
    let tenant = tenants.tenant(workspace_id).await?;
    let workspace = if tenant.workspace_id.is_empty() {
        workspace_id.to_owned()
    } else {
        tenant.workspace_id.clone()
    };
    Ok(Ctx {
        db: tenant.db,
        master: state.master(request),
        clerk_org_id: tenant.clerk_org_id.unwrap_or_else(|| workspace.clone()),
        workspace_id: workspace,
        svc: state.services(request),
    })
}

/// `runRemindersSweep(env, now)`: `{ due, processed, failed, seeded, reminded }`.
pub async fn run_reminders_sweep(
    state: &FormsState,
    request: &http::Extensions,
    now: OffsetDateTime,
) -> Value {
    let Some(master) = state.master(request) else {
        tracing::error!("[FormsReminders] no master database; skipping tick");
        return json!({ "due": 0, "processed": 0, "failed": 0, "seeded": 0, "reminded": 0 });
    };
    let reminded = AtomicUsize::new(0);
    let result = weldsuite_db::due_index::run_sweep(
        &master,
        REMINDERS_KIND,
        now,
        LIMIT,
        Some(RETRY_AFTER),
        |workspace_id, tick| {
            let reminded = &reminded;
            async move {
                let ctx = open(state, request, &workspace_id).await?;
                let (rows, next) = send_due_reminders(&ctx, ms(tick))
                    .await
                    .map_err(|error| format!("{error:?}"))?;
                reminded.fetch_add(rows.len(), Ordering::Relaxed);
                for row in &rows {
                    ctx.publish_as(
                        "system",
                        FORM_INVITATION_SENT,
                        text(row, "id"),
                        &event_data(row, true),
                    );
                }
                Ok::<_, String>(next.map(at))
            }
        },
    )
    .await;
    let reminded = reminded.into_inner();
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            reminded,
            failed = result.failed,
            "[FormsReminders]"
        );
    }
    json!({
        "due": result.due,
        "processed": result.processed,
        "failed": result.failed,
        "seeded": 0,
        "reminded": reminded,
    })
}

/// `runDigestSweep(env, now)`: `{ due, processed, failed, seeded, sent }`.
pub async fn run_digest_sweep(
    state: &FormsState,
    request: &http::Extensions,
    now: OffsetDateTime,
) -> Value {
    let Some(master) = state.master(request) else {
        tracing::error!("[FormsDigest] no master database; skipping tick");
        return json!({ "due": 0, "processed": 0, "failed": 0, "seeded": 0, "sent": 0 });
    };
    let sent = AtomicI64::new(0);
    let result = weldsuite_db::due_index::run_sweep(
        &master,
        DIGEST_KIND,
        now,
        LIMIT,
        Some(RETRY_AFTER),
        |workspace_id, tick| {
            let sent = &sent;
            async move {
                let ctx = open(state, request, &workspace_id).await?;
                let count = send_due_digests(&ctx, ms(tick))
                    .await
                    .map_err(|error| format!("{error:?}"))?;
                sent.fetch_add(count, Ordering::Relaxed);
                // Nothing is pending after the digests: the next response marks the workspace due again.
                Ok::<_, String>(None)
            }
        },
    )
    .await;
    let sent = sent.into_inner();
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            sent,
            failed = result.failed,
            "[FormsDigest]"
        );
    }
    json!({
        "due": result.due,
        "processed": result.processed,
        "failed": result.failed,
        "seeded": 0,
        "sent": sent,
    })
}
