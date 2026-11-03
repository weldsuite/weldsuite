//! `/api/ad-accounts`: the ad accounts the connections reach, and which of
//! them sync.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::Value;
use weldsuite_ads_domain::sync::{AccountSelection, set_account_selection};
use weldsuite_catalogs::entity_events::AD_ACCOUNT_UPDATED;
use weldsuite_kit::validation::{Presence, query_values};
use weldsuite_kit::{ApiError, Data};

use crate::{AdsState, Caller, internal, query_param, rows, validate};

/// `GET /api/ad-accounts[?connectionId=]`: the live accounts.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let connection_id = query_param(&query, "connectionId").filter(|id| !id.is_empty());
    let result: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(a) from ad_accounts a
         where a.deleted_at is null and ($1::text is null or a.connection_id = $1)",
    )
    .bind(connection_id.as_deref())
    .fetch_all(&caller.db)
    .await;
    match result {
        Ok(found) => Data(rows(found)).into_response(),
        Err(error) => internal(&error, "Failed to list ad accounts"),
    }
}

async fn live_row(caller: &Caller, table: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = match table {
        "ad_accounts" => {
            sqlx::query_scalar(
                "select to_jsonb(a) from ad_accounts a where a.id = $1 and a.deleted_at is null limit 1",
            )
            .bind(id)
            .fetch_optional(&caller.db)
            .await?
        }
        _ => {
            sqlx::query_scalar(
                "select to_jsonb(c) from ad_platform_connections c
                 where c.id = $1 and c.deleted_at is null limit 1",
            )
            .bind(id)
            .fetch_optional(&caller.db)
            .await?
        }
    };
    Ok(row.map(weldsuite_db::js_row))
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
    let account = match live_row(&caller, "ad_accounts", &id).await {
        Ok(Some(account)) => account,
        Ok(None) => return ApiError::not_found("Ad account", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Internal server error"),
    };
    let connection_id = account["connectionId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    match live_row(&caller, "ad_platform_connections", &connection_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return ApiError::not_found("Ad connection", Some(&connection_id)).into_response();
        }
        Err(error) => return internal(&error, "Internal server error"),
    }
    let Some(org_id) = caller.org_id.clone() else {
        return ApiError::bad_request("No active workspace").into_response();
    };
    let master = caller.master(&state);
    let result = async {
        set_account_selection(
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
        .await?;
        let updated: Option<Value> =
            sqlx::query_scalar("select to_jsonb(a) from ad_accounts a where a.id = $1 limit 1")
                .bind(&id)
                .fetch_optional(&caller.db)
                .await?;
        Ok::<_, weldsuite_ads_domain::AdsError>(updated.map(weldsuite_db::js_row))
    }
    .await;
    match result {
        Ok(updated) => {
            let updated = updated.unwrap_or(Value::Null);
            caller.publish(&state, AD_ACCOUNT_UPDATED, &id, &updated);
            Data(updated).into_response()
        }
        Err(error) => internal(&error, "Failed to update ad account"),
    }
}
