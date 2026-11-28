//! WeldBooks: books-api's routes, one crate per area (`weldsuite-books` is
//! the ledger, `weldsuite-books-*` the other areas; plan:
//! `rust/modules/books/PORTING.md`), all on the one [`BooksState`].
//!
//! An area crate is mounted with one line in [`api`] (and its public routes,
//! if any, in [`public`]). Served once `books` is marked ported; conformance
//! builds always mount it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use weldsuite_books_domain::http::{BooksState, Caller};
use weldsuite_db::{PgPool, Tenant, orm};
use weldsuite_schema::tenant::{bills, entities, invoices, recurring_invoices};

use crate::server::AppState;

/// The settings books-api reads from its env besides the shared ones, by
/// binding name: a name, or a prefix ending in `_`. Add what an area needs.
const BOOKS_ENV: &[&str] = &[
    "DIGIPOORT_MODE",
    "PLATFORM_URL",
    "BOOKS_API_URL",
    "BANK_FEED_PROVIDERS",
    "BANK_FEED_WEBHOOK_URL",
    "PLAID_",
    "STRIPE_FC_",
    "PONTO_",
    "ENABLE_BANKING_",
    "GUSTO_",
    "AVALARA_",
    "STRIPE_TAX_",
    "FOCUS_NFE_",
    "FIELD_ENCRYPTION_AAD_WRITES",
    // WeldBooks' public documents (edition feature `books-invoice-email`): the
    // pay portal's own address for the link in the e-mail, and the key that
    // signs the link (else derived from the field encryption key).
    "PAY_PORTAL_PUBLIC_URL",
    "BOOKS_DOCUMENT_TOKEN_SECRET",
];

/// books-api's `/api` prefixes, under `/api`.
pub(crate) fn api(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if !super::mounts("books") {
        return router;
    }
    let books = books_state(state);
    let gate = &state.permissions;
    let mut routers = Vec::new();
    // The ledger (foundation).
    routers.extend(weldsuite_books::routers(&books, gate));
    // The other areas: one line each.
    routers.extend(weldsuite_books_sales::routers(&books, gate));
    routers.extend(weldsuite_books_banking::routers(&books, gate));
    routers.extend(weldsuite_books_purchases::routers(&books, gate));
    routers.extend(weldsuite_books_sales_tax::routers(&books, gate));
    routers.extend(weldsuite_books_tax::routers(&books, gate));
    routers.extend(weldsuite_books_reports::routers(&books, gate));
    // Every books request marks its workspace for the daily sweep (books-api's
    // `registerBooksWorkspace` middleware). Conformance builds have no master.
    let master = books.master.clone();
    routers
        .into_iter()
        .fold(router, |router, (prefix, routes)| {
            let master = master.clone();
            router.nest(
                prefix,
                routes.layer(axum::middleware::from_fn(move |request, next| {
                    mark_books_workspace(master.clone(), request, next)
                })),
            )
        })
}

/// The due-index kind of the daily books sweep (`books:active:<org>` in
/// `WORKSPACE_CACHE` on Global).
pub(crate) const SWEEP_KIND: &str = "books";

/// `registerBooksWorkspace(env, org)`: remember, once per process, that this
/// workspace uses WeldBooks, so `weldsuite cron books-sweep` visits it.
async fn mark_books_workspace(master: Option<PgPool>, request: Request, next: Next) -> Response {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    if let (Some(master), Some(tenant)) = (master, request.extensions().get::<Tenant>()) {
        let workspace_id = tenant.workspace_id.clone();
        let fresh = SEEN
            .get_or_init(Mutex::default)
            .lock()
            .is_ok_and(|mut seen| seen.insert(workspace_id.clone()));
        if fresh {
            weldsuite_db::due_index::mark_due(
                &master,
                SWEEP_KIND,
                &workspace_id,
                time::OffsetDateTime::now_utc(),
            )
            .await;
        }
    }
    next.run(request).await
}

/// What the daily sweep did in one workspace (`TenantSweepResult`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct TenantSweep {
    pub(crate) overdue: usize,
    pub(crate) recurring_generated: usize,
    pub(crate) recurring_failed: usize,
    pub(crate) fx_rates: usize,
    /// Depreciation entries posted (one per period per entity).
    pub(crate) depreciation_posted: usize,
    /// Depreciation periods skipped (a lock date, a closed period).
    pub(crate) depreciation_skipped: usize,
    /// Tax reminder notices sent (each to every owner and admin).
    pub(crate) reminders_sent: u64,
    /// Tax reminders that failed (a candidate's query, a delivery).
    pub(crate) reminders_failed: u64,
    /// Approved bills that became overdue.
    pub(crate) bills_overdue: usize,
    /// Payment reminders e-mailed to customers (edition feature `books-reminders`).
    pub(crate) payment_reminders_sent: u64,
    /// Payment reminders that could not be sent.
    pub(crate) payment_reminders_failed: u64,
}

impl TenantSweep {
    pub(crate) fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "overdue": self.overdue,
            "recurringGenerated": self.recurring_generated,
            "recurringFailed": self.recurring_failed,
            "fxRates": self.fx_rates,
            "depreciationPosted": self.depreciation_posted,
            "depreciationSkipped": self.depreciation_skipped,
            "remindersSent": self.reminders_sent,
            "remindersFailed": self.reminders_failed,
            "billsOverdue": self.bills_overdue,
            "paymentRemindersSent": self.payment_reminders_sent,
            "paymentRemindersFailed": self.payment_reminders_failed,
        })
    }
}

/// `sweepTenant(db, now, tax)` (books-api `cron/books-sweep.ts`): finalized
/// invoices past due become overdue, due recurring invoices are generated (one
/// period per schedule per run) as the system, and today's ECB rates are
/// stored; then the US tax reminders go out ([`tax_reminders`]) and the
/// depreciation of fixed assets due through the end of last month is posted
/// (`runMonthlyDepreciation`: a locked period is skipped). A failure of
/// either is logged and never fails the tenant.
#[allow(clippy::too_many_lines, reason = "the sweep's steps in their order")]
pub(crate) async fn sweep_tenant(
    tenant: &Tenant,
    books: &BooksState,
    now: time::OffsetDateTime,
) -> Result<TenantSweep, DbErr> {
    let db = &tenant.db;
    let mut result = TenantSweep::default();
    let at = weldsuite_events::iso_timestamp(now);
    let stamp = weldsuite_db::utc_timestamp(now);
    let event_workspace = tenant
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| tenant.workspace_id.clone());
    let system = Caller::in_process(
        db.clone(),
        &tenant.workspace_id,
        &event_workspace,
        "system",
        "",
        None,
    );
    result.overdue = mark_overdue_invoices(&system, books, stamp).await?;
    result.bills_overdue = mark_overdue_bills(&system, books, stamp).await?;

    let due = recurring_invoices::Entity::find()
        .filter(recurring_invoices::Column::Status.eq("active"))
        .filter(recurring_invoices::Column::DeletedAt.is_null())
        .filter(recurring_invoices::Column::NextIssueDate.lte(stamp))
        .all(&orm(db))
        .await?;
    let runtime = weldsuite_books_domain::sales_tax::document_tax::Runtime {
        keyring: books.keyring.clone(),
        http: books.http.clone(),
    };
    for rec in due {
        let id = rec.id.clone();
        let rec = serde_json::to_value(rec).map_err(|error| DbErr::Json(error.to_string()))?;
        match weldsuite_books_sales::generate_recurring_invoice_as_system(db, &runtime, &rec).await
        {
            Ok(generated) => {
                result.recurring_generated += 1;
                if let Some(error) = generated.finalize_error {
                    tracing::warn!(
                        recurring = id,
                        invoice = generated.invoice_number,
                        %error,
                        "books-sweep: invoice left as draft"
                    );
                }
            }
            Err(weldsuite_books_sales::SystemGenerateError::AlreadyGenerated) => {}
            Err(weldsuite_books_sales::SystemGenerateError::Failed(error)) => {
                result.recurring_failed += 1;
                tracing::error!(recurring = id, %error, "books-sweep: recurring invoice failed");
            }
        }
    }

    let any_entity: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::Id)
        .filter(entities::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if any_entity.is_some() {
        let today: String = at.chars().take(10).collect();
        match weldsuite_books_domain::currency::persist_daily_ecb_rates(
            db,
            &books.rates,
            "",
            books.http.as_ref(),
            &today,
        )
        .await
        {
            Ok(stored) => result.fx_rates = stored,
            Err(error) => tracing::warn!(%error, "books-sweep: FX rates not stored"),
        }
    }

    // Payment reminders of the entities whose workflow sends them itself.
    match weldsuite_books_sales::send_due_reminders(
        db,
        books,
        &tenant.workspace_id,
        &event_workspace,
        i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default(),
    )
    .await
    {
        Ok(sent) => {
            result.payment_reminders_sent = sent.sent;
            result.payment_reminders_failed = sent.failed;
        }
        Err(error) => tracing::error!(%error, "books-sweep: payment reminders failed"),
    }

    if let Some(reminders) = tax_reminders(tenant, books, now).await {
        result.reminders_sent = reminders.sent;
        result.reminders_failed = reminders.failed;
    }

    // Depreciation due through the end of last month (UTC).
    let today: String = at.chars().take(10).collect();
    let through = weldsuite_books_reports::last_completed_month_end(&today);
    match weldsuite_books_reports::run_monthly_depreciation(db, None, &through).await {
        Ok(runs) => {
            for entity in &runs {
                result.depreciation_posted += entity.run.posted.len();
                result.depreciation_skipped += entity.run.skipped.len();
            }
            if !runs.is_empty() {
                tracing::info!(
                    entities = runs.len(),
                    posted = result.depreciation_posted,
                    skipped = result.depreciation_skipped,
                    "books-sweep: depreciation"
                );
            }
        }
        Err(error) => tracing::error!(%error, "books-sweep: depreciation failed"),
    }
    Ok(result)
}

/// Invoices past due become `overdue` and each is announced
/// (`invoice.overdue`, from the system), so workflows and agents that wait
/// for it fire. A `partial` invoice stays `partial`: its balance is still
/// shown and its payments are not hidden behind a status the TypeScript
/// sweep wrote over them (Rust only, plan weldbooks-connected-ux, bug 4).
async fn mark_overdue_invoices(
    system: &Caller,
    books: &BooksState,
    stamp: time::PrimitiveDateTime,
) -> Result<usize, DbErr> {
    use invoices::Column as C;
    let db = orm(&system.db);
    let due = invoices::Entity::find()
        .filter(C::Status.is_in(["sent", "finalized"]))
        .filter(C::DeletedAt.is_null())
        .filter(C::DueDate.lt(stamp))
        // `coalesce(balance_due, '0')::numeric > 0`: a null balance is not due.
        .filter(C::BalanceDue.gt(0))
        .filter(C::Type.is_in(["standard", "correction"]))
        .all(&db)
        .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = due.iter().map(|i| i.id.clone()).collect();
    let flipped = invoices::Entity::update_many()
        .col_expr(C::Status, Expr::value("overdue"))
        .col_expr(C::UpdatedAt, Expr::value(stamp))
        .filter(C::Id.is_in(ids))
        .filter(C::Status.is_in(["sent", "finalized"]))
        .exec(&db)
        .await?;
    for invoice in due {
        system.publish_system(
            books,
            weldsuite_catalogs::entity_events::INVOICE_OVERDUE,
            &invoice.id,
            serde_json::json!({
                "id": invoice.id,
                "invoiceNumber": invoice.invoice_number,
                "status": "overdue",
                "total": invoice.total.as_ref().map(ToString::to_string),
                "balanceDue": invoice.balance_due.as_ref().map(ToString::to_string),
                "currency": invoice.currency,
                "contactId": invoice.contact_id,
            }),
        );
    }
    Ok(usize::try_from(flipped.rows_affected).unwrap_or(usize::MAX))
}

/// Approved bills past due become `overdue` (never marked before; Rust
/// only). `partial` bills stay as they are.
async fn mark_overdue_bills(
    system: &Caller,
    books: &BooksState,
    stamp: time::PrimitiveDateTime,
) -> Result<usize, DbErr> {
    use bills::Column as C;
    let db = orm(&system.db);
    let due = bills::Entity::find()
        .filter(C::Status.eq("approved"))
        .filter(C::DeletedAt.is_null())
        .filter(C::DueDate.lt(stamp))
        .filter(C::BalanceDue.gt(0))
        .all(&db)
        .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let ids: Vec<String> = due.iter().map(|b| b.id.clone()).collect();
    let flipped = bills::Entity::update_many()
        .col_expr(C::Status, Expr::value("overdue"))
        .col_expr(C::UpdatedAt, Expr::value(stamp))
        .filter(C::Id.is_in(ids))
        .filter(C::Status.eq("approved"))
        .exec(&db)
        .await?;
    for bill in due {
        system.publish_system(
            books,
            weldsuite_catalogs::entity_events::BILL_OVERDUE,
            &bill.id,
            serde_json::json!({
                "id": bill.id,
                "billNumber": bill.bill_number,
                "status": "overdue",
                "total": bill.total.as_ref().map(ToString::to_string),
                "balanceDue": bill.balance_due.as_ref().map(ToString::to_string),
                "currency": bill.currency,
                "contactId": bill.contact_id,
            }),
        );
    }
    Ok(usize::try_from(flipped.rows_affected).unwrap_or(usize::MAX))
}

/// `runTaxReminders` for one workspace of the daily sweep
/// (`cron/tax-reminders.ts`): sales tax returns, calendar deadlines,
/// expiring certificates and (on Mondays) newly reached nexus of its US
/// entities, once each, to its owners and admins in the app. The "already
/// reminded" markers live in the cache with their TTL
/// (`books:reminder:<workspaces.id>:<marker>`, KV on Global); without a cache
/// nothing would keep a reminder from repeating daily, so none is sent.
async fn tax_reminders(
    tenant: &Tenant,
    books: &BooksState,
    now: time::OffsetDateTime,
) -> Option<weldsuite_books_sales_tax::reminders::TaxReminderResult> {
    use weldsuite_books_sales_tax::reminders::{
        CacheMarkers, InAppNotifier, TaxReminderOptions, run_tax_reminders,
    };
    let Some(cache) = books.cache.clone() else {
        tracing::warn!(
            workspace = %tenant.workspace_id,
            "books-sweep: no cache, tax reminders not sent"
        );
        return None;
    };
    let markers = CacheMarkers::new(cache, tenant.workspace_id.clone());
    // The realtime hub knows the workspace by its organization id, as books-api's.
    let hub = tenant
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| tenant.workspace_id.clone());
    let notifier = InAppNotifier::new(tenant.db.clone(), books.realtime.clone(), hub);
    let options = TaxReminderOptions {
        notifier: &notifier,
        markers: &markers,
        now,
        recipients: None,
        force_nexus: false,
    };
    match run_tax_reminders(&tenant.db, &options).await {
        Ok(result) => {
            if result.sent > 0 || result.failed > 0 {
                tracing::info!(
                    workspace = %tenant.workspace_id,
                    sent = result.sent,
                    skipped = result.skipped,
                    failed = result.failed,
                    "books-sweep: tax reminders"
                );
            }
            Some(result)
        }
        Err(error) => {
            tracing::error!(workspace = %tenant.workspace_id, %error, "books-sweep: tax reminders failed");
            None
        }
    }
}

/// books-api's routes outside the session (`/public/w9`,
/// `/public/fiscal-webhooks`), at their full paths. Conformance builds open
/// the test's tenant database for every workspace.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    if !super::mounts("books") {
        return Router::new();
    }
    let books = books_state(state);
    // The W-9 form (purchases).
    let router: Router<AppState> =
        weldsuite_books_purchases::public_router(&books, Some(Arc::clone(&state.workspaces)));
    // Focus NFe's webhook (VAT, GST and Brazil).
    let router = router.merge(weldsuite_books_tax::public_router(
        &books,
        Some(Arc::clone(&state.workspaces)),
    ));
    // The public invoice and quote page's documents (edition feature
    // `books-invoice-email`; the pay portal calls them).
    let router = router.merge(weldsuite_books_sales::public_router(
        &books,
        Some(Arc::clone(&state.workspaces)),
    ));
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// WeldBooks' handle on the app: events, files, the master database,
/// outbound HTTP, the cache, the field encryption keys and its settings.
pub(crate) fn books_state(state: &AppState) -> BooksState {
    let conformance = cfg!(feature = "conformance");
    BooksState {
        events: state.infra.events.clone(),
        // Conformance builds use only what a test shares, per request.
        files: (!conformance)
            .then(|| {
                state
                    .infra
                    .files
                    .clone()
                    .map(|private| weldsuite_ports::FileStores {
                        private,
                        public: state.infra.public_files.clone(),
                    })
            })
            .flatten(),
        master: (!conformance).then(|| state.workspaces.master().clone()),
        http: (!conformance).then(books_http).flatten(),
        ponto_http: (!conformance).then(ponto_http).flatten(),
        cache: (!conformance).then(|| state.infra.cache.clone()).flatten(),
        realtime: state.infra.realtime.clone(),
        jobs: Some(Arc::clone(&state.infra.jobs)),
        keyring: weldsuite_db::Keyring {
            v1: env_value("DATABASE_ENCRYPTION_KEY"),
            v2: env_value("DATABASE_ENCRYPTION_KEY_V2"),
        },
        env: books_env(),
        rates: rate_cache(),
        trusted_proxies: state.trusted_proxies,
        // Clerk sign-in: `public_auth` is set exactly with OIDC, where the
        // session layer's step-up switch decides (WeldID).
        second_factor_step_up: state.public_auth.is_none(),
        // Conformance answers the worker without its certificate binding.
        digipoort: (!conformance).then(digipoort).flatten(),
        // Document OCR (`books-ocr`); `None` with AI off. A conformance
        // request carries the test's own.
        ai: state.ai.clone(),
        mail: (!conformance).then(|| state.infra.mail.clone()).flatten(),
    }
}

/// The books state of a job without the app (`weldsuite cron books-sweep`):
/// the master database, the keys and outbound HTTP; the sweep publishes no
/// events.
pub(crate) fn sweep_state(master: &PgPool, keyring: &weldsuite_db::Keyring) -> BooksState {
    let mut books = BooksState::new(weldsuite_events::EntityEventPublisher::new(
        None,
        weldsuite_events::TaskTracker::new(),
    ));
    books.master = Some(master.clone());
    books.http = books_http();
    books.keyring = keyring.clone();
    books.env = books_env();
    books.rates = rate_cache();
    books.digipoort = digipoort();
    books
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The process's books settings ([`BOOKS_ENV`]), read once.
pub(crate) fn books_env() -> Arc<HashMap<String, String>> {
    static ENV: OnceLock<Arc<HashMap<String, String>>> = OnceLock::new();
    Arc::clone(ENV.get_or_init(|| {
        Arc::new(
            std::env::vars()
                .filter(|(name, _)| {
                    BOOKS_ENV.iter().any(|wanted| {
                        if wanted.ends_with('_') {
                            name.starts_with(wanted)
                        } else {
                            name == wanted
                        }
                    })
                })
                .collect(),
        )
    }))
}

/// One HTTP client for the third parties books calls (ECB, VIES, tax and
/// bank-feed providers), made once per process.
pub(crate) fn books_http() -> Option<weldsuite_ports::OutboundHttp> {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    HTTP.get_or_init(|| {
        weldsuite_adapters_oss::ReqwestOutbound::new(std::time::Duration::from_secs(15))
            .ok()
            .map(|client| weldsuite_ports::OutboundHttp(Arc::new(client)))
    })
    .clone()
}

/// Ponto's mTLS client: the client certificate and its key (PEM) from
/// `PONTO_MTLS_CERT` and `PONTO_MTLS_KEY`, made once per process. None
/// without them (Ponto is then called without a client certificate, which
/// its API refuses).
pub(crate) fn ponto_http() -> Option<weldsuite_ports::OutboundHttp> {
    static HTTP: OnceLock<Option<weldsuite_ports::OutboundHttp>> = OnceLock::new();
    HTTP.get_or_init(|| {
        let cert = env_value("PONTO_MTLS_CERT")?;
        let key = env_value("PONTO_MTLS_KEY")?;
        match weldsuite_adapters_oss::ReqwestOutbound::with_client_certificate(
            std::time::Duration::from_secs(15),
            format!(
                "{cert}
{key}"
            )
            .as_bytes(),
        ) {
            Ok(client) => Some(weldsuite_ports::OutboundHttp(Arc::new(client))),
            Err(error) => {
                tracing::error!(%error, "books: the Ponto client certificate does not load");
                None
            }
        }
    })
    .clone()
}

/// The install's Digipoort connection (`DIGIPOORT_*`): the `PKIoverheid`
/// certificate signs every message and is presented for mutual TLS, with
/// `DIGIPOORT_CA` added to the roots Digipoort's server certificate is
/// checked against. Made once per process; `None` when Digipoort is off or
/// its settings don't load (`/config.json` then lists `vat-digipoort` and
/// `kvk-digipoort`, and a start with a broken setup is refused there).
pub(crate) fn digipoort() -> Option<weldsuite_digipoort::Digipoort> {
    static CLIENT: OnceLock<Option<weldsuite_digipoort::Digipoort>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let config = match weldsuite_digipoort::DigipoortConfig::from_env(env_value) {
                Ok(Some(config)) => config,
                Ok(None) => return None,
                Err(error) => {
                    tracing::error!(%error, "books: Digipoort is not set up correctly");
                    return None;
                }
            };
            let http = match weldsuite_adapters_oss::ReqwestOutbound::with_client_certificate_and_roots(
                std::time::Duration::from_secs(60),
                config.identity_pem().as_bytes(),
                config.ca_pem.as_deref().map(str::as_bytes),
            ) {
                Ok(client) => weldsuite_ports::OutboundHttp(Arc::new(client)),
                Err(error) => {
                    tracing::error!(%error, "books: the Digipoort client certificate does not load");
                    return None;
                }
            };
            match weldsuite_digipoort::Digipoort::new(&config, http) {
                Ok(client) => {
                    tracing::info!(mode = config.mode.as_str(), "books: Digipoort filing is on");
                    Some(client)
                }
                Err(error) => {
                    tracing::error!(%error, "books: the Digipoort signing key does not load");
                    None
                }
            }
        })
        .clone()
}

/// The ECB rates cache, one per process (the worker's module-level cache).
fn rate_cache() -> Arc<weldsuite_books_domain::currency::RateCache> {
    static RATES: OnceLock<Arc<weldsuite_books_domain::currency::RateCache>> = OnceLock::new();
    Arc::clone(RATES.get_or_init(Arc::default))
}

/// The overdue sweep against a database (`WELDSUITE_TEST_TENANT_URL`; the
/// tests return early without it).
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "test fixtures are written in SQL"
)]
mod tests {
    use weldsuite_events::{EntityEventPublisher, TaskTracker};
    use weldsuite_ports::{DynEventBus, RecordingEventBus};

    use super::*;

    fn tenant_db() -> Option<PgPool> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return None;
        };
        Some(weldsuite_db::master_pool(&url, 2).unwrap())
    }

    async fn insert_invoice(
        db: &PgPool,
        entity: &str,
        status: &str,
        due_days_ago: i32,
        balance: &str,
    ) -> String {
        let id = weldsuite_kit::generate_id("inv");
        sqlx::query(
            "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, issue_date, due_date, \
               currency, total, amount_paid, balance_due) \
             values ($1, $2, $1, 'standard', $3, 'pty_x', now() - interval '60 days', \
               now() - ($4 || ' days')::interval, 'EUR', 121, 0, $5::numeric)",
        )
        .bind(&id)
        .bind(entity)
        .bind(status)
        .bind(due_days_ago.to_string())
        .bind(balance)
        .execute(db)
        .await
        .unwrap();
        id
    }

    async fn insert_bill(
        db: &PgPool,
        entity: &str,
        status: &str,
        due_days_ago: i32,
        balance: &str,
    ) -> String {
        let id = weldsuite_kit::generate_id("bil");
        sqlx::query(
            "insert into bills (id, entity_id, bill_number, type, status, contact_id, issue_date, due_date, \
               currency, total, amount_paid, balance_due) \
             values ($1, $2, $1, 'bill', $3, 'pty_x', now() - interval '60 days', \
               now() - ($4 || ' days')::interval, 'EUR', 121, 0, $5::numeric)",
        )
        .bind(&id)
        .bind(entity)
        .bind(status)
        .bind(due_days_ago.to_string())
        .bind(balance)
        .execute(db)
        .await
        .unwrap();
        id
    }

    async fn status_of(db: &PgPool, table: &'static str, id: &str) -> String {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "select status from {table} where id = $1"
        )))
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn the_sweep_announces_what_becomes_overdue_and_keeps_partial() {
        let Some(db) = tenant_db() else { return };
        let bus = Arc::new(RecordingEventBus::new());
        let books = BooksState::new(EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            TaskTracker::new(),
        ));
        let system =
            Caller::in_process(db.clone(), "ws_p4_sweep", "ws_p4_sweep", "system", "", None);
        let entity = weldsuite_kit::generate_id("ent");
        sqlx::query("insert into entities (id, name, jurisdiction_code, base_currency, is_active) values ($1, 'Sweep', 'NL', 'EUR', true)")
            .bind(&entity)
            .execute(&db)
            .await
            .unwrap();
        // Past due: sent and finalized flip; partial stays; paid, not yet due and drafts do not.
        let sent = insert_invoice(&db, &entity, "sent", 3, "121").await;
        let finalized = insert_invoice(&db, &entity, "finalized", 3, "121").await;
        let partial = insert_invoice(&db, &entity, "partial", 3, "60").await;
        let early = insert_invoice(&db, &entity, "sent", -3, "121").await;
        let draft = insert_invoice(&db, &entity, "draft", 3, "121").await;
        let settled = insert_invoice(&db, &entity, "sent", 3, "0").await;
        let approved = insert_bill(&db, &entity, "approved", 3, "121").await;
        let half = insert_bill(&db, &entity, "partial", 3, "60").await;
        let future = insert_bill(&db, &entity, "approved", -3, "121").await;
        let stamp = weldsuite_db::utc_now();

        let invoices_flipped = mark_overdue_invoices(&system, &books, stamp).await.unwrap();
        let bills_flipped = mark_overdue_bills(&system, &books, stamp).await.unwrap();
        assert!(
            invoices_flipped >= 2 && bills_flipped >= 1,
            "{invoices_flipped} {bills_flipped}"
        );
        for id in [&sent, &finalized] {
            assert_eq!(status_of(&db, "invoices", id).await, "overdue");
        }
        assert_eq!(
            status_of(&db, "invoices", &partial).await,
            "partial",
            "partial stays partial"
        );
        for id in [&early, &settled] {
            assert_eq!(status_of(&db, "invoices", id).await, "sent");
        }
        assert_eq!(status_of(&db, "invoices", &draft).await, "draft");
        assert_eq!(status_of(&db, "bills", &approved).await, "overdue");
        assert_eq!(status_of(&db, "bills", &half).await, "partial");
        assert_eq!(status_of(&db, "bills", &future).await, "approved");

        // Each one is announced once, from the system.
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        let events: Vec<(String, String)> = bus
            .payloads()
            .into_iter()
            .map(|p| {
                (
                    format!(
                        "{}.{}",
                        p["entityType"].as_str().unwrap(),
                        p["action"].as_str().unwrap()
                    ),
                    p["data"]["id"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        for id in [&sent, &finalized] {
            assert_eq!(
                events
                    .iter()
                    .filter(|(n, i)| n == "invoice.overdue" && i == id)
                    .count(),
                1,
                "{events:?}"
            );
        }
        assert!(events.contains(&("bill.overdue".to_owned(), approved.clone())));
        for id in [&partial, &early, &draft, &settled, &half, &future] {
            assert!(!events.iter().any(|(_, i)| i == id), "{id}");
        }
        // A second sweep announces nothing again.
        bus.clear();
        mark_overdue_invoices(&system, &books, stamp).await.unwrap();
        mark_overdue_bills(&system, &books, stamp).await.unwrap();
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        assert!(
            !bus.payloads()
                .iter()
                .any(|p| p["data"]["id"] == serde_json::json!(sent))
        );
    }
}
