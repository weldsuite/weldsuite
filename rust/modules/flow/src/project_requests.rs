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

use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::Date;
use time::macros::format_description;
use weldsuite_catalogs::entity_events::{
    EventName, FLOW_WORKSPACE_SETTINGS_UPDATED, PROJECT_REQUEST_CONVERTED, PROJECT_REQUEST_CREATED,
    PROJECT_REQUEST_DELETED, PROJECT_REQUEST_SUBMITTED, PROJECT_REQUEST_UPDATED,
    RESOURCE_BOOKING_DELETED, RESOURCE_BOOKING_UPDATED,
};
use weldsuite_db::{OrmConn, orm};
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
use weldsuite_schema::tenant::project_requests::{self, Column};
use weldsuite_schema::tenant::{flow_approvals, flow_workspace_settings, projects, resource_bookings};

use self::store::{
    board_of, clear_approvals, find_project_request, instant, js, list_subject_approvals,
    load_settings, model_of, request_approvals,
};
use crate::approvals::announce::{
    AftermathFuture, AftermathInfo, SubjectLabel, announce_approvals_cancelled,
    announce_approvals_requested,
};
use crate::capacity::body::{
    Body, parse_body, project_requests_query, read_convert, read_create_project_request,
    read_score, read_settings, read_update_project_request, roadmap_query,
};
use crate::capacity::store::load_capacity;
use crate::capacity::{parse_limit, today_utc};
use crate::raid_store::live_project_exists;
use crate::{Caller, FlowState, Refusal, Reply, outside, page, paged, reply};

/// A request as the roadmap query reads it.
type RequestRow = (
    String,
    i32,
    String,
    String,
    Option<BigDecimal>,
    String,
    String,
);

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

/// A `numeric` column's value from its text (`$n::numeric`).
fn decimal(text: Option<String>) -> Result<Option<BigDecimal>, DbErr> {
    text.map(|text| {
        BigDecimal::from_str(&text)
            .map_err(|_| DbErr::Custom(format!("invalid input syntax for type numeric: \"{text}\"")))
    })
    .transpose()
}

/// A `date` column's value from its `YYYY-MM-DD` text (`$n::date`).
fn day(text: Option<&str>) -> Result<Option<Date>, DbErr> {
    text.map(|text| {
        Date::parse(text, format_description!("[year]-[month]-[day]"))
            .map_err(|_| DbErr::Custom(format!("date/time field value out of range: \"{text}\"")))
    })
    .transpose()
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

/// The list's `where`, without the cursor: the status and the search.
fn request_filters(status: Option<&str>, search: Option<&str>) -> Condition {
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(status) = status {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(search) = search {
        filters = filters.add(
            Condition::any()
                .add(Column::Title.ilike(search))
                .add(Column::BusinessCase.ilike(search)),
        );
    }
    filters
}

/// `coalesce(t.score, -1)`: the rank, requests without a score last.
fn ranked_score() -> Expr {
    Expr::expr(Func::coalesce([Expr::col(Column::Score), Expr::value(-1)]))
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (status, search, cursor, limit) = match project_requests_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(limit.as_deref(), 100, 200);
    // Ranked: the highest score first, requests without one last, ties by number.
    let cursor: Option<(BigDecimal, i32)> = match &cursor {
        Some(cursor) => {
            let found: Result<Option<(i32, Option<BigDecimal>)>, DbErr> =
                project_requests::Entity::find_by_id(cursor.as_str())
                    .select_only()
                    .columns([Column::Number, Column::Score])
                    .into_tuple()
                    .one(&orm(&caller.db))
                    .await;
            match found {
                Ok(found) => found.map(|(number, score)| {
                    (score.unwrap_or_else(|| BigDecimal::from(-1)), number)
                }),
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
    cursor: Option<(BigDecimal, i32)>,
) -> Reply {
    use sea_orm::ExprTrait as _;

    let db = &orm(&caller.db);
    let mut select = project_requests::Entity::find().filter(request_filters(status, search));
    if let Some((score, number)) = cursor {
        select = select.filter(
            Condition::any().add(ranked_score().lt(score.clone())).add(
                Condition::all()
                    .add(ranked_score().eq(score))
                    .add(Column::Number.gt(number)),
            ),
        );
    }
    let rows = select
        .order_by(ranked_score(), Order::Desc)
        .order_by_asc(Column::Number)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(db)
        .await?;
    let total = project_requests::Entity::find()
        .filter(request_filters(status, search))
        .count(db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
    let (rows, has_more, next) = page(rows, limit);
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
    let db = &orm(&caller.db);
    let now_ms = crate::now_ms();
    let week_ago = instant(now_ms - 7 * DAY_MS);
    let by_status: Vec<(String, i64)> = project_requests::Entity::find()
        .select_only()
        .column(Column::Status)
        .column_as(Expr::expr(Func::count(Expr::col(Asterisk))), "count")
        .filter(Column::DeletedAt.is_null())
        .group_by(Column::Status)
        .into_tuple()
        .all(db)
        .await?;
    let recent = project_requests::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.eq("new"))
        .filter(Column::CreatedAt.gte(week_ago))
        .count(db)
        .await?;
    let recent = i64::try_from(recent).unwrap_or(i64::MAX);
    // `floor(extract(epoch from min(submitted_at)) * 1000)`: milliseconds.
    let oldest: Option<Option<time::OffsetDateTime>> = project_requests::Entity::find()
        .select_only()
        .column_as(Column::SubmittedAt.min(), "oldest")
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.eq("assessing"))
        .into_tuple()
        .one(db)
        .await?;
    let oldest = oldest.flatten().map(|at| {
        i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).unwrap_or_default()
    });
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

/// `to_char(at, 'YYYY-MM-DD')`.
fn day_text(at: Expr) -> Expr {
    Func::cust("to_char").arg(at).arg("YYYY-MM-DD").into()
}

/// `least(start, end)::date <= to and greatest(start, end)::date >= from`:
/// the span between two dates (either may be missing) overlaps the range.
fn overlaps<C: ColumnTrait>(start: C, end: C, from: &str, to: &str) -> Condition {
    use sea_orm::ExprTrait as _;

    let date = |text: &str| Expr::value(text.to_owned()).cast_as("date");
    Condition::all()
        .add(
            Expr::expr(Func::least([Expr::col(start), Expr::col(end)]))
                .cast_as("date")
                .lte(date(to)),
        )
        .add(
            Expr::expr(Func::greatest([Expr::col(start), Expr::col(end)]))
                .cast_as("date")
                .gte(date(from)),
        )
}

async fn build_roadmap(caller: &Caller, from: &str, to: &str, tentative: bool) -> Reply {
    use projects::Column as Project;

    let db = &caller.db;
    let projects: Vec<(String, String, String, String, String)> = projects::Entity::find()
        .select_only()
        .columns([Project::Id, Project::Name, Project::Status])
        .column_as(
            day_text(Func::least([Expr::col(Project::StartDate), Expr::col(Project::EndDate)]).into()),
            "starts_on",
        )
        .column_as(
            day_text(
                Func::greatest([Expr::col(Project::StartDate), Expr::col(Project::EndDate)]).into(),
            ),
            "ends_on",
        )
        .filter(Project::DeletedAt.is_null())
        .filter(Project::Status.is_in(CURRENT_PROJECT_STATUSES))
        .filter(overlaps(Project::StartDate, Project::EndDate, from, to))
        .order_by_asc(Project::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let requests: Vec<RequestRow> = project_requests::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Number, Column::Title, Column::Status, Column::Score])
        .column_as(
            day_text(Func::least([Expr::col(Column::DesiredStart), Expr::col(Column::DesiredEnd)]).into()),
            "starts_on",
        )
        .column_as(
            day_text(
                Func::greatest([Expr::col(Column::DesiredStart), Expr::col(Column::DesiredEnd)])
                    .into(),
            ),
            "ends_on",
        )
        .filter(Column::DeletedAt.is_null())
        .filter(Column::Status.is_in(["assessing", "approved"]))
        .filter(overlaps(Column::DesiredStart, Column::DesiredEnd, from, to))
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(db))
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
                // `score::text`: two decimals, as JavaScript reads the number.
                "score": score.map_or(Value::Null, |s| {
                    number_value(numeric(&Value::String(s.with_scale(2).to_plain_string())))
                }),
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
    let now = instant(crate::now_ms());
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
    let limit = decimal(amount_text(
        input.get("expenseApprovalLimit").and_then(Value::as_f64),
    ))?;

    // A new model re-ranks every open request: the stored scores follow it.
    let mut rescored: Vec<(String, Option<f64>)> = Vec::new();
    if let Some(model) = model {
        let open = project_requests::Entity::find()
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Status.is_in(["new", "assessing"]))
            .order_by_asc(Column::Number)
            .all(&orm(db))
            .await?;
        for row in open.into_iter().map(js) {
            let row = row?;
            let score = score_request(model, &scores_of(&row));
            if !same_score(score, stored_score(&row)) {
                rescored.push((row["id"].as_str().unwrap_or_default().to_owned(), score));
            }
        }
    }

    let model_json = model.map(|m| Value::Array(m.iter().map(Criterion::to_json).collect()));
    let upsert = upsert_settings(caller, model_json, board, (limit, limit_given), now);
    let score_updates = rescored
        .iter()
        .map(|(id, score)| {
            Ok(project_requests::Entity::update_many()
                .col_expr(Column::Score, Expr::value(decimal(score_text(*score))?))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id.as_str())))
        })
        .collect::<Result<Vec<_>, DbErr>>()?;
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            upsert.exec_without_returning(&tx).await?;
            for update in score_updates {
                update.exec(&tx).await?;
            }
            Ok::<_, Refusal>(())
        })
    })
    .await?;
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

/// The settings row written as sent: created on the first save (the default
/// model and an empty board unless sent), else only the fields sent change
/// (`on conflict (singleton) do update`).
fn upsert_settings(
    caller: &Caller,
    model: Option<Value>,
    board: Option<Vec<String>>,
    (limit, limit_given): (Option<BigDecimal>, bool),
    now: time::OffsetDateTime,
) -> sea_orm::Insert<flow_workspace_settings::ActiveModel> {
    use flow_workspace_settings::Column as Settings;

    let mut changed = vec![Settings::UpdatedBy, Settings::UpdatedAt];
    if model.is_some() {
        changed.push(Settings::ScoringModel);
    }
    if board.is_some() {
        changed.push(Settings::PortfolioBoardIds);
    }
    if limit_given {
        changed.push(Settings::ExpenseApprovalLimit);
    }
    flow_workspace_settings::Entity::insert(flow_workspace_settings::ActiveModel {
        id: Set(generate_id("fws")),
        singleton: Set(true),
        scoring_model: Set(model.unwrap_or_else(|| {
            Value::Array(default_scoring_model().iter().map(Criterion::to_json).collect())
        })),
        portfolio_board_ids: Set(board.map_or_else(|| json!([]), |ids| json!(ids))),
        expense_approval_limit: Set(limit),
        updated_by: Set(Some(caller.user_id.clone())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(Settings::Singleton)
            .update_columns(changed)
            .to_owned(),
    )
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
    let number = i32::try_from(number)
        .map_err(|_| DbErr::Custom(format!("integer out of range: {number}")))?;
    let now = instant(crate::now_ms());
    project_requests::Entity::insert(project_requests::ActiveModel {
        id: Set(id.clone()),
        number: Set(number),
        title: Set(text(input, "title").unwrap_or_default().to_owned()),
        requested_by: Set(caller.user_id.clone()),
        business_case: Set(text(input, "businessCase").map(str::to_owned)),
        estimated_cost: Set(decimal(amount_text(
            input.get("estimatedCost").and_then(Value::as_f64),
        ))?),
        estimated_value: Set(decimal(amount_text(
            input.get("estimatedValue").and_then(Value::as_f64),
        ))?),
        scores: Set(json!({})),
        score: Set(None),
        needed_skills: Set(needed_skills_json(input)),
        desired_start: Set(day(text(input, "desiredStart"))?),
        desired_end: Set(day(text(input, "desiredEnd"))?),
        status: Set("new".to_owned()),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
    let title = text(input, "title")
        .or_else(|| row_text(existing, "title"))
        .unwrap_or_default();
    project_requests::Entity::update_many()
        .col_expr(Column::Title, Expr::value(title))
        .col_expr(
            Column::BusinessCase,
            Expr::value(merged_text(input, existing, "businessCase")),
        )
        .col_expr(
            Column::EstimatedCost,
            Expr::value(decimal(merged_amount(input, existing, "estimatedCost"))?),
        )
        .col_expr(
            Column::EstimatedValue,
            Expr::value(decimal(merged_amount(input, existing, "estimatedValue"))?),
        )
        .col_expr(Column::NeededSkills, Expr::value(needed))
        .col_expr(Column::DesiredStart, Expr::value(day(start.as_deref())?))
        .col_expr(Column::DesiredEnd, Expr::value(day(end.as_deref())?))
        .col_expr(Column::UpdatedAt, Expr::value(instant(crate::now_ms())))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
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
    let held = resource_bookings::Entity::find()
        .filter(resource_bookings::Column::RequestId.eq(id))
        .filter(resource_bookings::Column::DeletedAt.is_null())
        .order_by_asc(resource_bookings::Column::Id)
        .all(&orm(db))
        .await?;
    let held = held.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
    let reviews = list_subject_approvals(db, id).await?;
    let now = instant(crate::now_ms());
    let id_owned = id.to_owned();
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            let id = id_owned.as_str();
            project_requests::Entity::update_many()
                .col_expr(Column::DeletedAt, Expr::value(now))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            resource_bookings::Entity::update_many()
                .col_expr(resource_bookings::Column::DeletedAt, Expr::value(now))
                .col_expr(resource_bookings::Column::UpdatedAt, Expr::value(now))
                .filter(resource_bookings::Column::RequestId.eq(id))
                .filter(resource_bookings::Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            flow_approvals::Entity::update_many()
                .col_expr(flow_approvals::Column::DeletedAt, Expr::value(now))
                .col_expr(flow_approvals::Column::UpdatedAt, Expr::value(now))
                .filter(flow_approvals::Column::SubjectType.eq("project_request"))
                .filter(flow_approvals::Column::SubjectId.eq(id))
                .filter(flow_approvals::Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    publish_request(state, caller, PROJECT_REQUEST_DELETED, existing);
    for booking in held {
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
    project_requests::Entity::update_many()
        .col_expr(Column::Scores, Expr::value(Value::Object(scores.clone())))
        .col_expr(Column::Score, Expr::value(decimal(score_text(computed))?))
        .col_expr(Column::UpdatedAt, Expr::value(instant(crate::now_ms())))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
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
    let now = instant(now_ms);
    // Only a new request moves, so two submits at once cannot both ask the board.
    let claimed = project_requests::Entity::update_many()
        .col_expr(Column::Status, Expr::value("assessing"))
        .col_expr(Column::SubmittedAt, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::Status.eq("new"))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    if claimed.rows_affected == 0 {
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
            let undone = project_requests::Entity::update_many()
                .col_expr(Column::Status, Expr::value("new"))
                .col_expr(
                    Column::SubmittedAt,
                    Expr::value(Option::<time::OffsetDateTime>::None),
                )
                .col_expr(Column::UpdatedAt, Expr::value(instant(crate::now_ms())))
                .filter(Column::Id.eq(id))
                .filter(Column::Status.eq("assessing"))
                .exec(&orm(db))
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
        let linked: Option<String> = project_requests::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::ProjectId.eq(project_id.as_str()))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
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
    use resource_bookings::Column as Booking;

    let db = &caller.db;
    // The people held tentatively for the request move onto the project.
    let held: Vec<String> = resource_bookings::Entity::find()
        .select_only()
        .column(Booking::Id)
        .filter(Booking::RequestId.eq(id))
        .filter(Booking::DeletedAt.is_null())
        .order_by_asc(Booking::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let now = instant(crate::now_ms());
    let (id_owned, project_owned) = (id.to_owned(), project_id.to_owned());
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            let (id, project_id) = (id_owned.as_str(), project_owned.as_str());
            project_requests::Entity::update_many()
                .col_expr(Column::Status, Expr::value("converted"))
                .col_expr(Column::ProjectId, Expr::value(project_id))
                .col_expr(Column::UpdatedAt, Expr::value(now))
                .filter(Column::Id.eq(id))
                .filter(Column::Status.eq("approved"))
                .filter(Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            resource_bookings::Entity::update_many()
                .col_expr(Booking::ProjectId, Expr::value(project_id))
                .col_expr(Booking::RequestId, Expr::value(Option::<String>::None))
                .col_expr(Booking::UpdatedAt, Expr::value(now))
                .filter(Booking::RequestId.eq(id))
                .filter(Booking::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    let Some(row) = find_project_request(db, id).await? else {
        return Err(Refusal::not_found(REQUEST_LABEL, id));
    };
    publish_request(state, caller, PROJECT_REQUEST_CONVERTED, &row);
    for booking_id in &held {
        let moved = resource_bookings::Entity::find_by_id(booking_id.as_str())
            .one(&orm(db))
            .await?
            .map(js)
            .transpose()?;
        if let Some(moved) = moved {
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
) -> Result<(), DbErr> {
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
