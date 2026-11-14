//! WeldBooks sales: books-api's invoices, credit notes, payments, recurring
//! invoices and invoice templates (`apps/workers/books-api/src/routes/`), on
//! the shared rules of `weldsuite-books-domain` (tax, posting, payments,
//! the printed invoice). The plan is `rust/modules/books/PORTING.md`.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! sales` conformance suite (`rust/conformance/suites.json`).

mod body;
mod credit_notes;
mod errors;
mod finalize;
mod invoices;
mod payments;
mod persist;
mod provider_sync;
mod recurring;
mod template_schema;
mod templates;

use std::sync::Arc;

use axum::Router;
pub use invoices::pdf::render_invoice_html_as_system;
pub use recurring::{SystemGenerateError, SystemGenerated, generate_recurring_invoice_as_system};
pub use weldsuite_books_domain::http::BooksState;
use weldsuite_legal_entities::{LegalEntityApp, LegalEntityContextOptions, legal_entity_context};
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
        ("/invoices", invoices::router(state.clone(), gate)),
        ("/payments", payments::router(state.clone(), gate)),
        (
            "/recurring-invoices",
            recurring::router(state.clone(), gate),
        ),
        ("/invoice-templates", templates::router(state.clone(), gate)),
    ]
    .into_iter()
    .map(|(prefix, router)| (prefix, router.layer(context.clone())))
    .collect()
}
