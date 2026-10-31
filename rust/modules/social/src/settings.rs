//! `/api/social-settings`: the module's settings, a singleton under
//! `workspace_settings.custom_settings.social` (the row keyed by the Clerk
//! org id), and the time zones the composer offers.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::SOCIAL_SETTINGS_UPDATED;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, SocialState, now, tables, validate};

const TIMEZONES: [&str; 13] = [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Europe/Amsterdam",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Australia/Sydney",
];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    let read = || gate.require([perm::ACCOUNTS_READ]);
    Router::new()
        .route(
            "/",
            get(read_settings)
                .route_layer(read())
                .merge(axum::routing::put(save).route_layer(gate.require([perm::ACCOUNTS_UPDATE]))),
        )
        .route("/timezones", get(timezones).route_layer(read()))
}

/// The settings row's `custom_settings`, when the row exists.
async fn custom_settings(caller: &Caller, org: Option<&str>) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<(Option<Value>,)> =
        sqlx::query_as("select custom_settings from workspace_settings where id = $1 limit 1")
            .bind(org)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(|(custom,)| custom.unwrap_or(Value::Null)))
}

/// `social[key] ?? fallback`.
fn or_default(social: &Value, key: &str, fallback: Value) -> Value {
    social
        .get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(fallback)
}

/// `GET /api/social-settings`: the stored settings over the defaults.
async fn read_settings(caller: Caller) -> Response {
    let custom = match custom_settings(&caller, caller.clerk_org_id.as_deref()).await {
        Ok(custom) => custom.unwrap_or(Value::Null),
        Err(error) => return crate::internal(&error, "Failed to fetch social settings"),
    };
    let social = custom
        .get("social")
        .filter(|s| !s.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    Data(json!({
        "defaultTimezone": or_default(&social, "defaultTimezone", json!("UTC")),
        "defaultApprovalRequired": or_default(&social, "defaultApprovalRequired", json!(false)),
        "autoScheduleEnabled": or_default(&social, "autoScheduleEnabled", json!(false)),
        "bestTimeToPost": or_default(&social, "bestTimeToPost", json!({ "enabled": false, "times": [] })),
        "hashtagSuggestions": or_default(&social, "hashtagSuggestions", json!(true)),
        "linkShortening": or_default(&social, "linkShortening", json!(false)),
        "utmTracking": or_default(&social, "utmTracking", json!({ "enabled": false, "source": "", "medium": "social", "campaign": "" })),
        "notifications": or_default(&social, "notifications", json!({
            "publishedPosts": true,
            "failedPosts": true,
            "approvalRequests": true,
            "weeklyReport": false,
        })),
    }))
    .into_response()
}

/// `updateSocialSettingsSchema`'s output: the keys given, nested objects
/// reduced to the schema's keys.
fn settings_input(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put(
        "defaultTimezone",
        issues
            .text(fields, "defaultTimezone", Presence::Optional, None, None)
            .into_option()
            .map(Value::String),
    );
    put(
        "defaultApprovalRequired",
        issues
            .boolean(fields, "defaultApprovalRequired", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    put(
        "autoScheduleEnabled",
        issues
            .boolean(fields, "autoScheduleEnabled", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    let best = issues.nested(
        fields,
        "bestTimeToPost",
        Presence::Optional,
        |issues, best| {
            let enabled = issues
                .boolean(best, "enabled", Presence::Required)
                .into_option();
            let times = issues.list(
                best,
                "times",
                Presence::Required,
                None,
                None,
                |issues, item| {
                    let fields = issues.object(item)?.clone();
                    let mut slot = Map::new();
                    issues_nested_numbers(issues, &fields, &mut slot);
                    Some(Value::Object(slot))
                },
            );
            json!({ "enabled": enabled, "times": times.into_option() })
        },
    );
    put("bestTimeToPost", best.into_option());
    put(
        "hashtagSuggestions",
        issues
            .boolean(fields, "hashtagSuggestions", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    put(
        "linkShortening",
        issues
            .boolean(fields, "linkShortening", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    let utm = issues.nested(fields, "utmTracking", Presence::Optional, |issues, utm| {
        json!({
            "enabled": issues.boolean(utm, "enabled", Presence::Required).into_option(),
            "source": issues.text_with(utm, "source", Presence::Required, Text::default()).into_option(),
            "medium": issues.text_with(utm, "medium", Presence::Required, Text::default()).into_option(),
            "campaign": issues.text_with(utm, "campaign", Presence::Required, Text::default()).into_option(),
        })
    });
    put("utmTracking", utm.into_option());
    let notifications = issues.nested(fields, "notifications", Presence::Optional, |issues, n| {
        json!({
            "publishedPosts": issues.boolean(n, "publishedPosts", Presence::Required).into_option(),
            "failedPosts": issues.boolean(n, "failedPosts", Presence::Required).into_option(),
            "approvalRequests": issues.boolean(n, "approvalRequests", Presence::Required).into_option(),
            "weeklyReport": issues.boolean(n, "weeklyReport", Presence::Required).into_option(),
        })
    });
    put("notifications", notifications.into_option());
    out
}

/// `{ day: z.number(), hour: z.number() }` of a `times` item.
fn issues_nested_numbers(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    slot: &mut Map<String, Value>,
) {
    for key in ["day", "hour"] {
        if let Some(number) = issues
            .number(fields, key, Presence::Required, Number::default())
            .into_option()
        {
            slot.insert(
                key.to_owned(),
                weldsuite_core_domain::js::number_value(number),
            );
        }
    }
}

/// `PUT /api/social-settings`: merge the given settings into the stored ones.
async fn save(
    State(state): State<SocialState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, settings_input) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let org = caller.clerk_org_id.clone().unwrap_or_default();
    let result = async {
        let existing = custom_settings(&caller, Some(&org)).await?;
        let mut custom = existing
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut social = custom
            .get("social")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        social.extend(data.clone());
        custom.insert("social".to_owned(), Value::Object(social));
        let table = &tables::WORKSPACE_SETTINGS;
        let now = now();
        let mut values = Map::new();
        table.set(&mut values, "customSettings", Value::Object(custom));
        table.set(&mut values, "updatedAt", json!(now));
        if existing.is_some() {
            table
                .patch(&caller.db, &org, values, false, &["updatedAt"])
                .await
                .map(|_| ())
        } else {
            table.set(&mut values, "id", json!(org));
            table.set(&mut values, "createdAt", json!(now));
            table
                .insert(&caller.db, values, &["createdAt", "updatedAt"])
                .await
                .map(|_| ())
        }
    }
    .await;
    if let Err(error) = result {
        return crate::internal(&error, "Failed to update social settings");
    }
    caller.publish(&state, SOCIAL_SETTINGS_UPDATED, &org, &Value::Object(data));
    Data(json!({ "message": "Social settings updated successfully" })).into_response()
}

/// `GET /api/social-settings/timezones`.
async fn timezones() -> Response {
    Data(json!(TIMEZONES)).into_response()
}
