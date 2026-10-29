//! `/api/mail-snooze` (`routes/mail-snooze/index.ts`, `@weldsuite/mail-domain/snooze`):
//! snooze, wake early and re-snooze a message, and the snoozed list. A
//! snooze points the workspace's due index at its wake-up time, for the
//! snooze sweep.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::{MESSAGES_READ, MESSAGES_UPDATE};
use weldsuite_db::js_row;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::labels::{add_labels, labels_of, labels_value, remove_labels};
use weldsuite_mail_domain::messages::iso;
use weldsuite_mail_domain::outbound::clock::{self, parse_iso};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, MailResult, answer, validate, validate_query};
use crate::{Caller, MailState};

/// The due-index kind of the snooze sweep.
const SNOOZE_KIND: &str = "mail_snooze";

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([MESSAGES_UPDATE]);
    Router::new()
        .route(
            "/mail-snooze/snoozed",
            get(snoozed).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-snooze/accounts/{account_id}/messages/{message_id}/snooze",
            post(snooze).route_layer(update()),
        )
        .route(
            "/mail-snooze/accounts/{account_id}/messages/{message_id}/unsnooze",
            post(unsnooze).route_layer(update()),
        )
        .route(
            "/mail-snooze/accounts/{account_id}/messages/{message_id}/resnooze",
            post(resnooze).route_layer(update()),
        )
        .with_state(state)
}

/// `listSnoozedMessages(db, { accountIds })`: the column first, the legacy
/// custom-field blob second.
async fn list_snoozed(caller: &Caller, account_ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from mail_messages m
         where m.account_id = any($1::text[]) and m.deleted_at is null
           and m.labels @> '[\"SNOOZED\"]'::jsonb",
    )
    .bind(account_ids)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .map(|m| {
            let custom = &m["customFields"];
            let pick = |column: &str, legacy: &str| {
                let value = m[column].clone();
                if value.is_null() {
                    custom
                        .get(legacy)
                        .cloned()
                        .filter(|v| !v.is_null())
                        .unwrap_or(Value::Null)
                } else {
                    value
                }
            };
            json!({
                "id": m["id"],
                "accountId": m["accountId"],
                "subject": m["subject"],
                "from": m["from"],
                "snoozedUntil": pick("snoozedUntil", "snoozedUntil"),
                "snoozedAt": pick("snoozedAt", "snoozedAt"),
                "triggerRunId": pick("unsnoozeTriggerRunId", "unsnoozeTriggerRunId"),
                "createdAt": m["createdAt"],
            })
        })
        .collect())
}

/// `GET /snoozed`.
async fn snoozed(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "accountId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(account) => account.filter(|a| !a.is_empty()),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let ids = match account {
            Some(account) => {
                if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                    return Err(MailError::forbidden(NO_ACCESS));
                }
                let live: Option<String> = sqlx::query_scalar(
                    "select id from mail_accounts where id = $1 and deleted_at is null limit 1",
                )
                .bind(&account)
                .fetch_optional(&caller.db)
                .await?;
                live.into_iter().collect()
            }
            None => accessible_account_ids(&caller.db, &caller.user_id).await?,
        };
        Ok(Data(list_snoozed(&caller, &ids).await?).into_response())
    }
    .await;
    answer(result, "Failed to list snoozed messages")
}

/// `snoozeBody`: `until` as milliseconds.
fn read_until(headers: &HeaderMap, body: &Bytes) -> MailResult<i64> {
    validate(headers, body, |issues, body| {
        issues
            .text_with(
                body,
                "until",
                Presence::Required,
                Text {
                    format: Some(Format::Datetime),
                    ..Text::default()
                },
            )
            .into_option()
            .and_then(|until| parse_iso(&until))
            .unwrap_or_default()
    })
}

/// The message in this mailbox (`findMessage`): its labels and snooze
/// fields, or `None`.
async fn find_message(
    caller: &Caller,
    account: &str,
    id: &str,
) -> Result<Option<(Option<Value>, Option<String>, Option<Value>)>, sqlx::Error> {
    sqlx::query_as(
        "select labels, snoozed_until::text, custom_fields from mail_messages
         where id = $1 and account_id = $2 and deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(&caller.db)
    .await
}

/// `snoozeMessage` / `resnoozeMessage`.
async fn apply_snooze(
    state: &MailState,
    caller: &Caller,
    account: &str,
    id: &str,
    until: i64,
    resnooze: bool,
) -> MailResult<Response> {
    if !check_account_access(&caller.db, account, &caller.user_id).await? {
        return Err(MailError::forbidden(NO_ACCESS));
    }
    let now = OffsetDateTime::now_utc();
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    if until <= now_ms {
        return Err(MailError::bad_request("Snooze time must be in the future"));
    }
    let Some((labels, _, _)) = find_message(caller, account, id).await? else {
        return Err(MailError::not_found("Message", None));
    };
    let until_iso = clock::iso(until);
    if resnooze {
        sqlx::query(
            "update mail_messages set snoozed_until = $2::timestamp, resnoozed_at = $3::timestamp,
               updated_at = $3::timestamp
             where id = $1",
        )
        .bind(id)
        .bind(&until_iso)
        .bind(iso(now))
        .execute(&caller.db)
        .await?;
    } else {
        let labels = labels_of(labels.as_ref());
        let next = add_labels(
            &remove_labels(&labels, &["INBOX".to_owned()]),
            &["SNOOZED".to_owned()],
        );
        sqlx::query(
            "update mail_messages set labels = $2, is_read = true, snoozed_until = $3::timestamp,
               snoozed_at = $4::timestamp, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(id)
        .bind(labels_value(&next))
        .bind(&until_iso)
        .bind(iso(now))
        .execute(&caller.db)
        .await?;
    }
    if let Some(master) = caller.bindings.master(state)
        && let Some(at) =
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(until) * 1_000_000).ok()
    {
        weldsuite_db::due_index::mark_due(&master, SNOOZE_KIND, &caller.workspace_id, at).await;
    }
    Ok(Data(json!({ "id": id, "snoozedUntil": until_iso })).into_response())
}

/// `POST /accounts/:accountId/messages/:messageId/snooze`.
async fn snooze(
    State(state): State<MailState>,
    caller: Caller,
    Path((account, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let until = match read_until(&headers, &body) {
        Ok(until) => until,
        Err(error) => return error.respond(""),
    };
    let result = apply_snooze(&state, &caller, &account, &id, until, false).await;
    answer(result, "Failed to snooze message")
}

/// `POST /accounts/:accountId/messages/:messageId/resnooze`.
async fn resnooze(
    State(state): State<MailState>,
    caller: Caller,
    Path((account, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let until = match read_until(&headers, &body) {
        Ok(until) => until,
        Err(error) => return error.respond(""),
    };
    let result = apply_snooze(&state, &caller, &account, &id, until, true).await;
    answer(result, "Failed to resnooze message")
}

/// `POST /accounts/:accountId/messages/:messageId/unsnooze`.
async fn unsnooze(caller: Caller, Path((account, id)): Path<(String, String)>) -> Response {
    let result = async {
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let Some((labels, snoozed_until, custom)) = find_message(&caller, &account, &id).await?
        else {
            return Err(MailError::not_found("Message", None));
        };
        let legacy = custom
            .as_ref()
            .and_then(|c| c.get("snoozedUntil"))
            .is_some_and(|v| match v {
                Value::Null => false,
                Value::String(s) => !s.is_empty(),
                _ => true,
            });
        if snoozed_until.is_none() && !legacy {
            return Err(MailError::bad_request("Message is not snoozed"));
        }
        let labels = labels_of(labels.as_ref());
        let next = add_labels(
            &remove_labels(&labels, &["SNOOZED".to_owned()]),
            &["INBOX".to_owned()],
        );
        sqlx::query(
            "update mail_messages set labels = $2, is_read = false, snoozed_until = null,
               unsnooze_trigger_run_id = null, unsnoozed_at = $3::timestamp, unsnoozed_early = true,
               updated_at = $3::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(labels_value(&next))
        .bind(iso(OffsetDateTime::now_utc()))
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to unsnooze message")
}
