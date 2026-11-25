//! `/api/capacity` (`routes/capacity/index.ts`): load per member and ISO week,
//! bookings, resource requests and member profiles (design:
//! weldflow-delivery-and-portfolio.md, "Capacity").
//!
//! ```text
//! GET    /                          load per member and ISO week (?from&to&skill&tentative)
//! GET    /bookings                  list (memberId, projectId, requestId, from, to, cursor)
//! POST   /bookings                  book a member on a project, or tentatively for a request
//! PATCH  /bookings/:id              change the period, the hours or tentative
//! DELETE /bookings/:id              soft delete; a request booked by it opens again
//! GET    /requests                  resource requests (projectId, status, cursor)
//! POST   /requests                  a project asks for a skill, hours per week, a period
//! PATCH  /requests/:id              edit or cancel an open request
//! DELETE /requests/:id              soft delete
//! GET    /requests/:id/suggestions  people with the skill, by free hours
//! POST   /requests/:id/book         book a member on it (firm or tentative)
//! GET    /profiles                  every member profile
//! GET    /profiles/:memberId        one profile (defaults when there is none)
//! PUT    /profiles/:memberId        weekly hours and skills (portfolio:manage, or your own)
//! ```
//!
//! The checks run in TypeScript's order: permission, then the row (404), then
//! access (403), then the body (400), then the rules. Capacity is
//! workspace-level: project names come back only for projects the caller is a
//! member of ("Other project" otherwise), and task titles never do.

pub(crate) mod body;
pub(crate) mod store;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, FLOW_MEMBER_PROFILE_UPDATED, RESOURCE_BOOKING_CREATED, RESOURCE_BOOKING_DELETED,
    RESOURCE_BOOKING_UPDATED, RESOURCE_REQUEST_CREATED, RESOURCE_REQUEST_DELETED,
    RESOURCE_REQUEST_UPDATED,
};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_flow_domain::capacity::{
    ResourceNeed, booking_target_error, capacity_range, fit_range, format_date, hours_text,
    messages, normalize_skills, period_error, present_booking, present_profile,
    present_resource_request, resource_request_event_data, round2, suggest_members,
};
use weldsuite_flow_domain::js::{number_value, parse_int, to_fixed};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    flow_member_profiles as profiles, project_requests, resource_bookings as bookings,
    resource_requests,
};

use self::body::{
    Body, bookings_query, capacity_query, parse_body, read_book, read_create_booking,
    read_create_resource_request, read_profile, read_update_booking, read_update_resource_request,
    requests_query,
};
use self::store::{
    ProjectLabel, date, decimal, find_booking, find_profile, find_resource_request, label_of,
    load_capacity, project_labels,
};
use crate::raid_store::live_project_exists;
use crate::{
    Caller, FlowState, Refusal, Reply, fetch_limit, json_rows, keyset_before, keyset_cursor_tz,
    outside, page, paged, reply,
};

const BOOKING_LABEL: &str = "Booking";
const REQUEST_LABEL: &str = "Resource request";
const MANAGE: &str = "portfolio:manage";

/// The request statuses a booking can still be held for.
const HELD_REQUEST_STATUSES: [&str; 3] = ["new", "assessing", "approved"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["portfolio:read"]);
    let write = || gate.require(["portfolio:manage", "projects:update"]);
    Router::new()
        .route("/", get(load).route_layer(read()))
        .route("/bookings", get(list_bookings).route_layer(read()))
        .route("/bookings", post(create_booking).route_layer(write()))
        .route("/bookings/{id}", patch(update_booking).route_layer(write()))
        .route(
            "/bookings/{id}",
            delete(remove_booking).route_layer(write()),
        )
        .route("/requests", get(list_requests).route_layer(read()))
        .route("/requests", post(create_request).route_layer(write()))
        .route("/requests/{id}", patch(update_request).route_layer(write()))
        .route(
            "/requests/{id}",
            delete(remove_request).route_layer(write()),
        )
        .route(
            "/requests/{id}/suggestions",
            get(suggestions).route_layer(read()),
        )
        .route(
            "/requests/{id}/book",
            post(book_request).route_layer(write()),
        )
        .route("/profiles", get(list_profiles).route_layer(read()))
        .route(
            "/profiles/{member_id}",
            get(get_profile).route_layer(read()),
        )
        .route(
            "/profiles/{member_id}",
            put(save_profile).route_layer(read()),
        )
        .with_state(state)
}

// ── Reading bodies and rows ─────────────────────────────────────────────────

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

fn number(body: &Body, key: &str) -> Option<f64> {
    body.get(key).and_then(Value::as_f64)
}

fn row_text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `new Date()` as the `timestamptz` it is written as (UTC, milliseconds).
fn now_at() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// `todayUtc()`: today as `YYYY-MM-DD` (UTC).
pub(crate) fn today_utc() -> String {
    format_date(crate::now_ms().div_euclid(86_400_000))
}

/// `parseLimit(raw, fallback, max)`: a missing, non-numeric or non-positive
/// value is the fallback.
pub(crate) fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

// ── Access ──────────────────────────────────────────────────────────────────

/// `mayBook(c, { memberId, projectId })`: `portfolio:manage` books anyone
/// anywhere; otherwise a manager of the project books on it, and a member who
/// can write to a project books themselves on it.
async fn may_book(
    caller: &Caller,
    member_id: &str,
    project_id: Option<&str>,
) -> Result<bool, DbErr> {
    if caller.can(MANAGE) {
        return Ok(true);
    }
    let Some(project) = project_id.filter(|p| !p.is_empty()) else {
        return Ok(false);
    };
    if caller.can_manage(project).await? {
        return Ok(true);
    }
    Ok(member_id == caller.user_id && caller.can_write(project).await?)
}

/// `mayRequestFor(c, projectId)`: `portfolio:manage`, or a manager of the project.
pub(crate) async fn may_request_for(caller: &Caller, project_id: &str) -> Result<bool, DbErr> {
    if caller.can(MANAGE) {
        return Ok(true);
    }
    caller.can_manage(project_id).await
}

// ── Events ──────────────────────────────────────────────────────────────────

pub(crate) fn publish_booking(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &present_booking(row));
}

fn publish_resource_request(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &resource_request_event_data(row));
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn load(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (from, to, skill, tentative) = match capacity_query(raw.as_deref()) {
        Ok(query) => query,
        Err(refused) => return outside(Err(refused)),
    };
    let range = match capacity_range(from.as_deref(), to.as_deref(), &today_utc()) {
        Ok(range) => range,
        Err(message) => return outside(Err(Refusal::bad_request(message))),
    };
    let result = async {
        let load = load_capacity(&caller.db, &range, tentative, skill.as_deref()).await?;
        let response = present_load(&caller, &load, &range.from, &range.to, tentative).await?;
        Ok(Data(response).into_response())
    }
    .await;
    reply(result, "Failed to load capacity")
}

/// `presentLoad(c, load, range, includeTentative)`: the load as the capacity
/// route answers it, each project row named for the caller.
async fn present_load(
    caller: &Caller,
    load: &weldsuite_flow_domain::capacity::CapacityLoad,
    from: &str,
    to: &str,
    tentative: bool,
) -> Result<Value, DbErr> {
    let project_ids: Vec<String> = load
        .members
        .iter()
        .flat_map(|m| m.projects.iter().filter_map(|p| p.project_id.clone()))
        .collect();
    let mut request_ids: Vec<String> = load
        .members
        .iter()
        .flat_map(|m| m.projects.iter().filter_map(|p| p.request_id.clone()))
        .collect();
    request_ids.sort();
    request_ids.dedup();
    let labels = project_labels(caller, &project_ids).await?;
    let titles: HashMap<String, String> = if request_ids.is_empty() {
        HashMap::new()
    } else {
        let rows: Vec<(String, String)> = project_requests::Entity::find()
            .select_only()
            .columns([
                project_requests::Column::Id,
                project_requests::Column::Title,
            ])
            .filter(project_requests::Column::Id.is_in(request_ids))
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        rows.into_iter().collect()
    };
    let members: Vec<Value> = load
        .members
        .iter()
        .map(|member| {
            let projects: Vec<Value> = member
                .projects
                .iter()
                .map(|row| {
                    let (name, accessible) = match row.project_id.as_deref() {
                        Some(project) => {
                            let label = label_of(&labels, project);
                            (label.name, label.accessible)
                        }
                        None => (
                            titles
                                .get(row.request_id.as_deref().unwrap_or_default())
                                .cloned()
                                .unwrap_or_else(|| {
                                    weldsuite_flow_domain::capacity::OTHER_PROJECT_NAME.to_owned()
                                }),
                            true,
                        ),
                    };
                    json!({
                        "projectId": row.project_id,
                        "requestId": row.request_id,
                        "name": name,
                        "accessible": accessible,
                        "hours": row.hours.iter().map(|h| number_value(*h)).collect::<Vec<_>>(),
                        "tentativeHours": row.tentative_hours.iter().map(|h| number_value(*h)).collect::<Vec<_>>(),
                    })
                })
                .collect();
            json!({
                "memberId": member.member_id,
                "weeklyHours": number_value(member.weekly_hours),
                "skills": member.skills,
                "hasProfile": member.has_profile,
                "cells": member.cells.iter().map(weldsuite_flow_domain::capacity::CapacityCell::to_json).collect::<Vec<_>>(),
                "projects": projects,
            })
        })
        .collect();
    Ok(json!({
        "from": from,
        "to": to,
        "tentative": tentative,
        "weeks": load.weeks.iter().map(weldsuite_flow_domain::capacity::CapacityWeek::to_json).collect::<Vec<_>>(),
        "totals": load.totals.iter().map(weldsuite_flow_domain::capacity::CapacityTotals::to_json).collect::<Vec<_>>(),
        "members": members,
        "summary": load.summary.to_json(),
    }))
}

// ── Bookings ────────────────────────────────────────────────────────────────

async fn list_bookings(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match bookings_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 50, 200);
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor_tz(
            &caller.db,
            bookings::Column::Id,
            bookings::Column::CreatedAt,
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
        list_booking_rows(&caller, &q, limit, cursor).await,
        "Failed to list bookings",
    )
}

/// The list's `where`, without the cursor.
fn booking_filters(q: &body::BookingsQuery) -> Result<Condition, DbErr> {
    let mut filters = Condition::all().add(bookings::Column::DeletedAt.is_null());
    for (value, column) in [
        (&q.member_id, bookings::Column::MemberId),
        (&q.project_id, bookings::Column::ProjectId),
        (&q.request_id, bookings::Column::RequestId),
    ] {
        if let Some(value) = value.as_deref() {
            filters = filters.add(column.eq(value));
        }
    }
    if let Some(to) = q.to.as_deref() {
        filters = filters.add(bookings::Column::StartsOn.lte(date(to)?));
    }
    if let Some(from) = q.from.as_deref() {
        filters = filters.add(bookings::Column::EndsOn.gte(date(from)?));
    }
    Ok(filters)
}

async fn list_booking_rows(
    caller: &Caller,
    q: &body::BookingsQuery,
    limit: i64,
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    let db = orm(&caller.db);
    let filters = booking_filters(q)?;
    let mut page_filters = filters.clone();
    if let Some(cursor) = &cursor {
        page_filters = page_filters.add(keyset_before(
            bookings::Column::Id,
            bookings::Column::CreatedAt,
            cursor,
        ));
    }
    let rows = bookings::Entity::find()
        .filter(page_filters)
        .order_by_desc(bookings::Column::CreatedAt)
        .order_by_desc(bookings::Column::Id)
        .limit(fetch_limit(limit)?)
        .all(&db)
        .await?;
    let total = bookings::Entity::find().filter(filters).count(&db).await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let (rows, has_more, next) = page(json_rows(rows)?, limit);
    let items = rows.iter().map(present_booking).collect();
    Ok(paged(items, total, has_more, next))
}

async fn create_booking(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_booking)?;
        let project_id = text(&input, "projectId");
        let request_id = text(&input, "requestId");
        if let Some(message) = booking_target_error(project_id, request_id) {
            return Err(Refusal::bad_request(message));
        }
        let (starts_on, ends_on) = (
            text(&input, "startsOn").unwrap_or_default(),
            text(&input, "endsOn").unwrap_or_default(),
        );
        if let Some(message) = period_error(starts_on, ends_on) {
            return Err(Refusal::bad_request(message));
        }
        let tentative = input
            .get("tentative")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if request_id.is_some() && !tentative {
            return Err(Refusal::bad_request(messages::HELD_BOOKING_TENTATIVE));
        }
        let member_id = text(&input, "memberId").unwrap_or_default();
        if !may_book(&caller, member_id, project_id).await? {
            return Err(Refusal::forbidden(messages::BOOKING_FORBIDDEN));
        }
        if let Some(project) = project_id
            && !live_project_exists(&caller.db, project).await?
        {
            return Err(Refusal::not_found("Project", project));
        }
        if let Some(request) = request_id {
            let status: Option<String> = project_requests::Entity::find()
                .select_only()
                .column(project_requests::Column::Status)
                .filter(project_requests::Column::Id.eq(request))
                .filter(project_requests::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
            let Some(status) = status else {
                return Err(Refusal::not_found("Project request", request));
            };
            if !HELD_REQUEST_STATUSES.contains(&status.as_str()) {
                return Err(Refusal::conflict(messages::HELD_REQUEST_CLOSED));
            }
        }
        Ok((input, tentative))
    }
    .await;
    let (input, tentative) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        insert_booking(&state, &caller, &input, tentative).await,
        "Failed to create booking",
    )
}

async fn insert_booking(
    state: &FlowState,
    caller: &Caller,
    input: &Body,
    tentative: bool,
) -> Reply {
    let id = generate_id("bkg");
    let now = now_at();
    bookings::Entity::insert(bookings::ActiveModel {
        id: Set(id.clone()),
        member_id: Set(text(input, "memberId").unwrap_or_default().to_owned()),
        project_id: Set(text(input, "projectId").map(str::to_owned)),
        request_id: Set(text(input, "requestId").map(str::to_owned)),
        starts_on: Set(date(text(input, "startsOn").unwrap_or_default())?),
        ends_on: Set(date(text(input, "endsOn").unwrap_or_default())?),
        hours_per_week: Set(decimal(&hours_text(
            number(input, "hoursPerWeek").unwrap_or_default(),
        ))?),
        tentative: Set(tentative),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    let Some(row) = find_booking(&caller.db, &id).await? else {
        return Err(Refusal::Internal("the new booking is missing".to_owned()));
    };
    publish_booking(state, caller, RESOURCE_BOOKING_CREATED, &row);
    Ok(Created(present_booking(&row)).into_response())
}

/// The live booking and the caller's right to change it: the 404 and 403 checks every write runs before its body.
async fn writable_booking(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let Some(existing) = find_booking(&caller.db, id).await? else {
        return Err(Refusal::not_found(BOOKING_LABEL, id));
    };
    let member = row_text(&existing, "memberId").unwrap_or_default();
    if !may_book(caller, member, row_text(&existing, "projectId")).await? {
        return Err(Refusal::forbidden(messages::BOOKING_FORBIDDEN));
    }
    Ok(existing)
}

async fn update_booking(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = writable_booking(&caller, &id).await?;
        let input = parse_body(&body, read_update_booking)?;
        let starts_on = text(&input, "startsOn")
            .or_else(|| row_text(&existing, "startsOn"))
            .unwrap_or_default()
            .to_owned();
        let ends_on = text(&input, "endsOn")
            .or_else(|| row_text(&existing, "endsOn"))
            .unwrap_or_default()
            .to_owned();
        if let Some(message) = period_error(&starts_on, &ends_on) {
            return Err(Refusal::bad_request(message));
        }
        let tentative = input
            .get("tentative")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| existing["tentative"].as_bool().unwrap_or(false));
        if !existing["requestId"].is_null() && !tentative {
            return Err(Refusal::bad_request(messages::HELD_BOOKING_TENTATIVE));
        }
        let hours = match number(&input, "hoursPerWeek") {
            Some(hours) => hours_text(hours),
            None => row_text(&existing, "hoursPerWeek")
                .unwrap_or_default()
                .to_owned(),
        };
        Ok((starts_on, ends_on, hours, tentative))
    }
    .await;
    let (starts_on, ends_on, hours, tentative) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    let result = async {
        bookings::Entity::update_many()
            .col_expr(bookings::Column::StartsOn, Expr::value(date(&starts_on)?))
            .col_expr(bookings::Column::EndsOn, Expr::value(date(&ends_on)?))
            .col_expr(
                bookings::Column::HoursPerWeek,
                Expr::value(decimal(&hours)?),
            )
            .col_expr(bookings::Column::Tentative, Expr::value(tentative))
            .col_expr(bookings::Column::UpdatedAt, Expr::value(now_at()))
            .filter(bookings::Column::Id.eq(&id))
            .filter(bookings::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        let Some(row) = find_booking(&caller.db, &id).await? else {
            return Err(Refusal::not_found(BOOKING_LABEL, &id));
        };
        publish_booking(&state, &caller, RESOURCE_BOOKING_UPDATED, &row);
        Ok(Data(present_booking(&row)).into_response())
    }
    .await;
    reply(result, "Failed to update booking")
}

async fn remove_booking(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match writable_booking(&caller, &id).await {
        Ok(existing) => existing,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        delete_booking(&state, &caller, &id, &existing).await,
        "Failed to delete booking",
    )
}

async fn delete_booking(state: &FlowState, caller: &Caller, id: &str, existing: &Value) -> Reply {
    // The request this booking filled opens again, in the same batch.
    let reopened: Vec<String> = resource_requests::Entity::find()
        .select_only()
        .column(resource_requests::Column::Id)
        .filter(resource_requests::Column::BookingId.eq(id))
        .filter(resource_requests::Column::Status.eq("booked"))
        .filter(resource_requests::Column::DeletedAt.is_null())
        .order_by_asc(resource_requests::Column::Id)
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    let now = now_at();
    let booking = id.to_owned();
    weldsuite_db::atomically_with(&caller.db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            bookings::Entity::update_many()
                .col_expr(bookings::Column::DeletedAt, Expr::value(now))
                .col_expr(bookings::Column::UpdatedAt, Expr::value(now))
                .filter(bookings::Column::Id.eq(&booking))
                .filter(bookings::Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            resource_requests::Entity::update_many()
                .col_expr(resource_requests::Column::Status, Expr::value("open"))
                .col_expr(
                    resource_requests::Column::BookingId,
                    Expr::value(None::<String>),
                )
                .col_expr(resource_requests::Column::UpdatedAt, Expr::value(now))
                .filter(resource_requests::Column::BookingId.eq(&booking))
                .filter(resource_requests::Column::Status.eq("booked"))
                .filter(resource_requests::Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    publish_booking(state, caller, RESOURCE_BOOKING_DELETED, existing);
    for request in &reopened {
        if let Some(row) = find_resource_request(&caller.db, request).await? {
            publish_resource_request(state, caller, RESOURCE_REQUEST_UPDATED, &row);
        }
    }
    Ok(NoContent.into_response())
}

// ── Resource requests ───────────────────────────────────────────────────────

async fn list_requests(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (project_id, status, cursor, limit) = match requests_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(limit.as_deref(), 50, 200);
    let cursor = match &cursor {
        Some(cursor) => match keyset_cursor_tz(
            &caller.db,
            resource_requests::Column::Id,
            resource_requests::Column::CreatedAt,
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
        list_request_rows(
            &caller,
            (project_id.as_deref(), status.as_deref()),
            limit,
            cursor,
        )
        .await,
        "Failed to list resource requests",
    )
}

async fn list_request_rows(
    caller: &Caller,
    (project_id, status): (Option<&str>, Option<&str>),
    limit: i64,
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    let db = orm(&caller.db);
    // The list's `where`, without the cursor.
    let mut filters = Condition::all().add(resource_requests::Column::DeletedAt.is_null());
    if let Some(project_id) = project_id {
        filters = filters.add(resource_requests::Column::ProjectId.eq(project_id));
    }
    if let Some(status) = status {
        filters = filters.add(resource_requests::Column::Status.eq(status));
    }
    let mut page_filters = filters.clone();
    if let Some(cursor) = &cursor {
        page_filters = page_filters.add(keyset_before(
            resource_requests::Column::Id,
            resource_requests::Column::CreatedAt,
            cursor,
        ));
    }
    let rows = resource_requests::Entity::find()
        .filter(page_filters)
        .order_by_desc(resource_requests::Column::CreatedAt)
        .order_by_desc(resource_requests::Column::Id)
        .limit(fetch_limit(limit)?)
        .all(&db)
        .await?;
    let total = resource_requests::Entity::find()
        .filter(filters)
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let (rows, has_more, next) = page(json_rows(rows)?, limit);
    let project_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row_text(row, "projectId").map(str::to_owned))
        .collect();
    let labels = project_labels(caller, &project_ids).await?;
    let items = rows
        .iter()
        .map(|row| present_request_with(row, &labels))
        .collect();
    Ok(paged(items, total, has_more, next))
}

fn present_request_with(row: &Value, labels: &HashMap<String, ProjectLabel>) -> Value {
    let label = label_of(labels, row_text(row, "projectId").unwrap_or_default());
    present_resource_request(row, &label.name)
}

/// `presentRequestFor(c, row)`: the request named for the caller.
async fn present_request_for(caller: &Caller, row: &Value) -> Result<Value, DbErr> {
    let project = row_text(row, "projectId").unwrap_or_default().to_owned();
    let labels = project_labels(caller, &[project]).await?;
    Ok(present_request_with(row, &labels))
}

async fn create_request(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let input = parse_body(&body, read_create_resource_request)?;
        let (starts_on, ends_on) = (
            text(&input, "startsOn").unwrap_or_default(),
            text(&input, "endsOn").unwrap_or_default(),
        );
        if let Some(message) = period_error(starts_on, ends_on) {
            return Err(Refusal::bad_request(message));
        }
        let project_id = text(&input, "projectId").unwrap_or_default();
        if !may_request_for(&caller, project_id).await? {
            return Err(Refusal::forbidden(messages::REQUEST_FORBIDDEN));
        }
        if !live_project_exists(&caller.db, project_id).await? {
            return Err(Refusal::not_found("Project", project_id));
        }
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        insert_request(&state, &caller, &input).await,
        "Failed to create resource request",
    )
}

async fn insert_request(state: &FlowState, caller: &Caller, input: &Body) -> Reply {
    let id = generate_id("rrq");
    let now = now_at();
    resource_requests::Entity::insert(resource_requests::ActiveModel {
        id: Set(id.clone()),
        project_id: Set(text(input, "projectId").unwrap_or_default().to_owned()),
        skill: Set(text(input, "skill").unwrap_or_default().to_owned()),
        hours_per_week: Set(decimal(&hours_text(
            number(input, "hoursPerWeek").unwrap_or_default(),
        ))?),
        starts_on: Set(date(text(input, "startsOn").unwrap_or_default())?),
        ends_on: Set(date(text(input, "endsOn").unwrap_or_default())?),
        status: Set("open".to_owned()),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    let Some(row) = find_resource_request(&caller.db, &id).await? else {
        return Err(Refusal::Internal("the new request is missing".to_owned()));
    };
    publish_resource_request(state, caller, RESOURCE_REQUEST_CREATED, &row);
    Ok(Created(present_request_for(caller, &row).await?).into_response())
}

/// The live request and the caller's right to change it.
async fn writable_request(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let Some(existing) = find_resource_request(&caller.db, id).await? else {
        return Err(Refusal::not_found(REQUEST_LABEL, id));
    };
    let project = row_text(&existing, "projectId").unwrap_or_default();
    if !may_request_for(caller, project).await? {
        return Err(Refusal::forbidden(messages::REQUEST_FORBIDDEN));
    }
    Ok(existing)
}

async fn update_request(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let existing = writable_request(&caller, &id).await?;
        let input = parse_body(&body, read_update_resource_request)?;
        if row_text(&existing, "status") != Some("open") {
            return Err(Refusal::conflict(messages::REQUEST_NOT_OPEN));
        }
        let pick = |key: &str| {
            text(&input, key)
                .or_else(|| row_text(&existing, key))
                .unwrap_or_default()
                .to_owned()
        };
        let (starts_on, ends_on) = (pick("startsOn"), pick("endsOn"));
        if let Some(message) = period_error(&starts_on, &ends_on) {
            return Err(Refusal::bad_request(message));
        }
        let hours = match number(&input, "hoursPerWeek") {
            Some(hours) => hours_text(hours),
            None => pick("hoursPerWeek"),
        };
        Ok((pick("skill"), hours, starts_on, ends_on, pick("status")))
    }
    .await;
    let (skill, hours, starts_on, ends_on, status) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    let result = async {
        resource_requests::Entity::update_many()
            .col_expr(resource_requests::Column::Skill, Expr::value(skill))
            .col_expr(
                resource_requests::Column::HoursPerWeek,
                Expr::value(decimal(&hours)?),
            )
            .col_expr(
                resource_requests::Column::StartsOn,
                Expr::value(date(&starts_on)?),
            )
            .col_expr(
                resource_requests::Column::EndsOn,
                Expr::value(date(&ends_on)?),
            )
            .col_expr(resource_requests::Column::Status, Expr::value(status))
            .col_expr(resource_requests::Column::UpdatedAt, Expr::value(now_at()))
            .filter(resource_requests::Column::Id.eq(&id))
            .filter(resource_requests::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        let Some(row) = find_resource_request(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REQUEST_LABEL, &id));
        };
        publish_resource_request(&state, &caller, RESOURCE_REQUEST_UPDATED, &row);
        Ok(Data(present_request_for(&caller, &row).await?).into_response())
    }
    .await;
    reply(result, "Failed to update resource request")
}

async fn remove_request(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match writable_request(&caller, &id).await {
        Ok(existing) => existing,
        Err(refused) => return outside(Err(refused)),
    };
    let result = async {
        let now = now_at();
        resource_requests::Entity::update_many()
            .col_expr(resource_requests::Column::DeletedAt, Expr::value(now))
            .col_expr(resource_requests::Column::UpdatedAt, Expr::value(now))
            .filter(resource_requests::Column::Id.eq(&id))
            .filter(resource_requests::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        publish_resource_request(&state, &caller, RESOURCE_REQUEST_DELETED, &existing);
        Ok(NoContent.into_response())
    }
    .await;
    reply(result, "Failed to delete resource request")
}

async fn suggestions(caller: Caller, Path(id): Path<String>) -> Response {
    let request = match find_resource_request(&caller.db, &id).await {
        Ok(Some(request)) => request,
        Ok(None) => return outside(Err(Refusal::not_found(REQUEST_LABEL, &id))),
        Err(error) => return outside(Err(error.into())),
    };
    let result = async {
        let starts_on = row_text(&request, "startsOn").unwrap_or_default();
        let ends_on = row_text(&request, "endsOn").unwrap_or_default();
        // The weeks of the request (at most 26), with tentative bookings: they hold the person too.
        let range = fit_range(Some(starts_on), Some(ends_on), &today_utc());
        let load = load_capacity(&caller.db, &range, true, None).await?;
        let found = suggest_members(
            &load,
            &ResourceNeed {
                skill: row_text(&request, "skill").unwrap_or_default(),
                hours_per_week: weldsuite_flow_domain::js::numeric(&request["hoursPerWeek"]),
                starts_on,
                ends_on,
            },
        );
        // What several people free for part of the request add up to ("19 + 5 covers it").
        let total = round2(found.iter().fold(0.0, |sum, s| sum + s.free_hours_per_week));
        Ok(Data(json!({
            "request": present_request_for(&caller, &request).await?,
            "suggestions": found.iter().map(weldsuite_flow_domain::capacity::MemberSuggestion::to_json).collect::<Vec<_>>(),
            "totalFreeHoursPerWeek": number_value(total),
            "truncated": ends_on > range.to.as_str(),
        }))
        .into_response())
    }
    .await;
    reply(result, "Failed to suggest people")
}

async fn book_request(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(request) = find_resource_request(&caller.db, &id).await? else {
            return Err(Refusal::not_found(REQUEST_LABEL, &id));
        };
        let input = parse_body(&body, read_book)?;
        let member = text(&input, "memberId").unwrap_or_default();
        if !may_book(&caller, member, row_text(&request, "projectId")).await? {
            return Err(Refusal::forbidden(messages::BOOKING_FORBIDDEN));
        }
        if row_text(&request, "status") != Some("open") {
            return Err(Refusal::conflict(messages::REQUEST_NOT_BOOKABLE));
        }
        Ok((request, input))
    }
    .await;
    let (request, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        book(&state, &caller, &id, &request, &input).await,
        "Failed to book resource request",
    )
}

async fn book(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    request: &Value,
    input: &Body,
) -> Reply {
    let booking_id = generate_id("bkg");
    let now = now_at();
    let tentative = input
        .get("tentative")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let booking = bookings::ActiveModel {
        id: Set(booking_id.clone()),
        member_id: Set(text(input, "memberId").unwrap_or_default().to_owned()),
        project_id: Set(Some(
            row_text(request, "projectId")
                .unwrap_or_default()
                .to_owned(),
        )),
        request_id: Set(None),
        starts_on: Set(date(row_text(request, "startsOn").unwrap_or_default())?),
        ends_on: Set(date(row_text(request, "endsOn").unwrap_or_default())?),
        hours_per_week: Set(decimal(
            row_text(request, "hoursPerWeek").unwrap_or_default(),
        )?),
        tentative: Set(tentative),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    let (request_id, filled_by) = (id.to_owned(), booking_id.clone());
    weldsuite_db::atomically_with(&caller.db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            bookings::Entity::insert(booking)
                .exec_without_returning(&tx)
                .await?;
            resource_requests::Entity::update_many()
                .col_expr(resource_requests::Column::Status, Expr::value("booked"))
                .col_expr(resource_requests::Column::BookingId, Expr::value(filled_by))
                .col_expr(resource_requests::Column::UpdatedAt, Expr::value(now))
                .filter(resource_requests::Column::Id.eq(&request_id))
                .filter(resource_requests::Column::Status.eq("open"))
                .filter(resource_requests::Column::DeletedAt.is_null())
                .exec(&tx)
                .await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    let booking = find_booking(&caller.db, &booking_id).await?;
    let updated = find_resource_request(&caller.db, id).await?;
    let (Some(booking), Some(updated)) = (booking, updated) else {
        return Err(Refusal::Internal("the booking is missing".to_owned()));
    };
    publish_booking(state, caller, RESOURCE_BOOKING_CREATED, &booking);
    publish_resource_request(state, caller, RESOURCE_REQUEST_UPDATED, &updated);
    Ok(Created(json!({
        "booking": present_booking(&booking),
        "request": present_request_for(caller, &updated).await?,
    }))
    .into_response())
}

// ── Member profiles ─────────────────────────────────────────────────────────

/// Insert the member's profile (40 hours and no skills unless given), or set
/// on the one there is only what was given.
async fn upsert_profile(
    caller: &Caller,
    member_id: &str,
    hours: Option<&str>,
    skills: Option<Value>,
) -> Result<(), DbErr> {
    let hours = hours.map(decimal).transpose()?;
    let now = now_at();
    let mut kept = vec![profiles::Column::UpdatedAt];
    if hours.is_some() {
        kept.push(profiles::Column::WeeklyHours);
    }
    if skills.is_some() {
        kept.push(profiles::Column::Skills);
    }
    profiles::Entity::insert(profiles::ActiveModel {
        id: Set(generate_id("fmp")),
        member_id: Set(member_id.to_owned()),
        weekly_hours: Set(hours.unwrap_or_else(|| 40.into())),
        skills: Set(skills.unwrap_or_else(|| json!([]))),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .on_conflict(
        OnConflict::column(profiles::Column::MemberId)
            .update_columns(kept)
            .to_owned(),
    )
    .exec_without_returning(&orm(&caller.db))
    .await?;
    Ok(())
}

async fn list_profiles(caller: Caller) -> Response {
    let result = async {
        let rows = profiles::Entity::find()
            .order_by_asc(profiles::Column::MemberId)
            .all(&orm(&caller.db))
            .await?;
        let items: Vec<Value> = json_rows(rows)?
            .into_iter()
            .map(|row| {
                let member = row_text(&row, "memberId").unwrap_or_default().to_owned();
                present_profile(Some(&row), &member)
            })
            .collect();
        let total = i64::try_from(items.len()).unwrap_or(i64::MAX);
        Ok(paged(items, total, false, None))
    }
    .await;
    reply(result, "Failed to list member profiles")
}

async fn get_profile(caller: Caller, Path(member_id): Path<String>) -> Response {
    let result = async {
        let row = find_profile(&caller.db, &member_id).await?;
        Ok(Data(present_profile(row.as_ref(), &member_id)).into_response())
    }
    .await;
    reply(result, "Failed to fetch member profile")
}

async fn save_profile(
    State(state): State<FlowState>,
    caller: Caller,
    Path(member_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = (|| {
        if member_id != caller.user_id && !caller.can(MANAGE) {
            return Err(Refusal::forbidden(messages::PROFILE_FORBIDDEN));
        }
        parse_body(&body, read_profile)
    })();
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    let result = async {
        let skills: Option<Value> = input.get("skills").and_then(Value::as_array).map(|list| {
            let given: Vec<String> = list
                .iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect();
            json!(normalize_skills(&given))
        });
        let hours: Option<String> = number(&input, "weeklyHours").map(|h| to_fixed(h, 2));
        upsert_profile(&caller, &member_id, hours.as_deref(), skills).await?;
        let Some(row) = find_profile(&caller.db, &member_id).await? else {
            return Err(Refusal::Internal("the profile is missing".to_owned()));
        };
        let profile = present_profile(Some(&row), &member_id);
        caller.publish(
            &state,
            FLOW_MEMBER_PROFILE_UPDATED,
            row_text(&row, "id").unwrap_or_default(),
            &profile,
        );
        Ok(Data(profile).into_response())
    }
    .await;
    reply(result, "Failed to save member profile")
}
