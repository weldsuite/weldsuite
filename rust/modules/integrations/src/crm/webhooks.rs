//! The CRM providers' webhook receivers (integration-webhook-worker's
//! `index.ts`, `lib/integrations`, `lib/sync.ts`, `lib/token.ts`):
//!
//! - `POST /webhook/:connectionId`: one connection's deliveries (Attio, and
//!   any provider the connection's KV entry names): signature, then each
//!   record, note, task or list-entry event fetched and upserted;
//! - `POST /webhook/hubspot`: `HubSpot`'s single app URL, the connection
//!   found by portal id (KV, else a scan of the workspaces);
//! - `POST /webhook/gcal/:connectionId`: Google Calendar's push
//!   notifications, which start an incremental sync through WeldConnect's
//!   internal sync route.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_catalogs::entity_events as events;
use weldsuite_core_domain::js::{Js, js_string, number_text};
use weldsuite_db::PgPool;
use weldsuite_events::{EventContext, EventSource, publish_entity_event};
use weldsuite_kit::generate_id;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::adapters::{form, hubspot_entity, json_of, millis_of, send};
use super::engine::{
    EntityTable, UpsertAction, find_mapping, insert_mapping, insert_row, now, touch_mapping,
    update_row, upsert_by_mapping,
};
use super::mapper::truthy;
use super::{Record, checksum, db_message, now_millis};
use crate::connect_internal::ConnectCall;
use crate::{IntegrationsState, PublicCtx};

const ATTIO_API_BASE: &str = "https://api.attio.com/v2";
const HUBSPOT_API_BASE: &str = "https://api.hubapi.com";
const EXPIRY_BUFFER_MS: i64 = 60_000;
const PORTAL_TTL: Duration = Duration::from_hours(24 * 30);

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhook/hubspot", post(hubspot_webhook))
        .route("/webhook/gcal/{connection_id}", post(gcal_webhook))
        .route("/webhook/{connection_id}", post(connection_webhook))
        .with_state(state)
}

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    answer(status, json!({ "error": message }))
}

/// A truthy value as a template string reads it (`${value}`).
fn text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), |v| js_string(&Js::from_jsonb(v)))
}

/// `value || ''`.
fn or_empty(value: Option<&Value>) -> String {
    if truthy(value) {
        text(value)
    } else {
        String::new()
    }
}

/// `ParsedWebhookEvent`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebhookEvent {
    pub event_type: String,
    pub object_id: String,
    pub object_type: String,
    pub record_id: String,
    pub merged_from_id: Option<String>,
    pub note_id: String,
    pub task_id: String,
    pub list_entry_id: String,
    pub list_id: String,
}

/// A record fetched for a webhook (`ExternalRecord`).
#[derive(Debug, Clone)]
pub struct ExternalRecord {
    pub id: String,
    pub data: Map<String, Value>,
    pub raw: Js,
}

/// The webhook worker's providers (`lib/integrations/registry.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Attio,
    HubSpot,
}

/// `crypto.subtle` HMAC-SHA256 of `body` as hex.
fn hmac_hex(secret: &str, body: &[u8]) -> String {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

/// The providers' constant-time compare: equal length, every code unit equal.
fn same(a: &str, b: &str) -> bool {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    a.len() == b.len() && a.iter().zip(&b).fold(0u16, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `secretMatches(provided, expected)`.
pub(crate) fn secret_matches(provided: Option<&str>, expected: Option<&str>) -> bool {
    match (provided, expected) {
        (Some(p), Some(e)) if !p.is_empty() && !e.is_empty() => same(p, e),
        _ => false,
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
}

/// The in-memory object slug cache (`objectSlugCache`, per worker instance).
fn slug_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn bearer(url: String, token: &str) -> HttpRequest {
    HttpRequest::empty("GET", url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
}

/// `HUBSPOT_PROPERTIES` of the webhook provider.
fn hubspot_properties(slug: &str) -> &'static str {
    match slug {
        "contacts" => {
            "firstname,lastname,email,phone,mobilephone,jobtitle,company,website,lifecyclestage"
        }
        "companies" => {
            "name,domain,phone,industry,description,numberofemployees,annualrevenue,website"
        }
        "deals" => "dealname,amount,dealstage,pipeline,closedate,description,deal_currency_code",
        _ => "",
    }
}

/// `OBJECT_TYPE_SLUGS[objectTypeId]`.
fn hubspot_slug(object: &str) -> Option<&'static str> {
    match object {
        "0-1" | "contact" => Some("contacts"),
        "0-2" | "company" => Some("companies"),
        "0-3" | "deal" => Some("deals"),
        _ => None,
    }
}

impl Provider {
    pub fn for_name(name: &str) -> Option<Self> {
        match name {
            "attio" => Some(Self::Attio),
            "hubspot" => Some(Self::HubSpot),
            _ => None,
        }
    }

    /// `verifyWebhookSignature(body, headers, secret)`.
    pub fn verify(self, body: &[u8], headers: &HeaderMap, secret: &str) -> bool {
        match self {
            Self::Attio => {
                let Some(signature) = header(headers, "attio-signature")
                    .or_else(|| header(headers, "x-attio-signature"))
                else {
                    return false;
                };
                same(signature, &hmac_hex(secret, body))
            }
            Self::HubSpot => {
                let Some(signature) = header(headers, "x-hubspot-signature-v3")
                    .or_else(|| header(headers, "x-hubspot-signature"))
                else {
                    return false;
                };
                let mut source = secret.as_bytes().to_vec();
                source.extend_from_slice(body);
                same(signature, &hex::encode(Sha256::digest(&source)))
            }
        }
    }

    /// `parseWebhookPayload(body)`: the webhook id and the events.
    pub fn parse(self, body: &[u8]) -> Result<(String, Vec<WebhookEvent>), String> {
        let payload: Value = serde_json::from_slice(body).map_err(|e| e.to_string())?;
        match self {
            Self::Attio => {
                let events = payload
                    .get("events")
                    .filter(|e| truthy(Some(e)))
                    .map(|e| {
                        e.as_array()
                            .cloned()
                            .ok_or("(payload.events || []).map is not a function")
                    })
                    .transpose()?
                    .unwrap_or_default();
                let mut out = Vec::with_capacity(events.len());
                for evt in events {
                    let event_type = evt
                        .get("event_type")
                        .and_then(Value::as_str)
                        .ok_or("Cannot read properties of undefined (reading 'startsWith')")?
                        .to_owned();
                    let id = evt.get("id");
                    let of = |key: &str| or_empty(id.and_then(|i| i.get(key)));
                    let mut event = WebhookEvent {
                        event_type: event_type.clone(),
                        ..WebhookEvent::default()
                    };
                    if event_type.starts_with("note.") {
                        event.note_id = of("note_id");
                    } else if event_type.starts_with("task.") {
                        event.task_id = of("task_id");
                    } else if event_type.starts_with("list-entry.") {
                        event.list_entry_id = of("entry_id");
                        event.list_id = of("list_id");
                    } else {
                        event.object_id = of("object_id");
                        event.record_id = of("record_id");
                        event.merged_from_id = evt
                            .get("merged_from")
                            .and_then(|m| m.get("id"))
                            .and_then(|i| i.get("record_id"))
                            .map(|v| text(Some(v)));
                    }
                    out.push(event);
                }
                Ok((or_empty(payload.get("webhook_id")), out))
            }
            Self::HubSpot => {
                let events = payload.as_array().ok_or("events.map is not a function")?;
                let out = events
                    .iter()
                    .map(|event| {
                        let object = or_empty(event.get("objectTypeId"));
                        let subscription = or_empty(event.get("subscriptionType"));
                        let event_type = if subscription.contains("creation")
                            || subscription.contains(".created")
                        {
                            "record.created"
                        } else if subscription.contains("deletion")
                            || subscription.contains(".deleted")
                        {
                            "record.deleted"
                        } else {
                            "record.updated"
                        };
                        WebhookEvent {
                            event_type: event_type.to_owned(),
                            object_type: hubspot_slug(&object).unwrap_or("contacts").to_owned(),
                            object_id: object,
                            record_id: text(event.get("objectId")),
                            ..WebhookEvent::default()
                        }
                    })
                    .collect();
                Ok((String::new(), out))
            }
        }
    }

    /// `resolveObjectSlug(accessToken, objectId)`.
    async fn resolve_object_slug(
        self,
        http: Option<&OutboundHttp>,
        token: &str,
        object_id: &str,
    ) -> Result<String, String> {
        if self == Self::HubSpot {
            return Ok(hubspot_slug(object_id).map_or_else(|| object_id.to_owned(), str::to_owned));
        }
        if let Some(slug) = slug_cache()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(object_id)
        {
            return Ok(slug.clone());
        }
        let response = send(
            http,
            bearer(format!("{ATTIO_API_BASE}/objects/{object_id}"), token),
        )
        .await?;
        if !response.ok() {
            tracing::warn!(
                "[Attio] Failed to resolve object {object_id}: {}",
                response.status
            );
            return Ok(object_id.to_owned());
        }
        let result = json_of(&response)?.to_value();
        let slug = result
            .get("data")
            .and_then(|d| d.get("api_slug"))
            .map(|v| text(Some(v)))
            .ok_or("Cannot read properties of undefined (reading 'api_slug')")?;
        if !slug.is_empty() {
            slug_cache()
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(object_id.to_owned(), slug.clone());
        }
        Ok(slug)
    }

    /// `fetchRecord(accessToken, objectType, recordId)`.
    async fn fetch_record(
        self,
        http: Option<&OutboundHttp>,
        token: &str,
        slug: &str,
        record_id: &str,
    ) -> Result<ExternalRecord, String> {
        match self {
            Self::Attio => {
                let response = send(
                    http,
                    bearer(
                        format!("{ATTIO_API_BASE}/objects/{slug}/records/{record_id}"),
                        token,
                    ),
                )
                .await?;
                if !response.ok() {
                    return Err(format!(
                        "Attio API error {}: {}",
                        response.status,
                        response.text()
                    ));
                }
                let data = json_of(&response)?
                    .get("data")
                    .cloned()
                    .ok_or("Cannot read properties of undefined (reading 'id')")?;
                let value = data.to_value();
                Ok(ExternalRecord {
                    id: value
                        .get("id")
                        .and_then(|i| i.get("record_id"))
                        .map(|v| text(Some(v)))
                        .ok_or("Cannot read properties of undefined (reading 'record_id')")?,
                    data: value
                        .get("values")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                    raw: data,
                })
            }
            Self::HubSpot => {
                let query = String::from_utf8(form(&[("properties", hubspot_properties(slug))]))
                    .unwrap_or_default();
                let response = send(
                    http,
                    bearer(
                        format!("{HUBSPOT_API_BASE}/crm/v3/objects/{slug}/{record_id}?{query}"),
                        token,
                    ),
                )
                .await?;
                if !response.ok() {
                    return Err(format!("HubSpot fetch error {}", response.status));
                }
                let raw = json_of(&response)?;
                let value = raw.to_value();
                Ok(ExternalRecord {
                    id: text(value.get("id")),
                    data: value
                        .get("properties")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default(),
                    raw,
                })
            }
        }
    }

    /// `mapCompany(record)`'s `data`.
    fn map_company(self, record: &ExternalRecord) -> Map<String, Value> {
        let values = &record.data;
        let mut out = Map::new();
        match self {
            Self::Attio => {
                use super::adapters::attio_values as v;
                let name = or_value(v::company_name(values), "Unknown Company");
                out.insert("name".to_owned(), name.clone());
                out.insert("displayName".to_owned(), name);
                put(&mut out, "email", v::email(values));
                put(&mut out, "website", v::website(values));
                put(&mut out, "notes", v::description(values));
                put(&mut out, "tags", v::categories(values));
                out.insert("status".to_owned(), "active".into());
                out.insert("source".to_owned(), "attio".into());
            }
            Self::HubSpot => {
                let name = or_value(values.get("name").cloned(), "Unknown Company");
                out.insert("name".to_owned(), name.clone());
                out.insert("displayName".to_owned(), name);
                out.insert(
                    "email".to_owned(),
                    Value::String(format!("noemail-{}@placeholder.local", record.id)),
                );
                put(&mut out, "website", truthy_value(values.get("domain")));
                put(&mut out, "phone", truthy_value(values.get("phone")));
                put(&mut out, "notes", truthy_value(values.get("description")));
                out.insert("status".to_owned(), "active".into());
                out.insert("source".to_owned(), "hubspot".into());
            }
        }
        out
    }

    /// `mapPerson(record)`: the `data` and `parentCompanyExternalId`.
    fn map_person(self, record: &ExternalRecord) -> (Map<String, Value>, Option<String>) {
        let values = &record.data;
        let mut out = Map::new();
        match self {
            Self::Attio => {
                use super::adapters::attio_values as v;
                let (first, last, full) = v::person_name(values);
                let email = v::email(values);
                let joined = join_names(first.as_ref(), last.as_ref());
                let display = if truthy(full.as_ref()) {
                    full.clone().expect("truthy")
                } else if !joined.is_empty() {
                    Value::String(joined)
                } else if truthy(email.as_ref()) {
                    email.clone().expect("truthy")
                } else {
                    "Unknown".into()
                };
                out.insert("firstName".to_owned(), first.unwrap_or(Value::Null));
                out.insert("lastName".to_owned(), last.unwrap_or(Value::Null));
                out.insert("fullName".to_owned(), full.unwrap_or(Value::Null));
                out.insert("displayName".to_owned(), display);
                put(&mut out, "email", email);
                put(&mut out, "directPhone", v::phone(values));
                put(&mut out, "title", webhook_attr_value(values, "job_title"));
                out.insert("status".to_owned(), "active".into());
                out.insert("source".to_owned(), "attio".into());
                let parent = v::company_record_id(values).map(|p| text(Some(&p)));
                (out, parent)
            }
            Self::HubSpot => {
                let first = truthy_value(values.get("firstname"));
                let last = truthy_value(values.get("lastname"));
                let joined = join_names(first.as_ref(), last.as_ref());
                let full = (!joined.is_empty()).then_some(Value::String(joined));
                let email = truthy_value(values.get("email")).unwrap_or_else(|| {
                    Value::String(format!("noemail-{}@placeholder.local", record.id))
                });
                let display = full.clone().unwrap_or_else(|| email.clone());
                out.insert("firstName".to_owned(), first.unwrap_or(Value::Null));
                out.insert("lastName".to_owned(), last.unwrap_or(Value::Null));
                out.insert("fullName".to_owned(), full.unwrap_or(Value::Null));
                out.insert("displayName".to_owned(), display);
                out.insert("email".to_owned(), email);
                put(&mut out, "directPhone", truthy_value(values.get("phone")));
                put(&mut out, "title", truthy_value(values.get("jobtitle")));
                out.insert("status".to_owned(), "active".into());
                out.insert("source".to_owned(), "hubspot".into());
                (out, None)
            }
        }
    }
}

/// The webhook mapper's `getAttrValue(values, key)`.
fn webhook_attr_value(values: &Map<String, Value>, key: &str) -> Option<Value> {
    let Some(Value::Array(items)) = values.get(key) else {
        return None;
    };
    let item = items.first()?;
    if let Value::String(text) = item {
        return Some(Value::String(text.clone()));
    }
    match item.get("value") {
        Some(value) if !value.is_null() => {
            return Some(Value::String(weldsuite_core_domain::js::as_text(
                &Js::from_jsonb(value),
            )));
        }
        _ => {}
    }
    item.get("original").filter(|o| truthy(Some(o))).cloned()
}

/// `[a, b].filter(Boolean).join(' ')`.
fn join_names(a: Option<&Value>, b: Option<&Value>) -> String {
    [a, b]
        .into_iter()
        .filter(|v| truthy(*v))
        .map(text)
        .collect::<Vec<_>>()
        .join(" ")
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

/// `value || undefined`.
fn truthy_value(value: Option<&Value>) -> Option<Value> {
    value.filter(|v| truthy(Some(v))).cloned()
}

/// `value || fallback`.
fn or_value(value: Option<Value>, fallback: &str) -> Value {
    if truthy(value.as_ref()) {
        value.expect("truthy")
    } else {
        Value::String(fallback.to_owned())
    }
}

// ── lib/sync.ts ─────────────────────────────────────────────────────────────

/// `upsertCompany(db, connectionId, externalEntityType, externalEntityId, mapped, raw)`.
async fn upsert_company(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
    data: &Map<String, Value>,
    raw: &Js,
) -> Result<(UpsertAction, String), String> {
    let sum = checksum(raw);
    let mut values = data.clone();
    let name = match data.get("name") {
        Some(name) if !name.is_null() => name.clone(),
        _ => "Unknown Company".into(),
    };
    let display = match data.get("displayName") {
        Some(display) if !display.is_null() => display.clone(),
        _ => name.clone(),
    };
    values.insert("name".to_owned(), name);
    values.insert("displayName".to_owned(), display);
    upsert_by_mapping(
        db,
        connection_id,
        external_type,
        external_id,
        EntityTable::companies(),
        &Record::plain(values),
        &sum,
    )
    .await
}

/// `upsertPerson(db, connectionId, externalEntityId, mapped, parentCompanyId, raw)`.
async fn upsert_person(
    db: &PgPool,
    connection_id: &str,
    external_id: &str,
    data: &Map<String, Value>,
    parent_company_id: Option<&str>,
    raw: &Js,
) -> Result<(UpsertAction, String), String> {
    let sum = checksum(raw);
    let joined = join_names(data.get("firstName"), data.get("lastName"));
    let display = ["displayName", "fullName"]
        .iter()
        .find_map(|key| data.get(*key).filter(|v| truthy(Some(v))).cloned())
        .or_else(|| (!joined.is_empty()).then_some(Value::String(joined)))
        .or_else(|| data.get("email").filter(|v| truthy(Some(v))).cloned())
        .unwrap_or_else(|| "Unknown".into());
    let mut values = data.clone();
    values.insert("displayName".to_owned(), display);
    let (action, id) = upsert_by_mapping(
        db,
        connection_id,
        "person",
        external_id,
        EntityTable::people(),
        &Record::plain(values),
        &sum,
    )
    .await?;
    if let Some(company) = parent_company_id {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from person_companies where person_id = $1 and company_id = $2 limit 1",
        )
        .bind(&id)
        .bind(company)
        .fetch_optional(db)
        .await
        .map_err(|e| db_message(&e))?;
        if existing.is_none() {
            sqlx::query(
                "insert into person_companies (id, person_id, company_id, is_primary) values ($1, $2, $3, true)",
            )
            .bind(generate_id("pc"))
            .bind(&id)
            .bind(company)
            .execute(db)
            .await
            .map_err(|e| db_message(&e))?;
        }
    }
    Ok((action, id))
}

/// `update <table> set deleted_at = now, updated_at = now where id = $1`.
async fn soft_delete(db: &PgPool, table: &str, id: &str) -> Result<(), String> {
    let at = now();
    let query = match table {
        "companies" => {
            "update companies set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1"
        }
        "people" => {
            "update people set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1"
        }
        _ => {
            "update crm_activities set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1"
        }
    };
    sqlx::query(query)
        .bind(id)
        .bind(at)
        .execute(db)
        .await
        .map(|_| ())
        .map_err(|e| db_message(&e))
}

/// `softDeleteByMapping(db, connectionId, externalEntityType, externalEntityId)`.
async fn soft_delete_by_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
) -> Result<bool, String> {
    let Some(mapping) = find_mapping(db, connection_id, external_type, external_id).await? else {
        return Ok(false);
    };
    match mapping.internal_entity_type.as_str() {
        "company" => soft_delete(db, "companies", &mapping.internal_entity_id).await?,
        "person" => soft_delete(db, "people", &mapping.internal_entity_id).await?,
        _ => {}
    }
    Ok(true)
}

/// `softDeleteNote` / `softDeleteTask`: the activity behind the mapping.
async fn soft_delete_activity(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
) -> Result<bool, String> {
    let Some(mapping) = find_mapping(db, connection_id, external_type, external_id).await? else {
        return Ok(false);
    };
    soft_delete(db, "crm_activities", &mapping.internal_entity_id).await?;
    Ok(true)
}

/// `resolveEntityByExternalId(db, connectionId, externalRecordId)`.
async fn resolve_entity(
    db: &PgPool,
    connection_id: &str,
    external_id: &str,
) -> Result<Option<(String, String)>, String> {
    sqlx::query_as(
        "select internal_entity_id, internal_entity_type from integration_entity_mappings
         where connection_id = $1 and external_entity_id = $2 limit 1",
    )
    .bind(connection_id)
    .bind(external_id)
    .fetch_optional(db)
    .await
    .map_err(|e| db_message(&e))
}

/// The parent/linked record's columns on an activity.
fn link_activity(data: &mut Map<String, Value>, entity: Option<&(String, String)>) {
    match entity {
        Some((id, kind)) if kind == "company" => {
            data.insert("counterpartyId".to_owned(), id.clone().into());
            data.insert("relatedTo".to_owned(), "company".into());
            data.insert("relatedToId".to_owned(), id.clone().into());
        }
        Some((id, kind)) if kind == "person" => {
            data.insert("personId".to_owned(), id.clone().into());
            data.insert("relatedTo".to_owned(), "person".into());
            data.insert("relatedToId".to_owned(), id.clone().into());
        }
        _ => {}
    }
}

/// `upsertNote` / `upsertTask`: the activity behind an `external_type`
/// mapping, created or updated (`skipped` on an unchanged checksum).
async fn upsert_activity(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
    record: &Record,
    raw: &Js,
) -> Result<(UpsertAction, String), String> {
    let sum = checksum(raw);
    let activities = EntityTable::of("activity")?;
    if let Some(mapping) = find_mapping(db, connection_id, external_type, external_id).await? {
        if mapping.sync_checksum.as_deref() == Some(sum.as_str()) {
            return Ok((UpsertAction::Skipped, mapping.internal_entity_id));
        }
        update_row(db, activities, &mapping.internal_entity_id, record).await?;
        touch_mapping(db, &mapping.id, &sum).await?;
        return Ok((UpsertAction::Updated, mapping.internal_entity_id));
    }
    let id = generate_id("act");
    insert_row(db, activities, &id, record).await?;
    insert_mapping(
        db,
        connection_id,
        external_type,
        external_id,
        "activity",
        &id,
        Some(&sum),
    )
    .await?;
    Ok((UpsertAction::Created, id))
}

/// `text.substring(0, n)` in UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut count = 0;
    let mut out = String::new();
    for c in text.chars() {
        count += c.len_utf16();
        if count > units {
            break;
        }
        out.push(c);
    }
    out
}

/// What a webhook handler works with.
struct EventCtx<'a> {
    state: &'a IntegrationsState,
    db: &'a PgPool,
    http: Option<&'a OutboundHttp>,
    provider: Provider,
    token: &'a str,
    connection_id: &'a str,
    workspace_id: &'a str,
}

/// `emitCrmEvent(...)`: `company` / `person` created or updated.
fn emit(ctx: &EventCtx<'_>, kind: &str, action: UpsertAction, id: &str, data: &Map<String, Value>) {
    let event = match (kind, action) {
        (_, UpsertAction::Skipped) => return,
        ("company", UpsertAction::Created) => events::COMPANY_CREATED,
        ("company", _) => events::COMPANY_UPDATED,
        (_, UpsertAction::Created) => events::PERSON_CREATED,
        _ => events::PERSON_UPDATED,
    };
    let context = EventContext::new(ctx.workspace_id, "system", EventSource::System);
    publish_entity_event(
        &ctx.state.events,
        &context,
        event,
        id,
        &Value::Object(data.clone()),
    );
}

#[derive(Debug, Default)]
struct Counters {
    companies: i32,
    people: i32,
    tasks: i32,
    list_entries: i32,
}

fn api_error(response: &weldsuite_ports::HttpResponse, what: &str) -> String {
    format!(
        "Attio {what} API error {}: {}",
        response.status,
        response.text()
    )
}

async fn note_event(ctx: &EventCtx<'_>, event: &WebhookEvent) -> Result<(), String> {
    if event.event_type == "note.deleted" {
        if !event.note_id.is_empty() {
            soft_delete_activity(ctx.db, ctx.connection_id, "note", &event.note_id).await?;
        }
        return Ok(());
    }
    if event.note_id.is_empty() {
        tracing::warn!("[Webhook] Note event missing noteId, skipping");
        return Ok(());
    }
    let note = match ctx.provider {
        Provider::Attio => {
            let response = send(
                ctx.http,
                bearer(
                    format!("{ATTIO_API_BASE}/notes/{}", event.note_id),
                    ctx.token,
                ),
            )
            .await?;
            if !response.ok() {
                return Err(api_error(&response, "notes"));
            }
            json_of(&response)?
                .get("data")
                .cloned()
                .ok_or("Cannot read properties of undefined (reading 'id')")?
        }
        Provider::HubSpot => return Err("HubSpot notes are not synced via webhooks".to_owned()),
    };
    let value = note.to_value();
    let note_id = value
        .get("id")
        .and_then(|i| i.get("note_id"))
        .map_or_else(|| "undefined".to_owned(), |v| text(Some(v)));
    let parent = value.get("parent_record_id").filter(|v| truthy(Some(v)));
    let parent = match parent {
        Some(parent) => resolve_entity(ctx.db, ctx.connection_id, &text(Some(parent))).await?,
        None => None,
    };
    let mut data = Map::new();
    data.insert("type".to_owned(), "note".into());
    data.insert(
        "subject".to_owned(),
        or_value(value.get("title").cloned(), "Untitled Note"),
    );
    data.insert(
        "description".to_owned(),
        value
            .get("content_plaintext")
            .filter(|v| truthy(Some(v)))
            .cloned()
            .unwrap_or_else(|| "".into()),
    );
    data.insert("status".to_owned(), "completed".into());
    data.insert("assignedToId".to_owned(), "system".into());
    data.insert("source".to_owned(), "attio".into());
    link_activity(&mut data, parent.as_ref());
    upsert_activity(
        ctx.db,
        ctx.connection_id,
        "note",
        &note_id,
        &Record::plain(data),
        &note,
    )
    .await?;
    Ok(())
}

async fn task_event(ctx: &EventCtx<'_>, event: &WebhookEvent) -> Result<bool, String> {
    if event.event_type == "task.deleted" {
        if !event.task_id.is_empty() {
            soft_delete_activity(ctx.db, ctx.connection_id, "task", &event.task_id).await?;
        }
        return Ok(false);
    }
    if event.task_id.is_empty() {
        tracing::warn!("[Webhook] Task event missing taskId, skipping");
        return Ok(false);
    }
    let task = match ctx.provider {
        Provider::Attio => {
            let response = send(
                ctx.http,
                bearer(
                    format!("{ATTIO_API_BASE}/tasks/{}", event.task_id),
                    ctx.token,
                ),
            )
            .await?;
            if !response.ok() {
                return Err(api_error(&response, "tasks"));
            }
            json_of(&response)?
                .get("data")
                .cloned()
                .ok_or("Cannot read properties of undefined (reading 'id')")?
        }
        Provider::HubSpot => return Err("HubSpot tasks are not synced via webhooks".to_owned()),
    };
    let value = task.to_value();
    let task_id = value
        .get("id")
        .and_then(|i| i.get("task_id"))
        .map_or_else(|| "undefined".to_owned(), |v| text(Some(v)));
    let linked = value
        .get("linked_records")
        .and_then(Value::as_array)
        .and_then(|l| l.first())
        .map(|first| text(first.get("target_record_id")));
    let linked = match linked {
        Some(id) => resolve_entity(ctx.db, ctx.connection_id, &id).await?,
        None => None,
    };
    let content = value
        .get("content")
        .filter(|v| truthy(Some(v)))
        .map(|v| text(Some(v)))
        .unwrap_or_default();
    let subject = if content.encode_utf16().count() > 255 {
        format!("{}...", utf16_prefix(&content, 252))
    } else {
        content.clone()
    };
    let mut record = Record::default();
    let data = &mut record.values;
    data.insert("type".to_owned(), "task".into());
    data.insert(
        "subject".to_owned(),
        if subject.is_empty() {
            "Untitled Task".into()
        } else {
            subject.into()
        },
    );
    data.insert("description".to_owned(), content.into());
    data.insert(
        "status".to_owned(),
        if truthy(value.get("is_completed")) {
            "completed"
        } else {
            "planned"
        }
        .into(),
    );
    data.insert("priority".to_owned(), "medium".into());
    data.insert("assignedToId".to_owned(), "system".into());
    data.insert("source".to_owned(), "attio".into());
    let deadline = value.get("deadline_at").filter(|v| truthy(Some(v)));
    if deadline.is_some() {
        record.set_date("dueDate", deadline);
    }
    link_activity(&mut record.values, linked.as_ref());
    upsert_activity(ctx.db, ctx.connection_id, "task", &task_id, &record, &task).await?;
    Ok(true)
}

async fn list_entry_event(ctx: &EventCtx<'_>, event: &WebhookEvent) -> Result<bool, String> {
    let db = ctx.db;
    if event.event_type == "list-entry.deleted" {
        if !event.list_entry_id.is_empty()
            && let Some(mapping) =
                find_mapping(db, ctx.connection_id, "list-entry", &event.list_entry_id).await?
        {
            for query in [
                "delete from list_members where id = $1",
                "delete from integration_entity_mappings where id = $1",
            ] {
                let id = if query.contains("list_members") {
                    &mapping.internal_entity_id
                } else {
                    &mapping.id
                };
                sqlx::query(query)
                    .bind(id)
                    .execute(db)
                    .await
                    .map_err(|e| db_message(&e))?;
            }
        }
        return Ok(false);
    }
    if event.list_entry_id.is_empty() || event.list_id.is_empty() {
        tracing::warn!("[Webhook] List-entry event missing entryId or listId, skipping");
        return Ok(false);
    }
    if ctx.provider == Provider::HubSpot {
        return Err("HubSpot list entries are not synced via webhooks".to_owned());
    }
    let response = send(
        ctx.http,
        bearer(
            format!(
                "{ATTIO_API_BASE}/lists/{}/entries/{}",
                event.list_id, event.list_entry_id
            ),
            ctx.token,
        ),
    )
    .await?;
    if !response.ok() {
        return Err(api_error(&response, "list entry"));
    }
    let entry = json_of(&response)?
        .get("data")
        .cloned()
        .ok_or("Cannot read properties of undefined (reading 'id')")?
        .to_value();
    let entry_id = text(entry.get("id").and_then(|i| i.get("entry_id")));
    let list_id = text(entry.get("id").and_then(|i| i.get("list_id")));
    let parent = text(entry.get("parent_record_id"));
    let resolved = resolve_entity(db, ctx.connection_id, &parent).await?;
    let Some((company_id, kind)) = resolved else {
        tracing::warn!("[Webhook] List entry parent record not found or not a company: {parent}");
        return Ok(false);
    };
    if kind != "company" {
        tracing::warn!("[Webhook] List entry parent record not found or not a company: {parent}");
        return Ok(false);
    }

    // The list's name.
    let response = send(
        ctx.http,
        bearer(format!("{ATTIO_API_BASE}/lists"), ctx.token),
    )
    .await?;
    if !response.ok() {
        return Err(api_error(&response, "lists"));
    }
    let lists = json_of(&response)?.to_value();
    let lists = lists
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Cannot read properties of undefined (reading 'map')")?;
    let name = lists
        .iter()
        .find(|l| text(l.get("id").and_then(|i| i.get("list_id"))) == list_id)
        .and_then(|l| l.get("name"))
        .filter(|n| truthy(Some(n)))
        .map_or_else(|| "Unknown List".to_owned(), |n| text(Some(n)));

    // `upsertListAndEntry`.
    #[allow(clippy::single_match_else)] // `if (listMapping) … else …`, kept as one expression
    let internal_list = match find_mapping(db, ctx.connection_id, "list", &list_id).await? {
        Some(mapping) => {
            sqlx::query("update lists set name = $2, updated_at = $3::timestamp where id = $1")
                .bind(&mapping.internal_entity_id)
                .bind(&name)
                .bind(now())
                .execute(db)
                .await
                .map_err(|e| db_message(&e))?;
            mapping.internal_entity_id
        }
        None => {
            let id = generate_id("list");
            sqlx::query(
                "insert into lists (id, name, kind, type) values ($1, $2, 'company', 'static')",
            )
            .bind(&id)
            .bind(&name)
            .execute(db)
            .await
            .map_err(|e| db_message(&e))?;
            insert_mapping(db, ctx.connection_id, "list", &list_id, "list", &id, None).await?;
            id
        }
    };
    let member: Option<String> = sqlx::query_scalar(
        "select id from list_members where list_id = $1 and entity_id = $2 limit 1",
    )
    .bind(&internal_list)
    .bind(&company_id)
    .fetch_optional(db)
    .await
    .map_err(|e| db_message(&e))?;
    if let Some(member) = member {
        if find_mapping(db, ctx.connection_id, "list-entry", &entry_id)
            .await?
            .is_none()
        {
            insert_mapping(
                db,
                ctx.connection_id,
                "list-entry",
                &entry_id,
                "list-member",
                &member,
                None,
            )
            .await?;
        }
        return Ok(true);
    }
    let member = generate_id("lm");
    sqlx::query("insert into list_members (id, list_id, entity_id) values ($1, $2, $3)")
        .bind(&member)
        .bind(&internal_list)
        .bind(&company_id)
        .execute(db)
        .await
        .map_err(|e| db_message(&e))?;
    insert_mapping(
        db,
        ctx.connection_id,
        "list-entry",
        &entry_id,
        "list-member",
        &member,
        None,
    )
    .await?;
    Ok(true)
}

/// `handleAttioRecordEvent`: which kind of record was upserted, if any.
async fn record_event(
    ctx: &EventCtx<'_>,
    event: &WebhookEvent,
) -> Result<Option<&'static str>, String> {
    let slug = ctx
        .provider
        .resolve_object_slug(ctx.http, ctx.token, &event.object_id)
        .await?;
    let external_type = if slug == "companies" {
        "company"
    } else {
        "person"
    };
    if event.event_type == "record.deleted" {
        soft_delete_by_mapping(ctx.db, ctx.connection_id, external_type, &event.record_id).await?;
        return Ok(None);
    }
    let record = ctx
        .provider
        .fetch_record(ctx.http, ctx.token, &slug, &event.record_id)
        .await?;
    match slug.as_str() {
        "companies" => {
            let data = ctx.provider.map_company(&record);
            let (action, id) = upsert_company(
                ctx.db,
                ctx.connection_id,
                "company",
                &record.id,
                &data,
                &record.raw,
            )
            .await?;
            emit(ctx, "company", action, &id, &data);
        }
        "people" => {
            let (data, parent) = ctx.provider.map_person(&record);
            let parent_company = match parent.filter(|p| !p.is_empty()) {
                Some(parent) => find_mapping(ctx.db, ctx.connection_id, "company", &parent)
                    .await?
                    .map(|m| m.internal_entity_id),
                None => None,
            };
            let (action, id) = upsert_person(
                ctx.db,
                ctx.connection_id,
                &record.id,
                &data,
                parent_company.as_deref(),
                &record.raw,
            )
            .await?;
            emit(ctx, "person", action, &id, &data);
        }
        other => {
            tracing::warn!("[Webhook] Skipping unknown object type: {other}");
            return Ok(None);
        }
    }
    if event.event_type == "record.merged"
        && let Some(from) = event.merged_from_id.as_deref().filter(|f| !f.is_empty())
    {
        soft_delete_by_mapping(ctx.db, ctx.connection_id, external_type, from).await?;
    }
    Ok(Some(external_type))
}

async fn process_event(
    ctx: &EventCtx<'_>,
    event: &WebhookEvent,
    counters: &mut Counters,
) -> Result<(), String> {
    if event.event_type.starts_with("note.") {
        return note_event(ctx, event).await;
    }
    if event.event_type.starts_with("task.") {
        if task_event(ctx, event).await? {
            counters.tasks += 1;
        }
        return Ok(());
    }
    if event.event_type.starts_with("list-entry.") {
        if list_entry_event(ctx, event).await? {
            counters.list_entries += 1;
        }
        return Ok(());
    }
    match record_event(ctx, event).await? {
        Some("company") => counters.companies += 1,
        Some(_) => counters.people += 1,
        None => {}
    }
    Ok(())
}

/// `updateAttioConnectionStats`: the processed counts added to the totals.
async fn add_stats(db: &PgPool, connection_id: &str, c: &Counters) -> Result<(), String> {
    if c.companies == 0 && c.people == 0 && c.tasks == 0 && c.list_entries == 0 {
        return Ok(());
    }
    sqlx::query(
        "update integration_connections set updated_at = $2::timestamp,
            companies_synced = companies_synced + $3, people_synced = people_synced + $4,
            tasks_synced = tasks_synced + $5, lists_synced = lists_synced + $6
         where id = $1",
    )
    .bind(connection_id)
    .bind(now())
    .bind(c.companies)
    .bind(c.people)
    .bind(c.tasks)
    .bind(c.list_entries)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| db_message(&e))
}

/// `getValidAccessToken(db, connection, env)`: the token, refreshed and
/// stored first when it is (about to be) expired.
async fn valid_access_token(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    db: &PgPool,
    connection_id: &str,
    provider: &str,
    tokens: &Value,
) -> Result<String, String> {
    let access = tokens.get("accessToken");
    if !truthy(access) {
        return Err(format!("No access token for connection {connection_id}"));
    }
    let access = text(access);
    let expires = tokens
        .get("expiresAt")
        .filter(|v| truthy(Some(v)))
        .map(|v| text(Some(v)));
    let needs = match expires {
        Some(at) => millis_of(&at).is_some_and(|ms| ms - EXPIRY_BUFFER_MS < now_millis()),
        None => false,
    };
    if !needs {
        return Ok(access);
    }
    let refresh = tokens.get("refreshToken").filter(|v| truthy(Some(v)));
    let Some(refresh) = refresh.map(|v| text(Some(v))) else {
        tracing::warn!(
            "[Token] {connection_id} token expired but no refresh token — using stale token"
        );
        return Ok(access);
    };
    let upper = provider.to_uppercase();
    let url = match provider {
        "attio" => "https://app.attio.com/oauth/token",
        "hubspot" => "https://api.hubapi.com/oauth/v1/token",
        _ => "",
    };
    let id = ctx
        .env(state, &format!("{upper}_CLIENT_ID"))
        .filter(|v| !v.is_empty());
    let secret = ctx
        .env(state, &format!("{upper}_CLIENT_SECRET"))
        .filter(|v| !v.is_empty());
    let (Some(id), Some(secret)) = (id, secret) else {
        tracing::warn!(
            "[Token] No refresh config/credentials for provider {provider} — using stale token"
        );
        return Ok(access);
    };
    if url.is_empty() {
        tracing::warn!(
            "[Token] No refresh config/credentials for provider {provider} — using stale token"
        );
        return Ok(access);
    }
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: url.to_owned(),
        headers: vec![(
            "Content-Type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        )],
        body: Some(form(&[
            ("client_id", &id),
            ("client_secret", &secret),
            ("refresh_token", &refresh),
            ("grant_type", "refresh_token"),
        ])),
    };
    let http = ctx.http(state);
    let response = match send(http.as_ref(), request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!("[Token] Refresh request failed for {connection_id}: {error}");
            return Ok(access);
        }
    };
    if !response.ok() {
        tracing::error!(
            "[Token] Refresh failed for {connection_id} ({}): {}",
            response.status,
            response.text()
        );
        return Ok(access);
    }
    let data = json_of(&response)?.to_value();
    let mut fresh = Map::new();
    put(&mut fresh, "accessToken", data.get("access_token").cloned());
    put(
        &mut fresh,
        "refreshToken",
        truthy_value(data.get("refresh_token")).or_else(|| Some(Value::String(refresh.clone()))),
    );
    if let Some(seconds) = data
        .get("expires_in")
        .filter(|v| truthy(Some(v)))
        .and_then(Value::as_f64)
    {
        #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
        let at = now_millis() as f64 + seconds * 1000.0;
        if at.is_finite() {
            #[allow(clippy::cast_possible_truncation)]
            fresh.insert(
                "expiresAt".to_owned(),
                super::iso_of_millis(at as i64).into(),
            );
        }
    }
    put(
        &mut fresh,
        "tokenType",
        truthy_value(data.get("token_type"))
            .or_else(|| truthy_value(tokens.get("tokenType")))
            .or_else(|| Some("Bearer".into())),
    );
    sqlx::query(
        "update integration_connections set oauth_tokens = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(connection_id)
    .bind(Value::Object(fresh.clone()))
    .bind(now())
    .execute(db)
    .await
    .map_err(|e| db_message(&e))?;
    tracing::info!("[Token] Refreshed access token for connection {connection_id}");
    Ok(text(fresh.get("accessToken")))
}

/// The live connection's `(provider, webhook_secret, oauth_tokens)`.
async fn load_connection(
    db: &PgPool,
    id: &str,
) -> Result<Option<(String, Option<String>, Option<Value>)>, String> {
    sqlx::query_as(
        "select provider, webhook_secret, oauth_tokens from integration_connections
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
    .map_err(|e| db_message(&e))
}

/// `WORKSPACE_CACHE.get(key, 'json')`.
async fn kv_json(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    key: &str,
) -> Result<Option<Value>, String> {
    let Some(cache) = ctx.cache(state) else {
        return Ok(None);
    };
    match cache.get_boxed(key).await.map_err(|e| e.to_string())? {
        None => Ok(None),
        Some(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// `{ workspaceId, provider }` of `intconn:<id>`.
async fn connection_entry(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    connection_id: &str,
) -> Result<Option<(String, String)>, String> {
    let entry = kv_json(ctx, state, &format!("intconn:{connection_id}")).await?;
    Ok(entry
        .filter(|e| truthy(Some(e)))
        .map(|e| (text(e.get("workspaceId")), text(e.get("provider")))))
}

/// Why a handler stopped early.
enum Stop {
    Thrown(String),
}

impl From<String> for Stop {
    fn from(message: String) -> Self {
        Self::Thrown(message)
    }
}

async fn connection_webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle_connection_webhook(&state, &ctx, &connection_id, &headers, &body).await {
        Ok(response) => response,
        Err(Stop::Thrown(message)) => {
            tracing::error!("[Webhook] Processing error: {message}");
            error(StatusCode::INTERNAL_SERVER_ERROR, &message)
        }
    }
}

async fn handle_connection_webhook(
    state: &IntegrationsState,
    ctx: &PublicCtx,
    connection_id: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response, Stop> {
    let Some((workspace_id, provider_name)) = connection_entry(ctx, state, connection_id).await?
    else {
        tracing::warn!("[Webhook] No KV entry for connection: {connection_id}");
        return Ok(error(StatusCode::NOT_FOUND, "Connection not found"));
    };
    let Some(provider) = Provider::for_name(&provider_name) else {
        tracing::error!("[Webhook] Unknown provider: {provider_name}");
        return Ok(error(StatusCode::BAD_REQUEST, "Unknown provider"));
    };
    let db = ctx.tenant_db(state, &workspace_id).await?;
    let Some((_, secret, tokens)) = load_connection(&db, connection_id).await? else {
        tracing::warn!("[Webhook] Connection not found in DB: {connection_id}");
        return Ok(error(StatusCode::NOT_FOUND, "Connection not found"));
    };
    if let Some(secret) = secret.as_deref().filter(|s| !s.is_empty())
        && !provider.verify(body, headers, secret)
    {
        tracing::warn!("[Webhook] Invalid signature for connection: {connection_id}");
        return Ok(error(StatusCode::UNAUTHORIZED, "Invalid signature"));
    }
    let (webhook_id, events) = provider.parse(body)?;
    tracing::info!(
        "[Webhook] Parsed {} event(s) from webhook {webhook_id}",
        events.len()
    );
    let tokens = tokens.unwrap_or(Value::Null);
    let token = match valid_access_token(ctx, state, &db, connection_id, &provider_name, &tokens)
        .await
    {
        Ok(token) => token,
        Err(message) => {
            tracing::error!("[Webhook] No access token for connection: {connection_id} {message}");
            return Ok(error(StatusCode::INTERNAL_SERVER_ERROR, "No access token"));
        }
    };
    let http = ctx.http(state);
    let event_ctx = EventCtx {
        state,
        db: &db,
        http: http.as_ref(),
        provider,
        token: &token,
        connection_id,
        workspace_id: &workspace_id,
    };
    let mut counters = Counters::default();
    for event in &events {
        process_event(&event_ctx, event, &mut counters).await?;
    }
    add_stats(&db, connection_id, &counters).await?;
    Ok(answer(
        StatusCode::OK,
        json!({ "status": "ok", "processed": events.len() }),
    ))
}

/// `extractPortalId(body)`: the first event's `portalId`, when truthy.
fn portal_id(body: &[u8]) -> Option<Value> {
    let events: Value = serde_json::from_slice(body).ok()?;
    let first = events.as_array()?.first()?;
    first.get("portalId").filter(|p| truthy(Some(p))).cloned()
}

/// `String(portalId)`.
fn portal_text(portal: &Value) -> String {
    match portal {
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), number_text),
        other => text(Some(other)),
    }
}

/// `findHubspotConnectionByPortal`: KV first, then every workspace's
/// database (the hit cached for 30 days).
async fn hubspot_target(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    portal: &str,
    key: &str,
) -> Result<Option<(String, String)>, String> {
    if let Some(cached) = kv_json(ctx, state, key).await?.filter(|c| truthy(Some(c))) {
        return Ok(Some((
            text(cached.get("workspaceId")),
            text(cached.get("connectionId")),
        )));
    }
    let Some(master) = ctx.master(state) else {
        return Err("Neither DATABASE_URL_MASTER nor HYPERDRIVE_MASTER is configured".to_owned());
    };
    let workspaces: Vec<String> = sqlx::query_scalar("select id from workspaces")
        .fetch_all(&master)
        .await
        .map_err(|e| db_message(&e))?;
    for workspace in workspaces {
        let Ok(db) = ctx.tenant_db(state, &workspace).await else {
            continue;
        };
        let found: Result<Option<String>, _> = sqlx::query_scalar(
            "select id from integration_connections
             where provider = 'hubspot' and external_account_id = $1 and deleted_at is null limit 1",
        )
        .bind(portal)
        .fetch_optional(&db)
        .await;
        if let Ok(Some(connection)) = found {
            if let Some(cache) = ctx.cache(state) {
                let value = format!(
                    "{{\"workspaceId\":{},\"connectionId\":{}}}",
                    serde_json::to_string(&workspace).unwrap_or_default(),
                    serde_json::to_string(&connection).unwrap_or_default()
                );
                if let Err(error) = cache.put_boxed(key, &value, Some(PORTAL_TTL)).await {
                    // The scan's catch swallows it, and the next workspace is tried.
                    tracing::warn!(%error, "[Webhook/HubSpot] caching the portal failed");
                    continue;
                }
            }
            return Ok(Some((workspace, connection)));
        }
    }
    Ok(None)
}

/// `processHubspotEvent`: whether the event was applied.
async fn hubspot_event(ctx: &EventCtx<'_>, event: &WebhookEvent) -> Result<bool, String> {
    let entity_type = match event.object_id.as_str() {
        "0-1" | "contact" => "person",
        "0-2" | "company" => "company",
        "0-3" | "deal" => "opportunity",
        _ => return Ok(false),
    };
    if event.event_type == "record.deleted" {
        soft_delete_by_mapping(
            ctx.db,
            ctx.connection_id,
            &event.object_type,
            &event.record_id,
        )
        .await?;
        return Ok(true);
    }
    // `fetchEntityGeneric`'s slugs are the sync engine's entity types, so
    // only deals are fetched.
    if entity_type != "opportunity" {
        return Err(format!(
            "Unsupported entity type for HubSpot: {entity_type}"
        ));
    }
    let query =
        String::from_utf8(form(&[("properties", hubspot_properties("deals"))])).unwrap_or_default();
    let response = send(
        ctx.http,
        bearer(
            format!(
                "{HUBSPOT_API_BASE}/crm/v3/objects/deals/{}?{query}",
                event.record_id
            ),
            ctx.token,
        ),
    )
    .await?;
    if !response.ok() {
        return Err(format!(
            "HubSpot fetch error {}: {}",
            response.status,
            response.text()
        ));
    }
    let _ = hubspot_entity(json_of(&response)?);
    Ok(true)
}

async fn hubspot_webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle_hubspot(&state, &ctx, &headers, &body).await {
        Ok(response) => response,
        Err(Stop::Thrown(message)) => {
            tracing::error!("[Webhook/HubSpot] Handler error: {message}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

async fn handle_hubspot(
    state: &IntegrationsState,
    ctx: &PublicCtx,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response, Stop> {
    let Some(portal) = portal_id(body) else {
        tracing::warn!("[Webhook/HubSpot] No portalId in payload");
        return Ok(error(StatusCode::BAD_REQUEST, "No portalId in payload"));
    };
    let portal = portal_text(&portal);
    let key = format!("hubspot_portal:{portal}");
    let Some((workspace_id, connection_id)) = hubspot_target(ctx, state, &portal, &key).await?
    else {
        tracing::warn!("[Webhook/HubSpot] No connection for portalId: {portal}");
        return Ok(error(StatusCode::NOT_FOUND, "Portal not connected"));
    };
    let db = ctx.tenant_db(state, &workspace_id).await?;
    let Some((_, secret, tokens)) = load_connection(&db, &connection_id).await? else {
        if let Some(cache) = ctx.cache(state) {
            cache.delete_boxed(&key).await.map_err(|e| e.to_string())?;
        }
        return Ok(error(StatusCode::NOT_FOUND, "Connection not found"));
    };
    if let Some(secret) = secret.as_deref().filter(|s| !s.is_empty())
        && !Provider::HubSpot.verify(body, headers, secret)
    {
        tracing::warn!("[Webhook/HubSpot] Invalid signature for portal {portal}");
        return Ok(error(StatusCode::UNAUTHORIZED, "Invalid signature"));
    }
    let tokens = tokens.unwrap_or(Value::Null);
    let Ok(token) = valid_access_token(ctx, state, &db, &connection_id, "hubspot", &tokens).await
    else {
        return Ok(error(StatusCode::INTERNAL_SERVER_ERROR, "No access token"));
    };
    let (_, events) = Provider::HubSpot.parse(body)?;
    let http = ctx.http(state);
    let event_ctx = EventCtx {
        state,
        db: &db,
        http: http.as_ref(),
        provider: Provider::HubSpot,
        token: &token,
        connection_id: &connection_id,
        workspace_id: &workspace_id,
    };
    let mut processed = 0;
    for event in &events {
        match hubspot_event(&event_ctx, event).await {
            Ok(true) => processed += 1,
            Ok(false) => {}
            Err(message) => tracing::error!(
                "[Webhook/HubSpot] Failed to process event {}: {message}",
                event.record_id
            ),
        }
    }
    Ok(answer(
        StatusCode::OK,
        json!({ "received": true, "processed": processed }),
    ))
}

async fn gcal_webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    match handle_gcal(&state, &ctx, &connection_id, &headers).await {
        Ok(response) => response,
        Err(Stop::Thrown(message)) => {
            tracing::error!("[Webhook/GoogleCalendar] Handler error: {message}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

async fn handle_gcal(
    state: &IntegrationsState,
    ctx: &PublicCtx,
    connection_id: &str,
    headers: &HeaderMap,
) -> Result<Response, Stop> {
    let resource_state = headers
        .get("x-goog-resource-state")
        .and_then(|v| v.to_str().ok());
    let channel_token = headers
        .get("x-goog-channel-token")
        .and_then(|v| v.to_str().ok());
    if resource_state == Some("sync") {
        return Ok(answer(
            StatusCode::OK,
            json!({ "status": "ok", "type": "sync_handshake" }),
        ));
    }
    let Some((workspace_id, _)) = connection_entry(ctx, state, connection_id).await? else {
        tracing::warn!("[Webhook/GoogleCalendar] No KV entry for connection: {connection_id}");
        return Ok(error(StatusCode::NOT_FOUND, "Connection not found"));
    };
    let db = ctx.tenant_db(state, &workspace_id).await?;
    let Some((_, secret, _)) = load_connection(&db, connection_id).await? else {
        return Ok(error(StatusCode::NOT_FOUND, "Connection not found"));
    };
    // `isValidGcalChannelToken`: an unparsable stored secret is tolerated.
    if let (Some(secret), Some(token)) = (
        secret.as_deref().filter(|s| !s.is_empty()),
        channel_token.filter(|t| !t.is_empty()),
    ) && let Ok(parsed) = serde_json::from_str::<Value>(secret)
        // `null.token` throws, and the catch lets the notification through.
        && !parsed.is_null()
    {
        let expected = parsed
            .get("token")
            .filter(|t| !t.is_null())
            .map(|t| text(Some(t)));
        if !secret_matches(Some(token), expected.as_deref()) {
            tracing::warn!("[Webhook/GoogleCalendar] Invalid channel token for {connection_id}");
            return Ok(error(StatusCode::UNAUTHORIZED, "Invalid token"));
        }
    }
    if resource_state == Some("exists") {
        tracing::info!(
            "[Webhook/GoogleCalendar] Change notification for {connection_id}, triggering incremental sync"
        );
        match ctx.connect_internal(state) {
            None => tracing::warn!(
                "[Webhook/GoogleCalendar] CONNECT_INTERNAL / APP_API service binding not available"
            ),
            Some(binding) => {
                let call = ConnectCall::post(
                    format!("/api/integrations/connections/{connection_id}/sync"),
                    "X-Internal-Workspace-Id",
                    &workspace_id,
                    Some(r#"{"syncType":"incremental"}"#.to_owned()),
                );
                let response = binding.fetch(call).await?;
                if !response.ok() {
                    tracing::error!(
                        "[Webhook/GoogleCalendar] Sync trigger failed: {}",
                        response.status
                    );
                }
            }
        }
    }
    Ok(answer(
        StatusCode::OK,
        json!({ "status": "ok", "type": "sync_triggered" }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attio_signatures_are_hex_hmacs() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "attio-signature",
            hmac_hex("s", b"{}").parse().expect("header"),
        );
        assert!(Provider::Attio.verify(b"{}", &headers, "s"));
        assert!(!Provider::Attio.verify(b"{ }", &headers, "s"));
        assert!(!Provider::Attio.verify(b"{}", &HeaderMap::new(), "s"));
    }

    #[test]
    fn hubspot_signatures_hash_the_secret_and_body() {
        let mut headers = HeaderMap::new();
        let sum = hex::encode(Sha256::digest(b"s[]"));
        headers.insert("x-hubspot-signature", sum.parse().expect("header"));
        assert!(Provider::HubSpot.verify(b"[]", &headers, "s"));
    }

    #[test]
    fn attio_events_parse_by_kind() {
        let body = br#"{"webhook_id":"w","events":[
            {"event_type":"record.merged","id":{"object_id":"o","record_id":"r"},"merged_from":{"id":{"record_id":"m"}}},
            {"event_type":"note.created","id":{"note_id":"n"}},
            {"event_type":"list-entry.deleted","id":{"entry_id":"e","list_id":"l"}}]}"#;
        let (id, events) = Provider::Attio.parse(body).expect("parses");
        assert_eq!(id, "w");
        assert_eq!(events[0].merged_from_id.as_deref(), Some("m"));
        assert_eq!(events[1].note_id, "n");
        assert_eq!(
            (events[2].list_entry_id.as_str(), events[2].list_id.as_str()),
            ("e", "l")
        );
    }

    #[test]
    fn hubspot_events_parse_and_find_the_portal() {
        let body = br#"[{"portalId":62515,"objectId":7,"objectTypeId":"0-3","subscriptionType":"deal.creation"}]"#;
        assert_eq!(
            portal_id(body).map(|p| portal_text(&p)).as_deref(),
            Some("62515")
        );
        let (_, events) = Provider::HubSpot.parse(body).expect("parses");
        assert_eq!(events[0].event_type, "record.created");
        assert_eq!(events[0].object_type, "deals");
        assert_eq!(events[0].record_id, "7");
        assert_eq!(portal_id(b"{}"), None);
    }
}
