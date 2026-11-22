//! `/v1/mail-drafts` (`routes/v1/mail-drafts/index.ts`): compose without
//! sending. A draft shows in its mailbox's Drafts in WeldMail, where a
//! person can review and send it; through the API it can also be sent
//! directly (`POST /:id/send`, [`super::sending`], scope
//! `mail_messages:send`). `attachmentIds` are upload ids, resolved when the
//! draft is sent.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_DRAFT_CREATED, MAIL_DRAFT_DELETED, MAIL_DRAFT_UPDATED,
};
use weldsuite_mail_domain::access::{can_open_account, email_event_data, principal_account_ids};
use weldsuite_mail_domain::drafts::{
    DraftInput, create_draft, get_draft, list_drafts, soft_delete_draft, update_draft,
};

use super::schemas::{CREATE_DRAFT, LIST_DRAFTS, UPDATE_DRAFT};
use super::{MailCaller, opt_strings, opt_text};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, created, no_content, ok};
use crate::list::Page;
use crate::session::not_found;
use crate::zod::{self, Parsed};

type S = State<ExternalApiState>;

/// The draft when it is in a mailbox the caller may open.
pub(super) async fn reachable_draft(mail: &MailCaller, id: &str) -> Result<Option<Value>, Fail> {
    let Some(draft) = get_draft(mail.db(), id).await? else {
        return Ok(None);
    };
    let account = draft["accountId"].as_str().unwrap_or_default();
    if !can_open_account(mail.db(), account, &mail.principal).await? {
        return Ok(None);
    }
    Ok(Some(draft))
}

async fn reachable_or_404(mail: &MailCaller, id: &str) -> Result<Value, Fail> {
    reachable_draft(mail, id)
        .await?
        .ok_or_else(|| not_found("MailDraft", id).into())
}

/// `draftEventData(c, draft)`: the subject only for a shared mailbox.
async fn event_data(mail: &MailCaller, draft: &Value) -> Value {
    let cleared = email_event_data(
        mail.db(),
        json!({ "accountId": draft["accountId"], "subject": draft["subject"], "from": null, "to": null }),
    )
    .await;
    json!({ "id": draft["id"], "accountId": draft["accountId"], "subject": cleared["subject"] })
}

/// A body's draft fields.
fn input(parsed: &Parsed) -> DraftInput {
    DraftInput {
        account_id: opt_text(parsed, "accountId"),
        subject: opt_text(parsed, "subject"),
        to: opt_strings(parsed, "to"),
        cc: opt_strings(parsed, "cc"),
        bcc: opt_strings(parsed, "bcc"),
        reply_to: opt_strings(parsed, "replyTo"),
        body: opt_text(parsed, "body"),
        html_body: opt_text(parsed, "htmlBody"),
        importance: opt_text(parsed, "importance"),
        labels: opt_strings(parsed, "labels"),
        attachment_ids: opt_strings(parsed, "attachmentIds"),
        in_reply_to: opt_text(parsed, "inReplyTo"),
        original_message_id: opt_text(parsed, "originalMessageId"),
        is_reply: parsed.get("isReply").and_then(Value::as_bool),
        is_forward: parsed.get("isForward").and_then(Value::as_bool),
    }
}

/// `GET /`: one mailbox's drafts, or those of every mailbox in reach.
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_DRAFTS, raw.as_deref())?;
    let account = q.text("accountId");
    if let Some(account) = account
        && !can_open_account(mail.db(), account, &mail.principal).await?
    {
        return Err(not_found("MailAccount", account).into());
    }
    #[allow(clippy::cast_possible_truncation)] // 1..=100
    let limit = q
        .get("limit")
        .and_then(Value::as_f64)
        .map_or(50, |n| n.floor() as i64);
    let cursor = q.get("cursor").and_then(Value::as_str);
    let page = if let Some(account) = account {
        list_drafts(mail.db(), Some(account), None, Some(limit), cursor).await?
    } else {
        let accessible = principal_account_ids(mail.db(), &mail.principal).await?;
        list_drafts(mail.db(), None, Some(&accessible), Some(limit), cursor).await?
    };
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows: page.data,
            total: page.total_count,
            has_more: page.has_more,
            cursor: page.cursor.map_or(Value::Null, Value::String),
        }
        .respond(),
    ))
}

/// `GET /:id`.
pub(super) async fn detail(mail: MailCaller, Path(id): Path<String>) -> Answer {
    ok(reachable_or_404(&mail, &id).await?)
}

/// `POST /`: `isReply` follows `inReplyTo` when not given.
pub(super) async fn create(
    State(state): S,
    mail: MailCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_DRAFT, &headers, &body)?;
    let account = parsed.text("accountId").unwrap_or_default().to_owned();
    if !can_open_account(mail.db(), &account, &mail.principal).await? {
        return Err(not_found("MailAccount", &account).into());
    }
    let mut data = input(&parsed);
    if data.is_reply.is_none() && data.in_reply_to.as_deref().is_some_and(|r| !r.is_empty()) {
        data.is_reply = Some(true);
    }
    let row = create_draft(mail.db(), &account, &data).await?;
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let event = event_data(&mail, &row).await;
    mail.caller
        .publish(&state.events, MAIL_DRAFT_CREATED, &id, event);
    created(row)
}

/// `PATCH /:id`: moving a draft to another mailbox needs that one too.
pub(super) async fn update(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_DRAFT, &headers, &body)?;
    reachable_or_404(&mail, &id).await?;
    let data = input(&parsed);
    if let Some(account) = data.account_id.as_deref().filter(|a| !a.is_empty())
        && !can_open_account(mail.db(), account, &mail.principal).await?
    {
        return Err(not_found("MailAccount", account).into());
    }
    let Some(after) = update_draft(mail.db(), &id, &data).await? else {
        return Err(not_found("MailDraft", &id).into());
    };
    let event = event_data(&mail, &after).await;
    mail.caller
        .publish(&state.events, MAIL_DRAFT_UPDATED, &id, event);
    ok(after)
}

/// `DELETE /:id`.
pub(super) async fn remove(State(state): S, mail: MailCaller, Path(id): Path<String>) -> Answer {
    let draft = reachable_or_404(&mail, &id).await?;
    soft_delete_draft(mail.db(), &id).await?;
    let event = event_data(&mail, &draft).await;
    mail.caller
        .publish(&state.events, MAIL_DRAFT_DELETED, &id, event);
    no_content()
}
