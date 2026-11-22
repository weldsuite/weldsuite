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
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_COMPUTED_PROPERTY_CREATED, PANEL_COMPUTED_PROPERTY_DELETED,
    PANEL_COMPUTED_PROPERTY_UPDATED, PANEL_CUSTOM_EVENT_CREATED, PANEL_CUSTOM_EVENT_DELETED,
    PANEL_CUSTOM_EVENT_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::expression::{
    ExpressionIdentifierKind, ParseExpressionOptions, parse_expression,
};
use weldsuite_zod::Z;

use crate::saved::{PROJECT_QUERY, field, project_exists, text};
use crate::schemas_gen::{
    CREATE_PANEL_COMPUTED_PROPERTY, CREATE_PANEL_CUSTOM_EVENT, PANEL_COMPUTED_PROPERTY_DEFINITION,
    PANEL_CUSTOM_EVENT_DEFINITION, UPDATE_PANEL_COMPUTED_PROPERTY, UPDATE_PANEL_CUSTOM_EVENT,
};
use crate::{Caller, PanelState, unexpected};

/// Definitions listed per project (`MAX_LISTED_DEFINITIONS`).
const MAX_LISTED: u64 = 500;

/// The two tables, which have the same columns.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Table {
    CustomEvents,
    ComputedProperties,
}

/// `$body` with `$t` naming the kind's entity module, for either table.
macro_rules! on_table {
    ($kind:expr, $t:ident => $body:expr) => {
        match $kind.table {
            Table::CustomEvents => {
                use weldsuite_schema::tenant::panel_custom_events as $t;
                $body
            }
            Table::ComputedProperties => {
                use weldsuite_schema::tenant::panel_computed_properties as $t;
                $body
            }
        }
    };
}

/// A row as Drizzle returns it.
fn js_row<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// One kind of definition: its table, id prefix, schemas, events and names.
struct Kind {
    table: Table,
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
    table: Table::CustomEvents,
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
    table: Table::ComputedProperties,
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
    Failed(DbErr),
}

impl From<DbErr> for Refusal {
    fn from(error: DbErr) -> Self {
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

async fn get_row(db: &PgPool, kind: &Kind, id: &str) -> Result<Option<Value>, DbErr> {
    on_table!(kind, t => t::Entity::find_by_id(id)
        .filter(t::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(js_row)
        .transpose())
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
    let taken: Option<String> = on_table!(kind, t => {
        let mut find = t::Entity::find()
            .select_only()
            .column(t::Column::Id)
            .filter(t::Column::ProjectId.eq(project_id))
            .filter(t::Column::DeletedAt.is_null())
            .filter(sea_orm::ExprTrait::eq(
                Func::lower(Expr::col(t::Column::Name)),
                Func::lower(Expr::val(name)),
            ));
        if let Some(self_id) = self_id {
            find = find.filter(t::Column::Id.ne(self_id));
        }
        find.into_tuple().one(&orm(db)).await?
    });
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
    if kind.table == Table::ComputedProperties
        && let Some(definition) = definition
    {
        check_formula(definition)?;
    }
    if let Some(name) = input.get("name").and_then(Value::as_str) {
        check_name_free(db, kind, project_id, name, self_id).await?;
    }
    if kind.table == Table::CustomEvents
        && let Some(definition) = definition
    {
        let refs = computed_refs(definition);
        if !refs.is_empty() {
            use weldsuite_schema::tenant::panel_computed_properties as computed;
            let known: Vec<String> = computed::Entity::find()
                .select_only()
                .column(computed::Column::Id)
                .filter(computed::Column::Id.is_in(refs.iter().map(String::as_str)))
                .filter(computed::Column::ProjectId.eq(project_id))
                .filter(computed::Column::DeletedAt.is_null())
                .into_tuple()
                .all(&orm(db))
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
    let project_id = query.text("projectId").unwrap_or_default();
    let found: Result<Vec<Value>, DbErr> = on_table!(kind, t => t::Entity::find()
        .filter(t::Column::ProjectId.eq(project_id))
        .filter(t::Column::DeletedAt.is_null())
        .order_by_asc(t::Column::Name)
        .limit(MAX_LISTED)
        .all(&orm(&caller.db))
        .await
        .and_then(|found| found.into_iter().map(js_row).collect()));
    match found {
        Ok(found) => {
            let items: Vec<Value> = found.iter().map(|row| dto(kind, row)).collect();
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
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let name = input.text("name").unwrap_or_default().to_owned();
    let created: Result<Value, DbErr> = on_table!(kind, t => t::Entity::insert(t::ActiveModel {
        id: Set(weldsuite_kit::id::generate_id(kind.prefix)),
        project_id: Set(project_id.clone()),
        name: Set(name),
        description: Set(description),
        definition: Set(definition),
        owner_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row));
    match created {
        Ok(row) => {
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
    let name = input.get("name").and_then(Value::as_str);
    let description = input
        .get("description")
        .map(|description| description.as_str().map(str::to_owned));
    let updated: Result<Option<Value>, DbErr> = on_table!(kind, t => {
        let mut update = t::Entity::update_many();
        if let Some(name) = name {
            update = update.col_expr(t::Column::Name, Expr::value(name));
        }
        if let Some(description) = description {
            update = update.col_expr(t::Column::Description, Expr::value(description));
        }
        if let Some(definition) = definition {
            update = update.col_expr(t::Column::Definition, Expr::value(definition));
        }
        update
            .col_expr(t::Column::UpdatedAt, Expr::current_timestamp())
            .filter(t::Column::Id.eq(&existing_id))
            .filter(t::Column::DeletedAt.is_null())
            .exec_with_returning(&orm(&caller.db))
            .await
            .and_then(|rows| rows.into_iter().next().map(js_row).transpose())
    });
    match updated {
        Ok(Some(row)) => {
            caller.publish(state, kind.updated, text(&row, "id"), &event_data(&row));
            Data(dto(kind, &row)).into_response()
        }
        Ok(None) => ApiError::not_found(kind.label, Some(id)).into_response(),
        Err(error) => unexpected(&error, "update definition"),
    }
}

async fn remove(kind: &Kind, state: &PanelState, caller: Caller, id: &str) -> Response {
    let deleted: Result<Option<Value>, DbErr> = on_table!(kind, t => t::Entity::update_many()
        .col_expr(t::Column::DeletedAt, Expr::current_timestamp())
        .col_expr(t::Column::UpdatedAt, Expr::current_timestamp())
        .filter(t::Column::Id.eq(id))
        .filter(t::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await
        .and_then(|rows| rows.into_iter().next().map(js_row).transpose()));
    match deleted {
        Ok(Some(row)) => {
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
