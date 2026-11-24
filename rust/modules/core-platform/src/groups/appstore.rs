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
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::json;
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{user_app_assignments, workspace_installed_apps, workspace_members};

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer};

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
async fn member_role(db: &PgPool, user_id: &str) -> Result<Option<String>, DbErr> {
    workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Role)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

fn is_manager(role: Option<&str>) -> bool {
    matches!(role, Some("OWNER" | "ADMIN"))
}

// ── GET /my-apps ────────────────────────────────────────────────────────────

async fn my_apps(caller: Caller) -> Response {
    let codes: Result<Vec<String>, DbErr> = user_app_assignments::Entity::find()
        .select_only()
        .column(user_app_assignments::Column::AppCode)
        .filter(user_app_assignments::Column::UserId.eq(&caller.user_id))
        .filter(user_app_assignments::Column::IsActive.eq(true))
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    match codes {
        Ok(codes) => Data(codes).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch apps", error).respond(),
    }
}

// ── GET /installed-apps ─────────────────────────────────────────────────────

async fn installed_apps(caller: Caller) -> Response {
    let rows = workspace_installed_apps::Entity::find()
        .filter(workspace_installed_apps::Column::IsActive.eq(true))
        .filter(workspace_installed_apps::Column::DeletedAt.is_null())
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
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
    let failed = |error: DbErr| PlatformError::internal(FAILED, error);
    let role = member_role(&caller.db, &caller.user_id)
        .await
        .map_err(failed)?;
    if !is_manager(role.as_deref()) {
        return Err(ApiError::forbidden()
            .with_message("Only workspace admins can assign apps")
            .into());
    }
    let db = orm(&caller.db);
    let installed: Option<String> = workspace_installed_apps::Entity::find()
        .select_only()
        .column(workspace_installed_apps::Column::Id)
        .filter(workspace_installed_apps::Column::AppCode.eq(app_code))
        .filter(workspace_installed_apps::Column::IsActive.eq(true))
        .filter(workspace_installed_apps::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await
        .map_err(failed)?;
    if installed.is_none() {
        return Err(ApiError::not_found("Installed app", Some(app_code)).into());
    }
    let eligible: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(workspace_members::Column::Role.ne("OWNER"))
        .filter(workspace_members::Column::Role.ne("ADMIN"))
        .into_tuple()
        .all(&db)
        .await
        .map_err(failed)?;
    if !eligible.is_empty() {
        let at = utc_now().assume_utc();
        let rows = eligible
            .iter()
            .map(|user_id| user_app_assignments::ActiveModel {
                id: Set(generate_id("uaa")),
                user_id: Set(user_id.clone()),
                app_code: Set(app_code.to_owned()),
                is_active: Set(true),
                granted_at: Set(Some(at)),
                granted_by: Set(Some(caller.user_id.clone())),
                created_at: Set(at),
                updated_at: Set(at),
                ..Default::default()
            });
        user_app_assignments::Entity::insert_many(rows)
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(&db)
            .await
            .map_err(failed)?;
    }
    Ok(Data(json!({ "appCode": app_code, "assignedCount": eligible.len() })).into_response())
}
