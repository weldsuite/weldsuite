//! `/api/desk/phone/queue` (`routes/desk-phone/queue.ts`): callers waiting
//! for an agent, oldest first, and a member picking one up (their softphone
//! is rung for that call).
//!
//! Waiting = queued, no agent yet, not ended, no outcome. No entity events:
//! the waiting set is announced on the realtime topic `desk_phone_queue`.

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use weldsuite_kit::{ApiError, Data};

use crate::desk_phone_options;
use crate::desk_phone_realtime::waiting_calls;
use crate::desk_phone_ring::{
    MemberRing, StaffedAgent, conversation_caller_name, load_call, ring_member,
};
use crate::{CallState, Caller, internal};

/// A waiting call: `(callId, conversationId, fromNumber, departmentId,
/// queueEnteredAt, the conversation's name)`.
type WaitingRow = (
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// `GET /api/desk/phone/queue`.
pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let rows: Vec<WaitingRow> = sqlx::query_as(concat!(
            "select c.id, c.desk_conversation_id, c.from_number, c.department_id,
                    to_jsonb(c.queue_entered_at) #>> '{}', d.name
             from voip_calls c
             left join desk_conversations d on d.id = c.desk_conversation_id
             where ",
            waiting_calls!(),
            " order by c.queue_entered_at asc, c.id asc"
        ))
        .fetch_all(&caller.db)
        .await?;
        let mut ringing: Vec<String> = Vec::new();
        if !rows.is_empty() {
            let ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
            ringing = sqlx::query_scalar(
                "select call_id from desk_phone_call_legs
                 where call_id = any($1) and status = 'ringing'",
            )
            .bind(&ids)
            .fetch_all(&caller.db)
            .await?;
        }
        let waiting: Vec<Value> = rows
            .into_iter()
            .map(
                |(call_id, conversation_id, from_number, department_id, entered, name)| {
                    // `(r.queueEnteredAt ?? new Date(0)).toISOString()`.
                    let waiting_since = entered
                        .as_deref()
                        .and_then(weldsuite_db::js_timestamp)
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned());
                    json!({
                        "callId": call_id,
                        "conversationId": conversation_id,
                        "fromNumber": from_number,
                        "callerName": conversation_caller_name(name.as_deref(), &from_number),
                        "departmentId": department_id,
                        "waitingSince": waiting_since,
                        "ringing": ringing.contains(&call_id),
                    })
                },
            )
            .collect();
        Ok::<_, sqlx::Error>(waiting)
    }
    .await;
    match result {
        Ok(waiting) => Data(waiting).into_response(),
        Err(error) => internal(&error, "Internal server error"),
    }
}

/// `POST /api/desk/phone/queue/:callId/pickup`: ring the calling member for
/// that call.
pub(crate) async fn pickup(
    State(state): State<CallState>,
    caller: Caller,
    Path(call_id): Path<String>,
) -> Response {
    let result = async {
        let Some(call) = load_call(&caller.db, &call_id).await? else {
            return Ok(ApiError::not_found("Call", Some(&call_id)).into_response());
        };
        if !call.waiting {
            return Ok(ApiError::conflict("The call is no longer waiting").into_response());
        }
        if call.control().is_none() {
            return Ok(ApiError::conflict("The call cannot be picked up yet").into_response());
        }
        let sip_username: Option<Option<String>> = sqlx::query_scalar(
            "select sip_username from desk_phone_agents where user_id = $1 limit 1",
        )
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|error| error.to_string())?;
        let Some(sip_username) = sip_username.flatten().filter(|sip| !sip.is_empty()) else {
            return Ok(ApiError::conflict("You have no softphone credential yet").into_response());
        };
        if caller.env("TELNYX_API_KEY").is_none() || caller.env("TELNYX_CONNECTION_ID").is_none() {
            return Ok(ApiError::bad_request("Phone service is not activated").into_response());
        }
        let options = desk_phone_options::for_number(&caller.db, &call.to_number)
            .await
            .map_err(|error| error.to_string())?;
        let telnyx = caller.telnyx(&state);
        let org = caller.org();
        let agent = StaffedAgent {
            user_id: caller.user_id.clone(),
            sip_username,
        };
        let rung = ring_member(
            &caller.phone(&state, &telnyx, &org),
            &call,
            &agent,
            &options.ring_seconds,
        )
        .await?;
        if rung == MemberRing::Failed {
            return Ok(ApiError::bad_gateway()
                .with_message("Could not ring your softphone")
                .into_response());
        }
        Ok::<_, String>(Data(json!({ "callId": call_id, "ringing": true })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Internal server error"))
}
