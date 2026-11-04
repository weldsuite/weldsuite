//! `/api/project-benefits` (`routes/project-benefits/index.ts`): benefits and
//! their measurements in `project_benefits` and
//! `project_benefit_measurements` (design: weldflow-project-control.md; ADRs
//! FLOW-011 and FLOW-014).
//!
//! ```text
//! GET    /                    list (projectId optional, filters, cursor), each with its newest measurement
//! GET    /goal-targets        progress of the goal-card targets of a project
//! GET    /:id                 benefit, its measurements (oldest month first) and links
//! POST   /                    create (code B-<n>, a metric of the catalogue or manual)
//! PATCH  /:id                 edit; realised and closed stop the measuring
//! DELETE /:id                 soft delete, with its links
//! GET    /:id/measurements    the measurements, oldest month first
//! POST   /:id/measurements    a manual value for a month
//! ```
//!
//! The monthly sweep ([`crate::benefit_measure`]) stores the catalogue
//! metrics' values; creating or editing a benefit with one marks the
//! workspace due for the next month boundary. The checks run in TypeScript's
//! order: permission, then the benefit (404), then project access (403), then
//! the body (400), then the business rules.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_BENEFIT_CREATED, PROJECT_BENEFIT_DELETED, PROJECT_BENEFIT_REALISED,
    PROJECT_BENEFIT_UPDATED, PROJECT_CONTROL_LINK_DELETED,
};
use weldsuite_flow_domain::benefit_metrics::{
    is_future_period, metric_is_measured, metric_params_error, metric_unit, next_month_start_ms,
};
use weldsuite_flow_domain::benefits::{
    GoalTarget, GoalTaskFilter, benefit_closed_at_for, benefit_code, benefit_event_data,
    benefit_sequence, benefit_target_progress, goal_card_id, latest_of, messages,
    parse_goal_targets, present_benefit, present_measurement, task_target_progress,
};
use weldsuite_flow_domain::js::{contains_pattern, number_text};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::governance_body::{
    RegisterQuery, benefit_list_query, goal_targets_query, read_create_benefit,
    read_create_measurement, read_update_benefit,
};
use crate::governance_store::{
    find_benefit, insert_statement, latest_measurements, measurements_of, update_statement,
    upsert_measurement,
};
use crate::project_decisions::project_scope;
use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, iso_ms, or_null, parse_limit, to_date};
use crate::raid_body::{Body, parse_body};
use crate::raid_store::{Direction, links_of_object, live_project_exists, present_linked_objects};
use crate::{Caller, FlowState, Refusal, Reply, keyset_cursor, outside, page, paged, reply};

const BENEFIT_LABEL: &str = "Benefit";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        // MUST be before /:id.
        .route(
            "/goal-targets",
            get(goal_targets).route_layer(need("projects:read")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:delete")))
        .route(
            "/{id}/measurements",
            get(measurements).route_layer(need("projects:read")),
        )
        .route(
            "/{id}/measurements",
            post(add_measurement).route_layer(need("projects:update")),
        )
        .with_state(state)
}

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// `numeric(value)`: a number as the numeric column stores it (text), or null.
fn numeric(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_f64) {
        Some(number) => Value::String(number_text(number)),
        None => Value::Null,
    }
}

/// `publishBenefit(c, action, row, extra)`.
fn publish_benefit(
    state: &FlowState,
    caller: &Caller,
    event: EventName,
    row: &Value,
    extra: Value,
) {
    let mut data = benefit_event_data(row);
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra);
    }
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &data);
}

/// `markBenefitMeasureDue(c, now)`: the sweep looks at this workspace at the
/// next month boundary. Best effort.
async fn mark_measure_due(state: &FlowState, caller: &Caller, now_ms: i64) {
    let Some(master) = caller.master(state) else {
        return;
    };
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(next_month_start_ms(now_ms)) * 1_000_000,
    );
    if let Ok(at) = at {
        weldsuite_db::due_index::mark_due(
            &master,
            crate::benefit_measure::BENEFIT_MEASURE_KIND,
            &caller.workspace_id,
            at,
        )
        .await;
    }
}

/// `presentBenefitRow(db, row)`: the benefit with its newest measurement.
async fn present_row(caller: &Caller, row: &Value) -> Result<Value, sqlx::Error> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let latest = latest_measurements(&caller.db, std::slice::from_ref(&id)).await?;
    let latest = latest.get(&id).map(|m| latest_of(std::slice::from_ref(m)));
    Ok(present_benefit(row, latest.flatten().as_ref()))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: the project scope (`$1` the
/// project, else `$2`/`$3` the accessible ones), the status and the search.
macro_rules! benefit_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ")",
            " and ($4::text is null or t.status = $4)",
            " and ($5::text is null or t.title ilike $5 or t.description ilike $5)"
        )
    };
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match benefit_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 25, 100);
    let (all, ids) = match project_scope(&caller, q.project_id.as_deref()).await {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_benefits where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        list_benefits(&caller, &q, limit, (all, &ids), cursor).await,
        "Failed to list benefits",
    )
}

async fn list_benefits(
    caller: &Caller,
    q: &RegisterQuery,
    limit: i64,
    (all, ids): (bool, &[String]),
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let search = q.search.as_deref().map(contains_pattern);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        benefit_json!("t"),
        " from project_benefits t where ",
        benefit_filters!(),
        " and ($6::timestamptz is null or t.created_at < $6::timestamptz",
        " or (t.created_at = $6::timestamptz and t.id < $7))",
        " order by t.created_at desc, t.id desc limit $8"
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.status.as_deref())
    .bind(search.as_deref())
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_benefits t where ",
        benefit_filters!()
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.status.as_deref())
    .bind(search.as_deref())
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(weldsuite_db::js_row).collect(), limit);
    let page_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let latest = latest_measurements(db, &page_ids).await?;
    let items = rows
        .iter()
        .map(|row| {
            let newest = latest
                .get(row["id"].as_str().unwrap_or_default())
                .and_then(|m| latest_of(std::slice::from_ref(m)));
            present_benefit(row, newest.as_ref())
        })
        .collect();
    Ok(paged(items, total, has_more, next))
}

// ── GET /goal-targets ───────────────────────────────────────────────────────

/// `findGoalsCanvas(db, projectId)`: the goal cards of the project's canvas row,
/// the one the goals routes pick too (one that holds canvas data first, then the
/// most recently written, then the id).
async fn find_goals_canvas(
    caller: &Caller,
    project_id: &str,
) -> Result<Option<Vec<Value>>, sqlx::Error> {
    let row: Option<Option<Value>> = sqlx::query_scalar(
        "select g.goals from project_goals g
         where g.project_id = $1 and g.deleted_at is null
         order by (case when g.mission is not null
                          or jsonb_array_length(coalesce(g.goals, '[]'::jsonb)) > 0
                        then 0 else 1 end),
                  g.updated_at desc, g.id desc
         limit 1",
    )
    .bind(project_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|goals| match goals {
        Some(Value::Array(cards)) => cards,
        _ => Vec::new(),
    }))
}

/// `countFilteredTasks(db, projectId, filter)`: done and total tasks of a
/// project that match a goal-card task filter.
async fn count_filtered_tasks(
    caller: &Caller,
    project_id: &str,
    filter: &GoalTaskFilter,
) -> Result<(i64, i64), sqlx::Error> {
    let (total, done): (i64, i64) = sqlx::query_as(
        "select count(*)::int8, (count(*) filter (where t.status = 'done'))::int8
         from tasks t
         where t.project_id = $1 and t.deleted_at is null and t.status <> 'cancelled'
           and ($2::text is null or t.deliverable_id = $2)
           and ($3::text is null or t.milestone_id = $3)
           and ($4::text is null or t.sprint_id = $4)
           and ($5::text is null or t.assignee_id = $5)
           and ($6::text is null or t.type = $6)
           and ($7::text is null or t.tags @> jsonb_build_array($7::text))",
    )
    .bind(project_id)
    .bind(filter.deliverable_id.as_deref())
    .bind(filter.milestone_id.as_deref())
    .bind(filter.sprint_id.as_deref())
    .bind(filter.assignee_id.as_deref())
    .bind(filter.task_type.as_deref())
    .bind(filter.tag.as_deref())
    .fetch_one(&caller.db)
    .await?;
    Ok((done, total))
}

async fn goal_targets(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let project_id = match goal_targets_query(raw.as_deref()) {
        Ok(project_id) => project_id,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        load_goal_targets(&caller, &project_id).await,
        "Failed to load goal targets",
    )
}

async fn load_goal_targets(caller: &Caller, project_id: &str) -> Reply {
    let db = &caller.db;
    if !live_project_exists(db, project_id).await? {
        return Err(Refusal::not_found("Project", project_id));
    }
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }

    let canvas = find_goals_canvas(caller, project_id).await?;
    let cards: Vec<(String, Vec<(usize, GoalTarget)>)> = canvas
        .unwrap_or_default()
        .iter()
        .filter_map(|card| {
            let id = goal_card_id(card)?;
            let targets = parse_goal_targets(card);
            (!targets.is_empty()).then_some((id, targets))
        })
        .collect();

    let mut benefit_ids: Vec<String> = Vec::new();
    for (_, targets) in &cards {
        for (_, target) in targets {
            if let GoalTarget::Benefit { benefit_id } = target
                && !benefit_ids.contains(benefit_id)
            {
                benefit_ids.push(benefit_id.clone());
            }
        }
    }
    let benefit_rows: Vec<Value> = if benefit_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            benefit_json!("b"),
            " from project_benefits b",
            " where b.project_id = $1 and b.deleted_at is null and b.id = any($2)"
        ))
        .bind(project_id)
        .bind(&benefit_ids)
        .fetch_all(db)
        .await?
    };
    let benefit_rows: Vec<Value> = benefit_rows.into_iter().map(weldsuite_db::js_row).collect();
    let row_ids: Vec<String> = benefit_rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let latest = latest_measurements(db, &row_ids).await?;
    let benefits: std::collections::HashMap<String, Value> = benefit_rows
        .iter()
        .map(|row| {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let newest = latest
                .get(&id)
                .and_then(|m| latest_of(std::slice::from_ref(m)));
            (id, present_benefit(row, newest.as_ref()))
        })
        .collect();

    let mut result: Vec<Value> = Vec::new();
    for (goal_id, targets) in &cards {
        let mut progress: Vec<Value> = Vec::new();
        for (index, target) in targets {
            progress.push(match target {
                GoalTarget::Benefit { benefit_id } => {
                    benefit_target_progress(*index, benefit_id, benefits.get(benefit_id))
                }
                GoalTarget::Task { label, filter } => {
                    let (done, total) = count_filtered_tasks(caller, project_id, filter).await?;
                    task_target_progress(*index, label, done, total)
                }
            });
        }
        result.push(json!({ "goalId": goal_id, "targets": progress }));
    }
    Ok(Data(Value::Array(result)).into_response())
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(fetch_detail(&caller, &id).await, "Failed to fetch benefit")
}

async fn fetch_detail(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(row) = find_benefit(db, id).await? else {
        return Err(Refusal::not_found(BENEFIT_LABEL, id));
    };
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let measurement_rows = measurements_of(db, id).await?;
    let link_rows = links_of_object(db, "benefit", id).await?;
    let links = present_linked_objects(caller, link_rows, |link| {
        if link["fromType"] == "benefit" && link["fromId"] == id {
            Direction::Outgoing
        } else {
            Direction::Incoming
        }
    })
    .await?;
    let mut benefit = present_benefit(&row, latest_of(&measurement_rows).as_ref());
    if let Value::Object(fields) = &mut benefit {
        fields.insert(
            "measurements".to_owned(),
            Value::Array(measurement_rows.iter().map(present_measurement).collect()),
        );
        fields.insert("links".to_owned(), Value::Array(links));
    }
    Ok(Data(benefit).into_response())
}

// ── GET /:id/measurements ───────────────────────────────────────────────────

async fn measurements(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        list_measurements(&caller, &id).await,
        "Failed to list measurements",
    )
}

async fn list_measurements(caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(row) = find_benefit(db, id).await? else {
        return Err(Refusal::not_found(BENEFIT_LABEL, id));
    };
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let rows = measurements_of(db, id).await?;
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(paged(
        rows.iter().map(present_measurement).collect(),
        total,
        false,
        None,
    ))
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_benefit)?;
        let project_id = text(&input, "projectId").unwrap_or_default().to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let metric = text(&input, "metric").unwrap_or("manual").to_owned();
        let params = input
            .get("metricParams")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let params = metric_params_error(&metric, &params).map_err(Refusal::bad_request)?;
        Ok((project_id, metric, params, input))
    }
    .await;
    let (project_id, metric, params, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_benefit(&state, &caller, &project_id, &metric, params, &input).await,
        "Failed to create benefit",
    )
}

async fn create_benefit(
    state: &FlowState,
    caller: &Caller,
    project_id: &str,
    metric: &str,
    params: Value,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = iso_ms(now_ms);
    let id = generate_id("ben");
    let number = allocate_number(db, &benefit_sequence(project_id)).await?;
    let unit = match input.get("unit") {
        Some(Value::String(unit)) => json!(unit),
        _ => json!(metric_unit(metric)),
    };
    let mut values = Body::new();
    values.insert("id".to_owned(), json!(id));
    values.insert("projectId".to_owned(), json!(project_id));
    values.insert("number".to_owned(), json!(number));
    values.insert("title".to_owned(), or_null(input, "title"));
    values.insert("description".to_owned(), or_null(input, "description"));
    values.insert("ownerId".to_owned(), or_null(input, "ownerId"));
    values.insert("goalRef".to_owned(), or_null(input, "goalRef"));
    values.insert("metric".to_owned(), json!(metric));
    values.insert("metricParams".to_owned(), params);
    values.insert("unit".to_owned(), unit);
    values.insert(
        "baselineValue".to_owned(),
        numeric(input.get("baselineValue")),
    );
    values.insert("targetValue".to_owned(), numeric(input.get("targetValue")));
    values.insert("realiseBy".to_owned(), to_date(input.get("realiseBy")));
    values.insert(
        "status".to_owned(),
        json!(text(input, "status").unwrap_or("planned")),
    );
    values.insert("closedAt".to_owned(), Value::Null);
    values.insert("createdBy".to_owned(), json!(caller.user_id));
    values.insert("createdAt".to_owned(), json!(now));
    values.insert("updatedAt".to_owned(), json!(now));
    weldsuite_db::atomically(db, [insert_statement("project_benefits", &values)]).await?;
    let Some(row) = find_benefit(db, &id).await? else {
        return Err(Refusal::Internal("the new benefit is missing".to_owned()));
    };

    if metric_is_measured(row["metric"].as_str().unwrap_or_default()) {
        mark_measure_due(state, caller, now_ms).await;
    }
    publish_benefit(state, caller, PROJECT_BENEFIT_CREATED, &row, json!({}));
    Ok(Created(present_benefit(&row, None)).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(existing) = find_benefit(&caller.db, &id).await? else {
            return Err(Refusal::not_found(BENEFIT_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_write(project).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_update_benefit)?;

        // A new metric starts with the parameters sent with it (none: empty);
        // an edit of the parameters alone keeps the metric.
        let existing_metric = existing["metric"].as_str().unwrap_or_default();
        let metric_changed = text(&input, "metric").is_some_and(|metric| metric != existing_metric);
        let next_metric = text(&input, "metric").unwrap_or(existing_metric);
        let mut next_params: Option<Value> = None;
        if input.contains_key("metric") || input.contains_key("metricParams") {
            let params: Map<String, Value> = match input.get("metricParams") {
                Some(Value::Object(params)) => params.clone(),
                _ if metric_changed => Map::new(),
                _ => existing["metricParams"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            };
            next_params =
                Some(metric_params_error(next_metric, &params).map_err(Refusal::bad_request)?);
        }
        Ok((existing, input, next_params))
    }
    .await;
    let (existing, input, next_params) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_benefit(&state, &caller, &id, &existing, &input, next_params).await,
        "Failed to update benefit",
    )
}

async fn update_benefit(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
    next_params: Option<Value>,
) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = iso_ms(now_ms);
    let mut set = Body::new();
    set.insert("updatedAt".to_owned(), json!(now));
    for key in [
        "title",
        "description",
        "ownerId",
        "goalRef",
        "metric",
        "unit",
    ] {
        if let Some(value) = input.get(key) {
            set.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(params) = next_params {
        set.insert("metricParams".to_owned(), params);
    }
    for key in ["baselineValue", "targetValue"] {
        if input.contains_key(key) {
            set.insert(key.to_owned(), numeric(input.get(key)));
        }
    }
    if input.contains_key("realiseBy") {
        set.insert("realiseBy".to_owned(), to_date(input.get("realiseBy")));
    }
    if let Some(status) = text(input, "status") {
        set.insert("status".to_owned(), json!(status));
        set.insert(
            "closedAt".to_owned(),
            json!(benefit_closed_at_for(
                status,
                existing["closedAt"].as_str(),
                &now
            )),
        );
    }

    weldsuite_db::atomically(db, [update_statement("project_benefits", &set, id)]).await?;
    let Some(row) = find_benefit(db, id).await? else {
        return Err(Refusal::not_found(BENEFIT_LABEL, id));
    };

    // Editing a benefit that is measured (or has just become so) has the sweep look at it next month.
    if metric_is_measured(row["metric"].as_str().unwrap_or_default()) && row["closedAt"].is_null() {
        mark_measure_due(state, caller, now_ms).await;
    }
    publish_benefit(state, caller, PROJECT_BENEFIT_UPDATED, &row, json!({}));
    if existing["status"] != "realised" && row["status"] == "realised" {
        publish_benefit(state, caller, PROJECT_BENEFIT_REALISED, &row, json!({}));
    }
    Ok(Data(present_row(caller, &row).await?).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_benefit(&state, &caller, &id).await,
        "Failed to delete benefit",
    )
}

async fn remove_benefit(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_benefit(db, id).await? else {
        return Err(Refusal::not_found(BENEFIT_LABEL, id));
    };
    let project = existing["projectId"].as_str().unwrap_or_default();
    if !caller.can_write(project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }

    let links = links_of_object(db, "benefit", id).await?;
    let now = iso_ms(crate::now_ms());
    // The benefit's links go with it, in the same batch; its measurements stay (append-only).
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "update project_benefits set deleted_at = $2::timestamptz,
                        updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now),
            sqlx::query(
                "delete from project_control_links
                 where (from_type = 'benefit' and from_id = $1)
                    or (to_type = 'benefit' and to_id = $1)",
            )
            .bind(id.to_owned()),
        ],
    )
    .await?;
    let number = existing["number"].as_i64().unwrap_or_default();
    caller.publish(
        state,
        PROJECT_BENEFIT_DELETED,
        id,
        &json!({ "id": id, "projectId": existing["projectId"], "code": benefit_code(number) }),
    );
    for link in &links {
        crate::raid::publish_link(state, caller, PROJECT_CONTROL_LINK_DELETED, link);
    }
    Ok(NoContent.into_response())
}

// ── POST /:id/measurements ──────────────────────────────────────────────────

async fn add_measurement(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let now_ms = crate::now_ms();
    let checked = async {
        let Some(existing) = find_benefit(&caller.db, &id).await? else {
            return Err(Refusal::not_found(BENEFIT_LABEL, &id));
        };
        let project = existing["projectId"].as_str().unwrap_or_default();
        if !caller.can_write(project).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_create_measurement)?;
        if is_future_period(text(&input, "period").unwrap_or_default(), now_ms) {
            return Err(Refusal::bad_request(messages::FUTURE_PERIOD));
        }
        Ok((existing, input))
    }
    .await;
    let (existing, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        store_measurement(&state, &caller, &id, &existing, &input, now_ms).await,
        "Failed to store measurement",
    )
}

async fn store_measurement(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
    now_ms: i64,
) -> Reply {
    let db = &caller.db;
    let period = text(input, "period").unwrap_or_default();
    let value = input
        .get("value")
        .and_then(Value::as_f64)
        .map(number_text)
        .unwrap_or_default();
    upsert_measurement(
        db,
        id,
        existing["projectId"].as_str().unwrap_or_default(),
        period,
        &value,
        Some(&caller.user_id),
        &iso_ms(now_ms),
    )
    .await?;
    let row = find_benefit(db, id).await?;
    let rows = measurements_of(db, id).await?;
    let measurement = rows.iter().find(|m| m["period"] == period);
    let (Some(row), Some(measurement)) = (row, measurement) else {
        return Err(Refusal::Internal("the measurement is missing".to_owned()));
    };

    publish_benefit(
        state,
        caller,
        PROJECT_BENEFIT_UPDATED,
        &row,
        json!({ "period": measurement["period"], "value": measurement["value"] }),
    );
    Ok(Created(json!({
        "measurement": present_measurement(measurement),
        "benefit": present_benefit(&row, latest_of(&rows).as_ref()),
    }))
    .into_response())
}
