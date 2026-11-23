//! Custom field values (`@weldsuite/core-domain/custom-field-values`, over
//! `@weldsuite/db/lib/custom-field-values` and the value rules of
//! `@weldsuite/app-api-client/schemas/custom-fields`): one typed cell per
//! value in `custom_field_values`, read and written as a `{ [slug]: value }`
//! map against the entity type's definitions.
//!
//! The entity routes (companies, people, opportunities, activities, …) read
//! their rows through [`hydrate`] (the Phase 3 read cutover) and mirror the
//! `customFields` blob into the table on every write with
//! [`sync_values_for_entity`] (the Phase 1 dual write).

use std::collections::HashMap;

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number;
use weldsuite_schema::tenant::{
    custom_field_definitions as definitions_table, custom_field_values as values_table,
};

use crate::js::{Js, as_text, js_date, js_string, number_value, whole_numbers};

/// A live `custom_field_definitions` row, the parts the value code reads.
#[derive(Debug, Clone)]
pub struct Definition {
    pub id: String,
    pub slug: String,
    pub field_type: String,
    pub options: Option<Value>,
    pub required: bool,
}

/// Which typed column a field type's value lives in (`fieldTypeToValueColumn`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Column {
    Text,
    Number,
    Date,
    Bool,
    Json,
    Ref,
}

impl Column {
    pub fn of(field_type: &str) -> Self {
        match field_type {
            "number" | "currency" | "rating" => Self::Number,
            "date" => Self::Date,
            "boolean" => Self::Bool,
            "multi_select" | "file" => Self::Json,
            "user_ref" | "entity_ref" => Self::Ref,
            _ => Self::Text,
        }
    }

    /// The name the list queries switch on (`text`, `number`, …).
    pub fn kind(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Date => "date",
            Self::Bool => "bool",
            Self::Json => "json",
            Self::Ref => "ref",
        }
    }
}

type DefinitionRow = (String, String, String, Option<Value>, Option<bool>);

/// `getDefinitionsForEntityType`: the live definitions of an entity type,
/// in the table's order (the query has no `order by`).
pub async fn definitions(db: &PgPool, entity_type: &str) -> Result<Vec<Definition>, DbErr> {
    let rows: Vec<DefinitionRow> = definitions_table::Entity::find()
        .select_only()
        .columns([
            definitions_table::Column::Id,
            definitions_table::Column::Slug,
            definitions_table::Column::FieldType,
            definitions_table::Column::Options,
            definitions_table::Column::Required,
        ])
        .filter(definitions_table::Column::EntityType.eq(entity_type))
        .filter(definitions_table::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, slug, field_type, options, required)| Definition {
            id,
            slug,
            field_type,
            options,
            required: required.unwrap_or(false),
        })
        .collect())
}

type ValueRow = (
    String,
    String,
    Option<String>,
    Option<f64>,
    Option<PrimitiveDateTime>,
    Option<bool>,
    Option<Value>,
    Option<String>,
);

/// `getValuesForEntities`: `{ [entityId]: { [slug]: value } }` for `ids`.
/// Every id gets a map; a value whose definition is gone is left out.
pub async fn values_for(
    db: &PgPool,
    entity_type: &str,
    ids: &[String],
    definitions: &[Definition],
) -> Result<HashMap<String, Map<String, Value>>, DbErr> {
    let mut out: HashMap<String, Map<String, Value>> =
        ids.iter().map(|id| (id.clone(), Map::new())).collect();
    if ids.is_empty() || definitions.is_empty() {
        return Ok(out);
    }
    let rows: Vec<ValueRow> = values_table::Entity::find()
        .select_only()
        .columns([
            values_table::Column::EntityId,
            values_table::Column::FieldId,
            values_table::Column::ValueText,
            values_table::Column::ValueNumber,
            values_table::Column::ValueDate,
            values_table::Column::ValueBool,
            values_table::Column::ValueJson,
            values_table::Column::ValueRef,
        ])
        .filter(values_table::Column::EntityType.eq(entity_type))
        .filter(values_table::Column::EntityId.is_in(ids))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let by_id: HashMap<&str, &Definition> =
        definitions.iter().map(|d| (d.id.as_str(), d)).collect();
    for (entity_id, field_id, text, number, date, flag, json, reference) in rows {
        let Some(definition) = by_id.get(field_id.as_str()) else {
            continue;
        };
        let value = match Column::of(&definition.field_type) {
            Column::Number => number.map_or(Value::Null, number_value),
            Column::Date => date.map_or(Value::Null, |stamp| {
                Value::String(weldsuite_events::iso_timestamp(stamp.assume_utc()))
            }),
            Column::Bool => flag.map_or(Value::Null, Value::Bool),
            Column::Json => json.unwrap_or(Value::Null),
            Column::Ref => reference.map_or(Value::Null, Value::String),
            Column::Text => text.map_or(Value::Null, Value::String),
        };
        out.entry(entity_id)
            .or_default()
            .insert(definition.slug.clone(), value);
    }
    Ok(out)
}

/// `hydrateCustomFields(db, entityType, rows, definitions)`: each row's
/// `customFields` blob overlaid with its typed values. A row without typed
/// values keeps its blob as it is (the migration-window fallback); with no
/// definitions the rows are returned untouched.
pub async fn hydrate(
    db: &PgPool,
    entity_type: &str,
    rows: Vec<Value>,
    definitions: Option<&[Definition]>,
) -> Result<Vec<Value>, DbErr> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let loaded;
    let definitions = if let Some(definitions) = definitions {
        definitions
    } else {
        loaded = self::definitions(db, entity_type).await?;
        &loaded
    };
    if definitions.is_empty() {
        return Ok(rows);
    }
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let by_entity = values_for(db, entity_type, &ids, definitions).await?;
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(values) = by_entity.get(id).filter(|values| !values.is_empty()) else {
                return row;
            };
            let mut merged = match row.get("customFields") {
                Some(Value::Object(blob)) => blob.clone(),
                _ => Map::new(),
            };
            for (slug, value) in values {
                merged.insert(slug.clone(), value.clone());
            }
            if let Value::Object(fields) = &mut row {
                fields.insert("customFields".to_owned(), Value::Object(merged));
            }
            row
        })
        .collect())
}

/// `hydrateCustomFieldsOne`.
pub async fn hydrate_one(
    db: &PgPool,
    entity_type: &str,
    row: Option<Value>,
) -> Result<Option<Value>, DbErr> {
    let Some(row) = row else {
        return Ok(None);
    };
    let mut rows = hydrate(db, entity_type, vec![row], None).await?;
    Ok(rows.pop())
}

/// A value ready to store, in its column; `None` clears the field.
#[derive(Debug, Clone)]
enum Stored {
    Text(String),
    Number(f64),
    /// `toISOString()`.
    Date(String),
    Bool(bool),
    Json(Value),
    Ref(String),
}

/// The option values of a select field's definition.
fn option_values(definition: &Definition) -> Vec<Value> {
    match &definition.options {
        Some(Value::Array(options)) => options
            .iter()
            .map(|option| option.get("value").cloned().unwrap_or(Value::Null))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_option(options: &[Value], value: &str) -> bool {
    options.iter().any(|option| option.as_str() == Some(value))
}

/// `typeof raw === 'number' ? raw : Number(raw)`.
fn js_to_number(raw: &Js) -> f64 {
    match raw {
        Js::Number(number) => *number,
        Js::Bool(flag) => f64::from(u8::from(*flag)),
        Js::Null => 0.0,
        Js::String(text) => js_number(text),
        other => js_number(&js_string(other)),
    }
}

/// `Boolean(raw)` of a value that isn't empty.
fn js_truthy(raw: &Js) -> bool {
    match raw {
        Js::Null => false,
        Js::Bool(flag) => *flag,
        Js::Number(number) => *number != 0.0 && !number.is_nan(),
        Js::String(text) => !text.is_empty(),
        Js::Array(_) | Js::Object(_) => true,
    }
}

/// `validateCustomFieldValue` + `toValueColumns`: the value to store, or
/// the field's message.
fn validate_value(definition: &Definition, raw: Option<&Js>) -> Result<Option<Stored>, String> {
    let slug = &definition.slug;
    let raw = match raw {
        Some(raw) if !Js::is_empty_value(Some(raw)) => raw,
        _ => {
            return if definition.required {
                Err(format!("'{slug}' is required"))
            } else {
                Ok(None)
            };
        }
    };
    let stored = match definition.field_type.as_str() {
        "number" | "currency" | "rating" => {
            let number = js_to_number(raw);
            if number.is_nan() {
                return Err(format!("'{slug}' must be a number"));
            }
            Stored::Number(number)
        }
        "boolean" => Stored::Bool(js_truthy(raw)),
        "date" => match js_date(&as_text(raw)) {
            Some(iso) => Stored::Date(iso),
            None => return Err(format!("'{slug}' must be a valid date")),
        },
        "single_select" => {
            let options = option_values(definition);
            let value = as_text(raw);
            if !options.is_empty() && !is_option(&options, &value) {
                return Err(format!("'{value}' is not a valid option for '{slug}'"));
            }
            Stored::Text(value)
        }
        "multi_select" => {
            let options = option_values(definition);
            let values: Vec<String> = match raw {
                Js::Array(items) => items.iter().map(js_string).collect(),
                other => vec![as_text(other)],
            };
            if !options.is_empty()
                && let Some(bad) = values.iter().find(|value| !is_option(&options, value))
            {
                return Err(format!("'{bad}' is not a valid option for '{slug}'"));
            }
            Stored::Json(json!(values))
        }
        "file" => Stored::Json(whole_numbers(&raw.to_value())),
        "user_ref" | "entity_ref" => Stored::Ref(as_text(raw)),
        _ => Stored::Text(as_text(raw)),
    };
    Ok(Some(stored))
}

/// `validateCustomFieldValue(def, raw)` of a value that isn't empty: the
/// coerced value as the caller sees it (`result.value`: a date as
/// `toISOString()`, a multi select as its strings), or the field's message.
pub fn coerce(definition: &Definition, raw: &Js) -> Result<Value, String> {
    Ok(match validate_value(definition, Some(raw))? {
        None => Value::Null,
        Some(Stored::Text(text) | Stored::Date(text) | Stored::Ref(text)) => Value::String(text),
        Some(Stored::Number(number)) => number_value(number),
        Some(Stored::Bool(flag)) => Value::Bool(flag),
        Some(Stored::Json(value)) => value,
    })
}

/// What `setValues` refuses with.
#[derive(Debug)]
pub enum ValuesError {
    /// `CustomFieldValidationError`: the caller's value.
    Invalid(String),
    Database(DbErr),
}

impl From<DbErr> for ValuesError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for ValuesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => f.write_str(message),
            Self::Database(error) => error.fmt(f),
        }
    }
}

/// `setValues(db, entityType, entityId, values, { definitions, patch, enforceRequired })`.
///
/// A patch touches only the slugs of `values`, in their order; otherwise
/// every definition's slug is written and a missing one is cleared. Every
/// value is validated before anything is written; the first invalid one is
/// the error.
pub async fn set_values(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    values: &[(String, Js)],
    definitions: &[Definition],
    patch: bool,
    enforce_required: bool,
) -> Result<(), ValuesError> {
    if definitions.is_empty() {
        return Ok(());
    }
    // `new Map(defs.map(d => [d.slug, d]))`: the last of a repeated slug wins.
    let mut by_slug: HashMap<&str, &Definition> = HashMap::new();
    for definition in definitions {
        by_slug.insert(definition.slug.as_str(), definition);
    }
    let slugs: Vec<&str> = if patch {
        values.iter().map(|(slug, _)| slug.as_str()).collect()
    } else {
        definitions.iter().map(|d| d.slug.as_str()).collect()
    };
    let now = utc_now();

    let existing: Vec<(String, String)> = values_table::Entity::find()
        .select_only()
        .columns([values_table::Column::FieldId, values_table::Column::Id])
        .filter(values_table::Column::EntityType.eq(entity_type))
        .filter(values_table::Column::EntityId.eq(entity_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let prior: HashMap<String, String> = existing.into_iter().collect();

    let mut writes = Vec::new();
    for slug in slugs {
        let Some(definition) = by_slug.get(slug) else {
            continue;
        };
        let raw = values
            .iter()
            .find(|(key, _)| key == slug)
            .map(|(_, value)| value);
        if raw.is_none() && patch {
            continue;
        }
        let stored = if Js::is_empty_value(raw) && !enforce_required {
            None
        } else {
            validate_value(definition, raw).map_err(ValuesError::Invalid)?
        };
        writes.push((*definition, stored));
    }

    // Each field owns its row, so TypeScript writes them all at once; every
    // write runs here too, and the first failure is reported.
    let mut failure = None;
    for (definition, stored) in writes {
        let result = persist(
            db,
            entity_type,
            entity_id,
            definition,
            stored,
            prior.get(&definition.id),
            now,
        )
        .await;
        if let Err(error) = result
            && failure.is_none()
        {
            failure = Some(error);
        }
    }
    failure.map_or(Ok(()), |error| Err(ValuesError::Database(error)))
}

/// A `toISOString()` date as the `timestamp` it is written as.
fn timestamp(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map(utc_timestamp)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })
}

/// Delete, update or insert the value row of one field.
async fn persist(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    definition: &Definition,
    stored: Option<Stored>,
    prior: Option<&String>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let db = orm(db);
    let Some(stored) = stored else {
        if let Some(prior) = prior {
            values_table::Entity::delete_many()
                .filter(values_table::Column::Id.eq(prior))
                .exec(&db)
                .await?;
        }
        return Ok(());
    };
    let (mut text, mut number, mut date, mut flag, mut json, mut reference) =
        (None, None, None, None, None, None);
    match stored {
        Stored::Text(value) => text = Some(value),
        Stored::Number(value) => number = Some(value),
        Stored::Date(value) => date = Some(timestamp(&value)?),
        Stored::Bool(value) => flag = Some(value),
        Stored::Json(value) => json = Some(value),
        Stored::Ref(value) => reference = Some(value),
    }
    if let Some(prior) = prior {
        values_table::Entity::update_many()
            .col_expr(values_table::Column::ValueText, Expr::value(text))
            .col_expr(values_table::Column::ValueNumber, Expr::value(number))
            .col_expr(values_table::Column::ValueDate, Expr::value(date))
            .col_expr(values_table::Column::ValueBool, Expr::value(flag))
            .col_expr(values_table::Column::ValueJson, Expr::value(json))
            .col_expr(values_table::Column::ValueRef, Expr::value(reference))
            .col_expr(values_table::Column::UpdatedAt, Expr::value(now))
            .filter(values_table::Column::Id.eq(prior))
            .exec(&db)
            .await?;
    } else {
        values_table::Entity::insert(values_table::ActiveModel {
            id: Set(generate_id("cfv")),
            field_id: Set(definition.id.clone()),
            entity_type: Set(entity_type.to_owned()),
            entity_id: Set(entity_id.to_owned()),
            created_at: Set(now),
            updated_at: Set(now),
            value_text: Set(text),
            value_number: Set(number),
            value_date: Set(date),
            value_bool: Set(flag),
            value_json: Set(json),
            value_ref: Set(reference),
        })
        .exec_without_returning(&db)
        .await?;
    }
    Ok(())
}

/// `syncValuesForEntity(db, entityType, entityId, customFields)`: the
/// best-effort Phase 1 mirror of a `customFields` blob into the table.
///
/// `custom_fields` is `None` when the write left the blob alone (no-op);
/// `Some(Value::Null)` or `{}` clears every mirrored value; an object
/// replaces the mirrored set. Never fails: a refused value is logged.
pub async fn sync_values_for_entity(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    custom_fields: Option<&Value>,
) {
    let Some(custom_fields) = custom_fields else {
        return;
    };
    let values: Vec<(String, Js)> = match custom_fields {
        Value::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), Js::from_jsonb(value)))
            .collect(),
        _ => Vec::new(),
    };
    let result = async {
        let definitions = definitions(db, entity_type).await?;
        set_values(
            db,
            entity_type,
            entity_id,
            &values,
            &definitions,
            false,
            false,
        )
        .await
    }
    .await;
    if let Err(error) = result {
        tracing_warn(entity_type, entity_id, &error);
    }
}

fn tracing_warn(entity_type: &str, entity_id: &str, error: &ValuesError) {
    tracing::warn!(%error, "[custom-field-values] dual-write mirror failed for {entity_type}:{entity_id}");
}
