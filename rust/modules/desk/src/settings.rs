//! WeldDesk settings: helpdesk settings and widgets, help center settings and domains, the desk widget, desk assignment, helpdesk email addresses, helpdesk analytics.

use std::sync::Arc;

use axum::Router;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::DeskState;

/// The routes, relative to `/api`, each with its `requirePermission`.
pub(crate) fn routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
}
