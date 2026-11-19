//! The realtime-worker's HTTP surface: the WebSocket upgrades (`/ws`,
//! `/ws/personal`, `/ws/chat/:channelId`, `/ws/support/:workspaceId`,
//! `/ws/conversation/:conversationId`) with their auth and access gates, and
//! the internal `/publish/*` and `/internal/presence` routes for callers that
//! cannot use the realtime port in process.
//!
//! A socket authenticates with its session token only (`?token=`, a bearer
//! header or the `authorization` subprotocol). The workspace-scoped sockets
//! work in the token's organization; in membership mode, whose tokens name
//! none, in the workspace `?workspace=` names ([`organization`]).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use weldsuite_auth::{AuthContext, TokenError};
use weldsuite_ports::{RealtimeMessage, RealtimePublisher, Room};

use crate::directory::{ChatAccess, DirectoryError, Member, WorkspaceResolver};
use crate::gateway::{Admission, Gateway};
use crate::room::RoomKind;
use crate::socket::{HubSession, RoomSession, serve_hub, serve_room};
use crate::topics::{personal_allowed, personal_hub_key, workspace_allowed};

/// The gateway's routes, to merge into the server's router. They carry
/// their own state and no request logging of their own: a socket's URL holds
/// the session token.
pub fn router(gateway: Arc<Gateway>) -> Router {
    Router::new()
        .route("/ws", get(workspace_socket))
        .route("/ws/personal", get(personal_socket))
        .route("/ws/chat/{channel_id}", get(chat_socket))
        .route("/ws/support/{workspace_id}", get(support_socket))
        .route(
            "/ws/conversation/{conversation_id}",
            get(conversation_socket),
        )
        .route("/publish/workspace", post(publish_workspace))
        .route("/publish/{room}/{id}", post(publish_room))
        .route("/internal/presence", get(internal_presence))
        .with_state(gateway)
}

/// A plain-text refusal, as the realtime-worker answers with `c.text`.
#[derive(Debug)]
struct Refusal(StatusCode, String);

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

type Answer = Result<Response, Refusal>;

fn text(status: StatusCode, body: impl Into<String>) -> Refusal {
    Refusal(status, body.into())
}

fn unauthorized(reason: &str) -> Refusal {
    text(StatusCode::UNAUTHORIZED, format!("Unauthorized: {reason}"))
}

fn forbidden(reason: &str) -> Refusal {
    text(StatusCode::FORBIDDEN, format!("Forbidden: {reason}"))
}

fn internal_error(message: &str) -> Refusal {
    text(StatusCode::INTERNAL_SERVER_ERROR, message)
}

/// Answer a handler's result, refusal or not.
fn reply(result: Answer) -> Response {
    result.unwrap_or_else(IntoResponse::into_response)
}

/// Answer a socket route's result. A refused handshake is logged with the
/// route, status and reason (never the URI or query: the token is in it), so
/// an operator can see why a browser's socket failed.
fn answer(route: &'static str, result: Answer) -> Response {
    result.unwrap_or_else(|refusal| {
        tracing::warn!(
            route,
            status = %refusal.0,
            reason = %refusal.1,
            "realtime: handshake refused"
        );
        refusal.into_response()
    })
}

fn query(uri: &Uri) -> HashMap<String, String> {
    form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .into_owned()
        .collect()
}

/// The token from `?token=`, `Authorization: Bearer`, or the
/// `authorization, <token>` WebSocket subprotocol, in that order.
fn token(uri: &Uri, headers: &HeaderMap) -> Option<String> {
    if let Some(token) = query(uri).remove("token").filter(|t| !t.is_empty()) {
        return Some(token);
    }
    let header = |name: http::HeaderName| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(bearer) =
        header(http::header::AUTHORIZATION).and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(bearer.to_owned());
    }
    let protocols: Vec<&str> = header(http::header::SEC_WEBSOCKET_PROTOCOL)?
        .split(", ")
        .collect();
    let at = protocols.iter().position(|p| *p == "authorization")?;
    protocols.get(at + 1).map(|token| (*token).to_owned())
}

/// The workspace a socket names in `?workspace=` (`workspaces.id`, its
/// organization id or its slug), trimmed; `None` when absent or empty.
fn workspace_param(uri: &Uri) -> Option<String> {
    query(uri)
        .remove("workspace")
        .map(|reference| reference.trim().to_owned())
        .filter(|reference| !reference.is_empty())
}

/// The organization a signed-in socket works in.
///
/// A token that names one decides: claim mode, where `named` is ignored, so
/// a token's organization is never overridden. In membership mode
/// (`OIDC_WORKSPACE_SOURCE=header`, `resolver` set) tokens name none, and a
/// browser can't send `X-Weld-Workspace` on a WebSocket, so the socket names
/// its workspace (`named`, from `?workspace=`): the session's user must be an
/// active member of it, checked as the API checks the header. A workspace
/// they may not use is refused (403) the same whether or not it exists.
///
/// `Ok(None)`: no organization either way; each route refuses that as it
/// did before membership mode.
async fn organization(
    resolver: Option<&dyn WorkspaceResolver>,
    auth: &AuthContext,
    named: Option<&str>,
) -> Result<Option<String>, Refusal> {
    if let Some(org) = &auth.org_id {
        return Ok(Some(org.clone()));
    }
    let (Some(resolver), Some(reference)) = (resolver, named) else {
        return Ok(None);
    };
    match resolver.member_workspace(&auth.user_id, reference).await {
        Ok(Some(org)) => Ok(Some(org)),
        Ok(None) => Err(forbidden("not a member of this workspace")),
        Err(error) => {
            tracing::error!(%error, "realtime: checking the workspace membership failed");
            Err(internal_error("Internal error resolving the workspace"))
        }
    }
}

/// The realtime-worker's refusal texts.
fn token_refusal(error: TokenError) -> &'static str {
    match error {
        TokenError::Malformed => "Invalid JWT format",
        TokenError::Expired => "Token expired",
        TokenError::MissingSubject | TokenError::EmptySubject => "No subject in token",
        TokenError::WrongIssuer => "Invalid token issuer",
        _ => "JWT signature verification failed",
    }
}

fn upgraded(
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<WebSocketUpgrade, Refusal> {
    upgrade.map_err(|_| text(StatusCode::UPGRADE_REQUIRED, "Expected WebSocket upgrade"))
}

impl Gateway {
    async fn session(&self, uri: &Uri, headers: &HeaderMap) -> Result<AuthContext, Refusal> {
        let Some(token) = token(uri, headers) else {
            return Err(unauthorized("Missing authorization token"));
        };
        self.auth
            .authenticate(&token)
            .await
            .map_err(|error| unauthorized(token_refusal(error)))
    }

    /// [`organization`] with this gateway's resolver (membership mode only).
    async fn organization(
        &self,
        auth: &AuthContext,
        named: Option<&str>,
    ) -> Result<Option<String>, Refusal> {
        organization(self.workspaces.as_deref(), auth, named).await
    }

    async fn workspace_member(&self, org: &str, user: &str) -> Result<Member, Refusal> {
        match self.directory.member(org, user).await {
            Ok(Some(member)) => Ok(member),
            Ok(None) => Err(forbidden("not a member of this workspace")),
            Err(DirectoryError::WorkspaceNotFound) => Err(forbidden("workspace not found")),
            Err(DirectoryError::Suspended) => Err(forbidden("workspace suspended")),
            Err(error @ DirectoryError::Failed(_)) => {
                tracing::error!(%error, "realtime: resolving the workspace failed");
                Err(internal_error("Internal error resolving the workspace"))
            }
        }
    }

    fn admitted(&self, user: &str) -> Result<Admission, Refusal> {
        self.admit(user)
            .ok_or_else(|| text(StatusCode::SERVICE_UNAVAILABLE, "Too many connections"))
    }

    fn upgrade(&self, upgrade: WebSocketUpgrade) -> WebSocketUpgrade {
        upgrade
            .max_message_size(self.config.max_message_bytes)
            .max_frame_size(self.config.max_message_bytes)
            .protocols(["authorization"])
    }
}

type Upgrade = Result<WebSocketUpgrade, WebSocketUpgradeRejection>;

/// `/ws`: the workspace hub of the session's organization (membership mode:
/// of the workspace `?workspace=` names).
async fn workspace_socket(
    State(gateway): State<Arc<Gateway>>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Upgrade,
) -> Response {
    answer("/ws", workspace(gateway, &uri, &headers, upgrade).await)
}

async fn workspace(
    gateway: Arc<Gateway>,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: Upgrade,
) -> Answer {
    let upgrade = upgraded(upgrade)?;
    let auth = gateway.session(uri, headers).await?;
    let org = gateway
        .organization(&auth, workspace_param(uri).as_deref())
        .await?
        .ok_or_else(|| unauthorized("No organization in token"))?;
    let member = gateway.workspace_member(&org, &auth.user_id).await?;
    let admission = gateway.admitted(&auth.user_id)?;
    let session = HubSession {
        allowed: workspace_allowed(&member.role, &auth.user_id),
        hub: member.hub,
        tracks_presence: true,
        user_id: auth.user_id,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_hub(gateway, socket, session, admission)))
}

/// `/ws/personal`: a consumer account's own hub, `personal:<user id>`.
async fn personal_socket(
    State(gateway): State<Arc<Gateway>>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Upgrade,
) -> Response {
    answer(
        "/ws/personal",
        personal(gateway, &uri, &headers, upgrade).await,
    )
}

async fn personal(
    gateway: Arc<Gateway>,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: Upgrade,
) -> Answer {
    let upgrade = upgraded(upgrade)?;
    let auth = gateway.session(uri, headers).await?;
    let admission = gateway.admitted(&auth.user_id)?;
    let session = HubSession {
        hub: personal_hub_key(&auth.user_id),
        tracks_presence: false,
        allowed: personal_allowed(&auth.user_id),
        user_id: auth.user_id,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_hub(gateway, socket, session, admission)))
}

fn display_name(member: &Member) -> String {
    member.name.clone().unwrap_or_else(|| "Unknown".to_owned())
}

/// `/ws/chat/:channelId`: a public channel or one the member is in (of the
/// workspace `?workspace=` names, in membership mode). Meeting rooms
/// (`meet_*`) have no channel row: anyone signed in, or a guest naming
/// themselves, may join (the meeting's join code is the boundary).
async fn chat_socket(
    State(gateway): State<Arc<Gateway>>,
    Path(channel_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Upgrade,
) -> Response {
    answer(
        "/ws/chat",
        chat(gateway, channel_id, &uri, &headers, upgrade).await,
    )
}

async fn chat(
    gateway: Arc<Gateway>,
    channel_id: String,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: Upgrade,
) -> Answer {
    let upgrade = upgraded(upgrade)?;
    let meeting = channel_id.starts_with("meet_");
    // No organization falls back to a meeting guest, as before; a workspace
    // named and refused (membership mode) is refused.
    let signed_in = match gateway.session(uri, headers).await {
        Ok(auth) => match gateway
            .organization(&auth, workspace_param(uri).as_deref())
            .await?
        {
            Some(org) => Ok((auth, org)),
            None => Err(unauthorized("No organization in token")),
        },
        Err(refusal) => Err(refusal),
    };
    let (user_id, user_name, role) = match signed_in {
        Ok((auth, org)) => {
            let member = gateway.workspace_member(&org, &auth.user_id).await?;
            if !meeting {
                let access = gateway
                    .directory
                    .chat_access(&member, &auth.user_id, &channel_id)
                    .await;
                match access {
                    Ok(ChatAccess::Allowed) => {}
                    Ok(ChatAccess::ChannelNotFound) => return Err(forbidden("channel not found")),
                    Ok(ChatAccess::NotMember) => {
                        return Err(forbidden("not a member of this channel"));
                    }
                    Err(error) => {
                        tracing::error!(%error, "[realtime /ws/chat] Channel access check failed");
                        return Err(internal_error("Internal error checking channel access"));
                    }
                }
            }
            (auth.user_id, display_name(&member), "member")
        }
        Err(refusal) => {
            if !meeting {
                return Err(refusal);
            }
            let params = query(uri);
            let guest = params.get("guestUserId").filter(|v| !v.is_empty());
            let name = params.get("guestName").filter(|v| !v.is_empty());
            let (Some(guest), Some(name)) = (guest, name) else {
                return Err(unauthorized("missing guest credentials"));
            };
            (guest.clone(), name.clone(), "guest")
        }
    };
    let admission = gateway.admitted(&user_id)?;
    let session = RoomSession {
        kind: RoomKind::Chat,
        room: channel_id,
        user_id,
        user_name,
        role: role.to_owned(),
        can_publish: true,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_room(gateway, socket, session, admission)))
}

/// `/ws/support/:workspaceId`: the workspace's support channel, for its own
/// members (`customer`). The support side (admin Clerk instance, `support`)
/// is not served here; see the crate docs. In membership mode the workspace
/// is the one `?workspace=` names, else the path's.
async fn support_socket(
    State(gateway): State<Arc<Gateway>>,
    Path(workspace_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Upgrade,
) -> Response {
    answer(
        "/ws/support",
        support(gateway, &workspace_id, &uri, &headers, upgrade).await,
    )
}

async fn support(
    gateway: Arc<Gateway>,
    workspace_id: &str,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: Upgrade,
) -> Answer {
    let upgrade = upgraded(upgrade)?;
    let token = token(uri, headers).ok_or_else(|| unauthorized("Missing token"))?;
    let auth = gateway
        .auth
        .authenticate(&token)
        .await
        .map_err(|_| unauthorized("Token verification failed"))?;
    let named = workspace_param(uri);
    let org = gateway
        .organization(&auth, Some(named.as_deref().unwrap_or(workspace_id)))
        .await?
        .ok_or_else(|| forbidden("not a member of this workspace"))?;
    let member = gateway.workspace_member(&org, &auth.user_id).await?;
    if ![
        org.as_str(),
        member.hub.as_str(),
        member.workspace_id.as_str(),
    ]
    .contains(&workspace_id)
    {
        return Err(forbidden("not a member of this workspace"));
    }
    let admission = gateway.admitted(&auth.user_id)?;
    let user_name = query(uri)
        .remove("userName")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| display_name(&member));
    let session = RoomSession {
        kind: RoomKind::Support,
        room: member.hub,
        user_id: auth.user_id,
        user_name,
        role: "customer".to_owned(),
        can_publish: true,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_room(gateway, socket, session, admission)))
}

/// `/ws/conversation/:conversationId`: a helpdesk conversation of the
/// member's workspace for agents (in membership mode, of the workspace
/// `?workspace=` names), or the one conversation a widget visitor's HS256
/// token was minted for.
async fn conversation_socket(
    State(gateway): State<Arc<Gateway>>,
    Path(conversation_id): Path<String>,
    uri: Uri,
    headers: HeaderMap,
    upgrade: Upgrade,
) -> Response {
    answer(
        "/ws/conversation",
        conversation(gateway, conversation_id, &uri, &headers, upgrade).await,
    )
}

async fn conversation(
    gateway: Arc<Gateway>,
    conversation_id: String,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: Upgrade,
) -> Answer {
    let upgrade = upgraded(upgrade)?;
    // An agent's session token first; anything else must be a widget
    // visitor's token bound to this conversation (knowing its id alone is
    // not enough to listen in).
    let Ok(auth) = gateway.session(uri, headers).await else {
        return visitor(gateway, conversation_id, uri, headers, upgrade);
    };
    let org = gateway
        .organization(&auth, workspace_param(uri).as_deref())
        .await?
        .ok_or_else(|| unauthorized("No organization in token"))?;
    let member = gateway.workspace_member(&org, &auth.user_id).await?;
    match gateway
        .directory
        .conversation_exists(&member, &conversation_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => return Err(forbidden("conversation not found")),
        Err(error) => {
            tracing::error!(%error, "[realtime] conversation access check failed");
            return Err(internal_error(
                "Internal error checking conversation access",
            ));
        }
    }
    let admission = gateway.admitted(&auth.user_id)?;
    let session = RoomSession {
        kind: RoomKind::Conversation,
        room: conversation_id,
        user_name: display_name(&member),
        user_id: auth.user_id,
        role: "agent".to_owned(),
        can_publish: true,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_room(gateway, socket, session, admission)))
}

/// A widget visitor on `/ws/conversation/:conversationId`, with the token
/// the widget API minted (`verifyWidgetToken`), as role `customer`.
fn visitor(
    gateway: Arc<Gateway>,
    conversation_id: String,
    uri: &Uri,
    headers: &HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Answer {
    let Some(token) = token(uri, headers) else {
        return Err(unauthorized("Missing widget token"));
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            i64::try_from(since.as_secs()).unwrap_or(i64::MAX)
        });
    let visitor = crate::widget::verify(gateway.config.widget_token_secret.as_deref(), &token, now)
        .map_err(unauthorized)?;
    if visitor.conversation_id.as_deref() != Some(conversation_id.as_str()) {
        return Err(forbidden("token is not valid for this conversation"));
    }
    let user_id = format!("visitor:{}", visitor.user_id);
    let admission = gateway.admitted(&user_id)?;
    let session = RoomSession {
        kind: RoomKind::Conversation,
        room: conversation_id,
        user_id,
        user_name: visitor.user_name,
        role: "customer".to_owned(),
        can_publish: true,
    };
    Ok(gateway
        .upgrade(upgrade)
        .on_upgrade(move |socket| serve_room(gateway, socket, session, admission)))
}

// ---------------------------------------------------------------------------
// Internal routes
// ---------------------------------------------------------------------------

/// `secretMatches`: present, equal, compared without an early exit.
fn secret_matches(given: Option<&str>, expected: &str) -> bool {
    let Some(given) = given else {
        return false;
    };
    if expected.is_empty() || given.len() != expected.len() {
        return false;
    }
    given
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// `requireInternalSecret`: `x-internal-secret` must match
/// `REALTIME_INTERNAL_SECRET`; with none configured nothing passes.
fn internal(gateway: &Gateway, headers: &HeaderMap) -> Result<(), Refusal> {
    let Some(expected) = gateway.config.internal_secret.as_deref() else {
        tracing::error!(
            "[realtime] REALTIME_INTERNAL_SECRET is not configured; refusing /publish/*"
        );
        return Err(forbidden("REALTIME_INTERNAL_SECRET not configured"));
    };
    let given = headers
        .get("x-internal-secret")
        .and_then(|v| v.to_str().ok());
    if secret_matches(given, expected) {
        Ok(())
    } else {
        Err(text(StatusCode::FORBIDDEN, "Forbidden"))
    }
}

fn json_body(body: &Bytes) -> Result<Value, Refusal> {
    serde_json::from_slice(body).map_err(|_| text(StatusCode::BAD_REQUEST, "Invalid JSON"))
}

async fn publish(gateway: &Gateway, message: RealtimeMessage) -> Answer {
    match gateway.publisher.publish(&message).await {
        Ok(()) => Ok((StatusCode::OK, "ok").into_response()),
        Err(error) => {
            tracing::error!(%error, channel = %message.channel, "[realtime] publish failed");
            Err(internal_error("Internal error"))
        }
    }
}

/// `POST /publish/workspace`: `{ workspaceId, topic, event, data, userId }`
/// to the workspace's hub (`workspaceId` may be either of its ids).
async fn publish_workspace(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reply(publish_to_workspace(&gateway, &headers, &body).await)
}

async fn publish_to_workspace(gateway: &Gateway, headers: &HeaderMap, body: &Bytes) -> Answer {
    internal(gateway, headers)?;
    let body = json_body(body)?;
    let reference = body
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let hub = gateway
        .directory
        .hub_key(reference)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[realtime] resolving the hub failed");
            internal_error("Internal error")
        })?;
    let mut payload = Map::new();
    payload.insert("workspaceId".to_owned(), hub.as_str().into());
    for key in ["topic", "event", "data", "userId"] {
        if let Some(value) = body.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    let message = RealtimeMessage {
        channel: format!("workspace:{hub}"),
        payload: Value::Object(payload),
    };
    publish(gateway, message).await
}

/// `POST /publish/{chat,support,conversation}/:id`: the body to the room.
async fn publish_room(
    State(gateway): State<Arc<Gateway>>,
    Path((room, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reply(publish_to_room(&gateway, &room, &id, &headers, &body).await)
}

async fn publish_to_room(
    gateway: &Gateway,
    room: &str,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Answer {
    internal(gateway, headers)?;
    let room = match room {
        "chat" => Room::Chat,
        "support" => Room::Support,
        "conversation" => Room::Conversation,
        _ => return Err(text(StatusCode::NOT_FOUND, "Not found")),
    };
    let body = json_body(body)?;
    publish(gateway, RealtimeMessage::room(room, id, body)).await
}

/// `GET /internal/presence?workspaceId=…[&userId=…]`: `{ users }`.
async fn internal_presence(
    State(gateway): State<Arc<Gateway>>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    reply(presence(&gateway, &uri, &headers).await)
}

async fn presence(gateway: &Gateway, uri: &Uri, headers: &HeaderMap) -> Answer {
    internal(gateway, headers)?;
    let pairs: Vec<(String, String)> =
        form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let reference = pairs
        .iter()
        .find(|(key, value)| key == "workspaceId" && !value.is_empty())
        .map(|(_, value)| value.clone())
        .ok_or_else(|| text(StatusCode::BAD_REQUEST, "workspaceId is required"))?;
    let users: Vec<String> = pairs
        .into_iter()
        .filter(|(key, _)| key == "userId")
        .map(|(_, value)| value)
        .collect();
    let presence = match gateway.directory.hub_key(&reference).await {
        Ok(hub) => gateway.publisher.presence(&hub, &users).await,
        Err(error) => Err(weldsuite_ports::PortError::backend(error)),
    };
    match presence {
        Ok(users) => Ok(axum::Json(json!({ "users": users })).into_response()),
        Err(error) => {
            tracing::error!(%error, "[realtime] presence read failed");
            Err(internal_error("Internal error"))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use weldsuite_ports::BoxFuture;

    use super::*;

    /// Membership mode's check: `user_1` is an active member of `ws_1`
    /// (organization `org_1`, slug `acme`); `down` fails every lookup.
    #[derive(Default)]
    struct Members {
        calls: AtomicUsize,
        down: bool,
    }

    impl WorkspaceResolver for Members {
        fn member_workspace<'a>(
            &'a self,
            user: &'a str,
            reference: &'a str,
        ) -> BoxFuture<'a, Result<Option<String>, DirectoryError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let result = if self.down {
                Err(DirectoryError::Failed("master down".to_owned()))
            } else {
                Ok(
                    (user == "user_1" && ["ws_1", "acme", "org_1"].contains(&reference))
                        .then(|| "org_1".to_owned()),
                )
            };
            Box::pin(std::future::ready(result))
        }
    }

    fn session(user: &str, org: Option<&str>) -> AuthContext {
        AuthContext {
            user_id: user.to_owned(),
            org_id: org.map(str::to_owned),
            session_id: String::new(),
            factor_verification_age: None,
        }
    }

    fn named(uri: &str) -> Option<String> {
        workspace_param(&uri.parse().expect("uri"))
    }

    #[test]
    fn the_workspace_parameter_is_trimmed_and_optional() {
        assert_eq!(named("/ws?token=t&workspace=ws_1").as_deref(), Some("ws_1"));
        assert_eq!(named("/ws?workspace=%20acme%20").as_deref(), Some("acme"));
        assert_eq!(named("/ws?token=t&workspace="), None);
        assert_eq!(named("/ws?token=t"), None);
    }

    #[tokio::test]
    async fn membership_mode_admits_a_member_on_the_named_workspace() {
        let members = Members::default();
        for reference in ["ws_1", "acme", "org_1"] {
            let org = organization(Some(&members), &session("user_1", None), Some(reference))
                .await
                .expect("admitted");
            assert_eq!(org.as_deref(), Some("org_1"), "{reference}");
        }
    }

    #[tokio::test]
    async fn membership_mode_refuses_a_workspace_the_user_is_not_in_alike() {
        let members = Members::default();
        // Another user's workspace and one that doesn't exist answer alike.
        for (user, reference) in [("user_2", "ws_1"), ("user_1", "ws_unknown")] {
            let Err(Refusal(status, body)) =
                organization(Some(&members), &session(user, None), Some(reference)).await
            else {
                panic!("{user} on {reference} is refused");
            };
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert_eq!(body, "Forbidden: not a member of this workspace");
        }
        let down = Members {
            down: true,
            ..Members::default()
        };
        let Err(Refusal(status, _)) =
            organization(Some(&down), &session("user_1", None), Some("ws_1")).await
        else {
            panic!("a failed lookup is refused");
        };
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn without_a_named_workspace_there_is_no_organization_as_before() {
        let members = Members::default();
        let org = organization(Some(&members), &session("user_1", None), None)
            .await
            .expect("no refusal of its own");
        assert_eq!(org, None, "the route answers `No organization in token`");
        assert_eq!(members.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_tokens_organization_is_never_overridden() {
        let members = Members::default();
        // Claim mode token, naming another workspace: the token wins, and
        // the parameter is not even looked up.
        let org = organization(
            Some(&members),
            &session("user_1", Some("org_claim")),
            Some("ws_1"),
        )
        .await
        .expect("admitted");
        assert_eq!(org.as_deref(), Some("org_claim"));
        assert_eq!(members.calls.load(Ordering::SeqCst), 0);
        // A claim-mode server ignores the parameter altogether.
        let org = organization(None, &session("user_1", None), Some("ws_1"))
            .await
            .expect("no refusal of its own");
        assert_eq!(org, None);
    }

    #[test]
    fn tokens_come_from_the_query_header_or_subprotocol() {
        let mut headers = HeaderMap::new();
        let uri: Uri = "/ws?token=a%2Bb".parse().expect("uri");
        assert_eq!(token(&uri, &headers).as_deref(), Some("a+b"));
        let bare: Uri = "/ws".parse().expect("uri");
        headers.insert(
            http::header::AUTHORIZATION,
            "Bearer bbb".parse().expect("header"),
        );
        assert_eq!(token(&bare, &headers).as_deref(), Some("bbb"));
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::SEC_WEBSOCKET_PROTOCOL,
            "authorization, ccc".parse().expect("header"),
        );
        assert_eq!(token(&bare, &headers).as_deref(), Some("ccc"));
        assert_eq!(token(&bare, &HeaderMap::new()), None);
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(secret_matches(Some("abc"), "abc"));
        assert!(!secret_matches(Some("abd"), "abc"));
        assert!(!secret_matches(Some("ab"), "abc"));
        assert!(!secret_matches(None, "abc"));
        assert!(!secret_matches(Some(""), ""));
    }
}
