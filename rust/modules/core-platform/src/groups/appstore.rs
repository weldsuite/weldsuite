//! `/api/appstore` (`app-api/src/routes/appstore`): the app store's
//! per-workspace and per-user side, next to `/api/app-catalog`'s browse and
//! install.
//!
//! - `GET /my-apps`: the codes actively assigned to the caller.
//! - `GET /installed-apps`: the workspace's active `workspace_installed_apps`
//!   rows, whole.
//! - `GET /can-manage-apps`: whether the caller's member row is OWNER or
//!   ADMIN; a failure reads as `false`, so the store still renders.
//! - `POST /apps/:appCode/assign-all-members` (`general:update`, and the
//!   member row must be OWNER or ADMIN): grant an installed app to every
//!   active member that is neither (owners and admins bypass assignments).
//!   Existing assignments stay as they are. Legacy codes are translated as
//!   the install route does.
//!
//! The reads need `general:read`. No entity events: app assignments are not
//! in the catalog.

use std::sync::Arc;

use axum::Router;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/my-apps", get(my_apps).route_layer(need(GENERAL_READ)))
        .route(
            "/installed-apps",
            get(installed_apps).route_layer(need(GENERAL_READ)),
        )
        .route(
            "/can-manage-apps",
            get(can_manage_apps).route_layer(need(GENERAL_READ)),
        )
        .route(
            "/apps/{app_code}/assign-all-members",
            post(assign_all_members).route_layer(need(GENERAL_UPDATE)),
        )
}

/// `toDbCode`: the legacy mobile codes as the database stores them.
fn to_db_code(code: &str) -> String {
    match code {
        "helpdesk" => "welddesk".to_owned(),
        "mail" => "weldmail".to_owned(),
        other => other.to_owned(),
    }
}

/// The caller's role on their member row (any, if there are several).
async fn member_role(db: &PgPool, user_id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select role from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
}

fn is_manager(role: Option<&str>) -> bool {
    matches!(role, Some("OWNER" | "ADMIN"))
}

// ── GET /my-apps ────────────────────────────────────────────────────────────

async fn my_apps(caller: Caller) -> Response {
    let codes: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "select app_code from user_app_assignments where user_id = $1 and is_active = true",
    )
    .bind(&caller.user_id)
    .fetch_all(&caller.db)
    .await;
    match codes {
        Ok(codes) => Data(codes).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch apps", error).respond(),
    }
}

// ── GET /installed-apps ─────────────────────────────────────────────────────

async fn installed_apps(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from workspace_installed_apps t
         where is_active = true and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch installed apps", error).respond(),
    }
}

// ── GET /can-manage-apps ────────────────────────────────────────────────────

async fn can_manage_apps(caller: Caller) -> Response {
    let can_manage = match member_role(&caller.db, &caller.user_id).await {
        Ok(role) => is_manager(role.as_deref()),
        Err(error) => {
            tracing::error!(%error, "appstore: failed to check app management permission");
            false
        }
    };
    Data(json!({ "canManage": can_manage })).into_response()
}

// ── POST /apps/:appCode/assign-all-members ──────────────────────────────────

async fn assign_all_members(caller: Caller, Path(app_code): Path<String>) -> Response {
    let app_code = to_db_code(&app_code);
    answer(assign(&caller, &app_code).await)
}

async fn assign(caller: &Caller, app_code: &str) -> PlatformResult<Response> {
    const FAILED: &str = "Failed to assign app";
    let failed = |error: sqlx::Error| PlatformError::internal(FAILED, error);
    let role = member_role(&caller.db, &caller.user_id)
        .await
        .map_err(failed)?;
    if !is_manager(role.as_deref()) {
        return Err(ApiError::forbidden()
            .with_message("Only workspace admins can assign apps")
            .into());
    }
    let installed: Option<String> = sqlx::query_scalar(
        "select id from workspace_installed_apps
         where app_code = $1 and is_active = true and deleted_at is null limit 1",
    )
    .bind(app_code)
    .fetch_optional(&caller.db)
    .await
    .map_err(failed)?;
    if installed.is_none() {
        return Err(ApiError::not_found("Installed app", Some(app_code)).into());
    }
    let eligible: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where status = 'ACTIVE' and deleted_at is null and role <> 'OWNER' and role <> 'ADMIN'",
    )
    .fetch_all(&caller.db)
    .await
    .map_err(failed)?;
    if !eligible.is_empty() {
        let ids: Vec<String> = eligible.iter().map(|_| generate_id("uaa")).collect();
        sqlx::query(
            "insert into user_app_assignments
                 (id, user_id, app_code, is_active, granted_at, granted_by, created_at, updated_at)
             select id, user_id, $3, true, $5::timestamptz, $4, $5::timestamptz, $5::timestamptz
             from unnest($1::varchar[], $2::varchar[]) as m(id, user_id)
             on conflict do nothing",
        )
        .bind(&ids)
        .bind(&eligible)
        .bind(app_code)
        .bind(&caller.user_id)
        .bind(now())
        .execute(&caller.db)
        .await
        .map_err(failed)?;
    }
    Ok(Data(json!({ "appCode": app_code, "assignedCount": eligible.len() })).into_response())
}
