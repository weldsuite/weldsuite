//! WeldBooks VAT, GST and Brazil: books-api's VAT returns and ICP
//! declarations (the Netherlands), the GST worksheet (India), and Brazil's
//! apuração, SPED ECD, withholding suggestions and fiscal documents (Focus
//! NFe), on the shared rules of `weldsuite-books-domain`. The plan is
//! `rust/modules/books/PORTING.md` (area 6).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! tax` conformance suite (`rust/conformance/suites.json`).

mod apuracao;
mod filing;
mod gst;
mod icp_declarations;
mod nl;
mod vat_returns;

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
        ("/vat-returns", vat_returns::router(state.clone(), gate)),
        (
            "/icp-declarations",
            icp_declarations::router(state.clone(), gate),
        ),
    ]
}
