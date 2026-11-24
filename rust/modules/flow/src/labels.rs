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
use sea_orm::sea_query::{Alias, Asterisk, Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_LABEL_CREATED, PROJECT_LABEL_DELETED, PROJECT_LABEL_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Issues, Presence, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{project_labels, tasks};

use crate::js::{Js, js_string};
use crate::projects::writable;
use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, fetch_limit, forbidden, in_accessible,
    json_rows, keyset_before, keyset_cursor, list_limit, outside, page, paged, reply, row_json,
    validate,
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
) -> Result<bool, DbErr> {
    use project_labels::Column;
    let trimmed = Func::lower(Func::cust("btrim").arg(Expr::col(Column::Name)));
    let mut found = project_labels::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(
            Expr::from(trimmed),
            js_trim(name).to_lowercase(),
        ));
    found = match project_id.filter(|p| !p.is_empty()) {
        Some(project_id) => found.filter(
            Condition::any()
                .add(Column::ProjectId.eq(project_id))
                .add(Column::ProjectId.is_null()),
        ),
        None => found.filter(Column::ProjectId.is_null()),
    };
    if let Some(exclude) = exclude {
        found = found.filter(Column::Id.ne(exclude));
    }
    let found: Option<String> = found.into_tuple().one(&orm(db)).await?;
    Ok(found.is_some())
}

/// `labelScopeCondition` and the search: that project's labels and the
/// workspace-wide ones, or the workspace-wide ones and the caller's
/// projects'.
fn label_filters(
    project_id: Option<&str>,
    scope: &(bool, Vec<String>),
    search: Option<&str>,
) -> Condition {
    use project_labels::Column;
    let in_scope = match project_id {
        Some(project_id) => Condition::any()
            .add(Column::ProjectId.eq(project_id))
            .add(Column::ProjectId.is_null()),
        None => Condition::any()
            .add(Column::ProjectId.is_null())
            .add(in_accessible(Column::ProjectId, scope)),
    };
    let mut filters = Condition::all()
        .add(Column::DeletedAt.is_null())
        .add(in_scope);
    if let Some(search) = search {
        filters = filters.add(Column::Name.ilike(search));
    }
    filters
}

/// How many visible tasks carry each label (`taskUsageScope`): `select
/// jsonb_array_elements_text(t.labels) as label_id, count(*)::int from
/// tasks t where … group by label_id`.
async fn label_usage(
    db: &PgPool,
    scope: &(bool, Vec<String>),
) -> Result<HashMap<String, i32>, DbErr> {
    use tasks::Column;
    let label = Alias::new("label_id");
    let usage: Vec<(Option<String>, i32)> = tasks::Entity::find()
        .select_only()
        .column_as(
            Expr::from(
                Func::cust("jsonb_array_elements_text")
                    .arg(Expr::col((tasks::Entity, Column::Labels))),
            ),
            "label_id",
        )
        .column_as(
            sea_orm::ExprTrait::cast_as(Expr::from(Func::count(Expr::col(Asterisk))), "int"),
            "count",
        )
        .filter(Column::Labels.is_not_null())
        .filter(Column::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(Column::ProjectId.is_null())
                .add(in_accessible(Column::ProjectId, scope)),
        )
        .group_by(Expr::col(label))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(usage
        .into_iter()
        .filter_map(|(label, count)| label.map(|l| (l, count)))
        .collect())
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
            use project_labels::Column;
            keyset_cursor(db, Column::Id, Column::CreatedAt, cursor).await?
        }
        None => None,
    };
    // `taskUsageScope`: only tasks of projects the caller can see.
    let usage_scope = access_scope(caller).await?;
    let result = async {
        use project_labels::Column;
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let filters = label_filters(project_id.as_deref(), &(all, ids), search.as_deref());
        let mut rows = project_labels::Entity::find().filter(filters.clone());
        if let Some(cursor) = &cursor {
            rows = rows.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
        }
        let rows = rows
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(fetch_limit(limit)?)
            .all(&orm(db))
            .await?;
        let total = project_labels::Entity::find()
            .filter(filters)
            .count(&orm(db))
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let counts = label_usage(db, &usage_scope).await?;
        let (rows, has_more, next) = page(json_rows(rows)?, limit);
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

async fn label_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    project_labels::Entity::find_by_id(id)
        .filter(project_labels::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// The live label's `projectId`, `None` when there is no such label.
async fn label_project(db: &PgPool, id: &str) -> Result<Option<Option<String>>, DbErr> {
    use project_labels::Column;
    project_labels::Entity::find_by_id(id)
        .select_only()
        .column(Column::ProjectId)
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
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
fn read_label(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
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
    let body = match validate(&headers, &body, |issues, fields| {
        read_label(issues, fields, false)
    }) {
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
            let now = utc_now();
            let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
            project_labels::Entity::insert(project_labels::ActiveModel {
                id: Set(id.clone()),
                created_at: Set(now),
                updated_at: Set(now),
                name: Set(text("name").unwrap_or_default()),
                color: Set(text("color").unwrap_or_default()),
                project_id: Set(text("projectId")),
                ..Default::default()
            })
            .exec_without_returning(&orm(&caller.db))
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
    let body = match validate(&headers, &body, |issues, fields| {
        read_label(issues, fields, true)
    }) {
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
    let Some(existing_project) = label_project(db, id).await? else {
        return Err(Refusal::not_found("Project label", id));
    };
    if let Some(project) = existing_project.as_deref().filter(|p| !p.is_empty())
        && !caller.can_write(project).await?
    {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    if let Some(next) = data
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
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
    {
        use project_labels::Column;
        let mut update = project_labels::Entity::update_many();
        for (key, column) in [
            ("name", Column::Name),
            ("color", Column::Color),
            ("projectId", Column::ProjectId),
        ] {
            if let Some(value) = data.get(key) {
                update = update.col_expr(column, Expr::value(value.as_str().map(str::to_owned)));
            }
        }
        update
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(id))
            .filter(Column::DeletedAt.is_null())
            .exec(&orm(db))
            .await?;
    }
    let mut out = data;
    out.insert("id".to_owned(), json!(id));
    let out = Value::Object(out);
    caller.publish(state, PROJECT_LABEL_UPDATED, id, &out);
    Ok(Data(out).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(project) = label_project(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Project label", &id));
            };
            if let Some(project) = project.as_deref().filter(|p| !p.is_empty())
                && !caller.can_write(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            let now = utc_now();
            project_labels::Entity::update_many()
                .col_expr(project_labels::Column::DeletedAt, Expr::value(now))
                .col_expr(project_labels::Column::UpdatedAt, Expr::value(now))
                .filter(project_labels::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
            caller.publish(&state, PROJECT_LABEL_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete project label",
    )
}
