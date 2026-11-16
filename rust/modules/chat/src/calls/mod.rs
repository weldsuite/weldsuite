//! `/api/chat-calls` (`routes/chat-calls/index.ts`) and
//! `/public/chat-calls` (`routes/chat-calls/public-decline.ts`): WeldChat's
//! voice and video calls.
//!
//! The backend keeps the call record and hands out join tokens; the client
//! SDK does the media. The room is the video provider's
//! (`weldsuite-video-rooms`): `RealtimeKit` on Global and in conformance (its
//! calls through the test's `fetch` stub), a self-hosted `LiveKit` server on
//! the Kubernetes editions, whose join tokens the platform hands to its
//! `LiveKit` client. Ending calls, the participant invariants and the DM
//! rooms are `weldsuite_chat_domain::calls`, shared with meet's video
//! webhooks.
//!
//! What differs from the worker: the 25-second ring timeout is the durable
//! `chat.call-ring-timeout` job (a delayed start) instead of a sleep inside
//! `waitUntil`, and "one live call at a time" reaches WeldMeet's sessions
//! through [`crate::MeetingSessionsLeaver`], which the app wires to meet.

mod history;
mod ring;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use http::request::Parts;
use serde_json::{Map, Value, json};
use weldsuite_chat_domain::Realtime;
use weldsuite_chat_domain::calls::{
    CallPorts, EndIfEmpty, EndIfEmptyOptions, active_participant_count, call_notice_metadata,
    call_row, dedupe_participants, end_chat_call, end_chat_call_if_empty, get_dm_call_room,
    insert_call_notice, is_abandoned_call, iso_of_ms, leave_other_active_calls, map_room_to_call,
    new_participant, now_ms, parse_ms, participants_of, remember_dm_call_room, room_of, text,
    upsert_participant,
};
use weldsuite_chat_domain::can_access_channel;
use weldsuite_chat_domain::publish::object;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, RequestEnv, generate_id};
use weldsuite_notifications::{ApnsConfig, Notifier};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, UnconfiguredVideoRooms, VideoError,
};
use weldsuite_ports::{
    BoxFuture, DynCache, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
    RequestCache,
};
use weldsuite_video_rooms::{RealtimeKit, RealtimeKitConfig};

pub use ring::{CALL_RING_TIMEOUT_JOB, CallRingTimeoutJob};

use crate::access::{Caller, ChatError, ChatResult, answer, validate};
use crate::{ChatState, LeaveMeetings};

/// The `RealtimeKit` presets marker (`ensurePresets`'s KV key, shared with
/// WeldMeet).
const PRESETS_SEEDED_KEY: &str = "rtk-presets-seeded-v8";

/// `PREPARED_JOIN_TTL_SECONDS`: KV's minimum; a ring lasts 25 s.
const PREPARED_JOIN_TTL_SECONDS: u64 = 60;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["channels:read"]);
    let create = || gate.require(["channels:create"]);
    Router::new()
        .route("/", post(start).route_layer(create()))
        .route(
            "/start-and-join",
            post(start_and_join).route_layer(create()),
        )
        .route("/active", get(active_calls).route_layer(read()))
        .route(
            "/active/{channel_id}",
            get(active_in_channel).route_layer(read()),
        )
        .route("/history", get(history::list).route_layer(read()))
        .route("/{call_id}", get(detail).route_layer(read()))
        .route("/{call_id}/prepare", post(prepare).route_layer(read()))
        .route("/{call_id}/join", post(join).route_layer(read()))
        .route("/{call_id}/leave", post(leave).route_layer(read()))
        .route(
            "/{call_id}/end",
            post(end).route_layer(gate.require(["channels:update"])),
        )
        .route("/{call_id}/decline", post(decline).route_layer(read()))
}

/// `/public/chat-calls`: the phone's lock-screen Decline, credentialed by
/// the ring's signed token.
pub(crate) fn public_router() -> Router<ChatState> {
    Router::new().route("/decline", post(public_decline))
}

// ============================================================================
// What a call request reaches
// ============================================================================

/// A deployment without an HTTP client: every call fails like a `fetch`
/// that can't connect.
struct Unreachable;

impl DynOutboundHttp for Unreachable {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(Err(PortError::backend(
            "no outbound HTTP client",
        ))))
    }
}

/// The request's ports for calls: in conformance (the test's env on the
/// request) `RealtimeKit` with the test's credentials through its outbound
/// bridge and the test's KV; else the app's provider and cache.
#[derive(Clone)]
struct RequestPorts {
    env: Option<RequestEnv>,
    cache: Option<RequestCache>,
    http: Option<OutboundHttp>,
}

impl RequestPorts {
    fn of(parts: &Parts) -> Self {
        Self {
            env: parts.extensions.get::<RequestEnv>().cloned(),
            cache: parts.extensions.get::<RequestCache>().cloned(),
            http: parts.extensions.get::<OutboundHttp>().cloned(),
        }
    }

    fn env(&self, state: &ChatState, name: &str) -> Option<String> {
        match &self.env {
            Some(env) => env.get(name).map(str::to_owned),
            None => state.env.get(name).cloned(),
        }
        .filter(|value| !value.is_empty())
    }

    fn http(&self, state: &ChatState) -> Option<OutboundHttp> {
        self.http.clone().or_else(|| state.http.clone())
    }

    fn video(&self, state: &ChatState) -> Arc<dyn DynVideoRooms> {
        if let Some(env) = &self.env {
            let config = RealtimeKitConfig::from_env(|name| env.get(name).map(str::to_owned));
            let http = self
                .http(state)
                .unwrap_or_else(|| OutboundHttp(Arc::new(Unreachable)));
            return Arc::new(RealtimeKit::new(config, http));
        }
        state.video.clone().unwrap_or_else(|| {
            Arc::new(UnconfiguredVideoRooms(
                "No video provider is configured".to_owned(),
            ))
        })
    }

    fn cache(&self, state: &ChatState) -> Option<Arc<dyn DynCache>> {
        match &self.cache {
            Some(RequestCache(cache)) => Some(Arc::clone(cache)),
            None if self.env.is_some() => None,
            None => state.cache.clone(),
        }
    }

    fn notifier(&self, state: &ChatState) -> Notifier {
        Notifier {
            realtime: state.realtime.clone(),
            presence: state.presence.clone(),
            mail: None,
            http: self.http(state),
            apns: ApnsConfig::from_values(
                self.env(state, "APNS_KEY_ID").as_deref(),
                self.env(state, "APNS_TEAM_ID").as_deref(),
                self.env(state, "APNS_PRIVATE_KEY").as_deref(),
            ),
        }
    }

    fn ports(&self, state: &ChatState) -> CallPorts {
        CallPorts {
            video: self.video(state),
            cache: self.cache(state),
            realtime: Realtime::new(state.realtime.clone()),
            notifier: self.notifier(state),
        }
    }
}

/// A signed-in call request: the caller and the request's ports.
struct CallRequest {
    caller: Caller,
    request: RequestPorts,
}

impl<S: Send + Sync> axum::extract::FromRequestParts<S> for CallRequest {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let caller = Caller::from_request_parts(parts, state).await?;
        Ok(Self {
            caller,
            request: RequestPorts::of(parts),
        })
    }
}

impl CallRequest {
    fn ports(&self, state: &ChatState) -> CallPorts {
        self.request.ports(state)
    }
}

/// Background work after the response (`c.executionCtx.waitUntil`).
fn later(state: &ChatState, work: impl Future<Output = ()> + Send + 'static) {
    state.events.tracker().spawn(work);
}

fn internal(error: &dyn std::fmt::Display, message: &str) -> ChatError {
    tracing::error!(%error, "[Chat:Calls] {message}");
    ChatError::api(ApiError::internal().with_message(message))
}

fn video_failed(message: &'static str) -> impl FnOnce(VideoError) -> ChatError {
    move |error| internal(&error, message)
}

/// `presetsReady(env)`: make sure the `RealtimeKit` presets the join names
/// exist (once per preset version). Best effort; nothing to do on `LiveKit`.
async fn presets_ready(video: &Arc<dyn DynVideoRooms>, cache: Option<&Arc<dyn DynCache>>) {
    if let Some(cache) = cache
        && let Ok(Some(marker)) = cache.get_boxed(PRESETS_SEEDED_KEY).await
        && !marker.is_empty()
    {
        return;
    }
    match video.seed_presets().await {
        Ok(()) => {
            if let Some(cache) = cache {
                let _ = cache.put_boxed(PRESETS_SEEDED_KEY, "1", None).await;
            }
        }
        Err(error) => {
            tracing::error!(%error, "[Chat:Calls] Seeding RealtimeKit presets failed");
        }
    }
}

/// The member's name and picture (`workspace_members`).
async fn member(
    db: &PgPool,
    user_id: &str,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let row: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.unwrap_or((None, None)))
}

/// `startCallSchema`: `{ channelId: string.min(1), callType: 'voice' | 'video' = 'voice' }`.
fn read_start(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> (String, String) {
    let channel_id = issues
        .text_with(
            body,
            "channelId",
            Presence::Required,
            Text::length(Some(1), None),
        )
        .into_option()
        .unwrap_or_default();
    let call_type = issues
        .choice(body, "callType", Presence::Optional, &["voice", "video"])
        .into_option()
        .unwrap_or_else(|| "voice".to_owned());
    (channel_id, call_type)
}

/// `disabledCallMessage(callType, channel)`.
fn disabled_call_message(
    call_type: &str,
    channel: Option<&(bool, bool, String)>,
) -> Option<&'static str> {
    let (voice, video, _) = channel?;
    if call_type == "voice" && !voice {
        return Some("Voice calls are disabled in this channel");
    }
    if call_type == "video" && !video {
        return Some("Video calls are disabled in this channel");
    }
    None
}

async fn is_member(db: &PgPool, channel_id: &str, user_id: &str) -> Result<bool, sqlx::Error> {
    weldsuite_chat_domain::access::is_member(db, channel_id, user_id).await
}

/// `(voice_calls_enabled, video_calls_enabled, type)` of the channel.
async fn channel_settings(
    db: &PgPool,
    channel_id: &str,
) -> Result<Option<(bool, bool, String)>, sqlx::Error> {
    sqlx::query_as(
        "select voice_calls_enabled, video_calls_enabled, type from chat_channels where id = $1 limit 1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await
}

/// The channel's ringing or active call, as Drizzle reads it.
async fn live_call_in(db: &PgPool, channel_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_calls t
         where t.channel_id = $1 and t.status in ('ringing', 'active') limit 1",
    )
    .bind(channel_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `endStaleCall`: end a call that looks abandoned unless the provider still
/// has people in it. A failed end lets the new call start, as before.
async fn end_stale_call(
    db: &PgPool,
    ports: &CallPorts,
    org: &str,
    call: &Value,
    is_dm: bool,
) -> EndIfEmpty {
    let call_id = text(call, "id").unwrap_or_default();
    let initiator = text(call, "initiatorId").unwrap_or_default();
    let options = EndIfEmptyOptions {
        send_missed_if_unanswered: false,
        end_when_alone: is_dm,
    };
    end_chat_call_if_empty(db, ports, org, call_id, call, initiator, options)
        .await
        .unwrap_or(EndIfEmpty::Ended)
}

/// `leaveOtherLiveCalls`: after a successful join, drop the user from every
/// other chat call and meeting session. Never fails.
async fn leave_other_live_calls(
    state: &ChatState,
    db: &PgPool,
    ports: &CallPorts,
    org: &str,
    user: &str,
    except_call_id: &str,
    triggered_at: i64,
) {
    leave_other_active_calls(db, ports, org, user, Some(except_call_id), triggered_at).await;
    if let Some(leave) = &state.leave_meetings {
        leave(LeaveMeetings {
            db: db.clone(),
            video: Arc::clone(&ports.video),
            cache: ports.cache.clone(),
            org_id: org.to_owned(),
            user_id: user.to_owned(),
            triggered_at,
        })
        .await;
    }
}

/// `publishChatCallParticipantJoined(env, channelId, data)`.
async fn publish_joined(
    realtime: &Realtime,
    channel_id: &str,
    call_id: &str,
    user_id: &str,
    user_name: &str,
    user_avatar: Option<&str>,
    session: &str,
) {
    realtime
        .call_participant(
            channel_id,
            object([
                ("callId", Some(json!(call_id))),
                ("userId", Some(json!(user_id))),
                ("userName", Some(json!(user_name))),
                ("userAvatar", user_avatar.map(|a| json!(a))),
                ("cfSessionId", Some(json!(session))),
                ("action", Some(json!("joined"))),
            ]),
        )
        .await;
}

/// The call started: the channel, every member's topic.
async fn publish_started(
    db: &PgPool,
    realtime: &Realtime,
    org: &str,
    channel_id: &str,
    call_id: &str,
    call_type: &str,
    initiator: &str,
) {
    realtime
        .call(channel_id, call_id, initiator, "started")
        .await;
    broadcast_started(db, realtime, org, channel_id, call_id, call_type).await;
}

/// `call_started` on every member's topic.
async fn broadcast_started(
    db: &PgPool,
    realtime: &Realtime,
    org: &str,
    channel_id: &str,
    call_id: &str,
    call_type: &str,
) {
    if let Err(error) = weldsuite_chat_domain::calls::broadcast_call_to_members(
        db,
        realtime,
        org,
        channel_id,
        "started",
        object([
            ("callId", Some(json!(call_id))),
            ("callType", Some(json!(call_type))),
        ]),
    )
    .await
    {
        tracing::error!(%error, "[Chat:Calls] Realtime publish failed");
    }
}

/// `max(maxParticipants, people still in)`.
fn max_participants(call: &Value, participants: &[Value]) -> i32 {
    let before = call
        .get("maxParticipants")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let now = i64::try_from(
        participants
            .iter()
            .filter(|p| !weldsuite_chat_domain::calls::truthy(p.get("leftAt")))
            .count(),
    )
    .unwrap_or(i64::MAX);
    i32::try_from(before.max(now)).unwrap_or(i32::MAX)
}

// ============================================================================
// POST / and POST /start-and-join
// ============================================================================

/// `POST /`: start a ringing call (the older two-step flow).
async fn start(
    State(state): State<ChatState>,
    request: CallRequest,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (channel_id, call_type) = match validate(&headers, &body, read_start) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    answer(
        start_inner(&state, &request, &org, &channel_id, &call_type).await,
        "Failed to start call",
    )
}

async fn start_inner(
    state: &ChatState,
    request: &CallRequest,
    org: &str,
    channel_id: &str,
    call_type: &str,
) -> ChatResult<Response> {
    let caller = &request.caller;
    let db = &caller.db;
    let user = caller.user_id.as_str();
    if !is_member(db, channel_id, user).await? {
        return Err(ChatError::forbidden("You are not a member of this channel"));
    }
    let channel = channel_settings(db, channel_id).await?;
    if let Some(message) = disabled_call_message(call_type, channel.as_ref()) {
        return Err(ChatError::forbidden(message));
    }
    let ports = request.ports(state);
    if let Some(existing) = live_call_in(db, channel_id).await? {
        let is_dm = channel.as_ref().is_some_and(|c| c.2 == "dm");
        if !is_abandoned_call(&existing, is_dm, user, now_ms())
            || end_stale_call(db, &ports, org, &existing, is_dm).await != EndIfEmpty::Ended
        {
            return Err(ChatError::conflict(
                "A call is already active in this channel",
            ));
        }
    }
    let (name, picture) = member(db, user).await?;
    let initiator_name = name.unwrap_or_else(|| "Unknown".to_owned());
    let call_id = generate_id("call");
    let now = iso_of_ms(now_ms());
    let label = if call_type == "video" {
        "video call"
    } else {
        "voice call"
    };

    let room = ports
        .video
        .create_room(&format!("{initiator_name}'s {label}"))
        .await
        .map_err(video_failed("Failed to start call"))?;
    map_room_to_call(ports.cache.as_ref(), &room, org, &call_id, channel_id)
        .await
        .map_err(|error| internal(&error, "Failed to start call"))?;
    sqlx::query(
        "insert into chat_calls (id, channel_id, call_type, status, cf_app_id, initiator_id,
             initiator_name, participants, max_participants, created_at, updated_at)
         values ($1, $2, $3, 'ringing', $4, $5, $6, '[]'::jsonb, 0, $7::timestamp, $7::timestamp)",
    )
    .bind(&call_id)
    .bind(channel_id)
    .bind(call_type)
    .bind(&room)
    .bind(user)
    .bind(&initiator_name)
    .bind(&now)
    .execute(db)
    .await?;
    let message_id = generate_id("msg");
    insert_call_notice(
        db,
        &message_id,
        channel_id,
        user,
        &initiator_name,
        picture.as_deref(),
        &format!("{initiator_name} started a {label}"),
        &call_notice_metadata(&call_id, call_type, "started", None, None),
        &now,
    )
    .await?;
    sqlx::query("update chat_calls set start_message_id = $2 where id = $1")
        .bind(&call_id)
        .bind(&message_id)
        .execute(db)
        .await?;

    // `publishCallStarted`: the events, then for a DM the ring of every
    // other member and the ring timeout. Best effort.
    publish_started(
        db,
        &ports.realtime,
        org,
        channel_id,
        &call_id,
        call_type,
        user,
    )
    .await;
    if channel.as_ref().is_some_and(|c| c.2 == "dm") {
        let ring = ring::Ring {
            org_id: org.to_owned(),
            caller_id: user.to_owned(),
            channel_id: channel_id.to_owned(),
            call_type: call_type.to_owned(),
            call_id: call_id.clone(),
            caller_name: initiator_name.clone(),
            caller_avatar: picture.clone(),
            secret: request.request.env(state, "CALL_RING_SECRET"),
        };
        ring::ring_dm_members(db, &ports, &ring).await;
        if state.ring_jobs {
            ring::schedule_ring_timeout(state.jobs.as_ref(), org, &call_id).await;
        }
    }
    Ok(
        Created(json!({ "callId": call_id, "status": "ringing", "meetingId": room }))
            .into_response(),
    )
}

/// `POST /start-and-join`: start a call and join it in one request, or join
/// the call already live in the channel.
async fn start_and_join(
    State(state): State<ChatState>,
    request: CallRequest,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (channel_id, call_type) = match validate(&headers, &body, read_start) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    answer(
        start_and_join_inner(&state, &request, &org, &channel_id, &call_type).await,
        "Failed to start call",
    )
}

async fn start_and_join_inner(
    state: &ChatState,
    request: &CallRequest,
    org: &str,
    channel_id: &str,
    call_type: &str,
) -> ChatResult<Response> {
    let requested_at = now_ms();
    let caller = &request.caller;
    let db = &caller.db;
    let user = caller.user_id.as_str();
    let ports = request.ports(state);

    let membership = is_member(db, channel_id, user).await?;
    let channel = channel_settings(db, channel_id).await?;
    let existing = live_call_in(db, channel_id).await?;
    let author = member(db, user).await?;
    // Read for every channel; only a DM uses it.
    let dm_room = get_dm_call_room(ports.cache.as_ref(), org, channel_id).await;
    presets_ready(&ports.video, ports.cache.as_ref()).await;

    if !membership {
        return Err(ChatError::forbidden("You are not a member of this channel"));
    }
    if let Some(message) = disabled_call_message(call_type, channel.as_ref()) {
        return Err(ChatError::forbidden(message));
    }
    let is_dm = channel.as_ref().is_some_and(|c| c.2 == "dm");
    if let Some(existing) = existing {
        // An abandoned call is ended so the new one can start (and ring),
        // unless the provider still has people in it: then the caller joins
        // it. A provider that can't be asked neither replaces nor joins.
        let outcome = if is_abandoned_call(&existing, is_dm, user, now_ms()) {
            end_stale_call(db, &ports, org, &existing, is_dm).await
        } else {
            EndIfEmpty::Occupied
        };
        if outcome != EndIfEmpty::Ended {
            let Some(room) = room_of(&existing).map(str::to_owned) else {
                return Err(ChatError::conflict(
                    "A call is already active in this channel",
                ));
            };
            if outcome == EndIfEmpty::Unknown {
                return Err(ChatError::conflict(
                    "A call is already active in this channel",
                ));
            }
            let joined = join_existing_call(
                state,
                &ports,
                caller,
                org,
                channel_id,
                &existing,
                &room,
                &author,
                requested_at,
            )
            .await?;
            return Ok(Data(joined).into_response());
        }
    }
    let started = start_new_call(
        state,
        request,
        &ports,
        org,
        channel_id,
        call_type,
        is_dm,
        dm_room,
        &author,
        requested_at,
    )
    .await?;
    Ok(Created(started).into_response())
}

/// `joinExistingCall`: join the call live in the channel (its own type).
#[allow(clippy::too_many_arguments)]
async fn join_existing_call(
    state: &ChatState,
    ports: &CallPorts,
    caller: &Caller,
    org: &str,
    channel_id: &str,
    call: &Value,
    room: &str,
    author: &(Option<String>, Option<String>),
    requested_at: i64,
) -> ChatResult<Value> {
    let user = caller.user_id.clone();
    let name = author.0.clone().unwrap_or_else(|| "Unknown".to_owned());
    let avatar = author.1.clone();
    let token = ports
        .video
        .add_participant(
            room,
            &NewParticipant {
                name: name.clone(),
                custom_participant_id: user.clone(),
                preset_name: None,
                picture: avatar.clone(),
            },
        )
        .await
        .map_err(video_failed("Failed to start call"))?;
    let participant = new_participant(
        &user,
        &name,
        avatar.as_deref(),
        &iso_of_ms(now_ms()),
        &token.participant_id,
    );
    let (merged, replaced) = upsert_participant(&participants_of(call), participant);
    let call_id = text(call, "id").unwrap_or_default().to_owned();
    let answer = json!({
        "callId": call_id,
        "authToken": token.token,
        "participants": merged,
        "callType": call["callType"],
    });

    let (state_c, ports, db) = (state.clone(), ports.clone(), caller.db.clone());
    let (org, channel_id, room) = (org.to_owned(), channel_id.to_owned(), room.to_owned());
    let call = call.clone();
    later(state, async move {
        let joined = JoinedCall {
            org: &org,
            user: &user,
            user_name: &name,
            avatar: avatar.as_deref(),
            call_id: &call_id,
            channel_id: &channel_id,
            room: &room,
            session: &token.participant_id,
        };
        announce_join(&ports, &joined, &replaced).await;
        let max = max_participants(&call, &merged);
        if let Err(error) = sqlx::query(
            "update chat_calls set participants = $2, max_participants = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&call_id)
        .bind(Value::Array(merged))
        .bind(max)
        .bind(iso_of_ms(now_ms()))
        .execute(&db)
        .await
        {
            tracing::error!(%error, "[Chat:Calls] Background join-existing tasks failed");
        }
        settle_join(
            &state_c,
            &db,
            &ports,
            &joined,
            &call,
            &replaced,
            requested_at,
        )
        .await;
    });
    Ok(answer)
}

/// Who joined which call, for the work after the answer.
struct JoinedCall<'a> {
    org: &'a str,
    user: &'a str,
    user_name: &'a str,
    avatar: Option<&'a str>,
    call_id: &'a str,
    channel_id: &'a str,
    room: &'a str,
    /// The provider's id of the new connection.
    session: &'a str,
}

/// The join's publishes, in the order the worker sends them (its
/// `waitUntil` work starts them before anything it awaits): the replaced
/// connections' `call_superseded`, `call_answered`, then participant joined.
async fn announce_join(ports: &CallPorts, joined: &JoinedCall<'_>, replaced: &[String]) {
    for session in replaced {
        ports
            .realtime
            .call_superseded(
                joined.org,
                joined.user,
                json!({ "kind": "chat", "id": joined.call_id, "cfSessionId": session }),
            )
            .await;
    }
    ports
        .realtime
        .call_answered(joined.org, joined.user, joined.call_id, joined.channel_id)
        .await;
    publish_joined(
        &ports.realtime,
        joined.channel_id,
        joined.call_id,
        joined.user,
        joined.user_name,
        joined.avatar,
        joined.session,
    )
    .await;
}

/// After the join was written: drop the replaced connections, leave every
/// other live call, and stop the ring this join answered.
async fn settle_join(
    state: &ChatState,
    db: &PgPool,
    ports: &CallPorts,
    joined: &JoinedCall<'_>,
    call_before: &Value,
    replaced: &[String],
    requested_at: i64,
) {
    // Announced above; only the removal is left.
    weldsuite_chat_domain::calls::evict_sessions(ports, Some(joined.room), replaced, None).await;
    leave_other_live_calls(
        state,
        db,
        ports,
        joined.org,
        joined.user,
        joined.call_id,
        requested_at,
    )
    .await;
    // Joining a call that rang us answers it: stop the ring everywhere else.
    ring::cancel_ring_on_answer(db, &ports.notifier, call_before, joined.user).await;
}

/// `startNewCall`: a DM reuses its room; other channels get a fresh one.
#[allow(clippy::too_many_arguments)]
async fn start_new_call(
    state: &ChatState,
    request: &CallRequest,
    ports: &CallPorts,
    org: &str,
    channel_id: &str,
    call_type: &str,
    is_dm: bool,
    dm_room: Option<String>,
    author: &(Option<String>, Option<String>),
    requested_at: i64,
) -> ChatResult<Value> {
    let caller = &request.caller;
    let db = &caller.db;
    let user = caller.user_id.as_str();
    let initiator_name = author.0.clone().unwrap_or_else(|| "Unknown".to_owned());
    let picture = author.1.clone();
    let label = if call_type == "video" {
        "video call"
    } else {
        "voice call"
    };
    let title = format!("{initiator_name}'s {label}");
    let now_ms = now_ms();
    let now = iso_of_ms(now_ms);

    let reused_room = is_dm && dm_room.is_some();
    let room = match dm_room.filter(|_| is_dm) {
        Some(room) => room,
        None => ports
            .video
            .create_room(&title)
            .await
            .map_err(video_failed("Failed to start call"))?,
    };
    if is_dm {
        // Store a new room, or refresh the one just used.
        let (cache, org_c, channel_c, room_c) = (
            ports.cache.clone(),
            org.to_owned(),
            channel_id.to_owned(),
            room.clone(),
        );
        later(state, async move {
            remember_dm_call_room(cache.as_ref(), &org_c, &channel_c, &room_c).await;
        });
    }

    let call_id = generate_id("call");
    let message_id = generate_id("msg");
    let mut participant = new_participant(user, &initiator_name, picture.as_deref(), &now, "");

    // The call record, its notice and the room mapping.
    sqlx::query(
        "insert into chat_calls (id, channel_id, call_type, status, cf_app_id, initiator_id,
             initiator_name, participants, max_participants, started_at, created_at, updated_at)
         values ($1, $2, $3, 'active', $4, $5, $6, $7, 1, $8::timestamp, $8::timestamp, $8::timestamp)",
    )
    .bind(&call_id)
    .bind(channel_id)
    .bind(call_type)
    .bind(&room)
    .bind(user)
    .bind(&initiator_name)
    .bind(Value::Array(vec![participant.clone()]))
    .bind(&now)
    .execute(db)
    .await?;
    insert_call_notice(
        db,
        &message_id,
        channel_id,
        user,
        &initiator_name,
        picture.as_deref(),
        &format!("{initiator_name} started a {label}"),
        &call_notice_metadata(&call_id, call_type, "started", None, None),
        &now,
    )
    .await?;
    map_room_to_call(ports.cache.as_ref(), &room, org, &call_id, channel_id)
        .await
        .map_err(|error| internal(&error, "Failed to start call"))?;

    // Ring the other DM members as soon as the call row exists, without
    // waiting for the caller's own token.
    if is_dm {
        let ring = ring::Ring {
            org_id: org.to_owned(),
            caller_id: user.to_owned(),
            channel_id: channel_id.to_owned(),
            call_type: call_type.to_owned(),
            call_id: call_id.clone(),
            caller_name: initiator_name.clone(),
            caller_avatar: picture.clone(),
            secret: request.request.env(state, "CALL_RING_SECRET"),
        };
        let (db_c, ports_c, jobs, ring_jobs) = (
            db.clone(),
            ports.clone(),
            state.jobs.clone(),
            state.ring_jobs,
        );
        later(state, async move {
            ring::ring_dm_members(&db_c, &ports_c, &ring).await;
            if ring_jobs {
                ring::schedule_ring_timeout(jobs.as_ref(), &ring.org_id, &ring.call_id).await;
            }
        });
    }

    let caller_params = NewParticipant {
        name: initiator_name.clone(),
        custom_participant_id: user.to_owned(),
        preset_name: None,
        picture: picture.clone(),
    };
    let token = match add_caller_to_room(
        db,
        ports,
        org,
        channel_id,
        &call_id,
        &room,
        reused_room,
        &title,
        &caller_params,
    )
    .await
    {
        Ok(token) => token,
        Err(error) => {
            // The ring may already be out: end the call rather than leave it
            // ringing for a caller who never got in.
            let failed = json!({
                "startedAt": now,
                "cfAppId": Value::Null,
                "channelId": channel_id,
                "initiatorId": user,
                "initiatorName": initiator_name,
                "status": "active",
                "callType": call_type,
                "participants": [participant],
            });
            let (db_c, ports_c, org_c, call_c, user_c) = (
                db.clone(),
                ports.clone(),
                org.to_owned(),
                call_id.clone(),
                user.to_owned(),
            );
            later(state, async move {
                if let Err(error) =
                    end_chat_call(&db_c, &ports_c, &org_c, &call_c, &failed, &user_c, false).await
                {
                    tracing::error!(%error, "[Chat:Calls] Ending the failed call failed");
                }
            });
            return Err(internal(&error, "Failed to start call"));
        }
    };

    // Record the caller's session, link the notice, one call at a time, publish.
    if let Some(entry) = participant.as_object_mut() {
        entry.insert("cfSessionId".into(), json!(token.participant_id));
    }
    let answer = json!({
        "callId": call_id,
        "authToken": token.token,
        "participants": [participant.clone()],
        "callType": call_type,
    });
    let (state_c, ports_c, db_c) = (state.clone(), ports.clone(), db.clone());
    let (org_c, channel_c, user_c, type_c) = (
        org.to_owned(),
        channel_id.to_owned(),
        user.to_owned(),
        call_type.to_owned(),
    );
    later(state, async move {
        // The worker starts these two before anything it awaits.
        ports_c
            .realtime
            .call(&channel_c, &call_id, &user_c, "started")
            .await;
        publish_joined(
            &ports_c.realtime,
            &channel_c,
            &call_id,
            &user_c,
            &initiator_name,
            picture.as_deref(),
            &token.participant_id,
        )
        .await;
        let fresh = call_row(&db_c, &call_id).await.ok().flatten();
        let before = fresh.as_ref().map(participants_of).unwrap_or_default();
        let (next, _) = upsert_participant(&before, participant);
        let max = max_participants(fresh.as_ref().unwrap_or(&Value::Null), &next);
        if let Err(error) = sqlx::query(
            "update chat_calls set participants = $2, max_participants = $3, start_message_id = $4
             where id = $1",
        )
        .bind(&call_id)
        .bind(Value::Array(next))
        .bind(max)
        .bind(&message_id)
        .execute(&db_c)
        .await
        {
            tracing::error!(%error, "[Chat:Calls] Background tasks failed");
        }
        broadcast_started(
            &db_c,
            &ports_c.realtime,
            &org_c,
            &channel_c,
            &call_id,
            &type_c,
        )
        .await;
        leave_other_live_calls(
            &state_c,
            &db_c,
            &ports_c,
            &org_c,
            &user_c,
            &call_id,
            requested_at,
        )
        .await;
    });
    Ok(answer)
}

/// `addCallerToRoom`: add the caller; when the DM's stored room turns out
/// to be gone, give the DM a new room and move the call into it.
#[allow(clippy::too_many_arguments)]
async fn add_caller_to_room(
    db: &PgPool,
    ports: &CallPorts,
    org: &str,
    channel_id: &str,
    call_id: &str,
    room: &str,
    reused_room: bool,
    title: &str,
    params: &NewParticipant,
) -> Result<JoinToken, String> {
    match ports.video.add_participant(room, params).await {
        Ok(token) => Ok(token),
        Err(error) if !reused_room => Err(error.to_string()),
        Err(error) => {
            tracing::warn!(%error, "[Chat:Calls] Persistent DM room unusable, replacing it");
            let fresh = ports
                .video
                .create_room(title)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("update chat_calls set cf_app_id = $2 where id = $1")
                .bind(call_id)
                .bind(&fresh)
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
            map_room_to_call(ports.cache.as_ref(), &fresh, org, call_id, channel_id)
                .await
                .map_err(|e| e.to_string())?;
            remember_dm_call_room(ports.cache.as_ref(), org, channel_id, &fresh).await;
            ports
                .video
                .add_participant(&fresh, params)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

// ============================================================================
// POST /:callId/prepare and /:callId/join
// ============================================================================

/// A participant minted while the call rang (`PreparedJoin`).
#[derive(Debug, Clone)]
struct PreparedJoin {
    meeting_id: String,
    participant_id: String,
    token: String,
}

fn prepared_join_key(call_id: &str, user_id: &str) -> String {
    format!("chat-call-prepared:{call_id}:{user_id}")
}

/// `readPreparedJoin`: the parked participant, or `None`. Never fails.
async fn read_prepared_join(
    cache: Option<&Arc<dyn DynCache>>,
    call_id: &str,
    user_id: &str,
) -> Option<PreparedJoin> {
    let raw = cache?
        .get_boxed(&prepared_join_key(call_id, user_id))
        .await
        .ok()??;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let field = |key: &str| {
        text(&parsed, key)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    Some(PreparedJoin {
        meeting_id: field("meetingId")?,
        participant_id: field("participantId")?,
        token: field("token")?,
    })
}

/// The call a token may be had for: found, readable, ringing or active, with
/// a room.
async fn joinable_call(caller: &Caller, call_id: &str) -> ChatResult<(Value, String)> {
    let Some(call) = call_row(&caller.db, call_id).await? else {
        return Err(ChatError::not_found("Call", Some(call_id)));
    };
    let channel_id = text(&call, "channelId").unwrap_or_default();
    if !can_access_channel(&caller.db, channel_id, &caller.user_id, None).await? {
        return Err(ChatError::forbidden("You do not have access to this call"));
    }
    if !matches!(text(&call, "status"), Some("ringing" | "active")) {
        return Err(ChatError::bad_request("Call is not joinable"));
    }
    let Some(room) = room_of(&call).map(str::to_owned) else {
        return Err(ChatError::api(
            ApiError::internal().with_message("Call has no meeting ID"),
        ));
    };
    Ok((call, room))
}

/// `POST /:callId/prepare`: a token for a call ringing for you, before you
/// answer it. Records nothing on the call.
async fn prepare(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(call_id): Path<String>,
) -> Response {
    if let Err(error) = request.caller.org() {
        return error.respond("");
    }
    answer(
        prepare_inner(&state, &request, &call_id).await,
        "Failed to prepare call",
    )
}

async fn prepare_inner(
    state: &ChatState,
    request: &CallRequest,
    call_id: &str,
) -> ChatResult<Response> {
    let caller = &request.caller;
    let ports = request.ports(state);
    let author = member(&caller.db, &caller.user_id).await?;
    let prepared = read_prepared_join(ports.cache.as_ref(), call_id, &caller.user_id).await;
    presets_ready(&ports.video, ports.cache.as_ref()).await;
    let (call, room) = joinable_call(caller, call_id).await?;

    // A second ring delivery or another tab gets the participant already parked.
    let ready = if let Some(ready) = prepared.filter(|p| p.meeting_id == room) {
        ready
    } else {
        let token = ports
            .video
            .add_participant(
                &room,
                &NewParticipant {
                    name: author.0.unwrap_or_else(|| "Unknown".to_owned()),
                    custom_participant_id: caller.user_id.clone(),
                    preset_name: None,
                    picture: author.1,
                },
            )
            .await
            .map_err(video_failed("Failed to prepare call"))?;
        let ready = PreparedJoin {
            meeting_id: room.clone(),
            participant_id: token.participant_id,
            token: token.token,
        };
        if let Some(cache) = &ports.cache {
            let value = json!({
                "meetingId": ready.meeting_id,
                "participantId": ready.participant_id,
                "token": ready.token,
            })
            .to_string();
            cache
                .put_boxed(
                    &prepared_join_key(call_id, &caller.user_id),
                    &value,
                    Some(std::time::Duration::from_secs(PREPARED_JOIN_TTL_SECONDS)),
                )
                .await
                .map_err(|error| internal(&error, "Failed to prepare call"))?;
        }
        ready
    };
    Ok(Data(json!({
        "callId": call_id,
        "channelId": call["channelId"],
        "callType": call["callType"],
        "authToken": ready.token,
    }))
    .into_response())
}

/// `POST /:callId/join`: join a call (reusing the participant prepared while
/// it rang).
async fn join(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(call_id): Path<String>,
) -> Response {
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    answer(
        join_inner(&state, &request, &org, &call_id).await,
        "Failed to join call",
    )
}

async fn join_inner(
    state: &ChatState,
    request: &CallRequest,
    org: &str,
    call_id: &str,
) -> ChatResult<Response> {
    let requested_at = now_ms();
    let caller = &request.caller;
    let ports = request.ports(state);
    let author = member(&caller.db, &caller.user_id).await?;
    let prepared = read_prepared_join(ports.cache.as_ref(), call_id, &caller.user_id).await;
    presets_ready(&ports.video, ports.cache.as_ref()).await;
    let (call, room) = joinable_call(caller, call_id).await?;

    let user = caller.user_id.clone();
    let user_name = author.0.clone().unwrap_or_else(|| "Unknown".to_owned());
    let avatar = author.1.clone();
    let token = match prepared.as_ref().filter(|p| p.meeting_id == room) {
        Some(ready) => JoinToken {
            participant_id: ready.participant_id.clone(),
            token: ready.token.clone(),
        },
        None => ports
            .video
            .add_participant(
                &room,
                &NewParticipant {
                    name: user_name.clone(),
                    custom_participant_id: user.clone(),
                    preset_name: None,
                    picture: avatar.clone(),
                },
            )
            .await
            .map_err(video_failed("Failed to join call"))?,
    };
    if prepared.is_some()
        && let Some(cache) = ports.cache.clone()
    {
        let key = prepared_join_key(call_id, &user);
        later(state, async move {
            let _ = cache.delete_boxed(&key).await;
        });
    }

    let now = iso_of_ms(now_ms());
    let participant = new_participant(
        &user,
        &user_name,
        avatar.as_deref(),
        &now,
        &token.participant_id,
    );
    let (participants, replaced) = upsert_participant(&participants_of(&call), participant);
    let channel_id = text(&call, "channelId").unwrap_or_default().to_owned();
    let answer = json!({
        "callId": call_id,
        "channelId": channel_id,
        "callType": call["callType"],
        "authToken": token.token,
        "participants": participants,
    });

    let ringing = text(&call, "status") == Some("ringing");
    let (state_c, db, call_id) = (state.clone(), caller.db.clone(), call_id.to_owned());
    let org = org.to_owned();
    later(state, async move {
        let joined = JoinedCall {
            org: &org,
            user: &user,
            user_name: &user_name,
            avatar: avatar.as_deref(),
            call_id: &call_id,
            channel_id: &channel_id,
            room: &room,
            session: &token.participant_id,
        };
        announce_join(&ports, &joined, &replaced).await;
        let max = max_participants(&call, &participants);
        if let Err(error) = sqlx::query(
            "update chat_calls set participants = $2, max_participants = $3, updated_at = $4::timestamp,
                 status = case when $5 then 'active' else status end,
                 started_at = case when $5 then $4::timestamp else started_at end
             where id = $1",
        )
        .bind(&call_id)
        .bind(Value::Array(participants))
        .bind(max)
        .bind(&now)
        .bind(ringing)
        .execute(&db)
        .await
        {
            tracing::error!(%error, "[Chat:Calls] Background join tasks failed");
        }
        settle_join(
            &state_c,
            &db,
            &ports,
            &joined,
            &call,
            &replaced,
            requested_at,
        )
        .await;
    });
    Ok(Data(answer).into_response())
}

// ============================================================================
// POST /:callId/leave, /end, /decline
// ============================================================================

/// The call, readable by the caller, or the 404 / 403.
async fn readable_call(caller: &Caller, call_id: &str) -> ChatResult<Value> {
    let Some(call) = call_row(&caller.db, call_id).await? else {
        return Err(ChatError::not_found("Call", Some(call_id)));
    };
    let channel_id = text(&call, "channelId").unwrap_or_default();
    if !can_access_channel(&caller.db, channel_id, &caller.user_id, None).await? {
        return Err(ChatError::forbidden("You do not have access to this call"));
    }
    Ok(call)
}

/// `POST /:callId/leave`: mark the caller left; when nobody is left, end the
/// call once the provider confirms the room is empty.
async fn leave(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(call_id): Path<String>,
) -> Response {
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    answer(
        leave_inner(&state, &request, &org, &call_id).await,
        "Failed to leave call",
    )
}

async fn leave_inner(
    state: &ChatState,
    request: &CallRequest,
    org: &str,
    call_id: &str,
) -> ChatResult<Response> {
    let caller = &request.caller;
    let call = readable_call(caller, call_id).await?;
    let now = iso_of_ms(now_ms());
    let participants: Vec<Value> = dedupe_participants(&participants_of(&call))
        .into_iter()
        .map(|mut p| {
            let left = p.get("leftAt").is_some_and(|at| !at.is_null());
            if text(&p, "userId") == Some(caller.user_id.as_str())
                && !left
                && let Some(entry) = p.as_object_mut()
            {
                entry.insert("leftAt".into(), json!(now));
            }
            p
        })
        .collect();
    let nobody_left = active_participant_count(&participants) == 0;
    sqlx::query(
        "update chat_calls set participants = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(call_id)
    .bind(Value::Array(participants))
    .bind(&now)
    .execute(&caller.db)
    .await?;
    let ports = request.ports(state);
    let channel_id = text(&call, "channelId").unwrap_or_default();
    weldsuite_chat_domain::calls::publish_participant_left(
        &ports.realtime,
        channel_id,
        call_id,
        &caller.user_id,
    )
    .await;

    // A call nobody answered can only hold the leaver's own connection, which
    // must not keep the callee ringing.
    if nobody_left && matches!(text(&call, "status"), Some("active" | "ringing")) {
        let options = EndIfEmptyOptions {
            end_when_alone: !weldsuite_chat_domain::calls::was_answered(&call),
            ..EndIfEmptyOptions::default()
        };
        end_chat_call_if_empty(
            &caller.db,
            &ports,
            org,
            call_id,
            &call,
            &caller.user_id,
            options,
        )
        .await?;
    }
    Ok(Data(json!({ "ok": true })).into_response())
}

/// `POST /:callId/end`: end the call for everyone.
async fn end(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(call_id): Path<String>,
) -> Response {
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let caller = &request.caller;
        let call = readable_call(caller, &call_id).await?;
        let ports = request.ports(&state);
        end_chat_call(
            &caller.db,
            &ports,
            &org,
            &call_id,
            &call,
            &caller.user_id,
            true,
        )
        .await?;
        Ok(Data(json!({ "ok": true })).into_response())
    };
    answer(result.await, "Failed to end call")
}

/// `POST /:callId/decline`: decline a call ringing for you.
async fn decline(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(call_id): Path<String>,
) -> Response {
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let caller = &request.caller;
        let call = readable_call(caller, &call_id).await?;
        let ports = request.ports(&state);
        if !ring::decline_ringing_call(&caller.db, &ports, &org, &call, &caller.user_id).await? {
            return Err(ChatError::bad_request("Call is not ringing"));
        }
        Ok(Data(json!({ "ok": true })).into_response())
    };
    answer(result.await, "Failed to decline call")
}

// ============================================================================
// GET /active, /active/:channelId, /:callId
// ============================================================================

/// `GET /active`: the live calls of every channel the caller is a member of.
async fn active_calls(request: CallRequest) -> Response {
    if let Err(error) = request.caller.org() {
        return error.respond("");
    }
    let result = async {
        let caller = &request.caller;
        let channels: Vec<String> =
            sqlx::query_scalar("select channel_id from chat_channel_members where user_id = $1")
                .bind(&caller.user_id)
                .fetch_all(&caller.db)
                .await?;
        if channels.is_empty() {
            return Ok(Data(json!([])).into_response());
        }
        let rows: Vec<(
            String,
            String,
            String,
            String,
            Option<Value>,
            String,
            String,
            String,
        )> = sqlx::query_as(
            "select c.channel_id, c.id, c.call_type, c.status, c.participants, c.initiator_id,
                        c.initiator_name, ch.type
                 from chat_calls c inner join chat_channels ch on ch.id = c.channel_id
                 where c.channel_id = any($1) and c.status in ('ringing', 'active')",
        )
        .bind(&channels)
        .fetch_all(&caller.db)
        .await?;
        let calls: Vec<Value> = rows
            .into_iter()
            .map(
                |(
                    channel_id,
                    call_id,
                    call_type,
                    status,
                    participants,
                    initiator_id,
                    initiator_name,
                    channel_type,
                )| {
                    let participants = participants
                        .and_then(|p| p.as_array().cloned())
                        .unwrap_or_default();
                    json!({
                        "channelId": channel_id,
                        "callId": call_id,
                        "callType": call_type,
                        "status": status,
                        "participantCount": active_participant_count(&participants),
                        "initiatorId": initiator_id,
                        "initiatorName": initiator_name,
                        "channelType": channel_type,
                    })
                },
            )
            .collect();
        Ok(Data(Value::Array(calls)).into_response())
    };
    answer(result.await, "Failed to list active calls")
}

/// The call with its participant list deduplicated (`{ ...call, participants }`).
fn with_deduped(mut call: Value) -> Value {
    let participants = dedupe_participants(&participants_of(&call));
    call["participants"] = Value::Array(participants);
    call
}

/// `GET /active/:channelId`: the channel's live call, ending one that has
/// gone stale once the provider confirms its room is empty.
async fn active_in_channel(
    State(state): State<ChatState>,
    request: CallRequest,
    Path(channel_id): Path<String>,
) -> Response {
    let org = match request.caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let caller = &request.caller;
        if !can_access_channel(&caller.db, &channel_id, &caller.user_id, None).await? {
            return Err(ChatError::forbidden(
                "You do not have access to this channel",
            ));
        }
        let Some(call) = live_call_in(&caller.db, &channel_id).await? else {
            return Ok(Data(Value::Null).into_response());
        };
        let now = now_ms();
        let nobody = active_participant_count(&participants_of(&call)) == 0;
        let age = |key: &str| text(&call, key).and_then(parse_ms).map(|at| now - at);
        let status = text(&call, "status");
        let stale_ringing =
            status == Some("ringing") && nobody && age("createdAt").is_some_and(|a| a > 60_000);
        let stale_active =
            status == Some("active") && nobody && age("updatedAt").is_some_and(|a| a > 5 * 60_000);
        if stale_ringing || stale_active {
            let ports = request.ports(&state);
            let call_id = text(&call, "id").unwrap_or_default();
            let initiator = text(&call, "initiatorId").unwrap_or_default();
            let outcome = end_chat_call_if_empty(
                &caller.db,
                &ports,
                &org,
                call_id,
                &call,
                initiator,
                EndIfEmptyOptions::default(),
            )
            .await
            .unwrap_or_else(|error| {
                tracing::error!(%error, "[Chat:Calls] Failed to auto-end stale call");
                EndIfEmpty::Unknown
            });
            if outcome == EndIfEmpty::Ended {
                return Ok(Data(Value::Null).into_response());
            }
        }
        Ok(Data(with_deduped(call)).into_response())
    };
    answer(result.await, "Failed to get active call")
}

/// `GET /:callId`.
async fn detail(request: CallRequest, Path(call_id): Path<String>) -> Response {
    if let Err(error) = request.caller.org() {
        return error.respond("");
    }
    let result = async {
        let call = readable_call(&request.caller, &call_id).await?;
        Ok(Data(with_deduped(call)).into_response())
    };
    answer(result.await, "Failed to get call")
}

// ============================================================================
// POST /public/chat-calls/decline
// ============================================================================

/// `POST /public/chat-calls/decline` with `{ token }`: decline the ring from
/// the phone's native call UI. Idempotent: a call that stopped ringing is a
/// success, so the phone never retries.
async fn public_decline(
    State(state): State<ChatState>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, 64 * 1024).await else {
        return ApiError::bad_request("Invalid JSON").into_response();
    };
    let token = match validate(&parts.headers, &body, |issues, body| {
        issues
            .text_with(
                body,
                "token",
                Presence::Required,
                Text::length(Some(1), Some(2000)),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(token) => token,
        Err(error) => return error.respond(""),
    };
    let request_ports = RequestPorts::of(&parts);
    let secret = request_ports.env(&state, "CALL_RING_SECRET");
    let Some(claims) = ring::verify_ring_token(secret.as_deref(), &token, now_ms()) else {
        if secret.is_none() {
            tracing::error!("[Chat:Calls] CALL_RING_SECRET is not set; ring declines are rejected");
        }
        return ApiError::unauthorized()
            .with_message("Invalid or expired ring token")
            .into_response();
    };
    let result = async {
        let db = match parts.extensions.get::<Tenant>() {
            Some(tenant) => tenant.db.clone(),
            None => match &state.tenants {
                Some(tenants) => tenants(claims.org.clone())
                    .await
                    .map_err(|error| internal(&error, "Failed to decline call"))?,
                None => return Err(internal(&"no tenant databases", "Failed to decline call")),
            },
        };
        let Some(call) = ring::load_call(&db, &claims.call).await? else {
            return Err(ChatError::not_found("Call", Some(&claims.call)));
        };
        // The token proves who was rung; they must still belong in the channel.
        let channel_id = text(&call, "channelId").unwrap_or_default();
        if !can_access_channel(&db, channel_id, &claims.user, None).await? {
            return Err(ChatError::forbidden("You do not have access to this call"));
        }
        let call_ports = request_ports.ports(&state);
        let declined =
            ring::decline_ringing_call(&db, &call_ports, &claims.org, &call, &claims.user).await?;
        Ok(Data(json!({ "ok": true, "declined": declined })).into_response())
    };
    answer(result.await, "Failed to decline call")
}
