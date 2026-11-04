//! `/api/reach/access`, `/settings`, `/billing` and `/overview`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::{ReachError, ReachResult, field, iso, now};

use crate::{Caller, ReachState, billing, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ReachState> {
    Router::new()
        .route(
            "/access",
            get(access).route_layer(gate.require([
                perm::REACH_CAMPAIGNS_READ,
                perm::REACH_PROSPECTS_READ,
                perm::REACH_INBOX_READ,
                perm::REACH_MAILBOXES_READ,
                perm::REACH_SETTINGS_READ,
            ])),
        )
        .route(
            "/settings",
            get(read_settings)
                .route_layer(gate.require([perm::REACH_SETTINGS_READ]))
                .merge(
                    axum::routing::patch(update_settings)
                        .route_layer(gate.require([perm::REACH_SETTINGS_UPDATE])),
                ),
        )
        .route(
            "/billing",
            get(billing_status).route_layer(gate.require([perm::REACH_SETTINGS_READ])),
        )
        .route(
            "/billing/setup",
            post(billing_setup).route_layer(gate.require([perm::REACH_MAILBOXES_CREATE])),
        )
        .route(
            "/overview",
            get(overview).route_layer(gate.require([perm::REACH_CAMPAIGNS_READ])),
        )
}

/// `GET /access`.
async fn access(caller: Caller) -> Response {
    respond(
        async {
            let access = crate::access_of(&caller)?;
            let sending = caller.sending_enabled().await;
            let summary = weldsuite_reach_domain::access::summary(
                &caller.db,
                &access.status,
                Some(&access.limits),
                sending,
            )
            .await?;
            Ok(Data(summary).into_response())
        }
        .await,
    )
}

/// `REACH_SETTINGS_ID`.
const SETTINGS_ID: &str = "rset_default";

/// `getOrCreateReachSettings(db)`.
pub(crate) async fn get_or_create_settings(db: &PgPool) -> ReachResult<Value> {
    if let Some(row) = weldsuite_reach_domain::campaigns::load_settings(db).await? {
        return Ok(row);
    }
    sqlx::query("insert into reach_settings (id) values ($1) on conflict do nothing")
        .bind(SETTINGS_ID)
        .execute(db)
        .await?;
    weldsuite_reach_domain::campaigns::load_settings(db)
        .await?
        .ok_or_else(|| ReachError::unexpected(&"reach_settings row could not be created"))
}

/// `toReachSettingsDto(row)`.
fn settings_dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "senderCompanyName": field(row, "senderCompanyName"),
        "senderAddress": field(row, "senderAddress"),
        "optOutText": field(row, "optOutText"),
        "defaultTimezone": field(row, "defaultTimezone"),
        "defaultSendDays": field(row, "defaultSendDays"),
        "defaultWindowStart": field(row, "defaultWindowStart"),
        "defaultWindowEnd": field(row, "defaultWindowEnd"),
        "defaultMailboxDailyCap": field(row, "defaultMailboxDailyCap"),
        "stopOnReplyScope": field(row, "stopOnReplyScope"),
        "onboardingCompletedAt": field(row, "onboardingCompletedAt"),
    })
}

async fn read_settings(caller: Caller) -> Response {
    respond(
        get_or_create_settings(&caller.db)
            .await
            .map(|row| Data(settings_dto(&row)).into_response()),
    )
}

/// `HH:MM` (`hhmm`).
pub(crate) fn is_hhmm(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && matches!(
            (bytes[0], bytes[1]),
            (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
        )
        && (b'0'..=b'5').contains(&bytes[3])
        && bytes[4].is_ascii_digit()
}

/// `z.array(z.number().int().min(1).max(7)).min(1).max(7)` (`weekdays`).
pub(crate) fn weekdays(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<Vec<i64>> {
    issues
        .list(fields, key, presence, Some(1), Some(7), |issues, item| {
            issues
                .item_number(
                    item,
                    Number {
                        coerce: false,
                        int: true,
                        min: Some(1.0),
                        max: Some(7.0),
                    },
                )
                .map(|n| n as i64)
        })
        .into_option()
}

/// The validated `updateReachSettingsSchema` body.
struct SettingsInput {
    fields: Vec<(&'static str, Value)>,
    complete_onboarding: Option<bool>,
}

fn settings_input(issues: &mut Issues, body: &Map<String, Value>) -> SettingsInput {
    let mut fields: Vec<(&'static str, Value)> = Vec::new();
    let text = |issues: &mut Issues, key: &str, rules: Text| {
        issues
            .text_with(body, key, Presence::Optional, rules)
            .into_option()
    };
    if let Some(v) = text(
        issues,
        "senderCompanyName",
        Text::trimmed(Some(1), Some(200)),
    ) {
        fields.push(("sender_company_name", json!(v)));
    }
    if let Some(v) = text(issues, "senderAddress", Text::trimmed(Some(1), Some(1000))) {
        fields.push(("sender_address", json!(v)));
    }
    if let Some(v) = text(issues, "optOutText", Text::trimmed(Some(1), Some(500))) {
        fields.push(("opt_out_text", json!(v)));
    }
    if let Some(v) = text(issues, "defaultTimezone", Text::length(Some(1), Some(64))) {
        fields.push(("default_timezone", json!(v)));
    }
    if let Some(v) = weekdays(issues, body, "defaultSendDays", Presence::Optional) {
        fields.push(("default_send_days", json!(v)));
    }
    for (key, column) in [
        ("defaultWindowStart", "default_window_start"),
        ("defaultWindowEnd", "default_window_end"),
    ] {
        if let Some(v) = issues
            .pattern(
                body,
                key,
                Presence::Optional,
                None,
                None,
                is_hhmm,
                "Use HH:MM",
            )
            .into_option()
        {
            fields.push((column, json!(v)));
        }
    }
    if let Some(v) = issues
        .whole_number(
            body,
            "defaultMailboxDailyCap",
            Presence::Optional,
            Number {
                coerce: false,
                int: true,
                min: Some(1.0),
                max: Some(50.0),
            },
        )
        .into_option()
    {
        fields.push(("default_mailbox_daily_cap", json!(v)));
    }
    if let Some(v) = issues
        .choice(
            body,
            "stopOnReplyScope",
            Presence::Optional,
            &["prospect", "company"],
        )
        .into_option()
    {
        fields.push(("stop_on_reply_scope", json!(v)));
    }
    let complete_onboarding = issues
        .boolean(body, "completeOnboarding", Presence::Optional)
        .into_option();
    SettingsInput {
        fields,
        complete_onboarding,
    }
}

async fn update_settings(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, settings_input) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        async {
            let current = get_or_create_settings(&caller.db).await?;
            let at = iso(now());
            let mut patch = Map::new();
            for (column, value) in &input.fields {
                patch.insert((*column).to_owned(), value.clone());
            }
            if input.complete_onboarding == Some(true) && current.get("onboardingCompletedAt").is_none_or(Value::is_null) {
                patch.insert("onboarding_completed_at".to_owned(), json!(at));
            }
            let row: Option<Value> = sqlx::query_scalar(
                "update reach_settings s set
                     sender_company_name = case when $2::jsonb ? 'sender_company_name' then $2::jsonb->>'sender_company_name' else s.sender_company_name end,
                     sender_address = case when $2::jsonb ? 'sender_address' then $2::jsonb->>'sender_address' else s.sender_address end,
                     opt_out_text = case when $2::jsonb ? 'opt_out_text' then $2::jsonb->>'opt_out_text' else s.opt_out_text end,
                     default_timezone = case when $2::jsonb ? 'default_timezone' then $2::jsonb->>'default_timezone' else s.default_timezone end,
                     default_send_days = case when $2::jsonb ? 'default_send_days' then $2::jsonb->'default_send_days' else s.default_send_days end,
                     default_window_start = case when $2::jsonb ? 'default_window_start' then $2::jsonb->>'default_window_start' else s.default_window_start end,
                     default_window_end = case when $2::jsonb ? 'default_window_end' then $2::jsonb->>'default_window_end' else s.default_window_end end,
                     default_mailbox_daily_cap = case when $2::jsonb ? 'default_mailbox_daily_cap' then ($2::jsonb->>'default_mailbox_daily_cap')::int else s.default_mailbox_daily_cap end,
                     stop_on_reply_scope = case when $2::jsonb ? 'stop_on_reply_scope' then $2::jsonb->>'stop_on_reply_scope' else s.stop_on_reply_scope end,
                     onboarding_completed_at = case when $2::jsonb ? 'onboarding_completed_at' then ($2::jsonb->>'onboarding_completed_at')::timestamptz else s.onboarding_completed_at end,
                     updated_at = $3::timestamptz
                 where s.id = $1 returning to_jsonb(s)",
            )
            .bind(field(&current, "id").as_str())
            .bind(Value::Object(patch))
            .bind(&at)
            .fetch_optional(&caller.db)
            .await?;
            let row = row.map_or(current, weldsuite_db::js_row);
            Ok(Data(settings_dto(&row)).into_response())
        }
        .await,
    )
}

async fn billing_status(State(state): State<ReachState>, caller: Caller) -> Response {
    respond(
        billing::status(&caller, &state)
            .await
            .map(|summary| Data(summary).into_response()),
    )
}

async fn billing_setup(
    State(state): State<ReachState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let success = issues
            .text_with(
                body,
                "successUrl",
                Presence::Required,
                Text {
                    format: Some(Format::Url),
                    ..Text::default()
                },
            )
            .into_option();
        let cancel = issues
            .text_with(
                body,
                "cancelUrl",
                Presence::Required,
                Text {
                    format: Some(Format::Url),
                    ..Text::default()
                },
            )
            .into_option();
        json!({ "successUrl": success, "cancelUrl": cancel })
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        billing::setup(&caller, &state, &input)
            .await
            .map(|url| Data(url).into_response()),
    )
}

async fn overview(caller: Caller) -> Response {
    match weldsuite_reach_domain::overview::build(&caller.db, caller.now()).await {
        Ok(overview) => Data(overview).into_response(),
        Err(error) => {
            tracing::error!(%error, "[reach-api] overview failed");
            weldsuite_kit::ApiError::internal().into_response()
        }
    }
}
