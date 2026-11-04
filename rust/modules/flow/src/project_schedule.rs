//! `/api/project-schedule` (`routes/project-schedule/index.ts`): the computed
//! schedule and the impact of a move (FLOW-015).
//!
//! ```text
//! GET  /settings/:projectId   the project calendar and the auto-schedule switch
//! PUT  /settings/:projectId   merge-write `settings.schedule`
//! GET  /:projectId            early and late dates, float, critical path, conflicts
//! POST /:projectId/preview    what a move would do
//! POST /:projectId/apply      the same move, written (auto-schedule on)
//! ```
//!
//! The checks run in TypeScript's order: permission, then the project (404),
//! then project access (403), then the body (400), then the rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PROJECT_TASK_RESCHEDULED, PROJECT_UPDATED};
use weldsuite_db::js_row;
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::js::iso_from_millis;
use weldsuite_flow_domain::schedule::{
    DependencyKind, MoveFailure, MoveFailureCode, MovePreview, MoveRequest, MovedTask,
    ScheduleCalendar, ScheduleConflict, ScheduleInput, ScheduleLinkInput, ScheduleResult,
    ScheduleTaskInput, compute_schedule, date_of, day_number, normalize_calendar, preview_move,
    project_deliverables, with_time_of_day, working_days_between,
};
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED};
use crate::raid_body::{Body, IDENTIFIER, Reader, parse_body};
use crate::task_dependencies::present_dependency;
use crate::{Caller, FlowState, Refusal, Reply, now_ms, outside, reply};

pub(crate) const PROJECT_MANAGE_DENIED: &str = "You do not have manage access to this project";
const AUTO_SCHEDULE_OFF: &str = "Auto-schedule is off for this project";
const HOLIDAYS_INVALID: &str = "Holidays must be real dates in the form YYYY-MM-DD";
const DEFAULT_SCHEDULE_LIMIT_DAYS: i64 = 5;

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/settings/{projectId}",
            get(get_settings)
                .route_layer(need("projects:read"))
                .merge(axum::routing::put(put_settings).route_layer(need("projects:update"))),
        )
        .route(
            "/{projectId}",
            get(get_schedule).route_layer(need("projects:read")),
        )
        .route(
            "/{projectId}/preview",
            post(preview).route_layer(need("projects:read")),
        )
        .route(
            "/{projectId}/apply",
            post(apply).route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Reading ─────────────────────────────────────────────────────────────────

pub(crate) async fn find_live_project(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) || jsonb_build_object('end_day', to_char(p.end_date, 'YYYY-MM-DD'))
         from projects p where p.id = $1 and p.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `scheduleSettingsOf(settings)`.
pub(crate) fn schedule_settings_of(project: &Value) -> (ScheduleCalendar, bool) {
    let stored = project["settings"].get("schedule");
    let calendar = normalize_calendar(
        stored.and_then(|s| s.get("workingDays")),
        stored.and_then(|s| s.get("holidays")),
    );
    let auto = stored
        .and_then(|s| s.get("autoSchedule"))
        .and_then(Value::as_bool)
        == Some(true);
    (calendar, auto)
}

fn settings_json(calendar: &ScheduleCalendar, auto: bool) -> Value {
    json!({
        "workingDays": calendar.working_days,
        "holidays": calendar.holidays,
        "autoSchedule": auto,
    })
}

/// Everything the calculation and its presentation read of one project.
pub(crate) struct ScheduleData {
    pub(crate) project: Value,
    pub(crate) calendar: ScheduleCalendar,
    pub(crate) auto: bool,
    pub(crate) tasks: Vec<Value>,
    pub(crate) links: Vec<Value>,
    pub(crate) deliverables: Vec<Value>,
    pub(crate) go_live: Option<String>,
    pub(crate) go_live_source: Option<&'static str>,
    pub(crate) baseline_version: Option<i64>,
    pub(crate) limit_days: i64,
}

pub(crate) async fn load_schedule_data(
    db: &weldsuite_db::PgPool,
    project: Value,
) -> Result<ScheduleData, sqlx::Error> {
    let id = project["id"].as_str().unwrap_or_default().to_owned();
    let tasks: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', t.id, 'number', t.number, 'title', t.title,
             'status', t.status, 'priority', t.priority, 'assigneeId', t.assignee_id,
             'parentTaskId', t.parent_task_id, 'deliverableId', t.deliverable_id,
             'progress', t.progress::text,
             'startMs', (extract(epoch from t.start_date) * 1000)::bigint,
             'dueMs', (extract(epoch from t.due_date) * 1000)::bigint,
             'startDay', to_char(t.start_date, 'YYYY-MM-DD'),
             'dueDay', to_char(t.due_date, 'YYYY-MM-DD'))
         from tasks t where t.project_id = $1 and t.deleted_at is null
         order by t.start_date asc nulls last, t.due_date asc nulls last, t.position asc, t.id asc",
    )
    .bind(&id)
    .fetch_all(db)
    .await?;
    let links: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from task_dependencies d where d.project_id = $1
         order by d.created_at asc, d.id asc",
    )
    .bind(&id)
    .fetch_all(db)
    .await?;
    let deliverables: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', d.id, 'number', d.number, 'title', d.title,
             'plannedStart', to_char(d.planned_start at time zone 'UTC', 'YYYY-MM-DD'),
             'plannedEnd', to_char(d.planned_end at time zone 'UTC', 'YYYY-MM-DD'))
         from project_deliverables d where d.project_id = $1 and d.deleted_at is null
         order by d.position asc, d.number asc",
    )
    .bind(&id)
    .fetch_all(db)
    .await?;
    let baseline: Option<(i32, Option<String>)> = sqlx::query_as(
        "select version, snapshot->>'goLive' from project_baselines
         where project_id = $1 order by version desc limit 1",
    )
    .bind(&id)
    .fetch_optional(db)
    .await?;
    let baseline_version = baseline.as_ref().map(|(version, _)| i64::from(*version));
    let baseline_go_live = baseline
        .and_then(|(_, go_live)| go_live)
        .and_then(|go_live| date_of(&go_live));
    let project_end = project["endDay"].as_str().map(str::to_owned);
    let (go_live, go_live_source) = match (baseline_go_live, project_end) {
        (Some(date), _) => (Some(date), Some("baseline")),
        (None, Some(date)) => (Some(date), Some("project")),
        (None, None) => (None, None),
    };
    let (calendar, auto) = schedule_settings_of(&project);
    let limit_days = project["settings"]["changeControl"]["scheduleLimitDays"]
        .as_i64()
        .unwrap_or(DEFAULT_SCHEDULE_LIMIT_DAYS);
    Ok(ScheduleData {
        project,
        calendar,
        auto,
        tasks,
        links: links.into_iter().map(js_row).collect(),
        deliverables,
        go_live,
        go_live_source,
        baseline_version,
        limit_days,
    })
}

fn str_of(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub(crate) fn build_schedule_input(data: &ScheduleData) -> ScheduleInput {
    ScheduleInput {
        tasks: data
            .tasks
            .iter()
            .map(|task| ScheduleTaskInput {
                id: str_of(task, "id").unwrap_or_default(),
                status: str_of(task, "status").unwrap_or_default(),
                start_date: str_of(task, "startDay"),
                due_date: str_of(task, "dueDay"),
            })
            .collect(),
        links: data
            .links
            .iter()
            .filter_map(|link| {
                Some(ScheduleLinkInput {
                    id: str_of(link, "id")?,
                    predecessor_id: str_of(link, "predecessorId")?,
                    successor_id: str_of(link, "successorId")?,
                    kind: DependencyKind::parse(link["type"].as_str()?)?,
                    lag_days: link["lagDays"].as_i64().unwrap_or(0),
                })
            })
            .collect(),
        calendar: data.calendar.clone(),
        go_live: data.go_live.clone(),
        pinned_task_ids: Vec::new(),
    }
}

fn go_live_json(data: &ScheduleData) -> Value {
    json!({
        "date": data.go_live,
        "source": data.go_live_source,
        "baselineVersion": data.baseline_version,
    })
}

/// Each deliverable with the end its tasks project (`presentDeliverables`).
fn deliverable_ends(data: &ScheduleData, result: &ScheduleResult) -> Vec<Value> {
    let ids: Vec<String> = data
        .deliverables
        .iter()
        .filter_map(|d| str_of(d, "id"))
        .collect();
    let refs: Vec<(String, String)> = data
        .tasks
        .iter()
        .filter_map(|task| Some((str_of(task, "deliverableId")?, str_of(task, "id")?)))
        .collect();
    let ends = project_deliverables(&ids, &refs, result);
    data.deliverables
        .iter()
        .zip(ends)
        .map(|(deliverable, projected_end)| {
            let planned_end = str_of(deliverable, "plannedEnd");
            let slip = match (&planned_end, &projected_end) {
                (Some(planned), Some(projected)) => {
                    working_days_between(&data.calendar, planned, projected)
                }
                _ => None,
            };
            json!({
                "id": deliverable["id"],
                "code": format!("D{}", deliverable["number"].as_i64().unwrap_or_default()),
                "title": deliverable["title"],
                "plannedStart": deliverable["plannedStart"],
                "plannedEnd": planned_end,
                "projectedEnd": projected_end,
                "slipDays": slip,
            })
        })
        .collect()
}

fn present_schedule(data: &ScheduleData, result: &ScheduleResult) -> Value {
    let tasks: Vec<Value> = data
        .tasks
        .iter()
        .zip(&result.tasks)
        .map(|(task, scheduled)| {
            let iso = |key: &str| {
                task.get(key)
                    .and_then(Value::as_i64)
                    .and_then(iso_from_millis)
            };
            let mut out = Map::new();
            for key in [
                "id",
                "number",
                "title",
                "status",
                "priority",
                "assigneeId",
                "parentTaskId",
                "deliverableId",
                "progress",
            ] {
                out.insert(
                    key.to_owned(),
                    task.get(key).cloned().unwrap_or(Value::Null),
                );
            }
            out.insert("startDate".to_owned(), json!(iso("startMs")));
            out.insert("dueDate".to_owned(), json!(iso("dueMs")));
            if let Value::Object(fields) = scheduled.to_json() {
                for (key, value) in fields {
                    if key != "id" {
                        out.insert(key, value);
                    }
                }
            }
            Value::Object(out)
        })
        .collect();
    let critical_count = result
        .tasks
        .iter()
        .filter(|task| result.critical_path.contains(&task.id))
        .count();
    let first_critical_start = result.critical_path.first().and_then(|id| {
        result
            .tasks
            .iter()
            .find(|task| &task.id == id)
            .and_then(|task| task.early_start.clone())
    });
    let critical_span = match (&first_critical_start, &result.finish) {
        (Some(start), Some(finish)) => {
            Some(working_days_between(&data.calendar, start, finish).unwrap_or(0) + 1)
        }
        _ => None,
    };
    json!({
        "projectId": data.project["id"],
        "settings": settings_json(&data.calendar, data.auto),
        "goLive": go_live_json(data),
        "finish": result.finish,
        "goLiveSlackDays": result.go_live_slack_days,
        "scheduleLimitDays": data.limit_days,
        "tasks": tasks,
        "dependencies": data.links.iter().map(present_dependency).collect::<Vec<_>>(),
        "conflicts": result.conflicts.iter().map(ScheduleConflict::to_json).collect::<Vec<_>>(),
        "criticalPath": result.critical_path,
        "cyclicTaskIds": result.cyclic_task_ids,
        "deliverables": deliverable_ends(data, result),
        "summary": {
            "taskCount": data.tasks.len(),
            "scheduledCount": result.tasks.iter().filter(|t| t.scheduled).count(),
            "unlinkedCount": result.tasks.iter().filter(|t| t.scheduled && !t.linked).count(),
            "linkCount": data.links.len(),
            "criticalCount": critical_count,
            "criticalSpanDays": critical_span,
            "conflictCount": result.conflicts.len(),
        },
    })
}

fn present_move_impact(
    data: &ScheduleData,
    before: &ScheduleResult,
    preview: &MovePreview,
) -> Value {
    let was = deliverable_ends(data, before);
    let now = deliverable_ends(data, &preview.schedule);
    let mut deliverables = Vec::new();
    for (was, now) in was.iter().zip(&now) {
        if was["projectedEnd"] == now["projectedEnd"] {
            continue;
        }
        let shift = match (was["projectedEnd"].as_str(), now["projectedEnd"].as_str()) {
            (Some(a), Some(b)) => working_days_between(&data.calendar, a, b).unwrap_or(0),
            _ => 0,
        };
        deliverables.push(json!({
            "id": was["id"],
            "code": was["code"],
            "title": was["title"],
            "plannedEnd": was["plannedEnd"],
            "endBefore": was["projectedEnd"],
            "endAfter": now["projectedEnd"],
            "shiftDays": shift,
        }));
    }
    let finish_shift = match (&preview.before.finish, &preview.after.finish) {
        (Some(a), Some(b)) => working_days_between(&data.calendar, a, b).unwrap_or(0),
        _ => 0,
    };
    json!({
        "taskId": preview.task_id,
        "task": { "startDate": preview.start_date, "dueDate": preview.due_date },
        "moved": preview.moved.iter().map(MovedTask::to_json).collect::<Vec<_>>(),
        "newConflicts": preview.new_conflicts.iter().map(ScheduleConflict::to_json).collect::<Vec<_>>(),
        "before": preview.before.to_json(),
        "after": preview.after.to_json(),
        "deliverables": deliverables,
        "goLive": go_live_json(data),
        "exceedsGoLive": preview.after.go_live_slack_days.is_some_and(|days| days < 0),
        "finishShiftDays": finish_shift,
        "autoSchedule": data.auto,
        "scheduleLimitDays": data.limit_days,
    })
}

/// The 400 / 404 / 409 of a refused move.
fn move_refusal(task_id: &str, failure: &MoveFailure) -> Refusal {
    match failure.code {
        MoveFailureCode::TaskNotFound => Refusal::not_found("Task", task_id),
        MoveFailureCode::TaskClosed => Refusal::conflict(failure.message),
        _ => Refusal::bad_request(failure.message),
    }
}

// ── Bodies ──────────────────────────────────────────────────────────────────

fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

fn read_move(issues: &mut Issues, body: &Value) -> Option<Body> {
    let mut r = Reader::of(issues, body)?;
    r.text("taskId", Presence::Required, IDENTIFIER)
        .text("startDate", Presence::Nullish, Text::default())
        .text("dueDate", Presence::Nullish, Text::default());
    let out = r.strict();
    for key in ["startDate", "dueDate"] {
        if let Some(Value::String(text)) = out.get(key)
            && !is_date(text)
        {
            issues.custom(key, "Use a date in the form YYYY-MM-DD");
        }
    }
    Some(out)
}

fn read_settings(issues: &mut Issues, body: &Value) -> Option<Body> {
    let fields = issues.object(body)?;
    let mut out = Body::new();
    if let Some(value) = fields.get("workingDays") {
        let valid = value.as_array().is_some_and(|days| {
            (1..=7).contains(&days.len())
                && days
                    .iter()
                    .all(|d| d.as_i64().is_some_and(|n| (1..=7).contains(&n)) && d.is_i64())
        });
        if valid {
            out.insert("workingDays".to_owned(), value.clone());
        } else {
            issues.custom("workingDays", "Invalid working days");
        }
    }
    if let Some(value) = fields.get("holidays") {
        let valid = value.as_array().is_some_and(|days| {
            days.len() <= 1000 && days.iter().all(|d| d.as_str().is_some_and(is_date))
        });
        if valid {
            out.insert("holidays".to_owned(), value.clone());
        } else {
            issues.custom("holidays", "Invalid holidays");
        }
    }
    if let Some(value) = fields.get("autoSchedule") {
        if value.is_boolean() {
            out.insert("autoSchedule".to_owned(), value.clone());
        } else {
            issues.custom("autoSchedule", "Expected boolean");
        }
    }
    let extra: Vec<&String> = fields
        .keys()
        .filter(|key| !["workingDays", "holidays", "autoSchedule"].contains(&key.as_str()))
        .collect();
    if !extra.is_empty() {
        let listed = extra
            .iter()
            .map(|key| format!("'{key}'"))
            .collect::<Vec<_>>()
            .join(", ");
        issues.issue_here(json!({
            "code": "unrecognized_keys",
            "keys": extra,
            "message": format!("Unrecognized key(s) in object: {listed}"),
        }));
    }
    Some(out)
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        settings_of(&caller, &project_id).await,
        "Failed to load the schedule settings",
    )
}

async fn settings_of(caller: &Caller, project_id: &str) -> Reply {
    let Some(project) = find_live_project(&caller.db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let (calendar, auto) = schedule_settings_of(&project);
    Ok(Data(settings_json(&calendar, auto)).into_response())
}

async fn put_settings(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
        }
        let input = parse_body(&body, read_settings)?;
        if input
            .get("holidays")
            .and_then(Value::as_array)
            .is_some_and(|days| {
                days.iter()
                    .any(|d| d.as_str().is_none_or(|text| day_number(text).is_none()))
            })
        {
            return Err(Refusal::bad_request(HOLIDAYS_INVALID));
        }
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_settings(&state, &caller, &project_id, &project, &input).await,
        "Failed to update the schedule settings",
    )
}

async fn write_settings(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    project: &Value,
    input: &Body,
) -> Reply {
    let (current, current_auto) = schedule_settings_of(project);
    let calendar = normalize_calendar(
        input
            .get("workingDays")
            .or(Some(&json!(current.working_days))),
        input.get("holidays").or(Some(&json!(current.holidays))),
    );
    let auto = input
        .get("autoSchedule")
        .and_then(Value::as_bool)
        .unwrap_or(current_auto);
    let next = settings_json(&calendar, auto);
    // A merge of this key only: the other settings keys are other features'.
    sqlx::query(
        "update projects set
             settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('schedule', $2::jsonb),
             updated_at = $3::timestamp
         where id = $1",
    )
    .bind(project_id)
    .bind(next.clone())
    .bind(crate::now())
    .execute(&caller.db)
    .await?;
    if let Value::Object(map) = project {
        caller.publish(
            state,
            PROJECT_UPDATED,
            project_id,
            &crate::projects::analytics_payload(map),
        );
    }
    Ok(Data(next).into_response())
}

// ── The schedule ────────────────────────────────────────────────────────────

async fn get_schedule(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        schedule_of(&caller, &project_id).await,
        "Failed to compute the schedule",
    )
}

async fn schedule_of(caller: &Caller, project_id: &str) -> Reply {
    let Some(project) = find_live_project(&caller.db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let data = load_schedule_data(&caller.db, project).await?;
    let result = compute_schedule(&build_schedule_input(&data));
    Ok(Data(present_schedule(&data, &result)).into_response())
}

// ── Preview and apply ───────────────────────────────────────────────────────

fn move_request(input: &Body) -> MoveRequest {
    MoveRequest {
        task_id: input
            .get("taskId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        start_date: input
            .get("startDate")
            .and_then(Value::as_str)
            .map(str::to_owned),
        due_date: input
            .get("dueDate")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

async fn preview(caller: Caller, Path(project_id): Path<String>, body: Bytes) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let input = parse_body(&body, read_move)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        preview_of(&caller, project, &input).await,
        "Failed to preview the move",
    )
}

async fn preview_of(caller: &Caller, project: Value, input: &Body) -> Reply {
    let data = load_schedule_data(&caller.db, project).await?;
    let schedule_input = build_schedule_input(&data);
    let request = move_request(input);
    match preview_move(&schedule_input, &request) {
        Ok(preview) => {
            let before = compute_schedule(&schedule_input);
            Ok(Data(present_move_impact(&data, &before, &preview)).into_response())
        }
        Err(failure) => Err(move_refusal(&request.task_id, &failure)),
    }
}

async fn apply(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_move)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        apply_move(&state, &caller, &project_id, project, &input).await,
        "Failed to apply the move",
    )
}

async fn apply_move(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    project: Value,
    input: &Body,
) -> Reply {
    let data = load_schedule_data(&caller.db, project).await?;
    // Off: the move is an ordinary edit of the task, which shows its conflicts; nothing else moves.
    if !data.auto {
        return Err(Refusal::conflict(AUTO_SCHEDULE_OFF));
    }
    let schedule_input = build_schedule_input(&data);
    let request = move_request(input);
    let preview = match preview_move(&schedule_input, &request) {
        Ok(preview) => preview,
        Err(failure) => return Err(move_refusal(&request.task_id, &failure)),
    };

    let now = crate::now();
    let mut writes = Vec::new();
    for (index, moved) in preview.moved.iter().enumerate() {
        let row = data
            .tasks
            .iter()
            .find(|task| task["id"] == moved.task_id.as_str());
        let itself = index == 0;
        let start_ms = row.and_then(|r| r["startMs"].as_i64());
        let due_ms = row.and_then(|r| r["dueMs"].as_i64());
        let start = (itself || start_ms.is_some())
            .then(|| with_time_of_day(&moved.to_start, start_ms))
            .flatten();
        let due = (itself || due_ms.is_some())
            .then(|| with_time_of_day(&moved.to_finish, due_ms))
            .flatten();
        writes.push((moved, row, itself, start, due));
    }
    let statements: Vec<_> = writes
        .iter()
        .map(|(moved, _, _, start, due)| {
            sqlx::query(
                "update tasks set
                     start_date = coalesce($2::timestamp, start_date),
                     due_date = coalesce($3::timestamp, due_date),
                     updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(moved.task_id.clone())
            .bind(start.and_then(iso_from_millis))
            .bind(due.and_then(iso_from_millis))
            .bind(now.clone())
        })
        .collect();
    weldsuite_db::atomically(&caller.db, statements).await?;

    for (moved, row, itself, start, due) in &writes {
        let iso = |ms: Option<i64>| ms.and_then(iso_from_millis);
        let new_start = iso(start.or_else(|| row.and_then(|r| r["startMs"].as_i64())));
        let new_due = iso(due.or_else(|| row.and_then(|r| r["dueMs"].as_i64())));
        let mut task = row.cloned().unwrap_or_else(|| json!({}));
        task["id"] = json!(moved.task_id);
        task["projectId"] = json!(project_id);
        task["dueDate"] = json!(new_due);
        let mut payload = task_analytics_payload(&task, &json!({}), now_ms());
        if let Value::Object(map) = &mut payload {
            map.insert("startDate".to_owned(), json!(new_start));
            map.insert("dueDate".to_owned(), json!(new_due));
            map.insert(
                "previousStartDate".to_owned(),
                json!(iso(row.and_then(|r| r["startMs"].as_i64()))),
            );
            map.insert(
                "previousDueDate".to_owned(),
                json!(iso(row.and_then(|r| r["dueMs"].as_i64()))),
            );
            map.insert("shiftDays".to_owned(), json!(moved.shift_days));
            map.insert(
                "cause".to_owned(),
                json!(if *itself { "moved" } else { "dependency" }),
            );
        }
        caller.publish(state, PROJECT_TASK_RESCHEDULED, &moved.task_id, &payload);
    }
    let before = compute_schedule(&schedule_input);
    let mut impact = present_move_impact(&data, &before, &preview);
    impact["applied"] = json!(true);
    Ok(Data(impact).into_response())
}
