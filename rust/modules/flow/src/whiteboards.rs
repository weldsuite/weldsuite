//! `/api/whiteboards` (`routes/whiteboards/index.ts`): a project's
//! whiteboards; the editor saves the whole `elements` array on every change.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    PROJECT_WHITEBOARD_CREATED, PROJECT_WHITEBOARD_DELETED, PROJECT_WHITEBOARD_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::js::contains_pattern;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{
    Caller, FlowState, Query, Refusal, Reply, access_scope, forbidden, keyset_cursor, list_limit,
    now, outside, page, paged, reply, validate,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";

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

async fn whiteboard_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(w) from project_whiteboards w
         where w.id = $1 and (not $2 or w.deleted_at is null) limit 1",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    outside(list_whiteboards(&caller, &q).await)
}

macro_rules! whiteboard_filters {
    () => {
        concat!(
            "($1::bool is not true or w.deleted_at is null)",
            " and ($2::text is null or w.project_id = $2)",
            " and ($3::bool is not true or ",
            in_accessible!("w.project_id", "$4", "$5"),
            ")",
            " and ($6::text is null or w.name ilike $6)"
        )
    };
}

async fn list_whiteboards(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    let limit = list_limit(q, 100, 100);
    let project_id = q.present("projectId").map(str::to_owned);
    let (all, ids) = if let Some(project_id) = &project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        (true, Vec::new())
    } else {
        access_scope(caller).await?
    };
    let search = q.present("search").map(contains_pattern);
    let cursor = match q.present("cursor") {
        Some(cursor) => {
            keyset_cursor(
                db,
                "select id, to_jsonb(created_at) #>> '{}' from project_whiteboards where id = $1 limit 1",
                cursor,
            )
            .await?
        }
        None => None,
    };
    // Deleted, project, scope, search: with a cursor the count leaves out
    // the last condition (`conditions.slice(0, -1)`).
    let mut flags = [true, project_id.is_some(), project_id.is_none(), search.is_some()];
    let row_flags = flags;
    if q.present("cursor").is_some()
        && cursor.is_none()
        && let Some(last) = flags.iter().rposition(|on| *on)
    {
        flags[last] = false;
    }
    let result = async {
        let Some(limit) = limit else {
            return Err(Refusal::Internal("limit is NaN".to_owned()));
        };
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select to_jsonb(w) from project_whiteboards w where ",
            whiteboard_filters!(),
            " and ($7::timestamp is null or w.created_at > $7::timestamp",
            " or (w.created_at = $7::timestamp and w.id > $8))",
            " order by w.created_at asc, w.id asc limit $9"
        ))
        .bind(row_flags[0])
        .bind(project_id.as_deref())
        .bind(row_flags[2])
        .bind(all)
        .bind(&ids)
        .bind(search.as_deref())
        .bind(cursor.as_ref().map(|c| c.0.as_str()))
        .bind(cursor.as_ref().map(|c| c.1.as_str()))
        .bind(limit + 1)
        .fetch_all(db)
        .await?;
        let total: i64 = sqlx::query_scalar(concat!(
            "select count(*) from project_whiteboards w where ",
            whiteboard_filters!()
        ))
        .bind(flags[0])
        .bind(project_id.as_deref().filter(|_| flags[1]))
        .bind(flags[2])
        .bind(all)
        .bind(&ids)
        .bind(search.as_deref().filter(|_| flags[3]))
        .fetch_one(db)
        .await?;
        let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
        Ok(paged(rows, total, has_more, next))
    }
    .await;
    Ok(reply(result, "Failed to list whiteboards"))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = whiteboard_row(&caller.db, &id, true).await? else {
                return Err(Refusal::not_found("Whiteboard", &id));
            };
            if let Some(project) = row["projectId"].as_str().filter(|p| !p.is_empty())
                && !caller.can_access(project).await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(row).into_response())
        }
        .await,
        "Failed to fetch whiteboard",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    State(state): State<FlowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let project_id = issues.text(fields, "projectId", Presence::Required, Some(1), None);
        let name = issues.text(fields, "name", Presence::Optional, Some(1), None);
        let elements = issues.list(fields, "elements", Presence::Optional, None, None, |_, item| {
            Some(item.clone())
        });
        (
            project_id.into_option().unwrap_or_default(),
            name.into_option().unwrap_or_else(|| "Whiteboard".to_owned()),
            elements.into_option(),
        )
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let (project_id, name, elements) = input;
    if !project_id.is_empty() {
        match caller.can_write(&project_id).await {
            Ok(true) => {}
            Ok(false) => return forbidden(PROJECT_WRITE_DENIED),
            Err(error) => return outside(Err(error.into())),
        }
    }
    reply(
        async {
            let id = generate_id("pwb");
            sqlx::query(
                "insert into project_whiteboards (id, project_id, name, elements, created_at, updated_at)
                 values ($1, $2, $3, $4, $5::timestamp, $5::timestamp)",
            )
            .bind(&id)
            .bind(&project_id)
            .bind(&name)
            .bind(Value::Array(elements.unwrap_or_default()))
            .bind(now())
            .execute(&caller.db)
            .await?;
            let created = whiteboard_row(&caller.db, &id, false).await?;
            caller.publish(
                &state,
                PROJECT_WHITEBOARD_CREATED,
                &id,
                &json!({ "id": id, "projectId": project_id, "name": name }),
            );
            Ok(Created(created.unwrap_or(Value::Null)).into_response())
        }
        .await,
        "Failed to create whiteboard",
    )
}

// ── PATCH /:id, DELETE /:id ─────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, elements) = match validate(&headers, &body, |issues, fields| {
        let name = issues.text(fields, "name", Presence::Optional, Some(1), None);
        let elements = issues.list(fields, "elements", Presence::Optional, None, None, |_, item| {
            Some(item.clone())
        });
        (name.into_option(), elements.into_option())
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    reply(
        async {
            let project: Option<String> = sqlx::query_scalar(
                "select project_id from project_whiteboards where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Whiteboard", &id));
            };
            if !project.is_empty() && !caller.can_write(&project).await? {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            sqlx::query(
                "update project_whiteboards set
                     name = coalesce($2, name),
                     elements = case when $3::jsonb is not null then $3 else elements end,
                     last_edited_by = case when $3::jsonb is not null then $4 else last_edited_by end,
                     updated_at = $5::timestamp
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(name.as_deref())
            .bind(elements.map(Value::Array))
            .bind(caller.user())
            .bind(now())
            .execute(&caller.db)
            .await?;
            let updated = whiteboard_row(&caller.db, &id, false).await?;
            caller.publish(
                &state,
                PROJECT_WHITEBOARD_UPDATED,
                &id,
                &json!({ "id": id, "name": updated.as_ref().map(|u| u["name"].clone()) }),
            );
            Ok(Data(updated.unwrap_or(Value::Null)).into_response())
        }
        .await,
        "Failed to update whiteboard",
    )
}

async fn remove(State(state): State<FlowState>, caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let project: Option<String> = sqlx::query_scalar(
                "select project_id from project_whiteboards where id = $1 and deleted_at is null limit 1",
            )
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(project) = project else {
                return Err(Refusal::not_found("Whiteboard", &id));
            };
            if !project.is_empty() && !caller.can_write(&project).await? {
                return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
            }
            sqlx::query(
                "update project_whiteboards set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
            caller.publish(&state, PROJECT_WHITEBOARD_DELETED, &id, &json!({ "id": id }));
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete whiteboard",
    )
}
