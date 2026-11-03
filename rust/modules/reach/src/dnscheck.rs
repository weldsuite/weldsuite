//! `lib/dns.ts`: the connect guard's footprint check (MX, A/AAAA on the apex
//! and `www`) and the DNS health of a connected domain, over
//! DNS-over-HTTPS. Every lookup failure is a [`DnsLookupError`]; a failed
//! lookup is never read as "no records".

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use weldsuite_ports::OutboundHttp;
use weldsuite_reach_domain::ReachError;
use weldsuite_reach_domain::dns::{DnsRecord, lookup_record};

/// `DnsLookupError`.
#[derive(Debug, Clone)]
pub(crate) struct DnsLookupError(pub(crate) String);

impl DnsLookupError {
    /// `mapReachError`: 503 `DNS_CHECK_FAILED`.
    pub(crate) fn into_reach(self) -> ReachError {
        tracing::error!(error = %self.0, "[reach] DNS_CHECK_FAILED");
        ReachError::new(
            503,
            "DNS_CHECK_FAILED",
            "DNS could not be checked right now. Try again in a moment.",
        )
    }
}

async fn safe_lookup(
    http: &OutboundHttp,
    name: &str,
    kind: &str,
) -> Result<Vec<DnsRecord>, DnsLookupError> {
    lookup_record(http, name, kind)
        .await
        .map_err(|error| DnsLookupError(format!("DNS lookup of {kind} {name} failed: {error}")))
}

fn strip_dot(value: &str) -> &str {
    value.strip_suffix('.').unwrap_or(value)
}

/// `checkDomainFootprint(domain)`: (has MX, has a website).
pub(crate) async fn footprint(
    http: &OutboundHttp,
    domain: &str,
) -> Result<(bool, bool), DnsLookupError> {
    let name = strip_dot(&domain.trim().to_lowercase()).to_owned();
    let www = format!("www.{name}");
    // `Promise.all`: every lookup is made, the first failure wins.
    let mx = safe_lookup(http, &name, "MX").await;
    let apex_a = safe_lookup(http, &name, "A").await;
    let apex_aaaa = safe_lookup(http, &name, "AAAA").await;
    let www_a = safe_lookup(http, &www, "A").await;
    let www_aaaa = safe_lookup(http, &www, "AAAA").await;
    let (mx, apex_a, apex_aaaa, www_a, www_aaaa) = (mx?, apex_a?, apex_aaaa?, www_a?, www_aaaa?);
    let website =
        !apex_a.is_empty() || !apex_aaaa.is_empty() || !www_a.is_empty() || !www_aaaa.is_empty();
    Ok((!mx.is_empty(), website))
}

fn normalise(value: &str) -> String {
    strip_dot(&value.trim().to_lowercase()).to_owned()
}

fn normalise_txt(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '"' && !weldsuite_reach_domain::text::is_js_space(*c))
        .collect::<String>()
        .to_lowercase()
}

/// `recordName(key, domain)`.
fn record_name(key: Option<&str>, domain: &str) -> String {
    let k = normalise(key.unwrap_or_default());
    let d = normalise(domain);
    if k.is_empty() || k == "@" {
        return d;
    }
    if k == d || k.ends_with(&format!(".{d}")) {
        return k;
    }
    format!("{k}.{d}")
}

static SPF_MECHANISM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^(include:|ip4:|ip6:|redirect=)").expect("spf mechanism"));
static SPF_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)^"?v=spf1"#).expect("spf"));
static SPF_LIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)^v=spf1").expect("spf live"));
static DMARC: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)v=dmarc1").expect("dmarc"));

fn spf_mechanisms(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .split(weldsuite_reach_domain::text::is_js_space)
        .filter(|token| SPF_MECHANISM.is_match(token))
        .map(str::to_owned)
        .collect()
}

/// `evaluateMailDns(input)`: `{ spf, dkim, dmarc, mx, checkedAt }`.
pub(crate) async fn evaluate(
    http: &OutboundHttp,
    domain: &str,
    expected: &[Value],
    checked_at: &str,
) -> Result<Value, DnsLookupError> {
    let domain = normalise(domain);
    let kind = |r: &Value| {
        r.get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let at = |r: &Value| record_name(r.get("key").and_then(Value::as_str), &domain);
    let value = |r: &Value| {
        r.get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let expected_mx: Vec<&Value> = expected
        .iter()
        .filter(|r| kind(r) == "MX" && at(r) == domain)
        .collect();
    let expected_spf = expected
        .iter()
        .find(|r| kind(r) == "TXT" && at(r) == domain && SPF_START.is_match(value(r).trim()));
    let expected_dkim: Vec<&Value> = expected
        .iter()
        .filter(|r| matches!(kind(r).as_str(), "TXT" | "CNAME") && at(r).contains("._domainkey."))
        .collect();
    let live_mx = safe_lookup(http, &domain, "MX").await;
    let live_apex_txt = safe_lookup(http, &domain, "TXT").await;
    let live_dmarc = safe_lookup(http, &format!("_dmarc.{domain}"), "TXT").await;
    let mut dkim_results = Vec::with_capacity(expected_dkim.len());
    for record in &expected_dkim {
        dkim_results.push(safe_lookup(http, &at(record), &kind(record)).await);
    }
    let (live_mx, live_apex_txt, live_dmarc) = (live_mx?, live_apex_txt?, live_dmarc?);
    let dkim_live = dkim_results.into_iter().collect::<Result<Vec<_>, _>>()?;
    let live_hosts: Vec<String> = live_mx.iter().map(|r| normalise(&r.value)).collect();
    let mx = if expected_mx.is_empty() {
        live_hosts.iter().any(|h| !h.is_empty())
    } else {
        expected_mx
            .iter()
            .all(|r| live_hosts.contains(&normalise(&value(r))))
    };
    let live_spf: Vec<&str> = live_apex_txt
        .iter()
        .map(|r| r.value.as_str())
        .filter(|v| SPF_LIVE.is_match(v.trim()))
        .collect();
    let spf = !live_spf.is_empty()
        && expected_spf.is_none_or(|expected| {
            let wanted = spf_mechanisms(&value(expected));
            live_spf.iter().any(|v| {
                let have = spf_mechanisms(v);
                wanted.iter().all(|m| have.contains(m))
            })
        });
    let dkim = !expected_dkim.is_empty()
        && expected_dkim.iter().enumerate().all(|(i, record)| {
            let txt = kind(record) == "TXT";
            let want = if txt {
                normalise_txt(&value(record))
            } else {
                normalise(&value(record))
            };
            dkim_live[i].iter().any(|a| {
                (if txt {
                    normalise_txt(&a.value)
                } else {
                    normalise(&a.value)
                }) == want
            })
        });
    let dmarc = live_dmarc.iter().any(|r| DMARC.is_match(&r.value));
    Ok(json!({ "spf": spf, "dkim": dkim, "dmarc": dmarc, "mx": mx, "checkedAt": checked_at }))
}
