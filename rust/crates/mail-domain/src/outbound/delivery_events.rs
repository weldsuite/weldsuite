//! Delivery events (`outbound/delivery-events.ts`) and their queue consumer
//! (`handleSendingEventsBatch`): `message.delivered | deferred | bounced |
//! complained | rejected | failed`, applied to the sender's workspace:
//!
//! - the ledger counts them (bounce and complaint rates drive the risk);
//! - the matching SENT copy gets its `delivery_status`;
//! - hard bounces and complaints become suppressions.
//!
//! On Global the events are Cloudflare Email Sending's, on a queue; on
//! Kubernetes the relay's webhook maps its payload to the same shape and
//! publishes it on NATS (ADR MAIL-010), so this parser serves both.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::BoxFuture;

use super::clock::{iso, now_ms, parse_iso};
use super::correspondents::add_suppression;
use super::ledger::OutboundLedger;
use super::ledger_core::{DeliveryEventType, LedgerSubject};
use super::review::Delivery;
use crate::text::{js_trim, utf16_prefix};

/// `ParsedSendingEvent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSendingEvent {
    pub kind: DeliveryEventType,
    pub sender: String,
    pub recipient: String,
    /// ms since the epoch.
    pub at_ms: i64,
    /// SMTP response or bounce/complaint type, at most 500 characters.
    pub detail: Option<String>,
}

const PREFIX: &str = "cf.email.sending.message.";

/// `parseSendingEvent(body)`: `None` for anything that isn't an event we use.
pub fn parse_sending_event(body: &Value) -> Option<ParsedSendingEvent> {
    let event = body.as_object()?;
    let name = event.get("type")?.as_str()?.strip_prefix(PREFIX)?;
    let empty = json!({});
    let payload = match event.get("payload") {
        Some(Value::Null) | None => &empty,
        Some(payload) => payload,
    };
    let address = |field: &str| {
        payload
            .get(field)
            .and_then(Value::as_str)
            .map(|s| js_trim(s).to_lowercase())
            .unwrap_or_default()
    };
    let sender = address("sender");
    let recipient = address("recipient");
    if !sender.contains('@') || !recipient.contains('@') {
        return None;
    }
    let kind = match name {
        "bounced" => {
            if payload.pointer("/bounce/type").and_then(Value::as_str) == Some("soft") {
                DeliveryEventType::SoftBounce
            } else {
                DeliveryEventType::HardBounce
            }
        }
        "delivered" => DeliveryEventType::Delivered,
        "deferred" => DeliveryEventType::Deferred,
        "complained" => DeliveryEventType::Complained,
        "rejected" => DeliveryEventType::Rejected,
        "failed" => DeliveryEventType::Failed,
        _ => return None,
    };
    let at_ms = event
        .get("metadata")
        .and_then(|m| m.get("eventTimestamp"))
        .and_then(Value::as_str)
        .and_then(parse_iso)
        .unwrap_or_else(now_ms);
    let smtp = payload
        .pointer("/delivery/smtpResponse")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let detail = smtp.map(str::to_owned).or_else(|| {
        (kind == DeliveryEventType::Complained)
            .then(|| payload.pointer("/complaint/type").and_then(Value::as_str))
            .flatten()
            .map(|t| format!("complaint: {t}"))
    });
    Some(ParsedSendingEvent {
        kind,
        sender,
        recipient,
        at_ms,
        detail: detail.map(|d| utf16_prefix(&d, 500).to_owned()),
    })
}

/// `STATUS_FOR`.
fn status_for(kind: DeliveryEventType) -> &'static str {
    match kind {
        DeliveryEventType::Delivered => "delivered",
        DeliveryEventType::Deferred => "deferred",
        DeliveryEventType::HardBounce | DeliveryEventType::SoftBounce => "bounced",
        DeliveryEventType::Complained => "complained",
        DeliveryEventType::Rejected => "rejected",
        DeliveryEventType::Failed => "failed",
    }
}

/// `STATUS_RANK`: a later event only replaces an equal or weaker status.
fn status_rank(status: &str) -> i32 {
    match status {
        "deferred" => 0,
        "delivered" => 1,
        "failed" | "rejected" => 2,
        "bounced" => 3,
        "complained" => 4,
        _ => -1,
    }
}

/// `markSentCopy(db, accountId, event)`: the delivery status on the latest
/// SENT copy from this account to this recipient (the `postgres` store's
/// `delivery.match`).
pub async fn mark_sent_copy(
    db: &PgPool,
    account_id: &str,
    event: &ParsedSendingEvent,
) -> Result<bool, sqlx::Error> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, delivery_status from mail_messages
         where account_id = $1 and source = 'sent'
           and sent_date >= $2::timestamp and sent_date <= $3::timestamp
           and exists (
             select 1 from jsonb_array_elements(
               coalesce(case when jsonb_typeof(\"to\") = 'array' then \"to\" end, '[]'::jsonb)
               || coalesce(case when jsonb_typeof(cc) = 'array' then cc end, '[]'::jsonb)
               || coalesce(case when jsonb_typeof(bcc) = 'array' then bcc end, '[]'::jsonb)
             ) as r where lower(r->>'email') = $4
           )
         order by sent_date desc
         limit 1",
    )
    .bind(account_id)
    .bind(iso(event.at_ms - 3 * 86_400_000))
    .bind(iso(event.at_ms + 3_600_000))
    .bind(&event.recipient)
    .fetch_optional(db)
    .await?;
    let Some((id, current)) = row else {
        return Ok(false);
    };
    let next = status_for(event.kind);
    if current
        .as_deref()
        .is_some_and(|status| status_rank(status) > status_rank(next))
    {
        return Ok(false);
    }
    sqlx::query(
        "update mail_messages
         set delivery_status = $2, delivery_updated_at = $3::timestamp, delivery_detail = $4
         where id = $1",
    )
    .bind(&id)
    .bind(next)
    .bind(iso(event.at_ms))
    .bind(&event.detail)
    .execute(db)
    .await?;
    Ok(true)
}

/// A workspace's tenant database, by `workspaces.id` or Clerk org id.
pub trait TenantDatabases: Send + Sync {
    fn tenant<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<PgPool, String>>;
}

struct SenderRoute {
    subject: LedgerSubject,
    account_id: String,
    clerk_org_id: Option<String>,
}

/// `(workspace_id, personal_account_id, account_id, clerk_org_id)`.
type RegistryRow = (Option<String>, Option<String>, String, Option<String>);

async fn resolve_sender(master: &PgPool, sender: &str) -> Result<Option<SenderRoute>, sqlx::Error> {
    let row: Option<RegistryRow> = sqlx::query_as(
        "select r.workspace_id, r.personal_account_id, r.account_id, w.clerk_org_id
         from mail_account_registry r
         left join workspaces w on w.id = r.workspace_id
         where r.email = $1
         limit 1",
    )
    .bind(sender)
    .fetch_optional(master)
    .await?;
    Ok(
        row.and_then(|(workspace, personal, account_id, clerk_org_id)| {
            if let Some(workspace_id) = workspace {
                return Some(SenderRoute {
                    subject: LedgerSubject::Workspace {
                        workspace_id,
                        clerk_org_id: clerk_org_id.clone(),
                    },
                    account_id,
                    clerk_org_id,
                });
            }
            personal.map(|personal_account_id| SenderRoute {
                subject: LedgerSubject::Personal {
                    personal_account_id,
                    plan: "free".to_owned(),
                },
                account_id,
                clerk_org_id: None,
            })
        }),
    )
}

/// What applying events needs.
pub struct DeliveryEventsDeps<'a> {
    pub master: &'a PgPool,
    pub ledger: Option<&'a dyn OutboundLedger>,
    pub tenants: &'a dyn TenantDatabases,
}

/// `applySendingEvents(env, events)`: the number applied. Events from an
/// unknown sender are skipped. Fails only on infrastructure, so the queue
/// retries the batch.
pub async fn apply_sending_events(
    deps: &DeliveryEventsDeps<'_>,
    events: &[ParsedSendingEvent],
) -> Result<usize, String> {
    let mut by_sender: BTreeMap<&str, Vec<&ParsedSendingEvent>> = BTreeMap::new();
    let mut order: Vec<&str> = Vec::new();
    for event in events {
        if !by_sender.contains_key(event.sender.as_str()) {
            order.push(&event.sender);
        }
        by_sender.entry(&event.sender).or_default().push(event);
    }
    let mut applied = 0;
    for sender in order {
        let sender_events = &by_sender[sender];
        let Some(route) = resolve_sender(deps.master, sender)
            .await
            .map_err(|error| error.to_string())?
        else {
            continue;
        };
        if let Some(ledger) = deps.ledger {
            let key = route.subject.ledger_key();
            for event in sender_events {
                ledger
                    .record_delivery(&key, &route.subject, event.kind, event.at_ms)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        if let (LedgerSubject::Workspace { .. }, Some(org)) = (&route.subject, &route.clerk_org_id)
        {
            let db = deps.tenants.tenant(org).await?;
            for event in sender_events {
                apply_to_tenant(&db, &route.account_id, sender, event).await;
            }
        }
        applied += sender_events.len();
    }
    Ok(applied)
}

/// Mark the SENT copy and suppress the address after a hard bounce or a
/// complaint. Never fails: a tenant without the tables yet is logged.
async fn apply_to_tenant(db: &PgPool, account_id: &str, sender: &str, event: &ParsedSendingEvent) {
    let result = async {
        mark_sent_copy(db, account_id, event).await?;
        let reason = match event.kind {
            DeliveryEventType::Complained => "complaint",
            DeliveryEventType::HardBounce => "hard_bounce",
            _ => return Ok(()),
        };
        let details = event.detail.as_ref().map(|d| json!({ "detail": d }));
        add_suppression(
            db,
            &event.recipient,
            reason,
            Some(sender),
            "cloudflare_event",
            details.as_ref(),
            now_ms(),
        )
        .await
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "[outbound-events] tenant update failed");
    }
}

/// `handleSendingEventsBatch(batch, env)`: parse and apply; malformed
/// messages are acked and dropped, an infrastructure failure retries all.
pub async fn handle_sending_events_batch(
    deps: &DeliveryEventsDeps<'_>,
    bodies: &[Value],
) -> Delivery {
    let parsed: Vec<ParsedSendingEvent> = bodies.iter().filter_map(parse_sending_event).collect();
    if !parsed.is_empty()
        && let Err(error) = apply_sending_events(deps, &parsed).await
    {
        tracing::error!(%error, "[outbound-events] batch failed, retrying");
        return Delivery::Retry;
    }
    Delivery::Ack
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cloudflare_events() {
        let bounce = json!({
            "type": "cf.email.sending.message.bounced",
            "payload": {
                "sender": " Tom@Acme.com ",
                "recipient": "gone@x.com",
                "bounce": { "type": "hard" },
                "delivery": { "smtpResponse": "550 5.1.1 no such user" }
            },
            "metadata": { "eventTimestamp": "2026-10-13T09:30:00.000Z" }
        });
        let event = parse_sending_event(&bounce).expect("event");
        assert_eq!(event.kind, DeliveryEventType::HardBounce);
        assert_eq!(event.sender, "tom@acme.com");
        assert_eq!(event.at_ms, 1_791_883_800_000);
        assert_eq!(event.detail.as_deref(), Some("550 5.1.1 no such user"));

        let soft = json!({ "type": "cf.email.sending.message.bounced", "payload": { "sender": "a@b.c", "recipient": "d@e.f", "bounce": { "type": "soft" } } });
        assert_eq!(
            parse_sending_event(&soft).map(|e| e.kind),
            Some(DeliveryEventType::SoftBounce)
        );
        let complaint = json!({ "type": "cf.email.sending.message.complained", "payload": { "sender": "a@b.c", "recipient": "d@e.f", "complaint": { "type": "abuse" } } });
        assert_eq!(
            parse_sending_event(&complaint).and_then(|e| e.detail),
            Some("complaint: abuse".to_owned())
        );
        for bad in [
            json!({ "type": "cf.email.sending.message.opened", "payload": { "sender": "a@b.c", "recipient": "d@e.f" } }),
            json!({ "type": "other.delivered", "payload": { "sender": "a@b.c", "recipient": "d@e.f" } }),
            json!({ "type": "cf.email.sending.message.delivered", "payload": { "sender": "nobody", "recipient": "d@e.f" } }),
            json!("text"),
        ] {
            assert!(parse_sending_event(&bad).is_none());
        }
    }

    #[test]
    fn stronger_statuses_win() {
        assert!(status_rank("complained") > status_rank("delivered"));
        assert!(status_rank("bounced") > status_rank("failed"));
        assert_eq!(status_for(DeliveryEventType::SoftBounce), "bounced");
    }
}
