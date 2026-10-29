//! `/api/tasks` (`routes/tasks/index.ts`): the task list with its filters,
//! one task, its subtasks and attachments, reorder, move and delete. The
//! writes that change a task's fields live in [`crate::task_writes`].
//!
//! `tasks:*` gates the feature; a task in a project needs membership of
//! that project to be read and write access to be changed. Tasks without
//! a project (personal and CRM tasks) are not owner-scoped, as in
//! TypeScript (a known, deferred gap).

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
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PROJECT_TASK_DELETED, PROJECT_TASK_UPDATED};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::day_bounds::{DayBounds, workspace_day_bounds};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_flow_domain::stage::task_status_aliases;
use weldsuite_flow_domain::task_tree::{MAX_SUBTASK_DEPTH, soft_delete_task_tree};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::task_enrich::{
    attach_attachment_counts, attach_subtask_counts, attach_subtask_tree, enrich, hydrate,
    load_descendants, subtask_counts,
};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, now, outside, reply, task_writes, validate,
    validate_value,
};

pub(crate) const TASK_PROJECT_DENIED: &str = "You are not a member of this task's project";
pub(crate) const PROJECT_MEMBER_DENIED: &str = "You are not a member of this project";
pub(crate) const TASK_PROJECT_WRITE_DENIED: &str =
    "You do not have write access to this task's project";
pub(crate) const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("tasks:read")))
        .route(
            "/",
            post(task_writes::create).route_layer(need("tasks:create")),
        )
        .route("/reorder", patch(reorder).route_layer(need("tasks:update")))
        .route(
            "/projects/{project_id}",
            post(task_writes::create_in_project).route_layer(need("tasks:create")),
        )
        .route("/{id}", get(detail).route_layer(need("tasks:read")))
        .route(
            "/{id}",
            patch(task_writes::update).route_layer(need("tasks:update")),
        )
        .route("/{id}", delete(remove).route_layer(need("tasks:delete")))
        .route(
            "/{id}/attachments",
            post(add_attachment).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/attachments/{file_id}",
            delete(remove_attachment).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/subtasks",
            get(subtasks).route_layer(need("tasks:read")),
        )
        .route(
            "/{id}/toggle",
            patch(task_writes::toggle).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/status",
            patch(task_writes::status).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/position",
            patch(task_writes::position).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/dependencies",
            put(task_writes::dependencies).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}/move",
            post(move_task).route_layer(need("tasks:update")),
        )
        .with_state(state)
}

/// A live task row (`select().from(tasks).where(id, not deleted)`).
pub(crate) async fn task_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        task_json!("t"),
        " from tasks t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// What `canAccessTaskProject` / `canWriteTaskProject` answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskAccess {
    Ok,
    Denied,
    NotFound,
}

/// The task's project access: `write` for mutations.
pub(crate) async fn task_access(
    caller: &Caller,
    id: &str,
    write: bool,
) -> Result<TaskAccess, sqlx::Error> {
    let task: Option<(Option<String>, bool)> = sqlx::query_as(
        "select project_id, deleted_at is not null from tasks where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((project_id, false)) = task else {
        return Ok(TaskAccess::NotFound);
    };
    let Some(project_id) = project_id.filter(|p| !p.is_empty()) else {
        return Ok(TaskAccess::Ok);
    };
    let allowed = if write {
        caller.can_write(&project_id).await?
    } else {
        caller.can_access(&project_id).await?
    };
    Ok(if allowed {
        TaskAccess::Ok
    } else {
        TaskAccess::Denied
    })
}

/// `guardTaskWrite`: the 404 / 403 a by-id mutation answers, if any.
pub(crate) async fn guard_write(caller: &Caller, id: &str) -> Result<(), Refusal> {
    match task_access(caller, id, true).await? {
        TaskAccess::Ok => Ok(()),
        TaskAccess::NotFound => Err(Refusal::not_found("Task", id)),
        TaskAccess::Denied => Err(Refusal::forbidden(TASK_PROJECT_WRITE_DENIED)),
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

const BUCKETS: [&str; 5] = ["overdue", "today", "this-week", "later", "no-date"];
pub(crate) const SORT_FIELDS: [&str; 7] = [
    "title",
    "status",
    "priority",
    "dueDate",
    "assignee",
    "position",
    "createdAt",
];
const QUERY_BOOLEAN: [&str; 4] = ["true", "false", "1", "0"];

/// `queryBoolean`: `true`/`1` or `false`/`0`.
pub(crate) fn query_boolean(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
) -> Option<bool> {
    issues
        .choice(fields, key, Presence::Optional, &QUERY_BOOLEAN)
        .into_option()
        .map(|value| value == "true" || value == "1")
}

/// `taskCsvStringArray`: a CSV string or repeated values, trimmed, empty
/// ones dropped; `None` when nothing is left.
pub(crate) fn csv_list(fields: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    let items: Vec<String> = match fields.get(key)? {
        Value::String(text) => text.split(',').map(str::to_owned).collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => return None,
    };
    let cleaned: Vec<String> = items
        .iter()
        .map(|item| weldsuite_kit::validation::js_trim(item).to_owned())
        .filter(|item| !item.is_empty())
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// An optional string query value.
pub(crate) fn query_text(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
) -> Option<String> {
    issues
        .text_with(fields, key, Presence::Optional, Text::default())
        .into_option()
}

/// `z.coerce.number().min(1)[.max(max)].default(fallback)`.
pub(crate) fn query_number(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    max: Option<f64>,
    fallback: f64,
) -> f64 {
    issues
        .number(
            fields,
            key,
            Presence::Optional,
            Number {
                coerce: true,
                int: false,
                min: Some(1.0),
                max,
            },
        )
        .into_option()
        .unwrap_or(fallback)
}

/// `listQuerySchema`.
#[derive(Debug, Default)]
struct ListQuery {
    limit: f64,
    cursor: Option<String>,
    page: f64,
    page_size: f64,
    project_id: Option<String>,
    sprint_id: Option<String>,
    milestone_id: Option<String>,
    customer_id: Option<String>,
    contact_id: Option<String>,
    person_id: Option<String>,
    crm_linked: bool,
    parent_task_id: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    kind: Option<String>,
    assignee_id: Option<String>,
    my_tasks: bool,
    search: Option<String>,
    label_ids: Option<Vec<String>>,
    due_bucket: Option<String>,
    exclude_status: Option<Vec<String>>,
    exclude_priority: Option<Vec<String>>,
    exclude_assignee_id: Option<String>,
    exclude_label_ids: Option<Vec<String>>,
    exclude_due_bucket: Option<String>,
    due_from: Option<String>,
    due_to: Option<String>,
    sort_field: String,
    sort_direction: String,
    include_subtasks: bool,
    enrich: bool,
}

fn read_list_query(issues: &mut Issues, f: &Map<String, Value>) -> ListQuery {
    let limit = query_number(issues, f, "limit", Some(200.0), 50.0);
    let cursor = query_text(issues, f, "cursor");
    let page = query_number(issues, f, "page", None, 1.0);
    let page_size = query_number(issues, f, "pageSize", Some(200.0), 50.0);
    let project_id = query_text(issues, f, "projectId");
    let sprint_id = query_text(issues, f, "sprintId");
    let milestone_id = query_text(issues, f, "milestoneId");
    let customer_id = query_text(issues, f, "customerId");
    let contact_id = query_text(issues, f, "contactId");
    let person_id = query_text(issues, f, "personId");
    let crm_linked = query_boolean(issues, f, "crmLinked").unwrap_or(false);
    let parent_task_id = query_text(issues, f, "parentTaskId");
    let status = query_text(issues, f, "status");
    let priority = query_text(issues, f, "priority");
    let kind = query_text(issues, f, "type");
    let assignee_id = query_text(issues, f, "assigneeId");
    let my_tasks = query_boolean(issues, f, "myTasks").unwrap_or(false);
    let search = query_text(issues, f, "search");
    let label_ids = csv_list(f, "labelIds");
    let _tags = csv_list(f, "tags");
    let due_bucket = issues
        .choice(f, "dueDateBucket", Presence::Optional, &BUCKETS)
        .into_option();
    let exclude_status = csv_list(f, "excludeStatus");
    let exclude_priority = csv_list(f, "excludePriority");
    let exclude_assignee_id = query_text(issues, f, "excludeAssigneeId");
    let exclude_label_ids = csv_list(f, "excludeLabelIds");
    let exclude_due_bucket = issues
        .choice(f, "excludeDueDateBucket", Presence::Optional, &BUCKETS)
        .into_option();
    let due_from = query_text(issues, f, "dueDateFrom");
    let due_to = query_text(issues, f, "dueDateTo");
    let sort_field = issues
        .choice(f, "sortField", Presence::Optional, &SORT_FIELDS)
        .into_option()
        .unwrap_or_else(|| "position".to_owned());
    let sort_direction = issues
        .choice(f, "sortDirection", Presence::Optional, &["asc", "desc"])
        .into_option()
        .unwrap_or_else(|| "asc".to_owned());
    let include_subtasks = query_boolean(issues, f, "includeSubtasks").unwrap_or(false);
    let enrich = query_boolean(issues, f, "enrich").unwrap_or(true);
    ListQuery {
        limit,
        cursor,
        page,
        page_size,
        project_id,
        sprint_id,
        milestone_id,
        customer_id,
        contact_id,
        person_id,
        crm_linked,
        parent_task_id,
        status,
        priority,
        kind,
        assignee_id,
        my_tasks,
        search,
        label_ids,
        due_bucket,
        exclude_status,
        exclude_priority,
        exclude_assignee_id,
        exclude_label_ids,
        exclude_due_bucket,
        due_from,
        due_to,
        sort_field,
        sort_direction,
        include_subtasks,
        enrich,
    }
}

/// The list's `where` over `t`, every filter behind its parameter
/// (`taskScopeFilters`, `taskValueFilters`, `taskSearchFilters`,
/// `taskDueDateFilters`).
macro_rules! task_list_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and not exists (select 1 from projects lp where lp.id = t.project_id and lp.deleted_at is not null)",
            " and ($1::text is null or t.project_id = $1)",
            " and ($2::bool is not true or t.project_id is null or t.project_id = any($3::text[]))",
            " and ($4::text is null or t.sprint_id = $4)",
            " and ($5::text is null or t.milestone_id = $5)",
            " and ($6::text is null or t.customer_id = $6)",
            " and ($7::text is null or t.contact_id = $7)",
            " and ($8::text is null or t.person_id = $8)",
            " and ($9::bool is not true or (t.customer_id is not null or t.contact_id is not null",
            " or t.counterparty_id is not null or t.person_id is not null))",
            " and ($10::text is null or t.parent_task_id = $10)",
            " and ($11::bool is not true or t.parent_task_id is null)",
            " and ($12::text[] is null or t.status = any($12))",
            " and ($13::text is null or t.priority = $13)",
            " and ($14::text is null or t.type = $14)",
            " and ($15::text[] is null or not (t.status = any($15)))",
            " and ($16::text[] is null or not (t.priority = any($16)))",
            " and ($17::text is null or not (coalesce(t.assignee_id = $17, false)",
            " or coalesce(t.assignee_ids::jsonb @> $18::jsonb, false)))",
            " and ($19::text is null or (t.assignee_id = $19 or t.assignee_ids::jsonb @> $20::jsonb))",
            " and ($21::text is null or (t.title ilike $21 or t.description ilike $21 or t.key ilike $21",
            " or ($22::bigint is not null and t.number = $22)))",
            " and ($23::text[] is null or not coalesce(t.labels ?| $23::text[], false))",
            " and ($24::text[] is null or t.labels ?| $24::text[])",
            " and ($25::text is null or ",
            due_bucket!("$25"),
            ")",
            " and ($26::text is null or coalesce(not (",
            due_bucket!("$26"),
            "), true))",
            " and ($30::text is null or t.due_date >= $30::timestamp)",
            " and ($31::text is null or t.due_date < $31::timestamp)"
        )
    };
}

/// `dueDateBucketCondition(bucket, tasks.dueDate, bounds)` over the bounds
/// in `$27` (start of today), `$28` (tomorrow) and `$29` (next week).
macro_rules! due_bucket {
    ($b:literal) => {
        concat!(
            "(case ",
            $b,
            " when 'overdue' then (t.due_date < $27::timestamp and t.due_date is not null)",
            " when 'today' then (t.due_date >= $27::timestamp and t.due_date < $28::timestamp)",
            " when 'this-week' then (t.due_date >= $28::timestamp and t.due_date < $29::timestamp)",
            " when 'later' then t.due_date >= $29::timestamp",
            " when 'no-date' then t.due_date is null end)"
        )
    };
}

/// `taskCursorCondition(column, direction, cursor)` for one sort column,
/// against the cursor row `cur` (timestamps as JavaScript read them back,
/// to the millisecond).
macro_rules! cursor_on {
    ($col:literal) => {
        concat!(
            "(case when $34 = 'asc' then (case when cur.",
            $col,
            " is null then (t.",
            $col,
            " is null and t.id < cur.id) else ((t.",
            $col,
            " > cur.",
            $col,
            " or t.",
            $col,
            " is null) or (t.",
            $col,
            " = cur.",
            $col,
            " and t.id < cur.id)) end) else (case when cur.",
            $col,
            " is null then (t.",
            $col,
            " is not null or (t.",
            $col,
            " is null and t.id < cur.id)) else (t.",
            $col,
            " < cur.",
            $col,
            " or (t.",
            $col,
            " = cur.",
            $col,
            " and t.id < cur.id)) end) end)"
        )
    };
}

/// `ORDER BY <sort column> <direction>` for one column.
macro_rules! order_on {
    ($name:literal, $col:literal) => {
        concat!(
            "(case when $33 = '",
            $name,
            "' and $34 = 'asc' then t.",
            $col,
            " end) asc, (case when $33 = '",
            $name,
            "' and $34 = 'desc' then t.",
            $col,
            " end) desc, "
        )
    };
}

struct ListParams {
    project_id: Option<String>,
    scoped: bool,
    ids: Vec<String>,
    parent: Option<String>,
    top_level: bool,
    statuses: Option<Vec<String>>,
    exclude_statuses: Option<Vec<String>>,
    exclude_assignee: Option<(String, String)>,
    assignee: Option<(String, String)>,
    search: Option<(String, Option<i64>)>,
    bounds: Option<DayBounds>,
    due_from: Option<String>,
    due_to: Option<String>,
}

/// Binds `$1`–`$31` (the filters) on a query.
macro_rules! bind_filters {
    ($query:expr, $q:expr, $p:expr) => {{
        let bound = |ms: Option<i64>| ms.and_then(weldsuite_flow_domain::js::iso_from_millis);
        $query
            .bind($p.project_id.as_deref())
            .bind($p.scoped)
            .bind(&$p.ids)
            .bind(present(&$q.sprint_id))
            .bind(present(&$q.milestone_id))
            .bind(present(&$q.customer_id))
            .bind(present(&$q.contact_id))
            .bind(present(&$q.person_id))
            .bind($q.crm_linked)
            .bind($p.parent.as_deref())
            .bind($p.top_level)
            .bind($p.statuses.as_ref())
            .bind(present(&$q.priority))
            .bind(present(&$q.kind))
            .bind($p.exclude_statuses.as_ref())
            .bind($q.exclude_priority.as_ref())
            .bind($p.exclude_assignee.as_ref().map(|(id, _)| id.as_str()))
            .bind($p.exclude_assignee.as_ref().map(|(_, json)| json.as_str()))
            .bind($p.assignee.as_ref().map(|(id, _)| id.as_str()))
            .bind($p.assignee.as_ref().map(|(_, json)| json.as_str()))
            .bind($p.search.as_ref().map(|(term, _)| term.as_str()))
            .bind($p.search.as_ref().and_then(|(_, number)| *number))
            .bind($q.exclude_label_ids.as_ref())
            .bind($q.label_ids.as_ref())
            .bind($q.due_bucket.as_deref())
            .bind($q.exclude_due_bucket.as_deref())
            .bind(bound($p.bounds.map(|b| b.start_of_today)))
            .bind(bound($p.bounds.map(|b| b.start_of_tomorrow)))
            .bind(bound($p.bounds.map(|b| b.start_of_next_week)))
            .bind($p.due_from.as_deref())
            .bind($p.due_to.as_deref())
    }};
}

/// A truthy query value (`if (q.x)`).
fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|v| !v.is_empty())
}

/// `JSON.stringify([id])`.
fn json_list(id: &str) -> String {
    serde_json::to_string(&[id]).unwrap_or_default()
}

/// The number a search term names (`TASK-1042`, `#1042`, `1042`).
fn search_number(search: &str) -> Option<i64> {
    let trimmed = weldsuite_kit::validation::js_trim(search);
    let trimmed = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let trimmed = if trimmed.len() >= 5 && trimmed[..5].eq_ignore_ascii_case("task-") {
        &trimmed[5..]
    } else {
        trimmed
    };
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.parse::<i64>().unwrap_or(i64::MAX))
}

async fn list(State(state): State<FlowState>, caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let query = match validate_value(&Value::Object(q.values().clone()), read_list_query) {
        Ok(query) => query,
        Err(refused) => return refused.respond("Invalid query"),
    };
    outside(list_tasks(&state, &caller, &query).await)
}

async fn list_tasks(state: &FlowState, caller: &Caller, q: &ListQuery) -> Reply {
    let db = &caller.db;
    let project_id = present(&q.project_id).map(str::to_owned);
    let (scoped, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MEMBER_DENIED));
        }
        (false, Vec::new())
    } else {
        match caller.accessible_project_ids().await? {
            None => (false, Vec::new()),
            Some(ids) if ids.is_empty() => (true, vec![String::new()]),
            Some(ids) => (true, ids),
        }
    };
    let bounds = if q.due_bucket.is_some() || q.exclude_due_bucket.is_some() {
        Some(workspace_day_bounds(db, crate::now_ms()).await?)
    } else {
        None
    };
    let user = caller.user().map(str::to_owned);
    let effective_assignee = if q.my_tasks {
        user
    } else {
        q.assignee_id.clone()
    }
    .filter(|id| !id.is_empty());
    let parent = q.parent_task_id.clone().filter(|p| !p.is_empty());
    let params = ListParams {
        top_level: parent.is_none() && project_id.is_some(),
        project_id,
        scoped,
        ids,
        parent,
        statuses: present(&q.status).map(task_status_aliases),
        exclude_statuses: q
            .exclude_status
            .as_ref()
            .map(|list| list.iter().flat_map(|s| task_status_aliases(s)).collect()),
        exclude_assignee: present(&q.exclude_assignee_id).map(|id| (id.to_owned(), json_list(id))),
        assignee: effective_assignee.map(|id| {
            let json = json_list(&id);
            (id, json)
        }),
        search: present(&q.search).map(|s| (contains_pattern(s), search_number(s))),
        bounds,
        due_from: None,
        due_to: None,
    };
    let result = async {
        let mut params = params;
        let date = |raw: &Option<String>| -> Result<Option<String>, Refusal> {
            match present(raw) {
                None => Ok(None),
                Some(raw) => weldsuite_flow_domain::js::js_date(raw)
                    .map(Some)
                    .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned())),
            }
        };
        params.due_from = date(&q.due_from)?;
        params.due_to = date(&q.due_to)?;
        let cursor_id = match q.cursor.as_deref().filter(|c| !c.is_empty()) {
            Some(cursor) => {
                let found: Option<String> =
                    sqlx::query_scalar("select id from tasks where id = $1 limit 1")
                        .bind(cursor)
                        .fetch_optional(db)
                        .await?;
                found
            }
            None => None,
        };
        let use_cursor = q.cursor.is_some() || params.project_id.is_none();
        let fetch = if use_cursor {
            q.limit + 1.0
        } else {
            q.page_size
        };
        let offset = if use_cursor {
            0.0
        } else {
            (q.page - 1.0) * q.page_size
        };
        if fetch.fract() != 0.0 || offset.fract() != 0.0 {
            return Err(Refusal::Internal("a fractional LIMIT or OFFSET".to_owned()));
        }
        #[allow(clippy::cast_possible_truncation)]
        let (fetch, offset) = (fetch as i64, offset as i64);
        let rows: Vec<Value> = bind_filters!(
            sqlx::query_scalar(concat!(
                "with cur as (select id, title, status, priority, assignee_id,",
                " date_trunc('milliseconds', due_date) as due_date,",
                " date_trunc('milliseconds', created_at) as created_at, position",
                " from tasks where id = $32)",
                " select ",
                task_json!("t"),
                " from tasks t where ",
                task_list_filters!(),
                " and ($32::text is null or exists (select 1 from cur where (case $33",
                " when 'title' then ",
                cursor_on!("title"),
                " when 'status' then ",
                cursor_on!("status"),
                " when 'priority' then ",
                cursor_on!("priority"),
                " when 'dueDate' then ",
                cursor_on!("due_date"),
                " when 'assignee' then ",
                cursor_on!("assignee_id"),
                " when 'createdAt' then ",
                cursor_on!("created_at"),
                " else ",
                cursor_on!("position"),
                " end)))",
                " order by ",
                order_on!("title", "title"),
                order_on!("status", "status"),
                order_on!("priority", "priority"),
                order_on!("dueDate", "due_date"),
                order_on!("assignee", "assignee_id"),
                order_on!("createdAt", "created_at"),
                order_on!("position", "position"),
                "(case when $35 then t.id end) desc,",
                " (case when not $35 then t.created_at end) asc,",
                " (case when not $35 then t.id end) asc",
                " limit $36 offset $37"
            )),
            q,
            params
        )
        .bind(cursor_id.as_deref())
        .bind(&q.sort_field)
        .bind(&q.sort_direction)
        .bind(use_cursor)
        .bind(fetch)
        .bind(offset)
        .fetch_all(db)
        .await?;
        let total: i64 = bind_filters!(
            sqlx::query_scalar(concat!(
                "select count(*) from tasks t where ",
                task_list_filters!()
            )),
            q,
            params
        )
        .fetch_one(db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
        #[allow(clippy::cast_possible_truncation)]
        let limit = q.limit as usize;
        let (data, has_more, next) = if use_cursor {
            let has_more = rows.len() > limit;
            let data: Vec<Value> = rows.into_iter().take(limit).collect();
            let next = if has_more { last_id(&data) } else { None };
            (data, has_more, next)
        } else {
            let has_more = offset + i64::try_from(rows.len()).unwrap_or(0) < total;
            let next = if has_more { last_id(&rows) } else { None };
            (rows, has_more, next)
        };
        let data = if q.enrich {
            enrich(state, db, data).await?
        } else {
            data
        };
        let mut data = hydrate(db, data).await?;
        if !data.is_empty() {
            if q.include_subtasks
                && let Some(project_id) = &params.project_id
            {
                let mut descendants = load_descendants(state, db, Some(project_id), &data).await?;
                attach_attachment_counts(db, &mut descendants).await?;
                attach_attachment_counts(db, &mut data).await?;
                attach_subtask_tree(&mut data, &descendants);
            } else {
                attach_subtask_counts(db, &mut data).await?;
                attach_attachment_counts(db, &mut data).await?;
            }
        }
        Ok(crate::paged(data, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list tasks"))
}

fn last_id(rows: &[Value]) -> Option<String> {
    rows.last()
        .and_then(|row| row.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(row) = task_row(db, &id).await? else {
            return Err(Refusal::not_found("Task", &id));
        };
        if let Some(project_id) = row
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
            && !caller.can_access(project_id).await?
        {
            return Err(Refusal::forbidden(TASK_PROJECT_DENIED));
        }
        let enriched = enrich(&state, db, vec![row]).await?;
        let mut task = hydrate(db, enriched).await?.pop().unwrap_or(Value::Null);
        let counts = subtask_counts(db, std::slice::from_ref(&id)).await?;
        let (total, done) = counts.get(&id).copied().unwrap_or((0, 0));
        let attachments: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', id, 'fileName', file_name,
                 'fileKey', coalesce(file_key, storage_path), 'fileSize', file_size,
                 'mimeType', mime_type, 'url', coalesce(url, ''))
             from files where entity_type = 'task' and entity_id = $1 and deleted_at is null
             order by created_at asc",
        )
        .bind(&id)
        .fetch_all(db)
        .await?;
        if let Value::Object(map) = &mut task {
            map.insert("subtaskCount".to_owned(), json!(total));
            map.insert("completedSubtaskCount".to_owned(), json!(done));
            map.insert("attachments".to_owned(), Value::Array(attachments));
        }
        Ok(Data(task).into_response())
    }
    .await;
    reply(result, "Failed to fetch task")
}

// ── GET /:id/subtasks ───────────────────────────────────────────────────────

async fn subtasks(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let access = match task_access(&caller, &id, false).await {
        Ok(access) => access,
        Err(error) => return outside(Err(error.into())),
    };
    match access {
        TaskAccess::NotFound => return ApiError::not_found("Task", Some(&id)).into_response(),
        TaskAccess::Denied => return crate::forbidden(TASK_PROJECT_DENIED),
        TaskAccess::Ok => {}
    }
    let result = async {
        let db = &caller.db;
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            task_json!("t"),
            " from tasks t where t.parent_task_id = $1 and t.deleted_at is null order by t.position"
        ))
        .bind(&id)
        .fetch_all(db)
        .await?;
        let rows = enrich(&state, db, rows.into_iter().map(js_row).collect()).await?;
        let mut rows = hydrate(db, rows).await?;
        if !rows.is_empty() {
            attach_subtask_counts(db, &mut rows).await?;
            attach_attachment_counts(db, &mut rows).await?;
        }
        Ok(Data(Value::Array(rows)).into_response())
    }
    .await;
    reply(result, "Failed to fetch subtasks")
}

// ── POST /:id/attachments ───────────────────────────────────────────────────

/// `isWorkspaceObjectKey(key, org)`: a safe key under `workspaces/<org>/`.
fn is_workspace_object_key(key: &str, org: Option<&str>) -> bool {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(owner), Some(_)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let valid_owner = !owner.is_empty()
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    weldsuite_ports::is_safe_key(key) && valid_owner && org.is_some_and(|org| org == owner)
}

struct NewAttachment {
    file_name: String,
    file_key: String,
    file_size: i64,
    mime_type: String,
    url: Option<String>,
}

async fn add_attachment(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let file = match validate(&headers, &body, |issues, f| {
        let file_name = issues.text(f, "fileName", Presence::Required, Some(1), Some(500));
        let file_key = issues.text(f, "fileKey", Presence::Required, Some(1), None);
        let file_size = issues.integer(f, "fileSize", Presence::Required, Some(0));
        let mime_type = issues.text(f, "mimeType", Presence::Required, Some(1), None);
        let url = issues.text(f, "url", Presence::Optional, None, None);
        NewAttachment {
            file_name: file_name.into_option().unwrap_or_default(),
            file_key: file_key.into_option().unwrap_or_default(),
            file_size: file_size.into_option().unwrap_or_default(),
            mime_type: mime_type.into_option().unwrap_or_default(),
            url: url.into_option(),
        }
    }) {
        Ok(file) => file,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let Some(user) = caller.user().map(str::to_owned) else {
        return ApiError::unauthorized().into_response();
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    if !is_workspace_object_key(&file.file_key, caller.clerk_org_id.as_deref()) {
        return ApiError::bad_request("fileKey is not a file of this workspace").into_response();
    }
    let result = async {
        let created = weldsuite_core_domain::files::create_file(
            &caller.db,
            &weldsuite_core_domain::files::NewFile {
                file_name: file.file_name,
                original_name: None,
                mime_type: file.mime_type,
                file_size: file.file_size,
                file_type: Some("file".to_owned()),
                storage_path: file.file_key.clone(),
                file_key: Some(file.file_key),
                bucket: None,
                url: file.url,
                thumbnail_url: None,
                folder_id: None,
                is_public: None,
                entity_type: Some("task".to_owned()),
                entity_id: Some(id.clone()),
                metadata: None,
                uploaded_by_id: user,
            },
            &now(),
        )
        .await?;
        let pick = |key: &str| created.get(key).cloned().unwrap_or(Value::Null);
        let file_key = match pick("fileKey") {
            Value::Null => pick("storagePath"),
            key => key,
        };
        let url = match pick("url") {
            Value::Null => json!(""),
            url => url,
        };
        Ok(Created(json!({
            "id": pick("id"),
            "fileName": pick("fileName"),
            "fileKey": file_key,
            "fileSize": pick("fileSize"),
            "mimeType": pick("mimeType"),
            "url": url,
        }))
        .into_response())
    }
    .await;
    reply(result, "Failed to add attachment")
}

// ── DELETE /:id/attachments/:fileId ─────────────────────────────────────────

async fn remove_attachment(
    State(state): State<FlowState>,
    caller: Caller,
    Path((id, file_id)): Path<(String, String)>,
) -> Response {
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let db = &caller.db;
        let existing: Option<String> = sqlx::query_scalar(
            "select id from files
             where id = $1 and entity_type = 'task' and entity_id = $2 and deleted_at is null
             limit 1",
        )
        .bind(&file_id)
        .bind(&id)
        .fetch_optional(db)
        .await?;
        if existing.is_none() {
            return Err(Refusal::not_found("Attachment", &file_id));
        }
        let at = time::OffsetDateTime::now_utc();
        let deleted_at = weldsuite_events::iso_timestamp(at);
        sqlx::query(
            "update files set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&file_id)
        .bind(&deleted_at)
        .execute(db)
        .await?;
        crate::project_files::mark_purge_due(&state, &caller, at).await;
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to remove attachment")
}

// ── PATCH /reorder ──────────────────────────────────────────────────────────

/// `reorderedPositions(rows, orderedIds)`: the rows' positions, sorted and
/// spread so each is above the last, handed out in the requested order.
pub(crate) fn reordered_positions(
    rows: &[(String, i64)],
    ordered: &[String],
) -> Vec<(String, i64)> {
    let mut slots: Vec<i64> = rows.iter().map(|(_, position)| *position).collect();
    slots.sort_unstable();
    for i in 1..slots.len() {
        if slots[i] <= slots[i - 1] {
            slots[i] = slots[i - 1] + 1;
        }
    }
    let mut out: Vec<(String, i64)> = Vec::new();
    for id in ordered {
        if !rows.iter().any(|(row, _)| row == id) || out.iter().any(|(done, _)| done == id) {
            continue;
        }
        out.push((id.clone(), slots[out.len()]));
    }
    out
}

/// `reorderedPositionsByProject`: each project's tasks (no project is a
/// group too) reuse that group's slots, groups in first-seen order.
pub(crate) fn reordered_by_project(
    rows: &[(String, Option<String>, i64)],
    ordered: &[String],
) -> Vec<(String, i64)> {
    let mut groups: Vec<(Option<String>, Vec<(String, i64)>)> = Vec::new();
    for (id, project, position) in rows {
        match groups.iter_mut().find(|(key, _)| key == project) {
            Some((_, group)) => group.push((id.clone(), *position)),
            None => groups.push((project.clone(), vec![(id.clone(), *position)])),
        }
    }
    let mut out: Vec<(String, i64)> = Vec::new();
    for (_, group) in &groups {
        for (id, position) in reordered_positions(group, ordered) {
            match out.iter_mut().find(|(done, _)| *done == id) {
                Some(entry) => entry.1 = position,
                None => out.push((id, position)),
            }
        }
    }
    out
}

async fn reorder(
    caller: Caller,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let task_ids = match validate(&headers, &body, |issues, f| {
        issues
            .list(
                f,
                "taskIds",
                Presence::Required,
                Some(1),
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let q = Query::parse(raw.as_deref());
    let project_id = q.present("projectId").map(str::to_owned);
    if let Some(project_id) = &project_id {
        match caller.can_write(project_id).await {
            Ok(true) => {}
            Ok(false) => return crate::forbidden(PROJECT_WRITE_DENIED),
            Err(error) => return outside(Err(error.into())),
        }
    }
    let result = async {
        let db = &caller.db;
        let rows: Vec<(String, Option<String>, i32)> = sqlx::query_as(
            "select id, project_id, position from tasks
             where id = any($1) and deleted_at is null and ($2::text is null or project_id = $2)",
        )
        .bind(&task_ids)
        .bind(project_id.as_deref())
        .fetch_all(db)
        .await?;
        let mut projects: Vec<String> = Vec::new();
        for (_, project, _) in &rows {
            if let Some(project) = project.as_ref().filter(|p| !p.is_empty())
                && !projects.contains(project)
            {
                projects.push(project.clone());
            }
        }
        for project in &projects {
            if !caller.can_write(project).await? {
                return Err(Refusal::forbidden(TASK_PROJECT_WRITE_DENIED));
            }
        }
        let rows: Vec<(String, Option<String>, i64)> = rows
            .into_iter()
            .map(|(id, project, position)| (id, project, i64::from(position)))
            .collect();
        let positions = reordered_by_project(&rows, &task_ids);
        if !positions.is_empty() {
            let at = now();
            let mut tx = db.begin().await?;
            for (task_id, position) in &positions {
                sqlx::query(
                    "update tasks set position = $2, updated_at = $3::timestamp where id = $1",
                )
                .bind(task_id)
                .bind(i32::try_from(*position).unwrap_or(i32::MAX))
                .bind(&at)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
        }
        Ok(Data(json!({ "success": true })).into_response())
    }
    .await;
    reply(result, "Failed to reorder tasks")
}

// ── POST /:id/move ──────────────────────────────────────────────────────────

async fn move_task(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let dest = match validate(&headers, &body, |issues, f| {
        issues
            .text(f, "projectId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(dest) => dest,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    match caller.can_write(&dest).await {
        Ok(true) => {}
        Ok(false) => {
            return crate::forbidden("You do not have write access to the destination project");
        }
        Err(error) => return outside(Err(error.into())),
    }
    if !caller
        .flag_on(weldsuite_catalogs::flags::WELDFLOW_MOVE_TASK)
        .await
    {
        return crate::forbidden("Moving tasks between projects is not available.");
    }
    reply(
        move_into(&state, &caller, &id, &dest).await,
        "Failed to move task",
    )
}

async fn move_into(state: &FlowState, caller: &Caller, id: &str, dest: &str) -> Reply {
    let db = &caller.db;
    let existing: Option<(Option<String>, String)> = sqlx::query_as(
        "select project_id, title from tasks where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((current_project, title)) = existing else {
        return Err(Refusal::not_found("Task", id));
    };
    if current_project.as_deref() == Some(dest) {
        return Ok(
            Data(json!({ "id": id, "projectId": dest, "movedSubtaskCount": 0 })).into_response(),
        );
    }
    let project: Option<String> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(dest)
            .fetch_optional(db)
            .await?;
    if project.is_none() {
        return Err(Refusal::not_found("Project", dest));
    }
    let default_stage: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, system_status from project_pipeline_stages
         where project_id = $1 and deleted_at is null order by position asc limit 1",
    )
    .bind(dest)
    .fetch_optional(db)
    .await?;
    let reset_stage = default_stage.as_ref().map(|(id, _)| id.clone());
    let reset_status = default_stage
        .and_then(|(_, status)| status)
        .unwrap_or_else(|| "todo".to_owned());

    let mut descendants: Vec<(String, String)> = Vec::new();
    let mut seen: Vec<String> = vec![id.to_owned()];
    let mut frontier = vec![id.to_owned()];
    for _ in 0..MAX_SUBTASK_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let children: Vec<(String, String)> = sqlx::query_as(
            "select id, title from tasks where parent_task_id = any($1) and deleted_at is null",
        )
        .bind(&frontier)
        .fetch_all(db)
        .await?;
        let fresh: Vec<(String, String)> = children
            .into_iter()
            .filter(|(child, _)| !seen.contains(child))
            .collect();
        if fresh.is_empty() {
            break;
        }
        frontier = fresh.iter().map(|(child, _)| child.clone()).collect();
        seen.extend(frontier.iter().cloned());
        descendants.extend(fresh);
    }
    let max_position: i32 = sqlx::query_scalar(
        "select coalesce(max(position), 0)::int from tasks where project_id = $1 and deleted_at is null",
    )
    .bind(dest)
    .fetch_one(db)
    .await?;
    let base = i64::from(max_position) + 1;
    let at = now();
    let mut all = vec![id.to_owned()];
    all.extend(descendants.iter().map(|(child, _)| child.clone()));
    let mut tx = db.begin().await?;
    for (i, task_id) in all.iter().enumerate() {
        sqlx::query(
            "update tasks set project_id = $2,
                 parent_task_id = case when $3 then null else parent_task_id end,
                 sprint_id = null, milestone_id = null, stage_id = $4, status = $5, key = null,
                 position = $6, board_position = null, updated_at = $7::timestamp
             where id = $1",
        )
        .bind(task_id)
        .bind(dest)
        .bind(task_id == id)
        .bind(reset_stage.as_deref())
        .bind(&reset_status)
        .bind(i32::try_from(base + i64::try_from(i).unwrap_or(0)).unwrap_or(i32::MAX))
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let moved = std::iter::once((id.to_owned(), title)).chain(descendants.iter().cloned());
    for (task_id, task_title) in moved {
        caller.publish(
            state,
            PROJECT_TASK_UPDATED,
            &task_id,
            &json!({
                "id": task_id,
                "title": task_title,
                "projectId": dest,
                "status": reset_status,
            }),
        );
    }
    Ok(Data(json!({
        "id": id,
        "projectId": dest,
        "movedSubtaskCount": descendants.len(),
    }))
    .into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let Some(removed) = soft_delete_task_tree(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Task", &id));
        };
        crate::project_files::mark_purge_due(&state, &caller, time::OffsetDateTime::now_utc())
            .await;
        for row in &removed {
            caller.publish(
                &state,
                PROJECT_TASK_DELETED,
                &row.id,
                &weldsuite_flow_domain::task_tree::removed_event_data(row),
            );
        }
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to delete task")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reorder_reuses_and_spreads_slots() {
        let rows = vec![
            ("a".to_owned(), 5),
            ("b".to_owned(), 5),
            ("c".to_owned(), 9),
        ];
        let order: Vec<String> = ["c", "x", "a", "b", "a"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(
            reordered_positions(&rows, &order),
            vec![
                ("c".to_owned(), 5),
                ("a".to_owned(), 6),
                ("b".to_owned(), 9)
            ]
        );
    }

    #[test]
    fn search_numbers_accept_task_prefixes() {
        assert_eq!(search_number(" TASK-42 "), Some(42));
        assert_eq!(search_number("#7"), Some(7));
        assert_eq!(search_number("abc"), None);
    }

    #[test]
    fn object_keys_belong_to_the_workspace() {
        assert!(is_workspace_object_key(
            "workspaces/org_1/a/b.png",
            Some("org_1")
        ));
        assert!(!is_workspace_object_key(
            "workspaces/org_2/a.png",
            Some("org_1")
        ));
        assert!(!is_workspace_object_key("other/org_1/a.png", Some("org_1")));
    }
}
