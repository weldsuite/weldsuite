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
use sea_orm::sea_query::{Asterisk, Expr, Func, IntoColumnRef, IntoCondition};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{js_number, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    accounts, carriers, companies, crm_activities, crm_pipelines, domains, helpdesk_departments,
    helpdesk_tickets, mail_accounts, mail_messages, orders, people, projects, roles,
    social_accounts, tasks, user_app_assignments, warehouses, workspace_installed_apps,
    workspace_members, workspace_settings,
};

use crate::{Caller, CorePlatformState};

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
fn thirty_days_ago() -> PrimitiveDateTime {
    utc_timestamp(OffsetDateTime::now_utc() - Duration::days(30))
}

/// `to_char(<column>, 'YYYY-MM-DD')`, the format written as a literal so
/// the select, group and order expressions are the same expression.
fn day_of(column: impl IntoColumnRef) -> Expr {
    Func::cust("to_char")
        .arg(Expr::col(column))
        .arg(Expr::Constant("YYYY-MM-DD".into()))
        .into()
}

/// `count(*)::int`.
fn count_int() -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::from(Func::count(Expr::col(Asterisk))), "int")
}

/// `select count(*)::int from <table> where …`.
async fn count_where<E: EntityTrait>(
    db: &DatabaseConnection,
    condition: impl IntoCondition,
) -> Result<Option<i32>, DbErr> {
    let count: Option<Option<i32>> = E::find()
        .select_only()
        .expr(count_int())
        .filter(condition)
        .into_tuple()
        .one(db)
        .await?;
    Ok(count.flatten())
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
async fn chart_points(caller: &Caller) -> Result<BTreeMap<String, ChartPoint>, DbErr> {
    let since = thirty_days_ago();
    let db = orm(&caller.db);
    let mut points = BTreeMap::new();
    if caller.can("orders:read") {
        use orders::Column as O;
        // `coalesce(sum(total::numeric), 0)::numeric::text`.
        let total = sea_orm::ExprTrait::cast_as(Expr::col(O::Total), "numeric");
        let revenue = Expr::from(Func::coalesce([
            Expr::from(Func::sum(total)),
            Expr::value(0),
        ]));
        let revenue =
            sea_orm::ExprTrait::cast_as(sea_orm::ExprTrait::cast_as(revenue, "numeric"), "text");
        let rows: Vec<(String, i32, String)> = orders::Entity::find()
            .select_only()
            .expr(day_of(O::CreatedAt))
            .expr(count_int())
            .expr(revenue)
            .filter(O::DeletedAt.is_null())
            .filter(O::CreatedAt.gte(since))
            .group_by(day_of(O::CreatedAt))
            .order_by_asc(day_of(O::CreatedAt))
            .into_tuple()
            .all(&db)
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
        use helpdesk_tickets::Column as T;
        let tickets: Result<Vec<(String, i32)>, DbErr> = helpdesk_tickets::Entity::find()
            .select_only()
            .expr(day_of(T::CreatedAt))
            .expr(count_int())
            .filter(T::DeletedAt.is_null())
            .filter(T::CreatedAt.gte(since))
            .group_by(day_of(T::CreatedAt))
            .into_tuple()
            .all(&db)
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
async fn list_member_app_codes(db: &PgPool, user_id: &str) -> Result<Vec<String>, DbErr> {
    use workspace_installed_apps::Column as I;
    use workspace_members::Column as M;
    let db = orm(db);
    let installed: Vec<String> = workspace_installed_apps::Entity::find()
        .select_only()
        .column(I::AppCode)
        .filter(I::IsActive.eq(true))
        .filter(I::DeletedAt.is_null())
        .order_by_asc(I::DisplayOrder)
        .order_by_asc(I::CreatedAt)
        .order_by_asc(I::AppCode)
        .into_tuple()
        .all(&db)
        .await?;
    let member: Option<(Option<String>, Option<String>, Option<String>)> =
        workspace_members::Entity::find()
            .select_only()
            .columns([M::Role, M::RoleId, M::MemberType])
            .filter(M::UserId.eq(user_id))
            .filter(M::DeletedAt.is_null())
            .into_tuple()
            .one(&db)
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
        let apps: Option<Option<Value>> = roles::Entity::find()
            .select_only()
            .column(roles::Column::Apps)
            .filter(roles::Column::Id.eq(&role_id))
            .filter(roles::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&db)
            .await?;
        if let Some(Value::Array(apps)) = apps.flatten() {
            for code in apps.iter().filter_map(Value::as_str) {
                if installed.iter().any(|i| i == code) {
                    effective.insert(code.to_owned());
                }
            }
        }
    }
    let assigned: Vec<String> = user_app_assignments::Entity::find()
        .select_only()
        .column(user_app_assignments::Column::AppCode)
        .filter(user_app_assignments::Column::UserId.eq(user_id))
        .filter(user_app_assignments::Column::IsActive.eq(true))
        .filter(user_app_assignments::Column::AppCode.is_in(installed.clone()))
        .into_tuple()
        .all(&db)
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
    let rows = crm_activities::Entity::find()
        .filter(crm_activities::Column::DeletedAt.is_null())
        .order_by_desc(crm_activities::Column::CreatedAt)
        .limit(20)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => {
            tracing::error!(%error, "dashboard: activity failed");
            Data(Vec::<Value>::new()).into_response()
        }
    }
}

// ── GET /sidebar-badges ─────────────────────────────────────────────────────

async fn sidebar_badges(caller: Caller) -> Response {
    let db = orm(&caller.db);
    let unread_messages = match unread_mail(&db, &caller.user_id).await {
        Ok(count) => count,
        Err(error) => {
            tracing::warn!(%error, "dashboard: unread mail badge failed");
            0
        }
    };
    let open_tickets = if caller.can("tickets:read") {
        count_or_zero(
            count_where::<helpdesk_tickets::Entity>(
                &db,
                Condition::all()
                    .add(helpdesk_tickets::Column::Status.eq("open"))
                    .add(helpdesk_tickets::Column::DeletedAt.is_null()),
            )
            .await,
        )
    } else {
        0
    };
    let pending_orders = if caller.can("orders:read") {
        count_or_zero(
            count_where::<orders::Entity>(
                &db,
                Condition::all()
                    .add(orders::Column::Status.eq("pending"))
                    .add(orders::Column::DeletedAt.is_null()),
            )
            .await,
        )
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
fn count_or_zero(count: Result<Option<i32>, DbErr>) -> i32 {
    match count {
        Ok(count) => count.unwrap_or(0),
        Err(error) => {
            tracing::warn!(%error, "dashboard: badge count failed");
            0
        }
    }
}

/// `coalesce(<column>, '[]'::jsonb)`.
fn json_list(column: impl IntoColumnRef) -> Expr {
    Func::coalesce([Expr::col(column), Expr::value(json!([]))]).into()
}

/// Unread live mail in the mailboxes `user_id` may open, trash and spam
/// left out (`inTrashOrSpamCondition`); 0 without any mailbox.
async fn unread_mail(db: &DatabaseConnection, user_id: &str) -> Result<i32, DbErr> {
    use mail_messages::Column as M;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let accounts = accessible_account_ids(db, user_id).await?;
    if accounts.is_empty() {
        return Ok(0);
    }
    let flag = |column: M| Expr::from(Func::coalesce([Expr::col(column), Expr::value(false)]));
    let trash_or_spam = Condition::any()
        .add(PgExpr::contains(json_list(M::Labels), json!(["TRASH"])))
        .add(PgExpr::contains(json_list(M::Labels), json!(["SPAM"])))
        .add(flag(M::IsTrash))
        .add(flag(M::IsSpam));
    let count = count_where::<mail_messages::Entity>(
        db,
        Condition::all()
            .add(M::IsRead.eq(false))
            .add(M::DeletedAt.is_null())
            .add(M::AccountId.is_in(accounts))
            .add(trash_or_spam.not()),
    )
    .await?;
    Ok(count.unwrap_or(0))
}

/// `listAccessibleAccountIds` (`@weldsuite/mail-domain/access`): the shared
/// mailboxes, the private ones the user is assigned to, and for an admin or
/// owner the private ones nobody is assigned to.
async fn accessible_account_ids(
    db: &DatabaseConnection,
    user_id: &str,
) -> Result<Vec<String>, DbErr> {
    use mail_accounts::Column as A;
    use sea_orm::sea_query::extension::postgres::PgExpr;
    let role: Option<Option<String>> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Role)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    let role = role.flatten().map(|role| role.to_uppercase());
    let is_admin = matches!(role.as_deref(), Some("OWNER" | "ADMIN"));
    let mut visible = Condition::any()
        .add(A::IsShared.eq(true))
        .add(PgExpr::contains(
            Expr::col(A::AssignedUserIds),
            json!([user_id]),
        ));
    if is_admin {
        visible = visible.add(sea_orm::ExprTrait::is_in(
            json_list(A::AssignedUserIds),
            [json!([]), Value::Null],
        ));
    }
    mail_accounts::Entity::find()
        .select_only()
        .column(A::Id)
        .filter(A::DeletedAt.is_null())
        .filter(visible)
        .into_tuple()
        .all(db)
        .await
}

// ── GET /onboarding-checklist ───────────────────────────────────────────────

/// `customSettings` and `logoUrl` of the workspace settings.
type SettingsRow = (Option<Value>, Option<String>);

/// The checklist items, in the worker's order.
const CHECKLIST_ITEMS: [&str; 14] = [
    "crm_customer_created",
    "crm_contact_created",
    "crm_note_created",
    "crm_task_created",
    "crm_pipeline_created",
    "helpdesk_department_created",
    "mail_account_connected",
    "project_created",
    "task_created",
    "host_domain_added",
    "parcel_carrier_configured",
    "wms_warehouse_added",
    "accounting_chart_setup",
    "social_account_connected",
];

/// `hasRows(table, deletedAt, ...extra)` for a checklist item: `select
/// count(*)::int from <table> where deleted_at is null …`. Every table has
/// `deleted_at`.
async fn checklist_count(db: &DatabaseConnection, item: &str) -> Result<Option<i32>, DbErr> {
    match item {
        "crm_customer_created" => {
            count_where::<companies::Entity>(db, companies::Column::DeletedAt.is_null()).await
        }
        "crm_contact_created" => {
            let live = Condition::all()
                .add(people::Column::DeletedAt.is_null())
                .add(people::Column::InCrm.eq(true));
            count_where::<people::Entity>(db, live).await
        }
        "crm_note_created" => {
            let notes = Condition::all()
                .add(crm_activities::Column::DeletedAt.is_null())
                .add(crm_activities::Column::Type.eq("note"));
            count_where::<crm_activities::Entity>(db, notes).await
        }
        "crm_task_created" => {
            let linked = Condition::any()
                .add(tasks::Column::CustomerId.is_not_null())
                .add(tasks::Column::PersonId.is_not_null())
                .add(tasks::Column::ContactId.is_not_null());
            let crm = Condition::all()
                .add(tasks::Column::DeletedAt.is_null())
                .add(linked);
            count_where::<tasks::Entity>(db, crm).await
        }
        "crm_pipeline_created" => {
            count_where::<crm_pipelines::Entity>(db, crm_pipelines::Column::DeletedAt.is_null())
                .await
        }
        "helpdesk_department_created" => {
            count_where::<helpdesk_departments::Entity>(
                db,
                helpdesk_departments::Column::DeletedAt.is_null(),
            )
            .await
        }
        "mail_account_connected" => {
            count_where::<mail_accounts::Entity>(db, mail_accounts::Column::DeletedAt.is_null())
                .await
        }
        "project_created" => {
            count_where::<projects::Entity>(db, projects::Column::DeletedAt.is_null()).await
        }
        "task_created" => {
            count_where::<tasks::Entity>(db, tasks::Column::DeletedAt.is_null()).await
        }
        "host_domain_added" => {
            count_where::<domains::Entity>(db, domains::Column::DeletedAt.is_null()).await
        }
        "parcel_carrier_configured" => {
            count_where::<carriers::Entity>(db, carriers::Column::DeletedAt.is_null()).await
        }
        "wms_warehouse_added" => {
            count_where::<warehouses::Entity>(db, warehouses::Column::DeletedAt.is_null()).await
        }
        "accounting_chart_setup" => {
            count_where::<accounts::Entity>(db, accounts::Column::DeletedAt.is_null()).await
        }
        _ => {
            count_where::<social_accounts::Entity>(db, social_accounts::Column::DeletedAt.is_null())
                .await
        }
    }
}

async fn onboarding_checklist(caller: Caller) -> Response {
    let mut dismissed_apps = json!([]);
    let mut has_logo = false;
    let db = orm(&caller.db);
    let settings: Result<Option<SettingsRow>, DbErr> = workspace_settings::Entity::find()
        .select_only()
        .columns([
            workspace_settings::Column::CustomSettings,
            workspace_settings::Column::LogoUrl,
        ])
        .filter(workspace_settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
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
    for key in CHECKLIST_ITEMS {
        items.insert(
            key.to_owned(),
            Value::Bool(count_or_zero(checklist_count(&db, key).await) > 0),
        );
    }
    let members = count_or_zero(
        count_where::<workspace_members::Entity>(
            &db,
            workspace_members::Column::DeletedAt.is_null(),
        )
        .await,
    );
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
    Database(DbErr),
}

impl From<DbErr> for DismissFailure {
    fn from(error: DbErr) -> Self {
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
    use workspace_settings::Column as S;
    // `const { appCode } = await c.req.json()`: `null` cannot be destructured.
    let parsed = request_json(body).ok_or(DismissFailure::Body)?;
    if parsed.is_null() {
        return Err(DismissFailure::Body);
    }
    let app_code = parsed.get("appCode").cloned().unwrap_or(Value::Null);
    if !truthy(&app_code) {
        return Ok(ApiError::bad_request("appCode is required").into_response());
    }

    let db = orm(&caller.db);
    let existing: Option<(String, Option<Value>)> = workspace_settings::Entity::find()
        .select_only()
        .columns([S::Id, S::CustomSettings])
        .filter(S::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let stamp = utc_now().assume_utc();
    if let Some((id, custom)) = existing {
        let custom = or_else(custom.as_ref(), json!({}));
        let dismissed = dismissed_with(dismissed_apps_of(Some(&custom)), &app_code)?;
        let mut settings = spread(&custom);
        settings.insert("onboardingChecklistDismissedApps".to_owned(), dismissed);
        workspace_settings::Entity::update_many()
            .col_expr(S::CustomSettings, Expr::value(Value::Object(settings)))
            .col_expr(S::UpdatedAt, Expr::value(stamp))
            .filter(S::Id.eq(&id))
            .exec(&db)
            .await?;
    } else {
        let settings = workspace_settings::ActiveModel {
            id: Set(generate_id("ws")),
            custom_settings: Set(Some(
                json!({ "onboardingChecklistDismissedApps": [app_code] }),
            )),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        };
        workspace_settings::Entity::insert(settings)
            .exec_without_returning(&db)
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
