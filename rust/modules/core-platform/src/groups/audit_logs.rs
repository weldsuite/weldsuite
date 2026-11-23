//! `/api/audit-logs` (`app-api/src/routes/audit-logs`): the workspace's
//! audit log (Settings › Activity Log) and one entity's history.
//!
//! - `GET /`: newest first, filtered (equality filters take one value or a
//!   comma list, `<param>Not` excludes, free-text `search`, `startDate` and
//!   `endDate`), with WeldMeet's internal rows hidden unless `entityType`
//!   asks for them. Cursor paging by default; `?page=` switches to a
//!   numbered pager whose pagination adds `page`, `pageSize`, `totalPages`.
//! - `GET /:entityType/:entityId`: one entity's history, hidden types too.
//! - `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (a hard delete): the
//!   row shell, `general:read|create|update|delete`. The schemas pass
//!   unknown keys through, so every key naming a column reaches the insert
//!   or update (`notifications::body`).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Issues, Presence, js_trim, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::audit_logs;

use super::notifications::body::{
    Column, Kind, col, column_values, ensure_some_column, js_max, js_min, new_id, parse_int,
    query_first, slice_end, sql_limit,
};
use super::notifications::set_values;
use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate};

/// Not catalog keys (no role holds them but the owner's `*`); the routes
/// require them as written.
const GENERAL_CREATE: &str = "general:create";
const GENERAL_DELETE: &str = "general:delete";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(GENERAL_READ)))
        .route("/", post(create).route_layer(need(GENERAL_CREATE)))
        .route(
            "/{entity_type}/{entity_id}",
            get(history).route_layer(need(GENERAL_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(GENERAL_READ)))
        .route("/{id}", patch(update).route_layer(need(GENERAL_UPDATE)))
        .route("/{id}", delete(remove).route_layer(need(GENERAL_DELETE)))
}

/// The `audit_logs` columns a body can reach, in table order.
const COLUMNS: [Column; 12] = [
    col("id", "id", Kind::Text(Some(30)), true),
    col("createdAt", "created_at", Kind::Timestamp, true),
    col("entityType", "entity_type", Kind::Text(Some(50)), true),
    col("entityId", "entity_id", Kind::Text(Some(30)), true),
    col("action", "action", Kind::Text(Some(50)), true),
    col("description", "description", Kind::Text(None), true),
    col("changes", "changes", Kind::Json, false),
    col("data", "data", Kind::Json, false),
    col("performedBy", "performed_by", Kind::Text(Some(255)), false),
    col(
        "performedByName",
        "performed_by_name",
        Kind::Text(Some(255)),
        false,
    ),
    col("ipAddress", "ip_address", Kind::Text(Some(45)), false),
    col("metadata", "metadata", Kind::Json, false),
];

/// Left out of the list unless `entityType` asks for them: WeldMeet's
/// bookkeeping (a row per call session and in-call chat message).
const HIDDEN_ACTIVITY_ENTITY_TYPES: [&str; 3] =
    ["meeting_session", "meeting_message", "meeting_bot_session"];

/// A row as `to_jsonb` through `js_row` read it: the entity serializes as
/// Drizzle did.
fn row_json(row: audit_logs::Model) -> Value {
    serde_json::to_value(row).unwrap_or(Value::Null)
}

async fn row_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = audit_logs::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json))
}

/// A query param counts as supplied only when present and non-empty.
fn supplied(query: &Map<String, Value>, key: &str) -> Option<String> {
    query_first(query, key).filter(|text| !text.is_empty())
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `parseListPaging`: cursor or numbered pages, the limit clamped to
/// `1..=100` (`NaN` stays `NaN`, as `Math.min`/`Math.max` keep it).
struct Paging {
    limit: f64,
    page: f64,
    page_size: f64,
    use_cursor: bool,
}

fn paging(query: &Map<String, Value>) -> Paging {
    let limit = js_min(
        js_max(
            supplied(query, "limit").map_or(25.0, |t| parse_int(&t)),
            1.0,
        ),
        100.0,
    );
    let raw_page = supplied(query, "page").map_or(f64::NAN, |t| parse_int(&t));
    let raw_page_size = supplied(query, "pageSize").map_or(f64::NAN, |t| parse_int(&t));
    Paging {
        limit,
        // A cursor always wins; numbered pages only on an explicit `page`.
        use_cursor: query.contains_key("cursor") || raw_page.is_nan(),
        page: if raw_page.is_nan() {
            1.0
        } else {
            raw_page.max(1.0)
        },
        page_size: if raw_page_size.is_nan() {
            limit
        } else {
            js_min(js_max(raw_page_size, 1.0), 100.0)
        },
    }
}

/// `a,b` → `['a', 'b']`.
fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect()
}

/// One equality filter: the values to match (none: no filter) and the ones
/// to exclude.
#[derive(Default)]
struct Equality {
    any: Vec<String>,
    not: Vec<String>,
}

fn equality(query: &Map<String, Value>, param: &str) -> Equality {
    Equality {
        any: supplied(query, param)
            .map(|v| split_list(&v))
            .unwrap_or_default(),
        not: supplied(query, &format!("{param}Not"))
            .map(|v| split_list(&v))
            .unwrap_or_default(),
    }
}

/// `buildListFilters`.
struct Filters {
    action: Equality,
    entity_type: Equality,
    entity_id: Equality,
    performed_by: Equality,
    hide_internal: bool,
    search: Option<String>,
    start: Option<String>,
    end: Option<String>,
}

fn filters(query: &Map<String, Value>) -> Result<Filters, String> {
    let date = |param: &str| -> Result<Option<String>, String> {
        match supplied(query, param) {
            None => Ok(None),
            Some(text) => js_date(&text)
                .map(|at| Some(weldsuite_events::iso_timestamp(at)))
                .ok_or_else(|| format!("Invalid {param} — expected an ISO 8601 date")),
        }
    };
    // Escape LIKE wildcards so a search for "50%" matches the literal text.
    let search = supplied(query, "search")
        .map(|text| js_trim(&text).to_owned())
        .filter(|text| !text.is_empty())
        .map(|text| {
            let mut pattern = String::from("%");
            for c in text.chars() {
                if matches!(c, '\\' | '%' | '_') {
                    pattern.push('\\');
                }
                pattern.push(c);
            }
            pattern.push('%');
            pattern
        });
    let start = date("startDate")?;
    let end = date("endDate")?;
    Ok(Filters {
        action: equality(query, "action"),
        entity_type: equality(query, "entityType"),
        entity_id: equality(query, "entityId"),
        performed_by: equality(query, "performedBy"),
        hide_internal: supplied(query, "entityType").is_none(),
        search,
        start,
        end,
    })
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let paging = paging(&query);
    let filters = match filters(&query) {
        Ok(filters) => filters,
        Err(message) => return ApiError::bad_request(message).into_response(),
    };
    let mut after: Option<(PrimitiveDateTime, String)> = None;
    if paging.use_cursor
        && let Some(cursor) = supplied(&query, "cursor")
    {
        // Its time as the route reads it (a `Date`, so milliseconds).
        let found: Result<Option<(PrimitiveDateTime, String)>, DbErr> =
            audit_logs::Entity::find()
                .select_only()
                .columns([audit_logs::Column::CreatedAt, audit_logs::Column::Id])
                .filter(audit_logs::Column::Id.eq(&cursor))
                .into_tuple()
                .one(&orm(&caller.db))
                .await;
        match found {
            Ok(found) => after = found.map(|(at, id)| (utc_timestamp(at.assume_utc()), id)),
            Err(error) => return PlatformError::Database(error).respond(),
        }
    }
    answer(list_page(&caller.db, &paging, &filters, after).await)
}

async fn list_page(
    db: &PgPool,
    paging: &Paging,
    filters: &Filters,
    after: Option<(PrimitiveDateTime, String)>,
) -> PlatformResult<Response> {
    const FAILED: &str = "Failed to list audit logs";
    let failed = |error: DbErr| PlatformError::internal(FAILED, error);
    // Cursor mode over-fetches by one to tell whether there is more; the
    // numbered pager reads the exact page and counts instead.
    let fetch = if paging.use_cursor {
        paging.limit + 1.0
    } else {
        paging.page_size
    };
    let offset = if paging.use_cursor {
        0.0
    } else {
        (paging.page - 1.0) * paging.page_size
    };
    // `.offset(n)` only when truthy; past a bigint Postgres refuses it.
    let sql_offset = if offset.is_nan() || offset == 0.0 {
        None
    } else if offset.is_finite() && offset < 9.2e18 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(offset as u64)
    } else {
        return Err(PlatformError::internal(FAILED, "offset out of range"));
    };
    let limit = sql_limit(fetch).map(|n| u64::try_from(n).unwrap_or(0));
    let db = orm(db);
    let rows = fetch_rows(&db, filters, after, limit, sql_offset)
        .await
        .map_err(failed)?;
    // The count reflects the filters only, never the cursor window.
    let total = filtered(filters)
        .count(&db)
        .await
        .map_err(failed)?;

    let mut rows: Vec<Value> = rows.into_iter().map(row_json).collect();
    let total_count = total;
    let last_id = |rows: &[Value]| {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    };
    #[allow(clippy::cast_precision_loss)]
    let len = rows.len() as f64;
    if paging.use_cursor {
        let has_more = len > paging.limit;
        if has_more {
            rows.truncate(slice_end(rows.len(), paging.limit));
        }
        let cursor = if has_more { last_id(&rows) } else { None };
        return Ok(List::new(rows, Pagination::new(total_count, has_more, cursor)).into_response());
    }
    #[allow(clippy::cast_precision_loss)]
    let has_more = offset + len < total as f64;
    let cursor = if has_more { last_id(&rows) } else { None };
    #[allow(clippy::cast_precision_loss)]
    let total_pages = (total as f64 / paging.page_size).ceil();
    Ok(Json(json!({
        "data": rows,
        "pagination": {
            "totalCount": total_count,
            "hasMore": has_more,
            "cursor": cursor,
            "page": js_number(paging.page),
            "pageSize": js_number(paging.page_size),
            "totalPages": js_number(total_pages),
        },
    }))
    .into_response())
}

/// One equality filter on `column`: `= any(values)` when it names some,
/// `is null or <> all(excluded)` when it excludes some.
fn equal(condition: Condition, column: audit_logs::Column, filter: &Equality) -> Condition {
    let mut condition = condition;
    if !filter.any.is_empty() {
        condition = condition.add(column.is_in(filter.any.clone()));
    }
    if !filter.not.is_empty() {
        condition = condition.add(
            Condition::any()
                .add(column.is_null())
                .add(column.is_not_in(filter.not.clone())),
        );
    }
    condition
}

/// `buildListFilters` as conditions: the rows the filters keep.
fn filtered(filters: &Filters) -> Select<audit_logs::Entity> {
    use audit_logs::Column as A;
    let mut condition = Condition::all();
    condition = equal(condition, A::Action, &filters.action);
    condition = equal(condition, A::EntityType, &filters.entity_type);
    condition = equal(condition, A::EntityId, &filters.entity_id);
    condition = equal(condition, A::PerformedBy, &filters.performed_by);
    if filters.hide_internal {
        condition = condition.add(A::EntityType.is_not_in(HIDDEN_ACTIVITY_ENTITY_TYPES));
    }
    if let Some(search) = &filters.search {
        condition = condition.add(
            Condition::any()
                .add(A::Description.ilike(search.as_str()))
                .add(A::EntityId.ilike(search.as_str())),
        );
    }
    // `$n::timestamp`: Postgres reads the ISO text as before.
    let at = |text: &String| sea_orm::ExprTrait::cast_as(Expr::value(text.clone()), "timestamp");
    if let Some(start) = &filters.start {
        condition = condition.add(sea_orm::ExprTrait::gte(Expr::col(A::CreatedAt), at(start)));
    }
    if let Some(end) = &filters.end {
        condition = condition.add(sea_orm::ExprTrait::lte(Expr::col(A::CreatedAt), at(end)));
    }
    audit_logs::Entity::find().filter(condition)
}

/// The page: the filters, the cursor window, newest first with the id
/// breaking ties.
async fn fetch_rows(
    db: &sea_orm::DatabaseConnection,
    filters: &Filters,
    after: Option<(PrimitiveDateTime, String)>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<Vec<audit_logs::Model>, DbErr> {
    use audit_logs::Column as A;
    let mut select = filtered(filters);
    if let Some((at, id)) = after {
        select = select.filter(
            Condition::any()
                .add(A::CreatedAt.lt(at))
                .add(Condition::all().add(A::CreatedAt.eq(at)).add(A::Id.lt(id))),
        );
    }
    select
        .order_by_desc(A::CreatedAt)
        .order_by_desc(A::Id)
        .limit(limit)
        .offset(offset)
        .all(db)
        .await
}

/// A number as `JSON.stringify` writes it: `NaN` and `±Infinity` are `null`.
fn js_number(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    #[allow(clippy::cast_possible_truncation)]
    let whole = number as i64;
    #[allow(clippy::cast_precision_loss, clippy::float_cmp)]
    if whole as f64 == number {
        return json!(whole);
    }
    json!(number)
}

// ── GET /:entityType/:entityId ──────────────────────────────────────────────

async fn history(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query_values(query.as_deref());
    // `Math.min(limit ? parseInt(limit, 10) : 100, 200)`: no lower bound.
    let limit = supplied(&query, "limit").map_or(100.0, |t| js_min(parse_int(&t), 200.0));
    let rows = audit_logs::Entity::find()
        .filter(audit_logs::Column::EntityType.eq(&entity_type))
        .filter(audit_logs::Column::EntityId.eq(&entity_id))
        .order_by_desc(audit_logs::Column::CreatedAt)
        .order_by_desc(audit_logs::Column::Id)
        .limit(sql_limit(limit).map(|n| u64::try_from(n).unwrap_or(0)))
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(row_json).collect::<Vec<_>>()).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch entity history", error).respond(),
    }
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match row_by_id(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Audit log", Some(&id)).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch audit log", error).respond(),
    }
}

// ── POST / and PATCH /:id ───────────────────────────────────────────────────

/// `createAuditLogSchema` (`.partial()` for the update, which leaves every
/// rule as it is): the declared keys checked in order, every other key
/// passed through. The body itself is what reaches Drizzle.
fn read_audit_log(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    issues.text(body, "userId", Presence::Nullish, None, None);
    issues.text(body, "action", Presence::Optional, None, Some(100));
    issues.text(body, "entityType", Presence::Optional, None, Some(50));
    issues.text(body, "entityId", Presence::Nullish, None, None);
    // `details` and `metadata` are `z.unknown().optional()`.
    body.clone()
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create audit log";
    answer(
        async {
            let mut input = validate(&headers, &body, read_audit_log)?;
            // `{ id, ...data, createdAt: now }`: the route's `createdAt` wins.
            input.remove("createdAt");
            let values = column_values(&COLUMNS, &input)
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            for required in ["entity_type", "entity_id", "action", "description"] {
                if !values.contains_key(required) {
                    return Err(PlatformError::internal(
                        FAILED,
                        format!("{required}: null value violates the not-null constraint"),
                    ));
                }
            }
            let id = generate_id("audit");
            let inserted = audit_logs::Entity::insert(new_row(&values, &id))
                .on_conflict(
                    OnConflict::column(audit_logs::Column::Id)
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(&orm(&caller.db))
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            // A body `id` that is taken: the primary key refuses the row.
            if inserted == 0 {
                return Err(PlatformError::internal(FAILED, "duplicate key"));
            }
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
    )
}

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update audit log";
    answer(
        async {
            let input = validate(&headers, &body, read_audit_log)?;
            let existing = row_by_id(&caller.db, &id)
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            if existing.is_none() {
                return Err(ApiError::not_found("Audit log", Some(&id)).into());
            }
            let values = column_values(&COLUMNS, &input)
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            ensure_some_column(&values, FAILED)?;
            let db = orm(&caller.db);
            if let Some(new_id) = new_id(&values, &id) {
                let taken: Option<String> = audit_logs::Entity::find()
                    .select_only()
                    .column(audit_logs::Column::Id)
                    .filter(audit_logs::Column::Id.eq(new_id))
                    .into_tuple()
                    .one(&db)
                    .await
                    .map_err(|error| PlatformError::internal(FAILED, error))?;
                if taken.is_some() {
                    return Err(PlatformError::internal(FAILED, "duplicate key"));
                }
            }
            let mut update = audit_logs::Entity::update_many();
            for (column, value) in set_values::<audit_logs::Entity>(&COLUMNS, &values) {
                update = update.col_expr(column, value);
            }
            update
                .filter(audit_logs::Column::Id.eq(&id))
                .exec(&db)
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
    )
}

/// The inserted row: `{ id, ...data, createdAt: now }` (the body's values
/// as `$1->>'column'` and `nullif($1->'column', 'null'::jsonb)` read them).
fn new_row(values: &Map<String, Value>, id: &str) -> audit_logs::ActiveModel {
    let text = |name: &str| values.get(name).and_then(Value::as_str).map(str::to_owned);
    let json = |name: &str| values.get(name).filter(|value| !value.is_null()).cloned();
    audit_logs::ActiveModel {
        id: Set(text("id").unwrap_or_else(|| id.to_owned())),
        created_at: Set(utc_now()),
        entity_type: Set(text("entity_type").unwrap_or_default()),
        entity_id: Set(text("entity_id").unwrap_or_default()),
        action: Set(text("action").unwrap_or_default()),
        description: Set(text("description").unwrap_or_default()),
        changes: Set(json("changes")),
        data: Set(json("data")),
        performed_by: Set(text("performed_by")),
        performed_by_name: Set(text("performed_by_name")),
        ip_address: Set(text("ip_address")),
        metadata: Set(json("metadata")),
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let removed = audit_logs::Entity::delete_by_id(id.clone())
        .exec(&orm(&caller.db))
        .await;
    match removed {
        Ok(done) if done.rows_affected == 0 => {
            ApiError::not_found("Audit log", Some(&id)).into_response()
        }
        Ok(_) => NoContent.into_response(),
        Err(error) => PlatformError::internal("Failed to delete audit log", error).respond(),
    }
}

// ── `new Date(text)` ────────────────────────────────────────────────────────

/// `new Date(text)` for the ISO forms (`2026`, `2026-02`, `2026-02-01`, with
/// `THH:mm`, seconds, a fraction and `Z` or `±HH:mm`); `None` for an invalid
/// date. A time without an offset is UTC, the Workers' local time. V8's
/// other, legacy forms are not read.
fn js_date(text: &str) -> Option<OffsetDateTime> {
    let mut p = Cursor {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = match p.peek() {
        Some(sign @ (b'+' | b'-')) => {
            p.at += 1;
            let digits = p.digits(6, 6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => p.digits(4, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if p.eat(b'-') {
        month = p.digits(2, 2)?;
        if p.eat(b'-') {
            day = p.digits(2, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut millis_of_day = 0;
    let mut offset_minutes = 0;
    if matches!(p.peek(), Some(b'T' | b't' | b' ')) {
        p.at += 1;
        let hour = p.digits(2, 2)?;
        if !p.eat(b':') {
            return None;
        }
        let minute = p.digits(2, 2)?;
        let mut second = 0;
        let mut millis = 0;
        if p.eat(b':') {
            second = p.digits(2, 2)?;
            if p.eat(b'.') {
                let start = p.at;
                while p.peek().is_some_and(|b| b.is_ascii_digit()) {
                    p.at += 1;
                }
                let fraction = &text[start..p.at];
                if fraction.is_empty() {
                    return None;
                }
                let padded: String = fraction.chars().chain("000".chars()).take(3).collect();
                millis = padded.parse::<i64>().ok()?;
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, millis) != (0, 0, 0))
        {
            return None;
        }
        millis_of_day = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match p.peek() {
            Some(b'Z' | b'z') => p.at += 1,
            Some(sign @ (b'+' | b'-')) => {
                p.at += 1;
                let hours = p.digits(2, 2)?;
                p.eat(b':');
                let minutes = p.digits(2, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let total = hours * 60 + minutes;
                offset_minutes = if sign == b'-' { -total } else { total };
            }
            _ => {}
        }
    }
    if p.at != text.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let epoch_millis = days * 86_400_000 + millis_of_day - offset_minutes * 60_000;
    // `toISOString()` throws past ±8.64e15 ms.
    if epoch_millis.abs() > 8_640_000_000_000_000 {
        return None;
    }
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(epoch_millis) * 1_000_000).ok()
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.at;
        while self.at - start < max && self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        if self.at - start < min {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_parse_like_javascripts_iso_forms() {
        let iso = |text: &str| js_date(text).map(weldsuite_events::iso_timestamp);
        assert_eq!(
            iso("2026-02-01").as_deref(),
            Some("2026-02-01T00:00:00.000Z")
        );
        assert_eq!(
            iso("2026-02-01T10:30:00+02:00").as_deref(),
            Some("2026-02-01T08:30:00.000Z")
        );
        assert_eq!(js_date("soon"), None);
        assert_eq!(js_date("2026-13-01"), None);
    }

    #[test]
    fn paging_reads_cursor_and_numbered_modes() {
        let query = query_values(Some("page=2&limit=3"));
        let p = paging(&query);
        assert!(!p.use_cursor);
        assert!((p.page_size - 3.0).abs() < f64::EPSILON);
        let query = query_values(Some("cursor=&page=2&limit=abc"));
        let p = paging(&query);
        assert!(p.use_cursor);
        assert!(p.limit.is_nan());
        assert_eq!(js_number(f64::NAN), Value::Null);
        assert_eq!(js_number(2.0), json!(2));
    }

    #[test]
    fn searches_escape_like_wildcards() {
        let query = query_values(Some("search=%2050%25_%5C%20"));
        let f = filters(&query).unwrap_or_else(|_| unreachable!());
        assert_eq!(f.search.as_deref(), Some("%50\\%\\_\\\\%"));
        assert!(f.hide_internal);
        let bad = query_values(Some("startDate=2026-01-01&endDate=nope"));
        assert_eq!(
            filters(&bad).err().as_deref(),
            Some("Invalid endDate — expected an ISO 8601 date")
        );
    }
}
