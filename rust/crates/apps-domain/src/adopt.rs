//! Adopting first-party (`system`) tenant installs onto an official hosted
//! app of WeldApps (`adoptSystemInstallInTenant` and its sweeps, `services/user-apps.ts`
//! of app-api and `services/adopt-system-install.ts` of external-api, which
//! mirrors it): app-api runs it on store reads and when an official app goes
//! live, external-api when the CLI publishes one.

use std::sync::Arc;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, Set};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_kit::id::generate_id;
use weldsuite_schema::master::{user_app_installs, user_apps, workspaces};
use weldsuite_schema::tenant::workspace_installed_apps;

use crate::scopes::{NATIVE_ONLY_APP_CODES, is_native_only, is_reserved};

/// A string column of a row (`''` when missing or not a string).
fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `new Date()` as Drizzle writes it to a `timestamptz` column: to the
/// millisecond.
fn now() -> OffsetDateTime {
    weldsuite_db::utc_now().assume_utc()
}

/// A public and approved app's bundle is open to anyone.
pub fn is_publicly_servable(visibility: &str, review_status: &str) -> bool {
    visibility == "public" && review_status == "approved"
}

// ── first-party → hosted app adoption ────────────────────────────────────────

/// What adopting one app in one tenant did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adoption {
    Adopted,
    Already,
    None,
}

/// Approved, public, live, official (or a reserved first-party code).
fn is_adoptable(app: &Value) -> bool {
    if !app["deletedAt"].is_null() || app["isActive"] != Value::Bool(true) {
        return false;
    }
    if !is_publicly_servable(text(app, "visibility"), text(app, "reviewStatus")) {
        return false;
    }
    let code = text(app, "code");
    !is_native_only(code) && (text(app, "publisherType") == "weldsuite" || is_reserved(code))
}

/// `adoptSystemInstallInTenant`.
#[allow(clippy::too_many_lines)] // the service's steps, in the TypeScript order
pub async fn adopt_system_install(
    master: &PgPool,
    tenant: &PgPool,
    app: &Value,
    workspace_id: &str,
    installed_by: Option<&str>,
) -> Result<Adoption, DbErr> {
    if !is_adoptable(app) {
        return Ok(Adoption::None);
    }
    let (master, tenant) = (orm(master), orm(tenant));
    let app_id = text(app, "id");
    let tenant_row: Option<(String, bool, String, Option<String>)> = {
        use workspace_installed_apps::Column;
        workspace_installed_apps::Entity::find()
            .select_only()
            .columns([Column::Id, Column::IsActive, Column::AppType, Column::UserAppId])
            .filter(Column::AppCode.eq(text(app, "code")))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&tenant)
            .await?
    };
    let Some((row_id, true, app_type, user_app_id)) = tenant_row else {
        return Ok(Adoption::None);
    };
    let linked = app_type == "user" && user_app_id.as_deref() == Some(app_id);
    if linked {
        let status: Option<String> = user_app_installs::Entity::find()
            .select_only()
            .column(user_app_installs::Column::Status)
            .filter(user_app_installs::Column::AppId.eq(app_id))
            .filter(user_app_installs::Column::WorkspaceId.eq(workspace_id))
            .into_tuple()
            .one(&master)
            .await?;
        if status.as_deref() == Some("active") {
            return Ok(Adoption::Already);
        }
    } else if app_type == "user" && user_app_id.as_deref().is_some_and(|id| !id.is_empty()) {
        // Another hosted app owns this sidenav code.
        return Ok(Adoption::None);
    } else if app_type != "system" && app_type != "user" {
        return Ok(Adoption::None);
    }

    let scopes = app
        .get("requestedScopes")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!([]));
    let now = now();
    let existing: Option<(String, String)> = user_app_installs::Entity::find()
        .select_only()
        .columns([
            user_app_installs::Column::Id,
            user_app_installs::Column::Status,
        ])
        .filter(user_app_installs::Column::AppId.eq(app_id))
        .filter(user_app_installs::Column::WorkspaceId.eq(workspace_id))
        .into_tuple()
        .one(&master)
        .await?;
    let (bump, existing_active) = match &existing {
        Some((_, status)) if status == "active" => (false, true),
        Some((install_id, _)) => {
            use user_app_installs::Column;
            let mut update = user_app_installs::Entity::update_many()
                .col_expr(Column::Status, Expr::value("active"))
                .col_expr(Column::GrantedScopes, Expr::value(scopes.clone()))
                .col_expr(Column::PendingScopes, Expr::value(Option::<Value>::None));
            // `coalesce($installedBy, installed_by)`.
            if let Some(by) = installed_by {
                update = update.col_expr(Column::InstalledBy, Expr::value(by));
            }
            update
                .col_expr(Column::InstalledAt, Expr::value(now))
                .col_expr(Column::RevokedAt, Expr::value(Option::<OffsetDateTime>::None))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(install_id))
                .exec(&master)
                .await?;
            (true, false)
        }
        None => {
            user_app_installs::Entity::insert(user_app_installs::ActiveModel {
                id: Set(generate_id("uai")),
                app_id: Set(app_id.to_owned()),
                workspace_id: Set(workspace_id.to_owned()),
                status: Set("active".to_owned()),
                granted_scopes: Set(Some(scopes.clone())),
                installed_by: Set(installed_by
                    .filter(|by| !by.is_empty())
                    .unwrap_or("system")
                    .to_owned()),
                installed_at: Set(now),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&master)
            .await?;
            (true, false)
        }
    };
    let already_linked = linked && existing_active;

    {
        use workspace_installed_apps::Column;
        let mut update = workspace_installed_apps::Entity::update_many()
            .col_expr(Column::AppType, Expr::value("user"))
            .col_expr(Column::UserAppId, Expr::value(app_id))
            .col_expr(Column::GrantedScopes, Expr::value(scopes))
            .col_expr(Column::IsActive, Expr::value(true))
            .col_expr(Column::DeletedAt, Expr::value(Option::<OffsetDateTime>::None))
            .col_expr(Column::UpdatedAt, Expr::value(now));
        // `case when $installedBy is null then installed_by else $installedBy end`.
        if let Some(by) = installed_by.filter(|by| !by.is_empty()) {
            update = update.col_expr(Column::InstalledBy, Expr::value(by));
        }
        update.filter(Column::Id.eq(row_id)).exec(&tenant).await?;
    }

    if bump {
        use sea_orm::ExprTrait as _;
        user_apps::Entity::update_many()
            .col_expr(
                user_apps::Column::InstallCount,
                Expr::col(user_apps::Column::InstallCount).add(1),
            )
            .col_expr(user_apps::Column::UpdatedAt, Expr::value(now))
            .filter(user_apps::Column::Id.eq(app_id))
            .exec(&master)
            .await?;
    }
    Ok(if already_linked {
        Adoption::Already
    } else {
        Adoption::Adopted
    })
}

/// Official public apps that could claim one of `codes` (`findOfficialAppsForCodes`),
/// as Drizzle returns their rows.
async fn official_apps_for_codes(master: &PgPool, codes: &[String]) -> Result<Vec<Value>, DbErr> {
    use user_apps::Column;
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let apps = user_apps::Entity::find()
        .filter(Column::Visibility.eq("public"))
        .filter(Column::ReviewStatus.eq("approved"))
        .filter(Column::IsActive.eq(true))
        .filter(Column::DeletedAt.is_null())
        .all(&orm(master))
        .await?;
    let mut out = Vec::new();
    for app in apps {
        let code = app.code.as_str();
        if codes.iter().any(|c| c == code)
            && (app.publisher_type == "weldsuite" || is_reserved(code))
        {
            out.push(serde_json::to_value(app).map_err(|error| DbErr::Json(error.to_string()))?);
        }
    }
    Ok(out)
}

/// `adoptOfficialSystemInstallsForTenant`: on every store and installed read.
pub async fn adopt_official_system_installs(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
    installed_by: Option<&str>,
) -> Result<usize, DbErr> {
    use workspace_installed_apps::Column;
    let tenant_orm = orm(tenant);
    let rows: Vec<(String, String)> = workspace_installed_apps::Entity::find()
        .select_only()
        .columns([Column::AppCode, Column::AppType])
        .filter(Column::IsActive.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&tenant_orm)
        .await?;
    // A native-again module adopted onto its hosted app goes back to being
    // the built-in install.
    if rows
        .iter()
        .any(|(code, app_type)| app_type == "user" && is_native_only(code))
    {
        workspace_installed_apps::Entity::update_many()
            .col_expr(Column::AppType, Expr::value("system"))
            .col_expr(Column::UserAppId, Expr::value(Option::<String>::None))
            .col_expr(Column::GrantedScopes, Expr::value(Option::<Value>::None))
            .col_expr(Column::UpdatedAt, Expr::value(now()))
            .filter(Column::AppCode.is_in(NATIVE_ONLY_APP_CODES))
            .filter(Column::AppType.eq("user"))
            .filter(Column::DeletedAt.is_null())
            .exec(&tenant_orm)
            .await?;
    }
    let mut codes: Vec<String> = Vec::new();
    for (code, _) in rows {
        if !is_native_only(&code) && !codes.contains(&code) {
            codes.push(code);
        }
    }
    let mut adopted = 0;
    for app in official_apps_for_codes(master, &codes).await? {
        if adopt_system_install(master, tenant, &app, workspace_id, installed_by).await?
            == Adoption::Adopted
        {
            adopted += 1;
        }
    }
    Ok(adopted)
}

/// `sweepAdoptSystemInstallsForApp`: every provisioned workspace, after an
/// official app goes live. Fire-and-forget; failures are counted and logged.
pub async fn sweep_adopt_system_installs(
    master: PgPool,
    workspaces: Arc<weldsuite_db::Workspaces>,
    app: Value,
    installed_by: String,
) {
    let code = text(&app, "code").to_owned();
    if is_native_only(&code) || (text(&app, "publisherType") != "weldsuite" && !is_reserved(&code))
    {
        return;
    }
    let rows: Vec<(String, Option<String>)> = match workspaces::Entity::find()
        .select_only()
        .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
        .filter(workspaces::Column::ScheduledDeletionAt.is_null())
        .into_tuple()
        .all(&orm(&master))
        .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "apps: adopt sweep could not list workspaces");
            return;
        }
    };
    let (mut adopted, mut failed) = (0, 0);
    for (workspace_id, clerk_org_id) in rows {
        let reference = clerk_org_id
            .filter(|org| !org.is_empty())
            .unwrap_or_else(|| workspace_id.clone());
        let result = match workspaces.tenant(&reference).await {
            Ok(tenant) => adopt_system_install(
                &master,
                &tenant.db,
                &app,
                &workspace_id,
                Some(&installed_by),
            )
            .await
            .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(Adoption::Adopted) => adopted += 1,
            Ok(_) => {}
            Err(error) => {
                failed += 1;
                tracing::error!(
                    error,
                    workspace_id,
                    "apps: adopt sweep failed for a workspace"
                );
            }
        }
    }
    tracing::info!(code, adopted, failed, "apps: adopt sweep done");
}
