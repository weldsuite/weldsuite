//! The provider seam (`services/providers/types.ts` and `registry.ts`): one
//! module per provider (`github`, `gitlab`, `bitbucket`, `azure_devops`)
//! behind the functions here, which pick the implementation by the
//! connection's provider. Everything above the seam (pull request sync,
//! issue sync, review) works on the neutral shapes below.
//!
//! No request in the adapters: they get an [`AdapterContext`] and return
//! plain values. Every outbound call is deterministic for a given input (the
//! worker's tests stub them by method and URL, and conformance compares them).

pub(crate) mod azure_devops;
pub(crate) mod bitbucket;
pub(crate) mod github;
pub(crate) mod gitlab;
pub(crate) mod http;
pub(crate) mod shared;

use serde_json::{Map, Value};
use weldsuite_ports::OutboundHttp;

use crate::credentials::open_credentials;
use crate::db::{Row, opt_text, text};
use crate::github::MirrorFields;
use crate::github_client::GithubClient;
use crate::{MergeError, MergeState, Overrides};

/// `MERGE_PROVIDERS`.
pub(crate) const PROVIDERS: [&str; 4] = ["github", "gitlab", "bitbucket", "azure_devops"];

/// What an adapter call acts on (`AdapterContext`): the module's state and
/// the request's overrides (env, HTTP), the connection, and optionally the
/// member's own token.
#[derive(Clone)]
pub(crate) struct AdapterContext {
    pub(crate) state: MergeState,
    pub(crate) overrides: Overrides,
    pub(crate) connection: Row,
    /// A member's own access token (review and merge run as the member), or
    /// the connection's resolved and refreshed one. Absent: the adapter
    /// authenticates with the connection (GitHub: an installation token).
    pub(crate) member_token: Option<String>,
}

impl AdapterContext {
    /// The connection's provider.
    pub(crate) fn provider(&self) -> &str {
        text(&self.connection, "provider")
    }

    /// The connection's `host` (self-managed GitLab, the Azure DevOps
    /// organisation URL).
    pub(crate) fn host(&self) -> Option<String> {
        opt_text(&self.connection, "host")
    }

    /// `ctx.env.<name>` when set.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        self.overrides.env_set(&self.state, name)
    }

    /// The outbound HTTP port.
    pub(crate) fn http(&self) -> Result<OutboundHttp, MergeError> {
        self.overrides
            .outbound(&self.state)
            .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))
    }

    /// `createGithubClient(env, connection.externalAccountId)`.
    pub(crate) fn github(&self) -> GithubClient {
        self.overrides
            .github(&self.state, text(&self.connection, "externalAccountId"))
    }

    /// `accessTokenOf(provider, ctx)`: `memberToken` when set, else the
    /// connection's stored token as it is (not refreshed); none is a 401.
    pub(crate) fn access_token(&self, provider: &str) -> Result<String, MergeError> {
        if let Some(token) = &self.member_token {
            return Ok(token.clone());
        }
        let keyring = self.overrides.keyring(&self.state);
        open_credentials(
            &keyring,
            self.connection.get("credentials").and_then(Value::as_str),
        )
        .map(|stored| stored.access_token)
        .ok_or_else(|| {
            MergeError::provider_api(
                provider,
                401,
                format!("No {provider} credentials are available for this call"),
            )
        })
    }
}

/// The repository an adapter call is about (`RepositoryRef`).
#[derive(Debug, Clone)]
pub(crate) struct RepositoryRef {
    pub(crate) external_id: String,
    /// `owner/name`.
    pub(crate) full_name: String,
    /// Bitbucket workspace slug, Azure DevOps project, GitLab namespace path.
    pub(crate) external_project: Option<String>,
    #[allow(dead_code)]
    pub(crate) default_branch: Option<String>,
}

impl RepositoryRef {
    /// `repositoryRef(repository)`.
    pub(crate) fn of(repository: &Row) -> Self {
        Self {
            external_id: text(repository, "externalId").to_owned(),
            full_name: text(repository, "fullName").to_owned(),
            external_project: opt_text(repository, "externalProject"),
            default_branch: opt_text(repository, "defaultBranch"),
        }
    }
}

/// `RemoteRepository`.
#[derive(Debug, Clone)]
pub(crate) struct RemoteRepository {
    pub(crate) external_id: String,
    pub(crate) full_name: Value,
    pub(crate) private: Value,
    pub(crate) default_branch: Option<String>,
    pub(crate) url: Option<String>,
    pub(crate) external_project: Option<String>,
}

/// `NormalizedIssue`.
#[derive(Debug, Clone)]
pub(crate) struct NormalizedIssue {
    pub(crate) external_id: String,
    pub(crate) number: i64,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) body: String,
    /// `open` or `closed`.
    pub(crate) state: &'static str,
    /// `completed`, `not_planned` or none.
    pub(crate) state_reason: Option<&'static str>,
    pub(crate) labels: Vec<String>,
    pub(crate) assignee_login: Option<String>,
    #[allow(dead_code)]
    pub(crate) author_login: Option<String>,
    #[allow(dead_code)]
    pub(crate) author_avatar_url: Option<String>,
    /// ISO; `None` for an invalid date.
    pub(crate) updated_at: Option<String>,
}

/// `NormalizedIssueComment`.
#[derive(Debug, Clone)]
pub(crate) struct NormalizedIssueComment {
    pub(crate) external_id: String,
    pub(crate) issue_number: i64,
    pub(crate) body: String,
    pub(crate) author_login: Option<String>,
    pub(crate) author_avatar_url: Option<String>,
    pub(crate) created_at: Option<String>,
    #[allow(dead_code)]
    pub(crate) updated_at: Option<String>,
}

/// `NormalizedWebhookEvent`.
#[derive(Debug, Clone)]
pub(crate) enum WebhookEvent {
    PullRequest {
        repository: String,
        pull_request: Box<MirrorFields>,
    },
    /// `decision` `None`: the provider only says "something changed".
    Review {
        repository: String,
        number: i64,
        decision: Option<&'static str>,
    },
    Checks {
        repository: String,
        head_sha: String,
        status: Option<&'static str>,
        numbers: Vec<i64>,
    },
    Issue {
        repository: String,
        action: String,
        issue: NormalizedIssue,
    },
    IssueComment {
        repository: String,
        action: &'static str,
        comment: NormalizedIssueComment,
    },
    #[allow(dead_code)]
    RepositoryRemoved { repository: String },
}

impl WebhookEvent {
    /// `event.repositoryExternalId`.
    pub(crate) fn repository(&self) -> &str {
        match self {
            Self::PullRequest { repository, .. }
            | Self::Review { repository, .. }
            | Self::Checks { repository, .. }
            | Self::Issue { repository, .. }
            | Self::IssueComment { repository, .. }
            | Self::RepositoryRemoved { repository } => repository,
        }
    }
}

/// `WebhookTarget`.
pub(crate) struct WebhookTarget {
    pub(crate) url: String,
    pub(crate) secret: String,
}

/// `IssueSyncListOptions`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ListIssuesOptions {
    /// `open`, `closed` or `all` (default `open` on GitHub, `all` on GitLab).
    pub(crate) state: Option<&'static str>,
    pub(crate) limit: Option<usize>,
}

/// `IssueWriteInput`: each field set or left out.
#[allow(clippy::option_option)]
#[derive(Debug, Clone, Default)]
pub(crate) struct IssueWriteInput {
    pub(crate) title: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) state: Option<&'static str>,
    /// `Some(None)`: no reason.
    pub(crate) state_reason: Option<Option<&'static str>>,
    pub(crate) labels: Option<Vec<String>>,
    /// `Some(None)`: unassign.
    pub(crate) assignee_login: Option<Option<String>>,
}

/// `OAuthUser`.
#[derive(Debug, Clone)]
pub(crate) struct OAuthUser {
    pub(crate) external_id: String,
    pub(crate) login: String,
    pub(crate) display_name: Option<String>,
    pub(crate) avatar_url: Option<String>,
}

// ── Connection adapter ─────────────────────────────────────────────────────

/// `adapterFor(provider).listAvailableRepositories(ctx)`.
pub(crate) async fn list_available_repositories(
    ctx: &AdapterContext,
) -> Result<Vec<RemoteRepository>, MergeError> {
    match ctx.provider() {
        "github" => github::list_available_repositories(ctx).await,
        "gitlab" => gitlab::list_available_repositories(ctx).await,
        "bitbucket" => bitbucket::list_available_repositories(ctx).await,
        "azure_devops" => azure_devops::list_available_repositories(ctx).await,
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// `adapterFor(provider).getRepository(ctx, externalId, externalProject)`.
pub(crate) async fn get_repository(
    ctx: &AdapterContext,
    external_id: &str,
    external_project: Option<&str>,
) -> Result<Option<RemoteRepository>, MergeError> {
    match ctx.provider() {
        "github" => github::get_repository(ctx, external_id).await,
        "gitlab" => gitlab::get_repository(ctx, external_id).await,
        "bitbucket" => bitbucket::get_repository(ctx, external_id, external_project).await,
        "azure_devops" => azure_devops::get_repository(ctx, external_id).await,
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// `adapterFor(provider).listPullRequestsForBackfill(ctx, repository)`.
pub(crate) async fn list_pull_requests_for_backfill(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
) -> Result<Vec<MirrorFields>, MergeError> {
    match ctx.provider() {
        "github" => github::list_pull_requests_for_backfill(ctx, repository).await,
        "gitlab" => gitlab::list_pull_requests_for_backfill(ctx, repository).await,
        "bitbucket" => bitbucket::list_pull_requests_for_backfill(ctx, repository).await,
        "azure_devops" => azure_devops::list_pull_requests_for_backfill(ctx, repository).await,
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// `adapterFor(provider).getPullRequest(ctx, repository, number)`.
pub(crate) async fn get_pull_request(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<MirrorFields>, MergeError> {
    match ctx.provider() {
        "github" => github::get_pull_request(ctx, repository, number).await,
        "gitlab" => gitlab::get_pull_request(ctx, repository, number).await,
        "bitbucket" => bitbucket::get_pull_request(ctx, repository, number).await,
        "azure_devops" => azure_devops::get_pull_request(ctx, repository, number).await,
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// `adapterFor(provider).reviewDecision(ctx, repository, number)`.
pub(crate) async fn review_decision(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<&'static str>, MergeError> {
    match ctx.provider() {
        "github" => github::review_decision(ctx, repository, number).await,
        "gitlab" => gitlab::review_decision(ctx, repository, number).await,
        "bitbucket" => bitbucket::review_decision(ctx, repository, number).await,
        "azure_devops" => azure_devops::review_decision(ctx, repository, number).await,
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// `adapterFor(provider).checksStatus(ctx, repository, headSha, number?)`.
pub(crate) async fn checks_status(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    head_sha: &str,
    pull_request_number: Option<i64>,
) -> Result<Option<&'static str>, MergeError> {
    match ctx.provider() {
        "github" => github::checks_status(ctx, repository, head_sha).await,
        "gitlab" => gitlab::checks_status(ctx, repository, head_sha).await,
        "bitbucket" => bitbucket::checks_status(ctx, repository, head_sha).await,
        "azure_devops" => {
            azure_devops::checks_status(ctx, repository, head_sha, pull_request_number).await
        }
        other => Err(MergeError::unsupported(other, "connections")),
    }
}

/// Whether the provider registers a hook per repository (GitHub's App
/// delivers events itself).
pub(crate) fn registers_webhooks(provider: &str) -> bool {
    matches!(provider, "gitlab" | "bitbucket" | "azure_devops")
}

/// `adapter.registerWebhook(ctx, repository, target)`.
pub(crate) async fn register_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    target: &WebhookTarget,
) -> Result<String, MergeError> {
    match ctx.provider() {
        "gitlab" => gitlab::register_webhook(ctx, repository, target).await,
        "bitbucket" => bitbucket::register_webhook(ctx, repository, target).await,
        "azure_devops" => azure_devops::register_webhook(ctx, repository, target).await,
        other => Err(MergeError::unsupported(other, "webhooks")),
    }
}

/// `adapter.deleteWebhook(ctx, repository, webhookId)`.
pub(crate) async fn delete_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    webhook_id: &str,
) -> Result<(), MergeError> {
    match ctx.provider() {
        "gitlab" => gitlab::delete_webhook(ctx, repository, webhook_id).await,
        "bitbucket" => bitbucket::delete_webhook(ctx, repository, webhook_id).await,
        "azure_devops" => azure_devops::delete_webhook(ctx, webhook_id).await,
        _ => Ok(()),
    }
}

/// `adapter.verifyWebhook(headers, rawBody, secret)`; `None` for a provider
/// without one.
pub(crate) fn verify_webhook(
    provider: &str,
    headers: &Map<String, Value>,
    raw_body: &str,
    secret: &str,
) -> Option<bool> {
    match provider {
        "gitlab" => Some(gitlab::verify_token(headers, secret)),
        "bitbucket" => Some(bitbucket::verify_signature(headers, raw_body, secret)),
        "azure_devops" => Some(azure_devops::verify_basic_auth(headers, secret)),
        _ => None,
    }
}

/// `adapter.parseWebhook(headers, body)`.
pub(crate) fn parse_webhook(
    provider: &str,
    headers: &Map<String, Value>,
    body: &Value,
) -> Vec<WebhookEvent> {
    match provider {
        "gitlab" => gitlab::parse_webhook(headers, body),
        "bitbucket" => bitbucket::parse_webhook(headers, body),
        "azure_devops" => azure_devops::parse_webhook(body),
        _ => Vec::new(),
    }
}

// ── Issue sync adapter (GitHub, GitLab) ───────────────────────────────────

/// `providerModule(provider).issues !== undefined`.
pub(crate) fn has_issues(provider: &str) -> bool {
    matches!(provider, "github" | "gitlab")
}

/// `ISSUE_SYNC_MODES_BY_PROVIDER[provider]`.
pub(crate) fn issue_sync_modes(provider: &str) -> &'static [&'static str] {
    if has_issues(provider) {
        &["off", "import", "two_way"]
    } else {
        &["off"]
    }
}

/// `issueAdapterFor(provider).listIssues(ctx, repository, options)`.
pub(crate) async fn list_issues(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    options: &ListIssuesOptions,
) -> Result<Vec<NormalizedIssue>, MergeError> {
    match ctx.provider() {
        "github" => github::list_issues(ctx, repository, options).await,
        "gitlab" => gitlab::list_issues(ctx, repository, options).await,
        other => Err(MergeError::unsupported(other, "issue sync")),
    }
}

/// `issueAdapterFor(provider).createIssue(ctx, repository, input)`.
pub(crate) async fn create_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    input: IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    match ctx.provider() {
        "github" => github::create_issue(ctx, repository, input).await,
        "gitlab" => gitlab::create_issue(ctx, repository, input).await,
        other => Err(MergeError::unsupported(other, "issue sync")),
    }
}

/// `issueAdapterFor(provider).updateIssue(ctx, repository, number, input)`.
pub(crate) async fn update_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    match ctx.provider() {
        "github" => github::update_issue(ctx, repository, number, input).await,
        "gitlab" => gitlab::update_issue(ctx, repository, number, input).await,
        other => Err(MergeError::unsupported(other, "issue sync")),
    }
}

/// `issueAdapterFor(provider).createComment(ctx, repository, number, body)`.
pub(crate) async fn create_comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: &str,
) -> Result<NormalizedIssueComment, MergeError> {
    match ctx.provider() {
        "github" => github::create_comment(ctx, repository, number, body).await,
        "gitlab" => gitlab::create_comment(ctx, repository, number, body).await,
        other => Err(MergeError::unsupported(other, "issue sync")),
    }
}

// ── OAuth ─────────────────────────────────────────────────────────────────

/// `oauthFor(provider).authorizeUrl(env, { state, redirectUri })`.
pub(crate) fn authorize_url(
    provider: &str,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    state: &str,
    redirect_uri: &str,
) -> Result<String, MergeError> {
    match provider {
        "github" => github::authorize_url(env, state, redirect_uri),
        "gitlab" => gitlab::authorize_url(env, state, redirect_uri),
        "bitbucket" => bitbucket::authorize_url(env, state, redirect_uri),
        "azure_devops" => azure_devops::authorize_url(env, state, redirect_uri),
        other => Err(MergeError::unsupported(other, "OAuth")),
    }
}

/// `oauthFor(provider).exchangeCode(env, { code, redirectUri })`.
pub(crate) async fn exchange_code(
    provider: &str,
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    code: &str,
    redirect_uri: &str,
) -> Result<crate::credentials::StoredCredentials, MergeError> {
    match provider {
        "github" => github::exchange_code(http, env, code, redirect_uri).await,
        "gitlab" => gitlab::exchange_code(http, env, code, redirect_uri).await,
        "bitbucket" => bitbucket::exchange_code(http, env, code, redirect_uri).await,
        "azure_devops" => azure_devops::exchange_code(http, env, code, redirect_uri).await,
        other => Err(MergeError::unsupported(other, "OAuth")),
    }
}

/// `oauthFor(provider).refresh(env, { refreshToken, host })`.
pub(crate) async fn refresh(
    provider: &str,
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    refresh_token: &str,
    host: Option<&str>,
) -> Result<crate::credentials::StoredCredentials, MergeError> {
    match provider {
        "github" => github::refresh(http, env, refresh_token).await,
        "gitlab" => gitlab::refresh(http, env, refresh_token, host).await,
        "bitbucket" => bitbucket::refresh(http, env, refresh_token).await,
        "azure_devops" => azure_devops::refresh(http, env, refresh_token).await,
        other => Err(MergeError::unsupported(other, "OAuth")),
    }
}

/// `oauthFor(provider).currentUser(env, { accessToken })`.
pub(crate) async fn current_user(
    provider: &str,
    http: &OutboundHttp,
    access_token: &str,
) -> Result<OAuthUser, MergeError> {
    match provider {
        "github" => github::current_user(http, access_token).await,
        "gitlab" => gitlab::current_user(http, None, access_token).await,
        "bitbucket" => bitbucket::current_user(http, access_token).await,
        "azure_devops" => azure_devops::current_user(http, access_token).await,
        other => Err(MergeError::unsupported(other, "OAuth")),
    }
}
