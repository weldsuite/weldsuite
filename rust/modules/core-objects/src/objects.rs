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
use sea_orm::sea_query::{Asterisk, Expr, Func, Query, SelectStatement, SubQueryStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DatabaseConnection, DbErr,
    EntityTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    CUSTOM_FIELD_CREATED, CUSTOM_FIELD_DELETED, CUSTOM_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys::{WELDOBJECTS_MANAGE, WELDOBJECTS_READ};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    custom_field_definitions, custom_field_values, custom_object_links, custom_object_records,
    custom_object_relations, custom_objects, search_index,
};

use crate::links::find_restricting_links;
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, all, answer, change, int4, json_row,
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
    fn from_model(model: custom_objects::Model) -> Result<Self, DbErr> {
        let row = json_row(&model)?;
        Ok(Self {
            id: model.id,
            slug: model.slug,
            entity_key: model.entity_key,
            label_singular: model.label_singular,
            label_plural: model.label_plural,
            title_field_id: model.title_field_id,
            status: model.status,
            enable_events: model.enable_events,
            enable_search: model.enable_search,
            row,
        })
    }
}

/// The live object that `condition` picks.
async fn live_object(db: &PgPool, condition: Condition) -> Result<Option<CustomObject>, DbErr> {
    let object = custom_objects::Entity::find()
        .filter(condition)
        .filter(custom_objects::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    object.map(CustomObject::from_model).transpose()
}

/// The live object with this id.
pub(crate) async fn object_by_id(db: &PgPool, id: &str) -> Result<Option<CustomObject>, DbErr> {
    live_object(db, Condition::all().add(custom_objects::Column::Id.eq(id))).await
}

/// The live object with this slug (`getCustomObjectBySlug`).
pub(crate) async fn object_by_slug(db: &PgPool, slug: &str) -> Result<Option<CustomObject>, DbErr> {
    live_object(
        db,
        Condition::all().add(custom_objects::Column::Slug.eq(slug)),
    )
    .await
}

/// The object with this id, deleted or not, as Drizzle returns it.
async fn object_row(db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
    let object = custom_objects::Entity::find_by_id(id).one(db).await?;
    object.map(json_row).transpose()
}

/// `{ [entityKey]: { recordCount, fieldCount } }` (`getCustomObjectCounts`).
async fn counts(db: &PgPool, keys: &[String]) -> Result<Map<String, Value>, DbErr> {
    let mut out = Map::new();
    for key in keys {
        out.insert(key.clone(), json!({ "recordCount": 0, "fieldCount": 0 }));
    }
    if keys.is_empty() {
        return Ok(out);
    }
    let db = &orm(db);
    let records: Vec<(String, i64)> = {
        use custom_object_records::Column;
        custom_object_records::Entity::find()
            .select_only()
            .column(Column::EntityKey)
            .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
            .filter(Column::EntityKey.is_in(keys.iter().map(String::as_str)))
            .filter(Column::DeletedAt.is_null())
            .group_by(Column::EntityKey)
            .into_tuple()
            .all(db)
            .await?
    };
    let fields: Vec<(String, i64)> = {
        use custom_field_definitions::Column;
        custom_field_definitions::Entity::find()
            .select_only()
            .column(Column::EntityType)
            .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
            .filter(Column::EntityType.is_in(keys.iter().map(String::as_str)))
            .filter(Column::DeletedAt.is_null())
            .group_by(Column::EntityType)
            .into_tuple()
            .all(db)
            .await?
    };
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
        use custom_objects::Column;
        let rows = custom_objects::Entity::find()
            .filter(Column::DeletedAt.is_null())
            .apply_if(status, |query, status| {
                query.filter(Column::Status.eq(status))
            })
            .order_by_asc(Column::SortOrder)
            .order_by_asc(Column::LabelPlural)
            .all(&orm(&caller.db))
            .await?;
        let objects = rows
            .into_iter()
            .map(CustomObject::from_model)
            .collect::<Result<Vec<_>, _>>()?;
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

/// `(select count(*) from … where …)`: a count as one column of a select.
fn count_of<E: EntityTrait>(condition: Condition) -> Expr {
    let count: SelectStatement = E::find()
        .select_only()
        .expr(Func::count(Expr::col(Asterisk)))
        .filter(condition)
        .into_query();
    Expr::SubQuery(None, Box::new(SubQueryStatement::SelectStatement(count)))
}

/// `getDeleteImpact`: what deleting the object would destroy, counted in one
/// statement.
async fn impact(db: &PgPool, entity_key: &str) -> Result<Value, DbErr> {
    // `source = key or target = key`.
    fn either<C: ColumnTrait>(source: C, target: C, entity_key: &str) -> Condition {
        Condition::any()
            .add(source.eq(entity_key))
            .add(target.eq(entity_key))
    }
    let statement = Query::select()
        .expr_as(
            count_of::<custom_object_records::Entity>(
                Condition::all()
                    .add(custom_object_records::Column::EntityKey.eq(entity_key))
                    .add(custom_object_records::Column::DeletedAt.is_null()),
            ),
            "records",
        )
        .expr_as(
            count_of::<custom_field_definitions::Entity>(
                Condition::all()
                    .add(custom_field_definitions::Column::EntityType.eq(entity_key))
                    .add(custom_field_definitions::Column::DeletedAt.is_null()),
            ),
            "fields",
        )
        .expr_as(
            count_of::<custom_object_links::Entity>(
                Condition::all()
                    .add(either(
                        custom_object_links::Column::SourceEntityKey,
                        custom_object_links::Column::TargetEntityKey,
                        entity_key,
                    ))
                    .add(custom_object_links::Column::DeletedAt.is_null()),
            ),
            "links",
        )
        .expr_as(
            count_of::<custom_object_relations::Entity>(either(
                custom_object_relations::Column::SourceEntityKey,
                custom_object_relations::Column::TargetEntityKey,
                entity_key,
            )),
            "relations",
        )
        .to_owned();
    let row = orm(db)
        .query_one(&statement)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("the delete impact counts".to_owned()))?;
    let count = |column: &str| row.try_get::<i64>("", column);
    let (records, fields, links, relations) = (
        count("records")?,
        count("fields")?,
        count("links")?,
        count("relations")?,
    );
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
        use custom_objects::Column;
        let now = utc_now();
        let mut statements = Vec::with_capacity(items.len());
        for (id, order) in &items {
            statements.push(
                custom_objects::Entity::update_many()
                    .col_expr(Column::SortOrder, Expr::value(int4(*order)?))
                    .col_expr(Column::UpdatedAt, Expr::value(now))
                    .filter(Column::Id.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            );
        }
        weldsuite_db::atomically_with(&caller.db, |tx| {
            Box::pin(async move {
                let tx = OrmConn::new(tx);
                for statement in statements {
                    statement.exec(&tx).await?;
                }
                Ok::<_, Refusal>(())
            })
        })
        .await?;
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
        let db = &orm(&caller.db);
        let existing: Option<(String, Option<PrimitiveDateTime>)> = custom_objects::Entity::find()
            .select_only()
            .columns([
                custom_objects::Column::Id,
                custom_objects::Column::DeletedAt,
            ])
            .filter(custom_objects::Column::Slug.eq(&input.slug))
            .into_tuple()
            .one(db)
            .await?;
        if let Some((_, deleted_at)) = existing {
            return Err(Refusal::conflict(if deleted_at.is_some() {
                format!(
                    "The name '{}' belonged to a deleted object and cannot be reused",
                    input.slug
                )
            } else {
                taken.clone()
            }));
        }
        let id = generate_id("cobj");
        let inserted = custom_objects::Entity::insert(new_object(&id, &input, &caller.user_id)?)
            .exec_without_returning(db)
            .await;
        if let Err(error) = inserted {
            // Two creates racing past the check: the unique index decides.
            if weldsuite_db::is_unique_violation(&error) {
                return Err(Refusal::conflict(taken.clone()));
            }
            return Err(error.into());
        }
        let created = object_row(db, &id).await?;
        let Some(created) = created else {
            return Err(ApiError::internal()
                .with_message("Failed to create custom object")
                .into());
        };
        caller.publish(
            &state,
            CUSTOM_FIELD_CREATED,
            &id,
            &event_data(&id, "custom_object", &input.data),
        );
        Ok(Created(created).into_response())
    }
    .await;
    answer(result, "Failed to create custom object")
}

/// The row a `POST` inserts: what the body set, the schema's defaults for
/// the rest.
fn new_object(
    id: &str,
    input: &ObjectInput,
    user_id: &str,
) -> Result<custom_objects::ActiveModel, DbErr> {
    let now = utc_now();
    let text = |field: &Field<String>| field.as_set().cloned();
    let flag = |field: &Field<bool>, default: bool| field.as_set().copied().unwrap_or(default);
    Ok(custom_objects::ActiveModel {
        id: Set(id.to_owned()),
        slug: Set(input.slug.clone()),
        entity_key: Set(format!("co_{}", input.slug)),
        label_singular: Set(text(&input.label_singular).unwrap_or_default()),
        label_plural: Set(text(&input.label_plural).unwrap_or_default()),
        description: Set(text(&input.description)),
        icon: Set(text(&input.icon).unwrap_or_else(|| "Box".to_owned())),
        color: Set(text(&input.color)),
        status: Set(text(&input.status).unwrap_or_else(|| "draft".to_owned())),
        enable_events: Set(flag(&input.enable_events, true)),
        enable_search: Set(flag(&input.enable_search, false)),
        enable_agent_tools: Set(flag(&input.enable_agent_tools, false)),
        enable_external_api: Set(flag(&input.enable_external_api, false)),
        list_config: Set(input
            .list_config
            .as_set()
            .cloned()
            .unwrap_or_else(|| json!({}))),
        sort_order: Set(int4(input.sort_order.as_set().copied().unwrap_or(0))?),
        created_by: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
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
        let existing = object_by_id(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        let db = &orm(&caller.db);
        if let Some(title_field_id) = input.title_field_id.as_set().filter(|t| !t.is_empty()) {
            use custom_field_definitions::Column;
            let found: Option<String> = custom_field_definitions::Entity::find()
                .select_only()
                .column(Column::Id)
                .filter(Column::Id.eq(title_field_id))
                .filter(Column::EntityType.eq(&existing.entity_key))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .one(db)
                .await?;
            if found.is_none() {
                return Err(Refusal::bad_request(
                    "titleFieldId must reference a field belonging to this object",
                ));
            }
        }
        // The index goes first, so a failure leaves the flag on to retry.
        if existing.enable_search && input.enable_search.as_set() == Some(&false) {
            search_index::Entity::delete_many()
                .filter(search_index::Column::EntityType.eq(&existing.entity_key))
                .exec(db)
                .await?;
        }
        object_update(&input)?
            .col_expr(custom_objects::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(custom_objects::Column::Id.eq(&id))
            .exec(db)
            .await?;
        let updated = object_row(db, &id).await?;
        caller.publish(
            &state,
            CUSTOM_FIELD_UPDATED,
            &id,
            &event_data(&id, "custom_object", &input.data),
        );
        Ok(Data(updated.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to update custom object")
}

/// The columns a `PUT` sets: only the fields the body sent.
fn object_update(
    input: &ObjectInput,
) -> Result<sea_orm::UpdateMany<custom_objects::Entity>, DbErr> {
    use custom_objects::Column;
    let mut update = custom_objects::Entity::update_many();
    let texts = [
        (Column::LabelSingular, &input.label_singular),
        (Column::LabelPlural, &input.label_plural),
        (Column::Description, &input.description),
        (Column::Icon, &input.icon),
        (Column::Color, &input.color),
        (Column::Status, &input.status),
        (Column::TitleFieldId, &input.title_field_id),
    ];
    for (column, field) in texts {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    let flags = [
        (Column::EnableEvents, &input.enable_events),
        (Column::EnableSearch, &input.enable_search),
        (Column::EnableAgentTools, &input.enable_agent_tools),
        (Column::EnableExternalApi, &input.enable_external_api),
    ];
    for (column, field) in flags {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let (true, config) = change(&input.list_config) {
        update = update.col_expr(Column::ListConfig, Expr::value(config));
    }
    if let (true, order) = change(&input.sort_order) {
        update = update.col_expr(Column::SortOrder, Expr::value(order.map(int4).transpose()?));
    }
    Ok(update)
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
        delete_object(db, &existing).await?;
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

/// Delete an object with everything that hangs off it, as one unit, the
/// definition last: a failure leaves the object intact.
async fn delete_object(db: &PgPool, object: &CustomObject) -> Result<(), Refusal> {
    let now = utc_now();
    let key = object.entity_key.clone();
    let values = custom_field_values::Entity::delete_many()
        .filter(custom_field_values::Column::EntityType.eq(&key))
        .filter(
            custom_field_values::Column::EntityId.in_subquery(
                Query::select()
                    .column((
                        custom_object_records::Entity,
                        custom_object_records::Column::Id,
                    ))
                    .from(custom_object_records::Entity)
                    .and_where(custom_object_records::Column::EntityKey.eq(&key))
                    .to_owned(),
            ),
        );
    let relations = custom_object_relations::Entity::delete_many().filter(
        Condition::any()
            .add(custom_object_relations::Column::SourceEntityKey.eq(&key))
            .add(custom_object_relations::Column::TargetEntityKey.eq(&key)),
    );
    let links = custom_object_links::Entity::update_many()
        .col_expr(custom_object_links::Column::DeletedAt, Expr::value(now))
        .col_expr(custom_object_links::Column::UpdatedAt, Expr::value(now))
        .filter(
            Condition::any()
                .add(custom_object_links::Column::SourceEntityKey.eq(&key))
                .add(custom_object_links::Column::TargetEntityKey.eq(&key)),
        );
    let records = custom_object_records::Entity::update_many()
        .col_expr(custom_object_records::Column::DeletedAt, Expr::value(now))
        .col_expr(custom_object_records::Column::UpdatedAt, Expr::value(now))
        .filter(custom_object_records::Column::EntityKey.eq(&key));
    let fields = custom_field_definitions::Entity::update_many()
        .col_expr(
            custom_field_definitions::Column::DeletedAt,
            Expr::value(now),
        )
        .col_expr(
            custom_field_definitions::Column::UpdatedAt,
            Expr::value(now),
        )
        .filter(custom_field_definitions::Column::EntityType.eq(&key));
    let index =
        search_index::Entity::delete_many().filter(search_index::Column::EntityType.eq(&key));
    let definition = custom_objects::Entity::update_many()
        .col_expr(custom_objects::Column::DeletedAt, Expr::value(now))
        .col_expr(custom_objects::Column::UpdatedAt, Expr::value(now))
        .filter(custom_objects::Column::Id.eq(&object.id));
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            values.exec(&tx).await?;
            relations.exec(&tx).await?;
            links.exec(&tx).await?;
            records.exec(&tx).await?;
            fields.exec(&tx).await?;
            index.exec(&tx).await?;
            definition.exec(&tx).await?;
            Ok::<_, Refusal>(())
        })
    })
    .await
}
