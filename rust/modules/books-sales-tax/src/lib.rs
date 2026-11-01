//! WeldBooks US sales tax: books-api's sales tax settings, agencies,
//! jurisdictions, taxability rules, zones, exemption certificates, reports,
//! nexus monitor, returns and tax calendar (`apps/workers/books-api/src/routes/`),
//! on the shared engine of `weldsuite_books_domain::sales_tax`. The plan is
//! `rust/modules/books/PORTING.md` (area 4).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! sales-tax` conformance suite (`rust/conformance/suites.json`).

mod agencies;
mod br_fiscal;
mod calendar;
mod certificates;
mod common;
mod jurisdictions;
mod nexus;
mod reports;
mod returns;
mod rules;
mod settings;
mod zones;

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
        (
            "/sales-tax",
            settings::router(state.clone(), gate)
                .merge(reports::router(state.clone(), gate))
                .merge(nexus::router(state.clone(), gate)),
        ),
        ("/sales-tax-agencies", agencies::router(state.clone(), gate)),
        (
            "/sales-tax-jurisdictions",
            jurisdictions::router(state.clone(), gate),
        ),
        ("/sales-tax-rules", rules::router(state.clone(), gate)),
        ("/sales-tax-zones", zones::router(state.clone(), gate)),
        ("/tax-calendar", calendar::router(state.clone(), gate)),
        ("/tax-returns", returns::router(state.clone(), gate)),
        (
            "/exemption-certificates",
            certificates::router(state.clone(), gate),
        ),
    ]
}
