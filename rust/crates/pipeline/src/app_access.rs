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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QuerySelect,
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_db::orm;
use weldsuite_kit::ApiError;
use weldsuite_schema::master::{workspace_app_access, workspaces};

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

#[derive(FromQueryResult)]
struct AccessRow {
    workspace_id: String,
    status: Option<String>,
    limits: Option<Value>,
    billing_status: Option<String>,
    billing_status_at: Option<OffsetDateTime>,
}

/// `Date#toISOString()` (what `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
/// printed in UTC: milliseconds truncated).
fn iso(at: OffsetDateTime) -> String {
    at.to_offset(time::UtcOffset::UTC)
        .format(time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        ))
        .unwrap_or_default()
}

/// Uncached master read (`readAppAccessFrom`), by `workspaces.id` or Clerk
/// org id.
pub async fn read_app_access(
    master: &PgPool,
    workspace_ref: &str,
    app_code: &str,
) -> Result<AppAccess, DbErr> {
    use workspace_app_access::Column as Access;
    // `left join workspace_app_access a on a.workspace_id = w.id and a.app_code = $app`.
    let app = app_code.to_owned();
    let access = workspaces::Entity::belongs_to(workspace_app_access::Entity)
        .from(workspaces::Column::Id)
        .to(Access::WorkspaceId)
        .on_condition(move |_, right| {
            Condition::all().add(sea_orm::ExprTrait::eq(
                Expr::col((right, Access::AppCode)),
                app.clone(),
            ))
        })
        .into();
    let row: Option<AccessRow> = workspaces::Entity::find()
        .select_only()
        .column_as(workspaces::Column::Id, "workspace_id")
        .column_as(Access::Status, "status")
        .column_as(Access::Limits, "limits")
        .column_as(Access::BillingStatus, "billing_status")
        .column_as(Access::BillingStatusAt, "billing_status_at")
        .join(JoinType::LeftJoin, access)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(workspace_ref))
                .add(workspaces::Column::ClerkOrgId.eq(workspace_ref)),
        )
        .into_model()
        .one(&orm(master))
        .await?;
    Ok(match row {
        Some(row) => AppAccess {
            workspace_id: Some(row.workspace_id),
            status: row.status.unwrap_or_else(|| "none".to_owned()),
            limits: row.limits.unwrap_or_else(|| json!({})),
            billing_status: row.billing_status.unwrap_or_else(|| "none".to_owned()),
            billing_status_at: row.billing_status_at.map(iso),
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
    pub async fn access(&self, org_id: &str) -> Result<AppAccess, DbErr> {
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
