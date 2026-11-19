//! `/api/product-suppliers` (phase 1 of `weldsuite-documentation/plans/weldstash-replenishment.md`;
//! Rust only): who a product, or one of its variants, is bought from, and
//! on what terms (supplier SKU and name, unit cost, lead time, minimum
//! order and pack size).
//!
//! ```text
//! GET    /      ?productId= &variantId= (an id, or `none`) &supplierId=   preferred first, then oldest
//! POST   /      link a supplier                                          201
//! PATCH  /:id   change the terms                                         200
//! DELETE /:id   unlink (soft)                                            204
//! ```
//!
//! One supplier per product/variant is the preferred one, which the planner
//! orders from: the first link is preferred whatever the body says,
//! `isPreferred: true` takes it from the others, and unlinking the
//! preferred supplier passes it to the oldest remaining link. A row whose
//! preference changes that way publishes `product_supplier` `updated` too.
//! The links of one product/variant are changed one request at a time (a
//! transaction-scoped advisory lock), so two first links can't both be
//! preferred.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use weldsuite_catalogs::entity_events::{
    EventName, PRODUCT_SUPPLIER_CREATED, PRODUCT_SUPPLIER_DELETED, PRODUCT_SUPPLIER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    SUPPLIERS_CREATE, SUPPLIERS_DELETE, SUPPLIERS_READ, SUPPLIERS_UPDATE,
};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{number_text, query_set};
use crate::{Caller, Refusal, StashState, internal, now, validate};

const RESOURCE: &str = "Product supplier";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.require([SUPPLIERS_READ])))
        .route(
            "/",
            post(create).route_layer(gate.require([SUPPLIERS_CREATE])),
        )
        .route(
            "/{id}",
            patch(update).route_layer(gate.require([SUPPLIERS_UPDATE])),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([SUPPLIERS_DELETE])),
        )
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// A link with its names, at `$1`–`$5`: the id (or null), the product (or
/// null), the variant mode (`any` | `none` | `only`), the variant, the
/// supplier (or null). Live links only.
const ITEMS: &str = "select jsonb_build_object(\
    'row', to_jsonb(t) || jsonb_build_object('unit_cost', t.unit_cost::text), \
    'supplierName', s.name, 'supplierCode', s.code, 'supplierCurrency', s.currency, \
    'supplierLeadTimeDays', s.default_lead_time_days, 'productName', p.name, 'productSku', p.sku) \
    from product_suppliers t \
    left join suppliers s on s.id = t.supplier_id \
    left join products p on p.id = t.product_id \
    where t.deleted_at is null \
    and ($1::text is null or t.id = $1) \
    and ($2::text is null or t.product_id = $2) \
    and ($3::text = 'any' \
         or ($3::text = 'none' and coalesce(t.variant_id, '') = '') \
         or ($3::text = 'only' and t.variant_id = $4)) \
    and ($5::text is null or t.supplier_id = $5) \
    order by t.is_preferred desc, t.created_at asc, t.id asc";

/// `{ ...row, supplierName, supplierCode, supplierCurrency,
/// supplierLeadTimeDays, productName, productSku }`.
fn item(joined: &Value) -> Value {
    let mut row = match weldsuite_db::js_row(joined.get("row").cloned().unwrap_or(Value::Null)) {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    for key in [
        "supplierName",
        "supplierCode",
        "supplierCurrency",
        "supplierLeadTimeDays",
        "productName",
        "productSku",
    ] {
        row.insert(
            key.to_owned(),
            joined.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(row)
}

/// The filters of a list.
struct Filters<'a> {
    id: Option<&'a str>,
    product_id: Option<&'a str>,
    /// `any`, `none` or `only` (with the variant).
    variant: (&'static str, Option<&'a str>),
    supplier_id: Option<&'a str>,
}

async fn items<'e>(
    db: impl sqlx::PgExecutor<'e>,
    filters: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(ITEMS)
        .bind(filters.id)
        .bind(filters.product_id)
        .bind(filters.variant.0)
        .bind(filters.variant.1)
        .bind(filters.supplier_id)
        .fetch_all(db)
        .await?;
    Ok(rows.iter().map(item).collect())
}

/// The live link `id` with its names.
pub(crate) async fn find_item<'e>(
    db: impl sqlx::PgExecutor<'e>,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let filters = Filters {
        id: Some(id),
        product_id: None,
        variant: ("any", None),
        supplier_id: None,
    };
    Ok(items(db, &filters).await?.into_iter().next())
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list product suppliers";
    let query = query.as_deref();
    let product_id = query_set(query, "productId");
    let variant = query_set(query, "variantId");
    let supplier_id = query_set(query, "supplierId");
    let filters = Filters {
        id: None,
        product_id: product_id.as_deref(),
        variant: match variant.as_deref() {
            None => ("any", None),
            Some("none") => ("none", None),
            Some(id) => ("only", Some(id)),
        },
        supplier_id: supplier_id.as_deref(),
    };
    match items(&caller.db, &filters).await {
        Ok(rows) => {
            let total = u64::try_from(rows.len()).unwrap_or(u64::MAX);
            List::new(rows, Pagination::new(total, false, None)).into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

// ── Body ────────────────────────────────────────────────────────────────────

/// The terms, in both bodies (`.partial()` for `PATCH`).
#[derive(Debug, Default)]
struct Terms {
    supplier_sku: Field<String>,
    supplier_product_name: Field<String>,
    unit_cost: Field<f64>,
    currency: Field<String>,
    lead_time_days: Field<i64>,
    min_order_qty: Field<i64>,
    order_multiple: Field<i64>,
    is_preferred: Field<bool>,
}

/// `POST`'s body: the item and its terms.
#[derive(Debug)]
struct NewLink {
    product_id: String,
    variant_id: Option<String>,
    supplier_id: String,
    terms: Terms,
}

fn whole(min: f64, max: f64) -> Number {
    Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    }
}

fn read_terms(issues: &mut Issues, body: &Map<String, Value>) -> Terms {
    let len = |max: usize| Text::length(None, Some(max));
    let supplier_sku = issues.text_with(body, "supplierSku", Presence::Nullish, len(100));
    let supplier_product_name =
        issues.text_with(body, "supplierProductName", Presence::Nullish, len(255));
    let unit_cost = issues.number(
        body,
        "unitCost",
        Presence::Nullish,
        Number {
            coerce: false,
            int: false,
            min: Some(0.0),
            max: Some(10_000_000_000.0),
        },
    );
    let mut currency = issues.text_with(body, "currency", Presence::Nullish, Text::default());
    if let Field::Set(text) = &currency {
        let before = issues.count();
        issues.string_length("currency", 3, text.encode_utf16().count());
        if issues.count() > before {
            currency = Field::Absent;
        }
    }
    let lead_time_days =
        issues.whole_number(body, "leadTimeDays", Presence::Nullish, whole(0.0, 3650.0));
    let min_order_qty = issues.whole_number(
        body,
        "minOrderQty",
        Presence::Nullish,
        whole(1.0, 1_000_000_000.0),
    );
    let order_multiple = issues.whole_number(
        body,
        "orderMultiple",
        Presence::Optional,
        whole(1.0, 1_000_000.0),
    );
    let is_preferred = issues.boolean(body, "isPreferred", Presence::Optional);
    Terms {
        supplier_sku,
        supplier_product_name,
        unit_cost,
        currency,
        lead_time_days,
        min_order_qty,
        order_multiple,
        is_preferred,
    }
}

fn read_new(issues: &mut Issues, body: &Map<String, Value>) -> Option<NewLink> {
    let id = |issues: &mut Issues, key: &str, presence: Presence| {
        issues.text_with(body, key, presence, Text::length(Some(1), Some(30)))
    };
    let product_id = id(issues, "productId", Presence::Required);
    let variant_id = issues.text_with(
        body,
        "variantId",
        Presence::Nullish,
        Text::length(None, Some(30)),
    );
    let supplier_id = id(issues, "supplierId", Presence::Required);
    let terms = read_terms(issues, body);
    Some(NewLink {
        product_id: product_id.into_option()?,
        variant_id: variant_id.into_option().filter(|id| !id.is_empty()),
        supplier_id: supplier_id.into_option()?,
        terms,
    })
}

/// A field as `(given, value)` for `case when $given then $value else col end`.
fn slot<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

// ── Writing ─────────────────────────────────────────────────────────────────

/// Serialise the changes to one product/variant's links for the rest of
/// the transaction.
async fn lock_item(
    conn: &mut PgConnection,
    product_id: &str,
    variant_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query("select pg_advisory_xact_lock(hashtext('product_suppliers:' || $1 || ':' || coalesce($2, '')))")
        .bind(product_id)
        .bind(variant_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Take the preference from the item's other links; the ones that had it.
async fn unset_preferred(
    conn: &mut PgConnection,
    product_id: &str,
    variant_id: Option<&str>,
    except: &str,
    now: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "update product_suppliers set is_preferred = false, updated_at = $4::timestamp \
         where product_id = $1 and coalesce(variant_id, '') = coalesce($2, '') and id <> $3 \
         and deleted_at is null and is_preferred \
         returning jsonb_build_object('id', id, 'productId', product_id, 'variantId', variant_id, \
         'supplierId', supplier_id, 'isPreferred', is_preferred)",
    )
    .bind(product_id)
    .bind(variant_id)
    .bind(except)
    .bind(now)
    .fetch_all(&mut *conn)
    .await
}

/// The event data of a link.
fn event_of(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "productId": row["productId"],
        "variantId": row["variantId"],
        "supplierId": row["supplierId"],
        "isPreferred": row["isPreferred"],
    })
}

/// The link's own event first, then an `updated` for each link whose
/// preference changed with it.
fn events(own: (EventName, &Value), others: Vec<Value>) -> Vec<(EventName, String, Value)> {
    let mut out = vec![(
        own.0,
        own.1["id"].as_str().unwrap_or_default().to_owned(),
        event_of(own.1),
    )];
    for other in others {
        out.push((
            PRODUCT_SUPPLIER_UPDATED,
            other["id"].as_str().unwrap_or_default().to_owned(),
            other,
        ));
    }
    out
}

/// A link that already exists: the 409.
fn duplicate() -> Refusal {
    ApiError::conflict("This supplier is already linked to this product").into()
}

async fn create(
    State(state): State<StashState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create product supplier";
    let link = match validate(&headers, &body, read_new) {
        Ok(Some(link)) => link,
        Ok(None) => return ApiError::internal().into_response(),
        Err(refusal) => return refusal.respond(FAILED),
    };
    match create_link(&caller, link).await {
        Ok((row, demoted)) => {
            caller.publish_in_order(&state, events((PRODUCT_SUPPLIER_CREATED, &row), demoted));
            Created(row).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// The checks (404s, 409), then the insert with its preference, in one
/// transaction. The new item and the links that lost the preference.
async fn create_link(caller: &Caller, link: NewLink) -> Result<(Value, Vec<Value>), Refusal> {
    let db = &caller.db;
    let product: Option<String> =
        sqlx::query_scalar("select id from products where id = $1 and deleted_at is null limit 1")
            .bind(&link.product_id)
            .fetch_optional(db)
            .await?;
    if product.is_none() {
        return Err(Refusal::not_found("Product", &link.product_id));
    }
    if let Some(variant) = &link.variant_id {
        let found: Option<String> = sqlx::query_scalar(
            "select id from product_variants where id = $1 and product_id = $2 \
             and deleted_at is null limit 1",
        )
        .bind(variant)
        .bind(&link.product_id)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Err(Refusal::not_found("Product variant", variant));
        }
    }
    let supplier: Option<String> =
        sqlx::query_scalar("select id from suppliers where id = $1 and deleted_at is null limit 1")
            .bind(&link.supplier_id)
            .fetch_optional(db)
            .await?;
    if supplier.is_none() {
        return Err(Refusal::not_found("Supplier", &link.supplier_id));
    }
    let id = generate_id("psup");
    let at = now();
    let written = weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let variant = link.variant_id.as_deref();
            lock_item(conn, &link.product_id, variant).await?;
            let links: Vec<(String, String)> = sqlx::query_as(
                "select id, supplier_id from product_suppliers where product_id = $1 \
                 and coalesce(variant_id, '') = coalesce($2, '') and deleted_at is null",
            )
            .bind(&link.product_id)
            .bind(variant)
            .fetch_all(&mut *conn)
            .await?;
            if links.iter().any(|(_, supplier)| *supplier == link.supplier_id) {
                return Err(duplicate());
            }
            let terms = &link.terms;
            let preferred = links.is_empty() || terms.is_preferred.as_set() == Some(&true);
            let demoted = if preferred && !links.is_empty() {
                unset_preferred(conn, &link.product_id, variant, &id, &at).await?
            } else {
                Vec::new()
            };
            let inserted = sqlx::query(
                "insert into product_suppliers (id, created_at, updated_at, product_id, variant_id, \
                 supplier_id, supplier_sku, supplier_product_name, unit_cost, currency, \
                 lead_time_days, min_order_qty, order_multiple, is_preferred) values \
                 ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13)",
            )
            .bind(&id)
            .bind(&at)
            .bind(&link.product_id)
            .bind(variant)
            .bind(&link.supplier_id)
            .bind(terms.supplier_sku.as_set())
            .bind(terms.supplier_product_name.as_set())
            .bind(terms.unit_cost.as_set().map(|cost| number_text(*cost)))
            .bind(terms.currency.as_set())
            .bind(terms.lead_time_days.as_set())
            .bind(terms.min_order_qty.as_set())
            .bind(terms.order_multiple.as_set().copied().unwrap_or(1))
            .bind(preferred)
            .execute(&mut *conn)
            .await;
            match inserted {
                Ok(_) => {}
                Err(error) if weldsuite_db::is_unique_violation(&error) => return Err(duplicate()),
                Err(error) => return Err(error.into()),
            }
            let row = find_item(&mut *conn, &id)
                .await?
                .ok_or_else(|| Refusal::not_found(RESOURCE, &id))?;
            Ok::<_, Refusal>((row, demoted))
        })
    })
    .await?;
    Ok(written)
}

async fn update(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update product supplier";
    let terms = match validate(&headers, &body, read_terms) {
        Ok(terms) => terms,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let at = now();
    let written = weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let key: Option<(String, Option<String>)> = sqlx::query_as(
                "select product_id, variant_id from product_suppliers where id = $1 \
                 and deleted_at is null",
            )
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((product_id, variant_id)) = key else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            lock_item(conn, &product_id, variant_id.as_deref()).await?;
            let demoted = if terms.is_preferred.as_set() == Some(&true) {
                unset_preferred(conn, &product_id, variant_id.as_deref(), &id, &at).await?
            } else {
                Vec::new()
            };
            let (sku_set, sku) = slot(&terms.supplier_sku);
            let (name_set, name) = slot(&terms.supplier_product_name);
            let (cost_set, cost) = slot(&terms.unit_cost);
            let (currency_set, currency) = slot(&terms.currency);
            let (lead_set, lead) = slot(&terms.lead_time_days);
            let (moq_set, moq) = slot(&terms.min_order_qty);
            let (multiple_set, multiple) = slot(&terms.order_multiple);
            let (preferred_set, preferred) = slot(&terms.is_preferred);
            let changed: Option<String> = sqlx::query_scalar(
                "update product_suppliers set \
                 supplier_sku = case when $2 then $3 else supplier_sku end, \
                 supplier_product_name = case when $4 then $5 else supplier_product_name end, \
                 unit_cost = case when $6 then $7::numeric else unit_cost end, \
                 currency = case when $8 then $9 else currency end, \
                 lead_time_days = case when $10 then $11::integer else lead_time_days end, \
                 min_order_qty = case when $12 then $13::integer else min_order_qty end, \
                 order_multiple = case when $14 then $15::integer else order_multiple end, \
                 is_preferred = case when $16 then $17::boolean else is_preferred end, \
                 updated_at = $18::timestamp \
                 where id = $1 and deleted_at is null returning id",
            )
            .bind(&id)
            .bind(sku_set)
            .bind(sku)
            .bind(name_set)
            .bind(name)
            .bind(cost_set)
            .bind(cost.map(number_text))
            .bind(currency_set)
            .bind(currency)
            .bind(lead_set)
            .bind(lead)
            .bind(moq_set)
            .bind(moq)
            .bind(multiple_set)
            .bind(multiple)
            .bind(preferred_set)
            .bind(preferred)
            .bind(&at)
            .fetch_optional(&mut *conn)
            .await?;
            if changed.is_none() {
                return Err(Refusal::not_found(RESOURCE, &id));
            }
            let row = find_item(&mut *conn, &id)
                .await?
                .ok_or_else(|| Refusal::not_found(RESOURCE, &id))?;
            Ok::<_, Refusal>((row, demoted))
        })
    })
    .await;
    match written {
        Ok((row, demoted)) => {
            caller.publish_in_order(&state, events((PRODUCT_SUPPLIER_UPDATED, &row), demoted));
            Data(row).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete product supplier";
    let at = now();
    let removed = weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let key: Option<(String, Option<String>)> = sqlx::query_as(
                "select product_id, variant_id from product_suppliers where id = $1 \
                 and deleted_at is null",
            )
            .bind(&id)
            .fetch_optional(&mut *conn)
            .await?;
            let Some((product_id, variant_id)) = key else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            lock_item(conn, &product_id, variant_id.as_deref()).await?;
            let row: Value = sqlx::query_scalar(
                "update product_suppliers set deleted_at = $2::timestamp, updated_at = $2::timestamp \
                 where id = $1 returning jsonb_build_object('id', id, 'productId', product_id, \
                 'variantId', variant_id, 'supplierId', supplier_id, 'isPreferred', is_preferred)",
            )
            .bind(&id)
            .bind(&at)
            .fetch_one(&mut *conn)
            .await?;
            let promoted: Vec<Value> = if row["isPreferred"] == json!(true) {
                sqlx::query_scalar(
                    "update product_suppliers set is_preferred = true, updated_at = $3::timestamp \
                     where id = (select id from product_suppliers where product_id = $1 \
                       and coalesce(variant_id, '') = coalesce($2, '') and deleted_at is null \
                       order by created_at asc, id asc limit 1) \
                     returning jsonb_build_object('id', id, 'productId', product_id, \
                     'variantId', variant_id, 'supplierId', supplier_id, 'isPreferred', is_preferred)",
                )
                .bind(&product_id)
                .bind(variant_id.as_deref())
                .bind(&at)
                .fetch_all(&mut *conn)
                .await?
            } else {
                Vec::new()
            };
            Ok::<_, Refusal>((row, promoted))
        })
    })
    .await;
    match removed {
        Ok((row, promoted)) => {
            let mut deleted = events((PRODUCT_SUPPLIER_DELETED, &row), promoted);
            if let Some((_, _, data)) = deleted.first_mut()
                && let Value::Object(fields) = data
            {
                fields.remove("isPreferred");
            }
            caller.publish_in_order(&state, deleted);
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read<T>(
        body: &Value,
        reader: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Result<T, Vec<Value>> {
        let mut issues = Issues::default();
        let read = issues
            .object(body)
            .map(|fields| reader(&mut issues, fields));
        match issues.finish() {
            Ok(()) => Ok(read.expect("an object")),
            Err(invalid) => Err(invalid.issues().to_vec()),
        }
    }

    #[test]
    fn reads_a_new_link() {
        let link = read(
            &json!({
                "productId": "prod_1", "variantId": "", "supplierId": "sup_1",
                "supplierSku": "AC-1", "unitCost": 2.125, "currency": "EUR",
                "leadTimeDays": 0, "minOrderQty": 10, "orderMultiple": 6, "isPreferred": true,
            }),
            read_new,
        )
        .expect("valid")
        .expect("read");
        assert_eq!(link.product_id, "prod_1");
        assert_eq!(link.variant_id, None);
        assert_eq!(link.terms.unit_cost, Field::Set(2.125));
        assert_eq!(link.terms.currency, Field::Set("EUR".to_owned()));
        assert_eq!(link.terms.lead_time_days, Field::Set(0));
        assert_eq!(link.terms.order_multiple, Field::Set(6));
        assert_eq!(link.terms.is_preferred, Field::Set(true));
        assert_eq!(link.terms.supplier_product_name, Field::Absent);
    }

    #[test]
    fn refuses_bad_terms() {
        for body in [
            json!({ "supplierId": "sup_1" }),
            json!({ "productId": "prod_1" }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "currency": "EURO" }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "unitCost": -1 }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "leadTimeDays": -1 }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "minOrderQty": 0 }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "orderMultiple": 0 }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "orderMultiple": 1.5 }),
            json!({ "productId": "prod_1", "supplierId": "sup_1", "isPreferred": "yes" }),
        ] {
            assert!(read(&body, read_new).is_err(), "{body}");
        }
    }

    #[test]
    fn a_patch_tells_left_out_from_cleared() {
        let terms = read(
            &json!({ "supplierSku": null, "leadTimeDays": 5 }),
            read_terms,
        )
        .expect("valid");
        assert_eq!(slot(&terms.supplier_sku), (true, None));
        assert_eq!(slot(&terms.lead_time_days), (true, Some(5)));
        assert_eq!(slot(&terms.unit_cost), (false, None));
    }

    #[test]
    fn an_item_is_the_row_with_its_names() {
        let joined = json!({
            "row": { "id": "psup_1", "product_id": "prod_1", "unit_cost": "2.1250",
                     "created_at": "2026-11-18T10:00:00.5", "is_preferred": true },
            "supplierName": "Acme", "supplierCode": "AC", "supplierCurrency": "EUR",
            "supplierLeadTimeDays": 14, "productName": "Lamp", "productSku": "L-1",
        });
        assert_eq!(
            item(&joined),
            json!({
                "id": "psup_1", "productId": "prod_1", "unitCost": "2.1250",
                "createdAt": "2026-11-18T10:00:00.500Z", "isPreferred": true,
                "supplierName": "Acme", "supplierCode": "AC", "supplierCurrency": "EUR",
                "supplierLeadTimeDays": 14, "productName": "Lamp", "productSku": "L-1",
            })
        );
    }
}
