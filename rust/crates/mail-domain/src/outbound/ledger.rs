//! The ledgers (`outbound/ledger.ts`): the `OutboundLedger` (one per
//! workspace or personal account) and `OutboundPlatformBudget` Durable
//! Objects as two traits, with the Kubernetes implementation over a
//! [`LedgerStore`] (Valkey).
//!
//! The traits are the Durable Objects' RPC surfaces, call for call, so the
//! guard reads the same either way and conformance builds can hand the calls
//! to a test's own ledger stub (`OUTBOUND_LEDGER`) through the harness's
//! ledger bridge. Each call names its ledger by `ledgerKeyFor(subject)`
//! (`idFromName(key)` in TypeScript).
//!
//! [`StoreLedger`] keeps each ledger as one versioned record: a call reads
//! it, decides with [`LedgerCore`], and commits only if no other call
//! changed it in between (then reads and decides again), so every decision
//! is made against the counts as they are, as with the Durable Object's
//! single-threaded instance (ADR MAIL-010). The Durable Object's alarm (risk,
//! automatic actions, platform push, pruning every 5 minutes while active)
//! is [`StoreLedger::sweep`], run by `weldsuite cron mail-outbound-ledgers`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, DynFlagSource, LedgerChanges, LedgerStore, PortError};

use super::cases::{OpenCase, open_outbound_case};
use super::clock::Clock;
use super::ledger_core::{
    AutomaticAction, DeliveryEventType, LedgerCore, LedgerSubject, OutboundUsage, ReserveDecision,
    ReserveRequest, ReviewRequest, StoredVerdict,
};
use super::limits::{OutboundState, thresholds};
use super::policy_store::{
    DeliveryRates, LoadedPolicy, OutboundEvent, StateChange, apply_automatic_state,
    customer_reason, fallback_policy, load_ledger_policy, ordered_object, platform_details,
    record_outbound_event, save_risk_score,
};

/// Why a ledger call did not go through (the Durable Object was unreachable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerError(pub String);

impl std::fmt::Display for LedgerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LedgerError {}

impl From<PortError> for LedgerError {
    fn from(error: PortError) -> Self {
        Self(error.to_string())
    }
}

pub type LedgerResult<T> = Result<T, LedgerError>;

/// `inspect(subject)`: the staff view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub usage: OutboundUsage,
    pub risk_score: i64,
    pub risk_reasons: Vec<String>,
    #[serde(rename = "shadowDenials7d")]
    pub shadow_denials_7d: BTreeMap<String, i64>,
}

/// The `OutboundLedger` Durable Object's RPC methods, each on the ledger
/// named `key`.
pub trait OutboundLedger: Send + Sync {
    fn reserve<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        request: &'a ReserveRequest,
    ) -> BoxFuture<'a, LedgerResult<ReserveDecision>>;

    fn commit<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
        sent_recipients: Option<&'a [String]>,
    ) -> BoxFuture<'a, LedgerResult<()>>;

    fn release<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
    ) -> BoxFuture<'a, LedgerResult<()>>;

    fn record_delivery<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        kind: DeliveryEventType,
        at_ms: i64,
    ) -> BoxFuture<'a, LedgerResult<()>>;

    fn record_verdict<'a>(
        &'a self,
        key: &'a str,
        verdict: &'a StoredVerdict,
        staff_requested: bool,
    ) -> BoxFuture<'a, LedgerResult<()>>;

    fn usage<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<OutboundUsage>>;

    fn inspect<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<Inspection>>;

    fn request_review<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<bool>>;

    fn refresh_policy<'a>(&'a self, key: &'a str) -> BoxFuture<'a, LedgerResult<()>>;
}

/// `status()` of the platform budget.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlatformStatus {
    pub tripped: bool,
    pub recipients: i64,
    pub quota: Option<i64>,
    pub reason: Option<String>,
}

/// The `OutboundPlatformBudget` Durable Object's RPC methods.
pub trait PlatformBudget: Send + Sync {
    fn status(&self) -> BoxFuture<'_, LedgerResult<PlatformStatus>>;
    fn trip<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, LedgerResult<()>>;
    fn add(&self, day: i64, delta: i64) -> BoxFuture<'_, LedgerResult<()>>;
}

/// `OutboundReviewMessage`: one queued AI review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundReviewMessage {
    pub subject: LedgerSubject,
    pub request: ReviewRequest,
    pub requested_at: String,
}

/// Where queued reviews go (the `MAIL_OUTBOUND_REVIEW` queue; NATS on
/// Kubernetes).
pub trait ReviewQueue: Send + Sync {
    fn send(&self, message: OutboundReviewMessage) -> BoxFuture<'_, Result<(), PortError>>;
}

// ---------------------------------------------------------------------------
// The store-backed ledgers
// ---------------------------------------------------------------------------

const POLICY_TTL_MS: i64 = 60_000;
const PLATFORM_TTL_MS: i64 = 60_000;
/// How long an untouched ledger is kept: past every window it counts.
const RECORD_TTL: Duration = Duration::from_hours(9 * 24);
const MAX_ATTEMPTS: usize = 8;
/// The record listing the ledgers with activity, for the sweep.
const ACTIVE_INDEX: &str = "ledgers:active";
/// The platform budget's record.
const PLATFORM_KEY: &str = "platform";

/// What the ledgers need around their records.
#[derive(Clone)]
pub struct LedgerDeps {
    pub store: Arc<dyn LedgerStore>,
    /// Master database: policies, cases, the trail. `None`: the fallback
    /// policy, nothing recorded.
    pub master: Option<PgPool>,
    pub flags: Option<Arc<dyn DynFlagSource>>,
    pub reviews: Option<Arc<dyn ReviewQueue>>,
    /// `CF_EMAIL_DAILY_QUOTA`: the relay's daily recipient quota; `None`
    /// arms no platform budget.
    pub daily_quota: Option<i64>,
    pub clock: Clock,
}

/// The ledgers over a [`LedgerStore`].
pub struct StoreLedger {
    deps: LedgerDeps,
    platform: Arc<StorePlatformBudget>,
    policies: Mutex<HashMap<String, (LoadedPolicy, i64)>>,
    platform_status: Mutex<(bool, i64)>,
}

impl std::fmt::Debug for StoreLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreLedger").finish_non_exhaustive()
    }
}

/// One read of a ledger record.
struct Loaded {
    version: u64,
    core: LedgerCore,
    subject: Option<LedgerSubject>,
    fields: HashMap<String, String>,
}

impl StoreLedger {
    pub fn new(deps: LedgerDeps) -> Self {
        let platform = Arc::new(StorePlatformBudget { deps: deps.clone() });
        Self {
            deps,
            platform,
            policies: Mutex::new(HashMap::new()),
            platform_status: Mutex::new((false, i64::MIN)),
        }
    }

    /// The platform budget sharing this store.
    pub fn platform(&self) -> Arc<dyn PlatformBudget> {
        Arc::clone(&self.platform) as Arc<dyn PlatformBudget>
    }

    fn now(&self) -> i64 {
        (self.deps.clock)()
    }

    fn record_key(key: &str) -> String {
        format!("ledger:{key}")
    }

    async fn load(&self, key: &str) -> LedgerResult<Loaded> {
        let snapshot = self.deps.store.load(&Self::record_key(key)).await?;
        let subject = snapshot
            .fields
            .get("subject")
            .and_then(|s| serde_json::from_str(s).ok());
        Ok(Loaded {
            version: snapshot.version,
            core: LedgerCore::load(self.deps.clock.clone(), &snapshot.fields),
            subject,
            fields: snapshot.fields,
        })
    }

    /// Read, apply `op`, commit; again from the top when another call got
    /// there first. `op` returns its result and extra fields to put.
    async fn update<T>(
        &self,
        key: &str,
        mut op: impl FnMut(&mut Loaded) -> (T, Vec<(String, String)>),
    ) -> LedgerResult<T> {
        for _ in 0..MAX_ATTEMPTS {
            let mut loaded = self.load(key).await?;
            let (result, extra) = op(&mut loaded);
            let mut changes = loaded.core.changes();
            changes.put.extend(extra);
            if changes.is_empty() {
                return Ok(result);
            }
            if self
                .deps
                .store
                .commit(&Self::record_key(key), loaded.version, &changes, RECORD_TTL)
                .await?
            {
                return Ok(result);
            }
        }
        Err(LedgerError(format!("ledger {key} is too busy")))
    }

    fn subject_field(subject: &LedgerSubject) -> (String, String) {
        (
            "subject".to_owned(),
            serde_json::to_string(subject).unwrap_or_default(),
        )
    }

    /// `ensure(subject?, force)`: the policy, from the master database at most
    /// once a minute.
    async fn policy(
        &self,
        key: &str,
        subject: Option<&LedgerSubject>,
        core: &LedgerCore,
        force: bool,
    ) -> LoadedPolicy {
        let now = self.now();
        let cached = self
            .policies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .cloned();
        if let Some((policy, loaded_at)) = &cached
            && !force
            && now - loaded_at <= POLICY_TTL_MS
        {
            return policy.clone();
        }
        let (Some(subject), Some(master)) = (subject, self.deps.master.as_ref()) else {
            return cached.map_or_else(fallback_policy, |(policy, _)| policy);
        };
        let previous = cached
            .as_ref()
            .map_or_else(fallback_policy, |(policy, _)| policy.clone());
        let risk = core.risk(&previous.policy);
        let rates = DeliveryRates {
            hard_bounce_rate_7d: risk.hard_bounce_rate_7d,
            complaint_rate_7d: risk.complaint_rate_7d,
        };
        match load_ledger_policy(master, self.deps.flags.as_deref(), subject, rates, now).await {
            Ok(policy) => {
                self.policies
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key.to_owned(), (policy.clone(), now));
                policy
            }
            Err(error) => {
                tracing::error!(%error, "[outbound-ledger] policy load failed");
                // Retry soon, not on every request.
                self.policies
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(
                        key.to_owned(),
                        (previous.clone(), now - POLICY_TTL_MS + 10_000),
                    );
                previous
            }
        }
    }

    fn forget_policy(&self, key: &str) {
        self.policies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
    }

    /// `platformStatus()`: tripped or not, at most once a minute.
    async fn platform_tripped(&self) -> bool {
        let now = self.now();
        let (tripped, checked) = *self
            .platform_status
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if now.saturating_sub(checked) < PLATFORM_TTL_MS {
            return tripped;
        }
        let tripped = match self.platform.status().await {
            Ok(status) => status.tripped,
            Err(error) => {
                tracing::warn!(%error, "[outbound-ledger] platform status unavailable");
                tripped
            }
        };
        *self
            .platform_status
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = (tripped, now);
        tripped
    }

    /// `ensureAlarm()`: list the ledger for the sweep.
    async fn mark_active(&self, key: &str) {
        let now = self.now();
        for _ in 0..MAX_ATTEMPTS {
            let Ok(snapshot) = self.deps.store.load(ACTIVE_INDEX).await else {
                return;
            };
            if snapshot.fields.contains_key(key) {
                return;
            }
            let changes = LedgerChanges {
                put: vec![(key.to_owned(), now.to_string())],
                delete: Vec::new(),
            };
            match self
                .deps
                .store
                .commit(ACTIVE_INDEX, snapshot.version, &changes, RECORD_TTL)
                .await
            {
                Ok(true) | Err(_) => return,
                Ok(false) => {}
            }
        }
    }

    async fn queue_review(&self, subject: Option<&LedgerSubject>, request: ReviewRequest) {
        let (Some(subject), Some(queue)) = (subject, self.deps.reviews.as_ref()) else {
            return;
        };
        let message = OutboundReviewMessage {
            subject: subject.clone(),
            request,
            requested_at: super::clock::iso(self.now()),
        };
        if let Err(error) = queue.send(message).await {
            tracing::error!(%error, "[outbound-ledger] review enqueue failed");
        }
    }

    /// `applyActions(policy, actions, riskScore)`: state changes and cases.
    async fn apply_actions(
        &self,
        key: &str,
        subject: &LedgerSubject,
        policy: &LoadedPolicy,
        actions: Vec<AutomaticAction>,
        risk_score: i64,
    ) {
        let Some(master) = self.deps.master.as_ref() else {
            return;
        };
        let mut current = policy.policy.state;
        for action in actions {
            let mut state = current;
            if let Some(to) = action.to_state {
                let change = StateChange {
                    from: current,
                    to,
                    customer_reason: customer_reason(to).to_owned(),
                    reason: action.reason.clone(),
                    details: ordered_object(&action.details),
                };
                match apply_automatic_state(master, subject, &change, self.now()).await {
                    Ok(()) => {
                        state = to;
                        current = to;
                        // Restricted limits and the hold come from the reloaded policy.
                        self.forget_policy(key);
                    }
                    Err(error) => {
                        tracing::error!(%error, "[outbound-ledger] state change failed");
                    }
                }
            }
            open_outbound_case(
                master,
                &OpenCase {
                    subject: Some(subject.clone()),
                    trigger: action.trigger.to_owned(),
                    severity: action.severity,
                    summary: action.reason,
                    risk_score: Some(risk_score),
                    state: Some(state.as_str().to_owned()),
                    template: action.template,
                    metrics: action.details,
                },
                self.now(),
            )
            .await;
        }
    }

    /// The Durable Object's alarm for one ledger: risk score, automatic
    /// actions, a grey-zone review, the platform push and pruning. Returns
    /// whether the ledger is still active.
    pub async fn alarm(&self, key: &str) -> LedgerResult<bool> {
        let loaded = self.load(key).await?;
        let Some(subject) = loaded.subject.clone() else {
            return Ok(false);
        };
        let policy = self.policy(key, Some(&subject), &loaded.core, true).await;
        let pushed: Option<(i64, i64)> = loaded
            .fields
            .get("platformPushed")
            .and_then(|s| serde_json::from_str(s).ok());
        let last_risk: Option<i64> = loaded
            .fields
            .get("lastRisk")
            .and_then(|s| s.parse().ok())
            .or(Some(policy.risk_score));
        let mut outcome = None;
        let policy_for_op = policy.policy.clone();
        self.update(key, |loaded| {
            let evaluation = loaded.core.evaluate(&policy_for_op);
            loaded.core.prune();
            let recent = loaded.core.has_recent_activity();
            let today = loaded.core.recipients_today();
            outcome = Some((evaluation, recent, today));
            ((), Vec::new())
        })
        .await?;
        let Some((evaluation, recent, (day, recipients))) = outcome else {
            return Ok(false);
        };
        let mut extra = Vec::new();
        if last_risk.is_none_or(|last| (evaluation.risk.score - last).abs() >= 5)
            && let Some(master) = self.deps.master.as_ref()
        {
            match save_risk_score(master, &subject, evaluation.risk.score, self.now()).await {
                Ok(()) => {
                    extra.push(("lastRisk".to_owned(), evaluation.risk.score.to_string()));
                }
                Err(error) => tracing::error!(%error, "[outbound-ledger] risk save failed"),
            }
        }
        if !evaluation.actions.is_empty() {
            self.apply_actions(
                key,
                &subject,
                &policy,
                evaluation.actions,
                evaluation.risk.score,
            )
            .await;
        }
        if let Some(review) = evaluation.review {
            self.queue_review(Some(&subject), review).await;
        }
        // `pushPlatform()`: the day's delta to the platform budget.
        let delta = match pushed {
            Some((pushed_day, pushed_recipients)) if pushed_day == day => {
                recipients - pushed_recipients
            }
            _ => recipients,
        };
        if delta > 0 {
            match self.platform.add(day, delta).await {
                Ok(()) => extra.push((
                    "platformPushed".to_owned(),
                    serde_json::to_string(&(day, recipients)).unwrap_or_default(),
                )),
                Err(error) => tracing::warn!(%error, "[outbound-ledger] platform push failed"),
            }
        }
        if !extra.is_empty() {
            let extra_fields = extra.clone();
            self.update(key, |_| ((), extra_fields.clone())).await?;
        }
        Ok(recent)
    }

    /// `weldsuite cron mail-outbound-ledgers`: every active ledger's alarm;
    /// ledgers without activity in 48 hours leave the list. Returns how many
    /// ran.
    pub async fn sweep(&self) -> LedgerResult<usize> {
        let snapshot = self.deps.store.load(ACTIVE_INDEX).await?;
        let mut idle = Vec::new();
        let mut ran = 0;
        let mut keys: Vec<&String> = snapshot.fields.keys().collect();
        keys.sort();
        for key in keys {
            match self.alarm(key).await {
                Ok(true) => ran += 1,
                Ok(false) => {
                    ran += 1;
                    idle.push(key.clone());
                }
                Err(error) => tracing::error!(%error, key, "[outbound-ledger] alarm failed"),
            }
        }
        if !idle.is_empty() {
            for _ in 0..MAX_ATTEMPTS {
                let current = self.deps.store.load(ACTIVE_INDEX).await?;
                let changes = LedgerChanges {
                    put: Vec::new(),
                    delete: idle.clone(),
                };
                if self
                    .deps
                    .store
                    .commit(ACTIVE_INDEX, current.version, &changes, RECORD_TTL)
                    .await?
                {
                    break;
                }
            }
        }
        Ok(ran)
    }
}

fn log_refusal(subject: &LedgerSubject, request: &ReserveRequest, decision: &ReserveDecision) {
    let Some(refused) = decision.denial.as_ref().or(decision.shadow_denial.as_ref()) else {
        return;
    };
    let mut line = json!({
        "event": if decision.denial.is_some() { "outbound_denied" } else { "outbound_shadow_denied" },
    });
    match subject {
        LedgerSubject::Workspace { workspace_id, .. } => line["workspaceId"] = json!(workspace_id),
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => line["personalAccountId"] = json!(personal_account_id),
    }
    line["sender"] = json!(request.sender);
    line["source"] = json!(request.source);
    line["kind"] = json!(request.kind);
    line["recipients"] = json!(request.recipients.len());
    line["firstContact"] = json!(request.first_contact.len());
    line["code"] = json!(refused.code);
    line["reason"] = json!(refused.reason);
    tracing::info!("{line}");
}

impl OutboundLedger for StoreLedger {
    fn reserve<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        request: &'a ReserveRequest,
    ) -> BoxFuture<'a, LedgerResult<ReserveDecision>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self.policy(key, Some(subject), &loaded.core, false).await;
            let tripped = self.platform_tripped().await;
            let decision = self
                .update(key, |loaded| {
                    let mut extra = Vec::new();
                    if loaded.subject.is_none() {
                        extra.push(Self::subject_field(subject));
                    }
                    let decision = loaded
                        .core
                        .reserve(&policy.policy, tripped, request.clone());
                    (decision, extra)
                })
                .await?;
            log_refusal(subject, request, &decision);
            self.mark_active(key).await;
            Ok(decision)
        })
    }

    fn commit<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
        sent_recipients: Option<&'a [String]>,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self
                .policy(key, loaded.subject.as_ref(), &loaded.core, false)
                .await;
            let review = self
                .update(key, |loaded| {
                    (
                        loaded
                            .core
                            .commit(&policy.policy, reservation_id, sent_recipients),
                        Vec::new(),
                    )
                })
                .await?;
            if let Some(review) = review {
                self.queue_review(loaded.subject.as_ref(), review).await;
            }
            Ok(())
        })
    }

    fn release<'a>(
        &'a self,
        key: &'a str,
        reservation_id: &'a str,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            self.update(key, |loaded| {
                loaded.core.release(reservation_id);
                ((), Vec::new())
            })
            .await
        })
    }

    fn record_delivery<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
        kind: DeliveryEventType,
        at_ms: i64,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            self.update(key, |loaded| {
                let extra = if loaded.subject.is_none() {
                    vec![Self::subject_field(subject)]
                } else {
                    Vec::new()
                };
                loaded.core.record_delivery(kind, at_ms);
                ((), extra)
            })
            .await?;
            self.mark_active(key).await;
            Ok(())
        })
    }

    fn record_verdict<'a>(
        &'a self,
        key: &'a str,
        verdict: &'a StoredVerdict,
        staff_requested: bool,
    ) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self
                .policy(key, loaded.subject.as_ref(), &loaded.core, false)
                .await;
            let mut risk_score = 0;
            let actions = self
                .update(key, |loaded| {
                    let actions = loaded.core.record_verdict(verdict, staff_requested);
                    risk_score = loaded.core.risk(&policy.policy).score;
                    (actions, Vec::new())
                })
                .await?;
            if let (false, Some(subject)) = (actions.is_empty(), loaded.subject.as_ref()) {
                self.apply_actions(key, subject, &policy, actions, risk_score)
                    .await;
            }
            Ok(())
        })
    }

    fn usage<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<OutboundUsage>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self.policy(key, Some(subject), &loaded.core, false).await;
            Ok(loaded.core.usage(&policy.policy))
        })
    }

    fn inspect<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<Inspection>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self.policy(key, Some(subject), &loaded.core, true).await;
            let risk = loaded.core.risk(&policy.policy);
            Ok(Inspection {
                usage: loaded.core.usage(&policy.policy),
                risk_score: risk.score,
                risk_reasons: risk.reasons,
                shadow_denials_7d: loaded.core.shadow_counts(),
            })
        })
    }

    fn request_review<'a>(
        &'a self,
        key: &'a str,
        subject: &'a LedgerSubject,
    ) -> BoxFuture<'a, LedgerResult<bool>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            let policy = self.policy(key, Some(subject), &loaded.core, false).await;
            let review = self
                .update(key, |loaded| {
                    (loaded.core.review_top_template(&policy.policy), Vec::new())
                })
                .await?;
            let Some(review) = review else {
                return Ok(false);
            };
            self.queue_review(Some(subject), review).await;
            Ok(true)
        })
    }

    fn refresh_policy<'a>(&'a self, key: &'a str) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            let loaded = self.load(key).await?;
            self.policy(key, loaded.subject.as_ref(), &loaded.core, true)
                .await;
            Ok(())
        })
    }
}

/// `OutboundPlatformBudget` over the same store.
pub struct StorePlatformBudget {
    deps: LedgerDeps,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PlatformState {
    day: i64,
    recipients: i64,
    tripped: bool,
    reason: Option<String>,
}

impl StorePlatformBudget {
    fn today(&self) -> i64 {
        (self.deps.clock)().div_euclid(86_400_000)
    }

    fn state_of(&self, fields: &HashMap<String, String>) -> PlatformState {
        let day = self.today();
        fields
            .get("state")
            .and_then(|s| serde_json::from_str::<PlatformState>(s).ok())
            .filter(|state| state.day == day)
            .unwrap_or(PlatformState {
                day,
                ..PlatformState::default()
            })
    }

    async fn update(
        &self,
        op: impl Fn(&mut PlatformState) -> bool,
    ) -> LedgerResult<(PlatformState, bool)> {
        for _ in 0..MAX_ATTEMPTS {
            let snapshot = self.deps.store.load(PLATFORM_KEY).await?;
            let mut state = self.state_of(&snapshot.fields);
            let tripped_now = op(&mut state);
            let changes = LedgerChanges {
                put: vec![(
                    "state".to_owned(),
                    serde_json::to_string(&state).unwrap_or_default(),
                )],
                delete: Vec::new(),
            };
            if self
                .deps
                .store
                .commit(PLATFORM_KEY, snapshot.version, &changes, RECORD_TTL)
                .await?
            {
                return Ok((state, tripped_now));
            }
        }
        Err(LedgerError("platform budget is too busy".to_owned()))
    }

    /// `tripInternal(state, reason)`: the trail and the case.
    async fn tripped(&self, state: &PlatformState) {
        let Some(master) = self.deps.master.as_ref() else {
            return;
        };
        let reason = state.reason.clone().unwrap_or_default();
        record_outbound_event(
            master,
            None,
            &OutboundEvent {
                kind: "platform_breaker",
                from_value: None,
                to_value: Some("tripped".to_owned()),
                reason: Some(reason.clone()),
                actor: "system".to_owned(),
                details: Some(platform_details(state.recipients, self.deps.daily_quota)),
            },
        )
        .await;
        open_outbound_case(
            master,
            &OpenCase {
                subject: None,
                trigger: "platform_budget".to_owned(),
                severity: super::ledger_core::CaseSeverity::Urgent,
                summary: format!(
                    "{reason} First-contact sends from new and standard workspaces stop until midnight UTC."
                ),
                risk_score: None,
                state: None,
                template: None,
                metrics: vec![
                    ("recipients".to_owned(), json!(state.recipients)),
                    ("quota".to_owned(), json!(self.deps.daily_quota)),
                ],
            },
            (self.deps.clock)(),
        )
        .await;
    }
}

impl PlatformBudget for StorePlatformBudget {
    fn status(&self) -> BoxFuture<'_, LedgerResult<PlatformStatus>> {
        Box::pin(async move {
            let snapshot = self.deps.store.load(PLATFORM_KEY).await?;
            let state = self.state_of(&snapshot.fields);
            Ok(PlatformStatus {
                tripped: state.tripped,
                recipients: state.recipients,
                quota: self.deps.daily_quota,
                reason: state.reason,
            })
        })
    }

    fn trip<'a>(&'a self, reason: &'a str) -> BoxFuture<'a, LedgerResult<()>> {
        Box::pin(async move {
            let (state, tripped_now) = self
                .update(|state| {
                    if state.tripped {
                        return false;
                    }
                    state.tripped = true;
                    state.reason = Some(reason.to_owned());
                    true
                })
                .await?;
            if tripped_now {
                self.tripped(&state).await;
            }
            Ok(())
        })
    }

    fn add(&self, day: i64, delta: i64) -> BoxFuture<'_, LedgerResult<()>> {
        Box::pin(async move {
            let quota = self.deps.daily_quota;
            let (state, tripped_now) = self
                .update(|state| {
                    if day != state.day {
                        return false;
                    }
                    state.recipients += delta;
                    #[allow(clippy::cast_precision_loss)]
                    let over = quota.is_some_and(|quota| {
                        state.recipients as f64 >= quota as f64 * thresholds::PLATFORM_BUDGET_RATIO
                    });
                    if state.tripped || !over {
                        return false;
                    }
                    let quota = quota.unwrap_or_default();
                    state.tripped = true;
                    state.reason = Some(format!(
                        "Customer mail reached {} of the {quota} recipient daily quota ({}%).",
                        state.recipients,
                        (thresholds::PLATFORM_BUDGET_RATIO * 100.0).round()
                    ));
                    true
                })
                .await?;
            if tripped_now {
                self.tripped(&state).await;
            }
            Ok(())
        })
    }
}

/// `OutboundState` for a case's `state` metric.
pub fn state_label(state: OutboundState) -> &'static str {
    state.as_str()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use weldsuite_ports::MemoryLedgerStore;

    use super::*;
    use crate::outbound::ledger_core::RequestTemplate;
    use crate::outbound::limits::OutboundKind;

    fn ledger(now: &Arc<AtomicI64>) -> StoreLedger {
        let clock_now = Arc::clone(now);
        StoreLedger::new(LedgerDeps {
            store: Arc::new(MemoryLedgerStore::new()),
            master: None,
            flags: None,
            reviews: None,
            daily_quota: Some(100),
            clock: Arc::new(move || clock_now.load(Ordering::SeqCst)),
        })
    }

    fn request(n: usize) -> ReserveRequest {
        ReserveRequest {
            sender: "tom@acme.com".to_owned(),
            source: "compose".to_owned(),
            kind: OutboundKind::NewThread,
            recipients: (0..n).map(|i| format!("r{i}@x.com")).collect(),
            first_contact: Vec::new(),
            template: None::<RequestTemplate>,
            content_score: 0,
            content_flags: None,
            shared_domain: false,
            sender_daily_cap: None,
            sender_unregistered: false,
        }
    }

    #[tokio::test]
    async fn reserves_commits_and_counts_across_calls() {
        let now = Arc::new(AtomicI64::new(1_791_883_800_000));
        let ledger = ledger(&now);
        let subject = LedgerSubject::workspace("ws_1", Some("org_1"));
        let key = subject.ledger_key();
        let decision = ledger
            .reserve(&key, &subject, &request(3))
            .await
            .expect("reserve");
        assert!(decision.allow);
        assert_eq!(decision.mode, crate::outbound::limits::GuardMode::Shadow);
        ledger
            .commit(&key, decision.reservation_id.as_deref().expect("id"), None)
            .await
            .expect("commit");
        let usage = ledger.usage(&key, &subject).await.expect("usage");
        assert_eq!(usage.workspace.day.used, 3);
        assert_eq!(usage.senders.len(), 1);
        // The sweep runs the alarm and pushes the day to the platform budget.
        assert_eq!(ledger.sweep().await.expect("sweep"), 1);
        let status = ledger.platform().status().await.expect("status");
        assert_eq!(status.recipients, 3);
        assert!(!status.tripped);
    }

    #[tokio::test]
    async fn the_platform_budget_trips_at_its_share_of_the_quota() {
        let now = Arc::new(AtomicI64::new(1_791_883_800_000));
        let ledger = ledger(&now);
        let platform = ledger.platform();
        let day = 1_791_883_800_000 / 86_400_000;
        platform.add(day, 69).await.expect("add");
        assert!(!platform.status().await.expect("status").tripped);
        platform.add(day, 1).await.expect("add");
        let status = platform.status().await.expect("status");
        assert!(status.tripped);
        assert_eq!(
            status.reason.as_deref(),
            Some("Customer mail reached 70 of the 100 recipient daily quota (70%).")
        );
        // A new day starts untripped.
        now.fetch_add(86_400_000, Ordering::SeqCst);
        assert!(!platform.status().await.expect("status").tripped);
    }

    #[tokio::test]
    async fn concurrent_reservations_are_all_counted() {
        let now = Arc::new(AtomicI64::new(1_791_883_800_000));
        let ledger = Arc::new(ledger(&now));
        let subject = LedgerSubject::workspace("ws_1", None);
        let key = subject.ledger_key();
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let ledger = Arc::clone(&ledger);
            let subject = subject.clone();
            let key = key.clone();
            tasks.push(tokio::spawn(async move {
                let decision = ledger
                    .reserve(&key, &subject, &request(1))
                    .await
                    .expect("reserve");
                ledger
                    .commit(&key, decision.reservation_id.as_deref().expect("id"), None)
                    .await
                    .expect("commit");
            }));
        }
        for task in tasks {
            task.await.expect("task");
        }
        let usage = ledger.usage(&key, &subject).await.expect("usage");
        assert_eq!(usage.workspace.day.used, 8);
    }
}
