//! `POST /webhooks/merge/:provider/:key` (`merge/provider-webhook.ts`): the
//! GitLab, Bitbucket Cloud and Azure DevOps webhooks WeldMerge registers on
//! a repository. Public, and nothing is verified here: `key` is the
//! repository's random `webhook_key`, which resolves to a workspace through
//! the master `merge_provider_index` (kind `webhook`, cached as
//! `merge-hook:<provider>:<key>`), and the delivery goes on as
//! `{ workspaceId, provider, key, headers (allow-listed), body (raw text) }`
//! to WeldMerge's provider-event intake (`MERGE_INTERNAL.providerEvent`, in
//! process), which verifies the signature with the repository's own secret.
//!
//! Answers: an unknown key, a provider that is not one of these three or a
//! key that cannot be one is a 404 (a probe learns nothing); a body over a
//! megabyte a 413; a lookup that fails a 503; a signature WeldMerge refuses
//! a 401; a repository it no longer tracks a 404 (the cached key is
//! dropped, so the provider drops the hook); an intake that fails a 502 (the
//! provider retries); no intake (WeldMerge not served) a 503; anything else,
//! applied or ignored, a 202.

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};

use crate::{IntegrationsState, PublicCtx};

/// `MERGE_WEBHOOK_PROVIDERS`: GitHub has its own receiver.
pub const MERGE_WEBHOOK_PROVIDERS: [&str; 3] = ["gitlab", "bitbucket", "azure_devops"];

/// `MERGE_PROVIDER_FORWARDED_HEADERS`: what WeldMerge needs to verify and
/// read a delivery, lower-case.
pub const MERGE_PROVIDER_FORWARDED_HEADERS: [&str; 6] = [
    "x-gitlab-token",
    "x-gitlab-event",
    "x-hub-signature",
    "x-event-key",
    "authorization",
    "content-type",
];

/// Deliveries are small; a provider sending more is not one of ours.
const MAX_BODY_BYTES: usize = 1_000_000;

/// How long a resolved key stays cached. A removed repository's key drops
/// out of the index at once; WeldMerge then answers `unknown_repository`.
const CACHE_TTL: Duration = Duration::from_hours(1);

pub(crate) fn router<S>(state: IntegrationsState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/webhooks/merge/{provider}/{key}", post(webhook))
        .with_state(state)
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn not_found() -> Response {
    error(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found")
}

fn too_large() -> Response {
    error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "PAYLOAD_TOO_LARGE",
        "Payload too large",
    )
}

fn try_again(status: StatusCode, code: &str) -> Response {
    error(status, code, "Try again")
}

/// `KEY_SHAPE`, `/^[A-Za-z0-9_-]{8,64}$/`: WeldMerge makes 40 random
/// alphanumerics; anything else cannot be one.
pub fn is_webhook_key(key: &str) -> bool {
    (8..=64).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `merge-hook:<provider>:<key>`.
pub fn cache_key(provider: &str, key: &str) -> String {
    format!("merge-hook:{provider}:{key}")
}

/// `Number(c.req.header('content-length') ?? 0)`: `NaN` (never larger) for
/// anything that is not a number.
fn declared_length(headers: &HeaderMap) -> Option<f64> {
    let Some(value) = headers.get(http::header::CONTENT_LENGTH) else {
        return Some(0.0);
    };
    let text = value.to_str().ok()?.trim();
    if text.is_empty() {
        return Some(0.0);
    }
    text.parse::<f64>().ok()
}

/// `await c.req.text()`: UTF-8 with replacement characters, a leading BOM
/// dropped (`TextDecoder`).
fn body_text(body: &[u8]) -> String {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    String::from_utf8_lossy(body).into_owned()
}

/// `body.length`: JavaScript counts UTF-16 units.
fn js_length(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `forwardedHeaders(headers)`: the allow-listed ones that were sent, a
/// repeated header joined as `Headers.get` joins it.
pub fn forwarded_headers(headers: &HeaderMap) -> Map<String, Value> {
    let mut out = Map::new();
    for name in MERGE_PROVIDER_FORWARDED_HEADERS {
        let values: Vec<&str> = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect();
        if !values.is_empty() {
            out.insert(name.to_owned(), Value::String(values.join(", ")));
        }
    }
    out
}

/// What WeldMerge's ack makes of the delivery.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The signature was refused: 401.
    BadSignature,
    /// The repository is gone: 404, and the cached key is dropped.
    UnknownRepository,
    /// Applied or ignored for another reason: 202.
    Received,
}

/// `ack.reason`, read as the worker reads it.
pub fn verdict(ack: &Value) -> Verdict {
    match ack.get("reason").and_then(Value::as_str) {
        Some("bad_signature") => Verdict::BadSignature,
        Some("unknown_repository") => Verdict::UnknownRepository,
        _ => Verdict::Received,
    }
}

/// `resolveWorkspace`: `workspaces.id` for a webhook key, the cache first,
/// then the master index (which fills the cache). `Err` when a lookup
/// failed.
async fn resolve_workspace(
    ctx: &PublicCtx,
    state: &IntegrationsState,
    provider: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let cache = ctx.cache(state);
    let cached_key = cache_key(provider, key);
    if let Some(cache) = &cache {
        let cached = cache
            .get_boxed(&cached_key)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(workspace) = cached.filter(|w| !w.is_empty()) {
            return Ok(Some(workspace));
        }
    }
    let master = ctx
        .master(state)
        .ok_or_else(|| "no master database".to_owned())?;
    let workspace: Option<String> = sqlx::query_scalar(
        "select workspace_id from merge_provider_index \
         where provider = $1 and kind = 'webhook' and external_key = $2 limit 1",
    )
    .bind(provider)
    .bind(key)
    .fetch_optional(&master)
    .await
    .map_err(|error| error.to_string())?;
    let Some(workspace) = workspace else {
        return Ok(None);
    };
    if let Some(cache) = &cache {
        cache
            .put_boxed(&cached_key, &workspace, Some(CACHE_TTL))
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(Some(workspace))
}

async fn webhook(
    State(state): State<IntegrationsState>,
    ctx: PublicCtx,
    Path((provider, key)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !MERGE_WEBHOOK_PROVIDERS.contains(&provider.as_str()) || !is_webhook_key(&key) {
        return not_found();
    }
    #[allow(clippy::cast_precision_loss)] // a megabyte is exact in an f64
    if declared_length(&headers).is_some_and(|declared| declared > MAX_BODY_BYTES as f64) {
        return too_large();
    }
    let text = body_text(&body);
    if js_length(&text) > MAX_BODY_BYTES {
        return too_large();
    }

    let workspace_id = match resolve_workspace(&ctx, &state, &provider, &key).await {
        Ok(Some(workspace_id)) => workspace_id,
        Ok(None) => return not_found(),
        Err(error) => {
            tracing::error!("[Merge Webhook] could not resolve a {provider} webhook key: {error}");
            return try_again(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
        }
    };

    let Some(merge) = state.merge_internal.clone() else {
        tracing::error!(
            "[Merge Webhook] MERGE_INTERNAL binding missing; {provider} delivery not forwarded"
        );
        return try_again(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    };
    let envelope = json!({
        "workspaceId": workspace_id,
        "provider": provider,
        "key": key,
        "headers": forwarded_headers(&headers),
        "body": text,
    });
    let ack = match merge.provider_event(envelope).await {
        Ok(ack) => ack,
        Err(error) => {
            tracing::error!("[Merge Webhook] WeldMerge refused a {provider} delivery: {error}");
            return try_again(StatusCode::BAD_GATEWAY, "BAD_GATEWAY");
        }
    };

    match verdict(&ack) {
        Verdict::BadSignature => error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized"),
        Verdict::UnknownRepository => {
            // The repository is gone: forget the key so the next delivery
            // looks it up again, and let the provider drop the hook.
            if let Some(cache) = ctx.cache(&state)
                && let Err(error) = cache.delete_boxed(&cache_key(&provider, &key)).await
            {
                tracing::warn!(%error, "[Merge Webhook] cached key not dropped");
            }
            not_found()
        }
        Verdict::Received => {
            (StatusCode::ACCEPTED, Json(json!({ "received": true }))).into_response()
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_providers() {
        assert!(is_webhook_key(&"k".repeat(40)));
        assert!(is_webhook_key("abc-DEF_12"));
        assert!(!is_webhook_key("abc"));
        assert!(!is_webhook_key(&"k".repeat(65)));
        assert!(!is_webhook_key("inst key 1"));
        assert!(!is_webhook_key("ünïcødé-key"));
        assert!(!MERGE_WEBHOOK_PROVIDERS.contains(&"github"));
        assert_eq!(cache_key("gitlab", "abc"), "merge-hook:gitlab:abc");
    }

    #[test]
    fn forwards_only_the_allow_listed_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Gitlab-Token", "s3cret".parse().unwrap());
        headers.insert("Cookie", "session=abc".parse().unwrap());
        headers.insert("Authorization", "Basic eDp5".parse().unwrap());
        headers.append("x-event-key", "a".parse().unwrap());
        headers.append("x-event-key", "b".parse().unwrap());
        assert_eq!(
            Value::Object(forwarded_headers(&headers)),
            json!({ "x-gitlab-token": "s3cret", "authorization": "Basic eDp5", "x-event-key": "a, b" })
        );
    }

    #[test]
    fn lengths_as_javascript_counts_them() {
        assert_eq!(js_length("café ✓"), 6);
        assert_eq!(js_length("😀"), 2);
        assert_eq!(body_text(b"\xEF\xBB\xBF{}"), "{}");
        let mut headers = HeaderMap::new();
        assert_eq!(declared_length(&headers), Some(0.0));
        headers.insert(http::header::CONTENT_LENGTH, "1000001".parse().unwrap());
        assert_eq!(declared_length(&headers), Some(1_000_001.0));
        headers.insert(http::header::CONTENT_LENGTH, "lots".parse().unwrap());
        assert_eq!(declared_length(&headers), None);
    }

    #[test]
    fn verdicts() {
        assert_eq!(
            verdict(&json!({ "outcome": "ignored", "reason": "bad_signature" })),
            Verdict::BadSignature
        );
        assert_eq!(
            verdict(&json!({ "outcome": "ignored", "reason": "unknown_repository" })),
            Verdict::UnknownRepository
        );
        for ack in [
            json!({ "outcome": "applied" }),
            json!({ "outcome": "ignored", "reason": "stale" }),
            json!({ "outcome": "ignored", "reason": "pr_sync_off" }),
            Value::Null,
        ] {
            assert_eq!(verdict(&ack), Verdict::Received);
        }
    }
}
