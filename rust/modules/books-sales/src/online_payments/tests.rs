//! Online invoice payments on the real tenant schema
//! (`WELDSUITE_TEST_TENANT_URL`, built by `scripts/rust-test-db.ts`; each test
//! returns early without it), with Mollie played by a fake behind the
//! `OutboundHttp` port: connecting by API key and by Mollie Connect, paying,
//! the webhook, and the settlements.

#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::type_complexity,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use weldsuite_books_domain::http::BooksState;
use weldsuite_books_domain::payment_refs::{self, PayRef};
use weldsuite_db::{Keyring, Tenant};
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

use super::connection;
use super::routes::{
    KeyBody, authorize_url, connect_api_key, disconnect_connection, read_connection, sync_now,
    update_connection,
};
use super::settlements;
use crate::delivery::{Links, invoice_token, public_router};
use crate::finalize::load_invoice;
use crate::test_support::{WORKSPACE, World, answer, customer, entity, invoice, row_of};

const KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const PORTAL: &str = "https://pay.example.test";
const APP: &str = "https://app.example.test";
const BOOKS: &str = "https://books.example.test";

// ── Mollie, played ──────────────────────────────────────────────────────────

#[derive(Default)]
struct FakeState {
    valid_keys: Vec<String>,
    payments: HashMap<String, Value>,
    created: Vec<Value>,
    idempotent: HashMap<String, String>,
    seq: u32,
    settlements: Vec<Value>,
    items: HashMap<String, Vec<Value>>,
    calls: Vec<(String, String)>,
    revoked: usize,
}

struct Fake {
    /// Ids are unique per run: the database is shared between runs.
    prefix: String,
    state: Mutex<FakeState>,
}

impl Fake {
    fn new() -> Self {
        Self {
            prefix: format!(
                "tr_T{}x",
                weldsuite_kit::portal::tokens::random_token(24)
                    .chars()
                    .filter(char::is_ascii_alphanumeric)
                    .take(10)
                    .collect::<String>()
            ),
            state: Mutex::default(),
        }
    }

    fn id(&self, n: u32) -> String {
        format!("{}{n}", self.prefix)
    }

    fn accept_key(&self, key: &str) {
        self.state.lock().unwrap().valid_keys.push(key.to_owned());
    }

    fn created(&self) -> Vec<Value> {
        self.state.lock().unwrap().created.clone()
    }

    fn payment(&self, id: &str, change: impl FnOnce(&mut Value)) {
        let mut state = self.state.lock().unwrap();
        change(state.payments.get_mut(id).unwrap());
    }

    fn calls(&self, needle: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(_, url)| url.contains(needle))
            .count()
    }

    fn handle(&self, request: &HttpRequest) -> (u16, Value) {
        let url = url::Url::parse(&request.url).unwrap();
        let path = url.path().to_owned();
        let method = request.method.as_str();
        let header = |name: &str| {
            request
                .headers
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        let bearer = header("authorization")
            .and_then(|v| v.strip_prefix("Bearer ").map(str::to_owned))
            .unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        state.calls.push((method.to_owned(), request.url.clone()));
        let body: Value = request
            .body
            .as_deref()
            .and_then(|b| serde_json::from_slice(b).ok())
            .unwrap_or(Value::Null);
        match (method, path.as_str()) {
            ("GET", "/v2/profiles/me") => {
                if state.valid_keys.contains(&bearer) {
                    (
                        200,
                        json!({ "id": "pfl_fake", "name": "Fake shop", "mode": "test" }),
                    )
                } else {
                    (401, json!({ "detail": "Invalid API key" }))
                }
            }
            ("GET", "/v2/profiles") => (
                200,
                json!({ "_embedded": { "profiles": [
                    { "id": "pfl_live", "name": "Live shop", "mode": "live" },
                    { "id": "pfl_test", "name": "Test shop", "mode": "test" },
                ] } }),
            ),
            ("GET", "/v2/organizations/me") => {
                (200, json!({ "id": "org_fake", "name": "Fake BV" }))
            }
            ("GET", "/v2/methods") => (
                200,
                json!({ "_embedded": { "methods": [
                    { "id": "ideal", "description": "iDEAL" },
                    { "id": "creditcard", "description": "Credit card" },
                    { "id": "bancontact", "description": "Bancontact" },
                ] } }),
            ),
            ("POST", "/v2/payments") => {
                let key = header("idempotency-key").unwrap_or_default();
                if let Some(id) = state.idempotent.get(&key) {
                    return (201, state.payments[id].clone());
                }
                state.seq += 1;
                let id = format!("{}{}", self.prefix, state.seq);
                let payment = json!({
                    "id": id,
                    "status": "open",
                    "amount": body["amount"],
                    "description": body["description"],
                    "metadata": body["metadata"],
                    "redirectUrl": body["redirectUrl"],
                    "webhookUrl": body["webhookUrl"],
                    "_links": { "checkout": { "href": format!("https://www.mollie.com/checkout/{id}") } },
                });
                state.created.push(body);
                state.idempotent.insert(key, id.clone());
                state.payments.insert(id, payment.clone());
                (201, payment)
            }
            ("GET", p) if p.starts_with("/v2/payments/") => {
                let id = p.trim_start_matches("/v2/payments/");
                match state.payments.get(id) {
                    Some(payment) => (200, payment.clone()),
                    None => (404, json!({ "detail": "No payment exists" })),
                }
            }
            ("GET", "/v2/settlements") => (
                200,
                json!({ "_embedded": { "settlements": state.settlements } }),
            ),
            ("GET", p) if p.starts_with("/v2/settlements/") => {
                let rest = p.trim_start_matches("/v2/settlements/");
                let (id, kind) = rest.split_once('/').unwrap();
                let list = state
                    .items
                    .get(&format!("{id}/{kind}"))
                    .cloned()
                    .unwrap_or_default();
                (200, json!({ "_embedded": { kind: list } }))
            }
            ("POST", "/oauth2/tokens") => {
                let form: HashMap<String, String> =
                    url::form_urlencoded::parse(request.body.as_deref().unwrap_or_default())
                        .into_owned()
                        .collect();
                match form.get("grant_type").map(String::as_str) {
                    Some("authorization_code")
                        if form.get("code").map(String::as_str) == Some("good-code") =>
                    {
                        (
                            200,
                            json!({
                                "access_token": "access-1",
                                "refresh_token": "refresh-1",
                                "expires_in": 3600,
                                "scope": "payments.read payments.write refunds.read profiles.read organizations.read settlements.read",
                            }),
                        )
                    }
                    Some("refresh_token") => (
                        200,
                        json!({ "access_token": "access-2", "expires_in": 3600 }),
                    ),
                    _ => (400, json!({ "detail": "invalid_grant" })),
                }
            }
            ("DELETE", "/oauth2/tokens") => {
                state.revoked += 1;
                (204, Value::Null)
            }
            _ => (
                404,
                json!({ "detail": format!("no route {method} {path}") }),
            ),
        }
    }
}

impl DynOutboundHttp for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let (status, body) = self.handle(&request);
        let bytes = if body.is_null() {
            Vec::new()
        } else {
            body.to_string().into_bytes()
        };
        Box::pin(std::future::ready(Ok(HttpResponse::new(status, bytes))))
    }
}

// ── the world ───────────────────────────────────────────────────────────────

struct Env {
    world: World,
    books: BooksState,
    fake: Arc<Fake>,
    entity: String,
}

async fn env() -> Option<Env> {
    let world = World::new()?;
    let fake = Arc::new(Fake::new());
    let mut books = world.state.clone();
    books.http = Some(OutboundHttp(Arc::clone(&fake) as Arc<dyn DynOutboundHttp>));
    books.keyring = Keyring {
        v1: Some(KEY.to_owned()),
        v2: None,
    };
    books.env = Arc::new(HashMap::from([
        ("PAY_PORTAL_PUBLIC_URL".to_owned(), PORTAL.to_owned()),
        (
            "BOOKS_DOCUMENT_TOKEN_SECRET".to_owned(),
            "p4-test-secret".to_owned(),
        ),
        ("PUBLIC_URL".to_owned(), BOOKS.to_owned()),
        ("PUBLIC_APP_URL".to_owned(), APP.to_owned()),
        ("MOLLIE_CONNECT_CLIENT_ID".to_owned(), "app_test".to_owned()),
        (
            "MOLLIE_CONNECT_CLIENT_SECRET".to_owned(),
            "secret_test".to_owned(),
        ),
    ]));
    let entity = entity(&world.db, "Online BV", "nl", None).await;
    chart(&world.db, &entity).await;
    Some(Env {
        world,
        books,
        fake,
        entity,
    })
}

async fn account(
    db: &PgPool,
    entity: &str,
    code: &str,
    name: &str,
    kind: &str,
    side: &str,
    role: Option<&str>,
) -> String {
    let id = generate_id("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, normal_side, metadata) \
         values ($1, $2, $3, $4, $5, $6, case when $7::text is null then null else jsonb_build_object('systemRole', $7::text) end)",
    )
    .bind(&id)
    .bind(entity)
    .bind(code)
    .bind(name)
    .bind(kind)
    .bind(side)
    .bind(role)
    .execute(db)
    .await
    .unwrap();
    id
}

/// Debtors, VAT payable and the chart's bank costs.
async fn chart(db: &PgPool, entity: &str) {
    account(db, entity, "1300", "Debtors", "asset", "debit", None).await;
    account(
        db,
        entity,
        "1700",
        "VAT payable",
        "liability",
        "credit",
        Some("tax_payable"),
    )
    .await;
    account(db, entity, "4650", "Bankkosten", "expense", "debit", None).await;
}

/// The entity's real bank account on its own ledger account.
async fn real_bank(db: &PgPool, entity: &str) -> (String, String) {
    let ledger = account(db, entity, "1100", "Bank", "asset", "debit", None).await;
    let bank = generate_id("bac");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, iban, currency, ledger_account_id, is_default) \
         values ($1, $2, 'Bank', 'NL91ABNA0417164300', 'EUR', $3, true)",
    )
    .bind(&bank)
    .bind(entity)
    .bind(&ledger)
    .execute(db)
    .await
    .unwrap();
    (bank, ledger)
}

fn tenant(world: &World) -> Tenant {
    Tenant {
        workspace_id: WORKSPACE.to_owned(),
        clerk_org_id: None,
        db: world.db.clone(),
        suspended: false,
        restrictions: weldsuite_db::WorkspaceRestrictions::default(),
    }
}

fn app(env: &Env) -> Router {
    public_router::<()>(&env.books, None).layer(axum::Extension(tenant(&env.world)))
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    ip: &str,
    content_type: &str,
    payload: Option<String>,
) -> (StatusCode, http::HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-forwarded-for", ip);
    let body = match payload {
        Some(text) => {
            request = request.header("content-type", content_type);
            Body::from(text)
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn get_json(app: &Router, uri: &str, ip: &str) -> (StatusCode, Value) {
    let (status, _, body) = call(app, "GET", uri, ip, "", None).await;
    (status, body)
}

async fn post_json(app: &Router, uri: &str, ip: &str, body: &Value) -> (StatusCode, Value) {
    let (status, _, body) = call(
        app,
        "POST",
        uri,
        ip,
        "application/json",
        Some(body.to_string()),
    )
    .await;
    (status, body)
}

/// The invoice's public link path.
async fn document_uri(env: &Env, invoice_id: &str) -> String {
    let secret = Links::secret(&env.books).unwrap();
    let row = load_invoice(&env.world.db, invoice_id)
        .await
        .unwrap()
        .unwrap();
    let token = invoice_token(&env.world.db, &secret, WORKSPACE, &row)
        .await
        .unwrap();
    format!("/public/weldbooks/documents/{token}")
}

fn webhook_ref(env: &Env, workspace: &str, entity: &str, invoice_id: &str) -> String {
    let secret = Links::secret(&env.books).unwrap();
    payment_refs::sign(&secret, &PayRef::webhook(workspace, entity, invoice_id))
}

async fn webhook(app: &Router, signed: &str, payment: &str, ip: &str) -> StatusCode {
    let (status, ..) = call(
        app,
        "POST",
        &format!("/public/weldbooks/mollie/webhook/{signed}"),
        ip,
        "application/x-www-form-urlencoded",
        Some(format!("id={payment}")),
    )
    .await;
    status
}

async fn sent_invoice(env: &Env) -> (String, String) {
    let contact = customer(&env.world.db, "Klant BV", false).await;
    let number = format!("INV-{}", &generate_id("n")[2..8]);
    let id = invoice(
        &env.world.db,
        &env.entity,
        &contact,
        &number,
        "sent",
        -9,
        Some("k@example.test"),
    )
    .await;
    (id, number)
}

async fn connect_key(env: &Env, key: &str) -> Value {
    env.fake.accept_key(key);
    let caller = env.world.caller(&env.entity);
    let (status, body) = answer(
        connect_api_key(
            &caller,
            &env.books,
            KeyBody {
                api_key: key.to_owned(),
                profile_id: None,
            },
        )
        .await,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    body["data"].clone()
}

async fn count(db: &PgPool, sql: &str, bind: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .bind(bind)
        .fetch_one(db)
        .await
        .unwrap()
}

// ── connecting ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn an_api_key_connects_one_entity_and_shows_no_secret() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let caller = env.world.caller(&env.entity);

    // A key Mollie does not accept is refused, and nothing is stored.
    let (status, body) = answer(
        connect_api_key(
            &caller,
            &env.books,
            KeyBody {
                api_key: "test_bad".into(),
                profile_id: None,
            },
        )
        .await,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("API key")
    );
    // A key with neither prefix is refused before Mollie is asked.
    let (status, _) = answer(
        connect_api_key(
            &caller,
            &env.books,
            KeyBody {
                api_key: "whatever".into(),
                profile_id: None,
            },
        )
        .await,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(
        count(
            db,
            "select count(*) from accounting_payment_connections where entity_id = $1",
            &env.entity
        )
        .await,
        0
    );

    let view = connect_key(&env, "test_goodkey123").await;
    assert_eq!(view["provider"], "mollie");
    assert_eq!(view["status"], "connected");
    assert_eq!(view["authMethod"], "api_key");
    assert_eq!(view["profileId"], "pfl_fake");
    assert_eq!(view["profileName"], "Fake shop");
    assert_eq!(view["testmode"], true);
    assert_eq!(
        view["methods"],
        json!(["ideal", "creditcard", "bancontact"])
    );
    assert_eq!(view["settlementsAvailable"], false);
    assert!(view["connectedAt"].is_string());
    let text = view.to_string();
    for secret in [
        "test_goodkey123",
        "apiKey",
        "Encrypted",
        "accessToken",
        "refreshToken",
    ] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    // The key is sealed in the row.
    let stored: String = sqlx::query_scalar(
        "select api_key_encrypted from accounting_payment_connections where entity_id = $1",
    )
    .bind(&env.entity)
    .fetch_one(db)
    .await
    .unwrap();
    assert!(!stored.contains("test_goodkey123") && !stored.is_empty());

    // The entity's Mollie money account: a bank account of its own type on its own ledger account.
    let (bank_id, ledger_id, bank_type): (String, String, String) = sqlx::query_as(
        "select id, ledger_account_id, account_type from bank_accounts where entity_id = $1 and deleted_at is null",
    )
    .bind(&env.entity)
    .fetch_one(db)
    .await
    .unwrap();
    assert_eq!(bank_type, "payment_provider");
    assert_eq!(view["bankAccountId"], bank_id);
    let ledger = row_of(db, "accounts", &ledger_id).await;
    assert_eq!(ledger["name"], "Mollie");
    assert_eq!(ledger["type"], "asset");
    assert_eq!(ledger["metadata"]["systemRole"], "payment_provider");

    let events: Vec<String> = env
        .world
        .events()
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    for wanted in [
        "payment_connection.created",
        "bank_account.created",
        "account.created",
    ] {
        assert!(
            events.contains(&wanted.to_owned()),
            "{wanted} in {events:?}"
        );
    }

    // GET shows it; the credentials never travel.
    let (status, body) = answer(read_connection(&caller).await).await;
    assert_eq!(status, 200);
    assert_eq!(body["data"]["id"], view["id"]);

    // Reconnecting replaces the connection (same id) and makes no second money account.
    let again = connect_key(&env, "test_other456").await;
    assert_eq!(again["id"], view["id"]);
    assert_eq!(
        count(db, "select count(*) from bank_accounts where entity_id = $1 and account_type = 'payment_provider'", &env.entity).await,
        1
    );

    // Another entity of the workspace has no connection.
    let other = entity(db, "Other BV", "nl", None).await;
    let (status, body) = answer(read_connection(&env.world.caller(&other)).await).await;
    assert_eq!(status, 200);
    assert!(body["data"].is_null());
    // And cannot reach this one's by id.
    let id = view["id"].as_str().unwrap().to_owned();
    let stranger = env.world.caller(&other);
    let (status, _) =
        answer(update_connection(&stranger, &env.books, &id, Some(vec!["ideal".into()])).await)
            .await;
    assert_eq!(status, 404);
    let (status, _) = answer(disconnect_connection(&stranger, &env.books, &id).await).await;
    assert_eq!(status, 404);
    let (status, _) = answer(sync_now(&stranger, &env.books, &id).await).await;
    assert_eq!(status, 404);

    // The methods offered must be active on the profile.
    let id = view["id"].as_str().unwrap();
    let (status, body) =
        answer(update_connection(&caller, &env.books, id, Some(vec!["ideal".into()])).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["methods"], json!(["ideal"]));
    let (status, body) =
        answer(update_connection(&caller, &env.books, id, Some(vec!["klarna".into()])).await).await;
    assert_eq!(status, 400, "{body}");

    // Settlements cannot be read with a key.
    let (status, body) = answer(sync_now(&caller, &env.books, id).await).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["details"]["code"], "SETTLEMENTS_UNAVAILABLE");

    // Disconnecting.
    let (status, _) = answer(disconnect_connection(&caller, &env.books, id).await).await;
    assert_eq!(status, 204);
    let (_, body) = answer(read_connection(&caller).await).await;
    assert!(body["data"].is_null());
    let events: Vec<String> = env
        .world
        .events()
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert!(
        events.contains(&"payment_connection.deleted".to_owned()),
        "{events:?}"
    );
    assert!(
        events.contains(&"payment_connection.updated".to_owned()),
        "{events:?}"
    );
    let remaining: Option<String> = sqlx::query_scalar(
        "select api_key_encrypted from accounting_payment_connections where id = $1",
    )
    .bind(id)
    .fetch_one(db)
    .await
    .unwrap();
    assert!(remaining.is_none());
}

#[tokio::test]
async fn mollie_connect_signs_its_state_and_the_callback_stores_the_connection() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let caller = env.world.caller(&env.entity);

    // A return address off the platform is refused.
    let (status, _) = answer(authorize_url(&caller, &env.books, "https://evil.test/x").await).await;
    assert_eq!(status, 400);

    let (status, body) =
        answer(authorize_url(&caller, &env.books, "/settings/apps/weldbooks?tab=payments").await)
            .await;
    assert_eq!(status, 200, "{body}");
    let authorize = url::Url::parse(body["data"]["authorizeUrl"].as_str().unwrap()).unwrap();
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    assert_eq!(query["client_id"], "app_test");
    assert_eq!(
        query["redirect_uri"],
        format!("{BOOKS}/public/weldbooks/mollie/callback")
    );
    assert!(
        query["scope"].contains("settlements.read") && query["scope"].contains("payments.write")
    );
    // The state is signed for this workspace, entity and member.
    let secret = Links::secret(&env.books).unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let state = payment_refs::verify(&secret, &query["state"], payment_refs::CONNECT, now).unwrap();
    assert_eq!(
        (state.ws.as_str(), state.e.as_str()),
        (WORKSPACE, env.entity.as_str())
    );
    assert_eq!(
        state.r.as_deref(),
        Some("https://app.example.test/settings/apps/weldbooks?tab=payments")
    );

    let router = app(&env);
    let callback = |state: &str, extra: &str| {
        format!("/public/weldbooks/mollie/callback?state={state}{extra}")
    };

    // A state that is not ours, or has expired, goes nowhere.
    let (status, headers, _) = call(
        &router,
        "GET",
        &callback("nope", "&code=good-code"),
        "10.1.0.1",
        "",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .contains("reason=invalid_state")
    );
    let old = payment_refs::sign(
        &secret,
        &PayRef::connect(WORKSPACE, &env.entity, "user_p4", "/settings", now - 3_600),
    );
    let (status, headers, _) = call(
        &router,
        "GET",
        &callback(&old, "&code=good-code"),
        "10.1.0.1",
        "",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .contains("reason=invalid_state")
    );
    assert_eq!(
        count(
            db,
            "select count(*) from accounting_payment_connections where entity_id = $1",
            &env.entity
        )
        .await,
        0
    );

    // Mollie says the merchant refused.
    let (_, headers, _) = call(
        &router,
        "GET",
        &callback(&query["state"], "&error=access_denied"),
        "10.1.0.2",
        "",
        None,
    )
    .await;
    let location = headers["location"].to_str().unwrap();
    assert!(location.starts_with("https://app.example.test/settings/apps/weldbooks?tab=payments"));
    assert!(location.contains("mollie=error") && location.contains("reason=access_denied"));

    // A code Mollie refuses.
    let (_, headers, _) = call(
        &router,
        "GET",
        &callback(&query["state"], "&code=bad-code"),
        "10.1.0.3",
        "",
        None,
    )
    .await;
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .contains("reason=token_exchange_failed")
    );

    // The merchant approved.
    let (status, headers, _) = call(
        &router,
        "GET",
        &callback(&query["state"], "&code=good-code"),
        "10.1.0.4",
        "",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let location = headers["location"].to_str().unwrap();
    assert!(
        location.starts_with("https://app.example.test/settings/apps/weldbooks?tab=payments")
            && location.contains("mollie=connected"),
        "{location}"
    );
    let (status, body) = answer(read_connection(&caller).await).await;
    assert_eq!(status, 200);
    let view = &body["data"];
    assert_eq!(view["authMethod"], "oauth");
    assert_eq!(view["organizationName"], "Fake BV");
    // The live profile is picked.
    assert_eq!(view["profileId"], "pfl_live");
    assert_eq!(view["testmode"], false);
    assert_eq!(view["settlementsAvailable"], true);
    assert_eq!(
        view["methods"],
        json!(["ideal", "creditcard", "bancontact"])
    );
    assert!(!view.to_string().contains("access-1"));
    // The tokens are sealed.
    let (access, refresh): (String, String) = sqlx::query_as(
        "select access_token_encrypted, refresh_token_encrypted from accounting_payment_connections where entity_id = $1",
    )
    .bind(&env.entity)
    .fetch_one(db)
    .await
    .unwrap();
    assert!(!access.contains("access-1") && !refresh.contains("refresh-1"));
    assert_eq!(
        count(db, "select count(*) from bank_accounts where entity_id = $1 and account_type = 'payment_provider'", &env.entity).await,
        1
    );

    // Disconnecting revokes the grant at Mollie.
    let id = view["id"].as_str().unwrap();
    let (status, _) = answer(disconnect_connection(&caller, &env.books, id).await).await;
    assert_eq!(status, 204);
    assert_eq!(env.fake.state.lock().unwrap().revoked, 2);
}

// ── paying ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn paying_creates_a_payment_once_and_says_when_it_cannot() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let router = app(&env);
    let (invoice_id, number) = sent_invoice(&env).await;
    let uri = document_uri(&env, &invoice_id).await;
    let pay = format!("{uri}/pay");
    let return_url = json!({ "returnUrl": format!("{PORTAL}/d/x/return") });

    // Not set up: the page shows no online payment, paying answers 503.
    let (status, body) = get_json(&router, &uri, "10.2.0.1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["payment"]["enabled"], false);
    let (status, body) = post_json(&router, &pay, "10.2.0.1", &return_url).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "PAYMENT_UNAVAILABLE");

    connect_key(&env, "test_paykey123").await;

    // Connected: the page offers the entity's methods.
    let (_, body) = get_json(&router, &uri, "10.2.0.2").await;
    assert_eq!(
        body["data"]["payment"],
        json!({ "enabled": true, "status": "open", "methods": ["ideal", "creditcard", "bancontact"] })
    );

    // A return address off the portal is refused.
    let (status, body) = post_json(
        &router,
        &pay,
        "10.2.0.3",
        &json!({ "returnUrl": "https://evil.test/x" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, _) = post_json(&router, &pay, "10.2.0.3", &json!({})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(env.fake.created().len(), 0);

    // The first request makes a Mollie payment for the balance due.
    let (status, body) = post_json(&router, &pay, "10.2.0.4", &return_url).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let checkout = body["data"]["checkoutUrl"].as_str().unwrap().to_owned();
    assert_eq!(
        checkout,
        format!("https://www.mollie.com/checkout/{}", env.fake.id(1))
    );
    let created = env.fake.created();
    assert_eq!(created.len(), 1);
    let sent = &created[0];
    assert_eq!(
        sent["amount"],
        json!({ "currency": "EUR", "value": "121.00" })
    );
    assert_eq!(sent["description"], format!("Invoice {number} - Online BV"));
    assert_eq!(sent["redirectUrl"], format!("{PORTAL}/d/x/return"));
    assert_eq!(
        sent["metadata"],
        json!({ "ws": WORKSPACE, "entityId": env.entity, "invoiceId": invoice_id })
    );
    assert_eq!(sent["method"], json!(["ideal", "creditcard", "bancontact"]));
    // The webhook carries a signed reference to this invoice.
    let hook = sent["webhookUrl"].as_str().unwrap();
    let prefix = format!("{BOOKS}/public/weldbooks/mollie/webhook/");
    assert!(hook.starts_with(&prefix), "{hook}");
    let secret = Links::secret(&env.books).unwrap();
    let reference = payment_refs::verify(
        &secret,
        hook.trim_start_matches(&prefix),
        payment_refs::WEBHOOK,
        0,
    )
    .unwrap();
    assert_eq!(
        (
            reference.ws.as_str(),
            reference.e.as_str(),
            reference.i.as_deref()
        ),
        (WORKSPACE, env.entity.as_str(), Some(invoice_id.as_str()))
    );

    // Paying again, for the same balance, resumes the open payment.
    let (status, body) = post_json(&router, &pay, "10.2.0.4", &return_url).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["checkoutUrl"], checkout);
    assert_eq!(env.fake.created().len(), 1);

    // The page says a payment is under way.
    let (_, body) = get_json(&router, &uri, "10.2.0.5").await;
    assert_eq!(body["data"]["payment"]["status"], "pending");

    // A payment Mollie has expired is replaced by a new one.
    env.fake
        .payment(&env.fake.id(1), |p| p["status"] = json!("expired"));
    let history_status =
        sqlx::query_scalar::<_, Value>("select email_history from invoices where id = $1")
            .bind(&invoice_id)
            .fetch_one(db)
            .await
            .unwrap();
    assert!(history_status.to_string().contains("payment_started"));
    // (The webhook records the expiry; here Mollie is simply asked again.)
    let (status, body) = post_json(&router, &pay, "10.2.0.6", &return_url).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["checkoutUrl"],
        format!("https://www.mollie.com/checkout/{}", env.fake.id(2))
    );
    assert_eq!(env.fake.created().len(), 2);

    // Nothing to pay on a paid invoice, a credit note or a cancelled one.
    for sql in [
        "status = 'paid', amount_paid = '121.00', balance_due = '0.00'",
        "status = 'cancelled', amount_paid = '0.00', balance_due = '121.00'",
        "status = 'sent', type = 'credit_note', amount_paid = '0.00', balance_due = '121.00'",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "update invoices set {sql} where id = $1"
        )))
        .bind(&invoice_id)
        .execute(db)
        .await
        .unwrap();
        let (status, _) = post_json(&router, &pay, "10.2.0.7", &return_url).await;
        assert_eq!(status, StatusCode::CONFLICT, "{sql}");
    }

    // A currency Mollie does not take with two decimals is not offered.
    sqlx::query("update invoices set status = 'sent', type = 'standard', currency = 'JPY', balance_due = '121.00' where id = $1")
        .bind(&invoice_id)
        .execute(db)
        .await
        .unwrap();
    let (status, body) = post_json(&router, &pay, "10.2.0.8", &return_url).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "PAYMENT_UNAVAILABLE");
    let (_, body) = get_json(&router, &uri, "10.2.0.9").await;
    assert_eq!(body["data"]["payment"]["enabled"], false);
}

// ── the webhook ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_paid_payment_is_recorded_once_on_the_mollie_account() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let router = app(&env);
    let (invoice_id, _) = sent_invoice(&env).await;
    let uri = document_uri(&env, &invoice_id).await;
    let view = connect_key(&env, "test_webhookkey1").await;
    env.world.events().await;
    let (status, _) = post_json(
        &router,
        &format!("{uri}/pay"),
        "10.3.0.1",
        &json!({ "returnUrl": format!("{PORTAL}/d/x/return") }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let signed = webhook_ref(&env, WORKSPACE, &env.entity, &invoice_id);

    // A reference that is not ours, or a payment id that is not one.
    assert_eq!(
        webhook(&router, "garbage", &env.fake.id(1), "10.3.0.2").await,
        StatusCode::NOT_FOUND
    );
    let foreign = {
        let other = payment_refs::sign(
            b"another-install-secret",
            &PayRef::webhook(WORKSPACE, &env.entity, &invoice_id),
        );
        webhook(&router, &other, &env.fake.id(1), "10.3.0.2").await
    };
    assert_eq!(foreign, StatusCode::NOT_FOUND);
    // A reference of another workspace does not open this one.
    let other_ws = webhook_ref(&env, "ws_somebody_else", &env.entity, &invoice_id);
    assert_eq!(
        webhook(&router, &other_ws, &env.fake.id(1), "10.3.0.2").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        webhook(&router, &signed, "not-a-payment", "10.3.0.2").await,
        StatusCode::OK
    );

    // Open: Mollie's status is kept, nothing is booked.
    assert_eq!(
        webhook(&router, &signed, &env.fake.id(1), "10.3.0.3").await,
        StatusCode::OK
    );
    assert_eq!(
        count(
            db,
            "select count(*) from payment_allocations where invoice_id = $1 and deleted_at is null",
            &invoice_id
        )
        .await,
        0
    );
    let history = row_of(db, "invoices", &invoice_id).await["email_history"].to_string();
    assert!(
        !history.contains("payment_status"),
        "an unchanged status adds nothing: {history}"
    );

    // A payment that is not this invoice's (made for another) is ignored.
    env.fake.payment(&env.fake.id(1), |p| {
        p["status"] = json!("paid");
        p["paidAt"] = json!("2026-01-05T10:00:00+00:00");
        p["method"] = json!("ideal");
        p["metadata"]["invoiceId"] = json!("inv_other");
    });
    assert_eq!(
        webhook(&router, &signed, &env.fake.id(1), "10.3.0.3").await,
        StatusCode::OK
    );
    assert_eq!(
        count(
            db,
            "select count(*) from payment_allocations where invoice_id = $1 and deleted_at is null",
            &invoice_id
        )
        .await,
        0
    );
    env.fake.payment(&env.fake.id(1), |p| {
        p["metadata"]["invoiceId"] = json!(invoice_id);
    });

    // Paid: booked on the Mollie account, and the invoice turns paid.
    assert_eq!(
        webhook(&router, &signed, &env.fake.id(1), "10.3.0.4").await,
        StatusCode::OK
    );
    let invoice_row = row_of(db, "invoices", &invoice_id).await;
    assert_eq!(invoice_row["status"], "paid");
    assert_eq!(invoice_row["balance_due"].as_f64(), Some(0.0));
    let (payment_id, amount, bank_account_id, method, reference): (String, String, String, String, String) = sqlx::query_as(
        "select p.id, p.amount::text, p.bank_account_id, p.payment_method, p.reference from payments p join payment_allocations a on a.payment_id = p.id where a.invoice_id = $1",
    )
    .bind(&invoice_id)
    .fetch_one(db)
    .await
    .unwrap();
    assert!(payment_id.starts_with("pay_mol_"));
    assert_eq!(amount, "121.00");
    assert_eq!(bank_account_id, view["bankAccountId"].as_str().unwrap());
    assert_eq!(method, "bank_transfer");
    assert_eq!(reference, env.fake.id(1));
    // Debit on the Mollie ledger account, credit on the debtors.
    let ledger: String =
        sqlx::query_scalar("select ledger_account_id from bank_accounts where id = $1")
            .bind(&bank_account_id)
            .fetch_one(db)
            .await
            .unwrap();
    let balance: String =
        sqlx::query_scalar("select current_balance::text from accounts where id = $1")
            .bind(&ledger)
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(balance, "121.00");
    let events: Vec<String> = env
        .world
        .events()
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    for wanted in ["payment.created", "invoice.updated", "invoice.paid"] {
        assert_eq!(
            events.iter().filter(|e| *e == wanted).count(),
            1,
            "{wanted} in {events:?}"
        );
    }

    // Delivered again (Mollie retries): still one payment, no new events.
    assert_eq!(
        webhook(&router, &signed, &env.fake.id(1), "10.3.0.5").await,
        StatusCode::OK
    );
    assert_eq!(
        count(
            db,
            "select count(*) from payment_allocations where invoice_id = $1 and deleted_at is null",
            &invoice_id
        )
        .await,
        1
    );
    assert_eq!(env.world.events().await.len(), 0);

    // The page shows it paid, and paying again has nothing to pay.
    let (_, body) = get_json(&router, &uri, "10.3.0.6").await;
    assert_eq!(body["data"]["payment"]["status"], "paid");
    assert_eq!(body["data"]["totals"]["balanceDue"], "0.00");
    let (status, _) = post_json(
        &router,
        &format!("{uri}/pay"),
        "10.3.0.7",
        &json!({ "returnUrl": format!("{PORTAL}/d/x/return") }),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A refund Mollie reports is kept for the owner, once.
    env.fake.payment(&env.fake.id(1), |p| {
        p["amountRefunded"] = json!({ "currency": "EUR", "value": "21.00" });
    });
    for _ in 0..2 {
        assert_eq!(
            webhook(&router, &signed, &env.fake.id(1), "10.3.0.8").await,
            StatusCode::OK
        );
    }
    let history = row_of(db, "invoices", &invoice_id).await["email_history"].clone();
    let reversed = history
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "payment_reversed")
        .count();
    assert_eq!(reversed, 1);
    assert_eq!(
        count(
            db,
            "select count(*) from payment_allocations where invoice_id = $1 and deleted_at is null",
            &invoice_id
        )
        .await,
        1
    );
}

#[tokio::test]
async fn a_failed_or_expired_payment_books_nothing() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let router = app(&env);
    let (invoice_id, _) = sent_invoice(&env).await;
    let uri = document_uri(&env, &invoice_id).await;
    connect_key(&env, "test_failedkey123").await;
    let (status, _) = post_json(
        &router,
        &format!("{uri}/pay"),
        "10.4.0.1",
        &json!({ "returnUrl": format!("{PORTAL}/d/x/return") }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let signed = webhook_ref(&env, WORKSPACE, &env.entity, &invoice_id);
    for state in ["failed", "canceled", "expired"] {
        env.fake
            .payment(&env.fake.id(1), |p| p["status"] = json!(state));
        assert_eq!(
            webhook(&router, &signed, &env.fake.id(1), "10.4.0.2").await,
            StatusCode::OK
        );
    }
    assert_eq!(
        count(
            db,
            "select count(*) from payment_allocations where invoice_id = $1 and deleted_at is null",
            &invoice_id
        )
        .await,
        0
    );
    assert_eq!(row_of(db, "invoices", &invoice_id).await["status"], "sent");
    // The last status is kept, and the page offers payment again.
    let history = row_of(db, "invoices", &invoice_id).await["email_history"].to_string();
    assert!(history.contains("expired"));
    let (_, body) = get_json(&router, &uri, "10.4.0.3").await;
    assert_eq!(body["data"]["payment"]["status"], "open");
    assert_eq!(body["data"]["payment"]["enabled"], true);
}

// ── settlements ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_settlement_books_its_fees_and_the_payout_as_a_transfer_once() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    let router = app(&env);
    let caller = env.world.caller(&env.entity);
    let (bank, bank_ledger) = real_bank(db, &env.entity).await;

    // Connected with Mollie Connect, and one payment paid through an invoice.
    let secret = Links::secret(&env.books).unwrap();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let state = payment_refs::sign(
        &secret,
        &PayRef::connect(WORKSPACE, &env.entity, "user_p4", "/settings", now),
    );
    let (_, headers, _) = call(
        &router,
        "GET",
        &format!("/public/weldbooks/mollie/callback?state={state}&code=good-code"),
        "10.5.0.1",
        "",
        None,
    )
    .await;
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .contains("mollie=connected")
    );
    let (invoice_id, _) = sent_invoice(&env).await;
    let uri = document_uri(&env, &invoice_id).await;
    let (status, _) = post_json(
        &router,
        &format!("{uri}/pay"),
        "10.5.0.2",
        &json!({ "returnUrl": format!("{PORTAL}/d/x/return") }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    env.fake.payment(&env.fake.id(1), |p| {
        p["status"] = json!("paid");
        p["paidAt"] = json!("2026-01-03T10:00:00+00:00");
        p["method"] = json!("ideal");
    });
    let signed = webhook_ref(&env, WORKSPACE, &env.entity, &invoice_id);
    assert_eq!(
        webhook(&router, &signed, &env.fake.id(1), "10.5.0.3").await,
        StatusCode::OK
    );

    // Mollie paid out 121.00 and 60.00 (made outside WeldBooks), less 2.66 of fees.
    let settlement = json!({
        "id": "stl_one", "reference": "1234567.2601.03", "status": "paidout",
        "createdAt": "2026-01-04T00:00:00+00:00", "settledAt": "2026-01-05T08:00:00+00:00",
        "amount": { "currency": "EUR", "value": "178.34" },
        "periods": { "2026": { "01": { "costs": [
            { "description": "iDEAL", "amountNet": { "currency": "EUR", "value": "0.20" }, "amountVat": { "currency": "EUR", "value": "0.04" }, "amountGross": { "currency": "EUR", "value": "0.24" } },
            { "description": "Card", "amountNet": { "currency": "EUR", "value": "2.00" }, "amountVat": { "currency": "EUR", "value": "0.42" }, "amountGross": { "currency": "EUR", "value": "2.42" } },
        ], "revenue": [] } } },
    });
    let open = json!({
        "id": "stl_open", "status": "open", "createdAt": "2026-01-06T00:00:00+00:00",
        "amount": { "currency": "EUR", "value": "10.00" }, "periods": {},
    });
    {
        let mut fake = env.fake.state.lock().unwrap();
        fake.settlements = vec![settlement, open];
        fake.items.insert(
            "stl_one/payments".into(),
            vec![
                json!({ "id": env.fake.id(1), "amount": { "currency": "EUR", "value": "121.00" }, "paidAt": "2026-01-03T10:00:00+00:00" }),
                json!({ "id": "tr_outside", "description": "Shop order", "amount": { "currency": "EUR", "value": "60.00" }, "paidAt": "2026-01-04T10:00:00+00:00" }),
            ],
        );
    }
    // The payout is already on the bank.
    let incoming: String = generate_id("btx");
    sqlx::query(
        "insert into bank_transactions (id, entity_id, bank_account_id, date, description, amount, status) \
         values ($1, $2, $3, '2026-01-06T00:00:00', 'Mollie 1234567.2601.03', '178.34', 'unreconciled')",
    )
    .bind(&incoming)
    .bind(&env.entity)
    .bind(&bank)
    .execute(db)
    .await
    .unwrap();
    env.world.events().await;

    let conn = connection::live(&weldsuite_db::orm(db), &env.entity)
        .await
        .unwrap()
        .unwrap();
    assert!(connection::settlements_available(&conn));
    let (status, body) = answer(sync_now(&caller, &env.books, &conn.id).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["imported"], 1);
    assert_eq!(body["data"]["lines"], 3);
    assert_eq!(body["data"]["booked"], 2);
    assert_eq!(body["data"]["toProcess"], 1);
    assert_eq!(body["data"]["fees"], "2.66");
    assert_eq!(body["data"]["payouts"], "178.34");

    let mollie_account: String = sqlx::query_scalar(
        "select id from bank_accounts where entity_id = $1 and account_type = 'payment_provider'",
    )
    .bind(&env.entity)
    .fetch_one(db)
    .await
    .unwrap();
    let lines: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select provider_transaction_id, amount::text, status, reconciliation_type, category_account_id from bank_transactions where bank_account_id = $1 order by provider_transaction_id",
    )
    .bind(&mollie_account)
    .fetch_all(db)
    .await
    .unwrap();
    let keys: Vec<&str> = lines.iter().map(|l| l.0.as_str()).collect();
    assert_eq!(
        keys,
        vec![
            "mollie:stl_one:fees",
            "mollie:stl_one:payment:tr_outside",
            "mollie:stl_one:payout"
        ]
    );
    // The payment made outside WeldBooks waits for the owner; the one on the invoice is not a line.
    assert_eq!(
        (lines[1].1.as_str(), lines[1].2.as_str()),
        ("60.00", "unreconciled")
    );
    // The fees went to bank costs.
    assert_eq!(
        (
            lines[0].1.as_str(),
            lines[0].2.as_str(),
            lines[0].3.as_deref()
        ),
        ("-2.66", "reconciled", Some("auto"))
    );
    let costs: String =
        sqlx::query_scalar("select id from accounts where entity_id = $1 and code = '4650'")
            .bind(&env.entity)
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(lines[0].4.as_deref(), Some(costs.as_str()));
    // The payout is a transfer through transfers in transit.
    assert_eq!(
        (
            lines[2].1.as_str(),
            lines[2].2.as_str(),
            lines[2].3.as_deref()
        ),
        ("-178.34", "reconciled", Some("auto"))
    );
    let transit: String = sqlx::query_scalar("select id from accounts where entity_id = $1 and metadata->>'systemRole' = 'transfers_in_transit'")
        .bind(&env.entity)
        .fetch_one(db)
        .await
        .unwrap();
    assert_eq!(lines[2].4.as_deref(), Some(transit.as_str()));
    // The incoming line on the real bank was booked against transit with it: they pair.
    let paired = row_of(db, "bank_transactions", &incoming).await;
    assert_eq!(paired["status"], "reconciled");
    assert_eq!(paired["category_account_id"], transit);
    // The accounts: transit nets to nothing, the Mollie account holds the 60.00 still to process.
    let balance = |id: String| {
        let db = db.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "select current_balance::text from accounts where id = $1",
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(balance(transit.clone()).await, "0.00");
    let mollie_ledger: String =
        sqlx::query_scalar("select ledger_account_id from bank_accounts where id = $1")
            .bind(&mollie_account)
            .fetch_one(db)
            .await
            .unwrap();
    assert_eq!(balance(mollie_ledger).await, "-60.00");
    assert_eq!(balance(bank_ledger).await, "178.34");
    assert_eq!(balance(costs).await, "2.66");
    let events: Vec<String> = env
        .world
        .events()
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        events
            .iter()
            .filter(|e| *e == "bank_transaction.created")
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| *e == "bank_transaction.processed")
            .count(),
        2
    );

    // Read again: nothing is added.
    let (status, body) = answer(sync_now(&caller, &env.books, &conn.id).await).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (
            body["data"]["imported"].clone(),
            body["data"]["skipped"].clone(),
            body["data"]["lines"].clone()
        ),
        (json!(0), json!(1), json!(0))
    );
    assert_eq!(
        count(
            db,
            "select count(*) from bank_transactions where bank_account_id = $1",
            &mollie_account
        )
        .await,
        3
    );
    assert_eq!(env.world.events().await.len(), 0);

    // The daily run does the same without a member.
    let swept = settlements::sync_workspace(&env.books, db, WORKSPACE, WORKSPACE)
        .await
        .unwrap();
    assert!(swept.connections >= 1 && swept.failed == 0);
    assert_eq!(
        count(
            db,
            "select count(*) from bank_transactions where bank_account_id = $1",
            &mollie_account
        )
        .await,
        3
    );
}

#[tokio::test]
async fn an_api_key_connection_cannot_read_settlements() {
    let Some(env) = env().await else { return };
    let view = connect_key(&env, "test_sweepkey1").await;
    let conn = connection::live(&weldsuite_db::orm(&env.world.db), &env.entity)
        .await
        .unwrap()
        .unwrap();
    assert!(!connection::settlements_available(&conn));
    // Neither the sync asks Mollie for them: an organisation's data needs Mollie Connect.
    let caller = env.world.caller(&env.entity);
    let (status, _) =
        answer(sync_now(&caller, &env.books, view["id"].as_str().unwrap()).await).await;
    assert_eq!(status, 409);
    assert_eq!(env.fake.calls("/v2/settlements"), 0);
}

#[tokio::test]
async fn a_provider_account_is_never_the_default_bank() {
    let Some(env) = env().await else { return };
    let db = &env.world.db;
    // The Mollie account comes first, then a plain bank account with no default flag.
    connect_key(&env, "test_defaultkey1").await;
    let ledger = account(db, &env.entity, "1100", "Bank", "asset", "debit", None).await;
    sqlx::query("insert into bank_accounts (id, entity_id, name, currency, ledger_account_id) values ($1, $2, 'Bank', 'EUR', $3)")
        .bind(generate_id("bac"))
        .bind(&env.entity)
        .bind(&ledger)
        .execute(db)
        .await
        .unwrap();
    let (_, picked) =
        weldsuite_books_domain::document_posting::find_default_bank_account(db, &env.entity)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(picked.as_deref(), Some(ledger.as_str()));
}

// ── the PDF ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_pdf_carries_the_pay_link_only_when_online_payment_is_set_up() {
    use crate::delivery::view::invoice_document;
    use crate::delivery::{attach_pay_link, history_of, link_nonce};
    let Some(env) = env().await else {
        return;
    };
    let db = &env.world.db;
    let now = weldsuite_books_domain::http::now_ms();
    // The PDF's model of invoice `id`, with the pay link attached when it applies.
    let document = |id: String| {
        let (env, db) = (&env, db);
        async move {
            let row = load_invoice(db, &id).await.unwrap().unwrap();
            let items = crate::finalize::load_items(db, &id, true).await.unwrap();
            let mut doc = invoice_document(db, &env.books.keyring, &row, &items, now)
                .await
                .unwrap()
                .unwrap();
            attach_pay_link(&env.books, db, WORKSPACE, &row, None, &mut doc)
                .await
                .unwrap();
            doc
        }
    };
    let (id, _) = sent_invoice(&env).await;

    // Mollie is not connected: no link, even with a public link.
    document_uri(&env, &id).await;
    assert!(document(id.clone()).await.pdf.pay_link.is_none());

    // Connected, with the invoice's public link: the PDF says where to pay.
    connect_key(&env, "test_pdfkey123").await;
    let link = document(id.clone()).await.pdf.pay_link.expect("a pay link");
    assert_eq!(link.label, "Online betalen:");
    assert!(
        link.url.starts_with(&format!("{PORTAL}/d/")),
        "{}",
        link.url
    );

    // Connected, but the invoice has no public link yet: none is made here.
    let (other, _) = sent_invoice(&env).await;
    assert!(document(other.clone()).await.pdf.pay_link.is_none());
    let row = load_invoice(db, &other).await.unwrap().unwrap();
    assert!(link_nonce(&history_of(&row)).is_none());
}
