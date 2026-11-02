//! WeldFlow's objects: `/v1/projects`, `/v1/tasks`, `/v1/time-entries`,
//! `/v1/milestones` (with their computed stats) and the plain groups
//! (`/v1/goals`, `/v1/sprints`, `/v1/task-comments`, `/v1/task-tags`,
//! `/v1/project-*`, `/v1/whiteboards`), on `weldsuite_flow_domain` where
//! the TypeScript routes use `@weldsuite/flow-domain`.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_CREATED, PROJECT_DELETED, PROJECT_DOCUMENT_CREATED, PROJECT_DOCUMENT_DELETED,
    PROJECT_DOCUMENT_UPDATED, PROJECT_FILE_CREATED, PROJECT_FILE_DELETED, PROJECT_FILE_UPDATED,
    PROJECT_GOAL_CREATED, PROJECT_GOAL_DELETED, PROJECT_GOAL_UPDATED, PROJECT_LABEL_CREATED,
    PROJECT_LABEL_DELETED, PROJECT_LABEL_UPDATED, PROJECT_MEMBER_ADDED, PROJECT_MEMBER_REMOVED,
    PROJECT_MEMBER_UPDATED, PROJECT_MESSAGE_CREATED, PROJECT_MESSAGE_DELETED,
    PROJECT_MESSAGE_UPDATED, PROJECT_MILESTONE_CREATED, PROJECT_MILESTONE_DELETED,
    PROJECT_MILESTONE_UPDATED, PROJECT_SPRINT_CREATED, PROJECT_SPRINT_DELETED,
    PROJECT_SPRINT_UPDATED, PROJECT_TASK_CREATED, PROJECT_TASK_DELETED, PROJECT_TASK_UPDATED,
    PROJECT_TIME_ENTRY_CREATED, PROJECT_TIME_ENTRY_DELETED, PROJECT_TIME_ENTRY_UPDATED,
    PROJECT_UPDATED, PROJECT_WHITEBOARD_CREATED, PROJECT_WHITEBOARD_DELETED,
    PROJECT_WHITEBOARD_UPDATED, TASK_COMMENT_CREATED, TASK_COMMENT_DELETED, TASK_COMMENT_UPDATED,
    TASK_TAG_CREATED, TASK_TAG_DELETED, TASK_TAG_UPDATED,
};
use weldsuite_flow_domain::stage::{apply_status_change, task_status_aliases};
use weldsuite_flow_domain::stats::{
    milestone_refs, milestone_stats, project_stats, with_milestone_stats, with_project_stats,
};
use weldsuite_flow_domain::task_dependencies::{
    DependencyFailure, LinkAccess, LinkInput, ParentChange, check_new_task_links,
    link_created_task, plan_dependency_update, validate_task_relations, write_dependency_rows,
};
use weldsuite_flow_domain::task_tree::soft_delete_task_tree;
use weldsuite_flow_domain::tasks::{CreateError, create_task};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, Fail, created, dates, field, js_date, list_query, live_or_404, no_content, now,
    ok, soft_delete, table_list_sql, to_date,
};
use crate::list::list_rows;
use crate::schemas::{
    CREATE_TIME_ENTRY, LIST_GOALS, LIST_MILESTONES, LIST_PROJECT_DOCUMENTS, LIST_PROJECT_FILES,
    LIST_PROJECT_LABELS, LIST_PROJECT_MEMBERS, LIST_PROJECT_MESSAGES, LIST_PROJECTS, LIST_SPRINTS,
    LIST_TASK_COMMENTS, LIST_TASK_TAGS, LIST_TASKS, LIST_TIME_ENTRIES, LIST_WHITEBOARDS,
    UPDATE_TIME_ENTRY,
};
use crate::schemas_gen::{
    CREATE_GOAL, CREATE_MILESTONE, CREATE_PROJECT, CREATE_PROJECT_DOCUMENT, CREATE_PROJECT_FILE,
    CREATE_PROJECT_LABEL, CREATE_PROJECT_MEMBER, CREATE_PROJECT_MESSAGE, CREATE_SPRINT,
    CREATE_TASK, CREATE_TASK_COMMENT, CREATE_TASK_TAG, CREATE_WHITEBOARD, UPDATE_GOAL,
    UPDATE_MILESTONE, UPDATE_PROJECT, UPDATE_PROJECT_DOCUMENT, UPDATE_PROJECT_FILE,
    UPDATE_PROJECT_LABEL, UPDATE_PROJECT_MEMBER, UPDATE_PROJECT_MESSAGE, UPDATE_SPRINT,
    UPDATE_TASK, UPDATE_TASK_COMMENT, UPDATE_TASK_TAG, UPDATE_WHITEBOARD,
};
use crate::session::{bad_request, internal, internal_with, not_found};
use crate::simple::{self, Dates, F, Simple, Stats};
use crate::tables_gen::{
    MILESTONES, PROJECT_DOCUMENTS, PROJECT_FILES, PROJECT_GOALS, PROJECT_LABELS, PROJECT_MEMBERS,
    PROJECT_MESSAGES, PROJECT_WHITEBOARDS, PROJECTS, SPRINTS, TASK_COMMENTS, TASK_TAGS, TASKS,
    TIME_ENTRIES,
};
use crate::zod;

type S = State<ExternalApiState>;

/// Flow's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    let router = [
        &PROJECT_GROUP,
        &MILESTONE_GROUP,
        &GOALS,
        &SPRINTS_GROUP,
        &TASK_COMMENTS_GROUP,
        &TASK_TAGS_GROUP,
        &DOCUMENTS,
        &FILES,
        &LABELS,
        &MEMBERS,
        &MESSAGES,
        &WHITEBOARDS,
    ]
    .into_iter()
    .fold(router, simple::mount);
    router
        .route(
            "/tasks",
            simple::scoped(get(list_tasks), "tasks:read")
                .merge(simple::scoped(post(create_task_route), "tasks:write")),
        )
        .route(
            "/tasks/{id}",
            simple::scoped(get(get_task), "tasks:read").merge(simple::scoped(
                patch(update_task).delete(delete_task),
                "tasks:write",
            )),
        )
        .route(
            "/time-entries",
            simple::scoped(get(list_time_entries), "time_entries:read").merge(simple::scoped(
                post(create_time_entry),
                "time_entries:write",
            )),
        )
        .route(
            "/time-entries/{id}",
            simple::scoped(get(get_time_entry), "time_entries:read").merge(simple::scoped(
                patch(update_time_entry).delete(delete_time_entry),
                "time_entries:write",
            )),
        )
}

// ---------------------------------------------------------------------------
// The plain groups
// ---------------------------------------------------------------------------

static PROJECT_GROUP: Simple = Simple {
    path: "/projects",
    scope: "projects",
    table: &PROJECTS,
    label: "Project",
    prefix: "prj",
    list: &LIST_PROJECTS,
    create: &CREATE_PROJECT,
    update: &UPDATE_PROJECT,
    sql: table_list_sql!(
        projects,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'ownerId' is null or t.project_manager_id = $3->>'ownerId') \
         and ($3->>'status' is null or t.status = $3->>'status') \
         and ($3->>'isActive' is null or t.is_active = ($3->>'isActive')::boolean)"
    ),
    filters: &[
        F::Like("search"),
        F::Eq("ownerId"),
        F::Eq("status"),
        F::Flag("isActive"),
    ],
    dates: &["startDate", "endDate"],
    events: Some([PROJECT_CREATED, PROJECT_UPDATED, PROJECT_DELETED]),
    data: &["name"],
    deleted_data: None,
    prepare: None,
    stats: Stats::Project,
    touch: true,
};

static MILESTONE_GROUP: Simple = Simple {
    path: "/milestones",
    scope: "milestones",
    table: &MILESTONES,
    label: "Milestone",
    prefix: "ms",
    list: &LIST_MILESTONES,
    create: &CREATE_MILESTONE,
    update: &UPDATE_MILESTONE,
    sql: table_list_sql!(
        milestones,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
         and ($3->>'status' is null or t.status = $3->>'status')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId"), F::Eq("status")],
    dates: &["dueDate", "completedAt"],
    events: Some([
        PROJECT_MILESTONE_CREATED,
        PROJECT_MILESTONE_UPDATED,
        PROJECT_MILESTONE_DELETED,
    ]),
    data: &["name", "projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::Milestone,
    touch: true,
};

static GOALS: Simple = Simple {
    path: "/goals",
    scope: "goals",
    table: &PROJECT_GOALS,
    label: "Goal",
    prefix: "goal",
    list: &LIST_GOALS,
    create: &CREATE_GOAL,
    update: &UPDATE_GOAL,
    sql: table_list_sql!(
        project_goals,
        "t.deleted_at is null and ($3->>'projectId' is null or t.project_id = $3->>'projectId')"
    ),
    filters: &[F::Eq("projectId")],
    dates: &[],
    events: Some([
        PROJECT_GOAL_CREATED,
        PROJECT_GOAL_UPDATED,
        PROJECT_GOAL_DELETED,
    ]),
    data: &["projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

static SPRINTS_GROUP: Simple = Simple {
    path: "/sprints",
    scope: "sprints",
    table: &SPRINTS,
    label: "Sprint",
    prefix: "spr",
    list: &LIST_SPRINTS,
    create: &CREATE_SPRINT,
    update: &UPDATE_SPRINT,
    sql: table_list_sql!(
        sprints,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
         and ($3->>'status' is null or t.status = $3->>'status')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId"), F::Eq("status")],
    dates: &["startDate", "endDate", "startedAt", "completedAt"],
    events: Some([
        PROJECT_SPRINT_CREATED,
        PROJECT_SPRINT_UPDATED,
        PROJECT_SPRINT_DELETED,
    ]),
    data: &["name", "projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

/// task-comments: the schema's `body` is the `content` column; a create
/// fills in the author and the task type.
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn comment_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    let body = values.remove("body");
    if create {
        let author = match values.get("authorId") {
            Some(Value::Null) | None => json!(caller.session.actor()),
            Some(author) => author.clone(),
        };
        values.insert("authorId".into(), author);
        values.insert("content".into(), body.unwrap_or_else(|| json!("")));
        if matches!(values.get("taskType"), Some(Value::Null) | None) {
            values.insert("taskType".into(), json!("project"));
        }
    } else if let Some(body) = body {
        values.insert("content".into(), body);
    }
    Ok(&[])
}

static TASK_COMMENTS_GROUP: Simple = Simple {
    path: "/task-comments",
    scope: "task_comments",
    table: &TASK_COMMENTS,
    label: "TaskComment",
    prefix: "tcmt",
    list: &LIST_TASK_COMMENTS,
    create: &CREATE_TASK_COMMENT,
    update: &UPDATE_TASK_COMMENT,
    sql: table_list_sql!(
        task_comments,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.content like $3->>'search') \
         and ($3->>'taskId' is null or t.task_id = $3->>'taskId')"
    ),
    filters: &[F::Like("search"), F::Eq("taskId")],
    dates: &[],
    events: Some([
        TASK_COMMENT_CREATED,
        TASK_COMMENT_UPDATED,
        TASK_COMMENT_DELETED,
    ]),
    data: &["taskId"],
    deleted_data: None,
    prepare: Some(comment_values),
    stats: Stats::None,
    touch: true,
};

/// task-tags: a create belongs to the caller (`userId`).
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn tag_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if create {
        values.insert("userId".into(), json!(caller.session.actor()));
    }
    Ok(&[])
}

static TASK_TAGS_GROUP: Simple = Simple {
    path: "/task-tags",
    scope: "task_tags",
    table: &TASK_TAGS,
    label: "TaskTag",
    prefix: "ttag",
    list: &LIST_TASK_TAGS,
    create: &CREATE_TASK_TAG,
    update: &UPDATE_TASK_TAG,
    sql: table_list_sql!(
        task_tags,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'userId' is null or t.user_id = $3->>'userId')"
    ),
    filters: &[F::Like("search"), F::Eq("userId")],
    dates: &[],
    events: Some([TASK_TAG_CREATED, TASK_TAG_UPDATED, TASK_TAG_DELETED]),
    data: &["name"],
    deleted_data: None,
    prepare: Some(tag_values),
    stats: Stats::None,
    touch: true,
};

static DOCUMENTS: Simple = Simple {
    path: "/project-documents",
    scope: "project_documents",
    table: &PROJECT_DOCUMENTS,
    label: "ProjectDocument",
    prefix: "pdoc",
    list: &LIST_PROJECT_DOCUMENTS,
    create: &CREATE_PROJECT_DOCUMENT,
    update: &UPDATE_PROJECT_DOCUMENT,
    sql: table_list_sql!(
        project_documents,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.title like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
         and ($3->>'parentId' is null or t.parent_id = $3->>'parentId')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId"), F::Eq("parentId")],
    dates: &[],
    events: Some([
        PROJECT_DOCUMENT_CREATED,
        PROJECT_DOCUMENT_UPDATED,
        PROJECT_DOCUMENT_DELETED,
    ]),
    data: &["projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

static FILES: Simple = Simple {
    path: "/project-files",
    scope: "project_files",
    table: &PROJECT_FILES,
    label: "ProjectFile",
    prefix: "pfile",
    list: &LIST_PROJECT_FILES,
    create: &CREATE_PROJECT_FILE,
    update: &UPDATE_PROJECT_FILE,
    sql: table_list_sql!(
        project_files,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.file_name like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
         and ($3->>'fileType' is null or t.file_type = $3->>'fileType')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId"), F::Eq("fileType")],
    dates: &[],
    events: Some([
        PROJECT_FILE_CREATED,
        PROJECT_FILE_UPDATED,
        PROJECT_FILE_DELETED,
    ]),
    data: &["projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

/// project-labels: `color` is NOT NULL, so a create defaults it.
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn label_values(_: &Caller, values: &mut Map<String, Value>, create: bool) -> Result<Dates, Fail> {
    if create && matches!(values.get("color"), Some(Value::Null) | None) {
        values.insert("color".into(), json!("#6B7280"));
    }
    Ok(&[])
}

static LABELS: Simple = Simple {
    path: "/project-labels",
    scope: "project_labels",
    table: &PROJECT_LABELS,
    label: "ProjectLabel",
    prefix: "plbl",
    list: &LIST_PROJECT_LABELS,
    create: &CREATE_PROJECT_LABEL,
    update: &UPDATE_PROJECT_LABEL,
    sql: table_list_sql!(
        project_labels,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId")],
    dates: &[],
    events: Some([
        PROJECT_LABEL_CREATED,
        PROJECT_LABEL_UPDATED,
        PROJECT_LABEL_DELETED,
    ]),
    data: &["name"],
    deleted_data: None,
    prepare: Some(label_values),
    stats: Stats::None,
    touch: true,
};

static MEMBERS: Simple = Simple {
    path: "/project-members",
    scope: "project_members",
    table: &PROJECT_MEMBERS,
    label: "ProjectMember",
    prefix: "pmem",
    list: &LIST_PROJECT_MEMBERS,
    create: &CREATE_PROJECT_MEMBER,
    update: &UPDATE_PROJECT_MEMBER,
    sql: table_list_sql!(
        project_members,
        "t.deleted_at is null \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
         and ($3->>'userId' is null or t.user_id = $3->>'userId') \
         and ($3->>'role' is null or t.role = $3->>'role')"
    ),
    filters: &[F::Eq("projectId"), F::Eq("userId"), F::Eq("role")],
    dates: &[],
    events: Some([
        PROJECT_MEMBER_ADDED,
        PROJECT_MEMBER_UPDATED,
        PROJECT_MEMBER_REMOVED,
    ]),
    data: &["projectId", "userId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

/// project-messages: a create is sent by the caller unless it names a sender.
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn message_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if create && matches!(values.get("senderId"), Some(Value::Null) | None) {
        values.insert("senderId".into(), json!(caller.session.actor()));
    }
    Ok(&[])
}

static MESSAGES: Simple = Simple {
    path: "/project-messages",
    scope: "project_messages",
    table: &PROJECT_MESSAGES,
    label: "ProjectMessage",
    prefix: "pmsg",
    list: &LIST_PROJECT_MESSAGES,
    create: &CREATE_PROJECT_MESSAGE,
    update: &UPDATE_PROJECT_MESSAGE,
    sql: table_list_sql!(
        project_messages,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.message like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId")],
    dates: &[],
    events: Some([
        PROJECT_MESSAGE_CREATED,
        PROJECT_MESSAGE_UPDATED,
        PROJECT_MESSAGE_DELETED,
    ]),
    data: &["projectId"],
    deleted_data: None,
    prepare: Some(message_values),
    stats: Stats::None,
    touch: true,
};

static WHITEBOARDS: Simple = Simple {
    path: "/whiteboards",
    scope: "whiteboards",
    table: &PROJECT_WHITEBOARDS,
    label: "Whiteboard",
    prefix: "pwb",
    list: &LIST_WHITEBOARDS,
    create: &CREATE_WHITEBOARD,
    update: &UPDATE_WHITEBOARD,
    sql: table_list_sql!(
        project_whiteboards,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'projectId' is null or t.project_id = $3->>'projectId')"
    ),
    filters: &[F::Like("search"), F::Eq("projectId")],
    dates: &[],
    events: Some([
        PROJECT_WHITEBOARD_CREATED,
        PROJECT_WHITEBOARD_UPDATED,
        PROJECT_WHITEBOARD_DELETED,
    ]),
    data: &["name", "projectId"],
    deleted_data: None,
    prepare: None,
    stats: Stats::None,
    touch: true,
};

/// `withProjectStats` / `withMilestoneStats` over rows, as the list and
/// the detail read them.
pub(crate) async fn decorate(
    db: &weldsuite_db::PgPool,
    stats: Stats,
    rows: Vec<Value>,
) -> Result<Vec<Value>, Fail> {
    Ok(match stats {
        Stats::None => rows,
        Stats::Project => {
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect();
            let stats = project_stats(db, &ids).await?;
            with_project_stats(rows, &stats)
        }
        Stats::Milestone => {
            let stats = milestone_stats(db, &milestone_refs(&rows)).await?;
            with_milestone_stats(rows, &stats)
        }
    })
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASKS_LIST: (&str, &str) = table_list_sql!(
    tasks,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.title like $3->>'search' or t.description like $3->>'search' \
          or ($3->>'number' is not null and t.number = ($3->>'number')::integer)) \
     and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
     and ($3->>'status' is null or t.status in (select jsonb_array_elements_text($3->'statuses'))) \
     and ($3->>'priority' is null or t.priority = $3->>'priority') \
     and ($3->>'type' is null or t.type = $3->>'type') \
     and ($3->>'sprintId' is null or t.sprint_id = $3->>'sprintId') \
     and ($3->>'milestoneId' is null or t.milestone_id = $3->>'milestoneId') \
     and ($3->>'parentTaskId' is null or t.parent_task_id = $3->>'parentTaskId') \
     and ($3->>'assigneeId' is null or t.assignee_id = $3->>'assigneeId' \
          or t.assignee_ids @> jsonb_build_array($3->>'assigneeId')) \
     and ($3->>'dueFrom' is null or t.due_date >= ($3->>'dueFrom')::timestamp) \
     and ($3->>'dueTo' is null or t.due_date <= ($3->>'dueTo')::timestamp)"
);

/// The task number a search names (`TASK-1042`, `#1042`, `1042`).
fn number_search(term: &str) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(term);
    let trimmed = trimmed.strip_prefix('#').unwrap_or(trimmed);
    let lower = trimmed.get(..5).map(str::to_ascii_lowercase);
    let digits = if lower.as_deref() == Some("task-") {
        &trimmed[5..]
    } else {
        trimmed
    };
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| {
        // `Number(numberMatch)`: leading zeros go.
        let stripped = digits.trim_start_matches('0');
        if stripped.is_empty() { "0" } else { stripped }.to_owned()
    })
}

/// A list date filter: `new Date(value)` (an invalid one throws: 500).
fn date_filter(parsed: &zod::Parsed, key: &str) -> Result<Value, Fail> {
    match parsed.text(key) {
        Some(text) => to_date(text),
        None => Ok(Value::Null),
    }
}

async fn list_tasks(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_TASKS, raw.as_deref())?;
    let search = q.text("search");
    let statuses = q
        .text("status")
        .map_or_else(|| json!([]), |status| json!(task_status_aliases(status)));
    let filters = json!({
        "search": search.map_or(Value::Null, |term| json!(format!("%{term}%"))),
        "number": search.and_then(number_search).map_or(Value::Null, Value::String),
        "projectId": crate::crud::text(&q, "projectId"),
        "status": crate::crud::text(&q, "status"),
        "statuses": statuses,
        "priority": crate::crud::text(&q, "priority"),
        "type": crate::crud::text(&q, "type"),
        "sprintId": crate::crud::text(&q, "sprintId"),
        "milestoneId": crate::crud::text(&q, "milestoneId"),
        "parentTaskId": crate::crud::text(&q, "parentTaskId"),
        "assigneeId": crate::crud::text(&q, "assigneeId"),
        "dueFrom": date_filter(&q, "dueDateFrom")?,
        "dueTo": date_filter(&q, "dueDateTo")?,
    });
    crate::crud::page(&caller.db, TASKS_LIST, &TASKS, &q, filters).await
}

async fn get_task(caller: Caller, Path(id): Path<String>) -> Answer {
    crate::crud::get_live(&caller.db, &TASKS, "Task", &id).await
}

/// `dependsOn` / `blocks` as `createTask`'s callers pass them.
fn link_input(body: &Map<String, Value>) -> LinkInput {
    let ids = |key: &str| -> Option<Vec<String>> {
        body.get(key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
    };
    LinkInput {
        depends_on: ids("dependsOn"),
        blocks: ids("blocks"),
    }
}

/// `parentTaskId` as a change: absent, null or an id.
fn parent_change(body: &Map<String, Value>) -> ParentChange {
    match body.get("parentTaskId") {
        None => ParentChange::Absent,
        Some(Value::String(id)) => ParentChange::Set(id.clone()),
        Some(_) => ParentChange::Null,
    }
}

/// `coerceDates`: `new Date(text)` of a task date, which throws for an
/// invalid one (an empty string too).
fn check_task_dates(data: &Map<String, Value>) -> Result<(), Fail> {
    for key in ["dueDate", "startDate"] {
        if let Some(Value::String(text)) = data.get(key)
            && js_date(text).is_none()
        {
            return Err(internal().into());
        }
    }
    Ok(())
}

fn task_event(row: &Value) -> Value {
    json!({ "id": field(row, "id"), "projectId": field(row, "projectId"), "title": field(row, "title") })
}

fn dependency_failure(failure: &DependencyFailure, id: &str) -> Fail {
    match failure {
        DependencyFailure::NotFound(_) => not_found("Task", id).into(),
        other => bad_request(other.message()).into(),
    }
}

async fn create_task_route(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_TASK, &headers, &body)?;
    let mut data = parsed.body.clone();
    let links = link_input(&data);
    let has_links = data.contains_key("dependsOn") || data.contains_key("blocks");
    data.remove("dependsOn");
    data.remove("blocks");
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(project) = &project_id {
        let live: Option<String> = sqlx::query_scalar(
            "select id from projects where id = $1 and deleted_at is null limit 1",
        )
        .bind(project)
        .fetch_optional(&caller.db)
        .await?;
        if live.is_none() {
            return Err(not_found("Project", project).into());
        }
    }
    if let Some(message) = validate_task_relations(
        &caller.db,
        None,
        None,
        Some(project_id.as_deref()),
        &parent_change(&data),
    )
    .await?
    {
        return Err(bad_request(message).into());
    }
    if has_links && let Some(failure) = check_new_task_links(&caller.db, &links).await? {
        return Err(bad_request(failure.message()).into());
    }
    check_task_dates(&data)?;
    let made = match create_task(
        &caller.db,
        &data,
        project_id.as_deref(),
        caller.session.actor(),
    )
    .await
    {
        Ok(made) => made,
        Err(CreateError::Database(error)) => return Err(error.into()),
        Err(CreateError::InvalidDate) => return Err(internal().into()),
    };
    let mut row = made.row;
    let id = field(&row, "id").as_str().unwrap_or_default().to_owned();
    if has_links {
        if let Some(failure) = link_created_task(&caller.db, &id, &links).await? {
            return Err(bad_request(failure.message()).into());
        }
        if let Some(linked) = TASKS.find_any(&caller.db, &id).await? {
            row = linked;
        }
    }
    caller.publish(&state.events, PROJECT_TASK_CREATED, &id, task_event(&row));
    created(row)
}

/// A task's project, parent, stage and status, as a PATCH checks them.
type TaskState = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The only `tasks` columns a PATCH writes.
const PATCHABLE_TASK_COLUMNS: [&str; 23] = [
    "title",
    "description",
    "status",
    "priority",
    "type",
    "stageId",
    "sprintId",
    "milestoneId",
    "parentTaskId",
    "assigneeId",
    "customerId",
    "contactId",
    "personId",
    "startDate",
    "dueDate",
    "estimatedHours",
    "duration",
    "storyPoints",
    "labels",
    "tags",
    "isBillable",
    "repeat",
    "customFields",
];

/// `syncAssigneeFields(update, data)`.
fn sync_assignees(update: &mut Map<String, Value>, data: &Map<String, Value>) {
    if let Some(ids) = data.get("assigneeIds") {
        let ids: Vec<Value> = ids.as_array().cloned().unwrap_or_default();
        let first = ids.first().cloned().unwrap_or(Value::Null);
        update.insert(
            "assigneeIds".into(),
            if ids.is_empty() {
                Value::Null
            } else {
                Value::Array(ids)
            },
        );
        update.insert("assigneeId".into(), first);
    } else if let Some(assignee) = data.get("assigneeId") {
        let truthy = assignee.as_str().is_some_and(|s| !s.is_empty());
        update.insert(
            "assigneeIds".into(),
            if truthy {
                json!([assignee])
            } else {
                Value::Null
            },
        );
    }
}

async fn update_task(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_TASK, &headers, &body)?;
    let body = &parsed.body;
    let existing: Option<TaskState> = sqlx::query_as(
        "select project_id, parent_task_id, stage_id, status from tasks
             where id = $1 and deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((project, parent_now, stage_now, status)) = existing else {
        return Err(not_found("Task", &id).into());
    };
    let sent_project = body.get("projectId").map(Value::as_str);
    if let Some(message) = validate_task_relations(
        &caller.db,
        Some((project.as_deref(), parent_now.as_deref())),
        Some(&id),
        sent_project,
        &parent_change(body),
    )
    .await?
    {
        return Err(bad_request(message).into());
    }
    let plan = if body.contains_key("dependsOn") || body.contains_key("blocks") {
        match plan_dependency_update(&caller.db, &id, &link_input(body), &LinkAccess::Unchecked)
            .await?
        {
            Ok(plan) => Some(plan),
            Err(failure) => return Err(dependency_failure(&failure, &id)),
        }
    } else {
        None
    };
    let mut date_props = vec!["updatedAt"];
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for key in PATCHABLE_TASK_COLUMNS {
        let Some(value) = body.get(key) else { continue };
        let value = match (key, value) {
            ("dueDate" | "startDate", Value::String(text)) => {
                date_props.push(key);
                to_date(text)?
            }
            _ => value.clone(),
        };
        update.insert(key.to_owned(), value);
    }
    sync_assignees(&mut update, body);
    let stage_sent = body.get("stageId").map(Value::as_str);
    let change = apply_status_change(
        &caller.db,
        project.as_deref(),
        stage_now.as_deref(),
        status.as_deref(),
        stage_sent,
        update
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
    )
    .await?;
    if let Some(next) = change.status {
        update.insert("status".into(), json!(next));
    }
    if let Some(stage_id) = change.stage_id {
        update.insert("stageId".into(), json!(stage_id));
    }
    if change.completes {
        update.insert("completedDate".into(), json!(now()));
        date_props.push("completedDate");
    }
    match plan {
        Some(plan) => {
            let mut tx = caller.db.begin().await?;
            write_dependency_rows(&mut tx, &id, &plan, &now()).await?;
            TASKS
                .patch(&mut *tx, &id, &update, true, &date_props)
                .await?;
            tx.commit().await?;
        }
        None => {
            TASKS
                .patch(&caller.db, &id, &update, true, &date_props)
                .await?;
        }
    }
    let row = TASKS
        .find_any(&caller.db, &id)
        .await?
        .ok_or_else(|| not_found("Task", &id))?;
    caller.publish(&state.events, PROJECT_TASK_UPDATED, &id, task_event(&row));
    ok(row)
}

async fn delete_task(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let removed = soft_delete_task_tree(&caller.db, &id)
        .await?
        .ok_or_else(|| not_found("Task", &id))?;
    for row in removed {
        caller.publish(
            &state.events,
            PROJECT_TASK_DELETED,
            &row.id,
            json!({ "id": row.id, "projectId": row.project_id, "title": row.title }),
        );
    }
    no_content()
}

// ---------------------------------------------------------------------------
// Time entries
// ---------------------------------------------------------------------------

const TIME_ENTRIES_LIST: (&str, &str) = table_list_sql!(
    time_entries,
    "t.deleted_at is null \
     and ($3->>'projectId' is null or t.project_id = $3->>'projectId') \
     and ($3->>'taskId' is null or t.task_id = $3->>'taskId') \
     and ($3->>'userId' is null or t.user_id = $3->>'userId') \
     and ($3->>'status' is null or t.status = $3->>'status') \
     and ($3->>'billable' is null or t.billable = ($3->>'billable')::boolean) \
     and ($3->>'fromDate' is null or t.date >= ($3->>'fromDate')::date) \
     and ($3->>'toDate' is null or t.date <= ($3->>'toDate')::date)"
);

async fn list_time_entries(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_TIME_ENTRIES, raw.as_deref())?;
    let filters = json!({
        "projectId": crate::crud::text(&q, "projectId"),
        "taskId": crate::crud::text(&q, "taskId"),
        "userId": crate::crud::text(&q, "userId"),
        "status": crate::crud::text(&q, "status"),
        "billable": crate::crud::flag(&q, "billable"),
        "fromDate": crate::crud::text(&q, "fromDate"),
        "toDate": crate::crud::text(&q, "toDate"),
    });
    crate::crud::page(&caller.db, TIME_ENTRIES_LIST, &TIME_ENTRIES, &q, filters).await
}

async fn get_time_entry(caller: Caller, Path(id): Path<String>) -> Answer {
    crate::crud::get_live(&caller.db, &TIME_ENTRIES, "TimeEntry", &id).await
}

/// `String(value)` of a string or a number.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => weldsuite_core_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        other => other.to_string(),
    }
}

/// `computeCost(rate, duration)`: `String((duration / 60) * rate)`, or null.
fn compute_cost(rate: Option<&Value>, duration: Option<&Value>) -> Value {
    let number = |value: Option<&Value>| -> Option<f64> {
        match value? {
            Value::Null => None,
            Value::Number(n) => n.as_f64(),
            Value::String(text) => Some(weldsuite_kit::validation::js_number(text)),
            _ => Some(f64::NAN),
        }
    };
    let (Some(rate), Some(duration)) = (number(rate), number(duration)) else {
        return Value::Null;
    };
    if !rate.is_finite() || !duration.is_finite() {
        return Value::Null;
    }
    json!(weldsuite_core_domain::js::number_text(
        (duration / 60.0) * rate
    ))
}

/// `value ? new Date(value) : null`.
fn date_or_null(value: Option<&Value>) -> Result<Value, Fail> {
    match value.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(text) => to_date(text),
        None => Ok(Value::Null),
    }
}

fn time_entry_event(id: &str, row: &Value, user: &Value) -> Value {
    let duration = match row.get("duration") {
        Some(Value::String(text)) => {
            weldsuite_core_domain::js::number_value(weldsuite_kit::validation::js_number(text))
        }
        Some(Value::Number(n)) => Value::Number(n.clone()),
        _ => json!(0),
    };
    json!({
        "id": id,
        "projectId": field(row, "projectId"),
        "taskId": field(row, "taskId"),
        "userId": user,
        "duration": duration,
    })
}

async fn create_time_entry(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_TIME_ENTRY, &headers, &body)?;
    let body = &parsed.body;
    let user = caller
        .session
        .user_id
        .clone()
        .or_else(|| {
            body.get("userId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|u| !u.is_empty());
    let Some(user) = user else {
        return Err(bad_request("userId is required for workspace API keys").into());
    };
    let stamp = now();
    let id = generate_id("te");
    let or_null = |key: &str| match body.get(key) {
        Some(Value::Null) | None => Value::Null,
        Some(value) => value.clone(),
    };
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("projectId".into(), or_null("projectId"));
    values.insert("taskId".into(), or_null("taskId"));
    values.insert("userId".into(), json!(user));
    values.insert("date".into(), or_null("date"));
    values.insert(
        "duration".into(),
        json!(js_string(body.get("duration").unwrap_or(&Value::Null))),
    );
    values.insert("description".into(), or_null("description"));
    values.insert("activity".into(), or_null("activity"));
    values.insert(
        "billable".into(),
        body.get("billable").cloned().unwrap_or(json!(true)),
    );
    values.insert(
        "rate".into(),
        body.get("rate")
            .map_or(Value::Null, |rate| json!(js_string(rate))),
    );
    values.insert(
        "cost".into(),
        compute_cost(body.get("rate"), body.get("duration")),
    );
    values.insert("startTime".into(), date_or_null(body.get("startTime"))?);
    values.insert("endTime".into(), date_or_null(body.get("endTime"))?);
    values.insert("location".into(), or_null("location"));
    values.insert(
        "isRemote".into(),
        body.get("isRemote").cloned().unwrap_or(json!(false)),
    );
    values.insert("status".into(), json!("draft"));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = TIME_ENTRIES
        .insert(
            &caller.db,
            &values,
            &["startTime", "endTime", "createdAt", "updatedAt"],
        )
        .await?;
    caller.publish(
        &state.events,
        PROJECT_TIME_ENTRY_CREATED,
        &id,
        time_entry_event(&id, &row, &json!(user)),
    );
    created(row)
}

const PLAIN_UPDATE_FIELDS: [&str; 8] = [
    "date",
    "description",
    "activity",
    "billable",
    "location",
    "isRemote",
    "taskId",
    "projectId",
];

async fn update_time_entry(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_TIME_ENTRY, &headers, &body)?;
    let body = &parsed.body;
    let existing = live_or_404(&caller.db, &TIME_ENTRIES, "TimeEntry", &id).await?;
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for key in PLAIN_UPDATE_FIELDS {
        if let Some(value) = body.get(key) {
            update.insert(key.into(), value.clone());
        }
    }
    if let Some(duration) = body.get("duration") {
        update.insert("duration".into(), json!(js_string(duration)));
    }
    if let Some(rate) = body.get("rate") {
        let rate = if rate.is_null() {
            Value::Null
        } else {
            json!(js_string(rate))
        };
        update.insert("rate".into(), rate);
    }
    if body.contains_key("startTime") {
        update.insert("startTime".into(), date_or_null(body.get("startTime"))?);
    }
    if body.contains_key("endTime") {
        update.insert("endTime".into(), date_or_null(body.get("endTime"))?);
    }
    if body.contains_key("rate") || body.contains_key("duration") {
        let pick = |key: &str| match body.get(key) {
            Some(Value::Null) | None => existing.get(key).cloned(),
            Some(value) => Some(value.clone()),
        };
        update.insert(
            "cost".into(),
            compute_cost(pick("rate").as_ref(), pick("duration").as_ref()),
        );
    }
    let row = TIME_ENTRIES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt", "startTime", "endTime"]),
        )
        .await?
        .ok_or_else(|| internal_with("Failed to update time entry"))?;
    let user = field(&row, "userId");
    caller.publish(
        &state.events,
        PROJECT_TIME_ENTRY_UPDATED,
        &id,
        time_entry_event(&id, &row, &user),
    );
    ok(row)
}

async fn delete_time_entry(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let row = soft_delete(&caller.db, &TIME_ENTRIES, &id)
        .await?
        .ok_or_else(|| not_found("TimeEntry", &id))?;
    let user = field(&row, "userId");
    caller.publish(
        &state.events,
        PROJECT_TIME_ENTRY_DELETED,
        &id,
        time_entry_event(&id, &row, &user),
    );
    no_content()
}

/// The rows of a decorated list (`list_rows` then [`decorate`]).
pub(crate) async fn decorated_page(
    caller: &Caller,
    spec: &Simple,
    parsed: &zod::Parsed,
    filters: Value,
) -> Answer {
    let mut page = list_rows(&caller.db, spec.sql, &list_query(parsed), &filters).await?;
    let rows = page
        .rows
        .into_iter()
        .map(|row| spec.table.js(row))
        .collect();
    page.rows = decorate(&caller.db, spec.stats, rows).await?;
    Ok(page.respond())
}
