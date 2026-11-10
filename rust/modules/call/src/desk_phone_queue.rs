//! The caller's side of a WeldDesk phone call that is offered to the team
//! (`services/desk-phone-queue.ts`): queue entry (`agents`), the unanswered
//! path, and voicemail.
//!
//! `client_state` of the caller's leg is `{ callId, workspaceId,
//! deskConversationId?, record: 'false', voiceAgentId?, stage? }`. `stage`
//! says which step a command belongs to, because several `call.speak.ended`
//! / `call.recording.saved` events happen on one call:
//!   `menu`                keypad prompt playing (`call.gather.ended` follows)
//!   `queue`               parked in the Telnyx queue
//!   `voicemail_greeting`  greeting playing (`call.speak.ended` starts the recording)
//!   `voicemail`           recording the message (`call.recording.saved` ends the call)
//!   `call`                bridged to an agent, call recording on
//! `record` is always `false` here: these flows start recordings themselves.

use serde_json::{Map, Value, json};

use crate::desk_phone_audio::ringback_url;
use crate::desk_phone_messages::post_phone_message;
use crate::desk_phone_options::{
    self, PHONE_VOICE, RouteOptions, default_voicemail_greeting, queue_name,
};
use crate::desk_phone_realtime::publish_queue_change;
use crate::desk_phone_ring::{
    Call, Phone, end_ringing_legs, load_call, notify_phone_ended, ring_agents, staffed_agents,
};
use crate::js::Ordered;
use crate::now;
use crate::telnyx::{Recording, Speech, TelnyxError, encode_client_state};

/// `callState(ctx, extra)`: the `client_state` for a command of these flows,
/// i.e. `stateBase` (`{ callId, workspaceId, deskConversationId? }`), `record`
/// off, then `extra`.
pub(crate) fn call_state(
    call_id: &str,
    workspace: &str,
    conversation_id: Option<&str>,
    extra: &[(&str, &str)],
) -> String {
    let mut state = Ordered::new()
        .with("callId", call_id)
        .with("workspaceId", workspace);
    if let Some(conversation_id) = conversation_id.filter(|id| !id.is_empty()) {
        state = state.with("deskConversationId", conversation_id);
    }
    state = state.with("record", "false");
    for (key, value) in extra {
        state = state.with(key, *value);
    }
    encode_client_state(&state)
}

/// `CallFlowContext`: what the flows need to command and describe one call.
#[derive(Clone, Copy)]
pub(crate) struct Flow<'a> {
    pub(crate) phone: Phone<'a>,
    pub(crate) call_id: &'a str,
    /// The caller leg's `call_control_id`.
    pub(crate) call_control_id: &'a str,
    pub(crate) conversation_id: Option<&'a str>,
}

impl Flow<'_> {
    /// `callState(ctx, extra)`.
    pub(crate) fn state(&self, extra: &[(&str, &str)]) -> String {
        call_state(
            self.call_id,
            self.phone.workspace,
            self.conversation_id,
            extra,
        )
    }
}

/// `flowContextOf(base, call)`: the flow context of a call row, or `None`
/// when the caller leg has no `call_control_id` yet.
pub(crate) fn flow_of<'a>(phone: Phone<'a>, call: &'a Call) -> Option<Flow<'a>> {
    Some(Flow {
        phone,
        call_id: &call.id,
        call_control_id: call.control()?,
        conversation_id: call.conversation(),
    })
}

/// `bestEffort(label, run)`: a Telnyx command whose failure (the call is
/// probably gone) is logged and nothing more.
pub(crate) fn best_effort(label: &str, result: Result<Value, TelnyxError>) {
    if let Err(error) = result {
        tracing::warn!(%error, "[desk-phone] {label} failed");
    }
}

/// `asString(value)`: a string that is not empty.
pub(crate) fn as_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

/// `startAgentsFlow(ctx, { answered, options, departmentId })`: ring the
/// team, i.e. join the queue, play hold audio, ring the agents' browsers.
pub(crate) async fn start_agents_flow(
    flow: &Flow<'_>,
    answered: bool,
    options: &RouteOptions,
    department_id: Option<&str>,
) -> Result<(), String> {
    let Phone { db, telnyx, .. } = flow.phone;
    let control = flow.call_control_id;
    if !answered {
        telnyx
            .answer(control, Some(&flow.state(&[])))
            .await
            .map_err(|error| error.to_string())?;
    }
    // The conditional update is the guard: a duplicate event finds the call
    // queued already.
    let queued: Option<Value> = sqlx::query_scalar(
        "update voip_calls set queue_entered_at = $2::timestamp, department_id = $3,
             updated_at = $2::timestamp
         where id = $1 and queue_entered_at is null and outcome is null
         returning to_jsonb(voip_calls)",
    )
    .bind(flow.call_id)
    .bind(now())
    .bind(department_id)
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(call) = queued.map(Call::from_row) else {
        return Ok(());
    };
    // Nobody staffed: waiting would be pointless.
    if staffed_agents(db, department_id).await?.is_empty() {
        return handle_unanswered(flow, "nobody_staffed").await;
    }
    if let Some(greeting) = options.greeting.as_deref() {
        let state = flow.state(&[]);
        let speech = Speech {
            voice: PHONE_VOICE,
            language: &options.language,
            client_state: Some(&state),
        };
        best_effort(
            "queue greeting",
            telnyx.speak(control, greeting, speech).await,
        );
    }
    // The queue's max wait is the caller's timer.
    let enqueued = telnyx
        .enqueue(
            control,
            &queue_name(flow.phone.workspace, department_id),
            &options.max_wait_seconds,
            Some(&flow.state(&[("stage", "queue")])),
        )
        .await;
    if let Err(error) = enqueued {
        tracing::error!(%error, "[desk-phone] enqueue failed");
        return handle_unanswered(flow, "enqueue_failed").await;
    }
    best_effort(
        "hold audio",
        telnyx
            .playback_start_looped(control, &ringback_url(flow.phone.env))
            .await,
    );
    publish_queue_change(&flow.phone).await;
    ring_agents(&flow.phone, &call, &options.ring_seconds, &[]).await?;
    Ok(())
}

/// `handleUnanswered(ctx, reason)`: nobody answered in time (or nobody was
/// staffed), so stop the ringing, count the call missed, then voicemail or
/// hang up per the route. Idempotent: only the event that moves the call
/// from "no outcome" does anything.
pub(crate) async fn handle_unanswered(flow: &Flow<'_>, reason: &str) -> Result<(), String> {
    let Phone { db, telnyx, .. } = flow.phone;
    let missed: Option<Value> = sqlx::query_scalar(
        "update voip_calls set outcome = 'missed', updated_at = $2::timestamp
         where id = $1 and outcome is null and agent_answered_at is null and ended_at is null
         returning to_jsonb(voip_calls)",
    )
    .bind(flow.call_id)
    .bind(now())
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(call) = missed.map(Call::from_row) else {
        return Ok(());
    };
    tracing::info!(call = flow.call_id, reason, "[desk-phone] call unanswered");

    let ended = end_ringing_legs(&flow.phone, flow.call_id, None).await?;
    notify_phone_ended(&flow.phone, flow.call_id, &ended, "timeout").await;
    publish_queue_change(&flow.phone).await;

    let options = desk_phone_options::for_number(db, &call.to_number)
        .await
        .map_err(|error| error.to_string())?;
    if options.when_unanswered == "voicemail" {
        return start_voicemail(flow, true, true, &options).await;
    }
    best_effort(
        "hangup after no answer",
        telnyx.hangup(flow.call_control_id, None).await,
    );
    post_phone_message(
        &flow.phone,
        flow.conversation_id,
        "Missed call".to_owned(),
        json!({ "event": "call_missed", "callId": flow.call_id }),
    )
    .await;
    Ok(())
}

/// `startVoicemail(ctx, { answered, fromQueue, options })`: the greeting,
/// then (on `call.speak.ended`) the recording.
pub(crate) async fn start_voicemail(
    flow: &Flow<'_>,
    answered: bool,
    from_queue: bool,
    options: &RouteOptions,
) -> Result<(), String> {
    let Phone { db, telnyx, .. } = flow.phone;
    let control = flow.call_control_id;
    if !answered {
        telnyx
            .answer(control, Some(&flow.state(&[])))
            .await
            .map_err(|error| error.to_string())?;
    }
    sqlx::query(
        "update voip_calls set outcome = 'missed', updated_at = $2::timestamp
         where id = $1 and outcome is null and agent_answered_at is null",
    )
    .bind(flow.call_id)
    .bind(now())
    .execute(db)
    .await
    .map_err(|error| error.to_string())?;

    if from_queue {
        best_effort("hold audio stop", telnyx.playback_stop(control).await);
    }
    let greeting = options
        .voicemail_greeting
        .as_deref()
        .unwrap_or_else(|| default_voicemail_greeting(&options.language));
    let state = flow.state(&[("stage", "voicemail_greeting")]);
    let speech = Speech {
        voice: PHONE_VOICE,
        language: &options.language,
        client_state: Some(&state),
    };
    if let Err(error) = telnyx.speak(control, greeting, speech).await {
        // No greeting is no reason to lose the message: record straight away.
        tracing::warn!(%error, "[desk-phone] voicemail greeting failed, recording without it");
        start_voicemail_recording(&flow.phone, control, &flow.state(&[("stage", "voicemail")]))
            .await;
    }
    Ok(())
}

/// `startVoicemailRecording(ctx)`: a beep, then up to three minutes of the
/// caller's message. `client_state` is the `voicemail` stage's.
async fn start_voicemail_recording(phone: &Phone<'_>, call_control_id: &str, client_state: &str) {
    let recording = Recording {
        single_channel: true,
        play_beep: true,
        max_length: Some(180),
        client_state: Some(client_state),
    };
    best_effort(
        "voicemail record_start",
        phone
            .telnyx
            .record_start_with(call_control_id, recording)
            .await,
    );
}

/// `CallEventInput`: what a webhook event of the caller's leg gives these
/// handlers.
#[derive(Clone, Copy)]
pub(crate) struct CallEventInput<'a> {
    pub(crate) phone: Phone<'a>,
    pub(crate) call_id: &'a str,
    pub(crate) conversation_id: Option<&'a str>,
    pub(crate) client_state: &'a Map<String, Value>,
    pub(crate) payload: &'a Value,
}

impl CallEventInput<'_> {
    /// `ev.clientState.stage`.
    pub(crate) fn stage(&self) -> Option<&str> {
        self.client_state.get("stage").and_then(Value::as_str)
    }
}

/// `handleSpeakEnded(ev)`: `call.speak.ended` in the voicemail greeting
/// stage starts the recording.
pub(crate) async fn handle_speak_ended(ev: &CallEventInput<'_>) {
    if ev.stage() != Some("voicemail_greeting") {
        return;
    }
    let Some(call_control_id) = as_string(&ev.payload["call_control_id"]) else {
        return;
    };
    let state = call_state(
        ev.call_id,
        ev.phone.workspace,
        ev.conversation_id,
        &[("stage", "voicemail")],
    );
    start_voicemail_recording(&ev.phone, call_control_id, &state).await;
}

/// `handleDequeued(ev)`: `call.dequeued`; only a timeout needs action
/// (agents answering, the caller leaving and so on are handled elsewhere).
pub(crate) async fn handle_dequeued(ev: &CallEventInput<'_>) -> Result<(), String> {
    if ev.payload["reason"] != "timeout" {
        return Ok(());
    }
    let Some(call) = load_call(ev.phone.db, ev.call_id).await? else {
        return Ok(());
    };
    let Some(flow) = flow_of(ev.phone, &call) else {
        return Ok(());
    };
    handle_unanswered(&flow, "queue_timeout").await
}

/// `handleVoicemailSaved(ev, { url, duration })`: a voicemail finished
/// recording, so the call's outcome is `voicemail`, the inbox gets a message
/// it can render as one, and the caller leg is hung up.
pub(crate) async fn handle_voicemail_saved(
    ev: &CallEventInput<'_>,
    url: &Value,
    duration: Option<i64>,
) -> Result<(), String> {
    let saved: Option<String> = sqlx::query_scalar(
        "update voip_calls set outcome = 'voicemail', updated_at = $2::timestamp
         where id = $1 and (outcome is null or outcome = 'missed') returning id",
    )
    .bind(ev.call_id)
    .bind(now())
    .fetch_optional(ev.phone.db)
    .await
    .map_err(|error| error.to_string())?;
    // A duplicate event finds the outcome set already: no second message.
    if saved.is_some() {
        let body = match duration.filter(|seconds| *seconds != 0) {
            Some(seconds) => format!("Voicemail ({seconds}s)"),
            None => "Voicemail".to_owned(),
        };
        post_phone_message(
            &ev.phone,
            ev.conversation_id,
            body,
            json!({
                "event": "voicemail",
                "callId": ev.call_id,
                "recordingUrl": url,
                "duration": duration,
            }),
        )
        .await;
    }
    if let Some(call_control_id) = as_string(&ev.payload["call_control_id"]) {
        best_effort(
            "hangup after voicemail",
            ev.phone.telnyx.hangup(call_control_id, None).await,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::telnyx::decode_client_state;

    use super::*;

    #[test]
    fn the_flows_client_state_has_the_recording_off_and_its_stage() {
        let state = call_state("vcall_1", "org_1", Some("dconv_1"), &[("stage", "queue")]);
        let decoded = Value::Object(decode_client_state(Some(&state)));
        assert_eq!(
            decoded,
            json!({
                "callId": "vcall_1",
                "workspaceId": "org_1",
                "deskConversationId": "dconv_1",
                "record": "false",
                "stage": "queue",
            })
        );
        let bare = Value::Object(decode_client_state(Some(&call_state(
            "vcall_1",
            "org_1",
            None,
            &[],
        ))));
        assert_eq!(
            bare,
            json!({ "callId": "vcall_1", "workspaceId": "org_1", "record": "false" })
        );
        assert_eq!(as_string(&json!("cc-1")), Some("cc-1"));
        assert_eq!(as_string(&json!("")), None);
        assert_eq!(as_string(&json!(7)), None);
    }
}
