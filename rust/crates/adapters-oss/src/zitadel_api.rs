//! One HTTP call to Zitadel's REST API as a service user, shared by the
//! `Identity` adapter (`zitadel.rs`) and the `SignInProvider` adapter
//! (`zitadel_sign_in.rs`).
//!
//! Zitadel's REST gateway writes camelCase JSON and leaves zero values out: a
//! `false`, an empty string, a `0` and an enum's first value are simply
//! absent. A refusal is `{ code, message, details: [{ id, message }] }`; the
//! text follows the instance's language, so callers go by `details[0].id`
//! (`COMMAND-3M0fs`).

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

/// How to reach the instance.
pub(crate) struct ZitadelApi {
    api_url: String,
    token: String,
    /// `Host` for every call, when `api_url` is an in-cluster address
    /// (Zitadel picks the instance by host).
    host: Option<String>,
    client: reqwest::Client,
}

/// Why a call gave no answer to use.
#[derive(Debug)]
pub(crate) enum ApiFailure {
    /// Zitadel could not be reached, or its answer could not be read.
    Unreachable(String),
    Refused(Refusal),
}

/// An error status from Zitadel.
#[derive(Debug)]
pub(crate) struct Refusal {
    pub(crate) status: u16,
    /// `details[0].id`, the stable name of the error.
    pub(crate) code: Option<String>,
    pub(crate) message: Option<String>,
    /// The answer's body as text.
    pub(crate) raw: String,
}

impl ZitadelApi {
    pub(crate) fn new(api_url: &str, token: String, host: Option<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            api_url: api_url.trim_end_matches('/').to_owned(),
            token,
            host,
            client,
        })
    }

    /// `method path?query`, as the service user, in `org` when given. The
    /// path must be [`safe_path`]; values that are not plain ids go in
    /// `query`, which is encoded.
    pub(crate) async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        org: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, ApiFailure> {
        // Ids from callers land in the path, and the request carries the
        // instance token: a `..` or an encoded `/` would reach another
        // endpoint. Every segment is a plain id, key or name.
        if !safe_path(path) {
            return Err(ApiFailure::Refused(Refusal {
                status: 404,
                code: None,
                message: None,
                raw: String::new(),
            }));
        }
        let address = format!("{}{path}", self.api_url);
        let url = if query.is_empty() {
            reqwest::Url::parse(&address)
        } else {
            reqwest::Url::parse_with_params(&address, query)
        }
        .map_err(|error| ApiFailure::Unreachable(format!("zitadel address: {error}")))?;
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.token)
            .header("accept", "application/json");
        if let Some(org) = org {
            request = request.header("x-zitadel-orgid", org);
        }
        if let Some(host) = &self.host {
            request = request.header("host", host);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|error| ApiFailure::Unreachable(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|error| ApiFailure::Unreachable(error.without_url().to_string()))?;
        let body: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()))
        };
        if status < 400 {
            return Ok(body);
        }
        Err(ApiFailure::Refused(Refusal {
            status,
            code: body
                .get("details")
                .and_then(Value::as_array)
                .and_then(|details| details.first())
                .and_then(|detail| detail.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            message: body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
            raw: text,
        }))
    }
}

/// `/a/b.c/d`: segments of `[0-9A-Za-z_.-]`, none empty, `.` or `..`, so
/// nothing in the path can be decoded or resolved into another endpoint.
pub(crate) fn safe_path(path: &str) -> bool {
    path.strip_prefix('/').is_some_and(|rest| {
        rest.split('/').all(|segment| {
            !matches!(segment, "" | "." | "..")
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        })
    })
}

/// A non-empty string field.
pub(crate) fn str_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// An RFC 3339 time as milliseconds since the epoch.
pub(crate) fn millis(time: &str) -> Option<i64> {
    time.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_made_of_plain_segments() {
        assert!(safe_path("/management/v1/metadata/weldsuite.slug"));
        assert!(safe_path("/v2/users/123/grants"));
        assert!(safe_path("/v2/oidc/auth_requests/V2_300000000000000100"));
        assert!(!safe_path("/v2/users/1/../../9"));
        assert!(!safe_path("/v2/users/%2e%2e/9"));
        assert!(!safe_path("/v2/users//9"));
        assert!(!safe_path("/v2/sessions/1?sessionToken=x"));
        assert!(!safe_path("v2/users"));
    }
}
