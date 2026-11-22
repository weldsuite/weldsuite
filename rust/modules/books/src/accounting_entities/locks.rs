//! Lock dates (`PATCH /:id/lock-dates`) and their logged, time-limited
//! exceptions (`/:id/lock-exceptions`). Postings dated on or before a lock
//! date are refused by the posting engine; the hard lock has no exceptions
//! and only moves forward.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::accounting_entity::upsert_accounting_entity_settings;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, now, now_ms, ok, reply, validate,
};
use weldsuite_books_domain::tables::LOCK_DATE_EXCEPTIONS;
use weldsuite_catalogs::entity_events::ACCOUNTING_ENTITY_UPDATED;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_schema::tenant::{entities, lock_date_exceptions};

use super::{find_active, serialize};
use crate::entity_setup::today_in;
use crate::orm_bridge::{pg_date, sqlx_error, to_json};

const LOCK_FIELDS: [&str; 5] = [
    "salesLockDate",
    "purchaseLockDate",
    "taxLockDate",
    "periodLockDate",
    "hardLockDate",
];

/// The column of each of [`LOCK_FIELDS`].
const LOCK_COLUMNS: [entities::Column; 5] = [
    entities::Column::SalesLockDate,
    entities::Column::PurchaseLockDate,
    entities::Column::TaxLockDate,
    entities::Column::PeriodLockDate,
    entities::Column::HardLockDate,
];

const HARD_LOCK_FORWARD_ONLY: &str = "The hard lock date can only move forward";
const MAX_EXCEPTION_DAYS: i64 = 30;

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn iso_shaped(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// The `isoDate` refinement: the value at UTC midnight is a real day whose
/// ISO string starts with the value.
fn real_date(value: &str) -> bool {
    weldsuite_books_domain::js::js_date(&format!("{value}T00:00:00Z"))
        .is_some_and(|iso| iso.starts_with(value))
}

/// `lockDatesSchema`: each date `YYYY-MM-DD` (regex), then a real date
/// (refinement, settled after every regex check).
fn read_lock_dates(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut refused = Vec::new();
    for field in LOCK_FIELDS {
        match issues.pattern(
            body,
            field,
            Presence::Nullish,
            None,
            None,
            iso_shaped,
            "Use the YYYY-MM-DD format",
        ) {
            Field::Set(value) => {
                if !real_date(&value) {
                    refused.push(field);
                }
                out.insert(field.to_owned(), json!(value));
            }
            Field::Null => {
                out.insert(field.to_owned(), Value::Null);
            }
            Field::Absent => {
                // A string that failed the regex still reaches the refinement.
                if let Some(Value::String(value)) = body.get(field)
                    && !real_date(value)
                {
                    refused.push(field);
                }
            }
        }
    }
    for field in refused {
        issues.custom(field, "Not a valid date");
    }
    out
}

/// Write the lock dates in `patch` (a date, or `null` to clear it) to the
/// live entity `id`. The hard-lock guard is repeated in the statement, so two
/// requests can't move it backwards between the read and the write. The row
/// as Drizzle returns it, or `None` when the guard (or nothing) matched.
async fn write_lock_dates(
    db: &PgPool,
    id: &str,
    patch: &Map<String, Value>,
) -> Result<Option<Value>, DbErr> {
    let mut update = entities::Entity::update_many();
    for (field, column) in LOCK_FIELDS.into_iter().zip(LOCK_COLUMNS) {
        if let Some(value) = patch.get(field) {
            let day = value.as_str().map(pg_date).transpose()?;
            update = update.col_expr(column, Expr::value(day));
        }
    }
    update = update
        .col_expr(
            entities::Column::UpdatedAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(entities::Column::Id.eq(id))
        .filter(entities::Column::DeletedAt.is_null());
    if let Some(hard) = patch.get("hardLockDate").and_then(Value::as_str) {
        update = update.filter(
            Condition::any()
                .add(entities::Column::HardLockDate.is_null())
                .add(entities::Column::HardLockDate.lte(pg_date(hard)?)),
        );
    }
    update
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(to_json)
        .transpose()
}

#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn lock_dates(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match validate(&headers, &body, read_lock_dates) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond("Failed to update lock dates"),
    };
    let result = async {
        let Some(existing) = find_active(&caller, &id).await? else {
            return Err(Refusal::not_found("Entity", &id));
        };
        let current_hard = existing
            .get("hardLockDate")
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty());
        match body.get("hardLockDate") {
            None => {}
            Some(Value::Null) => {
                if current_hard.is_some() {
                    return Err(Refusal::bad_request(HARD_LOCK_FORWARD_ONLY));
                }
            }
            Some(value) => {
                let hard = value.as_str().unwrap_or_default();
                if current_hard.is_some_and(|current| hard < current) {
                    return Err(Refusal::bad_request(HARD_LOCK_FORWARD_ONLY));
                }
                if hard > today_in(existing.get("timezone").and_then(Value::as_str)).as_str() {
                    return Err(Refusal::bad_request(
                        "The hard lock date can't be in the future",
                    ));
                }
            }
        }
        let mut patch = Map::new();
        for field in LOCK_FIELDS {
            let Some(value) = body.get(field) else {
                continue;
            };
            if field == "hardLockDate" && value.is_null() {
                continue;
            }
            patch.insert(field.to_owned(), value.clone());
        }
        let changes: Map<String, Value> = patch
            .iter()
            .filter(|(field, value)| existing.get(field.as_str()).unwrap_or(&Value::Null) != *value)
            .map(|(field, value)| {
                (
                    field.clone(),
                    change(
                        existing.get(field.as_str()).cloned().unwrap_or(Value::Null),
                        value.clone(),
                    ),
                )
            })
            .collect();
        if changes.is_empty() {
            return Ok(ok(serialize(&existing)));
        }
        let updated = write_lock_dates(&caller.db, &id, &patch)
            .await
            .map_err(sqlx_error)?;
        let Some(updated) = updated else {
            return Err(Refusal::bad_request(HARD_LOCK_FORWARD_ONLY));
        };
        // The extension holds the lock dates too (release 1 writes both).
        upsert_accounting_entity_settings(&caller.db, &id, &patch).await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&id),
                entity_type: "accounting_entity",
                entity_id: &id,
                action: "lock_dates_updated",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_ENTITY_UPDATED,
            &id,
            json!({
                "id": id,
                "name": updated["name"],
                "salesLockDate": updated["salesLockDate"],
                "purchaseLockDate": updated["purchaseLockDate"],
                "taxLockDate": updated["taxLockDate"],
                "periodLockDate": updated["periodLockDate"],
                "hardLockDate": updated["hardLockDate"],
            }),
        );
        Ok(ok(serialize(updated.as_object().unwrap_or(&Map::new()))))
    }
    .await;
    reply(result, "Failed to update lock dates")
}

pub(crate) async fn list_exceptions(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if find_active(&caller, &id).await?.is_none() {
            return Err(Refusal::not_found("Entity", &id));
        }
        let rows = lock_date_exceptions::Entity::find()
            .filter(lock_date_exceptions::Column::EntityId.eq(id.as_str()))
            .order_by_desc(lock_date_exceptions::Column::CreatedAt)
            .order_by_desc(lock_date_exceptions::Column::Id)
            .all(&orm(&caller.db))
            .await
            .map_err(sqlx_error)?;
        let rows = rows
            .into_iter()
            .map(to_json)
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlx_error)?;
        Ok(ok(Value::Array(rows)))
    }
    .await;
    reply(result, "Failed to fetch lock date exceptions")
}

/// `createLockExceptionSchema`.
struct NewException {
    lock_type: String,
    user_id: Option<String>,
    ends_at: String,
    reason: String,
}

fn read_exception(issues: &mut Issues, body: &Map<String, Value>) -> Option<NewException> {
    let lock_type = issues.choice(
        body,
        "lockType",
        Presence::Required,
        &["sales", "purchase", "tax", "period"],
    );
    let user_id = issues.text(body, "userId", Presence::Nullish, Some(1), Some(255));
    let ends_at = issues.text_with(
        body,
        "endsAt",
        Presence::Required,
        Text {
            format: Some(Format::DatetimeOffset),
            ..Text::default()
        },
    );
    let reason = issues.text_with(
        body,
        "reason",
        Presence::Required,
        Text::trimmed(Some(3), Some(2000)),
    );
    Some(NewException {
        lock_type: lock_type.into_option()?,
        user_id: user_id.into_option(),
        ends_at: ends_at.into_option()?,
        reason: reason.into_option()?,
    })
}

pub(crate) async fn create_exception(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_exception) {
        Ok(Some(input)) => input,
        Ok(None) => {
            return Refusal::Internal("unreadable body".to_owned())
                .respond("Failed to create lock date exception");
        }
        Err(refusal) => return refusal.respond("Failed to create lock date exception"),
    };
    let now_millis = now_ms();
    let ends_millis =
        weldsuite_books_domain::js::js_date_millis(&input.ends_at).unwrap_or(i64::MIN);
    if ends_millis <= now_millis {
        return Refusal::bad_request("endsAt must be in the future")
            .respond("Failed to create lock date exception");
    }
    if ends_millis > now_millis + MAX_EXCEPTION_DAYS * 24 * 60 * 60 * 1000 {
        return Refusal::bad_request(format!(
            "endsAt can be at most {MAX_EXCEPTION_DAYS} days ahead"
        ))
        .respond("Failed to create lock date exception");
    }
    let result = async {
        if find_active(&caller, &id).await?.is_none() {
            return Err(Refusal::not_found("Entity", &id));
        }
        let ends_at = weldsuite_books_domain::js::iso_from_millis(ends_millis).unwrap_or_default();
        let mut values = Map::new();
        for (key, value) in [
            ("id", json!(generate_id("lde"))),
            ("createdAt", json!(now())),
            ("entityId", json!(id)),
            ("lockType", json!(input.lock_type)),
            ("userId", json!(input.user_id)),
            ("endsAt", json!(ends_at)),
            ("reason", json!(input.reason)),
            ("createdBy", json!(caller.user_id)),
        ] {
            values.insert(key.to_owned(), value);
        }
        let exception = LOCK_DATE_EXCEPTIONS
            .insert_raw(&caller.db, LOCK_DATE_EXCEPTIONS.values(&values))
            .await?;
        let mut changes = Map::new();
        for key in ["lockType", "userId", "endsAt", "reason"] {
            changes.insert(key.to_owned(), change(Value::Null, exception[key].clone()));
        }
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&id),
                entity_type: "lock_date_exception",
                entity_id: exception["id"].as_str().unwrap_or_default(),
                action: "created",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_ENTITY_UPDATED,
            &id,
            json!({
                "id": id,
                "lockDateException": {
                    "id": exception["id"],
                    "lockType": exception["lockType"],
                    "userId": exception["userId"],
                    "endsAt": exception["endsAt"],
                    "status": "created",
                },
            }),
        );
        Ok(created(exception))
    }
    .await;
    reply(result, "Failed to create lock date exception")
}

/// The lock date exception `id` as Drizzle returns it; with `entity_id`, only
/// when it belongs to that entity.
async fn find_exception(
    db: &PgPool,
    id: &str,
    entity_id: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    let mut select =
        lock_date_exceptions::Entity::find().filter(lock_date_exceptions::Column::Id.eq(id));
    if let Some(entity_id) = entity_id {
        select = select.filter(lock_date_exceptions::Column::EntityId.eq(entity_id));
    }
    select.one(&orm(db)).await?.map(to_json).transpose()
}

pub(crate) async fn revoke_exception(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, exception_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let Some(existing) = find_exception(&caller.db, &exception_id, Some(&id))
            .await
            .map_err(sqlx_error)?
        else {
            return Err(Refusal::not_found("Lock date exception", &exception_id));
        };
        // Already revoked: the first revocation stays on record.
        if !existing["revokedAt"].is_null() {
            return Ok(ok(existing));
        }
        let revoked = lock_date_exceptions::Entity::update_many()
            .col_expr(
                lock_date_exceptions::Column::RevokedAt,
                Expr::value(weldsuite_db::utc_now()),
            )
            .col_expr(
                lock_date_exceptions::Column::RevokedBy,
                Expr::value(caller.user_id.as_str()),
            )
            .filter(lock_date_exceptions::Column::Id.eq(exception_id.as_str()))
            .filter(lock_date_exceptions::Column::RevokedAt.is_null())
            .exec_with_returning(&orm(&caller.db))
            .await
            .map_err(sqlx_error)?
            .into_iter()
            .next()
            .map(to_json)
            .transpose()
            .map_err(sqlx_error)?;
        let Some(revoked) = revoked else {
            // Lost a race with another revoke: the row as it now stands.
            let current = find_exception(&caller.db, &exception_id, None)
                .await
                .map_err(sqlx_error)?;
            return Ok(ok(current.unwrap_or(existing)));
        };
        let mut changes = Map::new();
        changes.insert(
            "revokedAt".to_owned(),
            change(Value::Null, revoked["revokedAt"].clone()),
        );
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&id),
                entity_type: "lock_date_exception",
                entity_id: &exception_id,
                action: "revoked",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_ENTITY_UPDATED,
            &id,
            json!({
                "id": id,
                "lockDateException": {
                    "id": revoked["id"],
                    "lockType": revoked["lockType"],
                    "userId": revoked["userId"],
                    "endsAt": revoked["endsAt"],
                    "status": "revoked",
                },
            }),
        );
        Ok(ok(revoked))
    }
    .await;
    reply(result, "Failed to revoke lock date exception")
}
