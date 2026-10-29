//! `appAccessGate(appCode)` (`worker-kit/src/app-access.ts`): apps that are on
//! request only refuse every request until staff approve the workspace's
//! access (master `workspace_app_access`). Answers 403 `APP_ACCESS_REQUIRED`
//! with the current status, so the client can say "pending", "rejected" or
//! "suspended".
//!
//! The status is cached for 60 seconds per (workspace, app), in process
//! instead of the workers' KV: a suspension reaches the request path within a
//! minute without a master read per request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::request::Parts;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_auth::AuthContext;
use weldsuite_kit::ApiError;

/// `APP_ACCESS_CACHE_TTL_SECONDS`.
pub const APP_ACCESS_CACHE_TTL: Duration = Duration::from_secs(60);

/// A workspace's access to one app (`AppAccess`), as the routes behind the
/// gate read it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAccess {
    /// `workspaces.id`, or `None` when the org has no workspace row.
    pub workspace_id: Option<String>,
    /// `none`, `requested`, `approved`, `rejected`, `suspended` or `revoked`.
    pub status: String,
    /// Staff-set limits for the routes to enforce.
    pub limits: Value,
    /// The app's own subscription state: `none`, `active`, `past_due`, `canceled`.
    pub billing_status: String,
    /// When `billing_status` last changed, as `Date#toISOString()`.
    pub billing_status_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AccessRow {
    workspace_id: String,
    status: Option<String>,
    limits: Option<Value>,
    billing_status: Option<String>,
    billing_status_at: Option<String>,
}

/// Uncached master read (`readAppAccessFrom`), by `workspaces.id` or Clerk
/// org id.
pub async fn read_app_access(
    master: &PgPool,
    workspace_ref: &str,
    app_code: &str,
) -> Result<AppAccess, sqlx::Error> {
    let row: Option<AccessRow> = sqlx::query_as(
        r#"select w.id as workspace_id, a.status, a.limits, a.billing_status,
                  to_char(a.billing_status_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                      as billing_status_at
           from workspaces w
           left join workspace_app_access a on a.workspace_id = w.id and a.app_code = $2
           where w.id = $1 or w.clerk_org_id = $1
           limit 1"#,
    )
    .bind(workspace_ref)
    .bind(app_code)
    .fetch_optional(master)
    .await?;
    Ok(match row {
        Some(row) => AppAccess {
            workspace_id: Some(row.workspace_id),
            status: row.status.unwrap_or_else(|| "none".to_owned()),
            limits: row.limits.unwrap_or_else(|| json!({})),
            billing_status: row.billing_status.unwrap_or_else(|| "none".to_owned()),
            billing_status_at: row.billing_status_at,
        },
        None => AppAccess {
            workspace_id: None,
            status: "none".to_owned(),
            limits: json!({}),
            billing_status: "none".to_owned(),
            billing_status_at: None,
        },
    })
}

/// 403 `APP_ACCESS_REQUIRED` (`appAccessRequiredBody`).
pub fn app_access_required(app_code: &str, status: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "APP_ACCESS_REQUIRED",
        format!("This workspace has no approved access to {app_code}."),
    )
    .with_details(json!({ "appCode": app_code, "status": status }))
}

/// The gate for one app; share it with `Arc` and mount it with
/// `from_fn_with_state(gate, app_access_gate)` on the app's routes.
pub struct AppAccessGate {
    master: PgPool,
    app_code: &'static str,
    cache: Mutex<HashMap<String, (Instant, AppAccess)>>,
}

impl std::fmt::Debug for AppAccessGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppAccessGate")
            .field("app_code", &self.app_code)
            .finish_non_exhaustive()
    }
}

impl AppAccessGate {
    pub fn new(master: PgPool, app_code: &'static str) -> Self {
        Self {
            master,
            app_code,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Cached read (`getAppAccess`).
    pub async fn access(&self, org_id: &str) -> Result<AppAccess, sqlx::Error> {
        {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some((at, access)) = cache.get(org_id)
                && at.elapsed() < APP_ACCESS_CACHE_TTL
            {
                return Ok(access.clone());
            }
        }
        let access = read_app_access(&self.master, org_id, self.app_code).await?;
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if cache.len() > 10_000 {
            cache.clear();
        }
        cache.insert(org_id.to_owned(), (Instant::now(), access.clone()));
        Ok(access)
    }
}

/// Middleware: refuse unless the workspace's access to the gate's app is
/// approved; puts the [`AppAccess`] in the request extensions.
pub async fn app_access_gate(
    State(gate): State<Arc<AppAccessGate>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(org_id) = request
        .extensions()
        .get::<AuthContext>()
        .and_then(|auth| auth.org_id.clone())
    else {
        return app_access_required(gate.app_code, "none").into_response();
    };
    let access = match gate.access(&org_id).await {
        Ok(access) => access,
        Err(error) => {
            tracing::error!(%error, app = gate.app_code, "app access: master read failed");
            return ApiError::internal().into_response();
        }
    };
    if access.status != "approved" {
        return app_access_required(gate.app_code, &access.status).into_response();
    }
    request.extensions_mut().insert(access);
    next.run(request).await
}

/// Handlers behind [`app_access_gate`] take [`AppAccess`] as an argument.
impl<S: Send + Sync> FromRequestParts<S> for AppAccess {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(parts.extensions.get::<Self>().cloned().ok_or_else(|| {
            tracing::error!("app access: AppAccess extracted on a route without app_access_gate");
            ApiError::internal()
        }))
    }
}
