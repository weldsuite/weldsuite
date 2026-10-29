//! `/api/calendars` (`routes/calendars/index.ts`): the caller's calendars and
//! the ones shared with them, sharing, the default calendar, and deleting a
//! calendar together with its events.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    CALENDAR_CREATED, CALENDAR_DELETED, CALENDAR_EVENT_DELETED, CALENDAR_SHARE_CREATED,
    CALENDAR_SHARE_DELETED, CALENDAR_SHARE_UPDATED, CALENDAR_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_events::EntityEvent;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::access;
use crate::js::{millis_of, now_ms};
use crate::mail::{self, MailEvent, MailKind};
use crate::{CalendarState, Caller, Outcome, Refusal, all, now, query_param, text, validate};

const PERMISSIONS: [&str; 3] = ["view", "edit", "manage"];

/// `{ name, description?, color? }`, or its `.partial()`.
struct CalendarInput {
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
}

fn calendar_input(headers: &HeaderMap, body: &Bytes, partial: bool) -> Outcome<CalendarInput> {
    validate(headers, body, |issues, fields| {
        let name_presence = if partial {
            Presence::Optional
        } else {
            Presence::Required
        };
        CalendarInput {
            name: issues
                .text(fields, "name", name_presence, Some(1), Some(255))
                .into_option(),
            description: issues
                .text(fields, "description", Presence::Optional, None, Some(500))
                .into_option(),
            color: issues
                .text(fields, "color", Presence::Optional, None, Some(20))
                .into_option(),
        }
    })
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    match access::list_for_user(&caller.db, &caller.user_id).await {
        Ok(rows) => all(rows),
        Err(error) => Refusal::from(error).respond("Failed to list calendars"),
    }
}

// ── POST /ensure-default ────────────────────────────────────────────────────

pub(crate) async fn ensure_default(State(state): State<CalendarState>, caller: Caller) -> Response {
    match access::ensure_default(&caller.db, &caller.user_id).await {
        Ok((calendar, created)) => {
            if created {
                let id = text(&calendar, "id").to_owned();
                caller.publish(
                    &state,
                    CALENDAR_CREATED,
                    &id,
                    &json!({ "id": id, "name": calendar["name"], "ownerId": calendar["ownerId"] }),
                );
                Created(calendar).into_response()
            } else {
                Data(calendar).into_response()
            }
        }
        Err(error) => Refusal::from(error).respond("Failed to ensure default calendar"),
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CalendarState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match calendar_input(&headers, &body, false) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to create calendar"),
    };
    let id = generate_id("cal");
    let now = now();
    let name = input.name.unwrap_or_default();
    let inserted = sqlx::query(
        "insert into calendars
             (id, name, description, color, owner_id, is_default, is_active, created_at, updated_at)
         values ($1, $2, $3, $4, $5, false, true, $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&input.description)
    .bind(&input.color)
    .bind(&caller.user_id)
    .bind(&now)
    .execute(&caller.db)
    .await;
    match inserted {
        Ok(_) => {
            caller.publish(
                &state,
                CALENDAR_CREATED,
                &id,
                &json!({ "id": id, "name": name, "ownerId": caller.user_id }),
            );
            Created(json!({ "id": id })).into_response()
        }
        Err(error) => Refusal::from(error).respond("Failed to create calendar"),
    }
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = access::calendar_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Calendar", &id));
        };
        if access::calendar_access(&caller.db, &id, &caller.user_id)
            .await?
            .is_none()
        {
            return Err(Refusal::forbidden());
        }
        Ok::<_, Refusal>(row)
    }
    .await;
    match result {
        Ok(row) => Data(row).into_response(),
        Err(refused) => refused.respond("Failed to fetch calendar"),
    }
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match calendar_input(&headers, &body, true) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to update calendar"),
    };
    let result = async {
        let Some(existing) = access::calendar_row(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Calendar", &id));
        };
        if text(&existing, "ownerId") != caller.user_id {
            return Err(Refusal::forbidden());
        }
        sqlx::query(
            "update calendars set
                 updated_at = $2::timestamp,
                 name = case when $3 then $4 else name end,
                 description = case when $5 then $6 else description end,
                 color = case when $7 then $8 else color end
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(now())
        .bind(input.name.is_some())
        .bind(&input.name)
        .bind(input.description.is_some())
        .bind(&input.description)
        .bind(input.color.is_some())
        .bind(&input.color)
        .execute(&caller.db)
        .await?;
        let name = input
            .name
            .clone()
            .map_or_else(|| existing["name"].clone(), Value::String);
        caller.publish(
            &state,
            CALENDAR_UPDATED,
            &id,
            &json!({ "id": id, "name": name, "ownerId": existing["ownerId"] }),
        );
        let mut answer = json!({ "id": id });
        if let Some(name) = &input.name {
            answer["name"] = json!(name);
        }
        if let Some(description) = &input.description {
            answer["description"] = json!(description);
        }
        if let Some(color) = &input.color {
            answer["color"] = json!(color);
        }
        Ok::<_, Refusal>(answer)
    }
    .await;
    match result {
        Ok(answer) => Data(answer).into_response(),
        Err(refused) => refused.respond("Failed to update calendar"),
    }
}

// ── Delete (TASK-745) ───────────────────────────────────────────────────────

/// The calendar the caller may delete (`loadDeletableCalendar`): 404 when
/// missing, 403 when not theirs, 400 for the default calendar.
async fn deletable(caller: &Caller, id: &str) -> Outcome<Value> {
    let Some(calendar) = access::calendar_row(&caller.db, id).await? else {
        return Err(Refusal::not_found("Calendar", id));
    };
    if text(&calendar, "ownerId") != caller.user_id {
        return Err(Refusal::forbidden());
    }
    if calendar["isDefault"] == true {
        return Err(Refusal::bad_request("Cannot delete default calendar"));
    }
    Ok(calendar)
}

/// `needsCancellationMail`: attendees, not already cancelled, not over yet
/// (a recurring event always counts).
pub(crate) fn needs_cancellation_mail(row: &Value, now: i64) -> bool {
    if row["attendees"].as_array().is_none_or(Vec::is_empty) {
        return false;
    }
    if row["status"] == "cancelled" {
        return false;
    }
    if row["recurrenceRule"]
        .as_str()
        .is_some_and(|rule| !rule.is_empty())
    {
        return true;
    }
    let end = millis_of(&row["endTime"]).or_else(|| millis_of(&row["startTime"]));
    end.is_some_and(|end| end >= now)
}

/// The calendar's live events (`listCalendarEventsForDeletion`).
async fn calendar_events(caller: &Caller, calendar_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from calendar_events e where calendar_id = $1 and deleted_at is null",
    )
    .bind(calendar_id)
    .fetch_all(&caller.db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

pub(crate) async fn delete_impact(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        deletable(&caller, &id).await?;
        let events = calendar_events(&caller, &id).await?;
        let now = now_ms();
        let with_attendees = events
            .iter()
            .filter(|event| needs_cancellation_mail(event, now))
            .count();
        Ok::<_, Refusal>(
            json!({ "eventCount": events.len(), "eventsWithAttendees": with_attendees }),
        )
    }
    .await;
    match result {
        Ok(impact) => Data(impact).into_response(),
        Err(refused) => refused.respond("Failed to load calendar delete impact"),
    }
}

pub(crate) async fn remove(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let send_notification =
        query_param(query.as_deref(), "sendNotification").as_deref() == Some("true");
    let result = async {
        let calendar = deletable(&caller, &id).await?;
        // Read before the soft delete: the mails and meeting cancels need the rows.
        let events = calendar_events(&caller, &id).await?;
        soft_delete(&caller, &id).await?;

        let mut published = vec![EntityEvent::new(
            CALENDAR_DELETED,
            id.clone(),
            json!({ "id": id, "name": calendar["name"], "ownerId": calendar["ownerId"] }),
        )];
        for event in &events {
            published.push(EntityEvent::new(
                CALENDAR_EVENT_DELETED,
                text(event, "id"),
                json!({ "id": event["id"], "title": event["title"], "calendarId": id }),
            ));
        }
        caller.publish_all(&state, published);

        let event_ids: Vec<String> = events.iter().map(|e| text(e, "id").to_owned()).collect();
        if !event_ids.is_empty() {
            crate::google::queue_deletes(&state, &caller, event_ids.clone());
        }

        cancel_linked_meetings(&state, &caller, &event_ids).await;

        if send_notification {
            let now = now_ms();
            let to_notify: Vec<Value> = events
                .into_iter()
                .filter(|event| needs_cancellation_mail(event, now))
                .collect();
            if !to_notify.is_empty() {
                queue_cancellation_mails(&state, &caller, to_notify);
            }
        }
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(refused) => refused.respond("Failed to delete calendar"),
    }
}

/// Soft-delete a calendar, its events and its shares (`softDeleteCalendar`).
async fn soft_delete(caller: &Caller, calendar_id: &str) -> Result<(), sqlx::Error> {
    let now = now();
    sqlx::query(
        "update calendar_events set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where calendar_id = $1 and deleted_at is null",
    )
    .bind(calendar_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    sqlx::query(
        "update calendar_shares set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where calendar_id = $1 and deleted_at is null",
    )
    .bind(calendar_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    sqlx::query(
        "update calendars set deleted_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1 and deleted_at is null",
    )
    .bind(calendar_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    Ok(())
}

/// Cancel the WeldMeet meetings linked to the deleted events (best effort).
async fn cancel_linked_meetings(state: &CalendarState, caller: &Caller, event_ids: &[String]) {
    let result = async {
        let with_meetings =
            crate::meetings::event_ids_with_scheduled_meetings(&caller.db, event_ids).await?;
        let mut changed = Vec::new();
        for event_id in with_meetings {
            changed.extend(crate::meetings::cancel_for_event(&caller.db, &event_id).await?);
        }
        Ok::<_, sqlx::Error>(changed)
    }
    .await;
    match result {
        Ok(changed) => crate::meetings::publish_changes(state, caller, &changed),
        Err(error) => tracing::error!(%error, "[calendar-api/calendars] meeting cancel failed"),
    }
}

/// Mail a cancellation to the attendees of each event, in the background.
fn queue_cancellation_mails(state: &CalendarState, caller: &Caller, events: Vec<Value>) {
    let context = mail::MailContext::of(state, caller);
    state.events.tracker().spawn(async move {
        let mut organizers = std::collections::HashMap::new();
        let language = mail::workspace_language(&context.db).await;
        for event in events {
            let organizer_id = text(&event, "organizerId").to_owned();
            let organizer = if let Some(organizer) = organizers.get(&organizer_id) {
                Clone::clone(organizer)
            } else {
                let organizer = mail::organizer_info(&context.db, &organizer_id).await;
                organizers.insert(organizer_id, organizer.clone());
                organizer
            };
            let attendees = mail::attendees_of(&event["attendees"]);
            let emails: Vec<String> = attendees
                .iter()
                .map(|a| a.email.clone().unwrap_or_default())
                .collect();
            let members = mail::member_emails(&context.db, &emails).await;
            let mail_event = MailEvent {
                meeting_url: None,
                ..MailEvent::from_row(&event)
            };
            mail::send_calendar_event_emails(
                &context,
                mail::SendOptions {
                    kind: MailKind::Cancel,
                    event: mail_event,
                    attendees,
                    organizer,
                    sequence: Some(3),
                    old_start_time: None,
                    old_end_time: None,
                    member_emails: members,
                    workspace_language: language.clone(),
                },
            )
            .await;
        }
    });
}

// ── Shares ──────────────────────────────────────────────────────────────────

pub(crate) async fn shares(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        owner_only(&caller, &id).await?;
        Ok::<_, Refusal>(access::list_shares(&caller.db, &id).await?)
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(refused) => refused.respond("Failed to list shares"),
    }
}

/// The calendar exists and the caller owns it: 404 / 403 otherwise.
async fn owner_only(caller: &Caller, id: &str) -> Outcome<()> {
    let owner: Option<String> = sqlx::query_scalar(
        "select owner_id from calendars where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    match owner {
        None => Err(Refusal::not_found("Calendar", id)),
        Some(owner) if owner != caller.user_id => Err(Refusal::forbidden()),
        Some(_) => Ok(()),
    }
}

/// 422 for a well-formed request the share model cannot accept.
fn unprocessable(message: &str) -> Refusal {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "UNPROCESSABLE_ENTITY",
        message,
    )
    .into()
}

pub(crate) async fn share(
    State(state): State<CalendarState>,
    caller: Caller,
    Path(calendar_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, fields| {
        let shared_with = issues
            .text_with(
                fields,
                "sharedWithId",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option();
        let permission = issues
            .choice(fields, "permission", Presence::Optional, &PERMISSIONS)
            .into_option()
            .unwrap_or_else(|| "view".to_owned());
        (shared_with.unwrap_or_default(), permission)
    });
    let (shared_with_id, permission) = match input {
        Ok(input) => input,
        Err(refused) => return refused.respond("Failed to share calendar"),
    };
    let result = async {
        let Some(access) =
            access::calendar_access(&caller.db, &calendar_id, &caller.user_id).await?
        else {
            let exists = access::calendar_row(&caller.db, &calendar_id).await?;
            return Err(if exists.is_some() {
                Refusal::forbidden()
            } else {
                Refusal::not_found("Calendar", &calendar_id)
            });
        };
        if !access.is_own && access.permission != "manage" {
            return Err(Refusal::forbidden());
        }
        if shared_with_id == caller.user_id || shared_with_id == text(&access.calendar, "ownerId") {
            return Err(unprocessable(
                "A calendar cannot be shared with yourself or its owner",
            ));
        }
        if !access::is_active_member(&caller.db, &shared_with_id).await? {
            return Err(unprocessable(
                "Calendars can only be shared with members of this workspace",
            ));
        }
        let (id, created) = access::upsert_share(
            &caller.db,
            &calendar_id,
            &shared_with_id,
            &permission,
            &caller.user_id,
        )
        .await?;
        let data = json!({
            "id": id,
            "calendarId": calendar_id,
            "sharedWithId": shared_with_id,
            "permission": permission,
        });
        if created {
            caller.publish(&state, CALENDAR_SHARE_CREATED, &id, &data);
            return Ok(Created(json!({ "id": id })).into_response());
        }
        caller.publish(&state, CALENDAR_SHARE_UPDATED, &id, &data);
        Ok::<_, Refusal>(Data(json!({ "id": id, "permission": permission })).into_response())
    }
    .await;
    result.unwrap_or_else(|refused| refused.respond("Failed to share calendar"))
}

pub(crate) async fn unshare(
    State(state): State<CalendarState>,
    caller: Caller,
    Path((calendar_id, share_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        owner_only(&caller, &calendar_id).await?;
        access::remove_share(&caller.db, &calendar_id, &share_id).await?;
        caller.publish(
            &state,
            CALENDAR_SHARE_DELETED,
            &share_id,
            &json!({ "id": share_id, "calendarId": calendar_id }),
        );
        Ok::<_, Refusal>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(refused) => refused.respond("Failed to remove share"),
    }
}
