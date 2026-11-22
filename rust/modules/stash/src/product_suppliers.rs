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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, Order, Query};
use sea_orm::{
    ActiveValue, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PRODUCT_SUPPLIER_CREATED, PRODUCT_SUPPLIER_DELETED, PRODUCT_SUPPLIER_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    SUPPLIERS_CREATE, SUPPLIERS_DELETE, SUPPLIERS_READ, SUPPLIERS_UPDATE,
};
use weldsuite_db::{OrmConn, orm};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::product_suppliers::{ActiveModel, Column, Entity, Model};
use weldsuite_schema::tenant::{product_variants, products, suppliers};

use crate::js::{number_text, query_set};
use crate::{Caller, Refusal, StashState, internal, validate};

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

/// A link with its names (left joins): its supplier's name, code,
/// currency and default lead time, its product's name and SKU.
#[derive(Debug, FromQueryResult)]
struct Linked {
    #[sea_orm(nested)]
    row: Model,
    supplier_name: Option<String>,
    supplier_code: Option<String>,
    supplier_currency: Option<String>,
    supplier_lead_time_days: Option<i32>,
    product_name: Option<String>,
    product_sku: Option<String>,
}

/// `{ ...row, supplierName, supplierCode, supplierCurrency,
/// supplierLeadTimeDays, productName, productSku }`.
fn item(linked: Linked) -> Result<Value, DbErr> {
    let row = serde_json::to_value(linked.row).map_err(|error| DbErr::Json(error.to_string()))?;
    let mut row = match row {
        Value::Object(row) => row,
        _ => Map::new(),
    };
    for (key, value) in [
        ("supplierName", json!(linked.supplier_name)),
        ("supplierCode", json!(linked.supplier_code)),
        ("supplierCurrency", json!(linked.supplier_currency)),
        (
            "supplierLeadTimeDays",
            json!(linked.supplier_lead_time_days),
        ),
        ("productName", json!(linked.product_name)),
        ("productSku", json!(linked.product_sku)),
    ] {
        row.insert(key.to_owned(), value);
    }
    Ok(Value::Object(row))
}

/// `coalesce(variant_id, '')`: the item key's variant part.
fn variant_key() -> Expr {
    Func::coalesce([Column::VariantId.into_expr(), Expr::val("")]).into()
}

/// The live links of one product/variant (`coalesce(variant_id, '') =
/// coalesce($variant, '')`).
fn of_item(product_id: &str, variant_id: Option<&str>) -> Condition {
    use sea_orm::ExprTrait as _;
    Condition::all()
        .add(Column::ProductId.eq(product_id))
        .add(variant_key().eq(variant_id.unwrap_or("")))
        .add(Column::DeletedAt.is_null())
}

/// Which variants' links a list reads.
enum Variant<'a> {
    /// Every link, with or without a variant.
    Any,
    /// The links without a variant (`variantId=none`).
    None,
    /// The links of this variant.
    Only(&'a str),
}

/// The filters of a list.
struct Filters<'a> {
    id: Option<&'a str>,
    product_id: Option<&'a str>,
    variant: Variant<'a>,
    supplier_id: Option<&'a str>,
}

/// The live links `filters` selects, preferred first, then oldest.
async fn items<C: ConnectionTrait>(db: &C, filters: &Filters<'_>) -> Result<Vec<Value>, DbErr> {
    use sea_orm::ExprTrait as _;
    let mut condition = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(id) = filters.id {
        condition = condition.add(Column::Id.eq(id));
    }
    if let Some(product) = filters.product_id {
        condition = condition.add(Column::ProductId.eq(product));
    }
    match filters.variant {
        Variant::Any => {}
        Variant::None => condition = condition.add(variant_key().eq("")),
        Variant::Only(variant) => condition = condition.add(Column::VariantId.eq(variant)),
    }
    if let Some(supplier) = filters.supplier_id {
        condition = condition.add(Column::SupplierId.eq(supplier));
    }
    Entity::find()
        .column_as(suppliers::Column::Name, "supplier_name")
        .column_as(suppliers::Column::Code, "supplier_code")
        .column_as(suppliers::Column::Currency, "supplier_currency")
        .column_as(
            suppliers::Column::DefaultLeadTimeDays,
            "supplier_lead_time_days",
        )
        .column_as(products::Column::Name, "product_name")
        .column_as(products::Column::Sku, "product_sku")
        .join(
            JoinType::LeftJoin,
            Entity::belongs_to(suppliers::Entity)
                .from(Column::SupplierId)
                .to(suppliers::Column::Id)
                .into(),
        )
        .join(
            JoinType::LeftJoin,
            Entity::belongs_to(products::Entity)
                .from(Column::ProductId)
                .to(products::Column::Id)
                .into(),
        )
        .filter(condition)
        .order_by(Column::IsPreferred, Order::Desc)
        .order_by(Column::CreatedAt, Order::Asc)
        .order_by(Column::Id, Order::Asc)
        .into_model::<Linked>()
        .all(db)
        .await?
        .into_iter()
        .map(item)
        .collect()
}

/// The live link `id` with its names.
pub(crate) async fn find_item<C: ConnectionTrait>(
    db: &C,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let filters = Filters {
        id: Some(id),
        product_id: None,
        variant: Variant::Any,
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
            None => Variant::Any,
            Some("none") => Variant::None,
            Some(id) => Variant::Only(id),
        },
        supplier_id: supplier_id.as_deref(),
    };
    match items(&orm(&caller.db), &filters).await {
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
/// the transaction: `pg_advisory_xact_lock(hashtext('product_suppliers:'
/// || product || ':' || coalesce(variant, '')))`.
async fn lock_item<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
    variant_id: Option<&str>,
) -> Result<(), DbErr> {
    let key = format!(
        "product_suppliers:{product_id}:{}",
        variant_id.unwrap_or("")
    );
    let lock = Query::select()
        .expr(Func::cust("pg_advisory_xact_lock").arg(Func::cust("hashtext").arg(key)))
        .to_owned();
    db.execute(&lock).await?;
    Ok(())
}

/// The event data of a link row: `{ id, productId, variantId, supplierId,
/// isPreferred }`.
fn link_event(row: &Model) -> Value {
    json!({
        "id": row.id,
        "productId": row.product_id,
        "variantId": row.variant_id,
        "supplierId": row.supplier_id,
        "isPreferred": row.is_preferred,
    })
}

/// Take the preference from the item's other links; the ones that had it.
async fn unset_preferred<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
    variant_id: Option<&str>,
    except: &str,
    now: PrimitiveDateTime,
) -> Result<Vec<Value>, DbErr> {
    let rows = Entity::update_many()
        .col_expr(Column::IsPreferred, Expr::value(false))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(of_item(product_id, variant_id))
        .filter(Column::Id.ne(except))
        .filter(Column::IsPreferred.eq(true))
        .exec_with_returning(db)
        .await?;
    Ok(rows.iter().map(link_event).collect())
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
/// Whether a live row matches `condition` (`select id … where … and
/// deleted_at is null limit 1`).
async fn exists<E: EntityTrait>(
    db: &weldsuite_db::PgPool,
    id: E::Column,
    deleted_at: E::Column,
    condition: Condition,
) -> Result<bool, DbErr> {
    let found: Option<String> = E::find()
        .select_only()
        .column(id)
        .filter(condition)
        .filter(deleted_at.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `$n::numeric` of a number as JavaScript prints it.
fn decimal(number: f64) -> Result<BigDecimal, DbErr> {
    let text = number_text(number);
    text.parse()
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: \"{text}\"")))
}

/// An integer the schema bounded, as its `integer` column.
fn integer(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Type("integer out of range".to_owned()))
}

/// The new link's row.
fn new_row(
    id: &str,
    link: &NewLink,
    preferred: bool,
    now: PrimitiveDateTime,
) -> Result<ActiveModel, DbErr> {
    let terms = &link.terms;
    Ok(ActiveModel {
        id: ActiveValue::Set(id.to_owned()),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        product_id: ActiveValue::Set(link.product_id.clone()),
        variant_id: ActiveValue::Set(link.variant_id.clone()),
        supplier_id: ActiveValue::Set(link.supplier_id.clone()),
        supplier_sku: ActiveValue::Set(terms.supplier_sku.as_set().cloned()),
        supplier_product_name: ActiveValue::Set(terms.supplier_product_name.as_set().cloned()),
        unit_cost: ActiveValue::Set(terms.unit_cost.as_set().copied().map(decimal).transpose()?),
        currency: ActiveValue::Set(terms.currency.as_set().cloned()),
        lead_time_days: ActiveValue::Set(
            terms
                .lead_time_days
                .as_set()
                .copied()
                .map(integer)
                .transpose()?,
        ),
        min_order_qty: ActiveValue::Set(
            terms
                .min_order_qty
                .as_set()
                .copied()
                .map(integer)
                .transpose()?,
        ),
        order_multiple: ActiveValue::Set(integer(
            terms.order_multiple.as_set().copied().unwrap_or(1),
        )?),
        is_preferred: ActiveValue::Set(preferred),
        ..Default::default()
    })
}

/// The checks (404s, 409), then the insert with its preference, in one
/// transaction. The new item and the links that lost the preference.
async fn create_link(caller: &Caller, link: NewLink) -> Result<(Value, Vec<Value>), Refusal> {
    let db = &caller.db;
    let product = Condition::all().add(products::Column::Id.eq(link.product_id.as_str()));
    if !exists::<products::Entity>(
        db,
        products::Column::Id,
        products::Column::DeletedAt,
        product,
    )
    .await?
    {
        return Err(Refusal::not_found("Product", &link.product_id));
    }
    if let Some(variant) = &link.variant_id {
        let of_product = Condition::all()
            .add(product_variants::Column::Id.eq(variant.as_str()))
            .add(product_variants::Column::ProductId.eq(link.product_id.as_str()));
        if !exists::<product_variants::Entity>(
            db,
            product_variants::Column::Id,
            product_variants::Column::DeletedAt,
            of_product,
        )
        .await?
        {
            return Err(Refusal::not_found("Product variant", variant));
        }
    }
    let supplier = Condition::all().add(suppliers::Column::Id.eq(link.supplier_id.as_str()));
    if !exists::<suppliers::Entity>(
        db,
        suppliers::Column::Id,
        suppliers::Column::DeletedAt,
        supplier,
    )
    .await?
    {
        return Err(Refusal::not_found("Supplier", &link.supplier_id));
    }
    let id = generate_id("psup");
    let at = weldsuite_db::utc_now();
    let written = weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let variant = link.variant_id.as_deref();
            lock_item(&db, &link.product_id, variant).await?;
            let links: Vec<(String, String)> = Entity::find()
                .select_only()
                .columns([Column::Id, Column::SupplierId])
                .filter(of_item(&link.product_id, variant))
                .into_tuple()
                .all(&db)
                .await?;
            if links
                .iter()
                .any(|(_, supplier)| *supplier == link.supplier_id)
            {
                return Err(duplicate());
            }
            let preferred = links.is_empty() || link.terms.is_preferred.as_set() == Some(&true);
            let demoted = if preferred && !links.is_empty() {
                unset_preferred(&db, &link.product_id, variant, &id, at).await?
            } else {
                Vec::new()
            };
            let inserted = Entity::insert(new_row(&id, &link, preferred, at)?)
                .exec_without_returning(&db)
                .await;
            match inserted {
                Ok(_) => {}
                Err(error) if weldsuite_db::is_unique_violation(&error) => return Err(duplicate()),
                Err(error) => return Err(error.into()),
            }
            let row = find_item(&db, &id)
                .await?
                .ok_or_else(|| Refusal::not_found(RESOURCE, &id))?;
            Ok::<_, Refusal>((row, demoted))
        })
    })
    .await?;
    Ok(written)
}

/// The live link's item: its product and variant.
async fn link_key<C: ConnectionTrait>(
    db: &C,
    id: &str,
) -> Result<Option<(String, Option<String>)>, DbErr> {
    Entity::find()
        .select_only()
        .columns([Column::ProductId, Column::VariantId])
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await
}

/// Write the terms the body sent (a field left out keeps its value, a
/// null clears it) on the live link `id`; `false` when there is none.
async fn change_terms<C: ConnectionTrait>(
    db: &C,
    id: &str,
    terms: &Terms,
    now: PrimitiveDateTime,
) -> Result<bool, DbErr> {
    use sea_orm::ExprTrait as _;
    let mut update = Entity::update_many();
    if let (true, sku) = slot(&terms.supplier_sku) {
        update = update.col_expr(Column::SupplierSku, Expr::value(sku));
    }
    if let (true, name) = slot(&terms.supplier_product_name) {
        update = update.col_expr(Column::SupplierProductName, Expr::value(name));
    }
    if let (true, cost) = slot(&terms.unit_cost) {
        update = update.col_expr(
            Column::UnitCost,
            Expr::val(cost.map(number_text)).cast_as("numeric"),
        );
    }
    if let (true, currency) = slot(&terms.currency) {
        update = update.col_expr(Column::Currency, Expr::value(currency));
    }
    for (column, field) in [
        (Column::LeadTimeDays, &terms.lead_time_days),
        (Column::MinOrderQty, &terms.min_order_qty),
        (Column::OrderMultiple, &terms.order_multiple),
    ] {
        if let (true, value) = slot(field) {
            update = update.col_expr(column, Expr::val(value).cast_as("integer"));
        }
    }
    if let (true, preferred) = slot(&terms.is_preferred) {
        update = update.col_expr(Column::IsPreferred, Expr::value(preferred));
    }
    let changed = update
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(db)
        .await?;
    Ok(changed.rows_affected > 0)
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
    let at = weldsuite_db::utc_now();
    let written = weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let Some((product_id, variant_id)) = link_key(&db, &id).await? else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            lock_item(&db, &product_id, variant_id.as_deref()).await?;
            let demoted = if terms.is_preferred.as_set() == Some(&true) {
                unset_preferred(&db, &product_id, variant_id.as_deref(), &id, at).await?
            } else {
                Vec::new()
            };
            if !change_terms(&db, &id, &terms, at).await? {
                return Err(Refusal::not_found(RESOURCE, &id));
            }
            let row = find_item(&db, &id)
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

/// Pass the preference to the item's oldest live link: `update … where id =
/// (select id … order by created_at, id limit 1)`, one statement.
async fn promote_oldest<C: ConnectionTrait>(
    db: &C,
    product_id: &str,
    variant_id: Option<&str>,
    now: PrimitiveDateTime,
) -> Result<Vec<Value>, DbErr> {
    use sea_orm::ExprTrait as _;
    let oldest = Query::select()
        .column(Column::Id)
        .from(Entity)
        .cond_where(of_item(product_id, variant_id))
        .order_by(Column::CreatedAt, Order::Asc)
        .order_by(Column::Id, Order::Asc)
        .limit(1)
        .to_owned();
    let rows = Entity::update_many()
        .col_expr(Column::IsPreferred, Expr::value(true))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.into_expr().eq(Expr::from(oldest)))
        .exec_with_returning(db)
        .await?;
    Ok(rows.iter().map(link_event).collect())
}

async fn remove(
    State(state): State<StashState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete product supplier";
    let at = weldsuite_db::utc_now();
    let removed = weldsuite_db::atomically_with(&caller.db, move |conn| {
        Box::pin(async move {
            let db = OrmConn::new(conn);
            let Some((product_id, variant_id)) = link_key(&db, &id).await? else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            lock_item(&db, &product_id, variant_id.as_deref()).await?;
            // Checked again under the lock: a delete that got there first
            // answered and published already.
            let deleted = Entity::update_many()
                .col_expr(Column::DeletedAt, Expr::value(at))
                .col_expr(Column::UpdatedAt, Expr::value(at))
                .filter(Column::Id.eq(id.as_str()))
                .filter(Column::DeletedAt.is_null())
                .exec_with_returning(&db)
                .await?;
            let Some(row) = deleted.first() else {
                return Err(Refusal::not_found(RESOURCE, &id));
            };
            let promoted: Vec<Value> = if row.is_preferred {
                promote_oldest(&db, &product_id, variant_id.as_deref(), at).await?
            } else {
                Vec::new()
            };
            Ok::<_, Refusal>((link_event(row), promoted))
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
        let at = time::macros::datetime!(2026-11-18 10:00:00.5);
        let linked = Linked {
            row: Model {
                id: "psup_1".to_owned(),
                created_at: at,
                updated_at: at,
                deleted_at: None,
                product_id: "prod_1".to_owned(),
                variant_id: None,
                supplier_id: "sup_1".to_owned(),
                supplier_sku: None,
                supplier_product_name: None,
                unit_cost: Some("2.125".parse().expect("decimal")),
                currency: None,
                lead_time_days: None,
                min_order_qty: None,
                order_multiple: 1,
                is_preferred: true,
                metadata: None,
            },
            supplier_name: Some("Acme".to_owned()),
            supplier_code: Some("AC".to_owned()),
            supplier_currency: Some("EUR".to_owned()),
            supplier_lead_time_days: Some(14),
            product_name: Some("Lamp".to_owned()),
            product_sku: Some("L-1".to_owned()),
        };
        let item = item(linked).expect("item");
        assert_eq!(item["id"], json!("psup_1"));
        assert_eq!(item["productId"], json!("prod_1"));
        assert_eq!(item["unitCost"], json!("2.1250"));
        assert_eq!(item["createdAt"], json!("2026-11-18T10:00:00.500Z"));
        assert_eq!(item["isPreferred"], json!(true));
        for (key, value) in [
            ("supplierName", json!("Acme")),
            ("supplierCode", json!("AC")),
            ("supplierCurrency", json!("EUR")),
            ("supplierLeadTimeDays", json!(14)),
            ("productName", json!("Lamp")),
            ("productSku", json!("L-1")),
        ] {
            assert_eq!(item[key], value, "{key}");
        }
    }
}
