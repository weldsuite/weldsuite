//! DMARC aggregate reports at the install's report address (ADR MAIL-015,
//! `weldsuite-documentation/plans/weldmail-dmarc-reports.md`).
//!
//! The suggested record of every custom mail domain names one address,
//! `MAIL_DMARC_REPORTS_ADDRESS` (`dmarc@reports.weldsuite.eu`). Haraka takes
//! it at `RCPT TO` (the check answers `match: "extra"`), spools the message
//! and publishes it on `mail.inbound` like any other; [`DmarcReportRouter`]
//! takes it out before WeldMail's handler, as WeldReach's router takes its
//! replies. Nothing here is ever shown as mail:
//!
//! 1. The report is read from the message ([`read`]): its gzip, zip or XML
//!    attachment, parsed with `weldsuite_mail_dmarc`. A failure report
//!    (`ruf`) or anything else is dropped unread.
//! 2. It is **authenticated** when the message passed DMARC (Haraka's
//!    `Authentication-Results`) for a From domain of the same organisation
//!    as the reporter's address. Unauthenticated reports are stored, but
//!    never count toward advice or alerts.
//! 3. Each row is tagged with WeldSuite's pool when its source is one of the
//!    MTA's addresses, else named by reverse DNS.
//! 4. The rows go to every workspace that verified their header From domain
//!    (or a parent) through `mail_domain_registry`, each into its tenant
//!    database; a report for nobody's domain is not stored.
//! 5. The master database logs the report once and adds WeldSuite's own
//!    rows to the operator's rollup.
//! 6. When WeldSuite's mail for a domain fails DMARC, the workspace's owners
//!    and admins are told once a day, with `mail_domain.dmarc_failing`.
//!
//! A database that can't be reached retries the message; anything else is
//! acknowledged, so a bad report never blocks the stream.

mod store;

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType};
use weldsuite_mail_dmarc::report::Report;
use weldsuite_mail_dmarc::{archive, report, sources};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition, DynFileStore};

pub use store::{RETENTION_DAYS, Sourced, Target};

use crate::context::TenantDbs;

/// Reports received, by outcome.
pub const REPORTS_METRIC: &str = "weldsuite_dmarc_reports_total";
/// Messages from WeldSuite's own addresses in new reports, by pool,
/// reporter and result.
pub const MESSAGES_METRIC: &str = "weldsuite_dmarc_messages_total";
/// Sources named by reverse DNS per report, at most.
const MAX_NAMED_SOURCES: usize = 50;
/// WeldSuite's mail for a domain fails more than this (per mille) of a
/// report's messages: alert.
const ALERT_FAIL_PERMILLE: u64 = 50;
/// ... and the report has at least this many of WeldSuite's messages.
const ALERT_MIN_MESSAGES: u64 = 10;

/// WeldSuite's own sending addresses, by pool (the MTA's `GET /v1/ips`).
pub trait SendingAddresses: Send + Sync {
    /// Address → pool; empty when unknown.
    fn pools(&self) -> BoxFuture<'_, HashMap<String, String>>;
}

/// Reverse DNS names, through the install's own resolver.
pub trait ReverseNames: Send + Sync {
    /// The names of those `ips` that have one.
    fn names(&self, ips: Vec<IpAddr>) -> BoxFuture<'_, HashMap<IpAddr, String>>;
}

/// No sending addresses known (an install without the MTA's API).
pub struct NoAddresses;

impl SendingAddresses for NoAddresses {
    fn pools(&self) -> BoxFuture<'_, HashMap<String, String>> {
        Box::pin(async { HashMap::new() })
    }
}

/// No reverse lookups.
pub struct NoNames;

impl ReverseNames for NoNames {
    fn names(&self, _ips: Vec<IpAddr>) -> BoxFuture<'_, HashMap<IpAddr, String>> {
        Box::pin(async { HashMap::new() })
    }
}

/// What became of a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Stored for this many verified domains.
    Stored(usize),
    /// Only WeldSuite's own domains: counted for the operator.
    Operator,
    /// Nobody's domain: dropped.
    UnknownDomain,
    /// Seen before.
    Duplicate,
    /// A failure report or other mail: dropped unread.
    NotAggregate,
    /// Not readable as a report.
    Invalid(String),
}

impl Outcome {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Stored(_) => "stored",
            Self::Operator => "operator",
            Self::UnknownDomain => "unknown_domain",
            Self::Duplicate => "duplicate",
            Self::NotAggregate => "not_aggregate",
            Self::Invalid(_) => "invalid",
        }
    }
}

/// A database could not be reached: the message is retried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable(pub String);

impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn unavailable(error: impl std::fmt::Display) -> Unavailable {
    Unavailable(error.to_string())
}

/// The install's report receiver.
pub struct DmarcReports {
    /// `MAIL_DMARC_REPORTS_ADDRESS`, lower-cased.
    pub address: String,
    /// `MAIL_DMARC_OPERATOR_DOMAINS`: WeldSuite's own sending domains.
    pub operator_domains: Vec<String>,
    pub master: PgPool,
    pub tenants: Arc<dyn TenantDbs>,
    pub events: EntityEventPublisher,
    pub notifier: Notifier,
    pub addresses: Arc<dyn SendingAddresses>,
    pub names: Arc<dyn ReverseNames>,
}

/// When the master tables were last pruned (unix seconds).
static PRUNED_AT: AtomicI64 = AtomicI64::new(0);

/// The report a message carries, and whether the message authenticated as
/// its reporter; the outcome when there is none.
///
/// # Errors
///
/// [`Outcome::NotAggregate`] or [`Outcome::Invalid`].
pub fn read(raw: &[u8]) -> Result<(Report, bool), Outcome> {
    let email = crate::mime::parse(raw).map_err(|error| Outcome::Invalid(error.to_string()))?;
    let content_type = email
        .headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, value)| value.to_ascii_lowercase())
        .unwrap_or_default();
    if content_type.contains("multipart/report") && content_type.contains("feedback-report") {
        // An ARF failure report (`ruf`): personal data, never read.
        return Err(Outcome::NotAggregate);
    }
    let attachment = email
        .attachments
        .iter()
        .map(|a| a.content.as_slice())
        .find(|content| archive::kind(content).is_some());
    let inline = email
        .text
        .as_deref()
        .map(str::trim_start)
        .filter(|text| text.starts_with("<?xml") || text.starts_with("<feedback"))
        .map(str::as_bytes);
    let Some(bytes) = attachment.or(inline) else {
        return Err(Outcome::NotAggregate);
    };
    let xml = archive::extract(bytes).map_err(|error| Outcome::Invalid(error.to_string()))?;
    let report = report::parse(&xml).map_err(|error| match error {
        report::ReportError::NotAReport(_) => Outcome::NotAggregate,
        other => Outcome::Invalid(other.to_string()),
    })?;
    let auth = crate::parsed::authentication_results(&email);
    let (_, _, dmarc) = crate::parsed::auth_statuses(&auth);
    let from_domain = email
        .from
        .as_ref()
        .and_then(|from| from.address.as_deref())
        .and_then(|address| address.rsplit_once('@'))
        .map(|(_, domain)| domain.to_ascii_lowercase())
        .unwrap_or_default();
    let authenticated = dmarc.as_deref() == Some("pass")
        && !from_domain.is_empty()
        && sources::registrable(&from_domain) == sources::registrable(&report.reporter_domain());
    Ok((report, authenticated))
}

/// A reporter as a metric label: the large ones by name.
fn reporter_label(domain: &str) -> &'static str {
    match sources::registrable(domain).as_str() {
        "google.com" => "google",
        "microsoft.com" | "outlook.com" | "hotmail.com" => "microsoft",
        "yahoo.com" | "yahoo.net" | "yahooinc.com" => "yahoo",
        "gmx.net" | "web.de" | "1und1.de" | "gmx.de" => "gmx",
        "apple.com" | "icloud.com" => "apple",
        _ => "other",
    }
}

fn result(pass: bool) -> &'static str {
    if pass { "pass" } else { "fail" }
}

impl DmarcReports {
    /// Whether `recipient` is the report address.
    pub fn claims(&self, recipient: &str) -> bool {
        recipient.trim().eq_ignore_ascii_case(&self.address)
    }

    /// Reads and files one message sent to the report address.
    ///
    /// # Errors
    ///
    /// [`Unavailable`] when a database could not be reached.
    pub async fn ingest(&self, raw: &[u8]) -> Result<Outcome, Unavailable> {
        let outcome = match read(raw) {
            Err(outcome) => outcome,
            Ok((report, authenticated)) => self.file(&report, authenticated).await?,
        };
        metrics::counter!(REPORTS_METRIC, "outcome" => outcome.label()).increment(1);
        match &outcome {
            Outcome::Invalid(why) => tracing::warn!(why, "[dmarc] unreadable report dropped"),
            other => tracing::info!(outcome = other.label(), "[dmarc] report"),
        }
        Ok(outcome)
    }

    /// The rows with their sources: WeldSuite's pool, or a reverse name for
    /// the busiest other sources.
    async fn sourced<'r>(&self, report: &'r Report) -> Vec<Sourced<'r>> {
        let pools = self.addresses.pools().await;
        let mut others: Vec<(IpAddr, u32)> = report
            .records
            .iter()
            .filter(|row| !pools.contains_key(&row.source_ip))
            .filter_map(|row| row.source_ip.parse().ok().map(|ip| (ip, row.count)))
            .collect();
        others.sort_by_key(|other| std::cmp::Reverse(other.1));
        let mut wanted: Vec<IpAddr> = Vec::new();
        for (ip, _) in others {
            if !wanted.contains(&ip) {
                wanted.push(ip);
            }
            if wanted.len() >= MAX_NAMED_SOURCES {
                break;
            }
        }
        let names = if wanted.is_empty() {
            HashMap::new()
        } else {
            self.names.names(wanted).await
        };
        report
            .records
            .iter()
            .map(|row| Sourced {
                row,
                pool: pools.get(&row.source_ip).cloned(),
                name: row
                    .source_ip
                    .parse::<IpAddr>()
                    .ok()
                    .and_then(|ip| names.get(&ip).cloned())
                    .map(|name| name.trim_end_matches('.').chars().take(255).collect()),
            })
            .collect()
    }

    async fn file(&self, report: &Report, authenticated: bool) -> Result<Outcome, Unavailable> {
        let rows = self.sourced(report).await;
        let targets = store::route(&self.master, &rows)
            .await
            .map_err(unavailable)?;
        let mut stored = 0;
        let mut seen = false;
        for (target, indexes) in &targets {
            let db = self
                .tenants
                .tenant_db(&target.workspace_id)
                .await
                .map_err(unavailable)?;
            let mine: Vec<&Sourced<'_>> = indexes.iter().map(|&i| &rows[i]).collect();
            if store::write_tenant(&db, target, report, &mine, authenticated)
                .await
                .map_err(unavailable)?
            {
                stored += 1;
                if authenticated {
                    self.alert_if_failing(&db, target, &mine).await;
                }
            } else {
                seen = true;
            }
        }
        let operator = rows.iter().any(|s| {
            self.operator_domains
                .iter()
                .any(|d| sources::within(&s.row.header_from, d))
        });
        let outcome = if stored > 0 || seen {
            Outcome::Stored(targets.len())
        } else if operator {
            Outcome::Operator
        } else {
            Outcome::UnknownDomain
        };
        let first = store::log_and_roll_up(&self.master, report, outcome.label(), &rows)
            .await
            .map_err(unavailable)?;
        self.prune_now_and_then().await;
        if !first {
            return Ok(Outcome::Duplicate);
        }
        let reporter = reporter_label(&report.reporter_domain());
        for sourced in rows.iter().filter(|s| s.pool.is_some()) {
            let row = sourced.row;
            metrics::counter!(
                MESSAGES_METRIC,
                "pool" => sourced.pool.clone().unwrap_or_default(),
                "reporter" => reporter,
                "dkim" => result(row.dkim_aligned()),
                "spf" => result(row.spf_aligned()),
                "dmarc" => result(row.passed()),
            )
            .increment(u64::from(row.count));
            if !row.passed() {
                tracing::warn!(
                    pool = sourced.pool.as_deref().unwrap_or_default(),
                    ip = %row.source_ip,
                    from = %row.header_from,
                    reporter = %report.reporter_domain(),
                    count = row.count,
                    "[dmarc] WeldSuite's mail failed DMARC"
                );
            }
        }
        if matches!(outcome, Outcome::UnknownDomain) {
            tracing::info!(
                domain = %report.policy.domain,
                reporter = %report.reporter_domain(),
                "[dmarc] report for a domain no workspace verified; dropped"
            );
        }
        Ok(outcome)
    }

    async fn prune_now_and_then(&self) {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        let last = PRUNED_AT.load(Ordering::Relaxed);
        if now - last < 3600
            || PRUNED_AT
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }
        if let Err(error) = store::prune_master(&self.master).await {
            tracing::warn!(%error, "[dmarc] pruning the report log failed");
        }
    }

    /// Tells the workspace when WeldSuite's own mail for the domain failed
    /// DMARC in this report (usually a removed DKIM record), once a day.
    async fn alert_if_failing(&self, db: &PgPool, target: &Target, rows: &[&Sourced<'_>]) {
        let (messages, failed) =
            rows.iter()
                .filter(|s| s.pool.is_some())
                .fold((0u64, 0u64), |(m, f), s| {
                    let n = u64::from(s.row.count);
                    (m + n, f + if s.row.passed() { 0 } else { n })
                });
        if messages < ALERT_MIN_MESSAGES || failed * 1000 / messages <= ALERT_FAIL_PERMILLE {
            return;
        }
        match store::claim_alert(db, &target.mail_domain_id).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::warn!(%error, "[dmarc] alert state not readable");
                return;
            }
        }
        let permille = failed * 1000 / messages;
        let data = json!({
            "id": target.mail_domain_id,
            "domainName": target.domain,
            "messages": messages,
            "failed": failed,
            "failedPermille": permille,
        });
        self.publish(&target.workspace_id, "mail_domain", "dmarc_failing", &data)
            .await;
        let hub = store::hub(&self.master, &target.workspace_id)
            .await
            .unwrap_or_else(|_| target.workspace_id.clone());
        let admins = match store::admins(&weldsuite_db::orm(db)).await {
            Ok(admins) => admins,
            Err(error) => {
                tracing::warn!(%error, "[dmarc] no admins to alert");
                return;
            }
        };
        let percent = permille / 10;
        for user_id in admins {
            let params = NewNotification {
                workspace_id: hub.clone(),
                user_id,
                title: format!("Mail from {} is failing DMARC", target.domain),
                body: format!(
                    "{percent}% of the mail WeldSuite sent for {} failed DMARC at a receiver. Check the domain's DKIM record under Settings › WeldMail › Domains.",
                    target.domain
                ),
                category: "mail".to_owned(),
                notification_type: "mail_dmarc_failing".to_owned(),
                entity_type: "mail_domain".to_owned(),
                entity_id: target.mail_domain_id.clone(),
                action_url: "/settings/apps/weldmail/domains".to_owned(),
                severity: "warning".to_owned(),
                actor_type: Some("system".to_owned()),
                ..NewNotification::default()
            };
            if let Err(error) = create_and_deliver(db, &self.notifier, &params).await {
                tracing::warn!(%error, "[dmarc] alert notification failed");
            }
        }
    }

    async fn publish(&self, workspace_id: &str, entity: &str, action: &str, data: &Value) {
        match EventType::catalog(entity, action) {
            Ok(event) => {
                let context = EventContext::new(workspace_id, "system", EventSource::System);
                let id = data["id"].as_str().unwrap_or_default().to_owned();
                self.events
                    .publish_and_wait(&context, EntityEvent::new(event, id, data.clone()))
                    .await;
            }
            Err(error) => tracing::error!(%error, "[dmarc] unknown entity event"),
        }
    }
}

/// The `mail-inbound` handler with the report address taken out: its
/// messages go to [`DmarcReports::ingest`], every other recipient to the
/// wrapped handler, which removes the spooled object once stored. A message
/// only for the report address is removed here.
pub struct DmarcReportRouter {
    pub dmarc: Arc<DmarcReports>,
    pub mail: Arc<dyn BatchHandler>,
    /// The bucket Haraka spools to.
    pub spool: Arc<dyn DynFileStore>,
}

impl DmarcReportRouter {
    async fn to_mail(&self, delivery: &Delivery) -> Disposition {
        self.mail
            .handle(std::slice::from_ref(delivery))
            .await
            .pop()
            .unwrap_or_else(|| Disposition::retry("the mail handler gave no answer"))
    }

    /// One delivery.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let Ok(mut envelope) = serde_json::from_slice::<Value>(&delivery.payload) else {
            return self.to_mail(delivery).await;
        };
        let recipients: Vec<String> = envelope["rcptTo"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let (ours, others): (Vec<String>, Vec<String>) =
            recipients.into_iter().partition(|r| self.dmarc.claims(r));
        if ours.is_empty() {
            return self.to_mail(delivery).await;
        }
        let Some(key) = envelope["key"].as_str().map(str::to_owned) else {
            return self.to_mail(delivery).await;
        };
        let object = match self.spool.get_boxed(&key).await {
            Ok(Some(object)) => object,
            Ok(None) => {
                tracing::info!(%key, "[dmarc] already handled (no spooled object)");
                return Disposition::Ack;
            }
            Err(error) => return Disposition::retry(format!("reading {key}: {error}")),
        };
        if let Err(error) = self.dmarc.ingest(&object.bytes).await {
            return Disposition::retry(format!("filing the DMARC report {key}: {error}"));
        }
        if !others.is_empty() {
            envelope["rcptTo"] = Value::from(others);
            let payload = match serde_json::to_vec(&envelope) {
                Ok(payload) => payload,
                Err(error) => return Disposition::retry(format!("re-encoding {key}: {error}")),
            };
            let rest = Delivery {
                payload,
                ..delivery.clone()
            };
            return self.to_mail(&rest).await;
        }
        match self.spool.delete_boxed(&key).await {
            Ok(()) => Disposition::Ack,
            Err(error) => Disposition::retry(format!("removing {key}: {error}")),
        }
    }
}

impl BatchHandler for DmarcReportRouter {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
            }
            out
        })
    }
}

#[cfg(test)]
mod tests;
