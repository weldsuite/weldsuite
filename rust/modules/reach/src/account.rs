//! `/api/reach/access`, `/settings`, `/billing` and `/overview`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::orm;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::{ReachError, ReachResult, field, now, text};
use weldsuite_schema::tenant::reach_settings;

use crate::{Caller, ReachState, billing, db_error, respond, validate};

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
    reach_settings::Entity::insert(reach_settings::ActiveModel {
        id: Set(SETTINGS_ID.to_owned()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(db))
    .await
    .map_err(db_error)?;
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

/// The validated `updateReachSettingsSchema` body: the columns it sets.
struct SettingsInput {
    fields: Vec<(reach_settings::Column, Expr)>,
    complete_onboarding: Option<bool>,
}

fn settings_input(issues: &mut Issues, body: &Map<String, Value>) -> SettingsInput {
    use reach_settings::Column;
    let mut fields: Vec<(Column, Expr)> = Vec::new();
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
        fields.push((Column::SenderCompanyName, Expr::value(v)));
    }
    if let Some(v) = text(issues, "senderAddress", Text::trimmed(Some(1), Some(1000))) {
        fields.push((Column::SenderAddress, Expr::value(v)));
    }
    if let Some(v) = text(issues, "optOutText", Text::trimmed(Some(1), Some(500))) {
        fields.push((Column::OptOutText, Expr::value(v)));
    }
    if let Some(v) = text(issues, "defaultTimezone", Text::length(Some(1), Some(64))) {
        fields.push((Column::DefaultTimezone, Expr::value(v)));
    }
    if let Some(v) = weekdays(issues, body, "defaultSendDays", Presence::Optional) {
        fields.push((Column::DefaultSendDays, Expr::value(json!(v))));
    }
    for (key, column) in [
        ("defaultWindowStart", Column::DefaultWindowStart),
        ("defaultWindowEnd", Column::DefaultWindowEnd),
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
            fields.push((column, Expr::value(v)));
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
        fields.push((
            Column::DefaultMailboxDailyCap,
            Expr::value(i32::try_from(v).unwrap_or_default()),
        ));
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
        fields.push((Column::StopOnReplyScope, Expr::value(v)));
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
            let at = now();
            let mut update = reach_settings::Entity::update_many();
            for (column, value) in &input.fields {
                update = update.col_expr(*column, value.clone());
            }
            if input.complete_onboarding == Some(true) && current.get("onboardingCompletedAt").is_none_or(Value::is_null) {
                update = update.col_expr(reach_settings::Column::OnboardingCompletedAt, Expr::value(at));
            }
            let row = update
                .col_expr(reach_settings::Column::UpdatedAt, Expr::value(at))
                .filter(reach_settings::Column::Id.eq(text(&current, "id").unwrap_or_default()))
                .exec_with_returning(&orm(&caller.db))
                .await
                .map_err(db_error)?
                .into_iter()
                .next()
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| ReachError::unexpected(&error))?;
            let row = row.unwrap_or(current);
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
