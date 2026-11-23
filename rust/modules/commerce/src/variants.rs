//! `/api/products/:id/variants`: a product's variants, one per combination
//! of its options (`products.options`, at most three), each with its own
//! SKU, barcode, price and status.
//!
//! - A variant's options are `optionValues`, `{ Size: "M", Colour: "Red" }`
//!   on the wire and `[{ name, value }]` in `product_variants.option_values`
//!   (the shape connector ingest writes), ordered by the product's options.
//!   Option names follow the product's spelling; matching ignores case.
//! - Two live variants of a product never have the same options.
//! - A SKU or barcode is unique among the workspace's live products and live
//!   variants; there is no database index for it yet, so the variant writes
//!   check it under a transaction-scoped advisory lock (a clash is a 409
//!   naming the field). Product writes keep stash-api's behaviour and do not
//!   check.
//! - `price` null means the product's price.
//! - `inventory_quantity` is never written here: the WeldStash ledger owns it
//!   (ADR STASH-001).
//! - Every write keeps `products.has_variants` and `variant_count` right and
//!   publishes `product.updated` for the parent: the catalog has no variant
//!   entity type.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func, NullOrdering, Order, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::PRODUCT_UPDATED;
use weldsuite_catalogs::permission_keys::{PRODUCTS_READ, PRODUCTS_UPDATE};
use weldsuite_db::{OrmConn, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{product_variants, products};

use crate::args::{advisory_lock, select_bool};
use crate::tables::{PRODUCT_VARIANTS, PRODUCTS};
use crate::{Caller, CommerceState, Refusal, internal, now, validate};

/// At most this many options per product (Shopify's limit too).
pub(crate) const MAX_OPTIONS: usize = 3;
/// At most this many combinations from one generate.
pub(crate) const MAX_COMBINATIONS: usize = 100;

/// The advisory lock every variant write takes before it checks SKUs,
/// barcodes and combinations, so two writes cannot both pass the check.
const CODES_LOCK: &str = "weldcommerce:catalogue-codes";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PRODUCTS_READ]);
    let write = || gate.require([PRODUCTS_UPDATE]);
    Router::new()
        .route("/{id}/variants", get(list).route_layer(read()))
        .route("/{id}/variants", post(create).route_layer(write()))
        .route(
            "/{id}/variants/generate",
            post(generate).route_layer(write()),
        )
        .route(
            "/{id}/variants/{variant_id}",
            patch(update).route_layer(write()),
        )
        .route(
            "/{id}/variants/{variant_id}",
            axum::routing::delete(remove).route_layer(write()),
        )
}

// ── options ─────────────────────────────────────────────────────────────────

/// One of a product's options (`products.options`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProductOption {
    pub(crate) name: String,
    pub(crate) values: Vec<String>,
}

/// A variant's options, `(name, value)` in the product's option order.
pub(crate) type Combination = Vec<(String, String)>;

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `products.options` as stored (jsonb nothing constrains): the well-formed
/// entries.
pub(crate) fn product_options(product: &Value) -> Vec<ProductOption> {
    product
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter_map(|option| {
                    let name = option.get("name")?.as_str()?.to_owned();
                    let values = option
                        .get("values")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(ProductOption { name, values })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn options_json(options: &[ProductOption]) -> Value {
    Value::Array(
        options
            .iter()
            .map(|option| json!({ "name": option.name, "values": option.values }))
            .collect(),
    )
}

/// A variant's stored `optionValues`: `[{ name, value }]`, or a
/// `{ name: value }` object.
pub(crate) fn stored_combination(value: &Value) -> Combination {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                Some((
                    item.get("name")?.as_str()?.to_owned(),
                    item.get("value")?.as_str()?.to_owned(),
                ))
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
            .collect(),
        _ => Vec::new(),
    }
}

/// The same options, whatever their order and case.
pub(crate) fn same_combination(a: &Combination, b: &Combination) -> bool {
    a.len() == b.len()
        && a.iter().all(|(name, value)| {
            b.iter()
                .any(|(other_name, other_value)| same(name, other_name) && same(value, other_value))
        })
}

/// The option values of a write, in the product's options: names and values
/// take the product's spelling, a new name or value is added to the
/// product's options. The combination in option order, and whether the
/// options changed.
pub(crate) fn place(
    values: &[(String, String)],
    options: &mut Vec<ProductOption>,
) -> (Combination, bool) {
    let mut changed = false;
    let mut placed: Vec<(usize, String, String)> = Vec::new();
    for (name, value) in values {
        let at = if let Some(at) = options.iter().position(|o| same(&o.name, name)) {
            at
        } else {
            options.push(ProductOption {
                name: name.clone(),
                values: Vec::new(),
            });
            changed = true;
            options.len() - 1
        };
        let option = &mut options[at];
        let value = if let Some(known) = option.values.iter().find(|v| same(v, value)) {
            known.clone()
        } else {
            option.values.push(value.clone());
            changed = true;
            value.clone()
        };
        placed.push((at, option.name.clone(), value));
    }
    placed.sort_by_key(|(at, _, _)| *at);
    (
        placed
            .into_iter()
            .map(|(_, name, value)| (name, value))
            .collect(),
        changed,
    )
}

/// A generate's options in the product's spelling: a name or value the
/// product already has (ignoring case) is written its way.
pub(crate) fn respell(wanted: &[ProductOption], known: &[ProductOption]) -> Vec<ProductOption> {
    wanted
        .iter()
        .map(|option| {
            let Some(known) = known.iter().find(|k| same(&k.name, &option.name)) else {
                return option.clone();
            };
            ProductOption {
                name: known.name.clone(),
                values: option
                    .values
                    .iter()
                    .map(|value| {
                        known
                            .values
                            .iter()
                            .find(|k| same(k, value))
                            .unwrap_or(value)
                            .clone()
                    })
                    .collect(),
            }
        })
        .collect()
}

/// `[{ name, value }]`, as `product_variants.option_values` holds it.
fn combination_json(combination: &Combination) -> Value {
    Value::Array(
        combination
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    )
}

/// The variant's name: its values, `M / Red`.
pub(crate) fn variant_name(combination: &Combination) -> String {
    let name = combination
        .iter()
        .map(|(_, value)| value.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    if name.is_empty() {
        "Variant".to_owned()
    } else {
        name.chars().take(255).collect()
    }
}

/// Every combination of `options`, in their order (the first option
/// varies slowest).
pub(crate) fn cartesian(options: &[ProductOption]) -> Vec<Combination> {
    let mut out: Vec<Combination> = vec![Vec::new()];
    for option in options {
        out = out
            .into_iter()
            .flat_map(|prefix| {
                option.values.iter().map(move |value| {
                    let mut next = prefix.clone();
                    next.push((option.name.clone(), value.clone()));
                    next
                })
            })
            .collect();
    }
    out
}

/// A variant row as the API answers it: Drizzle's row, with `optionValues`
/// as `{ name: value }`.
fn present(mut row: Value) -> Value {
    let options: Map<String, Value> = stored_combination(&row["optionValues"])
        .into_iter()
        .map(|(name, value)| (name, Value::String(value)))
        .collect();
    if let Value::Object(fields) = &mut row {
        fields.insert("optionValues".to_owned(), Value::Object(options));
    }
    row
}

// ── request bodies ──────────────────────────────────────────────────────────

/// A variant write as the body asked for it: `None` and `Field::Absent` are
/// left out, `Field::Null` clears a nullable field.
#[derive(Debug, Default)]
struct VariantBody {
    option_values: Option<Vec<(String, String)>>,
    sku: Field<String>,
    barcode: Field<String>,
    price: Field<String>,
    /// The variant's VAT category; null inherits the product's.
    vat_category: Field<String>,
    status: Option<String>,
    position: Option<i64>,
}

/// `products.vat_category` / `product_variants.vat_category`.
pub(crate) const VAT_CATEGORIES: [&str; 5] =
    ["standard", "reduced", "super_reduced", "zero", "exempt"];

/// `{ Size: "M", … }`: one to three names, each with a value.
fn read_option_values(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
) -> Option<Vec<(String, String)>> {
    issues
        .nested(fields, "optionValues", presence, |issues, values| {
            let before = issues.count();
            let mut out: Vec<(String, String)> = Vec::new();
            for key in values.keys() {
                let name = js_trim(key);
                let value = issues
                    .text_with(
                        values,
                        key,
                        Presence::Required,
                        Text::trimmed(Some(1), Some(255)),
                    )
                    .into_option();
                if name.is_empty() || name.encode_utf16().count() > 255 {
                    issues.custom(key, "An option name is 1 to 255 characters");
                } else if out.iter().any(|(other, _)| same(other, name)) {
                    issues.custom(key, "An option is named twice");
                } else if let Some(value) = value {
                    out.push((name.to_owned(), value));
                }
            }
            if issues.count() == before && (out.is_empty() || out.len() > MAX_OPTIONS) {
                issues.custom_here(&format!("A variant has 1 to {MAX_OPTIONS} option values"));
            }
            out
        })
        .into_option()
}

/// A code (`sku`, `barcode`): trimmed, at most 100 characters, blank or null
/// for none.
fn read_code(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Field<String> {
    match issues.text_with(
        fields,
        key,
        Presence::Nullish,
        Text::trimmed(None, Some(100)),
    ) {
        Field::Set(code) if code.is_empty() => Field::Null,
        field => field,
    }
}

/// A price: a non-negative amount as a string or a number, null for the
/// product's price. The amount as text for a `numeric` column.
fn read_price(issues: &mut Issues, fields: &Map<String, Value>) -> Field<String> {
    let amount = match issues.string_or_number(fields, "price", Presence::Nullish) {
        Field::Absent => return Field::Absent,
        Field::Null => return Field::Null,
        Field::Set(Value::Number(number)) => number
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && *n < 1e16)
            .map(|n| format!("{n}")),
        Field::Set(Value::String(text)) => {
            let text = js_trim(&text);
            let decimal = !text.is_empty()
                && text.split_once('.').map_or_else(
                    || text.bytes().all(|b| b.is_ascii_digit()),
                    |(whole, fraction)| {
                        !whole.is_empty()
                            && !fraction.is_empty()
                            && whole.bytes().all(|b| b.is_ascii_digit())
                            && fraction.bytes().all(|b| b.is_ascii_digit())
                    },
                );
            (decimal && text.parse::<f64>().is_ok_and(|n| n < 1e16)).then(|| text.to_owned())
        }
        Field::Set(_) => None,
    };
    if let Some(amount) = amount {
        return Field::Set(amount);
    }
    issues.custom(
        "price",
        "Price is a non-negative amount, or null for the product's price",
    );
    Field::Absent
}

/// A nullable column's new value: `Some(value)` to write (null clears it),
/// `None` to leave it.
fn written(field: Field<String>) -> Option<Value> {
    match field {
        Field::Set(value) => Some(Value::String(value)),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    }
}

fn read_variant(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> VariantBody {
    let presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    VariantBody {
        option_values: read_option_values(issues, fields, presence),
        sku: read_code(issues, fields, "sku"),
        barcode: read_code(issues, fields, "barcode"),
        price: read_price(issues, fields),
        vat_category: issues.choice(fields, "vatCategory", Presence::Nullish, &VAT_CATEGORIES),
        status: issues
            .text_with(
                fields,
                "status",
                Presence::Optional,
                Text::trimmed(Some(1), Some(20)),
            )
            .into_option(),
        position: issues
            .integer(fields, "position", Presence::Optional, Some(0))
            .into_option(),
    }
}

/// `{ options: [{ name, values }] }`: one to three options with unique
/// names, each with one or more values (repeats dropped), at most
/// [`MAX_COMBINATIONS`] combinations.
fn read_generate(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<ProductOption> {
    let options = issues
        .list(
            fields,
            "options",
            Presence::Required,
            Some(1),
            Some(MAX_OPTIONS),
            |issues, item| {
                let option = issues.object(item)?;
                let before = issues.count();
                let name = issues
                    .text_with(
                        option,
                        "name",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(255)),
                    )
                    .into_option();
                let values = issues
                    .list(
                        option,
                        "values",
                        Presence::Required,
                        Some(1),
                        Some(MAX_COMBINATIONS),
                        |issues, value| issues.item_text(value, Text::trimmed(Some(1), Some(255))),
                    )
                    .into_option();
                if issues.count() > before {
                    return None;
                }
                let mut unique: Vec<String> = Vec::new();
                for value in values? {
                    if !unique.iter().any(|known| same(known, &value)) {
                        unique.push(value);
                    }
                }
                Some(ProductOption {
                    name: name?,
                    values: unique,
                })
            },
        )
        .into_option()
        .unwrap_or_default();
    if options.is_empty() {
        return options;
    }
    let mut seen: Vec<&str> = Vec::new();
    for option in &options {
        if seen.iter().any(|name| same(name, &option.name)) {
            issues.custom("options", "Option names must be unique");
            return Vec::new();
        }
        seen.push(&option.name);
    }
    let combinations: usize = options.iter().map(|o| o.values.len()).product();
    if combinations > MAX_COMBINATIONS {
        issues.custom(
            "options",
            &format!(
                "At most {MAX_COMBINATIONS} variants can be generated; these options make {combinations}"
            ),
        );
        return Vec::new();
    }
    options
}

// ── statements ──────────────────────────────────────────────────────────────

/// The live product, locked (`for update`) until the transaction ends.
async fn live_product<C: ConnectionTrait>(db: &C, id: &str) -> Result<Value, Refusal> {
    let row = products::Entity::find_by_id(id)
        .filter(products::Column::DeletedAt.is_null())
        .lock_exclusive()
        .one(db)
        .await?;
    match row {
        Some(row) => Ok(PRODUCTS.model(&row)?),
        None => Err(Refusal::not_found("Product", id)),
    }
}

/// The product's live variants by `position` (none last), then age.
async fn live_variants<C: ConnectionTrait>(db: &C, product_id: &str) -> Result<Vec<Value>, DbErr> {
    product_variants::Entity::find()
        .filter(product_variants::Column::ProductId.eq(product_id))
        .filter(product_variants::Column::DeletedAt.is_null())
        .order_by_with_nulls(
            product_variants::Column::Position,
            Order::Asc,
            NullOrdering::Last,
        )
        .order_by_asc(product_variants::Column::CreatedAt)
        .order_by_asc(product_variants::Column::Id)
        .all(db)
        .await?
        .iter()
        .map(|row| PRODUCT_VARIANTS.model(row))
        .collect()
}

/// Whether the live product `id` is there.
async fn product_exists(db: &weldsuite_db::PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = products::Entity::find_by_id(id)
        .filter(products::Column::DeletedAt.is_null())
        .select_only()
        .column(products::Column::Id)
        .into_tuple()
        .one(&weldsuite_db::orm(db))
        .await?;
    Ok(found.is_some())
}

/// 409 when `code` is taken (`field` is `sku` or `barcode`): a live
/// product's, or another live variant's.
async fn check_code<C: ConnectionTrait>(
    db: &C,
    field: &str,
    code: &str,
    variant_id: &str,
) -> Result<(), Refusal> {
    let (product_column, variant_column, label) = if field == "sku" {
        (products::Column::Sku, product_variants::Column::Sku, "SKU")
    } else {
        (
            products::Column::Barcode,
            product_variants::Column::Barcode,
            "Barcode",
        )
    };
    let product = Query::select()
        .expr(Expr::val(1))
        .from(products::Entity)
        .and_where(products::Column::DeletedAt.is_null())
        .and_where(product_column.eq(code))
        .to_owned();
    let variant = Query::select()
        .expr(Expr::val(1))
        .from(product_variants::Entity)
        .and_where(product_variants::Column::DeletedAt.is_null())
        .and_where(variant_column.eq(code))
        .and_where(product_variants::Column::Id.ne(variant_id))
        .to_owned();
    let taken = select_bool(
        db,
        sea_orm::ExprTrait::or(Expr::exists(product), Expr::exists(variant)),
    )
    .await?;
    if taken {
        return Err(ApiError::conflict(format!(
            "{label} \"{code}\" is already used by another product or variant"
        ))
        .with_details(json!({ "field": field }))
        .into());
    }
    Ok(())
}

/// 409 when another live variant of the product has these options.
fn check_combination(
    variants: &[Value],
    combination: &Combination,
    except: Option<&str>,
) -> Result<(), Refusal> {
    let clash = variants.iter().find(|variant| {
        variant["id"].as_str() != except
            && same_combination(&stored_combination(&variant["optionValues"]), combination)
    });
    match clash {
        Some(variant) => Err(
            ApiError::conflict("A variant with these options already exists")
                .with_details(json!({ "field": "optionValues", "variantId": variant["id"] }))
                .into(),
        ),
        None => Ok(()),
    }
}

/// Recount the product's variants (and store `options` when given); the
/// product as it is now. One statement: `has_variants` and `variant_count`
/// from the live variants' `count(*)::int`.
async fn recount<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
    options: Option<&[ProductOption]>,
) -> Result<Value, DbErr> {
    let live = || {
        Expr::from(
            Query::select()
                .expr(Func::cast_as(Func::count(Expr::col(Asterisk)), "int"))
                .from(product_variants::Entity)
                .and_where(product_variants::Column::ProductId.eq(product_id))
                .and_where(product_variants::Column::DeletedAt.is_null())
                .to_owned(),
        )
    };
    let mut update = products::Entity::update_many();
    if let Some(options) = options {
        update = update.col_expr(products::Column::Options, Expr::val(options_json(options)));
    }
    let row = update
        .col_expr(
            products::Column::HasVariants,
            sea_orm::ExprTrait::gt(live(), 0),
        )
        .col_expr(products::Column::VariantCount, live())
        .col_expr(products::Column::UpdatedAt, Expr::val(utc_now()))
        .filter(products::Column::Id.eq(product_id))
        .exec_with_returning(db)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound(format!("product {product_id}")))?;
    PRODUCTS.model(&row)
}

/// The event every variant write publishes: `product.updated` for the
/// parent, with the product's fields.
fn publish_product(state: &CommerceState, caller: &Caller, product: &Value) {
    let id = product["id"].as_str().unwrap_or_default();
    caller.publish(
        state,
        PRODUCT_UPDATED,
        id,
        &crate::products::updated_event(id, &Map::new(), product),
    );
}

/// The row of a new variant.
fn new_variant(
    caller: &Caller,
    product: &Value,
    combination: &Combination,
    position: i64,
    now: &str,
) -> Map<String, Value> {
    let t = &PRODUCT_VARIANTS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(generate_id("pvr")));
    t.set(&mut values, "productId", product["id"].clone());
    t.set(&mut values, "name", json!(variant_name(combination)));
    t.set(&mut values, "optionValues", combination_json(combination));
    t.set(&mut values, "sku", Value::Null);
    t.set(&mut values, "barcode", Value::Null);
    t.set(&mut values, "price", Value::Null);
    // New writes set the currency rather than take the column's `USD`
    // default (ADR COM-010).
    t.set(
        &mut values,
        "currency",
        json!(product["currency"].as_str().unwrap_or("EUR")),
    );
    t.set(&mut values, "status", json!("active"));
    t.set(&mut values, "position", json!(position));
    t.set(&mut values, "createdBy", json!(caller.user_id));
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    values
}

fn next_position(variants: &[Value]) -> i64 {
    variants
        .iter()
        .filter_map(|v| v["position"].as_i64())
        .max()
        .map_or(0, |max| max + 1)
}

// ── routes ──────────────────────────────────────────────────────────────────

/// `GET /:id/variants`: the live variants by `position`, then age.
async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list variants";
    match product_exists(&caller.db, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    }
    match live_variants(&weldsuite_db::orm(&caller.db), &id).await {
        Ok(rows) => Data(rows.into_iter().map(present).collect::<Vec<_>>()).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

/// `POST /:id/variants`: one variant.
async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create variant";
    let body = match validate(&headers, &body, |issues, fields| {
        read_variant(issues, fields, false)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match create_variant(&caller, &id, body).await {
        Ok((variant_id, product)) => {
            publish_product(&state, &caller, &product);
            Created(json!({ "id": variant_id })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn create_variant(
    caller: &Caller,
    product_id: &str,
    body: VariantBody,
) -> Result<(String, Value), Refusal> {
    let mut tx = caller.db.begin().await?;
    let made = {
        let db = OrmConn::new(&mut tx);
        advisory_lock(&db, CODES_LOCK).await?;
        let product = live_product(&db, product_id).await?;
        let variants = live_variants(&db, product_id).await?;
        let mut options = product_options(&product);
        let (combination, changed) = place(&body.option_values.unwrap_or_default(), &mut options);
        if options.len() > MAX_OPTIONS {
            return Err(ApiError::bad_request(format!(
                "A product has at most {MAX_OPTIONS} options"
            ))
            .with_details(json!({ "field": "optionValues" }))
            .into());
        }
        check_combination(&variants, &combination, None)?;
        let now = now();
        let mut values = new_variant(
            caller,
            &product,
            &combination,
            body.position.unwrap_or_else(|| next_position(&variants)),
            &now,
        );
        let variant_id = values
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        for (field, code) in [("sku", &body.sku), ("barcode", &body.barcode)] {
            if let Field::Set(code) = code {
                check_code(&db, field, code, &variant_id).await?;
                PRODUCT_VARIANTS.set(&mut values, field, json!(code));
            }
        }
        if let Some(price) = written(body.price) {
            PRODUCT_VARIANTS.set(&mut values, "price", price);
        }
        if let Field::Set(category) = &body.vat_category {
            PRODUCT_VARIANTS.set(&mut values, "vatCategory", json!(category));
        }
        if let Some(status) = body.status {
            PRODUCT_VARIANTS.set(&mut values, "status", json!(status));
        }
        PRODUCT_VARIANTS
            .insert_on(&db, values, &["createdAt", "updatedAt"])
            .await?;
        let product = recount(&db, product_id, changed.then_some(options.as_slice())).await?;
        (variant_id, product)
    };
    tx.commit().await?;
    Ok(made)
}

/// `POST /:id/variants/generate`: the missing combinations of `options`.
async fn generate(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to generate variants";
    let options = match validate(&headers, &body, read_generate) {
        Ok(options) => options,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match generate_variants(&caller, &id, &options).await {
        Ok((created, kept, product, variants)) => {
            publish_product(&state, &caller, &product);
            Data(json!({
                "created": created,
                "kept": kept,
                "variants": variants.into_iter().map(present).collect::<Vec<_>>(),
            }))
            .into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn generate_variants(
    caller: &Caller,
    product_id: &str,
    options: &[ProductOption],
) -> Result<(usize, usize, Value, Vec<Value>), Refusal> {
    let mut tx = caller.db.begin().await?;
    let generated = {
        let db = OrmConn::new(&mut tx);
        advisory_lock(&db, CODES_LOCK).await?;
        let product = live_product(&db, product_id).await?;
        let existing = live_variants(&db, product_id).await?;
        let options = respell(options, &product_options(&product));
        let mut matched: Vec<&str> = Vec::new();
        let mut position = next_position(&existing);
        let now = now();
        let (mut created, mut kept) = (0, 0);
        for combination in cartesian(&options) {
            let found = existing.iter().find(|variant| {
                let id = variant["id"].as_str().unwrap_or_default();
                !matched.contains(&id)
                    && same_combination(&stored_combination(&variant["optionValues"]), &combination)
            });
            if let Some(variant) = found {
                matched.push(variant["id"].as_str().unwrap_or_default());
                kept += 1;
                continue;
            }
            let values = new_variant(caller, &product, &combination, position, &now);
            PRODUCT_VARIANTS
                .insert_on(&db, values, &["createdAt", "updatedAt"])
                .await?;
            position += 1;
            created += 1;
        }
        let product = recount(&db, product_id, Some(&options)).await?;
        let variants = live_variants(&db, product_id).await?;
        (created, kept, product, variants)
    };
    tx.commit().await?;
    Ok(generated)
}

/// `PATCH /:id/variants/:variantId`.
async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, variant_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update variant";
    let body = match validate(&headers, &body, |issues, fields| {
        read_variant(issues, fields, true)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match update_variant(&caller, &id, &variant_id, body).await {
        Ok(product) => {
            publish_product(&state, &caller, &product);
            Data(json!({ "id": variant_id })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The live variant `variant_id` of the product.
async fn live_variant<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
    variant_id: &str,
) -> Result<Option<Value>, DbErr> {
    product_variants::Entity::find_by_id(variant_id)
        .filter(product_variants::Column::ProductId.eq(product_id))
        .filter(product_variants::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .map(|row| PRODUCT_VARIANTS.model(&row))
        .transpose()
}

async fn update_variant(
    caller: &Caller,
    product_id: &str,
    variant_id: &str,
    body: VariantBody,
) -> Result<Value, Refusal> {
    let mut tx = caller.db.begin().await?;
    let product = {
        let db = OrmConn::new(&mut tx);
        advisory_lock(&db, CODES_LOCK).await?;
        let product = live_product(&db, product_id).await?;
        let Some(variant) = live_variant(&db, product_id, variant_id).await? else {
            return Err(Refusal::not_found("Variant", variant_id));
        };
        let t = &PRODUCT_VARIANTS;
        let mut values = Map::new();
        t.set(&mut values, "updatedAt", json!(now()));
        let mut options = product_options(&product);
        let mut options_changed = false;
        if let Some(wanted) = &body.option_values {
            let (combination, changed) = place(wanted, &mut options);
            if options.len() > MAX_OPTIONS {
                return Err(ApiError::bad_request(format!(
                    "A product has at most {MAX_OPTIONS} options"
                ))
                .with_details(json!({ "field": "optionValues" }))
                .into());
            }
            let variants = live_variants(&db, product_id).await?;
            check_combination(&variants, &combination, Some(variant_id))?;
            t.set(&mut values, "optionValues", combination_json(&combination));
            t.set(&mut values, "name", json!(variant_name(&combination)));
            options_changed = changed;
        }
        for (field, code) in [("sku", &body.sku), ("barcode", &body.barcode)] {
            match code {
                Field::Set(code) => {
                    if variant[field].as_str() != Some(code.as_str()) {
                        check_code(&db, field, code, variant_id).await?;
                    }
                    t.set(&mut values, field, json!(code));
                }
                Field::Null => t.set(&mut values, field, Value::Null),
                Field::Absent => {}
            }
        }
        if let Some(price) = written(body.price) {
            t.set(&mut values, "price", price);
        }
        match &body.vat_category {
            Field::Set(category) => t.set(&mut values, "vatCategory", json!(category)),
            Field::Null => t.set(&mut values, "vatCategory", Value::Null),
            Field::Absent => {}
        }
        if let Some(status) = body.status {
            t.set(&mut values, "status", json!(status));
        }
        if let Some(position) = body.position {
            t.set(&mut values, "position", json!(position));
        }
        t.patch_on(&db, variant_id, values, true, &["updatedAt"])
            .await?;
        recount(
            &db,
            product_id,
            options_changed.then_some(options.as_slice()),
        )
        .await?
    };
    tx.commit().await?;
    Ok(product)
}

/// `DELETE /:id/variants/:variantId`: a soft delete.
async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, variant_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete variant";
    match remove_variant(&caller, &id, &variant_id).await {
        Ok(product) => {
            publish_product(&state, &caller, &product);
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn remove_variant(
    caller: &Caller,
    product_id: &str,
    variant_id: &str,
) -> Result<Value, Refusal> {
    let mut tx = caller.db.begin().await?;
    let product = {
        let db = OrmConn::new(&mut tx);
        live_product(&db, product_id).await?;
        let now = utc_now();
        let removed = product_variants::Entity::update_many()
            .col_expr(product_variants::Column::DeletedAt, Expr::val(now))
            .col_expr(product_variants::Column::UpdatedAt, Expr::val(now))
            .filter(product_variants::Column::Id.eq(variant_id))
            .filter(product_variants::Column::ProductId.eq(product_id))
            .filter(product_variants::Column::DeletedAt.is_null())
            .exec(&db)
            .await?;
        if removed.rows_affected == 0 {
            return Err(Refusal::not_found("Variant", variant_id));
        }
        recount(&db, product_id, None).await?
    };
    tx.commit().await?;
    Ok(product)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(name: &str, values: &[&str]) -> ProductOption {
        ProductOption {
            name: name.to_owned(),
            values: values.iter().map(|v| (*v).to_owned()).collect(),
        }
    }

    fn pairs(values: &[(&str, &str)]) -> Combination {
        values
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn the_matrix_varies_the_last_option_fastest() {
        let combos = cartesian(&[
            option("Size", &["S", "M"]),
            option("Colour", &["Red", "Blue"]),
        ]);
        assert_eq!(combos.len(), 4);
        assert_eq!(combos[0], pairs(&[("Size", "S"), ("Colour", "Red")]));
        assert_eq!(combos[1], pairs(&[("Size", "S"), ("Colour", "Blue")]));
        assert_eq!(variant_name(&combos[3]), "M / Blue");
        assert_eq!(variant_name(&Vec::new()), "Variant");
    }

    #[test]
    fn options_take_the_products_spelling_and_order() {
        let mut options = vec![option("Size", &["S"]), option("Colour", &["Red"])];
        let (combination, changed) =
            place(&pairs(&[("colour", "red"), ("size", "M")]), &mut options);
        assert!(changed, "M is a new size");
        assert_eq!(combination, pairs(&[("Size", "M"), ("Colour", "Red")]));
        assert_eq!(options[0].values, vec!["S", "M"]);
        let (_, changed) = place(&pairs(&[("SIZE", "s"), ("Colour", "RED")]), &mut options);
        assert!(!changed);
        let (combination, changed) = place(&pairs(&[("Material", "Wool")]), &mut options);
        assert!(changed);
        assert_eq!(options.len(), 3);
        assert_eq!(combination, pairs(&[("Material", "Wool")]));
    }

    #[test]
    fn a_generate_takes_the_products_spelling() {
        let known = [option("Size", &["S", "M"])];
        let wanted = [option("size", &["s", "L"]), option("Colour", &["Red"])];
        assert_eq!(
            respell(&wanted, &known),
            [option("Size", &["S", "L"]), option("Colour", &["Red"])]
        );
    }

    #[test]
    fn combinations_match_whatever_their_order_and_case() {
        let stored = stored_combination(&json!([
            { "name": "Size", "value": "M" },
            { "name": "Colour", "value": "Red" },
        ]));
        assert!(same_combination(
            &stored,
            &pairs(&[("colour", "RED"), ("size", "m")])
        ));
        assert!(!same_combination(&stored, &pairs(&[("Size", "M")])));
        assert!(!same_combination(
            &stored,
            &pairs(&[("Size", "M"), ("Colour", "Blue")])
        ));
        assert_eq!(
            stored_combination(&json!({ "Size": "L" })),
            pairs(&[("Size", "L")])
        );
        assert_eq!(stored_combination(&Value::Null), Combination::new());
    }

    fn body(value: Value, partial: bool) -> (VariantBody, usize) {
        let Value::Object(fields) = value else {
            panic!("an object");
        };
        let mut issues = Issues::default();
        let body = read_variant(&mut issues, &fields, partial);
        (body, issues.count())
    }

    #[test]
    fn variant_bodies() {
        let (read, issues) = body(
            json!({ "optionValues": { " Size ": "M " }, "sku": " TEE-M ", "barcode": "", "price": 12.5 }),
            false,
        );
        assert_eq!(issues, 0);
        assert_eq!(read.option_values, Some(pairs(&[("Size", "M")])));
        assert_eq!(read.sku, Field::Set("TEE-M".to_owned()));
        assert_eq!(read.barcode, Field::Null);
        assert_eq!(read.price, Field::Set("12.5".to_owned()));
        let (read, issues) = body(json!({ "price": null, "price2": 1 }), true);
        assert_eq!(issues, 0);
        assert_eq!(read.price, Field::Null);
        assert_eq!(
            body(json!({ "price": "9.99" }), true).0.price,
            Field::Set("9.99".to_owned())
        );
        for bad in [
            json!({}),
            json!({ "optionValues": {} }),
            json!({ "optionValues": { "A": "1", "B": "2", "C": "3", "D": "4" } }),
            json!({ "optionValues": { "Size": "" } }),
            json!({ "optionValues": { "Size": "M", "size": "L" } }),
            json!({ "optionValues": { "Size": 1 } }),
            json!({ "optionValues": { "Size": "M" }, "price": "-1" }),
            json!({ "optionValues": { "Size": "M" }, "price": "1e3" }),
            json!({ "optionValues": { "Size": "M" }, "price": -2 }),
            json!({ "optionValues": { "Size": "M" }, "sku": "x".repeat(101) }),
        ] {
            assert!(body(bad.clone(), false).1 >= 1, "{bad}");
        }
    }

    fn generate_body(value: Value) -> (Vec<ProductOption>, usize) {
        let Value::Object(fields) = value else {
            panic!("an object");
        };
        let mut issues = Issues::default();
        let options = read_generate(&mut issues, &fields);
        (options, issues.count())
    }

    #[test]
    fn generate_bodies() {
        let (options, issues) = generate_body(json!({ "options": [
            { "name": "Size", "values": ["S", "M", "s"] },
            { "name": "Colour", "values": ["Red"] },
        ] }));
        assert_eq!(issues, 0);
        assert_eq!(options[0], option("Size", &["S", "M"]));
        let values: Vec<String> = (0..11).map(|n| n.to_string()).collect();
        for bad in [
            json!({ "options": [] }),
            json!({ "options": [
                { "name": "A", "values": ["1"] }, { "name": "B", "values": ["1"] },
                { "name": "C", "values": ["1"] }, { "name": "D", "values": ["1"] },
            ] }),
            json!({ "options": [{ "name": "Size", "values": [] }] }),
            json!({ "options": [{ "name": "Size", "values": ["S"] }, { "name": "size", "values": ["M"] }] }),
            json!({ "options": [{ "name": "A", "values": values }, { "name": "B", "values": values }] }),
        ] {
            assert!(generate_body(bad.clone()).1 >= 1, "{bad}");
        }
    }
}
