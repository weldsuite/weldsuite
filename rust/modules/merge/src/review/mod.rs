//! Review and merge in WeldMerge (phase 4; `services/review.ts`, routes
//! `pull-requests/review.ts`): `/api/merge/pull-requests/:id/…`.
//!
//! ```text
//!   GET  /:id/files     → changed files with their patch (connection token)
//!   GET  /:id/threads   → review threads and general comments (connection token)
//!   POST /:id/reviews   → approve | request_changes | comment, as the member
//!   POST /:id/comments  → a general comment, a line comment or a reply, as the member
//!   POST /:id/merge     → merge | squash | rebase, as the member
//! ```
//!
//! Permissions: `merge_pull_requests:read`, `:review`, `:merge`. Everything is
//! read live from the provider. Reads act with the connection's token (GitHub:
//! an installation token), writes as the member (their linked, verified
//! account): without one the member gets 409 `account_not_linked` before
//! anything is sent. The provider's own refusal is 502 `provider_error` with
//! its message, or 409 `not_mergeable`; a method or capability the provider
//! lacks is 422 `unsupported_method`. After a review or merge the mirror is
//! re-fetched and saved the way a webhook would (automations and hooks run),
//! and after a review the provider's review decision is stored when it
//! changed.

mod azure_devops;
mod bitbucket;
mod github;
mod gitlab;
mod http;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http_crate::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data};

use crate::credentials::{connection_token, member_token};
use crate::db::{Row, opt_text, text};
use crate::hooks::HookContext;
use crate::mappers::pull_request_event_data;
use crate::providers::{self, AdapterContext, RepositoryRef};
use crate::pull_requests::{linked_issues, pull_request_detail};
use crate::{
    Answer, Caller, MergeError, MergeState, Overrides, PendingEvent, Refusal, all, now, publish,
    validate,
};

use ::http as http_crate;

/// `MERGE_DIFF_SIDES`.
const SIDES: [&str; 2] = ["LEFT", "RIGHT"];
/// `MERGE_REVIEW_EVENTS`.
const REVIEW_EVENTS: [&str; 3] = ["approve", "request_changes", "comment"];
/// `MERGE_METHODS`.
const METHODS: [&str; 3] = ["merge", "squash", "rebase"];

/// A line comment sent with a review (`ReviewLineComment`).
pub(crate) struct LineComment {
    pub(crate) path: String,
    pub(crate) line: i64,
    pub(crate) side: String,
    pub(crate) body: String,
}

/// `submitMergeReviewSchema`, as validated.
pub(crate) struct ReviewInput {
    pub(crate) event: String,
    pub(crate) body: Option<String>,
    pub(crate) comments: Vec<LineComment>,
}

/// `createMergePullRequestCommentSchema`, as validated.
pub(crate) struct CommentInput {
    pub(crate) body: String,
    pub(crate) path: Option<String>,
    pub(crate) line: Option<i64>,
    pub(crate) side: Option<String>,
    pub(crate) in_reply_to_id: Option<String>,
}

/// `mergeMergePullRequestSchema`, as validated.
pub(crate) struct MergeInput {
    pub(crate) method: String,
    pub(crate) commit_title: Option<String>,
    pub(crate) commit_message: Option<String>,
}

// ── Validation ──────────────────────────────────────────────────────────────

fn read_line_comment(issues: &mut Issues, item: &Value) -> Option<LineComment> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let path = issues
        .text(fields, "path", Presence::Required, Some(1), None)
        .into_option();
    let line = issues
        .whole_number(
            fields,
            "line",
            Presence::Required,
            Number {
                min: Some(1.0),
                ..Number::default()
            },
        )
        .into_option();
    let side = issues
        .choice(fields, "side", Presence::Optional, &SIDES)
        .into_option()
        .unwrap_or_else(|| "RIGHT".to_owned());
    let body = issues
        .text_with(
            fields,
            "body",
            Presence::Required,
            Text::trimmed(Some(1), Some(65_000)),
        )
        .into_option();
    if issues.count() > before {
        return None;
    }
    Some(LineComment {
        path: path?,
        line: line?,
        side,
        body: body?,
    })
}

fn read_review(issues: &mut Issues, fields: &Map<String, Value>) -> ReviewInput {
    let start = issues.count();
    let event = issues
        .choice(fields, "event", Presence::Required, &REVIEW_EVENTS)
        .into_option()
        .unwrap_or_default();
    let body = issues
        .text_with(
            fields,
            "body",
            Presence::Optional,
            Text::trimmed(None, Some(65_000)),
        )
        .into_option();
    let comments = issues
        .list(
            fields,
            "comments",
            Presence::Optional,
            None,
            Some(100),
            read_line_comment,
        )
        .into_option()
        .unwrap_or_default();
    // `.refine((v) => v.event === 'approve' || Boolean(v.body) || (v.comments?.length ?? 0) > 0)`
    let given_comments = fields
        .get("comments")
        .and_then(Value::as_array)
        .is_some_and(|c| !c.is_empty());
    let given_body = body.as_deref().is_some_and(|b| !b.is_empty());
    if !crate::schemas::aborted(issues, start)
        && event != "approve"
        && !given_body
        && !given_comments
    {
        issues.custom("body", "Add a comment to this review");
    }
    ReviewInput {
        event,
        body,
        comments,
    }
}

fn read_comment(issues: &mut Issues, fields: &Map<String, Value>) -> CommentInput {
    let body = issues
        .text_with(
            fields,
            "body",
            Presence::Required,
            Text::trimmed(Some(1), Some(65_000)),
        )
        .into_option()
        .unwrap_or_default();
    let path = issues
        .text(fields, "path", Presence::Optional, Some(1), None)
        .into_option();
    let line = issues
        .whole_number(
            fields,
            "line",
            Presence::Optional,
            Number {
                min: Some(1.0),
                ..Number::default()
            },
        )
        .into_option();
    let side = issues
        .choice(fields, "side", Presence::Optional, &SIDES)
        .into_option();
    let in_reply_to_id = issues
        .text(fields, "inReplyToId", Presence::Optional, None, None)
        .into_option();
    CommentInput {
        body,
        path,
        line,
        side,
        in_reply_to_id,
    }
}

fn read_merge(issues: &mut Issues, fields: &Map<String, Value>) -> MergeInput {
    let method = issues
        .choice(fields, "method", Presence::Optional, &METHODS)
        .into_option()
        .unwrap_or_else(|| "merge".to_owned());
    let commit_title = issues
        .text_with(
            fields,
            "commitTitle",
            Presence::Optional,
            Text::trimmed(None, Some(500)),
        )
        .into_option();
    let commit_message = issues
        .text(
            fields,
            "commitMessage",
            Presence::Optional,
            None,
            Some(10_000),
        )
        .into_option();
    MergeInput {
        method,
        commit_title,
        commit_message,
    }
}

// ── The service ─────────────────────────────────────────────────────────────

/// Why a review call did not go through (`ReviewFailure`).
enum Failure {
    NotFound,
    AccountNotLinked(String),
    NotMergeable(String),
    Unsupported(String),
    ProviderError(String),
}

impl Failure {
    /// The route's answer (`failureResponse`).
    fn refusal(self, id: &str) -> Refusal {
        let (status, code, message) = match self {
            Self::NotFound => return Refusal::not_found("Pull request", Some(id)),
            Self::AccountNotLinked(message) => {
                (StatusCode::CONFLICT, "account_not_linked", message)
            }
            Self::NotMergeable(message) => (StatusCode::CONFLICT, "not_mergeable", message),
            Self::Unsupported(message) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "unsupported_method",
                message,
            ),
            Self::ProviderError(message) => (StatusCode::BAD_GATEWAY, "provider_error", message),
        };
        Refusal::Response(Box::new(
            (
                status,
                axum::Json(json!({ "error": { "code": code, "message": message } })),
            )
                .into_response(),
        ))
    }
}

/// What an operation is, for how a provider refusal reads (`Operation`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Read,
    Write,
    Merge,
}

/// `failureOf(err, operation)`: a provider's refusal as a failure; anything
/// else is thrown.
fn failure_of(error: MergeError, operation: Operation) -> Result<Failure, MergeError> {
    match error {
        MergeError::ProviderUnsupported {
            provider,
            capability,
        } => Ok(Failure::Unsupported(format!(
            "{provider} does not support {capability}"
        ))),
        MergeError::ProviderApi {
            status, message, ..
        } => {
            if operation == Operation::Merge && [405, 406, 409].contains(&status) {
                Ok(Failure::NotMergeable(message))
            } else {
                Ok(Failure::ProviderError(message))
            }
        }
        MergeError::GithubApi(status) => {
            Ok(Failure::ProviderError(format!("GitHub answered {status}")))
        }
        other => Err(other),
    }
}

/// A pull request with its repository and connection (`Target`).
struct Target {
    pr: Row,
    repository: Row,
    connection: Row,
}

impl Target {
    fn provider(&self) -> &str {
        text(&self.connection, "provider")
    }

    fn number(&self) -> i64 {
        self.pr.get("number").and_then(Value::as_i64).unwrap_or(0)
    }

    fn repository_ref(&self) -> RepositoryRef {
        RepositoryRef::of(&self.repository)
    }
}

/// `loadTarget(db, id)`: of a live repository on a live connection.
async fn load_target(db: &PgPool, id: &str) -> Result<Option<Target>, sqlx::Error> {
    let row: Option<(Value, Value, Value)> = sqlx::query_as(
        "select to_jsonb(p), to_jsonb(r), to_jsonb(c) from merge_pull_requests p \
         inner join merge_repositories r on r.id = p.repository_id \
         inner join merge_connections c on c.id = r.connection_id \
         where p.id = $1 and r.deleted_at is null and c.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(pr, repository, connection)| Target {
        pr: js_row(pr),
        repository: js_row(repository),
        connection: js_row(connection),
    }))
}

/// What a review call works with: the request's database, state and overrides.
struct Review<'a> {
    state: &'a MergeState,
    caller: &'a Caller,
}

impl Review<'_> {
    fn db(&self) -> &PgPool {
        &self.caller.db
    }

    fn overrides(&self) -> &Overrides {
        &self.caller.overrides
    }

    fn context(&self, target: &Target, token: Option<String>) -> AdapterContext {
        AdapterContext {
            state: self.state.clone(),
            overrides: self.overrides().clone(),
            connection: target.connection.clone(),
            member_token: token,
        }
    }

    /// `readContext(db, env, target)`: GitHub mints its own installation
    /// token; the other providers act with the connection's stored one.
    /// `None` when there is none.
    async fn read_context(&self, target: &Target) -> Result<Option<AdapterContext>, MergeError> {
        if target.provider() == "github" {
            return Ok(Some(self.context(target, None)));
        }
        let token =
            connection_token(self.db(), self.state, self.overrides(), &target.connection).await?;
        Ok(token.map(|token| self.context(target, Some(token.access_token))))
    }

    /// `writeContext(db, hooks, target)`: the member's verified account.
    async fn write_context(&self, target: &Target) -> Result<Option<AdapterContext>, MergeError> {
        let host = opt_text(&target.connection, "host");
        let token = member_token(
            self.db(),
            self.state,
            self.overrides(),
            &self.caller.user_id,
            target.provider(),
            host.as_deref(),
        )
        .await?;
        Ok(token.map(|token| self.context(target, Some(token.access_token))))
    }

    fn hooks(&self) -> HookContext {
        self.caller.hook_context(self.state)
    }

    /// `refreshMirror(hooks, target)`: re-reads the pull request and mirrors
    /// it as a webhook would. A provider that cannot answer leaves the
    /// stored mirror as it is: the member's action already happened.
    async fn refresh_mirror(&self, target: &Target) -> Vec<PendingEvent> {
        match self.try_refresh_mirror(target).await {
            Ok(events) => events,
            Err(error) => {
                tracing::error!(
                    ?error,
                    "[merge-api] refreshing the pull request mirror after a review action failed"
                );
                Vec::new()
            }
        }
    }

    async fn try_refresh_mirror(&self, target: &Target) -> Result<Vec<PendingEvent>, MergeError> {
        let Some(ctx) = self.read_context(target).await? else {
            return Ok(Vec::new());
        };
        let Some(fields) =
            providers::get_pull_request(&ctx, &target.repository_ref(), target.number()).await?
        else {
            return Ok(Vec::new());
        };
        let hooks = self.hooks();
        let outcome = crate::pr_sync::upsert_mirror(
            self.db(),
            &target.repository,
            fields,
            true,
            false,
            Some(&hooks),
        )
        .await?;
        Ok(outcome.events)
    }

    /// `refreshDecision(hooks, target)`: the provider's review decision after
    /// a review, stored when it changed.
    async fn refresh_decision(&self, target: &Target) -> Vec<PendingEvent> {
        match self.try_refresh_decision(target).await {
            Ok(events) => events,
            Err(error) => {
                tracing::error!(
                    ?error,
                    "[merge-api] reading the review decision after a review failed"
                );
                Vec::new()
            }
        }
    }

    async fn try_refresh_decision(&self, target: &Target) -> Result<Vec<PendingEvent>, MergeError> {
        let Some(ctx) = self.read_context(target).await? else {
            return Ok(Vec::new());
        };
        let Some(decision) =
            providers::review_decision(&ctx, &target.repository_ref(), target.number()).await?
        else {
            return Ok(Vec::new());
        };
        let before = target
            .pr
            .get("reviewDecision")
            .cloned()
            .unwrap_or(Value::Null);
        if before.as_str() == Some(decision) {
            return Ok(Vec::new());
        }
        let now = now();
        let row: Option<Value> = sqlx::query_scalar(
            "update merge_pull_requests set review_decision = $2, synced_at = $3::timestamptz, \
               updated_at = $3::timestamptz \
             where id = $1 returning to_jsonb(merge_pull_requests.*)",
        )
        .bind(text(&target.pr, "id"))
        .bind(decision)
        .bind(&now)
        .fetch_optional(self.db())
        .await?;
        let Some(row) = row.map(js_row) else {
            return Ok(Vec::new());
        };
        let id = text(&row, "id").to_owned();
        let issues = linked_issues(self.db(), std::slice::from_ref(&id)).await?;
        let issue_ids: Vec<String> = issues
            .get(&id)
            .map(|linked| linked.iter().map(|i| text(i, "id").to_owned()).collect())
            .unwrap_or_default();
        let mut changes = Map::new();
        changes.insert(
            "reviewDecision".to_owned(),
            json!({ "old": before, "new": decision }),
        );
        Ok(vec![
            PendingEvent::new(
                "merge_pull_request",
                "updated",
                &id,
                pull_request_event_data(&row, &issue_ids),
            )
            .with_changes(Some(changes)),
        ])
    }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/// Which read a route makes.
#[derive(Clone, Copy)]
enum Read {
    Files,
    Threads,
}

/// `GET /:id/files` and `/:id/threads`: everything the adapter read (capped).
async fn read(state: &MergeState, caller: &Caller, id: &str, what: Read) -> Answer {
    let review = Review { state, caller };
    let Some(target) = load_target(&caller.db, id).await? else {
        return Err(Failure::NotFound.refusal(id));
    };
    let outcome: Result<Vec<Value>, MergeError> = async {
        let Some(ctx) = review.read_context(&target).await? else {
            return Err(MergeError::provider_api(
                target.provider(),
                0,
                "The connection has no stored credentials",
            ));
        };
        let repository = target.repository_ref();
        let number = target.number();
        match (target.provider(), what) {
            ("github", Read::Files) => github::list_files(&ctx, &repository, number).await,
            ("github", Read::Threads) => github::list_threads(&ctx, &repository, number).await,
            ("gitlab", Read::Files) => gitlab::list_files(&ctx, &repository, number).await,
            ("gitlab", Read::Threads) => gitlab::list_threads(&ctx, &repository, number).await,
            ("bitbucket", Read::Files) => bitbucket::list_files(&ctx, &repository, number).await,
            ("bitbucket", Read::Threads) => {
                bitbucket::list_threads(&ctx, &repository, number).await
            }
            ("azure_devops", Read::Files) => {
                azure_devops::list_files(&ctx, &repository, number).await
            }
            ("azure_devops", Read::Threads) => {
                azure_devops::list_threads(&ctx, &repository, number).await
            }
            (other, _) => Err(MergeError::unsupported(other, "review")),
        }
    }
    .await;
    match outcome {
        Ok(rows) => Ok(all(rows)),
        Err(error) => Err(failure_of(error, Operation::Read)?.refusal(id)),
    }
}

/// `GET /pull-requests/:id/files`.
pub(crate) async fn files(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    read(&state, &caller, &id, Read::Files).await
}

/// `GET /pull-requests/:id/threads`.
pub(crate) async fn threads(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    read(&state, &caller, &id, Read::Threads).await
}

/// `NO_ACCOUNT(provider)`.
fn no_account(provider: &str) -> Failure {
    Failure::AccountNotLinked(format!(
        "Link your {provider} account to do this from WeldMerge"
    ))
}

/// `POST /pull-requests/:id/reviews`: the refreshed mirror.
pub(crate) async fn reviews(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, read_review)?;
    let review = Review {
        state: &state,
        caller: &caller,
    };
    let Some(target) = load_target(&caller.db, &id).await? else {
        return Err(Failure::NotFound.refusal(&id));
    };
    let Some(ctx) = review.write_context(&target).await? else {
        return Err(no_account(target.provider()).refusal(&id));
    };
    let repository = target.repository_ref();
    let number = target.number();
    let submitted = match target.provider() {
        "github" => github::submit_review(&ctx, &repository, number, &input).await,
        "gitlab" => gitlab::submit_review(&ctx, &repository, number, &input).await,
        "bitbucket" => bitbucket::submit_review(&ctx, &repository, number, &input).await,
        "azure_devops" => azure_devops::submit_review(&ctx, &repository, number, &input).await,
        other => Err(MergeError::unsupported(other, "review")),
    };
    if let Err(error) = submitted {
        return Err(failure_of(error, Operation::Write)?.refusal(&id));
    }
    let mut events = review.refresh_mirror(&target).await;
    events.extend(review.refresh_decision(&target).await);
    let detail = pull_request_detail(&caller.db, &id).await?;
    publish(&state, &caller.events, events);
    Ok(Data(json!({ "pullRequest": detail })).into_response())
}

/// `POST /pull-requests/:id/comments`.
pub(crate) async fn comments(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, read_comment)?;
    let has_path = input.path.as_deref().is_some_and(|p| !p.is_empty());
    let has_line = input.line.is_some_and(|l| l != 0);
    let replying = input
        .in_reply_to_id
        .as_deref()
        .is_some_and(|r| !r.is_empty());
    if has_path != has_line && !replying {
        return Err(Refusal::bad_request(
            "A line comment needs both path and line",
        ));
    }
    let review = Review {
        state: &state,
        caller: &caller,
    };
    let Some(target) = load_target(&caller.db, &id).await? else {
        return Err(Failure::NotFound.refusal(&id));
    };
    let Some(ctx) = review.write_context(&target).await? else {
        return Err(no_account(target.provider()).refusal(&id));
    };
    let repository = target.repository_ref();
    let number = target.number();
    let posted = match target.provider() {
        "github" => github::comment(&ctx, &repository, number, &input).await,
        "gitlab" => gitlab::comment(&ctx, &repository, number, &input).await,
        "bitbucket" => bitbucket::comment(&ctx, &repository, number, &input).await,
        "azure_devops" => azure_devops::comment(&ctx, &repository, number, &input).await,
        other => Err(MergeError::unsupported(other, "review")),
    };
    match posted {
        Ok(result) => Ok(Created(result).into_response()),
        Err(error) => Err(failure_of(error, Operation::Write)?.refusal(&id)),
    }
}

/// `POST /pull-requests/:id/merge`: the refreshed mirror.
pub(crate) async fn merge(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, read_merge)?;
    let review = Review {
        state: &state,
        caller: &caller,
    };
    let Some(target) = load_target(&caller.db, &id).await? else {
        return Err(Failure::NotFound.refusal(&id));
    };
    let Some(ctx) = review.write_context(&target).await? else {
        return Err(no_account(target.provider()).refusal(&id));
    };
    let state_now = text(&target.pr, "state");
    if state_now != "open" {
        return Err(
            Failure::NotMergeable(format!("This pull request is already {state_now}")).refusal(&id),
        );
    }
    let repository = target.repository_ref();
    let number = target.number();
    let merged = match target.provider() {
        "github" => github::merge(&ctx, &repository, number, &input).await,
        "gitlab" => gitlab::merge(&ctx, &repository, number, &input).await,
        "bitbucket" => bitbucket::merge(&ctx, &repository, number, &input).await,
        "azure_devops" => azure_devops::merge(&ctx, &repository, number, &input).await,
        other => Err(MergeError::unsupported(other, "review")),
    };
    if let Err(error) = merged {
        return Err(failure_of(error, Operation::Merge)?.refusal(&id));
    }
    let events = review.refresh_mirror(&target).await;
    let detail = pull_request_detail(&caller.db, &id).await?;
    publish(&state, &caller.events, events);
    Ok(Data(json!({ "pullRequest": detail })).into_response())
}
