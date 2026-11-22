//! `/api/roles` (`app-api/src/routes/roles/index.ts`, `services/roles.ts`):
//! the four system roles and the workspace's custom roles, each carrying
//! permissions and app grants.
//!
//! - `GET /` lists them (seeding the system roles on the first call): system
//!   roles in level order, then custom roles alphabetically, with member
//!   counts by role id.
//! - `GET /permission-catalog`: the catalog the role editor renders, with the
//!   workspace's custom objects in their own group.
//! - `GET /installable-apps`: the active installed apps a role can grant.
//! - `GET /:roleId`, `POST /`, `PUT /:roleId`, `DELETE /:roleId`.
//!
//! Writes sit under the grant ceiling: a role may only carry permissions the
//! caller holds (kept ones excepted on update). System names are reserved and
//! names are unique, both trimmed and case-insensitive. Deleting a role drops
//! the WeldChat memberships it drove and announces each departure.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{ROLES_CREATE, ROLES_DELETE, ROLES_READ, ROLES_UPDATE};
use weldsuite_catalogs::{PermissionObject, permissions as catalog};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{
    PermissionGate, PermissionQueries, check_permission_grants, is_app_scoped_object,
    role_row_permissions,
};
use weldsuite_ports::{DynRealtimePublisher, RealtimeMessage, Room};
use weldsuite_schema::tenant::{
    chat_channel_members as channel_members, chat_channel_role_links as role_links, chat_channels,
    custom_objects, roles, workspace_installed_apps as installed, workspace_members as members,
};

use crate::access::js;
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, validate};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(ROLES_READ)))
        .route("/", post(create).route_layer(need(ROLES_CREATE)))
        .route(
            "/permission-catalog",
            get(permission_catalog).route_layer(need(ROLES_READ)),
        )
        .route(
            "/installable-apps",
            get(installable_apps).route_layer(need(ROLES_READ)),
        )
        .route("/{role_id}", get(detail).route_layer(need(ROLES_READ)))
        .route("/{role_id}", put(update).route_layer(need(ROLES_UPDATE)))
        .route("/{role_id}", delete(remove).route_layer(need(ROLES_DELETE)))
}

/// System roles in level order (highest first); also the reserved names.
const SYSTEM_ROLE_ORDER: [&str; 4] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];

/// App code → display name (`APP_NAMES`).
const APP_NAMES: [(&str, &str); 24] = [
    ("crm", "CRM"),
    ("helpdesk", "WeldDesk"),
    ("mail", "WeldMail"),
    ("projects", "WeldFlow"),
    ("task", "WeldConnect"),
    ("host", "WeldHost"),
    ("wms", "WMS"),
    ("accounting", "Accounting"),
    ("parcel", "Parcel"),
    ("social", "Social"),
    ("weldcrm", "WeldCRM"),
    ("welddesk", "WeldDesk"),
    ("weldmail", "WeldMail"),
    ("weldflow", "WeldFlow"),
    ("weldconnect", "WeldConnect"),
    ("weldhost", "WeldHost"),
    ("weldstash", "WeldStash"),
    ("weldbooks", "WeldBooks"),
    ("weldchat", "WeldChat"),
    ("weldmeet", "WeldMeet"),
    ("weldcalendar", "WeldCalendar"),
    ("welddrive", "WeldDrive"),
    ("welddata", "WeldData"),
    ("weldads", "WeldAds"),
];

/// `appName(code)`: the brand name, else the code capitalised.
pub(crate) fn app_name(code: &str) -> String {
    if let Some((_, name)) = APP_NAMES.iter().find(|(c, _)| *c == code) {
        return (*name).to_owned();
    }
    let mut chars = code.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A `roles` row as Drizzle returns it (camelCase keys).
struct RoleRecord(Value);

impl RoleRecord {
    fn id(&self) -> &str {
        self.0["id"].as_str().unwrap_or_default()
    }

    fn name(&self) -> &str {
        self.0["name"].as_str().unwrap_or_default()
    }

    fn is_system(&self) -> bool {
        self.0["isSystem"].as_bool().unwrap_or(false)
    }

    fn stored_permissions(&self) -> Option<Vec<String>> {
        self.0["permissions"].as_array().map(|keys| {
            keys.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    }

    /// `getRoleRowPermissions(role)`.
    fn permissions(&self) -> Vec<String> {
        role_row_permissions(
            self.is_system(),
            self.name(),
            self.stored_permissions().as_deref(),
        )
    }

    /// `(role.apps as string[]) || []`.
    fn apps(&self) -> Value {
        match &self.0["apps"] {
            Value::Null => json!([]),
            apps => apps.clone(),
        }
    }

    /// `toRoleRow(role, memberCount)`.
    fn view(&self, member_count: i64) -> Value {
        let system = self.is_system();
        json!({
            "id": self.id(),
            "name": self.name(),
            "description": self.0["description"],
            "isSystemRole": system,
            "canDelete": !system,
            "canModify": !system,
            "memberCount": member_count,
            "permissions": self.permissions(),
            "apps": self.apps(),
            "createdAt": self.0["createdAt"].as_str().unwrap_or_default(),
            "updatedAt": self.0["updatedAt"].as_str().unwrap_or_default(),
        })
    }
}

fn normalise(name: &str) -> String {
    name.trim().to_uppercase()
}

fn system_rank(role: &RoleRecord) -> usize {
    let name = normalise(role.name());
    SYSTEM_ROLE_ORDER
        .iter()
        .position(|n| *n == name)
        .unwrap_or(SYSTEM_ROLE_ORDER.len())
}

/// `a.localeCompare(b, undefined, { sensitivity: 'base' })`, closely enough
/// for role names: case-insensitive.
fn locale_base_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// `compareRoles`: system roles first in level order, then by name.
fn compare_roles(a: &RoleRecord, b: &RoleRecord) -> Ordering {
    if a.is_system() != b.is_system() {
        return if a.is_system() {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if a.is_system() {
        let rank = system_rank(a).cmp(&system_rank(b));
        if rank != Ordering::Equal {
            return rank;
        }
    }
    locale_base_compare(a.name(), b.name())
}

async fn live_roles(db: &PgPool) -> Result<Vec<RoleRecord>, DbErr> {
    roles::Entity::find()
        .filter(roles::Column::DeletedAt.is_null())
        .order_by_asc(roles::Column::Name)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|role| js(role).map(RoleRecord))
        .collect()
}

async fn find_role(db: &PgPool, role_id: &str) -> Result<Option<RoleRecord>, DbErr> {
    roles::Entity::find_by_id(role_id)
        .filter(roles::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|role| js(role).map(RoleRecord))
        .transpose()
}

/// `ensureSeeded`: the four system roles when the workspace has no role yet.
async fn ensure_seeded(db: &PgPool) -> Result<Vec<RoleRecord>, DbErr> {
    let roles = live_roles(db).await?;
    if !roles.is_empty() {
        return Ok(roles);
    }
    let system = &catalog().system_roles;
    for code in SYSTEM_ROLE_ORDER {
        let Some(role) = system.get(code) else {
            continue;
        };
        let stamp = utc_now().assume_utc();
        roles::Entity::insert(roles::ActiveModel {
            id: Set(generate_id("role")),
            name: Set(role.name.clone()),
            description: Set(Some(role.description.clone())),
            is_system: Set(true),
            permissions: Set(Some(json!(role.permissions))),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
    }
    live_roles(db).await
}

/// `countMembersByRole`: an active member counts for their live custom role,
/// else for the system role of their tier.
async fn member_counts(db: &PgPool, roles: &[RoleRecord]) -> Result<HashMap<String, i64>, DbErr> {
    let groups: Vec<(Option<String>, Option<String>, i64)> = members::Entity::find()
        .select_only()
        .columns([members::Column::Role, members::Column::RoleId])
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(members::Column::Status.eq("ACTIVE"))
        .filter(members::Column::DeletedAt.is_null())
        .group_by(members::Column::Role)
        .group_by(members::Column::RoleId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let live: std::collections::HashSet<&str> = roles.iter().map(RoleRecord::id).collect();
    let system_by_tier: HashMap<String, &str> = roles
        .iter()
        .filter(|r| r.is_system())
        .map(|r| (normalise(r.name()), r.id()))
        .collect();
    let mut counts: HashMap<String, i64> = HashMap::new();
    for (role, role_id, count) in groups {
        let target = match role_id.as_deref() {
            Some(id) if live.contains(id) => Some(id.to_owned()),
            _ => role
                .as_deref()
                .filter(|r| !r.is_empty())
                .and_then(|r| system_by_tier.get(&normalise(r)))
                .map(|id| (*id).to_owned()),
        };
        if let Some(id) = target {
            *counts.entry(id).or_default() += count;
        }
    }
    Ok(counts)
}

/// `getRole`: one live role with its member count.
async fn role_view(db: &PgPool, role_id: &str) -> Result<Option<Value>, DbErr> {
    let Some(role) = find_role(db, role_id).await? else {
        return Ok(None);
    };
    let roles = live_roles(db).await?;
    let counts = member_counts(db, &roles).await?;
    Ok(Some(role.view(counts.get(role.id()).copied().unwrap_or(0))))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    let result: Result<Value, DbErr> = async {
        let mut roles = ensure_seeded(&caller.db).await?;
        roles.sort_by(compare_roles);
        let counts = member_counts(&caller.db, &roles).await?;
        Ok(Value::Array(
            roles
                .iter()
                .map(|role| role.view(counts.get(role.id()).copied().unwrap_or(0)))
                .collect(),
        ))
    }
    .await;
    match result {
        Ok(roles) => Data(roles).into_response(),
        Err(error) => TeamError::internal("Failed to fetch roles", error).respond(),
    }
}

// ── GET /permission-catalog ─────────────────────────────────────────────────

/// One catalog object as the role editor reads it (`toResponse`), its keys
/// prefixed with `app:` when given.
fn catalog_object(object: &PermissionObject, app: Option<&str>) -> Value {
    let prefix = app.map(|app| format!("{app}:{}:", object.key));
    let permissions: Vec<Value> = object
        .permissions
        .iter()
        .map(|permission| {
            let code = app.map_or_else(
                || permission.key.clone(),
                |app| format!("{app}:{}", permission.key),
            );
            let action = match &prefix {
                Some(prefix) => code.get(prefix.len()..).unwrap_or_default().to_owned(),
                None => code.split(':').skip(1).collect::<Vec<_>>().join(":"),
            };
            let action = if action.is_empty() {
                "read".to_owned()
            } else {
                action
            };
            let mut entry = Map::new();
            entry.insert("code".to_owned(), json!(code));
            entry.insert("name".to_owned(), json!(permission.label));
            if let Some(description) = &permission.description {
                entry.insert("description".to_owned(), json!(description));
            }
            entry.insert("action".to_owned(), json!(action));
            entry.insert("isGranted".to_owned(), json!(false));
            Value::Object(entry)
        })
        .collect();
    json!({ "object": object.key, "objectName": object.label, "permissions": permissions })
}

/// `customObjectPermissionObject`: the five keys of one custom object.
fn custom_object(slug: &str, label_plural: &str) -> Value {
    let lower = label_plural.to_lowercase();
    let mut permissions: Vec<Value> = [
        ("read", "View"),
        ("create", "Create"),
        ("update", "Edit"),
        ("delete", "Delete"),
    ]
    .iter()
    .map(|(action, label)| {
        json!({
            "code": format!("weldobjects:{slug}:{action}"),
            "name": format!("{label} {lower}"),
            "action": format!("{slug}:{action}"),
            "isGranted": false,
        })
    })
    .collect();
    permissions.push(json!({
        "code": format!("weldobjects:{slug}:scope:all"),
        "name": format!("See all {lower} (not only their own)"),
        "description": format!(
            "Without this grant, the user can only read/edit {lower} they own. Grant to managers and admins who need cross-team visibility."
        ),
        "action": format!("{slug}:scope:all"),
        "isGranted": false,
    }));
    json!({
        "object": format!("weldobjects:{slug}"),
        "objectName": label_plural,
        "permissions": permissions,
    })
}

async fn permission_catalog(caller: Caller) -> Response {
    let permissions = catalog();
    let objects: Vec<Value> = permissions
        .objects
        .iter()
        .map(|o| catalog_object(o, None))
        .collect();

    // A tenant from before custom_objects still edits roles: the static
    // catalog alone.
    let custom: Result<Vec<(String, String)>, DbErr> = custom_objects::Entity::find()
        .select_only()
        .columns([
            custom_objects::Column::Slug,
            custom_objects::Column::LabelPlural,
        ])
        .filter(custom_objects::Column::DeletedAt.is_null())
        .order_by_asc(custom_objects::Column::SortOrder)
        .order_by_asc(custom_objects::Column::LabelPlural)
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    let custom_objects: Vec<Value> = match custom {
        Ok(rows) => rows
            .iter()
            .map(|(slug, label)| custom_object(slug, label))
            .collect(),
        Err(error) => {
            tracing::error!(%error, "roles: custom object permission merge failed");
            Vec::new()
        }
    };

    let by_key: HashMap<&str, &PermissionObject> = permissions
        .objects
        .iter()
        .map(|o| (o.key.as_str(), o))
        .collect();
    let apps: Vec<Value> = permissions
        .apps
        .iter()
        .map(|app| {
            let objects: Vec<Value> = app
                .objects
                .iter()
                .filter_map(|key| by_key.get(key.as_str()))
                .map(|object| catalog_object(object, Some(&app.code)))
                .collect();
            json!({ "app": app.code, "appName": app.label, "objects": objects })
        })
        .collect();
    let workspace: Vec<Value> = permissions
        .objects
        .iter()
        .filter(|o| !is_app_scoped_object(&o.key))
        .map(|o| catalog_object(o, None))
        .collect();

    Data(json!({
        "objects": objects,
        "customObjects": custom_objects,
        "apps": apps,
        "workspace": workspace,
    }))
    .into_response()
}

// ── GET /installable-apps ───────────────────────────────────────────────────

async fn installable_apps(caller: Caller) -> Response {
    let codes: Result<Vec<String>, DbErr> = installed::Entity::find()
        .select_only()
        .column(installed::Column::AppCode)
        .filter(installed::Column::IsActive.eq(true))
        .filter(installed::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    match codes {
        Ok(codes) => Data(Value::Array(
            codes
                .iter()
                .map(|code| json!({ "appCode": code, "appName": app_name(code) }))
                .collect(),
        ))
        .into_response(),
        Err(error) => TeamError::internal("Failed to fetch installable apps", error).respond(),
    }
}

// ── GET /:roleId ────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(role_id): Path<String>) -> Response {
    match role_view(&caller.db, &role_id).await {
        Ok(Some(role)) => Data(role).into_response(),
        Ok(None) => ApiError::not_found("Role", Some(&role_id)).into_response(),
        Err(error) => TeamError::internal("Failed to fetch role", error).respond(),
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

/// `z.array(z.string()).optional()`.
fn string_list(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    issues
        .list(body, key, Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        })
        .into_option()
}

struct RoleInput {
    name: Option<String>,
    description: Option<String>,
    permissions: Option<Vec<String>>,
    apps: Option<Vec<String>>,
    copy_from: Option<String>,
}

/// `createRoleSchema`.
fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> RoleInput {
    let from = issues.count();
    let name = issues
        .text_with(
            body,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), None),
        )
        .into_option();
    issues.custom_message(from, "too_small", "Name is required");
    RoleInput {
        name,
        description: issues.string(body, "description", false, None, None),
        permissions: string_list(issues, body, "permissions"),
        apps: string_list(issues, body, "apps"),
        copy_from: issues.string(body, "copyFromRoleId", false, None, None),
    }
}

/// `updateRoleSchema`.
fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> RoleInput {
    RoleInput {
        name: issues
            .text_with(
                body,
                "name",
                Presence::Optional,
                Text::trimmed(Some(1), None),
            )
            .into_option(),
        description: issues.string(body, "description", false, None, None),
        permissions: string_list(issues, body, "permissions"),
        apps: string_list(issues, body, "apps"),
        copy_from: None,
    }
}

/// Why a name can't be used: `reserved` (a system tier) or `duplicate`.
async fn name_problem(
    db: &PgPool,
    name: &str,
    except: Option<&str>,
) -> Result<Option<&'static str>, DbErr> {
    let wanted = normalise(name);
    if SYSTEM_ROLE_ORDER.contains(&wanted.as_str()) {
        return Ok(Some("reserved"));
    }
    let live: Vec<(String, String)> = roles::Entity::find()
        .select_only()
        .columns([roles::Column::Id, roles::Column::Name])
        .filter(roles::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let clash = live
        .iter()
        .any(|(id, name)| Some(id.as_str()) != except && normalise(name) == wanted);
    Ok(clash.then_some("duplicate"))
}

fn name_error(reason: &str) -> TeamError {
    let details = json!({ "field": "name", "reason": reason });
    if reason == "reserved" {
        ApiError::bad_request("This name is reserved for a system role")
            .with_details(details)
            .into()
    } else {
        ApiError::conflict("A role with this name already exists")
            .with_details(details)
            .into()
    }
}

/// The grant ceiling (`checkPermissionGrants`): 400 for keys that aren't
/// permissions, 403 for keys the caller doesn't hold.
fn refuse_ungrantable(caller: &Caller, requested: &[String], kept: &[String]) -> TeamResult<()> {
    let Some(grantor) = &caller.permissions else {
        return Err(ApiError::unauthorized().into());
    };
    let check = check_permission_grants(grantor.resolved(), requested, kept);
    if check.ok {
        return Ok(());
    }
    if check.invalid.is_empty() {
        Err(ApiError::forbidden()
            .with_message("You cannot grant permissions you do not hold yourself")
            .into())
    } else {
        Err(ApiError::bad_request("Unknown or disallowed permissions")
            .with_details(json!({ "field": "permissions", "invalid": check.invalid }))
            .into())
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(create_role(&caller, &headers, &body).await)
}

async fn create_role(caller: &Caller, headers: &HeaderMap, body: &Bytes) -> TeamResult<Response> {
    let input = validate(headers, body, read_create)?;
    let name = input.name.unwrap_or_default().trim().to_owned();
    let db = &caller.db;
    let result: TeamResult<Response> = async {
        if let Some(reason) = name_problem(db, &name, None).await? {
            return Err(name_error(reason));
        }
        let mut permissions = input.permissions.clone().unwrap_or_default();
        let mut apps = input.apps.clone().map_or_else(|| json!([]), |a| json!(a));
        if let Some(source_id) = &input.copy_from
            && let Some(source) = find_role(db, source_id).await?
        {
            if input.permissions.is_none() {
                permissions = source.permissions();
            }
            if input.apps.is_none() && !source.0["apps"].is_null() {
                apps = source.0["apps"].clone();
            }
        }
        refuse_ungrantable(caller, &permissions, &[])?;

        let id = generate_id("role");
        let stamp = utc_now().assume_utc();
        roles::Entity::insert(roles::ActiveModel {
            id: Set(id.clone()),
            name: Set(name.clone()),
            description: Set(input.description.clone()),
            permissions: Set(Some(json!(permissions))),
            apps: Set(Some(apps)),
            is_system: Set(false),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
        let role = role_view(db, &id).await?.unwrap_or(Value::Null);
        Ok(Created(role).into_response())
    }
    .await;
    internal_on_db(result, "Failed to create role")
}

/// A database failure inside the route's `try` is its 500 with its message.
fn internal_on_db(result: TeamResult<Response>, message: &'static str) -> TeamResult<Response> {
    match result {
        Err(TeamError::Database(error)) => Err(TeamError::internal(message, error)),
        other => other,
    }
}

// ── PUT /:roleId ────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    Path(role_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(update_role(&caller, &role_id, &headers, &body).await)
}

async fn update_role(
    caller: &Caller,
    role_id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let input = validate(headers, body, read_update)?;
    let db = &caller.db;
    let result: TeamResult<Response> = async {
        let Some(existing) = find_role(db, role_id).await? else {
            return Err(ApiError::not_found("Role", Some(role_id)).into());
        };
        if existing.is_system() {
            return Err(ApiError::forbidden()
                .with_message("Cannot modify system roles")
                .into());
        }
        let name = match &input.name {
            Some(name) => {
                let name = name.trim().to_owned();
                if let Some(reason) = name_problem(db, &name, Some(role_id)).await? {
                    return Err(name_error(reason));
                }
                Some(name)
            }
            None => None,
        };
        if let Some(permissions) = &input.permissions {
            refuse_ungrantable(caller, permissions, &existing.permissions())?;
        }
        let mut write = roles::Entity::update_many().col_expr(
            roles::Column::UpdatedAt,
            Expr::value(utc_now().assume_utc()),
        );
        if let Some(name) = name {
            write = write.col_expr(roles::Column::Name, Expr::value(name));
        }
        if let Some(description) = &input.description {
            write = write.col_expr(roles::Column::Description, Expr::value(description));
        }
        if let Some(permissions) = &input.permissions {
            write = write.col_expr(roles::Column::Permissions, Expr::value(json!(permissions)));
        }
        if let Some(apps) = &input.apps {
            write = write.col_expr(roles::Column::Apps, Expr::value(json!(apps)));
        }
        write
            .filter(roles::Column::Id.eq(role_id))
            .exec(&orm(db))
            .await?;
        let role = role_view(db, role_id).await?.unwrap_or(Value::Null);
        Ok(Data(role).into_response())
    }
    .await;
    internal_on_db(result, "Failed to update role")
}

// ── DELETE /:roleId ─────────────────────────────────────────────────────────

async fn remove(
    State(state): State<CoreTeamState>,
    caller: Caller,
    Path(role_id): Path<String>,
) -> Response {
    let result: TeamResult<Response> = async {
        let Some(existing) = find_role(&caller.db, &role_id).await? else {
            return Err(ApiError::not_found("Role", Some(&role_id)).into());
        };
        if existing.is_system() {
            return Err(ApiError::forbidden()
                .with_message("Cannot delete system roles")
                .into());
        }
        let stamp = utc_now().assume_utc();
        roles::Entity::update_many()
            .col_expr(roles::Column::DeletedAt, Expr::value(stamp))
            .col_expr(roles::Column::UpdatedAt, Expr::value(stamp))
            .filter(roles::Column::Id.eq(&role_id))
            .exec(&orm(&caller.db))
            .await?;

        // Best effort: the role is gone whatever happens to its chat links.
        match cleanup_chat_links(&caller.db, &role_id).await {
            Ok(changes) => publish_left(&state, changes).await,
            Err(error) => {
                tracing::error!(%error, "roles: failed to clean up chat role links on role delete");
            }
        }
        Ok(NoContent.into_response())
    }
    .await;
    answer(internal_on_db(result, "Failed to delete role"))
}

/// `cleanupRoleLinksOnRoleDelete`: each channel linked to the role loses the
/// link and the members the role added. `(channel, removed users)`.
async fn cleanup_chat_links(
    db: &PgPool,
    role_id: &str,
) -> Result<Vec<(String, Vec<String>)>, DbErr> {
    let db = orm(db);
    let channels: Vec<String> = role_links::Entity::find()
        .select_only()
        .column(role_links::Column::ChannelId)
        .filter(role_links::Column::RoleId.eq(role_id))
        .into_tuple()
        .all(&db)
        .await?;
    let mut changes = Vec::new();
    for channel in channels {
        let _name: Option<String> = chat_channels::Entity::find_by_id(&channel)
            .select_only()
            .column(chat_channels::Column::Name)
            .into_tuple()
            .one(&db)
            .await?;
        role_links::Entity::delete_many()
            .filter(role_links::Column::ChannelId.eq(&channel))
            .filter(role_links::Column::RoleId.eq(role_id))
            .exec(&db)
            .await?;
        let added_by_role = || {
            Condition::all()
                .add(channel_members::Column::ChannelId.eq(&channel))
                .add(channel_members::Column::AddedByRoleId.eq(role_id))
        };
        let removed: Vec<String> = channel_members::Entity::find()
            .select_only()
            .column(channel_members::Column::UserId)
            .filter(added_by_role())
            .into_tuple()
            .all(&db)
            .await?;
        if removed.is_empty() {
            continue;
        }
        channel_members::Entity::delete_many()
            .filter(added_by_role())
            .exec(&db)
            .await?;
        // `(select count(*)::int from chat_channel_members where channel_id = $1)`.
        let member_count = channel_members::Entity::find()
            .select_only()
            .expr(sea_orm::ExprTrait::cast_as(
                Func::count(Expr::col(Asterisk)),
                "int",
            ))
            .filter(channel_members::Column::ChannelId.eq(&channel))
            .into_query();
        chat_channels::Entity::update_many()
            .col_expr(
                chat_channels::Column::MemberCount,
                Expr::SubQuery(None, Box::new(member_count.into())),
            )
            .col_expr(chat_channels::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(chat_channels::Column::Id.eq(&channel))
            .exec(&db)
            .await?;
        changes.push((channel, removed));
    }
    Ok(changes)
}

/// `publishChatMemberLeft` per removed member, to the channel's room.
async fn publish_left(state: &CoreTeamState, changes: Vec<(String, Vec<String>)>) {
    let Some(realtime) = state.realtime.clone() else {
        return;
    };
    for (channel, users) in changes {
        for user in users {
            let message = RealtimeMessage::room(
                Room::Chat,
                &channel,
                json!({ "type": "member", "userId": user, "userName": "", "action": "left" }),
            );
            if let Err(error) = DynRealtimePublisher::publish_boxed(&*realtime, &message).await {
                tracing::error!(%error, "roles: realtime publish failed (role-delete remove)");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_fall_back_to_the_capitalised_code() {
        assert_eq!(app_name("helpdesk"), "WeldDesk");
        assert_eq!(app_name("zapflow"), "Zapflow");
        assert_eq!(app_name(""), "");
    }

    #[test]
    fn custom_objects_get_five_keys() {
        let object = custom_object("machine", "Machines");
        assert_eq!(object["object"], "weldobjects:machine");
        assert_eq!(object["permissions"][0]["name"], "View machines");
        assert_eq!(object["permissions"][4]["action"], "machine:scope:all");
    }

    #[test]
    fn system_roles_come_first_in_level_order() {
        let role =
            |name: &str, system: bool| RoleRecord(json!({ "name": name, "isSystem": system }));
        let mut roles = [
            role("beta", false),
            role("Viewer", true),
            role("Alpha", false),
            role("Owner", true),
            role("Admin", true),
        ];
        roles.sort_by(compare_roles);
        let names: Vec<&str> = roles.iter().map(RoleRecord::name).collect();
        assert_eq!(names, ["Owner", "Admin", "Viewer", "Alpha", "beta"]);
    }
}
