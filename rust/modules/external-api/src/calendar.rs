//! The calendar's objects: `/v1/calendars` and `/v1/calendar-events`
//! (`routes/v1/<object>/index.ts`).

use axum::Router;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CALENDAR_CREATED, CALENDAR_DELETED, CALENDAR_EVENT_CREATED, CALENDAR_EVENT_DELETED,
    CALENDAR_EVENT_UPDATED, CALENDAR_UPDATED,
};

use crate::ExternalApiState;
use crate::crud::{Caller, Fail, table_list_sql};
use crate::schemas::{LIST_CALENDAR_EVENTS, LIST_CALENDARS};
use crate::schemas_gen::{
    CREATE_CALENDAR, CREATE_CALENDAR_EVENT, UPDATE_CALENDAR, UPDATE_CALENDAR_EVENT,
};
use crate::simple::{self, Dates, F, Simple, Stats};
use crate::tables_gen::{CALENDAR_EVENTS, CALENDARS};

/// The calendar's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    [&CALENDAR_GROUP, &EVENTS]
        .into_iter()
        .fold(router, simple::mount)
}

/// A calendar belongs to the caller unless it names an owner.
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn calendar_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    if create && matches!(values.get("ownerId"), Some(Value::Null) | None) {
        values.insert("ownerId".into(), json!(caller.session.actor()));
    }
    Ok(&[])
}

static CALENDAR_GROUP: Simple = Simple {
    path: "/calendars",
    scope: "calendars",
    table: &CALENDARS,
    label: "Calendar",
    prefix: "cal",
    list: &LIST_CALENDARS,
    create: &CREATE_CALENDAR,
    update: &UPDATE_CALENDAR,
    sql: table_list_sql!(
        calendars,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.name like $3->>'search') \
         and ($3->>'ownerId' is null or t.owner_id = $3->>'ownerId')"
    ),
    filters: &[F::Like("search"), F::Eq("ownerId")],
    dates: &[],
    events: Some([CALENDAR_CREATED, CALENDAR_UPDATED, CALENDAR_DELETED]),
    data: &["name"],
    deleted_data: None,
    prepare: Some(calendar_values),
    stats: Stats::None,
    touch: true,
};

/// `coerceDates`: the schema's `startsAt` / `endsAt` are the `startTime` /
/// `endTime` columns (written as `Date`s by the engine); a create is
/// organised by the caller and is an `event` unless it says otherwise.
#[allow(clippy::unnecessary_wraps)] // a `simple::Prepare` hook
fn event_values(
    caller: &Caller,
    values: &mut Map<String, Value>,
    create: bool,
) -> Result<Dates, Fail> {
    for (from, to) in [("startsAt", "startTime"), ("endsAt", "endTime")] {
        if let Some(Value::String(text)) = values.get(from).cloned() {
            values.remove(from);
            values.insert(to.into(), json!(text));
        }
    }
    if create {
        if matches!(values.get("organizerId"), Some(Value::Null) | None) {
            values.insert("organizerId".into(), json!(caller.session.actor()));
        }
        if matches!(values.get("type"), Some(Value::Null) | None) {
            values.insert("type".into(), json!("event"));
        }
    }
    Ok(&[])
}

static EVENTS: Simple = Simple {
    path: "/calendar-events",
    scope: "calendar_events",
    table: &CALENDAR_EVENTS,
    label: "CalendarEvent",
    prefix: "evt",
    list: &LIST_CALENDAR_EVENTS,
    create: &CREATE_CALENDAR_EVENT,
    update: &UPDATE_CALENDAR_EVENT,
    sql: table_list_sql!(
        calendar_events,
        "t.deleted_at is null \
         and ($3->>'search' is null or t.title like $3->>'search') \
         and ($3->>'calendarId' is null or t.calendar_id = $3->>'calendarId')"
    ),
    filters: &[F::Like("search"), F::Eq("calendarId")],
    dates: &["startTime", "endTime"],
    events: Some([
        CALENDAR_EVENT_CREATED,
        CALENDAR_EVENT_UPDATED,
        CALENDAR_EVENT_DELETED,
    ]),
    data: &["title", "calendarId"],
    deleted_data: None,
    prepare: Some(event_values),
    stats: Stats::None,
    touch: true,
};
