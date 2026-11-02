//! Leads (`@weldsuite/crm-domain/leads`): pre-qualified contacts in
//! `crm_leads`. Shared by crm-api's routes and WeldConnect's `create_lead`
//! step, so both insert the same row and publish the same `lead:created`
//! payload.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::tables::CRM_LEADS;
use crate::{DomainResult, insert_sql, now};

/// `LEAD_EVENT_FIELDS`: the contact card a workflow needs, not the whole
/// row (the free-text qualification fields stay off the event bus).
pub const LEAD_EVENT_FIELDS: [&str; 13] = [
    "firstName",
    "lastName",
    "fullName",
    "companyName",
    "title",
    "phone",
    "mobile",
    "website",
    "address",
    "source",
    "rating",
    "score",
    "ownerId",
];

/// `leadEventFields(lead)`: each event field, `null` when unset.
pub fn lead_event_fields(lead: &Map<String, Value>) -> Map<String, Value> {
    LEAD_EVENT_FIELDS
        .iter()
        .map(|field| {
            let value = lead.get(*field).cloned().unwrap_or(Value::Null);
            ((*field).to_owned(), value)
        })
        .collect()
}

/// `value || ''`-style truthiness of a JSON value.
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// What `createLead` answers.
#[derive(Debug, Clone)]
pub struct CreatedLead {
    pub id: String,
    pub row: Map<String, Value>,
    pub event_data: Value,
}

/// The input keys copied to the row as they are, in `createLead`'s order.
const COPIED: [&str; 10] = [
    "firstName",
    "lastName",
    "email",
    "companyName",
    "title",
    "phone",
    "mobile",
    "website",
    "address",
    "channel",
];

/// `createLead(db, input, actingUserId)`: insert the row; `ownerId`
/// defaults to the acting user.
pub async fn create_lead(
    db: &PgPool,
    input: &Map<String, Value>,
    acting_user_id: Option<&str>,
) -> DomainResult<CreatedLead> {
    let id = generate_id("lead");
    let now = now();
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    for key in COPIED {
        if let Some(value) = input.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    // `firstName || lastName ? \`${firstName ?? ''} ${lastName ?? ''}\`.trim() : undefined`
    if js_truthy(input.get("firstName")) || js_truthy(input.get("lastName")) {
        let full = format!("{} {}", text("firstName"), text("lastName"));
        values.insert(
            "fullName".into(),
            json!(weldsuite_kit::validation::js_trim(&full)),
        );
    }
    values.insert(
        "source".into(),
        input.get("source").cloned().unwrap_or(json!("other")),
    );
    for key in ["campaign", "medium"] {
        if let Some(value) = input.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert(
        "status".into(),
        input.get("status").cloned().unwrap_or(json!("new")),
    );
    if let Some(rating) = input.get("rating") {
        values.insert("rating".into(), rating.clone());
    }
    values.insert(
        "score".into(),
        input.get("score").cloned().unwrap_or(json!(0)),
    );
    // `input.ownerId ?? actingUserId`
    match input.get("ownerId") {
        Some(Value::Null) | None => {
            if let Some(user) = acting_user_id {
                values.insert("ownerId".into(), json!(user));
            }
        }
        Some(owner) => {
            values.insert("ownerId".into(), owner.clone());
        }
    }
    for key in [
        "productInterest",
        "budget",
        "timeline",
        "authority",
        "need",
        "notes",
        "nextAction",
    ] {
        if let Some(value) = input.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    sqlx::query(insert_sql!(crm_leads))
        .bind(CRM_LEADS.values(&values))
        .execute(db)
        .await?;
    let mut event = lead_event_fields(&values);
    event.insert("id".into(), json!(id));
    event.insert(
        "email".into(),
        values.get("email").cloned().unwrap_or(json!("")),
    );
    event.insert("status".into(), values["status"].clone());
    Ok(CreatedLead {
        id,
        row: values,
        event_data: Value::Object(event),
    })
}
