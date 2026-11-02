//! WeldDocs' and WeldSheets' rooms on Kubernetes (`rust/docs/collab-rooms.md`):
//! the collab-rooms service runs the workers' `DocRoom` and `SheetRoom` in
//! Node; this server reaches them through `COLLAB_ROOMS_URLS`.
//!
//! - The room sockets, `/api/docs/connect` and `/api/sheets/connect`, are
//!   proxied to the pod that holds the ticket's room. They sit outside the
//!   session pipeline, as on Global (`room/connect.ts`): the single-use ticket
//!   is the credential, and the room checks it.
//! - `POST /internal/collab/events`: the rooms' entity events
//!   (`publishEntityEventRaw` in a room: `doc:updated` after a checkpoint, a
//!   connected table's refresh), published on this server's bus. Behind
//!   `COLLAB_ROOMS_SECRET`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use futures_util::{SinkExt, StreamExt};
use http::header::UPGRADE;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpstreamCloseFrame;
use tokio_tungstenite::tungstenite::{self, Message as UpstreamMessage};
use weldsuite_adapters_oss::collab::{HttpCollabRooms, SECRET_HEADER};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_ports::CollabRooms;

use crate::server::AppState;

/// The app's rooms, for the docs and sheets modules.
pub(crate) fn rooms(state: &AppState) -> Option<Arc<dyn CollabRooms>> {
    state
        .collab
        .clone()
        .map(|rooms| rooms as Arc<dyn CollabRooms>)
}

/// The socket paths and the rooms' event hook, outside the session layers.
pub(crate) fn public(_state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/docs/connect", any(connect_doc))
        .route("/api/sheets/connect", any(connect_sheet))
        .route("/internal/collab/events", post(events))
}

async fn connect_doc(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    connect(
        &state,
        "/api/docs/connect",
        &headers,
        query.as_deref(),
        upgrade,
    )
    .await
}

async fn connect_sheet(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    connect(
        &state,
        "/api/sheets/connect",
        &headers,
        query.as_deref(),
        upgrade,
    )
    .await
}

fn text(status: StatusCode, body: &str) -> Response {
    (status, body.to_owned()).into_response()
}

/// `<room id>.<secret>`: the room id in hex, then the secret
/// (`/^([0-9a-f]{64})\.[\w-]{16,}$/`).
fn ticket_room(ticket: &str) -> Option<&str> {
    let (room, secret) = ticket.split_once('.')?;
    let room_ok = room.len() == 64 && room.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let secret_ok = secret.len() >= 16
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    (room_ok && secret_ok).then_some(room)
}

/// `connectToRoom`: checks what the worker checks before the room does,
/// then opens the room's socket on its pod and joins the two.
async fn connect(
    state: &AppState,
    path: &str,
    headers: &HeaderMap,
    query: Option<&str>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    if headers.get(UPGRADE).and_then(|v| v.to_str().ok()) != Some("websocket") {
        return text(StatusCode::UPGRADE_REQUIRED, "Expected a WebSocket upgrade");
    }
    let query = weldsuite_kit::validation::query_values(query);
    let ticket = query
        .get("ticket")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(room) = ticket_room(ticket) else {
        return text(StatusCode::UNAUTHORIZED, "Invalid ticket");
    };
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(rooms) = state.collab.clone() else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Document unavailable");
    };
    match open_upstream(&rooms, room, path, ticket).await {
        Ok(upstream) => upgrade.on_upgrade(move |socket| join(socket, upstream)),
        Err(response) => *response,
    }
}

type Upstream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The room's socket on the pod that holds it, or the pod's refusal as the
/// worker would have answered it (401 for a spent ticket, 503 for a
/// document that will not load).
async fn open_upstream(
    rooms: &HttpCollabRooms,
    room: &str,
    path: &str,
    ticket: &str,
) -> Result<Upstream, Box<Response>> {
    let pod = rooms.owner(room);
    let ws = pod
        .strip_prefix("http")
        .map_or_else(|| pod.to_owned(), |rest| format!("ws{rest}"));
    let unavailable = || text(StatusCode::SERVICE_UNAVAILABLE, "Document unavailable");
    // The ticket was checked to be `[0-9a-f.A-Za-z_-]`: nothing to escape.
    let mut request = format!("{ws}{path}?ticket={ticket}")
        .into_client_request()
        .map_err(|_| Box::new(unavailable()))?;
    if let Some(secret) = rooms.secret()
        && let Ok(value) = HeaderValue::from_str(secret)
    {
        request.headers_mut().insert(SECRET_HEADER, value);
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((upstream, _)) => Ok(upstream),
        Err(tungstenite::Error::Http(refused)) => {
            let status = StatusCode::from_u16(refused.status().as_u16())
                .unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
            let body = refused
                .body()
                .as_deref()
                .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                .unwrap_or_default();
            Err(Box::new((status, body).into_response()))
        }
        Err(error) => {
            tracing::error!(%error, pod, "[collab] opening a room socket failed");
            Err(Box::new(unavailable()))
        }
    }
}

/// Passes every message both ways until either side closes.
async fn join(socket: WebSocket, upstream: Upstream) {
    let (mut to_client, mut from_client) = socket.split();
    let (mut to_room, mut from_room) = upstream.split();
    let up = async {
        while let Some(Ok(message)) = from_client.next().await {
            let Some(message) = to_upstream(message) else {
                continue;
            };
            let closing = matches!(message, UpstreamMessage::Close(_));
            if to_room.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = to_room.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = from_room.next().await {
            let Some(message) = to_client_message(message) else {
                continue;
            };
            let closing = matches!(message, Message::Close(_));
            if to_client.send(message).await.is_err() || closing {
                break;
            }
        }
        let _ = to_client.close().await;
    };
    tokio::join!(up, down);
}

fn to_upstream(message: Message) -> Option<UpstreamMessage> {
    Some(match message {
        Message::Text(text) => UpstreamMessage::text(text.as_str()),
        Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
        Message::Close(frame) => UpstreamMessage::Close(frame.map(|frame| UpstreamCloseFrame {
            code: frame.code.into(),
            reason: frame.reason.as_str().into(),
        })),
        // Each side answers its own pings.
        Message::Ping(_) | Message::Pong(_) => return None,
    })
}

fn to_client_message(message: UpstreamMessage) -> Option<Message> {
    Some(match message {
        UpstreamMessage::Text(text) => Message::text(text.as_str()),
        UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
        UpstreamMessage::Close(frame) => Message::Close(frame.map(|frame| CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.as_str().into(),
        })),
        UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_) | UpstreamMessage::Frame(_) => {
            return None;
        }
    })
}

// ── POST /internal/collab/events ────────────────────────────────────────────

/// Constant-time comparison of the shared secret.
fn secret_matches(expected: &str, given: &str) -> bool {
    expected.len() == given.len()
        && expected
            .bytes()
            .zip(given.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// A room's hub message (`EntityEventMessage`), published as this server
/// publishes its own: the catalog checks the type, the bus stamps the id and
/// time.
async fn events(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let given = headers
        .get(SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    match state.collab_secret.as_deref() {
        Some(expected) if secret_matches(expected, given) => {}
        Some(_) => return StatusCode::UNAUTHORIZED.into_response(),
        None => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let field = |key: &str| message[key].as_str().unwrap_or_default();
    let Ok(event_type) = EventType::catalog(field("entityType"), field("action")) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let mut event = EntityEvent::new(event_type, field("entityId"), message["data"].clone());
    if let Some(changes) = message["changes"].as_object() {
        event = event.with_changes(changes.clone());
    }
    if let Some(ids) = message["accessUserIds"].as_array() {
        event = event.with_access_user_ids(
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        );
    }
    let metadata = &message["metadata"];
    let source = match metadata["source"].as_str() {
        Some("web") => EventSource::Web,
        Some("mobile") => EventSource::Mobile,
        Some("api") => EventSource::Api,
        _ => EventSource::System,
    };
    let context = EventContext::new(
        metadata["workspaceId"].as_str().unwrap_or_default(),
        metadata["userId"].as_str().unwrap_or("system"),
        source,
    );
    state.infra.events.publish_and_wait(&context, event).await;
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tickets_name_their_room() {
        let room = "a".repeat(64);
        assert_eq!(
            ticket_room(&format!("{room}.abcdefghijklmnop")),
            Some(room.as_str())
        );
        assert_eq!(ticket_room(&format!("{room}.short")), None);
        assert_eq!(
            ticket_room(&format!("{}.abcdefghijklmnop", "A".repeat(64))),
            None
        );
        assert_eq!(ticket_room("nope"), None);
        assert_eq!(ticket_room(&format!("{room}.abcdefghijklmnop!")), None);
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(secret_matches("abc", "abc"));
        assert!(!secret_matches("abc", "abd"));
        assert!(!secret_matches("abc", "ab"));
    }
}
