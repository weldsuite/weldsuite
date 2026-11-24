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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::user_preferences as prefs;

use crate::access::js;
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

/// The caller's live row.
async fn own_row(db: &PgPool, user_id: &str) -> Result<Option<prefs::Model>, DbErr> {
    prefs::Entity::find()
        .filter(prefs::Column::UserId.eq(user_id))
        .filter(prefs::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// The row `id` as Drizzle returns it; null without one.
async fn row_by_id(db: &PgPool, id: &str) -> Result<Value, DbErr> {
    let row = prefs::Entity::find_by_id(id).one(&orm(db)).await?;
    row.map_or(Ok(Value::Null), js)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn preferences(caller: Caller) -> Response {
    let row = own_row(&caller.db, &caller.user_id)
        .await
        .and_then(|row| row.map_or(Ok(Value::Null), js));
    match row {
        Ok(row) => Data(to_response(&row)).into_response(),
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

impl Changes {
    /// `fontSize` as the column holds it.
    fn font_size(&self) -> Option<i32> {
        self.font_size.and_then(|n| i32::try_from(n).ok())
    }

    /// `buildPreferencesUpdate`: the columns of the fields sent, with
    /// `uiPreferences` merged into the stored JSON (`existing`).
    fn sent(&self, existing: Option<&Value>) -> Vec<(prefs::Column, Expr)> {
        let mut sent = Vec::new();
        let texts = [
            (prefs::Column::Theme, &self.theme),
            (prefs::Column::Language, &self.language),
            (prefs::Column::DateFormat, &self.date_format),
            (prefs::Column::TimeFormat, &self.time_format),
            (prefs::Column::Timezone, &self.timezone),
        ];
        for (column, value) in texts {
            if let Some(value) = value {
                sent.push((column, Expr::value(value.clone())));
            }
        }
        if let Some(size) = self.font_size() {
            sent.push((prefs::Column::FontSize, Expr::value(size)));
        }
        if let Some(notifications) = &self.notifications {
            sent.push((
                prefs::Column::Notifications,
                Expr::value(notifications.clone()),
            ));
        }
        // Merge: keeps homeWidgets, profile, sidebarAppOrder and the rest.
        if let Some(patch) = &self.ui_preferences {
            let mut merged = match existing {
                Some(Value::Object(map)) => map.clone(),
                _ => Map::new(),
            };
            merged.extend(patch.clone());
            sent.push((
                prefs::Column::UiPreferences,
                Expr::value(Value::Object(merged)),
            ));
        }
        if let Some(hours) = &self.working_hours {
            sent.push((prefs::Column::WorkingHours, Expr::value(hours.clone())));
        }
        sent
    }

    /// The new row: the fields sent, else the defaults.
    fn new_row(&self, id: String, user_id: &str) -> prefs::ActiveModel {
        let stamp = utc_now().assume_utc();
        let text = |value: &Option<String>, default: &str| {
            Set(value.clone().unwrap_or_else(|| default.to_owned()))
        };
        prefs::ActiveModel {
            id: Set(id),
            user_id: Set(user_id.to_owned()),
            theme: text(&self.theme, "system"),
            font_size: Set(self.font_size().unwrap_or(16)),
            language: text(&self.language, "en"),
            date_format: text(&self.date_format, "MM/DD/YYYY"),
            time_format: text(&self.time_format, "12h"),
            timezone: text(&self.timezone, "UTC"),
            notifications: Set(Some(
                self.notifications.clone().unwrap_or_else(|| json!({})),
            )),
            ui_preferences: Set(Some(
                self.ui_preferences
                    .clone()
                    .map_or_else(|| json!({}), Value::Object),
            )),
            working_hours: Set(self.working_hours.clone()),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        }
    }
}

async fn save(db: &PgPool, user_id: &str, changes: &Changes) -> Result<Response, DbErr> {
    if let Some(existing) = own_row(db, user_id).await? {
        let mut update = prefs::Entity::update_many().col_expr(
            prefs::Column::UpdatedAt,
            Expr::value(utc_now().assume_utc()),
        );
        for (column, value) in changes.sent(existing.ui_preferences.as_ref()) {
            update = update.col_expr(column, value);
        }
        update
            .filter(prefs::Column::Id.eq(&existing.id))
            .exec(&orm(db))
            .await?;
        clear_auto_scheduled(db, user_id, changes.ui_preferences.as_ref()).await?;
        let updated = row_by_id(db, &existing.id).await?;
        return Ok(Data(to_response(&updated)).into_response());
    }

    let id = generate_id("upref");
    prefs::Entity::insert(changes.new_row(id.clone(), user_id))
        .exec_without_returning(&orm(db))
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
) -> Result<(), DbErr> {
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
#[allow(
    clippy::disallowed_methods,
    reason = "two data-modifying CTEs: the soft-delete and the unlink stay one atomic statement, as removeAutoScheduledTaskEvents runs them"
)]
async fn remove_auto_scheduled_task_events(
    db: &PgPool,
    user_id: &str,
    app: Option<&str>,
) -> Result<(), DbErr> {
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
    .await
    .map_err(weldsuite_db::orm_error)?;
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
async fn set_one(db: &PgPool, user_id: &str, column: &str, value: Value) -> Result<(), DbErr> {
    let stamp = utc_now().assume_utc();
    let theme = (column == "theme").then(|| value.as_str().unwrap_or_default().to_owned());
    let size = (column == "font_size")
        .then(|| value.as_i64().and_then(|n| i32::try_from(n).ok()))
        .flatten();
    let db = orm(db);
    let existing: Option<String> = prefs::Entity::find()
        .select_only()
        .column(prefs::Column::Id)
        .filter(prefs::Column::UserId.eq(user_id))
        .filter(prefs::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = existing {
        let mut update =
            prefs::Entity::update_many().col_expr(prefs::Column::UpdatedAt, Expr::value(stamp));
        if let Some(theme) = theme {
            update = update.col_expr(prefs::Column::Theme, Expr::value(theme));
        }
        if let Some(size) = size {
            update = update.col_expr(prefs::Column::FontSize, Expr::value(size));
        }
        update.filter(prefs::Column::Id.eq(id)).exec(&db).await?;
    } else {
        let row = prefs::ActiveModel {
            id: Set(generate_id("upref")),
            user_id: Set(user_id.to_owned()),
            theme: Set(theme.unwrap_or_else(|| "system".to_owned())),
            font_size: Set(size.unwrap_or(16)),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        };
        prefs::Entity::insert(row)
            .exec_without_returning(&db)
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
