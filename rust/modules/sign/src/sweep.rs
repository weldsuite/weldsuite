//! The WeldSign lifecycle sweep (`apps/workers/sign-api/src/cron/lifecycle-sweep.ts`),
//! run every 15 minutes by `weldsuite cron sign-lifecycle` (a Kubernetes
//! CronJob): sends the automatic reminders that are due and closes open
//! requests whose expiry has passed (status `expired`, every link revoked,
//! the sender told).
//!
//! It never wakes idle tenant databases: timing lives in the master
//! `workspace_due_index` (kind `sign_lifecycle`, `weldsuite_db::due_index`).
//! Sending, the next signing group and a corrected email re-derive a
//! workspace's next due time (`crate::schedule`); each tick reads only the
//! index, opens the workspaces that are due, does their work and stores when
//! they are next due (or drops the row).
//!
//! The one-time seed of the TypeScript sweep is kept, for parity and for
//! data that predates the index (an import, a restore): with a cache
//! configured, the first tick marks every workspace with a live signing link
//! due and remembers that under [`LIFECYCLE_SEED_KEY`]. Without a cache
//! there is nothing to remember it with, so the seed is skipped (the write
//! paths keep the index complete from the first request sent).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use serde_json::json;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::SIGN_ENVELOPE_EXPIRED;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{mark_due, run_sweep};
use weldsuite_events::{EntityEvent, EventContext, EventSource, iso_timestamp};

use crate::finalize::TenantResolver;
use crate::lifecycle::{expire_due, send_due_reminders};
use crate::schedule::{LIFECYCLE_KIND, next_lifecycle_due_at};
use crate::{SendContext, Services, text};

/// Cache flag: workspaces with live links were seeded into the due index.
/// Bump to reseed.
pub const LIFECYCLE_SEED_KEY: &str = "sign:lifecycle-index:seed:v1";

/// A workspace that failed (database hiccup, broken tenant) is retried after this.
const RETRY_AFTER: time::Duration = time::Duration::minutes(30);

/// Due rows one tick looks at.
const SWEEP_LIMIT: i64 = 200;

/// What one tick did (`DueIndexSweepResult & { reminded, expired }`).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LifecycleSweepResult {
    pub due: usize,
    pub processed: usize,
    pub failed: usize,
    pub seeded: usize,
    pub reminded: usize,
    pub expired: usize,
}

/// The seed: every workspace with a live link, due now, once per cache.
async fn seed(master: &PgPool, services: &Services, now: OffsetDateTime) -> Result<usize, String> {
    let Some(cache) = services.cache.as_deref() else {
        return Ok(0);
    };
    if cache
        .get_boxed(LIFECYCLE_SEED_KEY)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Ok(0);
    }
    let ids: Vec<String> = sqlx::query_scalar(
        "select distinct workspace_id from sign_link_registry where revoked_at is null",
    )
    .fetch_all(master)
    .await
    .map_err(|e| e.to_string())?;
    for id in &ids {
        mark_due(master, LIFECYCLE_KIND, id, now).await;
    }
    cache
        .put_boxed(LIFECYCLE_SEED_KEY, &iso_timestamp(now), None)
        .await
        .map_err(|e| e.to_string())?;
    if !ids.is_empty() {
        tracing::info!(
            seeded = ids.len(),
            "sign lifecycle: seeded the due index (one-time)"
        );
    }
    Ok(ids.len())
}

/// One tick of the sweep (`runLifecycleSweep`).
pub async fn run_lifecycle_sweep(
    master: &PgPool,
    tenants: &Arc<dyn TenantResolver>,
    services: &Services,
    now: OffsetDateTime,
) -> LifecycleSweepResult {
    let mut result = LifecycleSweepResult::default();
    match seed(master, services, now).await {
        Ok(seeded) => result.seeded = seeded,
        Err(error) => {
            tracing::error!(%error, "sign lifecycle: seeding the due index failed; skipping tick");
            return result;
        }
    }
    let reminded = AtomicUsize::new(0);
    let expired = AtomicUsize::new(0);
    let swept = run_sweep(
        master,
        LIFECYCLE_KIND,
        now,
        SWEEP_LIMIT,
        Some(RETRY_AFTER),
        |workspace_id, at| {
            let tenants = Arc::clone(tenants);
            let services = services.clone();
            let master = master.clone();
            let (reminded, expired) = (&reminded, &expired);
            async move {
                let tenant = tenants.tenant(&workspace_id).await?;
                let clerk_org_id = tenant
                    .clerk_org_id
                    .clone()
                    .unwrap_or_else(|| tenant.workspace_id.clone());
                let ctx = SendContext {
                    db: tenant.db,
                    master,
                    clerk_org_id: clerk_org_id.clone(),
                    workspace_id: tenant.workspace_id,
                    services,
                };
                let closed = expire_due(&ctx, at).await.map_err(|e| format!("{e:?}"))?;
                expired.fetch_add(closed.len(), Ordering::Relaxed);
                // Publish before the reminders run: if they fail, the retry
                // no longer finds these requests (they are expired now) and
                // the events would be lost.
                let context = EventContext::new(&clerk_org_id, "system", EventSource::System);
                for envelope in &closed {
                    let data = json!({
                        "id": envelope["id"],
                        "title": envelope["title"],
                        "status": envelope["status"],
                        "senderUserId": envelope["senderUserId"],
                    });
                    ctx.services
                        .events
                        .publish_and_wait(
                            &context,
                            EntityEvent::new(SIGN_ENVELOPE_EXPIRED, text(envelope, "id"), data),
                        )
                        .await;
                }
                let sent = send_due_reminders(&ctx, at)
                    .await
                    .map_err(|e| format!("{e:?}"))?;
                reminded.fetch_add(sent, Ordering::Relaxed);
                next_lifecycle_due_at(&ctx.db)
                    .await
                    .map_err(|e| format!("{e:?}"))
            }
        },
    )
    .await;
    result.due = swept.due;
    result.processed = swept.processed;
    result.failed = swept.failed;
    result.reminded = reminded.into_inner();
    result.expired = expired.into_inner();
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            reminded = result.reminded,
            expired = result.expired,
            failed = result.failed,
            "sign lifecycle sweep"
        );
    }
    result
}
