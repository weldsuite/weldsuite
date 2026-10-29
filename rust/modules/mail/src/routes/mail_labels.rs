//! `/api/mail-labels` (`routes/mail-labels/index.ts`): label CRUD on
//! `mail_labels`, bulk apply / unapply on messages, thread-scoped apply,
//! and the folder and search lists of threads (`GET /threads`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EMAIL_UPDATED, MAIL_LABEL_CREATED, MAIL_LABEL_DELETED, MAIL_LABEL_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE, MESSAGES_READ,
    MESSAGES_UPDATE,
};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::labels::{
    self, CreateMailLabel, MailLabelError, UpdateMailLabel, apply_label_to_thread,
};
use weldsuite_mail_domain::messages::{existing_ids, locate_messages};
use weldsuite_mail_domain::threads::{
    ThreadQuery, decode_thread_cursor, encode_thread_cursor, list_threads,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{MailError, MailResult, answer, bump_mailbox_directory, unhandled, validate, validate_query};
use crate::{Caller, MailState};

pub(crate) const NO_ACCESS: &str = "Access to this mail account is not allowed";
pub(crate) const NO_ACCESS_SOME: &str = "Access to one or more mail accounts is not allowed";

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let update_messages = || gate.require([MESSAGES_UPDATE]);
    Router::new()
        .route(
            "/mail-labels/threads",
            get(threads).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-labels/add-to-messages",
            post(add_to_messages).route_layer(update_messages()),
        )
        .route(
            "/mail-labels/remove-from-messages",
            post(remove_from_messages).route_layer(update_messages()),
        )
        .route(
            "/mail-labels/apply-to-thread",
            post(apply_to_thread).route_layer(update_messages()),
        )
        .route(
            "/mail-labels",
            get(list).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-labels",
            post(create).route_layer(gate.require([ACCOUNTS_CREATE])),
        )
        .route(
            "/mail-labels/{id}",
            get(detail).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-labels/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([ACCOUNTS_UPDATE])),
        )
        .route(
            "/mail-labels/{id}",
            axum::routing::delete(remove).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .with_state(state)
}

/// `mapLabelError`.
fn label_error(error: MailLabelError) -> MailError {
    match error {
        MailLabelError::DuplicateName(message) => MailError::conflict(message),
        MailLabelError::NotFound => MailError::not_found("Label", None),
        MailLabelError::SystemLabelImmutable(message) => MailError::forbidden(message),
        MailLabelError::Db(error) => MailError::Database(error),
    }
}

// ---------------------------------------------------------------------------
// Threads by label
// ---------------------------------------------------------------------------

/// `GET /threads`: one mailbox's (an inaccessible one answers an empty page)
/// or every accessible mailbox's threads in a folder or search.
async fn threads(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let account = issues.text(q, "accountId", Presence::Optional, None, None);
        let slug = issues.text(q, "labelSlug", Presence::Required, Some(1), None);
        let int = |issues: &mut Issues, key: &str, max: Option<f64>| {
            issues
                .whole_number(
                    q,
                    key,
                    Presence::Optional,
                    Number {
                        coerce: true,
                        int: true,
                        min: Some(1.0),
                        max,
                    },
                )
                .into_option()
        };
        let page = int(issues, "page", None);
        let page_size = int(issues, "pageSize", Some(100.0));
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        let text = |issues: &mut Issues, key: &str| {
            issues
                .text(q, key, Presence::Optional, None, Some(200))
                .into_option()
        };
        let search = text(issues, "search");
        let from = text(issues, "from");
        let to = text(issues, "to");
        let subject = text(issues, "subject");
        let exclude = text(issues, "excludeWords");
        let has_attachment = issues
            .text(q, "hasAttachment", Presence::Optional, None, None)
            .into_option()
            .map(|v| v == "true");
        (
            account.into_option(),
            ThreadQuery {
                label_slug: slug.into_option().unwrap_or_default(),
                search,
                from,
                to,
                subject,
                has_attachment,
                exclude_words: exclude,
                page_size: Some(page_size.unwrap_or(25)),
                offset: Some((page.unwrap_or(1) - 1) * page_size.unwrap_or(25)),
                ..ThreadQuery::default()
            },
            cursor.into_option(),
        )
    });
    let (account, mut query, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account_ids = match account.as_deref().filter(|a| !a.is_empty()) {
            Some(account) => {
                if check_account_access(&caller.db, account, &caller.user_id).await? {
                    vec![account.to_owned()]
                } else {
                    Vec::new()
                }
            }
            None => accessible_account_ids(&caller.db, &caller.user_id).await?,
        };
        if account_ids.is_empty() {
            return Ok(Data(json!({ "threads": [], "totalCount": 0, "nextCursor": null }))
                .into_response());
        }
        query.cursor = decode_thread_cursor(cursor.as_deref());
        if query.cursor.is_some() {
            query.offset = None;
        }
        if account_ids.len() == 1 {
            query.account_id = Some(account_ids[0].clone());
        }
        let page = list_threads(&caller.db, &account_ids, &query, OffsetDateTime::now_utc()).await?;
        Ok(Data(json!({
            "threads": page.threads,
            "totalCount": page.total_count,
            "nextCursor": page.next_cursor.as_ref().map(encode_thread_cursor),
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to fetch threads for label")
}

// ---------------------------------------------------------------------------
// Bulk apply / unapply
// ---------------------------------------------------------------------------

/// `canAccessMessageAccounts(db, access, ids)`: every mailbox the ids sit in
/// (deleted messages included) is open to the caller.
pub(crate) async fn can_access_message_accounts(
    caller: &Caller,
    ids: &[String],
) -> Result<bool, sqlx::Error> {
    if ids.is_empty() {
        return Ok(true);
    }
    let rows: Vec<String> =
        sqlx::query_scalar("select account_id from mail_messages where id = any($1::text[])")
            .bind(ids)
            .fetch_all(&caller.db)
            .await?;
    let mut seen: Vec<String> = Vec::new();
    for account in rows {
        if seen.contains(&account) {
            continue;
        }
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Ok(false);
        }
        seen.push(account);
    }
    Ok(true)
}

/// `messageId → accountId` regrouped as `accountId → messageIds`, in order.
pub(crate) fn group_by_account(pairs: &[(String, String)]) -> Vec<(String, Vec<String>)> {
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (id, account) in pairs {
        match groups.iter_mut().find(|(a, _)| a == account) {
            Some((_, ids)) => ids.push(id.clone()),
            None => groups.push((account.clone(), vec![id.clone()])),
        }
    }
    groups
}

/// `applyToMessagesBody`.
fn read_apply(headers: &HeaderMap, body: &Bytes) -> MailResult<(String, Vec<String>)> {
    validate(headers, body, |issues, body| {
        let label = issues.text(body, "labelName", Presence::Required, Some(1), None);
        let ids = issues.list(
            body,
            "messageIds",
            Presence::Required,
            Some(1),
            Some(500),
            |issues, item| issues.item_text(item, Text::default()),
        );
        (
            label.into_option().unwrap_or_default(),
            ids.into_option().unwrap_or_default(),
        )
    })
}

/// `POST /add-to-messages` and `/remove-from-messages`.
async fn bulk_label(
    state: &MailState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
    add: bool,
) -> Response {
    let (label, ids) = match read_apply(headers, body) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if !can_access_message_accounts(caller, &ids).await? {
            return Err(MailError::forbidden(NO_ACCESS_SOME));
        }
        let accessible = accessible_account_ids(&caller.db, &caller.user_id).await?;
        let located = locate_messages(&caller.db, &ids, &accessible, false).await?;
        let now = OffsetDateTime::now_utc();
        let mut affected = 0;
        for (_, group) in group_by_account(&located) {
            let live = existing_ids(&caller.db, &group).await?;
            if !live.is_empty() {
                if add {
                    labels::bulk_add_label(&caller.db, &label, &live, now).await?;
                } else {
                    labels::bulk_remove_label(&caller.db, &label, &live, now).await?;
                }
            }
            affected += live.len();
        }
        let anchor = &ids[0];
        let anchor_account = located
            .iter()
            .find(|(id, _)| id == anchor)
            .map(|(_, a)| a.clone())
            .unwrap_or_default();
        caller.publish(
            state,
            EMAIL_UPDATED,
            anchor,
            &json!({ "id": anchor, "accountId": anchor_account, "subject": null, "from": null, "to": null }),
        );
        Ok(Data(json!({ "count": affected })).into_response())
    }
    .await;
    answer(
        result,
        if add {
            "Failed to apply label"
        } else {
            "Failed to remove label"
        },
    )
}

async fn add_to_messages(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    bulk_label(&state, &caller, &headers, &body, true).await
}

async fn remove_from_messages(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    bulk_label(&state, &caller, &headers, &body, false).await
}

/// `POST /apply-to-thread`.
async fn apply_to_thread(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let account = issues.text(body, "accountId", Presence::Required, Some(1), None);
        let thread = issues.text(body, "threadId", Presence::Required, Some(1), None);
        let label = issues.text(body, "labelName", Presence::Required, Some(1), None);
        let action = issues.choice(body, "action", Presence::Required, &["add", "remove"]);
        (
            account.into_option().unwrap_or_default(),
            thread.into_option().unwrap_or_default(),
            label.into_option().unwrap_or_default(),
            action.into_option().unwrap_or_default(),
        )
    });
    let (account, thread, label, action) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let ids = apply_label_to_thread(
            &caller.db,
            &account,
            &thread,
            &label,
            action == "add",
            OffsetDateTime::now_utc(),
        )
        .await?;
        caller.publish(
            &state,
            EMAIL_UPDATED,
            &thread,
            &json!({ "id": thread, "accountId": account, "subject": null, "from": null, "to": null }),
        );
        Ok(Data(json!({ "affected": ids.len(), "action": action })).into_response())
    }
    .await;
    answer(result, "Failed to update thread labels")
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// `GET /` (`listMailLabels`): one mailbox's labels, or every accessible
/// mailbox's.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "accountId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(account) => account.filter(|a| !a.is_empty()),
        Err(error) => return error.respond(""),
    };
    let result = async {
        if let Some(account) = &account {
            if !check_account_access(&caller.db, account, &caller.user_id).await? {
                return Err(MailError::forbidden(NO_ACCESS));
            }
            let rows = labels::list_mail_labels(&caller.db, Some(account), None).await?;
            return Ok(Data(rows).into_response());
        }
        let scoped = accessible_account_ids(&caller.db, &caller.user_id).await?;
        if scoped.is_empty() {
            return Ok(Data(json!([])).into_response());
        }
        let rows = labels::list_mail_labels(&caller.db, None, Some(&scoped)).await?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to list labels")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = labels::get_mail_label(&caller.db, &id).await? else {
            return Err(MailError::not_found("Label", Some(&id)));
        };
        let account = row["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch label")
}

/// The AI fields shared by `createBody` and `updateBody`.
struct AiFields {
    enabled: Option<bool>,
    keywords: Option<Vec<String>>,
    description: Option<String>,
    confidence: Option<i64>,
}

fn read_ai(issues: &mut Issues, body: &serde_json::Map<String, Value>) -> AiFields {
    let enabled = issues.boolean(body, "aiEnabled", Presence::Optional);
    let keywords = issues.list(
        body,
        "aiKeywords",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    );
    let description = issues.text(body, "aiDescription", Presence::Optional, None, None);
    let confidence = issues.whole_number(
        body,
        "aiConfidence",
        Presence::Optional,
        Number {
            int: true,
            min: Some(0.0),
            max: Some(100.0),
            ..Number::default()
        },
    );
    AiFields {
        enabled: enabled.into_option(),
        keywords: keywords.into_option(),
        description: description.into_option(),
        confidence: confidence.into_option(),
    }
}

/// `POST /` (`createMailLabel`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = validate(&headers, &body, |issues, body| {
        let account = issues.text(body, "accountId", Presence::Required, Some(1), None);
        let name = issues.text(body, "name", Presence::Required, Some(1), Some(100));
        let color = issues.text(body, "color", Presence::Optional, None, Some(20));
        let ai = read_ai(issues, body);
        CreateMailLabel {
            account_id: account.into_option().unwrap_or_default(),
            name: name.into_option().unwrap_or_default(),
            color: color.into_option(),
            ai_enabled: ai.enabled,
            ai_keywords: ai.keywords,
            ai_description: ai.description,
            ai_confidence: ai.confidence,
        }
    });
    let data = match data {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if !check_account_access(&caller.db, &data.account_id, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let row = labels::create_mail_label(&caller.db, &data, OffsetDateTime::now_utc())
            .await
            .map_err(label_error)?;
        bump_mailbox_directory(&caller, &state).await;
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        caller.publish(
            &state,
            MAIL_LABEL_CREATED,
            &id,
            &json!({ "id": id, "accountId": row["accountId"], "name": row["name"] }),
        );
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create label")
}

/// `PUT|PATCH /:id` (`applyUpdate`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = validate(&headers, &body, |issues, body| {
        let name = issues.text(body, "name", Presence::Optional, Some(1), Some(100));
        let color = issues.text(body, "color", Presence::Optional, None, Some(20));
        let position = issues.whole_number(
            body,
            "position",
            Presence::Optional,
            Number {
                int: true,
                ..Number::default()
            },
        );
        let ai = read_ai(issues, body);
        UpdateMailLabel {
            name: name.into_option(),
            color: color.into_option(),
            position: position.into_option(),
            ai_enabled: ai.enabled,
            ai_keywords: ai.keywords,
            ai_description: ai.description,
            ai_confidence: ai.confidence,
        }
    });
    let data = match data {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    // Outside the route's try/catch.
    let existing = match labels::get_mail_label(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return MailError::not_found("Label", Some(&id)).respond(""),
        Err(error) => return unhandled(error.into()),
    };
    let account = existing["accountId"].as_str().unwrap_or_default().to_owned();
    match check_account_access(&caller.db, &account, &caller.user_id).await {
        Ok(true) => {}
        Ok(false) => return MailError::forbidden(NO_ACCESS).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let (_, after) = labels::update_mail_label(&caller.db, &id, &data, OffsetDateTime::now_utc())
            .await
            .map_err(label_error)?;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_LABEL_UPDATED,
            &id,
            &json!({ "id": id, "accountId": after["accountId"], "name": after["name"] }),
        );
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update label")
}

/// `DELETE /:id` (`deleteMailLabel`).
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = labels::get_mail_label(&caller.db, &id).await? else {
            return Err(MailError::not_found("Label", Some(&id)));
        };
        let account = existing["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let row = labels::delete_mail_label(&caller.db, &id, OffsetDateTime::now_utc())
            .await
            .map_err(label_error)?;
        let Some(row) = row else {
            return Err(MailError::not_found("Label", Some(&id)));
        };
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_LABEL_DELETED,
            &id,
            &json!({ "id": id, "accountId": row["accountId"], "name": row["name"] }),
        );
        Ok(Data(json!({ "id": id, "deleted": true })).into_response())
    }
    .await;
    answer(result, "Failed to delete label")
}
