//! `@weldsuite/worker-kit/dns-lookup`: DNS over HTTPS through Cloudflare's
//! public resolver (`https://cloudflare-dns.com/dns-query`), for the
//! ownership TXT record and the record scan before a nameserver cutover.

use std::sync::LazyLock;

use futures_util::future::join_all;
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::js::{encode_uri_component, number_json, number_of};

const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";

static WHITESPACE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("the whitespace pattern compiles"));
static TXT_CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""((?:[^"\\]|\\.)*)""#).expect("the chunk pattern compiles"));

fn type_code(kind: &str) -> f64 {
    match kind {
        "A" => 1.0,
        "NS" => 2.0,
        "CNAME" => 5.0,
        "MX" => 15.0,
        "TXT" => 16.0,
        "AAAA" => 28.0,
        "SRV" => 33.0,
        _ => 257.0,
    }
}

/// `parseTxtData`: the quoted chunks joined, or the data as it is.
fn parse_txt(raw: &str) -> String {
    let chunks: Vec<String> = TXT_CHUNK
        .find_iter(raw)
        .map(|m| {
            let chunk = m.as_str();
            chunk[1..chunk.len() - 1].to_owned()
        })
        .collect();
    if chunks.is_empty() {
        raw.to_owned()
    } else {
        chunks.concat()
    }
}

fn strip_dot(text: &str) -> &str {
    text.strip_suffix('.').unwrap_or(text)
}

/// `Number(x)` with a non-finite value read as 0.
fn priority_of(text: Option<&str>) -> Value {
    number_json(text.and_then(number_of).unwrap_or(0.0))
}

/// `lookupRecord(name, type)`: the records of one type, `Err` when the
/// resolver answers with an error or not JSON.
pub(crate) async fn lookup_record(
    http: &OutboundHttp,
    name: &str,
    kind: &str,
) -> Result<Vec<Value>, String> {
    let url = format!("{DOH_ENDPOINT}?name={}&type={kind}", encode_uri_component(name));
    let response = http
        .send(HttpRequest::empty("GET", url).header("accept", "application/dns-json"))
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!("DNS lookup failed with status {}", response.status));
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let Some(answers) = body.get("Answer").filter(|a| crate::js::truthy(Some(a))) else {
        return Ok(Vec::new());
    };
    let want = type_code(kind);
    let mut out = Vec::new();
    for answer in answers.as_array().map(Vec::as_slice).unwrap_or_default() {
        if answer.get("type").and_then(Value::as_f64) != Some(want) {
            continue;
        }
        let raw_name = answer.get("name").map(crate::js::as_text).unwrap_or_default();
        let data = answer.get("data").map(crate::js::as_text).unwrap_or_default();
        let mut record = Map::new();
        record.insert("name".to_owned(), json!(strip_dot(&raw_name)));
        record.insert("type".to_owned(), json!(kind));
        match kind {
            "TXT" => {
                record.insert("value".to_owned(), json!(parse_txt(&data)));
            }
            "MX" => {
                let parts: Vec<&str> = WHITESPACE.split(&data).take(2).collect();
                let target = parts.get(1).copied().unwrap_or_default();
                record.insert("value".to_owned(), json!(strip_dot(target)));
                record.insert("priority".to_owned(), priority_of(parts.first().copied()));
            }
            "SRV" => {
                let parts: Vec<&str> = WHITESPACE.split(&data).collect();
                let rest = parts.get(1..).map(|p| p.join(" ")).unwrap_or_default();
                record.insert("value".to_owned(), json!(strip_dot(&rest)));
                record.insert("priority".to_owned(), priority_of(parts.first().copied()));
            }
            "CNAME" | "NS" => {
                record.insert("value".to_owned(), json!(strip_dot(&data)));
            }
            _ => {
                record.insert("value".to_owned(), json!(data));
            }
        }
        if let Some(ttl) = answer.get("TTL") {
            record.insert("ttl".to_owned(), ttl.clone());
        }
        out.push(Value::Object(record));
    }
    Ok(out)
}

/// `lookupTxt(name)`.
pub(crate) async fn lookup_txt(http: &OutboundHttp, name: &str) -> Result<Vec<String>, String> {
    Ok(lookup_record(http, name, "TXT")
        .await?
        .iter()
        .map(|r| r["value"].as_str().unwrap_or_default().to_owned())
        .collect())
}

/// `scanDomainRecords(domain)`: the apex, common subdomains and mail
/// probes; failed lookups are left out.
pub(crate) async fn scan_domain_records(http: &OutboundHttp, domain: &str) -> Vec<Value> {
    let mut jobs: Vec<(String, &str)> = Vec::new();
    for kind in ["A", "AAAA", "MX", "TXT", "CAA", "NS"] {
        jobs.push((domain.to_owned(), kind));
    }
    for sub in [
        "www",
        "mail",
        "smtp",
        "imap",
        "pop",
        "webmail",
        "autodiscover",
        "autoconfig",
        "ftp",
        "api",
        "app",
        "admin",
        "blog",
        "shop",
        "cpanel",
    ] {
        for kind in ["A", "AAAA", "CNAME"] {
            jobs.push((format!("{sub}.{domain}"), kind));
        }
    }
    for probe in [
        "_dmarc",
        "default._domainkey",
        "selector1._domainkey",
        "selector2._domainkey",
        "google._domainkey",
    ] {
        jobs.push((format!("{probe}.{domain}"), "TXT"));
    }
    let results = join_all(
        jobs.iter()
            .map(|(name, kind)| lookup_record(http, name, kind)),
    )
    .await;
    results.into_iter().filter_map(Result::ok).flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_chunks_join() {
        assert_eq!(parse_txt("\"v=spf1 \" \"-all\""), "v=spf1 -all");
        assert_eq!(parse_txt("plain"), "plain");
    }
}
