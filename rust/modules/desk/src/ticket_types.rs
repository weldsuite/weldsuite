//! `syncTicketTypeDefinitions` (`@weldsuite/db/lib/custom-field-ticket-types`):
//! a ticket type's dynamic-form `fields` mirrored into
//! `custom_field_definitions` (entity `ticket`, scoped by `ticket_type_id`).
//! Best effort, as the route calls it: a failure is logged and never fails
//! the ticket-type write.

use serde_json::{Map, Value};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use crate::now;

/// A ticket-type field's `type` as a custom-field `fieldType` (`mapFieldType`).
fn field_type(kind: Option<&Value>) -> &'static str {
    match kind.and_then(Value::as_str) {
        Some("select") => "single_select",
        Some("multiselect") => "multi_select",
        Some("checkbox") => "boolean",
        Some("textarea") => "textarea",
        Some("number") => "number",
        Some("date") => "date",
        Some("email") => "email",
        Some("url") => "url",
        _ => "text",
    }
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A number as JavaScript prints it into a statement parameter.
fn js_number(value: &Value) -> Option<String> {
    let number = value.as_f64()?;
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9e15 {
        return Some(format!("{}", number as i64));
    }
    Some(number.to_string())
}

/// What one desired field writes.
struct Wanted {
    slug: String,
    name: Option<String>,
    field_type: &'static str,
    options: Option<Value>,
    required: bool,
    sort_order: String,
}

/// Why a field can't be written: the TypeScript helper throws (and the
/// route logs it).
#[derive(Debug)]
struct Unwritable(&'static str);

fn wanted(field: &Map<String, Value>) -> Result<Wanted, Unwritable> {
    let slug = match field.get("key") {
        Some(Value::String(key)) => key.clone(),
        Some(other) => other.to_string(),
        None => return Err(Unwritable("key")),
    };
    let name = match field.get("label") {
        None => None,
        Some(Value::String(label)) => Some(label.clone()),
        Some(Value::Null) => return Err(Unwritable("label")),
        Some(other) => Some(other.to_string()),
    };
    // `field.options && field.options.length > 0 ? field.options.map(...) : null`.
    let options = match field.get("options") {
        Some(Value::Array(items)) if !items.is_empty() => {
            let mut mapped = Vec::with_capacity(items.len());
            for item in items {
                let Value::Object(option) = item else {
                    return Err(Unwritable("options"));
                };
                let mut out = Map::new();
                for key in ["label", "value"] {
                    if let Some(value) = option.get(key) {
                        out.insert(key.to_owned(), value.clone());
                    }
                }
                mapped.push(Value::Object(out));
            }
            Some(Value::Array(mapped))
        }
        Some(Value::Array(_)) | None | Some(Value::Null) => None,
        Some(Value::Bool(false)) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(_) => return Err(Unwritable("options")),
    };
    let required = match field.get("required") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(Unwritable("required")),
    };
    let sort_order = match field.get("order") {
        None | Some(Value::Null) => "0".to_owned(),
        Some(number @ Value::Number(_)) => js_number(number).ok_or(Unwritable("order"))?,
        Some(_) => return Err(Unwritable("order")),
    };
    Ok(Wanted {
        slug,
        name,
        field_type: field_type(field.get("type")),
        options,
        required,
        sort_order,
    })
}

/// `syncDefinitions(db, ticketTypeId, fields)`: never fails the write.
pub(crate) async fn sync_definitions(db: &PgPool, ticket_type_id: &str, fields: Option<&Value>) {
    if let Err(error) = sync(db, ticket_type_id, fields).await {
        tracing::error!(%error, "[app-api/ticket-types] definition sync failed");
    }
}

#[derive(Debug)]
enum SyncError {
    Field(Unwritable),
    Database(sqlx::Error),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Field(Unwritable(what)) => write!(f, "unreadable field {what}"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<sqlx::Error> for SyncError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

async fn sync(db: &PgPool, ticket_type_id: &str, fields: Option<&Value>) -> Result<(), SyncError> {
    // `(fields ?? []).filter((f) => f?.key && !f.isDefault)`.
    let custom: Vec<&Map<String, Value>> = match fields {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_object)
            .filter(|f| truthy(f.get("key")) && !truthy(f.get("isDefault")))
            .collect(),
        Some(_) => return Err(SyncError::Field(Unwritable("fields"))),
    };
    let existing: Vec<(String, String)> = sqlx::query_as(
        "select id, slug from custom_field_definitions
         where entity_type = 'ticket' and ticket_type_id = $1 and deleted_at is null",
    )
    .bind(ticket_type_id)
    .fetch_all(db)
    .await?;
    let now = now();
    let mut desired = Vec::with_capacity(custom.len());
    for field in custom {
        desired.push(wanted(field).map_err(SyncError::Field)?);
    }
    for field in &desired {
        let prior = existing.iter().find(|(_, slug)| *slug == field.slug);
        if let Some((id, _)) = prior {
            sqlx::query(
                "update custom_field_definitions set
                   name = case when $2::boolean then $3::varchar else name end,
                   field_type = $4, options = $5::jsonb, required = $6,
                   sort_order = $7::text::integer, updated_at = $8::timestamp
                 where id = $1",
            )
            .bind(id)
            .bind(field.name.is_some())
            .bind(field.name.as_deref())
            .bind(field.field_type)
            .bind(field.options.as_ref())
            .bind(field.required)
            .bind(&field.sort_order)
            .bind(&now)
            .execute(db)
            .await?;
        } else {
            sqlx::query(
                "insert into custom_field_definitions
                   (id, entity_type, ticket_type_id, name, slug, field_type, options,
                    required, sort_order, created_at, updated_at)
                 values ($1, 'ticket', $2, $3, $4, $5, $6::jsonb, $7, $8::text::integer,
                         $9::timestamp, $9::timestamp)",
            )
            .bind(generate_id("cfld"))
            .bind(ticket_type_id)
            .bind(field.name.as_deref())
            .bind(&field.slug)
            .bind(field.field_type)
            .bind(field.options.as_ref())
            .bind(field.required)
            .bind(&field.sort_order)
            .bind(&now)
            .execute(db)
            .await?;
        }
    }
    for (id, slug) in &existing {
        if desired.iter().any(|field| field.slug == *slug) {
            continue;
        }
        sqlx::query(
            "update custom_field_definitions set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(id)
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(())
}
