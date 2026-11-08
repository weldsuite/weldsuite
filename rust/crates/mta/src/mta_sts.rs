//! MTA-STS (RFC 8461) as a sender: a destination that publishes
//! `_mta-sts.<domain>` TXT and a policy at
//! `https://mta-sts.<domain>/.well-known/mta-sts.txt` gets, in `enforce`
//! mode, only MX hosts its policy lists and only over TLS with a valid
//! certificate; in `testing` mode failures are only reported (TLS-RPT).
//!
//! Policies are cached in memory for their `max_age` (at most a year) and
//! refetched when the TXT record's `id` changes. A failed fetch falls back
//! to the cached policy, else to no policy (RFC 8461 §5.1), and is counted
//! for TLS-RPT.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use crate::dns::Resolver;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Enforce,
    Testing,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub mode: Mode,
    pub mx: Vec<String>,
    pub max_age: Duration,
    /// The policy's lines, for TLS-RPT's `policy-string`.
    pub lines: Vec<String>,
}

impl Policy {
    /// Whether `host` matches one of the policy's `mx` patterns
    /// (`*.example.net` matches exactly one leftmost label).
    pub fn allows(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.mx.iter().any(|pattern| {
            let pattern = pattern.trim_end_matches('.').to_ascii_lowercase();
            match pattern.strip_prefix("*.") {
                Some(suffix) => host
                    .split_once('.')
                    .is_some_and(|(label, rest)| !label.is_empty() && rest == suffix),
                None => host == pattern,
            }
        })
    }
}

/// Parses a policy body; `None` when it is not a valid `STSv1` policy.
pub fn parse_policy(text: &str) -> Option<Policy> {
    let mut version = None;
    let mut mode = None;
    let mut mx = Vec::new();
    let mut max_age = None;
    let mut lines = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        lines.push(line.to_owned());
        let (key, value) = line.split_once(':')?;
        let value = value.trim();
        match key.trim() {
            "version" => version = Some(value.to_owned()),
            "mode" => {
                mode = Some(match value {
                    "enforce" => Mode::Enforce,
                    "testing" => Mode::Testing,
                    "none" => Mode::None,
                    _ => return None,
                });
            }
            "mx" => mx.push(value.to_owned()),
            "max_age" => max_age = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    if version.as_deref() != Some("STSv1") {
        return None;
    }
    let mode = mode?;
    let max_age = Duration::from_secs(max_age?.min(31_557_600));
    if mode != Mode::None && mx.is_empty() {
        return None;
    }
    Some(Policy {
        mode,
        mx,
        max_age,
        lines,
    })
}

/// The `id` of an `_mta-sts` TXT record set (exactly one `v=STSv1`).
pub fn record_id(records: &[String]) -> Option<String> {
    let sts: Vec<&String> = records
        .iter()
        .filter(|r| r.trim_start().starts_with("v=STSv1"))
        .collect();
    if sts.len() != 1 {
        return None;
    }
    sts[0].split(';').find_map(|field| {
        let (key, value) = field.split_once('=')?;
        (key.trim() == "id")
            .then(|| value.trim().to_owned())
            .filter(|id| {
                !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric())
            })
    })
}

/// What delivery should do for a domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    NoPolicy,
    Policy(Arc<Policy>),
    /// A record exists but no policy could be fetched (counted as a failure;
    /// delivery goes on without one).
    FetchFailed,
}

type Cached = (Instant, String, Arc<Policy>);

/// The policy cache and fetcher.
#[derive(Debug)]
pub struct Sts {
    resolver: Arc<Resolver>,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, Cached>>,
}

const MAX_POLICY_BYTES: usize = 64 * 1024;

impl Sts {
    pub fn new(resolver: Arc<Resolver>) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .user_agent("weldsuite-mta")
            .build()?;
        Ok(Self {
            resolver,
            http,
            cache: Mutex::new(HashMap::new()),
        })
    }

    fn cached(&self, domain: &str) -> Option<(String, Arc<Policy>)> {
        let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get(domain)
            .filter(|(expires, _, _)| *expires > Instant::now())
            .map(|(_, id, policy)| (id.clone(), Arc::clone(policy)))
    }

    pub async fn lookup(&self, domain: &str) -> Lookup {
        let domain = domain.to_ascii_lowercase();
        let cached = self.cached(&domain);
        let Ok(records) = self.resolver.txt(&format!("_mta-sts.{domain}")).await else {
            // DNS trouble: whatever we had.
            return cached.map_or(Lookup::NoPolicy, |(_, p)| Lookup::Policy(p));
        };
        let Some(id) = record_id(&records) else {
            // No record: a cached policy still applies until it expires.
            return cached.map_or(Lookup::NoPolicy, |(_, p)| Lookup::Policy(p));
        };
        if let Some((cached_id, policy)) = &cached
            && *cached_id == id
        {
            return Lookup::Policy(Arc::clone(policy));
        }
        match self.fetch(&domain).await {
            Some(policy) => {
                let policy = Arc::new(policy);
                let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
                if cache.len() > 50_000 {
                    cache.clear();
                }
                cache.insert(
                    domain,
                    (Instant::now() + policy.max_age, id, Arc::clone(&policy)),
                );
                Lookup::Policy(policy)
            }
            None => cached.map_or(Lookup::FetchFailed, |(_, p)| Lookup::Policy(p)),
        }
    }

    async fn fetch(&self, domain: &str) -> Option<Policy> {
        let url = format!("https://mta-sts.{domain}/.well-known/mta-sts.txt");
        let response = self.http.get(&url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        let is_text = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/plain"));
        if !is_text {
            return None;
        }
        let body = response.bytes().await.ok()?;
        if body.len() > MAX_POLICY_BYTES {
            return None;
        }
        parse_policy(&String::from_utf8_lossy(&body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_policies() {
        let policy = parse_policy(
            "version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmx: *.example.net\r\nmax_age: 604800\r\n",
        )
        .expect("policy");
        assert_eq!(policy.mode, Mode::Enforce);
        assert_eq!(policy.max_age, Duration::from_hours(7 * 24));
        assert_eq!(policy.lines.len(), 5);
        assert!(policy.allows("mail.example.com."));
        assert!(policy.allows("mx1.example.net"));
        assert!(!policy.allows("a.b.example.net"));
        assert!(!policy.allows("example.net"));
        assert!(!policy.allows("evil.example.com"));
        assert!(parse_policy("version: STSv2\nmode: enforce\nmx: a\nmax_age: 1\n").is_none());
        assert!(parse_policy("version: STSv1\nmode: enforce\nmax_age: 1\n").is_none());
        assert!(parse_policy("version: STSv1\nmode: none\nmax_age: 1\n").is_some());
        assert!(parse_policy("version: STSv1\nmode: strict\nmx: a\nmax_age: 1\n").is_none());
    }

    #[test]
    fn reads_the_record_id() {
        assert_eq!(
            record_id(&["v=STSv1; id=20261107".into()]),
            Some("20261107".into())
        );
        assert_eq!(record_id(&["v=spf1 -all".into()]), None);
        assert_eq!(
            record_id(&["v=STSv1; id=1".into(), "v=STSv1; id=2".into()]),
            None
        );
        assert_eq!(record_id(&["v=STSv1; id=bad-id".into()]), None);
    }
}
