//! `/api/customer-statuses` (`routes/customer-statuses/index.ts`): the
//! workspace's own customer lifecycle states (`crm_customer_statuses`).
//! Slugs are unique per workspace; the built-in ones are reserved.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOMER_STATUS_CREATED, CUSTOMER_STATUS_DELETED, CUSTOMER_STATUS_UPDATED,
};
use weldsuite_crm_domain::drizzle_row;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{self, OPT, REQ, Spec, int, partial, s};
use crate::{Answer, Caller, CrmState, answer, now, validate};

const LOG: &str = "customer-statuses";

/// Slugs of the built-in statuses the client hardcodes.
const BUILTIN_SLUGS: [&str; 5] = ["prospect", "active", "inactive", "churned", "blacklisted"];

/// `createCustomerStatusSchema` without its slug, which has a regex.
const NAME: Spec = Spec::new("name", s(Some(1), Some(60)), REQ);
const COLOR: Spec = Spec::new("color", s(Some(1), Some(30)), REQ);
const SORT_ORDER: Spec = Spec::new("sortOrder", int(None, None), OPT);

fn is_slug(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// `createCustomerStatusSchema`, or its `.partial()`.
fn status_input(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial_schema: bool,
) -> Map<String, Value> {
    let specs = if partial_schema {
        partial(&[NAME])
    } else {
        vec![NAME]
    };
    let mut out = schema::read(issues, body, &specs);
    let presence = if partial_schema {
        Presence::Optional
    } else {
        Presence::Required
    };
    if let Some(slug) = issues
        .pattern(
            body,
            "slug",
            presence,
            Some(1),
            Some(30),
            is_slug,
            "Invalid",
        )
        .into_option()
    {
        out.insert("slug".into(), json!(slug));
    }
    let rest = if partial_schema {
        partial(&[COLOR, SORT_ORDER])
    } else {
        vec![COLOR, SORT_ORDER]
    };
    for (key, value) in schema::read(issues, body, &rest) {
        out.insert(key, value);
    }
    out
}

async fn ordered(caller: &Caller) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_customer_statuses t where deleted_at is null
         order by sort_order asc, name asc",
    )
    .fetch_all(&caller.db)
    .await?;
    Ok(rows.into_iter().map(drizzle_row).collect())
}

async fn by_id(caller: &Caller, id: &str, live: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_customer_statuses t
         where id = $1 and (not $2 or deleted_at is null) limit 1",
    )
    .bind(id)
    .bind(live)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
}

/// A live status other than `except` with this slug.
async fn slug_taken(
    caller: &Caller,
    slug: &str,
    except: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from crm_customer_statuses
         where slug = $1 and deleted_at is null and ($2::text is null or id <> $2) limit 1",
    )
    .bind(slug)
    .bind(except)
    .fetch_optional(&caller.db)
    .await?;
    Ok(found.is_some())
}

pub(crate) async fn list(caller: Caller) -> Response {
    let result = async { Ok(Data(ordered(&caller).await?).into_response()) }.await;
    answer(result, LOG, "Failed to list customer statuses")
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        Ok(match by_id(&caller, &id, true).await? {
            Some(row) => Data(row).into_response(),
            None => ApiError::not_found("Customer status", Some(&id)).into_response(),
        })
    }
    .await;
    answer(result, LOG, "Failed to fetch customer status")
}

pub(crate) async fn reorder(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "ids",
                Presence::Required,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result: Answer = async {
        for (index, id) in ids.iter().enumerate() {
            sqlx::query(
                "update crm_customer_statuses set sort_order = $2, updated_at = $3::timestamp
                 where id = $1 and deleted_at is null",
            )
            .bind(id)
            .bind(i32::try_from(index).unwrap_or(i32::MAX))
            .bind(now())
            .execute(&caller.db)
            .await?;
        }
        let data = ordered(&caller).await?;
        let first = ids.first().map_or("reorder", String::as_str);
        caller.publish(
            &state,
            CUSTOMER_STATUS_UPDATED,
            first,
            &json!({ "ids": ids }),
        );
        Ok(Data(data).into_response())
    }
    .await;
    answer(result, LOG, "Failed to reorder customer statuses")
}

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        status_input(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let slug = data.get("slug").and_then(Value::as_str).unwrap_or_default();
        if BUILTIN_SLUGS.contains(&slug) {
            return Ok(ApiError::conflict(format!("Slug '{slug}' is reserved")).into_response());
        }
        if slug_taken(&caller, slug, None).await? {
            return Ok(ApiError::conflict(format!("Slug '{slug}' is already in use")).into_response());
        }
        let id = generate_id("ccst");
        let now = now();
        sqlx::query(
            "insert into crm_customer_statuses (id, name, slug, color, sort_order, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6::timestamp, $6::timestamp)",
        )
        .bind(&id)
        .bind(data.get("name").and_then(Value::as_str))
        .bind(slug)
        .bind(data.get("color").and_then(Value::as_str))
        .bind(
            data.get("sortOrder")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok())
                .unwrap_or(0),
        )
        .bind(&now)
        .execute(&caller.db)
        .await?;
        let row = by_id(&caller, &id, false).await?;
        caller.publish(
            &state,
            CUSTOMER_STATUS_CREATED,
            &id,
            &json!({ "id": id, "name": data.get("name"), "slug": slug }),
        );
        Ok(Created(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create customer status")
}

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        status_input(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(existing) = by_id(&caller, &id, true).await? else {
            return Ok(ApiError::not_found("Customer status", Some(&id)).into_response());
        };
        if let Some(slug) = data.get("slug").and_then(Value::as_str) {
            if BUILTIN_SLUGS.contains(&slug) {
                return Ok(ApiError::conflict(format!("Slug '{slug}' is reserved")).into_response());
            }
            if slug_taken(&caller, slug, Some(&id)).await? {
                return Ok(
                    ApiError::conflict(format!("Slug '{slug}' is already in use")).into_response(),
                );
            }
        }
        let text = |key: &str| data.get(key).and_then(Value::as_str);
        sqlx::query(
            "update crm_customer_statuses set
                 updated_at = $2::timestamp,
                 name = coalesce($3, name),
                 slug = coalesce($4, slug),
                 color = coalesce($5, color),
                 sort_order = coalesce($6, sort_order)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text("name"))
        .bind(text("slug"))
        .bind(text("color"))
        .bind(
            data.get("sortOrder")
                .and_then(Value::as_i64)
                .and_then(|n| i32::try_from(n).ok()),
        )
        .execute(&caller.db)
        .await?;
        let row = by_id(&caller, &id, false).await?;
        let name = row
            .as_ref()
            .and_then(|row| row.get("name"))
            .or_else(|| existing.get("name"))
            .cloned();
        caller.publish(
            &state,
            CUSTOMER_STATUS_UPDATED,
            &id,
            &json!({ "id": id, "name": name }),
        );
        Ok(Data(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update customer status")
}

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if by_id(&caller, &id, true).await?.is_none() {
            return Ok(ApiError::not_found("Customer status", Some(&id)).into_response());
        }
        sqlx::query(
            "update crm_customer_statuses set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, CUSTOMER_STATUS_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete customer status")
}
