//! `/api/custom-fields`: custom field definitions for any entity type
//! (`routes/custom-fields`), read with `settings:read` and changed with
//! `settings:manage`. A custom object's fields are these rows with
//! `entityType = co_<slug>`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    QueryTrait,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOM_FIELD_CREATED, CUSTOM_FIELD_DELETED, CUSTOM_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys::{SETTINGS_MANAGE, SETTINGS_READ};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_events::is_custom_object_entity_key;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, js_trim};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::custom_field_definitions::{self, Column, Entity};

use crate::js::{Js, parse_body, stringify};
use crate::objects::{field_json, reorder_items};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, answer, change, int4, json_row, validate,
    validate_query,
};

const FIELD_TYPES: [&str; 15] = [
    "text",
    "number",
    "date",
    "single_select",
    "multi_select",
    "boolean",
    "url",
    "email",
    "phone",
    "currency",
    "textarea",
    "rating",
    "file",
    "user_ref",
    "entity_ref",
];
const RESERVED_FIELD_SLUGS: [&str; 9] = [
    "id",
    "search",
    "limit",
    "cursor",
    "fields",
    "title",
    "owner_id",
    "created_at",
    "updated_at",
];

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([SETTINGS_READ]);
    let manage = || gate.require([SETTINGS_MANAGE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(manage()))
        .route("/all", get(grouped).route_layer(read()))
        .route("/reorder", put(reorder).route_layer(manage()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", put(update).route_layer(manage()))
        .route("/{id}", delete(remove).route_layer(manage()))
}

/// `isReservedFieldSlug`: separators and case don't make a different name.
fn is_reserved_field_slug(slug: &str) -> bool {
    let normalized: String = slug
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '_' | '-'))
        .collect();
    RESERVED_FIELD_SLUGS
        .iter()
        .any(|reserved| reserved.replace('_', "") == normalized)
}

/// `hasUsableSelectOptions`: a select field needs an option with a
/// non-blank label and value.
fn has_usable_select_options(field_type: &str, options: Option<&Value>) -> bool {
    if !matches!(field_type, "single_select" | "multi_select") {
        return true;
    }
    let blank =
        |option: &Value, key: &str| js_trim(option[key].as_str().unwrap_or_default()).is_empty();
    options.and_then(Value::as_array).is_some_and(|options| {
        options
            .iter()
            .any(|o| !blank(o, "label") && !blank(o, "value"))
    })
}

/// Definitions as the routes return them.
fn definitions(rows: Vec<custom_field_definitions::Model>) -> Result<Vec<Value>, DbErr> {
    rows.into_iter().map(json_row).collect()
}

// ── reads ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let entity_type = match validate_query(query.as_deref(), |issues, values| {
        issues.text(values, "entityType", Presence::Optional, None, None)
    }) {
        Ok(entity_type) => entity_type.into_option().filter(|t| !t.is_empty()),
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let rows = Entity::find()
            .filter(Column::DeletedAt.is_null())
            .apply_if(entity_type, |query, entity_type| {
                query.filter(Column::EntityType.eq(entity_type))
            })
            .order_by_asc(Column::SortOrder)
            .order_by_asc(Column::CreatedAt)
            .all(&orm(&caller.db))
            .await?;
        Ok(Data(definitions(rows)?).into_response())
    }
    .await;
    answer(result, "Failed to list custom field definitions")
}

async fn grouped(caller: Caller) -> Response {
    let result: Answer = async {
        let rows = Entity::find()
            .filter(Column::DeletedAt.is_null())
            .order_by_asc(Column::EntityType)
            .order_by_asc(Column::SortOrder)
            .all(&orm(&caller.db))
            .await?;
        let mut out = Map::new();
        for field in definitions(rows)? {
            let key = field["entityType"].as_str().unwrap_or_default().to_owned();
            if let Value::Array(list) = out.entry(key).or_insert_with(|| json!([])) {
                list.push(field);
            }
        }
        Ok(Data(Value::Object(out)).into_response())
    }
    .await;
    answer(result, "Failed to list custom field definitions")
}

async fn fetch(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let field = Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    field.map(json_row).transpose()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let field = fetch(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom field definition", &id))?;
        Ok(Data(field).into_response())
    }
    .await;
    answer(result, "Failed to get custom field definition")
}

// ── PUT /reorder ───────────────────────────────────────────────────────────

async fn reorder(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let items = match validate(&headers, &body, reorder_items) {
        Ok(items) => items,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        // Independent rows, no transaction, as in TypeScript.
        let db = &orm(&caller.db);
        for (id, order) in &items {
            Entity::update_many()
                .col_expr(Column::SortOrder, Expr::value(int4(*order)?))
                .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                .filter(Column::Id.eq(id))
                .filter(Column::DeletedAt.is_null())
                .exec(db)
                .await?;
        }
        Ok(Data(json!({ "reordered": items.len() })).into_response())
    }
    .await;
    answer(result, "Failed to reorder custom field definitions")
}

// ── POST /, PUT /:id ───────────────────────────────────────────────────────

/// `createCustomFieldSchema` / `updateCustomFieldSchema` as Zod's output.
struct FieldInput {
    /// The fields the body set, for the event (and `computeChanges`).
    data: Map<String, Value>,
    entity_type: String,
    slug: String,
    name: Field<String>,
    description: Field<String>,
    field_type: Field<String>,
    options: Field<Vec<Value>>,
    config: Field<Value>,
    required: Field<bool>,
    sort_order: Field<i64>,
    group: Field<String>,
    ticket_type_id: Field<String>,
}

/// `selectOptionSchema` items as Zod outputs them: `label`, `value`, then
/// `color` when given, nothing else.
fn select_options(issues: &mut Issues, body: &Map<String, Value>) -> Field<Vec<Value>> {
    issues.list(
        body,
        "options",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let option = issues.object(item)?;
            let label = issues.text(option, "label", Presence::Required, Some(1), None);
            let value = issues.text(option, "value", Presence::Required, Some(1), None);
            let color = issues.text(option, "color", Presence::Optional, None, None);
            let mut out = Map::new();
            out.insert("label".to_owned(), json!(label.into_option()?));
            out.insert("value".to_owned(), json!(value.into_option()?));
            if let Field::Set(color) = color {
                out.insert("color".to_owned(), json!(color));
            }
            Some(Value::Object(out))
        },
    )
}

fn field_input(headers: &HeaderMap, body: &Bytes, create: bool) -> Result<FieldInput, Rejected> {
    validate(headers, body, |issues, fields| {
        let mut data = Map::new();
        let (mut entity_type, mut slug) = (String::new(), String::new());
        if create {
            entity_type = issues
                .text(fields, "entityType", Presence::Required, Some(1), Some(50))
                .into_option()
                .unwrap_or_default();
            data.insert("entityType".to_owned(), json!(entity_type));
        }
        let required_text = if create {
            Presence::Required
        } else {
            Presence::Optional
        };
        let name = issues.text(fields, "name", required_text, Some(1), Some(100));
        if create {
            slug = issues
                .pattern(
                    fields,
                    "slug",
                    Presence::Required,
                    Some(1),
                    Some(100),
                    |s| {
                        !s.is_empty()
                            && s.chars()
                                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                    },
                    "Slug must be lowercase alphanumeric with underscores",
                )
                .into_option()
                .unwrap_or_default();
        }
        let description = issues.text(fields, "description", Presence::Optional, None, Some(500));
        let field_type = issues.choice(fields, "fieldType", required_text, &FIELD_TYPES);
        let options = select_options(issues, fields);
        let config = issues.nested(fields, "config", Presence::Optional, |_, config| {
            Value::Object(config.clone())
        });
        let required = issues.boolean(fields, "required", Presence::Optional);
        let sort_order =
            issues.whole_number(fields, "sortOrder", Presence::Optional, Number::default());
        let group = issues.text(fields, "group", Presence::Optional, None, Some(100));
        let ticket_type_id = if create {
            issues.text(fields, "ticketTypeId", Presence::Nullish, None, Some(30))
        } else {
            Field::Absent
        };
        for (key, value) in [
            ("name", field_json(&name)),
            ("slug", create.then(|| json!(slug))),
            ("description", field_json(&description)),
            ("fieldType", field_json(&field_type)),
            ("options", field_json(&options)),
            ("config", field_json(&config)),
            ("required", field_json(&required)),
            ("sortOrder", field_json(&sort_order)),
            ("group", field_json(&group)),
            ("ticketTypeId", field_json(&ticket_type_id)),
        ] {
            if let Some(value) = value {
                data.insert(key.to_owned(), value);
            }
        }
        FieldInput {
            data,
            entity_type,
            slug,
            name,
            description,
            field_type,
            options,
            config,
            required,
            sort_order,
            group,
            ticket_type_id,
        }
    })
}

async fn create(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match field_input(&headers, &body, true) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let field_type = input.field_type.as_set().cloned().unwrap_or_default();
    let options = input.options.as_set().map(|o| Value::Array(o.clone()));
    if !has_usable_select_options(&field_type, options.as_ref()) {
        return Refusal::bad_request(format!("A {field_type} field needs at least one option"))
            .respond("Failed to create custom field definition");
    }
    let result: Answer = async {
        let db = &orm(&caller.db);
        if is_custom_object_entity_key(&input.entity_type) && is_reserved_field_slug(&input.slug) {
            return Err(Refusal::bad_request(format!(
                "'{}' is reserved and cannot be used as a field name on a custom object",
                input.slug
            )));
        }
        let ticket_type = input.ticket_type_id.as_set().filter(|t| !t.is_empty());
        let existing: Option<String> = Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::EntityType.eq(&input.entity_type))
            .filter(Column::Slug.eq(&input.slug))
            .filter(Column::DeletedAt.is_null())
            .filter(match ticket_type {
                None => Column::TicketTypeId.is_null(),
                Some(ticket_type) => Column::TicketTypeId.eq(ticket_type),
            })
            .into_tuple()
            .one(db)
            .await?;
        if existing.is_some() {
            return Err(Refusal::conflict(format!(
                "A custom field with slug '{}' already exists for entity type '{}'",
                input.slug, input.entity_type
            )));
        }
        let id = generate_id("cfld");
        let now = utc_now();
        Entity::insert(custom_field_definitions::ActiveModel {
            id: Set(id.clone()),
            entity_type: Set(input.entity_type.clone()),
            name: Set(input.name.as_set().cloned().unwrap_or_default()),
            slug: Set(input.slug.clone()),
            description: Set(input.description.as_set().cloned()),
            field_type: Set(field_type.clone()),
            options: Set(options.clone()),
            config: Set(input.config.as_set().map(crate::js::whole_numbers)),
            required: Set(Some(input.required.as_set().copied().unwrap_or(false))),
            sort_order: Set(Some(int4(input.sort_order.as_set().copied().unwrap_or(0))?)),
            group: Set(input.group.as_set().cloned()),
            ticket_type_id: Set(input.ticket_type_id.as_set().cloned()),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(db)
        .await?;
        let created = fetch(&caller.db, &id).await?;
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(id));
        data.extend(input.data);
        caller.publish(&state, CUSTOM_FIELD_CREATED, &id, &Value::Object(data));
        Ok(Created(created.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to create custom field definition")
}

/// `JSON.stringify` of what the body set for `key`, as Zod's output holds
/// it: options in the schema's key order, `config` in the body's.
fn input_json(key: &str, value: &Value, body: &Js) -> String {
    match key {
        "options" => {
            let options = value.as_array().map(Vec::as_slice).unwrap_or_default();
            let items = options
                .iter()
                .map(|option| {
                    let mut entries = vec![
                        ("label".to_owned(), Js::from_jsonb(&option["label"])),
                        ("value".to_owned(), Js::from_jsonb(&option["value"])),
                    ];
                    if let Some(color) = option.get("color") {
                        entries.push(("color".to_owned(), Js::from_jsonb(color)));
                    }
                    Js::Object(entries)
                })
                .collect();
            stringify(&Js::Array(items))
        }
        "config" => body
            .get("config")
            .map_or_else(|| stringify(&Js::from_jsonb(value)), stringify),
        _ => stringify(&Js::from_jsonb(value)),
    }
}

/// `computeChanges(existing, data)`: what the body set that differs from
/// the stored row, compared as JSON text.
fn definition_changes(
    existing: &Value,
    data: &Map<String, Value>,
    body: &Js,
) -> Option<Map<String, Value>> {
    let mut changes = Map::new();
    for (key, value) in data {
        if key == "updatedAt" {
            continue;
        }
        let old = existing.get(key).cloned().unwrap_or(Value::Null);
        if stringify(&Js::from_jsonb(&old)) != input_json(key, value, body) {
            changes.insert(key.clone(), json!({ "old": old, "new": value }));
        }
    }
    (!changes.is_empty()).then_some(changes)
}

async fn update(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match field_input(&headers, &body, false) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let existing = fetch(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom field definition", &id))?;
        let next_type = input.field_type.as_set().cloned().unwrap_or_else(|| {
            existing["fieldType"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        });
        let next_options = input
            .options
            .as_set()
            .map(|o| Value::Array(o.clone()))
            .or_else(|| Some(existing["options"].clone()).filter(|o| !o.is_null()));
        let touches = !input.field_type.is_absent() || !input.options.is_absent();
        if touches && !has_usable_select_options(&next_type, next_options.as_ref()) {
            return Err(Refusal::bad_request(format!(
                "A {next_type} field needs at least one option"
            )));
        }
        definition_update(&input)?
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let updated = fetch(&caller.db, &id).await?;
        if let Some(changes) = definition_changes(&existing, &input.data, &parse_body(&body)) {
            let mut data = Map::new();
            data.insert("id".to_owned(), json!(id));
            data.extend(input.data);
            caller.publish_with_changes(
                &state,
                CUSTOM_FIELD_UPDATED,
                &id,
                Value::Object(data),
                Some(changes),
            );
        }
        Ok(Data(updated.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to update custom field definition")
}

/// The columns a `PUT` sets: only the fields the body sent.
fn definition_update(input: &FieldInput) -> Result<sea_orm::UpdateMany<Entity>, DbErr> {
    let mut update = Entity::update_many();
    if let (true, name) = change(&input.name) {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let (true, description) = change(&input.description) {
        update = update.col_expr(Column::Description, Expr::value(description));
    }
    if let (true, field_type) = change(&input.field_type) {
        update = update.col_expr(Column::FieldType, Expr::value(field_type));
    }
    if let (true, options) = change(&input.options) {
        update = update.col_expr(Column::Options, Expr::value(options.map(Value::Array)));
    }
    if let (true, config) = change(&input.config) {
        let config = config.as_ref().map(crate::js::whole_numbers);
        update = update.col_expr(Column::Config, Expr::value(config));
    }
    if let (true, required) = change(&input.required) {
        update = update.col_expr(Column::Required, Expr::value(required));
    }
    if let (true, order) = change(&input.sort_order) {
        update = update.col_expr(Column::SortOrder, Expr::value(order.map(int4).transpose()?));
    }
    if let (true, group) = change(&input.group) {
        update = update.col_expr(Column::Group, Expr::value(group));
    }
    Ok(update)
}

// ── DELETE /:id ────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        fetch(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom field definition", &id))?;
        let now = utc_now();
        Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(now))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, CUSTOM_FIELD_DELETED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "deleted": true })).into_response())
    }
    .await;
    answer(result, "Failed to delete custom field definition")
}
