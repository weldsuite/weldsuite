//! WeldBooks' purchases and payables: books-api's bills, accounting
//! contacts (customers and suppliers), the accounting document inbox, W-9
//! requests and the public W-9 form, and vendor payment runs, on the shared
//! rules of `weldsuite-books-domain` (`contacts`, `vendor_tax`). The plan is
//! `rust/modules/books/PORTING.md`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! purchases` conformance suite (`rust/conformance/suites.json`).

mod accounting_contacts;
mod accounting_documents;
mod bills;
mod ocr;
mod payment_runs;
mod public_w9;
mod w9_requests;

use std::sync::Arc;

use axum::Router;
use weldsuite_books_domain::http::BooksState;
use weldsuite_legal_entities::{LegalEntityApp, LegalEntityContextOptions, legal_entity_context};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub use public_w9::public_router;

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
    // Which legal entity the request is about, and per-entity access
    // (books-api's `legalEntityContext({ app: 'weldbooks', scoped: true })`
    // on `/api/*`): outside every route's gates and record guards.
    let context = legal_entity_context(
        gate,
        LegalEntityContextOptions::new()
            .app(LegalEntityApp::Weldbooks)
            .scoped(),
    );
    vec![
        (
            "/accounting-contacts",
            accounting_contacts::router(state.clone(), gate),
        ),
        (
            "/accounting-documents",
            accounting_documents::router(state.clone(), gate),
        ),
        ("/bills", bills::router(state.clone(), gate)),
        ("/payment-runs", payment_runs::router(state.clone(), gate)),
        ("/w9-requests", w9_requests::router(state.clone(), gate)),
    ]
    .into_iter()
    .map(|(prefix, router)| (prefix, router.layer(context.clone())))
    .collect()
}
