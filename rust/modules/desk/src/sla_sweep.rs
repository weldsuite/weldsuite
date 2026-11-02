//! The WeldDesk SLA sweep (`apps/workers/desk-api/src/cron/sla-sweep.ts`),
//! run every minute by `weldsuite cron desk-sla-sweep`.
//!
//! Announces SLA warnings and breaches on inbox conversations: an internal
//! `sla_warning` / `sla_breached` event on the timeline, a notification to
//! the assignee (or the whole team when unassigned), a `desk_conversation`
//! entity event for workflows and agents, and a live update of the inbox.
//!
//! It never wakes idle tenant databases (ADR DATA-008): every desk write
//! re-derives the conversation's clocks (`weldsuite_desk_domain::sla`,
//! through `append`) and the writer marks the workspace due at the earliest
//! check time ([`crate::mark_sla_due`], and the same mark in the widget API,
//! the inbound mail fan-out and the call webhook). Each tick lists the due
//! index (kind `desk_sla`, keyed by `workspaces.id`), opens the workspaces
//! that are due, re-derives their due clocks with `acknowledge`, announces
//! what came due and stores when the workspace is next due (or drops the
//! row). Global's one-time seed has nothing to add (clocks only exist since
//! the index does), so there is none.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::run_sweep;
use weldsuite_desk_domain::notify::{SlaAlert, sla_alert};
use weldsuite_desk_domain::sla::{self, Alert, ConversationRef, DUE_KIND};
use weldsuite_desk_domain::sla_calendar::iso;
use weldsuite_desk_domain::webchat::{Append, append};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_notifications::Notifier;
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, DynSystemMail, RealtimeMessage};

/// A workspace that failed (a database hiccup, a broken tenant) is retried after this.
const RETRY_AFTER: time::Duration = time::Duration::minutes(10);
/// A conversation whose clocks fail to refresh, or whose alert fails to post, is looked at again after this.
const CONVERSATION_RETRY_MS: i64 = 30 * 60_000;
/// Conversations per workspace per tick; the rest stay due for the next tick.
const CONVERSATIONS_PER_TICK: i64 = 100;
/// Due workspaces per tick (`runDueIndexSweep`'s default).
const SWEEP_LIMIT: i64 = 200;

/// A due workspace's tenant database and its Clerk org id (events,
/// realtime and notifications are keyed by it).
pub struct SlaTenant {
    pub db: PgPool,
    pub clerk_org_id: String,
}

/// Opens a workspace (`workspaces.id`) for the sweep.
pub type SlaTenants =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<SlaTenant, String>> + Send + Sync>;

/// What an announcement goes out through.
#[derive(Clone)]
pub struct SweepServices {
    pub events: EntityEventPublisher,
    /// The inbox hub; without it the live update is skipped (`env.REALTIME`).
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Notification email.
    pub mail: Option<Arc<dyn DynSystemMail>>,
}

/// One tick (`runSlaSweep`'s result).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlaSweepResult {
    pub due: usize,
    pub processed: usize,
    pub failed: usize,
    /// Always 0: there is no seed (see the module docs).
    pub seeded: usize,
    pub announced: usize,
}

impl SlaSweepResult {
    /// As TypeScript returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "due": self.due,
            "processed": self.processed,
            "failed": self.failed,
            "seeded": self.seeded,
            "announced": self.announced,
        })
    }
}

/// The timeline event an alert posts.
fn event_type(alert: &Alert) -> &'static str {
    if alert.kind == "warning" {
        "sla_warning"
    } else {
        "sla_breached"
    }
}

/// `announce(env, db, orgId, conversation, alert)`: post one warning or
/// breach. Only the timeline event can fail; the entity event, the
/// notification and the live update are best effort after it.
async fn announce(
    services: &SweepServices,
    db: &PgPool,
    org_id: &str,
    alert: &Alert,
) -> Result<(), String> {
    let event_type = event_type(alert);
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!(event_type));
    metadata.insert("metric".to_owned(), json!(alert.metric.as_str()));
    metadata.insert(
        "dueAt".to_owned(),
        alert.due_at.map_or(Value::Null, |at| json!(iso(at))),
    );
    let appended = append(
        db,
        Append {
            conversation_id: &alert.clock.conversation_id,
            kind: "event",
            author_type: "system",
            author_id: None,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let (updated, message) = appended.pair();
    let id = updated["id"].as_str().unwrap_or_default().to_owned();

    let mut data = updated.clone();
    if let Some(fields) = data.as_object_mut() {
        fields.insert("slaAlertMetric".to_owned(), json!(alert.metric.as_str()));
    }
    let event = if alert.kind == "warning" {
        ev::DESK_CONVERSATION_SLA_WARNING
    } else {
        ev::DESK_CONVERSATION_SLA_BREACHED
    };
    let context = EventContext::new(org_id, "system", EventSource::System);
    services
        .events
        .publish_and_wait(&context, EntityEvent::new(event, id.clone(), data))
        .await;

    let subject = ["title", "name", "email"]
        .into_iter()
        .map(|key| &updated[key])
        .find(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        .and_then(Value::as_str);
    let reference = format!(
        "#{}",
        weldsuite_desk_domain::workflow::shared::js_string(updated.get("conversationNumber"))
    );
    let notifications = sla_alert(
        db,
        &SlaAlert {
            kind: alert.kind,
            metric: alert.metric.as_str(),
            conversation_id: &id,
            assignee_id: updated["assigneeId"].as_str(),
            subject,
            reference: Some(&reference),
            due_at: alert.due_at.map(iso),
        },
    )
    .await;
    match notifications {
        Ok(notifications) => {
            let notifier = Notifier {
                realtime: services.realtime.clone(),
                presence: None,
                mail: services.mail.clone(),
                http: None,
                apns: None,
            };
            for notification in &notifications {
                crate::notify::deliver_with(db, &notifier, org_id, notification).await;
            }
        }
        Err(error) => tracing::error!(%error, "[DeskSla] announcing failed"),
    }

    if let Some(realtime) = &services.realtime {
        // The event is internal: the inbox hub only, never the visitor's room.
        for publish in [
            RealtimeMessage::workspace(org_id, "desk_conversation", "updated", updated, "system"),
            RealtimeMessage::workspace(org_id, "desk_message", "created", message, "system"),
        ] {
            if let Err(error) = realtime.publish_boxed(&publish).await {
                tracing::error!(%error, "[DeskSla] announcing failed");
            }
        }
    }
    Ok(())
}

/// `sweepWorkspaceSla(env, db, orgId, now)`: re-derive one workspace's due
/// clocks and announce what came due; how many alerts went out.
pub async fn sweep_workspace(
    services: &SweepServices,
    db: &PgPool,
    org_id: &str,
    now: i64,
) -> Result<usize, sqlx::Error> {
    let mut announced = 0;
    let retry_at = now + CONVERSATION_RETRY_MS;
    let ids = sla::list_due(db, now, CONVERSATIONS_PER_TICK).await?;
    for id in ids {
        let swept = async {
            let refreshed = sla::refresh(db, ConversationRef::Id(&id), now, true)
                .await
                .map_err(|error| error.to_string())?;
            if refreshed.conversation.is_none() {
                return Ok(0);
            }
            let mut sent = 0;
            for alert in &refreshed.alerts {
                match announce(services, db, org_id, alert).await {
                    Ok(()) => sent += 1,
                    Err(error) => {
                        // The refresh already marked it announced: undo that, or
                        // the retry finds nothing to say and it is lost.
                        tracing::error!(%error, kind = alert.kind, conversation = %id, org_id, "[DeskSla] announcing failed");
                        sla::release_alert(db, alert, retry_at)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
            Ok::<_, String>(sent)
        }
        .await;
        match swept {
            Ok(sent) => announced += sent,
            Err(error) => {
                tracing::error!(%error, conversation = %id, org_id, "[DeskSla] conversation failed");
                // Don't let one broken conversation keep its workspace due every tick.
                if let Err(error) = sla::back_off(db, &id, retry_at).await {
                    tracing::warn!(%error, conversation = %id, "[DeskSla] could not back off");
                }
            }
        }
    }
    Ok(announced)
}

/// `runSlaSweep(env, now)`: one tick.
pub async fn run_sla_sweep(
    master: &PgPool,
    tenants: &SlaTenants,
    services: &SweepServices,
    now: OffsetDateTime,
) -> SlaSweepResult {
    let announced = std::sync::atomic::AtomicUsize::new(0);
    let swept = run_sweep(
        master,
        DUE_KIND,
        now,
        SWEEP_LIMIT,
        Some(RETRY_AFTER),
        |workspace_id, at| {
            let tenants = Arc::clone(tenants);
            let announced = &announced;
            async move {
                let tenant = tenants(workspace_id).await?;
                let at = i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
                let sent = sweep_workspace(services, &tenant.db, &tenant.clerk_org_id, at)
                    .await
                    .map_err(|error| error.to_string())?;
                announced.fetch_add(sent, std::sync::atomic::Ordering::Relaxed);
                let next = sla::workspace_next_check_at(&tenant.db)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>(next.and_then(sla::instant))
            }
        },
    )
    .await;
    let result = SlaSweepResult {
        due: swept.due,
        processed: swept.processed,
        failed: swept.failed,
        seeded: 0,
        announced: announced.into_inner(),
    };
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            announced = result.announced,
            failed = result.failed,
            "[DeskSla] swept"
        );
    }
    result
}
