//! Requests per key and client address per minute, counted in the cache
//! (atomic counters, one per minute): 120 reads, 60 cart writes, 10
//! checkouts. Without a cache, or when it fails, nothing is limited.
//!
//! The client is the `X-Forwarded-For` entry the ingress appended
//! (`TRUSTED_PROXIES` from the right); a private key may name the shopper's
//! own address in `X-Shopper-Ip`, since its server is the one connecting.

use std::sync::Arc;
use std::time::Duration;

use http::{HeaderMap, Method};
use weldsuite_ports::DynCache;

/// GET and HEAD requests per minute.
pub(crate) const READ_LIMIT: i64 = 120;
/// Cart writes per minute.
pub(crate) const WRITE_LIMIT: i64 = 60;
/// Checkouts per minute.
pub(crate) const CHECKOUT_LIMIT: i64 = 10;

const COUNTER_TTL: Duration = Duration::from_secs(120);

fn address_like(text: &str) -> bool {
    (2..=45).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || matches!(b, b'.' | b':'))
}

/// The address the ingress saw, or `unknown` (one shared counter).
pub(crate) fn proxy_client(headers: &HeaderMap, trusted_proxies: usize) -> String {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .filter(|ip| address_like(ip))
        .map_or_else(|| "unknown".to_owned(), |ip| (*ip).to_owned())
}

/// The client a private key's request is counted against.
pub(crate) fn shopper(headers: &HeaderMap, trusted_proxies: usize) -> String {
    headers
        .get("x-shopper-ip")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|ip| address_like(ip))
        .map_or_else(|| proxy_client(headers, trusted_proxies), str::to_owned)
}

/// Sign-in code requests per client address per channel, per 15 minutes.
pub(crate) const SIGN_IN_CODE_LIMIT: u32 = 20;

/// The client a sign-in code request is counted against: the browser's
/// address for a publishable key, the shopper's own (`X-Shopper-Ip`) for a
/// private key. None when it is not known (a private key's server sent no
/// shopper address, or no ingress put one in front), so that one shared
/// counter cannot lock a whole shop out of sign-in.
pub(crate) fn sign_in_client(
    headers: &HeaderMap,
    trusted_proxies: usize,
    publishable: bool,
) -> Option<String> {
    if publishable {
        Some(proxy_client(headers, trusted_proxies)).filter(|client| client != "unknown")
    } else {
        headers
            .get("x-shopper-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|ip| address_like(ip))
            .map(str::to_owned)
    }
}

/// The class of a request: the counter's name and its limit.
pub(crate) fn class(method: &Method, path: &str) -> (&'static str, i64) {
    if matches!(*method, Method::GET | Method::HEAD) {
        ("r", READ_LIMIT)
    } else if path.ends_with("/cart/checkout") {
        ("c", CHECKOUT_LIMIT)
    } else {
        ("w", WRITE_LIMIT)
    }
}

/// Count the request; the seconds to wait when it is over the limit.
pub(crate) async fn check(
    cache: Option<&Arc<dyn DynCache>>,
    key_hash: &str,
    client: &str,
    method: &Method,
    path: &str,
    now: i64,
) -> Option<u32> {
    let cache = cache?;
    let (name, limit) = class(method, path);
    let counter = format!("sfrl:{key_hash}:{client}:{name}:{}", now.div_euclid(60));
    match cache.increment_boxed(&counter, 1, Some(COUNTER_TTL)).await {
        Ok(count) if count > limit => Some(u32::try_from(60 - now.rem_euclid(60)).unwrap_or(60)),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(%error, "[storefront] rate limit counter failed");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;
    use weldsuite_ports::MemoryCache;

    use super::*;

    #[test]
    fn classes() {
        assert_eq!(class(&Method::GET, "/products").1, 120);
        assert_eq!(class(&Method::POST, "/cart/items").1, 60);
        assert_eq!(class(&Method::POST, "/cart/checkout").1, 10);
    }

    #[test]
    fn the_shopper_header_only_counts_when_it_is_an_address() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("9.9.9.9"));
        headers.insert("x-shopper-ip", HeaderValue::from_static("1.2.3.4"));
        assert_eq!(shopper(&headers, 1), "1.2.3.4");
        headers.insert("x-shopper-ip", HeaderValue::from_static("nonsense!"));
        assert_eq!(shopper(&headers, 1), "9.9.9.9");
    }

    #[test]
    fn the_sign_in_client_is_the_browser_or_the_named_shopper() {
        let mut headers = HeaderMap::new();
        assert_eq!(sign_in_client(&headers, 1, true), None);
        assert_eq!(sign_in_client(&headers, 1, false), None);
        headers.insert("x-forwarded-for", HeaderValue::from_static("9.9.9.9"));
        assert_eq!(
            sign_in_client(&headers, 1, true).as_deref(),
            Some("9.9.9.9")
        );
        // A private key's server address is not the shopper's.
        assert_eq!(sign_in_client(&headers, 1, false), None);
        headers.insert("x-shopper-ip", HeaderValue::from_static("1.2.3.4"));
        assert_eq!(
            sign_in_client(&headers, 1, false).as_deref(),
            Some("1.2.3.4")
        );
        // A browser cannot name another address.
        assert_eq!(
            sign_in_client(&headers, 1, true).as_deref(),
            Some("9.9.9.9")
        );
    }

    #[tokio::test]
    async fn over_the_limit_waits_for_the_next_minute() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::default());
        for _ in 0..10 {
            assert!(
                check(Some(&cache), "k", "ip", &Method::POST, "/cart/checkout", 75)
                    .await
                    .is_none()
            );
        }
        assert_eq!(
            check(Some(&cache), "k", "ip", &Method::POST, "/cart/checkout", 75).await,
            Some(45)
        );
    }
}
