//! WeldChat's realtime publishes (`@weldsuite/chat-domain/realtime/*`,
//! `RealtimePublisher` of `@weldsuite/realtime/server`): the same channels,
//! event types and payloads, through the realtime port. Without a publisher
//! (no `REALTIME` binding, no Valkey) every call does nothing; a failed
//! publish is logged, never raised, as the routes treat them.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage, RealtimePublisher, Room};

/// The publisher a route sends through, if any.
#[derive(Clone, Default)]
pub struct Realtime(pub Option<Arc<dyn DynRealtimePublisher>>);

impl std::fmt::Debug for Realtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Realtime").field(&self.0.is_some()).finish()
    }
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    let now = time::OffsetDateTime::now_utc();
    i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

impl Realtime {
    pub fn new(publisher: Option<Arc<dyn DynRealtimePublisher>>) -> Self {
        Self(publisher)
    }

    /// Whether a publisher is there (`env.REALTIME`).
    pub fn is_on(&self) -> bool {
        self.0.is_some()
    }

    async fn send(&self, message: RealtimeMessage) {
        if let Some(publisher) = &self.0
            && let Err(error) = publisher.publish(&message).await
        {
            tracing::error!(%error, channel = %message.channel, "[weldchat] realtime publish failed");
        }
    }

    /// `chatPublish(channelId, payload)`: the channel's `ChatRoom`.
    pub async fn chat(&self, channel_id: &str, payload: Value) {
        self.send(RealtimeMessage::room(Room::Chat, channel_id, payload))
            .await;
    }

    /// `publish(workspaceId, topic, event, data, userId)`: the `WorkspaceHub`.
    pub async fn workspace(
        &self,
        workspace_id: &str,
        topic: &str,
        event: &str,
        data: Value,
        user_id: &str,
    ) {
        self.send(RealtimeMessage::workspace(
            workspace_id,
            topic,
            event,
            data,
            user_id,
        ))
        .await;
    }

    /// `publishPersonal(...)` on `chat.user.<userId>`.
    pub async fn chat_user(&self, workspace_id: &str, user_id: &str, event: &str, data: Value) {
        self.send(RealtimeMessage::personal(
            workspace_id,
            &format!("chat.user.{user_id}"),
            event,
            data,
            user_id,
        ))
        .await;
    }

    /// `notify(workspaceId, userId, notification)`: `notification.<userId>`.
    pub async fn notify(&self, workspace_id: &str, user_id: &str, notification: Value) {
        self.send(RealtimeMessage::personal(
            workspace_id,
            &format!("notification.{user_id}"),
            "created",
            notification,
            user_id,
        ))
        .await;
    }

    /// `publishChatMemberJoined` / `publishChatMemberLeft` (no user name).
    pub async fn member(&self, channel_id: &str, user_id: &str, action: &str) {
        self.chat(
            channel_id,
            json!({ "type": "member", "userId": user_id, "userName": "", "action": action }),
        )
        .await;
    }

    /// `publishChatChannelUpdated(channelId, data)`.
    pub async fn channel_updated(&self, channel_id: &str, data: Value) {
        self.chat(
            channel_id,
            json!({ "type": "channel:updated", "data": data }),
        )
        .await;
    }

    /// `publishChatUnreadUpdate`: `unread_update` on the user's topic.
    pub async fn unread_update(
        &self,
        workspace_id: &str,
        user_id: &str,
        channel_id: &str,
        unread_count: i64,
    ) {
        self.chat_user(
            workspace_id,
            user_id,
            "unread_update",
            json!({ "channelId": channel_id, "unreadCount": unread_count }),
        )
        .await;
    }

    /// `publishChatUserChannelNew`: `channel_new` on the user's topic.
    pub async fn channel_new(
        &self,
        workspace_id: &str,
        user_id: &str,
        channel_id: &str,
        channel_name: &str,
    ) {
        self.chat_user(
            workspace_id,
            user_id,
            "channel_new",
            json!({ "channelId": channel_id, "channelName": channel_name }),
        )
        .await;
    }

    /// `publishChatReadUpdated`: `read:updated` to the channel (`data` holds
    /// channelId, userId, userName, userAvatar?, lastReadMessageId, lastReadAt).
    pub async fn read_updated(&self, channel_id: &str, data: Map<String, Value>) {
        let mut payload = Map::new();
        payload.insert("type".to_owned(), Value::from("read:updated"));
        payload.extend(data);
        self.chat(channel_id, Value::Object(payload)).await;
    }

    /// `publishChatMessagePinned` / `publishChatMessageUnpinned`.
    pub async fn pin(&self, channel_id: &str, message_id: &str, user_id: &str, action: &str) {
        self.chat(
            channel_id,
            json!({ "type": "pin", "messageId": message_id, "userId": user_id, "action": action }),
        )
        .await;
    }

    /// `publishChatMessageUpdated(channelId, data)`: everything under `data`.
    pub async fn message_updated(&self, channel_id: &str, id: &str, data: Value) {
        self.chat(
            channel_id,
            json!({ "type": "message:updated", "id": id, "data": data }),
        )
        .await;
    }

    /// `publishChatMessageDeleted`.
    pub async fn message_deleted(&self, channel_id: &str, message_id: &str) {
        self.chat(
            channel_id,
            json!({ "type": "message:deleted", "id": message_id }),
        )
        .await;
    }

    /// `chatMessage(channelId, message)`: `{ type: 'message', ...message, ts }`.
    /// `message` keys left `None` are left out, as `undefined` is by
    /// `JSON.stringify`.
    pub async fn message(&self, channel_id: &str, message: Map<String, Value>) {
        let mut payload = Map::new();
        payload.insert("type".to_owned(), Value::from("message"));
        payload.extend(message);
        payload.insert("ts".to_owned(), Value::from(now_ms()));
        self.chat(channel_id, Value::Object(payload)).await;
    }

    /// `chatClipTranscriptUpdated`.
    pub async fn clip_transcript_updated(&self, channel_id: &str, data: Map<String, Value>) {
        let mut payload = Map::new();
        payload.insert("type".to_owned(), Value::from("clip:transcript:updated"));
        payload.extend(data);
        self.chat(channel_id, Value::Object(payload)).await;
    }

    /// `chatCall(channelId, callId, initiatorId, action)`.
    pub async fn call(&self, channel_id: &str, call_id: &str, initiator_id: &str, action: &str) {
        self.chat(
            channel_id,
            json!({ "type": "call", "callId": call_id, "initiatorId": initiator_id, "action": action }),
        )
        .await;
    }

    /// `chatCallParticipant(channelId, { ...data, action })`.
    pub async fn call_participant(&self, channel_id: &str, data: Map<String, Value>) {
        let mut payload = Map::new();
        payload.insert("type".to_owned(), Value::from("call:participant"));
        payload.extend(data);
        self.chat(channel_id, Value::Object(payload)).await;
    }
}

/// An object from `(key, value)` pairs, leaving out the `None`s
/// (`JSON.stringify` drops `undefined`).
pub fn object<const N: usize>(fields: [(&str, Option<Value>); N]) -> Map<String, Value> {
    fields
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
        .collect()
}
