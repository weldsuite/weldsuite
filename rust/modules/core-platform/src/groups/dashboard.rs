//! `/api/dashboard` (`app-api/src/routes/dashboard`): the workspace home's
//! sections. They span every module, so there is no route gate: each section
//! reads only the object the member may read (`hasContextPermission`, so the
//! routes that check resolve the permissions first with `gate.resolve()`) and
//! comes back empty or zero without it. A failing read answers what the
//! section shows when it has nothing, as the workers do.
//!
//! - `GET /chart`: orders, revenue and tickets per day over the last 30 days
//!   (`orders:read` for the order figures, `tickets:read` for the tickets).
//! - `GET /installed-apps`: the app codes the member can open
//!   (`services/member-apps.ts`). The worker first repairs a member row an
//!   invitation left on its placeholder user id (`ensureMemberLinked`, a Clerk
//!   lookup); the Rust backend does not do that repair yet (no identity
//!   provider on Kubernetes, see `GET /api/me` in core-team), so a member whose
//!   row is unlinked gets the apps of a user without a row.
//! - `GET /activity`: the 20 newest live CRM activities (`activities:read`).
//! - `GET /sidebar-badges`: unread mail in the mailboxes the member may open
//!   (`@weldsuite/mail-domain`'s `listAccessibleAccountIds`, trash and spam
//!   left out), open tickets and pending orders.
//! - `GET /onboarding-checklist` and `POST /onboarding-checklist/dismiss`:
//!   the getting-started items and the apps the checklist was dismissed for
//!   (`workspace_settings.custom_settings`). Dismissing only flips that JSON
//!   flag, so it publishes no entity event.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{js_number, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CorePlatformState, now};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/chart", get(chart).route_layer(gate.resolve()))
        .route("/installed-apps", get(installed_apps))
        .route("/activity", get(activity).route_layer(gate.resolve()))
        .route(
            "/sidebar-badges",
            get(sidebar_badges).route_layer(gate.resolve()),
        )
        .route("/onboarding-checklist", get(onboarding_checklist))
        .route("/onboarding-checklist/dismiss", post(dismiss))
}

// ── JavaScript values ───────────────────────────────────────────────────────

/// A number as `JSON.stringify` writes it: integral values without `.0`.
fn js_number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.is_finite() && number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        // NaN and the infinities are `null` in JSON, as `json!` writes them.
        json!(number)
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value || fallback`.
fn or_else(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(value) if truthy(value) => value.clone(),
        _ => fallback,
    }
}

/// `(settings.customSettings as Record<string, unknown>) || {}`, then
/// `custom.onboardingChecklistDismissedApps || []`: a field of an object
/// only (an array or a string has no such property).
fn dismissed_apps_of(custom: Option<&Value>) -> Value {
    let field = custom
        .and_then(Value::as_object)
        .and_then(|custom| custom.get("onboardingChecklistDismissedApps"));
    or_else(field, json!([]))
}

// ── GET /chart ──────────────────────────────────────────────────────────────

/// One day of the chart.
#[derive(Debug, Clone, PartialEq)]
struct ChartPoint {
    orders: i32,
    tickets: i32,
    revenue: f64,
}

/// `thirtyDaysAgo` (`setDate(getDate() - 30)`), bound as Drizzle binds a
/// `Date`. The worker counts 30 days in its local time zone, which only
/// differs across a daylight-saving change and only by that hour.
fn thirty_days_ago() -> String {
    iso_timestamp(OffsetDateTime::now_utc() - Duration::days(30))
}

async fn chart(caller: Caller) -> Response {
    let points = match chart_points(&caller).await {
        Ok(points) => points,
        Err(error) => {
            tracing::error!(%error, "dashboard: chart failed");
            BTreeMap::new()
        }
    };
    let points: Vec<Value> = points
        .into_iter()
        .map(|(date, point)| {
            json!({
                "date": date,
                "orders": point.orders,
                "tickets": point.tickets,
                "revenue": js_number_value(point.revenue),
            })
        })
        .collect();
    Data(points).into_response()
}

/// The points keyed by date, which sorts them as the worker does
/// (`localeCompare` on `YYYY-MM-DD`).
async fn chart_points(caller: &Caller) -> Result<BTreeMap<String, ChartPoint>, sqlx::Error> {
    let since = thirty_days_ago();
    let mut points = BTreeMap::new();
    if caller.can("orders:read") {
        let rows: Vec<(String, i32, String)> = sqlx::query_as(
            "select to_char(created_at, 'YYYY-MM-DD'), count(*)::int,
                    coalesce(sum(total::numeric), 0)::numeric::text
             from orders
             where deleted_at is null and created_at >= $1::timestamp
             group by to_char(created_at, 'YYYY-MM-DD')
             order by to_char(created_at, 'YYYY-MM-DD')",
        )
        .bind(&since)
        .fetch_all(&caller.db)
        .await?;
        for (date, orders, revenue) in rows {
            let point = ChartPoint {
                orders,
                tickets: 0,
                revenue: js_number(&revenue),
            };
            points.insert(date, point);
        }
    }
    // A failed ticket read leaves the ticket counts out (the worker's own catch).
    if caller.can("tickets:read") {
        let tickets: Result<Vec<(String, i32)>, sqlx::Error> = sqlx::query_as(
            "select to_char(created_at, 'YYYY-MM-DD'), count(*)::int
             from helpdesk_tickets
             where deleted_at is null and created_at >= $1::timestamp
             group by to_char(created_at, 'YYYY-MM-DD')",
        )
        .bind(&since)
        .fetch_all(&caller.db)
        .await;
        match tickets {
            Ok(rows) => {
                for (date, count) in rows {
                    let point = points.entry(date).or_insert(ChartPoint {
                        orders: 0,
                        tickets: 0,
                        revenue: 0.0,
                    });
                    point.tickets = count;
                }
            }
            Err(error) => tracing::warn!(%error, "dashboard: chart tickets failed"),
        }
    }
    Ok(points)
}

// ── GET /installed-apps ─────────────────────────────────────────────────────

/// The apps an EMPLOYEE member can open, whatever their assignments say.
const EMPLOYEE_MEMBER_APPS: [&str; 2] = ["weldhr", "weldchat"];

/// What the worker answers when the lookup fails.
const FALLBACK_APPS: [&str; 6] = [
    "welddesk",
    "weldcrm",
    "weldstash",
    "weldmail",
    "parcel",
    "weldflow",
];

async fn installed_apps(caller: Caller) -> Response {
    match list_member_app_codes(&caller.db, &caller.user_id).await {
        Ok(apps) => Data(apps).into_response(),
        Err(error) => {
            tracing::error!(%error, "dashboard: installed-apps failed");
            Data(FALLBACK_APPS).into_response()
        }
    }
}

/// `listMemberAppCodes`: the installed apps (in rail order) an admin gets
/// whole, an EMPLOYEE member gets WeldHR and WeldChat of, and anyone else
/// gets where their role or an active assignment grants them.
async fn list_member_app_codes(db: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let installed: Vec<String> = sqlx::query_scalar(
        "select app_code from workspace_installed_apps
         where is_active = true and deleted_at is null
         order by display_order asc, created_at asc, app_code asc",
    )
    .fetch_all(db)
    .await?;
    let member: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select role, role_id, member_type::text from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (role, role_id, member_type) = member.unwrap_or_default();
    let role = role.map(|r| r.to_uppercase());
    if matches!(role.as_deref(), Some("OWNER" | "ADMIN")) {
        return Ok(installed);
    }
    if member_type.as_deref() == Some("EMPLOYEE") {
        return Ok(installed
            .into_iter()
            .filter(|code| EMPLOYEE_MEMBER_APPS.contains(&code.as_str()))
            .collect());
    }
    if installed.is_empty() {
        return Ok(installed);
    }
    let mut effective = HashSet::new();
    if let Some(role_id) = role_id.filter(|id| !id.is_empty()) {
        let apps: Option<Option<Value>> = sqlx::query_scalar(
            "select apps from roles where id = $1 and deleted_at is null limit 1",
        )
        .bind(&role_id)
        .fetch_optional(db)
        .await?;
        if let Some(Value::Array(apps)) = apps.flatten() {
            for code in apps.iter().filter_map(Value::as_str) {
                if installed.iter().any(|i| i == code) {
                    effective.insert(code.to_owned());
                }
            }
        }
    }
    let assigned: Vec<String> = sqlx::query_scalar(
        "select app_code from user_app_assignments
         where user_id = $1 and is_active = true and app_code = any($2)",
    )
    .bind(user_id)
    .bind(&installed)
    .fetch_all(db)
    .await?;
    effective.extend(assigned);
    Ok(installed
        .into_iter()
        .filter(|code| effective.contains(code))
        .collect())
}

// ── GET /activity ───────────────────────────────────────────────────────────

async fn activity(caller: Caller) -> Response {
    if !caller.can("activities:read") {
        return Data(Vec::<Value>::new()).into_response();
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(a) from crm_activities a
         where deleted_at is null
         order by created_at desc
         limit 20",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => {
            tracing::error!(%error, "dashboard: activity failed");
            Data(Vec::<Value>::new()).into_response()
        }
    }
}

// ── GET /sidebar-badges ─────────────────────────────────────────────────────

async fn sidebar_badges(caller: Caller) -> Response {
    let unread_messages = match unread_mail(&caller.db, &caller.user_id).await {
        Ok(count) => count,
        Err(error) => {
            tracing::warn!(%error, "dashboard: unread mail badge failed");
            0
        }
    };
    let open_tickets = if caller.can("tickets:read") {
        count_or_zero(
            &caller.db,
            "select count(*)::int from helpdesk_tickets
             where status = 'open' and deleted_at is null",
        )
        .await
    } else {
        0
    };
    let pending_orders = if caller.can("orders:read") {
        count_or_zero(
            &caller.db,
            "select count(*)::int from orders where status = 'pending' and deleted_at is null",
        )
        .await
    } else {
        0
    };
    Data(json!({
        "unreadMessages": unread_messages,
        "openTickets": open_tickets,
        "pendingOrders": pending_orders,
    }))
    .into_response()
}

/// A badge count; 0 when the read fails (the worker's per-badge catch).
async fn count_or_zero(db: &PgPool, sql: &'static str) -> i32 {
    match sqlx::query_scalar::<_, Option<i32>>(sql)
        .fetch_one(db)
        .await
    {
        Ok(count) => count.unwrap_or(0),
        Err(error) => {
            tracing::warn!(%error, "dashboard: badge count failed");
            0
        }
    }
}

/// Unread live mail in the mailboxes `user_id` may open, trash and spam
/// left out (`inTrashOrSpamCondition`); 0 without any mailbox.
async fn unread_mail(db: &PgPool, user_id: &str) -> Result<i32, sqlx::Error> {
    let accounts = accessible_account_ids(db, user_id).await?;
    if accounts.is_empty() {
        return Ok(0);
    }
    let count: Option<i32> = sqlx::query_scalar(
        "select count(*)::int from mail_messages
         where is_read = false and deleted_at is null and account_id = any($1)
           and not (coalesce(labels, '[]'::jsonb) @> '[\"TRASH\"]'::jsonb
                    or coalesce(labels, '[]'::jsonb) @> '[\"SPAM\"]'::jsonb
                    or coalesce(is_trash, false) or coalesce(is_spam, false))",
    )
    .bind(&accounts)
    .fetch_one(db)
    .await?;
    Ok(count.unwrap_or(0))
}

/// `listAccessibleAccountIds` (`@weldsuite/mail-domain/access`): the shared
/// mailboxes, the private ones the user is assigned to, and for an admin or
/// owner the private ones nobody is assigned to.
async fn accessible_account_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let role: Option<Option<String>> = sqlx::query_scalar(
        "select role from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let role = role.flatten().map(|role| role.to_uppercase());
    let is_admin = matches!(role.as_deref(), Some("OWNER" | "ADMIN"));
    let assigned = Value::Array(vec![Value::String(user_id.to_owned())]).to_string();
    sqlx::query_scalar(
        "select id from mail_accounts
         where deleted_at is null
           and (is_shared = true
                or assigned_user_ids @> $1::jsonb
                or ($2 and coalesce(assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)))",
    )
    .bind(&assigned)
    .bind(is_admin)
    .fetch_all(db)
    .await
}

// ── GET /onboarding-checklist ───────────────────────────────────────────────

/// `customSettings` and `logoUrl` of the workspace settings.
type SettingsRow = (Option<Value>, Option<String>);

/// `hasRows(table, deletedAt, ...extra)` per checklist item, in the
/// worker's order. Every table has `deleted_at`.
const CHECKLIST_ITEMS: [(&str, &str); 14] = [
    (
        "crm_customer_created",
        "select count(*)::int from companies where deleted_at is null limit 1",
    ),
    (
        "crm_contact_created",
        "select count(*)::int from people where deleted_at is null and in_crm = true limit 1",
    ),
    (
        "crm_note_created",
        "select count(*)::int from crm_activities where deleted_at is null and type = 'note' limit 1",
    ),
    (
        "crm_task_created",
        "select count(*)::int from tasks where deleted_at is null
           and (customer_id is not null or person_id is not null or contact_id is not null) limit 1",
    ),
    (
        "crm_pipeline_created",
        "select count(*)::int from crm_pipelines where deleted_at is null limit 1",
    ),
    (
        "helpdesk_department_created",
        "select count(*)::int from helpdesk_departments where deleted_at is null limit 1",
    ),
    (
        "mail_account_connected",
        "select count(*)::int from mail_accounts where deleted_at is null limit 1",
    ),
    (
        "project_created",
        "select count(*)::int from projects where deleted_at is null limit 1",
    ),
    (
        "task_created",
        "select count(*)::int from tasks where deleted_at is null limit 1",
    ),
    (
        "host_domain_added",
        "select count(*)::int from domains where deleted_at is null limit 1",
    ),
    (
        "parcel_carrier_configured",
        "select count(*)::int from carriers where deleted_at is null limit 1",
    ),
    (
        "wms_warehouse_added",
        "select count(*)::int from warehouses where deleted_at is null limit 1",
    ),
    (
        "accounting_chart_setup",
        "select count(*)::int from accounts where deleted_at is null limit 1",
    ),
    (
        "social_account_connected",
        "select count(*)::int from social_accounts where deleted_at is null limit 1",
    ),
];

async fn onboarding_checklist(caller: Caller) -> Response {
    let mut dismissed_apps = json!([]);
    let mut has_logo = false;
    let settings: Result<Option<SettingsRow>, sqlx::Error> = sqlx::query_as(
        "select custom_settings, logo_url from workspace_settings
         where deleted_at is null limit 1",
    )
    .fetch_optional(&caller.db)
    .await;
    match settings {
        Ok(Some((custom, logo))) => {
            dismissed_apps = dismissed_apps_of(custom.as_ref());
            has_logo = logo.is_some_and(|logo| !logo.is_empty() && !js_trim(&logo).is_empty());
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "dashboard: checklist settings failed"),
    }

    let mut items = Map::new();
    for (key, sql) in CHECKLIST_ITEMS {
        items.insert(
            key.to_owned(),
            Value::Bool(count_or_zero(&caller.db, sql).await > 0),
        );
    }
    let members = count_or_zero(
        &caller.db,
        "select count(*)::int from workspace_members where deleted_at is null",
    )
    .await;
    items.insert(
        "workspace_member_invited".to_owned(),
        Value::Bool(members > 1),
    );
    items.insert("workspace_logo_uploaded".to_owned(), Value::Bool(has_logo));

    Data(json!({ "dismissedApps": dismissed_apps, "items": items })).into_response()
}

// ── POST /onboarding-checklist/dismiss ──────────────────────────────────────

/// Why a dismissal failed: the worker answers every one of these with
/// `error.internal(c, 'Failed to dismiss checklist')`.
#[derive(Debug)]
enum DismissFailure {
    /// `c.req.json()` threw, or the body could not be destructured.
    Body,
    /// The stored list is not one `includes`/`push` work on.
    StoredList,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for DismissFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

async fn dismiss(caller: Caller, body: Bytes) -> Response {
    let failure = match dismiss_inner(&caller, &body).await {
        Ok(response) => return response,
        Err(failure) => failure,
    };
    match failure {
        DismissFailure::Database(error) => {
            tracing::error!(%error, "dashboard: dismiss onboarding checklist failed");
        }
        other => tracing::error!(?other, "dashboard: dismiss onboarding checklist failed"),
    }
    ApiError::internal()
        .with_message("Failed to dismiss checklist")
        .into_response()
}

/// `await c.req.json()`: the body as JSON whatever its content type (a
/// UTF-8 byte order mark is dropped, as `Response.json()` decodes it).
fn request_json(body: &[u8]) -> Option<Value> {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    serde_json::from_slice(body).ok()
}

/// `{ ...custom }` for the custom settings as stored: an object's fields, an
/// array's indexes; anything else spreads to nothing.
fn spread(custom: &Value) -> Map<String, Value> {
    match custom {
        Value::Object(fields) => fields.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item.clone()))
            .collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

/// `dismissed.includes(appCode)` (`SameValueZero`: an object is never equal
/// to a parsed one).
fn includes(list: &[Value], item: &Value) -> bool {
    list.iter().any(|existing| match (existing, item) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => false,
        (a, b) => a == b,
    })
}

/// The list with `app_code` added once. A stored string answers `includes`
/// (as a substring) but has no `push`; anything else has neither.
fn dismissed_with(stored: Value, app_code: &Value) -> Result<Value, DismissFailure> {
    match stored {
        Value::Array(mut list) => {
            if !includes(&list, app_code) {
                list.push(app_code.clone());
            }
            Ok(Value::Array(list))
        }
        Value::String(text) => match app_code {
            Value::String(code) if text.contains(code.as_str()) => Ok(Value::String(text)),
            _ => Err(DismissFailure::StoredList),
        },
        _ => Err(DismissFailure::StoredList),
    }
}

async fn dismiss_inner(caller: &Caller, body: &[u8]) -> Result<Response, DismissFailure> {
    // `const { appCode } = await c.req.json()`: `null` cannot be destructured.
    let parsed = request_json(body).ok_or(DismissFailure::Body)?;
    if parsed.is_null() {
        return Err(DismissFailure::Body);
    }
    let app_code = parsed.get("appCode").cloned().unwrap_or(Value::Null);
    if !truthy(&app_code) {
        return Ok(ApiError::bad_request("appCode is required").into_response());
    }

    let existing: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, custom_settings from workspace_settings
         where deleted_at is null limit 1",
    )
    .fetch_optional(&caller.db)
    .await?;
    let stamp = now();
    if let Some((id, custom)) = existing {
        let custom = or_else(custom.as_ref(), json!({}));
        let dismissed = dismissed_with(dismissed_apps_of(Some(&custom)), &app_code)?;
        let mut settings = spread(&custom);
        settings.insert("onboardingChecklistDismissedApps".to_owned(), dismissed);
        sqlx::query(
            "update workspace_settings
             set custom_settings = $2::jsonb, updated_at = $3::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(Value::Object(settings))
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
    } else {
        sqlx::query(
            "insert into workspace_settings (id, custom_settings, created_at, updated_at)
             values ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)",
        )
        .bind(generate_id("ws"))
        .bind(json!({ "onboardingChecklistDismissedApps": [app_code] }))
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
    }
    Ok(Data(json!({ "success": true })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_as_javascript_does() {
        assert_eq!(js_number_value(150.0), json!(150));
        assert_eq!(js_number_value(20.25), json!(20.25));
        assert_eq!(js_number_value(js_number("150.00")), json!(150));
        assert_eq!(js_number_value(f64::NAN), Value::Null);
    }

    #[test]
    fn dismissed_apps_read_like_the_worker() {
        assert_eq!(dismissed_apps_of(None), json!([]));
        assert_eq!(dismissed_apps_of(Some(&json!(null))), json!([]));
        assert_eq!(dismissed_apps_of(Some(&json!(["weldcrm"]))), json!([]));
        assert_eq!(
            dismissed_apps_of(Some(
                &json!({ "onboardingChecklistDismissedApps": ["weldcrm"] })
            )),
            json!(["weldcrm"])
        );
        assert_eq!(
            dismissed_apps_of(Some(&json!({ "onboardingChecklistDismissedApps": "" }))),
            json!([])
        );
    }

    #[test]
    fn dismissing_adds_an_app_once() {
        let code = json!("weldcrm");
        assert_eq!(
            dismissed_with(json!([]), &code).ok(),
            Some(json!(["weldcrm"]))
        );
        assert_eq!(
            dismissed_with(json!(["weldcrm"]), &code).ok(),
            Some(json!(["weldcrm"]))
        );
        assert_eq!(
            dismissed_with(json!([{ "a": 1 }]), &json!({ "a": 1 })).ok(),
            Some(json!([{ "a": 1 }, { "a": 1 }]))
        );
        assert!(dismissed_with(json!("weldcrm,welddesk"), &code).is_ok());
        assert!(dismissed_with(json!("welddesk"), &code).is_err());
        assert!(dismissed_with(json!(5), &code).is_err());
    }

    #[test]
    fn custom_settings_spread_like_an_object_literal() {
        assert_eq!(Value::Object(spread(&json!({ "a": 1 }))), json!({ "a": 1 }));
        assert_eq!(Value::Object(spread(&json!(["x"]))), json!({ "0": "x" }));
        assert_eq!(Value::Object(spread(&json!(true))), json!({}));
    }

    #[test]
    fn request_bodies_parse_like_request_json() {
        assert_eq!(
            request_json(b"\xEF\xBB\xBF{\"a\":1}"),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(request_json(b""), None);
        assert_eq!(request_json(b"not json"), None);
    }
}
