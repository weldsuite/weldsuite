//! WeldChat calls: what chat-api's call routes and the video provider's
//! webhooks share (`@weldsuite/chat-domain/call-lifecycle`,
//! `call-participants`, `dm-call-room` and the call half of
//! `realtime/weldchat-call-publisher`).
//!
//! - Ending a call ([`end_chat_call`]) marks the row over, tears the room
//!   down, posts the "Call ended" / "Missed call" notice, publishes, and for
//!   an unanswered DM call stops the ring and sends the missed-call push.
//!   Everything automatic goes through [`end_chat_call_if_empty`], which asks
//!   the video provider first: the participant list drifts, the provider
//!   knows who is connected.
//! - The participant list keeps every user once ([`upsert_participant`],
//!   [`dedupe_participants`]), and a user is in one live call at a time
//!   ([`leave_other_active_calls`]; WeldMeet's half is meet's).
//! - A DM keeps one room for all its calls ([`get_dm_call_room`]).
//!
//! A call row is read as Drizzle hands it back ([`call_row`]): camelCase
//! keys, ISO timestamps, `participants` a JSON array of `ChatCallParticipant`s
//! (`userId`, `userName`, `userAvatar?`, `joinedAt`, `leftAt?`,
//! `cfSessionId`, `hasAudio`, `hasVideo`, `hasScreenShare`).
//!
//! The room is the video provider's: a `RealtimeKit` meeting on Global and in
//! conformance, a `LiveKit` room on the Kubernetes editions. Its id is the
//! row's `cfAppId`, and a participant's `cfSessionId` is the provider's
//! participant id (on `LiveKit` the token's identity, `<userId>~<nonce>`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_notifications::{
    CallCancelReason, Notifier, cancel_incoming_call_push, chat as notify, create_and_deliver,
};
use weldsuite_ports::DynCache;
use weldsuite_ports::video_rooms::DynVideoRooms;

use crate::publish::{Realtime, object};

/// How long a DM call rings before it counts as missed (`RING_TIMEOUT_MS`).
pub const RING_TIMEOUT_MS: i64 = 25_000;

/// A ringing/active call older than this with nobody left in it is dead.
const STALE_CALL_MS: i64 = 60_000;

/// Refreshed on every call, so only a DM nobody called for this long loses
/// its room (`DM_CALL_ROOM_TTL_SECONDS`).
pub const DM_CALL_ROOM_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;

/// How long a room's webhook mapping (`rtk-meeting:<room>`) lives.
pub const ROOM_MAPPING_TTL_SECONDS: u64 = 86_400;

/// What the lifecycle reaches besides the database (`CallLifecycleEnv`).
#[derive(Clone)]
pub struct CallPorts {
    /// The video provider.
    pub video: Arc<dyn DynVideoRooms>,
    /// `WORKSPACE_CACHE`: the room mappings and the DM rooms.
    pub cache: Option<Arc<dyn DynCache>>,
    pub realtime: Realtime,
    /// The missed-call pushes and the ring cancels.
    pub notifier: Notifier,
}

impl std::fmt::Debug for CallPorts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallPorts")
            .field("cache", &self.cache.is_some())
            .field("realtime", &self.realtime)
            .finish_non_exhaustive()
    }
}

// ============================================================================
// Small JavaScript semantics
// ============================================================================

/// A string field, or `None`.
pub fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// JavaScript truthiness of a JSON field (`!!p.leftAt`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `new Date(text).getTime()` for the ISO timestamps calls carry
/// (`toISOString()`, Drizzle's dates, the providers' times); `None` where
/// JavaScript answers `NaN`.
pub fn parse_ms(text: &str) -> Option<i64> {
    let at = OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// The JSON field's time (`new Date(value).getTime()`), `None` when missing.
fn field_ms(value: &Value, key: &str) -> Option<i64> {
    text(value, key).and_then(parse_ms)
}

/// `Date.now()`.
pub fn now_ms() -> i64 {
    crate::publish::now_ms()
}

/// `new Date(ms).toISOString()`.
pub fn iso_of_ms(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// `Math.round(seconds)` for a positive or negative number.
#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn round_seconds(ms: i64) -> i64 {
    (ms as f64 / 1000.0 + 0.5).floor() as i64
}

// ============================================================================
// Rows and participants
// ============================================================================

/// The call row as Drizzle reads it, or `None`.
pub async fn call_row(db: &PgPool, call_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from chat_calls t where t.id = $1 limit 1")
            .bind(call_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `call.participants ?? []`.
pub fn participants_of(call: &Value) -> Vec<Value> {
    call.get("participants")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The call's room (`cfAppId`), when it has one.
pub fn room_of(call: &Value) -> Option<&str> {
    text(call, "cfAppId").filter(|room| !room.is_empty())
}

fn has_left(participant: &Value) -> bool {
    truthy(participant.get("leftAt"))
}

/// `wasAnswered(call)`: anyone other than the initiator has joined.
pub fn was_answered(call: &Value) -> bool {
    let initiator = text(call, "initiatorId");
    participants_of(call)
        .iter()
        .any(|p| text(p, "userId") != initiator && truthy(p.get("joinedAt")))
}

/// `pickBetter(a, b)`: an active entry beats a left one, else the most
/// recently joined.
fn pick_better(a: &Value, b: &Value) -> Value {
    let (a_active, b_active) = (!has_left(a), !has_left(b));
    if a_active != b_active {
        return if a_active { a.clone() } else { b.clone() };
    }
    match (field_ms(a, "joinedAt"), field_ms(b, "joinedAt")) {
        (Some(at), Some(bt)) if bt >= at => b.clone(),
        _ => a.clone(),
    }
}

/// `dedupeParticipants(participants)`: every `userId` at most once, in the
/// order each first appeared.
pub fn dedupe_participants(participants: &[Value]) -> Vec<Value> {
    let mut by_user: Vec<(Option<String>, Value)> = Vec::new();
    for p in participants {
        let user = text(p, "userId").map(str::to_owned);
        match by_user.iter_mut().find(|(key, _)| *key == user) {
            Some(entry) => entry.1 = pick_better(&entry.1, p),
            None => by_user.push((user, p.clone())),
        }
    }
    by_user.into_iter().map(|(_, p)| p).collect()
}

/// `activeParticipantCount(participants)`: distinct users not left.
pub fn active_participant_count(participants: &[Value]) -> usize {
    dedupe_participants(participants)
        .iter()
        .filter(|p| !has_left(p))
        .count()
}

/// `upsertParticipant(participants, participant)`: the list with the user's
/// entries replaced by `participant` (last), and the provider ids of their
/// previous live entries, to evict.
pub fn upsert_participant(participants: &[Value], participant: Value) -> (Vec<Value>, Vec<String>) {
    let user = text(&participant, "userId").map(str::to_owned);
    let session = text(&participant, "cfSessionId").map(str::to_owned);
    let mut stale = Vec::new();
    let mut next = Vec::new();
    for p in dedupe_participants(participants) {
        if text(&p, "userId").map(str::to_owned) == user {
            if let Some(old) = text(&p, "cfSessionId").filter(|old| !old.is_empty())
                && !has_left(&p)
                && Some(old) != session.as_deref()
            {
                stale.push(old.to_owned());
            }
            continue;
        }
        next.push(p);
    }
    next.push(participant);
    (next, stale)
}

/// A new participant entry (`ChatCallParticipant`), media flags off.
pub fn new_participant(
    user_id: &str,
    user_name: &str,
    user_avatar: Option<&str>,
    joined_at: &str,
    cf_session_id: &str,
) -> Value {
    let mut entry = Map::new();
    entry.insert("userId".into(), json!(user_id));
    entry.insert("userName".into(), json!(user_name));
    if let Some(avatar) = user_avatar {
        entry.insert("userAvatar".into(), json!(avatar));
    }
    entry.insert("joinedAt".into(), json!(joined_at));
    entry.insert("cfSessionId".into(), json!(cf_session_id));
    entry.insert("hasAudio".into(), json!(false));
    entry.insert("hasVideo".into(), json!(false));
    entry.insert("hasScreenShare".into(), json!(false));
    Value::Object(entry)
}

/// `isAbandonedCall(call, { isDm, requesterId, now })`: whether an existing
/// ringing/active call is dead and may be ended so a new one can start.
pub fn is_abandoned_call(call: &Value, is_dm: bool, requester_id: &str, now: i64) -> bool {
    let age = field_ms(call, "createdAt").map(|created| now - created);
    let older_than = |limit: i64| age.is_some_and(|age| age > limit);
    let active: Vec<Value> = dedupe_participants(&participants_of(call))
        .into_iter()
        .filter(|p| !has_left(p))
        .collect();
    if active.is_empty() && older_than(STALE_CALL_MS) {
        return true;
    }
    if text(call, "status") == Some("ringing") && older_than(STALE_CALL_MS) {
        return true;
    }
    if !is_dm {
        return false;
    }
    if active
        .iter()
        .all(|p| text(p, "userId") == Some(requester_id))
    {
        return true;
    }
    !was_answered(call) && older_than(RING_TIMEOUT_MS)
}

// ============================================================================
// Notices
// ============================================================================

/// `callNoticeMetadata(call)`: `metadata.call` on a call's started and ended
/// notices.
pub fn call_notice_metadata(
    call_id: &str,
    call_type: &str,
    event: &str,
    outcome: Option<&str>,
    duration: Option<i64>,
) -> Value {
    let mut call = Map::new();
    call.insert("callId".into(), json!(call_id));
    call.insert("callType".into(), json!(call_type));
    call.insert("event".into(), json!(event));
    if let Some(outcome) = outcome {
        call.insert("outcome".into(), json!(outcome));
    }
    if let Some(duration) = duration {
        call.insert("duration".into(), json!(duration));
    }
    json!({ "call": Value::Object(call) })
}

/// `formatDuration(seconds)`: `45s`, `3m`, `3m 12s`.
pub fn format_duration(seconds: i64) -> String {
    let (minutes, rest) = (seconds.div_euclid(60), seconds.rem_euclid(60));
    if minutes == 0 {
        format!("{rest}s")
    } else if rest > 0 {
        format!("{minutes}m {rest}s")
    } else {
        format!("{minutes}m")
    }
}

/// A system notice from the call's initiator (the call's started / ended
/// message). No realtime publish: the call events carry it.
#[allow(clippy::too_many_arguments)]
pub async fn insert_call_notice(
    db: &PgPool,
    id: &str,
    channel_id: &str,
    author_id: &str,
    author_name: &str,
    author_avatar: Option<&str>,
    content: &str,
    metadata: &Value,
    at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into chat_messages (id, channel_id, author_id, author_name, author_avatar, content,
             type, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, 'system', $7, $8::timestamp, $8::timestamp)",
    )
    .bind(id)
    .bind(channel_id)
    .bind(author_id)
    .bind(author_name)
    .bind(author_avatar)
    .bind(content)
    .bind(metadata)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

// ============================================================================
// Realtime
// ============================================================================

/// `broadcastChatCallToMembers(env, db, workspaceId, channelId, action, data)`:
/// `call_started` / `call_ended` on every member's `chat.user.<id>` topic.
pub async fn broadcast_call_to_members(
    db: &PgPool,
    realtime: &Realtime,
    workspace_id: &str,
    channel_id: &str,
    action: &str,
    data: Map<String, Value>,
) -> Result<(), sqlx::Error> {
    if !realtime.is_on() {
        return Ok(());
    }
    let event = if action == "started" {
        "call_started"
    } else {
        "call_ended"
    };
    let members: Vec<String> =
        sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
            .bind(channel_id)
            .fetch_all(db)
            .await?;
    let mut payload = Map::new();
    payload.insert("channelId".into(), json!(channel_id));
    payload.extend(data);
    let payload = Value::Object(payload);
    for member in members {
        realtime
            .workspace(
                workspace_id,
                &format!("chat.user.{member}"),
                event,
                payload.clone(),
                "system",
            )
            .await;
    }
    Ok(())
}

/// `publishChatCallParticipantLeft(env, channelId, { callId, userId })`.
pub async fn publish_participant_left(
    realtime: &Realtime,
    channel_id: &str,
    call_id: &str,
    user_id: &str,
) {
    realtime
        .call_participant(
            channel_id,
            object([
                ("callId", Some(json!(call_id))),
                ("userId", Some(json!(user_id))),
                ("userName", Some(json!(""))),
                ("action", Some(json!("left"))),
            ]),
        )
        .await;
}

// ============================================================================
// DM rooms
// ============================================================================

/// `dmCallRoomKey(orgId, channelId)`.
pub fn dm_call_room_key(org_id: &str, channel_id: &str) -> String {
    format!("chat-dm-room:{org_id}:{channel_id}")
}

/// `getDmCallRoom`: the DM's room, or `None` when it has none yet (or the
/// cache failed).
pub async fn get_dm_call_room(
    cache: Option<&Arc<dyn DynCache>>,
    org_id: &str,
    channel_id: &str,
) -> Option<String> {
    let cache = cache?;
    match cache.get_boxed(&dm_call_room_key(org_id, channel_id)).await {
        Ok(room) => room.filter(|room| !room.is_empty()),
        Err(error) => {
            tracing::error!(%error, org_id, channel_id, "[DmCallRoom] KV read failed");
            None
        }
    }
}

/// `rememberDmCallRoom`: store (or refresh) the DM's room. Best effort.
pub async fn remember_dm_call_room(
    cache: Option<&Arc<dyn DynCache>>,
    org_id: &str,
    channel_id: &str,
    room: &str,
) {
    let Some(cache) = cache else {
        return;
    };
    let ttl = Some(Duration::from_secs(DM_CALL_ROOM_TTL_SECONDS));
    if let Err(error) = cache
        .put_boxed(&dm_call_room_key(org_id, channel_id), room, ttl)
        .await
    {
        tracing::error!(%error, org_id, channel_id, "[DmCallRoom] KV write failed");
    }
}

/// `isDmCallRoom`: the room is the DM's, which must outlive the call.
pub async fn is_dm_call_room(
    cache: Option<&Arc<dyn DynCache>>,
    org_id: &str,
    channel_id: &str,
    room: &str,
) -> bool {
    get_dm_call_room(cache, org_id, channel_id).await.as_deref() == Some(room)
}

/// The room's webhook mapping (`rtk-meeting:<room>`, the same key for either
/// provider): which workspace, call and channel the room belongs to.
pub async fn map_room_to_call(
    cache: Option<&Arc<dyn DynCache>>,
    room: &str,
    org_id: &str,
    call_id: &str,
    channel_id: &str,
) -> Result<(), weldsuite_ports::PortError> {
    let Some(cache) = cache else {
        return Ok(());
    };
    let value =
        json!({ "orgId": org_id, "type": "call", "callId": call_id, "channelId": channel_id })
            .to_string();
    cache
        .put_boxed(
            &format!("rtk-meeting:{room}"),
            &value,
            Some(Duration::from_secs(ROOM_MAPPING_TTL_SECONDS)),
        )
        .await
}

// ============================================================================
// Ending a call
// ============================================================================

/// `teardownRtkMeeting(env, cfAppId, logCtx)`: disconnect everyone, then end
/// the room and drop its mapping. A DM's own room stays open for the next
/// call: only the participants created up to `ended_at_ms` are removed, and
/// its mapping is left for that call to overwrite. Every step is best effort.
pub async fn teardown_room(
    ports: &CallPorts,
    room: &str,
    call_id: &str,
    org_id: Option<&str>,
    channel_id: Option<&str>,
    ended_at_ms: Option<i64>,
) {
    if let Err(error) = ports.video.kick_all(room).await {
        tracing::error!(%error, call_id, room, "[CallLifecycle] RTK kick-all failed");
    }
    if let (Some(org), Some(channel)) = (org_id, channel_id)
        && is_dm_call_room(ports.cache.as_ref(), org, channel, room).await
    {
        revoke_room_participants(ports, room, ended_at_ms.unwrap_or_else(now_ms), call_id).await;
        return;
    }
    if let Err(error) = ports.video.end_room(room).await {
        tracing::error!(%error, call_id, room, "[CallLifecycle] RTK end meeting failed");
    }
    if let Some(cache) = &ports.cache
        && let Err(error) = cache.delete_boxed(&format!("rtk-meeting:{room}")).await
    {
        tracing::error!(%error, call_id, room, "[CallLifecycle] KV mapping cleanup failed");
    }
}

/// `revokeRoomParticipants`: remove the DM room's participants created up to
/// `ended_at_ms`; later ones belong to the next call. Best effort.
async fn revoke_room_participants(ports: &CallPorts, room: &str, ended_at_ms: i64, call_id: &str) {
    let participants = match ports.video.list_participants(room).await {
        Ok(participants) => participants,
        Err(error) => {
            tracing::error!(%error, call_id, room, "[CallLifecycle] RTK participant revoke failed");
            return;
        }
    };
    let stale: Vec<_> = participants
        .iter()
        .filter(|p| parse_ms(&p.created_at).is_some_and(|created| created <= ended_at_ms))
        .collect();
    let mut failed = 0_usize;
    for participant in &stale {
        if ports
            .video
            .remove_participant(room, &participant.id)
            .await
            .is_err()
        {
            failed += 1;
        }
    }
    if failed > 0 {
        tracing::error!(
            call_id,
            room,
            failed,
            of = stale.len(),
            "[CallLifecycle] RTK participant revoke incomplete"
        );
    }
}

/// `endChatCall(db, env, orgId, callId, call, endedBy, { sendMissedIfUnanswered })`:
/// unconditionally. `call` needs `startedAt`, `cfAppId`, `channelId`,
/// `initiatorId`, `initiatorName`, `status`, `callType` and `participants`.
pub async fn end_chat_call(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    call_id: &str,
    call: &Value,
    ended_by: &str,
    send_missed_if_unanswered: bool,
) -> Result<(), sqlx::Error> {
    let now_ms = now_ms();
    let now = iso_of_ms(now_ms);
    let duration = field_ms(call, "startedAt").map_or(0, |start| round_seconds(now_ms - start));
    let unanswered = !was_answered(call);
    let status = if unanswered && matches!(text(call, "status"), Some("ringing" | "active")) {
        "missed"
    } else {
        "ended"
    };
    sqlx::query(
        "update chat_calls set status = $2, ended_at = $3::timestamp, duration = $4,
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(call_id)
    .bind(status)
    .bind(&now)
    .bind(i32::try_from(duration).unwrap_or(i32::MAX))
    .execute(db)
    .await?;

    let channel_id = text(call, "channelId").unwrap_or_default();
    if let Some(room) = room_of(call) {
        teardown_room(
            ports,
            room,
            call_id,
            Some(org_id),
            Some(channel_id),
            Some(now_ms),
        )
        .await;
    }

    let initiator_id = text(call, "initiatorId").unwrap_or_default();
    let initiator_name = text(call, "initiatorName").unwrap_or_default();
    let call_type = text(call, "callType").unwrap_or("voice");
    let message_id = generate_id("msg");
    let content = if unanswered {
        "Missed call".to_owned()
    } else if duration > 0 {
        format!("Call ended — {}", format_duration(duration))
    } else {
        "Call ended".to_owned()
    };
    let metadata = call_notice_metadata(
        call_id,
        call_type,
        "ended",
        Some(if unanswered { "missed" } else { "answered" }),
        Some(if unanswered { 0 } else { duration }),
    );
    insert_call_notice(
        db,
        &message_id,
        channel_id,
        initiator_id,
        initiator_name,
        None,
        &content,
        &metadata,
        &now,
    )
    .await?;
    sqlx::query("update chat_calls set end_message_id = $2 where id = $1")
        .bind(call_id)
        .bind(&message_id)
        .execute(db)
        .await?;

    ports
        .realtime
        .call(channel_id, call_id, ended_by, "ended")
        .await;
    if let Err(error) = broadcast_call_to_members(
        db,
        &ports.realtime,
        org_id,
        channel_id,
        "ended",
        object([("callId", Some(json!(call_id)))]),
    )
    .await
    {
        tracing::error!(%error, "[CallLifecycle] broadcastChatCallToMembers failed");
    }

    if unanswered {
        stop_unanswered_ring(db, ports, org_id, call_id, call, send_missed_if_unanswered).await;
    }
    Ok(())
}

/// An unanswered DM call is still ringing on the callees' phones: stop it,
/// then send the missed-call push (a decline does both itself).
async fn stop_unanswered_ring(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    call_id: &str,
    call: &Value,
    send_missed: bool,
) {
    let channel_id = text(call, "channelId").unwrap_or_default();
    let initiator_id = text(call, "initiatorId").unwrap_or_default();
    let recipients = dm_call_recipients(db, channel_id, initiator_id).await;
    cancel_call_rings(
        db,
        &ports.notifier,
        call_id,
        &recipients,
        CallCancelReason::Ended,
    )
    .await;
    if !send_missed {
        return;
    }
    for recipient in &recipients {
        let params = notify::missed_call(
            org_id,
            recipient,
            initiator_id,
            text(call, "initiatorName").unwrap_or_default(),
            channel_id,
            call_id,
            text(call, "callType").unwrap_or("voice"),
        );
        if let Err(error) = create_and_deliver(db, &ports.notifier, &params).await {
            tracing::error!(%error, "[CallLifecycle] Missed-call notification failed");
        }
    }
}

/// `EndIfEmptyOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndIfEmpty {
    /// The provider reported an empty room and the call was ended.
    Ended,
    /// Someone is still connected; nothing was touched.
    Occupied,
    /// The provider could not be asked; nothing was touched.
    Unknown,
}

impl EndIfEmpty {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ended => "ended",
            Self::Occupied => "occupied",
            Self::Unknown => "unknown",
        }
    }
}

/// `EndIfEmptyOptions`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndIfEmptyOptions {
    /// `sendMissedIfUnanswered` (default on).
    pub send_missed_if_unanswered: bool,
    /// Also end when exactly one connection is left (the caller waiting
    /// alone in an unanswered call's room).
    pub end_when_alone: bool,
}

impl Default for EndIfEmptyOptions {
    fn default() -> Self {
        Self {
            send_missed_if_unanswered: true,
            end_when_alone: false,
        }
    }
}

/// `endChatCallIfEmpty(...)`: end a call that looks finished, after asking
/// the provider whether anyone is still in its room. A call without a room
/// counts as empty.
pub async fn end_chat_call_if_empty(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    call_id: &str,
    call: &Value,
    ended_by: &str,
    options: EndIfEmptyOptions,
) -> Result<EndIfEmpty, sqlx::Error> {
    if let Some(room) = room_of(call) {
        match ports.video.live_participant_count(room).await {
            Ok(live) if live > u32::from(options.end_when_alone) => {
                return Ok(EndIfEmpty::Occupied);
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(%error, call_id, room, "[CallLifecycle] RTK live participant check failed, keeping the call");
                return Ok(EndIfEmpty::Unknown);
            }
        }
    }
    end_chat_call(
        db,
        ports,
        org_id,
        call_id,
        call,
        ended_by,
        options.send_missed_if_unanswered,
    )
    .await?;
    Ok(EndIfEmpty::Ended)
}

/// `dmCallRecipients(db, call)`: everyone in the DM but the caller; empty for
/// a channel call. Never fails.
pub async fn dm_call_recipients(db: &PgPool, channel_id: &str, initiator_id: &str) -> Vec<String> {
    let run = async {
        let kind: Option<String> =
            sqlx::query_scalar("select type from chat_channels where id = $1 limit 1")
                .bind(channel_id)
                .fetch_optional(db)
                .await?;
        if kind.as_deref() != Some("dm") {
            return Ok::<_, sqlx::Error>(Vec::new());
        }
        let members: Vec<String> =
            sqlx::query_scalar("select user_id from chat_channel_members where channel_id = $1")
                .bind(channel_id)
                .fetch_all(db)
                .await?;
        Ok(members
            .into_iter()
            .filter(|member| member != initiator_id)
            .collect())
    };
    run.await.unwrap_or_else(|error| {
        tracing::error!(%error, "[CallLifecycle] DM recipient lookup failed");
        Vec::new()
    })
}

/// `cancelCallRings`: stop the call's native ring on the recipients' phones.
pub async fn cancel_call_rings(
    db: &PgPool,
    notifier: &Notifier,
    call_id: &str,
    recipients: &[String],
    reason: CallCancelReason,
) {
    for user_id in recipients {
        cancel_incoming_call_push(db, notifier, user_id, call_id, reason).await;
    }
}

/// What `scheduleRingTimeout` does once the ring window has passed: end a
/// DM call nobody answered as missed. Never fails.
pub async fn ring_timed_out(db: &PgPool, ports: &CallPorts, org_id: &str, call_id: &str) {
    let run = async {
        let Some(fresh) = call_row(db, call_id).await? else {
            return Ok::<(), sqlx::Error>(());
        };
        let status = text(&fresh, "status");
        if !matches!(status, Some("ringing" | "active")) {
            return Ok(());
        }
        let initiator = text(&fresh, "initiatorId").unwrap_or_default().to_owned();
        let participants = participants_of(&fresh);
        let remote_joined = participants.iter().any(|p| {
            text(p, "userId") != Some(initiator.as_str())
                && truthy(p.get("joinedAt"))
                && !has_left(p)
        });
        if remote_joined {
            return Ok(());
        }
        if status == Some("ringing") || participants.iter().filter(|p| !has_left(p)).count() <= 1 {
            // The caller waits in the room: one connection is expected, a
            // second is the callee our list missed.
            let outcome = end_chat_call_if_empty(
                db,
                ports,
                org_id,
                call_id,
                &fresh,
                &initiator,
                EndIfEmptyOptions {
                    end_when_alone: true,
                    ..EndIfEmptyOptions::default()
                },
            )
            .await?;
            // The provider could not be asked: an unanswered call that never
            // ends swallows the DM's next call, so fall back to the list.
            if outcome == EndIfEmpty::Unknown {
                end_chat_call(db, ports, org_id, call_id, &fresh, &initiator, true).await?;
            }
        }
        Ok(())
    };
    if let Err(error) = run.await {
        tracing::error!(%error, call_id, "[CallLifecycle] Ring timeout handler failed");
    }
}

// ============================================================================
// One live call at a time
// ============================================================================

/// `evictRtkSessions(env, cfAppId, sessionIds, notify)`: disconnect these
/// participants, first telling the user's clients why (`call_superseded`)
/// when `notify` names the workspace, user and call. Best effort.
pub async fn evict_sessions(
    ports: &CallPorts,
    room: Option<&str>,
    session_ids: &[String],
    notify: Option<(&str, &str, &str)>,
) {
    let Some(room) = room.filter(|room| !room.is_empty()) else {
        return;
    };
    for session_id in session_ids {
        if let Some((org_id, user_id, call_id)) = notify {
            ports
                .realtime
                .call_superseded(
                    org_id,
                    user_id,
                    json!({ "kind": "chat", "id": call_id, "cfSessionId": session_id }),
                )
                .await;
        }
        // The session may already be gone.
        let _ = ports.video.remove_participant(room, session_id).await;
    }
}

/// `leaveOtherActiveCalls(db, env, orgId, userId, exceptCallId, { triggeredAt })`:
/// drop the user from every other ringing/active call they are still in,
/// ending one that is left empty once the provider agrees. A participation
/// that began after `triggered_at` is a newer join elsewhere and is kept.
/// Never fails.
pub async fn leave_other_active_calls(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    user_id: &str,
    except_call_id: Option<&str>,
    triggered_at: i64,
) {
    let needle = json!([{ "userId": user_id }]).to_string();
    let calls: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from chat_calls t
         where t.status in ('ringing', 'active') and t.participants @> $1::jsonb",
    )
    .bind(&needle)
    .fetch_all(db)
    .await;
    let calls = match calls {
        Ok(calls) => calls,
        Err(error) => {
            tracing::error!(%error, "[Chat:Calls] leaveOtherActiveCalls failed");
            return;
        }
    };
    for call in calls.into_iter().map(weldsuite_db::js_row) {
        let call_id = text(&call, "id").unwrap_or_default().to_owned();
        if Some(call_id.as_str()) == except_call_id {
            continue;
        }
        if let Err(error) = leave_call(db, ports, org_id, user_id, &call, triggered_at).await {
            tracing::error!(%error, call_id, "[Chat:Calls] leaveOtherActiveCalls failed for call");
        }
    }
}

/// `leaveCall`: announce, evict, mark left, end if empty.
async fn leave_call(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    user_id: &str,
    call: &Value,
    triggered_at: i64,
) -> Result<(), sqlx::Error> {
    let deduped = dedupe_participants(&participants_of(call));
    let Some(mine) = deduped
        .iter()
        .find(|p| text(p, "userId") == Some(user_id) && !has_left(p))
    else {
        return Ok(());
    };
    if field_ms(mine, "joinedAt").is_some_and(|joined| joined > triggered_at) {
        return Ok(());
    }
    let call_id = text(call, "id").unwrap_or_default();
    let session = text(mine, "cfSessionId").filter(|id| !id.is_empty());
    ports
        .realtime
        .call_superseded(
            org_id,
            user_id,
            json!({ "kind": "chat", "id": call_id, "cfSessionId": session }),
        )
        .await;
    let evicted: Vec<String> = session.map(str::to_owned).into_iter().collect();
    evict_sessions(ports, room_of(call), &evicted, None).await;

    let now = iso_of_ms(now_ms());
    let updated: Vec<Value> = deduped
        .iter()
        .map(|p| {
            if text(p, "userId") == Some(user_id) && !has_left(p) {
                let mut entry = p.clone();
                if let Some(object) = entry.as_object_mut() {
                    object.insert("leftAt".into(), json!(now));
                }
                entry
            } else {
                p.clone()
            }
        })
        .collect();
    let still_active = updated.iter().any(|p| !has_left(p));
    sqlx::query(
        "update chat_calls set participants = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(call_id)
    .bind(Value::Array(updated))
    .bind(&now)
    .execute(db)
    .await?;
    let channel_id = text(call, "channelId").unwrap_or_default();
    publish_participant_left(&ports.realtime, channel_id, call_id, user_id).await;

    if !still_active {
        // Unanswered: the only connection there can be is the one evicted above.
        let options = EndIfEmptyOptions {
            end_when_alone: !was_answered(call),
            ..EndIfEmptyOptions::default()
        };
        let _ = end_chat_call_if_empty(db, ports, org_id, call_id, call, user_id, options).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(user: &str, joined: &str, left: Option<&str>, session: &str) -> Value {
        let mut p = new_participant(user, user, None, joined, session);
        if let Some(left) = left {
            p["leftAt"] = json!(left);
        }
        p
    }

    #[test]
    fn keeps_every_user_once() {
        let list = vec![
            participant(
                "a",
                "2026-01-01T10:00:00.000Z",
                Some("2026-01-01T10:05:00.000Z"),
                "s1",
            ),
            participant("b", "2026-01-01T10:00:00.000Z", None, "s2"),
            participant("a", "2026-01-01T10:06:00.000Z", None, "s3"),
            participant("b", "2026-01-01T10:07:00.000Z", None, "s4"),
        ];
        let deduped = dedupe_participants(&list);
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0]["cfSessionId"], "s3");
        assert_eq!(deduped[1]["cfSessionId"], "s4");
        assert_eq!(active_participant_count(&list), 2);
    }

    #[test]
    fn upsert_surfaces_the_stale_session() {
        let list = vec![participant("a", "2026-01-01T10:00:00.000Z", None, "old")];
        let fresh = participant("a", "2026-01-01T10:01:00.000Z", None, "new");
        let (next, stale) = upsert_participant(&list, fresh);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["cfSessionId"], "new");
        assert_eq!(stale, vec!["old".to_owned()]);
        // Rejoining with the same session evicts nothing.
        let (_, stale) = upsert_participant(
            &next,
            participant("a", "2026-01-01T10:02:00.000Z", None, "new"),
        );
        assert_eq!(stale, Vec::<String>::new());
    }

    #[test]
    fn tells_an_abandoned_call() {
        let now = parse_ms("2026-01-01T10:10:00.000Z").unwrap_or_default();
        let call = |status: &str, created: &str, participants: Vec<Value>| json!({ "status": status, "createdAt": created, "initiatorId": "a", "participants": participants });
        let alone = call(
            "active",
            "2026-01-01T10:09:50.000Z",
            vec![participant("a", "2026-01-01T10:09:50.000Z", None, "s")],
        );
        // In a DM, only the requester left in it: abandoned at once.
        assert!(is_abandoned_call(&alone, true, "a", now));
        // In a channel, a young call with someone in it is live.
        assert!(!is_abandoned_call(&alone, false, "a", now));
        let old_empty = call("active", "2026-01-01T10:00:00.000Z", vec![]);
        assert!(is_abandoned_call(&old_empty, false, "a", now));
        let answered = call(
            "active",
            "2026-01-01T10:00:00.000Z",
            vec![
                participant("a", "2026-01-01T10:00:00.000Z", None, "s1"),
                participant("b", "2026-01-01T10:00:05.000Z", None, "s2"),
            ],
        );
        assert!(was_answered(&answered));
        assert!(!is_abandoned_call(&answered, true, "a", now));
    }

    #[test]
    fn formats_durations_and_notices() {
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(180), "3m");
        assert_eq!(format_duration(192), "3m 12s");
        assert_eq!(
            call_notice_metadata("call_1", "voice", "ended", Some("missed"), Some(0)),
            json!({ "call": { "callId": "call_1", "callType": "voice", "event": "ended", "outcome": "missed", "duration": 0 } })
        );
        assert_eq!(
            call_notice_metadata("call_1", "video", "started", None, None),
            json!({ "call": { "callId": "call_1", "callType": "video", "event": "started" } })
        );
        assert_eq!(round_seconds(2_500), 3);
        assert_eq!(round_seconds(2_499), 2);
    }
}
