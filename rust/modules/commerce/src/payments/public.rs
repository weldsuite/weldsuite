//! The two public routes of payments, outside the session: Mollie's webhook
//! (`POST /webhooks/commerce/mollie/:connectionId`) and the OAuth callback
//! (`GET /api/commerce-payments/connection/mollie/callback`).
//!
//! The webhook has no credential at all, so it believes nothing it is told:
//! the connection id in the path names the workspace through the master
//! registry, the body names a payment id, and the payment's state is read
//! back from Mollie with that connection's own token. A payment id that is
//! not ours is answered 200 and ignored; so is any failure after that (the
//! next webhook or read tries again).
//!
//! The callback's signed `state` carries the workspace and the member who
//! started the connection (ten minutes).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::header::LOCATION;
use http::{HeaderValue, StatusCode};
use serde_json::Value;
use weldsuite_catalogs::entity_events::COMMERCE_PAYMENT_CONNECTION_CONNECTED;
use weldsuite_commerce_domain::payments::service;
use weldsuite_db::{PgPool, Workspaces};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_ports::OutboundHttp;

use super::connection::{Save, save};
use super::registry::{Registry, workspace_of};
use super::settle::{Settle, settle_after_apply};
use super::state;
use crate::config::PaymentsConfig;

/// What the public routes need from the server.
#[derive(Clone)]
pub struct PaymentsPublicState {
    pub events: EntityEventPublisher,
    pub http: Option<OutboundHttp>,
    /// The master database (`commerce_connection_registry`).
    pub master: PgPool,
    /// Opens a workspace's tenant database by `workspaces.id`.
    pub workspaces: Arc<Workspaces>,
    pub payments: PaymentsConfig,
}

/// Mollie's webhook and the OAuth callback, at their full paths, to merge at
/// the server's root ahead of the session.
pub fn public_router<S>(state: PaymentsPublicState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/commerce/mollie/{connection_id}", post(webhook))
        .route(
            "/api/commerce-payments/connection/mollie/callback",
            get(callback),
        )
        .with_state(state)
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

// ── the webhook ─────────────────────────────────────────────────────────────

async fn webhook(
    State(state): State<PaymentsPublicState>,
    Path(connection_id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(payment_id) = url::form_urlencoded::parse(&body)
        .find(|(name, _)| name == "id")
        .map(|(_, value)| value.into_owned())
        .filter(|id| weldsuite_mollie::is_payment_id(id))
    else {
        return status(StatusCode::BAD_REQUEST);
    };
    let workspace = match workspace_of(&state.master, &connection_id).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return status(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::error!(%error, "[commerce] webhook: the registry could not be read");
            return status(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let tenant = match state.workspaces.tenant(&workspace).await {
        Ok(tenant) => tenant,
        Err(error) => {
            tracing::error!(%error, "[commerce] webhook: the workspace could not be opened");
            return status(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let Some(http) = state.http.as_ref() else {
        return status(StatusCode::OK);
    };
    let payment = match service::by_provider_id(&tenant.db, &payment_id).await {
        Ok(Some(payment)) if payment["connectionId"] == connection_id.as_str() => payment,
        Ok(_) => return status(StatusCode::OK),
        Err(error) => {
            tracing::error!(%error, "[commerce] webhook: the payment could not be read");
            return status(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let env = state.payments.env(&tenant.db, http);
    match service::read_back(&env, &payment).await {
        Ok(applied) => {
            let ctx = EventContext::from_ids(
                &tenant.workspace_id,
                tenant.clerk_org_id.as_deref(),
                "system",
            );
            let settle = Settle {
                events: &state.events,
                ctx: &ctx,
                db: &tenant.db,
                config: &state.payments,
                workspace_id: &tenant.workspace_id,
                user_id: "system",
            };
            settle_after_apply(&settle, &applied).await;
        }
        Err(error) => {
            tracing::error!(%error, payment = payment_id, "[commerce] webhook: the payment could not be read back");
        }
    }
    status(StatusCode::OK)
}

// ── the OAuth callback ──────────────────────────────────────────────────────

const DEFAULT_RETURN: &str = "/settings/apps/weldcommerce?tab=payments";

/// A 302 to the platform with the outcome in the query.
fn back(state: &PaymentsPublicState, path: Option<&str>, outcome: &[(&str, &str)]) -> Response {
    let path = path.unwrap_or(DEFAULT_RETURN);
    let mut target = path.to_owned();
    for (name, value) in outcome {
        target.push(if target.contains('?') { '&' } else { '?' });
        target.push_str(name);
        target.push('=');
        target.extend(url::form_urlencoded::byte_serialize(value.as_bytes()));
    }
    let base = state
        .payments
        .app_url
        .as_deref()
        .or(state.payments.public_url.as_deref())
        .map_or("", |base| base.trim_end_matches('/'));
    let location = format!("{base}{target}");
    let mut response = status(StatusCode::FOUND);
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(LOCATION, value);
    }
    response
}

fn failure(state: &PaymentsPublicState, path: Option<&str>, reason: &str) -> Response {
    back(state, path, &[("mollie", "error"), ("reason", reason)])
}

/// `access_denied` and the like: a short code, nothing else.
fn short_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .take(40)
        .collect()
}

#[allow(
    clippy::too_many_lines,
    reason = "the steps of the connection in order"
)]
async fn callback(State(state): State<PaymentsPublicState>, RawQuery(query): RawQuery) -> Response {
    let params: Vec<(String, String)> =
        url::form_urlencoded::parse(query.as_deref().unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let param = |name: &str| {
        params
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    let claims = state
        .payments
        .state_secret
        .as_deref()
        .zip(param("state"))
        .and_then(|(secret, token)| state::verify(secret, token));
    let Some(claims) = claims else {
        return failure(&state, None, "invalid_state");
    };
    let text = |key: &str| claims.get(key).and_then(Value::as_str);
    let (Some(workspace), Some(user)) = (text("workspaceId"), text("userId")) else {
        return failure(&state, None, "invalid_state");
    };
    let path = text("redirectTo").filter(|p| p.starts_with('/') && !p.starts_with("//"));
    if let Some(error) = param("error") {
        let code = short_code(error);
        return failure(&state, path, if code.is_empty() { "denied" } else { &code });
    }
    let Some(code) = param("code").filter(|c| !c.is_empty()) else {
        return failure(&state, path, "missing_code");
    };
    let (Some(app), Some(http), Some(callback_url)) = (
        state.payments.connect.as_ref(),
        state.http.as_ref(),
        state.payments.callback_url(),
    ) else {
        return failure(&state, path, "not_configured");
    };
    let tenant = match state.workspaces.tenant(workspace).await {
        Ok(tenant) => tenant,
        Err(error) => {
            tracing::error!(%error, "[commerce] callback: the workspace could not be opened");
            return failure(&state, path, "workspace");
        }
    };
    let tokens = match app.exchange_code(http, code, &callback_url).await {
        Ok(tokens) => tokens,
        Err(error) => {
            tracing::warn!(%error, "[commerce] callback: Mollie refused the code");
            return failure(&state, path, "token_exchange_failed");
        }
    };
    let mollie = weldsuite_mollie::Mollie::new(&state.payments.api_url, &tokens.access_token);
    let organization = mollie.organization(http).await.ok();
    let profiles = mollie.profiles(http).await.unwrap_or_default();
    let profile = profiles
        .iter()
        .find(|p| p.mode.as_deref() == Some("live"))
        .or_else(|| profiles.first());
    let registry = Registry::new(&state.master, &tenant.workspace_id);
    let saved = save(
        &registry,
        &tenant.db,
        &state.payments,
        &Save {
            auth_method: "oauth",
            tokens: Some(&tokens),
            api_key: None,
            testmode: profile.is_some_and(|p| p.mode.as_deref() == Some("test")),
            profile_id: profile.map(|p| p.id.as_str()),
            profile_name: profile.map(|p| p.name.as_str()),
            organization_id: organization.as_ref().map(|o| o.id.as_str()),
            organization_name: organization.as_ref().and_then(|o| o.name.as_deref()),
            connected_by: user,
        },
    )
    .await;
    match saved {
        Ok(row) => {
            let ctx =
                EventContext::from_ids(&tenant.workspace_id, tenant.clerk_org_id.as_deref(), user);
            publish_entity_event(
                &state.events,
                &ctx,
                COMMERCE_PAYMENT_CONNECTION_CONNECTED,
                row["id"].as_str().unwrap_or_default(),
                &serde_json::json!({
                    "id": row["id"],
                    "provider": "mollie",
                    "authMethod": "oauth",
                    "status": row["status"],
                    "testmode": row["testmode"],
                    "profileId": row["profileId"],
                    "organizationName": row["organizationName"],
                }),
            );
            back(&state, path, &[("mollie", "connected")])
        }
        Err(refusal) => {
            let _ = refusal.respond("Failed to store the Mollie connection");
            failure(&state, path, "store_failed")
        }
    }
}
