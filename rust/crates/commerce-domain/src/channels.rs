//! Sales channels the order writes need (ADR COM-011): the channel of a
//! connected store. The staff routes (`/api/commerce-channels`) manage
//! channels; this is the one the connector ingest creates on its own, so
//! every imported order carries a `channel_id`.

use sqlx::PgConnection;
use weldsuite_kit::generate_id;

/// The store connection a channel stands for.
#[derive(Debug, Clone, Copy)]
pub struct Connector<'a> {
    /// `connector_connections.id`.
    pub connection_id: &'a str,
    /// `shopify` or `woocommerce`.
    pub provider: &'a str,
    /// The store's name, for the channel list.
    pub name: &'a str,
    /// The currency of the store's orders.
    pub currency: &'a str,
}

/// A channel found or made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ensured {
    pub id: String,
    /// The channel was made by this call (the caller publishes
    /// `commerce_channel:created`).
    pub created: bool,
}

/// The live channel of a store connection, made on first use: `type` is the
/// provider, `status` `active`, no keys and no shipping rates. Serialised per
/// connection, so two imports at once make one channel.
///
/// # Errors
/// A failed statement.
pub async fn ensure_connector(
    conn: &mut PgConnection,
    connector: &Connector<'_>,
) -> Result<Ensured, sqlx::Error> {
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("weldcommerce:channel:{}", connector.connection_id))
        .execute(&mut *conn)
        .await?;
    let found: Option<String> = sqlx::query_scalar(
        "select id from commerce_channels where connection_id = $1 and deleted_at is null \
         order by created_at asc, id asc limit 1",
    )
    .bind(connector.connection_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(id) = found {
        return Ok(Ensured { id, created: false });
    }
    let id = generate_id("chan");
    let currency = connector.currency.trim().to_ascii_uppercase();
    let currency = if currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_alphabetic()) {
        currency
    } else {
        "EUR".to_owned()
    };
    let name: String = connector.name.trim().chars().take(255).collect();
    let name = if name.is_empty() {
        connector.provider.to_owned()
    } else {
        name
    };
    sqlx::query(
        "insert into commerce_channels (id, name, type, audience, status, currency, \
           prices_include_tax, selling_countries, guest_checkout, payment_methods, connection_id, \
           created_at, updated_at) \
         values ($1, $2, $3, 'b2c', 'active', $4, true, '[]'::jsonb, true, '[]'::jsonb, $5, \
           $6::timestamp, $6::timestamp)",
    )
    .bind(&id)
    .bind(&name)
    .bind(connector.provider)
    .bind(&currency)
    .bind(connector.connection_id)
    .bind(crate::now())
    .execute(&mut *conn)
    .await?;
    Ok(Ensured { id, created: true })
}
