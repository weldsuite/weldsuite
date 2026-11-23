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
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, IdenStatic, Iterable,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::NOTIFICATION_UPDATED;
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Issues, Presence, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{notifications, workspace_members};

use self::body::{
    Column, Kind, col, column_values, js_min, parse_int, pg_bool, query_first, slice_end, sql_limit,
};
use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate};

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

/// A row as `to_jsonb` through `js_row` read it: the entity serializes as
/// Drizzle did.
fn row_json(row: notifications::Model) -> Value {
    serde_json::to_value(row).unwrap_or(Value::Null)
}

/// The caller's row with this id (deleted or not), if any.
async fn own(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, DbErr> {
    let row = notifications::Entity::find()
        .filter(notifications::Column::Id.eq(id))
        .filter(notifications::Column::UserId.eq(user_id))
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json))
}

/// `user_id = $1 and deleted_at is null and ($2 is null or is_read = $2)`.
fn live_of(user_id: &str, is_read: Option<bool>) -> Condition {
    let mut condition = Condition::all()
        .add(notifications::Column::UserId.eq(user_id))
        .add(notifications::Column::DeletedAt.is_null());
    if let Some(is_read) = is_read {
        condition = condition.add(notifications::Column::IsRead.eq(is_read));
    }
    condition
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
    let mut after: Option<(OffsetDateTime, String)> = None;
    if let Some(cursor) = &cursor {
        let found: Result<Option<(OffsetDateTime, String)>, DbErr> =
            notifications::Entity::find()
                .select_only()
                .columns([notifications::Column::CreatedAt, notifications::Column::Id])
                .filter(notifications::Column::Id.eq(cursor))
                .into_tuple()
                .one(&orm(&caller.db))
                .await;
        match found {
            Ok(found) => {
                after = found.map(|(at, id)| (utc_timestamp(at).assume_utc(), id));
            }
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
    after: Option<(OffsetDateTime, String)>,
) -> Result<Response, DbErr> {
    use notifications::Column as N;
    let db = orm(&caller.db);
    let mut select = notifications::Entity::find().filter(live_of(&caller.user_id, is_read));
    if let Some((at, id)) = after {
        select = select.filter(
            Condition::any().add(N::CreatedAt.lt(at)).add(
                Condition::all()
                    .add(N::CreatedAt.eq(at))
                    .add(N::Id.lt(id)),
            ),
        );
    }
    let rows = select
        .order_by_desc(N::CreatedAt)
        .order_by_desc(N::Id)
        .limit(sql_limit(limit + 1.0).map(|n| u64::try_from(n).unwrap_or(0)))
        .all(&db)
        .await?;
    let total = notifications::Entity::find()
        .filter(live_of(&caller.user_id, is_read))
        .count(&db)
        .await?;

    let mut rows: Vec<Value> = rows.into_iter().map(row_json).collect();
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

    // The actor's name and picture, for notifications a member triggered:
    // the name from the member row, the picture from the account.
    let mut actor_ids: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(id) = user_actor(row)
            && !actor_ids.iter().any(|known| known == id)
        {
            actor_ids.push(id.to_owned());
        }
    }
    let mut names: HashMap<String, Value> = HashMap::new();
    if !actor_ids.is_empty() {
        let members: Vec<(String, Option<String>)> = workspace_members::Entity::find()
            .select_only()
            .columns([
                workspace_members::Column::UserId,
                workspace_members::Column::Name,
            ])
            .filter(workspace_members::Column::UserId.is_in(actor_ids.clone()))
            .into_tuple()
            .all(&db)
            .await?;
        // `new Map(entries)`: a later row for the same user wins.
        for (user_id, name) in members {
            names.insert(user_id, json!(name));
        }
    }
    let pictures = weldsuite_db::AccountPictures::load(caller.request_master(), &actor_ids).await;
    let data: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let actor = user_actor(&row);
            let name = actor
                .and_then(|id| names.get(id))
                .cloned()
                .unwrap_or(Value::Null);
            let picture = pictures.value(actor);
            if let Value::Object(fields) = &mut row {
                fields.insert("actorName".to_owned(), name);
                fields.insert("actorAvatar".to_owned(), picture);
            }
            row
        })
        .collect();
    Ok(List::new(data, Pagination::new(total, has_more, cursor)).into_response())
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
    let count: Result<u64, DbErr> = notifications::Entity::find()
        .filter(notifications::Column::UserId.eq(&caller.user_id))
        .filter(notifications::Column::IsRead.eq(false))
        .filter(notifications::Column::DeletedAt.is_null())
        .count(&orm(&caller.db))
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
    let updated = notifications::Entity::update_many()
        .col_expr(notifications::Column::IsRead, Expr::value(true))
        .col_expr(
            notifications::Column::ReadAt,
            Expr::value(utc_now().assume_utc()),
        )
        .filter(notifications::Column::UserId.eq(&caller.user_id))
        .filter(notifications::Column::IsRead.eq(false))
        .filter(notifications::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await;
    match updated {
        Ok(done) => Data(json!({ "updated": done.rows_affected })).into_response(),
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
            let row = notifications::Entity::update_many()
                .col_expr(notifications::Column::IsRead, Expr::value(true))
                .col_expr(
                    notifications::Column::ReadAt,
                    Expr::value(utc_now().assume_utc()),
                )
                .filter(notifications::Column::Id.eq(&id))
                .filter(notifications::Column::UserId.eq(&caller.user_id))
                .exec_with_returning(&orm(&caller.db))
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?
                .into_iter()
                .next();
            let row = row_json(
                row.ok_or_else(|| PlatformError::internal(FAILED, "row vanished"))?,
            );
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
            let inserted = notifications::Entity::insert(new_row(&values, &id))
                .on_conflict(
                    OnConflict::column(notifications::Column::Id)
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(&orm(&caller.db))
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            // A body `id` that is taken: the primary key refuses the row.
            if inserted == 0 {
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
            let mut update = notifications::Entity::update_many();
            for (column, value) in set_values::<notifications::Entity>(&COLUMNS, &values) {
                update = update.col_expr(column, value);
            }
            update
                .filter(notifications::Column::Id.eq(&id))
                .filter(notifications::Column::UserId.eq(&caller.user_id))
                .exec(&orm(&caller.db))
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
    )
}

/// The text a column takes from the body's values (`$1->>'column'`).
fn text_of(values: &Map<String, Value>, name: &str) -> Option<String> {
    values.get(name).and_then(Value::as_str).map(str::to_owned)
}

/// A boolean column's value (`($1->>'column')::boolean`, already read as
/// Postgres reads it), else its default.
fn flag_of(values: &Map<String, Value>, name: &str, default: bool) -> bool {
    values
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

/// The inserted row: `{ id, ...data, createdAt: now }`, the defaults where
/// the body leaves a column out (`coalesce($1->>'column', default)`).
fn new_row(values: &Map<String, Value>, id: &str) -> notifications::ActiveModel {
    let text = |name: &str| text_of(values, name);
    notifications::ActiveModel {
        id: Set(text("id").unwrap_or_else(|| id.to_owned())),
        user_id: Set(text("user_id").unwrap_or_default()),
        title: Set(text("title").unwrap_or_default()),
        body: Set(text("body")),
        category: Set(text("category").unwrap_or_else(|| "system".to_owned())),
        notification_type: Set(text("notification_type").unwrap_or_else(|| "custom".to_owned())),
        entity_type: Set(text("entity_type")),
        entity_id: Set(text("entity_id")),
        action_url: Set(text("action_url")),
        actor_type: Set(text("actor_type")),
        actor_id: Set(text("actor_id")),
        icon: Set(text("icon")),
        severity: Set(text("severity").unwrap_or_else(|| "info".to_owned())),
        // `nullif($1->'data', 'null'::jsonb)`.
        data: Set(values.get("data").filter(|data| !data.is_null()).cloned()),
        is_read: Set(flag_of(values, "is_read", false)),
        read_at: Set(None),
        delivered_in_app: Set(flag_of(values, "delivered_in_app", true)),
        delivered_email: Set(flag_of(values, "delivered_email", false)),
        delivered_push: Set(flag_of(values, "delivered_push", false)),
        created_at: Set(utc_now().assume_utc()),
        expires_at: Set(None),
        deleted_at: Set(None),
    }
}

/// `set <column> = …` for each of `columns` the body's values name (the
/// others keep their value), each value as `case when $1 ? 'column' …` read
/// it from the values: `$1->>'column'` for text and booleans,
/// `nullif($1->'column', 'null'::jsonb)` for `jsonb`, and `null` for a
/// timestamp (the only value [`column_values`] lets through for one).
pub(super) fn set_values<E: EntityTrait>(
    columns: &[Column],
    values: &Map<String, Value>,
) -> Vec<(E::Column, Expr)> {
    let mut set = Vec::new();
    for column in columns {
        let Some(value) = values.get(column.name) else {
            continue;
        };
        let Some(target) = E::Column::iter().find(|c| c.as_str() == column.name) else {
            continue;
        };
        let expr = match column.kind {
            Kind::Text(_) => Expr::value(value.as_str().map(str::to_owned)),
            Kind::Bool => Expr::value(value.as_bool()),
            Kind::Json => Expr::value((!value.is_null()).then(|| value.clone())),
            Kind::Timestamp => Expr::null(),
        };
        set.push((target, expr));
    }
    set
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
        let taken: Option<String> = notifications::Entity::find()
            .select_only()
            .column(notifications::Column::Id)
            .filter(notifications::Column::Id.eq(new_id))
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|error| PlatformError::internal(failed, error))?;
        if taken.is_some() {
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
            let removed = notifications::Entity::update_many()
                .col_expr(
                    notifications::Column::DeletedAt,
                    Expr::value(utc_now().assume_utc()),
                )
                .filter(notifications::Column::Id.eq(&id))
                .filter(notifications::Column::UserId.eq(&caller.user_id))
                .filter(notifications::Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await
                .map_err(|error| PlatformError::internal(FAILED, error))?;
            if removed.rows_affected == 0 {
                return Err(ApiError::not_found("Notification", Some(&id)).into());
            }
            Ok(NoContent.into_response())
        }
        .await,
    )
}
