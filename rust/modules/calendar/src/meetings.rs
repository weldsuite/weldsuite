//! Calendar event ↔ WeldMeet meeting sync (`services/calendar-meeting-sync.ts`,
//! TASK-724): a meeting linked to an event (`meetings.calendar_event_id`)
//! follows the event's title, time and attendees, and is cancelled with it.
//! Only `scheduled` meetings are touched; a cancelled event that is on again
//! brings its cancelled meetings back (TASK-935).

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::MEETING_UPDATED;
use weldsuite_db::{PgPool, js_row};
use weldsuite_events::EntityEvent;

use crate::js::{iso, millis_of};
use crate::{CalendarState, Caller, now, text};

/// A meeting the sync changed, as the `meeting` entity event wants it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MeetingChange {
    pub(crate) id: String,
    pub(crate) title: Value,
    pub(crate) status: String,
    pub(crate) start_at: Value,
    pub(crate) host_id: Value,
    pub(crate) old_status: String,
}

/// `publishMeetingChanges`: one `meeting:updated` per change, with the status
/// change when there is one.
pub(crate) fn publish_changes(state: &CalendarState, caller: &Caller, changes: &[MeetingChange]) {
    let events = changes
        .iter()
        .map(|m| {
            let event = EntityEvent::new(
                MEETING_UPDATED,
                m.id.clone(),
                json!({
                    "id": m.id,
                    "title": m.title,
                    "status": m.status,
                    "startAt": m.start_at,
                    "hostId": m.host_id,
                }),
            );
            if m.status == m.old_status {
                event
            } else {
                let mut changes = Map::new();
                changes.insert(
                    "status".to_owned(),
                    json!({ "old": m.old_status, "new": m.status }),
                );
                event.with_changes(changes)
            }
        })
        .collect();
    caller.publish_all(state, events);
}

fn email_of(attendee: &Value) -> String {
    attendee["email"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

fn same_time(a: &Value, b: &Value) -> bool {
    millis_of(a) == millis_of(b)
}

fn iso_or_null(value: &Value) -> Value {
    millis_of(value).map_or(Value::Null, |ms| Value::String(iso(ms)))
}

/// `applyEventAttendeeChange`: the meeting's attendees after the event's list
/// went from `before` to `after`, and whether that changed anything.
pub(crate) fn apply_attendee_change(
    current: &[Value],
    before: &Value,
    after: &Value,
) -> (Vec<Value>, bool) {
    let empty = Vec::new();
    let before_list = before.as_array().unwrap_or(&empty);
    let after_list = after.as_array().unwrap_or(&empty);
    let before_emails: HashSet<String> = before_list
        .iter()
        .map(email_of)
        .filter(|e| !e.is_empty())
        .collect();
    let mut after_order: Vec<String> = Vec::new();
    let mut after_by_email: std::collections::HashMap<String, &Value> =
        std::collections::HashMap::new();
    for attendee in after_list {
        let email = email_of(attendee);
        if !email.is_empty() && !after_by_email.contains_key(&email) {
            after_order.push(email.clone());
            after_by_email.insert(email, attendee);
        }
    }
    let removed: HashSet<&String> = before_emails
        .iter()
        .filter(|e| !after_by_email.contains_key(*e))
        .collect();
    let added: Vec<&String> = after_order
        .iter()
        .filter(|e| !before_emails.contains(*e))
        .collect();
    if removed.is_empty() && added.is_empty() {
        return (current.to_vec(), false);
    }
    let kept: Vec<Value> = current
        .iter()
        .filter(|a| {
            !(removed.contains(&email_of(a))
                && a["role"] != "organizer"
                && a["source"] != "walk_in")
        })
        .cloned()
        .collect();
    let on_meeting: HashSet<String> = kept.iter().map(email_of).collect();
    let mut appended = Vec::new();
    for email in added {
        if on_meeting.contains(email) {
            continue;
        }
        let name = after_by_email
            .get(email)
            .and_then(|a| a["name"].as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(email);
        appended.push(json!({
            "userId": "",
            "email": email,
            "name": name,
            "status": "pending",
            "role": "attendee",
        }));
    }
    let changed = kept.len() != current.len() || !appended.is_empty();
    let mut attendees = kept;
    attendees.extend(appended);
    (attendees, changed)
}

/// Point a meeting at its event, if the caller organises it
/// (`linkMeetingToEvent`).
pub(crate) async fn link(
    db: &PgPool,
    meeting_id: &str,
    event_id: &str,
    user_id: &str,
) -> Result<Option<MeetingChange>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update meetings set calendar_event_id = $2, updated_at = $4::timestamp
         where id = $1 and deleted_at is null and organizer_id = $3
         returning to_jsonb(meetings)",
    )
    .bind(meeting_id)
    .bind(event_id)
    .bind(user_id)
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row).map(|row| {
        let status = text(&row, "status").to_owned();
        MeetingChange {
            id: text(&row, "id").to_owned(),
            title: row["title"].clone(),
            status: status.clone(),
            start_at: iso_or_null(&row["scheduledStart"]),
            host_id: row["organizerId"].clone(),
            old_status: status,
        }
    }))
}

async fn scheduled_for_event(db: &PgPool, event_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from meetings m
         where calendar_event_id = $1 and deleted_at is null and status = 'scheduled'",
    )
    .bind(event_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn cancel(db: &PgPool, row: &Value) -> Result<MeetingChange, sqlx::Error> {
    sqlx::query(
        "update meetings set status = 'cancelled', updated_at = $2::timestamp
         where id = $1 and status = 'scheduled'",
    )
    .bind(text(row, "id"))
    .bind(now())
    .execute(db)
    .await?;
    Ok(MeetingChange {
        id: text(row, "id").to_owned(),
        title: row["title"].clone(),
        status: "cancelled".to_owned(),
        start_at: iso_or_null(&row["scheduledStart"]),
        host_id: row["organizerId"].clone(),
        old_status: text(row, "status").to_owned(),
    })
}

/// The event no longer carries this meeting's join link (`lostMeetingLink`).
fn lost_link(row: &Value, meeting_url: &Value) -> bool {
    let url = meeting_url.as_str().map(str::trim).unwrap_or_default();
    if url.is_empty() {
        return true;
    }
    match row["joinCode"].as_str().filter(|code| !code.is_empty()) {
        Some(code) => !url.contains(code),
        None => false,
    }
}

/// Cancel every scheduled meeting of an event (`cancelMeetingsForEvent`).
pub(crate) async fn cancel_for_event(
    db: &PgPool,
    event_id: &str,
) -> Result<Vec<MeetingChange>, sqlx::Error> {
    let mut out = Vec::new();
    for row in scheduled_for_event(db, event_id).await? {
        out.push(cancel(db, &row).await?);
    }
    Ok(out)
}

/// Of these events, the ones with a scheduled meeting
/// (`eventIdsWithScheduledMeetings`).
pub(crate) async fn event_ids_with_scheduled_meetings(
    db: &PgPool,
    event_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if event_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Option<String>> = sqlx::query_scalar(
        "select distinct calendar_event_id from meetings
         where calendar_event_id = any($1) and deleted_at is null and status = 'scheduled'",
    )
    .bind(event_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .collect())
}

/// Put an event's cancelled meetings back on, when the event still carries
/// their link (`restoreMeetingsForEvent`).
async fn restore_for_event(db: &PgPool, event: &Value) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from meetings m
         where calendar_event_id = $1 and deleted_at is null and status = 'cancelled'",
    )
    .bind(text(event, "id"))
    .fetch_all(db)
    .await?;
    let mut restored = Vec::new();
    for row in rows.into_iter().map(js_row) {
        if lost_link(&row, &event["meetingUrl"]) {
            continue;
        }
        sqlx::query(
            "update meetings set status = 'scheduled', updated_at = $2::timestamp
             where id = $1 and status = 'cancelled'",
        )
        .bind(text(&row, "id"))
        .bind(now())
        .execute(db)
        .await?;
        restored.push(text(&row, "id").to_owned());
    }
    Ok(restored)
}

/// Bring the linked meetings in line with the event (`syncMeetingsFromEvent`):
/// `before` is the event before the edit, `after` the re-read row.
pub(crate) async fn sync_from_event(
    db: &PgPool,
    before: &Value,
    after: &Value,
) -> Result<Vec<MeetingChange>, sqlx::Error> {
    let after_deleted = !after["deletedAt"].is_null();
    let uncancelled =
        before["status"] == "cancelled" && after["status"] != "cancelled" && !after_deleted;
    let restored: HashSet<String> = if uncancelled {
        restore_for_event(db, after).await?.into_iter().collect()
    } else {
        HashSet::new()
    };
    let mut out = Vec::new();
    for row in scheduled_for_event(db, text(after, "id")).await? {
        let id = text(&row, "id").to_owned();
        let old_status = if restored.contains(&id) {
            "cancelled".to_owned()
        } else {
            text(&row, "status").to_owned()
        };
        if after_deleted || after["status"] == "cancelled" || lost_link(&row, &after["meetingUrl"])
        {
            out.push(cancel(db, &row).await?);
            continue;
        }
        let set_title = row["title"] != after["title"];
        let set_start = !same_time(&row["scheduledStart"], &after["startTime"]);
        let set_end = !same_time(&row["scheduledEnd"], &after["endTime"]);
        let current = row["attendees"].as_array().cloned().unwrap_or_default();
        let (attendees, attendees_changed) =
            apply_attendee_change(&current, &before["attendees"], &after["attendees"]);
        let changed = set_title || set_start || set_end || attendees_changed;
        if !changed && !restored.contains(&id) {
            continue;
        }
        if changed {
            sqlx::query(
                "update meetings set
                     title = case when $2 then $3 else title end,
                     scheduled_start = case when $4 then $5::timestamp else scheduled_start end,
                     scheduled_end = case when $6 then $7::timestamp else scheduled_end end,
                     attendees = case when $8 then $9::jsonb else attendees end,
                     updated_at = $10::timestamp
                 where id = $1 and status = 'scheduled'",
            )
            .bind(&id)
            .bind(set_title)
            .bind(after["title"].as_str())
            .bind(set_start)
            .bind(millis_of(&after["startTime"]).map(iso))
            .bind(set_end)
            .bind(millis_of(&after["endTime"]).map(iso))
            .bind(attendees_changed)
            .bind(Value::Array(attendees))
            .bind(now())
            .execute(db)
            .await?;
        }
        let title = if set_title {
            after["title"].clone()
        } else {
            row["title"].clone()
        };
        let start_at = if set_start {
            iso_or_null(&after["startTime"])
        } else {
            iso_or_null(&row["scheduledStart"])
        };
        out.push(MeetingChange {
            id,
            title,
            status: text(&row, "status").to_owned(),
            start_at,
            host_id: row["organizerId"].clone(),
            old_status,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attendee_changes_follow_the_event() {
        let current = vec![
            json!({ "userId": "u1", "email": "a@x.test", "name": "A", "status": "accepted", "role": "organizer" }),
            json!({ "userId": "", "email": "b@x.test", "name": "B", "status": "pending", "role": "attendee" }),
        ];
        let before = json!([{ "email": "a@x.test" }, { "email": "b@x.test" }]);
        let after = json!([{ "email": "c@x.test", "name": " C " }]);
        let (attendees, changed) = apply_attendee_change(&current, &before, &after);
        assert!(changed);
        assert_eq!(attendees.len(), 2);
        assert_eq!(attendees[0]["email"], "a@x.test");
        assert_eq!(attendees[1]["name"], "C");
        let (_, unchanged) = apply_attendee_change(&current, &before, &before);
        assert!(!unchanged);
    }
}
