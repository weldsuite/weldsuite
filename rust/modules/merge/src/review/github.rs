//! GitHub's `ReviewAdapter` (`services/providers/github/review.ts`). Reads
//! use the installation token (a fresh client per list, as
//! `createGithubClient` per call does); writes go out with the member's own
//! user-to-server token, so GitHub shows the member as the reviewer.

use serde_json::{Value, json};

use super::http::{
    MAX_COMMENTS, MAX_FILES, ProviderRequest, REVIEW_PAGE, at, bearer, id_string, provider_json,
};
use super::{CommentInput, MergeInput, ReviewInput};
use crate::MergeError;
use crate::github_client::GITHUB_API;
use crate::providers::{AdapterContext, RepositoryRef};

const PROVIDER: &str = "github";

const FILE_STATUSES: [&str; 6] = [
    "added", "removed", "modified", "renamed", "copied", "changed",
];

fn file_status(status: &str) -> &str {
    if FILE_STATUSES.contains(&status) {
        status
    } else {
        "changed"
    }
}

/// `author(user)`.
fn author(user: Option<&Value>) -> Value {
    match user {
        Some(user @ Value::Object(_)) => {
            json!({ "login": at(user, "login"), "avatarUrl": at(user, "avatar_url") })
        }
        _ => Value::Null,
    }
}

/// `threadComment(row)`.
fn thread_comment(row: &Value) -> Value {
    json!({
        "id": id_string(row.get("id")),
        "body": at(row, "body"),
        "author": author(row.get("user")),
        "createdAt": at(row, "created_at"),
        "url": at(row, "html_url"),
    })
}

/// `collect(ctx, path, cap)`: pages through a list endpoint with a new
/// installation client until it runs dry or `cap` rows are read.
async fn collect(ctx: &AdapterContext, path: &str, cap: usize) -> Result<Vec<Value>, MergeError> {
    let client = ctx.github();
    let mut out: Vec<Value> = Vec::new();
    let mut page = 1;
    while out.len() < cap {
        let rows = client
            .get(&format!("{path}?per_page={REVIEW_PAGE}&page={page}"))
            .await
            .map_err(|error| match error {
                // `GithubApiError`: `GitHub <path> answered <status>`.
                MergeError::GithubApi(status) => MergeError::provider_api(
                    PROVIDER,
                    status,
                    format!("GitHub {path} answered {status}"),
                ),
                other => other,
            })?;
        let rows = rows.and_then(|r| r.as_array().cloned()).unwrap_or_default();
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

/// `memberHeaders(ctx)`.
fn member_headers(ctx: &AdapterContext) -> Result<Vec<(&'static str, String)>, MergeError> {
    Ok(vec![
        bearer(ctx, PROVIDER)?,
        ("Accept", "application/vnd.github+json".to_owned()),
        ("X-GitHub-Api-Version", "2022-11-28".to_owned()),
    ])
}

/// `write(ctx, method, path, body)`: a write as the member.
async fn write(
    ctx: &AdapterContext,
    method: &str,
    path: &str,
    body: Value,
) -> Result<Value, MergeError> {
    provider_json(
        ctx,
        PROVIDER,
        ProviderRequest {
            method,
            url: format!("{GITHUB_API}{path}"),
            headers: member_headers(ctx)?,
            body: Some(body),
        },
    )
    .await
}

pub(crate) async fn list_files(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let rows = collect(
        ctx,
        &format!("/repos/{}/pulls/{number}/files", repository.full_name),
        MAX_FILES,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|f| {
            json!({
                "path": at(f, "filename"),
                "previousPath": at(f, "previous_filename"),
                "status": file_status(f.get("status").and_then(Value::as_str).unwrap_or_default()),
                "additions": at(f, "additions"),
                "deletions": at(f, "deletions"),
                "patch": at(f, "patch"),
            })
        })
        .collect())
}

/// `lineThreads(rows)`: a reply joins its root's thread.
fn line_threads(rows: &[Value]) -> Vec<Value> {
    let mut sorted: Vec<&Value> = rows.iter().collect();
    let created = |v: &Value| {
        v.get("created_at")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let id = |v: &Value| v.get("id").and_then(Value::as_f64).unwrap_or(0.0);
    sorted.sort_by(|a, b| {
        created(a).cmp(&created(b)).then(
            id(a)
                .partial_cmp(&id(b))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let mut threads: Vec<(String, Value)> = Vec::new();
    for row in sorted {
        let root = match row.get("in_reply_to_id") {
            Some(reply @ Value::Number(_)) => id_string(Some(reply)),
            _ => id_string(row.get("id")),
        };
        if let Some((_, thread)) = threads.iter_mut().find(|(key, _)| *key == root) {
            if let Some(comments) = thread.get_mut("comments").and_then(Value::as_array_mut) {
                comments.push(thread_comment(row));
            }
            continue;
        }
        let line = match at(row, "line") {
            Value::Null => at(row, "original_line"),
            line => line,
        };
        threads.push((
            root.clone(),
            json!({
                "id": root,
                "path": at(row, "path"),
                "line": line,
                "side": at(row, "side"),
                "resolved": false,
                "comments": [thread_comment(row)],
            }),
        ));
    }
    threads.into_iter().map(|(_, thread)| thread).collect()
}

/// `GENERAL_THREAD`: the id prefix of a general (conversation) thread.
const GENERAL_THREAD: &str = "issue-";

/// `generalThread(row)`: a conversation comment.
fn general_thread(row: &Value) -> Value {
    json!({
        "id": format!("{GENERAL_THREAD}{}", id_string(row.get("id"))),
        "path": null,
        "line": null,
        "side": null,
        "resolved": false,
        "comments": [thread_comment(row)],
    })
}

pub(crate) async fn list_threads(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    // `Promise.all`: both lists are read whatever the other answers.
    let review_path = format!("/repos/{}/pulls/{number}/comments", repository.full_name);
    let general_path = format!("/repos/{}/issues/{number}/comments", repository.full_name);
    let (review, general) = tokio::join!(
        collect(ctx, &review_path, MAX_COMMENTS),
        collect(ctx, &general_path, MAX_COMMENTS),
    );
    let (review, general) = (review?, general?);
    let mut threads = line_threads(&review);
    threads.extend(general.iter().map(general_thread));
    Ok(threads)
}

/// `REVIEW_EVENTS`.
fn review_event(event: &str) -> &'static str {
    match event {
        "approve" => "APPROVE",
        "request_changes" => "REQUEST_CHANGES",
        _ => "COMMENT",
    }
}

pub(crate) async fn submit_review(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &ReviewInput,
) -> Result<(), MergeError> {
    let mut body = serde_json::Map::new();
    body.insert("event".to_owned(), json!(review_event(&input.event)));
    if let Some(text) = input.body.as_deref().filter(|b| !b.is_empty()) {
        body.insert("body".to_owned(), json!(text));
    }
    if !input.comments.is_empty() {
        body.insert(
            "comments".to_owned(),
            Value::Array(
                input
                    .comments
                    .iter()
                    .map(|c| json!({ "path": c.path, "line": c.line, "side": c.side, "body": c.body }))
                    .collect(),
            ),
        );
    }
    write(
        ctx,
        "POST",
        &format!("/repos/{}/pulls/{number}/reviews", repository.full_name),
        Value::Object(body),
    )
    .await?;
    Ok(())
}

/// `headSha(ctx, repository, number)`, read with the member's token.
async fn head_sha(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<String, MergeError> {
    let pull = provider_json(
        ctx,
        PROVIDER,
        ProviderRequest {
            method: "GET",
            url: format!("{GITHUB_API}/repos/{}/pulls/{number}", repository.full_name),
            headers: member_headers(ctx)?,
            body: None,
        },
    )
    .await?;
    Ok(pull
        .pointer("/head/sha")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

pub(crate) async fn comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &CommentInput,
) -> Result<Value, MergeError> {
    let reply = input.in_reply_to_id.as_deref().filter(|id| !id.is_empty());
    // GitHub has no threaded replies on conversation comments: a reply to a
    // general thread (`issue-<id>`) is a new issue comment, shown in that thread.
    let general_reply = reply.filter(|id| id.starts_with(GENERAL_THREAD));
    let reply = reply.filter(|_| general_reply.is_none());
    if general_reply.is_none()
        && (reply.is_some() || input.path.as_deref().is_some_and(|p| !p.is_empty()))
    {
        // A reply, or a new line comment anchored to the head commit.
        let mut body = serde_json::Map::new();
        body.insert("body".to_owned(), json!(input.body));
        if let Some(reply) = reply {
            // `Number(inReplyToId)`.
            let number_of = reply.trim().parse::<f64>().ok().filter(|n| n.is_finite());
            body.insert(
                "in_reply_to".to_owned(),
                number_of.map_or(Value::Null, |n| {
                    if n.fract() == 0.0 && n.abs() < 9e15 {
                        #[allow(clippy::cast_possible_truncation)]
                        let whole = n as i64;
                        json!(whole)
                    } else {
                        json!(n)
                    }
                }),
            );
        } else {
            body.insert(
                "commit_id".to_owned(),
                json!(head_sha(ctx, repository, number).await?),
            );
            body.insert("path".to_owned(), json!(input.path));
            body.insert("line".to_owned(), json!(input.line));
            body.insert(
                "side".to_owned(),
                json!(input.side.as_deref().unwrap_or("RIGHT")),
            );
        }
        let row = write(
            ctx,
            "POST",
            &format!("/repos/{}/pulls/{number}/comments", repository.full_name),
            Value::Object(body),
        )
        .await?;
        let thread = match row.get("in_reply_to_id") {
            Some(reply @ Value::Number(_)) => id_string(Some(reply)),
            _ => id_string(row.get("id")),
        };
        return Ok(json!({ "comment": thread_comment(&row), "threadId": thread }));
    }
    let row = write(
        ctx,
        "POST",
        &format!("/repos/{}/issues/{number}/comments", repository.full_name),
        json!({ "body": input.body }),
    )
    .await?;
    let thread = general_reply.map_or_else(
        || format!("{GENERAL_THREAD}{}", id_string(row.get("id"))),
        str::to_owned,
    );
    Ok(json!({ "comment": thread_comment(&row), "threadId": thread }))
}

pub(crate) async fn merge(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &MergeInput,
) -> Result<(), MergeError> {
    let mut body = serde_json::Map::new();
    body.insert("merge_method".to_owned(), json!(input.method));
    if let Some(title) = input.commit_title.as_deref().filter(|t| !t.is_empty()) {
        body.insert("commit_title".to_owned(), json!(title));
    }
    if let Some(message) = input.commit_message.as_deref().filter(|m| !m.is_empty()) {
        body.insert("commit_message".to_owned(), json!(message));
    }
    write(
        ctx,
        "PUT",
        &format!("/repos/{}/pulls/{number}/merge", repository.full_name),
        Value::Object(body),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_joins_its_roots_thread() {
        let rows = [
            json!({ "id": 12, "body": "Why?", "user": { "login": "bob", "avatar_url": "a" }, "created_at": "2026-11-01T11:00:00Z", "path": "src/a.ts", "line": 4, "side": "RIGHT", "in_reply_to_id": 11, "html_url": "u12" }),
            json!({ "id": 11, "body": "Rename this", "user": { "login": "alice-gh", "avatar_url": null }, "created_at": "2026-11-01T10:00:00Z", "path": "src/a.ts", "line": 4, "side": "RIGHT", "html_url": "u11" }),
        ];
        let threads = line_threads(&rows);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["id"], "11");
        assert_eq!(threads[0]["comments"][1]["id"], "12");
        assert_eq!(file_status("unchanged"), "changed");
    }
}
