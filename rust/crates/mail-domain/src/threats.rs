//! WeldMail's threat checks for links, shared by the inbound consumer
//! (`weldsuite-mail-inbound`, at delivery) and the mail module's
//! `POST /api/mail-messages/{id}/link-check` (at click). EU and self-hosted
//! only: Global never checked links.
//!
//! A link is **malicious** when a threat feed lists it (master
//! `mail_threat_indicators`, synced by [`crate::threat_feeds`]): the exact
//! normalised URL, or its host or a parent domain for a domain feed. It is
//! **suspicious** on a heuristic that rarely fires on honest mail: an IP
//! address for a host, credentials before the host
//! (`https://bank.example@evil.test/`), or a punycode label that mixes
//! scripts or spells a Latin word in Cyrillic or Greek look-alikes.
//! Everything else is safe. Nothing about a link leaves the deployment.
//!
//! The JSON shapes here are the API's: the `threats` column of
//! `mail_messages` and the link-check response.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_schema::master::mail_threat_indicators;

/// Links looked at per message; a newsletter rarely has more.
pub const MAX_LINKS_PER_MESSAGE: usize = 200;
/// Link findings kept on one message.
pub const MAX_LINK_THREATS: usize = 20;
/// The longest link worth keeping (the indicators' column width).
pub const MAX_URL_LEN: usize = 2048;

/// How bad a link is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LinkVerdict {
    Safe,
    Suspicious,
    Malicious,
}

impl LinkVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Safe => "safe",
            Self::Suspicious => "suspicious",
            Self::Malicious => "malicious",
        }
    }
}

/// Why a link is not safe. `code` is one of `threat_feed`, `ip_host`,
/// `userinfo`, `homograph`; the feed fields only for `threat_feed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkReason {
    pub code: &'static str,
    pub source: Option<String>,
    pub threat: Option<String>,
}

impl LinkReason {
    fn heuristic(code: &'static str) -> Self {
        Self {
            code,
            source: None,
            threat: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut out = json!({ "code": self.code });
        if let Some(source) = &self.source {
            out["source"] = json!(source);
        }
        if let Some(threat) = &self.threat {
            out["threat"] = json!(threat);
        }
        out
    }
}

/// One link's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkFinding {
    /// The normalised URL.
    pub url: String,
    pub verdict: LinkVerdict,
    pub reasons: Vec<LinkReason>,
}

impl LinkFinding {
    /// The link-check response's `data`.
    pub fn to_json(&self) -> Value {
        json!({
            "url": self.url,
            "verdict": self.verdict.as_str(),
            "reasons": self.reasons.iter().map(LinkReason::to_json).collect::<Vec<_>>(),
        })
    }

    /// The entry in a message's `threats`: `{ kind: "link", verdict, url,
    /// reason, source?, threat? }`, the first (worst) reason. `None` for a
    /// safe link.
    pub fn threat_json(&self) -> Option<Value> {
        if self.verdict == LinkVerdict::Safe {
            return None;
        }
        let reason = self.reasons.first()?;
        let mut out = json!({
            "kind": "link",
            "verdict": self.verdict.as_str(),
            "url": self.url,
            "reason": reason.code,
        });
        if let Some(source) = &reason.source {
            out["source"] = json!(source);
        }
        if let Some(threat) = &reason.threat {
            out["threat"] = json!(threat);
        }
        Some(out)
    }
}

/// A link as the checks compare it: `http`/`https` only, lower-case host,
/// no default port, no fragment. `None` for anything else.
pub fn normalize_url(raw: &str) -> Option<url::Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > MAX_URL_LEN * 2 {
        return None;
    }
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    url.set_fragment(None);
    (url.as_str().len() <= MAX_URL_LEN).then_some(url)
}

/// The host and each parent domain with at least two labels
/// (`a.b.evil.test` → `a.b.evil.test`, `b.evil.test`, `evil.test`): what a
/// domain feed entry for any of them covers. An IP address is itself.
pub fn host_candidates(url: &url::Url) -> Vec<String> {
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            let labels: Vec<&str> = domain.split('.').collect();
            (0..labels.len().saturating_sub(1))
                .map(|i| labels[i..].join("."))
                .collect()
        }
        Some(url::Host::Ipv4(ip)) => vec![ip.to_string()],
        Some(url::Host::Ipv6(ip)) => vec![format!("[{ip}]")],
        None => Vec::new(),
    }
}

/// `&amp;` and friends in an attribute value, the five that matter in a URL.
fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// An `<a>` or `<area>` tag's `href`, quoted either way or bare.
static HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<(?:a|area)\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
        .unwrap_or_else(|e| panic!("{e}"))
});

/// A URL written out in plain text.
static TEXT_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhttps?://[^\s<>"'()\[\]]+"#).unwrap_or_else(|e| panic!("{e}"))
});

/// The distinct `http`/`https` links of a message, normalised, in order:
/// every `<a>`/`<area>` `href` of the HTML, then URLs written out in the
/// plain text. At most [`MAX_LINKS_PER_MESSAGE`].
pub fn extract_links(html: Option<&str>, text: Option<&str>) -> Vec<url::Url> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut push = |raw: &str| {
        if out.len() >= MAX_LINKS_PER_MESSAGE {
            return;
        }
        if let Some(url) = normalize_url(&decode_entities(raw))
            && seen.insert(url.as_str().to_owned())
        {
            out.push(url);
        }
    };
    if let Some(html) = html {
        for captures in HREF.captures_iter(html) {
            if let Some(value) = captures.get(1).or(captures.get(2)).or(captures.get(3)) {
                push(value.as_str());
            }
        }
    }
    if let Some(text) = text {
        for found in TEXT_URL.find_iter(text) {
            push(
                found
                    .as_str()
                    .trim_end_matches(['.', ',', ';', ':', '!', '?']),
            );
        }
    }
    out
}

/// Cyrillic and Greek letters that pass for Latin ones in most fonts.
const LATIN_LOOKALIKES: &[char] = &[
    'а', 'в', 'е', 'к', 'м', 'н', 'о', 'р', 'с', 'т', 'у', 'х', 'ѕ', 'і', 'ј', 'ӏ', 'ԁ', 'ԛ', 'ԝ',
    'ɡ', 'α', 'ο', 'ρ', 'ν', 'τ', 'ι', 'κ', 'υ', 'χ', 'ε',
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Script {
    Latin,
    Cyrillic,
    Greek,
    Other,
}

fn script(c: char) -> Option<Script> {
    if !c.is_alphabetic() {
        return None;
    }
    Some(match u32::from(c) {
        0x41..=0x5A | 0x61..=0x7A | 0xC0..=0x24F | 0x1E00..=0x1EFF => Script::Latin,
        0x370..=0x3FF | 0x1F00..=0x1FFF => Script::Greek,
        0x400..=0x52F => Script::Cyrillic,
        _ => Script::Other,
    })
}

/// A punycode label that mixes Latin with Cyrillic or Greek, or that is
/// Cyrillic or Greek made only of Latin look-alikes (under a non-IDN TLD):
/// `аpple`, `раураl`. Honest IDN domains (`münchen.de`, `пример.рф`) pass.
fn is_homograph(url: &url::Url) -> bool {
    let Some(url::Host::Domain(domain)) = url.host() else {
        return false;
    };
    if !domain.split('.').any(|l| l.starts_with("xn--")) {
        return false;
    }
    let unicode = url::quirks::domain_to_unicode(domain);
    let labels: Vec<&str> = unicode.split('.').collect();
    let tld_is_ascii = labels.last().is_some_and(|tld| tld.is_ascii());
    labels.iter().any(|label| {
        if label.is_ascii() {
            return false;
        }
        let scripts: BTreeSet<Script> = label.chars().filter_map(script).collect();
        let mixes_latin = scripts.contains(&Script::Latin)
            && (scripts.contains(&Script::Cyrillic) || scripts.contains(&Script::Greek));
        let all_lookalikes = tld_is_ascii
            && !scripts.contains(&Script::Latin)
            && label
                .chars()
                .filter(|c| c.is_alphabetic())
                .all(|c| LATIN_LOOKALIKES.contains(&c));
        mixes_latin || all_lookalikes
    })
}

/// The heuristic reasons for one link, worst first.
pub fn heuristic_reasons(url: &url::Url) -> Vec<LinkReason> {
    let mut reasons = Vec::new();
    if !url.username().is_empty() || url.password().is_some() {
        reasons.push(LinkReason::heuristic("userinfo"));
    }
    if is_homograph(url) {
        reasons.push(LinkReason::heuristic("homograph"));
    }
    if matches!(url.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_))) {
        reasons.push(LinkReason::heuristic("ip_host"));
    }
    reasons
}

/// A feed match for a link: `(source, threat)`.
type FeedHit = (String, String);

/// Which of `urls` a threat feed lists, by normalised URL.
pub async fn feed_matches(
    master: &PgPool,
    urls: &[url::Url],
) -> Result<BTreeMap<String, FeedHit>, DbErr> {
    if urls.is_empty() {
        return Ok(BTreeMap::new());
    }
    let url_values: Vec<String> = urls.iter().map(|u| u.as_str().to_owned()).collect();
    let mut hosts: BTreeSet<String> = BTreeSet::new();
    for url in urls {
        hosts.extend(host_candidates(url));
    }
    let rows = mail_threat_indicators::Entity::find()
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(mail_threat_indicators::Column::Kind.eq("url"))
                        .add(mail_threat_indicators::Column::Value.is_in(url_values)),
                )
                .add(
                    Condition::all()
                        .add(mail_threat_indicators::Column::Kind.eq("host"))
                        .add(mail_threat_indicators::Column::Value.is_in(hosts)),
                ),
        )
        .all(&weldsuite_db::orm(master))
        .await?;
    let mut by_url: BTreeMap<String, FeedHit> = BTreeMap::new();
    let mut by_host: BTreeMap<String, FeedHit> = BTreeMap::new();
    for row in rows {
        let hit = (row.source, row.threat);
        if row.kind == "url" {
            by_url.insert(row.value, hit);
        } else {
            by_host.insert(row.value, hit);
        }
    }
    let mut out = BTreeMap::new();
    for url in urls {
        let hit = by_url.get(url.as_str()).cloned().or_else(|| {
            host_candidates(url)
                .iter()
                .find_map(|host| by_host.get(host).cloned())
        });
        if let Some(hit) = hit {
            out.insert(url.as_str().to_owned(), hit);
        }
    }
    Ok(out)
}

/// The verdict for each of `urls` from the feed hits and the heuristics.
pub fn verdicts(urls: &[url::Url], hits: &BTreeMap<String, FeedHit>) -> Vec<LinkFinding> {
    urls.iter()
        .map(|url| {
            let mut reasons = Vec::new();
            if let Some((source, threat)) = hits.get(url.as_str()) {
                reasons.push(LinkReason {
                    code: "threat_feed",
                    source: Some(source.clone()),
                    threat: Some(threat.clone()),
                });
            }
            reasons.extend(heuristic_reasons(url));
            let verdict = if hits.contains_key(url.as_str()) {
                LinkVerdict::Malicious
            } else if reasons.is_empty() {
                LinkVerdict::Safe
            } else {
                LinkVerdict::Suspicious
            };
            LinkFinding {
                url: url.as_str().to_owned(),
                verdict,
                reasons,
            }
        })
        .collect()
}

/// The links of a message that are not safe, worst first, at most
/// [`MAX_LINK_THREATS`]. A feed lookup that fails is logged and leaves the
/// heuristics: delivery never waits on it.
pub async fn check_message_links(
    master: &PgPool,
    html: Option<&str>,
    text: Option<&str>,
) -> Vec<LinkFinding> {
    let urls = extract_links(html, text);
    if urls.is_empty() {
        return Vec::new();
    }
    let hits = match feed_matches(master, &urls).await {
        Ok(hits) => hits,
        Err(error) => {
            tracing::warn!(%error, "[Threats] threat feed lookup failed; heuristics only");
            BTreeMap::new()
        }
    };
    let mut findings: Vec<LinkFinding> = verdicts(&urls, &hits)
        .into_iter()
        .filter(|f| f.verdict != LinkVerdict::Safe)
        .collect();
    findings.sort_by_key(|f| std::cmp::Reverse(f.verdict));
    findings.truncate(MAX_LINK_THREATS);
    findings
}

/// One link, at click time. `None` for a link that is not `http`/`https`.
pub async fn check_link(master: &PgPool, raw: &str) -> Result<Option<LinkFinding>, DbErr> {
    let Some(url) = normalize_url(raw) else {
        return Ok(None);
    };
    let urls = [url];
    let hits = feed_matches(master, &urls).await?;
    Ok(verdicts(&urls, &hits).into_iter().next())
}

/// The entry in a message's `threats` for an infected attachment.
pub fn attachment_threat_json(
    file_name: &str,
    attachment_id: Option<&str>,
    signature: &str,
) -> Value {
    let mut out = json!({
        "kind": "attachment",
        "verdict": "infected",
        "fileName": file_name,
        "signature": signature,
    });
    if let Some(id) = attachment_id {
        out["attachmentId"] = json!(id);
    }
    out
}

/// Whether a message's `threats` value holds an infected file or a
/// malicious link (the ones that move a message to Spam).
pub fn is_dangerous(threats: &Value) -> bool {
    threats.as_array().is_some_and(|list| {
        list.iter().any(|t| {
            matches!(
                t.get("verdict").and_then(Value::as_str),
                Some("infected" | "malicious")
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> url::Url {
        normalize_url(raw).expect("a link")
    }

    #[test]
    fn normalises_links() {
        assert_eq!(
            url("HTTPS://Example.COM:443/a?b=1#top").as_str(),
            "https://example.com/a?b=1"
        );
        assert_eq!(url("http://evil.test").as_str(), "http://evil.test/");
        assert!(normalize_url("mailto:a@b.c").is_none());
        assert!(normalize_url("javascript:alert(1)").is_none());
        assert!(normalize_url("not a url").is_none());
    }

    #[test]
    fn extracts_links_from_html_and_text() {
        let html = r#"<p><a class="x" href="https://a.test/x?y=1&amp;z=2">A</a>
            <A HREF='http://b.test/'>B</A> <a href=https://c.test/c>C</a>
            <a href="mailto:x@y.z">m</a> <a href="https://a.test/x?y=1&z=2">dup</a></p>"#;
        let text = "See https://d.test/page. And (https://e.test/x), again https://d.test/page";
        let links: Vec<String> = extract_links(Some(html), Some(text))
            .iter()
            .map(|u| u.as_str().to_owned())
            .collect();
        assert_eq!(
            links,
            [
                "https://a.test/x?y=1&z=2",
                "http://b.test/",
                "https://c.test/c",
                "https://d.test/page",
                "https://e.test/x",
            ]
        );
    }

    #[test]
    fn hosts_cover_parent_domains() {
        assert_eq!(
            host_candidates(&url("https://a.b.evil.test/x")),
            ["a.b.evil.test", "b.evil.test", "evil.test"]
        );
        assert_eq!(host_candidates(&url("http://192.0.2.7/")), ["192.0.2.7"]);
    }

    #[test]
    fn heuristics() {
        let codes = |raw: &str| -> Vec<&str> {
            heuristic_reasons(&url(raw))
                .iter()
                .map(|r| r.code)
                .collect()
        };
        assert_eq!(codes("http://192.0.2.7/login"), ["ip_host"]);
        assert_eq!(codes("https://bank.example@evil.test/"), ["userinfo"]);
        // "аpple" with a Cyrillic а.
        assert_eq!(codes("https://xn--pple-43d.com/"), ["homograph"]);
        // "аррӏе" written entirely in Cyrillic look-alikes.
        assert_eq!(codes("https://xn--80ak6aa92e.com/"), ["homograph"]);
        // Honest IDN domains.
        assert_eq!(codes("https://xn--mnchen-3ya.de/"), Vec::<&str>::new());
        assert_eq!(codes("https://xn--e1afmkfd.xn--p1ai/"), Vec::<&str>::new());
        assert_eq!(codes("https://www.example.com/"), Vec::<&str>::new());
    }

    #[test]
    fn feed_hits_make_links_malicious() {
        let urls = [
            url("https://evil.test/a"),
            url("http://192.0.2.7/"),
            url("https://fine.test/"),
        ];
        let mut hits = BTreeMap::new();
        hits.insert(
            "https://evil.test/a".to_owned(),
            ("urlhaus".to_owned(), "malware".to_owned()),
        );
        let found = verdicts(&urls, &hits);
        assert_eq!(found[0].verdict, LinkVerdict::Malicious);
        assert_eq!(found[1].verdict, LinkVerdict::Suspicious);
        assert_eq!(found[2].verdict, LinkVerdict::Safe);
        assert_eq!(
            found[0].threat_json(),
            Some(json!({
                "kind": "link", "verdict": "malicious", "url": "https://evil.test/a",
                "reason": "threat_feed", "source": "urlhaus", "threat": "malware",
            }))
        );
        assert_eq!(found[2].threat_json(), None);
        assert!(is_dangerous(&json!([found[0].threat_json()])));
        assert!(!is_dangerous(&json!([found[1].threat_json()])));
        assert!(is_dangerous(&json!([attachment_threat_json(
            "a.exe", None, "Eicar"
        )])));
    }
}
