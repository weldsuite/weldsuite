//! `/api/project-labels` (`routes/project-labels/index.ts`): a project's
//! labels plus the workspace-wide ones (no project), with how many visible
//! tasks carry each; names are unique per list, case-insensitively.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_LABEL_CREATED, PROJECT_LABEL_DELETED, PROJECT_LABEL_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Issues, Presence, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{Js, js_string};
use crate::projects::{bindable, writable};
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, keyset_cursor, list_limit,
    now, outside, page, paged, reply, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const DEFAULT_LABEL_COLOR: &str = "#6b7280";
const WRITABLE: [&str; 3] = ["name", "color", "projectId"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("projects:create")),
        )
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("projects:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("projects:delete")),
        )
        .with_state(state)
}

/// A live label with this name (trimmed, any case) in the same list
/// (`findDuplicateLabel`): a project's list includes the workspace-wide
/// labels.
async fn duplicate(
    db: &PgPool,
    name: &str,
    project_id: Option<&str>,
    exclude: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from project_labels
         where deleted_at is null and lower(btrim(name)) = $1
           and (case when $2::text is not null then (project_id = $2 or project_id is null)
                     else project_id is null end)
           and ($3::text is null or id <> $3)
         limit 1",
    )
    .bind(js_trim(name).to_lowercase())
    .bind(project_id.filter(|p| !p.is_empty()))
    .bind(exclude)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

fn duplicate_message(name: &str) -> String {
    format!("A label named \"{name}\" already exists")
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_labels(&caller, &q).await)
}

async fn list_labels(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    let limit = list_limit(q, 25, 100);
    let project_id = q.present("projectId").map(str::to_owned);
    // `labelScopeCondition`: that project's labels and the workspace-wide
    // ones, or the workspace-wide ones and the caller's projects'.
    let (all, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (false, Vec::new())
    } else {
        access_scope(caller).await?
    };
    let search = q.present("search").map(contains_pattern);
    let cursor = match q.present("cursor") {
        Some(cursor) => {
            keyset_cursor(
                db,
                "select id, to_jsonb(created_at) #>> '{}' from project_labels where id = $1 limit 1",
                cursor,
            )
            .await?
        }
        None => None,
    };
    // `taskUsageScope`: only tasks of projects the caller can see.
    let usage_scope = access_scope(caller).await?;
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(l) from project_labels l where l.deleted_at is null",
            " and (case when $1::text is not null then (l.project_id = $1 or l.project_id is null)",
            " else (l.project_id is null or ",
            in_accessible!("l.project_id", "$2", "$3"),
            ") end)",
            " and ($4::text is null or l.name ilike $4)",
            " and ($5::timestamp is null or l.created_at < $5::timestamp",
            " or (l.created_at = $5::timestamp and l.id < $6))",
            " order by l.created_at desc, l.id desc limit $7"
        ))
        .bind(project_id.as_deref())
        .bind(all)
        .bind(&ids)
        .bind(search.as_deref())
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
        let total: i64 = sqlx::query_scalar(concat!(
            "select count(*) from project_labels l where l.deleted_at is null",
            " and (case when $1::text is not null then (l.project_id = $1 or l.project_id is null)",
            " else (l.project_id is null or ",
            in_accessible!("l.project_id", "$2", "$3"),
            ") end)",
            " and ($4::text is null or l.name ilike $4)"
        ))
        .bind(project_id.as_deref())
        .bind(all)
        .bind(&ids)
        .bind(search.as_deref())
        .fetch_one(db)
        .await?;
        let usage: Vec<(Option<String>, i32)> = sqlx::query_as(concat!(
            "select jsonb_array_elements_text(t.labels) as label_id, count(*)::int as count",
            " from tasks t where t.labels is not null and t.deleted_at is null",
            " and (t.project_id is null or ",
            in_accessible!("t.project_id", "$1", "$2"),
            ") group by label_id"
        ))
        .bind(usage_scope.0)
        .bind(&usage_scope.1)
        .fetch_all(db)
        .await?;
        let counts: HashMap<String, i32> = usage
            .into_iter()
            .filter_map(|(label, count)| label.map(|l| (l, count)))
            .collect();
        let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                let id = row["id"].as_str().unwrap_or_default();
                row["usageCount"] = json!(counts.get(id).copied().unwrap_or(0));
                row
            })
            .collect();
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list project labels"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn label_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from project_labels l where l.id = $1 and l.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = label_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Project label", &id));
            };
            if let Some(project_id) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project_id).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch project label",
    )
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// `createProjectLabelSchema` (`.partial()` for a PATCH), passthrough.
fn read_label(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let name = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(fields, "name", name, Some(1), Some(100));
    issues.text(fields, "color", Presence::Optional, None, Some(50));
    issues.text(fields, "projectId", Presence::Nullish, None, None);
    fields.clone()
}

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| read_label(issues, fields, false)) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Ok(mut data) = writable(&body, &WRITABLE, &[]) else {
        return ApiError::internal().into_response();
    };
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_owned);
    if let Some(project_id) = &project_id {
        match caller.can_write(project_id).await {
            Ok(true) => {}
            Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
            Err(error) => return outside(Err(error.into())),
        }
    }
    let name = js_trim(&js_string(&Js::from_jsonb(
        data.get("name").unwrap_or(&Value::Null),
    )))
    .to_owned();
    if name.is_empty() {
        return ApiError::bad_request("Label name is required").into_response();
    }
    data.insert("name".to_owned(), json!(name));
    if matches!(data.get("color"), None | Some(Value::Null)) {
        data.insert("color".to_owned(), json!(DEFAULT_LABEL_COLOR));
    }
    reply(
        async {
            if duplicate(&caller.db, &name, project_id.as_deref(), None).await? {
                return Err(Refusal::conflict(&duplicate_message(&name)));
            }
            let id = generate_id("plbl");
            sqlx::query(concat!(
                "insert into project_labels (id, created_at, updated_at, name, color, project_id)",
                " values ($2, $3::timestamp, $3::timestamp, ",
                val_text!("name", "null"),
                ", ",
                val_text!("color", "null"),
                ", ",
                val_text!("projectId", "null"),
                ")"
            ))
            .bind(bindable(&data))
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            let mut out = data.clone();
            out.insert("id".to_owned(), json!(id));
            let out = Value::Object(out);
            caller.publish(&state, PROJECT_LABEL_CREATED, &id, &out);
            Ok(Created(out).into_response())
        }
        .await,
        "Failed to create project label",
    )
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, |issues, fields| read_label(issues, fields, true)) {
        Ok(body) => body,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let Ok(data) = writable(&body, &WRITABLE, &[]) else {
        return ApiError::internal().into_response();
    };
    reply(
        update_label(&state, &caller, &id, data).await,
        "Failed to update project label",
    )
}

async fn update_label(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    mut data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let existing: Option<Option<String>> = sqlx::query_scalar(
        "select project_id from project_labels where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(existing_project) = existing else {
        return Err(Refusal::not_found("Project label", id));
    };
    if let Some(project) = existing_project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if let Some(next) = data.get("projectId").and_then(Value::as_str).filter(|p| !p.is_empty())
        && Some(next) != existing_project.as_deref()
        && !caller.can_write(next).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if let Some(Value::String(name)) = data.get("name") {
        let name = js_trim(name).to_owned();
        if name.is_empty() {
            return Err(Refusal::bad_request("Label name is required"));
        }
        let target = match data.get("projectId") {
            Some(project) => project.as_str().map(str::to_owned),
            None => existing_project.clone(),
        };
        if duplicate(db, &name, target.as_deref(), Some(id)).await? {
            return Err(Refusal::conflict(&duplicate_message(&name)));
        }
        data.insert("name".to_owned(), json!(name));
    }
    sqlx::query(concat!(
        "update project_labels set ",
        set_text!("name", "name"),
        ", ",
        set_text!("color", "color"),
        ", ",
        set_text!("projectId", "project_id"),
        ", updated_at = $3::timestamp where id = $2 and deleted_at is null"
    ))
    .bind(bindable(&data))
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    let mut out = data;
    out.insert("id".to_owned(), json!(id));
    let out = Value::Object(out);
    caller.publish(state, PROJECT_LABEL_UPDATED, id, &out);
    Ok(Data(out).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let project: Option<Option<String>> = sqlx::query_scalar(
                "select project_id from project_labels where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Project label", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            sqlx::query(
                "update project_labels set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_LABEL_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete project label",
    )
}
