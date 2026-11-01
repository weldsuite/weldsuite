//! WeldBooks: books-api's routes, one crate per area (`weldsuite-books` is
//! the ledger, `weldsuite-books-*` the other areas; plan:
//! `rust/modules/books/PORTING.md`), all on the one [`BooksState`].
//!
//! An area crate is mounted with one line in [`api`] (and its public routes,
//! if any, in [`public`]). Served once `books` is marked ported; conformance
//! builds always mount it.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use axum::Router;
use weldsuite_books_domain::http::BooksState;

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
    routers.extend(weldsuite_books_banking::routers(&books, gate));
    routers
        .into_iter()
        .fold(router, |router, (prefix, routes)| {
            router.nest(prefix, routes)
        })
}

/// books-api's routes outside the session (`/public/w9`,
/// `/public/fiscal-webhooks`), at their full paths. None ported yet.
pub(crate) fn public(_state: &AppState) -> Router<AppState> {
    Router::new()
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
