//! The DMARC report receiver's adapters (ADR MAIL-015): WeldSuite's own
//! sending addresses from the MTA's API, cached, and reverse DNS names
//! through the install's own resolver (the MTA's stub resolver on
//! `/etc/resolv.conf`, the cluster's DNS), never an outside lookup service.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use weldsuite_mail_domain::mta_domains::MtaDomainApi;
use weldsuite_mail_inbound::dmarc::{ReverseNames, SendingAddresses};
use weldsuite_ports::BoxFuture;

/// How long the MTA's address list is kept.
const ADDRESSES_TTL: Duration = Duration::from_secs(600);
/// One reverse lookup's budget.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
/// Lookups in flight at once.
const LOOKUP_CONCURRENCY: usize = 8;

/// The MTA's `GET /v1/ips`, asked at most every ten minutes. A failed call
/// keeps the last list (or none).
pub(crate) struct MtaAddresses {
    api: MtaDomainApi,
    cache: Mutex<Option<(Instant, HashMap<String, String>)>>,
}

impl MtaAddresses {
    pub(crate) fn new(api: MtaDomainApi) -> Self {
        Self {
            api,
            cache: Mutex::new(None),
        }
    }
}

impl SendingAddresses for MtaAddresses {
    fn pools(&self) -> BoxFuture<'_, HashMap<String, String>> {
        Box::pin(async move {
            let mut cache = self.cache.lock().await;
            if let Some((at, pools)) = cache.as_ref()
                && at.elapsed() < ADDRESSES_TTL
            {
                return pools.clone();
            }
            match self.api.sending_addresses().await {
                Ok(pools) => {
                    *cache = Some((Instant::now(), pools.clone()));
                    pools
                }
                Err(error) => {
                    tracing::warn!(%error, "[dmarc] the MTA's sending addresses are unknown");
                    cache
                        .as_ref()
                        .map(|(_, pools)| pools.clone())
                        .unwrap_or_default()
                }
            }
        })
    }
}

/// PTR lookups for IPv4 sources through the system resolver.
pub(crate) struct ResolverNames {
    resolver: Arc<weldsuite_mta::dns::Resolver>,
}

impl ResolverNames {
    pub(crate) fn system() -> Self {
        Self {
            resolver: Arc::new(weldsuite_mta::dns::Resolver::system()),
        }
    }
}

impl ReverseNames for ResolverNames {
    fn names(&self, ips: Vec<IpAddr>) -> BoxFuture<'_, HashMap<IpAddr, String>> {
        Box::pin(async move {
            let mut names = HashMap::new();
            let v4: Vec<std::net::Ipv4Addr> = ips
                .into_iter()
                .filter_map(|ip| match ip {
                    IpAddr::V4(ip) => Some(ip),
                    IpAddr::V6(_) => None,
                })
                .collect();
            for chunk in v4.chunks(LOOKUP_CONCURRENCY) {
                let mut lookups = tokio::task::JoinSet::new();
                for &ip in chunk {
                    let resolver = Arc::clone(&self.resolver);
                    lookups.spawn(async move {
                        let name = tokio::time::timeout(LOOKUP_TIMEOUT, resolver.ptr(ip))
                            .await
                            .ok()
                            .and_then(Result::ok)
                            .flatten();
                        (ip, name)
                    });
                }
                while let Some(done) = lookups.join_next().await {
                    if let Ok((ip, Some(name))) = done {
                        names.insert(IpAddr::V4(ip), name);
                    }
                }
            }
            names
        })
    }
}
