//! Shared plumbing for the review adapters (`services/providers/review-http.ts`):
//! one request per call, the provider's own error message passed through as
//! a `ProviderApiError`, and the unified-diff helpers GitLab and Bitbucket
//! need. No retries: every outbound call is deterministic for a given input.

use serde_json::{Value, json};
use weldsuite_ports::HttpRequest;

use crate::MergeError;
use crate::providers::AdapterContext;

pub(crate) const REVIEW_PAGE: usize = 100;
pub(crate) const MAX_FILES: usize = 300;
pub(crate) const MAX_COMMENTS: usize = 300;

/// `messageOf(value)`: a non-empty string, or an object as JSON.
fn message_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        object @ Value::Object(_) => Some(object.to_string()),
        Value::Array(_) => Some(value?.to_string()),
        _ => None,
    }
}

/// `providerMessage(status, text)`: the provider's own words for a failure:
/// `message`, `error.message`, `error`, or the raw body.
pub(crate) fn provider_message(status: u16, text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Null) => {
            // `body.message` throws on null: the raw text is the message.
            let trimmed = weldsuite_kit::validation::js_trim(text);
            if !trimmed.is_empty() {
                return utf16_prefix(trimmed, 500);
            }
        }
        Ok(body) => {
            let nested = body.get("error").and_then(|e| e.get("message"));
            if let Some(found) = message_of(body.get("message"))
                .or_else(|| message_of(nested))
                .or_else(|| message_of(body.get("error")))
            {
                return found;
            }
        }
        Err(_) => {
            let trimmed = weldsuite_kit::validation::js_trim(text);
            if !trimmed.is_empty() {
                return utf16_prefix(trimmed, 500);
            }
        }
    }
    format!("Provider answered {status}")
}

/// `text.slice(0, n)` in UTF-16 units.
fn utf16_prefix(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// One provider request (`ProviderRequest`).
pub(crate) struct ProviderRequest<'a> {
    pub(crate) method: &'a str,
    pub(crate) url: String,
    pub(crate) headers: Vec<(&'static str, String)>,
    /// Sent as JSON.
    pub(crate) body: Option<Value>,
}

/// `send(provider, req, accept)`: a non-2xx answer is a `ProviderApiError`
/// with the provider's own message.
async fn send(
    ctx: &AdapterContext,
    provider: &str,
    request: ProviderRequest<'_>,
    accept: &str,
) -> Result<Vec<u8>, MergeError> {
    let http = ctx.http()?;
    let mut outbound = match &request.body {
        Some(body) => HttpRequest::json(request.method, request.url, body),
        None => HttpRequest::empty(request.method, request.url),
    };
    // `{ Accept, 'User-Agent', ...req.headers }`: the request's own win.
    let mut headers: Vec<(String, String)> = vec![
        ("Accept".to_owned(), accept.to_owned()),
        ("User-Agent".to_owned(), "WeldSuite-WeldMerge".to_owned()),
    ];
    for (name, value) in request.headers {
        if let Some(existing) = headers
            .iter_mut()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
        {
            existing.1 = value;
        } else {
            headers.push((name.to_owned(), value));
        }
    }
    for (name, value) in headers {
        outbound = outbound.header(&name, value);
    }
    let response = http
        .send(outbound)
        .await
        .map_err(|error| MergeError::Unexpected(error.to_string()))?;
    if !response.ok() {
        return Err(MergeError::provider_api(
            provider,
            response.status,
            provider_message(response.status, &response.text()),
        ));
    }
    Ok(response.body)
}

/// `providerJson(provider, req)`: the parsed JSON of a successful answer;
/// `Null` for an empty one (204).
pub(crate) async fn provider_json(
    ctx: &AdapterContext,
    provider: &str,
    request: ProviderRequest<'_>,
) -> Result<Value, MergeError> {
    let body = send(ctx, provider, request, "application/json").await?;
    if body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&body).map_err(|error| MergeError::Unexpected(error.to_string()))
}

/// `providerText(provider, req)`.
pub(crate) async fn provider_text(
    ctx: &AdapterContext,
    provider: &str,
    request: ProviderRequest<'_>,
) -> Result<String, MergeError> {
    let body = send(ctx, provider, request, "text/plain").await?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// `bearer(requireToken(provider, ctx.memberToken))`: the token the adapter
/// acts with; none is a provider-side 401.
pub(crate) fn bearer(
    ctx: &AdapterContext,
    provider: &str,
) -> Result<(&'static str, String), MergeError> {
    match ctx.member_token.as_deref().filter(|t| !t.is_empty()) {
        Some(token) => Ok(("Authorization", format!("Bearer {token}"))),
        None => Err(MergeError::provider_api(
            provider,
            401,
            format!("No {provider} credentials are available for this call"),
        )),
    }
}

/// `patchStats(patch)`: added and removed lines of a unified diff body (file
/// headers excluded).
pub(crate) fn patch_stats(patch: Option<&str>) -> (i64, i64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in patch.unwrap_or_default().split('\n') {
        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// `String.prototype.trimEnd()`.
fn trim_end(text: &str) -> &str {
    text.trim_end_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `splitUnifiedDiff(diff)`: a whole-pull-request unified diff split per file
/// (the `b/` path of each `diff --git` section), in order.
pub(crate) fn split_unified_diff(diff: &str) -> Vec<(String, String)> {
    const MARKER: &str = "diff --git ";
    // `diff.split(/^diff --git /m).slice(1)`: the starts of the sections.
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    while let Some(found) = diff[at..].find(MARKER) {
        let index = at + found;
        if index == 0 || diff.as_bytes()[index - 1] == b'\n' {
            starts.push(index + MARKER.len());
        }
        at = index + MARKER.len();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for (i, start) in starts.iter().enumerate() {
        let end = starts
            .get(i + 1)
            .map_or(diff.len(), |next| next - MARKER.len());
        let section = &diff[*start..end];
        let header = section.split('\n').next().unwrap_or_default();
        // `/\sb\/(.+)$/`: the first whitespace followed by `b/`.
        let path = header
            .char_indices()
            .find(|(i, c)| c.is_whitespace() && header[i + c.len_utf8()..].starts_with("b/"))
            .map(|(i, c)| &header[i + c.len_utf8() + 2..])
            .filter(|p| !p.is_empty());
        let Some(path) = path else { continue };
        let hunks = match section.find("\n@@") {
            None => String::new(),
            Some(hunk) => trim_end(&section[hunk + 1..]).to_owned(),
        };
        if let Some(existing) = out.iter_mut().find(|(p, _)| p == path) {
            existing.1 = hunks;
        } else {
            out.push((path.to_owned(), hunks));
        }
    }
    out
}

/// `trimTrailingSlashes(value)`.
pub(crate) fn trim_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

/// `diffSide(newLine, oldLine)`: the new side when the comment has a line
/// there, else the old one; `null` without a line.
pub(crate) fn diff_side(new_line: Option<&Value>, old_line: Option<&Value>) -> Value {
    let truthy = |v: Option<&Value>| v.and_then(Value::as_f64).is_some_and(|n| n != 0.0);
    if truthy(new_line) {
        json!("RIGHT")
    } else if truthy(old_line) {
        json!("LEFT")
    } else {
        Value::Null
    }
}

/// `value ?? null` for a member of a JSON object.
pub(crate) fn at(value: &Value, key: &str) -> Value {
    match value.get(key) {
        None | Some(Value::Null) => Value::Null,
        Some(found) => found.clone(),
    }
}

/// `String(value)`: a number or a string id as text.
pub(crate) fn id_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Null) | None => "null".to_owned(),
        Some(other) => other.to_string(),
    }
}

/// `[title, message].filter(Boolean).join('\n\n')`.
pub(crate) fn commit_message(title: Option<&str>, message: Option<&str>) -> String {
    [title, message]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_provider_message_is_its_own_words() {
        assert_eq!(provider_message(422, r#"{"message":"No"}"#), "No");
        assert_eq!(
            provider_message(400, r#"{"error":{"message":"bad"}}"#),
            "bad"
        );
        assert_eq!(provider_message(400, r#"{"error":"nope"}"#), "nope");
        assert_eq!(provider_message(500, "boom"), "boom");
        assert_eq!(provider_message(500, "  "), "Provider answered 500");
        assert_eq!(provider_message(500, "{}"), "Provider answered 500");
    }

    #[test]
    fn a_diff_splits_per_file_with_its_hunks() {
        let diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n";
        let files = split_unified_diff(diff);
        assert_eq!(
            files,
            [
                ("a.ts".to_owned(), "@@ -1 +1 @@\n-a\n+b".to_owned()),
                ("b.ts".to_owned(), "@@ -0,0 +1,2 @@\n+x\n+y".to_owned()),
            ]
        );
        assert_eq!(patch_stats(Some("@@ -1 +1,2 @@\n-a\n+b\n+c")), (2, 1));
    }

    #[test]
    fn the_side_follows_the_line() {
        assert_eq!(diff_side(Some(&json!(3)), None), json!("RIGHT"));
        assert_eq!(
            diff_side(Some(&Value::Null), Some(&json!(2))),
            json!("LEFT")
        );
        assert_eq!(diff_side(None, None), Value::Null);
        assert_eq!(commit_message(Some("T"), Some("M")), "T\n\nM");
        assert_eq!(commit_message(None, Some("M")), "M");
    }
}
