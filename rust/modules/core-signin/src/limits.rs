//! How often the sign-in screens may be tried: fixed windows counted in the
//! shared cache (Valkey `INCRBY`, so every replica counts against the same
//! window), per caller and per account.
//!
//! These routes take no session: anybody can post a password. The provider
//! locks an account after its own number of wrong passwords, when it is set
//! to; these limits hold whatever the provider is set to, and cover what it
//! does not count (sign-ups, emails sent).
//!
//! A cache that cannot be reached refuses the attempt (503): an uncounted
//! password guess is worse than a sign-in that has to wait.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::{HeaderMap, StatusCode};
use sha2::{Digest, Sha256};
use weldsuite_kit::ApiError;
use weldsuite_ports::DynCache;

/// One limit: `max` hits per `window`, per subject.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Rule {
    name: &'static str,
    max: i64,
    window: Duration,
}

const fn rule(name: &'static str, max: i64, seconds: u64) -> Rule {
    Rule {
        name,
        max,
        window: Duration::from_secs(seconds),
    }
}

/// Reading where a sign-in stands (it asks the provider several things).
pub(crate) const READS: Rule = rule("read", 120, 60);
pub(crate) const PASSWORDS_PER_CALLER: Rule = rule("password-caller", 30, 300);
pub(crate) const PASSWORDS_PER_ACCOUNT: Rule = rule("password-account", 10, 300);
pub(crate) const CODES_PER_CALLER: Rule = rule("code-caller", 40, 600);
/// Per session or account: a six-character code is not to be guessed.
pub(crate) const CODES_PER_TARGET: Rule = rule("code-target", 10, 600);
pub(crate) const SENDS_PER_CALLER: Rule = rule("send-caller", 20, 900);
pub(crate) const SENDS_PER_TARGET: Rule = rule("send-target", 5, 900);
pub(crate) const SIGN_UPS_PER_CALLER: Rule = rule("sign-up-caller", 10, 3600);

#[derive(Clone)]
pub(crate) struct Limits {
    cache: Arc<dyn DynCache>,
    trusted_proxies: usize,
}

impl Limits {
    pub(crate) fn new(cache: Arc<dyn DynCache>, trusted_proxies: usize) -> Self {
        Self {
            cache,
            trusted_proxies,
        }
    }

    /// The caller: the `X-Forwarded-For` entry the ingress appended
    /// (`trusted_proxies` from the right), when it looks like an address;
    /// else `unknown`, one shared counter. `CF-Connecting-IP` is not read:
    /// nothing in front of the Kubernetes server overwrites it.
    pub(crate) fn caller(&self, headers: &HeaderMap) -> String {
        let hops: Vec<&str> = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .map(str::trim)
            .filter(|hop| !hop.is_empty())
            .collect();
        hops.len()
            .checked_sub(self.trusted_proxies.max(1))
            .and_then(|at| hops.get(at))
            .filter(|ip| {
                (2..=45).contains(&ip.len())
                    && ip
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() || matches!(b, b'.' | b':'))
            })
            .map_or_else(|| "unknown".to_owned(), |ip| (*ip).to_owned())
    }

    /// Count one hit for `subject`; the 429 once the window is full.
    pub(crate) async fn hit(&self, rule: Rule, subject: &str) -> Result<(), ApiError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        let window = rule.window.as_secs().max(1);
        let key = counter_key(rule, subject, now / window);
        let count = self
            .cache
            .increment_boxed(&key, 1, Some(rule.window * 2))
            .await
            .map_err(|error| {
                tracing::error!(%error, rule = rule.name, "sign-in: attempt counter unavailable");
                ApiError::unavailable("Sign-in is temporarily unavailable. Try again in a moment.")
            })?;
        if count > rule.max {
            let retry_after = u32::try_from(window - now % window).unwrap_or(u32::MAX);
            return Err(too_many(retry_after));
        }
        Ok(())
    }
}

/// `signin:<rule>:<subject hash>:<window>`. The subject (an address, an IP)
/// is hashed: the cache holds no personal data for a counter.
fn counter_key(rule: Rule, subject: &str, window: u64) -> String {
    let digest = Sha256::digest(subject.trim().to_lowercase().as_bytes());
    format!(
        "signin:{}:{}:{window}",
        rule.name,
        hex::encode(&digest[..12])
    )
}

fn too_many(retry_after: u32) -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts. Try again later.",
    )
    .with_retry_after(retry_after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;
    use weldsuite_ports::MemoryCache;

    fn limits(trusted_proxies: usize) -> Limits {
        Limits::new(Arc::new(MemoryCache::new()), trusted_proxies)
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_str(value).expect("value"),
        );
        headers
    }

    #[test]
    fn the_caller_is_the_hop_the_ingress_added() {
        // The client can prepend anything; the ingress appends the real one.
        assert_eq!(
            limits(1).caller(&forwarded("6.6.6.6, 203.0.113.9")),
            "203.0.113.9"
        );
        assert_eq!(
            limits(2).caller(&forwarded("203.0.113.9, 10.0.0.1")),
            "203.0.113.9"
        );
        assert_eq!(limits(1).caller(&HeaderMap::new()), "unknown");
        assert_eq!(limits(1).caller(&forwarded("not an address")), "unknown");
    }

    #[test]
    fn a_counter_key_holds_no_address() {
        let key = counter_key(PASSWORDS_PER_ACCOUNT, " Jane@Acme.Test ", 7);
        assert!(key.starts_with("signin:password-account:"));
        assert!(key.ends_with(":7"));
        assert!(!key.contains("jane"));
        // Case and spaces around an address count as the same account.
        assert_eq!(key, counter_key(PASSWORDS_PER_ACCOUNT, "jane@acme.test", 7));
        assert_ne!(key, counter_key(PASSWORDS_PER_CALLER, "jane@acme.test", 7));
    }

    #[tokio::test]
    async fn a_full_window_refuses_with_retry_after() {
        let limits = limits(1);
        let rule = rule("test", 2, 3600);
        assert!(limits.hit(rule, "a").await.is_ok());
        assert!(limits.hit(rule, "a").await.is_ok());
        let refused = limits.hit(rule, "a").await.expect_err("limited");
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.code(), "RATE_LIMITED");
        assert!(refused.retry_after().is_some_and(|seconds| seconds > 0));
        // Another subject has its own window.
        assert!(limits.hit(rule, "b").await.is_ok());
    }
}
