//! Payments over a real master and tenant schema
//! (`WELDSUITE_TEST_MASTER_URL`, `WELDSUITE_TEST_TENANT_URL`), with Mollie and
//! WeldBooks faked.
//!
//! - [`Fake`] is Mollie: the outbound HTTP port answers `api.mollie.com` and
//!   its OAuth endpoints from memory, logs every request, and lets a test move
//!   a payment's state, refuse a call or reject a token.
//! - [`FakeBooks`] is WeldBooks: it records what it is asked and can be told
//!   to fail.
//! - Every pool has ONE connection, as in production: a request that asked for
//!   a second one while holding the first would hang these tests.
//!
//! One connection per workspace and provider is the rule, and the tenant
//! database is shared by the tests: they take [`LOCK`] and start from
//! [`Ctx::reset`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{HeaderMap, Request, StatusCode, header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::MutexGuard;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_commerce::storefront::{StorefrontState, storefront_router};
use weldsuite_commerce::{
    CommerceState, PaymentsConfig, PaymentsPublicState, StorefrontRegistry, payments_public_router,
};
use weldsuite_commerce_domain::payments::books::{
    CreditNoteRef, CreditNoteRequest, InvoiceRef, InvoiceRequest, Invoicing,
};
use weldsuite_db::{Keyring, PgPool, Tenant, WorkspaceConfig, WorkspaceRestrictions, Workspaces};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_mollie::connect::ConnectApp;
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};
use weldsuite_ports::{
    BoxFuture, DynCache, DynEventBus, DynOutboundHttp, DynSystemMail, HttpRequest, HttpResponse,
    MemoryCache, OutboundHttp, PortError, RecordingEventBus, RecordingSystemMail,
};

pub(crate) const WORKSPACE: &str = "ws_pay_test";
pub(crate) const SELLER: &str = "ent_pay_test_nl";
pub(crate) const USER: &str = "user_pay_test";
pub(crate) const KEY: &str = "11111111111111111111111111111111111111111111111111111111111111aa";

/// Payments tests share one connection row: one at a time.
pub(crate) static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) const ALL: &[&str] = &[
    "orders:read",
    "orders:create",
    "orders:update",
    "commerce_settings:read",
    "commerce_settings:update",
    "companies:read",
    "companies:update",
];

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

// ── Mollie, faked ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub(crate) struct Logged {
    pub(crate) method: String,
    pub(crate) url: String,
    pub(crate) bearer: Option<String>,
    pub(crate) body: String,
}

#[derive(Debug, Clone)]
struct Pay {
    id: String,
    status: String,
    amount: String,
    currency: String,
    method: Option<String>,
    metadata: Value,
}

#[derive(Debug, Clone)]
struct Refund {
    id: String,
    payment: String,
    status: String,
    amount: String,
}

#[derive(Default)]
struct FakeState {
    log: Vec<Logged>,
    payments: Vec<Pay>,
    refunds: Vec<Refund>,
    by_key: HashMap<String, String>,
    /// Every API key is refused (401).
    reject_keys: bool,
    create_failure: Option<(u16, String)>,
    refund_failure: Option<(u16, String)>,
    /// This bearer token is answered 401.
    reject_token: Option<String>,
    refresh_fails: bool,
    tokens: u32,
    next: u32,
    /// Ids are unique to this fake: the databases outlive it.
    nonce: String,
}

pub(crate) struct Fake {
    state: Mutex<FakeState>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            state: Mutex::new(FakeState {
                nonce: fresh(""),
                ..FakeState::default()
            }),
        }
    }
}

#[allow(clippy::unnecessary_wraps, reason = "what a handler returns")]
fn answer(status: u16, body: &Value) -> Result<HttpResponse, PortError> {
    Ok(HttpResponse::new(status, body.to_string().into_bytes()))
}

fn money(value: &str, currency: &str) -> Value {
    json!({ "currency": currency, "value": value })
}

impl Fake {
    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().expect("fake mollie")
    }

    /// The requests whose method and path (after the host) match.
    pub(crate) fn requests_to(&self, method: &str, path_end: &str) -> Vec<Logged> {
        self.lock()
            .log
            .iter()
            .filter(|r| {
                r.method == method
                    && r.url
                        .split('?')
                        .next()
                        .is_some_and(|u| u.ends_with(path_end))
            })
            .cloned()
            .collect()
    }

    pub(crate) fn set_status(&self, payment: &str, status: &str, method: Option<&str>) {
        let mut state = self.lock();
        let pay = state
            .payments
            .iter_mut()
            .find(|p| p.id == payment)
            .expect("a fake payment");
        status.clone_into(&mut pay.status);
        pay.method = method.map(str::to_owned);
    }

    pub(crate) fn set_refund_status(&self, refund: &str, status: &str) {
        let mut state = self.lock();
        let found = state
            .refunds
            .iter_mut()
            .find(|r| r.id == refund)
            .expect("a fake refund");
        status.clone_into(&mut found.status);
    }

    pub(crate) fn last_payment(&self) -> String {
        self.lock().payments.last().expect("a payment").id.clone()
    }

    pub(crate) fn payment_count(&self) -> usize {
        self.lock().payments.len()
    }

    pub(crate) fn refund_ids(&self) -> Vec<String> {
        self.lock().refunds.iter().map(|r| r.id.clone()).collect()
    }

    /// A refund Mollie's dashboard made; its id.
    pub(crate) fn add_refund(&self, payment: &str, amount: &str) -> String {
        let mut state = self.lock();
        state.next += 1;
        let id = format!("re_{}d{:04}", state.nonce, state.next);
        state.refunds.push(Refund {
            id: id.clone(),
            payment: payment.to_owned(),
            status: "queued".to_owned(),
            amount: amount.to_owned(),
        });
        id
    }

    pub(crate) fn reject_keys(&self, on: bool) {
        self.lock().reject_keys = on;
    }

    pub(crate) fn fail_create(&self, failure: Option<(u16, &str)>) {
        self.lock().create_failure = failure.map(|(s, m)| (s, m.to_owned()));
    }

    pub(crate) fn fail_refund(&self, failure: Option<(u16, &str)>) {
        self.lock().refund_failure = failure.map(|(s, m)| (s, m.to_owned()));
    }

    pub(crate) fn reject_token(&self, token: Option<&str>) {
        self.lock().reject_token = token.map(str::to_owned);
    }

    pub(crate) fn fail_refresh(&self, on: bool) {
        self.lock().refresh_fails = on;
    }

    fn payment_json(pay: &Pay) -> Value {
        let mut json = json!({
            "id": pay.id, "status": pay.status, "amount": money(&pay.amount, &pay.currency),
            "metadata": pay.metadata, "expiresAt": "2099-01-01T00:00:00+00:00",
            "method": pay.method,
        });
        if pay.status == "open" {
            json["_links"] =
                json!({ "checkout": { "href": format!("https://pay.mollie.test/{}", pay.id) } });
        }
        if pay.status == "paid" {
            json["paidAt"] = json!("2026-11-21T10:00:00+00:00");
        }
        json
    }

    fn refund_json(refund: &Refund, currency: &str) -> Value {
        json!({
            "id": refund.id, "status": refund.status,
            "amount": money(&refund.amount, currency), "description": "x",
        })
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one arm per Mollie endpoint the tests use"
    )]
    fn handle(&self, request: &HttpRequest) -> Result<HttpResponse, PortError> {
        let url = url::Url::parse(&request.url).expect("a url");
        let bearer = request
            .headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("authorization"))
            .and_then(|(_, v)| v.strip_prefix("Bearer "))
            .map(str::to_owned);
        let body = request
            .body
            .as_deref()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        let mut state = self.lock();
        state.log.push(Logged {
            method: request.method.clone(),
            url: request.url.clone(),
            bearer: bearer.clone(),
            body: body.clone(),
        });
        let json_body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let path = url.path().to_owned();

        if path == "/oauth2/tokens" {
            if request.method == "DELETE" {
                return Ok(HttpResponse::new(204, Vec::new()));
            }
            let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                .into_owned()
                .collect();
            if form.get("grant_type").map(String::as_str) == Some("refresh_token")
                && state.refresh_fails
            {
                return answer(400, &json!({ "detail": "invalid_grant" }));
            }
            if form.get("code").map(String::as_str) == Some("bad_code") {
                return answer(400, &json!({ "detail": "invalid_grant" }));
            }
            state.tokens += 1;
            let n = state.tokens;
            return answer(
                200,
                &json!({ "access_token": format!("access_{n}"), "refresh_token": "refresh_1",
                         "expires_in": 3600, "scope": "payments.read payments.write" }),
            );
        }
        // Everything else is the v2 API.
        if let Some(token) = &bearer
            && (state.reject_token.as_deref() == Some(token.as_str())
                || (state.reject_keys
                    && (token.starts_with("live_") || token.starts_with("test_"))))
        {
            return answer(401, &json!({ "detail": "Unauthorized request" }));
        }
        let api = path.strip_prefix("/v2").unwrap_or(&path).to_owned();
        match (request.method.as_str(), api.as_str()) {
            ("GET", "/profiles/me") => answer(
                200,
                &json!({ "id": "pfl_key", "name": "Key shop",
                         "mode": if bearer.as_deref().is_some_and(|b| b.starts_with("test_")) { "test" } else { "live" } }),
            ),
            ("GET", "/profiles") => answer(
                200,
                &json!({ "_embedded": { "profiles": [
                    { "id": "pfl_1", "name": "Shop", "website": "https://shop.test", "mode": "live" },
                    { "id": "pfl_2", "name": "Shop test", "website": "https://shop.test", "mode": "test" },
                ] } }),
            ),
            ("GET", "/organizations/me") => {
                answer(200, &json!({ "id": "org_1", "name": "Shop BV" }))
            }
            ("POST", "/payments") => {
                if let Some((status, message)) = state.create_failure.clone() {
                    return answer(status, &json!({ "detail": message }));
                }
                let key = request
                    .headers
                    .iter()
                    .find(|(n, _)| n.eq_ignore_ascii_case("idempotency-key"))
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                if let Some(id) = state.by_key.get(&key).cloned() {
                    let pay = state
                        .payments
                        .iter()
                        .find(|p| p.id == id)
                        .expect("payment")
                        .clone();
                    return answer(201, &Self::payment_json(&pay));
                }
                state.next += 1;
                let pay = Pay {
                    id: format!("tr_{}{:04}", state.nonce, state.next),
                    status: "open".to_owned(),
                    amount: json_body["amount"]["value"]
                        .as_str()
                        .unwrap_or("0.00")
                        .to_owned(),
                    currency: json_body["amount"]["currency"]
                        .as_str()
                        .unwrap_or("EUR")
                        .to_owned(),
                    method: None,
                    metadata: json_body["metadata"].clone(),
                };
                state.by_key.insert(key, pay.id.clone());
                state.payments.push(pay.clone());
                answer(201, &Self::payment_json(&pay))
            }
            (method, other) if other.starts_with("/payments/") => {
                let rest = &other["/payments/".len()..];
                let (id, tail) = rest.split_once('/').map_or((rest, ""), |(i, t)| (i, t));
                let Some(pay) = state.payments.iter().find(|p| p.id == id).cloned() else {
                    return answer(
                        404,
                        &json!({ "detail": "No payment exists with this token" }),
                    );
                };
                match (method, tail) {
                    ("GET", "") => answer(200, &Self::payment_json(&pay)),
                    ("POST", "refunds") => {
                        if let Some((status, message)) = state.refund_failure.clone() {
                            return answer(status, &json!({ "detail": message }));
                        }
                        state.next += 1;
                        let refund = Refund {
                            id: format!("re_{}{:04}", state.nonce, state.next),
                            payment: pay.id.clone(),
                            status: "queued".to_owned(),
                            amount: json_body["amount"]["value"]
                                .as_str()
                                .unwrap_or("0.00")
                                .to_owned(),
                        };
                        state.refunds.push(refund.clone());
                        answer(201, &Self::refund_json(&refund, &pay.currency))
                    }
                    ("GET", "refunds") => {
                        let list: Vec<Value> = state
                            .refunds
                            .iter()
                            .filter(|r| r.payment == pay.id)
                            .map(|r| Self::refund_json(r, &pay.currency))
                            .collect();
                        answer(200, &json!({ "_embedded": { "refunds": list } }))
                    }
                    _ => answer(404, &json!({ "detail": "no such route" })),
                }
            }
            _ => answer(404, &json!({ "detail": format!("fake: no route {path}") })),
        }
    }
}

impl DynOutboundHttp for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(std::future::ready(self.handle(&request)))
    }
}

// ── WeldBooks, faked ────────────────────────────────────────────────────────

#[derive(Default)]
pub(crate) struct FakeBooks {
    pub(crate) calls: Mutex<Vec<String>>,
    pub(crate) paid_amounts: Mutex<Vec<Option<String>>>,
    pub(crate) credit_amounts: Mutex<Vec<String>>,
    fail: Mutex<Option<String>>,
    invoices: Mutex<HashMap<String, InvoiceRef>>,
}

impl FakeBooks {
    pub(crate) fn fail(&self, message: Option<&str>) {
        *self.fail.lock().expect("lock") = message.map(str::to_owned);
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("lock").clone()
    }
}

impl Invoicing for FakeBooks {
    fn invoice_order<'a>(
        &'a self,
        request: &'a InvoiceRequest<'a>,
    ) -> BoxFuture<'a, Result<InvoiceRef, String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("lock")
                .push(format!("invoice:{}", request.order_id));
            self.paid_amounts.lock().expect("lock").push(
                request
                    .payment
                    .as_ref()
                    .map(|p| weldsuite_commerce_domain::money::format(p.amount)),
            );
            if let Some(message) = self.fail.lock().expect("lock").clone() {
                return Err(message);
            }
            let mut invoices = self.invoices.lock().expect("lock");
            let number = invoices.len() + 1;
            Ok(invoices
                .entry(request.order_id.to_owned())
                .or_insert_with(|| InvoiceRef {
                    id: fresh("inv_fake_"),
                    number: format!("INV-{number}"),
                    status: "finalized".to_owned(),
                })
                .clone())
        })
    }

    fn credit_note<'a>(
        &'a self,
        request: &'a CreditNoteRequest<'a>,
    ) -> BoxFuture<'a, Result<CreditNoteRef, String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("lock")
                .push(format!("credit:{}", request.invoice_id));
            self.credit_amounts
                .lock()
                .expect("lock")
                .push(weldsuite_commerce_domain::money::format(request.amount));
            if let Some(message) = self.fail.lock().expect("lock").clone() {
                return Err(message);
            }
            Ok(CreditNoteRef {
                id: fresh("cn_fake_"),
                number: "CN-1".to_owned(),
            })
        })
    }
}

// ── the environment ─────────────────────────────────────────────────────────

pub(crate) struct Ctx {
    pub(crate) master: PgPool,
    pub(crate) tenant: PgPool,
    workspaces: Arc<Workspaces>,
    pub(crate) fake: Arc<Fake>,
    pub(crate) books: Arc<FakeBooks>,
    bus: Arc<RecordingEventBus>,
    /// The system mail every router sends through.
    pub(crate) mail: Arc<RecordingSystemMail>,
    tracker: TaskTracker,
    tenant_url: String,
    master_url: String,
    _guard: MutexGuard<'static, ()>,
}

/// The tenant database is shared with the other test targets, which expect
/// no Mollie connection: a test leaves none behind.
impl Drop for Ctx {
    fn drop(&mut self) {
        let (tenant, master) = (self.tenant_url.clone(), self.master_url.clone());
        let cleaned = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async {
                let db = weldsuite_db::master_pool(&tenant, 1).expect("pool");
                sqlx::query("delete from commerce_payment_connections")
                    .execute(&db)
                    .await
                    .expect("clean connections");
                let db = weldsuite_db::master_pool(&master, 1).expect("pool");
                sqlx::query("delete from commerce_connection_registry where workspace_id = $1")
                    .bind(WORKSPACE)
                    .execute(&db)
                    .await
                    .expect("clean registry");
            });
        })
        .join();
        assert!(cleaned.is_ok(), "cleaning up after the test");
    }
}

/// The shared databases with a clean connection, or `None` to skip.
pub(crate) async fn setup() -> Option<Ctx> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let guard = LOCK.lock().await;
    let master = weldsuite_db::master_pool(&master_url, 2).expect("master pool");
    let tenant = weldsuite_db::master_pool(&tenant_url, 1).expect("tenant pool");
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id, database_url) \
         values ($1, 'Payment tests', 'payment-tests', 'org_pay_test', $2) on conflict do nothing",
    )
    .bind(WORKSPACE)
    .bind(&tenant_url)
    .execute(&master)
    .await
    .expect("workspace");
    sqlx::query("update workspaces set database_url = $2 where id = $1")
        .bind(WORKSPACE)
        .bind(&tenant_url)
        .execute(&master)
        .await
        .expect("workspace url");
    seller(&tenant).await;
    sqlx::query("delete from commerce_payment_connections")
        .execute(&tenant)
        .await
        .expect("connections");
    sqlx::query("delete from commerce_connection_registry where workspace_id = $1")
        .bind(WORKSPACE)
        .execute(&master)
        .await
        .expect("registry");
    sqlx::query("update commerce_settings set auto_invoice = true")
        .execute(&tenant)
        .await
        .expect("auto invoice");
    let workspaces = Arc::new(Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig {
            tenant_max_connections: 1,
            ..WorkspaceConfig::default()
        },
    ));
    let ctx = Ctx {
        master,
        tenant,
        workspaces,
        fake: Arc::new(Fake::default()),
        books: Arc::new(FakeBooks::default()),
        bus: Arc::new(RecordingEventBus::new()),
        mail: Arc::new(RecordingSystemMail::new()),
        tracker: TaskTracker::new(),
        tenant_url,
        master_url,
        _guard: guard,
    };
    Some(ctx)
}

async fn seller(db: &PgPool) {
    let mut tx = db.begin().await.expect("tx");
    sqlx::query("select pg_advisory_xact_lock(hashtext('weldcommerce:settings'))")
        .execute(&mut *tx)
        .await
        .expect("lock");
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
         values ($1, 'Payment test seller', 'NL', 'EUR', true) \
         on conflict (id) do update set deleted_at = null, is_active = true, jurisdiction_code = 'NL'",
    )
    .bind(SELLER)
    .execute(&mut *tx)
    .await
    .expect("entity");
    sqlx::query(
        "insert into commerce_settings (id) select 'cset_pay_test' \
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

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

impl Ctx {
    pub(crate) fn config(&self, connect: bool) -> PaymentsConfig {
        PaymentsConfig {
            keyring: Keyring {
                v1: Some(KEY.to_owned()),
                v2: None,
            },
            public_url: Some("https://app.test".to_owned()),
            app_url: Some("https://app.test".to_owned()),
            connect: connect.then(|| ConnectApp::new("app_test", "sekret")),
            state_secret: Some("state-secret".to_owned()),
            invoicing: Some(Arc::clone(&self.books) as Arc<dyn Invoicing>),
            ..PaymentsConfig::default()
        }
    }

    fn publisher(&self) -> EntityEventPublisher {
        EntityEventPublisher::new(
            Some(Arc::clone(&self.bus) as Arc<dyn DynEventBus>),
            self.tracker.clone(),
        )
    }

    /// The entity events published so far by any router, once every publish
    /// has run. Call it once, at the end of a test.
    pub(crate) async fn events(&self) -> Vec<Value> {
        self.tracker.close();
        self.tracker.wait().await;
        self.bus.payloads()
    }

    fn http(&self) -> OutboundHttp {
        OutboundHttp(Arc::clone(&self.fake) as Arc<dyn DynOutboundHttp>)
    }

    /// The staff router for a member holding `permissions`.
    pub(crate) fn staff(&self, permissions: &[&str], connect: bool) -> Staff {
        let state = CommerceState {
            mail: Some(Arc::clone(&self.mail) as Arc<dyn DynSystemMail>),
            events: self.publisher(),
            http: Some(self.http()),
            payments: self.config(connect),
        };
        let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
        let resolved = ResolvedPermissions {
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            ..ResolvedPermissions::default()
        };
        let db = self.tenant.clone();
        let master = self.master.clone();
        let router = weldsuite_commerce::router(state, &gate).layer(axum::middleware::from_fn(
            move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                request.extensions_mut().insert(AuthContext {
                    user_id: USER.to_owned(),
                    org_id: Some("org_pay_test".to_owned()),
                    session_id: "sess_pay".to_owned(),
                    factor_verification_age: None,
                });
                request.extensions_mut().insert(Tenant {
                    workspace_id: WORKSPACE.to_owned(),
                    clerk_org_id: Some("org_pay_test".to_owned()),
                    db: db.clone(),
                    suspended: false,
                    restrictions: WorkspaceRestrictions::default(),
                });
                request.extensions_mut().insert(Permissions::new(
                    resolved.clone(),
                    None,
                    false,
                    USER.to_owned(),
                ));
                request
                    .extensions_mut()
                    .insert(StorefrontRegistry(master.clone()));
                next.run(request)
            },
        ));
        Staff { router }
    }

    /// Mollie's webhook and the OAuth callback.
    pub(crate) fn public(&self, connect: bool) -> Router {
        payments_public_router(PaymentsPublicState {
            events: self.publisher(),
            http: Some(self.http()),
            master: self.master.clone(),
            workspaces: Arc::clone(&self.workspaces),
            payments: self.config(connect),
        })
    }

    /// The storefront router.
    pub(crate) fn storefront(&self) -> Storefront {
        let router = storefront_router(StorefrontState {
            mail: Some(Arc::clone(&self.mail) as Arc<dyn DynSystemMail>),
            events: self.publisher(),
            http: Some(self.http()),
            master: self.master.clone(),
            workspaces: Arc::clone(&self.workspaces),
            cache: Some(Arc::new(MemoryCache::default()) as Arc<dyn DynCache>),
            trusted_proxies: 1,
            payments: self.config(true),
        });
        Storefront { router }
    }

    /// An order of `total` (EUR), to be paid; its id.
    pub(crate) async fn order(&self, total: &str, payment_status: &str) -> String {
        let id = fresh("ord_");
        sqlx::query(
            "insert into orders (id, order_number, status, payment_status, total, subtotal, currency, \
               customer_email, customer_name, source) \
             values ($1, $2, 'pending', $3, $4::numeric, $4::numeric, 'EUR', 'shopper@example.com', 'Sam Shopper', 'manual')",
        )
        .bind(&id)
        .bind(fresh("PAY-"))
        .bind(payment_status)
        .bind(total)
        .execute(&self.tenant)
        .await
        .expect("order");
        id
    }

    pub(crate) async fn order_row(&self, id: &str) -> Value {
        sqlx::query_scalar(
            "select jsonb_build_object('status', status, 'paymentStatus', payment_status, \
               'paidAt', paid_at, 'paymentMethod', payment_method, 'metadata', metadata, \
               'personId', person_id, 'counterpartyId', counterparty_id) from orders where id = $1",
        )
        .bind(id)
        .fetch_one(&self.tenant)
        .await
        .expect("order row")
    }

    /// A channel, a private key and a product for the storefront; `(key, product)`.
    pub(crate) async fn shop(&self, kind: &str, origins: &[&str]) -> (String, String, String) {
        self.shop_with(kind, origins, "b2c", &["mollie"]).await
    }

    pub(crate) async fn shop_with(
        &self,
        kind: &str,
        origins: &[&str],
        audience: &str,
        methods: &[&str],
    ) -> (String, String, String) {
        let channel = fresh("chan_");
        sqlx::query(
            "insert into commerce_channels (id, name, type, audience, status, currency, \
               prices_include_tax, selling_countries, guest_checkout, payment_methods) \
             values ($1, 'Pay shop', 'storefront', $4, 'active', 'EUR', true, $2, true, $3)",
        )
        .bind(&channel)
        .bind(json!(["NL", "DE"]))
        .bind(json!(methods))
        .bind(audience)
        .execute(&self.tenant)
        .await
        .expect("channel");
        let secret = format!(
            "{}{}",
            if kind == "private" { "wcs_" } else { "wcp_" },
            fresh("k")
        );
        let hash = hex::encode(Sha256::digest(secret.as_bytes()));
        let key_id = fresh("ckey_");
        sqlx::query(
            "insert into commerce_channel_keys (id, channel_id, kind, name, key_hash, key_prefix, allowed_origins) \
             values ($1, $2, $3, 'test', $4, $5, $6)",
        )
        .bind(&key_id)
        .bind(&channel)
        .bind(kind)
        .bind(&hash)
        .bind(&secret[..16])
        .bind(json!(origins))
        .execute(&self.tenant)
        .await
        .expect("key");
        sqlx::query(
            "insert into storefront_key_registry (id, key_hash, kind, key_prefix, workspace_id, channel_id, allowed_origins) \
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&key_id)
        .bind(&hash)
        .bind(kind)
        .bind(&secret[..16])
        .bind(WORKSPACE)
        .bind(&channel)
        .bind(json!(origins))
        .execute(&self.master)
        .await
        .expect("registry key");
        let product = fresh("prod_");
        sqlx::query(
            "insert into products (id, name, slug, sku, price, currency, status, track_inventory, \
               inventory_quantity, allow_backorder, vendor, has_variants, vat_category, cost_price, \
               visibility, requires_shipping) \
             values ($1, 'Widget', $2, $3, 12.10, 'EUR', 'active', false, 0, false, 'Acme', false, \
               'standard', 7.77, 'visible', false)",
        )
        .bind(&product)
        .bind(fresh("w-"))
        .bind(fresh("SKU-"))
        .execute(&self.tenant)
        .await
        .expect("product");
        (secret, product, channel)
    }
}

// ── requests ────────────────────────────────────────────────────────────────

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, headers, bytes.to_vec())
}

fn json_of(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()))
    }
}

pub(crate) struct Staff {
    router: Router,
}

impl Staff {
    pub(crate) async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let (status, _, bytes) = send(&self.router, request.body(body).expect("request")).await;
        (status, json_of(&bytes))
    }

    pub(crate) async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.call("GET", path, None).await
    }

    pub(crate) async fn post(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.call("POST", path, Some(body)).await
    }

    pub(crate) async fn patch(&self, path: &str, body: &Value) -> (StatusCode, Value) {
        self.call("PATCH", path, Some(body)).await
    }

    pub(crate) async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.call("DELETE", path, None).await
    }

    /// Connects Mollie with an API key (`test_…`); the connection.
    pub(crate) async fn connect_key(&self) -> Value {
        let (status, body) = self
            .post(
                "/commerce-payments/connection/mollie/api-key",
                &json!({ "apiKey": "test_abcdefghijklmnopqrstuvwxyz123456" }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["data"].clone()
    }
}

pub(crate) fn events_of(events: &[Value], event_type: &str, entity_id: &str) -> usize {
    events
        .iter()
        .filter(|e| e["eventType"] == event_type && e["entityId"] == entity_id)
        .count()
}

/// The public routes (webhook, callback).
pub(crate) struct Public(pub(crate) Router);

impl Public {
    pub(crate) async fn webhook(&self, connection: &str, payment: &str) -> StatusCode {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/webhooks/commerce/mollie/{connection}"))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(format!("id={payment}")))
            .expect("request");
        send(&self.0, request).await.0
    }

    pub(crate) async fn webhook_body(&self, connection: &str, body: &str) -> StatusCode {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/webhooks/commerce/mollie/{connection}"))
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(body.to_owned()))
            .expect("request");
        send(&self.0, request).await.0
    }

    /// The callback with `query`: its status and `Location`.
    pub(crate) async fn callback(&self, query: &str) -> (StatusCode, String) {
        let request = Request::builder()
            .method("GET")
            .uri(format!(
                "/api/commerce-payments/connection/mollie/callback?{query}"
            ))
            .body(Body::empty())
            .expect("request");
        let (status, headers, _) = send(&self.0, request).await;
        let location = headers
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        (status, location)
    }
}

pub(crate) struct Storefront {
    router: Router,
}

pub(crate) struct Reply {
    pub(crate) status: StatusCode,
    pub(crate) body: Value,
}

impl Reply {
    pub(crate) fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or_default()
    }
}

impl Storefront {
    pub(crate) async fn call(
        &self,
        method: &str,
        path: &str,
        key: &str,
        extra: &[(&str, &str)],
        body: Option<Value>,
    ) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/storefront/v1{path}"))
            .header(header::AUTHORIZATION, format!("Bearer {key}"));
        if key.starts_with("wcp_") {
            request = request.header(header::ORIGIN, "https://shop.example");
        }
        for (name, value) in extra {
            request = request.header(*name, *value);
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let (status, _, bytes) = send(&self.router, request.body(body).expect("request")).await;
        Reply {
            status,
            body: json_of(&bytes),
        }
    }

    /// A cart with one `product`; its token.
    pub(crate) async fn cart(&self, key: &str, product: &str) -> String {
        let reply = self
            .call(
                "POST",
                "/carts",
                key,
                &[],
                Some(json!({ "items": [{ "productId": product, "quantity": 1 }], "email": "shopper@example.com" })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.body);
        let token = reply.body["data"]["cartToken"]
            .as_str()
            .expect("token")
            .to_owned();
        // The checkout needs a destination.
        let reply = self
            .call(
                "PATCH",
                "/cart",
                key,
                &[("x-cart-token", &token)],
                Some(json!({ "shippingAddress": {
                    "name": "Sam Shopper", "line1": "Street 1", "city": "Amsterdam",
                    "postalCode": "1011AA", "country": "NL" } })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        token
    }
}

/// A refund made in Mollie's dashboard, not by WeldSuite; its id.
pub(crate) fn dashboard_refund(ctx: &Ctx, payment: &str, amount: &str) -> String {
    ctx.fake.add_refund(payment, amount)
}

// ── B2B fixtures (phase 6) ──────────────────────────────────────────────────

impl Ctx {
    /// A company and its party, with payment terms and a credit limit (EUR)
    /// when given; `(company id, party id)`.
    pub(crate) async fn company(
        &self,
        name: &str,
        terms: Option<&str>,
        credit_limit: Option<i64>,
    ) -> (String, String) {
        let company = fresh("comp_");
        let party = fresh("party_");
        sqlx::query("insert into companies (id, name, display_name) values ($1, $2, $2)")
            .bind(&company)
            .bind(name)
            .execute(&self.tenant)
            .await
            .expect("company");
        sqlx::query(
            "insert into parties (id, kind, company_id, role, display_name, payment_terms, credit_limit) \
             values ($1, 'company', $2, 'customer', $3, $4, $5)",
        )
        .bind(&party)
        .bind(&company)
        .bind(name)
        .bind(terms)
        .bind(credit_limit.map(|amount| json!({ "amount": amount, "currency": "EUR" })))
        .execute(&self.tenant)
        .await
        .expect("party");
        (company, party)
    }

    /// A buyer of `company`: the person, the link and the buyer row; the
    /// person's id. `limit` is a spend limit in EUR.
    pub(crate) async fn buyer(
        &self,
        company: &str,
        email: &str,
        role: &str,
        status: &str,
        limit: Option<&str>,
    ) -> String {
        let person = fresh("per_");
        sqlx::query(
            "insert into people (id, display_name, full_name, email, in_crm) \
             values ($1, $2, $2, $3, false)",
        )
        .bind(&person)
        .bind(email)
        .bind(email)
        .execute(&self.tenant)
        .await
        .expect("person");
        sqlx::query(
            "insert into person_companies (id, person_id, company_id, is_primary) values ($1, $2, $3, true)",
        )
        .bind(fresh("pc_"))
        .bind(&person)
        .bind(company)
        .execute(&self.tenant)
        .await
        .expect("link");
        sqlx::query(
            "insert into commerce_buyers (id, person_id, company_id, role, spend_limit, \
               spend_limit_currency, status) values ($1, $2, $3, $4, $5::numeric, $6, $7)",
        )
        .bind(fresh("cbuy_"))
        .bind(&person)
        .bind(company)
        .bind(role)
        .bind(limit)
        .bind(limit.map(|_| "EUR"))
        .bind(status)
        .execute(&self.tenant)
        .await
        .expect("buyer");
        person
    }

    /// The sign-in code last mailed to `email`.
    pub(crate) fn code_for(&self, email: &str) -> String {
        let sent = self.mail.sent();
        let mail = sent
            .iter()
            .rev()
            .find(|m| {
                m.to.iter().any(|to| to.email == email)
                    && m.subject.chars().any(|c| c.is_ascii_digit())
            })
            .expect("a sign-in mail");
        let text = &mail.text;
        let bytes = text.as_bytes();
        let mut at = 0;
        while at + 6 <= bytes.len() {
            if bytes[at..at + 6].iter().all(u8::is_ascii_digit)
                && (at == 0 || !bytes[at - 1].is_ascii_digit())
                && (at + 6 == bytes.len() || !bytes[at + 6].is_ascii_digit())
            {
                return text[at..at + 6].to_owned();
            }
            at += 1;
        }
        panic!("no code in the mail");
    }

    /// The mails sent to `email` so far, newest last (subject, text).
    pub(crate) fn mails_to(&self, email: &str) -> Vec<(String, String)> {
        self.mail
            .sent()
            .into_iter()
            .filter(|m| m.to.iter().any(|to| to.email == email))
            .map(|m| (m.subject, m.text))
            .collect()
    }

    /// Put a limit on every buyer of the company at once (rows in the setup).
    pub(crate) async fn threshold(&self, company: &str, amount: &str) {
        sqlx::query(
            "insert into commerce_company_settings (id, company_id, approval_threshold, \
               approval_threshold_currency) values ($1, $2, $3::numeric, 'EUR') \
             on conflict (company_id) do update set approval_threshold = excluded.approval_threshold, \
               approval_threshold_currency = 'EUR'",
        )
        .bind(fresh("ccs_"))
        .bind(company)
        .bind(amount)
        .execute(&self.tenant)
        .await
        .expect("threshold");
    }
}

impl Storefront {
    /// Sign in `email` on the channel of `key`; the session token.
    pub(crate) async fn sign_in(&self, ctx: &Ctx, key: &str, email: &str) -> String {
        let reply = self
            .call(
                "POST",
                "/auth/code",
                key,
                &[],
                Some(json!({ "email": email })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::ACCEPTED, "{}", reply.body);
        let code = ctx.code_for(email);
        let reply = self
            .call(
                "POST",
                "/auth/verify",
                key,
                &[],
                Some(json!({ "email": email, "code": code })),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
        reply.body["data"]["sessionToken"]
            .as_str()
            .expect("session token")
            .to_owned()
    }
}

impl Ctx {
    /// An existing person as a buyer of one more company.
    pub(crate) async fn buyer_for(&self, person: &str, company: &str, role: &str, status: &str) {
        sqlx::query(
            "insert into person_companies (id, person_id, company_id, is_primary) values ($1, $2, $3, false)",
        )
        .bind(fresh("pc_"))
        .bind(person)
        .bind(company)
        .execute(&self.tenant)
        .await
        .expect("link");
        sqlx::query(
            "insert into commerce_buyers (id, person_id, company_id, role, status) values ($1, $2, $3, $4, $5)",
        )
        .bind(fresh("cbuy_"))
        .bind(person)
        .bind(company)
        .bind(role)
        .bind(status)
        .execute(&self.tenant)
        .await
        .expect("buyer");
    }
}
