//! The delivery workers: claim due recipients of this node's pools, group
//! them by destination domain, and deliver each group over one connection.
//!
//! Per group:
//! 1. MX lookup: NXDOMAIN or a null MX bounces, a DNS failure defers.
//! 2. MTA-STS: an `enforce` policy keeps only the MX hosts it lists and
//!    requires verified TLS; `testing` tries verified TLS and falls back.
//! 3. Shaping: a free connection slot for the provider (else the group waits
//!    a minute, no attempt counted).
//! 4. Connect to the MX hosts in preference order (two addresses each); an
//!    opportunistic handshake that fails is retried in plaintext.
//! 5. Per recipient: the IP's warm-up cap, the provider's per-minute budget,
//!    then one transaction with the recipient's VERP return path and the
//!    message DKIM-signed for its From domain.
//!
//! Outcomes: `250` delivered; 4xx and broken connections defer (retry
//! schedule, then expired after `MTA_MAX_QUEUE_AGE`); 5xx bounce, hard when
//! the address does not exist ([`crate::feedback::hard_failure`]).

use std::collections::{BTreeMap, HashMap};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::crypto::Keys;
use crate::dns::{DnsError, MxAnswer, Resolver};
use crate::domains::Signers;
use crate::feedback::hard_failure;
use crate::message::{self, domain_of};
use crate::mta_sts::{Lookup, Mode, Sts};
use crate::retry;
use crate::shaping::{Shaper, Slot, classify};
use crate::smtp::client::{
    ClientSettings, ConnectError, Connection, Needs, SendOutcome, TlsMode, TlsOutcome,
};
use crate::store::{Claimed, Outcome, Store, StoredMessage};
use crate::verp;

/// Everything a worker needs.
pub struct Delivery {
    pub store: Store,
    pub keys: Keys,
    pub resolver: Arc<Resolver>,
    pub sts: Arc<Sts>,
    pub shaper: Arc<Shaper>,
    pub signers: Arc<Signers>,
    pub client: ClientSettings,
    pub pools: Vec<String>,
    /// This node's name (lease owner).
    pub owner: String,
    pub bounce_domain: Option<String>,
    pub max_queue_age: Duration,
    pub warmup: Vec<u32>,
    pub concurrency: usize,
}

const LEASE: Duration = Duration::from_mins(15);
const SHAPED_WAIT: Duration = Duration::from_secs(60);
const MAX_MX_HOSTS: usize = 5;
const ADDRESSES_PER_HOST: usize = 2;

/// The policy in force for one group, for TLS mode and TLS-RPT.
struct StsState {
    policy_type: &'static str,
    lines: Vec<String>,
    mode: Option<Mode>,
}

impl Delivery {
    /// Runs until `shutdown`; in-flight groups finish first.
    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) {
        let slots = Arc::new(Semaphore::new(self.concurrency));
        let mut tasks = tokio::task::JoinSet::new();
        loop {
            while tasks.try_join_next().is_some() {}
            let free = slots.available_permits();
            let claimed = if free == 0 {
                Vec::new()
            } else {
                let limit = i64::try_from((free * 8).min(400)).unwrap_or(400);
                match self
                    .store
                    .claim(&self.pools, &self.owner, limit, LEASE)
                    .await
                {
                    Ok(claimed) => claimed,
                    Err(error) => {
                        tracing::warn!(%error, "claiming the queue failed");
                        Vec::new()
                    }
                }
            };
            let idle = claimed.is_empty();
            for (domain, group) in group_by_domain(claimed) {
                let Ok(permit) = Arc::clone(&slots).acquire_owned().await else {
                    return;
                };
                let this = Arc::clone(&self);
                tasks.spawn(async move {
                    this.deliver_group(&domain, group).await;
                    drop(permit);
                });
            }
            let pause = if idle {
                Duration::from_secs(1)
            } else {
                Duration::from_millis(50)
            };
            tokio::select! {
                () = shutdown.cancelled() => break,
                () = tokio::time::sleep(pause) => {}
            }
        }
        while tasks.join_next().await.is_some() {}
    }

    async fn finish(&self, claimed: &Claimed, sender: &str, outcome: Outcome) {
        let outcome = match outcome {
            Outcome::Deferred { response, delay }
                if retry::expired(
                    Duration::from_secs_f64(claimed.age_seconds.max(0.0)) + delay,
                    self.max_queue_age,
                ) =>
            {
                Outcome::Expired {
                    response: format!(
                        "{response} (gave up after {} attempts)",
                        claimed.attempts + 1
                    ),
                }
            }
            other => other,
        };
        tracing::info!(
            recipient = %claimed.id,
            domain = %claimed.domain,
            pool = %claimed.pool,
            outcome = ?outcome,
            "delivery attempt"
        );
        if let Err(error) = self.store.finish(claimed, sender, &outcome).await {
            tracing::error!(%error, recipient = %claimed.id, "recording an outcome failed; the lease will expire");
        }
    }

    async fn defer_all(
        &self,
        group: &[Claimed],
        messages: &HashMap<String, Arc<StoredMessage>>,
        response: &str,
    ) {
        for claimed in group {
            let sender = messages
                .get(&claimed.message_id)
                .map_or("", |m| m.header_from.as_str());
            let delay = retry::delay(u32::try_from(claimed.attempts + 1).unwrap_or(u32::MAX));
            self.finish(
                claimed,
                sender,
                Outcome::Deferred {
                    response: response.to_owned(),
                    delay,
                },
            )
            .await;
        }
    }

    async fn bounce_all(
        &self,
        group: &[Claimed],
        messages: &HashMap<String, Arc<StoredMessage>>,
        response: &str,
    ) {
        for claimed in group {
            let sender = messages
                .get(&claimed.message_id)
                .map_or("", |m| m.header_from.as_str());
            self.finish(
                claimed,
                sender,
                Outcome::Bounced {
                    response: response.to_owned(),
                    hard: true,
                },
            )
            .await;
        }
    }

    async fn release_all(&self, group: &[Claimed], delay: Duration) {
        for claimed in group {
            if let Err(error) = self.store.release(&claimed.id, delay).await {
                tracing::warn!(%error, "releasing a recipient failed; the lease will expire");
            }
        }
    }

    async fn load_messages(&self, group: &[Claimed]) -> HashMap<String, Arc<StoredMessage>> {
        let mut messages = HashMap::new();
        for claimed in group {
            if messages.contains_key(&claimed.message_id) {
                continue;
            }
            match self.store.message(&claimed.message_id).await {
                Ok(Some(message)) => {
                    messages.insert(claimed.message_id.clone(), Arc::new(message));
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%error, "loading a message failed"),
            }
        }
        messages
    }

    async fn deliver_group(&self, domain: &str, group: Vec<Claimed>) {
        let messages = self.load_messages(&group).await;
        let (group, missing): (Vec<Claimed>, Vec<Claimed>) = group.into_iter().partition(|c| {
            messages
                .get(&c.message_id)
                .is_some_and(|m| !m.body.is_empty())
        });
        for claimed in &missing {
            self.finish(
                claimed,
                "",
                Outcome::Expired {
                    response: "554 5.3.0 the queued message is gone".into(),
                },
            )
            .await;
        }
        if group.is_empty() {
            return;
        }

        let Some(hosts) = self.mx_hosts(domain, &group, &messages).await else {
            return;
        };
        let (sts, hosts) = self.apply_sts(domain, hosts).await;
        if hosts.is_empty() {
            let _ = self
                .store
                .record_tls(
                    domain,
                    sts.policy_type,
                    &sts.lines,
                    "",
                    Some("validation-failure"),
                )
                .await;
            return self
                .defer_all(
                    &group,
                    &messages,
                    "451 4.7.5 no MX host matches the domain's MTA-STS policy",
                )
                .await;
        }

        let provider = classify(&hosts[0]);
        let Some(slot) = self.shaper.try_connect(provider, domain) else {
            return self.release_all(&group, SHAPED_WAIT).await;
        };

        match self.connect(domain, &hosts, &sts).await {
            Ok(connection) => self.send_all(&group, &messages, connection, &slot).await,
            Err(response) => self.defer_all(&group, &messages, &response).await,
        }
    }

    /// The domain's MX hosts. `None` when it has none to try, after the
    /// group has been bounced (null MX, no such domain) or deferred (DNS
    /// trouble).
    async fn mx_hosts(
        &self,
        domain: &str,
        group: &[Claimed],
        messages: &HashMap<String, Arc<StoredMessage>>,
    ) -> Option<Vec<String>> {
        match self.resolver.mx(domain).await {
            Ok(MxAnswer::Hosts(hosts)) => Some(hosts),
            Ok(MxAnswer::NullMx) => {
                self.bounce_all(
                    group,
                    messages,
                    "556 5.1.10 the domain accepts no mail (null MX)",
                )
                .await;
                None
            }
            Err(DnsError::NoSuchName) => {
                self.bounce_all(group, messages, "550 5.1.2 the domain does not exist")
                    .await;
                None
            }
            Err(DnsError::Temporary(error)) => {
                self.defer_all(group, messages, &format!("451 4.4.3 DNS: {error}"))
                    .await;
                None
            }
        }
    }

    /// The domain's MTA-STS policy, and the MX hosts it allows (all of them
    /// unless the policy enforces).
    async fn apply_sts(&self, domain: &str, hosts: Vec<String>) -> (StsState, Vec<String>) {
        match self.sts.lookup(domain).await {
            Lookup::Policy(policy) if policy.mode != Mode::None => {
                let state = StsState {
                    policy_type: "sts",
                    lines: policy.lines.clone(),
                    mode: Some(policy.mode),
                };
                let hosts = if policy.mode == Mode::Enforce {
                    hosts.into_iter().filter(|h| policy.allows(h)).collect()
                } else {
                    hosts
                };
                (state, hosts)
            }
            Lookup::FetchFailed => {
                let _ = self
                    .store
                    .record_tls(
                        domain,
                        "no-policy-found",
                        &[],
                        "",
                        Some("sts-policy-fetch-error"),
                    )
                    .await;
                (
                    StsState {
                        policy_type: "no-policy-found",
                        lines: Vec::new(),
                        mode: None,
                    },
                    hosts,
                )
            }
            _ => (
                StsState {
                    policy_type: "no-policy-found",
                    lines: Vec::new(),
                    mode: None,
                },
                hosts,
            ),
        }
    }

    /// The first MX host that takes a connection, in preference order.
    /// `Err` carries the last failure as a reply text.
    async fn connect(
        &self,
        domain: &str,
        hosts: &[String],
        sts: &StsState,
    ) -> Result<Connection, String> {
        let mut last = "451 4.4.1 no MX host could be reached".to_owned();
        for host in hosts.iter().take(MAX_MX_HOSTS) {
            let addresses = match self.resolver.ipv4(host).await {
                Ok(addresses) => addresses,
                Err(error) => {
                    last = format!("451 4.4.3 DNS for {host}: {error}");
                    continue;
                }
            };
            if addresses.is_empty() {
                last = format!("451 4.4.4 {host} has no IPv4 address");
            }
            for ip in addresses.into_iter().take(ADDRESSES_PER_HOST) {
                match self.connect_one(domain, host, ip, sts).await {
                    Ok(connection) => return Ok(connection),
                    Err(error) => {
                        tracing::debug!(%host, %ip, %error, "MX connection failed");
                        last = deferral_text(&error);
                    }
                }
            }
        }
        Err(last)
    }

    /// One address, with the TLS mode the policy asks for and the fallbacks
    /// it allows; every TLS outcome is counted for TLS-RPT.
    async fn connect_one(
        &self,
        domain: &str,
        host: &str,
        ip: Ipv4Addr,
        sts: &StsState,
    ) -> Result<Connection, ConnectError> {
        let first = match sts.mode {
            Some(Mode::Enforce | Mode::Testing) => TlsMode::Required,
            _ => TlsMode::Opportunistic,
        };
        let result = Connection::open(&self.client, host, ip, first).await;
        let record = |failure: Option<&'static str>| async move {
            if let Err(error) = self
                .store
                .record_tls(domain, sts.policy_type, &sts.lines, host, failure)
                .await
            {
                tracing::debug!(%error, "recording a TLS result failed");
            }
        };
        match result {
            Ok(connection) => {
                if connection.tls == TlsOutcome::Plain {
                    record(Some("starttls-not-supported")).await;
                } else {
                    record(None).await;
                }
                Ok(connection)
            }
            Err(error) => {
                if let Some(failure) = tls_failure(&error) {
                    record(Some(failure)).await;
                }
                let fallback = match (&error, sts.mode) {
                    // Enforce: no fallback.
                    (_, Some(Mode::Enforce)) => None,
                    // Testing: report, then deliver as without a policy.
                    (ConnectError::Tls { .. } | ConnectError::NoStartTls, Some(Mode::Testing)) => {
                        Some(TlsMode::Opportunistic)
                    }
                    // A broken opportunistic handshake: plaintext beats nothing.
                    (
                        ConnectError::Tls {
                            required: false, ..
                        },
                        _,
                    ) => Some(TlsMode::Off),
                    _ => None,
                };
                match fallback {
                    Some(mode) => Connection::open(&self.client, host, ip, mode).await,
                    None => Err(error),
                }
            }
        }
    }

    /// The message as it goes to one recipient: signed once per message
    /// (cached), with the recipient's id header in front.
    async fn prepare(
        &self,
        message: &StoredMessage,
        prepared: &mut HashMap<String, Arc<Vec<u8>>>,
    ) -> Arc<Vec<u8>> {
        if let Some(bytes) = prepared.get(&message.id) {
            return Arc::clone(bytes);
        }
        let from_domain = domain_of(&message.header_from).unwrap_or_default();
        let mut bytes = message::prepend_header(
            &message.body,
            "Feedback-ID",
            &format!("{}:{}:weldsuite", message.pool, from_domain),
        );
        match self.signers.for_domain(&from_domain, &message.pool).await {
            Ok(Some(signer)) => {
                let now = time::OffsetDateTime::now_utc().unix_timestamp();
                match signer.sign(&bytes, now) {
                    Ok(header) => {
                        let mut out = header.into_bytes();
                        out.extend_from_slice(&bytes);
                        bytes = out;
                    }
                    Err(error) => {
                        tracing::error!(%error, message = %message.id, "DKIM signing failed; sending unsigned");
                    }
                }
            }
            Ok(None) => {
                tracing::warn!(domain = %from_domain, message = %message.id, "no DKIM key covers the sender; sending unsigned");
            }
            Err(error) => tracing::error!(%error, "loading the DKIM key failed; sending unsigned"),
        }
        let bytes = Arc::new(bytes);
        prepared.insert(message.id.clone(), Arc::clone(&bytes));
        bytes
    }

    async fn send_all(
        &self,
        group: &[Claimed],
        messages: &HashMap<String, Arc<StoredMessage>>,
        mut connection: Connection,
        slot: &Slot,
    ) {
        let source = self
            .client
            .source_ip
            .map_or_else(|| "default".to_owned(), |ip| ip.to_string());
        let mut signed = HashMap::new();
        for (index, claimed) in group.iter().enumerate() {
            let Some(message) = messages.get(&claimed.message_id) else {
                continue;
            };
            match self.store.reserve_ip(&source, &self.warmup).await {
                Ok(true) => {}
                Ok(false) => {
                    let wait = self.store.seconds_to_tomorrow().await.unwrap_or(3600.0);
                    tracing::info!(ip = %source, "warm-up cap reached for today");
                    self.release_all(&group[index..], Duration::from_secs_f64(wait.max(60.0)))
                        .await;
                    break;
                }
                Err(error) => {
                    tracing::warn!(%error, "warm-up counter unavailable");
                    self.release_all(&group[index..], SHAPED_WAIT).await;
                    break;
                }
            }
            if !self.wait_for_budget(slot).await {
                self.release_all(&group[index..], SHAPED_WAIT).await;
                break;
            }
            let prepared = self.prepare(message, &mut signed).await;
            let with_id = message::prepend_header(&prepared, "X-WeldSuite-Mta-Id", &claimed.id);
            let wire = message::dot_stuff(&with_id);
            let mail_from = match &self.bounce_domain {
                Some(domain) => verp::address(&self.keys, &claimed.id, domain),
                None => message.mail_from.clone(),
            };
            let needs = needs(with_id.len(), &with_id, &mail_from, &claimed.address);
            let result = connection
                .send(&mail_from, &claimed.address, &wire, needs)
                .await;
            let (outcome, unusable) = outcome_of(result, claimed.attempts);
            let response = match &outcome {
                Outcome::Deferred { response, .. } => Some(response.clone()),
                _ => None,
            };
            self.finish(claimed, &message.header_from, outcome).await;
            if unusable {
                let rest = &group[index + 1..];
                let response = response.unwrap_or_else(|| "451 4.4.2 connection closed".into());
                self.defer_all(rest, messages, &response).await;
                return;
            }
        }
        connection.quit().await;
    }

    /// Waits up to 30 s for the provider's per-minute budget.
    async fn wait_for_budget(&self, slot: &Slot) -> bool {
        for _ in 0..30 {
            if slot.take_message() {
                return true;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        false
    }
}

/// Groups claimed recipients by destination domain.
fn group_by_domain(claimed: Vec<Claimed>) -> BTreeMap<String, Vec<Claimed>> {
    let mut groups: BTreeMap<String, Vec<Claimed>> = BTreeMap::new();
    for item in claimed {
        groups.entry(item.domain.clone()).or_default().push(item);
    }
    groups
}

/// The reply a refused or broken attempt is recorded with.
fn deferral_text(error: &ConnectError) -> String {
    match error {
        ConnectError::Refused(reply) => format!("{} (at connect)", reply.summary()),
        ConnectError::Network(message) => format!("451 4.4.1 {message}"),
        ConnectError::Tls { message, .. } => format!("451 4.7.5 TLS: {message}"),
        ConnectError::NoStartTls => "451 4.7.5 STARTTLS required by MTA-STS but not offered".into(),
    }
}

/// The TLS-RPT result type of a failed connection, if TLS was the problem.
fn tls_failure(error: &ConnectError) -> Option<&'static str> {
    match error {
        ConnectError::NoStartTls => Some("starttls-not-supported"),
        ConnectError::Tls {
            required: true,
            message,
        } if message.to_lowercase().contains("name") => Some("certificate-host-mismatch"),
        ConnectError::Tls {
            required: true,
            message,
        } if message.to_lowercase().contains("expired") => Some("certificate-expired"),
        ConnectError::Tls { required: true, .. } => Some("validation-failure"),
        _ => None,
    }
}

/// How a send outcome is recorded; `true` when the connection is unusable
/// afterwards.
fn outcome_of(result: SendOutcome, attempts: i32) -> (Outcome, bool) {
    let next = u32::try_from(attempts + 1).unwrap_or(u32::MAX);
    match result {
        SendOutcome::Accepted(reply) => (
            Outcome::Delivered {
                response: reply.summary(),
            },
            false,
        ),
        SendOutcome::Refused(reply) if reply.is_transient() => (
            Outcome::Deferred {
                response: reply.summary(),
                delay: retry::delay(next),
            },
            reply.code == 421,
        ),
        SendOutcome::Refused(reply) => {
            let hard = hard_failure(reply.enhanced(), reply.code, &reply.text());
            (
                Outcome::Bounced {
                    response: reply.summary(),
                    hard,
                },
                false,
            )
        }
        SendOutcome::Broken(message) => (
            Outcome::Deferred {
                response: format!("451 4.4.2 connection lost: {message}"),
                delay: retry::delay(next),
            },
            true,
        ),
    }
}

/// What a message needs from the server.
fn needs(wire_len: usize, body: &[u8], mail_from: &str, to: &str) -> Needs {
    Needs {
        eight_bit: message::is_8bit(body),
        smtputf8: !mail_from.is_ascii() || !to.is_ascii(),
        size: wire_len,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smtp::Reply;

    #[test]
    fn maps_send_outcomes() {
        let (outcome, unusable) = outcome_of(SendOutcome::Accepted(Reply::new(250, "2.0.0 ok")), 0);
        assert_eq!(
            outcome,
            Outcome::Delivered {
                response: "250 2.0.0 ok".into()
            }
        );
        assert!(!unusable);
        let (outcome, _) = outcome_of(
            SendOutcome::Refused(Reply::new(550, "5.1.1 no such user")),
            0,
        );
        assert_eq!(
            outcome,
            Outcome::Bounced {
                response: "550 5.1.1 no such user".into(),
                hard: true
            }
        );
        let (outcome, _) = outcome_of(SendOutcome::Refused(Reply::new(550, "5.7.1 spam")), 0);
        assert!(matches!(outcome, Outcome::Bounced { hard: false, .. }));
        let (outcome, unusable) =
            outcome_of(SendOutcome::Refused(Reply::new(421, "4.7.0 slow down")), 0);
        assert!(matches!(outcome, Outcome::Deferred { .. }));
        assert!(unusable);
        let (_, unusable) = outcome_of(SendOutcome::Broken("reset".into()), 2);
        assert!(unusable);
    }

    #[test]
    fn names_tls_failures_for_tls_rpt() {
        assert_eq!(
            tls_failure(&ConnectError::NoStartTls),
            Some("starttls-not-supported")
        );
        assert_eq!(
            tls_failure(&ConnectError::Tls {
                message: "invalid peer certificate: NotValidForName".into(),
                required: true
            }),
            Some("certificate-host-mismatch")
        );
        assert_eq!(
            tls_failure(&ConnectError::Tls {
                message: "UnknownIssuer".into(),
                required: true
            }),
            Some("validation-failure")
        );
        assert_eq!(
            tls_failure(&ConnectError::Tls {
                message: "x".into(),
                required: false
            }),
            None
        );
        assert_eq!(tls_failure(&ConnectError::Network("x".into())), None);
    }

    #[test]
    fn groups_by_domain_and_flags_utf8() {
        let claimed = |id: &str, domain: &str| Claimed {
            id: id.into(),
            message_id: "m".into(),
            pool: "customer".into(),
            address: format!("x@{domain}"),
            domain: domain.into(),
            attempts: 0,
            age_seconds: 0.0,
        };
        let groups = group_by_domain(vec![
            claimed("1", "a.eu"),
            claimed("2", "b.eu"),
            claimed("3", "a.eu"),
        ]);
        assert_eq!(groups["a.eu"].len(), 2);
        assert!(needs(10, b"caf\xc3\xa9", "a@b.eu", "c@d.eu").eight_bit);
        assert!(needs(10, b"x", "a@b.eu", "jos\u{e9}@d.eu").smtputf8);
    }
}
