//! The storefront router as the server mounts it, over a real master and
//! tenant schema (`WELDSUITE_TEST_MASTER_URL`, `WELDSUITE_TEST_TENANT_URL`,
//! built by `scripts/rust-test-db.ts`), a cache that counts, and an event bus
//! that records. Channels, keys, products, rates and prices go straight into
//! the databases with SQL.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{HeaderMap, Request, StatusCode, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use weldsuite_commerce::storefront::{StorefrontState, storefront_router};
use weldsuite_db::{Keyring, PgPool, WorkspaceConfig, Workspaces, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_ports::{DynCache, DynEventBus, MemoryCache, RecordingEventBus};

pub(crate) const WORKSPACE: &str = "ws_sf_test";
pub(crate) const SELLER: &str = "ent_sf_test_nl";

pub(crate) struct Env {
    pub(crate) master: PgPool,
    pub(crate) tenant: PgPool,
    workspaces: Arc<Workspaces>,
}

/// The shared databases, or `None` to skip.
pub(crate) async fn env() -> Option<Env> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let master = master_pool(&master_url, 4).expect("master pool");
    let tenant = master_pool(&tenant_url, 1).expect("tenant pool");
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id, database_url) \
         values ($1, 'Storefront tests', 'storefront-tests', 'org_sf_test', $2) \
         on conflict do nothing",
    )
    .bind(WORKSPACE)
    .bind(&tenant_url)
    .execute(&master)
    .await
    .expect("workspace");
    // (Tests starting together on a fresh database race on the insert; the
    // row is the same for all of them.)
    sqlx::query("update workspaces set database_url = $2 where id = $1")
        .bind(WORKSPACE)
        .bind(&tenant_url)
        .execute(&master)
        .await
        .expect("workspace url");
    seller(&tenant).await;
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig {
            // One connection, as in production: a request never needs a second.
            tenant_max_connections: 1,
            ..WorkspaceConfig::default()
        },
    ));
    Some(Env {
        master,
        tenant,
        workspaces,
    })
}

async fn seller(db: &PgPool) {
    let mut tx = db.begin().await.expect("tx");
    sqlx::query("select pg_advisory_xact_lock(hashtext('weldcommerce:settings'))")
        .execute(&mut *tx)
        .await
        .expect("lock");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
         values ($1, 'Storefront test seller', 'NL', 'EUR', true) \
         on conflict (id) do update set deleted_at = null, is_active = true, jurisdiction_code = 'NL'",
    )
    .bind(SELLER)
    .execute(&mut *tx)
    .await
    .expect("entity");
    sqlx::query(
        "insert into legal_entity_registrations (id, entity_id, type, number) \
         values ('ler_sf_test_oss', $1, 'oss', 'NL123456789B01') \
         on conflict (id) do update set deleted_at = null, valid_from = null, valid_to = null",
    )
    .bind(SELLER)
    .execute(&mut *tx)
    .await
    .expect("oss");
    sqlx::query(
        "insert into commerce_settings (id) select 'cset_sf_test' \
         where not exists (select 1 from commerce_settings)",
    )
    .execute(&mut *tx)
    .await
    .expect("settings row");
    sqlx::query("update commerce_settings set default_entity_id = $1")
        .bind(SELLER)
        .execute(&mut *tx)
        .await
        .expect("default entity");
    tx.commit().await.expect("commit");
}

/// A value no other test (or run) uses.
pub(crate) fn fresh(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!(
        "{prefix}{nanos:x}{}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

pub(crate) struct App {
    router: Router,
    pub(crate) bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

impl Env {
    pub(crate) fn app(&self) -> App {
        let bus = Arc::new(RecordingEventBus::new());
        let tracker = TaskTracker::new();
        let state = StorefrontState {
            events: EntityEventPublisher::new(
                Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
                tracker.clone(),
            ),
            http: None,
            master: self.master.clone(),
            workspaces: Arc::clone(&self.workspaces),
            cache: Some(Arc::new(MemoryCache::default()) as Arc<dyn DynCache>),
            trusted_proxies: 1,
            payments: weldsuite_commerce::PaymentsConfig::default(),
        };
        App {
            router: storefront_router(state),
            bus,
            tracker,
        }
    }

    /// A channel; its id.
    pub(crate) async fn channel(&self, extra: &Value) -> String {
        let id = fresh("chan_");
        let get = |key: &str, default: Value| extra.get(key).cloned().unwrap_or(default);
        sqlx::query(
            "insert into commerce_channels (id, name, type, audience, status, currency, \
               prices_include_tax, selling_countries, guest_checkout, payment_methods) \
             values ($1, 'Test shop', 'storefront', $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(&id)
        .bind(
            get("audience", json!("b2c"))
                .as_str()
                .unwrap_or("b2c")
                .to_owned(),
        )
        .bind(
            get("status", json!("active"))
                .as_str()
                .unwrap_or("active")
                .to_owned(),
        )
        .bind(
            get("currency", json!("EUR"))
                .as_str()
                .unwrap_or("EUR")
                .to_owned(),
        )
        .bind(
            get("pricesIncludeTax", json!(true))
                .as_bool()
                .unwrap_or(true),
        )
        .bind(get("countries", json!(["NL", "DE", "BE"])))
        .bind(get("guestCheckout", json!(true)).as_bool().unwrap_or(true))
        .bind(get("paymentMethods", json!(["mollie"])))
        .execute(&self.tenant)
        .await
        .expect("channel");
        id
    }

    /// A key of `kind` for the channel; its secret.
    pub(crate) async fn key(&self, channel: &str, kind: &str, origins: &[&str]) -> String {
        let secret = format!(
            "{}{}",
            if kind == "private" { "wcs_" } else { "wcp_" },
            fresh("k")
        );
        let hash = hex::encode(Sha256::digest(secret.as_bytes()));
        let id = fresh("ckey_");
        sqlx::query(
            "insert into commerce_channel_keys (id, channel_id, kind, name, key_hash, key_prefix, allowed_origins) \
             values ($1, $2, $3, 'test', $4, $5, $6)",
        )
        .bind(&id)
        .bind(channel)
        .bind(kind)
        .bind(&hash)
        .bind(&secret[..16.min(secret.len())])
        .bind(json!(origins))
        .execute(&self.tenant)
        .await
        .expect("tenant key");
        sqlx::query(
            "insert into storefront_key_registry (id, key_hash, kind, key_prefix, workspace_id, channel_id, allowed_origins) \
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&id)
        .bind(&hash)
        .bind(kind)
        .bind(&secret[..16.min(secret.len())])
        .bind(WORKSPACE)
        .bind(channel)
        .bind(json!(origins))
        .execute(&self.master)
        .await
        .expect("registry key");
        secret
    }

    pub(crate) async fn revoke(&self, secret: &str) {
        let hash = hex::encode(Sha256::digest(secret.as_bytes()));
        sqlx::query("update storefront_key_registry set revoked_at = now() where key_hash = $1")
            .bind(&hash)
            .execute(&self.master)
            .await
            .expect("revoke");
    }

    /// A product; its id. `extra` overrides columns by name (`price`,
    /// `currency`, `status`, `qty`, `track`, `backorder`, `vendor`,
    /// `hasVariants`, `vat`, `slug`, `name`).
    pub(crate) async fn product(&self, extra: &Value) -> String {
        let id = fresh("prod_");
        let text = |key: &str, default: &str| {
            extra
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(default)
                .to_owned()
        };
        sqlx::query(
            "insert into products (id, name, slug, sku, price, currency, status, track_inventory, \
               inventory_quantity, allow_backorder, vendor, has_variants, vat_category, cost_price, \
               visibility, requires_shipping) \
             values ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11, $12, $13, 7.77, $14, $15)",
        )
        .bind(&id)
        .bind(text("name", "Widget"))
        .bind(extra.get("slug").and_then(Value::as_str).map_or_else(|| fresh("w-"), str::to_owned))
        .bind(fresh("SKU-"))
        .bind(text("price", "12.10"))
        .bind(text("currency", "EUR"))
        .bind(text("status", "active"))
        .bind(extra.get("track").and_then(Value::as_bool).unwrap_or(false))
        .bind(i32::try_from(extra.get("qty").and_then(Value::as_i64).unwrap_or(0)).expect("qty"))
        .bind(extra.get("backorder").and_then(Value::as_bool).unwrap_or(false))
        .bind(text("vendor", "Acme"))
        .bind(extra.get("hasVariants").and_then(Value::as_bool).unwrap_or(false))
        .bind(text("vat", "standard"))
        .bind(text("visibility", "visible"))
        .bind(extra.get("requiresShipping").and_then(Value::as_bool).unwrap_or(true))
        .execute(&self.tenant)
        .await
        .expect("product");
        id
    }

    /// A variant of `product`; its id.
    pub(crate) async fn variant(
        &self,
        product: &str,
        name: &str,
        price: Option<&str>,
        qty: i32,
    ) -> String {
        let id = fresh("var_");
        sqlx::query(
            "insert into product_variants (id, product_id, name, sku, price, currency, track_inventory, \
               inventory_quantity, status, option_values) \
             values ($1, $2, $3, $4, $5::numeric, 'EUR', true, $6, 'active', $7)",
        )
        .bind(&id)
        .bind(product)
        .bind(name)
        .bind(fresh("VSKU-"))
        .bind(price)
        .bind(qty)
        .bind(json!([{ "name": "Size", "value": name }]))
        .execute(&self.tenant)
        .await
        .expect("variant");
        id
    }

    pub(crate) async fn price_row(&self, product: &str, currency: &str, price: &str) {
        sqlx::query(
            "insert into product_prices (id, product_id, currency, price) values ($1, $2, $3, $4::numeric)",
        )
        .bind(fresh("pp_"))
        .bind(product)
        .bind(currency)
        .bind(price)
        .execute(&self.tenant)
        .await
        .expect("price");
    }

    /// A flat shipping rate; its id.
    pub(crate) async fn rate(
        &self,
        channel: &str,
        countries: &[&str],
        price: &str,
        free_from: Option<&str>,
    ) -> String {
        let id = fresh("srate_");
        sqlx::query(
            "insert into commerce_shipping_rates (id, channel_id, zone_name, countries, name, price, \
               currency, free_shipping_threshold) \
             values ($1, $2, 'Zone', $3, 'Post', $4::numeric, 'EUR', $5::numeric)",
        )
        .bind(&id)
        .bind(channel)
        .bind(json!(countries))
        .bind(price)
        .bind(free_from)
        .execute(&self.tenant)
        .await
        .expect("rate");
        id
    }

    /// A percentage discount code, active; its id.
    pub(crate) async fn discount(&self, code: &str, percent: &str) -> String {
        let id = fresh("disc_");
        sqlx::query(
            "insert into discounts (id, name, code, type, value, currency, applies_to, status) \
             values ($1, 'Test', $2, 'percentage', $3::numeric, 'EUR', 'all', 'active')",
        )
        .bind(&id)
        .bind(code)
        .bind(percent)
        .execute(&self.tenant)
        .await
        .expect("discount");
        id
    }

    pub(crate) async fn vies(&self, number: &str, valid: bool) {
        sqlx::query(
            "insert into vies_checks (id, vat_number, country_code, valid, checked_at) \
             values ($1, $2, left($2, 2), $3, now() at time zone 'utc') \
             on conflict (vat_number) do update set valid = excluded.valid, checked_at = excluded.checked_at",
        )
        .bind(fresh("vies_"))
        .bind(number)
        .bind(valid)
        .execute(&self.tenant)
        .await
        .expect("vies");
    }
}

pub(crate) struct Reply {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    pub(crate) body: Value,
}

/// A request builder: `app.get("/channel", &key)`, then `.send()`.
pub(crate) struct Call<'a> {
    app: &'a App,
    method: &'static str,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<Value>,
}

impl App {
    fn call(&self, method: &'static str, path: &str, key: Option<&str>) -> Call<'_> {
        let mut call = Call {
            app: self,
            method,
            path: format!("/storefront/v1{path}"),
            headers: Vec::new(),
            body: None,
        };
        if let Some(key) = key {
            call.headers
                .push(("authorization".into(), format!("Bearer {key}")));
        }
        call
    }

    pub(crate) fn get(&self, path: &str, key: &str) -> Call<'_> {
        self.call("GET", path, Some(key))
    }

    pub(crate) fn post(&self, path: &str, key: &str, body: Value) -> Call<'_> {
        let mut call = self.call("POST", path, Some(key));
        call.body = Some(body);
        call
    }

    pub(crate) fn patch(&self, path: &str, key: &str, body: Value) -> Call<'_> {
        let mut call = self.call("PATCH", path, Some(key));
        call.body = Some(body);
        call
    }

    pub(crate) fn put(&self, path: &str, key: &str, body: Value) -> Call<'_> {
        let mut call = self.call("PUT", path, Some(key));
        call.body = Some(body);
        call
    }

    pub(crate) fn delete(&self, path: &str, key: &str) -> Call<'_> {
        self.call("DELETE", path, Some(key))
    }

    pub(crate) fn options(&self, path: &str) -> Call<'_> {
        self.call("OPTIONS", path, None)
    }

    /// Entity events published so far, once every publish has run.
    pub(crate) async fn events(&self) -> Vec<Value> {
        self.tracker.close();
        self.tracker.wait().await;
        self.bus.payloads()
    }

    pub(crate) async fn settle(&self) {
        self.tracker.close();
        self.tracker.wait().await;
        self.tracker.reopen();
    }
}

impl Call<'_> {
    pub(crate) fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub(crate) fn token(self, token: &str) -> Self {
        self.header("x-cart-token", token)
    }

    pub(crate) fn origin(self, origin: &str) -> Self {
        self.header("origin", origin)
    }

    pub(crate) async fn send(self) -> Reply {
        let mut request = Request::builder().method(self.method).uri(&self.path);
        for (name, value) in &self.headers {
            request = request.header(name, value);
        }
        let body = match &self.body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .router
            .clone()
            .oneshot(request.body(body).expect("request"))
            .await
            .expect("response");
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        Reply {
            status,
            headers,
            body,
        }
    }

    /// Send and expect `status`; the `data`.
    pub(crate) async fn ok(self, status: StatusCode) -> Value {
        let reply = self.send().await;
        assert_eq!(reply.status, status, "{}", reply.body);
        reply.body["data"].clone()
    }
}

/// The error code of a refusal.
pub(crate) fn code(reply: &Reply) -> &str {
    reply.body["error"]["code"].as_str().unwrap_or_default()
}

/// A cart on `key` with `items`; its token and cart.
pub(crate) async fn cart(app: &App, key: &str, items: Value) -> (String, Value) {
    let data = app
        .post(
            "/carts",
            key,
            json!({ "items": items, "email": "shopper@example.com" }),
        )
        .ok(StatusCode::CREATED)
        .await;
    (
        data["cartToken"].as_str().expect("token").to_owned(),
        data["cart"].clone(),
    )
}

pub(crate) fn address(country: &str) -> Value {
    json!({ "name": "Sam Shopper", "line1": "Straat 1", "city": "Stad", "postalCode": "1234 AB", "country": country })
}

/// A German VAT number no other test uses.
pub(crate) fn german_vat() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    format!("DE{:09}", n % 1_000_000_000)
}
