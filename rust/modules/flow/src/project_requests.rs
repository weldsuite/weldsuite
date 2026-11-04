//! `/api/project-requests` (`routes/project-requests/index.ts`): project
//! intake, with the requests in `project_requests` and the workspace settings
//! in `flow_workspace_settings` (design: weldflow-delivery-and-portfolio.md,
//! "Intake").
//!
//! ```text
//! GET    /                ranked list (status, search, cursor)
//! GET    /funnel          requests per status
//! GET    /roadmap         current projects and approved requests per quarter, with the capacity line
//! GET    /settings        scoring model, portfolio board, expense approval limit
//! PUT    /settings        change them (portfolio:manage); a new model re-scores open requests
//! GET    /:id             request, score breakdown, board answers, capacity fit
//! POST   /                file a request (REQ-n)
//! PATCH  /:id             edit a new or assessing request
//! DELETE /:id             soft delete, with its held bookings and open approvals
//! POST   /:id/score       rate the criteria of the scoring model
//! POST   /:id/submit      ask every portfolio board member to approve
//! POST   /:id/convert     link the project made from an approved request
//! ```
//!
//! The checks run in TypeScript's order: permission, then the row (404), then
//! access (403), then the body (400), then the rules. The board answers in My
//! reviews (slice A's `/api/approvals`); the request becomes `approved` or
//! `rejected` through the `project_request` subject (`store::register_subject`).

mod store;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, FLOW_WORKSPACE_SETTINGS_UPDATED, PROJECT_REQUEST_CONVERTED, PROJECT_REQUEST_CREATED,
    PROJECT_REQUEST_DELETED, PROJECT_REQUEST_SUBMITTED, PROJECT_REQUEST_UPDATED,
    RESOURCE_BOOKING_DELETED, RESOURCE_BOOKING_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::approvals::ResolvedApprovalOutcome;
use weldsuite_flow_domain::capacity::{
    NeededSkill, PROJECT_REQUEST_STATUSES, fit_range, present_booking, roadmap_range, rollup_load,
    skill_fit, weeks_covering,
};
use weldsuite_flow_domain::intake::{
    Criterion, REQUEST_SEQUENCE, amount_text, default_scoring_model, desired_dates_error,
    intake_messages, is_open_request_status, normalize_needed_skills, present_project_request,
    present_request_approval, present_settings, request_code, score_breakdown, score_request,
    scores_error, scoring_model_error, sort_roadmap_items,
};
use weldsuite_flow_domain::js::{contains_pattern, number_value, numeric, to_fixed};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::store::{
    board_of, clear_approvals, find_project_request, list_subject_approvals, load_settings,
    model_of, request_approvals, request_json,
};
use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_cancelled,
    announce_approvals_requested,
};
use crate::capacity::body::{
    Body, parse_body, project_requests_query, read_convert, read_create_project_request,
    read_score, read_settings, read_update_project_request, roadmap_query,
};
use crate::capacity::store::{booking_json, load_capacity};
use crate::capacity::{iso_now, parse_limit, today_utc};
use crate::raid_store::live_project_exists;
use crate::{Caller, FlowState, Refusal, Reply, outside, page, paged, reply};

/// A request as the roadmap query reads it.
type RequestRow = (String, i32, String, String, Option<String>, String, String);

const REQUEST_LABEL: &str = "Project request";
const MANAGE: &str = "portfolio:manage";
const DAY_MS: i64 = 86_400_000;
/// The projects the portfolio counts: not yet completed, cancelled or closed.
const CURRENT_PROJECT_STATUSES: [&str; 3] = ["Planning", "Active", "On Hold"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    register_subject();
    let read = || gate.require(["portfolio:read"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(read()))
        .route("/funnel", get(funnel).route_layer(read()))
        .route("/roadmap", get(roadmap).route_layer(read()))
        .route("/settings", get(get_settings).route_layer(read()))
        .route(
            "/settings",
            put(save_settings).route_layer(gate.require([MANAGE])),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update).route_layer(read()))
        .route("/{id}", delete(remove).route_layer(read()))
        .route("/{id}/score", post(score).route_layer(read()))
        .route("/{id}/submit", post(submit).route_layer(read()))
        .route("/{id}/convert", post(convert).route_layer(read()))
        .with_state(state)
}

// ── Reading rows and bodies ─────────────────────────────────────────────────

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn row_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `scores` of a row as a map.
fn scores_of(row: &Value) -> Map<String, Value> {
    row.get("scores")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// A score as a column stores it: two decimals, or null.
fn score_text(score: Option<f64>) -> Option<String> {
    score.map(|s| to_fixed(s, 2))
}

/// The stored score of a row, as JavaScript reads it.
fn stored_score(row: &Value) -> Option<f64> {
    match row.get("score") {
        Some(Value::Null) | None => None,
        Some(value) => Some(numeric(value)),
    }
}

fn same_score(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => (a - b).abs() < f64::EPSILON,
        _ => false,
    }
}

// ── Access and events ───────────────────────────────────────────────────────

/// `mayChange(c, row)`: whoever filed the request, or `portfolio:manage`.
fn may_change(caller: &Caller, row: &Value) -> bool {
    row_text(row, "requestedBy") == Some(caller.user_id.as_str()) || caller.can(MANAGE)
}

fn publish_request(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &present_project_request(row));
}

/// The live request, or the 404.
async fn request_or_404(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    find_project_request(&caller.db, id)
        .await?
        .ok_or_else(|| Refusal::not_found(REQUEST_LABEL, id))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor.
macro_rules! request_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.status = $1)",
            " and ($2::text is null or t.title ilike $2 or t.business_case ilike $2)"
        )
    };
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (status, search, cursor, limit) = match project_requests_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(limit.as_deref(), 100, 200);
    // Ranked: the highest score first, requests without one last, ties by number.
    let cursor: Option<(String, i32)> = match &cursor {
        Some(cursor) => {
            let found: Result<Option<(i32, String)>, sqlx::Error> = sqlx::query_as(
                "select number, coalesce(score, -1)::text from project_requests where id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(&caller.db)
            .await;
            match found {
                Ok(found) => found.map(|(number, score)| (score, number)),
                Err(error) => return outside(Err(error.into())),
            }
        }
        None => None,
    };
    let search = search.as_deref().map(contains_pattern);
    reply(
        list_rows(
            &caller,
            (status.as_deref(), search.as_deref()),
            limit,
            cursor,
        )
        .await,
        "Failed to list project requests",
    )
}

async fn list_rows(
    caller: &Caller,
    (status, search): (Option<&str>, Option<&str>),
    limit: i64,
    cursor: Option<(String, i32)>,
) -> Reply {
    let db = &caller.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        request_json!("t"),
        " from project_requests t where ",
        request_filters!(),
        " and ($3::text is null or (coalesce(t.score, -1) < $3::numeric",
        " or (coalesce(t.score, -1) = $3::numeric and t.number > $4::int)))",
        " order by coalesce(t.score, -1) desc, t.number asc limit $5"
    ))
    .bind(status)
    .bind(search)
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_requests t where ",
        request_filters!()
    ))
    .bind(status)
    .bind(search)
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
    let items = rows.iter().map(present_project_request).collect();
    Ok(paged(items, total, has_more, next))
}

// ── GET /funnel ─────────────────────────────────────────────────────────────

async fn funnel(caller: Caller) -> Response {
    reply(
        read_funnel(&caller).await,
        "Failed to load the intake funnel",
    )
}

async fn read_funnel(caller: &Caller) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let week_ago =
        weldsuite_flow_domain::js::iso_from_millis(now_ms - 7 * DAY_MS).unwrap_or_default();
    let by_status: Vec<(String, i64)> = sqlx::query_as(
        "select status, count(*)::int8 from project_requests where deleted_at is null group by status",
    )
    .fetch_all(db)
    .await?;
    let recent: i64 = sqlx::query_scalar(
        "select count(*)::int8 from project_requests
         where deleted_at is null and status = 'new' and created_at >= $1::timestamptz",
    )
    .bind(week_ago)
    .fetch_one(db)
    .await?;
    let oldest: Option<i64> = sqlx::query_scalar(
        "select floor(extract(epoch from min(submitted_at)) * 1000)::int8 from project_requests
         where deleted_at is null and status = 'assessing'",
    )
    .fetch_one(db)
    .await?;
    let mut counts = Map::new();
    for status in PROJECT_REQUEST_STATUSES {
        counts.insert(status.to_owned(), json!(0));
    }
    for (status, count) in by_status {
        if counts.contains_key(&status) {
            counts.insert(status, json!(count));
        }
    }
    Ok(Data(json!({
        "counts": counts,
        "newLast7Days": recent,
        "oldestAssessingDays": oldest.map(|at| ((now_ms - at).div_euclid(DAY_MS)).max(0)),
    }))
    .into_response())
}

// ── GET /roadmap ────────────────────────────────────────────────────────────

async fn roadmap(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (from, to, tentative) = match roadmap_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let range = match roadmap_range(from.as_deref(), to.as_deref(), &today_utc()) {
        Ok(range) => range,
        Err(message) => return outside(Err(Refusal::bad_request(message))),
    };
    reply(
        build_roadmap(&caller, &range.from, &range.to, tentative).await,
        "Failed to load the roadmap",
    )
}

async fn build_roadmap(caller: &Caller, from: &str, to: &str, tentative: bool) -> Reply {
    let db = &caller.db;
    let projects: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "select p.id, p.name, p.status,
                to_char(least(p.start_date, p.end_date), 'YYYY-MM-DD'),
                to_char(greatest(p.start_date, p.end_date), 'YYYY-MM-DD')
         from projects p
         where p.deleted_at is null and p.status = any($3)
           and least(p.start_date, p.end_date)::date <= $2::date
           and greatest(p.start_date, p.end_date)::date >= $1::date
         order by p.id",
    )
    .bind(from)
    .bind(to)
    .bind(CURRENT_PROJECT_STATUSES.as_slice())
    .fetch_all(db)
    .await?;
    let requests: Vec<RequestRow> = sqlx::query_as(
        "select r.id, r.number, r.title, r.status, r.score::text,
                to_char(least(r.desired_start, r.desired_end), 'YYYY-MM-DD'),
                to_char(greatest(r.desired_start, r.desired_end), 'YYYY-MM-DD')
         from project_requests r
         where r.deleted_at is null and r.status in ('assessing', 'approved')
           and least(r.desired_start, r.desired_end)::date <= $2::date
           and greatest(r.desired_start, r.desired_end)::date >= $1::date
         order by r.id",
    )
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    let accessible = caller.accessible_project_ids().await?;

    let mut items: Vec<Value> = projects
        .into_iter()
        .map(|(id, name, status, starts_on, ends_on)| {
            let may_access = accessible.as_ref().is_none_or(|allowed| allowed.contains(&id));
            json!({
                "type": "project",
                "id": id,
                "code": null,
                "name": if may_access { name } else { weldsuite_flow_domain::capacity::OTHER_PROJECT_NAME.to_owned() },
                "accessible": may_access,
                "status": status,
                "startsOn": starts_on,
                "endsOn": ends_on,
                "score": null,
            })
        })
        .collect();
    items.extend(requests.into_iter().map(
        |(id, number, title, status, score, starts_on, ends_on)| {
            json!({
                "type": "request",
                "id": id,
                "code": request_code(i64::from(number)),
                "name": title,
                "accessible": true,
                "status": status,
                "startsOn": starts_on,
                "endsOn": ends_on,
                "score": score.map_or(Value::Null, |s| number_value(numeric(&Value::String(s)))),
            })
        },
    ));

    // The team's load over the same weeks, rolled up to quarters and months.
    let span = weeks_covering(from, to);
    let load = load_capacity(db, &span, tentative, None).await?;
    sort_roadmap_items(&mut items);
    Ok(Data(json!({
        "from": from,
        "to": to,
        "quarters": rollup_load(&load.weeks, &load.totals, from, to, true),
        "months": rollup_load(&load.weeks, &load.totals, from, to, false),
        "items": items,
    }))
    .into_response())
}

// ── Workspace settings ──────────────────────────────────────────────────────

async fn get_settings(caller: Caller) -> Response {
    let result = async {
        let settings = load_settings(&caller.db).await?;
        Ok(Data(present_settings(settings.as_ref())).into_response())
    }
    .await;
    reply(result, "Failed to fetch intake settings")
}

async fn save_settings(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = (|| {
        let input = parse_body(&body, read_settings)?;
        let model: Option<Vec<Criterion>> = input
            .get("scoringModel")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Criterion::from_json).collect());
        if let Some(model) = &model
            && let Some(message) = scoring_model_error(model)
        {
            return Err(Refusal::bad_request(message));
        }
        Ok((input, model))
    })();
    let (input, model) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_settings(&state, &caller, &input, model.as_deref()).await,
        "Failed to save intake settings",
    )
}

async fn write_settings(
    state: &FlowState,
    caller: &Caller,
    input: &Body,
    model: Option<&[Criterion]>,
) -> Reply {
    let db = &caller.db;
    let now = iso_now();
    // The board once each, in the order given.
    let board: Option<Vec<String>> = input
        .get("portfolioBoardIds")
        .and_then(Value::as_array)
        .map(|ids| {
            let mut seen = Vec::new();
            for id in ids.iter().filter_map(Value::as_str) {
                if !seen.iter().any(|s: &String| s == id) {
                    seen.push(id.to_owned());
                }
            }
            seen
        });
    let limit_given = input.contains_key("expenseApprovalLimit");
    let limit = amount_text(input.get("expenseApprovalLimit").and_then(Value::as_f64));

    // A new model re-ranks every open request: the stored scores follow it.
    let mut rescored: Vec<(String, Option<f64>)> = Vec::new();
    if let Some(model) = model {
        let open: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            request_json!("t"),
            " from project_requests t where t.deleted_at is null",
            " and t.status in ('new', 'assessing') order by t.number"
        ))
        .fetch_all(db)
        .await?;
        for row in open.into_iter().map(js_row) {
            let score = score_request(model, &scores_of(&row));
            if !same_score(score, stored_score(&row)) {
                rescored.push((row["id"].as_str().unwrap_or_default().to_owned(), score));
            }
        }
    }

    let model_json = model.map(|m| Value::Array(m.iter().map(Criterion::to_json).collect()));
    let mut statements = vec![
        sqlx::query(
            "insert into flow_workspace_settings (id, singleton, scoring_model, portfolio_board_ids,
                 expense_approval_limit, updated_by, created_at, updated_at)
             values ($1, true, coalesce($2::jsonb, $3::jsonb), coalesce($4::jsonb, '[]'::jsonb),
                 $5::numeric, $6, $7::timestamptz, $7::timestamptz)
             on conflict (singleton) do update set
                 scoring_model = coalesce($2::jsonb, flow_workspace_settings.scoring_model),
                 portfolio_board_ids = coalesce($4::jsonb, flow_workspace_settings.portfolio_board_ids),
                 expense_approval_limit = case when $8::bool then $5::numeric
                     else flow_workspace_settings.expense_approval_limit end,
                 updated_by = $6, updated_at = $7::timestamptz",
        )
        .bind(generate_id("fws"))
        .bind(model_json)
        .bind(Value::Array(
            default_scoring_model().iter().map(Criterion::to_json).collect(),
        ))
        .bind(board.map(|ids| json!(ids)))
        .bind(limit)
        .bind(caller.user_id.clone())
        .bind(now.clone())
        .bind(limit_given),
    ];
    for (id, score) in &rescored {
        statements.push(
            sqlx::query(
                "update project_requests set score = $2::numeric, updated_at = $3::timestamptz
                 where id = $1",
            )
            .bind(id.clone())
            .bind(score_text(*score))
            .bind(now.clone()),
        );
    }
    weldsuite_db::atomically(db, statements).await?;
    let Some(settings) = load_settings(db).await? else {
        return Err(Refusal::Internal("the settings are missing".to_owned()));
    };
    let shown = present_settings(Some(&settings));
    caller.publish(
        state,
        FLOW_WORKSPACE_SETTINGS_UPDATED,
        settings["id"].as_str().unwrap_or_default(),
        &shown,
    );
    for (id, _) in &rescored {
        if let Some(updated) = find_project_request(db, id).await? {
            publish_request(state, caller, PROJECT_REQUEST_UPDATED, &updated);
        }
    }
    Ok(Data(shown).into_response())
}

// ── GET /:id ────────────────────────────────────────────────────────────────

/// The skills a request needs, as the capacity fit reads them.
fn needed_skills(row: &Value) -> Vec<NeededSkill> {
    row.get("neededSkills")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|need| {
                    Some(NeededSkill {
                        skill: need.get("skill")?.as_str()?.to_owned(),
                        hours_per_week: need.get("hoursPerWeek").and_then(Value::as_f64),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        read_detail(&caller, &id).await,
        "Failed to fetch project request",
    )
}

async fn read_detail(caller: &Caller, id: &str) -> Reply {
    let row = request_or_404(caller, id).await?;
    let settings = load_settings(&caller.db).await?;
    let model = model_of(settings.as_ref());
    let approvals = list_subject_approvals(&caller.db, id).await?;

    // Free capacity of the skills the request needs, over the weeks it wants to run.
    let window = fit_range(
        row_text(&row, "desiredStart"),
        row_text(&row, "desiredEnd"),
        &today_utc(),
    );
    let needs = needed_skills(&row);
    let fit = if needs.is_empty() {
        Vec::new()
    } else {
        skill_fit(
            &load_capacity(&caller.db, &window, true, None).await?,
            &needs,
        )
    };
    let mut shown = present_project_request(&row);
    if let Value::Object(fields) = &mut shown {
        fields.insert(
            "breakdown".to_owned(),
            Value::Array(score_breakdown(&model, &scores_of(&row))),
        );
        fields.insert(
            "approvals".to_owned(),
            Value::Array(
                approvals
                    .iter()
                    .map(|a| present_request_approval(&a.to_json()))
                    .collect(),
            ),
        );
        fields.insert("fit".to_owned(), Value::Array(fit));
        fields.insert(
            "fitWindow".to_owned(),
            json!({ "from": window.from, "to": window.to }),
        );
    }
    Ok(Data(shown).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// A `neededSkills` body field as the column stores it.
fn needed_skills_json(input: &Body) -> Value {
    let list = input
        .get("neededSkills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    normalize_needed_skills(&list)
}

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = (|| {
        let input = parse_body(&body, read_create_project_request)?;
        if let Some(message) =
            desired_dates_error(text(&input, "desiredStart"), text(&input, "desiredEnd"))
        {
            return Err(Refusal::bad_request(message));
        }
        Ok(input)
    })();
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        insert_request(&state, &caller, &input).await,
        "Failed to create project request",
    )
}

async fn insert_request(state: &FlowState, caller: &Caller, input: &Body) -> Reply {
    let db = &caller.db;
    let id = generate_id("prq");
    let number = allocate_number(db, &REQUEST_SEQUENCE).await?;
    weldsuite_db::atomically(
        db,
        [sqlx::query(
            "insert into project_requests (id, number, title, requested_by, business_case,
                 estimated_cost, estimated_value, scores, score, needed_skills, desired_start,
                 desired_end, status, created_by, created_at, updated_at)
             values ($1, $2::int, $3, $4, $5, $6::numeric, $7::numeric, '{}'::jsonb, null, $8::jsonb,
                 $9::date, $10::date, 'new', $4, $11::timestamptz, $11::timestamptz)",
        )
        .bind(id.clone())
        .bind(number)
        .bind(text(input, "title").unwrap_or_default().to_owned())
        .bind(caller.user_id.clone())
        .bind(text(input, "businessCase").map(str::to_owned))
        .bind(amount_text(input.get("estimatedCost").and_then(Value::as_f64)))
        .bind(amount_text(input.get("estimatedValue").and_then(Value::as_f64)))
        .bind(needed_skills_json(input))
        .bind(text(input, "desiredStart").map(str::to_owned))
        .bind(text(input, "desiredEnd").map(str::to_owned))
        .bind(iso_now())],
    )
    .await?;
    let Some(row) = find_project_request(db, &id).await? else {
        return Err(Refusal::Internal("the new request is missing".to_owned()));
    };
    publish_request(state, caller, PROJECT_REQUEST_CREATED, &row);
    Ok(Created(present_project_request(&row)).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// A nullish field of an edit: left out keeps the row's value, `null` clears it.
fn merged_text(input: &Body, existing: &Value, key: &str) -> Option<String> {
    match input.get(key) {
        Some(value) => value.as_str().map(str::to_owned),
        None => row_text(existing, key).map(str::to_owned),
    }
}

fn merged_amount(input: &Body, existing: &Value, key: &str) -> Option<String> {
    match input.get(key) {
        Some(value) => amount_text(value.as_f64()),
        None => row_text(existing, key).map(str::to_owned),
    }
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = request_or_404(&caller, &id).await?;
        if !may_change(&caller, &existing) {
            return Err(Refusal::forbidden(intake_messages::REQUEST_FORBIDDEN));
        }
        let input = parse_body(&body, read_update_project_request)?;
        if !is_open_request_status(row_text(&existing, "status").unwrap_or_default()) {
            return Err(Refusal::conflict(intake_messages::NOT_EDITABLE));
        }
        let start = merged_text(&input, &existing, "desiredStart");
        let end = merged_text(&input, &existing, "desiredEnd");
        if let Some(message) = desired_dates_error(start.as_deref(), end.as_deref()) {
            return Err(Refusal::bad_request(message));
        }
        Ok((existing, input, start, end))
    }
    .await;
    let (existing, input, start, end) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_update(&state, &caller, &id, (&existing, &input), (start, end)).await,
        "Failed to update project request",
    )
}

async fn write_update(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    (existing, input): (&Value, &Body),
    (start, end): (Option<String>, Option<String>),
) -> Reply {
    let needed = if input.contains_key("neededSkills") {
        needed_skills_json(input)
    } else {
        existing
            .get("neededSkills")
            .cloned()
            .unwrap_or_else(|| json!([]))
    };
    weldsuite_db::atomically(
        &caller.db,
        [sqlx::query(
            "update project_requests set title = $2, business_case = $3, estimated_cost = $4::numeric,
                 estimated_value = $5::numeric, needed_skills = $6::jsonb, desired_start = $7::date,
                 desired_end = $8::date, updated_at = $9::timestamptz
             where id = $1 and deleted_at is null",
        )
        .bind(id.to_owned())
        .bind(
            text(input, "title")
                .or_else(|| row_text(existing, "title"))
                .unwrap_or_default()
                .to_owned(),
        )
        .bind(merged_text(input, existing, "businessCase"))
        .bind(merged_amount(input, existing, "estimatedCost"))
        .bind(merged_amount(input, existing, "estimatedValue"))
        .bind(needed)
        .bind(start)
        .bind(end)
        .bind(iso_now())],
    )
    .await?;
    let Some(row) = find_project_request(&caller.db, id).await? else {
        return Err(Refusal::not_found(REQUEST_LABEL, id));
    };
    publish_request(state, caller, PROJECT_REQUEST_UPDATED, &row);
    Ok(Data(present_project_request(&row)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match request_or_404(&caller, &id).await {
        Ok(existing) => existing,
        Err(refused) => return outside(Err(refused)),
    };
    if !may_change(&caller, &existing) {
        return outside(Err(Refusal::forbidden(intake_messages::REQUEST_FORBIDDEN)));
    }
    if row_text(&existing, "status") == Some("converted") {
        return outside(Err(Refusal::conflict(intake_messages::NOT_DELETABLE)));
    }
    reply(
        delete_request(&state, &caller, &id, &existing).await,
        "Failed to delete project request",
    )
}

async fn delete_request(state: &FlowState, caller: &Caller, id: &str, existing: &Value) -> Reply {
    let db = &caller.db;
    // Bookings held for the request and the board's open reviews go with it.
    let held: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        booking_json!("b"),
        " from resource_bookings b where b.request_id = $1 and b.deleted_at is null order by b.id"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    let reviews = list_subject_approvals(db, id).await?;
    let now = iso_now();
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "update project_requests set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now.clone()),
            sqlx::query(
                "update resource_bookings set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where request_id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now.clone()),
            sqlx::query(
                "update flow_approvals set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where subject_type = 'project_request' and subject_id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now),
        ],
    )
    .await?;
    publish_request(state, caller, PROJECT_REQUEST_DELETED, existing);
    for booking in held.into_iter().map(js_row) {
        let booking_id = booking["id"].as_str().unwrap_or_default();
        caller.publish(
            state,
            RESOURCE_BOOKING_DELETED,
            booking_id,
            &present_booking(&booking),
        );
    }
    announce_approvals_cancelled(state, caller, &reviews);
    Ok(NoContent.into_response())
}

// ── POST /:id/score ─────────────────────────────────────────────────────────

async fn score(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = request_or_404(&caller, &id).await?;
        let settings = load_settings(&caller.db).await?;
        if !board_of(settings.as_ref()).contains(&caller.user_id) && !caller.can(MANAGE) {
            return Err(Refusal::forbidden(intake_messages::SCORE_FORBIDDEN));
        }
        let input = parse_body(&body, read_score)?;
        if !is_open_request_status(row_text(&existing, "status").unwrap_or_default()) {
            return Err(Refusal::conflict(intake_messages::NOT_SCORABLE));
        }
        let model = model_of(settings.as_ref());
        let scores = input
            .get("scores")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(message) = scores_error(&model, &scores) {
            return Err(Refusal::bad_request(message));
        }
        Ok((model, scores))
    }
    .await;
    let (model, scores) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        write_score(&state, &caller, &id, &model, &scores).await,
        "Failed to score project request",
    )
}

async fn write_score(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    model: &[Criterion],
    scores: &Map<String, Value>,
) -> Reply {
    let computed = score_request(model, scores);
    weldsuite_db::atomically(
        &caller.db,
        [sqlx::query(
            "update project_requests set scores = $2::jsonb, score = $3::numeric,
                 updated_at = $4::timestamptz
             where id = $1 and deleted_at is null",
        )
        .bind(id.to_owned())
        .bind(Value::Object(scores.clone()))
        .bind(score_text(computed))
        .bind(iso_now())],
    )
    .await?;
    let Some(row) = find_project_request(&caller.db, id).await? else {
        return Err(Refusal::not_found(REQUEST_LABEL, id));
    };
    publish_request(state, caller, PROJECT_REQUEST_UPDATED, &row);
    let mut shown = present_project_request(&row);
    if let Value::Object(fields) = &mut shown {
        fields.insert(
            "breakdown".to_owned(),
            Value::Array(score_breakdown(model, &scores_of(&row))),
        );
    }
    Ok(Data(shown).into_response())
}

// ── POST /:id/submit ────────────────────────────────────────────────────────

async fn submit(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let checked = async {
        let existing = request_or_404(&caller, &id).await?;
        if !may_change(&caller, &existing) {
            return Err(Refusal::forbidden(intake_messages::REQUEST_FORBIDDEN));
        }
        if row_text(&existing, "status") != Some("new") {
            return Err(Refusal::conflict(intake_messages::NOT_NEW));
        }
        let settings = load_settings(&caller.db).await?;
        let mut board: Vec<String> = Vec::new();
        for member in board_of(settings.as_ref()) {
            if !board.contains(&member) {
                board.push(member);
            }
        }
        if board.is_empty() {
            return Err(Refusal::bad_request(intake_messages::NO_BOARD));
        }
        Ok(board)
    }
    .await;
    let board = match checked {
        Ok(board) => board,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        ask_board(&state, &caller, &id, &board).await,
        "Failed to submit project request",
    )
}

async fn ask_board(state: &FlowState, caller: &Caller, id: &str, board: &[String]) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = weldsuite_flow_domain::js::iso_from_millis(now_ms).unwrap_or_default();
    // Only a new request moves, so two submits at once cannot both ask the board.
    let claimed: Option<String> = sqlx::query_scalar(
        "update project_requests set status = 'assessing', submitted_at = $2::timestamptz,
             updated_at = $2::timestamptz
         where id = $1 and status = 'new' and deleted_at is null returning id",
    )
    .bind(id)
    .bind(now)
    .fetch_optional(db)
    .await?;
    if claimed.is_none() {
        return Err(Refusal::conflict(intake_messages::NOT_NEW));
    }
    let asked = async {
        let rows = request_approvals(db, id, &caller.user_id, board, now_ms).await?;
        let Some(row) = find_project_request(db, id).await? else {
            return Err(Refusal::Internal("the request is missing".to_owned()));
        };
        Ok((row, rows))
    }
    .await;
    match asked {
        Ok((row, rows)) => {
            publish_request(state, caller, PROJECT_REQUEST_SUBMITTED, &row);
            announce_approvals_requested(
                state,
                caller,
                &rows,
                &SubjectLabel {
                    code: Some(request_code(row["number"].as_i64().unwrap_or_default())),
                    title: row["title"].as_str().unwrap_or_default().to_owned(),
                },
                None,
            );
            let mut shown = present_project_request(&row);
            if let Value::Object(fields) = &mut shown {
                fields.insert(
                    "approvals".to_owned(),
                    Value::Array(
                        rows.iter()
                            .map(|r| present_request_approval(&r.to_json()))
                            .collect(),
                    ),
                );
            }
            Ok(Data(shown).into_response())
        }
        Err(refused) => {
            // Back to new, with no half-asked board.
            if let Err(error) = clear_approvals(db, id).await {
                tracing::error!(%error, "[flow-api/project-requests] approval rollback failed");
            }
            let undone = sqlx::query(
                "update project_requests set status = 'new', submitted_at = null,
                     updated_at = $2::timestamptz
                 where id = $1 and status = 'assessing'",
            )
            .bind(id)
            .bind(iso_now())
            .execute(db)
            .await;
            if let Err(error) = undone {
                tracing::error!(%error, "[flow-api/project-requests] submit rollback failed");
            }
            Err(refused)
        }
    }
}

// ── POST /:id/convert ───────────────────────────────────────────────────────

async fn convert(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = request_or_404(&caller, &id).await?;
        let input = parse_body(&body, read_convert)?;
        let project_id = text(&input, "projectId").unwrap_or_default().to_owned();
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can(MANAGE) && !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(intake_messages::CONVERT_FORBIDDEN));
        }
        if row_text(&existing, "status") != Some("approved") {
            return Err(Refusal::conflict(intake_messages::NOT_APPROVED));
        }
        let linked: Option<String> = sqlx::query_scalar(
            "select id from project_requests where project_id = $1 and deleted_at is null limit 1",
        )
        .bind(&project_id)
        .fetch_optional(&caller.db)
        .await?;
        if linked.is_some() {
            return Err(Refusal::conflict(intake_messages::PROJECT_LINKED));
        }
        Ok(project_id)
    }
    .await;
    let project_id = match checked {
        Ok(project_id) => project_id,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        link_project(&state, &caller, &id, &project_id).await,
        "Failed to convert project request",
    )
}

async fn link_project(state: &FlowState, caller: &Caller, id: &str, project_id: &str) -> Reply {
    let db = &caller.db;
    // The people held tentatively for the request move onto the project.
    let held: Vec<String> = sqlx::query_scalar(
        "select id from resource_bookings where request_id = $1 and deleted_at is null order by id",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let now = iso_now();
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "update project_requests set status = 'converted', project_id = $2,
                     updated_at = $3::timestamptz
                 where id = $1 and status = 'approved' and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(project_id.to_owned())
            .bind(now.clone()),
            sqlx::query(
                "update resource_bookings set project_id = $2, request_id = null,
                     updated_at = $3::timestamptz
                 where request_id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(project_id.to_owned())
            .bind(now),
        ],
    )
    .await?;
    let Some(row) = find_project_request(db, id).await? else {
        return Err(Refusal::not_found(REQUEST_LABEL, id));
    };
    publish_request(state, caller, PROJECT_REQUEST_CONVERTED, &row);
    for booking_id in &held {
        let moved: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            booking_json!("b"),
            " from resource_bookings b where b.id = $1 limit 1"
        ))
        .bind(booking_id)
        .fetch_optional(db)
        .await?;
        if let Some(moved) = moved.map(js_row) {
            caller.publish(
                state,
                RESOURCE_BOOKING_UPDATED,
                booking_id,
                &present_booking(&moved),
            );
        }
    }
    Ok(Data(present_project_request(&row)).into_response())
}

/// Plug the `project_request` subject in (idempotent): its handler and the
/// aftermath that publishes the outcome.
pub(crate) fn register_subject() {
    store::register_subject(aftermath);
}

fn aftermath<'a>(
    state: &'a FlowState,
    caller: &'a Caller,
    info: &'a AftermathInfo,
) -> AftermathFuture<'a> {
    Box::pin(publish_project_request_outcome(
        state,
        caller,
        &info.subject_id,
        info.outcome,
    ))
}

/// `publishProjectRequestOutcome`: tell the entity-event bus a request was
/// approved or rejected once the approvals core settled it (the handler has no
/// request context, so the aftermath of `/api/approvals/:id/decide` calls this).
async fn publish_project_request_outcome(
    state: &FlowState,
    caller: &Caller,
    request_id: &str,
    outcome: ResolvedApprovalOutcome,
) -> Result<(), sqlx::Error> {
    let Some(row) = find_project_request(&caller.db, request_id).await? else {
        return Ok(());
    };
    let event = match outcome {
        ResolvedApprovalOutcome::Approved => {
            weldsuite_catalogs::entity_events::PROJECT_REQUEST_APPROVED
        }
        ResolvedApprovalOutcome::Rejected => {
            weldsuite_catalogs::entity_events::PROJECT_REQUEST_REJECTED
        }
    };
    publish_request(state, caller, event, &row);
    Ok(())
}
