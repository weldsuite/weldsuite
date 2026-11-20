//! WooCommerce's application-authentication callback, PUBLIC
//! (`routes/webhooks-woocommerce-auth.ts`, `POST /webhooks/woocommerce/auth`):
//! the shop posts the API keys it made after the merchant approved. The
//! `user_id` is the HMAC-signed state `POST /api/connectors/authorize`
//! minted; the connection is finished by `weldsuite_connect_domain::auth`.
//! WooCommerce needs a 200 or it deletes the keys, so the webhooks, the
//! event and the first sync run after the answer.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::json;
use weldsuite_connect_domain::auth::{TenantRef, complete_woo_app_auth};
use weldsuite_db::Tenant;

use crate::connector_auth::auth_env;
use crate::{ConnectState, Overrides};

/// What the callback needs beyond the connect state: the workspace
/// directory, which opens the authorising workspace's tenant database and
/// names its `workspaces.id` (`getWorkspaceForOrg`).
#[derive(Clone)]
struct WooAuthState {
    connect: ConnectState,
    workspaces: Option<Arc<weldsuite_db::Workspaces>>,
}

/// The route at its full path.
pub(crate) fn router<S>(
    connect: ConnectState,
    workspaces: Option<Arc<weldsuite_db::Workspaces>>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/woocommerce/auth", post(callback))
        .with_state(WooAuthState {
            connect,
            workspaces,
        })
}

async fn callback(
    State(state): State<WooAuthState>,
    extensions: http::Extensions,
    body: Bytes,
) -> Response {
    let overrides = Overrides::from_extensions(&extensions);
    // `completeWooCommerceAppAuth({ env: c.env, ... })`: connect-api's env.
    let auth = auth_env(&overrides, &state.connect);
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
