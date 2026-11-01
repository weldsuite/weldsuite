//! WeldBooks VAT, GST and Brazil: books-api's VAT returns and ICP
//! declarations (the Netherlands), the GST worksheet (India), and Brazil's
//! apuração, SPED ECD, withholding suggestions and fiscal documents (Focus
//! NFe), on the shared rules of `weldsuite-books-domain`. The plan is
//! `rust/modules/books/PORTING.md` (area 6).
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! tax` conformance suite (`rust/conformance/suites.json`).

// The handlers mirror the worker's TypeScript functions one for one (the
// long ones too), its names (`periodStart` / `periodEnd`, `base` / `bases`)
// and its JavaScript comparisons (`===` on numbers); the docs name Dutch,
// Indian and Brazilian tax terms (NF-e, DANFE, XBRL) as words.
#![allow(
    clippy::too_many_lines,
    clippy::similar_names,
    clippy::doc_markdown,
    clippy::struct_field_names,
    clippy::type_complexity,
    clippy::single_match_else,
    clippy::items_after_statements,
    clippy::match_same_arms,
    clippy::float_cmp
)]

mod apuracao;
mod brazil;
mod ecd;
mod filing;
mod fiscal;
mod gst;
mod icp_declarations;
mod nl;
mod vat_returns;

use std::sync::Arc;

use axum::Router;
pub use weldsuite_books_domain::http::BooksState;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

/// Focus NFe's webhook (`/public/fiscal-webhooks/:token`), outside the
/// session: `workspaces` opens the tenant a token leads to.
pub use fiscal::webhooks::public_router;

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
        ("/br-tax", brazil::router(state.clone(), gate)),
        (
            "/fiscal-documents",
            fiscal::documents::router(state.clone(), gate),
        ),
        (
            "/received-fiscal-documents",
            fiscal::received::router(state.clone(), gate),
        ),
    ]
}
