//! Bitbucket Cloud's `ReviewAdapter` (`services/providers/bitbucket/review.ts`).
//! `repository.fullName` is `workspace/slug`; a thread is a root comment and
//! its replies. A merge the provider refuses (400, 555) is raised as a 409 so
//! the service answers `not_mergeable`.

use serde_json::{Map, Value, json};

use super::http::{
    MAX_COMMENTS, MAX_FILES, ProviderRequest, REVIEW_PAGE, at, bearer, commit_message, diff_side,
    id_string, provider_json, provider_text, split_unified_diff,
};
use super::{CommentInput, MergeInput, ReviewInput};
use crate::MergeError;
use crate::providers::{AdapterContext, RepositoryRef};

const PROVIDER: &str = "bitbucket";
const API: &str = "https://api.bitbucket.org/2.0";

fn pr_url(repository: &RepositoryRef, number: i64) -> String {
    format!(
        "{API}/repositories/{}/pullrequests/{number}",
        repository.full_name
    )
}

async fn call(
    ctx: &AdapterContext,
    method: &str,
    url: String,
    body: Option<Value>,
) -> Result<Value, MergeError> {
    provider_json(
        ctx,
        PROVIDER,
        ProviderRequest {
            method,
            url,
            headers: vec![bearer(ctx, PROVIDER)?],
            body,
        },
    )
    .await
}

/// `collect(ctx, firstUrl, cap)`: follows `next` links until the pages run
/// out or `cap` rows are read.
async fn collect(
    ctx: &AdapterContext,
    first_url: String,
    cap: usize,
) -> Result<Vec<Value>, MergeError> {
    let mut out: Vec<Value> = Vec::new();
    let mut url = Some(first_url);
    while let Some(next) = url.take() {
        if out.len() >= cap {
            break;
        }
        let page = call(ctx, "GET", next, None).await?;
        out.extend(
            page.get("values")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        url = page
            .get("next")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .map(str::to_owned);
    }
    out.truncate(cap);
    Ok(out)
}

fn status_of(status: &str) -> &'static str {
    match status {
        "added" => "added",
        "removed" => "removed",
        "modified" => "modified",
        "renamed" => "renamed",
        _ => "changed",
    }
}

/// `threadComment(row)`.
fn thread_comment(row: &Value) -> Value {
    let author = match row.get("user") {
        Some(user @ Value::Object(_)) => {
            let login = user
                .get("nickname")
                .and_then(Value::as_str)
                .or_else(|| user.get("display_name").and_then(Value::as_str))
                .unwrap_or("unknown");
            json!({
                "login": login,
                "avatarUrl": user.pointer("/links/avatar/href").cloned().unwrap_or(Value::Null),
            })
        }
        _ => Value::Null,
    };
    json!({
        "id": id_string(row.get("id")),
        "body": row.pointer("/content/raw").cloned().unwrap_or_else(|| json!("")),
        "author": author,
        "createdAt": at(row, "created_on"),
        "url": row.pointer("/links/html/href").cloned().unwrap_or(Value::Null),
    })
}

/// `buildThreads(rows)`.
fn build_threads(rows: &[Value]) -> Vec<Value> {
    let mut live: Vec<&Value> = rows
        .iter()
        .filter(|r| r.get("deleted").and_then(Value::as_bool) != Some(true))
        .collect();
    let created = |v: &Value| {
        v.get("created_on")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let id = |v: &Value| v.get("id").and_then(Value::as_f64).unwrap_or(0.0);
    live.sort_by(|a, b| {
        created(a).cmp(&created(b)).then(
            id(a)
                .partial_cmp(&id(b))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let mut threads: Vec<(String, Value)> = Vec::new();
    for row in live {
        let root = match row.pointer("/parent/id") {
            Some(parent) if !parent.is_null() => id_string(Some(parent)),
            _ => id_string(row.get("id")),
        };
        if let Some((_, thread)) = threads.iter_mut().find(|(key, _)| *key == root) {
            if let Some(comments) = thread.get_mut("comments").and_then(Value::as_array_mut) {
                comments.push(thread_comment(row));
            }
            continue;
        }
        let inline = row.get("inline").filter(|i| i.is_object());
        let anchor_line = inline.map_or(Value::Null, |i| match at(i, "to") {
            Value::Null => at(i, "from"),
            to => to,
        });
        let resolved = row.get("resolution").is_some_and(|r| {
            !matches!(r, Value::Null | Value::Bool(false)) && r != &json!(0) && r != &json!("")
        });
        threads.push((
            root.clone(),
            json!({
                "id": root,
                "path": inline.map_or(Value::Null, |i| at(i, "path")),
                "line": anchor_line,
                "side": diff_side(inline.and_then(|i| i.get("to")), inline.and_then(|i| i.get("from"))),
                "resolved": resolved,
                "comments": [thread_comment(row)],
            }),
        ));
    }
    threads.into_iter().map(|(_, thread)| thread).collect()
}

async fn post_comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: Value,
) -> Result<Value, MergeError> {
    call(
        ctx,
        "POST",
        format!("{}/comments", pr_url(repository, number)),
        Some(body),
    )
    .await
}

/// `{ path, from | to }` of an inline comment.
fn inline(path: &str, line: i64, side: &str) -> Value {
    if side == "LEFT" {
        json!({ "path": path, "from": line })
    } else {
        json!({ "path": path, "to": line })
    }
}

pub(crate) async fn list_files(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    // `Promise.all`: both reads go out whatever the other answers.
    let token = bearer(ctx, PROVIDER)?;
    let (stats, diff) = tokio::join!(
        collect(
            ctx,
            format!(
                "{}/diffstat?pagelen={REVIEW_PAGE}",
                pr_url(repository, number)
            ),
            MAX_FILES,
        ),
        provider_text(
            ctx,
            PROVIDER,
            ProviderRequest {
                method: "GET",
                url: format!("{}/diff", pr_url(repository, number)),
                headers: vec![token],
                body: None,
            },
        ),
    );
    let (stats, diff) = (stats?, diff?);
    let patches = split_unified_diff(&diff);
    Ok(stats
        .iter()
        .map(|s| {
            let file_path = s
                .pointer("/new/path")
                .and_then(Value::as_str)
                .or_else(|| s.pointer("/old/path").and_then(Value::as_str))
                .unwrap_or_default()
                .to_owned();
            let file_status = s.get("status").and_then(Value::as_str).unwrap_or_default();
            let previous_path = if file_status == "renamed" {
                s.pointer("/old/path").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let diff_hunks = patches
                .iter()
                .find(|(p, _)| *p == file_path)
                .map_or(Value::Null, |(_, hunks)| json!(hunks));
            json!({
                "path": file_path,
                "previousPath": previous_path,
                "status": status_of(file_status),
                "additions": at(s, "lines_added"),
                "deletions": at(s, "lines_removed"),
                "patch": diff_hunks,
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
        format!(
            "{}/comments?pagelen={REVIEW_PAGE}",
            pr_url(repository, number)
        ),
        MAX_COMMENTS,
    )
    .await?;
    Ok(build_threads(&rows))
}

pub(crate) async fn submit_review(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &ReviewInput,
) -> Result<(), MergeError> {
    if let Some(body) = input.body.as_deref().filter(|b| !b.is_empty()) {
        post_comment(
            ctx,
            repository,
            number,
            json!({ "content": { "raw": body } }),
        )
        .await?;
    }
    for c in &input.comments {
        post_comment(
            ctx,
            repository,
            number,
            json!({ "content": { "raw": c.body }, "inline": inline(&c.path, c.line, &c.side) }),
        )
        .await?;
    }
    match input.event.as_str() {
        "approve" => {
            call(
                ctx,
                "POST",
                format!("{}/approve", pr_url(repository, number)),
                None,
            )
            .await?;
        }
        "request_changes" => {
            call(
                ctx,
                "POST",
                format!("{}/request-changes", pr_url(repository, number)),
                None,
            )
            .await?;
        }
        _ => {}
    }
    Ok(())
}

pub(crate) async fn comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &CommentInput,
) -> Result<Value, MergeError> {
    let mut body = Map::new();
    body.insert("content".to_owned(), json!({ "raw": input.body }));
    if let Some(reply) = input.in_reply_to_id.as_deref().filter(|id| !id.is_empty()) {
        // `Number(inReplyToId)`; NaN is `null` in JSON.
        let id = reply
            .trim()
            .parse::<i64>()
            .map_or(Value::Null, |n| json!(n));
        body.insert("parent".to_owned(), json!({ "id": id }));
    } else if let (Some(path), Some(line)) = (
        input.path.as_deref().filter(|p| !p.is_empty()),
        input.line.filter(|l| *l != 0),
    ) {
        body.insert(
            "inline".to_owned(),
            inline(path, line, input.side.as_deref().unwrap_or("RIGHT")),
        );
    }
    let row = post_comment(ctx, repository, number, Value::Object(body)).await?;
    let thread = match row.pointer("/parent/id") {
        Some(parent) if !parent.is_null() => id_string(Some(parent)),
        _ => id_string(row.get("id")),
    };
    Ok(json!({ "comment": thread_comment(&row), "threadId": thread }))
}

/// `MERGE_STRATEGIES`.
fn merge_strategy(method: &str) -> &'static str {
    match method {
        "squash" => "squash",
        "rebase" => "rebase_fast_forward",
        _ => "merge_commit",
    }
}

pub(crate) async fn merge(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &MergeInput,
) -> Result<(), MergeError> {
    let message = commit_message(
        input.commit_title.as_deref(),
        input.commit_message.as_deref(),
    );
    let mut body = Map::new();
    body.insert("type".to_owned(), json!("pullrequest"));
    body.insert(
        "merge_strategy".to_owned(),
        json!(merge_strategy(&input.method)),
    );
    if !message.is_empty() {
        body.insert("message".to_owned(), json!(message));
    }
    match call(
        ctx,
        "POST",
        format!("{}/merge", pr_url(repository, number)),
        Some(Value::Object(body)),
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(MergeError::ProviderApi {
            status: 400 | 555,
            message,
            ..
        }) => Err(MergeError::provider_api(PROVIDER, 409, message)),
        Err(other) => Err(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threads_are_a_root_and_its_replies_without_deleted_comments() {
        let rows = [
            json!({ "id": 2, "content": { "raw": "reply" }, "user": { "nickname": "alice" }, "created_on": "2026-11-01T11:00:00Z", "parent": { "id": 1 } }),
            json!({ "id": 1, "content": { "raw": "rename" }, "user": { "nickname": "bob" }, "created_on": "2026-11-01T10:00:00Z", "inline": { "path": "a.ts", "from": null, "to": 5 } }),
            json!({ "id": 3, "content": { "raw": "gone" }, "created_on": "2026-11-01T12:00:00Z", "deleted": true }),
        ];
        let threads = build_threads(&rows);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["id"], "1");
        assert_eq!(threads[0]["line"], 5);
        assert_eq!(threads[0]["side"], "RIGHT");
        assert_eq!(threads[0]["comments"][1]["body"], "reply");
    }
}
