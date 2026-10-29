//! The outbound ledger's logic (`outbound/ledger-core.ts`), without the
//! storage around it.
//!
//! One ledger per workspace (or personal account) counts the recipients its
//! mail reaches (per sender address and for the whole workspace, hourly
//! buckets kept 8 days) and decides each send against the policy's limits.
//! It also tracks the day's templates, the AI verdicts on them and delivery
//! events, and turns those into a risk score and automatic actions.
//!
//! Deterministic over an injected clock and a field map in the shape the
//! Durable Object kept in its storage (`h:<hour>`, `t:<day>`, `v:<fp>`, …),
//! plus the pending reservations (`r:<id>`), which the Durable Object kept in
//! memory and a stateless server keeps in the record. [`LedgerCore::load`]
//! reads a snapshot; [`LedgerCore::changes`] hands back what changed, for a
//! compare-and-set commit (`weldsuite_ports::LedgerStore`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use weldsuite_ports::LedgerChanges;

use super::clock::{Clock, iso, month_key, next_month_start, parse_iso};
use super::fingerprint::is_same_template;
use super::limits::{
    DenialCode, DenialDetails, GuardMode, OutboundKind, OutboundLimits, OutboundState, TrustLevel,
    WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY, thresholds,
};
use super::risk::{RiskInput, RiskResult, compute_risk, to_fixed};
use crate::text::utf16_prefix;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// `LedgerSubject`: whose mail a ledger counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LedgerSubject {
    #[serde(rename_all = "camelCase")]
    Workspace {
        workspace_id: String,
        clerk_org_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Personal {
        personal_account_id: String,
        /// `free` | `pro`.
        plan: String,
    },
}

impl LedgerSubject {
    pub fn workspace(workspace_id: &str, clerk_org_id: Option<&str>) -> Self {
        Self::Workspace {
            workspace_id: workspace_id.to_owned(),
            clerk_org_id: clerk_org_id.map(str::to_owned),
        }
    }

    /// `ledgerKeyFor(subject)`: the ledger's name.
    pub fn ledger_key(&self) -> String {
        match self {
            Self::Workspace { workspace_id, .. } => format!("ws:{workspace_id}"),
            Self::Personal {
                personal_account_id,
                ..
            } => format!("personal:{personal_account_id}"),
        }
    }

    /// The master `workspaces.id`, for a workspace.
    pub fn workspace_id(&self) -> Option<&str> {
        match self {
            Self::Workspace { workspace_id, .. } => Some(workspace_id),
            Self::Personal { .. } => None,
        }
    }
}

/// `LedgerPolicy`: the master policy, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerPolicy {
    pub mode: GuardMode,
    pub trust_level: TrustLevel,
    pub state: OutboundState,
    pub state_reason: Option<String>,
    pub state_set_by: Option<String>,
    /// The last state change, ms since the epoch.
    pub state_set_at: Option<i64>,
    pub allow_replies_when_suspended: bool,
    pub limits: OutboundLimits,
}

/// `ReserveRequest.template`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestTemplate {
    pub fingerprint: String,
    pub sample: String,
    pub subject: String,
}

/// `ReserveRequest.contentFlags`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContentFlags {
    pub cold_outreach: bool,
    pub bulk: bool,
    pub phishing: bool,
}

/// `ReserveRequest`, serialised as the guard sends it to the ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveRequest {
    /// Lower-cased From address; `""` for WeldSuite's own address.
    pub sender: String,
    pub source: String,
    pub kind: OutboundKind,
    /// Lower-cased, de-duplicated to + cc + bcc.
    pub recipients: Vec<String>,
    /// The recipients (subset) who never wrote to the workspace.
    pub first_contact: Vec<String>,
    /// `null` for replies and for messages too short to fingerprint.
    #[serde(default)]
    pub template: Option<RequestTemplate>,
    pub content_score: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_flags: Option<RequestContentFlags>,
    pub shared_domain: bool,
    #[serde(default)]
    pub sender_daily_cap: Option<i64>,
    #[serde(default)]
    pub sender_unregistered: bool,
}

/// `ReserveDecision`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveDecision {
    pub allow: bool,
    pub mode: GuardMode,
    /// Pass to commit / release; `null` when nothing was reserved.
    pub reservation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denial: Option<DenialDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow_denial: Option<DenialDetails>,
}

/// `ReviewRequest.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewReason {
    TemplateThreshold,
    NewWorkspaceSample,
    RiskGreyZone,
    Staff,
}

/// `ReviewRequest`: a template for the AI to classify.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub fingerprint: String,
    pub sample: String,
    pub subject: String,
    pub reason: ReviewReason,
    pub first_contact_recipients: i64,
    pub recipients: i64,
    pub sources: Vec<String>,
    pub domains: Vec<String>,
    pub trust_level: TrustLevel,
}

/// `StoredVerdict`: an AI verdict on a template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVerdict {
    pub category: String,
    pub unsolicited: bool,
    pub confidence: f64,
    pub signals: Vec<String>,
    pub model_id: String,
    pub reviewed_at: String,
    pub fingerprint: String,
}

/// `TemplateSummary`: a template as a case shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub fingerprint: String,
    pub subject: String,
    pub snippet: String,
    pub first_contact_recipients: i64,
    pub recipients: i64,
    pub sources: Vec<String>,
    pub domains: Vec<String>,
    pub verdict: Option<StoredVerdict>,
}

/// `OutboundCaseSeverity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseSeverity {
    Info,
    Warning,
    Urgent,
}

impl CaseSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Urgent => "urgent",
        }
    }
}

/// Details of an automatic action, in insertion order.
pub type ActionDetails = Vec<(String, Value)>;

/// `AutomaticAction`: tighten the state, or open a case.
#[derive(Debug, Clone, PartialEq)]
pub struct AutomaticAction {
    /// `Some(restricted | hold)` for a state change, `None` for a case only.
    pub to_state: Option<OutboundState>,
    /// `OutboundCaseTrigger`.
    pub trigger: &'static str,
    pub severity: CaseSeverity,
    pub reason: String,
    pub details: ActionDetails,
    pub template: Option<TemplateSummary>,
}

/// `DeliveryEventType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryEventType {
    Delivered,
    Deferred,
    HardBounce,
    SoftBounce,
    Complained,
    Rejected,
    Failed,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Counts {
    r: i64,
    fc: i64,
    nt: i64,
    rp: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct HourBucket {
    ws: Counts,
    senders: BTreeMap<String, Counts>,
    sources: BTreeMap<String, i64>,
    sends: i64,
    flagged: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
struct DeliveryBucket {
    delivered: i64,
    deferred: i64,
    hard: i64,
    soft: i64,
    complaints: i64,
    rejected: i64,
    failed: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateEntry {
    fp: String,
    first_seen: i64,
    recipients: Vec<String>,
    fc: i64,
    sources: Vec<String>,
    domains: Vec<String>,
    subject: String,
    sample: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    review_queued_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reservation {
    id: String,
    request: ReserveRequest,
    expires_at: i64,
}

/// `OutboundUsage`: the customer's view (`GET /api/mail-sending/usage`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundUsage {
    pub mode: GuardMode,
    pub trust_level: TrustLevel,
    pub state: OutboundState,
    pub state_reason: Option<String>,
    pub limits: OutboundLimits,
    pub workspace: UsageWorkspace,
    pub senders: Vec<UsageSender>,
    pub deliveries7d: UsageDeliveries,
    pub cold_outreach_capped: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageWindow {
    pub used: i64,
    pub limit: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageMonth {
    pub used: i64,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkspace {
    pub hour: i64,
    pub day: UsageWindow,
    pub first_contact_day: UsageWindow,
    pub month: UsageMonth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageSender {
    pub email: String,
    pub hour: UsageWindow,
    pub day: UsageWindow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDeliveries {
    pub delivered: i64,
    pub hard_bounces: i64,
    pub soft_bounces: i64,
    pub complaints: i64,
    pub rejected: i64,
}

/// `{ risk, actions, review }` of [`LedgerCore::evaluate`].
#[derive(Debug, Clone, PartialEq)]
pub struct Evaluation {
    pub risk: RiskResult,
    pub actions: Vec<AutomaticAction>,
    pub review: Option<ReviewRequest>,
}

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// Reservations expire after 2 minutes.
pub const RESERVATION_TTL_MS: i64 = 2 * 60_000;
const KEEP_HOURS: i64 = 24 * 8;
const KEEP_VERDICT_MS: i64 = 30 * DAY;
const MAX_TEMPLATE_RECIPIENTS: usize = 500;
const MAX_TEMPLATE_DOMAINS: usize = 10;
const STAFF_COOLDOWN_MS: i64 = 7 * DAY;
const AUTOMATED_SOURCES: [&str; 3] = ["api", "crm_sequence", "workflow"];

/// `shortHash(value)`: FNV-1a over UTF-16 code units, in base 36.
fn short_hash(value: &str) -> String {
    let mut hash = 0x811c_9dc5_u32;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    to_base36(u64::from(hash))
}

fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[usize::try_from(value % 36).unwrap_or(0)]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn domain_of(address: &str) -> &str {
    address.rfind('@').map_or(address, |at| &address[at + 1..])
}

fn is_cold_verdict(verdict: Option<&StoredVerdict>) -> bool {
    verdict.is_some_and(|v| {
        (v.category == "cold_outreach" || v.category == "marketing_bulk")
            && v.confidence >= thresholds::COLD_OUTREACH_CONFIDENCE
    })
}

fn is_phishing_verdict(verdict: Option<&StoredVerdict>) -> bool {
    verdict.is_some_and(|v| {
        v.category == "phishing_or_scam" && v.confidence >= thresholds::PHISHING_CONFIDENCE
    })
}

fn len(items: usize) -> i64 {
    i64::try_from(items).unwrap_or(i64::MAX)
}

static RESERVATION_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `detail` entries as an [`ActionDetails`] list.
fn details(entries: &[(&str, Value)]) -> ActionDetails {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/// `LedgerCore`.
pub struct LedgerCore {
    hours: BTreeMap<i64, HourBucket>,
    deliveries: BTreeMap<i64, DeliveryBucket>,
    templates: BTreeMap<i64, Vec<TemplateEntry>>,
    /// Insertion-ordered, as a JavaScript `Map` iterates.
    verdicts: Vec<StoredVerdict>,
    months: BTreeMap<String, i64>,
    review_samples: BTreeMap<i64, i64>,
    shadow: BTreeMap<i64, BTreeMap<String, i64>>,
    reservations: Vec<Reservation>,
    dirty: BTreeSet<String>,
    deleted: BTreeSet<String>,
    clock: Clock,
}

impl std::fmt::Debug for LedgerCore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LedgerCore")
            .field("hours", &self.hours.len())
            .field("reservations", &self.reservations.len())
            .finish_non_exhaustive()
    }
}

fn parse_field<T: serde::de::DeserializeOwned>(value: &str) -> Option<T> {
    serde_json::from_str(value).ok()
}

impl LedgerCore {
    /// An empty ledger.
    pub fn new(clock: Clock) -> Self {
        Self {
            hours: BTreeMap::new(),
            deliveries: BTreeMap::new(),
            templates: BTreeMap::new(),
            verdicts: Vec::new(),
            months: BTreeMap::new(),
            review_samples: BTreeMap::new(),
            shadow: BTreeMap::new(),
            reservations: Vec::new(),
            dirty: BTreeSet::new(),
            deleted: BTreeSet::new(),
            clock,
        }
    }

    /// A ledger over the fields of a stored record (`load()`). Fields that
    /// don't parse are skipped.
    pub fn load(clock: Clock, fields: &HashMap<String, String>) -> Self {
        let mut core = Self::new(clock);
        let mut keys: Vec<&String> = fields.keys().collect();
        keys.sort();
        for key in keys {
            let value = &fields[key];
            let Some((prefix, raw)) = key.split_once(':') else {
                continue;
            };
            let number = raw.parse::<i64>().ok();
            match (prefix, number) {
                ("h", Some(hour)) => {
                    if let Some(bucket) = parse_field(value) {
                        core.hours.insert(hour, bucket);
                    }
                }
                ("d", Some(hour)) => {
                    if let Some(bucket) = parse_field(value) {
                        core.deliveries.insert(hour, bucket);
                    }
                }
                ("t", Some(day)) => {
                    if let Some(entries) = parse_field(value) {
                        core.templates.insert(day, entries);
                    }
                }
                ("rs", Some(day)) => {
                    if let Some(count) = parse_field(value) {
                        core.review_samples.insert(day, count);
                    }
                }
                ("sh", Some(day)) => {
                    if let Some(counts) = parse_field(value) {
                        core.shadow.insert(day, counts);
                    }
                }
                ("v", _) => {
                    if let Some(verdict) = parse_field::<StoredVerdict>(value) {
                        core.verdicts.push(verdict);
                    }
                }
                ("m", _) => {
                    if let Some(count) = parse_field(value) {
                        core.months.insert(raw.to_owned(), count);
                    }
                }
                ("r", _) => {
                    if let Some(reservation) = parse_field(value) {
                        core.reservations.push(reservation);
                    }
                }
                _ => {}
            }
        }
        core
    }

    /// What changed since the last call (`flush()`), as fields to put and
    /// remove.
    pub fn changes(&mut self) -> LedgerChanges {
        let mut changes = LedgerChanges::default();
        for key in std::mem::take(&mut self.dirty) {
            if let Some(value) = self.value_for(&key) {
                changes.put.push((key, value));
            }
        }
        changes.delete = std::mem::take(&mut self.deleted).into_iter().collect();
        changes
    }

    fn value_for(&self, key: &str) -> Option<String> {
        let (prefix, raw) = key.split_once(':')?;
        let number = raw.parse::<i64>().ok();
        let json = match prefix {
            "h" => serde_json::to_string(self.hours.get(&number?)?),
            "d" => serde_json::to_string(self.deliveries.get(&number?)?),
            "t" => serde_json::to_string(self.templates.get(&number?)?),
            "v" => serde_json::to_string(self.verdicts.iter().find(|v| v.fingerprint == raw)?),
            "m" => serde_json::to_string(self.months.get(raw)?),
            "rs" => serde_json::to_string(self.review_samples.get(&number?)?),
            "sh" => serde_json::to_string(self.shadow.get(&number?)?),
            "r" => serde_json::to_string(self.reservations.iter().find(|r| r.id == raw)?),
            _ => return None,
        };
        json.ok()
    }

    fn mark(&mut self, key: String) {
        self.deleted.remove(&key);
        self.dirty.insert(key);
    }

    fn unmark(&mut self, key: String) {
        self.dirty.remove(&key);
        self.deleted.insert(key);
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn hour(&self) -> i64 {
        self.now().div_euclid(HOUR)
    }

    fn day(&self) -> i64 {
        self.now().div_euclid(DAY)
    }

    // -------------------------------------------------------------------------
    // Windows
    // -------------------------------------------------------------------------

    /// Drop expired reservations; the live ones remain.
    fn prune_reservations(&mut self) {
        let now = self.now();
        let expired: Vec<String> = self
            .reservations
            .iter()
            .filter(|r| r.expires_at <= now)
            .map(|r| r.id.clone())
            .collect();
        self.reservations.retain(|r| r.expires_at > now);
        for id in expired {
            self.unmark(format!("r:{id}"));
        }
    }

    fn sum(&self, hours: i64, pick: impl Fn(&HourBucket) -> i64) -> i64 {
        let current = self.hour();
        (current - hours + 1..=current)
            .filter_map(|h| self.hours.get(&h))
            .map(&pick)
            .sum()
    }

    fn day_window_retry(&self, pick: impl Fn(&HourBucket) -> i64) -> String {
        let current = self.hour();
        for h in current - 23..=current {
            if self.hours.get(&h).is_some_and(|bucket| pick(bucket) > 0) {
                return iso((h + 24) * HOUR);
            }
        }
        iso((current + 1) * HOUR)
    }

    fn sender_counts(bucket: &HourBucket, sender: &str) -> Counts {
        bucket.senders.get(sender).copied().unwrap_or_default()
    }

    fn pending(&self, pick: impl Fn(&ReserveRequest) -> i64) -> i64 {
        let now = self.now();
        self.reservations
            .iter()
            .filter(|r| r.expires_at > now)
            .map(|r| pick(&r.request))
            .sum()
    }

    fn template_index(&self, fingerprint: &str, day: i64) -> Option<usize> {
        self.templates
            .get(&day)?
            .iter()
            .position(|entry| is_same_template(&entry.fp, fingerprint))
    }

    fn verdict_for(&self, fingerprint: &str) -> Option<&StoredVerdict> {
        self.verdicts
            .iter()
            .find(|v| v.fingerprint == fingerprint)
            .or_else(|| {
                self.verdicts
                    .iter()
                    .find(|v| is_same_template(&v.fingerprint, fingerprint))
            })
    }

    // -------------------------------------------------------------------------
    // Reserve / commit / release
    // -------------------------------------------------------------------------

    /// `reserve(ctx, req)`.
    pub fn reserve(
        &mut self,
        policy: &LedgerPolicy,
        platform_tripped: bool,
        request: ReserveRequest,
    ) -> ReserveDecision {
        if policy.mode == GuardMode::Off {
            return ReserveDecision {
                allow: true,
                mode: GuardMode::Off,
                reservation_id: None,
                denial: None,
                shadow_denial: None,
            };
        }
        self.prune_reservations();
        let denial = self.decide(policy, platform_tripped, &request);
        if let Some(denial) = denial.clone().filter(|_| policy.mode == GuardMode::Enforce) {
            return ReserveDecision {
                allow: false,
                mode: GuardMode::Enforce,
                reservation_id: None,
                denial: Some(denial),
                shadow_denial: None,
            };
        }
        if let Some(denial) = &denial {
            let day = self.day();
            let counts = self.shadow.entry(day).or_default();
            *counts.entry(denial.code.as_str().to_owned()).or_default() += 1;
            self.mark(format!("sh:{day}"));
        }
        let counter = RESERVATION_COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = self.now();
        let id = format!(
            "r{}{}",
            to_base36(u64::try_from(now).unwrap_or(0)),
            to_base36(counter)
        );
        self.reservations.push(Reservation {
            id: id.clone(),
            request,
            expires_at: now + RESERVATION_TTL_MS,
        });
        self.mark(format!("r:{id}"));
        ReserveDecision {
            allow: true,
            mode: policy.mode,
            reservation_id: Some(id),
            denial: None,
            shadow_denial: denial,
        }
    }

    /// The first limit this send would break.
    fn decide(
        &self,
        policy: &LedgerPolicy,
        platform_tripped: bool,
        req: &ReserveRequest,
    ) -> Option<DenialDetails> {
        if let Some(gate) = Self::state_gate(policy, req) {
            return Some(gate);
        }
        if req.sender.is_empty() {
            return self.decide_workspace_windows(policy, platform_tripped, req);
        }
        if self.within_reply_floor(&policy.limits, req) {
            return None;
        }
        self.sender_volume(&policy.limits, req)
            .or_else(|| self.shared_domain_first_contact(req))
            .or_else(|| self.decide_workspace_windows(policy, platform_tripped, req))
    }

    fn state_gate(policy: &LedgerPolicy, req: &ReserveRequest) -> Option<DenialDetails> {
        let is_reply = req.kind == OutboundKind::Reply;
        let n = len(req.recipients.len());
        if policy.state == OutboundState::Suspended
            && !(is_reply && policy.allow_replies_when_suspended)
        {
            return Some(
                DenialDetails::new(DenialCode::SendingSuspended).reason("staff_suspension"),
            );
        }
        if req.sender_unregistered {
            return Some(
                DenialDetails::new(DenialCode::SenderNotOwned)
                    .reason("unregistered_shared_address"),
            );
        }
        if !req.sender.is_empty() && n > policy.limits.recipients_per_message {
            return Some(
                DenialDetails::new(DenialCode::TooManyRecipients)
                    .window("message")
                    .limit(policy.limits.recipients_per_message)
                    .used(n),
            );
        }
        if policy.state == OutboundState::Hold && !is_reply {
            return Some(DenialDetails::new(DenialCode::SendingOnHold).reason("under_review"));
        }
        None
    }

    fn within_reply_floor(&self, limits: &OutboundLimits, req: &ReserveRequest) -> bool {
        if req.kind != OutboundKind::Reply {
            return false;
        }
        let sender = req.sender.as_str();
        let replies_day = self.sum(24, |b| Self::sender_counts(b, sender).rp)
            + self.pending(|r| {
                if r.sender == sender && r.kind == OutboundKind::Reply {
                    len(r.recipients.len())
                } else {
                    0
                }
            });
        replies_day + len(req.recipients.len()) <= limits.replies_per_sender_per_day
    }

    fn sender_volume(
        &self,
        limits: &OutboundLimits,
        req: &ReserveRequest,
    ) -> Option<DenialDetails> {
        let sender = req.sender.as_str();
        let n = len(req.recipients.len());
        let pending_sender = self.pending(|r| {
            if r.sender == sender {
                len(r.recipients.len())
            } else {
                0
            }
        });
        let current = self
            .hours
            .get(&self.hour())
            .map(|b| Self::sender_counts(b, sender).r)
            .unwrap_or_default();
        let sender_hour = current + pending_sender;
        if sender_hour + n > limits.sender_per_hour {
            return Some(
                DenialDetails::new(DenialCode::SendingLimited)
                    .window("hour")
                    .limit(limits.sender_per_hour)
                    .used(sender_hour)
                    .retry_after(iso((self.hour() + 1) * HOUR))
                    .reason("sender_hour"),
            );
        }
        let cap = req.sender_daily_cap.unwrap_or(0);
        let sender_per_day = if cap > 0 {
            limits.sender_per_day.min(cap)
        } else {
            limits.sender_per_day
        };
        let sender_day = self.sum(24, |b| Self::sender_counts(b, sender).r) + pending_sender;
        if sender_day + n > sender_per_day {
            return Some(
                DenialDetails::new(DenialCode::SendingLimited)
                    .window("day")
                    .limit(sender_per_day)
                    .used(sender_day)
                    .retry_after(self.day_window_retry(|b| Self::sender_counts(b, sender).r))
                    .reason("sender_day"),
            );
        }
        None
    }

    fn shared_domain_first_contact(&self, req: &ReserveRequest) -> Option<DenialDetails> {
        let fc = len(req.first_contact.len());
        if fc == 0 || !req.shared_domain {
            return None;
        }
        let sender = req.sender.as_str();
        let sender_fc = self.sum(24, |b| Self::sender_counts(b, sender).fc)
            + self.pending(|r| {
                if r.sender == sender {
                    len(r.first_contact.len())
                } else {
                    0
                }
            });
        if sender_fc + fc <= WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY {
            return None;
        }
        Some(
            DenialDetails::new(DenialCode::FirstContactLimited)
                .window("day")
                .limit(WELDMAIL_SHARED_FIRST_CONTACT_PER_DAY)
                .used(sender_fc)
                .retry_after(self.day_window_retry(|b| Self::sender_counts(b, sender).fc))
                .reason("weldmail_shared_domain")
                .suggest_weld_reach(),
        )
    }

    fn decide_workspace_windows(
        &self,
        policy: &LedgerPolicy,
        platform_tripped: bool,
        req: &ReserveRequest,
    ) -> Option<DenialDetails> {
        let volume = self.workspace_volume(&policy.limits, req);
        if volume.is_some() || req.first_contact.is_empty() {
            return volume;
        }
        self.workspace_first_contact(&policy.limits, req)
            .or_else(|| self.cold_template_cap(req))
            .or_else(|| self.platform_budget(policy, platform_tripped))
    }

    fn workspace_volume(
        &self,
        limits: &OutboundLimits,
        req: &ReserveRequest,
    ) -> Option<DenialDetails> {
        let n = len(req.recipients.len());
        let pending_all = self.pending(|r| len(r.recipients.len()));
        let ws_day = self.sum(24, |b| b.ws.r) + pending_all;
        if ws_day + n > limits.workspace_per_day {
            return Some(
                DenialDetails::new(DenialCode::SendingLimited)
                    .window("day")
                    .limit(limits.workspace_per_day)
                    .used(ws_day)
                    .retry_after(self.day_window_retry(|b| b.ws.r))
                    .reason("workspace_day"),
            );
        }
        let monthly = limits.monthly_recipients?;
        let month = self
            .months
            .get(&month_key(self.now()))
            .copied()
            .unwrap_or_default()
            + pending_all;
        if month + n <= monthly {
            return None;
        }
        Some(
            DenialDetails::new(DenialCode::SendingLimited)
                .window("month")
                .limit(monthly)
                .used(month)
                .retry_after(iso(next_month_start(self.now())))
                .reason("workspace_month"),
        )
    }

    fn workspace_first_contact(
        &self,
        limits: &OutboundLimits,
        req: &ReserveRequest,
    ) -> Option<DenialDetails> {
        let ws_fc = self.sum(24, |b| b.ws.fc) + self.pending(|r| len(r.first_contact.len()));
        if ws_fc + len(req.first_contact.len()) <= limits.first_contact_per_day {
            return None;
        }
        let mut denial = DenialDetails::new(DenialCode::FirstContactLimited)
            .window("day")
            .limit(limits.first_contact_per_day)
            .used(ws_fc);
        if limits.first_contact_per_day > 0 {
            denial = denial.retry_after(self.day_window_retry(|b| b.ws.fc));
        }
        Some(
            denial
                .reason("workspace_first_contact")
                .suggest_weld_reach(),
        )
    }

    fn cold_template_cap(&self, req: &ReserveRequest) -> Option<DenialDetails> {
        let template = req.template.as_ref()?;
        if !is_cold_verdict(self.verdict_for(&template.fingerprint)) {
            return None;
        }
        let today = self
            .template_index(&template.fingerprint, self.day())
            .and_then(|at| {
                self.templates
                    .get(&self.day())
                    .map(|entries| entries[at].fc)
            })
            .unwrap_or_default();
        let used = today
            + self.pending(|r| match &r.template {
                Some(t) if is_same_template(&t.fingerprint, &template.fingerprint) => {
                    len(r.first_contact.len())
                }
                _ => 0,
            });
        let cap = thresholds::COLD_TEMPLATE_FIRST_CONTACT_PER_DAY;
        if used + len(req.first_contact.len()) <= cap {
            return None;
        }
        Some(
            DenialDetails::new(DenialCode::FirstContactLimited)
                .window("day")
                .limit(cap)
                .used(used)
                .retry_after(iso((self.day() + 1) * DAY))
                .reason("cold_outreach_template")
                .suggest_weld_reach(),
        )
    }

    fn platform_budget(
        &self,
        policy: &LedgerPolicy,
        platform_tripped: bool,
    ) -> Option<DenialDetails> {
        if !platform_tripped || policy.trust_level == TrustLevel::Trusted {
            return None;
        }
        Some(
            DenialDetails::new(DenialCode::PlatformLimited)
                .window("day")
                .retry_after(iso((self.day() + 1) * DAY)),
        )
    }

    /// `release(reservationId)`.
    pub fn release(&mut self, reservation_id: &str) {
        if let Some(at) = self
            .reservations
            .iter()
            .position(|r| r.id == reservation_id)
        {
            self.reservations.remove(at);
            self.unmark(format!("r:{reservation_id}"));
        }
    }

    /// `commit(policy, reservationId, sentRecipients?)`: count a send that went
    /// out; `sent_recipients` narrows a partial send.
    pub fn commit(
        &mut self,
        policy: &LedgerPolicy,
        reservation_id: &str,
        sent_recipients: Option<&[String]>,
    ) -> Option<ReviewRequest> {
        let at = self
            .reservations
            .iter()
            .position(|r| r.id == reservation_id)?;
        let reservation = self.reservations.remove(at);
        self.unmark(format!("r:{reservation_id}"));
        let req = reservation.request;
        let sent_set: Option<HashSet<String>> =
            sent_recipients.map(|sent| sent.iter().map(|r| r.to_lowercase()).collect());
        let sent: Vec<String> = req
            .recipients
            .iter()
            .filter(|r| sent_set.as_ref().is_none_or(|set| set.contains(*r)))
            .cloned()
            .collect();
        if sent.is_empty() {
            return None;
        }
        let fc_sent: Vec<String> = req
            .first_contact
            .iter()
            .filter(|r| sent_set.as_ref().is_none_or(|set| set.contains(*r)))
            .cloned()
            .collect();

        self.count_send(&req, len(sent.len()), len(fc_sent.len()));
        let template = req.template.clone()?;
        if req.kind == OutboundKind::Reply {
            return None;
        }
        let (day, index) = self.track_template(&req, &template, &sent, &fc_sent);
        let entry = self
            .templates
            .get(&day)
            .map(|entries| entries[index].clone())?;
        if entry.review_queued_at.is_some() || self.verdict_for(&entry.fp).is_some() {
            return None;
        }
        let reason = self.review_reason(policy, &entry, len(fc_sent.len()))?;
        let now = self.now();
        if let Some(stored) = self.templates.get_mut(&day) {
            stored[index].review_queued_at = Some(now);
        }
        Some(Self::review_for(&entry, reason, policy.trust_level))
    }

    fn count_send(&mut self, req: &ReserveRequest, n: i64, fc: i64) {
        let is_reply = req.kind == OutboundKind::Reply;
        let add = |counts: &mut Counts| {
            counts.r += n;
            counts.fc += fc;
            counts.nt += i64::from(!is_reply);
            counts.rp += if is_reply { n } else { 0 };
        };
        let hour = self.hour();
        let bucket = self.hours.entry(hour).or_default();
        add(&mut bucket.ws);
        add(bucket.senders.entry(req.sender.clone()).or_default());
        *bucket.sources.entry(req.source.clone()).or_default() += n;
        bucket.sends += 1;
        if req.content_score >= 3 {
            bucket.flagged += 1;
        }
        self.mark(format!("h:{hour}"));
        let month = month_key(self.now());
        *self.months.entry(month.clone()).or_default() += n;
        self.mark(format!("m:{month}"));
    }

    /// Today's entry for this template, updated with this send: its day and
    /// index.
    fn track_template(
        &mut self,
        req: &ReserveRequest,
        template: &RequestTemplate,
        sent: &[String],
        fc_sent: &[String],
    ) -> (i64, usize) {
        let day = self.day();
        let now = self.now();
        let index = self.template_index(&template.fingerprint, day);
        let entries = self.templates.entry(day).or_default();
        let index = index.unwrap_or_else(|| {
            entries.push(TemplateEntry {
                fp: template.fingerprint.clone(),
                first_seen: now,
                recipients: Vec::new(),
                fc: 0,
                sources: Vec::new(),
                domains: Vec::new(),
                subject: utf16_prefix(&template.subject, 200).to_owned(),
                sample: template.sample.clone(),
                review_queued_at: None,
            });
            entries.len() - 1
        });
        let entry = &mut entries[index];
        let known: HashSet<String> = entry.recipients.iter().cloned().collect();
        let mut fresh_seen = HashSet::new();
        let fresh: Vec<String> = sent
            .iter()
            .map(|r| short_hash(r))
            .filter(|h| !known.contains(h))
            .filter(|h| fresh_seen.insert(h.clone()))
            .collect();
        let room = MAX_TEMPLATE_RECIPIENTS.saturating_sub(entry.recipients.len());
        entry.recipients.extend(fresh.into_iter().take(room));
        entry.fc += len(fc_sent.len());
        if !entry.sources.contains(&req.source) {
            entry.sources.push(req.source.clone());
        }
        let mut domain_seen = HashSet::new();
        let new_domains: Vec<String> = fc_sent
            .iter()
            .map(|r| domain_of(r).to_owned())
            .filter(|d| !entry.domains.contains(d))
            .filter(|d| domain_seen.insert(d.clone()))
            .collect();
        let room = MAX_TEMPLATE_DOMAINS.saturating_sub(entry.domains.len());
        entry.domains.extend(new_domains.into_iter().take(room));
        self.mark(format!("t:{day}"));
        (day, index)
    }

    fn review_reason(
        &mut self,
        policy: &LedgerPolicy,
        entry: &TemplateEntry,
        fc: i64,
    ) -> Option<ReviewReason> {
        if entry.fc >= thresholds::REVIEW_FIRST_CONTACT_RECIPIENTS {
            return Some(ReviewReason::TemplateThreshold);
        }
        if policy.trust_level != TrustLevel::New || fc == 0 {
            return None;
        }
        let day = self.day();
        let samples = self.review_samples.get(&day).copied().unwrap_or_default();
        if samples >= thresholds::NEW_WORKSPACE_REVIEW_SAMPLES_PER_DAY {
            return None;
        }
        self.review_samples.insert(day, samples + 1);
        self.mark(format!("rs:{day}"));
        Some(ReviewReason::NewWorkspaceSample)
    }

    fn review_for(entry: &TemplateEntry, reason: ReviewReason, trust: TrustLevel) -> ReviewRequest {
        ReviewRequest {
            fingerprint: entry.fp.clone(),
            sample: entry.sample.clone(),
            subject: entry.subject.clone(),
            reason,
            first_contact_recipients: entry.fc,
            recipients: len(entry.recipients.len()),
            sources: entry.sources.clone(),
            domains: entry.domains.clone(),
            trust_level: trust,
        }
    }

    /// `reviewTopTemplate(policy)`: a staff-requested review of today's
    /// biggest template.
    pub fn review_top_template(&mut self, policy: &LedgerPolicy) -> Option<ReviewRequest> {
        let day = self.day();
        let index = self.top_template_index()?;
        let now = self.now();
        let entries = self.templates.get_mut(&day)?;
        entries[index].review_queued_at = Some(now);
        let review = Self::review_for(&entries[index], ReviewReason::Staff, policy.trust_level);
        self.mark(format!("t:{day}"));
        Some(review)
    }

    /// The first template with the most first contacts today.
    fn top_template_index(&self) -> Option<usize> {
        let entries = self.templates.get(&self.day())?;
        let mut top: Option<usize> = None;
        for (index, entry) in entries.iter().enumerate() {
            if top.is_none_or(|t| entry.fc > entries[t].fc) {
                top = Some(index);
            }
        }
        top
    }

    // -------------------------------------------------------------------------
    // Delivery events and verdicts
    // -------------------------------------------------------------------------

    /// `recordDelivery(type, atMs)`.
    pub fn record_delivery(&mut self, kind: DeliveryEventType, at_ms: i64) {
        let hour = at_ms.div_euclid(HOUR);
        let bucket = self.deliveries.entry(hour).or_default();
        match kind {
            DeliveryEventType::Delivered => bucket.delivered += 1,
            DeliveryEventType::Deferred => bucket.deferred += 1,
            DeliveryEventType::HardBounce => bucket.hard += 1,
            DeliveryEventType::SoftBounce => bucket.soft += 1,
            DeliveryEventType::Complained => bucket.complaints += 1,
            DeliveryEventType::Rejected => bucket.rejected += 1,
            DeliveryEventType::Failed => bucket.failed += 1,
        }
        self.mark(format!("d:{hour}"));
    }

    /// `recordVerdict(verdict, { staffRequested })`: store it and return what
    /// it calls for.
    pub fn record_verdict(
        &mut self,
        verdict: &StoredVerdict,
        staff_requested: bool,
    ) -> Vec<AutomaticAction> {
        match self
            .verdicts
            .iter()
            .position(|v| v.fingerprint == verdict.fingerprint)
        {
            Some(at) => self.verdicts[at] = verdict.clone(),
            None => self.verdicts.push(verdict.clone()),
        }
        self.mark(format!("v:{}", verdict.fingerprint));
        let day = self.day();
        let entry = self
            .template_index(&verdict.fingerprint, day)
            .and_then(|at| self.templates.get(&day).map(|entries| entries[at].clone()));
        let template = entry.as_ref().map(|entry| self.summarize(entry));
        let mut actions = Self::verdict_actions(verdict, entry.as_ref(), template.clone());
        if staff_requested && actions.is_empty() {
            actions.push(AutomaticAction {
                to_state: None,
                trigger: "staff_review",
                severity: CaseSeverity::Info,
                reason: format!(
                    "Requested review: {} ({}).",
                    verdict.category.replace('_', " "),
                    to_fixed(verdict.confidence, 2)
                ),
                details: details(&[("confidence", Value::from(verdict.confidence))]),
                template,
            });
        }
        actions
    }

    fn verdict_actions(
        verdict: &StoredVerdict,
        entry: Option<&TemplateEntry>,
        template: Option<TemplateSummary>,
    ) -> Vec<AutomaticAction> {
        if is_phishing_verdict(Some(verdict)) {
            return vec![AutomaticAction {
                to_state: Some(OutboundState::Hold),
                trigger: "phishing",
                severity: CaseSeverity::Urgent,
                reason: "A template was classified as phishing or a scam.".to_owned(),
                details: details(&[("confidence", Value::from(verdict.confidence))]),
                template,
            }];
        }
        if is_cold_verdict(Some(verdict)) {
            return vec![AutomaticAction {
                to_state: None,
                trigger: "cold_outreach_template",
                severity: CaseSeverity::Warning,
                // `category.replace('_', ' ')`: the first underscore only.
                reason: format!(
                    "A template was classified as {}.",
                    verdict.category.replacen('_', " ", 1)
                ),
                details: details(&[
                    ("confidence", Value::from(verdict.confidence)),
                    (
                        "firstContactRecipients",
                        Value::from(entry.map_or(0, |e| e.fc)),
                    ),
                    (
                        "capPerDay",
                        Value::from(thresholds::COLD_TEMPLATE_FIRST_CONTACT_PER_DAY),
                    ),
                ]),
                template,
            }];
        }
        Vec::new()
    }

    fn summarize(&self, entry: &TemplateEntry) -> TemplateSummary {
        TemplateSummary {
            fingerprint: entry.fp.clone(),
            subject: entry.subject.clone(),
            snippet: utf16_prefix(&entry.sample, 300).to_owned(),
            first_contact_recipients: entry.fc,
            recipients: len(entry.recipients.len()),
            sources: entry.sources.clone(),
            domains: entry.domains.clone(),
            verdict: self.verdict_for(&entry.fp).cloned(),
        }
    }

    // -------------------------------------------------------------------------
    // Risk and automatic actions
    // -------------------------------------------------------------------------

    fn deliveries_7d(&self) -> DeliveryBucket {
        let current = self.hour();
        let mut total = DeliveryBucket::default();
        for h in current - 24 * 7 + 1..=current {
            if let Some(b) = self.deliveries.get(&h) {
                total.delivered += b.delivered;
                total.deferred += b.deferred;
                total.hard += b.hard;
                total.soft += b.soft;
                total.complaints += b.complaints;
                total.rejected += b.rejected;
                total.failed += b.failed;
            }
        }
        total
    }

    /// `risk(policy)`.
    pub fn risk(&self, policy: &LedgerPolicy) -> RiskResult {
        let today = self.templates.get(&self.day());
        let entries: &[TemplateEntry] = today.map_or(&[], Vec::as_slice);
        let deliveries = self.deliveries_7d();
        compute_risk(&RiskInput {
            trust_level: policy.trust_level,
            recipients_day: self.sum(24, |b| b.ws.r),
            first_contact_day: self.sum(24, |b| b.ws.fc),
            automated_day: self.sum(24, |b| {
                b.sources
                    .iter()
                    .filter(|(source, _)| AUTOMATED_SOURCES.contains(&source.as_str()))
                    .map(|(_, v)| v)
                    .sum()
            }),
            flagged_sends_day: self.sum(24, |b| b.flagged),
            sends_day: self.sum(24, |b| b.sends),
            top_template_first_contact: entries.iter().map(|e| e.fc).max().unwrap_or(0).max(0),
            recipients_7d: self.sum(24 * 7, |b| b.ws.r),
            hard_bounces_7d: deliveries.hard,
            complaints_7d: deliveries.complaints,
            cold_templates: len(entries
                .iter()
                .filter(|e| is_cold_verdict(self.verdict_for(&e.fp)))
                .count()),
            phishing_verdict: entries
                .iter()
                .any(|e| is_phishing_verdict(self.verdict_for(&e.fp))),
        })
    }

    /// `evaluate(policy)`: the risk score and the actions it calls for.
    pub fn evaluate(&mut self, policy: &LedgerPolicy) -> Evaluation {
        let risk = self.risk(policy);
        let deliveries = self.deliveries_7d();
        let recipients_7d = self.sum(24 * 7, |b| b.ws.r);
        let base = details(&[
            ("riskScore", Value::from(risk.score)),
            ("hardBounces7d", Value::from(deliveries.hard)),
            ("complaints7d", Value::from(deliveries.complaints)),
            ("recipients7d", Value::from(recipients_7d)),
            ("recipientsDay", Value::from(self.sum(24, |b| b.ws.r))),
            ("firstContactDay", Value::from(self.sum(24, |b| b.ws.fc))),
        ]);
        let staff_recently = policy
            .state_set_by
            .as_deref()
            .is_some_and(|by| by != "system")
            && policy
                .state_set_at
                .is_some_and(|at| self.now() - at < STAFF_COOLDOWN_MS);
        let can_tighten = |to: OutboundState, trigger: &str| {
            to.order() > policy.state.order() && (!staff_recently || trigger == "phishing")
        };
        let top = self.top_template_index();
        let day = self.day();
        let top_entry = top.and_then(|at| self.templates.get(&day).map(|e| e[at].clone()));
        let actions: Vec<AutomaticAction> = [
            self.phishing_action(&base, &can_tighten),
            Self::bounce_action(&risk, &base, &can_tighten),
            Self::complaint_action(deliveries.complaints, recipients_7d, &base, &can_tighten),
            self.risk_score_action(&risk, &base, &can_tighten, top_entry.as_ref()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let review = self.grey_zone_review(policy, &risk, top);
        Evaluation {
            risk,
            actions,
            review,
        }
    }

    fn phishing_action(
        &self,
        base: &ActionDetails,
        can_tighten: &dyn Fn(OutboundState, &str) -> bool,
    ) -> Option<AutomaticAction> {
        let entries = self.templates.get(&self.day())?;
        let phishing = entries
            .iter()
            .find(|e| is_phishing_verdict(self.verdict_for(&e.fp)))?;
        if !can_tighten(OutboundState::Hold, "phishing") {
            return None;
        }
        Some(AutomaticAction {
            to_state: Some(OutboundState::Hold),
            trigger: "phishing",
            severity: CaseSeverity::Urgent,
            reason: "A template was classified as phishing or a scam.".to_owned(),
            details: base.clone(),
            template: Some(self.summarize(phishing)),
        })
    }

    fn restrict_or_case(
        trigger: &'static str,
        reason: String,
        base: &ActionDetails,
        can_tighten: &dyn Fn(OutboundState, &str) -> bool,
    ) -> AutomaticAction {
        AutomaticAction {
            to_state: can_tighten(OutboundState::Restricted, trigger)
                .then_some(OutboundState::Restricted),
            trigger,
            severity: CaseSeverity::Warning,
            reason,
            details: base.clone(),
            template: None,
        }
    }

    fn bounce_action(
        risk: &RiskResult,
        base: &ActionDetails,
        can_tighten: &dyn Fn(OutboundState, &str) -> bool,
    ) -> Option<AutomaticAction> {
        let rate = risk
            .hard_bounce_rate_7d
            .filter(|rate| *rate > thresholds::HARD_BOUNCE_RATE)?;
        let reason = format!(
            "Hard bounces at {}% over 7 days.",
            to_fixed(rate * 100.0, 1)
        );
        Some(Self::restrict_or_case(
            "bounce_rate",
            reason,
            base,
            can_tighten,
        ))
    }

    fn complaint_action(
        complaints: i64,
        recipients_7d: i64,
        base: &ActionDetails,
        can_tighten: &dyn Fn(OutboundState, &str) -> bool,
    ) -> Option<AutomaticAction> {
        #[allow(clippy::cast_precision_loss)]
        let rate = if recipients_7d > 0 {
            complaints as f64 / recipients_7d as f64
        } else {
            0.0
        };
        let too_many = complaints >= thresholds::COMPLAINTS_7D
            || (complaints > 0 && rate > thresholds::COMPLAINT_RATE);
        if !too_many {
            return None;
        }
        Some(Self::restrict_or_case(
            "complaints",
            format!("{complaints} spam complaint(s) in 7 days."),
            base,
            can_tighten,
        ))
    }

    fn risk_score_action(
        &self,
        risk: &RiskResult,
        base: &ActionDetails,
        can_tighten: &dyn Fn(OutboundState, &str) -> bool,
        top: Option<&TemplateEntry>,
    ) -> Option<AutomaticAction> {
        let hold =
            risk.score >= thresholds::RISK_HOLD && can_tighten(OutboundState::Hold, "risk_score");
        let restrict = !hold
            && risk.score >= thresholds::RISK_RESTRICTED
            && can_tighten(OutboundState::Restricted, "risk_score");
        if !hold && !restrict {
            return None;
        }
        Some(AutomaticAction {
            to_state: Some(if hold {
                OutboundState::Hold
            } else {
                OutboundState::Restricted
            }),
            trigger: "risk_score",
            severity: if hold {
                CaseSeverity::Urgent
            } else {
                CaseSeverity::Warning
            },
            reason: format!("Risk score {}: {}.", risk.score, risk.reasons.join(", ")),
            details: base.clone(),
            template: top.map(|entry| self.summarize(entry)),
        })
    }

    fn grey_zone_review(
        &mut self,
        policy: &LedgerPolicy,
        risk: &RiskResult,
        top: Option<usize>,
    ) -> Option<ReviewRequest> {
        let index = top?;
        let day = self.day();
        let entry = self.templates.get(&day)?.get(index)?.clone();
        if risk.score < thresholds::RISK_REVIEW_MIN
            || entry.review_queued_at.is_some()
            || self.verdict_for(&entry.fp).is_some()
        {
            return None;
        }
        let now = self.now();
        if let Some(entries) = self.templates.get_mut(&day) {
            entries[index].review_queued_at = Some(now);
        }
        self.mark(format!("t:{day}"));
        Some(Self::review_for(
            &entry,
            ReviewReason::RiskGreyZone,
            policy.trust_level,
        ))
    }

    /// `hasRecentActivity()`: anything sent or delivered in the last 48 hours.
    pub fn has_recent_activity(&self) -> bool {
        let current = self.hour();
        (current - 47..=current)
            .any(|h| self.hours.contains_key(&h) || self.deliveries.contains_key(&h))
    }

    /// `recipientsToday()`: recipients since UTC midnight and the day number.
    pub fn recipients_today(&self) -> (i64, i64) {
        let day = self.day();
        let total = (day * 24..=self.hour())
            .filter_map(|h| self.hours.get(&h))
            .map(|b| b.ws.r)
            .sum();
        (day, total)
    }

    /// `prune()`: drop buckets and verdicts past their retention.
    pub fn prune(&mut self) -> Vec<String> {
        let mut deleted = Vec::new();
        let oldest_hour = self.hour() - KEEP_HOURS;
        let day = self.day();
        let now = self.now();
        let old_hours: Vec<i64> = self.hours.range(..oldest_hour).map(|(h, _)| *h).collect();
        for h in old_hours {
            self.hours.remove(&h);
            deleted.push(format!("h:{h}"));
        }
        let old: Vec<i64> = self
            .deliveries
            .range(..oldest_hour)
            .map(|(h, _)| *h)
            .collect();
        for h in old {
            self.deliveries.remove(&h);
            deleted.push(format!("d:{h}"));
        }
        let old: Vec<i64> = self.templates.range(..day - 1).map(|(d, _)| *d).collect();
        for d in old {
            self.templates.remove(&d);
            deleted.push(format!("t:{d}"));
        }
        let old: Vec<i64> = self
            .review_samples
            .range(..day - 8)
            .map(|(d, _)| *d)
            .collect();
        for d in old {
            self.review_samples.remove(&d);
            deleted.push(format!("rs:{d}"));
        }
        let old: Vec<i64> = self.shadow.range(..day - 8).map(|(d, _)| *d).collect();
        for d in old {
            self.shadow.remove(&d);
            deleted.push(format!("sh:{d}"));
        }
        let expired: Vec<String> = self
            .verdicts
            .iter()
            .filter(|v| parse_iso(&v.reviewed_at).is_some_and(|at| now - at > KEEP_VERDICT_MS))
            .map(|v| v.fingerprint.clone())
            .collect();
        self.verdicts.retain(|v| !expired.contains(&v.fingerprint));
        deleted.extend(expired.into_iter().map(|fp| format!("v:{fp}")));
        let keep = [month_key(now), month_key(now - 31 * DAY)];
        let old: Vec<String> = self
            .months
            .keys()
            .filter(|mk| !keep.contains(mk))
            .cloned()
            .collect();
        for mk in old {
            self.months.remove(&mk);
            deleted.push(format!("m:{mk}"));
        }
        for key in &deleted {
            self.unmark(key.clone());
        }
        deleted
    }

    // -------------------------------------------------------------------------
    // Customer view
    // -------------------------------------------------------------------------

    /// `usage(policy)`.
    pub fn usage(&self, policy: &LedgerPolicy) -> OutboundUsage {
        let limits = policy.limits;
        let current = self.hour();
        let senders: BTreeSet<String> = (current - 23..=current)
            .filter_map(|h| self.hours.get(&h))
            .flat_map(|b| b.senders.keys().cloned())
            .filter(|s| !s.is_empty())
            .collect();
        let now_bucket = self.hours.get(&current).cloned().unwrap_or_default();
        let deliveries = self.deliveries_7d();
        let today = self.templates.get(&self.day());
        let entries: &[TemplateEntry] = today.map_or(&[], Vec::as_slice);
        OutboundUsage {
            mode: policy.mode,
            trust_level: policy.trust_level,
            state: policy.state,
            state_reason: policy.state_reason.clone(),
            limits,
            workspace: UsageWorkspace {
                hour: now_bucket.ws.r,
                day: UsageWindow {
                    used: self.sum(24, |b| b.ws.r),
                    limit: limits.workspace_per_day,
                },
                first_contact_day: UsageWindow {
                    used: self.sum(24, |b| b.ws.fc),
                    limit: limits.first_contact_per_day,
                },
                month: UsageMonth {
                    used: self
                        .months
                        .get(&month_key(self.now()))
                        .copied()
                        .unwrap_or_default(),
                    limit: limits.monthly_recipients,
                },
            },
            senders: senders
                .into_iter()
                .map(|email| UsageSender {
                    hour: UsageWindow {
                        used: Self::sender_counts(&now_bucket, &email).r,
                        limit: limits.sender_per_hour,
                    },
                    day: UsageWindow {
                        used: self.sum(24, |b| Self::sender_counts(b, &email).r),
                        limit: limits.sender_per_day,
                    },
                    email,
                })
                .collect(),
            deliveries7d: UsageDeliveries {
                delivered: deliveries.delivered,
                hard_bounces: deliveries.hard,
                soft_bounces: deliveries.soft,
                complaints: deliveries.complaints,
                rejected: deliveries.rejected,
            },
            cold_outreach_capped: entries.iter().any(|e| {
                is_cold_verdict(self.verdict_for(&e.fp))
                    && e.fc >= thresholds::COLD_TEMPLATE_FIRST_CONTACT_PER_DAY
            }),
        }
    }

    /// `shadowCounts()`: shadow-mode would-be denials per code, last 7 days.
    pub fn shadow_counts(&self) -> BTreeMap<String, i64> {
        let day = self.day();
        let mut totals = BTreeMap::new();
        for d in day - 6..=day {
            for (code, count) in self.shadow.get(&d).into_iter().flatten() {
                *totals.entry(code.clone()).or_default() += count;
            }
        }
        totals
    }
}

#[cfg(test)]
mod tests;
