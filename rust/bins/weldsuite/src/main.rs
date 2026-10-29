//! The `weldsuite` binary. One image runs every role through a subcommand:
//! `serve` today; `consume`, `cron <job>` and the admin commands as they are
//! ported.
//!
//! Configuration is environment variables only (`config.rs`); the Helm chart
//! in `rust/deploy/helm/weldsuite` sets them.

mod config;
#[cfg(feature = "conformance")]
mod conformance;
#[cfg(feature = "conformance")]
mod conformance_files;
#[cfg(feature = "conformance")]
mod conformance_outbound;
#[cfg(feature = "conformance")]
mod conformance_portal;
mod cron;
mod infra;
mod routes;
mod server;
mod telemetry;

use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use weldsuite_auth::{ClerkVerifier, SessionVerifier};
use weldsuite_db::{Workspaces, master_pool};

use crate::config::{AuthConfig, ClerkKey, Config};
use crate::server::{AppState, router, shutdown_signal};

const USAGE: &str = "\
usage: weldsuite <command>

commands:
  serve      run the HTTP API (configured by environment variables)
  cron <job> run one scheduled job and exit: sign-lifecycle
  version    print the version and exit
  help       print this message and exit";

/// `weldsuite 0.0.0`, with ` (conformance)` on a test build; CI checks
/// that the release image's version has no suffix.
fn version() -> String {
    let suffix = if cfg!(feature = "conformance") {
        " (conformance)"
    } else {
        ""
    };
    format!("weldsuite {}{suffix}", env!("CARGO_PKG_VERSION"))
}

fn main() -> ExitCode {
    let command = std::env::args().nth(1);
    match command.as_deref() {
        Some("serve") => serve(),
        Some("cron") => cron::main(std::env::args().nth(2).as_deref()),
        Some("version" | "--version" | "-V") => {
            println!("{}", version());
            ExitCode::SUCCESS
        }
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn serve() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78); // EX_CONFIG
        }
    };
    let telemetry = telemetry::init(config.log_format);

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "cannot start the async runtime");
            return ExitCode::FAILURE;
        }
    };
    let code = match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "server stopped");
            ExitCode::FAILURE
        }
    };
    telemetry.shutdown();
    code
}

async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let (verifier, public_auth) = session_verifier(&config.auth)?;
    tracing::info!(provider = verifier.provider(), "sign-in");

    // Lazy: the pod starts and reports not-ready until the database answers,
    // instead of crash-looping while it comes up.
    let master = master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Workspaces::new(master, config.keyring.clone(), config.workspaces.clone());

    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra = infra::connect(&config.infra, workspaces.master(), tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, recorders) = conformance::infra(tracker.clone());
    let flags = Arc::new(weldsuite_pipeline::FlagGate::new(
        Arc::clone(&infra.flags),
        config.environment.clone(),
        config.infra.test_fixtures_token.clone(),
    ));

    let draining = Arc::new(AtomicBool::new(false));
    let state = AppState {
        service: "weldsuite",
        environment: config.environment.clone(),
        workspaces: Arc::new(workspaces),
        verifier: Arc::new(verifier),
        permissions_app_enforce: config.permissions_app_enforce,
        draining: Arc::clone(&draining),
        infra,
        permissions: AppState::permission_gate(config.permissions_app_enforce),
        flags,
        sign_session_secret: config.sign_session_secret.as_deref().map(Arc::from),
        sign_portal_url: config.sign_portal_url.as_deref().map(Arc::from),
        sign_portal_secret: config.sign_portal_secret.as_deref().map(Arc::from),
        files_public_url: config.files_public_url.as_deref().map(Arc::from),
        public_auth,
        #[cfg(feature = "conformance")]
        recorders,
        #[cfg(feature = "conformance")]
        conformance_pools: Arc::default(),
    };

    let (stopping, stop) = tokio::sync::watch::channel(false);
    let jobs = serve_jobs(&config, &state, stop);

    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(listen = %config.listen, version = env!("CARGO_PKG_VERSION"), "serving");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async move {
            shutdown_signal(draining, config.shutdown_delay).await;
            let _ = stopping.send(true);
        })
        .await?;
    if let Some(jobs) = jobs {
        let _ = jobs.await;
    }
    // Let fire-and-forget publishes finish before the process exits.
    tracker.close();
    if tokio::time::timeout(std::time::Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    tracing::info!("stopped");
    Ok(())
}

/// The session verifier for the configured provider, and what `/config.json`
/// tells the frontends about sign-in (nothing for Clerk, whose frontends
/// carry their own key).
fn session_verifier(
    auth: &AuthConfig,
) -> Result<(SessionVerifier, Option<Arc<serde_json::Value>>), weldsuite_auth::KeyError> {
    match auth {
        AuthConfig::Clerk {
            key,
            authorized_parties,
        } => {
            let parties = authorized_parties.clone();
            let verifier = match key {
                ClerkKey::Pem(pem) => ClerkVerifier::from_pem(pem, parties.as_deref())?.into(),
                ClerkKey::Jwks(jwks) => ClerkVerifier::from_jwks(jwks, parties.as_deref())?.into(),
                ClerkKey::JwksUrl(url) => SessionVerifier::remote(url.clone(), None, parties)?,
                ClerkKey::SecretKey(secret) => {
                    SessionVerifier::clerk_backend_api(secret.clone(), parties)?
                }
            };
            Ok((verifier, None))
        }
        AuthConfig::Oidc {
            settings,
            web_client_id,
        } => {
            let public = serde_json::json!({
                "provider": "oidc",
                "issuer": settings.issuer,
                "clientId": web_client_id,
                "audience": settings.audiences.first(),
                "orgClaim": settings.org_claim,
            });
            Ok((
                SessionVerifier::oidc(settings.clone())?,
                Some(Arc::new(public)),
            ))
        }
    }
}

/// With Restate configured: serve the jobs service on `JOBS_PORT` until
/// `stop` turns true, and register it with the admin API in the background.
fn serve_jobs(
    config: &Config,
    state: &AppState,
    mut stop: tokio::sync::watch::Receiver<bool>,
) -> Option<tokio::task::JoinHandle<()>> {
    let jobs = &config.infra.jobs;
    jobs.restate_ingress_url.as_ref()?;
    let registry = state.infra.job_registry.clone();
    let address = std::net::SocketAddr::new(config.listen.ip(), jobs.port);
    if let (Some(admin), Some(uri)) = (
        jobs.restate_admin_url.clone(),
        jobs.restate_deployment_uri.clone(),
    ) {
        tokio::spawn(async move {
            let client = reqwest::Client::new();
            let wait = std::time::Duration::from_secs(300);
            if let Err(error) =
                weldsuite_adapters_oss::register_deployment(&client, &admin, &uri, wait).await
            {
                tracing::error!(%error, "jobs: not registered with restate; jobs will not run");
            }
        });
    }
    Some(tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(%error, %address, "jobs: cannot listen for restate");
                return;
            }
        };
        tracing::info!(%address, jobs = ?registry.names(), "jobs: serving the restate endpoint");
        weldsuite_adapters_oss::serve_endpoint(registry, listener, async move {
            let _ = stop.wait_for(|stopping| *stopping).await;
        })
        .await;
    }))
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn version_names_the_binary_and_crate_version() {
        assert!(version().starts_with(&format!("weldsuite {}", env!("CARGO_PKG_VERSION"))));
    }
}
