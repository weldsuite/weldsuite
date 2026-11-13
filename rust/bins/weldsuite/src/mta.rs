//! `weldsuite mta`: WeldSuite's own MTA on the mail nodes (ADR MAIL-011,
//! `crates/mta`), and its operator commands.

use std::process::ExitCode;

use tokio_util::sync::CancellationToken;
use weldsuite_mta::config::{BaseConfig, Config};
use weldsuite_mta::domains::{self, DomainView};
use weldsuite_mta::store::Store;

use crate::config::LogFormat;

const USAGE: &str = "\
usage: weldsuite mta [command]

commands:
  run                               run the MTA (the default): submission, the bounce MX,
                                    the API and delivery for MTA_POOLS
  migrate                           apply the MTA database migrations and exit
  domains list                      the registered sending domains
  domains show <domain>             one domain and its DKIM record
  domains add <domain> [--pool P]…  register a domain (idempotent), print its DKIM record
  domains remove <domain>           stop signing for a domain
  queue                             recipients by pool and status

Settings are environment variables (docs/plans/eu-mail-service.md).";

fn log_format() -> LogFormat {
    match std::env::var("LOG_FORMAT").as_deref() {
        Ok("text") => LogFormat::Text,
        _ => LogFormat::Json,
    }
}

fn runtime() -> Option<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .inspect_err(|error| eprintln!("cannot start the async runtime: {error}"))
        .ok()
}

pub(crate) fn run(args: &[String]) -> ExitCode {
    match args.first().map(String::as_str) {
        None | Some("run") => serve(),
        Some("migrate" | "domains" | "queue") => tool(args),
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(_) => {
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
    // `METRICS_ADDR`, as for `serve`: the chart sets the node's private
    // address, since the MTA runs on the host network.
    let metrics_addr = match crate::monitoring::listen_addr_from_env() {
        Ok(addr) => addr,
        Err(error) => {
            eprintln!("invalid configuration: {error}");
            return ExitCode::from(78);
        }
    };
    let telemetry = crate::telemetry::init(log_format(), "info");
    let Some(runtime) = runtime() else {
        return ExitCode::FAILURE;
    };
    let code = runtime.block_on(async {
        crate::monitoring::start(metrics_addr).await;
        let shutdown = CancellationToken::new();
        let signal = shutdown.clone();
        tokio::spawn(async move {
            terminated().await;
            tracing::info!("shutdown signal received");
            signal.cancel();
        });
        match weldsuite_mta::run::run(config, shutdown).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                tracing::error!(%error, "the MTA stopped");
                ExitCode::FAILURE
            }
        }
    });
    telemetry.shutdown();
    code
}

/// SIGTERM (Kubernetes) or Ctrl-C.
async fn terminated() {
    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}

fn print_domain(view: &DomainView) {
    println!(
        "{}  selector {}  pools {}",
        view.domain,
        view.selector,
        if view.pools.is_empty() {
            "any".to_owned()
        } else {
            view.pools.join(",")
        }
    );
    println!("  publish: {} TXT \"{}\"", view.dkim.name, view.dkim.value);
}

fn tool(args: &[String]) -> ExitCode {
    let base = match BaseConfig::from_lookup(&|name| std::env::var(name).ok()) {
        Ok(base) => base,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(78);
        }
    };
    let Some(runtime) = runtime() else {
        return ExitCode::FAILURE;
    };
    runtime.block_on(async move {
        let store = match Store::connect(&base.database_url, 2) {
            Ok(store) => store,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        };
        match tool_command(&store, &base, args).await {
            Ok(code) => code,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::FAILURE
            }
        }
    })
}

async fn tool_command(
    store: &Store,
    base: &BaseConfig,
    args: &[String],
) -> Result<ExitCode, Box<dyn std::error::Error>> {
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    match (args[0].as_str(), rest.as_slice()) {
        ("migrate", []) => {
            let ran = store.migrate().await?;
            println!("{ran} migration(s) applied");
        }
        ("queue", []) => {
            store.migrate().await?;
            println!("{}", serde_json::to_string_pretty(&store.stats().await?)?);
        }
        ("domains", ["list"]) => {
            for row in store.domains().await? {
                print_domain(&DomainView::from(&row));
            }
        }
        ("domains", ["show", domain]) => {
            let Some(row) = store.domain(domain).await? else {
                eprintln!("{domain} is not registered");
                return Ok(ExitCode::FAILURE);
            };
            print_domain(&DomainView::from(&row));
        }
        ("domains", ["add", domain, flags @ ..]) => {
            let mut pools = Vec::new();
            let mut flags = flags.iter();
            while let Some(flag) = flags.next() {
                let ("--pool", Some(pool)) = (*flag, flags.next()) else {
                    eprintln!("{USAGE}");
                    return Ok(ExitCode::from(2));
                };
                pools.push((*pool).to_owned());
            }
            store.migrate().await?;
            let (view, created) = domains::register(store, &base.keys, domain, &pools).await?;
            println!(
                "{}",
                if created {
                    "registered"
                } else {
                    "already registered"
                }
            );
            print_domain(&view);
        }
        ("domains", ["remove", domain]) => {
            if store.delete_domain(domain).await? {
                println!("{domain} removed; publish nothing more for it");
            } else {
                eprintln!("{domain} is not registered");
                return Ok(ExitCode::FAILURE);
            }
        }
        _ => {
            eprintln!("{USAGE}");
            return Ok(ExitCode::from(2));
        }
    }
    Ok(ExitCode::SUCCESS)
}
