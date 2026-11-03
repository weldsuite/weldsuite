//! Every connector's client behind one type (`createConnectorProviderClient`
//! / `createConnectorClient`, the `ConnectorProviderClient` interface):
//! WooCommerce, Shopify and Picqer ([`StoreClient`]), Moneybird and Stripe.

use serde_json::{Map, Value};
use weldsuite_ports::OutboundHttp;

use crate::clients::{ConnectorError, Kind, StoreClient, product_write_client};
use crate::moneybird::Moneybird;
use crate::stripe::Stripe;
pub use crate::stripe::{ListPage, Tested, WebhookCreated};

/// `ConnectorProviderClient`.
pub enum ProviderClient {
    Store(StoreClient),
    Moneybird(Moneybird),
    Stripe(Stripe),
}

impl ProviderClient {
    /// `createConnectorProviderClient(provider, credentials, fallbackAccountId)`.
    pub fn new(
        provider: &str,
        credentials: &Map<String, Value>,
        fallback: Option<&str>,
    ) -> Result<Self, ConnectorError> {
        match provider {
            "moneybird" => Ok(Self::Moneybird(Moneybird::from_credentials(
                credentials,
                fallback,
            ))),
            "stripe" => Ok(Self::Stripe(Stripe::from_credentials(
                credentials,
                fallback,
            ))),
            "woocommerce" | "shopify" | "picqer" => {
                product_write_client(provider, credentials, fallback).map(Self::Store)
            }
            _ => Err(ConnectorError::new(
                format!("No sync client for provider '{provider}'"),
                400,
                Kind::Permanent,
            )),
        }
    }

    /// `client.storeUrl`.
    pub fn store_url(&self) -> String {
        match self {
            Self::Store(store) => store.store_url(),
            Self::Moneybird(client) => client.store_url(),
            Self::Stripe(client) => client.store_url(),
        }
    }

    /// `client.test()`.
    pub async fn test(&self, http: Option<&OutboundHttp>) -> Result<Tested, String> {
        match self {
            Self::Store(store) => store.test(http).await.map(|store_url| Tested {
                store_url,
                account_name: None,
            }),
            Self::Moneybird(client) => client.test(http).await,
            Self::Stripe(client) => client.test(http).await,
        }
    }
}

impl ProviderClient {
    /// `client.listSync(sync, { page, cursor, limit, modifiedAfter })`.
    pub async fn list_sync(
        &self,
        http: Option<&OutboundHttp>,
        sync: &Value,
        page: u32,
        cursor: Option<&str>,
        limit: u32,
        modified_after: Option<&str>,
    ) -> Result<ListPage, ConnectorError> {
        let setting_key = sync["settingKey"].as_str().unwrap_or_default();
        let sync_name = sync["syncName"].as_str().unwrap_or_default();
        match self {
            Self::Store(StoreClient::Woo(woo)) => {
                woo.list_sync(http, setting_key, page, limit, modified_after)
                    .await
            }
            Self::Store(StoreClient::Shopify(shopify)) => {
                shopify
                    .list_sync(http, setting_key, cursor, limit, modified_after)
                    .await
            }
            Self::Store(StoreClient::Picqer(picqer)) => {
                picqer
                    .list_sync(http, setting_key, page, cursor, limit, modified_after)
                    .await
            }
            Self::Moneybird(client) => {
                client
                    .list_sync(http, sync_name, page, cursor, limit, modified_after)
                    .await
            }
            Self::Stripe(client) => {
                client
                    .list_sync(http, sync_name, cursor, modified_after)
                    .await
            }
        }
    }

    /// `client.hydrateWebhookRecords?.(sync, record)`: `None` for a client
    /// without one (only Stripe re-reads its webhook payloads).
    pub async fn hydrate_webhook_records(
        &self,
        http: Option<&OutboundHttp>,
        sync: &Value,
        record: &Value,
    ) -> Option<Result<Vec<Value>, ConnectorError>> {
        match self {
            Self::Stripe(client) => Some(
                client
                    .hydrate_webhook_records(
                        http,
                        sync["syncName"].as_str().unwrap_or_default(),
                        record,
                    )
                    .await,
            ),
            _ => None,
        }
    }

    /// `client.hasUpdatesSince(resource, since)`.
    pub async fn has_updates_since(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
        since: Option<&str>,
    ) -> Result<bool, ConnectorError> {
        match self {
            Self::Store(StoreClient::Woo(c)) => c.has_updates_since(http, resource, since).await,
            Self::Store(StoreClient::Shopify(c)) => {
                c.has_updates_since(http, resource, since).await
            }
            Self::Store(StoreClient::Picqer(c)) => c.has_updates_since(http, resource, since).await,
            Self::Moneybird(c) => c.has_updates_since(http, resource, since).await,
            Self::Stripe(c) => c.has_updates_since(http, resource, since).await,
        }
    }

    /// `client.countResource(resource)`.
    pub async fn count_resource(
        &self,
        http: Option<&OutboundHttp>,
        resource: &str,
    ) -> Result<f64, ConnectorError> {
        match self {
            Self::Store(StoreClient::Woo(c)) => c.count_resource(http, resource).await,
            Self::Store(StoreClient::Shopify(c)) => c.count_resource(http, resource).await,
            Self::Store(StoreClient::Picqer(c)) => c.count_resource(http, resource).await,
            #[allow(clippy::cast_precision_loss)]
            Self::Moneybird(c) => c.count_resource(http, resource).await.map(|n| n as f64),
            Self::Stripe(_) => Ok(0.0),
        }
    }

    /// `client.registerWebhooks({ deliveryUrl, secret, topics })`.
    pub async fn register_webhooks(
        &self,
        http: Option<&OutboundHttp>,
        delivery_url: &str,
        secret: &str,
        topics: &[String],
    ) -> Result<Vec<WebhookCreated>, ConnectorError> {
        match self {
            Self::Store(StoreClient::Woo(c)) => {
                c.register_webhooks(http, delivery_url, secret, topics)
                    .await
            }
            Self::Store(StoreClient::Shopify(c)) => {
                c.register_webhooks(http, delivery_url, topics).await
            }
            Self::Store(StoreClient::Picqer(c)) => {
                c.register_webhooks(http, delivery_url, secret, topics)
                    .await
            }
            Self::Moneybird(c) => c.register_webhooks(http, delivery_url, topics).await,
            Self::Stripe(c) => c.register_webhooks(http, delivery_url, topics).await,
        }
    }

    /// `client.deleteWebhook(id)`.
    pub async fn delete_webhook(
        &self,
        http: Option<&OutboundHttp>,
        id: &str,
    ) -> Result<(), ConnectorError> {
        match self {
            Self::Store(StoreClient::Woo(c)) => c.delete_webhook(http, id).await,
            Self::Store(StoreClient::Shopify(c)) => c.delete_webhook(http, id).await,
            Self::Store(StoreClient::Picqer(c)) => c.delete_webhook(http, id).await,
            Self::Moneybird(c) => c.delete_webhook(http, id).await,
            Self::Stripe(c) => c.delete_webhook(http, id).await,
        }
    }
}

/// `testConnectorCredentials(provider, credentials)`: a client that cannot
/// be built is a failed test with its message (`Unknown connector …`
/// otherwise).
pub async fn test_connector_credentials(
    provider: &str,
    credentials: &Map<String, Value>,
    http: Option<&OutboundHttp>,
) -> Result<Tested, String> {
    match ProviderClient::new(provider, credentials, None) {
        Ok(client) => client.test(http).await,
        Err(error) => Err(error.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send<T: Send>(_: T) {}

    #[test]
    fn futures_are_send() {
        let creds = Map::new();
        assert_send(test_connector_credentials("stripe", &creds, None));
    }
}
