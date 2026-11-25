//! Plan billing's handle on the app (ADR BILL-014): the state of
//! `weldsuite-core-billing` from the environment, the one Mollie webhook it
//! shares with BILL-013's credit top-up, the WeldBooks invoice issuer, and
//! the billing owners' emails over system mail.
//!
//! On when `BILLING_PROVIDER=mollie` (`BillingSettings`); a deployment that
//! sets it but lacks a setting doesn't start (`crate::edition`). Never in
//! conformance builds, whose billing tests are Global's (Stripe).

use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, NullOrdering, Order};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_core_billing::{
    AddonSource, BillingError, BillingMail, BillingMailKind, BillingMailer, BillingSettings,
    BillingState, InvoiceIssuer, InvoiceMail, IssueRequest, IssuedInvoice, Language, Line,
    LineKind, TopUpRequest, Treatment, WEBHOOK_PATH,
};
use weldsuite_core_platform::{TopUpBilling, TopUpPrice, TopUpQuote};
use weldsuite_db::{Keyring, OrmConn, PgPool, Workspaces, orm, orm_error};
use weldsuite_emails::billing::{Dunning, DunningKind, Invoice, InvoiceVat, dunning, invoice};
use weldsuite_emails::{EmailBrand, EmailLocale, RenderedEmail, SystemEmail, send_system_email};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_ports::{BoxFuture, DynSystemMail, OutboundHttp};
use weldsuite_reach::weldsuite_reach_domain::ReachError;
use weldsuite_schema::tenant::{
    companies, entities, invoices, parties, recurring_invoices, tax_rates,
};

use crate::server::AppState;

/// Plan billing, made once per process; `None` when it is off.
pub(crate) fn billing_state(state: &AppState) -> Option<BillingState> {
    static BILLING: OnceLock<Option<BillingState>> = OnceLock::new();
    if cfg!(feature = "conformance") {
        return None;
    }
    BILLING
        .get_or_init(|| {
            let settings = match BillingSettings::from_lookup(&|name| std::env::var(name).ok()) {
                Ok(Some(settings)) => settings,
                Ok(None) => return None,
                Err(problem) => {
                    // `serve` refuses to start on it (`crate::edition`).
                    tracing::error!(problem, "billing: plan billing is off");
                    return None;
                }
            };
            Some(build(
                state.workspaces.master().clone(),
                Arc::clone(&state.workspaces),
                settings,
                state.infra.identity.clone(),
                state.infra.files.clone(),
                state.infra.mail.clone(),
            ))
        })
        .clone()
}

/// The state from its parts (`serve` and `weldsuite cron billing-renewals`).
pub(crate) fn build(
    master: PgPool,
    workspaces: Arc<Workspaces>,
    settings: BillingSettings,
    identity: Option<Arc<dyn weldsuite_ports::Identity>>,
    files: Option<Arc<dyn weldsuite_ports::DynFileStore>>,
    mail: Option<Arc<dyn DynSystemMail>>,
) -> BillingState {
    let http = crate::routes::shared_outbound();
    let issuer = Arc::new(WeldBooksIssuer {
        workspaces: Arc::clone(&workspaces),
        workspace_id: settings.issuer_workspace_id.clone(),
        entity_id: settings.issuer_entity_id.clone(),
        keyring: keyring(),
        http: http.clone(),
    });
    let inboxes = Arc::new(ReachInboxes {
        workspaces: Arc::clone(&workspaces),
    });
    let tenants: weldsuite_core_billing::TenantDatabases = Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map(|tenant| tenant.db)
                .map_err(|error| error.to_string())
        })
    });
    let mailer = mail.map(|mail| Arc::new(SystemMailer { mail }) as Arc<dyn BillingMailer>);
    BillingState::new(
        master,
        settings,
        http,
        identity,
        Some(tenants),
        files,
        issuer,
        mailer,
    )
    .with_addons(inboxes)
}

fn keyring() -> Keyring {
    let read = |name: &str| std::env::var(name).ok().filter(|key| !key.is_empty());
    Keyring {
        v1: read("DATABASE_ENCRYPTION_KEY"),
        v2: read("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

// ── the webhook ─────────────────────────────────────────────────────────────

/// `POST /api/webhooks/mollie` for every Mollie payment: plan billing's
/// (`kind: billing`) and the credit top-up's (`kind: credit_topup`).
pub(crate) fn webhook(state: &AppState, billing: BillingState) -> Router<AppState> {
    let hook = Hook {
        billing,
        top_up: crate::routes::credit_top_up_configured(state),
    };
    Router::new().route(WEBHOOK_PATH, post(mollie_webhook).with_state(hook))
}

#[derive(Clone)]
struct Hook {
    billing: BillingState,
    top_up: bool,
}

/// Mollie posts `id=tr_…`; the payment is read back, never taken from the
/// body. 200 for anything settled or not ours (an unknown id included, as
/// Mollie asks); 5xx when Mollie or the database can't be reached, so Mollie
/// tries again.
async fn mollie_webhook(State(hook): State<Hook>, body: Bytes) -> Response {
    let id = url::form_urlencoded::parse(&body)
        .find(|(name, _)| name == "id")
        .map(|(_, value)| value.into_owned());
    let Some(id) = id.filter(|id| weldsuite_mollie::is_payment_id(id)) else {
        tracing::warn!("mollie: webhook without a payment id, ignored");
        return StatusCode::OK.into_response();
    };
    let Some(http) = hook.billing.http.clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let payment = match hook.billing.mollie.payment(&http, &id).await {
        Ok(payment) => payment,
        Err(error) if error.is_not_found() => {
            tracing::warn!(%error, payment = %id, "mollie: webhook for an unknown payment");
            return StatusCode::OK.into_response();
        }
        Err(error) => {
            tracing::warn!(%error, payment = %id, "mollie: payment unreadable, Mollie retries");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    let kind = payment
        .metadata
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = if kind == "credit_topup" && hook.top_up {
        // The wallet first (the credits), then the charge plan billing priced
        // it with (the invoice); a top-up from before plan billing has none.
        match weldsuite_core_platform::topup::settle(&hook.billing.master, &payment).await {
            Ok(granted) => weldsuite_core_billing::settle_payment(
                &hook.billing,
                &payment,
                OffsetDateTime::now_utc(),
            )
            .await
            .map(|charged| format!("{granted:?}; {charged:?}"))
            .map_err(|error| format!("{error:?}")),
            Err(error) => Err(error.to_string()),
        }
    } else {
        weldsuite_core_billing::settle_payment(&hook.billing, &payment, OffsetDateTime::now_utc())
            .await
            .map(|settled| format!("{settled:?}"))
            .map_err(|error| format!("{error:?}"))
    };
    match result {
        Ok(settled) => {
            tracing::info!(payment = %id, kind, settled, "mollie: webhook");
            StatusCode::OK.into_response()
        }
        Err(error) => {
            tracing::error!(error, payment = %id, "mollie: not settled, Mollie retries");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

// ── credit top-ups ──────────────────────────────────────────────────────────

/// Plan billing's part in BILL-013's credit top-up: the package's price is
/// before VAT, so the payment is priced with the VAT on top against a charge,
/// and a paid top-up is invoiced from that charge.
pub(crate) fn top_up_billing(billing: BillingState) -> Arc<dyn TopUpBilling> {
    Arc::new(TopUpInvoicing { billing })
}

struct TopUpInvoicing {
    billing: BillingState,
}

impl TopUpBilling for TopUpInvoicing {
    fn quote<'a>(&'a self, request: TopUpQuote<'a>) -> BoxFuture<'a, Result<TopUpPrice, ApiError>> {
        Box::pin(async move {
            let quoted = weldsuite_core_billing::quote_top_up(
                &self.billing,
                &TopUpRequest {
                    checkout_id: request.checkout_id,
                    workspace_id: request.workspace_id,
                    user_id: request.user_id,
                    package_id: request.package_id,
                    package_name: request.package_name,
                    credits: request.credits,
                    net: request.net.cents,
                    currency: &request.net.currency,
                },
            )
            .await
            .map_err(api_error)?;
            Ok(TopUpPrice {
                gross: weldsuite_mollie::Money::from_cents(&request.net.currency, quoted.gross),
                charge_id: quoted.charge_id,
            })
        })
    }

    fn settle<'a>(
        &'a self,
        payment: &'a weldsuite_mollie::Payment,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            weldsuite_core_billing::settle_payment(
                &self.billing,
                payment,
                OffsetDateTime::now_utc(),
            )
            .await
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
        })
    }
}

/// A billing refusal as the top-up route answers it.
fn api_error(error: BillingError) -> ApiError {
    match error {
        BillingError::Api(error) => error,
        BillingError::Internal(message, cause) => {
            tracing::error!(cause, "billing: {message}");
            ApiError::internal().with_message(message)
        }
        BillingError::Database(error) => {
            tracing::error!(%error, "billing: database error pricing a top-up");
            ApiError::internal()
        }
        BillingError::Response(_) => ApiError::internal(),
    }
}

// ── WeldReach inboxes ───────────────────────────────────────────────────────

/// The renewal job's monthly add-on: every live WeldReach inbox of the
/// workspace (its tenant database), billed for the coming month.
struct ReachInboxes {
    workspaces: Arc<Workspaces>,
}

impl AddonSource for ReachInboxes {
    fn lines<'a>(
        &'a self,
        workspace_id: &'a str,
        period: (OffsetDateTime, OffsetDateTime),
        language: Language,
    ) -> BoxFuture<'a, Result<Vec<Line>, String>> {
        Box::pin(async move {
            let tenant = self
                .workspaces
                .tenant(workspace_id)
                .await
                .map_err(|error| error.to_string())?;
            let count = weldsuite_reach::live_inbox_count(&tenant.db)
                .await
                .map_err(|error| error.to_string())?;
            Ok(if count > 0 {
                vec![weldsuite_core_billing::inbox_line(count, period, language)]
            } else {
                Vec::new()
            })
        })
    }
}

/// WeldReach's inbox billing on the plan's Mollie charge: the reach module's
/// status, payment-method setup and inbox charges, over core-billing.
pub(crate) fn reach_inbox_billing(
    billing: BillingState,
    workspaces: Arc<Workspaces>,
) -> Arc<dyn weldsuite_reach::InboxBilling> {
    Arc::new(ReachInboxBilling {
        billing,
        workspaces,
    })
}

struct ReachInboxBilling {
    billing: BillingState,
    workspaces: Arc<Workspaces>,
}

impl weldsuite_reach::InboxBilling for ReachInboxBilling {
    fn status<'a>(
        &'a self,
        workspace_id: &'a str,
        inboxes: i64,
    ) -> BoxFuture<'a, Result<Value, ReachError>> {
        Box::pin(async move {
            let summary = weldsuite_core_billing::inbox_billing(
                &self.billing,
                workspace_id,
                OffsetDateTime::now_utc(),
            )
            .await
            .map_err(reach_error)?;
            // `ReachBillingSummary`, as billing-worker answers it on Global.
            Ok(json!({
                "status": summary.status,
                "hasPaymentMethod": summary.has_payment_method,
                "inboxCount": inboxes,
                "unitAmountCents": weldsuite_core_billing::addons::WELDREACH_INBOX_CENTS,
                "currency": "eur",
                "currentPeriodEnd": summary.period_end,
            }))
        })
    }

    fn setup<'a>(
        &'a self,
        workspace_id: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, Result<Value, ReachError>> {
        Box::pin(async move {
            let tenant = self
                .workspaces
                .tenant(workspace_id)
                .await
                .ok()
                .map(|t| t.db);
            let actor = weldsuite_core_billing::engine::Actor {
                workspace_id: workspace_id.to_owned(),
                user_id: Some(user_id.to_owned()),
                tenant,
            };
            let url = weldsuite_core_billing::engine::mandate_checkout(
                &self.billing,
                &self.billing.master,
                None,
                &actor,
            )
            .await
            .map_err(reach_error)?;
            Ok(json!({ "url": url }))
        })
    }

    fn add<'a>(
        &'a self,
        workspace_id: &'a str,
        user_id: &'a str,
        mailbox_id: &'a str,
        inboxes_after: i64,
    ) -> BoxFuture<'a, Result<(), ReachError>> {
        Box::pin(async move {
            weldsuite_core_billing::charge_inbox_added(
                &self.billing,
                workspace_id,
                Some(user_id),
                mailbox_id,
                inboxes_after,
                OffsetDateTime::now_utc(),
            )
            .await
            .map(|_| ())
            .map_err(reach_error)
        })
    }
}

/// A billing refusal as the reach routes answer it.
fn reach_error(error: BillingError) -> ReachError {
    match error {
        BillingError::Api(error) => {
            let reach = ReachError::new(error.status().as_u16(), error.code(), error.message());
            match error.details() {
                Some(details) => reach.with_details(details.clone()),
                None => reach,
            }
        }
        BillingError::Internal(message, cause) => {
            tracing::error!(cause, "billing: {message}");
            ReachError::new(500, "INTERNAL_ERROR", message)
        }
        BillingError::Database(error) => {
            tracing::error!(%error, "billing: database error billing an inbox");
            ReachError::new(500, "INTERNAL_ERROR", "Internal server error")
        }
        BillingError::Response(_) => {
            ReachError::new(500, "INTERNAL_ERROR", "Internal server error")
        }
    }
}

// ── the billing owners' emails ──────────────────────────────────────────────

struct SystemMailer {
    mail: Arc<dyn DynSystemMail>,
}

impl BillingMailer for SystemMailer {
    fn send<'a>(&'a self, message: &'a BillingMail) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let locale = email_locale(message.language);
            let props = Dunning {
                kind: match message.kind {
                    BillingMailKind::PaymentFailed => DunningKind::Failed,
                    BillingMailKind::PaymentReminder => DunningKind::Reminder,
                    BillingMailKind::PlanEnded => DunningKind::Ended,
                    BillingMailKind::PaymentMethodNeeded => DunningKind::Upcoming,
                },
                workspace_name: message.workspace_name.clone(),
                plan_name: message.plan_name.clone(),
                amount: message.amount.clone().unwrap_or_default(),
                ends_on: message.ends_on.clone().unwrap_or_default(),
                url: message
                    .pay_url
                    .clone()
                    .unwrap_or_else(|| message.billing_url.clone()),
                no_method: message.no_method,
            };
            let brand = EmailBrand::weldsuite("WeldSuite");
            let rendered = dunning(locale, &brand, &props).map_err(|error| error.to_string())?;
            let failures = self.each(&message.recipients, &rendered, &brand).await;
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        })
    }

    /// Links to Settings › Billing and attaches nothing: the printable
    /// invoice is HTML (no PDF renderer on the EU edition), which mail
    /// filters treat as a phishing attachment, and the document route is for
    /// signed-in members with `billing:read`.
    fn send_invoice<'a>(&'a self, message: &'a InvoiceMail) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let props = Invoice {
                workspace_name: message.workspace_name.clone(),
                number: message.number.clone(),
                date: message.date.clone(),
                amount: message.amount.clone(),
                vat: match message.treatment {
                    Treatment::Domestic | Treatment::Oss => InvoiceVat::Charged,
                    Treatment::ReverseCharge => InvoiceVat::Reverse,
                    Treatment::OutsideEu => InvoiceVat::Outside,
                },
                vat_amount: message.tax.clone(),
                vat_rate: message.rate.clone(),
                url: message.billing_url.clone(),
            };
            let brand = EmailBrand::weldsuite("WeldSuite");
            let rendered = invoice(email_locale(message.language), &brand, &props)
                .map_err(|error| error.to_string())?;
            let failures = self.each(&message.recipients, &rendered, &brand).await;
            if failures.len() < message.recipients.len() {
                if !failures.is_empty() {
                    tracing::warn!(
                        failures = failures.join("; "),
                        workspace = %message.workspace_id,
                        number = %message.number,
                        "billing: invoice email refused for some billing owners"
                    );
                }
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        })
    }
}

impl SystemMailer {
    /// Sends `rendered` to each recipient on its own; the refusals.
    async fn each(
        &self,
        recipients: &[String],
        rendered: &RenderedEmail,
        brand: &EmailBrand,
    ) -> Vec<String> {
        let mut failures = Vec::new();
        for recipient in recipients {
            let email = SystemEmail::to(rendered.clone(), brand.clone(), recipient);
            if let Err(error) = send_system_email(self.mail.as_ref(), email).await {
                failures.push(error.to_string());
            }
        }
        failures
    }
}

fn email_locale(language: Language) -> EmailLocale {
    match language {
        Language::Nl => EmailLocale::Nl,
        Language::En => EmailLocale::En,
    }
}

// ── the WeldBooks issuer ────────────────────────────────────────────────────

/// Issues plan invoices as WeldBooks invoices in WeldSuite's own workspace
/// (`BILLING_ISSUER_WORKSPACE_ID`, entity `BILLING_ISSUER_ENTITY_ID` or its
/// first), as the system user (ADR BILL-014, decision 5):
///
/// 1. The customer is a company contact keyed by `WS-<workspace id>`
///    (`parties.party_code`), its name, address and VAT number kept current.
/// 2. The invoice is generated from a per-customer recurring template
///    (paused between charges) through `generate_recurring_invoice_as_system`,
///    WeldBooks' own path for system invoices: numbering, tax, posting and
///    the reverse-charge notice. Its reference is the Mollie payment id, so a
///    retry finds the invoice instead of making a second.
/// 3. The payment is recorded against it (deposited to undeposited funds,
///    Mollie's clearing), keyed on the Mollie payment.
/// 4. The printable invoice is rendered for the customer's copy.
///
/// WeldBooks never sends it (`auto_send` off): plan billing emails the
/// billing owners from `notifications@` once it is mirrored
/// (`SystemMailer::send_invoice`).
struct WeldBooksIssuer {
    workspaces: Arc<Workspaces>,
    workspace_id: String,
    entity_id: Option<String>,
    keyring: Keyring,
    http: Option<OutboundHttp>,
}

impl InvoiceIssuer for WeldBooksIssuer {
    fn issue_paid<'a>(
        &'a self,
        request: &'a IssueRequest,
    ) -> BoxFuture<'a, Result<IssuedInvoice, String>> {
        Box::pin(async move { self.issue(request).await })
    }
}

fn decimal(cents: i64) -> f64 {
    #[allow(clippy::cast_precision_loss)] // cents of a plan invoice
    let value = cents as f64 / 100.0;
    value
}

impl WeldBooksIssuer {
    async fn entity(&self, db: &PgPool) -> Result<(String, String), String> {
        let query = entities::Entity::find()
            .select_only()
            .columns([entities::Column::Id, entities::Column::JurisdictionCode])
            .filter(entities::Column::DeletedAt.is_null());
        let query = match &self.entity_id {
            Some(id) => query.filter(entities::Column::Id.eq(id)),
            None => query.order_by_asc(entities::Column::CreatedAt),
        };
        let row: Option<(String, Option<String>)> = query
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(|error| error.to_string())?;
        row.map(|(id, code)| (id, code.unwrap_or_else(|| "NL".to_owned())))
            .ok_or_else(|| "the issuer workspace has no accounting entity".to_owned())
    }

    /// The customer contact, created or updated.
    async fn contact(&self, db: &PgPool, request: &IssueRequest) -> Result<String, DbErr> {
        let customer = &request.customer;
        let code = format!("WS-{}", request.workspace_id);
        let address = json!({
            "line1": customer.address_line1,
            "line2": customer.address_line2,
            "city": customer.city,
            "state": customer.state,
            "postalCode": customer.postal_code,
            "country": customer.country,
        });
        let existing: Option<(String, Option<String>)> = parties::Entity::find()
            .select_only()
            .columns([parties::Column::Id, parties::Column::CompanyId])
            .filter(parties::Column::PartyCode.eq(&code))
            .filter(parties::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        if let Some((party_id, company_id)) = existing {
            parties::Entity::update_many()
                .col_expr(parties::Column::DisplayName, Expr::value(&customer.name))
                .col_expr(parties::Column::BillingAddress, Expr::value(address))
                .col_expr(parties::Column::UpdatedAt, Expr::current_timestamp())
                .filter(parties::Column::Id.eq(&party_id))
                .exec(&orm(db))
                .await?;
            if let Some(company_id) = company_id {
                // `email = coalesce($4, email)`: an email only when one is known.
                let email = Func::coalesce([
                    Expr::val(customer.email.clone()),
                    Expr::col(companies::Column::Email),
                ]);
                companies::Entity::update_many()
                    .col_expr(companies::Column::Name, Expr::value(&customer.name))
                    .col_expr(companies::Column::DisplayName, Expr::value(&customer.name))
                    .col_expr(
                        companies::Column::VatNumber,
                        Expr::value(customer.vat_number.clone()),
                    )
                    .col_expr(companies::Column::Email, email.into())
                    .col_expr(companies::Column::UpdatedAt, Expr::current_timestamp())
                    .filter(companies::Column::Id.eq(company_id))
                    .exec(&orm(db))
                    .await?;
            }
            return Ok(party_id);
        }
        let company_id = generate_id("comp");
        let party_id = generate_id("pty");
        let mut tx = db.begin().await.map_err(orm_error)?;
        {
            let tx = OrmConn::new(&mut tx);
            companies::Entity::insert(companies::ActiveModel {
                id: Set(company_id.clone()),
                name: Set(customer.name.clone()),
                display_name: Set(customer.name.clone()),
                vat_number: Set(customer.vat_number.clone()),
                email: Set(customer.email.clone()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
            parties::Entity::insert(parties::ActiveModel {
                id: Set(party_id.clone()),
                party_code: Set(Some(code)),
                kind: Set(Some("company".to_owned())),
                company_id: Set(Some(company_id)),
                display_name: Set(Some(customer.name.clone())),
                billing_address: Set(Some(address)),
                currency: Set(Some("EUR".to_owned())),
                status: Set("active".to_owned()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
        }
        tx.commit().await.map_err(orm_error)?;
        Ok(party_id)
    }

    /// The entity's tax rate for the charge's VAT treatment, created when
    /// the entity has none (an OSS country rate, typically).
    async fn tax_rate(
        &self,
        db: &PgPool,
        entity_id: &str,
        jurisdiction: &str,
        request: &IssueRequest,
    ) -> Result<String, DbErr> {
        let vat = &request.charge.vat;
        let (category, name, metadata) = match vat.treatment {
            Treatment::Domestic => (
                "standard",
                format!("BTW Hoog {}%", rate_label(vat.rate_bps)),
                json!({ "btwRubriek": "1a" }),
            ),
            Treatment::ReverseCharge => (
                "eu_b2b_service",
                "BTW Intracommunautair diensten".to_owned(),
                json!({ "btwRubriek": "3b" }),
            ),
            Treatment::OutsideEu => (
                "export_goods",
                "BTW Export buiten EU".to_owned(),
                Value::Null,
            ),
            Treatment::Oss => (
                "eu_b2c_distance",
                format!("OSS {} {}%", vat.country, rate_label(vat.rate_bps)),
                json!({ "ossCountry": vat.country }),
            ),
        };
        let rate = format!("{}.{:02}", vat.rate_bps / 100, vat.rate_bps % 100);
        let rate: BigDecimal = rate
            .parse()
            .map_err(|_| DbErr::Type(format!("tax rate {rate}")))?;
        let mut query = tax_rates::Entity::find()
            .select_only()
            .column(tax_rates::Column::Id)
            .filter(tax_rates::Column::EntityId.eq(entity_id))
            .filter(tax_rates::Column::DeletedAt.is_null())
            .filter(Expr::from(Func::coalesce([
                Expr::col(tax_rates::Column::IsActive),
                Expr::val(true),
            ])))
            .filter(tax_rates::Column::TaxCategoryCode.eq(category))
            .filter(tax_rates::Column::Rate.eq(rate.clone()));
        if vat.treatment == Treatment::Oss {
            // `jurisdiction_metadata ->> 'ossCountry' = $4`.
            query = query.filter(sea_orm::ExprTrait::eq(
                sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                    Expr::col(tax_rates::Column::JurisdictionMetadata),
                    "ossCountry",
                ),
                vat.country.as_str(),
            ));
        }
        let existing: Option<String> = query
            .order_by_with_nulls(
                tax_rates::Column::IsDefault,
                Order::Desc,
                NullOrdering::Last,
            )
            .order_by_asc(tax_rates::Column::CreatedAt)
            .into_tuple()
            .one(&orm(db))
            .await?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = generate_id("txr");
        tax_rates::Entity::insert(tax_rates::ActiveModel {
            id: Set(id.clone()),
            entity_id: Set(entity_id.to_owned()),
            jurisdiction_code: Set(jurisdiction.to_owned()),
            name: Set(name),
            rate: Set(rate),
            type_: Set("sales".to_owned()),
            tax_category_code: Set(Some(category.to_owned())),
            is_default: Set(Some(false)),
            is_active: Set(Some(true)),
            description: Set(Some(
                "Created by WeldSuite plan billing (ADR BILL-014)".to_owned(),
            )),
            jurisdiction_metadata: Set((!metadata.is_null()).then_some(metadata)),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
        Ok(id)
    }

    #[allow(clippy::too_many_lines)] // the four steps above, in order
    async fn issue(&self, request: &IssueRequest) -> Result<IssuedInvoice, String> {
        let text = |error: DbErr| error.to_string();
        let tenant = self
            .workspaces
            .tenant(&self.workspace_id)
            .await
            .map_err(|error| format!("issuer workspace: {error}"))?;
        let db = &tenant.db;
        let (entity_id, jurisdiction) = self.entity(db).await?;

        let existing: Option<(String, Option<String>, Option<String>)> = invoices::Entity::find()
            .select_only()
            .columns([
                invoices::Column::Id,
                invoices::Column::InvoiceNumber,
                invoices::Column::Status,
            ])
            .filter(invoices::Column::Reference.eq(&request.payment_id))
            .filter(invoices::Column::EntityId.eq(&entity_id))
            .filter(invoices::Column::DeletedAt.is_null())
            .order_by_asc(invoices::Column::CreatedAt)
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(text)?;

        let (invoice_id, number) = if let Some((id, number, status)) = existing {
            if status.as_deref() == Some("draft") {
                return Err(format!(
                    "invoice {id} for {} was left as a draft; finalize it in WeldBooks",
                    request.payment_id
                ));
            }
            (id, number.unwrap_or_default())
        } else {
            let contact_id = self.contact(db, request).await.map_err(text)?;
            let tax_rate_id = self
                .tax_rate(db, &entity_id, &jurisdiction, request)
                .await
                .map_err(text)?;
            let items: Vec<Value> = request
                .charge
                .lines
                .iter()
                .map(|line| {
                    let (quantity, unit) = match line.kind {
                        LineKind::Plan | LineKind::Addon if line.quantity > 0 => {
                            (line.quantity, line.unit_amount)
                        }
                        _ => (1, line.amount),
                    };
                    let period = match (&line.period_start, &line.period_end) {
                        (Some(start), Some(end)) => {
                            format!(
                                " ({} – {})",
                                &start[..10.min(start.len())],
                                &end[..10.min(end.len())]
                            )
                        }
                        _ => String::new(),
                    };
                    json!({
                        "description": format!("{}{period}", line.description),
                        "quantity": quantity,
                        "unitPrice": decimal(unit),
                        "taxRateId": tax_rate_id,
                    })
                })
                .collect();
            let notes = match request.language {
                Language::Nl => format!(
                    "Betaald via Mollie ({}). Werkruimte: {}.",
                    request.payment_id, request.workspace_id
                ),
                Language::En => format!(
                    "Paid through Mollie ({}). Workspace: {}.",
                    request.payment_id, request.workspace_id
                ),
            };
            let template = json!({
                "currency": request.charge.currency,
                "items": items,
                "paymentTermsDays": 1,
                "reference": request.payment_id,
                "notes": notes,
            });
            let recurring_id = self
                .recurring(db, &entity_id, &contact_id, template)
                .await
                .map_err(text)?;
            let rec = recurring_invoices::Entity::find_by_id(recurring_id.clone())
                .one(&orm(db))
                .await
                .map_err(text)?
                .ok_or_else(|| text(DbErr::RecordNotFound("recurring_invoices".to_owned())))?;
            let rec = serde_json::to_value(rec).map_err(|error| error.to_string())?;
            let runtime = weldsuite_books_domain::sales_tax::document_tax::Runtime {
                keyring: self.keyring.clone(),
                http: self.http.clone(),
            };
            let generated =
                weldsuite_books_sales::generate_recurring_invoice_as_system(db, &runtime, &rec)
                    .await;
            // Paused between charges, whatever happened.
            recurring_invoices::Entity::update_many()
                .col_expr(recurring_invoices::Column::Status, Expr::value("paused"))
                .col_expr(
                    recurring_invoices::Column::UpdatedAt,
                    Expr::current_timestamp(),
                )
                .filter(recurring_invoices::Column::Id.eq(&recurring_id))
                .exec(&orm(db))
                .await
                .map_err(text)?;
            let generated = generated.map_err(|error| format!("{error:?}"))?;
            if let Some(error) = generated.finalize_error {
                return Err(format!(
                    "invoice {} left as a draft: {error}",
                    generated.invoice_number
                ));
            }
            (generated.invoice_id, generated.invoice_number)
        };

        // The payment, once per Mollie payment.
        let total: Option<String> = invoices::Entity::find_by_id(invoice_id.clone())
            .select_only()
            // `total::text`: the amount as Postgres prints it.
            .column_as(
                sea_orm::ExprTrait::cast_as(Expr::col(invoices::Column::Total), "text"),
                "total",
            )
            .into_tuple::<Option<String>>()
            .one(&orm(db))
            .await
            .map_err(text)?
            .flatten();
        let total_cents = total
            .as_deref()
            .and_then(|t| weldsuite_mollie::Money::parse("EUR", t.trim_start_matches('-')))
            .map_or(request.charge.gross, |money| money.cents);
        if total_cents != request.charge.gross {
            tracing::warn!(invoice = %invoice_id, total_cents, charged = request.charge.gross, "billing: invoice total and charge differ");
        }
        let contact_id: Option<String> = invoices::Entity::find_by_id(invoice_id.clone())
            .select_only()
            .column(invoices::Column::ContactId)
            .into_tuple::<Option<String>>()
            .one(&orm(db))
            .await
            .map_err(text)?
            .flatten();
        let payment_key = format!(
            "bpm_{}",
            request
                .payment_id
                .trim_start_matches("tr_")
                .chars()
                .take(26)
                .collect::<String>()
        );
        let paid = request.charge.gross.min(total_cents);
        weldsuite_books_domain::payments::record_payment(
            db,
            self.http.as_ref(),
            weldsuite_books_domain::payments::RecordPaymentInput {
                id: Some(payment_key),
                entity_id: entity_id.clone(),
                received: true,
                amount: decimal(paid),
                currency: Some(request.charge.currency.clone()),
                date: weldsuite_events::iso_timestamp(request.paid_at),
                payment_method: Some("mollie".to_owned()),
                deposit_to: Some("undeposited_funds".to_owned()),
                reference: Some(request.payment_id.clone()),
                notes: request.method_label.clone(),
                contact_id,
                allocations: vec![weldsuite_books_domain::payments::AllocationInput {
                    invoice_id: Some(invoice_id.clone()),
                    bill_id: None,
                    amount: decimal(paid),
                }],
                ..weldsuite_books_domain::payments::RecordPaymentInput::default()
            },
        )
        .await
        .map_err(|error| format!("payment not recorded: {error:?}"))?;

        let document = match weldsuite_books_sales::render_invoice_html_as_system(
            db,
            &self.keyring,
            &invoice_id,
        )
        .await
        {
            Ok(html) => Some((html.into_bytes(), "text/html; charset=utf-8")),
            Err(error) => {
                tracing::warn!(error, invoice = %invoice_id, "billing: invoice document not rendered");
                None
            }
        };
        Ok(IssuedInvoice {
            provider_invoice_id: invoice_id,
            number,
            document,
        })
    }

    /// The customer's plan billing template, written for this charge
    /// (active, due now) or created: its id.
    async fn recurring(
        &self,
        db: &PgPool,
        entity_id: &str,
        contact_id: &str,
        template: Value,
    ) -> Result<String, DbErr> {
        let now = weldsuite_db::utc_timestamp(OffsetDateTime::now_utc());
        let recurring_id: Option<String> = recurring_invoices::Entity::find()
            .select_only()
            .column(recurring_invoices::Column::Id)
            .filter(recurring_invoices::Column::EntityId.eq(entity_id))
            .filter(recurring_invoices::Column::ContactId.eq(contact_id))
            .filter(recurring_invoices::Column::Name.eq("WeldSuite plan billing"))
            .filter(recurring_invoices::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        if let Some(id) = recurring_id {
            recurring_invoices::Entity::update_many()
                .col_expr(
                    recurring_invoices::Column::TemplateData,
                    Expr::value(template),
                )
                .col_expr(recurring_invoices::Column::Status, Expr::value("active"))
                .col_expr(recurring_invoices::Column::NextIssueDate, Expr::value(now))
                .col_expr(
                    recurring_invoices::Column::EndDate,
                    Expr::value(Option::<time::PrimitiveDateTime>::None),
                )
                .col_expr(recurring_invoices::Column::AutoFinalize, Expr::value(true))
                .col_expr(recurring_invoices::Column::AutoSend, Expr::value(false))
                .col_expr(recurring_invoices::Column::UpdatedAt, Expr::value(now))
                .filter(recurring_invoices::Column::Id.eq(&id))
                .exec(&orm(db))
                .await?;
            return Ok(id);
        }
        let id = generate_id("rinv");
        recurring_invoices::Entity::insert(recurring_invoices::ActiveModel {
            id: Set(id.clone()),
            entity_id: Set(entity_id.to_owned()),
            name: Set(Some("WeldSuite plan billing".to_owned())),
            contact_id: Set(contact_id.to_owned()),
            frequency: Set("monthly".to_owned()),
            next_issue_date: Set(now),
            status: Set("active".to_owned()),
            template_data: Set(Some(template)),
            auto_send: Set(Some(false)),
            auto_finalize: Set(Some(true)),
            created_by: Set(Some("system:billing".to_owned())),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
        Ok(id)
    }
}

fn rate_label(rate_bps: u32) -> String {
    weldsuite_core_billing::vat::rate_text(rate_bps)
}
