//! `/api/bookings` (`routes/bookings/index.ts`): bookings on booking pages,
//! limited to the caller's own pages unless `bookings:scope:all`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CALENDAR_BOOKING_DELETED, CALENDAR_BOOKING_UPDATED};
use weldsuite_catalogs::permission_keys::BOOKINGS_SCOPE_ALL;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_schema::tenant::{calendar_booking_pages as pages, calendar_bookings as bookings};

use crate::access::row_json;
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
async fn owns_page(db: &PgPool, page_id: Option<&str>, scope: &str) -> Result<bool, DbErr> {
    let owner: Option<String> = pages::Entity::find()
        .select_only()
        .column(pages::Column::OwnerId)
        .filter(pages::Column::Id.eq(page_id.map(str::to_owned)))
        .into_tuple()
        .one(&orm(db))
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

#[allow(clippy::too_many_lines)] // the route's conditions, as TypeScript builds them
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
                let ids: Vec<String> = pages::Entity::find()
                    .select_only()
                    .column(pages::Column::Id)
                    .filter(pages::Column::OwnerId.eq(scope.as_str()))
                    .into_tuple()
                    .all(&orm(&caller.db))
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
        Ok::<_, DbErr>((owned_pages, cursor))
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
    // `and(...conditions)` for the conditions that are on in `list`.
    let conditions = |list: &[(&str, bool)]| {
        let mut all = Condition::all();
        if on(list, "page")
            && let Some(page_id) = &page_id
        {
            all = all.add(bookings::Column::BookingPageId.eq(page_id.as_str()));
        }
        if on(list, "status")
            && let Some(status) = &status
        {
            all = all.add(bookings::Column::Status.eq(status.as_str()));
        }
        if on(list, "scope")
            && let Some(owned) = &owned_pages
        {
            all = all.add(bookings::Column::BookingPageId.is_in(owned.clone()));
        }
        if on(list, "cursor")
            && let Some((at, id)) = &cursor
        {
            all = all.add(
                Condition::any().add(bookings::Column::CreatedAt.lt(*at)).add(
                    Condition::all()
                        .add(bookings::Column::CreatedAt.eq(*at))
                        .add(bookings::Column::Id.lt(id.as_str())),
                ),
            );
        }
        all
    };
    let result = async {
        let db = orm(&caller.db);
        let rows = bookings::Entity::find()
            .filter(bookings::Column::DeletedAt.is_null())
            .filter(conditions(&applied))
            .order_by_desc(bookings::Column::CreatedAt)
            .order_by_desc(bookings::Column::Id)
            .limit(paging.sql_limit().and_then(|l| u64::try_from(l).ok()))
            .all(&db)
            .await?;
        let mut counted = bookings::Entity::find();
        if count_keeps_deleted {
            counted = counted.filter(bookings::Column::DeletedAt.is_null());
        }
        let total = counted.filter(conditions(&count)).count(&db).await?;
        let rows = rows
            .into_iter()
            .map(row_json)
            .collect::<Result<Vec<_>, _>>()?;
        let (data, has_more, next) = paging.cut(rows);
        Ok::<_, DbErr>(page(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    result.unwrap_or_else(|error| Refusal::from(error).respond("Failed to list bookings"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn booking_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    bookings::Entity::find()
        .filter(bookings::Column::Id.eq(id))
        .filter(bookings::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
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
    write_booking(caller, id, &columns, &updated_at, &cancelled_at).await?;
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

/// `update(calendarBookings).set({ ...data, updatedAt: new Date() })`: only
/// the columns the body names, each as the driver handed it over (a
/// timestamp can only be `null` here: anything else threw before).
async fn write_booking(
    caller: &Caller,
    id: &str,
    columns: &std::collections::HashMap<&'static str, passthrough::Column>,
    updated_at: &passthrough::Column,
    cancelled_at: &passthrough::Column,
) -> Result<(), DbErr> {
    use bookings::Column as B;
    let null_stamp = || Expr::value(Option::<time::PrimitiveDateTime>::None);
    let set = |key: &str| columns[key].is_set();
    let text = |key: &str| Expr::value(passthrough::bind(&columns[key]).1);
    let mut update = bookings::Entity::update_many();
    if set("id") {
        update = update.col_expr(B::Id, text("id"));
    }
    if set("createdAt") {
        update = update.col_expr(B::CreatedAt, null_stamp());
    }
    update = update.col_expr(
        B::UpdatedAt,
        if updated_at.is_set() {
            null_stamp()
        } else {
            Expr::value(now())
        },
    );
    if set("deletedAt") {
        update = update.col_expr(B::DeletedAt, null_stamp());
    }
    for (key, column) in [
        ("bookingPageId", B::BookingPageId),
        ("calendarEventId", B::CalendarEventId),
        ("bookerName", B::BookerName),
        ("bookerEmail", B::BookerEmail),
    ] {
        if set(key) {
            update = update.col_expr(column, text(key));
        }
    }
    if set("startTime") {
        update = update.col_expr(B::StartTime, null_stamp());
    }
    if set("endTime") {
        update = update.col_expr(B::EndTime, null_stamp());
    }
    for (key, column, jsonb) in [
        ("status", B::Status, false),
        ("answers", B::Answers, true),
        ("notes", B::Notes, false),
        ("guests", B::Guests, true),
        ("timezone", B::Timezone, false),
    ] {
        if set(key) {
            let value = if jsonb {
                text(key).cast_as("jsonb")
            } else {
                text(key)
            };
            update = update.col_expr(column, value);
        }
    }
    if cancelled_at.is_set() {
        update = update.col_expr(B::CancelledAt, null_stamp());
    }
    if set("cancelReason") {
        update = update.col_expr(B::CancelReason, text("cancelReason"));
    }
    update
        .filter(B::Id.eq(id))
        .filter(B::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
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
        bookings::Entity::update_many()
            .col_expr(bookings::Column::DeletedAt, Expr::value(now))
            .col_expr(bookings::Column::UpdatedAt, Expr::value(now))
            .filter(bookings::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
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
