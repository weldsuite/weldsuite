//! The task writes of `/api/tasks` (`routes/tasks/index.ts`): create
//! (global and in a project), PATCH, status, toggle, position and
//! dependencies. Each keeps the task's stage, its calendar block, its
//! completion (the `completed` event, a repeating task's next occurrence)
//! and its dependency links in step, as TypeScript does.

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

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_TASK_COMPLETED, PROJECT_TASK_CREATED, PROJECT_TASK_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::js::millis_of;
use weldsuite_flow_domain::recurrence::is_completion;
use weldsuite_flow_domain::stage::{apply_status_change, normalize_task_status, stage_for_status};
use weldsuite_flow_domain::task_dependencies::{
    DependencyFailure, DependencyPlan, LinkAccess, LinkInput, ParentChange, parent_error,
    plan_dependency_update, write_dependency_rows,
};
use weldsuite_flow_domain::task_relations::{
    TaskReferences, changed_task_references, find_invalid_task_reference,
};
use weldsuite_flow_domain::tasks::{CreateError, create_next_occurrence, create_task};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data};

use crate::calendar::{REPLAN_KIND, TaskCalendar, TaskEvent};
use crate::js::{Js, parse_body};
use crate::task_changes::{Update, assignee_ids_involved, build_task_changes};
use crate::task_enrich::{TASK_ENTITY, assignee_names, enrich};
use crate::tasks::{PROJECT_WRITE_DENIED, guard_write, task_row};
use crate::{Caller, FlowState, Refusal, Reply, custom_values, now, reply, validate};

/// `isTerminalStatus`.
fn terminal(status: Option<&str>) -> bool {
    matches!(status, Some("done" | "cancelled"))
}

fn text_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

impl From<CreateError> for Refusal {
    fn from(error: CreateError) -> Self {
        match error {
            CreateError::Database(error) => Self::Database(error),
            CreateError::InvalidDate => Self::Internal("Invalid time value".to_owned()),
        }
    }
}

// ── Bodies ──────────────────────────────────────────────────────────────────

const REPEAT_FREQUENCIES: [&str; 6] =
    ["daily", "weekly", "biweekly", "monthly", "yearly", "custom"];
const REPEAT_UNITS: [&str; 4] = ["days", "weeks", "months", "years"];

/// A read field into the ordered body (`undefined` stays out).
fn put(data: &mut Update, key: &str, field: Field<Js>) {
    match field {
        Field::Set(value) => data.set(key, value),
        Field::Null => data.set(key, Js::Null),
        Field::Absent => {}
    }
}

fn string(field: Field<String>) -> Field<Js> {
    match field {
        Field::Set(text) => Field::Set(Js::String(text)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

fn text(
    issues: &mut Issues,
    f: &Map<String, Value>,
    key: &str,
    presence: Presence,
    max: Option<usize>,
) -> Field<Js> {
    string(issues.text(f, key, presence, None, max))
}

fn strings(
    issues: &mut Issues,
    f: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<Js> {
    match issues.list(f, key, presence, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    }) {
        Field::Set(items) => Field::Set(Js::Array(items.into_iter().map(Js::String).collect())),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

fn number(
    issues: &mut Issues,
    f: &Map<String, Value>,
    key: &str,
    presence: Presence,
    int: bool,
) -> Field<Js> {
    let rules = Number {
        int,
        ..Number::default()
    };
    match issues.number(f, key, presence, rules) {
        Field::Set(n) => Field::Set(Js::Number(n)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `taskStatusSchema`: a string of at most 30, normalised.
fn status_text(issues: &mut Issues, f: &Map<String, Value>, presence: Presence) -> Field<Js> {
    match issues.text(f, "status", presence, None, Some(30)) {
        Field::Set(status) => Field::Set(Js::String(normalize_task_status(&status))),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `repeatSchema.nullable().optional()`, its keys in the schema's order.
fn repeat(issues: &mut Issues, f: &Map<String, Value>) -> Field<Js> {
    issues.nested(f, "repeat", Presence::Nullish, |issues, r| {
        let mut out = Vec::new();
        if let Some(frequency) = issues
            .choice(r, "frequency", Presence::Required, &REPEAT_FREQUENCIES)
            .into_option()
        {
            out.push(("frequency".to_owned(), Js::String(frequency)));
        }
        if let Field::Set(interval) =
            issues.number(r, "interval", Presence::Optional, Number::default())
        {
            out.push(("interval".to_owned(), Js::Number(interval)));
        }
        if let Some(unit) = issues
            .choice(r, "unit", Presence::Optional, &REPEAT_UNITS)
            .into_option()
        {
            out.push(("unit".to_owned(), Js::String(unit)));
        }
        Js::Object(out)
    })
}

/// `z.record(z.any()).nullable().optional()`, in the body's key order.
fn record(issues: &mut Issues, f: &Map<String, Value>, key: &str, raw: &Js) -> Field<Js> {
    match issues.nested(f, key, Presence::Nullish, |_, _| ()) {
        Field::Set(()) => Field::Set(raw.get(key).cloned().unwrap_or(Js::Null)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `createTaskSchema` (`.passthrough()`: the extra keys are never read).
fn read_create(issues: &mut Issues, f: &Map<String, Value>, raw: &Js) -> Update {
    let mut d = Update::default();
    let nullish = Presence::Nullish;
    let optional = Presence::Optional;
    put(
        &mut d,
        "title",
        string(issues.text(f, "title", Presence::Required, Some(1), Some(500))),
    );
    put(
        &mut d,
        "description",
        text(issues, f, "description", optional, None),
    );
    for key in [
        "projectId",
        "sprintId",
        "milestoneId",
        "parentTaskId",
        "stageId",
        "assigneeId",
    ] {
        let field = text(issues, f, key, nullish, None);
        put(&mut d, key, field);
    }
    let assignees = strings(issues, f, "assigneeIds", optional);
    put(&mut d, "assigneeIds", assignees);
    let reporter = text(issues, f, "reporterId", nullish, None);
    put(&mut d, "reporterId", reporter);
    let status = status_text(issues, f, optional);
    put(&mut d, "status", status);
    let priority = text(issues, f, "priority", optional, Some(20));
    put(&mut d, "priority", priority);
    let kind = text(issues, f, "type", optional, Some(50));
    put(&mut d, "type", kind);
    let due = text(issues, f, "dueDate", optional, None);
    put(&mut d, "dueDate", due);
    let start = text(issues, f, "startDate", optional, None);
    put(&mut d, "startDate", start);
    let estimate = number(issues, f, "estimateMinutes", optional, true);
    put(&mut d, "estimateMinutes", estimate);
    let hours = text(issues, f, "estimatedHours", optional, None);
    put(&mut d, "estimatedHours", hours);
    let duration = number(issues, f, "duration", optional, false);
    put(&mut d, "duration", duration);
    let points = number(issues, f, "storyPoints", optional, false);
    put(&mut d, "storyPoints", points);
    for key in ["labels", "tags"] {
        let field = strings(issues, f, key, optional);
        put(&mut d, key, field);
    }
    for key in ["customerId", "contactId", "personId"] {
        let field = text(issues, f, key, nullish, None);
        put(&mut d, key, field);
    }
    let billable = match issues.boolean(f, "isBillable", optional) {
        Field::Set(flag) => Field::Set(Js::Bool(flag)),
        _ => Field::Absent,
    };
    put(&mut d, "isBillable", billable);
    for key in ["dependsOn", "blocks"] {
        let field = strings(issues, f, key, optional);
        put(&mut d, key, field);
    }
    let repeat = repeat(issues, f);
    put(&mut d, "repeat", repeat);
    let custom = record(issues, f, "customFields", raw);
    put(&mut d, "customFields", custom);
    d
}

/// `updateTaskSchema` (unknown keys stripped).
fn read_update(issues: &mut Issues, f: &Map<String, Value>, raw: &Js) -> Update {
    let mut d = Update::default();
    let nullish = Presence::Nullish;
    let optional = Presence::Optional;
    put(
        &mut d,
        "title",
        string(issues.text(f, "title", optional, Some(1), Some(500))),
    );
    let description = text(issues, f, "description", nullish, None);
    put(&mut d, "description", description);
    let status = status_text(issues, f, optional);
    put(&mut d, "status", status);
    let priority = text(issues, f, "priority", optional, Some(20));
    put(&mut d, "priority", priority);
    let kind = text(issues, f, "type", optional, Some(50));
    put(&mut d, "type", kind);
    for key in [
        "stageId",
        "sprintId",
        "milestoneId",
        "parentTaskId",
        "assigneeId",
    ] {
        let field = text(issues, f, key, nullish, None);
        put(&mut d, key, field);
    }
    let assignees = strings(issues, f, "assigneeIds", nullish);
    put(&mut d, "assigneeIds", assignees);
    for key in [
        "customerId",
        "contactId",
        "personId",
        "startDate",
        "dueDate",
        "estimatedHours",
    ] {
        let field = text(issues, f, key, nullish, None);
        put(&mut d, key, field);
    }
    let duration = number(issues, f, "duration", nullish, false);
    put(&mut d, "duration", duration);
    let points = number(issues, f, "storyPoints", nullish, false);
    put(&mut d, "storyPoints", points);
    for key in ["labels", "tags"] {
        let field = strings(issues, f, key, optional);
        put(&mut d, key, field);
    }
    let billable = match issues.boolean(f, "isBillable", optional) {
        Field::Set(flag) => Field::Set(Js::Bool(flag)),
        _ => Field::Absent,
    };
    put(&mut d, "isBillable", billable);
    let repeat = repeat(issues, f);
    put(&mut d, "repeat", repeat);
    let custom = record(issues, f, "customFields", raw);
    put(&mut d, "customFields", custom);
    let project = text(issues, f, "projectId", nullish, None);
    put(&mut d, "projectId", project);
    for key in ["dependsOn", "blocks"] {
        let field = strings(issues, f, key, optional);
        put(&mut d, key, field);
    }
    d
}

fn js_text<'a>(data: &'a Update, key: &str) -> Option<&'a str> {
    match data.get(key) {
        Some(Js::String(text)) => Some(text),
        _ => None,
    }
}

fn js_list(data: &Update, key: &str) -> Option<Vec<String>> {
    match data.get(key) {
        Some(Js::Array(items)) => Some(
            items
                .iter()
                .map(|item| match item {
                    Js::String(text) => text.clone(),
                    other => crate::js::js_string(other),
                })
                .collect(),
        ),
        _ => None,
    }
}

/// The references a body names (`null` and empty are unset).
fn references(data: &Update, with_parent: bool) -> TaskReferences {
    let get = |key: &str| js_text(data, key).map(str::to_owned);
    TaskReferences {
        sprint_id: get("sprintId"),
        milestone_id: get("milestoneId"),
        stage_id: get("stageId"),
        parent_task_id: if with_parent {
            get("parentTaskId")
        } else {
            None
        },
    }
}

fn row_references(row: &Value) -> TaskReferences {
    let get = |key: &str| text_of(row, key).map(str::to_owned);
    TaskReferences {
        sprint_id: get("sprintId"),
        milestone_id: get("milestoneId"),
        stage_id: get("stageId"),
        parent_task_id: get("parentTaskId"),
    }
}

// ── Background work ─────────────────────────────────────────────────────────

/// What background calendar work needs from the request.
#[derive(Clone)]
struct Background {
    db: PgPool,
    master: Option<PgPool>,
    workspace_id: String,
    calendar: Arc<dyn TaskCalendar>,
    state: FlowState,
}

impl Background {
    fn of(state: &FlowState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            master: caller.master(state),
            workspace_id: caller.workspace_id.clone(),
            calendar: Arc::clone(&state.calendar),
            state: state.clone(),
        }
    }

    /// `syncReplanDue`: point the calendar's nightly re-plan at the
    /// workspace's next auto-placed block.
    async fn sync_replan_due(&self) {
        let Some(master) = &self.master else {
            return;
        };
        let calendar = Arc::clone(&self.calendar);
        let db = self.db.clone();
        weldsuite_db::due_index::sync_due(master, REPLAN_KIND, &self.workspace_id, || async move {
            calendar.next_replan_at(&db).await
        })
        .await;
    }

    fn spawn(&self, work: impl Future<Output = ()> + Send + 'static) {
        self.state.events.tracker().spawn(work);
    }

    fn cancel(&self, event_id: String) {
        let this = self.clone();
        self.spawn(async move {
            if let Err(error) = this.calendar.cancel(&this.db, &event_id).await {
                tracing::error!(error, "[app-api/tasks] calendar cancel failed");
            }
        });
    }

    fn confirm(&self, event_id: String) {
        let this = self.clone();
        self.spawn(async move {
            match this.calendar.confirm(&this.db, &event_id).await {
                Ok(()) => this.sync_replan_due().await,
                Err(error) => tracing::error!(error, "[app-api/tasks] calendar confirm failed"),
            }
        });
    }

    /// `syncCalendarOnStatusChange`.
    fn on_status_change(&self, event_id: &str, old: Option<&str>, new: Option<&str>) {
        if !terminal(old) && terminal(new) {
            self.cancel(event_id.to_owned());
        } else if terminal(old) && !terminal(new) {
            self.confirm(event_id.to_owned());
        }
    }

    /// Place a block for a task that has none, and link it.
    fn place(&self, event: TaskEvent, label: &'static str, link_none: bool) {
        let this = self.clone();
        self.spawn(async move {
            match this.calendar.create_for_task(&this.db, &event).await {
                Ok(None) if !link_none => {}
                Ok(placed) => {
                    if let Err(error) =
                        link_event(&this.db, &event.task_id, placed.as_deref()).await
                    {
                        tracing::error!(%error, "[app-api/tasks] {label} failed");
                        return;
                    }
                    this.sync_replan_due().await;
                }
                Err(error) => tracing::error!(error, "[app-api/tasks] {label} failed"),
            }
        });
    }

    fn reschedule(&self, event_id: String, event: TaskEvent, label: &'static str) {
        let this = self.clone();
        self.spawn(async move {
            match this.calendar.reschedule(&this.db, &event_id, &event).await {
                Ok(placed) => {
                    if let Err(error) =
                        link_event(&this.db, &event.task_id, placed.as_deref()).await
                    {
                        tracing::error!(%error, "[app-api/tasks] {label} failed");
                        return;
                    }
                    this.sync_replan_due().await;
                }
                Err(error) => tracing::error!(error, "[app-api/tasks] {label} failed"),
            }
        });
    }
}

/// `update(tasks).set({ calendarEventId })`.
async fn link_event(db: &PgPool, task_id: &str, event_id: Option<&str>) -> Result<(), sqlx::Error> {
    sqlx::query("update tasks set calendar_event_id = $2 where id = $1")
        .bind(task_id)
        .bind(event_id)
        .execute(db)
        .await
        .map(|_| ())
}

fn millis(row: &Value, key: &str) -> Option<i64> {
    text_of(row, key)
        .filter(|d| !d.is_empty())
        .and_then(millis_of)
}

/// The calendar block of a task row.
fn task_event(user_id: &str, row: &Value) -> TaskEvent {
    TaskEvent {
        user_id: user_id.to_owned(),
        task_id: text_of(row, "id").unwrap_or_default().to_owned(),
        title: text_of(row, "title").unwrap_or_default().to_owned(),
        description: text_of(row, "description").map(str::to_owned),
        due_date: millis(row, "dueDate"),
        start_date: millis(row, "startDate"),
        duration_minutes: row.get("duration").and_then(Value::as_f64),
        priority: text_of(row, "priority").map(str::to_owned),
    }
}

// ── Completion ──────────────────────────────────────────────────────────────

/// `announceNextOccurrence`: the new occurrence gets its calendar block,
/// the `created` event and its assignees' notifications.
fn announce_next(state: &FlowState, caller: &Caller, row: &Value) {
    let background = Background::of(state, caller);
    background.place(
        task_event(&caller.user_id, row),
        "recurrence calendar event",
        false,
    );
    let project = row.get("projectId").cloned().unwrap_or(Value::Null);
    caller.publish(
        state,
        PROJECT_TASK_CREATED,
        text_of(row, "id").unwrap_or_default(),
        &task_analytics_payload(row, &json!({ "projectId": project }), crate::now_ms()),
    );
    crate::notify::assignment(
        state,
        caller,
        crate::notify::Assignment {
            assignee_ids: assignee_ids_of(row),
            task_id: text_of(row, "id").unwrap_or_default().to_owned(),
            task_title: text_of(row, "title").unwrap_or_default().to_owned(),
            project_id: text_of(row, "projectId").map(str::to_owned),
        },
    );
}

/// `assigneeIdsOf(row)`: the assignee list, else the single assignee.
fn assignee_ids_of(row: &Value) -> Vec<String> {
    let ids: Vec<String> = row
        .get("assigneeIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !ids.is_empty() {
        return ids;
    }
    text_of(row, "assigneeId")
        .filter(|id| !id.is_empty())
        .map(|id| vec![id.to_owned()])
        .unwrap_or_default()
}

/// `newlyAddedAssignees(existing, update)`: the assignees a PATCH adds.
fn newly_added_assignees(task: &Value, update: &Update) -> Vec<String> {
    let strings = |ids: &[Js]| -> Vec<String> {
        ids.iter()
            .filter_map(|id| match id {
                Js::String(id) => Some(id.clone()),
                _ => None,
            })
            .collect()
    };
    let old: Vec<String> = match task.get("assigneeIds") {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => text_of(task, "assigneeId")
            .filter(|id| !id.is_empty())
            .map(|id| vec![id.to_owned()])
            .unwrap_or_default(),
    };
    let new: Vec<String> = match (update.get("assigneeIds"), update.get("assigneeId")) {
        (Some(Js::Array(ids)), _) => strings(ids),
        (_, Some(Js::String(id))) if !id.is_empty() => vec![id.clone()],
        _ => old.clone(),
    };
    new.into_iter().filter(|id| !old.contains(id)).collect()
}

/// `handleTaskCompletion`: the `completed` event and, for a repeating
/// task, its next occurrence. `after` is the task once the change is
/// written. The new occurrence's id, if one was created.
async fn handle_completion(
    state: &FlowState,
    caller: &Caller,
    completed: bool,
    after: &Map<String, Value>,
) -> Result<Option<String>, Refusal> {
    if !completed {
        return Ok(None);
    }
    let after_value = Value::Object(after.clone());
    let id = text_of(&after_value, "id").unwrap_or_default().to_owned();
    caller.publish(
        state,
        PROJECT_TASK_COMPLETED,
        &id,
        &task_analytics_payload(&after_value, &json!({ "status": "done" }), crate::now_ms()),
    );
    if !weldsuite_flow_domain::js::truthy(after.get("repeat")) {
        return Ok(None);
    }
    let Some(next) = create_next_occurrence(&caller.db, after, crate::now_ms()).await? else {
        return Ok(None);
    };
    let next_id = text_of(&next, "id").unwrap_or_default().to_owned();
    custom_values::sync_values_for_entity(
        &caller.db,
        TASK_ENTITY,
        &next_id,
        after.get("customFields").map(Js::from_jsonb).as_ref(),
    )
    .await;
    announce_next(state, caller, &next);
    Ok(Some(next_id))
}

/// `writeTaskChange`: the status / position change, and whether this
/// write completed the task (one of any number of concurrent ones).
async fn write_task_change(
    db: &PgPool,
    id: &str,
    update: &Update,
    before: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let status = js_text(update, "status");
    if !is_completion(before, status) {
        write_columns(db, id, update, false).await?;
        return Ok(false);
    }
    if write_columns(db, id, update, true).await? {
        return Ok(true);
    }
    let mut rest = update.clone();
    rest.remove("status");
    rest.remove("completedDate");
    rest.remove("stageId");
    write_columns(db, id, &rest, false).await?;
    Ok(false)
}

/// The columns of `update` on the live task; `claim` writes only when the
/// task is not done yet. Whether a row was written.
async fn write_columns(
    db: &PgPool,
    id: &str,
    update: &Update,
    claim: bool,
) -> Result<bool, sqlx::Error> {
    write_columns_on(db, id, update, claim).await
}

async fn write_columns_on<'e>(
    db: impl sqlx::PgExecutor<'e>,
    id: &str,
    update: &Update,
    claim: bool,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(concat!(
        "update tasks set ",
        set_text!("title", "title"),
        ", ",
        set_text!("description", "description"),
        ", ",
        set_text!("status", "status"),
        ", ",
        set_text!("priority", "priority"),
        ", ",
        set_text!("type", "type"),
        ", ",
        set_text!("stageId", "stage_id"),
        ", ",
        set_text!("sprintId", "sprint_id"),
        ", ",
        set_text!("milestoneId", "milestone_id"),
        ", ",
        set_text!("parentTaskId", "parent_task_id"),
        ", ",
        set_text!("assigneeId", "assignee_id"),
        ", ",
        set_text!("customerId", "customer_id"),
        ", ",
        set_text!("contactId", "contact_id"),
        ", ",
        set_text!("personId", "person_id"),
        ", ",
        set_ts!("startDate", "start_date"),
        ", ",
        set_ts!("dueDate", "due_date"),
        ", ",
        set_ts!("completedDate", "completed_date"),
        ", ",
        set_num!("estimatedHours", "estimated_hours"),
        ", ",
        set_int!("duration", "duration"),
        ", ",
        set_int!("storyPoints", "story_points"),
        ", ",
        set_int!("position", "position"),
        ", ",
        set_int!("boardPosition", "board_position"),
        ", ",
        set_json!("labels", "labels"),
        ", ",
        set_json!("tags", "tags"),
        ", ",
        set_bool!("isBillable", "is_billable"),
        ", ",
        set_json!("repeat", "repeat"),
        ", ",
        set_json!("customFields", "custom_fields"),
        ", ",
        set_json!("assigneeIds", "assignee_ids"),
        ", updated_at = $2::timestamp",
        " where id = $3 and deleted_at is null",
        " and ($4::bool is not true or status is distinct from 'done')"
    ))
    .bind(update.to_value())
    .bind(now())
    .bind(id)
    .bind(claim)
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

// ── POST / and POST /projects/:projectId ────────────────────────────────────

pub(crate) async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = parse_body(&body);
    let data = match validate(&headers, &body, |issues, f| read_create(issues, f, &raw)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let result = async {
        let project_id = js_text(&data, "projectId").map(str::to_owned);
        if let Some(project_id) = project_id.as_deref().filter(|p| !p.is_empty())
            && !caller.can_write(project_id).await?
        {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        create_with(&state, &caller, &data, project_id).await
    }
    .await;
    reply(result, "Failed to create task")
}

pub(crate) async fn create_in_project(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = parse_body(&body);
    let data = match validate(&headers, &body, |issues, f| read_create(issues, f, &raw)) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid body"),
    };
    match caller.can_write(&project_id).await {
        Ok(true) => {}
        Ok(false) => return crate::forbidden(PROJECT_WRITE_DENIED),
        Err(error) => return crate::outside(Err(error.into())),
    }
    reply(
        create_with(&state, &caller, &data, Some(project_id)).await,
        "Failed to create task",
    )
}

async fn create_with(
    state: &FlowState,
    caller: &Caller,
    data: &Update,
    project_id: Option<String>,
) -> Reply {
    let db = &caller.db;
    if let Some(message) =
        find_invalid_task_reference(db, project_id.as_deref(), &references(data, true)).await?
    {
        return Err(Refusal::bad_request(message));
    }
    let fields = match data.to_value() {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    let created = create_task(db, &fields, project_id.as_deref(), &caller.user_id).await?;
    let id = text_of(&created.row, "id").unwrap_or_default().to_owned();
    custom_values::sync_values_for_entity(db, TASK_ENTITY, &id, data.get("customFields")).await;

    // Placed synchronously, so a failure shows in the logs of the create.
    let background = Background::of(state, caller);
    match state
        .calendar
        .create_for_task(db, &task_event(&caller.user_id, &created.row))
        .await
    {
        Ok(Some(event_id)) => match link_event(db, &id, Some(&event_id)).await {
            Ok(()) => background.sync_replan_due().await,
            Err(error) => {
                tracing::error!(%error, "[app-api/tasks] calendar auto-schedule failed");
            }
        },
        Ok(None) => {}
        Err(error) => tracing::error!(error, "[app-api/tasks] calendar auto-schedule failed"),
    }

    caller.publish(
        state,
        PROJECT_TASK_CREATED,
        &id,
        &task_analytics_payload(
            &created.row,
            &json!({ "projectId": project_id }),
            crate::now_ms(),
        ),
    );
    crate::notify::assignment(
        state,
        caller,
        crate::notify::Assignment {
            assignee_ids: created.assignee_ids.clone(),
            task_id: id.clone(),
            task_title: text_of(&created.row, "title")
                .unwrap_or_default()
                .to_owned(),
            project_id: project_id.clone(),
        },
    );
    let enriched = enrich(state, db, vec![created.row]).await?;
    Ok(Created(enriched.into_iter().next().unwrap_or(Value::Null)).into_response())
}

// ── PATCH /:id/toggle, /:id/status, /:id/position ───────────────────────────

/// A status-only change's columns: the status, the completion stamp and
/// the stage that goes with it.
async fn status_update(
    db: &PgPool,
    task: &Value,
    status: &str,
) -> Result<(Update, Option<String>), sqlx::Error> {
    let mut update = Update::default();
    update.set("status", Js::String(status.to_owned()));
    if status == "done" {
        update.set("completedDate", Js::String(now()));
    }
    let stage = stage_for_status(
        db,
        text_of(task, "projectId"),
        text_of(task, "stageId"),
        status,
    )
    .await?;
    if let Some(stage) = &stage {
        update.set("stageId", Js::String(stage.clone()));
    }
    Ok((update, stage))
}

/// `{ ...currentTask, ...update }`.
fn merged(task: &Value, update: &Update) -> Map<String, Value> {
    let mut after = task.as_object().cloned().unwrap_or_default();
    for (key, value) in &update.0 {
        after.insert(key.clone(), value.to_value());
    }
    after
}

fn status_reply(
    id: &str,
    status: &str,
    stage: Option<String>,
    task: &Value,
    next: Option<String>,
) -> Response {
    let mut body = json!({
        "id": id,
        "status": status,
        "stageId": stage.map_or_else(|| task.get("stageId").cloned().unwrap_or(Value::Null), Value::String),
    });
    if let Some(next) = next {
        body["nextTaskId"] = Value::String(next);
    }
    Data(body).into_response()
}

pub(crate) async fn toggle(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (current, wanted) = match validate(&headers, &body, |issues, f| {
        let current = issues
            .text(f, "currentStatus", Presence::Optional, None, None)
            .into_option();
        let wanted = match status_text(issues, f, Presence::Optional) {
            Field::Set(Js::String(status)) => Some(status),
            _ => None,
        };
        (current, wanted)
    }) {
        Ok(read) => read,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let db = &caller.db;
        let Some(task) = task_row(db, &id).await? else {
            return Err(Refusal::not_found("Task", &id));
        };
        let new_status = wanted.filter(|s| !s.is_empty()).unwrap_or_else(|| {
            if current.as_deref() == Some("done") {
                "todo"
            } else {
                "done"
            }
            .to_owned()
        });
        let (update, stage) = status_update(db, &task, &new_status).await?;
        let before = text_of(&task, "status");
        let completed = write_task_change(db, &id, &update, before).await?;
        if let Some(event_id) = text_of(&task, "calendarEventId").filter(|e| !e.is_empty()) {
            let background = Background::of(&state, &caller);
            if terminal(Some(&new_status)) {
                background.cancel(event_id.to_owned());
            } else if terminal(before) {
                background.confirm(event_id.to_owned());
            }
        }
        let next = handle_completion(&state, &caller, completed, &merged(&task, &update)).await?;
        publish_updated(
            &state,
            &caller,
            &id,
            &task,
            &json!({ "status": new_status }),
            &update,
        );
        Ok(status_reply(&id, &new_status, stage, &task, next))
    }
    .await;
    reply(result, "Failed to toggle task")
}

/// The `updated` event of a status-only change.
fn publish_updated(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    task: &Value,
    overrides: &Value,
    update: &Update,
) {
    let changes = build_task_changes(task, update, &std::collections::HashMap::new());
    caller.publish_changes(
        state,
        PROJECT_TASK_UPDATED,
        id,
        task_analytics_payload(task, overrides, crate::now_ms()),
        changes,
    );
}

pub(crate) async fn status(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let wanted = match validate(&headers, &body, |issues, f| match status_field(issues, f) {
        Field::Set(Js::String(status)) => status,
        _ => String::new(),
    }) {
        Ok(wanted) => wanted,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let db = &caller.db;
        let Some(task) = task_row(db, &id).await? else {
            return Err(Refusal::not_found("Task", &id));
        };
        let (update, stage) = status_update(db, &task, &wanted).await?;
        let before = text_of(&task, "status");
        let completed = write_task_change(db, &id, &update, before).await?;
        if let Some(event_id) = text_of(&task, "calendarEventId").filter(|e| !e.is_empty()) {
            Background::of(&state, &caller).on_status_change(event_id, before, Some(&wanted));
        }
        let next = handle_completion(&state, &caller, completed, &merged(&task, &update)).await?;
        publish_updated(
            &state,
            &caller,
            &id,
            &task,
            &json!({ "status": wanted }),
            &update,
        );
        Ok(status_reply(&id, &wanted, stage, &task, next))
    }
    .await;
    reply(result, "Failed to update task status")
}

/// `taskStatusSchema`, required.
fn status_field(issues: &mut Issues, f: &Map<String, Value>) -> Field<Js> {
    status_text(issues, f, Presence::Required)
}

pub(crate) async fn position(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = match validate(&headers, &body, |issues, f| {
        let position = issues
            .number(f, "position", Presence::Optional, Number::default())
            .into_option();
        let board = issues
            .number(f, "boardPosition", Presence::Optional, Number::default())
            .into_option();
        let wanted = match status_text(issues, f, Presence::Optional) {
            Field::Set(Js::String(status)) => Some(status),
            _ => None,
        };
        (position, board, wanted)
    }) {
        Ok(read) => read,
        Err(refused) => return refused.respond("Invalid body"),
    };
    let (position, board, wanted) = read;
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let db = &caller.db;
        let Some(task) = task_row(db, &id).await? else {
            return Err(Refusal::not_found("Task", &id));
        };
        let sent_status = wanted.clone();
        let wanted = wanted.filter(|s| !s.is_empty());
        let mut update = Update::default();
        if let Some(position) = position {
            update.set("position", Js::Number(position));
        }
        if let Some(board) = board {
            update.set("boardPosition", Js::Number(board));
        }
        if let Some(wanted) = &wanted {
            update.set("status", Js::String(wanted.clone()));
            if wanted == "done" {
                update.set("completedDate", Js::String(now()));
            }
            if let Some(stage) = stage_for_status(
                db,
                text_of(&task, "projectId"),
                text_of(&task, "stageId"),
                wanted,
            )
            .await?
            {
                update.set("stageId", Js::String(stage));
            }
        }
        let before = text_of(&task, "status");
        let completed = write_task_change(db, &id, &update, before).await?;
        if let (Some(event_id), Some(wanted)) = (
            text_of(&task, "calendarEventId").filter(|e| !e.is_empty()),
            &wanted,
        ) {
            Background::of(&state, &caller).on_status_change(event_id, before, Some(wanted));
        }
        let next = handle_completion(&state, &caller, completed, &merged(&task, &update)).await?;
        let mut echo = Map::new();
        if let Some(position) = position {
            echo.insert("position".to_owned(), crate::js::number_value(position));
        }
        if let Some(wanted) = &wanted {
            echo.insert("status".to_owned(), Value::String(wanted.clone()));
        }
        let mut status_only = Update::default();
        if let Some(sent) = sent_status {
            status_only.set("status", Js::String(sent));
        }
        publish_updated(
            &state,
            &caller,
            &id,
            &task,
            &Value::Object(echo.clone()),
            &status_only,
        );
        let mut body = Map::new();
        body.insert("id".to_owned(), Value::String(id.clone()));
        body.extend(echo);
        if let Some(next) = next {
            body.insert("nextTaskId".to_owned(), Value::String(next));
        }
        Ok(Data(Value::Object(body)).into_response())
    }
    .await;
    reply(result, "Failed to update task position")
}

// ── PUT /:id/dependencies ───────────────────────────────────────────────────

/// `dependencyFailureResponse`.
fn dependency_refusal(id: &str, failure: DependencyFailure) -> Refusal {
    match failure {
        DependencyFailure::NotFound(_) => Refusal::not_found("Task", id),
        DependencyFailure::Forbidden(message) => Refusal::forbidden(&message),
        DependencyFailure::Invalid(message) => Refusal::bad_request(message),
    }
}

/// flow-api's `planDependencyUpdate`: the caller's projects bound the
/// tasks it may link.
async fn plan_links(
    caller: &Caller,
    id: &str,
    input: &LinkInput,
) -> Result<Result<DependencyPlan, DependencyFailure>, sqlx::Error> {
    let access = LinkAccess::Projects(caller.accessible_project_ids().await?);
    plan_dependency_update(&caller.db, id, input, &access).await
}

pub(crate) async fn dependencies(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, f| {
        let read = |issues: &mut Issues, key: &str| {
            issues
                .list(f, key, Presence::Optional, None, None, |issues, item| {
                    issues.item_text(item, Text::default())
                })
                .into_option()
        };
        let depends_on = read(issues, "dependsOn");
        let blocks = read(issues, "blocks");
        LinkInput { depends_on, blocks }
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    let result = async {
        let db = &caller.db;
        let task = task_row(db, &id).await?;
        let plan = match plan_links(&caller, &id, &input).await? {
            Ok(plan) => plan,
            Err(failure) => return Err(dependency_refusal(&id, failure)),
        };
        let at = now();
        let mut tx = db.begin().await?;
        write_dependency_rows(&mut tx, &id, &plan, &at).await?;
        tx.commit().await?;
        let task = task.unwrap_or(Value::Null);
        caller.publish(
            &state,
            PROJECT_TASK_UPDATED,
            &id,
            &task_analytics_payload(&task, &Value::Null, crate::now_ms()),
        );
        Ok(
            Data(json!({ "id": id, "dependsOn": plan.depends_on, "blocks": plan.blocks }))
                .into_response(),
        )
    }
    .await;
    reply(result, "Failed to update dependencies")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// `PATCHABLE_TASK_COLUMNS`.
const PATCHABLE: [&str; 23] = [
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

/// `buildTaskUpdate(data)`: the allow-listed columns (dates parsed) and the
/// assignee columns kept consistent.
fn build_update(data: &Update) -> Result<Update, Refusal> {
    let mut update = Update::default();
    for key in PATCHABLE {
        let Some(value) = data.get(key) else {
            continue;
        };
        let value = match (key, value) {
            ("startDate" | "dueDate", Js::String(raw)) if !raw.is_empty() => Js::String(
                weldsuite_flow_domain::js::js_date(raw)
                    .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?,
            ),
            _ => value.clone(),
        };
        update.set(key, value);
    }
    if let Some(ids) = data.get("assigneeIds") {
        let ids = match ids {
            Js::Array(ids) => ids.clone(),
            _ => Vec::new(),
        };
        let first = ids
            .first()
            .cloned()
            .filter(|id| !matches!(id, Js::String(s) if s.is_empty()));
        update.set(
            "assigneeIds",
            if ids.is_empty() {
                Js::Null
            } else {
                Js::Array(ids)
            },
        );
        update.set("assigneeId", first.unwrap_or(Js::Null));
    } else if let Some(assignee) = data.get("assigneeId") {
        let set = matches!(assignee, Js::String(s) if !s.is_empty());
        update.set(
            "assigneeIds",
            if set {
                Js::Array(vec![assignee.clone()])
            } else {
                Js::Null
            },
        );
    }
    Ok(update)
}

/// flow-api's `validateTaskRelations`.
async fn relation_error(
    db: &PgPool,
    task: &Value,
    id: &str,
    body: &Update,
) -> Result<Option<String>, sqlx::Error> {
    let current_project = text_of(task, "projectId");
    if let Some(sent) = body.get("projectId") {
        let sent = match sent {
            Js::String(project) => Some(project.as_str()),
            _ => None,
        };
        if sent != current_project {
            return Ok(Some(
                "projectId cannot be changed with PATCH; use POST /api/tasks/:id/move".to_owned(),
            ));
        }
    }
    let changed = changed_task_references(&row_references(task), &references(body, false));
    let refs = TaskReferences {
        parent_task_id: None,
        ..changed
    };
    if let Some(message) = find_invalid_task_reference(db, current_project, &refs).await? {
        return Ok(Some(message));
    }
    let parent = match body.get("parentTaskId") {
        None => ParentChange::Absent,
        Some(Js::String(parent)) => ParentChange::Set(parent.clone()),
        Some(_) => ParentChange::Null,
    };
    parent_error(
        db,
        Some(id),
        text_of(task, "parentTaskId"),
        current_project,
        &parent,
    )
    .await
}

pub(crate) async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw = parse_body(&body);
    let body = match validate(&headers, &body, |issues, f| read_update(issues, f, &raw)) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid body"),
    };
    if let Err(refused) = guard_write(&caller, &id).await {
        return refused.respond("Internal server error");
    }
    reply(
        patch_task(&state, &caller, &id, &body).await,
        "Failed to update task",
    )
}

/// The calendar after a PATCH (`syncCalendarAfterUpdate`).
fn sync_calendar_after_update(
    state: &FlowState,
    caller: &Caller,
    task: &Value,
    data: &Update,
    update: &Update,
    resolved: Option<&str>,
    id: &str,
) {
    let background = Background::of(state, caller);
    let sent = |key: &str| data.get(key);
    let date = |key: &str| match update.get(key) {
        None => millis(task, key),
        Some(Js::String(iso)) if !iso.is_empty() => millis_of(iso),
        Some(_) => None,
    };
    let title = js_text(data, "title")
        .filter(|t| !t.is_empty())
        .or_else(|| text_of(task, "title"))
        .unwrap_or_default()
        .to_owned();
    let description = match sent("description") {
        Some(Js::String(text)) => Some(text.clone()),
        Some(_) => None,
        None => text_of(task, "description").map(str::to_owned),
    };
    let duration = match sent("duration") {
        Some(Js::Number(n)) => Some(*n),
        Some(_) => None,
        None => task.get("duration").and_then(Value::as_f64),
    };
    let priority_sent = js_text(data, "priority").map(str::to_owned);
    let existing_priority = text_of(task, "priority").map(str::to_owned);
    let event = |priority: Option<String>| TaskEvent {
        user_id: caller.user_id.clone(),
        task_id: id.to_owned(),
        title: title.clone(),
        description: description.clone(),
        due_date: date("dueDate"),
        start_date: date("startDate"),
        duration_minutes: duration,
        priority,
    };
    let Some(event_id) = text_of(task, "calendarEventId").filter(|e| !e.is_empty()) else {
        background.place(
            event(priority_sent.or(existing_priority)),
            "calendar event creation",
            true,
        );
        return;
    };
    let dates_changed = sent("dueDate").is_some() || sent("startDate").is_some();
    if dates_changed || sent("title").is_some() || sent("duration").is_some() {
        background.reschedule(
            event_id.to_owned(),
            event(priority_sent.clone().or(existing_priority.clone())),
            "calendar reschedule",
        );
    }
    background.on_status_change(event_id, text_of(task, "status"), resolved);
    let priority_changed = sent("priority").is_some() && priority_sent != existing_priority;
    if priority_changed && !dates_changed {
        background.reschedule(
            event_id.to_owned(),
            event(priority_sent),
            "calendar priority reschedule",
        );
    }
}

async fn patch_task(state: &FlowState, caller: &Caller, id: &str, body: &Update) -> Reply {
    let db = &caller.db;
    let Some(task) = task_row(db, id).await? else {
        return Err(Refusal::not_found("Task", id));
    };
    if let Some(message) = relation_error(db, &task, id, body).await? {
        return Err(Refusal::bad_request(message));
    }
    let links = LinkInput {
        depends_on: js_list(body, "dependsOn"),
        blocks: js_list(body, "blocks"),
    };
    let plan = if links.depends_on.is_none() && links.blocks.is_none() {
        None
    } else {
        match plan_links(caller, id, &links).await? {
            Ok(plan) => Some(plan),
            Err(failure) => return Err(dependency_refusal(id, failure)),
        }
    };
    let mut data = body.clone();
    for key in ["projectId", "dependsOn", "blocks"] {
        data.remove(key);
    }

    let mut update = build_update(&data)?;
    let stage_sent = data.get("stageId").map(|stage| match stage {
        Js::String(stage) => Some(stage.as_str()),
        _ => None,
    });
    let change = apply_status_change(
        db,
        text_of(&task, "projectId"),
        text_of(&task, "stageId"),
        text_of(&task, "status"),
        stage_sent,
        js_text(&update, "status").map(str::to_owned),
    )
    .await?;
    if let Some(status) = &change.status {
        update.set("status", Js::String(status.clone()));
    }
    if let Some(stage) = &change.stage_id {
        update.set("stageId", Js::String(stage.clone()));
    }
    if change.completes {
        update.set("completedDate", Js::String(now()));
    }
    let resolved = change.resolved.clone();

    // Claimed up front: of concurrent completions, one owns it.
    let completed = if is_completion(text_of(&task, "status"), resolved.as_deref()) {
        let mut claim = Update::default();
        claim.set("status", Js::String("done".to_owned()));
        write_columns(db, id, &claim, true).await?
    } else {
        false
    };
    if let Some(plan) = &plan {
        let at = now();
        let mut tx = db.begin().await?;
        write_dependency_rows(&mut tx, id, plan, &at).await?;
        write_columns_on(&mut *tx, id, &update, false).await?;
        tx.commit().await?;
    } else {
        write_columns(db, id, &update, false).await?;
    }
    custom_values::sync_values_for_entity(db, TASK_ENTITY, id, data.get("customFields")).await;

    sync_calendar_after_update(
        state,
        caller,
        &task,
        &data,
        &update,
        resolved.as_deref(),
        id,
    );

    let mut after = merged(&task, &update);
    after.insert(
        "status".to_owned(),
        resolved.clone().map_or(Value::Null, Value::String),
    );
    let next = handle_completion(state, caller, completed, &after).await?;

    let mut echo = Map::new();
    if let Some(plan) = &plan {
        if links.depends_on.is_some() {
            echo.insert("dependsOn".to_owned(), json!(plan.depends_on));
        }
        if links.blocks.is_some() {
            echo.insert("blocks".to_owned(), json!(plan.blocks));
        }
    }
    // `notifyAddedAssigneesOnUpdate`.
    crate::notify::assignment(
        state,
        caller,
        crate::notify::Assignment {
            assignee_ids: newly_added_assignees(&task, &update),
            task_id: id.to_owned(),
            task_title: js_text(&data, "title")
                .filter(|t| !t.is_empty())
                .or_else(|| text_of(&task, "title"))
                .unwrap_or_default()
                .to_owned(),
            project_id: text_of(&task, "projectId").map(str::to_owned),
        },
    );
    let names = assignee_names(db, &assignee_ids_involved(&task, &update)).await?;
    let changes = build_task_changes(&task, &update, &names);
    let mut merged_data = task.as_object().cloned().unwrap_or_default();
    for (key, value) in &data.0 {
        merged_data.insert(key.clone(), value.to_value());
    }
    merged_data.extend(echo.clone());
    let title = js_text(&data, "title")
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .map_or_else(
            || task.get("title").cloned().unwrap_or(Value::Null),
            Value::String,
        );
    caller.publish_changes(
        state,
        PROJECT_TASK_UPDATED,
        id,
        task_analytics_payload(
            &Value::Object(merged_data),
            &json!({ "id": id, "title": title }),
            crate::now_ms(),
        ),
        changes,
    );

    let mut reply_body = Map::new();
    reply_body.insert("id".to_owned(), Value::String(id.to_owned()));
    for (key, value) in &data.0 {
        reply_body.insert(key.clone(), value.to_value());
    }
    reply_body.extend(echo);
    if let Some(next) = next {
        reply_body.insert("nextTaskId".to_owned(), Value::String(next));
    }
    Ok(Data(Value::Object(reply_body)).into_response())
}

/// `ApiError` for the validators' callers that need it.
#[allow(dead_code)]
fn bad_request(message: &str) -> Response {
    ApiError::bad_request(message).into_response()
}
