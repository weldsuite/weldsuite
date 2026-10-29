//! Jobs on a real Restate server. Runs when these are set (CI's
//! `Rust · checks` does), and passes trivially otherwise:
//!
//! - `WELDSUITE_TEST_RESTATE_INGRESS`: `http://localhost:8080`
//! - `WELDSUITE_TEST_RESTATE_ADMIN`: `http://localhost:9070`
//! - `WELDSUITE_TEST_RESTATE_ENDPOINT_HOST`: how the Restate server reaches
//!   this test process (`host.docker.internal` for a container).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_adapters_oss::{RestateJobs, register_deployment, serve_endpoint};
use weldsuite_ports::{
    BoxFuture, Job, JobContext, JobError, JobRegistry, JobRequest, Jobs, StepRetry, step,
};

struct Counting {
    runs: Arc<AtomicU32>,
    attempts: Arc<AtomicU32>,
    done: Arc<AtomicU32>,
}

impl Job for Counting {
    fn name(&self) -> &'static str {
        "test.counting"
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            self.runs.fetch_add(1, Ordering::SeqCst);
            let retry = StepRetry {
                max_attempts: 5,
                initial_delay: Duration::from_millis(50),
                factor: 1.0,
                max_delay: None,
            };
            // Fails once, then succeeds: Restate retries the step.
            let n: i64 = step(ctx, "flaky", retry, || async {
                if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(JobError::failed("first attempt fails"));
                }
                Ok(payload["n"].as_i64().unwrap_or(0) + 1)
            })
            .await?;
            if n == 42 {
                self.done.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        })
    }
}

/// Naps, then waits three times: for a signal sent during the nap (kept, so
/// `true` at once), for one that never comes (`false` after a second), and
/// for one sent while it is parked (`true`).
struct Waiting {
    /// What each wait answered; by index, so a replay rewrites the same slot.
    outcomes: Arc<Mutex<[Option<bool>; 3]>>,
    /// Set just before the third wait parks.
    parking: Arc<AtomicU32>,
}

impl Job for Waiting {
    fn name(&self) -> &'static str {
        "test.waiting"
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        _payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let record = |wait: usize, woke: bool| {
                self.outcomes.lock().unwrap_or_else(PoisonError::into_inner)[wait] = Some(woke);
            };
            ctx.sleep("nap", Duration::from_millis(500)).await?;
            record(
                0,
                ctx.wait_for_signal("kept", "go", Duration::from_secs(60))
                    .await?,
            );
            record(
                1,
                ctx.wait_for_signal("never", "never", Duration::from_secs(1))
                    .await?,
            );
            self.parking.store(1, Ordering::SeqCst);
            record(
                2,
                ctx.wait_for_signal("parked", "again", Duration::from_secs(60))
                    .await?,
            );
            Ok(())
        })
    }
}

#[tokio::test]
async fn jobs_run_steps_sleeps_and_signals_on_restate() {
    let (Ok(ingress), Ok(admin), Ok(host)) = (
        std::env::var("WELDSUITE_TEST_RESTATE_INGRESS"),
        std::env::var("WELDSUITE_TEST_RESTATE_ADMIN"),
        std::env::var("WELDSUITE_TEST_RESTATE_ENDPOINT_HOST"),
    ) else {
        eprintln!("WELDSUITE_TEST_RESTATE_* not set; skipping");
        return;
    };

    let runs = Arc::new(AtomicU32::new(0));
    let attempts = Arc::new(AtomicU32::new(0));
    let done = Arc::new(AtomicU32::new(0));
    let outcomes = Arc::new(Mutex::new([None; 3]));
    let parking = Arc::new(AtomicU32::new(0));
    // One registry and endpoint for every scenario: registering a second
    // deployment would take the services over from the first.
    let registry = JobRegistry::new();
    registry.register(Counting {
        runs: Arc::clone(&runs),
        attempts: Arc::clone(&attempts),
        done: Arc::clone(&done),
    });
    registry.register(Waiting {
        outcomes: Arc::clone(&outcomes),
        parking: Arc::clone(&parking),
    });

    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .expect("a port");
    let port = listener.local_addr().expect("an address").port();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(serve_endpoint(registry, listener, async {
        let _ = stopped.await;
    }));

    let client = reqwest::Client::new();
    register_deployment(
        &client,
        &admin,
        &format!("http://{host}:{port}"),
        Duration::from_secs(60),
    )
    .await
    .expect("registered");

    let jobs = RestateJobs::new(&ingress, client);
    // A fresh key per run, so the test is repeatable within Restate's retention.
    let key = format!("k-{}", std::process::id());
    let request = JobRequest::new("test.counting", &key, &json!({ "n": 41 })).expect("a request");
    jobs.start(request.clone()).await.expect("started");
    jobs.start(request).await.expect("started again");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while done.load(Ordering::SeqCst) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Give a duplicate a moment to show up if deduplication failed.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(done.load(Ordering::SeqCst), 1, "the job finished once");
    assert!(attempts.load(Ordering::SeqCst) >= 2, "the step was retried");
    // A retried step replays the invocation; it never starts a second one.
    assert!(runs.load(Ordering::SeqCst) >= 1);

    // Sleeps and signals.
    let key = format!(
        "w-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let request = JobRequest::new("test.waiting", &key, &json!({})).expect("a request");
    jobs.start(request).await.expect("started");
    // During the nap: nothing is parked yet, so the signal is kept.
    jobs.signal("test.waiting", &key, "go")
        .await
        .expect("signalled");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while parking.load(Ordering::SeqCst) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let third_answered = || outcomes.lock().unwrap_or_else(PoisonError::into_inner)[2].is_some();
    while !third_answered() && tokio::time::Instant::now() < deadline {
        // Kept if the wait is not parked yet; it then returns at once.
        jobs.signal("test.waiting", &key, "again")
            .await
            .expect("signalled");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(
        *outcomes.lock().unwrap_or_else(PoisonError::into_inner),
        [Some(true), Some(false), Some(true)],
        "kept signal, timeout, parked signal"
    );

    let _ = stop.send(());
    let _ = server.await;
}
