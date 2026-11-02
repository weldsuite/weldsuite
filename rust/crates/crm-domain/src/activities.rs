//! Activities (`@weldsuite/crm-domain/activities`): the call, email,
//! meeting, task and note trail on a contact, customer, lead or
//! opportunity (`crm_activities`). Shared by crm-api's routes and
//! WeldConnect's `log_activity` step, so both insert the same row and
//! publish the same `activity:created` payload.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::tables::CRM_ACTIVITIES;
use crate::{DomainError, DomainResult, insert_sql, now, to_iso};

/// What `createActivity` answers.
#[derive(Debug, Clone)]
pub struct CreatedActivity {
    pub id: String,
    /// The inserted values (not re-read), by Drizzle key.
    pub row: Map<String, Value>,
    /// `activity:created`'s data.
    pub event_data: Value,
}

/// The input keys copied to the row as they are (`values` of `createActivity`).
const COPIED: [&str; 30] = [
    "type",
    "subject",
    "description",
    "relatedTo",
    "relatedToId",
    "relatedToName",
    "customerId",
    "contactId",
    "personId",
    "leadId",
    "opportunityId",
    "duration",
    "location",
    "isVirtual",
    "meetingUrl",
    "callDirection",
    "callDuration",
    "callRecordingUrl",
    "emailMessageId",
    "emailSubject",
    "emailFrom",
    "emailTo",
    "emailCc",
    "attendees",
    "meetingAgenda",
    "meetingNotes",
    "outcome",
    "nextAction",
    "attachments",
    "calendarEventId",
];

/// `x ? new Date(x) : undefined` for a date field of the input.
fn date_field(input: &Map<String, Value>, key: &str) -> DomainResult<Option<Value>> {
    match input.get(key) {
        Some(Value::String(text)) if !text.is_empty() => Ok(Some(Value::String(to_iso(text)?))),
        _ => Ok(None),
    }
}

/// `createActivity(db, input, actingUserId)`: insert the row; `assignedToId`
/// defaults to the acting user.
pub async fn create_activity(
    db: &PgPool,
    input: &Map<String, Value>,
    acting_user_id: Option<&str>,
) -> DomainResult<CreatedActivity> {
    let assigned_to_id = input
        .get("assignedToId")
        .and_then(Value::as_str)
        .or(acting_user_id)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| DomainError::Other("assignedToId required".to_owned()))?
        .to_owned();
    let id = generate_id("act");
    let now = now();
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    for key in COPIED {
        if let Some(value) = input.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert("assignedToId".into(), json!(assigned_to_id));
    for key in ["dueDate", "startTime", "endTime", "followUpDate"] {
        if let Some(date) = date_field(input, key)? {
            values.insert(key.into(), date);
        }
    }
    values.insert(
        "status".into(),
        input.get("status").cloned().unwrap_or(json!("planned")),
    );
    values.insert(
        "priority".into(),
        input.get("priority").cloned().unwrap_or(json!("medium")),
    );
    for key in ["tags", "customFields"] {
        if let Some(value) = input.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    sqlx::query(insert_sql!(crm_activities))
        .bind(CRM_ACTIVITIES.values(&values))
        .execute(db)
        .await?;
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for (to, from) in [
        ("type", "type"),
        ("subject", "subject"),
        ("status", "status"),
        ("customerId", "customerId"),
        ("contactId", "contactId"),
        ("assigneeId", "assignedToId"),
    ] {
        if let Some(value) = values.get(from) {
            event.insert(to.into(), value.clone());
        }
    }
    event.insert(
        "dueDate".into(),
        values.get("dueDate").cloned().unwrap_or(Value::Null),
    );
    Ok(CreatedActivity {
        id,
        row: values,
        event_data: Value::Object(event),
    })
}
