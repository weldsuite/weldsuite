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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, TASK_PROJECT_CREATED, TASK_PROJECT_DELETED, TASK_PROJECT_UPDATED, TASK_TAG_CREATED,
    TASK_TAG_DELETED, TASK_TAG_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{
    Caller, FlowState, Query, Refusal, keyset_cursor, now, outside, page, paged, reply, validate,
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

/// The row as `to_jsonb`, the caller's own and live.
async fn own_row(caller: &Caller, kind: Kind, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = match kind {
        Kind::Tags => {
            sqlx::query_scalar(
                "select to_jsonb(t) from task_tags t
                 where t.id = $1 and t.deleted_at is null and t.user_id = $2 limit 1",
            )
            .bind(id)
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await?
        }
        Kind::Projects => {
            sqlx::query_scalar(
                "select to_jsonb(t) from task_projects t
                 where t.id = $1 and t.deleted_at is null and t.user_id = $2 limit 1",
            )
            .bind(id)
            .bind(&caller.user_id)
            .fetch_optional(&caller.db)
            .await?
        }
    };
    Ok(row.map(js_row))
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
    let cursor_sql = match kind {
        Kind::Tags => {
            "select id, to_jsonb(created_at) #>> '{}' from task_tags where id = $1 limit 1"
        }
        Kind::Projects => {
            "select id, to_jsonb(created_at) #>> '{}' from task_projects where id = $1 limit 1"
        }
    };
    let cursor = match q.present("cursor") {
        Some(at) => match keyset_cursor(&caller.db, cursor_sql, at).await {
            Ok(cursor) => cursor,
            Err(error) => return outside(Err(error.into())),
        },
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
        macro_rules! personal_list {
            ($table:literal) => {
                (
                    concat!(
                        "select to_jsonb(t) from ", $table, " t where t.deleted_at is null and t.user_id = $1",
                        " and ($2::text is null or t.name ilike $2)",
                        " and ($3::timestamp is null or t.created_at < $3::timestamp",
                        " or (t.created_at = $3::timestamp and t.id < $4))",
                        " order by t.created_at desc, t.id desc limit $5"
                    ),
                    concat!(
                        "select count(*) from ", $table, " t where ($1::bool is not true or t.deleted_at is null)",
                        " and ($2::text is null or t.user_id = $2) and ($3::text is null or t.name ilike $3)"
                    ),
                )
            };
        }
        let (rows_sql, count_sql) = match kind {
            Kind::Tags => personal_list!("task_tags"),
            Kind::Projects => personal_list!("task_projects"),
        };
        let rows: Vec<Value> = sqlx::query_scalar(rows_sql)
            .bind(&caller.user_id)
            .bind(search.as_deref())
            .bind(cursor.as_ref().map(|c| c.0.as_str()))
            .bind(cursor.as_ref().map(|c| c.1.as_str()))
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
        let total: i64 = sqlx::query_scalar(count_sql)
            .bind(flags[0])
            .bind(Some(caller.user_id.as_str()).filter(|_| flags[1]))
            .bind(search.as_deref().filter(|_| flags[2]))
            .fetch_one(&caller.db)
            .await?;
        let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
        Ok(paged(rows, total, has_more, next))
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
            match kind {
                Kind::Tags => {
                    sqlx::query(
                        "insert into task_tags (id, name, color, user_id, created_at, updated_at)
                         values ($1, $2, $3, $4, $5::timestamp, $5::timestamp)",
                    )
                    .bind(&id)
                    .bind(text("name"))
                    .bind(text("color"))
                    .bind(&caller.user_id)
                    .bind(now())
                    .execute(&caller.db)
                    .await?;
                }
                Kind::Projects => {
                    sqlx::query(
                        "insert into task_projects (id, name, description, color, user_id, created_at, updated_at)
                         values ($1, $2, $3, $4, $5, $6::timestamp, $6::timestamp)",
                    )
                    .bind(&id)
                    .bind(text("name"))
                    .bind(text("description"))
                    .bind(text("color"))
                    .bind(&caller.user_id)
                    .bind(now())
                    .execute(&caller.db)
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
            let set = Value::Object(data.clone());
            match kind {
                Kind::Tags => {
                    sqlx::query(concat!(
                        "update task_tags set ",
                        set_text!("name", "name"),
                        ", ",
                        set_text!("color", "color"),
                        ", updated_at = $4::timestamp",
                        " where id = $2 and deleted_at is null and user_id = $3"
                    ))
                    .bind(&set)
                    .bind(&id)
                    .bind(&caller.user_id)
                    .bind(now())
                    .execute(&caller.db)
                    .await?;
                }
                Kind::Projects => {
                    sqlx::query(concat!(
                        "update task_projects set ",
                        set_text!("name", "name"),
                        ", ",
                        set_text!("description", "description"),
                        ", ",
                        set_text!("color", "color"),
                        ", updated_at = $4::timestamp",
                        " where id = $2 and deleted_at is null and user_id = $3"
                    ))
                    .bind(&set)
                    .bind(&id)
                    .bind(&caller.user_id)
                    .bind(now())
                    .execute(&caller.db)
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
            let sql = match kind {
                Kind::Tags => {
                    "update task_tags set deleted_at = $3::timestamp, updated_at = $3::timestamp
                     where id = $1 and user_id = $2"
                }
                Kind::Projects => {
                    "update task_projects set deleted_at = $3::timestamp, updated_at = $3::timestamp
                     where id = $1 and user_id = $2"
                }
            };
            sqlx::query(sql)
                .bind(&id)
                .bind(&caller.user_id)
                .bind(now())
                .execute(&caller.db)
                .await?;
            caller.publish(&state.flow, kind.events().2, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        &format!("Failed to delete {}", kind.label()),
    )
}
