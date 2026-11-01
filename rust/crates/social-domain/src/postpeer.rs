//! PostPeer, WeldSocial's one upstream for connecting channels, publishing
//! and analytics (`@weldsuite/social-publishing`'s `postpeer.ts`): a thin
//! client over [`OutboundHttp`] with the same URLs, query order, bodies and
//! error messages, the BYOK app lookup, the schedule conversion and the
//! webhook signature check.

use aws_lc_rs::hmac;
use serde_json::{Map, Value};
use weldsuite_core_domain::js::{Js, js_string};
use weldsuite_ports::{HttpRequest, OutboundHttp};

/// `DEFAULT_BASE_URL`.
pub const DEFAULT_BASE_URL: &str = "https://api.postpeer.dev/v1";

/// A refused or failed PostPeer call (`PostPeerError`): the message the
/// routes report, and the HTTP status (0 for a failed `fetch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostPeerError {
    pub message: String,
    pub status: u16,
}

impl std::fmt::Display for PostPeerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// A JSON field as JavaScript's `||` reads it: present and truthy.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `String(value)` of a parsed JSON value.
fn text_of(value: &Value) -> String {
    let js: Js = serde_json::from_value(value.clone()).unwrap_or(Js::Null);
    js_string(&js)
}

/// `PostPeerClient`: one API key, one base URL.
#[derive(Clone)]
pub struct PostPeerClient {
    http: OutboundHttp,
    api_key: String,
    base_url: String,
}

impl std::fmt::Debug for PostPeerClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostPeerClient")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl PostPeerClient {
    /// `getPostPeerClient(env)`: `None` without an API key.
    pub fn from_env(
        http: OutboundHttp,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) -> Option<Self> {
        let api_key = api_key.filter(|key| !key.is_empty())?;
        let base = base_url
            .filter(|url| !url.is_empty())
            .unwrap_or(DEFAULT_BASE_URL);
        Some(Self {
            http,
            api_key: api_key.to_owned(),
            base_url: base.strip_suffix('/').unwrap_or(base).to_owned(),
        })
    }

    /// One call. The parsed body (`Null` when empty, the text when it isn't
    /// JSON), or the `PostPeerError` a non-2xx answer becomes.
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, Option<&str>)],
    ) -> Result<Value, PostPeerError> {
        let mut url = format!("{}{path}", self.base_url);
        let pairs: Vec<(&str, &str)> = query
            .iter()
            .filter_map(|(key, value)| value.filter(|v| !v.is_empty()).map(|v| (*key, v)))
            .collect();
        if !pairs.is_empty() {
            let mut serializer = form_urlencoded::Serializer::new(String::new());
            for (key, value) in pairs {
                serializer.append_pair(key, value);
            }
            url = format!("{url}?{}", serializer.finish());
        }
        let request = HttpRequest {
            method: method.to_owned(),
            url,
            headers: vec![
                ("x-access-key".to_owned(), self.api_key.clone()),
                ("content-type".to_owned(), "application/json".to_owned()),
                ("accept".to_owned(), "application/json".to_owned()),
            ],
            body: body.map(|body| body.to_string().into_bytes()),
        };
        let response = self.http.send(request).await.map_err(|error| {
            tracing::warn!(%error, "[postpeer] request failed");
            PostPeerError {
                message: "fetch failed".to_owned(),
                status: 0,
            }
        })?;
        let text = response.text();
        let parsed = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if !response.ok() {
            let message = [parsed.get("message"), parsed.get("error")]
                .into_iter()
                .find(|value| truthy(*value))
                .flatten()
                .map_or_else(
                    || format!("PostPeer request failed ({})", response.status),
                    text_of,
                );
            return Err(PostPeerError {
                message,
                status: response.status,
            });
        }
        Ok(parsed)
    }

    /// `createProfile(name)`.
    pub async fn create_profile(&self, name: &str) -> Result<Value, PostPeerError> {
        self.request(
            "POST",
            "/profiles",
            Some(&serde_json::json!({ "name": name })),
            &[],
        )
        .await
    }

    /// `listProfiles()`.
    pub async fn list_profiles(&self) -> Result<Vec<Value>, PostPeerError> {
        let res = self.request("GET", "/profiles", None, &[]).await?;
        Ok(list_of(res, &["profiles", "data"]))
    }

    /// `getConnectUrl(platform, profileId, redirectUri, appId)`.
    pub async fn get_connect_url(
        &self,
        platform: &str,
        profile_id: &str,
        redirect_uri: Option<&str>,
        app_id: Option<&str>,
    ) -> Result<Value, PostPeerError> {
        self.request(
            "GET",
            &format!("/connect/{platform}"),
            None,
            &[
                ("profileId", Some(profile_id)),
                ("redirectUri", redirect_uri),
                ("appId", app_id),
            ],
        )
        .await
    }

    /// `listIntegrations(profileId)`.
    pub async fn list_integrations(&self, profile_id: &str) -> Result<Vec<Value>, PostPeerError> {
        let res = self
            .request(
                "GET",
                "/connect/integrations",
                None,
                &[("profileId", Some(profile_id))],
            )
            .await?;
        Ok(list_of(res, &["data", "integrations"]))
    }

    /// `createPost(input)`.
    pub async fn create_post(&self, input: &Value) -> Result<Value, PostPeerError> {
        self.request("POST", "/posts", Some(input), &[]).await
    }

    /// `deletePost(postpeerPostId)`.
    pub async fn delete_post(&self, postpeer_post_id: &str) -> Result<(), PostPeerError> {
        self.request(
            "DELETE",
            &format!("/posts/{}", encode_uri_component(postpeer_post_id)),
            None,
            &[],
        )
        .await
        .map(|_| ())
    }

    /// `getAnalytics({ postId })`.
    pub async fn get_analytics(&self, post_id: &str) -> Result<Vec<Value>, PostPeerError> {
        let res = self
            .request("GET", "/analytics", None, &[("postId", Some(post_id))])
            .await?;
        Ok(list_of(res, &["data"]))
    }
}

/// An array answer, or the first of `keys` that holds one (`res.profiles ??
/// res.data ?? []`).
fn list_of(res: Value, keys: &[&str]) -> Vec<Value> {
    if let Value::Array(items) = res {
        return items;
    }
    for key in keys {
        match res.get(*key) {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => return items.clone(),
            Some(_) => return Vec::new(),
        }
    }
    Vec::new()
}

/// `getPostPeerAppId(env, platform)`: the BYOK OAuth app for `platform` in
/// `POSTPEER_APP_IDS` (a JSON object), or `None` (PostPeer's own app) when
/// unset, malformed or not a non-empty string.
pub fn postpeer_app_id(app_ids: Option<&str>, platform: &str) -> Option<String> {
    let raw = app_ids.filter(|raw| !raw.is_empty())?;
    let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(raw) else {
        tracing::error!(
            "[PostPeer] POSTPEER_APP_IDS must be a JSON object of platform → appId — falling back to PostPeer's system app"
        );
        return None;
    };
    match parsed.get(platform) {
        None => None,
        Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
        Some(_) => {
            tracing::error!(
                "[PostPeer] POSTPEER_APP_IDS[\"{platform}\"] must be a non-empty string — falling back to PostPeer's system app"
            );
            None
        }
    }
}

/// `toPostPeerSchedule(isoInstant)`: the instant in UTC (`scheduledFor`),
/// with `timezone: 'UTC'`. An instant without its offset, or one JavaScript
/// can't read, is refused with the TypeScript message.
pub fn to_postpeer_schedule(iso: &str) -> Result<String, String> {
    let lower = iso.to_ascii_lowercase();
    let has_offset = lower.ends_with('z') || {
        let bytes = iso.as_bytes();
        let n = bytes.len();
        let digits = |range: std::ops::Range<usize>| {
            range
                .clone()
                .all(|i| bytes.get(i).is_some_and(u8::is_ascii_digit))
        };
        // `[+-]\d{2}:?\d{2}$`
        (n >= 5 && matches!(bytes[n - 5], b'+' | b'-') && digits(n - 4..n))
            || (n >= 6
                && matches!(bytes[n - 6], b'+' | b'-')
                && digits(n - 5..n - 3)
                && bytes[n - 3] == b':'
                && digits(n - 2..n))
    };
    if !has_offset {
        return Err(format!(
            "Invalid scheduled time: {iso} (needs an explicit UTC offset, e.g. a trailing Z)"
        ));
    }
    weldsuite_kit::validation::js_date_iso(iso)
        .ok_or_else(|| format!("Invalid scheduled time: {iso}"))
}

/// `verifyPostPeerSignature(secret, rawBody, signatureHeader)`: the header
/// is the hex HMAC-SHA256 of the raw body under the secret, optionally
/// `sha256=`-prefixed. Fails closed without a secret.
pub fn verify_postpeer_signature(
    secret: Option<&str>,
    raw_body: &str,
    signature: Option<&str>,
) -> bool {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
        tracing::error!(
            "[postpeer] POSTPEER_WEBHOOK_SECRET not set — rejecting webhook (fail closed)"
        );
        return false;
    };
    let Some(signature) = signature.filter(|s| !s.is_empty()) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let expected = hex::encode(hmac::sign(&key, raw_body.as_bytes()).as_ref());
    let trimmed = signature
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case("sha256="))
        .map_or(signature, |_| &signature[7..]);
    let provided = trimmed.trim().to_lowercase();
    if provided.encode_utf16().count() != expected.len() {
        return false;
    }
    let mut diff = 0u32;
    for (a, b) in expected.chars().zip(provided.chars()) {
        diff |= u32::from(a) ^ u32::from(b);
    }
    diff == 0
}

/// A `Value` object's string field.
pub(crate) fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// An object, or empty.
pub(crate) fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_read_like_the_typescript_helper() {
        assert_eq!(
            to_postpeer_schedule("2030-06-01T16:00:00+02:00").as_deref(),
            Ok("2030-06-01T14:00:00.000Z")
        );
        assert_eq!(
            to_postpeer_schedule("2030-06-01T16:00:00Z").as_deref(),
            Ok("2030-06-01T16:00:00.000Z")
        );
        assert!(to_postpeer_schedule("2030-06-01T16:00:00").is_err());
    }

    #[test]
    fn app_ids_fall_back_to_postpeer() {
        let ids = Some(r#"{"twitter":"app_tw","linkedin":""}"#);
        assert_eq!(postpeer_app_id(ids, "twitter").as_deref(), Some("app_tw"));
        assert_eq!(postpeer_app_id(ids, "linkedin"), None);
        assert_eq!(postpeer_app_id(ids, "facebook"), None);
        assert_eq!(postpeer_app_id(Some("[1]"), "twitter"), None);
        assert_eq!(postpeer_app_id(None, "twitter"), None);
    }

    #[test]
    fn signatures_match_hex_hmac_sha256() {
        let key = hmac::Key::new(hmac::HMAC_SHA256, b"secret");
        let sig = hex::encode(hmac::sign(&key, b"body").as_ref());
        assert!(verify_postpeer_signature(
            Some("secret"),
            "body",
            Some(&sig)
        ));
        let prefixed = format!("SHA256={}", sig.to_uppercase());
        assert!(verify_postpeer_signature(
            Some("secret"),
            "body",
            Some(&prefixed)
        ));
        assert!(!verify_postpeer_signature(
            Some("other"),
            "body",
            Some(&sig)
        ));
        assert!(!verify_postpeer_signature(None, "body", Some(&sig)));
        assert!(!verify_postpeer_signature(Some("secret"), "body", None));
    }
}
