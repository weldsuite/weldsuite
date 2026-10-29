//! `/api/bookings` (`routes/bookings/index.ts`): bookings on booking pages,
//! limited to the caller's own pages unless `bookings:scope:all`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CALENDAR_BOOKING_DELETED, CALENDAR_BOOKING_UPDATED};
use weldsuite_catalogs::permission_keys::BOOKINGS_SCOPE_ALL;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, NoContent};

use crate::passthrough::{self, Kind};
use crate::{CalendarState, Caller, Outcome, Refusal, now, page, text, validate};

const BOOKING_DENIED: &str = "You do not have access to this booking";

/// Own-only (the booking page's owner) unless `bookings:scope:all` (`scopeFor`).
pub(crate) fn scope_for(caller: &Caller) -> Option<String> {
    if caller.can(BOOKINGS_SCOPE_ALL) {
        None
    } else {
        Some(caller.user_id.clone())
    }
}

/// Whether `scope` owns the booking page (`ownsPage`), deleted or not.
async fn owns_page(db: &PgPool, page_id: Option<&str>, scope: &str) -> Result<bool, sqlx::Error> {
    let owner: Option<String> =
        sqlx::query_scalar("select owner_id from calendar_booking_pages where id = $1 limit 1")
            .bind(page_id)
            .fetch_optional(db)
            .await?;
    Ok(owner.as_deref() == Some(scope))
}

fn denied() -> Refusal {
    ApiError::forbidden().with_message(BOOKING_DENIED).into()
}

/// `parseInt(text, 10)`: leading whitespace, a sign and digits; NaN otherwise.
pub(crate) fn parse_int(text: &str) -> Option<i64> {
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

/// The page of a list as the routes cut it, for `limit = min(parseInt(q.limit) || 25, 100)`:
/// `None` is NaN (no SQL limit, never more), a negative one slices from the end.
pub(crate) struct Paging {
    limit: Option<i64>,
}

impl Paging {
    pub(crate) fn of(raw: Option<&str>) -> Self {
        let limit = match raw.filter(|r| !r.is_empty()) {
            None => Some(25),
            Some(raw) => parse_int(raw).map(|n| n.min(100)),
        };
        Self { limit }
    }

    /// `.limit(limit + 1)`: Drizzle leaves a negative or NaN limit out.
    pub(crate) fn sql_limit(&self) -> Option<i64> {
        self.limit.map(|l| l + 1).filter(|l| *l >= 0)
    }

    /// `hasMore`, the page and the next cursor.
    pub(crate) fn cut(&self, rows: Vec<Value>) -> (Vec<Value>, bool, Option<String>) {
        let Some(limit) = self.limit else {
            return (rows, false, None);
        };
        let len = i64::try_from(rows.len()).unwrap_or(i64::MAX);
        if len <= limit {
            return (rows, false, None);
        }
        // `rows.slice(0, limit)`: a negative end counts from the back.
        let end = if limit < 0 {
            (len + limit).max(0)
        } else {
            limit
        };
        let data: Vec<Value> = rows
            .into_iter()
            .take(usize::try_from(end).unwrap_or(0))
            .collect();
        let cursor = data.last().map(|row| text(row, "id").to_owned());
        (data, true, cursor)
    }
}

/// `c.req.query()`: the first value of each key.
pub(crate) fn first_values(query: Option<&str>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if !key.is_empty() && !out.contains_key(key.as_ref()) {
            out.insert(key.into_owned(), Value::String(value.into_owned()));
        }
    }
    out
}

fn non_empty(q: &Map<String, Value>, key: &str) -> Option<String> {
    q.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let q = first_values(query.as_deref());
    let paging = Paging::of(q.get("limit").and_then(Value::as_str));
    let page_id = non_empty(&q, "bookingPageId");
    let status = non_empty(&q, "status");
    let scope = scope_for(&caller);
    let cursor_text = non_empty(&q, "cursor");
    // Built outside the route's try: a failure here is the app's 500.
    let setup = async {
        let owned_pages: Option<Vec<String>> = match &scope {
            Some(scope) => {
                let ids: Vec<String> =
                    sqlx::query_scalar("select id from calendar_booking_pages where owner_id = $1")
                        .bind(scope)
                        .fetch_all(&caller.db)
                        .await?;
                Some(if ids.is_empty() {
                    vec![String::new()]
                } else {
                    ids
                })
            }
            None => None,
        };
        let cursor = match &cursor_text {
            Some(id) => crate::events::cursor_of(&caller.db, "calendar_bookings", id).await?,
            None => None,
        };
        Ok::<_, sqlx::Error>((owned_pages, cursor))
    }
    .await;
    let (owned_pages, cursor) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            tracing::error!(%error, "[calendar-api/bookings] list setup failed");
            return ApiError::internal().into_response();
        }
    };
    // `conditions`, in order; with a `?cursor=` the count drops the last one,
    // the keyset when it was found and otherwise the condition before it.
    let mut applied = vec![
        ("page", page_id.is_some()),
        ("status", status.is_some()),
        ("scope", owned_pages.is_some()),
        ("cursor", cursor.is_some()),
    ];
    let mut count = applied.clone();
    if cursor_text.is_some() {
        if let Some(last) = count.iter_mut().rev().find(|(_, on)| *on) {
            last.1 = false;
        } else {
            // Only `deleted_at is null` left: the count drops it.
            count.push(("deleted", true));
        }
    }
    let on = |list: &[(&str, bool)], name: &str| list.iter().any(|(n, set)| *n == name && *set);
    let count_keeps_deleted = !on(&count, "deleted");
    applied.retain(|(n, _)| *n != "deleted");
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(b) from calendar_bookings b
             where deleted_at is null
               and (not $1 or booking_page_id = $2)
               and (not $3 or status = $4)
               and (not $5 or booking_page_id = any($6))
               and (not $7 or (created_at < $8::timestamp or (created_at = $8::timestamp and id < $9)))
             order by created_at desc, id desc
             limit $10",
        )
        .bind(on(&applied, "page"))
        .bind(&page_id)
        .bind(on(&applied, "status"))
        .bind(&status)
        .bind(on(&applied, "scope"))
        .bind(owned_pages.clone().unwrap_or_default())
        .bind(on(&applied, "cursor"))
        .bind(cursor.as_ref().map(|c| c.0.clone()))
        .bind(cursor.as_ref().map(|c| c.1.clone()))
        .bind(paging.sql_limit())
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from calendar_bookings
             where (not $1 or deleted_at is null)
               and (not $2 or booking_page_id = $3)
               and (not $4 or status = $5)
               and (not $6 or booking_page_id = any($7))
               and (not $8 or (created_at < $9::timestamp or (created_at = $9::timestamp and id < $10)))",
        )
        .bind(count_keeps_deleted)
        .bind(on(&count, "page"))
        .bind(&page_id)
        .bind(on(&count, "status"))
        .bind(&status)
        .bind(on(&count, "scope"))
        .bind(owned_pages.clone().unwrap_or_default())
        .bind(on(&count, "cursor"))
        .bind(cursor.as_ref().map(|c| c.0.clone()))
        .bind(cursor.as_ref().map(|c| c.1.clone()))
        .fetch_one(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
        let (data, has_more, next) = paging.cut(rows);
        Ok::<_, sqlx::Error>(page(data, total, has_more, next))
    }
    .await;
    result.unwrap_or_else(|error| Refusal::from(error).respond("Failed to list bookings"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn booking_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(b) from calendar_bookings b where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The live booking, when the caller may touch it: 404 / 403 otherwise.
async fn reachable(caller: &Caller, id: &str) -> Outcome<Value> {
    let Some(row) = booking_row(&caller.db, id).await? else {
        return Err(Refusal::not_found("Booking", id));
    };
    if let Some(scope) = scope_for(caller)
        && !owns_page(&caller.db, row["bookingPageId"].as_str(), &scope).await?
    {
        return Err(denied());
    }
    Ok(row)
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match reachable(&caller, &id).await {
        Ok(row) => Data(row).into_response(),
        Err(refused) => refused.respond("Failed to fetch booking"),
    }
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// `createBookingSchema` (or its `.partial()`): `.passthrough()`, so the
/// output is the body with the schema's keys checked.
fn booking_body(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "bookingPageId", Presence::Nullish, None, None);
    issues.text(fields, "customerName", Presence::Optional, None, Some(255));
    issues.text_with(
        fields,
        "customerEmail",
        Presence::Optional,
        Text {
            format: Some(Format::Email),
            max: Some(255),
            ..Text::default()
        },
    );
    issues.text(fields, "startsAt", required, None, None);
    issues.text(fields, "endsAt", required, None, None);
    issues.text(fields, "status", Presence::Optional, None, Some(30));
    fields.clone()
}

pub(crate) async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        booking_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Failed to create booking"),
    };
    if let Some(scope) = scope_for(&caller) {
        match owns_page(
            &caller.db,
            data.get("bookingPageId").and_then(Value::as_str),
            &scope,
        )
        .await
        {
            Ok(true) => {}
            Ok(false) => return denied().respond("Failed to create booking"),
            Err(error) => {
                tracing::error!(%error, "[calendar-api/bookings] scope check failed");
                return ApiError::internal().into_response();
            }
        }
    }
    // `insert({ id, ...data, createdAt, updatedAt })` cannot succeed with
    // this schema: `start_time` / `end_time` are NOT NULL `timestamp`
    // columns, which Drizzle maps with `toISOString()`, so a JSON body leaves
    // them out (a not-null violation) or hands a string (a TypeError). The
    // route answers its 500 either way, with nothing written or published.
    tracing::error!(
        "[calendar-api/bookings] create failed: start_time/end_time cannot come from a JSON body"
    );
    Refusal::Internal("booking create".to_owned()).respond("Failed to create booking")
}

/// The booking columns a passthrough body may name.
const COLUMNS: [(&str, Kind); 15] = [
    ("id", Kind::Text),
    ("createdAt", Kind::Timestamp),
    ("deletedAt", Kind::Timestamp),
    ("bookingPageId", Kind::Text),
    ("calendarEventId", Kind::Text),
    ("bookerName", Kind::Text),
    ("bookerEmail", Kind::Text),
    ("startTime", Kind::Timestamp),
    ("endTime", Kind::Timestamp),
    ("status", Kind::Text),
    ("answers", Kind::Jsonb),
    ("notes", Kind::Text),
    ("guests", Kind::Jsonb),
    ("timezone", Kind::Text),
    ("cancelReason", Kind::Text),
];

pub(crate) async fn update(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        booking_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Failed to update booking"),
    };
    update_booking(&state, &caller, &id, &data)
        .await
        .unwrap_or_else(|refused| refused.respond("Failed to update booking"))
}

async fn update_booking(
    state: &CalendarState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Outcome<Response> {
    let existing = reachable(caller, id).await?;
    let mut columns = std::collections::HashMap::new();
    for (key, kind) in COLUMNS {
        let column = passthrough::column(data, key, kind).map_err(|e| Refusal::Internal(e.0))?;
        columns.insert(key, column);
    }
    // `updatedAt` and `cancelledAt` from the body: a value Drizzle maps with
    // `toISOString()`.
    let updated_at = passthrough::column(data, "updatedAt", Kind::Timestamp)
        .map_err(|e| Refusal::Internal(e.0))?;
    let cancelled_at = passthrough::column(data, "cancelledAt", Kind::Timestamp)
        .map_err(|e| Refusal::Internal(e.0))?;
    let col = |key: &str| passthrough::bind(&columns[key]);
    let (set_id, new_id) = col("id");
    let (set_created, _) = col("createdAt");
    let (set_deleted, _) = col("deletedAt");
    let (set_page, page_id) = col("bookingPageId");
    let (set_event, event_id) = col("calendarEventId");
    let (set_name, name) = col("bookerName");
    let (set_email, email) = col("bookerEmail");
    let (set_start, _) = col("startTime");
    let (set_end, _) = col("endTime");
    let (set_status, status) = col("status");
    let (set_answers, answers) = col("answers");
    let (set_notes, notes) = col("notes");
    let (set_guests, guests) = col("guests");
    let (set_zone, zone) = col("timezone");
    let (set_reason, reason) = col("cancelReason");
    sqlx::query(
        "update calendar_bookings set
             id = case when $2 then $3 else id end,
             created_at = case when $4 then null else created_at end,
             updated_at = case when $5 then null else $6::timestamp end,
             deleted_at = case when $7 then null else deleted_at end,
             booking_page_id = case when $8 then $9 else booking_page_id end,
             calendar_event_id = case when $10 then $11 else calendar_event_id end,
             booker_name = case when $12 then $13 else booker_name end,
             booker_email = case when $14 then $15 else booker_email end,
             start_time = case when $16 then null else start_time end,
             end_time = case when $17 then null else end_time end,
             status = case when $18 then $19 else status end,
             answers = case when $20 then $21::jsonb else answers end,
             notes = case when $22 then $23 else notes end,
             guests = case when $24 then $25::jsonb else guests end,
             timezone = case when $26 then $27 else timezone end,
             cancelled_at = case when $28 then null else cancelled_at end,
             cancel_reason = case when $29 then $30 else cancel_reason end
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(set_id)
    .bind(&new_id)
    .bind(set_created)
    .bind(updated_at.is_set())
    .bind(now())
    .bind(set_deleted)
    .bind(set_page)
    .bind(&page_id)
    .bind(set_event)
    .bind(&event_id)
    .bind(set_name)
    .bind(&name)
    .bind(set_email)
    .bind(&email)
    .bind(set_start)
    .bind(set_end)
    .bind(set_status)
    .bind(&status)
    .bind(set_answers)
    .bind(&answers)
    .bind(set_notes)
    .bind(&notes)
    .bind(set_guests)
    .bind(&guests)
    .bind(set_zone)
    .bind(&zone)
    .bind(cancelled_at.is_set())
    .bind(set_reason)
    .bind(&reason)
    .execute(&caller.db)
    .await?;
    // `(update.x as string | undefined) ?? existing.x`: the body's value as sent.
    let pick = |key: &str| match data.get(key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => existing[key].clone(),
    };
    caller.publish(
        state,
        CALENDAR_BOOKING_UPDATED,
        id,
        &json!({
            "id": id,
            "bookingPageId": pick("bookingPageId"),
            "bookerEmail": pick("bookerEmail"),
            "status": pick("status"),
        }),
    );
    Ok(Data(json!({ "id": id })).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        reachable(&caller, &id).await?;
        let now = now();
        sqlx::query(
            "update calendar_bookings set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, CALENDAR_BOOKING_DELETED, &id, &json!({ "id": id }));
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(refused) => refused.respond("Failed to delete booking"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_reads_like_javascript() {
        assert_eq!(parse_int("12"), Some(12));
        assert_eq!(parse_int(" 12abc"), Some(12));
        assert_eq!(parse_int("2.7"), Some(2));
        assert_eq!(parse_int("-5"), Some(-5));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn pages_cut_like_slice() {
        let rows = |n: usize| {
            (0..n)
                .map(|i| json!({ "id": i.to_string() }))
                .collect::<Vec<_>>()
        };
        let (data, more, cursor) = Paging::of(Some("2")).cut(rows(3));
        assert_eq!((data.len(), more, cursor.as_deref()), (2, true, Some("1")));
        let (data, more, _) = Paging::of(Some("-1")).cut(rows(3));
        assert_eq!((data.len(), more), (2, true));
        let (data, more, _) = Paging::of(Some("x")).cut(rows(3));
        assert_eq!((data.len(), more), (3, false));
        assert_eq!(Paging::of(Some("x")).sql_limit(), None);
        assert_eq!(Paging::of(None).sql_limit(), Some(26));
    }
}
