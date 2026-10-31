//! The writes of `/api/mail-messages`: flag / label / thread updates, bulk
//! actions, delete, and single-message label changes. Each mirrors the
//! `MailboxOp` the TypeScript route applies through the `postgres` store.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{EMAIL_DELETED, EMAIL_UPDATED};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Data, NoContent};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_mail_domain::labels::{self, INBOX, STARRED, TRASH};
use weldsuite_mail_domain::messages::{
    FlagPatch, change_message_labels, existing_ids, live_messages_by_ids, set_labels,
    set_thread_id, soft_delete_message, update_message_flags,
};

use super::reads::locate;
use crate::read_push::{clears_unread_banner, queue_mail_read_push};
use crate::routes::mail_accounts::email_event_data;
use crate::routes::mail_labels::{NO_ACCESS_SOME, group_by_account};
use crate::util::{MailError, answer, strings, validate};
use crate::{Caller, MailState};

const FLAG_KEYS: [&str; 6] = [
    "isRead",
    "isStarred",
    "isFlagged",
    "isImportant",
    "isSpam",
    "isTrash",
];

/// `updateBody`: the given fields in the schema's order.
fn read_update(headers: &HeaderMap, body: &Bytes) -> Result<Map<String, Value>, MailError> {
    validate(headers, body, |issues, body| {
        let mut out = Map::new();
        for key in FLAG_KEYS {
            if let Some(v) = issues.boolean(body, key, Presence::Optional).into_option() {
                out.insert(key.into(), Value::Bool(v));
            }
        }
        if let Some(v) = issues
            .text(body, "threadId", Presence::Optional, None, None)
            .into_option()
        {
            out.insert("threadId".into(), Value::String(v));
        }
        if let Some(v) = issues
            .list(
                body,
                "labels",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
        {
            out.insert("labels".into(), json!(v));
        }
        out
    })
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

/// `PUT|PATCH /:id` (`patchHandler`): flags, then an explicit label set,
/// then a thread move.
pub(super) async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_update(&headers, &body) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = locate(&caller, &id, "Message").await?;
        let now = OffsetDateTime::now_utc();
        let patch = FlagPatch {
            is_read: flag(&data, "isRead"),
            is_starred: flag(&data, "isStarred"),
            is_flagged: flag(&data, "isFlagged"),
            is_important: flag(&data, "isImportant"),
            is_spam: flag(&data, "isSpam"),
            is_trash: flag(&data, "isTrash"),
        };
        let mut missing = !update_message_flags(&caller.db, &id, patch, now).await?;
        let labels = data.get("labels").map(strings);
        if let Some(labels) = &labels {
            missing |= set_labels(&caller.db, &id, labels, now).await?.is_none();
        }
        if let Some(thread) = data.get("threadId").and_then(Value::as_str) {
            missing |= !set_thread_id(&caller.db, &id, thread, now).await?;
        }
        if missing {
            return Err(MailError::not_found("Message", Some(&id)));
        }
        let after = live_messages_by_ids(&caller.db, &account, std::slice::from_ref(&id), false)
            .await?
            .into_iter()
            .next();
        let (subject, from, to) = match &after {
            Some(row) => (
                row["subject"].clone(),
                row["from"]
                    .get("email")
                    .cloned()
                    .filter(|v| !v.is_null())
                    .unwrap_or(Value::Null),
                match row["to"].as_array() {
                    Some(items) => json!(
                        items
                            .iter()
                            .filter_map(|t| t.get("email").and_then(Value::as_str))
                            .filter(|e| !e.is_empty())
                            .collect::<Vec<_>>()
                    ),
                    None => Value::Null,
                },
            ),
            None => (Value::Null, Value::Null, Value::Null),
        };
        let event = email_event_data(
            &caller,
            &account,
            json!({ "id": id, "accountId": account, "subject": subject, "from": from, "to": to }),
        )
        .await;
        caller.publish(&state, EMAIL_UPDATED, &id, &event);
        if clears_unread_banner(
            patch.is_read,
            patch.is_trash,
            patch.is_spam,
            labels.as_deref(),
        ) {
            queue_mail_read_push(&state, &caller, &account, vec![id.clone()]);
        }
        let mut answer = Map::new();
        answer.insert("id".into(), Value::String(id.clone()));
        answer.extend(data);
        Ok(Data(Value::Object(answer)).into_response())
    }
    .await;
    answer(result, "Failed to update message")
}

const BULK_ACTIONS: [&str; 9] = [
    "markRead",
    "markUnread",
    "star",
    "unstar",
    "flag",
    "unflag",
    "trash",
    "restore",
    "delete",
];

/// `bulkOpFor(action, ids)` applied to one mailbox's ids.
async fn apply_bulk(caller: &Caller, action: &str, ids: &[String]) -> Result<(), sqlx::Error> {
    let now = OffsetDateTime::now_utc();
    match action {
        "markRead" | "markUnread" | "flag" | "unflag" => {
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
            let live = existing_ids(&caller.db, ids).await?;
            weldsuite_mail_domain::messages::bulk_flags(&caller.db, &live, patch, now).await?;
        }
        "star" | "unstar" => {
            let live = existing_ids(&caller.db, ids).await?;
            if !live.is_empty() {
                if action == "star" {
                    labels::bulk_add_label(&caller.db, STARRED, &live, now).await?;
                } else {
                    labels::bulk_remove_label(&caller.db, STARRED, &live, now).await?;
                }
            }
        }
        "trash" | "restore" => {
            let live = existing_ids(&caller.db, ids).await?;
            if !live.is_empty() {
                let location = if action == "trash" { TRASH } else { INBOX };
                labels::move_messages_to_location(&caller.db, &live, location, now).await?;
            }
        }
        _ => {
            for id in ids {
                soft_delete_message(&caller.db, id, now).await?;
            }
        }
    }
    Ok(())
}

/// `POST /bulk`: all or nothing on access; the requested count back.
pub(super) async fn bulk(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let ids = issues.list(
            body,
            "messageIds",
            Presence::Required,
            Some(1),
            Some(100),
            |issues, item| issues.item_text(item, Text::default()),
        );
        let action = issues.choice(body, "action", Presence::Required, &BULK_ACTIONS);
        (
            ids.into_option().unwrap_or_default(),
            action.into_option().unwrap_or_default(),
        )
    });
    let (ids, action) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        // Every id's true mailbox, whatever the caller's access.
        let located: Vec<(String, String)> = sqlx::query_as(
            "select id, account_id from mail_messages where id = any($1::text[]) and deleted_at is null",
        )
        .bind(&ids)
        .fetch_all(&caller.db)
        .await?;
        let mut checked: Vec<&String> = Vec::new();
        for (_, account) in &located {
            if checked.contains(&account) {
                continue;
            }
            if !check_account_access(&caller.db, account, &caller.user_id).await? {
                return Err(MailError::forbidden(NO_ACCESS_SOME));
            }
            checked.push(account);
        }
        let groups = group_by_account(&located);
        for (_, group) in &groups {
            apply_bulk(&caller, &action, group).await?;
        }
        let anchor = &ids[0];
        let anchor_account = located
            .iter()
            .find(|(id, _)| id == anchor)
            .map(|(_, a)| a.clone())
            .unwrap_or_default();
        caller.publish(
            &state,
            if action == "delete" {
                EMAIL_DELETED
            } else {
                EMAIL_UPDATED
            },
            anchor,
            &json!({ "id": anchor, "accountId": anchor_account, "subject": null, "from": null, "to": null }),
        );
        if matches!(action.as_str(), "markRead" | "trash" | "delete") {
            for (account, group) in groups {
                queue_mail_read_push(&state, &caller, &account, group);
            }
        }
        Ok(Data(json!({ "affected": ids.len() })).into_response())
    }
    .await;
    answer(result, "Failed to apply bulk action")
}

/// `DELETE /:id`: a soft delete.
pub(super) async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let account = locate(&caller, &id, "Message").await?;
        let before = live_messages_by_ids(&caller.db, &account, std::slice::from_ref(&id), false)
            .await?
            .into_iter()
            .next();
        if !soft_delete_message(&caller.db, &id, OffsetDateTime::now_utc()).await? {
            return Err(MailError::not_found("Message", Some(&id)));
        }
        let subject = before
            .as_ref()
            .map_or(Value::Null, |row| row["subject"].clone());
        let event = email_event_data(
            &caller,
            &account,
            json!({ "id": id, "accountId": account, "subject": subject, "from": null, "to": null }),
        )
        .await;
        caller.publish(&state, EMAIL_DELETED, &id, &event);
        queue_mail_read_push(&state, &caller, &account, vec![id.clone()]);
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete message")
}

/// `POST /:id/labels/add` and `/:id/labels/remove`.
async fn change_labels(
    state: &MailState,
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
    add: bool,
) -> Response {
    let labels = validate(headers, body, |issues, body| {
        issues
            .list(
                body,
                "labels",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default()
    });
    let labels = match labels {
        Ok(labels) => labels,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = locate(caller, id, "Message").await?;
        let next =
            change_message_labels(&caller.db, id, &labels, add, OffsetDateTime::now_utc()).await?;
        let Some(next) = next else {
            return Err(MailError::not_found("Message", Some(id)));
        };
        caller.publish(
            state,
            EMAIL_UPDATED,
            id,
            &json!({ "id": id, "accountId": account, "subject": null, "from": null, "to": null }),
        );
        Ok(Data(json!({ "id": id, "labels": next })).into_response())
    }
    .await;
    answer(
        result,
        if add {
            "Failed to add labels"
        } else {
            "Failed to remove labels"
        },
    )
}

pub(super) async fn add_labels(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    change_labels(&state, &caller, &id, &headers, &body, true).await
}

pub(super) async fn remove_labels(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    change_labels(&state, &caller, &id, &headers, &body, false).await
}
