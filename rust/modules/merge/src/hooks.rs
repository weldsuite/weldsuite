//! Hook points (`services/hooks.ts`): what happens in other WeldSuite
//! surfaces when a WeldMerge row changes. Services and routes call these
//! after the write; each fans out to the area modules:
//!
//! ```text
//!   issue_sync::hooks  pushes issue and comment changes to GitHub / GitLab
//!   chat::hooks        posts to subscribed WeldChat channels
//! ```
//!
//! A hook runs inside the request or webhook that caused it (so conformance
//! sees its outbound calls) and never fails the write that triggered it: a
//! failing area is logged and the caller carries on.

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_events::EventContext;

use crate::db::Row;
use crate::{MergeError, MergeState, Overrides, PendingEvent, chat, issue_sync};

/// What a hook needs to act (`HookContext`): the tenant database, the
/// module's state and the request's overrides (the worker env, HTTP, master
/// database, cache), and who and where the change happened.
#[derive(Clone)]
pub(crate) struct HookContext {
    pub(crate) db: PgPool,
    pub(crate) state: MergeState,
    pub(crate) overrides: Overrides,
    /// The member who made the change; `system` for sync and automation.
    pub(crate) user_id: String,
    /// `workspaces.id` (ws_…).
    pub(crate) workspace_id: String,
    /// The Clerk org id, for the stores still keyed by it.
    pub(crate) clerk_org_id: Option<String>,
    /// The event context of the change (the request's, or the system's for
    /// sync), for hooks that publish.
    #[allow(dead_code)]
    pub(crate) events: EventContext,
}

/// `CommentChange`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommentChange {
    Created,
    Updated,
    Deleted,
}

/// `run(name, work)`: a failing area is logged, never thrown.
fn logged(name: &str, result: Result<(), MergeError>) {
    if let Err(error) = result {
        tracing::error!(hook = name, ?error, "merge: a hook failed");
    }
}

/// `afterIssueCreated(ctx, issue, teamKey)`.
pub(crate) async fn after_issue_created(ctx: &HookContext, issue: &Row, team_key: &str) {
    logged(
        "issueSync.afterIssueCreated",
        issue_sync::hooks::after_issue_created(ctx, issue, team_key).await,
    );
    logged(
        "chat.afterIssueCreated",
        chat::hooks::after_issue_created(ctx, issue, team_key).await,
    );
}

/// `afterIssueUpdated(ctx, before, after, teamKey)`: `before` and `after` are
/// the rows around the change (a member's edit, or a pull request moving the
/// issue).
pub(crate) async fn after_issue_updated(
    ctx: &HookContext,
    before: &Row,
    after: &Row,
    team_key: &str,
) {
    logged(
        "issueSync.afterIssueUpdated",
        issue_sync::hooks::after_issue_updated(ctx, before, after, team_key).await,
    );
    logged(
        "chat.afterIssueUpdated",
        chat::hooks::after_issue_updated(ctx, before, after, team_key).await,
    );
}

/// `afterCommentChanged(ctx, change, comment, issue, teamKey)`.
pub(crate) async fn after_comment_changed(
    ctx: &HookContext,
    change: CommentChange,
    comment: &Row,
    issue: &Row,
    team_key: &str,
) {
    logged(
        "issueSync.afterCommentChanged",
        issue_sync::hooks::after_comment_changed(ctx, change, comment, issue, team_key).await,
    );
}

/// `afterPullRequestSynced(ctx, before, after, events)`: after sync wrote a
/// pull request (a webhook, never a backfill). `before` is `None` for a new
/// pull request; `events` are the entity events the write produced.
pub(crate) async fn after_pull_request_synced(
    ctx: &HookContext,
    before: Option<&Row>,
    after: &Row,
    events: &[PendingEvent],
) {
    logged(
        "chat.afterPullRequestSynced",
        chat::hooks::after_pull_request_synced(ctx, before, after, events).await,
    );
}

/// `afterReleaseShipped(ctx, release, shipped)`: `shipped` is the payload of
/// the `merge_release.shipped` event.
#[allow(dead_code)]
pub(crate) async fn after_release_shipped(ctx: &HookContext, release: &Row, shipped: &Value) {
    logged(
        "chat.afterReleaseShipped",
        chat::hooks::after_release_shipped(ctx, release, shipped).await,
    );
}
