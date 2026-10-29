//! `/api/mail-accounts` (`routes/mail-accounts/index.ts`), the send only:
//! `POST /:id/send` composes and sends a new email from the account and keeps
//! a SENT copy. The account CRUD belongs to the accounts workstream.

use std::sync::Arc;

use axum::Extension;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::EMAIL_EMAIL_SENT;
use weldsuite_catalogs::permission_keys::MESSAGES_CREATE;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text, json_body};
use weldsuite_mail_domain::send::{SendInput, SendOptions, send_and_persist};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::send::{
    EMAIL, RequestDoh, SendContext, attachments, emails, optional_text, send_error_response,
};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-accounts/{id}/send",
            post(send).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .with_state(state)
}

/// `sendBody`.
fn read_send_body(headers: &HeaderMap, body: &Bytes) -> Result<SendInput, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let value = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let Some(object) = issues.object(&value) else {
        return Err(issues.finish().err().map_or_else(
            || weldsuite_kit::ApiError::internal().into_response(),
            IntoResponse::into_response,
        ));
    };
    let to = emails(&mut issues, object, "to", Presence::Required, Some(1));
    let cc = emails(&mut issues, object, "cc", Presence::Optional, None);
    let bcc = emails(&mut issues, object, "bcc", Presence::Optional, None);
    let subject = issues.text(object, "subject", Presence::Optional, None, None);
    let text = issues.text(object, "body", Presence::Optional, None, None);
    let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
    let reply_to = issues.text_with(object, "replyTo", Presence::Optional, EMAIL);
    let in_reply_to = issues.text(object, "inReplyTo", Presence::Optional, None, None);
    let references = issues
        .list(
            object,
            "references",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::length(None, None)),
        )
        .into_option();
    issues.choice(
        object,
        "importance",
        Presence::Optional,
        &["low", "normal", "high"],
    );
    let files = attachments(&mut issues, object);
    let key = issues.text(
        object,
        "idempotencyKey",
        Presence::Optional,
        Some(1),
        Some(64),
    );
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(SendInput {
        to: to.unwrap_or_default(),
        cc,
        bcc,
        // `.default('(No subject)')`.
        subject: Some(optional_text(subject).unwrap_or_else(|| "(No subject)".to_owned())),
        body: optional_text(text),
        html_body: optional_text(html),
        reply_to: optional_text(reply_to),
        in_reply_to: optional_text(in_reply_to),
        references,
        attachments: files,
        idempotency_key: optional_text(key),
    })
}

/// `emailEventData(db, data)`: the content only for a shared mailbox.
pub(crate) async fn email_event_data(caller: &Caller, account_id: &str, mut data: Value) -> Value {
    let shared = match weldsuite_mail_domain::access::load_access_fields(&caller.db, account_id)
        .await
    {
        Ok(fields) => fields.is_some_and(|f| f.is_shared),
        Err(error) => {
            tracing::error!(%error, "[mail/access] Could not resolve account for email event, dropping content");
            false
        }
    };
    if !shared {
        data["subject"] = Value::Null;
        data["from"] = Value::Null;
        data["to"] = Value::Null;
    }
    data
}

/// `POST /:id/send`.
async fn send(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_send_body(&headers, &body) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let options = SendOptions::default();
    let result = send_and_persist(
        &context.deps(&caller),
        &org,
        &caller.user_id,
        &account_id,
        &data,
        &options,
    )
    .await;
    match result {
        Ok(result) => {
            let event = email_event_data(
                &caller,
                &result.account_id,
                json!({
                    "id": result.message_id,
                    "accountId": result.account_id,
                    "subject": result.subject,
                    "from": null,
                    "to": data.to,
                }),
            )
            .await;
            caller.publish(&state, EMAIL_EMAIL_SENT, &result.message_id, &event);
            Data(json!({
                "messageId": result.message_id,
                "smtpMessageId": result.smtp_message_id,
                "pendingVerification": result.pending_verification,
                "message": if result.pending_verification {
                    "Send is pending recipient verification"
                } else {
                    "Email sent successfully"
                },
            }))
            .into_response()
        }
        Err(error) => send_error_response(error, "Mail account", None, "Failed to send email"),
    }
}
