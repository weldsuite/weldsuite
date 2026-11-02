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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, now, validate};

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

fn row_of(row: Value) -> Value {
    js_row(row)
}

/// The caller's row with this id, if any.
async fn own(db: &PgPool, id: &str, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from notification_preferences t
         where id = $1 and user_id = $2 limit 1",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_of))
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

    // The cursor row (any user's, as the route reads it).
    let mut after: Option<(Value, String)> = None;
    if let Some(cursor) = &cursor {
        let found: Result<Option<(Value, String)>, sqlx::Error> = sqlx::query_as(
            "select to_jsonb(date_trunc('milliseconds', created_at)), id
             from notification_preferences where id = $1 limit 1",
        )
        .bind(cursor)
        .fetch_optional(&caller.db)
        .await;
        match found {
            Ok(found) => after = found,
            Err(error) => return TeamError::Database(error).respond(),
        }
    }
    answer(page(&caller, limit, cursor.is_some(), after).await)
}

async fn page(
    caller: &Caller,
    limit: Option<i64>,
    has_cursor: bool,
    after: Option<(Value, String)>,
) -> TeamResult<Response> {
    const FAILED: &str = "Failed to list notification preferences";
    // `limit(NaN)` or a negative limit fails in the database.
    let Some(limit) = limit.filter(|limit| limit + 1 >= 0) else {
        return Err(TeamError::internal(FAILED, "invalid limit"));
    };
    let (after_at, after_id) = match &after {
        Some((at, id)) => (at.as_str().map(str::to_owned), Some(id.clone())),
        None => (None, None),
    };
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from notification_preferences t
         where user_id = $1
           and ($2::timestamptz is null or created_at < $2::timestamptz
                or (created_at = $2::timestamptz and id < $3))
         order by created_at desc, id desc
         limit $4",
    )
    .bind(&caller.user_id)
    .bind(&after_at)
    .bind(&after_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await
    .map_err(|error| TeamError::internal(FAILED, error))?;
    // The count drops the cursor condition, which is the last one: with an
    // unknown cursor that is the user condition itself.
    let count_all = has_cursor && after.is_none();
    let total: i64 = sqlx::query_scalar(
        "select count(*) from notification_preferences where $2 or user_id = $1",
    )
    .bind(&caller.user_id)
    .bind(count_all)
    .fetch_one(&caller.db)
    .await
    .map_err(|error| TeamError::internal(FAILED, error))?;

    let mut rows: Vec<Value> = rows.into_iter().map(row_of).collect();
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
    Ok(List::new(
        rows,
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response())
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
            let row: Value = sqlx::query_scalar(
                "insert into notification_preferences as t
                     (id, user_id, do_not_disturb, sound_enabled, module_preferences,
                      default_in_app, default_email, default_push, default_desktop,
                      created_at, updated_at)
                 values ($1, $2, coalesce($3, false), coalesce($4, true),
                         coalesce($5, '{}'::jsonb), coalesce($6, true), coalesce($7, false),
                         coalesce($8, true), coalesce($9, true),
                         $10::timestamptz, $10::timestamptz)
                 on conflict (user_id) do update set
                     do_not_disturb = coalesce($3, t.do_not_disturb),
                     sound_enabled = coalesce($4, t.sound_enabled),
                     module_preferences = coalesce($5, t.module_preferences),
                     default_in_app = coalesce($6, t.default_in_app),
                     default_email = coalesce($7, t.default_email),
                     default_push = coalesce($8, t.default_push),
                     default_desktop = coalesce($9, t.default_desktop),
                     updated_at = $10::timestamptz
                 returning to_jsonb(t)",
            )
            .bind(generate_id("npr"))
            .bind(&caller.user_id)
            .bind(patch.do_not_disturb)
            .bind(patch.sound_enabled)
            .bind(&patch.module_preferences)
            .bind(patch.default_in_app)
            .bind(patch.default_email)
            .bind(patch.default_push)
            .bind(patch.default_desktop)
            .bind(now())
            .fetch_one(&caller.db)
            .await
            .map_err(|error| {
                TeamError::internal("Failed to update notification preferences", error)
            })?;
            Ok(Data(row_of(row)).into_response())
        }
        .await,
    )
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
            let row: Value = sqlx::query_scalar(
                "insert into notification_preferences as t
                     (id, user_id, module_preferences, created_at, updated_at)
                 values ($1, $2, $3, $4::timestamptz, $4::timestamptz)
                 on conflict (user_id) do update set
                     module_preferences = coalesce(t.module_preferences, '{}'::jsonb) || $3,
                     updated_at = $4::timestamptz
                 returning to_jsonb(t)",
            )
            .bind(generate_id("npr"))
            .bind(&caller.user_id)
            .bind(&patch)
            .bind(now())
            .fetch_one(&caller.db)
            .await
            .map_err(|error| TeamError::internal("Failed to update module preferences", error))?;
            Ok(Data(row_of(row)).into_response())
        }
        .await,
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let patch = validate(&headers, &body, read_patch)?;
            let id = generate_id("npr");
            // What it leaves out takes the column defaults.
            sqlx::query(
                "insert into notification_preferences
                     (id, user_id, do_not_disturb, sound_enabled, module_preferences,
                      default_in_app, default_email, default_push, default_desktop,
                      created_at, updated_at)
                 values ($1, $2, coalesce($3, false), coalesce($4, true), $5,
                         coalesce($6, true), coalesce($7, false), coalesce($8, true),
                         coalesce($9, true), $10::timestamptz, $10::timestamptz)",
            )
            .bind(&id)
            .bind(&caller.user_id)
            .bind(patch.do_not_disturb)
            .bind(patch.sound_enabled)
            .bind(&patch.module_preferences)
            .bind(patch.default_in_app)
            .bind(patch.default_email)
            .bind(patch.default_push)
            .bind(patch.default_desktop)
            .bind(now())
            .execute(&caller.db)
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
            sqlx::query(
                "update notification_preferences set
                     do_not_disturb = coalesce($3, do_not_disturb),
                     sound_enabled = coalesce($4, sound_enabled),
                     module_preferences = coalesce($5, module_preferences),
                     default_in_app = coalesce($6, default_in_app),
                     default_email = coalesce($7, default_email),
                     default_push = coalesce($8, default_push),
                     default_desktop = coalesce($9, default_desktop),
                     updated_at = $10::timestamptz
                 where id = $1 and user_id = $2",
            )
            .bind(&id)
            .bind(&caller.user_id)
            .bind(patch.do_not_disturb)
            .bind(patch.sound_enabled)
            .bind(&patch.module_preferences)
            .bind(patch.default_in_app)
            .bind(patch.default_email)
            .bind(patch.default_push)
            .bind(patch.default_desktop)
            .bind(now())
            .execute(&caller.db)
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
            sqlx::query("delete from notification_preferences where id = $1 and user_id = $2")
                .bind(&id)
                .bind(&caller.user_id)
                .execute(&caller.db)
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
