//! `/api/mail-sync` (`routes/mail-sync/index.ts`, `services/mail/sync.ts`):
//! the sync state of IMAP-pull mailboxes. Inbound mail is pushed on
//! WeldMail's own domains, so "sync" only marks the mailbox syncing.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveEnum, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::permission_keys::{ACCOUNTS_READ, ACCOUNTS_UPDATE};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::Data;
use weldsuite_kit::validation::Presence;
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::MailSyncStatus;
use weldsuite_schema::tenant::mail_accounts;

use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{
    MailError, MailResult, answer, bump_mailbox_directory, unhandled, validate, validate_query,
};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([ACCOUNTS_UPDATE]);
    Router::new()
        .route(
            "/mail-sync/accounts/{account_id}/sync-messages",
            post(sync_messages).route_layer(update()),
        )
        .route(
            "/mail-sync/accounts/{account_id}/full-sync",
            post(full_sync).route_layer(update()),
        )
        .route(
            "/mail-sync/accounts/{account_id}/force-resync",
            post(force_resync).route_layer(update()),
        )
        .route(
            "/mail-sync/accounts/{account_id}/sync-status",
            get(sync_status).route_layer(gate.require([ACCOUNTS_READ])),
        )
        .route(
            "/mail-sync/accounts/{account_id}/sync-status",
            patch(set_sync_status).route_layer(update()),
        )
        .with_state(state)
}

/// The access check every route makes before its try/catch.
async fn allowed(caller: &Caller, account: &str) -> Result<(), Response> {
    match check_account_access(&caller.db, account, &caller.user_id).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(MailError::forbidden(NO_ACCESS).respond("")),
        Err(error) => Err(unhandled(error.into())),
    }
}

async fn live_account(caller: &Caller, account: &str) -> Result<bool, DbErr> {
    let found: Option<String> = mail_accounts::Entity::find_by_id(account)
        .select_only()
        .column(mail_accounts::Column::Id)
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(found.is_some())
}

/// `sync_status = <status>`: the value as the `mail_sync_status` enum.
fn sync_status_value(status: MailSyncStatus) -> Expr {
    mail_accounts::Column::SyncStatus.save_as(Expr::val(status))
}

/// `beginSync(db, accountId)`.
async fn begin_sync(state: &MailState, caller: &Caller, account: &str) -> MailResult<Value> {
    if !live_account(caller, account).await? {
        return Err(MailError::not_found("Mail account", None));
    }
    mail_accounts::Entity::update_many()
        .col_expr(
            mail_accounts::Column::SyncStatus,
            sync_status_value(MailSyncStatus::Syncing),
        )
        .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(mail_accounts::Column::Id.eq(account))
        .exec(&orm(&caller.db))
        .await?;
    bump_mailbox_directory(caller, state).await;
    Ok(json!({ "accountId": account, "status": "syncing", "syncedMessages": 0 }))
}

/// `POST /accounts/:accountId/sync-messages?label=`.
async fn sync_messages(
    State(state): State<MailState>,
    caller: Caller,
    Path(account): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let label = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "label", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(label) => label,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = allowed(&caller, &account).await {
        return response;
    }
    let result = async {
        let mut body = begin_sync(&state, &caller, &account).await?;
        body["label"] = Value::String(label.unwrap_or_else(|| "inbox".to_owned()));
        Ok(Data(body).into_response())
    }
    .await;
    answer(result, "Failed to sync messages")
}

/// `POST /accounts/:accountId/full-sync`.
async fn full_sync(
    State(state): State<MailState>,
    caller: Caller,
    Path(account): Path<String>,
) -> Response {
    if let Err(response) = allowed(&caller, &account).await {
        return response;
    }
    let result =
        async { Ok(Data(begin_sync(&state, &caller, &account).await?).into_response()) }.await;
    answer(result, "Failed to perform full sync")
}

/// `POST /accounts/:accountId/force-resync`.
async fn force_resync(
    State(state): State<MailState>,
    caller: Caller,
    Path(account): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let label = match validate(&headers, &body, |issues, body| {
        issues
            .text(body, "label", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(label) => label,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = allowed(&caller, &account).await {
        return response;
    }
    let result = async {
        let mut body = begin_sync(&state, &caller, &account).await?;
        body["label"] = Value::String(label.unwrap_or_else(|| "inbox".to_owned()));
        Ok(Data(body).into_response())
    }
    .await;
    answer(result, "Failed to force resync")
}

/// `GET /accounts/:accountId/sync-status` (`getSyncStatus`).
async fn sync_status(caller: Caller, Path(account): Path<String>) -> Response {
    if let Err(response) = allowed(&caller, &account).await {
        return response;
    }
    let result = async {
        let row: Option<(Option<MailSyncStatus>, Option<PrimitiveDateTime>)> =
            mail_accounts::Entity::find_by_id(&account)
                .select_only()
                .columns([
                    mail_accounts::Column::SyncStatus,
                    mail_accounts::Column::LastSyncAt,
                ])
                .filter(mail_accounts::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
        let Some((status, last)) = row else {
            return Err(MailError::not_found("Mail account", Some(&account)));
        };
        // `lastSyncAt` as `toISOString()` (UTC, milliseconds, `Z`).
        let last = last.map_or(Value::Null, |at| {
            weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer)
                .unwrap_or(Value::Null)
        });
        Ok(Data(json!({
            "status": status.map_or_else(|| "idle".to_owned(), |status| status.to_value()),
            "lastSyncAt": last,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to fetch sync status")
}

/// `PATCH /accounts/:accountId/sync-status` (`setSyncStatus`).
async fn set_sync_status(
    State(state): State<MailState>,
    caller: Caller,
    Path(account): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let status = issues.choice(
            body,
            "status",
            Presence::Required,
            &["idle", "syncing", "error"],
        );
        let message = issues.text(body, "errorMessage", Presence::Optional, None, None);
        (
            status.into_option().unwrap_or_default(),
            message.into_option(),
        )
    });
    let (status, message) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = allowed(&caller, &account).await {
        return response;
    }
    let result = async {
        if !live_account(&caller, &account).await? {
            return Err(MailError::not_found("Mail account", None));
        }
        if let Some(message) = message.filter(|m| !m.is_empty()) {
            tracing::warn!(
                "[mail-sync] error on {} (no errorMessage column yet): {}",
                weldsuite_kit::log_safe(&account),
                weldsuite_kit::log_safe(&message)
            );
        }
        let value = MailSyncStatus::try_from_value(&status)?;
        let at = utc_now();
        let mut update = mail_accounts::Entity::update_many()
            .col_expr(mail_accounts::Column::SyncStatus, sync_status_value(value))
            .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(at));
        if value == MailSyncStatus::Idle {
            update = update.col_expr(mail_accounts::Column::LastSyncAt, Expr::value(at));
        }
        update
            .filter(mail_accounts::Column::Id.eq(&account))
            .exec(&orm(&caller.db))
            .await?;
        bump_mailbox_directory(&caller, &state).await;
        Ok(Data(json!({ "id": account, "status": status })).into_response())
    }
    .await;
    answer(result, "Failed to update sync status")
}
