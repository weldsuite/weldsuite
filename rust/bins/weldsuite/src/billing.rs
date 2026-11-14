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
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_core_billing::{
    BillingMail, BillingMailKind, BillingMailer, BillingSettings, BillingState, InvoiceIssuer,
    IssueRequest, IssuedInvoice, Language, LineKind, Treatment, WEBHOOK_PATH,
};
use weldsuite_db::{Keyring, PgPool, Workspaces};
use weldsuite_emails::billing::{Dunning, DunningKind, dunning};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_kit::generate_id;
use weldsuite_ports::{BoxFuture, DynSystemMail, OutboundHttp};

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
        weldsuite_core_platform::topup::settle(&hook.billing.master, &payment)
            .await
            .map(|settled| format!("{settled:?}"))
            .map_err(|error| error.to_string())
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

// ── the billing owners' emails ──────────────────────────────────────────────

struct SystemMailer {
    mail: Arc<dyn DynSystemMail>,
}

impl BillingMailer for SystemMailer {
    fn send<'a>(&'a self, message: &'a BillingMail) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let locale = match message.language {
                Language::Nl => EmailLocale::Nl,
                Language::En => EmailLocale::En,
            };
            let props = Dunning {
                kind: match message.kind {
                    BillingMailKind::PaymentFailed => DunningKind::Failed,
                    BillingMailKind::PaymentReminder => DunningKind::Reminder,
                    BillingMailKind::PlanEnded => DunningKind::Ended,
                },
                workspace_name: message.workspace_name.clone(),
                plan_name: message.plan_name.clone(),
                amount: message.amount.clone().unwrap_or_default(),
                ends_on: message.ends_on.clone().unwrap_or_default(),
                url: message
                    .pay_url
                    .clone()
                    .unwrap_or_else(|| message.billing_url.clone()),
            };
            let brand = EmailBrand::weldsuite("WeldSuite");
            let rendered = dunning(locale, &brand, &props).map_err(|error| error.to_string())?;
            let mut failures = Vec::new();
            for recipient in &message.recipients {
                let email = SystemEmail::to(rendered.clone(), brand.clone(), recipient);
                if let Err(error) = send_system_email(self.mail.as_ref(), email).await {
                    failures.push(error.to_string());
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("; "))
            }
        })
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
        let row: Option<(String, Option<String>)> = match &self.entity_id {
            Some(id) => sqlx::query_as(
                "select id, jurisdiction_code from entities where id = $1 and deleted_at is null",
            )
            .bind(id)
            .fetch_optional(db)
            .await,
            None => {
                sqlx::query_as(
                    "select id, jurisdiction_code from entities where deleted_at is null
                 order by created_at limit 1",
                )
                .fetch_optional(db)
                .await
            }
        }
        .map_err(|error| error.to_string())?;
        row.map(|(id, code)| (id, code.unwrap_or_else(|| "NL".to_owned())))
            .ok_or_else(|| "the issuer workspace has no accounting entity".to_owned())
    }

    /// The customer contact, created or updated.
    async fn contact(&self, db: &PgPool, request: &IssueRequest) -> Result<String, sqlx::Error> {
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
        let existing: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, company_id from parties where party_code = $1 and deleted_at is null limit 1",
        )
        .bind(&code)
        .fetch_optional(db)
        .await?;
        if let Some((party_id, company_id)) = existing {
            sqlx::query(
                "update parties set display_name = $2, billing_address = $3::jsonb, updated_at = now()
                 where id = $1",
            )
            .bind(&party_id)
            .bind(&customer.name)
            .bind(&address)
            .execute(db)
            .await?;
            if let Some(company_id) = company_id {
                sqlx::query(
                    "update companies set name = $2, display_name = $2, vat_number = $3,
                         email = coalesce($4, email), updated_at = now()
                     where id = $1",
                )
                .bind(&company_id)
                .bind(&customer.name)
                .bind(customer.vat_number.as_deref())
                .bind(customer.email.as_deref())
                .execute(db)
                .await?;
            }
            return Ok(party_id);
        }
        let company_id = generate_id("comp");
        let party_id = generate_id("pty");
        let mut tx = db.begin().await?;
        sqlx::query(
            "insert into companies (id, name, display_name, vat_number, email)
             values ($1, $2, $2, $3, $4)",
        )
        .bind(&company_id)
        .bind(&customer.name)
        .bind(customer.vat_number.as_deref())
        .bind(customer.email.as_deref())
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "insert into parties (id, party_code, kind, company_id, display_name, billing_address,
                 currency, status)
             values ($1, $2, 'company', $3, $4, $5::jsonb, 'EUR', 'active')",
        )
        .bind(&party_id)
        .bind(&code)
        .bind(&company_id)
        .bind(&customer.name)
        .bind(&address)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
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
    ) -> Result<String, sqlx::Error> {
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
        let existing: Option<String> = sqlx::query_scalar(
            "select id from tax_rates
             where entity_id = $1 and deleted_at is null and coalesce(is_active, true)
               and tax_category_code = $2 and rate = $3::numeric
               and ($4::text is null or jurisdiction_metadata ->> 'ossCountry' = $4)
             order by is_default desc nulls last, created_at limit 1",
        )
        .bind(entity_id)
        .bind(category)
        .bind(&rate)
        .bind((vat.treatment == Treatment::Oss).then_some(vat.country.as_str()))
        .fetch_optional(db)
        .await?;
        if let Some(id) = existing {
            return Ok(id);
        }
        let id = generate_id("txr");
        sqlx::query(
            "insert into tax_rates (id, entity_id, jurisdiction_code, name, rate, type,
                 tax_category_code, is_default, is_active, description, jurisdiction_metadata)
             values ($1, $2, $3, $4, $5::numeric, 'sales', $6, false, true, $7, $8::jsonb)",
        )
        .bind(&id)
        .bind(entity_id)
        .bind(jurisdiction)
        .bind(&name)
        .bind(&rate)
        .bind(category)
        .bind("Created by WeldSuite plan billing (ADR BILL-014)")
        .bind(if metadata.is_null() {
            None
        } else {
            Some(metadata)
        })
        .execute(db)
        .await?;
        Ok(id)
    }

    #[allow(clippy::too_many_lines)] // the four steps above, in order
    async fn issue(&self, request: &IssueRequest) -> Result<IssuedInvoice, String> {
        let text = |error: sqlx::Error| error.to_string();
        let tenant = self
            .workspaces
            .tenant(&self.workspace_id)
            .await
            .map_err(|error| format!("issuer workspace: {error}"))?;
        let db = &tenant.db;
        let (entity_id, jurisdiction) = self.entity(db).await?;

        let existing: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, invoice_number, status from invoices
             where reference = $1 and entity_id = $2 and deleted_at is null
             order by created_at limit 1",
        )
        .bind(&request.payment_id)
        .bind(&entity_id)
        .fetch_optional(db)
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
            let now = weldsuite_events::iso_timestamp(OffsetDateTime::now_utc());
            let recurring_id: Option<String> = sqlx::query_scalar(
                "select id from recurring_invoices
                 where entity_id = $1 and contact_id = $2 and name = 'WeldSuite plan billing'
                   and deleted_at is null limit 1",
            )
            .bind(&entity_id)
            .bind(&contact_id)
            .fetch_optional(db)
            .await
            .map_err(text)?;
            let recurring_id = if let Some(id) = recurring_id {
                {
                    sqlx::query(
                        "update recurring_invoices set template_data = $2::jsonb, status = 'active',
                             next_issue_date = $3::timestamp, end_date = null, auto_finalize = true,
                             auto_send = false, updated_at = $3::timestamp
                         where id = $1",
                    )
                    .bind(&id)
                    .bind(&template)
                    .bind(&now)
                    .execute(db)
                    .await
                    .map_err(text)?;
                    id
                }
            } else {
                {
                    let id = generate_id("rinv");
                    sqlx::query(
                        "insert into recurring_invoices (id, entity_id, name, contact_id, frequency,
                             next_issue_date, status, template_data, auto_send, auto_finalize, created_by)
                         values ($1, $2, 'WeldSuite plan billing', $3, 'monthly', $4::timestamp,
                                 'active', $5::jsonb, false, true, 'system:billing')",
                    )
                    .bind(&id)
                    .bind(&entity_id)
                    .bind(&contact_id)
                    .bind(&now)
                    .bind(&template)
                    .execute(db)
                    .await
                    .map_err(text)?;
                    id
                }
            };
            let rec: Value = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(recurring_invoices),
                " from recurring_invoices t where t.id = $1"
            ))
            .bind(&recurring_id)
            .fetch_one(db)
            .await
            .map_err(text)?;
            let rec = weldsuite_books_domain::tables::RECURRING_INVOICES.js(rec);
            let runtime = weldsuite_books_domain::sales_tax::document_tax::Runtime {
                keyring: self.keyring.clone(),
                http: self.http.clone(),
            };
            let generated =
                weldsuite_books_sales::generate_recurring_invoice_as_system(db, &runtime, &rec)
                    .await;
            // Paused between charges, whatever happened.
            sqlx::query(
                "update recurring_invoices set status = 'paused', updated_at = now() where id = $1",
            )
            .bind(&recurring_id)
            .execute(db)
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
        let total: Option<String> =
            sqlx::query_scalar("select total::text from invoices where id = $1")
                .bind(&invoice_id)
                .fetch_optional(db)
                .await
                .map_err(text)?;
        let total_cents = total
            .as_deref()
            .and_then(|t| weldsuite_mollie::Money::parse("EUR", t.trim_start_matches('-')))
            .map_or(request.charge.gross, |money| money.cents);
        if total_cents != request.charge.gross {
            tracing::warn!(invoice = %invoice_id, total_cents, charged = request.charge.gross, "billing: invoice total and charge differ");
        }
        let contact_id: Option<String> =
            sqlx::query_scalar("select contact_id from invoices where id = $1")
                .bind(&invoice_id)
                .fetch_optional(db)
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
}

fn rate_label(rate_bps: u32) -> String {
    weldsuite_core_billing::vat::rate_text(rate_bps)
}
