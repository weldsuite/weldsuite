//! Durable jobs: work that outlives the request that started it, in steps
//! that are each retried on their own. Replaces the Cloudflare Workflows
//! (`WorkflowEntrypoint`, `step.do`) and the `waitUntil` fallback a Worker
//! uses without the binding.
//!
//! A module implements [`Job`] for each kind of job and registers it in the
//! process's [`JobRegistry`]; a route starts one with [`Jobs::start`] and a
//! key. One run per key, like a Workflow instance id: starting the same key
//! again while it runs, or after it succeeded, does nothing.
//!
//! ```ignore
//! struct Finalize { /* the module's state */ }
//!
//! impl Job for Finalize {
//!     fn name(&self) -> &'static str { "sign.finalize" }
//!
//!     fn run<'a>(&'a self, ctx: &'a dyn JobContext, payload: Value) -> BoxFuture<'a, Result<(), JobError>> {
//!         Box::pin(async move {
//!             let built: Option<String> =
//!                 step(ctx, "build signed pdf", StepRetry::exponential(5, secs(10)), || async { … }).await?;
//!             …
//!         })
//!     }
//! }
//! ```
//!
//! Inside a step, do the work and return its result: a replay after a crash
//! (on Restate) returns the journaled result instead of running the step
//! again. Code between steps runs again on a replay, so keep it free of side
//! effects.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{BoxFuture, PortError};

/// Start one job.
#[derive(Debug, Clone, PartialEq)]
pub struct JobRequest {
    /// The [`Job::name`] of the handler, `sign.finalize`.
    pub name: String,
    /// One run per key (the Workflow instance id), `finalize-sgn_123`.
    pub key: String,
    pub payload: Value,
}

impl JobRequest {
    /// A request whose payload is `payload` as JSON.
    pub fn new(
        name: impl Into<String>,
        key: impl Into<String>,
        payload: &impl Serialize,
    ) -> Result<Self, PortError> {
        Ok(Self {
            name: name.into(),
            key: key.into(),
            payload: serde_json::to_value(payload)?,
        })
    }
}

/// Starts jobs. `start` returns once the job is accepted (stored, on a
/// durable adapter); it never waits for the job to run.
pub trait Jobs: Send + Sync {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send;
}

/// Object-safe [`Jobs`], for `Arc<dyn DynJobs>`.
pub trait DynJobs: Send + Sync {
    fn start_boxed(&self, request: JobRequest) -> BoxFuture<'_, Result<(), PortError>>;
}

impl<J: Jobs> DynJobs for J {
    fn start_boxed(&self, request: JobRequest) -> BoxFuture<'_, Result<(), PortError>> {
        Box::pin(self.start(request))
    }
}

impl Jobs for dyn DynJobs {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        self.start_boxed(request)
    }
}

impl<J: Jobs + ?Sized> Jobs for Arc<J> {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        (**self).start(request)
    }
}

/// Why a job or a step failed. A step that fails is retried by its
/// [`StepRetry`]; once those attempts are spent the job fails with
/// [`JobError::StepFailed`] and stops (a Workflow instance that errored).
#[derive(Debug)]
pub enum JobError {
    /// The step's code failed; retried while attempts are left.
    Failed(String),
    /// The step failed on its last attempt.
    StepFailed { step: String, message: String },
    /// The payload or a step's result is not the JSON expected.
    Json(serde_json::Error),
    /// No handler is registered under the request's name.
    UnknownJob(String),
}

impl JobError {
    pub fn failed(error: impl std::fmt::Display) -> Self {
        Self::Failed(error.to_string())
    }
}

impl std::fmt::Display for JobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) => f.write_str(message),
            Self::StepFailed { step, message } => {
                write!(f, "step {step:?} failed after its retries: {message}")
            }
            Self::Json(error) => write!(f, "job JSON: {error}"),
            Self::UnknownJob(name) => write!(f, "no job named {name:?} is registered"),
        }
    }
}

impl std::error::Error for JobError {}

impl From<serde_json::Error> for JobError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// How a step is retried (`step.do(name, { retries: { limit, delay, backoff } })`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepRetry {
    /// Attempts in all, the first included. At least 1.
    pub max_attempts: u32,
    /// The wait before the second attempt.
    pub initial_delay: Duration,
    /// Each wait is the previous one times this (1.0: constant).
    pub factor: f32,
    /// No wait is longer than this.
    pub max_delay: Option<Duration>,
}

impl StepRetry {
    /// One attempt, no retry.
    pub const ONCE: Self = Self {
        max_attempts: 1,
        initial_delay: Duration::ZERO,
        factor: 1.0,
        max_delay: None,
    };

    /// `retries: { limit, delay, backoff: 'exponential' }`: `limit` retries
    /// after the first attempt, the wait doubling from `delay`.
    pub const fn exponential(limit: u32, delay: Duration) -> Self {
        Self {
            max_attempts: limit + 1,
            initial_delay: delay,
            factor: 2.0,
            max_delay: None,
        }
    }

    /// The wait before attempt `attempt + 1` (`attempt` from 1).
    pub fn delay_after(&self, attempt: u32) -> Duration {
        let exponent = i32::try_from(attempt.saturating_sub(1)).unwrap_or(i32::MAX);
        let delay = self
            .initial_delay
            .mul_f64(f64::from(self.factor).powi(exponent));
        match self.max_delay {
            Some(max) if delay > max => max,
            _ => delay,
        }
    }
}

impl Default for StepRetry {
    /// Cloudflare's default for `step.do` without options: 5 retries, 10 s,
    /// exponential.
    fn default() -> Self {
        Self::exponential(5, Duration::from_secs(10))
    }
}

/// A step's code: called once per attempt.
pub type StepFn<'a> = dyn Fn() -> BoxFuture<'a, Result<Value, JobError>> + Send + Sync + 'a;

/// What a running job gets from its adapter: durable steps.
pub trait JobContext: Send + Sync {
    /// The key the job was started with.
    fn key(&self) -> &str;

    /// Run `step` until it succeeds or `retry` is spent, and remember its
    /// result: a replay of the job returns it without running the step again.
    fn run_step<'s>(
        &'s self,
        name: &'s str,
        retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>>;
}

/// `await step.do(name, options, async () => …)`, typed: the step's result
/// goes through JSON, as the journal keeps it.
pub async fn step<'a, T, F, Fut>(
    ctx: &'a dyn JobContext,
    name: &'a str,
    retry: StepRetry,
    code: F,
) -> Result<T, JobError>
where
    T: Serialize + DeserializeOwned,
    F: Fn() -> Fut + Send + Sync + 'a,
    Fut: Future<Output = Result<T, JobError>> + Send + 'a,
{
    let as_json = move || {
        let attempt = code();
        Box::pin(async move { Ok(serde_json::to_value(attempt.await?)?) })
            as BoxFuture<'_, Result<Value, JobError>>
    };
    let value = ctx.run_step(name, retry, &as_json).await?;
    Ok(serde_json::from_value(value)?)
}

/// One kind of job (a `WorkflowEntrypoint` class).
pub trait Job: Send + Sync + 'static {
    /// The name it is started under, `<module>.<job>`: `sign.finalize`.
    fn name(&self) -> &'static str;

    /// Run the job. Do the work in [`step`]s; an error fails the job.
    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>>;
}

/// The jobs this process can run, by name. Cheap to clone; the adapters hold
/// one from the start and modules register into it once their state exists.
#[derive(Clone, Default)]
pub struct JobRegistry {
    jobs: Arc<RwLock<HashMap<&'static str, Arc<dyn Job>>>>,
}

impl std::fmt::Debug for JobRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobRegistry")
            .field("jobs", &self.names())
            .finish()
    }
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a job; a second job under the same name replaces the first.
    pub fn register(&self, job: impl Job) {
        let job: Arc<dyn Job> = Arc::new(job);
        self.jobs
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(job.name(), job);
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Job>> {
        self.jobs
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
    }

    /// The registered names, sorted.
    pub fn names(&self) -> Vec<&'static str> {
        let mut names: Vec<_> = self
            .jobs
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect();
        names.sort_unstable();
        names
    }
}

/// A job that does nothing, under [`NoopJob::NAME`]: what the smoke test
/// starts to prove jobs run end to end.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopJob;

impl NoopJob {
    pub const NAME: &'static str = "weldsuite.noop";
}

impl Job for NoopJob {
    fn name(&self) -> &'static str {
        Self::NAME
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let echoed: Value = step(ctx, "echo", StepRetry::ONCE, || {
                let payload = payload.clone();
                async move { Ok(payload) }
            })
            .await?;
            tracing::info!(key = ctx.key(), payload = %echoed, "jobs: noop job ran");
            Ok(())
        })
    }
}
