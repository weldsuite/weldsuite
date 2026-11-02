//! `lib/billing.ts`: the inbox subscription ($5 per inbox per month) is
//! Global's billing-worker (`/api/billing/reach/*`, Stripe), called with the
//! member's token.
//!
//! Billing is off where the worker cannot forward the caller's token to
//! billing-worker (`reachBillingEnabled(env)`: an `ENVIRONMENT` other than
//! test, preview or production), and always on the Kubernetes editions, which
//! have no billing-worker and no Stripe (the `billing` feature is off). Then
//! mailboxes are provisioned unbilled, as WeldBooks' bank connections are:
//! the status is null, an inbox change is a no-op, and a payment-method setup
//! is refused (409 `BILLING_OFF`). Under conformance the test's
//! `ENVIRONMENT` decides, and where billing is on the calls go to the test's
//! `fetch`, at the URL the worker derives from it, so both backends are
//! compared on the same answers; a production request never leaves the
//! cluster for Global.

use serde_json::{Value, json};
use weldsuite_ports::HttpRequest;
use weldsuite_reach_domain::ReachError;

use crate::{Caller, ReachState};

const BASE: &str = "/api/billing/reach";

/// Why a billing call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BillingError {
    /// `PaymentMethodRequiredError`.
    PaymentMethodRequired,
    /// `ReachBillingError(status, code, message)`.
    Failed {
        status: u16,
        code: Option<String>,
        message: String,
    },
}

impl BillingError {
    /// `mapReachError`.
    pub(crate) fn into_reach(self) -> ReachError {
        match self {
            Self::PaymentMethodRequired => ReachError::new(
                402,
                "PAYMENT_METHOD_REQUIRED",
                "A payment method is required before adding inboxes",
            ),
            Self::Failed {
                status,
                code,
                message,
            } => {
                tracing::error!(status, ?code, %message, "[reach] UPSTREAM_ERROR: billing");
                ReachError::new(
                    502,
                    "UPSTREAM_ERROR",
                    "Billing service error. Try again in a moment.",
                )
            }
        }
    }
}

/// `billingWorkerUrl(env)`.
fn billing_worker_url(environment: Option<&str>) -> &'static str {
    match environment {
        Some("production" | "preview") => "https://billing-worker.weldsuite.org",
        Some("test") => "https://billing-worker-test.weldsuite.org",
        _ => "http://localhost:8788",
    }
}

/// `reachBillingEnabled(env)`: only under conformance, with an HTTPS
/// billing-worker URL.
fn enabled(caller: &Caller) -> bool {
    caller.conformance()
        && billing_worker_url(caller.env("ENVIRONMENT").as_deref()).starts_with("https:")
}

/// `billingOffError()`.
fn billing_off() -> ReachError {
    ReachError::new(
        409,
        "BILLING_OFF",
        "Billing is off in this environment: mailboxes are not charged, so there is no payment method to add.",
    )
}

async fn send(
    caller: &Caller,
    state: &ReachState,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, BillingError> {
    let base = billing_worker_url(caller.env("ENVIRONMENT").as_deref());
    let mut headers = vec![("Content-Type".to_owned(), "application/json".to_owned())];
    if base.starts_with("https:")
        && let Some(authorization) = &caller.authorization
    {
        headers.push(("Authorization".to_owned(), authorization.clone()));
    }
    let request = HttpRequest {
        method: method.to_owned(),
        url: format!("{base}{BASE}{path}"),
        headers,
        body: body.map(|b| b.to_string().into_bytes()),
    };
    let response =
        caller
            .http(state)
            .send(request)
            .await
            .map_err(|error| BillingError::Failed {
                status: 502,
                code: None,
                message: format!("billing-worker unreachable: {error}"),
            })?;
    let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
    let error_code = parsed
        .as_ref()
        .and_then(|b| b.pointer("/error/code"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if response.status == 402 && error_code.as_deref() == Some("PAYMENT_METHOD_REQUIRED") {
        return Err(BillingError::PaymentMethodRequired);
    }
    if !(200..300).contains(&response.status) {
        let message = parsed
            .as_ref()
            .and_then(|b| b.pointer("/error/message"))
            .and_then(Value::as_str)
            .map_or_else(
                || format!("billing-worker answered {}", response.status),
                str::to_owned,
            );
        return Err(BillingError::Failed {
            status: response.status,
            code: error_code,
            message,
        });
    }
    match parsed.and_then(|b| b.get("data").cloned()) {
        Some(data) => Ok(data),
        None => Err(BillingError::Failed {
            status: 502,
            code: None,
            message: "billing-worker returned no data".to_owned(),
        }),
    }
}

/// `GET /status`; null when billing is off.
pub(crate) async fn status(caller: &Caller, state: &ReachState) -> Result<Value, ReachError> {
    if !enabled(caller) {
        return Ok(Value::Null);
    }
    send(caller, state, "GET", "/status", None)
        .await
        .map_err(BillingError::into_reach)
}

/// `POST /setup`; refused when billing is off.
pub(crate) async fn setup(
    caller: &Caller,
    state: &ReachState,
    input: &Value,
) -> Result<Value, ReachError> {
    if !enabled(caller) {
        return Err(billing_off());
    }
    send(caller, state, "POST", "/setup", Some(input))
        .await
        .map_err(BillingError::into_reach)
}

/// `POST /inboxes { delta, mailboxId }`; a no-op answering null when
/// billing is off.
pub(crate) async fn adjust_inboxes(
    caller: &Caller,
    state: &ReachState,
    delta: i64,
    mailbox_id: &str,
) -> Result<Value, BillingError> {
    if !enabled(caller) {
        return Ok(Value::Null);
    }
    send(
        caller,
        state,
        "POST",
        "/inboxes",
        Some(&json!({ "delta": delta, "mailboxId": mailbox_id })),
    )
    .await
}

/// `releaseInbox(billing, mailboxId)`: three tries, never fails.
pub(crate) async fn release_inbox(caller: &Caller, state: &ReachState, mailbox_id: &str) -> bool {
    for attempt in 0..3 {
        match adjust_inboxes(caller, state, -1, mailbox_id).await {
            Ok(_) => return true,
            Err(error) if attempt == 2 => {
                tracing::error!(
                    ?error,
                    mailbox_id,
                    "[reach-billing] could not release inbox after 3 attempts"
                );
            }
            Err(_) => {}
        }
    }
    false
}
