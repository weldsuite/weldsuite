//! The directory half of `/api/team-members` (`app-api/src/routes/team-members/index.ts`,
//! `services/team/{members,member-access}.ts`): `/me`, the list, one member,
//! and a member's permission breakdown and app assignments (with the toggle).
//! The `/user/:userId/*` routes (profile, notes, common, activity) are in
//! [`directory_profile`].
//!
//! Visibility: `team:read` (`hasContextPermission`) sees every field of a
//! row; anyone else sees the public fields, and their own row with email,
//! role id and permissions. The list and one member resolve the caller's
//! permissions without requiring any (`gate.resolve()`).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries, role_row_permissions};
use weldsuite_schema::tenant::{
    roles, user_app_assignments as assignments, workspace_installed_apps as installed,
    workspace_members as members,
};

use crate::access::js;
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, validate};

#[path = "directory_profile.rs"]
mod directory_profile;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let team_read = || gate.require(["team:read"]);
    let team_update = || gate.require(["team:update"]);
    Router::new()
        .route("/me", get(me))
        .route("/", get(list).route_layer(gate.resolve()))
        .route("/{id}", get(detail).route_layer(gate.resolve()))
        .route(
            "/{id}/permissions",
            get(permissions).route_layer(team_read()),
        )
        .route("/{id}/apps", get(apps).route_layer(team_read()))
        .route(
            "/{id}/apps/toggle",
            post(toggle_app).route_layer(team_update()),
        )
        .merge(directory_profile::router(gate))
}

/// `error.internal(c, message)` for a failed query.
pub(super) fn failed(message: &'static str) -> impl FnOnce(DbErr) -> TeamError {
    move |error| TeamError::internal(message, error)
}

/// A member row (`select()`), as Drizzle returns it.
async fn member_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    members::Entity::find_by_id(id)
        .filter(members::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

// ── visibility ──────────────────────────────────────────────────────────────

const PUBLIC_KEYS: [&str; 7] = [
    "id",
    "userId",
    "name",
    "picture",
    "role",
    "status",
    "memberType",
];
const SELF_KEYS: [&str; 3] = ["email", "roleId", "permissions"];
const ADMIN_KEYS: [&str; 4] = ["invitedBy", "invitedAt", "acceptedAt", "createdAt"];

/// `projectMemberFields`: the fields `admin` (`team:read`) or the viewer may see.
fn project(member: &Value, admin: bool, viewer: &str) -> Value {
    let own = member["userId"].as_str() == Some(viewer);
    let mut keys: Vec<&str> = PUBLIC_KEYS.to_vec();
    if admin || own {
        keys.extend(SELF_KEYS);
    }
    if admin {
        keys.extend(ADMIN_KEYS);
    }
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = member.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

// ── GET /me ─────────────────────────────────────────────────────────────────

async fn me(caller: Caller) -> Response {
    answer(me_inner(&caller).await)
}

/// What `GET /me` selects of the caller's row (`picture` comes after).
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Me {
    id: String,
    user_id: String,
    email: Option<String>,
    name: Option<String>,
    role: String,
    role_id: Option<String>,
    permissions: Option<Value>,
    status: String,
    member_type: String,
}

async fn me_inner(caller: &Caller) -> TeamResult<Response> {
    let row = members::Entity::find()
        .select_only()
        .columns([
            members::Column::Id,
            members::Column::UserId,
            members::Column::Email,
            members::Column::Name,
            members::Column::Role,
            members::Column::RoleId,
            members::Column::Permissions,
            members::Column::Status,
            members::Column::MemberType,
        ])
        .filter(members::Column::UserId.eq(&caller.user_id))
        .filter(members::Column::DeletedAt.is_null())
        .into_model::<Me>()
        .one(&orm(&caller.db))
        .await
        .and_then(|row| row.map(js).transpose())
        .map_err(failed("Failed to fetch current member"))?;
    match row {
        Some(mut row) => {
            // The avatar is the account picture, not the member row's copy.
            row["picture"] =
                weldsuite_db::load_account_picture(caller.request_master(), &caller.user_id)
                    .await
                    .map_or(Value::Null, Value::String);
            Ok(Data(row).into_response())
        }
        None => Err(ApiError::not_found("Member", Some(&caller.user_id)).into()),
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `c.req.query()`: the first value of each key.
pub(super) fn first_values(query: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (key, value) in form_urlencoded_pairs(query.unwrap_or_default()) {
        out.entry(key).or_insert(value);
    }
    out
}

/// `application/x-www-form-urlencoded` pairs, `+` as a space.
fn form_urlencoded_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(key), decode(value))
        })
        .collect()
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                if let Some(byte) = hex {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then digits;
/// `None` is `NaN`.
pub(super) fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let number: i64 = digits[..end].parse().ok()?;
    Some(if negative { -number } else { number })
}

/// The JavaScript truthiness of an optional query value.
fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(list_inner(&caller, query.as_deref()).await)
}

async fn list_inner(caller: &Caller, query: Option<&str>) -> TeamResult<Response> {
    let admin = caller.can("team:read");
    let query = first_values(query);

    let member_type = match query.get("memberType").map(String::as_str) {
        Some(kind @ ("INTERNAL" | "EXTERNAL_GUEST" | "EMPLOYEE" | "all")) => Some(kind),
        _ if query.get("include").map(String::as_str) == Some("guests") => Some("all"),
        _ => None,
    };
    let limit = match truthy(query.get("limit")) {
        // `Math.min(NaN, 100)` is NaN, which the query refuses.
        Some(text) => match parse_int(text) {
            Some(limit) => limit.min(100),
            None => return Err(TeamError::internal("Failed to fetch members", "NaN limit")),
        },
        None => 25,
    };
    let status = truthy(query.get("status"));
    let member_type = member_type.unwrap_or("INTERNAL");
    let type_filter = (member_type != "all").then_some(member_type);
    let search = truthy(query.get("search")).map(|s| format!("%{s}%"));
    let cursor = truthy(query.get("cursor"));

    let result = list_members(
        &caller.db,
        ListFilters {
            status,
            member_type: type_filter,
            search: search.as_deref(),
            cursor,
        },
        limit,
    )
    .await
    .map_err(failed("Failed to fetch members"))?;
    let mut rows = result.rows;
    // Avatars are account pictures, not the member row's copy.
    weldsuite_db::overlay_account_pictures(caller.request_master(), &mut rows, "userId", "picture")
        .await;
    let data = rows
        .iter()
        .map(|member| project(member, admin, &caller.user_id))
        .collect();
    Ok(List::new(data, result.pagination).into_response())
}

struct ListFilters<'a> {
    status: Option<&'a str>,
    member_type: Option<&'a str>,
    search: Option<&'a str>,
    cursor: Option<&'a str>,
}

struct Page {
    rows: Vec<Value>,
    pagination: Pagination,
}

/// The list's filters (`and(...)`), without the keyset; `deleted_at is null`
/// only when `live`.
fn filtered(
    live: bool,
    status: Option<&str>,
    member_type: Option<&str>,
    search: Option<&str>,
) -> Select<members::Entity> {
    let mut select = members::Entity::find();
    if live {
        select = select.filter(members::Column::DeletedAt.is_null());
    }
    if let Some(status) = status {
        select = select.filter(members::Column::Status.eq(status));
    }
    if let Some(member_type) = member_type {
        select = select.filter(members::Column::MemberType.eq(member_type));
    }
    if let Some(search) = search {
        select = select.filter(
            Condition::any()
                .add(members::Column::Name.like(search))
                .add(members::Column::Email.like(search)),
        );
    }
    select
}

/// `listMembers`, its keyset cursor and its count included.
async fn list_members(db: &PgPool, f: ListFilters<'_>, limit: i64) -> Result<Page, DbErr> {
    let orm = orm(db);
    // The cursor row's `createdAt`, to the millisecond as the route's `Date`.
    let keyset: Option<(OffsetDateTime, String)> = match f.cursor {
        Some(cursor) => members::Entity::find_by_id(cursor)
            .select_only()
            .columns([members::Column::CreatedAt, members::Column::Id])
            .into_tuple::<(OffsetDateTime, String)>()
            .one(&orm)
            .await?
            .map(|(at, id)| (utc_timestamp(at).assume_utc(), id)),
        None => None,
    };
    // `limit(-n)` fails in the database.
    let fetch = u64::try_from(limit + 1)
        .map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))?;
    let mut select = filtered(true, f.status, f.member_type, f.search);
    if let Some((at, id)) = &keyset {
        select = select.filter(
            Condition::any()
                .add(members::Column::CreatedAt.lt(*at))
                .add(
                    Condition::all()
                        .add(members::Column::CreatedAt.eq(*at))
                        .add(members::Column::Id.lt(id)),
                ),
        );
    }
    let rows = select
        .order_by_desc(members::Column::CreatedAt)
        .order_by_desc(members::Column::Id)
        .limit(fetch)
        .all(&orm)
        .await?;

    // The count leaves out the last condition when a cursor was given: the
    // keyset one, or (cursor not found) the last filter before it.
    let mut keep_deleted = true;
    let (mut status, mut member_type, mut search) = (f.status, f.member_type, f.search);
    if f.cursor.is_some() && keyset.is_none() {
        if search.is_some() {
            search = None;
        } else if member_type.is_some() {
            member_type = None;
        } else if status.is_some() {
            status = None;
        } else {
            keep_deleted = false;
        }
    }
    let total = filtered(keep_deleted, status, member_type, search)
        .count(&orm)
        .await?;

    let mut rows: Vec<Value> = rows.into_iter().map(js).collect::<Result<_, _>>()?;
    let (rows, has_more) = take_page(&mut rows, limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(Page {
        rows,
        pagination: Pagination::new(total, has_more, cursor),
    })
}

/// `rows.length > limit`, `rows.slice(0, limit)` (a negative limit never gets
/// here: the query refuses it).
pub(super) fn take_page(rows: &mut Vec<Value>, limit: i64) -> (Vec<Value>, bool) {
    let limit = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    (std::mem::take(rows), has_more)
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(detail_inner(&caller, &id).await)
}

async fn detail_inner(caller: &Caller, id: &str) -> TeamResult<Response> {
    let admin = caller.can("team:read");
    let member = member_by_id(&caller.db, id)
        .await
        .map_err(failed("Failed to fetch member"))?
        .ok_or_else(|| ApiError::not_found("Member", Some(id)))?;
    // The avatar is the account picture, not the member row's copy.
    let mut members = [member];
    weldsuite_db::overlay_account_pictures(
        caller.request_master(),
        &mut members,
        "userId",
        "picture",
    )
    .await;
    Ok(Data(project(&members[0], admin, &caller.user_id)).into_response())
}

// ── GET /:id/permissions ────────────────────────────────────────────────────

/// A JSON array of strings (`(x as string[] | null) || []`).
fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// A member's access fields, as `findMember` selects them.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberAccess {
    user_id: String,
    role: String,
    role_id: Option<String>,
    permissions: Option<Value>,
    permission_denies: Option<Value>,
    member_type: String,
}

/// The live member's access fields (`findMember`).
async fn find_member(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    members::Entity::find_by_id(id)
        .select_only()
        .columns([
            members::Column::UserId,
            members::Column::Role,
            members::Column::RoleId,
            members::Column::Permissions,
            members::Column::PermissionDenies,
            members::Column::MemberType,
        ])
        .filter(members::Column::DeletedAt.is_null())
        .into_model::<MemberAccess>()
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

async fn permissions(caller: Caller, Path(id): Path<String>) -> Response {
    answer(permissions_inner(&caller, &id).await)
}

async fn permissions_inner(caller: &Caller, id: &str) -> TeamResult<Response> {
    let message = "Failed to fetch member permissions";
    let member = find_member(&caller.db, id)
        .await
        .map_err(failed(message))?
        .ok_or_else(|| ApiError::not_found("Member", Some(id)))?;
    let role = member["role"].as_str().unwrap_or_default();
    let role_id = member["roleId"].as_str();

    let mut role_permissions: Vec<String> = Vec::new();
    if let Some(role_id) = role_id {
        let row: Option<(Option<Value>, bool, String)> = roles::Entity::find_by_id(role_id)
            .select_only()
            .columns([
                roles::Column::Permissions,
                roles::Column::IsSystem,
                roles::Column::Name,
            ])
            .filter(roles::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await
            .map_err(failed(message))?;
        if let Some((stored, is_system, name)) = row {
            let stored = stored.as_ref().map(strings);
            role_permissions = role_row_permissions(is_system, &name, stored.as_deref());
        }
    }
    let overrides = strings(&member["permissions"]);
    let denies = strings(&member["permissionDenies"]);
    let catalog = weldsuite_catalogs::permissions();
    let employee = member["memberType"] == "EMPLOYEE";
    let inherited = if employee {
        catalog.employee_member_permissions.clone()
    } else if role_id.is_some() {
        role_permissions.clone()
    } else {
        catalog
            .system_roles
            .get(role)
            .map(|r| r.permissions.clone())
            .unwrap_or_default()
    };
    let effective = if employee {
        inherited.clone()
    } else {
        let mut seen: Vec<String> = Vec::new();
        for key in role_permissions.iter().chain(&overrides) {
            if !seen.contains(key) {
                seen.push(key.clone());
            }
        }
        seen
    };
    Ok(Data(json!({
        "effective": effective,
        "rolePermissions": role_permissions,
        "memberOverrides": overrides,
        "memberDenies": denies,
        "inheritedPermissions": inherited,
        "role": role,
        "roleId": role_id,
    }))
    .into_response())
}

// ── GET /:id/apps ───────────────────────────────────────────────────────────

/// `appName(code)` (`services/roles.ts`): the brand name, else the code
/// capitalised.
pub(crate) fn app_name(code: &str) -> String {
    let known = match code {
        "crm" => Some("CRM"),
        "helpdesk" | "welddesk" => Some("WeldDesk"),
        "mail" | "weldmail" => Some("WeldMail"),
        "projects" | "weldflow" => Some("WeldFlow"),
        "task" | "weldconnect" => Some("WeldConnect"),
        "host" | "weldhost" => Some("WeldHost"),
        "wms" => Some("WMS"),
        "accounting" => Some("Accounting"),
        "parcel" => Some("Parcel"),
        "social" => Some("Social"),
        "weldcrm" => Some("WeldCRM"),
        "weldstash" => Some("WeldStash"),
        "weldbooks" => Some("WeldBooks"),
        "weldchat" => Some("WeldChat"),
        "weldmeet" => Some("WeldMeet"),
        "weldcalendar" => Some("WeldCalendar"),
        "welddrive" => Some("WeldDrive"),
        "welddata" => Some("WeldData"),
        "weldads" => Some("WeldAds"),
        _ => None,
    };
    if let Some(name) = known {
        return name.to_owned();
    }
    let mut chars = code.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `app_code, is_active, granted_at, granted_by` of an assignment.
type Assignment = (String, bool, Option<OffsetDateTime>, Option<String>);

/// A `timestamptz` as the route's `Date` serializes: `toISOString()`.
fn js_date(at: Option<OffsetDateTime>) -> Value {
    weldsuite_schema::js::timestamptz::option::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

async fn apps(caller: Caller, Path(id): Path<String>) -> Response {
    answer(apps_inner(&caller, &id).await)
}

async fn apps_inner(caller: &Caller, id: &str) -> TeamResult<Response> {
    let message = "Failed to fetch member apps";
    let member = find_member(&caller.db, id)
        .await
        .map_err(failed(message))?
        .ok_or_else(|| ApiError::not_found("Member", Some(id)))?;
    let user_id = member["userId"].as_str().unwrap_or_default();
    let db = orm(&caller.db);
    let installed: Vec<String> = installed::Entity::find()
        .select_only()
        .column(installed::Column::AppCode)
        .filter(installed::Column::IsActive.eq(true))
        .filter(installed::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await
        .map_err(failed(message))?;
    let assignments: Vec<Assignment> = assignments::Entity::find()
        .select_only()
        .columns([
            assignments::Column::AppCode,
            assignments::Column::IsActive,
            assignments::Column::GrantedAt,
            assignments::Column::GrantedBy,
        ])
        .filter(assignments::Column::UserId.eq(user_id))
        .into_tuple()
        .all(&db)
        .await
        .map_err(failed(message))?;
    let by_app: HashMap<&str, &Assignment> =
        assignments.iter().map(|a| (a.0.as_str(), a)).collect();
    let data: Vec<Value> = installed
        .iter()
        .map(|code| {
            let assignment = by_app.get(code.as_str());
            json!({
                "appCode": code,
                "appName": app_name(code),
                "isAssigned": assignment.is_some_and(|a| a.1),
                "assignedAt": js_date(assignment.and_then(|a| a.2)),
                "assignedBy": assignment.and_then(|a| a.3.clone()),
            })
        })
        .collect();
    Ok(Data(data).into_response())
}

// ── POST /:id/apps/toggle ───────────────────────────────────────────────────

async fn toggle_app(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(toggle_inner(&caller, &id, &headers, &body).await)
}

async fn toggle_inner(
    caller: &Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let (app_code, enabled) = validate(headers, body, |issues, fields| {
        (
            issues
                .text_with(
                    fields,
                    "appCode",
                    Presence::Required,
                    Text::length(Some(1), None),
                )
                .into_option(),
            issues
                .boolean(fields, "enabled", Presence::Required)
                .into_option(),
        )
    })?;
    let (app_code, enabled) = (app_code.unwrap_or_default(), enabled.unwrap_or_default());
    let message = "Failed to toggle member app";
    let member = find_member(&caller.db, id)
        .await
        .map_err(failed(message))?
        .ok_or_else(|| ApiError::not_found("Member", Some(id)))?;
    let user_id = member["userId"].as_str().unwrap_or_default();
    toggle(&caller.db, user_id, &app_code, enabled, &caller.user_id)
        .await
        .map_err(failed(message))?;
    Ok(Data(json!({ "appCode": app_code, "enabled": enabled })).into_response())
}

/// `toggleMemberApp`: grant (insert or reactivate) or deactivate.
async fn toggle(
    db: &PgPool,
    user_id: &str,
    app_code: &str,
    enabled: bool,
    actor: &str,
) -> Result<(), DbErr> {
    let db = orm(db);
    let existing: Option<String> = assignments::Entity::find()
        .select_only()
        .column(assignments::Column::Id)
        .filter(assignments::Column::UserId.eq(user_id))
        .filter(assignments::Column::AppCode.eq(app_code))
        .into_tuple()
        .one(&db)
        .await?;
    let now = utc_now().assume_utc();
    match (enabled, existing) {
        (_, Some(id)) => {
            assignments::Entity::update_many()
                .col_expr(assignments::Column::IsActive, Expr::value(enabled))
                .col_expr(assignments::Column::UpdatedAt, Expr::value(now))
                .filter(assignments::Column::Id.eq(id))
                .exec(&db)
                .await?;
        }
        (true, None) => {
            assignments::Entity::insert(assignments::ActiveModel {
                id: Set(generate_id("uaa")),
                user_id: Set(user_id.to_owned()),
                app_code: Set(app_code.to_owned()),
                is_active: Set(true),
                granted_at: Set(Some(now)),
                granted_by: Set(Some(actor.to_owned())),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec_without_returning(&db)
            .await?;
        }
        // Revoking an app that was never granted is a no-op.
        (false, None) => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_reads_like_javascript() {
        assert_eq!(parse_int("25"), Some(25));
        assert_eq!(parse_int("  10abc"), Some(10));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn query_keeps_the_first_value() {
        let query = first_values(Some("search=a+b%40c&search=x&limit="));
        assert_eq!(query.get("search").map(String::as_str), Some("a b@c"));
        assert_eq!(query.get("limit").map(String::as_str), Some(""));
    }

    #[test]
    fn app_names_fall_back_to_the_code() {
        assert_eq!(app_name("weldcrm"), "WeldCRM");
        assert_eq!(app_name("zebra"), "Zebra");
        assert_eq!(app_name(""), "");
    }

    #[test]
    fn projection_follows_visibility() {
        let row = json!({
            "id": "wm_1", "userId": "u1", "name": "A", "picture": null, "role": "MEMBER",
            "status": "ACTIVE", "memberType": "INTERNAL", "email": "a@b", "roleId": null,
            "permissions": [], "invitedBy": null, "invitedAt": null, "acceptedAt": null,
            "createdAt": "2026-01-01T00:00:00.000Z", "deletedAt": null,
        });
        assert_eq!(
            project(&row, false, "u2").as_object().map(Map::len),
            Some(7)
        );
        assert_eq!(
            project(&row, false, "u1").as_object().map(Map::len),
            Some(10)
        );
        assert_eq!(
            project(&row, true, "u2").as_object().map(Map::len),
            Some(14)
        );
    }
}
