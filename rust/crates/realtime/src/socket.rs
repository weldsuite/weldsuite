//! One socket's life: the `webSocketMessage` / `webSocketClose` handlers of
//! the Durable Objects, for a hub and for each kind of room.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::ws::{Message, WebSocket};
use futures_util::StreamExt;
use futures_util::stream::SplitStream;
use serde_json::{Map, Value, json};

use crate::gateway::{Admission, Gateway, Replay};
use crate::hub::{ConnPresence, Hub, HubConn};
use crate::outbox::Outbox;
use crate::protocol;
use crate::room::{Room, RoomConn, RoomKind};
use crate::topics::{Allowed, PRESENCE_TOPIC, is_personal_topic_for_other_user, topic_matches};

/// Who a hub socket is.
pub(crate) struct HubSession {
    pub(crate) hub: String,
    pub(crate) tracks_presence: bool,
    pub(crate) user_id: String,
    pub(crate) allowed: Allowed,
}

/// Who a room socket is: the tags the realtime-worker gave it.
pub(crate) struct RoomSession {
    pub(crate) kind: RoomKind,
    pub(crate) room: String,
    pub(crate) user_id: String,
    pub(crate) user_name: String,
    pub(crate) role: String,
    pub(crate) can_publish: bool,
}

/// What ended the read loop.
enum Ended {
    /// The client closed, or the connection dropped.
    Client,
    /// The writer stopped (a slow client, a failed write, a close we sent).
    Writer,
}

/// Read client messages until the socket ends, handing each text to
/// `handle`; closes sockets that went silent.
async fn read_loop<F, Fut>(
    gateway: &Gateway,
    stream: &mut SplitStream<WebSocket>,
    out: &Outbox,
    writer: &mut tokio::task::JoinHandle<()>,
    mut handle: F,
) -> Ended
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut last_heard = Instant::now();
    let mut check = tokio::time::interval(gateway.config.stale_check);
    check.tick().await;
    loop {
        tokio::select! {
            next = stream.next() => {
                let Some(Ok(message)) = next else { return Ended::Client };
                last_heard = Instant::now();
                let text = match message {
                    Message::Text(text) => text.as_str().to_owned(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                    // Read on: the next read sends the close reply.
                    Message::Close(_) | Message::Ping(_) | Message::Pong(_) => continue,
                };
                handle(text).await;
            }
            _ = check.tick() => {
                if last_heard.elapsed() > gateway.config.stale_after {
                    out.close(protocol::STALE, "heartbeat timeout");
                    return Ended::Writer;
                }
            }
            _ = &mut *writer => return Ended::Writer,
        }
    }
}

/// Let the writer send what is queued and close.
async fn finish(
    out: Outbox,
    writer: tokio::task::JoinHandle<()>,
    ended: &Ended,
    gateway: &Gateway,
) {
    out.close(1000, "");
    drop(out);
    if matches!(ended, Ended::Client) {
        let _ = tokio::time::timeout(gateway.config.write_timeout, writer).await;
    }
}

// ---------------------------------------------------------------------------
// Workspace hubs
// ---------------------------------------------------------------------------

pub(crate) async fn serve_hub(
    gateway: Arc<Gateway>,
    socket: WebSocket,
    session: HubSession,
    admission: Admission,
) {
    let (sink, mut stream) = socket.split();
    let (out, mut writer) = Outbox::start(
        sink,
        gateway.config.send_queue,
        gateway.config.write_timeout,
    );
    let conn = Arc::new(HubConn::new(
        gateway.next_local(),
        session.user_id.clone(),
        session.allowed,
        out.clone(),
    ));
    let hub = gateway.hub(&session.hub, session.tracks_presence, |hub| {
        hub.join(Arc::clone(&conn));
    });
    if let Err(error) = gateway.ready_hub(&hub).await {
        tracing::error!(%error, hub = %hub.key, "realtime: cannot subscribe the hub");
        out.close(protocol::INTERNAL, "Internal error");
    } else {
        out.text(protocol::connected(&conn.id));
        gateway.refresh_presence(&hub, &conn.user_id).await;
    }

    let ended = read_loop(&gateway, &mut stream, &out, &mut writer, |text| {
        let (gateway, hub, conn) = (Arc::clone(&gateway), Arc::clone(&hub), Arc::clone(&conn));
        async move { hub_message(&gateway, &hub, &conn, &text).await }
    })
    .await;

    if hub.leave(conn.local) {
        gateway.retire_hub_later(&hub);
    }
    gateway.refresh_presence(&hub, &conn.user_id).await;
    drop(conn);
    finish(out, writer, &ended, &gateway).await;
    drop(admission);
}

/// `webSocketMessage` of the `WorkspaceHub`.
async fn hub_message(gateway: &Arc<Gateway>, hub: &Arc<Hub>, conn: &HubConn, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        conn.out
            .text(protocol::error("invalid_json", "Invalid JSON"));
        return;
    };
    let kind = message.get("type");
    match kind.and_then(Value::as_str) {
        Some("subscribe") => subscribe(gateway, hub, conn, &message).await,
        Some("unsubscribe") => {
            let Some(topics) = message.get("topics").filter(|t| t.is_array()) else {
                return;
            };
            let names: Vec<&str> = topics
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            hub.unsubscribe(conn.local, &names);
            conn.out.text(protocol::unsubscribed(topics));
        }
        Some("presence") => {
            conn.set_presence(ConnPresence {
                idle: message.get("idle") == Some(&Value::Bool(true)),
                in_call: message.get("inCall") == Some(&Value::Bool(true)),
            });
            gateway.refresh_presence(hub, &conn.user_id).await;
        }
        Some("ping") => {
            conn.out.text(protocol::PONG);
        }
        _ => {
            let message = format!("Unknown message type: {}", protocol::js_string(kind));
            conn.out.text(protocol::error("unknown_type", &message));
        }
    }
}

/// `handleSubscribe`: accept what the connection may watch, replay from the
/// cursor, send the presence snapshot, then `subscribed`.
async fn subscribe(gateway: &Arc<Gateway>, hub: &Arc<Hub>, conn: &HubConn, message: &Value) {
    let Some(topics) = message.get("topics").and_then(Value::as_array) else {
        return;
    };
    let mut accepted = Vec::new();
    let mut room = gateway
        .config
        .max_subscriptions
        .saturating_sub(hub.subscription_count(conn.local));
    for topic in topics.iter().filter_map(Value::as_str) {
        if is_personal_topic_for_other_user(&conn.user_id, topic) {
            let text = format!("Cannot subscribe to another user's personal topic: {topic}");
            conn.out.text(protocol::error("forbidden", &text));
        } else if !conn.allowed.permits(topic) {
            let text = format!("Cannot subscribe to topic: {topic}");
            conn.out.text(protocol::error("forbidden", &text));
        } else if room == 0 && !accepted.iter().any(|t| t == topic) {
            let text = format!(
                "Cannot subscribe to topic: {topic} (at most {} topics per connection)",
                gateway.config.max_subscriptions
            );
            conn.out
                .text(protocol::error("too_many_subscriptions", &text));
        } else {
            if !accepted.iter().any(|t| t == topic) {
                room = room.saturating_sub(1);
            }
            accepted.push(topic.to_owned());
        }
    }

    let since = message
        .get("since")
        .and_then(Value::as_str)
        .filter(|since| !since.is_empty() && !accepted.is_empty());
    if since.is_some() {
        conn.hold();
    }
    hub.subscribe(conn.local, &accepted);

    let mut replayed = HashSet::new();
    if let Some(since) = since {
        match gateway.replay(hub, since, &accepted, &conn.user_id).await {
            Replay::Resync => {
                conn.out.text(protocol::resync_required(&accepted));
            }
            Replay::Events(events) => {
                for event in events {
                    replayed.insert(event.seq);
                    conn.out.text(protocol::event(&event));
                }
            }
        }
    }

    if hub.tracks_presence
        && accepted
            .iter()
            .any(|topic| topic_matches(topic, PRESENCE_TOPIC))
    {
        match gateway.backplane.presence_snapshot(&hub.key).await {
            Ok(users) => {
                let snapshot = protocol::presence_event(
                    "snapshot",
                    &json!({ "users": users }),
                    "system",
                    protocol::now_ms(),
                );
                conn.out.text(snapshot);
            }
            Err(error) => {
                tracing::warn!(%error, hub = %hub.key, "realtime: presence snapshot failed")
            }
        }
    }

    if !accepted.is_empty() {
        conn.out.text(protocol::subscribed(&accepted));
    }
    if since.is_some() {
        conn.release(&replayed);
    }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

pub(crate) async fn serve_room(
    gateway: Arc<Gateway>,
    socket: WebSocket,
    session: RoomSession,
    admission: Admission,
) {
    let (sink, mut stream) = socket.split();
    let (out, mut writer) = Outbox::start(
        sink,
        gateway.config.send_queue,
        gateway.config.write_timeout,
    );
    let conn = Arc::new(RoomConn {
        local: gateway.next_local(),
        id: uuid::Uuid::new_v4().to_string(),
        user_id: session.user_id,
        user_name: session.user_name,
        role: session.role,
        can_publish: session.can_publish,
        out: out.clone(),
    });
    let room = gateway.room(session.kind, &session.room, |room| {
        room.join(Arc::clone(&conn));
    });
    match connected_message(&gateway, &room, &conn).await {
        Ok(text) => {
            out.text(text);
        }
        Err(error) => {
            tracing::error!(%error, room = %room.channel, "realtime: cannot open the room");
            out.close(protocol::INTERNAL, "Internal error");
        }
    }

    let ended = read_loop(&gateway, &mut stream, &out, &mut writer, |text| {
        let (gateway, room, conn) = (Arc::clone(&gateway), Arc::clone(&room), Arc::clone(&conn));
        async move { room_message(&gateway, &room, &conn, &text).await }
    })
    .await;

    if room.leave(conn.local) {
        gateway.retire_room_later(&room);
    }
    room.clear_typing_timer(&conn.user_id);
    match gateway
        .backplane
        .room_leave(&room.channel, &conn.user_id)
        .await
    {
        Ok(true) => {
            let leave = json!({ "type": "presence:leave", "userId": conn.user_id }).to_string();
            peer(&gateway, &room, None, &leave).await;
        }
        Ok(false) => {}
        Err(error) => tracing::warn!(%error, room = %room.channel, "realtime: room leave failed"),
    }
    drop(conn);
    finish(out, writer, &ended, &gateway).await;
    drop(admission);
}

/// `{ type: 'connected', connectionId, presence[, lastSeq] }`, once the
/// room's channel is subscribed.
async fn connected_message(
    gateway: &Gateway,
    room: &Room,
    conn: &RoomConn,
) -> Result<String, weldsuite_ports::PortError> {
    gateway.ready_room(room).await?;
    let members = gateway.backplane.room_members(&room.channel).await?;
    let mut text = format!(
        r#"{{"type":"connected","connectionId":{},"presence":[{}]"#,
        Value::from(conn.id.as_str()),
        members.join(",")
    );
    if room.kind == RoomKind::Chat {
        let seq = gateway.backplane.last_seq(&room.channel).await?;
        let _ = write!(text, r#","lastSeq":{seq}"#);
    }
    text.push('}');
    Ok(text)
}

/// Say `json` in the room: to everyone but `from` (`None`: everyone).
async fn peer(gateway: &Gateway, room: &Room, from: Option<&str>, json: &str) {
    if let Err(error) = gateway.backplane.peer(&room.channel, from, json).await {
        tracing::warn!(%error, room = %room.channel, "realtime: room relay failed");
    }
}

fn typing(conn: &RoomConn, kind: RoomKind, is_typing: bool) -> String {
    let mut message = Map::new();
    message.insert("type".to_owned(), "typing".into());
    message.insert("userId".to_owned(), conn.user_id.as_str().into());
    message.insert("userName".to_owned(), conn.user_name.as_str().into());
    if kind == RoomKind::Support {
        message.insert("role".to_owned(), conn.role.as_str().into());
    }
    message.insert("isTyping".to_owned(), is_typing.into());
    Value::Object(message).to_string()
}

/// `webSocketMessage` of the room Durable Objects.
async fn room_message(gateway: &Arc<Gateway>, room: &Arc<Room>, conn: &RoomConn, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        conn.out
            .text(protocol::error("invalid_json", "Invalid JSON"));
        return;
    };
    let kind = room.kind;
    let me = Some(conn.id.as_str());
    // Chat gates typing and hand raising on `can:publish`.
    let gated = kind == RoomKind::Chat && !conn.can_publish;
    match message.get("type").and_then(Value::as_str) {
        Some("message") => room_chat_message(gateway, room, conn, &message).await,
        Some("reaction:add" | "reaction:remove") if kind == RoomKind::Chat => {
            conn.out.text(protocol::error(
                "server_publish_only",
                "Messages and reactions must be sent via the API",
            ));
        }
        Some("typing:start") if !gated => {
            peer(gateway, room, me, &typing(conn, kind, true)).await;
            start_typing_timer(gateway, room, conn);
        }
        Some("typing:stop") if !gated => {
            room.clear_typing_timer(&conn.user_id);
            peer(gateway, room, me, &typing(conn, kind, false)).await;
        }
        Some("presence:enter") => {
            let data = message.get("data").filter(|data| !data.is_null());
            let data = if kind == RoomKind::Support {
                let mut merged = Map::new();
                merged.insert("role".to_owned(), conn.role.as_str().into());
                if let Some(Value::Object(fields)) = data {
                    merged.extend(fields.clone());
                }
                Value::Object(merged)
            } else {
                data.cloned().unwrap_or_else(|| json!({}))
            };
            let member =
                json!({ "userId": conn.user_id, "userName": conn.user_name, "data": data });
            if let Err(error) = gateway
                .backplane
                .room_enter(&room.channel, &conn.user_id, &member.to_string())
                .await
            {
                tracing::warn!(%error, room = %room.channel, "realtime: room enter failed");
            }
            let join = json!({ "type": "presence:join", "member": member }).to_string();
            peer(gateway, room, me, &join).await;
        }
        Some("presence:leave") => {
            if let Err(error) = gateway
                .backplane
                .room_leave(&room.channel, &conn.user_id)
                .await
            {
                tracing::warn!(%error, room = %room.channel, "realtime: room leave failed");
            }
            let leave = json!({ "type": "presence:leave", "userId": conn.user_id }).to_string();
            peer(gateway, room, me, &leave).await;
        }
        Some(hand @ ("call:hand-raised" | "call:hand-lowered"))
            if kind == RoomKind::Chat && conn.can_publish =>
        {
            let raised = json!({ "type": hand, "userId": conn.user_id }).to_string();
            peer(gateway, room, me, &raised).await;
        }
        Some("ping") => {
            conn.out.text(protocol::PONG);
        }
        _ => {}
    }
}

/// A client's `message`: refused in chat (messages go through the API), sent
/// to everyone in a support room, to everyone else in a conversation (but
/// not from a widget visitor).
async fn room_chat_message(
    gateway: &Arc<Gateway>,
    room: &Arc<Room>,
    conn: &RoomConn,
    message: &Value,
) {
    let mut out = Map::new();
    out.insert("type".to_owned(), "message".into());
    out.insert("id".to_owned(), uuid::Uuid::new_v4().to_string().into());
    if let Some(content) = message.get("content") {
        out.insert("content".to_owned(), content.clone());
    }
    out.insert("senderId".to_owned(), conn.user_id.as_str().into());
    out.insert("senderName".to_owned(), conn.user_name.as_str().into());
    out.insert("senderType".to_owned(), conn.role.as_str().into());
    match room.kind {
        RoomKind::Chat => {
            conn.out.text(protocol::error(
                "server_publish_only",
                "Messages and reactions must be sent via the API",
            ));
        }
        RoomKind::Support => {
            if let Some(avatar) = message.get("senderAvatar").filter(|v| !v.is_null()) {
                out.insert("senderAvatar".to_owned(), avatar.clone());
            }
            out.insert("ts".to_owned(), protocol::now_ms().into());
            peer(gateway, room, None, &Value::Object(out).to_string()).await;
        }
        RoomKind::Conversation => {
            if conn.role == "customer" {
                conn.out.text(protocol::error(
                    "forbidden",
                    "Send messages through the widget API",
                ));
                return;
            }
            out.insert("ts".to_owned(), protocol::now_ms().into());
            if let Some(attachments) = message.get("attachments").filter(|v| !v.is_null()) {
                out.insert("attachments".to_owned(), attachments.clone());
            }
            peer(
                gateway,
                room,
                Some(conn.id.as_str()),
                &Value::Object(out).to_string(),
            )
            .await;
        }
    }
}

/// Typing stops by itself after 5 s (to everyone, the typist included).
fn start_typing_timer(gateway: &Arc<Gateway>, room: &Arc<Room>, conn: &RoomConn) {
    let stop = typing(conn, room.kind, false);
    let user_id = conn.user_id.clone();
    let (gateway, room_for_timer) = (Arc::clone(gateway), Arc::clone(room));
    let timer = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        room_for_timer.typing_timer_done(&user_id);
        peer(&gateway, &room_for_timer, None, &stop).await;
    });
    room.set_typing_timer(&conn.user_id, timer.abort_handle());
}
