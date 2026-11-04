//! The enrichment actions an enrichment column runs per lead, by its type
//! (`packages/domains/data/src/enrichment/actions`): `ai` (stubbed, as AI
//! is on the worker), `email_finder` (Findymail or Prospeo, through the
//! [`OutboundHttp`] port) and `phone_finder` (the number a company lists on
//! its own website, read through [`WebPages`]).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

use crate::js::{is_js_space, js_lowercase, js_string, js_trim};

/// What an action found for one lead.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ActionResult {
    /// The text in the grid cell.
    pub(crate) value: String,
    pub(crate) data: Option<Value>,
    pub(crate) credits_used: Option<i64>,
}

impl ActionResult {
    fn of(value: impl Into<String>, data: Value) -> Self {
        Self {
            value: value.into(),
            data: Some(data),
            credits_used: None,
        }
    }
}

/// The keys the actions read (`ActionEnv`).
#[derive(Debug, Clone, Default)]
pub struct ActionKeys {
    pub findymail_api_key: Option<String>,
    pub prospeo_api_key: Option<String>,
}

/// What an action runs with.
pub(crate) struct ActionContext<'a> {
    pub(crate) keys: &'a ActionKeys,
    pub(crate) http: &'a OutboundHttp,
    pub(crate) pages: &'a dyn WebPages,
    /// The column's `config` (`null` read as `{}`).
    pub(crate) config: &'a Value,
    /// The lead row, as Drizzle returns it (camelCase).
    pub(crate) lead: &'a Value,
    /// Other columns' done values for this lead, by lowercased name.
    pub(crate) siblings: &'a HashMap<String, String>,
}

impl ActionContext<'_> {
    fn lead_text(&self, key: &str) -> Option<&str> {
        self.lead.get(key).and_then(Value::as_str)
    }

    fn config_value(&self, key: &str) -> Option<&Value> {
        self.config.get(key).filter(|value| !value.is_null())
    }
}

/// The action types there are (`getAction(type)`).
pub(crate) fn known_action(kind: &str) -> bool {
    matches!(kind, "ai" | "email_finder" | "phone_finder")
}

/// Run the action of `kind`; `Err` with the message the cell shows.
pub(crate) async fn run_action(
    kind: &str,
    ctx: &ActionContext<'_>,
) -> Result<ActionResult, String> {
    match kind {
        "ai" => Ok(ai(ctx)),
        "email_finder" => email_finder(ctx).await,
        "phone_finder" => phone_finder(ctx).await,
        other => Err(format!("Unknown action type: {other}")),
    }
}

// ── template ────────────────────────────────────────────────────────────────

const BASE_FIELDS: [&str; 10] = [
    "name",
    "email",
    "title",
    "companyName",
    "domain",
    "industry",
    "location",
    "country",
    "companySize",
    "linkedinUrl",
];

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{([^{}]+)\}\}").expect("token pattern"));

/// `resolveTemplate(template, lead, siblingValues)`: `{{token}}` from the
/// lead's fields, its raw data's plain values, then other columns' values;
/// unknown tokens are empty.
pub(crate) fn resolve_template(
    template: &str,
    lead: &Value,
    siblings: &HashMap<String, String>,
) -> String {
    let mut lookup: HashMap<String, String> = HashMap::new();
    for field in BASE_FIELDS {
        if let Some(value) = lead.get(field).filter(|value| !value.is_null()) {
            lookup.insert(js_lowercase(field), js_string(value));
        }
    }
    if let Some(Value::Object(data)) = lead.get("data") {
        for (key, value) in data {
            if matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                lookup.insert(js_lowercase(key), js_string(value));
            }
        }
    }
    for (name, value) in siblings {
        lookup.insert(js_lowercase(name), value.clone());
    }
    TOKEN
        .replace_all(template, |captures: &regex::Captures<'_>| {
            let token = js_lowercase(js_trim(&captures[1]));
            lookup.get(&token).cloned().unwrap_or_default()
        })
        .into_owned()
}

// ── ai ──────────────────────────────────────────────────────────────────────

/// The `ai` action, stubbed: AI is not available, so the cell is done and
/// empty (`aiAction`).
fn ai(ctx: &ActionContext<'_>) -> ActionResult {
    let prompt = ctx
        .config_value("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let resolved = resolve_template(prompt, ctx.lead, ctx.siblings);
    tracing::warn!(
        lead = ctx.lead_text("id").unwrap_or_default(),
        "[ai] AI is currently unavailable — skipping AI enrichment column for lead"
    );
    ActionResult::of(
        "",
        json!({ "unavailable": true, "promptResolved": !js_trim(&resolved).is_empty() }),
    )
}

// ── email finder ────────────────────────────────────────────────────────────

/// `cleanDomain(domain)`: no scheme, nothing from the first slash, trimmed.
fn clean_domain(domain: Option<&str>) -> String {
    let domain = domain.unwrap_or_default();
    let domain = domain
        .strip_prefix("https://")
        .or_else(|| domain.strip_prefix("http://"))
        .unwrap_or(domain);
    let domain = domain.split_once('/').map_or(domain, |(host, _)| host);
    js_trim(domain).to_owned()
}

/// The first email-looking text, case-insensitively (`EMAIL_RE`; the
/// worker's lookbehind never changes the leftmost match).
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}").expect("email pattern")
});

/// `extractEmail(payload)`: a known field first, else the first email in
/// the payload's text (`raw`, the body as it came, in its own key order).
fn extract_email(payload: &Value, raw: &str) -> Option<String> {
    match payload {
        Value::String(text) => EMAIL.find(text).map(|m| m.as_str().to_owned()),
        Value::Object(map) => {
            for key in ["email", "work_email", "professional_email"] {
                if let Some(Value::String(email)) = map.get(key)
                    && EMAIL.is_match(email)
                {
                    return Some(email.clone());
                }
            }
            EMAIL.find(raw).map(|m| m.as_str().to_owned())
        }
        Value::Array(_) => EMAIL.find(raw).map(|m| m.as_str().to_owned()),
        _ => None,
    }
}

/// `text.slice(0, end)` in UTF-16 units.
fn slice_utf16(text: &str, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

/// One email-finder call: `(url, headers, body)` → the cell.
async fn find_email(
    ctx: &ActionContext<'_>,
    provider: &str,
    request: HttpRequest,
) -> Result<ActionResult, String> {
    let label = if provider == "prospeo" {
        "Prospeo"
    } else {
        "Findymail"
    };
    let response = ctx
        .http
        .send(request)
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!(
            "{label} HTTP {}: {}",
            response.status,
            slice_utf16(&response.text(), 200)
        ));
    }
    let raw = response.text();
    let payload = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
    let raw = if payload == json!({}) {
        "{}".to_owned()
    } else {
        raw
    };
    let email = extract_email(&payload, &raw);
    Ok(ActionResult::of(
        email.clone().unwrap_or_default(),
        json!({ "provider": provider, "found": email.is_some() }),
    ))
}

/// The `email_finder` action: the lead's work email from their name and
/// company domain.
async fn email_finder(ctx: &ActionContext<'_>) -> Result<ActionResult, String> {
    let provider = ctx
        .config_value("provider")
        .and_then(Value::as_str)
        .unwrap_or("findymail");
    let name = js_trim(ctx.lead_text("name").unwrap_or_default()).to_owned();
    let domain = clean_domain(ctx.lead_text("domain"));
    if name.is_empty() {
        return Err("No contact name on this lead to look up".to_owned());
    }
    if domain.is_empty() {
        return Err("No company domain on this lead to find an email against".to_owned());
    }
    if provider == "prospeo" {
        let Some(key) = ctx
            .keys
            .prospeo_api_key
            .as_deref()
            .filter(|k| !k.is_empty())
        else {
            return Err("Prospeo is not configured (missing PROSPEO_API_KEY)".to_owned());
        };
        let request = HttpRequest::json(
            "POST",
            "https://api.prospeo.io/email-finder",
            &json!({ "full_name": name, "company": domain }),
        )
        .header("X-KEY", key);
        return find_email(ctx, "prospeo", request).await;
    }
    let Some(key) = ctx
        .keys
        .findymail_api_key
        .as_deref()
        .filter(|k| !k.is_empty())
    else {
        return Err("Findymail is not configured (missing FINDYMAIL_API_KEY)".to_owned());
    };
    let request = HttpRequest::json(
        "POST",
        "https://app.findymail.com/api/search/name",
        &json!({ "name": name, "domain": domain }),
    )
    .header("Authorization", format!("Bearer {key}"))
    .header("Accept", "application/json");
    find_email(ctx, "findymail", request).await
}

// ── phone finder ────────────────────────────────────────────────────────────

/// The pages read, in order: the home page, then the usual contact pages.
const CANDIDATE_PATHS: [&str; 3] = ["", "contact", "contact-us"];
/// One page's time limit.
const FETCH_TIMEOUT: Duration = Duration::from_secs(4);
/// The whole website pass's.
const SCRAPE_DEADLINE: Duration = Duration::from_secs(10);
/// The HTML scanned, in UTF-16 units.
const MAX_HTML_UNITS: usize = 600_000;

/// JavaScript's `\s`, as a character class body.
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

static TEL_HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "[hH][rR][eE][fF][{JS_SPACE}]*=[{JS_SPACE}]*[\"'][tT][eE][lL]:([^\"']+)[\"']"
    ))
    .expect("tel pattern")
});

/// Conservative text forms: international, and a parenthesised area code.
static PHONE_TEXT: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        Regex::new(&format!(
            r"(?:\+|00)[0-9][0-9{JS_SPACE}().\-–]{{6,16}}[0-9]"
        ))
        .expect("international pattern"),
        Regex::new(&format!(
            r"\([0-9]{{2,5}}\)[{JS_SPACE}.-]?[0-9][0-9{JS_SPACE}.-]{{5,14}}[0-9]"
        ))
        .expect("area code pattern"),
    ]
});

/// `cleanDomain(domain)` of the phone finder: also lowercased.
fn clean_host(domain: Option<&str>) -> String {
    js_lowercase(&clean_domain(domain))
}

/// `normalizePhone(raw)`: digits, `+()-.` and spaces only, single-spaced.
fn normalize_phone(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| {
            c.is_ascii_digit() || matches!(c, '+' | '(' | ')' | '-' | '.') || is_js_space(*c)
        })
        .collect();
    let mut out = String::with_capacity(kept.len());
    let mut space = false;
    for c in kept.chars() {
        if is_js_space(c) {
            space = true;
        } else {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    if space {
        out.push(' ');
    }
    js_trim(&out).to_owned()
}

/// 7 to 15 digits (E.164).
fn is_plausible_phone(text: &str) -> bool {
    let digits = text.chars().filter(char::is_ascii_digit).count();
    (7..=15).contains(&digits)
}

/// `decodeURIComponent(text)`; `Err` (`URIError`) on a malformed escape.
fn decode_uri_component(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| "URI malformed".to_owned())?;
            out.push(hex);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "URI malformed".to_owned())
}

/// `tagsToSpaces(html)`: every `<…>` tag a space; a bare `<>` stays.
pub(crate) fn tags_to_spaces(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    let mut from = 0;
    while let Some(lt) = html[from..].find('<').map(|i| i + from) {
        let Some(gt) = html[lt + 1..].find('>').map(|i| i + lt + 1) else {
            break;
        };
        from = gt + 1;
        if gt == lt + 1 {
            continue;
        }
        out.push_str(&html[pos..lt]);
        out.push(' ');
        pos = gt + 1;
    }
    out.push_str(&html[pos..]);
    out
}

/// `extractPhone(html)`: a `tel:` link first, then the text forms.
fn extract_phone(html: &str) -> Result<Option<String>, String> {
    for captures in TEL_HREF.captures_iter(html) {
        let candidate = normalize_phone(&decode_uri_component(&captures[1])?);
        if is_plausible_phone(&candidate) {
            return Ok(Some(candidate));
        }
    }
    let text = tags_to_spaces(html);
    for pattern in PHONE_TEXT.iter() {
        for found in pattern.find_iter(&text) {
            let candidate = normalize_phone(found.as_str());
            if is_plausible_phone(&candidate) {
                return Ok(Some(candidate));
            }
        }
    }
    Ok(None)
}

/// The `phone_finder` action: a number the company lists on its own site.
async fn phone_finder(ctx: &ActionContext<'_>) -> Result<ActionResult, String> {
    let domain = clean_host(ctx.lead_text("domain"));
    let company = js_trim(ctx.lead_text("companyName").unwrap_or_default());
    let company = if company.is_empty() {
        domain.clone()
    } else {
        company.to_owned()
    };
    if !domain.is_empty() {
        let deadline = Instant::now() + SCRAPE_DEADLINE;
        for path in CANDIDATE_PATHS {
            if Instant::now() >= deadline {
                break;
            }
            let url = format!("https://{domain}/{path}");
            let Some(html) = ctx.pages.fetch(&url).await else {
                continue;
            };
            if let Some(phone) = extract_phone(&html)? {
                return Ok(ActionResult::of(
                    phone,
                    json!({ "source": "website", "found": true, "url": url }),
                ));
            }
        }
    }
    let fallback = ctx
        .config_value("webSearchFallback")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if fallback && !company.is_empty() {
        tracing::warn!(
            "[ai] AI is currently unavailable — skipping phone-finder web-search fallback for \"{company}\""
        );
        return Ok(ActionResult::of(
            "",
            json!({ "source": "web", "found": false, "verified": false, "unavailable": true }),
        ));
    }
    if domain.is_empty() && company.is_empty() {
        return Err(
            "No company domain or name on this lead to find a phone number from".to_owned(),
        );
    }
    Ok(ActionResult::of(
        "",
        json!({ "source": "website", "found": false }),
    ))
}

// ── reading websites ────────────────────────────────────────────────────────

/// Reads a web page for the phone finder: the HTML or text of a page that
/// answered 2xx, cut to [`MAX_HTML_UNITS`]; `None` for anything else (a
/// timeout, a refused address, another content type).
pub trait WebPages: Send + Sync {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Option<String>>;
}

/// [`WebPages`] over HTTP, public addresses only: a lead's domain is
/// whatever its source says, and a cluster's own services must not be
/// reachable through it.
#[derive(Clone)]
pub struct PublicPages {
    client: reqwest::Client,
}

impl std::fmt::Debug for PublicPages {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PublicPages")
    }
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

/// A globally routable address (as the webhook sender's
/// `weldsuite_subscribers::webhooks::is_public`).
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

impl PublicPages {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .dns_resolver(Arc::new(PublicOnlyResolver))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if literal_is_blocked(attempt.url()) {
                    attempt.error(BlockedAddress)
                } else if attempt.previous().len() >= 20 {
                    attempt.error("too many redirects")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        Ok(Self { client })
    }
}

impl WebPages for PublicPages {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let parsed = reqwest::Url::parse(url).ok()?;
            if literal_is_blocked(&parsed) {
                return None;
            }
            let response = self
                .client
                .get(parsed)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (compatible; WeldSuiteBot/1.0; +https://weldsuite.org/bot)",
                )
                .header("Accept", "text/html,application/xhtml+xml")
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if !content_type.contains("html") && !content_type.contains("text") {
                return None;
            }
            let body = response.bytes().await.ok()?;
            let text = String::from_utf8_lossy(&body);
            Some(if text.encode_utf16().count() > MAX_HTML_UNITS {
                slice_utf16(&text, MAX_HTML_UNITS)
            } else {
                text.into_owned()
            })
        })
    }
}

/// The column config as the actions read it: `null` is `{}`.
pub(crate) fn config_of(config: Option<&Value>) -> Value {
    match config {
        Some(Value::Object(map)) => Value::Object(map.clone()),
        _ => Value::Object(Map::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_resolve_lead_fields_data_and_siblings() {
        let lead = json!({ "name": "Ada", "companyName": null, "data": { "Score": 7, "nested": { "a": 1 } } });
        let siblings = HashMap::from([("email".to_owned(), "ada@x.test".to_owned())]);
        assert_eq!(
            resolve_template(
                "{{ NAME }} {{score}} {{email}} {{nested}} {{companyName}}!",
                &lead,
                &siblings
            ),
            "Ada 7 ada@x.test  !"
        );
    }

    #[test]
    fn emails_come_from_known_fields_then_the_text() {
        assert_eq!(
            extract_email(&json!({ "email": "a@b.co" }), "").as_deref(),
            Some("a@b.co")
        );
        let raw = r#"{"contact":{"name":"x","mail":"Jane.Doe@Example.COM"}}"#;
        let payload: Value = serde_json::from_str(raw).expect("json");
        assert_eq!(
            extract_email(&payload, raw).as_deref(),
            Some("Jane.Doe@Example.COM")
        );
        assert_eq!(
            extract_email(&json!("reach me: x@y.io"), "").as_deref(),
            Some("x@y.io")
        );
        assert_eq!(extract_email(&json!(5), "5"), None);
        assert_eq!(clean_domain(Some("https://acme.test/about")), "acme.test");
        // The scheme goes only when it opens the value, in lowercase.
        assert_eq!(clean_host(Some(" HTTP://Acme.TEST ")), "http:");
        assert_eq!(clean_host(Some("http://Acme.TEST/x")), "acme.test");
    }

    #[test]
    fn phones_come_from_tel_links_then_the_text() {
        let html = r#"<a href = "tel:%2B31%2020%20123%204567">Call</a>"#;
        assert_eq!(
            extract_phone(html).expect("ok").as_deref(),
            Some("+31 20 123 4567")
        );
        let text = "<p>Phone:</p><b>(020) 7946 0000</b>";
        assert_eq!(
            extract_phone(text).expect("ok").as_deref(),
            Some("(020) 7946 0000")
        );
        assert_eq!(
            extract_phone("<p>Call +44 20–7946–0000 today</p>")
                .expect("ok")
                .as_deref(),
            Some("+44 2079460000")
        );
        assert_eq!(extract_phone("<p>no number, 2026</p>").expect("ok"), None);
        assert!(extract_phone(r#"<a href="tel:%E0%A4%A">x</a>"#).is_err());
        assert_eq!(tags_to_spaces("a<b>c<>d<e"), "a c<>d<e");
    }

    #[test]
    fn only_public_addresses_are_read() {
        assert!(!is_public("127.0.0.1".parse().expect("ip")));
        assert!(!is_public("10.1.2.3".parse().expect("ip")));
        assert!(!is_public("169.254.169.254".parse().expect("ip")));
        assert!(is_public("93.184.216.34".parse().expect("ip")));
    }
}
