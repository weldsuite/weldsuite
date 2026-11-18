//! How often a caller id verification code may be sent and tried, per hour
//! (`lib/sip-verification-limits.ts`).
//!
//! Every send makes Telnyx call or text the number, and a code is a few
//! digits: without a limit a member could have a number rung without end, or
//! guess the code of a number that is not theirs. The counters live in the
//! workspace cache, one key per clock hour; without a cache, or when it fails,
//! nothing is limited.

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ports::DynCache;

/// Codes sent to one number per hour.
pub(crate) const SENDS_PER_NUMBER: i64 = 3;
/// Codes sent by one workspace per hour, over all its numbers.
pub(crate) const SENDS_PER_WORKSPACE: i64 = 10;
/// Codes tried on one number per hour.
pub(crate) const CONFIRMS_PER_NUMBER: i64 = 5;

const WINDOW_MS: i64 = 60 * 60 * 1000;
/// Twice the window: a counter outlives its hour, never the next one.
const COUNTER_TTL: Duration = Duration::from_hours(2);

/// `Date.now()`.
fn now_ms() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(i64::MAX)
}

/// `countVerificationAttempt(env, scope, max)`: count one attempt in this
/// hour's window of `scope`. `None` while the window has room; once it holds
/// more than `max`, the seconds until it ends.
pub(crate) async fn count_attempt(
    cache: Option<&Arc<dyn DynCache>>,
    scope: &str,
    max: i64,
) -> Option<u64> {
    count_attempt_at(cache, scope, max, now_ms()).await
}

async fn count_attempt_at(
    cache: Option<&Arc<dyn DynCache>>,
    scope: &str,
    max: i64,
    now: i64,
) -> Option<u64> {
    let cache = cache?;
    let window = now.div_euclid(WINDOW_MS);
    let key = format!("sip-verify:{scope}:{window}");
    let counted = async {
        let used = cache
            .get_boxed(&key)
            .await?
            .and_then(|text| text.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let count = used.saturating_add(1);
        cache
            .put_boxed(&key, &count.to_string(), Some(COUNTER_TTL))
            .await?;
        Ok::<i64, weldsuite_ports::PortError>(count)
    }
    .await;
    match counted {
        Ok(count) if count <= max => None,
        Ok(_) => {
            let left_ms = (window + 1) * WINDOW_MS - now;
            Some(u64::try_from((left_ms + 999) / 1000).unwrap_or(1).max(1))
        }
        Err(error) => {
            tracing::warn!(%error, "[sip-trunks] verification counter unavailable");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryCache;

    #[tokio::test]
    async fn the_attempt_after_the_limit_waits_for_the_next_hour() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        let now = 5 * WINDOW_MS + 600_000;
        for _ in 0..3 {
            assert_eq!(count_attempt_at(Some(&cache), "n", 3, now).await, None);
        }
        assert_eq!(
            count_attempt_at(Some(&cache), "n", 3, now).await,
            Some(3000)
        );
        // Another scope, and the next hour, start afresh.
        assert_eq!(count_attempt_at(Some(&cache), "m", 3, now).await, None);
        assert_eq!(
            count_attempt_at(Some(&cache), "n", 3, now + WINDOW_MS).await,
            None
        );
    }

    #[tokio::test]
    async fn without_a_cache_nothing_is_limited() {
        for _ in 0..20 {
            assert_eq!(count_attempt_at(None, "n", 1, 0).await, None);
        }
    }
}
