//! `services/connectors/publish-product.ts`: list a product on an external
//! store. Adding a sales channel pushes (or matches by SKU and updates) the
//! store's listing, then writes `product_sales_channels` and an
//! `integration_entity_mappings` row; removing one deletes the remote listing
//! first. The store clients are [`crate::connectors`].

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use crate::connectors::{self, ConnectorError, ProductRef, StoreClient};
use crate::js::{number_text, to_fixed};
use crate::now;
use crate::tables;

/// `ProductSalesChannelError` (its `code` and message), or a database error.
#[derive(Debug)]
pub(crate) enum ChannelError {
    NotFound(String),
    Conflict(String),
    ConnectionInactive(String),
    Unsupported(String),
    Invalid(String),
    SyncFailed(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for ChannelError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

const WRITABLE: &[&str] = &["active", "sync_error"];

/// The store, the product and what the routes pass along.
pub(crate) struct Context<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) http: Option<&'a OutboundHttp>,
    pub(crate) keyring: &'a Keyring,
}

/// `numericString(value)`.
fn numeric_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => "0".to_owned(),
        Some(Value::String(s)) if s.is_empty() => "0".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(0.0)),
        Some(other) => other.to_string(),
    }
}

/// `resolvePrice(value, fallback)`.
fn resolve_price(value: Option<&Value>, fallback: String) -> Result<String, ChannelError> {
    let n = match value {
        None | Some(Value::Null) => return Ok(fallback),
        Some(Value::String(s)) if s.is_empty() => return Ok(fallback),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => weldsuite_kit::validation::js_number(&s.replacen(',', ".", 1)),
        Some(other) => weldsuite_kit::validation::js_number(&other.to_string()),
    };
    if !n.is_finite() || n < 0.0 {
        return Err(ChannelError::Invalid("Price must be a non-negative number".to_owned()));
    }
    Ok(to_fixed(n, 2))
}

/// `resolveListingStatus(value, fallback)`.
fn resolve_listing_status(value: Option<&Value>, fallback: &str) -> Result<String, ChannelError> {
    let raw = match value.and_then(Value::as_str).map(weldsuite_kit::validation::js_trim) {
        Some(text) if !text.is_empty() => text,
        _ => fallback,
    };
    if matches!(raw, "active" | "inactive" | "draft") {
        Ok(raw.to_owned())
    } else {
        Err(ChannelError::Invalid(
            "Listing status must be active, inactive, or draft".to_owned(),
        ))
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `toOutboundProduct(product, { price, listingStatus })`.
fn outbound_product(product: &Value, price: &str, status: &str) -> Value {
    let mut images: Vec<Value> = product
        .get("images")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|img| img.get("url").is_some_and(|u| u.as_str().is_some_and(|s| !s.is_empty())))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if images.is_empty()
        && let Some(featured) = text(product, "featuredImageUrl").filter(|f| !f.is_empty())
    {
        images.push(json!({ "url": featured }));
    }
    let string_of = |key: &str| match product.get(key) {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(other) => json!(other.to_string()),
    };
    let mut out = Map::new();
    for key in ["name", "description", "shortDescription", "sku", "slug"] {
        out.insert(key.to_owned(), product.get(key).cloned().unwrap_or(Value::Null));
    }
    out.insert("price".to_owned(), json!(price));
    out.insert("status".to_owned(), json!(status));
    for key in ["vendor", "productType"] {
        out.insert(key.to_owned(), product.get(key).cloned().unwrap_or(Value::Null));
    }
    out.insert("images".to_owned(), Value::Array(images));
    for key in ["weight", "length", "width", "height"] {
        out.insert(key.to_owned(), string_of(key));
    }
    if let Some(track) = product.get("trackInventory").filter(|t| !t.is_null()) {
        out.insert("trackInventory".to_owned(), track.clone());
    }
    out.insert(
        "inventoryQuantity".to_owned(),
        product.get("inventoryQuantity").cloned().unwrap_or(Value::Null),
    );
    Value::Object(out)
}

pub(crate) async fn load_product(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    tables::PRODUCTS.find_live(db, id).await
}

async fn connection(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(connector_connections),
        " from connector_connections t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| tables::CONNECTOR_CONNECTIONS.js(row)))
}

async fn channel_where(db: &PgPool, sql: &'static str, a: &str, b: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(a).bind(b).fetch_optional(db).await?;
    Ok(row.map(|row| tables::PRODUCT_SALES_CHANNELS.js(row)))
}

const BY_PRODUCT_CONNECTION: &str = concat!(
    "select ",
    row_of!(product_sales_channels),
    " from product_sales_channels t where t.product_id = $1 and t.connection_id = $2 limit 1"
);
const BY_CONNECTION_EXTERNAL: &str = concat!(
    "select ",
    row_of!(product_sales_channels),
    " from product_sales_channels t where t.connection_id = $1 and t.external_id = $2 limit 1"
);
const BY_ID_PRODUCT: &str = concat!(
    "select ",
    row_of!(product_sales_channels),
    " from product_sales_channels t where t.id = $1 and t.product_id = $2 limit 1"
);
const BY_ID: &str = concat!(
    "select ",
    row_of!(product_sales_channels),
    " from product_sales_channels t where t.id = $1 limit 1"
);

/// `assertWritableConnection(connection)`.
fn assert_writable(connection: &Value) -> Result<(), ChannelError> {
    let provider = text(connection, "provider").unwrap_or_default();
    if connectors::connector(provider).is_none() {
        return Err(ChannelError::Unsupported(format!("Unknown connector '{provider}'")));
    }
    let status = text(connection, "status").unwrap_or_default();
    if connection.get("deletedAt").is_some_and(|d| !d.is_null()) || !WRITABLE.contains(&status) {
        return Err(ChannelError::ConnectionInactive(
            "This sales channel is not connected. Reconnect the store and try again.".to_owned(),
        ));
    }
    if !connectors::allows_outbound(
        text(connection, "direction"),
        connection.get("objectSyncDirections"),
        "products",
    ) {
        return Err(ChannelError::Unsupported(
            "This connection is set to inbound-only. Enable outbound or two-way sync for products to publish."
                .to_owned(),
        ));
    }
    Ok(())
}

fn client_for(connection: &Value, keyring: &Keyring) -> Result<StoreClient, ConnectorError> {
    let credentials = connectors::decrypt_credentials(connection.get("credentials"), keyring);
    connectors::product_write_client(
        text(connection, "provider").unwrap_or_default(),
        &credentials,
        text(connection, "externalAccountId"),
    )
}

fn sync_failed(error: ConnectorError) -> ChannelError {
    ChannelError::SyncFailed(error.message)
}

/// `ensureMapping`.
async fn ensure_mapping(db: &PgPool, connection: &Value, external_id: &str, product_id: &str) -> Result<(), ChannelError> {
    let provider = text(connection, "provider").unwrap_or_default();
    let entity = connectors::connector(provider)
        .and_then(|c| c.product_entity)
        .map_or_else(|| format!("{provider}_product"), str::to_owned);
    let connection_id = text(connection, "id").unwrap_or_default();
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, internal_entity_id from integration_entity_mappings \
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3 limit 1",
    )
    .bind(connection_id)
    .bind(&entity)
    .bind(external_id)
    .fetch_optional(db)
    .await?;
    let now = now();
    if let Some((id, internal)) = existing {
        if internal != product_id {
            return Err(ChannelError::Conflict(
                "That store listing is already linked to a different product".to_owned(),
            ));
        }
        sqlx::query(
            "update integration_entity_mappings set last_synced_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
        )
        .bind(&now)
        .bind(&id)
        .execute(db)
        .await?;
        return Ok(());
    }
    let t = &tables::INTEGRATION_ENTITY_MAPPINGS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(generate_id("iem")));
    t.set(&mut values, "connectionId", json!(connection_id));
    t.set(&mut values, "externalEntityType", json!(entity));
    t.set(&mut values, "externalEntityId", json!(external_id));
    t.set(&mut values, "internalEntityType", json!("product"));
    t.set(&mut values, "internalEntityId", json!(product_id));
    t.set(&mut values, "lastSyncedAt", json!(now));
    t.insert(db, values, &["lastSyncedAt"]).await.map_err(|error| match error {
        crate::table::WriteError::Database(error) => ChannelError::Database(error),
        crate::table::WriteError::NotADate(prop) => ChannelError::SyncFailed(prop.to_owned()),
    })?;
    Ok(())
}

/// `writeSalesChannel`.
async fn write_channel(
    db: &PgPool,
    product_id: &str,
    connection: &Value,
    remote: &ProductRef,
    price: &str,
    status: &str,
) -> Result<Value, ChannelError> {
    let connection_id = text(connection, "id").unwrap_or_default();
    if let Some(stolen) = channel_where(db, BY_CONNECTION_EXTERNAL, connection_id, &remote.id).await?
        && text(&stolen, "productId") != Some(product_id)
    {
        return Err(ChannelError::Conflict(
            "That store listing is already linked to a different product".to_owned(),
        ));
    }
    let now = now();
    let t = &tables::PRODUCT_SALES_CHANNELS;
    let mut listing = Map::new();
    t.set(&mut listing, "externalId", json!(remote.id));
    t.set(&mut listing, "externalUrl", json!(remote.url));
    t.set(&mut listing, "displayName", connection.get("displayName").cloned().unwrap_or(Value::Null));
    t.set(&mut listing, "provider", connection.get("provider").cloned().unwrap_or(Value::Null));
    t.set(&mut listing, "status", json!("active"));
    t.set(&mut listing, "price", json!(price));
    t.set(&mut listing, "listingStatus", json!(status));
    t.set(&mut listing, "lastSyncedAt", json!(now));
    t.set(&mut listing, "updatedAt", json!(now));
    let trusted = ["lastSyncedAt", "updatedAt"];
    let map_write = |error: crate::table::WriteError| match error {
        crate::table::WriteError::Database(error) => ChannelError::Database(error),
        crate::table::WriteError::NotADate(prop) => ChannelError::SyncFailed(prop.to_owned()),
    };
    if let Some(linked) = channel_where(db, BY_PRODUCT_CONNECTION, product_id, connection_id).await? {
        let id = text(&linked, "id").unwrap_or_default().to_owned();
        t.patch(db, &id, listing, false, &trusted).await.map_err(map_write)?;
        let row: Option<Value> = sqlx::query_scalar(BY_ID).bind(&id).fetch_optional(db).await?;
        return Ok(row.map_or(linked, |row| t.js(row)));
    }
    let id = generate_id("psch");
    t.set(&mut listing, "id", json!(id));
    t.set(&mut listing, "productId", json!(product_id));
    t.set(&mut listing, "connectionId", json!(connection_id));
    t.insert(db, listing, &trusted).await.map_err(map_write)?;
    let row: Option<Value> = sqlx::query_scalar(BY_ID).bind(&id).fetch_optional(db).await?;
    row.map(|row| t.js(row))
        .ok_or_else(|| ChannelError::SyncFailed("Failed to record the sales channel".to_owned()))
}

/// `publishProductToSalesChannel`.
pub(crate) async fn publish(
    ctx: &Context<'_>,
    product_id: &str,
    connection_id: &str,
    price: Option<&Value>,
    listing_status: Option<&Value>,
) -> Result<Value, ChannelError> {
    let Some(product) = load_product(ctx.db, product_id).await? else {
        return Err(ChannelError::NotFound("Product not found".to_owned()));
    };
    let Some(connection) = connection(ctx.db, connection_id).await? else {
        return Err(ChannelError::NotFound("Sales channel not found".to_owned()));
    };
    assert_writable(&connection)?;
    let product_id = text(&product, "id").unwrap_or(product_id).to_owned();
    let connection_id = text(&connection, "id").unwrap_or(connection_id).to_owned();
    if let Some(already) = channel_where(ctx.db, BY_PRODUCT_CONNECTION, &product_id, &connection_id).await?
        && text(&already, "status") == Some("active")
    {
        return Err(ChannelError::Conflict(
            "This product is already listed on that sales channel".to_owned(),
        ));
    }
    let price = resolve_price(price, numeric_string(product.get("price")))?;
    let fallback = text(&product, "status").unwrap_or("draft").to_owned();
    let status = resolve_listing_status(listing_status, &fallback)?;
    let payload = outbound_product(&product, &price, &status);
    let client = client_for(&connection, ctx.keyring).map_err(|e| ChannelError::Unsupported(e.message))?;
    let sku = text(&product, "sku").map(weldsuite_kit::validation::js_trim).unwrap_or_default();
    let existing = if sku.is_empty() {
        None
    } else {
        client.find_by_sku(ctx.http, sku).await.map_err(sync_failed)?
    };
    let remote = match existing {
        Some(existing) => client.update(ctx.http, &existing.id, &payload).await,
        None => client.create(ctx.http, &payload).await,
    }
    .map_err(sync_failed)?;
    if remote.id.is_empty() {
        return Err(ChannelError::SyncFailed("The store did not return a product id".to_owned()));
    }
    ensure_mapping(ctx.db, &connection, &remote.id, &product_id).await?;
    write_channel(ctx.db, &product_id, &connection, &remote, &price, &status).await
}

/// `updateProductSalesChannel`.
pub(crate) async fn update(
    ctx: &Context<'_>,
    product_id: &str,
    channel_id: &str,
    price: Option<&Value>,
    listing_status: Option<&Value>,
) -> Result<Value, ChannelError> {
    let Some(product) = load_product(ctx.db, product_id).await? else {
        return Err(ChannelError::NotFound("Product not found".to_owned()));
    };
    let Some(channel) = channel_where(ctx.db, BY_ID_PRODUCT, channel_id, product_id).await? else {
        return Err(ChannelError::NotFound("Sales channel listing not found".to_owned()));
    };
    let Some(connection) = connection(ctx.db, text(&channel, "connectionId").unwrap_or_default()).await? else {
        return Err(ChannelError::NotFound("Sales channel not found".to_owned()));
    };
    assert_writable(&connection)?;
    let fallback_price = match channel.get("price") {
        Some(Value::String(price)) => price.clone(),
        _ => numeric_string(product.get("price")),
    };
    let price = resolve_price(price, fallback_price)?;
    let fallback = [text(&channel, "listingStatus"), text(&product, "status")]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
        .unwrap_or("draft")
        .to_owned();
    let status = resolve_listing_status(listing_status, &fallback)?;
    let payload = outbound_product(&product, &price, &status);
    let client = client_for(&connection, ctx.keyring).map_err(|e| ChannelError::Unsupported(e.message))?;
    let external_id = text(&channel, "externalId").unwrap_or_default().to_owned();
    let remote = client.update(ctx.http, &external_id, &payload).await.map_err(sync_failed)?;
    let remote = ProductRef {
        id: if remote.id.is_empty() { external_id } else { remote.id },
        url: remote
            .url
            .or_else(|| text(&channel, "externalUrl").map(str::to_owned)),
    };
    let product_id = text(&product, "id").unwrap_or(product_id).to_owned();
    write_channel(ctx.db, &product_id, &connection, &remote, &price, &status).await
}

/// `unlinkProductSalesChannel`: the remote listing first (a 404 is fine),
/// then the local row.
pub(crate) async fn unlink(ctx: &Context<'_>, product_id: &str, channel_id: &str) -> Result<(), ChannelError> {
    if load_product(ctx.db, product_id).await?.is_none() {
        return Err(ChannelError::NotFound("Product not found".to_owned()));
    }
    let Some(channel) = channel_where(ctx.db, BY_ID_PRODUCT, channel_id, product_id).await? else {
        return Err(ChannelError::NotFound("Sales channel listing not found".to_owned()));
    };
    if let Some(external_id) = text(&channel, "externalId").filter(|e| !e.is_empty()) {
        let Some(connection) = connection(ctx.db, text(&channel, "connectionId").unwrap_or_default()).await? else {
            return Err(ChannelError::NotFound("Sales channel connection not found".to_owned()));
        };
        let deleted = match client_for(&connection, ctx.keyring) {
            Ok(client) => client.delete(ctx.http, external_id).await,
            Err(error) => Err(error),
        };
        match deleted {
            Ok(()) => {}
            Err(error) if error.status == 404 => {}
            Err(error) => return Err(ChannelError::SyncFailed(error.message)),
        }
    }
    sqlx::query("delete from product_sales_channels where id = $1")
        .bind(text(&channel, "id"))
        .execute(ctx.db)
        .await?;
    Ok(())
}

/// `listSalesChannelTargets`: live ecommerce connections that can be written.
pub(crate) async fn targets(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(connector_connections),
        " from connector_connections t where t.deleted_at is null"
    ))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| tables::CONNECTOR_CONNECTIONS.js(row))
        .filter_map(|row| {
            let provider = text(&row, "provider").unwrap_or_default().to_owned();
            let connector = connectors::connector(&provider)?;
            let status = text(&row, "status").unwrap_or_default();
            (connector.category == "ecommerce" && WRITABLE.contains(&status)).then(|| {
                json!({
                    "id": row["id"],
                    "provider": provider,
                    "label": connector.label,
                    "displayName": row.get("displayName").cloned().unwrap_or(Value::Null),
                    "status": status,
                    "externalAccountId": row.get("externalAccountId").cloned().unwrap_or(Value::Null),
                })
            })
        })
        .collect())
}

/// A product's sales channel rows (no ORDER BY, as the worker reads them).
pub(crate) async fn channels_of(db: &PgPool, product_ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(product_sales_channels),
        " from product_sales_channels t where t.product_id = any($1)"
    ))
    .bind(product_ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| tables::PRODUCT_SALES_CHANNELS.js(row))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_and_statuses_like_the_worker() {
        assert_eq!(resolve_price(Some(&json!("29,95")), "0".into()).expect("price"), "29.95");
        assert_eq!(resolve_price(Some(&json!(10)), "0".into()).expect("price"), "10.00");
        assert_eq!(resolve_price(None, "12.5".into()).expect("price"), "12.5");
        assert!(resolve_price(Some(&json!("-1")), "0".into()).is_err());
        assert_eq!(resolve_listing_status(Some(&json!(" active ")), "draft").expect("status"), "active");
        assert!(resolve_listing_status(None, "archived").is_err());
    }
}
