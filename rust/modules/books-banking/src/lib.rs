//! WeldBooks banking (area 3 of `rust/modules/books/PORTING.md`): the
//! `/api/<object>` routes of books-api's banking groups
//! (`apps/workers/books-api/src/routes/bank-*`, `reconciliation-rules`), on
//! the shared rules of `weldsuite-books-domain` (bank accounts, matching,
//! the bank feeds).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! banking` conformance suite (`rust/conformance/suites.json`).

mod bank_accounts;
mod bank_transactions;
mod categorize;
mod common;
mod csv_format;
mod import;
mod parsers;
mod reconciliation_rules;

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
        ("/bank-accounts", bank_accounts::router(state.clone(), gate)),
        (
            "/bank-transactions",
            bank_transactions::router(state.clone(), gate),
        ),
        (
            "/reconciliation-rules",
            reconciliation_rules::router(state.clone(), gate),
        ),
    ]
}
