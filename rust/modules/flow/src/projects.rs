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
use sea_orm::sea_query::{Expr, Func, NullOrdering, Query as SqlQuery, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, Order,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, TransactionTrait,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    PROJECT_CREATED, PROJECT_DELETED, PROJECT_MEMBER_ADDED, PROJECT_TASK_UPDATED, PROJECT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    PROJECTS_CREATE, PROJECTS_DELETE, PROJECTS_READ, PROJECTS_UPDATE, TASKS_CREATE, TASKS_READ,
};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, orm_error, utc_now};
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
use weldsuite_schema::tenant::{
    milestones, project_members, projects, task_dependencies, tasks, workspace_members,
};

use crate::custom_values::{self, Definition};
use crate::import_jobs;
use crate::{
    Caller, FlowState, Query, Refusal, Reply, json_rows, keyset_before, keyset_cursor, now,
    outside, reply, row_json, validate,
};

const NOT_A_MEMBER: &str = "You are not a member of this project";
const PROJECT_ENTITY: &str = "project";
const PROJECTS: JsonTable = JsonTable::of::<projects::Entity>();

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        // Membership-scoped, not gated on `projects:read`; the handler still
        // reads `projects:scope:all`, so the permissions are resolved first.
        .route("/", get(list).route_layer(gate.resolve()))
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
            "/{id}/tabs",
            axum::routing::put(crate::project_tabs::put_tabs).route_layer(need(PROJECTS_UPDATE)),
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
pub(crate) async fn project_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, DbErr> {
    let mut find = projects::Entity::find().filter(projects::Column::Id.eq(id));
    if live {
        find = find.filter(projects::Column::DeletedAt.is_null());
    }
    find.one(&orm(db)).await?.map(row_json).transpose()
}

/// `withProjectStats(hydrate(rows))`.
async fn decorate(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, DbErr> {
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let stats = project_stats(db, &ids).await.map_err(orm_error)?;
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
        "closed" => "Closed".to_owned(),
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

/// The list's filters.
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

impl Filters {
    /// The list's `where`, without the keyset cursor.
    fn condition(&self) -> Condition {
        use projects::Column;
        let mut all = Condition::all().add(Column::DeletedAt.is_null());
        if let Some((user, ids)) = &self.member_of {
            all = all.add(
                Condition::any()
                    .add(Column::ProjectManagerId.eq(user.as_str()))
                    .add(Column::Id.is_in(ids)),
            );
        }
        if let Some(status) = &self.derived_status {
            all = all.add(sea_orm::ExprTrait::eq(derived_status(), status.as_str()));
        }
        if let Some(key) = &self.status_key {
            // `lower(regexp_replace(p.status, '[\s_-]+', '', 'g'))`.
            let squashed = Func::lower(regexp_replace(
                Expr::col((projects::Entity, Column::Status)),
                r"[\s_-]+",
                "",
            ));
            all = all.add(sea_orm::ExprTrait::eq(Expr::from(squashed), key.as_str()));
        }
        if let Some(priority) = &self.priority {
            all = all.add(if priority == "medium" {
                sea_orm::ExprTrait::eq(priority_or_medium(), "medium")
            } else {
                sea_orm::ExprTrait::eq(
                    Expr::from(Func::lower(btrim(Expr::col((
                        projects::Entity,
                        Column::Priority,
                    ))))),
                    priority.as_str(),
                )
            });
        }
        if let Some(owner) = &self.owner_id {
            // The manager, or an active owner member (`exists (…)`).
            let owners = SqlQuery::select()
                .column(project_members::Column::ProjectId)
                .from(project_members::Entity)
                .and_where(project_members::Column::UserId.eq(owner.as_str()))
                .and_where(sea_orm::ExprTrait::eq(
                    Expr::from(Func::lower(Expr::col(project_members::Column::Role))),
                    "owner",
                ))
                .and_where(project_members::Column::IsActive.eq(true))
                .and_where(project_members::Column::DeletedAt.is_null())
                .to_owned();
            all = all.add(
                Condition::any()
                    .add(Column::ProjectManagerId.eq(owner.as_str()))
                    .add(Column::Id.in_subquery(owners)),
            );
        }
        if let Some(customer) = &self.customer_id {
            all = all.add(Column::CustomerId.eq(customer.as_str()));
        }
        if let Some(active) = self.is_active {
            all = all.add(Column::IsActive.eq(active));
        }
        if let Some(search) = &self.search {
            all = all.add(
                Condition::any()
                    .add(Column::Name.ilike(search.as_str()))
                    .add(Column::Code.ilike(search.as_str())),
            );
        }
        all
    }
}

/// `btrim(x)`.
fn btrim(expr: impl Into<Expr>) -> Expr {
    Func::cust("btrim").arg(expr.into()).into()
}

/// `regexp_replace(x, pattern, with, 'g')`.
fn regexp_replace(expr: impl Into<Expr>, pattern: &str, with: &str) -> Expr {
    Func::cust("regexp_replace")
        .arg(expr.into())
        .arg(pattern)
        .arg(with)
        .arg("g")
        .into()
}

/// `regexp_replace(lower(btrim(col)), '[\s-]+', '_', 'g')`.
fn status_word(column: projects::Column) -> Expr {
    regexp_replace(
        Func::lower(btrim(Expr::col((projects::Entity, column)))),
        r"[\s-]+",
        "_",
    )
}

/// `lower(coalesce(nullif(btrim(p.priority), ''), 'medium'))`.
fn priority_or_medium() -> Expr {
    let set = Func::cust("nullif")
        .arg(btrim(Expr::col((
            projects::Entity,
            projects::Column::Priority,
        ))))
        .arg("");
    Func::lower(Func::coalesce([Expr::from(set), Expr::val("medium")])).into()
}

/// The status the All Projects table shows for a row (`DERIVED_STATUS_SQL`):
/// a set `health` wins, else the stored `status`.
fn derived_status() -> Expr {
    use projects::Column;
    let word = |column, value: &str| sea_orm::ExprTrait::eq(status_word(column), value);
    let health_set = sea_orm::ExprTrait::ne(
        Expr::from(Func::coalesce([
            btrim(Expr::col((projects::Entity, Column::Health))),
            Expr::val(""),
        ])),
        "",
    );
    let health = Expr::case(word(Column::Health, "at_risk"), "at-risk")
        .case(word(Column::Health, "off_track"), "off-track")
        .case(word(Column::Health, "critical"), "off-track")
        .finally("on-track");
    let status = Expr::case(word(Column::Status, "on_hold"), "on-hold")
        .case(word(Column::Status, "completed"), "completed")
        .case(word(Column::Status, "archived"), "completed")
        .case(word(Column::Status, "cancelled"), "off-track")
        .finally("on-track");
    Expr::case(health_set, health).finally(status).into()
}

/// Priority rank for sorting; an unset priority sorts as "medium".
fn priority_rank() -> Expr {
    let is = |value: &str| sea_orm::ExprTrait::eq(priority_or_medium(), value);
    Expr::case(is("critical"), 4)
        .case(is("high"), 3)
        .case(is("medium"), 2)
        .case(is("low"), 1)
        .finally(0)
        .into()
}

/// The name of the project's first owner member.
fn owner_name() -> Expr {
    use sea_orm::ExprTrait as _;
    let first_owner: SelectStatement = SqlQuery::select()
        .column((workspace_members::Entity, workspace_members::Column::Name))
        .from(project_members::Entity)
        .inner_join(
            workspace_members::Entity,
            Expr::col((workspace_members::Entity, workspace_members::Column::UserId))
                .equals((project_members::Entity, project_members::Column::UserId)),
        )
        .and_where(
            Expr::col((project_members::Entity, project_members::Column::ProjectId))
                .equals((projects::Entity, projects::Column::Id)),
        )
        .and_where(sea_orm::ExprTrait::eq(
            Expr::from(Func::lower(Expr::col((
                project_members::Entity,
                project_members::Column::Role,
            )))),
            "owner",
        ))
        .and_where(Expr::col((project_members::Entity, project_members::Column::IsActive)).eq(true))
        .and_where(
            Expr::col((project_members::Entity, project_members::Column::DeletedAt)).is_null(),
        )
        .order_by(
            (project_members::Entity, project_members::Column::CreatedAt),
            Order::Asc,
        )
        .limit(1)
        .to_owned();
    Expr::SubQuery(None, Box::new(first_owner.into()))
}

/// The explicit sort's key (`sortField:sortDirection`), which sorts nulls last.
fn sort_key(order: &str) -> Option<(Expr, Order)> {
    use projects::Column;
    let (field, direction) = order.split_once(':')?;
    let direction = if direction == "asc" {
        Order::Asc
    } else {
        Order::Desc
    };
    let key = match field {
        "name" => Func::lower(Expr::col((projects::Entity, Column::Name))).into(),
        "status" => derived_status(),
        "priority" => priority_rank(),
        "dueDate" => Expr::col((projects::Entity, Column::EndDate)),
        "owner" => Func::lower(owner_name()).into(),
        // Only `createdAt:asc` is an explicit sort; `desc` is the default order.
        "createdAt" if direction == Order::Asc => Expr::col((projects::Entity, Column::CreatedAt)),
        _ => return None,
    };
    Some((key, direction))
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
        use project_members::Column;
        let ids: Vec<String> = project_members::Entity::find()
            .select_only()
            .column(Column::ProjectId)
            .filter(Column::UserId.eq(user))
            .filter(Column::IsActive.eq(true))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&caller.db))
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
    let mut keyset: Option<(PrimitiveDateTime, String)> = None;
    if order.is_none()
        && let Some(cursor) = q.present("cursor")
    {
        keyset = keyset_cursor(
            &caller.db,
            projects::Column::Id,
            projects::Column::CreatedAt,
            cursor,
        )
        .await?;
    }
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows = list_page(
            &caller.db,
            &filters,
            keyset.as_ref(),
            order.as_deref(),
            ascending,
            (limit, offset),
        )
        .await?;
        let total = i64::try_from(
            projects::Entity::find()
                .filter(filters.condition())
                .count(&orm(&caller.db))
                .await?,
        )
        .unwrap_or(i64::MAX);
        let mut data: Vec<Value> = json_rows(rows)?;
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

/// One page of the list: the filters, after the keyset cursor, in the
/// explicit sort (then `created_at, id` in its direction) or newest first.
async fn list_page(
    db: &PgPool,
    filters: &Filters,
    keyset: Option<&(PrimitiveDateTime, String)>,
    order: Option<&str>,
    ascending: bool,
    (limit, offset): (i64, i64),
) -> Result<Vec<projects::Model>, DbErr> {
    use projects::Column;
    let mut find = projects::Entity::find().filter(filters.condition());
    if let Some(keyset) = keyset {
        find = find.filter(keyset_before(Column::Id, Column::CreatedAt, keyset));
    }
    if let Some((key, direction)) = order.and_then(sort_key) {
        find = find.order_by_with_nulls(key, direction, NullOrdering::Last);
    }
    let tail = if order.is_some() && ascending {
        Order::Asc
    } else {
        Order::Desc
    };
    find.order_by(Column::CreatedAt, tail.clone())
        .order_by(Column::Id, tail)
        .limit(crate::fetch_limit(limit)?)
        .offset(
            u64::try_from(offset)
                .map_err(|_| DbErr::Custom("OFFSET must not be negative".to_owned()))?,
        )
        .all(&orm(db))
        .await
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

/// The avatar is the account picture (`master`), not the member row's copy.
async fn active_members(
    db: &PgPool,
    master: Option<&PgPool>,
    project_ids: &[String],
) -> Result<Vec<MemberLoad>, DbErr> {
    use project_members::Column;
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    // Unordered, so the plan decides the order: the projects as Drizzle's
    // `inArray` sends them (`in ($1, …)`; Postgres reads one as `= $1`).
    let rows: Vec<Row> = project_members::Entity::find()
        .select_only()
        .columns([Column::UserId, Column::Role])
        .column_as(
            as_text((project_members::Entity, Column::AllocationPercentage)),
            "allocation_percentage",
        )
        .column_as(
            as_text((
                workspace_members::Entity,
                workspace_members::Column::HoursPerWeek,
            )),
            "hours_per_week",
        )
        .column(workspace_members::Column::Name)
        .column(workspace_members::Column::Email)
        .join(
            JoinType::LeftJoin,
            project_members::Entity::belongs_to(workspace_members::Entity)
                .from(Column::UserId)
                .to(workspace_members::Column::UserId)
                .into(),
        )
        .filter(Column::ProjectId.is_in(project_ids))
        .filter(Column::IsActive.eq(true))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let pictures = weldsuite_db::AccountPictures::load(
        master,
        rows.iter().map(|(user_id, ..)| user_id.as_str()),
    )
    .await;
    Ok(rows
        .into_iter()
        .map(|(user_id, role, allocation, hours, name, email)| {
            let avatar = pictures.get(&user_id).map(str::to_owned);
            MemberLoad {
                user_id,
                role: Value::String(role),
                allocation: or_default(allocation.as_deref().map(js_text_number), 100.0),
                hours_per_week: hours.map_or(Value::Null, Value::String),
                name,
                email,
                avatar,
            }
        })
        .collect())
}

/// `col::text`: a `numeric` exactly as Postgres prints it.
fn as_text(column: impl sea_orm::sea_query::IntoColumnRef) -> Expr {
    sea_orm::ExprTrait::cast_as(Expr::col(column), "text")
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

/// A task as the workload views select it.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadTask {
    id: String,
    number: Option<i32>,
    key: Option<String>,
    title: String,
    project_id: Option<String>,
    assignee_id: Option<String>,
    status: String,
    priority: String,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    start_date: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    due_date: Option<PrimitiveDateTime>,
    estimated_hours: Option<String>,
    actual_hours: Option<String>,
}

impl WorkloadTask {
    /// The open tasks (`status not in ('done', 'cancelled')`), with a task's
    /// estimate in hours as text (`workloadEstimateHours`): `estimated_hours`,
    /// else its `duration` (minutes), which the task panel's estimate picker
    /// writes.
    fn open() -> sea_orm::Select<tasks::Entity> {
        use tasks::Column;
        let from_duration = Func::round_with_precision(
            sea_orm::ExprTrait::div(
                Expr::col(Column::Duration),
                sea_orm::ExprTrait::cast_as(Expr::val(60), "numeric"),
            ),
            2,
        );
        let estimate = Func::coalesce([Expr::col(Column::EstimatedHours), from_duration.into()]);
        tasks::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Number,
                Column::Key,
                Column::Title,
                Column::ProjectId,
                Column::AssigneeId,
                Column::Status,
                Column::Priority,
                Column::StartDate,
                Column::DueDate,
            ])
            .column_as(
                sea_orm::ExprTrait::cast_as(Expr::from(estimate), "text"),
                "estimated_hours",
            )
            .column_as(as_text(Column::ActualHours), "actual_hours")
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.is_not_in(["done", "cancelled"]))
    }

    fn json(&self) -> Result<Value, DbErr> {
        row_json(self)
    }
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
    let mut live = projects::Entity::find()
        .select_only()
        .columns([projects::Column::Id, projects::Column::Name])
        .filter(projects::Column::DeletedAt.is_null());
    if let Some(ids) = &accessible {
        live = live.filter(projects::Column::Id.is_in(ids));
    }
    let projects: Vec<(String, String)> = live.into_tuple().all(&orm(db)).await?;
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
    for member in active_members(db, caller.request_master(), &ids).await? {
        if let Some(seen) = unique.iter_mut().find(|(m, _)| m.user_id == member.user_id) {
            seen.1 += member.allocation;
        } else {
            let allocation = member.allocation;
            unique.push((member, allocation));
        }
    }
    // The projects as `inArray` sends them (see `active_members`).
    let tasks: Vec<Value> = WorkloadTask::open()
        .filter(tasks::Column::ProjectId.is_in(&ids))
        .into_model::<WorkloadTask>()
        .all(&orm(db))
        .await?
        .iter()
        .map(WorkloadTask::json)
        .collect::<Result<_, _>>()?;
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
    let Some(name) = live_project_name(db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    let members = active_members(db, caller.request_master(), &[project_id.to_owned()]).await?;
    let tasks: Vec<Value> = WorkloadTask::open()
        .filter(tasks::Column::ProjectId.eq(project_id))
        .filter(tasks::Column::AssigneeId.is_not_null())
        .into_model::<WorkloadTask>()
        .all(&orm(db))
        .await?
        .iter()
        .map(WorkloadTask::json)
        .collect::<Result<_, _>>()?;
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

/// The name of a live project.
async fn live_project_name(db: &PgPool, project_id: &str) -> Result<Option<String>, DbErr> {
    projects::Entity::find()
        .select_only()
        .column(projects::Column::Name)
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

// ── GET /search ─────────────────────────────────────────────────────────────

async fn search(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let term = q.present("q").map(contains_pattern);
    reply(
        async {
            use projects::Column;
            if caller.user().is_none() {
                return Err(ApiError::unauthorized().into());
            }
            let accessible = caller.accessible_project_ids().await?;
            if accessible.as_ref().is_some_and(Vec::is_empty) {
                return Ok(Data(json!([])).into_response());
            }
            let mut found = projects::Entity::find().filter(Column::DeletedAt.is_null());
            if let Some(ids) = &accessible {
                found = found.filter(Column::Id.is_in(ids));
            }
            if let Some(term) = term.as_deref() {
                found = found.filter(
                    Condition::any()
                        .add(Column::Name.ilike(term))
                        .add(Column::Description.ilike(term))
                        .add(Column::Code.ilike(term)),
                );
            }
            let rows = found
                .order_by_desc(Column::Name)
                .limit(20)
                .all(&orm(&caller.db))
                .await?;
            let rows: Vec<Value> = json_rows(rows)?;
            let ids: Vec<String> = rows
                .iter()
                .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
                .collect();
            let stats = project_stats(&caller.db, &ids).await.map_err(orm_error)?;
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

/// A task as the Gantt chart reads it.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GanttTask {
    id: String,
    title: String,
    project_id: Option<String>,
    milestone_id: Option<String>,
    parent_task_id: Option<String>,
    sprint_id: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    start_date: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    due_date: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    completed_date: Option<PrimitiveDateTime>,
    status: String,
    priority: String,
    progress: Option<String>,
    assignee_id: Option<String>,
    #[serde(rename = "type")]
    type_: Option<String>,
    depends_on: Option<Value>,
    blocks: Option<Value>,
    estimated_hours: Option<String>,
    actual_hours: Option<String>,
}

impl GanttTask {
    /// The project's live tasks by start, then due date.
    async fn of_project(db: &PgPool, project_id: &str) -> Result<Vec<Value>, DbErr> {
        use tasks::Column;
        let rows = tasks::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Title,
                Column::ProjectId,
                Column::MilestoneId,
                Column::ParentTaskId,
                Column::SprintId,
                Column::StartDate,
                Column::DueDate,
                Column::CompletedDate,
                Column::Status,
                Column::Priority,
            ])
            .column_as(as_text(Column::Progress), "progress")
            .column(Column::AssigneeId)
            .column_as(Column::Type, "type_")
            .columns([Column::DependsOn, Column::Blocks])
            .column_as(as_text(Column::EstimatedHours), "estimated_hours")
            .column_as(as_text(Column::ActualHours), "actual_hours")
            .filter(Column::ProjectId.eq(project_id))
            .filter(Column::DeletedAt.is_null())
            .order_by_asc(Column::StartDate)
            .order_by_asc(Column::DueDate)
            .into_model::<Self>()
            .all(&orm(db))
            .await?;
        json_rows(rows)
    }
}

/// A milestone as the Gantt chart reads it.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GanttMilestone {
    id: String,
    name: String,
    description: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    due_date: PrimitiveDateTime,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    completed_at: Option<PrimitiveDateTime>,
    status: String,
    progress: Option<String>,
    owner_id: Option<String>,
    is_key_milestone: Option<bool>,
    depends_on: Option<Value>,
    completed_tasks: Option<i32>,
    total_tasks: Option<i32>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
}

impl GanttMilestone {
    /// The project's live milestones by due date.
    async fn of_project(db: &PgPool, project_id: &str) -> Result<Vec<Value>, DbErr> {
        use milestones::Column;
        let rows = milestones::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::Name,
                Column::Description,
                Column::DueDate,
                Column::CompletedAt,
                Column::Status,
            ])
            .column_as(as_text(Column::Progress), "progress")
            .columns([
                Column::OwnerId,
                Column::IsKeyMilestone,
                Column::DependsOn,
                Column::CompletedTasks,
                Column::TotalTasks,
                Column::CreatedAt,
            ])
            .filter(Column::ProjectId.eq(project_id))
            .filter(Column::DeletedAt.is_null())
            .order_by_asc(Column::DueDate)
            .into_model::<Self>()
            .all(&orm(db))
            .await?;
        json_rows(rows)
    }
}

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
    match GanttTask::of_project(&caller.db, &id).await {
        Ok(rows) => Data(rows).into_response(),
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
            let rows = GanttMilestone::of_project(&caller.db, &id).await?;
            let stats = milestone_stats(&caller.db, &milestone_refs(&rows))
                .await
                .map_err(orm_error)?;
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
        custom_values::ValuesError::Database(error) => Refusal::from(error),
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

/// The writable project keys and their columns (the insert's and the
/// update's `project_values`).
const COLUMNS: [(&str, &str); 31] = [
    ("name", "name"),
    ("description", "description"),
    ("code", "code"),
    ("key", "key"),
    ("customerId", "customer_id"),
    ("counterpartyId", "counterparty_id"),
    ("clientId", "client_id"),
    ("leaderId", "leader_id"),
    ("administrationId", "administration_id"),
    ("priority", "priority"),
    ("type", "type"),
    ("health", "health"),
    ("methodology", "methodology"),
    ("visibility", "visibility"),
    ("startDate", "start_date"),
    ("endDate", "end_date"),
    ("actualStartDate", "actual_start_date"),
    ("actualEndDate", "actual_end_date"),
    ("budgetedHours", "budgeted_hours"),
    ("budgetedAmount", "budgeted_amount"),
    ("budgetCurrency", "budget_currency"),
    ("billingMethod", "billing_method"),
    ("hourlyRate", "hourly_rate"),
    ("categoryId", "category_id"),
    ("color", "color"),
    ("icon", "icon"),
    ("coverImage", "cover_image"),
    ("settings", "settings"),
    ("whiteboardData", "whiteboard_data"),
    ("documentData", "document_data"),
    ("goalsData", "goals_data"),
];

/// The keys written with a fallback of their own on insert.
const WITH_FALLBACK: [(&str, &str); 5] = [
    ("projectManagerId", "project_manager_id"),
    ("status", "status"),
    ("isBillable", "is_billable"),
    ("isActive", "is_active"),
    ("trackTime", "track_time"),
];

/// The body's keys by column, as `jsonb_populate_record` converts them:
/// Postgres casts each to its column's type, as the `->>` casts did.
/// `fallback` is the value of a key the body leaves out (`None`: the column
/// is not written).
fn project_columns(
    body: &Map<String, Value>,
    fallback: impl Fn(&str) -> Option<Value>,
) -> Map<String, Value> {
    let mut row = Map::new();
    for (key, column) in WITH_FALLBACK.iter().chain(COLUMNS.iter()) {
        if let Some(value) = body.get(*key).cloned().or_else(|| fallback(key)) {
            row.insert((*column).to_owned(), value);
        }
    }
    row
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
    let at = time::OffsetDateTime::now_utc();
    let now = weldsuite_events::iso_timestamp(at);
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
    let Value::Object(body) = bindable(&values) else {
        return Err(Refusal::Internal("body is not an object".to_owned()));
    };
    // Every column named: a key the body sent (even as `null`), else the
    // insert's own default.
    let mut row = project_columns(&body, |key| {
        Some(match key {
            "status" => json!("Planning"),
            "isBillable" | "isActive" | "trackTime" => json!(true),
            _ => Value::Null,
        })
    });
    row.insert("id".to_owned(), json!(id));
    row.insert("created_at".to_owned(), json!(now));
    row.insert("updated_at".to_owned(), json!(now));
    PROJECTS.insert(&orm(db), row).await?;
    if let Some(custom) = &custom {
        write_custom_fields(db, &id, custom).await?;
    }
    // The creator joins as an owner member; never fail the create over it.
    if let Some(user) = caller.user() {
        let member_id = generate_id("pmem");
        let at = weldsuite_db::utc_timestamp(at);
        let added = project_members::Entity::insert(project_members::ActiveModel {
            id: Set(member_id.clone()),
            project_id: Set(id.clone()),
            user_id: Set(user.to_owned()),
            role: Set("owner".to_owned()),
            is_active: Set(true),
            joined_at: Set(at),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
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
    let Value::Object(body) = bindable(&data) else {
        return Err(Refusal::Internal("body is not an object".to_owned()));
    };
    // A key the body leaves out keeps its column.
    let mut row = project_columns(&body, |_| None);
    row.insert("updated_at".to_owned(), json!(now()));
    PROJECTS.update(&orm(db), id, row, true).await?;
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
    let Some(name) = live_project_name(db, id).await? else {
        return Err(Refusal::not_found("Project", id));
    };
    let now = utc_now();
    let mut moved: Vec<(String, String, Option<String>)> = Vec::new();
    if let Some(dest) = move_to {
        if !crate::raid_store::live_project_exists(db, dest).await? {
            return Err(Refusal::not_found("Project", dest));
        }
        moved = transfer_tasks(db, id, dest, now).await?;
    } else {
        soft_delete(id, now).exec(&orm(db)).await?;
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
    now: PrimitiveDateTime,
) -> Result<Vec<(String, String, Option<String>)>, DbErr> {
    use tasks::Column;
    let moving: Vec<(String, String, String)> = tasks::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Title, Column::Status])
        .filter(Column::ProjectId.eq(source))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let place = stage_placement(db, dest).await.map_err(orm_error)?;
    // `coalesce(max(position), 0)`.
    let max_position: Option<i32> = tasks::Entity::find()
        .select_only()
        .column_as(Column::Position.max(), "max")
        .filter(Column::ProjectId.eq(dest))
        .filter(Column::DeletedAt.is_null())
        .into_tuple::<Option<i32>>()
        .one(&orm(db))
        .await?
        .flatten();
    let max_position = max_position.unwrap_or(0);
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
    // Into `dest` at `stage`/`status`: project-scoped references cleared,
    // positions offset past the destination's last task.
    let move_into = |stage: Option<&str>, status: Option<&str>| {
        tasks::Entity::update_many()
            .col_expr(Column::ProjectId, Expr::value(dest))
            .col_expr(Column::SprintId, Expr::value(Option::<String>::None))
            .col_expr(Column::MilestoneId, Expr::value(Option::<String>::None))
            .col_expr(Column::DeliverableId, Expr::value(Option::<String>::None))
            .col_expr(Column::Key, Expr::value(Option::<String>::None))
            .col_expr(Column::BoardPosition, Expr::value(Option::<i32>::None))
            .col_expr(
                Column::Position,
                sea_orm::ExprTrait::add(Expr::col(Column::Position), offset),
            )
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .col_expr(Column::StageId, Expr::value(stage.map(str::to_owned)))
            .col_expr(Column::Status, Expr::value(status.map(str::to_owned)))
            .filter(Column::ProjectId.eq(source))
            .filter(Column::DeletedAt.is_null())
    };
    let tx = orm(db).begin().await?;
    for status in &kept {
        let placed = place.place(Some(status));
        move_into(placed.stage_id.as_deref(), Some(status))
            .filter(Column::Status.is_in(task_status_aliases(status)))
            .exec(&tx)
            .await?;
    }
    move_into(fallback.stage_id.as_deref(), fallback.status.as_deref())
        .exec(&tx)
        .await?;
    // Links travel with their tasks: a dependency's project is its tasks' project.
    task_dependencies::Entity::update_many()
        .col_expr(task_dependencies::Column::ProjectId, Expr::value(dest))
        .filter(task_dependencies::Column::ProjectId.eq(source))
        .exec(&tx)
        .await?;
    soft_delete(source, now).exec(&tx).await?;
    tx.commit().await?;
    Ok(moved
        .into_iter()
        .map(|(id, title, status, _)| (id, title, status))
        .collect())
}

/// The project soft-deleted: `deletedAt` and `updatedAt` set to `now`.
fn soft_delete(id: &str, now: PrimitiveDateTime) -> sea_orm::UpdateMany<projects::Entity> {
    projects::Entity::update_many()
        .col_expr(projects::Column::DeletedAt, Expr::value(Some(now)))
        .col_expr(projects::Column::UpdatedAt, Expr::value(now))
        .filter(projects::Column::Id.eq(id))
}
