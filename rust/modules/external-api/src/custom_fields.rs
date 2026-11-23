//! Custom fields on the CRM's `/v1` objects, companies and people
//! (`lib/custom-fields.ts`).
//!
//! WeldCRM reads custom fields from the typed `custom_field_values` table,
//! not from the row's `customFields` blob. A create or update checks every
//! value against the workspace's definitions before it writes anything, then
//! writes the blob and the typed values both, so one request carries the
//! whole record. Keys without a definition are not refused: they stay in the
//! blob and the API keeps returning them.

use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use weldsuite_core_domain::custom_field_values::{self as values, Definition, ValuesError};
use weldsuite_core_domain::js::Js;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::custom_field_definitions;

use crate::crud::{Answer, Fail, list_query};
use crate::list::{Filter, Page, list_rows};
use crate::session::bad_request;
use crate::table::Table;
use crate::zod::Parsed;

/// `getDefinitionsForEntityType(db, entityType)`.
pub(crate) async fn definitions(db: &PgPool, entity_type: &str) -> Result<Vec<Definition>, Fail> {
    Ok(values::definitions(db, entity_type).await?)
}

/// `null` and `''` clear a field; they never fail validation.
fn is_empty(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

/// `customFieldProblems(definitions, values)`: the values their definition
/// refuses, by slug, in slug order. An empty value always passes, a required
/// field is not enforced, and a key without a definition passes.
pub(crate) fn problems(
    definitions: &[Definition],
    sent: &Map<String, Value>,
) -> Map<String, Value> {
    let mut by_slug: Vec<&Definition> = definitions.iter().collect();
    by_slug.sort_by(|a, b| a.slug.cmp(&b.slug));
    let mut out = Map::new();
    for definition in by_slug {
        let Some(raw) = sent.get(&definition.slug) else {
            continue;
        };
        if is_empty(raw) {
            continue;
        }
        if let Err(message) = values::coerce(definition, &Js::from_jsonb(raw)) {
            out.insert(definition.slug.clone(), Value::String(message));
        }
    }
    out
}

/// The custom fields a body sends, when it sends any, refused as a whole
/// when a value is (`customFieldsRefused`).
pub(crate) fn check(
    definitions: &[Definition],
    sent: Option<&Map<String, Value>>,
) -> Result<(), Fail> {
    let Some(sent) = sent else {
        return Ok(());
    };
    let problems = problems(definitions, sent);
    if problems.is_empty() {
        return Ok(());
    }
    let messages: Vec<&str> = problems.values().filter_map(Value::as_str).collect();
    Err(bad_request(format!(
        "Invalid custom field values: {}",
        messages.join("; ")
    ))
    .with_details(json!({ "field": "customFields", "errors": problems }))
    .into())
}

/// `mergeCustomFields(stored, sent)`: a sent key replaces the stored one, an
/// empty value removes it, an unsent key is kept.
pub(crate) fn merge(stored: Option<&Value>, sent: &Map<String, Value>) -> Value {
    let mut merged = match stored {
        Some(Value::Object(blob)) => blob.clone(),
        _ => Map::new(),
    };
    for (slug, value) in sent {
        if is_empty(value) {
            merged.remove(slug);
        } else {
            merged.insert(slug.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

/// `writeCustomFields`: the sent slugs into `custom_field_values` (a patch,
/// required fields not enforced), after [`check`] passed.
pub(crate) async fn write(
    db: &PgPool,
    entity_type: &str,
    entity_id: &str,
    sent: Option<&Map<String, Value>>,
    definitions: &[Definition],
) -> Result<(), Fail> {
    let Some(sent) = sent else {
        return Ok(());
    };
    if definitions.is_empty() {
        return Ok(());
    }
    let fields: Vec<(String, Js)> = sent
        .iter()
        .map(|(slug, value)| (slug.clone(), Js::from_jsonb(value)))
        .collect();
    values::set_values(
        db,
        entity_type,
        entity_id,
        &fields,
        definitions,
        true,
        false,
    )
    .await
    .map_err(|error| match error {
        ValuesError::Database(error) => Fail::from(error),
        ValuesError::Invalid(message) => Fail::from(bad_request(message)),
    })
}

/// The `customFields` object a parsed body carries, when it carries one.
pub(crate) fn sent(body: &Map<String, Value>) -> Option<&Map<String, Value>> {
    body.get("customFields").and_then(Value::as_object)
}

/// One row with its custom fields read from the typed table.
pub(crate) async fn hydrated(
    db: &PgPool,
    entity_type: &str,
    row: Value,
    definitions: Option<&[Definition]>,
) -> Result<Value, Fail> {
    let mut rows = values::hydrate(db, entity_type, vec![row], definitions).await?;
    Ok(rows.pop().unwrap_or(Value::Null))
}

/// [`crate::crud::page`] with each row's custom fields read from the typed
/// table (`hydrateCustomFields` over the page).
pub(crate) async fn page(
    db: &PgPool,
    filter: Filter,
    table: &'static Table,
    parsed: &Parsed,
    filters: Value,
    entity_type: &str,
) -> Answer {
    let mut page = list_rows(db, &table.entity, filter(&filters), &list_query(parsed)).await?;
    let rows = page.rows.into_iter().map(|row| table.js(row)).collect();
    page.rows = values::hydrate(db, entity_type, rows, None).await?;
    Ok(page.respond())
}

/// A definition as `GET /custom-fields` answers it.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicDefinition {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    field_type: String,
    options: Option<Value>,
    config: Option<Value>,
    required: Option<bool>,
    group: Option<String>,
    sort_order: Option<i32>,
}

/// `GET /v1/<object>/custom-fields`: the live definitions, in display order.
pub(crate) async fn definitions_list(db: &PgPool, entity_type: &str) -> Answer {
    use custom_field_definitions::Column;
    let definitions: Vec<PublicDefinition> = custom_field_definitions::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::Slug,
            Column::Name,
            Column::Description,
            Column::FieldType,
            Column::Options,
            Column::Config,
            Column::Required,
            Column::Group,
            Column::SortOrder,
        ])
        .filter(Column::EntityType.eq(entity_type))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::SortOrder)
        .order_by_asc(Column::Name)
        .order_by_asc(Column::Id)
        .into_model()
        .all(&orm(db))
        .await?;
    let rows = definitions
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| Fail::from(DbErr::Json(error.to_string())))?;
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(Page {
        rows,
        total,
        has_more: false,
        cursor: Value::Null,
    }
    .respond())
}
