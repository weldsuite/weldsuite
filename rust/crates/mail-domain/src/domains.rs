//! Custom mail domains on the Kubernetes editions (ADR MAIL-010, "Domains
//! and addresses"): the `MailDomains` port in place of the Cloudflare Email
//! Routing and Email Sending API that `@weldsuite/worker-email` calls on
//! Global (`createDomain`, `getDomain`, `deleteDomain`).
//!
//! A domain does not have to be a WeldHost zone. Registering one answers the
//! records the customer publishes (MX to the edition's MX, the relay's SPF
//! include and DKIM key, a DMARC suggestion); verifying looks them up through
//! the edition's resolver. A domain that still has other MX records is the
//! customer's choice, not an error: it verifies once the records point here.
//!
//! Two adapters:
//! - [`ManualDomains`]: shows the records and checks them over DNS. The
//!   self-hosted default, where the relay is the customer's business.
//! - [`RelayDomains`]: the relay's domain API (per-domain DKIM, verification).
//!   A skeleton around [`RelayDomainApi`] until the relay is chosen (MAIL-010
//!   names the criteria, not the provider).

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_ports::BoxFuture;

use crate::recipients::DnsOverHttps;

/// Why a domain operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// The adapter cannot run (no relay API client, no resolver).
    NotConfigured(String),
    /// The provider or the resolver answered with an error.
    Provider(String),
}

impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured(message) | Self::Provider(message) => f.write_str(message),
        }
    }
}

/// One DNS record a domain publishes, as `mail_domains.dns_records` keeps it
/// (`MailDnsRecord`: `type`, `name`, `value`, `priority`, `verified`) plus
/// what it is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsRecord {
    /// `MX` or `TXT`.
    pub kind: &'static str,
    pub name: String,
    pub value: String,
    pub priority: Option<u16>,
    /// `mx`, `spf`, `dkim` or `dmarc`.
    pub purpose: &'static str,
    /// Whether the lookup found it (false until verified).
    pub verified: bool,
}

impl DnsRecord {
    /// The record as a `dns_records` entry.
    pub fn to_json(&self) -> Value {
        let mut record = json!({
            "type": self.kind,
            "name": self.name,
            "value": self.value,
            "purpose": self.purpose,
            "verified": self.verified,
        });
        if let Some(priority) = self.priority {
            record["priority"] = json!(priority);
        }
        record
    }
}

/// A domain's setup as the adapter sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainSetup {
    pub records: Vec<DnsRecord>,
    /// Inbound and sending work: every required record resolves.
    pub verified: bool,
    /// The DKIM selector, when the adapter publishes one.
    pub dkim_selector: Option<String>,
}

impl DomainSetup {
    /// The records as the `dns_records` column holds them.
    pub fn records_json(&self) -> Value {
        Value::Array(self.records.iter().map(DnsRecord::to_json).collect())
    }

    fn record(&self, purpose: &str) -> Option<&DnsRecord> {
        self.records.iter().find(|r| r.purpose == purpose)
    }

    /// The SPF, DKIM and DMARC records resolved.
    pub fn spf_verified(&self) -> bool {
        self.record("spf").is_some_and(|r| r.verified)
    }

    pub fn dkim_verified(&self) -> bool {
        self.record("dkim").is_some_and(|r| r.verified)
    }

    pub fn dmarc_verified(&self) -> bool {
        self.record("dmarc").is_some_and(|r| r.verified)
    }

    /// The DKIM record's value (`generate-dkim`), when there is one.
    pub fn dkim_record(&self) -> Option<&DnsRecord> {
        self.record("dkim")
    }
}

/// Registering, checking and removing a customer's mail domain.
pub trait MailDomains: Send + Sync {
    /// The provider written to `mail_domains.{mail,send,receive}_provider`.
    fn provider(&self) -> &str;

    /// Make `domain` known to the relay and the MX, and answer the records
    /// to publish. Idempotent: registering a known domain answers its records.
    fn register<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>>;

    /// Look the records up and say which resolve.
    fn verify<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>>;

    /// Stop receiving and sending for `domain`. Callers treat a failure as
    /// best effort, as `deleteDomain` is on Global.
    fn deregister<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>>;
}

/// What the edition publishes for a domain: its MX, the relay's SPF include
/// and DKIM key, and the DMARC policy it suggests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainRecordsConfig {
    /// The edition's MX host (`mx.<edition domain>`), Haraka behind the load
    /// balancer.
    pub mx_host: String,
    /// The relay's SPF include (`include:<this>`); `None` publishes `mx`.
    pub spf_include: Option<String>,
    /// The relay's DKIM selector and TXT value (`v=DKIM1; k=rsa; p=…`), when
    /// the relay signs with one key for every domain.
    pub dkim: Option<(String, String)>,
    /// The DMARC record suggested at `_dmarc.<domain>`.
    pub dmarc: String,
}

impl DomainRecordsConfig {
    /// The records `domain` must publish, none verified yet.
    pub fn records_for(&self, domain: &str) -> Vec<DnsRecord> {
        let mut records = vec![
            DnsRecord {
                kind: "MX",
                name: domain.to_owned(),
                value: self.mx_host.clone(),
                priority: Some(10),
                purpose: "mx",
                verified: false,
            },
            DnsRecord {
                kind: "TXT",
                name: domain.to_owned(),
                value: self.spf_include.as_ref().map_or_else(
                    || "v=spf1 mx ~all".to_owned(),
                    |include| format!("v=spf1 include:{include} ~all"),
                ),
                priority: None,
                purpose: "spf",
                verified: false,
            },
        ];
        if let Some((selector, value)) = &self.dkim {
            records.push(DnsRecord {
                kind: "TXT",
                name: format!("{selector}._domainkey.{domain}"),
                value: value.clone(),
                priority: None,
                purpose: "dkim",
                verified: false,
            });
        }
        records.push(DnsRecord {
            kind: "TXT",
            name: format!("_dmarc.{domain}"),
            value: self.dmarc.clone(),
            priority: None,
            purpose: "dmarc",
            verified: false,
        });
        records
    }
}

/// The `manual` adapter: the customer publishes the records (or the
/// edition's DNS automation does), and verification is a DNS lookup through
/// the edition's resolver (DNS over HTTPS). Nothing to register or remove at
/// a provider: the relay is configured out of band.
pub struct ManualDomains {
    config: DomainRecordsConfig,
    doh: Arc<dyn DnsOverHttps>,
    /// The resolver's DNS-over-HTTPS endpoint (`MAIL_DNS_RESOLVER`).
    resolver: String,
}

impl ManualDomains {
    pub fn new(config: DomainRecordsConfig, doh: Arc<dyn DnsOverHttps>, resolver: String) -> Self {
        Self {
            config,
            doh,
            resolver,
        }
    }

    /// The `data` of every answer of `name`/`kind`, or an error when the
    /// resolver could not be asked.
    async fn lookup(&self, name: &str, kind: &str) -> Result<Vec<String>, DomainError> {
        let url = format!("{}?name={}&type={kind}", self.resolver, encode(name));
        let (status, body) = self.doh.get(&url).await.map_err(|error| {
            DomainError::Provider(format!("DNS lookup of {name} failed: {error}"))
        })?;
        if !(200..300).contains(&status) {
            return Err(DomainError::Provider(format!(
                "DNS lookup of {name} answered {status}"
            )));
        }
        let json: Value = serde_json::from_str(&body)
            .map_err(|_| DomainError::Provider(format!("DNS lookup of {name}: not JSON")))?;
        Ok(json
            .get("Answer")
            .and_then(Value::as_array)
            .map(|answers| {
                answers
                    .iter()
                    .filter_map(|a| a.get("data").and_then(Value::as_str))
                    .map(unquote_txt)
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn check(&self, record: &DnsRecord) -> Result<bool, DomainError> {
        let answers = self.lookup(&record.name, record.kind).await?;
        Ok(answers.iter().any(|data| record_matches(record, data)))
    }
}

impl MailDomains for ManualDomains {
    fn provider(&self) -> &'static str {
        "manual"
    }

    fn register<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
        Box::pin(async move {
            Ok(DomainSetup {
                records: self.config.records_for(domain),
                verified: false,
                dkim_selector: self.config.dkim.as_ref().map(|(s, _)| s.clone()),
            })
        })
    }

    fn verify<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
        Box::pin(async move {
            let mut records = self.config.records_for(domain);
            for record in &mut records {
                record.verified = self.check(record).await?;
            }
            // DMARC is a suggestion: inbound and sending work without it.
            let verified = records
                .iter()
                .filter(|r| r.purpose != "dmarc")
                .all(|r| r.verified);
            Ok(DomainSetup {
                records,
                verified,
                dkim_selector: self.config.dkim.as_ref().map(|(s, _)| s.clone()),
            })
        })
    }

    fn deregister<'a>(&'a self, _domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
        Box::pin(async { Ok(()) })
    }
}

/// Whether a resolved `data` value is the record asked for. MX answers are
/// `<priority> <host>.`; TXT answers are compared after the quotes are gone.
fn record_matches(record: &DnsRecord, data: &str) -> bool {
    match record.purpose {
        "mx" => {
            let host = data.split_whitespace().last().unwrap_or_default();
            host.trim_end_matches('.')
                .eq_ignore_ascii_case(record.value.trim_end_matches('.'))
        }
        "spf" => {
            let wanted = record
                .value
                .split_whitespace()
                .find(|term| term.starts_with("include:") || *term == "mx")
                .unwrap_or_default();
            data.starts_with("v=spf1") && data.split_whitespace().any(|term| term == wanted)
        }
        "dkim" => {
            let key = |text: &str| {
                text.split(';')
                    .map(str::trim)
                    .find_map(|part| part.strip_prefix("p="))
                    .map(str::to_owned)
            };
            key(data).is_some() && key(data) == key(&record.value)
        }
        "dmarc" => data.starts_with("v=DMARC1"),
        _ => false,
    }
}

/// A TXT answer's text: DNS-over-HTTPS answers quote it and split long ones into
/// `"…" "…"` chunks.
fn unquote_txt(data: &str) -> String {
    let trimmed = data.trim();
    if !trimmed.starts_with('"') {
        return trimmed.to_owned();
    }
    trimmed
        .split("\" \"")
        .map(|chunk| chunk.trim_matches('"'))
        .collect()
}

/// `encodeURIComponent` for a host name.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// A relay's domain API: what [`RelayDomains`] needs from the chosen
/// provider (Scaleway TEM, Brevo, …). No client is written until the relay
/// is chosen (MAIL-010).
pub trait RelayDomainApi: Send + Sync {
    /// The provider's name, written to `mail_domains`.
    fn name(&self) -> &str;
    /// Create (or find) the sending domain: its DKIM selector and record.
    fn create_domain<'a>(
        &'a self,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<(String, String), DomainError>>;
    /// Whether the provider has verified the domain's SPF and DKIM.
    fn domain_status<'a>(
        &'a self,
        domain: &'a str,
    ) -> BoxFuture<'a, Result<(bool, bool), DomainError>>;
    fn delete_domain<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>>;
}

/// The relay-API adapter: the relay owns DKIM per domain and verifies SPF and
/// DKIM itself; the MX record is still checked over DNS by [`ManualDomains`].
/// Without an API client every call answers [`DomainError::NotConfigured`].
pub struct RelayDomains {
    api: Option<Arc<dyn RelayDomainApi>>,
    /// MX and DMARC, and the lookups.
    dns: ManualDomains,
}

impl RelayDomains {
    pub fn new(api: Option<Arc<dyn RelayDomainApi>>, dns: ManualDomains) -> Self {
        Self { api, dns }
    }

    fn api(&self) -> Result<&Arc<dyn RelayDomainApi>, DomainError> {
        self.api.as_ref().ok_or_else(|| {
            DomainError::NotConfigured(
                "No relay domain API is configured (MAIL-010: the relay is not chosen yet)"
                    .to_owned(),
            )
        })
    }

    /// The manual records with the relay's DKIM record in place of the
    /// edition-wide one.
    fn records(&self, domain: &str, dkim: &(String, String)) -> Vec<DnsRecord> {
        let mut records: Vec<DnsRecord> = self
            .dns
            .config
            .records_for(domain)
            .into_iter()
            .filter(|r| r.purpose != "dkim")
            .collect();
        records.insert(
            2,
            DnsRecord {
                kind: "TXT",
                name: format!("{}._domainkey.{domain}", dkim.0),
                value: dkim.1.clone(),
                priority: None,
                purpose: "dkim",
                verified: false,
            },
        );
        records
    }
}

impl MailDomains for RelayDomains {
    fn provider(&self) -> &str {
        self.api.as_ref().map_or("relay", |api| api.name())
    }

    fn register<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
        Box::pin(async move {
            let dkim = self.api()?.create_domain(domain).await?;
            Ok(DomainSetup {
                records: self.records(domain, &dkim),
                verified: false,
                dkim_selector: Some(dkim.0),
            })
        })
    }

    fn verify<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
        Box::pin(async move {
            let api = self.api()?;
            let dkim = api.create_domain(domain).await?;
            let (spf_ok, dkim_ok) = api.domain_status(domain).await?;
            let mut records = self.records(domain, &dkim);
            for record in &mut records {
                record.verified = match record.purpose {
                    "spf" => spf_ok,
                    "dkim" => dkim_ok,
                    _ => self.dns.check(record).await?,
                };
            }
            let verified = records
                .iter()
                .filter(|r| r.purpose != "dmarc")
                .all(|r| r.verified);
            Ok(DomainSetup {
                records,
                verified,
                dkim_selector: Some(dkim.0),
            })
        })
    }

    fn deregister<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
        Box::pin(async move { self.api()?.delete_domain(domain).await })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// Answers by URL, and remembers what was asked.
    #[derive(Default)]
    struct FakeDoh {
        answers: HashMap<String, Vec<&'static str>>,
        asked: Mutex<Vec<String>>,
    }

    impl FakeDoh {
        fn with(mut self, name: &str, kind: &str, data: &[&'static str]) -> Self {
            self.answers.insert(
                format!("https://resolver.test/dns-query?name={name}&type={kind}"),
                data.to_vec(),
            );
            self
        }
    }

    impl DnsOverHttps for FakeDoh {
        fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
            self.asked.lock().expect("lock").push(url.to_owned());
            let answers = self.answers.get(url).cloned().unwrap_or_default();
            let body = json!({
                "Status": 0,
                "Answer": answers.iter().map(|d| json!({ "data": d })).collect::<Vec<_>>(),
            });
            Box::pin(async move { Ok((200, body.to_string())) })
        }
    }

    fn config() -> DomainRecordsConfig {
        DomainRecordsConfig {
            mx_host: "mx.eu.weldsuite.test".to_owned(),
            spf_include: Some("spf.relay.test".to_owned()),
            dkim: Some(("ws1".to_owned(), "v=DKIM1; k=rsa; p=ABC123".to_owned())),
            dmarc: "v=DMARC1; p=none".to_owned(),
        }
    }

    fn manual(doh: FakeDoh) -> ManualDomains {
        ManualDomains::new(
            config(),
            Arc::new(doh),
            "https://resolver.test/dns-query".to_owned(),
        )
    }

    #[tokio::test]
    async fn register_answers_the_records_to_publish() {
        let setup = manual(FakeDoh::default())
            .register("acme.test")
            .await
            .expect("domain setup");
        assert!(!setup.verified);
        assert_eq!(setup.dkim_selector.as_deref(), Some("ws1"));
        assert_eq!(
            setup.records_json(),
            json!([
                { "type": "MX", "name": "acme.test", "value": "mx.eu.weldsuite.test", "priority": 10, "purpose": "mx", "verified": false },
                { "type": "TXT", "name": "acme.test", "value": "v=spf1 include:spf.relay.test ~all", "purpose": "spf", "verified": false },
                { "type": "TXT", "name": "ws1._domainkey.acme.test", "value": "v=DKIM1; k=rsa; p=ABC123", "purpose": "dkim", "verified": false },
                { "type": "TXT", "name": "_dmarc.acme.test", "value": "v=DMARC1; p=none", "purpose": "dmarc", "verified": false },
            ])
        );
    }

    #[tokio::test]
    async fn verify_needs_mx_spf_and_dkim_but_not_dmarc() {
        let doh = FakeDoh::default()
            .with("acme.test", "MX", &["10 mx.eu.weldsuite.test."])
            .with(
                "acme.test",
                "TXT",
                &["\"v=spf1 include:spf.relay.test ~all\""],
            )
            .with(
                "ws1._domainkey.acme.test",
                "TXT",
                &["\"v=DKIM1; k=rsa; \" \"p=ABC123\""],
            );
        let setup = manual(doh).verify("acme.test").await.expect("domain setup");
        assert!(setup.verified);
        assert!(setup.spf_verified() && setup.dkim_verified());
        assert!(!setup.dmarc_verified());
    }

    #[tokio::test]
    async fn another_providers_mx_is_not_an_error_only_unverified() {
        let doh = FakeDoh::default()
            .with("acme.test", "MX", &["1 aspmx.l.google.com."])
            .with(
                "acme.test",
                "TXT",
                &["\"v=spf1 include:spf.relay.test ~all\""],
            )
            .with(
                "ws1._domainkey.acme.test",
                "TXT",
                &["\"v=DKIM1; p=ABC123\""],
            );
        let setup = manual(doh).verify("acme.test").await.expect("domain setup");
        assert!(!setup.verified);
        assert!(!setup.records[0].verified);
        assert!(setup.spf_verified());
    }

    #[tokio::test]
    async fn the_relay_adapter_needs_its_api() {
        let relay = RelayDomains::new(None, manual(FakeDoh::default()));
        assert_eq!(relay.provider(), "relay");
        assert!(matches!(
            relay.register("acme.test").await,
            Err(DomainError::NotConfigured(_))
        ));
        assert!(matches!(
            relay.deregister("acme.test").await,
            Err(DomainError::NotConfigured(_))
        ));
    }

    struct FakeRelay;

    impl RelayDomainApi for FakeRelay {
        fn name(&self) -> &'static str {
            "fakerelay"
        }
        fn create_domain<'a>(
            &'a self,
            _domain: &'a str,
        ) -> BoxFuture<'a, Result<(String, String), DomainError>> {
            Box::pin(async { Ok(("rly".to_owned(), "v=DKIM1; p=RELAYKEY".to_owned())) })
        }
        fn domain_status<'a>(
            &'a self,
            _domain: &'a str,
        ) -> BoxFuture<'a, Result<(bool, bool), DomainError>> {
            Box::pin(async { Ok((true, true)) })
        }
        fn delete_domain<'a>(&'a self, _domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn the_relay_adapter_takes_dkim_from_the_relay_and_mx_from_dns() {
        let doh = FakeDoh::default().with("acme.test", "MX", &["10 mx.eu.weldsuite.test."]);
        let relay = RelayDomains::new(Some(Arc::new(FakeRelay)), manual(doh));
        assert_eq!(relay.provider(), "fakerelay");
        let setup = relay.verify("acme.test").await.expect("domain setup");
        assert!(setup.verified);
        assert_eq!(setup.dkim_selector.as_deref(), Some("rly"));
        assert_eq!(
            setup.dkim_record().map(|r| r.name.as_str()),
            Some("rly._domainkey.acme.test")
        );
    }
}
