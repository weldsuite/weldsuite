//! `portal-rate-limit.ts`: the atomic fixed-window limits of the public
//! portals.
//!
//! On Global the counters live in commerce-api's `PortalRateLimiter`
//! Durable Object, one instance per limiter key. Here they are behind the
//! [`RateLimitCounters`] port: [`CacheRateLimitCounters`] keeps them on the
//! shared cache's atomic counters (Valkey `INCRBY`, so every replica counts
//! against the same window), and conformance builds call the test's own
//! namespace through the harness's bridge.
//!
//! Window: fixed, starting at the first hit and lasting `window_seconds`.
//! Refused hits are not counted, so a flood does not grow the counter.

use std::sync::Arc;
use std::time::Duration;

use weldsuite_kit::validation::js_trim;
use weldsuite_ports::{BoxFuture, DynCache, PortError};

/// Window and cap of the per-email limit on requesting a code.
pub const RATE_LIMIT_TTL_SECONDS: u64 = 15 * 60;
pub const RATE_LIMIT_MAX: u32 = 5;
/// Code requests per 15 minutes per workspace, across all addresses.
pub const REQUEST_RATE_LIMIT_WORKSPACE_MAX: u32 = 200;

/// One hit's verdict (`RateLimitVerdict`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitVerdict {
    pub allowed: bool,
    /// Hits counted in the current window, including this one when allowed.
    pub count: u32,
    pub remaining: u32,
}

/// The counters behind the limits, one per limiter key (`rateLimitKey`).
pub trait RateLimitCounters: Send + Sync {
    /// Count one hit against `name`'s window; refused when the cap is reached.
    fn hit<'a>(
        &'a self,
        name: &'a str,
        max: u32,
        window_seconds: u64,
    ) -> BoxFuture<'a, Result<RateLimitVerdict, PortError>>;

    /// Give back one hit of the current window (an attempt that succeeded).
    fn release<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), PortError>>;
}

/// The limiter a request uses in place of the app's: conformance builds
/// insert it (the test's `PORTAL_RATE_LIMITER`, or none).
#[derive(Clone)]
pub struct RequestRateLimiter(pub Option<Arc<dyn RateLimitCounters>>);

/// `rateLimitKey(workspaceId, key)`: never shared between workspaces.
pub fn rate_limit_key(workspace_id: &str, key: &str) -> String {
    format!("cportal:rl:{workspace_id}:{}", js_trim(key).to_lowercase())
}

/// What a limited call may answer (`RateLimitOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitOutcome {
    /// Under the cap; the hit was counted.
    Allowed,
    /// Over the cap.
    Limited,
    /// The counter could not be reached (no limiter, or it failed). The
    /// portal's sign-in endpoints refuse then (fail closed).
    Unavailable,
}

/// `consumeRateLimit(env, workspaceId, key, max, windowSeconds)`.
pub async fn consume_rate_limit(
    limiter: Option<&Arc<dyn RateLimitCounters>>,
    workspace_id: &str,
    key: &str,
    max: u32,
    window_seconds: u64,
) -> RateLimitOutcome {
    let Some(limiter) = limiter else {
        tracing::error!("[commerce-domain/portal-rate-limit] PORTAL_RATE_LIMITER binding is missing");
        return RateLimitOutcome::Unavailable;
    };
    match limiter
        .hit(&rate_limit_key(workspace_id, key), max, window_seconds)
        .await
    {
        Ok(verdict) if verdict.allowed => RateLimitOutcome::Allowed,
        Ok(_) => RateLimitOutcome::Limited,
        Err(error) => {
            tracing::error!(%error, "[commerce-domain/portal-rate-limit] counter unreachable");
            RateLimitOutcome::Unavailable
        }
    }
}

/// `releaseRateLimit(env, workspaceId, key)`: best effort.
pub async fn release_rate_limit(
    limiter: Option<&Arc<dyn RateLimitCounters>>,
    workspace_id: &str,
    key: &str,
) {
    let Some(limiter) = limiter else {
        return;
    };
    if let Err(error) = limiter.release(&rate_limit_key(workspace_id, key)).await {
        tracing::error!(%error, "[commerce-domain/portal-rate-limit] could not release a slot");
    }
}

/// The counters on the shared cache: `INCRBY` is atomic across replicas.
/// The first hit of a window sets the key's expiry to the window; a refused
/// hit is taken back at once.
pub struct CacheRateLimitCounters {
    cache: Arc<dyn DynCache>,
}

impl CacheRateLimitCounters {
    pub fn new(cache: Arc<dyn DynCache>) -> Self {
        Self { cache }
    }
}

impl RateLimitCounters for CacheRateLimitCounters {
    fn hit<'a>(
        &'a self,
        name: &'a str,
        max: u32,
        window_seconds: u64,
    ) -> BoxFuture<'a, Result<RateLimitVerdict, PortError>> {
        Box::pin(async move {
            if max < 1 || window_seconds < 1 {
                return Err(PortError::backend("rate limit max and window must be positive"));
            }
            let count = self.cache.increment_boxed(name, 1, None).await?;
            if count == 1 {
                self.cache
                    .increment_boxed(name, 0, Some(Duration::from_secs(window_seconds)))
                    .await?;
            }
            let cap = i64::from(max);
            if count > cap {
                self.cache.increment_boxed(name, -1, None).await?;
                return Ok(RateLimitVerdict {
                    allowed: false,
                    count: max,
                    remaining: 0,
                });
            }
            let count = u32::try_from(count).unwrap_or(max);
            Ok(RateLimitVerdict {
                allowed: true,
                count,
                remaining: max.saturating_sub(count),
            })
        })
    }

    fn release<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let current = self
                .cache
                .get_boxed(name)
                .await?
                .and_then(|text| text.trim().parse::<i64>().ok())
                .unwrap_or(0);
            if current <= 0 {
                return Ok(());
            }
            // The window may have ended in between: a counter that comes
            // back below zero was recreated, and goes.
            if self.cache.increment_boxed(name, -1, None).await? < 0 {
                self.cache.delete_boxed(name).await?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryCache;

    #[tokio::test]
    async fn counts_up_to_the_cap_and_releases() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        let counters: Arc<dyn RateLimitCounters> = Arc::new(CacheRateLimitCounters::new(cache));
        for expected in 1..=3 {
            let verdict = counters.hit("k", 3, 60).await.expect("hit");
            assert!(verdict.allowed);
            assert_eq!(verdict.count, expected);
        }
        let refused = counters.hit("k", 3, 60).await.expect("hit");
        assert!(!refused.allowed);
        counters.release("k").await.expect("release");
        assert!(counters.hit("k", 3, 60).await.expect("hit").allowed);
        assert_eq!(
            consume_rate_limit(Some(&counters), "ws", " K ", 1, 60).await,
            RateLimitOutcome::Allowed
        );
        assert_eq!(
            consume_rate_limit(Some(&counters), "ws", "k", 1, 60).await,
            RateLimitOutcome::Limited
        );
        assert_eq!(
            consume_rate_limit(None, "ws", "k", 1, 60).await,
            RateLimitOutcome::Unavailable
        );
        assert_eq!(rate_limit_key("ws", " E:A@B.C "), "cportal:rl:ws:e:a@b.c");
    }
}
