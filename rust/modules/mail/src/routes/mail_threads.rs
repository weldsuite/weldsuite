//! `/api/mail-threads` (`routes/mail-threads/index.ts`): mark a folder read
//! (one mailbox or every accessible one) and mark one thread read or unread.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::json;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::EMAIL_UPDATED;
use weldsuite_catalogs::permission_keys::MESSAGES_UPDATE;
use weldsuite_kit::Data;
use weldsuite_kit::validation::Presence;
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::threads::{mark_folder_read, mark_thread_read};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::read_push::queue_mail_read_push;
use crate::routes::mail_labels::{NO_ACCESS, group_by_account};
use crate::util::{MailError, answer, query_map, validate};
use crate::{Caller, MailState};

/// `READ_ALL_PUSH_IDS`.
const READ_ALL_PUSH_IDS: usize = 200;

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-threads/read-all",
            post(read_all).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-threads/{thread_id}/read",
            post(read_thread).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .with_state(state)
}

/// `POST /read-all`.
async fn read_all(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let slug = issues.text(body, "labelSlug", Presence::Required, Some(1), Some(100));
        let account = issues.text(body, "accountId", Presence::Optional, Some(1), None);
        (
            slug.into_option().unwrap_or_default(),
            account.into_option(),
        )
    });
    let (slug, account) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account_ids = match account {
            Some(account) => {
                if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                    return Err(MailError::forbidden(NO_ACCESS));
                }
                vec![account]
            }
            None => accessible_account_ids(&caller.db, &caller.user_id).await?,
        };
        let done = mark_folder_read(
            &caller.db,
            &account_ids,
            &slug,
            READ_ALL_PUSH_IDS,
            OffsetDateTime::now_utc(),
        )
        .await?;
        if let Some((id, account)) = done.updated.first() {
            caller.publish(
                &state,
                EMAIL_UPDATED,
                id,
                &json!({ "id": id, "accountId": account, "subject": null, "from": null, "to": null }),
            );
        }
        for (account, mut ids) in group_by_account(&done.updated) {
            ids.truncate(READ_ALL_PUSH_IDS);
            queue_mail_read_push(&state, &caller, &account, ids);
        }
        Ok(Data(json!({ "updatedCount": done.updated_count })).into_response())
    }
    .await;
    answer(result, "Failed to mark the folder as read")
}

/// `POST /:threadId/read?accountId=`.
async fn read_thread(
    State(state): State<MailState>,
    caller: Caller,
    Path(thread_id): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let is_read = match validate(&headers, &body, |issues, body| {
        issues
            .boolean(body, "isRead", Presence::Required)
            .into_option()
            .unwrap_or(false)
    }) {
        Ok(is_read) => is_read,
        Err(error) => return error.respond(""),
    };
    let Some(account) = query_map(raw.as_deref())
        .remove("accountId")
        .filter(|a| !a.is_empty())
    else {
        return MailError::bad_request("accountId query parameter is required").respond("");
    };
    let result = async {
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let ids = mark_thread_read(
            &caller.db,
            &account,
            &thread_id,
            is_read,
            OffsetDateTime::now_utc(),
        )
        .await?;
        if !ids.is_empty() {
            caller.publish(
                &state,
                EMAIL_UPDATED,
                &thread_id,
                &json!({ "id": thread_id, "accountId": account, "subject": null, "from": null, "to": null }),
            );
        }
        let count = ids.len();
        if is_read {
            queue_mail_read_push(&state, &caller, &account, ids);
        }
        Ok(Data(json!({ "updatedCount": count })).into_response())
    }
    .await;
    answer(result, "Failed to update thread read state")
}
