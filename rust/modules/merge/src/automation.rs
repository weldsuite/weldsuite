//! How a linked pull request moves an issue (`@weldsuite/merge-domain/automation`,
//! design/modules/weldmerge.md, "A pull request changes on GitHub").
//!
//! Rules run only when something changed for the link: the pull request
//! moved to another phase, or the link is new. A member who moves an issue
//! back while the pull request stays open is not overridden by the next push.
//!
//! - draft opened                → `in_progress` from `backlog` or `todo`
//! - ready for review            → `in_review` from `backlog`, `todo` or `in_progress`
//! - merged, and the link closes → `done`
//! - closed without merging      → no change
//!
//! An issue in `done` or `canceled` never moves.

/// Where a pull request stands, for the rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestPhase {
    Draft,
    Ready,
    Merged,
    Closed,
}

/// `pullRequestPhase({ state, draft })`.
pub fn pull_request_phase(state: &str, draft: bool) -> PullRequestPhase {
    match state {
        "merged" => PullRequestPhase::Merged,
        "closed" => PullRequestPhase::Closed,
        _ if draft => PullRequestPhase::Draft,
        _ => PullRequestPhase::Ready,
    }
}

/// `shouldEvaluateLink(previous, next, linkIsNew)`.
pub fn should_evaluate_link(
    previous: Option<PullRequestPhase>,
    next: PullRequestPhase,
    link_is_new: bool,
) -> bool {
    link_is_new || previous != Some(next)
}

fn rank(status: &str) -> u8 {
    match status {
        "todo" => 1,
        "in_progress" => 2,
        "in_review" => 3,
        "done" | "canceled" => 4,
        // backlog
        _ => 0,
    }
}

/// `issueStatusForPullRequest(current, phase, closes)`: the status the
/// issue moves to, or `None` to leave it.
pub fn issue_status_for_pull_request(
    current: &str,
    phase: PullRequestPhase,
    closes: bool,
) -> Option<&'static str> {
    if current == "done" || current == "canceled" {
        return None;
    }
    match phase {
        PullRequestPhase::Draft => (rank(current) < rank("in_progress")).then_some("in_progress"),
        PullRequestPhase::Ready => (rank(current) < rank("in_review")).then_some("in_review"),
        PullRequestPhase::Merged => closes.then_some("done"),
        PullRequestPhase::Closed => None,
    }
}

/// An issue's status timestamps, as ISO strings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusTimestamps {
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub canceled_at: Option<String>,
}

/// `statusTimestamps(next, existing, now)`: `started_at` is set the first
/// time work starts and kept; `completed_at` and `canceled_at` hold only
/// while the issue is in that status.
pub fn status_timestamps(next: &str, existing: &StatusTimestamps, now: &str) -> StatusTimestamps {
    let started = rank(next) >= rank("in_progress") && next != "canceled";
    StatusTimestamps {
        started_at: existing
            .started_at
            .clone()
            .or_else(|| started.then(|| now.to_owned())),
        completed_at: (next == "done").then(|| {
            existing
                .completed_at
                .clone()
                .unwrap_or_else(|| now.to_owned())
        }),
        canceled_at: (next == "canceled").then(|| {
            existing
                .canceled_at
                .clone()
                .unwrap_or_else(|| now.to_owned())
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_state_and_draft() {
        assert_eq!(pull_request_phase("open", true), PullRequestPhase::Draft);
        assert_eq!(pull_request_phase("open", false), PullRequestPhase::Ready);
        assert_eq!(
            pull_request_phase("merged", false),
            PullRequestPhase::Merged
        );
        assert_eq!(pull_request_phase("closed", true), PullRequestPhase::Closed);
    }

    #[test]
    fn runs_on_a_phase_change_or_a_new_link_only() {
        use PullRequestPhase::{Draft, Ready};
        assert!(should_evaluate_link(None, Ready, false));
        assert!(!should_evaluate_link(Some(Ready), Ready, false));
        assert!(should_evaluate_link(Some(Ready), Ready, true));
        assert!(should_evaluate_link(Some(Draft), Ready, false));
    }

    #[test]
    fn moves_forward_only() {
        use PullRequestPhase::{Draft, Ready};
        assert_eq!(
            issue_status_for_pull_request("backlog", Draft, true),
            Some("in_progress")
        );
        assert_eq!(
            issue_status_for_pull_request("in_review", Draft, true),
            None
        );
        assert_eq!(
            issue_status_for_pull_request("todo", Ready, true),
            Some("in_review")
        );
        assert_eq!(
            issue_status_for_pull_request("in_progress", Ready, true),
            Some("in_review")
        );
        assert_eq!(
            issue_status_for_pull_request("in_review", Ready, true),
            None
        );
    }

    #[test]
    fn completes_on_merge_only_when_the_link_closes() {
        use PullRequestPhase::Merged;
        assert_eq!(
            issue_status_for_pull_request("in_review", Merged, true),
            Some("done")
        );
        assert_eq!(
            issue_status_for_pull_request("in_review", Merged, false),
            None
        );
    }

    #[test]
    fn never_moves_done_or_canceled_issues_and_ignores_closed_pull_requests() {
        use PullRequestPhase::{Closed, Merged, Ready};
        assert_eq!(issue_status_for_pull_request("done", Ready, true), None);
        assert_eq!(
            issue_status_for_pull_request("canceled", Merged, true),
            None
        );
        assert_eq!(
            issue_status_for_pull_request("in_review", Closed, true),
            None
        );
    }

    #[test]
    fn sets_started_once_and_keeps_it() {
        let now = "2026-11-05T10:00:00.000Z";
        let started = status_timestamps("in_progress", &StatusTimestamps::default(), now);
        assert_eq!(started.started_at.as_deref(), Some(now));
        let later = status_timestamps("in_review", &started, "2026-11-06T10:00:00.000Z");
        assert_eq!(later.started_at.as_deref(), Some(now));
    }

    #[test]
    fn holds_completed_and_canceled_only_while_in_that_status() {
        let now = "2026-11-05T10:00:00.000Z";
        let none = StatusTimestamps::default();
        let done = status_timestamps("done", &none, now);
        assert_eq!(done.completed_at.as_deref(), Some(now));
        assert_eq!(
            status_timestamps("in_review", &done, now).completed_at,
            None
        );
        let canceled = status_timestamps("canceled", &none, now);
        assert_eq!(canceled.canceled_at.as_deref(), Some(now));
        assert_eq!(canceled.started_at, None);
    }
}
