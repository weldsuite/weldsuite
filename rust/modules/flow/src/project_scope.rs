//! `/api/project-scope` (`routes/project-scope/index.ts`): the scope of a
//! project in `project_scope`, one row per project: the scope statement, what
//! is in scope and what is deliberately out, with the reason and, optionally,
//! the decision, change request or project it relates to (design:
//! weldflow-project-control.md).
//!
//! ```text
//! GET /:projectId   the scope (empty before the first save)
//! PUT /:projectId   save it: created on first save, a list left out stays as it is
//! ```
//!
//! The checks run in TypeScript's order: permission, then the project (404),
//! then project access (403), then the body (400), then the business rules.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{PROJECT_SCOPE_CREATED, PROJECT_SCOPE_UPDATED};
use weldsuite_db::js_row;
use weldsuite_flow_domain::decisions::decision_code;
use weldsuite_flow_domain::scope::{
    ScopeLinkTarget, messages, normalize_out_of_scope, out_of_scope_link_error, present_scope,
    scope_event_data, scope_link_key,
};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::governance_body::read_put_scope;
use crate::raid::{PROJECT_DENIED, PROJECT_WRITE_DENIED, iso_ms};
use crate::raid_body::{Body, parse_body};
use crate::raid_store::live_project_exists;
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{projectId}",
            get(fetch).route_layer(need("projects:read")),
        )
        .route(
            "/{projectId}",
            put(save).route_layer(need("projects:update")),
        )
        .with_state(state)
}

/// `findScope(db, projectId)`.
async fn find_scope(caller: &Caller, project_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from project_scope s where s.project_id = $1 limit 1",
    )
    .bind(project_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

/// `resolveScopeLinks(c, projectId, items)`: what the out-of-scope links of a
/// project resolve to, by `type:id`. A decision or change request counts only
/// in this project; another project only when the caller can read it. Links
/// that do not resolve are left out.
async fn resolve_scope_links(
    caller: &Caller,
    project_id: &str,
    items: &[Value],
) -> Result<HashMap<String, ScopeLinkTarget>, sqlx::Error> {
    let mut decisions: Vec<String> = Vec::new();
    let mut changes: Vec<String> = Vec::new();
    let mut projects: Vec<String> = Vec::new();
    for item in items {
        let (Some(_), Some(link_type), Some(link_id)) = (
            scope_link_key(item),
            item["linkType"].as_str(),
            item["linkId"].as_str(),
        ) else {
            continue;
        };
        let list = match link_type {
            "decision" => &mut decisions,
            "change_request" => &mut changes,
            "project" => &mut projects,
            _ => continue,
        };
        if !list.iter().any(|known| known == link_id) {
            list.push(link_id.to_owned());
        }
    }
    let db = &caller.db;
    let mut out = HashMap::new();
    if !decisions.is_empty() {
        let rows: Vec<(String, i32, String, String)> = sqlx::query_as(
            "select id, number, title, status from project_decisions
             where id = any($1) and project_id = $2 and deleted_at is null",
        )
        .bind(&decisions)
        .bind(project_id)
        .fetch_all(db)
        .await?;
        for (id, number, title, status) in rows {
            out.insert(
                format!("decision:{id}"),
                ScopeLinkTarget {
                    link_type: "decision",
                    code: Some(decision_code(i64::from(number))),
                    id,
                    title,
                    status: Some(status),
                },
            );
        }
    }
    if !changes.is_empty() {
        let rows: Vec<(String, i32, String, String)> = sqlx::query_as(
            "select id, number, title, status from project_change_requests
             where id = any($1) and project_id = $2 and deleted_at is null",
        )
        .bind(&changes)
        .bind(project_id)
        .fetch_all(db)
        .await?;
        for (id, number, title, status) in rows {
            out.insert(
                format!("change_request:{id}"),
                ScopeLinkTarget {
                    link_type: "change_request",
                    code: Some(format!("CR-{number}")),
                    id,
                    title,
                    status: Some(status),
                },
            );
        }
    }
    if !projects.is_empty() {
        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "select id, name, status from projects where id = any($1) and deleted_at is null",
        )
        .bind(&projects)
        .fetch_all(db)
        .await?;
        for (id, name, status) in rows {
            if !caller.can_access(&id).await? {
                continue;
            }
            out.insert(
                format!("project:{id}"),
                ScopeLinkTarget {
                    link_type: "project",
                    id,
                    code: None,
                    title: name,
                    status,
                },
            );
        }
    }
    Ok(out)
}

fn out_of_scope_of(row: &Value) -> Vec<Value> {
    row.get("outOfScope")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

// ── GET /:projectId ─────────────────────────────────────────────────────────

async fn fetch(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        fetch_scope(&caller, &project_id).await,
        "Failed to fetch scope",
    )
}

async fn fetch_scope(caller: &Caller, project_id: &str) -> Reply {
    if !live_project_exists(&caller.db, project_id).await? {
        return Err(Refusal::not_found("Project", project_id));
    }
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let row = find_scope(caller, project_id).await?;
    let items = row.as_ref().map(out_of_scope_of).unwrap_or_default();
    let targets = resolve_scope_links(caller, project_id, &items).await?;
    Ok(Data(present_scope(project_id, row.as_ref(), &targets)).into_response())
}

// ── PUT /:projectId ─────────────────────────────────────────────────────────

async fn save(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        let input = parse_body(&body, read_put_scope)?;
        if let Some(items) = input.get("outOfScope").and_then(Value::as_array)
            && let Some(message) = out_of_scope_link_error(items)
        {
            return Err(Refusal::bad_request(message));
        }
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        save_scope(&state, &caller, &project_id, &input).await,
        "Failed to save scope",
    )
}

async fn save_scope(state: &FlowState, caller: &Caller, project_id: &str, input: &Body) -> Reply {
    let out_of_scope: Option<Vec<Value>> = input
        .get("outOfScope")
        .and_then(Value::as_array)
        .map(|items| normalize_out_of_scope(items));
    if let Some(items) = &out_of_scope {
        let targets = resolve_scope_links(caller, project_id, items).await?;
        for item in items {
            if let Some(key) = scope_link_key(item)
                && !targets.contains_key(&key)
            {
                return Err(Refusal::bad_request(messages::LINK_NOT_FOUND));
            }
        }
    }

    let now = iso_ms(crate::now_ms());
    let existing = find_scope(caller, project_id).await?;
    let statement = match input.get("statement") {
        Some(statement) => statement.clone(),
        None => existing
            .as_ref()
            .map_or(Value::Null, |row| row["statement"].clone()),
    };
    let in_scope = input
        .get("inScope")
        .cloned()
        .or_else(|| existing.as_ref().map(|row| row["inScope"].clone()))
        .unwrap_or_else(|| json!([]));
    let out_of_scope = out_of_scope.map_or_else(
        || {
            existing
                .as_ref()
                .map_or_else(|| json!([]), |row| row["outOfScope"].clone())
        },
        Value::Array,
    );
    sqlx::query(
        "insert into project_scope (id, project_id, statement, in_scope, out_of_scope, created_by,
             updated_by, created_at, updated_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $6, $7::timestamptz, $7::timestamptz)
         on conflict (project_id) do update set statement = excluded.statement,
             in_scope = excluded.in_scope, out_of_scope = excluded.out_of_scope,
             updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(generate_id("scope"))
    .bind(project_id)
    .bind(statement.as_str())
    .bind(in_scope)
    .bind(out_of_scope)
    .bind(&caller.user_id)
    .bind(&now)
    .execute(&caller.db)
    .await?;
    let Some(row) = find_scope(caller, project_id).await? else {
        return Err(Refusal::Internal("the saved scope is missing".to_owned()));
    };

    let event = if existing.is_some() {
        PROJECT_SCOPE_UPDATED
    } else {
        PROJECT_SCOPE_CREATED
    };
    caller.publish(
        state,
        event,
        row["id"].as_str().unwrap_or_default(),
        &scope_event_data(&row),
    );
    let targets = resolve_scope_links(caller, project_id, &out_of_scope_of(&row)).await?;
    Ok(Data(present_scope(project_id, Some(&row), &targets)).into_response())
}
