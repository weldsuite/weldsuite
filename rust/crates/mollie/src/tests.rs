use std::sync::{Arc, Mutex};

use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse};

use super::*;

/// Records the requests and answers each with the next canned response.
#[derive(Default)]
struct Recorded {
    requests: Mutex<Vec<HttpRequest>>,
    answers: Mutex<Vec<Result<HttpResponse, PortError>>>,
}

impl DynOutboundHttp for Recorded {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        self.requests.lock().expect("lock").push(request);
        let answer = self.answers.lock().expect("lock").remove(0);
        Box::pin(std::future::ready(answer))
    }
}

fn http(answers: Vec<Result<HttpResponse, PortError>>) -> (Arc<Recorded>, OutboundHttp) {
    let recorded = Arc::new(Recorded {
        requests: Mutex::default(),
        answers: Mutex::new(answers),
    });
    let http = OutboundHttp(Arc::clone(&recorded) as Arc<dyn DynOutboundHttp>);
    (recorded, http)
}

fn answer(status: u16, body: &Value) -> HttpResponse {
    HttpResponse::new(status, body.to_string().into_bytes())
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

fn body_of(request: &HttpRequest) -> Value {
    serde_json::from_slice(request.body.as_deref().expect("body")).expect("json")
}

#[test]
fn money_reads_and_writes_two_decimals() {
    let money = Money::parse("eur", "9.99").expect("money");
    assert_eq!(money.currency, "EUR");
    assert_eq!(money.cents, 999);
    assert_eq!(money.value(), "9.99");
    assert_eq!(Money::parse("EUR", "10").expect("money").value(), "10.00");
    assert_eq!(Money::parse("EUR", "10.5").expect("money").value(), "10.50");
    assert_eq!(Money::parse("EUR", "0.05").expect("money").value(), "0.05");
    for bad in ["", "-1.00", "1.234", "1,00", "abc", ".5", "1."] {
        assert_eq!(Money::parse("EUR", bad), None, "{bad:?}");
    }
    assert_eq!(Money::parse("EURO", "1.00"), None);
    assert_eq!(Money::from_cents("eur", 6533).value(), "65.33");
    assert_eq!(Money::from_cents("EUR", -5).cents, 0);
}

#[test]
fn ids_are_checked_before_they_reach_a_path() {
    assert!(is_payment_id("tr_WDqYK6vllg"));
    assert!(is_customer_id("cst_8wmqcHMN4U"));
    assert!(is_mandate_id("mdt_h3gAaD5zP"));
    for bad in ["", "tr_", "ord_abc", "tr_../x", "tr_a b", "tr_a/b"] {
        assert!(!is_payment_id(bad), "{bad:?}");
    }
    assert!(!is_customer_id("tr_abc"));
    assert!(!is_mandate_id("mdt_../x"));
}

#[tokio::test]
async fn creates_a_one_off_payment_with_the_amount_urls_and_metadata() {
    let (recorded, http) = http(vec![Ok(answer(
        201,
        &json!({
            "resource": "payment",
            "id": "tr_7UhSN1zuXS",
            "mode": "test",
            "status": "open",
            "amount": { "currency": "EUR", "value": "10.00" },
            "metadata": { "workspaceId": "ws_1" },
            "_links": { "checkout": { "href": "https://www.mollie.com/checkout/select-method/7UhSN1zuXS", "type": "text/html" } },
        }),
    ))]);
    let mollie = Mollie::new(
        "https://api.mollie.com/v2/",
        "test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM",
    );
    assert!(mollie.is_test());
    let amount = Money::parse("EUR", "10.00").expect("money");
    let payment = NewPayment {
        amount: &amount,
        description: "Credits: 1000 credits",
        redirect_url: Some(
            "https://app.weldsuite.eu/settings/billing?credits=success&checkout=ctp_1",
        ),
        cancel_url: Some("https://app.weldsuite.eu/settings/billing?credits=cancelled"),
        webhook_url: "https://app.weldsuite.eu/api/webhooks/mollie",
        metadata: json!({ "workspaceId": "ws_1", "packageId": "pkg_1", "userId": "user_1" }),
        sequence: Sequence::OneOff,
        methods: Vec::new(),
        locale: None,
    };
    let created = mollie
        .create(&http, &payment, "ctp_1")
        .await
        .expect("created");
    assert_eq!(created.id, "tr_7UhSN1zuXS");
    assert_eq!(created.status, PaymentStatus::Open);
    assert_eq!(
        created.checkout_url.as_deref(),
        Some("https://www.mollie.com/checkout/select-method/7UhSN1zuXS")
    );

    let requests = recorded.requests.lock().expect("lock");
    let request = &requests[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.url, "https://api.mollie.com/v2/payments");
    assert_eq!(
        header(request, "authorization"),
        Some("Bearer test_dHar4XY7LxsDOtmnkVtjNVWXLSlXsM")
    );
    assert_eq!(header(request, "content-type"), Some("application/json"));
    assert_eq!(header(request, "idempotency-key"), Some("ctp_1"));
    assert_eq!(
        body_of(request),
        json!({
            "amount": { "currency": "EUR", "value": "10.00" },
            "description": "Credits: 1000 credits",
            "redirectUrl": "https://app.weldsuite.eu/settings/billing?credits=success&checkout=ctp_1",
            "cancelUrl": "https://app.weldsuite.eu/settings/billing?credits=cancelled",
            "webhookUrl": "https://app.weldsuite.eu/api/webhooks/mollie",
            "metadata": { "workspaceId": "ws_1", "packageId": "pkg_1", "userId": "user_1" },
        })
    );
}

#[test]
fn first_and_recurring_payments_name_the_customer_and_mandate() {
    let amount = Money::from_cents("EUR", 17787);
    let first = NewPayment {
        amount: &amount,
        description: "WeldSuite Business, 3 seats",
        redirect_url: Some("https://app.weldsuite.eu/settings/billing?checkout=bpy_1"),
        cancel_url: None,
        webhook_url: "https://app.weldsuite.eu/api/webhooks/mollie",
        metadata: json!({ "kind": "billing" }),
        sequence: Sequence::First {
            customer_id: "cst_1".to_owned(),
        },
        methods: vec!["creditcard".to_owned()],
        locale: Some("nl_NL".to_owned()),
    };
    let body = first.body();
    assert_eq!(body["sequenceType"], "first");
    assert_eq!(body["customerId"], "cst_1");
    assert_eq!(body["method"], json!(["creditcard"]));
    assert_eq!(body["locale"], "nl_NL");
    assert!(body.get("mandateId").is_none());

    let recurring = NewPayment {
        redirect_url: None,
        sequence: Sequence::Recurring {
            customer_id: "cst_1".to_owned(),
            mandate_id: "mdt_1".to_owned(),
        },
        methods: Vec::new(),
        locale: None,
        ..first
    };
    let body = recurring.body();
    assert_eq!(body["sequenceType"], "recurring");
    assert_eq!(body["mandateId"], "mdt_1");
    assert!(
        body.get("redirectUrl").is_none(),
        "no checkout to return from"
    );
    assert!(body.get("method").is_none());
}

#[tokio::test]
async fn reads_a_payment_its_mandate_and_reversals() {
    let (recorded, http) = http(vec![Ok(answer(
        200,
        &json!({
            "id": "tr_abc123",
            "status": "paid",
            "sequenceType": "first",
            "customerId": "cst_1",
            "mandateId": "mdt_9",
            "method": "creditcard",
            "paidAt": "2026-11-14T10:00:00+00:00",
            "details": { "cardNumber": "4242", "cardLabel": "Visa", "cardExpiryDate": "2028-04-30" },
            "amount": { "currency": "EUR", "value": "25.00" },
            "amountRefunded": { "currency": "EUR", "value": "20.00" },
            "amountChargedBack": { "currency": "EUR", "value": "5.00" },
            "metadata": { "kind": "credit_topup" },
        }),
    ))]);
    let mollie = Mollie::new(DEFAULT_API_URL, "live_key");
    let payment = mollie.payment(&http, "tr_abc123").await.expect("payment");
    assert_eq!(payment.status, PaymentStatus::Paid);
    assert_eq!(payment.metadata["kind"], "credit_topup");
    assert_eq!(payment.mandate_id.as_deref(), Some("mdt_9"));
    assert_eq!(payment.customer_id.as_deref(), Some("cst_1"));
    assert_eq!(payment.details.label.as_deref(), Some("Visa •••• 4242"));
    assert_eq!(payment.details.expiry.as_deref(), Some("2028-04-30"));
    assert!(payment.fully_reversed());
    assert!(payment.charged_back());
    let request = &recorded.requests.lock().expect("lock")[0];
    assert_eq!(request.method, "GET");
    assert_eq!(request.url, "https://api.mollie.com/v2/payments/tr_abc123");
    assert!(request.body.is_none());
}

#[tokio::test]
async fn reports_refusals_and_never_sends_a_bad_id() {
    let (recorded, http) = http(vec![
        Ok(answer(
            404,
            &json!({ "status": 404, "title": "Not Found", "detail": "No payment exists with token tr_nope." }),
        )),
        Err(PortError::backend("connection refused")),
    ]);
    let mollie = Mollie::new(DEFAULT_API_URL, "live_key");
    let missing = mollie.payment(&http, "tr_nope").await.expect_err("404");
    assert!(missing.is_not_found(), "{missing}");
    assert!(missing.is_refusal());
    assert!(missing.to_string().contains("No payment exists"));
    let down = mollie.payment(&http, "tr_down").await.expect_err("down");
    assert!(matches!(down, MollieError::Unreachable(_)));
    assert!(!down.is_refusal());
    let bad = mollie.payment(&http, "../admin").await.expect_err("bad id");
    assert!(bad.is_not_found());
    assert_eq!(recorded.requests.lock().expect("lock").len(), 2);
}

#[test]
fn partial_reversals_and_other_currencies_are_not_full() {
    let payment = |refunded: Option<(&str, &str)>| Payment {
        id: "tr_x".to_owned(),
        status: PaymentStatus::Paid,
        amount: Money::parse("EUR", "10.00"),
        amount_refunded: refunded.and_then(|(c, v)| Money::parse(c, v)),
        amount_charged_back: None,
        metadata: Map::new(),
        checkout_url: None,
        sequence_type: None,
        customer_id: None,
        mandate_id: None,
        details: MethodDetails::default(),
        paid_at: None,
        failure_reason: None,
    };
    assert!(!payment(None).fully_reversed());
    assert!(!payment(Some(("EUR", "9.99"))).fully_reversed());
    assert!(!payment(Some(("USD", "10.00"))).fully_reversed());
    assert!(payment(Some(("EUR", "10.00"))).fully_reversed());
}

#[tokio::test]
async fn creates_customers_and_lists_mandates_newest_first() {
    let (recorded, http) = http(vec![
        Ok(answer(
            201,
            &json!({ "resource": "customer", "id": "cst_8wmqcHMN4U" }),
        )),
        Ok(answer(
            200,
            &json!({
                "count": 2,
                "_embedded": { "mandates": [
                    { "id": "mdt_old", "status": "invalid", "method": "creditcard", "createdAt": "2026-01-01T00:00:00+00:00",
                      "details": { "cardNumber": "1111", "cardLabel": "Mastercard" } },
                    { "id": "mdt_new", "status": "valid", "method": "directdebit", "createdAt": "2026-11-01T00:00:00+00:00",
                      "details": { "consumerName": "Acme BV", "consumerAccount": "NL55INGB0000000000" } },
                ] },
            }),
        )),
    ]);
    let mollie = Mollie::new(DEFAULT_API_URL, "test_key");
    let customer = NewCustomer {
        name: "Acme BV".to_owned(),
        email: Some("billing@acme.test".to_owned()),
        locale: Some("nl_NL".to_owned()),
        metadata: json!({ "workspaceId": "ws_1" }),
    };
    let id = mollie
        .create_customer(&http, &customer, "bac_1")
        .await
        .expect("customer");
    assert_eq!(id, "cst_8wmqcHMN4U");
    let mandates = mollie.mandates(&http, &id).await.expect("mandates");
    assert_eq!(mandates[0].id, "mdt_new");
    assert!(mandates[0].is_usable());
    assert_eq!(mandates[0].details.label.as_deref(), Some("NL•• •••• 0000"));
    assert_eq!(mandates[0].details.last4.as_deref(), Some("0000"));
    assert!(!mandates[1].is_usable());
    assert_eq!(
        mandates[1].details.label.as_deref(),
        Some("Mastercard •••• 1111")
    );

    let requests = recorded.requests.lock().expect("lock");
    assert_eq!(requests[0].url, "https://api.mollie.com/v2/customers");
    assert_eq!(header(&requests[0], "idempotency-key"), Some("bac_1"));
    assert_eq!(body_of(&requests[0])["email"], "billing@acme.test");
    assert_eq!(
        requests[1].url,
        "https://api.mollie.com/v2/customers/cst_8wmqcHMN4U/mandates?limit=50"
    );
}

#[tokio::test]
async fn revokes_mandates_and_refunds_payments() {
    let (recorded, http) = http(vec![
        Ok(HttpResponse::new(204, Vec::new())),
        Ok(answer(404, &json!({ "detail": "gone" }))),
        Ok(answer(
            201,
            &json!({ "id": "re_4qqhO89gsT", "status": "pending", "amount": { "currency": "EUR", "value": "5.00" } }),
        )),
    ]);
    let mollie = Mollie::new(DEFAULT_API_URL, "test_key");
    mollie
        .revoke_mandate(&http, "cst_1", "mdt_1")
        .await
        .expect("revoked");
    mollie
        .revoke_mandate(&http, "cst_1", "mdt_2")
        .await
        .expect("already gone counts as revoked");
    let refund = mollie
        .refund(
            &http,
            "tr_1",
            &Money::from_cents("EUR", 500),
            "Refund INV-1",
            "refund:1",
        )
        .await
        .expect("refund");
    assert_eq!(refund.id, "re_4qqhO89gsT");
    let requests = recorded.requests.lock().expect("lock");
    assert_eq!(requests[0].method, "DELETE");
    assert_eq!(
        requests[0].url,
        "https://api.mollie.com/v2/customers/cst_1/mandates/mdt_1"
    );
    assert_eq!(
        requests[2].url,
        "https://api.mollie.com/v2/payments/tr_1/refunds"
    );
    assert_eq!(body_of(&requests[2])["amount"]["value"], "5.00");
}

#[test]
fn masks_ibans_and_maps_locales() {
    assert_eq!(mask_iban("NL55 INGB 0000 0012 34"), "NL•• •••• 1234");
    assert_eq!(checkout_locale(Some("nl")), Some("nl_NL".to_owned()));
    assert_eq!(checkout_locale(Some("en-GB")), Some("en_US".to_owned()));
    assert_eq!(checkout_locale(None), None);
    assert_eq!(
        with_query(
            "https://app.weldsuite.eu/settings/billing?x=1",
            "checkout",
            "bpy_1"
        )
        .as_deref(),
        Some("https://app.weldsuite.eu/settings/billing?x=1&checkout=bpy_1")
    );
}
