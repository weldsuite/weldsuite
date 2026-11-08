//! WeldBooks' ledger: the `/api/<object>` routes of books-api's ledger
//! groups (`apps/workers/books-api/src/routes/`), on the shared rules of
//! `weldsuite-books-domain`. The other books areas are their own crates
//! (`weldsuite-books-*`); the plan is `PORTING.md` next to this crate.
//!
//! Paths, bodies, status codes, messages and entity events are the
//! TypeScript worker's; its tests run against this crate in the `books:
//! ledger` conformance suite (`rust/conformance/suites.json`).
//!
//! Every router goes through `legalEntityContext({ app: 'weldbooks', scoped:
//! true })` (books-api's `/api/*` middleware,
//! [`weldsuite_books_domain::entity_context::books_entity_context`]): the
//! request's legal entity, resolved against the member's per-entity access,
//! and their entity role swapped in. The accounting-entities list and create
//! skip it, so the switcher works whatever the current entity's role is. The
//! routers whose records sit under `/:id` answer 404 for a record of an
//! entity the request may not touch (`guardEntityRecords`).

mod accounting_dimensions;
mod accounting_entities;
mod accounting_settings;
mod entity_setup;
mod fiscal_periods;
mod fx_rates;
mod gl_accounts;
mod journal_entries;
mod tax_rates;

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use weldsuite_books_domain::entity_context::{books_entity_context, books_entity_context_options};
pub use weldsuite_books_domain::http::BooksState;
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable, legal_entity_context};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

/// books-api's skip: `GET` and `POST` exactly on the accounting-entities
/// collection (trailing slashes trimmed) run on workspace permissions. The
/// router sees its paths relative to `/accounting-entities`.
fn entity_collection(request: &Request) -> bool {
    (request.method() == http::Method::GET || request.method() == http::Method::POST)
        && request.uri().path().trim_end_matches('/').is_empty()
}

/// `guardEntityRecords(app, table, { label })`: a 404 for a route under
/// `/:id` whose record (`table.id`) belongs to an entity the request may not
/// touch. It runs before the routes' permission gates, as the TypeScript
/// middleware runs before the handlers' `requirePermission`.
fn guarded<S>(router: Router<S>, table: &'static str, label: &'static str) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.route_layer(EntityRecordGuard::table(EntityTable::new(table), label).layer())
}

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
    let entities = accounting_entities::router(state.clone(), gate).layer(legal_entity_context(
        gate,
        books_entity_context_options().skip(entity_collection),
    ));
    let scoped = |router: Router<S>| router.layer(books_entity_context(gate));
    vec![
        ("/accounting-entities", entities),
        (
            "/accounting-settings",
            scoped(accounting_settings::router(state.clone(), gate)),
        ),
        (
            "/accounting-dimensions",
            scoped(guarded(
                accounting_dimensions::router(state.clone(), gate),
                "accounting_dimension_values",
                "Dimension value",
            )),
        ),
        (
            "/fiscal-periods",
            scoped(guarded(
                fiscal_periods::router(state.clone(), gate),
                "fiscal_periods",
                "Fiscal period",
            )),
        ),
        ("/fx-rates", scoped(fx_rates::router(state.clone(), gate))),
        (
            "/gl-accounts",
            scoped(guarded(
                gl_accounts::router(state.clone(), gate),
                "accounts",
                "Account",
            )),
        ),
        (
            "/journal-entries",
            scoped(guarded(
                journal_entries::router(state.clone(), gate),
                "journal_entries",
                "Journal entry",
            )),
        ),
        (
            "/tax-rates",
            scoped(guarded(
                tax_rates::router(state.clone(), gate),
                "tax_rates",
                "Tax rate",
            )),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;

    fn request(method: &str, path: &str) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .body(Body::empty())
            .unwrap_or_default()
    }

    #[test]
    fn only_the_entity_list_and_create_skip_the_entity_context() {
        assert!(entity_collection(&request("GET", "/")));
        assert!(entity_collection(&request("POST", "/")));
        assert!(entity_collection(&request("GET", "//")));
        assert!(!entity_collection(&request("PATCH", "/")));
        assert!(!entity_collection(&request("GET", "/ent_1")));
        assert!(!entity_collection(&request("GET", "/jurisdictions")));
    }
}
