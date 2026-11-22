//! `/api/notification-preferences` (`app-api/src/routes/notification-preferences`,
//! `services/notification-preferences.ts`): the caller's notification
//! settings, one row per user (`user_id` is unique). Every route is scoped to
//! the caller; another user's row is a 404.
//!
//! - `GET /` (cursor list), `GET /:id`: `general:read`.
//! - `PUT /`: upsert, the settings page's write (`general:read`). A first
//!   write gets the defaults for what it leaves out; later writes touch only
//!   what they send.
//! - `PUT /module/:module`: merge one module's channels into
//!   `module_preferences`, server side (`general:read`).
//! - `POST /`, `PATCH /:id`, `DELETE /:id`: the per-row shell
//!   (`general:create`, `general:update`, `general:delete`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Issues, Presence, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::notification_preferences as prefs;

use crate::access::js;
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, validate};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need(GENERAL_READ)))
        .route("/", put(upsert).route_layer(need(GENERAL_READ)))
        .route("/", post(create).route_layer(need(GENERAL_CREATE)))
        .route(
            "/module/{module}",
            put(merge_module).route_layer(need(GENERAL_READ)),
        )
        .route("/{id}", get(detail).route_layer(need(GENERAL_READ)))
        .route("/{id}", patch(update).route_layer(need(GENERAL_UPDATE)))
        .route("/{id}", delete(remove).route_layer(need(GENERAL_DELETE)))
}

/// Not catalog keys (no role holds them but the owner's `*`); the routes
/// require them as written.
const GENERAL_CREATE: &str = "general:create";
const GENERAL_DELETE: &str = "general:delete";

const CHANNELS: [&str; 5] = ["enabled", "inApp", "email", "push", "desktop"];

/// `moduleChannelPreferencesSchema`: all five flags, required.
fn read_channels(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for key in CHANNELS {
        if let Field::Set(flag) = issues.boolean(fields, key, Presence::Required) {
            out.insert(key.to_owned(), json!(flag));
        }
    }
    Value::Object(out)
}

/// The validated `upsertNotificationPreferencesSchema`: only what was sent.
#[derive(Default)]
struct Patch {
    do_not_disturb: Option<bool>,
    sound_enabled: Option<bool>,
    module_preferences: Option<Value>,
    default_in_app: Option<bool>,
    default_email: Option<bool>,
    default_push: Option<bool>,
    default_desktop: Option<bool>,
}

fn read_patch(issues: &mut Issues, body: &Map<String, Value>) -> Patch {
    let flag = |issues: &mut Issues, key: &str| {
        issues.boolean(body, key, Presence::Optional).into_option()
    };
    let do_not_disturb = flag(issues, "doNotDisturb");
    let sound_enabled = flag(issues, "soundEnabled");
    let module_preferences = issues
        .nested(
            body,
            "modulePreferences",
            Presence::Optional,
            |issues, modules| {
                let mut out = Map::new();
                for name in modules.keys() {
                    if let Field::Set(channels) =
                        issues.nested(modules, name, Presence::Required, read_channels)
                    {
                        out.insert(name.clone(), channels);
                    }
                }
                Value::Object(out)
            },
        )
        .into_option();
    Patch {
        do_not_disturb,
        sound_enabled,
        module_preferences,
        default_in_app: flag(issues, "defaultInApp"),
        default_email: flag(issues, "defaultEmail"),
        default_push: flag(issues, "defaultPush"),
        default_desktop: flag(issues, "defaultDesktop"),
    }
}

impl Patch {
    /// `coalesce($sent, column)` for each field: the sent ones as
    /// `(column, value)`, in the schema's order.
    fn sent(&self) -> Vec<(prefs::Column, sea_orm::Value)> {
        let flags = [
            (prefs::Column::DoNotDisturb, self.do_not_disturb),
            (prefs::Column::SoundEnabled, self.sound_enabled),
        ];
        let defaults = [
            (prefs::Column::DefaultInApp, self.default_in_app),
            (prefs::Column::DefaultEmail, self.default_email),
            (prefs::Column::DefaultPush, self.default_push),
            (prefs::Column::DefaultDesktop, self.default_desktop),
        ];
        let flag = |(column, value): (prefs::Column, Option<bool>)| {
            value.map(|value| (column, sea_orm::Value::from(value)))
        };
        let modules = self
            .module_preferences
            .clone()
            .map(|value| (prefs::Column::ModulePreferences, sea_orm::Value::from(value)));
        flags
            .into_iter()
            .filter_map(flag)
            .chain(modules)
            .chain(defaults.into_iter().filter_map(flag))
            .collect()
    }
}

/// The caller's row with this id, if any.
async fn own(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, DbErr> {
    prefs::Entity::find()
        .filter(prefs::Column::Id.eq(id))
        .filter(prefs::Column::UserId.eq(user_id))
        .one(&orm(db))
        .await?
        .map(js)
        .transpose()
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then digits;
/// `None` (NaN) without any.
fn parse_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

fn first(query: &Map<String, Value>, key: &str) -> Option<String> {
    match query.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
    .filter(|text| !text.is_empty())
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query_values(query.as_deref());
    let limit = first(&query, "limit").map_or(Some(25), |text| parse_int(&text));
    let limit = limit.map(|limit| limit.min(100));
    let cursor = first(&query, "cursor");

    // The cursor row (any user's, as the route reads it), its `createdAt`
    // to the millisecond as the route's `Date` holds it.
    let mut after: Option<(OffsetDateTime, String)> = None;
    if let Some(cursor) = &cursor {
        let found: Result<Option<(OffsetDateTime, String)>, DbErr> = prefs::Entity::find()
            .select_only()
            .columns([prefs::Column::CreatedAt, prefs::Column::Id])
            .filter(prefs::Column::Id.eq(cursor))
            .into_tuple()
            .one(&orm(&caller.db))
            .await;
        match found {
            Ok(found) => after = found.map(|(at, id)| (utc_timestamp(at).assume_utc(), id)),
            Err(error) => return TeamError::Database(error).respond(),
        }
    }
    answer(page(&caller, limit, cursor.is_some(), after).await)
}

async fn page(
    caller: &Caller,
    limit: Option<i64>,
    has_cursor: bool,
    after: Option<(OffsetDateTime, String)>,
) -> TeamResult<Response> {
    const FAILED: &str = "Failed to list notification preferences";
    // `limit(NaN)` or a negative limit fails in the database.
    let Some(limit) = limit.filter(|limit| limit + 1 >= 0) else {
        return Err(TeamError::internal(FAILED, "invalid limit"));
    };
    let db = orm(&caller.db);
    // The count drops the cursor condition, which is the last one: with an
    // unknown cursor that is the user condition itself.
    let count_all = has_cursor && after.is_none();
    let mut select = prefs::Entity::find().filter(prefs::Column::UserId.eq(&caller.user_id));
    if let Some((at, id)) = after {
        select = select.filter(
            Condition::any()
                .add(prefs::Column::CreatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(prefs::Column::CreatedAt.eq(at))
                        .add(prefs::Column::Id.lt(id)),
                ),
        );
    }
    let rows = select
        .order_by_desc(prefs::Column::CreatedAt)
        .order_by_desc(prefs::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await
        .map_err(|error| TeamError::internal(FAILED, error))?;
    let mut count = prefs::Entity::find();
    if !count_all {
        count = count.filter(prefs::Column::UserId.eq(&caller.user_id));
    }
    let total = count
        .count(&db)
        .await
        .map_err(|error| TeamError::internal(FAILED, error))?;

    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(js)
        .collect::<Result<_, _>>()
        .map_err(|error| TeamError::internal(FAILED, error))?;
    let keep = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > keep;
    rows.truncate(keep);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    Ok(List::new(rows, Pagination::new(total, has_more, cursor)).into_response())
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match own(&caller.db, &id, &caller.user_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Notification preference", Some(&id)).into_response(),
        Err(error) => {
            TeamError::internal("Failed to fetch notification preference", error).respond()
        }
    }
}

// ── PUT / ───────────────────────────────────────────────────────────────────

async fn upsert(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let patch = validate(&headers, &body, read_patch)?;
            let row = upsert_row(&caller, patch).await.map_err(|error| {
                TeamError::internal("Failed to update notification preferences", error)
            })?;
            Ok(Data(row).into_response())
        }
        .await,
    )
}

/// The row with the defaults for what a first write leaves out
/// (`coalesce($sent, default)`), the columns' own defaults otherwise.
fn new_row(caller: &Caller, id: String, patch: &Patch, at: OffsetDateTime) -> prefs::ActiveModel {
    prefs::ActiveModel {
        id: Set(id),
        user_id: Set(caller.user_id.clone()),
        do_not_disturb: Set(patch.do_not_disturb.unwrap_or(false)),
        sound_enabled: Set(patch.sound_enabled.unwrap_or(true)),
        default_in_app: Set(patch.default_in_app.unwrap_or(true)),
        default_email: Set(patch.default_email.unwrap_or(false)),
        default_push: Set(patch.default_push.unwrap_or(true)),
        default_desktop: Set(patch.default_desktop.unwrap_or(true)),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    }
}

/// Insert the caller's row, or (`on conflict (user_id)`) write only what the
/// patch sent over the existing one.
async fn upsert_row(caller: &Caller, patch: Patch) -> Result<Value, DbErr> {
    let mut row = new_row(caller, generate_id("npr"), &patch, utc_now().assume_utc());
    row.module_preferences = Set(Some(
        patch.module_preferences.clone().unwrap_or_else(|| json!({})),
    ));
    let mut written: Vec<prefs::Column> = patch.sent().into_iter().map(|(c, _)| c).collect();
    written.push(prefs::Column::UpdatedAt);
    let row = prefs::Entity::insert(row)
        .on_conflict(
            OnConflict::column(prefs::Column::UserId)
                .update_columns(written)
                .to_owned(),
        )
        .exec_with_returning(&orm(&caller.db))
        .await?;
    js(row)
}

// ── PUT /module/:module ─────────────────────────────────────────────────────

/// `moduleNameSchema`: `/^[a-z0-9][a-z0-9_-]{0,49}$/i`.
fn is_module_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 50
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

async fn merge_module(
    caller: Caller,
    Path(module): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let channels = validate(&headers, &body, read_channels)?;
            if !is_module_name(&module) {
                return Err(TeamError::api(ApiError::bad_request("Invalid module name")));
            }
            let patch = json!({ module: channels });
            let row = merge_row(&caller, patch)
                .await
                .map_err(|error| TeamError::internal("Failed to update module preferences", error))?;
            Ok(Data(row).into_response())
        }
        .await,
    )
}

/// Insert the caller's row with this module's channels, or merge them into
/// the existing `module_preferences` (`coalesce(…, '{}') || $patch`).
async fn merge_row(caller: &Caller, patch: Value) -> Result<Value, DbErr> {
    let at = utc_now().assume_utc();
    let current = Expr::col((prefs::Entity, prefs::Column::ModulePreferences));
    let merged = sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::from(Func::coalesce([current, Expr::value(json!({}))])),
        Expr::value(patch.clone()),
    );
    let row = prefs::Entity::insert(prefs::ActiveModel {
        id: Set(generate_id("npr")),
        user_id: Set(caller.user_id.clone()),
        module_preferences: Set(Some(patch)),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(prefs::Column::UserId)
            .value(prefs::Column::ModulePreferences, merged)
            .update_column(prefs::Column::UpdatedAt)
            .to_owned(),
    )
    .exec_with_returning(&orm(&caller.db))
    .await?;
    js(row)
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let patch = validate(&headers, &body, read_patch)?;
            // What it leaves out takes the column defaults.
            let id = generate_id("npr");
            let mut row = new_row(&caller, id.clone(), &patch, utc_now().assume_utc());
            row.module_preferences = Set(patch.module_preferences);
            prefs::Entity::insert(row)
                .exec_without_returning(&orm(&caller.db))
                .await
                .map_err(|error| {
                    TeamError::internal("Failed to create notification preference", error)
                })?;
            Ok(Created(json!({ "id": id })).into_response())
        }
        .await,
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to update notification preference";
            let patch = validate(&headers, &body, read_patch)?;
            let existing = own(&caller.db, &id, &caller.user_id)
                .await
                .map_err(|error| TeamError::internal(FAILED, error))?;
            if existing.is_none() {
                return Err(ApiError::not_found("Notification preference", Some(&id)).into());
            }
            let mut write = prefs::Entity::update_many();
            for (column, value) in patch.sent() {
                write = write.col_expr(column, Expr::value(value));
            }
            write
                .col_expr(
                    prefs::Column::UpdatedAt,
                    Expr::value(utc_now().assume_utc()),
                )
                .filter(prefs::Column::Id.eq(&id))
                .filter(prefs::Column::UserId.eq(&caller.user_id))
                .exec(&orm(&caller.db))
                .await
                .map_err(|error| TeamError::internal(FAILED, error))?;
            Ok(Data(json!({ "id": id })).into_response())
        }
        .await,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to delete notification preference";
            let existing = own(&caller.db, &id, &caller.user_id)
                .await
                .map_err(|error| TeamError::internal(FAILED, error))?;
            if existing.is_none() {
                return Err(ApiError::not_found("Notification preference", Some(&id)).into());
            }
            prefs::Entity::delete_many()
                .filter(prefs::Column::Id.eq(&id))
                .filter(prefs::Column::UserId.eq(&caller.user_id))
                .exec(&orm(&caller.db))
                .await
                .map_err(|error| TeamError::internal(FAILED, error))?;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_reads_like_javascript() {
        assert_eq!(parse_int("10"), Some(10));
        assert_eq!(parse_int(" 7abc"), Some(7));
        assert_eq!(parse_int("-3"), Some(-3));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int(""), None);
    }

    #[test]
    fn module_names_are_slugs() {
        assert!(is_module_name("crm"));
        assert!(is_module_name("Weld_chat-2"));
        assert!(!is_module_name("_crm"));
        assert!(!is_module_name("bad name"));
        assert!(!is_module_name(&"a".repeat(51)));
    }
}
