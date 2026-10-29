//! `/api/booking-pages` (`routes/booking-pages/index.ts`): booking pages,
//! owner-scoped unless `bookings:scope:all`, with their slot availability.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CALENDAR_BOOKING_PAGE_CREATED, CALENDAR_BOOKING_PAGE_DELETED, CALENDAR_BOOKING_PAGE_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::bookings::{Paging, first_values, scope_for};
use crate::passthrough::{self, Column, Kind};
use crate::{
    CalendarState, Caller, Outcome, Refusal, now, page, validate_hooked, validate_query_hooked,
};

const NOT_FOUND: &str = "Booking page";

/// The live page, within the caller's scope: 404 otherwise.
async fn scoped_page(caller: &Caller, id: &str) -> Outcome<Value> {
    let scope = scope_for(caller);
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from calendar_booking_pages p
         where id = $1 and deleted_at is null and ($2::text is null or owner_id = $2)
         limit 1",
    )
    .bind(id)
    .bind(&scope)
    .fetch_optional(&caller.db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| Refusal::not_found(NOT_FOUND, id))
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let q = first_values(query.as_deref());
    let paging = Paging::of(q.get("limit").and_then(Value::as_str));
    let scope = scope_for(&caller);
    let owner = q
        .get("ownerId")
        .and_then(Value::as_str)
        .filter(|o| !o.is_empty())
        .map(str::to_owned);
    let search = q
        .get("search")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let cursor_text = q
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    // The keyset lookup runs outside the route's try.
    let cursor = match &cursor_text {
        Some(id) => {
            match crate::events::cursor_of(&caller.db, "calendar_booking_pages", id).await {
                Ok(cursor) => cursor,
                Err(error) => {
                    tracing::error!(%error, "[calendar-api/booking-pages] cursor lookup failed");
                    return ApiError::internal().into_response();
                }
            }
        }
        None => None,
    };
    // `conditions`; with a `?cursor=` the count drops the last one.
    let applied = [
        ("scope", scope.is_some()),
        ("owner", owner.is_some()),
        ("search", search.is_some()),
        ("cursor", cursor.is_some()),
    ];
    let mut count = applied.to_vec();
    let mut count_keeps_deleted = true;
    if cursor_text.is_some() {
        match count.iter_mut().rev().find(|(_, on)| *on) {
            Some(last) => last.1 = false,
            None => count_keeps_deleted = false,
        }
    }
    let on = |list: &[(&str, bool)], name: &str| list.iter().any(|(n, set)| *n == name && *set);
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(p) from calendar_booking_pages p
             where deleted_at is null
               and (not $1 or owner_id = $2)
               and (not $3 or owner_id = $4)
               and (not $5 or (name like $6 or slug like $6))
               and (not $7 or (created_at < $8::timestamp or (created_at = $8::timestamp and id < $9)))
             order by created_at desc, id desc
             limit $10",
        )
        .bind(on(&applied, "scope"))
        .bind(&scope)
        .bind(on(&applied, "owner"))
        .bind(&owner)
        .bind(on(&applied, "search"))
        .bind(&search)
        .bind(on(&applied, "cursor"))
        .bind(cursor.as_ref().map(|c| c.0.clone()))
        .bind(cursor.as_ref().map(|c| c.1.clone()))
        .bind(paging.sql_limit())
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from calendar_booking_pages
             where (not $1 or deleted_at is null)
               and (not $2 or owner_id = $3)
               and (not $4 or owner_id = $5)
               and (not $6 or (name like $7 or slug like $7))
               and (not $8 or (created_at < $9::timestamp or (created_at = $9::timestamp and id < $10)))",
        )
        .bind(count_keeps_deleted)
        .bind(on(&count, "scope"))
        .bind(&scope)
        .bind(on(&count, "owner"))
        .bind(&owner)
        .bind(on(&count, "search"))
        .bind(&search)
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
    result.unwrap_or_else(|error| Refusal::from(error).respond("Failed to list booking pages"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match scoped_page(&caller, &id).await {
        Ok(row) => Data(row).into_response(),
        Err(refused) => refused.respond("Failed to fetch booking page"),
    }
}

// ── Validation (`createBookingPageSchema`, `.passthrough()`) ────────────────

/// `HH:MM`, 24h (`HHMM`).
fn is_hhmm(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && matches!(
            (b[0], b[1]),
            (b'0' | b'1', b'0'..=b'9') | (b'2', b'0'..=b'3')
        )
        && matches!(b[3], b'0'..=b'5')
        && b[4].is_ascii_digit()
}

/// A real calendar date written `YYYY-MM-DD` (`isValidIsoDate`).
fn is_valid_iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    crate::js::parse_date(text).is_some_and(|ms| crate::js::iso(ms).starts_with(text))
}

/// `bookingTimeRangeSchema`: `{ start, end }` as `HH:MM`. `None` when the
/// item is not an object or a field is not a string (Zod aborts it).
fn time_range(issues: &mut Issues, item: &Value) -> Option<(String, String)> {
    let fields = issues.object(item)?;
    let start = fields
        .get("start")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let end = fields.get("end").and_then(Value::as_str).map(str::to_owned);
    issues.pattern(
        fields,
        "start",
        Presence::Required,
        None,
        None,
        is_hhmm,
        "Expected HH:MM",
    );
    issues.pattern(
        fields,
        "end",
        Presence::Required,
        None,
        None,
        is_hhmm,
        "Expected HH:MM",
    );
    Some((start?, end?))
}

/// A list of ranges (`z.array(bookingTimeRangeSchema).max(24)`): the parsed
/// ranges, and whether every item kept its type.
fn ranges(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> (Option<Vec<(String, String)>>, bool) {
    let mut whole = true;
    let mut read = Vec::new();
    let value = fields.get(key);
    let typed = match value {
        None => true,
        Some(Value::Array(_)) => true,
        Some(Value::Null) => false,
        Some(_) => false,
    };
    issues.list(fields, key, presence, None, Some(24), |issues, item| {
        let range = time_range(issues, item);
        match &range {
            Some(range) => read.push(range.clone()),
            None => whole = false,
        }
        range
    });
    if !typed || value.is_none() {
        return (None, typed);
    }
    (Some(read), whole)
}

fn ranges_value(list: &[(String, String)]) -> Value {
    Value::Array(
        list.iter()
            .map(|(start, end)| json!({ "start": start, "end": end }))
            .collect(),
    )
}

const WEEKDAY_KEYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// The first range that ends before it starts, or overlaps another of its
/// list: `(index, overlap)` (`findAvailabilityProblem` for one list).
fn range_problem(list: &[(String, String)]) -> Option<(usize, bool)> {
    if let Some(index) = list.iter().position(|(start, end)| start >= end) {
        return Some((index, false));
    }
    let mut sorted: Vec<(usize, &(String, String))> = list.iter().enumerate().collect();
    sorted.sort_by(|a, b| a.1.0.cmp(&b.1.0));
    sorted
        .windows(2)
        .find(|pair| pair[1].1.0 < pair[0].1.1)
        .map(|pair| (pair[1].0, true))
}

/// The refinements of a body, in the order `safeParseAsync` settles them.
#[derive(Default)]
struct Deferred {
    override_dates: Vec<usize>,
    override_slots: Vec<(usize, usize, bool)>,
    questions: Vec<usize>,
    duplicate_dates: Vec<usize>,
    availability: Option<(&'static str, usize, bool)>,
}

/// `createBookingPageSchema` (or its `.partial()`): the body with the
/// schema's keys replaced by their parsed values.
#[allow(clippy::too_many_lines)] // one block per schema field, in order
fn page_body(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let mut out = fields.clone();
    let mut deferred = Deferred::default();
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "name", required, Some(1), Some(255));
    issues.text(fields, "slug", required, Some(1), Some(255));
    issues.text(fields, "description", Presence::Optional, None, None);
    issues.text(fields, "ownerId", Presence::Nullish, None, None);
    issues.boolean(fields, "isActive", Presence::Optional);
    issues.integer(fields, "durationMinutes", Presence::Optional, None);

    // availability: a weekly schedule, unknown keys dropped.
    if let Some(value) = fields.get("availability") {
        let mut parsed = Map::new();
        let mut whole = value.is_object();
        let mut lists: Vec<(&'static str, Vec<(String, String)>)> = Vec::new();
        issues.nested(
            fields,
            "availability",
            Presence::Optional,
            |issues, days| {
                for day in WEEKDAY_KEYS {
                    let (list, typed) = ranges(issues, days, day, Presence::Optional);
                    whole &= typed;
                    if let Some(list) = list {
                        parsed.insert(day.to_owned(), ranges_value(&list));
                        lists.push((day, list));
                    }
                }
            },
        );
        if value.is_object() {
            out.insert("availability".to_owned(), Value::Object(parsed));
        }
        if whole {
            deferred.availability = lists.iter().find_map(|(day, list)| {
                range_problem(list).map(|(index, overlap)| (*day, index, overlap))
            });
        }
    }

    // questions: custom fields of the booking form.
    if let Some(Value::Array(items)) = fields.get("questions") {
        let mut parsed = Vec::new();
        let _ = items;
        issues.list(
            fields,
            "questions",
            Presence::Nullish,
            None,
            Some(20),
            |issues, item| {
                let question = question(issues, item);
                if let Some((value, whole, select_without_options)) = &question {
                    parsed.push(value.clone());
                    if *whole && *select_without_options {
                        deferred.questions.push(parsed.len() - 1);
                    }
                }
                question.map(|q| q.0)
            },
        );
        out.insert("questions".to_owned(), Value::Array(parsed));
    } else {
        issues.list(
            fields,
            "questions",
            Presence::Nullish,
            None,
            Some(20),
            |_, _| None::<()>,
        );
    }

    issues.integer(fields, "minNotice", Presence::Optional, Some(0));
    issues.integer(fields, "maxAdvance", Presence::Optional, Some(1));

    // dateOverrides: per-date availability.
    if let Some(Value::Array(_)) = fields.get("dateOverrides") {
        let mut parsed = Vec::new();
        let mut whole = true;
        let mut index = 0usize;
        issues.list(
            fields,
            "dateOverrides",
            Presence::Nullish,
            None,
            Some(366),
            |issues, item| {
                let at = index;
                index += 1;
                let read = date_override(issues, item);
                if read.date_invalid {
                    deferred.override_dates.push(at);
                }
                match read.parsed {
                    Some((value, slots)) => {
                        if let Some(slots) = &slots
                            && let Some((slot, overlap)) = range_problem(slots)
                        {
                            deferred.override_slots.push((at, slot, overlap));
                        }
                        parsed.push(value.clone());
                        Some(value)
                    }
                    None => {
                        whole = false;
                        None
                    }
                }
            },
        );
        if whole {
            let mut seen = std::collections::HashSet::new();
            for (at, item) in parsed.iter().enumerate() {
                let date = item["date"].as_str().unwrap_or_default().to_owned();
                if !seen.insert(date) {
                    deferred.duplicate_dates.push(at);
                }
            }
        }
        out.insert("dateOverrides".to_owned(), Value::Array(parsed));
    } else {
        issues.list(
            fields,
            "dateOverrides",
            Presence::Nullish,
            None,
            Some(366),
            |_, _| None::<()>,
        );
    }

    issues.whole_number(
        fields,
        "maxBookingsPerDay",
        Presence::Nullish,
        Number {
            min: Some(0.0),
            ..Number::default()
        },
    );

    for at in deferred.override_dates {
        issues.custom_at(
            &["dateOverrides".into(), at.into(), "date".into()],
            "Expected a date as YYYY-MM-DD",
        );
    }
    for (at, slot, overlap) in deferred.override_slots {
        let message = if overlap {
            "Time ranges must not overlap"
        } else {
            "End time must be after start time"
        };
        issues.custom_at(
            &[
                "dateOverrides".into(),
                at.into(),
                "slots".into(),
                slot.into(),
            ],
            message,
        );
    }
    for at in deferred.questions {
        issues.custom_at(
            &["questions".into(), at.into(), "options".into()],
            "A select field needs at least one option",
        );
    }
    for at in deferred.duplicate_dates {
        issues.custom_at(
            &["dateOverrides".into(), at.into(), "date".into()],
            "Each date can only have one override",
        );
    }
    if let Some((day, index, overlap)) = deferred.availability {
        let message = if overlap {
            format!("{day}: time ranges must not overlap")
        } else {
            format!("{day}: end time must be after start time")
        };
        issues.custom_at(&["availability".into(), day.into(), index.into()], &message);
    }
    out
}

/// `bookingQuestionSchema`: the parsed question, whether it kept its types
/// (its refinement runs), and whether it is a select without options.
fn question(issues: &mut Issues, item: &Value) -> Option<(Value, bool, bool)> {
    let fields = issues.object(item)?;
    let id = issues.text(fields, "id", Presence::Required, Some(1), Some(100));
    let label = issues.text_with(
        fields,
        "label",
        Presence::Required,
        Text::trimmed(Some(1), Some(200)),
    );
    let kind = issues.choice(
        fields,
        "type",
        Presence::Required,
        &["text", "textarea", "select"],
    );
    let required = issues.boolean(fields, "required", Presence::Required);
    let options = issues.list(
        fields,
        "options",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| issues.item_text(item, Text::length(Some(1), Some(200))),
    );
    let typed = |key: &str| fields.get(key).is_some_and(Value::is_string);
    let whole = typed("id")
        && typed("label")
        && kind.as_set().is_some()
        && required.as_set().is_some()
        && match fields.get("options") {
            None => true,
            Some(Value::Array(items)) => items.iter().all(Value::is_string),
            Some(_) => false,
        };
    let mut out = Map::new();
    let raw = |key: &str| fields.get(key).cloned().unwrap_or(Value::Null);
    out.insert(
        "id".to_owned(),
        id.into_option().map_or_else(|| raw("id"), Value::String),
    );
    let trimmed = fields
        .get("label")
        .and_then(Value::as_str)
        .map(|l| Value::String(weldsuite_kit::validation::js_trim(l).to_owned()));
    let _ = label;
    out.insert("label".to_owned(), trimmed.unwrap_or_else(|| raw("label")));
    out.insert("type".to_owned(), raw("type"));
    out.insert("required".to_owned(), raw("required"));
    let options_value = fields.get("options").cloned();
    if let Some(options) = &options_value {
        out.insert("options".to_owned(), options.clone());
    }
    let _ = options;
    let select_without_options = fields.get("type").and_then(Value::as_str) == Some("select")
        && options_value
            .as_ref()
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
    Some((Value::Object(out), whole, select_without_options))
}

/// One date override as Zod reads it.
struct OverrideRead {
    /// The date is a string that is not a real `YYYY-MM-DD` date: its
    /// refinement fails (whatever happens to the rest of the item).
    date_invalid: bool,
    /// The parsed override and its slots, unless the item is aborted (not
    /// an object, a date that is not a string, slots that lost their type).
    parsed: Option<(Value, Option<Vec<(String, String)>>)>,
}

/// `bookingDateOverrideSchema`.
fn date_override(issues: &mut Issues, item: &Value) -> OverrideRead {
    let Some(fields) = issues.object(item) else {
        return OverrideRead {
            date_invalid: false,
            parsed: None,
        };
    };
    let date = fields
        .get("date")
        .and_then(Value::as_str)
        .map(str::to_owned);
    issues.text(fields, "date", Presence::Required, None, None);
    let (slots, whole) = ranges(issues, fields, "slots", Presence::Required);
    let date_invalid = date.as_deref().is_some_and(|d| !is_valid_iso_date(d));
    let parsed = match (date, whole) {
        (Some(date), true) => {
            let value = json!({
                "date": date,
                "slots": slots.as_deref().map_or(Value::Null, ranges_value),
            });
            Some((value, slots))
        }
        _ => None,
    };
    OverrideRead {
        date_invalid,
        parsed,
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// The page columns a passthrough body may name, with their kind.
const COLUMNS: [(&str, &str, Kind); 21] = [
    ("id", "id", Kind::Text),
    ("deletedAt", "deleted_at", Kind::Timestamp),
    ("name", "name", Kind::Text),
    ("slug", "slug", Kind::Text),
    ("description", "description", Kind::Text),
    ("ownerId", "owner_id", Kind::Text),
    ("duration", "duration", Kind::Integer),
    ("bufferBefore", "buffer_before", Kind::Integer),
    ("bufferAfter", "buffer_after", Kind::Integer),
    ("color", "color", Kind::Text),
    ("isActive", "is_active", Kind::Boolean),
    ("locationType", "location_type", Kind::Text),
    ("locationValue", "location_value", Kind::Text),
    ("availability", "availability", Kind::Jsonb),
    ("questions", "questions", Kind::Jsonb),
    ("minNotice", "min_notice", Kind::Integer),
    ("maxAdvance", "max_advance", Kind::Integer),
    ("dateOverrides", "date_overrides", Kind::Jsonb),
    ("maxBookingsPerDay", "max_bookings_per_day", Kind::Integer),
    ("confirmationMessage", "confirmation_message", Kind::Text),
    ("timezone", "timezone", Kind::Text),
];

fn columns_of(
    data: &Map<String, Value>,
) -> Result<std::collections::HashMap<&'static str, Column>, Refusal> {
    let mut columns = std::collections::HashMap::new();
    for (key, _, kind) in COLUMNS {
        let column = passthrough::column(data, key, kind).map_err(|e| Refusal::Internal(e.0))?;
        columns.insert(key, column);
    }
    // `createdAt` / `updatedAt` from the body go through `toISOString()` too.
    for key in ["createdAt", "updatedAt"] {
        passthrough::column(data, key, Kind::Timestamp).map_err(|e| Refusal::Internal(e.0))?;
    }
    Ok(columns)
}

pub(crate) async fn create(
    State(state): State<CalendarState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_hooked(&headers, &body, |issues, fields| {
        page_body(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Failed to create booking page"),
    };
    create_page(&state, &caller, data)
        .await
        .unwrap_or_else(|refused| refused.respond("Failed to create booking page"))
}

async fn create_page(
    state: &CalendarState,
    caller: &Caller,
    mut data: Map<String, Value>,
) -> Outcome<Response> {
    let id = generate_id("bpg");
    let owner_id = data
        .get("ownerId")
        .and_then(Value::as_str)
        .filter(|o| !o.is_empty())
        .map_or_else(|| caller.user_id.clone(), str::to_owned);
    // `{ id, ...data, ownerId, createdAt, updatedAt }`: a body `id` wins.
    if !data.contains_key("id") {
        data.insert("id".to_owned(), Value::String(id.clone()));
    }
    data.insert("ownerId".to_owned(), Value::String(owner_id.clone()));
    data.remove("createdAt");
    data.remove("updatedAt");
    let columns = columns_of(&data)?;
    let col = |key: &str| passthrough::bind(&columns[key]);
    let (_, row_id) = col("id");
    let (_, name) = col("name");
    let (_, slug) = col("slug");
    let (_, description) = col("description");
    let (_, duration) = col("duration");
    let (set_before, before) = col("bufferBefore");
    let (set_after, after) = col("bufferAfter");
    let (_, color) = col("color");
    let (set_active, active) = col("isActive");
    let (_, location_type) = col("locationType");
    let (_, location_value) = col("locationValue");
    let (_, availability) = col("availability");
    let (_, questions) = col("questions");
    let (set_notice, notice) = col("minNotice");
    let (set_advance, advance) = col("maxAdvance");
    let (_, overrides) = col("dateOverrides");
    let (_, per_day) = col("maxBookingsPerDay");
    let (_, confirmation) = col("confirmationMessage");
    let (set_zone, zone) = col("timezone");
    sqlx::query(
        "insert into calendar_booking_pages
             (id, created_at, updated_at, deleted_at, name, slug, description, owner_id, duration,
              buffer_before, buffer_after, color, is_active, location_type, location_value,
              availability, questions, min_notice, max_advance, date_overrides,
              max_bookings_per_day, confirmation_message, timezone)
         values ($1, $2::timestamp, $2::timestamp, null, $3, $4, $5, $6, $7::integer,
                 case when $8 then $9::integer else 0 end,
                 case when $10 then $11::integer else 0 end,
                 $12,
                 case when $13 then $14::boolean else true end,
                 $15, $16, $17::jsonb, $18::jsonb,
                 case when $19 then $20::integer else 60 end,
                 case when $21 then $22::integer else 60 end,
                 $23::jsonb, $24::integer, $25,
                 case when $26 then $27 else 'UTC' end)",
    )
    .bind(&row_id)
    .bind(now())
    .bind(&name)
    .bind(&slug)
    .bind(&description)
    .bind(&owner_id)
    .bind(&duration)
    .bind(set_before)
    .bind(&before)
    .bind(set_after)
    .bind(&after)
    .bind(&color)
    .bind(set_active)
    .bind(&active)
    .bind(&location_type)
    .bind(&location_value)
    .bind(&availability)
    .bind(&questions)
    .bind(set_notice)
    .bind(&notice)
    .bind(set_advance)
    .bind(&advance)
    .bind(&overrides)
    .bind(&per_day)
    .bind(&confirmation)
    .bind(set_zone)
    .bind(&zone)
    .execute(&caller.db)
    .await?;
    caller.publish(
        state,
        CALENDAR_BOOKING_PAGE_CREATED,
        &id,
        &json!({ "id": id, "name": data["name"], "slug": data["slug"], "ownerId": owner_id }),
    );
    Ok(Created(json!({ "id": id })).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_hooked(&headers, &body, |issues, fields| {
        page_body(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Failed to update booking page"),
    };
    update_page(&state, &caller, &id, &data)
        .await
        .unwrap_or_else(|refused| refused.respond("Failed to update booking page"))
}

async fn update_page(
    state: &CalendarState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Outcome<Response> {
    let existing = scoped_page(caller, id).await?;
    let columns = columns_of(data)?;
    let updated_at =
        passthrough::column(data, "updatedAt", Kind::Timestamp).unwrap_or(Column::Absent);
    let created_at =
        passthrough::column(data, "createdAt", Kind::Timestamp).unwrap_or(Column::Absent);
    let col = |key: &str| passthrough::bind(&columns[key]);
    let (set_id, new_id) = col("id");
    let (set_deleted, _) = col("deletedAt");
    let (set_name, name) = col("name");
    let (set_slug, slug) = col("slug");
    let (set_description, description) = col("description");
    let (set_owner, owner) = col("ownerId");
    let (set_duration, duration) = col("duration");
    let (set_before, before) = col("bufferBefore");
    let (set_after, after) = col("bufferAfter");
    let (set_color, color) = col("color");
    let (set_active, active) = col("isActive");
    let (set_location_type, location_type) = col("locationType");
    let (set_location_value, location_value) = col("locationValue");
    let (set_availability, availability) = col("availability");
    let (set_questions, questions) = col("questions");
    let (set_notice, notice) = col("minNotice");
    let (set_advance, advance) = col("maxAdvance");
    let (set_overrides, overrides) = col("dateOverrides");
    let (set_per_day, per_day) = col("maxBookingsPerDay");
    let (set_confirmation, confirmation) = col("confirmationMessage");
    let (set_zone, zone) = col("timezone");
    sqlx::query(
        "update calendar_booking_pages set
             id = case when $2 then $3 else id end,
             created_at = case when $4 then null else created_at end,
             updated_at = case when $5 then null else $6::timestamp end,
             deleted_at = case when $7 then null else deleted_at end,
             name = case when $8 then $9 else name end,
             slug = case when $10 then $11 else slug end,
             description = case when $12 then $13 else description end,
             owner_id = case when $14 then $15 else owner_id end,
             duration = case when $16 then $17::integer else duration end,
             buffer_before = case when $18 then $19::integer else buffer_before end,
             buffer_after = case when $20 then $21::integer else buffer_after end,
             color = case when $22 then $23 else color end,
             is_active = case when $24 then $25::boolean else is_active end,
             location_type = case when $26 then $27 else location_type end,
             location_value = case when $28 then $29 else location_value end,
             availability = case when $30 then $31::jsonb else availability end,
             questions = case when $32 then $33::jsonb else questions end,
             min_notice = case when $34 then $35::integer else min_notice end,
             max_advance = case when $36 then $37::integer else max_advance end,
             date_overrides = case when $38 then $39::jsonb else date_overrides end,
             max_bookings_per_day = case when $40 then $41::integer else max_bookings_per_day end,
             confirmation_message = case when $42 then $43 else confirmation_message end,
             timezone = case when $44 then $45 else timezone end
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(set_id)
    .bind(&new_id)
    .bind(created_at.is_set())
    .bind(updated_at.is_set())
    .bind(now())
    .bind(set_deleted)
    .bind(set_name)
    .bind(&name)
    .bind(set_slug)
    .bind(&slug)
    .bind(set_description)
    .bind(&description)
    .bind(set_owner)
    .bind(&owner)
    .bind(set_duration)
    .bind(&duration)
    .bind(set_before)
    .bind(&before)
    .bind(set_after)
    .bind(&after)
    .bind(set_color)
    .bind(&color)
    .bind(set_active)
    .bind(&active)
    .bind(set_location_type)
    .bind(&location_type)
    .bind(set_location_value)
    .bind(&location_value)
    .bind(set_availability)
    .bind(&availability)
    .bind(set_questions)
    .bind(&questions)
    .bind(set_notice)
    .bind(&notice)
    .bind(set_advance)
    .bind(&advance)
    .bind(set_overrides)
    .bind(&overrides)
    .bind(set_per_day)
    .bind(&per_day)
    .bind(set_confirmation)
    .bind(&confirmation)
    .bind(set_zone)
    .bind(&zone)
    .execute(&caller.db)
    .await?;
    let pick = |key: &str| match data.get(key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => existing[key].clone(),
    };
    caller.publish(
        state,
        CALENDAR_BOOKING_PAGE_UPDATED,
        id,
        &json!({ "id": id, "name": pick("name"), "slug": pick("slug"), "ownerId": pick("ownerId") }),
    );
    Ok(Data(json!({ "id": id })).into_response())
}

// ── GET /:id/delete-impact ──────────────────────────────────────────────────

pub(crate) async fn delete_impact(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        scoped_page(&caller, &id).await?;
        let count: i64 = sqlx::query_scalar(
            "select count(*) from calendar_bookings
             where booking_page_id = $1 and deleted_at is null and status <> 'cancelled'
               and start_time >= $2::timestamp",
        )
        .bind(&id)
        .bind(now())
        .fetch_one(&caller.db)
        .await?;
        Ok::<_, Refusal>(json!({ "upcomingBookingCount": count }))
    }
    .await;
    match result {
        Ok(impact) => Data(impact).into_response(),
        Err(refused) => refused.respond("Failed to load booking page delete impact"),
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        scoped_page(&caller, &id).await?;
        let now = now();
        sqlx::query(
            "update calendar_booking_pages set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, CALENDAR_BOOKING_PAGE_DELETED, &id, &json!({ "id": id }));
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(refused) => refused.respond("Failed to delete booking page"),
    }
}

// ── PATCH /:id/toggle ───────────────────────────────────────────────────────

pub(crate) async fn toggle(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let record = scoped_page(&caller, &id).await?;
        let was = record["isActive"].clone();
        let is_active = !crate::js::truthy(&was);
        sqlx::query(
            "update calendar_booking_pages set is_active = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(is_active)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let mut changes = Map::new();
        changes.insert("isActive".to_owned(), json!({ "old": was, "new": is_active }));
        state.events.publish(
            &caller.events,
            weldsuite_events::EntityEvent::new(
                CALENDAR_BOOKING_PAGE_UPDATED,
                id.clone(),
                json!({
                    "id": id,
                    "name": record["name"],
                    "slug": record["slug"],
                    "ownerId": record["ownerId"],
                }),
            )
            .with_changes(changes),
        );
        Ok::<_, Refusal>(is_active)
    }
    .await;
    match result {
        Ok(is_active) => Data(json!({ "id": id, "isActive": is_active })).into_response(),
        Err(refused) => refused.respond("Failed to toggle booking page"),
    }
}

// ── GET /:id/available-slots ────────────────────────────────────────────────

pub(crate) async fn available_slots(
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let date = match validate_query_hooked(query.as_deref(), |issues, fields| {
        issues
            .text(fields, "date", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(date) => date,
        Err(refused) => return refused.respond("Failed to compute available slots"),
    };
    let result = async {
        let page = scoped_page(&caller, &id).await?;
        crate::slots::available_slots(&caller.db, &page, &date, crate::js::now_ms()).await
    }
    .await;
    match result {
        Ok(slots) => Data(slots).into_response(),
        Err(refused) => refused.respond("Failed to compute available slots"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_and_dates_are_checked() {
        assert!(is_hhmm("09:00"));
        assert!(is_hhmm("23:59"));
        assert!(!is_hhmm("9:00"));
        assert!(!is_hhmm("24:00"));
        assert!(is_valid_iso_date("2030-12-25"));
        assert!(!is_valid_iso_date("2030-02-30"));
        assert!(!is_valid_iso_date("25-12-2030"));
    }

    #[test]
    fn overlapping_and_backwards_ranges_are_found() {
        let r = |s: &str, e: &str| (s.to_owned(), e.to_owned());
        assert_eq!(range_problem(&[r("18:00", "17:00")]), Some((0, false)));
        assert_eq!(
            range_problem(&[r("09:00", "12:00"), r("11:00", "14:00")]),
            Some((1, true))
        );
        assert_eq!(
            range_problem(&[r("09:00", "12:00"), r("12:00", "14:00")]),
            None
        );
    }
}
