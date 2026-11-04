//! `/api/bookings` (`routes/bookings.ts`): the owner's view of the bookings
//! made on their pages (list, get, cancel, delete). Guests book through the
//! booking portal.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::Response;
use axum::routing::{get, patch};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::Presence;

use crate::PersonalState;
use crate::booking_pages::{cursor_of, parse_limit};
use crate::caller::{
    Caller, Failure, answer, data, no_content, query_map, rows, unhandled, validate,
};
use crate::events::page;
use crate::js::now_iso;

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/bookings", get(list_bookings))
        .route("/api/bookings/{id}", get(get_one).delete(remove))
        .route("/api/bookings/{id}/cancel", patch(cancel))
}

async fn find(db: &PgPool, account: &str, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from personal_calendar_bookings t
         where t.id = $1 and t.personal_account_id = $2 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(db)
    .await?;
    Ok(found.map(weldsuite_db::js_row))
}

/// `GET /api/bookings?bookingPageId=&status=&cursor=&limit=`.
async fn list_bookings(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let q = query_map(raw.as_deref());
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    // The cursor lookup runs before the route's try/catch.
    let cursor = match cursor_of(
        &db,
        "select to_jsonb(t.created_at), t.id from personal_calendar_bookings t where t.id = $1 limit 1",
        q.get("cursor"),
    )
    .await
    {
        Ok(cursor) => cursor,
        Err(error) => return unhandled(Err(error.into())),
    };
    let result = async {
        let limit = parse_limit(q.get("limit"))?;
        let filter = |key: &str| q.get(key).filter(|v| !v.is_empty()).cloned();
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from personal_calendar_bookings t
             where t.deleted_at is null and t.personal_account_id = $1
               and ($2::text is null or t.booking_page_id = $2)
               and ($3::text is null or t.status = $3)
               and ($4::timestamp is null
                    or (t.created_at < $4::timestamp or (t.created_at = $4::timestamp and t.id < $5)))
             order by t.created_at desc, t.id desc
             limit $6",
        )
        .bind(&account)
        .bind(filter("bookingPageId"))
        .bind(filter("status"))
        .bind(&cursor.0)
        .bind(&cursor.1)
        .bind(limit + 1)
        .fetch_all(&db)
        .await?;
        // The total counts every live booking of the account, unfiltered.
        let total: i64 = sqlx::query_scalar(
            "select count(*) from personal_calendar_bookings
             where deleted_at is null and personal_account_id = $1",
        )
        .bind(&account)
        .fetch_one(&db)
        .await?;
        Ok(page(rows(found), limit, total))
    }
    .await;
    answer(result, "Failed to list bookings")
}

/// `GET /api/bookings/:id`.
async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        match find(&db, &account, &id).await? {
            Some(row) => Ok(data(row)),
            None => Err(ApiError::not_found("Booking", Some(&id)).into()),
        }
    }
    .await;
    answer(result, "Failed to fetch booking")
}

/// `PATCH /api/bookings/:id/cancel`: the booking and its calendar event.
async fn cancel(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reason = match validate(&headers, &body, |issues, b| {
        issues
            .text(b, "cancelReason", Presence::Optional, None, Some(500))
            .into_option()
    }) {
        Ok(reason) => reason,
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
    let now = now_iso();
    let result = async {
        let Some(existing) = find(&db, &account, &id).await? else {
            return Err(Failure::from(ApiError::not_found("Booking", Some(&id))));
        };
        sqlx::query(
            "update personal_calendar_bookings set status = 'cancelled', cancelled_at = $3::timestamp,
               cancel_reason = $4, updated_at = $3::timestamp
             where id = $1 and personal_account_id = $2",
        )
        .bind(&id)
        .bind(&account)
        .bind(&now)
        .bind(&reason)
        .execute(&db)
        .await?;
        if let Some(event) = existing["calendarEventId"].as_str().filter(|e| !e.is_empty()) {
            sqlx::query(
                "update personal_calendar_events set status = 'cancelled', updated_at = $3::timestamp
                 where id = $1 and personal_account_id = $2 and deleted_at is null",
            )
            .bind(event)
            .bind(&account)
            .bind(&now)
            .execute(&db)
            .await?;
        }
        Ok(data(json!({ "id": id, "status": "cancelled" })))
    }
    .await;
    answer(result, "Failed to cancel booking")
}

/// `DELETE /api/bookings/:id`: soft delete.
async fn remove(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let db = match caller.personal() {
        Ok(db) => db.clone(),
        Err(failure) => return unhandled(Err(failure)),
    };
    let result = async {
        if find(&db, &account, &id).await?.is_none() {
            return Err(Failure::from(ApiError::not_found("Booking", Some(&id))));
        }
        sqlx::query(
            "update personal_calendar_bookings set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = $1 and personal_account_id = $2",
        )
        .bind(&id)
        .bind(&account)
        .bind(now_iso())
        .execute(&db)
        .await?;
        Ok(no_content())
    }
    .await;
    answer(result, "Failed to delete booking")
}
