//! `/api/calendar-events` (`routes/calendar-events/index.ts`): events of the
//! calendars the caller can see, with the linked WeldMeet meetings kept in
//! step, attendee mail, and a push to the workspace's Google calendars after
//! every change.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CALENDAR_EVENT_CREATED, CALENDAR_EVENT_DELETED, CALENDAR_EVENT_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::EntityEvent;
use weldsuite_kit::validation::Field;
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::access;
use crate::event_input::{
    AttendeeIn, EventInput, read_event, read_list_query, read_range_query, read_reschedule,
    read_upcoming_query,
};
use crate::google::{self, PushAction};
use crate::js::{DAY_MS, Ordered, iso, millis_of, now_ms, parse_date};
use crate::mail::{self, Attendee, MailEvent, MailKind, SendOptions};
use crate::meetings;
use crate::{
    CalendarState, Caller, Outcome, Refusal, now, page, query_param, text, validate, validate_query,
};

const NOT_FOUND: &str = "Calendar event";

/// A live event by id.
async fn event_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from calendar_events e where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The event, when it is live and on a calendar the caller can see: 404
/// otherwise.
async fn visible_event(caller: &Caller, id: &str) -> Outcome<Value> {
    let Some(row) = event_row(&caller.db, id).await? else {
        return Err(Refusal::not_found(NOT_FOUND, id));
    };
    let accessible = access::accessible_calendar_ids(&caller.db, &caller.user_id).await?;
    if !accessible.iter().any(|c| c == text(&row, "calendarId")) {
        return Err(Refusal::not_found(NOT_FOUND, id));
    }
    Ok(row)
}

/// `isoOrNull` of a stored timestamp.
fn iso_or_null(value: &Value) -> Value {
    millis_of(value).map_or(Value::Null, |ms| Value::String(iso(ms)))
}

/// Why a start/end pair is not a valid range (`timeRangeError`): an event
/// ends after it starts; an all-day one may end the same instant.
fn time_range_error(
    start: Option<i64>,
    end: Option<Option<i64>>,
    all_day: bool,
) -> Option<&'static str> {
    let Some(start) = start else {
        return Some("startTime is not a valid date");
    };
    let end = end?;
    let Some(end) = end else {
        return Some("endTime is not a valid date");
    };
    let ok = if all_day { end >= start } else { end > start };
    (!ok).then_some("endTime must be after startTime")
}

/// `new Date(text)` bound for a timestamp column: `Err` (500) for an Invalid
/// Date, which the driver refuses.
fn date_param(text: &str) -> Outcome<String> {
    parse_date(text)
        .map(iso)
        .ok_or_else(|| Refusal::Internal(format!("invalid date: {text}")))
}

/// `q.limit` as `.limit(n)` binds it: a fraction is refused by the driver.
#[allow(clippy::cast_possible_truncation)]
fn limit_param(limit: f64) -> Outcome<i64> {
    if limit.fract() == 0.0 {
        Ok(limit as i64)
    } else {
        Err(Refusal::Internal(format!(
            "limit {limit} is not an integer"
        )))
    }
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let q = match validate_query(query.as_deref(), read_list_query) {
        Ok(q) => q,
        Err(refused) => return refused.respond("Failed to list calendar events"),
    };
    let result = async {
        let calendar_ids =
            access::resolve_requested(&caller.db, &caller.user_id, q.calendar_ids.as_deref()).await?;
        if calendar_ids.is_empty() {
            return Ok(page(Vec::new(), 0, false, None));
        }
        let non_empty = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
        let start_date = non_empty(&q.start_date).map(|d| date_param(&d)).transpose()?;
        let end_date = non_empty(&q.end_date).map(|d| date_param(&d)).transpose()?;
        let search = non_empty(&q.search).map(|s| {
            let mut term = String::from("%");
            for c in s.chars() {
                if matches!(c, '\\' | '%' | '_') {
                    term.push('\\');
                }
                term.push(c);
            }
            term.push('%');
            term
        });
        let cursor = match non_empty(&q.cursor) {
            Some(cursor) => cursor_of(&caller.db, "calendar_events", &cursor).await?,
            None => None,
        };
        let limit = limit_param(q.limit)?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(e) from calendar_events e
             where deleted_at is null and calendar_id = any($1)
               and ($2::text is null or type = $2)
               and ($3::text is null or status = $3)
               and ($4::timestamp is null or coalesce(end_time, start_time) >= $4::timestamp)
               and ($5::timestamp is null or start_time <= $5::timestamp)
               and ($6::text is null or title ilike $6 or description ilike $6 or location ilike $6)
               and ($7::timestamp is null or (created_at < $7::timestamp or (created_at = $7::timestamp and id < $8)))
             order by created_at desc, id desc
             limit $9",
        )
        .bind(&calendar_ids)
        .bind(non_empty(&q.kind))
        .bind(non_empty(&q.status))
        .bind(&start_date)
        .bind(&end_date)
        .bind(&search)
        .bind(cursor.as_ref().map(|(at, _)| at.clone()))
        .bind(cursor.as_ref().map(|(_, id)| id.clone()))
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from calendar_events
             where deleted_at is null and calendar_id = any($1)
               and ($2::text is null or type = $2)
               and ($3::text is null or status = $3)
               and ($4::timestamp is null or coalesce(end_time, start_time) >= $4::timestamp)
               and ($5::timestamp is null or start_time <= $5::timestamp)
               and ($6::text is null or title ilike $6 or description ilike $6 or location ilike $6)",
        )
        .bind(&calendar_ids)
        .bind(non_empty(&q.kind))
        .bind(non_empty(&q.status))
        .bind(&start_date)
        .bind(&end_date)
        .bind(&search)
        .fetch_one(&caller.db)
        .await?;
        let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
        let take = usize::try_from(limit).unwrap_or(0);
        let has_more = rows.len() > take;
        rows.truncate(take);
        let next = if has_more {
            rows.last().map(|row| text(row, "id").to_owned())
        } else {
            None
        };
        Ok::<_, Refusal>(page(rows, total, has_more, next))
    }
    .await;
    result.unwrap_or_else(|refused: Refusal| refused.respond("Failed to list calendar events"))
}

/// The keyset of the row after which the next page starts: its `createdAt`
/// (as JavaScript reads it, milliseconds) and id.
pub(crate) async fn cursor_of(
    db: &PgPool,
    table: &str,
    id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
    let created: Option<Value> = match table {
        "calendar_events" => {
            sqlx::query_scalar(
                "select to_jsonb(created_at) from calendar_events where id = $1 limit 1",
            )
            .bind(id)
            .fetch_optional(db)
            .await?
        }
        "calendar_bookings" => {
            sqlx::query_scalar(
                "select to_jsonb(created_at) from calendar_bookings where id = $1 limit 1",
            )
            .bind(id)
            .fetch_optional(db)
            .await?
        }
        _ => {
            sqlx::query_scalar(
                "select to_jsonb(created_at) from calendar_booking_pages where id = $1 limit 1",
            )
            .bind(id)
            .fetch_optional(db)
            .await?
        }
    };
    Ok(created
        .and_then(|value| value.as_str().and_then(weldsuite_db::js_timestamp))
        .map(|at| (at, id.to_owned())))
}

// ── GET /range ──────────────────────────────────────────────────────────────

pub(crate) async fn range(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (start, end, calendars) = match validate_query(query.as_deref(), read_range_query) {
        Ok(q) => q,
        Err(refused) => return refused.respond("Failed to fetch events"),
    };
    let result = async {
        let ids =
            access::resolve_requested(&caller.db, &caller.user_id, calendars.as_deref()).await?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let start = date_param(&start)?;
        let end = date_param(&end)?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(e) from calendar_events e
             where deleted_at is null and calendar_id = any($1)
               and coalesce(end_time, start_time) >= $2::timestamp
               and start_time <= $3::timestamp
             order by start_time asc",
        )
        .bind(&ids)
        .bind(&start)
        .bind(&end)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, Refusal>(rows.into_iter().map(js_row).collect::<Vec<_>>())
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(refused) => refused.respond("Failed to fetch events"),
    }
}

// ── GET /upcoming ───────────────────────────────────────────────────────────

pub(crate) async fn upcoming(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let (days, limit) = match validate_query(query.as_deref(), read_upcoming_query) {
        Ok(q) => q,
        Err(refused) => return refused.respond("Failed to fetch upcoming events"),
    };
    let result = async {
        let ids = access::accessible_calendar_ids(&caller.db, &caller.user_id).await?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let now = now_ms();
        // `endDate.setDate(endDate.getDate() + days)`: whole days.
        #[allow(clippy::cast_possible_truncation)]
        let end = now + (days.trunc() as i64) * DAY_MS;
        let limit = limit_param(limit)?;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(e) from calendar_events e
             where deleted_at is null and calendar_id = any($1)
               and start_time >= $2::timestamp and start_time <= $3::timestamp
               and status = 'confirmed'
             order by start_time asc
             limit $4",
        )
        .bind(&ids)
        .bind(iso(now))
        .bind(iso(end))
        .bind(limit)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, Refusal>(rows.into_iter().map(js_row).collect::<Vec<_>>())
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(refused) => refused.respond("Failed to fetch upcoming events"),
    }
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match visible_event(&caller, &id).await {
        Ok(row) => Data(row).into_response(),
        Err(refused) => refused.respond("Failed to fetch calendar event"),
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

fn text_field(field: &Field<String>) -> Option<&str> {
    field.as_set().map(String::as_str)
}

fn json_list<T>(field: &Field<Vec<T>>, to_value: impl Fn(&T) -> Value) -> Option<Value> {
    field
        .as_set()
        .map(|items| Value::Array(items.iter().map(to_value).collect()))
}

fn attendee_value(attendee: &AttendeeIn) -> Value {
    attendee.ordered().to_value()
}

fn attendees_for_mail(list: &[AttendeeIn]) -> Vec<Attendee> {
    list.iter()
        .map(|a| Attendee {
            email: Some(a.email.clone()),
            name: a.name.clone(),
        })
        .collect()
}

pub(crate) async fn create(
    State(state): State<CalendarState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        read_event(issues, fields, false)
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to create calendar event"),
    };
    create_event(&state, &caller, input)
        .await
        .unwrap_or_else(|refused| refused.respond("Failed to create calendar event"))
}

#[allow(clippy::too_many_lines)] // the route, step by step as TypeScript has it
async fn create_event(
    state: &CalendarState,
    caller: &Caller,
    input: EventInput,
) -> Outcome<Response> {
    let id = generate_id("evt");
    let now = now();
    let calendar_id = text_field(&input.calendar_id)
        .unwrap_or_default()
        .to_owned();
    let accessible = access::accessible_calendar_ids(&caller.db, &caller.user_id).await?;
    if !accessible.iter().any(|c| *c == calendar_id) {
        return Err(Refusal::forbidden());
    }
    let start_text = text_field(&input.start_time).unwrap_or_default().to_owned();
    let start = parse_date(&start_text);
    let end_text = text_field(&input.end_time).filter(|e| !e.is_empty());
    let end = end_text.map(parse_date);
    let all_day = input.all_day.as_set().copied().unwrap_or(false);
    if let Some(message) = time_range_error(start, end, all_day) {
        return Err(Refusal::bad_request(message));
    }
    let start_iso = start.map(iso);
    let end_iso = end.flatten().map(iso);
    let meeting_url = text_field(&input.meeting_url)
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let status = text_field(&input.status)
        .filter(|s| !s.is_empty())
        .unwrap_or("confirmed");
    let priority = text_field(&input.priority)
        .filter(|p| !p.is_empty())
        .unwrap_or("normal");
    sqlx::query(
        "insert into calendar_events
             (id, calendar_id, title, description, type, start_time, end_time, all_day, timezone,
              location, is_virtual, meeting_url, status, priority, color, recurrence_rule,
              recurrence_id, organizer_id, attendees, reminders, customer_id, contact_id, notes,
              tags, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp, coalesce($8, false), $9,
                 $10, coalesce($11, false), $12, $13, $14, $15, $16,
                 $17, $18, $19::jsonb, $20::jsonb, $21, $22, $23,
                 $24::jsonb, $25::timestamp, $25::timestamp)",
    )
    .bind(&id)
    .bind(&calendar_id)
    .bind(text_field(&input.title))
    .bind(text_field(&input.description))
    .bind(text_field(&input.kind))
    .bind(&start_iso)
    .bind(&end_iso)
    .bind(input.all_day.as_set().copied())
    .bind(text_field(&input.timezone))
    .bind(text_field(&input.location))
    .bind(input.is_virtual.as_set().copied())
    .bind(meeting_url)
    .bind(status)
    .bind(priority)
    .bind(text_field(&input.color))
    .bind(text_field(&input.recurrence_rule))
    .bind(text_field(&input.recurrence_id))
    .bind(&caller.user_id)
    .bind(json_list(&input.attendees, attendee_value))
    .bind(json_list(&input.reminders, Clone::clone))
    .bind(text_field(&input.customer_id))
    .bind(text_field(&input.contact_id))
    .bind(text_field(&input.notes))
    .bind(json_list(&input.tags, |t| Value::String(t.clone())))
    .bind(&now)
    .execute(&caller.db)
    .await?;

    caller.publish(
        state,
        CALENDAR_EVENT_CREATED,
        &id,
        &json!({
            "id": id,
            "title": text_field(&input.title),
            "calendarId": calendar_id,
            "startAt": start_text,
            "endAt": text_field(&input.end_time),
        }),
    );

    google::queue_push(
        state,
        caller,
        &id,
        PushAction::Created,
        with_id(&id, &input.data),
    );

    let weld_meeting = text_field(&input.weld_meeting_id).filter(|m| !m.is_empty());
    let linked = match weld_meeting {
        Some(meeting_id) => Some(link_meeting(state, caller, meeting_id, &id).await),
        None => None,
    };

    if let Field::Set(attendees) = &input.attendees
        && !attendees.is_empty()
    {
        let organizer = mail::organizer_info(&caller.db, &caller.user_id).await;
        let event = MailEvent {
            id: id.clone(),
            title: text_field(&input.title).unwrap_or_default().to_owned(),
            description: text_field(&input.description).map(str::to_owned),
            location: text_field(&input.location).map(str::to_owned),
            start_time: Some(start_text.clone()),
            end_time: text_field(&input.end_time).map(str::to_owned),
            meeting_url: text_field(&input.meeting_url).map(str::to_owned),
            timezone: text_field(&input.timezone).map(str::to_owned),
            all_day: input.all_day.as_set().copied(),
        };
        mail::queue(
            state,
            caller,
            options(
                MailKind::Invite,
                event,
                attendees_for_mail(attendees),
                organizer,
            ),
        );
    }

    let answer = match (weld_meeting, linked) {
        (Some(_), Some(linked)) => json!({ "id": id, "weldMeetingLinked": linked }),
        _ => json!({ "id": id }),
    };
    Ok(Created(answer).into_response())
}

/// `{ id, ...data }`, in that key order.
fn with_id(id: &str, data: &Ordered) -> Ordered {
    let mut out = Ordered::default();
    out.plain("id", Value::String(id.to_owned()));
    for (key, value) in &data.0 {
        out.push(key, value.clone());
    }
    out
}

/// Mail options with no sequence floor, old times or member lookups yet.
fn options(
    kind: MailKind,
    event: MailEvent,
    attendees: Vec<Attendee>,
    organizer: mail::OrganizerInfo,
) -> SendOptions {
    SendOptions {
        kind,
        event,
        attendees,
        organizer,
        sequence: None,
        old_start_time: None,
        old_end_time: None,
        member_emails: std::collections::HashMap::new(),
        workspace_language: None,
    }
}

// ── WeldMeet sync (best effort) ─────────────────────────────────────────────

/// Link a meeting to an event; whether it was linked (`linkMeeting`).
async fn link_meeting(
    state: &CalendarState,
    caller: &Caller,
    meeting_id: &str,
    event_id: &str,
) -> bool {
    match meetings::link(&caller.db, meeting_id, event_id, &caller.user_id).await {
        Ok(Some(linked)) => {
            meetings::publish_changes(state, caller, &[linked]);
            true
        }
        Ok(None) => {
            tracing::error!(
                "[calendar-api/calendar-events] weldMeetingId {meeting_id} not linked to {event_id}: meeting not found or not owned by caller"
            );
            false
        }
        Err(error) => {
            tracing::error!(%error, "[calendar-api/calendar-events] linking meeting failed");
            false
        }
    }
}

/// Re-read the event and bring its meetings in line (`syncLinkedMeetings`).
async fn sync_linked_meetings(state: &CalendarState, caller: &Caller, before: &Value) {
    let result = async {
        let after: Option<Value> =
            sqlx::query_scalar("select to_jsonb(e) from calendar_events e where id = $1 limit 1")
                .bind(text(before, "id"))
                .fetch_optional(&caller.db)
                .await?;
        let Some(after) = after.map(js_row) else {
            return Ok(Vec::new());
        };
        meetings::sync_from_event(&caller.db, before, &after).await
    }
    .await;
    match result {
        Ok(changes) => meetings::publish_changes(state, caller, &changes),
        Err(error) => tracing::error!(%error, "[calendar-api/calendar-events] meeting sync failed"),
    }
}

/// Cancel the meetings of a deleted or cancelled event (`cancelLinkedMeetings`).
async fn cancel_linked_meetings(state: &CalendarState, caller: &Caller, event_id: &str) {
    match meetings::cancel_for_event(&caller.db, event_id).await {
        Ok(changes) => meetings::publish_changes(state, caller, &changes),
        Err(error) => {
            tracing::error!(%error, "[calendar-api/calendar-events] meeting cancel failed")
        }
    }
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        read_event(issues, fields, true)
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to update calendar event"),
    };
    let send_notification =
        query_param(query.as_deref(), "sendNotification").as_deref() == Some("true");
    update_event(&state, &caller, &id, input, send_notification)
        .await
        .unwrap_or_else(|refused| refused.respond("Failed to update calendar event"))
}

/// `(set, value)` of a text column for `case when $set then $value else col end`.
fn change_text(field: &Field<String>) -> (bool, Option<String>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

fn change_json<T>(field: &Field<Vec<T>>, to_value: impl Fn(&T) -> Value) -> (bool, Option<Value>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(items) => (
            true,
            Some(Value::Array(items.iter().map(to_value).collect())),
        ),
    }
}

#[allow(clippy::too_many_lines)] // the route, step by step as TypeScript has it
async fn update_event(
    state: &CalendarState,
    caller: &Caller,
    id: &str,
    input: EventInput,
    send_notification: bool,
) -> Outcome<Response> {
    let existing = visible_event(caller, id).await?;
    let existing_calendar = text(&existing, "calendarId").to_owned();

    // Moving to another calendar needs write access to both.
    let moved_to = text_field(&input.calendar_id)
        .filter(|target| *target != existing_calendar)
        .map(str::to_owned);
    if let Some(target) = &moved_to {
        let source =
            access::calendar_access(&caller.db, &existing_calendar, &caller.user_id).await?;
        let target = access::calendar_access(&caller.db, target, &caller.user_id).await?;
        let can = |a: &Option<access::CalendarAccess>| {
            a.as_ref().is_some_and(access::CalendarAccess::can_write)
        };
        if !can(&source) || !can(&target) {
            return Err(Refusal::forbidden());
        }
    }

    if !input.start_time.is_absent() || !input.end_time.is_absent() {
        let start = match text_field(&input.start_time) {
            Some(start) => parse_date(start),
            None => millis_of(&existing["startTime"]),
        };
        let end = match text_field(&input.end_time) {
            Some(end) => Some(parse_date(end)),
            None => millis_of(&existing["endTime"]).map(Some),
        };
        let all_day = input
            .all_day
            .as_set()
            .copied()
            .or_else(|| existing["allDay"].as_bool())
            .unwrap_or(false);
        if let Some(message) = time_range_error(start, end, all_day) {
            return Err(Refusal::bad_request(message));
        }
    }

    let (set_calendar, calendar) = change_text(&input.calendar_id);
    let (set_title, title) = change_text(&input.title);
    let (set_description, description) = change_text(&input.description);
    let (set_type, kind) = change_text(&input.kind);
    let start = text_field(&input.start_time).and_then(parse_date).map(iso);
    let end = text_field(&input.end_time).and_then(parse_date).map(iso);
    let (set_timezone, timezone) = change_text(&input.timezone);
    let (set_location, location) = change_text(&input.location);
    let (set_url, meeting_url) = match &input.meeting_url {
        Field::Set(url) if url.is_empty() => (true, None),
        other => change_text(other),
    };
    let (set_status, status) = change_text(&input.status);
    let (set_priority, priority) = change_text(&input.priority);
    let (set_color, color) = change_text(&input.color);
    let (set_rule, rule) = change_text(&input.recurrence_rule);
    let (set_attendees, attendees) = change_json(&input.attendees, attendee_value);
    let (set_reminders, reminders) = change_json(&input.reminders, Clone::clone);
    let (set_customer, customer) = change_text(&input.customer_id);
    let (set_contact, contact) = change_text(&input.contact_id);
    let (set_notes, notes) = change_text(&input.notes);
    let (set_tags, tags) = change_json(&input.tags, |t| Value::String(t.clone()));
    sqlx::query(
        "update calendar_events set
             updated_at = $2::timestamp,
             calendar_id = case when $3 then $4 else calendar_id end,
             title = case when $5 then $6 else title end,
             description = case when $7 then $8 else description end,
             type = case when $9 then $10 else type end,
             start_time = case when $11 then $12::timestamp else start_time end,
             end_time = case when $13 then $14::timestamp else end_time end,
             all_day = case when $15 then $16 else all_day end,
             timezone = case when $17 then $18 else timezone end,
             location = case when $19 then $20 else location end,
             is_virtual = case when $21 then $22 else is_virtual end,
             meeting_url = case when $23 then $24 else meeting_url end,
             status = case when $25 then $26 else status end,
             priority = case when $27 then $28 else priority end,
             color = case when $29 then $30 else color end,
             recurrence_rule = case when $31 then $32 else recurrence_rule end,
             attendees = case when $33 then $34::jsonb else attendees end,
             reminders = case when $35 then $36::jsonb else reminders end,
             customer_id = case when $37 then $38 else customer_id end,
             contact_id = case when $39 then $40 else contact_id end,
             notes = case when $41 then $42 else notes end,
             tags = case when $43 then $44::jsonb else tags end
         where id = $1 and deleted_at is null",
    )
    .bind(id)
    .bind(now())
    .bind(set_calendar)
    .bind(&calendar)
    .bind(set_title)
    .bind(&title)
    .bind(set_description)
    .bind(&description)
    .bind(set_type)
    .bind(&kind)
    .bind(!input.start_time.is_absent())
    .bind(&start)
    .bind(!input.end_time.is_absent())
    .bind(&end)
    .bind(!input.all_day.is_absent())
    .bind(input.all_day.as_set().copied())
    .bind(set_timezone)
    .bind(&timezone)
    .bind(set_location)
    .bind(&location)
    .bind(!input.is_virtual.is_absent())
    .bind(input.is_virtual.as_set().copied())
    .bind(set_url)
    .bind(&meeting_url)
    .bind(set_status)
    .bind(&status)
    .bind(set_priority)
    .bind(&priority)
    .bind(set_color)
    .bind(&color)
    .bind(set_rule)
    .bind(&rule)
    .bind(set_attendees)
    .bind(&attendees)
    .bind(set_reminders)
    .bind(&reminders)
    .bind(set_customer)
    .bind(&customer)
    .bind(set_contact)
    .bind(&contact)
    .bind(set_notes)
    .bind(&notes)
    .bind(set_tags)
    .bind(&tags)
    .execute(&caller.db)
    .await?;

    let event = EntityEvent::new(
        CALENDAR_EVENT_UPDATED,
        id,
        json!({
            "id": id,
            "title": text_field(&input.title).map_or_else(|| existing["title"].clone(), |t| json!(t)),
            "calendarId": moved_to.clone().unwrap_or_else(|| existing_calendar.clone()),
            "startAt": text_field(&input.start_time).map_or_else(|| iso_or_null(&existing["startTime"]), |t| json!(t)),
            "endAt": text_field(&input.end_time).map_or_else(|| iso_or_null(&existing["endTime"]), |t| json!(t)),
        }),
    );
    let event = match &moved_to {
        Some(target) => {
            let mut changes = Map::new();
            changes.insert(
                "calendarId".to_owned(),
                json!({ "old": existing_calendar, "new": target }),
            );
            event.with_changes(changes)
        }
        None => event,
    };
    state.events.publish(&caller.events, event);

    google::queue_push(
        state,
        caller,
        id,
        PushAction::Updated,
        with_id(id, &input.data),
    );

    if send_notification {
        notify_attendees_of_update(state, caller, &existing, &input).await;
    }

    let weld_meeting = text_field(&input.weld_meeting_id).filter(|m| !m.is_empty());
    let linked = match weld_meeting {
        Some(meeting_id) => Some(link_meeting(state, caller, meeting_id, id).await),
        None => None,
    };
    sync_linked_meetings(state, caller, &existing).await;

    let mut answer = with_id(id, &input.data).to_value();
    if let (Some(_), Some(linked)) = (weld_meeting, linked) {
        answer["weldMeetingLinked"] = Value::Bool(linked);
    }
    Ok(Data(answer).into_response())
}

fn email_key(attendee: &Attendee) -> String {
    attendee
        .email
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

/// Mail the people an edit affects (`notifyAttendeesOfUpdate`).
async fn notify_attendees_of_update(
    state: &CalendarState,
    caller: &Caller,
    existing: &Value,
    input: &EventInput,
) {
    let organizer = mail::organizer_info(&caller.db, text(existing, "organizerId")).await;
    // The event as it reads after the edit (a null clears the field).
    let pick = |field: &Field<String>, key: &str| match field {
        Field::Set(value) => Some(value.clone()),
        Field::Null => None,
        Field::Absent => existing[key].as_str().map(str::to_owned),
    };
    let start = text_field(&input.start_time)
        .filter(|s| !s.is_empty())
        .and_then(parse_date)
        .or_else(|| millis_of(&existing["startTime"]));
    let end = text_field(&input.end_time)
        .filter(|s| !s.is_empty())
        .and_then(parse_date)
        .or_else(|| millis_of(&existing["endTime"]));
    let meeting_url = pick(&input.meeting_url, "meetingUrl")
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty());
    let mail_event = MailEvent {
        id: text(existing, "id").to_owned(),
        title: text_field(&input.title)
            .map_or_else(|| text(existing, "title").to_owned(), str::to_owned),
        description: pick(&input.description, "description"),
        location: pick(&input.location, "location"),
        start_time: start.map(iso),
        end_time: end.map(iso),
        meeting_url: meeting_url.clone(),
        timezone: pick(&input.timezone, "timezone"),
        all_day: input
            .all_day
            .as_set()
            .copied()
            .or_else(|| existing["allDay"].as_bool()),
    };

    let old_attendees = mail::attendees_of(&existing["attendees"]);
    let new_attendees = match &input.attendees {
        Field::Absent => old_attendees.clone(),
        Field::Null => Vec::new(),
        Field::Set(list) => attendees_for_mail(list),
    };
    let old_keys: std::collections::HashSet<String> = old_attendees
        .iter()
        .map(email_key)
        .filter(|k| !k.is_empty())
        .collect();
    let new_keys: std::collections::HashSet<String> = new_attendees
        .iter()
        .map(email_key)
        .filter(|k| !k.is_empty())
        .collect();
    let added: Vec<Attendee> = new_attendees
        .iter()
        .filter(|a| !email_key(a).is_empty() && !old_keys.contains(&email_key(a)))
        .cloned()
        .collect();
    let removed: Vec<Attendee> = old_attendees
        .iter()
        .filter(|a| !email_key(a).is_empty() && !new_keys.contains(&email_key(a)))
        .cloned()
        .collect();
    let retained: Vec<Attendee> = new_attendees
        .iter()
        .filter(|a| old_keys.contains(&email_key(a)))
        .cloned()
        .collect();

    let was_cancelled = existing["status"] == "cancelled";
    let is_cancelled = match text_field(&input.status) {
        Some(status) => status == "cancelled",
        None => was_cancelled,
    };
    let row_event = MailEvent::from_row(existing);
    if is_cancelled && !was_cancelled {
        mail::queue(
            state,
            caller,
            options(MailKind::Cancel, row_event, old_attendees, organizer),
        );
        return;
    }
    if was_cancelled && !is_cancelled {
        let mut restored = options(MailKind::Restored, mail_event, new_attendees, organizer);
        restored.sequence = Some(mail::next_ics_sequence());
        mail::queue(state, caller, restored);
        return;
    }
    let mut invite = options(
        MailKind::Invite,
        mail_event.clone(),
        added,
        organizer.clone(),
    );
    invite.sequence = Some(mail::next_ics_sequence());
    mail::queue(state, caller, invite);
    mail::queue(
        state,
        caller,
        options(MailKind::Removed, row_event, removed, organizer.clone()),
    );

    let existing_start = millis_of(&existing["startTime"]);
    let existing_end = millis_of(&existing["endTime"]);
    let moved = start != existing_start || end != existing_end;
    let existing_url = existing["meetingUrl"]
        .as_str()
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let link_changed = meeting_url.is_some() && meeting_url.as_deref() != existing_url;
    if moved || link_changed {
        let mut update = options(
            if moved {
                MailKind::Reschedule
            } else {
                MailKind::Update
            },
            mail_event,
            retained,
            organizer,
        );
        update.old_start_time = existing_start.map(iso);
        update.old_end_time = existing_end.map(iso);
        mail::queue(state, caller, update);
    }
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let send_notification =
        query_param(query.as_deref(), "sendNotification").as_deref() == Some("true");
    let result = async {
        let existing = visible_event(&caller, &id).await?;
        let now = now();
        sqlx::query(
            "update calendar_events set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            CALENDAR_EVENT_DELETED,
            &id,
            &json!({ "id": id, "title": existing["title"], "calendarId": existing["calendarId"] }),
        );
        let mut data = Ordered::default();
        data.plain("id", Value::String(id.clone()));
        google::queue_push(&state, &caller, &id, PushAction::Deleted, data);
        cancel_linked_meetings(&state, &caller, &id).await;
        let attendees = mail::attendees_of(&existing["attendees"]);
        if send_notification && !attendees.is_empty() {
            let organizer = mail::organizer_info(&caller.db, text(&existing, "organizerId")).await;
            mail::queue(
                &state,
                &caller,
                options(
                    MailKind::Cancel,
                    MailEvent::from_row(&existing),
                    attendees,
                    organizer,
                ),
            );
        }
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(refused) => refused.respond("Failed to delete calendar event"),
    }
}

// ── PATCH /:id/cancel ───────────────────────────────────────────────────────

pub(crate) async fn cancel(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let existing = visible_event(&caller, &id).await?;
        sqlx::query(
            "update calendar_events set status = 'cancelled', updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let mut changes = Map::new();
        changes.insert(
            "status".to_owned(),
            json!({ "old": existing["status"], "new": "cancelled" }),
        );
        state.events.publish(
            &caller.events,
            EntityEvent::new(
                CALENDAR_EVENT_UPDATED,
                id.clone(),
                json!({ "id": id, "title": existing["title"], "calendarId": existing["calendarId"] }),
            )
            .with_changes(changes),
        );
        let mut data = Ordered::default();
        data.plain("id", Value::String(id.clone()));
        data.plain("status", json!("cancelled"));
        google::queue_push(&state, &caller, &id, PushAction::Updated, data);
        cancel_linked_meetings(&state, &caller, &id).await;
        let attendees = mail::attendees_of(&existing["attendees"]);
        if !attendees.is_empty() {
            let organizer = mail::organizer_info(&caller.db, text(&existing, "organizerId")).await;
            mail::queue(
                &state,
                &caller,
                options(MailKind::Cancel, MailEvent::from_row(&existing), attendees, organizer),
            );
        }
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => Data(json!({ "id": id, "status": "cancelled" })).into_response(),
        Err(refused) => refused.respond("Failed to cancel calendar event"),
    }
}

// ── PATCH /:id/reschedule ───────────────────────────────────────────────────

pub(crate) async fn reschedule(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_reschedule) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to reschedule calendar event"),
    };
    let result = async {
        let existing = visible_event(&caller, &id).await?;
        let new_start = parse_date(&input.start_time);
        let new_end = input
            .end_time
            .as_deref()
            .filter(|e| !e.is_empty())
            .map(parse_date);
        let end_for_check = match new_end {
            Some(end) => Some(end),
            None => millis_of(&existing["endTime"]).map(Some),
        };
        let all_day = existing["allDay"].as_bool().unwrap_or(false);
        if let Some(message) = time_range_error(new_start, end_for_check, all_day) {
            return Err(Refusal::bad_request(message));
        }
        let start_iso = new_start.map(iso);
        let end_iso = new_end.flatten().map(iso);
        sqlx::query(
            "update calendar_events set
                 start_time = $2::timestamp,
                 updated_at = $3::timestamp,
                 end_time = case when $4 then $5::timestamp else end_time end
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&start_iso)
        .bind(now())
        .bind(end_iso.is_some())
        .bind(&end_iso)
        .execute(&caller.db)
        .await?;
        if input.manual {
            pin_rescheduled_source(&caller.db, &existing, new_start.unwrap_or_default(), new_end.flatten())
                .await?;
        }
        caller.publish(
            &state,
            CALENDAR_EVENT_UPDATED,
            &id,
            &json!({
                "id": id,
                "title": existing["title"],
                "calendarId": existing["calendarId"],
                "startAt": input.start_time,
                "endAt": input.end_time.as_ref().map_or_else(|| iso_or_null(&existing["endTime"]), |e| json!(e)),
            }),
        );
        google::queue_push(&state, &caller, &id, PushAction::Updated, with_id(&id, &input.data));
        sync_linked_meetings(&state, &caller, &existing).await;
        let attendees = mail::attendees_of(&existing["attendees"]);
        if input.notify_attendees && !attendees.is_empty() {
            let organizer = mail::organizer_info(&caller.db, text(&existing, "organizerId")).await;
            let mut event = MailEvent::from_row(&existing);
            event.start_time = Some(input.start_time.clone());
            event.end_time = input
                .end_time
                .clone()
                .or_else(|| millis_of(&existing["endTime"]).map(iso));
            let mut reschedule = options(MailKind::Reschedule, event, attendees, organizer);
            reschedule.old_start_time = millis_of(&existing["startTime"]).map(iso);
            reschedule.old_end_time = millis_of(&existing["endTime"]).map(iso);
            mail::queue(&state, &caller, reschedule);
        }
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => Data(with_id(&id, &input.data).to_value()).into_response(),
        Err(refused) => refused.respond("Failed to reschedule calendar event"),
    }
}

/// Write a hand-picked slot back to the task or activity behind the event and
/// pin the event (`pinRescheduledSource`).
async fn pin_rescheduled_source(
    db: &PgPool,
    event: &Value,
    start: i64,
    end: Option<i64>,
) -> Result<(), sqlx::Error> {
    let Some(source_id) = event["sourceId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let now = now();
    match event["sourceType"].as_str() {
        Some("task") => {
            sqlx::query(
                "update tasks set start_date = $2::timestamp, updated_at = $3::timestamp where id = $1",
            )
            .bind(source_id)
            .bind(iso(start))
            .bind(&now)
            .execute(db)
            .await?;
        }
        Some("activity") => {
            // Activities need a concrete end; 30 minutes like legacy.
            let end = end.unwrap_or(start + 30 * 60_000);
            sqlx::query(
                "update crm_activities set start_time = $2::timestamp, end_time = $3::timestamp,
                     updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(source_id)
            .bind(iso(start))
            .bind(iso(end))
            .bind(&now)
            .execute(db)
            .await?;
        }
        _ => {}
    }
    if event["autoScheduled"] == true {
        sqlx::query(
            "update calendar_events set auto_scheduled = false, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(text(event, "id"))
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(())
}

// ── POST /:id/unpin ─────────────────────────────────────────────────────────

pub(crate) async fn unpin(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result =
        async {
            let existing = visible_event(&caller, &id).await?;
            unpin_event(&caller.db, &existing).await?;
            // Back under the auto-scheduler: point the nightly re-plan at it.
            if let Some(master) = caller.master(&state) {
                let db = caller.db.clone();
                weldsuite_db::due_index::sync_due(
                    &master,
                    weldsuite_calendar_domain::REPLAN_KIND,
                    &caller.workspace_id,
                    || async move {
                        weldsuite_calendar_domain::next_auto_scheduled_replan_at(&db).await
                    },
                )
                .await;
            }
            Ok::<_, Refusal>(())
        }
        .await;
    match result {
        Ok(()) => Data(json!({ "id": id, "autoScheduled": true })).into_response(),
        Err(refused) => refused.respond("Failed to unpin calendar event"),
    }
}

/// Hand an event back to the auto-scheduler (`unpinEvent`).
async fn unpin_event(db: &PgPool, event: &Value) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update calendar_events set auto_scheduled = true, updated_at = $2::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(text(event, "id"))
    .bind(now())
    .execute(db)
    .await?;
    let Some(source_id) = event["sourceId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    match event["sourceType"].as_str() {
        Some("task") => {
            sqlx::query(
                "update tasks set start_date = null, updated_at = $2::timestamp where id = $1",
            )
            .bind(source_id)
            .bind(now())
            .execute(db)
            .await?;
            let due: Option<Option<Value>> =
                sqlx::query_scalar("select to_jsonb(due_date) from tasks where id = $1 limit 1")
                    .bind(source_id)
                    .fetch_optional(db)
                    .await?;
            let due = due
                .flatten()
                .and_then(|value| value.as_str().and_then(weldsuite_db::js_timestamp));
            weldsuite_calendar_domain::update_calendar_event_for_task(
                db,
                &weldsuite_calendar_domain::EventUpdate {
                    calendar_event_id: text(event, "id").to_owned(),
                    due_date: due.map(Some),
                    ..Default::default()
                },
            )
            .await?;
        }
        Some("activity") => {
            sqlx::query(
                "update crm_activities set start_time = null, end_time = null,
                     updated_at = $2::timestamp
                 where id = $1",
            )
            .bind(source_id)
            .bind(now())
            .execute(db)
            .await?;
        }
        _ => {}
    }
    Ok(())
}
