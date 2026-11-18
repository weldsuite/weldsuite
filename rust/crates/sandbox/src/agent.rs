//! The HTTP client of the agent inside a sandbox (`rust/deploy/sandbox/agent`).
//!
//! Every call carries the pod's bearer token ([`crate::token::pod_token`]);
//! the agent checks its digest and answers JSON. The agent caps what it sends
//! back (output, files, page text, screenshots); [`crate::tools`] caps again
//! on this side.
//!
//! | Path | What |
//! |---|---|
//! | `GET /healthz` | up, and its version |
//! | `POST /v1/exec` | a shell command in `/workspace`, with a timeout |
//! | `POST /v1/files/read`, `/write`, `/list` | files under `/workspace` |
//! | `POST /v1/code` | Python or JavaScript |
//! | `POST /v1/fetch` | a web page, as text, fetched from the pod |
//! | `POST /v1/browser/open`, `/act`, `/close` | Chromium on the pod's desktop |
//! | `POST /v1/desktop` | the X desktop: screenshot, mouse, keyboard |
//! | `POST /v1/selftest/egress` | which of the given `host:port` it can reach |

use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::error::SandboxError;

/// One sandbox's agent.
#[derive(Clone)]
pub struct AgentClient {
    http: OutboundHttp,
    base: String,
    token: String,
}

impl std::fmt::Debug for AgentClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentClient")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// How long a call may take beyond what it asks the agent for.
const SLACK: Duration = Duration::from_secs(15);

impl AgentClient {
    pub fn new(http: OutboundHttp, base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            http,
            base: base.into(),
            token: token.into(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn send(&self, request: HttpRequest, timeout: Duration) -> Result<Value, SandboxError> {
        let request = request
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/json");
        let response = tokio::time::timeout(timeout, self.http.send(request))
            .await
            .map_err(|_| SandboxError::Timeout("the sandbox did not answer"))?
            .map_err(|error| SandboxError::Unreachable(format!("sandbox agent: {error}")))?;
        let body = response.json();
        if response.ok() {
            return Ok(body);
        }
        let message = body.get("error").and_then(Value::as_str).map_or_else(
            || format!("The sandbox answered {}.", response.status),
            str::to_owned,
        );
        Err(SandboxError::Agent(response.status, message))
    }

    /// `POST <path>` with a JSON body.
    pub async fn post(
        &self,
        path: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, SandboxError> {
        self.send(
            HttpRequest::json("POST", format!("{}{path}", self.base), body),
            timeout + SLACK,
        )
        .await
    }

    /// `GET /healthz`: whether the agent answers.
    pub async fn health(&self) -> Result<Value, SandboxError> {
        self.send(
            HttpRequest::empty("GET", format!("{}/healthz", self.base)),
            Duration::from_secs(3),
        )
        .await
    }

    /// Which of `targets` (`host:port`) a TCP connection from inside the pod
    /// reaches.
    pub async fn reachable(&self, targets: &[String]) -> Result<Vec<String>, SandboxError> {
        let answer = self
            .post(
                "/v1/selftest/egress",
                &json!({ "targets": targets, "timeoutMs": 2000 }),
                Duration::from_secs(10),
            )
            .await?;
        Ok(answer
            .get("reachable")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::RecordingHttp;

    #[tokio::test]
    async fn sends_the_token_and_reads_refusals() {
        let http = RecordingHttp::new(|request| {
            if request.url.ends_with("/v1/files/read") {
                (400, json!({ "error": "Paths must be under /workspace" }))
            } else {
                (200, json!({ "reachable": ["169.254.169.254:80"] }))
            }
        });
        let client = AgentClient::new(http.outbound(), "http://10.244.1.5:8080", "tok");
        let reached = client
            .reachable(&["169.254.169.254:80".to_owned(), "10.96.0.1:443".to_owned()])
            .await
            .expect("answer");
        assert_eq!(reached, ["169.254.169.254:80"]);
        let refused = client
            .post(
                "/v1/files/read",
                &json!({ "path": "/etc/passwd" }),
                Duration::from_secs(1),
            )
            .await
            .expect_err("refused");
        assert_eq!(
            refused,
            SandboxError::Agent(400, "Paths must be under /workspace".to_owned())
        );
        let calls = http.calls();
        assert_eq!(calls[0].url, "http://10.244.1.5:8080/v1/selftest/egress");
        assert!(
            calls[0]
                .headers
                .iter()
                .any(|(n, v)| n == "Authorization" && v == "Bearer tok")
        );
    }
}
