//! `/api/workflow-variables` (`routes/workflow-variables/index.ts`,
//! `services/workflow-variables.ts`). Secret values never leave the server.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_VARIABLE_CREATED, WORKFLOW_VARIABLE_DELETED, WORKFLOW_VARIABLE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

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

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let search = query_truthy(query, "search").map(|s| format!("%{s}%"));
    let workflow_id = query_truthy(query, "workflowId");
    let scope = query_truthy(query, "scope");
    let secret = query_param(query, "isSecret").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.name like $1)
        and ($2::text is null or t.workflow_id = $2) and ($3::text is null or t.scope = $3)
        and ($4::boolean is null or t.is_secret = $4)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from workflow_variables t where {FILTER} and ($5::text is null or t.id < $5)
         order by t.id desc limit $6"
    )))
    .bind(&search)
    .bind(&workflow_id)
    .bind(&scope)
    .bind(secret)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_variables t where {FILTER}"
    )))
    .bind(&search)
    .bind(&workflow_id)
    .bind(&scope)
    .bind(secret)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            let data = data.into_iter().map(mask).collect();
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow variables"),
    }
}

async fn global(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_variables t where t.scope = 'global' and t.deleted_at is null
         order by t.name",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => {
            Data(rows.into_iter().map(js_row).map(mask).collect::<Vec<_>>()).into_response()
        }
        Err(error) => internal(&error, "Failed to fetch global variables"),
    }
}

async fn for_workflow(caller: Caller, Path(workflow_id): Path<String>) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('name', t.name, 'type', t.type, 'isSecret', t.is_secret, 'scope', t.scope)
         from workflow_variables t
         where (t.workflow_id = $1 or t.scope = 'global') and t.deleted_at is null order by t.name",
    )
    .bind(&workflow_id)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => {
            tracing::error!(%error, "[app-api/workflow-variables] workflow failed");
            Data(Vec::<Value>::new()).into_response()
        }
    }
}

async fn get_variable(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_variables t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row).map(mask))
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
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from workflow_variables
         where lower(name) = lower($1) and deleted_at is null and ($2::text is null or id <> $2)
           and ($3::text is null or workflow_id is null or workflow_id = $3)
         limit 1",
    )
    .bind(name)
    .bind(exclude)
    .bind(workflow_id)
    .fetch_optional(db)
    .await?;
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
            let found: Option<String> = sqlx::query_scalar(
                "select id from workflows where id = $1 and deleted_at is null limit 1",
            )
            .bind(workflow_id)
            .fetch_optional(&caller.db)
            .await?;
            if found.is_none() {
                return Err(Refusal::not_found("Workflow", workflow_id));
            }
        }
        if conflicting(&caller.db, &name, target.as_deref(), None).await? {
            return Err(name_taken(&name));
        }
        let id = generate_id("var");
        let stamp = now();
        sqlx::query(
            "insert into workflow_variables
                (id, name, description, type, value, is_secret, scope, workflow_id, modified_by,
                 created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $10::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&description)
        .bind(kind.unwrap_or_else(|| "string".into()))
        .bind(value.map(Value::String).unwrap_or(Value::Null))
        .bind(secret == Some(true))
        .bind(if target.is_some() {
            "workflow"
        } else {
            "global"
        })
        .bind(&target)
        .bind(&caller.user_id)
        .bind(&stamp)
        .execute(&caller.db)
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
        sqlx::query(
            "update workflow_variables set updated_at = $2::timestamp, modified_by = $3,
                name = case when $4 then $5 else name end,
                description = case when $6 then $7 else description end,
                type = case when $8 then $9 else type end,
                value = case when $10 then $11 else value end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(&caller.user_id)
        .bind(!name.is_absent())
        .bind(name.as_set())
        .bind(!description.is_absent())
        .bind(description.as_set())
        .bind(!kind.is_absent())
        .bind(kind.as_set())
        .bind(!value.is_absent())
        .bind(value.as_set().map(|v| Value::String(v.clone())))
        .execute(&caller.db)
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
        let stamp = now();
        sqlx::query(
            "update workflow_variables set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, WORKFLOW_VARIABLE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow variable"))
}
