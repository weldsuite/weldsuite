//! `/api/meeting-sessions` (`routes/meeting-sessions/index.ts`): the active
//! and latest session of a meeting, start, join, leave, end, removing a
//! participant, the provider's recordings of a session and the CRUD. The
//! recording, transcript and summary routes are `crate::recording`'s.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MEETING_SESSION_CREATED, MEETING_SESSION_DELETED, MEETING_SESSION_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_video_rooms::{HOST_PRESET, MEMBER_PRESET, NewParticipant, RoomOptions};

use crate::js::{js_limit, js_slice, now_ms, parse_ms, query_param, sql_limit, text, truthy};
use crate::lifecycle::{self, EndIfEmpty, Env};
use crate::participants::{self, AvatarStore, Input, Link};
use crate::table::WriteError;
use crate::tables::MEETING_SESSIONS;
use crate::{Caller, MeetState, internal, now, publish, validate};

/// `RTK_SESSION_MAPPING_TTL_SECONDS`: the post-meeting mapping lives 14 days.
pub(crate) const SESSION_MAPPING_TTL_SECONDS: u64 = 14 * 24 * 60 * 60;

/// `SERVER_OWNED_MEETING_SESSION_FIELDS`.
const SERVER_OWNED: &[&str] = &[
    "id",
    "meetingId",
    "cfAppId",
    "rtkSessionId",
    "recordingEnabled",
    "recordingUrl",
    "recordingKey",
    "recordingStatus",
    "recordingRtkId",
    "recordingVideoKey",
    "recordingAudioKey",
    "recordingSizeBytes",
    "recordingDurationSeconds",
    "recordingReadyAt",
    "recordingError",
    "recordingParts",
    "aiTranscribeRequested",
    "aiSummarizeRequested",
    "aiLanguage",
    "transcriptionCreditsCharged",
    "summaryStatus",
    "summaryText",
    "summaryFormat",
    "summarySource",
    "summaryGeneratedAt",
    "summaryError",
    "summaryCreditsCharged",
    "createdAt",
    "updatedAt",
];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/active", get(active).route_layer(need("sessions:read")))
        .route("/latest", get(latest).route_layer(need("sessions:read")))
        .route("/start", post(start).route_layer(need("sessions:create")))
        .route("/{id}/join", post(join).route_layer(need("sessions:read")))
        .route(
            "/{id}/leave",
            post(leave).route_layer(need("sessions:read")),
        )
        .route("/{id}/end", post(end).route_layer(need("sessions:read")))
        .route(
            "/{id}/participants/remove",
            post(remove_participant).route_layer(need("sessions:read")),
        )
        .merge(crate::recording::session_routes(gate))
        .route(
            "/{id}/recordings",
            get(provider_recordings).route_layer(need("sessions:read")),
        )
        .route("/", get(list).route_layer(need("sessions:read")))
        .route("/", post(create).route_layer(need("sessions:create")))
        .route("/{id}", get(detail).route_layer(need("sessions:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("sessions:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("sessions:delete")),
        )
}

/// The lifecycle's view of the request.
pub(crate) fn lifecycle_env(state: &MeetState, caller: &Caller) -> Env {
    Env {
        video: caller.parts.video(state),
        cache: caller.parts.cache(state),
    }
}

/// Where a new person's avatar goes (`STORAGE`, `R2_PUBLIC_URL`).
pub(crate) fn avatars(state: &MeetState, caller: &Caller) -> AvatarStore {
    AvatarStore {
        bucket: caller.parts.public_bucket(state),
        public_url: caller.parts.env("R2_PUBLIC_URL"),
    }
}

/// `buildSessionParticipant(userId, userName, avatar, link, cfSessionId)`.
pub(crate) fn build_participant(
    user_id: &str,
    user_name: &str,
    avatar: Option<&str>,
    link: &Link,
    cf_session_id: &str,
) -> Value {
    let mut entry = Map::new();
    entry.insert("userId".into(), json!(user_id));
    entry.insert("userName".into(), json!(user_name));
    if let Some(avatar) = avatar {
        entry.insert("userAvatar".into(), json!(avatar));
    }
    entry.insert("joinedAt".into(), json!(now()));
    entry.insert("cfSessionId".into(), json!(cf_session_id));
    entry.insert("hasAudio".into(), json!(false));
    entry.insert("hasVideo".into(), json!(false));
    entry.insert("hasScreenShare".into(), json!(false));
    if let Some(member) = link
        .workspace_member_id
        .as_deref()
        .filter(|m| !m.is_empty())
    {
        entry.insert("workspaceMemberId".into(), json!(member));
    }
    if let Some(person) = link.person_id.as_deref().filter(|p| !p.is_empty()) {
        entry.insert("personId".into(), json!(person));
    }
    Value::Object(entry)
}

/// `mergeRejoin(prev, next)`: a rejoin keeps the first join time and the
/// time already spent.
pub(crate) fn merge_rejoin(previous: Option<&Value>, next: Value) -> Value {
    let Some(prev) = previous else {
        return next;
    };
    let mut out = next.as_object().cloned().unwrap_or_default();
    let first_joined = prev
        .get("firstJoinedAt")
        .filter(|v| !v.is_null())
        .or_else(|| prev.get("joinedAt"))
        .cloned()
        .unwrap_or(Value::Null);
    out.insert("lastJoinAt".into(), next["joinedAt"].clone());
    if prev["peerIds"]
        .as_array()
        .is_some_and(|ids| !ids.is_empty())
    {
        out.insert("peerIds".into(), prev["peerIds"].clone());
    }
    if !truthy(prev.get("leftAt")) {
        out.insert("joinedAt".into(), prev["joinedAt"].clone());
        out.insert("firstJoinedAt".into(), first_joined);
        if let Some(prior) = prev.get("priorSeconds") {
            out.insert("priorSeconds".into(), prior.clone());
        }
        if let Some(stints) = prev.get("stints") {
            out.insert("stints".into(), stints.clone());
        }
        return Value::Object(out);
    }
    let left = text(prev, "leftAt").and_then(parse_ms);
    let joined = text(prev, "joinedAt").and_then(parse_ms);
    let stint_seconds = match (left, joined) {
        (Some(left), Some(joined)) if left > joined => {
            #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
            let seconds = ((left - joined) as f64 / 1000.0 + 0.5).floor() as i64;
            seconds
        }
        _ => 0,
    };
    let prior = prev
        .get("priorSeconds")
        .filter(|v| !v.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let stints = prev
        .get("stints")
        .filter(|v| !v.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    out.insert("firstJoinedAt".into(), first_joined);
    #[allow(clippy::cast_precision_loss)]
    out.insert(
        "priorSeconds".into(),
        crate::billing::js_number(prior + stint_seconds as f64),
    );
    out.insert("stints".into(), crate::billing::js_number(stints + 1.0));
    Value::Object(out)
}

fn org_of(caller: &Caller) -> Result<String, Box<Response>> {
    caller
        .org_id
        .clone()
        .ok_or_else(|| Box::new(ApiError::org_required().into_response()))
}

async fn session(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    lifecycle::session_row(db, id).await
}

// ── GET /active ────────────────────────────────────────────────────────────

async fn active(
    State(state): State<MeetState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let Some(meeting_id) = query_param(query.as_deref(), "meetingId").filter(|m| !m.is_empty())
    else {
        return ApiError::bad_request("meetingId query parameter is required").into_response();
    };
    match active_session(&state, &caller, &org, &meeting_id).await {
        Ok(session) => Data(session).into_response(),
        Err(error) => internal(&error, "Failed to get active session"),
    }
}

async fn active_session(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    meeting_id: &str,
) -> Result<Value, sqlx::Error> {
    let db = &caller.db;
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_sessions t
         where t.meeting_id = $1 and (t.status = 'waiting' or t.status = 'active') limit 1",
    )
    .bind(meeting_id)
    .fetch_optional(db)
    .await?;
    let Some(session) = row.map(|row| MEETING_SESSIONS.js(row)) else {
        return Ok(Value::Null);
    };
    let policy: Option<(Option<bool>, Option<i32>)> = sqlx::query_as(
        "select auto_end_on_inactivity, auto_end_inactivity_minutes from meetings where id = $1 limit 1",
    )
    .bind(meeting_id)
    .fetch_optional(db)
    .await?;
    let inactivity = match policy {
        Some((Some(false), _)) => f64::INFINITY,
        Some((_, minutes)) => f64::from(minutes.unwrap_or(10)) * 60_000.0,
        None => 10.0 * 60_000.0,
    };
    #[allow(clippy::cast_precision_loss)]
    let now = now_ms() as f64;
    let age = |key: &str| {
        #[allow(clippy::cast_precision_loss)]
        text(&session, key)
            .and_then(parse_ms)
            .map_or(f64::NAN, |at| now - at as f64)
    };
    let active = session["participants"].as_array().map_or(0, |all| {
        all.iter().filter(|p| !truthy(p.get("leftAt"))).count()
    });
    let status = text(&session, "status").unwrap_or_default();
    let stale = (status == "waiting" && age("createdAt") > inactivity)
        || (status == "active" && active == 0 && age("updatedAt") > inactivity);
    if stale {
        let env = lifecycle_env(state, caller);
        let id = text(&session, "id").unwrap_or_default().to_owned();
        let outcome =
            lifecycle::end_session_if_empty(state, &env, db, org, &id, &session, meeting_id)
                .await
                .unwrap_or(EndIfEmpty::Unknown);
        if outcome == EndIfEmpty::Ended {
            return Ok(Value::Null);
        }
    }
    Ok(session)
}

// ── GET /latest ────────────────────────────────────────────────────────────

async fn latest(caller: Caller, RawQuery(query): RawQuery) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let Some(meeting_id) = query_param(query.as_deref(), "meetingId").filter(|m| !m.is_empty())
    else {
        return ApiError::bad_request("meetingId query parameter is required").into_response();
    };
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_sessions t where t.meeting_id = $1
         order by t.created_at desc limit 1",
    )
    .bind(&meeting_id)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(row) => Data(row.map_or(Value::Null, |row| MEETING_SESSIONS.js(row))).into_response(),
        Err(error) => internal(&error, "Failed to get latest session"),
    }
}

// ── POST /start ────────────────────────────────────────────────────────────

/// `getMemberDisplayCached(c, orgId, userId)`: the member's name and picture,
/// cached an hour.
async fn member_display(
    state: &MeetState,
    caller: &Caller,
    org: &str,
) -> Result<(String, Option<String>), sqlx::Error> {
    let key = format!("member-display:{org}:{}", caller.user_id);
    let cache = caller.parts.cache(state);
    if let Some(cache) = &cache
        && let Ok(Some(raw)) = cache.get_boxed(&key).await
        && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
        && !raw.is_empty()
    {
        let name = text(&parsed, "name").unwrap_or("Unknown").to_owned();
        let picture = text(&parsed, "picture").map(str::to_owned);
        return Ok((name, picture));
    }
    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await?;
    let (name, picture) = author.unwrap_or((None, None));
    let name = name.unwrap_or_else(|| "Unknown".to_owned());
    if let Some(cache) = cache {
        let mut value = Map::new();
        value.insert("name".into(), json!(name));
        if let Some(picture) = &picture {
            value.insert("picture".into(), json!(picture));
        }
        let value = Value::Object(value).to_string();
        state.events.tracker().spawn(async move {
            let _ = cache
                .put_boxed(&key, &value, Some(std::time::Duration::from_secs(3600)))
                .await;
        });
    }
    Ok((name, picture))
}

/// `ensurePresets(env)`: seed the provider's presets once per version.
pub(crate) async fn ensure_presets(state: &MeetState, caller: &Caller) -> Result<(), String> {
    const KEY: &str = "rtk-presets-seeded-v7";
    let cache = caller.parts.cache(state);
    if let Some(cache) = &cache
        && let Ok(Some(value)) = cache.get_boxed(KEY).await
        && !value.is_empty()
    {
        return Ok(());
    }
    caller
        .parts
        .video(state)
        .seed_presets()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(cache) = cache {
        let _ = cache.put_boxed(KEY, "1", None).await;
    }
    Ok(())
}

/// The two webhook mappings of a new room, written in the background:
/// `rtk-meeting:` (24 h) and `rtk-session:` (14 days).
pub(crate) fn write_mappings(
    state: &MeetState,
    caller: &Caller,
    room: &str,
    org: &str,
    session_id: &str,
    meeting_id: &str,
) {
    let Some(cache) = caller.parts.cache(state) else {
        return;
    };
    let live = json!({ "orgId": org, "type": "session", "sessionId": session_id, "meetingId": meeting_id }).to_string();
    let durable =
        json!({ "orgId": org, "sessionId": session_id, "meetingId": meeting_id }).to_string();
    let room = room.to_owned();
    state.events.tracker().spawn(async move {
        let live_key = format!("rtk-meeting:{room}");
        let live_put = cache.put_boxed(&live_key, &live, Some(std::time::Duration::from_hours(24)));
        let durable_key = format!("rtk-session:{room}");
        let durable_put = cache.put_boxed(
            &durable_key,
            &durable,
            Some(std::time::Duration::from_secs(SESSION_MAPPING_TTL_SECONDS)),
        );
        let (a, b) = tokio::join!(live_put, durable_put);
        if let Err(error) = a.and(b) {
            tracing::warn!(%error, "[meeting-sessions/start] KV write failed (non-fatal)");
        }
    });
}

/// `leaveOtherLiveCalls(db, env, orgId, userId, exceptSessionId, triggeredAt)`
/// in the background (WeldChat calls: see `crate::lifecycle`).
pub(crate) fn leave_other_calls_later(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    except_session_id: &str,
    triggered_at: i64,
    superseded: Option<(Value, String)>,
) {
    let state = state.clone();
    let env = lifecycle_env(&state, caller);
    let db = caller.db.clone();
    let org = org.to_owned();
    let user = caller.user_id.clone();
    let except = except_session_id.to_owned();
    state.events.tracker().clone().spawn(async move {
        if let Some((session, old)) = superseded {
            lifecycle::evict_superseded(&state, &env, &org, &user, &session, &old).await;
        }
        lifecycle::leave_other_sessions(
            &state,
            &env,
            &db,
            &org,
            &user,
            Some(&except),
            triggered_at,
        )
        .await;
    });
}

async fn start(
    State(state): State<MeetState>,
    caller: Caller,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let meeting_id = match validate(&headers, &body, |issues, fields| {
        issues
            .text_with(
                fields,
                "meetingId",
                Presence::Required,
                Text::length(Some(1), None),
            )
            .into_option()
    }) {
        Ok(Some(id)) => id,
        Ok(None) => return ApiError::internal().into_response(),
        Err(response) => return *response,
    };
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let join_inline = query_param(query.as_deref(), "join").as_deref() == Some("true");
    match start_session(&state, &caller, &org, &meeting_id, join_inline).await {
        Ok(response) => response,
        Err(error) => internal(&error, "Failed to start session"),
    }
}

async fn start_session(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    meeting_id: &str,
    join_inline: bool,
) -> Result<Response, String> {
    let t0 = now_ms();
    let db = &caller.db;
    let (meeting, member) = tokio::join!(
        lifecycle::meeting_row(db, meeting_id),
        member_display(state, caller, org)
    );
    let meeting = meeting.map_err(|e| e.to_string())?;
    let (user_name, picture) = member.map_err(|e| e.to_string())?;
    let Some(meeting) = meeting else {
        return Ok(ApiError::not_found("Meeting", Some(meeting_id)).into_response());
    };
    if text(&meeting, "status") == Some("cancelled") {
        return Ok(ApiError::bad_request("Meeting is cancelled").into_response());
    }
    let env = lifecycle_env(state, caller);
    if let Some(active) = text(&meeting, "activeSessionId").filter(|a| !a.is_empty()) {
        let ok = stale_session_or_conflict(state, &env, db, org, meeting_id, active)
            .await
            .map_err(|e| e.to_string())?;
        if !ok {
            return Ok(
                ApiError::conflict("A session is already active for this meeting").into_response(),
            );
        }
    }
    let session_id = generate_id("msess");
    let now = now();
    ensure_presets(state, caller).await?;
    let options = RoomOptions {
        record_on_start: Some(
            meeting["autoRecord"] == json!(true) && meeting["allowRecording"] != json!(false),
        ),
        audio_export: true,
        ..RoomOptions::default()
    };
    let room = env
        .video
        .create_room_with(text(&meeting, "title").unwrap_or_default(), &options)
        .await
        .map_err(|e| e.to_string())?;
    write_mappings(state, caller, &room, org, &session_id, meeting_id);

    let is_host = text(&meeting, "organizerId") == Some(caller.user_id.as_str());
    let mut auth_token = None;
    let mut initial = Vec::new();
    if join_inline {
        let link = participants::resolve(
            db,
            &avatars(state, caller),
            org,
            Input {
                user_id: Some(&caller.user_id),
                name: Some(&user_name),
                email: None,
            },
        )
        .await;
        let avatar = link.avatar_url.clone().or_else(|| picture.clone());
        let joined = env
            .video
            .add_participant(
                &room,
                &NewParticipant {
                    name: user_name.clone(),
                    custom_participant_id: caller.user_id.clone(),
                    preset_name: Some(if is_host { HOST_PRESET } else { MEMBER_PRESET }.to_owned()),
                    picture: avatar.clone().filter(|a| !a.is_empty()),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        auth_token = Some(joined.token);
        initial.push(build_participant(
            &caller.user_id,
            &user_name,
            avatar.as_deref(),
            &link,
            &joined.participant_id,
        ));
    }
    let status = if join_inline { "active" } else { "waiting" };
    sqlx::query(
        "insert into meeting_sessions (id, meeting_id, session_type, status, cf_app_id, started_by,
             started_by_name, participants, max_participants, created_at, updated_at, started_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $10::timestamp,
             case when $11 then $10::timestamp else null end)",
    )
    .bind(&session_id)
    .bind(meeting_id)
    .bind(text(&meeting, "meetingType").unwrap_or("video"))
    .bind(status)
    .bind(&room)
    .bind(&caller.user_id)
    .bind(&user_name)
    .bind(Value::Array(initial.clone()))
    .bind(i32::try_from(initial.len()).unwrap_or(0))
    .bind(&now)
    .bind(join_inline)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "update meetings set status = 'in_progress', active_session_id = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(meeting_id)
    .bind(&session_id)
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;

    {
        let state = state.clone();
        let env = env.clone();
        let db = db.clone();
        let org = org.to_owned();
        let user = caller.user_id.clone();
        let meeting_id = meeting_id.to_owned();
        let session_id = session_id.clone();
        state.events.tracker().clone().spawn(async move {
            publish::session_started(&state, &org, &meeting_id, &session_id, &user).await;
            publish::meeting_updated(
                &state,
                &org,
                json!({ "meetingId": meeting_id, "status": "in_progress" }),
            )
            .await;
            if join_inline {
                lifecycle::leave_other_sessions(
                    &state,
                    &env,
                    &db,
                    &org,
                    &user,
                    Some(&session_id),
                    t0,
                )
                .await;
            }
        });
    }
    caller.publish(
        state,
        MEETING_SESSION_CREATED,
        &session_id,
        &json!({ "id": session_id, "meetingId": meeting_id, "status": status, "startedBy": caller.user_id }),
    );
    let mut answer = Map::new();
    answer.insert("sessionId".into(), json!(session_id));
    answer.insert("status".into(), json!(status));
    answer.insert("rtkMeetingId".into(), json!(room));
    if join_inline {
        answer.insert("authToken".into(), json!(auth_token));
        answer.insert("participants".into(), Value::Array(initial));
    }
    Ok(Created(Value::Object(answer)).into_response())
}

/// `endStaleSessionOrConflict`: `true` when the meeting is free to start
/// (no live session, or a stale one the provider confirms empty, ended now).
async fn stale_session_or_conflict(
    state: &MeetState,
    env: &Env,
    db: &PgPool,
    org: &str,
    meeting_id: &str,
    active_session_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(existing) = session(db, active_session_id).await? else {
        return Ok(true);
    };
    if text(&existing, "status") == Some("ended") {
        return Ok(true);
    }
    #[allow(clippy::cast_precision_loss)]
    let age = text(&existing, "createdAt")
        .and_then(parse_ms)
        .map_or(f64::NAN, |at| (now_ms() - at) as f64);
    let active = existing["participants"].as_array().map_or(0, |all| {
        all.iter().filter(|p| !truthy(p.get("leftAt"))).count()
    });
    let stale = (active == 0 && age > 60_000.0)
        || (text(&existing, "status") == Some("waiting") && age > 5.0 * 60_000.0);
    if !stale {
        return Ok(false);
    }
    let id = text(&existing, "id").unwrap_or_default().to_owned();
    let outcome =
        lifecycle::end_session_if_empty(state, env, db, org, &id, &existing, meeting_id).await?;
    Ok(outcome == EndIfEmpty::Ended)
}

// ── POST /:id/join ─────────────────────────────────────────────────────────

/// `checkJoinPolicy(meeting, session, userId)`.
fn join_policy(meeting: &Value, session: &Value, user_id: &str) -> Option<&'static str> {
    if truthy(meeting.get("lockAfterStart")) && text(session, "status") == Some("active") {
        let invited = meeting["attendees"]
            .as_array()
            .is_some_and(|all| all.iter().any(|a| text(a, "userId") == Some(user_id)));
        if !invited {
            return Some("locked");
        }
    }
    if truthy(meeting.get("hostMustJoinFirst")) {
        let organizer = meeting.get("organizerId");
        let present = session["participants"]
            .as_array()
            .is_some_and(|all| all.iter().any(|p| p.get("userId") == organizer));
        if !present {
            return Some("host_must_join_first");
        }
    }
    None
}

async fn join(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let started = now_ms();
    match join_session(&state, &caller, &org, &id, started).await {
        Ok(response) => response,
        Err(error) => internal(&error, "Failed to join session"),
    }
}

async fn join_session(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    id: &str,
    started: i64,
) -> Result<Response, String> {
    let db = &caller.db;
    let Some(session) = session(db, id).await.map_err(|e| e.to_string())? else {
        return Ok(ApiError::not_found("Session", Some(id)).into_response());
    };
    if text(&session, "status") == Some("ended") {
        return Ok(ApiError::bad_request("Session has ended").into_response());
    }
    let Some(room) = text(&session, "cfAppId")
        .filter(|r| !r.is_empty())
        .map(str::to_owned)
    else {
        return Ok(ApiError::internal()
            .with_message("Session has no RTK meeting ID")
            .into_response());
    };
    let meeting_id = text(&session, "meetingId").unwrap_or_default().to_owned();
    let meeting = lifecycle::meeting_row(db, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    let is_host = meeting
        .as_ref()
        .is_some_and(|m| text(m, "organizerId") == Some(caller.user_id.as_str()));
    let blocked = match &meeting {
        Some(meeting) if !is_host => join_policy(meeting, &session, &caller.user_id),
        _ => None,
    };
    if blocked == Some("locked") {
        return Ok(ApiError::new(
            http::StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "This meeting is locked. New participants are not allowed.",
        )
        .into_response());
    }
    if blocked == Some("host_must_join_first") {
        return Ok(Data(
            json!({ "sessionId": id, "status": "waiting", "reason": "host_must_join_first" }),
        )
        .into_response());
    }
    let author: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, picture from workspace_members where user_id = $1 limit 1")
            .bind(&caller.user_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    let (author_name, author_picture) = author.unwrap_or((None, None));
    let user_name = author_name.unwrap_or_else(|| "Unknown".to_owned());
    let link = participants::resolve(
        db,
        &avatars(state, caller),
        org,
        Input {
            user_id: Some(&caller.user_id),
            name: Some(&user_name),
            email: None,
        },
    )
    .await;
    let avatar = link.avatar_url.clone().or(author_picture);
    let env = lifecycle_env(state, caller);
    let joined = env
        .video
        .add_participant(
            &room,
            &NewParticipant {
                name: user_name.clone(),
                custom_participant_id: caller.user_id.clone(),
                preset_name: Some(if is_host { HOST_PRESET } else { MEMBER_PRESET }.to_owned()),
                picture: avatar.clone().filter(|a| !a.is_empty()),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let participant = build_participant(
        &caller.user_id,
        &user_name,
        avatar.as_deref(),
        &link,
        &joined.participant_id,
    );
    let current = session["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let previous = current
        .iter()
        .find(|p| text(p, "userId") == Some(caller.user_id.as_str()))
        .cloned();
    let mut filtered: Vec<Value> = current
        .into_iter()
        .filter(|p| text(p, "userId") != Some(caller.user_id.as_str()))
        .collect();
    filtered.push(merge_rejoin(previous.as_ref(), participant));
    let max = session["maxParticipants"]
        .as_i64()
        .unwrap_or(0)
        .max(i64::try_from(filtered.len()).unwrap_or(i64::MAX));
    let now = now();
    let waiting = text(&session, "status") == Some("waiting");
    sqlx::query(
        "update meeting_sessions set participants = $2, max_participants = $3, updated_at = $4::timestamp,
             status = case when $5 then 'active' else status end,
             started_at = case when $5 then $4::timestamp else started_at end
         where id = $1",
    )
    .bind(id)
    .bind(Value::Array(filtered.clone()))
    .bind(i32::try_from(max).unwrap_or(i32::MAX))
    .bind(&now)
    .bind(waiting)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    let superseded = lifecycle::superseded_cf_session_id(previous.as_ref(), &joined.participant_id)
        .map(|old| (session.clone(), old));
    leave_other_calls_later(state, caller, org, id, started, superseded);
    Ok(
        Data(json!({ "sessionId": id, "authToken": joined.token, "participants": filtered }))
            .into_response(),
    )
}

// ── POST /:id/leave ────────────────────────────────────────────────────────

async fn leave(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    match leave_session(&state, &caller, &org, &id).await {
        Ok(response) => response,
        Err(error) => internal(&error, "Failed to leave session"),
    }
}

async fn leave_session(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    id: &str,
) -> Result<Response, sqlx::Error> {
    let db = &caller.db;
    let Some(session) = session(db, id).await? else {
        return Ok(ApiError::not_found("Session", Some(id)).into_response());
    };
    if text(&session, "status") == Some("ended") {
        return Ok(Data(json!({ "ok": true })).into_response());
    }
    let mut participants = session["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some(entry) = participants
        .iter_mut()
        .find(|p| text(p, "userId") == Some(caller.user_id.as_str()))
        && let Some(object) = entry.as_object_mut()
    {
        object.insert("leftAt".into(), json!(now()));
    }
    let active = participants
        .iter()
        .filter(|p| !truthy(p.get("leftAt")))
        .count();
    sqlx::query(
        "update meeting_sessions set participants = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(Value::Array(participants))
    .bind(now())
    .execute(db)
    .await?;
    if active == 0 {
        let env = lifecycle_env(state, caller);
        let meeting_id = text(&session, "meetingId").unwrap_or_default().to_owned();
        lifecycle::end_session_if_empty(state, &env, db, org, id, &session, &meeting_id).await?;
    }
    Ok(Data(json!({ "ok": true })).into_response())
}

// ── POST /:id/end ──────────────────────────────────────────────────────────

/// Whether the caller organizes the session's meeting.
async fn is_organizer(
    db: &PgPool,
    session: &Value,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let organizer: Option<String> =
        sqlx::query_scalar("select organizer_id from meetings where id = $1 limit 1")
            .bind(text(session, "meetingId").unwrap_or_default())
            .fetch_optional(db)
            .await?;
    let _ = user_id;
    Ok(organizer)
}

async fn end(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let Some(session) = session(db, &id).await? else {
            return Ok(ApiError::not_found("Session", Some(&id)).into_response());
        };
        let organizer = is_organizer(db, &session, &caller.user_id).await?;
        let organizes = organizer
            .as_deref()
            .is_some_and(|o| !o.is_empty() && o == caller.user_id);
        if !organizes && !caller.can("sessions:update") {
            return Ok(ApiError::forbidden()
                .with_message("Only the meeting organizer can end the meeting for everyone.")
                .into_response());
        }
        if text(&session, "status") == Some("ended") {
            return Ok(Data(json!({ "ok": true })).into_response());
        }
        let env = lifecycle_env(&state, &caller);
        let meeting_id = text(&session, "meetingId").unwrap_or_default().to_owned();
        lifecycle::end_session(&state, &env, db, &org, &id, &session, &meeting_id).await?;
        Ok(Data(json!({ "ok": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to end session"))
}

// ── POST /:id/participants/remove ──────────────────────────────────────────

/// `MEETING_GUEST_USER_ID_PREFIX`.
const GUEST_PREFIX: &str = "guest:";

/// `guestEmailFromUserId(userId)`.
fn guest_email(user_id: &str) -> Option<String> {
    let email = user_id.strip_prefix(GUEST_PREFIX)?.trim().to_lowercase();
    (!email.is_empty()).then_some(email)
}

/// `isGuestRemovedFromSession(metadata, email)`.
fn guest_removed(metadata: &Value, email: &str) -> bool {
    let key = email.trim().to_lowercase();
    !key.is_empty()
        && metadata
            .get("removedGuests")
            .and_then(Value::as_object)
            .is_some_and(|guests| guests.contains_key(&key))
}

async fn remove_participant(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = validate(&headers, &body, |issues, fields| {
        let rules = Text::length(Some(1), Some(200));
        let participant = issues
            .text_with(fields, "participantId", Presence::Required, rules)
            .into_option();
        let rtk_user = issues
            .text_with(fields, "rtkUserId", Presence::Optional, rules)
            .into_option();
        let custom = issues
            .text_with(fields, "customParticipantId", Presence::Optional, rules)
            .into_option();
        (participant.unwrap_or_default(), rtk_user, custom)
    });
    let (participant_id, rtk_user_id, custom_id) = match ids {
        Ok(ids) => ids,
        Err(response) => return *response,
    };
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let _ = org;
    let result = remove_one(
        &state,
        &caller,
        &id,
        &participant_id,
        rtk_user_id.as_deref(),
        custom_id.as_deref(),
    )
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to remove participant"))
}

async fn remove_one(
    state: &MeetState,
    caller: &Caller,
    id: &str,
    participant_id: &str,
    rtk_user_id: Option<&str>,
    custom_id: Option<&str>,
) -> Result<Response, sqlx::Error> {
    let db = &caller.db;
    let Some(session) = session(db, id).await? else {
        return Ok(ApiError::not_found("Session", Some(id)).into_response());
    };
    let organizer = is_organizer(db, &session, &caller.user_id).await?;
    let organizes = organizer
        .as_deref()
        .is_some_and(|o| !o.is_empty() && o == caller.user_id);
    if !organizes && !caller.can("sessions:update") {
        return Ok(ApiError::forbidden()
            .with_message("Only the meeting organizer can remove participants.")
            .into_response());
    }
    if text(&session, "status") == Some("ended") {
        return Ok(Data(json!({ "ok": true, "kicked": false, "blocked": false })).into_response());
    }
    let mut participants = session["participants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let matches = |p: &Value| {
        let cf = text(p, "cfSessionId");
        cf == Some(participant_id)
            || rtk_user_id.is_some_and(|r| cf == Some(r))
            || custom_id.is_some_and(|c| text(p, "userId") == Some(c))
    };
    let index = participants
        .iter()
        .position(|p| !truthy(p.get("leftAt")) && matches(p))
        .or_else(|| participants.iter().position(&matches));
    let Some(index) = index else {
        return Ok(ApiError::not_found("Participant", Some(participant_id)).into_response());
    };
    let target = participants[index].clone();
    let target_user = text(&target, "userId").unwrap_or_default().to_owned();
    if target_user == caller.user_id {
        return Ok(ApiError::bad_request(
            "You cannot remove yourself from the call. Leave the call instead.",
        )
        .into_response());
    }
    if organizer
        .as_deref()
        .is_some_and(|o| !o.is_empty() && o == target_user)
    {
        return Ok(
            ApiError::bad_request("The meeting organizer cannot be removed from the call.")
                .into_response(),
        );
    }
    let guest = guest_email(&target_user);
    let already_blocked = guest
        .as_deref()
        .is_some_and(|email| guest_removed(&session["metadata"], email));
    let needs_kick = !truthy(target.get("leftAt"));
    let needs_block = guest.is_some() && !already_blocked;
    if !needs_kick && !needs_block {
        return Ok(
            Data(json!({ "ok": true, "kicked": false, "blocked": guest.is_some() }))
                .into_response(),
        );
    }
    let now = now();
    if needs_kick && let Some(entry) = participants[index].as_object_mut() {
        entry.insert("leftAt".into(), json!(now));
    }
    let removed = guest.as_ref().map(|email| {
        let mut entry = Map::new();
        entry.insert("removedAt".into(), json!(now));
        entry.insert("removedBy".into(), json!(caller.user_id));
        entry.insert("name".into(), target["userName"].clone());
        let mut map = Map::new();
        map.insert(email.clone(), Value::Object(entry));
        Value::Object(map).to_string()
    });
    sqlx::query(
        "update meeting_sessions set updated_at = $2::timestamp,
             participants = case when $3 then $4 else participants end,
             metadata = case when $5 then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('removedGuests', $6::jsonb || coalesce(metadata->'removedGuests', '{}'::jsonb)) else metadata end
         where id = $1",
    )
    .bind(id)
    .bind(&now)
    .bind(needs_kick)
    .bind(Value::Array(participants))
    .bind(removed.is_some() && needs_block)
    .bind(removed.as_deref().unwrap_or("{}"))
    .execute(db)
    .await?;
    let mut kicked = false;
    if needs_kick && let Some(room) = text(&session, "cfAppId").filter(|r| !r.is_empty()) {
        let video = caller.parts.video(state);
        let ids = vec![text(&target, "cfSessionId").unwrap_or_default().to_owned()];
        match video.kick_participants(room, &ids).await {
            Ok(()) => kicked = true,
            Err(error) => {
                tracing::error!(%error, session_id = id, room, "[meeting-sessions] RTK kick participant failed");
            }
        }
    }
    caller.publish(
        state,
        MEETING_SESSION_UPDATED,
        id,
        &json!({
            "id": id,
            "meetingId": session["meetingId"],
            "status": session["status"],
            "removedParticipantId": target.get("cfSessionId"),
            "removedBy": caller.user_id,
            "blocked": guest.is_some(),
        }),
    );
    Ok(Data(json!({ "ok": true, "kicked": kicked, "blocked": guest.is_some() })).into_response())
}

// ── GET /:id/recordings ────────────────────────────────────────────────────

async fn provider_recordings(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let row: Result<Option<(Option<String>, Option<String>)>, sqlx::Error> = sqlx::query_as(
        "select cf_app_id, recording_url from meeting_sessions where id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await;
    let (room, saved) = match row {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Session", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to get recordings"),
    };
    let mut recordings = Vec::new();
    if let Some(room) = room.filter(|r| !r.is_empty()) {
        recordings = caller
            .parts
            .video(&state)
            .list_recordings(&room)
            .await
            .unwrap_or_default();
    }
    Data(json!({ "recordings": recordings, "savedUrl": saved })).into_response()
}

// ── CRUD ───────────────────────────────────────────────────────────────────

/// The keyset condition's operands of a cursor: its `createdAt` as
/// JavaScript read it (milliseconds) and its id.
async fn cursor_row(db: &PgPool, cursor: &str) -> Result<Option<(String, String)>, sqlx::Error> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "select to_jsonb(t.created_at)#>>'{}', t.id from meeting_sessions t where t.id = $1 limit 1",
    )
    .bind(cursor)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(created, id)| {
        created
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .map(|stamp| (stamp, id))
    }))
}

const LIST_SQL: &str = "select to_jsonb(t) from meeting_sessions t
     where ($1::boolean or t.meeting_id = $2) and ($3::boolean or t.status = $4)
       and ($5::boolean or t.created_at < $6::timestamp or (t.created_at = $6::timestamp and t.id < $7))
     order by t.created_at desc, t.id desc limit $8";
const COUNT_SQL: &str = "select count(*) from meeting_sessions t
     where ($1::boolean or t.meeting_id = $2) and ($3::boolean or t.status = $4)
       and ($5::boolean or t.created_at < $6::timestamp or (t.created_at = $6::timestamp and t.id < $7))";

/// The skipped slots of the page and of its count: a `?cursor=` makes the
/// count drop the last condition (the cursor's, or the last filter when the
/// cursor row is gone).
fn slots(active: &[bool], cursor_given: bool) -> (Vec<bool>, Vec<bool>) {
    let page: Vec<bool> = active.iter().map(|a| !a).collect();
    let mut count = page.clone();
    if cursor_given && let Some(last) = count.iter().rposition(|skip| !skip) {
        count[last] = true;
    }
    (page, count)
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let meeting = query_param(query, "meetingId").filter(|v| !v.is_empty());
    let status = query_param(query, "status").filter(|v| !v.is_empty());
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "meet: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let active = [meeting.is_some(), status.is_some(), cursor_row.is_some()];
    let (page, count) = slots(&active, cursor.is_some());
    let bind = |sql: &'static str, skip: &[bool]| {
        sqlx::query_scalar::<_, Value>(sql)
            .bind(skip[0])
            .bind(meeting.clone())
            .bind(skip[1])
            .bind(status.clone())
            .bind(skip[2])
            .bind(cursor_row.as_ref().map(|(at, _)| at.clone()))
            .bind(cursor_row.as_ref().map(|(_, id)| id.clone()))
    };
    let rows: Result<Vec<Value>, sqlx::Error> = bind(LIST_SQL, &page)
        .bind(sql_limit(limit + 1.0))
        .fetch_all(db)
        .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(COUNT_SQL)
        .bind(count[0])
        .bind(meeting.clone())
        .bind(count[1])
        .bind(status.clone())
        .bind(count[2])
        .bind(cursor_row.as_ref().map(|(at, _)| at.clone()))
        .bind(cursor_row.as_ref().map(|(_, id)| id.clone()))
        .fetch_one(db)
        .await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => {
            return internal(&error, "Failed to list meeting sessions");
        }
    };
    page_of(
        rows.into_iter().map(|r| MEETING_SESSIONS.js(r)).collect(),
        limit,
        total,
    )
}

/// The list envelope of `rows` fetched with `limit + 1`.
pub(crate) fn page_of(rows: Vec<Value>, limit: f64, total: i64) -> Response {
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    let data = if has_more {
        #[allow(clippy::cast_possible_truncation)]
        js_slice(rows, limit as i64)
    } else {
        rows
    };
    let next = if has_more {
        data.last()
            .and_then(|row| text(row, "id"))
            .map(str::to_owned)
    } else {
        None
    };
    weldsuite_kit::List::new(
        data,
        weldsuite_kit::Pagination::new(u64::try_from(total).unwrap_or(0), has_more, next),
    )
    .into_response()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match session(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Meeting session", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch meeting session"),
    }
}

/// `createMeetingSessionSchema` (passthrough; its `.partial()` is the same).
fn read_session_body(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Map<String, Value>, Box<Response>> {
    validate(headers, body, |issues, fields| {
        let _ = issues.text(fields, "meetingId", Presence::Nullish, None, None);
        let _ = issues.text(fields, "status", Presence::Optional, None, Some(30));
        let _ = issues.text(fields, "startedAt", Presence::Optional, None, None);
        let _ = issues.text(fields, "endedAt", Presence::Optional, None, None);
        fields.clone()
    })
}

fn strip_server_owned(data: &Map<String, Value>) -> Map<String, Value> {
    data.iter()
        .filter(|(key, _)| !SERVER_OWNED.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn write_failed(error: &WriteError, message: &str) -> Response {
    internal(error, message)
}

async fn create(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match read_session_body(&headers, &body) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let mut data = strip_server_owned(&body);
    if let Some(meeting) = body.get("meetingId") {
        data.insert("meetingId".into(), meeting.clone());
    }
    let id = generate_id("msn");
    let now = now();
    let table = &MEETING_SESSIONS;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    values.extend(table.values(&data));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = table
        .insert(&caller.db, values, &["id", "createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, "Failed to create meeting session");
    }
    let status = data
        .get("status")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!("waiting"));
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    if let Some(meeting) = data.get("meetingId") {
        event.insert("meetingId".into(), meeting.clone());
    }
    event.insert("status".into(), status);
    if let Some(started_by) = data.get("startedBy") {
        event.insert("startedBy".into(), started_by.clone());
    }
    caller.publish(&state, MEETING_SESSION_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

async fn update(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match read_session_body(&headers, &body) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let data = strip_server_owned(&body);
    let existing = match session(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Meeting session", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to update meeting session"),
    };
    let table = &MEETING_SESSIONS;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(&data));
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    if let Err(error) = table.patch(&caller.db, &id, values, false, trusted).await {
        return write_failed(&error, "Failed to update meeting session");
    }
    let pick = |key: &str| {
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| existing.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    caller.publish(
        &state,
        MEETING_SESSION_UPDATED,
        &id,
        &json!({
            "id": id,
            "meetingId": pick("meetingId"),
            "status": pick("status"),
            "startedBy": pick("startedBy"),
        }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let Some(_) = session(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Meeting session", Some(&id)).into_response());
        };
        sqlx::query("delete from meeting_sessions where id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, MEETING_SESSION_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete meeting session"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejoins_keep_the_first_join_and_the_time_spent() {
        let next =
            json!({ "userId": "u", "joinedAt": "2026-10-01T10:10:00.000Z", "cfSessionId": "new" });
        let live =
            json!({ "userId": "u", "joinedAt": "2026-10-01T10:00:00.000Z", "peerIds": ["p1"] });
        let merged = merge_rejoin(Some(&live), next.clone());
        assert_eq!(merged["joinedAt"], "2026-10-01T10:00:00.000Z");
        assert_eq!(merged["lastJoinAt"], "2026-10-01T10:10:00.000Z");
        assert_eq!(merged["firstJoinedAt"], "2026-10-01T10:00:00.000Z");
        assert_eq!(merged["peerIds"], json!(["p1"]));
        let left = json!({ "userId": "u", "joinedAt": "2026-10-01T10:00:00.000Z", "leftAt": "2026-10-01T10:05:00.000Z" });
        let merged = merge_rejoin(Some(&left), next);
        assert_eq!(merged["joinedAt"], "2026-10-01T10:10:00.000Z");
        assert_eq!(merged["priorSeconds"], 300);
        assert_eq!(merged["stints"], 2);
        assert_eq!(guest_email("guest: Ann@X.io "), Some("ann@x.io".into()));
        assert!(guest_removed(
            &json!({ "removedGuests": { "ann@x.io": {} } }),
            "ANN@x.io"
        ));
    }
}
