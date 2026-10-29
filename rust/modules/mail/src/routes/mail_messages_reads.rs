//! The reads of `/api/mail-messages`: the list (one mailbox, every
//! accessible one, or the CRM's counterparty view), the counters, a message
//! and its thread.

use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::messages::{
    MessageFilters, list_messages_wide, live_messages_by_ids, locate_messages, mailbox_message,
    mailbox_stats, message_account_id, message_stats, public_attachment, thread_of_message,
};

use crate::Caller;
use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, MailResult, answer, list_response, query_map, validate_query};

/// The list projection the route has always served (`toLegacyListItem`).
const LEGACY_KEYS: [&str; 24] = [
    "id",
    "accountId",
    "messageId",
    "threadId",
    "from",
    "to",
    "cc",
    "subject",
    "preview",
    "sentDate",
    "receivedDate",
    "isRead",
    "isStarred",
    "isFlagged",
    "isImportant",
    "isDraft",
    "hasAttachments",
    "attachmentCount",
    "priority",
    "labels",
    "sizeBytes",
    "scheduledFor",
    "sendStatus",
    "createdAt",
];

fn legacy_item(row: &Value) -> Value {
    let mut out = Map::new();
    for key in LEGACY_KEYS {
        if let Some(value) = row.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `resolveLegacyCursor(store, accountIds, cursorId)`: the cursor message's
/// sort position (deleted messages included), or none.
async fn legacy_cursor(
    caller: &Caller,
    account_ids: &[String],
    cursor: Option<&str>,
) -> MailResult<Option<(String, String)>> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    if account_ids.is_empty() {
        return Ok(None);
    }
    let owner = if account_ids.len() == 1 {
        Some(account_ids[0].clone())
    } else {
        locate_messages(&caller.db, &[cursor.to_owned()], account_ids, true)
            .await?
            .into_iter()
            .find(|(id, _)| id == cursor)
            .map(|(_, account)| account)
    };
    let Some(owner) = owner else { return Ok(None) };
    let rows = live_messages_by_ids(&caller.db, &owner, &[cursor.to_owned()], true).await?;
    Ok(rows
        .first()
        .and_then(|row| row["sentDate"].as_str())
        .map(|at| (at.to_owned(), cursor.to_owned())))
}

/// `GET /`.
pub(super) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let account = issues.text(q, "accountId", Presence::Optional, None, None);
        let limit = issues.number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..Number::default()
            },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        let search = issues.text(q, "search", Presence::Optional, None, None);
        let mut flag = |key: &str| {
            issues
                .text(q, key, Presence::Optional, None, None)
                .into_option()
                .map(|v| v == "true")
        };
        let is_read = flag("isRead");
        let is_starred = flag("isStarred");
        let is_flagged = flag("isFlagged");
        let has_attachments = flag("hasAttachments");
        let thread = issues.text(q, "threadId", Presence::Optional, None, None);
        let label = issues.text(q, "label", Presence::Optional, None, None);
        let counterparty = issues.text(q, "counterparty", Presence::Optional, Some(1), None);
        (
            account.into_option(),
            limit.into_option(),
            cursor.into_option(),
            MessageFilters {
                search: search.into_option(),
                is_read,
                is_starred,
                is_flagged,
                has_attachments,
                thread_id: thread.into_option(),
                label: label.into_option(),
                ..MessageFilters::default()
            },
            counterparty.into_option(),
        )
    });
    let (account, limit, cursor, mut filters, counterparty) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account_ids = match account.filter(|a| !a.is_empty()) {
            Some(account) => {
                if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                    return Err(MailError::forbidden(NO_ACCESS));
                }
                vec![account]
            }
            None => {
                let ids = accessible_account_ids(&caller.db, &caller.user_id).await?;
                if ids.is_empty() {
                    return Ok(list_response(Vec::new(), 0, false, None));
                }
                ids
            }
        };
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit.map_or(50, |l| l.ceil() as i64);
        let cursor = legacy_cursor(&caller, &account_ids, cursor.as_deref()).await?;
        let filters = match counterparty.filter(|c| !c.is_empty()) {
            Some(counterparty) => MessageFilters {
                accessible_account_ids: Some(account_ids),
                limit: Some(limit),
                cursor,
                counterparty: Some(counterparty),
                ..MessageFilters::default()
            },
            None => {
                filters.limit = Some(limit);
                filters.cursor = cursor;
                if account_ids.len() == 1 {
                    filters.account_id = Some(account_ids[0].clone());
                } else {
                    filters.accessible_account_ids = Some(account_ids);
                }
                filters
            }
        };
        let page = list_messages_wide(&caller.db, &filters).await?;
        let next = if page.has_more {
            page.data
                .last()
                .and_then(|row| row["id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        let data = page.data.iter().map(legacy_item).collect();
        Ok(list_response(data, page.total_count, next.is_some(), next))
    }
    .await;
    answer(result, "Failed to list mail messages")
}

/// `GET /stats`: one mailbox's counters and folder counts, or the unified
/// counters of every accessible mailbox.
pub(super) async fn stats(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = query_map(raw.as_deref())
        .remove("accountId")
        .filter(|a| !a.is_empty());
    let result = async {
        if let Some(account) = account {
            if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                return Err(MailError::forbidden(NO_ACCESS));
            }
            return Ok(Data(mailbox_stats(&caller.db, &account).await?).into_response());
        }
        let ids = accessible_account_ids(&caller.db, &caller.user_id).await?;
        Ok(Data(message_stats(&caller.db, &ids).await?).into_response())
    }
    .await;
    answer(result, "Failed to fetch message stats")
}

/// `locateMessageOrRespond`: the message's mailbox among those the caller
/// may open; otherwise 404 when it does not exist, 403 when it is in a
/// mailbox closed to the caller.
pub(crate) async fn locate(caller: &Caller, id: &str, resource: &str) -> MailResult<String> {
    let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
    if !accessible.is_empty()
        && let Some((_, account)) = locate_messages(&caller.db, &[id.to_owned()], &accessible, false)
            .await?
            .into_iter()
            .find(|(found, _)| found == id)
    {
        return Ok(account);
    }
    match message_account_id(&caller.db, id).await? {
        None => Err(MailError::not_found(resource, Some(id))),
        Some(_) => Err(MailError::forbidden(NO_ACCESS)),
    }
}

/// `GET /:id`: the message with its bodies and live attachments (without
/// their storage paths).
pub(super) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let account = locate(&caller, &id, "Message").await?;
        let Some(mut row) = mailbox_message(&caller.db, &account, &id, true, true).await? else {
            return Err(MailError::not_found("Message", Some(&id)));
        };
        let attachments: Vec<Value> = row["attachments"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a["deletedAt"].is_null())
            .map(public_attachment)
            .collect();
        row["attachments"] = Value::Array(attachments);
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch message")
}

/// `GET /:id/thread`.
pub(super) async fn thread(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let _account = locate(&caller, &id, "Thread for message").await?;
        match thread_of_message(&caller.db, &id).await? {
            Some(thread) => Ok(Data(thread).into_response()),
            None => Err(MailError::not_found("Thread for message", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch thread")
}
