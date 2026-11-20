//! `/api/panel/metric-trees` (`routes/metric-trees/index.ts`,
//! `services/metric-trees.ts`): an output metric and the input metrics that
//! drive it (1-25 nodes, one root, no cycles), each a saved trends report or
//! an inline single-series trends spec. Same visibility rule as reports.
//!
//!   GET    /       → visible trees (?projectId, ?scope)
//!   POST   /       → new tree
//!   GET    /:id    → one tree
//!   PATCH  /:id    → name, description, visibility, nodes
//!   DELETE /:id    → soft delete

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_METRIC_TREE_CREATED, PANEL_METRIC_TREE_DELETED, PANEL_METRIC_TREE_UPDATED,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::Permissions;
use weldsuite_zod::{Keys, Z};

use crate::saved::{
    Actor, PROJECT_ID, SCOPES, can_change, can_see, field, project_exists, reports_by_id, rows,
    text,
};
use crate::schemas_gen::{
    CREATE_PANEL_METRIC_TREE, PANEL_METRIC_TREE_NODES, UPDATE_PANEL_METRIC_TREE,
};
use crate::{Caller, PanelState, unexpected};

const LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", Z::Opt(&PROJECT_ID)),
        ("scope", Z::Opt(&Z::Enum(SCOPES, None))),
    ],
    Keys::Strip,
);

/// `panelMetricTreeNodesSchema` under a key, so the parse gives an object.
const NODES: Z = Z::Obj(&[("nodes", PANEL_METRIC_TREE_NODES)], Keys::Strip);

/// `panelMetricTreeNodesSchema.safeParse(nodes)`.
fn parse_nodes(nodes: &Value) -> Option<Value> {
    weldsuite_zod::parse_issues(&NODES, &json!({ "nodes": nodes }))
        .ok()
        .and_then(|mut parsed| parsed.body.remove("nodes"))
}

/// `toMetricTreeDto(t)`: nodes that no longer parse show as none.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "description": field(row, "description"),
        "nodes": parse_nodes(&field(row, "nodes")).unwrap_or_else(|| json!([])),
        "ownerUserId": field(row, "ownerUserId"),
        "visibility": field(row, "visibility"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `metricTreeEventData(t)`: never the nodes.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "name": field(row, "name"),
        "visibility": field(row, "visibility"),
    })
}

fn publish(caller: &Caller, state: &PanelState, tree: &Value, event: EventName) {
    caller.publish(state, event, text(tree, "id"), &event_data(tree));
}

/// `nodesProblem(db, projectId, nodes, actor)`: every inline spec for the
/// project, every saved report a trends report of the project the actor
/// may see.
async fn nodes_problem(
    caller: &Caller,
    project_id: &str,
    nodes: &[Value],
    actor: &Actor,
) -> Result<Option<String>, sqlx::Error> {
    for node in nodes {
        if let Some(spec) = node.get("metric").and_then(|metric| metric.get("spec"))
            && spec.get("projectId").and_then(Value::as_str) != Some(project_id)
        {
            return Ok(Some(format!(
                "Node \"{}\" measures another project",
                text(node, "id")
            )));
        }
    }
    let mut report_ids: Vec<String> = Vec::new();
    for node in nodes {
        if let Some(id) = node
            .get("metric")
            .and_then(|metric| metric.get("reportId"))
            .and_then(Value::as_str)
            && !report_ids.iter().any(|known| known == id)
        {
            report_ids.push(id.to_owned());
        }
    }
    if report_ids.is_empty() {
        return Ok(None);
    }
    let reports = reports_by_id(&caller.db, &report_ids).await?;
    for id in &report_ids {
        let report = reports.iter().find(|r| text(r, "id") == id);
        match report {
            Some(report) if text(report, "projectId") == project_id && can_see(report, actor) => {
                if text(report, "kind") != "trends" {
                    return Ok(Some(format!("Report {id} is not a trends report")));
                }
            }
            _ => return Ok(Some(format!("Report {id} was not found"))),
        }
    }
    Ok(None)
}

async fn get_tree(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from panel_metric_trees t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `editable(c)`: a tree the caller may change, or the answer instead.
async fn editable(caller: &Caller, actor: &Actor, id: &str) -> Result<Value, Box<Response>> {
    match get_tree(caller, id).await {
        Ok(Some(tree)) if can_see(&tree, actor) => {
            if can_change(&tree, actor) {
                Ok(tree)
            } else {
                Err(Box::new(
                    ApiError::forbidden()
                        .with_message("Only the owner can change this metric tree")
                        .into_response(),
                ))
            }
        }
        Ok(_) => Err(Box::new(
            ApiError::not_found("Metric tree", Some(id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get metric tree"))),
    }
}

/// `GET /`.
pub(crate) async fn list(
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from panel_metric_trees t
         where t.deleted_at is null
           and ($2 <> 'mine' or t.owner_user_id = $1)
           and ($2 <> 'shared' or t.visibility = 'workspace')
           and ($3::text is null or t.project_id = $3)
         order by t.updated_at desc limit 500",
    )
    .bind(&actor.user_id)
    .bind(query.text("scope").unwrap_or("all"))
    .bind(query.text("projectId"))
    .fetch_all(&caller.db)
    .await;
    match found {
        Ok(found) => {
            let trees: Vec<Value> = rows(found)
                .iter()
                .filter(|tree| can_see(tree, &actor))
                .map(dto)
                .collect();
            let count = trees.len() as u64;
            List::new(trees, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list metric trees"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_PANEL_METRIC_TREE, &headers, &body) {
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
        Err(error) => return unexpected(&error, "create metric tree"),
    }
    let nodes = input.get("nodes").cloned().unwrap_or_else(|| json!([]));
    let actor = Actor::of(&caller, &permissions);
    match nodes_problem(
        &caller,
        &project_id,
        nodes.as_array().map_or(&[][..], Vec::as_slice),
        &actor,
    )
    .await
    {
        Ok(None) => {}
        Ok(Some(problem)) => return ApiError::bad_request(problem).into_response(),
        Err(error) => return unexpected(&error, "create metric tree"),
    }
    let created: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into panel_metric_trees as t
           (id, project_id, name, description, nodes, owner_user_id, visibility)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning to_jsonb(t)",
    )
    .bind(weldsuite_kit::id::generate_id("pnmt"))
    .bind(&project_id)
    .bind(input.text("name"))
    .bind(input.get("description").and_then(Value::as_str))
    .bind(parse_nodes(&nodes).unwrap_or(nodes))
    .bind(&caller.user_id)
    .bind(input.text("visibility").unwrap_or("private"))
    .fetch_one(&caller.db)
    .await;
    match created {
        Ok(row) => {
            let tree = weldsuite_db::js_row(row);
            publish(&caller, &state, &tree, PANEL_METRIC_TREE_CREATED);
            Created(dto(&tree)).into_response()
        }
        Err(error) => unexpected(&error, "create metric tree"),
    }
}

/// `GET /:id`.
pub(crate) async fn detail(
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    match get_tree(&caller, &id).await {
        Ok(Some(tree)) if can_see(&tree, &actor) => Data(dto(&tree)).into_response(),
        Ok(_) => ApiError::not_found("Metric tree", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "get metric tree"),
    }
}

/// `PATCH /:id`.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&UPDATE_PANEL_METRIC_TREE, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let nodes = input.get("nodes").cloned();
    if let Some(nodes) = nodes.as_ref().and_then(Value::as_array) {
        match nodes_problem(&caller, text(&found, "projectId"), nodes, &actor).await {
            Ok(None) => {}
            Ok(Some(problem)) => return ApiError::bad_request(problem).into_response(),
            Err(error) => return unexpected(&error, "update metric tree"),
        }
    }
    let updated: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_metric_trees as t set
           name = coalesce($2, t.name),
           description = case when $3 then $4 else t.description end,
           visibility = coalesce($5, t.visibility),
           nodes = coalesce($6, t.nodes),
           updated_at = now()
         where t.id = $1 and t.deleted_at is null
         returning to_jsonb(t)",
    )
    .bind(text(&found, "id"))
    .bind(input.get("name").and_then(Value::as_str))
    .bind(input.get("description").is_some())
    .bind(input.get("description").and_then(Value::as_str))
    .bind(input.get("visibility").and_then(Value::as_str))
    .bind(nodes.map(|nodes| parse_nodes(&nodes).unwrap_or(nodes)))
    .fetch_optional(&caller.db)
    .await;
    match updated {
        Ok(Some(row)) => {
            let tree = weldsuite_db::js_row(row);
            publish(&caller, &state, &tree, PANEL_METRIC_TREE_UPDATED);
            Data(dto(&tree)).into_response()
        }
        Ok(None) => ApiError::not_found("Metric tree", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "update metric tree"),
    }
}

/// `DELETE /:id`.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
) -> Response {
    let actor = Actor::of(&caller, &permissions);
    let found = match editable(&caller, &actor, &id).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let deleted: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(
        "update panel_metric_trees as t set deleted_at = now(), updated_at = now()
         where t.id = $1 and t.deleted_at is null
         returning to_jsonb(t)",
    )
    .bind(text(&found, "id"))
    .fetch_optional(&caller.db)
    .await;
    match deleted {
        Ok(Some(row)) => {
            let tree = weldsuite_db::js_row(row);
            publish(&caller, &state, &tree, PANEL_METRIC_TREE_DELETED);
            NoContent.into_response()
        }
        Ok(None) => ApiError::not_found("Metric tree", Some(text(&found, "id"))).into_response(),
        Err(error) => unexpected(&error, "delete metric tree"),
    }
}
