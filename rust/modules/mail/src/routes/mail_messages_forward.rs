//! `POST /api/mail-messages/:id/forward` (`forwardAndPersist`): a forwarded
//! copy for new recipients, the original quoted inline (or attached as an
//! `.eml`), its files travelling with it unless the sender removed them. The
//! forward itself is `weldsuite_mail_domain::forward`, which the public API
//! sends through too.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::json;
use weldsuite_catalogs::entity_events::EMAIL_EMAIL_SENT;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_mail_domain::forward::{ForwardInput, forward_and_persist};
use weldsuite_mail_domain::send::SendOptions;

use super::locate as locate_for_send;
use crate::routes::mail_accounts::email_event_data;
use crate::send::{
    RequestDoh, SendContext, attachments, emails, optional_text, send_error_response,
};
use crate::util::validate;
use crate::{Caller, MailState};

/// `POST /:id/forward`.
pub(super) async fn forward(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, object| {
        let to = emails(issues, object, "to", Presence::Required, Some(1));
        let text = issues.text(object, "body", Presence::Optional, None, None);
        let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
        let files = attachments(issues, object);
        let exclude = issues.list(
            object,
            "excludeAttachmentIds",
            Presence::Optional,
            None,
            Some(100),
            |issues, item| issues.item_text(item, Text::default()),
        );
        let as_attachment = issues.boolean(object, "asAttachment", Presence::Optional);
        let time_zone = issues.text(object, "timeZone", Presence::Optional, None, Some(64));
        // `locale`: checked, but the quoted date is written for en-US.
        issues.text(object, "locale", Presence::Optional, None, Some(35));
        ForwardInput {
            to: to.unwrap_or_default(),
            body: optional_text(text),
            html_body: optional_text(html),
            attachments: files,
            exclude: exclude.into_option().unwrap_or_default(),
            as_attachment: as_attachment.into_option().unwrap_or(false),
            time_zone: optional_text(time_zone),
            idempotency_key: None,
        }
    });
    let data = match input {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let account_id = match locate_for_send(&caller, &id).await {
        Ok(account) => account,
        Err(response) => return response,
    };
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let files = caller.bindings.buckets(&state).file_stores();
    let options = SendOptions {
        workspace_id: Some(caller.workspace_id.clone()),
        ..SendOptions::default()
    };
    let result = forward_and_persist(
        &context.deps(&caller),
        files.as_ref(),
        &org,
        &caller.user_id,
        &account_id,
        &id,
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
                    "conversationId": id,
                }),
            )
            .await;
            caller.publish(&state, EMAIL_EMAIL_SENT, &result.message_id, &event);
            Data(json!({
                "messageId": result.message_id,
                "smtpMessageId": result.smtp_message_id,
                "pendingVerification": result.pending_verification,
                "forwardedFrom": id,
            }))
            .into_response()
        }
        Err(error) => send_error_response(error, "Message", Some(&id), "Failed to forward email"),
    }
}
