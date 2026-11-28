//! `POST /public/weldbooks/documents/:token/pay`: a customer pays the open
//! balance of an invoice on Mollie's checkout, and what the public document
//! shows of it (`payment: { enabled, status, methods }`).
//!
//! Mollie's payment is kept in the invoice's `email_history` (no column): a
//! `payment_started` entry per payment made, a `payment_status` entry per
//! change Mollie reported (the webhook writes them). Paying again reuses a
//! payment that is still open for the same amount.

use sea_orm::{EntityTrait, QuerySelect};
use serde_json::{Value, json};
use weldsuite_books_domain::http::{BooksState, now_ms};
use weldsuite_books_domain::js::{millis_of, parse_float, round_money, to_fixed};
use weldsuite_books_domain::payment_refs::{self, PayRef};
use weldsuite_db::{PgPool, orm};
use weldsuite_mollie::{Money, NewPayment, PaymentStatus, Sequence};
use weldsuite_schema::tenant::entities;

use super::connection::{self, methods_of};
use super::{Ctx, PayError, Settings};
use crate::delivery::public::Opened;
use crate::delivery::{append_history, entry, history_of};
use crate::persist::text;

/// The currencies Mollie takes with two decimals.
pub(crate) const SUPPORTED_CURRENCIES: &[&str] = &[
    "EUR", "GBP", "USD", "CHF", "DKK", "NOK", "SEK", "PLN", "CZK", "CAD", "AUD", "BGN", "RON",
];

/// How long a payment Mollie still calls `open` counts as in progress: the
/// customer is on the checkout or at the bank. Later it is an abandoned
/// attempt, and paying again reuses its checkout.
const OPEN_IN_PROGRESS_MS: i64 = 30 * 60 * 1000;

/// The open balance of an invoice, in cents (`0` when it has none).
pub(crate) fn balance_cents(invoice: &Value) -> i64 {
    let balance = text(invoice, "balanceDue")
        .or_else(|| text(invoice, "total"))
        .unwrap_or("0");
    Money::parse("EUR", &to_fixed(round_money(parse_float(balance)), 2)).map_or(0, |m| m.cents)
}

/// An invoice the customer can pay: sent, with a balance, not a credit note.
pub(crate) fn payable(invoice: &Value) -> bool {
    matches!(
        text(invoice, "status"),
        Some("sent" | "finalized" | "partial" | "overdue")
    ) && text(invoice, "type") != Some("credit_note")
        && balance_cents(invoice) > 0
}

pub(crate) fn currency_of(invoice: &Value) -> String {
    text(invoice, "currency")
        .unwrap_or("EUR")
        .to_ascii_uppercase()
}

/// What a customer's payment is on: a Mollie payment of the invoice, and what
/// Mollie last said about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Started {
    pub payment_id: String,
    pub cents: i64,
    pub currency: String,
    pub at_ms: i64,
    pub status: String,
}

/// The Mollie payments made for an invoice, oldest first, each with its
/// latest reported status.
pub(crate) fn started_payments(history: &[Value]) -> Vec<Started> {
    let mut out: Vec<Started> = Vec::new();
    for item in history {
        let Some(id) = text(item, "paymentId") else {
            continue;
        };
        match text(item, "type") {
            Some("payment_started") if !out.iter().any(|s| s.payment_id == id) => {
                out.push(Started {
                    payment_id: id.to_owned(),
                    cents: item.get("amountCents").and_then(Value::as_i64).unwrap_or(0),
                    currency: text(item, "currency").unwrap_or("EUR").to_owned(),
                    at_ms: text(item, "at").and_then(millis_of).unwrap_or(0),
                    status: text(item, "status").unwrap_or("open").to_owned(),
                });
            }
            Some("payment_status") => {
                if let Some(found) = out.iter_mut().find(|s| s.payment_id == id) {
                    text(item, "status")
                        .unwrap_or_default()
                        .clone_into(&mut found.status);
                }
            }
            _ => {}
        }
    }
    out
}

/// A payment Mollie is still working on for the customer: processing at the
/// bank, or open and recent.
fn in_progress(started: &Started, now: i64) -> bool {
    match started.status.as_str() {
        "pending" | "authorized" => true,
        "open" => now - started.at_ms < OPEN_IN_PROGRESS_MS,
        _ => false,
    }
}

/// `payment` of the public document, when the entity has Mollie connected;
/// `None` leaves the document as it is (bank details only).
pub(crate) async fn document_payment(
    books: &BooksState,
    db: &PgPool,
    invoice: &Value,
    status: &str,
) -> Result<Option<Value>, sea_orm::DbErr> {
    let Some(entity) = text(invoice, "entityId") else {
        return Ok(None);
    };
    let Some(conn) = connection::connected(&orm(db), entity).await? else {
        return Ok(None);
    };
    if status == "paid" {
        return Ok(Some(
            json!({ "enabled": false, "status": "paid", "methods": [] }),
        ));
    }
    if !payable(invoice) {
        return Ok(None);
    }
    let settings = Settings::of(books);
    let ready = settings.public_url.is_some()
        && settings.secret.is_some()
        && SUPPORTED_CURRENCIES.contains(&currency_of(invoice).as_str());
    let started = started_payments(&history_of(invoice));
    let now = now_ms();
    let pending = started.iter().any(|s| in_progress(s, now));
    Ok(Some(json!({
        "enabled": ready,
        "status": if pending { "pending" } else { "open" },
        "methods": if ready { methods_of(&conn) } else { Vec::new() },
    })))
}

/// Whether the customer can pay `invoice` online: the entity has Mollie
/// connected with methods, the install can take the payment and the invoice is
/// open in a currency Mollie takes. What the public page offers as `enabled`,
/// and when the invoice's PDF carries the pay link.
pub(crate) async fn online_ready(
    books: &BooksState,
    db: &PgPool,
    invoice: &Value,
) -> Result<bool, sea_orm::DbErr> {
    if !payable(invoice) || !SUPPORTED_CURRENCIES.contains(&currency_of(invoice).as_str()) {
        return Ok(false);
    }
    let settings = Settings::of(books);
    if settings.public_url.is_none() || settings.secret.is_none() {
        return Ok(false);
    }
    let Some(entity) = text(invoice, "entityId") else {
        return Ok(false);
    };
    Ok(connection::connected(&orm(db), entity)
        .await?
        .is_some_and(|conn| !methods_of(&conn).is_empty()))
}

/// How a pay request ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Where the customer pays.
    Checkout(String),
    /// Nothing is open to pay (paid, cancelled, a credit note, or a payment
    /// is already being processed).
    NothingToPay,
    /// Online payment is not set up for this invoice.
    Unavailable(&'static str),
    /// The request itself is wrong.
    Invalid(&'static str),
}

/// A return URL on the pay portal's origin.
pub(crate) fn return_url_ok(settings: &Settings, wanted: &str) -> bool {
    let (Some(portal), Ok(given)) = (settings.portal_url.as_deref(), url::Url::parse(wanted))
    else {
        return false;
    };
    let Ok(portal) = url::Url::parse(portal) else {
        return false;
    };
    matches!(given.scheme(), "http" | "https")
        && given.origin() == portal.origin()
        && given.username().is_empty()
        && given.password().is_none()
        && wanted.len() <= 500
}

async fn seller_name(db: &PgPool, entity: &str) -> Result<String, sea_orm::DbErr> {
    let name: Option<String> = entities::Entity::find_by_id(entity.to_owned())
        .select_only()
        .column(entities::Column::Name)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(name.unwrap_or_default())
}

/// Starts (or resumes) the payment of the opened invoice.
#[allow(
    clippy::too_many_lines,
    reason = "the checks and the steps of one payment, in order"
)]
pub(crate) async fn start(
    books: &BooksState,
    opened: &Opened,
    return_url: &str,
) -> Result<Outcome, PayError> {
    if opened.token.t != "invoice" || !payable(&opened.row) {
        return Ok(Outcome::NothingToPay);
    }
    let invoice = &opened.row;
    let db = orm(&opened.db);
    let entity = text(invoice, "entityId").unwrap_or_default().to_owned();
    let Some(conn) = connection::connected(&db, &entity).await? else {
        return Ok(Outcome::Unavailable("Online payment is not set up"));
    };
    let currency = currency_of(invoice);
    if !SUPPORTED_CURRENCIES.contains(&currency.as_str()) {
        return Ok(Outcome::Unavailable(
            "Online payment is not available in this currency",
        ));
    }
    let Some(ctx) = Ctx::new(books, &opened.db, None) else {
        return Ok(Outcome::Unavailable("Online payment is not set up"));
    };
    let settings = &ctx.settings;
    let (Some(secret), true) = (settings.secret.as_deref(), settings.public_url.is_some()) else {
        return Ok(Outcome::Unavailable("Online payment is not set up"));
    };
    if !return_url_ok(settings, return_url) {
        return Ok(Outcome::Invalid("returnUrl must be on the pay portal"));
    }
    let cents = balance_cents(invoice);
    let invoice_id = opened.token.id.as_str();
    let history = history_of(invoice);
    let started = started_payments(&history);

    // A payment already made for this balance: still open, resume it; paid or
    // being processed, there is nothing more to pay.
    for earlier in started
        .iter()
        .rev()
        .filter(|s| s.cents == cents && s.currency == currency)
        .take(3)
    {
        let http = &ctx.http;
        let id = earlier.payment_id.clone();
        let payment = match connection::call(&ctx, &conn, |mollie| {
            let id = id.clone();
            async move { mollie.payment(http, &id).await }
        })
        .await
        {
            Ok(payment) => payment,
            // Mollie has no such payment (another account's): make a new one.
            Err(PayError::Refused(_)) => continue,
            Err(error) => return Err(error),
        };
        match payment.status {
            PaymentStatus::Open => {
                if let Some(checkout) = payment.checkout_url {
                    return Ok(Outcome::Checkout(checkout));
                }
            }
            PaymentStatus::Paid | PaymentStatus::Pending | PaymentStatus::Authorized => {
                return Ok(Outcome::NothingToPay);
            }
            _ => {}
        }
    }

    let amount = Money::from_cents(&currency, cents);
    let number = text(invoice, "invoiceNumber").unwrap_or(invoice_id);
    let seller = seller_name(&opened.db, &entity).await?;
    let description = if seller.is_empty() {
        format!("Invoice {number}")
    } else {
        format!("Invoice {number} - {seller}")
    };
    let signed = payment_refs::sign(
        secret,
        &PayRef::webhook(&opened.token.ws, &entity, invoice_id),
    );
    let Some(webhook) = settings.webhook_url(&signed) else {
        return Ok(Outcome::Unavailable("Online payment is not set up"));
    };
    let methods = methods_of(&conn);
    let new = NewPayment {
        amount: &amount,
        description: &description,
        redirect_url: Some(return_url),
        cancel_url: None,
        webhook_url: &webhook,
        metadata: json!({ "ws": opened.token.ws, "entityId": entity, "invoiceId": invoice_id }),
        sequence: Sequence::OneOff,
        methods,
        locale: None,
    };
    // Concurrent requests for the same balance and attempt share Mollie's
    // idempotency key, so they make one payment.
    let attempt = started.len();
    let key = format!("books-{invoice_id}-{cents}-{attempt}");
    let http = &ctx.http;
    let payment = connection::call(&ctx, &conn, |mollie| {
        let new = &new;
        let key = &key;
        async move { mollie.create(http, new, key).await }
    })
    .await?;
    let Some(checkout) = payment.checkout_url.clone() else {
        return Err(PayError::Refused("Mollie gave no checkout".to_owned()));
    };
    append_history(
        &opened.db,
        invoice_id,
        entry(
            "payment_started",
            json!({
                "paymentId": payment.id,
                "amountCents": cents,
                "currency": currency,
                "status": payment.status.as_str(),
                "provider": "mollie",
            }),
        ),
        Vec::new(),
    )
    .await?;
    Ok(Outcome::Checkout(checkout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_balance_is_read_in_cents() {
        assert_eq!(balance_cents(&json!({ "balanceDue": "121.00" })), 12100);
        assert_eq!(balance_cents(&json!({ "balanceDue": "0.5" })), 50);
        assert_eq!(balance_cents(&json!({ "balanceDue": "-5.00" })), 0);
        assert_eq!(balance_cents(&json!({ "total": "10.00" })), 1000);
        assert_eq!(balance_cents(&json!({})), 0);
    }

    #[test]
    fn only_a_sent_invoice_with_a_balance_is_payable() {
        let invoice = |status: &str, kind: &str, balance: &str| json!({ "status": status, "type": kind, "balanceDue": balance });
        assert!(payable(&invoice("sent", "standard", "10.00")));
        assert!(payable(&invoice("overdue", "standard", "10.00")));
        assert!(payable(&invoice("partial", "standard", "4.00")));
        assert!(!payable(&invoice("draft", "standard", "10.00")));
        assert!(!payable(&invoice("paid", "standard", "0.00")));
        assert!(!payable(&invoice("sent", "standard", "0.00")));
        assert!(!payable(&invoice("sent", "credit_note", "10.00")));
        assert!(!payable(&invoice("cancelled", "standard", "10.00")));
    }

    #[test]
    fn the_history_gives_each_payment_its_latest_status() {
        let history = vec![
            json!({ "type": "link", "nonce": "n" }),
            json!({ "type": "payment_started", "paymentId": "tr_1", "amountCents": 100,
                    "currency": "EUR", "at": "2026-01-01T10:00:00.000Z", "status": "open" }),
            json!({ "type": "payment_status", "paymentId": "tr_1", "status": "expired" }),
            json!({ "type": "payment_started", "paymentId": "tr_2", "amountCents": 100,
                    "currency": "EUR", "at": "2026-01-01T11:00:00.000Z", "status": "open" }),
            json!({ "type": "payment_started", "paymentId": "tr_2", "amountCents": 100,
                    "currency": "EUR", "at": "2026-01-01T11:00:01.000Z", "status": "open" }),
            json!({ "type": "payment_status", "paymentId": "tr_2", "status": "pending" }),
        ];
        let started = started_payments(&history);
        assert_eq!(started.len(), 2);
        assert_eq!(started[0].status, "expired");
        assert_eq!(started[1].status, "pending");
        assert!(in_progress(&started[1], 0));
        assert!(!in_progress(&started[0], 0));
        let open = Started {
            status: "open".into(),
            at_ms: 1_000,
            ..started[1].clone()
        };
        assert!(in_progress(&open, 1_000 + OPEN_IN_PROGRESS_MS - 1));
        assert!(!in_progress(&open, 1_000 + OPEN_IN_PROGRESS_MS));
    }

    #[test]
    fn a_return_url_is_on_the_portal() {
        let settings = Settings {
            api_url: String::new(),
            public_url: None,
            app_url: None,
            portal_url: Some("https://pay.example.test".to_owned()),
            connect: None,
            secret: None,
        };
        assert!(return_url_ok(
            &settings,
            "https://pay.example.test/d/x/return"
        ));
        for bad in [
            "https://evil.test/d/x",
            "https://pay.example.test.evil.test/",
            "http://pay.example.test/d/x",
            "https://u@pay.example.test/",
            "/d/x",
            "nope",
        ] {
            assert!(!return_url_ok(&settings, bad), "{bad:?}");
        }
    }
}
