//! Realtime publishes (`services/realtime/weldmeet-publisher.ts`,
//! `weldmeet-chat-publisher.ts`, the lifecycle's `publishEnded` and the
//! `call_superseded` notice). Best effort: a failed publish is logged.

use serde_json::{Map, Value, json};
use weldsuite_chat_domain::publish::Realtime;

use crate::MeetState;

fn realtime(state: &MeetState) -> Realtime {
    Realtime::new(state.realtime.clone())
}

/// `publishMeetingUpdated(env, workspaceId, data)`.
pub(crate) async fn meeting_updated(state: &MeetState, workspace_id: &str, data: Value) {
    realtime(state)
        .workspace(workspace_id, "meeting", "updated", data, "system")
        .await;
}

/// `publishSessionStarted(env, workspaceId, data)`.
pub(crate) async fn session_started(
    state: &MeetState,
    workspace_id: &str,
    meeting_id: &str,
    session_id: &str,
    started_by: &str,
) {
    realtime(state)
        .workspace(
            workspace_id,
            "meeting_session",
            "created",
            json!({ "meetingId": meeting_id, "sessionId": session_id, "startedBy": started_by }),
            started_by,
        )
        .await;
}

/// The lifecycle's `publishEnded`: the session (ended) and the meeting's
/// new status. Skipped without a workspace.
pub(crate) async fn session_ended(
    state: &MeetState,
    workspace_id: &str,
    meeting_id: &str,
    session_id: &str,
    duration: i64,
    meeting_status: &str,
) {
    if workspace_id.is_empty() {
        return;
    }
    let realtime = realtime(state);
    realtime
        .workspace(
            workspace_id,
            "meeting_session",
            "updated",
            json!({
                "meetingId": meeting_id,
                "sessionId": session_id,
                "duration": duration,
                "status": "ended",
            }),
            "system",
        )
        .await;
    realtime
        .workspace(
            workspace_id,
            "meeting",
            "updated",
            json!({ "meetingId": meeting_id, "status": meeting_status }),
            "system",
        )
        .await;
}

/// `chatCallSuperseded(orgId, userId, data)` (`announceSuperseded`).
pub(crate) async fn call_superseded(
    state: &MeetState,
    workspace_id: &str,
    user_id: &str,
    data: Value,
) {
    if workspace_id.is_empty() {
        return;
    }
    realtime(state)
        .chat_user(workspace_id, user_id, "call_superseded", data)
        .await;
}

/// `publishMeetingChatMessage(env, meetingId, message)`: `chatMessage` on
/// the `meet_<meetingId>` room.
pub(crate) async fn chat_message(state: &MeetState, meeting_id: &str, message: Map<String, Value>) {
    realtime(state)
        .message(&format!("meet_{meeting_id}"), message)
        .await;
}

/// `publishMeetingChatMessageDeleted(env, meetingId, messageId)`.
pub(crate) async fn chat_message_deleted(state: &MeetState, meeting_id: &str, message_id: &str) {
    realtime(state)
        .chat(
            &format!("meet_{meeting_id}"),
            json!({ "type": "message:deleted", "id": message_id }),
        )
        .await;
}
