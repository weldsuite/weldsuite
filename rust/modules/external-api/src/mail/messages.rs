//! `/v1/mail-messages` (`routes/v1/mail-messages/index.ts`): read and
//! organize. Lists return headers only, newest `sentDate` first; bodies
//! come with the single read. Organizing (flags, labels, moving, bulk,
//! delete) changes WeldSuite's copy only: nothing is written back to Gmail,
//! Outlook or IMAP. Without an `accountId` a list covers exactly the
//! mailboxes the principal opens, and a message elsewhere is a 404. Reply
//! and forward are in [`super::sending`].

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{EMAIL_DELETED, EMAIL_UPDATED};
use weldsuite_mail_domain::access::{can_open_account, email_event_data, principal_account_ids};
use weldsuite_mail_domain::attachments::{list_for_message, public_attachment};
use weldsuite_mail_domain::labels::{
    self, ARCHIVE, INBOX, SPAM, STARRED, TRASH, is_location_label, normalize_label,
};
use weldsuite_mail_domain::messages::{
    FlagPatch, MessageFilters, bulk_flags, change_message_labels, existing_ids, list_messages_wide,
    live_messages_by_ids, locate_messages, mailbox_message, soft_delete_message,
    update_message_flags,
};
use weldsuite_mail_domain::text::js_trim;

use super::schemas::{BULK, GET_MESSAGE, LIST_MESSAGES, MESSAGE_LABELS, MOVE, UPDATE_MESSAGE};
use super::{MailCaller, bool_flag, public_list_message, public_message, strings};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, no_content, ok};
use crate::list::Page;
use crate::session::{bad_request, not_found};
use crate::zod;

type S = State<ExternalApiState>;

/// `location` → the system label it moves a message to.
fn location_label(location: &str) -> &'static str {
    match location {
        "archive" => ARCHIVE,
        "trash" => TRASH,
        "spam" => SPAM,
        _ => INBOX,
    }
}

/// The message's mailbox when the caller may open it (`reachableAccountId`).
async fn reachable_account(mail: &MailCaller, id: &str) -> Result<Option<String>, Fail> {
    let accessible = principal_account_ids(mail.db(), &mail.principal).await?;
    if accessible.is_empty() {
        return Ok(None);
    }
    Ok(
        locate_messages(mail.db(), &[id.to_owned()], &accessible, false)
            .await?
            .into_iter()
            .find(|(found, _)| found == id)
            .map(|(_, account)| account),
    )
}

/// The message's mailbox, or `Message with ID … not found`.
async fn reachable_or_404(mail: &MailCaller, id: &str) -> Result<String, Fail> {
    reachable_account(mail, id)
        .await?
        .ok_or_else(|| not_found("Message", id).into())
}

/// The mailboxes a list covers: the one asked for (404 when out of
/// reach), else every one the principal opens.
pub(super) async fn list_accounts(
    mail: &MailCaller,
    account: Option<&str>,
) -> Result<Vec<String>, Fail> {
    match account.filter(|a| !a.is_empty()) {
        Some(account) => {
            if !can_open_account(mail.db(), account, &mail.principal).await? {
                return Err(not_found("MailAccount", account).into());
            }
            Ok(vec![account.to_owned()])
        }
        None => Ok(principal_account_ids(mail.db(), &mail.principal).await?),
    }
}

/// An empty page: `list(c, [], cursorPagination(0, false, null))`.
#[allow(clippy::unnecessary_wraps)] // a handler's answer
pub(super) fn empty_page() -> Answer {
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows: Vec::new(),
            total: 0,
            has_more: false,
            cursor: Value::Null,
        }
        .respond(),
    ))
}

/// `resolveLegacyCursor(store, accountIds, cursorId)`: the bare message-id
/// cursor as the sort position before it (deleted messages included, so a
/// client that deletes what it processes keeps paging).
async fn legacy_cursor(
    mail: &MailCaller,
    account_ids: &[String],
    cursor: Option<&str>,
) -> Result<Option<(String, String)>, Fail> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    if account_ids.is_empty() {
        return Ok(None);
    }
    let owner = if account_ids.len() == 1 {
        Some(account_ids[0].clone())
    } else {
        locate_messages(mail.db(), &[cursor.to_owned()], account_ids, true)
            .await?
            .into_iter()
            .find(|(id, _)| id == cursor)
            .map(|(_, account)| account)
    };
    let Some(owner) = owner else { return Ok(None) };
    let rows = live_messages_by_ids(mail.db(), &owner, &[cursor.to_owned()], true).await?;
    Ok(rows
        .first()
        .and_then(|row| row["sentDate"].as_str())
        .map(|at| (at.to_owned(), cursor.to_owned())))
}

/// `GET /`.
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_MESSAGES, raw.as_deref())?;
    let account_ids = list_accounts(&mail, q.text("accountId")).await?;
    if account_ids.is_empty() {
        return empty_page();
    }
    let label = q.text("label").map(normalize_label);
    let cursor =
        legacy_cursor(&mail, &account_ids, q.get("cursor").and_then(Value::as_str)).await?;
    #[allow(clippy::cast_possible_truncation)] // 1..=100
    let limit = q
        .get("limit")
        .and_then(Value::as_f64)
        .map_or(50, |n| n.floor() as i64);
    let include = |key: &str| q.get(key).and_then(Value::as_str) == Some("true");
    let mut filters = MessageFilters {
        limit: Some(limit),
        cursor,
        search: q.get("search").and_then(Value::as_str).map(str::to_owned),
        from: q.get("from").and_then(Value::as_str).map(str::to_owned),
        thread_id: q.get("threadId").and_then(Value::as_str).map(str::to_owned),
        is_read: bool_flag(&q, "isRead"),
        is_starred: bool_flag(&q, "isStarred"),
        is_flagged: bool_flag(&q, "isFlagged"),
        has_attachments: bool_flag(&q, "hasAttachments"),
        exclude_trash: !include("includeTrash") && label.as_deref() != Some(TRASH),
        exclude_spam: !include("includeSpam") && label.as_deref() != Some(SPAM),
        label,
        ..MessageFilters::default()
    };
    if account_ids.len() == 1 {
        filters.account_id = account_ids.into_iter().next();
    } else {
        filters.accessible_account_ids = Some(account_ids);
    }
    let page = list_messages_wide(mail.db(), &filters).await?;
    let next = if page.has_more {
        page.data
            .last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows: page.data.iter().map(public_list_message).collect(),
            total: page.total_count,
            has_more: next.is_some(),
            cursor: next.map_or(Value::Null, Value::String),
        }
        .respond(),
    ))
}

/// A content-free `email` event: label and bulk changes need ids only.
fn publish_id_only(
    state: &ExternalApiState,
    mail: &MailCaller,
    id: &str,
    account_id: &str,
    deleted: bool,
) {
    let data =
        json!({ "id": id, "accountId": account_id, "subject": null, "from": null, "to": null });
    let event = if deleted {
        EMAIL_DELETED
    } else {
        EMAIL_UPDATED
    };
    mail.caller.publish(&state.events, event, id, data);
}

/// `POST /bulk`: every id must be a live message in a mailbox the caller
/// opens; one that isn't fails the whole request.
pub(super) async fn bulk(
    State(state): S,
    mail: MailCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&BULK, &headers, &body)?;
    let action = parsed.text("action").unwrap_or_default().to_owned();
    let mut unique: Vec<String> = Vec::new();
    for id in strings(&parsed, "ids") {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let accessible = principal_account_ids(mail.db(), &mail.principal).await?;
    let located = locate_messages(mail.db(), &unique, &accessible, false).await?;
    let account_of = |id: &str| {
        located
            .iter()
            .find(|(found, _)| found == id)
            .map(|(_, account)| account.clone())
    };
    if let Some(missing) = unique.iter().find(|id| account_of(id).is_none()) {
        return Err(not_found("Message", missing).into());
    }
    let mut by_account: Vec<(String, Vec<String>)> = Vec::new();
    for (id, account) in &located {
        match by_account.iter_mut().find(|(a, _)| a == account) {
            Some((_, ids)) => ids.push(id.clone()),
            None => by_account.push((account.clone(), vec![id.clone()])),
        }
    }
    let now = OffsetDateTime::now_utc();
    for (_, ids) in &by_account {
        apply_bulk(&mail, &action, ids, now).await?;
    }
    for id in &unique {
        let account = account_of(id).unwrap_or_default();
        publish_id_only(&state, &mail, id, &account, action == "delete");
    }
    ok(json!({ "affected": unique.len(), "action": action }))
}

/// `bulkOpFor(action, ids)` applied to one mailbox, as the store applies it.
async fn apply_bulk(
    mail: &MailCaller,
    action: &str,
    ids: &[String],
    now: OffsetDateTime,
) -> Result<(), Fail> {
    let db = mail.db();
    match action {
        "delete" => {
            for id in ids {
                soft_delete_message(db, id, now).await?;
            }
        }
        "archive" | "spam" | "trash" | "restore" => {
            let location = match action {
                "archive" => ARCHIVE,
                "spam" => SPAM,
                "trash" => TRASH,
                _ => INBOX,
            };
            let live = existing_ids(db, ids).await?;
            if !live.is_empty() {
                labels::move_messages_to_location(db, &live, location, now).await?;
            }
        }
        "star" | "unstar" => {
            let live = existing_ids(db, ids).await?;
            if !live.is_empty() {
                if action == "star" {
                    labels::bulk_add_label(db, STARRED, &live, now).await?;
                } else {
                    labels::bulk_remove_label(db, STARRED, &live, now).await?;
                }
            }
        }
        _ => {
            let patch = match action {
                "markRead" => FlagPatch {
                    is_read: Some(true),
                    ..FlagPatch::default()
                },
                "markUnread" => FlagPatch {
                    is_read: Some(false),
                    ..FlagPatch::default()
                },
                "flag" => FlagPatch {
                    is_flagged: Some(true),
                    ..FlagPatch::default()
                },
                _ => FlagPatch {
                    is_flagged: Some(false),
                    ..FlagPatch::default()
                },
            };
            let live = existing_ids(db, ids).await?;
            bulk_flags(db, &live, patch, now).await?;
        }
    }
    Ok(())
}

/// `GET /:id`: the message with its bodies and live attachments
/// (`includeHtml=false`: the plain text only, when there is one).
pub(super) async fn detail(
    mail: MailCaller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&GET_MESSAGE, raw.as_deref())?;
    let account = reachable_or_404(&mail, &id).await?;
    let Some(mut row) = mailbox_message(mail.db(), &account, &id, true, true).await? else {
        return Err(not_found("Message", &id).into());
    };
    let files = row
        .as_object_mut()
        .and_then(|object| object.remove("attachments"))
        .unwrap_or(Value::Array(Vec::new()));
    let text_only = q.get("includeHtml").and_then(Value::as_str) == Some("false")
        && row["textBody"]
            .as_str()
            .is_some_and(|text| !js_trim(text).is_empty());
    let mut message = public_message(row);
    if text_only {
        message["htmlBody"] = Value::Null;
    }
    message["attachments"] = Value::Array(
        files
            .as_array()
            .into_iter()
            .flatten()
            .filter(|file| file["deletedAt"].is_null())
            .map(public_attachment)
            .collect(),
    );
    ok(message)
}

/// `GET /:id/attachments`.
pub(super) async fn attachments(mail: MailCaller, Path(id): Path<String>) -> Answer {
    reachable_or_404(&mail, &id).await?;
    let rows: Vec<Value> = list_for_message(mail.db(), &id)
        .await?
        .iter()
        .map(weldsuite_mail_domain::attachments::AttachmentRow::public)
        .collect();
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows,
            total,
            has_more: false,
            cursor: Value::Null,
        }
        .respond(),
    ))
}

/// `PATCH /:id`: flags.
pub(super) async fn update(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_MESSAGE, &headers, &body)?;
    let account = reachable_or_404(&mail, &id).await?;
    let flag = |key: &str| parsed.get(key).and_then(Value::as_bool);
    let patch = FlagPatch {
        is_read: flag("isRead"),
        is_starred: flag("isStarred"),
        is_flagged: flag("isFlagged"),
        is_important: flag("isImportant"),
        ..FlagPatch::default()
    };
    if !update_message_flags(mail.db(), &id, patch, OffsetDateTime::now_utc()).await? {
        return Err(not_found("Message", &id).into());
    }
    let after = mailbox_message(mail.db(), &account, &id, true, false)
        .await?
        .unwrap_or(Value::Null);
    let to = after["to"].as_array().map(|recipients| {
        recipients
            .iter()
            .map(|r| r["email"].as_str().unwrap_or_default().to_owned())
            .filter(|email| !email.is_empty())
            .collect::<Vec<_>>()
    });
    let data = email_event_data(
        mail.db(),
        json!({
            "id": id,
            "accountId": account,
            "subject": after["subject"],
            "from": after["from"]["email"],
            "to": to,
        }),
    )
    .await;
    mail.caller.publish(&state.events, EMAIL_UPDATED, &id, data);
    ok(public_message(after))
}

/// `POST /:id/labels`: user labels only; a location is moved to instead.
pub(super) async fn labels(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&MESSAGE_LABELS, &headers, &body)?;
    let account = reachable_or_404(&mail, &id).await?;
    let add: Vec<String> = strings(&parsed, "add")
        .iter()
        .map(|l| normalize_label(l))
        .collect();
    let remove: Vec<String> = strings(&parsed, "remove")
        .iter()
        .map(|l| normalize_label(l))
        .collect();
    if let Some(location) = add.iter().chain(&remove).find(|l| is_location_label(l)) {
        return Err(bad_request(format!(
            "{location} is a location, not a label. Use POST /v1/mail-messages/{id}/move."
        ))
        .into());
    }
    let now = OffsetDateTime::now_utc();
    let mut applied = false;
    let mut labels: Vec<String> = Vec::new();
    for (list, adding) in [(&add, true), (&remove, false)] {
        if list.is_empty() {
            continue;
        }
        if let Some(next) = change_message_labels(mail.db(), &id, list, adding, now).await? {
            applied = true;
            labels = next;
        }
    }
    if !applied {
        return Err(not_found("Message", &id).into());
    }
    publish_id_only(&state, &mail, &id, &account, false);
    ok(json!({ "id": id, "labels": labels }))
}

/// `POST /:id/move`: to the inbox, the archive, the trash or spam.
pub(super) async fn move_to(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&MOVE, &headers, &body)?;
    let account = reachable_or_404(&mail, &id).await?;
    let location = parsed.text("location").unwrap_or("inbox").to_owned();
    let live = existing_ids(mail.db(), std::slice::from_ref(&id)).await?;
    if !live.is_empty() {
        labels::move_messages_to_location(
            mail.db(),
            &live,
            location_label(&location),
            OffsetDateTime::now_utc(),
        )
        .await?;
    }
    publish_id_only(&state, &mail, &id, &account, false);
    ok(json!({ "id": id, "location": location }))
}

/// `DELETE /:id`: a soft delete.
pub(super) async fn remove(State(state): S, mail: MailCaller, Path(id): Path<String>) -> Answer {
    let account = reachable_or_404(&mail, &id).await?;
    let before =
        live_messages_by_ids(mail.db(), &account, std::slice::from_ref(&id), false).await?;
    if !soft_delete_message(mail.db(), &id, OffsetDateTime::now_utc()).await? {
        return Err(not_found("Message", &id).into());
    }
    let subject = before
        .first()
        .map_or(Value::Null, |row| row["subject"].clone());
    let data = email_event_data(
        mail.db(),
        json!({ "id": id, "accountId": account, "subject": subject, "from": null, "to": null }),
    )
    .await;
    mail.caller.publish(&state.events, EMAIL_DELETED, &id, data);
    no_content()
}
