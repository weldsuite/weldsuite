//! Jobs on a real Restate server. Runs when these are set (CI's
//! `Rust · checks` does), and passes trivially otherwise:
//!
//! - `WELDSUITE_TEST_RESTATE_INGRESS`: `http://localhost:8080`
//! - `WELDSUITE_TEST_RESTATE_ADMIN`: `http://localhost:9070`
//! - `WELDSUITE_TEST_RESTATE_ENDPOINT_HOST`: how the Restate server reaches
//!   this test process (`host.docker.internal` for a container).

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
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

#[tokio::test]
async fn jobs_run_once_per_key_with_retried_steps() {
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
    let registry = JobRegistry::new();
    registry.register(Counting {
        runs: Arc::clone(&runs),
        attempts: Arc::clone(&attempts),
        done: Arc::clone(&done),
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

    let _ = stop.send(());
    let _ = server.await;
}
