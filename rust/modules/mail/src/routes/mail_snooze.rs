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
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::permission_keys::{MESSAGES_READ, MESSAGES_UPDATE};
use weldsuite_db::{orm, utc_timestamp};
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::labels::{add_labels, labels_of, labels_value, remove_labels};
use weldsuite_mail_domain::outbound::clock::{self, parse_iso};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{mail_accounts, mail_messages};

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
async fn list_snoozed(caller: &Caller, account_ids: &[String]) -> Result<Vec<Value>, DbErr> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = mail_messages::Entity::find()
        .filter(mail_messages::Column::AccountId.is_in(account_ids.iter().map(String::as_str)))
        .filter(mail_messages::Column::DeletedAt.is_null())
        // `labels @> '["SNOOZED"]'`.
        .filter(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col(mail_messages::Column::Labels),
            Expr::value(json!(["SNOOZED"])),
        ))
        .all(&orm(&caller.db))
        .await?;
    let rows = rows
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| DbErr::Json(error.to_string()))?;
    Ok(rows
        .into_iter()
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
                let live: Option<String> = mail_accounts::Entity::find_by_id(account)
                    .select_only()
                    .column(mail_accounts::Column::Id)
                    .filter(mail_accounts::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(&orm(&caller.db))
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

/// The message's labels, `snoozed_until` and custom fields.
type SnoozeFields = (Option<Value>, Option<PrimitiveDateTime>, Option<Value>);

/// The message in this mailbox (`findMessage`): its labels and snooze
/// fields, or `None`.
async fn find_message(
    caller: &Caller,
    account: &str,
    id: &str,
) -> Result<Option<SnoozeFields>, DbErr> {
    mail_messages::Entity::find_by_id(id)
        .select_only()
        .columns([
            mail_messages::Column::Labels,
            mail_messages::Column::SnoozedUntil,
            mail_messages::Column::CustomFields,
        ])
        .filter(mail_messages::Column::AccountId.eq(account))
        .filter(mail_messages::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
    let until_at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(until) * 1_000_000).ok();
    let snoozed_until = utc_timestamp(until_at.unwrap_or(OffsetDateTime::UNIX_EPOCH));
    let stamp = utc_timestamp(now);
    let update = mail_messages::Entity::update_many();
    let update = if resnooze {
        update
            .col_expr(
                mail_messages::Column::SnoozedUntil,
                Expr::value(snoozed_until),
            )
            .col_expr(mail_messages::Column::ResnoozedAt, Expr::value(stamp))
            .col_expr(mail_messages::Column::UpdatedAt, Expr::value(stamp))
    } else {
        let labels = labels_of(labels.as_ref());
        let next = add_labels(
            &remove_labels(&labels, &["INBOX".to_owned()]),
            &["SNOOZED".to_owned()],
        );
        update
            .col_expr(mail_messages::Column::Labels, Expr::value(labels_value(&next)))
            .col_expr(mail_messages::Column::IsRead, Expr::value(true))
            .col_expr(
                mail_messages::Column::SnoozedUntil,
                Expr::value(snoozed_until),
            )
            .col_expr(mail_messages::Column::SnoozedAt, Expr::value(stamp))
            .col_expr(mail_messages::Column::UpdatedAt, Expr::value(stamp))
    };
    update
        .filter(mail_messages::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    if let Some(master) = caller.bindings.master(state)
        && let Some(at) = until_at
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
        let stamp = weldsuite_db::utc_now();
        mail_messages::Entity::update_many()
            .col_expr(mail_messages::Column::Labels, Expr::value(labels_value(&next)))
            .col_expr(mail_messages::Column::IsRead, Expr::value(false))
            .col_expr(
                mail_messages::Column::SnoozedUntil,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .col_expr(
                mail_messages::Column::UnsnoozeTriggerRunId,
                Expr::value(Option::<String>::None),
            )
            .col_expr(mail_messages::Column::UnsnoozedAt, Expr::value(stamp))
            .col_expr(mail_messages::Column::UnsnoozedEarly, Expr::value(true))
            .col_expr(mail_messages::Column::UpdatedAt, Expr::value(stamp))
            .filter(mail_messages::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to unsnooze message")
}
