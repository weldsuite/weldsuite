//! `/api/chat-clips` (`routes/chat-clips/index.ts`): a voice or video
//! clip's transcript, kept on the clip attachment of its message.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::CHAT_MESSAGE_UPDATED;
use weldsuite_chat_domain::can_access_channel;
use weldsuite_chat_domain::publish::object;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ChatState;
use crate::access::{Caller, ChatError, ChatResult, answer, validate};
use crate::groups::channels::read_transcript;
use crate::util::now;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/{id}",
            post(transcribe).route_layer(gate.require(["messages:create"])),
        )
        .route(
            "/{id}/{message_id}/transcript",
            patch(update_transcript).route_layer(gate.require(["messages:update"])),
        )
}

/// The message's attachments and the index of the clip `attachment_id`.
async fn clip_of(
    caller: &Caller,
    channel_id: &str,
    message_id: &str,
    attachment_id: &str,
) -> ChatResult<(Vec<Value>, usize)> {
    if !can_access_channel(&caller.db, channel_id, &caller.user_id, None).await? {
        return Err(ChatError::forbidden("You do not have access to this channel"));
    }
    let row: Option<Option<Value>> = sqlx::query_scalar(
        "select attachments from chat_messages
         where id = $1 and channel_id = $2 and deleted_at is null limit 1",
    )
    .bind(message_id)
    .bind(channel_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(attachments) = row else {
        return Err(ChatError::not_found("Message", Some(message_id)));
    };
    let attachments = attachments
        .and_then(|a| a.as_array().cloned())
        .unwrap_or_default();
    let index = attachments.iter().position(|a| {
        a["id"].as_str() == Some(attachment_id)
            && a.as_object().is_some_and(|fields| fields.contains_key("clipType"))
    });
    let Some(index) = index else {
        return Err(ChatError::not_found("Clip attachment", Some(attachment_id)));
    };
    Ok((attachments, index))
}

async fn save(caller: &Caller, message_id: &str, attachments: Vec<Value>) -> Result<(), sqlx::Error> {
    sqlx::query("update chat_messages set attachments = $2, updated_at = $3::timestamp where id = $1")
        .bind(message_id)
        .bind(Value::Array(attachments))
        .bind(now())
        .execute(&caller.db)
        .await?;
    Ok(())
}

/// `POST /:channelId`: mark a clip's transcript as processing.
async fn transcribe(
    State(state): State<ChatState>,
    caller: Caller,
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let message = issues.string(body, "messageId", true, None, None).unwrap_or_default();
        let attachment = issues.string(body, "attachmentId", true, None, None).unwrap_or_default();
        (message, attachment)
    });
    let (message_id, attachment_id) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let (mut attachments, index) = clip_of(&caller, &channel_id, &message_id, &attachment_id).await?;
        if let Some(Value::Object(clip)) = attachments.get_mut(index) {
            clip.insert("transcript".to_owned(), json!({ "status": "processing" }));
        }
        save(&caller, &message_id, attachments).await?;
        tracing::warn!(
            message = %message_id,
            attachment = %attachment_id,
            "[app-api/chat-clips] Transcription requested but no dispatcher is wired"
        );
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &message_id,
            &json!({ "id": message_id, "channelId": channel_id }),
        );
        Ok(Data(json!({ "messageId": message_id, "attachmentId": attachment_id, "status": "processing" }))
            .into_response())
    }
    .await;
    answer(result, "Failed to trigger transcription")
}

/// `PATCH /:channelId/:messageId/transcript`: the transcript, from the
/// transcription callback.
async fn update_transcript(
    State(state): State<ChatState>,
    caller: Caller,
    Path((channel_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let attachment = issues.string(body, "attachmentId", true, None, None).unwrap_or_default();
        let transcript = match issues.nested(body, "transcript", Presence::Required, read_transcript) {
            Field::Set(transcript) => transcript,
            _ => Value::Null,
        };
        (attachment, transcript)
    });
    let (attachment_id, transcript) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let (mut attachments, index) = clip_of(&caller, &channel_id, &message_id, &attachment_id).await?;
        if let Some(Value::Object(clip)) = attachments.get_mut(index) {
            clip.insert("transcript".to_owned(), transcript.clone());
        }
        save(&caller, &message_id, attachments).await?;
        let data: Map<String, Value> = object([
            ("messageId", Some(Value::from(message_id.as_str()))),
            ("attachmentId", Some(Value::from(attachment_id.as_str()))),
            ("transcript", Some(transcript.clone())),
        ]);
        Caller::realtime(&state).clip_transcript_updated(&channel_id, data).await;
        caller.publish(
            &state,
            CHAT_MESSAGE_UPDATED,
            &message_id,
            &json!({ "id": message_id, "channelId": channel_id }),
        );
        Ok(Data(json!({ "messageId": message_id, "attachmentId": attachment_id, "transcript": transcript }))
            .into_response())
    }
    .await;
    answer(result, "Failed to update transcript")
}
