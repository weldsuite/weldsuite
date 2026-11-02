//! `/api/notifications` (`app-api/src/routes/notifications`): the caller's
//! own notifications. Every route is scoped to the caller; another user's
//! row is a 404.
//!
//! - `GET /` (cursor list, with the actor's name and picture),
//!   `GET /unread-count`, `GET /:id`: `general:read`.
//! - `POST /read-all`, `POST /:id/read`, `DELETE /:id` (a soft delete):
//!   `general:read`, the baseline every role holds, since they only touch
//!   the caller's rows. Marking one read publishes `notification.updated`.
//! - `POST /` (`general:create`) and `PATCH /:id` (`general:update`): the
//!   generic row shell. The schemas pass unknown keys through, so every key
//!   naming a column reaches the insert or update ([`body`]).

pub(crate) mod body;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::NOTIFICATION_UPDATED;
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::body::{
    Column, Kind, col, column_values, js_min, parse_int, pg_bool, query_first, slice_end, sql_limit,
};
use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now, validate};

/// Not a catalog key (no role holds it but the owner's `*`); the route
/// requires it as written.
const GENERAL_CREATE: &str = "general:create";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(GENERAL_READ)))
        .route("/", post(create).route_layer(need(GENERAL_CREATE)))
        .route(
            "/unread-count",
            get(unread_count).route_layer(need(GENERAL_READ)),
        )
        .route("/read-all", post(read_all).route_layer(need(GENERAL_READ)))
        // Hono matches the literal segments only for their own method; any
        // other method reaches the `/:id` route with the segment as the id.
        .route(
            "/unread-count",
            patch(|caller, headers, body| {
                update(caller, Path("unread-count".to_owned()), headers, body)
            })
            .route_layer(need(GENERAL_UPDATE)),
        )
        .route(
            "/unread-count",
            delete(|caller| remove(caller, Path("unread-count".to_owned())))
                .route_layer(need(GENERAL_READ)),
        )
        .route(
            "/read-all",
            get(|caller| detail(caller, Path("read-all".to_owned())))
                .route_layer(need(GENERAL_READ)),
        )
        .route(
            "/read-all",
            patch(|caller, headers, body| {
                update(caller, Path("read-all".to_owned()), headers, body)
            })
            .route_layer(need(GENERAL_UPDATE)),
        )
        .route(
            "/read-all",
            delete(|caller| remove(caller, Path("read-all".to_owned())))
                .route_layer(need(GENERAL_READ)),
        )
        .route(
            "/{id}/read",
            post(mark_read).route_layer(need(GENERAL_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(GENERAL_READ)))
        .route("/{id}", patch(update).route_layer(need(GENERAL_UPDATE)))
        .route("/{id}", delete(remove).route_layer(need(GENERAL_READ)))
}

/// The `notifications` columns a body can reach, in table order.
const COLUMNS: [Column; 22] = [
    col("id", "id", Kind::Text(Some(30)), true),
    col("userId", "user_id", Kind::Text(Some(255)), true),
    col("title", "title", Kind::Text(Some(255)), true),
    col("body", "body", Kind::Text(None), false),
    col("category", "category", Kind::Text(Some(50)), true),
    col(
        "notificationType",
        "notification_type",
        Kind::Text(Some(50)),
        true,
    ),
    col("entityType", "entity_type", Kind::Text(Some(50)), false),
    col("entityId", "entity_id", Kind::Text(Some(30)), false),
    col("actionUrl", "action_url", Kind::Text(Some(500)), false),
    col("actorType", "actor_type", Kind::Text(Some(20)), false),
    col("actorId", "actor_id", Kind::Text(Some(255)), false),
    col("icon", "icon", Kind::Text(Some(50)), false),
    col("severity", "severity", Kind::Text(Some(20)), true),
    col("data", "data", Kind::Json, false),
    col("isRead", "is_read", Kind::Bool, true),
    col("readAt", "read_at", Kind::Timestamp, false),
    col("deliveredInApp", "delivered_in_app", Kind::Bool, true),
    col("deliveredEmail", "delivered_email", Kind::Bool, true),
    col("deliveredPush", "delivered_push", Kind::Bool, true),
    col("createdAt", "created_at", Kind::Timestamp, true),
    col("expiresAt", "expires_at", Kind::Timestamp, false),
    col("deletedAt", "deleted_at", Kind::Timestamp, false),
];

/// The caller's row with this id (deleted or not), if any.
async fn own(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from notifications t where id = $1 and user_id = $2 limit 1",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list notifications";
    let query = query_values(query.as_deref());
    // `Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100)`: no lower bound.
    let limit = query_first(&query, "limit")
        .filter(|text| !text.is_empty())
        .map_or(25.0, |text| js_min(parse_int(&text), 100.0));
    let is_read = query_first(&query, "isRead").filter(|text| !text.is_empty());
    let cursor = query_first(&query, "cursor").filter(|text| !text.is_empty());

    // The cursor row, any user's: its time as the route reads it (a `Date`,
    // so milliseconds) and its id.
    let mut after: Option<(Value, String)> = None;
    if let Some(cursor) = &cursor {
        let found: Result<Option<(Value, String)>, sqlx::Error> = sqlx::query_as(
            "select to_jsonb(date_trunc('milliseconds', created_at)), id
             from notifications where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await;
        match found {
            Ok(found) => after = found,
            Err(error) => return PlatformError::Database(error).respond(),
        }
    }
    answer(
        async {
            // `eq(t.isRead, q.isRead)`: Postgres reads the text as a boolean.
            let is_read = match &is_read {
                Some(text) => Some(
                    pg_bool(text)
                        .ok_or_else(|| PlatformError::internal(FAILED, "invalid boolean"))?,
                ),
                None => None,
            };
            page(&caller, limit, is_read, after)
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))
        }
        .await,
    )
}

async fn page(
    caller: &Caller,
    limit: f64,
    is_read: Option<bool>,
    after: Option<(Value, String)>,
) -> Result<Response, sqlx::Error> {
    let (after_at, after_id) = match &after {
        Some((at, id)) => (at.as_str().map(str::to_owned), Some(id.clone())),
        None => (None, None),
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from notifications t
         where user_id = $1 and deleted_at is null
           and ($2::boolean is null or is_read = $2)
           and ($3::timestamptz is null or created_at < $3::timestamptz
                or (created_at = $3::timestamptz and id < $4))
         order by created_at desc, id desc
         limit $5",
    )
    .bind(&caller.user_id)
    .bind(is_read)
    .bind(&after_at)
    .bind(&after_id)
    .bind(sql_limit(limit + 1.0))
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from notifications
         where user_id = $1 and deleted_at is null and ($2::boolean is null or is_read = $2)",
    )
    .bind(&caller.user_id)
    .bind(is_read)
    .fetch_one(&caller.db)
    .await?;

    let mut rows: Vec<Value> = rows.into_iter().map(js_row).collect();
    #[allow(clippy::cast_precision_loss)]
    let has_more = (rows.len() as f64) > limit;
    if has_more {
        rows.truncate(slice_end(rows.len(), limit));
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };

    // The actor's name and picture, for notifications a member triggered.
    let mut actor_ids: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(id) = user_actor(row)
            && !actor_ids.iter().any(|known| known == id)
        {
            actor_ids.push(id.to_owned());
        }
    }
    let mut actors: HashMap<String, (Value, Value)> = HashMap::new();
    if !actor_ids.is_empty() {
        let members: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select user_id, name, picture from workspace_members where user_id = any($1)",
        )
        .bind(&actor_ids)
        .fetch_all(&caller.db)
        .await?;
        // `new Map(entries)`: a later row for the same user wins.
        for (user_id, name, picture) in members {
            actors.insert(user_id, (json!(name), json!(picture)));
        }
    }
    let data: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let actor = user_actor(&row).and_then(|id| actors.get(id)).cloned();
            let (name, picture) = actor.unwrap_or((Value::Null, Value::Null));
            if let Value::Object(fields) = &mut row {
                fields.insert("actorName".to_owned(), name);
                fields.insert("actorAvatar".to_owned(), picture);
            }
            row
        })
        .collect();
    Ok(List::new(
        data,
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response())
}

/// The actor's user id when a member triggered the notification.
fn user_actor(row: &Value) -> Option<&str> {
    if row["actorType"] != "user" {
        return None;
    }
    row["actorId"].as_str().filter(|id| !id.is_empty())
}

// ── GET /unread-count ───────────────────────────────────────────────────────

async fn unread_count(caller: Caller) -> Response {
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(
        "select count(*) from notifications
         where user_id = $1 and is_read = false and deleted_at is null",
    )
    .bind(&caller.user_id)
    .fetch_one(&caller.db)
    .await;
    match count {
        Ok(count) => Data(json!({ "count": count })).into_response(),
        Err(error) => {
            PlatformError::internal("Failed to count unread notifications", error).respond()
        }
    }
}

// ── POST /read-all ──────────────────────────────────────────────────────────

async fn read_all(caller: Caller) -> Response {
    let updated = sqlx::query(
        "update notifications set is_read = true, read_at = $2::timestamptz
         where user_id = $1 and is_read = false and deleted_at is null",
    )
    .bind(&caller.user_id)
    .bind(now())
    .execute(&caller.db)
    .await;
    match updated {
        Ok(done) => Data(json!({ "updated": done.rows_affected() })).into_response(),
        Err(error) => {
            PlatformError::internal("Failed to mark notifications as read", error).respond()
        }
    }
}

// ── POST /:id/read ──────────────────────────────────────────────────────────

async fn mark_read(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to mark notification as read";
    answer(
        async {
            let existing = own(&caller.db, &id, &caller.user_id)
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            if existing.is_none() {
                return Err(ApiError::not_found("Notification", Some(&id)).into());
            }
            let row: Option<Value> = sqlx::query_scalar(
                "update notifications as t set is_read = true, read_at = $3::timestamptz
                 where id = $1 and user_id = $2
                 returning to_jsonb(t)",
            )
            .bind(&id)
            .bind(&caller.user_id)
            .bind(now())
            .fetch_optional(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            let row = js_row(row.ok_or_else(|| PlatformError::internal(FAILED, "row vanished"))?);
            caller.publish(
                &state,
                NOTIFICATION_UPDATED,
                &id,
                &json!({
                    "id": row["id"],
                    "title": row["title"],
                    "body": row["body"],
                    "category": row["category"],
                    "actionUrl": row["actionUrl"],
                    "entityType": row["entityType"],
                    "entityId": row["entityId"],
                }),
            );
            Ok(Data(row).into_response())
        }
        .await,
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match own(&caller.db, &id, &caller.user_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Notification", Some(&id)).into_response(),
        Err(error) => PlatformError::internal("Failed to fetch notification", error).respond(),
    }
}

// ── POST / and PATCH /:id ───────────────────────────────────────────────────

/// `createNotificationSchema` (`.partial()` for the update, which leaves
/// every rule as it is): the declared keys checked in order, every other key
/// passed through. The body itself is what reaches Drizzle.
fn read_notification(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    issues.text(body, "userId", Presence::Nullish, None, None);
    issues.text(body, "type", Presence::Optional, None, Some(50));
    issues.text(body, "title", Presence::Optional, None, Some(500));
    issues.text(body, "body", Presence::Optional, None, None);
    issues.text(body, "link", Presence::Optional, None, None);
    issues.boolean(body, "isRead", Presence::Optional);
    // `metadata: z.unknown().optional()` takes anything.
    body.clone()
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create notification";
    answer(
        async {
            let mut input = validate(&headers, &body, read_notification)?;
            // `{ id, ...data, createdAt: now }`: the route's `createdAt` wins.
            input.remove("createdAt");
            let values = column_values(&COLUMNS, &input)
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            for required in ["user_id", "title"] {
                if !values.contains_key(required) {
                    return Err(PlatformError::internal(
                        FAILED,
                        format!("{required}: null value violates the not-null constraint"),
                    ));
                }
            }
            let id = generate_id("ntf");
            let inserted = sqlx::query(
                "insert into notifications
                     (id, user_id, title, body, category, notification_type, entity_type,
                      entity_id, action_url, actor_type, actor_id, icon, severity, data,
                      is_read, read_at, delivered_in_app, delivered_email, delivered_push,
                      created_at, expires_at, deleted_at)
                 values (coalesce($1->>'id', $2), $1->>'user_id', $1->>'title', $1->>'body',
                         coalesce($1->>'category', 'system'),
                         coalesce($1->>'notification_type', 'custom'),
                         $1->>'entity_type', $1->>'entity_id', $1->>'action_url',
                         $1->>'actor_type', $1->>'actor_id', $1->>'icon',
                         coalesce($1->>'severity', 'info'), nullif($1->'data', 'null'::jsonb),
                         coalesce(($1->>'is_read')::boolean, false), null,
                         coalesce(($1->>'delivered_in_app')::boolean, true),
                         coalesce(($1->>'delivered_email')::boolean, false),
                         coalesce(($1->>'delivered_push')::boolean, false),
                         $3::timestamptz, null, null)
                 on conflict (id) do nothing",
            )
            .bind(Value::Object(values))
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            // A body `id` that is taken: the primary key refuses the row.
            if inserted.rows_affected() == 0 {
                return Err(PlatformError::internal(FAILED, "duplicate key"));
            }
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
    )
}

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update notification";
    answer(
        async {
            let input = validate(&headers, &body, read_notification)?;
            let existing = own(&caller.db, &id, &caller.user_id)
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            if existing.is_none() {
                return Err(ApiError::not_found("Notification", Some(&id)).into());
            }
            let values = column_values(&COLUMNS, &input)
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            ensure_settable(&caller.db, &values, &id, FAILED).await?;
            sqlx::query(
                "update notifications set
                     id = case when $1 ? 'id' then $1->>'id' else id end,
                     user_id = case when $1 ? 'user_id' then $1->>'user_id' else user_id end,
                     title = case when $1 ? 'title' then $1->>'title' else title end,
                     body = case when $1 ? 'body' then $1->>'body' else body end,
                     category = case when $1 ? 'category' then $1->>'category' else category end,
                     notification_type = case when $1 ? 'notification_type'
                         then $1->>'notification_type' else notification_type end,
                     entity_type = case when $1 ? 'entity_type'
                         then $1->>'entity_type' else entity_type end,
                     entity_id = case when $1 ? 'entity_id' then $1->>'entity_id' else entity_id end,
                     action_url = case when $1 ? 'action_url'
                         then $1->>'action_url' else action_url end,
                     actor_type = case when $1 ? 'actor_type'
                         then $1->>'actor_type' else actor_type end,
                     actor_id = case when $1 ? 'actor_id' then $1->>'actor_id' else actor_id end,
                     icon = case when $1 ? 'icon' then $1->>'icon' else icon end,
                     severity = case when $1 ? 'severity' then $1->>'severity' else severity end,
                     data = case when $1 ? 'data'
                         then nullif($1->'data', 'null'::jsonb) else data end,
                     is_read = case when $1 ? 'is_read'
                         then ($1->>'is_read')::boolean else is_read end,
                     read_at = case when $1 ? 'read_at' then null else read_at end,
                     delivered_in_app = case when $1 ? 'delivered_in_app'
                         then ($1->>'delivered_in_app')::boolean else delivered_in_app end,
                     delivered_email = case when $1 ? 'delivered_email'
                         then ($1->>'delivered_email')::boolean else delivered_email end,
                     delivered_push = case when $1 ? 'delivered_push'
                         then ($1->>'delivered_push')::boolean else delivered_push end,
                     expires_at = case when $1 ? 'expires_at' then null else expires_at end,
                     deleted_at = case when $1 ? 'deleted_at' then null else deleted_at end
                 where id = $2 and user_id = $3",
            )
            .bind(Value::Object(values))
            .bind(&id)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
    )
}

/// What makes Drizzle's `update … set` fail before it changes anything: no
/// column to set (an empty `SET`, a syntax error), or a new `id` that is
/// taken.
async fn ensure_settable(
    db: &PgPool,
    values: &Map<String, Value>,
    id: &str,
    failed: &'static str,
) -> PlatformResult<()> {
    body::ensure_some_column(values, failed)?;
    if let Some(new_id) = body::new_id(values, id) {
        let taken: bool =
            sqlx::query_scalar("select exists (select 1 from notifications where id = $1)")
                .bind(new_id)
                .fetch_one(db)
                .await
                .map_err(|error| PlatformError::internal(failed, error))?;
        if taken {
            return Err(PlatformError::internal(failed, "duplicate key"));
        }
    }
    Ok(())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete notification";
    answer(
        async {
            // A soft delete, scoped to the caller's live rows.
            let removed = sqlx::query(
                "update notifications set deleted_at = $3::timestamptz
                 where id = $1 and user_id = $2 and deleted_at is null",
            )
            .bind(&id)
            .bind(&caller.user_id)
            .bind(now())
            .execute(&caller.db)
            .await
            .map_err(|error| PlatformError::internal(FAILED, error))?;
            if removed.rows_affected() == 0 {
                return Err(ApiError::not_found("Notification", Some(&id)).into());
            }
            Ok(NoContent.into_response())
        }
        .await,
    )
}
