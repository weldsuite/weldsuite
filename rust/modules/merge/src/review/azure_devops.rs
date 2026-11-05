//! Azure DevOps' `ReviewAdapter` (`services/providers/azure-devops/review.ts`).
//! `connection.host` is the organisation URL (`https://dev.azure.com/<org>`),
//! `repository.externalProject` the project, `repository.externalId` the
//! repository id. The token is an Entra ID bearer token. Azure DevOps has no
//! per-file patch endpoint, so `patch` is null and additions/deletions are 0;
//! a "request changes" is the reviewer vote "waiting for the author" (-5).

use serde_json::{Map, Value, json};

use super::http::{
    MAX_COMMENTS, MAX_FILES, ProviderRequest, REVIEW_PAGE, at, bearer, commit_message, diff_side,
    id_string, provider_json, trim_trailing_slashes,
};
use super::{CommentInput, MergeInput, ReviewInput};
use crate::MergeError;
use crate::github_client::encode_uri_component;
use crate::providers::{AdapterContext, RepositoryRef};

const PROVIDER: &str = "azure_devops";
const API_VERSION: &str = "api-version=7.1";

/// `orgOf(ctx)`: `connection.host ?? ''`, without trailing slashes.
fn org_of(ctx: &AdapterContext) -> String {
    trim_trailing_slashes(
        ctx.connection
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )
    .to_owned()
}

fn pr_url(ctx: &AdapterContext, repository: &RepositoryRef, number: i64) -> String {
    format!(
        "{}/{}/_apis/git/repositories/{}/pullrequests/{number}",
        org_of(ctx),
        encode_uri_component(repository.external_project.as_deref().unwrap_or_default()),
        encode_uri_component(&repository.external_id)
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

fn change_type(kind: &str) -> &'static str {
    match kind {
        "add" => "added",
        "edit" => "modified",
        "delete" => "removed",
        "rename" | "edit, rename" => "renamed",
        _ => "changed",
    }
}

/// `path.replace(/^\//, '')`.
fn strip_slash(path: &str) -> &str {
    path.strip_prefix('/').unwrap_or(path)
}

/// `listChanges`: the last iteration's changes, up to 300.
async fn list_changes(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let base = pr_url(ctx, repository, number);
    let iterations = call(ctx, "GET", format!("{base}/iterations?{API_VERSION}"), None).await?;
    let Some(last) = iterations
        .get("value")
        .and_then(Value::as_array)
        .and_then(|v| v.last())
        .cloned()
    else {
        return Ok(Vec::new());
    };
    let last_id = id_string(last.get("id"));
    let mut out: Vec<Value> = Vec::new();
    let mut skip = 0;
    while out.len() < MAX_FILES {
        let page = call(
            ctx,
            "GET",
            format!(
                "{base}/iterations/{last_id}/changes?$top={REVIEW_PAGE}&$skip={skip}&{API_VERSION}"
            ),
            None,
        )
        .await?;
        out.extend(
            page.get("changeEntries")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        // `!page?.nextSkip`: absent, null or 0 ends the pages.
        if page
            .get("nextSkip")
            .and_then(Value::as_f64)
            .is_none_or(|n| n == 0.0)
        {
            break;
        }
        skip += REVIEW_PAGE;
    }
    out.truncate(MAX_FILES);
    Ok(out)
}

/// `threadComment(row)`.
fn thread_comment(row: &Value) -> Value {
    let author = match row.get("author") {
        Some(author @ Value::Object(_)) => {
            let login = author
                .get("uniqueName")
                .and_then(Value::as_str)
                .or_else(|| author.get("displayName").and_then(Value::as_str))
                .unwrap_or("unknown");
            json!({ "login": login, "avatarUrl": at(author, "imageUrl") })
        }
        _ => Value::Null,
    };
    json!({
        "id": id_string(row.get("id")),
        "body": row.get("content").and_then(Value::as_str).unwrap_or_default(),
        "author": author,
        "createdAt": at(row, "publishedDate"),
        "url": null,
    })
}

const RESOLVED: [&str; 4] = ["fixed", "closed", "wontFix", "byDesign"];

/// `threadOf(thread)`: system comments left out; `None` without any other.
fn thread_of(thread: &Value) -> Option<Value> {
    let comments: Vec<&Value> = thread
        .get("comments")
        .and_then(Value::as_array)
        .map(|c| {
            c.iter()
                .filter(|c| c.get("commentType").and_then(Value::as_str) != Some("system"))
                .collect()
        })
        .unwrap_or_default();
    if comments.is_empty() {
        return None;
    }
    let context = thread.get("threadContext").filter(|c| c.is_object());
    let right = context
        .and_then(|c| c.pointer("/rightFileStart/line"))
        .cloned();
    let left = context
        .and_then(|c| c.pointer("/leftFileStart/line"))
        .cloned();
    let right = right.filter(|v| !v.is_null());
    let left = left.filter(|v| !v.is_null());
    let line = right
        .clone()
        .or_else(|| left.clone())
        .unwrap_or(Value::Null);
    let path = context
        .and_then(|c| c.get("filePath"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map_or(Value::Null, |p| json!(strip_slash(p)));
    let status = thread
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(json!({
        "id": id_string(thread.get("id")),
        "path": path,
        "line": line,
        "side": diff_side(right.as_ref(), left.as_ref()),
        "resolved": RESOLVED.contains(&status),
        "comments": comments.iter().map(|c| thread_comment(c)).collect::<Vec<_>>(),
    }))
}

/// `threadContext(path, line, side)`.
fn thread_context(path: &str, line: i64, side: &str) -> Value {
    let point = json!({ "line": line, "offset": 1 });
    let key = if side == "LEFT" { "left" } else { "right" };
    let mut context = Map::new();
    context.insert(
        "filePath".to_owned(),
        json!(format!("/{}", strip_slash(path))),
    );
    context.insert(format!("{key}FileStart"), point.clone());
    context.insert(format!("{key}FileEnd"), point);
    Value::Object(context)
}

/// `newThread(ctx, repository, number, body, anchor?)`.
async fn new_thread(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: &str,
    anchor: Option<(&str, i64, &str)>,
) -> Result<Value, MergeError> {
    let mut payload = Map::new();
    payload.insert(
        "comments".to_owned(),
        json!([{ "parentCommentId": 0, "content": body, "commentType": 1 }]),
    );
    payload.insert("status".to_owned(), json!(1));
    if let Some((path, line, side)) = anchor {
        payload.insert("threadContext".to_owned(), thread_context(path, line, side));
    }
    call(
        ctx,
        "POST",
        format!("{}/threads?{API_VERSION}", pr_url(ctx, repository, number)),
        Some(Value::Object(payload)),
    )
    .await
}

/// `currentUserId(ctx)`: the signed-in member's id, which the vote is
/// addressed to.
async fn current_user_id(ctx: &AdapterContext) -> Result<String, MergeError> {
    let data = call(
        ctx,
        "GET",
        format!("{}/_apis/connectionData?{API_VERSION}-preview", org_of(ctx)),
        None,
    )
    .await?;
    data.pointer("/authenticatedUser/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            MergeError::provider_api(
                PROVIDER,
                401,
                "Azure DevOps did not say who this token belongs to",
            )
        })
}

pub(crate) async fn list_files(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let changes = list_changes(ctx, repository, number).await?;
    Ok(changes
        .iter()
        .map(|c| {
            json!({
                "path": strip_slash(c.pointer("/item/path").and_then(Value::as_str).unwrap_or_default()),
                "previousPath": c
                    .get("originalPath")
                    .and_then(Value::as_str)
                    .filter(|p| !p.is_empty())
                    .map_or(Value::Null, |p| json!(strip_slash(p))),
                "status": change_type(c.get("changeType").and_then(Value::as_str).unwrap_or_default()),
                "additions": 0,
                "deletions": 0,
                "patch": null,
            })
        })
        .collect())
}

pub(crate) async fn list_threads(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    let data = call(
        ctx,
        "GET",
        format!("{}/threads?{API_VERSION}", pr_url(ctx, repository, number)),
        None,
    )
    .await?;
    let threads: Vec<Value> = data
        .get("value")
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(thread_of).collect())
        .unwrap_or_default();
    let mut kept: Vec<Value> = Vec::new();
    let mut seen = 0;
    for thread in threads {
        if seen >= MAX_COMMENTS {
            break;
        }
        seen += thread
            .get("comments")
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        kept.push(thread);
    }
    Ok(kept)
}

/// `VOTES`.
fn vote(event: &str) -> i64 {
    match event {
        "approve" => 10,
        "request_changes" => -5,
        _ => 0,
    }
}

pub(crate) async fn submit_review(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &ReviewInput,
) -> Result<(), MergeError> {
    if let Some(body) = input.body.as_deref().filter(|b| !b.is_empty()) {
        new_thread(ctx, repository, number, body, None).await?;
    }
    for c in &input.comments {
        new_thread(
            ctx,
            repository,
            number,
            &c.body,
            Some((&c.path, c.line, &c.side)),
        )
        .await?;
    }
    if input.event == "comment" {
        return Ok(());
    }
    let reviewer = current_user_id(ctx).await?;
    call(
        ctx,
        "PUT",
        format!(
            "{}/reviewers/{reviewer}?{API_VERSION}",
            pr_url(ctx, repository, number)
        ),
        Some(json!({ "vote": vote(&input.event) })),
    )
    .await?;
    Ok(())
}

pub(crate) async fn comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &CommentInput,
) -> Result<Value, MergeError> {
    if let Some(reply) = input.in_reply_to_id.as_deref().filter(|id| !id.is_empty()) {
        let row = call(
            ctx,
            "POST",
            format!(
                "{}/threads/{reply}/comments?{API_VERSION}",
                pr_url(ctx, repository, number)
            ),
            Some(json!({ "content": input.body, "parentCommentId": 1, "commentType": 1 })),
        )
        .await?;
        return Ok(json!({ "comment": thread_comment(&row), "threadId": reply }));
    }
    let anchor = match (input.path.as_deref().filter(|p| !p.is_empty()), input.line) {
        (Some(path), Some(line)) if line != 0 => {
            Some((path, line, input.side.as_deref().unwrap_or("RIGHT")))
        }
        _ => None,
    };
    let thread = new_thread(ctx, repository, number, &input.body, anchor).await?;
    let first = thread
        .pointer("/comments/0")
        .cloned()
        .unwrap_or(Value::Null);
    Ok(json!({
        "comment": thread_comment(&first),
        "threadId": id_string(thread.get("id")),
    }))
}

/// `STRATEGIES`.
fn strategy(method: &str) -> &'static str {
    match method {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "noFastForward",
    }
}

pub(crate) async fn merge(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &MergeInput,
) -> Result<(), MergeError> {
    let url = format!("{}?{API_VERSION}", pr_url(ctx, repository, number));
    let current = call(ctx, "GET", url.clone(), None).await?;
    let message = commit_message(
        input.commit_title.as_deref(),
        input.commit_message.as_deref(),
    );
    let mut options = Map::new();
    options.insert("mergeStrategy".to_owned(), json!(strategy(&input.method)));
    if !message.is_empty() {
        options.insert("mergeCommitMessage".to_owned(), json!(message));
    }
    let mut body = Map::new();
    body.insert("status".to_owned(), json!("completed"));
    // `current?.lastMergeSourceCommit`: an undefined one leaves the JSON.
    if let Some(commit) = current.get("lastMergeSourceCommit") {
        body.insert("lastMergeSourceCommit".to_owned(), commit.clone());
    }
    body.insert("completionOptions".to_owned(), Value::Object(options));
    let done = call(ctx, "PATCH", url, Some(Value::Object(body))).await?;
    let failure = done
        .get("mergeFailureMessage")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty());
    let status = done.get("mergeStatus").and_then(Value::as_str);
    if failure.is_some() || matches!(status, Some("conflicts" | "failure")) {
        return Err(MergeError::provider_api(
            PROVIDER,
            409,
            failure.unwrap_or("The pull request cannot be completed"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_skips_system_comments_and_reads_its_anchor() {
        let thread = json!({
            "id": 4, "status": "fixed",
            "threadContext": { "filePath": "/src/a.ts", "rightFileStart": { "line": 12 } },
            "comments": [{ "id": 1, "content": "nit", "commentType": "text", "publishedDate": "t", "author": { "uniqueName": "bob@acme.io" } }],
        });
        let read = thread_of(&thread).unwrap_or_default();
        assert_eq!(read["id"], "4");
        assert_eq!(read["path"], "src/a.ts");
        assert_eq!(read["line"], 12);
        assert_eq!(read["side"], "RIGHT");
        assert_eq!(read["resolved"], true);
        let system = json!({ "id": 5, "comments": [{ "id": 1, "commentType": "system" }] });
        assert!(thread_of(&system).is_none());
        assert_eq!(
            thread_context("a.ts", 3, "LEFT"),
            json!({ "filePath": "/a.ts", "leftFileStart": { "line": 3, "offset": 1 }, "leftFileEnd": { "line": 3, "offset": 1 } })
        );
    }
}
