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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence, js_trim, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::notifications::body::{
    Column, Kind, col, column_values, ensure_some_column, js_max, js_min, new_id, parse_int,
    query_first, slice_end, sql_limit,
};
use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now, validate};

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

async fn row_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from audit_logs t where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
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
                .map(Some)
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
    let mut after: Option<(Value, String)> = None;
    if paging.use_cursor
        && let Some(cursor) = supplied(&query, "cursor")
    {
        let found: Result<Option<(Value, String)>, sqlx::Error> = sqlx::query_as(
            "select to_jsonb(date_trunc('milliseconds', created_at)), id
             from audit_logs where id = $1 limit 1",
        )
        .bind(&cursor)
        .fetch_optional(&caller.db)
        .await;
        match found {
            Ok(found) => after = found,
            Err(error) => return PlatformError::Database(error).respond(),
        }
    }
    answer(list_page(&caller.db, &paging, &filters, after).await)
}

async fn list_page(
    db: &PgPool,
    paging: &Paging,
    filters: &Filters,
    after: Option<(Value, String)>,
) -> PlatformResult<Response> {
    const FAILED: &str = "Failed to list audit logs";
    let failed = |error: sqlx::Error| PlatformError::internal(FAILED, error);
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
        #[allow(clippy::cast_possible_truncation)]
        Some(offset as i64)
    } else {
        return Err(PlatformError::internal(FAILED, "offset out of range"));
    };
    let rows = fetch_rows(db, filters, after, sql_limit(fetch), sql_offset)
        .await
        .map_err(failed)?;
    // The count reflects the filters only, never the cursor window.
    let total = count_rows(db, filters).await.map_err(failed)?;

    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    let total_count = u64::try_from(total).unwrap_or(0);
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

fn hidden_types() -> Vec<String> {
    HIDDEN_ACTIVITY_ENTITY_TYPES
        .iter()
        .map(|t| (*t).to_owned())
        .collect()
}

/// The page: the filters, the cursor window, newest first with the id
/// breaking ties.
async fn fetch_rows(
    db: &PgPool,
    filters: &Filters,
    after: Option<(Value, String)>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (after_at, after_id) = match &after {
        Some((at, id)) => (at.as_str().map(str::to_owned), Some(id.clone())),
        None => (None, None),
    };
    sqlx::query_scalar(
        "select to_jsonb(t) from audit_logs t
         where (cardinality($1::text[]) = 0 or action = any($1))
           and (cardinality($2::text[]) = 0 or action is null or action <> all($2))
           and (cardinality($3::text[]) = 0 or entity_type = any($3))
           and (cardinality($4::text[]) = 0 or entity_type is null or entity_type <> all($4))
           and (cardinality($5::text[]) = 0 or entity_id = any($5))
           and (cardinality($6::text[]) = 0 or entity_id is null or entity_id <> all($6))
           and (cardinality($7::text[]) = 0 or performed_by = any($7))
           and (cardinality($8::text[]) = 0 or performed_by is null or performed_by <> all($8))
           and (not $9 or entity_type <> all($10))
           and ($11::text is null or description ilike $11 or entity_id ilike $11)
           and ($12::timestamp is null or created_at >= $12::timestamp)
           and ($13::timestamp is null or created_at <= $13::timestamp)
           and ($14::timestamp is null or created_at < $14::timestamp
                or (created_at = $14::timestamp and id < $15))
         order by created_at desc, id desc
         limit $16 offset $17",
    )
    .bind(&filters.action.any)
    .bind(&filters.action.not)
    .bind(&filters.entity_type.any)
    .bind(&filters.entity_type.not)
    .bind(&filters.entity_id.any)
    .bind(&filters.entity_id.not)
    .bind(&filters.performed_by.any)
    .bind(&filters.performed_by.not)
    .bind(filters.hide_internal)
    .bind(hidden_types())
    .bind(&filters.search)
    .bind(&filters.start)
    .bind(&filters.end)
    .bind(&after_at)
    .bind(&after_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await
}

/// The rows the filters keep.
async fn count_rows(db: &PgPool, filters: &Filters) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from audit_logs
         where (cardinality($1::text[]) = 0 or action = any($1))
           and (cardinality($2::text[]) = 0 or action is null or action <> all($2))
           and (cardinality($3::text[]) = 0 or entity_type = any($3))
           and (cardinality($4::text[]) = 0 or entity_type is null or entity_type <> all($4))
           and (cardinality($5::text[]) = 0 or entity_id = any($5))
           and (cardinality($6::text[]) = 0 or entity_id is null or entity_id <> all($6))
           and (cardinality($7::text[]) = 0 or performed_by = any($7))
           and (cardinality($8::text[]) = 0 or performed_by is null or performed_by <> all($8))
           and (not $9 or entity_type <> all($10))
           and ($11::text is null or description ilike $11 or entity_id ilike $11)
           and ($12::timestamp is null or created_at >= $12::timestamp)
           and ($13::timestamp is null or created_at <= $13::timestamp)",
    )
    .bind(&filters.action.any)
    .bind(&filters.action.not)
    .bind(&filters.entity_type.any)
    .bind(&filters.entity_type.not)
    .bind(&filters.entity_id.any)
    .bind(&filters.entity_id.not)
    .bind(&filters.performed_by.any)
    .bind(&filters.performed_by.not)
    .bind(filters.hide_internal)
    .bind(hidden_types())
    .bind(&filters.search)
    .bind(&filters.start)
    .bind(&filters.end)
    .fetch_one(db)
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
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from audit_logs t
         where entity_type = $1 and entity_id = $2
         order by created_at desc, id desc
         limit $3",
    )
    .bind(&entity_type)
    .bind(&entity_id)
    .bind(sql_limit(limit))
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response(),
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
            let inserted = sqlx::query(
                "insert into audit_logs
                     (id, created_at, entity_type, entity_id, action, description, changes,
                      data, performed_by, performed_by_name, ip_address, metadata)
                 values (coalesce($1->>'id', $2), $3::timestamp, $1->>'entity_type',
                         $1->>'entity_id', $1->>'action', $1->>'description',
                         nullif($1->'changes', 'null'::jsonb), nullif($1->'data', 'null'::jsonb),
                         $1->>'performed_by', $1->>'performed_by_name', $1->>'ip_address',
                         nullif($1->'metadata', 'null'::jsonb))
                 on conflict (id) do nothing",
            )
            .bind(Value::Object(values))
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            // A body `id` that is taken: the primary key refuses the row.
            if inserted.rows_affected() == 0 {
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
            if let Some(new_id) = new_id(&values, &id) {
                let taken: bool =
                    sqlx::query_scalar("select exists (select 1 from audit_logs where id = $1)")
                        .bind(new_id)
                        .fetch_one(&caller.db)
                        .await
                        .map_err(|error| PlatformError::internal(FAILED, error))?;
                if taken {
                    return Err(PlatformError::internal(FAILED, "duplicate key"));
                }
            }
            sqlx::query(
                "update audit_logs set
                     id = case when $1 ? 'id' then $1->>'id' else id end,
                     entity_type = case when $1 ? 'entity_type'
                         then $1->>'entity_type' else entity_type end,
                     entity_id = case when $1 ? 'entity_id' then $1->>'entity_id' else entity_id end,
                     action = case when $1 ? 'action' then $1->>'action' else action end,
                     description = case when $1 ? 'description'
                         then $1->>'description' else description end,
                     changes = case when $1 ? 'changes'
                         then nullif($1->'changes', 'null'::jsonb) else changes end,
                     data = case when $1 ? 'data'
                         then nullif($1->'data', 'null'::jsonb) else data end,
                     performed_by = case when $1 ? 'performed_by'
                         then $1->>'performed_by' else performed_by end,
                     performed_by_name = case when $1 ? 'performed_by_name'
                         then $1->>'performed_by_name' else performed_by_name end,
                     ip_address = case when $1 ? 'ip_address'
                         then $1->>'ip_address' else ip_address end,
                     metadata = case when $1 ? 'metadata'
                         then nullif($1->'metadata', 'null'::jsonb) else metadata end
                 where id = $2",
            )
            .bind(Value::Object(values))
            .bind(&id)
            .execute(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let removed = sqlx::query("delete from audit_logs where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await;
    match removed {
        Ok(done) if done.rows_affected() == 0 => {
            ApiError::not_found("Audit log", Some(&id)).into_response()
        }
        Ok(_) => NoContent.into_response(),
        Err(error) => PlatformError::internal("Failed to delete audit log", error).respond(),
    }
}

// ── `new Date(text)` ────────────────────────────────────────────────────────

/// `new Date(text)` for the ISO forms (`2026`, `2026-02`, `2026-02-01`, with
/// `THH:mm`, seconds, a fraction and `Z` or `±HH:mm`), as `toISOString()`;
/// `None` for an invalid date. A time without an offset is UTC, the
/// Workers' local time. V8's other, legacy forms are not read.
fn js_date(text: &str) -> Option<String> {
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
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(epoch_millis) * 1_000_000)
        .ok()?;
    Some(weldsuite_events::iso_timestamp(at))
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
        assert_eq!(
            js_date("2026-02-01").as_deref(),
            Some("2026-02-01T00:00:00.000Z")
        );
        assert_eq!(
            js_date("2026-02-01T10:30:00+02:00").as_deref(),
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
