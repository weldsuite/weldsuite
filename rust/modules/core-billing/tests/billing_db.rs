//! Plan billing on the real schema (`WELDSUITE_TEST_MASTER_URL` and
//! `WELDSUITE_TEST_TENANT_URL`, built by `scripts/rust-test-db.ts`; skipped
//! without them), against a recorded Mollie and an issuer that only counts:
//! a checkout, its first payment, renewals on the anchor, a prorated seat
//! upgrade, a scheduled decrease, a failed renewal, past due, and the end of
//! the grace period on Free.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use time::macros::datetime;
use weldsuite_core_billing::engine::{self, Actor, CheckoutAnswer, CheckoutInput};
use weldsuite_core_billing::period::Cycle;
use weldsuite_core_billing::renewals::run_renewals;
use weldsuite_core_billing::{
    BillingSettings, BillingState, InvoiceIssuer, IssueRequest, IssuedInvoice, Settled,
    settle_payment,
};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

const WS: &str = "ws_billingdb1";
const ORG: &str = "org_billingdb1";
const PLAN: &str = "plan_billingdb_business";
const FREE: &str = "plan_billingdb_free";

async fn databases() -> Option<(PgPool, PgPool)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        PgPool::connect(&master).await.expect("master"),
        PgPool::connect(&tenant).await.expect("tenant"),
    ))
}

/// Mollie as the tests set it: customers, payments (first ones open on a
/// checkout, recurring ones in `recurring_status`), read back as stored.
#[derive(Default)]
struct FakeMollie {
    payments: Mutex<HashMap<String, Value>>,
    next: Mutex<u32>,
    recurring_status: Mutex<String>,
    created: Mutex<Vec<Value>>,
}

impl FakeMollie {
    fn set(&self, id: &str, patch: &Value) {
        let mut payments = self.payments.lock().expect("lock");
        let payment = payments.get_mut(id).expect("payment");
        for (key, value) in patch.as_object().expect("object") {
            payment[key] = value.clone();
        }
    }

    fn last_created(&self) -> Value {
        self.created
            .lock()
            .expect("lock")
            .last()
            .cloned()
            .expect("a payment")
    }
}

impl DynOutboundHttp for FakeMollie {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let answer =
            |status: u16, body: Value| Ok(HttpResponse::new(status, body.to_string().into_bytes()));
        let path = request
            .url
            .trim_start_matches("https://api.mollie.test/v2")
            .to_owned();
        let result = match (request.method.as_str(), path.as_str()) {
            ("POST", "/customers") => answer(201, json!({ "id": "cst_billingdb1" })),
            ("POST", "/payments") => {
                let body: Value =
                    serde_json::from_slice(request.body.as_deref().unwrap_or_default())
                        .expect("json");
                let mut next = self.next.lock().expect("lock");
                *next += 1;
                let id = format!("tr_billingdb{next}");
                let recurring = body["sequenceType"] == "recurring";
                let status = if recurring {
                    self.recurring_status.lock().expect("lock").clone()
                } else {
                    "open".to_owned()
                };
                let payment = json!({
                    "id": id,
                    "status": status,
                    "amount": body["amount"],
                    "metadata": body["metadata"],
                    "sequenceType": body["sequenceType"],
                    "customerId": body["customerId"],
                    "mandateId": body["mandateId"],
                    "method": if recurring { json!("creditcard") } else { Value::Null },
                    "paidAt": if status == "paid" { json!("2026-12-14T10:00:00+00:00") } else { Value::Null },
                    "_links": { "checkout": { "href": format!("https://www.mollie.test/checkout/{id}") } },
                });
                self.created.lock().expect("lock").push(body);
                self.payments
                    .lock()
                    .expect("lock")
                    .insert(id, payment.clone());
                answer(201, payment)
            }
            ("GET", p) if p.starts_with("/payments/") => {
                let id = p.trim_start_matches("/payments/");
                match self.payments.lock().expect("lock").get(id) {
                    Some(payment) => answer(200, payment.clone()),
                    None => answer(404, json!({ "detail": "no such payment" })),
                }
            }
            ("GET", p) if p.contains("/mandates") => answer(
                200,
                json!({ "_embedded": { "mandates": [
                    { "id": "mdt_billingdb1", "status": "valid", "method": "creditcard",
                      "details": { "cardNumber": "4242", "cardLabel": "Visa" } },
                ] } }),
            ),
            _ => answer(404, json!({ "detail": format!("unexpected {path}") })),
        };
        Box::pin(std::future::ready(result))
    }
}

/// Counts the invoices it is asked for.
#[derive(Default)]
struct CountingIssuer {
    issued: Mutex<Vec<IssueRequest>>,
}

impl InvoiceIssuer for CountingIssuer {
    fn issue_paid<'a>(
        &'a self,
        request: &'a IssueRequest,
    ) -> BoxFuture<'a, Result<IssuedInvoice, String>> {
        let mut issued = self.issued.lock().expect("lock");
        issued.push(request.clone());
        let number = format!("WS-{:04}", issued.len());
        Box::pin(std::future::ready(Ok(IssuedInvoice {
            provider_invoice_id: format!("inv_billingdb{}", issued.len()),
            number,
            document: None,
        })))
    }
}

async fn exec(db: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query
        .execute(db)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

async fn reset(master: &PgPool, tenant: &PgPool) {
    for sql in [
        "delete from billing_payments where workspace_id = $1",
        "delete from billing_invoices where workspace_id = $1",
        "delete from billing_accounts where workspace_id = $1",
        "delete from credit_transactions where workspace_id = $1",
        "delete from workspace_credits where workspace_id = $1",
        "delete from user_workspaces where workspace_id = $1",
        "delete from workspaces where id = $1",
    ] {
        exec(master, sql, &[WS]).await;
    }
    exec(
        tenant,
        "delete from workspace_settings where id = 'wss_billingdb1'",
        &[],
    )
    .await;
}

async fn seed(master: &PgPool, tenant: &PgPool) {
    exec(
        master,
        "insert into plans (id, name, slug, price_monthly, price_yearly, currency, included_users,
             max_users, monthly_credits, sort_order, is_active)
         values ($1, 'Business', 'billingdb-business', 25, 264, 'EUR', 0, null, 100, 2, true)
         on conflict (id) do update set price_monthly = 25, price_yearly = 264, monthly_credits = 100",
        &[PLAN],
    )
    .await;
    // The Free plan the end of a subscription moves to (`slug = 'free'`).
    exec(
        master,
        "insert into plans (id, name, slug, price_monthly, price_yearly, currency, max_users, sort_order)
         values ($1, 'Free', 'free', 0, 0, 'EUR', 1, 0)
         on conflict (slug) do nothing",
        &[FREE],
    )
    .await;
    exec(
        master,
        "insert into workspaces (id, clerk_org_id, name, slug, plan_id, is_active, paid_plan_required)
         values ($1, $2, 'Billing DB', 'billing-db-test', (select id from plans where slug = 'free'), true, false)",
        &[WS, ORG],
    )
    .await;
    exec(
        tenant,
        "insert into workspace_settings (id, legal_name, email, address_line_1, city, postal_code, country, language)
         values ('wss_billingdb1', 'Billing DB B.V.', 'billing@billingdb.test', 'Keizersgracht 1',
                 'Amsterdam', '1015 AA', 'NL', 'nl')",
        &[],
    )
    .await;
}

fn state(
    master: &PgPool,
    tenant: &PgPool,
    mollie: &Arc<FakeMollie>,
    issuer: &Arc<CountingIssuer>,
) -> BillingState {
    let settings = BillingSettings::from_lookup(&|name: &str| {
        match name {
            "BILLING_PROVIDER" => Some("mollie"),
            "MOLLIE_API_KEY" => Some("test_billingdb"),
            "MOLLIE_API_URL" => Some("https://api.mollie.test/v2"),
            "PUBLIC_URL" => Some("https://app.weldsuite.test"),
            "BILLING_ISSUER_WORKSPACE_ID" => Some("ws_issuer"),
            "BILLING_PAY_LINK_KEY" => Some("0123456789abcdef0123456789abcdef"),
            _ => None,
        }
        .map(str::to_owned)
    })
    .expect("valid")
    .expect("on");
    let tenant = tenant.clone();
    let tenants: weldsuite_core_billing::TenantDatabases = Arc::new(move |_| {
        let tenant = tenant.clone();
        Box::pin(async move { Ok(tenant) })
    });
    BillingState::new(
        master.clone(),
        settings,
        Some(OutboundHttp(Arc::clone(mollie) as Arc<dyn DynOutboundHttp>)),
        None,
        Some(tenants),
        None,
        Arc::clone(issuer) as Arc<dyn InvoiceIssuer>,
        None,
    )
}

async fn workspace(master: &PgPool) -> Value {
    sqlx::query_scalar(
        "select jsonb_build_object('plan', plan_id, 'seats', purchased_seats,
             'status', subscription_status, 'cycle', subscription_cycle,
             'start', to_char(subscription_current_period_start, 'YYYY-MM-DD\"T\"HH24:MI:SS'),
             'end', to_char(subscription_current_period_end, 'YYYY-MM-DD\"T\"HH24:MI:SS'))
         from workspaces where id = $1",
    )
    .bind(WS)
    .fetch_one(master)
    .await
    .expect("workspace")
}

async fn account(master: &PgPool) -> Value {
    sqlx::query_scalar("select to_jsonb(a) from billing_accounts a where workspace_id = $1")
        .bind(WS)
        .fetch_one(master)
        .await
        .expect("account")
}

async fn pay(state: &BillingState, mollie: &FakeMollie, id: &str, now: OffsetDateTime) -> Settled {
    mollie.set(
        id,
        &json!({
            "status": "paid",
            "mandateId": "mdt_billingdb1",
            "method": "creditcard",
            "details": { "cardNumber": "4242", "cardLabel": "Visa" },
            "paidAt": weldsuite_core_billing::period::iso(now),
        }),
    );
    let http = state.http.clone().expect("http");
    let payment = state.mollie.payment(&http, id).await.expect("payment");
    settle_payment(state, &payment, now).await.expect("settled")
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one subscription, start to end
async fn a_subscription_from_checkout_to_free() {
    let Some((master, tenant)) = databases().await else {
        eprintln!("skipped: WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL unset");
        return;
    };
    reset(&master, &tenant).await;
    seed(&master, &tenant).await;
    let mollie = Arc::new(FakeMollie::default());
    *mollie.recurring_status.lock().expect("lock") = "paid".to_owned();
    let issuer = Arc::new(CountingIssuer::default());
    let state = state(&master, &tenant, &mollie, &issuer);
    let actor = Actor {
        workspace_id: WS.to_owned(),
        user_id: Some("user_billingdb".to_owned()),
        tenant: Some(tenant.clone()),
    };

    // 1. Checkout: a first payment for 3 seats × €25 + 21% VAT.
    let t0 = datetime!(2026-11-14 10:00:00 UTC);
    let answer = engine::checkout(
        &state,
        &master,
        None,
        &actor,
        &CheckoutInput {
            plan_id: PLAN.to_owned(),
            seats: 3,
            cycle: Cycle::Monthly,
            success_url: None,
            cancel_url: None,
        },
        t0,
    )
    .await
    .expect("checkout");
    let CheckoutAnswer::Redirect(url) = answer else {
        panic!("a new subscription pays on the checkout: {answer:?}");
    };
    assert!(
        url.starts_with("https://www.mollie.test/checkout/"),
        "{url}"
    );
    let first = mollie.last_created();
    assert_eq!(first["sequenceType"], "first");
    assert_eq!(first["amount"]["value"], "90.75", "3 × €25 + 21%");
    assert!(
        first["redirectUrl"]
            .as_str()
            .unwrap_or_default()
            .contains("checkout=bpy_")
    );
    // Nothing changes before it is paid.
    assert_eq!(workspace(&master).await["seats"], 0);

    // 2. Paid: active, 3 seats, a month on the anchor, credits, an invoice.
    assert_eq!(
        pay(&state, &mollie, "tr_billingdb1", t0).await,
        Settled::Activated
    );
    // A second delivery changes nothing.
    assert!(matches!(
        pay(&state, &mollie, "tr_billingdb1", t0).await,
        Settled::Recorded(_)
    ));
    let ws = workspace(&master).await;
    assert_eq!(ws["plan"], PLAN);
    assert_eq!(ws["seats"], 3);
    assert_eq!(ws["status"], "active");
    assert_eq!(ws["end"], "2026-12-14T10:00:00");
    let acc = account(&master).await;
    assert_eq!(acc["mandate_id"], "mdt_billingdb1");
    assert_eq!(acc["unit_amount"], 2500);
    assert_eq!(acc["anchor_day"], 14);
    let balance: i32 =
        sqlx::query_scalar("select current_balance from workspace_credits where workspace_id = $1")
            .bind(WS)
            .fetch_one(&master)
            .await
            .expect("credits");
    assert_eq!(balance, 100, "the plan's monthly credits");
    assert_eq!(issuer.issued.lock().expect("lock").len(), 1);
    let invoices: i64 =
        sqlx::query_scalar("select count(*) from billing_invoices where workspace_id = $1")
            .bind(WS)
            .fetch_one(&master)
            .await
            .expect("invoices");
    assert_eq!(invoices, 1);

    // 3. Two more seats on day 11 of 30: prorated on the mandate, at once.
    let t1 = datetime!(2026-11-24 09:00:00 UTC);
    let answer = engine::set_seats(&state, &master, None, &actor, 5, t1)
        .await
        .expect("seats");
    assert_eq!(
        answer,
        CheckoutAnswer::Changed {
            scheduled: false,
            effective_at: None,
            purchased_seats: 5
        }
    );
    let proration = mollie.last_created();
    assert_eq!(proration["sequenceType"], "recurring");
    assert_eq!(proration["mandateId"], "mdt_billingdb1");
    // 2 × €25 × 20/30 days = €33.33, + 21% = €40.33.
    assert_eq!(proration["amount"]["value"], "40.33");
    assert_eq!(workspace(&master).await["seats"], 5);

    // 4. One seat fewer waits for the period end.
    let answer = engine::set_seats(&state, &master, None, &actor, 4, t1)
        .await
        .expect("decrease");
    assert!(
        matches!(
            answer,
            CheckoutAnswer::Changed {
                scheduled: true,
                ..
            }
        ),
        "{answer:?}"
    );
    assert_eq!(workspace(&master).await["seats"], 5, "until the period end");

    // 5. The anchor: the scheduled 4 seats are billed for the next month.
    let t2 = datetime!(2026-12-14 10:30:00 UTC);
    let report = run_renewals(&state, t2).await;
    assert_eq!(report.charged, 1, "{report:?}");
    assert_eq!(report.failed, 0, "{report:?}");
    let renewal = mollie.last_created();
    assert_eq!(renewal["sequenceType"], "recurring");
    assert_eq!(renewal["amount"]["value"], "121.00", "4 × €25 + 21%");
    let ws = workspace(&master).await;
    assert_eq!(ws["seats"], 4);
    assert_eq!(ws["end"], "2027-01-14T10:00:00");
    // Running again in the same hour charges nothing twice.
    let again = run_renewals(&state, t2).await;
    assert_eq!(again.charged, 0, "{again:?}");

    // 6. The next renewal fails: past due, the plan keeps working.
    *mollie.recurring_status.lock().expect("lock") = "failed".to_owned();
    let t3 = datetime!(2027-01-14 10:30:00 UTC);
    let report = run_renewals(&state, t3).await;
    assert_eq!(report.past_due, 1, "{report:?}");
    assert_eq!(workspace(&master).await["status"], "past_due");
    assert!(account(&master).await["past_due_payment_id"].is_string());

    // 7. Fourteen days later, still unpaid: Free.
    let t4 = datetime!(2027-01-29 11:00:00 UTC);
    let report = run_renewals(&state, t4).await;
    assert_eq!(report.ended, 1, "{report:?}");
    let ws = workspace(&master).await;
    assert_eq!(ws["status"], "canceled");
    assert_eq!(ws["seats"], 0);
    assert!(ws["end"].is_null());
    let free: String = sqlx::query_scalar("select id from plans where slug = 'free'")
        .fetch_one(&master)
        .await
        .expect("free");
    assert_eq!(ws["plan"], free);
    assert!(account(&master).await["next_charge_at"].is_null());

    reset(&master, &tenant).await;
}
