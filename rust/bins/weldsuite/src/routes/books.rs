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
use weldsuite_books_domain::http::BooksState;
use weldsuite_db::{PgPool, Tenant};

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
        })
    }
}

/// `sweepTenant(db, now, tax)` (books-api `cron/books-sweep.ts`): finalized
/// invoices past due become overdue, due recurring invoices are generated (one
/// period per schedule per run) as the system, and today's ECB rates are
/// stored; then the depreciation of fixed assets due through the end of last
/// month is posted (`runMonthlyDepreciation`: a locked period is skipped, a
/// failure is logged and never fails the tenant). The US tax reminders join
/// here when the sales-tax area has ported the services they read.
pub(crate) async fn sweep_tenant(
    db: &PgPool,
    books: &BooksState,
    now: time::OffsetDateTime,
) -> Result<TenantSweep, sqlx::Error> {
    let mut result = TenantSweep::default();
    let at = weldsuite_events::iso_timestamp(now);
    let overdue: Vec<String> = sqlx::query_scalar(
        "update invoices set status = 'overdue', updated_at = $1::timestamp \
         where status in ('sent', 'finalized') and deleted_at is null and due_date < $1::timestamp \
         and coalesce(balance_due, '0')::numeric > 0 and type in ('standard', 'correction') \
         returning id",
    )
    .bind(&at)
    .fetch_all(db)
    .await?;
    result.overdue = overdue.len();

    let due: Vec<serde_json::Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(recurring_invoices),
        " from recurring_invoices t where t.status = 'active' and t.deleted_at is null \
         and t.next_issue_date <= $1::timestamp"
    ))
    .bind(&at)
    .fetch_all(db)
    .await?;
    let runtime = weldsuite_books_domain::sales_tax::document_tax::Runtime {
        keyring: books.keyring.clone(),
        http: books.http.clone(),
    };
    for rec in due {
        let rec = weldsuite_books_domain::tables::RECURRING_INVOICES.js(rec);
        let id = rec["id"].as_str().unwrap_or_default().to_owned();
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

    let any_entity: Option<String> =
        sqlx::query_scalar("select id from entities where deleted_at is null limit 1")
            .fetch_optional(db)
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
    books
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

/// The process's books settings ([`BOOKS_ENV`]), read once.
fn books_env() -> Arc<HashMap<String, String>> {
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
fn books_http() -> Option<weldsuite_ports::OutboundHttp> {
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
fn ponto_http() -> Option<weldsuite_ports::OutboundHttp> {
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

/// The ECB rates cache, one per process (the worker's module-level cache).
fn rate_cache() -> Arc<weldsuite_books_domain::currency::RateCache> {
    static RATES: OnceLock<Arc<weldsuite_books_domain::currency::RateCache>> = OnceLock::new();
    Arc::clone(RATES.get_or_init(Arc::default))
}
