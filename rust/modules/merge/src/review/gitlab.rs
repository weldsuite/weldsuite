//! GitLab's `ReviewAdapter` (`services/providers/gitlab/review.ts`). Reads and
//! writes use the token the service puts on the context (the connection's
//! for reads, the member's for writes). `repository.externalId` is the
//! project id, the pull request number the merge request `iid`, a thread a
//! discussion.

use serde_json::{Map, Value, json};

use super::http::{
    MAX_COMMENTS, MAX_FILES, ProviderRequest, REVIEW_PAGE, at, bearer, commit_message, diff_side,
    id_string, patch_stats, provider_json, trim_trailing_slashes,
};
use super::{CommentInput, MergeInput, ReviewInput};
use crate::MergeError;
use crate::github_client::encode_uri_component;
use crate::providers::{AdapterContext, RepositoryRef};

const PROVIDER: &str = "gitlab";

/// How long a rebase poll waits between reads (`setTimeout(…, 1000)`).
const REBASE_POLL: std::time::Duration = std::time::Duration::from_secs(1);

/// `hostOf(ctx)`: `connection.host ?? 'https://gitlab.com'`, without trailing slashes.
fn host_of(ctx: &AdapterContext) -> String {
    match ctx.connection.get("host").and_then(Value::as_str) {
        Some(host) => trim_trailing_slashes(host).to_owned(),
        None => "https://gitlab.com".to_owned(),
    }
}

fn mr_path(repository: &RepositoryRef, number: i64) -> String {
    format!(
        "/api/v4/projects/{}/merge_requests/{number}",
        encode_uri_component(&repository.external_id)
    )
}

/// `call(ctx, method, path, body?)`.
async fn call(
    ctx: &AdapterContext,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, MergeError> {
    provider_json(
        ctx,
        PROVIDER,
        ProviderRequest {
            method,
            url: format!("{}{path}", host_of(ctx)),
            headers: vec![bearer(ctx, PROVIDER)?],
            body,
        },
    )
    .await
}

async fn collect(ctx: &AdapterContext, path: &str, cap: usize) -> Result<Vec<Value>, MergeError> {
    let mut out: Vec<Value> = Vec::new();
    let mut page = 1;
    while out.len() < cap {
        let rows = call(
            ctx,
            "GET",
            &format!("{path}?per_page={REVIEW_PAGE}&page={page}"),
            None,
        )
        .await?;
        let rows = rows.as_array().cloned().unwrap_or_default();
        let count = rows.len();
        out.extend(rows);
        if count < REVIEW_PAGE {
            break;
        }
        page += 1;
    }
    out.truncate(cap);
    Ok(out)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn diff_status(d: &Value) -> &'static str {
    if flag(d, "new_file") {
        "added"
    } else if flag(d, "deleted_file") {
        "removed"
    } else if flag(d, "renamed_file") {
        "renamed"
    } else {
        "modified"
    }
}

/// `threadComment(note, url)`.
fn thread_comment(note: &Value) -> Value {
    let author = match note.get("author") {
        Some(author @ Value::Object(_)) => {
            json!({ "login": at(author, "username"), "avatarUrl": at(author, "avatar_url") })
        }
        _ => Value::Null,
    };
    json!({
        "id": id_string(note.get("id")),
        "body": at(note, "body"),
        "author": author,
        "createdAt": at(note, "created_at"),
        "url": null,
    })
}

/// `a ?? b ?? null`.
fn either(value: &Value, first: &str, second: &str) -> Value {
    match at(value, first) {
        Value::Null => at(value, second),
        found => found,
    }
}

/// `threadOf(discussion)`: system notes left out; `None` without any other.
fn thread_of(discussion: &Value) -> Option<Value> {
    let notes: Vec<&Value> = discussion
        .get("notes")
        .and_then(Value::as_array)
        .map(|notes| notes.iter().filter(|n| !flag(n, "system")).collect())
        .unwrap_or_default();
    let first = *notes.first()?;
    let position = first.get("position").filter(|p| p.is_object());
    let (path, line) = match position {
        Some(position) => (
            either(position, "new_path", "old_path"),
            either(position, "new_line", "old_line"),
        ),
        None => (Value::Null, Value::Null),
    };
    Some(json!({
        "id": at(discussion, "id"),
        "path": path,
        "line": line,
        "side": diff_side(position.and_then(|p| p.get("new_line")), position.and_then(|p| p.get("old_line"))),
        "resolved": flag(first, "resolvable") && flag(first, "resolved"),
        "comments": notes.iter().map(|n| thread_comment(n)).collect::<Vec<_>>(),
    }))
}

/// A line comment's anchor.
struct Anchor<'a> {
    path: &'a str,
    line: i64,
    side: &'a str,
}

/// `startDiscussion(ctx, repository, number, body, anchor?)`: a line comment
/// carries the diff position of the merge request's current head.
async fn start_discussion(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: &str,
    anchor: Option<Anchor<'_>>,
) -> Result<Value, MergeError> {
    let mut payload = Map::new();
    payload.insert("body".to_owned(), json!(body));
    if let Some(anchor) = anchor {
        let mr = call(ctx, "GET", &mr_path(repository, number), None).await?;
        let refs = mr.get("diff_refs").filter(|r| r.is_object());
        let mut position = Map::new();
        position.insert("position_type".to_owned(), json!("text"));
        // `refs?.base_sha`: undefined keys leave the JSON.
        for key in ["base_sha", "start_sha", "head_sha"] {
            if let Some(value) = refs.and_then(|r| r.get(key)) {
                position.insert(key.to_owned(), value.clone());
            }
        }
        position.insert("new_path".to_owned(), json!(anchor.path));
        position.insert("old_path".to_owned(), json!(anchor.path));
        if anchor.side == "LEFT" {
            position.insert("old_line".to_owned(), json!(anchor.line));
        } else {
            position.insert("new_line".to_owned(), json!(anchor.line));
        }
        payload.insert("position".to_owned(), Value::Object(position));
    }
    call(
        ctx,
        "POST",
        &format!("{}/discussions", mr_path(repository, number)),
        Some(Value::Object(payload)),
    )
    .await
}

/// `waitForRebase`: up to ten reads, a second apart, until GitLab says the
/// rebase is done.
async fn wait_for_rebase(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<(), MergeError> {
    for _ in 0..10 {
        let mr = call(
            ctx,
            "GET",
            &format!(
                "{}?include_rebase_in_progress=true",
                mr_path(repository, number)
            ),
            None,
        )
        .await?;
        if !flag(&mr, "rebase_in_progress") {
            return Ok(());
        }
        tokio::time::sleep(REBASE_POLL).await;
    }
    Ok(())
}

/// `mergeBody(input)`.
fn merge_body(input: &MergeInput) -> Value {
    let message = commit_message(
        input.commit_title.as_deref(),
        input.commit_message.as_deref(),
    );
    match input.method.as_str() {
        "squash" if message.is_empty() => json!({ "squash": true }),
        "squash" => json!({ "squash": true, "squash_commit_message": message }),
        "merge" if !message.is_empty() => json!({ "merge_commit_message": message }),
        _ => json!({}),
    }
}

pub(crate) async fn list_files(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let rows = collect(
        ctx,
        &format!("{}/diffs", mr_path(repository, number)),
        MAX_FILES,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|d| {
            let patch = d
                .get("diff")
                .and_then(Value::as_str)
                .filter(|p| !p.is_empty())
                .map(str::to_owned);
            let (additions, deletions) = patch_stats(patch.as_deref());
            json!({
                "path": at(d, "new_path"),
                "previousPath": if flag(d, "renamed_file") { at(d, "old_path") } else { Value::Null },
                "status": diff_status(d),
                "additions": additions,
                "deletions": deletions,
                "patch": patch,
            })
        })
        .collect())
}

pub(crate) async fn list_threads(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let rows = collect(
        ctx,
        &format!("{}/discussions", mr_path(repository, number)),
        MAX_COMMENTS,
    )
    .await?;
    Ok(rows.iter().filter_map(thread_of).collect())
}

/// GitLab has no "changes requested" state: the request is posted as a discussion.
pub(crate) async fn submit_review(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &ReviewInput,
) -> Result<(), MergeError> {
    if input.event == "approve" {
        call(
            ctx,
            "POST",
            &format!("{}/approve", mr_path(repository, number)),
            None,
        )
        .await?;
    }
    if let Some(body) = input.body.as_deref().filter(|b| !b.is_empty()) {
        start_discussion(ctx, repository, number, body, None).await?;
    }
    for c in &input.comments {
        let anchor = Anchor {
            path: &c.path,
            line: c.line,
            side: &c.side,
        };
        start_discussion(ctx, repository, number, &c.body, Some(anchor)).await?;
    }
    Ok(())
}

pub(crate) async fn comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &CommentInput,
) -> Result<Value, MergeError> {
    if let Some(reply) = input.in_reply_to_id.as_deref().filter(|id| !id.is_empty()) {
        let note = call(
            ctx,
            "POST",
            &format!(
                "{}/discussions/{}/notes",
                mr_path(repository, number),
                encode_uri_component(reply)
            ),
            Some(json!({ "body": input.body })),
        )
        .await?;
        return Ok(json!({ "comment": thread_comment(&note), "threadId": reply }));
    }
    let anchor = match (input.path.as_deref().filter(|p| !p.is_empty()), input.line) {
        (Some(path), Some(line)) if line != 0 => Some(Anchor {
            path,
            line,
            side: input.side.as_deref().unwrap_or("RIGHT"),
        }),
        _ => None,
    };
    let discussion = start_discussion(ctx, repository, number, &input.body, anchor).await?;
    let first = discussion
        .pointer("/notes/0")
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({ "comment": thread_comment(&first), "threadId": at(&discussion, "id") }))
}

pub(crate) async fn merge(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &MergeInput,
) -> Result<(), MergeError> {
    if input.method == "rebase" {
        call(
            ctx,
            "PUT",
            &format!("{}/rebase", mr_path(repository, number)),
            None,
        )
        .await?;
        wait_for_rebase(ctx, repository, number).await?;
    }
    call(
        ctx,
        "PUT",
        &format!("{}/merge", mr_path(repository, number)),
        Some(merge_body(input)),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_discussion_is_a_thread_without_its_system_notes() {
        let discussion = json!({
            "id": "d1",
            "notes": [
                { "id": 1, "body": "fix", "author": { "username": "bob" }, "created_at": "t", "resolvable": true, "resolved": true, "position": { "new_path": "a.ts", "old_path": "a.ts", "new_line": 2 } },
                { "id": 2, "body": "done", "author": { "username": "alice" }, "created_at": "t" },
            ],
        });
        let thread = thread_of(&discussion).unwrap_or_default();
        assert_eq!(thread["path"], "a.ts");
        assert_eq!(thread["line"], 2);
        assert_eq!(thread["side"], "RIGHT");
        assert_eq!(thread["resolved"], true);
        assert!(
            thread_of(&json!({ "id": "d2", "notes": [{ "id": 3, "system": true }] })).is_none()
        );
    }

    #[test]
    fn the_merge_body_follows_the_method() {
        let input = |method: &str, title: Option<&str>, message: Option<&str>| MergeInput {
            method: method.to_owned(),
            commit_title: title.map(str::to_owned),
            commit_message: message.map(str::to_owned),
        };
        assert_eq!(
            merge_body(&input("squash", Some("T"), Some("M"))),
            json!({ "squash": true, "squash_commit_message": "T\n\nM" })
        );
        assert_eq!(merge_body(&input("merge", None, None)), json!({}));
        assert_eq!(merge_body(&input("rebase", Some("T"), None)), json!({}));
    }
}
