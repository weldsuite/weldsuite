//! `@weldsuite/worker-kit/dns-lookup`'s `lookupRecord`: DNS over HTTPS at
//! Cloudflare's resolver, through the outbound HTTP port (the same URL and
//! answer parsing, so conformance compares the calls).

use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use weldsuite_ports::{HttpRequest, OutboundHttp};

/// `DOH_ENDPOINT`.
pub const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";

/// One answer (`DnsRecord`).
#[derive(Debug, Clone, PartialEq)]
pub struct DnsRecord {
    pub name: String,
    pub kind: String,
    pub value: String,
    pub ttl: i64,
    pub priority: Option<f64>,
}

fn type_code(kind: &str) -> i64 {
    match kind {
        "A" => 1,
        "NS" => 2,
        "CNAME" => 5,
        "MX" => 15,
        "TXT" => 16,
        "AAAA" => 28,
        "SRV" => 33,
        "CAA" => 257,
        _ => 0,
    }
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

static TXT_CHUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""((?:[^"\\]|\\.)*)""#).expect("txt"));

fn parse_txt_data(raw: &str) -> String {
    let chunks: Vec<&str> = TXT_CHUNK.find_iter(raw).map(|m| m.as_str()).collect();
    if chunks.is_empty() {
        return raw.to_owned();
    }
    chunks.iter().map(|c| &c[1..c.len() - 1]).collect()
}

fn strip_dot(value: &str) -> String {
    value.strip_suffix('.').unwrap_or(value).to_owned()
}

/// `lookupRecord(name, type)`: the answers of that type; an error for a
/// failed request or answer.
pub async fn lookup_record(http: &OutboundHttp, name: &str, kind: &str) -> Result<Vec<DnsRecord>, String> {
    let url = format!("{DOH_ENDPOINT}?name={}&type={kind}", encode_uri_component(name));
    let request = HttpRequest {
        method: "GET".to_owned(),
        url,
        headers: vec![("Accept".to_owned(), "application/dns-json".to_owned())],
        body: None,
    };
    let response = http.send(request).await.map_err(|error| error.to_string())?;
    if !(200..300).contains(&response.status) {
        return Err(format!("DNS lookup failed with status {}", response.status));
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let Some(answers) = body.get("Answer").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let want = type_code(kind);
    let mut out = Vec::new();
    for answer in answers {
        if answer.get("type").and_then(Value::as_i64) != Some(want) {
            continue;
        }
        let raw_name = answer.get("name").and_then(Value::as_str).unwrap_or_default();
        let data = answer.get("data").and_then(Value::as_str).unwrap_or_default();
        let ttl = answer.get("TTL").and_then(Value::as_i64).unwrap_or_default();
        let name = strip_dot(raw_name);
        let (value, priority) = match kind {
            "TXT" => (parse_txt_data(data), None),
            "MX" => {
                let mut parts = data.split(crate::text::is_js_space).filter(|p| !p.is_empty());
                let prio = parts.next().unwrap_or_default();
                let target = parts.next().unwrap_or_default();
                let priority = prio.parse::<f64>().ok().filter(|p| p.is_finite()).unwrap_or(0.0);
                (strip_dot(target), Some(priority))
            }
            "SRV" => {
                let parts: Vec<&str> = data.split(crate::text::is_js_space).collect();
                let priority = parts.first().and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0);
                (strip_dot(&parts[1.min(parts.len())..].join(" ")), Some(priority))
            }
            "CNAME" | "NS" => (strip_dot(data), None),
            _ => (data.to_owned(), None),
        };
        out.push(DnsRecord {
            name,
            kind: kind.to_owned(),
            value,
            ttl,
            priority,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_chunks_join() {
        assert_eq!(parse_txt_data("\"v=spf1 \" \"-all\""), "v=spf1 -all");
        assert_eq!(parse_txt_data("plain"), "plain");
        assert_eq!(encode_uri_component("a b.com"), "a%20b.com");
    }
}
