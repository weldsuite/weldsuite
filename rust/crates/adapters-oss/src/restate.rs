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
//! - **Sleeps**: [`JobContext::sleep`] is a durable `ctx.sleep`; Restate
//!   suspends the invocation and calls it back when the time is up.
//! - **Signals**: one virtual object per job and signal, `WeldsuiteJobSignals`
//!   keyed `<name>:<key>:<signal>` ([`SIGNALS_OBJECT`]). A
//!   [`wait_for_signal`](JobContext::wait_for_signal) creates an awakeable,
//!   parks its id in the object (`park`, a journaled one-way send) and awaits
//!   the awakeable or a durable `ctx.sleep(timeout)`, whichever comes first;
//!   after a timeout it takes the id back (`unpark`). [`RestateJobs::signal`]
//!   calls the object's `signal` handler through the ingress
//!   (`POST <ingress>/WeldsuiteJobSignals/<key>/signal`), which resolves the
//!   parked awakeable and answers `true`, or keeps the signal (object state,
//!   cleared by a delayed `expire` after
//!   [`PENDING_SIGNAL_TTL`](weldsuite_ports::PENDING_SIGNAL_TTL)) and answers
//!   `false`. A virtual object runs one handler per key at a time, so a park
//!   and a signal never interleave.
//! - **Endpoint**: the `weldsuite serve` process also serves both Restate
//!   services on its own port ([`serve_endpoint`]; `JOBS_PORT`, 9080 by
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
    BoxFuture, JobContext, JobError, JobRegistry, JobRequest, Jobs, PENDING_SIGNAL_TTL, PortError,
    StepFn, StepRetry,
};

/// The Restate service every job runs under.
pub const JOBS_SERVICE: &str = "WeldsuiteJobs";

/// The Restate virtual object that carries signals to waiting jobs.
pub const SIGNALS_OBJECT: &str = "WeldsuiteJobSignals";

/// The [`SIGNALS_OBJECT`] key of one job's signal.
fn signal_object_key(name: &str, key: &str, signal: &str) -> String {
    format!("{name}:{key}:{signal}")
}

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

    async fn deliver(&self, name: &str, key: &str, signal: &str) -> Result<bool, PortError> {
        let url = signal_url(&self.ingress_url, &signal_object_key(name, key, signal))?;
        let response = self
            .client
            .post(url)
            .send()
            .await
            .map_err(PortError::backend)?;
        let status = response.status();
        let body = response.bytes().await.map_err(PortError::backend)?;
        if status.is_success() {
            return Ok(serde_json::from_slice(&body)?);
        }
        Err(PortError::backend(format!(
            "restate ingress answered {status}: {}",
            String::from_utf8_lossy(&body)
                .chars()
                .take(300)
                .collect::<String>()
        )))
    }
}

/// The ingress URL that signals a job: the `signal` handler of the
/// [`SIGNALS_OBJECT`] keyed `object_key`, the key percent-encoded as one path
/// segment.
fn signal_url(ingress_url: &str, object_key: &str) -> Result<reqwest::Url, PortError> {
    let mut url = reqwest::Url::parse(ingress_url).map_err(PortError::backend)?;
    url.path_segments_mut()
        .map_err(|()| PortError::backend(format!("{ingress_url} cannot take a path")))?
        .pop_if_empty()
        .extend([SIGNALS_OBJECT, object_key, "signal"]);
    Ok(url)
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

    fn signal<'a>(
        &'a self,
        name: &'a str,
        key: &'a str,
        signal: &'a str,
    ) -> impl Future<Output = Result<bool, PortError>> + Send + 'a {
        self.deliver(name, key, signal)
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
            name: call.name,
            key: call.key,
            ctx: &ctx,
        };
        job.run(&context, call.payload).await.map_err(|error| {
            tracing::error!(job = context.name, key = context.key, %error, "jobs: job failed");
            // Steps retry by their own policy; the job as a whole does not.
            TerminalError::new(error.to_string()).into()
        })
    }
}

struct RestateContext<'c> {
    name: String,
    key: String,
    ctx: &'c Context<'c>,
}

impl JobContext for RestateContext<'_> {
    fn key(&self) -> &str {
        &self.key
    }

    fn sleep(&self, name: &str, duration: Duration) -> BoxFuture<'_, Result<(), JobError>> {
        let ctx: &Context<'_> = self.ctx;
        let name = name.to_owned();
        Box::pin(async move {
            ctx.sleep(duration)
                .await
                .map_err(|error| JobError::Failed(format!("sleep {name:?}: {error}")))
        })
    }

    fn wait_for_signal(
        &self,
        name: &str,
        signal: &str,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<bool, JobError>> {
        let ctx: &Context<'_> = self.ctx;
        let object = signal_object_key(&self.name, &self.key, signal);
        let name = name.to_owned();
        Box::pin(async move {
            let (awakeable_id, woken) = ctx.awakeable::<()>();
            ctx.object_client::<WeldsuiteJobSignalsClient>(object.clone())
                .park(awakeable_id.clone())
                .send();
            let outcome = restate_sdk::select! {
                woke = woken => woke.map(|()| true),
                slept = ctx.sleep(timeout) => slept.map(|()| false),
                on_cancel => Err(TerminalError::new_with_code(409, "cancelled")),
            };
            let woke =
                outcome.map_err(|error| JobError::Failed(format!("waiting {name:?}: {error}")))?;
            if !woke {
                // Take the id back, so a later signal is kept for the next
                // wait instead of resolving this spent awakeable.
                ctx.object_client::<WeldsuiteJobSignalsClient>(object)
                    .unpark(awakeable_id)
                    .send();
            }
            Ok(woke)
        })
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

/// Object state: the awakeable id of the wait parked on the signal.
const PARKED: &str = "parked";
/// Object state: a signal no wait was parked for, until it is taken or
/// expires. The value is the id of the invocation that kept it, so only that
/// one's `expire` clears it.
const PENDING: &str = "pending";

/// The Restate virtual object that carries one job's signal
/// ([`SIGNALS_OBJECT`], keyed `<name>:<key>:<signal>`).
pub struct WeldsuiteJobSignals;

#[restate_sdk::object]
impl WeldsuiteJobSignals {
    /// A wait parks its awakeable; a kept signal resolves it at once.
    #[handler]
    async fn park(&self, ctx: ObjectContext<'_>, awakeable_id: String) -> Result<(), HandlerError> {
        if ctx.get::<String>(PENDING).await?.is_some() {
            ctx.clear(PENDING);
            ctx.resolve_awakeable(&awakeable_id, ());
        } else {
            ctx.set(PARKED, awakeable_id);
        }
        Ok(())
    }

    /// A wait that timed out takes its awakeable back, if still parked.
    #[handler]
    async fn unpark(
        &self,
        ctx: ObjectContext<'_>,
        awakeable_id: String,
    ) -> Result<(), HandlerError> {
        if ctx.get::<String>(PARKED).await?.as_deref() == Some(awakeable_id.as_str()) {
            ctx.clear(PARKED);
        }
        Ok(())
    }

    /// Wake the parked wait (`true`), or keep the signal for the next one
    /// (`false`) until `PENDING_SIGNAL_TTL` from now.
    #[handler]
    async fn signal(&self, ctx: ObjectContext<'_>) -> Result<bool, HandlerError> {
        if let Some(awakeable_id) = ctx.get::<String>(PARKED).await? {
            ctx.clear(PARKED);
            ctx.resolve_awakeable(&awakeable_id, ());
            return Ok(true);
        }
        let token = ctx.invocation_id().to_owned();
        ctx.set(PENDING, token.clone());
        ctx.object_client::<WeldsuiteJobSignalsClient>(ctx.key())
            .expire(token)
            .send_after(PENDING_SIGNAL_TTL);
        Ok(false)
    }

    /// Drop the kept signal, unless a later one replaced it.
    #[handler]
    async fn expire(&self, ctx: ObjectContext<'_>, token: String) -> Result<(), HandlerError> {
        if ctx.get::<String>(PENDING).await?.as_deref() == Some(token.as_str()) {
            ctx.clear(PENDING);
        }
        Ok(())
    }
}

/// Serve the jobs service and the signals object for Restate on `listener`
/// until `shutdown` resolves.
pub async fn serve_endpoint(
    registry: JobRegistry,
    listener: TcpListener,
    shutdown: impl Future<Output = ()>,
) {
    let endpoint = Endpoint::builder()
        .bind(WeldsuiteJobs { registry })
        .bind(WeldsuiteJobSignals)
        .build();
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

    #[test]
    fn signals_go_to_the_object_of_the_job_and_signal() {
        let key = signal_object_key("crm.execute-sequence", "enr_1/a b", "sequence-resume");
        assert_eq!(key, "crm.execute-sequence:enr_1/a b:sequence-resume");
        assert_eq!(
            signal_url("http://restate:8080", &key)
                .expect("a url")
                .as_str(),
            "http://restate:8080/WeldsuiteJobSignals/crm.execute-sequence:enr_1%2Fa%20b:sequence-resume/signal"
        );
        // An ingress behind a path keeps it.
        assert_eq!(
            signal_url("http://gateway/restate", "a:b:c")
                .expect("a url")
                .as_str(),
            "http://gateway/restate/WeldsuiteJobSignals/a:b:c/signal"
        );
        assert!(signal_url("not a url", "a:b:c").is_err());
    }

    /// Answers one request with `response` on a socket standing in for the
    /// ingress, and hands back what was sent.
    async fn ingress_answering(response: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let ingress = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut seen = Vec::new();
            let mut buffer = [0u8; 4096];
            while !String::from_utf8_lossy(&seen).contains("\r\n\r\n") {
                let read = socket.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                seen.extend_from_slice(&buffer[..read]);
            }
            socket.write_all(response.as_bytes()).await.expect("write");
            String::from_utf8_lossy(&seen).into_owned()
        });
        (format!("http://{address}/"), ingress)
    }

    #[tokio::test]
    async fn a_signal_calls_the_object_and_reads_whether_it_woke_a_wait() {
        for (answer, woke) in [("true", true), ("false", false)] {
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{answer}",
                answer.len()
            );
            let (ingress_url, ingress) = ingress_answering(response).await;
            let jobs = RestateJobs::new(&ingress_url, reqwest::Client::new());
            let answered = jobs
                .signal("crm.execute-sequence", "enr_1", "sequence-resume")
                .await
                .expect("signalled");
            assert_eq!(answered, woke);
            let sent = ingress.await.expect("ingress").to_ascii_lowercase();
            assert!(
                sent.starts_with(
                    "post /weldsuitejobsignals/crm.execute-sequence:enr_1:sequence-resume/signal http/1.1"
                ),
                "{sent}"
            );
        }
    }

    #[tokio::test]
    async fn a_refused_signal_is_an_error() {
        let (ingress_url, ingress) = ingress_answering(
            "HTTP/1.1 404 Not Found\r\ncontent-length: 17\r\n\r\nservice not found".to_owned(),
        )
        .await;
        let jobs = RestateJobs::new(&ingress_url, reqwest::Client::new());
        let refused = jobs.signal("crm.execute-sequence", "enr_1", "go").await;
        let message = refused.expect_err("refused").to_string();
        assert!(
            message.contains("404") && message.contains("service not found"),
            "{message}"
        );
        ingress.await.expect("ingress");
    }
}
