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

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number;
use weldsuite_schema::tenant::{custom_field_definitions, custom_field_values};

use crate::crud::js_date_time;
use crate::js::js_date_iso;

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

/// `getDefinitionsForTicket(db, ticketTypeId)`: the global ticket
/// definitions, and the ticket type's when it has one.
pub(crate) async fn definitions_for_ticket(
    db: &PgPool,
    ticket_type_id: Option<&str>,
) -> Result<Vec<Definition>, DbErr> {
    let scope = match ticket_type_id.filter(|id| !id.is_empty()) {
        Some(id) => Condition::any()
            .add(custom_field_definitions::Column::TicketTypeId.eq(id))
            .add(custom_field_definitions::Column::TicketTypeId.is_null()),
        None => Condition::all().add(custom_field_definitions::Column::TicketTypeId.is_null()),
    };
    definitions(db, scope).await
}

/// `getDefinitionsForEntityType(db, 'ticket')`: every live ticket definition.
pub(crate) async fn definitions_for_tickets(db: &PgPool) -> Result<Vec<Definition>, DbErr> {
    definitions(db, Condition::all()).await
}

/// The live ticket definitions within `scope`.
async fn definitions(db: &PgPool, scope: Condition) -> Result<Vec<Definition>, DbErr> {
    let rows: Vec<(String, String, String, Option<Value>)> =
        custom_field_definitions::Entity::find()
            .select_only()
            .column(custom_field_definitions::Column::Id)
            .column(custom_field_definitions::Column::Slug)
            .column(custom_field_definitions::Column::FieldType)
            .column(custom_field_definitions::Column::Options)
            .filter(custom_field_definitions::Column::EntityType.eq("ticket"))
            .filter(scope)
            .filter(custom_field_definitions::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
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
pub(crate) async fn hydrate_tickets(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, DbErr> {
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
    let values = custom_field_values::Entity::find()
        .filter(custom_field_values::Column::EntityType.eq("ticket"))
        .filter(custom_field_values::Column::EntityId.is_in(ids))
        .all(&orm(db))
        .await?;
    let mut by_entity: HashMap<String, Map<String, Value>> = HashMap::new();
    for value in values {
        let Some(definition) = by_id.get(value.field_id.as_str()) else {
            continue;
        };
        by_entity
            .entry(value.entity_id.clone())
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

/// `readValue(def, row)`.
fn read_value(definition: &Definition, row: &custom_field_values::Model) -> Value {
    match Column::of(&definition.field_type) {
        Column::Number => row.value_number.map_or(Value::Null, number_value),
        Column::Date => row.value_date.map_or(Value::Null, |at| {
            Value::String(iso_timestamp(at.assume_utc()))
        }),
        Column::Bool => row.value_bool.map_or(Value::Null, Value::Bool),
        Column::Json => row.value_json.clone().unwrap_or(Value::Null),
        Column::Ref => row.value_ref.clone().map_or(Value::Null, Value::String),
        Column::Text => row.value_text.clone().map_or(Value::Null, Value::String),
    }
}

/// A `double precision` as `to_jsonb` and the driver hand it on: a whole
/// number without a fraction.
fn number_value(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9e15 {
        return json!(number as i64);
    }
    json!(number)
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
    now: PrimitiveDateTime,
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

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
        Self(error.to_string())
    }
}

/// `setValues(..., { patch: false, enforceRequired: false })`.
async fn set_values(
    db: &PgPool,
    ticket_id: &str,
    custom_fields: &Value,
    definitions: &[Definition],
    now: PrimitiveDateTime,
) -> Result<(), SyncError> {
    if definitions.is_empty() {
        return Ok(());
    }
    // `customFields ?? {}`; a non-object reads no slugs.
    let values = custom_fields.as_object().cloned().unwrap_or_default();
    let existing: Vec<(String, String)> = custom_field_values::Entity::find()
        .select_only()
        .column(custom_field_values::Column::Id)
        .column(custom_field_values::Column::FieldId)
        .filter(custom_field_values::Column::EntityType.eq("ticket"))
        .filter(custom_field_values::Column::EntityId.eq(ticket_id))
        .into_tuple()
        .all(&orm(db))
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
    Option<PrimitiveDateTime>,
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
    now: PrimitiveDateTime,
) -> Result<(), SyncError> {
    let db = orm(db);
    let (text, number, date, flag, json, reference): Cells = match stored {
        Stored::Clear => {
            if let Some(prior) = prior {
                custom_field_values::Entity::delete_by_id(prior.clone())
                    .exec(&db)
                    .await?;
            }
            return Ok(());
        }
        Stored::Text(text) => (Some(text), None, None, None, None, None),
        Stored::Number(number) => (None, Some(number), None, None, None, None),
        Stored::Date(date) => {
            // An ISO string Postgres would cast to `timestamp` (the zone dropped).
            let at = js_date_time(&date)
                .ok_or_else(|| SyncError(format!("invalid timestamp: {date}")))?;
            (None, None, Some(at), None, None, None)
        }
        Stored::Bool(flag) => (None, None, None, Some(flag), None, None),
        Stored::Json(json) => (None, None, None, None, Some(json), None),
        Stored::Ref(reference) => (None, None, None, None, None, Some(reference)),
    };
    if let Some(prior) = prior {
        custom_field_values::Entity::update_many()
            .col_expr(custom_field_values::Column::ValueText, Expr::value(text))
            .col_expr(
                custom_field_values::Column::ValueNumber,
                Expr::value(number),
            )
            .col_expr(custom_field_values::Column::ValueDate, Expr::value(date))
            .col_expr(custom_field_values::Column::ValueBool, Expr::value(flag))
            .col_expr(custom_field_values::Column::ValueJson, Expr::value(json))
            .col_expr(
                custom_field_values::Column::ValueRef,
                Expr::value(reference),
            )
            .col_expr(custom_field_values::Column::UpdatedAt, Expr::value(now))
            .filter(custom_field_values::Column::Id.eq(prior))
            .exec(&db)
            .await?;
    } else {
        custom_field_values::Entity::insert(custom_field_values::ActiveModel {
            id: ActiveValue::Set(generate_id("cfv")),
            field_id: ActiveValue::Set(definition.id.clone()),
            entity_type: ActiveValue::Set("ticket".to_owned()),
            entity_id: ActiveValue::Set(ticket_id.to_owned()),
            created_at: ActiveValue::Set(now),
            updated_at: ActiveValue::Set(now),
            value_text: ActiveValue::Set(text),
            value_number: ActiveValue::Set(number),
            value_date: ActiveValue::Set(date),
            value_bool: ActiveValue::Set(flag),
            value_json: ActiveValue::Set(json),
            value_ref: ActiveValue::Set(reference),
        })
        .exec_without_returning(&db)
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
