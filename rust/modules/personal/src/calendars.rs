//! `/api/calendars` (`routes/calendars.ts`, `services/calendar-access.ts`):
//! a person's own calendars, owner-only (no shares in v1).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::DbErr;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm_error};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence};

use crate::PersonalState;
use crate::caller::{
    Caller, Failure, answer, created, data, list, no_content, plan_limit, rows, unhandled, validate,
};
use crate::js::now_iso;

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/calendars", get(list_calendars).post(create))
        .route("/api/calendars/ensure-default", post(ensure_default))
        .route(
            "/api/calendars/{id}",
            get(get_one).patch(update).delete(remove),
        )
}

/// A calendar as the routes answer it: the row, `isOwn` and `permission`.
fn annotated(mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        fields.insert("isOwn".to_owned(), Value::Bool(true));
        fields.insert("permission".to_owned(), json!("manage"));
    }
    row
}

/// `listCalendarsForAccount(db, personalAccountId)`: the default first, then
/// by name.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
pub(crate) async fn list_for_account(db: &PgPool, account: &str) -> Result<Vec<Value>, DbErr> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from personal_calendars c
         where c.personal_account_id = $1 and c.deleted_at is null
         order by c.is_default desc, c.name",
    )
    .bind(account)
    .fetch_all(db)
    .await
    .map_err(orm_error)?;
    Ok(rows(found))
}

/// `getCalendarForAccount(db, personalAccountId, calendarId)`.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
pub(crate) async fn get_for_account(
    db: &PgPool,
    account: &str,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from personal_calendars c
         where c.id = $1 and c.personal_account_id = $2 and c.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await
    .map_err(orm_error)?;
    Ok(found.map(weldsuite_db::js_row))
}

/// `resolveRequestedCalendarIds(db, personalAccountId, requested)`: the
/// account's calendars, narrowed to a comma-separated request.
pub(crate) async fn resolve_requested(
    db: &PgPool,
    account: &str,
    requested: Option<&str>,
) -> Result<Vec<String>, DbErr> {
    let accessible: Vec<String> = list_for_account(db, account)
        .await?
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let Some(requested) = requested.filter(|r| !r.is_empty()) else {
        return Ok(accessible);
    };
    Ok(requested
        .split(',')
        .map(crate::js::js_trim)
        .filter(|id| !id.is_empty() && accessible.iter().any(|a| a == id))
        .map(str::to_owned)
        .collect())
}

/// `GET /api/calendars`.
async fn list_calendars(caller: Caller) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let found: Vec<Value> = list_for_account(caller.personal()?, &account)
            .await?
            .into_iter()
            .map(annotated)
            .collect();
        let total = i64::try_from(found.len()).unwrap_or(0);
        Ok(list(found, total, false, None))
    }
    .await;
    answer(result, "Failed to list calendars")
}

/// `POST /api/calendars/ensure-default` (`ensureDefaultCalendar`).
async fn ensure_default(caller: Caller) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if let Some(existing) = default_calendar(db, &account).await? {
            return Ok(data(annotated(weldsuite_db::js_row(existing))));
        }
        let created_row = insert_default(db, &account, &caller.user_id).await?;
        Ok(created(annotated(weldsuite_db::js_row(created_row))))
    }
    .await;
    answer(result, "Failed to ensure default calendar")
}

/// The account's live default calendar, as `to_jsonb` writes it.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn default_calendar(db: &PgPool, account: &str) -> Result<Option<Value>, DbErr> {
    sqlx::query_scalar(
        "select to_jsonb(c) from personal_calendars c
         where c.personal_account_id = $1 and c.is_default = true and c.deleted_at is null
         limit 1",
    )
    .bind(account)
    .fetch_optional(db)
    .await
    .map_err(orm_error)
}

/// "My Calendar", the account's new default, as `to_jsonb` writes it.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn insert_default(db: &PgPool, account: &str, owner: &str) -> Result<Value, DbErr> {
    let now = now_iso();
    sqlx::query_scalar(
        "insert into personal_calendars
           (id, personal_account_id, name, color, owner_id, is_default, is_active, created_at, updated_at)
         values ($1, $2, 'My Calendar', '#3b82f6', $3, true, true, $4::timestamp, $4::timestamp)
         returning to_jsonb(personal_calendars)",
    )
    .bind(weldsuite_kit::generate_id("cal"))
    .bind(account)
    .bind(owner)
    .bind(&now)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// `createSchema` (or its `.partial()`): name, description, color.
struct Input {
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
}

fn read_input(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Input {
    let presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    Input {
        name: issues
            .text(body, "name", presence, Some(1), Some(255))
            .into_option(),
        description: issues
            .text(body, "description", Presence::Optional, None, Some(500))
            .into_option(),
        color: issues
            .text(body, "color", Presence::Optional, None, Some(20))
            .into_option(),
    }
}

/// `POST /api/calendars`, within the plan's calendar count.
async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_input(issues, b, false)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        let count = count_live(&db, &account).await?;
        let max = caller.entitlements.max_calendars();
        if count >= max {
            return Ok(plan_limit(
                "Calendar limit reached for your plan",
                json!({ "maxCalendars": max }),
            ));
        }
        let id = weldsuite_kit::generate_id("cal");
        insert_calendar(&db, &id, &account, &caller.user_id, &input).await?;
        Ok(created(json!({ "id": id })))
    }
    .await;
    answer(result, "Failed to create calendar")
}

/// The account's live calendars.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn count_live(db: &PgPool, account: &str) -> Result<i64, DbErr> {
    sqlx::query_scalar(
        "select count(*) from personal_calendars
         where personal_account_id = $1 and deleted_at is null",
    )
    .bind(account)
    .fetch_one(db)
    .await
    .map_err(orm_error)
}

/// A new calendar of the account, not the default.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn insert_calendar(
    db: &PgPool,
    id: &str,
    account: &str,
    owner: &str,
    input: &Input,
) -> Result<(), DbErr> {
    let now = now_iso();
    sqlx::query(
        "insert into personal_calendars
           (id, personal_account_id, name, description, color, owner_id, is_default, is_active,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, false, true, $7::timestamp, $7::timestamp)",
    )
    .bind(id)
    .bind(account)
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.color)
    .bind(owner)
    .bind(&now)
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

/// `GET /api/calendars/:id`.
async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        match get_for_account(caller.personal()?, &account, &id).await? {
            Some(row) => Ok(data(annotated(row))),
            None => Err(ApiError::not_found("Calendar", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch calendar")
}

/// `PATCH /api/calendars/:id`.
async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| read_input(issues, b, true)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        if get_for_account(db, &account, &id).await?.is_none() {
            return Err(Failure::from(ApiError::not_found("Calendar", Some(&id))));
        }
        update_calendar(db, &id, &account, &input).await?;
        Ok(data(json!({ "id": id })))
    }
    .await;
    answer(result, "Failed to update calendar")
}

/// The fields the body set, on the account's live calendar.
#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn update_calendar(db: &PgPool, id: &str, account: &str, input: &Input) -> Result<(), DbErr> {
    sqlx::query(
        "update personal_calendars set
           updated_at = $3::timestamp,
           name = case when $4 then $5 else name end,
           description = case when $6 then $7 else description end,
           color = case when $8 then $9 else color end
         where id = $1 and personal_account_id = $2 and deleted_at is null",
    )
    .bind(id)
    .bind(account)
    .bind(now_iso())
    .bind(input.name.is_some())
    .bind(&input.name)
    .bind(input.description.is_some())
    .bind(&input.description)
    .bind(input.color.is_some())
    .bind(&input.color)
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

/// `DELETE /api/calendars/:id`: soft delete; never the default calendar.
async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        let Some(existing) = get_for_account(db, &account, &id).await? else {
            return Err(ApiError::not_found("Calendar", Some(&id)).into());
        };
        if existing["isDefault"] == Value::Bool(true) {
            return Err(ApiError::bad_request("Cannot delete the default calendar").into());
        }
        soft_delete(db, &id, &account).await?;
        Ok(no_content())
    }
    .await;
    answer(result, "Failed to delete calendar")
}

#[allow(
    clippy::disallowed_methods,
    reason = "the personal database has no entities: its schema is still Drizzle's and retires with the consumer product (ADR OPS-025)"
)]
async fn soft_delete(db: &PgPool, id: &str, account: &str) -> Result<(), DbErr> {
    let now = now_iso();
    sqlx::query(
        "update personal_calendars set deleted_at = $3::timestamp, updated_at = $3::timestamp
         where id = $1 and personal_account_id = $2",
    )
    .bind(id)
    .bind(account)
    .bind(&now)
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}
