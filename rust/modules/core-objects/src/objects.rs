//! `/api/custom-objects`: object type definitions (`routes/custom-objects`,
//! with `@weldsuite/db/lib/custom-objects`). Listing and reading need
//! `weldobjects:read` or `weldobjects:manage`; everything that changes a
//! definition needs `weldobjects:manage`.

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
use weldsuite_catalogs::permission_keys::{WELDOBJECTS_MANAGE, WELDOBJECTS_READ};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::links::find_restricting_links;
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, STAMPS, all, answer, change, now, row,
    validate, validate_query,
};

const STATUSES: [&str; 3] = ["draft", "active", "disabled"];
const SLUG_MESSAGE: &str =
    "Slug must start with a letter and contain only lowercase letters, numbers and underscores";
const RESERVED_OBJECT_SLUGS: [&str; 34] = [
    "company",
    "companies",
    "person",
    "people",
    "contact",
    "contacts",
    "lead",
    "leads",
    "opportunity",
    "opportunities",
    "ticket",
    "tickets",
    "conversation",
    "conversations",
    "project",
    "projects",
    "task",
    "tasks",
    "product",
    "products",
    "order",
    "orders",
    "invoice",
    "invoices",
    "quote",
    "quotes",
    "user",
    "users",
    "settings",
    "new",
    "edit",
    "create",
    "admin",
    "api",
];

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WELDOBJECTS_READ, WELDOBJECTS_MANAGE]);
    let manage = || gate.require([WELDOBJECTS_MANAGE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(manage()))
        .route("/reorder", put(reorder).route_layer(manage()))
        // Hono answers `GET /reorder` with `GET /:id`.
        .route("/reorder", get(detail_reorder).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", put(update).route_layer(manage()))
        .route("/{id}", delete(remove).route_layer(manage()))
        .route(
            "/{id}/delete-impact",
            get(delete_impact).route_layer(manage()),
        )
}

/// `^[a-z][a-z0-9_]*$`.
pub(crate) fn is_lower_slug(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A live `custom_objects` row: the parts the routes read, and the row as
/// Drizzle returns it.
#[derive(Debug, Clone)]
pub(crate) struct CustomObject {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) entity_key: String,
    pub(crate) label_singular: String,
    pub(crate) label_plural: String,
    pub(crate) title_field_id: Option<String>,
    pub(crate) status: String,
    pub(crate) enable_events: bool,
    pub(crate) enable_search: bool,
    pub(crate) row: Value,
}

impl CustomObject {
    fn from_row(raw: Value) -> Self {
        let row = row(raw, &STAMPS);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            slug: text("slug"),
            entity_key: text("entityKey"),
            label_singular: text("labelSingular"),
            label_plural: text("labelPlural"),
            title_field_id: row["titleFieldId"].as_str().map(str::to_owned),
            status: text("status"),
            enable_events: row["enableEvents"] == true,
            enable_search: row["enableSearch"] == true,
            row,
        }
    }
}

/// The live object with this id.
pub(crate) async fn object_by_id(
    db: &PgPool,
    id: &str,
) -> Result<Option<CustomObject>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(o) from custom_objects o where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(raw.map(CustomObject::from_row))
}

/// The live object with this slug (`getCustomObjectBySlug`).
pub(crate) async fn object_by_slug(
    db: &PgPool,
    slug: &str,
) -> Result<Option<CustomObject>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(o) from custom_objects o where slug = $1 and deleted_at is null limit 1",
    )
    .bind(slug)
    .fetch_optional(db)
    .await?;
    Ok(raw.map(CustomObject::from_row))
}

/// `{ [entityKey]: { recordCount, fieldCount } }` (`getCustomObjectCounts`).
async fn counts(db: &PgPool, keys: &[String]) -> Result<Map<String, Value>, sqlx::Error> {
    let mut out = Map::new();
    for key in keys {
        out.insert(key.clone(), json!({ "recordCount": 0, "fieldCount": 0 }));
    }
    if keys.is_empty() {
        return Ok(out);
    }
    let records: Vec<(String, i64)> = sqlx::query_as(
        "select entity_key, count(*) from custom_object_records
          where entity_key = any($1) and deleted_at is null group by entity_key",
    )
    .bind(keys)
    .fetch_all(db)
    .await?;
    let fields: Vec<(String, i64)> = sqlx::query_as(
        "select entity_type, count(*) from custom_field_definitions
          where entity_type = any($1) and deleted_at is null group by entity_type",
    )
    .bind(keys)
    .fetch_all(db)
    .await?;
    for (key, count) in records {
        if let Some(entry) = out.get_mut(&key) {
            entry["recordCount"] = json!(count);
        }
    }
    for (key, count) in fields {
        if let Some(entry) = out.get_mut(&key) {
            entry["fieldCount"] = json!(count);
        }
    }
    Ok(out)
}

/// The row with `recordCount` and `fieldCount` added.
fn with_counts(mut row: Value, key: &str, counts: &Map<String, Value>) -> Value {
    let count = |name: &str| {
        counts
            .get(key)
            .and_then(|c| c.get(name))
            .cloned()
            .unwrap_or(json!(0))
    };
    row["recordCount"] = count("recordCount");
    row["fieldCount"] = count("fieldCount");
    row
}

// ── GET / ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let status = match validate_query(query.as_deref(), |issues, values| {
        issues.text(values, "status", Presence::Optional, None, None)
    }) {
        Ok(status) => status.into_option().filter(|status| !status.is_empty()),
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(o) from custom_objects o
              where deleted_at is null and ($1::text is null or status = $1)
              order by sort_order asc, label_plural asc",
        )
        .bind(status)
        .fetch_all(&caller.db)
        .await?;
        let objects: Vec<CustomObject> = rows.into_iter().map(CustomObject::from_row).collect();
        let keys: Vec<String> = objects.iter().map(|o| o.entity_key.clone()).collect();
        let counts = counts(&caller.db, &keys).await?;
        let data = objects
            .into_iter()
            .map(|o| with_counts(o.row, &o.entity_key, &counts))
            .collect();
        Ok(all(data))
    }
    .await;
    answer(result, "Failed to list custom objects")
}

// ── GET /:id ───────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    show(caller, id).await
}

async fn detail_reorder(caller: Caller) -> Response {
    show(caller, "reorder".to_owned()).await
}

async fn show(caller: Caller, id: String) -> Response {
    let result: Answer = async {
        let object = object_by_id(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        let counts = counts(&caller.db, std::slice::from_ref(&object.entity_key)).await?;
        Ok(Data(with_counts(object.row, &object.entity_key, &counts)).into_response())
    }
    .await;
    answer(result, "Failed to fetch custom object")
}

// ── GET /:id/delete-impact ─────────────────────────────────────────────────

/// `getDeleteImpact`: what deleting the object would destroy.
async fn impact(db: &PgPool, entity_key: &str) -> Result<Value, sqlx::Error> {
    let (records, fields, links, relations): (i64, i64, i64, i64) = sqlx::query_as(
        "select
             (select count(*) from custom_object_records where entity_key = $1 and deleted_at is null),
             (select count(*) from custom_field_definitions where entity_type = $1 and deleted_at is null),
             (select count(*) from custom_object_links
               where (source_entity_key = $1 or target_entity_key = $1) and deleted_at is null),
             (select count(*) from custom_object_relations
               where source_entity_key = $1 or target_entity_key = $1)",
    )
    .bind(entity_key)
    .fetch_one(db)
    .await?;
    Ok(json!({
        "recordCount": records,
        "fieldCount": fields,
        "linkCount": links,
        "relationCount": relations,
    }))
}

async fn delete_impact(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let object = object_by_id(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        let mut data = impact(&caller.db, &object.entity_key).await?;
        data["blockedBy"] = json!(find_restricting_links(&caller.db, &object.entity_key).await?);
        Ok(Data(data).into_response())
    }
    .await;
    answer(result, "Failed to compute delete impact")
}

// ── PUT /reorder ───────────────────────────────────────────────────────────

/// `{ items: [{ id, sortOrder }] }` (`reorderCustomObjectsSchema`, and the
/// custom fields' one).
pub(crate) fn reorder_items(issues: &mut Issues, body: &Map<String, Value>) -> Vec<(String, i64)> {
    issues
        .list(
            body,
            "items",
            Presence::Required,
            None,
            None,
            |issues, item| {
                let fields = issues.object(item)?;
                let id = issues.text(fields, "id", Presence::Required, None, None);
                let order = issues.integer(fields, "sortOrder", Presence::Required, None);
                Some((id.into_option()?, order.into_option()?))
            },
        )
        .into_option()
        .unwrap_or_default()
}

async fn reorder(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let items = match validate(&headers, &body, reorder_items) {
        Ok(items) => items,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let now = now();
        let mut statements = Vec::with_capacity(items.len());
        for (id, order) in &items {
            statements.push(
                sqlx::query(
                    "update custom_objects set sort_order = $2::int, updated_at = $3::timestamp
                  where id = $1 and deleted_at is null",
                )
                .bind(id)
                .bind(order)
                .bind(&now),
            );
        }
        weldsuite_db::atomically(&caller.db, statements).await?;
        Ok(Data(json!({ "reordered": items.len() })).into_response())
    }
    .await;
    answer(result, "Failed to reorder custom objects")
}

// ── POST /, PUT /:id ───────────────────────────────────────────────────────

/// `customObjectListConfigSchema`: what Zod keeps of it.
fn list_config(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    issues.nested(body, "listConfig", Presence::Optional, |issues, config| {
        let columns = issues.list(
            config,
            "columns",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        );
        let sort = issues.nested(config, "defaultSort", Presence::Optional, |issues, sort| {
            let key = issues.text(sort, "key", Presence::Required, None, None);
            let direction = issues.choice(sort, "direction", Presence::Required, &["asc", "desc"]);
            json!({ "key": key.into_option(), "direction": direction.into_option() })
        });
        let mut out = Map::new();
        if let Field::Set(columns) = columns {
            out.insert("columns".to_owned(), json!(columns));
        }
        if let Field::Set(sort) = sort {
            out.insert("defaultSort".to_owned(), sort);
        }
        Value::Object(out)
    })
}

/// `createCustomObjectSchema` / `updateCustomObjectSchema`, as Zod's output:
/// the fields the body set, in a map for the event, plus the parts the
/// routes write.
struct ObjectInput {
    data: Map<String, Value>,
    slug: String,
    label_singular: Field<String>,
    label_plural: Field<String>,
    description: Field<String>,
    icon: Field<String>,
    color: Field<String>,
    status: Field<String>,
    title_field_id: Field<String>,
    enable_events: Field<bool>,
    enable_search: Field<bool>,
    enable_agent_tools: Field<bool>,
    enable_external_api: Field<bool>,
    list_config: Field<Value>,
    sort_order: Field<i64>,
}

fn object_input(headers: &HeaderMap, body: &Bytes, create: bool) -> Result<ObjectInput, Rejected> {
    validate(headers, body, |issues, fields| {
        let slug = if create {
            let slug = issues.pattern(
                fields,
                "slug",
                Presence::Required,
                Some(1),
                Some(24),
                is_lower_slug,
                SLUG_MESSAGE,
            );
            slug.into_option().unwrap_or_default()
        } else {
            String::new()
        };
        let label = if create {
            Presence::Required
        } else {
            Presence::Optional
        };
        let nullish = if create {
            Presence::Optional
        } else {
            Presence::Nullish
        };
        let label_singular = issues.text(fields, "labelSingular", label, Some(1), Some(100));
        let label_plural = issues.text(fields, "labelPlural", label, Some(1), Some(100));
        let description = issues.text(fields, "description", nullish, None, Some(500));
        let icon = issues.text(fields, "icon", Presence::Optional, None, Some(50));
        let color = issues.text(fields, "color", nullish, None, Some(20));
        let status = issues.choice(fields, "status", Presence::Optional, &STATUSES);
        let title_field_id = if create {
            Field::Absent
        } else {
            issues.text(fields, "titleFieldId", Presence::Nullish, None, Some(30))
        };
        let enable_events = issues.boolean(fields, "enableEvents", Presence::Optional);
        let enable_search = issues.boolean(fields, "enableSearch", Presence::Optional);
        let enable_agent_tools = issues.boolean(fields, "enableAgentTools", Presence::Optional);
        let enable_external_api = issues.boolean(fields, "enableExternalApi", Presence::Optional);
        let list_config = list_config(issues, fields);
        let sort_order =
            issues.whole_number(fields, "sortOrder", Presence::Optional, Number::default());
        // The refinement's issue comes after the body's other issues.
        if create
            && let Some(Value::String(text)) = fields.get("slug")
            && RESERVED_OBJECT_SLUGS.contains(&text.as_str())
        {
            issues.custom(
                "slug",
                "That name is reserved by a built-in WeldSuite object",
            );
        }

        let mut data = Map::new();
        if create {
            data.insert("slug".to_owned(), json!(slug));
        }
        let mut put = |key: &str, value: Option<Value>| {
            if let Some(value) = value {
                data.insert(key.to_owned(), value);
            }
        };
        put("labelSingular", field_json(&label_singular));
        put("labelPlural", field_json(&label_plural));
        put("description", field_json(&description));
        put("icon", field_json(&icon));
        put("color", field_json(&color));
        put("status", field_json(&status));
        put("titleFieldId", field_json(&title_field_id));
        put("enableEvents", field_json(&enable_events));
        put("enableSearch", field_json(&enable_search));
        put("enableAgentTools", field_json(&enable_agent_tools));
        put("enableExternalApi", field_json(&enable_external_api));
        put("listConfig", field_json(&list_config));
        put("sortOrder", field_json(&sort_order));
        ObjectInput {
            data,
            slug,
            label_singular,
            label_plural,
            description,
            icon,
            color,
            status,
            title_field_id,
            enable_events,
            enable_search,
            enable_agent_tools,
            enable_external_api,
            list_config,
            sort_order,
        }
    })
}

/// A field as Zod's output holds it: absent, `null` or the value.
pub(crate) fn field_json<T: serde::Serialize>(field: &Field<T>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(value) => serde_json::to_value(value).ok(),
    }
}

/// `{ id, kind, ...data }`: the definition events' payload.
fn event_data(id: &str, kind: &str, data: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), json!(id));
    out.insert("kind".to_owned(), json!(kind));
    for (key, value) in data {
        out.insert(key.clone(), value.clone());
    }
    Value::Object(out)
}

async fn create(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match object_input(&headers, &body, true) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let taken = format!(
        "A custom object with the name '{}' already exists",
        input.slug
    );
    let result: Answer = async {
        let existing: Option<(String, bool)> = sqlx::query_as(
            "select id, deleted_at is not null from custom_objects where slug = $1 limit 1",
        )
        .bind(&input.slug)
        .fetch_optional(&caller.db)
        .await?;
        if let Some((_, deleted)) = existing {
            return Err(Refusal::conflict(if deleted {
                format!("The name '{}' belonged to a deleted object and cannot be reused", input.slug)
            } else {
                taken.clone()
            }));
        }
        let id = generate_id("cobj");
        let now = now();
        let inserted = sqlx::query(
            "insert into custom_objects
                 (id, slug, entity_key, label_singular, label_plural, description, icon, color, status,
                  enable_events, enable_search, enable_agent_tools, enable_external_api, list_config,
                  sort_order, created_by, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::int, $16,
                     $17::timestamp, $17::timestamp)",
        )
        .bind(&id)
        .bind(&input.slug)
        .bind(format!("co_{}", input.slug))
        .bind(input.label_singular.as_set())
        .bind(input.label_plural.as_set())
        .bind(input.description.as_set())
        .bind(input.icon.as_set().map_or("Box", String::as_str))
        .bind(input.color.as_set())
        .bind(input.status.as_set().map_or("draft", String::as_str))
        .bind(input.enable_events.as_set().copied().unwrap_or(true))
        .bind(input.enable_search.as_set().copied().unwrap_or(false))
        .bind(input.enable_agent_tools.as_set().copied().unwrap_or(false))
        .bind(input.enable_external_api.as_set().copied().unwrap_or(false))
        .bind(input.list_config.as_set().cloned().unwrap_or_else(|| json!({})))
        .bind(input.sort_order.as_set().copied().unwrap_or(0))
        .bind(&caller.user_id)
        .bind(&now)
        .execute(&caller.db)
        .await;
        if let Err(error) = inserted {
            // Two creates racing past the check: the unique index decides.
            if weldsuite_db::is_unique_violation(&error) {
                return Err(Refusal::conflict(taken.clone()));
            }
            return Err(error.into());
        }
        let created: Option<Value> = sqlx::query_scalar("select to_jsonb(o) from custom_objects o where id = $1 limit 1")
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
        let Some(created) = created else {
            return Err(ApiError::internal().with_message("Failed to create custom object").into());
        };
        caller.publish(&state, CUSTOM_FIELD_CREATED, &id, &event_data(&id, "custom_object", &input.data));
        Ok(Created(row(created, &STAMPS)).into_response())
    }
    .await;
    answer(result, "Failed to create custom object")
}

#[allow(clippy::too_many_lines)]
async fn update(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match object_input(&headers, &body, false) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let db = &caller.db;
        let existing = object_by_id(db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        if let Some(title_field_id) = input.title_field_id.as_set().filter(|t| !t.is_empty()) {
            let found: Option<String> = sqlx::query_scalar(
                "select id from custom_field_definitions
                  where id = $1 and entity_type = $2 and deleted_at is null limit 1",
            )
            .bind(title_field_id)
            .bind(&existing.entity_key)
            .fetch_optional(db)
            .await?;
            if found.is_none() {
                return Err(Refusal::bad_request(
                    "titleFieldId must reference a field belonging to this object",
                ));
            }
        }
        // The index goes first, so a failure leaves the flag on to retry.
        if existing.enable_search && input.enable_search.as_set() == Some(&false) {
            sqlx::query("delete from search_index where entity_type = $1")
                .bind(&existing.entity_key)
                .execute(db)
                .await?;
        }
        let (set_singular, singular) = change(&input.label_singular);
        let (set_plural, plural) = change(&input.label_plural);
        let (set_description, description) = change(&input.description);
        let (set_icon, icon) = change(&input.icon);
        let (set_color, color) = change(&input.color);
        let (set_status, status) = change(&input.status);
        let (set_title, title) = change(&input.title_field_id);
        let (set_events, events) = change(&input.enable_events);
        let (set_search, search) = change(&input.enable_search);
        let (set_agent, agent) = change(&input.enable_agent_tools);
        let (set_external, external) = change(&input.enable_external_api);
        let (set_config, config) = change(&input.list_config);
        let (set_order, order) = change(&input.sort_order);
        sqlx::query(
            "update custom_objects set
                 label_singular = case when $2 then $3 else label_singular end,
                 label_plural = case when $4 then $5 else label_plural end,
                 description = case when $6 then $7 else description end,
                 icon = case when $8 then $9 else icon end,
                 color = case when $10 then $11 else color end,
                 status = case when $12 then $13 else status end,
                 title_field_id = case when $14 then $15 else title_field_id end,
                 enable_events = case when $16 then $17 else enable_events end,
                 enable_search = case when $18 then $19 else enable_search end,
                 enable_agent_tools = case when $20 then $21 else enable_agent_tools end,
                 enable_external_api = case when $22 then $23 else enable_external_api end,
                 list_config = case when $24 then $25 else list_config end,
                 sort_order = case when $26 then $27::int else sort_order end,
                 updated_at = $28::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(set_singular)
        .bind(singular)
        .bind(set_plural)
        .bind(plural)
        .bind(set_description)
        .bind(description)
        .bind(set_icon)
        .bind(icon)
        .bind(set_color)
        .bind(color)
        .bind(set_status)
        .bind(status)
        .bind(set_title)
        .bind(title)
        .bind(set_events)
        .bind(events)
        .bind(set_search)
        .bind(search)
        .bind(set_agent)
        .bind(agent)
        .bind(set_external)
        .bind(external)
        .bind(set_config)
        .bind(config)
        .bind(set_order)
        .bind(order)
        .bind(now())
        .execute(db)
        .await?;
        let updated: Option<Value> =
            sqlx::query_scalar("select to_jsonb(o) from custom_objects o where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(db)
                .await?;
        caller.publish(
            &state,
            CUSTOM_FIELD_UPDATED,
            &id,
            &event_data(&id, "custom_object", &input.data),
        );
        Ok(Data(updated.map_or(Value::Null, |u| row(u, &STAMPS))).into_response())
    }
    .await;
    answer(result, "Failed to update custom object")
}

// ── DELETE /:id ────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let confirm = crate::query_param(query.as_deref(), "confirm");
    let result: Answer = async {
        let db = &caller.db;
        let existing = object_by_id(db, &id).await?.ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        if confirm.as_deref() != Some(existing.slug.as_str()) {
            let impact = impact(db, &existing.entity_key).await?;
            let message = format!(
                "Deleting '{}' will remove {} record(s), {} field(s) and {} relationship(s). Re-send with ?confirm={} to proceed.",
                existing.label_plural, impact["recordCount"], impact["fieldCount"], impact["relationCount"], existing.slug
            );
            return Err(ApiError::bad_request(message).with_details(impact).into());
        }
        let restricting = find_restricting_links(db, &existing.entity_key).await?;
        if !restricting.is_empty() {
            let message = format!(
                "'{}' is still linked from {}, and those relationships are set to block deletion. Remove those links or change their delete rule first.",
                existing.label_plural,
                restricting.join(", ")
            );
            return Err(ApiError::conflict(message).with_details(json!({ "blockedBy": restricting })).into());
        }
        let now = now();
        let key = existing.entity_key.as_str();
        // One unit, the definition last: a failure leaves the object intact.
        weldsuite_db::atomically(
            db,
            [
                sqlx::query(
                    "delete from custom_field_values where entity_type = $1
                        and entity_id in (select id from custom_object_records where entity_key = $1)",
                )
                .bind(key),
                sqlx::query("delete from custom_object_relations where source_entity_key = $1 or target_entity_key = $1")
                    .bind(key),
                sqlx::query(
                    "update custom_object_links set deleted_at = $2::timestamp, updated_at = $2::timestamp
                      where source_entity_key = $1 or target_entity_key = $1",
                )
                .bind(key)
                .bind(&now),
                sqlx::query(
                    "update custom_object_records set deleted_at = $2::timestamp, updated_at = $2::timestamp
                      where entity_key = $1",
                )
                .bind(key)
                .bind(&now),
                sqlx::query(
                    "update custom_field_definitions set deleted_at = $2::timestamp, updated_at = $2::timestamp
                      where entity_type = $1",
                )
                .bind(key)
                .bind(&now),
                sqlx::query("delete from search_index where entity_type = $1").bind(key),
                sqlx::query(
                    "update custom_objects set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
                )
                .bind(&existing.id)
                .bind(&now),
            ],
        )
        .await?;
        caller.publish(
            &state,
            CUSTOM_FIELD_DELETED,
            &id,
            &json!({ "id": id, "kind": "custom_object", "slug": existing.slug }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete custom object")
}
