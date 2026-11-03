//! `/public/project-portal`: the client portal API (FLOW-020), served without a
//! session (`routes/public-project-portal/index.ts`).
//!
//! Stub from the WeldFlow project-control foundation (slice H, client portal).
//! `public_router` (lib.rs) nests it at `/public/project-portal`, and the
//! server merges that into its pre-session routes (`flow_public` in
//! `rust/bins/weldsuite/src/routes/mod.rs`). The slice resolves the workspace
//! and the portal session itself, as the commerce portal does
//! (`rust/modules/commerce/src/portal_public.rs`), and adds the conformance
//! tenant layers there when it adds routes.

use axum::Router;

use crate::FlowState;

pub(crate) fn router<S>(_state: FlowState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
}
