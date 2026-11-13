//! Prometheus metrics: `GET /metrics` (text format) on a listener of its
//! own, `METRICS_ADDR` (default `0.0.0.0:9464`; `off` or empty turns it
//! off), never on the API's port and so never behind the ingress. `serve`,
//! `consume` and `mta` run it; a `cron <job>` run exits and has none
//! (kube-state-metrics reports its failures).
//!
//! The alert rules and dashboards read these names and labels: don't rename
//! them. No label carries a workspace, tenant, user or request id.
//!
//! | Metric | Labels | Where |
//! |---|---|---|
//! | `weldsuite_http_requests_total` | `method`, `route`, `status` | `serve` ([`track_http`]) |
//! | `weldsuite_http_request_duration_seconds` | `method`, `route` | `serve` |
//! | `weldsuite_http_requests_in_flight` | | `serve` |
//! | `weldsuite_db_pool_connections` | `pool`, `state` (`idle`, `in_use`) | every 15 s ([`sample_pools`]; the MTA its own) |
//! | `weldsuite_db_pool_max_connections` | `pool` | as above |
//! | `weldsuite_consumer_messages_total` | `consumer`, `outcome` (`ok`, `redelivered`, `error`) | `consume` (`weldsuite_adapters_oss::run_consumer`) |
//! | `weldsuite_job_runs_total` | `job`, `outcome` (`ok`, `error`) | durable jobs in `serve` (`weldsuite_ports::run_job`), the webhook retry sweep in `consume` |
//! | `weldsuite_job_duration_seconds` | `job` | as above |
//! | `weldsuite_mta_messages_total` | `pool`, `outcome` (`delivered`, `deferred`, `bounced`) | `mta` (`weldsuite_mta::monitoring`) |
//!
//! `route` is the route's template (axum's `MatchedPath`, e.g.
//! `/api/crm/contacts/{id}`), never the path a client sent: `static` for the
//! SPA's files and pages, `unmatched` for a request no route took. `pool` is
//! `master`, `tenant` (every workspace's pool summed), `personal` or `mta`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::Router;
use axum::extract::{MatchedPath, Request, State};
use axum::http::{Method, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use weldsuite_db::{PgPool, PoolUsage, Workspaces};

/// The setting naming the listener.
pub(crate) const METRICS_ADDR: &str = "METRICS_ADDR";

/// Where `/metrics` listens unless `METRICS_ADDR` says otherwise.
pub(crate) const DEFAULT_ADDR: SocketAddr =
    SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 9464);

pub(crate) const HTTP_REQUESTS: &str = "weldsuite_http_requests_total";
pub(crate) const HTTP_DURATION: &str = "weldsuite_http_request_duration_seconds";
pub(crate) const HTTP_IN_FLIGHT: &str = "weldsuite_http_requests_in_flight";
pub(crate) const DB_POOL_CONNECTIONS: &str = "weldsuite_db_pool_connections";
pub(crate) const DB_POOL_MAX: &str = "weldsuite_db_pool_max_connections";

/// Request durations, in seconds.
const HTTP_BUCKETS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

/// Job run durations, in seconds: a job runs for a moment or for many
/// minutes (an import, a payroll run).
const JOB_BUCKETS: [f64; 12] = [
    0.1, 0.5, 1.0, 5.0, 15.0, 30.0, 60.0, 120.0, 300.0, 600.0, 1800.0, 3600.0,
];

/// How often the pools are sampled.
const POOL_SAMPLE_INTERVAL: Duration = Duration::from_secs(15);

/// How often the recorder drains its histograms between scrapes.
const UPKEEP_INTERVAL: Duration = Duration::from_secs(5);

/// The text format's content type.
const TEXT_FORMAT: &str = "text/plain; version=0.0.4; charset=utf-8";

/// `METRICS_ADDR`: unset is [`DEFAULT_ADDR`], `off` or empty turns the
/// listener off, anything else must be `host:port`. `value` is the raw
/// variable: an empty one is not "unset".
pub(crate) fn listen_addr(value: Option<&str>, problems: &mut Vec<String>) -> Option<SocketAddr> {
    let Some(value) = value.map(str::trim) else {
        return Some(DEFAULT_ADDR);
    };
    if value.is_empty() || value.eq_ignore_ascii_case("off") {
        return None;
    }
    let addr = value.parse().ok();
    if addr.is_none() {
        problems.push(format!(
            "{METRICS_ADDR} must be host:port (e.g. 0.0.0.0:9464), or off"
        ));
    }
    addr
}

/// [`listen_addr`] from the environment, for the roles whose settings are
/// not read through `Config` (the MTA).
pub(crate) fn listen_addr_from_env() -> Result<Option<SocketAddr>, String> {
    let mut problems = Vec::new();
    let addr = listen_addr(std::env::var(METRICS_ADDR).ok().as_deref(), &mut problems);
    match problems.pop() {
        Some(problem) => Err(problem),
        None => Ok(addr),
    }
}

/// The recorder's settings: histograms with the buckets above, rendered as
/// Prometheus histograms (any other histogram is a summary).
pub(crate) fn builder() -> PrometheusBuilder {
    let buckets = |builder: PrometheusBuilder, name: &str, values: &[f64]| {
        builder
            .set_buckets_for_metric(Matcher::Full(name.to_owned()), values)
            .expect("the bucket lists are not empty")
    };
    let builder = buckets(PrometheusBuilder::new(), HTTP_DURATION, &HTTP_BUCKETS);
    buckets(builder, weldsuite_ports::JOB_DURATION_METRIC, &JOB_BUCKETS)
}

/// Set once [`start`] installed the recorder.
static RECORDING: AtomicBool = AtomicBool::new(false);

/// Install the process's recorder and serve `GET /metrics` on `addr`, both
/// for as long as the process runs. Call it first, before anything records:
/// a metric handle taken earlier records nowhere. `None` (off) installs
/// nothing, and every metric is a no-op.
///
/// A listener that cannot bind is logged, not fatal: the role runs without
/// metrics (its scrape target is down, which alerts) rather than not at
/// all.
pub(crate) async fn start(addr: Option<SocketAddr>) {
    let Some(addr) = addr else {
        tracing::info!("metrics: off ({METRICS_ADDR}=off)");
        return;
    };
    let handle = match builder().install_recorder() {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!(%error, "metrics: cannot install the recorder; no metrics");
            return;
        }
    };
    RECORDING.store(true, Ordering::Relaxed);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, %addr, "metrics: cannot listen; no /metrics");
            return;
        }
    };
    tracing::info!(%addr, "metrics: serving /metrics");
    let upkeep = handle.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(UPKEEP_INTERVAL);
        loop {
            ticker.tick().await;
            upkeep.run_upkeep();
        }
    });
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router(handle)).await {
            tracing::error!(%error, "metrics: the listener stopped");
        }
    });
}

/// The metrics listener's routes: `/metrics` and nothing else.
pub(crate) fn router(handle: PrometheusHandle) -> Router {
    Router::new()
        .route("/metrics", get(render))
        .with_state(handle)
}

async fn render(State(handle): State<PrometheusHandle>) -> Response {
    ([(header::CONTENT_TYPE, TEXT_FORMAT)], handle.render()).into_response()
}

/// Put on a response the SPA served (a file of the build, `index.html` or a
/// `404.html`), so it counts as `route="static"`: the SPA is the fallback,
/// which has no route template.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StaticRoute;

/// Count every request `app` answers: [`HTTP_REQUESTS`], [`HTTP_DURATION`]
/// and [`HTTP_IN_FLIGHT`]. Layered on the finished router (SPA and realtime
/// gateway included): a router layer runs after routing, so the route's
/// template is known.
pub(crate) fn track_http(app: Router) -> Router {
    app.layer(axum::middleware::from_fn(record_request))
}

async fn record_request(request: Request, next: Next) -> Response {
    let method = method_label(request.method());
    let template = request
        .extensions()
        .get::<MatchedPath>()
        .map(|path| path.as_str().to_owned());
    let started = Instant::now();
    let response = {
        let _in_flight = InFlight::enter();
        next.run(request).await
    };
    let elapsed = started.elapsed().as_secs_f64();
    let route: metrics::SharedString = match template {
        Some(template) => template.into(),
        None if response.extensions().get::<StaticRoute>().is_some() => "static".into(),
        None => "unmatched".into(),
    };
    let status = response.status().as_u16().to_string();
    metrics::counter!(
        HTTP_REQUESTS,
        "method" => method,
        "route" => route.clone(),
        "status" => status
    )
    .increment(1);
    metrics::histogram!(HTTP_DURATION, "method" => method, "route" => route).record(elapsed);
    response
}

/// The standard methods by name, anything else `OTHER`: a client can send
/// any token as a method.
fn method_label(method: &Method) -> &'static str {
    match method.as_str() {
        "GET" => "GET",
        "HEAD" => "HEAD",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

/// One request in [`HTTP_IN_FLIGHT`], until dropped (a cancelled request
/// too).
struct InFlight(metrics::Gauge);

impl InFlight {
    fn enter() -> Self {
        let gauge = metrics::gauge!(HTTP_IN_FLIGHT);
        gauge.increment(1.0);
        Self(gauge)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.decrement(1.0);
    }
}

/// Pools beside the workspaces' that this process holds, by their `pool`
/// label ([`watch_pool`]).
static WATCHED: Mutex<Vec<(&'static str, PgPool)>> = Mutex::new(Vec::new());

/// Sample `pool` with the others, as `pool="<name>"`; a second pool under
/// the same name replaces the first.
pub(crate) fn watch_pool(name: &'static str, pool: &PgPool) {
    let mut watched = WATCHED.lock().unwrap_or_else(PoisonError::into_inner);
    watched.retain(|(known, _)| *known != name);
    watched.push((name, pool.clone()));
}

/// With metrics on ([`start`]): record the pools now and every 15 s after,
/// in a task, while the process runs: `master`, `tenant` (every open tenant
/// pool summed) and the watched ones.
pub(crate) fn sample_pools(workspaces: &Arc<Workspaces>) {
    if !RECORDING.load(Ordering::Relaxed) {
        return;
    }
    let workspaces = Arc::clone(workspaces);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(POOL_SAMPLE_INTERVAL);
        loop {
            ticker.tick().await;
            record_pools(&workspaces);
        }
    });
}

fn record_pools(workspaces: &Workspaces) {
    let usage = workspaces.pool_usage();
    record_pool("master", usage.master);
    record_pool("tenant", usage.tenants);
    let watched = WATCHED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    for (name, pool) in watched {
        record_pool(name, PoolUsage::of(&pool));
    }
}

fn record_pool(name: &'static str, usage: PoolUsage) {
    metrics::gauge!(DB_POOL_CONNECTIONS, "pool" => name, "state" => "idle")
        .set(f64::from(usage.idle));
    metrics::gauge!(DB_POOL_CONNECTIONS, "pool" => name, "state" => "in_use")
        .set(f64::from(usage.in_use));
    metrics::gauge!(DB_POOL_MAX, "pool" => name).set(f64::from(usage.max));
}

#[cfg(test)]
pub(crate) mod tests {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use weldsuite_db::{Keyring, WorkspaceConfig};

    use super::*;

    fn get_request(path: &str) -> Request {
        axum::http::Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("request")
    }

    #[test]
    fn the_address_defaults_and_turns_off() {
        let mut problems = Vec::new();
        assert_eq!(listen_addr(None, &mut problems), Some(DEFAULT_ADDR));
        assert_eq!(DEFAULT_ADDR.to_string(), "0.0.0.0:9464");
        for off in ["off", "OFF", "", "  "] {
            assert_eq!(listen_addr(Some(off), &mut problems), None, "{off:?}");
        }
        assert_eq!(
            listen_addr(Some("10.0.0.7:9100"), &mut problems).map(|a| a.to_string()),
            Some("10.0.0.7:9100".to_owned())
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(listen_addr(Some("9464"), &mut problems), None);
        assert_eq!(problems.len(), 1, "{problems:?}");
    }

    /// The names the MTA crate records under are the binary's.
    #[test]
    fn the_mta_records_the_same_pool_metrics() {
        assert_eq!(
            weldsuite_mta::monitoring::DB_POOL_CONNECTIONS_METRIC,
            DB_POOL_CONNECTIONS
        );
        assert_eq!(weldsuite_mta::monitoring::DB_POOL_MAX_METRIC, DB_POOL_MAX);
    }

    /// A recorder of this process's own (the global one can be installed
    /// once), current on this thread while the guard lives: a
    /// `#[tokio::test]` runs every task on the test's thread.
    pub(crate) struct LocalMetrics {
        recorder: metrics_exporter_prometheus::PrometheusRecorder,
    }

    impl LocalMetrics {
        pub(crate) fn new() -> Self {
            Self {
                recorder: builder().build_recorder(),
            }
        }

        pub(crate) fn guard(&self) -> metrics::LocalRecorderGuard<'_> {
            metrics::set_default_local_recorder(&self.recorder)
        }

        pub(crate) fn render(&self) -> String {
            self.recorder.handle().render()
        }
    }

    #[tokio::test]
    async fn metrics_listener_serves_the_text_format_at_metrics_only() {
        let local = LocalMetrics::new();
        let _guard = local.guard();
        metrics::counter!(HTTP_REQUESTS, "method" => "GET", "route" => "/livez", "status" => "200")
            .increment(1);
        let app = router(local.recorder.handle());

        let response = app
            .clone()
            .oneshot(get_request("/metrics"))
            .await
            .expect("response");
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_TYPE], TEXT_FORMAT);
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let body = String::from_utf8_lossy(&body);
        assert!(
            body.contains(
                r#"weldsuite_http_requests_total{method="GET",route="/livez",status="200"} 1"#
            ),
            "{body}"
        );

        let response = app.oneshot(get_request("/health")).await.expect("response");
        assert_eq!(response.status(), 404);
    }

    #[tokio::test]
    async fn histograms_have_the_dashboards_buckets() {
        let local = LocalMetrics::new();
        let _guard = local.guard();
        metrics::histogram!(HTTP_DURATION, "method" => "GET", "route" => "/livez").record(0.003);
        weldsuite_ports::record_job_run("sign.finalize", false, Duration::from_secs(42));
        let text = local.render();
        assert!(
            text.contains("# TYPE weldsuite_http_request_duration_seconds histogram"),
            "{text}"
        );
        for bound in [
            "0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "+Inf",
        ] {
            assert!(
                text.contains(&format!(
                    r#"weldsuite_http_request_duration_seconds_bucket{{method="GET",route="/livez",le="{bound}"}} 1"#
                )),
                "le={bound}: {text}"
            );
        }
        assert!(
            text.contains("# TYPE weldsuite_job_duration_seconds histogram"),
            "{text}"
        );
        assert!(
            text.contains(r#"weldsuite_job_runs_total{job="sign.finalize",outcome="error"} 1"#),
            "{text}"
        );
    }

    #[tokio::test]
    async fn requests_count_by_route_template_and_status() {
        let local = LocalMetrics::new();
        let _guard = local.guard();
        let app = track_http(
            Router::new()
                .route("/items/{id}", get(|| async { "item" }))
                .nest(
                    "/api",
                    Router::new().route("/things/{id}", axum::routing::post(|| async { "made" })),
                ),
        );
        for (method, uri) in [
            ("GET", "/items/42?token=secret123"),
            ("GET", "/items/43"),
            ("POST", "/api/things/7"),
            ("GET", "/nothing/here"),
            ("BREW", "/items/44"),
        ] {
            let request = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("request");
            app.clone().oneshot(request).await.expect("response");
        }
        let text = local.render();
        for line in [
            r#"weldsuite_http_requests_total{method="GET",route="/items/{id}",status="200"} 2"#,
            r#"weldsuite_http_requests_total{method="POST",route="/api/things/{id}",status="200"} 1"#,
            r#"weldsuite_http_requests_total{method="GET",route="unmatched",status="404"} 1"#,
            r#"weldsuite_http_requests_total{method="OTHER",route="/items/{id}",status="405"} 1"#,
            r#"weldsuite_http_request_duration_seconds_count{method="GET",route="/items/{id}"} 2"#,
            "weldsuite_http_requests_in_flight 0",
        ] {
            assert!(text.contains(line), "{line}\n{text}");
        }
        for raw in ["/items/42", "/items/43", "secret123", "/nothing/here"] {
            assert!(!text.contains(raw), "{raw} leaked into a label: {text}");
        }
    }

    #[tokio::test]
    async fn pools_are_sampled_by_kind_not_by_workspace() {
        let local = LocalMetrics::new();
        let _guard = local.guard();
        let master = weldsuite_db::master_pool("postgres://weldsuite:x@127.0.0.1:1/master", 10)
            .expect("lazy pool");
        let personal = weldsuite_db::master_pool("postgres://weldsuite:x@127.0.0.1:1/personal", 5)
            .expect("lazy pool");
        watch_pool("personal", &personal);
        record_pools(&Workspaces::new(
            master,
            Keyring::default(),
            WorkspaceConfig::default(),
        ));
        let text = local.render();
        for line in [
            r#"weldsuite_db_pool_connections{pool="master",state="idle"} 0"#,
            r#"weldsuite_db_pool_connections{pool="master",state="in_use"} 0"#,
            r#"weldsuite_db_pool_max_connections{pool="master"} 10"#,
            r#"weldsuite_db_pool_max_connections{pool="tenant"} 0"#,
            r#"weldsuite_db_pool_max_connections{pool="personal"} 5"#,
        ] {
            assert!(text.contains(line), "{line}\n{text}");
        }
    }
}
