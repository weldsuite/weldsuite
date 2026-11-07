//! The WeldChat hooks (`services/chat/hooks.ts`), called from
//! [`crate::hooks`], which never lets a failure here fail the write that
//! caused it.
//!
//! Posts go through [`post_card_to_channels`] (author `app:weldmerge`, with
//! `metadata.weldmerge`), inside the request or webhook that caused them; the
//! channels are the subscriptions matching the event's team and repository
//! ([`channels_for`]). The daily digest is [`crate::chat::digest`].

use serde_json::{Value, json};
use weldsuite_db::js_row;

use crate::chat::post::post_card_to_channels;
use crate::chat::subscriptions::{EventScope, channels_for};
use crate::db::{Row, col, flag, opt_text, text};
use crate::hooks::HookContext;
use crate::{MergeError, PendingEvent};

/// A non-empty text column.
fn some_text(row: &Row, key: &str) -> Option<String> {
    opt_text(row, key).filter(|v| !v.is_empty())
}

/// `afterIssueCreated(ctx, issue, teamKey)`: `issue_created` cards.
pub(crate) async fn after_issue_created(
    ctx: &HookContext,
    issue: &Row,
    team_key: &str,
) -> Result<(), MergeError> {
    let scope = EventScope {
        team_id: some_text(issue, "teamId"),
        repository_id: None,
    };
    let channels = channels_for(&ctx.db, "issue_created", &scope).await?;
    if channels.is_empty() {
        return Ok(());
    }
    let content = format!(
        "Issue {team_key}-{} created: {}",
        col(issue, "number"),
        text(issue, "title")
    );
    post_card_to_channels(
        ctx,
        &channels,
        &content,
        &json!({ "kind": "issue_created", "issueId": text(issue, "id") }),
    )
    .await;
    Ok(())
}

/// `afterIssueUpdated(ctx, before, after, teamKey)`: `issue_done` when the
/// status turned done.
pub(crate) async fn after_issue_updated(
    ctx: &HookContext,
    before: &Row,
    after: &Row,
    team_key: &str,
) -> Result<(), MergeError> {
    if text(before, "status") == "done" || text(after, "status") != "done" {
        return Ok(());
    }
    let scope = EventScope {
        team_id: some_text(after, "teamId"),
        repository_id: None,
    };
    let channels = channels_for(&ctx.db, "issue_done", &scope).await?;
    if channels.is_empty() {
        return Ok(());
    }
    let content = format!(
        "Issue {team_key}-{} is done: {}",
        col(after, "number"),
        text(after, "title")
    );
    post_card_to_channels(
        ctx,
        &channels,
        &content,
        &json!({ "kind": "issue_done", "issueId": text(after, "id") }),
    )
    .await;
    Ok(())
}

/// `reviewerLogins(pr)`: the logins of the user reviewers a pull request asks for.
fn reviewer_logins(pr: Option<&Row>) -> Vec<String> {
    pr.and_then(|pr| pr.get("requestedReviewers"))
        .and_then(Value::as_array)
        .map(|reviewers| {
            reviewers
                .iter()
                .filter(|r| r.get("kind").and_then(Value::as_str) == Some("user"))
                .filter_map(|r| r.get("login").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `newReviewers(before, after)`: reviewers asked since the last copy (all of
/// them once a draft turns ready), for an open, non-draft pull request.
fn new_reviewers(before: Option<&Row>, after: &Row) -> Vec<String> {
    if text(after, "state") != "open" || flag(after, "draft") {
        return Vec::new();
    }
    let known: Vec<String> = match before {
        Some(before) if !flag(before, "draft") => reviewer_logins(Some(before)),
        _ => Vec::new(),
    };
    reviewer_logins(Some(after))
        .into_iter()
        .filter(|login| !known.contains(login))
        .collect()
}

/// `afterPullRequestSynced(ctx, before, after, events)`: `review_requested`,
/// `checks_failed`, `pull_request_merged`.
pub(crate) async fn after_pull_request_synced(
    ctx: &HookContext,
    before: Option<&Row>,
    after: &Row,
    events: &[PendingEvent],
) -> Result<(), MergeError> {
    let reviewers = new_reviewers(before, after);
    let checks_failed = text(after, "state") == "open"
        && opt_text(after, "checksStatus").as_deref() == Some("failure")
        && before.and_then(|b| opt_text(b, "checksStatus")).as_deref() != Some("failure");
    let merged = events
        .iter()
        .any(|e| e.entity_type == "merge_pull_request" && e.action == "merged");
    if reviewers.is_empty() && !checks_failed && !merged {
        return Ok(());
    }

    let repository: Option<Value> =
        sqlx::query_scalar("select to_jsonb(r) from merge_repositories r where r.id = $1 limit 1")
            .bind(text(after, "repositoryId"))
            .fetch_optional(&ctx.db)
            .await?;
    let repository = repository.map(js_row);
    let scope = EventScope {
        team_id: repository.as_ref().and_then(|r| some_text(r, "teamId")),
        repository_id: some_text(after, "repositoryId"),
    };
    let label = format!(
        "{}#{}",
        repository
            .as_ref()
            .map_or("pull request", |r| text(r, "fullName")),
        col(after, "number")
    );
    let id = text(after, "id");
    let title = text(after, "title");
    let url = text(after, "url");

    if !reviewers.is_empty() {
        let channels = channels_for(&ctx.db, "review_requested", &scope).await?;
        post_card_to_channels(
            ctx,
            &channels,
            &format!(
                "Review requested from {} on {label}: {title}\n{url}",
                reviewers.join(", ")
            ),
            &json!({ "kind": "review_requested", "pullRequestId": id, "itemKey": format!("review_requested:{id}") }),
        )
        .await;
    }
    if checks_failed {
        let channels = channels_for(&ctx.db, "checks_failed", &scope).await?;
        post_card_to_channels(
            ctx,
            &channels,
            &format!("Checks failed on {label}: {title}\n{url}"),
            &json!({ "kind": "checks_failed", "pullRequestId": id, "itemKey": format!("checks_failed:{id}") }),
        )
        .await;
    }
    if merged {
        let channels = channels_for(&ctx.db, "pull_request_merged", &scope).await?;
        post_card_to_channels(
            ctx,
            &channels,
            &format!("Merged {label}: {title}\n{url}"),
            &json!({ "kind": "pull_request_merged", "pullRequestId": id }),
        )
        .await;
    }
    Ok(())
}

/// `afterReleaseShipped(ctx, release, shipped)`: `shipped` is the payload of
/// the `merge_release.shipped` event.
pub(crate) async fn after_release_shipped(
    ctx: &HookContext,
    release: &Row,
    shipped: &Value,
) -> Result<(), MergeError> {
    let scope = EventScope {
        team_id: some_text(release, "teamId"),
        repository_id: some_text(release, "repositoryId"),
    };
    let channels = channels_for(&ctx.db, "release_shipped", &scope).await?;
    if channels.is_empty() {
        return Ok(());
    }
    let title = match some_text(release, "version") {
        Some(version) => format!("{} {version}", text(release, "name")),
        None => text(release, "name").to_owned(),
    };
    let count = shipped
        .get("pullRequestIds")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let plural = if count == 1 { "" } else { "s" };
    post_card_to_channels(
        ctx,
        &channels,
        &format!("Shipped {title}: {count} pull request{plural}"),
        &json!({ "kind": "release_shipped", "releaseId": text(release, "id") }),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_reviewers_are_those_asked_since_the_last_copy() {
        let pr = |draft: bool, logins: &[&str]| {
            json!({
                "state": "open",
                "draft": draft,
                "requestedReviewers": logins.iter().map(|l| json!({ "kind": "user", "login": l })).collect::<Vec<_>>(),
            })
        };
        assert_eq!(new_reviewers(None, &pr(false, &["a"])), ["a"]);
        assert_eq!(
            new_reviewers(Some(&pr(false, &["a"])), &pr(false, &["a", "b"])),
            ["b"]
        );
        // A draft turning ready asks everyone again.
        assert_eq!(
            new_reviewers(Some(&pr(true, &["a"])), &pr(false, &["a"])),
            ["a"]
        );
        assert_eq!(new_reviewers(None, &pr(true, &["a"])), Vec::<String>::new());
    }
}
