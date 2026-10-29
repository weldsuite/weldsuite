//! `/api/time-entries` (`routes/time-entries/index.ts`): WeldFlow time
//! tracking.
//!
//! - The list reads the caller's own entries; `scope=team` with a
//!   `projectId` reads the project's, for those who manage it. `/:id`,
//!   PATCH and DELETE are owner-only (another user's entry is a 404).
//! - Approve / reject are for whoever manages the entry's project, never on
//!   one's own entry; an approved entry is locked until it is rejected.
//! - Writes check the caller may write to the project (and task) the hours
//!   land on, and a user logs at most 24 hours a day.
//! - `/timer`: the caller's running timer (one per user); stopping it
//!   writes a time entry.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_TIME_ENTRY_CREATED, PROJECT_TIME_ENTRY_DELETED, PROJECT_TIME_ENTRY_UPDATED,
    PROJECT_TIMESHEET_APPROVED, PROJECT_TIMESHEET_REJECTED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::iso_timestamp;
use weldsuite_flow_domain::analytics::time_entry_analytics_payload;
use weldsuite_flow_domain::js::{js_date, math_round, number_text, number_value, numeric, to_fixed};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, js_number, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::tasks::query_boolean;
use crate::{Caller, FlowState, Query, Refusal, Reply, reply, validate, validate_value};

/// Approved hours are final until a manager rejects the entry.
const APPROVED_LOCKED: &str =
    "Approved time entries are locked. A project manager has to reject the entry before it can change.";
const TEAM_DENIED: &str = "You cannot view the team timesheet for this project";
/// A calendar day only has 24 hours.
const MAX_MINUTES_PER_DAY: f64 = 24.0 * 60.0;

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("time:read")))
        .route("/", post(create).route_layer(need("time:create")))
        .route("/team-summary", get(team_summary).route_layer(need("time:read")))
        .route("/timer", get(timer).route_layer(need("time:read")))
        .route("/timer", delete(discard_timer).route_layer(need("time:create")))
        .route("/timer/start", post(start_timer).route_layer(need("time:create")))
        .route("/timer/stop", post(stop_timer).route_layer(need("time:create")))
        .route("/{id}", get(detail).route_layer(need("time:read")))
        .route("/{id}", patch(update).route_layer(need("time:update")))
        .route("/{id}", delete(remove).route_layer(need("time:delete")))
        .route("/{id}/approve", patch(approve).route_layer(need("time:update")))
        .route("/{id}/reject", patch(reject).route_layer(need("time:update")))
        .with_state(state)
}

// ── Shared ──────────────────────────────────────────────────────────────────


/// `new Date()` as an ISO timestamp and its milliseconds.
fn now_stamp() -> (String, i64) {
    let now = OffsetDateTime::now_utc();
    let ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
    (iso_timestamp(now), ms)
}

/// `Number(value)` of a string-or-number body value, or of a numeric
/// column's text.
fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::String(text) => js_number(text),
        other => numeric(other),
    }
}

/// `String(value)` of a string-or-number body value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// `computeCost(rate, duration)`: `String((duration / 60) * rate)`.
fn compute_cost(rate: Option<&Value>, duration: Option<&Value>) -> Option<String> {
    let (Some(rate), Some(duration)) = (rate, duration) else {
        return None;
    };
    if rate.is_null() || duration.is_null() {
        return None;
    }
    let r = js_number_of(rate);
    let d = js_number_of(duration);
    if !r.is_finite() || !d.is_finite() {
        return None;
    }
    Some(number_text((d / 60.0) * r))
}

fn format_hours(minutes: f64) -> String {
    format!("{}h", number_text(math_round((minutes / 60.0) * 100.0) / 100.0))
}

/// `dailyLimitViolation`: the user-facing message when the entry is not a
/// valid duration, is longer than 24 hours, or would push the user's day
/// past 24 hours.
async fn daily_limit_violation(
    db: &PgPool,
    user_id: &str,
    date: &str,
    minutes: &Value,
    exclude_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let minutes = match minutes {
        Value::String(text) => {
            let raw = js_trim(text);
            if raw.is_empty() { f64::NAN } else { js_number(raw) }
        }
        other => js_number_of(other),
    };
    if !minutes.is_finite() || minutes < 0.0 {
        return Ok(Some(
            "Duration must be a non-negative number of minutes".to_owned(),
        ));
    }
    if minutes > MAX_MINUTES_PER_DAY {
        return Ok(Some(format!(
            "A time entry cannot be longer than 24 hours (got {})",
            format_hours(minutes)
        )));
    }
    let logged: f64 = sqlx::query_scalar(
        "select coalesce(sum(duration), 0)::float8 from time_entries
         where deleted_at is null and user_id = $1 and date = $2::date
           and ($3::text is null or id <> $3)",
    )
    .bind(user_id)
    .bind(date)
    .bind(exclude_id)
    .fetch_one(db)
    .await?;
    if logged + minutes > MAX_MINUTES_PER_DAY {
        return Ok(Some(format!(
            "You cannot log more than 24 hours on a single day: {date} already has {} logged, \
             and adding {} would exceed the limit",
            format_hours(logged),
            format_hours(minutes)
        )));
    }
    Ok(None)
}

/// A live task's project: `None` when the task is gone, `Some(None)` for
/// a task without a project.
async fn task_project(db: &PgPool, task_id: &str) -> Result<Option<Option<String>>, sqlx::Error> {
    sqlx::query_scalar("select project_id from tasks where id = $1 and deleted_at is null limit 1")
        .bind(task_id)
        .fetch_optional(db)
        .await
}

/// `resolveEntryTarget`: the project the entry belongs to (a task's project
/// wins when none is given), once the caller may write there.
async fn resolve_entry_target(
    caller: &Caller,
    project_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<String>, Refusal> {
    let mut project = project_id.map(str::to_owned);
    if let Some(task_id) = task_id.filter(|t| !t.is_empty()) {
        let Some(task_project) = task_project(&caller.db, task_id).await? else {
            return Err(Refusal::not_found("Task", task_id));
        };
        if let Some(task_project) = task_project.filter(|p| !p.is_empty()) {
            if project.as_deref().is_some_and(|p| !p.is_empty() && p != task_project) {
                return Err(Refusal::bad_request(
                    "The task does not belong to the given project",
                ));
            }
            project = Some(task_project);
        }
    }
    if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(
            "You do not have write access to this project",
        ));
    }
    Ok(project)
}

/// `usableTaskId`: the task when it still exists and fits the project.
async fn usable_task_id(
    db: &PgPool,
    task_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(task_id) = task_id.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let Some(task_project) = task_project(db, task_id).await? else {
        return Ok(None);
    };
    if let Some(task_project) = task_project.filter(|p| !p.is_empty())
        && Some(task_project.as_str()) != project_id
    {
        return Ok(None);
    }
    Ok(Some(task_id.to_owned()))
}

/// A body string field that is set.
fn text(fields: &Map<String, Value>, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `new Date(text)` for a timestamp column; an invalid date throws.
fn timestamp(text: &str) -> Result<String, Refusal> {
    js_date(text).ok_or_else(|| Refusal::Internal("RangeError: Invalid time value".to_owned()))
}

/// `data.startTime ? new Date(data.startTime) : null`.
fn optional_timestamp(fields: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match fields.get(key).and_then(Value::as_str).filter(|t| !t.is_empty()) {
        Some(text) => timestamp(text).map(Some),
        None => Ok(None),
    }
}

// ── Body schemas ────────────────────────────────────────────────────────────

/// `createTimeEntrySchema` (`.partial()` with a nullable `taskId` for a
/// PATCH): the parsed fields, defaults applied.
fn read_entry(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let mut put = |key: &str, value: Field<Value>| match value {
        Field::Set(value) => {
            out.insert(key.to_owned(), value);
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    };
    let string = |issues: &mut Issues, key: &str, presence: Presence| match issues.text(
        fields, key, presence, None, None,
    ) {
        Field::Set(text) => Field::Set(Value::String(text)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    let boolean = |issues: &mut Issues, key: &str| match issues.boolean(fields, key, Presence::Optional) {
        Field::Set(flag) => Field::Set(Value::Bool(flag)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    put("projectId", string(issues, "projectId", Presence::Optional));
    let task_presence = if partial {
        Presence::Nullish
    } else {
        Presence::Optional
    };
    put("taskId", string(issues, "taskId", task_presence));
    put("date", string(issues, "date", required));
    put("duration", issues.string_or_number(fields, "duration", required));
    put("description", string(issues, "description", Presence::Optional));
    put("activity", string(issues, "activity", Presence::Optional));
    let billable = boolean(issues, "billable");
    put("billable", billable);
    put("rate", issues.string_or_number(fields, "rate", Presence::Optional));
    put("startTime", string(issues, "startTime", Presence::Optional));
    put("endTime", string(issues, "endTime", Presence::Optional));
    put("location", string(issues, "location", Presence::Optional));
    let is_remote = boolean(issues, "isRemote");
    put("isRemote", is_remote);
    if !partial {
        // `.default(true)` / `.default(false)`.
        out.entry("billable".to_owned()).or_insert(Value::Bool(true));
        out.entry("isRemote".to_owned()).or_insert(Value::Bool(false));
    }
    out
}

/// `startTimerSchema` (`.partial().extend({ timeZone })` to stop one).
fn read_timer(issues: &mut Issues, fields: &Map<String, Value>, stop: bool) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["projectId", "taskId", "description", "activity"] {
        if let Some(text) = issues.text(fields, key, Presence::Optional, None, None).into_option() {
            out.insert(key.to_owned(), Value::String(text));
        }
    }
    match issues.boolean(fields, "billable", Presence::Optional) {
        Field::Set(flag) => {
            out.insert("billable".to_owned(), Value::Bool(flag));
        }
        _ if !stop => {
            out.insert("billable".to_owned(), Value::Bool(true));
        }
        _ => {}
    }
    if let Field::Set(rate) = issues.string_or_number(fields, "rate", Presence::Optional) {
        out.insert("rate".to_owned(), rate);
    }
    if stop {
        let zone = issues.text(fields, "timeZone", Presence::Optional, None, Some(64));
        // `.refine(...)`, run once the value is a string (even a too long one).
        if let Some(Value::String(name)) = fields.get("timeZone") {
            if jiff::tz::TimeZone::get(name).is_err() {
                issues.custom("timeZone", "Unknown time zone");
            } else if let Some(zone) = zone.into_option() {
                out.insert("timeZone".to_owned(), Value::String(zone));
            }
        }
    }
    out
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `listFiltersSchema` / `teamSummarySchema`.
#[derive(Default)]
struct Filters {
    project_id: Option<String>,
    task_id: Option<String>,
    user_id: Option<String>,
    status: Option<String>,
    billable: Option<bool>,
    from_date: Option<String>,
    to_date: Option<String>,
    page: Option<i64>,
    limit: Option<i64>,
    team: bool,
}

fn query_int(issues: &mut Issues, fields: &Map<String, Value>, key: &str, max: Option<f64>) -> Option<i64> {
    issues
        .whole_number(
            fields,
            key,
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max,
            },
        )
        .into_option()
}

fn query_str(issues: &mut Issues, fields: &Map<String, Value>, key: &str, presence: Presence) -> Option<String> {
    issues.text(fields, key, presence, None, None).into_option()
}

fn read_list_filters(issues: &mut Issues, f: &Map<String, Value>) -> Filters {
    let project_id = query_str(issues, f, "projectId", Presence::Optional);
    let task_id = query_str(issues, f, "taskId", Presence::Optional);
    let user_id = query_str(issues, f, "userId", Presence::Optional);
    let status = query_str(issues, f, "status", Presence::Optional);
    let billable = query_boolean(issues, f, "billable");
    let from_date = query_str(issues, f, "fromDate", Presence::Optional);
    let to_date = query_str(issues, f, "toDate", Presence::Optional);
    let page = query_int(issues, f, "page", None);
    let limit = query_int(issues, f, "limit", Some(500.0));
    let _search = query_str(issues, f, "search", Presence::Optional);
    let scope = issues
        .choice(f, "scope", Presence::Optional, &["own", "team"])
        .into_option();
    Filters {
        project_id,
        task_id,
        user_id,
        status,
        billable,
        from_date,
        to_date,
        page,
        limit,
        team: scope.as_deref() == Some("team"),
    }
}

fn read_summary_filters(issues: &mut Issues, f: &Map<String, Value>) -> Filters {
    let project_id = query_str(issues, f, "projectId", Presence::Required);
    let task_id = query_str(issues, f, "taskId", Presence::Optional);
    let user_id = query_str(issues, f, "userId", Presence::Optional);
    let status = query_str(issues, f, "status", Presence::Optional);
    let billable = query_boolean(issues, f, "billable");
    let from_date = query_str(issues, f, "fromDate", Presence::Optional);
    let to_date = query_str(issues, f, "toDate", Presence::Optional);
    let limit = query_int(issues, f, "limit", Some(2000.0));
    Filters {
        project_id,
        task_id,
        user_id,
        status,
        billable,
        from_date,
        to_date,
        limit,
        team: true,
        ..Filters::default()
    }
}

/// A set, non-empty filter (`if (f.x)`).
fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let filters = match validate_value(&Value::Object(q.values().clone()), read_list_filters) {
        Ok(filters) => filters,
        Err(refused) => return refused.respond("Invalid query"),
    };
    crate::outside(list_entries(&caller, filters).await)
}

async fn list_entries(caller: &Caller, f: Filters) -> Reply {
    let page = f.page.unwrap_or(1);
    let limit = f.limit.unwrap_or(50);
    let offset = (page - 1).saturating_mul(limit);
    if f.team {
        let Some(project_id) = present(&f.project_id) else {
            return Err(Refusal::bad_request("scope=team requires a projectId"));
        };
        if !caller.can_manage(project_id).await? {
            return Err(Refusal::forbidden(TEAM_DENIED));
        }
    }
    // Own scope pins the caller; a team read may narrow to one member.
    let user = if f.team {
        present(&f.user_id).map(str::to_owned)
    } else {
        Some(caller.user_id.clone())
    };
    let result = async {
        let rows: Vec<(Value, Option<String>, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as(concat!(
                "select ",
                time_entry_json!("t"),
                ", wm.name, wm.email, wm.picture, tk.title from time_entries t",
                " left join workspace_members wm on t.user_id = wm.user_id",
                " left join tasks tk on t.task_id = tk.id",
                " where t.deleted_at is null",
                " and ($1::text is null or t.user_id = $1)",
                " and ($2::text is null or t.project_id = $2)",
                " and ($3::text is null or t.task_id = $3)",
                " and ($4::text is null or t.status = $4)",
                " and ($5::bool is null or t.billable = $5)",
                " and ($6::text is null or t.date >= $6::date)",
                " and ($7::text is null or t.date <= $7::date)",
                " order by t.date desc, t.created_at desc limit $8 offset $9"
            ))
            .bind(&user)
            .bind(present(&f.project_id))
            .bind(present(&f.task_id))
            .bind(present(&f.status))
            .bind(f.billable)
            .bind(present(&f.from_date))
            .bind(present(&f.to_date))
            .bind(limit)
            .bind(offset)
            .fetch_all(&caller.db)
            .await?;
        let total: i32 = sqlx::query_scalar(concat!(
            "select count(*)::int from time_entries t where t.deleted_at is null",
            " and ($1::text is null or t.user_id = $1)",
            " and ($2::text is null or t.project_id = $2)",
            " and ($3::text is null or t.task_id = $3)",
            " and ($4::text is null or t.status = $4)",
            " and ($5::bool is null or t.billable = $5)",
            " and ($6::text is null or t.date >= $6::date)",
            " and ($7::text is null or t.date <= $7::date)"
        ))
        .bind(&user)
        .bind(present(&f.project_id))
        .bind(present(&f.task_id))
        .bind(present(&f.status))
        .bind(f.billable)
        .bind(present(&f.from_date))
        .bind(present(&f.to_date))
        .fetch_one(&caller.db)
        .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|(row, name, email, avatar, task_title)| {
                let mut row = js_row(row);
                let user_id = row["userId"].clone();
                let task_id = row["taskId"].as_str().filter(|t| !t.is_empty()).map(str::to_owned);
                let display = name
                    .or_else(|| email.clone())
                    .map_or_else(|| user_id.clone(), Value::String);
                if let Value::Object(fields) = &mut row {
                    fields.insert(
                        "user".to_owned(),
                        json!({
                            "id": user_id,
                            "name": display,
                            "email": email.unwrap_or_default(),
                            "avatar": avatar.unwrap_or_default(),
                        }),
                    );
                    if let (Some(task_id), Some(title)) =
                        (task_id, task_title.filter(|t| !t.is_empty()))
                    {
                        fields.insert("task".to_owned(), json!({ "id": task_id, "title": title }));
                    }
                }
                row
            })
            .collect();
        let total = i64::from(total);
        let returned = i64::try_from(rows.len()).unwrap_or(i64::MAX);
        Ok(weldsuite_kit::List::new(
            rows,
            weldsuite_kit::Pagination::new(
                u64::try_from(total).unwrap_or(0),
                offset + returned < total,
                None,
            ),
        )
        .into_response())
    }
    .await;
    Ok(reply(result, "Failed to list time entries"))
}

// ── GET /team-summary ───────────────────────────────────────────────────────

/// One member's totals.
struct Bucket {
    user_id: String,
    name: String,
    email: String,
    avatar: String,
    role: Option<String>,
    is_active_member: bool,
    total: f64,
    billable: f64,
    non_billable: f64,
    entries: i64,
}

impl Bucket {
    /// `blank(userId, info, isActiveMember)`.
    fn blank(
        user_id: &str,
        name: Option<String>,
        email: Option<String>,
        avatar: Option<String>,
        role: Option<String>,
        is_active_member: bool,
    ) -> Self {
        let name = name
            .or_else(|| email.clone())
            .unwrap_or_else(|| user_id.to_owned());
        Self {
            user_id: user_id.to_owned(),
            name,
            email: email.unwrap_or_default(),
            avatar: avatar.unwrap_or_default(),
            role,
            is_active_member,
            total: 0.0,
            billable: 0.0,
            non_billable: 0.0,
            entries: 0,
        }
    }

    fn to_value(&self) -> Value {
        let initials: String = weldsuite_flow_domain::js::slice_utf16(&self.name, 2).to_uppercase();
        json!({
            "userId": self.user_id,
            "name": self.name,
            "email": self.email,
            "avatar": self.avatar,
            "initials": initials,
            "role": self.role,
            "isActiveMember": self.is_active_member,
            "totalMinutes": number_value(self.total),
            "billableMinutes": number_value(self.billable),
            "nonBillableMinutes": number_value(self.non_billable),
            "entryCount": self.entries,
        })
    }
}

/// `new Map()` keyed by user: a later `set` keeps the first position.
#[derive(Default)]
struct Roster {
    order: Vec<String>,
    by_user: HashMap<String, Bucket>,
}

impl Roster {
    fn set(&mut self, bucket: Bucket) {
        if !self.by_user.contains_key(&bucket.user_id) {
            self.order.push(bucket.user_id.clone());
        }
        self.by_user.insert(bucket.user_id.clone(), bucket);
    }

    fn has(&self, user: &str) -> bool {
        self.by_user.contains_key(user)
    }
}

type MemberRow = (String, Option<String>, Option<String>, Option<String>, Option<String>);
type TotalRow = (String, Option<bool>, f64, i32);

async fn team_summary(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let filters = match validate_value(&Value::Object(q.values().clone()), read_summary_filters) {
        Ok(filters) => filters,
        Err(refused) => return refused.respond("Invalid query"),
    };
    let project_id = filters.project_id.clone().unwrap_or_default();
    match caller.can_manage(&project_id).await {
        Ok(true) => {}
        Ok(false) => return crate::forbidden(TEAM_DENIED),
        Err(error) => return crate::outside(Err(error.into())),
    }
    reply(
        summarise(&caller, &project_id, &filters).await,
        "Failed to fetch team timesheet summary",
    )
}

/// The WHERE of the summary queries (`buildTeamSummaryConditions`), on `t`.
macro_rules! summary_where {
    () => {
        concat!(
            " where t.deleted_at is null and t.project_id = $1",
            " and ($2::text is null or t.user_id = $2)",
            " and ($3::text is null or t.task_id = $3)",
            " and ($4::text is null or t.status = $4)",
            " and ($5::bool is null or t.billable = $5)",
            " and ($6::text is null or t.date >= $6::date)",
            " and ($7::text is null or t.date <= $7::date)"
        )
    };
}

async fn summarise(caller: &Caller, project_id: &str, f: &Filters) -> Reply {
    let db = &caller.db;
    let project: Option<(String, String)> = sqlx::query_as(
        "select id, name from projects where id = $1 and deleted_at is null limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let Some((project_id, project_name)) = project else {
        return Err(Refusal::not_found("Project", project_id));
    };
    let members: Vec<MemberRow> = sqlx::query_as(
        "select pm.user_id, pm.role, wm.name, wm.email, wm.picture from project_members pm
         left join workspace_members wm on pm.user_id = wm.user_id
         where pm.project_id = $1 and pm.is_active = true and pm.deleted_at is null",
    )
    .bind(&project_id)
    .fetch_all(db)
    .await?;
    let totals: Vec<TotalRow> = sqlx::query_as(concat!(
        "select t.user_id, t.billable, coalesce(sum(t.duration), 0)::float8, count(*)::int",
        " from time_entries t",
        summary_where!(),
        " group by t.user_id, t.billable"
    ))
    .bind(&project_id)
    .bind(present(&f.user_id))
    .bind(present(&f.task_id))
    .bind(present(&f.status))
    .bind(f.billable)
    .bind(present(&f.from_date))
    .bind(present(&f.to_date))
    .fetch_all(db)
    .await?;
    let entries: Vec<Value> = sqlx::query_scalar(concat!(
        "select jsonb_build_object('id', t.id, 'project_id', t.project_id, 'task_id', t.task_id,",
        " 'user_id', t.user_id, 'date', t.date, 'start_time', t.start_time, 'end_time', t.end_time,",
        " 'duration', t.duration::text, 'description', t.description, 'activity', t.activity,",
        " 'billable', t.billable, 'status', t.status, 'task_title', tk.title)",
        " from time_entries t left join tasks tk on t.task_id = tk.id",
        summary_where!(),
        " order by t.date desc, t.created_at desc limit $8"
    ))
    .bind(&project_id)
    .bind(present(&f.user_id))
    .bind(present(&f.task_id))
    .bind(present(&f.status))
    .bind(f.billable)
    .bind(present(&f.from_date))
    .bind(present(&f.to_date))
    .bind(f.limit.unwrap_or(1000))
    .fetch_all(db)
    .await?;

    // The roster first (zero-hour members included), then anyone with hours
    // who has since left the project.
    let mut roster = Roster::default();
    for (user, role, name, email, avatar) in members {
        roster.set(Bucket::blank(&user, name, email, avatar, role, true));
    }
    let mut off_roster: Vec<String> = Vec::new();
    for (user, ..) in &totals {
        if !roster.has(user) && !off_roster.contains(user) {
            off_roster.push(user.clone());
        }
    }
    if !off_roster.is_empty() {
        let former: Vec<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "select user_id, name, email, picture from workspace_members where user_id = any($1)",
        )
        .bind(&off_roster)
        .fetch_all(db)
        .await?;
        let directory: HashMap<String, (Option<String>, Option<String>, Option<String>)> = former
            .into_iter()
            .map(|(user, name, email, avatar)| (user, (name, email, avatar)))
            .collect();
        for user in &off_roster {
            let (name, email, avatar) = directory.get(user).cloned().unwrap_or_default();
            roster.set(Bucket::blank(user, name, email, avatar, None, false));
        }
    }
    // `addTotalsToBuckets`.
    for (user, billable, minutes, count) in &totals {
        let Some(bucket) = roster.by_user.get_mut(user) else {
            continue;
        };
        let minutes = if minutes.is_nan() { 0.0 } else { *minutes };
        bucket.total += minutes;
        if billable.unwrap_or(false) {
            bucket.billable += minutes;
        } else {
            bucket.non_billable += minutes;
        }
        bucket.entries += i64::from(*count);
    }
    let mut members: Vec<&Bucket> = roster
        .order
        .iter()
        .filter_map(|user| roster.by_user.get(user))
        .collect();
    // A stable sort, as `Array.prototype.sort`.
    members.sort_by(|a, b| b.total.partial_cmp(&a.total).unwrap_or(std::cmp::Ordering::Equal));
    let (mut total, mut billable, mut non_billable, mut count) = (0.0, 0.0, 0.0, 0_i64);
    for member in &members {
        total += member.total;
        billable += member.billable;
        non_billable += member.non_billable;
        count += member.entries;
    }
    let contributors = members.iter().filter(|m| m.entries > 0).count();
    let entry_count = entries.len();
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
            let mut entry = js_row(entry);
            let title = entry["taskTitle"].as_str().filter(|t| !t.is_empty()).map(str::to_owned);
            let task_id = entry["taskId"].as_str().filter(|t| !t.is_empty()).map(str::to_owned);
            let duration = numeric(&entry["duration"]);
            let user = entry["userId"].as_str().unwrap_or_default().to_owned();
            let user_name = roster
                .by_user
                .get(&user)
                .map_or_else(|| entry["userId"].clone(), |b| Value::String(b.name.clone()));
            if let Value::Object(fields) = &mut entry {
                fields.remove("taskTitle");
                fields.insert(
                    "duration".to_owned(),
                    number_value(if duration.is_nan() { 0.0 } else { duration }),
                );
                fields.insert("userName".to_owned(), user_name);
                if let (Some(task_id), Some(title)) = (task_id, title) {
                    fields.insert("task".to_owned(), json!({ "id": task_id, "title": title }));
                }
            }
            entry
        })
        .collect();
    Ok(Data(json!({
        "projectId": project_id,
        "projectName": project_name,
        "range": { "fromDate": f.from_date, "toDate": f.to_date },
        "totals": {
            "totalMinutes": number_value(total),
            "billableMinutes": number_value(billable),
            "nonBillableMinutes": number_value(non_billable),
            "entryCount": count,
            "memberCount": members.len(),
            "contributorCount": contributors,
        },
        "members": members.iter().map(|m| m.to_value()).collect::<Vec<_>>(),
        "entries": entries,
        "entriesTruncated": count > i64::try_from(entry_count).unwrap_or(i64::MAX),
    }))
    .into_response())
}

// ── Timer ───────────────────────────────────────────────────────────────────

/// An `active_timers` row as Drizzle reads it.
macro_rules! timer_json {
    ($a:literal) => {
        concat!("(to_jsonb(", $a, ") || jsonb_build_object('rate', ", $a, ".rate::text))")
    };
}

async fn running_timer(db: &PgPool, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        timer_json!("a"),
        " from active_timers a where a.user_id = $1 limit 1"
    ))
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn timer(caller: Caller) -> Response {
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(
        async {
            let row = running_timer(&caller.db, &user).await?;
            Ok(Data(row.unwrap_or(Value::Null)).into_response())
        }
        .await,
        "Failed to fetch running timer",
    )
}

async fn start_timer(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_timer(issues, fields, false)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(
        async {
            if let Some(running) = running_timer(&caller.db, &user).await? {
                return Err(ApiError::conflict("A timer is already running")
                    .with_details(json!({ "timer": running }))
                    .into());
            }
            let project = resolve_entry_target(
                &caller,
                text(&data, "projectId").as_deref(),
                text(&data, "taskId").as_deref(),
            )
            .await?;
            let (now, _) = now_stamp();
            let created: Value = sqlx::query_scalar(concat!(
                "insert into active_timers as a (id, project_id, task_id, user_id, started_at,",
                " description, activity, billable, rate, created_at, updated_at)",
                " values ($1, $2, $3, $4, $5::timestamp, $6, $7, $8, $9::numeric, $5::timestamp, $5::timestamp)",
                " returning ",
                timer_json!("a")
            ))
            .bind(generate_id("timer"))
            .bind(&project)
            .bind(text(&data, "taskId"))
            .bind(&user)
            .bind(&now)
            .bind(text(&data, "description"))
            .bind(text(&data, "activity"))
            .bind(data.get("billable").and_then(Value::as_bool).unwrap_or(true))
            .bind(data.get("rate").map(js_string))
            .fetch_one(&caller.db)
            .await?;
            Ok(Created(js_row(created)).into_response())
        }
        .await,
        "Failed to start timer",
    )
}

/// `calendarDate(instant, timeZone)`: the `YYYY-MM-DD` the instant falls on
/// in the zone (UTC when none is given).
fn calendar_date(millis: i64, zone: Option<&str>) -> Result<String, Refusal> {
    let instant = jiff::Timestamp::from_millisecond(millis)
        .map_err(|error| Refusal::Internal(error.to_string()))?;
    let zone = match zone {
        Some(name) => jiff::tz::TimeZone::get(name).map_err(|error| Refusal::Internal(error.to_string()))?,
        None => jiff::tz::TimeZone::UTC,
    };
    Ok(instant.to_zoned(zone).date().to_string())
}

/// `resolveTimerTarget`: where a stopped timer's hours land. What the
/// client sends is checked strictly; the stored target keeps whatever part
/// is still usable.
async fn resolve_timer_target(
    caller: &Caller,
    stored: (Option<String>, Option<String>),
    overrides: &Map<String, Value>,
) -> Result<(Option<String>, Option<String>), Refusal> {
    let (stored_project, stored_task) = stored;
    let project_override = text(overrides, "projectId");
    if let Some(task) = text(overrides, "taskId") {
        let project = resolve_entry_target(caller, project_override.as_deref(), Some(&task)).await?;
        return Ok((project, Some(task)));
    }
    if let Some(project) = project_override {
        let project = resolve_entry_target(caller, Some(&project), None).await?;
        let task = usable_task_id(&caller.db, stored_task.as_deref(), project.as_deref()).await?;
        return Ok((project, task));
    }
    let stored_project = stored_project.filter(|p| !p.is_empty());
    let project = match &stored_project {
        Some(project) if caller.can_write(project).await? => Some(project.clone()),
        _ => None,
    };
    let task = if stored_project.is_some() && project.is_none() {
        None
    } else {
        usable_task_id(&caller.db, stored_task.as_deref(), project.as_deref()).await?
    };
    Ok((project, task))
}

async fn stop_timer(State(state): State<FlowState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let overrides = match validate(&headers, &body, |issues, fields| read_timer(issues, fields, true)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(stop(&state, &caller, &user, &overrides).await, "Failed to stop timer")
}

async fn stop(state: &FlowState, caller: &Caller, user: &str, overrides: &Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(current) = running_timer(db, user).await? else {
        return Err(Refusal::not_found("Running timer", user));
    };
    let stored = (
        current["projectId"].as_str().map(str::to_owned),
        current["taskId"].as_str().map(str::to_owned),
    );
    let (project, task) = resolve_timer_target(caller, stored, overrides).await?;
    // Claim the timer: exactly one request gets the row back.
    let running: Option<Value> = sqlx::query_scalar(concat!(
        "delete from active_timers a where a.id = $1 returning ",
        timer_json!("a")
    ))
    .bind(current["id"].as_str().unwrap_or_default())
    .fetch_optional(db)
    .await?;
    let Some(running) = running.map(js_row) else {
        return Err(Refusal::not_found("Running timer", user));
    };
    let (now, now_ms) = now_stamp();
    let started = running["startedAt"].as_str().unwrap_or_default().to_owned();
    let started_ms = weldsuite_flow_domain::js::millis_of(&started).unwrap_or(now_ms);
    #[allow(clippy::cast_precision_loss)]
    let duration = to_fixed(((now_ms - started_ms) as f64 / 60_000.0).max(0.0), 2);
    let rate = match overrides.get("rate") {
        Some(rate) => Some(js_string(rate)),
        None => running["rate"].as_str().map(str::to_owned),
    };
    let billable = overrides
        .get("billable")
        .and_then(Value::as_bool)
        .or_else(|| running["billable"].as_bool())
        .unwrap_or(true);
    let id = generate_id("time");
    let cost = compute_cost(
        rate.as_ref().map(|r| Value::String(r.clone())).as_ref(),
        Some(&Value::String(duration.clone())),
    );
    let pick = |key: &str| text(overrides, key).or_else(|| running[key].as_str().map(str::to_owned));
    let date = calendar_date(started_ms, text(overrides, "timeZone").as_deref())?;
    let inserted = sqlx::query(
        "insert into time_entries (id, project_id, task_id, user_id, date, start_time, end_time,
             duration, description, activity, billable, rate, cost, status, created_at, updated_at)
         values ($1, $2, $3, $4, $5::date, $6::timestamp, $7::timestamp, $8::numeric, $9, $10, $11,
                 $12::numeric, $13::numeric, 'draft', $7::timestamp, $7::timestamp)",
    )
    .bind(&id)
    .bind(&project)
    .bind(&task)
    .bind(user)
    .bind(&date)
    .bind(&started)
    .bind(&now)
    .bind(&duration)
    .bind(pick("description"))
    .bind(pick("activity"))
    .bind(billable)
    .bind(&rate)
    .bind(&cost)
    .execute(db)
    .await;
    if let Err(error) = inserted {
        // Keep the running time when the entry could not be written.
        let restored = sqlx::query(
            "insert into active_timers (id, created_at, updated_at, project_id, task_id, user_id,
                 started_at, description, activity, billable, rate)
             select x.id, x.created_at, x.updated_at, x.project_id, x.task_id, x.user_id,
                    x.started_at, x.description, x.activity, x.billable, x.rate
             from jsonb_populate_record(null::active_timers, $1) x
             on conflict do nothing",
        )
        .bind(&running_record(&running))
        .execute(db)
        .await;
        if let Err(restore) = restored {
            tracing::error!(%restore, "[app-api/time-entries] restoring the timer failed");
        }
        return Err(error.into());
    }
    let mut event = time_entry_analytics_payload(
        &id,
        project.as_deref(),
        task.as_deref(),
        user,
        js_number(&duration),
        Some(billable),
    );
    if let Value::Object(fields) = &mut event {
        fields.insert("startedAt".to_owned(), Value::String(started.clone()));
        fields.insert("endedAt".to_owned(), Value::String(now.clone()));
        if let Some(cost) = &cost {
            fields.insert("cost".to_owned(), number_value(js_number(cost)));
        }
    }
    caller.publish(state, PROJECT_TIME_ENTRY_CREATED, &id, &event);
    Ok(Created(json!({ "id": id, "duration": duration, "startTime": started, "endTime": now }))
        .into_response())
}

/// A timer row (camelCase, as read) back in its column names.
fn running_record(running: &Value) -> Value {
    let mut record = Map::new();
    if let Value::Object(fields) = running {
        for (key, value) in fields {
            let column: String = key
                .chars()
                .flat_map(|ch| {
                    if ch.is_ascii_uppercase() {
                        vec!['_', ch.to_ascii_lowercase()]
                    } else {
                        vec![ch]
                    }
                })
                .collect();
            record.insert(column, value.clone());
        }
    }
    Value::Object(record)
}

async fn discard_timer(caller: Caller) -> Response {
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(
        async {
            sqlx::query("delete from active_timers where user_id = $1")
                .bind(&user)
                .execute(&caller.db)
                .await?;
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to discard timer",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

/// The caller's own live entry.
async fn own_entry(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        time_entry_json!("t"),
        " from time_entries t where t.id = $1 and t.deleted_at is null and t.user_id = $2 limit 1"
    ))
    .bind(id)
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            match own_entry(&caller, &id).await? {
                Some(row) => Ok(Data(row).into_response()),
                None => Err(Refusal::not_found("Time entry", &id)),
            }
        }
        .await,
        "Failed to fetch time entry",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_entry(issues, fields, false)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    reply(create_entry(&state, &caller, &user, &data).await, "Failed to create time entry")
}

async fn create_entry(state: &FlowState, caller: &Caller, user: &str, data: &Map<String, Value>) -> Reply {
    let id = generate_id("time");
    let (now, _) = now_stamp();
    let date = text(data, "date").unwrap_or_default();
    let duration = data.get("duration").cloned().unwrap_or(Value::Null);
    if let Some(violation) = daily_limit_violation(&caller.db, user, &date, &duration, None).await? {
        return Err(Refusal::bad_request(violation));
    }
    let task = text(data, "taskId");
    let project = resolve_entry_target(caller, text(data, "projectId").as_deref(), task.as_deref()).await?;
    let billable = data.get("billable").and_then(Value::as_bool).unwrap_or(true);
    let start = optional_timestamp(data, "startTime")?;
    let end = optional_timestamp(data, "endTime")?;
    sqlx::query(
        "insert into time_entries (id, project_id, task_id, user_id, date, duration, description,
             activity, billable, rate, cost, start_time, end_time, location, is_remote, status,
             created_at, updated_at)
         values ($1, $2, $3, $4, $5::date, $6::numeric, $7, $8, $9, $10::numeric, $11::numeric,
                 $12::timestamp, $13::timestamp, $14, $15, 'draft', $16::timestamp, $16::timestamp)",
    )
    .bind(&id)
    .bind(&project)
    .bind(&task)
    .bind(user)
    .bind(&date)
    .bind(js_string(&duration))
    .bind(text(data, "description"))
    .bind(text(data, "activity"))
    .bind(billable)
    .bind(data.get("rate").map(js_string))
    .bind(compute_cost(data.get("rate"), Some(&duration)))
    .bind(start)
    .bind(end)
    .bind(text(data, "location"))
    .bind(data.get("isRemote").and_then(Value::as_bool).unwrap_or(false))
    .bind(&now)
    .execute(&caller.db)
    .await?;
    caller.publish(
        state,
        PROJECT_TIME_ENTRY_CREATED,
        &id,
        &time_entry_analytics_payload(
            &id,
            project.as_deref(),
            task.as_deref(),
            user,
            js_number_of(&duration),
            Some(billable),
        ),
    );
    Ok(Created(json!({ "id": id })).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| read_entry(issues, fields, true)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    reply(update_entry(&state, &caller, &id, &data).await, "Failed to update time entry")
}

/// `resolvePatchProject`: the project a PATCH moves the entry to; `None`
/// when it leaves the project and task alone.
async fn resolve_patch_project(
    caller: &Caller,
    data: &Map<String, Value>,
    existing: &Value,
) -> Result<Option<Option<String>>, Refusal> {
    let task_given = data.get("taskId");
    if !data.contains_key("projectId") && task_given.is_none() {
        return Ok(None);
    }
    let moves_to_task = matches!(task_given, Some(Value::String(_)));
    let project = match text(data, "projectId") {
        Some(project) => Some(project),
        None if moves_to_task => None,
        None => existing["projectId"].as_str().map(str::to_owned),
    };
    let task = match task_given {
        None => existing["taskId"].as_str().map(str::to_owned),
        Some(value) => value.as_str().map(str::to_owned),
    };
    Ok(Some(resolve_entry_target(caller, project.as_deref(), task.as_deref()).await?))
}

async fn update_entry(state: &FlowState, caller: &Caller, id: &str, data: &Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(existing) = own_entry(caller, id).await? else {
        return Err(Refusal::not_found("Time entry", id));
    };
    if existing["status"] == "approved" {
        return Err(Refusal::conflict(APPROVED_LOCKED));
    }
    let resolved = resolve_patch_project(caller, data, &existing).await?;

    // `patchDailyLimitViolation`: a longer entry or another day.
    let changes_day = data
        .get("date")
        .is_some_and(|date| *date != existing["date"]);
    if data.contains_key("duration") || changes_day {
        let date = text(data, "date")
            .or_else(|| existing["date"].as_str().map(str::to_owned))
            .unwrap_or_default();
        let minutes = data
            .get("duration")
            .cloned()
            .unwrap_or_else(|| existing["duration"].clone());
        let user = existing["userId"].as_str().unwrap_or_default();
        if let Some(violation) = daily_limit_violation(db, user, &date, &minutes, Some(id)).await? {
            return Err(Refusal::bad_request(violation));
        }
    }

    // `buildTimeEntryUpdate`: only what was sent.
    let (now, _) = now_stamp();
    let cost = if data.contains_key("rate") || data.contains_key("duration") {
        let rate = data
            .get("rate")
            .filter(|r| !r.is_null())
            .unwrap_or(&existing["rate"]);
        let duration = data
            .get("duration")
            .filter(|d| !d.is_null())
            .unwrap_or(&existing["duration"]);
        Some(compute_cost(Some(rate), Some(duration)))
    } else {
        None
    };
    let start = match data.get("startTime") {
        None => None,
        Some(_) => Some(optional_timestamp(data, "startTime")?),
    };
    let end = match data.get("endTime") {
        None => None,
        Some(_) => Some(optional_timestamp(data, "endTime")?),
    };
    let mut copied = Map::new();
    for key in ["date", "description", "activity", "billable", "location", "isRemote", "taskId"] {
        if let Some(value) = data.get(key) {
            copied.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(duration) = data.get("duration") {
        copied.insert("duration".to_owned(), Value::String(js_string(duration)));
    }
    if let Some(rate) = data.get("rate") {
        copied.insert(
            "rate".to_owned(),
            if rate.is_null() { Value::Null } else { Value::String(js_string(rate)) },
        );
    }
    sqlx::query(concat!(
        "update time_entries set updated_at = $2::timestamp,",
        " date = case when $1::jsonb ? 'date' then ($1::jsonb->>'date')::date else date end, ",
        set_text!("description", "description"),
        ", ",
        set_text!("activity", "activity"),
        ", ",
        set_bool!("billable", "billable"),
        ", ",
        set_text!("location", "location"),
        ", ",
        set_bool!("isRemote", "is_remote"),
        ", ",
        set_text!("taskId", "task_id"),
        ", ",
        set_num!("duration", "duration"),
        ", ",
        set_num!("rate", "rate"),
        ", start_time = case when $3 then $4::timestamp else start_time end",
        ", end_time = case when $5 then $6::timestamp else end_time end",
        ", cost = case when $7 then $8::numeric else cost end",
        ", project_id = case when $9 then $10 else project_id end",
        " where id = $11 and deleted_at is null"
    ))
    .bind(Value::Object(copied))
    .bind(&now)
    .bind(start.is_some())
    .bind(start.flatten())
    .bind(end.is_some())
    .bind(end.flatten())
    .bind(cost.is_some())
    .bind(cost.clone().flatten())
    .bind(resolved.is_some())
    .bind(resolved.clone().flatten())
    .bind(id)
    .execute(db)
    .await?;

    // `costForEvent`: the recomputed cost, else the stored one.
    let event_cost = match cost.flatten() {
        Some(cost) => Some(js_number(&cost)),
        None => existing["cost"].as_str().map(js_number),
    };
    let project = match &resolved {
        Some(project) => project.clone(),
        None => existing["projectId"].as_str().map(str::to_owned),
    };
    let task = match data.get("taskId") {
        Some(value) => value.as_str().map(str::to_owned),
        None => existing["taskId"].as_str().map(str::to_owned),
    };
    let duration = js_number_of(data.get("duration").filter(|d| !d.is_null()).unwrap_or(&existing["duration"]));
    let billable = data
        .get("billable")
        .and_then(Value::as_bool)
        .or_else(|| existing["billable"].as_bool());
    let mut event = time_entry_analytics_payload(
        id,
        project.as_deref(),
        task.as_deref(),
        existing["userId"].as_str().unwrap_or_default(),
        duration,
        billable,
    );
    if let (Value::Object(fields), Some(cost)) = (&mut event, event_cost) {
        fields.insert("cost".to_owned(), number_value(cost));
    }
    caller.publish(state, PROJECT_TIME_ENTRY_UPDATED, id, &event);
    let mut answer = Map::new();
    answer.insert("id".to_owned(), Value::String(id.to_owned()));
    for (key, value) in data {
        answer.insert(key.clone(), value.clone());
    }
    Ok(Data(Value::Object(answer)).into_response())
}

// ── PATCH /:id/approve, /:id/reject ─────────────────────────────────────────

async fn approve(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(review(&state, &caller, &id, true).await, "Failed to approve time entry")
}

async fn reject(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(review(&state, &caller, &id, false).await, "Failed to reject time entry")
}

/// `reviewTimeEntry`: whoever manages the entry's project (`projects:scope:all`
/// for an entry without one), never its author.
async fn review(state: &FlowState, caller: &Caller, id: &str, approved: bool) -> Reply {
    let db = &caller.db;
    let existing: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        time_entry_json!("t"),
        " from time_entries t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(existing) = existing.map(js_row) else {
        return Err(Refusal::not_found("Time entry", id));
    };
    if existing["userId"].as_str() == Some(caller.user_id.as_str()) {
        return Err(Refusal::forbidden(
            "You cannot approve or reject your own time entry",
        ));
    }
    let allowed = match existing["projectId"].as_str().filter(|p| !p.is_empty()) {
        Some(project) => caller.can_manage(project).await?,
        None => caller.scope_all(),
    };
    if !allowed {
        return Err(Refusal::forbidden(
            "Only a project manager can approve or reject time entries",
        ));
    }
    let (now, _) = now_stamp();
    sqlx::query(
        "update time_entries set status = $2, approved_by = $3,
             approved_at = $4::timestamp, updated_at = $5::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(if approved { "approved" } else { "rejected" })
    .bind(approved.then(|| caller.user_id.clone()))
    .bind(approved.then(|| now.clone()))
    .bind(&now)
    .execute(db)
    .await?;
    let payload = entry_payload(id, &existing);
    caller.publish(state, PROJECT_TIME_ENTRY_UPDATED, id, &payload);
    let mut reviewed = payload;
    if let Value::Object(fields) = &mut reviewed {
        fields.insert("reviewedBy".to_owned(), Value::String(caller.user_id.clone()));
    }
    caller.publish(
        state,
        if approved {
            PROJECT_TIMESHEET_APPROVED
        } else {
            PROJECT_TIMESHEET_REJECTED
        },
        id,
        &reviewed,
    );
    let status = if approved { "approved" } else { "rejected" };
    Ok(Data(json!({ "id": id, "status": status })).into_response())
}

/// `{ id, projectId, taskId, userId, duration: Number(duration) }`.
fn entry_payload(id: &str, entry: &Value) -> Value {
    json!({
        "id": id,
        "projectId": entry["projectId"],
        "taskId": entry["taskId"],
        "userId": entry["userId"],
        "duration": number_value(numeric(&entry["duration"])),
    })
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(existing) = own_entry(&caller, &id).await? else {
                return Err(Refusal::not_found("Time entry", &id));
            };
            if existing["status"] == "approved" {
                return Err(Refusal::conflict(APPROVED_LOCKED));
            }
            sqlx::query(
                "update time_entries set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now_stamp().0)
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_TIME_ENTRY_DELETED, &id, &entry_payload(&id, &existing));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete time entry",
    )
}
