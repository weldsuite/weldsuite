//! Plan billing on the Kubernetes editions (ADR BILL-014): app-api's
//! `/api/billing/*` with the same paths and response shapes, on Mollie
//! instead of Stripe. Global keeps Stripe (`apps/workers/app-api/src/routes/billing`,
//! billing-worker); nothing here runs there.
//!
//! - **The master DB is the record.** Plan, seats, cycle, period and status
//!   stay on `workspaces`, so the seat check, limits and lock gate read them
//!   as before. `billing_accounts` holds the Mollie customer, the default
//!   mandate, the seat price the running period was bought at, the monthly
//!   anchor and what is scheduled for the period end. Everything is written
//!   only after Mollie confirms a payment the server read back.
//! - **WeldSuite charges the mandate itself** (no Mollie Subscriptions API):
//!   the hourly `weldsuite cron billing-renewals` ([`renewals`]) charges what
//!   is due on each anchor as a recurring payment.
//! - **Upgrades now, prorated; downgrades at the period end.** More seats or
//!   a dearer plan are charged on the mandate for the rest of the period and
//!   granted once Mollie takes the payment on. Fewer seats, a cheaper plan,
//!   another cycle and cancelling wait for the renewal. Nothing is refunded
//!   for part of a period.
//! - **Invoices are WeldBooks invoices** in WeldSuite's own workspace, issued
//!   through [`InvoiceIssuer`] once a payment is paid (never before, so an
//!   abandoned checkout leaves nothing to credit), mirrored into master
//!   `billing_invoices` with the printable document copied into the files
//!   bucket.
//! - **Past due:** a charge that fails sets `past_due`, emails the billing
//!   owners a pay link ([`paylink`]) and keeps the plan working for the grace
//!   period (`BILLING_GRACE_DAYS`, 14), after which it ends on Free.
//! - **One webhook** (`/api/webhooks/mollie`, shared with BILL-013's top-up):
//!   [`settle::settle_payment`] reads the payment back and applies it once.

mod access;
mod account;
mod buyer;
mod credits;
pub mod engine;
pub mod lines;
mod notify;
pub mod paylink;
pub mod period;
mod plans;
mod routes;
pub mod renewals;
mod seats;
pub mod settings;
pub mod settle;
mod store;
pub mod vat;
mod workspace;

use std::sync::Arc;

use axum::Router;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_mollie::Mollie;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{BoxFuture, DynFileStore, Identity, OutboundHttp};

pub use access::{BillingError, BillingResult, Caller};
pub use buyer::BillingDetails;
pub use lines::{Charge, Line, LineKind};
pub use notify::{BillingMail, BillingMailKind, BillingMailer};
pub use settings::{BillingSettings, WEBHOOK_PATH};
pub use settle::{Settled, settle_payment};
pub use vat::{Treatment, VatDecision};

/// The language a customer's invoices and emails are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    En,
    Nl,
}

impl Language {
    /// From `workspace_settings.language`: Dutch for `nl…`, else English.
    pub fn parse(text: Option<&str>) -> Self {
        match text {
            Some(text) if text.trim().to_ascii_lowercase().starts_with("nl") => Self::Nl,
            _ => Self::En,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Nl => "nl",
        }
    }
}

/// A paid charge to invoice.
#[derive(Debug, Clone)]
pub struct IssueRequest {
    /// The customer workspace (`workspaces.id`).
    pub workspace_id: String,
    pub customer: BillingDetails,
    pub charge: Charge,
    /// The Mollie payment that paid it (`tr_…`).
    pub payment_id: String,
    pub paid_at: OffsetDateTime,
    /// How it was paid, masked (`Visa •••• 4242`).
    pub method_label: Option<String>,
    pub language: Language,
}

/// An invoice the issuer made.
#[derive(Debug, Clone)]
pub struct IssuedInvoice {
    /// The invoice in the issuer's books.
    pub provider_invoice_id: String,
    pub number: String,
    /// The printable document and its media type, when the issuer renders
    /// one.
    pub document: Option<(Vec<u8>, &'static str)>,
}

/// Whoever issues the VAT invoices: WeldBooks in WeldSuite's own workspace
/// on the EU edition (the binary's `WeldBooksIssuer`). A failure is retried
/// by the renewal job; a paid payment is never left without its invoice.
pub trait InvoiceIssuer: Send + Sync {
    fn issue_paid<'a>(
        &'a self,
        request: &'a IssueRequest,
    ) -> BoxFuture<'a, Result<IssuedInvoice, String>>;
}

/// A workspace's tenant database, by `workspaces.id` or Clerk org id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

/// What the routes, the webhook and the renewal job share.
#[derive(Clone)]
pub struct BillingState {
    pub master: PgPool,
    pub settings: Arc<BillingSettings>,
    pub mollie: Mollie,
    /// The process's outbound client; a request's own (conformance) wins.
    pub http: Option<OutboundHttp>,
    /// The identity provider, for the seat cap and pending invitations.
    pub identity: Option<Arc<dyn Identity>>,
    /// Other workspaces' tenant databases: billing details for renewals.
    pub tenants: Option<TenantDatabases>,
    /// The private bucket: invoice documents.
    pub files: Option<Arc<dyn DynFileStore>>,
    pub issuer: Arc<dyn InvoiceIssuer>,
    pub mailer: Option<Arc<dyn BillingMailer>>,
    /// Monthly add-ons billed on each anchor (WeldReach inboxes).
    pub addons: Option<Arc<dyn AddonSource>>,
}

impl std::fmt::Debug for BillingState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BillingState")
            .field("settings", &self.settings)
            .field("identity", &self.identity.is_some())
            .field("files", &self.files.is_some())
            .field("mailer", &self.mailer.is_some())
            .finish_non_exhaustive()
    }
}

impl BillingState {
    /// Builds the state from the settings and the app's ports.
    #[allow(clippy::too_many_arguments)] // one per port
    pub fn new(
        master: PgPool,
        settings: BillingSettings,
        http: Option<OutboundHttp>,
        identity: Option<Arc<dyn Identity>>,
        tenants: Option<TenantDatabases>,
        files: Option<Arc<dyn DynFileStore>>,
        issuer: Arc<dyn InvoiceIssuer>,
        mailer: Option<Arc<dyn BillingMailer>>,
    ) -> Self {
        Self {
            mollie: Mollie::new(&settings.api_url, &settings.api_key),
            master,
            settings: Arc::new(settings),
            http,
            identity,
            tenants,
            files,
            issuer,
            mailer,
            addons: None,
        }
    }

    /// Bills `addons` on every anchor.
    #[must_use]
    pub fn with_addons(mut self, addons: Arc<dyn AddonSource>) -> Self {
        self.addons = Some(addons);
        self
    }
}

/// Monthly add-ons on the plan's charge (ADR BILL-014, phase 5): the lines
/// a workspace owes for the month `period` on its anchor.
pub trait AddonSource: Send + Sync {
    fn lines<'a>(
        &'a self,
        workspace_id: &'a str,
        period: (OffsetDateTime, OffsetDateTime),
        language: Language,
    ) -> BoxFuture<'a, Result<Vec<Line>, String>>;
}

/// `/api/billing`: behind the session, the tenant database and the
/// permission gate.
pub fn router<S, Q>(state: BillingState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    routes::router(gate).with_state(state)
}

/// The pay links (`/public/billing/pay/:token`), ahead of the session.
pub fn public_router<S>(state: BillingState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    routes::public_router().with_state(state)
}
