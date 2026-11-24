//! Webhook events of the legs the server dialled to ring agents' browsers
//! (`client_state` has `agentLegId`), and the caller hanging up while
//! waiting (`services/desk-phone-legs.ts`).
//!
//! Every state change is a conditional update, so a duplicate or
//! out-of-order event finds the work done and does nothing. Telnyx commands
//! that fail because a leg is gone are logged and swallowed.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::DESK_CONVERSATION_ASSIGNED;
use weldsuite_db::{orm, utc_now};
use weldsuite_desk_domain::realtime::now_ms;
use weldsuite_desk_domain::webchat::{Append, append_desk_message};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_schema::tenant::{desk_conversations, desk_phone_call_legs as legs, voip_calls};

use crate::desk_phone_messages::{fanout, member_display_name, post_phone_message};
use crate::desk_phone_options;
use crate::desk_phone_queue::{CallEventInput, as_string, best_effort, call_state};
use crate::desk_phone_realtime::{publish_queue_change, send_inbox_event};
use crate::desk_phone_ring::{
    Call, MIN_RING_MS_FOR_NEXT_ROUND, Phone, end_leg, end_ringing_legs, epoch_ms,
    hangup_best_effort, load_call, load_waiting_call, notify_phone_ended, ring_agents,
    ring_waiting_calls, ringing_legs, set_leg_control,
};
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
type LegRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    PrimitiveDateTime,
);

/// `handleAgentLegEvent(ev)`: route an event of an agent leg.
pub(crate) async fn handle_agent_leg_event(
    phone: &Phone<'_>,
    event_type: &str,
    leg_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let db = phone.db;
    let row: Option<LegRow> = legs::Entity::find()
        .select_only()
        .columns([
            legs::Column::Id,
            legs::Column::CallId,
            legs::Column::UserId,
            legs::Column::ProviderCallId,
            legs::Column::Status,
            legs::Column::CreatedAt,
        ])
        .filter(legs::Column::Id.eq(leg_id))
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    let Some((id, call_id, user_id, provider_call_id, status, created_at)) = row else {
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
        created_ms: epoch_ms(created_at),
    };
    let leg_control = as_string(&payload["call_control_id"]);
    if matches!(event_type, "call.initiated" | "call.answered")
        && let Some(control) = leg_control
    {
        set_leg_control(db, &leg.id, control)
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
    // The claim: one conditional update, so of two agents answering at once
    // only one finds the call unanswered.
    let now = utc_now();
    let won = voip_calls::Entity::update_many()
        .col_expr(voip_calls::Column::AgentAnsweredAt, Expr::value(now))
        .col_expr(
            voip_calls::Column::AnsweredByUserId,
            Expr::value(&leg.user_id),
        )
        .col_expr(voip_calls::Column::UserId, Expr::value(&leg.user_id))
        .col_expr(voip_calls::Column::Outcome, Expr::value("answered"))
        .col_expr(voip_calls::Column::UpdatedAt, Expr::value(now))
        .filter(voip_calls::Column::Id.eq(&leg.call_id))
        .filter(voip_calls::Column::AgentAnsweredAt.is_null())
        .filter(voip_calls::Column::EndedAt.is_null())
        .filter(voip_calls::Column::Outcome.is_null())
        .exec_with_returning(&orm(db))
        .await
        .map_err(|error| error.to_string())?;
    let Some(won) = won.into_iter().next().map(Call::from_model) else {
        // The same event delivered twice for the winner must not hang the
        // winner up.
        let call = load_call(db, &leg.call_id).await?;
        if call.and_then(|call| call.answered_by_user_id).as_deref() == Some(leg.user_id.as_str()) {
            return Ok(());
        }
        let ended = end_leg(db, &leg.id).await?;
        hangup_best_effort(phone, agent_control).await;
        // They lost the race and are free again. When the leg was ended
        // already, whoever ended it offers them the next caller.
        if ended {
            ring_waiting_calls(phone, None).await;
        }
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

    legs::Entity::update_many()
        .col_expr(legs::Column::Status, Expr::value("answered"))
        .filter(legs::Column::Id.eq(&leg.id))
        .filter(legs::Column::Status.eq("ringing"))
        .exec(&orm(db))
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
    // The members whose browsers stopped ringing are free: their legs' own
    // hangups find them ended, so the next waiting caller is offered here.
    if !others.is_empty() {
        ring_waiting_calls(phone, None).await;
    }
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
    voip_calls::Entity::update_many()
        .col_expr(
            voip_calls::Column::AgentAnsweredAt,
            Expr::value(Option::<PrimitiveDateTime>::None),
        )
        .col_expr(
            voip_calls::Column::AnsweredByUserId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(
            voip_calls::Column::Outcome,
            Expr::value(Option::<String>::None),
        )
        .col_expr(voip_calls::Column::UserId, Expr::value(previous_user_id))
        .col_expr(voip_calls::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(voip_calls::Column::Id.eq(call_id))
        .filter(voip_calls::Column::AnsweredByUserId.eq(&leg.user_id))
        .filter(voip_calls::Column::EndedAt.is_null())
        .exec(&orm(phone.db))
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
    let claimed = desk_conversations::Entity::update_many()
        .col_expr(desk_conversations::Column::AssigneeId, Expr::value(user_id))
        .col_expr(
            desk_conversations::Column::UpdatedAt,
            Expr::value(utc_now()),
        )
        .filter(desk_conversations::Column::Id.eq(conversation_id))
        .filter(desk_conversations::Column::AssigneeId.is_null())
        .exec(&orm(phone.db))
        .await
        .map_err(|error| error.to_string())?;
    if claimed.rows_affected == 0 {
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
    if ringing_legs(db, &call.id).await? > 0 {
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
///
/// True when browsers were ringing for it: those members are free again,
/// and the webhook offers them the next waiting caller
/// (`ring_waiting_calls`) once it has finished with this call.
pub(crate) async fn handle_caller_left_queue(ev: &CallEventInput<'_>) -> Result<bool, String> {
    let abandoned = voip_calls::Entity::update_many()
        .col_expr(voip_calls::Column::Outcome, Expr::value("abandoned"))
        .col_expr(voip_calls::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(voip_calls::Column::Id.eq(ev.call_id))
        .filter(voip_calls::Column::QueueEnteredAt.is_not_null())
        .filter(voip_calls::Column::AgentAnsweredAt.is_null())
        .filter(voip_calls::Column::Outcome.is_null())
        .exec(&orm(ev.phone.db))
        .await
        .map_err(|error| error.to_string())?;
    if abandoned.rows_affected == 0 {
        return Ok(false);
    }
    let ended = end_ringing_legs(&ev.phone, ev.call_id, None).await?;
    notify_phone_ended(&ev.phone, ev.call_id, &ended, "caller_hung_up").await;
    publish_queue_change(&ev.phone).await;
    Ok(!ended.is_empty())
}
