//! Sales channels the order writes need (ADR COM-011): the channel of a
//! connected store. The staff routes (`/api/commerce-channels`) manage
//! channels; this is the one the connector ingest creates on its own, so
//! every imported order carries a `channel_id`.

use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;
use sqlx::PgConnection;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::commerce_channels;

use crate::db;

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
) -> Result<Ensured, DbErr> {
    db::advisory_lock(
        conn,
        &format!("weldcommerce:channel:{}", connector.connection_id),
    )
    .await?;
    let found = commerce_channels::Entity::find()
        .filter(commerce_channels::Column::ConnectionId.eq(connector.connection_id))
        .filter(commerce_channels::Column::DeletedAt.is_null())
        .order_by_asc(commerce_channels::Column::CreatedAt)
        .order_by_asc(commerce_channels::Column::Id)
        .one(&db::on(conn))
        .await?;
    if let Some(found) = found {
        return Ok(Ensured {
            id: found.id,
            created: false,
        });
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
    let now = db::now();
    commerce_channels::ActiveModel {
        id: Set(id.clone()),
        name: Set(name),
        type_: Set(connector.provider.to_owned()),
        audience: Set("b2c".to_owned()),
        status: Set("active".to_owned()),
        currency: Set(currency),
        prices_include_tax: Set(true),
        selling_countries: Set(json!([])),
        guest_checkout: Set(true),
        payment_methods: Set(json!([])),
        connection_id: Set(Some(connector.connection_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&db::on(conn))
    .await?;
    Ok(Ensured { id, created: true })
}
