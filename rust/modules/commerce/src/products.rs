//! `/api/products`: the product catalogue, cursor-paged CRUD with the sales
//! tax fields `taxable` / `taxClass`.
//!
//! The prefix still belongs to the `stash` module in `@weldsuite/api-modules`:
//! Global's TypeScript stash-api serves it (`routes/products/index.ts`,
//! `tax-schemas.ts`) and WeldStash's pages call it. On the Rust backend the
//! route moved here from `weldsuite-stash` with its behaviour unchanged, so
//! the "stash: products" conformance suite (stash-api's tests, run against
//! this crate) still judges it: the quirks of stash-api's generic route file
//! are kept (a `?cursor=` makes the count drop the last condition of the
//! list; a passthrough body's `id` wins over the generated one in the row,
//! the response and the event still carry the generated id; a body key that
//! names a `date` timestamp makes Drizzle throw, the route's 500).
//!
//! The variants ([`crate::variants`]) and a product's categories
//! ([`crate::categories`]) are WeldCommerce's own sub-resources.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::Order;
use sea_orm::{ColumnTrait, Condition};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::sales_tax::tax_codes::{is_stripe_tax_code, is_weld_tax_code};
use weldsuite_catalogs::entity_events::{PRODUCT_CREATED, PRODUCT_DELETED, PRODUCT_UPDATED};
use weldsuite_catalogs::permission_keys::{
    PRODUCTS_CREATE, PRODUCTS_DELETE, PRODUCTS_READ, PRODUCTS_UPDATE,
};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::products;

use crate::args::{
    all_on, before, cursor_row, limit_plus_one, page_list, pushed, sliced, table_count, table_rows,
};
use crate::js::{js_limit, query_param, query_set};
use crate::table::WriteError;
use crate::tables::PRODUCTS;
use crate::{Caller, CommerceState, Refusal, internal, now, validate};

type Body = Map<String, Value>;

const LIST_FAILED: &str = "Failed to list products";
const FETCH_FAILED: &str = "Failed to fetch product";
const CREATE_FAILED: &str = "Failed to create product";
const UPDATE_FAILED: &str = "Failed to update product";
const DELETE_FAILED: &str = "Failed to delete product";

/// The product routes, the variants' and a product's categories, each with
/// its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.require([PRODUCTS_READ])))
        .route(
            "/",
            axum::routing::post(create).route_layer(gate.require([PRODUCTS_CREATE])),
        )
        .route(
            "/{id}",
            get(detail).route_layer(gate.require([PRODUCTS_READ])),
        )
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(gate.require([PRODUCTS_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(gate.require([PRODUCTS_DELETE])),
        )
        .merge(crate::variants::routes(gate))
        .merge(crate::prices::routes(gate))
        .merge(crate::categories::product_routes(gate))
}

// ── schema ──────────────────────────────────────────────────────────────────

/// `/^[A-Z]{1,2}\d{6,7}$/`: an Avalara product tax code.
fn is_product_avalara_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    let digits = bytes.len() - letters;
    (1..=2).contains(&letters)
        && (6..=7).contains(&digits)
        && bytes[letters..].iter().all(u8::is_ascii_digit)
}

/// `isAcceptedProductTaxClass(value)`: a WeldBooks tax code, a Stripe Tax
/// code or an Avalara product code
/// ([`weldsuite_books_domain::sales_tax::tax_codes`]).
fn is_accepted_product_tax_class(value: &str) -> bool {
    is_weld_tax_code(value) || is_stripe_tax_code(value) || is_product_avalara_code(value)
}

const TAX_CLASS_MESSAGE: &str =
    "Unknown tax code: use a WeldBooks code, a Stripe txcd_ code or an Avalara code";

/// `createProductBodySchema` (`updateProductBodySchema`, its `.partial()`,
/// for the PATCH): the body as Zod passes it on (passthrough), with
/// `taxClass` trimmed and blank as null.
fn product_schema(issues: &mut Issues, fields: &Body, partial: bool) -> Body {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let text = |issues: &mut Issues,
                key: &str,
                presence: Presence,
                min: Option<usize>,
                max: Option<usize>| {
        issues.text_with(fields, key, presence, Text::length(min, max));
    };
    text(issues, "name", required, Some(1), Some(255));
    text(issues, "slug", Presence::Optional, Some(1), Some(255));
    text(issues, "description", Presence::Optional, None, None);
    text(issues, "sku", Presence::Optional, None, Some(100));
    text(issues, "type", Presence::Optional, None, Some(30));
    text(issues, "status", Presence::Optional, None, Some(30));
    issues.string_or_number(fields, "price", Presence::Optional);
    text(issues, "currency", Presence::Optional, None, Some(10));
    text(issues, "categoryId", Presence::Nullish, None, None);
    text(issues, "imageUrl", Presence::Optional, None, None);
    issues.boolean(fields, "taxable", Presence::Optional);
    issues.choice(
        fields,
        "vatCategory",
        Presence::Optional,
        &crate::variants::VAT_CATEGORIES,
    );
    let mut data = fields.clone();
    // `productTaxClassSchema`: `.max(50).nullish()`, trimmed, `''` as null,
    // then refined (a refinement settles after every other check).
    let before = issues.count();
    let class = issues.text_with(
        fields,
        "taxClass",
        Presence::Nullish,
        Text::length(None, Some(50)),
    );
    let refused = match class {
        Field::Set(raw) => {
            let trimmed = js_trim(&raw);
            if trimmed.is_empty() {
                data.insert("taxClass".to_owned(), Value::Null);
                false
            } else {
                data.insert("taxClass".to_owned(), json!(trimmed));
                !is_accepted_product_tax_class(trimmed)
            }
        }
        Field::Null => {
            data.insert("taxClass".to_owned(), Value::Null);
            false
        }
        // A string past its `.max()` is still refined, untrimmed.
        Field::Absent => {
            issues.count() > before
                && fields
                    .get("taxClass")
                    .and_then(Value::as_str)
                    .is_some_and(|raw| !is_accepted_product_tax_class(raw))
        }
    };
    if refused {
        issues.custom("taxClass", TAX_CLASS_MESSAGE);
    }
    data
}

// ── events ──────────────────────────────────────────────────────────────────

/// `name ?? ''`.
fn name_or_empty(name: Value) -> Value {
    match name {
        Value::Null => json!(""),
        name => name,
    }
}

/// `(update.<key>) ?? existing.<key>`.
fn update_or_existing(data: &Body, existing: &Value, key: &str) -> Value {
    data.get(key)
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| existing.get(key).cloned().unwrap_or(Value::Null))
}

/// `{ id, name: data.name ?? '', sku, status, price, currency }`, the keys
/// the body left out left out.
fn created_event(id: &str, data: &Body) -> Value {
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert(
        "name".to_owned(),
        name_or_empty(data.get("name").cloned().unwrap_or(Value::Null)),
    );
    for key in ["sku", "status", "price", "currency"] {
        if let Some(value) = data.get(key) {
            event.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(event)
}

/// `(update.x ?? existing.x)`, the name `?? ''`. With an empty update, the
/// event a variant write publishes for its product.
pub(crate) fn updated_event(id: &str, data: &Body, existing: &Value) -> Value {
    json!({
        "id": id,
        "name": name_or_empty(update_or_existing(data, existing, "name")),
        "sku": update_or_existing(data, existing, "sku"),
        "status": update_or_existing(data, existing, "status"),
        "price": update_or_existing(data, existing, "price"),
        "currency": update_or_existing(data, existing, "currency"),
    })
}

/// `{ id, name: existing.name ?? '' }`.
fn deleted_event(id: &str, existing: &Value) -> Value {
    json!({
        "id": id,
        "name": name_or_empty(existing.get("name").cloned().unwrap_or(Value::Null)),
    })
}

// ── list ────────────────────────────────────────────────────────────────────

/// `like(t.name, s) or like(t.slug, s) or like(t.sku, s) or like(t.barcode, s)`.
fn search_condition(pattern: &str) -> Condition {
    Condition::any()
        .add(products::Column::Name.like(pattern))
        .add(products::Column::Slug.like(pattern))
        .add(products::Column::Sku.like(pattern))
        .add(products::Column::Barcode.like(pattern))
}

/// `GET /`: live products newest first, `eq(t.status, q.status)` when set,
/// then `like` on name, slug, SKU and barcode.
async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let cursor = query_set(query, "cursor");
    let status = query_set(query, "status");
    let search = query_set(query, "search").map(|search| format!("%{search}%"));
    // The cursor lookup runs before the route's `try`: a failure is the
    // app's 500.
    let cursor_row = match &cursor {
        None => None,
        Some(cursor) => match cursor_row::<products::Entity>(
            &caller.db,
            products::Column::CreatedAt,
            products::Column::Id,
            cursor,
        )
        .await
        {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "commerce: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
    };
    let slots = [
        Some(Condition::all().add(products::Column::DeletedAt.is_null())),
        status.map(|status| Condition::all().add(products::Column::Status.eq(status))),
        search.as_deref().map(search_condition),
        cursor_row
            .as_ref()
            .map(|row| before(products::Column::CreatedAt, products::Column::Id, row)),
    ];
    let on = pushed(&slots);
    let count_on = sliced(on.clone(), cursor.is_some());
    let mut select = PRODUCTS.entity.select();
    select
        .cond_where(all_on(&slots, &on))
        .order_by(products::Column::CreatedAt, Order::Desc)
        .order_by(products::Column::Id, Order::Desc);
    limit_plus_one(&mut select, limit);
    let mut counted = PRODUCTS.entity.select();
    counted.cond_where(all_on(&slots, &count_on));
    let rows = table_rows(&caller.db, &PRODUCTS, &select).await;
    let total = table_count(&caller.db, &PRODUCTS, &counted).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_list(rows, limit, total),
        (Err(error), _) | (_, Err(error)) => internal(&error, LIST_FAILED),
    }
}

// ── one product ─────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match PRODUCTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Product", &id).respond(FETCH_FAILED),
        Err(error) => internal(&error, FETCH_FAILED),
    }
}

/// `{ id, ...data, createdAt: now, updatedAt: now }`.
fn spread_create(data: &Body, id: &str, now: &str) -> Body {
    let mut props = Map::new();
    props.insert("id".to_owned(), json!(id));
    props.extend(data.clone());
    props.insert("createdAt".to_owned(), json!(now));
    props.insert("updatedAt".to_owned(), json!(now));
    props
}

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        product_schema(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(CREATE_FAILED),
    };
    let id = generate_id("prod");
    let props = spread_create(&data, &id, &now());
    let mut values = Map::new();
    for (prop, value) in &props {
        PRODUCTS.set(&mut values, prop, value.clone());
    }
    // What the route set itself is a JavaScript value (it sets the
    // timestamps after the body); what came from the body is checked as
    // Drizzle would.
    let trusted = ["id", "createdAt", "updatedAt"];
    if let Err(error) = PRODUCTS.insert(&caller.db, values, &trusted).await {
        return write_failed(&error, CREATE_FAILED);
    }
    caller.publish(&state, PRODUCT_CREATED, &id, &created_event(&id, &data));
    Created(json!({ "id": id })).into_response()
}

/// A failed write: the route's 500.
fn write_failed(error: &WriteError, message: &str) -> Response {
    internal(error, message)
}

async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        product_schema(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(UPDATE_FAILED),
    };
    let existing = match PRODUCTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Product", &id).respond(UPDATE_FAILED),
        Err(error) => return internal(&error, UPDATE_FAILED),
    };
    // `db.update(t).set({ updatedAt, ...update })`.
    let mut props = Map::new();
    props.insert("updatedAt".to_owned(), json!(now()));
    props.extend(data.clone());
    let mut values = Map::new();
    for (prop, value) in &props {
        PRODUCTS.set(&mut values, prop, value.clone());
    }
    // The route's own `updatedAt`, unless the body overrode it.
    let trusted: Vec<&str> = if data.contains_key("updatedAt") {
        Vec::new()
    } else {
        vec!["updatedAt"]
    };
    if let Err(error) = PRODUCTS
        .patch(&caller.db, &id, values, true, &trusted)
        .await
    {
        return write_failed(&error, UPDATE_FAILED);
    }
    caller.publish(
        &state,
        PRODUCT_UPDATED,
        &id,
        &updated_event(&id, &data, &existing),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let existing = match PRODUCTS.find_live(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Product", &id).respond(DELETE_FAILED),
        Err(error) => return internal(&error, DELETE_FAILED),
    };
    // `update(t).set({ deletedAt: new Date(), updatedAt: new Date() })`.
    let now = now();
    let mut values = Map::new();
    PRODUCTS.set(&mut values, "deletedAt", json!(now));
    PRODUCTS.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = PRODUCTS
        .patch(&caller.db, &id, values, false, &["deletedAt", "updatedAt"])
        .await
    {
        return write_failed(&error, DELETE_FAILED);
    }
    caller.publish(&state, PRODUCT_DELETED, &id, &deleted_event(&id, &existing));
    NoContent.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_product_tax_classes() {
        assert!(is_accepted_product_tax_class("saas"));
        assert!(is_accepted_product_tax_class("txcd_20030000"));
        assert!(is_accepted_product_tax_class("P0000000"));
        assert!(is_accepted_product_tax_class("SW054000"));
        assert!(!is_accepted_product_tax_class("txcd_123"));
        assert!(!is_accepted_product_tax_class("luxury"));
        assert!(!is_accepted_product_tax_class("ABC123456"));
    }

    fn read(body: Value, partial: bool) -> (Body, usize) {
        let Value::Object(fields) = body else {
            panic!("an object");
        };
        let mut issues = Issues::default();
        let data = product_schema(&mut issues, &fields, partial);
        (data, issues.count())
    }

    #[test]
    fn tax_class_is_trimmed_cleared_and_refined() {
        let (data, issues) = read(
            json!({ "name": "Tee", "slug": "tee", "taxClass": " clothing " }),
            false,
        );
        assert_eq!(issues, 0);
        assert_eq!(data["taxClass"], json!("clothing"));
        let (data, issues) = read(json!({ "taxClass": "  " }), true);
        assert_eq!(issues, 0);
        assert_eq!(data["taxClass"], Value::Null);
        let (data, issues) = read(json!({ "name": "Tee" }), true);
        assert_eq!(issues, 0);
        assert!(!data.contains_key("taxClass"));
        let (_, issues) = read(json!({ "taxClass": "reduced" }), true);
        assert_eq!(issues, 1);
        let (_, issues) = read(json!({ "taxClass": "x".repeat(51) }), true);
        assert!(issues >= 1);
        let (_, issues) = read(json!({}), false);
        assert!(issues >= 1);
    }

    #[test]
    fn events_carry_the_name_or_an_empty_one() {
        let data = Map::new();
        assert_eq!(
            created_event("prod_1", &data),
            json!({ "id": "prod_1", "name": "" })
        );
        let existing = json!({ "name": null, "sku": "S1", "status": "active", "price": "9.99", "currency": "EUR" });
        let mut change = Map::new();
        change.insert("sku".to_owned(), Value::Null);
        change.insert("price".to_owned(), json!(12));
        assert_eq!(
            updated_event("prod_1", &change, &existing),
            json!({ "id": "prod_1", "name": "", "sku": "S1", "status": "active", "price": 12, "currency": "EUR" })
        );
        assert_eq!(
            deleted_event("prod_1", &json!({ "name": "Widget" })),
            json!({ "id": "prod_1", "name": "Widget" })
        );
    }
}
