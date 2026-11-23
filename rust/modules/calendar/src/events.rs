//! `/api/calendar-events` (`routes/calendar-events/index.ts`): events of the
//! calendars the caller can see, with the linked WeldMeet meetings kept in
//! step, attendee mail, and a push to the workspace's Google calendars after
//! every change.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    CALENDAR_EVENT_CREATED, CALENDAR_EVENT_DELETED, CALENDAR_EVENT_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_events::EntityEvent;
use weldsuite_kit::validation::Field;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{
    calendar_booking_pages, calendar_bookings, calendar_events as events, crm_activities, tasks,
};

use crate::access;
use crate::access::row_json;
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

/// `new Date(millis)` as a `timestamp` column takes it (`toISOString()`
/// bound as text and cast with `::timestamp`).
pub(crate) fn timestamp_at(millis: i64) -> PrimitiveDateTime {
    utc_timestamp(
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
    )
}

/// A `timestamp` column's value as JavaScript reads it: milliseconds (UTC).
pub(crate) fn millis_at(at: PrimitiveDateTime) -> i64 {
    i64::try_from(at.assume_utc().unix_timestamp_nanos().div_euclid(1_000_000)).unwrap_or(0)
}

/// A live event by id.
async fn event_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    events::Entity::find()
        .filter(events::Column::Id.eq(id))
        .filter(events::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
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
#[allow(clippy::option_option)] // no end, an end, an end that is an Invalid Date
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
fn date_param(text: &str) -> Outcome<PrimitiveDateTime> {
    parse_date(text)
        .map(timestamp_at)
        .ok_or_else(|| Refusal::Internal(format!("invalid date: {text}")))
}

/// A value for a `NOT NULL` column: `Err` (500) when there is none, which
/// Postgres refuses (a not-null violation).
fn not_null<T>(value: Option<T>, column: &str) -> Outcome<T> {
    value.ok_or_else(|| {
        Refusal::Internal(format!(
            "null value in column \"{column}\" of relation \"calendar_events\""
        ))
    })
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
        let filters = ListFilters {
            calendar_ids: &calendar_ids,
            kind: non_empty(&q.kind),
            status: non_empty(&q.status),
            start: start_date,
            end: end_date,
            search,
        };
        let db = orm(&caller.db);
        let mut rows = filters.select();
        if let Some((at, id)) = &cursor {
            rows = rows.filter(
                Condition::any().add(events::Column::CreatedAt.lt(*at)).add(
                    Condition::all()
                        .add(events::Column::CreatedAt.eq(*at))
                        .add(events::Column::Id.lt(id.as_str())),
                ),
            );
        }
        let rows = rows
            .order_by_desc(events::Column::CreatedAt)
            .order_by_desc(events::Column::Id)
            .limit(u64::try_from(limit + 1).unwrap_or(0))
            .all(&db)
            .await?;
        let total = filters.select().count(&db).await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let mut rows = rows
            .into_iter()
            .map(row_json)
            .collect::<Result<Vec<_>, _>>()?;
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

/// The list's filters (`conditions`, the keyset aside): the rows and their
/// count share them.
struct ListFilters<'a> {
    calendar_ids: &'a [String],
    kind: Option<String>,
    status: Option<String>,
    start: Option<PrimitiveDateTime>,
    end: Option<PrimitiveDateTime>,
    /// An `ilike` pattern, its wildcards escaped.
    search: Option<String>,
}

impl ListFilters<'_> {
    fn select(&self) -> Select<events::Entity> {
        let mut select = events::Entity::find()
            .filter(events::Column::DeletedAt.is_null())
            .filter(events::Column::CalendarId.is_in(self.calendar_ids.iter().cloned()));
        if let Some(kind) = &self.kind {
            select = select.filter(events::Column::Type.eq(kind.as_str()));
        }
        if let Some(status) = &self.status {
            select = select.filter(events::Column::Status.eq(status.as_str()));
        }
        if let Some(start) = self.start {
            select = select.filter(sea_orm::ExprTrait::gte(ends_at(), start));
        }
        if let Some(end) = self.end {
            select = select.filter(events::Column::StartTime.lte(end));
        }
        if let Some(search) = &self.search {
            select = select.filter(
                Condition::any()
                    .add(events::Column::Title.ilike(search.as_str()))
                    .add(events::Column::Description.ilike(search.as_str()))
                    .add(events::Column::Location.ilike(search.as_str())),
            );
        }
        select
    }
}

/// `coalesce(end_time, start_time)`: when the event is over.
fn ends_at() -> Expr {
    Expr::expr(Func::coalesce([
        Expr::col(events::Column::EndTime),
        Expr::col(events::Column::StartTime),
    ]))
}

/// The keyset of the row after which the next page starts: its `createdAt`
/// (as JavaScript reads it, to the millisecond) and id.
pub(crate) async fn cursor_of(
    db: &PgPool,
    table: &str,
    id: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let db = orm(db);
    let created: Option<PrimitiveDateTime> = match table {
        "calendar_events" => {
            events::Entity::find()
                .select_only()
                .column(events::Column::CreatedAt)
                .filter(events::Column::Id.eq(id))
                .into_tuple()
                .one(&db)
                .await?
        }
        "calendar_bookings" => {
            calendar_bookings::Entity::find()
                .select_only()
                .column(calendar_bookings::Column::CreatedAt)
                .filter(calendar_bookings::Column::Id.eq(id))
                .into_tuple()
                .one(&db)
                .await?
        }
        _ => {
            calendar_booking_pages::Entity::find()
                .select_only()
                .column(calendar_booking_pages::Column::CreatedAt)
                .filter(calendar_booking_pages::Column::Id.eq(id))
                .into_tuple()
                .one(&db)
                .await?
        }
    };
    Ok(created.map(|at| (utc_timestamp(at.assume_utc()), id.to_owned())))
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
        let rows = events::Entity::find()
            .filter(events::Column::DeletedAt.is_null())
            .filter(events::Column::CalendarId.is_in(ids))
            .filter(sea_orm::ExprTrait::gte(ends_at(), start))
            .filter(events::Column::StartTime.lte(end))
            .order_by_asc(events::Column::StartTime)
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, Refusal>(
            rows.into_iter()
                .map(row_json)
                .collect::<Result<Vec<_>, _>>()?,
        )
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
        let rows = events::Entity::find()
            .filter(events::Column::DeletedAt.is_null())
            .filter(events::Column::CalendarId.is_in(ids))
            .filter(events::Column::StartTime.gte(timestamp_at(now)))
            .filter(events::Column::StartTime.lte(timestamp_at(end)))
            .filter(events::Column::Status.eq("confirmed"))
            .order_by_asc(events::Column::StartTime)
            .limit(u64::try_from(limit).unwrap_or(0))
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, Refusal>(
            rows.into_iter()
                .map(row_json)
                .collect::<Result<Vec<_>, _>>()?,
        )
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
    if !accessible.contains(&calendar_id) {
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
    let meeting_url = text_field(&input.meeting_url)
        .map(str::trim)
        .filter(|u| !u.is_empty());
    let status = text_field(&input.status)
        .filter(|s| !s.is_empty())
        .unwrap_or("confirmed");
    let priority = text_field(&input.priority)
        .filter(|p| !p.is_empty())
        .unwrap_or("normal");
    let owned = |field: &Field<String>| text_field(field).map(str::to_owned);
    events::Entity::insert(events::ActiveModel {
        id: Set(id.clone()),
        calendar_id: Set(calendar_id.clone()),
        title: Set(not_null(owned(&input.title), "title")?),
        description: Set(owned(&input.description)),
        type_: Set(not_null(owned(&input.kind), "type")?),
        start_time: Set(not_null(start.map(timestamp_at), "start_time")?),
        end_time: Set(end.flatten().map(timestamp_at)),
        all_day: Set(Some(input.all_day.as_set().copied().unwrap_or(false))),
        timezone: Set(owned(&input.timezone)),
        location: Set(owned(&input.location)),
        is_virtual: Set(Some(input.is_virtual.as_set().copied().unwrap_or(false))),
        meeting_url: Set(meeting_url.map(str::to_owned)),
        status: Set(status.to_owned()),
        priority: Set(Some(priority.to_owned())),
        color: Set(owned(&input.color)),
        recurrence_rule: Set(owned(&input.recurrence_rule)),
        recurrence_id: Set(owned(&input.recurrence_id)),
        organizer_id: Set(caller.user_id.clone()),
        attendees: Set(json_list(&input.attendees, attendee_value)),
        reminders: Set(json_list(&input.reminders, Clone::clone)),
        customer_id: Set(owned(&input.customer_id)),
        contact_id: Set(owned(&input.contact_id)),
        notes: Set(owned(&input.notes)),
        tags: Set(json_list(&input.tags, |t| Value::String(t.clone()))),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
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
        let after = events::Entity::find()
            .filter(events::Column::Id.eq(text(before, "id")))
            .one(&orm(&caller.db))
            .await?;
        let Some(after) = after.map(row_json).transpose()? else {
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
            tracing::error!(%error, "[calendar-api/calendar-events] meeting cancel failed");
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

/// The value a sent text field writes (`null` clears it); `None` when the
/// body left it out.
fn change_text(field: &Field<String>) -> Option<Option<String>> {
    match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(value) => Some(Some(value.clone())),
    }
}

fn change_json<T>(
    field: &Field<Vec<T>>,
    to_value: impl Fn(&T) -> Value,
) -> Option<Option<Value>> {
    match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(items) => Some(Some(Value::Array(items.iter().map(to_value).collect()))),
    }
}

/// `update(calendarEvents).set({ ...data, updatedAt })`: the columns the body
/// sent, a `null` clearing one.
async fn write_event(db: &PgPool, id: &str, input: &EventInput) -> Result<(), DbErr> {
    use events::Column as E;
    let text = |field: &Field<String>| change_text(field).map(Expr::value);
    let instant = |field: &Field<String>| {
        (!field.is_absent())
            .then(|| Expr::value(text_field(field).and_then(parse_date).map(timestamp_at)))
    };
    let flag = |field: &Field<bool>| (!field.is_absent()).then(|| Expr::value(field.as_set().copied()));
    let meeting_url = match &input.meeting_url {
        Field::Set(url) if url.is_empty() => Some(Expr::value(Option::<String>::None)),
        other => text(other),
    };
    let sets = [
        (E::CalendarId, text(&input.calendar_id)),
        (E::Title, text(&input.title)),
        (E::Description, text(&input.description)),
        (E::Type, text(&input.kind)),
        (E::StartTime, instant(&input.start_time)),
        (E::EndTime, instant(&input.end_time)),
        (E::AllDay, flag(&input.all_day)),
        (E::Timezone, text(&input.timezone)),
        (E::Location, text(&input.location)),
        (E::IsVirtual, flag(&input.is_virtual)),
        (E::MeetingUrl, meeting_url),
        (E::Status, text(&input.status)),
        (E::Priority, text(&input.priority)),
        (E::Color, text(&input.color)),
        (E::RecurrenceRule, text(&input.recurrence_rule)),
        (
            E::Attendees,
            change_json(&input.attendees, attendee_value).map(Expr::value),
        ),
        (
            E::Reminders,
            change_json(&input.reminders, Clone::clone).map(Expr::value),
        ),
        (E::CustomerId, text(&input.customer_id)),
        (E::ContactId, text(&input.contact_id)),
        (E::Notes, text(&input.notes)),
        (
            E::Tags,
            change_json(&input.tags, |t| Value::String(t.clone())).map(Expr::value),
        ),
    ];
    let mut update = events::Entity::update_many().col_expr(E::UpdatedAt, Expr::value(now()));
    for (column, value) in sets {
        if let Some(value) = value {
            update = update.col_expr(column, value);
        }
    }
    update
        .filter(E::Id.eq(id))
        .filter(E::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
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

    write_event(&caller.db, id, &input).await?;

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
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
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
        events::Entity::update_many()
            .col_expr(events::Column::DeletedAt, Expr::value(now))
            .col_expr(events::Column::UpdatedAt, Expr::value(now))
            .filter(events::Column::Id.eq(id.as_str()))
            .filter(events::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
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
        events::Entity::update_many()
            .col_expr(events::Column::Status, Expr::value("cancelled"))
            .col_expr(events::Column::UpdatedAt, Expr::value(now()))
            .filter(events::Column::Id.eq(id.as_str()))
            .filter(events::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
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
        let mut update = events::Entity::update_many()
            .col_expr(
                events::Column::StartTime,
                Expr::value(new_start.map(timestamp_at)),
            )
            .col_expr(events::Column::UpdatedAt, Expr::value(now()));
        if let Some(end) = new_end.flatten() {
            update = update.col_expr(events::Column::EndTime, Expr::value(timestamp_at(end)));
        }
        update
            .filter(events::Column::Id.eq(id.as_str()))
            .filter(events::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
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
) -> Result<(), DbErr> {
    let Some(source_id) = event["sourceId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let now = now();
    let db = orm(db);
    match event["sourceType"].as_str() {
        Some("task") => {
            tasks::Entity::update_many()
                .col_expr(tasks::Column::StartDate, Expr::value(timestamp_at(start)))
                .col_expr(tasks::Column::UpdatedAt, Expr::value(now))
                .filter(tasks::Column::Id.eq(source_id))
                .exec(&db)
                .await?;
        }
        Some("activity") => {
            // Activities need a concrete end; 30 minutes like legacy.
            let end = end.unwrap_or(start + 30 * 60_000);
            crm_activities::Entity::update_many()
                .col_expr(
                    crm_activities::Column::StartTime,
                    Expr::value(timestamp_at(start)),
                )
                .col_expr(
                    crm_activities::Column::EndTime,
                    Expr::value(timestamp_at(end)),
                )
                .col_expr(crm_activities::Column::UpdatedAt, Expr::value(now))
                .filter(crm_activities::Column::Id.eq(source_id))
                .exec(&db)
                .await?;
        }
        _ => {}
    }
    if event["autoScheduled"] == true {
        events::Entity::update_many()
            .col_expr(events::Column::AutoScheduled, Expr::value(false))
            .col_expr(events::Column::UpdatedAt, Expr::value(now))
            .filter(events::Column::Id.eq(text(event, "id")))
            .filter(events::Column::DeletedAt.is_null())
            .exec(&db)
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
    let result = async {
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
async fn unpin_event(db: &PgPool, event: &Value) -> Outcome<()> {
    let orm_db = orm(db);
    events::Entity::update_many()
        .col_expr(events::Column::AutoScheduled, Expr::value(true))
        .col_expr(events::Column::UpdatedAt, Expr::value(now()))
        .filter(events::Column::Id.eq(text(event, "id")))
        .filter(events::Column::DeletedAt.is_null())
        .exec(&orm_db)
        .await?;
    let Some(source_id) = event["sourceId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    let no_stamp = || Expr::value(Option::<PrimitiveDateTime>::None);
    match event["sourceType"].as_str() {
        Some("task") => {
            tasks::Entity::update_many()
                .col_expr(tasks::Column::StartDate, no_stamp())
                .col_expr(tasks::Column::UpdatedAt, Expr::value(now()))
                .filter(tasks::Column::Id.eq(source_id))
                .exec(&orm_db)
                .await?;
            let due: Option<Option<PrimitiveDateTime>> = tasks::Entity::find()
                .select_only()
                .column(tasks::Column::DueDate)
                .filter(tasks::Column::Id.eq(source_id))
                .into_tuple()
                .one(&orm_db)
                .await?;
            weldsuite_calendar_domain::update_calendar_event_for_task(
                db,
                &weldsuite_calendar_domain::EventUpdate {
                    calendar_event_id: text(event, "id").to_owned(),
                    #[allow(clippy::cast_precision_loss)]
                    due_date: due.flatten().map(|at| Some(millis_at(at) as f64)),
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| match error {
                weldsuite_calendar_domain::SyncError::Database(error) => Refusal::from(error),
                weldsuite_calendar_domain::SyncError::Invalid(message) => {
                    Refusal::Internal(message)
                }
            })?;
        }
        Some("activity") => {
            crm_activities::Entity::update_many()
                .col_expr(crm_activities::Column::StartTime, no_stamp())
                .col_expr(crm_activities::Column::EndTime, no_stamp())
                .col_expr(crm_activities::Column::UpdatedAt, Expr::value(now()))
                .filter(crm_activities::Column::Id.eq(source_id))
                .exec(&orm_db)
                .await?;
        }
        _ => {}
    }
    Ok(())
}
