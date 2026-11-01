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
use serde_json::{Map, Value};
use weldsuite_db::js_row;
use weldsuite_flow_domain::day_bounds::workspace_day_bounds;
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_flow_domain::stage::task_status_aliases;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::task_enrich::{attach_tree_across_projects, enrich};
use crate::tasks::{SORT_FIELDS, csv_list, query_boolean, query_number, query_text};
use crate::{Caller, FlowState, Query, Refusal, Reply, outside, reply, validate_value};

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

macro_rules! my_task_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and not exists (select 1 from projects lp where lp.id = t.project_id and lp.deleted_at is not null)",
            " and (t.assignee_id = $1 or t.assignee_ids::jsonb @> $2::jsonb)",
            " and ($3::text[] is null or t.status = any($3))",
            " and ($4::text[] is null or not (t.status = any($4)))",
            " and ($5::text is null or t.priority = $5)",
            " and ($6::text is null or t.project_id = $6)",
            " and ($7::text[] is null or t.labels ?| $7::text[])",
            " and ($8::text is null or (case $8",
            " when 'overdue' then (t.due_date < $9::timestamp and t.due_date is not null)",
            " when 'today' then (t.due_date >= $9::timestamp and t.due_date < $10::timestamp)",
            " when 'this-week' then (t.due_date >= $10::timestamp and t.due_date < $11::timestamp)",
            " when 'later' then t.due_date >= $11::timestamp",
            " when 'no-date' then t.due_date is null end))",
            " and ($12::text is null or (t.title ilike $12 or t.description ilike $12 or t.key ilike $12))"
        )
    };
}

/// `ORDER BY <column> <direction>` for one sort field.
macro_rules! my_order_on {
    ($name:literal, $col:literal) => {
        concat!(
            "(case when $13 = '",
            $name,
            "' and $14 = 'asc' then t.",
            $col,
            " end) asc, (case when $13 = '",
            $name,
            "' and $14 = 'desc' then t.",
            $col,
            " end) desc, "
        )
    };
}

macro_rules! bind_my_filters {
    ($query:expr, $user:expr, $f:expr, $p:expr) => {
        $query
            .bind(&$user)
            .bind(serde_json::to_string(&[&$user]).unwrap_or_default())
            .bind(&$p.statuses)
            .bind(&$p.excluded)
            .bind($f.priority.as_deref().filter(|v| !v.is_empty()))
            .bind($f.project_id.as_deref().filter(|v| !v.is_empty()))
            .bind(&$f.label_ids)
            .bind($f.due_bucket.as_deref())
            .bind($p.bounds[0].as_deref())
            .bind($p.bounds[1].as_deref())
            .bind($p.bounds[2].as_deref())
            .bind($p.search.as_deref())
    };
}

struct Params {
    statuses: Option<Vec<String>>,
    excluded: Option<Vec<String>>,
    bounds: [Option<String>; 3],
    search: Option<String>,
}

async fn my_tasks(state: &FlowState, caller: &Caller, f: &Filters) -> Reply {
    let db = &caller.db;
    let user = caller.user_id.clone();
    let mut bounds = [None, None, None];
    if f.due_bucket.is_some() {
        let b = workspace_day_bounds(db, crate::now_ms()).await?;
        let iso = weldsuite_flow_domain::js::iso_from_millis;
        bounds = [
            iso(b.start_of_today),
            iso(b.start_of_tomorrow),
            iso(b.start_of_next_week),
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
        let rows: Vec<(Value, Option<Value>)> = bind_my_filters!(
            sqlx::query_as(concat!(
                "select ",
                task_json!("t"),
                ", case when p.id is null then null else jsonb_build_object('id', p.id, 'name', p.name,",
                " 'color', p.color, 'icon', p.icon, 'status', p.status) end",
                " from tasks t left join projects p on t.project_id = p.id where ",
                my_task_filters!(),
                " order by (case when $15 then (case t.status when 'todo' then 1",
                " when 'in_progress' then 2 when 'review' then 3 when 'in_review' then 3",
                " when 'testing' then 4 when 'backlog' then 5 when 'done' then 6",
                " when 'cancelled' then 7 else 8 end) end) asc, ",
                my_order_on!("title", "title"),
                my_order_on!("status", "status"),
                my_order_on!("priority", "priority"),
                my_order_on!("dueDate", "due_date"),
                my_order_on!("assignee", "assignee_id"),
                my_order_on!("createdAt", "created_at"),
                "t.updated_at desc, t.id desc limit $16 offset $17"
            )),
            user,
            f,
            params
        )
        .bind(&f.sort_field)
        .bind(&f.sort_direction)
        .bind(default_sort)
        .bind(limit)
        .bind(offset)
        .fetch_all(db)
        .await?;
        let total: i64 = bind_my_filters!(
            sqlx::query_scalar(concat!(
                "select count(*) from tasks t where ",
                my_task_filters!()
            )),
            user,
            f,
            params
        )
        .fetch_one(db)
        .await?;
        let has_more = offset + i64::try_from(rows.len()).unwrap_or(0) < total;
        let projects: Vec<Value> = rows
            .iter()
            .map(|(_, project)| project.clone().unwrap_or(Value::Null))
            .collect();
        let tasks: Vec<Value> = rows.into_iter().map(|(task, _)| js_row(task)).collect();
        let enriched = enrich(state, db, tasks).await?;
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
            attach_tree_across_projects(state, db, &mut data).await?;
        }
        Ok(crate::paged(data, total, has_more, None))
    }
    .await;
    Ok(reply(result, "Failed to list my tasks"))
}
