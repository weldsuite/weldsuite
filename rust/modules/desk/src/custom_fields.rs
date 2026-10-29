//! Ticket custom field values (`@weldsuite/core-domain/custom-field-values`,
//! implemented in `@weldsuite/db/lib/custom-field-values`): one typed cell
//! per value in `custom_field_values`, read and written as `{ [slug]: value }`
//! against the ticket's definitions (its ticket type's plus the global ones).
//!
//! The tickets routes use three of its functions: `getDefinitionsForTicket`,
//! `hydrateCustomFields` (the read cutover: typed values overlaid on the
//! `custom_fields` blob) and `syncValuesForEntity` (the best-effort mirror of
//! the blob, which never fails the ticket write).
//!
//! `weldsuite-core-objects` has the same rules for WeldObjects records, in a
//! crate this one may not reach into; this is the ticket slice of them.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number;

use crate::table::js_date;

/// A live `custom_field_definitions` row, the parts the value code reads.
#[derive(Debug, Clone)]
pub(crate) struct Definition {
    id: String,
    slug: String,
    field_type: String,
    options: Option<Value>,
}

/// Which typed column a field type's value lives in (`fieldTypeToValueColumn`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    Text,
    Number,
    Date,
    Bool,
    Json,
    Ref,
}

impl Column {
    fn of(field_type: &str) -> Self {
        match field_type {
            "number" | "currency" | "rating" => Self::Number,
            "date" => Self::Date,
            "boolean" => Self::Bool,
            "multi_select" | "file" => Self::Json,
            "user_ref" | "entity_ref" => Self::Ref,
            _ => Self::Text,
        }
    }
}

/// `getDefinitionsForTicket(db, ticketTypeId)`.
pub(crate) async fn definitions_for_ticket(
    db: &PgPool,
    ticket_type_id: Option<&str>,
) -> Result<Vec<Definition>, sqlx::Error> {
    let rows: Vec<(String, String, String, Option<Value>)> = sqlx::query_as(
        "select id, slug, field_type, options from custom_field_definitions
         where entity_type = 'ticket'
           and (case when $1::text is not null and $1 <> '' then (ticket_type_id = $1 or ticket_type_id is null)
                     else ticket_type_id is null end)
           and deleted_at is null",
    )
    .bind(ticket_type_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, slug, field_type, options)| Definition {
            id,
            slug,
            field_type,
            options,
        })
        .collect())
}

/// `getDefinitionsForEntityType(db, 'ticket')`: every live ticket definition.
pub(crate) async fn definitions_for_tickets(db: &PgPool) -> Result<Vec<Definition>, sqlx::Error> {
    let rows: Vec<(String, String, String, Option<Value>)> = sqlx::query_as(
        "select id, slug, field_type, options from custom_field_definitions
         where entity_type = 'ticket' and deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, slug, field_type, options)| Definition {
            id,
            slug,
            field_type,
            options,
        })
        .collect())
}

/// `hydrateCustomFields(db, 'ticket', rows)`: each row's `customFields` blob
/// with its typed values laid over it; a row without values keeps its blob.
pub(crate) async fn hydrate_tickets(
    db: &PgPool,
    rows: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let definitions = definitions_for_tickets(db).await?;
    if definitions.is_empty() {
        return Ok(rows);
    }
    let by_id: HashMap<&str, &Definition> =
        definitions.iter().map(|d| (d.id.as_str(), d)).collect();
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let values: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(v) from custom_field_values v where v.entity_type = 'ticket' and v.entity_id = any($1)",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let mut by_entity: HashMap<String, Map<String, Value>> = HashMap::new();
    for value in values {
        let Some(definition) = value["field_id"].as_str().and_then(|id| by_id.get(id)) else {
            continue;
        };
        let entity = value["entity_id"].as_str().unwrap_or_default().to_owned();
        by_entity
            .entry(entity)
            .or_default()
            .insert(definition.slug.clone(), read_value(definition, &value));
    }
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            if let Some(values) = by_entity.remove(&id).filter(|v| !v.is_empty()) {
                let mut blob = match &row["customFields"] {
                    Value::Object(map) => map.clone(),
                    // `{ ...null }` is `{}`; spreading a string or an array
                    // spreads its indexes, which no ticket blob holds.
                    _ => Map::new(),
                };
                blob.extend(values);
                row["customFields"] = Value::Object(blob);
            }
            row
        })
        .collect())
}

/// `readValue(def, row)` over a `to_jsonb` value row.
fn read_value(definition: &Definition, row: &Value) -> Value {
    match Column::of(&definition.field_type) {
        Column::Number => row["value_number"].clone(),
        Column::Date => row["value_date"]
            .as_str()
            .map_or(Value::Null, |text| Value::String(js_date(text))),
        Column::Bool => row["value_bool"].clone(),
        Column::Json => row["value_json"].clone(),
        Column::Ref => row["value_ref"].clone(),
        Column::Text => row["value_text"].clone(),
    }
}

/// A value ready to store, in its column.
enum Stored {
    Clear,
    Text(String),
    Number(f64),
    Date(String),
    Bool(bool),
    Json(Value),
    Ref(String),
}

/// `syncValuesForEntity(db, 'ticket', id, customFields, definitions)`: a
/// no-op without `customFields` in the body; otherwise the whole set is
/// replaced, never refusing an empty required field. Best effort: a value
/// that does not validate, or a failed statement, is logged and the ticket
/// write stands.
pub(crate) async fn sync_ticket(
    db: &PgPool,
    ticket_id: &str,
    custom_fields: Option<&Value>,
    definitions: &[Definition],
    now: &str,
) {
    let Some(custom_fields) = custom_fields else {
        return;
    };
    if let Err(error) = set_values(db, ticket_id, custom_fields, definitions, now).await {
        tracing::warn!(%error, "[custom-field-values] dual-write mirror failed for ticket:{ticket_id}");
    }
}

#[derive(Debug)]
struct SyncError(String);

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<sqlx::Error> for SyncError {
    fn from(error: sqlx::Error) -> Self {
        Self(error.to_string())
    }
}

/// `setValues(..., { patch: false, enforceRequired: false })`.
async fn set_values(
    db: &PgPool,
    ticket_id: &str,
    custom_fields: &Value,
    definitions: &[Definition],
    now: &str,
) -> Result<(), SyncError> {
    if definitions.is_empty() {
        return Ok(());
    }
    // `customFields ?? {}`; a non-object reads no slugs.
    let values = custom_fields.as_object().cloned().unwrap_or_default();
    let existing: Vec<(String, String)> = sqlx::query_as(
        "select id, field_id from custom_field_values where entity_type = 'ticket' and entity_id = $1",
    )
    .bind(ticket_id)
    .fetch_all(db)
    .await?;
    let prior: HashMap<String, String> = existing
        .into_iter()
        .map(|(id, field)| (field, id))
        .collect();
    // `defBySlug`: the last definition with a slug wins.
    let mut by_slug: HashMap<&str, &Definition> = HashMap::new();
    for definition in definitions {
        by_slug.insert(definition.slug.as_str(), definition);
    }
    let mut writes = Vec::new();
    for definition in definitions {
        let Some(definition) = by_slug.get(definition.slug.as_str()) else {
            continue;
        };
        writes.push((
            *definition,
            normalize(definition, values.get(&definition.slug))?,
        ));
    }
    for (definition, stored) in writes {
        persist(
            db,
            ticket_id,
            definition,
            stored,
            prior.get(&definition.id),
            now,
        )
        .await?;
    }
    Ok(())
}

/// `normalizeFieldValue` without `enforceRequired`: empty clears.
fn normalize(definition: &Definition, raw: Option<&Value>) -> Result<Stored, SyncError> {
    let raw = match raw {
        None | Some(Value::Null) => return Ok(Stored::Clear),
        Some(Value::String(text)) if text.is_empty() => return Ok(Stored::Clear),
        Some(raw) => raw,
    };
    let slug = &definition.slug;
    match definition.field_type.as_str() {
        "number" | "currency" | "rating" => {
            let number = match raw {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                Value::String(text) => js_number(text),
                Value::Bool(flag) => f64::from(u8::from(*flag)),
                _ => f64::NAN,
            };
            if number.is_nan() {
                return Err(SyncError(format!("'{slug}' must be a number")));
            }
            Ok(Stored::Number(number))
        }
        "boolean" => Ok(Stored::Bool(truthy(raw))),
        "date" => {
            let text = as_text(raw);
            js_date_iso(&text)
                .map(Stored::Date)
                .ok_or_else(|| SyncError(format!("'{slug}' must be a valid date")))
        }
        "single_select" => {
            let value = as_text(raw);
            let options = option_values(definition);
            if !options.is_empty() && !options.contains(&value) {
                return Err(SyncError(format!(
                    "'{value}' is not a valid option for '{slug}'"
                )));
            }
            Ok(Stored::Text(value))
        }
        "multi_select" => {
            let list: Vec<String> = match raw {
                Value::Array(items) => items.iter().map(js_string).collect(),
                other => vec![as_text(other)],
            };
            let options = option_values(definition);
            if !options.is_empty()
                && let Some(bad) = list.iter().find(|v| !options.contains(v))
            {
                return Err(SyncError(format!(
                    "'{bad}' is not a valid option for '{slug}'"
                )));
            }
            Ok(Stored::Json(json!(list)))
        }
        "file" => Ok(Stored::Json(raw.clone())),
        "user_ref" | "entity_ref" => Ok(Stored::Ref(as_text(raw))),
        _ => Ok(Stored::Text(as_text(raw))),
    }
}

fn option_values(definition: &Definition) -> Vec<String> {
    definition
        .options
        .as_ref()
        .and_then(Value::as_array)
        .map(|options| options.iter().map(|o| js_string(&o["value"])).collect())
        .unwrap_or_default()
}

/// JavaScript truthiness (`Boolean(raw)`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `asText(value)` (`@weldsuite/text`): `String()` for primitives, arrays
/// joined, objects as JSON.
fn as_text(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    as_text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => value.to_string(),
        other => js_string(other),
    }
}

/// The typed value columns: text, number, date, bool, json, ref.
type Cells = (
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<bool>,
    Option<Value>,
    Option<String>,
);

/// `persistFieldValue`.
async fn persist(
    db: &PgPool,
    ticket_id: &str,
    definition: &Definition,
    stored: Stored,
    prior: Option<&String>,
    now: &str,
) -> Result<(), sqlx::Error> {
    let (text, number, date, flag, json, reference): Cells = match stored {
        Stored::Clear => {
            if let Some(prior) = prior {
                sqlx::query("delete from custom_field_values where id = $1")
                    .bind(prior)
                    .execute(db)
                    .await?;
            }
            return Ok(());
        }
        Stored::Text(text) => (Some(text), None, None, None, None, None),
        Stored::Number(number) => (None, Some(number), None, None, None, None),
        Stored::Date(date) => (None, None, Some(date), None, None, None),
        Stored::Bool(flag) => (None, None, None, Some(flag), None, None),
        Stored::Json(json) => (None, None, None, None, Some(json), None),
        Stored::Ref(reference) => (None, None, None, None, None, Some(reference)),
    };
    if let Some(prior) = prior {
        sqlx::query(
            "update custom_field_values set value_text = $2, value_number = $3, value_date = $4::timestamp,
                 value_bool = $5, value_json = $6, value_ref = $7, updated_at = $8::timestamp
             where id = $1",
        )
        .bind(prior)
        .bind(text)
        .bind(number)
        .bind(date)
        .bind(flag)
        .bind(json)
        .bind(reference)
        .bind(now)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "insert into custom_field_values
                 (id, field_id, entity_type, entity_id, created_at, updated_at,
                  value_text, value_number, value_date, value_bool, value_json, value_ref)
             values ($1, $2, 'ticket', $3, $4::timestamp, $4::timestamp, $5, $6, $7::timestamp, $8, $9, $10)",
        )
        .bind(generate_id("cfv"))
        .bind(&definition.id)
        .bind(ticket_id)
        .bind(now)
        .bind(text)
        .bind(number)
        .bind(date)
        .bind(flag)
        .bind(json)
        .bind(reference)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `String(number)` for the values a JSON body can carry.
fn js_number_string(number: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{}", number as i64)
    } else {
        format!("{number}")
    }
}

/// `new Date(text).toISOString()` for the ISO shapes JavaScript parses
/// (a date alone is UTC midnight; a date-time without an offset is the
/// worker's time zone, UTC); `None` where it is an Invalid Date.
fn js_date_iso(text: &str) -> Option<String> {
    use time::format_description::well_known::Rfc3339;
    use time::macros::format_description;
    let text = text.trim();
    if let Ok(parsed) = time::OffsetDateTime::parse(text, &Rfc3339) {
        return Some(weldsuite_events::iso_timestamp(parsed));
    }
    if let Ok(date) = time::Date::parse(text, format_description!("[year]-[month]-[day]")) {
        return Some(weldsuite_events::iso_timestamp(
            date.midnight().assume_utc(),
        ));
    }
    for format in [
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]"),
        format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]"),
        format_description!("[year]-[month]-[day]T[hour]:[minute]"),
    ] {
        if let Ok(local) = time::PrimitiveDateTime::parse(text, format) {
            return Some(weldsuite_events::iso_timestamp(local.assume_utc()));
        }
    }
    None
}
