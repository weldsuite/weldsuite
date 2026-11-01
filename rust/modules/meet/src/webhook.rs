//! `RealtimeKit`'s webhook (`routes/webhooks-cloudflare-realtime/index.ts`,
//! `services/rtk-webhook.ts`), served ahead of the session at
//! `/api/webhooks/cloudflare-realtime`: `POST /` verifies each delivery's
//! `rtk-signature` (RSA-SHA256 over the raw body, `RealtimeKit`'s published
//! key) and drops repeats by `rtk-uuid`; `POST /setup` and
//! `POST /backfill-recordings` are operator-only.
//!
//! The session events (`meeting.ended`, `meeting.participantJoined`,
//! `meeting.participantLeft`) and the post-meeting ones of `RealtimeKit`'s
//! recorder (`recording.statusUpdate`, `meeting.transcript`,
//! `meeting.summary`) are handled as the worker handles them. A mapping of
//! type `call` belongs to a WeldChat call, which the Kubernetes editions
//! don't have (`chat-calls` is unavailable there): it is acknowledged and
//! nothing is done. The `LiveKit` equivalent is `crate::livekit_webhook`.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::MEETING_SESSION_UPDATED;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_video_rooms::WebhookRegistration;

use crate::js::{iso_of_ms, now_ms, origin_for_path_from, parse_ms, present, request_origin, text};
use crate::lifecycle::{self, EndIfEmpty, Env};
use crate::recording::patch_session;
use crate::{MeetState, RequestParts, publish_system};

const WEBHOOK_PATH: &str = "/api/webhooks/cloudflare-realtime";
/// `RTK_WEBHOOK_PUBLIC_KEY_URL`.
const PUBLIC_KEY_URL: &str = "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
/// `DELIVERY_DEDUPE_TTL_SECONDS`.
const DEDUPE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;
/// `BACKFILL_SESSIONS_PER_RUN`.
const BACKFILL_PER_RUN: i64 = 400;
/// `PARTICIPANT_WRITE_ATTEMPTS`.
const WRITE_ATTEMPTS: usize = 3;
/// `WEBHOOK_EVENTS`: what `POST /setup` registers.
const WEBHOOK_EVENTS: &[&str] = &[
    "meeting.ended",
    "meeting.participantJoined",
    "meeting.participantLeft",
    "recording.statusUpdate",
    "meeting.transcript",
    "meeting.summary",
];

pub(crate) fn routes() -> Router<MeetState> {
    Router::new()
        .route("/", post(receive))
        .route("/setup", post(setup))
        .route("/backfill-recordings", post(backfill))
}

fn json_answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn ok() -> Response {
    json_answer(StatusCode::OK, json!({ "ok": true }))
}

// ============================================================================
// Signature
// ============================================================================

/// The public key, cached an hour (`cachedKey`): its SPKI DER and when it
/// was fetched.
static KEY: Mutex<Option<(Vec<u8>, Instant)>> = Mutex::new(None);
const KEY_TTL: Duration = Duration::from_secs(60 * 60);
const MIN_REFETCH: Duration = Duration::from_secs(60);

/// `RtkWebhookKeyUnavailableError`.
struct KeyUnavailable(String);

/// `pemToSpki(pem)`.
fn pem_to_spki(pem: &str) -> Option<Vec<u8>> {
    let b64: String = pem
        .replace("\\n", "")
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .split_whitespace()
        .collect();
    STANDARD.decode(b64).ok()
}

async fn fetch_key(parts: &RequestParts, state: &MeetState) -> Result<Vec<u8>, KeyUnavailable> {
    let http = parts.http(state);
    let request = weldsuite_ports::HttpRequest::empty("GET", PUBLIC_KEY_URL);
    let response = http.send(request).await.map_err(|error| {
        KeyUnavailable(format!(
            "Could not fetch the RealtimeKit webhook public key: {error}"
        ))
    })?;
    if !response.ok() {
        return Err(KeyUnavailable(format!(
            "Could not fetch the RealtimeKit webhook public key: HTTP {}",
            response.status
        )));
    }
    let body = response.json();
    let pem = body["data"]["publicKey"]
        .as_str()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            KeyUnavailable("RealtimeKit webhook public key response carried no key".into())
        })?;
    pem_to_spki(pem)
        .ok_or_else(|| KeyUnavailable("Could not import the RealtimeKit webhook public key".into()))
}

async fn public_key(
    parts: &RequestParts,
    state: &MeetState,
    force: bool,
) -> Result<Vec<u8>, KeyUnavailable> {
    if !force {
        let cached = KEY.lock().unwrap_or_else(PoisonError::into_inner).clone();
        if let Some((key, at)) = cached
            && at.elapsed() < KEY_TTL
        {
            return Ok(key);
        }
    }
    let key = fetch_key(parts, state).await?;
    *KEY.lock().unwrap_or_else(PoisonError::into_inner) = Some((key.clone(), Instant::now()));
    Ok(key)
}

fn verify_with(key: &[u8], body: &[u8], signature: &[u8]) -> bool {
    use aws_lc_rs::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
    UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, key)
        .verify(body, signature)
        .is_ok()
}

/// `verifyRtkWebhookSignature(rawBody, signature)`.
async fn verify(
    parts: &RequestParts,
    state: &MeetState,
    body: &[u8],
    signature: Option<&str>,
) -> Result<bool, KeyUnavailable> {
    let Some(signature) = signature.filter(|s| !s.is_empty()) else {
        return Ok(false);
    };
    let Ok(signature) = STANDARD.decode(signature.trim()) else {
        return Ok(false);
    };
    if signature.is_empty() {
        return Ok(false);
    }
    if verify_with(&public_key(parts, state, false).await?, body, &signature) {
        return Ok(true);
    }
    let stale = KEY
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .is_some_and(|(_, at)| at.elapsed() >= MIN_REFETCH);
    if stale {
        return Ok(verify_with(
            &public_key(parts, state, true).await?,
            body,
            &signature,
        ));
    }
    Ok(false)
}

// ============================================================================
// Mappings
// ============================================================================

/// `RtkMeetingMapping`.
#[derive(Debug, Clone)]
pub(crate) struct Mapping {
    pub(crate) org_id: String,
    /// `session` or `call`.
    pub(crate) kind: String,
    pub(crate) session_id: Option<String>,
    pub(crate) meeting_id: Option<String>,
}

impl Mapping {
    fn of(value: &Value, kind: Option<&str>) -> Option<Self> {
        let object = value.as_object()?;
        let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            org_id: field("orgId").unwrap_or_default(),
            kind: kind
                .map(str::to_owned)
                .or_else(|| field("type"))
                .unwrap_or_default(),
            session_id: field("sessionId"),
            meeting_id: field("meetingId"),
        })
    }

    fn session(&self) -> Option<&str> {
        (self.kind == "session")
            .then_some(self.session_id.as_deref())
            .flatten()
            .filter(|s| !s.is_empty())
    }
}

/// `KV.get(key, 'json')`: `Err` when the stored value is not JSON (the
/// worker's `JSON.parse` throws).
async fn cache_json(
    parts: &RequestParts,
    state: &MeetState,
    key: &str,
) -> Result<Option<Value>, String> {
    let Some(cache) = parts.cache(state) else {
        return Err("Cannot read properties of undefined (reading 'get')".into());
    };
    match cache.get_boxed(key).await.map_err(|e| e.to_string())? {
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// `rtkMeetingIdCandidates(event)`.
fn candidates(event: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in [
        event.pointer("/meeting/id"),
        event.pointer("/recording/meetingId"),
        event.get("meetingId"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .filter(|id| !id.is_empty())
    {
        if !out.iter().any(|known| known == id) {
            out.push(id.to_owned());
        }
    }
    out
}

/// `resolvePostMeetingMapping(env, event)`.
async fn post_meeting_mapping(
    parts: &RequestParts,
    state: &MeetState,
    event: &Value,
) -> Result<Option<Mapping>, String> {
    let ids = candidates(event);
    for id in &ids {
        if let Some(durable) = cache_json(parts, state, &format!("rtk-session:{id}")).await?
            && crate::js::truthy(durable.get("sessionId"))
        {
            return Ok(Mapping::of(&durable, Some("session")));
        }
    }
    for id in &ids {
        if let Some(live) = cache_json(parts, state, &format!("rtk-meeting:{id}")).await?
            && text(&live, "type") == Some("session")
            && crate::js::truthy(live.get("sessionId"))
        {
            return Ok(Mapping::of(&live, None));
        }
    }
    Ok(None)
}

// ============================================================================
// POST /
// ============================================================================

async fn receive(State(state): State<MeetState>, request: axum::extract::Request) -> Response {
    let (parts, body) = request.into_parts();
    let request_parts = RequestParts::of(&parts);
    let Ok(body) = axum::body::to_bytes(body, usize::MAX).await else {
        return ok();
    };
    let signature = parts
        .headers
        .get("rtk-signature")
        .and_then(|v| v.to_str().ok());
    match verify(&request_parts, &state, &body, signature).await {
        Ok(true) => {}
        Ok(false) => {
            tracing::warn!("[RTK Webhook] Rejected: missing/invalid rtk-signature");
            return json_answer(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
        }
        Err(KeyUnavailable(message)) => {
            tracing::error!("[RTK Webhook] Signature key unavailable: {message}");
            return json_answer(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "error": "signature key unavailable" }),
            );
        }
    }
    let delivery = parts
        .headers
        .get("rtk-uuid")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if let Err(error) = handle(&state, &request_parts, &body, delivery.as_deref()).await {
        tracing::error!("[RTK Webhook] Error processing event: {error}");
    }
    ok()
}

/// The body of `POST /` after the signature: errors are logged and the
/// delivery still answers 200, so `RealtimeKit` does not retry.
async fn handle(
    state: &MeetState,
    parts: &RequestParts,
    body: &[u8],
    delivery: Option<&str>,
) -> Result<(), String> {
    let event: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let event_type = event
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // `event.meeting?.id ?? event.recording?.meetingId ?? event.meetingId`.
    let room = present(event.pointer("/meeting/id"))
        .or_else(|| present(event.pointer("/recording/meetingId")))
        .or_else(|| present(event.get("meetingId")))
        .cloned();
    let Some(room) = room.filter(|r| crate::js::truthy(Some(r))) else {
        tracing::warn!("[RTK Webhook] No meeting id in payload");
        return Ok(());
    };
    let room = match room {
        Value::String(text) => text,
        other => other.to_string(),
    };
    let dedupe_key = delivery
        .filter(|id| {
            (1..=128).contains(&id.len())
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .map(|id| format!("rtk-webhook-delivery:{id}"));
    let cache = parts.cache(state);
    if let Some(key) = &dedupe_key {
        let cache = cache
            .as_ref()
            .ok_or_else(|| "Cannot read properties of undefined (reading 'get')".to_owned())?;
        if cache
            .get_boxed(key)
            .await
            .map_err(|e| e.to_string())?
            .is_some_and(|v| !v.is_empty())
        {
            return Ok(());
        }
    }
    let remember = || async {
        if let (Some(key), Some(cache)) = (&dedupe_key, &cache) {
            cache
                .put_boxed(key, "1", Some(Duration::from_secs(DEDUPE_TTL_SECONDS)))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    };

    if matches!(
        event_type.as_str(),
        "recording.statusUpdate" | "meeting.transcript" | "meeting.summary"
    ) {
        let Some(mapping) = post_meeting_mapping(parts, state, &event).await? else {
            return Ok(());
        };
        match event_type.as_str() {
            "recording.statusUpdate" => {
                handle_recording_status(state, parts, None, &mapping, &event).await?;
            }
            "meeting.transcript" => {
                post_meeting_ai(state, parts, &mapping, &event, "transcript").await?;
            }
            _ => post_meeting_ai(state, parts, &mapping, &event, "summary").await?,
        }
        return remember().await;
    }

    let Some(mapping) = cache_json(parts, state, &format!("rtk-meeting:{room}"))
        .await?
        .and_then(|raw| Mapping::of(&raw, None))
    else {
        return Ok(());
    };
    match event_type.as_str() {
        "meeting.ended" => meeting_ended(state, parts, &mapping, &room).await?,
        "meeting.participantJoined" => {
            let ids = Joined {
                custom_id: event
                    .pointer("/participant/customParticipantId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                peer_id: event
                    .pointer("/participant/peerId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            };
            participant_joined(state, parts, &mapping, &ids).await?;
        }
        "meeting.participantLeft" => {
            let field = |key: &str| {
                event
                    .pointer(&format!("/participant/{key}"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            let ids = Left {
                cf_session_id: field("id"),
                custom_id: field("customParticipantId"),
                left_at: field("leftAt"),
                peer_id: field("peerId"),
                peer_joined_at: field("joinedAt"),
            };
            participant_left(state, parts, &mapping, &ids).await?;
        }
        _ => {}
    }
    remember().await
}

/// The lifecycle's view of a webhook delivery.
fn lifecycle_env(state: &MeetState, parts: &RequestParts) -> Env {
    Env {
        video: parts.video(state),
        cache: parts.cache(state),
    }
}

/// `handleMeetingEnded(env, mapping, rtkMeetingId)`, shared with `LiveKit`'s
/// `room_finished`.
pub(crate) async fn meeting_ended(
    state: &MeetState,
    parts: &RequestParts,
    mapping: &Mapping,
    room: &str,
) -> Result<(), String> {
    let db = parts.tenant(state, &mapping.org_id).await?;
    let (Some(session_id), Some(meeting_id)) = (
        mapping.session(),
        mapping.meeting_id.as_deref().filter(|m| !m.is_empty()),
    ) else {
        // A WeldChat call's room: no calls on Kubernetes (see the module docs).
        return Ok(());
    };
    let Some(session) = lifecycle::session_row(&db, session_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    if text(&session, "status") == Some("ended") {
        return Ok(());
    }
    let env = lifecycle_env(state, parts);
    let outcome = lifecycle::end_session_if_empty(
        state,
        &env,
        &db,
        &mapping.org_id,
        session_id,
        &session,
        meeting_id,
    )
    .await
    .map_err(|e| e.to_string())?;
    match outcome {
        EndIfEmpty::Occupied => {
            tracing::info!(
                "[RTK Webhook] meeting.ended for {room} ignored: the room has live participants"
            );
        }
        EndIfEmpty::Unknown => {
            lifecycle::end_session(
                state,
                &env,
                &db,
                &mapping.org_id,
                session_id,
                &session,
                meeting_id,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        EndIfEmpty::Ended => {}
    }
    Ok(())
}

// ============================================================================
// Presence
// ============================================================================

/// `LeftParticipantIds`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Left {
    pub(crate) cf_session_id: Option<String>,
    pub(crate) custom_id: Option<String>,
    pub(crate) left_at: Option<String>,
    pub(crate) peer_id: Option<String>,
    pub(crate) peer_joined_at: Option<String>,
}

/// `JoinedParticipantIds`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Joined {
    pub(crate) custom_id: Option<String>,
    pub(crate) peer_id: Option<String>,
}

fn non_empty(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// `matchesParticipant(p, ids)`.
fn matches(p: &Value, cf_session_id: Option<&str>, custom_id: Option<&str>) -> bool {
    cf_session_id.is_some_and(|cf| text(p, "cfSessionId") == Some(cf))
        || custom_id.is_some_and(|custom| text(p, "userId") == Some(custom))
}

fn peer_ids(p: &Value) -> Vec<String> {
    p.get("peerIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `withPeerIds(participant, peerIds)`.
fn with_peer_ids(p: &Value, ids: Vec<String>) -> Value {
    let mut next = p.as_object().cloned().unwrap_or_default();
    if ids.is_empty() {
        next.remove("peerIds");
    } else {
        next.insert("peerIds".into(), json!(ids));
    }
    Value::Object(next)
}

/// `findLeavingParticipant(participants, ids)`.
fn find_leaving(participants: &[Value], ids: &Left) -> Option<usize> {
    let cf = non_empty(ids.cf_session_id.as_ref());
    let custom = non_empty(ids.custom_id.as_ref());
    let index = participants
        .iter()
        .position(|p| !crate::js::truthy(p.get("leftAt")) && matches(p, cf, custom))?;
    let entry = &participants[index];
    let left = ids.left_at.as_deref().and_then(parse_ms);
    let joined = text(entry, "joinedAt").and_then(parse_ms);
    if let (Some(left), Some(joined)) = (left, joined)
        && left < joined
    {
        return None;
    }
    let peer_joined = ids.peer_joined_at.as_deref().and_then(parse_ms);
    let last_join = text(entry, "lastJoinAt").and_then(parse_ms);
    if let (Some(peer), Some(last)) = (peer_joined, last_join)
        && peer < last
    {
        return None;
    }
    Some(index)
}

/// `applyParticipantLeft(participants, ids, leftAtIso)`:
/// `(participants, changed, markedLeft)`.
pub(crate) fn apply_left(
    participants: &[Value],
    ids: &Left,
    left_at: &str,
) -> (Vec<Value>, bool, bool) {
    let mut next = participants.to_vec();
    let mut changed = false;
    let cf = non_empty(ids.cf_session_id.as_ref());
    let custom = non_empty(ids.custom_id.as_ref());
    if let Some(peer) = non_empty(ids.peer_id.as_ref()) {
        for p in &mut next {
            let known = peer_ids(p);
            if !known.iter().any(|id| id == peer) || !matches(p, cf, custom) {
                continue;
            }
            *p = with_peer_ids(p, known.into_iter().filter(|id| id != peer).collect());
            changed = true;
        }
    }
    let Some(index) = find_leaving(&next, ids) else {
        return (next, changed, false);
    };
    if !peer_ids(&next[index]).is_empty() {
        return (next, changed, false);
    }
    if let Some(entry) = next[index].as_object_mut() {
        entry.insert("leftAt".into(), json!(left_at));
    }
    (next, true, true)
}

/// `applyParticipantJoined(participants, ids)`: `(participants, changed, restored)`.
pub(crate) fn apply_joined(participants: &[Value], ids: &Joined) -> (Vec<Value>, bool, bool) {
    let mut next = participants.to_vec();
    let custom = non_empty(ids.custom_id.as_ref());
    let Some(index) = next
        .iter()
        .position(|p| custom.is_some_and(|c| text(p, "userId") == Some(c)))
    else {
        return (next, false, false);
    };
    let entry = &next[index];
    let known = peer_ids(entry);
    let peer = non_empty(ids.peer_id.as_ref());
    let tracked = peer.is_none_or(|peer| known.iter().any(|id| id == peer));
    let restored = crate::js::truthy(entry.get("leftAt"));
    if tracked && !restored {
        return (next, false, false);
    }
    let ids_after = match peer {
        Some(peer) if !tracked => {
            let mut all = known;
            all.push(peer.to_owned());
            all
        }
        _ => known,
    };
    let mut updated = with_peer_ids(entry, ids_after);
    if let Some(object) = updated.as_object_mut() {
        object.remove("leftAt");
    }
    next[index] = updated;
    (next, true, restored)
}

/// `updateSessionParticipants(db, sessionId, change)`: a conditional write
/// (only while the list is the one read), retried on a fresh read. The
/// session as read and the change's flag, or `None`.
async fn update_participants(
    db: &PgPool,
    session_id: &str,
    change: impl Fn(&[Value]) -> (Vec<Value>, bool, bool),
) -> Result<Option<(Value, Vec<Value>, bool)>, String> {
    for _ in 0..WRITE_ATTEMPTS {
        let Some(session) = lifecycle::session_row(db, session_id)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        if text(&session, "status") == Some("ended") {
            return Ok(None);
        }
        let current = session["participants"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let (participants, changed, flag) = change(&current);
        if !changed {
            return Ok(None);
        }
        let written: Option<String> = sqlx::query_scalar(
            "update meeting_sessions set participants = $2, updated_at = $3::timestamp
             where id = $1 and status <> 'ended' and participants = $4::jsonb returning id",
        )
        .bind(session_id)
        .bind(Value::Array(participants.clone()))
        .bind(crate::now())
        .bind(Value::Array(current).to_string())
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
        if written.is_some() {
            return Ok(Some((session, participants, flag)));
        }
    }
    tracing::warn!(
        "[RTK Webhook] Participant update for session {session_id} kept losing the race, skipped"
    );
    Ok(None)
}

/// `publishSessionParticipantsChanged`: the session row with the new list.
fn publish_participants(state: &MeetState, org: &str, session: &Value, participants: Vec<Value>) {
    let mut data = session.clone();
    data["participants"] = Value::Array(participants);
    let id = text(session, "id").unwrap_or_default().to_owned();
    publish_system(state, org, "system", MEETING_SESSION_UPDATED, &id, data);
}

/// `handleParticipantLeft(env, mapping, event)`.
pub(crate) async fn participant_left(
    state: &MeetState,
    parts: &RequestParts,
    mapping: &Mapping,
    ids: &Left,
) -> Result<(), String> {
    let db = parts.tenant(state, &mapping.org_id).await?;
    if non_empty(ids.cf_session_id.as_ref()).is_none()
        && non_empty(ids.custom_id.as_ref()).is_none()
    {
        return Ok(());
    }
    let Some(session_id) = mapping.session() else {
        // A WeldChat call: none on Kubernetes.
        return Ok(());
    };
    let left_at = crate::now();
    let written = update_participants(&db, session_id, |participants| {
        apply_left(participants, ids, &left_at)
    })
    .await?;
    if let Some((session, participants, true)) = written {
        publish_participants(state, &mapping.org_id, &session, participants);
    }
    Ok(())
}

/// `handleParticipantJoined(env, mapping, event)`.
pub(crate) async fn participant_joined(
    state: &MeetState,
    parts: &RequestParts,
    mapping: &Mapping,
    ids: &Joined,
) -> Result<(), String> {
    let Some(session_id) = mapping.session() else {
        return Ok(());
    };
    if non_empty(ids.custom_id.as_ref()).is_none() {
        return Ok(());
    }
    let db = parts.tenant(state, &mapping.org_id).await?;
    let written = update_participants(&db, session_id, |participants| {
        apply_joined(participants, ids)
    })
    .await?;
    if let Some((session, participants, true)) = written {
        publish_participants(state, &mapping.org_id, &session, participants);
    }
    Ok(())
}

// ============================================================================
// Post-meeting events
// ============================================================================

/// `toNumber(value)`.
fn to_number(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map(|_| Value::Number(n.clone())),
        Value::String(text) if !text.trim().is_empty() => {
            let number = weldsuite_kit::validation::js_number(text);
            number
                .is_finite()
                .then(|| crate::billing::js_number(number))
        }
        _ => None,
    }
}

/// `partStatusFor(rtkStatus)`.
fn part_status(rtk: &str) -> Option<&'static str> {
    match rtk {
        "INVOKED" | "RECORDING" => Some("recording"),
        "UPLOADING" | "UPLOADED" => Some("processing"),
        "ERRORED" => Some("failed"),
        _ => None,
    }
}

/// `upsertRecordingPart(parts, part)`: replaced or added, sorted by start.
fn upsert_part(parts: &Value, part: &Map<String, Value>) -> Vec<Value> {
    let mut next: Vec<Value> = parts.as_array().cloned().unwrap_or_default();
    let id = part.get("rtkRecordingId");
    if let Some(existing) = next.iter_mut().find(|p| p.get("rtkRecordingId") == id) {
        let mut merged = existing.as_object().cloned().unwrap_or_default();
        for (key, value) in part {
            merged.insert(key.clone(), value.clone());
        }
        *existing = Value::Object(merged);
    } else {
        next.push(Value::Object(part.clone()));
    }
    next.sort_by(|a, b| {
        text(a, "startedAt")
            .unwrap_or_default()
            .cmp(text(b, "startedAt").unwrap_or_default())
    });
    next
}

/// `deriveRecordingStatus(parts)`.
fn derive_status(parts: &[Value]) -> Option<&'static str> {
    if parts.is_empty() {
        return None;
    }
    let has = |status: &str| parts.iter().any(|p| text(p, "status") == Some(status));
    Some(if has("recording") {
        "recording"
    } else if has("processing") {
        "processing"
    } else if has("ready") {
        "ready"
    } else {
        "failed"
    })
}

/// `recordingPatchFromParts(parts)`.
fn patch_from_parts(parts: &[Value]) -> Vec<(&'static str, Value)> {
    let status = derive_status(parts);
    let ready: Vec<&Value> = parts
        .iter()
        .filter(|p| text(p, "status") == Some("ready"))
        .collect();
    let latest = ready.last();
    let field = |key: &str| {
        latest
            .and_then(|p| p.get(key))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null)
    };
    let duration = latest
        .and_then(|p| p.get("durationSeconds"))
        .and_then(Value::as_f64)
        .map_or(Value::Null, |d| {
            #[allow(clippy::cast_possible_truncation)]
            let rounded = (d + 0.5).floor() as i64;
            json!(rounded)
        });
    let mut patch = vec![
        ("recordingParts", Value::Array(parts.to_vec())),
        ("recordingStatus", json!(status)),
        ("recordingEnabled", json!(status == Some("recording"))),
        ("recordingRtkId", field("rtkRecordingId")),
        ("recordingVideoKey", field("videoKey")),
        ("recordingAudioKey", field("audioKey")),
        ("recordingSizeBytes", field("sizeBytes")),
        ("recordingDurationSeconds", duration),
    ];
    if status == Some("ready") {
        patch.push(("recordingReadyAt", json!(crate::now())));
    }
    patch
}

/// `startWorkflow(binding, label, id, params)`: a missing binding skips, a
/// repeated id is not an error.
async fn start_workflow(
    binding: Option<std::sync::Arc<dyn crate::MeetWorkflow>>,
    label: &str,
    id: &str,
    params: &Value,
) -> Result<(), String> {
    let Some(binding) = binding else {
        tracing::warn!("[RTK Webhook] {label} binding not configured, skipping dispatch of {id}");
        return Ok(());
    };
    match binding.create(id, params).await {
        Ok(()) => Ok(()),
        Err(message) => {
            let lower = message.to_lowercase();
            let repeat = has_words(&lower, "already", "exist")
                || lower.contains("duplicate")
                || has_words(&lower, "id", "conflict");
            if repeat {
                tracing::info!("[RTK Webhook] {label} {id} already running, skipping");
                return Ok(());
            }
            Err(message)
        }
    }
}

/// `/<a>[\s_.]*<b>/` on lower-cased text.
fn has_words(text: &str, a: &str, b: &str) -> bool {
    text.match_indices(a).any(|(at, _)| {
        let rest = text[at + a.len()..]
            .trim_start_matches(|c: char| c.is_whitespace() || c == '_' || c == '.');
        rest.starts_with(b)
    })
}

/// A provider recording as the `recording.statusUpdate` payload the handler
/// reads (`recordingStatusEvent`).
pub(crate) fn recording_status_event(room: &str, recording: &Value) -> Value {
    let field = |key: &str| recording.get(key).cloned();
    let mut meeting = Map::new();
    meeting.insert("id".into(), json!(room));
    if let Some(session) = field("session_id") {
        meeting.insert("sessionId".into(), session);
    }
    let mut rec = Map::new();
    for (to, from) in [
        ("id", "id"),
        ("status", "status"),
        ("fileSize", "file_size"),
        ("recordingDuration", "recording_duration"),
        ("startedTime", "started_time"),
        ("stoppedTime", "stopped_time"),
        ("outputFileName", "output_file_name"),
    ] {
        if let Some(value) = field(from) {
            rec.insert(to.into(), value);
        }
    }
    json!({ "event": "recording.statusUpdate", "meeting": meeting, "recording": rec })
}

/// `handleRecordingStatus(env, mapping, event)`: the session's parts in step
/// with the provider; on `UPLOADED` the copy into the private bucket starts.
/// `db` is the tenant database when the caller has it already.
pub(crate) async fn handle_recording_status(
    state: &MeetState,
    parts: &RequestParts,
    db: Option<&PgPool>,
    mapping: &Mapping,
    event: &Value,
) -> Result<(), String> {
    let Some(session_id) = mapping.session() else {
        return Ok(());
    };
    let rec = event.get("recording");
    let recording_id = rec
        .and_then(|r| present(r.get("id")).or_else(|| present(r.get("recordingId"))))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let rtk_status = rec
        .and_then(|r| r.get("status"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_uppercase);
    let (Some(recording_id), Some(rtk_status)) = (recording_id, rtk_status) else {
        tracing::warn!("[RTK Webhook] recording.statusUpdate without recording id/status");
        return Ok(());
    };
    let Some(next) = part_status(&rtk_status) else {
        return Ok(());
    };
    let db = match db {
        Some(db) => db.clone(),
        None => parts.tenant(state, &mapping.org_id).await?,
    };
    let Some(session) = lifecycle::session_row(&db, session_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let existing = session["recordingParts"]
        .as_array()
        .and_then(|all| {
            all.iter()
                .find(|p| text(p, "rtkRecordingId") == Some(recording_id.as_str()))
        })
        .cloned();
    let existing_status = existing.as_ref().and_then(|e| text(e, "status"));
    if existing_status == Some("ready") {
        return Ok(());
    }
    if existing.is_none()
        && text(&session, "recordingStatus") == Some("deleted")
        && next != "recording"
    {
        return Ok(());
    }
    if existing_status == Some("processing") && next == "recording" {
        return Ok(());
    }
    let old = |key: &str| {
        existing
            .as_ref()
            .and_then(|e| e.get(key))
            .filter(|v| !v.is_null())
            .cloned()
    };
    let rec_field = |key: &str| rec.and_then(|r| present(r.get(key))).cloned();
    let mut part = Map::new();
    part.insert("rtkRecordingId".into(), json!(recording_id));
    part.insert("videoKey".into(), old("videoKey").unwrap_or(Value::Null));
    part.insert("audioKey".into(), old("audioKey").unwrap_or(Value::Null));
    part.insert(
        "sizeBytes".into(),
        to_number(rec.and_then(|r| r.get("fileSize")))
            .or_else(|| old("sizeBytes"))
            .unwrap_or(Value::Null),
    );
    part.insert(
        "durationSeconds".into(),
        to_number(rec.and_then(|r| r.get("recordingDuration")))
            .or_else(|| old("durationSeconds"))
            .unwrap_or(Value::Null),
    );
    part.insert(
        "startedAt".into(),
        rec_field("startedTime")
            .or_else(|| old("startedAt"))
            .unwrap_or(Value::Null),
    );
    part.insert(
        "stoppedAt".into(),
        rec_field("stoppedTime")
            .or_else(|| old("stoppedAt"))
            .unwrap_or(Value::Null),
    );
    part.insert("status".into(), json!(next));
    let all = upsert_part(&session["recordingParts"], &part);
    let rtk_session = present(event.pointer("/meeting/sessionId"))
        .or_else(|| present(event.get("sessionId")))
        .cloned();
    let mut patch = patch_from_parts(&all);
    patch.push((
        "recordingError",
        if next == "failed" {
            json!(format!(
                "RealtimeKit reported the recording as {rtk_status}"
            ))
        } else {
            Value::Null
        },
    ));
    if let Some(rtk_session) = rtk_session.filter(|r| crate::js::truthy(Some(r)))
        && !crate::js::truthy(session.get("rtkSessionId"))
    {
        patch.push(("rtkSessionId", rtk_session));
    }
    patch_session(&db, session_id, &patch)
        .await
        .map_err(|e| e.to_string())?;

    if rtk_status == "UPLOADED" {
        let params = json!({
            "orgId": mapping.org_id,
            "sessionId": session_id,
            "rtkRecordingId": recording_id,
            "startedAt": part["startedAt"],
            "stoppedAt": part["stoppedAt"],
            "durationSeconds": part["durationSeconds"],
        });
        let copy = parts.workflows(state).copy;
        if let Err(error) = start_workflow(
            copy,
            "MEETING_RECORDING_COPY",
            &format!("rec-{recording_id}"),
            &params,
        )
        .await
        {
            let message = format!("Could not start the recording copy: {error}");
            let mut failed = part.clone();
            failed.insert("status".into(), json!("failed"));
            let all = upsert_part(&Value::Array(all.clone()), &failed);
            let mut patch = patch_from_parts(&all);
            patch.push(("recordingError", json!(message)));
            patch_session(&db, session_id, &patch)
                .await
                .map_err(|e| e.to_string())?;
            tracing::error!("[RTK Webhook] {message}");
        }
    }
    let status = lifecycle::session_row(&db, session_id)
        .await
        .map_err(|e| e.to_string())?
        .map_or(Value::Null, |s| s["recordingStatus"].clone());
    publish_system(
        state,
        &mapping.org_id,
        "system",
        MEETING_SESSION_UPDATED,
        session_id,
        json!({
            "id": session["id"],
            "meetingId": session["meetingId"],
            "status": session["status"],
            "recordingStatus": status,
        }),
    );
    Ok(())
}

/// `handleMeetingTranscript` / `handleMeetingSummary`: hand the expiring
/// download URL to the AI workflow (never downloaded here).
async fn post_meeting_ai(
    state: &MeetState,
    parts: &RequestParts,
    mapping: &Mapping,
    event: &Value,
    what: &str,
) -> Result<(), String> {
    let Some(session_id) = mapping.session() else {
        return Ok(());
    };
    let db = parts.tenant(state, &mapping.org_id).await?;
    let Some(session) = lifecycle::session_row(&db, session_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let rtk_session = present(event.pointer("/meeting/sessionId"))
        .or_else(|| present(event.get("sessionId")))
        .or_else(|| present(session.get("rtkSessionId")))
        .cloned()
        .unwrap_or(Value::Null);
    if crate::js::truthy(Some(&rtk_session)) && session.get("rtkSessionId") != Some(&rtk_session) {
        patch_session(&db, session_id, &[("rtkSessionId", rtk_session.clone())])
            .await
            .map_err(|e| e.to_string())?;
    }
    let (kind, url_key) = if what == "transcript" {
        ("ingest-rtk-transcript", "transcriptDownloadUrl")
    } else {
        ("ingest-rtk-summary", "summaryDownloadUrl")
    };
    let params = json!({
        "kind": kind,
        "orgId": mapping.org_id,
        "sessionId": session["id"],
        "rtkSessionId": rtk_session,
        "downloadUrl": present(event.get(url_key)).cloned().unwrap_or(Value::Null),
    });
    let ai = parts.workflows(state).ai;
    start_workflow(
        ai,
        "MEETING_AI",
        &format!("rtk-{what}-{session_id}"),
        &params,
    )
    .await
}

// ============================================================================
// Operator routes
// ============================================================================

/// Constant-time string equality (`timingSafeEqualStr`).
fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `rejectNonOperator(c, label)`: the 401, or `None` for the operator.
fn reject_non_operator(parts: &RequestParts, headers: &HeaderMap) -> Option<Response> {
    let unauthorized = || json_answer(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    let Some(token) = parts.env("CF_REALTIME_WEBHOOK_TOKEN") else {
        return Some(unauthorized());
    };
    let auth = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let provided = auth.strip_prefix("Bearer ").unwrap_or("");
    if !timing_safe_eq(provided, &token) {
        return Some(unauthorized());
    }
    None
}

async fn setup(State(state): State<MeetState>, request: axum::extract::Request) -> Response {
    let (parts, _) = request.into_parts();
    let request_parts = RequestParts::of(&parts);
    if let Some(rejected) = reject_non_operator(&request_parts, &parts.headers) {
        return rejected;
    }
    let configured = [
        "CF_ACCOUNT_ID",
        "CF_REALTIME_APP_ID",
        "CF_REALTIME_APP_SECRET",
    ]
    .iter()
    .all(|name| request_parts.env(name).is_some());
    if !configured {
        return json_answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Missing CF_ACCOUNT_ID, CF_REALTIME_APP_ID, or CF_REALTIME_APP_SECRET" }),
        );
    }
    let environment = request_parts
        .env("ENVIRONMENT")
        .unwrap_or_else(|| "development".to_owned());
    let core = match environment.as_str() {
        "production" => Some("https://app-api.weldsuite.org"),
        "preview" | "test" => Some("https://app-api-test.weldsuite.org"),
        _ => None,
    };
    let base = match core {
        Some(core) => origin_for_path_from(core, WEBHOOK_PATH),
        None => request_origin(&parts.headers),
    };
    let url = format!("{base}{WEBHOOK_PATH}");
    let registration = WebhookRegistration {
        name: format!("WeldSuite meeting lifecycle ({environment})"),
        url: url.clone(),
        events: WEBHOOK_EVENTS.iter().map(|e| (*e).to_owned()).collect(),
        enabled: true,
    };
    let result = match request_parts
        .video(&state)
        .upsert_webhook(&registration)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            tracing::error!("[RTK Webhook Setup] Failed: {error}");
            return json_answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Failed to register webhook" }),
            );
        }
    };
    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    body.insert("url".into(), json!(url));
    if let Some(id) = result.id {
        body.insert("id".into(), json!(id));
    }
    body.insert("action".into(), json!(result.action));
    body.insert("removedDuplicates".into(), json!(result.removed_duplicates));
    body.insert("events".into(), json!(WEBHOOK_EVENTS));
    json_answer(StatusCode::OK, Value::Object(body))
}

/// `legacyRecordingCandidates(db, limit)`: how many sessions still carry
/// only a legacy recording marker (at most `limit`).
async fn legacy_candidates(db: &PgPool) -> Result<i64, sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select id from meeting_sessions
         where recording_status is null and (recording_url is not null or recording_key is not null)
         order by created_at asc limit $1",
    )
    .bind(BACKFILL_PER_RUN)
    .fetch_all(db)
    .await?;
    Ok(i64::try_from(ids.len()).unwrap_or(0))
}

async fn backfill(State(state): State<MeetState>, request: axum::extract::Request) -> Response {
    let (parts, body) = request.into_parts();
    let request_parts = RequestParts::of(&parts);
    if let Some(rejected) = reject_non_operator(&request_parts, &parts.headers) {
        return rejected;
    }
    let body = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();
    let raw = crate::optional_json(&body);
    let mut issues = Issues::default();
    let read = issues.object(&raw).map(|fields| {
        let org = issues
            .text_with(
                fields,
                "orgId",
                Presence::Optional,
                Text::length(Some(1), Some(100)),
            )
            .into_option();
        let dry = issues
            .boolean(fields, "dryRun", Presence::Optional)
            .into_option();
        (org, dry)
    });
    if let Err(invalid) = issues.finish() {
        return json_answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid body", "details": invalid.flatten() }),
        );
    }
    let (org, dry_run) = read.unwrap_or((None, None));
    let dry_run = dry_run.unwrap_or(false);
    let backfill = request_parts.workflows(&state).backfill;
    if !dry_run && backfill.is_none() {
        return json_answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "MEETING_RECORDING_BACKFILL binding is not configured" }),
        );
    }
    let orgs: Vec<String> = match org {
        Some(org) => vec![org],
        None => {
            let Some(master) = request_parts.master(&state) else {
                return weldsuite_kit::ApiError::internal().into_response();
            };
            let rows: Result<Vec<Option<String>>, sqlx::Error> =
                sqlx::query_scalar("select clerk_org_id from workspaces where is_active = true")
                    .fetch_all(&master)
                    .await;
            match rows {
                Ok(rows) => rows
                    .into_iter()
                    .flatten()
                    .filter(|o| !o.is_empty())
                    .collect(),
                Err(error) => {
                    tracing::error!(%error, "[RTK Webhook Backfill] workspace list failed");
                    return weldsuite_kit::ApiError::internal().into_response();
                }
            }
        }
    };
    let stamp = to_base36(now_ms());
    let mut results = Vec::new();
    let (mut candidates_total, mut dispatched, mut failed) = (0_i64, 0_i64, 0_i64);
    for org in &orgs {
        let mut result = Map::new();
        result.insert("orgId".into(), json!(org));
        result.insert("candidates".into(), json!(0));
        let outcome: Result<(), String> = async {
            let db = request_parts.tenant(&state, org).await?;
            let count = legacy_candidates(&db).await.map_err(|e| e.to_string())?;
            result.insert("candidates".into(), json!(count));
            candidates_total += count;
            if !dry_run
                && count > 0
                && let Some(binding) = &backfill
            {
                let prefix: String = org.chars().take(40).collect();
                let instance = format!("bf-{prefix}-{stamp}");
                binding.create(&instance, &json!({ "orgId": org })).await?;
                result.insert("instanceId".into(), json!(instance));
                dispatched += 1;
            }
            Ok(())
        }
        .await;
        if let Err(error) = outcome {
            tracing::error!("[RTK Webhook Backfill] {org} failed: {error}");
            result.insert("error".into(), json!(error));
            failed += 1;
        }
        results.push(Value::Object(result));
    }
    json_answer(
        StatusCode::OK,
        json!({
            "ok": true,
            "dryRun": dry_run,
            "workspaces": results.len(),
            "candidates": candidates_total,
            "dispatched": dispatched,
            "failed": failed,
            "perRunLimit": BACKFILL_PER_RUN,
            "results": results,
        }),
    )
}

/// `Date.now().toString(36)`.
fn to_base36(mut value: i64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value <= 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Unused outside tests: the ISO stamp of a millisecond time.
#[allow(dead_code)]
fn iso(ms: i64) -> String {
    iso_of_ms(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn left(cf: &str) -> Left {
        Left {
            cf_session_id: Some(cf.into()),
            ..Left::default()
        }
    }

    #[test]
    fn presence_follows_each_connection() {
        let participants = vec![json!({
            "userId": "u1", "cfSessionId": "cf1", "joinedAt": "2026-10-01T10:00:00.000Z", "peerIds": ["p1", "p2"],
        })];
        let ids = Left {
            peer_id: Some("p1".into()),
            ..left("cf1")
        };
        let (next, changed, marked) = apply_left(&participants, &ids, "2026-10-01T10:05:00.000Z");
        assert!(changed && !marked);
        assert_eq!(next[0]["peerIds"], json!(["p2"]));
        let ids = Left {
            peer_id: Some("p2".into()),
            ..left("cf1")
        };
        let (next, _, marked) = apply_left(&next, &ids, "2026-10-01T10:06:00.000Z");
        assert!(marked);
        assert_eq!(next[0]["leftAt"], "2026-10-01T10:06:00.000Z");
        assert!(next[0].get("peerIds").is_none());
        let (back, changed, restored) = apply_joined(
            &next,
            &Joined {
                custom_id: Some("u1".into()),
                peer_id: Some("p3".into()),
            },
        );
        assert!(changed && restored);
        assert!(back[0].get("leftAt").is_none());
        assert_eq!(back[0]["peerIds"], json!(["p3"]));
        // A leave stamped before the participant joined is an earlier stint's.
        let stale = Left {
            left_at: Some("2026-10-01T09:00:00.000Z".into()),
            ..left("cf1")
        };
        assert_eq!(find_leaving(&participants, &stale), None);
    }

    #[test]
    fn recording_parts_follow_the_provider() {
        assert_eq!(part_status("UPLOADED"), Some("processing"));
        assert_eq!(part_status("PAUSED"), None);
        let parts = upsert_part(
            &json!([{ "rtkRecordingId": "b", "startedAt": "2026-10-01T11:00:00Z", "status": "ready" }]),
            json!({ "rtkRecordingId": "a", "startedAt": "2026-10-01T10:00:00Z", "status": "recording" })
                .as_object()
                .expect("object"),
        );
        assert_eq!(parts[0]["rtkRecordingId"], "a");
        assert_eq!(derive_status(&parts), Some("recording"));
        assert!(has_words("instance.already_exists", "already", "exist"));
        assert!(has_words("id conflict", "id", "conflict"));
        assert!(!has_words("other", "id", "conflict"));
        assert_eq!(to_number(Some(&json!("12"))), Some(json!(12)));
        assert_eq!(to_number(Some(&json!("x"))), None);
        assert_eq!(to_number(Some(&json!(10.5))), Some(json!(10.5)));
    }

    #[test]
    fn verifies_rsa_signatures_against_an_spki_key() {
        use aws_lc_rs::encoding::AsDer;
        use aws_lc_rs::rsa::{KeyPair, KeySize};
        use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_SHA256};
        let pair = KeyPair::generate(KeySize::Rsa2048).expect("key");
        let body = br#"{"event":"meeting.ended"}"#;
        let mut signature = vec![0; pair.public_modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &aws_lc_rs::rand::SystemRandom::new(),
            body,
            &mut signature,
        )
        .expect("signs");
        let spki = pair.public_key().as_der().expect("der");
        assert!(verify_with(spki.as_ref(), body, &signature));
        assert!(!verify_with(spki.as_ref(), b"tampered", &signature));
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----",
            STANDARD.encode(spki.as_ref())
        );
        assert_eq!(pem_to_spki(&pem).as_deref(), Some(spki.as_ref()));
    }
}
