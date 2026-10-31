//! Lock dates (`PATCH /:id/lock-dates`) and their logged, time-limited
//! exceptions (`/:id/lock-exceptions`). Postings dated on or before a lock
//! date are refused by the posting engine; the hard lock has no exceptions
//! and only moves forward.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, now, now_ms, ok, reply, validate,
};
use weldsuite_books_domain::tables::{ENTITIES, LOCK_DATE_EXCEPTIONS};
use weldsuite_catalogs::entity_events::ACCOUNTING_ENTITY_UPDATED;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};

use super::{find_active, serialize};
use crate::entity_setup::today_in;

const LOCK_FIELDS: [&str; 5] = [
    "salesLockDate",
    "purchaseLockDate",
    "taxLockDate",
    "periodLockDate",
    "hardLockDate",
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

/// The `isoDate` refinement: `new Date(\`${value}T00:00:00Z\`)` is a real day
/// whose ISO string starts with the value.
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
                    return Err(Refusal::bad_request("The hard lock date can't be in the future"));
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
                    change(existing.get(field.as_str()).cloned().unwrap_or(Value::Null), value.clone()),
                )
            })
            .collect();
        if changes.is_empty() {
            return Ok(ok(serialize(&existing)));
        }
        // The hard-lock guard is repeated in the statement, so two requests
        // can't move it backwards between the read and the write.
        let hard = patch.get("hardLockDate").and_then(Value::as_str);
        let set = |key: &str| patch.get(key).cloned();
        let updated: Option<Value> = sqlx::query_scalar(concat!(
            "update entities as t set \
               sales_lock_date = case when $2 then $3::date else t.sales_lock_date end, \
               purchase_lock_date = case when $4 then $5::date else t.purchase_lock_date end, \
               tax_lock_date = case when $6 then $7::date else t.tax_lock_date end, \
               period_lock_date = case when $8 then $9::date else t.period_lock_date end, \
               hard_lock_date = case when $10 then $11::date else t.hard_lock_date end, \
               updated_at = $12::timestamp \
             where t.id = $1 and t.deleted_at is null \
               and ($11::text is null or t.hard_lock_date is null or t.hard_lock_date <= $11::date) \
             returning ",
            weldsuite_books_domain::books_row!(entities)
        ))
        .bind(&id)
        .bind(set("salesLockDate").is_some())
        .bind(set("salesLockDate").and_then(|v| v.as_str().map(str::to_owned)))
        .bind(set("purchaseLockDate").is_some())
        .bind(set("purchaseLockDate").and_then(|v| v.as_str().map(str::to_owned)))
        .bind(set("taxLockDate").is_some())
        .bind(set("taxLockDate").and_then(|v| v.as_str().map(str::to_owned)))
        .bind(set("periodLockDate").is_some())
        .bind(set("periodLockDate").and_then(|v| v.as_str().map(str::to_owned)))
        .bind(hard.is_some())
        .bind(hard)
        .bind(now())
        .fetch_optional(&caller.db)
        .await?;
        let Some(updated) = updated.map(|row| ENTITIES.js(row)) else {
            return Err(Refusal::bad_request(HARD_LOCK_FORWARD_ONLY));
        };
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
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(lock_date_exceptions),
            " from lock_date_exceptions t where t.entity_id = $1 order by t.created_at desc, t.id desc"
        ))
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(LOCK_DATE_EXCEPTIONS.js_rows(rows))))
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

pub(crate) async fn revoke_exception(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, exception_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let find = |only_entity: bool| {
            let db = caller.db.clone();
            let exception_id = exception_id.clone();
            let id = id.clone();
            async move {
                let row: Option<Value> = sqlx::query_scalar(concat!(
                    "select ",
                    weldsuite_books_domain::books_row!(lock_date_exceptions),
                    " from lock_date_exceptions t where t.id = $1 and (not $3 or t.entity_id = $2) limit 1"
                ))
                .bind(&exception_id)
                .bind(&id)
                .bind(only_entity)
                .fetch_optional(&db)
                .await?;
                Ok::<_, sqlx::Error>(row.map(|row| LOCK_DATE_EXCEPTIONS.js(row)))
            }
        };
        let Some(existing) = find(true).await? else {
            return Err(Refusal::not_found("Lock date exception", &exception_id));
        };
        // Already revoked: the first revocation stays on record.
        if !existing["revokedAt"].is_null() {
            return Ok(ok(existing));
        }
        let revoked: Option<Value> = sqlx::query_scalar(concat!(
            "update lock_date_exceptions as t set revoked_at = $2::timestamp, revoked_by = $3 \
             where t.id = $1 and t.revoked_at is null returning ",
            weldsuite_books_domain::books_row!(lock_date_exceptions)
        ))
        .bind(&exception_id)
        .bind(now())
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(revoked) = revoked.map(|row| LOCK_DATE_EXCEPTIONS.js(row)) else {
            // Lost a race with another revoke: the row as it now stands.
            let current = find(false).await?;
            return Ok(ok(current.unwrap_or(existing)));
        };
        let mut changes = Map::new();
        changes.insert("revokedAt".to_owned(), change(Value::Null, revoked["revokedAt"].clone()));
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
