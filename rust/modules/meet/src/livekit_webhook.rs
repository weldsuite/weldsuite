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
//!   or the WeldChat call's `cfAppId`; the room's `creationTimeMs` (else
//!   `creationTime`) and the event's `createdAt` stand for the session's
//!   start and end; whole seconds read as their last millisecond, see
//!   `livekit_time`),
//!   `participant_joined` / `participant_left` are the participant events:
//!   the participant's identity is the id the join stored (`cfSessionId`,
//!   `<userId>~<nonce>`), the part before `~` the app's id, and the
//!   connection is the participant's `sid`;
//! - `egress_*` (`LiveKit`'s recorder) and everything else are acknowledged
//!   and ignored: recordings, transcripts and summaries are unavailable on
//!   Kubernetes (`meet-recordings`, `meet-transcription`). Recording on
//!   `LiveKit` needs its Egress service (a room composite into the
//!   recordings bucket) and its `egress_ended` event in place of
//!   `recording.statusUpdate`.
//!
//! The session and call handling itself is `crate::webhook`'s, so both
//! providers end sessions and calls and track presence the same way.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_video_rooms::verify_livekit_webhook;

use crate::chat_calls::SessionTimes;
use crate::js::{iso_of_ms, text};
use crate::webhook::{self, Joined, LeftIds, Mapping};
use crate::{MeetState, RequestParts};

const DEDUPE_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

pub(crate) fn routes() -> Router<MeetState> {
    Router::new().route("/", post(receive))
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// A protojson `int64`: a number or a string; `None` when missing or not
/// positive.
fn positive_int(value: Option<&Value>) -> Option<i64> {
    let number = match value? {
        Value::Number(n) => n.as_i64()?,
        Value::String(text) => text.trim().parse::<i64>().ok()?,
        _ => return None,
    };
    (number > 0).then_some(number)
}

/// A `LiveKit` time, as ISO: its millisecond field when the event carries
/// one (`creationTimeMs`, `joinedAtMs`), else its whole-second field read as
/// the last millisecond of that second.
///
/// What these are compared with (a call's `createdAt`, a participant's
/// `joinedAt`) is ours, in milliseconds, stamped a moment before `LiveKit`'s
/// own time. Read as the start of its second, a fresh room looked older than
/// its call and a new connection older than the join that made it, so the
/// room's end and the leave were ignored. The end of the second errs toward
/// newer, which only ever lets the event count.
fn livekit_time(millis: Option<&Value>, seconds: Option<&Value>) -> Option<String> {
    if let Some(ms) = positive_int(millis) {
        return Some(iso_of_ms(ms));
    }
    positive_int(seconds).map(|s| iso_of_ms(s.saturating_mul(1000).saturating_add(999)))
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
        "room_finished" => {
            // The room's session: from its creation to this event.
            let times = SessionTimes {
                started_at: livekit_time(
                    event.pointer("/room/creationTimeMs"),
                    event.pointer("/room/creationTime"),
                ),
                ended_at: livekit_time(None, event.get("createdAt")),
            };
            webhook::meeting_ended(state, parts, &mapping, room, &times).await?;
        }
        "participant_joined" if !identity.is_empty() => {
            let ids = Joined {
                custom_id: Some(custom_id(&identity)),
                peer_id: sid,
            };
            webhook::participant_joined(state, parts, &mapping, &ids).await?;
        }
        "participant_left" if !identity.is_empty() => {
            let ids = LeftIds {
                cf_session_id: Some(identity.clone()),
                custom_id: Some(custom_id(&identity)),
                left_at: livekit_time(None, event.get("createdAt")),
                peer_id: sid,
                peer_joined_at: livekit_time(
                    participant.get("joinedAtMs"),
                    participant.get("joinedAt"),
                ),
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

/// The `rtk-meeting:` mapping the session start or the call start wrote
/// (the same key for either provider).
fn mapping_of(value: &Value) -> Option<Mapping> {
    Mapping::of(value, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_livekit_identities_and_times() {
        assert_eq!(custom_id("user_1~ab12"), "user_1");
        assert_eq!(custom_id("guest:a~b~c"), "guest:a~b");
        assert_eq!(custom_id("plain"), "plain");
        // Milliseconds when the event has them.
        assert_eq!(
            livekit_time(Some(&json!("1791896400350")), Some(&json!("1791896400"))).as_deref(),
            Some("2026-10-13T13:00:00.350Z")
        );
        // Else the whole second, read as its last millisecond.
        assert_eq!(
            livekit_time(None, Some(&json!("1791896400"))).as_deref(),
            Some("2026-10-13T13:00:00.999Z")
        );
        assert_eq!(
            livekit_time(Some(&json!(0)), Some(&json!(1_791_896_400))).as_deref(),
            Some("2026-10-13T13:00:00.999Z")
        );
        assert_eq!(livekit_time(None, Some(&json!(0))), None);
        assert_eq!(livekit_time(None, None), None);
    }

    /// The review's two cases: a call stamped in milliseconds a moment before
    /// `LiveKit`'s whole-second time of the same second.
    #[test]
    fn a_whole_second_never_reads_as_older_than_our_own_stamp() {
        use crate::chat_calls::{SessionTimes, is_earlier_call_session};
        // A channel call created at :00.300; its room, created after it, finishes.
        let call = json!({
            "createdAt": "2026-10-13T13:00:00.300Z",
            "initiatorId": "a",
            "participants": [{ "userId": "a", "joinedAt": "2026-10-13T13:00:00.300Z" }],
        });
        let room_finished = SessionTimes {
            started_at: livekit_time(None, Some(&json!("1791896400"))),
            ended_at: livekit_time(None, Some(&json!("1791896460"))),
        };
        assert!(!is_earlier_call_session(&call, &room_finished));
        // A DM room still open from a call a second earlier is that call's.
        let earlier = SessionTimes {
            started_at: livekit_time(None, Some(&json!("1791896399"))),
            ended_at: livekit_time(None, Some(&json!("1791896460"))),
        };
        assert!(is_earlier_call_session(&call, &earlier));

        // A participant who joined at :00.300 and whose connection, joined in
        // that same second, goes: their leave counts.
        let participants = vec![json!({
            "userId": "b",
            "cfSessionId": "b~1",
            "joinedAt": "2026-10-13T13:00:00.300Z",
            "lastJoinAt": "2026-10-13T13:00:00.300Z",
        })];
        let left = LeftIds {
            cf_session_id: Some("b~1".to_owned()),
            custom_id: Some("b".to_owned()),
            left_at: livekit_time(None, Some(&json!("1791896400"))),
            peer_id: None,
            peer_joined_at: livekit_time(None, Some(&json!("1791896400"))),
        };
        assert_eq!(crate::webhook::find_leaving(&participants, &left), Some(0));
    }
}
