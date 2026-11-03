//! Store-pushed connector webhooks (`connectors/webhooks.ts` of
//! connect-domain and `webhooks.ts` of `@weldsuite/connectors`): the topics
//! each provider pushes, registering them on connect and removing them on
//! disconnect, the KV mappings the ingress reads (`connconn:<id>`,
//! `stripeacct:<account>`), the signatures, and ingesting one delivery.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_db::{Keyring, PgPool};
use weldsuite_ports::{DynCache, OutboundHttp};

use crate::catalog::{get_connector, syncs};
use crate::clients::decrypt_credentials;
use crate::connections::{
    SettingsUpdate, encrypt_webhook_secret, maybe_decrypt_webhook_secret,
    update_connection_settings,
};
use crate::ingest::{IngestArgs, MoneybirdFiles, StripeFiles, ingest_records};
use crate::provider::ProviderClient;
use crate::sync::{
    RunEnd, SyncEnv, finish_sync_run, mark_connection_error, skipped_financial_account_ids,
    start_sync_run, with_runtime_credentials,
};

pub const STRIPE_DEAUTHORIZED_EVENT: &str = "account.application.deauthorized";
pub const STRIPE_CONNECT_VERIFIED_HEADER: &str = "x-weldsuite-stripe-connect";
const MAPPING_TTL: Duration = Duration::from_secs(86_400 * 365);

/// `ConnectorWebhookTopic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Topic {
    pub topic: String,
    pub setting_key: &'static str,
    /// `create` | `update` | `delete`.
    pub kind: &'static str,
    pub sync_name: Option<&'static str>,
}

const fn t(
    topic: &'static str,
    setting_key: &'static str,
    kind: &'static str,
    sync_name: Option<&'static str>,
) -> (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
) {
    (topic, setting_key, kind, sync_name)
}

type Row = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
);

const WOO: [Row; 9] = [
    t("product.created", "products", "create", None),
    t("product.updated", "products", "update", None),
    t("product.deleted", "products", "delete", None),
    t("order.created", "orders", "create", None),
    t("order.updated", "orders", "update", None),
    t("order.deleted", "orders", "delete", None),
    t("customer.created", "customers", "create", None),
    t("customer.updated", "customers", "update", None),
    t("customer.deleted", "customers", "delete", None),
];

const SHOPIFY: [Row; 9] = [
    t("products/create", "products", "create", None),
    t("products/update", "products", "update", None),
    t("products/delete", "products", "delete", None),
    t("orders/create", "orders", "create", None),
    t("orders/updated", "orders", "update", None),
    t("orders/delete", "orders", "delete", None),
    t("customers/create", "customers", "create", None),
    t("customers/update", "customers", "update", None),
    t("customers/delete", "customers", "delete", None),
];

const MB_C: Option<&str> = Some("moneybird-contacts");
const MB_SI: Option<&str> = Some("moneybird-sales-invoices");
const MB_P: Option<&str> = Some("moneybird-products");
const MB_PI: Option<&str> = Some("moneybird-purchase-invoices");
const MB_R: Option<&str> = Some("moneybird-receipts");
const MB_FA: Option<&str> = Some("moneybird-financial-accounts");

const MONEYBIRD: [Row; 24] = [
    t("contact_created", "contacts", "create", MB_C),
    t("contact_updated", "contacts", "update", MB_C),
    t("contact_destroyed", "contacts", "delete", MB_C),
    t("sales_invoice_created", "invoices", "create", MB_SI),
    t("sales_invoice_updated", "invoices", "update", MB_SI),
    t("sales_invoice_destroyed", "invoices", "delete", MB_SI),
    t(
        "sales_invoice_state_changed_to_open",
        "invoices",
        "update",
        MB_SI,
    ),
    t(
        "sales_invoice_state_changed_to_late",
        "invoices",
        "update",
        MB_SI,
    ),
    t(
        "sales_invoice_state_changed_to_paid",
        "invoices",
        "update",
        MB_SI,
    ),
    t(
        "sales_invoice_state_changed_to_uncollectible",
        "invoices",
        "update",
        MB_SI,
    ),
    t("product_created", "products", "create", MB_P),
    t("product_updated", "products", "update", MB_P),
    t("product_destroyed", "products", "delete", MB_P),
    t("purchase_invoice_created", "bills", "create", MB_PI),
    t("purchase_invoice_updated", "bills", "update", MB_PI),
    t("purchase_invoice_destroyed", "bills", "delete", MB_PI),
    t("receipt_created", "bills", "create", MB_R),
    t("receipt_updated", "bills", "update", MB_R),
    t("receipt_destroyed", "bills", "delete", MB_R),
    t("financial_account_created", "bankAccounts", "create", MB_FA),
    t("financial_account_renamed", "bankAccounts", "update", MB_FA),
    t(
        "financial_account_activated",
        "bankAccounts",
        "update",
        MB_FA,
    ),
    t(
        "financial_account_deactivated",
        "bankAccounts",
        "update",
        MB_FA,
    ),
    t(
        "financial_account_destroyed",
        "bankAccounts",
        "delete",
        MB_FA,
    ),
];

const PQ_P: Option<&str> = Some("picqer-products");
const PQ_I: Option<&str> = Some("picqer-inventory");
const PQ_O: Option<&str> = Some("picqer-orders");
const PQ_PL: Option<&str> = Some("picqer-picklists");
const PQ_S: Option<&str> = Some("picqer-shipments");
const PQ_PO: Option<&str> = Some("picqer-purchase-orders");
const PQ_R: Option<&str> = Some("picqer-returns");

const PICQER: [Row; 30] = [
    t("products.created", "products", "create", PQ_P),
    t("products.changed", "products", "update", PQ_P),
    t("products.free_stock_changed", "inventory", "update", PQ_I),
    t("products.stock_changed", "inventory", "update", PQ_I),
    t(
        "products.stock_on_location_changed",
        "inventory",
        "update",
        PQ_I,
    ),
    t("orders.created", "orders", "create", PQ_O),
    t("orders.status_changed", "orders", "update", PQ_O),
    t("orders.completed", "orders", "update", PQ_O),
    t("orders.closed", "orders", "update", PQ_O),
    t("orders.allocated", "orders", "update", PQ_O),
    t("orders.paused", "orders", "update", PQ_O),
    t("orders.resumed", "orders", "update", PQ_O),
    t("picklists.created", "picklists", "create", PQ_PL),
    t("picklists.changed", "picklists", "update", PQ_PL),
    t("picklists.closed", "picklists", "update", PQ_PL),
    t("picklists.cancelled", "picklists", "update", PQ_PL),
    t("picklists.paused", "picklists", "update", PQ_PL),
    t("picklists.resumed", "picklists", "update", PQ_PL),
    t("picklists.shipments.created", "shipments", "create", PQ_S),
    t("picklists.shipments.cancelled", "shipments", "update", PQ_S),
    t("purchase_orders.created", "purchaseOrders", "create", PQ_PO),
    t("purchase_orders.changed", "purchaseOrders", "update", PQ_PO),
    t(
        "purchase_orders.purchased",
        "purchaseOrders",
        "update",
        PQ_PO,
    ),
    t("receipts.completed", "purchaseOrders", "update", PQ_PO),
    t("returns.created", "returns", "create", PQ_R),
    t("returns.changed", "returns", "update", PQ_R),
    t("returns.status_changed", "returns", "update", PQ_R),
    t("returns.products_received", "returns", "update", PQ_R),
    t(
        "movements.moved",
        "movements",
        "update",
        Some("picqer-movements"),
    ),
    t(
        "location_stock_counts.completed",
        "stockCounts",
        "update",
        Some("picqer-stock-counts"),
    ),
];

const ST_I: Option<&str> = Some("stripe-invoices");

const STRIPE: [Row; 7] = [
    t("invoice.finalized", "invoices", "create", ST_I),
    t("invoice.updated", "invoices", "update", ST_I),
    t("invoice.paid", "invoices", "update", ST_I),
    t("invoice.payment_succeeded", "invoices", "update", ST_I),
    t("invoice.voided", "invoices", "update", ST_I),
    t("invoice.marked_uncollectible", "invoices", "update", ST_I),
    t(
        "payout.paid",
        "bankTransactions",
        "update",
        Some("stripe-balance-transactions"),
    ),
];

fn rows(provider: &str) -> &'static [Row] {
    match provider {
        "woocommerce" => &WOO,
        "shopify" => &SHOPIFY,
        "moneybird" => &MONEYBIRD,
        "stripe" => &STRIPE,
        "picqer" => &PICQER,
        _ => &[],
    }
}

fn topic_of(row: &Row) -> Topic {
    Topic {
        topic: row.0.to_owned(),
        setting_key: row.1,
        kind: row.2,
        sync_name: row.3,
    }
}

/// `webhookTopicsFor(provider)`.
pub fn topics_for(provider: &str) -> Vec<Topic> {
    rows(provider).iter().map(topic_of).collect()
}

const MONEYBIRD_PREFIXES: [(&str, &str, &str); 6] = [
    ("contact_", "contacts", "moneybird-contacts"),
    ("sales_invoice_", "invoices", "moneybird-sales-invoices"),
    ("product_", "products", "moneybird-products"),
    ("purchase_invoice_", "bills", "moneybird-purchase-invoices"),
    ("receipt_", "bills", "moneybird-receipts"),
    (
        "financial_account_",
        "bankAccounts",
        "moneybird-financial-accounts",
    ),
];

/// `matchWebhookTopic(provider, topic)`.
pub fn match_topic(provider: &str, topic: &str) -> Option<Topic> {
    let normalised = weldsuite_kit::validation::js_trim(topic).to_lowercase();
    let list = rows(provider);
    if let Some(row) = list.iter().find(|row| row.0 == normalised) {
        return Some(topic_of(row));
    }
    if provider != "moneybird" {
        return None;
    }
    let kind = if normalised.contains("destroy") {
        "delete"
    } else {
        "update"
    };
    let prefixed = list.iter().find(|row| {
        let parts: Vec<&str> = row.0.split('_').collect();
        let prefix = format!("{}_", parts[..parts.len() - 1].join("_"));
        normalised.starts_with(&prefix)
    });
    if let Some(row) = prefixed {
        return Some(Topic {
            topic: normalised,
            setting_key: row.1,
            kind,
            sync_name: row.3,
        });
    }
    let fallback = MONEYBIRD_PREFIXES
        .iter()
        .find(|(prefix, _, _)| normalised.starts_with(prefix))?;
    Some(Topic {
        topic: normalised,
        setting_key: fallback.1,
        kind,
        sync_name: Some(fallback.2),
    })
}

/// `connectorWebhookDeliveryUrl(baseUrl, connectionId)`.
pub fn delivery_url(base_url: &str, connection_id: &str) -> String {
    format!(
        "{}/webhooks/connectors/{connection_id}",
        base_url.trim_end_matches('/')
    )
}

/// `connectorWebhookKvKey(connectionId)`.
pub fn connection_kv_key(connection_id: &str) -> String {
    format!("connconn:{connection_id}")
}

/// `stripeAccountKvKey(accountId)`.
pub fn stripe_account_kv_key(account_id: &str) -> String {
    format!("stripeacct:{account_id}")
}

/// `connectorWebhookBaseUrl(env)`.
pub fn webhook_base_url(explicit: Option<&str>, environment: Option<&str>) -> String {
    if let Some(explicit) = explicit.filter(|e| !e.is_empty()) {
        return explicit.trim_end_matches('/').to_owned();
    }
    match environment {
        Some("production") => "https://integration-webhooks.weldsuite.org".to_owned(),
        Some("test") => "https://integration-webhooks-test.weldsuite.org".to_owned(),
        _ => "http://localhost:8787".to_owned(),
    }
}

/// `generateWebhookSecret()`: 32 random bytes, base64.
pub fn generate_webhook_secret() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(secret: &str, body: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(body.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `timingSafeEqual(left, right)` over code points.
fn timing_safe_equal(left: &str, right: &str) -> bool {
    let l: Vec<u16> = left.encode_utf16().collect();
    let r: Vec<u16> = right.encode_utf16().collect();
    if l.len() != r.len() {
        return false;
    }
    l.iter().zip(&r).fold(0u16, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn verify_base64(secret: &str, body: &str, signature: Option<&str>) -> bool {
    let Some(signature) = signature.filter(|s| !s.is_empty()) else {
        return false;
    };
    let expected = base64::engine::general_purpose::STANDARD.encode(hmac(secret, body));
    timing_safe_equal(&expected, weldsuite_kit::validation::js_trim(signature))
}

fn verify_timestamped(secret: &str, body: &str, signature: Option<&str>) -> bool {
    let Some(signature) = signature.filter(|s| !s.is_empty()) else {
        return false;
    };
    let parts: Vec<&str> = signature
        .split(',')
        .map(weldsuite_kit::validation::js_trim)
        .collect();
    let Some(timestamp) = parts.iter().find_map(|p| p.strip_prefix("t=")) else {
        return false;
    };
    let digests: Vec<String> = parts
        .iter()
        .filter_map(|p| p.strip_prefix("v1="))
        .map(str::to_lowercase)
        .collect();
    if digests.is_empty() || timestamp.is_empty() {
        return false;
    }
    let ts = weldsuite_kit::validation::js_number(timestamp);
    if !ts.is_finite() {
        return false;
    }
    let now = (crate::js::now_ms() / 1000.0).floor();
    if (now - ts).abs() > 300.0 {
        return false;
    }
    let expected = hex::encode(hmac(secret, &format!("{timestamp}.{body}")));
    digests.iter().any(|d| timing_safe_equal(&expected, d))
}

/// `verifyConnectorWebhook({ provider, secret, body, signature })`.
pub fn verify(provider: &str, secret: &str, body: &str, signature: Option<&str>) -> bool {
    match provider {
        "shopify" | "woocommerce" | "picqer" => verify_base64(secret, body, signature),
        "moneybird" | "stripe" => verify_timestamped(secret, body, signature),
        _ => false,
    }
}

/// `readWebhookTopicFromHeaders(provider, headers)`.
pub fn topic_from_headers(provider: &str, headers: &http::HeaderMap) -> Option<String> {
    let name = match provider {
        "woocommerce" => "x-wc-webhook-topic",
        "shopify" => "x-shopify-topic",
        _ => return None,
    };
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// `readWebhookTopicFromPayload(provider, payload)`.
pub fn topic_from_payload(provider: &str, payload: &Value) -> Option<String> {
    let key = match provider {
        "moneybird" => "action",
        "picqer" => "event",
        "stripe" => "type",
        _ => return None,
    };
    let value = payload.get(key)?.as_str()?;
    let trimmed = weldsuite_kit::validation::js_trim(value);
    (!trimmed.is_empty()).then(|| trimmed.to_lowercase())
}

/// `unwrapWebhookPayload(provider, payload)`.
pub fn unwrap_payload(provider: &str, payload: &Value) -> Value {
    let inner = match provider {
        "moneybird" => payload.get("entity"),
        "picqer" => payload.get("data"),
        "stripe" => payload.get("data").and_then(|d| d.get("object")),
        _ => None,
    };
    inner
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| payload.clone())
}

/// `readWebhookSignatureFromHeaders(provider, headers)`.
pub fn signature_from_headers(provider: &str, headers: &http::HeaderMap) -> Option<String> {
    let name = match provider {
        "woocommerce" => "x-wc-webhook-signature",
        "shopify" => "x-shopify-hmac-sha256",
        "moneybird" => "moneybird-signature",
        "picqer" => "x-picqer-signature",
        "stripe" => "stripe-signature",
        _ => return None,
    };
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// OAuth Stripe connections report through the platform's Connect webhook.
fn uses_stripe_connect_webhook(connection: &Value, credentials: &Map<String, Value>) -> bool {
    text(connection, "provider") == Some("stripe")
        && credentials
            .get("apiKey")
            .is_none_or(|k| !crate::js::truthy(k))
}

/// `enabledConnectorSyncs(connector, enabled)`.
pub fn enabled_syncs(connector: &Value, enabled: Option<&Value>) -> Vec<Value> {
    let enabled: Vec<&str> = enabled
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let all = syncs(connector);
    if enabled.is_empty() {
        return all.to_vec();
    }
    all.iter()
        .filter(|s| {
            enabled
                .iter()
                .any(|k| s["syncName"].as_str() == Some(*k) || s["settingKey"].as_str() == Some(*k))
        })
        .cloned()
        .collect()
}

/// What `registerConnectionWebhooks` answers.
pub struct Registered {
    pub registrations: Vec<Value>,
    pub warning: Option<String>,
}

/// `registerConnectionWebhooks({ connection, credentials, webhookSecret })`.
pub async fn register_connection_webhooks(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    keyring: &Keyring,
    base_url: &str,
    connection: &Value,
    credentials: &Map<String, Value>,
    webhook_secret: &str,
) -> Result<Registered, String> {
    if uses_stripe_connect_webhook(connection, credentials) {
        return Ok(Registered {
            registrations: Vec::new(),
            warning: None,
        });
    }
    let id = text(connection, "id").unwrap_or_default();
    let url = delivery_url(base_url, id);
    if url.starts_with("http://") {
        return Ok(Registered {
            registrations: Vec::new(),
            warning: Some(
                "Webhooks need a public HTTPS URL. Use Sync now until this environment is reachable from the store."
                    .to_owned(),
            ),
        });
    }
    let provider = text(connection, "provider").unwrap_or_default();
    let Some(connector) = get_connector(provider) else {
        return Err(format!("Unknown connector '{provider}'"));
    };
    let enabled = enabled_syncs(connector, connection.get("enabled_syncs"));
    let allowed: Vec<&str> = enabled
        .iter()
        .filter_map(|s| s["settingKey"].as_str())
        .collect();
    let topics: Vec<String> = topics_for(provider)
        .into_iter()
        .filter(|topic| allowed.contains(&topic.setting_key))
        .map(|topic| topic.topic)
        .collect();
    if topics.is_empty() {
        return Ok(Registered {
            registrations: Vec::new(),
            warning: None,
        });
    }
    let client = ProviderClient::new(
        provider,
        credentials,
        text(connection, "external_account_id"),
    )
    .map_err(|error| error.message)?;
    let mut registrations = Vec::new();
    let mut failures = 0;
    let mut provider_secret: Option<String> = None;
    match client
        .register_webhooks(http, &url, webhook_secret, &topics)
        .await
    {
        Ok(created) => {
            for row in created {
                if !row.id.is_empty() {
                    registrations.push(json!({ "id": row.id, "topic": row.topic, "deliveryUrl": row.delivery_url }));
                }
                if let Some(secret) = row.secret.filter(|s| !s.is_empty()) {
                    provider_secret = Some(secret);
                }
            }
        }
        Err(error) => {
            failures = topics.len();
            tracing::error!(error = %error.message, "[connectors/webhooks] register failed");
        }
    }
    let sealed = encrypt_webhook_secret(
        provider_secret.as_deref().unwrap_or(webhook_secret),
        keyring,
    )?;
    update_connection_settings(
        db,
        id,
        &SettingsUpdate {
            webhook_registrations: Some(Value::Array(registrations.clone())),
            webhook_secret: Some(Some(sealed)),
            ..SettingsUpdate::default()
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let warning = if failures > 0 {
        Some(format!(
            "Connected, but {failures} webhook(s) failed to register. Use Sync now until the store can reach WeldSuite."
        ))
    } else if registrations.is_empty() {
        Some("Connected without webhooks. Use Sync now to import, then reconnect to enable push updates.".to_owned())
    } else {
        None
    };
    Ok(Registered {
        registrations,
        warning,
    })
}

/// `unregisterConnectionWebhooks({ connection, credentials })`: best effort.
pub async fn unregister_connection_webhooks(
    http: Option<&OutboundHttp>,
    connection: &Value,
    credentials: &Map<String, Value>,
) {
    let registrations = connection
        .get("webhook_registrations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if registrations.is_empty() {
        return;
    }
    let provider = text(connection, "provider").unwrap_or_default();
    let client = match ProviderClient::new(
        provider,
        credentials,
        text(connection, "external_account_id"),
    ) {
        Ok(client) => client,
        Err(error) => {
            tracing::error!(error = %error.message, "[connectors/webhooks] client for unregister failed");
            return;
        }
    };
    for registration in registrations {
        let id = registration
            .get("id")
            .map(crate::clients::as_text)
            .unwrap_or_default();
        if let Err(error) = client.delete_webhook(http, &id).await {
            tracing::error!(error = %error.message, id, "[connectors/webhooks] unregister failed");
        }
    }
}

/// `putConnectorWebhookMapping({ connectionId, workspaceId, provider })`.
pub async fn put_webhook_mapping(
    cache: &Arc<dyn DynCache>,
    connection_id: &str,
    workspace_id: &str,
    provider: &str,
) -> Result<(), String> {
    // `JSON.stringify({ workspaceId, provider })`, in that order.
    let entry = format!(
        "{{\"workspaceId\":{},\"provider\":{}}}",
        Value::String(workspace_id.to_owned()),
        Value::String(provider.to_owned())
    );
    cache
        .put_boxed(&connection_kv_key(connection_id), &entry, Some(MAPPING_TTL))
        .await
        .map_err(|error| error.to_string())
}

/// `deleteConnectorWebhookMapping(env, connectionId)`.
pub async fn delete_webhook_mapping(
    cache: &Arc<dyn DynCache>,
    connection_id: &str,
) -> Result<(), String> {
    cache
        .delete_boxed(&connection_kv_key(connection_id))
        .await
        .map_err(|error| error.to_string())
}

async fn read_stripe_account_entry(cache: &Arc<dyn DynCache>, account_id: &str) -> Vec<Value> {
    let raw = cache
        .get_boxed(&stripe_account_kv_key(account_id))
        .await
        .ok()
        .flatten();
    raw.and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

/// The `stripeacct:` entries as `JSON.stringify` writes them: each
/// `{ workspaceId, connectionId }` in that order.
fn account_entries_json(entries: &[Value]) -> String {
    let items: Vec<String> = entries
        .iter()
        .map(|e| {
            format!(
                "{{\"workspaceId\":{},\"connectionId\":{}}}",
                e.get("workspaceId").cloned().unwrap_or(Value::Null),
                e.get("connectionId").cloned().unwrap_or(Value::Null)
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// `putStripeAccountMapping({ accountId, workspaceId, connectionId })`.
pub async fn put_stripe_account_mapping(
    cache: &Arc<dyn DynCache>,
    account_id: &str,
    workspace_id: &str,
    connection_id: &str,
) -> Result<(), String> {
    let mut entries: Vec<Value> = read_stripe_account_entry(cache, account_id)
        .await
        .into_iter()
        .filter(|e| e.get("connectionId").and_then(Value::as_str) != Some(connection_id))
        .collect();
    entries.push(json!({ "workspaceId": workspace_id, "connectionId": connection_id }));
    cache
        .put_boxed(
            &stripe_account_kv_key(account_id),
            &account_entries_json(&entries),
            Some(MAPPING_TTL),
        )
        .await
        .map_err(|error| error.to_string())
}

/// `deleteStripeAccountMapping(env, accountId, connectionId)`.
pub async fn delete_stripe_account_mapping(
    cache: &Arc<dyn DynCache>,
    account_id: &str,
    connection_id: &str,
) -> Result<(), String> {
    let entries: Vec<Value> = read_stripe_account_entry(cache, account_id)
        .await
        .into_iter()
        .filter(|e| e.get("connectionId").and_then(Value::as_str) != Some(connection_id))
        .collect();
    let key = stripe_account_kv_key(account_id);
    if entries.is_empty() {
        return cache
            .delete_boxed(&key)
            .await
            .map_err(|error| error.to_string());
    }
    cache
        .put_boxed(&key, &account_entries_json(&entries), Some(MAPPING_TTL))
        .await
        .map_err(|error| error.to_string())
}

/// What a delivery is answered with (`{ ok, status, message }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookResult {
    pub ok: bool,
    pub status: u16,
    pub message: String,
}

fn result(ok: bool, status: u16, message: impl Into<String>) -> WebhookResult {
    WebhookResult {
        ok,
        status,
        message: message.into(),
    }
}

/// `processConnectorWebhook(...)`: one delivery, verified and ingested.
#[allow(clippy::too_many_arguments)] // `processConnectorWebhook`'s arguments
pub async fn process_connector_webhook(
    db: &PgPool,
    env: &SyncEnv,
    connection: &Value,
    owner_id: &str,
    workspace_id: &str,
    raw_body: &str,
    headers: &http::HeaderMap,
) -> Result<WebhookResult, sqlx::Error> {
    if connection["status"] == "paused" || !connection["deleted_at"].is_null() {
        return Ok(result(true, 200, "ignored paused connection"));
    }
    let provider = text(connection, "provider").unwrap_or_default();
    let id = text(connection, "id").unwrap_or_default();
    let stored = decrypt_credentials(connection.get("credentials"), &env.keyring);
    let pre_verified = uses_stripe_connect_webhook(connection, &stored)
        && headers
            .get(STRIPE_CONNECT_VERIFIED_HEADER)
            .and_then(|v| v.to_str().ok())
            == Some("verified");
    if !pre_verified {
        let decrypted =
            maybe_decrypt_webhook_secret(text(connection, "webhook_secret"), &env.keyring);
        let secret = if provider == "shopify" {
            stored
                .get("apiSecret")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .or(decrypted)
        } else {
            decrypted
        };
        let Some(secret) = secret.filter(|s| !s.is_empty()) else {
            return Ok(result(false, 401, "missing webhook secret"));
        };
        if !verify(
            provider,
            &secret,
            raw_body,
            signature_from_headers(provider, headers).as_deref(),
        ) {
            return Ok(result(false, 401, "invalid webhook signature"));
        }
    }
    let credentials =
        with_runtime_credentials(connection, stored, env.stripe_secret_key.as_deref());
    let Ok(payload) = serde_json::from_str::<Value>(raw_body) else {
        return Ok(result(false, 400, "invalid JSON body"));
    };
    if provider == "stripe"
        && payload.get("type").and_then(Value::as_str) == Some(STRIPE_DEAUTHORIZED_EVENT)
    {
        mark_connection_error(
            db,
            id,
            "auth_error",
            "The Stripe account disconnected WeldSuite. Connect it again to resume the import.",
        )
        .await?;
        return Ok(result(true, 200, "deauthorized"));
    }
    // The topic and the sync it feeds.
    let Some(topic_name) =
        topic_from_headers(provider, headers).or_else(|| topic_from_payload(provider, &payload))
    else {
        return Ok(result(false, 400, "missing webhook topic"));
    };
    let Some(topic) = match_topic(provider, &topic_name) else {
        return Ok(result(true, 200, format!("ignored topic {topic_name}")));
    };
    let connector = get_connector(provider);
    let sync = connector.and_then(|c| {
        syncs(c)
            .iter()
            .find(|s| match topic.sync_name {
                Some(name) => s["syncName"].as_str() == Some(name),
                None => s["settingKey"].as_str() == Some(topic.setting_key),
            })
            .cloned()
    });
    let (Some(connector), Some(sync)) = (connector, sync) else {
        return Ok(result(true, 200, "topic not enabled"));
    };
    if !enabled_syncs(connector, connection.get("enabled_syncs"))
        .iter()
        .any(|s| s["syncName"] == sync["syncName"])
    {
        return Ok(result(true, 200, "sync disabled"));
    }
    let key = sync["settingKey"].as_str().unwrap_or_default();
    let direction = connection
        .get("object_sync_directions")
        .and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .or_else(|| text(connection, "direction"))
        .unwrap_or("inbound");
    if direction != "inbound" && direction != "bidirectional" {
        return Ok(result(true, 200, "inbound sync disabled for object"));
    }
    let model = sync["model"].as_str().unwrap_or_default().to_owned();
    let run_id = start_sync_run(
        db,
        id,
        sync["syncName"].as_str().unwrap_or_default(),
        &model,
        "webhook",
        "WEBHOOK",
    )
    .await?;
    let outcome: Result<crate::ingest::IngestResult, String> = async {
        let client = ProviderClient::new(
            provider,
            &credentials,
            text(connection, "external_account_id"),
        )
        .map_err(|error| error.message)?;
        let record = unwrap_payload(provider, &payload);
        let records = match client
            .hydrate_webhook_records(env.http.as_ref(), &sync, &record)
            .await
        {
            Some(Ok(records)) => records,
            Some(Err(error)) => return Err(error.message),
            None => vec![record.clone()],
        };
        let moneybird_files = match (&client, &env.storage) {
            (ProviderClient::Moneybird(mb), Some(storage)) => Some(MoneybirdFiles {
                client: mb.clone(),
                storage: Arc::clone(storage),
                workspace_id: workspace_id.to_owned(),
                budget: Arc::new(std::sync::atomic::AtomicI64::new(
                    crate::ingest::MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET,
                )),
            }),
            _ => None,
        };
        let stripe_files = match (&client, &env.storage) {
            (ProviderClient::Stripe(stripe), Some(storage)) => Some(StripeFiles {
                client: stripe.clone(),
                storage: Arc::clone(storage),
                workspace_id: workspace_id.to_owned(),
                budget: Arc::new(std::sync::atomic::AtomicI64::new(
                    crate::ingest::STRIPE_PDF_DOWNLOAD_BUDGET,
                )),
            }),
            _ => None,
        };
        let skip = skipped_financial_account_ids(connection);
        let entity_id = credentials
            .get("entityId")
            .and_then(Value::as_str)
            .map(|e| weldsuite_kit::validation::js_trim(e).to_owned())
            .filter(|e| !e.is_empty());
        let store_url = client.store_url();
        ingest_records(&IngestArgs {
            db,
            http: env.http.as_ref(),
            events: &env.events,
            connection_id: id,
            provider,
            display_name: text(connection, "display_name"),
            store_url: Some(&store_url),
            sync: &sync,
            records,
            owner_id,
            workspace_id,
            entity_id: entity_id.as_deref(),
            force_deleted: topic.kind == "delete",
            moneybird_files: moneybird_files.as_ref(),
            stripe_files: stripe_files.as_ref(),
            skip_financial_account_ids: &skip,
        })
        .await
        .map_err(|error| error.to_string())
    }
    .await;
    match outcome {
        Ok(ingested) => {
            let error = (ingested.failed > 0).then(|| {
                ingested
                    .error_samples
                    .first()
                    .map_or_else(|| "ingest failed".to_owned(), |(_, m)| m.clone())
            });
            finish_sync_run(
                db,
                &run_id,
                id,
                &RunEnd {
                    status: if ingested.failed > 0 {
                        "partial"
                    } else {
                        "success"
                    },
                    applied: &ingested,
                    error,
                    watermarks: Vec::new(),
                },
            )
            .await?;
            if provider == "stripe" && ingested.created + ingested.modified > 0 {
                crate::moneybird_push::push_after_stripe_ingest(db, env, id).await;
            }
            Ok(result(true, 200, "ingested"))
        }
        Err(message) => {
            finish_sync_run(
                db,
                &run_id,
                id,
                &RunEnd {
                    status: "error",
                    applied: &crate::ingest::IngestResult::default(),
                    error: Some(message.clone()),
                    watermarks: Vec::new(),
                },
            )
            .await?;
            Ok(result(false, 500, message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_and_signatures() {
        assert_eq!(
            match_topic("woocommerce", " Product.Updated ").map(|t| t.kind),
            Some("update")
        );
        let mb = match_topic("moneybird", "sales_invoice_send_email").expect("prefix");
        assert_eq!(
            (mb.setting_key, mb.kind, mb.sync_name),
            ("invoices", "update", MB_SI)
        );
        assert_eq!(
            match_topic("moneybird", "contact_destroyed").map(|t| t.kind),
            Some("delete")
        );
        assert!(match_topic("shopify", "carts/create").is_none());
        let body = r#"{"id":1}"#;
        let sig = base64::engine::general_purpose::STANDARD.encode(hmac("s", body));
        assert!(verify("woocommerce", "s", body, Some(&sig)));
        assert!(!verify("woocommerce", "x", body, Some(&sig)));
        let now = (crate::js::now_ms() / 1000.0).floor();
        let digest = hex::encode(hmac("s", &format!("{now}.{body}")));
        assert!(verify(
            "stripe",
            "s",
            body,
            Some(&format!("t={now},v1={digest}"))
        ));
        assert_eq!(generate_webhook_secret().len(), 44);
    }
}
