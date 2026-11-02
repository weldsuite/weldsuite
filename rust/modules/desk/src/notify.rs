//! `lib/notify.ts`: "assigned to you", in the background
//! (`executionCtx.waitUntil`), so a notification never slows down or fails
//! the response that caused it.

use weldsuite_desk_domain::notify::{EntityKind, HelpdeskNotification, ticket_assigned};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};

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
            Ok(Some(notification)) => deliver(&db, &state, &workspace, &notification).await,
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "[desk-api/notify] assignment notification failed");
            }
        }
    });
}

/// `createAndDeliverNotification` (`@weldsuite/notifications`): the in-app
/// row, its realtime publish, and email/push as the member's preferences
/// say. A failure is logged, as the worker's `.catch` does.
async fn deliver(
    db: &weldsuite_db::PgPool,
    state: &DeskState,
    workspace: &str,
    notification: &HelpdeskNotification,
) {
    let notifier = Notifier {
        realtime: state.realtime.clone(),
        presence: None,
        mail: state.mail.clone(),
        http: None,
        apns: None,
    };
    let data = notification
        .data
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let params = NewNotification {
        workspace_id: workspace.to_owned(),
        user_id: notification.user_id.clone(),
        title: notification.title.clone(),
        body: notification.body.clone(),
        category: notification.category.to_owned(),
        notification_type: notification.notification_type.to_owned(),
        entity_type: notification.entity_type.to_owned(),
        entity_id: notification.entity_id.clone(),
        action_url: notification.action_url.clone(),
        severity: notification.severity.to_owned(),
        actor_type: Some(notification.actor_type.to_owned()),
        actor_id: notification.actor_id.clone(),
        data,
        ..NewNotification::default()
    };
    if let Err(error) = create_and_deliver(db, &notifier, &params).await {
        tracing::error!(%error, "[desk-api/notify] assignment notification failed");
    }
}
