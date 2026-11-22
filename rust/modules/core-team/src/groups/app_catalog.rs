//! `/api/app-catalog` (`app-api/src/routes/app-catalog`, `services/app-catalog.ts`)
//! and its access requests (`routes/app-access`, `services/app-access.ts`):
//! the first-party app store.
//!
//! - `GET /`, `GET /:code`: published apps (master `app_catalog`) with whether
//!   this workspace installed them; apps on request only also carry the
//!   workspace's access status. Codes go out as the mobile app's legacy codes
//!   (`helpdesk`, `mail`) unless `?codes=canonical`.
//! - `GET /categories`, `GET /beta`.
//! - `POST /:code/install`, `DELETE /:code/install`: OWNER/ADMIN of the
//!   tenant `workspace_members` row. A partner-managed workspace installs only
//!   what its licence lists; an app on request only installs once staff
//!   approved the workspace.
//! - `GET /:code/access-request`, `POST /:code/access-request`: the
//!   workspace's request for an app on request only (WeldReach).
//!
//! No entity events, as in TypeScript. The staff email about a new access
//! request is skipped: the workers skip it without an email transport, and
//! the Rust backend has none yet (the system mail port is on its way).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::StatusCode;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, IntoCondition, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Format;
use weldsuite_kit::validation::{Issues, Number, Presence, Text, query_values};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynCache;
use weldsuite_schema::master::{
    app_catalog as catalog, partners, workspace_app_access as app_access,
    workspace_licences as licences, workspaces,
};
use weldsuite_schema::tenant::{
    workspace_installed_apps as installed, workspace_members as members,
};

use crate::access::js;
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list))
        .route("/categories", get(categories))
        .route("/beta", get(beta))
        .route("/{code}", get(detail))
        .route("/{code}/install", post(install).delete(uninstall))
        .route(
            "/{code}/access-request",
            get(access_request).post(request_access),
        )
}

// ── codes ───────────────────────────────────────────────────────────────────

/// `toDbCode`: the mobile app's legacy codes to the catalog's.
fn to_db_code(code: &str) -> String {
    match code {
        "helpdesk" => "welddesk".to_owned(),
        "mail" => "weldmail".to_owned(),
        other => other.to_owned(),
    }
}

/// `toLegacyCode`.
fn to_legacy_code(code: &str) -> String {
    match code {
        "welddesk" => "helpdesk".to_owned(),
        "weldmail" => "mail".to_owned(),
        other => other.to_owned(),
    }
}

/// `emitCode`: the raw code with `?codes=canonical`, else the legacy one.
fn emit_code(query: Option<&str>, code: &str) -> String {
    if query_values(query).get("codes").and_then(Value::as_str) == Some("canonical") {
        code.to_owned()
    } else {
        to_legacy_code(code)
    }
}

// ── reads ───────────────────────────────────────────────────────────────────

/// `or(eq(workspaces.id, ref), eq(workspaces.clerkOrgId, ref))`.
fn org_workspace(org_ref: &str) -> Condition {
    Condition::any()
        .add(workspaces::Column::Id.eq(org_ref))
        .add(workspaces::Column::ClerkOrgId.eq(org_ref))
}

/// `join(workspaceAppAccess, eq(workspaceAppAccess.workspaceId, workspaces.id))`.
fn workspace_app_access() -> sea_orm::RelationBuilder<workspaces::Entity, app_access::Entity> {
    workspaces::Entity::belongs_to(app_access::Entity)
        .from(workspaces::Column::Id)
        .to(app_access::Column::WorkspaceId)
}

/// `listAccessStatuses`: the workspace's access status per app code.
async fn access_statuses(master: &PgPool, org_ref: &str) -> Result<HashMap<String, String>, DbErr> {
    let rows: Vec<(String, String)> = workspaces::Entity::find()
        .select_only()
        .columns([app_access::Column::AppCode, app_access::Column::Status])
        .join(JoinType::InnerJoin, workspace_app_access().into())
        .filter(org_workspace(org_ref))
        .into_tuple()
        .all(&orm(master))
        .await?;
    Ok(rows.into_iter().collect())
}

async fn statuses_for(
    caller: &Caller,
    master: &PgPool,
) -> Result<Option<HashMap<String, String>>, DbErr> {
    match caller.org_id.as_deref() {
        Some(org) => Ok(Some(access_statuses(master, org).await?)),
        None => Ok(None),
    }
}

/// `toCatalogItem`.
fn catalog_item(
    app: &Value,
    installed: bool,
    statuses: Option<&HashMap<String, String>>,
    query: Option<&str>,
) -> Value {
    let code = app["code"].as_str().unwrap_or_default();
    let or_empty = |value: &Value| {
        if value.is_null() {
            json!([])
        } else {
            value.clone()
        }
    };
    let requires_approval = app["requiresApproval"].as_bool().unwrap_or(false);
    let mut item = json!({
        "id": app["id"],
        "code": emit_code(query, code),
        "name": app["name"],
        "description": app["description"],
        "icon": app["icon"],
        "category": app["category"],
        "path": app["path"],
        "overview": app["overview"],
        "features": or_empty(&app["features"]),
        "howItWorks": or_empty(&app["howItWorks"]),
        "version": app["version"],
        "provider": app["provider"],
        "isInstalled": installed,
        "verified": app["verified"],
        "releasedAt": app["releasedAt"],
        "websiteUrl": app["websiteUrl"],
        "documentationUrl": app["documentationUrl"],
        "contactUrl": app["contactUrl"],
        "requiresApproval": requires_approval,
    });
    if requires_approval {
        let status = statuses
            .and_then(|s| s.get(code))
            .map_or("none", String::as_str);
        item["accessStatus"] = json!(status);
    }
    item
}

async fn list(
    caller: Caller,
    State(state): State<CoreTeamState>,
    RawQuery(query): RawQuery,
) -> Response {
    let master = caller.master(&state);
    let result: Result<Value, DbErr> = async {
        let statuses = statuses_for(&caller, &master).await?;
        let apps = catalog::Entity::find()
            .filter(catalog::Column::IsActive.eq(true))
            .filter(catalog::Column::IsPublished.eq(true))
            .order_by_asc(catalog::Column::SortOrder)
            .all(&orm(&master))
            .await?;
        let installed: HashSet<String> = installed::Entity::find()
            .select_only()
            .column(installed::Column::AppCode)
            .filter(installed::Column::IsActive.eq(true))
            .filter(installed::Column::DeletedAt.is_null())
            .into_tuple::<String>()
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .collect();
        let mut items = Vec::with_capacity(apps.len());
        for app in apps {
            let app = js(app)?;
            let code = app["code"].as_str().unwrap_or_default();
            items.push(catalog_item(
                &app,
                installed.contains(code),
                statuses.as_ref(),
                query.as_deref(),
            ));
        }
        Ok(Value::Array(items))
    }
    .await;
    match result {
        Ok(apps) => Data(apps).into_response(),
        Err(error) => TeamError::Database(error).respond(),
    }
}

/// `localeCompare` for category names: case-insensitive first, lower case
/// before upper case on a tie.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

async fn categories(caller: Caller, State(state): State<CoreTeamState>) -> Response {
    let master = caller.master(&state);
    let rows: Result<Vec<String>, DbErr> = catalog::Entity::find()
        .select_only()
        .column(catalog::Column::Category)
        .filter(catalog::Column::IsActive.eq(true))
        .filter(catalog::Column::IsPublished.eq(true))
        .into_tuple()
        .all(&orm(&master))
        .await;
    match rows {
        Ok(rows) => {
            let mut seen = HashSet::new();
            let mut categories: Vec<String> = rows
                .into_iter()
                .filter(|c| !c.is_empty() && seen.insert(c.clone()))
                .collect();
            categories.sort_by(|a, b| locale_compare(a, b));
            Data(json!(categories)).into_response()
        }
        Err(error) => TeamError::Database(error).respond(),
    }
}

async fn beta(caller: Caller, State(state): State<CoreTeamState>) -> Response {
    let master = caller.master(&state);
    let rows: Result<Vec<String>, DbErr> = catalog::Entity::find()
        .select_only()
        .column(catalog::Column::Code)
        .filter(catalog::Column::IsActive.eq(true))
        .filter(catalog::Column::IsBeta.eq(true))
        .into_tuple()
        .all(&orm(&master))
        .await;
    match rows {
        Ok(codes) => Data(json!(codes)).into_response(),
        Err(error) => TeamError::Database(error).respond(),
    }
}

async fn published_app(master: &PgPool, code: &str) -> Result<Option<Value>, DbErr> {
    catalog::Entity::find()
        .filter(catalog::Column::Code.eq(code))
        .filter(catalog::Column::IsActive.eq(true))
        .filter(catalog::Column::IsPublished.eq(true))
        .one(&orm(master))
        .await?
        .map(js)
        .transpose()
}

/// The installation `GET /:code` adds: `{ id, installedAt, settings }`.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    id: String,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    installed_at: Option<time::OffsetDateTime>,
    settings: Option<Value>,
}

async fn detail(
    caller: Caller,
    State(state): State<CoreTeamState>,
    Path(code): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let code = to_db_code(&code);
    let master = caller.master(&state);
    let result: Result<Option<Value>, DbErr> = async {
        let statuses = statuses_for(&caller, &master).await?;
        let Some(app) = published_app(&master, &code).await? else {
            return Ok(None);
        };
        let installation = installed::Entity::find()
            .select_only()
            .columns([
                installed::Column::Id,
                installed::Column::InstalledAt,
                installed::Column::Settings,
            ])
            .filter(installed::Column::AppCode.eq(&code))
            .filter(installed::Column::IsActive.eq(true))
            .filter(installed::Column::DeletedAt.is_null())
            .into_model::<Installation>()
            .one(&orm(&caller.db))
            .await?
            .map(js)
            .transpose()?;
        let mut item = catalog_item(
            &app,
            installation.is_some(),
            statuses.as_ref(),
            query.as_deref(),
        );
        item["installation"] = installation.unwrap_or(Value::Null);
        Ok(Some(item))
    }
    .await;
    match result {
        Ok(Some(item)) => Data(item).into_response(),
        Ok(None) => ApiError::not_found("App", Some(&code)).into_response(),
        Err(error) => TeamError::Database(error).respond(),
    }
}

// ── who may install ─────────────────────────────────────────────────────────

/// `isAdminOrOwner`: the caller's live member row is OWNER or ADMIN.
async fn is_admin_or_owner(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    let role: Option<String> = members::Entity::find()
        .select_only()
        .column(members::Column::Role)
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let role = role.map(|r| r.to_uppercase());
    Ok(matches!(role.as_deref(), Some("OWNER" | "ADMIN")))
}

/// `getManagedContext`, as far as the install and request checks read it:
/// `None` for a direct workspace, else the licence's allowed apps (`None`
/// without a licence row).
async fn managed_allowed_apps(
    master: &PgPool,
    org_ref: &str,
) -> Result<Option<Option<Vec<String>>>, DbErr> {
    let db = orm(master);
    let partner: RelationDef = workspaces::Entity::belongs_to(partners::Entity)
        .from(workspaces::Column::PartnerId)
        .to(partners::Column::Id)
        .into();
    let workspace: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .join(JoinType::InnerJoin, partner)
        .filter(org_workspace(org_ref))
        .filter(workspaces::Column::BillingMode.eq("partner"))
        .into_tuple()
        .one(&db)
        .await?;
    let Some(workspace) = workspace else {
        return Ok(None);
    };
    let allowed: Option<Value> = licences::Entity::find()
        .select_only()
        .column(licences::Column::AllowedApps)
        .filter(licences::Column::WorkspaceId.eq(&workspace))
        .into_tuple()
        .one(&db)
        .await?;
    Ok(Some(allowed.map(|apps| {
        apps.as_array()
            .map(|codes| {
                codes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    })))
}

/// `appNotLicensedBody(app)` with 403.
fn not_licensed(app: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(json!({
            "error": {
                "code": "APP_NOT_LICENSED",
                "message": format!("This workspace is not licensed for {app}."),
                "details": { "app": app },
            }
        })),
    )
        .into_response()
}

/// The licence check of a partner-managed workspace; `Some(403)` refuses.
async fn licence_refusal(
    master: &PgPool,
    org_ref: Option<&str>,
    app_code: &str,
) -> Result<Option<Response>, DbErr> {
    let Some(org) = org_ref else {
        return Ok(None);
    };
    match managed_allowed_apps(master, org).await? {
        Some(allowed)
            if !allowed
                .as_ref()
                .is_some_and(|apps| apps.iter().any(|a| a == app_code)) =>
        {
            Ok(Some(not_licensed(app_code)))
        }
        _ => Ok(None),
    }
}

/// `checkInstallAccess`: `Some(status)` when an app on request only is not
/// approved for the workspace.
async fn missing_access(
    master: &PgPool,
    org_ref: Option<&str>,
    app_code: &str,
) -> Result<Option<String>, DbErr> {
    let requires: Option<bool> = catalog::Entity::find()
        .select_only()
        .column(catalog::Column::RequiresApproval)
        .filter(catalog::Column::Code.eq(app_code))
        .into_tuple()
        .one(&orm(master))
        .await?;
    if requires != Some(true) {
        return Ok(None);
    }
    let Some(org) = org_ref else {
        return Ok(Some("none".to_owned()));
    };
    let status = workspace_access(master, org, app_code)
        .await?
        .and_then(|found| found.access)
        .and_then(|row| row["status"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "none".to_owned());
    Ok((status != "approved").then_some(status))
}

// ── POST|DELETE /:code/install ──────────────────────────────────────────────

/// `JSON.stringify`-style `trim()`: whitespace and the BOM.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The optional `{ settings }` body (`installCatalogAppSchema`).
fn install_settings(body: &Bytes) -> TeamResult<Option<Value>> {
    let raw = String::from_utf8_lossy(body);
    if js_trim(&raw).is_empty() {
        return Ok(None);
    }
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return Err(ApiError::bad_request("Invalid JSON body").into());
    };
    let problem = match &json {
        Value::Object(fields) => match fields.get("settings") {
            None | Some(Value::Object(_)) => None,
            Some(other) => Some((Some("settings"), other)),
        },
        other => Some((None, other)),
    };
    if let Some((field, value)) = problem {
        let message = format!("Expected object, received {}", js_type(value));
        let flattened = match field {
            Some(field) => json!({ "formErrors": [], "fieldErrors": { field: [message] } }),
            None => json!({ "formErrors": [message], "fieldErrors": {} }),
        };
        return Err(ApiError::bad_request("Invalid install payload")
            .with_details(flattened)
            .into());
    }
    Ok(json.get("settings").cloned())
}

/// Zod's name for a value's type.
fn js_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

async fn install(
    caller: Caller,
    State(state): State<CoreTeamState>,
    Path(code): Path<String>,
    body: Bytes,
) -> Response {
    answer(install_app(&caller, &state, &to_db_code(&code), &body).await)
}

async fn install_app(
    caller: &Caller,
    state: &CoreTeamState,
    app_code: &str,
    body: &Bytes,
) -> TeamResult<Response> {
    let master = caller.master(state);
    if !is_admin_or_owner(&caller.db, &caller.user_id).await? {
        return Err(ApiError::forbidden()
            .with_message("Only workspace admins can install apps")
            .into());
    }
    let org = caller.org_id.as_deref();
    if let Some(refusal) = licence_refusal(&master, org, app_code).await? {
        return Ok(refusal);
    }
    if let Some(status) = missing_access(&master, org, app_code).await? {
        return Ok((
            StatusCode::FORBIDDEN,
            axum::Json(json!({
                "error": {
                    "code": "APP_ACCESS_REQUIRED",
                    "message": format!("This workspace has no approved access to {app_code}."),
                    "details": { "appCode": app_code, "status": status },
                }
            })),
        )
            .into_response());
    }
    let settings = install_settings(body)?;

    let listed: Option<String> = catalog::Entity::find()
        .select_only()
        .column(catalog::Column::Code)
        .filter(catalog::Column::Code.eq(app_code))
        .filter(catalog::Column::IsActive.eq(true))
        .filter(catalog::Column::IsPublished.eq(true))
        .into_tuple()
        .one(&orm(&master))
        .await?;
    if listed.is_none() {
        return Err(ApiError::not_found("App", Some(app_code)).into());
    }

    let row = js(store_install(caller, app_code, settings).await?)?;
    Ok(Created(json!({
        "id": row["id"],
        "appCode": row["appCode"],
        "isActive": row["isActive"],
        "displayOrder": row["displayOrder"],
        "settings": row["settings"],
        "installedAt": row["installedAt"],
    }))
    .into_response())
}

/// The install's write: the app's row reactivated, or a new one at the end
/// of the order.
async fn store_install(
    caller: &Caller,
    app_code: &str,
    settings: Option<Value>,
) -> Result<installed::Model, DbErr> {
    let db = orm(&caller.db);
    let max_order: Option<Option<i32>> = installed::Entity::find()
        .select_only()
        .column_as(installed::Column::DisplayOrder.max(), "max")
        .into_tuple()
        .one(&db)
        .await?;
    let next_order = max_order.flatten().unwrap_or(-1) + 1;
    let existing: Option<String> = installed::Entity::find()
        .select_only()
        .column(installed::Column::Id)
        .filter(installed::Column::AppCode.eq(app_code))
        .into_tuple()
        .one(&db)
        .await?;
    let stamp = utc_now().assume_utc();
    if let Some(id) = existing {
        let mut update = installed::Entity::update_many()
            .col_expr(installed::Column::IsActive, Expr::value(true))
            .col_expr(
                installed::Column::DeletedAt,
                Expr::value(Option::<time::OffsetDateTime>::None),
            );
        if let Some(settings) = settings {
            update = update.col_expr(installed::Column::Settings, Expr::value(settings));
        }
        return update
            .col_expr(installed::Column::InstalledAt, Expr::value(stamp))
            .col_expr(installed::Column::InstalledBy, Expr::value(&caller.user_id))
            .col_expr(installed::Column::UpdatedAt, Expr::value(stamp))
            .filter(installed::Column::Id.eq(&id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("workspace_installed_apps".to_owned()));
    }
    installed::Entity::insert(installed::ActiveModel {
        id: Set(generate_id("wia")),
        app_code: Set(app_code.to_owned()),
        is_active: Set(true),
        display_order: Set(Some(next_order)),
        settings: Set(Some(settings.unwrap_or_else(|| json!({})))),
        installed_at: Set(Some(stamp)),
        installed_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await
}

async fn uninstall(caller: Caller, Path(code): Path<String>) -> Response {
    let app_code = to_db_code(&code);
    let result: TeamResult<Response> = async {
        if !is_admin_or_owner(&caller.db, &caller.user_id).await? {
            return Err(ApiError::forbidden()
                .with_message("Only workspace admins can uninstall apps")
                .into());
        }
        let db = orm(&caller.db);
        let found: Option<String> = installed::Entity::find()
            .select_only()
            .column(installed::Column::Id)
            .filter(installed::Column::AppCode.eq(&app_code))
            .filter(installed::Column::IsActive.eq(true))
            .filter(installed::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&db)
            .await?;
        let Some(id) = found else {
            return Err(ApiError::not_found("Installed app", Some(&app_code)).into());
        };
        let stamp = utc_now().assume_utc();
        installed::Entity::update_many()
            .col_expr(installed::Column::IsActive, Expr::value(false))
            .col_expr(installed::Column::DeletedAt, Expr::value(stamp))
            .col_expr(installed::Column::UpdatedAt, Expr::value(stamp))
            .filter(installed::Column::Id.eq(&id))
            .exec(&db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    answer(result)
}

// ── access requests ─────────────────────────────────────────────────────────

/// `WELDREACH_APP_CODE`, `WELDREACH_TERMS_VERSION`, `WELDREACH_TERMS` and
/// `WELDREACH_DEFAULT_LIMITS` (`@weldsuite/app-api-client/schemas/reach`).
const WELDREACH: &str = "weldreach";
const WELDREACH_TERMS_VERSION: &str = "weldreach-2026-10b";
const WELDREACH_TERMS: [&str; 7] = [
    "b2b_only",
    "comply_with_law",
    "identify_and_opt_out",
    "lawful_lists",
    "suspension",
    "responsible_for_content",
    "warmup_network",
];

fn weldreach_default_limits() -> Value {
    json!({
        "maxDomains": 3,
        "maxMailboxes": 10,
        "maxDailySends": 300,
        "allowConsumerRecipients": false,
        "forceAllowDomains": [],
    })
}

/// The statuses in which a new request is refused.
const OPEN_STATUSES: [&str; 3] = ["requested", "approved", "suspended"];

struct WorkspaceAccess {
    workspace_id: String,
    workspace_name: String,
    /// The `workspace_app_access` row (camelCase), when the workspace asked.
    access: Option<Value>,
}

/// The workspace's id and name, beside its access row.
#[derive(Debug, FromQueryResult)]
struct WorkspaceRef {
    id: String,
    name: String,
}

/// `getWorkspaceAccess`: the master workspace behind the org and its row
/// for the app.
async fn workspace_access(
    master: &PgPool,
    org_ref: &str,
    app_code: &str,
) -> Result<Option<WorkspaceAccess>, DbErr> {
    let code = app_code.to_owned();
    // `left join workspace_app_access on workspace_id = workspaces.id and app_code = $code`.
    let for_app: RelationDef = workspace_app_access()
        .on_condition(move |_, _| {
            app_access::Column::AppCode
                .eq(code.clone())
                .into_condition()
        })
        .into();
    let row = workspaces::Entity::find()
        .select_only()
        .columns([workspaces::Column::Id, workspaces::Column::Name])
        .select_also(app_access::Entity)
        .join(JoinType::LeftJoin, for_app)
        .filter(org_workspace(org_ref))
        .into_model::<WorkspaceRef, app_access::Model>()
        .one(&orm(master))
        .await?;
    let Some((workspace, access)) = row else {
        return Ok(None);
    };
    Ok(Some(WorkspaceAccess {
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        access: access.map(js).transpose()?,
    }))
}

/// `toAppAccessView`: what the workspace sees; staff notes and billing stay out.
fn access_view(row: &Value) -> Value {
    let request = &row["request"];
    let request = if request.is_object() {
        let mut view = Map::new();
        for key in [
            "companyName",
            "website",
            "contactName",
            "contactEmail",
            "useCase",
            "expectedDailySends",
            "targetCountries",
            "listSource",
        ] {
            view.insert(key.to_owned(), request[key].clone());
        }
        if truthy(&request["listSourceDetails"]) {
            view.insert(
                "listSourceDetails".to_owned(),
                request["listSourceDetails"].clone(),
            );
        }
        for key in [
            "termsVersion",
            "termsAccepted",
            "termsAcceptedAt",
            "termsAcceptedBy",
        ] {
            view.insert(key.to_owned(), request[key].clone());
        }
        Value::Object(view)
    } else {
        Value::Null
    };
    json!({
        "appCode": row["appCode"],
        "status": row["status"],
        "request": request,
        "limits": row["limits"],
        "rejectionReason": row["rejectionReason"],
        "suspendedReason": row["suspendedReason"],
        "requestedAt": row["requestedAt"],
        "reviewedAt": row["reviewedAt"],
    })
}

/// JavaScript truthiness of a JSON value (a non-empty string, here).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

async fn access_request(
    caller: Caller,
    State(state): State<CoreTeamState>,
    Path(code): Path<String>,
) -> Response {
    let Some(org) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    let app_code = to_db_code(&code);
    let master = caller.master(&state);
    match workspace_access(&master, &org, &app_code).await {
        Ok(found) => Data(
            found
                .and_then(|found| found.access)
                .map_or(Value::Null, |row| access_view(&row)),
        )
        .into_response(),
        Err(error) => TeamError::Database(error).respond(),
    }
}

/// `z.string().trim().length(2).toUpperCase()`.
fn country_code(issues: &mut Issues, item: &Value) -> Option<String> {
    const EXACTLY: &str = "String must contain exactly 2 character(s)";
    let from = issues.count();
    let code = issues.item_text(item, Text::trimmed(Some(2), Some(2)));
    issues.custom_message(from, "too_small", EXACTLY);
    issues.custom_message(from, "too_big", EXACTLY);
    code.map(|code| code.to_uppercase())
}

/// `appAccessRequestInputSchema`, read in its field order.
fn read_request(issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let trimmed = |min, max| Text::trimmed(min, max);
    let company = issues.text_with(
        body,
        "companyName",
        Presence::Required,
        trimmed(Some(1), Some(200)),
    );
    let website = issues.text_with(
        body,
        "website",
        Presence::Required,
        trimmed(Some(1), Some(300)),
    );
    let contact = issues.text_with(
        body,
        "contactName",
        Presence::Required,
        trimmed(Some(1), Some(200)),
    );
    let email = issues.text_with(
        body,
        "contactEmail",
        Presence::Required,
        Text {
            format: Some(Format::Email),
            ..trimmed(None, Some(320))
        },
    );
    let use_case = issues.text_with(
        body,
        "useCase",
        Presence::Required,
        trimmed(Some(10), Some(4000)),
    );
    let sends = issues.whole_number(
        body,
        "expectedDailySends",
        Presence::Required,
        Number {
            int: true,
            min: Some(1.0),
            max: Some(100_000.0),
            ..Number::default()
        },
    );
    let countries = issues.list(
        body,
        "targetCountries",
        Presence::Required,
        Some(1),
        Some(250),
        country_code,
    );
    let source = issues.choice(
        body,
        "listSource",
        Presence::Required,
        &["own_customers", "own_research", "bought_list", "other"],
    );
    let details = issues.text_with(
        body,
        "listSourceDetails",
        Presence::Optional,
        trimmed(None, Some(2000)),
    );
    let version = issues.text_with(
        body,
        "termsVersion",
        Presence::Required,
        Text::length(Some(1), Some(50)),
    );
    let accepted = issues.list(
        body,
        "termsAccepted",
        Presence::Required,
        Some(1),
        None,
        |issues, item| issues.item_text(item, Text::length(Some(1), Some(50))),
    );
    let mut input = json!({
        "companyName": company.into_option(),
        "website": website.into_option(),
        "contactName": contact.into_option(),
        "contactEmail": email.into_option(),
        "useCase": use_case.into_option(),
        "expectedDailySends": sends.into_option(),
        "targetCountries": countries.into_option(),
        "listSource": source.into_option(),
        "termsVersion": version.into_option(),
        "termsAccepted": accepted.into_option(),
    });
    if let Some(details) = details.into_option() {
        input["listSourceDetails"] = json!(details);
    }
    input
}

/// `validateTerms`: WeldReach needs the current version and every term.
fn terms_problem(app_code: &str, input: &Value) -> Option<String> {
    if app_code != WELDREACH {
        return None;
    }
    if input["termsVersion"] != WELDREACH_TERMS_VERSION {
        return Some(format!(
            "The terms have changed. Accept version {WELDREACH_TERMS_VERSION}."
        ));
    }
    let accepted: Vec<&str> = input["termsAccepted"]
        .as_array()
        .map(|terms| terms.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let missing: Vec<&str> = WELDREACH_TERMS
        .iter()
        .copied()
        .filter(|term| !accepted.contains(term))
        .collect();
    (!missing.is_empty()).then(|| {
        format!(
            "Every term must be accepted. Missing: {}.",
            missing.join(", ")
        )
    })
}

async fn request_access(
    caller: Caller,
    State(state): State<CoreTeamState>,
    Path(code): Path<String>,
    body: Bytes,
) -> Response {
    let Some(org) = caller.org_id.clone() else {
        return ApiError::org_required().into_response();
    };
    answer(file_request(&caller, &state, &org, &to_db_code(&code), &body).await)
}

async fn file_request(
    caller: &Caller,
    state: &CoreTeamState,
    org: &str,
    app_code: &str,
    body: &Bytes,
) -> TeamResult<Response> {
    let master = caller.master(state);
    if !is_admin_or_owner(&caller.db, &caller.user_id).await? {
        return Err(ApiError::forbidden()
            .with_message("Only workspace admins can request access to an app")
            .into());
    }
    let requestable: Option<String> = catalog::Entity::find()
        .select_only()
        .column(catalog::Column::Id)
        .filter(catalog::Column::Code.eq(app_code))
        .filter(catalog::Column::IsActive.eq(true))
        .filter(catalog::Column::RequiresApproval.eq(true))
        .into_tuple()
        .one(&orm(&master))
        .await?;
    if requestable.is_none() {
        return Err(ApiError::not_found("App", Some(app_code)).into());
    }
    if let Some(refusal) = licence_refusal(&master, Some(org), app_code).await? {
        return Ok(refusal);
    }
    let input = parse_request(app_code, body)?;
    let Some(found) = workspace_access(&master, org, app_code).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    if let Some(existing) = &found.access {
        let status = existing["status"].as_str().unwrap_or_default();
        if OPEN_STATUSES.contains(&status) {
            return Ok(exists(app_code, status));
        }
    }

    let Some(row) = store_request(&master, &found, app_code, input, &caller.user_id).await? else {
        return Ok(exists(app_code, "requested"));
    };

    // The module workers cache the status for 60 s.
    if let Some(cache) = caller.cache(state)
        && let Err(error) =
            DynCache::delete_boxed(&*cache, &format!("appaccess:{org}:{app_code}")).await
    {
        tracing::warn!(%error, "app-access: cache delete failed");
    }
    tracing::debug!(
        app_code,
        workspace = found.workspace_id,
        workspace_name = found.workspace_name,
        "app-access: no email transport; skipping the staff notification"
    );
    Ok(Created(access_view(&row)).into_response())
}

/// The body: JSON, then the schema (400 with `flatten()`), then the terms.
fn parse_request(app_code: &str, body: &Bytes) -> TeamResult<Value> {
    let Ok(json) = serde_json::from_slice::<Value>(body) else {
        return Err(ApiError::bad_request("Invalid JSON body").into());
    };
    let mut issues = Issues::default();
    let input = issues
        .object(&json)
        .map(|fields| read_request(&mut issues, fields));
    if let Err(invalid) = issues.finish() {
        return Err(ApiError::bad_request("Invalid access request")
            .with_details(invalid.flatten())
            .into());
    }
    let input = input.unwrap_or(Value::Null);
    if let Some(problem) = terms_problem(app_code, &input) {
        return Err(ApiError::bad_request(problem).into());
    }
    Ok(input)
}

/// `requestAppAccess`'s write: a first request, or a new one after a
/// rejection or revocation. `None` when a concurrent request won.
async fn store_request(
    master: &PgPool,
    found: &WorkspaceAccess,
    app_code: &str,
    input: Value,
    user_id: &str,
) -> Result<Option<Value>, DbErr> {
    let at = utc_now().assume_utc();
    let mut request = input;
    request["termsAcceptedAt"] = json!(iso_timestamp(at));
    request["termsAcceptedBy"] = json!(user_id);

    let db = orm(master);
    let row = match &found.access {
        None => {
            let limits = if app_code == WELDREACH {
                weldreach_default_limits()
            } else {
                json!({})
            };
            app_access::Entity::insert(app_access::ActiveModel {
                id: Set(generate_id("waa")),
                workspace_id: Set(found.workspace_id.clone()),
                app_code: Set(app_code.to_owned()),
                status: Set("requested".to_owned()),
                request: Set(Some(request)),
                limits: Set(limits),
                requested_by: Set(Some(user_id.to_owned())),
                requested_at: Set(Some(at)),
                created_at: Set(at),
                updated_at: Set(at),
                ..Default::default()
            })
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_with_returning_many(&db)
            .await?
        }
        Some(existing) => {
            let cleared = || Expr::value(Option::<String>::None);
            app_access::Entity::update_many()
                .col_expr(app_access::Column::Status, Expr::value("requested"))
                .col_expr(app_access::Column::Request, Expr::value(request))
                .col_expr(app_access::Column::RequestedBy, Expr::value(user_id))
                .col_expr(app_access::Column::RequestedAt, Expr::value(at))
                .col_expr(app_access::Column::ReviewedBy, cleared())
                .col_expr(
                    app_access::Column::ReviewedAt,
                    Expr::value(Option::<time::OffsetDateTime>::None),
                )
                .col_expr(app_access::Column::RejectionReason, cleared())
                .col_expr(app_access::Column::SuspendedReason, cleared())
                .col_expr(app_access::Column::UpdatedAt, Expr::value(at))
                .filter(app_access::Column::Id.eq(existing["id"].as_str().unwrap_or_default()))
                .filter(app_access::Column::Status.is_in(["rejected", "revoked"]))
                .exec_with_returning(&db)
                .await?
        }
    };
    row.into_iter().next().map(js).transpose()
}

/// 409 `APP_ACCESS_EXISTS`.
fn exists(app_code: &str, status: &str) -> Response {
    (
        StatusCode::CONFLICT,
        axum::Json(json!({
            "error": {
                "code": "APP_ACCESS_EXISTS",
                "message": format!("Access to {app_code} is already {status}."),
                "details": { "appCode": app_code, "status": status },
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_translate_both_ways() {
        assert_eq!(to_db_code("helpdesk"), "welddesk");
        assert_eq!(emit_code(None, "weldmail"), "mail");
        assert_eq!(emit_code(Some("codes=canonical"), "weldmail"), "weldmail");
        assert_eq!(emit_code(Some("codes=legacy"), "weldcrm"), "weldcrm");
    }

    #[test]
    fn weldreach_needs_the_current_terms() {
        let mut input = json!({ "termsVersion": "old", "termsAccepted": WELDREACH_TERMS });
        assert!(terms_problem("weldreach", &input).is_some_and(|p| p.contains("have changed")));
        input["termsVersion"] = json!(WELDREACH_TERMS_VERSION);
        assert_eq!(terms_problem("weldreach", &input), None);
        input["termsAccepted"] = json!(["b2b_only"]);
        assert!(terms_problem("weldreach", &input).is_some_and(|p| p.contains("lawful_lists")));
        assert_eq!(terms_problem("weldother", &input), None);
    }

    #[test]
    fn install_bodies_follow_the_schema() {
        assert_eq!(
            install_settings(&Bytes::from_static(b"  ")).ok(),
            Some(None)
        );
        assert!(install_settings(&Bytes::from_static(b"nope")).is_err());
        assert!(install_settings(&Bytes::from_static(b"{\"settings\":[]}")).is_err());
        assert_eq!(
            install_settings(&Bytes::from_static(b"{\"settings\":{\"a\":1}}")).ok(),
            Some(Some(json!({ "a": 1 })))
        );
    }
}
