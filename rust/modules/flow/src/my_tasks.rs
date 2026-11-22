//! `/api/my-tasks` (`routes/my-tasks/index.ts`): the tasks assigned to the
//! caller (as the assignee or one of the assignees) across every project,
//! enriched with a project summary; page-based. Read-only.

// The handlers follow the TypeScript route bodies one to one (long
// functions, `data`/`date`-style names from the original), and the list
// queries bind tuples of optional columns.
#![allow(
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::type_complexity,
    clippy::struct_excessive_bools,
    clippy::ref_option,
    clippy::cast_sign_loss
)]

use std::sync::Arc;

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use sea_orm::sea_query::{CaseStatement, Expr, Func, Order};
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{orm, orm_error, utc_timestamp};
use weldsuite_flow_domain::day_bounds::workspace_day_bounds;
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_flow_domain::stage::task_status_aliases;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use weldsuite_schema::tenant::{projects, tasks};

use crate::task_enrich::{attach_tree_across_projects, enrich};
use crate::tasks::{SORT_FIELDS, csv_list, query_boolean, query_number, query_text};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, outside, project_not_deleted, reply, row_json,
    validate_value,
};

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(list).route_layer(gate.require(["tasks:read".to_owned()])),
        )
        .with_state(state)
}

const BUCKETS: [&str; 5] = ["overdue", "today", "this-week", "later", "no-date"];

/// `myTasksFiltersSchema`.
struct Filters {
    page: f64,
    page_size: f64,
    status: Option<String>,
    exclude_status: Option<Vec<String>>,
    priority: Option<String>,
    search: Option<String>,
    project_id: Option<String>,
    label_ids: Option<Vec<String>>,
    due_bucket: Option<String>,
    sort_field: String,
    sort_direction: String,
    include_subtasks: bool,
}

fn read_filters(issues: &mut Issues, f: &Map<String, Value>) -> Filters {
    let page = query_number(issues, f, "page", None, 1.0);
    let page_size = query_number(issues, f, "pageSize", Some(100.0), 50.0);
    let status = query_text(issues, f, "status");
    let exclude_status = csv_list(f, "excludeStatus");
    let priority = query_text(issues, f, "priority");
    let search = query_text(issues, f, "search");
    let project_id = query_text(issues, f, "projectId");
    let label_ids = csv_list(f, "labelIds");
    let due_bucket = issues
        .choice(f, "dueDateBucket", Presence::Optional, &BUCKETS)
        .into_option();
    let sort_field = issues
        .choice(f, "sortField", Presence::Optional, &SORT_FIELDS)
        .into_option()
        .unwrap_or_else(|| "position".to_owned());
    let sort_direction = issues
        .choice(f, "sortDirection", Presence::Optional, &["asc", "desc"])
        .into_option()
        .unwrap_or_else(|| "asc".to_owned());
    let include_subtasks = query_boolean(issues, f, "includeSubtasks").unwrap_or(false);
    Filters {
        page,
        page_size,
        status,
        exclude_status,
        priority,
        search,
        project_id,
        label_ids,
        due_bucket,
        sort_field,
        sort_direction,
        include_subtasks,
    }
}

async fn list(State(state): State<FlowState>, caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let filters = match validate_value(&Value::Object(q.values().clone()), read_filters) {
        Ok(filters) => filters,
        Err(refused) => return refused.respond("Invalid query"),
    };
    outside(my_tasks(&state, &caller, &filters).await)
}

/// `myTasksFilters`: live tasks of live projects (or of none) assigned to
/// `user`, with the query's filters.
fn my_task_filters(user: &str, f: &Filters, p: &Params) -> Condition {
    use tasks::Column;
    let mut filters = Condition::all()
        .add(Column::DeletedAt.is_null())
        .add(project_not_deleted(Column::ProjectId))
        .add(Condition::any().add(Column::AssigneeId.eq(user)).add(
            sea_orm::sea_query::extension::postgres::PgExpr::contains(
                Expr::col((tasks::Entity, Column::AssigneeIds)),
                json!([user]),
            ),
        ));
    if let Some(statuses) = &p.statuses {
        filters = filters.add(Column::Status.is_in(statuses.iter().map(String::as_str)));
    }
    if let Some(excluded) = &p.excluded {
        filters = filters.add(Column::Status.is_not_in(excluded.iter().map(String::as_str)));
    }
    if let Some(priority) = f.priority.as_deref().filter(|v| !v.is_empty()) {
        filters = filters.add(Column::Priority.eq(priority));
    }
    if let Some(project_id) = f.project_id.as_deref().filter(|v| !v.is_empty()) {
        filters = filters.add(Column::ProjectId.eq(project_id));
    }
    if let Some(labels) = &f.label_ids {
        // `labels ?| $labels`.
        filters = filters.add(Expr::from(
            Func::cust("jsonb_exists_any")
                .arg(Expr::col((tasks::Entity, Column::Labels)))
                .arg(Expr::val(labels.clone())),
        ));
    }
    if let Some(bucket) = f.due_bucket.as_deref() {
        filters = filters.add(due_bucket(bucket, &p.bounds));
    }
    if let Some(search) = p.search.as_deref() {
        filters = filters.add(
            Condition::any()
                .add(Column::Title.ilike(search))
                .add(Column::Description.ilike(search))
                .add(Column::Key.ilike(search)),
        );
    }
    filters
}

/// The due-date bucket over the workspace's day bounds (start of today, of
/// tomorrow, of next week); a missing bound matches nothing, as `null` did.
fn due_bucket(bucket: &str, bounds: &[Option<PrimitiveDateTime>; 3]) -> Condition {
    use tasks::Column;
    let none = || Condition::all().add(Expr::value(false));
    match bucket {
        "overdue" => bounds[0].map_or_else(none, |today| {
            Condition::all()
                .add(Column::DueDate.lt(today))
                .add(Column::DueDate.is_not_null())
        }),
        "today" => match (bounds[0], bounds[1]) {
            (Some(today), Some(tomorrow)) => Condition::all()
                .add(Column::DueDate.gte(today))
                .add(Column::DueDate.lt(tomorrow)),
            _ => none(),
        },
        "this-week" => match (bounds[1], bounds[2]) {
            (Some(tomorrow), Some(next_week)) => Condition::all()
                .add(Column::DueDate.gte(tomorrow))
                .add(Column::DueDate.lt(next_week)),
            _ => none(),
        },
        "later" => bounds[2].map_or_else(none, |next_week| {
            Condition::all().add(Column::DueDate.gte(next_week))
        }),
        "no-date" => Condition::all().add(Column::DueDate.is_null()),
        // `case` without a match is null: no row.
        _ => none(),
    }
}

/// The default order's status rank (todo, in progress, review, testing,
/// backlog, done, cancelled, the rest).
fn status_rank() -> Expr {
    use tasks::Column;
    let rank = [
        ("todo", 1),
        ("in_progress", 2),
        ("review", 3),
        ("in_review", 3),
        ("testing", 4),
        ("backlog", 5),
        ("done", 6),
        ("cancelled", 7),
    ];
    let mut case = CaseStatement::new();
    for (status, rank) in rank {
        case = case.case(Column::Status.eq(status), rank);
    }
    case.finally(8).into()
}

/// A task with the summary of its project (`leftJoin(projects)`).
#[derive(Debug, FromQueryResult)]
struct MyTask {
    #[sea_orm(nested)]
    task: tasks::Model,
    project_ref: Option<String>,
    project_name: Option<String>,
    project_color: Option<String>,
    project_icon: Option<String>,
    project_status: Option<String>,
}

impl MyTask {
    /// `{ id, name, color, icon, status }`, `null` without a project.
    fn project(&self) -> Value {
        match &self.project_ref {
            None => Value::Null,
            Some(id) => json!({
                "id": id,
                "name": self.project_name,
                "color": self.project_color,
                "icon": self.project_icon,
                "status": self.project_status,
            }),
        }
    }
}

struct Params {
    statuses: Option<Vec<String>>,
    excluded: Option<Vec<String>>,
    bounds: [Option<PrimitiveDateTime>; 3],
    search: Option<String>,
}

/// A JavaScript millisecond timestamp as the `timestamp` its
/// `toISOString()` was cast to.
fn stamp(millis: i64) -> Option<PrimitiveDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .map(utc_timestamp)
}

async fn my_tasks(state: &FlowState, caller: &Caller, f: &Filters) -> Reply {
    let db = &caller.db;
    let user = caller.user_id.clone();
    let mut bounds = [None, None, None];
    if f.due_bucket.is_some() {
        let b = workspace_day_bounds(db, crate::now_ms())
            .await
            .map_err(orm_error)?;
        bounds = [
            stamp(b.start_of_today),
            stamp(b.start_of_tomorrow),
            stamp(b.start_of_next_week),
        ];
    }
    let params = Params {
        statuses: f
            .status
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(task_status_aliases),
        excluded: f
            .exclude_status
            .as_ref()
            .map(|list| list.iter().flat_map(|s| task_status_aliases(s)).collect()),
        bounds,
        search: f
            .search
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(contains_pattern),
    };
    let result = async {
        let offset = (f.page - 1.0) * f.page_size;
        if offset.fract() != 0.0 || f.page_size.fract() != 0.0 {
            return Err(Refusal::Internal("a fractional LIMIT or OFFSET".to_owned()));
        }
        #[allow(clippy::cast_possible_truncation)]
        let (limit, offset) = (f.page_size as i64, offset as i64);
        let default_sort = f.sort_field == "position";
        let project = tasks::Entity::belongs_to(projects::Entity)
            .from(tasks::Column::ProjectId)
            .to(projects::Column::Id)
            .into();
        let mut rows = tasks::Entity::find()
            .column_as(projects::Column::Id, "project_ref")
            .column_as(projects::Column::Name, "project_name")
            .column_as(projects::Column::Color, "project_color")
            .column_as(projects::Column::Icon, "project_icon")
            .column_as(projects::Column::Status, "project_status")
            .join(JoinType::LeftJoin, project)
            .filter(my_task_filters(&user, f, &params));
        // `asc` / `desc` on the chosen column (nulls last / first, as
        // Postgres orders them); the default order ranks the statuses.
        if default_sort {
            rows = rows.order_by(status_rank(), Order::Asc);
        }
        let sorted = match f.sort_field.as_str() {
            "title" => Some(tasks::Column::Title),
            "status" => Some(tasks::Column::Status),
            "priority" => Some(tasks::Column::Priority),
            "dueDate" => Some(tasks::Column::DueDate),
            "assignee" => Some(tasks::Column::AssigneeId),
            "createdAt" => Some(tasks::Column::CreatedAt),
            _ => None,
        };
        if let Some(column) = sorted {
            let order = if f.sort_direction == "desc" {
                Order::Desc
            } else {
                Order::Asc
            };
            rows = rows.order_by(column, order);
        }
        let rows = rows
            .order_by_desc(tasks::Column::UpdatedAt)
            .order_by_desc(tasks::Column::Id)
            .limit(u64::try_from(limit).unwrap_or(0))
            .offset(u64::try_from(offset).unwrap_or(0))
            .into_model::<MyTask>()
            .all(&orm(db))
            .await?;
        let total = tasks::Entity::find()
            .filter(my_task_filters(&user, f, &params))
            .count(&orm(db))
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let has_more = offset + i64::try_from(rows.len()).unwrap_or(0) < total;
        let projects: Vec<Value> = rows.iter().map(MyTask::project).collect();
        let tasks = rows
            .into_iter()
            .map(|row| row_json(row.task))
            .collect::<Result<Vec<Value>, _>>()?;
        let enriched = enrich(state, db, caller.request_master(), tasks).await?;
        let mut data: Vec<Value> = enriched
            .into_iter()
            .zip(projects)
            .map(|(mut task, project)| {
                if let Value::Object(map) = &mut task {
                    map.insert("project".to_owned(), project);
                }
                task
            })
            .collect();
        if f.include_subtasks {
            attach_tree_across_projects(state, db, caller.request_master(), &mut data).await?;
        }
        Ok(crate::paged(data, total, has_more, None))
    }
    .await;
    Ok(reply(result, "Failed to list my tasks"))
}
