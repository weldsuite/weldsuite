//! Two gateways (two "pods") on one Valkey, driven by WebSocket clients:
//! fan-out between them, replay, presence, rooms, the internal routes and
//! the limits.
//!
//! Runs when `WELDSUITE_TEST_VALKEY_URL` points at a throwaway Valkey, e.g.
//! `redis://127.0.0.1:6379`; otherwise each test returns early. Each test
//! uses a prefix of its own, so a shared server is fine.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use weldsuite_adapters_oss::{ValkeyRealtime, connect_valkey};
use weldsuite_auth::{AuthContext, TokenError};
use weldsuite_ports::{BoxFuture, RealtimeMessage, RealtimePublisher, Room};
use weldsuite_realtime::{
    Authenticator, ChatAccess, Directory, DirectoryError, Gateway, GatewayConfig, Member,
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn valkey_url() -> Option<String> {
    let url = std::env::var("WELDSUITE_TEST_VALKEY_URL").ok();
    if url.is_none() {
        eprintln!("WELDSUITE_TEST_VALKEY_URL is not set; skipping");
    }
    url
}

fn prefix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("weldsuite-rt-test:{nanos}:")
}

/// Tokens are `<user>` or `<user>@<org>`; `bad` is refused.
struct Tokens;

impl Authenticator for Tokens {
    fn authenticate<'a>(
        &'a self,
        token: &'a str,
    ) -> BoxFuture<'a, Result<AuthContext, TokenError>> {
        let result = if token == "bad" {
            Err(TokenError::BadSignature)
        } else {
            let (user, org) = match token.split_once('@') {
                Some((user, org)) => (user, Some(org.to_owned())),
                None => (token, None),
            };
            Ok(AuthContext {
                user_id: user.to_owned(),
                org_id: org,
                session_id: String::new(),
                factor_verification_age: None,
            })
        };
        Box::pin(std::future::ready(result))
    }
}

/// Workspace `org_a` (hub `org_a`): `admin_1` (ADMIN), `member_1` and
/// `member_2` (MEMBER). Channel `ch_public` is public, `ch_private` has
/// `member_1` only. Conversation `conv_1` exists.
struct People;

impl Directory for People {
    fn member<'a>(
        &'a self,
        org: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<Option<Member>, DirectoryError>> {
        let result = if org == "org_a" {
            let role = match user {
                "admin_1" => Some("ADMIN"),
                "member_1" | "member_2" => Some("MEMBER"),
                _ => None,
            };
            Ok(role.map(|role| Member {
                org: org.to_owned(),
                hub: "org_a".to_owned(),
                workspace_id: "ws_a".to_owned(),
                role: role.to_owned(),
                name: Some(format!("Name of {user}")),
            }))
        } else {
            Err(DirectoryError::WorkspaceNotFound)
        };
        Box::pin(std::future::ready(result))
    }

    fn chat_access<'a>(
        &'a self,
        _member: &'a Member,
        user: &'a str,
        channel: &'a str,
    ) -> BoxFuture<'a, Result<ChatAccess, DirectoryError>> {
        let access = match (channel, user) {
            ("ch_public", _) | ("ch_private", "member_1") => ChatAccess::Allowed,
            ("ch_private", _) => ChatAccess::NotMember,
            _ => ChatAccess::ChannelNotFound,
        };
        Box::pin(std::future::ready(Ok(access)))
    }

    fn conversation_exists<'a>(
        &'a self,
        _member: &'a Member,
        conversation: &'a str,
    ) -> BoxFuture<'a, Result<bool, DirectoryError>> {
        Box::pin(std::future::ready(Ok(conversation == "conv_1")))
    }

    fn hub_key<'a>(&'a self, reference: &'a str) -> BoxFuture<'a, Result<String, DirectoryError>> {
        let hub = if reference == "ws_a" {
            "org_a"
        } else {
            reference
        };
        Box::pin(std::future::ready(Ok(hub.to_owned())))
    }
}

struct Pod {
    gateway: Arc<Gateway>,
    base: String,
}

async fn pod(url: &str, prefix: &str, config: GatewayConfig) -> Pod {
    let gateway = Gateway::start(config, Arc::new(Tokens), Arc::new(People), url, prefix)
        .await
        .expect("gateway starts");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listen");
    let address = listener.local_addr().expect("address");
    let router = weldsuite_realtime::router(Arc::clone(&gateway));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Pod {
        gateway,
        base: format!("ws://{address}"),
    }
}

fn config() -> GatewayConfig {
    GatewayConfig {
        internal_secret: Some("test-secret".to_owned()),
        linger: Duration::from_millis(200),
        ..GatewayConfig::default()
    }
}

async fn publisher(url: &str, prefix: &str) -> ValkeyRealtime {
    ValkeyRealtime::new(connect_valkey(url).await.expect("connects"), prefix)
}

async fn connect(pod: &Pod, path: &str, token: &str) -> Socket {
    let separator = if path.contains('?') { '&' } else { '?' };
    let url = format!("{}{path}{separator}token={token}", pod.base);
    let (socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("upgrade");
    socket
}

/// The HTTP status a refused upgrade answered with.
async fn refused(pod: &Pod, path: &str) -> u16 {
    match tokio_tungstenite::connect_async(format!("{}{path}", pod.base)).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status().as_u16(),
        other => panic!("expected a refusal for {path}, got {:?}", other.map(|_| ())),
    }
}

async fn next(socket: &mut Socket) -> Value {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .expect("a message within 10 s")
            .expect("open")
            .expect("readable");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("json");
        }
    }
}

/// The next message of `kind`, skipping others.
async fn next_of(socket: &mut Socket, kind: &str) -> Value {
    loop {
        let message = next(socket).await;
        if message["type"] == kind {
            return message;
        }
    }
}

/// Nothing arrives for a moment.
async fn quiet(socket: &mut Socket) {
    match tokio::time::timeout(Duration::from_millis(400), socket.next()).await {
        Err(_) => {}
        Ok(message) => panic!("expected nothing, got {message:?}"),
    }
}

async fn send(socket: &mut Socket, message: &Value) {
    socket
        .send(Message::text(message.to_string()))
        .await
        .expect("send");
}

async fn subscribe(socket: &mut Socket, topics: &[&str], since: Option<&str>) -> Value {
    let mut message = json!({ "type": "subscribe", "topics": topics });
    if let Some(since) = since {
        message["since"] = json!(since);
    }
    send(socket, &message).await;
    next_of(socket, "subscribed").await
}

fn event(topic: &str, data: Value) -> RealtimeMessage {
    RealtimeMessage::workspace("org_a", topic, "updated", data, "admin_1")
}

#[tokio::test]
async fn handshake_auth_and_refusals() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(&url, &prefix, config()).await;

    let mut socket = connect(&one, "/ws", "member_1@org_a").await;
    let connected = next(&mut socket).await;
    assert_eq!(connected["type"], "connected");
    assert!(
        connected["connectionId"]
            .as_str()
            .is_some_and(|id| id.len() == 36)
    );

    send(&mut socket, &json!({ "type": "ping" })).await;
    assert_eq!(next(&mut socket).await, json!({ "type": "pong" }));
    socket.send(Message::text("{nope")).await.expect("send");
    assert_eq!(next(&mut socket).await["code"], "invalid_json");
    send(&mut socket, &json!({ "type": "dance" })).await;
    assert_eq!(
        next(&mut socket).await,
        json!({ "type": "error", "code": "unknown_type", "message": "Unknown message type: dance" })
    );

    assert_eq!(refused(&one, "/ws?token=bad").await, 401);
    assert_eq!(refused(&one, "/ws").await, 401);
    assert_eq!(
        refused(&one, "/ws?token=member_1").await,
        401,
        "no organization"
    );
    assert_eq!(
        refused(&one, "/ws?token=stranger@org_a").await,
        403,
        "not a member"
    );
    assert_eq!(
        refused(&one, "/ws?token=member_1@org_x").await,
        403,
        "no workspace"
    );
    let plain = reqwest_get(&one, "/ws").await;
    assert_eq!(plain, 426, "a plain GET is not an upgrade");
}

/// A GET without the upgrade headers.
async fn reqwest_get(pod: &Pod, path: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = pod.base.trim_start_matches("ws://");
    let mut stream = TcpStream::connect(address).await.expect("tcp");
    let request = format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).await.expect("read");
    response
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("status")
}

#[tokio::test]
async fn events_reach_subscribers_on_both_pods() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );
    let publisher = publisher(&url, &prefix).await;

    let mut a = connect(&one, "/ws", "member_1@org_a").await;
    let mut b = connect(&two, "/ws", "member_2@org_a").await;
    next_of(&mut a, "connected").await;
    next_of(&mut b, "connected").await;
    assert_eq!(
        subscribe(&mut a, &["task"], None).await["topics"],
        json!(["task"])
    );
    subscribe(&mut b, &["task.t1"], None).await;

    publisher
        .publish(&event("task.t1", json!({ "id": "t1", "z": 1, "a": 2 })))
        .await
        .expect("publish");
    let (got_a, got_b) = (
        next_of(&mut a, "event").await,
        next_of(&mut b, "event").await,
    );
    for got in [&got_a, &got_b] {
        assert_eq!(got["topic"], "task.t1");
        assert_eq!(got["event"], "updated");
        assert_eq!(got["data"], json!({ "id": "t1", "z": 1, "a": 2 }));
        assert_eq!(got["userId"], "admin_1");
        assert!(got["ts"].as_u64().is_some());
        assert_eq!(got["eventId"].as_str().map(str::len), Some(16));
    }
    assert_eq!(got_a["eventId"], got_b["eventId"], "one id for every pod");

    // A sibling topic does not match a child subscription.
    publisher
        .publish(&event("task.t2", json!({ "id": "t2" })))
        .await
        .expect("publish");
    assert_eq!(next_of(&mut a, "event").await["topic"], "task.t2");
    quiet(&mut b).await;

    // `_access` leaves the data and narrows the recipients.
    let personal =
        RealtimeMessage::personal("org_a", "task.t1", "created", json!({ "n": 1 }), "member_2");
    publisher.publish(&personal).await.expect("publish");
    let got = next_of(&mut b, "event").await;
    assert_eq!(got["data"], json!({ "n": 1 }));
    assert_eq!(got["userId"], "system");
    quiet(&mut a).await;

    // Unsubscribe echoes the topics and stops delivery.
    send(
        &mut a,
        &json!({ "type": "unsubscribe", "topics": ["task"] }),
    )
    .await;
    assert_eq!(
        next(&mut a).await,
        json!({ "type": "unsubscribed", "topics": ["task"] })
    );
    publisher
        .publish(&event("task.t1", json!({})))
        .await
        .expect("publish");
    next_of(&mut b, "event").await;
    quiet(&mut a).await;
}

#[tokio::test]
async fn topic_rules_follow_the_role() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(&url, &prefix, config()).await;

    let mut member = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut member, "connected").await;
    send(
        &mut member,
        &json!({ "type": "subscribe", "topics": ["notification.member_2", "made_up", "notification.member_1", 5] }),
    )
    .await;
    assert_eq!(
        next(&mut member).await["message"],
        "Cannot subscribe to another user's personal topic: notification.member_2"
    );
    assert_eq!(
        next(&mut member).await["message"],
        "Cannot subscribe to topic: made_up"
    );
    assert_eq!(
        next(&mut member).await,
        json!({ "type": "subscribed", "topics": ["notification.member_1"] })
    );

    let mut admin = connect(&one, "/ws", "admin_1@org_a").await;
    next_of(&mut admin, "connected").await;
    assert_eq!(
        subscribe(&mut admin, &["made_up", "notification.admin_1"], None).await["topics"],
        json!(["made_up", "notification.admin_1"])
    );
    send(
        &mut admin,
        &json!({ "type": "subscribe", "topics": ["mail.member_1"] }),
    )
    .await;
    assert_eq!(
        next(&mut admin).await["code"],
        "forbidden",
        "personal topics stay personal for admins"
    );

    let mut personal = connect(&one, "/ws/personal", "consumer_1").await;
    next_of(&mut personal, "connected").await;
    assert_eq!(
        subscribe(&mut personal, &["mail.consumer_1"], None).await["topics"],
        json!(["mail.consumer_1"])
    );
    send(
        &mut personal,
        &json!({ "type": "subscribe", "topics": ["task"] }),
    )
    .await;
    assert_eq!(next(&mut personal).await["code"], "forbidden");
}

#[tokio::test]
async fn reconnecting_replays_from_the_cursor_on_another_pod() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );
    let publisher = publisher(&url, &prefix).await;

    let mut first = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut first, "connected").await;
    subscribe(&mut first, &["task"], None).await;
    publisher
        .publish(&event("task.a", json!({ "n": 1 })))
        .await
        .expect("publish");
    let cursor = next_of(&mut first, "event").await["eventId"]
        .as_str()
        .expect("id")
        .to_owned();
    drop(first);

    for n in 2..=4 {
        let topic = if n == 3 { "project.p" } else { "task.b" };
        publisher
            .publish(&event(topic, json!({ "n": n })))
            .await
            .expect("publish");
    }
    let mut again = connect(&two, "/ws", "member_1@org_a").await;
    next_of(&mut again, "connected").await;
    send(
        &mut again,
        &json!({ "type": "subscribe", "topics": ["task"], "since": cursor }),
    )
    .await;
    let replayed: Vec<Value> = vec![next(&mut again).await, next(&mut again).await];
    assert_eq!(replayed[0]["data"], json!({ "n": 2 }));
    assert_eq!(
        replayed[1]["data"],
        json!({ "n": 4 }),
        "only the subscribed topics"
    );
    assert_eq!(
        next(&mut again).await["type"],
        "subscribed",
        "after the replay"
    );

    // A cursor older than the log asks for a resync.
    let mut stale = connect(&two, "/ws", "member_1@org_a").await;
    next_of(&mut stale, "connected").await;
    send(
        &mut stale,
        &json!({ "type": "subscribe", "topics": ["task"], "since": "0000000000000001" }),
    )
    .await;
    assert_eq!(
        next(&mut stale).await,
        json!({ "type": "resync_required", "topics": ["task"] })
    );
    assert_eq!(next(&mut stale).await["type"], "subscribed");
}

#[tokio::test]
async fn presence_spans_pods_with_a_grace_period() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );

    let mut watcher = connect(&two, "/ws", "member_2@org_a").await;
    next_of(&mut watcher, "connected").await;
    send(
        &mut watcher,
        &json!({ "type": "subscribe", "topics": ["presence"] }),
    )
    .await;
    let snapshot = next_of(&mut watcher, "event").await;
    assert_eq!(snapshot["event"], "snapshot");
    assert_eq!(snapshot["userId"], "system");
    assert_eq!(snapshot["data"]["users"]["member_2"], "online");
    next_of(&mut watcher, "subscribed").await;

    let mut member = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut member, "connected").await;
    let joined = next_of(&mut watcher, "event").await;
    assert_eq!(joined["event"], "connection_changed");
    assert_eq!(
        joined["data"],
        json!({ "userId": "member_1", "live": "online" })
    );
    assert_eq!(joined["userId"], "member_1");

    send(
        &mut member,
        &json!({ "type": "presence", "idle": true, "inCall": false }),
    )
    .await;
    assert_eq!(next_of(&mut watcher, "event").await["data"]["live"], "away");
    send(
        &mut member,
        &json!({ "type": "presence", "idle": true, "inCall": true }),
    )
    .await;
    assert_eq!(next_of(&mut watcher, "event").await["data"]["live"], "busy");

    // The port reads the same state.
    let publisher = publisher(&url, &prefix).await;
    let live = publisher
        .presence("org_a", &["member_1".to_owned()])
        .await
        .expect("presence");
    assert_eq!(live.get("member_1").map(String::as_str), Some("busy"));

    // A reload onto the other pod inside the grace period: no offline.
    member.close(None).await.expect("close");
    drop(member);
    let mut back = connect(&two, "/ws", "member_1@org_a").await;
    next_of(&mut back, "connected").await;
    assert_eq!(
        next_of(&mut watcher, "event").await["data"]["live"],
        "online"
    );

    // Gone for good: offline once the grace period is over.
    back.close(None).await.expect("close");
    drop(back);
    let left = tokio::time::timeout(Duration::from_secs(12), next_of(&mut watcher, "event"))
        .await
        .expect("offline within the grace period");
    assert_eq!(left["data"], json!({ "userId": "member_1", "live": null }));

    let snapshot = publisher.presence("org_a", &[]).await.expect("presence");
    assert_eq!(snapshot.keys().collect::<Vec<_>>(), ["member_2"]);
}

#[tokio::test]
async fn a_dead_pod_s_members_go_offline() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );
    let mut watcher = connect(&two, "/ws", "member_2@org_a").await;
    next_of(&mut watcher, "connected").await;
    subscribe(&mut watcher, &["presence"], None).await;
    let mut member = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut member, "connected").await;
    assert_eq!(
        next_of(&mut watcher, "event").await["data"]["live"],
        "online"
    );

    // Pod one disappears without closing its sockets.
    one.gateway
        .backplane()
        .check_out()
        .await
        .expect("check out");
    one.gateway.backplane().stop();
    two.gateway.sweep().await;
    tokio::time::sleep(Duration::from_millis(5_300)).await;
    two.gateway.sweep().await;
    let left = next_of(&mut watcher, "event").await;
    assert_eq!(left["data"], json!({ "userId": "member_1", "live": null }));
    drop(member);
}

#[tokio::test]
async fn chat_rooms_relay_between_pods() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );
    let publisher = publisher(&url, &prefix).await;

    assert_eq!(
        refused(&one, "/ws/chat/ch_private?token=member_2@org_a").await,
        403
    );
    assert_eq!(
        refused(&one, "/ws/chat/ch_gone?token=member_1@org_a").await,
        403
    );
    assert_eq!(refused(&one, "/ws/chat/ch_public?token=bad").await, 401);

    let mut a = connect(&one, "/ws/chat/ch_private", "member_1@org_a").await;
    let connected = next(&mut a).await;
    assert_eq!(connected["type"], "connected");
    assert_eq!(connected["presence"], json!([]));
    assert_eq!(connected["lastSeq"], 0);

    send(
        &mut a,
        &json!({ "type": "presence:enter", "data": { "status": "here" } }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut b = connect(&two, "/ws/chat/ch_private", "member_1@org_a").await;
    let connected = next(&mut b).await;
    assert_eq!(
        connected["presence"],
        json!([{ "userId": "member_1", "userName": "Name of member_1", "data": { "status": "here" } }])
    );

    send(&mut a, &json!({ "type": "typing:start" })).await;
    assert_eq!(
        next(&mut b).await,
        json!({ "type": "typing", "userId": "member_1", "userName": "Name of member_1", "isTyping": true })
    );
    send(&mut a, &json!({ "type": "message", "content": "hi" })).await;
    assert_eq!(next(&mut a).await["code"], "server_publish_only");

    publisher
        .publish(&RealtimeMessage::room(
            Room::Chat,
            "ch_private",
            json!({ "type": "message", "id": "m1", "content": "hi", "seq": 99 }),
        ))
        .await
        .expect("publish");
    let (got_a, got_b) = (
        next_of(&mut a, "message").await,
        next_of(&mut b, "message").await,
    );
    assert_eq!(got_a, got_b);
    let seq = got_a["seq"].as_u64().expect("seq");
    assert!(
        seq > 1_000_000_000_000_000,
        "numbered by the room, from the clock: {seq}"
    );
    publisher
        .publish(&RealtimeMessage::room(
            Room::Chat,
            "ch_private",
            json!({ "type": "pin", "messageId": "m1" }),
        ))
        .await
        .expect("publish");
    assert!(
        next_of(&mut b, "pin").await.get("seq").is_none(),
        "only messages are numbered"
    );

    let mut c = connect(&one, "/ws/chat/ch_private", "member_1@org_a").await;
    assert_eq!(next(&mut c).await["lastSeq"].as_u64(), Some(seq));

    // Typing stops by itself after 5 s, for everyone.
    let stopped = tokio::time::timeout(Duration::from_secs(8), next_of(&mut b, "typing"))
        .await
        .expect("typing stops");
    assert_eq!(stopped["isTyping"], false);

    a.close(None).await.expect("close");
    assert_eq!(
        next_of(&mut b, "presence:leave").await,
        json!({ "type": "presence:leave", "userId": "member_1" })
    );

    // Meeting rooms take guests.
    let guest = format!(
        "{}/ws/chat/meet_m1?guestUserId=g1&guestName=Guest",
        two.base
    );
    let (mut guest, _) = tokio_tungstenite::connect_async(guest)
        .await
        .expect("guest joins");
    assert_eq!(next(&mut guest).await["type"], "connected");
    assert_eq!(
        refused(&two, "/ws/chat/meet_m1").await,
        401,
        "a guest needs a name"
    );
}

#[tokio::test]
async fn support_and_conversation_rooms() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let (one, two) = (
        pod(&url, &prefix, config()).await,
        pod(&url, &prefix, config()).await,
    );

    assert_eq!(
        refused(&one, "/ws/support/org_other?token=member_1@org_a").await,
        403
    );
    let mut a = connect(&one, "/ws/support/ws_a", "member_1@org_a").await;
    next_of(&mut a, "connected").await;
    let mut b = connect(&two, "/ws/support/org_a?userName=Bea", "member_2@org_a").await;
    next_of(&mut b, "connected").await;
    send(&mut b, &json!({ "type": "message", "content": "help" })).await;
    for socket in [&mut a, &mut b] {
        let got = next_of(socket, "message").await;
        assert_eq!(got["content"], "help");
        assert_eq!(got["senderName"], "Bea");
        assert_eq!(got["senderType"], "customer");
    }
    let publisher = publisher(&url, &prefix).await;
    publisher
        .publish(&RealtimeMessage::room(
            Room::Support,
            "org_a",
            json!({ "type": "reply", "data": {}, "ts": 1 }),
        ))
        .await
        .expect("publish");
    assert_eq!(next_of(&mut a, "reply").await["ts"], 1);

    assert_eq!(
        refused(&one, "/ws/conversation/conv_9?token=member_1@org_a").await,
        403
    );
    assert_eq!(
        refused(&one, "/ws/conversation/conv_1?token=bad").await,
        401
    );
    let mut agent = connect(&one, "/ws/conversation/conv_1", "member_1@org_a").await;
    next_of(&mut agent, "connected").await;
    let mut other = connect(&two, "/ws/conversation/conv_1", "admin_1@org_a").await;
    next_of(&mut other, "connected").await;
    send(
        &mut agent,
        &json!({ "type": "message", "content": "on it" }),
    )
    .await;
    let got = next_of(&mut other, "message").await;
    assert_eq!(got["senderType"], "agent");
    quiet(&mut agent).await;
}

#[tokio::test]
async fn internal_routes_need_the_secret() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(&url, &prefix, config()).await;
    let mut socket = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut socket, "connected").await;
    subscribe(&mut socket, &["task"], None).await;

    let http = one.base.replace("ws://", "http://");
    let body = json!({ "workspaceId": "ws_a", "topic": "task.x", "event": "created", "data": { "id": "x" }, "userId": "u" });
    let status = post(&format!("{http}/publish/workspace"), None, &body).await;
    assert_eq!(status, 403);
    let status = post(&format!("{http}/publish/workspace"), Some("wrong"), &body).await;
    assert_eq!(status, 403);
    let status = post(
        &format!("{http}/publish/workspace"),
        Some("test-secret"),
        &body,
    )
    .await;
    assert_eq!(status, 200);
    let got = next_of(&mut socket, "event").await;
    assert_eq!(got["topic"], "task.x", "ws_a is mapped onto its hub");
}

async fn post(url: &str, secret: Option<&str>, body: &Value) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url.trim_start_matches("http://");
    let (address, path) = rest.split_at(rest.find('/').expect("path"));
    let body = body.to_string();
    let secret = secret
        .map(|s| format!("x-internal-secret: {s}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\n{secret}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(address).await.expect("tcp");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).await.expect("read");
    response
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("status")
}

#[tokio::test]
async fn limits() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(
        &url,
        &prefix,
        GatewayConfig {
            max_connections_per_user: 2,
            max_subscriptions: 2,
            stale_after: Duration::from_millis(600),
            stale_check: Duration::from_millis(100),
            ..config()
        },
    )
    .await;

    let mut first = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut first, "connected").await;
    let mut second = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut second, "connected").await;
    assert_eq!(
        refused(&one, "/ws?token=member_1@org_a").await,
        503,
        "two per person"
    );

    send(
        &mut first,
        &json!({ "type": "subscribe", "topics": ["task", "project", "lead"] }),
    )
    .await;
    assert_eq!(next(&mut first).await["code"], "too_many_subscriptions");
    assert_eq!(next(&mut first).await["topics"], json!(["task", "project"]));

    // Silent sockets are closed with 4000; one that pings stays.
    let mut closed = None;
    for _ in 0..12 {
        send(&mut first, &json!({ "type": "ping" })).await;
        match tokio::time::timeout(Duration::from_millis(150), second.next()).await {
            Ok(Some(Ok(Message::Close(frame)))) => {
                closed = frame;
                break;
            }
            Ok(None | Some(Err(_))) => break,
            _ => {}
        }
    }
    let frame = closed.expect("a close frame");
    assert_eq!(frame.code, CloseCode::Library(4000));
    assert_eq!(frame.reason.as_str(), "heartbeat timeout");
    assert_eq!(
        next_of(&mut first, "pong").await["type"],
        "pong",
        "the pinging socket is open"
    );
    drop(second);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut third = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut third, "connected").await;
}

#[tokio::test]
async fn slow_clients_are_dropped() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(
        &url,
        &prefix,
        GatewayConfig {
            send_queue: 4,
            write_timeout: Duration::from_millis(300),
            ..config()
        },
    )
    .await;
    let publisher = publisher(&url, &prefix).await;
    let mut slow = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut slow, "connected").await;
    subscribe(&mut slow, &["task"], None).await;
    let big = "x".repeat(256 * 1024);
    for n in 0..80 {
        publisher
            .publish(&event("task.big", json!({ "n": n, "pad": big })))
            .await
            .expect("publish");
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        one.gateway.open_connections(),
        0,
        "the slow socket was let go"
    );
    let mut received = 0;
    while let Ok(Some(Ok(message))) =
        tokio::time::timeout(Duration::from_secs(2), slow.next()).await
    {
        if message.is_text() {
            received += 1;
        }
    }
    assert!(received < 80, "dropped before the end ({received})");
}

#[tokio::test]
async fn a_lost_subscription_asks_for_a_resync() {
    let Some(url) = valkey_url() else { return };
    let prefix = prefix();
    let one = pod(&url, &prefix, config()).await;
    let mut socket = connect(&one, "/ws", "member_1@org_a").await;
    next_of(&mut socket, "connected").await;
    subscribe(&mut socket, &["task", "project"], None).await;

    one.gateway.backplane().reconnect();
    let resync = tokio::time::timeout(
        Duration::from_secs(10),
        next_of(&mut socket, "resync_required"),
    )
    .await
    .expect("a resync after the subscription is back");
    assert_eq!(resync["topics"], json!(["project", "task"]));

    let publisher = publisher(&url, &prefix).await;
    publisher
        .publish(&event("task.after", json!({})))
        .await
        .expect("publish");
    assert_eq!(next_of(&mut socket, "event").await["topic"], "task.after");
}
