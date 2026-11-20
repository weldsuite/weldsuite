//! Data definitions of a project (`services/definitions.ts`): custom events
//! (`/api/panel/custom-events`, `routes/custom-events/index.ts`) and computed
//! properties (`/api/panel/computed-properties`,
//! `routes/computed-properties/index.ts`). Query specs refer to both as
//! `@<id>`. Names are unique per project, ignoring case; a formula is
//! checked with the shared expression parser.
//!
//!   GET    /       → ?projectId: the project's definitions, by name
//!   POST   /       → new definition (400 for a bad definition, 409 when the name is taken)
//!   GET    /:id    → one definition
//!   PATCH  /:id    → name, description, definition
//!   DELETE /:id    → soft delete
//!
//! `panel_reports:read` to read, `:create` / `:update` / `:delete` to write.
//! The definition itself never goes on the entity bus.

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_COMPUTED_PROPERTY_CREATED, PANEL_COMPUTED_PROPERTY_DELETED,
    PANEL_COMPUTED_PROPERTY_UPDATED, PANEL_CUSTOM_EVENT_CREATED, PANEL_CUSTOM_EVENT_DELETED,
    PANEL_CUSTOM_EVENT_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::expression::{
    ExpressionIdentifierKind, ParseExpressionOptions, parse_expression,
};
use weldsuite_zod::Z;

use crate::saved::{PROJECT_QUERY, field, project_exists, rows, text};
use crate::schemas_gen::{
    CREATE_PANEL_COMPUTED_PROPERTY, CREATE_PANEL_CUSTOM_EVENT, PANEL_COMPUTED_PROPERTY_DEFINITION,
    PANEL_CUSTOM_EVENT_DEFINITION, UPDATE_PANEL_COMPUTED_PROPERTY, UPDATE_PANEL_CUSTOM_EVENT,
};
use crate::{Caller, PanelState, unexpected};

/// Definitions listed per project (`MAX_LISTED_DEFINITIONS`).
const MAX_LISTED: i64 = 500;

/// One kind of definition: its table, id prefix, schemas, events and names.
struct Kind {
    table: &'static str,
    prefix: &'static str,
    /// What a 404 calls it.
    label: &'static str,
    definition: &'static Z,
    create: &'static Z,
    update: &'static Z,
    created: EventName,
    updated: EventName,
    deleted: EventName,
}

const CUSTOM_EVENTS: Kind = Kind {
    table: "panel_custom_events",
    prefix: "pnce",
    label: "Custom event",
    definition: &PANEL_CUSTOM_EVENT_DEFINITION,
    create: &CREATE_PANEL_CUSTOM_EVENT,
    update: &UPDATE_PANEL_CUSTOM_EVENT,
    created: PANEL_CUSTOM_EVENT_CREATED,
    updated: PANEL_CUSTOM_EVENT_UPDATED,
    deleted: PANEL_CUSTOM_EVENT_DELETED,
};

const COMPUTED_PROPERTIES: Kind = Kind {
    table: "panel_computed_properties",
    prefix: "pncp",
    label: "Computed property",
    definition: &PANEL_COMPUTED_PROPERTY_DEFINITION,
    create: &CREATE_PANEL_COMPUTED_PROPERTY,
    update: &UPDATE_PANEL_COMPUTED_PROPERTY,
    created: PANEL_COMPUTED_PROPERTY_CREATED,
    updated: PANEL_COMPUTED_PROPERTY_UPDATED,
    deleted: PANEL_COMPUTED_PROPERTY_DELETED,
};

/// A definition that cannot be saved (`DefinitionError`): 400 or 409.
enum Refusal {
    Bad(String, Option<Value>),
    Taken(String),
    Failed(sqlx::Error),
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error)
    }
}

impl Refusal {
    /// `definitionFailure(c, err)`.
    fn into_response(self, what: &str) -> Response {
        match self {
            Self::Bad(message, details) => {
                let error = ApiError::bad_request(message);
                match details {
                    Some(details) => error.with_details(details),
                    None => error,
                }
                .into_response()
            }
            Self::Taken(message) => ApiError::conflict(message).into_response(),
            Self::Failed(error) => unexpected(&error, what),
        }
    }
}

/// `schema.parse(definition)`: the definition as its schema reads it.
fn parsed_definition(kind: &Kind, definition: &Value) -> Value {
    weldsuite_zod::parse_issues(kind.definition, definition)
        .map_or_else(|_| definition.clone(), |parsed| Value::Object(parsed.body))
}

/// `toCustomEventDto` / `toComputedPropertyDto`.
fn dto(kind: &Kind, row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "definition": parsed_definition(kind, &field(row, "definition")),
        "ref": format!("@{}", text(row, "id")),
        "ownerUserId": field(row, "ownerUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// The event payload: never the definition.
fn event_data(row: &Value) -> Value {
    json!({ "id": field(row, "id"), "projectId": field(row, "projectId"), "name": field(row, "name") })
}

async fn get_row(db: &PgPool, kind: &Kind, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let sql = format!(
        "select to_jsonb(d) from {} d where d.id = $1 and d.deleted_at is null limit 1",
        kind.table
    );
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `checkNameFree`: a 409 when another live definition of the project has
/// this name, ignoring case.
async fn check_name_free(
    db: &PgPool,
    kind: &Kind,
    project_id: &str,
    name: &str,
    self_id: Option<&str>,
) -> Result<(), Refusal> {
    let sql = format!(
        "select id from {} where project_id = $1 and deleted_at is null
           and lower(name) = lower($2) and ($3::text is null or id <> $3) limit 1",
        kind.table
    );
    let taken: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(project_id)
        .bind(name)
        .bind(self_id)
        .fetch_optional(db)
        .await?;
    match taken {
        Some(_) => Err(Refusal::Taken(format!(
            "\"{name}\" is already taken in this project"
        ))),
        None => Ok(()),
    }
}

/// `computedRefsOf(definition)`: the computed properties a custom event's
/// filters name, without the `@`.
fn computed_refs(definition: &Value) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();
    let matches = definition
        .get("match")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for item in matches {
        let filters = item
            .get("filters")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        for filter in filters {
            if let Some(key) = filter.get("key").and_then(Value::as_str)
                && let Some(id) = key.strip_prefix('@')
                && !refs.iter().any(|known| known == id)
            {
                refs.push(id.to_owned());
            }
        }
    }
    refs
}

/// `checkComputedDefinition`: a formula the expression parser takes, with
/// at least one property.
fn check_formula(definition: &Value) -> Result<(), Refusal> {
    if text(definition, "kind") != "formula" {
        return Ok(());
    }
    let options = ParseExpressionOptions {
        identifiers: ExpressionIdentifierKind::Properties,
        series_count: None,
    };
    match parse_expression(text(definition, "expression"), options) {
        Err(error) => Err(Refusal::Bad(
            error.message,
            Some(json!({ "position": error.position })),
        )),
        Ok(parsed) if parsed.identifiers.is_empty() => Err(Refusal::Bad(
            "Use at least one property in the formula".to_owned(),
            Some(json!({ "position": 0 })),
        )),
        Ok(_) => Ok(()),
    }
}

/// What is checked before a write: the name, then a custom event's
/// computed properties; a computed property's formula comes first.
async fn check(
    db: &PgPool,
    kind: &Kind,
    project_id: &str,
    input: &Map<String, Value>,
    self_id: Option<&str>,
) -> Result<(), Refusal> {
    let definition = input.get("definition");
    if kind.table == COMPUTED_PROPERTIES.table
        && let Some(definition) = definition
    {
        check_formula(definition)?;
    }
    if let Some(name) = input.get("name").and_then(Value::as_str) {
        check_name_free(db, kind, project_id, name, self_id).await?;
    }
    if kind.table == CUSTOM_EVENTS.table
        && let Some(definition) = definition
    {
        let refs = computed_refs(definition);
        if !refs.is_empty() {
            let known: Vec<String> = sqlx::query_scalar(
                "select id from panel_computed_properties
                 where id = any($1) and project_id = $2 and deleted_at is null",
            )
            .bind(&refs)
            .bind(project_id)
            .fetch_all(db)
            .await?;
            if let Some(missing) = refs.iter().find(|id| !known.contains(id)) {
                return Err(Refusal::Bad(
                    format!("Unknown computed property: @{missing}"),
                    None,
                ));
            }
        }
    }
    Ok(())
}

async fn list(kind: &Kind, caller: Caller, raw: Option<String>) -> Response {
    let query = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let sql = format!(
        "select to_jsonb(d) from {} d where d.project_id = $1 and d.deleted_at is null
         order by d.name asc limit $2",
        kind.table
    );
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(query.text("projectId"))
        .bind(MAX_LISTED)
        .fetch_all(&caller.db)
        .await;
    match found {
        Ok(found) => {
            let items: Vec<Value> = rows(found).iter().map(|row| dto(kind, row)).collect();
            let count = items.len() as u64;
            List::new(items, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list definitions"),
    }
}

async fn create(
    kind: &Kind,
    state: &PanelState,
    caller: Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> Response {
    let input = match weldsuite_zod::json(kind.create, headers, body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = input.text("projectId").unwrap_or_default().to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "create definition"),
    }
    if let Err(refusal) = check(&caller.db, kind, &project_id, &input.body, None).await {
        return refusal.into_response("create definition");
    }
    let definition = parsed_definition(
        kind,
        &input.get("definition").cloned().unwrap_or(Value::Null),
    );
    let sql = format!(
        "insert into {} as d (id, project_id, name, description, definition, owner_user_id)
         values ($1, $2, $3, $4, $5, $6)
         returning to_jsonb(d)",
        kind.table
    );
    let created: Result<Value, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(weldsuite_kit::id::generate_id(kind.prefix))
        .bind(&project_id)
        .bind(input.text("name"))
        .bind(input.get("description").and_then(Value::as_str))
        .bind(&definition)
        .bind(&caller.user_id)
        .fetch_one(&caller.db)
        .await;
    match created {
        Ok(row) => {
            let row = weldsuite_db::js_row(row);
            caller.publish(state, kind.created, text(&row, "id"), &event_data(&row));
            Created(dto(kind, &row)).into_response()
        }
        Err(error) => unexpected(&error, "create definition"),
    }
}

async fn detail(kind: &Kind, caller: Caller, id: &str) -> Response {
    match get_row(&caller.db, kind, id).await {
        Ok(Some(row)) => Data(dto(kind, &row)).into_response(),
        Ok(None) => ApiError::not_found(kind.label, Some(id)).into_response(),
        Err(error) => unexpected(&error, "get definition"),
    }
}

async fn update(
    kind: &Kind,
    state: &PanelState,
    caller: Caller,
    id: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> Response {
    let input = match weldsuite_zod::json(kind.update, headers, body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let existing = match get_row(&caller.db, kind, id).await {
        Ok(Some(existing)) => existing,
        Ok(None) => return ApiError::not_found(kind.label, Some(id)).into_response(),
        Err(error) => return unexpected(&error, "update definition"),
    };
    let existing_id = text(&existing, "id").to_owned();
    if let Err(refusal) = check(
        &caller.db,
        kind,
        text(&existing, "projectId"),
        &input.body,
        Some(&existing_id),
    )
    .await
    {
        return refusal.into_response("update definition");
    }
    let definition = input
        .get("definition")
        .map(|definition| parsed_definition(kind, definition));
    let sql = format!(
        "update {} as d set
           name = coalesce($2, d.name),
           description = case when $3 then $4 else d.description end,
           definition = coalesce($5, d.definition),
           updated_at = now()
         where d.id = $1 and d.deleted_at is null
         returning to_jsonb(d)",
        kind.table
    );
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(&existing_id)
        .bind(input.get("name").and_then(Value::as_str))
        .bind(input.get("description").is_some())
        .bind(input.get("description").and_then(Value::as_str))
        .bind(definition)
        .fetch_optional(&caller.db)
        .await;
    match updated {
        Ok(Some(row)) => {
            let row = weldsuite_db::js_row(row);
            caller.publish(state, kind.updated, text(&row, "id"), &event_data(&row));
            Data(dto(kind, &row)).into_response()
        }
        Ok(None) => ApiError::not_found(kind.label, Some(id)).into_response(),
        Err(error) => unexpected(&error, "update definition"),
    }
}

async fn remove(kind: &Kind, state: &PanelState, caller: Caller, id: &str) -> Response {
    let sql = format!(
        "update {} as d set deleted_at = now(), updated_at = now()
         where d.id = $1 and d.deleted_at is null
         returning to_jsonb(d)",
        kind.table
    );
    let deleted: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(&caller.db)
        .await;
    match deleted {
        Ok(Some(row)) => {
            let row = weldsuite_db::js_row(row);
            caller.publish(state, kind.deleted, text(&row, "id"), &event_data(&row));
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found(kind.label, Some(id)).into_response(),
        Err(error) => unexpected(&error, "delete definition"),
    }
}

/// The routes of one kind, as axum handlers.
macro_rules! definition_routes {
    ($module:ident, $kind:ident) => {
        pub(crate) mod $module {
            use axum::body::Bytes;
            use axum::extract::{Path, RawQuery, State};
            use axum::response::Response;
            use http::HeaderMap;

            use crate::{Caller, PanelState};

            pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
                super::list(&super::$kind, caller, raw).await
            }

            pub(crate) async fn create(
                State(state): State<PanelState>,
                caller: Caller,
                headers: HeaderMap,
                body: Bytes,
            ) -> Response {
                super::create(&super::$kind, &state, caller, &headers, &body).await
            }

            pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
                super::detail(&super::$kind, caller, &id).await
            }

            pub(crate) async fn update(
                State(state): State<PanelState>,
                caller: Caller,
                Path(id): Path<String>,
                headers: HeaderMap,
                body: Bytes,
            ) -> Response {
                super::update(&super::$kind, &state, caller, &id, &headers, &body).await
            }

            pub(crate) async fn remove(
                State(state): State<PanelState>,
                caller: Caller,
                Path(id): Path<String>,
            ) -> Response {
                super::remove(&super::$kind, &state, caller, &id).await
            }
        }
    };
}

definition_routes!(custom_events, CUSTOM_EVENTS);
definition_routes!(computed_properties, COMPUTED_PROPERTIES);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computed_refs_come_from_filter_keys() {
        let definition = json!({ "match": [
            { "event": "Paid", "filters": [{ "source": "event", "key": "@pncp_a" }, { "source": "event", "key": "plan" }] },
            { "event": "Other", "filters": [{ "source": "event", "key": "@pncp_a" }] }
        ]});
        assert_eq!(computed_refs(&definition), vec!["pncp_a".to_owned()]);
    }

    #[test]
    fn formulas_need_a_property() {
        assert!(
            check_formula(&json!({ "kind": "formula", "expression": "price * quantity" })).is_ok()
        );
        assert!(matches!(
            check_formula(&json!({ "kind": "formula", "expression": "2 * 3" })),
            Err(Refusal::Bad(_, Some(_)))
        ));
        assert!(check_formula(&json!({ "kind": "coalesce", "keys": [] })).is_ok());
    }
}
