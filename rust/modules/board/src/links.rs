//! What a link card shows (`services/unfurl.ts`): a page's title,
//! description, image and site name, read from its Open Graph and Twitter
//! tags (else its `<title>`).
//!
//! The page is fetched from the server, so the address someone pastes must
//! not reach anything private: only http(s) on the default ports, never a
//! private, loopback or link-local address or an internal host name, every
//! redirect checked again (at most three), five seconds and 256 KB of HTML at
//! most. On Kubernetes the server sits inside the cluster's network, so
//! [`PublicLinks`] also refuses a name that resolves to a private address
//! (on Global, Workers cannot reach one). Anything else gives an empty
//! preview, never an error, so a link card is still made.

use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use regex::Regex;
use serde_json::{Value, json};
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

use crate::{BoardState, Caller, answer, js_slice, validate};

const MAX_BYTES: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(5);
const USER_AGENT: &str = "WeldBoard-LinkPreview/1.0";

// ── POST /unfurl ────────────────────────────────────────────────────────────

/// A link card's preview. Never an error for a page that cannot be read: the
/// card just shows the address.
pub(crate) async fn unfurl_route(
    State(state): State<BoardState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let url = validate(&headers, &body, |issues, body| {
                issues
                    .text_with(
                        body,
                        "url",
                        Presence::Required,
                        Text {
                            format: Some(Format::Url),
                            ..Text::length(None, Some(2048))
                        },
                    )
                    .into_option()
                    .unwrap_or_default()
            })?;
            let preview = match caller.links(&state) {
                Some(http) => unfurl(&http, &url).await,
                None => empty(&url),
            };
            Ok(Data(preview).into_response())
        }
        .await,
    )
}

fn empty(url: &str) -> Value {
    json!({ "url": url, "title": null, "description": null, "image": null, "siteName": null })
}

/// Fetches the page (redirects checked one by one) and reads its preview (`unfurl`).
pub(crate) async fn unfurl(http: &OutboundHttp, raw: &str) -> Value {
    let mut url = raw.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        if !is_fetchable_url(&url) {
            return empty(raw);
        }
        let request = HttpRequest::empty("GET", url.clone())
            .header("Accept", "text/html,application/xhtml+xml")
            .header("User-Agent", USER_AGENT);
        let Ok(response) = http.send(request).await else {
            return empty(raw);
        };
        if (300..400).contains(&response.status) {
            let Some(next) = response.header("location") else {
                return empty(raw);
            };
            let Some(joined) = url::Url::parse(&url)
                .ok()
                .and_then(|base| base.join(next).ok())
            else {
                return empty(raw);
            };
            url = joined.to_string();
            continue;
        }
        let html_type = response
            .header("content-type")
            .is_some_and(|kind| kind.contains("html"));
        if !response.ok() || !html_type {
            return empty(raw);
        }
        let html = String::from_utf8_lossy(&response.body);
        let mut preview = read_preview(&html, &url);
        preview["url"] = json!(raw);
        return preview;
    }
    empty(raw)
}

/// Whether the address may be fetched from the server (`isFetchableUrl`).
pub(crate) fn is_fetchable_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" && url.scheme() != "http" {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.port().is_some_and(|port| port != 80 && port != 443) {
        return false;
    }
    let host = url
        .host_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    if host.is_empty() || !host.contains('.') || INTERNAL.is_match(&host) {
        return false;
    }
    !is_private_ipv4(&host) && !is_private_ipv6(&host)
}

fn is_private_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4
        || !parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let a: u32 = parts[0].parse().unwrap_or(0);
    let b: u32 = parts[1].parse().unwrap_or(0);
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 224
}

fn is_private_ipv6(host: &str) -> bool {
    if !host.contains(':') {
        return false;
    }
    let h = host.to_ascii_lowercase();
    h == "::"
        || h == "::1"
        || h.starts_with("fc")
        || h.starts_with("fd")
        || h.starts_with("fe80")
        || h.starts_with("::ffff:")
}

/// Host names that only exist inside a network.
static INTERNAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(^|\.)(localhost|local|internal|intranet|lan|home|corp)$").expect("pattern")
});

/// JavaScript's `\s`: Unicode white space plus the byte order mark.
const SPACE: &str = r"[\s\x{FEFF}]";

static META_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<meta\b[^>]*>").expect("pattern"));
static TITLE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("pattern"));
static ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&(#x[0-9a-f]+|#\d+|[a-z]+);").expect("pattern"));
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{SPACE}+")).expect("pattern"));

/// `(name)\s*=\s*("…"|'…'|bare)` for one attribute name.
fn attribute(name: &str) -> Regex {
    Regex::new(&format!(
        r#"(?i)\b{name}{SPACE}*={SPACE}*("([^"]*)"|'([^']*)'|([^\s>\x{{FEFF}}]+))"#
    ))
    .expect("pattern")
}

static PROPERTY: LazyLock<Regex> = LazyLock::new(|| attribute("property"));
static NAME: LazyLock<Regex> = LazyLock::new(|| attribute("name"));
static CONTENT: LazyLock<Regex> = LazyLock::new(|| attribute("content"));

/// The value an attribute pattern captured: double-quoted, single-quoted or bare.
fn captured(caps: &regex::Captures<'_>) -> String {
    caps.get(2)
        .or_else(|| caps.get(3))
        .or_else(|| caps.get(4))
        .map_or_else(String::new, |m| m.as_str().to_owned())
}

/// `decode`: the entities a tag's text may hold, white space collapsed.
fn decode(text: &str) -> String {
    let decoded = ENTITY.replace_all(text, |caps: &regex::Captures<'_>| {
        let whole = caps[0].to_owned();
        let code = &caps[1];
        if let Some(number) = code.strip_prefix('#') {
            let n = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok(),
                None => number.parse::<u32>().ok(),
            };
            return n
                .filter(|n| *n > 0 && *n < 0x0011_0000)
                .and_then(char::from_u32)
                .map_or(whole, String::from);
        }
        match code.to_ascii_lowercase().as_str() {
            "amp" => "&".to_owned(),
            "lt" => "<".to_owned(),
            "gt" => ">".to_owned(),
            "quot" => "\"".to_owned(),
            "apos" => "'".to_owned(),
            "nbsp" => " ".to_owned(),
            _ => whole,
        }
    });
    let collapsed = SPACES.replace_all(&decoded, " ");
    collapsed
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_owned()
}

/// The preview a page's HTML gives (`readPreview`).
pub(crate) fn read_preview(html: &str, page_url: &str) -> Value {
    let mut meta: Vec<(String, String)> = Vec::new();
    for tag in META_TAG.find_iter(html).map(|m| m.as_str()) {
        let key = PROPERTY.captures(tag).or_else(|| NAME.captures(tag));
        let content = CONTENT.captures(tag);
        let (Some(key), Some(content)) = (key, content) else {
            continue;
        };
        let k = captured(&key).to_lowercase();
        if !k.is_empty() && !meta.iter().any(|(seen, _)| *seen == k) {
            meta.push((k, decode(&captured(&content))));
        }
    }
    let pick = |keys: &[&str]| -> Option<String> {
        keys.iter().find_map(|key| {
            meta.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_empty())
        })
    };
    let title_tag = TITLE_TAG
        .captures(html)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_owned()));
    let image = pick(&[
        "og:image:secure_url",
        "og:image",
        "twitter:image",
        "twitter:image:src",
    ])
    .and_then(|raw| {
        let resolved = url::Url::parse(page_url).ok()?.join(&raw).ok()?;
        (resolved.scheme() == "https").then(|| js_slice(resolved.as_str(), 4096))
    });
    // `s ? s.slice(0, n) : null`: an empty text is no text.
    let clip =
        |text: Option<String>, n: usize| text.filter(|t| !t.is_empty()).map(|t| js_slice(&t, n));
    let title = pick(&["og:title", "twitter:title"])
        .or_else(|| title_tag.filter(|t| !t.is_empty()).map(|t| decode(&t)));
    let site = pick(&["og:site_name", "application-name"]).or_else(|| safe_host(page_url));
    json!({
        "title": clip(title, 500),
        "description": clip(pick(&["og:description", "twitter:description", "description"]), 2000),
        "image": image,
        "siteName": clip(site, 200),
    })
}

fn safe_host(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(host.strip_prefix("www.").unwrap_or(host).to_owned())
}

// ── the HTTP client ─────────────────────────────────────────────────────────

/// The client link previews are fetched with: public addresses only (a name
/// that resolves to a private address is refused), no redirects followed
/// (the route checks each hop), five seconds, and at most 256 KB of the page
/// read, stopping at the end of its `<head>`.
#[derive(Clone)]
pub struct PublicLinks {
    client: reqwest::Client,
}

impl std::fmt::Debug for PublicLinks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PublicLinks")
    }
}

impl PublicLinks {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .dns_resolver(Arc::new(PublicOnlyResolver))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self { client })
    }

    /// As an [`OutboundHttp`] for [`BoardState::links`].
    pub fn outbound(self) -> OutboundHttp {
        OutboundHttp(Arc::new(self))
    }
}

impl DynOutboundHttp for PublicLinks {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let parsed = reqwest::Url::parse(&request.url).map_err(PortError::backend)?;
            if literal_is_blocked(&parsed) {
                return Err(PortError::backend(BlockedAddress));
            }
            let mut call = self.client.get(parsed);
            for (name, value) in &request.headers {
                call = call.header(name.as_str(), value.as_str());
            }
            let mut response = call.send().await.map_err(PortError::backend)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_owned(), value.to_owned()))
                })
                .collect();
            // The tags are in <head>: stop at its end, or at the cap.
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(PortError::backend)? {
                body.extend_from_slice(&chunk);
                if body.len() >= MAX_BYTES || ends_head(&body) {
                    break;
                }
            }
            Ok(HttpResponse {
                status,
                body,
                headers,
            })
        })
    }
}

fn ends_head(body: &[u8]) -> bool {
    body.windows(7).any(|w| w.eq_ignore_ascii_case(b"</head>"))
}

/// Names that resolve only to non-public addresses are refused.
struct PublicOnlyResolver;

impl reqwest::dns::Resolve for PublicOnlyResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|address| is_public(address.ip()))
                .collect();
            if addresses.is_empty() {
                return Err(Box::new(BlockedAddress) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Debug)]
struct BlockedAddress;

impl std::fmt::Display for BlockedAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the address is private or reserved")
    }
}

impl std::error::Error for BlockedAddress {}

/// A globally routable address.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || first == 0x2001 && v6.segments()[1] == 0x0db8)
        }
    }
}

/// A URL whose host is an IP literal that is not public.
fn literal_is_blocked(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(v4)) => !is_public(IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => !is_public(IpAddr::V6(v6)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_web_addresses_are_fetched() {
        // services/unfurl.test.ts's cases.
        for ok in [
            "https://example.com/post",
            "http://news.example.org:80/a",
            "https://example.com:443/",
        ] {
            assert!(is_fetchable_url(ok), "{ok}");
        }
        for refused in [
            "ftp://example.com/",
            "https://user:pw@example.com/",
            "https://example.com:8080/",
            "http://localhost/",
            "http://printer.local/",
            "http://intranet/",
            "http://service.internal/",
            "http://127.0.0.1/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://172.20.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/",
            "http://0x7f.0.0.1/",
            "http://[::1]/",
            "not a url",
        ] {
            assert!(!is_fetchable_url(refused), "{refused}");
        }
    }

    #[test]
    fn previews_read_open_graph_then_the_title() {
        let html = r#"<html><head>
            <title>Fallback &amp; title</title>
            <meta property="og:title" content="The &quot;real&quot; title">
            <meta name='description' content='A   page
              about things'>
            <meta property="og:image" content="/img/card.png">
            <meta property="og:site_name" content=Example>
        </head></html>"#;
        let preview = read_preview(html, "https://www.example.com/post");
        assert_eq!(preview["title"], json!("The \"real\" title"));
        assert_eq!(preview["description"], json!("A page about things"));
        assert_eq!(
            preview["image"],
            json!("https://www.example.com/img/card.png")
        );
        assert_eq!(preview["siteName"], json!("Example"));

        let bare = read_preview(
            "<title> Only &#x41;&#66; </title>",
            "http://www.example.com/",
        );
        assert_eq!(bare["title"], json!("Only AB"));
        // An http image is not shown; the site name falls back to the host.
        assert_eq!(bare["image"], Value::Null);
        assert_eq!(bare["siteName"], json!("example.com"));
    }

    #[test]
    fn the_head_ends_the_read() {
        assert!(ends_head(b"<html><HEAD></Head>"));
        assert!(!ends_head(b"<html><head>"));
    }
}
