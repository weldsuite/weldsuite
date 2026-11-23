//! The caller's own task tags (`/api/task-tags`, `routes/task-tags/`) and
//! saved task projects (`/api/task-projects`, `routes/task-projects/`):
//! every read and write is scoped to the calling user.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, TASK_PROJECT_CREATED, TASK_PROJECT_DELETED, TASK_PROJECT_UPDATED, TASK_TAG_CREATED,
    TASK_TAG_DELETED, TASK_TAG_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{task_projects, task_tags};

use crate::{
    Caller, FlowState, Keyset, Query, Refusal, fetch_limit, json_rows, keyset_before,
    keyset_cursor, outside, page, paged, reply, row_json, validate,
};

/// Which personal list a router serves.
#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Tags,
    Projects,
}

impl Kind {
    fn resource(self) -> &'static str {
        match self {
            Self::Tags => "Task tag",
            Self::Projects => "Task project",
        }
    }

    fn events(self) -> (EventName, EventName, EventName) {
        match self {
            Self::Tags => (TASK_TAG_CREATED, TASK_TAG_UPDATED, TASK_TAG_DELETED),
            Self::Projects => (
                TASK_PROJECT_CREATED,
                TASK_PROJECT_UPDATED,
                TASK_PROJECT_DELETED,
            ),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tags => "task tag",
            Self::Projects => "task project",
        }
    }
}

#[derive(Clone)]
struct PersonalState {
    flow: FlowState,
    kind: Kind,
}

pub(crate) fn router<S, Q>(state: FlowState, kind: Kind, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("tasks:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("tasks:create")),
        )
        .route("/{id}", get(detail).route_layer(need("tasks:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("tasks:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("tasks:delete")),
        )
        .with_state(PersonalState { flow: state, kind })
}

/// The columns `task_tags` and `task_projects` share.
#[derive(Clone, Copy)]
struct Columns<C> {
    id: C,
    created_at: C,
    updated_at: C,
    deleted_at: C,
    user_id: C,
    name: C,
}

const TAGS: Columns<task_tags::Column> = Columns {
    id: task_tags::Column::Id,
    created_at: task_tags::Column::CreatedAt,
    updated_at: task_tags::Column::UpdatedAt,
    deleted_at: task_tags::Column::DeletedAt,
    user_id: task_tags::Column::UserId,
    name: task_tags::Column::Name,
};

const PROJECTS: Columns<task_projects::Column> = Columns {
    id: task_projects::Column::Id,
    created_at: task_projects::Column::CreatedAt,
    updated_at: task_projects::Column::UpdatedAt,
    deleted_at: task_projects::Column::DeletedAt,
    user_id: task_projects::Column::UserId,
    name: task_projects::Column::Name,
};

/// The row, the caller's own and live.
async fn own_row(caller: &Caller, kind: Kind, id: &str) -> Result<Option<Value>, DbErr> {
    match kind {
        Kind::Tags => own_row_in::<task_tags::Entity>(caller, TAGS, id).await,
        Kind::Projects => own_row_in::<task_projects::Entity>(caller, PROJECTS, id).await,
    }
}

async fn own_row_in<E>(
    caller: &Caller,
    columns: Columns<E::Column>,
    id: &str,
) -> Result<Option<Value>, DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize,
{
    E::find()
        .filter(columns.id.eq(id))
        .filter(columns.deleted_at.is_null())
        .filter(columns.user_id.eq(caller.user_id.as_str()))
        .one(&orm(&caller.db))
        .await?
        .map(row_json)
        .transpose()
}

/// A page of the caller's live rows (by name when searching) after the
/// cursor, newest first, and the count, whose conditions (deleted, user,
/// search) the flags switch.
async fn list_in<E>(
    db: &PgPool,
    columns: Columns<E::Column>,
    user_id: &str,
    search: Option<&str>,
    cursor: Option<&Keyset>,
    limit: i64,
    flags: [bool; 3],
) -> Result<(Vec<Value>, i64), DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize + Sync,
    E::Column: Copy,
{
    let mut rows = E::find()
        .filter(columns.deleted_at.is_null())
        .filter(columns.user_id.eq(user_id));
    if let Some(search) = search {
        rows = rows.filter(columns.name.ilike(search));
    }
    if let Some(cursor) = cursor {
        rows = rows.filter(keyset_before(columns.id, columns.created_at, cursor));
    }
    let rows = rows
        .order_by_desc(columns.created_at)
        .order_by_desc(columns.id)
        .limit(fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let mut count = Condition::all();
    if flags[0] {
        count = count.add(columns.deleted_at.is_null());
    }
    if flags[1] {
        count = count.add(columns.user_id.eq(user_id));
    }
    if flags[2]
        && let Some(search) = search
    {
        count = count.add(columns.name.ilike(search));
    }
    let total = E::find().filter(count).count(&orm(db)).await?;
    Ok((json_rows(rows)?, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// `update t set <the sent text fields>, updated_at = now where id = $id
/// and deleted_at is null and user_id = $user`.
async fn update_in<E>(
    caller: &Caller,
    columns: Columns<E::Column>,
    fields: &[(&str, E::Column)],
    data: &Map<String, Value>,
    id: &str,
) -> Result<(), DbErr>
where
    E: EntityTrait,
{
    let mut update = E::update_many();
    for (key, column) in fields {
        if let Some(value) = data.get(*key) {
            update = update.col_expr(*column, Expr::value(value.as_str().map(str::to_owned)));
        }
    }
    update
        .col_expr(columns.updated_at, Expr::value(utc_now()))
        .filter(columns.id.eq(id))
        .filter(columns.deleted_at.is_null())
        .filter(columns.user_id.eq(caller.user_id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `update t set deleted_at = now, updated_at = now where id = $id and
/// user_id = $user`.
async fn remove_in<E>(caller: &Caller, columns: Columns<E::Column>, id: &str) -> Result<(), DbErr>
where
    E: EntityTrait,
{
    let now = utc_now();
    E::update_many()
        .col_expr(columns.deleted_at, Expr::value(now))
        .col_expr(columns.updated_at, Expr::value(now))
        .filter(columns.id.eq(id))
        .filter(columns.user_id.eq(caller.user_id.as_str()))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(
    State(state): State<PersonalState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    let kind = state.kind;
    // `parseLimit(q.limit, 25, 100)`.
    let limit = q
        .get("limit")
        .and_then(weldsuite_flow_domain::js::parse_int)
        .filter(|n| *n >= 1)
        .map_or(25, |n| n.min(100));
    let search = q.present("search").map(contains_pattern);
    let cursor = match q.present("cursor") {
        Some(at) => {
            let found = match kind {
                Kind::Tags => keyset_cursor(&caller.db, TAGS.id, TAGS.created_at, at).await,
                Kind::Projects => {
                    keyset_cursor(&caller.db, PROJECTS.id, PROJECTS.created_at, at).await
                }
            };
            match found {
                Ok(cursor) => cursor,
                Err(error) => return outside(Err(error.into())),
            }
        }
        None => None,
    };
    // Deleted, user, search: with a cursor the count leaves out the last
    // condition (`conditions.slice(0, -1)`).
    let mut flags = [true, true, search.is_some()];
    if q.present("cursor").is_some()
        && cursor.is_none()
        && let Some(last) = flags.iter().rposition(|on| *on)
    {
        flags[last] = false;
    }
    let result = async {
        let (db, user, search, cursor) = (
            &caller.db,
            caller.user_id.as_str(),
            search.as_deref(),
            cursor.as_ref(),
        );
        let (rows, total) = match kind {
            Kind::Tags => {
                list_in::<task_tags::Entity>(db, TAGS, user, search, cursor, limit, flags).await?
            }
            Kind::Projects => {
                list_in::<task_projects::Entity>(db, PROJECTS, user, search, cursor, limit, flags)
                    .await?
            }
        };
        let (rows, has_more, next) = page(rows, limit);
        Ok::<_, Refusal>(paged(rows, total, has_more, next))
    }
    .await;
    reply(result, &format!("Failed to list {}s", kind.label()))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(
    State(state): State<PersonalState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let kind = state.kind;
    reply(
        async {
            let Some(row) = own_row(&caller, kind, &id).await? else {
                return Err(Refusal::not_found(kind.resource(), &id));
            };
            Ok(Data(row).into_response())
        }
        .await,
        &format!("Failed to fetch {}", kind.label()),
    )
}

// ── POST /, PATCH /:id ──────────────────────────────────────────────────────

/// `createTaskTagSchema` / `createTaskProjectSchema` (`.partial()` for a
/// PATCH), passthrough: the fields the routes take.
fn read_body(
    kind: Kind,
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let name = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut data = Map::new();
    let max_name = match kind {
        Kind::Tags => 100,
        Kind::Projects => 255,
    };
    if let Field::Set(value) = issues.text(fields, "name", name, Some(1), Some(max_name)) {
        data.insert("name".to_owned(), json!(value));
    }
    if matches!(kind, Kind::Projects)
        && let Field::Set(value) =
            issues.text(fields, "description", Presence::Optional, None, None)
    {
        data.insert("description".to_owned(), json!(value));
    }
    if let Field::Set(value) = issues.text(fields, "color", Presence::Optional, None, Some(50)) {
        data.insert("color".to_owned(), json!(value));
    }
    if matches!(kind, Kind::Projects) {
        issues.text(fields, "icon", Presence::Optional, None, Some(100));
    }
    data
}

async fn create(
    State(state): State<PersonalState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let kind = state.kind;
    let data = match validate(&headers, &body, |issues, fields| {
        read_body(kind, issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let id = generate_id(match kind {
                Kind::Tags => "ttag",
                Kind::Projects => "tpr",
            });
            let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
            let now = utc_now();
            match kind {
                Kind::Tags => {
                    task_tags::Entity::insert(task_tags::ActiveModel {
                        id: Set(id.clone()),
                        name: Set(text("name").unwrap_or_default()),
                        color: Set(text("color")),
                        user_id: Set(caller.user_id.clone()),
                        created_at: Set(now),
                        updated_at: Set(now),
                        ..Default::default()
                    })
                    .exec_without_returning(&orm(&caller.db))
                    .await?;
                }
                Kind::Projects => {
                    task_projects::Entity::insert(task_projects::ActiveModel {
                        id: Set(id.clone()),
                        name: Set(text("name").unwrap_or_default()),
                        description: Set(text("description")),
                        color: Set(text("color")),
                        user_id: Set(caller.user_id.clone()),
                        created_at: Set(now),
                        updated_at: Set(now),
                        ..Default::default()
                    })
                    .exec_without_returning(&orm(&caller.db))
                    .await?;
                }
            }
            caller.publish(
                &state.flow,
                kind.events().0,
                &id,
                &json!({ "id": id, "name": data.get("name"), "userId": caller.user_id }),
            );
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
        &format!("Failed to create {}", kind.label()),
    )
}

async fn update(
    State(state): State<PersonalState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let kind = state.kind;
    let data = match validate(&headers, &body, |issues, fields| {
        read_body(kind, issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let Some(existing) = own_row(&caller, kind, &id).await? else {
                return Err(Refusal::not_found(kind.resource(), &id));
            };
            match kind {
                Kind::Tags => {
                    use task_tags::Column;
                    let fields = [("name", Column::Name), ("color", Column::Color)];
                    update_in::<task_tags::Entity>(&caller, TAGS, &fields, &data, &id).await?;
                }
                Kind::Projects => {
                    use task_projects::Column;
                    let fields = [
                        ("name", Column::Name),
                        ("description", Column::Description),
                        ("color", Column::Color),
                    ];
                    update_in::<task_projects::Entity>(&caller, PROJECTS, &fields, &data, &id)
                        .await?;
                }
            }
            let name = data
                .get("name")
                .cloned()
                .unwrap_or_else(|| existing["name"].clone());
            caller.publish(
                &state.flow,
                kind.events().1,
                &id,
                &json!({ "id": id, "name": name, "userId": existing["userId"] }),
            );
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
        &format!("Failed to update {}", kind.label()),
    )
}

async fn remove(
    State(state): State<PersonalState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let kind = state.kind;
    reply(
        async {
            if own_row(&caller, kind, &id).await?.is_none() {
                return Err(Refusal::not_found(kind.resource(), &id));
            }
            match kind {
                Kind::Tags => remove_in::<task_tags::Entity>(&caller, TAGS, &id).await?,
                Kind::Projects => {
                    remove_in::<task_projects::Entity>(&caller, PROJECTS, &id).await?;
                }
            }
            caller.publish(&state.flow, kind.events().2, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        &format!("Failed to delete {}", kind.label()),
    )
}
