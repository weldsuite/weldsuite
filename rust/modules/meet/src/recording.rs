//! Session-scoped recording, transcript and summary operations
//! (`services/weldmeet/session-recording.ts`, `recording-access.ts`,
//! `recording-reconcile.ts`) and their routes under
//! `/api/meeting-sessions/:id` (`routes/meeting-sessions/recording.ts`). The
//! per-meeting aliases in `crate::meetings` call the same functions.
//!
//! The recorder is `RealtimeKit`'s, and the transcript and summary come from
//! `RealtimeKit` or Workers AI. The Kubernetes editions have neither (the
//! `meet-recordings` and `meet-transcription` features are unavailable
//! there): without the `MEETING_RECORDINGS` bucket and the `MEETING_AI`
//! Workflow these routes answer exactly as the worker does without them.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;
use weldsuite_catalogs::entity_events::MEETING_SESSION_UPDATED;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, CreditShortfall, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_video_rooms::RoomOptions;

use crate::billing::{self, BillingError};
use crate::js::{iso_of_ms, now_ms, origin_for_path_from, parse_ms, text, truthy};
use crate::lifecycle;
use crate::table::WriteError;
use crate::tables::{CRM_TRANSCRIPTIONS, MEETING_SESSIONS};
use crate::{Caller, MeetState, internal, now, optional_json, validate};

/// `RECORDING_DENIED`.
const RECORDING_DENIED: &str = "You do not have access to this meeting recording";
/// `RECORDING_TOKEN_TTL_SECONDS`.
pub(crate) const TOKEN_TTL_SECONDS: u64 = 60 * 60;
/// `PUBLIC_RECORDINGS_PATH`.
pub(crate) const PUBLIC_PATH: &str = "/public/meeting-recordings";
/// `RECONCILE_THROTTLE_SECONDS`.
const RECONCILE_THROTTLE_SECONDS: u64 = 60;
/// `MISSING_RECORDING_GRACE_MS`.
const MISSING_RECORDING_GRACE_MS: i64 = 30 * 60 * 1000;
/// `MISSING_RECORDING_ERROR`.
const MISSING_RECORDING_ERROR: &str = "RealtimeKit has no recording for this meeting.";

pub(crate) fn session_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{id}/recording/start",
            post(start).route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/recording/stop",
            post(stop).route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/recording/ai-options",
            post(ai_options).route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/recording",
            get(info).route_layer(need("recordings:read")),
        )
        .route(
            "/{id}/recording/access",
            post(access).route_layer(need("recordings:read")),
        )
        .route(
            "/{id}/recording",
            delete(remove).route_layer(need("recordings:delete")),
        )
        .route(
            "/{id}/recording/transcribe",
            post(transcribe)
                .route_layer(need("recordings:read"))
                .route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/recording/summarize",
            post(summarize).route_layer(need("sessions:update")),
        )
        .route(
            "/{id}/transcription",
            get(transcription).route_layer(need("recordings:read")),
        )
        .route(
            "/{id}/transcription/status",
            get(transcription_status_route).route_layer(need("recordings:read")),
        )
}

/// A route's outcome: an answer, or a failure that becomes the route's 500.
pub(crate) type Outcome = Result<Response, String>;

#[allow(clippy::needless_pass_by_value)] // `map_err(db_error)`
fn db_error(error: sqlx::Error) -> String {
    error.to_string()
}

// ============================================================================
// Access
// ============================================================================

/// `AuthorizedSession`.
pub(crate) struct Authorized {
    pub(crate) session: Value,
    pub(crate) meeting: Option<Value>,
}

/// `authorizeSession(c, sessionId)`: the session when the caller organizes
/// its meeting or holds `meetings:scope:all`, else the 404 / 403.
pub(crate) async fn authorize(
    caller: &Caller,
    session_id: &str,
) -> Result<Result<Authorized, Response>, String> {
    let db = &caller.db;
    let Some(session) = lifecycle::session_row(db, session_id)
        .await
        .map_err(db_error)?
    else {
        return Ok(Err(
            ApiError::not_found("Session", Some(session_id)).into_response()
        ));
    };
    let meeting = lifecycle::meeting_row(db, text(&session, "meetingId").unwrap_or_default())
        .await
        .map_err(db_error)?;
    let organizes = meeting
        .as_ref()
        .is_some_and(|m| text(m, "organizerId") == Some(caller.user_id.as_str()));
    if !organizes && !caller.can("meetings:scope:all") {
        return Ok(Err(ApiError::forbidden()
            .with_message(RECORDING_DENIED)
            .into_response()));
    }
    Ok(Ok(Authorized { session, meeting }))
}

/// `gateCredits(c, selected)`: `Some(answer)` when the wallet refuses.
async fn gate_credits(
    state: &MeetState,
    caller: &Caller,
    transcription: bool,
    summary: bool,
) -> Result<Option<Response>, String> {
    let Some(org) = caller.org_id.as_deref() else {
        return Ok(Some(ApiError::org_required().into_response()));
    };
    let cache = caller.parts.cache(state);
    let master = caller.parts.master(state);
    match billing::gate(cache.as_ref(), master.as_ref(), org, transcription, summary).await {
        Ok(()) => Ok(None),
        Err(BillingError::Insufficient {
            current,
            required,
            shortfall,
        }) => {
            #[allow(clippy::cast_precision_loss)]
            let details = CreditShortfall {
                current_balance: Some(current as f64),
                required: Some(required as f64),
                shortfall: Some(shortfall as f64),
            };
            Ok(Some(
                ApiError::insufficient_credits(Some(details)).into_response(),
            ))
        }
        Err(BillingError::Unavailable) => Ok(Some(
            ApiError::unavailable("Credit metering is unavailable for this workspace")
                .into_response(),
        )),
        Err(BillingError::Failed(error)) => Err(error),
    }
}

/// `emitSessionUpdated(c, session, data)`.
fn emit_updated(state: &MeetState, caller: &Caller, session: &Value, extra: &[(&str, Value)]) {
    let mut data = Map::new();
    data.insert("id".into(), session["id"].clone());
    data.insert("meetingId".into(), session["meetingId"].clone());
    data.insert("status".into(), session["status"].clone());
    for (key, value) in extra {
        data.insert((*key).to_owned(), value.clone());
    }
    let id = text(session, "id").unwrap_or_default();
    caller.publish(state, MEETING_SESSION_UPDATED, id, &Value::Object(data));
}

/// `patchSession(db, sessionId, patch)`: the given columns and `updatedAt`.
pub(crate) async fn patch_session(
    db: &PgPool,
    session_id: &str,
    patch: &[(&str, Value)],
) -> Result<(), WriteError> {
    let table = &MEETING_SESSIONS;
    let mut values = Map::new();
    let mut trusted: Vec<&str> = vec!["updatedAt"];
    for (prop, value) in patch {
        table.set(&mut values, prop, value.clone());
        trusted.push(prop);
    }
    table.set(&mut values, "updatedAt", json!(now()));
    table
        .patch(db, session_id, values, false, &trusted)
        .await
        .map(|_| ())
}

// ============================================================================
// Parts
// ============================================================================

/// `readyParts(parts)`.
pub(crate) fn ready_parts(parts: &Value) -> Vec<Value> {
    parts
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|p| text(p, "status") == Some("ready"))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// `extensionOf(nameOrUrl, fallback)`.
pub(crate) fn extension_of(name: Option<&str>, fallback: &str) -> String {
    let Some(name) = name.filter(|n| !n.is_empty()) else {
        return fallback.to_owned();
    };
    let path = name.split('?').next().unwrap_or_default();
    let Some((_, ext)) = path.rsplit_once('.') else {
        return fallback.to_owned();
    };
    let valid = (2..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    if valid {
        ext.to_ascii_lowercase()
    } else {
        fallback.to_owned()
    }
}

/// `contentTypeForExtension(ext)`.
pub(crate) fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "aac" | "m4a" => "audio/mp4",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
}

/// `safeFilename(title, ext)`.
pub(crate) fn safe_filename(title: Option<&str>, ext: &str) -> String {
    let normalized: String = title.unwrap_or("meeting").nfkd().collect();
    let mut replaced = String::new();
    let mut in_run = false;
    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            replaced.push(ch);
            in_run = false;
        } else if !in_run {
            replaced.push('_');
            in_run = true;
        }
    }
    let trimmed = replaced.trim_matches('_');
    // `.slice(0, 80)`: ASCII only by now.
    let base: String = trimmed.chars().take(80).collect();
    let base = if base.is_empty() { "meeting" } else { &base };
    format!("{base}.{ext}")
}

// ============================================================================
// Read: recording info
// ============================================================================

/// `findSessionTranscription(db, sessionId)`.
pub(crate) async fn find_transcription(
    db: &PgPool,
    activity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_transcriptions t where t.activity_id = $1 limit 1",
    )
    .bind(activity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| CRM_TRANSCRIPTIONS.js(row)))
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `iso(value)`: a timestamp as `toISOString()`, null when empty.
fn iso(value: &Value) -> Value {
    match value.as_str().filter(|s| !s.is_empty()) {
        Some(stamp) => parse_ms(stamp).map_or(Value::Null, |ms| json!(iso_of_ms(ms))),
        None => Value::Null,
    }
}

/// `buildRecordingInfo(db, session)`.
pub(crate) async fn recording_info(db: &PgPool, session: &Value) -> Result<Value, sqlx::Error> {
    let id = text(session, "id").unwrap_or_default();
    let transcription = find_transcription(db, id).await?;
    let parts: Vec<Value> = session["recordingParts"]
        .as_array()
        .map(|all| {
            all.iter()
                .map(|p| {
                    json!({
                        "rtkRecordingId": p["rtkRecordingId"],
                        "status": p["status"],
                        "hasVideo": truthy(p.get("videoKey")),
                        "hasAudio": truthy(p.get("audioKey")),
                        "sizeBytes": or_null(p.get("sizeBytes")),
                        "durationSeconds": or_null(p.get("durationSeconds")),
                        "startedAt": or_null(p.get("startedAt")),
                        "stoppedAt": or_null(p.get("stoppedAt")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let transcription = match transcription {
        Some(t) => {
            let mut out = Map::new();
            out.insert("exists".into(), json!(true));
            out.insert("id".into(), t["id"].clone());
            out.insert("status".into(), t["status"].clone());
            if let Some(provider) = t.get("provider").filter(|p| !p.is_null()) {
                out.insert("source".into(), provider.clone());
            }
            Value::Object(out)
        }
        None => json!({ "exists": false }),
    };
    Ok(json!({
        "sessionId": session["id"],
        "meetingId": session["meetingId"],
        "status": session["recordingStatus"],
        "recording": text(session, "recordingStatus") == Some("recording"),
        "error": session["recordingError"],
        "hasVideo": truthy(session.get("recordingVideoKey")),
        "hasAudio": truthy(session.get("recordingAudioKey")),
        "sizeBytes": session["recordingSizeBytes"],
        "durationSeconds": session["recordingDurationSeconds"],
        "readyAt": iso(&session["recordingReadyAt"]),
        "parts": parts,
        "ai": {
            "transcribe": truthy(session.get("aiTranscribeRequested")),
            "summarize": truthy(session.get("aiSummarizeRequested")),
            "language": session["aiLanguage"],
        },
        "transcription": transcription,
        "summary": {
            "status": session["summaryStatus"],
            "source": session["summarySource"],
            "generatedAt": iso(&session["summaryGeneratedAt"]),
            "error": session["summaryError"],
        },
        "transcriptionCreditsCharged": session["transcriptionCreditsCharged"],
        "summaryCreditsCharged": session["summaryCreditsCharged"],
    }))
}

/// `needsRecordingReconcile(session)`.
fn needs_reconcile(session: &Value) -> bool {
    if text(session, "cfAppId").is_none_or(str::is_empty) {
        return false;
    }
    match text(session, "recordingStatus") {
        Some("processing") => true,
        Some("recording") => text(session, "status") == Some("ended"),
        _ => false,
    }
}

/// `reconcileRecordingFromRtk(env, db, orgId, session)`: an unfinished
/// recording brought in step with the provider (throttled to once a minute
/// per session); the session as it is afterwards. Never fails.
pub(crate) async fn reconcile(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    session: Value,
) -> Value {
    if !needs_reconcile(&session) {
        return session;
    }
    match try_reconcile(state, caller, org, &session).await {
        Ok(Some(updated)) => updated,
        Ok(None) => session,
        Err(error) => {
            tracing::warn!(
                "[meet-api/recording-reconcile] {}: {error}",
                text(&session, "id").unwrap_or_default()
            );
            session
        }
    }
}

async fn try_reconcile(
    state: &MeetState,
    caller: &Caller,
    org: &str,
    session: &Value,
) -> Result<Option<Value>, String> {
    let id = text(session, "id").unwrap_or_default();
    let cache = caller
        .parts
        .cache(state)
        .ok_or_else(|| "Cannot read properties of undefined (reading 'get')".to_owned())?;
    let key = format!("rtk-recording-reconcile:{id}");
    if cache
        .get_boxed(&key)
        .await
        .map_err(|e| e.to_string())?
        .is_some_and(|v| !v.is_empty())
    {
        return Ok(None);
    }
    cache
        .put_boxed(
            &key,
            "1",
            Some(std::time::Duration::from_secs(RECONCILE_THROTTLE_SECONDS)),
        )
        .await
        .map_err(|e| e.to_string())?;
    let room = text(session, "cfAppId").unwrap_or_default();
    let recordings = caller
        .parts
        .video(state)
        .list_recordings(room)
        .await
        .map_err(|e| e.to_string())?;
    let mapping = crate::webhook::Mapping {
        org_id: org.to_owned(),
        kind: "session".to_owned(),
        session_id: text(session, "id").map(str::to_owned),
        meeting_id: text(session, "meetingId").map(str::to_owned),
    };
    let parts = session["recordingParts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for recording in &recordings {
        let known = parts
            .iter()
            .find(|p| p.get("rtkRecordingId") == recording.get("id"))
            .and_then(|p| text(p, "status"));
        if matches!(known, Some("ready" | "failed")) {
            continue;
        }
        let event = crate::webhook::recording_status_event(room, recording);
        crate::webhook::handle_recording_status(
            state,
            &caller.parts,
            Some(&caller.db),
            &mapping,
            &event,
        )
        .await?;
    }
    if recordings.is_empty()
        && parts.is_empty()
        && let Some(ended) = text(session, "endedAt").and_then(parse_ms)
        && now_ms() - ended > MISSING_RECORDING_GRACE_MS
    {
        patch_session(
            &caller.db,
            id,
            &[
                ("recordingStatus", json!("failed")),
                ("recordingEnabled", json!(false)),
                ("recordingError", json!(MISSING_RECORDING_ERROR)),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    lifecycle::session_row(&caller.db, id)
        .await
        .map_err(db_error)
}

async fn info(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    let outcome: Outcome = async {
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let session = match caller.org_id.clone() {
            Some(org) => reconcile(&state, &caller, &org, auth.session).await,
            None => auth.session,
        };
        let info = recording_info(&caller.db, &session)
            .await
            .map_err(db_error)?;
        Ok(Data(info).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to get recording"))
}

// ============================================================================
// Access tokens
// ============================================================================

/// `newRecordingToken()`: 24 random bytes, URL-safe base64.
fn new_token() -> String {
    let mut bytes = [0_u8; 24];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `mintRecordingAccess(c, auth)`: tokenized URLs for the latest ready part
/// (`RecordingAccessResult`), or the refusal.
pub(crate) async fn mint_access(
    state: &MeetState,
    caller: &Caller,
    session: &Value,
    meeting: Option<&Value>,
) -> Outcome {
    let Some(org) = caller.org_id.clone() else {
        return Ok(ApiError::org_required().into_response());
    };
    let status = text(session, "recordingStatus");
    let latest = ready_parts(&session["recordingParts"]).pop();
    let key_of = |part_key: &str, column: &str| -> Option<String> {
        latest
            .as_ref()
            .and_then(|p| p.get(part_key))
            .filter(|v| !v.is_null())
            .or_else(|| session.get(column).filter(|v| !v.is_null()))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let video = key_of("videoKey", "recordingVideoKey");
    let audio = key_of("audioKey", "recordingAudioKey");
    let primary = video
        .clone()
        .or_else(|| audio.clone())
        .filter(|k| !k.is_empty());
    let Some(primary) = primary else {
        return Ok(match status {
            Some("recording" | "processing") => ApiError::conflict(
                "The recording is still being processed. Try again in a few minutes.",
            )
            .into_response(),
            Some("failed") => ApiError::conflict(
                text(session, "recordingError").unwrap_or("The recording failed."),
            )
            .into_response(),
            _ => ApiError::not_found("Recording", None).into_response(),
        });
    };
    if caller.parts.recordings(state).is_none() {
        return Ok(ApiError::unavailable("Recording storage is not configured").into_response());
    }
    let cache = caller
        .parts
        .cache(state)
        .ok_or_else(|| "Cannot read properties of undefined (reading 'put')".to_owned())?;
    let title = meeting.and_then(|m| text(m, "title"));
    let session_id = text(session, "id").unwrap_or_default();
    let mint = |key: String, kind: &'static str| {
        let cache = Arc::clone(&cache);
        let ext = extension_of(Some(&key), if kind == "video" { "mp4" } else { "mp3" });
        let grant = json!({
            "orgId": org,
            "sessionId": session_id,
            "key": key,
            "kind": kind,
            "contentType": content_type_for(&ext),
            "filename": safe_filename(title, &ext),
            "userId": caller.user_id,
        })
        .to_string();
        async move {
            let token = new_token();
            cache
                .put_boxed(
                    &format!("rec-token:{token}"),
                    &grant,
                    Some(std::time::Duration::from_secs(TOKEN_TTL_SECONDS)),
                )
                .await
                .map(|()| token)
                .map_err(|e| e.to_string())
        }
    };
    let video_is_set = video.as_deref().is_some_and(|v| !v.is_empty());
    let primary_kind = if video_is_set { "video" } else { "audio" };
    let primary_token = mint(primary, primary_kind).await?;
    let audio_token = match (video_is_set, audio.filter(|a| !a.is_empty())) {
        (true, Some(audio)) => Some(mint(audio, "audio").await?),
        _ => None,
    };
    let origin = origin_for_path_from(&caller.origin, PUBLIC_PATH);
    #[allow(clippy::cast_possible_wrap)]
    let expires = iso_of_ms(now_ms() + (TOKEN_TTL_SECONDS as i64) * 1000);
    Ok(Data(json!({
        "url": format!("{origin}{PUBLIC_PATH}/{primary_token}"),
        "audioUrl": audio_token.map(|t| format!("{origin}{PUBLIC_PATH}/{t}")),
        "expiresAt": expires,
    }))
    .into_response())
}

async fn access(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let outcome: Outcome = async {
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        mint_access(&state, &caller, &auth.session, auth.meeting.as_ref()).await
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to create recording access"))
}

// ============================================================================
// AI options (live meeting)
// ============================================================================

/// `mapLocaleToRtkLanguage(locale)`.
pub(crate) fn rtk_language(locale: Option<&str>) -> Option<String> {
    let raw = locale?.trim().replacen('_', "-", 1);
    if raw.is_empty() {
        return None;
    }
    let mut pieces = raw.split('-');
    let lang = pieces.next().unwrap_or_default().to_lowercase();
    let region = pieces.next().unwrap_or_default().to_uppercase();
    if lang == "en" {
        return Some(if region == "IN" { "en-IN" } else { "en-US" }.to_owned());
    }
    matches!(
        lang.as_str(),
        "de" | "hi" | "sv" | "ru" | "pl" | "el" | "fr" | "nl"
    )
    .then_some(lang)
}

/// The AI options a request asked for.
#[derive(Debug, Clone, Default)]
pub(crate) struct AiInput {
    pub(crate) transcribe: Option<bool>,
    pub(crate) summarize: Option<bool>,
    /// `None` absent, `Some(None)` null.
    pub(crate) language: Option<Option<String>>,
}

/// `applyAiOptions(c, auth, input)`: the applied options, or the refusal.
async fn apply_ai_options(
    state: &MeetState,
    caller: &Caller,
    session: &Value,
    input: &AiInput,
) -> Result<Result<Value, Response>, String> {
    let transcribe = input
        .transcribe
        .unwrap_or_else(|| truthy(session.get("aiTranscribeRequested")));
    let summarize = input
        .summarize
        .unwrap_or_else(|| truthy(session.get("aiSummarizeRequested")));
    if summarize && !transcribe {
        return Ok(Err(ApiError::bad_request(
            "A summary needs a transcript. Turn on transcribe too.",
        )
        .into_response()));
    }
    if text(session, "status") == Some("ended") {
        return Ok(Err(ApiError::bad_request(
            "This meeting has ended. Use \"transcribe afterwards\" on the recording instead.",
        )
        .into_response()));
    }
    let Some(room) = text(session, "cfAppId").filter(|r| !r.is_empty()) else {
        return Ok(Err(ApiError::internal()
            .with_message("Session has no RTK meeting ID")
            .into_response()));
    };
    if (transcribe || summarize)
        && let Some(blocked) = gate_credits(state, caller, transcribe, summarize).await?
    {
        return Ok(Err(blocked));
    }
    let language = match &input.language {
        None => rtk_language(text(session, "aiLanguage")),
        Some(language) => rtk_language(language.as_deref()),
    };
    let options = RoomOptions {
        transcribe_on_end: Some(transcribe),
        summarize_on_end: Some(summarize),
        transcription_language: language.clone(),
        summary_text_format: summarize.then(|| "markdown".to_owned()),
        ..RoomOptions::default()
    };
    if let Err(error) = caller.parts.video(state).update_room(room, &options).await {
        tracing::error!("[meet-api/session-recording] RTK update failed: {error}");
        return Ok(Err(ApiError::bad_gateway()
            .with_message("Could not update the meeting settings")
            .into_response()));
    }
    let id = text(session, "id").unwrap_or_default();
    patch_session(
        &caller.db,
        id,
        &[
            ("aiTranscribeRequested", json!(transcribe)),
            ("aiSummarizeRequested", json!(summarize)),
            ("aiLanguage", json!(language)),
        ],
    )
    .await
    .map_err(|e| e.to_string())?;
    emit_updated(
        state,
        caller,
        session,
        &[
            ("aiTranscribeRequested", json!(transcribe)),
            ("aiSummarizeRequested", json!(summarize)),
            ("aiLanguage", json!(language)),
        ],
    );
    Ok(Ok(
        json!({ "transcribe": transcribe, "summarize": summarize, "language": language }),
    ))
}

/// The `language` rule shared by the AI schemas: `z.string().min(2).max(10).nullish()`.
fn read_language(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Option<String>> {
    match issues.text_with(
        fields,
        "language",
        Presence::Nullish,
        Text::length(Some(2), Some(10)),
    ) {
        weldsuite_kit::validation::Field::Set(language) => Some(Some(language)),
        weldsuite_kit::validation::Field::Null => Some(None),
        weldsuite_kit::validation::Field::Absent => None,
    }
}

async fn ai_options(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| AiInput {
        transcribe: issues
            .boolean(fields, "transcribe", Presence::Required)
            .into_option(),
        summarize: issues
            .boolean(fields, "summarize", Presence::Required)
            .into_option(),
        language: read_language(issues, fields),
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let outcome: Outcome = async {
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        Ok(
            match apply_ai_options(&state, &caller, &auth.session, &input).await? {
                Ok(ai) => Data(json!({ "ok": true, "ai": ai })).into_response(),
                Err(response) => response,
            },
        )
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to update recording options"))
}

/// A `safeParse` of an optional body: the read value, or the 400 with
/// `message` and the flattened issues.
fn parse_optional<T>(
    body: &Bytes,
    message: &str,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Box<Response>> {
    let value = optional_json(body);
    let mut issues = Issues::default();
    let read = issues
        .object(&value)
        .map(|fields| read(&mut issues, fields));
    if let Err(invalid) = issues.finish() {
        return Err(Box::new(
            ApiError::bad_request(message)
                .with_details(invalid.flatten())
                .into_response(),
        ));
    }
    read.ok_or_else(|| Box::new(ApiError::internal().into_response()))
}

// ============================================================================
// Start / stop
// ============================================================================

async fn start(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let input = match parse_optional(&body, "Invalid recording options", |issues, fields| {
        AiInput {
            transcribe: issues
                .boolean(fields, "transcribe", Presence::Optional)
                .into_option(),
            summarize: issues
                .boolean(fields, "summarize", Presence::Optional)
                .into_option(),
            language: read_language(issues, fields),
        }
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let outcome: Outcome = start_recording(&state, &caller, &id, &input).await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to start recording"))
}

async fn start_recording(state: &MeetState, caller: &Caller, id: &str, input: &AiInput) -> Outcome {
    let db = &caller.db;
    let Some(session) = lifecycle::session_row(db, id).await.map_err(db_error)? else {
        return Ok(ApiError::not_found("Session", Some(id)).into_response());
    };
    let meeting: Option<(String, Option<bool>)> = sqlx::query_as(
        "select organizer_id, allow_participant_record from meetings where id = $1 limit 1",
    )
    .bind(text(&session, "meetingId").unwrap_or_default())
    .fetch_optional(db)
    .await
    .map_err(db_error)?;
    if let Some((organizer, allow)) = &meeting
        && *organizer != caller.user_id
        && !allow.unwrap_or(false)
    {
        return Ok(ApiError::forbidden()
            .with_message("Only the meeting organizer can start a recording.")
            .into_response());
    }
    let mut ai = json!({
        "transcribe": truthy(session.get("aiTranscribeRequested")),
        "summarize": truthy(session.get("aiSummarizeRequested")),
        "language": session["aiLanguage"],
    });
    let wants_ai = input.transcribe.is_some()
        || input.summarize.is_some()
        || matches!(input.language, Some(Some(_)));
    if wants_ai {
        let auth = match authorize(caller, id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        match apply_ai_options(state, caller, &auth.session, input).await? {
            Ok(applied) => ai = applied,
            Err(response) => return Ok(response),
        }
    }
    let mut patch = vec![("recordingEnabled", json!(true))];
    if !matches!(
        text(&session, "recordingStatus"),
        Some("processing" | "ready")
    ) {
        patch.push(("recordingStatus", json!("recording")));
    }
    patch_session(db, id, &patch)
        .await
        .map_err(|e| e.to_string())?;
    emit_updated(
        state,
        caller,
        &session,
        &[("recordingStatus", json!("recording"))],
    );
    Ok(Data(json!({ "ok": true, "ai": ai })).into_response())
}

async fn stop(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    let outcome: Outcome = async {
        let db = &caller.db;
        let Some(session) = lifecycle::session_row(db, &id).await.map_err(db_error)? else {
            return Ok(ApiError::not_found("Session", Some(&id)).into_response());
        };
        let mut patch = vec![("recordingEnabled", json!(false))];
        if text(&session, "recordingStatus") == Some("recording") {
            patch.push(("recordingStatus", json!("processing")));
        }
        patch_session(db, &id, &patch)
            .await
            .map_err(|e| e.to_string())?;
        emit_updated(
            &state,
            &caller,
            &session,
            &[("recordingStatus", json!("processing"))],
        );
        Ok(Data(json!({ "ok": true })).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to stop recording"))
}

// ============================================================================
// Delete
// ============================================================================

/// `CLEARED_RECORDING_COLUMNS`.
fn cleared_columns() -> Vec<(&'static str, Value)> {
    let null = Value::Null;
    vec![
        ("recordingEnabled", json!(false)),
        ("recordingUrl", null.clone()),
        ("recordingKey", null.clone()),
        ("recordingStatus", json!("deleted")),
        ("recordingRtkId", null.clone()),
        ("recordingVideoKey", null.clone()),
        ("recordingAudioKey", null.clone()),
        ("recordingSizeBytes", null.clone()),
        ("recordingDurationSeconds", null.clone()),
        ("recordingReadyAt", null.clone()),
        ("recordingError", null.clone()),
        ("recordingParts", null.clone()),
        ("aiTranscribeRequested", json!(false)),
        ("aiSummarizeRequested", json!(false)),
        ("aiLanguage", null.clone()),
        ("transcriptionCreditsCharged", null.clone()),
        ("summaryStatus", null.clone()),
        ("summaryText", null.clone()),
        ("summaryFormat", null.clone()),
        ("summarySource", null.clone()),
        ("summaryGeneratedAt", null.clone()),
        ("summaryError", null.clone()),
        ("summaryCreditsCharged", null),
    ]
}

/// `deleteSessionTranscripts(db, activityId)`.
pub(crate) async fn delete_transcripts(db: &PgPool, activity_id: &str) -> Result<u64, sqlx::Error> {
    let ids: Vec<String> =
        sqlx::query_scalar("select id from crm_transcriptions where activity_id = $1")
            .bind(activity_id)
            .fetch_all(db)
            .await?;
    if ids.is_empty() {
        return Ok(0);
    }
    sqlx::query("delete from crm_transcript_segments where transcription_id = any($1)")
        .bind(&ids)
        .execute(db)
        .await?;
    sqlx::query("delete from crm_transcriptions where id = any($1)")
        .bind(&ids)
        .execute(db)
        .await?;
    Ok(u64::try_from(ids.len()).unwrap_or(0))
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let outcome: Outcome = async {
        let Some(org) = caller.org_id.clone() else {
            return Ok(ApiError::org_required().into_response());
        };
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let session = auth.session;
        if text(&session, "recordingStatus") == Some("recording") {
            return Ok(ApiError::conflict("Stop the recording before deleting it.").into_response());
        }
        let Some(bucket) = caller.parts.recordings(&state) else {
            return Ok(ApiError::unavailable("Recording storage is not configured").into_response());
        };
        let prefix = format!("{org}/{}/", text(&session, "id").unwrap_or_default());
        let mut cursor: Option<String> = None;
        let mut total = 0_u64;
        loop {
            let listed = bucket
                .list(&prefix, cursor.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            if !listed.keys.is_empty() {
                bucket
                    .delete_many(&listed.keys)
                    .await
                    .map_err(|e| e.to_string())?;
                total += u64::try_from(listed.keys.len()).unwrap_or(0);
            }
            cursor = listed.cursor;
            if cursor.is_none() {
                break;
            }
        }
        let db = &caller.db;
        let session_id = text(&session, "id").unwrap_or_default();
        delete_transcripts(db, session_id).await.map_err(db_error)?;
        if truthy(session.get("recordingUrl")) || truthy(session.get("recordingKey")) {
            delete_transcripts(db, text(&session, "meetingId").unwrap_or_default())
                .await
                .map_err(db_error)?;
        }
        patch_session(db, session_id, &cleared_columns())
            .await
            .map_err(|e| e.to_string())?;
        emit_updated(
            &state,
            &caller,
            &session,
            &[
                ("recordingDeleted", json!(true)),
                ("recordingStatus", json!("deleted")),
            ],
        );
        Ok(Data(json!({ "ok": true, "deletedObjects": total })).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to delete recording"))
}

// ============================================================================
// Transcribe afterwards / summarize
// ============================================================================

/// `whisperLanguage(code)`.
fn whisper_language(code: Option<&str>) -> Option<String> {
    let code = code.filter(|c| !c.is_empty())?;
    let base = code.trim().split(['-', '_']).next()?.to_lowercase();
    let valid = (2..=3).contains(&base.len()) && base.bytes().all(|b| b.is_ascii_lowercase());
    (valid && base != "auto").then_some(base)
}

/// `removeTranscription(db, id)`.
async fn remove_transcription(db: &PgPool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("delete from crm_transcript_segments where transcription_id = $1")
        .bind(id)
        .execute(db)
        .await?;
    sqlx::query("delete from crm_transcriptions where id = $1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// `transcribeRecording(c, sessionId, input)`.
pub(crate) async fn transcribe_session(
    state: &MeetState,
    caller: &Caller,
    session_id: &str,
    language: Option<Option<String>>,
) -> Outcome {
    let Some(org) = caller.org_id.clone() else {
        return Ok(ApiError::org_required().into_response());
    };
    let auth = match authorize(caller, session_id).await? {
        Ok(auth) => auth,
        Err(response) => return Ok(response),
    };
    let session = auth.session;
    let db = &caller.db;
    let has_audio = ready_parts(&session["recordingParts"])
        .iter()
        .any(|p| truthy(p.get("audioKey")))
        || truthy(session.get("recordingAudioKey"));
    let ready = text(&session, "recordingStatus") == Some("ready");
    if !ready || !has_audio {
        return Ok(ApiError::bad_request(if ready {
            "This recording has no audio file to transcribe."
        } else {
            "The recording is not ready yet."
        })
        .into_response());
    }
    let id = text(&session, "id").unwrap_or_default().to_owned();
    let existing = find_transcription(db, &id).await.map_err(db_error)?;
    if let Some(existing) = &existing
        && text(existing, "status") != Some("failed")
    {
        return Ok(Data(json!({
            "id": existing["id"],
            "status": "existing",
            "message": "A transcript already exists or is in progress",
        }))
        .into_response());
    }
    if let Some(blocked) = gate_credits(state, caller, true, false).await? {
        return Ok(blocked);
    }
    let Some(ai) = caller.parts.workflows(state).ai else {
        return Ok(ApiError::unavailable("Transcription is not configured").into_response());
    };
    if let Some(existing) = &existing {
        remove_transcription(db, text(existing, "id").unwrap_or_default())
            .await
            .map_err(db_error)?;
    }
    let requested = language.flatten();
    let transcription_id = generate_id("trans");
    let now = now();
    let stored_language: String = whisper_language(requested.as_deref())
        .unwrap_or_else(|| "en".to_owned())
        .chars()
        .take(10)
        .collect();
    sqlx::query(
        "insert into crm_transcriptions (id, activity_id, status, language, created_at, updated_at)
         values ($1, $2, 'pending', $3, $4::timestamp, $4::timestamp)",
    )
    .bind(&transcription_id)
    .bind(&id)
    .bind(&stored_language)
    .bind(&now)
    .execute(db)
    .await
    .map_err(db_error)?;
    let mut params = Map::new();
    params.insert("kind".into(), json!("whisper-transcribe"));
    params.insert("orgId".into(), json!(org));
    params.insert("sessionId".into(), json!(id));
    params.insert("transcriptionId".into(), json!(transcription_id));
    params.insert("userId".into(), json!(caller.user_id));
    if let Some(language) = &requested {
        params.insert("language".into(), json!(language));
    }
    let instance = format!("whisper-{transcription_id}");
    if let Err(error) = ai.create(&instance, &Value::Object(params)).await {
        remove_transcription(db, &transcription_id)
            .await
            .map_err(db_error)?;
        tracing::error!("[meet-api/session-recording] whisper dispatch failed: {error}");
        return Ok(ApiError::internal()
            .with_message("Failed to start transcription")
            .into_response());
    }
    emit_updated(
        state,
        caller,
        &session,
        &[("transcriptionStatus", json!("pending"))],
    );
    Ok(Created(json!({ "id": transcription_id, "status": "pending" })).into_response())
}

/// The body of a transcribe route (`transcribeRecordingSchema`).
pub(crate) fn read_transcribe_body(body: &Bytes) -> Result<Option<Option<String>>, Box<Response>> {
    parse_optional(body, "Invalid transcription options", |issues, fields| {
        read_language(issues, fields)
    })
}

async fn transcribe(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let language = match read_transcribe_body(&body) {
        Ok(language) => language,
        Err(response) => return *response,
    };
    transcribe_session(&state, &caller, &id, language)
        .await
        .unwrap_or_else(|error| internal(&error, "Failed to start transcription"))
}

async fn summarize(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let outcome: Outcome = async {
        let Some(org) = caller.org_id.clone() else {
            return Ok(ApiError::org_required().into_response());
        };
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let session = auth.session;
        let db = &caller.db;
        let session_id = text(&session, "id").unwrap_or_default().to_owned();
        let transcription = find_transcription(db, &session_id)
            .await
            .map_err(db_error)?;
        if transcription
            .as_ref()
            .is_none_or(|t| text(t, "status") != Some("completed"))
        {
            return Ok(
                ApiError::bad_request("There is no completed transcript to summarize yet.")
                    .into_response(),
            );
        }
        if matches!(
            text(&session, "summaryStatus"),
            Some("completed" | "processing" | "pending")
        ) {
            return Ok(Data(json!({
                "status": "existing",
                "message": "A summary already exists or is in progress",
            }))
            .into_response());
        }
        if let Some(blocked) = gate_credits(&state, &caller, false, true).await? {
            return Ok(blocked);
        }
        let Some(ai) = caller.parts.workflows(&state).ai else {
            return Ok(ApiError::unavailable("Summaries are not configured").into_response());
        };
        let run_id = to_base36(now_ms());
        patch_session(
            db,
            &session_id,
            &[
                ("summaryStatus", json!("pending")),
                ("summaryError", Value::Null),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
        let instance = format!("summarize-{session_id}-{run_id}");
        let params = json!({
            "kind": "summarize",
            "orgId": org,
            "sessionId": session_id,
            "userId": caller.user_id,
            "runId": run_id,
        });
        if let Err(error) = ai.create(&instance, &params).await {
            patch_session(
                db,
                &session_id,
                &[("summaryStatus", session["summaryStatus"].clone())],
            )
            .await
            .map_err(|e| e.to_string())?;
            tracing::error!("[meet-api/session-recording] summarize dispatch failed: {error}");
            return Ok(ApiError::internal()
                .with_message("Failed to start the summary")
                .into_response());
        }
        emit_updated(
            &state,
            &caller,
            &session,
            &[("summaryStatus", json!("pending"))],
        );
        Ok(Data(json!({ "status": "processing" })).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to start the summary"))
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

// ============================================================================
// Transcript reads
// ============================================================================

/// `buildTranscriptionPayload(db, transcription, session)`.
pub(crate) async fn transcription_payload(
    db: &PgPool,
    transcription: &Value,
    session: Option<&Value>,
) -> Result<Value, sqlx::Error> {
    let segments: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from crm_transcript_segments s where s.transcription_id = $1
         order by s.sequence_number asc",
    )
    .bind(text(transcription, "id").unwrap_or_default())
    .fetch_all(db)
    .await?;
    let segments: Vec<Value> = segments
        .into_iter()
        .map(|row| crate::tables::CRM_TRANSCRIPT_SEGMENTS.js(row))
        .map(|seg| {
            json!({
                "id": seg["id"],
                "speakerId": seg["speakerId"],
                "speakerLabel": seg["speakerLabel"],
                "speakerName": seg["speakerName"],
                "text": seg["text"],
                "startTime": seg["startTime"],
                "endTime": seg["endTime"],
                "timestamp": seg["timestamp"],
                "sequenceNumber": seg["sequenceNumber"],
                "start": seg["startTime"],
                "end": seg["endTime"],
                "speaker": seg["speakerLabel"],
            })
        })
        .collect();
    let summary_status = session.map_or(Value::Null, |s| s["summaryStatus"].clone());
    let summary = match session {
        Some(s) if text(s, "summaryStatus") == Some("completed") => s["summaryText"].clone(),
        _ => Value::Null,
    };
    Ok(json!({
        "id": transcription["id"],
        "activityId": transcription["activityId"],
        "status": transcription["status"],
        "fullText": transcription["fullText"],
        "provider": transcription["provider"],
        "model": transcription["model"],
        "language": transcription["language"],
        "speakerCount": transcription["speakerCount"],
        "wordCount": transcription["wordCount"],
        "errorMessage": transcription["errorMessage"],
        "segments": segments,
        "summary": summary,
        "summaryStatus": summary_status,
    }))
}

/// `buildTranscriptionStatus(transcription, session)`.
pub(crate) fn transcription_status(
    transcription: Option<&Value>,
    session: Option<&Value>,
) -> Value {
    let summary_status = session.map_or(Value::Null, |s| s["summaryStatus"].clone());
    match transcription {
        None => json!({ "exists": false, "summaryStatus": summary_status }),
        Some(t) => json!({
            "exists": true,
            "id": t["id"],
            "status": t["status"],
            "errorMessage": t["errorMessage"],
            "wordCount": t["wordCount"],
            "speakerCount": t["speakerCount"],
            "summaryStatus": summary_status,
        }),
    }
}

async fn transcription(caller: Caller, Path(id): Path<String>) -> Response {
    let outcome: Outcome = async {
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let session_id = text(&auth.session, "id").unwrap_or_default();
        let Some(found) = find_transcription(&caller.db, session_id)
            .await
            .map_err(db_error)?
        else {
            return Ok(ApiError::not_found("Transcription", None).into_response());
        };
        let payload = transcription_payload(&caller.db, &found, Some(&auth.session))
            .await
            .map_err(db_error)?;
        Ok(Data(payload).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription"))
}

async fn transcription_status_route(caller: Caller, Path(id): Path<String>) -> Response {
    let outcome: Outcome = async {
        let auth = match authorize(&caller, &id).await? {
            Ok(auth) => auth,
            Err(response) => return Ok(response),
        };
        let session_id = text(&auth.session, "id").unwrap_or_default();
        let found = find_transcription(&caller.db, session_id)
            .await
            .map_err(db_error)?;
        Ok(Data(transcription_status(found.as_ref(), Some(&auth.session))).into_response())
    }
    .await;
    outcome.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription status"))
}

/// `findLatestRecordedSession(db, meetingId)`.
pub(crate) async fn latest_recorded_session(
    db: &PgPool,
    meeting_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_sessions t
         where t.meeting_id = $1 and t.recording_status is not null
         order by t.created_at desc limit 1",
    )
    .bind(meeting_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| MEETING_SESSIONS.js(row)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers_behave_like_the_worker() {
        assert_eq!(rtk_language(Some("nl-NL")), Some("nl".into()));
        assert_eq!(rtk_language(Some("en_IN")), Some("en-IN".into()));
        assert_eq!(rtk_language(Some("en-GB")), Some("en-US".into()));
        assert_eq!(rtk_language(Some("es")), None);
        assert_eq!(rtk_language(Some(" ")), None);
        assert_eq!(whisper_language(Some("en-US")), Some("en".into()));
        assert_eq!(whisper_language(Some("auto")), None);
        assert_eq!(
            safe_filename(Some("Team sync / Q3"), "mp4"),
            "Team_sync_Q3.mp4"
        );
        assert_eq!(
            safe_filename(Some("Café"), "mp3"),
            "Cafe_.mp3".replace("_.", ".")
        );
        assert_eq!(safe_filename(None, "mp4"), "meeting.mp4");
        assert_eq!(safe_filename(Some("///"), "mp4"), "meeting.mp4");
        assert_eq!(extension_of(Some("a/b/rec.MP4?x=1"), "mp3"), "mp4");
        assert_eq!(extension_of(Some("a/b/rec"), "mp3"), "mp3");
        assert_eq!(to_base36(35), "z");
        assert_eq!(new_token().len(), 32);
    }
}
