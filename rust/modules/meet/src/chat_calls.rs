//! WeldChat calls as meet-api sees them: the video provider's webhooks end
//! a call whose room emptied and mark who left it (`handleCallMeetingEnded`,
//! `handleCallParticipantLeft` in `services/rtk-webhook.ts`), and joining a
//! meeting drops the user from their chat calls (the chat half of
//! `leaveOtherLiveCalls`). The call lifecycle itself is
//! `weldsuite_chat_domain::calls`, shared with chat-api's routes.
//!
//! The room mapping (`rtk-meeting:<room>`, type `call`) is written by the
//! call routes and is the same for `RealtimeKit` and `LiveKit`.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::CHAT_CALL_LEFT;
use weldsuite_chat_domain::calls::{
    self, CallPorts, EndIfEmpty, EndIfEmptyOptions, call_row, participants_of, text, was_answered,
};
use weldsuite_chat_domain::publish::Realtime;
use weldsuite_db::PgPool;
use weldsuite_notifications::{ApnsConfig, Notifier};

use crate::webhook::{LeftIds, find_leaving};
use crate::{MeetState, RequestParts, publish_system};

/// When the provider's session of a room began and ended: `RealtimeKit`'s
/// `event.meeting.startedAt` / `endedAt`, `LiveKit`'s room creation and the
/// `room_finished` event's time.
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionTimes {
    pub(crate) started_at: Option<String>,
    pub(crate) ended_at: Option<String>,
}

/// What the call lifecycle reaches from a meet request: the request's
/// provider and cache (conformance: the test's), the realtime publisher, and
/// the push notifications.
pub(crate) fn call_ports(state: &MeetState, parts: &RequestParts) -> CallPorts {
    CallPorts {
        video: parts.video(state),
        cache: parts.cache(state),
        realtime: Realtime::new(state.realtime.clone()),
        notifier: Notifier {
            realtime: state.realtime.clone(),
            presence: None,
            mail: None,
            http: Some(parts.http(state)),
            apns: ApnsConfig::from_values(
                parts.env("APNS_KEY_ID").as_deref(),
                parts.env("APNS_TEAM_ID").as_deref(),
                parts.env("APNS_PRIVATE_KEY").as_deref(),
            ),
        },
    }
}

/// `isEarlierCallSession(call, rtkSession)`: the ending session belongs to
/// an earlier call in the same room (a DM keeps one room for all its calls,
/// so its mapping already points at the newest call): it ended before this
/// call was created, or it began before it while nobody has answered yet.
pub(crate) fn is_earlier_call_session(call: &Value, times: &SessionTimes) -> bool {
    let Some(created) = text(call, "createdAt").and_then(calls::parse_ms) else {
        return false;
    };
    let at = |value: &Option<String>| value.as_deref().and_then(calls::parse_ms);
    if at(&times.ended_at).is_some_and(|ended| ended < created) {
        return true;
    }
    at(&times.started_at).is_some_and(|started| started < created) && !was_answered(call)
}

/// `handleCallMeetingEnded`: the provider closed the call's room. A call
/// that is no longer live is left alone: a DM's room outlives its calls, and
/// ending a missed or declined call again would post its notice and send
/// its missed-call push twice.
pub(crate) async fn meeting_ended(
    state: &MeetState,
    parts: &RequestParts,
    db: &PgPool,
    org_id: &str,
    call_id: &str,
    room: &str,
    times: &SessionTimes,
) -> Result<(), String> {
    let Some(call) = call_row(db, call_id).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if !matches!(text(&call, "status"), Some("ringing" | "active")) {
        tracing::info!("[RTK Webhook] Call {call_id} already over or not found");
        return Ok(());
    }
    if is_earlier_call_session(&call, times) {
        tracing::info!("[RTK Webhook] meeting.ended for {room} ignored: an earlier call's session");
        return Ok(());
    }
    let ports = call_ports(state, parts);
    let initiator = text(&call, "initiatorId").unwrap_or_default().to_owned();
    // A late or replayed end must not throw out the people in the room now.
    let outcome = calls::end_chat_call_if_empty(
        db,
        &ports,
        org_id,
        call_id,
        &call,
        &initiator,
        EndIfEmptyOptions::default(),
    )
    .await
    .map_err(|e| e.to_string())?;
    match outcome {
        EndIfEmpty::Occupied => {
            tracing::info!(
                "[RTK Webhook] meeting.ended for {room} ignored: the call has live participants"
            );
        }
        // The provider could not be asked, but it reported the end itself.
        EndIfEmpty::Unknown => {
            calls::end_chat_call(db, &ports, org_id, call_id, &call, &initiator, true)
                .await
                .map_err(|e| e.to_string())?;
        }
        EndIfEmpty::Ended => {}
    }
    Ok(())
}

/// `findLeavingCallParticipant`: every join of a call writes a fresh entry,
/// so its `joinedAt` is the latest join and an older connection's leave
/// doesn't count.
fn find_leaving_call_participant(participants: &[Value], ids: &LeftIds) -> Option<usize> {
    let with_last_join: Vec<Value> = participants
        .iter()
        .map(|p| {
            let mut entry = p.clone();
            if let (Some(object), Some(joined)) = (entry.as_object_mut(), p.get("joinedAt")) {
                object.insert("lastJoinAt".into(), joined.clone());
            }
            entry
        })
        .collect();
    find_leaving(&with_last_join, ids)
}

/// `handleCallParticipantLeft`: mark the participant whose connection went as
/// left, and publish `chat_call.left`.
pub(crate) async fn participant_left(
    state: &MeetState,
    db: &PgPool,
    org_id: &str,
    call_id: &str,
    ids: &LeftIds,
) -> Result<(), String> {
    let Some(call) = call_row(db, call_id).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if text(&call, "status") == Some("ended") {
        return Ok(());
    }
    let mut participants = participants_of(&call);
    let Some(index) = find_leaving_call_participant(&participants, ids) else {
        return Ok(());
    };
    let now = crate::now();
    if let Some(entry) = participants[index].as_object_mut() {
        entry.insert("leftAt".into(), json!(now));
    }
    sqlx::query(
        "update chat_calls set participants = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(call_id)
    .bind(Value::Array(participants.clone()))
    .bind(&now)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    let mut data = call;
    data["participants"] = Value::Array(participants);
    publish_system(state, org_id, "system", CHAT_CALL_LEFT, call_id, data);
    Ok(())
}

/// The chat half of `leaveOtherLiveCalls` when a user joins a meeting
/// session: no chat call is spared.
pub(crate) async fn leave_chat_calls(
    db: &PgPool,
    ports: &CallPorts,
    org_id: &str,
    user_id: &str,
    triggered_at: i64,
) {
    calls::leave_other_active_calls(db, ports, org_id, user_id, None, triggered_at).await;
}

/// For the app: WeldMeet's half of "one live call at a time" when a user
/// joins a WeldChat call (`leaveOtherMeetingSessions(db, env, orgId, userId,
/// null, { triggeredAt })`), with the call request's provider and cache.
pub async fn leave_meeting_sessions(
    state: &MeetState,
    video: Arc<dyn weldsuite_video_rooms::DynVideoRooms>,
    cache: Option<Arc<dyn weldsuite_ports::DynCache>>,
    db: &PgPool,
    org_id: &str,
    user_id: &str,
    triggered_at: i64,
) {
    let env = crate::lifecycle::Env { video, cache };
    crate::lifecycle::leave_other_sessions(state, &env, db, org_id, user_id, None, triggered_at)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_an_earlier_sessions_end() {
        let call = |joined: &[&str]| {
            let participants: Vec<Value> = joined
                .iter()
                .map(|user| json!({ "userId": user, "joinedAt": "2026-01-01T10:00:00.000Z" }))
                .collect();
            json!({ "createdAt": "2026-01-01T10:00:00.000Z", "initiatorId": "a", "participants": participants })
        };
        let times = |started: &str, ended: &str| SessionTimes {
            started_at: Some(started.to_owned()),
            ended_at: Some(ended.to_owned()),
        };
        // Ended before the call was created.
        assert!(is_earlier_call_session(
            &call(&["a"]),
            &times("2026-01-01T09:00:00.000Z", "2026-01-01T09:30:00.000Z")
        ));
        // Began earlier while the call still rings.
        assert!(is_earlier_call_session(
            &call(&["a"]),
            &times("2026-01-01T09:00:00.000Z", "2026-01-01T10:05:00.000Z")
        ));
        // Began earlier, but the call was answered: the people stayed on.
        assert!(!is_earlier_call_session(
            &call(&["a", "b"]),
            &times("2026-01-01T09:00:00.000Z", "2026-01-01T10:05:00.000Z")
        ));
        // No times: the call's own session.
        assert!(!is_earlier_call_session(
            &call(&["a"]),
            &SessionTimes::default()
        ));
    }
}
