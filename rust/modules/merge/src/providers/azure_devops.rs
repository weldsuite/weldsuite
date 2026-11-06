//! Azure DevOps behind the provider seam: the pure mappers of
//! `@weldsuite/merge-domain/providers/azure-devops` and merge-api's
//! `services/providers/azure-devops/*` (Git REST `7.1`, connection adapter,
//! service hooks, Microsoft Entra ID OAuth). The connection's `host` is the
//! organisation URL (`https://dev.azure.com/<org>`); a repository's
//! `externalId` is its GUID, `externalProject` the project name.
//!
//! Azure DevOps pull requests carry no "updated" time: a REST read is
//! stamped with the time it was made, a service hook with the event's
//! `createdDate`.

use base64::Engine as _;
use serde_json::{Map, Value, json};
use weldsuite_ports::OutboundHttp;

use super::http::{ApiClient, Body, bearer, credentials_from_token, request_json};
use super::shared::{
    arr, constant_time_equal, header, id_string, lower_login, nullable_date, obj,
    parse_provider_date, str_of, trim_trailing_slashes,
};
use super::{
    AdapterContext, OAuthUser, RemoteRepository, RepositoryRef, WebhookEvent, WebhookTarget,
};
use crate::MergeError;
use crate::credentials::StoredCredentials;
use crate::github::MirrorFields;
use crate::github_client::encode_uri_component as encode;

const API_VERSION: &str = "api-version=7.1";
const PAGE: usize = 100;
const PAGES: usize = 3;
const BACKFILL_DAYS: f64 = 30.0;
const BACKFILL_CAP: usize = 300;

/// `azureOrganizationBase(ctx)`: a connection without one has not chosen
/// its organisation yet (a 409).
fn organization_base(ctx: &AdapterContext) -> Result<String, MergeError> {
    let host = ctx.host().map(|h| h.trim().to_owned()).unwrap_or_default();
    if host.is_empty() {
        return Err(MergeError::ProviderCredentials(
            "The Azure DevOps connection has no organisation yet".to_owned(),
        ));
    }
    Ok(trim_trailing_slashes(&host).to_owned())
}

fn client(ctx: &AdapterContext) -> Result<ApiClient<'_>, MergeError> {
    Ok(ApiClient {
        ctx,
        provider: "azure_devops",
        base: organization_base(ctx)?,
    })
}

fn project_of(repository: &RepositoryRef) -> String {
    repository.external_project.clone().unwrap_or_else(|| {
        repository
            .full_name
            .split('/')
            .next()
            .unwrap_or_default()
            .to_owned()
    })
}

/// `/{project}/_apis/git/repositories/{id}`.
fn repo_path(repository: &RepositoryRef) -> String {
    format!(
        "/{}/_apis/git/repositories/{}",
        encode(&project_of(repository)),
        encode(&repository.external_id)
    )
}

// ── Mappers ────────────────────────────────────────────────────────────────

/// `azureBranchName(ref)`: `refs/heads/main` → `main`.
fn branch_name(reference: Option<&Value>) -> Option<String> {
    let text = reference
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())?;
    Some(text.strip_prefix("refs/heads/").unwrap_or(text).to_owned())
}

/// `azurePullRequestUrl(organizationUrl, pr)`.
fn pull_request_url(organization_url: &str, pr: &Value) -> String {
    if let Some(web) = pr
        .get("_links")
        .and_then(|l| l.get("web"))
        .and_then(|w| w.get("href"))
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty())
    {
        return web.to_owned();
    }
    let repository = pr.get("repository");
    let project = repository
        .and_then(|r| r.get("project"))
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let repo = repository
        .and_then(|r| r.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    format!(
        "{}/{}/_git/{}/pullrequest/{}",
        trim_trailing_slashes(organization_url),
        encode(project),
        encode(repo),
        crate::github::js_string(pr.get("pullRequestId"))
    )
}

fn pr_state(status: &str) -> &'static str {
    match status {
        "completed" => "merged",
        "abandoned" => "closed",
        _ => "open",
    }
}

/// `pendingReviewers(reviewers)`.
fn pending_reviewers(reviewers: Option<&Value>) -> Vec<Value> {
    arr(reviewers)
        .iter()
        .filter_map(|reviewer| {
            let vote = reviewer.get("vote").and_then(Value::as_f64).unwrap_or(0.0);
            if vote != 0.0 {
                return None;
            }
            if crate::github::truthy(reviewer.get("isContainer")) {
                let name = str_of(reviewer.get("displayName"))?;
                return Some(json!({ "kind": "team", "login": name }));
            }
            let login = lower_login(reviewer.get("uniqueName"))?;
            Some(json!({
                "kind": "user",
                "login": login,
                "avatarUrl": reviewer.get("imageUrl").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            }))
        })
        .collect()
}

/// `mapAzurePullRequest(pr, { organizationUrl, updatedAt })`.
fn map_pull_request(pr: &Value, organization_url: &str, updated_at: &str) -> MirrorFields {
    let state = pr_state(pr.get("status").and_then(Value::as_str).unwrap_or_default());
    let closed_at = nullable_date(pr.get("closedDate"))
        .or_else(|| (state != "open").then(|| updated_at.to_owned()));
    let created_by = pr.get("createdBy");
    MirrorFields {
        external_id: crate::github::js_string(pr.get("pullRequestId")),
        number: pr.get("pullRequestId").cloned().unwrap_or(Value::Null),
        title: pr.get("title").cloned().unwrap_or(Value::Null),
        body: str_of(pr.get("description")).map_or(Value::Null, |d| json!(d)),
        state,
        draft: pr.get("isDraft") == Some(&Value::Bool(true)),
        url: json!(pull_request_url(organization_url, pr)),
        author_login: lower_login(created_by.and_then(|c| c.get("uniqueName"))),
        author_avatar_url: created_by
            .and_then(|c| c.get("imageUrl"))
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Null),
        head_ref: branch_name(pr.get("sourceRefName")).map_or(Value::Null, |b| json!(b)),
        base_ref: branch_name(pr.get("targetRefName")).map_or(Value::Null, |b| json!(b)),
        head_sha: pr
            .get("lastMergeSourceCommit")
            .and_then(|c| c.get("commitId"))
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Null),
        additions: Value::Null,
        deletions: Value::Null,
        changed_files: Value::Null,
        requested_reviewers: pending_reviewers(pr.get("reviewers")),
        labels: arr(pr.get("labels"))
            .iter()
            .filter_map(|l| {
                str_of(l.get("name")).map(|name| json!({ "name": name, "color": null }))
            })
            .collect(),
        provider_created_at: Some(parse_provider_date(pr.get("creationDate"))),
        provider_updated_at: Some(updated_at.to_owned()),
        merged_at: if state == "merged" {
            closed_at.clone()
        } else {
            None
        },
        closed_at: if state == "open" { None } else { closed_at },
    }
}

/// `azureReviewDecision(reviewers)`.
fn review_decision_of(reviewers: Option<&Value>) -> Option<&'static str> {
    let votes: Vec<f64> = arr(reviewers)
        .iter()
        .filter(|r| !crate::github::truthy(r.get("isContainer")))
        .map(|r| r.get("vote").and_then(Value::as_f64).unwrap_or(0.0))
        .collect();
    if votes.iter().any(|v| *v < 0.0) {
        return Some("changes_requested");
    }
    if votes.iter().any(|v| *v > 0.0) {
        return Some("approved");
    }
    (!votes.is_empty()).then_some("review_required")
}

/// `azureChecksStatus(statuses, evaluations)`.
fn checks_status_of(statuses: &[Value], evaluations: &[Value]) -> Option<&'static str> {
    let states: Vec<&str> = statuses
        .iter()
        .filter_map(|s| s.get("state").and_then(Value::as_str))
        .filter(|s| !s.is_empty() && *s != "notSet" && *s != "notApplicable")
        .collect();
    let policies: Vec<&str> = evaluations
        .iter()
        .filter(|e| {
            e.get("configuration").and_then(|c| c.get("isBlocking")) != Some(&Value::Bool(false))
        })
        .filter_map(|e| e.get("status").and_then(Value::as_str))
        .filter(|s| !s.is_empty() && *s != "notApplicable")
        .collect();
    if states.is_empty() && policies.is_empty() {
        return None;
    }
    let failed = states.contains(&"failed")
        || states.contains(&"error")
        || policies.contains(&"rejected")
        || policies.contains(&"broken");
    if failed {
        return Some("failure");
    }
    if states.contains(&"pending") || policies.contains(&"queued") || policies.contains(&"running")
    {
        return Some("pending");
    }
    Some(
        if states.contains(&"succeeded") || policies.contains(&"approved") {
            "success"
        } else {
            "neutral"
        },
    )
}

// ── Service hooks: verification and parsing ────────────────────────────────

/// `verifyAzureBasicAuth(headers, secret)`: the basic-auth password.
pub(crate) fn verify_basic_auth(headers: &Map<String, Value>, secret: &str) -> bool {
    let Some(value) = header(headers, "authorization").filter(|v| !v.is_empty()) else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("basic") else {
        return false;
    };
    if !rest.starts_with(char::is_whitespace) {
        return false;
    }
    let encoded = value[value.len() - rest.len()..].trim();
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    // `atob` yields one char per byte.
    let decoded: String = bytes.iter().map(|b| char::from(*b)).collect();
    let Some(separator) = decoded.find(':') else {
        return false;
    };
    constant_time_equal(&decoded[separator + 1..], secret)
}

/// `azureOrganizationUrl(payload)`.
fn organization_url(payload: &Map<String, Value>) -> String {
    let containers = obj(payload.get("resourceContainers"));
    let base =
        str_of(obj(containers.and_then(|c| c.get("collection"))).and_then(|c| c.get("baseUrl")))
            .or_else(|| {
                str_of(
                    obj(containers.and_then(|c| c.get("account"))).and_then(|a| a.get("baseUrl")),
                )
            });
    if let Some(base) = base {
        return trim_trailing_slashes(&base).to_owned();
    }
    let resource_url =
        str_of(obj(payload.get("resource")).and_then(|r| r.get("url"))).unwrap_or_default();
    let Ok(url) = url::Url::parse(&resource_url) else {
        return String::new();
    };
    let Some(org) = url.path().split('/').find(|s| !s.is_empty()) else {
        return String::new();
    };
    format!("{}/{org}", url.origin().ascii_serialization())
}

/// `parseAzureWebhook(headers, body)`.
pub(crate) fn parse_webhook(body: &Value) -> Vec<WebhookEvent> {
    let Some(payload) = body.as_object() else {
        return Vec::new();
    };
    let (Some(event_type), Some(resource)) = (
        str_of(payload.get("eventType")),
        obj(payload.get("resource")),
    ) else {
        return Vec::new();
    };
    if !matches!(
        event_type.as_str(),
        "git.pullrequest.created" | "git.pullrequest.updated" | "git.pullrequest.merged"
    ) {
        return Vec::new();
    }
    let Some(repository) = id_string(obj(resource.get("repository")).and_then(|r| r.get("id")))
    else {
        return Vec::new();
    };
    let Some(number) = resource
        .get("pullRequestId")
        .filter(|n| n.is_number())
        .and_then(Value::as_f64)
    else {
        return Vec::new();
    };
    #[allow(clippy::cast_possible_truncation)]
    let number = number as i64;
    let raw = Value::Object(resource.clone());
    let updated = parse_provider_date(payload.get("createdDate"));
    let pull_request = map_pull_request(&raw, &organization_url(payload), &updated);
    let head_sha = pull_request.head_sha.as_str().map(str::to_owned);
    let open = pull_request.state == "open";
    let mut events = vec![WebhookEvent::PullRequest {
        repository: repository.clone(),
        pull_request: Box::new(pull_request),
    }];
    if !arr(resource.get("reviewers")).is_empty() {
        // Deliveries arrive out of order and the decision is written without
        // a staleness check: the receiver re-reads the votes rather than
        // trust this payload's.
        events.push(WebhookEvent::Review {
            repository: repository.clone(),
            number,
            decision: None,
        });
    }
    if let Some(sha) = head_sha.filter(|s| !s.is_empty() && open) {
        // A policy or status change shows up as an update: re-read the checks.
        events.push(WebhookEvent::Checks {
            repository,
            head_sha: sha,
            status: None,
            numbers: vec![number],
        });
    }
    events
}

// ── Connection adapter ─────────────────────────────────────────────────────

fn remote_repository(repo: &Value) -> RemoteRepository {
    let project = repo.get("project");
    let project_name = project
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    RemoteRepository {
        external_id: repo
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        full_name: json!(format!(
            "{project_name}/{}",
            repo.get("name").and_then(Value::as_str).unwrap_or_default()
        )),
        private: json!(
            project
                .and_then(|p| p.get("visibility"))
                .and_then(Value::as_str)
                != Some("public")
        ),
        default_branch: branch_name(repo.get("defaultBranch")),
        url: repo
            .get("webUrl")
            .and_then(Value::as_str)
            .map(str::to_owned),
        external_project: (!project_name.is_empty()).then(|| project_name.to_owned()),
    }
}

pub(crate) async fn list_available_repositories(
    ctx: &AdapterContext,
) -> Result<Vec<RemoteRepository>, MergeError> {
    let body = client(ctx)?
        .get(&format!("/_apis/git/repositories?{API_VERSION}"))
        .await?;
    Ok(arr(body.as_ref().and_then(|b| b.get("value")))
        .iter()
        .filter(|repo| repo.get("isDisabled") != Some(&Value::Bool(true)))
        .map(remote_repository)
        .collect())
}

pub(crate) async fn get_repository(
    ctx: &AdapterContext,
    external_id: &str,
) -> Result<Option<RemoteRepository>, MergeError> {
    Ok(client(ctx)?
        .get(&format!(
            "/_apis/git/repositories/{}?{API_VERSION}",
            encode(external_id)
        ))
        .await?
        .as_ref()
        .map(remote_repository))
}

async fn pull_requests_for(
    api: &ApiClient<'_>,
    repository: &RepositoryRef,
    criteria: &str,
    cap: usize,
) -> Result<Vec<Value>, MergeError> {
    let mut out: Vec<Value> = Vec::new();
    let mut page = 0;
    while page < PAGES && out.len() < cap {
        let body = api
            .get(&format!(
                "{}/pullrequests?{criteria}&$top={PAGE}&$skip={}&{API_VERSION}",
                repo_path(repository),
                page * PAGE
            ))
            .await?;
        let rows = arr(body.as_ref().and_then(|b| b.get("value")));
        let count = rows.len();
        out.extend(rows);
        if count < PAGE {
            break;
        }
        page += 1;
    }
    out.truncate(cap);
    Ok(out)
}

pub(crate) async fn list_pull_requests_for_backfill(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
) -> Result<Vec<MirrorFields>, MergeError> {
    let api = client(ctx)?;
    let now = crate::now_ms();
    let since = encode(
        &weldsuite_kit::validation::js_iso_from_millis(
            now - BACKFILL_DAYS * 24.0 * 60.0 * 60.0 * 1000.0,
        )
        .unwrap_or_default(),
    );
    let mut out: Vec<Value> = Vec::new();
    for criteria in [
        "searchCriteria.status=active".to_owned(),
        format!(
            "searchCriteria.status=completed&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime={since}"
        ),
        format!(
            "searchCriteria.status=abandoned&searchCriteria.queryTimeRangeType=closed&searchCriteria.minTime={since}"
        ),
    ] {
        if out.len() >= BACKFILL_CAP {
            break;
        }
        let rows = pull_requests_for(&api, repository, &criteria, BACKFILL_CAP - out.len()).await?;
        out.extend(rows);
    }
    let organization = organization_base(ctx)?;
    let updated = weldsuite_kit::validation::js_iso_from_millis(now).unwrap_or_default();
    Ok(out
        .iter()
        .map(|pr| map_pull_request(pr, &organization, &updated))
        .collect())
}

pub(crate) async fn get_pull_request(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<MirrorFields>, MergeError> {
    let pr = client(ctx)?
        .get(&format!(
            "{}/pullrequests/{number}?{API_VERSION}",
            repo_path(repository)
        ))
        .await?;
    let organization = organization_base(ctx)?;
    let updated = crate::now();
    Ok(pr.map(|pr| map_pull_request(&pr, &organization, &updated)))
}

pub(crate) async fn review_decision(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<&'static str>, MergeError> {
    let pr = client(ctx)?
        .get(&format!(
            "{}/pullrequests/{number}?{API_VERSION}",
            repo_path(repository)
        ))
        .await?;
    Ok(pr.and_then(|pr| review_decision_of(pr.get("reviewers"))))
}

pub(crate) async fn checks_status(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    head_sha: &str,
    pull_request_number: Option<i64>,
) -> Result<Option<&'static str>, MergeError> {
    let api = client(ctx)?;
    let base = repo_path(repository);
    let Some(number) = pull_request_number else {
        let body = api
            .get(&format!(
                "{base}/commits/{}/statuses?{API_VERSION}",
                encode(head_sha)
            ))
            .await?;
        return Ok(checks_status_of(
            &arr(body.as_ref().and_then(|b| b.get("value"))),
            &[],
        ));
    };
    let Some(pr) = api
        .get(&format!("{base}/pullrequests/{number}?{API_VERSION}"))
        .await?
    else {
        return Ok(None);
    };
    let statuses = api
        .get(&format!(
            "{base}/pullRequests/{number}/statuses?{API_VERSION}"
        ))
        .await?;
    let project_id = pr
        .get("repository")
        .and_then(|r| r.get("project"))
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let mut evaluations: Vec<Value> = Vec::new();
    if let Some(project_id) = project_id {
        let review = match pr.get("codeReviewId").filter(|v| !v.is_null()) {
            Some(id) => crate::github::js_string(Some(id)),
            None => number.to_string(),
        };
        let artifact = encode(&format!(
            "vstfs:///CodeReview/CodeReviewId/{project_id}/{review}"
        ));
        let body = api
            .get(&format!(
                "/{}/_apis/policy/evaluations?artifactId={artifact}&api-version=7.1-preview.1",
                encode(&project_of(repository))
            ))
            .await?;
        evaluations = arr(body.as_ref().and_then(|b| b.get("value")));
    }
    Ok(checks_status_of(
        &arr(statuses.as_ref().and_then(|b| b.get("value"))),
        &evaluations,
    ))
}

// ── Service hook subscriptions ─────────────────────────────────────────────

const HOOK_EVENTS: [&str; 3] = [
    "git.pullrequest.created",
    "git.pullrequest.updated",
    "git.pullrequest.merged",
];
const HOOK_USER: &str = "weldmerge";

async fn delete_subscription(api: &ApiClient<'_>, id: &str) -> Result<(), MergeError> {
    match api
        .send(
            "DELETE",
            &format!("/_apis/hooks/subscriptions/{}?{API_VERSION}", encode(id)),
            None,
        )
        .await
    {
        Err(error) if error.is_status(&[404]) => Ok(()),
        other => other.map(|_| ()),
    }
}

/// `registerAzureWebhook(ctx, repository, target)`: one subscription per
/// pull request event; the hook id is the three ids joined by commas.
pub(crate) async fn register_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    target: &WebhookTarget,
) -> Result<String, MergeError> {
    let api = client(ctx)?;
    let repo = api
        .get(&format!(
            "/_apis/git/repositories/{}?{API_VERSION}",
            encode(&repository.external_id)
        ))
        .await?;
    let Some(project_id) = repo
        .as_ref()
        .and_then(|r| r.get("project"))
        .and_then(|p| p.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return Err(MergeError::provider_api(
            "azure_devops",
            404,
            "The Azure DevOps repository was not found",
        ));
    };
    let mut ids: Vec<String> = Vec::new();
    for event_type in HOOK_EVENTS {
        let created = api
            .send(
                "POST",
                &format!("/_apis/hooks/subscriptions?{API_VERSION}"),
                Some(json!({
                    "publisherId": "tfs",
                    "eventType": event_type,
                    "resourceVersion": "1.0",
                    "consumerId": "webHooks",
                    "consumerActionId": "httpRequest",
                    "publisherInputs": { "projectId": project_id, "repository": repository.external_id },
                    "consumerInputs": {
                        "url": target.url,
                        "basicAuthUsername": HOOK_USER,
                        "basicAuthPassword": target.secret,
                    },
                })),
            )
            .await;
        match created {
            Ok(created) => ids.push(crate::github::js_string(
                created.as_ref().and_then(|c| c.get("id")),
            )),
            Err(error) => {
                // Leave nothing half-registered.
                for id in &ids {
                    let _ = delete_subscription(&api, id).await;
                }
                return Err(error);
            }
        }
    }
    Ok(ids.join(","))
}

pub(crate) async fn delete_webhook(
    ctx: &AdapterContext,
    webhook_id: &str,
) -> Result<(), MergeError> {
    let api = client(ctx)?;
    for id in webhook_id.split(',').filter(|id| !id.is_empty()) {
        delete_subscription(&api, id).await?;
    }
    Ok(())
}

// ── OAuth (Microsoft Entra ID) ─────────────────────────────────────────────

const AUTHORITY: &str = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
const SCOPE: &str = "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access";
const VSSPS: &str = "https://app.vssps.visualstudio.com/_apis";

fn client_of(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<(String, String), MergeError> {
    match (
        env("AZURE_DEVOPS_CLIENT_ID"),
        env("AZURE_DEVOPS_CLIENT_SECRET"),
    ) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(MergeError::ProviderNotConfigured("azure_devops".to_owned())),
    }
}

pub(crate) fn authorize_url(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    state: &str,
    redirect_uri: &str,
) -> Result<String, MergeError> {
    let (client_id, _) = client_of(env)?;
    let query = super::http::form_encode(&[
        ("client_id".to_owned(), client_id),
        ("response_type".to_owned(), "code".to_owned()),
        ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ("response_mode".to_owned(), "query".to_owned()),
        ("scope".to_owned(), SCOPE.to_owned()),
        ("state".to_owned(), state.to_owned()),
    ]);
    Ok(format!("{AUTHORITY}/authorize?{query}"))
}

pub(crate) async fn exchange_code(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    code: &str,
    redirect_uri: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    let body = request_json(
        http,
        "azure_devops",
        "POST",
        &format!("{AUTHORITY}/token"),
        &[],
        Body::Form(vec![
            ("client_id".to_owned(), client_id),
            ("client_secret".to_owned(), client_secret),
            ("grant_type".to_owned(), "authorization_code".to_owned()),
            ("code".to_owned(), code.to_owned()),
            ("redirect_uri".to_owned(), redirect_uri.to_owned()),
            ("scope".to_owned(), SCOPE.to_owned()),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "azure_devops")
}

pub(crate) async fn refresh(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    refresh_token: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    let body = request_json(
        http,
        "azure_devops",
        "POST",
        &format!("{AUTHORITY}/token"),
        &[],
        Body::Form(vec![
            ("client_id".to_owned(), client_id),
            ("client_secret".to_owned(), client_secret),
            ("grant_type".to_owned(), "refresh_token".to_owned()),
            ("refresh_token".to_owned(), refresh_token.to_owned()),
            ("scope".to_owned(), SCOPE.to_owned()),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "azure_devops")
}

pub(crate) async fn current_user(
    http: &OutboundHttp,
    access_token: &str,
) -> Result<OAuthUser, MergeError> {
    let profile = request_json(
        http,
        "azure_devops",
        "GET",
        &format!("{VSSPS}/profile/profiles/me?api-version=7.1"),
        &bearer(access_token),
        Body::None,
    )
    .await?
    .ok_or_else(|| {
        MergeError::Unexpected("Azure DevOps answered the profile with an empty body".to_owned())
    })?;
    let text = |key: &str| profile.get(key).and_then(Value::as_str).map(str::to_owned);
    let id = text("id").unwrap_or_default();
    Ok(OAuthUser {
        login: text("emailAddress")
            .or_else(|| text("publicAlias"))
            .unwrap_or_else(|| id.clone())
            .to_lowercase(),
        external_id: id,
        display_name: text("displayName"),
        avatar_url: None,
    })
}

/// `listAzureOrganizations(accessToken, memberId)`: `(name, url)`.
pub(crate) async fn list_organizations(
    http: &OutboundHttp,
    access_token: &str,
    member_id: &str,
) -> Result<Vec<(String, String)>, MergeError> {
    let body = request_json(
        http,
        "azure_devops",
        "GET",
        &format!(
            "{VSSPS}/accounts?memberId={}&api-version=7.1",
            encode(member_id)
        ),
        &bearer(access_token),
        Body::None,
    )
    .await?;
    Ok(arr(body.as_ref().and_then(|b| b.get("value")))
        .iter()
        .map(|account| {
            let name = account
                .get("accountName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let url = format!("https://dev.azure.com/{name}");
            (name, url)
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_basic_auth() {
        let token = base64::engine::general_purpose::STANDARD.encode("weldmerge:s3cret");
        let headers = json!({ "Authorization": format!("Basic {token}") });
        let headers = headers.as_object().expect("an object");
        assert!(verify_basic_auth(headers, "s3cret"));
        assert!(!verify_basic_auth(headers, "other"));
    }

    #[test]
    fn decides_votes_and_checks() {
        assert_eq!(
            review_decision_of(Some(&json!([{ "vote": 10 }, { "vote": -5 }]))),
            Some("changes_requested")
        );
        assert_eq!(
            review_decision_of(Some(&json!([{ "vote": 0 }]))),
            Some("review_required")
        );
        assert_eq!(review_decision_of(Some(&json!([]))), None);
        assert_eq!(
            checks_status_of(
                &[json!({ "state": "succeeded" })],
                &[json!({ "status": "running" })]
            ),
            Some("pending")
        );
        assert_eq!(checks_status_of(&[], &[]), None);
    }

    #[test]
    fn a_delivery_leaves_the_decision_to_a_re_read() {
        // Deliveries arrive out of order: this one's votes may be older than the stored decision.
        let delivery = json!({
            "eventType": "git.pullrequest.updated",
            "createdDate": "2026-11-01T10:00:00.000Z",
            "resource": {
                "pullRequestId": 77, "status": "active", "title": "T",
                "repository": { "id": "repo-guid" },
                "lastMergeSourceCommit": { "commitId": "abc123" },
                "reviewers": [{ "uniqueName": "a@acme.com", "vote": 10 }],
            },
            "resourceContainers": { "collection": { "baseUrl": "https://dev.azure.com/acme/" } },
        });
        let events = parse_webhook(&delivery);
        assert!(events.iter().any(|event| matches!(
            event,
            WebhookEvent::Review {
                number: 77,
                decision: None,
                ..
            }
        )));
    }
}
