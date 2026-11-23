//! Custom field values (`@weldsuite/db/lib/custom-field-values` and the
//! value rules of `@weldsuite/app-api-client/schemas/custom-fields`): one
//! typed cell per value in `custom_field_values`, read and written as a
//! `{ [slug]: value }` map against the entity type's definitions.

use std::collections::HashMap;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number;
use weldsuite_schema::tenant::{custom_field_definitions, custom_field_values};

use crate::js::{Js, as_text, js_date, js_string, number_value, slice_utf16, whole_numbers};

/// A live `custom_field_definitions` row, the parts the value code reads.
#[derive(Debug, Clone)]
pub(crate) struct Definition {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) field_type: String,
    pub(crate) options: Option<Value>,
    pub(crate) required: bool,
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
pub(crate) async fn definitions(db: &PgPool, entity_type: &str) -> Result<Vec<Definition>, DbErr> {
    use custom_field_definitions::Column;
    let rows: Vec<DefinitionRow> = custom_field_definitions::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Slug,
            Column::FieldType,
            Column::Options,
            Column::Required,
            Column::SortOrder,
        ])
        .filter(Column::EntityType.eq(entity_type))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
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
    Option<PrimitiveDateTime>,
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
) -> Result<HashMap<String, Map<String, Value>>, DbErr> {
    use custom_field_values::Column as Cell;
    let mut out: HashMap<String, Map<String, Value>> =
        ids.iter().map(|id| (id.clone(), Map::new())).collect();
    if ids.is_empty() || definitions.is_empty() {
        return Ok(out);
    }
    let rows: Vec<ValueRow> = custom_field_values::Entity::find()
        .select_only()
        .columns([
            Cell::EntityId,
            Cell::FieldId,
            Cell::ValueText,
            Cell::ValueNumber,
            Cell::ValueDate,
            Cell::ValueBool,
            Cell::ValueJson,
            Cell::ValueRef,
        ])
        .filter(Cell::EntityType.eq(entity_type))
        .filter(Cell::EntityId.is_in(ids.iter().map(String::as_str)))
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
            Column::Date => date.map_or(Value::Null, |at| Value::String(crate::iso(at))),
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
    Database(DbErr),
}

impl From<DbErr> for ValuesError {
    fn from(error: DbErr) -> Self {
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
    let now = utc_now();
    let db = &orm(db);

    let existing: Vec<(String, String)> = custom_field_values::Entity::find()
        .select_only()
        .columns([
            custom_field_values::Column::FieldId,
            custom_field_values::Column::Id,
        ])
        .filter(custom_field_values::Column::EntityType.eq(entity_type))
        .filter(custom_field_values::Column::EntityId.eq(entity_id))
        .into_tuple()
        .all(db)
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

/// Delete, update or insert the value row of one field.
async fn persist(
    db: &impl ConnectionTrait,
    entity_type: &str,
    entity_id: &str,
    definition: &Definition,
    stored: Option<Stored>,
    prior: Option<&String>,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    use custom_field_values::{ActiveModel, Column as Cell, Entity};
    let Some(stored) = stored else {
        if let Some(prior) = prior {
            Entity::delete_many()
                .filter(Cell::Id.eq(prior))
                .exec(db)
                .await?;
        }
        return Ok(());
    };
    let (mut text, mut number, mut date, mut flag, mut json, mut reference) =
        (None, None, None, None, None, None);
    match stored {
        Stored::Text(value) => text = Some(value),
        Stored::Number(value) => number = Some(value),
        Stored::Date(value) => date = Some(crate::timestamp(&value)?),
        Stored::Bool(value) => flag = Some(value),
        Stored::Json(value) => json = Some(value),
        Stored::Ref(value) => reference = Some(value),
    }
    if let Some(prior) = prior {
        Entity::update_many()
            .col_expr(Cell::ValueText, Expr::value(text))
            .col_expr(Cell::ValueNumber, Expr::value(number))
            .col_expr(Cell::ValueDate, Expr::value(date))
            .col_expr(Cell::ValueBool, Expr::value(flag))
            .col_expr(Cell::ValueJson, Expr::value(json))
            .col_expr(Cell::ValueRef, Expr::value(reference))
            .col_expr(Cell::UpdatedAt, Expr::value(now))
            .filter(Cell::Id.eq(prior))
            .exec(db)
            .await?;
    } else {
        Entity::insert(ActiveModel {
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
        .exec_without_returning(db)
        .await?;
    }
    Ok(())
}

/// Field types that can stand in as a record's display name.
const TITLE_FALLBACK_TYPES: [&str; 5] = ["text", "email", "url", "phone", "textarea"];

/// `resolveRecordTitle`: the title field's value, else the first text-ish
/// field (by sort order) with one, cut to 500 UTF-16 units; else `None`.
pub(crate) fn resolve_title(
    title_field_id: Option<&str>,
    definitions: &[Definition],
    field: impl Fn(&str) -> Option<Js>,
) -> Option<String> {
    let present = |slug: &str| field(slug).filter(|raw| !Js::is_empty_value(Some(raw)));
    if let Some(title_field_id) = title_field_id.filter(|id| !id.is_empty())
        && let Some(definition) = definitions.iter().find(|d| d.id == title_field_id)
        && let Some(raw) = present(&definition.slug)
    {
        return Some(slice_utf16(&as_text(&raw), 500));
    }
    let mut ordered: Vec<&Definition> = definitions.iter().collect();
    ordered.sort_by_key(|d| d.sort_order);
    ordered
        .into_iter()
        .filter(|d| TITLE_FALLBACK_TYPES.contains(&d.field_type.as_str()))
        .find_map(|d| present(&d.slug))
        .map(|raw| slice_utf16(&as_text(&raw), 500))
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

    #[test]
    fn titles_fall_back_to_the_first_text_field() {
        let mut serial = definition("serial", "text", None, false);
        serial.sort_order = 1;
        let power = definition("power", "number", None, false);
        let definitions = vec![serial, power];
        let fields = |slug: &str| match slug {
            "serial" => Some(Js::String("SN-1".to_owned())),
            "power" => Some(Js::Number(5.0)),
            _ => None,
        };
        assert_eq!(
            resolve_title(Some("cfld_power"), &definitions, fields),
            Some("5".to_owned())
        );
        assert_eq!(
            resolve_title(None, &definitions, fields),
            Some("SN-1".to_owned())
        );
        assert_eq!(resolve_title(None, &definitions, |_| None), None);
    }
}
