//! The `weldsuite` binary. One image runs every role through a subcommand:
//! `serve` today; `consume`, `cron <job>` and the admin commands as they are
//! ported.
//!
//! Configuration is environment variables only (`config.rs`); the Helm chart
//! in `rust/deploy/helm/weldsuite` sets them.

mod config;
#[cfg(feature = "conformance")]
mod conformance;
mod server;

use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tracing_subscriber::EnvFilter;
use weldsuite_auth::ClerkVerifier;
use weldsuite_db::{Workspaces, master_pool};

use crate::config::{ClerkKey, Config, LogFormat};
use crate::server::{AppState, router, shutdown_signal};

const USAGE: &str = "\
usage: weldsuite <command>

commands:
  serve      run the HTTP API (configured by environment variables)
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

fn init_logging(format: LogFormat) {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let builder = tracing_subscriber::fmt().with_env_filter(filter);
    match format {
        LogFormat::Json => builder.json().flatten_event(true).init(),
        LogFormat::Text => builder.init(),
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
    init_logging(config.log_format);

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
    match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "server stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let verifier = match &config.clerk_key {
        ClerkKey::Pem(pem) => ClerkVerifier::from_pem(pem, config.authorized_parties.as_deref())?,
        ClerkKey::Jwks(jwks) => {
            ClerkVerifier::from_jwks(jwks, config.authorized_parties.as_deref())?
        }
    };

    // Lazy: the pod starts and reports not-ready until the database answers,
    // instead of crash-looping while it comes up.
    let master = master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Workspaces::new(master, config.keyring.clone(), config.workspaces.clone());

    let draining = Arc::new(AtomicBool::new(false));
    let state = AppState {
        service: "weldsuite",
        environment: config.environment.clone(),
        workspaces: Arc::new(workspaces),
        verifier: Arc::new(verifier),
        permissions_app_enforce: config.permissions_app_enforce,
        draining: Arc::clone(&draining),
    };

    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(listen = %config.listen, version = env!("CARGO_PKG_VERSION"), "serving");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal(draining, config.shutdown_delay))
        .await?;
    tracing::info!("stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn version_names_the_binary_and_crate_version() {
        assert!(version().starts_with(&format!("weldsuite {}", env!("CARGO_PKG_VERSION"))));
    }
}
