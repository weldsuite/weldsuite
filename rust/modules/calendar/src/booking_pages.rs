//! `/api/booking-pages` (`routes/booking-pages/index.ts`): booking pages,
//! owner-scoped unless `bookings:scope:all`, with their slot availability.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CALENDAR_BOOKING_PAGE_CREATED, CALENDAR_BOOKING_PAGE_DELETED, CALENDAR_BOOKING_PAGE_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{calendar_booking_pages as pages, calendar_bookings};

use crate::access::row_json;
use crate::bookings::{Paging, first_values, scope_for};
use crate::passthrough::{self, Column, Kind};
use crate::{
    CalendarState, Caller, Outcome, Refusal, now, page, validate_hooked, validate_query_hooked,
};

const NOT_FOUND: &str = "Booking page";

/// The live page, within the caller's scope: 404 otherwise.
async fn scoped_page(caller: &Caller, id: &str) -> Outcome<Value> {
    let mut find = pages::Entity::find()
        .filter(pages::Column::Id.eq(id))
        .filter(pages::Column::DeletedAt.is_null());
    if let Some(scope) = scope_for(caller) {
        find = find.filter(pages::Column::OwnerId.eq(scope));
    }
    let row = find.one(&orm(&caller.db)).await?;
    row.map(row_json)
        .transpose()?
        .ok_or_else(|| Refusal::not_found(NOT_FOUND, id))
}

/// The list's conditions that are on (`and(...conditions)`): the scope, the
/// owner, the search and the keyset.
struct PageFilters<'a> {
    scope: Option<&'a str>,
    owner: Option<&'a str>,
    search: Option<&'a str>,
    cursor: Option<&'a (time::PrimitiveDateTime, String)>,
}

impl PageFilters<'_> {
    fn condition(&self) -> Condition {
        let mut all = Condition::all();
        if let Some(scope) = self.scope {
            all = all.add(pages::Column::OwnerId.eq(scope));
        }
        if let Some(owner) = self.owner {
            all = all.add(pages::Column::OwnerId.eq(owner));
        }
        if let Some(search) = self.search {
            all = all.add(
                Condition::any()
                    .add(pages::Column::Name.like(search))
                    .add(pages::Column::Slug.like(search)),
            );
        }
        if let Some((at, id)) = self.cursor {
            all = all.add(
                Condition::any().add(pages::Column::CreatedAt.lt(*at)).add(
                    Condition::all()
                        .add(pages::Column::CreatedAt.eq(*at))
                        .add(pages::Column::Id.lt(id.as_str())),
                ),
            );
        }
        all
    }
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
    let filters = |list: &[(&str, bool)]| PageFilters {
        scope: scope.as_deref().filter(|_| on(list, "scope")),
        owner: owner.as_deref().filter(|_| on(list, "owner")),
        search: search.as_deref().filter(|_| on(list, "search")),
        cursor: cursor.as_ref().filter(|_| on(list, "cursor")),
    };
    let result = async {
        let db = orm(&caller.db);
        let rows = pages::Entity::find()
            .filter(pages::Column::DeletedAt.is_null())
            .filter(filters(&applied).condition())
            .order_by_desc(pages::Column::CreatedAt)
            .order_by_desc(pages::Column::Id)
            .limit(paging.sql_limit().and_then(|l| u64::try_from(l).ok()))
            .all(&db)
            .await?;
        let mut counted = pages::Entity::find();
        if count_keeps_deleted {
            counted = counted.filter(pages::Column::DeletedAt.is_null());
        }
        let total = counted
            .filter(filters(&count).condition())
            .count(&db)
            .await?;
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
    let typed = matches!(value, None | Some(Value::Array(_)));
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
                if let Some((value, slots)) = read.parsed {
                    if let Some(slots) = &slots
                        && let Some((slot, overlap)) = range_problem(slots)
                    {
                        deferred.override_slots.push((at, slot, overlap));
                    }
                    parsed.push(value.clone());
                    Some(value)
                } else {
                    whole = false;
                    None
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
    parsed: Option<ParsedOverride>,
}

/// An override as stored, and its slots when they kept their types.
type ParsedOverride = (Value, Option<Vec<(String, String)>>);

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

/// A passthrough value as the driver handed it to Postgres: text, cast to
/// the column's type (`$n::integer`), `NULL` for a `null`.
fn cast(column: &Column, sql_type: &'static str) -> Expr {
    sea_orm::ExprTrait::cast_as(plain(column), sql_type)
}

/// A passthrough text value (`NULL` for a `null` or a key left out).
fn plain(column: &Column) -> Expr {
    Expr::value(passthrough::bind(column).1)
}

/// The value of a column with a default: the body's when it names the
/// column, else `default` (`case when $set then $value else <default> end`).
fn or_default(column: &Column, value: Expr, default: Expr) -> Expr {
    if column.is_set() { value } else { default }
}

/// `insert into calendar_booking_pages (…) values (…)`: every column, the
/// body's values cast by Postgres, the defaults the TypeScript schema has
/// where the body leaves a column out.
async fn insert_page(
    db: &weldsuite_db::PgPool,
    columns: &std::collections::HashMap<&'static str, Column>,
    owner_id: &str,
) -> Result<(), DbErr> {
    use pages::Column as P;
    let col = |key: &str| &columns[key];
    let now = now();
    let mut insert = Query::insert();
    insert
        .into_table(pages::Entity)
        .columns([
            P::Id,
            P::CreatedAt,
            P::UpdatedAt,
            P::DeletedAt,
            P::Name,
            P::Slug,
            P::Description,
            P::OwnerId,
            P::Duration,
            P::BufferBefore,
            P::BufferAfter,
            P::Color,
            P::IsActive,
            P::LocationType,
            P::LocationValue,
            P::Availability,
            P::Questions,
            P::MinNotice,
            P::MaxAdvance,
            P::DateOverrides,
            P::MaxBookingsPerDay,
            P::ConfirmationMessage,
            P::Timezone,
        ])
        .values([
            plain(col("id")),
            Expr::value(now),
            Expr::value(now),
            Expr::value(Option::<time::PrimitiveDateTime>::None),
            plain(col("name")),
            plain(col("slug")),
            plain(col("description")),
            Expr::value(owner_id.to_owned()),
            cast(col("duration"), "integer"),
            or_default(
                col("bufferBefore"),
                cast(col("bufferBefore"), "integer"),
                Expr::value(0),
            ),
            or_default(
                col("bufferAfter"),
                cast(col("bufferAfter"), "integer"),
                Expr::value(0),
            ),
            plain(col("color")),
            or_default(
                col("isActive"),
                cast(col("isActive"), "boolean"),
                Expr::value(true),
            ),
            plain(col("locationType")),
            plain(col("locationValue")),
            cast(col("availability"), "jsonb"),
            cast(col("questions"), "jsonb"),
            or_default(
                col("minNotice"),
                cast(col("minNotice"), "integer"),
                Expr::value(60),
            ),
            or_default(
                col("maxAdvance"),
                cast(col("maxAdvance"), "integer"),
                Expr::value(60),
            ),
            cast(col("dateOverrides"), "jsonb"),
            cast(col("maxBookingsPerDay"), "integer"),
            plain(col("confirmationMessage")),
            or_default(col("timezone"), plain(col("timezone")), Expr::value("UTC")),
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?;
    orm(db).execute(&insert).await?;
    Ok(())
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
    insert_page(&caller.db, &columns, &owner_id).await?;
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
    use pages::Column as P;
    let existing = scoped_page(caller, id).await?;
    let columns = columns_of(data)?;
    let updated_at =
        passthrough::column(data, "updatedAt", Kind::Timestamp).unwrap_or(Column::Absent);
    let created_at =
        passthrough::column(data, "createdAt", Kind::Timestamp).unwrap_or(Column::Absent);
    let null_stamp = || Expr::value(Option::<time::PrimitiveDateTime>::None);
    // `set({ ...data, updatedAt: new Date() })`: only the columns the body
    // names, each as the driver handed it over (a timestamp can only be
    // `null` here: anything else threw above).
    let mut update = pages::Entity::update_many();
    if columns["id"].is_set() {
        update = update.col_expr(P::Id, plain(&columns["id"]));
    }
    if created_at.is_set() {
        update = update.col_expr(P::CreatedAt, null_stamp());
    }
    update = update.col_expr(
        P::UpdatedAt,
        if updated_at.is_set() {
            null_stamp()
        } else {
            Expr::value(now())
        },
    );
    if columns["deletedAt"].is_set() {
        update = update.col_expr(P::DeletedAt, null_stamp());
    }
    for (key, column, sql_type) in [
        ("name", P::Name, None),
        ("slug", P::Slug, None),
        ("description", P::Description, None),
        ("ownerId", P::OwnerId, None),
        ("duration", P::Duration, Some("integer")),
        ("bufferBefore", P::BufferBefore, Some("integer")),
        ("bufferAfter", P::BufferAfter, Some("integer")),
        ("color", P::Color, None),
        ("isActive", P::IsActive, Some("boolean")),
        ("locationType", P::LocationType, None),
        ("locationValue", P::LocationValue, None),
        ("availability", P::Availability, Some("jsonb")),
        ("questions", P::Questions, Some("jsonb")),
        ("minNotice", P::MinNotice, Some("integer")),
        ("maxAdvance", P::MaxAdvance, Some("integer")),
        ("dateOverrides", P::DateOverrides, Some("jsonb")),
        ("maxBookingsPerDay", P::MaxBookingsPerDay, Some("integer")),
        ("confirmationMessage", P::ConfirmationMessage, None),
        ("timezone", P::Timezone, None),
    ] {
        let value = &columns[key];
        if value.is_set() {
            let expr = match sql_type {
                Some(sql_type) => cast(value, sql_type),
                None => plain(value),
            };
            update = update.col_expr(column, expr);
        }
    }
    update
        .filter(P::Id.eq(id))
        .filter(P::DeletedAt.is_null())
        .exec(&orm(&caller.db))
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
        let count = calendar_bookings::Entity::find()
            .filter(calendar_bookings::Column::BookingPageId.eq(id.as_str()))
            .filter(calendar_bookings::Column::DeletedAt.is_null())
            .filter(calendar_bookings::Column::Status.ne("cancelled"))
            .filter(calendar_bookings::Column::StartTime.gte(now()))
            .count(&orm(&caller.db))
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
        pages::Entity::update_many()
            .col_expr(pages::Column::DeletedAt, Expr::value(now))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now))
            .filter(pages::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            CALENDAR_BOOKING_PAGE_DELETED,
            &id,
            &json!({ "id": id }),
        );
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
        pages::Entity::update_many()
            .col_expr(pages::Column::IsActive, Expr::value(is_active))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now()))
            .filter(pages::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let mut changes = Map::new();
        changes.insert(
            "isActive".to_owned(),
            json!({ "old": was, "new": is_active }),
        );
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
