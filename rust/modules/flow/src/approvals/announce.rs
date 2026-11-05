//! What asking for, cancelling and answering approvals tells the world
//! (`services/approvals.ts`): `flow_approval` entity events, the
//! notifications to approvers, the `approval_due` due-index mark, and the
//! aftermath hooks a subject uses to publish its own events once an answer
//! settles it.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{OnceLock, RwLock};

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, FLOW_APPROVAL_CANCELLED, FLOW_APPROVAL_DECIDED, FLOW_APPROVAL_REQUESTED,
};
use weldsuite_flow_domain::approval_views::approval_event_data;
use weldsuite_flow_domain::approvals::{
    ApprovalActor, ApprovalRow, ResolvedApprovalOutcome, is_step_active,
};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};

use crate::{Caller, FlowState};

/// The kind of `flow_approval` event.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ApprovalAction {
    Requested,
    Decided,
    Cancelled,
}

impl ApprovalAction {
    pub(crate) const fn event(self) -> EventName {
        match self {
            Self::Requested => FLOW_APPROVAL_REQUESTED,
            Self::Decided => FLOW_APPROVAL_DECIDED,
            Self::Cancelled => FLOW_APPROVAL_CANCELLED,
        }
    }
}

/// `publishApproval(c, action, row, extra)`.
pub(crate) fn publish_approval(
    state: &FlowState,
    caller: &Caller,
    action: ApprovalAction,
    row: &ApprovalRow,
    extra: &Value,
) {
    let mut data = approval_event_data(row);
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra.clone());
    }
    caller.publish(state, action.event(), &row.id, &data);
}

/// What a notification says the review is about (`ApprovalSubjectLabel`).
#[derive(Debug, Clone)]
pub(crate) struct SubjectLabel {
    pub(crate) code: Option<String>,
    pub(crate) title: String,
}

fn label_text(label: &SubjectLabel) -> String {
    let text = match &label.code {
        Some(code) => format!("{code} {}", label.title),
        None => label.title.clone(),
    };
    if weldsuite_flow_domain::js::utf16_len(&text) > 200 {
        format!("{}…", weldsuite_flow_domain::js::slice_utf16(&text, 199))
    } else {
        text
    }
}

/// Where a notification goes out from (`NotifyBase`).
#[derive(Clone)]
pub(crate) struct NotifyBase {
    pub(crate) db: PgPool,
    pub(crate) notifier: Notifier,
    /// The Clerk org id: the realtime hub and the links use it.
    pub(crate) org_id: String,
}

impl NotifyBase {
    pub(crate) fn of(state: &FlowState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            notifier: caller.notifier(state),
            org_id: caller.clerk_org_id.clone().unwrap_or_default(),
        }
    }
}

/// `'requested' | 'reminder' | 'overdue'`.
#[derive(Debug, Clone, Copy)]
pub(crate) enum NoticeKind {
    Requested,
    Reminder,
    Overdue,
}

/// `sendApprovalNotification(base, input)`: best effort, a failure is logged.
pub(crate) async fn send_approval_notification(
    base: &NotifyBase,
    user_id: &str,
    approval_id: &str,
    kind: NoticeKind,
    label: &SubjectLabel,
    actor_id: Option<&str>,
    project_name: Option<&str>,
) {
    let text = label_text(label);
    let place = project_name.map(|p| format!(" in {p}")).unwrap_or_default();
    let (title, body, severity) = match kind {
        NoticeKind::Requested => (
            format!("Review requested: {text}"),
            format!("Your review is needed on {text}{place}."),
            "info",
        ),
        NoticeKind::Reminder => (
            format!("Review due tomorrow: {text}"),
            format!("{text}{place} is due for your review tomorrow."),
            "warning",
        ),
        NoticeKind::Overdue => (
            format!("Review overdue: {text}"),
            format!("{text}{place} is still waiting for a review."),
            "warning",
        ),
    };
    let params = NewNotification {
        workspace_id: base.org_id.clone(),
        clerk_org_id: Some(base.org_id.clone()).filter(|id| !id.is_empty()),
        user_id: user_id.to_owned(),
        title: weldsuite_flow_domain::js::slice_utf16(&title, 255),
        body,
        category: "projects".to_owned(),
        notification_type: "project_updated".to_owned(),
        entity_type: "flow_approval".to_owned(),
        entity_id: approval_id.to_owned(),
        action_url: "/weldflow/reviews".to_owned(),
        severity: severity.to_owned(),
        actor_type: Some(if actor_id.is_some() { "user" } else { "system" }.to_owned()),
        actor_id: actor_id.map(str::to_owned),
        ..NewNotification::default()
    };
    if let Err(error) = create_and_deliver(&base.db, &base.notifier, &params).await {
        tracing::error!(%error, "[flow-api/approvals] notification failed");
    }
}

const DAY_MS: i64 = 86_400_000;

/// Notify the member approvers of `rows` (never the requester), in the background.
fn notify_approvers(
    state: &FlowState,
    caller: &Caller,
    rows: &[ApprovalRow],
    label: &SubjectLabel,
    project_name: Option<&str>,
) {
    let targets: Vec<(String, String)> = rows
        .iter()
        .filter(|row| row.approver_kind == "member" && row.approver_id != caller.user_id)
        .map(|row| (row.approver_id.clone(), row.id.clone()))
        .collect();
    if targets.is_empty() {
        return;
    }
    let base = NotifyBase::of(state, caller);
    let (label, actor, project) = (
        label.clone(),
        caller.user_id.clone(),
        project_name.map(str::to_owned),
    );
    state.events.tracker().spawn(async move {
        for (user, approval) in targets {
            send_approval_notification(
                &base,
                &user,
                &approval,
                NoticeKind::Requested,
                &label,
                Some(&actor),
                project.as_deref(),
            )
            .await;
        }
    });
}

/// `markReminderDue(c, rows)`: the workspace is looked at a day before the earliest due date.
pub(crate) fn mark_reminder_due(state: &FlowState, caller: &Caller, rows: &[ApprovalRow]) {
    let Some(first) = rows
        .iter()
        .filter_map(|row| row.due_at)
        .map(|due| due - DAY_MS)
        .min()
    else {
        return;
    };
    let Some(master) = caller.master(state) else {
        return;
    };
    let Ok(at) = OffsetDateTime::from_unix_timestamp_nanos(i128::from(first) * 1_000_000) else {
        return;
    };
    let workspace = caller.workspace_id.clone();
    state.events.tracker().spawn(async move {
        weldsuite_db::due_index::mark_due(&master, "approval_due", &workspace, at).await;
    });
}

/// `announceApprovalsRequested`: call after `request_approvals`. Publishes
/// `flow_approval.requested` for each row, notifies the approvers who can
/// answer now (the lowest step) and marks the workspace for the reminders.
pub(crate) fn announce_approvals_requested(
    state: &FlowState,
    caller: &Caller,
    rows: &[ApprovalRow],
    subject: &SubjectLabel,
    project_name: Option<&str>,
) {
    for row in rows {
        publish_approval(state, caller, ApprovalAction::Requested, row, &json!({}));
    }
    let Some(first_step) = rows.iter().map(|row| row.step).min() else {
        return;
    };
    let first: Vec<ApprovalRow> = rows
        .iter()
        .filter(|row| row.step == first_step)
        .cloned()
        .collect();
    notify_approvers(state, caller, &first, subject, project_name);
    mark_reminder_due(state, caller, rows);
}

/// `announceApprovalsCancelled`: call after `cancel_pending_approvals`.
pub(crate) fn announce_approvals_cancelled(
    state: &FlowState,
    caller: &Caller,
    rows: &[ApprovalRow],
) {
    for row in rows {
        publish_approval(state, caller, ApprovalAction::Cancelled, row, &json!({}));
    }
}

/// `announceStepsActivated`: tell the approvers whose step has just come up.
pub(crate) fn announce_steps_activated(
    state: &FlowState,
    caller: &Caller,
    before: &[ApprovalRow],
    after: &[ApprovalRow],
    label: &SubjectLabel,
    project_name: Option<&str>,
) {
    let newly: Vec<ApprovalRow> = after
        .iter()
        .filter(|row| {
            row.decision == "pending" && is_step_active(row, after) && !is_step_active(row, before)
        })
        .cloned()
        .collect();
    if !newly.is_empty() {
        notify_approvers(state, caller, &newly, label, project_name);
    }
}

// ── Aftermath hooks ─────────────────────────────────────────────────────────

/// What an aftermath hook is told when `POST /api/approvals/:id/decide`
/// settled a subject (`ApprovalAftermathInfo`).
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct AftermathInfo {
    pub(crate) subject_id: String,
    pub(crate) project_id: Option<String>,
    pub(crate) outcome: ResolvedApprovalOutcome,
    /// The subject's live rows after the answer.
    pub(crate) rows: Vec<ApprovalRow>,
    /// The answer that settled it.
    pub(crate) decided: ApprovalRow,
    pub(crate) actor: ApprovalActor,
}

pub(crate) type AftermathFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>>;

/// A hook: publish the subject's own entity events (and anything else that needs the request).
pub(crate) type Aftermath =
    for<'a> fn(&'a FlowState, &'a Caller, &'a AftermathInfo) -> AftermathFuture<'a>;

fn aftermaths() -> &'static RwLock<HashMap<&'static str, Aftermath>> {
    static HOOKS: OnceLock<RwLock<HashMap<&'static str, Aftermath>>> = OnceLock::new();
    HOOKS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// `registerApprovalAftermath(type, hook)`: one hook per type; the router
/// that registers may be built twice (tests), so a second call replaces it.
pub(crate) fn register_aftermath(subject_type: &'static str, hook: Aftermath) {
    aftermaths()
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(subject_type, hook);
}

/// `runApprovalAftermath(c, type, info)`: a failure is logged, the answer is already stored.
pub(crate) async fn run_aftermath(
    state: &FlowState,
    caller: &Caller,
    subject_type: &str,
    info: &AftermathInfo,
) {
    let hook = aftermaths()
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(subject_type)
        .copied();
    if let Some(hook) = hook
        && let Err(error) = hook(state, caller, info).await
    {
        tracing::error!(%error, subject_type, "[flow-api/approvals] aftermath failed");
    }
}
