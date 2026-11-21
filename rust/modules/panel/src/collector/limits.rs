//! `lib/rate-limit.ts`: per-IP limits on the public browser routes (`/e`,
//! `/r`, `/snap`). On Global they are Cloudflare's rate-limiting bindings
//! (`[[ratelimits]]` in panel-ingest's wrangler.toml, which sets the
//! limits); here they are counters in the cache ([`CacheRateLimiter`]), one
//! per binding, key and minute.
//!
//! The limiter counts on a key we choose: a short hash of the address, so
//! the address itself is never passed on, and nothing here is stored. A
//! missing limiter or an address-less request is not limited, and a failing
//! limiter lets the request through: it protects the collector, it must not
//! take it down.

use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use weldsuite_ports::{BoxFuture, Cache, DynCache, PortError};

/// One of panel-ingest's rate-limiting bindings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Limit {
    /// `POST /e` per client address.
    Events,
    /// `POST /e` per connecting address when it isn't the client (a proxy
    /// on the site's own domain, or a forged `X-Forwarded-For`): 50 times
    /// [`Limit::Events`], so rotating the header buys little.
    EventsProxy,
    /// `POST /r` per client address.
    Replays,
    /// `POST /snap` per client address.
    Snapshots,
}

impl Limit {
    /// The binding's name in wrangler.toml (and in a conformance test's env).
    pub const fn binding(self) -> &'static str {
        match self {
            Self::Events => "EVENTS_RATE_LIMIT",
            Self::EventsProxy => "EVENTS_PROXY_RATE_LIMIT",
            Self::Replays => "REPLAYS_RATE_LIMIT",
            Self::Snapshots => "SNAPSHOTS_RATE_LIMIT",
        }
    }

    /// Requests per minute, as wrangler.toml sets them (`simple = { limit,
    /// period = 60 }`).
    pub const fn per_minute(self) -> i64 {
        match self {
            Self::Events => 1200,
            Self::EventsProxy => 60_000,
            Self::Replays => 600,
            Self::Snapshots => 60,
        }
    }
}

/// `limiter.limit({ key })` of one of the bindings: whether this request is
/// within the limit (`success`).
pub trait RateLimiter: Send + Sync {
    fn limit<'a>(&'a self, limit: Limit, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>>;
}

/// Fixed one-minute windows in the cache (Valkey's `INCR`, atomic across
/// pods): `panel:rate:<binding>:<key>:<minute>`, kept two minutes.
pub struct CacheRateLimiter {
    cache: Arc<dyn DynCache>,
}

impl CacheRateLimiter {
    pub fn new(cache: Arc<dyn DynCache>) -> Self {
        Self { cache }
    }

    /// One more request under `key` in the `minute` since 1970.
    async fn count(&self, limit: Limit, key: &str, minute: i64) -> Result<bool, PortError> {
        let count = self
            .cache
            .increment(
                &format!("panel:rate:{}:{key}:{minute}", limit.binding()),
                1,
                Some(Duration::from_secs(120)),
            )
            .await?;
        Ok(count <= limit.per_minute())
    }
}

impl RateLimiter for CacheRateLimiter {
    fn limit<'a>(&'a self, limit: Limit, key: &'a str) -> BoxFuture<'a, Result<bool, PortError>> {
        let minute = time::OffsetDateTime::now_utc()
            .unix_timestamp()
            .div_euclid(60);
        Box::pin(self.count(limit, key, minute))
    }
}

/// The key an address counts on: the first 8 bytes of its SHA-256, in hex.
pub(crate) fn rate_key(ip: &str) -> String {
    hex::encode(&Sha256::digest(ip.as_bytes())[..8])
}

/// `rateLimited(limiter, ip)`: whether this request is over the limit and
/// should be answered 429.
pub(crate) async fn rate_limited(
    limiter: Option<&Arc<dyn RateLimiter>>,
    limit: Limit,
    ip: &str,
) -> bool {
    let Some(limiter) = limiter else {
        return false;
    };
    if ip.is_empty() {
        return false;
    }
    match limiter.limit(limit, &rate_key(ip)).await {
        Ok(within) => !within,
        Err(error) => {
            super::warn_once(
                "rate-limit",
                &format!("Rate limiter failed, not limiting: {error}"),
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_never_carries_the_address() {
        let key = rate_key("203.0.113.7");
        assert_eq!(key.len(), 16);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!key.contains("203"));
        assert_ne!(key, rate_key("198.51.100.9"));
    }

    #[tokio::test]
    async fn counts_per_binding_key_and_minute() {
        let limiter = CacheRateLimiter::new(Arc::new(weldsuite_ports::MemoryCache::default()));
        let key = rate_key("203.0.113.7");
        for _ in 0..60 {
            assert!(
                limiter
                    .count(Limit::Snapshots, &key, 7)
                    .await
                    .expect("a count")
            );
        }
        assert!(
            !limiter
                .count(Limit::Snapshots, &key, 7)
                .await
                .expect("a count")
        );
        assert!(
            limiter
                .count(Limit::Snapshots, &key, 8)
                .await
                .expect("a count")
        );
        let other = rate_key("198.51.100.9");
        assert!(
            limiter
                .count(Limit::Snapshots, &other, 7)
                .await
                .expect("a count")
        );
        assert!(
            limiter
                .count(Limit::Replays, &key, 7)
                .await
                .expect("a count")
        );
    }

    #[tokio::test]
    async fn no_address_or_no_limiter_is_not_limited() {
        let cache: Arc<dyn DynCache> = Arc::new(weldsuite_ports::MemoryCache::default());
        let limiter: Arc<dyn RateLimiter> = Arc::new(CacheRateLimiter::new(cache));
        assert!(!rate_limited(Some(&limiter), Limit::Snapshots, "").await);
        assert!(!rate_limited(None, Limit::Snapshots, "203.0.113.7").await);
        assert!(!rate_limited(Some(&limiter), Limit::Snapshots, "203.0.113.7").await);
    }
}
