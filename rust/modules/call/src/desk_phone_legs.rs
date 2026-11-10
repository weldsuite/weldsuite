//! Webhook events of the legs the server dialled to ring agents' browsers
//! (`client_state` has `agentLegId`), and the caller hanging up while
//! waiting (`services/desk-phone-legs.ts`).
//!
//! Every state change is a conditional update, so a duplicate or
//! out-of-order event finds the work done and does nothing. Telnyx commands
//! that fail because a leg is gone are logged and swallowed.

use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::DESK_CONVERSATION_ASSIGNED;
use weldsuite_desk_domain::realtime::now_ms;
use weldsuite_desk_domain::webchat::{Append, append_desk_message};
use weldsuite_events::{EntityEvent, EventContext, EventSource};

use crate::desk_phone_messages::{fanout, member_display_name, post_phone_message};
use crate::desk_phone_options;
use crate::desk_phone_queue::{CallEventInput, as_string, best_effort, call_state};
use crate::desk_phone_realtime::{publish_queue_change, send_inbox_event};
use crate::desk_phone_ring::{
    Call, MIN_RING_MS_FOR_NEXT_ROUND, Phone, end_leg, end_ringing_legs, hangup_best_effort,
    load_call, load_waiting_call, notify_phone_ended, ring_agents, ring_waiting_calls,
};
use crate::now;
use crate::telnyx::Recording;

/// A `desk_phone_call_legs` row as an event finds it.
struct Leg {
    id: String,
    call_id: String,
    user_id: String,
    provider_call_id: Option<String>,
    status: String,
    /// `createdAt.getTime()`.
    created_ms: i64,
}

/// `(id, callId, userId, providerCallId, status, createdAt)`.
type LegRow = (String, String, String, Option<String>, String, i64);

/// `handleAgentLegEvent(ev)`: route an event of an agent leg.
pub(crate) async fn handle_agent_leg_event(
    phone: &Phone<'_>,
    event_type: &str,
    leg_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let db = phone.db;
    let row: Option<LegRow> = sqlx::query_as(
        "select id, call_id, user_id, provider_call_id, status,
                floor(extract(epoch from created_at) * 1000)::int8
         from desk_phone_call_legs where id = $1 limit 1",
    )
    .bind(leg_id)
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let Some((id, call_id, user_id, provider_call_id, status, created_ms)) = row else {
        tracing::warn!(
            event_type,
            leg_id,
            "[desk-phone] event for unknown agent leg"
        );
        return Ok(());
    };
    let leg = Leg {
        id,
        call_id,
        user_id,
        provider_call_id,
        status,
        created_ms,
    };
    let leg_control = as_string(&payload["call_control_id"]);
    if matches!(event_type, "call.initiated" | "call.answered")
        && let Some(control) = leg_control
    {
        sqlx::query(
            "update desk_phone_call_legs set provider_call_id = $2
             where id = $1 and provider_call_id is null",
        )
        .bind(&leg.id)
        .bind(control)
        .execute(db)
        .await
        .map_err(|error| error.to_string())?;
    }
    // `leg.providerCallId ?? legCallControlId ?? null`.
    let provider_call_id = leg.provider_call_id.as_deref().or(leg_control);
    match event_type {
        "call.answered" => on_agent_answered(phone, &leg, provider_call_id).await,
        "call.hangup" => on_agent_hangup(phone, &leg).await,
        _ => Ok(()),
    }
}

/// `onAgentAnswered(ctx, leg, agentCallControlId)`: the agent accepted in
/// the browser; the first one wins the call.
async fn on_agent_answered(
    phone: &Phone<'_>,
    leg: &Leg,
    agent_control: Option<&str>,
) -> Result<(), String> {
    let db = phone.db;
    let previous_user_id = load_call(db, &leg.call_id)
        .await?
        .map_or_else(|| "system".to_owned(), |call| call.user_id);
    let won: Option<Value> = sqlx::query_scalar(
        "update voip_calls set agent_answered_at = $3::timestamp, answered_by_user_id = $2,
             user_id = $2, outcome = 'answered', updated_at = $3::timestamp
         where id = $1 and agent_answered_at is null and ended_at is null and outcome is null
         returning to_jsonb(voip_calls)",
    )
    .bind(&leg.call_id)
    .bind(&leg.user_id)
    .bind(now())
    .fetch_optional(db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(won) = won.map(Call::from_row) else {
        // The same event delivered twice for the winner must not hang the
        // winner up.
        let call = load_call(db, &leg.call_id).await?;
        if call.and_then(|call| call.answered_by_user_id).as_deref() == Some(leg.user_id.as_str()) {
            return Ok(());
        }
        end_leg(db, &leg.id).await?;
        hangup_best_effort(phone, agent_control).await;
        return Ok(());
    };

    let caller_control = won.control();
    let agent_control = agent_control.filter(|control| !control.is_empty());
    let mut bridged = false;
    if let (Some(caller), Some(agent)) = (caller_control, agent_control) {
        match phone.telnyx.bridge(agent, caller).await {
            Ok(_) => bridged = true,
            Err(error) => tracing::error!(%error, call = %won.id, "[desk-phone] bridge failed"),
        }
    } else {
        tracing::error!(call = %won.id, "[desk-phone] call cannot be bridged: missing call_control_id");
    }
    if !bridged {
        return return_to_queue(phone, leg, &won.id, &previous_user_id, agent_control).await;
    }

    sqlx::query(
        "update desk_phone_call_legs set status = 'answered'
         where id = $1 and status = 'ringing'",
    )
    .bind(&leg.id)
    .execute(db)
    .await
    .map_err(|error| error.to_string())?;

    if let Some(caller) = caller_control {
        best_effort("hold audio stop", phone.telnyx.playback_stop(caller).await);
        if won.is_recorded {
            let state = call_state(
                &won.id,
                phone.workspace,
                won.conversation(),
                &[("stage", "call")],
            );
            let recording = Recording {
                client_state: Some(&state),
                ..Recording::default()
            };
            best_effort(
                "call record_start",
                phone.telnyx.record_start_with(caller, recording).await,
            );
        }
    }

    let others = end_ringing_legs(phone, &won.id, Some(&leg.id)).await?;
    notify_phone_ended(phone, &won.id, &others, "answered_elsewhere").await;
    send_inbox_event(
        phone,
        &leg.user_id,
        "phone.answered",
        json!({
            "callId": won.id,
            "conversationId": won.desk_conversation_id,
            "answeredByUserId": leg.user_id,
        }),
    )
    .await;
    publish_queue_change(phone).await;
    record_answer(phone, &won, &leg.user_id).await;
    Ok(())
}

/// The bridge failed, so nobody is on the call: give it back to the queue
/// (the claim undone, its owner as before). The other ringing legs are
/// untouched.
async fn return_to_queue(
    phone: &Phone<'_>,
    leg: &Leg,
    call_id: &str,
    previous_user_id: &str,
    agent_control: Option<&str>,
) -> Result<(), String> {
    end_leg(phone.db, &leg.id).await?;
    hangup_best_effort(phone, agent_control).await;
    sqlx::query(
        "update voip_calls set agent_answered_at = null, answered_by_user_id = null,
             outcome = null, user_id = $3, updated_at = $4::timestamp
         where id = $1 and answered_by_user_id = $2 and ended_at is null",
    )
    .bind(call_id)
    .bind(&leg.user_id)
    .bind(previous_user_id)
    .bind(now())
    .execute(phone.db)
    .await
    .map_err(|error| error.to_string())?;
    send_inbox_event(
        phone,
        &leg.user_id,
        "phone.ended",
        json!({ "callId": call_id, "reason": "timeout" }),
    )
    .await;
    publish_queue_change(phone).await;
    ring_waiting_calls(phone, None).await;
    Ok(())
}

/// `recordAnswer(ctx, call, userId)`: give the conversation to the answerer
/// (when nobody owns it) and say who answered.
async fn record_answer(phone: &Phone<'_>, call: &Call, user_id: &str) {
    let Some(conversation_id) = call.conversation() else {
        return;
    };
    if let Err(error) = assign_to_answerer(phone, conversation_id, user_id).await {
        tracing::error!(%error, "[desk-phone] assigning the conversation failed");
    }
    let name = member_display_name(phone.db, user_id)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "an agent".to_owned());
    post_phone_message(
        phone,
        Some(conversation_id),
        format!("Call answered by {name}"),
        json!({ "event": "call_answered", "callId": call.id, "userId": user_id }),
    )
    .await;
}

/// The conversation's owner becomes the member who answered, when it has
/// none: the `assigned` event on its timeline, published as the widget and
/// email paths publish an assignment.
async fn assign_to_answerer(
    phone: &Phone<'_>,
    conversation_id: &str,
    user_id: &str,
) -> Result<(), String> {
    let claimed: Option<String> = sqlx::query_scalar(
        "update desk_conversations set assignee_id = $2, updated_at = $3::timestamp
         where id = $1 and assignee_id is null returning id",
    )
    .bind(conversation_id)
    .bind(user_id)
    .bind(now())
    .fetch_optional(phone.db)
    .await
    .map_err(|error| error.to_string())?;
    if claimed.is_none() {
        return Ok(());
    }
    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("assigned"));
    metadata.insert("assigneeId".to_owned(), json!(user_id));
    metadata.insert("via".to_owned(), json!("phone"));
    let (conversation, message) = append_desk_message(
        phone.db,
        Append {
            conversation_id,
            kind: "event",
            author_type: "system",
            author_id: None,
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: Some(Some(user_id.to_owned())),
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let context = EventContext::new(phone.workspace, "system", EventSource::System);
    phone
        .state
        .events
        .publish_and_wait(
            &context,
            EntityEvent::new(
                DESK_CONVERSATION_ASSIGNED,
                conversation["id"].as_str().unwrap_or_default(),
                conversation.clone(),
            ),
        )
        .await;
    fanout(phone.state, phone.workspace, &conversation, &message, true).await;
    Ok(())
}

/// `onAgentHangup(ctx, leg)`: an agent leg ended, so hang the caller up
/// with an answered leg, or ring on when everyone let it ring out.
async fn on_agent_hangup(phone: &Phone<'_>, leg: &Leg) -> Result<(), String> {
    let db = phone.db;
    if !end_leg(db, &leg.id).await? {
        return Ok(());
    }
    let Some(call) = load_call(db, &leg.call_id).await? else {
        return Ok(());
    };
    if leg.status == "answered" {
        hangup_best_effort(phone, call.provider_call_id.as_deref()).await;
        // The agent is free: offer them the oldest waiting caller.
        ring_waiting_calls(phone, Some(&call.id)).await;
        return Ok(());
    }

    // A round has ended only when no other leg of it is still ringing.
    let ringing: i64 = sqlx::query_scalar(
        "select count(*) from desk_phone_call_legs where call_id = $1 and status = 'ringing'",
    )
    .bind(&call.id)
    .fetch_one(db)
    .await
    .map_err(|error| error.to_string())?;
    if ringing > 0 {
        return Ok(());
    }
    if load_waiting_call(db, &call.id).await?.is_none() {
        // This call is settled: the members who were ringing for it can take
        // the next caller.
        ring_waiting_calls(phone, None).await;
        return Ok(());
    }
    // A leg that failed at once (a broken credential) must not spin a dial
    // loop.
    if now_ms() - leg.created_ms < MIN_RING_MS_FOR_NEXT_ROUND {
        return Ok(());
    }
    let options = desk_phone_options::for_number(db, &call.to_number)
        .await
        .map_err(|error| error.to_string())?;
    ring_agents(phone, &call, &options.ring_seconds, &[]).await?;
    Ok(())
}

/// `handleCallerLeftQueue(ev)`: the caller's `call.hangup`, for a call that
/// was waiting for an agent. It is abandoned, the ringing browsers stop and
/// the queue count drops.
pub(crate) async fn handle_caller_left_queue(ev: &CallEventInput<'_>) -> Result<(), String> {
    let abandoned: Option<String> = sqlx::query_scalar(
        "update voip_calls set outcome = 'abandoned', updated_at = $2::timestamp
         where id = $1 and queue_entered_at is not null and agent_answered_at is null
           and outcome is null
         returning id",
    )
    .bind(ev.call_id)
    .bind(now())
    .fetch_optional(ev.phone.db)
    .await
    .map_err(|error| error.to_string())?;
    if abandoned.is_none() {
        return Ok(());
    }
    let ended = end_ringing_legs(&ev.phone, ev.call_id, None).await?;
    notify_phone_ended(&ev.phone, ev.call_id, &ended, "caller_hung_up").await;
    publish_queue_change(&ev.phone).await;
    Ok(())
}
