//! `POST /api/connectors/connections/:id/picqer/push`
//! (`services/connectors/publish-picqer.ts`): push one WeldSuite record to
//! Picqer: a person (customer), an order, a supplier, a warehouse, a
//! purchase order, a return, or a stock change.
//!
//! Each push builds the body Picqer gets, hashes it (`sha256` of
//! `JSON.stringify(body)`) and skips the call when the record's mapping
//! (`integration_entity_mappings`) already carries that hash. The bodies are
//! serialised in the TypeScript object's key order, `undefined` left out, so
//! the stored hashes match the ones Global writes.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_connect_domain::clients::{
    ConnectorError, Kind, Picqer, StoreClient, allows_outbound, decrypt_credentials,
    product_write_client,
};
use weldsuite_connect_domain::connections::get_connection;
use weldsuite_connect_domain::js::number_value;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_kit::{ApiError, Data};
use weldsuite_ports::OutboundHttp;

use crate::{Caller, ConnectState, now, validate};

/// `picqerPushSchema`'s entities.
const ENTITIES: &[&str] = &[
    "person",
    "order",
    "supplier",
    "warehouse",
    "purchase_order",
    "return",
    "inventory",
];

/// Why a push stopped: the provider's (or the push's own) error, or a
/// statement that failed.
enum PushError {
    Connector(ConnectorError),
    Database(sqlx::Error),
}

impl From<ConnectorError> for PushError {
    fn from(error: ConnectorError) -> Self {
        Self::Connector(error)
    }
}

impl From<sqlx::Error> for PushError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

fn permanent(message: &str, status: u16) -> PushError {
    PushError::Connector(ConnectorError::new(message, status, Kind::Permanent))
}

/// `connectorErrorResponse(c, err)`.
fn error_response(error: &PushError) -> Response {
    if let PushError::Connector(error) = error {
        match error.kind {
            Kind::Auth => {
                return ApiError::bad_request(
                    "Connector authorisation was rejected — check the stored credentials",
                )
                .into_response();
            }
            Kind::RateLimit => {
                return (
                    http::StatusCode::TOO_MANY_REQUESTS,
                    axum::Json(json!({ "error": {
                        "code": "RATE_LIMITED",
                        "message": "Connector provider is rate limiting — try again shortly",
                    }})),
                )
                    .into_response();
            }
            Kind::Permanent => return ApiError::bad_request(error.message.clone()).into_response(),
            Kind::Transient => {}
        }
    }
    ApiError::internal()
        .with_message("Connector request failed")
        .into_response()
}

// ── the body, in JavaScript's key order ──────────────────────────────────────

/// An object literal as `JSON.stringify` writes it: keys in the order they
/// were set, `undefined` (`None`) left out.
#[derive(Default)]
struct Ordered(Vec<(&'static str, String)>);

impl Ordered {
    fn set(mut self, key: &'static str, value: Option<Value>) -> Self {
        if let Some(value) = value {
            self.0.push((key, value.to_string()));
        }
        self
    }

    fn raw(mut self, key: &'static str, json: String) -> Self {
        self.0.push((key, json));
        self
    }

    fn text(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(key, value)| format!("{}:{value}", Value::from(*key)))
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

/// A list of objects, as `JSON.stringify` writes it.
fn list(items: &[Ordered]) -> String {
    let items: Vec<String> = items.iter().map(Ordered::text).collect();
    format!("[{}]", items.join(","))
}

/// `value || undefined` for a text column.
fn or_undefined(row: &Value, key: &str) -> Option<Value> {
    row[key]
        .as_str()
        .filter(|text| !text.is_empty())
        .map(|text| json!(text))
}

/// `a || b || undefined` over text columns.
fn first_of(row: &Value, keys: &[&str]) -> Option<Value> {
    keys.iter().find_map(|key| or_undefined(row, key))
}

/// `Number(id) || id`: the mapped id as a number when it reads as one.
fn picqer_id(external_id: &str) -> Value {
    let number = weldsuite_kit::validation::js_number_of(Some(&json!(external_id)));
    if number.is_nan() || number == 0.0 {
        json!(external_id)
    } else {
        number_value(number)
    }
}

/// `Number(value)` of a column (`numeric` arrives as a number or text).
fn js_number(value: &Value) -> f64 {
    weldsuite_kit::validation::js_number_of(Some(value))
}

fn sha256_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

// ── mappings ─────────────────────────────────────────────────────────────────

/// One `integration_entity_mappings` row: id, external id, checksum.
struct Mapping {
    id: String,
    external_id: String,
    checksum: Option<String>,
}

/// `findExternalId(db, connectionId, externalEntityType, internalEntityId)`.
async fn find_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    internal_id: &str,
) -> Result<Option<Mapping>, sqlx::Error> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, external_entity_id, sync_checksum from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and internal_entity_id = $3
         limit 1",
    )
    .bind(connection_id)
    .bind(external_type)
    .bind(internal_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, external_id, checksum)| Mapping {
        id,
        external_id,
        checksum,
    }))
}

/// The mapped Picqer id of a WeldSuite record, as the body carries it.
async fn mapped_id(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    internal_id: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(internal_id) = internal_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    Ok(find_mapping(db, connection_id, external_type, internal_id)
        .await?
        .map(|m| picqer_id(&m.external_id)))
}

/// What a push writes back: the mapping (new, or its checksum and external
/// id moved on).
struct Pushed<'a> {
    external_type: &'a str,
    internal_type: &'a str,
    internal_id: &'a str,
}

/// `upsertOutboundMapping(args)`.
async fn upsert_mapping(
    db: &PgPool,
    connection_id: &str,
    pushed: &Pushed<'_>,
    external_id: &str,
    checksum: &str,
    existing: Option<&Mapping>,
) -> Result<(), sqlx::Error> {
    let now = now();
    if let Some(existing) = existing {
        sqlx::query(
            "update integration_entity_mappings set sync_checksum = $2, last_synced_at = $3::timestamp,
               updated_at = $3::timestamp, external_entity_id = $4
             where id = $1",
        )
        .bind(&existing.id)
        .bind(checksum)
        .bind(&now)
        .bind(external_id)
        .execute(db)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "insert into integration_entity_mappings (id, connection_id, external_entity_type,
           external_entity_id, internal_entity_type, internal_entity_id, sync_checksum, last_synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp)",
    )
    .bind(weldsuite_kit::generate_id("iem"))
    .bind(connection_id)
    .bind(pushed.external_type)
    .bind(external_id)
    .bind(pushed.internal_type)
    .bind(pushed.internal_id)
    .bind(checksum)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// The id Picqer answered with: `String(remote[key] ?? remote.id ?? fallback ?? '')`.
fn remote_id(remote: &Value, key: &str, fallback: Option<&str>) -> String {
    let id = remote
        .get(key)
        .filter(|v| !v.is_null())
        .or_else(|| remote.get("id").filter(|v| !v.is_null()));
    match id {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => {
            weldsuite_connect_domain::js::number_text(number.as_f64().unwrap_or_default())
        }
        Some(other) => other.to_string(),
        None => fallback.unwrap_or_default().to_owned(),
    }
}

// ── the pushes ───────────────────────────────────────────────────────────────

/// The tables a push reads its record from.
#[derive(Clone, Copy)]
enum Table {
    People,
    Orders,
    Suppliers,
    Warehouses,
    PurchaseOrders,
    Returns,
}

/// The connection, its Picqer client and the HTTP it goes out on.
struct Target<'a> {
    db: &'a PgPool,
    connection_id: &'a str,
    connection: Value,
    client: Picqer,
    http: Option<OutboundHttp>,
}

/// `loadPicqerClient(args)`.
async fn load<'a>(
    state: &ConnectState,
    caller: &'a Caller,
    connection_id: &'a str,
) -> Result<Target<'a>, PushError> {
    let connection = get_connection(&caller.db, connection_id).await?;
    let Some(connection) = connection.filter(|c| c["provider"] == "picqer") else {
        return Err(permanent("Picqer connection not found", 404));
    };
    if connection["status"] == "paused" || !connection["deleted_at"].is_null() {
        return Err(permanent("Picqer connection is not active", 400));
    }
    let keyring = crate::connectors::keyring(caller, state);
    let credentials = decrypt_credentials(connection.get("credentials"), &keyring);
    let client = match product_write_client(
        "picqer",
        &credentials,
        connection["external_account_id"].as_str(),
    )? {
        StoreClient::Picqer(client) => client,
        _ => return Err(permanent("Picqer connection not found", 404)),
    };
    Ok(Target {
        db: &caller.db,
        connection_id,
        connection,
        client,
        http: caller.overrides.http(state),
    })
}

impl Target<'_> {
    /// `assertOutbound(connection, settingKey)`.
    fn assert_outbound(&self, setting_key: &str) -> Result<(), PushError> {
        let direction = self.connection["direction"].as_str();
        let per_object = self.connection.get("object_sync_directions");
        if allows_outbound(direction, per_object, setting_key) {
            return Ok(());
        }
        Err(permanent(
            &format!("Outbound sync disabled for {setting_key}"),
            400,
        ))
    }

    /// The live row of `table` (`select * … where id and deleted_at is null`).
    async fn row(&self, table: Table, id: &str, missing: &str) -> Result<Value, PushError> {
        let sql = match table {
            Table::People => {
                "select to_jsonb(t) from people t where t.id = $1 and t.deleted_at is null limit 1"
            }
            Table::Orders => {
                "select to_jsonb(t) from orders t where t.id = $1 and t.deleted_at is null limit 1"
            }
            Table::Suppliers => {
                "select to_jsonb(t) from suppliers t where t.id = $1 and t.deleted_at is null limit 1"
            }
            Table::Warehouses => {
                "select to_jsonb(t) from warehouses t where t.id = $1 and t.deleted_at is null limit 1"
            }
            Table::PurchaseOrders => {
                "select to_jsonb(t) from purchase_orders t where t.id = $1 and t.deleted_at is null limit 1"
            }
            Table::Returns => {
                "select to_jsonb(t) from returns t where t.id = $1 and t.deleted_at is null limit 1"
            }
        };
        let row: Option<Value> = sqlx::query_scalar(sql)
            .bind(id)
            .fetch_optional(self.db)
            .await?;
        row.ok_or_else(|| permanent(missing, 404))
    }

    /// Hash the body; skip when unchanged, else create (or update, when
    /// `update_path` and a mapping exist), and write the mapping back.
    async fn push(
        &self,
        pushed: &Pushed<'_>,
        body: &str,
        create_path: &str,
        update_path: Option<&str>,
        id_key: &str,
    ) -> Result<String, PushError> {
        let checksum = sha256_hex(body);
        let existing = find_mapping(
            self.db,
            self.connection_id,
            pushed.external_type,
            pushed.internal_id,
        )
        .await?;
        if let Some(existing) = &existing
            && existing.checksum.as_deref() == Some(checksum.as_str())
        {
            return Ok(existing.external_id.clone());
        }
        let http = self.http.as_ref();
        let remote = match (&existing, update_path) {
            (Some(existing), Some(path)) => {
                let path = format!("{path}/{}", existing.external_id);
                self.client
                    .send(http, "PUT", &path, body.to_owned())
                    .await?
            }
            _ => {
                self.client
                    .send(http, "POST", create_path, body.to_owned())
                    .await?
            }
        };
        let fallback = if update_path.is_some() {
            existing.as_ref().map(|m| m.external_id.as_str())
        } else {
            None
        };
        let external_id = remote_id(&remote, id_key, fallback);
        upsert_mapping(
            self.db,
            self.connection_id,
            pushed,
            &external_id,
            &checksum,
            existing.as_ref(),
        )
        .await?;
        Ok(external_id)
    }

    /// `pushPersonToPicqer`.
    async fn person(&self, person_id: &str) -> Result<String, PushError> {
        self.assert_outbound("customers")?;
        let person = self
            .row(Table::People, person_id, "Person not found")
            .await?;
        let names: Vec<&str> = ["first_name", "last_name"]
            .iter()
            .filter_map(|key| person[*key].as_str().filter(|n| !n.is_empty()))
            .collect();
        let joined = names.join(" ");
        let name =
            first_of(&person, &["full_name", "display_name"]).unwrap_or_else(|| json!(joined));
        let body = Ordered::default()
            .set("name", Some(name))
            .set("contactname", (!joined.is_empty()).then(|| json!(joined)))
            .set("emailaddress", or_undefined(&person, "email"))
            .set("telephone", or_undefined(&person, "direct_phone"));
        let pushed = Pushed {
            external_type: "picqer_customer",
            internal_type: "person",
            internal_id: person_id,
        };
        self.push(
            &pushed,
            &body.text(),
            "customers",
            Some("customers"),
            "idcustomer",
        )
        .await
    }

    /// `pushOrderToPicqer`.
    async fn order(&self, order_id: &str) -> Result<String, PushError> {
        self.assert_outbound("orders")?;
        let order = self.row(Table::Orders, order_id, "Order not found").await?;
        let items: Vec<Value> =
            sqlx::query_scalar("select to_jsonb(t) from order_items t where t.order_id = $1")
                .bind(order_id)
                .fetch_all(self.db)
                .await?;

        let mut customer: Option<Value> = None;
        if let Some(person_id) = order["person_id"].as_str().filter(|p| !p.is_empty()) {
            customer = Some(
                match find_mapping(self.db, self.connection_id, "picqer_customer", person_id)
                    .await?
                {
                    Some(mapping) => picqer_id(&mapping.external_id),
                    None => picqer_id(&self.person(person_id).await?),
                },
            );
        }
        let mut products = Vec::new();
        for item in &items {
            let product = mapped_id(
                self.db,
                self.connection_id,
                "picqer_product",
                item["product_id"].as_str(),
            )
            .await?;
            let price = js_number(&item["unit_price"]);
            products.push(
                Ordered::default()
                    .set("idproduct", product)
                    .set("productcode", or_undefined(item, "sku"))
                    .set("name", Some(item["name"].clone()))
                    .set("amount", Some(item["quantity"].clone()))
                    .set(
                        "price",
                        Some(number_value(if price.is_nan() { 0.0 } else { price })),
                    ),
            );
        }
        let body = Ordered::default()
            .set(
                "reference",
                first_of(&order, &["order_number", "external_order_id", "id"]),
            )
            .set("emailaddress", or_undefined(&order, "customer_email"))
            .set("telephone", or_undefined(&order, "customer_phone"))
            .set("deliveryname", or_undefined(&order, "customer_name"))
            .set("remarks", or_undefined(&order, "customer_note"))
            .set("idcustomer", customer)
            .raw("products", list(&products));
        let pushed = Pushed {
            external_type: "picqer_order",
            internal_type: "order",
            internal_id: order_id,
        };
        self.push(&pushed, &body.text(), "orders", Some("orders"), "idorder")
            .await
    }

    /// `pushSupplierToPicqer`.
    async fn supplier(&self, supplier_id: &str) -> Result<String, PushError> {
        self.assert_outbound("suppliers")?;
        let supplier = self
            .row(Table::Suppliers, supplier_id, "Supplier not found")
            .await?;
        let body = Ordered::default()
            .set("name", Some(supplier["name"].clone()))
            .set("contactname", or_undefined(&supplier, "contact_name"))
            .set("emailaddress", or_undefined(&supplier, "email"))
            .set("telephone", or_undefined(&supplier, "phone"))
            .set("address", or_undefined(&supplier, "address_line_1"))
            .set("city", or_undefined(&supplier, "city"))
            .set("zipcode", or_undefined(&supplier, "postal_code"))
            .set("country", or_undefined(&supplier, "country"))
            .set("remarks", or_undefined(&supplier, "notes"));
        let pushed = Pushed {
            external_type: "picqer_supplier",
            internal_type: "supplier",
            internal_id: supplier_id,
        };
        self.push(
            &pushed,
            &body.text(),
            "suppliers",
            Some("suppliers"),
            "idsupplier",
        )
        .await
    }

    /// `pushWarehouseToPicqer`.
    async fn warehouse(&self, warehouse_id: &str) -> Result<String, PushError> {
        self.assert_outbound("warehouses")?;
        let warehouse = self
            .row(Table::Warehouses, warehouse_id, "Warehouse not found")
            .await?;
        let body = Ordered::default()
            .set("name", Some(warehouse["name"].clone()))
            .set(
                "accepts_orders",
                Some(json!(warehouse["is_active"] != Value::Bool(false))),
            );
        let pushed = Pushed {
            external_type: "picqer_warehouse",
            internal_type: "warehouse",
            internal_id: warehouse_id,
        };
        self.push(
            &pushed,
            &body.text(),
            "warehouses",
            Some("warehouses"),
            "idwarehouse",
        )
        .await
    }

    /// `pushStockAdjustmentToPicqer`.
    async fn stock(
        &self,
        product_id: &str,
        warehouse_id: &str,
        delta: f64,
    ) -> Result<(), PushError> {
        self.assert_outbound("inventory")?;
        let product =
            find_mapping(self.db, self.connection_id, "picqer_product", product_id).await?;
        let warehouse = find_mapping(
            self.db,
            self.connection_id,
            "picqer_warehouse",
            warehouse_id,
        )
        .await?;
        let (Some(product), Some(warehouse)) = (product, warehouse) else {
            return Err(permanent(
                "Product and warehouse must be mapped to Picqer before stock push",
                400,
            ));
        };
        if delta == 0.0 || delta.is_nan() {
            return Ok(());
        }
        let body = Ordered::default()
            .set("idwarehouse", Some(picqer_id(&warehouse.external_id)))
            .set("amount", Some(number_value(delta)));
        let path = format!("products/{}/stock", product.external_id);
        self.client
            .send(self.http.as_ref(), "POST", &path, body.text())
            .await?;
        Ok(())
    }

    /// `pushPurchaseOrderToPicqer`.
    async fn purchase_order(&self, purchase_order_id: &str) -> Result<String, PushError> {
        self.assert_outbound("purchaseOrders")?;
        let po = self
            .row(
                Table::PurchaseOrders,
                purchase_order_id,
                "Purchase order not found",
            )
            .await?;
        let items: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from purchase_order_items t where t.purchase_order_id = $1",
        )
        .bind(purchase_order_id)
        .fetch_all(self.db)
        .await?;
        let supplier = mapped_id(
            self.db,
            self.connection_id,
            "picqer_supplier",
            po["supplier_id"].as_str(),
        )
        .await?;
        let warehouse = mapped_id(
            self.db,
            self.connection_id,
            "picqer_warehouse",
            po["warehouse_id"].as_str(),
        )
        .await?;
        let mut products = Vec::new();
        for item in &items {
            let product = mapped_id(
                self.db,
                self.connection_id,
                "picqer_product",
                item["product_id"].as_str(),
            )
            .await?;
            let amount = match &item["quantity_ordered"] {
                Value::Null => json!(1),
                other => other.clone(),
            };
            let price = match &item["unit_price"] {
                Value::Null => 0.0,
                other => js_number(other),
            };
            let price = (price != 0.0 && !price.is_nan()).then(|| number_value(price));
            products.push(
                Ordered::default()
                    .set("idproduct", product)
                    .set("amount", Some(amount))
                    .set("price", price),
            );
        }
        let delivery = po["expected_date"]
            .as_str()
            .map(|date| json!(date.chars().take(10).collect::<String>()));
        let body = Ordered::default()
            .set("idsupplier", supplier)
            .set("idwarehouse", warehouse)
            .set("supplier_name", or_undefined(&po, "supplier_name"))
            .set(
                "remarks",
                first_of(&po, &["internal_notes", "supplier_notes"]),
            )
            .set("delivery_date", delivery)
            .raw("products", list(&products));
        let pushed = Pushed {
            external_type: "picqer_purchase_order",
            internal_type: "purchase_order",
            internal_id: purchase_order_id,
        };
        self.push(
            &pushed,
            &body.text(),
            "purchaseorders",
            None,
            "idpurchaseorder",
        )
        .await
    }

    /// `pushReturnToPicqer`.
    async fn return_(&self, return_id: &str) -> Result<String, PushError> {
        self.assert_outbound("returns")?;
        let ret = self
            .row(Table::Returns, return_id, "Return not found")
            .await?;
        let order = mapped_id(
            self.db,
            self.connection_id,
            "picqer_order",
            ret["original_order_id"].as_str(),
        )
        .await?;
        let items = match &ret["items"] {
            Value::Array(items) => items.clone(),
            _ => Vec::new(),
        };
        let products: Vec<Ordered> = items
            .iter()
            .map(|item| {
                let field = |key: &str| item.get(key).cloned();
                Ordered::default()
                    .set("name", field("productName"))
                    .set("productcode", field("sku"))
                    .set("amount", field("quantity"))
            })
            .collect();
        let body = Ordered::default()
            .set("idorder", order)
            .set("name", or_undefined(&ret, "customer_name"))
            .set("emailaddress", or_undefined(&ret, "customer_email"))
            .set("telephone", or_undefined(&ret, "customer_phone"))
            .set("remarks", first_of(&ret, &["reason_details", "reason"]))
            .raw("products", list(&products));
        let pushed = Pushed {
            external_type: "picqer_return",
            internal_type: "return",
            internal_id: return_id,
        };
        self.push(&pushed, &body.text(), "returns", None, "idreturn")
            .await
    }
}

/// The request body (`picqerPushSchema`).
struct PushBody {
    entity: String,
    entity_id: String,
    warehouse_id: Option<String>,
    amount_delta: Option<f64>,
}

/// `POST /connections/:id/picqer/push`.
pub(crate) async fn push(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Connector request failed";
    let body = match validate(&headers, &body, |issues, b: &Map<String, Value>| PushBody {
        entity: issues
            .choice(b, "entity", Presence::Required, ENTITIES)
            .into_option()
            .unwrap_or_default(),
        entity_id: issues
            .text(b, "entityId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        warehouse_id: issues
            .text(b, "warehouseId", Presence::Optional, None, None)
            .into_option(),
        amount_delta: issues
            .number(b, "amountDelta", Presence::Optional, Number::default())
            .into_option(),
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let row = match get_connection(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Connection", Some(&id)).into_response(),
        Err(error) => return crate::internal(&error, FAILED),
    };
    if row["provider"] != "picqer" {
        return ApiError::bad_request("Not a Picqer connection").into_response();
    }
    if body.entity == "inventory" && (body.warehouse_id.is_none() || body.amount_delta.is_none()) {
        return ApiError::bad_request("warehouseId and amountDelta required for inventory push")
            .into_response();
    }
    let pushed = async {
        let target = load(&state, &caller, &id).await?;
        let entity_id = body.entity_id.as_str();
        let external_id = match body.entity.as_str() {
            "person" => target.person(entity_id).await?,
            "order" => target.order(entity_id).await?,
            "supplier" => target.supplier(entity_id).await?,
            "warehouse" => target.warehouse(entity_id).await?,
            "purchase_order" => target.purchase_order(entity_id).await?,
            "return" => target.return_(entity_id).await?,
            _ => {
                let warehouse_id = body.warehouse_id.as_deref().unwrap_or_default();
                let delta = body.amount_delta.unwrap_or_default();
                target.stock(entity_id, warehouse_id, delta).await?;
                return Ok::<_, PushError>(json!({ "ok": true }));
            }
        };
        Ok(json!({ "externalId": external_id }))
    }
    .await;
    match pushed {
        Ok(data) => Data(data).into_response(),
        Err(error) => {
            if let PushError::Database(error) = &error {
                tracing::error!(%error, "[app-api/connectors] picqer push failed");
            }
            error_response(&error)
        }
    }
}
