//! The `weldsuite` binary. One image runs every role through a subcommand:
//! `serve`, `consume`, `cron <job>`, `migrate`, `mta` (ADR MAIL-011) and `admin` (staff work, ADR
//! SEC-014); the other operator commands as they are ported.
//!
//! Configuration is environment variables only (`config.rs`); the Helm chart
//! in `rust/deploy/helm/weldsuite` sets them.

mod admin;
mod admin_billing;
mod ai;
mod billing;
mod collab;
mod config;
#[cfg(feature = "conformance")]
mod conformance;
#[cfg(feature = "conformance")]
mod conformance_books;
#[cfg(feature = "conformance")]
mod conformance_files;
#[cfg(feature = "conformance")]
mod conformance_forms;
#[cfg(feature = "conformance")]
mod conformance_kv;
#[cfg(feature = "conformance")]
mod conformance_mail;
#[cfg(feature = "conformance")]
mod conformance_outbound;
#[cfg(feature = "conformance")]
mod conformance_panel;
#[cfg(feature = "conformance")]
mod conformance_portal;
#[cfg(feature = "conformance")]
mod conformance_workflows;
mod consume;
mod cron;
mod desk_http;
mod doctor;
mod edition;
mod infra;
mod migrate;
mod monitoring;
mod mta;
mod reach;
mod realtime;
mod routes;
mod sandbox;
mod server;
mod spa;
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
  consume    run the entity-event subscribers on NATS JetStream
  cron <job> run one scheduled job and exit: sign-lifecycle, identity-sync,
             workspace-deletion, workspace-teardown, mail-outbound-ledgers,
             calendar-replan, flow-file-purge, flow-approval-due, flow-benefit-measure,
             flow-status-reports, flow-finance-snapshot, books-sweep, domain-auto-renew,
             desk-sla-sweep, desk-report-sweep,
             reach-send-sweep, reach-warmup-sweep, reach-slot-reconciliation,
             reach-warmup-dispatch, reach-warmup-plan, reach-warmup-daily, bank-feed-due,
             crm-due, ad-sync, workflow-polls, workflow-schedules, connector-catchup,
             moneybird-push, merge-digest-sweep, forms-reminders, forms-digest,
             sandbox-cleanup, billing-renewals
  migrate    apply the database migrations to the master and every tenant
             database (weldsuite migrate --help)
  mta        WeldSuite's own MTA on the mail nodes, and its domain and queue
             tools (weldsuite mta --help)
  admin      staff work: access to apps on request only (WeldReach) and the
             staff list (weldsuite admin --help)
  doctor     check the configuration and what it points at: the master
             database, the AI providers' keys and models (weldsuite doctor --help)
  version   print the version and exit
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => serve(),
        Some("consume") => consume::run(),
        Some("cron") => cron::main(args.get(1).map(String::as_str)),
        Some("migrate") => migrate::run(&args[1..]),
        Some("admin") => admin::run(&args[1..]),
        Some("mta") => mta::run(&args[1..]),
        Some("doctor") => doctor::run(&args[1..]),
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
    let telemetry = telemetry::init(config.log_format, "info");
    // An EU or self-hosted install should have none of these.
    for line in &config.global_defaults {
        tracing::warn!("Global default: {line}");
    }

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
    // First: a metric handle taken before the recorder exists records
    // nowhere. Its listener keeps running on the runtime's workers.
    runtime.block_on(monitoring::start(config.metrics_addr));
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

#[allow(
    clippy::too_many_lines,
    reason = "the start-up sequence, one service after the other"
)]
async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let (verifier, public_auth) = session_verifier(&config.auth)?;
    tracing::info!(provider = verifier.provider(), "sign-in");

    // Lazy: the pod starts and reports not-ready until the database answers,
    // instead of crash-looping while it comes up.
    let master = master_pool(&config.master_database_url, config.master_max_connections)?;
    let workspaces = Workspaces::new(master, config.keyring.clone(), config.workspaces.clone());

    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra = infra::connect(
        &config.infra,
        workspaces.master(),
        &config.keyring,
        tracker.clone(),
    )
    .await?;
    #[cfg(feature = "conformance")]
    let (infra, recorders) = conformance::infra(tracker.clone());
    let flags = Arc::new(weldsuite_pipeline::FlagGate::new(
        Arc::clone(&infra.flags),
        config.environment.clone(),
        config.infra.test_fixtures_token.clone(),
    ));

    let spa = config
        .spa_dir
        .as_deref()
        .map(spa::Spa::load)
        .transpose()?
        .map(Arc::new);
    if let Some(spa) = &spa {
        tracing::info!(dir = %spa.root().display(), "serving the SPA");
    }

    let sign_in = sign_in_screens(&config, infra.cache.clone(), infra.mail.clone())?;
    let ai = ai::for_app(&config.ai, infra.cache.clone())?;
    let sandboxes = sandbox::build(config.sandbox.as_ref())?;

    let draining = Arc::new(AtomicBool::new(false));
    let state = AppState {
        service: "weldsuite",
        environment: config.environment.clone(),
        edition: Arc::new(config.edition.clone()),
        workspaces: Arc::new(workspaces),
        verifier: Arc::new(verifier),
        permissions_app_enforce: config.permissions_app_enforce,
        draining: Arc::clone(&draining),
        infra,
        permissions: AppState::permission_gate(config.permissions_app_enforce),
        flags,
        sign_session_secret: config.sign_session_secret.as_deref().map(Arc::from),
        sign_portal_url: config.sign_portal_url.as_deref().map(Arc::from),
        public_app_url: config.public_app_url.as_deref().map(Arc::from),
        project_portal_url: config.project_portal_url.as_deref().map(Arc::from),
        sign_portal_secret: config.sign_portal_secret.as_deref().map(Arc::from),
        collab: (!config.collab_rooms_urls.is_empty()).then(|| {
            Arc::new(weldsuite_adapters_oss::collab::HttpCollabRooms::new(
                config.collab_rooms_urls.clone(),
                config.collab_rooms_secret.clone(),
            ))
        }),
        collab_secret: config.collab_rooms_secret.as_deref().map(Arc::from),
        mail_inbound_secret: config.mail_inbound_secret.as_deref().map(Arc::from),
        files_public_url: config.files_public_url.as_deref().map(Arc::from),
        files_public_via_server: config.files_public_via_server,
        widget_token_secret: config
            .realtime
            .widget_token_secret
            .as_deref()
            .map(Arc::from),
        trusted_proxies: config.trusted_proxies,
        storage_signing_key: config.storage_signing_key.as_deref().map(Arc::from),
        public_auth,
        sign_in,
        realtime: realtime::PublicRealtime::from_config(&config),
        ai,
        sandboxes,
        #[cfg(feature = "conformance")]
        recorders,
        #[cfg(feature = "conformance")]
        conformance_pools: Arc::default(),
    };

    monitoring::sample_pools(&state.workspaces);
    let (stopping, stop) = tokio::sync::watch::channel(false);
    let jobs = serve_jobs(&config, &state, stop);
    let gateway = realtime::start(&config, &state).await?;
    let app = realtime::mount(router(state), gateway.as_ref());

    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    tracing::info!(listen = %config.listen, version = env!("CARGO_PKG_VERSION"), "serving");
    axum::serve(listener, monitoring::track_http(spa::mount(app, spa)))
        .with_graceful_shutdown(async move {
            shutdown_signal(draining, config.shutdown_delay).await;
            realtime::stop(gateway.as_ref()).await;
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
            mobile_client_id,
            platform_sign_in,
        } => {
            let mut public = serde_json::json!({
                "provider": "oidc",
                "issuer": settings.issuer,
                "clientId": web_client_id,
                // The mobile apps' native client (weldsuite-documentation/plans/mobile-server-choice.md).
                "mobileClientId": mobile_client_id,
                "audience": settings.audiences.first(),
                "orgClaim": settings.org_claim,
            });
            if *platform_sign_in {
                // The platform shows its own sign-in screens (ADR SEC-016).
                public["signIn"] = serde_json::json!("platform");
            }
            Ok((
                SessionVerifier::oidc(settings.clone())?,
                Some(Arc::new(public)),
            ))
        }
    }
}

/// The sign-in screens' backend, with `OIDC_SIGN_IN=platform` (ADR SEC-016):
/// this server as Zitadel's login client. Its token is `ZITADEL_LOGIN_TOKEN`
/// (a service user with only `IAM_LOGIN_CLIENT`), else the service token,
/// whose user then needs that role too: without it Zitadel lets a session
/// be opened but not a sign-in finished.
fn sign_in_screens(
    config: &Config,
    cache: Option<Arc<dyn weldsuite_ports::DynCache>>,
    mail: Option<Arc<dyn weldsuite_ports::DynSystemMail>>,
) -> Result<Option<weldsuite_core_signin::SignInState>, Box<dyn std::error::Error>> {
    let AuthConfig::Oidc {
        settings,
        platform_sign_in: true,
        ..
    } = &config.auth
    else {
        return Ok(None);
    };
    // The configuration refuses `platform` without the provider's API.
    let Some(identity) = &config.infra.identity else {
        return Ok(None);
    };
    let provider =
        weldsuite_adapters_oss::ZitadelSignIn::new(weldsuite_adapters_oss::ZitadelSignInOptions {
            api_url: identity.api_url.clone(),
            token: identity
                .login_token
                .clone()
                .unwrap_or_else(|| identity.token.clone()),
            host: identity.host.clone(),
            // Its own login pages, for what the platform's screens hand back.
            public_url: Some(settings.issuer.clone()),
        })?;
    let cache = cache.unwrap_or_else(|| {
        tracing::warn!("VALKEY_URL is not set: sign-in attempts are counted in this process only");
        Arc::new(weldsuite_ports::MemoryCache::new())
    });
    if config.platform_url.is_none() {
        tracing::warn!(
            "PLATFORM_URL is not set: the provider sends the sign-in emails, its links opening its own pages"
        );
    } else if mail.is_none() {
        tracing::warn!("SMTP_URL is not set: the provider sends the sign-in emails");
    }
    tracing::info!("sign-in screens: the platform's own, on the provider's login API");
    Ok(Some(
        weldsuite_core_signin::SignInState::new(
            Arc::new(provider),
            cache,
            config.platform_url.as_deref(),
            config.trusted_proxies,
        )
        .with_mail(mail),
    ))
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
