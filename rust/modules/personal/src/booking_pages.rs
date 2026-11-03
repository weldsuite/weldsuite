//! `/api/booking-pages` (`routes/booking-pages.ts`) and the slot
//! calculation (`services/calendar-slots.ts`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use axum::routing::{get, patch};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_calendar_domain::js_dates::{from_zoned_time, time_zone, weekday_name};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};

use crate::PersonalState;
use crate::caller::{
    Caller, Failure, answer, created, data, no_content, plan_limit, query_map, rows, unhandled,
    validate, validate_query,
};
use crate::events::page;
use crate::js::{iso, now_iso, now_ms, stamp_ms};

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/booking-pages", get(list_pages).post(create))
        .route(
            "/api/booking-pages/{id}/available-slots",
            get(available_slots),
        )
        .route("/api/booking-pages/{id}/toggle", patch(toggle))
        .route(
            "/api/booking-pages/{id}",
            get(get_one).patch(update).delete(remove),
        )
}

const DAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// `slugSchema`'s regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`.
fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

/// `createSchema` (or its `.partial()`): the parsed body, every field it
/// set in the schema's order, as the writes take it.
fn read_page(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put(
        "name",
        issues
            .text(body, "name", required, Some(1), Some(255))
            .into_option()
            .map(Value::String),
    );
    put(
        "slug",
        issues
            .pattern(
                body,
                "slug",
                required,
                Some(1),
                Some(100),
                is_slug,
                "Slug must be lowercase letters, numbers, and hyphens",
            )
            .into_option()
            .map(Value::String),
    );
    put(
        "description",
        issues
            .text(body, "description", Presence::Optional, None, None)
            .into_option()
            .map(Value::String),
    );
    let int = |min: f64, max: Option<f64>| Number {
        coerce: false,
        int: true,
        min: Some(min),
        max,
    };
    put(
        "duration",
        issues
            .whole_number(body, "duration", required, int(5.0, Some(480.0)))
            .into_option()
            .map(Value::from),
    );
    put(
        "bufferBefore",
        issues
            .whole_number(
                body,
                "bufferBefore",
                Presence::Optional,
                int(0.0, Some(240.0)),
            )
            .into_option()
            .map(Value::from),
    );
    put(
        "bufferAfter",
        issues
            .whole_number(
                body,
                "bufferAfter",
                Presence::Optional,
                int(0.0, Some(240.0)),
            )
            .into_option()
            .map(Value::from),
    );
    put(
        "color",
        issues
            .text(body, "color", Presence::Optional, None, Some(20))
            .into_option()
            .map(Value::String),
    );
    put(
        "isActive",
        issues
            .boolean(body, "isActive", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    put(
        "locationType",
        issues
            .choice(
                body,
                "locationType",
                Presence::Optional,
                &["in-person", "phone", "video"],
            )
            .into_option()
            .map(Value::String),
    );
    put(
        "locationValue",
        issues
            .text(body, "locationValue", Presence::Optional, None, Some(500))
            .into_option()
            .map(Value::String),
    );
    let availability = issues.nested(body, "availability", required, |issues, days| {
        let mut week = Map::new();
        for day in DAYS {
            let ranges = issues.list(days, day, Presence::Required, None, None, |issues, item| {
                let fields = issues.object(item)?;
                let start = issues
                    .text(fields, "start", Presence::Required, None, None)
                    .into_option();
                let end = issues
                    .text(fields, "end", Presence::Required, None, None)
                    .into_option();
                Some(json!({ "start": start, "end": end }))
            });
            if let Some(ranges) = ranges.into_option() {
                week.insert(day.to_owned(), Value::Array(ranges));
            }
        }
        Value::Object(week)
    });
    put("availability", availability.into_option());
    let any = Text::length(None, None);
    let questions = issues.list(
        body,
        "questions",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let mut question = Map::new();
            for key in ["id", "label"] {
                if let Some(value) = issues
                    .text(fields, key, Presence::Required, None, None)
                    .into_option()
                {
                    question.insert(key.to_owned(), Value::String(value));
                }
            }
            if let Some(kind) = issues
                .choice(
                    fields,
                    "type",
                    Presence::Required,
                    &["text", "textarea", "select"],
                )
                .into_option()
            {
                question.insert("type".to_owned(), Value::String(kind));
            }
            if let Some(required) = issues
                .boolean(fields, "required", Presence::Required)
                .into_option()
            {
                question.insert("required".to_owned(), Value::Bool(required));
            }
            let options = issues.list(
                fields,
                "options",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, any).map(Value::String),
            );
            if let Some(options) = options.into_option() {
                question.insert("options".to_owned(), Value::Array(options));
            }
            Some(Value::Object(question))
        },
    );
    put("questions", questions.into_option().map(Value::Array));
    put(
        "minNotice",
        issues
            .whole_number(body, "minNotice", Presence::Optional, int(0.0, None))
            .into_option()
            .map(Value::from),
    );
    put(
        "maxAdvance",
        issues
            .whole_number(
                body,
                "maxAdvance",
                Presence::Optional,
                int(1.0, Some(365.0)),
            )
            .into_option()
            .map(Value::from),
    );
    put(
        "confirmationMessage",
        issues
            .text(body, "confirmationMessage", Presence::Optional, None, None)
            .into_option()
            .map(Value::String),
    );
    put(
        "timezone",
        issues
            .text(body, "timezone", Presence::Optional, None, Some(100))
            .into_option()
            .map(Value::String),
    );
    out
}

/// The page of the account, or `None`.
async fn find(db: &PgPool, account: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from personal_calendar_booking_pages t
         where t.id = $1 and t.personal_account_id = $2 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await?;
    Ok(found.map(weldsuite_db::js_row))
}

/// `Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100)`.
pub(crate) fn parse_limit(raw: Option<&String>) -> Result<i64, Failure> {
    let limit = match raw.filter(|raw| !raw.is_empty()) {
        None => 25,
        Some(raw) => {
            let trimmed = crate::js::js_trim(raw);
            let (sign, digits) = match trimmed.strip_prefix('-') {
                Some(rest) => (-1, rest),
                None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
            };
            let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
            if digits.is_empty() {
                // NaN reaches Postgres as the limit.
                return Err(Failure::Internal(
                    "invalid input syntax for type bigint: \"NaN\"".to_owned(),
                ));
            }
            sign * digits.parse::<i64>().unwrap_or(i64::MAX)
        }
    };
    Ok(limit.min(100))
}

/// The cursor row's `(createdAt, id)` in a table, when it has one.
pub(crate) async fn cursor_of(
    db: &PgPool,
    sql: &'static str,
    cursor: Option<&String>,
) -> Result<(Option<String>, Option<String>), sqlx::Error> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok((None, None));
    };
    let found: Option<(Value, String)> =
        sqlx::query_as(sql).bind(cursor).fetch_optional(db).await?;
    Ok(found
        .and_then(|(at, id)| {
            at.as_str()
                .and_then(weldsuite_db::js_timestamp)
                .map(|at| (Some(at), Some(id)))
        })
        .unwrap_or((None, None)))
}

/// `GET /api/booking-pages?search=&cursor=&limit=`.
async fn list_pages(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let q = query_map(raw.as_deref());
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    // The cursor lookup runs before the route's try/catch.
    let cursor = match cursor_of(
        &db,
        "select to_jsonb(t.created_at), t.id from personal_calendar_booking_pages t where t.id = $1 limit 1",
        q.get("cursor"),
    )
    .await
    {
        Ok(cursor) => cursor,
        Err(error) => return unhandled(Err(error.into())),
    };
    let result = async {
        let limit = parse_limit(q.get("limit"))?;
        let term = q.get("search").filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from personal_calendar_booking_pages t
             where t.deleted_at is null and t.personal_account_id = $1
               and ($2::text is null or (t.name like $2 or t.slug like $2))
               and ($3::timestamp is null
                    or (t.created_at < $3::timestamp or (t.created_at = $3::timestamp and t.id < $4)))
             order by t.created_at desc, t.id desc
             limit $5",
        )
        .bind(&account)
        .bind(&term)
        .bind(&cursor.0)
        .bind(&cursor.1)
        .bind(limit + 1)
        .fetch_all(&db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from personal_calendar_booking_pages
             where deleted_at is null and personal_account_id = $1",
        )
        .bind(&account)
        .fetch_one(&db)
        .await?;
        Ok(page(rows(found), limit, total))
    }
    .await;
    answer(result, "Failed to list booking pages")
}

/// `GET /api/booking-pages/:id/available-slots?date=`.
async fn available_slots(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let date = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "date", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(date) => date,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let Some(page) = find(&db, &account, &id).await? else {
            return Err(Failure::from(ApiError::not_found(
                "Booking page",
                Some(&id),
            )));
        };
        let slots = compute_available_slots(&db, &account, &page, &date).await?;
        Ok(data(Value::Array(slots)))
    }
    .await;
    answer(result, "Failed to compute available slots")
}

/// `computeAvailableSlots(db, page, date)`: the day's windows of the page's
/// weekly availability, in `duration` steps, each available unless it (with
/// buffers) overlaps a confirmed event of the owner or falls inside the
/// minimum notice.
async fn compute_available_slots(
    db: &PgPool,
    account: &str,
    page: &Value,
    date: &str,
) -> Result<Vec<Value>, Failure> {
    let empty = Map::new();
    let availability = page["availability"].as_object().unwrap_or(&empty);
    // `page.timezone || 'UTC'`: an unknown zone throws in `Intl`.
    let zone_name = page["timezone"]
        .as_str()
        .filter(|z| !z.is_empty())
        .unwrap_or("UTC");
    let weekday = weekday_name(date).map_err(Failure::Internal)?;
    let day_slots = availability
        .get(weekday)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if day_slots.is_empty() {
        return Ok(Vec::new());
    }
    let zone = time_zone(zone_name).ok_or_else(|| {
        Failure::Internal(format!(
            "RangeError: Invalid time zone specified: {zone_name}"
        ))
    })?;
    let day_start =
        from_zoned_time(&format!("{date}T00:00:00"), &zone).map_err(Failure::Internal)?;
    let day_end =
        from_zoned_time(&format!("{date}T23:59:59.999"), &zone).map_err(Failure::Internal)?;

    let events: Vec<(Value, Option<Value>)> = sqlx::query_as(
        "select to_jsonb(start_time), to_jsonb(end_time) from personal_calendar_events
         where deleted_at is null and personal_account_id = $1
           and start_time >= $2::timestamp and start_time <= $3::timestamp
           and status = 'confirmed'",
    )
    .bind(account)
    .bind(iso(day_start))
    .bind(iso(day_end))
    .fetch_all(db)
    .await?;
    let events: Vec<(i64, i64)> = events
        .iter()
        .filter_map(|(start, end)| {
            let start = stamp_ms(start)?;
            let end = end
                .as_ref()
                .and_then(stamp_ms)
                .unwrap_or(start + 30 * 60_000);
            Some((start, end))
        })
        .collect();

    let number = |key: &str| page[key].as_i64();
    let duration = number("duration").unwrap_or(0);
    let buffer_before = number("bufferBefore").unwrap_or(0);
    let buffer_after = number("bufferAfter").unwrap_or(0);
    let min_notice_ms = number("minNotice").unwrap_or(60) * 60_000;
    let now = now_ms();
    let step = duration * 60_000;

    let mut slots = Vec::new();
    for range in &day_slots {
        let text = |key: &str| match &range[key] {
            Value::String(text) => text.clone(),
            other => crate::js::js_string(other),
        };
        let range_start = from_zoned_time(&format!("{date}T{}:00", text("start")), &zone)
            .map_err(Failure::Internal)?;
        let range_end = from_zoned_time(&format!("{date}T{}:00", text("end")), &zone)
            .map_err(Failure::Internal)?;
        if step <= 0 {
            // A zero-minute page never leaves the loop in TypeScript; a page
            // can't be saved with one (`duration` is at least 5).
            continue;
        }
        let mut current = range_start;
        while current + step <= range_end {
            let slot_end = current + step;
            let buffered_start = current - buffer_before * 60_000;
            let buffered_end = slot_end + buffer_after * 60_000;
            let conflict = events
                .iter()
                .any(|(start, end)| buffered_start < *end && buffered_end > *start);
            let too_soon = current - now < min_notice_ms;
            slots.push(json!({
                "start": iso(current),
                "end": iso(slot_end),
                "available": !conflict && !too_soon,
            }));
            current += step;
        }
    }
    Ok(slots)
}

/// `PATCH /api/booking-pages/:id/toggle`.
async fn toggle(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let Some(record) = find(&db, &account, &id).await? else {
            return Err(Failure::from(ApiError::not_found(
                "Booking page",
                Some(&id),
            )));
        };
        let is_active = record["isActive"] != Value::Bool(true);
        sqlx::query(
            "update personal_calendar_booking_pages set is_active = $3, updated_at = $4::timestamp
             where id = $1 and personal_account_id = $2",
        )
        .bind(&id)
        .bind(&account)
        .bind(is_active)
        .bind(now_iso())
        .execute(&db)
        .await?;
        Ok(data(json!({ "id": id, "isActive": is_active })))
    }
    .await;
    answer(result, "Failed to toggle booking page")
}

/// `GET /api/booking-pages/:id`.
async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        match find(&db, &account, &id).await? {
            Some(row) => Ok(data(row)),
            None => Err(ApiError::not_found("Booking page", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch booking page")
}

/// Whether another live page has the slug.
async fn slug_taken(db: &PgPool, slug: &str) -> Result<bool, sqlx::Error> {
    let taken: Option<String> = sqlx::query_scalar(
        "select id from personal_calendar_booking_pages where slug = $1 and deleted_at is null limit 1",
    )
    .bind(slug)
    .fetch_optional(db)
    .await?;
    Ok(taken.is_some())
}

fn slug_conflict() -> Failure {
    ApiError::conflict("That booking slug is already taken").into()
}

/// A field of the parsed body.
fn field<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    input.get(key)
}

fn text<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn int(input: &Map<String, Value>, key: &str) -> Option<i64> {
    input.get(key).and_then(Value::as_i64)
}

/// `POST /api/booking-pages`, within the plan's page count.
async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_page(issues, b, false)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let count: i64 = sqlx::query_scalar(
            "select count(*) from personal_calendar_booking_pages
             where personal_account_id = $1 and deleted_at is null",
        )
        .bind(&account)
        .fetch_one(&db)
        .await?;
        let max = caller.entitlements.max_booking_pages();
        if count >= max {
            return Ok(plan_limit(
                "Booking page limit reached for your plan",
                json!({ "maxBookingPages": max }),
            ));
        }
        if slug_taken(&db, text(&input, "slug").unwrap_or_default()).await? {
            return Err(slug_conflict());
        }
        let id = weldsuite_kit::generate_id("bpg");
        let now = now_iso();
        sqlx::query(
            "insert into personal_calendar_booking_pages
               (id, personal_account_id, name, slug, description, owner_id, duration, buffer_before,
                buffer_after, color, is_active, location_type, location_value, availability, questions,
                min_notice, max_advance, confirmation_message, timezone, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb,
                     $16, $17, $18, $19, $20::timestamp, $20::timestamp)",
        )
        .bind(&id)
        .bind(&account)
        .bind(text(&input, "name"))
        .bind(text(&input, "slug"))
        .bind(text(&input, "description"))
        .bind(&caller.user_id)
        .bind(int(&input, "duration"))
        .bind(int(&input, "bufferBefore").unwrap_or(0))
        .bind(int(&input, "bufferAfter").unwrap_or(0))
        .bind(text(&input, "color"))
        .bind(field(&input, "isActive").and_then(Value::as_bool).unwrap_or(true))
        .bind(text(&input, "locationType"))
        .bind(text(&input, "locationValue"))
        .bind(field(&input, "availability"))
        .bind(field(&input, "questions"))
        .bind(int(&input, "minNotice").unwrap_or(60))
        .bind(int(&input, "maxAdvance").unwrap_or(60))
        .bind(text(&input, "confirmationMessage"))
        .bind(text(&input, "timezone").unwrap_or("UTC"))
        .bind(&now)
        .execute(&db)
        .await?;
        Ok(created(json!({ "id": id })))
    }
    .await;
    match result {
        Err(failure) if failure.is_unique_violation() => answer(Err(slug_conflict()), ""),
        result => answer(result, "Failed to create booking page"),
    }
}

/// `PATCH /api/booking-pages/:id`: the fields the body set.
async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_page(issues, b, true)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let Some(existing) = find(&db, &account, &id).await? else {
            return Err(Failure::from(ApiError::not_found(
                "Booking page",
                Some(&id),
            )));
        };
        if let Some(slug) = text(&input, "slug").filter(|s| !s.is_empty())
            && Some(slug) != existing["slug"].as_str()
            && slug_taken(&db, slug).await?
        {
            return Err(slug_conflict());
        }
        let set = |key: &str| input.contains_key(key);
        sqlx::query(
            "update personal_calendar_booking_pages set
               updated_at = $3::timestamp,
               name = case when $4 then $5 else name end,
               slug = case when $6 then $7 else slug end,
               description = case when $8 then $9 else description end,
               duration = case when $10 then $11 else duration end,
               buffer_before = case when $12 then $13 else buffer_before end,
               buffer_after = case when $14 then $15 else buffer_after end,
               color = case when $16 then $17 else color end,
               is_active = case when $18 then $19 else is_active end,
               location_type = case when $20 then $21 else location_type end,
               location_value = case when $22 then $23 else location_value end,
               availability = case when $24 then $25::jsonb else availability end,
               questions = case when $26 then $27::jsonb else questions end,
               min_notice = case when $28 then $29 else min_notice end,
               max_advance = case when $30 then $31 else max_advance end,
               confirmation_message = case when $32 then $33 else confirmation_message end,
               timezone = case when $34 then $35 else timezone end
             where id = $1 and personal_account_id = $2 and deleted_at is null",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .bind(set("name"))
        .bind(text(&input, "name"))
        .bind(set("slug"))
        .bind(text(&input, "slug"))
        .bind(set("description"))
        .bind(text(&input, "description"))
        .bind(set("duration"))
        .bind(int(&input, "duration").and_then(|v| i32::try_from(v).ok()))
        .bind(set("bufferBefore"))
        .bind(int(&input, "bufferBefore").and_then(|v| i32::try_from(v).ok()))
        .bind(set("bufferAfter"))
        .bind(int(&input, "bufferAfter").and_then(|v| i32::try_from(v).ok()))
        .bind(set("color"))
        .bind(text(&input, "color"))
        .bind(set("isActive"))
        .bind(field(&input, "isActive").and_then(Value::as_bool))
        .bind(set("locationType"))
        .bind(text(&input, "locationType"))
        .bind(set("locationValue"))
        .bind(text(&input, "locationValue"))
        .bind(set("availability"))
        .bind(field(&input, "availability"))
        .bind(set("questions"))
        .bind(field(&input, "questions"))
        .bind(set("minNotice"))
        .bind(int(&input, "minNotice").and_then(|v| i32::try_from(v).ok()))
        .bind(set("maxAdvance"))
        .bind(int(&input, "maxAdvance").and_then(|v| i32::try_from(v).ok()))
        .bind(set("confirmationMessage"))
        .bind(text(&input, "confirmationMessage"))
        .bind(set("timezone"))
        .bind(text(&input, "timezone"))
        .execute(&db)
        .await?;
        Ok(data(json!({ "id": id })))
    }
    .await;
    match result {
        Err(failure) if failure.is_unique_violation() => answer(Err(slug_conflict()), ""),
        result => answer(result, "Failed to update booking page"),
    }
}

/// `DELETE /api/booking-pages/:id`: soft delete.
async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        if find(&db, &account, &id).await?.is_none() {
            return Err(Failure::from(ApiError::not_found("Booking page", Some(&id))));
        }
        sqlx::query(
            "update personal_calendar_booking_pages set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = $1 and personal_account_id = $2",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .execute(&db)
        .await?;
        Ok(no_content())
    }
    .await;
    answer(result, "Failed to delete booking page")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::js::js_number;

    #[test]
    fn slugs_and_limits() {
        assert!(is_slug("intro-call"));
        assert!(is_slug("a1"));
        assert!(!is_slug("Intro"));
        assert!(!is_slug("a--b"));
        assert!(!is_slug("-a"));
        assert_eq!(parse_limit(None).ok(), Some(25));
        assert_eq!(parse_limit(Some(&"500".to_owned())).ok(), Some(100));
        assert_eq!(parse_limit(Some(&"2abc".to_owned())).ok(), Some(2));
        assert!(parse_limit(Some(&"abc".to_owned())).is_err());
        assert_eq!(js_number(&json!(3.0)), json!(3));
    }
}
