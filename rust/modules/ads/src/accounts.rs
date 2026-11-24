//! `/api/ad-accounts`: the ad accounts the connections reach, and which of
//! them sync.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use weldsuite_ads_domain::sync::{AccountSelection, set_account_selection};
use weldsuite_catalogs::entity_events::AD_ACCOUNT_UPDATED;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Presence, query_values};
use weldsuite_kit::{ApiError, Data};
use weldsuite_schema::tenant::{ad_accounts, ad_platform_connections};

use crate::{AdsState, Caller, internal, json_error, query_param, validate};

/// `GET /api/ad-accounts[?connectionId=]`: the live accounts.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let connection_id = query_param(&query, "connectionId").filter(|id| !id.is_empty());
    match live_accounts(&caller, connection_id).await {
        Ok(found) => Data(found).into_response(),
        Err(error) => internal(&error, "Failed to list ad accounts"),
    }
}

/// The live accounts, of one connection when it is given.
async fn live_accounts(
    caller: &Caller,
    connection_id: Option<String>,
) -> Result<Vec<Value>, DbErr> {
    let mut find = ad_accounts::Entity::find().filter(ad_accounts::Column::DeletedAt.is_null());
    if let Some(connection_id) = connection_id {
        find = find.filter(ad_accounts::Column::ConnectionId.eq(connection_id));
    }
    find.all(&orm(&caller.db))
        .await?
        .into_iter()
        .map(|account| serde_json::to_value(account).map_err(json_error))
        .collect()
}

/// The account `id`; `live_only` skips a deleted one.
async fn account_row(caller: &Caller, id: &str, live_only: bool) -> Result<Option<Value>, DbErr> {
    let mut find = ad_accounts::Entity::find().filter(ad_accounts::Column::Id.eq(id));
    if live_only {
        find = find.filter(ad_accounts::Column::DeletedAt.is_null());
    }
    find.one(&orm(&caller.db))
        .await?
        .map(|account| serde_json::to_value(account).map_err(json_error))
        .transpose()
}

/// Whether the connection `id` is live.
async fn live_connection(caller: &Caller, id: &str) -> Result<bool, DbErr> {
    let found = ad_platform_connections::Entity::find()
        .filter(ad_platform_connections::Column::Id.eq(id))
        .filter(ad_platform_connections::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    Ok(found.is_some())
}

/// `PATCH /api/ad-accounts/:id { isSelected }`: (un)select the account for
/// sync; the connection's sync index entry follows.
pub(crate) async fn update(
    State(state): State<AdsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let is_selected = match validate(&headers, &body, |issues, fields| {
        issues.boolean(fields, "isSelected", Presence::Required)
    }) {
        Ok(field) => field.into_option().unwrap_or_default(),
        Err(response) => return *response,
    };
    let account = match account_row(&caller, &id, true).await {
        Ok(Some(account)) => account,
        Ok(None) => return ApiError::not_found("Ad account", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let connection_id = account["connectionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    match live_connection(&caller, &connection_id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::not_found("Ad connection", Some(&connection_id)).into_response();
        }
        Err(error) => return internal(&error, "Internal server error"),
    }
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    let master = caller.master(&state);
    let selected = set_account_selection(
        &caller.db,
        master.as_ref(),
        AccountSelection {
            account_id: &id,
            is_selected,
            workspace_id: &caller.workspace_id,
            clerk_org_id: &org_id,
            connection_id: &connection_id,
        },
    )
    .await;
    if let Err(error) = selected {
        return internal(&error, "Failed to update ad account");
    }
    match account_row(&caller, &id, false).await {
        Ok(updated) => {
            let updated = updated.unwrap_or(Value::Null);
            caller.publish(&state, AD_ACCOUNT_UPDATED, &id, &updated);
            Data(updated).into_response()
        }
        Err(error) => internal(&error, "Failed to update ad account"),
    }
}
