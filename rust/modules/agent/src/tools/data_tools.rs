//! The platform data tools: people (WeldCRM), tasks and projects (WeldFlow)
//! (`tools.ts` `people.*`, `tasks.*`; `projects-tools.ts`; `read-helpers.ts`).
//!
//! Reads respect the person's row scope when the tools act on a person's
//! behalf. Writes publish the entity event with `triggeredByAgentId`, so audit,
//! workflows and realtime see them and agents don't re-trigger on their own
//! records. The tenant database is per workspace; these tables carry no
//! workspace id, so every query filters by ids and `deleted_at is null`.

use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, Order,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{EventName, PERSON_CREATED, PROJECT_TASK_CREATED};
use weldsuite_crm_domain::people::{
    ListOptions, PeopleFilter, create_person_with, get_person, list_people,
};
use weldsuite_db::orm;
use weldsuite_events::publish_entity_event;
use weldsuite_flow_domain::numbering::allocate_task_number;
use weldsuite_flow_domain::stats::project_stats;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{project_members, projects, tasks, workspace_members};

use super::{ToolContext, ToolError, ToolSpec};
use crate::agents::{int4, js, row_limit};

const DESCRIPTION_MAX_CHARS: usize = 500;

#[allow(clippy::too_many_lines)] // one literal per tool
pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "people.list",
            name: "list_people",
            description: "Search or list people (CRM contacts) in the workspace.",
            required_permissions: &["people:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "maxLength": 200 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "people.get",
            name: "get_person",
            description: "Get a single person by id.",
            required_permissions: &["people:read"],
            parameters: json!({
                "type": "object",
                "properties": { "id": { "type": "string", "minLength": 1, "maxLength": 30 } },
                "required": ["id"],
            }),
        },
        ToolSpec {
            id: "people.create",
            name: "create_person",
            description: "Create a new person (CRM contact) in the workspace.",
            required_permissions: &["people:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "firstName": { "type": "string", "maxLength": 100 },
                    "lastName": { "type": "string", "maxLength": 100 },
                    "email": { "type": "string", "format": "email" },
                    "title": { "type": "string", "maxLength": 100 },
                    "mobilePhone": { "type": "string", "maxLength": 50 },
                },
            }),
        },
        ToolSpec {
            id: "tasks.list",
            name: "list_tasks",
            description: "List WeldFlow tasks with their project, assignees and due date, optionally filtered by status, project, \
                assignee, due date or search. totalCount is how many tasks match, whatever the limit. \
                \"My tasks\": assignedToMe. \"Due today\" or \"overdue\": dueOnOrBefore with includeDone=false.",
            required_permissions: &["tasks:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "maxLength": 200, "description": "Part of the task title" },
                    "status": { "type": "string", "maxLength": 30, "description": "One exact status, such as todo, in_progress or done" },
                    "projectId": { "type": "string", "maxLength": 30, "description": "Only tasks of this project (id from list_projects)" },
                    "assignedToMe": { "type": "boolean", "description": "true: only tasks assigned to the person you are working for (\"my tasks\")" },
                    "dueOnOrBefore": { "type": "string", "maxLength": 40,
                        "description": "ISO date such as 2026-10-27 (that whole day counts) or a date-time. Finds tasks due then or earlier, so overdue tasks are included. Tasks without a due date are left out." },
                    "includeDone": { "type": "boolean",
                        "description": "false leaves out finished tasks (done or cancelled). Use false for \"open\", \"to do\", \"due\" or \"overdue\" questions. Omitted: tasks of every status." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "tasks.create",
            name: "create_task",
            description: "Create a new project/personal task.",
            required_permissions: &["tasks:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "description": { "type": "string", "maxLength": 10000 },
                    "projectId": { "type": "string", "maxLength": 30 },
                    "priority": { "type": "string", "enum": ["low", "medium", "high", "urgent"] },
                    "status": { "type": "string", "maxLength": 30 },
                },
                "required": ["title"],
            }),
        },
        ToolSpec {
            id: "projects.list",
            name: "list_projects",
            description: "List WeldFlow projects with their status and how many tasks are open, done and in total. \
                Use it to find a project by name, or to answer questions about how many tasks a project has.",
            required_permissions: &["projects:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "search": { "type": "string", "maxLength": 200, "description": "Part of the project name or key" },
                    "status": { "type": "string", "maxLength": 50, "description": "Project status such as Planning, Active or Completed (not case sensitive)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50 },
                },
            }),
        },
        ToolSpec {
            id: "projects.get",
            name: "get_project",
            description: "Get one WeldFlow project: status, dates, manager, description and its task and milestone counts. \
                Pass its id (from list_projects) or its name.",
            required_permissions: &["projects:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "minLength": 1, "maxLength": 255, "description": "The project id, from list_projects" },
                    "name": { "type": "string", "minLength": 1, "maxLength": 255, "description": "The project name, when you do not have its id" },
                },
            }),
        },
    ]
}

pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    match id {
        "people.list" => people_list(ctx, args).await,
        "people.get" => people_get(ctx, args).await,
        "people.create" => people_create(ctx, args).await,
        "tasks.list" => tasks_list(ctx, args).await,
        "tasks.create" => tasks_create(ctx, args).await,
        "projects.list" => projects_list(ctx, args).await,
        "projects.get" => projects_get(ctx, args).await,
        other => Err(ToolError::UnknownTool(other.to_owned())),
    }
}

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

/// `emitAgentEntityEvent`: the event for a record an agent created. The
/// `triggeredByAgentId` marker stops agents from re-triggering on it.
fn emit_created(ctx: &ToolContext, event: EventName, entity_id: &str, data: Value) {
    let Some(sink) = &ctx.events else { return };
    let mut data = data;
    if let Some(map) = data.as_object_mut() {
        map.insert("createdBy".into(), json!(ctx.actor_user_id));
        map.insert("triggeredByAgentId".into(), json!(ctx.agent_id));
    }
    publish_entity_event(&sink.publisher, &sink.context, event, entity_id, &data);
}

/// The owner a people read is limited to: the person the tools act for,
/// unless they may see everyone's (`peopleOwnerScope`).
fn people_owner_scope(ctx: &ToolContext) -> Option<&str> {
    ctx.row_scope
        .as_ref()
        .filter(|scope| !scope.all_people)
        .map(|scope| scope.user_id.as_str())
}

async fn people_list(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let filter = PeopleFilter {
        search: text(args, "search").map(str::to_owned),
        ..PeopleFilter::default()
    };
    let options = ListOptions {
        limit: args.get("limit").and_then(Value::as_i64).unwrap_or(20),
        ..ListOptions::default()
    };
    let page = list_people(&ctx.db, &filter, &options, people_owner_scope(ctx))
        .await
        .map_err(|e| ToolError::Failed(format!("Could not list people: {e:?}")))?;
    let people: Vec<Value> = page
        .data
        .iter()
        .map(|p| json!({ "id": p["id"], "fullName": p["fullName"], "email": p["email"], "title": p["title"], "status": p["status"] }))
        .collect();
    Ok(json!({ "totalCount": page.total_count, "people": people }))
}

async fn people_get(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let id = text(args, "id").unwrap_or_default();
    let person = get_person(&ctx.db, id, people_owner_scope(ctx))
        .await
        .map_err(|e| ToolError::Failed(format!("Could not read the person: {e:?}")))?;
    let Some(person) = person else {
        return Ok(json!({ "error": "Person not found" }));
    };
    Ok(json!({
        "id": person["id"], "fullName": person["fullName"], "email": person["email"],
        "title": person["title"], "mobilePhone": person["mobilePhone"], "status": person["status"],
    }))
}

/// Whether the person is a member of the workspace (`isValidWorkspaceMember`).
/// Background agent jobs can outlive the invoker's membership; the owner is
/// left unset then instead of failing the tool on the owner check.
async fn is_workspace_member(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Id)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

async fn people_create(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let mut input: Map<String, Value> = args.as_object().cloned().unwrap_or_default();
    if is_workspace_member(&ctx.db, &ctx.actor_user_id).await? {
        input.insert("ownerId".into(), json!(ctx.actor_user_id));
    }
    input.insert("inCrm".into(), json!(true));
    let (person, _) = create_person_with(&ctx.db, &input, false)
        .await
        .map_err(|e| ToolError::Failed(format!("Could not create the person: {e:?}")))?;
    let id = person["id"].as_str().unwrap_or_default().to_owned();
    emit_created(
        ctx,
        PERSON_CREATED,
        &id,
        json!({ "id": id, "fullName": person["fullName"], "email": person["email"] }),
    );
    Ok(json!({ "id": id, "fullName": person["fullName"], "email": person["email"] }))
}

/// Task statuses that count as finished (`CLOSED_TASK_STATUSES`).
const CLOSED_TASK_STATUSES: [&str; 2] = ["done", "cancelled"];

/// Projects a person manages or is an active member of
/// (`accessibleProjectIds`): the membership boundary WeldFlow applies to
/// everyone without `projects:scope:all`. The live projects they manage,
/// and those they are an active member of (the worker's `union`).
async fn accessible_project_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, DbErr> {
    let member_of = Query::select()
        .column(project_members::Column::ProjectId)
        .from(project_members::Entity)
        .and_where(project_members::Column::UserId.eq(user_id))
        .and_where(project_members::Column::IsActive.eq(true))
        .and_where(project_members::Column::DeletedAt.is_null())
        .to_owned();
    projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(projects::Column::ProjectManagerId.eq(user_id))
                .add(projects::Column::Id.in_subquery(member_of)),
        )
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `null` when the person sees every project; otherwise the ids they may see
/// (`visibleProjectIds`).
async fn visible_project_ids(ctx: &ToolContext) -> Result<Option<Vec<String>>, DbErr> {
    match &ctx.row_scope {
        Some(scope) if !scope.all_projects => {
            Ok(Some(accessible_project_ids(&ctx.db, &scope.user_id).await?))
        }
        _ => Ok(None),
    }
}

/// Display names of workspace members, by user id (`memberNames`); the email
/// when a member has no name.
async fn member_names(db: &PgPool, ids: &[String]) -> Result<Vec<(String, String)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Name,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::UserId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(user_id, name, email)| {
            name.filter(|n| !n.is_empty())
                .or(email.filter(|e| !e.is_empty()))
                .map(|label| (user_id, label))
        })
        .collect())
}

/// What `dueOnOrBefore` stands for: a plain date is that whole calendar day
/// in the zone (the bound is the next local midnight, exclusive); a date-time
/// is an exact instant, inclusive (`dueCutoff`). `None` when it is neither.
fn plain_date(text: &str) -> Option<(i32, u32, u32)> {
    let mut parts = text.trim().split('-');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day.len() != 2 {
        return None;
    }
    let (year, month, day): (i32, u32, u32) =
        (year.parse().ok()?, month.parse().ok()?, day.parse().ok()?);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => return None,
    };
    (day >= 1 && day <= days).then_some((year, month, day))
}

/// A `dueOnOrBefore` bound, as the SQL needs it.
enum DueBound {
    /// A plain date: before the next local midnight in the zone.
    Day { date: String, zone: String },
    /// A date-time: up to and including the instant.
    Instant(String),
}

/// `(t.assignee_id = $user or t.assignee_ids::jsonb @> [$user])`.
fn assigned_to(user_id: &str) -> Condition {
    Condition::any()
        .add(tasks::Column::AssigneeId.eq(user_id))
        .add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            Expr::col((tasks::Entity, tasks::Column::AssigneeIds)),
            Expr::value(json!([user_id])),
        ))
}

/// `t.due_date` against a `dueOnOrBefore` bound: before the next local
/// midnight (`(date + 1)::timestamp at time zone zone`), or up to the instant
/// (`::timestamptz`). Postgres reads the date, the zone and the instant, as
/// it did in the worker's SQL.
fn due_condition(due: &DueBound) -> Expr {
    use sea_orm::ExprTrait as _;
    let due_date = Expr::col((tasks::Entity, tasks::Column::DueDate));
    match due {
        DueBound::Day { date, zone } => {
            let next_midnight = Expr::value(date.clone())
                .cast_as("date")
                .add(1)
                .cast_as("timestamp");
            due_date.lt(Func::cust("timezone")
                .arg(Expr::value(zone.clone()))
                .arg(next_midnight))
        }
        DueBound::Instant(at) => due_date.lte(Expr::value(at.clone()).cast_as("timestamptz")),
    }
}

/// The columns `list_tasks` reads.
#[derive(Debug, FromQueryResult)]
struct TaskRow {
    id: String,
    number: Option<i32>,
    title: String,
    status: Option<String>,
    priority: Option<String>,
    project_id: Option<String>,
    assignee_id: Option<String>,
    assignee_ids: Option<Value>,
    due_date: Option<PrimitiveDateTime>,
}

#[allow(clippy::too_many_lines)] // the one list query, as TypeScript builds it
async fn tasks_list(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(20);
    let due = match text(args, "dueOnOrBefore") {
        None => None,
        Some(due) => {
            let zone = ctx
                .user_timezone
                .clone()
                .unwrap_or_else(|| "UTC".to_owned());
            if let Some((year, month, day)) = plain_date(due) {
                Some(DueBound::Day {
                    date: format!("{year:04}-{month:02}-{day:02}"),
                    zone,
                })
            } else if looks_like_instant(due) {
                Some(DueBound::Instant(due.trim().to_owned()))
            } else {
                return Ok(
                    json!({ "error": "dueOnOrBefore must be an ISO date such as 2026-10-27." }),
                );
            }
        }
    };
    // The projects the person manages or belongs to, tasks assigned to them,
    // and personal tasks they reported.
    let scoped = match &ctx.row_scope {
        Some(scope) if !scope.all_projects => Some((
            scope.user_id.clone(),
            accessible_project_ids(&ctx.db, &scope.user_id).await?,
        )),
        _ => None,
    };
    // Tasks of a deleted project are gone with it.
    let deleted_project = Query::select()
        .expr(Expr::value(1))
        .from(projects::Entity)
        .and_where(sea_orm::ExprTrait::equals(
            Expr::col((projects::Entity, projects::Column::Id)),
            (tasks::Entity, tasks::Column::ProjectId),
        ))
        .and_where(projects::Column::DeletedAt.is_not_null())
        .to_owned();
    let mut conditions = Condition::all()
        .add(tasks::Column::DeletedAt.is_null())
        .add(Expr::not_exists(deleted_project));
    if let Some(status) = text(args, "status") {
        conditions = conditions.add(tasks::Column::Status.eq(status));
    } else if args.get("includeDone").and_then(Value::as_bool) == Some(false) {
        conditions = conditions.add(tasks::Column::Status.is_not_in(CLOSED_TASK_STATUSES));
    }
    if let Some(project) = text(args, "projectId") {
        conditions = conditions.add(tasks::Column::ProjectId.eq(project));
    }
    if let Some(search) = text(args, "search") {
        conditions = conditions.add(tasks::Column::Title.ilike(format!("%{search}%")));
    }
    if args.get("assignedToMe").and_then(Value::as_bool) == Some(true) {
        conditions = conditions.add(assigned_to(&ctx.actor_user_id));
    }
    if let Some(due) = &due {
        conditions = conditions.add(due_condition(due));
    }
    if let Some((user_id, projects)) = &scoped {
        conditions = conditions.add(
            Condition::any()
                .add(tasks::Column::ProjectId.is_in(projects.iter().map(String::as_str)))
                .add(assigned_to(user_id))
                .add(
                    Condition::all()
                        .add(tasks::Column::ProjectId.is_null())
                        .add(tasks::Column::ReporterId.eq(user_id.as_str())),
                ),
        );
    }
    let conn = orm(&ctx.db);
    let total = tasks::Entity::find()
        .filter(conditions.clone())
        .count(&conn)
        .await?;
    let mut page = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::Id,
            tasks::Column::Number,
            tasks::Column::Title,
            tasks::Column::Status,
            tasks::Column::Priority,
            tasks::Column::ProjectId,
            tasks::Column::AssigneeId,
            tasks::Column::AssigneeIds,
            tasks::Column::DueDate,
        ])
        .filter(conditions);
    // Tasks due soonest come first when the question is about due dates.
    if due.is_some() {
        page = page.order_by_asc(tasks::Column::DueDate);
    }
    let rows = page
        .order_by_desc(tasks::Column::CreatedAt)
        .limit(row_limit(limit)?)
        .into_model::<TaskRow>()
        .all(&conn)
        .await?;

    let mut project_ids: Vec<String> = Vec::new();
    let mut member_ids: Vec<String> = Vec::new();
    let mut raw: Vec<(Value, Option<String>, Vec<String>)> = Vec::new();
    for row in rows {
        let project_id = row.project_id;
        let primary = row.assignee_id;
        let many = row.assignee_ids;
        let mut assignees: Vec<String> = Vec::new();
        let listed = many
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned));
        for id in primary.into_iter().chain(listed) {
            if !id.is_empty() && !assignees.contains(&id) {
                assignees.push(id);
            }
        }
        if let Some(project) = &project_id
            && !project_ids.contains(project)
        {
            project_ids.push(project.clone());
        }
        member_ids.extend(assignees.iter().cloned());
        // to_char(due_date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        let due_date = row
            .due_date
            .map(|at| weldsuite_events::iso_timestamp(at.assume_utc()));
        raw.push((
            json!({
                "id": row.id,
                "number": row.number,
                "title": row.title,
                "status": row.status,
                "priority": row.priority,
                "dueDate": due_date,
            }),
            project_id,
            assignees,
        ));
    }
    let projects = project_names(&ctx.db, &project_ids).await?;
    let members = member_names(&ctx.db, &member_ids).await?;
    let mut tasks: Vec<Value> = Vec::with_capacity(raw.len());
    for (mut task, project_id, assignees) in raw {
        let project_name = project_id.as_ref().and_then(|id| {
            projects
                .iter()
                .find(|(p, _)| p == id)
                .map(|(_, n)| n.clone())
        });
        let names: Vec<String> = assignees
            .iter()
            .filter_map(|id| {
                members
                    .iter()
                    .find(|(m, _)| m == id)
                    .map(|(_, n)| n.clone())
            })
            .collect();
        if let Some(map) = task.as_object_mut() {
            map.insert("projectId".into(), json!(project_id));
            map.insert("projectName".into(), json!(project_name));
            map.insert("assigneeIds".into(), json!(assignees));
            map.insert("assignees".into(), json!(names));
        }
        tasks.push(task);
    }
    Ok(json!({ "totalCount": total, "tasks": tasks }))
}

fn looks_like_instant(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() >= 10
        && trimmed.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && trimmed.contains('T')
}

async fn project_names(db: &PgPool, ids: &[String]) -> Result<Vec<(String, String)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    projects::Entity::find()
        .select_only()
        .columns([projects::Column::Id, projects::Column::Name])
        .filter(projects::Column::Id.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await
}

async fn tasks_create(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let id = generate_id("task");
    let now = weldsuite_db::utc_now();
    let number = allocate_task_number(&orm(&ctx.db)).await?;
    let status = text(args, "status").unwrap_or("todo").to_owned();
    let title = text(args, "title").unwrap_or_default().to_owned();
    tasks::Entity::insert(tasks::ActiveModel {
        id: Set(id.clone()),
        number: Set(Some(int4(number)?)),
        title: Set(title.clone()),
        description: Set(text(args, "description").map(str::to_owned)),
        project_id: Set(text(args, "projectId").map(str::to_owned)),
        status: Set(status.clone()),
        priority: Set(text(args, "priority").unwrap_or("medium").to_owned()),
        type_: Set(Some("task".to_owned())),
        reporter_id: Set(Some(ctx.actor_user_id.clone())),
        position: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&ctx.db))
    .await?;
    emit_created(
        ctx,
        PROJECT_TASK_CREATED,
        &id,
        json!({ "id": id, "title": title, "projectId": text(args, "projectId"), "status": status }),
    );
    Ok(json!({ "id": id, "title": title, "status": status }))
}

fn task_counts(stats: Option<&weldsuite_flow_domain::stats::ProjectStats>) -> Value {
    let progress: f64 = stats.and_then(|s| s.progress.parse().ok()).unwrap_or(0.0);
    json!({
        "openTasks": stats.map_or(0, |s| s.open_tasks),
        "completedTasks": stats.map_or(0, |s| s.completed_tasks),
        "totalTasks": stats.map_or(0, |s| s.total_tasks),
        "progressPercent": progress.round(),
    })
}

/// The columns `list_projects` reads, as Drizzle returns them.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRow {
    id: String,
    name: String,
    key: Option<String>,
    status: String,
    priority: Option<String>,
    health: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    start_date: Option<PrimitiveDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    end_date: Option<PrimitiveDateTime>,
}

/// `lower(p.status) = lower($status)`.
fn status_is(status: &str) -> Expr {
    sea_orm::ExprTrait::eq(
        Expr::from(Func::lower(Expr::col((
            projects::Entity,
            projects::Column::Status,
        )))),
        Func::lower(Expr::value(status)),
    )
}

async fn projects_list(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let visible = visible_project_ids(ctx).await?;
    if visible.as_ref().is_some_and(Vec::is_empty) {
        return Ok(json!({ "totalCount": 0, "projects": [] }));
    }
    let limit = args.get("limit").and_then(Value::as_i64).unwrap_or(20);
    let mut conditions = Condition::all().add(projects::Column::DeletedAt.is_null());
    if let Some(ids) = &visible {
        conditions = conditions.add(projects::Column::Id.is_in(ids.iter().map(String::as_str)));
    }
    if let Some(status) = text(args, "status") {
        conditions = conditions.add(status_is(status));
    }
    if let Some(search) = text(args, "search") {
        let like = format!("%{search}%");
        conditions = conditions.add(
            Condition::any()
                .add(projects::Column::Name.ilike(like.clone()))
                .add(projects::Column::Key.ilike(like.clone()))
                .add(projects::Column::Code.ilike(like)),
        );
    }
    let conn = orm(&ctx.db);
    let total = projects::Entity::find()
        .filter(conditions.clone())
        .count(&conn)
        .await?;
    let rows: Vec<Value> = projects::Entity::find()
        .select_only()
        .columns([
            projects::Column::Id,
            projects::Column::Name,
            projects::Column::Key,
            projects::Column::Status,
            projects::Column::Priority,
            projects::Column::Health,
            projects::Column::StartDate,
            projects::Column::EndDate,
        ])
        .filter(conditions)
        .order_by_desc(projects::Column::UpdatedAt)
        .limit(row_limit(limit)?)
        .into_model::<ProjectRow>()
        .all(&conn)
        .await?
        .into_iter()
        .map(js)
        .collect();
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let stats = project_stats(&ctx.db, &ids).await?;
    let projects: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut out = json!({
                "id": row["id"], "name": row["name"], "key": row["key"], "status": row["status"],
                "priority": row["priority"], "health": row["health"],
                "startDate": row["startDate"], "endDate": row["endDate"],
            });
            if let (Some(map), Some(counts)) = (
                out.as_object_mut(),
                task_counts(row["id"].as_str().and_then(|id| stats.get(id)))
                    .as_object()
                    .cloned(),
            ) {
                map.extend(counts);
            }
            out
        })
        .collect();
    Ok(json!({ "totalCount": total, "projects": projects }))
}

async fn projects_get(ctx: &ToolContext, args: &Value) -> Result<Value, ToolError> {
    let (id, name) = (text(args, "id"), text(args, "name"));
    if id.is_none() && name.is_none() {
        return Ok(json!({ "error": "Give the project id or its name." }));
    }
    let visible = visible_project_ids(ctx).await?;
    if visible.as_ref().is_some_and(Vec::is_empty) {
        return Ok(json!({ "error": "Project not found" }));
    }
    let mut query = projects::Entity::find().filter(projects::Column::DeletedAt.is_null());
    if let Some(ids) = &visible {
        query = query.filter(projects::Column::Id.is_in(ids.iter().map(String::as_str)));
    }
    if let Some(id) = id {
        query = query.filter(projects::Column::Id.eq(id));
    } else if let Some(name) = name {
        query = query.filter(projects::Column::Name.ilike(format!("%{name}%")));
    }
    if let Some(name) = name.filter(|_| id.is_none()) {
        // An exact name leads, so it is among the few rows read however many
        // projects partly match.
        query = query.order_by(
            sea_orm::ExprTrait::eq(
                Expr::from(Func::lower(Expr::col((
                    projects::Entity,
                    projects::Column::Name,
                )))),
                Func::lower(Expr::value(name)),
            ),
            Order::Desc,
        );
    }
    let rows: Vec<Value> = query
        .order_by_desc(projects::Column::UpdatedAt)
        .limit(6)
        .all(&orm(&ctx.db))
        .await?
        .into_iter()
        .map(js)
        .collect();
    if rows.is_empty() {
        return Ok(json!({ "error": "Project not found" }));
    }
    // A name can match several projects; an exact (case-insensitive) match wins.
    let exact: Vec<&Value> = match name.filter(|_| id.is_none()) {
        Some(name) => rows
            .iter()
            .filter(|r| {
                r["name"]
                    .as_str()
                    .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
            })
            .collect(),
        None => Vec::new(),
    };
    let candidates: Vec<&Value> = if exact.is_empty() {
        rows.iter().collect()
    } else {
        exact
    };
    if candidates.len() > 1 {
        return Ok(json!({
            "error": "Several projects match that name; ask the user which one they mean.",
            "matches": candidates.iter().map(|r| json!({ "id": r["id"], "name": r["name"], "status": r["status"] })).collect::<Vec<_>>(),
        }));
    }
    let project = candidates[0];
    let project_id = project["id"].as_str().unwrap_or_default().to_owned();
    let stats = project_stats(&ctx.db, std::slice::from_ref(&project_id)).await?;
    let detail = stats.get(&project_id);
    let manager = match project["projectManagerId"].as_str() {
        Some(manager) => member_names(&ctx.db, &[manager.to_owned()])
            .await?
            .into_iter()
            .next()
            .map(|(_, label)| label),
        None => None,
    };
    let description = project["description"]
        .as_str()
        .map(|d| d.chars().take(DESCRIPTION_MAX_CHARS).collect::<String>());
    let mut out = json!({
        "id": project["id"], "name": project["name"], "key": project["key"],
        "status": project["status"], "priority": project["priority"], "health": project["health"],
        "description": description, "manager": manager,
        "startDate": project["startDate"], "endDate": project["endDate"],
        "totalMilestones": detail.map_or(0, |s| s.total_milestones),
        "completedMilestones": detail.map_or(0, |s| s.completed_milestones),
    });
    if let (Some(map), Some(counts)) = (
        out.as_object_mut(),
        task_counts(detail).as_object().cloned(),
    ) {
        map.extend(counts);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_dates_are_checked_like_the_worker() {
        assert_eq!(plain_date("2026-10-27"), Some((2026, 10, 27)));
        assert_eq!(plain_date("2026-02-31"), None);
        assert_eq!(plain_date("2028-02-29"), Some((2028, 2, 29)));
        assert_eq!(plain_date("2026-10-27T10:00:00Z"), None);
        assert!(looks_like_instant("2026-10-27T10:00:00Z"));
        assert!(!looks_like_instant("soon"));
    }

    #[test]
    fn task_counts_round_the_progress() {
        let stats = weldsuite_flow_domain::stats::ProjectStats {
            total_tasks: 8,
            completed_tasks: 3,
            open_tasks: 5,
            total_milestones: 0,
            completed_milestones: 0,
            progress: "37.50".to_owned(),
            actual_hours: "0.00".to_owned(),
        };
        let counts = task_counts(Some(&stats));
        assert_eq!(counts["progressPercent"], 38.0);
        assert_eq!(counts["openTasks"], 5);
        assert_eq!(task_counts(None)["totalTasks"], 0);
    }
}
