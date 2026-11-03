//! `/api/project-stakeholders`: the stakeholder register and the RACI.
//!
//! Stub from the WeldFlow project-control foundation (slice D, reporting): the router is
//! mounted in `routers()` (lib.rs) and the prefix is registered in
//! `@weldsuite/api-modules`, so the slice only fills this file in. The
//! TypeScript worker's router is `apps/workers/flow-api/src/routes/project-stakeholders/index.ts`;
//! paths, bodies, messages and entity events are its, and the routes go in
//! `rust/conformance/suites.json` with it.

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::FlowState;

pub(crate) fn router<S, Q>(_state: FlowState, _gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
}
