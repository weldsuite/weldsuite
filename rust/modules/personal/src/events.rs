//! `/api/calendar-events` (`routes/calendar-events.ts`): the events of a
//! person's own calendars.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use axum::routing::{get, patch};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};

use crate::PersonalState;
use crate::calendars::{get_for_account, resolve_requested};
use crate::caller::{
    Caller, Failure, answer, created, data, list, no_content, rows, unhandled, validate,
    validate_query,
};
use crate::js::{date_iso, js_number, now_iso};

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/calendar-events", get(list_events).post(create))
        .route("/api/calendar-events/range", get(range))
        .route(
            "/api/calendar-events/{id}",
            get(get_one).patch(update).delete(remove),
        )
        .route("/api/calendar-events/{id}/cancel", patch(cancel))
}

const TYPES: [&str; 6] = [
    "meeting",
    "call",
    "appointment",
    "event",
    "reminder",
    "other",
];

/// The body of `createSchema`, or of its `.partial().omit({ calendarId,
/// recurrenceId })`, as Zod hands it to the route: every field the body
/// set, in the schema's order (`echo`, what `{ id, ...data }` answers), and
/// the values the writes take.
#[derive(Default)]
struct EventInput {
    calendar_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    status: Option<String>,
    priority: Option<String>,
    all_day: Option<bool>,
    is_virtual: Option<bool>,
    /// Field → value, as parsed (unknown keys of nested objects dropped).
    echo: Map<String, Value>,
}

/// One string field of the schema, kept in `echo` when set.
fn text_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    echo: &mut Map<String, Value>,
    key: &str,
    presence: Presence,
    rules: Text,
) -> Option<String> {
    let value = issues.text_with(body, key, presence, rules).into_option();
    if let Some(value) = &value {
        echo.insert(key.to_owned(), Value::String(value.clone()));
    }
    value
}

fn choice_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    echo: &mut Map<String, Value>,
    key: &str,
    options: &[&str],
) -> Option<String> {
    let value = issues
        .choice(body, key, Presence::Optional, options)
        .into_option();
    if let Some(value) = &value {
        echo.insert(key.to_owned(), Value::String(value.clone()));
    }
    value
}

fn bool_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    echo: &mut Map<String, Value>,
    key: &str,
) -> Option<bool> {
    let value = issues.boolean(body, key, Presence::Optional).into_option();
    if let Some(value) = value {
        echo.insert(key.to_owned(), Value::Bool(value));
    }
    value
}

/// Read the event schema. `create`: `createSchema` (calendarId, title and
/// startTime required, type defaulting to `meeting`); otherwise the update's
/// partial without calendarId and recurrenceId.
fn read_event(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> EventInput {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let any = Text::length(None, None);
    let mut input = EventInput::default();
    let mut echo = Map::new();
    if create {
        input.calendar_id = text_field(
            issues,
            body,
            &mut echo,
            "calendarId",
            required,
            Text::length(Some(1), None),
        );
    }
    text_field(
        issues,
        body,
        &mut echo,
        "title",
        required,
        Text::length(Some(1), Some(255)),
    );
    text_field(
        issues,
        body,
        &mut echo,
        "description",
        Presence::Optional,
        any,
    );
    let kind = choice_field(issues, body, &mut echo, "type", &TYPES);
    if create && kind.is_none() && !body.contains_key("type") {
        // `.default('meeting')`.
        echo.insert("type".to_owned(), json!("meeting"));
    }
    input.start_time = text_field(
        issues,
        body,
        &mut echo,
        "startTime",
        required,
        Text::length(Some(1), None),
    );
    input.end_time = text_field(issues, body, &mut echo, "endTime", Presence::Optional, any);
    input.all_day = bool_field(issues, body, &mut echo, "allDay");
    text_field(issues, body, &mut echo, "timezone", Presence::Optional, any);
    text_field(issues, body, &mut echo, "location", Presence::Optional, any);
    input.is_virtual = bool_field(issues, body, &mut echo, "isVirtual");
    text_field(
        issues,
        body,
        &mut echo,
        "meetingUrl",
        Presence::Optional,
        any,
    );
    input.status = choice_field(
        issues,
        body,
        &mut echo,
        "status",
        &["confirmed", "tentative", "cancelled"],
    );
    input.priority = choice_field(
        issues,
        body,
        &mut echo,
        "priority",
        &["low", "normal", "high", "urgent"],
    );
    text_field(issues, body, &mut echo, "color", Presence::Optional, any);
    text_field(
        issues,
        body,
        &mut echo,
        "recurrenceRule",
        Presence::Optional,
        any,
    );
    if create {
        text_field(
            issues,
            body,
            &mut echo,
            "recurrenceId",
            Presence::Optional,
            any,
        );
    }
    let attendees = issues.list(
        body,
        "attendees",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let mut attendee = Map::new();
            let email = Text {
                format: Some(Format::Email),
                ..Text::length(None, None)
            };
            if let Some(value) = issues
                .text_with(fields, "email", Presence::Required, email)
                .into_option()
            {
                attendee.insert("email".to_owned(), Value::String(value));
            }
            for key in ["name", "status", "role"] {
                if let Some(value) = issues
                    .text(fields, key, Presence::Optional, None, None)
                    .into_option()
                {
                    attendee.insert(key.to_owned(), Value::String(value));
                }
            }
            Some(Value::Object(attendee))
        },
    );
    if let Some(attendees) = attendees.into_option() {
        echo.insert("attendees".to_owned(), Value::Array(attendees));
    }
    let reminders = issues.list(
        body,
        "reminders",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let kind = issues
                .choice(
                    fields,
                    "type",
                    Presence::Required,
                    &["email", "notification"],
                )
                .into_option();
            let minutes = issues
                .number(fields, "minutes", Presence::Required, Number::default())
                .into_option();
            let mut reminder = Map::new();
            if let Some(kind) = kind {
                reminder.insert("type".to_owned(), Value::String(kind));
            }
            if minutes.is_some()
                && let Some(original) = fields.get("minutes")
            {
                reminder.insert("minutes".to_owned(), js_number(original));
            }
            Some(Value::Object(reminder))
        },
    );
    if let Some(reminders) = reminders.into_option() {
        echo.insert("reminders".to_owned(), Value::Array(reminders));
    }
    text_field(issues, body, &mut echo, "notes", Presence::Optional, any);
    let tags = issues.list(
        body,
        "tags",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, any).map(Value::String),
    );
    if let Some(tags) = tags.into_option() {
        echo.insert("tags".to_owned(), Value::Array(tags));
    }
    input.echo = echo;
    input
}

/// A text field of the parsed body.
fn text<'a>(input: &'a EventInput, key: &str) -> Option<&'a str> {
    input.echo.get(key).and_then(Value::as_str)
}

/// `new Date(text)` bound to a query: an Invalid Date throws.
fn bound_date(text: &str) -> Result<String, Failure> {
    date_iso(text).ok_or_else(|| Failure::Internal("RangeError: Invalid time value".to_owned()))
}

/// The event of the account, or `None`.
async fn find(db: &PgPool, account: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from personal_calendar_events t
         where t.id = $1 and t.personal_account_id = $2 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await?;
    Ok(found.map(weldsuite_db::js_row))
}

/// `listQuerySchema`.
struct ListQuery {
    limit: f64,
    cursor: Option<String>,
    search: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    calendar_ids: Option<String>,
}

/// A query's `.limit(n + 1)` and `rows.length > n`: Postgres takes only a
/// whole number.
fn whole_limit(limit: f64) -> Result<i64, Failure> {
    if limit.fract() == 0.0 && limit.is_finite() {
        #[allow(clippy::cast_possible_truncation)]
        Ok(limit as i64)
    } else {
        Err(Failure::Internal(format!(
            "invalid input syntax for type bigint: \"{}\"",
            limit + 1.0
        )))
    }
}

/// `GET /api/calendar-events`.
async fn list_events(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let optional = |issues: &mut Issues, key: &str| {
            issues
                .text(q, key, Presence::Optional, None, None)
                .into_option()
        };
        ListQuery {
            limit: issues
                .number(
                    q,
                    "limit",
                    Presence::Optional,
                    Number {
                        coerce: true,
                        int: false,
                        min: Some(1.0),
                        max: Some(100.0),
                    },
                )
                .into_option()
                .unwrap_or(25.0),
            cursor: optional(issues, "cursor"),
            search: optional(issues, "search"),
            kind: optional(issues, "type"),
            status: optional(issues, "status"),
            start_date: optional(issues, "startDate"),
            end_date: optional(issues, "endDate"),
            calendar_ids: optional(issues, "calendarIds"),
        }
    }) {
        Ok(query) => query,
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
        let calendars = resolve_requested(&db, &account, query.calendar_ids.as_deref()).await?;
        if calendars.is_empty() {
            return Ok(list(Vec::new(), 0, false, None));
        }
        let non_empty = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
        let start = non_empty(&query.start_date);
        let end = non_empty(&query.end_date);
        let term = non_empty(&query.search).map(|search| format!("%{search}%"));
        let cursor = match non_empty(&query.cursor) {
            Some(cursor) => {
                let found: Option<(Value, String)> = sqlx::query_as(
                    "select to_jsonb(t.created_at), t.id from personal_calendar_events t
                     where t.id = $1 limit 1",
                )
                .bind(&cursor)
                .fetch_optional(&db)
                .await?;
                found.and_then(|(at, id)| {
                    at.as_str()
                        .and_then(weldsuite_db::js_timestamp)
                        .map(|at| (at, id))
                })
            }
            None => None,
        };
        let start = start.as_deref().map(bound_date).transpose()?;
        let end = end.as_deref().map(bound_date).transpose()?;
        let limit = whole_limit(query.limit)?;
        let (cursor_at, cursor_id) = cursor.unzip();
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from personal_calendar_events t
             where t.deleted_at is null and t.personal_account_id = $1
               and t.calendar_id = any($2::text[])
               and ($3::text is null or t.type = $3)
               and ($4::text is null or t.status = $4)
               and ($5::timestamp is null or t.start_time >= $5::timestamp)
               and ($6::timestamp is null or t.start_time <= $6::timestamp)
               and ($7::text is null or (t.title like $7 or t.description like $7))
               and ($8::timestamp is null
                    or (t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9)))
             order by t.created_at desc, t.id desc
             limit $10",
        )
        .bind(&account)
        .bind(&calendars)
        .bind(non_empty(&query.kind))
        .bind(non_empty(&query.status))
        .bind(&start)
        .bind(&end)
        .bind(&term)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from personal_calendar_events t
             where t.deleted_at is null and t.personal_account_id = $1
               and t.calendar_id = any($2::text[])
               and ($3::text is null or t.type = $3)
               and ($4::text is null or t.status = $4)
               and ($5::timestamp is null or t.start_time >= $5::timestamp)
               and ($6::timestamp is null or t.start_time <= $6::timestamp)
               and ($7::text is null or (t.title like $7 or t.description like $7))",
        )
        .bind(&account)
        .bind(&calendars)
        .bind(non_empty(&query.kind))
        .bind(non_empty(&query.status))
        .bind(&start)
        .bind(&end)
        .bind(&term)
        .fetch_one(&db)
        .await?;
        Ok(page(rows(found), limit, total))
    }
    .await;
    answer(result, "Failed to list calendar events")
}

/// `hasMore`, the page and the next cursor (the last row's id).
pub(crate) fn page(mut found: Vec<Value>, limit: i64, total: i64) -> Response {
    let has_more = i64::try_from(found.len()).unwrap_or(0) > limit;
    if has_more {
        found.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let cursor = if has_more {
        found
            .last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    list(found, total, has_more, cursor)
}

/// `GET /api/calendar-events/range?startDate=&endDate=&calendarIds=`.
async fn range(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        (
            issues
                .text(q, "startDate", Presence::Required, Some(1), None)
                .into_option(),
            issues
                .text(q, "endDate", Presence::Required, Some(1), None)
                .into_option(),
            issues
                .text(q, "calendarIds", Presence::Optional, None, None)
                .into_option(),
        )
    }) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let (start, end, calendar_ids) = query;
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let calendars = resolve_requested(&db, &account, calendar_ids.as_deref()).await?;
        if calendars.is_empty() {
            return Ok(data(json!([])));
        }
        let start = bound_date(start.as_deref().unwrap_or_default())?;
        let end = bound_date(end.as_deref().unwrap_or_default())?;
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from personal_calendar_events t
             where t.deleted_at is null and t.personal_account_id = $1
               and t.calendar_id = any($2::text[])
               and t.start_time >= $3::timestamp and t.start_time <= $4::timestamp
             order by t.start_time",
        )
        .bind(&account)
        .bind(&calendars)
        .bind(&start)
        .bind(&end)
        .fetch_all(&db)
        .await?;
        Ok(data(Value::Array(rows(found))))
    }
    .await;
    answer(result, "Failed to fetch events")
}

/// `GET /api/calendar-events/:id`.
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
            None => Err(ApiError::not_found("Calendar event", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch calendar event")
}

/// A JSON field of the parsed body for a `jsonb` column.
fn json_field(input: &EventInput, key: &str) -> Option<Value> {
    input.echo.get(key).cloned()
}

/// `POST /api/calendar-events`: in one of the account's calendars.
async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_event(issues, b, true)) {
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
        let calendar = input.calendar_id.clone().unwrap_or_default();
        if get_for_account(&db, &account, &calendar).await?.is_none() {
            return Err(ApiError::forbidden().into());
        }
        let start = bound_date(input.start_time.as_deref().unwrap_or_default())?;
        let end = match input.end_time.as_deref().filter(|end| !end.is_empty()) {
            Some(end) => Some(bound_date(end)?),
            None => None,
        };
        let id = weldsuite_kit::generate_id("evt");
        let now = now_iso();
        sqlx::query(
            "insert into personal_calendar_events
               (id, personal_account_id, calendar_id, title, description, type, start_time, end_time,
                all_day, timezone, location, is_virtual, meeting_url, status, priority, color,
                recurrence_rule, recurrence_id, organizer_id, attendees, reminders, notes, tags,
                created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp,
                     coalesce($9, false), $10, $11, coalesce($12, false), $13, $14, $15, $16,
                     $17, $18, $19, $20::jsonb, $21::jsonb, $22, $23::jsonb,
                     $24::timestamp, $24::timestamp)",
        )
        .bind(&id)
        .bind(&account)
        .bind(&calendar)
        .bind(text(&input, "title"))
        .bind(text(&input, "description"))
        .bind(text(&input, "type"))
        .bind(&start)
        .bind(&end)
        .bind(input.all_day)
        .bind(text(&input, "timezone"))
        .bind(text(&input, "location"))
        .bind(input.is_virtual)
        .bind(text(&input, "meetingUrl"))
        .bind(input.status.as_deref().filter(|s| !s.is_empty()).unwrap_or("confirmed"))
        .bind(input.priority.as_deref().filter(|p| !p.is_empty()).unwrap_or("normal"))
        .bind(text(&input, "color"))
        .bind(text(&input, "recurrenceRule"))
        .bind(text(&input, "recurrenceId"))
        .bind(&caller.user_id)
        .bind(json_field(&input, "attendees"))
        .bind(json_field(&input, "reminders"))
        .bind(text(&input, "notes"))
        .bind(json_field(&input, "tags"))
        .bind(&now)
        .execute(&db)
        .await?;
        Ok(created(json!({ "id": id })))
    }
    .await;
    answer(result, "Failed to create calendar event")
}

/// `PATCH /api/calendar-events/:id`: the fields the body set.
async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_event(issues, b, false)) {
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
        if find(&db, &account, &id).await?.is_none() {
            return Err(Failure::from(ApiError::not_found(
                "Calendar event",
                Some(&id),
            )));
        }
        let start = input.start_time.as_deref().map(bound_date).transpose()?;
        let end = input.end_time.as_deref().map(bound_date).transpose()?;
        let set = |key: &str| input.echo.contains_key(key);
        sqlx::query(
            "update personal_calendar_events set
               updated_at = $3::timestamp,
               title = case when $4 then $5 else title end,
               description = case when $6 then $7 else description end,
               type = case when $8 then $9 else type end,
               start_time = case when $10 then $11::timestamp else start_time end,
               end_time = case when $12 then $13::timestamp else end_time end,
               all_day = case when $14 then $15 else all_day end,
               timezone = case when $16 then $17 else timezone end,
               location = case when $18 then $19 else location end,
               is_virtual = case when $20 then $21 else is_virtual end,
               meeting_url = case when $22 then $23 else meeting_url end,
               status = case when $24 then $25 else status end,
               priority = case when $26 then $27 else priority end,
               color = case when $28 then $29 else color end,
               recurrence_rule = case when $30 then $31 else recurrence_rule end,
               attendees = case when $32 then $33::jsonb else attendees end,
               reminders = case when $34 then $35::jsonb else reminders end,
               notes = case when $36 then $37 else notes end,
               tags = case when $38 then $39::jsonb else tags end
             where id = $1 and personal_account_id = $2 and deleted_at is null",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .bind(set("title"))
        .bind(text(&input, "title"))
        .bind(set("description"))
        .bind(text(&input, "description"))
        .bind(set("type"))
        .bind(text(&input, "type"))
        .bind(start.is_some())
        .bind(&start)
        .bind(end.is_some())
        .bind(&end)
        .bind(input.all_day.is_some())
        .bind(input.all_day)
        .bind(set("timezone"))
        .bind(text(&input, "timezone"))
        .bind(set("location"))
        .bind(text(&input, "location"))
        .bind(input.is_virtual.is_some())
        .bind(input.is_virtual)
        .bind(set("meetingUrl"))
        .bind(text(&input, "meetingUrl"))
        .bind(set("status"))
        .bind(text(&input, "status"))
        .bind(set("priority"))
        .bind(text(&input, "priority"))
        .bind(set("color"))
        .bind(text(&input, "color"))
        .bind(set("recurrenceRule"))
        .bind(text(&input, "recurrenceRule"))
        .bind(set("attendees"))
        .bind(json_field(&input, "attendees"))
        .bind(set("reminders"))
        .bind(json_field(&input, "reminders"))
        .bind(set("notes"))
        .bind(text(&input, "notes"))
        .bind(set("tags"))
        .bind(json_field(&input, "tags"))
        .execute(&db)
        .await?;
        let mut answer_body = Map::new();
        answer_body.insert("id".to_owned(), Value::String(id.clone()));
        answer_body.extend(input.echo.clone());
        Ok(data(Value::Object(answer_body)))
    }
    .await;
    answer(result, "Failed to update calendar event")
}

/// `DELETE /api/calendar-events/:id`: soft delete.
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
            return Err(Failure::from(ApiError::not_found("Calendar event", Some(&id))));
        }
        sqlx::query(
            "update personal_calendar_events set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = $1 and personal_account_id = $2 and deleted_at is null",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .execute(&db)
        .await?;
        Ok(no_content())
    }
    .await;
    answer(result, "Failed to delete calendar event")
}

/// `PATCH /api/calendar-events/:id/cancel`.
async fn cancel(caller: Caller, Path(id): Path<String>) -> Response {
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
            return Err(Failure::from(ApiError::not_found(
                "Calendar event",
                Some(&id),
            )));
        }
        sqlx::query(
            "update personal_calendar_events set status = 'cancelled', updated_at = $3::timestamp
             where id = $1 and personal_account_id = $2 and deleted_at is null",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .execute(&db)
        .await?;
        Ok(data(json!({ "id": id, "status": "cancelled" })))
    }
    .await;
    answer(result, "Failed to cancel calendar event")
}
