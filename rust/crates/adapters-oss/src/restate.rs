//! [`Jobs`] on [Restate](https://restate.dev), the durable-execution server
//! that replaces Cloudflare Workflows on Kubernetes (design doc, "Durable
//! jobs").
//!
//! - **One Restate service for every job**: `WeldsuiteJobs`, handler `run`,
//!   which takes `{ name, key, payload }` and dispatches to the [`Job`]
//!   registered under `name`. A new job kind needs no new Restate service,
//!   only a [`JobRegistry::register`].
//! - **Start** ([`RestateJobs`]): `POST <ingress>/WeldsuiteJobs/run/send` with
//!   the header `idempotency-key: <name>:<key>`, so Restate keeps one
//!   invocation per key for its idempotency retention (a day by default).
//!   Unlike a Workflow, a key whose run failed for good is not restarted
//!   within that window.
//! - **Steps**: each [`step`](weldsuite_ports::step) is a journaled `ctx.run`
//!   with the step's retry policy. A replay returns the journaled result; once
//!   a step's attempts are spent the job fails terminally (no endless retry).
//! - **Endpoint**: the `weldsuite serve` process also serves the Restate
//!   service on its own port ([`serve_endpoint`]; `JOBS_PORT`, 9080 by
//!   default; Restate speaks HTTP/2 to it), behind its own Kubernetes Service.
//!   Every API pod runs jobs; there is no separate jobs role to deploy.
//! - **Registration**: each pod registers that Service's URL with the Restate
//!   admin API when it starts ([`register_deployment`], retried until Restate
//!   answers), with `force`, so a rollout with new job kinds updates the
//!   deployment. Restate then calls whichever pod the Service routes to.

use std::time::Duration;

use restate_sdk::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::net::TcpListener;
use weldsuite_ports::{
    BoxFuture, JobContext, JobError, JobRegistry, JobRequest, Jobs, PortError, StepFn, StepRetry,
};

/// The Restate service every job runs under.
pub const JOBS_SERVICE: &str = "WeldsuiteJobs";

/// What the `run` handler receives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobCall {
    pub name: String,
    pub key: String,
    pub payload: Value,
}

/// Starts jobs through the Restate ingress.
#[derive(Debug, Clone)]
pub struct RestateJobs {
    client: reqwest::Client,
    /// `RESTATE_INGRESS_URL`, `http://restate:8080`.
    ingress_url: String,
}

impl RestateJobs {
    pub fn new(ingress_url: &str, client: reqwest::Client) -> Self {
        Self {
            client,
            ingress_url: ingress_url.trim_end_matches('/').to_owned(),
        }
    }

    async fn send(&self, request: JobRequest) -> Result<(), PortError> {
        let idempotency_key = format!("{}:{}", request.name, request.key);
        let url = send_url(&self.ingress_url, request.delay);
        let call = JobCall {
            name: request.name,
            key: request.key,
            payload: request.payload,
        };
        let response = self
            .client
            .post(url)
            .header("idempotency-key", idempotency_key)
            .header("content-type", "application/json")
            .body(serde_json::to_vec(&call)?)
            .send()
            .await
            .map_err(PortError::backend)?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(PortError::backend(format!(
            "restate ingress answered {status}: {}",
            body.chars().take(300).collect::<String>()
        )))
    }
}

/// The ingress URL that starts a job: `…/WeldsuiteJobs/run/send`, with
/// `?delay=<ms>ms` for a delayed start, which Restate keeps durably and
/// invokes when it is due (the 30-day trash purge waits there, not in a pod).
fn send_url(ingress_url: &str, delay: Option<Duration>) -> String {
    let base = format!("{ingress_url}/{JOBS_SERVICE}/run/send");
    match delay {
        Some(delay) if !delay.is_zero() => format!("{base}?delay={}ms", delay.as_millis()),
        _ => base,
    }
}

impl Jobs for RestateJobs {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        self.send(request)
    }
}

/// The Restate service: dispatches each invocation to its registered job.
pub struct WeldsuiteJobs {
    registry: JobRegistry,
}

#[restate_sdk::service]
impl WeldsuiteJobs {
    #[handler]
    async fn run(&self, ctx: Context<'_>, call: Json<JobCall>) -> Result<(), HandlerError> {
        let call = call.into_inner();
        let Some(job) = self.registry.get(&call.name) else {
            return Err(TerminalError::new(JobError::UnknownJob(call.name).to_string()).into());
        };
        let context = RestateContext {
            key: call.key,
            ctx: &ctx,
        };
        job.run(&context, call.payload).await.map_err(|error| {
            tracing::error!(job = call.name, key = context.key, %error, "jobs: job failed");
            // Steps retry by their own policy; the job as a whole does not.
            TerminalError::new(error.to_string()).into()
        })
    }
}

struct RestateContext<'c> {
    key: String,
    ctx: &'c Context<'c>,
}

impl JobContext for RestateContext<'_> {
    fn key(&self) -> &str {
        &self.key
    }

    fn run_step<'s>(
        &'s self,
        name: &'s str,
        retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        let ctx: &'s Context<'s> = self.ctx;
        let mut policy = RunRetryPolicy::default()
            .initial_delay(retry.initial_delay)
            .exponentiation_factor(retry.factor)
            .max_attempts(retry.max_attempts.max(1));
        if let Some(max) = retry.max_delay {
            policy = policy.max_delay(max);
        }
        Box::pin(async move {
            let result = ctx
                .run(|| async move {
                    step()
                        .await
                        .map(Json)
                        .map_err(|error| HandlerError::from(error.to_string()))
                })
                .name(name)
                .retry_policy(policy)
                .await;
            result
                .map(Json::into_inner)
                .map_err(|terminal| JobError::StepFailed {
                    step: name.to_owned(),
                    message: terminal.to_string(),
                })
        })
    }
}

/// Serve the jobs service for Restate on `listener` until `shutdown`
/// resolves.
pub async fn serve_endpoint(
    registry: JobRegistry,
    listener: TcpListener,
    shutdown: impl Future<Output = ()>,
) {
    let endpoint = Endpoint::builder().bind(WeldsuiteJobs { registry }).build();
    HttpServer::new(endpoint)
        .serve_with_cancel(listener, shutdown)
        .await;
}

/// Register `deployment_uri` (the jobs Service, `http://weldsuite-jobs:9080`)
/// with the Restate admin API, retrying while Restate or the endpoint is not
/// up yet, for at most `give_up_after`.
pub async fn register_deployment(
    client: &reqwest::Client,
    admin_url: &str,
    deployment_uri: &str,
    give_up_after: Duration,
) -> Result<(), PortError> {
    let url = format!("{}/deployments", admin_url.trim_end_matches('/'));
    let body = serde_json::to_vec(&serde_json::json!({ "uri": deployment_uri, "force": true }))?;
    let deadline = tokio::time::Instant::now() + give_up_after;
    let mut wait = Duration::from_millis(500);
    loop {
        let outcome = client
            .post(&url)
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
            .await;
        let problem = match outcome {
            Ok(response) if response.status().is_success() => {
                tracing::info!(deployment_uri, "jobs: registered with restate");
                return Ok(());
            }
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                format!("{status}: {}", text.chars().take(300).collect::<String>())
            }
            Err(error) => error.to_string(),
        };
        if tokio::time::Instant::now() + wait > deadline {
            return Err(PortError::backend(format!(
                "registering {deployment_uri} with restate failed: {problem}"
            )));
        }
        tracing::warn!(
            deployment_uri,
            problem,
            "jobs: restate registration failed; retrying"
        );
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn delayed_starts_ask_restate_to_wait() {
        let ingress = "http://restate:8080";
        assert_eq!(
            send_url(ingress, None),
            "http://restate:8080/WeldsuiteJobs/run/send"
        );
        assert_eq!(
            send_url(ingress, Some(Duration::ZERO)),
            "http://restate:8080/WeldsuiteJobs/run/send"
        );
        assert_eq!(
            send_url(ingress, Some(Duration::from_hours(30 * 24))),
            "http://restate:8080/WeldsuiteJobs/run/send?delay=2592000000ms"
        );
    }

    /// The request a delayed start sends, read off a socket standing in for
    /// the ingress.
    #[tokio::test]
    async fn a_delayed_start_sends_the_delay_and_the_idempotency_key() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let ingress = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            while !String::from_utf8_lossy(&seen).contains("\"payload\"") {
                let read = socket.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                seen.extend_from_slice(&buffer[..read]);
            }
            socket
                .write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n")
                .await
                .expect("write");
            String::from_utf8_lossy(&seen).into_owned()
        });
        let jobs = RestateJobs::new(&format!("http://{address}/"), reqwest::Client::new());
        let request = JobRequest::new(
            "core.trash-purge",
            "trash-file_1-1",
            &serde_json::json!({ "fileId": "file_1" }),
        )
        .expect("a request")
        .with_delay(Duration::from_millis(1500));
        jobs.start(request).await.expect("accepted");
        let sent = ingress.await.expect("ingress").to_ascii_lowercase();
        assert!(
            sent.starts_with("post /weldsuitejobs/run/send?delay=1500ms http/1.1"),
            "{sent}"
        );
        assert!(
            sent.contains("idempotency-key: core.trash-purge:trash-file_1-1"),
            "{sent}"
        );
    }
}
