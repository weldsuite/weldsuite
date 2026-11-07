//! HTTP plumbing for the GitLab, Bitbucket and Azure DevOps adapters
//! (`services/providers/provider-http.ts`): one call per request, the
//! provider's own message passed through as `ProviderApiError`, a 404 read
//! as "not there" on reads. No retries, no hidden calls: every outbound call
//! is deterministic for a given input (the TypeScript tests stub them by
//! method and URL, and conformance compares them).

use serde_json::Value;
use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

use super::AdapterContext;
use crate::MergeError;
use crate::credentials::StoredCredentials;

/// `messageOf(value)`.
fn message_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(value @ (Value::Object(_) | Value::Array(_))) => Some(value.to_string()),
        _ => None,
    }
}

/// `failureMessage(status, text)`: the provider's own words for a failure
/// (`message`, `error_description`, `error.message`, `error`, or the raw
/// body).
pub(crate) fn failure_message(status: u16, text: &str) -> String {
    // `JSON.parse` then `body.message`: a `null` body throws and reads as text.
    if let Ok(body) = serde_json::from_str::<Value>(text)
        && !body.is_null()
    {
        let nested = body.get("error").and_then(|error| error.get("message"));
        return message_of(body.get("message"))
            .or_else(|| message_of(body.get("error_description")))
            .or_else(|| message_of(nested))
            .or_else(|| message_of(body.get("error")))
            .unwrap_or_else(|| format!("Provider answered {status}"));
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        format!("Provider answered {status}")
    } else {
        trimmed.chars().take(500).collect()
    }
}

/// What to send (`HttpRequest`): a JSON body, a form, or none.
pub(crate) enum Body {
    None,
    Json(Value),
    Form(Vec<(String, String)>),
}

/// `new URLSearchParams(pairs).toString()`.
pub(crate) fn form_encode(pairs: &[(String, String)]) -> String {
    let mut serializer = form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

/// `sendRequest(provider, req)`: sends it; a non-2xx answer is a
/// `ProviderApiError` with the provider's message, an unreachable host a 502
/// one.
pub(crate) async fn send_request(
    http: &OutboundHttp,
    provider: &str,
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Body,
) -> Result<HttpResponse, MergeError> {
    // `{ Accept, 'User-Agent', ...req.headers }`: the caller's win.
    let mut all: Vec<(String, String)> = vec![
        ("Accept".to_owned(), "application/json".to_owned()),
        ("User-Agent".to_owned(), "WeldSuite-WeldMerge".to_owned()),
    ];
    for (name, value) in headers {
        all.retain(|(existing, _)| !existing.eq_ignore_ascii_case(name));
        all.push((name.clone(), value.clone()));
    }
    let (content_type, bytes) = match body {
        Body::None => (None, None),
        Body::Json(value) => (
            Some("application/json"),
            Some(value.to_string().into_bytes()),
        ),
        Body::Form(pairs) => (
            Some("application/x-www-form-urlencoded"),
            Some(form_encode(&pairs).into_bytes()),
        ),
    };
    if let Some(content_type) = content_type {
        all.retain(|(existing, _)| !existing.eq_ignore_ascii_case("content-type"));
        all.push(("Content-Type".to_owned(), content_type.to_owned()));
    }
    let request = HttpRequest {
        method: method.to_owned(),
        url: url.to_owned(),
        headers: all,
        body: bytes,
    };
    let response = match http.send(request).await {
        Ok(response) => response,
        Err(error) => {
            let host = url::Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(str::to_owned))
                .unwrap_or_default();
            return Err(MergeError::provider_api(
                provider,
                502,
                format!("Could not reach {host}: {error}"),
            ));
        }
    };
    if !response.ok() {
        return Err(MergeError::provider_api(
            provider,
            response.status,
            failure_message(response.status, &response.text()),
        ));
    }
    Ok(response)
}

/// `readJson(res)`: the parsed JSON, `None` for an empty answer.
pub(crate) fn read_json(response: &HttpResponse) -> Result<Option<Value>, MergeError> {
    if response.body.is_empty() {
        return Ok(None);
    }
    serde_json::from_slice(&response.body)
        .map(Some)
        .map_err(|error| MergeError::Unexpected(error.to_string()))
}

/// `requestJson(provider, req)`.
pub(crate) async fn request_json(
    http: &OutboundHttp,
    provider: &str,
    method: &str,
    url: &str,
    headers: &[(String, String)],
    body: Body,
) -> Result<Option<Value>, MergeError> {
    read_json(&send_request(http, provider, method, url, headers, body).await?)
}

/// `bearer(token)`.
pub(crate) fn bearer(token: &str) -> Vec<(String, String)> {
    vec![("Authorization".to_owned(), format!("Bearer {token}"))]
}

/// `credentialsFromToken(body, provider, now)`: stored credentials from an
/// OAuth token response (`expires_in` is seconds from now).
pub(crate) fn credentials_from_token(
    body: &Value,
    provider: &str,
) -> Result<StoredCredentials, MergeError> {
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            MergeError::provider_api(provider, 502, "The provider did not return an access token")
        })?;
    let seconds = weldsuite_kit::validation::js_number_of(body.get("expires_in"));
    let expires_at = (seconds.is_finite() && seconds > 0.0)
        .then(|| weldsuite_kit::validation::js_iso_from_millis(crate::now_ms() + seconds * 1000.0))
        .flatten();
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    Ok(StoredCredentials {
        access_token: access_token.to_owned(),
        refresh_token: text("refresh_token"),
        expires_at,
        token_type: text("token_type"),
    })
}

/// A client for one provider API (`createApiClient(provider, base, auth)`):
/// `path` is appended to `base` unless it is an absolute URL (Bitbucket's
/// `next`); the token is the context's, read per call.
pub(crate) struct ApiClient<'a> {
    pub(crate) ctx: &'a AdapterContext,
    pub(crate) provider: &'static str,
    pub(crate) base: String,
}

impl ApiClient<'_> {
    fn url_of(&self, path: &str) -> String {
        if path.starts_with("http://") || path.starts_with("https://") {
            path.to_owned()
        } else {
            format!("{}{path}", self.base)
        }
    }

    fn auth(&self) -> Result<Vec<(String, String)>, MergeError> {
        Ok(bearer(&self.ctx.access_token(self.provider)?))
    }

    /// `client.get(path)`: the parsed JSON body, or `None` on a 404.
    pub(crate) async fn get(&self, path: &str) -> Result<Option<Value>, MergeError> {
        let headers = self.auth()?;
        let http = self.ctx.http()?;
        match request_json(
            &http,
            self.provider,
            "GET",
            &self.url_of(path),
            &headers,
            Body::None,
        )
        .await
        {
            Err(error) if error.is_status(&[404]) => Ok(None),
            other => other,
        }
    }

    /// `client.send(method, path, json?)`: a write; any non-2xx answer (404
    /// included) is an error.
    pub(crate) async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Option<Value>, MergeError> {
        let headers = self.auth()?;
        let http = self.ctx.http()?;
        request_json(
            &http,
            self.provider,
            method,
            &self.url_of(path),
            &headers,
            body.map_or(Body::None, Body::Json),
        )
        .await
    }

    /// `client.get(path) ?? []` for a list answer.
    pub(crate) async fn get_list(&self, path: &str) -> Result<Vec<Value>, MergeError> {
        Ok(match self.get(path).await? {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        })
    }
}

/// `collectPages(read, maxPages, cap)`: the first pages of a paginated
/// list, capped; each page says whether more may follow (`rows.length ==
/// page size`).
pub(crate) async fn collect_pages<F, Fut>(
    mut read: F,
    max_pages: usize,
    cap: usize,
) -> Result<Vec<Value>, MergeError>
where
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<(Vec<Value>, bool), MergeError>>,
{
    let mut out: Vec<Value> = Vec::new();
    let mut page = 1;
    while page <= max_pages && out.len() < cap {
        let (rows, more) = read(page).await?;
        out.extend(rows);
        if !more {
            break;
        }
        page += 1;
    }
    out.truncate(cap);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_providers_own_words() {
        assert_eq!(
            failure_message(403, r#"{"message":"403 Forbidden"}"#),
            "403 Forbidden"
        );
        assert_eq!(
            failure_message(400, r#"{"error":{"message":"bad"}}"#),
            "bad"
        );
        assert_eq!(
            failure_message(
                400,
                r#"{"error":"invalid_grant","error_description":"expired"}"#
            ),
            "expired"
        );
        assert_eq!(failure_message(500, "  oops "), "oops");
        assert_eq!(failure_message(500, ""), "Provider answered 500");
        assert_eq!(failure_message(500, "{}"), "Provider answered 500");
    }

    #[test]
    fn encodes_forms_like_url_search_params() {
        let pairs = vec![
            ("scope".to_owned(), "a/b .default offline_access".to_owned()),
            ("x".to_owned(), "1".to_owned()),
        ];
        assert_eq!(
            form_encode(&pairs),
            "scope=a%2Fb+.default+offline_access&x=1"
        );
    }
}
