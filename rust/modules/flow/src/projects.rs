//! `/api/projects` (`routes/projects/index.ts`): the project list (the
//! membership boundary, filters, sorts, keyset or offset paging), workload,
//! search, the caller's permissions, Gantt data, CRUD with custom fields,
//! delete with an optional task hand-over, and task import jobs.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_CREATED, PROJECT_DELETED, PROJECT_MEMBER_ADDED, PROJECT_TASK_UPDATED, PROJECT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    PROJECTS_CREATE, PROJECTS_DELETE, PROJECTS_READ, PROJECTS_UPDATE, TASKS_CREATE, TASKS_READ,
};
use weldsuite_db::{PgPool, js_row, js_timestamp};
use weldsuite_flow_domain::js::{
    contains_pattern, js_date, math_round, number_value, numeric, parse_int, slice_utf16,
};
use weldsuite_flow_domain::stage::{stage_placement, task_status_aliases};
use weldsuite_flow_domain::stats::{
    milestone_refs, milestone_stats, project_stats, with_milestone_stats, with_project_stats,
};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::custom_values::{self, Definition};
use crate::import_jobs;
use crate::{Caller, FlowState, Query, Refusal, Reply, now, outside, reply, validate};

const NOT_A_MEMBER: &str = "You are not a member of this project";
const PROJECT_ENTITY: &str = "project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list))
        .route("/", post(create).route_layer(need(PROJECTS_CREATE)))
        .route(
            "/workload/overview",
            get(workload_overview).route_layer(need(PROJECTS_READ)),
        )
        .route("/search", get(search).route_layer(need(PROJECTS_READ)))
        .route(
            "/{id}/permissions",
            get(permissions).route_layer(need(PROJECTS_READ)),
        )
        .route(
            "/{id}/gantt/tasks",
            get(gantt_tasks).route_layer(need(TASKS_READ)),
        )
        .route(
            "/{id}/gantt/milestones",
            get(gantt_milestones).route_layer(need(TASKS_READ)),
        )
        .route(
            "/{id}/workload",
            get(project_workload).route_layer(need(PROJECTS_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(PROJECTS_READ)))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need(PROJECTS_UPDATE)),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need(PROJECTS_DELETE)),
        )
        .route(
            "/{project_id}/tasks/import-jobs",
            post(import_jobs::start).route_layer(need(TASKS_CREATE)),
        )
        .route(
            "/{project_id}/tasks/import-jobs/{job_id}",
            get(import_jobs::status).route_layer(need(TASKS_CREATE)),
        )
        .with_state(state)
}

/// A whole project row (`select()`), numerics as text.
pub(crate) async fn project_row(
    db: &PgPool,
    id: &str,
    live: bool,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        project_json!("p"),
        " from projects p where p.id = $1 and (not $2 or p.deleted_at is null) limit 1"
    ))
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `withProjectStats(hydrate(rows))`.
async fn decorate(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, sqlx::Error> {
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let stats = project_stats(db, &ids).await?;
    let hydrated = custom_values::hydrate(db, PROJECT_ENTITY, rows).await?;
    Ok(with_project_stats(hydrated, &stats))
}

// ── GET / ───────────────────────────────────────────────────────────────────

const DERIVED_STATUSES: [&str; 5] = ["on-track", "at-risk", "off-track", "on-hold", "completed"];

/// `normalizeProjectStatus`: any spelling of a canonical status to its
/// stored form; unknown values unchanged.
pub(crate) fn normalize_project_status(value: &str) -> String {
    match status_key(value.trim()).as_str() {
        "planning" => "Planning".to_owned(),
        "active" => "Active".to_owned(),
        "onhold" => "On Hold".to_owned(),
        "completed" => "Completed".to_owned(),
        "cancelled" | "canceled" => "Cancelled".to_owned(),
        _ => value.to_owned(),
    }
}

/// `value.toLowerCase().replace(/[\s_-]+/g, '')`.
fn status_key(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| !(c.is_whitespace() || *c == '_' || *c == '-'))
        .collect()
}

/// The list's filters, bound in [`list_filters`]' order.
struct Filters {
    member_of: Option<(String, Vec<String>)>,
    derived_status: Option<String>,
    status_key: Option<String>,
    priority: Option<String>,
    owner_id: Option<String>,
    customer_id: Option<String>,
    is_active: Option<bool>,
    search: Option<String>,
}

impl Filters {
    fn from_query(q: &Query, member_of: Option<(String, Vec<String>)>) -> Self {
        let status = q.present("status");
        let (derived_status, status_key) = match status {
            Some(s) if DERIVED_STATUSES.contains(&s) => (Some(s.to_owned()), None),
            Some(s) => (None, Some(status_key(&normalize_project_status(s)))),
            None => (None, None),
        };
        Self {
            member_of,
            derived_status,
            status_key,
            priority: q.present("priority").map(|p| p.trim().to_lowercase()),
            owner_id: q.present("ownerId").map(str::to_owned),
            customer_id: q.present("customerId").map(str::to_owned),
            is_active: q.present("isActive").map(|v| v == "true" || v == "1"),
            search: q.present("search").map(contains_pattern),
        }
    }
}

/// The list's `where`, without the keyset cursor: `$1`–`$10`.
macro_rules! list_filters {
    () => {
        concat!(
            "p.deleted_at is null",
            " and ($1::bool or p.project_manager_id = $2 or p.id = any($3))",
            " and ($4::text is null or ",
            derived_status!("p"),
            " = $4)",
            r" and ($5::text is null or lower(regexp_replace(p.status, '[\s_-]+', '', 'g')) = $5)",
            " and ($6::text is null or (case when $6 = 'medium'",
            " then lower(coalesce(nullif(btrim(p.priority), ''), 'medium')) = 'medium'",
            " else lower(btrim(p.priority)) = $6 end))",
            " and ($7::text is null or p.project_manager_id = $7 or exists (",
            "select 1 from project_members xpm where xpm.project_id = p.id and xpm.user_id = $7",
            " and lower(xpm.role) = 'owner' and xpm.is_active = true and xpm.deleted_at is null))",
            " and ($8::text is null or p.customer_id = $8)",
            " and ($9::bool is null or p.is_active = $9)",
            " and ($10::text is null or p.name ilike $10 or p.code ilike $10)"
        )
    };
}

fn bind_filters<'q, O>(
    query: sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments>,
    filters: &'q Filters,
) -> sqlx::query::QueryScalar<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments> {
    let (all, user, ids) = match &filters.member_of {
        Some((user, ids)) => (false, Some(user.as_str()), ids.clone()),
        None => (true, None, Vec::new()),
    };
    query
        .bind(all)
        .bind(user)
        .bind(ids)
        .bind(filters.derived_status.as_deref())
        .bind(filters.status_key.as_deref())
        .bind(filters.priority.as_deref())
        .bind(filters.owner_id.as_deref())
        .bind(filters.customer_id.as_deref())
        .bind(filters.is_active)
        .bind(filters.search.as_deref())
}

const SORT_FIELDS: [&str; 6] = [
    "name",
    "status",
    "priority",
    "dueDate",
    "owner",
    "createdAt",
];

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_projects(&caller, &q).await)
}

#[allow(clippy::too_many_lines)]
async fn list_projects(caller: &Caller, q: &Query) -> Reply {
    let Some(user) = caller.user() else {
        return Err(ApiError::unauthorized().into());
    };
    let limit = match q.present("limit") {
        Some(raw) => parse_int(raw).map(|n| n.min(100)),
        None => Some(25),
    };
    let member_of = if caller.scope_all() {
        None
    } else {
        let ids: Vec<String> = sqlx::query_scalar(
            "select project_id from project_members
             where user_id = $1 and is_active = true and deleted_at is null",
        )
        .bind(user)
        .fetch_all(&caller.db)
        .await?;
        Some((user.to_owned(), ids))
    };
    let filters = Filters::from_query(q, member_of);
    // An explicit sort pages by offset; the default (newest first) by keyset.
    let sort = q
        .present("sortField")
        .filter(|field| SORT_FIELDS.contains(field));
    let ascending = q.get("sortDirection") == Some("asc");
    let order = match sort {
        Some("createdAt") if !ascending => None,
        Some(field) => Some(format!(
            "{field}:{}",
            if ascending { "asc" } else { "desc" }
        )),
        None => None,
    };
    let offset: i64 = if order.is_some() {
        q.get("cursor")
            .and_then(|c| c.strip_prefix("o:"))
            .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .map_or(0, |n| n.parse().unwrap_or(i64::MAX))
    } else {
        0
    };
    let mut keyset: Option<(String, String)> = None;
    if order.is_none()
        && let Some(cursor) = q.present("cursor")
    {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, to_jsonb(created_at) #>> '{}' from projects where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await?;
        if let Some((id, Some(created))) = row {
            keyset = js_timestamp(&created).map(|at| (at, id));
        }
    }
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows: Vec<Value> = bind_filters(
            sqlx::query_scalar(concat!(
                "select ",
                project_json!("p"),
                " from projects p where ",
                list_filters!(),
                " and ($11::timestamp is null or p.created_at < $11::timestamp",
                " or (p.created_at = $11::timestamp and p.id < $12))",
                " order by",
                " (case when $13 = 'name:asc' then lower(p.name) end) asc nulls last,",
                " (case when $13 = 'name:desc' then lower(p.name) end) desc nulls last,",
                " (case when $13 = 'status:asc' then ",
                derived_status!("p"),
                " end) asc nulls last,",
                " (case when $13 = 'status:desc' then ",
                derived_status!("p"),
                " end) desc nulls last,",
                " (case when $13 = 'priority:asc' then ",
                priority_rank!("p"),
                " end) asc nulls last,",
                " (case when $13 = 'priority:desc' then ",
                priority_rank!("p"),
                " end) desc nulls last,",
                " (case when $13 = 'dueDate:asc' then p.end_date end) asc nulls last,",
                " (case when $13 = 'dueDate:desc' then p.end_date end) desc nulls last,",
                " (case when $13 = 'owner:asc' then lower(",
                owner_name!("p"),
                ") end) asc nulls last,",
                " (case when $13 = 'owner:desc' then lower(",
                owner_name!("p"),
                ") end) desc nulls last,",
                " (case when $13 = 'createdAt:asc' then p.created_at end) asc nulls last,",
                " (case when $14 then p.created_at end) asc,",
                " (case when $14 then p.id end) asc,",
                " (case when not $14 then p.created_at end) desc,",
                " (case when not $14 then p.id end) desc",
                " limit $15 offset $16"
            )),
            &filters,
        )
        .bind(keyset.as_ref().map(|(at, _)| at.as_str()))
        .bind(keyset.as_ref().map(|(_, id)| id.as_str()))
        .bind(order.as_deref().unwrap_or(""))
        .bind(order.is_some() && ascending)
        .bind(limit + 1)
        .bind(offset)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = bind_filters(
            sqlx::query_scalar(concat!(
                "select count(*) from projects p where ",
                list_filters!()
            )),
            &filters,
        )
        .fetch_one(&caller.db)
        .await?;
        let mut data: Vec<Value> = rows.into_iter().map(js_row).collect();
        let has_more = i64::try_from(data.len()).unwrap_or(i64::MAX) > limit;
        if has_more {
            data.truncate(usize::try_from(limit).unwrap_or(0));
        }
        let cursor = if has_more && !data.is_empty() {
            if order.is_some() {
                Some(format!("o:{}", offset + limit))
            } else {
                data.last()
                    .and_then(|row| row["id"].as_str())
                    .map(str::to_owned)
            }
        } else {
            None
        };
        let data = decorate(&caller.db, data).await?;
        Ok(List::new(
            data,
            Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
        )
        .into_response())
    }
    .await;
    Ok(reply(result, "Failed to list projects"))
}

// ── GET /workload/overview, GET /:id/workload ─────────────────────────────

fn empty_workload() -> Value {
    json!({
        "totalProjects": 0,
        "totalMembers": 0,
        "totalTasks": 0,
        "teamMembers": [],
        "unassigned": { "tasks": [] },
    })
}

/// An active project member with their workspace profile.
struct MemberLoad {
    user_id: String,
    role: Value,
    allocation: f64,
    hours_per_week: Value,
    name: Option<String>,
    email: Option<String>,
    avatar: Option<String>,
}

async fn active_members(
    db: &PgPool,
    project_ids: &[String],
) -> Result<Vec<MemberLoad>, sqlx::Error> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    // Unordered, so the plan decides the order: one project is an equality
    // (Postgres reads `in ($1)` as `= $1`, which plans differently from
    // `= any($1)`), several an array, as Drizzle's `inArray` sends them.
    let rows: Vec<Row> = if let [project_id] = project_ids {
        sqlx::query_as(
            "select pm.user_id, pm.role, pm.allocation_percentage::text, wm.hours_per_week::text,
                    wm.name, wm.email, wm.picture
             from project_members pm
             left join workspace_members wm on pm.user_id = wm.user_id
             where pm.project_id = $1 and pm.is_active = true and pm.deleted_at is null",
        )
        .bind(project_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as(
            "select pm.user_id, pm.role, pm.allocation_percentage::text, wm.hours_per_week::text,
                    wm.name, wm.email, wm.picture
             from project_members pm
             left join workspace_members wm on pm.user_id = wm.user_id
             where pm.project_id = any($1) and pm.is_active = true and pm.deleted_at is null",
        )
        .bind(project_ids)
        .fetch_all(db)
        .await?
    };
    Ok(rows
        .into_iter()
        .map(
            |(user_id, role, allocation, hours, name, email, avatar)| MemberLoad {
                user_id,
                role: Value::String(role),
                allocation: or_default(allocation.as_deref().map(js_text_number), 100.0),
                hours_per_week: hours.map_or(Value::Null, Value::String),
                name,
                email,
                avatar,
            },
        )
        .collect())
}

/// `Number(text)`.
fn js_text_number(text: &str) -> f64 {
    weldsuite_kit::validation::js_number(text)
}

/// `Number(x) || fallback`.
fn or_default(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(n) if n != 0.0 && !n.is_nan() => n,
        _ => fallback,
    }
}

impl MemberLoad {
    /// The person's card: profile, capacity and their `tasks`.
    #[allow(clippy::needless_pass_by_value)]
    fn card(&self, allocation: f64, tasks: Vec<Value>) -> Value {
        let hours_per_week = or_default(Some(numeric(&self.hours_per_week)), 40.0);
        let capacity = math_round((allocation / 100.0) * hours_per_week);
        let display = self
            .name
            .clone()
            .or_else(|| self.email.clone())
            .unwrap_or_else(|| self.user_id.clone());
        json!({
            "userId": self.user_id,
            "name": display,
            "email": self.email.clone().unwrap_or_default(),
            "avatar": self.avatar.clone().unwrap_or_default(),
            "initials": slice_utf16(&display, 2).to_uppercase(),
            "role": self.role,
            "capacity": number_value(capacity),
            "tasks": tasks,
        })
    }
}

/// A task as the workload views list it.
fn workload_task(task: &Value, project_name: &str, with_number: bool) -> Value {
    let mut row = json!({
        "id": task["id"],
        "title": task["title"],
        "projectId": task["projectId"],
        "projectName": project_name,
        "estimatedHours": or_zero(&task["estimatedHours"]),
        "actualHours": or_zero(&task["actualHours"]),
        "priority": or_text(&task["priority"], "medium"),
        "status": or_text(&task["status"], "todo"),
        "startDate": task["startDate"],
        "dueDate": task["dueDate"],
    });
    if with_number {
        row["number"] = task["number"].clone();
        row["key"] = task["key"].clone();
    }
    row
}

fn or_zero(value: &Value) -> Value {
    if value.is_null() {
        json!(0)
    } else {
        value.clone()
    }
}

fn or_text(value: &Value, fallback: &str) -> Value {
    if value.is_null() {
        json!(fallback)
    } else {
        value.clone()
    }
}

/// A task as the workload overview selects it.
macro_rules! overview_task {
    () => {
        "jsonb_build_object('id', t.id, 'number', t.number, 'key', t.key, 'title', t.title,
                'projectId', t.project_id, 'assigneeId', t.assignee_id, 'status', t.status,
                'priority', t.priority, 'startDate', t.start_date, 'dueDate', t.due_date,
                'estimatedHours', t.estimated_hours::text, 'actualHours', t.actual_hours::text)"
    };
}

async fn workload_overview(caller: Caller) -> Response {
    reply(overview(&caller).await, "Failed to fetch workload overview")
}

async fn overview(caller: &Caller) -> Reply {
    if caller.user().is_none() {
        return Err(ApiError::unauthorized().into());
    }
    let db = &caller.db;
    let accessible = caller.accessible_project_ids().await?;
    if accessible.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Data(empty_workload()).into_response());
    }
    let projects: Vec<(String, String)> = sqlx::query_as(
        "select id, name from projects
         where deleted_at is null and ($1::text[] is null or id = any($1))",
    )
    .bind(accessible.as_deref())
    .fetch_all(db)
    .await?;
    if projects.is_empty() {
        return Ok(Data(empty_workload()).into_response());
    }
    let ids: Vec<String> = projects.iter().map(|(id, _)| id.clone()).collect();
    let names: HashMap<&str, &str> = projects
        .iter()
        .map(|(id, name)| (id.as_str(), name.as_str()))
        .collect();
    // One row per person across projects: the first row's profile and role,
    // the allocations summed.
    let mut unique: Vec<(MemberLoad, f64)> = Vec::new();
    for member in active_members(db, &ids).await? {
        if let Some(seen) = unique.iter_mut().find(|(m, _)| m.user_id == member.user_id) {
            seen.1 += member.allocation;
        } else {
            let allocation = member.allocation;
            unique.push((member, allocation));
        }
    }
    // One project is an equality, several an array (see `active_members`).
    let tasks: Vec<Value> = if let [project_id] = ids.as_slice() {
        sqlx::query_scalar(concat!(
            "select ",
            overview_task!(),
            " from tasks t where t.project_id = $1 and t.deleted_at is null",
            " and t.status not in ('done', 'cancelled')"
        ))
        .bind(project_id)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            overview_task!(),
            " from tasks t where t.project_id = any($1) and t.deleted_at is null",
            " and t.status not in ('done', 'cancelled')"
        ))
        .bind(&ids)
        .fetch_all(db)
        .await?
    };
    let tasks: Vec<Value> = tasks.into_iter().map(js_row).collect();
    let name_of = |task: &Value| {
        names
            .get(task["projectId"].as_str().unwrap_or_default())
            .copied()
            .unwrap_or_default()
            .to_owned()
    };
    let mut by_assignee: HashMap<String, Vec<Value>> = HashMap::new();
    let mut other = Vec::new();
    for task in &tasks {
        let assignee = task["assigneeId"].as_str().filter(|a| !a.is_empty());
        match assignee {
            Some(a) if unique.iter().any(|(m, _)| m.user_id == a) => {
                by_assignee
                    .entry(a.to_owned())
                    .or_default()
                    .push(workload_task(task, &name_of(task), true));
            }
            _ => other.push(workload_task(task, &name_of(task), true)),
        }
    }
    let team: Vec<Value> = unique
        .iter()
        .map(|(member, allocation)| {
            let tasks = by_assignee.remove(&member.user_id).unwrap_or_default();
            member.card(allocation.min(100.0), tasks)
        })
        .collect();
    Ok(Data(json!({
        "totalProjects": ids.len(),
        "totalMembers": unique.len(),
        "totalTasks": tasks.len(),
        "teamMembers": team,
        "unassigned": { "tasks": other },
    }))
    .into_response())
}

async fn project_workload(caller: Caller, Path(id): Path<String>) -> Response {
    match caller.can_access(&id).await {
        Ok(true) => reply(
            workload(&caller, &id).await,
            "Failed to fetch project workload",
        ),
        Ok(false) => ApiError::forbidden()
            .with_message(NOT_A_MEMBER)
            .into_response(),
        Err(error) => outside(Err(error.into())),
    }
}

async fn workload(caller: &Caller, project_id: &str) -> Reply {
    let db = &caller.db;
    let name: Option<String> = sqlx::query_scalar(
        "select name from projects where id = $1 and deleted_at is null limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let Some(name) = name else {
        return Err(Refusal::not_found("Project", project_id));
    };
    let members = active_members(db, &[project_id.to_owned()]).await?;
    let tasks: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', t.id, 'title', t.title, 'assigneeId', t.assignee_id,
                'status', t.status, 'priority', t.priority, 'startDate', t.start_date,
                'dueDate', t.due_date, 'estimatedHours', t.estimated_hours::text,
                'actualHours', t.actual_hours::text)
         from tasks t
         where t.project_id = $1 and t.deleted_at is null and t.assignee_id is not null
           and t.status not in ('done', 'cancelled')",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let tasks: Vec<Value> = tasks.into_iter().map(js_row).collect();
    let mut by_assignee: HashMap<String, Vec<Value>> = HashMap::new();
    for task in &tasks {
        let Some(assignee) = task["assigneeId"].as_str().filter(|a| !a.is_empty()) else {
            continue;
        };
        let mut row = task.clone();
        row["projectId"] = json!(project_id);
        by_assignee
            .entry(assignee.to_owned())
            .or_default()
            .push(workload_task(&row, &name, false));
    }
    let team: Vec<Value> = members
        .iter()
        .map(|member| {
            let tasks = by_assignee
                .get(&member.user_id)
                .cloned()
                .unwrap_or_default();
            member.card(member.allocation, tasks)
        })
        .collect();
    Ok(Data(json!({
        "projectId": project_id,
        "projectName": name,
        "totalMembers": members.len(),
        "totalTasks": tasks.len(),
        "teamMembers": team,
    }))
    .into_response())
}

// ── GET /search ─────────────────────────────────────────────────────────────

async fn search(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let term = q.present("q").map(contains_pattern);
    reply(
        async {
            if caller.user().is_none() {
                return Err(ApiError::unauthorized().into());
            }
            let accessible = caller.accessible_project_ids().await?;
            if accessible.as_ref().is_some_and(Vec::is_empty) {
                return Ok(Data(json!([])).into_response());
            }
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                project_json!("p"),
                " from projects p where p.deleted_at is null",
                " and ($1::text[] is null or p.id = any($1))",
                " and ($2::text is null or p.name ilike $2 or p.description ilike $2 or p.code ilike $2)",
                " order by p.name desc limit 20"
            ))
            .bind(accessible.as_deref())
            .bind(term.as_deref())
            .fetch_all(&caller.db)
            .await?;
            let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
            let ids: Vec<String> = rows
                .iter()
                .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
                .collect();
            let stats = project_stats(&caller.db, &ids).await?;
            Ok(Data(with_project_stats(rows, &stats)).into_response())
        }
        .await,
        "Failed to search projects",
    )
}

// ── GET /:id/permissions ───────────────────────────────────────────────────

async fn permissions(caller: Caller, Path(id): Path<String>) -> Response {
    if caller.user().is_none() {
        return ApiError::unauthorized().into_response();
    }
    match caller.access(&id).await {
        Ok(access) => Data(json!({
            "role": access.role,
            "canRead": access.can_read,
            "canWrite": access.can_write,
            "isAdmin": access.is_admin,
        }))
        .into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch project permissions"),
    }
}

// ── Gantt ───────────────────────────────────────────────────────────────────

async fn gantt_tasks(caller: Caller, Path(id): Path<String>) -> Response {
    match caller.can_access(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(NOT_A_MEMBER)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', t.id, 'title', t.title, 'projectId', t.project_id,
                'milestoneId', t.milestone_id, 'parentTaskId', t.parent_task_id,
                'sprintId', t.sprint_id, 'startDate', t.start_date, 'dueDate', t.due_date,
                'completedDate', t.completed_date, 'status', t.status, 'priority', t.priority,
                'progress', t.progress::text, 'assigneeId', t.assignee_id, 'type', t.type,
                'dependsOn', t.depends_on, 'blocks', t.blocks,
                'estimatedHours', t.estimated_hours::text, 'actualHours', t.actual_hours::text)
         from tasks t
         where t.project_id = $1 and t.deleted_at is null
         order by t.start_date, t.due_date",
    )
    .bind(&id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch gantt tasks"),
    }
}

async fn gantt_milestones(caller: Caller, Path(id): Path<String>) -> Response {
    match caller.can_access(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(NOT_A_MEMBER)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object('id', m.id, 'name', m.name, 'description', m.description,
                        'dueDate', m.due_date, 'completedAt', m.completed_at, 'status', m.status,
                        'progress', m.progress::text, 'ownerId', m.owner_id,
                        'isKeyMilestone', m.is_key_milestone, 'dependsOn', m.depends_on,
                        'completedTasks', m.completed_tasks, 'totalTasks', m.total_tasks,
                        'createdAt', m.created_at)
                 from milestones m
                 where m.project_id = $1 and m.deleted_at is null
                 order by m.due_date",
            )
            .bind(&id)
            .fetch_all(&caller.db)
            .await?;
            let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
            let stats = milestone_stats(&caller.db, &milestone_refs(&rows)).await?;
            Ok(Data(with_milestone_stats(rows, &stats)).into_response())
        }
        .await,
        "Failed to fetch gantt milestones",
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match caller.can_access(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message(NOT_A_MEMBER)
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    reply(
        async {
            let Some(row) = project_row(&caller.db, &id, true).await? else {
                return Err(Refusal::not_found("Project", &id));
            };
            let mut rows = decorate(&caller.db, vec![row]).await?;
            Ok(Data(rows.remove(0)).into_response())
        }
        .await,
        "Failed to fetch project",
    )
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// Project columns a client may set (`PROJECT_WRITABLE_FIELDS`).
const WRITABLE: [&str; 36] = [
    "name",
    "description",
    "code",
    "key",
    "customerId",
    "counterpartyId",
    "clientId",
    "projectManagerId",
    "leaderId",
    "administrationId",
    "status",
    "priority",
    "type",
    "health",
    "methodology",
    "visibility",
    "startDate",
    "endDate",
    "actualStartDate",
    "actualEndDate",
    "budgetedHours",
    "budgetedAmount",
    "budgetCurrency",
    "billingMethod",
    "hourlyRate",
    "isBillable",
    "isActive",
    "trackTime",
    "categoryId",
    "color",
    "icon",
    "coverImage",
    "settings",
    "whiteboardData",
    "documentData",
    "goalsData",
];

const TIMESTAMPS: [&str; 4] = ["startDate", "endDate", "actualStartDate", "actualEndDate"];

/// `createProjectSchema` (`.partial()` for a PATCH), passthrough: the body
/// with `status` normalised, and its `customFields`.
struct ProjectBody {
    body: Map<String, Value>,
    custom_fields: Option<Value>,
}

fn project_body(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<ProjectBody, Refusal> {
    validate(headers, body, |issues, fields| {
        read_project(issues, fields, partial)
    })
}

fn read_project(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> ProjectBody {
    let name_presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "name", name_presence, Some(1), Some(255));
    issues.text(fields, "description", Presence::Optional, None, None);
    let status = issues.text(fields, "status", Presence::Optional, None, Some(30));
    issues.text(fields, "startDate", Presence::Optional, None, None);
    issues.text(fields, "endDate", Presence::Optional, None, None);
    issues.text(fields, "ownerId", Presence::Nullish, None, None);
    issues.text(fields, "color", Presence::Optional, None, Some(50));
    issues.text(fields, "icon", Presence::Optional, None, Some(100));
    let custom = issues.nested(fields, "customFields", Presence::Nullish, |_, map| {
        Value::Object(map.clone())
    });
    let mut body = fields.clone();
    if let Some(status) = status.as_set() {
        body.insert("status".to_owned(), json!(normalize_project_status(status)));
    }
    let custom_fields = match custom {
        weldsuite_kit::validation::Field::Absent => None,
        weldsuite_kit::validation::Field::Null => Some(Value::Null),
        weldsuite_kit::validation::Field::Set(map) => Some(map),
    };
    ProjectBody {
        body,
        custom_fields,
    }
}

/// `coerceTimestamps(pickWritable(body, WRITABLE), TIMESTAMPS)`: the
/// allow-listed, defined keys with dates as `toISOString()`, or the first
/// field that is not a valid date.
pub(crate) fn writable(
    body: &Map<String, Value>,
    allowed: &[&str],
    timestamps: &[&str],
) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for key in allowed {
        if let Some(value) = body.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    for field in timestamps {
        let Some(value) = out.get(*field) else {
            continue;
        };
        let date = match value {
            Value::Null => continue,
            Value::String(text) => js_date(text),
            Value::Number(n) => n
                .as_f64()
                .filter(|n| n.is_finite() && n.abs() <= 8.64e15)
                .and_then(|n| {
                    #[allow(clippy::cast_possible_truncation)]
                    let millis = n.trunc() as i64;
                    weldsuite_flow_domain::js::iso_from_millis(millis)
                }),
            _ => None,
        };
        match date {
            Some(iso) => {
                out.insert((*field).to_owned(), json!(iso));
            }
            None => return Err((*field).to_owned()),
        }
    }
    Ok(out)
}

/// The `customFields` of a body, validated against the project
/// definitions (`prepareProjectCustomFields`): `None` leaves them alone.
async fn prepare_custom_fields(
    db: &PgPool,
    custom_fields: Option<&Value>,
) -> Result<Option<(Map<String, Value>, Vec<Definition>)>, Refusal> {
    let Some(custom_fields) = custom_fields else {
        return Ok(None);
    };
    let definitions = custom_values::definitions(db, PROJECT_ENTITY).await?;
    let values = match custom_fields {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    custom_values::assert_valid(&definitions, &values).map_err(Refusal::bad_request)?;
    Ok(Some((values, definitions)))
}

/// `writeProjectCustomFields`: the full set, a field left out is cleared.
async fn write_custom_fields(
    db: &PgPool,
    project_id: &str,
    prepared: &(Map<String, Value>, Vec<Definition>),
) -> Result<(), Refusal> {
    let values: Vec<(String, crate::js::Js)> = prepared
        .0
        .iter()
        .map(|(slug, value)| (slug.clone(), crate::js::Js::from_jsonb(value)))
        .collect();
    custom_values::set_values(
        db,
        PROJECT_ENTITY,
        project_id,
        &values,
        &prepared.1,
        false,
        false,
    )
    .await
    .map_err(|error| match error {
        custom_values::ValuesError::Invalid(message) => Refusal::bad_request(message),
        custom_values::ValuesError::Database(error) => Refusal::Database(error),
    })
}

/// `projectAnalyticsPayload(project)`.
pub(crate) fn analytics_payload(project: &Map<String, Value>) -> Value {
    let get = |key: &str| project.get(key).cloned().unwrap_or(Value::Null);
    let mut out = json!({
        "id": get("id"),
        "name": get("name"),
        "status": get("status"),
        "health": get("health"),
        "priority": get("priority"),
        "isActive": match project.get("isActive") {
            None | Some(Value::Null) => json!(true),
            Some(value) => value.clone(),
        },
    });
    for key in [
        "progress",
        "budgetedAmount",
        "actualAmount",
        "budgetedHours",
        "actualHours",
    ] {
        match project.get(key) {
            None | Some(Value::Null) => {}
            Some(value) => {
                out[key] = number_value(weldsuite_flow_domain::js::js_number_value(Some(value)));
            }
        }
    }
    out
}

/// The project columns as jsonb expressions over the body `$1` (a key
/// absent from the body is `$2`'s fallback per column).
macro_rules! project_values {
    ($fallback:tt) => {
        concat!(
            text_col!("name", "name", $fallback),
            ", ",
            text_col!("description", "description", $fallback),
            ", ",
            text_col!("code", "code", $fallback),
            ", ",
            text_col!("key", "key", $fallback),
            ", ",
            text_col!("customerId", "customer_id", $fallback),
            ", ",
            text_col!("counterpartyId", "counterparty_id", $fallback),
            ", ",
            text_col!("clientId", "client_id", $fallback),
            ", ",
            text_col!("leaderId", "leader_id", $fallback),
            ", ",
            text_col!("administrationId", "administration_id", $fallback),
            ", ",
            text_col!("priority", "priority", $fallback),
            ", ",
            text_col!("type", "type", $fallback),
            ", ",
            text_col!("health", "health", $fallback),
            ", ",
            text_col!("methodology", "methodology", $fallback),
            ", ",
            text_col!("visibility", "visibility", $fallback),
            ", ",
            ts_col!("startDate", "start_date", $fallback),
            ", ",
            ts_col!("endDate", "end_date", $fallback),
            ", ",
            ts_col!("actualStartDate", "actual_start_date", $fallback),
            ", ",
            ts_col!("actualEndDate", "actual_end_date", $fallback),
            ", ",
            num_col!("budgetedHours", "budgeted_hours", $fallback),
            ", ",
            num_col!("budgetedAmount", "budgeted_amount", $fallback),
            ", ",
            text_col!("budgetCurrency", "budget_currency", $fallback),
            ", ",
            text_col!("billingMethod", "billing_method", $fallback),
            ", ",
            num_col!("hourlyRate", "hourly_rate", $fallback),
            ", ",
            text_col!("categoryId", "category_id", $fallback),
            ", ",
            text_col!("color", "color", $fallback),
            ", ",
            text_col!("icon", "icon", $fallback),
            ", ",
            text_col!("coverImage", "cover_image", $fallback),
            ", ",
            json_col!("settings", "settings", $fallback),
            ", ",
            text_col!("whiteboardData", "whiteboard_data", $fallback),
            ", ",
            text_col!("documentData", "document_data", $fallback),
            ", ",
            text_col!("goalsData", "goals_data", $fallback)
        )
    };
}

/// A text column from the body `$1`: the key's text, else `$fallback`
/// (`"col"` keeps the column in an update, `"null"` in an insert).
macro_rules! text_col {
    ($key:literal, $col:literal, "keep") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then $1::jsonb->>'",
            $key,
            "' else ",
            $col,
            " end"
        )
    };
    ($key:literal, $col:literal, "null") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then $1::jsonb->>'",
            $key,
            "' end"
        )
    };
}

macro_rules! ts_col {
    ($key:literal, $col:literal, "keep") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then ($1::jsonb->>'",
            $key,
            "')::timestamp else ",
            $col,
            " end"
        )
    };
    ($key:literal, $col:literal, "null") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then ($1::jsonb->>'",
            $key,
            "')::timestamp end"
        )
    };
}

macro_rules! num_col {
    ($key:literal, $col:literal, "keep") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then ($1::jsonb->>'",
            $key,
            "')::numeric else ",
            $col,
            " end"
        )
    };
    ($key:literal, $col:literal, "null") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then ($1::jsonb->>'",
            $key,
            "')::numeric end"
        )
    };
}

macro_rules! json_col {
    ($key:literal, $col:literal, "keep") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then nullif($1::jsonb->'",
            $key,
            "', 'null'::jsonb) else ",
            $col,
            " end"
        )
    };
    ($key:literal, $col:literal, "null") => {
        concat!(
            "case when $1::jsonb ? '",
            $key,
            "' then nullif($1::jsonb->'",
            $key,
            "', 'null'::jsonb) end"
        )
    };
}

/// The body as Drizzle would bind it to the columns: whole numbers as
/// integers (`String(1)` is `"1"`), objects and arrays as their JSON text
/// for text columns.
pub(crate) fn bindable(values: &Map<String, Value>) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| {
                let value = match value {
                    Value::Number(n) => {
                        let n = n.as_f64().unwrap_or(f64::NAN);
                        Value::String(weldsuite_flow_domain::js::number_text(n))
                    }
                    other => other.clone(),
                };
                (key.clone(), value)
            })
            .collect(),
    )
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match project_body(&headers, &body, false) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let data = match writable(&input.body, &WRITABLE, &TIMESTAMPS) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    reply(
        create_project(&state, &caller, &input, data).await,
        "Failed to create project",
    )
}

async fn create_project(
    state: &FlowState,
    caller: &Caller,
    input: &ProjectBody,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let id = generate_id("prj");
    let now = now();
    let custom = prepare_custom_fields(db, input.custom_fields.as_ref()).await?;
    // The creator manages the project unless the body names someone.
    let manager = match data.get("projectManagerId") {
        Some(Value::Null) | None => caller
            .user()
            .map_or(Value::Null, |u| Value::String(u.to_owned())),
        Some(value) => value.clone(),
    };
    let mut values = data.clone();
    values.insert("projectManagerId".to_owned(), manager);
    sqlx::query(concat!(
        "insert into projects (id, created_at, updated_at, project_manager_id, status,",
        " is_billable, is_active, track_time,",
        " name, description, code, key, customer_id, counterparty_id, client_id, leader_id,",
        " administration_id, priority, type, health, methodology, visibility, start_date,",
        " end_date, actual_start_date, actual_end_date, budgeted_hours, budgeted_amount,",
        " budget_currency, billing_method, hourly_rate, category_id, color, icon, cover_image,",
        " settings, whiteboard_data, document_data, goals_data)",
        " values ($2, $3::timestamp, $3::timestamp, $1::jsonb->>'projectManagerId',",
        " case when $1::jsonb ? 'status' then $1::jsonb->>'status' else 'Planning' end,",
        " case when $1::jsonb ? 'isBillable' then ($1::jsonb->>'isBillable')::boolean else true end,",
        " case when $1::jsonb ? 'isActive' then ($1::jsonb->>'isActive')::boolean else true end,",
        " case when $1::jsonb ? 'trackTime' then ($1::jsonb->>'trackTime')::boolean else true end, ",
        project_values!("null"),
        ")"
    ))
    .bind(bindable(&values))
    .bind(&id)
    .bind(&now)
    .execute(db)
    .await?;
    if let Some(custom) = &custom {
        write_custom_fields(db, &id, custom).await?;
    }
    // The creator joins as an owner member; never fail the create over it.
    if let Some(user) = caller.user() {
        let member_id = generate_id("pmem");
        let added = sqlx::query(
            "insert into project_members
                 (id, project_id, user_id, role, is_active, joined_at, created_at, updated_at)
             values ($1, $2, $3, 'owner', true, $4::timestamp, $4::timestamp, $4::timestamp)",
        )
        .bind(&member_id)
        .bind(&id)
        .bind(user)
        .bind(&now)
        .execute(db)
        .await;
        match added {
            Ok(_) => caller.publish(
                state,
                PROJECT_MEMBER_ADDED,
                &member_id,
                &json!({ "id": member_id, "projectId": id, "userId": user, "role": "owner" }),
            ),
            Err(error) => {
                tracing::error!(%error, "[flow-api/projects] failed to add creator as owner member");
            }
        }
    }
    let created = project_row(db, &id, false).await?;
    let payload = if let Some(Value::Object(row)) = created {
        analytics_payload(&row)
    } else {
        let mut row = data.clone();
        row.insert("id".to_owned(), json!(id));
        analytics_payload(&row)
    };
    caller.publish(state, PROJECT_CREATED, &id, &payload);
    Ok(Created(json!({ "id": id })).into_response())
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match project_body(&headers, &body, true) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match caller.can_manage(&id).await {
        Ok(true) => {}
        Ok(false) => {
            return ApiError::forbidden()
                .with_message("You must be a project owner, admin, or manager to edit this project")
                .into_response();
        }
        Err(error) => return outside(Err(error.into())),
    }
    let data = match writable(&input.body, &WRITABLE, &TIMESTAMPS) {
        Ok(data) => data,
        Err(field) => {
            return ApiError::bad_request(format!("Invalid date: {field}")).into_response();
        }
    };
    reply(
        update_project(&state, &caller, &id, &input, data).await,
        "Failed to update project",
    )
}

async fn update_project(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    input: &ProjectBody,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let Some(Value::Object(existing)) = project_row(db, id, true).await? else {
        return Err(Refusal::not_found("Project", id));
    };
    let custom = prepare_custom_fields(db, input.custom_fields.as_ref()).await?;
    // Handing over the manager seat is an owner-level change.
    if let Some(next) = data.get("projectManagerId")
        && *next
            != existing
                .get("projectManagerId")
                .cloned()
                .unwrap_or(Value::Null)
        && !caller.can_change_owners(id).await?
    {
        return Err(Refusal::forbidden(
            "Only a project owner can change the project manager",
        ));
    }
    sqlx::query(concat!(
        "update projects set project_manager_id = ",
        text_col!("projectManagerId", "project_manager_id", "keep"),
        ", status = ",
        text_col!("status", "status", "keep"),
        ", is_billable = case when $1::jsonb ? 'isBillable' then ($1::jsonb->>'isBillable')::boolean else is_billable end",
        ", is_active = case when $1::jsonb ? 'isActive' then ($1::jsonb->>'isActive')::boolean else is_active end",
        ", track_time = case when $1::jsonb ? 'trackTime' then ($1::jsonb->>'trackTime')::boolean else track_time end",
        ", (name, description, code, key, customer_id, counterparty_id, client_id, leader_id,",
        " administration_id, priority, type, health, methodology, visibility, start_date,",
        " end_date, actual_start_date, actual_end_date, budgeted_hours, budgeted_amount,",
        " budget_currency, billing_method, hourly_rate, category_id, color, icon, cover_image,",
        " settings, whiteboard_data, document_data, goals_data) = row(",
        project_values!("keep"),
        "), updated_at = $3::timestamp",
        " where id = $2 and deleted_at is null"
    ))
    .bind(bindable(&data))
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    if let Some(custom) = &custom {
        write_custom_fields(db, id, custom).await?;
    }
    let mut merged = existing.clone();
    for (key, value) in &data {
        merged.insert(key.clone(), value.clone());
    }
    merged.insert("id".to_owned(), json!(id));
    caller.publish(state, PROJECT_UPDATED, id, &analytics_payload(&merged));
    Ok(Data(json!({ "id": id })).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    let move_to = q.present("moveTasksTo").map(str::to_owned);
    let guard = async {
        if !caller.can_manage(&id).await? {
            return Err(Refusal::forbidden(
                "You must be a project owner, admin, or manager to delete this project",
            ));
        }
        if move_to.as_deref() == Some(id.as_str()) {
            return Err(Refusal::bad_request(
                "Cannot move tasks into the project being deleted",
            ));
        }
        if let Some(dest) = &move_to
            && !caller.can_write(dest).await?
        {
            return Err(Refusal::forbidden(
                "You do not have write access to the destination project",
            ));
        }
        Ok(())
    };
    if let Err(refusal) = guard.await {
        return outside(Err(refusal));
    }
    reply(
        delete_project(&state, &caller, &id, move_to.as_deref()).await,
        "Failed to delete project",
    )
}

async fn delete_project(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    move_to: Option<&str>,
) -> Reply {
    let db = &caller.db;
    let name: Option<String> = sqlx::query_scalar(
        "select name from projects where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(name) = name else {
        return Err(Refusal::not_found("Project", id));
    };
    let now = now();
    let mut moved: Vec<(String, String, Option<String>)> = Vec::new();
    if let Some(dest) = move_to {
        let exists: Option<String> = sqlx::query_scalar(
            "select id from projects where id = $1 and deleted_at is null limit 1",
        )
        .bind(dest)
        .fetch_optional(db)
        .await?;
        if exists.is_none() {
            return Err(Refusal::not_found("Project", dest));
        }
        moved = transfer_tasks(db, id, dest, &now).await?;
    } else {
        sqlx::query(
            "update projects set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(id)
        .bind(&now)
        .execute(db)
        .await?;
    }
    caller.publish(
        state,
        PROJECT_DELETED,
        id,
        &json!({ "id": id, "name": name }),
    );
    for (task_id, title, status) in moved {
        caller.publish(
            state,
            PROJECT_TASK_UPDATED,
            &task_id,
            &json!({ "id": task_id, "title": title, "projectId": move_to, "status": status }),
        );
    }
    Ok(NoContent.into_response())
}

/// `planTaskTransfer` + the soft delete, in one transaction: every live
/// task of `source` lands in `dest` where `stagePlacement` puts its status,
/// project-scoped references cleared, positions offset past the
/// destination's last task. The moved tasks, as `(id, title, status)`.
async fn transfer_tasks(
    db: &PgPool,
    source: &str,
    dest: &str,
    now: &str,
) -> Result<Vec<(String, String, Option<String>)>, sqlx::Error> {
    let moving: Vec<(String, String, String)> = sqlx::query_as(
        "select id, title, status from tasks where project_id = $1 and deleted_at is null",
    )
    .bind(source)
    .fetch_all(db)
    .await?;
    let place = stage_placement(db, dest).await?;
    let max_position: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from tasks where project_id = $1 and deleted_at is null",
    )
    .bind(dest)
    .fetch_one(db)
    .await?;
    let offset = if max_position == 0 { 0 } else { max_position } + 1;
    let moved: Vec<(String, String, Option<String>, bool)> = moving
        .into_iter()
        .map(|(id, title, status)| {
            let placed = place.place(Some(&status));
            (id, title, placed.status, placed.matched)
        })
        .collect();
    let mut kept: Vec<String> = Vec::new();
    for (_, _, status, matched) in &moved {
        if let (true, Some(status)) = (matched, status)
            && !kept.contains(status)
        {
            kept.push(status.clone());
        }
    }
    let fallback = place.place(None);
    let mut tx = db.begin().await?;
    for status in &kept {
        let placed = place.place(Some(status));
        sqlx::query(
            "update tasks set project_id = $1, sprint_id = null, milestone_id = null, key = null,
                    board_position = null, position = position + $2, updated_at = $3::timestamp,
                    stage_id = $4, status = $5
             where project_id = $6 and deleted_at is null and status = any($7)",
        )
        .bind(dest)
        .bind(offset)
        .bind(now)
        .bind(placed.stage_id.as_deref())
        .bind(status)
        .bind(source)
        .bind(task_status_aliases(status))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "update tasks set project_id = $1, sprint_id = null, milestone_id = null, key = null,
                board_position = null, position = position + $2, updated_at = $3::timestamp,
                stage_id = $4, status = $5
         where project_id = $6 and deleted_at is null",
    )
    .bind(dest)
    .bind(offset)
    .bind(now)
    .bind(fallback.stage_id.as_deref())
    .bind(fallback.status.as_deref())
    .bind(source)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update projects set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(source)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(moved
        .into_iter()
        .map(|(id, title, status, _)| (id, title, status))
        .collect())
}
