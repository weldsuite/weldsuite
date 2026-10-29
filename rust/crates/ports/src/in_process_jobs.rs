//! [`Jobs`] in the server process: each job runs as a task on the server's
//! [`TaskTracker`] (the workers' `waitUntil` fallback without a Workflow
//! binding). For conformance builds, tests, and installs without Restate.
//!
//! Steps are retried by their [`StepRetry`] but nothing is journaled: a job
//! cut off by a restart is lost, and graceful shutdown waits for the tracker.
//! One run per key within the process; a key whose last run failed may be
//! started again (a Workflow instance that errored is restarted).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use tokio_util::task::TaskTracker;

use crate::jobs::{JobContext, JobError, JobRegistry, JobRequest, Jobs, StepFn, StepRetry};
use crate::{BoxFuture, PortError};

/// Finished keys kept for deduplication before the oldest are forgotten.
const MAX_REMEMBERED: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunState {
    Running,
    Succeeded,
    Failed,
}

/// Jobs as tasks on a [`TaskTracker`].
#[derive(Clone)]
pub struct InProcessJobs {
    registry: JobRegistry,
    tracker: TaskTracker,
    runs: Arc<Mutex<HashMap<String, RunState>>>,
}

impl std::fmt::Debug for InProcessJobs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InProcessJobs")
            .field("registry", &self.registry)
            .finish_non_exhaustive()
    }
}

impl InProcessJobs {
    pub fn new(registry: JobRegistry, tracker: TaskTracker) -> Self {
        Self {
            registry,
            tracker,
            runs: Arc::default(),
        }
    }

    /// Whether the run for `key` finished, and how: `Some(true)` succeeded,
    /// `Some(false)` failed, `None` still running or never started.
    pub fn finished(&self, key: &str) -> Option<bool> {
        match self.lock().get(key) {
            Some(RunState::Succeeded) => Some(true),
            Some(RunState::Failed) => Some(false),
            _ => None,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunState>> {
        self.runs.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, key: &str, state: RunState) {
        let mut runs = self.lock();
        if runs.len() >= MAX_REMEMBERED {
            runs.retain(|_, s| *s == RunState::Running);
        }
        runs.insert(key.to_owned(), state);
    }
}

impl Jobs for InProcessJobs {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        let started = (|| {
            let Some(job) = self.registry.get(&request.name) else {
                return Err(PortError::backend(JobError::UnknownJob(request.name)));
            };
            if matches!(
                self.lock().get(&request.key),
                Some(RunState::Running | RunState::Succeeded)
            ) {
                return Ok(());
            }
            if tokio::runtime::Handle::try_current().is_err() {
                return Err(PortError::backend("jobs: start outside a Tokio runtime"));
            }
            self.set(&request.key, RunState::Running);
            let this = self.clone();
            let run = async move {
                let ctx = InProcessContext { key: request.key };
                let state = match job.run(&ctx, request.payload).await {
                    Ok(()) => RunState::Succeeded,
                    Err(error) => {
                        tracing::error!(job = request.name, key = ctx.key, %error, "jobs: job failed");
                        RunState::Failed
                    }
                };
                this.set(&ctx.key, state);
            };
            match request.delay {
                // The wait is a plain task, off the tracker: graceful shutdown
                // waits for running jobs, not for ones due in a month (those
                // are lost on a restart, like every in-process job).
                Some(delay) => {
                    let tracker = self.tracker.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(delay).await;
                        tracker.spawn(run);
                    });
                }
                None => {
                    self.tracker.spawn(run);
                }
            }
            Ok(())
        })();
        std::future::ready(started)
    }
}

struct InProcessContext {
    key: String,
}

impl JobContext for InProcessContext {
    fn key(&self) -> &str {
        &self.key
    }

    fn run_step<'s>(
        &'s self,
        name: &'s str,
        retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        Box::pin(async move {
            let attempts = retry.max_attempts.max(1);
            let mut attempt = 1;
            loop {
                match step().await {
                    Ok(value) => return Ok(value),
                    Err(error) if attempt >= attempts => {
                        return Err(JobError::StepFailed {
                            step: name.to_owned(),
                            message: error.to_string(),
                        });
                    }
                    Err(error) => {
                        tracing::warn!(step = name, attempt, %error, "jobs: step failed; retrying");
                        tokio::time::sleep(retry.delay_after(attempt)).await;
                        attempt += 1;
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    use super::*;
    use crate::jobs::{Job, NoopJob, step};

    /// Fails its step `fail_first` times, then succeeds; counts attempts and runs.
    struct Flaky {
        fail_first: u32,
        attempts: Arc<AtomicU32>,
        runs: Arc<AtomicU32>,
    }

    impl Job for Flaky {
        fn name(&self) -> &'static str {
            "test.flaky"
        }

        fn run<'a>(
            &'a self,
            ctx: &'a dyn JobContext,
            payload: Value,
        ) -> BoxFuture<'a, Result<(), JobError>> {
            Box::pin(async move {
                self.runs.fetch_add(1, Ordering::SeqCst);
                let retry = StepRetry {
                    max_attempts: 3,
                    initial_delay: Duration::from_millis(1),
                    factor: 2.0,
                    max_delay: None,
                };
                let doubled: i64 = step(ctx, "double", retry, || async {
                    let attempt = self.attempts.fetch_add(1, Ordering::SeqCst) + 1;
                    if attempt <= self.fail_first {
                        return Err(JobError::failed(format!("attempt {attempt}")));
                    }
                    Ok(payload["n"].as_i64().unwrap_or(0) * 2)
                })
                .await?;
                assert_eq!(doubled, 42);
                Ok(())
            })
        }
    }

    fn flaky(fail_first: u32) -> (JobRegistry, Arc<AtomicU32>, Arc<AtomicU32>) {
        let registry = JobRegistry::new();
        let attempts = Arc::new(AtomicU32::new(0));
        let runs = Arc::new(AtomicU32::new(0));
        registry.register(Flaky {
            fail_first,
            attempts: Arc::clone(&attempts),
            runs: Arc::clone(&runs),
        });
        (registry, attempts, runs)
    }

    async fn settle(tracker: &TaskTracker) {
        tracker.close();
        tracker.wait().await;
        tracker.reopen();
    }

    #[tokio::test]
    async fn retries_a_step_and_runs_a_key_once() {
        let (registry, attempts, runs) = flaky(2);
        let tracker = TaskTracker::new();
        let jobs = InProcessJobs::new(registry, tracker.clone());
        let request = JobRequest::new("test.flaky", "k1", &serde_json::json!({ "n": 21 }))
            .expect("a request");
        jobs.start(request.clone()).await.expect("started");
        jobs.start(request.clone()).await.expect("started");
        settle(&tracker).await;
        assert_eq!(jobs.finished("k1"), Some(true));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        // Started twice while running, then again after it succeeded: one run.
        jobs.start(request).await.expect("started");
        settle(&tracker).await;
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_key_can_be_started_again() {
        let (registry, attempts, runs) = flaky(3);
        let tracker = TaskTracker::new();
        let jobs = InProcessJobs::new(registry, tracker.clone());
        let request = JobRequest::new("test.flaky", "k2", &serde_json::json!({ "n": 21 }))
            .expect("a request");
        jobs.start(request.clone()).await.expect("started");
        settle(&tracker).await;
        assert_eq!(jobs.finished("k2"), Some(false));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        jobs.start(request).await.expect("started");
        settle(&tracker).await;
        assert_eq!(jobs.finished("k2"), Some(true));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn unknown_jobs_are_refused_and_noop_runs() {
        let registry = JobRegistry::new();
        registry.register(NoopJob);
        let tracker = TaskTracker::new();
        let jobs = InProcessJobs::new(registry, tracker.clone());
        let unknown = JobRequest::new("nope", "k", &serde_json::json!({})).expect("a request");
        assert!(jobs.start(unknown).await.is_err());
        let noop = JobRequest::new(NoopJob::NAME, "k3", &serde_json::json!({ "hi": 1 }))
            .expect("a request");
        jobs.start(noop).await.expect("started");
        settle(&tracker).await;
        assert_eq!(jobs.finished("k3"), Some(true));
    }

    #[tokio::test(start_paused = true)]
    async fn a_delayed_job_waits_and_keeps_its_key() {
        let (registry, attempts, runs) = flaky(0);
        let tracker = TaskTracker::new();
        let jobs = InProcessJobs::new(registry, tracker.clone());
        let request = JobRequest::new("test.flaky", "k4", &serde_json::json!({ "n": 21 }))
            .expect("a request")
            .with_delay(Duration::from_hours(30 * 24));
        jobs.start(request.clone()).await.expect("started");
        // Started again while it waits: still one run.
        jobs.start(request).await.expect("started");
        tokio::time::sleep(Duration::from_hours(29 * 24)).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        assert_eq!(jobs.finished("k4"), None);
        tokio::time::sleep(Duration::from_hours(2 * 24)).await;
        settle(&tracker).await;
        assert_eq!(jobs.finished("k4"), Some(true));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn delays_from_a_start_time() {
        let request =
            JobRequest::new("test.flaky", "k", &serde_json::json!({})).expect("a request");
        assert_eq!(request.delay, None);
        let past = request
            .clone()
            .starting_at(std::time::SystemTime::now() - Duration::from_secs(5));
        assert_eq!(past.delay, None);
        let later = request.starting_at(std::time::SystemTime::now() + Duration::from_secs(3600));
        let delay = later.delay.expect("a delay");
        assert!(delay > Duration::from_secs(3590) && delay <= Duration::from_secs(3600));
    }

    #[test]
    fn exponential_delays() {
        let retry = StepRetry::exponential(5, Duration::from_secs(10));
        assert_eq!(retry.max_attempts, 6);
        assert_eq!(retry.delay_after(1), Duration::from_secs(10));
        assert_eq!(retry.delay_after(3), Duration::from_secs(40));
        let capped = StepRetry {
            max_delay: Some(Duration::from_secs(15)),
            ..retry
        };
        assert_eq!(capped.delay_after(3), Duration::from_secs(15));
    }
}
