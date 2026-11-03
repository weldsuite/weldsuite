//! `/api/fx-rates` (`routes/fx-rates/index.ts`): the stored exchange rates
//! (`fx_rates`, append-only, no soft delete). A small complete route group:
//! the template for the other books groups.
//!
//! The TypeScript quirks are kept: a `?cursor=` drops the last filter from
//! the count when the cursor row is gone, a passthrough body writes every key
//! that is a column (a client `id` included), and a PATCH body without a
//! column fails the statement (500).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, list_limit, no_content, now, ok, page,
    paged, reply, validate,
};
use weldsuite_books_domain::tables::FX_RATES;
use weldsuite_catalogs::entity_events::{FX_RATE_CREATED, FX_RATE_DELETED, FX_RATE_UPDATED};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("reports:read")))
        .route(
            "/",
            axum::routing::post(create).route_layer(need("reports:create")),
        )
        .route("/{id}", get(detail).route_layer(need("reports:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("reports:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("reports:delete")),
        )
        .with_state(state)
}

/// `createFxRateSchema` (`@weldsuite/core-api-client/schemas/fx-rates`),
/// `.partial()` for a PATCH. Passthrough: the body as it came.
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    issues.text(body, "fromCurrency", required, Some(1), Some(10));
    issues.text(body, "toCurrency", required, Some(1), Some(10));
    issues.string_or_number(body, "rate", required);
    issues.text(body, "rateDate", Presence::Optional, None, None);
    issues.text(body, "source", Presence::Optional, None, Some(50));
    issues.text(body, "entityId", Presence::Nullish, None, None);
    body.clone()
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(list_rates(&caller, &q).await, "Failed to list fx rates")
}

async fn list_rates(caller: &Caller, q: &Query) -> Reply {
    let db = &caller.db;
    // `q.x !== undefined && q.x !== ''`
    let from = q.present("fromCurrency");
    let to = q.present("toCurrency");
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = q.present("cursor") {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, to_jsonb(created_at) #>> '{}' from fx_rates where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
        cursor = row.and_then(|(id, created)| {
            created
                .as_deref()
                .and_then(weldsuite_db::js_timestamp)
                .map(|at| (at, id))
        });
    }
    // The count drops the last condition when a cursor was asked for: the
    // keyset condition, or the last filter when the cursor row is gone.
    let (count_from, count_to) = match (q.present("cursor"), &cursor) {
        (Some(_), None) if to.is_some() => (from, None),
        (Some(_), None) => (None, to),
        _ => (from, to),
    };
    let Some(limit) = list_limit(q, 25, 100) else {
        return Err(Refusal::Internal("limit is NaN".to_owned()));
    };
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fx_rates),
        " from fx_rates t where ($1::text is null or t.from_currency = $1) \
         and ($2::text is null or t.to_currency = $2) \
         and ($3::timestamp is null or t.created_at < $3::timestamp \
         or (t.created_at = $3::timestamp and t.id < $4)) \
         order by t.created_at desc, t.id desc limit $5"
    ))
    .bind(from)
    .bind(to)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from fx_rates where ($1::text is null or from_currency = $1) \
         and ($2::text is null or to_currency = $2)",
    )
    .bind(count_from)
    .bind(count_to)
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(FX_RATES.js_rows(rows), limit);
    Ok(paged(rows, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fx_rates),
        " from fx_rates t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| FX_RATES.js(row)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("FX rate", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch fx rate")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create fx rate"),
    };
    let id = generate_id("fx");
    let result = async {
        // `{ id, ...data, createdAt: now, updatedAt: now }`
        let mut values = Map::new();
        FX_RATES.set(&mut values, "id", json!(id));
        values.extend(FX_RATES.values(&data));
        FX_RATES.set(&mut values, "createdAt", json!(now()));
        FX_RATES.insert(&caller.db, values, &["createdAt"]).await?;
        caller.publish(
            &state,
            FX_RATE_CREATED,
            &id,
            json!({
                "id": id,
                "fromCurrency": data.get("fromCurrency"),
                "toCurrency": data.get("toCurrency"),
                "rate": data.get("rate"),
            }),
        );
        Ok(created(json!({ "id": id })))
    }
    .await;
    reply(result, "Failed to create fx rate")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update fx rate"),
    };
    let result = async {
        let Some(existing) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("FX rate", &id));
        };
        // `{ updatedAt, ...data }`: fx_rates has no updated_at, so only the
        // body's columns are set; none at all leaves an empty SET (500).
        let values = FX_RATES.values(&data);
        if values.is_empty() {
            return Err(Refusal::Internal("No values to set".to_owned()));
        }
        FX_RATES.patch(&caller.db, &id, values, false, &[]).await?;
        let pick = |key: &str| {
            data.get(key)
                .cloned()
                .filter(|v| !v.is_null())
                .unwrap_or_else(|| existing.get(key).cloned().unwrap_or(Value::Null))
        };
        caller.publish(
            &state,
            FX_RATE_UPDATED,
            &id,
            json!({
                "id": id,
                "fromCurrency": pick("fromCurrency"),
                "toCurrency": pick("toCurrency"),
                "rate": pick("rate"),
            }),
        );
        Ok(ok(json!({ "id": id })))
    }
    .await;
    reply(result, "Failed to update fx rate")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if find(&caller, &id).await?.is_none() {
            return Err(Refusal::not_found("FX rate", &id));
        }
        sqlx::query("delete from fx_rates where id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, FX_RATE_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete fx rate")
}
