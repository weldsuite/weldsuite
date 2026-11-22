//! `POST /purchase-orders/{id}/send-to-odoo` (phase 6 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`; Rust only):
//! a draft, pending or approved purchase order whose warehouse an Odoo
//! connection manages becomes an RFQ in Odoo.
//!
//! The RFQ is a `purchase.order` for the supplier's Odoo vendor (the
//! `odoo_supplier` mapping), received through the warehouse's receipt
//! operation (`stock.warehouse.in_type_id`), with `date_planned` from the
//! expected date, `origin = 'WeldStash <PO number> [<PO id>]'` (the id
//! because PO numbers need not be unique), and one line per item
//! (the `odoo_product` mapping, the ordered quantity in the product's unit,
//! the unit price). It stays an RFQ: the buyer confirms it in Odoo, and the
//! `odoo-purchase-orders` sync keeps the purchase order current from then
//! on, so WeldStash treats it as Odoo's ([`crate::po_guard`]).
//!
//! Retry-safe and one at a time: the push holds the purchase order's row
//! lock (`select … for update`) from its checks to its last write, so a
//! second request for the same order waits, then finds it sent (400); and
//! before creating, it looks for an RFQ with exactly that `origin`, so a
//! retry after a failure between Odoo's answer and the database write
//! reuses the RFQ instead of making a second. The `create` itself is sent
//! once (the client never retries a write): when its answer is lost (a
//! timeout, a proxy's 5xx) Odoo may have made the RFQ anyway, so the push
//! looks for it by `origin` once more and adopts it, else fails; the next
//! push looks first. Then it stores
//! the `odoo_purchase_order` mapping, each item's Odoo line id
//! (`metadata.odooLineId`, how the sync matches lines) and
//! `metadata.odoo = { id, name, sentAt }`, and sets the status to `pending`.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, JoinType, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_catalogs::entity_events::PURCHASE_ORDER_UPDATED;
use weldsuite_catalogs::permission_keys::PURCHASE_ORDERS_UPDATE;
use weldsuite_connect_domain::clients::{ConnectorError, Kind, decrypt_credentials};
use weldsuite_connect_domain::odoo::{Odoo, mapping_types};
use weldsuite_db::{Keyring, OrmConn, PgPool, orm, utc_now};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{
    connector_connections as connections, integration_entity_mappings as mappings,
    purchase_order_items as items, purchase_orders as orders, warehouses,
};

use crate::po_actions::{lock_order, order_json};
use crate::po_guard::is_odoo_managed;
use crate::{Caller, Refusal, StashState, now};

const ORDER: &str = "Purchase order";
const NOT_MANAGED: &str = "This purchase order's warehouse is not managed by an Odoo connection";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<StashState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/{id}/send-to-odoo",
        post(send).route_layer(gate.require([PURCHASE_ORDERS_UPDATE])),
    )
}

async fn send(State(state): State<StashState>, caller: Caller, Path(id): Path<String>) -> Response {
    let http = caller.http(&state);
    let keyring = weldsuite_connect_domain::connections::keyring(
        caller.env("DATABASE_ENCRYPTION_KEY"),
        caller.env("DATABASE_ENCRYPTION_KEY_V2"),
    );
    match send_to_odoo(&caller.db, http.as_ref(), &keyring, &id).await {
        Ok(sent) => {
            let order = &sent.purchase_order;
            caller.publish(
                &state,
                PURCHASE_ORDER_UPDATED,
                &id,
                &json!({
                    "id": id,
                    "poNumber": order["poNumber"],
                    "status": order["status"],
                    "supplierId": order["supplierId"],
                }),
            );
            Data(json!({
                "purchaseOrder": sent.purchase_order,
                "odoo": { "id": sent.odoo_id, "name": sent.odoo_name },
            }))
            .into_response()
        }
        Err(refusal) => refusal.respond("Failed to send the purchase order to Odoo"),
    }
}

/// What the push did.
#[derive(Debug)]
pub(crate) struct Sent {
    /// The purchase order row after the push.
    pub(crate) purchase_order: Value,
    pub(crate) odoo_id: i64,
    pub(crate) odoo_name: String,
}

/// An item as the push reads it.
struct Item {
    id: String,
    product_id: Option<String>,
    variant_id: Option<String>,
    label: String,
    quantity: i32,
    unit_price: f64,
}

/// The Odoo id a WeldStash row is mapped to by this connection.
async fn odoo_id_of<C: ConnectionTrait>(
    db: &C,
    connection_id: &str,
    external_type: &str,
    internal_type: &str,
    internal_id: &str,
) -> Result<Option<i64>, DbErr> {
    let found: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::ExternalEntityId)
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .filter(mappings::Column::InternalEntityType.eq(internal_type))
        .filter(mappings::Column::InternalEntityId.eq(internal_id))
        .order_by_desc(mappings::Column::UpdatedAt)
        .into_tuple()
        .one(db)
        .await?;
    Ok(found.and_then(|id| id.parse().ok()))
}

/// An Odoo datetime (`YYYY-MM-DD HH:MM:SS`, UTC) from a row's ISO timestamp.
fn odoo_datetime(iso: &str) -> Option<String> {
    let head = iso.get(..19)?;
    (head.as_bytes().get(10) == Some(&b'T')).then(|| head.replacen('T', " ", 1))
}

/// An Odoo failure as the answer: rejected credentials put the connection
/// in `auth_error` (as a sync does), missing rights are written on the
/// connection as its last error; both are a 400 with Odoo's reason, an
/// unreachable or overloaded Odoo a 502.
async fn odoo_refusal(db: &PgPool, connection_id: &str, error: ConnectorError) -> Refusal {
    match error.kind {
        Kind::Auth => {
            if let Err(db_error) = weldsuite_connect_domain::sync::mark_connection_error(
                db,
                connection_id,
                "auth_error",
                &error.message,
            )
            .await
            {
                tracing::warn!(error = %db_error, "[stash/odoo-push] could not mark the connection");
            }
            Refusal::bad_request(error.message)
        }
        Kind::Permanent => {
            let now = utc_now();
            let noted = connections::Entity::update_many()
                .col_expr(
                    connections::Column::LastError,
                    Expr::value(error.message.as_str()),
                )
                .col_expr(connections::Column::LastErrorAt, Expr::value(now))
                .col_expr(connections::Column::UpdatedAt, Expr::value(now))
                .filter(connections::Column::Id.eq(connection_id))
                .exec(&orm(db))
                .await;
            if let Err(db_error) = noted {
                tracing::warn!(error = %db_error, "[stash/odoo-push] could not note the error");
            }
            Refusal::bad_request(error.message)
        }
        Kind::RateLimit | Kind::Transient => Refusal::Response(Box::new(
            ApiError::bad_gateway()
                .with_message(error.message)
                .into_response(),
        )),
    }
}

/// `purchase_order_items` as the push reads them.
type ItemRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    i32,
    sea_orm::prelude::BigDecimal,
);

/// Everything the RFQ needs, checked before Odoo is called.
struct Prepared {
    order: Value,
    /// The connection's stored (encrypted) credentials.
    credentials: Option<Value>,
    connection_id: String,
    odoo_warehouse: i64,
    partner: i64,
    items: Vec<Item>,
    /// Each item's Odoo product, in item order.
    products: Vec<i64>,
}

/// Sends purchase order `id` to Odoo as an RFQ.
pub(crate) async fn send_to_odoo(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    keyring: &Keyring,
    id: &str,
) -> Result<Sent, Refusal> {
    let mut tx = db.begin().await?;
    let prepared = prepare(&mut tx, id).await?;
    let credentials = decrypt_credentials(prepared.credentials.as_ref(), keyring);
    let client = match Odoo::from_credentials(&credentials) {
        Ok(client) => client,
        Err(error) => {
            tx.rollback().await?;
            return Err(odoo_refusal(db, &prepared.connection_id, error).await);
        }
    };
    let origin = rfq_origin(&prepared.order, id);
    let created = create_rfq(
        &client,
        http,
        &Rfq {
            origin: &origin,
            partner: prepared.partner,
            warehouse: prepared.odoo_warehouse,
            date_planned: prepared.order["expectedDate"]
                .as_str()
                .and_then(odoo_datetime),
            items: &prepared.items,
            products: &prepared.products,
        },
    )
    .await;
    match created {
        Ok((odoo_id, odoo_name, line_ids)) => {
            let sent = record(&mut tx, id, &prepared, odoo_id, odoo_name, &line_ids).await?;
            tx.commit().await?;
            Ok(sent)
        }
        Err(error) => {
            tx.rollback().await?;
            Err(odoo_refusal(db, &prepared.connection_id, error).await)
        }
    }
}

/// The RFQ's `origin`: the PO number for the buyer, the PO id to tell two
/// purchase orders with one number apart (the retry matches it exactly).
fn rfq_origin(order: &Value, id: &str) -> String {
    let number = order["poNumber"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or(id);
    format!("WeldStash {number} [{id}]")
}

/// The purchase order (its row locked until the transaction ends), its
/// Odoo connection and its mappings, or why it cannot be sent. Checked
/// after taking the lock, so a request that waited on another sees it sent.
async fn prepare(conn: &mut PgConnection, id: &str) -> Result<Prepared, Refusal> {
    let db = &OrmConn::new(conn);
    let order = lock_order(db, id).await?;
    if is_odoo_managed(&order) {
        return Err(Refusal::bad_request(
            "This purchase order was already sent to Odoo",
        ));
    }
    let status = order["status"].as_str().unwrap_or("draft");
    if !matches!(status, "draft" | "pending" | "approved") {
        return Err(Refusal::bad_request(format!(
            "Only a draft, pending or approved purchase order can be sent to Odoo (this one is {status})"
        )));
    }
    let Some(warehouse_id) = order["warehouseId"].as_str().filter(|w| !w.is_empty()) else {
        return Err(Refusal::bad_request(NOT_MANAGED));
    };
    let connection = connections::Entity::find()
        .join(
            JoinType::InnerJoin,
            connections::Entity::belongs_to(warehouses::Entity)
                .from(connections::Column::Id)
                .to(warehouses::Column::ManagedByConnectionId)
                .into(),
        )
        .filter(connections::Column::DeletedAt.is_null())
        .filter(connections::Column::Provider.eq("odoo"))
        .filter(warehouses::Column::Id.eq(warehouse_id))
        .filter(warehouses::Column::DeletedAt.is_null())
        .one(db)
        .await?;
    let Some(connection) = connection else {
        return Err(Refusal::bad_request(NOT_MANAGED));
    };
    let connection_id = connection.id;
    let Some(odoo_warehouse) = odoo_id_of(
        db,
        &connection_id,
        mapping_types::WAREHOUSE,
        "warehouse",
        warehouse_id,
    )
    .await?
    else {
        return Err(Refusal::bad_request(NOT_MANAGED));
    };
    let supplier = order["supplierId"].as_str().filter(|s| !s.is_empty());
    let partner = match supplier {
        Some(supplier) => {
            odoo_id_of(
                db,
                &connection_id,
                mapping_types::SUPPLIER,
                "supplier",
                supplier,
            )
            .await?
        }
        None => None,
    };
    let Some(partner) = partner else {
        let name = order["supplierName"]
            .as_str()
            .unwrap_or("The purchase order");
        return Err(Refusal::bad_request(format!(
            "{name} has no Odoo vendor: sync suppliers from Odoo, or pick a supplier that came from Odoo"
        )));
    };

    let (items, products) = resolve_items(db, &connection_id, id).await?;
    Ok(Prepared {
        order,
        credentials: connection.credentials,
        connection_id,
        odoo_warehouse,
        partner,
        items,
        products,
    })
}

/// The items, each with its Odoo product, or the 400 that lists the ones
/// without (by SKU, else name).
async fn resolve_items<C: ConnectionTrait>(
    db: &C,
    connection_id: &str,
    id: &str,
) -> Result<(Vec<Item>, Vec<i64>), Refusal> {
    let rows: Vec<ItemRow> = items::Entity::find()
        .select_only()
        .columns([
            items::Column::Id,
            items::Column::ProductId,
            items::Column::VariantId,
            items::Column::Sku,
            items::Column::Name,
            items::Column::QuantityOrdered,
            items::Column::UnitPrice,
        ])
        .filter(items::Column::PurchaseOrderId.eq(id))
        .order_by_asc(items::Column::CreatedAt)
        .order_by_asc(items::Column::Id)
        .into_tuple()
        .all(db)
        .await?;
    if rows.is_empty() {
        return Err(Refusal::bad_request(
            "The purchase order has no lines to send to Odoo",
        ));
    }
    let items: Vec<Item> = rows
        .into_iter()
        .map(
            |(id, product_id, variant_id, sku, name, quantity, price)| Item {
                id,
                product_id,
                variant_id,
                label: sku.filter(|s| !s.is_empty()).unwrap_or(name),
                quantity,
                // `unit_price::text`, read as a JavaScript number.
                unit_price: price.to_plain_string().parse().unwrap_or(0.0),
            },
        )
        .collect();
    let mut products = Vec::new();
    let mut missing = Vec::new();
    for item in &items {
        let mapped = match (&item.variant_id, &item.product_id) {
            (Some(variant), _) => {
                odoo_id_of(
                    db,
                    connection_id,
                    mapping_types::PRODUCT,
                    "product_variant",
                    variant,
                )
                .await?
            }
            (None, Some(product)) => {
                odoo_id_of(
                    db,
                    connection_id,
                    mapping_types::PRODUCT,
                    "product",
                    product,
                )
                .await?
            }
            (None, None) => None,
        };
        match mapped {
            Some(product) => products.push(product),
            None => missing.push(item.label.clone()),
        }
    }
    if !missing.is_empty() {
        missing.dedup();
        return Err(Refusal::bad_request(format!(
            "These products have no Odoo product: {}",
            missing.join(", ")
        )));
    }
    Ok((items, products))
}

/// The push's trail: the mapping, the items' Odoo line ids, the purchase
/// order's `metadata.odoo` and status, in the push's transaction.
async fn record(
    tx: &mut PgConnection,
    id: &str,
    prepared: &Prepared,
    odoo_id: i64,
    odoo_name: String,
    line_ids: &[i64],
) -> Result<Sent, Refusal> {
    let db = &OrmConn::new(tx);
    let connection_id = &prepared.connection_id;
    let items = &prepared.items;
    let mapping = mappings::ActiveModel {
        id: ActiveValue::Set(generate_id("iem")),
        connection_id: ActiveValue::Set(connection_id.clone()),
        external_entity_type: ActiveValue::Set(mapping_types::PURCHASE_ORDER.to_owned()),
        external_entity_id: ActiveValue::Set(odoo_id.to_string()),
        internal_entity_type: ActiveValue::Set("purchase_order".to_owned()),
        internal_entity_id: ActiveValue::Set(id.to_owned()),
        last_synced_at: ActiveValue::Set(Some(utc_now())),
        ..Default::default()
    };
    mappings::Entity::insert(mapping)
        .on_conflict(
            OnConflict::columns([
                mappings::Column::ConnectionId,
                mappings::Column::ExternalEntityType,
                mappings::Column::ExternalEntityId,
            ])
            .update_columns([
                mappings::Column::InternalEntityType,
                mappings::Column::InternalEntityId,
                mappings::Column::LastSyncedAt,
            ])
            .value(
                mappings::Column::UpdatedAt,
                Expr::col((
                    sea_orm::sea_query::Alias::new("excluded"),
                    mappings::Column::LastSyncedAt,
                )),
            )
            .to_owned(),
        )
        .exec_without_returning(db)
        .await?;
    // `coalesce(metadata, '{}'::jsonb) || <object>`.
    let merged = |column: Expr, object: Value| {
        sea_orm::sea_query::extension::postgres::PgExpr::concat(
            Expr::from(Func::coalesce([column, Expr::val(json!({}))])),
            Expr::val(object),
        )
    };
    // Odoo keeps the lines in the order they were sent (`sequence, id`).
    if line_ids.len() == items.len() {
        for (item, line) in items.iter().zip(line_ids) {
            items::Entity::update_many()
                .col_expr(
                    items::Column::Metadata,
                    merged(
                        items::Column::Metadata.into_expr(),
                        json!({ "odooLineId": line.to_string() }),
                    ),
                )
                .col_expr(items::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(items::Column::Id.eq(item.id.as_str()))
                .exec(db)
                .await?;
        }
    }
    let odoo = json!({ "id": odoo_id, "name": odoo_name, "sentAt": now() });
    let updated = orders::Entity::update_many()
        .col_expr(orders::Column::Status, Expr::value("pending"))
        .col_expr(orders::Column::UpdatedAt, Expr::value(utc_now()))
        .col_expr(
            orders::Column::Metadata,
            merged(orders::Column::Metadata.into_expr(), json!({ "odoo": odoo })),
        )
        .filter(orders::Column::Id.eq(id))
        .exec_with_returning(db)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound(format!("purchase order {id}")))?;
    Ok(Sent {
        purchase_order: order_json(updated)?,
        odoo_id,
        odoo_name,
    })
}

/// What the RFQ is made of.
struct Rfq<'a> {
    origin: &'a str,
    partner: i64,
    warehouse: i64,
    date_planned: Option<String>,
    items: &'a [Item],
    /// Each item's Odoo product, in item order.
    products: &'a [i64],
}

/// The RFQ with exactly this `origin`, the oldest if there are several.
async fn rfq_by_origin(
    client: &Odoo,
    http: Option<&OutboundHttp>,
    origin: &str,
) -> Result<Option<i64>, ConnectorError> {
    let found = client
        .search(
            http,
            "purchase.order",
            json!([["origin", "=", origin]]),
            Some(1),
            Some("id asc"),
            None,
        )
        .await?;
    Ok(found.first().copied())
}

/// Finds the RFQ an earlier attempt made (by `origin`), or creates it; then
/// its name and line ids.
async fn create_rfq(
    client: &Odoo,
    http: Option<&OutboundHttp>,
    rfq: &Rfq<'_>,
) -> Result<(i64, String, Vec<i64>), ConnectorError> {
    let odoo_id = if let Some(found) = rfq_by_origin(client, http, rfq.origin).await? {
        found
    } else {
        let warehouses = client
            .read(
                http,
                "stock.warehouse",
                &[rfq.warehouse],
                &["in_type_id".to_owned()],
                None,
            )
            .await?;
        let receipts = warehouses
            .first()
            .and_then(|w| weldsuite_connect_domain::odoo::mappers::m2o_id(&w["in_type_id"]));
        // Quantities are in the product's own unit; Odoo would otherwise
        // default a line to the purchase unit (`uom_po_id`, 16–18).
        let mut unique = rfq.products.to_vec();
        unique.sort_unstable();
        unique.dedup();
        let units: std::collections::HashMap<i64, i64> = client
            .read(
                http,
                "product.product",
                &unique,
                &["uom_id".to_owned()],
                None,
            )
            .await?
            .iter()
            .filter_map(|p| {
                Some((
                    p["id"].as_i64()?,
                    weldsuite_connect_domain::odoo::mappers::m2o_id(&p["uom_id"])?,
                ))
            })
            .collect();
        let line_fields = client.fields(http, "purchase.order.line").await?;
        let unit_field = if line_fields.contains("product_uom_id") {
            "product_uom_id"
        } else {
            "product_uom"
        };
        let lines: Vec<Value> = rfq
            .items
            .iter()
            .zip(rfq.products)
            .map(|(item, product)| {
                let mut line = serde_json::Map::new();
                line.insert("product_id".to_owned(), json!(product));
                line.insert("product_qty".to_owned(), json!(item.quantity));
                line.insert("price_unit".to_owned(), json!(item.unit_price));
                if let Some(unit) = units.get(product) {
                    line.insert(unit_field.to_owned(), json!(unit));
                }
                if let Some(date) = &rfq.date_planned {
                    line.insert("date_planned".to_owned(), json!(date));
                }
                json!([0, 0, Value::Object(line)])
            })
            .collect();
        let mut values = serde_json::Map::new();
        values.insert("partner_id".to_owned(), json!(rfq.partner));
        values.insert("origin".to_owned(), json!(rfq.origin));
        if let Some(receipts) = receipts {
            values.insert("picking_type_id".to_owned(), json!(receipts));
        }
        if let Some(date) = &rfq.date_planned {
            values.insert("date_planned".to_owned(), json!(date));
        }
        values.insert("order_line".to_owned(), Value::Array(lines));
        match client
            .create(http, "purchase.order", Value::Object(values))
            .await
        {
            Ok(id) => id,
            // The answer was lost (a timeout, a proxy's 5xx), not
            // necessarily the RFQ: adopt it if Odoo made it.
            Err(error) if error.kind == Kind::Transient => {
                match rfq_by_origin(client, http, rfq.origin).await {
                    Ok(Some(found)) => found,
                    Ok(None) | Err(_) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        }
    };
    let back = client
        .read(
            http,
            "purchase.order",
            &[odoo_id],
            &["name".to_owned(), "order_line".to_owned()],
            None,
        )
        .await?;
    let record = back.first().cloned().unwrap_or(Value::Null);
    let name = record["name"]
        .as_str()
        .map_or_else(|| format!("RFQ {odoo_id}"), str::to_owned);
    let line_ids = weldsuite_connect_domain::odoo::mappers::odoo_ids(&record["order_line"]);
    Ok((odoo_id, name, line_ids))
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test fixtures")]
mod tests {
    #![allow(clippy::unwrap_used, clippy::too_many_lines)]

    use std::sync::Arc;

    use serde_json::{Value, json};
    use sqlx::PgPool;
    use weldsuite_connect_domain::odoo::fake::FakeOdoo;
    use weldsuite_db::Keyring;

    use super::*;

    async fn tenant() -> Option<PgPool> {
        let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
        Some(
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(2)
                .connect(&url)
                .await
                .unwrap(),
        )
    }

    fn suffix() -> String {
        generate_id("t").chars().rev().take(10).collect()
    }

    async fn exec(db: &PgPool, sql: &'static str, binds: &[&str]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(db).await.unwrap();
    }

    async fn map(
        db: &PgPool,
        conn: &str,
        external_type: &str,
        external_id: &str,
        internal_type: &str,
        internal_id: &str,
    ) {
        let id = generate_id("iem");
        exec(
            db,
            "insert into integration_entity_mappings (id, connection_id, external_entity_type, external_entity_id,
               internal_entity_type, internal_entity_id) values ($1, $2, $3, $4, $5, $6)",
            &[&id, conn, external_type, external_id, internal_type, internal_id],
        )
        .await;
    }

    async fn message(refusal: Refusal) -> (u16, String) {
        let response = refusal.respond("x");
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        (
            status,
            body["error"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )
    }

    async fn sent(result: Result<Sent, Refusal>) -> Sent {
        match result {
            Ok(sent) => sent,
            Err(refusal) => panic!("refused: {:?}", message(refusal).await),
        }
    }

    struct Setup {
        conn: String,
        warehouse: String,
        supplier: String,
        product: String,
    }

    async fn setup(db: &PgPool, s: &str) -> Setup {
        let conn = format!("conn_push_{s}");
        let warehouse = format!("wh_push_{s}");
        let supplier = format!("sup_push_{s}");
        let product = format!("prod_push_{s}");
        exec(
            db,
            "insert into connector_connections (id, provider, display_name, status, credentials, external_account_id, enabled_syncs)
             values ($1, 'odoo', 'Odoo', 'active', jsonb_build_object('url', $2::text, 'database', 'acme', 'login', 'api@acme.test', 'apiKey', 'secret'), $2, '[]'::jsonb)",
            &[&conn, &format!("https://push-{s}.odoo.com")],
        )
        .await;
        exec(db, "insert into warehouses (id, name, code, managed_by_connection_id) values ($1, 'San Francisco', 'WH', $2)", &[&warehouse, &conn]).await;
        exec(
            db,
            "insert into suppliers (id, name) values ($1, 'Azure Interior')",
            &[&supplier],
        )
        .await;
        exec(
            db,
            "insert into products (id, name, slug, sku) values ($1, 'Desk lamp', 'desk-lamp', $2)",
            &[&product, &format!("LAMP-{s}")],
        )
        .await;
        map(db, &conn, "odoo_warehouse", "1", "warehouse", &warehouse).await;
        map(db, &conn, "odoo_supplier", "14", "supplier", &supplier).await;
        map(db, &conn, "odoo_product", "10", "product", &product).await;
        Setup {
            conn,
            warehouse,
            supplier,
            product,
        }
    }

    async fn order(
        db: &PgPool,
        setup: &Setup,
        number: &str,
        lines: &[(Option<&str>, &str, i32)],
    ) -> String {
        let id = generate_id("po");
        exec(
            db,
            "insert into purchase_orders (id, po_number, supplier_id, supplier_name, warehouse_id, status, expected_date)
             values ($1, $2, $3, 'Azure Interior', $4, 'approved', '2026-12-01 00:00:00')",
            &[&id, number, &setup.supplier, &setup.warehouse],
        )
        .await;
        for (product, sku, quantity) in lines {
            let item = generate_id("poi");
            sqlx::query(
                "insert into purchase_order_items (id, purchase_order_id, product_id, sku, name, quantity_ordered, unit_price, total)
                 values ($1, $2, $3, $4, 'Line', $5, 10.5, 0)",
            )
            .bind(&item)
            .bind(&id)
            .bind(*product)
            .bind(*sku)
            .bind(*quantity)
            .execute(db)
            .await
            .unwrap();
        }
        id
    }

    fn fake() -> Arc<FakeOdoo> {
        let fake = Arc::new(FakeOdoo::new(17));
        fake.add("stock.warehouse", vec![json!({ "id": 1, "name": "San Francisco", "in_type_id": [7, "San Francisco: Receipts"] })]);
        fake.add(
            "product.product",
            vec![json!({ "id": 10, "name": "Desk lamp", "uom_id": [1, "Units"] })],
        );
        fake.fields(
            "purchase.order",
            &[
                "name",
                "origin",
                "partner_id",
                "picking_type_id",
                "date_planned",
                "order_line",
                "state",
            ],
        );
        fake.fields(
            "purchase.order.line",
            &[
                "order_id",
                "product_id",
                "product_qty",
                "price_unit",
                "product_uom",
                "date_planned",
            ],
        );
        fake
    }

    #[tokio::test]
    async fn an_approved_order_becomes_an_rfq_once() {
        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let number = format!("PO-{s}");
        let po = order(&db, &setup, &number, &[(Some(&setup.product), "LAMP", 24)]).await;
        let fake = fake();
        let http = fake.http();
        let sent = sent(send_to_odoo(&db, Some(&http), &Keyring::default(), &po).await).await;

        let created = fake.all("purchase.order");
        assert_eq!(created.len(), 1);
        let rfq = &created[0];
        assert_eq!(rfq["partner_id"], json!(14));
        assert_eq!(rfq["picking_type_id"], json!(7));
        assert_eq!(rfq["origin"], json!(format!("WeldStash {number} [{po}]")));
        assert_eq!(rfq["date_planned"], json!("2026-12-01 00:00:00"));
        let lines = fake.all("purchase.order.line");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["product_id"], json!(10));
        assert_eq!(lines[0]["product_qty"], json!(24));
        assert_eq!(lines[0]["price_unit"], json!(10.5));
        assert_eq!(lines[0]["product_uom"], json!(1));

        assert_eq!(sent.odoo_id, 1);
        assert_eq!(sent.odoo_name, "P00001");
        assert_eq!(sent.purchase_order["status"], json!("pending"));
        assert_eq!(sent.purchase_order["metadata"]["odoo"]["id"], json!(1));
        assert_eq!(
            sent.purchase_order["metadata"]["odoo"]["name"],
            json!("P00001")
        );
        assert!(sent.purchase_order["metadata"]["odoo"]["sentAt"].is_string());
        let mapped: String = sqlx::query_scalar(
            "select internal_entity_id from integration_entity_mappings
             where connection_id = $1 and external_entity_type = 'odoo_purchase_order' and external_entity_id = '1'",
        )
        .bind(&setup.conn)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(mapped, po);
        let line_id: Option<String> = sqlx::query_scalar(
            "select metadata->>'odooLineId' from purchase_order_items where purchase_order_id = $1",
        )
        .bind(&po)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(line_id.as_deref(), Some("1"));

        // Sent once: a second push is refused and makes nothing in Odoo.
        let again = send_to_odoo(&db, Some(&http), &Keyring::default(), &po)
            .await
            .expect_err("refused");
        assert_eq!(
            message(again).await,
            (
                400,
                "This purchase order was already sent to Odoo".to_owned()
            )
        );
        assert_eq!(fake.all("purchase.order").len(), 1);
    }

    #[tokio::test]
    async fn two_pushes_at_once_make_one_rfq() {
        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let po = order(
            &db,
            &setup,
            &format!("PO-{s}"),
            &[(Some(&setup.product), "LAMP", 3)],
        )
        .await;
        let fake = fake();
        let http = fake.http();
        let keyring = Keyring::default();
        let (first, second) = tokio::join!(
            send_to_odoo(&db, Some(&http), &keyring, &po),
            send_to_odoo(&db, Some(&http), &keyring, &po),
        );
        let (sent, refused) = match (first, second) {
            (Ok(sent), Err(refused)) | (Err(refused), Ok(sent)) => (sent, refused),
            (Ok(_), Ok(_)) => panic!("both pushes created an RFQ"),
            (Err(a), Err(b)) => panic!(
                "both refused: {:?} {:?}",
                message(a).await,
                message(b).await
            ),
        };
        assert_eq!(sent.odoo_id, 1);
        assert_eq!(
            message(refused).await,
            (
                400,
                "This purchase order was already sent to Odoo".to_owned()
            )
        );
        assert_eq!(fake.all("purchase.order").len(), 1);
    }

    #[tokio::test]
    async fn a_retry_reuses_the_rfq_it_finds() {
        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let number = format!("PO-{s}");
        let po = order(&db, &setup, &number, &[(Some(&setup.product), "LAMP", 5)]).await;
        let fake = fake();
        // An earlier attempt created it, then failed before the database write.
        fake.add("purchase.order", vec![json!({ "id": 41, "name": "P00041", "origin": format!("WeldStash {number} [{po}]"), "order_line": [77] })]);
        // Another purchase order with the same number: not this one's RFQ.
        fake.add("purchase.order", vec![json!({ "id": 40, "name": "P00040", "origin": format!("WeldStash {number} [po_other]"), "order_line": [76] })]);
        let http = fake.http();
        let sent = sent(send_to_odoo(&db, Some(&http), &Keyring::default(), &po).await).await;
        assert_eq!((sent.odoo_id, sent.odoo_name.as_str()), (41, "P00041"));
        assert_eq!(fake.all("purchase.order").len(), 2);
        assert!(!fake.calls().iter().any(|(_, method)| method == "create"));
    }

    #[tokio::test]
    async fn a_lost_answer_adopts_the_rfq_odoo_made() {
        use weldsuite_connect_domain::odoo::fake::CreateFailure;

        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let number = format!("PO-{s}");
        let po = order(&db, &setup, &number, &[(Some(&setup.product), "LAMP", 6)]).await;
        let fake = fake();
        // Odoo commits the RFQ, the proxy in front answers 502.
        fake.failing_creates
            .lock()
            .unwrap()
            .push_back(CreateFailure::AnswerLost);
        let http = fake.http();
        let sent = sent(send_to_odoo(&db, Some(&http), &Keyring::default(), &po).await).await;
        assert_eq!((sent.odoo_id, sent.odoo_name.as_str()), (1, "P00001"));
        assert_eq!(fake.all("purchase.order").len(), 1, "no second RFQ");
        let creates = fake
            .calls()
            .iter()
            .filter(|(_, method)| method == "create")
            .count();
        assert_eq!(creates, 1);
        assert_eq!(sent.purchase_order["status"], json!("pending"));
    }

    #[tokio::test]
    async fn a_create_odoo_never_got_fails_and_the_next_push_makes_it() {
        use weldsuite_connect_domain::odoo::fake::CreateFailure;

        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let po = order(
            &db,
            &setup,
            &format!("PO-{s}"),
            &[(Some(&setup.product), "LAMP", 2)],
        )
        .await;
        let fake = fake();
        fake.failing_creates
            .lock()
            .unwrap()
            .push_back(CreateFailure::NotMade);
        let http = fake.http();
        let keyring = Keyring::default();
        let refused = send_to_odoo(&db, Some(&http), &keyring, &po)
            .await
            .expect_err("refused");
        assert_eq!(
            message(refused).await,
            (502, "Odoo request failed (502)".to_owned())
        );
        assert_eq!(fake.all("purchase.order"), Vec::<Value>::new());
        let status: String = sqlx::query_scalar("select status from purchase_orders where id = $1")
            .bind(&po)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(status, "approved");

        let sent = sent(send_to_odoo(&db, Some(&http), &keyring, &po).await).await;
        assert_eq!(sent.odoo_id, 1);
        assert_eq!(fake.all("purchase.order").len(), 1);
    }

    #[tokio::test]
    async fn refusals_say_what_is_missing() {
        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let fake = fake();
        let http = fake.http();
        let keyring = Keyring::default();

        // A product without an Odoo product.
        let other = format!("prod_other_{s}");
        exec(
            &db,
            "insert into products (id, name, slug, sku) values ($1, 'Shade', 'shade', $2)",
            &[&other, &format!("SHADE-{s}")],
        )
        .await;
        let po = order(
            &db,
            &setup,
            &format!("PO-A-{s}"),
            &[
                (Some(&setup.product), "LAMP", 1),
                (Some(&other), "SHADE-X", 2),
            ],
        )
        .await;
        let refused = send_to_odoo(&db, Some(&http), &keyring, &po)
            .await
            .expect_err("refused");
        assert_eq!(
            message(refused).await,
            (
                400,
                "These products have no Odoo product: SHADE-X".to_owned()
            )
        );

        // A warehouse WeldStash manages itself.
        let local = format!("wh_local_{s}");
        exec(
            &db,
            "insert into warehouses (id, name, code) values ($1, 'Local', 'LOC')",
            &[&local],
        )
        .await;
        let po = order(
            &db,
            &setup,
            &format!("PO-B-{s}"),
            &[(Some(&setup.product), "LAMP", 1)],
        )
        .await;
        exec(
            &db,
            "update purchase_orders set warehouse_id = $2 where id = $1",
            &[&po, &local],
        )
        .await;
        let refused = send_to_odoo(&db, Some(&http), &keyring, &po)
            .await
            .expect_err("refused");
        assert_eq!(message(refused).await, (400, NOT_MANAGED.to_owned()));

        // A supplier without an Odoo vendor.
        let po = order(
            &db,
            &setup,
            &format!("PO-C-{s}"),
            &[(Some(&setup.product), "LAMP", 1)],
        )
        .await;
        exec(
            &db,
            "update purchase_orders set supplier_id = null where id = $1",
            &[&po],
        )
        .await;
        let refused = send_to_odoo(&db, Some(&http), &keyring, &po)
            .await
            .expect_err("refused");
        assert_eq!(
            message(refused).await.1,
            "Azure Interior has no Odoo vendor: sync suppliers from Odoo, or pick a supplier that came from Odoo"
        );

        // A status past ordering.
        let po = order(
            &db,
            &setup,
            &format!("PO-D-{s}"),
            &[(Some(&setup.product), "LAMP", 1)],
        )
        .await;
        exec(
            &db,
            "update purchase_orders set status = 'received' where id = $1",
            &[&po],
        )
        .await;
        let refused = send_to_odoo(&db, Some(&http), &keyring, &po)
            .await
            .expect_err("refused");
        assert_eq!(
            message(refused).await,
            (400, "Only a draft, pending or approved purchase order can be sent to Odoo (this one is received)".to_owned())
        );

        // Unknown.
        let refused = send_to_odoo(&db, Some(&http), &keyring, "po_nope")
            .await
            .expect_err("refused");
        assert_eq!(message(refused).await.0, 404);
        assert_eq!(fake.all("purchase.order"), Vec::<Value>::new());
    }

    #[tokio::test]
    async fn missing_purchase_rights_show_on_the_connection() {
        let Some(db) = tenant().await else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let s = suffix();
        let setup = setup(&db, &s).await;
        let po = order(
            &db,
            &setup,
            &format!("PO-{s}"),
            &[(Some(&setup.product), "LAMP", 1)],
        )
        .await;
        let fake = Arc::new(FakeOdoo {
            forbidden: vec!["purchase.order".to_owned()],
            ..FakeOdoo::new(19)
        });
        let http = fake.http();
        let refused = send_to_odoo(&db, Some(&http), &Keyring::default(), &po)
            .await
            .expect_err("refused");
        let (status, text) = message(refused).await;
        assert_eq!(status, 400);
        assert!(
            text.starts_with(
                "The Odoo user has no access to purchase.order: give it Purchase access rights."
            ),
            "{text}"
        );
        let noted: (String, Option<String>) =
            sqlx::query_as("select status, last_error from connector_connections where id = $1")
                .bind(&setup.conn)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(noted.0, "active");
        assert_eq!(noted.1.as_deref(), Some(text.as_str()));
        let order: Value =
            sqlx::query_scalar("select to_jsonb(p) from purchase_orders p where id = $1")
                .bind(&po)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(order["status"], json!("approved"));
        assert!(order["metadata"].is_null());
    }
}
