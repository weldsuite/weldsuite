//! `/api/workflow-variables` (`routes/workflow-variables/index.ts`,
//! `services/workflow-variables.ts`). Secret values never leave the server.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_VARIABLE_CREATED, WORKFLOW_VARIABLE_DELETED, WORKFLOW_VARIABLE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_variables::{self, Column};
use weldsuite_schema::tenant::workflows;

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy};
use crate::{Caller, ConnectState, Refusal, internal, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOW_VARIABLES_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::WORKFLOW_VARIABLES_CREATE])),
        )
        .route("/global", get(global).route_layer(read()))
        .route(
            "/workflow/{workflow_id}",
            get(for_workflow).route_layer(read()),
        )
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(gate.require([perm::WORKFLOW_VARIABLES_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete)
                .route_layer(gate.require([perm::WORKFLOW_VARIABLES_DELETE])),
        )
}

/// `maskSecret(v)`.
fn mask(mut row: Value) -> Value {
    if row["isSecret"].as_bool() == Some(true) {
        row["value"] = json!("********");
    }
    row
}

/// The list's filters: not deleted, `name like %search%`, and the
/// `workflowId`, `scope` and `isSecret` sent.
fn filtered(
    search: Option<&str>,
    workflow_id: Option<&str>,
    scope: Option<&str>,
    secret: Option<bool>,
) -> Select<workflow_variables::Entity> {
    let mut filter = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(search) = search {
        filter = filter.add(Column::Name.like(search));
    }
    if let Some(workflow_id) = workflow_id {
        filter = filter.add(Column::WorkflowId.eq(workflow_id));
    }
    if let Some(scope) = scope {
        filter = filter.add(Column::Scope.eq(scope));
    }
    if let Some(secret) = secret {
        filter = filter.add(Column::IsSecret.eq(secret));
    }
    workflow_variables::Entity::find().filter(filter)
}

/// A row as Drizzle returned it.
fn js(model: workflow_variables::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let search = query_truthy(query, "search").map(|s| format!("%{s}%"));
    let workflow_id = query_truthy(query, "workflowId");
    let scope = query_truthy(query, "scope");
    let secret = query_param(query, "isSecret").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    let db = orm(&caller.db);
    let filters = || {
        filtered(
            search.as_deref(),
            workflow_id.as_deref(),
            scope.as_deref(),
            secret,
        )
    };
    let mut rows = filters();
    if let Some(cursor) = &cursor {
        rows = rows.filter(Column::Id.lt(cursor));
    }
    let rows: Result<Vec<workflow_variables::Model>, DbErr> = rows
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await;
    let count = filters().count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            let data = data.into_iter().map(mask).collect();
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow variables"),
    }
}

async fn global(caller: Caller) -> Response {
    let rows = workflow_variables::Entity::find()
        .filter(Column::Scope.eq("global"))
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::Name)
        .all(&orm(&caller.db))
        .await;
    match rows {
        Ok(rows) => Data(rows.into_iter().map(js).map(mask).collect::<Vec<_>>()).into_response(),
        Err(error) => internal(&error, "Failed to fetch global variables"),
    }
}

async fn for_workflow(caller: Caller, Path(workflow_id): Path<String>) -> Response {
    let rows: Result<Vec<(String, String, bool, String)>, DbErr> =
        workflow_variables::Entity::find()
            .select_only()
            .columns([Column::Name, Column::Type, Column::IsSecret, Column::Scope])
            .filter(
                Condition::any()
                    .add(Column::WorkflowId.eq(&workflow_id))
                    .add(Column::Scope.eq("global")),
            )
            .filter(Column::DeletedAt.is_null())
            .order_by_asc(Column::Name)
            .into_tuple()
            .all(&orm(&caller.db))
            .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|(name, kind, is_secret, scope)| {
                    json!({ "name": name, "type": kind, "isSecret": is_secret, "scope": scope })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "[app-api/workflow-variables] workflow failed");
            Data(Vec::<Value>::new()).into_response()
        }
    }
}

async fn get_variable(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workflow_variables::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(js).map(mask))
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_variable(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Workflow variable", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow variable"),
    }
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn name_field(issues: &mut Issues, b: &Map<String, Value>, presence: Presence) -> Field<String> {
    issues.pattern(
        b,
        "name",
        presence,
        Some(1),
        Some(255),
        identifier,
        "Invalid",
    )
}

/// `findConflictingVariable(db, name, target, excludeId)`.
async fn conflicting(
    db: &PgPool,
    name: &str,
    workflow_id: Option<&str>,
    exclude: Option<&str>,
) -> Result<bool, DbErr> {
    // `lower(name) = lower($1)`.
    let mut found = workflow_variables::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(sea_orm::ExprTrait::eq(
            Func::lower(Expr::col(Column::Name)),
            Func::lower(Expr::val(name)),
        ))
        .filter(Column::DeletedAt.is_null());
    if let Some(exclude) = exclude {
        found = found.filter(Column::Id.ne(exclude));
    }
    if let Some(workflow_id) = workflow_id {
        found = found.filter(
            Condition::any()
                .add(Column::WorkflowId.is_null())
                .add(Column::WorkflowId.eq(workflow_id)),
        );
    }
    let found: Option<String> = found.limit(1).into_tuple().one(&orm(db)).await?;
    Ok(found.is_some())
}

fn name_taken(name: &str) -> Refusal {
    ApiError::conflict(format!("A variable named \"{name}\" already exists"))
        .with_details(json!({ "reason": "name_taken" }))
        .into()
}

async fn create(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let name = name_field(issues, b, Presence::Required)
            .into_option()
            .unwrap_or_default();
        let description = issues
            .text(b, "description", Presence::Optional, None, None)
            .into_option();
        let kind = issues
            .choice(
                b,
                "type",
                Presence::Optional,
                &["string", "number", "boolean", "json"],
            )
            .into_option();
        let value = issues
            .text(b, "value", Presence::Required, None, None)
            .into_option();
        let secret = issues
            .boolean(b, "isSecret", Presence::Optional)
            .into_option();
        let global = issues
            .boolean(b, "isGlobal", Presence::Optional)
            .into_option();
        let scope = issues
            .choice(
                b,
                "scope",
                Presence::Optional,
                &["global", "workflow", "execution"],
            )
            .into_option();
        let workflow_id = issues
            .text(b, "workflowId", Presence::Nullish, None, None)
            .into_option();
        (
            name,
            description,
            kind,
            value,
            secret,
            global,
            scope,
            workflow_id,
        )
    });
    let (name, description, kind, value, secret, global, scope, workflow_id) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create workflow variable"),
    };
    let implied = if global != Some(true) && workflow_id.as_deref().is_some_and(|w| !w.is_empty()) {
        "workflow"
    } else {
        "global"
    };
    let scope = scope.unwrap_or_else(|| implied.to_owned());
    let target: Option<Option<String>> = match scope.as_str() {
        "global" => Some(None),
        "workflow" => workflow_id.clone().filter(|w| !w.is_empty()).map(Some),
        _ => None,
    };
    let Some(target) = target else {
        return ApiError::bad_request("A workflow variable needs a workflowId")
            .with_details(json!({ "reason": "workflow_required" }))
            .into_response();
    };
    let result = async {
        if let Some(workflow_id) = &target {
            let found: Option<String> = workflows::Entity::find()
                .select_only()
                .column(workflows::Column::Id)
                .filter(workflows::Column::Id.eq(workflow_id))
                .filter(workflows::Column::DeletedAt.is_null())
                .limit(1)
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
            if found.is_none() {
                return Err(Refusal::not_found("Workflow", workflow_id));
            }
        }
        if conflicting(&caller.db, &name, target.as_deref(), None).await? {
            return Err(name_taken(&name));
        }
        let id = generate_id("var");
        let stamp = utc_now();
        workflow_variables::Entity::insert(workflow_variables::ActiveModel {
            id: Set(id.clone()),
            name: Set(name.clone()),
            description: Set(description),
            type_: Set(kind.unwrap_or_else(|| "string".into())),
            value: Set(Some(value.map_or(Value::Null, Value::String))),
            is_secret: Set(secret == Some(true)),
            scope: Set(if target.is_some() {
                "workflow"
            } else {
                "global"
            }
            .to_owned()),
            workflow_id: Set(target),
            modified_by: Set(Some(caller.user_id.clone())),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        caller.publish(
            &state,
            WORKFLOW_VARIABLE_CREATED,
            &id,
            &json!({ "id": id, "name": name }),
        );
        Ok(Created(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create workflow variable"))
}

async fn update(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let name = name_field(issues, b, Presence::Optional);
        let description = issues.text(b, "description", Presence::Optional, None, None);
        let kind = issues.choice(
            b,
            "type",
            Presence::Optional,
            &["string", "number", "boolean", "json"],
        );
        let value = issues.text(b, "value", Presence::Optional, None, None);
        (name, description, kind, value)
    });
    let (name, description, kind, value) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update workflow variable"),
    };
    let result = async {
        if let Some(name) = name.as_set() {
            let Some(current) = get_variable(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Workflow variable", &id));
            };
            if current["name"].as_str() != Some(name.as_str()) {
                let workflow = current["workflowId"].as_str().filter(|w| !w.is_empty());
                if conflicting(&caller.db, name, workflow, Some(&id)).await? {
                    return Err(name_taken(name));
                }
            }
        }
        if get_variable(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow variable", &id));
        }
        let mut update = workflow_variables::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .col_expr(Column::ModifiedBy, Expr::value(&caller.user_id));
        if !name.is_absent() {
            update = update.col_expr(Column::Name, Expr::value(name.as_set().cloned()));
        }
        if !description.is_absent() {
            update = update.col_expr(
                Column::Description,
                Expr::value(description.as_set().cloned()),
            );
        }
        if !kind.is_absent() {
            update = update.col_expr(Column::Type, Expr::value(kind.as_set().cloned()));
        }
        if !value.is_absent() {
            let value = value.as_set().map(|v| Value::String(v.clone()));
            update = update.col_expr(Column::Value, Expr::value(value));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, WORKFLOW_VARIABLE_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow variable"))
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if get_variable(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow variable", &id));
        }
        let stamp = utc_now();
        workflow_variables::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, WORKFLOW_VARIABLE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow variable"))
}
