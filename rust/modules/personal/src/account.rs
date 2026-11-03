//! `POST /api/onboard` (`routes/onboard.ts`), `GET /api/me`
//! (`routes/me.ts`) and `/api/push-tokens` (`routes/push-tokens.ts`,
//! `services/push-tokens.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence};

use crate::PersonalState;
use crate::caller::{Caller, Failure, answer, created, data, pick, rows, validate, validate_query};
use crate::js::now_iso;

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/onboard", post(onboard))
        .route("/api/me", get(me))
        .route("/api/push-tokens", post(register).delete(unregister))
}

/// `c.req.json().catch(() => ({}))`: the body as JSON whatever its type,
/// `{}` when it doesn't parse; then `body ?? {}`.
fn loose_json(body: &Bytes) -> Value {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Null) | Err(_) => json!({}),
        Ok(value) => value,
    }
}

async fn find_account(
    master: &weldsuite_db::PgPool,
    user_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, clerk_user_id, display_name from personal_accounts
         where clerk_user_id = $1 limit 1",
    )
    .bind(user_id)
    .fetch_optional(master)
    .await?;
    Ok(row.map(|(id, clerk_user_id, display_name)| {
        json!({ "id": id, "clerkUserId": clerk_user_id, "displayName": display_name })
    }))
}

/// `POST /api/onboard`: idempotent personal account creation.
async fn onboard(caller: Caller, body: Bytes) -> Response {
    // `onboardBody.safeParse(body)`.
    let body = loose_json(&body);
    let mut issues = Issues::default();
    let display_name = issues.object(&body).and_then(|fields| {
        issues
            .text(
                fields,
                "displayName",
                Presence::Optional,
                Some(1),
                Some(255),
            )
            .into_option()
    });
    if let Err(invalid) = issues.finish() {
        return ApiError::bad_request("Invalid body")
            .with_details(invalid.flatten())
            .into_response();
    }
    if let Some(account) = &caller.account {
        return data(account.to_json());
    }
    let result = async {
        let master = caller.master()?;
        // Race-safe: another request may have created it since the middleware ran.
        if let Some(found) = find_account(master, &caller.user_id).await? {
            return Ok(data(found));
        }
        let id = weldsuite_kit::generate_id("pa");
        let now = now_iso();
        let inserted = sqlx::query_as::<_, (String, String, Option<String>)>(
            "insert into personal_accounts (id, clerk_user_id, display_name, is_active, created_at, updated_at)
             values ($1, $2, $3, true, $4::timestamp, $4::timestamp)
             returning id, clerk_user_id, display_name",
        )
        .bind(&id)
        .bind(&caller.user_id)
        .bind(&display_name)
        .bind(&now)
        .fetch_one(master)
        .await;
        match inserted {
            Ok((id, clerk_user_id, display_name)) => Ok(created(
                json!({ "id": id, "clerkUserId": clerk_user_id, "displayName": display_name }),
            )),
            Err(error) => {
                let failure = Failure::Db(error);
                // A unique violation on clerk_user_id: the account that won.
                if failure.is_unique_violation()
                    && let Ok(Some(found)) = find_account(master, &caller.user_id).await
                {
                    return Ok(data(found));
                }
                Err(failure)
            }
        }
    }
    .await;
    answer(result, "Failed to onboard personal account")
}

/// `GET /api/me`: the account, its mailboxes and calendars, and the plan.
async fn me(caller: Caller) -> Response {
    let entitlements = caller.entitlements.to_json();
    let Some(account) = caller.account.clone() else {
        return data(json!({
            "account": null,
            "mailAccounts": [],
            "calendars": [],
            "entitlements": entitlements,
        }));
    };
    let result = async {
        let db = caller.personal()?;
        let mail_accounts: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(a) from personal_mail_accounts a
             where a.personal_account_id = $1 and a.deleted_at is null",
        )
        .bind(&account.id)
        .fetch_all(db)
        .await?;
        let calendars: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(c) from personal_calendars c
             where c.personal_account_id = $1 and c.deleted_at is null",
        )
        .bind(&account.id)
        .fetch_all(db)
        .await?;
        let mail_accounts: Vec<Value> = rows(mail_accounts)
            .iter()
            .map(|row| {
                pick(
                    row,
                    &[
                        "id",
                        "email",
                        "name",
                        "displayName",
                        "provider",
                        "status",
                        "isDefault",
                        "createdAt",
                    ],
                )
            })
            .collect();
        let calendars: Vec<Value> = rows(calendars)
            .iter()
            .map(|row| pick(row, &["id", "name", "color", "isDefault"]))
            .collect();
        Ok(data(json!({
            "account": account.to_json(),
            "mailAccounts": mail_accounts,
            "calendars": calendars,
            "entitlements": entitlements,
        })))
    }
    .await;
    answer(result, "Failed to load profile")
}

/// `registerBody`.
struct Register {
    token: String,
    platform: String,
    device_id: String,
    token_type: String,
    app_code: String,
    device_model: Option<String>,
    os_version: Option<String>,
    app_version: Option<String>,
}

/// `POST /api/push-tokens`: upsert by (account, device, app).
async fn register(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| Register {
        token: issues
            .text(b, "token", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        platform: issues
            .choice(
                b,
                "platform",
                Presence::Required,
                &["ios", "android", "web"],
            )
            .into_option()
            .unwrap_or_default(),
        device_id: issues
            .text(b, "deviceId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        token_type: issues
            .choice(b, "tokenType", Presence::Optional, &["expo", "fcm", "apns"])
            .into_option()
            .unwrap_or_else(|| "expo".to_owned()),
        app_code: issues
            .text(b, "appCode", Presence::Optional, Some(1), None)
            .into_option()
            .unwrap_or_else(|| "weldmail".to_owned()),
        device_model: issues
            .text(b, "deviceModel", Presence::Optional, None, None)
            .into_option(),
        os_version: issues
            .text(b, "osVersion", Presence::Optional, None, None)
            .into_option(),
        app_version: issues
            .text(b, "appVersion", Presence::Optional, None, None)
            .into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        let now = now_iso();
        sqlx::query(
            "insert into personal_device_tokens
               (id, personal_account_id, clerk_user_id, device_id, platform, token, token_type,
                app_code, device_model, os_version, app_version, is_active, last_used_at,
                created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, null, $12::timestamp,
                     $12::timestamp, $12::timestamp)
             on conflict (personal_account_id, device_id, app_code) do update set
               token = $6, token_type = $7, platform = $5, clerk_user_id = $3,
               device_model = coalesce($9, personal_device_tokens.device_model),
               os_version = coalesce($10, personal_device_tokens.os_version),
               app_version = coalesce($11, personal_device_tokens.app_version), is_active = null,
               last_used_at = $12::timestamp, updated_at = $12::timestamp",
        )
        .bind(weldsuite_kit::generate_id("pdt"))
        .bind(&account)
        .bind(&caller.user_id)
        .bind(&input.device_id)
        .bind(&input.platform)
        .bind(&input.token)
        .bind(&input.token_type)
        .bind(&input.app_code)
        .bind(&input.device_model)
        .bind(&input.os_version)
        .bind(&input.app_version)
        .bind(&now)
        .execute(db)
        .await?;
        Ok(data(json!({
            "deviceId": input.device_id,
            "platform": input.platform,
            "registered": true,
        })))
    }
    .await;
    answer(result, "Failed to register push token")
}

/// `DELETE /api/push-tokens?deviceId=`: deactivate the caller's device.
async fn unregister(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let device_id = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "deviceId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(device_id) => device_id,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        sqlx::query(
            "update personal_device_tokens set is_active = $3::timestamp, updated_at = $3::timestamp
             where personal_account_id = $1 and device_id = $2",
        )
        .bind(&account)
        .bind(&device_id)
        .bind(now_iso())
        .execute(db)
        .await?;
        Ok(data(json!({ "deviceId": device_id, "unregistered": true })))
    }
    .await;
    answer(result, "Failed to unregister push token")
}
