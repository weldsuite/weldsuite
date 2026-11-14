//! The Mollie credit top-up against the real master schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`), with Mollie faked at
//! the HTTP port: a checkout writes nothing to the wallet, a paid payment
//! grants its credits exactly once however often (or however concurrently)
//! it is settled, an unpaid one grants nothing, and a full refund takes the
//! credits back once.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set; otherwise every test
//! returns early.

use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use weldsuite_core_platform::topup::ledger::{Applied, Reversed};
use weldsuite_core_platform::topup::mollie::{Money, Payment, PaymentStatus};
use weldsuite_core_platform::topup::{Buyer, CheckoutInput, Settled, TopUp, TopUpSettings, settle};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynCache, DynOutboundHttp, HttpRequest, HttpResponse, MemoryCache, OutboundHttp,
    PortError,
};

fn master() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    Some(master_pool(&url, 4).expect("master"))
}

/// Mollie: records the requests, answers each with the next response.
#[derive(Default)]
struct FakeMollie {
    requests: Mutex<Vec<HttpRequest>>,
    answers: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for FakeMollie {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        self.requests.lock().expect("lock").push(request);
        let mut answers = self.answers.lock().expect("lock");
        let answer = if answers.is_empty() {
            Err(PortError::backend("no answer left"))
        } else {
            let body = answers.remove(0);
            Ok(HttpResponse::new(201, body.to_string().into_bytes()))
        };
        Box::pin(std::future::ready(answer))
    }
}

/// A workspace and an active EUR package of its own.
async fn seed(master: &PgPool) -> (String, String) {
    let workspace = generate_id("ws");
    sqlx::query("insert into workspaces (id, name, slug) values ($1, $1, $1)")
        .bind(&workspace)
        .execute(master)
        .await
        .expect("workspace");
    let package = generate_id("pkg");
    sqlx::query(
        "insert into credit_packages (id, name, credits, price, currency, sort_order, is_active)
         values ($1, 'Small', 1000, '9.99', 'EUR', 99, 1)",
    )
    .bind(&package)
    .execute(master)
    .await
    .expect("package");
    (workspace, package)
}

async fn balance(master: &PgPool, workspace: &str) -> Option<i32> {
    sqlx::query_scalar("select current_balance from workspace_credits where workspace_id = $1")
        .bind(workspace)
        .fetch_optional(master)
        .await
        .expect("balance")
}

async fn ledger(master: &PgPool, workspace: &str) -> Vec<(String, i32, Option<String>)> {
    sqlx::query_as(
        "select type, amount, amount_paid::text from credit_transactions
         where workspace_id = $1 order by created_at, id",
    )
    .bind(workspace)
    .fetch_all(master)
    .await
    .expect("ledger")
}

fn paid(id: &str, workspace: &str, checkout: &str, status: PaymentStatus) -> Payment {
    let metadata: Map<String, Value> = json!({
        "kind": "credit_topup",
        "checkoutId": checkout,
        "workspaceId": workspace,
        "packageId": "pkg_x",
        "credits": 1000,
        "userId": "user_1",
    })
    .as_object()
    .cloned()
    .unwrap_or_default();
    Payment {
        id: id.to_owned(),
        status,
        amount: Money::parse("EUR", "9.99"),
        amount_refunded: None,
        amount_charged_back: None,
        metadata,
        checkout_url: None,
        sequence_type: None,
        customer_id: None,
        mandate_id: None,
        details: weldsuite_core_platform::topup::mollie::MethodDetails::default(),
        paid_at: None,
        failure_reason: None,
    }
}

fn top_up(fake: &Arc<FakeMollie>, cache: Arc<dyn DynCache>) -> TopUp {
    let settings = TopUpSettings::from_lookup(&|name: &str| match name {
        "MOLLIE_API_KEY" => Some("test_key".to_owned()),
        "PUBLIC_URL" => Some("https://app.weldsuite.eu".to_owned()),
        _ => None,
    })
    .expect("valid")
    .expect("configured");
    let http = OutboundHttp(Arc::clone(fake) as Arc<dyn DynOutboundHttp>);
    TopUp::new(&settings, Some(http), Some(cache))
}

#[tokio::test]
async fn a_checkout_prices_the_package_and_writes_nothing_to_the_wallet() {
    let Some(master) = master() else { return };
    let (workspace, package) = seed(&master).await;
    let fake = Arc::new(FakeMollie::default());
    fake.answers.lock().expect("lock").push(json!({
        "id": "tr_checkout1",
        "status": "open",
        "amount": { "currency": "EUR", "value": "9.99" },
        "_links": { "checkout": { "href": "https://www.mollie.com/checkout/select-method/checkout1" } },
    }));
    let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
    let top_up = top_up(&fake, Arc::clone(&cache));
    let url = top_up
        .start(
            &master,
            None,
            Buyer {
                workspace_id: &workspace,
                user_id: "user_1",
            },
            &CheckoutInput {
                package_id: package.clone(),
                success_url: Some(
                    "https://app.weldsuite.eu/w/acme/settings/billing?credits=success".to_owned(),
                ),
                cancel_url: Some(
                    "https://app.weldsuite.eu/w/acme/settings/billing?credits=cancelled".to_owned(),
                ),
            },
        )
        .await
        .expect("checkout");
    assert_eq!(
        url,
        "https://www.mollie.com/checkout/select-method/checkout1"
    );

    let request = fake.requests.lock().expect("lock")[0].clone();
    let body: Value = serde_json::from_slice(&request.body.expect("body")).expect("json");
    assert_eq!(
        body["amount"],
        json!({ "currency": "EUR", "value": "9.99" })
    );
    assert_eq!(
        body["webhookUrl"],
        "https://app.weldsuite.eu/api/webhooks/mollie"
    );
    assert_eq!(body["metadata"]["workspaceId"], json!(workspace));
    assert_eq!(body["metadata"]["packageId"], json!(package));
    assert_eq!(body["metadata"]["credits"], 1000);
    assert_eq!(body["metadata"]["userId"], "user_1");
    let checkout = body["metadata"]["checkoutId"]
        .as_str()
        .expect("checkout id");
    assert_eq!(
        body["redirectUrl"],
        json!(format!(
            "https://app.weldsuite.eu/w/acme/settings/billing?credits=success&checkout={checkout}"
        ))
    );
    assert_eq!(ledger(&master, &workspace).await, Vec::new());
    assert_eq!(balance(&master, &workspace).await, None);
}

#[tokio::test]
async fn a_checkout_refuses_a_package_it_cannot_sell() {
    let Some(master) = master() else { return };
    let (workspace, package) = seed(&master).await;
    let fake = Arc::new(FakeMollie::default());
    let top_up = top_up(&fake, Arc::new(MemoryCache::new()));

    // An inactive or unknown package is a 404, a non-EUR one a 400.
    sqlx::query("update credit_packages set currency = 'USD' where id = $1")
        .bind(&package)
        .execute(&master)
        .await
        .expect("usd");
    let buyer = Buyer {
        workspace_id: &workspace,
        user_id: "user_1",
    };
    let usd = top_up
        .start(
            &master,
            None,
            buyer,
            &CheckoutInput {
                package_id: package.clone(),
                ..CheckoutInput::default()
            },
        )
        .await
        .expect_err("usd")
        .respond();
    assert_eq!(usd.status(), http::StatusCode::BAD_REQUEST);
    let missing = top_up
        .start(
            &master,
            None,
            buyer,
            &CheckoutInput {
                package_id: "pkg_none".to_owned(),
                ..CheckoutInput::default()
            },
        )
        .await
        .expect_err("missing")
        .respond();
    assert_eq!(missing.status(), http::StatusCode::NOT_FOUND);
    assert!(
        fake.requests.lock().expect("lock").is_empty(),
        "no payment made"
    );
}

#[tokio::test]
async fn a_paid_payment_grants_once() {
    let Some(master) = master() else { return };
    let (workspace, _) = seed(&master).await;
    let payment_id = generate_id("tr").replace('_', "_x");
    let payment = paid(&payment_id, &workspace, "ctp_once", PaymentStatus::Paid);

    let first = settle(&master, &payment).await.expect("settled");
    assert!(
        matches!(
            first,
            Settled::Granted(Applied::New {
                balance_after: 1000,
                ..
            })
        ),
        "{first:?}"
    );
    // Mollie delivers again (a retry, a status change, a refund of another
    // payment): nothing more.
    let again = settle(&master, &payment).await.expect("settled");
    assert_eq!(again, Settled::Granted(Applied::Duplicate));
    assert_eq!(balance(&master, &workspace).await, Some(1000));
    assert_eq!(
        ledger(&master, &workspace).await,
        vec![("purchase".to_owned(), 1000, Some("9.99".to_owned()))]
    );

    // Two deliveries at once: one grant.
    let racing = paid(
        &format!("{payment_id}r"),
        &workspace,
        "ctp_race",
        PaymentStatus::Paid,
    );
    let (a, b) = tokio::join!(settle(&master, &racing), settle(&master, &racing));
    let granted = [a.expect("a"), b.expect("b")]
        .into_iter()
        .filter(|settled| matches!(settled, Settled::Granted(Applied::New { .. })))
        .count();
    assert_eq!(granted, 1);
    assert_eq!(balance(&master, &workspace).await, Some(2000));
    assert_eq!(ledger(&master, &workspace).await.len(), 2);
}

#[tokio::test]
async fn unpaid_payments_grant_nothing() {
    let Some(master) = master() else { return };
    let (workspace, _) = seed(&master).await;
    for (n, status) in [
        PaymentStatus::Failed,
        PaymentStatus::Expired,
        PaymentStatus::Canceled,
        PaymentStatus::Open,
    ]
    .into_iter()
    .enumerate()
    {
        let payment = paid(&format!("tr_unpaid{n}"), &workspace, "ctp_unpaid", status);
        assert_eq!(
            settle(&master, &payment).await.expect("settled"),
            Settled::Ignored("not paid")
        );
    }
    assert_eq!(ledger(&master, &workspace).await, Vec::new());
    assert_eq!(balance(&master, &workspace).await, None);
}

#[tokio::test]
async fn a_full_refund_takes_the_credits_back_once() {
    let Some(master) = master() else { return };
    let (workspace, _) = seed(&master).await;
    let payment_id = format!("tr_refund{}", generate_id("").replace('_', ""));
    let mut payment = paid(&payment_id, &workspace, "ctp_refund", PaymentStatus::Paid);
    settle(&master, &payment).await.expect("granted");
    payment.amount_refunded = Money::parse("EUR", "9.99");
    let reversed = settle(&master, &payment).await.expect("reversed");
    assert!(
        matches!(
            reversed,
            Settled::Reversed(Reversed::ClawedBack(Applied::New {
                balance_after: 0,
                ..
            }))
        ),
        "{reversed:?}"
    );
    assert_eq!(
        settle(&master, &payment).await.expect("again"),
        Settled::Reversed(Reversed::ClawedBack(Applied::Duplicate))
    );
    assert_eq!(balance(&master, &workspace).await, Some(0));
    let rows = ledger(&master, &workspace).await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1], ("adjustment".to_owned(), -1000, None));

    // Refunded before it was ever granted: nothing to take back.
    let mut never = paid(
        &format!("{payment_id}n"),
        &workspace,
        "ctp_never",
        PaymentStatus::Paid,
    );
    never.amount_refunded = Money::parse("EUR", "9.99");
    assert_eq!(
        settle(&master, &never).await.expect("nothing"),
        Settled::Reversed(Reversed::NothingGranted)
    );
}

#[tokio::test]
async fn the_return_page_reads_how_its_checkout_ended() {
    let Some(master) = master() else { return };
    let (workspace, package) = seed(&master).await;
    let fake = Arc::new(FakeMollie::default());
    let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
    let top_up = top_up(&fake, Arc::clone(&cache));
    fake.answers.lock().expect("lock").push(json!({
        "id": "tr_return1",
        "status": "open",
        "amount": { "currency": "EUR", "value": "9.99" },
        "_links": { "checkout": { "href": "https://www.mollie.com/checkout/x" } },
    }));
    let buyer = Buyer {
        workspace_id: &workspace,
        user_id: "user_1",
    };
    top_up
        .start(
            &master,
            None,
            buyer,
            &CheckoutInput {
                package_id: package,
                ..CheckoutInput::default()
            },
        )
        .await
        .expect("checkout");
    let body: Value = serde_json::from_slice(
        &fake.requests.lock().expect("lock")[0]
            .body
            .clone()
            .expect("body"),
    )
    .expect("json");
    let checkout = body["metadata"]["checkoutId"]
        .as_str()
        .expect("checkout")
        .to_owned();
    // Back before the webhook: Mollie says paid, so the page settles it.
    let mut mollie_paid = body.clone();
    mollie_paid["id"] = json!("tr_return1");
    mollie_paid["status"] = json!("paid");
    fake.answers.lock().expect("lock").push(mollie_paid.clone());
    let status = top_up
        .status(&master, None, &workspace, &checkout)
        .await
        .expect("status");
    assert_eq!(status["status"], "paid");
    assert_eq!(status["credits"], 1000);
    assert_eq!(balance(&master, &workspace).await, Some(1000));
    // The webhook after it grants nothing more.
    let payment = paid("tr_return1", &workspace, &checkout, PaymentStatus::Paid);
    assert_eq!(
        settle(&master, &payment).await.expect("settled"),
        Settled::Granted(Applied::Duplicate)
    );
    // Another workspace can't read it.
    assert!(
        top_up
            .status(&master, None, "ws_other", &checkout)
            .await
            .is_err()
    );
    // Without the cached checkout, the ledger still knows it was paid.
    cache
        .delete_boxed(&format!("credits:topup:{checkout}"))
        .await
        .expect("delete");
    let status = top_up
        .status(&master, None, &workspace, &checkout)
        .await
        .expect("status");
    assert_eq!(status["status"], "paid");
    let unknown = top_up
        .status(&master, None, &workspace, "ctp_neverseen")
        .await
        .expect("status");
    assert_eq!(unknown["status"], "unknown");
}
