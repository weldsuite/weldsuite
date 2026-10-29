//! `/api/user-preferences` (`app-api/src/routes/user-preferences`): the
//! caller's own preferences, one `user_preferences` row per user. No
//! permission: every signed-in member manages their own.
//!
//! - `GET /`: the preferences, or the defaults without a row.
//! - `PUT /`: upsert (201 when it creates the row). `uiPreferences` merges
//!   into the stored JSON. Turning an app's task auto-scheduling off
//!   (`autoScheduleFlowTasks`, `autoScheduleCrmTasks`, or the legacy
//!   `autoScheduleTasks` for both) clears the task events it placed
//!   (`removeAutoScheduledTaskEvents`).
//! - `PATCH /theme`, `PATCH /font-size`: one field.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CoreTeamState, TeamError, answer, now, validate};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(preferences).put(update))
        .route("/theme", patch(theme))
        .route("/font-size", patch(font_size))
}

const THEMES: [&str; 3] = ["light", "dark", "system"];
const FONT_SIZE: Number = Number {
    coerce: false,
    int: true,
    min: Some(12.0),
    max: Some(20.0),
};

/// `a || b`: JavaScript's falsy values fall through.
fn or(a: &Value, b: Value) -> Value {
    let falsy = match a {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(n) => n.as_f64().is_none_or(|n| n == 0.0 || n.is_nan()),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    if falsy { b } else { a.clone() }
}

/// `toResponse`: the row with the defaults filled in.
fn to_response(row: &Value) -> Value {
    json!({
        "theme": or(&row["theme"], json!("system")),
        "fontSize": if row["fontSize"].is_null() { json!(16) } else { row["fontSize"].clone() },
        "language": or(&row["language"], json!("en")),
        "dateFormat": or(&row["dateFormat"], json!("MM/DD/YYYY")),
        "timeFormat": or(&row["timeFormat"], json!("12h")),
        "timezone": or(&row["timezone"], json!("UTC")),
        "notifications": or(&row["notifications"], json!({})),
        "uiPreferences": or(&row["uiPreferences"], json!({})),
        "workingHours": row["workingHours"].clone(),
    })
}

async fn own_row(db: &PgPool, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from user_preferences p
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn row_by_id(db: &PgPool, id: &str) -> Result<Value, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(p) from user_preferences p where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map_or(Value::Null, js_row))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn preferences(caller: Caller) -> Response {
    match own_row(&caller.db, &caller.user_id).await {
        Ok(row) => Data(to_response(&row.unwrap_or(Value::Null))).into_response(),
        Err(error) => TeamError::internal("Failed to fetch user preferences", error).respond(),
    }
}

// ── PUT / ───────────────────────────────────────────────────────────────────

/// The validated `updatePreferencesSchema`; `None` = not sent.
#[derive(Default)]
struct Changes {
    theme: Option<String>,
    font_size: Option<i64>,
    language: Option<String>,
    date_format: Option<String>,
    time_format: Option<String>,
    timezone: Option<String>,
    notifications: Option<Value>,
    ui_preferences: Option<Map<String, Value>>,
    working_hours: Option<Value>,
}

/// `z.record(z.string(), z.any()).optional()`.
fn record(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<Map<String, Value>> {
    issues
        .nested(body, key, Presence::Optional, |_, fields| fields.clone())
        .into_option()
}

fn read_changes(issues: &mut Issues, body: &Map<String, Value>) -> Changes {
    Changes {
        theme: issues
            .choice(body, "theme", Presence::Optional, &THEMES)
            .into_option(),
        font_size: issues
            .whole_number(body, "fontSize", Presence::Optional, FONT_SIZE)
            .into_option(),
        language: issues.string(body, "language", false, None, None),
        date_format: issues.string(body, "dateFormat", false, None, None),
        time_format: issues.string(body, "timeFormat", false, None, None),
        timezone: issues.string(body, "timezone", false, None, None),
        notifications: issues
            .nested(
                body,
                "notifications",
                Presence::Optional,
                |issues, fields| {
                    // Zod's object keeps only its own keys.
                    let mut out = Map::new();
                    for key in ["email", "push", "desktop", "sound"] {
                        if let Field::Set(flag) = issues.boolean(fields, key, Presence::Optional) {
                            out.insert(key.to_owned(), json!(flag));
                        }
                    }
                    Value::Object(out)
                },
            )
            .into_option(),
        ui_preferences: record(issues, body, "uiPreferences"),
        working_hours: record(issues, body, "workingHours").map(Value::Object),
    }
}

async fn update(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let changes = validate(&headers, &body, read_changes)?;
            save(&caller.db, &caller.user_id, &changes)
                .await
                .map_err(|error| TeamError::internal("Failed to update user preferences", error))
        }
        .await,
    )
}

async fn save(db: &PgPool, user_id: &str, changes: &Changes) -> Result<Response, sqlx::Error> {
    let stamp = now();
    if let Some(existing) = own_row(db, user_id).await? {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        // Merge: keeps homeWidgets, profile, sidebarAppOrder and the rest.
        let ui = changes.ui_preferences.as_ref().map(|patch| {
            let mut merged = match &existing["uiPreferences"] {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            merged.extend(patch.clone());
            Value::Object(merged)
        });
        sqlx::query(
            "update user_preferences set
                 theme = coalesce($2, theme),
                 font_size = coalesce($3, font_size),
                 language = coalesce($4, language),
                 date_format = coalesce($5, date_format),
                 time_format = coalesce($6, time_format),
                 timezone = coalesce($7, timezone),
                 notifications = case when $8 then $9 else notifications end,
                 ui_preferences = case when $10 then $11 else ui_preferences end,
                 working_hours = case when $12 then $13 else working_hours end,
                 updated_at = $14::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(&changes.theme)
        .bind(changes.font_size.and_then(|n| i32::try_from(n).ok()))
        .bind(&changes.language)
        .bind(&changes.date_format)
        .bind(&changes.time_format)
        .bind(&changes.timezone)
        .bind(changes.notifications.is_some())
        .bind(&changes.notifications)
        .bind(ui.is_some())
        .bind(&ui)
        .bind(changes.working_hours.is_some())
        .bind(&changes.working_hours)
        .bind(&stamp)
        .execute(db)
        .await?;
        clear_auto_scheduled(db, user_id, changes.ui_preferences.as_ref()).await?;
        let updated = row_by_id(db, &id).await?;
        return Ok(Data(to_response(&updated)).into_response());
    }

    let id = generate_id("upref");
    sqlx::query(
        "insert into user_preferences
             (id, user_id, theme, font_size, language, date_format, time_format, timezone,
              notifications, ui_preferences, working_hours, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $12::timestamptz)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(changes.theme.as_deref().unwrap_or("system"))
    .bind(
        changes
            .font_size
            .and_then(|n| i32::try_from(n).ok())
            .unwrap_or(16),
    )
    .bind(changes.language.as_deref().unwrap_or("en"))
    .bind(changes.date_format.as_deref().unwrap_or("MM/DD/YYYY"))
    .bind(changes.time_format.as_deref().unwrap_or("12h"))
    .bind(changes.timezone.as_deref().unwrap_or("UTC"))
    .bind(changes.notifications.clone().unwrap_or_else(|| json!({})))
    .bind(
        changes
            .ui_preferences
            .clone()
            .map_or_else(|| json!({}), Value::Object),
    )
    .bind(&changes.working_hours)
    .bind(&stamp)
    .execute(db)
    .await?;
    clear_auto_scheduled(db, user_id, changes.ui_preferences.as_ref()).await?;
    let created = row_by_id(db, &id).await?;
    Ok(Created(to_response(&created)).into_response())
}

/// Turning an app's auto-scheduling off clears the task events it placed.
async fn clear_auto_scheduled(
    db: &PgPool,
    user_id: &str,
    ui: Option<&Map<String, Value>>,
) -> Result<(), sqlx::Error> {
    let off = |key: &str| ui.and_then(|ui| ui.get(key)) == Some(&Value::Bool(false));
    if off("autoScheduleTasks") {
        return remove_auto_scheduled_task_events(db, user_id, None).await;
    }
    for (app, key) in [
        ("flow", "autoScheduleFlowTasks"),
        ("crm", "autoScheduleCrmTasks"),
    ] {
        if off(key) {
            remove_auto_scheduled_task_events(db, user_id, Some(app)).await?;
        }
    }
    Ok(())
}

/// `removeAutoScheduledTaskEvents` (`@weldsuite/db/lib/calendar-sync`):
/// soft-delete the user's auto-placed task events (of one app's tasks, when
/// given) and unlink them from their tasks, in one statement.
async fn remove_auto_scheduled_task_events(
    db: &PgPool,
    user_id: &str,
    app: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "with removed as (
             update calendar_events
             set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where organizer_id = $1
               and source_type = 'task'
               and auto_scheduled = true
               and deleted_at is null
               and ($3::text is null or ($3 = 'crm') = exists (
                   select 1 from tasks
                   where tasks.id = calendar_events.source_id
                     and (tasks.customer_id is not null or tasks.contact_id is not null
                          or tasks.counterparty_id is not null or tasks.person_id is not null)))
             returning id
         ), unlinked as (
             update tasks set calendar_event_id = null
             where calendar_event_id in (select id from removed)
         )
         select count(*)::int as removed from removed",
    )
    .bind(user_id)
    .bind(now())
    .bind(app)
    .execute(db)
    .await?;
    Ok(())
}

// ── PATCH /theme, PATCH /font-size ──────────────────────────────────────────

async fn theme(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let theme = validate(&headers, &body, |issues, fields| {
                issues.one_of(fields, "theme", &THEMES).unwrap_or_default()
            })?;
            set_one(&caller.db, &caller.user_id, "theme", json!(theme))
                .await
                .map_err(|error| TeamError::internal("Failed to update theme", error))?;
            Ok(Data(json!({ "theme": theme })).into_response())
        }
        .await,
    )
}

async fn font_size(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let size = validate(&headers, &body, |issues, fields| {
                issues
                    .whole_number(fields, "fontSize", Presence::Required, FONT_SIZE)
                    .into_option()
                    .unwrap_or_default()
            })?;
            set_one(&caller.db, &caller.user_id, "font_size", json!(size))
                .await
                .map_err(|error| TeamError::internal("Failed to update font size", error))?;
            Ok(Data(json!({ "fontSize": size })).into_response())
        }
        .await,
    )
}

/// Set `theme` or `font_size` on the caller's row, creating it with the
/// column defaults otherwise.
async fn set_one(
    db: &PgPool,
    user_id: &str,
    column: &str,
    value: Value,
) -> Result<(), sqlx::Error> {
    let stamp = now();
    let theme = (column == "theme").then(|| value.as_str().unwrap_or_default().to_owned());
    let size = (column == "font_size")
        .then(|| value.as_i64().and_then(|n| i32::try_from(n).ok()))
        .flatten();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from user_preferences where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        sqlx::query(
            "update user_preferences
             set theme = coalesce($2, theme), font_size = coalesce($3, font_size),
                 updated_at = $4::timestamptz
             where id = $1",
        )
        .bind(id)
        .bind(theme)
        .bind(size)
        .bind(&stamp)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "insert into user_preferences (id, user_id, theme, font_size, created_at, updated_at)
             values ($1, $2, coalesce($3, 'system'), coalesce($4, 16),
                     $5::timestamptz, $5::timestamptz)",
        )
        .bind(generate_id("upref"))
        .bind(user_id)
        .bind(theme)
        .bind(size)
        .bind(&stamp)
        .execute(db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_take_the_defaults() {
        let response = to_response(&Value::Null);
        assert_eq!(response["theme"], "system");
        assert_eq!(response["fontSize"], 16);
        assert_eq!(response["notifications"], json!({}));
        assert_eq!(response["workingHours"], Value::Null);
    }
}
