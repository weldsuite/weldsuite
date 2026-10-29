//! `lib/notify.ts`: "assigned to you", in the background
//! (`executionCtx.waitUntil`), so a notification never slows down or fails
//! the response that caused it.

use weldsuite_desk_domain::notify::{EntityKind, HelpdeskNotification, ticket_assigned};

use crate::{Caller, DeskState};

/// `notifyAssigned(c, params)`.
pub(crate) struct Assigned {
    /// The new assignee; none (an unassign) sends nothing.
    pub(crate) assignee_id: Option<String>,
    /// The assignee before the change; an unchanged assignee sends nothing.
    pub(crate) previous: Option<String>,
    pub(crate) kind: EntityKind,
    pub(crate) entity_id: String,
    pub(crate) subject: Option<String>,
    pub(crate) reference: Option<String>,
    /// Who made the change; `None` for the system.
    pub(crate) by: Option<String>,
}

/// `notifyAssigned`: nothing without an assignee or when it did not change.
pub(crate) fn assigned(state: &DeskState, caller: &Caller, params: Assigned) {
    let Some(assignee) = params.assignee_id.filter(|a| !a.is_empty()) else {
        return;
    };
    if Some(&assignee) == params.previous.as_ref() {
        return;
    }
    let db = caller.db.clone();
    let workspace = caller.clerk_org_id.clone();
    let state = state.clone();
    state.events.tracker().clone().spawn(async move {
        let notification = ticket_assigned(
            &db,
            &assignee,
            params.by.as_deref(),
            params.kind,
            &params.entity_id,
            params.subject.as_deref(),
            params.reference.as_deref(),
        )
        .await;
        match notification {
            Ok(Some(notification)) => deliver(&state, &workspace, &notification),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "[desk-api/notify] assignment notification failed");
            }
        }
    });
}

/// `createAndDeliverNotification`: the shared notifications crate, once it
/// is on this branch (see the crate docs). Until then the notification is
/// logged and dropped.
fn deliver(_state: &DeskState, workspace: &str, notification: &HelpdeskNotification) {
    tracing::warn!(
        workspace,
        user = %notification.user_id,
        kind = notification.notification_type,
        "[desk-api/notify] notification delivery is not wired yet"
    );
}
