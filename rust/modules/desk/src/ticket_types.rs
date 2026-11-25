//! `syncTicketTypeDefinitions` (`@weldsuite/db/lib/custom-field-ticket-types`):
//! a ticket type's dynamic-form `fields` mirrored into
//! `custom_field_definitions` (entity `ticket`, scoped by `ticket_type_id`).
//! Best effort, as the route calls it: a failure is logged and never fails
//! the ticket-type write.

use sea_orm::sea_query::Expr;
use sea_orm::{ActiveValue, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::custom_field_definitions;

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
    /// As JavaScript prints it into the statement: Postgres refuses one that
    /// is not an integer.
    sort_order: String,
}

impl Wanted {
    /// `sort_order` as the integer column takes it; the statement fails on
    /// anything else (`'1.5'::integer`).
    fn sort_order(&self) -> Result<i32, SyncError> {
        self.sort_order
            .parse()
            .map_err(|_| SyncError::Field(Unwritable("order")))
    }
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
        Some(Value::Array(_) | Value::Null | Value::Bool(false)) | None => None,
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
    Database(DbErr),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Field(Unwritable(what)) => write!(f, "unreadable field {what}"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
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
    let db = orm(db);
    let existing: Vec<(String, String)> = custom_field_definitions::Entity::find()
        .select_only()
        .column(custom_field_definitions::Column::Id)
        .column(custom_field_definitions::Column::Slug)
        .filter(custom_field_definitions::Column::EntityType.eq("ticket"))
        .filter(custom_field_definitions::Column::TicketTypeId.eq(ticket_type_id))
        .filter(custom_field_definitions::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    let now = utc_now();
    let mut desired = Vec::with_capacity(custom.len());
    for field in custom {
        desired.push(wanted(field).map_err(SyncError::Field)?);
    }
    for field in &desired {
        let prior = existing.iter().find(|(_, slug)| *slug == field.slug);
        if let Some((id, _)) = prior {
            let mut update = custom_field_definitions::Entity::update_many();
            if let Some(name) = &field.name {
                update = update.col_expr(custom_field_definitions::Column::Name, Expr::value(name));
            }
            update
                .col_expr(
                    custom_field_definitions::Column::FieldType,
                    Expr::value(field.field_type),
                )
                .col_expr(
                    custom_field_definitions::Column::Options,
                    Expr::value(field.options.clone()),
                )
                .col_expr(
                    custom_field_definitions::Column::Required,
                    Expr::value(field.required),
                )
                .col_expr(
                    custom_field_definitions::Column::SortOrder,
                    Expr::value(field.sort_order()?),
                )
                .col_expr(
                    custom_field_definitions::Column::UpdatedAt,
                    Expr::value(now),
                )
                .filter(custom_field_definitions::Column::Id.eq(id))
                .exec(&db)
                .await?;
        } else {
            // A missing label is a NULL name, which the column refuses.
            let name = field
                .name
                .clone()
                .map_or(ActiveValue::NotSet, ActiveValue::Set);
            custom_field_definitions::Entity::insert(custom_field_definitions::ActiveModel {
                id: ActiveValue::Set(generate_id("cfld")),
                entity_type: ActiveValue::Set("ticket".to_owned()),
                ticket_type_id: ActiveValue::Set(Some(ticket_type_id.to_owned())),
                name,
                slug: ActiveValue::Set(field.slug.clone()),
                field_type: ActiveValue::Set(field.field_type.to_owned()),
                options: ActiveValue::Set(field.options.clone()),
                required: ActiveValue::Set(Some(field.required)),
                sort_order: ActiveValue::Set(Some(field.sort_order()?)),
                created_at: ActiveValue::Set(now),
                updated_at: ActiveValue::Set(now),
                ..Default::default()
            })
            .exec_without_returning(&db)
            .await?;
        }
    }
    for (id, slug) in &existing {
        if desired.iter().any(|field| field.slug == *slug) {
            continue;
        }
        custom_field_definitions::Entity::update_many()
            .col_expr(
                custom_field_definitions::Column::DeletedAt,
                Expr::value(now),
            )
            .col_expr(
                custom_field_definitions::Column::UpdatedAt,
                Expr::value(now),
            )
            .filter(custom_field_definitions::Column::Id.eq(id))
            .exec(&db)
            .await?;
    }
    Ok(())
}
