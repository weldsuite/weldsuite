//! The payment provider port (ADR COM-013) and its Mollie adapter. Stripe
//! and "pay on invoice" are the other adapters the ADR names; only Mollie
//! exists.

use serde_json::Value;
use weldsuite_mollie::{
    Mollie, MollieError, Money, NewPayment, Payment, PaymentStatus, Refund, Sequence,
};
use weldsuite_ports::{BoxFuture, OutboundHttp};

/// Why a provider call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// The credentials were not accepted (an expired token).
    Unauthorized,
    /// The provider refused the request: its message.
    Refused(String),
    /// The provider could not be reached or answered nonsense.
    Unavailable(String),
}

impl ProviderError {
    /// The text for the API's `PROVIDER_ERROR`.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Unauthorized => "The payment provider did not accept the connection".to_owned(),
            Self::Refused(message) | Self::Unavailable(message) => message.clone(),
        }
    }
}

impl From<MollieError> for ProviderError {
    fn from(error: MollieError) -> Self {
        if error.is_unauthorized() {
            return Self::Unauthorized;
        }
        match error {
            MollieError::Refused { detail, .. } => Self::Refused(detail),
            other => Self::Unavailable(other.to_string()),
        }
    }
}

/// A payment to create.
#[derive(Debug, Clone)]
pub struct PaymentRequest<'a> {
    pub amount_cents: i64,
    pub currency: &'a str,
    pub description: &'a str,
    pub redirect_url: &'a str,
    pub webhook_url: &'a str,
    pub metadata: Value,
    /// Makes a retried request create the payment once.
    pub idempotency_key: &'a str,
    pub locale: Option<String>,
}

/// A payment as the provider reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderPayment {
    pub id: String,
    /// `open`, `pending`, `authorized`, `paid`, `failed`, `canceled`,
    /// `expired`; anything else the provider invents is kept as written.
    pub status: String,
    pub method: Option<String>,
    pub checkout_url: Option<String>,
    pub paid_at: Option<String>,
    pub expires_at: Option<String>,
    pub failure_reason: Option<String>,
    pub amount_cents: Option<i64>,
    pub currency: Option<String>,
    /// The payment as the provider wrote it.
    pub raw: Value,
}

/// A refund as the provider reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRefund {
    pub id: String,
    /// `queued`, `pending`, `processing`, `refunded`, `failed`, `canceled`.
    pub status: String,
    pub amount_cents: i64,
}

/// What an order's payments need from a payment provider.
pub trait PaymentProvider: Send + Sync {
    fn create_payment<'a>(
        &'a self,
        request: &'a PaymentRequest<'a>,
    ) -> BoxFuture<'a, Result<ProviderPayment, ProviderError>>;

    fn read_payment<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFuture<'a, Result<ProviderPayment, ProviderError>>;

    fn create_refund<'a>(
        &'a self,
        payment_id: &'a str,
        amount_cents: i64,
        currency: &'a str,
        description: &'a str,
        idempotency_key: &'a str,
    ) -> BoxFuture<'a, Result<ProviderRefund, ProviderError>>;

    fn read_refunds<'a>(
        &'a self,
        payment_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<ProviderRefund>, ProviderError>>;
}

/// Mollie, on one connection's credentials.
pub struct MollieProvider<'a> {
    pub mollie: Mollie,
    pub http: &'a OutboundHttp,
}

fn status_text(status: &PaymentStatus) -> String {
    status.as_str().to_owned()
}

fn payment_of(payment: &Payment) -> ProviderPayment {
    ProviderPayment {
        id: payment.id.clone(),
        status: status_text(&payment.status),
        method: payment.details.method.clone(),
        checkout_url: payment.checkout_url.clone(),
        paid_at: payment.paid_at.clone(),
        expires_at: payment.expires_at.clone(),
        failure_reason: payment.failure_reason.clone(),
        amount_cents: payment.amount.as_ref().map(|m| m.cents),
        currency: payment.amount.as_ref().map(|m| m.currency.clone()),
        raw: payment.raw.clone(),
    }
}

fn refund_of(refund: &Refund) -> ProviderRefund {
    ProviderRefund {
        id: refund.id.clone(),
        status: refund.status.clone(),
        amount_cents: refund.amount.as_ref().map_or(0, |m| m.cents),
    }
}

impl PaymentProvider for MollieProvider<'_> {
    fn create_payment<'a>(
        &'a self,
        request: &'a PaymentRequest<'a>,
    ) -> BoxFuture<'a, Result<ProviderPayment, ProviderError>> {
        Box::pin(async move {
            let amount = Money::from_cents(request.currency, request.amount_cents);
            let new = NewPayment {
                amount: &amount,
                description: request.description,
                redirect_url: Some(request.redirect_url),
                cancel_url: None,
                webhook_url: request.webhook_url,
                metadata: request.metadata.clone(),
                sequence: Sequence::OneOff,
                methods: Vec::new(),
                locale: request.locale.clone(),
            };
            let payment = self
                .mollie
                .create(self.http, &new, request.idempotency_key)
                .await?;
            Ok(payment_of(&payment))
        })
    }

    fn read_payment<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFuture<'a, Result<ProviderPayment, ProviderError>> {
        Box::pin(async move {
            let payment = self.mollie.payment(self.http, id).await?;
            Ok(payment_of(&payment))
        })
    }

    fn create_refund<'a>(
        &'a self,
        payment_id: &'a str,
        amount_cents: i64,
        currency: &'a str,
        description: &'a str,
        idempotency_key: &'a str,
    ) -> BoxFuture<'a, Result<ProviderRefund, ProviderError>> {
        Box::pin(async move {
            let amount = Money::from_cents(currency, amount_cents);
            let refund = self
                .mollie
                .refund(self.http, payment_id, &amount, description, idempotency_key)
                .await?;
            Ok(refund_of(&refund))
        })
    }

    fn read_refunds<'a>(
        &'a self,
        payment_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<ProviderRefund>, ProviderError>> {
        Box::pin(async move {
            let refunds = self.mollie.refunds(self.http, payment_id).await?;
            Ok(refunds.iter().map(refund_of).collect())
        })
    }
}
