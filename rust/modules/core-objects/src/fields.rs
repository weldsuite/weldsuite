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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOM_FIELD_CREATED, CUSTOM_FIELD_DELETED, CUSTOM_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys::{SETTINGS_MANAGE, SETTINGS_READ};
use weldsuite_events::is_custom_object_entity_key;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, js_trim};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{Js, parse_body, stringify};
use crate::objects::{field_json, reorder_items};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, STAMPS, answer, change, now, row,
    validate, validate_query,
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
fn definitions(rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter().map(|r| row(r, &STAMPS)).collect()
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from custom_field_definitions d
              where deleted_at is null and ($1::text is null or entity_type = $1)
              order by sort_order asc, created_at asc",
        )
        .bind(entity_type)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(definitions(rows)).into_response())
    }
    .await;
    answer(result, "Failed to list custom field definitions")
}

async fn grouped(caller: Caller) -> Response {
    let result: Answer = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from custom_field_definitions d
              where deleted_at is null order by entity_type asc, sort_order asc",
        )
        .fetch_all(&caller.db)
        .await?;
        let mut out = Map::new();
        for field in definitions(rows) {
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

async fn fetch(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from custom_field_definitions d where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(raw.map(|r| row(r, &STAMPS)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let field = fetch(&caller, &id)
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
        for (id, order) in &items {
            sqlx::query(
                "update custom_field_definitions set sort_order = $2::int, updated_at = $3::timestamp
                  where id = $1 and deleted_at is null",
            )
            .bind(id)
            .bind(order)
            .bind(now())
            .execute(&caller.db)
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
        let db = &caller.db;
        if is_custom_object_entity_key(&input.entity_type) && is_reserved_field_slug(&input.slug) {
            return Err(Refusal::bad_request(format!(
                "'{}' is reserved and cannot be used as a field name on a custom object",
                input.slug
            )));
        }
        let ticket_type = input.ticket_type_id.as_set().filter(|t| !t.is_empty());
        let existing: Option<String> = sqlx::query_scalar(
            "select id from custom_field_definitions
              where entity_type = $1 and slug = $2 and deleted_at is null
                and (case when $3::text is null then ticket_type_id is null else ticket_type_id = $3 end)
              limit 1",
        )
        .bind(&input.entity_type)
        .bind(&input.slug)
        .bind(ticket_type)
        .fetch_optional(db)
        .await?;
        if existing.is_some() {
            return Err(Refusal::conflict(format!(
                "A custom field with slug '{}' already exists for entity type '{}'",
                input.slug, input.entity_type
            )));
        }
        let id = generate_id("cfld");
        sqlx::query(
            "insert into custom_field_definitions
                 (id, entity_type, name, slug, description, field_type, options, config, required,
                  sort_order, \"group\", ticket_type_id, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $11, $12, $13::timestamp, $13::timestamp)",
        )
        .bind(&id)
        .bind(&input.entity_type)
        .bind(input.name.as_set())
        .bind(&input.slug)
        .bind(input.description.as_set())
        .bind(&field_type)
        .bind(&options)
        .bind(input.config.as_set().map(crate::js::whole_numbers))
        .bind(input.required.as_set().copied().unwrap_or(false))
        .bind(input.sort_order.as_set().copied().unwrap_or(0))
        .bind(input.group.as_set())
        .bind(input.ticket_type_id.as_set())
        .bind(now())
        .execute(db)
        .await?;
        let created = fetch(&caller, &id).await?;
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
        let db = &caller.db;
        let existing = fetch(&caller, &id)
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
        let (set_name, name) = change(&input.name);
        let (set_description, description) = change(&input.description);
        let (set_type, field_type) = change(&input.field_type);
        let (set_options, options) = change(&input.options);
        let (set_config, config) = change(&input.config);
        let (set_required, required) = change(&input.required);
        let (set_order, order) = change(&input.sort_order);
        let (set_group, group) = change(&input.group);
        sqlx::query(
            "update custom_field_definitions set
                 name = case when $2 then $3 else name end,
                 description = case when $4 then $5 else description end,
                 field_type = case when $6 then $7 else field_type end,
                 options = case when $8 then $9 else options end,
                 config = case when $10 then $11 else config end,
                 required = case when $12 then $13 else required end,
                 sort_order = case when $14 then $15::int else sort_order end,
                 \"group\" = case when $16 then $17 else \"group\" end,
                 updated_at = $18::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(set_name)
        .bind(name)
        .bind(set_description)
        .bind(description)
        .bind(set_type)
        .bind(field_type)
        .bind(set_options)
        .bind(options.map(Value::Array))
        .bind(set_config)
        .bind(config.as_ref().map(crate::js::whole_numbers))
        .bind(set_required)
        .bind(required)
        .bind(set_order)
        .bind(order)
        .bind(set_group)
        .bind(group)
        .bind(now())
        .execute(db)
        .await?;
        let updated = fetch(&caller, &id).await?;
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

// ── DELETE /:id ────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        fetch(&caller, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom field definition", &id))?;
        let now = now();
        sqlx::query(
            "update custom_field_definitions set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, CUSTOM_FIELD_DELETED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "deleted": true })).into_response())
    }
    .await;
    answer(result, "Failed to delete custom field definition")
}
