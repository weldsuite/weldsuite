//! Task notifications (`@weldsuite/notifications`, as flow-api sends them):
//! the assignees a task gains (`dispatchAssignmentNotifications` with
//! `sendTaskAssignmentNotification`) and the people a comment concerns
//! (`services/task-comment-notifications.ts`). Both run after the response,
//! on the event tracker, and a failure is only logged.
//!
//! The assignment email's richer template (`task.assigned`) is not sent:
//! `weldsuite_notifications` does not send notification email yet.

use std::collections::HashSet;

use sqlx::PgPool;
use weldsuite_flow_domain::access::resolve_project_access;
use weldsuite_flow_domain::js::slice_utf16;
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};

use crate::{Caller, FlowState};

/// What a background notification needs from the request.
struct Context {
    db: PgPool,
    notifier: Notifier,
    /// `c.get('clerkOrgId')`: the realtime hub notifications go to.
    org_id: String,
    actor_id: String,
}

impl Context {
    fn of(state: &FlowState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            notifier: caller.notifier(state),
            org_id: caller.clerk_org_id.clone().unwrap_or_default(),
            actor_id: caller.user_id.clone(),
        }
    }
}

/// `opts.projectId ? 'projects' : 'crm'` and the link the notification opens.
fn task_target(task_id: &str, project_id: Option<&str>) -> (&'static str, String) {
    match project_id.filter(|p| !p.is_empty()) {
        Some(_) => ("projects", format!("/weldflow/task/{task_id}")),
        None => ("crm", "/weldcrm/tasks".to_owned()),
    }
}

/// `{ taskId, ...(projectId ? { projectId } : {}) }` plus the extra keys.
fn push_data(task_id: &str, extra: &[(&str, &str)], project_id: Option<&str>) -> Vec<(String, String)> {
    let mut data = vec![("taskId".to_owned(), task_id.to_owned())];
    data.extend(extra.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
    if let Some(project) = project_id.filter(|p| !p.is_empty()) {
        data.push(("projectId".to_owned(), project.to_owned()));
    }
    data
}

/// A workspace member's display name, if set.
async fn member_name(db: &PgPool, user_id: &str) -> Result<Option<String>, sqlx::Error> {
    let name: Option<Option<String>> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(name.flatten())
}

// ── Assignment ──────────────────────────────────────────────────────────────

/// A task's assignees to tell (`dispatchAssignmentNotifications`).
pub(crate) struct Assignment {
    pub(crate) assignee_ids: Vec<String>,
    pub(crate) task_id: String,
    pub(crate) task_title: String,
    pub(crate) project_id: Option<String>,
}

/// `dispatchAssignmentNotifications(c, opts)`: one notification per
/// assignee, none for the one who assigned.
pub(crate) fn assignment(state: &FlowState, caller: &Caller, assignment: Assignment) {
    if assignment.assignee_ids.is_empty() {
        return;
    }
    let context = Context::of(state, caller);
    state.events.tracker().spawn(async move {
        for assignee in &assignment.assignee_ids {
            if let Err(error) = send_assignment(&context, &assignment, assignee).await {
                tracing::error!(%error, "[app-api/tasks] assignment notification failed");
            }
        }
    });
}

/// `sendTaskAssignmentNotification`.
async fn send_assignment(
    context: &Context,
    assignment: &Assignment,
    assignee: &str,
) -> Result<(), sqlx::Error> {
    if assignee == context.actor_id {
        return Ok(());
    }
    let assigner = match member_name(&context.db, &context.actor_id).await {
        Ok(name) => name.filter(|n| !n.is_empty()),
        Err(error) => {
            tracing::error!(%error, "[Notifications] Failed to resolve assigner name");
            None
        }
    }
    .unwrap_or_else(|| "Someone".to_owned());
    let (category, action_url) =
        task_target(&assignment.task_id, assignment.project_id.as_deref());
    let params = NewNotification {
        workspace_id: context.org_id.clone(),
        clerk_org_id: None,
        user_id: assignee.to_owned(),
        title: "Task assigned to you".to_owned(),
        body: format!("{assigner} assigned \"{}\" to you", assignment.task_title),
        category: category.to_owned(),
        notification_type: "task_assigned".to_owned(),
        entity_type: "task".to_owned(),
        entity_id: assignment.task_id.clone(),
        action_url,
        severity: "info".to_owned(),
        actor_type: Some("user".to_owned()),
        actor_id: Some(context.actor_id.clone()),
        data: push_data(&assignment.task_id, &[], assignment.project_id.as_deref()),
        ..NewNotification::default()
    };
    create_and_deliver(&context.db, &context.notifier, &params).await?;
    Ok(())
}

// ── Comments ────────────────────────────────────────────────────────────────

/// `extractMentionedUserIds`: the ids of `<@userId>` tokens, once each, in
/// order of appearance.
pub(crate) fn mentioned_user_ids(content: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("<@") {
        let after = &rest[start + 2..];
        let end = after
            .char_indices()
            .find(|(_, ch)| *ch == '>' || ch.is_whitespace())
            .map(|(at, ch)| (at, ch == '>'));
        match end {
            Some((at, true)) if at > 0 => {
                let id = &after[..at];
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_owned());
                }
                rest = &after[at + 1..];
            }
            _ => rest = after,
        }
    }
    ids
}

/// `taskCommentRecipients`: a mentioned watcher gets the mention only, and
/// the author neither.
fn comment_recipients(
    author: &str,
    mentioned: Vec<String>,
    watchers: Vec<String>,
) -> (Vec<String>, Vec<String>) {
    let mut seen = HashSet::new();
    let mentioned: Vec<String> = mentioned
        .into_iter()
        .filter(|id| !id.is_empty() && id != author && seen.insert(id.clone()))
        .collect();
    let mut seen_watchers = HashSet::new();
    let watchers = watchers
        .into_iter()
        .filter(|id| {
            !id.is_empty()
                && id != author
                && !mentioned.contains(id)
                && seen_watchers.insert(id.clone())
        })
        .collect();
    (mentioned, watchers)
}

/// A new comment (`notifyTaskComment`).
pub(crate) struct Comment {
    pub(crate) comment_id: String,
    pub(crate) task_id: String,
    pub(crate) content: String,
}

/// `notifyTaskComment(...)` in `waitUntil`.
pub(crate) fn comment(state: &FlowState, caller: &Caller, comment: Comment) {
    let context = Context::of(state, caller);
    state.events.tracker().spawn(async move {
        if let Err(error) = notify_comment(&context, &comment).await {
            tracing::error!(%error, "[app-api/task-comments] comment notification failed");
        }
    });
}

type CommentTask = (String, Option<String>, Option<String>, Option<Vec<String>>, Option<String>);

/// Mentioned ids that are active members and may read the task's project
/// (`mentionableUserIds`).
async fn mentionable(
    db: &PgPool,
    user_ids: &[String],
    project_id: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let active: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = any($1) and upper(status) = 'ACTIVE'",
    )
    .bind(user_ids)
    .fetch_all(db)
    .await?;
    let Some(project_id) = project_id else {
        return Ok(active);
    };
    let mut readers = Vec::with_capacity(active.len());
    for user in active {
        if resolve_project_access(db, Some(&user), false, project_id)
            .await?
            .can_read
        {
            readers.push(user);
        }
    }
    Ok(readers)
}

async fn notify_comment(context: &Context, comment: &Comment) -> Result<(), sqlx::Error> {
    let db = &context.db;
    let task: Option<CommentTask> = sqlx::query_as(
        "select title, project_id, assignee_id, assignee_ids, reporter_id from tasks
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(&comment.task_id)
    .fetch_optional(db)
    .await?;
    let Some((title, project_id, assignee_id, assignee_ids, reporter_id)) = task else {
        return Ok(());
    };
    let project_id = project_id.filter(|p| !p.is_empty());
    let watchers: Vec<String> = assignee_id
        .into_iter()
        .chain(assignee_ids.unwrap_or_default())
        .chain(reporter_id)
        .filter(|id| !id.is_empty())
        .collect();
    let candidates: Vec<String> = mentioned_user_ids(&comment.content)
        .into_iter()
        .filter(|id| *id != context.actor_id)
        .collect();
    let mentioned = mentionable(db, &candidates, project_id.as_deref()).await?;
    let (mentioned, watchers) = comment_recipients(&context.actor_id, mentioned, watchers);
    if mentioned.is_empty() && watchers.is_empty() {
        return Ok(());
    }
    let author = member_name(db, &context.actor_id)
        .await?
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Someone".to_owned());
    let (category, action_url) = task_target(&comment.task_id, project_id.as_deref());
    // `content.replace(/\s+/g, ' ').trim().slice(0, 180)`.
    let collapsed = comment
        .content
        .split(char::is_whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let preview = slice_utf16(&collapsed, 180);
    let recipients = mentioned
        .iter()
        .map(|id| (id, true))
        .chain(watchers.iter().map(|id| (id, false)));
    for (recipient, mention) in recipients {
        let title = if mention {
            format!("{author} mentioned you on \"{title}\"")
        } else {
            format!("{author} commented on \"{title}\"")
        };
        let params = NewNotification {
            workspace_id: context.org_id.clone(),
            clerk_org_id: None,
            user_id: recipient.clone(),
            title: slice_utf16(&title, 255),
            body: preview.clone(),
            category: category.to_owned(),
            notification_type: if mention { "mention" } else { "task_comment" }.to_owned(),
            entity_type: "task".to_owned(),
            entity_id: comment.task_id.clone(),
            action_url: action_url.clone(),
            severity: "info".to_owned(),
            actor_type: Some("user".to_owned()),
            actor_id: Some(context.actor_id.clone()),
            data: push_data(
                &comment.task_id,
                &[("commentId", comment.comment_id.as_str())],
                project_id.as_deref(),
            ),
            ..NewNotification::default()
        };
        if let Err(error) = create_and_deliver(db, &context.notifier, &params).await {
            tracing::error!(%error, "[Notifications] task comment notification failed");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_read_like_the_regex() {
        assert_eq!(
            mentioned_user_ids("hi <@u1> and <@u2>, again <@u1> <@ bad> <@> <@u3"),
            vec!["u1".to_owned(), "u2".to_owned()]
        );
    }

    #[test]
    fn a_mentioned_watcher_gets_the_mention_only() {
        let (mentioned, watchers) = comment_recipients(
            "me",
            vec!["a".into(), "me".into(), "a".into()],
            vec!["a".into(), "b".into(), "me".into(), "b".into(), String::new()],
        );
        assert_eq!(mentioned, vec!["a".to_owned()]);
        assert_eq!(watchers, vec!["b".to_owned()]);
    }
}
