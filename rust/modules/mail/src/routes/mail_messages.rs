//! `/api/mail-messages` (`routes/mail-messages/index.ts`), the send paths
//! only: `POST /:id/reply` (and `/:id/forward`). The reads, updates and bulk
//! actions belong to the mailbox workstream.

use std::sync::Arc;

use axum::Extension;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::json;
use weldsuite_catalogs::entity_events::EMAIL_REPLY_SENT;
use weldsuite_catalogs::permission_keys::MESSAGES_CREATE;
use weldsuite_kit::validation::{Issues, Presence, json_body};
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_mail_domain::send::{ReplyInput, SendOptions, reply_and_persist};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::routes::mail_accounts::email_event_data;
use crate::send::{RequestDoh, SendContext, attachments, optional_text, send_error_response};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-messages/{id}/reply",
            post(reply).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .with_state(state)
}

/// `replyBody`.
fn read_reply_body(headers: &HeaderMap, body: &Bytes) -> Result<ReplyInput, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let value = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let Some(object) = issues.object(&value) else {
        return Err(issues.finish().err().map_or_else(
            || ApiError::internal().into_response(),
            IntoResponse::into_response,
        ));
    };
    let text = issues.text(object, "body", Presence::Optional, None, None);
    let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
    let reply_all = issues.boolean(object, "replyAll", Presence::Optional);
    let files = attachments(&mut issues, object);
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(ReplyInput {
        body: optional_text(text),
        html_body: optional_text(html),
        reply_all: reply_all.into_option().unwrap_or(false),
        attachments: files,
        idempotency_key: None,
    })
}

/// `messages.getMessageAccountId(db, id)`.
async fn message_account(caller: &Caller, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select account_id from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await
}

/// The send's guard checks before the body: the account of the message, and
/// the caller's access to it.
async fn locate(caller: &Caller, id: &str) -> Result<String, Response> {
    let account_id = match message_account(caller, id).await {
        Ok(Some(account_id)) => account_id,
        Ok(None) => return Err(ApiError::not_found("Message", Some(id)).into_response()),
        Err(error) => {
            tracing::error!(%error, "[mail-messages] message lookup failed");
            return Err(ApiError::internal().into_response());
        }
    };
    match check_account_access(&caller.db, &account_id, &caller.user_id).await {
        Ok(true) => Ok(account_id),
        Ok(false) => Err(ApiError::forbidden()
            .with_message("Access to this mail account is not allowed")
            .into_response()),
        Err(error) => {
            tracing::error!(%error, "[mail-messages] access check failed");
            Err(ApiError::internal().into_response())
        }
    }
}

/// `POST /:id/reply`.
async fn reply(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_reply_body(&headers, &body) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    if let Err(response) = locate(&caller, &id).await {
        return response;
    }
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let result = reply_and_persist(
        &context.deps(&caller),
        &org,
        &caller.user_id,
        &id,
        &data,
        &SendOptions::default(),
    )
    .await;
    match result {
        Ok((result, replied_to)) => {
            let event = email_event_data(
                &caller,
                &result.account_id,
                json!({
                    "id": result.message_id,
                    "accountId": result.account_id,
                    "subject": result.subject,
                    "from": null,
                    "to": null,
                    "conversationId": replied_to,
                }),
            )
            .await;
            caller.publish(&state, EMAIL_REPLY_SENT, &result.message_id, &event);
            Data(json!({
                "messageId": result.message_id,
                "smtpMessageId": result.smtp_message_id,
                "pendingVerification": result.pending_verification,
                "repliedTo": replied_to,
            }))
            .into_response()
        }
        Err(error) => send_error_response(error, "Message", Some(&id), "Failed to send reply"),
    }
}
