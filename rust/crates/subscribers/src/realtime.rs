//! The realtime subscriber: `entity-realtime-consumer.ts` in
//! realtime-worker. Every entity event becomes a `WorkspaceHub` publish on
//! the workspace's channel, through the realtime port (Valkey pub/sub on
//! Kubernetes), which the WebSocket gateway fans out to the browsers. The
//! payload is what `RealtimePublisher.publish` POSTs to `/publish/workspace`
//! (`RealtimeMessage::workspace`): topic = entity type, event = action.
//!
//! When the event names `accessUserIds`, they ride along as
//! `data._access.userIds`, so only those users get it. Delivery is
//! at-least-once; a duplicate frame is acceptable (EVT-002).

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_ports::{
    BatchHandler, BoxFuture, Delivery, Disposition, DynRealtimePublisher, RealtimeMessage,
};

use crate::event::HubEvent;
use crate::tenants::Tenants;

/// The realtime publish for `event` on the hub named `hub_key`, or `None`
/// for an event without a workspace.
pub fn realtime_message(event: &HubEvent, hub_key: &str) -> RealtimeMessage {
    let data = event.data_value();
    let data = match &event.access_user_ids {
        Some(ids) if !ids.is_empty() => {
            let mut spread = js_spread(data);
            spread.insert("_access".to_owned(), json!({ "userIds": ids }));
            Value::Object(spread)
        }
        _ => data,
    };
    let user_id = event
        .metadata
        .user_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or("system");
    RealtimeMessage::workspace(hub_key, &event.entity_type, &event.action, data, user_id)
}

/// `{ ...(value as object) }`: an object's entries, an array's or a string's
/// by index, nothing for anything else.
fn js_spread(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| (index.to_string(), item))
            .collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

/// The realtime subscriber.
#[derive(Clone)]
pub struct RealtimeSubscriber {
    tenants: Arc<dyn Tenants>,
    realtime: Arc<dyn DynRealtimePublisher>,
}

impl std::fmt::Debug for RealtimeSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RealtimeSubscriber").finish_non_exhaustive()
    }
}

impl RealtimeSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>, realtime: Arc<dyn DynRealtimePublisher>) -> Self {
        Self { tenants, realtime }
    }

    /// `handleEntityRealtimeMessage`: publish, or say why not.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, subject = delivery.subject, "realtime: not an entity event; dropped");
                return Disposition::Ack;
            }
        };
        if event.metadata.workspace_id.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "realtime: skipping event, missing workspaceId"
            );
            return Disposition::Ack;
        }
        let hub_key = match self.tenants.hub_key(&event.metadata.workspace_id).await {
            Ok(key) => key,
            Err(error) => {
                return Disposition::retry(format!("cannot find the workspace hub: {error}"));
            }
        };
        let message = realtime_message(&event, &hub_key);
        match self.realtime.publish_boxed(&message).await {
            Ok(()) => Disposition::Ack,
            Err(error) => Disposition::retry(format!(
                "WorkspaceHub publish failed for {}: {error}",
                event.event_type
            )),
        }
    }
}

impl BatchHandler for RealtimeSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_lists_ride_in_data() {
        let event = HubEvent::parse(
            br#"{"id":"evt_1","entityType":"ticket","action":"updated","data":{"id":"t1"},"accessUserIds":["u2"],"metadata":{"workspaceId":"org_1","userId":""}}"#,
        )
        .expect("parses");
        let message = realtime_message(&event, "org_1");
        assert_eq!(message.channel, "workspace:org_1");
        assert_eq!(
            message.payload,
            json!({
                "workspaceId": "org_1",
                "topic": "ticket",
                "event": "updated",
                "data": { "id": "t1", "_access": { "userIds": ["u2"] } },
                "userId": "system",
            })
        );
    }

    #[test]
    fn spreading_follows_javascript() {
        assert_eq!(
            Value::Object(js_spread(json!("ab"))),
            json!({ "0": "a", "1": "b" })
        );
        assert_eq!(Value::Object(js_spread(json!(null))), json!({}));
    }
}
