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
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row, js_timestamp};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries, role_row_permissions};

use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, now, validate};

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
pub(super) fn failed(message: &'static str) -> impl FnOnce(sqlx::Error) -> TeamError {
    move |error| TeamError::internal(message, error)
}

/// A member row (`select()`), as Drizzle returns it.
async fn member_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from workspace_members m
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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

async fn me_inner(caller: &Caller) -> TeamResult<Response> {
    let row: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
             'id', id, 'userId', user_id, 'email', email, 'name', name,
             'picture', picture, 'role', role, 'roleId', role_id,
             'permissions', permissions, 'status', status, 'memberType', member_type)
         from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
    .await
    .map_err(failed("Failed to fetch current member"))?;
    match row {
        Some(row) => Ok(Data(row).into_response()),
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
    let data = result
        .rows
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

/// `listMembers`, its keyset cursor and its count included.
async fn list_members(db: &PgPool, f: ListFilters<'_>, limit: i64) -> Result<Page, sqlx::Error> {
    let keyset: Option<(String, String)> = match f.cursor {
        Some(cursor) => {
            sqlx::query_as(
                "select date_trunc('milliseconds', created_at)::text, id
                 from workspace_members where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(db)
            .await?
        }
        None => None,
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from workspace_members m
         where deleted_at is null
           and ($1::text is null or status = $1)
           and ($2::text is null or member_type = $2)
           and ($3::text is null or name like $3 or email like $3)
           and ($4::timestamptz is null or created_at < $4::timestamptz
                or (created_at = $4::timestamptz and id < $5))
         order by created_at desc, id desc
         limit $6",
    )
    .bind(f.status)
    .bind(f.member_type)
    .bind(f.search)
    .bind(keyset.as_ref().map(|(at, _)| at.as_str()))
    .bind(keyset.as_ref().map(|(_, id)| id.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
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
    let total: i64 = sqlx::query_scalar(
        "select count(*) from workspace_members
         where (not $1 or deleted_at is null)
           and ($2::text is null or status = $2)
           and ($3::text is null or member_type = $3)
           and ($4::text is null or name like $4 or email like $4)",
    )
    .bind(keep_deleted)
    .bind(status)
    .bind(member_type)
    .bind(search)
    .fetch_one(db)
    .await?;

    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
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
        pagination: Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
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
    Ok(Data(project(&member, admin, &caller.user_id)).into_response())
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

/// The live member's access fields (`findMember`).
async fn find_member(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select jsonb_build_object(
             'userId', user_id, 'role', role, 'roleId', role_id,
             'permissions', permissions, 'permissionDenies', permission_denies,
             'memberType', member_type)
         from workspace_members where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
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
        let row: Option<(Option<Value>, bool, String)> = sqlx::query_as(
            "select permissions, is_system, name from roles
             where id = $1 and deleted_at is null limit 1",
        )
        .bind(role_id)
        .fetch_optional(&caller.db)
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
        "weldcommerce" => Some("WeldCommerce"),
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
type Assignment = (String, bool, Option<String>, Option<String>);

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
    let installed: Vec<String> = sqlx::query_scalar(
        "select app_code from workspace_installed_apps
         where is_active = true and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await
    .map_err(failed(message))?;
    let assignments: Vec<Assignment> = sqlx::query_as(
        "select app_code, is_active, to_jsonb(granted_at) #>> '{}', granted_by
         from user_app_assignments where user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&caller.db)
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
                "assignedAt": assignment.and_then(|a| a.2.as_deref()).and_then(js_timestamp),
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
) -> Result<(), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from user_app_assignments where user_id = $1 and app_code = $2 limit 1",
    )
    .bind(user_id)
    .bind(app_code)
    .fetch_optional(db)
    .await?;
    let now = now();
    match (enabled, existing) {
        (_, Some(id)) => {
            sqlx::query(
                "update user_app_assignments set is_active = $2, updated_at = $3::timestamptz
                 where id = $1",
            )
            .bind(id)
            .bind(enabled)
            .bind(&now)
            .execute(db)
            .await?;
        }
        (true, None) => {
            sqlx::query(
                "insert into user_app_assignments
                     (id, user_id, app_code, is_active, granted_at, granted_by, created_at, updated_at)
                 values ($1, $2, $3, true, $4::timestamptz, $5, $4::timestamptz, $4::timestamptz)",
            )
            .bind(generate_id("uaa"))
            .bind(user_id)
            .bind(app_code)
            .bind(&now)
            .bind(actor)
            .execute(db)
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
