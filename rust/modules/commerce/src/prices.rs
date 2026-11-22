//! `/api/products/:id/prices`: a product's prices per currency, and per
//! variant. The base price (`products.price`, a variant's `price`) stays the
//! price in the base currency; these rows add other currencies, and may
//! override the base currency for a variant. What a currency resolves to is
//! `weldsuite_commerce_domain::prices` (ADR COM-011).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Map, Value};
use sqlx::PgConnection;
use weldsuite_catalogs::entity_events::PRODUCT_UPDATED;
use weldsuite_catalogs::permission_keys::{PRODUCTS_READ, PRODUCTS_UPDATE};
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::tables::PRODUCTS;
use crate::wire::{read_currency, read_money};
use crate::{Caller, CommerceState, Refusal, now, validate, wire};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/{id}/prices",
            get(list).route_layer(gate.require([PRODUCTS_READ])),
        )
        .route(
            "/{id}/prices",
            put(replace).route_layer(gate.require([PRODUCTS_UPDATE])),
        )
}

const SELECT: &str = "select jsonb_build_object('id', p.id, 'productId', p.product_id, \
       'variantId', p.variant_id, 'currency', p.currency, 'price', p.price::text, \
       'compareAtPrice', p.compare_at_price::text) \
     from product_prices p where p.product_id = $1 and p.deleted_at is null \
     order by p.currency asc, (p.variant_id is not null), p.variant_id asc";

async fn current(conn: &mut PgConnection, product_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(SELECT)
        .bind(product_id)
        .fetch_all(&mut *conn)
        .await
}

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch product prices";
    let result = async {
        let mut conn = caller.db.acquire().await?;
        let exists: bool = sqlx::query_scalar(
            "select exists (select 1 from products where id = $1 and deleted_at is null)",
        )
        .bind(&id)
        .fetch_one(&mut *conn)
        .await?;
        if !exists {
            return Err(Refusal::not_found("Product", &id));
        }
        Ok(current(&mut conn, &id).await?)
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

struct Entry {
    variant_id: Option<String>,
    currency: String,
    price: Cents,
    compare_at: Option<Cents>,
}

fn read_entries(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<Entry> {
    let list = issues.list(
        fields,
        "prices",
        Presence::Required,
        None,
        Some(500),
        |issues, item| {
            let object = issues.object(item)?;
            let variant_id = issues
                .text_with(
                    object,
                    "variantId",
                    Presence::Nullish,
                    Text::trimmed(Some(1), Some(30)),
                )
                .into_option();
            let currency = read_currency(issues, object, Presence::Required).into_option();
            let price = read_money(issues, object, "price", Presence::Required).into_option();
            let compare_at = read_money(issues, object, "compareAtPrice", Presence::Nullish);
            Some(Entry {
                variant_id,
                currency: currency?,
                price: price?,
                compare_at: match compare_at {
                    Field::Set(cents) => Some(cents),
                    _ => None,
                },
            })
        },
    );
    list.into_option().unwrap_or_default()
}

async fn replace(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to save product prices";
    let entries = match validate(&headers, &body, read_entries) {
        Ok(entries) => entries,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match save(&caller, &id, &entries).await {
        Ok((product, rows)) => {
            caller.publish(
                &state,
                PRODUCT_UPDATED,
                &id,
                &crate::products::updated_event(&id, &Map::new(), &product),
            );
            Data(rows).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[allow(clippy::too_many_lines)]
async fn save(
    caller: &Caller,
    product_id: &str,
    entries: &[Entry],
) -> Result<(Value, Vec<Value>), Refusal> {
    // The same variant and currency twice is ambiguous.
    for (index, entry) in entries.iter().enumerate() {
        if entries[..index]
            .iter()
            .any(|o| o.variant_id == entry.variant_id && o.currency == entry.currency)
        {
            return Err(wire::invalid(
                &format!("prices.{index}.currency"),
                "This currency is listed twice for the same product or variant",
            ));
        }
    }
    let mut tx = caller.db.begin().await?;
    let locked = PRODUCTS
        .select_live
        .replace(" limit 1", " limit 1 for update of t");
    let product: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(locked))
        .bind(product_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(product) = product else {
        return Err(Refusal::not_found("Product", product_id));
    };
    let product = PRODUCTS.js(product);
    let variants: Vec<String> = sqlx::query_scalar(
        "select id from product_variants where product_id = $1 and deleted_at is null",
    )
    .bind(product_id)
    .fetch_all(&mut *tx)
    .await?;
    for (index, entry) in entries.iter().enumerate() {
        if let Some(variant) = &entry.variant_id
            && !variants.contains(variant)
        {
            return Err(wire::invalid(
                &format!("prices.{index}.variantId"),
                "Not a variant of this product",
            ));
        }
    }
    let stamp = now();
    let existing: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "select id, variant_id, currency from product_prices \
         where product_id = $1 and deleted_at is null for update",
    )
    .bind(product_id)
    .fetch_all(&mut *tx)
    .await?;
    // What is not listed goes first.
    for (row_id, variant, currency) in &existing {
        let kept = entries
            .iter()
            .any(|e| e.variant_id == *variant && e.currency == *currency);
        if !kept {
            sqlx::query(
                "update product_prices set deleted_at = $2::timestamp, updated_at = $2::timestamp \
                 where id = $1",
            )
            .bind(row_id)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        }
    }
    for entry in entries {
        let price = money::format(entry.price);
        let compare = entry.compare_at.map(money::format);
        let found = existing
            .iter()
            .find(|(_, v, c)| *v == entry.variant_id && *c == entry.currency);
        if let Some((row_id, _, _)) = found {
            sqlx::query(
                "update product_prices set price = $2::numeric, compare_at_price = $3::numeric, \
                 updated_at = $4::timestamp where id = $1",
            )
            .bind(row_id)
            .bind(&price)
            .bind(compare.as_deref())
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                "insert into product_prices (id, product_id, variant_id, currency, price, \
                 compare_at_price, created_at, updated_at) \
                 values ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::timestamp, $7::timestamp)",
            )
            .bind(generate_id("ppr"))
            .bind(product_id)
            .bind(entry.variant_id.as_deref())
            .bind(&entry.currency)
            .bind(&price)
            .bind(compare.as_deref())
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        }
    }
    let rows = current(&mut tx, product_id).await?;
    tx.commit().await?;
    Ok((product, rows))
}
