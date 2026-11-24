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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events::PRODUCT_UPDATED;
use weldsuite_catalogs::permission_keys::{PRODUCTS_READ, PRODUCTS_UPDATE};
use weldsuite_commerce_domain::money::Cents;
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{product_prices, product_variants, products};

use crate::args::decimal;
use crate::tables::PRODUCTS;
use crate::wire::{read_currency, read_money};
use crate::{Caller, CommerceState, Refusal, validate, wire};

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

/// A price as the routes answer it: `{ id, productId, variantId, currency,
/// price, compareAtPrice }`, the amounts as `numeric` text.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceRow {
    id: String,
    product_id: String,
    variant_id: Option<String>,
    currency: String,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize")]
    price: BigDecimal,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    compare_at_price: Option<BigDecimal>,
}

/// The product's live prices by currency, the product's own before its
/// variants'.
async fn current<C: ConnectionTrait>(db: &C, product_id: &str) -> Result<Vec<Value>, DbErr> {
    let rows: Vec<PriceRow> = product_prices::Entity::find()
        .select_only()
        .columns([
            product_prices::Column::Id,
            product_prices::Column::ProductId,
            product_prices::Column::VariantId,
            product_prices::Column::Currency,
            product_prices::Column::Price,
            product_prices::Column::CompareAtPrice,
        ])
        .filter(product_prices::Column::ProductId.eq(product_id))
        .filter(product_prices::Column::DeletedAt.is_null())
        .order_by_asc(product_prices::Column::Currency)
        .order_by_asc(product_prices::Column::VariantId.is_not_null())
        .order_by_asc(product_prices::Column::VariantId)
        .into_model()
        .all(db)
        .await?;
    rows.iter()
        .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
        .collect()
}

async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch product prices";
    let result = async {
        let db = orm(&caller.db);
        let exists: Option<String> = products::Entity::find_by_id(id.as_str())
            .filter(products::Column::DeletedAt.is_null())
            .select_only()
            .column(products::Column::Id)
            .into_tuple()
            .one(&db)
            .await?;
        if exists.is_none() {
            return Err(Refusal::not_found("Product", &id));
        }
        Ok(current(&db, &id).await?)
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
    let saved = {
        let db = OrmConn::new(&mut tx);
        let product = products::Entity::find_by_id(product_id)
            .filter(products::Column::DeletedAt.is_null())
            .lock_exclusive()
            .one(&db)
            .await?;
        let Some(product) = product else {
            return Err(Refusal::not_found("Product", product_id));
        };
        let product = PRODUCTS.model(&product)?;
        let variants: Vec<String> = product_variants::Entity::find()
            .select_only()
            .column(product_variants::Column::Id)
            .filter(product_variants::Column::ProductId.eq(product_id))
            .filter(product_variants::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&db)
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
        let stamp = utc_now();
        let existing: Vec<(String, Option<String>, String)> = product_prices::Entity::find()
            .select_only()
            .columns([
                product_prices::Column::Id,
                product_prices::Column::VariantId,
                product_prices::Column::Currency,
            ])
            .filter(product_prices::Column::ProductId.eq(product_id))
            .filter(product_prices::Column::DeletedAt.is_null())
            .lock_exclusive()
            .into_tuple()
            .all(&db)
            .await?;
        // What is not listed goes first.
        for (row_id, variant, currency) in &existing {
            let kept = entries
                .iter()
                .any(|e| e.variant_id == *variant && e.currency == *currency);
            if !kept {
                product_prices::Entity::update_many()
                    .col_expr(product_prices::Column::DeletedAt, Expr::val(stamp))
                    .col_expr(product_prices::Column::UpdatedAt, Expr::val(stamp))
                    .filter(product_prices::Column::Id.eq(row_id.as_str()))
                    .exec(&db)
                    .await?;
            }
        }
        for entry in entries {
            let price = decimal(entry.price);
            let compare = entry.compare_at.map(decimal);
            let found = existing
                .iter()
                .find(|(_, v, c)| *v == entry.variant_id && *c == entry.currency);
            if let Some((row_id, _, _)) = found {
                product_prices::Entity::update_many()
                    .col_expr(product_prices::Column::Price, Expr::val(price))
                    .col_expr(product_prices::Column::CompareAtPrice, Expr::val(compare))
                    .col_expr(product_prices::Column::UpdatedAt, Expr::val(stamp))
                    .filter(product_prices::Column::Id.eq(row_id.as_str()))
                    .exec(&db)
                    .await?;
            } else {
                product_prices::Entity::insert(product_prices::ActiveModel {
                    id: Set(generate_id("ppr")),
                    product_id: Set(product_id.to_owned()),
                    variant_id: Set(entry.variant_id.clone()),
                    currency: Set(entry.currency.clone()),
                    price: Set(price),
                    compare_at_price: Set(compare),
                    created_at: Set(stamp),
                    updated_at: Set(stamp),
                    ..Default::default()
                })
                .exec_without_returning(&db)
                .await?;
            }
        }
        let rows = current(&db, product_id).await?;
        (product, rows)
    };
    tx.commit().await?;
    Ok(saved)
}
