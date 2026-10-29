//! Realtime publish: the port behind `RealtimePublisher`
//! (`packages/core/realtime/src/server/publisher.ts`), which POSTs to the
//! realtime-worker's `/publish/*` routes. A channel names the hub or room the
//! worker would route to; the payload is the body it would POST, so the
//! WebSocket gateway that reads these needs no translation.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use crate::{BoxFuture, PortError};

/// One realtime publish.
#[derive(Debug, Clone, PartialEq)]
pub struct RealtimeMessage {
    /// `workspace:<id>`, `support:<id>`, `conversation:<id>` or `chat:<id>`.
    pub channel: String,
    pub payload: Value,
}

/// The room kinds behind `/publish/{support,conversation,chat}/:id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Room {
    /// `SupportRoom`, keyed by workspace.
    Support,
    /// `ConversationRoom`, keyed by helpdesk conversation.
    Conversation,
    /// `ChatRoom`, keyed by chat channel.
    Chat,
}

impl Room {
    fn prefix(self) -> &'static str {
        match self {
            Self::Support => "support",
            Self::Conversation => "conversation",
            Self::Chat => "chat",
        }
    }
}

impl RealtimeMessage {
    /// A `WorkspaceHub` event (`publish()`): the `/publish/workspace` body.
    pub fn workspace(
        workspace_id: &str,
        topic: &str,
        event: &str,
        data: Value,
        user_id: &str,
    ) -> Self {
        let mut payload = serde_json::Map::new();
        payload.insert("workspaceId".to_owned(), workspace_id.into());
        payload.insert("topic".to_owned(), topic.into());
        payload.insert("event".to_owned(), event.into());
        payload.insert("data".to_owned(), data);
        payload.insert("userId".to_owned(), user_id.into());
        Self {
            channel: format!("workspace:{workspace_id}"),
            payload: Value::Object(payload),
        }
    }

    /// A `WorkspaceHub` event only `target_user_id` receives (`publishPersonal()`):
    /// `_access.userIds` merged into `data`, sent as `system`. A `data` that is
    /// not an object is sent as `{ _access }` alone, as spreading it does in
    /// TypeScript.
    pub fn personal(
        workspace_id: &str,
        topic: &str,
        event: &str,
        data: Value,
        target_user_id: &str,
    ) -> Self {
        let mut payload = match data {
            Value::Object(map) => map,
            _ => serde_json::Map::new(),
        };
        payload.insert("_access".to_owned(), json!({ "userIds": [target_user_id] }));
        Self::workspace(workspace_id, topic, event, Value::Object(payload), "system")
    }

    /// A room publish (`supportPublish`, `conversationPublish`, `chatPublish`).
    pub fn room(room: Room, id: &str, payload: Value) -> Self {
        Self {
            channel: format!("{}:{id}", room.prefix()),
            payload,
        }
    }
}

/// Fire-and-forget fan-out to connected clients. A publish nobody listens to
/// is not an error.
pub trait RealtimePublisher: Send + Sync {
    fn publish(
        &self,
        message: &RealtimeMessage,
    ) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// Object-safe [`RealtimePublisher`], for `Arc<dyn DynRealtimePublisher>`.
pub trait DynRealtimePublisher: Send + Sync {
    fn publish_boxed<'a>(
        &'a self,
        message: &'a RealtimeMessage,
    ) -> BoxFuture<'a, Result<(), PortError>>;
}

impl<R: RealtimePublisher> DynRealtimePublisher for R {
    fn publish_boxed<'a>(
        &'a self,
        message: &'a RealtimeMessage,
    ) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(self.publish(message))
    }
}

impl RealtimePublisher for dyn DynRealtimePublisher {
    async fn publish(&self, message: &RealtimeMessage) -> Result<(), PortError> {
        self.publish_boxed(message).await
    }
}

impl<R: RealtimePublisher + ?Sized> RealtimePublisher for Arc<R> {
    fn publish(
        &self,
        message: &RealtimeMessage,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).publish(message)
    }
}

/// [`RealtimePublisher`] double: keeps every publish, in order.
#[derive(Debug, Default)]
pub struct RecordingRealtime {
    messages: Mutex<Vec<RealtimeMessage>>,
}

impl RecordingRealtime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn messages(&self) -> Vec<RealtimeMessage> {
        self.lock().clone()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    fn lock(&self) -> MutexGuard<'_, Vec<RealtimeMessage>> {
        self.messages.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl RealtimePublisher for RecordingRealtime {
    fn publish(
        &self,
        message: &RealtimeMessage,
    ) -> impl Future<Output = Result<(), PortError>> + Send {
        self.lock().push(message.clone());
        std::future::ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_message_is_the_publish_workspace_body() {
        let message = RealtimeMessage::workspace(
            "org_1",
            "knowledge_page",
            "created",
            json!({ "id": "p" }),
            "user_1",
        );
        assert_eq!(message.channel, "workspace:org_1");
        assert_eq!(
            message.payload,
            json!({
                "workspaceId": "org_1",
                "topic": "knowledge_page",
                "event": "created",
                "data": { "id": "p" },
                "userId": "user_1",
            })
        );
    }

    #[test]
    fn personal_message_carries_the_access_list() {
        let message = RealtimeMessage::personal(
            "org_1",
            "notification.u1",
            "created",
            json!({ "n": 1 }),
            "u1",
        );
        assert_eq!(message.payload["userId"], "system");
        assert_eq!(
            message.payload["data"],
            json!({ "n": 1, "_access": { "userIds": ["u1"] } })
        );
        let scalar = RealtimeMessage::personal("org_1", "t", "e", json!(5), "u1");
        assert_eq!(
            scalar.payload["data"],
            json!({ "_access": { "userIds": ["u1"] } })
        );
    }

    #[tokio::test]
    async fn records_room_publishes() {
        let recording = Arc::new(RecordingRealtime::new());
        let realtime: Arc<dyn DynRealtimePublisher> = recording.clone();
        let message = RealtimeMessage::room(Room::Chat, "ch_1", json!({ "type": "pin" }));
        realtime.publish(&message).await.expect("publish");
        assert_eq!(recording.messages(), vec![message]);
        assert_eq!(recording.messages()[0].channel, "chat:ch_1");
    }
}
