//! The bodies and queries of `/api/calendar-events`, read as their Zod
//! schemas read them (`createSchema`, `updateSchema`, `rescheduleSchema`,
//! the list, range and upcoming queries).

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};

use crate::js::{Ordered, OrderedValue, is_valid_time_zone};

const TYPES: [&str; 6] = [
    "meeting",
    "call",
    "appointment",
    "event",
    "reminder",
    "other",
];
const STATUSES: [&str; 3] = ["confirmed", "tentative", "cancelled"];
const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];
const REMINDER_TYPES: [&str; 2] = ["email", "notification"];

/// Every attendee is mailed an invitation, so an event has at most this many.
const MAX_ATTENDEES: usize = 100;

/// One attendee after `attendeeSchema`: unknown keys stripped, `null` text
/// read as absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttendeeIn {
    pub(crate) email: String,
    pub(crate) name: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) role: Option<String>,
}

impl AttendeeIn {
    /// The attendee as Zod outputs it, in its key order.
    pub(crate) fn ordered(&self) -> Ordered {
        let mut out = Ordered::default();
        out.plain("email", Value::String(self.email.clone()));
        for (key, value) in [
            ("name", &self.name),
            ("status", &self.status),
            ("role", &self.role),
        ] {
            if let Some(value) = value {
                out.plain(key, Value::String(value.clone()));
            }
        }
        out
    }
}

/// A body of `POST /` or `PATCH /:id`, as Zod parsed it.
#[derive(Debug, Default)]
pub(crate) struct EventInput {
    pub(crate) calendar_id: Field<String>,
    pub(crate) title: Field<String>,
    pub(crate) description: Field<String>,
    pub(crate) kind: Field<String>,
    pub(crate) start_time: Field<String>,
    pub(crate) end_time: Field<String>,
    pub(crate) all_day: Field<bool>,
    pub(crate) timezone: Field<String>,
    pub(crate) location: Field<String>,
    pub(crate) is_virtual: Field<bool>,
    pub(crate) meeting_url: Field<String>,
    pub(crate) status: Field<String>,
    pub(crate) priority: Field<String>,
    pub(crate) color: Field<String>,
    pub(crate) recurrence_rule: Field<String>,
    pub(crate) recurrence_id: Field<String>,
    pub(crate) attendees: Field<Vec<AttendeeIn>>,
    pub(crate) reminders: Field<Vec<Value>>,
    pub(crate) customer_id: Field<String>,
    pub(crate) contact_id: Field<String>,
    pub(crate) notes: Field<String>,
    pub(crate) tags: Field<Vec<String>>,
    pub(crate) weld_meeting_id: Field<String>,
    /// The parsed body without `weldMeetingId`, in the schema's key order
    /// (`{ id, ...data }` answers and Google pushes).
    pub(crate) data: Ordered,
}

/// `optionalText`: a string, `null` read as absent.
fn optional_text(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text(fields, key, Presence::Nullish, None, None)
        .into_option()
}

/// `attendeeSchema`.
fn attendee(issues: &mut Issues, item: &Value) -> Option<AttendeeIn> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let email = issues
        .text_with(
            fields,
            "email",
            Presence::Required,
            Text {
                trim: true,
                format: Some(Format::Email),
                ..Text::default()
            },
        )
        .into_option();
    let name = optional_text(issues, fields, "name");
    let status = optional_text(issues, fields, "status");
    let role = optional_text(issues, fields, "role");
    if issues.count() > before {
        return None;
    }
    Some(AttendeeIn {
        email: email?,
        name,
        status,
        role,
    })
}

/// `attendeesSchema`: at most 100 as sent, then one per email
/// (case-insensitive).
fn attendees(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Field<Vec<AttendeeIn>> {
    let from = issues.count();
    let list = issues.list(
        fields,
        "attendees",
        presence,
        None,
        Some(MAX_ATTENDEES),
        attendee,
    );
    issues.custom_message(
        from,
        "too_big",
        &format!("An event can have at most {MAX_ATTENDEES} attendees"),
    );
    match list {
        Field::Set(list) => {
            let mut seen = std::collections::HashSet::new();
            Field::Set(
                list.into_iter()
                    .filter(|a| seen.insert(a.email.to_lowercase()))
                    .collect(),
            )
        }
        other => other,
    }
}

/// `{ type, minutes }` of a reminder.
fn reminder(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let kind = issues
        .choice(fields, "type", Presence::Required, &REMINDER_TYPES)
        .into_option();
    let minutes = issues
        .number(fields, "minutes", Presence::Required, Number::default())
        .into_option();
    if issues.count() > before {
        return None;
    }
    let mut out = Map::new();
    out.insert("type".to_owned(), Value::String(kind?));
    out.insert(
        "minutes".to_owned(),
        crate::js::js_number(&serde_json::Number::from_f64(minutes?)?),
    );
    Some(Value::Object(out))
}

/// `true` for an absolute http(s) URL (`isHttpUrl`).
pub(crate) fn is_http_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

/// The body of `POST /` (`update` false) or `PATCH /:id` (`update` true).
#[allow(clippy::too_many_lines)] // one statement per schema field, in order
pub(crate) fn read_event(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    update: bool,
) -> EventInput {
    let required = if update {
        Presence::Optional
    } else {
        Presence::Required
    };
    // The update schema accepts null on these to clear them.
    let clearable = if update {
        Presence::Nullish
    } else {
        Presence::Optional
    };
    let mut input = EventInput {
        calendar_id: issues.text(fields, "calendarId", required, Some(1), None),
        title: issues.text_with(fields, "title", required, Text::trimmed(Some(1), Some(255))),
        description: issues.text(fields, "description", clearable, None, None),
        ..EventInput::default()
    };
    input.kind = match issues.choice(fields, "type", Presence::Optional, &TYPES) {
        Field::Absent if !update && !fields.contains_key("type") => {
            Field::Set("meeting".to_owned())
        }
        other => other,
    };
    input.start_time = issues.text(fields, "startTime", required, Some(1), None);
    input.end_time = issues.text(fields, "endTime", Presence::Optional, None, None);
    input.all_day = issues.boolean(fields, "allDay", Presence::Optional);
    let timezone_raw = fields.get("timezone");
    input.timezone = issues.text(fields, "timezone", clearable, None, Some(50));
    input.location = issues.text(fields, "location", clearable, None, None);
    input.is_virtual = issues.boolean(fields, "isVirtual", Presence::Optional);
    input.meeting_url = issues.text_with(
        fields,
        "meetingUrl",
        clearable,
        Text {
            trim: true,
            ..Text::default()
        },
    );
    input.status = issues.choice(fields, "status", Presence::Optional, &STATUSES);
    input.priority = issues.choice(fields, "priority", Presence::Optional, &PRIORITIES);
    input.color = issues.text(fields, "color", Presence::Optional, None, None);
    input.recurrence_rule = issues.text(fields, "recurrenceRule", Presence::Optional, None, None);
    if !update {
        input.recurrence_id = issues.text(fields, "recurrenceId", Presence::Optional, None, None);
    }
    input.attendees = attendees(issues, fields, clearable);
    input.reminders = issues.list(
        fields,
        "reminders",
        Presence::Optional,
        None,
        None,
        reminder,
    );
    input.customer_id = issues.text(fields, "customerId", clearable, None, None);
    input.contact_id = issues.text(fields, "contactId", clearable, None, None);
    input.notes = issues.text(fields, "notes", Presence::Optional, None, None);
    input.tags = issues.list(fields, "tags", clearable, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
    input.weld_meeting_id =
        issues.text(fields, "weldMeetingId", Presence::Optional, None, Some(30));

    // Refinements settle after every synchronous check (`safeParseAsync`).
    if let Some(Value::String(zone)) = timezone_raw
        && !is_valid_time_zone(zone)
    {
        issues.custom("timezone", "Invalid IANA timezone");
        input.timezone = Field::Absent;
    }
    if let Field::Set(url) = &input.meeting_url
        && !url.is_empty()
        && !is_http_url(url)
    {
        issues.custom("meetingUrl", "meetingUrl must be an http(s) URL");
    }
    input.data = ordered_data(&input, fields);
    input
}

/// The parsed body as Zod outputs it: the schema's keys in order, those the
/// body carried (or defaulted), a `null` text of an attendee dropped.
fn ordered_data(input: &EventInput, fields: &Map<String, Value>) -> Ordered {
    let mut data = Ordered::default();
    let text = |data: &mut Ordered, key: &str, field: &Field<String>| match field {
        Field::Set(value) => data.plain(key, Value::String(value.clone())),
        Field::Null => data.plain(key, Value::Null),
        Field::Absent => {}
    };
    let flag = |data: &mut Ordered, key: &str, field: &Field<bool>| {
        if let Field::Set(value) = field {
            data.plain(key, Value::Bool(*value));
        }
    };
    text(&mut data, "calendarId", &input.calendar_id);
    text(&mut data, "title", &input.title);
    text(&mut data, "description", &input.description);
    text(&mut data, "type", &input.kind);
    text(&mut data, "startTime", &input.start_time);
    text(&mut data, "endTime", &input.end_time);
    flag(&mut data, "allDay", &input.all_day);
    text(&mut data, "timezone", &input.timezone);
    text(&mut data, "location", &input.location);
    flag(&mut data, "isVirtual", &input.is_virtual);
    text(&mut data, "meetingUrl", &input.meeting_url);
    text(&mut data, "status", &input.status);
    text(&mut data, "priority", &input.priority);
    text(&mut data, "color", &input.color);
    text(&mut data, "recurrenceRule", &input.recurrence_rule);
    text(&mut data, "recurrenceId", &input.recurrence_id);
    match &input.attendees {
        Field::Set(list) => data.push(
            "attendees",
            OrderedValue::Array(
                list.iter()
                    .map(|a| OrderedValue::Object(a.ordered()))
                    .collect(),
            ),
        ),
        Field::Null => data.plain("attendees", Value::Null),
        Field::Absent => {}
    }
    if let Field::Set(list) = &input.reminders {
        data.push(
            "reminders",
            OrderedValue::Array(
                list.iter()
                    .map(|r| {
                        let mut item = Ordered::default();
                        item.plain("type", r["type"].clone());
                        item.plain("minutes", r["minutes"].clone());
                        OrderedValue::Object(item)
                    })
                    .collect(),
            ),
        );
    }
    text(&mut data, "customerId", &input.customer_id);
    text(&mut data, "contactId", &input.contact_id);
    text(&mut data, "notes", &input.notes);
    match &input.tags {
        Field::Set(tags) => data.plain(
            "tags",
            Value::Array(tags.iter().cloned().map(Value::String).collect()),
        ),
        Field::Null => data.plain("tags", Value::Null),
        Field::Absent => {}
    }
    let _ = fields;
    data
}

/// `rescheduleSchema`.
pub(crate) struct RescheduleInput {
    pub(crate) start_time: String,
    pub(crate) end_time: Option<String>,
    pub(crate) manual: bool,
    pub(crate) notify_attendees: bool,
    /// `data`, in the schema's key order.
    pub(crate) data: Ordered,
}

pub(crate) fn read_reschedule(issues: &mut Issues, fields: &Map<String, Value>) -> RescheduleInput {
    let start_time = issues
        .text(fields, "startTime", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let end_time = issues
        .text(fields, "endTime", Presence::Optional, None, None)
        .into_option();
    let manual = issues
        .boolean(fields, "manual", Presence::Optional)
        .into_option()
        .unwrap_or(false);
    let notify_attendees = issues
        .boolean(fields, "notifyAttendees", Presence::Optional)
        .into_option()
        .unwrap_or(true);
    let mut data = Ordered::default();
    data.plain("startTime", Value::String(start_time.clone()));
    if let Some(end) = &end_time {
        data.plain("endTime", Value::String(end.clone()));
    }
    data.plain("manual", Value::Bool(manual));
    data.plain("notifyAttendees", Value::Bool(notify_attendees));
    RescheduleInput {
        start_time,
        end_time,
        manual,
        notify_attendees,
        data,
    }
}

/// `listQuerySchema`.
pub(crate) struct ListQuery {
    pub(crate) limit: f64,
    pub(crate) cursor: Option<String>,
    pub(crate) search: Option<String>,
    pub(crate) kind: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) start_date: Option<String>,
    pub(crate) end_date: Option<String>,
    pub(crate) calendar_ids: Option<String>,
}

fn coerced(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    min: f64,
    max: f64,
    default: f64,
) -> f64 {
    issues
        .number(
            fields,
            key,
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(min),
                max: Some(max),
                ..Number::default()
            },
        )
        .into_option()
        .unwrap_or(default)
}

fn optional_string(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text(fields, key, Presence::Optional, None, None)
        .into_option()
}

pub(crate) fn read_list_query(issues: &mut Issues, fields: &Map<String, Value>) -> ListQuery {
    let limit = coerced(issues, fields, "limit", 1.0, 100.0, 25.0);
    ListQuery {
        limit,
        cursor: optional_string(issues, fields, "cursor"),
        search: optional_string(issues, fields, "search"),
        kind: optional_string(issues, fields, "type"),
        status: optional_string(issues, fields, "status"),
        start_date: optional_string(issues, fields, "startDate"),
        end_date: optional_string(issues, fields, "endDate"),
        calendar_ids: optional_string(issues, fields, "calendarIds"),
    }
}

/// `rangeQuerySchema`.
pub(crate) fn read_range_query(
    issues: &mut Issues,
    fields: &Map<String, Value>,
) -> (String, String, Option<String>) {
    let start = issues
        .text(fields, "startDate", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let end = issues
        .text(fields, "endDate", Presence::Required, Some(1), None)
        .into_option()
        .unwrap_or_default();
    let calendars = optional_string(issues, fields, "calendarIds");
    (start, end, calendars)
}

/// `upcomingQuerySchema`: `(days, limit)`.
pub(crate) fn read_upcoming_query(issues: &mut Issues, fields: &Map<String, Value>) -> (f64, f64) {
    let days = coerced(issues, fields, "days", 1.0, 365.0, 7.0);
    let limit = coerced(issues, fields, "limit", 1.0, 100.0, 20.0);
    (days, limit)
}
