//! WeldBooks' ledger: the `/api/<object>` routes of books-api's ledger
//! groups (`apps/workers/books-api/src/routes/`), on the shared rules of
//! `weldsuite-books-domain`. The other books areas are their own crates
//! (`weldsuite-books-*`); the plan is `PORTING.md` next to this crate.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! ledger` conformance suite (`rust/conformance/suites.json`).

mod accounting_dimensions;
mod accounting_entities;
mod entity_setup;
mod fiscal_periods;
mod fx_rates;
mod gl_accounts;
mod journal_entries;
mod tax_rates;

use std::sync::Arc;

use axum::Router;
pub use weldsuite_books_domain::http::BooksState;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

/// The routers, by `/api` prefix (`app.route(prefix, routes)` in
/// books-api's `src/index.ts`), to nest under `/api` behind the session,
/// tenant database, licence and flag layers.
pub fn routers<S, Q>(
    state: &BooksState,
    gate: &Arc<PermissionGate<Q>>,
) -> Vec<(&'static str, Router<S>)>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    vec![
        (
            "/accounting-entities",
            accounting_entities::router(state.clone(), gate),
        ),
        (
            "/accounting-dimensions",
            accounting_dimensions::router(state.clone(), gate),
        ),
        (
            "/fiscal-periods",
            fiscal_periods::router(state.clone(), gate),
        ),
        ("/fx-rates", fx_rates::router(state.clone(), gate)),
        ("/gl-accounts", gl_accounts::router(state.clone(), gate)),
        (
            "/journal-entries",
            journal_entries::router(state.clone(), gate),
        ),
        ("/tax-rates", tax_rates::router(state.clone(), gate)),
    ]
}
