//! WeldForms' custom form domains on this server (`formsPortal.customDomains`
//! in the chart): their cert-manager profile, whose Ingresses send every path
//! of a domain to the forms portal's Service, and `weldsuite cron
//! forms-domains`.
//!
//! | Variable | |
//! |---|---|
//! | `FORMS_CUSTOM_DOMAINS=cert-manager` | custom form domains, with `FORMS_CNAME_TARGET`, `FORMS_APEX_ADDRESSES`, `FORMS_DOMAINS_NAMESPACE`, `FORMS_DOMAINS_SERVICE` (the portal's Service), `FORMS_DOMAINS_SERVICE_PORT`, `FORMS_DOMAINS_INGRESS_CLASS`, `FORMS_DOMAINS_ISSUER`, `FORMS_DOMAINS_ISSUER_KIND`, `FORMS_DNS_RESOLVER` |

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use weldsuite_custom_domains::{
    CertManagerHosts, ClusterSettings, DEFAULT_DNS_RESOLVER, KubeToken, Profile, Routes,
    TOKEN_FILE, Target, normalize_host,
};

use crate::config::Config;

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
/// (`forms.weldsuite.eu` → `weldsuite.eu`).
fn parent(host: &str) -> Option<String> {
    host.split_once('.')
        .map(|(_, parent)| parent.to_owned())
        .filter(|parent| parent.contains('.'))
}

/// The forms profile: objects `weldforms-*`, component `forms-domain` (keep
/// in step with `weldsuite.customDomains.profiles` in the chart), every path
/// to the portal's Service.
fn profile() -> Profile {
    Profile {
        owner: "WeldForms",
        component: "forms-domain",
        annotation: "weldsuite.org/forms-hostname",
        name_prefix: "weldforms",
        chart_switch: "formsPortal.customDomains.enabled",
        routes: Routes::Everything { service_port: None },
    }
}

/// Custom form domains through cert-manager, made once per process; `None`
/// without `FORMS_CUSTOM_DOMAINS=cert-manager` or outside a cluster.
pub(crate) fn custom_domains() -> Option<Arc<CertManagerHosts>> {
    static DOMAINS: OnceLock<Option<Arc<CertManagerHosts>>> = OnceLock::new();
    if cfg!(feature = "conformance") {
        return None;
    }
    DOMAINS
        .get_or_init(|| {
            match env("FORMS_CUSTOM_DOMAINS").as_deref() {
                None => return None,
                Some("cert-manager") => {}
                Some(other) => {
                    tracing::error!(value = other, "FORMS_CUSTOM_DOMAINS must be cert-manager; custom form domains are off");
                    return None;
                }
            }
            let required = |name: &str| {
                let value = env(name);
                if value.is_none() {
                    tracing::error!(variable = name, "custom form domains are off: the variable is missing");
                }
                value
            };
            let target = normalize_host(&required("FORMS_CNAME_TARGET")?);
            let api_url = ClusterSettings::api_url_from_env(&|name| env(name)).or_else(|| {
                tracing::error!("custom form domains are off: not in a cluster (KUBERNETES_SERVICE_HOST)");
                None
            })?;
            let settings = ClusterSettings {
                api_url,
                namespace: required("FORMS_DOMAINS_NAMESPACE")?,
                token: KubeToken::File(TOKEN_FILE.to_owned()),
                service: required("FORMS_DOMAINS_SERVICE")?,
                service_port: env("FORMS_DOMAINS_SERVICE_PORT").unwrap_or_else(|| "http".to_owned()),
                ingress_class: env("FORMS_DOMAINS_INGRESS_CLASS"),
                issuer: env("FORMS_DOMAINS_ISSUER").unwrap_or_else(|| "letsencrypt".to_owned()),
                issuer_kind: env("FORMS_DOMAINS_ISSUER_KIND").unwrap_or_else(|| "ClusterIssuer".to_owned()),
                dns_resolver: env("FORMS_DNS_RESOLVER").unwrap_or_else(|| DEFAULT_DNS_RESOLVER.to_owned()),
            };
            let kube = match weldsuite_sandbox::kube::http_client(
                weldsuite_sandbox::config::CA_FILE,
                Duration::from_secs(30),
            ) {
                Ok(kube) => kube,
                Err(error) => {
                    tracing::error!(%error, "custom form domains are off: no Kubernetes API client");
                    return None;
                }
            };
            let dns = crate::panel_monitor::public_http()?;
            // The install's own names are never a customer's: the target's
            // parent domain (or the target itself) and the platform's.
            let mut refused: Vec<String> = vec![parent(&target).unwrap_or_else(|| target.clone())];
            if let Some(app) = env("PUBLIC_APP_URL")
                .and_then(|u| url::Url::parse(&u).ok())
                .and_then(|u| u.host_str().map(normalize_host))
            {
                refused.extend(parent(&app).or(Some(app)));
            }
            tracing::info!(target = %target, namespace = %settings.namespace, "custom form domains through cert-manager");
            Some(Arc::new(CertManagerHosts::new(
                settings,
                profile(),
                Target {
                    host: target,
                    apex_addresses: list("FORMS_APEX_ADDRESSES"),
                    refused,
                },
                kube,
                dns,
            )))
        })
        .clone()
}

/// `weldsuite cron forms-domains`: the custom form domains still pending,
/// checked from the master database alone.
pub(crate) async fn sweep(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    let started = Instant::now();
    let Some(domains) = custom_domains() else {
        println!(
            "{}",
            serde_json::json!({ "job": "forms-domains", "result": { "skipped": "custom form domains are off" } })
        );
        return Ok(());
    };
    let master =
        weldsuite_db::master_pool(&config.master_database_url, config.master_max_connections)?;
    // The cache, so a domain that went live answers at once, and the events
    // (`form_domain.verified` / `failed`).
    let tracker = weldsuite_events::TaskTracker::new();
    #[cfg(not(feature = "conformance"))]
    let infra =
        crate::infra::connect(&config.infra, &master, &config.keyring, tracker.clone()).await?;
    #[cfg(feature = "conformance")]
    let (infra, _) = crate::conformance::infra(tracker.clone());
    let checked = weldsuite_forms::sweep_domains(
        &master,
        Some(&domains),
        infra.cache.as_ref(),
        Some(&infra.events),
    )
    .await;
    weldsuite_ports::record_job_run("forms.domains", checked.is_ok(), started.elapsed());
    tracker.close();
    if tokio::time::timeout(Duration::from_secs(10), tracker.wait())
        .await
        .is_err()
    {
        tracing::warn!("stopped with publishes still in flight");
    }
    let checked = checked?;
    println!(
        "{}",
        serde_json::json!({ "job": "forms-domains", "result": { "checked": checked } })
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parent, profile};

    #[test]
    fn parents() {
        assert_eq!(
            parent("forms.weldsuite.eu").as_deref(),
            Some("weldsuite.eu")
        );
        assert_eq!(parent("weldsuite.eu"), None);
    }

    #[test]
    fn the_profile_matches_the_chart() {
        // templates/_helpers.tpl, weldsuite.customDomains.profiles.
        assert_eq!(profile().component, "forms-domain");
        assert_eq!(profile().name_prefix, "weldforms");
    }
}
