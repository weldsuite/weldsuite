//! The send engine around the tick (`cron/send-sweep.ts`,
//! `queue/send-consumer.ts`) on the Kubernetes editions:
//!
//! - `weldsuite cron reach-send-sweep` (every minute) reads only the master
//!   due index (kind `reach_send`, which the routes write) and publishes one
//!   [`ReachSendMessage`] per due workspace on NATS `JetStream`
//!   ([`SEND_SUBJECT`] in [`SEND_STREAM`]); it stores a provisional next due
//!   time until the consumer reports the real one. It never opens a tenant
//!   database.
//! - the `reach-send` subscriber of `weldsuite consume`
//!   ([`ReachSendSubscriber`]) runs [`process_send_message`] per message:
//!   access from the master database (never a cache), the
//!   `weldreach-sending` kill switch, then the tenant's send tick
//!   (`weldsuite_reach_domain::engine::tick`), and settles the due row.
//!
//! An unexpected error retries the message; the claim and the message rows
//! make a retry safe (nothing is sent twice).

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::Keyring;
use weldsuite_db::due_index::{self, DueRow, SweepResult};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_ports::{
    BatchHandler, BoxFuture, BusMessage, Delivery, Disposition, DynEventBus, DynFlagSource,
    FlagContext, FlagSourceExt,
};
use weldsuite_reach_domain::access::may_send;
use weldsuite_reach_domain::engine::tick::{TickDeps, TickResult, run_send_tick};
use weldsuite_reach_domain::inbox::AccessState;
use weldsuite_reach_domain::schemas::{WELDREACH_APP_CODE, resolve_limits};
use weldsuite_reach_domain::smtp::SmtpTransport;
use weldsuite_reach_domain::{EventSink, ReachEvent, epoch_ms, from_epoch_ms, iso};

/// The due-index kind (`SEND_DUE_KIND`).
pub const SEND_DUE_KIND: &str = "reach_send";
/// The `JetStream` subject and stream of the `reach-send` queue.
pub const SEND_SUBJECT: &str = "reach.send";
pub const SEND_STREAM: &str = "REACH_SEND";
/// The durable consumer's name.
pub const SEND_CONSUMER: &str = "reach-send";
/// Stored when a workspace is published, until its consumer reports.
const PROVISIONAL_NEXT_DUE_MS: i64 = 10 * 60_000;
/// Back-off for a workspace the sweep could not publish.
const ENQUEUE_RETRY: time::Duration = time::Duration::minutes(2);
const SWEEP_LIMIT: i64 = 200;
/// Look again this long after a workspace was found not allowed to send.
const NOT_ALLOWED_RECHECK_MS: i64 = 60 * 60_000;
const KILL_SWITCH_RECHECK_MS: i64 = 5 * 60_000;

/// One `reach-send` message: send whatever is due in this workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachSendMessage {
    /// `workspaces.id` (the due-index key).
    pub workspace_id: String,
    /// Epoch ms the sweep published it, for lag logging.
    pub enqueued_at: i64,
}

/// `runSendSweep(env, now)`: publish every due workspace.
pub async fn run_send_sweep(
    master: &PgPool,
    bus: &dyn DynEventBus,
    now: OffsetDateTime,
) -> SweepResult {
    let result = due_index::run_sweep(
        master,
        SEND_DUE_KIND,
        now,
        SWEEP_LIMIT,
        Some(ENQUEUE_RETRY),
        |workspace_id, now| async move {
            let enqueued_at = epoch_ms(now);
            let message = ReachSendMessage {
                workspace_id: workspace_id.clone(),
                enqueued_at,
            };
            let payload = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
            bus.publish_boxed(BusMessage {
                subject: SEND_SUBJECT.to_owned(),
                id: format!("reach-send:{workspace_id}:{}", enqueued_at / 60_000),
                payload,
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok::<_, String>(Some(from_epoch_ms(enqueued_at + PROVISIONAL_NEXT_DUE_MS)))
        },
    )
    .await;
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            enqueued = result.processed,
            failed = result.failed,
            "[ReachSendSweep]"
        );
    }
    result
}

/// The sweep without a queue (no NATS): run each due workspace's tick in
/// this process, one after the other. A workspace that fails is looked at
/// again in a minute (the queue's `retry({ delaySeconds: 60 })`).
pub async fn run_send_inline(
    engine: &SendEngine,
    clock: &(dyn Fn() -> OffsetDateTime + Send + Sync),
) -> SweepResult {
    let now = clock();
    let mut result = SweepResult::default();
    let rows = match due_index::list_due(&engine.master, SEND_DUE_KIND, now, SWEEP_LIMIT).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "[ReachSendSweep] due index unavailable; skipping tick");
            return result;
        }
    };
    result.due = rows.len();
    for row in rows {
        let message = ReachSendMessage {
            workspace_id: row.workspace_id.clone(),
            enqueued_at: epoch_ms(now),
        };
        match process_send_message(engine, &message, clock).await {
            Ok(_) => result.processed += 1,
            Err(error) => {
                result.failed += 1;
                tracing::error!(%error, workspace_id = row.workspace_id, "[reach-send] failed, will retry");
                let retry = from_epoch_ms(epoch_ms(clock()) + 60_000);
                settle_send_due(&engine.master, &row.workspace_id, Some(&row), Some(retry)).await;
            }
        }
    }
    result
}

/// A workspace's tenant, for background work.
pub struct SendTenant {
    pub db: PgPool,
    pub clerk_org_id: Option<String>,
}

/// Opens a workspace's tenant database by `workspaces.id`.
pub type SendTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<SendTenant, String>> + Send + Sync>;

/// What the consumer needs.
pub struct SendEngine {
    pub master: PgPool,
    pub tenants: SendTenants,
    pub keyring: Keyring,
    pub transport: Arc<dyn SmtpTransport>,
    pub events: EntityEventPublisher,
    pub flags: Arc<dyn DynFlagSource>,
}

/// `SendMessageOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    Ticked(TickResult),
    Skipped(String),
}

/// Entity events of background work, as the system user.
pub struct SystemEvents<'a> {
    pub publisher: &'a EntityEventPublisher,
    pub context: EventContext,
}

impl EventSink for SystemEvents<'_> {
    fn emit(&self, event: ReachEvent) {
        let mut entity = EntityEvent::new(event.event, event.entity_id, event.data);
        if let Some(changes) = event.changes {
            entity = entity.with_changes(changes);
        }
        self.publisher.publish(&self.context, entity);
    }
}

/// `settleSendDue(d1, workspace, row, next)`: replace the row unless a
/// write path touched it since it was read; otherwise only pull it forward.
async fn settle_send_due(
    master: &PgPool,
    workspace_id: &str,
    row: Option<&DueRow>,
    next: Option<OffsetDateTime>,
) {
    if let Some(row) = row {
        match due_index::settle(master, SEND_DUE_KIND, row, next).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%error, workspace_id, "[ReachSendSweep] could not settle");
            }
        }
    }
    if let Some(next) = next {
        due_index::mark_due(master, SEND_DUE_KIND, workspace_id, next).await;
    }
}

/// `processSendMessage(env, body, deps)`.
pub async fn process_send_message(
    engine: &SendEngine,
    message: &ReachSendMessage,
    clock: &(dyn Fn() -> OffsetDateTime + Send + Sync),
) -> Result<SendOutcome, String> {
    let now = clock();
    let master = &engine.master;
    let workspace_id = message.workspace_id.as_str();
    let due_row = match due_index::read_due(master, SEND_DUE_KIND, workspace_id).await {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(%error, workspace_id, "[ReachSendSweep] could not read the due row");
            None
        }
    };
    let access = weldsuite_pipeline::read_app_access(master, workspace_id, WELDREACH_APP_CODE)
        .await
        .map_err(|e| e.to_string())?;
    let Some(id) = access.workspace_id.clone() else {
        // No such workspace any more: nothing will ever be due here again.
        settle_send_due(master, workspace_id, due_row.as_ref(), None).await;
        return Ok(SendOutcome::Skipped("unknown_workspace".to_owned()));
    };
    let state = AccessState {
        status: access.status.clone(),
        billing_status: access.billing_status.clone(),
        billing_status_at: access.billing_status_at.clone(),
    };
    if let Err(reason) = may_send(&state, now) {
        let later = from_epoch_ms(epoch_ms(now) + NOT_ALLOWED_RECHECK_MS);
        settle_send_due(master, workspace_id, due_row.as_ref(), Some(later)).await;
        return Ok(SendOutcome::Skipped(reason));
    }
    let tenant = (engine.tenants)(id.clone()).await?;
    let flags = FlagContext {
        workspace_id: id.clone(),
        clerk_org_id: tenant.clerk_org_id.clone(),
        user_id: "system".to_owned(),
    };
    if !engine
        .flags
        .is_on(weldsuite_catalogs::flags::WELDREACH_SENDING, &flags)
        .await
    {
        let later = from_epoch_ms(epoch_ms(now) + KILL_SWITCH_RECHECK_MS);
        settle_send_due(master, workspace_id, due_row.as_ref(), Some(later)).await;
        return Ok(SendOutcome::Skipped("kill_switch".to_owned()));
    }
    let limits = resolve_limits(Some(&access.limits));
    let events = SystemEvents {
        publisher: &engine.events,
        context: EventContext::new(
            tenant.clerk_org_id.clone().unwrap_or_else(|| id.clone()),
            "system",
            EventSource::System,
        ),
    };
    let tick = run_send_tick(&TickDeps {
        db: &tenant.db,
        keyring: &engine.keyring,
        transport: engine.transport.as_ref(),
        events: &events,
        limits: &limits,
        clock,
    })
    .await
    .map_err(|e| e.message)?;
    settle_send_due(master, workspace_id, due_row.as_ref(), tick.next_due_at).await;
    if tick.claimed > 0 {
        tracing::info!(
            workspace_id,
            claimed = tick.claimed,
            sent = tick.sent,
            bounced = tick.bounced,
            failed = tick.failed,
            deferred = tick.deferred,
            next_due_at = tick.next_due_at.map(iso),
            "[reach-send]"
        );
    }
    Ok(SendOutcome::Ticked(tick))
}

/// The `reach-send` subscriber of `weldsuite consume`.
pub struct ReachSendSubscriber {
    engine: SendEngine,
}

impl ReachSendSubscriber {
    pub fn new(engine: SendEngine) -> Self {
        Self { engine }
    }
}

impl BatchHandler for ReachSendSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                let message: ReachSendMessage = match serde_json::from_slice(&delivery.payload) {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::error!(%error, "[reach-send] a message that is not JSON; dropped");
                        out.push(Disposition::Ack);
                        continue;
                    }
                };
                match process_send_message(&self.engine, &message, &OffsetDateTime::now_utc).await {
                    Ok(_) => out.push(Disposition::Ack),
                    Err(error) => {
                        tracing::error!(%error, workspace_id = message.workspace_id, "[reach-send] failed, will retry");
                        out.push(Disposition::retry(error));
                    }
                }
            }
            out
        })
    }
}
