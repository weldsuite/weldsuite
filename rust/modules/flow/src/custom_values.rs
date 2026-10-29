//! (Copied from `weldsuite-core-objects`: module crates do not depend on each other.)
//! Custom field values (`@weldsuite/db/lib/custom-field-values` and the
//! value rules of `@weldsuite/app-api-client/schemas/custom-fields`): one
//! typed cell per value in `custom_field_values`, read and written as a
//! `{ [slug]: value }` map against the entity type's definitions.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number;

use crate::js::{Js, as_text, js_date, js_string, number_value, whole_numbers};

/// A live `custom_field_definitions` row, the parts the value code reads.
#[derive(Debug, Clone)]
pub(crate) struct Definition {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) field_type: String,
    pub(crate) options: Option<Value>,
    pub(crate) required: bool,
    #[allow(dead_code)]
    pub(crate) sort_order: i64,
}

/// Which typed column a field type's value lives in (`fieldTypeToValueColumn`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Column {
    Text,
    Number,
    Date,
    Bool,
    Json,
    Ref,
}

impl Column {
    pub(crate) fn of(field_type: &str) -> Self {
        match field_type {
            "number" | "currency" | "rating" => Self::Number,
            "date" => Self::Date,
            "boolean" => Self::Bool,
            "multi_select" | "file" => Self::Json,
            "user_ref" | "entity_ref" => Self::Ref,
            _ => Self::Text,
        }
    }

    /// The name the list query's sort and filter switch on.
    #[allow(dead_code)]
    pub(crate) fn kind(self) -> &'static str {
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

type DefinitionRow = (
    String,
    String,
    String,
    Option<Value>,
    Option<bool>,
    Option<i32>,
);

/// The live definitions of an entity type, in the table's order
/// (`getDefinitionsForEntityType` has no `order by`).
pub(crate) async fn definitions(
    db: &PgPool,
    entity_type: &str,
) -> Result<Vec<Definition>, sqlx::Error> {
    let rows: Vec<DefinitionRow> = sqlx::query_as(
        "select id, slug, field_type, options, required, sort_order
           from custom_field_definitions
          where entity_type = $1 and deleted_at is null",
    )
    .bind(entity_type)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, slug, field_type, options, required, sort_order)| Definition {
                id,
                slug,
                field_type,
                options,
                required: required.unwrap_or(false),
                sort_order: i64::from(sort_order.unwrap_or(0)),
            },
        )
        .collect())
}

type ValueRow = (
    String,
    String,
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<bool>,
    Option<Value>,
    Option<String>,
);

/// `{ [entityId]: { [slug]: value } }` for `ids` (`getValuesForEntities`):
/// every id gets a map; a value whose definition is gone is left out.
pub(crate) async fn values_for(
    db: &PgPool,
    entity_type: &str,
    ids: &[String],
    definitions: &[Definition],
) -> Result<HashMap<String, Map<String, Value>>, sqlx::Error> {
    let mut out: HashMap<String, Map<String, Value>> =
        ids.iter().map(|id| (id.clone(), Map::new())).collect();
    if ids.is_empty() || definitions.is_empty() {
        return Ok(out);
    }
    let rows: Vec<ValueRow> = sqlx::query_as(
        "select entity_id, field_id, value_text, value_number, to_jsonb(value_date) #>> '{}',
                value_bool, value_json, value_ref
           from custom_field_values
          where entity_type = $1 and entity_id = any($2)",
    )
    .bind(entity_type)
    .bind(ids)
    .fetch_all(db)
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
                Value::String(weldsuite_db::js_timestamp(&stamp).unwrap_or(stamp))
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

/// What `setValues` refuses with.
#[derive(Debug)]
pub(crate) enum ValuesError {
    /// `CustomFieldValidationError`: the caller's value (400).
    Invalid(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for ValuesError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `setValues(db, entityType, entityId, values, { patch, enforceRequired })`.
///
/// `values` is the `{ [slug]: value }` map in the body's key order: a patch
/// touches only its slugs, in that order; otherwise every definition's slug
/// is written and a missing one is cleared. Every value is validated before
/// anything is written; the first invalid one (in that order) is the error.
pub(crate) async fn set_values(
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
    let now = crate::now();

    let existing: Vec<(String, String)> = sqlx::query_as(
        "select field_id, id from custom_field_values where entity_type = $1 and entity_id = $2",
    )
    .bind(entity_type)
    .bind(entity_id)
    .fetch_all(db)
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
            &now,
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

/// Delete, update or insert the value row of one field.
async fn persist(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    definition: &Definition,
    stored: Option<Stored>,
    prior: Option<&String>,
    now: &str,
) -> Result<(), sqlx::Error> {
    let Some(stored) = stored else {
        if let Some(prior) = prior {
            sqlx::query("delete from custom_field_values where id = $1")
                .bind(prior)
                .execute(db)
                .await?;
        }
        return Ok(());
    };
    let (mut text, mut number, mut date, mut flag, mut json, mut reference) =
        (None, None, None, None, None, None);
    match stored {
        Stored::Text(value) => text = Some(value),
        Stored::Number(value) => number = Some(value),
        Stored::Date(value) => date = Some(value),
        Stored::Bool(value) => flag = Some(value),
        Stored::Json(value) => json = Some(value),
        Stored::Ref(value) => reference = Some(value),
    }
    if let Some(prior) = prior {
        sqlx::query(
            "update custom_field_values set
                 value_text = $2, value_number = $3, value_date = $4::timestamp, value_bool = $5,
                 value_json = $6, value_ref = $7, updated_at = $8::timestamp
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
             values ($1, $2, $3, $4, $5::timestamp, $5::timestamp,
                     $6, $7, $8::timestamp, $9, $10, $11)",
        )
        .bind(generate_id("cfv"))
        .bind(&definition.id)
        .bind(entity_type)
        .bind(entity_id)
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

/// `hydrateCustomFields(db, entityType, rows)`: each row's `customFields`
/// with the typed values over it; a row without values is left as read.
pub(crate) async fn hydrate(
    db: &PgPool,
    entity_type: &str,
    rows: Vec<Value>,
) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let definitions = definitions(db, entity_type).await?;
    if definitions.is_empty() {
        return Ok(rows);
    }
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let by_entity = values_for(db, entity_type, &ids, &definitions).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let Value::Object(mut map) = row else {
                return row;
            };
            let id = map.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(values) = by_entity.get(id).filter(|values| !values.is_empty()) else {
                return Value::Object(map);
            };
            let mut merged = match map.get("customFields") {
                Some(Value::Object(blob)) => blob.clone(),
                _ => Map::new(),
            };
            for (slug, value) in values {
                merged.insert(slug.clone(), value.clone());
            }
            map.insert("customFields".to_owned(), Value::Object(merged));
            Value::Object(map)
        })
        .collect())
}

/// `assertValidCustomFieldValues(definitions, values)` without
/// `enforceRequired`: the first invalid value's message, in the
/// definitions' order; empty values pass.
pub(crate) fn assert_valid(
    definitions: &[Definition],
    values: &Map<String, Value>,
) -> Result<(), String> {
    for definition in definitions {
        let Some(raw) = values.get(&definition.slug) else {
            continue;
        };
        let raw = Js::from_jsonb(raw);
        if Js::is_empty_value(Some(&raw)) {
            continue;
        }
        validate_value(definition, Some(&raw))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(
        slug: &str,
        field_type: &str,
        options: Option<Value>,
        required: bool,
    ) -> Definition {
        Definition {
            id: format!("cfld_{slug}"),
            slug: slug.to_owned(),
            field_type: field_type.to_owned(),
            options,
            required,
            sort_order: 0,
        }
    }

    fn check(definition: &Definition, raw: &str) -> Result<Option<String>, String> {
        let raw: Js = serde_json::from_str(raw).expect("json");
        validate_value(definition, Some(&raw)).map(|stored| stored.map(|s| format!("{s:?}")))
    }

    #[test]
    fn values_validate_like_validate_custom_field_value() {
        let number = definition("power", "number", None, false);
        assert_eq!(
            check(&number, r#""7.5""#),
            Ok(Some("Number(7.5)".to_owned()))
        );
        assert_eq!(check(&number, "true"), Ok(Some("Number(1.0)".to_owned())));
        assert_eq!(
            check(&number, r#""lots""#),
            Err("'power' must be a number".to_owned())
        );
        assert_eq!(check(&number, "null"), Ok(None));
        let required = definition("name", "text", None, true);
        assert_eq!(
            check(&required, r#""""#),
            Err("'name' is required".to_owned())
        );
        assert_eq!(check(&required, "12"), Ok(Some(r#"Text("12")"#.to_owned())));
        let tier = definition(
            "tier",
            "single_select",
            Some(json!([{ "label": "Gold", "value": "gold" }])),
            false,
        );
        assert_eq!(
            check(&tier, r#""bronze""#),
            Err("'bronze' is not a valid option for 'tier'".to_owned())
        );
        let tags = definition(
            "tags",
            "multi_select",
            Some(json!([{ "label": "Red", "value": "red" }])),
            false,
        );
        assert_eq!(
            check(&tags, r#"["red","pink"]"#),
            Err("'pink' is not a valid option for 'tags'".to_owned())
        );
        assert_eq!(
            check(&tags, r#""red""#),
            Ok(Some(r#"Json(Array [String("red")])"#.to_owned()))
        );
        let date = definition("installed", "date", None, false);
        assert_eq!(
            check(&date, r#""2026-03-04""#),
            Ok(Some(r#"Date("2026-03-04T00:00:00.000Z")"#.to_owned()))
        );
        assert_eq!(
            check(&date, r#""not a date""#),
            Err("'installed' must be a valid date".to_owned())
        );
    }
}
