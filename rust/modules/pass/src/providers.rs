//! The deploy targets a vault environment is pushed to: Cloudflare Workers
//! secrets and Pages environment variables (pass-api goes through
//! `@weldsuite/cloudflare-deploy`, the official `cloudflare` SDK), and Vercel
//! project environment variables (`providers/vercel.ts`, plain `fetch`).
//!
//! These are third-party calls, so they go through [`HttpTransport`]: reqwest
//! in a deployment, the test's `fetch` stub in conformance mode, where the
//! harness compares method, URL and body with TypeScript's. To match, this
//! makes the SDK's requests as the SDK makes them: its URLs and path
//! encoding, its JSON bodies, two retries on 408/409/429/5xx and connection
//! failures (`x-should-retry`, `retry-after-ms`, `retry-after`, else 0.5 s
//! doubling with jitter), a 20 s timeout, and its error messages.
//!
//! The EU edition's note: a push sends decrypted values to these US
//! providers; whether the EU edition offers sync at all is the operator's
//! decision, not this code's.

use std::time::Duration;

use serde_json::{Value, json};

use crate::transport::{HttpTransport, OutboundRequest, OutboundResponse, TransportError};
use crate::js::JsRecord;
use crate::jsjson::Js;

const CLOUDFLARE_API: &str = "https://api.cloudflare.com/client/v4";
const VERCEL_API: &str = "https://api.vercel.com";
const BULK_SECRET_LIMIT: usize = 100;
const CLOUDFLARE_TIMEOUT: Duration = Duration::from_secs(20);
const CLOUDFLARE_MAX_RETRIES: u32 = 2;

pub(crate) const VERCEL_REDEPLOY_NOTICE: &str =
    "Vercel applies these on the next deployment — redeploy to pick them up.";

/// `ProviderError`: shown to the user, never carries a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProviderError(pub(crate) String);

/// `listProviders()`.
pub(crate) fn list_providers() -> Value {
    json!([
        { "id": "cloudflare_workers", "label": "Cloudflare Workers" },
        { "id": "cloudflare_pages", "label": "Cloudflare Pages" },
        { "id": "vercel", "label": "Vercel" },
    ])
}

/// `redeployNotice(config)`.
pub(crate) fn redeploy_notice(config: &Value) -> Value {
    match config["provider"].as_str() {
        Some("vercel") => Value::from(VERCEL_REDEPLOY_NOTICE),
        Some("cloudflare_pages") => Value::from(
            "Cloudflare Pages applies these on the next deployment — redeploy to pick them up.",
        ),
        Some("cloudflare_workers") => Value::from(
            "Cloudflare rolls a new Worker version when secrets change; a redeploy is not needed.",
        ),
        _ => Value::Null,
    }
}

/// One key's outcome on a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushDetail {
    pub(crate) key: String,
    pub(crate) action: &'static str,
    pub(crate) message: Option<String>,
}

impl PushDetail {
    fn new(key: &str, action: &'static str) -> Self {
        Self {
            key: key.to_owned(),
            action,
            message: None,
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        match &self.message {
            Some(message) => json!({ "key": self.key, "action": self.action, "message": message }),
            None => json!({ "key": self.key, "action": self.action }),
        }
    }
}

/// `PushResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct PushResult {
    pub(crate) pushed: i64,
    pub(crate) removed: i64,
    pub(crate) failed: i64,
    pub(crate) details: Vec<PushDetail>,
}

/// `VerifyResult`: `{ ok: true, identity }` or `{ ok: false, message }`.
pub(crate) enum VerifyResult {
    Ok(Value),
    Failed(String),
}

impl VerifyResult {
    pub(crate) fn is_ok(&self) -> bool {
        matches!(self, Self::Ok(_))
    }

    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Ok(identity) => json!({ "ok": true, "identity": identity }),
            Self::Failed(message) => json!({ "ok": false, "message": message }),
        }
    }
}

/// A config field as text (`config.accountId`), `undefined` when missing.
fn field(config: &Value, key: &str) -> String {
    match &config[key] {
        Value::String(text) => text.clone(),
        Value::Null => "undefined".to_owned(),
        other => other.to_string(),
    }
}

/// `getProvider(id).verify(token, config)`. `Err` is the `ProviderError` the
/// route answers with 502 (a config for another provider, an unknown
/// provider); a token that does not work is `Ok(VerifyResult::Failed)`.
pub(crate) async fn verify(
    http: &dyn HttpTransport,
    provider: &str,
    token: &str,
    config: &Value,
) -> Result<VerifyResult, ProviderError> {
    match provider {
        "cloudflare_workers" => {
            if config["provider"] != "cloudflare_workers" {
                return Err(ProviderError(
                    "Config does not describe a Cloudflare Workers target".to_owned(),
                ));
            }
            let account_id = field(config, "accountId");
            let script = field(config, "scriptName");
            let cloudflare = Cloudflare { http, token };
            let outcome = async {
                let name = cloudflare.account_name(&account_id).await?;
                cloudflare.worker_secret_names(&account_id, &script).await?;
                Ok::<_, String>(format!("{name} → {script}"))
            }
            .await;
            Ok(match outcome {
                Ok(identity) => VerifyResult::Ok(Value::String(identity)),
                Err(message) => VerifyResult::Failed(message),
            })
        }
        "cloudflare_pages" => {
            if config["provider"] != "cloudflare_pages" {
                return Err(ProviderError(
                    "Config does not describe a Cloudflare Pages target".to_owned(),
                ));
            }
            let account_id = field(config, "accountId");
            let project = field(config, "projectName");
            let environment = field(config, "environment");
            let cloudflare = Cloudflare { http, token };
            let outcome = async {
                let name = cloudflare.account_name(&account_id).await?;
                cloudflare
                    .pages_env_var_names(&account_id, &project, &environment)
                    .await?;
                Ok::<_, String>(format!("{name} → {project} ({environment})"))
            }
            .await;
            Ok(match outcome {
                Ok(identity) => VerifyResult::Ok(Value::String(identity)),
                Err(message) => VerifyResult::Failed(message),
            })
        }
        "vercel" => {
            if config["provider"] != "vercel" {
                return Err(ProviderError(
                    "Config does not describe a Vercel target".to_owned(),
                ));
            }
            let project_id = field(config, "projectId");
            let vercel = Vercel {
                http,
                token,
                team_id: team_id(config),
            };
            let path = format!("/v9/projects/{}", encode_uri_component(&project_id));
            Ok(match vercel.fetch("GET", &path, None).await {
                Ok(project) => {
                    let identity = [project.get("name"), project.get("id")]
                        .into_iter()
                        .flatten()
                        .find(|value| !matches!(value, Js::Null))
                        .map_or_else(|| Value::String(project_id.clone()), Js::to_value);
                    VerifyResult::Ok(identity)
                }
                Err(ProviderError(message)) => VerifyResult::Failed(message),
            })
        }
        other => Err(ProviderError(format!(
            "Unknown deploy target provider: {other}"
        ))),
    }
}

/// `getProvider(id).push(request)`: `Err` is what `pushToTarget` records as
/// the failed run's error.
pub(crate) async fn push(
    http: &dyn HttpTransport,
    provider: &str,
    token: &str,
    config: &Value,
    secrets: &JsRecord,
    prune: bool,
) -> Result<PushResult, ProviderError> {
    match provider {
        "cloudflare_workers" => {
            if config["provider"] != "cloudflare_workers" {
                return Err(ProviderError(
                    "Config does not describe a Cloudflare Workers target".to_owned(),
                ));
            }
            let account_id = field(config, "accountId");
            let script = field(config, "scriptName");
            let cloudflare = Cloudflare { http, token };
            let remove = if prune {
                let remote = cloudflare
                    .worker_secret_names(&account_id, &script)
                    .await
                    .map_err(ProviderError)?;
                remote.into_iter().filter(|key| !secrets.has(key)).collect()
            } else {
                Vec::new()
            };
            let (written, removed) = cloudflare
                .put_worker_secrets(&account_id, &script, secrets, &remove)
                .await
                .map_err(ProviderError)?;
            Ok(cloudflare_result(&written, &removed))
        }
        "cloudflare_pages" => {
            if config["provider"] != "cloudflare_pages" {
                return Err(ProviderError(
                    "Config does not describe a Cloudflare Pages target".to_owned(),
                ));
            }
            let account_id = field(config, "accountId");
            let project = field(config, "projectName");
            let environment = field(config, "environment");
            let cloudflare = Cloudflare { http, token };
            let remove = if prune {
                let remote = cloudflare
                    .pages_env_var_names(&account_id, &project, &environment)
                    .await
                    .map_err(ProviderError)?;
                remote.into_iter().filter(|key| !secrets.has(key)).collect()
            } else {
                Vec::new()
            };
            let (written, removed) = cloudflare
                .put_pages_env_vars(&account_id, &project, &environment, secrets, &remove)
                .await
                .map_err(ProviderError)?;
            Ok(cloudflare_result(&written, &removed))
        }
        "vercel" => {
            if config["provider"] != "vercel" {
                return Err(ProviderError(
                    "Config does not describe a Vercel target".to_owned(),
                ));
            }
            let vercel = Vercel {
                http,
                token,
                team_id: team_id(config),
            };
            vercel.push(config, secrets, prune).await
        }
        other => Err(ProviderError(format!(
            "Unknown deploy target provider: {other}"
        ))),
    }
}

fn cloudflare_result(written: &[String], removed: &[String]) -> PushResult {
    let details = written
        .iter()
        .map(|key| PushDetail::new(key, "pushed"))
        .chain(removed.iter().map(|key| PushDetail::new(key, "removed")))
        .collect();
    PushResult {
        pushed: i64::try_from(written.len()).unwrap_or(i64::MAX),
        removed: i64::try_from(removed.len()).unwrap_or(i64::MAX),
        failed: 0,
        details,
    }
}

/// `config.teamId`, when set and not empty (`if (init.teamId)`).
fn team_id(config: &Value) -> Option<String> {
    match &config["teamId"] {
        Value::String(team) if !team.is_empty() => Some(team.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// URL encoding
// ---------------------------------------------------------------------------

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    percent_encode(value, |b| {
        b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')')
    })
}

/// The SDK's `encodeURIPath`: everything but RFC 3986 `pchar`.
fn encode_uri_path(value: &str) -> String {
    percent_encode(value, |b| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
            )
    })
}

fn percent_encode(value: &str, keep: impl Fn(u8) -> bool) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if keep(byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The SDK's `path` tag: encoded parameters, and a refusal of `.`/`..`
/// segments with the SDK's own message (a `CloudflareError`).
fn sdk_path(statics: &[&str], params: &[&str]) -> Result<String, String> {
    let mut path = String::new();
    for (index, part) in statics.iter().enumerate() {
        path.push_str(part);
        if let Some(param) = params.get(index) {
            path.push_str(&encode_uri_path(param));
        }
    }
    let mut invalid: Vec<(usize, usize, String)> = Vec::new();
    let mut start = 0;
    for segment in path.split('/') {
        let lower = segment.to_ascii_lowercase();
        let units = lower.replace("%2e", ".");
        if !segment.is_empty() && matches!(units.as_str(), "." | "..") {
            invalid.push((
                start,
                segment.len(),
                format!("Value \"{segment}\" can't be safely passed as a path parameter"),
            ));
        }
        start += segment.len() + 1;
    }
    if invalid.is_empty() {
        return Ok(path);
    }
    let mut underline = String::new();
    let mut last = 0;
    for (start, length, _) in &invalid {
        underline.push_str(&" ".repeat(start.saturating_sub(last)));
        underline.push_str(&"^".repeat(*length));
        last = start + length;
    }
    let errors: Vec<&str> = invalid.iter().map(|(_, _, e)| e.as_str()).collect();
    Err(format!(
        "Path parameters result in path with invalid segments:\n{}\n{path}\n{underline}",
        errors.join("\n")
    ))
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

struct Cloudflare<'a> {
    http: &'a dyn HttpTransport,
    token: &'a str,
}

/// Why an SDK call failed, before `toDeployError` words it.
enum SdkError {
    /// A response with this status and body (`APIError`).
    Status { status: u16, body: String },
    /// `fetch` threw: `Connection error.` / `Request timed out.`.
    Connection { timed_out: bool },
    /// Anything else the SDK throws, with its message.
    Other(String),
}

/// `toDeployError(err, what)`.
fn deploy_error(error: SdkError, what: &str) -> String {
    match error {
        SdkError::Other(message) => format!("{what}: {message}"),
        SdkError::Connection { timed_out } => format!(
            "{what}: {}",
            if timed_out {
                "Request timed out."
            } else {
                "Connection error."
            }
        ),
        SdkError::Status { status, body } => {
            let parsed = Js::parse(&body);
            let errors: Vec<String> = parsed
                .as_ref()
                .and_then(|json| json.get("errors"))
                .map(|errors| match errors {
                    Js::Array(items) => items
                        .iter()
                        .map(|item| {
                            item.get("message")
                                .filter(|m| !matches!(m, Js::Null))
                                .map_or_else(String::new, Js::to_js_string)
                        })
                        .filter(|message| !message.is_empty())
                        .collect(),
                    _ => Vec::new(),
                })
                .unwrap_or_default();
            let detail = if errors.is_empty() {
                api_error_message(status, parsed.as_ref(), &body)
            } else {
                errors.join("; ")
            };
            format!("{what}: {detail}")
        }
    }
}

/// `APIError.makeMessage(status, errJSON, errMessage)`.
fn api_error_message(status: u16, parsed: Option<&Js>, text: &str) -> String {
    let error = parsed.filter(|json| json.truthy());
    let message = match error {
        Some(json) => match json.get("message").filter(|m| m.truthy()) {
            Some(Js::String(message)) => message.clone(),
            Some(message) => message.stringify(),
            None => json.stringify(),
        },
        // `errMessage`: the text whenever the parsed body is falsy.
        None => text.to_owned(),
    };
    if message.is_empty() {
        format!("{status} status code (no body)")
    } else {
        format!("{status} {message}")
    }
}

/// `/timed? ?out/i`.
fn mentions_timeout(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("timed out")
        || lower.contains("timedout")
        || lower.contains("time out")
        || lower.contains("timeout")
}

/// The SDK's default backoff: 0.5 s doubling to 8 s, minus up to 25 %.
fn default_retry_delay(retries_remaining: u32) -> Duration {
    let retry = CLOUDFLARE_MAX_RETRIES - retries_remaining;
    let seconds = (0.5 * f64::from(2_u32.pow(retry))).min(8.0);
    let mut byte = [0_u8; 1];
    let jitter = if getrandom::fill(&mut byte).is_ok() {
        1.0 - f64::from(byte[0]) / 255.0 * 0.25
    } else {
        1.0
    };
    Duration::from_secs_f64(seconds * jitter)
}

/// `retryRequest`'s wait: `retry-after-ms`, `retry-after` (seconds), else
/// the default backoff. A `retry-after` date is not honoured; the default
/// applies.
fn retry_delay(response: Option<&OutboundResponse>, retries_remaining: u32) -> Duration {
    let header = |name: &str| response.and_then(|r| r.header(name));
    if let Some(millis) = header("retry-after-ms").and_then(|v| v.trim().parse::<f64>().ok())
        && millis.is_finite()
        && millis >= 0.0
    {
        return Duration::from_secs_f64((millis / 1000.0).min(60.0));
    }
    if let Some(seconds) = header("retry-after").and_then(|v| v.trim().parse::<f64>().ok())
        && seconds.is_finite()
        && seconds >= 0.0
    {
        return Duration::from_secs_f64(seconds.min(60.0));
    }
    default_retry_delay(retries_remaining)
}

impl Cloudflare<'_> {
    /// One SDK request with its retries; the parsed body on a 2xx.
    async fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Js, SdkError> {
        let url = url::Url::parse(&format!("{CLOUDFLARE_API}{path}"))
            .map_err(|error| SdkError::Other(error.to_string()))?
            .to_string();
        let mut retries_remaining = CLOUDFLARE_MAX_RETRIES;
        loop {
            let retry_count = CLOUDFLARE_MAX_RETRIES - retries_remaining;
            let mut headers = vec![
                ("accept".to_owned(), "application/json".to_owned()),
                ("authorization".to_owned(), format!("Bearer {}", self.token)),
                ("x-stainless-retry-count".to_owned(), retry_count.to_string()),
                ("x-stainless-timeout".to_owned(), "20".to_owned()),
            ];
            if body.is_some() {
                headers.push(("content-type".to_owned(), "application/json".to_owned()));
            }
            let request = OutboundRequest {
                method: method.to_owned(),
                url: url.clone(),
                headers,
                body: body.map(Value::to_string),
                timeout: Some(CLOUDFLARE_TIMEOUT),
            };
            match self.http.send(request).await {
                Err(error) => {
                    if retries_remaining > 0 {
                        tokio::time::sleep(default_retry_delay(retries_remaining)).await;
                        retries_remaining -= 1;
                        continue;
                    }
                    let timed_out = match error {
                        TransportError::TimedOut => true,
                        TransportError::Failed(text) => mentions_timeout(&text),
                    };
                    return Err(SdkError::Connection { timed_out });
                }
                Ok(response) if !(200..300).contains(&response.status) => {
                    let should_retry = match response.header("x-should-retry") {
                        Some("true") => true,
                        Some("false") => false,
                        _ => matches!(response.status, 408 | 409 | 429) || response.status >= 500,
                    };
                    if retries_remaining > 0 && should_retry {
                        tokio::time::sleep(retry_delay(Some(&response), retries_remaining)).await;
                        retries_remaining -= 1;
                        continue;
                    }
                    return Err(SdkError::Status {
                        status: response.status,
                        body: response.text(),
                    });
                }
                Ok(response) => return Ok(parse_response(&response)),
            }
        }
    }

    /// `verifyAccountAccess`: the account's name, else its id.
    async fn account_name(&self, account_id: &str) -> Result<String, String> {
        let what = format!("Cloudflare account {account_id} is not reachable with this token");
        let path = sdk_path(&["/accounts/", ""], &[account_id])
            .map_err(|message| deploy_error(SdkError::Other(message), &what))?;
        let body = self
            .request("GET", &path, None)
            .await
            .map_err(|error| deploy_error(error, &what))?;
        Ok(body
            .get("result")
            .and_then(|account| account.get("name"))
            .filter(|name| !matches!(name, Js::Null))
            .map_or_else(|| account_id.to_owned(), Js::to_js_string))
    }

    /// `listWorkerSecretNames`.
    async fn worker_secret_names(&self, account_id: &str, script: &str) -> Result<Vec<String>, String> {
        let what = format!("Could not list secrets on Worker \"{script}\"");
        let path = sdk_path(
            &["/accounts/", "/workers/scripts/", "/secrets"],
            &[account_id, script],
        )
        .map_err(|message| deploy_error(SdkError::Other(message), &what))?;
        let body = self
            .request("GET", &path, None)
            .await
            .map_err(|error| deploy_error(error, &what))?;
        let names = match body.get("result").filter(|result| result.truthy()) {
            Some(Js::Array(items)) => items
                .iter()
                .filter_map(|secret| secret.get("name").filter(|name| name.truthy()))
                .map(Js::to_js_string)
                .collect(),
            _ => Vec::new(),
        };
        Ok(names)
    }

    /// `putWorkerSecrets`: batches of 100 through the bulk endpoint.
    async fn put_worker_secrets(
        &self,
        account_id: &str,
        script: &str,
        secrets: &JsRecord,
        remove: &[String],
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let entries: Vec<(String, Value)> = secrets
            .entries()
            .map(|(name, text)| {
                (
                    name.to_owned(),
                    json!({ "name": name, "text": text, "type": "secret_text" }),
                )
            })
            .chain(remove.iter().map(|name| (name.clone(), Value::Null)))
            .collect();
        if entries.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let what = format!("Could not write secrets to Worker \"{script}\"");
        for batch in entries.chunks(BULK_SECRET_LIMIT) {
            let path = sdk_path(
                &["/accounts/", "/workers/scripts/", "/secrets-bulk"],
                &[account_id, script],
            )
            .map_err(|message| deploy_error(SdkError::Other(message), &what))?;
            let body = json!({ "secrets": batch.iter().cloned().collect::<serde_json::Map<String, Value>>() });
            self.request("PATCH", &path, Some(&body))
                .await
                .map_err(|error| deploy_error(error, &what))?;
        }
        Ok((secrets.keys().map(str::to_owned).collect(), remove.to_vec()))
    }

    /// `listPagesEnvVarNames`: the names in the order the API lists them.
    async fn pages_env_var_names(
        &self,
        account_id: &str,
        project: &str,
        environment: &str,
    ) -> Result<Vec<String>, String> {
        let what = format!("Could not read Pages project \"{project}\"");
        let path = sdk_path(&["/accounts/", "/pages/projects/", ""], &[account_id, project])
            .map_err(|message| deploy_error(SdkError::Other(message), &what))?;
        let body = self
            .request("GET", &path, None)
            .await
            .map_err(|error| deploy_error(error, &what))?;
        Ok(body
            .get("result")
            .and_then(|project| project.get("deployment_configs"))
            .and_then(|configs| configs.get(environment))
            .and_then(|config| config.get("env_vars"))
            .filter(|vars| !matches!(vars, Js::Null))
            .map(Js::keys)
            .unwrap_or_default())
    }

    /// `putPagesEnvVars`: one PATCH of the deployment config.
    async fn put_pages_env_vars(
        &self,
        account_id: &str,
        project: &str,
        environment: &str,
        vars: &JsRecord,
        remove: &[String],
    ) -> Result<(Vec<String>, Vec<String>), String> {
        let mut env_vars = serde_json::Map::new();
        for (name, value) in vars.entries() {
            env_vars.insert(
                name.to_owned(),
                json!({ "type": "secret_text", "value": value }),
            );
        }
        for name in remove {
            env_vars.insert(name.clone(), Value::Null);
        }
        if env_vars.is_empty() {
            return Ok((Vec::new(), Vec::new()));
        }
        let what = format!("Could not write env vars to Pages project \"{project}\"");
        let path = sdk_path(&["/accounts/", "/pages/projects/", ""], &[account_id, project])
            .map_err(|message| deploy_error(SdkError::Other(message), &what))?;
        let mut configs = serde_json::Map::new();
        configs.insert(environment.to_owned(), json!({ "env_vars": env_vars }));
        let body = json!({ "deployment_configs": configs });
        self.request("PATCH", &path, Some(&body))
            .await
            .map_err(|error| deploy_error(error, &what))?;
        Ok((vars.keys().map(str::to_owned).collect(), remove.to_vec()))
    }
}

/// `defaultParseResponse`: `null` for a 204, JSON for a JSON content type
/// (empty for a `content-length: 0`), else the text.
fn parse_response(response: &OutboundResponse) -> Js {
    if response.status == 204 {
        return Js::Null;
    }
    let media = response
        .header("content-type")
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .unwrap_or_default();
    if media.contains("application/json") || media.ends_with("+json") {
        if response.header("content-length") == Some("0") {
            return Js::Null;
        }
        return Js::parse(&response.text()).unwrap_or(Js::Null);
    }
    Js::String(response.text())
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

struct Vercel<'a> {
    http: &'a dyn HttpTransport,
    token: &'a str,
    team_id: Option<String>,
}

/// `String(error)` as the bridge or a transport reports it, as `err.message`.
fn error_message(text: &str) -> String {
    match text.split_once(": ") {
        Some((name, message)) if name.ends_with("Error") && !name.contains(' ') => {
            message.to_owned()
        }
        _ => text.to_owned(),
    }
}

impl Vercel<'_> {
    /// `vercelFetch`: the parsed body (`{}` when empty), or the
    /// `ProviderError` for a failed call.
    async fn fetch(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Js, ProviderError> {
        let mut url = url::Url::parse(&format!("{VERCEL_API}{path}"))
            .map_err(|error| ProviderError(format!("Could not reach the Vercel API: {error}")))?;
        if let Some(team) = &self.team_id {
            set_query_param(&mut url, "teamId", team);
        }
        let request = OutboundRequest {
            method: method.to_owned(),
            url: url.to_string(),
            headers: vec![
                ("authorization".to_owned(), format!("Bearer {}", self.token)),
                ("content-type".to_owned(), "application/json".to_owned()),
            ],
            body: body.map(Value::to_string),
            timeout: None,
        };
        let response = self.http.send(request).await.map_err(|error| {
            let message = match error {
                TransportError::TimedOut => "The operation was aborted due to timeout".to_owned(),
                TransportError::Failed(text) => error_message(&text),
            };
            ProviderError(format!("Could not reach the Vercel API: {message}"))
        })?;
        let text = response.text();
        if !(200..300).contains(&response.status) {
            let mut detail = crate::js::utf16_slice(&text, 0, 200);
            if let Some(message) = Js::parse(&text)
                .as_ref()
                .and_then(|parsed| parsed.get("error"))
                .and_then(|error| error.get("message"))
                .filter(|message| message.truthy())
            {
                detail = message.to_js_string();
            }
            return Err(ProviderError(format!(
                "Vercel API {}: {detail}",
                response.status
            )));
        }
        if text.is_empty() {
            return Ok(Js::Object(Vec::new()));
        }
        Js::parse(&text).ok_or_else(|| {
            ProviderError("Vercel answered with a body that is not JSON".to_owned())
        })
    }

    async fn push(&self, config: &Value, secrets: &JsRecord, prune: bool) -> Result<PushResult, ProviderError> {
        let mut targets: Vec<Value> = config["targets"].as_array().cloned().unwrap_or_default();
        if targets.is_empty() {
            targets = vec![Value::from("production")];
        }
        let project_path = encode_uri_component(&field(config, "projectId"));
        let mut details = Vec::new();

        let mut pushed = 0;
        if !secrets.is_empty() {
            let body = Value::Array(
                secrets
                    .entries()
                    .map(|(key, value)| {
                        json!({ "key": key, "value": value, "type": "encrypted", "target": targets })
                    })
                    .collect(),
            );
            let result = self
                .fetch(
                    "POST",
                    &format!("/v10/projects/{project_path}/env?upsert=true"),
                    Some(&body),
                )
                .await?;
            let mut failures: Vec<(String, String)> = Vec::new();
            if let Some(Js::Array(failed)) = result.get("failed") {
                for failure in failed {
                    let error = failure.get("error");
                    let key = error.and_then(|e| e.get("key")).filter(|k| k.truthy());
                    if let Some(key) = key {
                        let message = error
                            .and_then(|e| e.get("message"))
                            .filter(|m| !matches!(m, Js::Null))
                            .map_or_else(|| "Rejected by Vercel".to_owned(), Js::to_js_string);
                        let key = key.to_js_string();
                        match failures.iter_mut().find(|(k, _)| *k == key) {
                            Some(slot) => slot.1 = message,
                            None => failures.push((key, message)),
                        }
                    }
                }
            }
            for key in secrets.keys() {
                match failures.iter().find(|(k, _)| k == key).map(|(_, m)| m) {
                    Some(message) if !message.is_empty() => details.push(PushDetail {
                        key: key.to_owned(),
                        action: "failed",
                        message: Some(message.clone()),
                    }),
                    _ => {
                        details.push(PushDetail::new(key, "pushed"));
                        pushed += 1;
                    }
                }
            }
        }

        let mut removed = 0;
        if prune {
            let existing = self
                .fetch("GET", &format!("/v9/projects/{project_path}/env"), None)
                .await?;
            let rows = match existing.get("envs") {
                Some(Js::Array(rows)) => rows.clone(),
                _ => Vec::new(),
            };
            for row in rows {
                let key = row.get("key").map_or_else(|| "undefined".to_owned(), Js::to_js_string);
                if secrets.has(&key) {
                    continue;
                }
                let covers = |target: &Value| match row.get("target") {
                    Some(Js::Array(items)) => items.iter().any(|item| match (item, target) {
                        (Js::String(a), Value::String(b)) => a == b,
                        _ => false,
                    }),
                    Some(Js::String(text)) => target.as_str().is_some_and(|t| text.contains(t)),
                    _ => false,
                };
                if !targets.iter().all(covers) {
                    continue;
                }
                let id = row.get("id").map_or_else(|| "undefined".to_owned(), Js::to_js_string);
                let path = format!("/v9/projects/{project_path}/env/{}", encode_uri_component(&id));
                match self.fetch("DELETE", &path, None).await {
                    Ok(_) => {
                        details.push(PushDetail::new(&key, "removed"));
                        removed += 1;
                    }
                    Err(ProviderError(message)) => details.push(PushDetail {
                        key,
                        action: "failed",
                        message: Some(message),
                    }),
                }
            }
        }

        let failed = details.iter().filter(|d| d.action == "failed").count();
        Ok(PushResult {
            pushed,
            removed,
            failed: i64::try_from(failed).unwrap_or(i64::MAX),
            details,
        })
    }
}

/// `url.searchParams.set(name, value)`: the query re-serialised as
/// `application/x-www-form-urlencoded`, with `name` once, where it was or at
/// the end.
fn set_query_param(url: &mut url::Url, name: &str, value: &str) {
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut seen = false;
    let mut kept: Vec<(String, String)> = Vec::new();
    for (key, current) in pairs {
        if key == name {
            if !seen {
                kept.push((key, value.to_owned()));
                seen = true;
            }
        } else {
            kept.push((key, current));
        }
    }
    if !seen {
        kept.push((name.to_owned(), value.to_owned()));
    }
    url.query_pairs_mut().clear().extend_pairs(kept);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_encode_like_the_sdk() {
        assert_eq!(
            sdk_path(&["/accounts/", "/workers/scripts/", "/secrets"], &["acc", "my worker"]),
            Ok("/accounts/acc/workers/scripts/my%20worker/secrets".to_owned())
        );
        assert_eq!(
            sdk_path(&["/accounts/", ""], &["a:b@c+d"]),
            Ok("/accounts/a:b@c+d".to_owned())
        );
        let refused = sdk_path(&["/accounts/", "/pages/projects/", ""], &["acc", ".."])
            .expect_err("dot segments are refused");
        assert_eq!(
            refused,
            "Path parameters result in path with invalid segments:\nValue \"..\" can't be safely passed as a path parameter\n/accounts/acc/pages/projects/..\n                             ^^"
        );
        assert_eq!(encode_uri_component("prj a/b"), "prj%20a%2Fb");
    }

    #[test]
    fn api_errors_read_like_the_sdk() {
        let status = |status, body: &str| deploy_error(SdkError::Status { status, body: body.to_owned() }, "W");
        assert_eq!(
            status(403, r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}"#),
            "W: Authentication error"
        );
        assert_eq!(status(404, r#"{"success":false,"errors":[]}"#), r#"W: 404 {"success":false,"errors":[]}"#);
        assert_eq!(status(500, "oops"), "W: 500 oops");
        assert_eq!(status(502, ""), "W: 502 status code (no body)");
        assert_eq!(status(400, r#"{"message":"bad"}"#), "W: 400 bad");
    }

    #[test]
    fn query_params_set_like_url_search_params() {
        let mut url = url::Url::parse("https://api.vercel.com/v10/projects/p/env?upsert=true").expect("url");
        set_query_param(&mut url, "teamId", "team a&b");
        assert_eq!(url.as_str(), "https://api.vercel.com/v10/projects/p/env?upsert=true&teamId=team+a%26b");
    }
}
