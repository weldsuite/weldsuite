//! WeldMail's custom domains on the Kubernetes editions (MAIL-010, MAIL-011):
//! which `MailDomains` adapter the mail routes get, from the environment,
//! once per process. Global's counterpart is the Cloudflare Email Routing
//! and Email Sending API that mail-api's `services/mail/domains.ts` calls.
//!
//! | Variable | |
//! |---|---|
//! | `MAIL_MX_HOST` | the edition's MX (`mx.<domain>`, Haraka). Unset: no adapter, custom domains are not offered |
//! | `MTA_API_URL`, `MTA_API_SECRET` | the EU edition's MTA: `RelayDomains` over [`MtaDomainApi`], per-domain DKIM. Unset: `ManualDomains` |
//! | `MAIL_SPF_INCLUDE` | the SPF include customers publish (`_spf.<domain>`); unset: `mx` |
//! | `MAIL_DKIM_SELECTOR`, `MAIL_DKIM_RECORD` | `ManualDomains` only: the relay's one DKIM key for every domain |
//! | `MAIL_DMARC_RECORD` | the DMARC record suggested (default `v=DMARC1; p=none`) |
//! | `MAIL_DNS_RESOLVER` | the DNS-over-HTTPS endpoint verification asks (default Cloudflare's, as the MX lookups) |

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use weldsuite_mail_domain::domains::{
    DomainRecordsConfig, MailDomains, ManualDomains, RelayDomains,
};
use weldsuite_mail_domain::mta_domains::MtaDomainApi;
use weldsuite_mail_domain::recipients::{DOH_ENDPOINT, DnsOverHttps};
use weldsuite_ports::OutboundHttp;

/// The process's adapter; conformance builds have none (the
/// `/api/mail-domains` routes are not served on Kubernetes yet).
pub(crate) fn mail_domains() -> Option<Arc<dyn MailDomains>> {
    static DOMAINS: OnceLock<Option<Arc<dyn MailDomains>>> = OnceLock::new();
    if cfg!(feature = "conformance") {
        return None;
    }
    DOMAINS
        .get_or_init(|| {
            let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
            let http = || {
                weldsuite_adapters_oss::ReqwestOutbound::new(Duration::from_secs(15))
                    .inspect_err(|error| tracing::error!(%error, "MTA API client"))
                    .ok()
                    .map(|client| OutboundHttp(Arc::new(client)))
            };
            from_env(read, http, weldsuite_mail::send::reqwest_doh())
        })
        .clone()
}

/// The adapter `read` describes; `http` makes the MTA API's client.
fn from_env(
    read: impl Fn(&str) -> Option<String>,
    http: impl FnOnce() -> Option<OutboundHttp>,
    doh: Arc<dyn DnsOverHttps>,
) -> Option<Arc<dyn MailDomains>> {
    let Some(mx_host) = read("MAIL_MX_HOST") else {
        tracing::info!("MAIL_MX_HOST is not set: no custom mail domains");
        return None;
    };
    let dkim = match (read("MAIL_DKIM_SELECTOR"), read("MAIL_DKIM_RECORD")) {
        (Some(selector), Some(record)) => Some((selector, record)),
        (None, None) => None,
        _ => {
            tracing::error!("MAIL_DKIM_SELECTOR and MAIL_DKIM_RECORD go together; ignored");
            None
        }
    };
    let manual = ManualDomains::new(
        DomainRecordsConfig {
            mx_host,
            spf_include: read("MAIL_SPF_INCLUDE"),
            dkim,
            dmarc: read("MAIL_DMARC_RECORD").unwrap_or_else(|| "v=DMARC1; p=none".to_owned()),
        },
        doh,
        read("MAIL_DNS_RESOLVER").unwrap_or_else(|| DOH_ENDPOINT.to_owned()),
    );
    match (read("MTA_API_URL"), read("MTA_API_SECRET")) {
        (Some(url), Some(secret)) => {
            let api = http().map(|http| {
                Arc::new(MtaDomainApi::new(http, &url, secret))
                    as Arc<dyn weldsuite_mail_domain::domains::RelayDomainApi>
            });
            Some(Arc::new(RelayDomains::new(api, manual)))
        }
        (None, None) => Some(Arc::new(manual)),
        _ => {
            tracing::error!(
                "MTA_API_URL and MTA_API_SECRET go together: custom domains are not offered"
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, PortError};

    use super::*;

    struct NoDoh;

    impl DnsOverHttps for NoDoh {
        fn get<'a>(&'a self, _url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
            Box::pin(async { Err("offline".to_owned()) })
        }
    }

    struct NoHttp;

    impl DynOutboundHttp for NoHttp {
        fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            Box::pin(async { Err(PortError::backend("offline")) })
        }
    }

    fn adapter(vars: &[(&str, &str)]) -> Option<Arc<dyn MailDomains>> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        from_env(
            |name| vars.get(name).cloned(),
            || Some(OutboundHttp(Arc::new(NoHttp))),
            Arc::new(NoDoh),
        )
    }

    #[test]
    fn the_mta_api_picks_the_relay_adapter() {
        assert!(adapter(&[]).is_none());
        let mx = ("MAIL_MX_HOST", "mx.eu.weldsuite.test");
        assert_eq!(adapter(&[mx]).expect("manual").provider(), "manual");
        let mta = adapter(&[
            mx,
            ("MTA_API_URL", "http://weldsuite-mta:8025"),
            ("MTA_API_SECRET", "s3cret"),
        ])
        .expect("relay");
        assert_eq!(mta.provider(), "mta");
        assert!(adapter(&[mx, ("MTA_API_URL", "http://weldsuite-mta:8025")]).is_none());
    }
}
