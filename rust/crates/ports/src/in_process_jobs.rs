//! [`Jobs`] in the server process: each job runs as a task on the server's
//! [`TaskTracker`] (the workers' `waitUntil` fallback without a Workflow
//! binding). For conformance builds, tests, and installs without Restate.
//!
//! Steps are retried by their [`StepRetry`] but nothing is journaled: a job
//! cut off by a restart is lost, and graceful shutdown waits for the tracker.
//! One run per key within the process; a key whose last run failed may be
//! started again (a Workflow instance that errored is restarted).
//!
//! [`sleep`](JobContext::sleep) is a Tokio sleep. Signals go through a table
//! in the process, by job name, key and signal: a parked
//! [`wait_for_signal`](JobContext::wait_for_signal) leaves a oneshot there
//! that [`Jobs::signal`] fires; a signal that finds none is kept (one per
//! signal, merged) for [`PENDING_SIGNAL_TTL`], as on Restate. Neither
//! outlives the process.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::task::TaskTracker;

use crate::jobs::{
    JobContext, JobError, JobRegistry, JobRequest, Jobs, PENDING_SIGNAL_TTL, StepFn, StepRetry,
};
use crate::{BoxFuture, PortError};

/// Finished keys kept for deduplication before the oldest are forgotten.
const MAX_REMEMBERED: usize = 10_000;

/// Signal slots held before the expired ones are swept.
const MAX_SIGNAL_SLOTS: usize = 10_000;

/// A signal's address: job name, job key, signal.
type SignalId = (String, String, String);

/// The signals of one job and signal name.
#[derive(Debug, Default)]
struct SignalSlot {
    /// The wait parked on the signal: its number and the sender that wakes it.
    parked: Option<(u64, oneshot::Sender<()>)>,
    /// When a signal arrived that no wait was parked for. Never set while a
    /// wait is parked: parking takes it.
    pending_since: Option<Instant>,
}

impl SignalSlot {
    fn is_empty(&self) -> bool {
        self.parked.is_none() && self.pending_since.is_none()
    }
}

/// What [`SignalTable::park`] did.
enum Parked {
    /// A kept signal was waiting: the wait is over.
    Pending,
    /// The wait is parked as number `.0`; `.1` fires when it is signalled.
    Waiting(u64, oneshot::Receiver<()>),
}

/// The signal slots of the process.
#[derive(Debug, Default)]
struct SignalTable {
    slots: HashMap<SignalId, SignalSlot>,
    next_wait: u64,
}

impl SignalTable {
    /// Wake the wait parked on `id` (`true`), or keep the signal for the
    /// next one (`false`).
    fn deliver(&mut self, id: SignalId, now: Instant) -> bool {
        if let Some(slot) = self.slots.get_mut(&id)
            && let Some((_, waiter)) = slot.parked.take()
            && waiter.send(()).is_ok()
        {
            self.slots.remove(&id);
            return true;
        }
        // No wait, or one whose job was dropped mid-wait: keep the signal.
        if self.slots.len() >= MAX_SIGNAL_SLOTS {
            self.sweep(now);
        }
        self.slots.entry(id).or_default().pending_since = Some(now);
        false
    }

    /// Take a kept signal, or park a new wait (replacing an older one).
    fn park(&mut self, id: &SignalId, now: Instant) -> Parked {
        if let Some(slot) = self.slots.get_mut(id)
            && let Some(since) = slot.pending_since.take()
        {
            if slot.is_empty() {
                self.slots.remove(id);
            }
            if now.duration_since(since) < PENDING_SIGNAL_TTL {
                return Parked::Pending;
            }
        }
        let wait = self.next_wait;
        self.next_wait += 1;
        let (waker, woken) = oneshot::channel();
        self.slots.entry(id.clone()).or_default().parked = Some((wait, waker));
        Parked::Waiting(wait, woken)
    }

    /// Remove wait `wait` after its timeout. `false`: it was no longer
    /// parked (a signal took it just now, or a newer wait replaced it).
    fn unpark(&mut self, id: &SignalId, wait: u64) -> bool {
        let Some(slot) = self.slots.get_mut(id) else {
            return false;
        };
        if slot
            .parked
            .as_ref()
            .is_none_or(|(parked, _)| *parked != wait)
        {
            return false;
        }
        slot.parked = None;
        if slot.is_empty() {
            self.slots.remove(id);
        }
        true
    }

    /// Forget expired signals and waits whose job is gone.
    fn sweep(&mut self, now: Instant) {
        self.slots.retain(|_, slot| {
            if slot
                .pending_since
                .is_some_and(|since| now.duration_since(since) >= PENDING_SIGNAL_TTL)
            {
                slot.pending_since = None;
            }
            if slot
                .parked
                .as_ref()
                .is_some_and(|(_, waiter)| waiter.is_closed())
            {
                slot.parked = None;
            }
            !slot.is_empty()
        });
    }
}

fn lock_signals(signals: &Mutex<SignalTable>) -> MutexGuard<'_, SignalTable> {
    signals.lock().unwrap_or_else(PoisonError::into_inner)
}

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
    signals: Arc<Mutex<SignalTable>>,
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
            signals: Arc::default(),
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
                let ctx = InProcessContext {
                    name: request.name,
                    key: request.key,
                    signals: Arc::clone(&this.signals),
                };
                let state = match job.run(&ctx, request.payload).await {
                    Ok(()) => RunState::Succeeded,
                    Err(error) => {
                        tracing::error!(job = ctx.name, key = ctx.key, %error, "jobs: job failed");
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

    fn signal<'a>(
        &'a self,
        name: &'a str,
        key: &'a str,
        signal: &'a str,
    ) -> impl Future<Output = Result<bool, PortError>> + Send + 'a {
        let id = (name.to_owned(), key.to_owned(), signal.to_owned());
        let woke = lock_signals(&self.signals).deliver(id, Instant::now());
        std::future::ready(Ok(woke))
    }
}

struct InProcessContext {
    name: String,
    key: String,
    signals: Arc<Mutex<SignalTable>>,
}

impl JobContext for InProcessContext {
    fn key(&self) -> &str {
        &self.key
    }

    fn sleep(&self, name: &str, duration: Duration) -> BoxFuture<'_, Result<(), JobError>> {
        tracing::debug!(
            job = self.name,
            key = self.key,
            sleep = name,
            ?duration,
            "jobs: sleeping"
        );
        Box::pin(async move {
            tokio::time::sleep(duration).await;
            Ok(())
        })
    }

    fn wait_for_signal(
        &self,
        name: &str,
        signal: &str,
        timeout: Duration,
    ) -> BoxFuture<'_, Result<bool, JobError>> {
        tracing::debug!(
            job = self.name,
            key = self.key,
            wait = name,
            signal,
            ?timeout,
            "jobs: waiting for a signal"
        );
        let id = (self.name.clone(), self.key.clone(), signal.to_owned());
        Box::pin(async move {
            let parked = lock_signals(&self.signals).park(&id, Instant::now());
            let (wait, mut woken) = match parked {
                Parked::Pending => return Ok(true),
                Parked::Waiting(wait, woken) => (wait, woken),
            };
            match tokio::time::timeout(timeout, &mut woken).await {
                // `Err`: a newer wait for the same signal replaced this one.
                Ok(result) => Ok(result.is_ok()),
                Err(_elapsed) => {
                    let unparked = lock_signals(&self.signals).unpark(&id, wait);
                    // Not parked any more: a signal fired it as time ran out
                    // (it sends under the lock, so it has arrived).
                    Ok(!unparked && woken.try_recv().is_ok())
                }
            }
        })
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
    use crate::jobs::{DynJobs, Job, NoopJob, step};

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

    const HOUR: Duration = Duration::from_hours(1);

    /// Naps, then waits for each `(signal, timeout)` in turn, recording what
    /// each wait answered.
    struct Waiter {
        nap: Duration,
        waits: Vec<(&'static str, Duration)>,
        outcomes: Arc<Mutex<Vec<bool>>>,
    }

    impl Job for Waiter {
        fn name(&self) -> &'static str {
            "test.waiter"
        }

        fn run<'a>(
            &'a self,
            ctx: &'a dyn JobContext,
            _payload: Value,
        ) -> BoxFuture<'a, Result<(), JobError>> {
            Box::pin(async move {
                ctx.sleep("nap", self.nap).await?;
                for (n, (signal, timeout)) in self.waits.iter().enumerate() {
                    let woke = ctx
                        .wait_for_signal(&format!("wait-{n}"), signal, *timeout)
                        .await?;
                    self.outcomes
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(woke);
                }
                Ok(())
            })
        }
    }

    /// Starts a [`Waiter`] under key `k`; the jobs come back as a
    /// `dyn DynJobs`, so signals go through the boxed twin.
    async fn start_waiter(
        nap: Duration,
        waits: Vec<(&'static str, Duration)>,
    ) -> (Arc<dyn DynJobs>, TaskTracker, Arc<Mutex<Vec<bool>>>) {
        let outcomes = Arc::new(Mutex::new(Vec::new()));
        let registry = JobRegistry::new();
        registry.register(Waiter {
            nap,
            waits,
            outcomes: Arc::clone(&outcomes),
        });
        let tracker = TaskTracker::new();
        let jobs: Arc<dyn DynJobs> = Arc::new(InProcessJobs::new(registry, tracker.clone()));
        let request =
            JobRequest::new("test.waiter", "k", &serde_json::json!({})).expect("a request");
        jobs.start(request).await.expect("started");
        (jobs, tracker, outcomes)
    }

    fn outcomes(recorded: &Mutex<Vec<bool>>) -> Vec<bool> {
        recorded
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[tokio::test(start_paused = true)]
    async fn a_signal_wakes_a_parked_wait_and_a_wait_times_out() {
        let (jobs, tracker, recorded) =
            start_waiter(HOUR, vec![("go", 24 * HOUR), ("go", HOUR)]).await;
        let started = Instant::now();
        // Past the nap: the job is parked on its first wait.
        tokio::time::sleep(2 * HOUR).await;
        assert_eq!(outcomes(&recorded), Vec::<bool>::new());
        assert!(jobs.signal("test.waiter", "k", "go").await.expect("sent"));
        // Another job, key or signal reaches nobody.
        assert!(!jobs.signal("test.other", "k", "go").await.expect("sent"));
        assert!(!jobs.signal("test.waiter", "k2", "go").await.expect("sent"));
        settle(&tracker).await;
        // The second wait found nothing kept and ran out its hour.
        assert_eq!(outcomes(&recorded), [true, false]);
        assert_eq!(started.elapsed(), 3 * HOUR);
    }

    #[tokio::test(start_paused = true)]
    async fn a_signal_before_the_wait_is_kept_once() {
        let (jobs, tracker, recorded) =
            start_waiter(HOUR, vec![("go", 24 * HOUR), ("go", HOUR)]).await;
        let started = Instant::now();
        tokio::time::sleep(HOUR / 2).await;
        // The job naps: both signals are kept, as one.
        assert!(!jobs.signal("test.waiter", "k", "go").await.expect("sent"));
        assert!(!jobs.signal("test.waiter", "k", "go").await.expect("sent"));
        settle(&tracker).await;
        assert_eq!(outcomes(&recorded), [true, false]);
        // The first wait returned at once, the second ran out.
        assert_eq!(started.elapsed(), 2 * HOUR);
    }

    #[tokio::test(start_paused = true)]
    async fn a_kept_signal_expires() {
        let (jobs, tracker, recorded) = start_waiter(2 * HOUR, vec![("go", HOUR)]).await;
        assert!(!jobs.signal("test.waiter", "k", "go").await.expect("sent"));
        settle(&tracker).await;
        // Kept for an hour; the job woke from its two-hour nap after that.
        assert_eq!(outcomes(&recorded), [false]);
    }

    #[tokio::test(start_paused = true)]
    async fn waits_are_per_signal() {
        let (jobs, tracker, recorded) =
            start_waiter(HOUR, vec![("resume", HOUR / 6), ("go", HOUR)]).await;
        tokio::time::sleep(HOUR / 2).await;
        assert!(!jobs.signal("test.waiter", "k", "go").await.expect("sent"));
        settle(&tracker).await;
        // "resume" ran out; "go" had been kept (40 minutes, within its hour).
        assert_eq!(outcomes(&recorded), [false, true]);
    }

    #[test]
    fn the_signal_table_forgets_expired_signals_and_dropped_waits() {
        let mut table = SignalTable::default();
        let now = Instant::now();
        let id = |signal: &str| ("job".to_owned(), "k".to_owned(), signal.to_owned());
        assert!(!table.deliver(id("old"), now));
        let Parked::Waiting(_, woken) = table.park(&id("dropped"), now) else {
            panic!("nothing was kept for it");
        };
        drop(woken);
        let Parked::Waiting(wait, _woken) = table.park(&id("live"), now) else {
            panic!("nothing was kept for it");
        };
        assert_eq!(table.slots.len(), 3);
        table.sweep(now + PENDING_SIGNAL_TTL);
        assert_eq!(table.slots.keys().collect::<Vec<_>>(), [&id("live")]);
        assert!(table.unpark(&id("live"), wait));
        assert!(table.slots.is_empty());
        // A signal for a wait whose job is gone is kept instead.
        let Parked::Waiting(_, woken) = table.park(&id("gone"), now) else {
            panic!("nothing was kept for it");
        };
        drop(woken);
        assert!(!table.deliver(id("gone"), now));
        assert!(matches!(table.park(&id("gone"), now), Parked::Pending));
    }
}
