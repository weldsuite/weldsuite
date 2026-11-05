//! GitHub → WeldMerge mirror mapping (`@weldsuite/merge-domain/github`):
//! pure functions over GitHub's REST and webhook JSON. The HTTP calls are
//! in [`crate::github_client`].
//!
//! The same mapper serves the webhook body (`pull_request` event) and the
//! REST list (`GET /repos/{owner}/{repo}/pulls`). The list leaves out
//! additions, deletions and changed files, so those map to null and an
//! upsert keeps the stored numbers ([`merge_mirror_update`]).

use serde_json::{Value, json};
use weldsuite_kit::validation::{js_date_parse, js_iso_from_millis, js_number_of};

/// JavaScript's `String(value)`, for an id GitHub sends.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number_text(number),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// A JSON number as JavaScript prints it (integers without a fraction).
fn number_text(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let float = number.as_f64().unwrap_or(f64::NAN);
    if float.fract() == 0.0 && float.abs() < 1e21 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", float as i128);
    }
    number.to_string()
}

/// JavaScript truthiness (`Boolean(value)`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `value ?? null`: a missing key reads as null.
fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `new Date(text).toISOString()`, or `None` for an invalid date.
pub fn iso_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => js_date_parse(text).and_then(js_iso_from_millis),
        Some(Value::Number(number)) => number.as_f64().and_then(js_iso_from_millis),
        Some(Value::Null) => js_iso_from_millis(0.0),
        _ => None,
    }
}

/// The milliseconds of an ISO time this module stored or read.
pub fn millis_of(iso: &str) -> Option<f64> {
    js_date_parse(iso)
}

/// `pr.user?.login?.toLowerCase()`.
fn lower(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_lowercase)
}

/// The mirror columns of one pull request (`MirrorFields`). Times are ISO
/// strings; `None` where `new Date(...)` was invalid.
#[derive(Debug, Clone, PartialEq)]
pub struct MirrorFields {
    pub external_id: String,
    pub number: Value,
    pub title: Value,
    pub body: Value,
    pub state: &'static str,
    pub draft: bool,
    pub url: Value,
    pub author_login: Option<String>,
    pub author_avatar_url: Value,
    pub head_ref: Value,
    pub base_ref: Value,
    pub head_sha: Value,
    pub additions: Value,
    pub deletions: Value,
    pub changed_files: Value,
    /// `[{ kind, login, avatarUrl }]` for users, `{ kind, login }` for teams.
    pub requested_reviewers: Vec<Value>,
    pub labels: Vec<Value>,
    pub provider_created_at: Option<String>,
    pub provider_updated_at: Option<String>,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
}

/// `mapGithubPullRequest(pr)`.
pub fn map_github_pull_request(pr: &Value) -> MirrorFields {
    let get = |key: &str| pr.get(key);
    let merged = get("merged") == Some(&Value::Bool(true)) || truthy(get("merged_at"));
    let state = if merged {
        "merged"
    } else if get("state").and_then(Value::as_str) == Some("closed") {
        "closed"
    } else {
        "open"
    };
    let mut reviewers: Vec<Value> = get("requested_reviewers")
        .and_then(Value::as_array)
        .map(|users| {
            users
                .iter()
                .map(|u| {
                    json!({
                        "kind": "user",
                        "login": lower(u.get("login")),
                        "avatarUrl": or_null(u.get("avatar_url")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(teams) = get("requested_teams").and_then(Value::as_array) {
        for team in teams {
            let mut entry = serde_json::Map::new();
            entry.insert("kind".to_owned(), json!("team"));
            if let Some(slug) = team.get("slug") {
                entry.insert("login".to_owned(), slug.clone());
            }
            reviewers.push(Value::Object(entry));
        }
    }
    let labels = get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .map(|label| {
                    let color = match label.get("color") {
                        Some(Value::String(text)) if !text.is_empty() => {
                            Value::String(format!("#{}", text.strip_prefix('#').unwrap_or(text)))
                        }
                        _ => Value::Null,
                    };
                    let mut entry = serde_json::Map::new();
                    if let Some(name) = label.get("name") {
                        entry.insert("name".to_owned(), name.clone());
                    }
                    entry.insert("color".to_owned(), color);
                    Value::Object(entry)
                })
                .collect()
        })
        .unwrap_or_default();
    let user = get("user");
    let head = get("head");
    let base = get("base");
    let nested = |outer: Option<&Value>, key: &str| or_null(outer.and_then(|o| o.get(key)));
    MirrorFields {
        external_id: js_string(get("id")),
        number: or_null(get("number")),
        title: or_null(get("title")),
        body: or_null(get("body")),
        state,
        draft: get("draft") == Some(&Value::Bool(true)),
        url: or_null(get("html_url")),
        author_login: lower(user.and_then(|u| u.get("login"))),
        author_avatar_url: nested(user, "avatar_url"),
        head_ref: nested(head, "ref"),
        base_ref: nested(base, "ref"),
        head_sha: nested(head, "sha"),
        additions: or_null(get("additions")),
        deletions: or_null(get("deletions")),
        changed_files: or_null(get("changed_files")),
        requested_reviewers: reviewers,
        labels,
        provider_created_at: iso_of(get("created_at")),
        provider_updated_at: iso_of(get("updated_at")),
        merged_at: if merged {
            truthy(get("merged_at"))
                .then(|| iso_of(get("merged_at")))
                .flatten()
        } else {
            None
        },
        closed_at: truthy(get("closed_at"))
            .then(|| iso_of(get("closed_at")))
            .flatten(),
    }
}

/// `isNotOlder(incoming, stored)`: only a copy that is not older may
/// overwrite the mirror. Equal times are applied (a review or check event
/// carries the pull request's own `updated_at`).
pub fn is_not_older(incoming: Option<&str>, stored: Option<&str>) -> bool {
    let Some(stored) = stored else {
        return true;
    };
    let incoming = incoming.and_then(millis_of).unwrap_or(f64::NAN);
    let stored = millis_of(stored).unwrap_or(f64::NAN);
    incoming >= stored
}

/// `mergeMirrorUpdate(fields, stored)`: keeps the stored size numbers when
/// the copy (a REST list row) doesn't carry them.
pub fn merge_mirror_update(
    mut fields: MirrorFields,
    stored_additions: &Value,
    stored_deletions: &Value,
    stored_changed_files: &Value,
) -> MirrorFields {
    if fields.additions.is_null() {
        fields.additions = stored_additions.clone();
    }
    if fields.deletions.is_null() {
        fields.deletions = stored_deletions.clone();
    }
    if fields.changed_files.is_null() {
        fields.changed_files = stored_changed_files.clone();
    }
    fields
}

/// `combineCheckSuites(suites)`: any failure wins, then anything still
/// running. GitHub creates an empty suite for every installed app; it never
/// runs and does not count.
pub fn combine_check_suites(suites: &[Value]) -> Option<&'static str> {
    let real: Vec<&Value> = suites
        .iter()
        .filter(|s| match s.get("latest_check_runs_count") {
            None => true,
            Some(count) => js_number_of(Some(count)) > 0.0,
        })
        .collect();
    if real.is_empty() {
        return None;
    }
    let mut pending = false;
    let mut success = false;
    for suite in real {
        let completed = suite.get("status").and_then(Value::as_str) == Some("completed");
        let conclusion = suite.get("conclusion");
        if !completed || conclusion == Some(&Value::Null) {
            pending = true;
            continue;
        }
        match conclusion.and_then(Value::as_str) {
            Some("failure" | "timed_out" | "action_required" | "startup_failure") => {
                return Some("failure");
            }
            Some("success") => success = true,
            // neutral, skipped, cancelled, stale
            _ => {}
        }
    }
    if pending {
        return Some("pending");
    }
    Some(if success { "success" } else { "neutral" })
}

/// `reviewDecisionFromReviews(reviews, requestedReviewerCount)`: each
/// reviewer's latest approving, rejecting or dismissed review counts.
/// Changes requested by anyone wins; then any approval; then
/// `review_required` while reviewers are still requested.
pub fn review_decision_from_reviews(
    reviews: &[Value],
    requested_reviewer_count: usize,
) -> Option<&'static str> {
    let time = |review: &Value| -> f64 {
        match review.get("submitted_at") {
            None | Some(Value::Null) => 0.0,
            Some(Value::String(text)) => js_date_parse(text).unwrap_or(f64::NAN),
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(_) => f64::NAN,
        }
    };
    let mut ordered: Vec<&Value> = reviews.iter().collect();
    // A stable sort, as `Array.prototype.sort`; NaN compares equal.
    ordered.sort_by(|a, b| {
        time(a)
            .partial_cmp(&time(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut latest: Vec<(String, String)> = Vec::new();
    for review in ordered {
        let Some(login) = review
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .filter(|l| !l.is_empty())
        else {
            continue;
        };
        let Some(state) = review.get("state").and_then(Value::as_str) else {
            continue;
        };
        if matches!(state, "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED") {
            match latest.iter_mut().find(|(l, _)| *l == login) {
                Some(entry) => state.clone_into(&mut entry.1),
                None => latest.push((login, state.to_owned())),
            }
        }
    }
    if latest.iter().any(|(_, s)| s == "CHANGES_REQUESTED") {
        return Some("changes_requested");
    }
    if latest.iter().any(|(_, s)| s == "APPROVED") {
        return Some("approved");
    }
    (requested_reviewer_count > 0).then_some("review_required")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Value {
        json!({
            "id": 9001,
            "number": 1466,
            "title": "Restrict project tab writes",
            "body": "Fixes PLAT-209",
            "state": "open",
            "draft": false,
            "merged": false,
            "merged_at": null,
            "closed_at": null,
            "created_at": "2026-11-04T09:00:00Z",
            "updated_at": "2026-11-05T09:00:00Z",
            "html_url": "https://github.com/weldsuite/weldsuite/pull/1466",
            "user": { "login": "SVermeer", "avatar_url": "https://avatars.example/sv" },
            "head": { "ref": "plat-209-tabs", "sha": "abc123" },
            "base": { "ref": "develop" },
            "additions": 120,
            "deletions": 14,
            "changed_files": 6,
            "requested_reviewers": [{ "login": "TJanssen" }],
            "requested_teams": [{ "slug": "platform" }],
            "labels": [{ "name": "flow", "color": "6e56cf" }],
        })
    }

    fn with(changes: &Value) -> Value {
        let mut pr = base();
        if let (Some(target), Some(source)) = (pr.as_object_mut(), changes.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        pr
    }

    #[test]
    fn maps_an_open_pull_request() {
        let m = map_github_pull_request(&base());
        assert_eq!(m.external_id, "9001");
        assert_eq!(m.state, "open");
        assert_eq!(m.author_login.as_deref(), Some("svermeer"));
        assert_eq!(m.head_ref, json!("plat-209-tabs"));
        assert_eq!(
            m.requested_reviewers,
            vec![
                json!({ "kind": "user", "login": "tjanssen", "avatarUrl": null }),
                json!({ "kind": "team", "login": "platform" }),
            ]
        );
        assert_eq!(
            m.labels,
            vec![json!({ "name": "flow", "color": "#6e56cf" })]
        );
        assert_eq!(m.merged_at, None);
        assert_eq!(
            m.provider_updated_at.as_deref(),
            Some("2026-11-05T09:00:00.000Z")
        );
    }

    #[test]
    fn maps_merged_and_closed() {
        let merged =
            json!({ "state": "closed", "merged": true, "merged_at": "2026-11-05T10:00:00Z" });
        assert_eq!(map_github_pull_request(&with(&merged)).state, "merged");
        let by_time =
            json!({ "state": "closed", "merged_at": "2026-11-05T10:00:00Z", "merged": null });
        assert_eq!(map_github_pull_request(&with(&by_time)).state, "merged");
        let closed = json!({ "state": "closed", "closed_at": "2026-11-05T10:00:00Z" });
        assert_eq!(map_github_pull_request(&with(&closed)).state, "closed");
    }

    #[test]
    fn keeps_stored_size_numbers_when_a_list_row_lacks_them() {
        let mut pr = base();
        if let Some(fields) = pr.as_object_mut() {
            fields.remove("additions");
            fields.remove("deletions");
            fields.remove("changed_files");
        }
        let row = merge_mirror_update(
            map_github_pull_request(&pr),
            &json!(1),
            &json!(2),
            &json!(3),
        );
        assert_eq!(
            (row.additions, row.deletions, row.changed_files),
            (json!(1), json!(2), json!(3))
        );
    }

    #[test]
    fn accepts_newer_and_equal_copies_only() {
        let t = "2026-11-05T09:00:00.000Z";
        assert!(is_not_older(Some(t), None));
        assert!(is_not_older(Some(t), Some(t)));
        assert!(!is_not_older(Some("2026-11-05T08:00:00.000Z"), Some(t)));
    }

    #[test]
    fn lets_failure_win_then_pending() {
        let suite =
            |status: &str, conclusion: Value| json!({ "status": status, "conclusion": conclusion });
        assert_eq!(
            combine_check_suites(&[
                suite("completed", json!("success")),
                suite("in_progress", Value::Null),
                suite("completed", json!("failure")),
            ]),
            Some("failure")
        );
        assert_eq!(
            combine_check_suites(&[
                suite("completed", json!("success")),
                suite("queued", Value::Null)
            ]),
            Some("pending")
        );
        assert_eq!(
            combine_check_suites(&[
                suite("completed", json!("success")),
                suite("completed", json!("skipped"))
            ]),
            Some("success")
        );
    }

    #[test]
    fn ignores_empty_suites_and_returns_none_when_none_ran() {
        assert_eq!(
            combine_check_suites(&[
                json!({ "status": "queued", "conclusion": null, "latest_check_runs_count": 0 })
            ]),
            None
        );
        assert_eq!(combine_check_suites(&[]), None);
    }

    #[test]
    fn uses_each_reviewers_latest_decisive_review() {
        let review = |state: &str, login: &str, at: &str| json!({ "user": { "login": login }, "state": state, "submitted_at": at });
        assert_eq!(
            review_decision_from_reviews(
                &[
                    review("CHANGES_REQUESTED", "tj", "2026-11-05T08:00:00Z"),
                    review("COMMENTED", "tj", "2026-11-05T08:30:00Z"),
                    review("APPROVED", "tj", "2026-11-05T09:00:00Z"),
                ],
                0
            ),
            Some("approved")
        );
    }

    #[test]
    fn lets_changes_requested_win_and_falls_back_to_review_required() {
        let review = |state: &str, login: &str, at: &str| json!({ "user": { "login": login }, "state": state, "submitted_at": at });
        assert_eq!(
            review_decision_from_reviews(
                &[
                    review("APPROVED", "a", "2026-11-05T08:00:00Z"),
                    review("CHANGES_REQUESTED", "b", "2026-11-05T08:10:00Z"),
                ],
                1
            ),
            Some("changes_requested")
        );
        assert_eq!(
            review_decision_from_reviews(&[], 2),
            Some("review_required")
        );
        assert_eq!(review_decision_from_reviews(&[], 0), None);
    }

    #[test]
    fn prints_ids_as_javascript_does() {
        assert_eq!(js_string(Some(&json!(900))), "900");
        assert_eq!(js_string(Some(&json!("900"))), "900");
        assert_eq!(js_string(None), "undefined");
    }
}
