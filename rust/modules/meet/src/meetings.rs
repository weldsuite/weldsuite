//! `/api/meetings` (`routes/meetings/index.ts`): the list (with each
//! meeting's organizer and, on request, its latest session), upcoming
//! meetings, recorded sessions, the AI price list, the join-code lookup, the
//! instant meeting, cancel, invitations, the per-meeting recording aliases,
//! host controls and the CRUD.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{MEETING_CREATED, MEETING_DELETED, MEETING_UPDATED};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_video_rooms::{HOST_PRESET, NewParticipant, RoomOptions};

use crate::attendees::{self, Attendee, Invitee, ResolvedInvitee};
use crate::billing::{self, BillingError};
use crate::invitations;
use crate::js::{iso_of_ms, js_limit, now_ms, query_param, sql_limit, text, truthy};
use crate::lifecycle;
use crate::participants::{self, Input};
use crate::recording::{self, Outcome};
use crate::sessions::{
    avatars, build_participant, ensure_presets, leave_other_calls_later, page_of, write_mappings,
};
use crate::tables::MEETINGS;
use crate::{Caller, MeetState, internal, now, publish, validate};

const MEETING_DENIED: &str = "You do not have access to this meeting";

/// The in-call host controls and their defaults (`DEFAULT_HOST_CONTROLS`).
const HOST_CONTROLS: &[(&str, &str)] = &[
    ("hostManagement", "true"),
    ("allowScreenShare", "true"),
    ("allowMicrophone", "true"),
    ("allowVideo", "true"),
    ("allowHandRaise", "true"),
    ("allowReactions", "true"),
    ("allowAnnotations", "true"),
    ("allowVirtualBackgrounds", "true"),
    ("allowParticipantRecord", "false"),
    ("allowThirdPartyAccess", "true"),
    ("noiseCancellation", "true"),
    ("enableCaptions", "false"),
    ("autoRecord", "false"),
    ("hostMustJoinFirst", "false"),
    ("lockAfterStart", "false"),
    ("autoEndOnInactivity", "true"),
    ("autoEndInactivityMinutes", "10"),
];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("meetings:read")))
        .route(
            "/upcoming",
            get(upcoming).route_layer(need("meetings:read")),
        )
        .route(
            "/recordings",
            get(recordings).route_layer(need("meetings:read")),
        )
        .route(
            "/ai-pricing",
            get(ai_pricing).route_layer(need("meetings:read")),
        )
        .route(
            "/join/{code}",
            get(join_code).route_layer(need("meetings:read")),
        )
        .route(
            "/start-instant",
            post(start_instant).route_layer(need("meetings:create")),
        )
        .route(
            "/{id}/cancel",
            patch(cancel).route_layer(need("meetings:update")),
        )
        .route(
            "/{id}/invitations",
            post(invite).route_layer(need("meetings:update")),
        )
        .route(
            "/{id}/recording",
            get(recording_alias).route_layer(need("meetings:read")),
        )
        .route(
            "/{id}/recording/transcribe",
            post(transcribe_alias)
                .route_layer(need("recordings:read"))
                .route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/recording/transcription",
            get(transcription_alias).route_layer(need("meetings:read")),
        )
        .route(
            "/{id}/recording/transcription-status",
            get(transcription_status_alias).route_layer(need("meetings:read")),
        )
        .route("/{id}", get(detail).route_layer(need("meetings:read")))
        .route("/", post(create).route_layer(need("meetings:create")))
        .route("/{id}", patch(update).route_layer(need("meetings:update")))
        .route(
            "/{id}/host-controls",
            patch(host_controls).route_layer(need("meetings:read")),
        )
        .route("/{id}", delete(remove).route_layer(need("meetings:delete")))
}

/// `scopeFor(c)`: the organizer the caller is limited to, or none with
/// `meetings:scope:all`.
fn scope(caller: &Caller) -> Option<String> {
    (!caller.can("meetings:scope:all")).then(|| caller.user_id.clone())
}

fn org_of(caller: &Caller) -> Result<String, Box<Response>> {
    caller
        .org_id
        .clone()
        .ok_or_else(|| Box::new(ApiError::org_required().into_response()))
}

fn forbidden(message: &str) -> Response {
    ApiError::forbidden().with_message(message).into_response()
}

/// The live meeting `id`, limited to `scope`'s organizer when given.
async fn live_meeting(
    db: &PgPool,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meetings t
         where t.id = $1 and t.deleted_at is null and ($2::text is null or t.organizer_id = $2) limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| MEETINGS.js(row)))
}

// ============================================================================
// GET /
// ============================================================================

const LIST_SQL: &str = "select to_jsonb(t) from meetings t
     where ($1::boolean or t.deleted_at is null)
       and ($2::boolean or t.organizer_id = $3)
       and ($4::boolean or t.title like $5)
       and ($6::boolean or t.status = any($7))
       and ($8::boolean or t.attendees @> $9::jsonb)
       and ($10::boolean or (t.attendees @> $11::jsonb or t.attendees @> $12::jsonb))
       and ($13::boolean or (t.status in ('scheduled', 'in_progress') and (t.status = 'in_progress' or t.scheduled_start is null or coalesce(t.scheduled_end, t.scheduled_start + interval '1 hour') >= (now() at time zone 'utc'))))
       and ($14::boolean or (t.status in ('completed', 'failed', 'cancelled') or exists (select 1 from meeting_sessions ms where ms.meeting_id = t.id and ms.status = 'ended')))
       and ($15::boolean or t.created_at < $16::timestamp or (t.created_at = $16::timestamp and t.id < $17))
     order by t.created_at desc, t.id desc limit $18";

/// The list's filter values, in the order the route pushes its conditions.
struct Filters {
    scope: Option<String>,
    search: Option<String>,
    statuses: Option<Vec<String>>,
    counterparty: Option<String>,
    person: Option<(String, String)>,
    upcoming: bool,
    history: bool,
    cursor: Option<(String, String)>,
}

impl Filters {
    /// Whether each condition is there (`[live, scope, search, status,
    /// counterparty, person, upcoming, history, cursor]`).
    fn active(&self) -> [bool; 9] {
        [
            true,
            self.scope.is_some(),
            self.search.is_some(),
            self.statuses.is_some(),
            self.counterparty.is_some(),
            self.person.is_some(),
            self.upcoming,
            self.history,
            self.cursor.is_some(),
        ]
    }

    fn bind(
        &self,
        sql: &'static str,
        skip: &[bool; 9],
    ) -> sqlx::query::QueryScalar<'static, sqlx::Postgres, Value, sqlx::postgres::PgArguments> {
        sqlx::query_scalar(sql)
            .bind(skip[0])
            .bind(skip[1])
            .bind(self.scope.clone())
            .bind(skip[2])
            .bind(self.search.clone())
            .bind(skip[3])
            .bind(self.statuses.clone())
            .bind(skip[4])
            .bind(self.counterparty.clone())
            .bind(skip[5])
            .bind(self.person.as_ref().map(|(a, _)| a.clone()))
            .bind(self.person.as_ref().map(|(_, b)| b.clone()))
            .bind(skip[6])
            .bind(skip[7])
            .bind(skip[8])
            .bind(self.cursor.as_ref().map(|(at, _)| at.clone()))
            .bind(self.cursor.as_ref().map(|(_, id)| id.clone()))
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let value = |name: &str| query_param(query, name).filter(|v| !v.is_empty());
    let statuses = value("status").and_then(|raw| {
        let list: Vec<String> = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        (!list.is_empty()).then_some(list)
    });
    let view = query_param(query, "view");
    let cursor = value("cursor");
    let cursor_row = match &cursor {
        Some(cursor) => {
            let row: Result<Option<(Option<String>, String)>, sqlx::Error> = sqlx::query_as(
                "select to_jsonb(t.created_at)#>>'{}', t.id from meetings t where t.id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(db)
            .await;
            match row {
                Ok(row) => row.and_then(|(at, id)| {
                    at.and_then(|s| weldsuite_db::js_timestamp(&s))
                        .map(|at| (at, id))
                }),
                Err(error) => {
                    tracing::error!(%error, "meet: cursor lookup failed");
                    return ApiError::internal().into_response();
                }
            }
        }
        None => None,
    };
    let filters = Filters {
        scope: scope(&caller),
        search: value("search").map(|s| format!("%{s}%")),
        statuses,
        counterparty: value("counterpartyId")
            .map(|id| json!([{ "counterpartyId": id }]).to_string()),
        person: value("personId").map(|id| {
            (
                json!([{ "personId": id }]).to_string(),
                json!([{ "contactId": id }]).to_string(),
            )
        }),
        upcoming: view.as_deref() == Some("upcoming"),
        history: view.as_deref() == Some("history"),
        cursor: cursor_row,
    };
    let active = filters.active();
    let page = active.map(|a| !a);
    let mut count = page;
    if cursor.is_some()
        && let Some(last) = count.iter().rposition(|skip| !skip)
    {
        count[last] = true;
    }
    let rows: Result<Vec<Value>, sqlx::Error> = filters
        .bind(LIST_SQL, &page)
        .bind(sql_limit(limit + 1.0))
        .fetch_all(db)
        .await;
    let total: Result<Value, sqlx::Error> =
        filters.bind(COUNT_SQL_JSON, &count).fetch_one(db).await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total.as_i64().unwrap_or(0)),
        (Err(error), _) | (_, Err(error)) => return internal(&error, "Failed to list meetings"),
    };
    let rows: Vec<Value> = rows.into_iter().map(|r| MEETINGS.js(r)).collect();
    let include_last = query_param(query, "include")
        .unwrap_or_default()
        .split(',')
        .any(|part| part.trim() == "lastSession");
    match decorate(db, &rows, include_last).await {
        Ok(items) => page_of(items, limit, total),
        Err(error) => internal(&error, "Failed to list meetings"),
    }
}

/// The list's count as a JSON scalar, so both statements bind alike.
const COUNT_SQL_JSON: &str = "select to_jsonb(c.n) from (select count(*) as n from meetings t
     where ($1::boolean or t.deleted_at is null)
       and ($2::boolean or t.organizer_id = $3)
       and ($4::boolean or t.title like $5)
       and ($6::boolean or t.status = any($7))
       and ($8::boolean or t.attendees @> $9::jsonb)
       and ($10::boolean or (t.attendees @> $11::jsonb or t.attendees @> $12::jsonb))
       and ($13::boolean or (t.status in ('scheduled', 'in_progress') and (t.status = 'in_progress' or t.scheduled_start is null or coalesce(t.scheduled_end, t.scheduled_start + interval '1 hour') >= (now() at time zone 'utc'))))
       and ($14::boolean or (t.status in ('completed', 'failed', 'cancelled') or exists (select 1 from meeting_sessions ms where ms.meeting_id = t.id and ms.status = 'ended')))
       and ($15::boolean or t.created_at < $16::timestamp or (t.created_at = $16::timestamp and t.id < $17))) c";

/// `decorateMeetings(db, rows, include)`: each meeting's `organizer` and,
/// with `?include=lastSession`, its newest session.
async fn decorate(
    db: &PgPool,
    rows: &[Value],
    include_last: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut organizer_ids: Vec<String> = Vec::new();
    for row in rows {
        if let Some(id) = text(row, "organizerId")
            && !organizer_ids.iter().any(|known| known == id)
        {
            organizer_ids.push(id.to_owned());
        }
    }
    let mut organizers: HashMap<String, Value> = HashMap::new();
    if !organizer_ids.is_empty() {
        let members: Vec<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "select user_id, name, email, picture from workspace_members where user_id = any($1)",
        )
        .bind(&organizer_ids)
        .fetch_all(db)
        .await?;
        for (user, name, email, picture) in members {
            organizers.entry(user.clone()).or_insert_with(|| {
                let display = name
                    .filter(|n| !n.is_empty())
                    .or_else(|| email.filter(|e| !e.is_empty()))
                    .unwrap_or_default();
                json!({ "userId": user, "name": display, "avatar": picture })
            });
        }
    }
    let mut last: HashMap<String, Value> = HashMap::new();
    if include_last && !rows.is_empty() {
        let ids: Vec<String> = rows
            .iter()
            .filter_map(|r| text(r, "id").map(str::to_owned))
            .collect();
        let sessions: Vec<Value> = sqlx::query_scalar(
            "select distinct on (t.meeting_id) to_jsonb(t) from meeting_sessions t
             where t.meeting_id = any($1)
             order by t.meeting_id, t.created_at desc, t.id desc",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?;
        for session in sessions {
            let s = crate::tables::MEETING_SESSIONS.js(session);
            let participants: Vec<Value> = s["participants"]
                .as_array()
                .map(|all| {
                    all.iter()
                        .map(|p| {
                            let mut out = Map::new();
                            for key in [
                                "userId",
                                "userName",
                                "userAvatar",
                                "joinedAt",
                                "leftAt",
                                "firstJoinedAt",
                                "priorSeconds",
                                "stints",
                            ] {
                                if let Some(value) = p.get(key) {
                                    out.insert(key.into(), value.clone());
                                }
                            }
                            Value::Object(out)
                        })
                        .collect()
                })
                .unwrap_or_default();
            let meeting = text(&s, "meetingId").unwrap_or_default().to_owned();
            last.insert(
                meeting,
                json!({
                    "id": s["id"],
                    "status": s["status"],
                    "startedAt": s["startedAt"],
                    "endedAt": s["endedAt"],
                    "duration": s["duration"],
                    "recordingStatus": s["recordingStatus"],
                    "participants": participants,
                }),
            );
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            let mut item = row.as_object().cloned().unwrap_or_default();
            let organizer = text(row, "organizerId")
                .and_then(|id| organizers.get(id).cloned())
                .unwrap_or(Value::Null);
            item.insert("organizer".into(), organizer);
            if include_last {
                let session = text(row, "id")
                    .and_then(|id| last.get(id).cloned())
                    .unwrap_or(Value::Null);
                item.insert("lastSession".into(), session);
            }
            Value::Object(item)
        })
        .collect())
}

// ============================================================================
// GET /upcoming, /recordings, /ai-pricing, /join/:code
// ============================================================================

async fn upcoming(caller: Caller, RawQuery(query): RawQuery) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let query = query.as_deref();
    let number = |name: &str, fallback: &str| {
        weldsuite_kit::validation::js_number(
            &query_param(query, name).unwrap_or_else(|| fallback.to_owned()),
        )
    };
    let days = number("days", "7");
    let limit = number("limit", "20").min(100.0);
    let now = now_ms();
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let future = now as f64 + days * 24.0 * 60.0 * 60.0 * 1000.0;
    if !future.is_finite() || future.abs() > 8.64e15 {
        return internal(
            &"RangeError: Invalid time value",
            "Failed to list upcoming meetings",
        );
    }
    #[allow(clippy::cast_possible_truncation)]
    let future = iso_of_ms(future as i64);
    let needle = json!([{ "userId": caller.user_id }]).to_string();
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from meetings t
         where t.deleted_at is null and (t.status = 'scheduled' or t.status = 'in_progress')
           and (t.organizer_id = $1 or t.attendees::jsonb @> $2::jsonb)
           and t.scheduled_start >= $3::timestamp and t.scheduled_start <= $4::timestamp
         order by t.scheduled_start limit $5",
    )
    .bind(&caller.user_id)
    .bind(&needle)
    .bind(iso_of_ms(now))
    .bind(&future)
    .bind(sql_limit(limit))
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter().map(|r| MEETINGS.js(r)).collect(),
        ))
        .into_response(),
        Err(error) => internal(&error, "Failed to list upcoming meetings"),
    }
}

async fn recordings(caller: Caller) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let scope = scope(&caller);
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object(
             'sessionId', ms.id,
             'meetingId', ms.meeting_id,
             'cfAppId', ms.cf_app_id,
             'recordingStatus', ms.recording_status,
             'recordingAudioKey', ms.recording_audio_key,
             'recordingDurationSeconds', ms.recording_duration_seconds,
             'recordingSizeBytes', ms.recording_size_bytes,
             'summaryStatus', ms.summary_status,
             'hasTranscript', exists (select 1 from crm_transcriptions ct where ct.activity_id = ms.id and ct.status = 'completed'),
             'startedAt', ms.started_at,
             'endedAt', ms.ended_at,
             'duration', ms.duration,
             'maxParticipants', ms.max_participants,
             'meetingTitle', t.title,
             'meetingType', t.meeting_type)
         from meeting_sessions ms inner join meetings t on ms.meeting_id = t.id
         where (ms.recording_status is not null or ms.recording_url is not null or ms.recording_key is not null)
           and (ms.recording_status is null or ms.recording_status <> 'deleted')
           and t.deleted_at is null
           and ($1::text is null or t.organizer_id = $1)
         order by ms.started_at desc limit 50",
    )
    .bind(scope)
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to list recordings"),
    };
    let items: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let audio = row
                .as_object_mut()
                .and_then(|o| o.remove("recordingAudioKey"));
            let summary = row.as_object_mut().and_then(|o| o.remove("summaryStatus"));
            for key in ["startedAt", "endedAt"] {
                if let Some(stamp) = row[key].as_str().and_then(weldsuite_db::js_timestamp) {
                    row[key] = json!(stamp);
                }
            }
            row["recordingUrl"] = Value::Null;
            row["recordingKey"] = Value::Null;
            row["hasAudio"] = json!(truthy(audio.as_ref()));
            row["hasSummary"] =
                json!(summary.as_ref().and_then(Value::as_str) == Some("completed"));
            row
        })
        .collect();
    Data(Value::Array(items)).into_response()
}

async fn ai_pricing(State(state): State<MeetState>, caller: Caller) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let cache = caller.parts.cache(&state);
    let master = caller.parts.master(&state);
    let pricing = billing::pricing(cache.as_ref(), master.as_ref()).await;
    let workspace = match billing::metering(master.as_ref(), &org).await {
        Ok(workspace) => workspace,
        Err(BillingError::Unavailable) => {
            return ApiError::unavailable("Credit metering is unavailable for this workspace")
                .into_response();
        }
        Err(error) => return internal(&format!("{error:?}"), "Failed to load pricing"),
    };
    let Some(master) = master else {
        return internal(&"no master database", "Failed to load pricing");
    };
    match billing::balance(&master, &workspace).await {
        Ok(balance) => {
            let mut body = pricing.json();
            body.insert("balance".into(), json!(balance));
            Data(Value::Object(body)).into_response()
        }
        Err(error) => internal(&error, "Failed to load pricing"),
    }
}

async fn join_code(caller: Caller, Path(code): Path<String>) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let row: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from meetings t where t.join_code = $1 and t.deleted_at is null limit 1",
    )
    .bind(&code)
    .fetch_optional(&caller.db)
    .await;
    match row {
        Ok(Some(row)) => Data(MEETINGS.js(row)).into_response(),
        Ok(None) => ApiError::not_found("Meeting", None).into_response(),
        Err(error) => internal(&error, "Failed to resolve join code"),
    }
}

// ============================================================================
// POST /start-instant
// ============================================================================

/// `generateJoinCode()`: `wm-abc-def-ghi` from the random source.
pub(crate) fn join_code_new() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    let segment = || {
        let mut bytes = [0_u8; 3];
        getrandom::fill(&mut bytes).expect("the operating system has a random source");
        bytes
            .iter()
            .map(|b| char::from(ALPHABET[usize::from(*b) % ALPHABET.len()]))
            .collect::<String>()
    };
    format!("wm-{}-{}-{}", segment(), segment(), segment())
}

struct InstantInput {
    title: Option<String>,
    meeting_type: Option<String>,
    access_type: Option<String>,
    waiting_room: Option<bool>,
}

async fn start_instant(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| InstantInput {
        title: issues
            .text(fields, "title", Presence::Optional, None, Some(255))
            .into_option(),
        meeting_type: issues
            .choice(
                fields,
                "meetingType",
                Presence::Optional,
                &["video", "audio"],
            )
            .into_option(),
        access_type: issues
            .choice(
                fields,
                "accessType",
                Presence::Optional,
                &["workspace", "invited_only", "anyone_with_link"],
            )
            .into_option(),
        waiting_room: issues
            .boolean(fields, "waitingRoom", Presence::Optional)
            .into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let started = now_ms();
    instant(&state, &caller, &org, &input, started)
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to start instant meeting"))
}

async fn instant(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    input: &InstantInput,
    started: i64,
) -> Result<Response, String> {
    let db = &caller.db;
    let member: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, email, picture from workspace_members where user_id = $1 limit 1",
    )
    .bind(&caller.user_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let (name, email, picture) = member.unwrap_or((None, None, None));
    let user_name = name.unwrap_or_else(|| "Unknown".to_owned());

    let t0 = now_ms();
    let meeting_id = generate_id("mtg");
    let session_id = generate_id("msess");
    let join_code = join_code_new();
    let now = now();
    let title = input
        .title
        .clone()
        .unwrap_or_else(|| "Instant Meeting".to_owned());
    let meeting_type = input
        .meeting_type
        .clone()
        .unwrap_or_else(|| "video".to_owned());
    let access_type = input
        .access_type
        .clone()
        .unwrap_or_else(|| "anyone_with_link".to_owned());
    let waiting_room = input.waiting_room.unwrap_or(true);
    let mut timings = Map::new();

    ensure_presets(state, caller).await?;
    timings.insert("presets".into(), json!(now_ms() - t0));
    let video = caller.parts.video(state);
    let options = RoomOptions {
        audio_export: true,
        ..RoomOptions::default()
    };
    let store = avatars(state, caller);
    let (room, link) = tokio::join!(
        video.create_room_with(&title, &options),
        participants::resolve(
            db,
            &store,
            org,
            Input {
                user_id: Some(&caller.user_id),
                email: email.as_deref(),
                name: Some(&user_name),
            },
        )
    );
    let room = room.map_err(|e| e.to_string())?;
    timings.insert("rtkCreate".into(), json!(now_ms() - t0));
    let avatar = link.avatar_url.clone().or_else(|| picture.clone());
    let joined = video
        .add_participant(
            &room,
            &NewParticipant {
                name: user_name.clone(),
                custom_participant_id: caller.user_id.clone(),
                preset_name: Some(HOST_PRESET.to_owned()),
                picture: avatar.clone().filter(|a| !a.is_empty()),
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    timings.insert("rtkJoin".into(), json!(now_ms() - t0));
    let mut first = build_participant(
        &caller.user_id,
        &user_name,
        avatar.as_deref(),
        &link,
        &joined.participant_id,
    );
    first["joinedAt"] = json!(now);
    let mut organizer = Map::new();
    organizer.insert("userId".into(), json!(caller.user_id));
    organizer.insert("email".into(), json!(email.clone().unwrap_or_default()));
    organizer.insert("name".into(), json!(user_name));
    organizer.insert("status".into(), json!("accepted"));
    organizer.insert("role".into(), json!("organizer"));
    if let Some(member) = link
        .workspace_member_id
        .as_deref()
        .filter(|m| !m.is_empty())
    {
        organizer.insert("workspaceMemberId".into(), json!(member));
    }
    if let Some(person) = link.person_id.as_deref().filter(|p| !p.is_empty()) {
        organizer.insert("personId".into(), json!(person));
    }
    sqlx::query(
        "insert into meetings (id, title, organizer_id, attendees, meeting_type, status, access_type,
             waiting_room, allow_recording, join_code, active_session_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 'in_progress', $6, $7, true, $8, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&meeting_id)
    .bind(&title)
    .bind(&caller.user_id)
    .bind(json!([organizer]))
    .bind(&meeting_type)
    .bind(&access_type)
    .bind(waiting_room)
    .bind(&join_code)
    .bind(&session_id)
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "insert into meeting_sessions (id, meeting_id, session_type, status, cf_app_id, started_by,
             started_by_name, participants, max_participants, started_at, created_at, updated_at)
         values ($1, $2, $3, 'active', $4, $5, $6, $7, 1, $8::timestamp, $8::timestamp, $8::timestamp)",
    )
    .bind(&session_id)
    .bind(&meeting_id)
    .bind(&meeting_type)
    .bind(&room)
    .bind(&caller.user_id)
    .bind(&user_name)
    .bind(json!([first]))
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    timings.insert("dbWrite".into(), json!(now_ms() - t0));
    write_mappings(state, caller, &room, org, &session_id, &meeting_id);
    timings.insert("total".into(), json!(now_ms() - t0));

    leave_other_calls_later(state, caller, org, &session_id, started, None);
    caller.publish(
        state,
        MEETING_CREATED,
        &meeting_id,
        &json!({ "id": meeting_id, "title": title, "status": "in_progress", "hostId": caller.user_id }),
    );
    Ok(Created(json!({
        "meetingId": meeting_id,
        "sessionId": session_id,
        "rtkMeetingId": room,
        "authToken": joined.token,
        "joinCode": join_code,
        "participants": [first],
        "timings": timings,
    }))
    .into_response())
}

// ============================================================================
// PATCH /:id/cancel
// ============================================================================

async fn cancel(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let result: Result<Response, sqlx::Error> = async {
        let Some(existing) = live_meeting(&caller.db, &id, None).await? else {
            return Ok(ApiError::not_found("Meeting", Some(&id)).into_response());
        };
        if let Some(scope) = scope(&caller)
            && text(&existing, "organizerId") != Some(scope.as_str())
        {
            return Ok(forbidden(MEETING_DENIED));
        }
        if text(&existing, "status") == Some("cancelled") {
            return Ok(ApiError::bad_request("Meeting is already cancelled").into_response());
        }
        sqlx::query("update meetings set status = 'cancelled', updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
        publish::meeting_updated(&state, &org, json!({ "meetingId": id, "status": "cancelled" })).await;
        caller.publish(
            &state,
            MEETING_UPDATED,
            &id,
            &json!({ "id": id, "title": existing["title"], "status": "cancelled", "hostId": existing["organizerId"] }),
        );
        Ok(Data(json!({ "ok": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to cancel meeting"))
}

// ============================================================================
// POST /:id/invitations
// ============================================================================

/// `z.string().trim().email().max(255)`.
const EMAIL: Text = Text {
    trim: true,
    lowercase: false,
    format: Some(Format::Email),
    min: None,
    max: Some(255),
};

fn read_invitee(issues: &mut Issues, item: &Value) -> Option<Invitee> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let email = issues
        .text_with(fields, "email", Presence::Required, EMAIL)
        .into_option();
    let name = issues
        .text_with(
            fields,
            "name",
            Presence::Optional,
            Text::trimmed(None, Some(255)),
        )
        .into_option();
    if issues.count() > before {
        return None;
    }
    Some(Invitee {
        email: email.unwrap_or_default(),
        name,
    })
}

async fn invite(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let invitees = issues
            .list(
                fields,
                "invitees",
                Presence::Required,
                Some(1),
                Some(50),
                read_invitee,
            )
            .into_option();
        let send_email = issues
            .boolean(fields, "sendEmail", Presence::Optional)
            .into_option();
        (invitees.unwrap_or_default(), send_email)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    invite_people(&state, &caller, &org, &id, input.0, input.1)
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to invite people"))
}

async fn invite_people(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    id: &str,
    invitees: Vec<Invitee>,
    send_email: Option<bool>,
) -> Result<Response, String> {
    let db = &caller.db;
    let Some(existing) = live_meeting(db, id, None)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(ApiError::not_found("Meeting", Some(id)).into_response());
    };
    let current = attendees::stored(&existing);
    let organizer_id = text(&existing, "organizerId")
        .unwrap_or_default()
        .to_owned();
    if organizer_id != caller.user_id
        && !attendees::is_invited_member(&current, &caller.user_id)
        && scope(caller).is_some()
    {
        return Ok(forbidden(MEETING_DENIED));
    }
    if matches!(text(&existing, "status"), Some("cancelled" | "completed")) {
        return Ok(ApiError::bad_request(
            "Cannot invite people to a meeting that has ended or was cancelled",
        )
        .into_response());
    }
    let Some(join_code) = text(&existing, "joinCode")
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
    else {
        return Ok(ApiError::bad_request("Meeting has no join link").into_response());
    };
    let store = avatars(state, caller);
    let mut resolved = Vec::new();
    for invitee in attendees::normalize_invitees(invitees) {
        let link = participants::resolve(
            db,
            &store,
            org,
            Input {
                email: Some(&invitee.email),
                name: invitee.name.as_deref(),
                user_id: None,
            },
        )
        .await;
        let mut user_id = String::new();
        if let Some(member) = link
            .workspace_member_id
            .as_deref()
            .filter(|m| !m.is_empty())
        {
            let user: Option<String> =
                sqlx::query_scalar("select user_id from workspace_members where id = $1 limit 1")
                    .bind(member)
                    .fetch_optional(db)
                    .await
                    .map_err(|e| e.to_string())?;
            user_id = user.unwrap_or_default();
        }
        let name = link
            .display_name
            .clone()
            .filter(|n| !n.is_empty())
            .or_else(|| invitee.name.clone().filter(|n| !n.is_empty()))
            .unwrap_or_else(|| invitee.email.clone());
        resolved.push(ResolvedInvitee {
            email: invitee.email,
            name,
            user_id,
            avatar: link.avatar_url,
            workspace_member_id: link.workspace_member_id,
            person_id: link.person_id,
        });
    }
    let (all, added, already) = attendees::merge_invitees(&current, &resolved);
    if !added.is_empty() {
        let list: Vec<Value> = all.iter().cloned().map(Value::Object).collect();
        sqlx::query(
            "update meetings set attendees = $2, updated_at = $3::timestamp where id = $1 and deleted_at is null",
        )
        .bind(id)
        .bind(Value::Array(list))
        .bind(now())
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
        caller.publish(
            state,
            MEETING_UPDATED,
            id,
            &json!({ "id": id, "title": existing["title"], "status": existing["status"], "hostId": existing["organizerId"] }),
        );
        publish::meeting_updated(
            state,
            org,
            json!({ "meetingId": id, "title": existing["title"] }),
        )
        .await;
    }
    let people: Vec<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select wm.user_id, wm.name, wm.email, up.timezone from workspace_members wm
         left join user_preferences up on up.user_id = wm.user_id
         where wm.user_id = any($1)",
    )
    .bind(vec![caller.user_id.clone(), organizer_id.clone()])
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    let inviter = people.iter().find(|p| p.0 == caller.user_id);
    let organizer = people.iter().find(|p| p.0 == organizer_id).or(inviter);
    let portal = invitations::portal_url(caller.parts.env("MEETING_PORTAL_URL").as_deref());
    let join_url = invitations::join_url(&portal, org, &join_code);
    let recipients: Vec<(String, Option<String>)> = added
        .iter()
        .map(|a| {
            (
                text(&Value::Object(a.clone()), "email")
                    .unwrap_or_default()
                    .to_owned(),
                a.get("name").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect();
    let sent = if send_email == Some(false) {
        vec![false; added.len()]
    } else {
        let meeting = invitations::Meeting {
            id: id.to_owned(),
            title: text(&existing, "title").unwrap_or_default().to_owned(),
            description: text(&existing, "description").map(str::to_owned),
            scheduled_start: text(&existing, "scheduledStart").map(str::to_owned),
            scheduled_end: text(&existing, "scheduledEnd").map(str::to_owned),
        };
        let person = invitations::Organizer {
            name: inviter
                .and_then(|p| p.1.clone().filter(|n| !n.is_empty()))
                .or_else(|| organizer.and_then(|p| p.1.clone().filter(|n| !n.is_empty())))
                .unwrap_or_else(|| "Someone".to_owned()),
            email: organizer.and_then(|p| p.2.clone()).unwrap_or_default(),
            timezone: organizer.and_then(|p| p.3.clone()),
        };
        let batch = invitations::Batch {
            db,
            clerk_org_id: org,
            bindings: caller.parts.outbound(state),
            master: caller.parts.master(state),
            cache: caller.parts.cache(state),
            from_override: caller.parts.env("SYSTEM_EMAIL_FROM"),
            meeting: &meeting,
            organizer: &person,
            join_url: &join_url,
        };
        invitations::send_all(&batch, &recipients).await
    };
    let invited: Vec<Value> = added
        .iter()
        .zip(&sent)
        .map(|(a, sent)| json!({ "email": a["email"], "name": a["name"], "emailSent": sent }))
        .collect();
    let list: Vec<Value> = all.into_iter().map(Value::Object).collect();
    Ok(
        Data(json!({ "attendees": list, "invited": invited, "alreadyInvited": already }))
            .into_response(),
    )
}

// ============================================================================
// Per-meeting recording aliases
// ============================================================================

/// `resolveRecordedSession(c, meetingId, { legacyOk })`: the latest session
/// with recorder state after the meeting-level access check.
async fn recorded_session(
    caller: &Caller,
    meeting_id: &str,
    legacy_ok: bool,
) -> Result<Result<Option<Value>, Response>, String> {
    let organizer: Option<String> = sqlx::query_scalar(
        "select organizer_id from meetings where id = $1 and deleted_at is null limit 1",
    )
    .bind(meeting_id)
    .fetch_optional(&caller.db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(organizer) = organizer else {
        return Ok(Err(
            ApiError::not_found("Meeting", Some(meeting_id)).into_response()
        ));
    };
    if let Some(scope) = scope(caller)
        && organizer != scope
    {
        return Ok(Err(forbidden(MEETING_DENIED)));
    }
    let session = recording::latest_recorded_session(&caller.db, meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    if session.is_none() && !legacy_ok {
        return Ok(Err(ApiError::not_found("Recording", None).into_response()));
    }
    Ok(Ok(session))
}

async fn recording_alias(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let org = match org_of(&caller) {
        Ok(org) => org,
        Err(response) => return *response,
    };
    let outcome: Outcome = async {
        let session = match recorded_session(&caller, &id, true).await? {
            Ok(Some(session)) => session,
            Ok(None) => return Ok(Data(Value::Null).into_response()),
            Err(response) => return Ok(response),
        };
        let session_id = text(&session, "id").unwrap_or_default().to_owned();
        let auth = match recording::authorize(&caller, &session_id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let current = recording::reconcile(&state, &caller, &org, auth.session).await;
        let info = recording::recording_info(&caller.db, &current)
            .await
            .map_err(|e| e.to_string())?;
        let mut access = json!({ "url": null, "audioUrl": null, "expiresAt": null });
        if text(&info, "status") == Some("ready") {
            let minted =
                recording::mint_access(&state, &caller, &current, auth.meeting.as_ref()).await?;
            if minted.status() != http::StatusCode::OK {
                return Ok(minted);
            }
            let bytes = axum::body::to_bytes(minted.into_body(), usize::MAX)
                .await
                .map_err(|e| e.to_string())?;
            let body: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            access = body["data"].clone();
        }
        let mut out = info.as_object().cloned().unwrap_or_default();
        out.insert("duration".into(), session["duration"].clone());
        out.insert("url".into(), access["url"].clone());
        out.insert("audioUrl".into(), access["audioUrl"].clone());
        out.insert("expiresAt".into(), access["expiresAt"].clone());
        Ok(Data(Value::Object(out)).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to get recording"))
}

async fn transcribe_alias(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let language = match recording::read_transcribe_body(&body) {
        Ok(language) => language,
        Err(response) => return *response,
    };
    let outcome: Outcome = async {
        let session = match recorded_session(&caller, &id, false).await? {
            Ok(Some(session)) => session,
            Ok(None) => return Ok(ApiError::not_found("Recording", None).into_response()),
            Err(response) => return Ok(response),
        };
        let session_id = text(&session, "id").unwrap_or_default().to_owned();
        recording::transcribe_session(&state, &caller, &session_id, language).await
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to trigger transcription"))
}

/// `findMeetingTranscription(c, meetingId, session)`: the session's, else the
/// legacy one keyed by the meeting.
async fn meeting_transcription(
    db: &PgPool,
    meeting_id: &str,
    session: Option<&Value>,
) -> Result<Option<Value>, String> {
    if let Some(session) = session
        && let Some(own) =
            recording::find_transcription(db, text(session, "id").unwrap_or_default())
                .await
                .map_err(|e| e.to_string())?
    {
        return Ok(Some(own));
    }
    recording::find_transcription(db, meeting_id)
        .await
        .map_err(|e| e.to_string())
}

async fn transcription_alias(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let outcome: Outcome = async {
        let session = match recorded_session(&caller, &id, true).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
        let Some(found) = meeting_transcription(&caller.db, &id, session.as_ref()).await? else {
            return Ok(ApiError::not_found("Transcription", None).into_response());
        };
        let payload = recording::transcription_payload(&caller.db, &found, session.as_ref())
            .await
            .map_err(|e| e.to_string())?;
        Ok(Data(payload).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription"))
}

async fn transcription_status_alias(caller: Caller, Path(id): Path<String>) -> Response {
    if let Err(response) = org_of(&caller) {
        return *response;
    }
    let outcome: Outcome = async {
        let session = match recorded_session(&caller, &id, true).await? {
            Ok(session) => session,
            Err(response) => return Ok(response),
        };
        let found = meeting_transcription(&caller.db, &id, session.as_ref()).await?;
        Ok(Data(recording::transcription_status(
            found.as_ref(),
            session.as_ref(),
        ))
        .into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription status"))
}

// ============================================================================
// CRUD
// ============================================================================

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let scope = scope(&caller);
    match live_meeting(&caller.db, &id, scope.as_deref()).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Meeting", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch meeting"),
    }
}

/// The written meeting fields, as the schema read them: `None` absent,
/// `Some(Value::Null)` null.
#[derive(Default)]
struct MeetingBody {
    fields: Vec<(&'static str, Value)>,
    attendees: Option<Vec<Attendee>>,
    organizer_id: Option<String>,
}

fn set_field<T: Into<Value>>(
    out: &mut Vec<(&'static str, Value)>,
    key: &'static str,
    field: Field<T>,
) {
    match field {
        Field::Set(value) => out.push((key, value.into())),
        Field::Null => out.push((key, Value::Null)),
        Field::Absent => {}
    }
}

/// `meetingAttendeeInputSchema`: only its keys, values as Zod returns them.
fn read_attendee(issues: &mut Issues, item: &Value) -> Option<Attendee> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let mut out = Map::new();
    let keep = |out: &mut Map<String, Value>, key: &str, field: Field<String>| match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    };
    keep(
        &mut out,
        "userId",
        issues.text(fields, "userId", Presence::Optional, None, Some(255)),
    );
    keep(
        &mut out,
        "email",
        issues.text_with(fields, "email", Presence::Required, EMAIL),
    );
    keep(
        &mut out,
        "name",
        issues.text_with(
            fields,
            "name",
            Presence::Optional,
            Text::trimmed(None, Some(255)),
        ),
    );
    keep(
        &mut out,
        "avatar",
        issues.text(fields, "avatar", Presence::Nullish, None, Some(2048)),
    );
    keep(
        &mut out,
        "status",
        issues.choice(
            fields,
            "status",
            Presence::Optional,
            &["pending", "accepted", "declined", "tentative"],
        ),
    );
    keep(
        &mut out,
        "role",
        issues.choice(
            fields,
            "role",
            Presence::Optional,
            &["organizer", "attendee"],
        ),
    );
    match fields.get("source") {
        None => {}
        Some(Value::String(source)) if source == "walk_in" => {
            out.insert("source".into(), json!("walk_in"));
        }
        Some(other) => issues.issue_at(
            "source",
            json!({
                "received": other,
                "code": "invalid_literal",
                "expected": "walk_in",
                "message": "Invalid literal value, expected \"walk_in\"",
            }),
        ),
    }
    for key in [
        "workspaceMemberId",
        "personId",
        "contactId",
        "counterpartyId",
    ] {
        keep(
            &mut out,
            key,
            issues.text(fields, key, Presence::Nullish, None, Some(64)),
        );
    }
    if issues.count() > before {
        return None;
    }
    Some(out)
}

/// `meetingFields` (and `createMeetingSchema`'s extras when `create`), with
/// every field optional for the update's `.partial()`.
fn read_meeting(issues: &mut Issues, fields: &Map<String, Value>, create: bool) -> MeetingBody {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let mut body = MeetingBody::default();
    let out = &mut body.fields;
    set_field(
        out,
        "title",
        issues.text_with(fields, "title", required, Text::length(Some(1), Some(255))),
    );
    set_field(
        out,
        "description",
        issues.text(fields, "description", Presence::Nullish, None, Some(20_000)),
    );
    set_field(
        out,
        "meetingType",
        issues.choice(
            fields,
            "meetingType",
            Presence::Optional,
            &["video", "audio"],
        ),
    );
    set_field(
        out,
        "accessType",
        issues.choice(
            fields,
            "accessType",
            Presence::Optional,
            &["workspace", "invited_only", "anyone_with_link"],
        ),
    );
    set_field(
        out,
        "waitingRoom",
        issues.boolean(fields, "waitingRoom", Presence::Optional),
    );
    set_field(
        out,
        "allowRecording",
        issues.boolean(fields, "allowRecording", Presence::Optional),
    );
    let max = issues.number(
        fields,
        "maxParticipants",
        Presence::Nullish,
        Number {
            int: true,
            ..Number::default()
        },
    );
    match max {
        Field::Set(n) if n <= 0.0 => issues.issue_at(
            "maxParticipants",
            json!({
                "code": "too_small",
                "minimum": 0,
                "type": "number",
                "inclusive": false,
                "exact": false,
                "message": "Number must be greater than 0",
            }),
        ),
        Field::Set(n) => out.push(("maxParticipants", billing::js_number(n))),
        Field::Null => out.push(("maxParticipants", Value::Null)),
        Field::Absent => {}
    }
    body.attendees = issues
        .list(
            fields,
            "attendees",
            Presence::Optional,
            None,
            Some(200),
            read_attendee,
        )
        .into_option();
    let stamp = Text {
        format: Some(Format::DatetimeOffset),
        ..Text::default()
    };
    for key in ["scheduledStart", "scheduledEnd"] {
        match issues.text_with(fields, key, Presence::Nullish, stamp) {
            // `new Date(value)`: the instant as UTC.
            Field::Set(text) => out.push((
                key,
                weldsuite_kit::validation::js_date_iso(&text).map_or(Value::Null, Value::String),
            )),
            Field::Null => out.push((key, Value::Null)),
            Field::Absent => {}
        }
    }
    set_field(
        out,
        "calendarEventId",
        issues.text(fields, "calendarEventId", Presence::Nullish, None, Some(30)),
    );
    set_field(
        out,
        "isRecurring",
        issues.boolean(fields, "isRecurring", Presence::Optional),
    );
    set_field(
        out,
        "recurrenceRule",
        issues.text(fields, "recurrenceRule", Presence::Nullish, None, Some(500)),
    );
    let tags = issues.list(
        fields,
        "tags",
        Presence::Nullish,
        None,
        Some(50),
        |issues, item| issues.item_text(item, Text::length(None, Some(100))),
    );
    match tags {
        Field::Set(tags) => out.push(("tags", json!(tags))),
        Field::Null => out.push(("tags", Value::Null)),
        Field::Absent => {}
    }
    if create {
        body.organizer_id = issues
            .text(
                fields,
                "organizerId",
                Presence::Optional,
                Some(1),
                Some(255),
            )
            .into_option();
        let _ = issues.boolean(fields, "createCalendarEvent", Presence::Optional);
    }
    body
}

/// `pickWritableMeetingFields(data, attendees)` as `{ column: value }`, in
/// the route's order: the attendees are the server-resolved list.
fn writable(body: &MeetingBody, attendees: Option<&[Attendee]>) -> Map<String, Value> {
    let table = &MEETINGS;
    let mut values = Map::new();
    let order = [
        "title",
        "description",
        "meetingType",
        "accessType",
        "waitingRoom",
        "allowRecording",
        "maxParticipants",
        "attendees",
        "scheduledStart",
        "scheduledEnd",
        "calendarEventId",
        "isRecurring",
        "recurrenceRule",
        "tags",
    ];
    for key in order {
        if key == "attendees" {
            if let Some(list) = attendees {
                let list: Vec<Value> = list.iter().cloned().map(Value::Object).collect();
                table.set(&mut values, key, Value::Array(list));
            }
            continue;
        }
        if let Some((_, value)) = body.fields.iter().find(|(k, _)| *k == key) {
            table.set(&mut values, key, value.clone());
        }
    }
    values
}

const TRUSTED: &[&str] = &[
    "id",
    "createdAt",
    "updatedAt",
    "scheduledStart",
    "scheduledEnd",
    "deletedAt",
];

async fn create(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| {
        read_meeting(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let db = &caller.db;
    let mut organizer_id = caller.user_id.clone();
    if let Some(asked) = body.organizer_id.as_deref()
        && asked != caller.user_id
        && scope(&caller).is_none()
    {
        let member: Result<Option<String>, sqlx::Error> =
            sqlx::query_scalar("select id from workspace_members where user_id = $1 limit 1")
                .bind(asked)
                .fetch_optional(db)
                .await;
        match member {
            Ok(Some(_)) => organizer_id = asked.to_owned(),
            Ok(None) => {
                return ApiError::bad_request("organizerId is not a member of this workspace")
                    .into_response();
            }
            Err(error) => return internal(&error, "Failed to create meeting"),
        }
    }
    let waiting_room = body
        .fields
        .iter()
        .find(|(k, _)| *k == "waitingRoom")
        .map_or(json!(true), |(_, v)| v.clone());
    let join_code = join_code_new();
    let id = generate_id("mtg");
    let title = body
        .fields
        .iter()
        .find(|(k, _)| *k == "title")
        .map_or(Value::Null, |(_, v)| v.clone());
    let result: Result<(), String> = async {
        let workspace_key = caller
            .org_id
            .clone()
            .or_else(|| caller.clerk_org_id.clone())
            .unwrap_or_default();
        let resolved = match &body.attendees {
            Some(inputs) => Some(
                attendees::resolve_writes(
                    db,
                    &avatars(&state, &caller),
                    &workspace_key,
                    inputs,
                    &[],
                )
                .await
                .map_err(|e| e.to_string())?,
            ),
            None => None,
        };
        let list =
            attendees::with_organizer(db, resolved.clone().unwrap_or_default(), &organizer_id)
                .await
                .map_err(|e| e.to_string())?;
        let table = &MEETINGS;
        let mut values = writable(&body, resolved.as_deref());
        let now = now();
        table.set(&mut values, "title", title.clone());
        table.set(
            &mut values,
            "attendees",
            Value::Array(list.into_iter().map(Value::Object).collect()),
        );
        table.set(&mut values, "id", json!(id));
        table.set(&mut values, "joinCode", json!(join_code));
        table.set(&mut values, "waitingRoom", waiting_room.clone());
        table.set(&mut values, "organizerId", json!(organizer_id));
        table.set(&mut values, "createdAt", json!(now));
        table.set(&mut values, "updatedAt", json!(now));
        table
            .insert(db, values, TRUSTED)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    .await;
    if let Err(error) = result {
        return internal(&error, "Failed to create meeting");
    }
    caller.publish(
        &state,
        MEETING_CREATED,
        &id,
        &json!({ "id": id, "title": title, "status": "scheduled", "hostId": organizer_id }),
    );
    Created(json!({ "id": id, "joinCode": join_code })).into_response()
}

async fn update(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| {
        read_meeting(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let scope = scope(&caller);
    let result: Result<Response, String> = async {
        let db = &caller.db;
        let Some(existing) = live_meeting(db, &id, scope.as_deref())
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(ApiError::not_found("Meeting", Some(&id)).into_response());
        };
        let workspace_key = caller
            .org_id
            .clone()
            .or_else(|| caller.clerk_org_id.clone())
            .unwrap_or_default();
        let resolved = match &body.attendees {
            Some(inputs) => Some(
                attendees::resolve_writes(
                    db,
                    &avatars(&state, &caller),
                    &workspace_key,
                    inputs,
                    &attendees::stored(&existing),
                )
                .await
                .map_err(|e| e.to_string())?,
            ),
            None => None,
        };
        let table = &MEETINGS;
        let mut values = writable(&body, resolved.as_deref());
        table.set(&mut values, "updatedAt", json!(now()));
        let changed: Option<String> = {
            let row = table
                .patch(db, &id, values, true, TRUSTED)
                .await
                .map_err(|e| e.to_string())?;
            row.and_then(|r| text(&r, "id").map(str::to_owned))
        };
        let _ = changed;
        let title = body
            .fields
            .iter()
            .find(|(k, _)| *k == "title")
            .map_or_else(|| existing["title"].clone(), |(_, v)| v.clone());
        caller.publish(
            &state,
            MEETING_UPDATED,
            &id,
            &json!({ "id": id, "title": title, "status": existing["status"], "hostId": existing["organizerId"] }),
        );
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update meeting"))
}

async fn host_controls(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let mut out: Vec<(&'static str, Value)> = Vec::new();
        for (key, _) in HOST_CONTROLS {
            if *key == "autoEndInactivityMinutes" {
                let rules = Number {
                    int: true,
                    min: Some(1.0),
                    max: Some(180.0),
                    ..Number::default()
                };
                if let Field::Set(n) = issues.number(fields, key, Presence::Optional, rules) {
                    out.push((key, billing::js_number(n)));
                }
            } else if let Field::Set(flag) = issues.boolean(fields, key, Presence::Optional) {
                out.push((key, json!(flag)));
            }
        }
        out
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let result: Result<Response, String> = async {
        let db = &caller.db;
        let Some(existing) = live_meeting(db, &id, None).await.map_err(|e| e.to_string())? else {
            return Ok(ApiError::not_found("Meeting", Some(&id)).into_response());
        };
        if text(&existing, "organizerId") != Some(caller.user_id.as_str()) {
            return Ok(forbidden("Only the meeting organizer can change host controls"));
        }
        let table = &MEETINGS;
        let mut values = Map::new();
        table.set(&mut values, "updatedAt", json!(now()));
        for (key, value) in &input {
            table.set(&mut values, key, value.clone());
        }
        table
            .patch(db, &id, values, false, &["updatedAt"])
            .await
            .map_err(|e| e.to_string())?;
        let after = lifecycle::meeting_row(db, &id)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(Value::Null);
        let mut controls = Map::new();
        for (key, default) in HOST_CONTROLS {
            let value = after
                .get(*key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| serde_json::from_str(default).unwrap_or(Value::Null));
            controls.insert((*key).to_owned(), value);
        }
        caller.publish(
            &state,
            MEETING_UPDATED,
            &id,
            &json!({ "id": id, "title": existing["title"], "status": existing["status"], "hostId": existing["organizerId"] }),
        );
        Ok(Data(Value::Object(controls)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update host controls"))
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let scope = scope(&caller);
    let result: Result<Response, sqlx::Error> = async {
        let Some(existing) = live_meeting(&caller.db, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Meeting", Some(&id)).into_response());
        };
        let now = now();
        sqlx::query("update meetings set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        caller.publish(
            &state,
            MEETING_DELETED,
            &id,
            &json!({ "id": id, "title": existing["title"], "status": existing["status"] }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete meeting"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_codes_look_like_the_workers() {
        let code = join_code_new();
        assert_eq!(code.len(), 14);
        assert!(code.starts_with("wm-"));
        assert!(
            code[3..]
                .split('-')
                .all(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_lowercase()))
        );
    }
}
