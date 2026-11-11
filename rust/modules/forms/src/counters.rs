//! `FormCounters` on the cache port (`lib/counters.ts`): views per day,
//! rate-limit windows and wrong-code counts per form. On Global one Durable
//! Object per form settles one call at a time; here every rule is one atomic
//! `INCRBY` on Valkey (with its expiry), so parallel requests on other pods
//! cannot slip past a limit or the five-try lock either.
//!
//! Keys, under the cache's prefix: `forms:counters:<formId>:` then
//! `vk:<day>:<viewKey>` (a view counted today), `views:<day>` (kept 400
//! days, longer than any insights range reads back),
//! `rl:<scope>:<window>` and `at:<scope>` (wrong answers, expiring 15
//! minutes after the last one).

use std::sync::Arc;
use std::time::Duration;

use weldsuite_ports::DynCache;

use crate::common::{FormsResult, day_of, forms_error_with};
use crate::sessions::{CODE_LOCK_SECONDS, CODE_MAX_ATTEMPTS};

/// `RateCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RateCheck {
    pub(crate) allowed: bool,
    pub(crate) remaining: i64,
    pub(crate) retry_after_seconds: i64,
}

/// `CodeCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodeCheck {
    Ok,
    Wrong { locked: bool, attempts_left: i64 },
}

/// One form's counters (`countersFor(ns, formId)`).
#[derive(Clone)]
pub(crate) struct Counters {
    cache: Arc<dyn DynCache>,
    form_id: String,
    now_ms: i64,
}

/// A view marker outlives its day: a reload after midnight is a new view.
const VIEW_MARKER_TTL: Duration = Duration::from_hours(48);
/// A day's view count: kept 400 days, then gone with the day.
const VIEW_DAY_TTL: Duration = Duration::from_hours(400 * 24);

impl Counters {
    pub(crate) fn new(cache: Arc<dyn DynCache>, form_id: &str, now_ms: i64) -> Self {
        Self {
            cache,
            form_id: form_id.to_owned(),
            now_ms,
        }
    }

    fn key(&self, suffix: &str) -> String {
        format!("forms:counters:{}:{suffix}", self.form_id)
    }

    /// `recordView(day, viewKey)`: false when this key was counted today.
    pub(crate) async fn record_view(&self, day: &str, view_key: &str) -> FormsResult<bool> {
        let marker = self.key(&format!("vk:{day}:{view_key}"));
        let seen = self
            .cache
            .increment_boxed(&marker, 1, Some(VIEW_MARKER_TTL))
            .await?;
        if seen != 1 {
            return Ok(false);
        }
        self.cache
            .increment_boxed(&self.key(&format!("views:{day}")), 1, Some(VIEW_DAY_TTL))
            .await?;
        Ok(true)
    }

    /// `viewsByDay(from, to)`: views of each of `days` that has any.
    pub(crate) async fn views_by_day(&self, days: &[String]) -> FormsResult<Vec<(String, i64)>> {
        let mut out = Vec::new();
        for day in days {
            if let Some(count) = self
                .cache
                .get_boxed(&self.key(&format!("views:{day}")))
                .await?
                .and_then(|text| text.parse::<i64>().ok())
            {
                out.push((day.clone(), count));
            }
        }
        Ok(out)
    }

    /// `rateLimit(scope, limit, windowSeconds)`: one hit in a fixed window,
    /// refused once the window has `limit` hits.
    pub(crate) async fn rate_limit(
        &self,
        scope: &str,
        limit: i64,
        window_seconds: i64,
    ) -> FormsResult<RateCheck> {
        let window_ms = window_seconds * 1000;
        let window = self.now_ms.div_euclid(window_ms);
        let retry_after_seconds = 1.max(((window + 1) * window_ms - self.now_ms + 999) / 1000);
        let ttl = Duration::from_secs(u64::try_from(window_seconds * 2).unwrap_or(120));
        let used = self
            .cache
            .increment_boxed(&self.key(&format!("rl:{scope}:{window}")), 1, Some(ttl))
            .await?;
        if used > limit {
            return Ok(RateCheck {
                allowed: false,
                remaining: 0,
                retry_after_seconds,
            });
        }
        Ok(RateCheck {
            allowed: true,
            remaining: limit - used,
            retry_after_seconds,
        })
    }

    /// `tries(scope)`: wrong answers so far (0 once the lock window passed).
    pub(crate) async fn tries(&self, scope: &str) -> FormsResult<i64> {
        Ok(self
            .cache
            .get_boxed(&self.key(&format!("at:{scope}")))
            .await?
            .and_then(|text| text.parse::<i64>().ok())
            .unwrap_or(0))
    }

    /// `attempt(scope, match)`: refused while locked, clears the count on a
    /// match, else counts a miss; each miss restarts the 15-minute window.
    /// Every answer takes its slot atomically before it is judged, so
    /// parallel guesses never get more than five looks.
    pub(crate) async fn attempt(&self, scope: &str, matched: bool) -> FormsResult<CodeCheck> {
        let locked = CodeCheck::Wrong {
            locked: true,
            attempts_left: 0,
        };
        if self.tries(scope).await? >= CODE_MAX_ATTEMPTS {
            return Ok(locked);
        }
        let key = self.key(&format!("at:{scope}"));
        let ttl = Duration::from_secs(u64::try_from(CODE_LOCK_SECONDS).unwrap_or(900));
        let tries = self.cache.increment_boxed(&key, 1, Some(ttl)).await?;
        if tries > CODE_MAX_ATTEMPTS {
            return Ok(locked);
        }
        if matched {
            self.cache.delete_boxed(&key).await?;
            return Ok(CodeCheck::Ok);
        }
        Ok(CodeCheck::Wrong {
            locked: tries >= CODE_MAX_ATTEMPTS,
            attempts_left: (CODE_MAX_ATTEMPTS - tries).max(0),
        })
    }
}

/// `rateLimited(counters, scope, limit)`: 429 `RATE_LIMITED` once the
/// minute's window is full.
pub(crate) async fn rate_limited(counters: &Counters, scope: &str, limit: i64) -> FormsResult<()> {
    let check = counters.rate_limit(scope, limit, 60).await?;
    if check.allowed {
        return Ok(());
    }
    Err(forms_error_with(
        429,
        "RATE_LIMITED",
        "Too many requests. Try again in a moment.",
        serde_json::json!({ "retryAfterSeconds": check.retry_after_seconds }),
    ))
}

/// Today's UTC day, for views.
pub(crate) fn today(now_ms: i64) -> String {
    day_of(now_ms)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use weldsuite_ports::MemoryCache;

    use super::*;

    fn counters(now_ms: i64) -> (Arc<MemoryCache>, Counters) {
        let cache = Arc::new(MemoryCache::default());
        let counters = Counters::new(cache.clone(), "frm_1", now_ms);
        (cache, counters)
    }

    #[tokio::test]
    async fn views_count_once_per_key_and_day() {
        let (_, counters) = counters(1_700_000_000_000);
        assert!(counters.record_view("2023-11-14", "tab-1").await.unwrap());
        assert!(!counters.record_view("2023-11-14", "tab-1").await.unwrap());
        assert!(counters.record_view("2023-11-14", "tab-2").await.unwrap());
        let views = counters
            .views_by_day(&["2023-11-14".to_owned(), "2023-11-15".to_owned()])
            .await
            .unwrap();
        assert_eq!(views, vec![("2023-11-14".to_owned(), 2)]);
    }

    #[tokio::test]
    async fn rate_limits_refuse_past_the_limit_in_a_window() {
        let (_, counters) = counters(60_000 * 100 + 15_000);
        for _ in 0..3 {
            assert!(counters.rate_limit("sess:x", 3, 60).await.unwrap().allowed);
        }
        let refused = counters.rate_limit("sess:x", 3, 60).await.unwrap();
        assert_eq!(
            refused,
            RateCheck {
                allowed: false,
                remaining: 0,
                retry_after_seconds: 45
            }
        );
        assert!(counters.rate_limit("sess:y", 3, 60).await.unwrap().allowed);
    }

    #[tokio::test]
    async fn five_wrong_codes_lock_even_the_right_one() {
        let (_, counters) = counters(1_000);
        for tries in 1..=4 {
            assert_eq!(
                counters.attempt("code:h", false).await.unwrap(),
                CodeCheck::Wrong {
                    locked: false,
                    attempts_left: 5 - tries
                }
            );
        }
        assert_eq!(
            counters.attempt("code:h", false).await.unwrap(),
            CodeCheck::Wrong {
                locked: true,
                attempts_left: 0
            }
        );
        assert_eq!(
            counters.attempt("code:h", true).await.unwrap(),
            CodeCheck::Wrong {
                locked: true,
                attempts_left: 0
            }
        );
        assert_eq!(counters.tries("code:h").await.unwrap(), 5);
        // A right answer before the lock clears the count.
        assert_eq!(
            counters.attempt("code:g", false).await.unwrap(),
            CodeCheck::Wrong {
                locked: false,
                attempts_left: 4
            }
        );
        assert_eq!(
            counters.attempt("code:g", true).await.unwrap(),
            CodeCheck::Ok
        );
        assert_eq!(counters.tries("code:g").await.unwrap(), 0);
    }
}
