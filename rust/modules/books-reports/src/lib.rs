//! WeldBooks reports and US compliance: books-api's accounting reports,
//! dashboard, XAF export, fixed assets, form 1099 and payroll imports
//! (`apps/workers/books-api/src/routes/`), on the shared rules of
//! `weldsuite-books-domain` (the report ledger in `reports_basis`, posting,
//! payroll). The plan is `rust/modules/books/PORTING.md`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! reports` conformance suite (`rust/conformance/suites.json`).

mod dashboard;
mod exports;
mod reports;

use std::sync::Arc;

use axum::Router;
pub use weldsuite_books_domain::http::BooksState;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

/// The routers, by `/api` prefix (`app.route(prefix, routes)` in
/// books-api's `src/index.ts`).
pub fn routers<S, Q>(
    state: &BooksState,
    gate: &Arc<PermissionGate<Q>>,
) -> Vec<(&'static str, Router<S>)>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    vec![
        ("/accounting-reports", reports::router(state.clone(), gate)),
        (
            "/accounting-dashboard",
            dashboard::router(state.clone(), gate),
        ),
        ("/accounting-exports", exports::router(state.clone(), gate)),
    ]
}
