//! `LiveKit`'s webhook, the Kubernetes editions' counterpart of
//! `RealtimeKit`'s (`crate::webhook`), at `POST /api/webhooks/livekit`. Rust
//! only: Global has no `LiveKit`.
//!
//! What differs from `RealtimeKit`'s:
//! - the credential is a JWT in `Authorization`, signed with the
//!   `LIVEKIT_API_SECRET`, issued by the `LIVEKIT_API_KEY`, covering the
//!   body's SHA-256 (`weldsuite_video_rooms::verify_livekit_webhook`); a bad
//!   one is 401, no key pair configured 503;
//! - deliveries are de-duplicated by the event's `id`
//!   (`livekit-webhook-delivery:<id>`, 7 days);
//! - `room_finished` is `meeting.ended` (the room's name is the session's
//!   `cfAppId`), `participant_joined` / `participant_left` are the
//!   participant events: the participant's identity is the id the join
//!   stored (`cfSessionId`, `<userId>~<nonce>`), the part before `~` the
//!   app's id, and the connection is the participant's `sid`;
//! - `egress_*` (`LiveKit`'s recorder) and everything else are acknowledged
//!   and ignored: recordings, transcripts and summaries are unavailable on
//!   Kubernetes (`meet-recordings`, `meet-transcription`). Recording on
//!   `LiveKit` needs its Egress service (a room composite into the
//!   recordings bucket) and its `egress_ended` event in place of
//!   `recording.statusUpdate`.
//!
//! The session handling itself is `crate::webhook`'s, so both providers end
//! sessions and track presence the same way.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_video_rooms::verify_livekit_webhook;

use crate::js::{iso_of_ms, text};
use crate::webhook::{self, Joined, Left, Mapping};
use crate::{MeetState, RequestParts};

const DEDUPE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

pub(crate) fn routes() -> Router<MeetState> {
    Router::new().route("/", post(receive))
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// `LiveKit` times are Unix seconds, as a number or a string (protojson's
/// `int64`); `None` when missing or zero.
fn seconds_iso(value: Option<&Value>) -> Option<String> {
    let seconds = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(text) => text.parse::<f64>().ok()?,
        _ => return None,
    };
    #[allow(clippy::cast_possible_truncation)]
    (seconds > 0.0).then(|| iso_of_ms((seconds * 1000.0) as i64))
}

/// The app's id in a participant identity (`<customParticipantId>~<nonce>`),
/// or the identity itself.
fn custom_id(identity: &str) -> String {
    identity
        .rsplit_once('~')
        .map_or(identity, |(custom, _)| custom)
        .to_owned()
}

async fn receive(State(state): State<MeetState>, request: axum::extract::Request) -> Response {
    let (parts, body) = request.into_parts();
    let request_parts = RequestParts::of(&parts);
    let Some(keys) = state.livekit.clone() else {
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "LiveKit webhooks are not configured" }),
        );
    };
    let Ok(body) = axum::body::to_bytes(body, usize::MAX).await else {
        return answer(
            StatusCode::BAD_REQUEST,
            json!({ "error": "unreadable body" }),
        );
    };
    let authorization = parts
        .headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let event = match verify_livekit_webhook(&keys.api_key, &keys.api_secret, &body, authorization)
    {
        Ok(event) => event,
        Err(rejected) => {
            tracing::warn!("[LiveKit Webhook] Rejected: {rejected}");
            return answer(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
        }
    };
    if let Err(error) = handle(&state, &request_parts, &event).await {
        tracing::error!("[LiveKit Webhook] Error processing event: {error}");
    }
    answer(StatusCode::OK, json!({ "ok": true }))
}

async fn handle(state: &MeetState, parts: &RequestParts, event: &Value) -> Result<(), String> {
    let kind = text(event, "event").unwrap_or_default();
    let Some(room) = event
        .pointer("/room/name")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
    else {
        return Ok(());
    };
    if !matches!(
        kind,
        "room_finished" | "participant_joined" | "participant_left"
    ) {
        return Ok(());
    }
    let cache = parts.cache(state);
    let dedupe = text(event, "id")
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(|id| format!("livekit-webhook-delivery:{id}"));
    if let (Some(key), Some(cache)) = (&dedupe, &cache)
        && cache
            .get_boxed(key)
            .await
            .map_err(|e| e.to_string())?
            .is_some_and(|v| !v.is_empty())
    {
        return Ok(());
    }
    let Some(raw) = cache
        .as_ref()
        .ok_or_else(|| "no cache for the room mappings".to_owned())?
        .get_boxed(&format!("rtk-meeting:{room}"))
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let mapping: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let Some(mapping) = mapping_of(&mapping) else {
        return Ok(());
    };
    let participant = event.get("participant").cloned().unwrap_or(Value::Null);
    let identity = text(&participant, "identity")
        .unwrap_or_default()
        .to_owned();
    let sid = text(&participant, "sid").map(str::to_owned);
    match kind {
        "room_finished" => webhook::meeting_ended(state, parts, &mapping, room).await?,
        "participant_joined" if !identity.is_empty() => {
            let ids = Joined {
                custom_id: Some(custom_id(&identity)),
                peer_id: sid,
            };
            webhook::participant_joined(state, parts, &mapping, &ids).await?;
        }
        "participant_left" if !identity.is_empty() => {
            let ids = Left {
                cf_session_id: Some(identity.clone()),
                custom_id: Some(custom_id(&identity)),
                left_at: seconds_iso(event.get("createdAt")),
                peer_id: sid,
                peer_joined_at: seconds_iso(participant.get("joinedAt")),
            };
            webhook::participant_left(state, parts, &mapping, &ids).await?;
        }
        _ => {}
    }
    if let (Some(key), Some(cache)) = (&dedupe, &cache) {
        cache
            .put_boxed(key, "1", Some(Duration::from_secs(DEDUPE_TTL_SECONDS)))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The `rtk-meeting:` mapping the session start wrote (the same key for
/// either provider).
fn mapping_of(value: &Value) -> Option<Mapping> {
    let object = value.as_object()?;
    let field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(Mapping {
        org_id: field("orgId").unwrap_or_default(),
        kind: field("type").unwrap_or_default(),
        session_id: field("sessionId"),
        meeting_id: field("meetingId"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_livekit_identities_and_times() {
        assert_eq!(custom_id("user_1~ab12"), "user_1");
        assert_eq!(custom_id("guest:a~b~c"), "guest:a~b");
        assert_eq!(custom_id("plain"), "plain");
        assert_eq!(
            seconds_iso(Some(&json!("1791896400"))).as_deref(),
            Some("2026-10-13T13:00:00.000Z")
        );
        assert_eq!(seconds_iso(Some(&json!(0))), None);
    }
}
