//! WooCommerce's application-authentication callback, PUBLIC
//! (`routes/webhooks-woocommerce-auth.ts`, `POST /webhooks/woocommerce/auth`):
//! the shop posts the API keys it made after the merchant approved. The
//! `user_id` is the HMAC-signed state `POST /api/connectors/authorize`
//! minted; the connection is finished by `weldsuite_connect_domain::auth`.
//! WooCommerce needs a 200 or it deletes the keys, so the webhooks, the
//! event and the first sync run after the answer.

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::json;
use weldsuite_connect_domain::auth::{AuthEnv, TenantRef, complete_woo_app_auth};
use weldsuite_connect_domain::sync::SyncEnv;
use weldsuite_connect_domain::webhooks::webhook_base_url;
use weldsuite_db::Tenant;

use crate::{CommerceState, Overrides};

/// The route at its full path.
pub(crate) fn router<S>(state: CommerceState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/woocommerce/auth", post(callback))
        .with_state(state)
}

async fn callback(
    State(state): State<CommerceState>,
    extensions: http::Extensions,
    body: Bytes,
) -> Response {
    let overrides = Overrides::from_extensions(&extensions);
    let env = |name: &str| overrides.env(&state, name);
    let auth = AuthEnv {
        sync: SyncEnv {
            keyring: weldsuite_connect_domain::connections::keyring(
                env("DATABASE_ENCRYPTION_KEY"),
                env("DATABASE_ENCRYPTION_KEY_V2"),
            ),
            stripe_secret_key: None,
            storage: None,
            http: overrides.http(&state),
            events: state.events.clone(),
        },
        cache: overrides.kv(&state),
        internal_api_secret: env("INTERNAL_API_SECRET"),
        app_api_public_url: env("APP_API_PUBLIC_URL"),
        public_app_url: env("PUBLIC_APP_URL"),
        environment: env("ENVIRONMENT"),
        moneybird_client_id: None,
        moneybird_client_secret: None,
        stripe_connect_client_id: None,
        webhook_base_url: webhook_base_url(
            env("CONNECTOR_WEBHOOK_BASE_URL").as_deref(),
            env("ENVIRONMENT").as_deref(),
        ),
    };
    let own = extensions.get::<Tenant>().cloned();
    let workspaces = state.workspaces.clone();
    let tenant_for = |org: String| async move {
        // Conformance: the test's `getTenantDbForWorkspace` hands out its database.
        if let Some(tenant) = own {
            return Ok(TenantRef {
                db: tenant.db,
                workspace_id: tenant.workspace_id,
            });
        }
        let Some(workspaces) = workspaces else {
            return Err("no tenant databases".to_owned());
        };
        let tenant = workspaces.tenant(&org).await.map_err(|e| e.to_string())?;
        Ok(TenantRef {
            db: tenant.db,
            workspace_id: tenant.workspace_id,
        })
    };
    let raw = String::from_utf8_lossy(&body).into_owned();
    match complete_woo_app_auth(&auth, &raw, tenant_for).await {
        Ok((_, status, message)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
            axum::Json(json!({ "data": { "message": message } })),
        )
            .into_response(),
        Err(error) => {
            tracing::error!(?error, "[app-api/woocommerce-auth] callback failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(
                    json!({ "error": { "message": "Failed to complete WooCommerce connection" } }),
                ),
            )
                .into_response()
        }
    }
}
