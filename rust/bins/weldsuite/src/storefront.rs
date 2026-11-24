//! WeldCommerce's online store on this server (storefronts plan,
//! `weldsuite-documentation/plans/weldcommerce-storefronts.md`): its
//! settings from the environment, the storefront edge on a listener of its
//! own, the renderer's `/public/storefront` mount, the deploy-key upload,
//! and `weldsuite cron storefront-hosts`.
//!
//! | Variable | |
//! |---|---|
//! | `STOREFRONT_LISTEN` | the edge's address (`0.0.0.0:8791`); unset: no edge |
//! | `STOREFRONT_BASE_DOMAIN` | free addresses `{slug}.<base>` |
//! | `STOREFRONT_SCHEME`, `STOREFRONT_PUBLIC_PORT` | `https`, or `http` and a port in development |
//! | `STOREFRONT_RENDERER_URL`, `STOREFRONT_RENDERER_SECRET` | the renderer's Service and the secret it and the server share |
//! | `STOREFRONT_EDITOR_ORIGINS` | who may frame a preview (default: `PUBLIC_APP_URL`'s origin) |
//! | `STOREFRONT_CUSTOM_DOMAINS=cert-manager` | custom domains, with `STOREFRONT_CNAME_TARGET`, `STOREFRONT_APEX_ADDRESSES`, `STOREFRONT_DOMAINS_NAMESPACE`, `STOREFRONT_DOMAINS_SERVICE`, `STOREFRONT_DOMAINS_SERVICE_PORT`, `STOREFRONT_DOMAINS_INGRESS_CLASS`, `STOREFRONT_DOMAINS_ISSUER`, `STOREFRONT_DOMAINS_ISSUER_KIND`, `STOREFRONT_DNS_RESOLVER` |

use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::Router;
use weldsuite_commerce::online_store::OnlineStoreConfig;
use weldsuite_commerce::online_store::edge::{EdgeState, edge_router};
use weldsuite_custom_domains::{
    CertManagerHosts, ClusterSettings, DEFAULT_DNS_RESOLVER, KubeToken, Profile, Routes,
    TOKEN_FILE, Target, normalize_host,
};
use weldsuite_ports::{DynCache, DynFileStore, OutboundHttp};

use crate::config::Config;
use crate::server::AppState;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn list(name: &str) -> Vec<String> {
    env(name)
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The parent domain of a host name with at least three labels
/// (`shops.weldsuite.eu` → `weldsuite.eu`).
fn parent(host: &str) -> Option<String> {
    host.split_once('.')
        .map(|(_, parent)| parent.to_owned())
        .filter(|parent| parent.contains('.'))
}

/// Custom shop domains through cert-manager, made once per process; `None`
/// without `STOREFRONT_CUSTOM_DOMAINS=cert-manager` or outside a cluster.
fn custom_domains() -> Option<Arc<CertManagerHosts>> {
    static DOMAINS: OnceLock<Option<Arc<CertManagerHosts>>> = OnceLock::new();
    if cfg!(feature = "conformance") {
        return None;
    }
    DOMAINS
        .get_or_init(|| {
            match env("STOREFRONT_CUSTOM_DOMAINS").as_deref() {
                None => return None,
                Some("cert-manager") => {}
                Some(other) => {
                    tracing::error!(value = other, "STOREFRONT_CUSTOM_DOMAINS must be cert-manager; custom shop domains are off");
                    return None;
                }
            }
            let required = |name: &str| {
                let value = env(name);
                if value.is_none() {
                    tracing::error!(variable = name, "custom shop domains are off: the variable is missing");
                }
                value
            };
            let target = normalize_host(&required("STOREFRONT_CNAME_TARGET")?);
            let api_url = ClusterSettings::api_url_from_env(&|name| env(name)).or_else(|| {
                tracing::error!("custom shop domains are off: not in a cluster (KUBERNETES_SERVICE_HOST)");
                None
            })?;
            let settings = ClusterSettings {
                api_url,
                namespace: required("STOREFRONT_DOMAINS_NAMESPACE")?,
                token: KubeToken::File(TOKEN_FILE.to_owned()),
                service: required("STOREFRONT_DOMAINS_SERVICE")?,
                service_port: env("STOREFRONT_DOMAINS_SERVICE_PORT").unwrap_or_else(|| "storefront".to_owned()),
                ingress_class: env("STOREFRONT_DOMAINS_INGRESS_CLASS"),
                issuer: env("STOREFRONT_DOMAINS_ISSUER").unwrap_or_else(|| "letsencrypt".to_owned()),
                issuer_kind: env("STOREFRONT_DOMAINS_ISSUER_KIND").unwrap_or_else(|| "ClusterIssuer".to_owned()),
                dns_resolver: env("STOREFRONT_DNS_RESOLVER").unwrap_or_else(|| DEFAULT_DNS_RESOLVER.to_owned()),
            };
            let kube = match weldsuite_sandbox::kube::http_client(
                weldsuite_sandbox::config::CA_FILE,
                Duration::from_secs(30),
            ) {
                Ok(kube) => kube,
                Err(error) => {
                    tracing::error!(%error, "custom shop domains are off: no Kubernetes API client");
                    return None;
                }
            };
            let dns = crate::panel_monitor::public_http()?;
            // The install's own names are never a customer's: the target's
            // parent domain, the platform's, and the free-address domain.
            let mut refused: Vec<String> = parent(&target).into_iter().collect();
            if let Some(app) = env("PUBLIC_APP_URL")
                .and_then(|u| url::Url::parse(&u).ok())
                .and_then(|u| u.host_str().map(normalize_host))
            {
                refused.extend(parent(&app).or(Some(app)));
            }
            refused.extend(env("STOREFRONT_BASE_DOMAIN").map(|b| normalize_host(&b)));
            tracing::info!(target = %target, namespace = %settings.namespace, "custom shop domains through cert-manager");
            Some(Arc::new(CertManagerHosts::new(
                settings,
                Profile {
                    owner: "WeldCommerce",
                    component: "storefront-host",
                    annotation: "weldsuite.org/storefront-hostname",
                    name_prefix: "weldshop",
                    chart_switch: "storefront.customDomains.enabled",
                    routes: Routes::Everything { service_port: None },
                },
                Target {
                    host: target,
                    apex_addresses: list("STOREFRONT_APEX_ADDRESSES"),
                    refused,
                },
                kube,
                dns,
            )))
        })
        .clone()
}

/// The online store's settings with the given ports.
pub(crate) fn config_with(
    cache: Option<Arc<dyn DynCache>>,
    files: Option<Arc<dyn DynFileStore>>,
) -> OnlineStoreConfig {
    OnlineStoreConfig {
        base_domain: env("STOREFRONT_BASE_DOMAIN").map(|b| normalize_host(&b)),
        cname_target: env("STOREFRONT_CNAME_TARGET").map(|t| normalize_host(&t)),
        apex_addresses: list("STOREFRONT_APEX_ADDRESSES"),
        scheme: env("STOREFRONT_SCHEME").unwrap_or_else(|| "https".to_owned()),
        public_port: env("STOREFRONT_PUBLIC_PORT").and_then(|p| p.parse().ok()),
        secret: env("STOREFRONT_RENDERER_SECRET"),
        domains: custom_domains(),
        files,
        cache,
    }
}

/// The online store's settings for the routes.
pub(crate) fn online_store(state: &AppState) -> OnlineStoreConfig {
    config_with(state.infra.cache.clone(), state.infra.public_files.clone())
}

/// The renderer's `/public/storefront` routes.
pub(crate) fn renderer_routes(state: &AppState) -> Router {
    weldsuite_commerce::online_store::renderer::router(
        weldsuite_commerce::online_store::renderer::RendererState {
            master: state.workspaces.master().clone(),
            workspaces: Arc::clone(&state.workspaces),
            config: online_store(state),
        },
    )
}

/// `POST /storefront-deploy/v1/deployments` (deploy keys).
pub(crate) fn deploy_routes(state: &AppState) -> Router {
    weldsuite_commerce::online_store::deploy_router(weldsuite_commerce::online_store::DeployState {
        master: state.workspaces.master().clone(),
        workspaces: Arc::clone(&state.workspaces),
        events: state.infra.events.clone(),
        config: online_store(state),
    })
}

/// The storefront edge and its address, with `STOREFRONT_LISTEN`.
pub(crate) fn edge(state: &AppState) -> Option<(SocketAddr, Router)> {
    let listen = env("STOREFRONT_LISTEN")?;
    let address: SocketAddr = match listen.parse() {
        Ok(address) => address,
        Err(error) => {
            tracing::error!(%error, listen, "STOREFRONT_LISTEN is not an address; no storefront edge");
            return None;
        }
    };
    let renderer =
        weldsuite_adapters_oss::ReqwestOutbound::without_redirects(Duration::from_secs(30))
            .map(|client| OutboundHttp(Arc::new(client)))
            .map_err(|error| tracing::error!(%error, "no client for the storefront renderer"))
            .ok();
    let editor_origins = {
        let configured = list("STOREFRONT_EDITOR_ORIGINS");
        if configured.is_empty() {
            env("PUBLIC_APP_URL")
                .and_then(|u| url::Url::parse(&u).ok())
                .map(|u| vec![u.origin().ascii_serialization()])
                .unwrap_or_default()
        } else {
            configured
        }
    };
    let edge = EdgeState::new(
        state.workspaces.master().clone(),
        Arc::clone(&state.workspaces),
        online_store(state),
        env("STOREFRONT_RENDERER_URL"),
        renderer,
        editor_origins,
        state.trusted_proxies,
    );
    let router = edge_router(edge).layer(axum::middleware::from_fn(weldsuite_kit::request_id));
    Some((address, router))
}

/// `weldsuite cron storefront-hosts`: the custom shop domains still pending,
/// checked from the master database alone.
pub(crate) async fn sweep(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    if custom_domains().is_none() {
        println!(
            "{}",
            serde_json::json!({ "job": "storefront-hosts", "result": { "skipped": "custom shop domains are off" } })
        );
        return Ok(());
    }
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    let store = config_with(None, None);
    let checked = weldsuite_commerce::online_store::sweep_hosts(&master, &store, None).await;
    weldsuite_ports::record_job_run("storefront.hosts", checked.is_ok(), started.elapsed());
    let checked = checked?;
    println!(
        "{}",
        serde_json::json!({ "job": "storefront-hosts", "result": { "checked": checked } })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parent;

    #[test]
    fn parents() {
        assert_eq!(
            parent("shops.weldsuite.eu").as_deref(),
            Some("weldsuite.eu")
        );
        assert_eq!(parent("weldsuite.eu"), None);
    }
}
