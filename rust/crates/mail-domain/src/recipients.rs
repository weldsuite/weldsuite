//! Recipient validation for outbound mail (`./recipient-validation`): Zod's
//! `.email()` format check, then an MX (or A) lookup per domain over
//! DNS-over-HTTPS, cached in `WORKSPACE_CACHE` under `mx:<domain>` (a day
//! when reachable, an hour when not).

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_ports::{BoxFuture, DynCache};

/// `DOH_ENDPOINT`.
pub const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";

/// One DNS-over-HTTPS GET (`Accept: application/dns-json`): status and body,
/// or an error for a request that failed outright (or timed out after 3 s).
pub trait DnsOverHttps: Send + Sync {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>>;
}

/// `z.string().email().safeParse(address).success`.
pub fn is_email(address: &str) -> bool {
    let mut body = Map::new();
    body.insert("e".to_owned(), Value::from(address));
    let mut issues = Issues::default();
    issues.text_with(
        &body,
        "e",
        Presence::Required,
        Text {
            format: Some(Format::Email),
            ..Text::length(None, None)
        },
    );
    issues.is_empty()
}

/// `extractDomains(addresses)`: the lower-cased domains of the valid ones,
/// first seen first.
pub fn extract_domains(addresses: &[String]) -> Vec<String> {
    let mut domains: Vec<String> = Vec::new();
    for address in addresses.iter().filter(|a| is_email(a)) {
        let Some(at) = address.rfind('@') else {
            continue;
        };
        let domain = crate::text::js_trim(&address[at + 1..].to_lowercase()).to_owned();
        if !domain.is_empty() && !domains.contains(&domain) {
            domains.push(domain);
        }
    }
    domains
}

/// JavaScript's `encodeURIComponent`.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

async fn doh_query(doh: &dyn DnsOverHttps, domain: &str, kind: &str) -> bool {
    let url = format!(
        "{DOH_ENDPOINT}?name={}&type={kind}",
        encode_component(domain)
    );
    let Ok((status, body)) = doh.get(&url).await else {
        return false;
    };
    if !(200..300).contains(&status) {
        return false;
    }
    let Ok(json) = serde_json::from_str::<Value>(&body) else {
        return false;
    };
    json.get("Status").and_then(Value::as_i64) == Some(0)
        && json
            .get("Answer")
            .and_then(Value::as_array)
            .is_some_and(|answers| !answers.is_empty())
}

/// What an MX lookup reads.
#[derive(Clone, Default)]
pub struct MxLookup {
    pub cache: Option<Arc<dyn DynCache>>,
    pub doh: Option<Arc<dyn DnsOverHttps>>,
}

impl MxLookup {
    /// `lookupMx(domain, env)`.
    pub async fn reachable(&self, domain: &str) -> bool {
        let key = format!("mx:{domain}");
        if let Some(cache) = &self.cache {
            match cache.get_boxed(&key).await {
                Ok(Some(value)) if value == "1" => return true,
                Ok(Some(value)) if value == "0" => return false,
                _ => {}
            }
        }
        let reachable = match &self.doh {
            Some(doh) => {
                doh_query(doh.as_ref(), domain, "MX").await
                    || doh_query(doh.as_ref(), domain, "A").await
            }
            None => false,
        };
        if let Some(cache) = &self.cache {
            let ttl = if reachable {
                Duration::from_hours(24)
            } else {
                Duration::from_hours(1)
            };
            let _ = cache
                .put_boxed(&key, if reachable { "1" } else { "0" }, Some(ttl))
                .await;
        }
        reachable
    }
}

/// `RecipientValidationResult` when not ok.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRecipients {
    pub invalid_format: Vec<String>,
    pub unreachable_domains: Vec<String>,
}

/// `validateRecipients(to, cc, bcc, env)`.
pub async fn validate_recipients(
    lookup: &MxLookup,
    to: &[String],
    cc: &[String],
    bcc: &[String],
) -> Result<(), InvalidRecipients> {
    let all: Vec<String> = to.iter().chain(cc).chain(bcc).cloned().collect();
    let invalid_format: Vec<String> = all.iter().filter(|a| !is_email(a)).cloned().collect();
    let valid: Vec<String> = all.iter().filter(|a| is_email(a)).cloned().collect();
    let mut unreachable_domains = Vec::new();
    for domain in extract_domains(&valid) {
        if !lookup.reachable(&domain).await {
            unreachable_domains.push(domain);
        }
    }
    if invalid_format.is_empty() && unreachable_domains.is_empty() {
        Ok(())
    } else {
        Err(InvalidRecipients {
            invalid_format,
            unreachable_domains,
        })
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::MemoryCache;

    use super::*;

    #[test]
    fn formats_and_domains() {
        assert!(is_email("anna@acme.com"));
        assert!(!is_email("anna@"));
        assert!(!is_email("Anna <anna@acme.com>"));
        assert_eq!(
            extract_domains(&["a@X.com".to_owned(), "b@x.com".to_owned(), "bad".to_owned()]),
            ["x.com"]
        );
        assert_eq!(encode_component("a b/é"), "a%20b%2F%C3%A9");
    }

    #[tokio::test]
    async fn the_cache_answers_first() {
        let cache = Arc::new(MemoryCache::new());
        cache
            .put_boxed("mx:x.com", "1", None)
            .await
            .expect("seeded");
        let lookup = MxLookup {
            cache: Some(cache.clone()),
            doh: None,
        };
        assert!(
            validate_recipients(&lookup, &["a@x.com".to_owned()], &[], &[])
                .await
                .is_ok()
        );
        let refused = validate_recipients(
            &lookup,
            &["a@y.com".to_owned(), "nope".to_owned()],
            &[],
            &[],
        )
        .await
        .expect_err("refused");
        assert_eq!(refused.invalid_format, ["nope"]);
        assert_eq!(refused.unreachable_domains, ["y.com"]);
        assert_eq!(
            cache
                .get_boxed("mx:y.com")
                .await
                .expect("cached")
                .as_deref(),
            Some("0")
        );
    }
}
