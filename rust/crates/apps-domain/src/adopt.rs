//! Adopting first-party (`system`) tenant installs onto an official hosted
//! app of WeldApps (`adoptSystemInstallInTenant` and its sweeps, `services/user-apps.ts`
//! of app-api and `services/adopt-system-install.ts` of external-api, which
//! mirrors it): app-api runs it on store reads and when an official app goes
//! live, external-api when the CLI publishes one.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::js_row;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::id::generate_id;

use crate::scopes::{NATIVE_ONLY_APP_CODES, is_native_only, is_reserved};

/// A `user_apps` row as JSON, with `price_monthly` as Drizzle reads
/// `numeric` (a string). `a` is the table's alias.
macro_rules! app_json {
    () => {
        "to_jsonb(a) || jsonb_build_object('price_monthly', a.price_monthly::text)"
    };
}

/// A row from `to_jsonb`, as Drizzle returns it.
fn row(value: Value) -> Value {
    js_row(value)
}

/// A string column of a row (`''` when missing or not a string).
fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `new Date().toISOString()`.
fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
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
) -> Result<Adoption, sqlx::Error> {
    if !is_adoptable(app) {
        return Ok(Adoption::None);
    }
    let app_id = text(app, "id");
    let tenant_row: Option<(String, bool, String, Option<String>)> = sqlx::query_as(
        "select id, is_active, app_type, user_app_id from workspace_installed_apps
         where app_code = $1 and deleted_at is null limit 1",
    )
    .bind(text(app, "code"))
    .fetch_optional(tenant)
    .await?;
    let Some((row_id, true, app_type, user_app_id)) = tenant_row else {
        return Ok(Adoption::None);
    };
    let linked = app_type == "user" && user_app_id.as_deref() == Some(app_id);
    if linked {
        let status: Option<String> = sqlx::query_scalar(
            "select status from user_app_installs where app_id = $1 and workspace_id = $2 limit 1",
        )
        .bind(app_id)
        .bind(workspace_id)
        .fetch_optional(master)
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
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, status from user_app_installs where app_id = $1 and workspace_id = $2 limit 1",
    )
    .bind(app_id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    let (bump, existing_active) = match &existing {
        Some((_, status)) if status == "active" => (false, true),
        Some((install_id, _)) => {
            sqlx::query(
                "update user_app_installs set
                   status = 'active', granted_scopes = $2::jsonb, pending_scopes = null,
                   installed_by = coalesce($3, installed_by), installed_at = $4::timestamptz,
                   revoked_at = null, updated_at = $4::timestamptz
                 where id = $1",
            )
            .bind(install_id)
            .bind(&scopes)
            .bind(installed_by)
            .bind(&now)
            .execute(master)
            .await?;
            (true, false)
        }
        None => {
            sqlx::query(
                "insert into user_app_installs
                   (id, app_id, workspace_id, status, granted_scopes, installed_by, installed_at, created_at, updated_at)
                 values ($1, $2, $3, 'active', $4::jsonb, $5, $6::timestamptz, $6::timestamptz, $6::timestamptz)",
            )
            .bind(generate_id("uai"))
            .bind(app_id)
            .bind(workspace_id)
            .bind(&scopes)
            .bind(installed_by.filter(|by| !by.is_empty()).unwrap_or("system"))
            .bind(&now)
            .execute(master)
            .await?;
            (true, false)
        }
    };
    let already_linked = linked && existing_active;

    sqlx::query(
        "update workspace_installed_apps set
           app_type = 'user', user_app_id = $2, granted_scopes = $3::jsonb, is_active = true,
           deleted_at = null, updated_at = $4::timestamptz,
           installed_by = case when $5::text is null then installed_by else $5 end
         where id = $1",
    )
    .bind(&row_id)
    .bind(app_id)
    .bind(&scopes)
    .bind(&now)
    .bind(installed_by.filter(|by| !by.is_empty()))
    .execute(tenant)
    .await?;

    if bump {
        sqlx::query(
            "update user_apps set install_count = install_count + 1, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(app_id)
        .bind(&now)
        .execute(master)
        .await?;
    }
    Ok(if already_linked {
        Adoption::Already
    } else {
        Adoption::Adopted
    })
}

/// Official public apps that could claim one of `codes` (`findOfficialAppsForCodes`).
async fn official_apps_for_codes(
    master: &PgPool,
    codes: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if codes.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        app_json!(),
        " from user_apps a
         where a.visibility = 'public' and a.review_status = 'approved' and a.is_active = true
           and a.deleted_at is null"
    ))
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(row)
        .filter(|app| {
            let code = text(app, "code");
            codes.iter().any(|c| c == code)
                && (text(app, "publisherType") == "weldsuite" || is_reserved(code))
        })
        .collect())
}

/// `adoptOfficialSystemInstallsForTenant`: on every store and installed read.
pub async fn adopt_official_system_installs(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
    installed_by: Option<&str>,
) -> Result<usize, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select app_code, app_type from workspace_installed_apps
         where is_active = true and deleted_at is null",
    )
    .fetch_all(tenant)
    .await?;
    // A native-again module adopted onto its hosted app goes back to being
    // the built-in install.
    if rows
        .iter()
        .any(|(code, app_type)| app_type == "user" && is_native_only(code))
    {
        sqlx::query(
            "update workspace_installed_apps set
               app_type = 'system', user_app_id = null, granted_scopes = null, updated_at = $1::timestamptz
             where app_code = any($2) and app_type = 'user' and deleted_at is null",
        )
        .bind(now())
        .bind(NATIVE_ONLY_APP_CODES.map(str::to_owned).to_vec())
        .execute(tenant)
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
    let rows: Vec<(String, Option<String>)> = match sqlx::query_as(
        "select id, clerk_org_id from workspaces where scheduled_deletion_at is null",
    )
    .fetch_all(&master)
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
