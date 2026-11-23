//! The threat feeds behind WeldMail's link checks ([`crate::threats`]):
//! `weldsuite cron mail-threat-feeds` downloads each configured feed and
//! keeps master `mail_threat_indicators` in step with it.
//!
//! Feeds are configured, never built in: which lists a deployment may use
//! commercially is the operator's call (abuse.ch's `URLhaus` and `ThreatFox`,
//! for instance, ask for a paid subscription for commercial use).
//! `MAIL_THREAT_FEEDS` is a JSON array:
//!
//! ```json
//! [{ "name": "phishing-db", "url": "https://…/phishing-links-ACTIVE.txt",
//!    "format": "urls", "threat": "phishing" }]
//! ```
//!
//! - `format` `urls`: one link per line. `hosts`: one domain per line, or a
//!   hosts file (`0.0.0.0 evil.test`). Lines starting with `#` or `!` are
//!   comments.
//! - `threat`: `malware` or `phishing`.
//! - A URL that carries a key belongs in the Secret: put the whole variable
//!   there rather than in the chart's values.
//!
//! An entry a feed stops listing is dropped [`PRUNE_AFTER`] later; a feed
//! that fails to download keeps what it had. Entries of a feed that is no
//! longer configured go the same way.

use std::collections::BTreeSet;
use std::time::Duration;

use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::NotSet, ColumnTrait, DbErr, EntityTrait, QueryFilter, Set};
use serde::Deserialize;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_schema::master::mail_threat_indicators;

use crate::threats::{MAX_URL_LEN, normalize_url};

/// How long an entry outlives the last download that listed it.
pub const PRUNE_AFTER: Duration = Duration::from_hours(48);
/// The most entries taken from one feed.
pub const MAX_ENTRIES_PER_FEED: usize = 500_000;
/// The largest feed body read.
pub const MAX_FEED_BYTES: usize = 64 * 1024 * 1024;
/// Rows per insert.
const BATCH: usize = 1000;

/// One configured feed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Feed {
    pub name: String,
    pub url: String,
    pub format: FeedFormat,
    pub threat: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedFormat {
    Urls,
    Hosts,
}

impl FeedFormat {
    fn kind(self) -> &'static str {
        match self {
            Self::Urls => "url",
            Self::Hosts => "host",
        }
    }
}

/// `MAIL_THREAT_FEEDS`, checked: a name of letters, digits, `-` and `_`
/// (at most 50), an `https` URL, a known format and threat, names unique.
pub fn parse_feeds(raw: &str) -> Result<Vec<Feed>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    let feeds: Vec<Feed> = serde_json::from_str(raw)
        .map_err(|error| format!("MAIL_THREAT_FEEDS must be a JSON array of feeds: {error}"))?;
    let mut names = BTreeSet::new();
    for feed in &feeds {
        let name_ok = !feed.name.is_empty()
            && feed.name.len() <= 50
            && feed
                .name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
        if !name_ok {
            return Err(format!("MAIL_THREAT_FEEDS: bad feed name {:?}", feed.name));
        }
        if !names.insert(feed.name.as_str()) {
            return Err(format!(
                "MAIL_THREAT_FEEDS: feed {:?} is listed twice",
                feed.name
            ));
        }
        if !feed.url.starts_with("https://") {
            return Err(format!(
                "MAIL_THREAT_FEEDS: feed {:?} needs an https URL",
                feed.name
            ));
        }
        if !matches!(feed.threat.as_str(), "malware" | "phishing") {
            return Err(format!(
                "MAIL_THREAT_FEEDS: feed {:?} has threat {:?} (malware or phishing)",
                feed.name, feed.threat
            ));
        }
    }
    Ok(feeds)
}

/// A domain as a hosts feed writes it, or `None` (comments, IPs alone,
/// `localhost`, anything that is not a host name).
fn host_entry(line: &str) -> Option<String> {
    let mut parts = line.split_whitespace();
    let first = parts.next()?;
    // A hosts file: the address first, the name second.
    let name = if first.parse::<std::net::IpAddr>().is_ok() {
        parts.next()?
    } else {
        first
    };
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    let valid = name.contains('.')
        && name.len() <= 253
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
        && name.parse::<std::net::IpAddr>().is_err();
    (valid && name != "localhost.localdomain").then_some(name)
}

/// A feed body's entries, distinct, normalised as the checks compare them.
pub fn parse_entries(format: FeedFormat, body: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for line in body.lines() {
        if seen.len() >= MAX_ENTRIES_PER_FEED {
            break;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        let entry = match format {
            FeedFormat::Urls => normalize_url(line).map(|u| u.as_str().to_owned()),
            FeedFormat::Hosts => host_entry(line),
        };
        if let Some(entry) = entry.filter(|e| e.len() <= MAX_URL_LEN) {
            seen.insert(entry);
        }
    }
    seen.into_iter().collect()
}

/// What one sync did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// `(feed, entries)` for each feed that downloaded.
    pub synced: Vec<(String, usize)>,
    /// `(feed, error)` for each one that did not.
    pub failed: Vec<(String, String)>,
    pub pruned: u64,
}

async fn upsert(
    master: &PgPool,
    feed: &Feed,
    entries: &[String],
    now: OffsetDateTime,
) -> Result<(), DbErr> {
    let orm = weldsuite_db::orm(master);
    for chunk in entries.chunks(BATCH) {
        let rows = chunk
            .iter()
            .map(|value| mail_threat_indicators::ActiveModel {
                kind: Set(feed.format.kind().to_owned()),
                value: Set(value.clone()),
                source: Set(feed.name.clone()),
                threat: Set(feed.threat.clone()),
                first_seen_at: NotSet,
                last_seen_at: Set(now),
            });
        mail_threat_indicators::Entity::insert_many(rows)
            .on_conflict(
                OnConflict::columns([
                    mail_threat_indicators::Column::Kind,
                    mail_threat_indicators::Column::Value,
                ])
                .update_columns([
                    mail_threat_indicators::Column::Source,
                    mail_threat_indicators::Column::Threat,
                    mail_threat_indicators::Column::LastSeenAt,
                ])
                .to_owned(),
            )
            .exec_without_returning(&orm)
            .await?;
    }
    Ok(())
}

async fn download(http: &OutboundHttp, feed: &Feed) -> Result<String, String> {
    let response = http
        .send(HttpRequest::empty("GET", &feed.url).header("accept", "text/plain"))
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!("HTTP {}", response.status));
    }
    if response.body.len() > MAX_FEED_BYTES {
        return Err(format!("larger than {MAX_FEED_BYTES} bytes"));
    }
    Ok(String::from_utf8_lossy(&response.body).into_owned())
}

/// Download every feed, upsert what it lists, then drop what no download
/// has listed for [`PRUNE_AFTER`]: per feed that downloaded, and for feeds
/// no longer configured. A feed that fails keeps its entries.
pub async fn sync_feeds(
    master: &PgPool,
    http: &OutboundHttp,
    feeds: &[Feed],
    now: OffsetDateTime,
) -> Result<SyncReport, DbErr> {
    let mut report = SyncReport::default();
    let cutoff = now - PRUNE_AFTER;
    let orm = weldsuite_db::orm(master);
    for feed in feeds {
        let body = match download(http, feed).await {
            Ok(body) => body,
            Err(error) => {
                tracing::warn!(feed = %feed.name, %error, "[ThreatFeeds] download failed; keeping its entries");
                report.failed.push((feed.name.clone(), error));
                continue;
            }
        };
        let entries = parse_entries(feed.format, &body);
        upsert(master, feed, &entries, now).await?;
        let pruned = mail_threat_indicators::Entity::delete_many()
            .filter(mail_threat_indicators::Column::Source.eq(feed.name.as_str()))
            .filter(mail_threat_indicators::Column::LastSeenAt.lt(cutoff))
            .exec(&orm)
            .await?;
        report.pruned += pruned.rows_affected;
        tracing::info!(feed = %feed.name, entries = entries.len(), pruned = pruned.rows_affected, "[ThreatFeeds] synced");
        report.synced.push((feed.name.clone(), entries.len()));
    }
    let configured: Vec<&str> = feeds.iter().map(|f| f.name.as_str()).collect();
    let mut stale = mail_threat_indicators::Entity::delete_many()
        .filter(mail_threat_indicators::Column::LastSeenAt.lt(cutoff));
    if !configured.is_empty() {
        stale = stale.filter(mail_threat_indicators::Column::Source.is_not_in(configured));
    }
    report.pruned += stale.exec(&orm).await?.rows_affected;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_configuration() {
        assert_eq!(parse_feeds(""), Ok(Vec::new()));
        let feeds = parse_feeds(
            r#"[{"name":"phish-db","url":"https://example.test/links.txt","format":"urls","threat":"phishing"},
                {"name":"c2","url":"https://example.test/hosts","format":"hosts","threat":"malware"}]"#,
        )
        .expect("feeds");
        assert_eq!(feeds.len(), 2);
        assert_eq!(feeds[1].format, FeedFormat::Hosts);
        let bad = |raw: &str| parse_feeds(raw).is_err();
        assert!(bad(
            r#"[{"name":"x","url":"http://example.test/","format":"urls","threat":"malware"}]"#
        ));
        assert!(bad(
            r#"[{"name":"x y","url":"https://example.test/","format":"urls","threat":"malware"}]"#
        ));
        assert!(bad(
            r#"[{"name":"x","url":"https://example.test/","format":"csv","threat":"malware"}]"#
        ));
        assert!(bad(
            r#"[{"name":"x","url":"https://example.test/","format":"urls","threat":"spam"}]"#
        ));
        assert!(bad(
            r#"[{"name":"x","url":"https://a.test/","format":"urls","threat":"malware"},
                {"name":"x","url":"https://b.test/","format":"urls","threat":"malware"}]"#
        ));
        assert!(bad("{}"));
    }

    #[test]
    fn parses_url_feeds() {
        let body = "# comment\nhttps://Evil.test/a#x\n\nhttps://evil.test/a\nnot a url\nftp://x.test/\nhttp://192.0.2.1/p\n";
        assert_eq!(
            parse_entries(FeedFormat::Urls, body),
            ["http://192.0.2.1/p", "https://evil.test/a"]
        );
    }

    #[test]
    fn parses_host_feeds() {
        let body = "! adblock comment\n# hosts\n0.0.0.0 Evil.test\n127.0.0.1 localhost\nbad.example.\n192.0.2.4\nnodots\nx y.test\n";
        assert_eq!(
            parse_entries(FeedFormat::Hosts, body),
            ["bad.example", "evil.test"]
        );
    }
}
