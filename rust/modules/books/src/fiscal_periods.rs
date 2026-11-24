//! `/api/fiscal-periods` (`routes/fiscal-periods/index.ts`, `calendar.ts`):
//! an entity's fiscal periods. `status` only changes through `/close` and
//! `/reopen`; closed periods block bookings dated inside them and can't be
//! edited or deleted. `/calendar` and `/generate` build a fiscal year's
//! periods from the entity's setup (calendar months, or 4-4-5 week periods
//! for a 52-53-week year).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::fiscal_year::{
    FiscalYearConfig, fiscal_periods, fiscal_year_config_of, fiscal_year_for,
};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, list_limit, no_content, now, ok, page,
    paged, reply, validate, validate_value,
};
use weldsuite_books_domain::tables::FISCAL_PERIODS as T;
use weldsuite_catalogs::entity_events::{
    FISCAL_PERIOD_CREATED, FISCAL_PERIOD_DELETED, FISCAL_PERIOD_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::entities;
use weldsuite_schema::tenant::fiscal_periods::{self, Column};

use crate::orm_bridge::{pg_date, to_json};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("reports:read")))
        .route("/", post(create).route_layer(need("reports:create")))
        .route("/calendar", get(calendar).route_layer(need("reports:read")))
        .route(
            "/generate",
            post(generate).route_layer(need("reports:create")),
        )
        .route("/{id}", get(detail).route_layer(need("reports:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("reports:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("reports:delete")),
        )
        .route(
            "/{id}/close",
            post(close).route_layer(need("reports:update")),
        )
        .route(
            "/{id}/reopen",
            post(reopen).route_layer(need("reports:update")),
        )
        .with_state(state)
}

/// `createFiscalPeriodSchema` (`@weldsuite/core-api-client/schemas/fiscal-periods`),
/// `.partial()` for a PATCH. Passthrough: the body as it came.
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(body, "name", required, Some(1), Some(50));
    issues.text(body, "entityId", Presence::Nullish, None, None);
    issues.text(body, "startDate", required, None, None);
    issues.text(body, "endDate", required, None, None);
    issues.text(body, "status", Presence::Optional, None, Some(30));
    issues.text(body, "type", Presence::Optional, None, Some(30));
    body.clone()
}

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    fiscal_periods::Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_periods(&caller, &q).await,
        "Failed to list fiscal periods",
    )
}

async fn list_periods(caller: &Caller, q: &Query) -> Reply {
    let db = orm(&caller.db);
    let entity = q.present("entityId");
    let status = q.present("status");
    let search = q.present("search").map(|s| format!("%{s}%"));
    let cursor: Option<(PrimitiveDateTime, String)> = match q.present("cursor") {
        Some(id) => {
            let row: Option<(String, PrimitiveDateTime)> = fiscal_periods::Entity::find()
                .select_only()
                .column(Column::Id)
                .column(Column::CreatedAt)
                .filter(Column::Id.eq(id))
                .into_tuple()
                .one(&db)
                .await?;
            // The cursor row's `createdAt` as the worker read it back: a
            // `Date`, to the millisecond.
            row.map(|(id, created)| (weldsuite_db::utc_timestamp(created.assume_utc()), id))
        }
        None => None,
    };
    let Some(limit) = list_limit(q, 25, 100) else {
        return Err(Refusal::Internal("limit is NaN".to_owned()));
    };
    // A negative `limit` is Postgres's error: the route's 500.
    let Ok(fetch) = u64::try_from(limit + 1) else {
        return Err(Refusal::Internal("LIMIT must not be negative".to_owned()));
    };
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(entity) = entity {
        filters = filters.add(Column::EntityId.eq(entity));
    }
    if let Some(status) = status {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(search) = &search {
        filters = filters.add(Column::Name.like(search.as_str()));
    }
    let mut select = fiscal_periods::Entity::find().filter(filters.clone());
    if let Some((at, id)) = &cursor {
        select = select.filter(
            Condition::any().add(Column::CreatedAt.lt(*at)).add(
                Condition::all()
                    .add(Column::CreatedAt.eq(*at))
                    .add(Column::Id.lt(id.as_str())),
            ),
        );
    }
    let rows = select
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(fetch)
        .all(&db)
        .await?;
    let total = fiscal_periods::Entity::find()
        .filter(filters)
        .count(&db)
        .await?;
    let rows = rows
        .into_iter()
        .map(to_json)
        .collect::<Result<Vec<_>, _>>()?;
    let (rows, has_more, next) = page(rows, limit);
    Ok(paged(
        rows,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

// ── calendar ────────────────────────────────────────────────────────────────

/// One planned period (`PlannedPeriod`).
struct Planned {
    name: String,
    kind: &'static str,
    start: String,
    end: String,
    number: Option<i64>,
    weeks: Option<i64>,
}

/// `FiscalCalendar`.
struct Calendar {
    fiscal_year: i64,
    start: String,
    end: String,
    kind: &'static str,
    weeks: Option<i64>,
    periods: Vec<Planned>,
}

/// `fiscalCalendarFor(entity, fiscalYear, options)`; `None` where the
/// worker's date arithmetic throws.
fn fiscal_calendar_for(
    entity: &Value,
    fiscal_year: i64,
    include_quarters: bool,
    include_year: bool,
) -> Option<Calendar> {
    let config = fiscal_year_config_of(
        entity.get("fiscalYearStart").and_then(Value::as_f64),
        entity.get("fiscalYearConfig"),
    );
    let year = fiscal_year_for(&config, fiscal_year)?;
    let periods = fiscal_periods(&config, fiscal_year)?;
    #[allow(clippy::float_cmp)]
    let calendar_year =
        matches!(config, FiscalYearConfig::Month { start_month } if start_month == 1.0);
    let label = if calendar_year {
        year.year.to_string()
    } else {
        format!("FY{}", year.year)
    };
    let week_based = matches!(config, FiscalYearConfig::FiftyTwoFiftyThree { .. });
    let mut planned: Vec<Planned> = periods
        .iter()
        .map(|period| Planned {
            name: if week_based {
                format!("{label} P{:02}", period.number)
            } else {
                period.start.chars().take(7).collect()
            },
            kind: if week_based { "period" } else { "month" },
            start: period.start.clone(),
            end: period.end.clone(),
            number: Some(period.number),
            weeks: period.weeks,
        })
        .collect();
    if include_quarters {
        for quarter in 1..=4 {
            let in_quarter: Vec<_> = periods.iter().filter(|p| p.quarter == quarter).collect();
            planned.push(Planned {
                name: format!("{label} Q{quarter}"),
                kind: "quarter",
                start: in_quarter.first()?.start.clone(),
                end: in_quarter.last()?.end.clone(),
                number: Some(quarter),
                weeks: week_based.then(|| in_quarter.iter().map(|p| p.weeks.unwrap_or(0)).sum()),
            });
        }
    }
    if include_year {
        planned.push(Planned {
            name: label,
            kind: "year",
            start: year.start.clone(),
            end: year.end.clone(),
            number: None,
            weeks: year.weeks,
        });
    }
    Some(Calendar {
        fiscal_year: year.year,
        start: year.start,
        end: year.end,
        kind: config.kind(),
        weeks: year.weeks,
        periods: planned,
    })
}

/// `calendarContext`: the entity (`entityId ?? resolveEntityId`), or the
/// refusal.
async fn calendar_entity(caller: &Caller, requested: Option<String>) -> Result<Value, Refusal> {
    let entity_id = match requested {
        Some(id) => id,
        None => match resolve_entity_id(caller).await? {
            Some(id) => id,
            None => return Err(Refusal::bad_request("No accounting entity resolved")),
        },
    };
    let entity = entities::Entity::find()
        .filter(entities::Column::Id.eq(entity_id.as_str()))
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()?;
    entity.ok_or_else(|| Refusal::not_found("Accounting entity", &entity_id))
}

/// `existingPeriods`: the entity's live periods inside the dates.
async fn existing_periods(
    caller: &Caller,
    entity_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Value>, DbErr> {
    fiscal_periods::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .filter(Column::StartDate.gte(pg_date(from)?))
        .filter(Column::EndDate.lte(pg_date(to)?))
        .all(&orm(&caller.db))
        .await?
        .into_iter()
        .map(to_json)
        .collect()
}

fn matching<'a>(existing: &'a [Value], period: &Planned) -> Option<&'a Value> {
    existing.iter().find(|row| {
        row["startDate"].as_str() == Some(period.start.as_str())
            && row["endDate"].as_str() == Some(period.end.as_str())
            && row["type"].as_str() == Some(period.kind)
    })
}

async fn calendar(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    // `zValidator('query', calendarQuerySchema)`
    let query = match validate_value(&Value::Object(q.values().clone()), |issues, fields| {
        let entity_id = issues.text(fields, "entityId", Presence::Optional, None, Some(30));
        let year = issues.number(
            fields,
            "fiscalYear",
            Presence::Required,
            Number {
                coerce: true,
                int: true,
                min: Some(1990.0),
                max: Some(2200.0),
            },
        );
        let quarters = issues.choice(
            fields,
            "includeQuarters",
            Presence::Optional,
            &["true", "false"],
        );
        let year_too = issues.choice(
            fields,
            "includeYear",
            Presence::Optional,
            &["true", "false"],
        );
        (
            entity_id.into_option(),
            year.into_option(),
            quarters.as_set().is_some_and(|v| v == "true"),
            year_too.as_set().is_some_and(|v| v == "true"),
        )
    }) {
        Ok(query) => query,
        Err(refusal) => return refusal.respond("Failed to build the fiscal calendar"),
    };
    reply(
        calendar_reply(&caller, query).await,
        "Failed to build the fiscal calendar",
    )
}

#[allow(clippy::cast_possible_truncation)]
async fn calendar_reply(
    caller: &Caller,
    query: (Option<String>, Option<f64>, bool, bool),
) -> Reply {
    let (entity_id, year, quarters, whole_year) = query;
    let entity = calendar_entity(caller, entity_id).await?;
    let year = year.unwrap_or_default() as i64;
    let calendar = fiscal_calendar_for(&entity, year, quarters, whole_year)
        .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    let existing = existing_periods(caller, &entity_id, &calendar.start, &calendar.end).await?;
    let locked_through = [&entity["periodLockDate"], &entity["hardLockDate"]]
        .into_iter()
        .filter_map(Value::as_str)
        .filter(|d| !d.is_empty())
        .max()
        .map(str::to_owned);
    let periods: Vec<Value> = calendar
        .periods
        .iter()
        .map(|period| {
            let row = matching(&existing, period);
            json!({
                "name": period.name,
                "type": period.kind,
                "startDate": period.start,
                "endDate": period.end,
                "number": period.number,
                "weeks": period.weeks,
                "existingId": row.map_or(Value::Null, |r| r["id"].clone()),
                "existingStatus": row.map_or(Value::Null, |r| r["status"].clone()),
                "closedAt": row.map_or(Value::Null, |r| r["closedAt"].clone()),
                "locked": locked_through.as_deref().is_some_and(|through| period.end.as_str() <= through),
            })
        })
        .collect();
    Ok(ok(json!({
        "fiscalYear": calendar.fiscal_year,
        "startDate": calendar.start,
        "endDate": calendar.end,
        "kind": calendar.kind,
        "weeks": calendar.weeks,
        "entityId": entity_id,
        "periods": periods,
    })))
}

// ── POST /generate ──────────────────────────────────────────────────────────

async fn generate(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let entity_id = issues.text(fields, "entityId", Presence::Optional, None, Some(30));
        let year = issues.number(
            fields,
            "fiscalYear",
            Presence::Required,
            Number {
                coerce: false,
                int: true,
                min: Some(1990.0),
                max: Some(2200.0),
            },
        );
        let quarters = issues.boolean(fields, "includeQuarters", Presence::Optional);
        let whole_year = issues.boolean(fields, "includeYear", Presence::Optional);
        (
            entity_id.into_option(),
            year.into_option(),
            matches!(quarters, Field::Set(true)),
            matches!(whole_year, Field::Set(true)),
        )
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to generate fiscal periods"),
    };
    reply(
        generate_periods(&caller, &state, input).await,
        "Failed to generate fiscal periods",
    )
}

#[allow(clippy::cast_possible_truncation)]
async fn generate_periods(
    caller: &Caller,
    state: &BooksState,
    input: (Option<String>, Option<f64>, bool, bool),
) -> Reply {
    let (entity_id, year, quarters, whole_year) = input;
    let entity = calendar_entity(caller, entity_id).await?;
    let year = year.unwrap_or_default() as i64;
    let calendar = fiscal_calendar_for(&entity, year, quarters, whole_year)
        .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    let existing = existing_periods(caller, &entity_id, &calendar.start, &calendar.end).await?;
    let at = now();
    let mut rows: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for period in &calendar.periods {
        if matching(&existing, period).is_some() {
            skipped.push(
                json!({ "name": period.name, "startDate": period.start, "endDate": period.end }),
            );
            continue;
        }
        rows.push(json!({
            "id": generate_id("fp"),
            "entityId": entity_id,
            "name": period.name,
            "type": period.kind,
            "startDate": period.start,
            "endDate": period.end,
            "status": "open",
            "createdAt": at,
            "updatedAt": at,
        }));
    }
    if !rows.is_empty() {
        let inserts: Vec<Map<String, Value>> = rows
            .iter()
            .filter_map(Value::as_object)
            .map(|row| T.values(row))
            .collect();
        weldsuite_db::atomically_with(&caller.db, move |conn| {
            Box::pin(async move {
                for values in inserts {
                    T.insert_raw(&mut *conn, values).await?;
                }
                Ok::<_, Refusal>(())
            })
        })
        .await?;
    }
    for row in &rows {
        caller.publish(
            state,
            FISCAL_PERIOD_CREATED,
            row["id"].as_str().unwrap_or_default(),
            json!({ "id": row["id"], "name": row["name"], "status": "open", "entityId": row["entityId"] }),
        );
    }
    Ok(created(json!({
        "entityId": entity_id,
        "fiscalYear": calendar.fiscal_year,
        "startDate": calendar.start,
        "endDate": calendar.end,
        "kind": calendar.kind,
        "weeks": calendar.weeks,
        "created": rows,
        "skipped": skipped,
    })))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Fiscal period", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch fiscal period")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create fiscal period"),
    };
    let id = generate_id("fp");
    let result = async {
        // Periods are born open: `status`, `closedAt`, `closedBy` of the body are dropped.
        let rest: Map<String, Value> = data
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "status" | "closedAt" | "closedBy"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let at = now();
        let mut values = Map::new();
        T.set(&mut values, "id", json!(id));
        values.extend(T.values(&rest));
        T.set(&mut values, "status", json!("open"));
        T.set(&mut values, "createdAt", json!(at));
        T.set(&mut values, "updatedAt", json!(at));
        T.insert(&caller.db, values, &["createdAt", "updatedAt"])
            .await?;
        let mut event = Map::new();
        event.insert("id".to_owned(), json!(id));
        if let Some(name) = data.get("name") {
            event.insert("name".to_owned(), name.clone());
        }
        event.insert("status".to_owned(), json!("open"));
        if let Some(entity) = data.get("entityId") {
            event.insert("entityId".to_owned(), entity.clone());
        }
        caller.publish(&state, FISCAL_PERIOD_CREATED, &id, Value::Object(event));
        Ok(created(json!({ "id": id })))
    }
    .await;
    reply(result, "Failed to create fiscal period")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update fiscal period"),
    };
    let result = async {
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Fiscal period", &id));
        };
        if existing["status"].as_str() == Some("closed") {
            return Err(Refusal::bad_request(
                "Closed fiscal periods cannot be edited — reopen the period first",
            ));
        }
        // Status transitions only via /close and /reopen.
        let changes: Map<String, Value> = data
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "status" | "closedAt" | "closedBy"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        let mut values = T.values(&changes);
        T.set(&mut values, "updatedAt", json!(now()));
        T.patch(&caller.db, &id, values, true, &["updatedAt"]).await?;
        let pick = |key: &str| {
            changes
                .get(key)
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| existing[key].clone())
        };
        caller.publish(
            &state,
            FISCAL_PERIOD_UPDATED,
            &id,
            json!({ "id": id, "name": pick("name"), "status": existing["status"], "entityId": pick("entityId") }),
        );
        Ok(ok(json!({ "id": id })))
    }
    .await;
    reply(result, "Failed to update fiscal period")
}

// ── POST /:id/close, /:id/reopen ────────────────────────────────────────────

async fn close(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Fiscal period", &id));
        };
        if existing["status"].as_str() == Some("closed") {
            return Err(Refusal::bad_request("Fiscal period is already closed"));
        }
        let at = weldsuite_db::utc_now();
        fiscal_periods::Entity::update_many()
            .col_expr(Column::Status, Expr::value("closed"))
            .col_expr(Column::ClosedAt, Expr::value(at))
            .col_expr(Column::ClosedBy, Expr::value(caller.user_id.as_str()))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let mut changes = Map::new();
        changes.insert("status".to_owned(), change(existing["status"].clone(), json!("closed")));
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: existing["entityId"].as_str(),
                entity_type: "fiscal_period",
                entity_id: &id,
                action: "closed",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            FISCAL_PERIOD_UPDATED,
            &id,
            json!({ "id": id, "name": existing["name"], "status": "closed", "entityId": existing["entityId"] }),
        );
        Ok(ok(json!({ "id": id, "status": "closed" })))
    }
    .await;
    reply(result, "Failed to close fiscal period")
}

async fn reopen(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Fiscal period", &id));
        };
        if existing["status"].as_str() != Some("closed") {
            return Err(Refusal::bad_request("Fiscal period is not closed"));
        }
        fiscal_periods::Entity::update_many()
            .col_expr(Column::Status, Expr::value("open"))
            .col_expr(Column::ClosedAt, Expr::value(None::<PrimitiveDateTime>))
            .col_expr(Column::ClosedBy, Expr::value(None::<String>))
            .col_expr(Column::UpdatedAt, Expr::value(weldsuite_db::utc_now()))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let mut changes = Map::new();
        changes.insert("status".to_owned(), change(json!("closed"), json!("open")));
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: existing["entityId"].as_str(),
                entity_type: "fiscal_period",
                entity_id: &id,
                action: "reopened",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            FISCAL_PERIOD_UPDATED,
            &id,
            json!({ "id": id, "name": existing["name"], "status": "open", "entityId": existing["entityId"] }),
        );
        Ok(ok(json!({ "id": id, "status": "open" })))
    }
    .await;
    reply(result, "Failed to reopen fiscal period")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Fiscal period", &id));
        };
        if existing["status"].as_str() == Some("closed") {
            return Err(Refusal::bad_request(
                "Closed fiscal periods cannot be deleted — reopen the period first",
            ));
        }
        let at = weldsuite_db::utc_now();
        fiscal_periods::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, FISCAL_PERIOD_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete fiscal period")
}
