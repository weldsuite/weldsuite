//! `/api/social-accounts`: the connected channels (CRUD, their OAuth tokens
//! never shown), and connecting and syncing them through PostPeer.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_social_domain::publishing::{PublishError, get_connect_url, sync_accounts};

use crate::crud::{
    self, Crud, Filter, Partial, Standard, event, field, or_default, update_or_existing,
    update_or_existing_or,
};
use crate::objects::{OPT, POSTS, messages, string};
use crate::{Caller, SocialState, tables, validate};

const ACCOUNT_LIST: (&str, &str) = listing!("social_accounts";
    "($2::boolean or t.platform = $3::social_platform)",
    "($4::boolean or t.status = $5::social_account_status)";
    6, 7, 8; "$9");

fn account_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "platform", partial.required(), Some(50));
    string(issues, body, "username", OPT, Some(255));
    string(issues, body, "displayName", OPT, Some(255));
    string(issues, body, "status", OPT, Some(30));
}

/// `connectedByUserId` is NOT NULL and server-owned: the caller by default.
#[allow(clippy::unnecessary_wraps)] // a crud::Prepare
fn account_prepare(
    caller: &Caller,
    _id: &str,
    data: &mut Map<String, Value>,
) -> Result<Vec<&'static str>, ()> {
    if data.get("connectedByUserId").is_none_or(Value::is_null) {
        data.insert("connectedByUserId".to_owned(), json!(caller.user_id));
    }
    Ok(Vec::new())
}

fn account_created(id: &str, data: &Map<String, Value>) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("name", field(data, "name")),
        ("platform", field(data, "platform")),
        ("status", or_default(data, "status", "active")),
    ])
}

fn account_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("name", update_or_existing(data, existing, "name")),
        ("platform", existing.get("platform").cloned()),
        (
            "status",
            update_or_existing_or(data, existing, "status", "active"),
        ),
    ])
}

static ACCOUNTS: Crud = Crud {
    table: &tables::SOCIAL_ACCOUNTS,
    resource: "Social account",
    id_prefix: "sac",
    gates: POSTS,
    messages: messages(
        "Failed to list social accounts",
        "Failed to fetch social account",
        "Failed to create social account",
        "Failed to update social account",
        "Failed to delete social account",
    ),
    schema: account_schema,
    filters: &[Filter::eq("platform"), Filter::eq("status")],
    list_sql: ACCOUNT_LIST.0,
    count_sql: ACCOUNT_LIST.1,
    slice_count: true,
    hidden: &["accessToken", "refreshToken"],
    prepare: account_prepare,
    created: ev::SOCIAL_ACCOUNT_CREATED,
    created_event: account_created,
    updated: ev::SOCIAL_ACCOUNT_UPDATED,
    updated_event: account_updated,
    guard: None,
    deleted: ev::SOCIAL_ACCOUNT_DELETED,
};

const PLATFORMS: [&str; 5] = ["facebook", "instagram", "twitter", "linkedin", "tiktok"];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    let update = || gate.require([POSTS.update]);
    crud::routes(
        &ACCOUNTS,
        gate,
        Standard {
            create: true,
            remove: true,
        },
    )
    .route("/connect", post(connect).route_layer(update()))
    .route("/sync", post(sync).route_layer(update()))
}

/// `PostPeerNotConfiguredError`'s answer, else the route's 500.
fn refused(error: &PublishError, message: &str) -> Response {
    if matches!(error, PublishError::NotConfigured) {
        return ApiError::bad_request("Social publishing is not configured").into_response();
    }
    crate::internal(error, message)
}

/// `POST /api/social-accounts/connect { platform, redirectUri? }`: the
/// hosted OAuth URL under the workspace's PostPeer profile.
async fn connect(
    State(state): State<SocialState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        let platform = issues.choice(fields, "platform", Presence::Required, &PLATFORMS);
        let redirect = issues.text_with(
            fields,
            "redirectUri",
            Presence::Optional,
            Text {
                format: Some(Format::Url),
                ..Text::default()
            },
        );
        (platform.into_option(), redirect.into_option())
    });
    let (platform, redirect) = match input {
        Ok((Some(platform), redirect)) => (platform, redirect),
        Ok(_) => return ApiError::internal().into_response(),
        Err(response) => return *response,
    };
    let org = caller.clerk_org_id.clone().unwrap_or_default();
    match get_connect_url(
        &caller.db,
        &caller.context(&state),
        &org,
        &platform,
        redirect.as_deref(),
    )
    .await
    {
        Ok(result) => Data(result).into_response(),
        Err(error) => refused(&error, "Failed to start account connection"),
    }
}

/// `POST /api/social-accounts/sync`: import the workspace's PostPeer channels.
async fn sync(State(state): State<SocialState>, caller: Caller) -> Response {
    let org = caller.clerk_org_id.clone().unwrap_or_default();
    match sync_accounts(&caller.db, &caller.context(&state), &org, &caller.user_id).await {
        Ok(result) => Data(result).into_response(),
        Err(error) => refused(&error, "Failed to sync social accounts"),
    }
}
