//! The outbound guard (`outbound/guard.ts`): the one check every send of
//! user-written mail goes through before it reaches a transport.
//!
//! ```text
//! let reservation = check_outbound(&guard, db, &input).await?;   // may refuse
//! … transmit …
//! commit_outbound(&guard, db, &reservation, None).await;           // or release_outbound
//! ```
//!
//! or [`guarded_send`] around the transmit. Steps, as in TypeScript:
//!
//! 1. Sender ownership against the master `mail_account_registry`; always
//!    enforced.
//! 2. Complaint suppressions; always enforced.
//! 3. First contact, from the tenant `mail_correspondents` (Kubernetes runs
//!    the `postgres` mailbox store only, so the `MailIndex` path is not here).
//! 4. Content screen and template fingerprint (new conversations only).
//! 5. The workspace's ledger: limits, state, platform budget, in the mode the
//!    `weldmail-outbound-guard` flag sets (`off` / `shadow` / `enforce`).
//!
//! When the ledger can't be reached the guard fails open, behind a
//! per-sender backstop.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, DynCache};

use super::clock::{iso, now_ms};
use super::content_screen::{ContentScreenInput, ScreenAttachment, screen_outbound_content};
use super::correspondents::{
    find_known_correspondents, find_suppressed, record_outbound_correspondents,
};
use super::fingerprint::{NormalizeInput, fingerprint_template, personal_tokens_for};
use super::ledger::{OutboundLedger, PlatformBudget};
use super::ledger_core::{
    LedgerSubject, OutboundUsage, RequestContentFlags, RequestTemplate, ReserveRequest,
};
use super::limits::{
    DenialCode, DenialDetails, GuardMode, OutboundKind, denial_message, is_shared_weldmail_domain,
};

/// The per-sender backstop when the ledger is unreachable (the
/// `OUTBOUND_BACKSTOP` `[[ratelimits]]` binding).
pub trait Backstop: Send + Sync {
    /// Whether one more send under `key` is allowed.
    fn limit(&self, key: &str) -> bool;
}

/// [`Backstop`] in this process: at most `limit` sends per key per `period`
/// (fixed windows, as `[[ratelimits]] simple`: 30 per 60 seconds).
#[derive(Debug)]
pub struct WindowBackstop {
    limit: u32,
    period: Duration,
    windows: Mutex<HashMap<String, (i64, u32)>>,
}

impl WindowBackstop {
    pub fn new(limit: u32, period: Duration) -> Self {
        Self {
            limit,
            period,
            windows: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for WindowBackstop {
    fn default() -> Self {
        Self::new(30, Duration::from_secs(60))
    }
}

impl Backstop for WindowBackstop {
    fn limit(&self, key: &str) -> bool {
        let period = i64::try_from(self.period.as_millis())
            .unwrap_or(i64::MAX)
            .max(1);
        let window = now_ms().div_euclid(period);
        let mut windows = self.windows.lock().unwrap_or_else(PoisonError::into_inner);
        if windows.len() > 10_000 {
            windows.retain(|_, (at, _)| *at == window);
        }
        let entry = windows.entry(key.to_owned()).or_insert((window, 0));
        if entry.0 != window {
            *entry = (window, 0);
        }
        entry.1 += 1;
        entry.1 <= self.limit
    }
}

/// What the guard reads (`OutboundGuardEnv`). Every part is optional:
/// missing ones degrade, never break a send.
#[derive(Clone, Default)]
pub struct OutboundGuard {
    /// `OUTBOUND_LEDGER`.
    pub ledger: Option<Arc<dyn OutboundLedger>>,
    /// `OUTBOUND_PLATFORM`.
    pub platform: Option<Arc<dyn PlatformBudget>>,
    /// `OUTBOUND_BACKSTOP`.
    pub backstop: Option<Arc<dyn Backstop>>,
    /// The master database (sender ownership, the workspace id);
    /// `DATABASE_URL_MASTER`.
    pub master: Option<PgPool>,
    /// The ownership cache (`WORKSPACE_CACHE`).
    pub cache: Option<Arc<dyn DynCache>>,
}

impl std::fmt::Debug for OutboundGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutboundGuard")
            .field("ledger", &self.ledger.is_some())
            .field("platform", &self.platform.is_some())
            .field("backstop", &self.backstop.is_some())
            .field("master", &self.master.is_some())
            .field("cache", &self.cache.is_some())
            .finish()
    }
}

/// `OutboundSubjectInput`: whose send it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubjectInput {
    Workspace {
        clerk_org_id: String,
        /// The master workspace id, when the caller has it (saves a lookup).
        workspace_id: Option<String>,
    },
    Personal {
        personal_account_id: String,
        /// `free` | `pro`.
        plan: String,
    },
}

/// `CheckOutboundInput`.
#[derive(Debug, Clone)]
pub struct CheckOutboundInput {
    pub subject: SubjectInput,
    /// `OutboundSource`.
    pub source: String,
    /// `reply` only when answering a message someone sent to this mailbox.
    pub kind: OutboundKind,
    /// The From address, bare or `Name <address>`.
    pub from: String,
    /// WeldSuite's own address (calendar and WeldMeet invitations): counted
    /// against the workspace, never ownership-checked.
    pub system_sender: bool,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject_line: Option<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<ScreenAttachment>,
    /// Recipient display names, so "Hi Anna" and "Hi Bram" fingerprint alike.
    pub recipient_names: Vec<String>,
    /// The mailbox's own `dailySendLimit`; it can only lower the sender's day.
    pub sender_daily_cap: Option<i64>,
}

impl CheckOutboundInput {
    /// A send from `from` to `to`, with everything else empty.
    pub fn new(
        subject: SubjectInput,
        source: &str,
        kind: OutboundKind,
        from: &str,
        to: Vec<String>,
    ) -> Self {
        Self {
            subject,
            source: source.to_owned(),
            kind,
            from: from.to_owned(),
            system_sender: false,
            to,
            cc: Vec::new(),
            bcc: Vec::new(),
            subject_line: None,
            text: None,
            html: None,
            attachments: Vec::new(),
            recipient_names: Vec::new(),
            sender_daily_cap: None,
        }
    }
}

/// The guard's mode for one send: the ledger's, or `unavailable` when it
/// was not reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReservationMode {
    Guard(GuardMode),
    Unavailable,
}

/// `OutboundReservation`.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboundReservation {
    /// The ledger's name and subject; `None` when no subject was resolved.
    pub ledger: Option<(String, LedgerSubject)>,
    pub reservation_id: Option<String>,
    pub sender: String,
    pub recipients: Vec<String>,
    pub first_contact: Vec<String>,
    pub mode: ReservationMode,
    /// Shadow mode: what enforcement would have refused.
    pub shadow_denial: Option<DenialDetails>,
}

/// `OutboundDeniedError`: the send must not go out.
#[derive(Debug, Clone, PartialEq)]
pub struct OutboundDenied {
    /// Boxed: a denial travels in every send's `Result`.
    pub details: Box<DenialDetails>,
}

impl OutboundDenied {
    pub fn new(details: DenialDetails) -> Self {
        Self {
            details: Box::new(details),
        }
    }

    pub fn code(&self) -> DenialCode {
        self.details.code
    }

    /// `outboundDenialStatus(code)`: 403, 422 or 429.
    pub fn status(&self) -> u16 {
        self.details.code.status()
    }

    /// `denialMessage(details)`.
    pub fn message(&self) -> String {
        denial_message(&self.details)
    }
}

impl std::fmt::Display for OutboundDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for OutboundDenied {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `bareAddress(value)`: `"Anna" <Anna@Example.com>` → `anna@example.com`.
pub fn bare_address(value: &str) -> String {
    let trimmed = crate::text::js_trim(value);
    let inner = match (trimmed.rfind('<'), trimmed.ends_with('>')) {
        (Some(open), true) => &trimmed[open + 1..trimmed.len() - 1],
        _ => trimmed,
    };
    crate::text::js_trim(inner).to_lowercase()
}

/// `uniqueAddresses(...lists)`: bare, lower-cased, de-duplicated, in order.
pub fn unique_addresses(lists: &[&[String]]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for list in lists {
        for raw in *list {
            let address = bare_address(raw);
            if address.contains('@') && seen.insert(address.clone()) {
                out.push(address);
            }
        }
    }
    out
}

/// `resolveSubject(env, input)`.
async fn resolve_subject(guard: &OutboundGuard, input: &SubjectInput) -> Option<LedgerSubject> {
    match input {
        SubjectInput::Personal {
            personal_account_id,
            plan,
        } => Some(LedgerSubject::Personal {
            personal_account_id: personal_account_id.clone(),
            plan: plan.clone(),
        }),
        SubjectInput::Workspace {
            clerk_org_id,
            workspace_id: Some(workspace_id),
        } => Some(LedgerSubject::workspace(workspace_id, Some(clerk_org_id))),
        SubjectInput::Workspace { clerk_org_id, .. } => {
            let master = guard.master.as_ref()?;
            let found: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
                "select id from workspaces where clerk_org_id = $1 or id = $1 limit 1",
            )
            .bind(clerk_org_id)
            .fetch_optional(master)
            .await;
            match found {
                Ok(Some(id)) => Some(LedgerSubject::workspace(&id, Some(clerk_org_id))),
                Ok(None) => {
                    tracing::warn!("[outbound] workspace lookup failed: workspace not found");
                    None
                }
                Err(error) => {
                    tracing::warn!(%error, "[outbound] workspace lookup failed");
                    None
                }
            }
        }
    }
}

/// `SenderOwnership`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SenderOwnership {
    /// Registered to this subject, or nobody claims the address or its domain.
    Owned,
    /// Registered to someone else: always refused.
    Other,
    /// On the shared weldmail domain with no registry row: refused through
    /// the ledger, so shadow mode only logs it.
    Unregistered,
}

impl SenderOwnership {
    fn as_str(self) -> &'static str {
        match self {
            Self::Owned => "owned",
            Self::Other => "other",
            Self::Unregistered => "unregistered",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "owned" => Some(Self::Owned),
            "other" => Some(Self::Other),
            "unregistered" => Some(Self::Unregistered),
            _ => None,
        }
    }
}

const OWNERSHIP_TTL: Duration = Duration::from_secs(600);

fn owned_by(subject: &LedgerSubject, workspace: Option<&str>, personal: Option<&str>) -> bool {
    match subject {
        LedgerSubject::Workspace { workspace_id, .. } => workspace == Some(workspace_id.as_str()),
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => personal == Some(personal_account_id.as_str()),
    }
}

fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `lookupOwnership(...)`: the registry's answer for one address.
async fn lookup_ownership(
    master: &PgPool,
    subject: &LedgerSubject,
    address: &str,
) -> Result<SenderOwnership, sqlx::Error> {
    let exact: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select workspace_id, personal_account_id from mail_account_registry
         where email = $1 and is_active = true limit 1",
    )
    .bind(address)
    .fetch_optional(master)
    .await?;
    if let Some((workspace, personal)) = exact {
        return Ok(
            if owned_by(subject, workspace.as_deref(), personal.as_deref()) {
                SenderOwnership::Owned
            } else {
                SenderOwnership::Other
            },
        );
    }
    let domain = address.rfind('@').map_or(address, |at| &address[at + 1..]);
    if is_shared_weldmail_domain(domain) {
        return Ok(SenderOwnership::Unregistered);
    }
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select workspace_id, personal_account_id from mail_account_registry
         where email like $1 and is_active = true limit 50",
    )
    .bind(format!("%@{}", escape_like(domain)))
    .fetch_all(master)
    .await?;
    Ok(
        if rows.is_empty()
            || rows
                .iter()
                .any(|(w, p)| owned_by(subject, w.as_deref(), p.as_deref()))
        {
            SenderOwnership::Owned
        } else {
            SenderOwnership::Other
        },
    )
}

/// `senderOwnership(env, subject, address)`, cached for 10 minutes. Fails
/// open (`Owned`) when the registry can't be reached.
pub async fn sender_ownership(
    guard: &OutboundGuard,
    subject: &LedgerSubject,
    address: &str,
) -> SenderOwnership {
    let Some(master) = guard.master.as_ref() else {
        return SenderOwnership::Owned;
    };
    let owner_key = match subject {
        LedgerSubject::Workspace { workspace_id, .. } => workspace_id.clone(),
        LedgerSubject::Personal {
            personal_account_id,
            ..
        } => format!("personal:{personal_account_id}"),
    };
    let cache_key = format!("outbound:own:{owner_key}:{address}");
    if let Some(cache) = guard.cache.as_ref()
        && let Ok(Some(cached)) = cache.get_boxed(&cache_key).await
        && let Some(ownership) = SenderOwnership::parse(&cached)
    {
        return ownership;
    }
    let ownership = match lookup_ownership(master, subject, address).await {
        Ok(ownership) => ownership,
        Err(error) => {
            // Fail open: the registry being down must not stop mail.
            tracing::warn!(%error, "[outbound] ownership lookup failed");
            return SenderOwnership::Owned;
        }
    };
    if let Some(cache) = guard.cache.as_ref() {
        let _ = cache
            .put_boxed(&cache_key, ownership.as_str(), Some(OWNERSHIP_TTL))
            .await;
    }
    ownership
}

/// `isSenderOwned(env, subject, address)`: true unless registered to
/// someone else.
pub async fn is_sender_owned(
    guard: &OutboundGuard,
    subject: &LedgerSubject,
    address: &str,
) -> bool {
    sender_ownership(guard, subject, address).await != SenderOwnership::Other
}

/// `backstop(env, key)`.
fn backstop(guard: &OutboundGuard, key: &str) -> Result<(), OutboundDenied> {
    let Some(backstop) = guard.backstop.as_ref() else {
        return Ok(());
    };
    if backstop.limit(key) {
        return Ok(());
    }
    Err(OutboundDenied::new(
        DenialDetails::new(DenialCode::SendingLimited)
            .window("hour")
            .retry_after(iso(now_ms() + 60_000))
            .reason("backstop"),
    ))
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/// `checkOutbound(env, db, input)`: check a send and reserve its recipients.
/// `db` is the tenant database (`None` for personal accounts).
pub async fn check_outbound(
    guard: &OutboundGuard,
    db: Option<&PgPool>,
    input: &CheckOutboundInput,
) -> Result<OutboundReservation, OutboundDenied> {
    let sender = if input.system_sender {
        String::new()
    } else {
        bare_address(&input.from)
    };
    let recipients = unique_addresses(&[&input.to, &input.cc, &input.bcc]);
    let subject = resolve_subject(guard, &input.subject).await;

    let ownership = match &subject {
        Some(subject) if !input.system_sender => sender_ownership(guard, subject, &sender).await,
        _ => SenderOwnership::Owned,
    };
    if ownership == SenderOwnership::Other {
        return Err(OutboundDenied::new(
            DenialDetails::new(DenialCode::SenderNotOwned).reason("address_registered_elsewhere"),
        ));
    }

    let first_contact = match db {
        Some(db) => first_contacts_of(db, &recipients).await?,
        None => Vec::new(),
    };
    let ledger_key = subject.as_ref().map(LedgerSubject::ledger_key);
    let mut reservation = OutboundReservation {
        ledger: subject.clone().zip(ledger_key.clone()).map(|(s, k)| (k, s)),
        reservation_id: None,
        sender: sender.clone(),
        recipients,
        first_contact,
        mode: ReservationMode::Unavailable,
        shadow_denial: None,
    };
    let (Some(subject), Some(ledger), Some(key)) = (subject, guard.ledger.as_ref(), ledger_key)
    else {
        let key = reservation
            .ledger
            .as_ref()
            .map_or("unknown", |(key, _)| key.as_str());
        backstop(guard, &format!("{key}:{sender}"))?;
        return Ok(reservation);
    };

    let request = reserve_request_for(input, &reservation, ownership);
    let decision = match ledger.reserve(&key, &subject, &request).await {
        Ok(decision) => decision,
        Err(error) => {
            tracing::error!(%error, "[outbound] ledger unavailable, failing open");
            backstop(guard, &format!("{key}:{sender}"))?;
            return Ok(reservation);
        }
    };
    if let (false, Some(denial)) = (decision.allow, decision.denial) {
        return Err(OutboundDenied::new(denial));
    }
    reservation.reservation_id = decision.reservation_id;
    reservation.mode = ReservationMode::Guard(decision.mode);
    reservation.shadow_denial = decision.shadow_denial;
    Ok(reservation)
}

/// `firstContactsOf(...)`: the recipients who never wrote to the workspace;
/// refuses a recipient who complained about earlier mail. Fails open (`[]`)
/// when the tables can't be read.
async fn first_contacts_of(
    db: &PgPool,
    recipients: &[String],
) -> Result<Vec<String>, OutboundDenied> {
    let suppressed = match find_suppressed(db, recipients).await {
        Ok(found) => found,
        Err(error) => {
            tracing::warn!(%error, "[outbound] correspondent lookup failed");
            return Ok(Vec::new());
        }
    };
    let complaints: Vec<String> = suppressed
        .into_iter()
        .filter(|s| s.reason == "complaint")
        .map(|s| s.email)
        .collect();
    if !complaints.is_empty() {
        let mut details = DenialDetails::new(DenialCode::RecipientSuppressed);
        details.recipients = Some(complaints);
        return Err(OutboundDenied::new(details));
    }
    match find_known_correspondents(db, recipients).await {
        Ok(known) => Ok(recipients
            .iter()
            .filter(|r| !known.contains(*r))
            .cloned()
            .collect()),
        Err(error) => {
            tracing::warn!(%error, "[outbound] correspondent lookup failed");
            Ok(Vec::new())
        }
    }
}

/// `templateOf(input, recipients)`: the fingerprint of a new conversation.
fn template_of(input: &CheckOutboundInput, recipients: &[String]) -> Option<RequestTemplate> {
    let text = input.text.as_deref().filter(|t| !t.is_empty());
    let html = input.html.as_deref().filter(|h| !h.is_empty());
    if input.kind == OutboundKind::Reply || (text.is_none() && html.is_none()) {
        return None;
    }
    let tokens = personal_tokens_for(recipients, &input.recipient_names);
    let fp = fingerprint_template(&NormalizeInput {
        subject: input.subject_line.as_deref(),
        text: text.unwrap_or_default(),
        personal_tokens: &tokens,
    });
    (!fp.too_short).then(|| RequestTemplate {
        fingerprint: fp.fingerprint,
        sample: fp.normalized,
        subject: input.subject_line.clone().unwrap_or_default(),
    })
}

/// `reserveRequestFor(input, base, ownership)`.
fn reserve_request_for(
    input: &CheckOutboundInput,
    base: &OutboundReservation,
    ownership: SenderOwnership,
) -> ReserveRequest {
    let content = (input.kind != OutboundKind::Reply).then(|| {
        screen_outbound_content(&ContentScreenInput {
            subject: input.subject_line.as_deref(),
            text: input.text.as_deref(),
            html: input.html.as_deref(),
            attachments: &input.attachments,
        })
    });
    let sender = base.sender.clone();
    let shared_domain = !sender.is_empty()
        && is_shared_weldmail_domain(
            sender
                .rfind('@')
                .map_or(sender.as_str(), |at| &sender[at + 1..]),
        );
    ReserveRequest {
        source: input.source.clone(),
        kind: input.kind,
        recipients: base.recipients.clone(),
        first_contact: base.first_contact.clone(),
        template: template_of(input, &base.recipients),
        content_score: content.as_ref().map_or(0, |c| c.score),
        content_flags: content.as_ref().map(|c| RequestContentFlags {
            cold_outreach: c.flags.cold_outreach,
            bulk: c.flags.bulk,
            phishing: c.flags.phishing,
        }),
        shared_domain,
        sender_daily_cap: input.sender_daily_cap,
        sender_unregistered: ownership == SenderOwnership::Unregistered,
        sender,
    }
}

/// `commitOutbound(env, db, reservation, { sentRecipients })`: count a send
/// that went out and record its recipients as correspondents.
/// `sent_recipients` narrows a partial send. Never fails.
pub async fn commit_outbound(
    guard: &OutboundGuard,
    db: Option<&PgPool>,
    reservation: &OutboundReservation,
    sent_recipients: Option<&[String]>,
) {
    let sent = sent_recipients.map_or_else(
        || reservation.recipients.clone(),
        |sent| unique_addresses(&[sent]),
    );
    let ledger_commit = async {
        let (Some((key, _)), Some(id), Some(ledger)) = (
            reservation.ledger.as_ref(),
            reservation.reservation_id.as_deref(),
            guard.ledger.as_ref(),
        ) else {
            return;
        };
        let narrowed = sent_recipients.map(|_| sent.as_slice());
        if let Err(error) = ledger.commit(key, id, narrowed).await {
            tracing::error!(%error, "[outbound] ledger commit failed");
        }
    };
    let correspondents = async {
        let Some(db) = db.filter(|_| !sent.is_empty()) else {
            return;
        };
        if let Err(error) = record_outbound_correspondents(db, &sent, now_ms()).await {
            tracing::warn!(%error, "[outbound] correspondent record failed");
        }
    };
    let ((), ()) = join(ledger_commit, correspondents).await;
}

/// Both futures, side by side (`Promise.all`).
async fn join<A: Future<Output = ()>, B: Future<Output = ()>>(a: A, b: B) -> ((), ()) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut a_done, mut b_done) = (false, false);
    std::future::poll_fn(|cx| {
        if !a_done {
            a_done = a.as_mut().poll(cx).is_ready();
        }
        if !b_done {
            b_done = b.as_mut().poll(cx).is_ready();
        }
        if a_done && b_done {
            std::task::Poll::Ready(((), ()))
        } else {
            std::task::Poll::Pending
        }
    })
    .await
}

/// `releaseOutbound(env, reservation)`: give back a reservation whose send
/// never went out. Never fails.
pub async fn release_outbound(guard: &OutboundGuard, reservation: &OutboundReservation) {
    let (Some((key, _)), Some(id), Some(ledger)) = (
        reservation.ledger.as_ref(),
        reservation.reservation_id.as_deref(),
        guard.ledger.as_ref(),
    ) else {
        return;
    };
    if let Err(error) = ledger.release(key, id).await {
        tracing::warn!(%error, "[outbound] ledger release failed");
    }
}

/// `tripPlatformBreaker(env, reason)`: the relay refused a send with its
/// daily-limit error. Never fails.
pub async fn trip_platform_breaker(guard: &OutboundGuard, reason: &str) {
    let Some(platform) = guard.platform.as_ref() else {
        return;
    };
    if let Err(error) = platform.trip(reason).await {
        tracing::error!(%error, "[outbound] platform breaker trip failed");
    }
}

/// `getOutboundUsage(env, input)`: the customer's view; `None` when the
/// ledger isn't reachable in this deployment.
pub async fn get_outbound_usage(
    guard: &OutboundGuard,
    input: &SubjectInput,
) -> Result<Option<OutboundUsage>, super::ledger::LedgerError> {
    let Some(subject) = resolve_subject(guard, input).await else {
        return Ok(None);
    };
    let Some(ledger) = guard.ledger.as_ref() else {
        return Ok(None);
    };
    ledger
        .usage(&subject.ledger_key(), &subject)
        .await
        .map(Some)
}

/// A send failure that may have reached some recipients
/// (`err.sentRecipients`).
pub trait SentRecipients {
    /// The recipients the message reached before it failed; empty when none.
    fn sent_recipients(&self) -> &[String] {
        &[]
    }
}

/// Why [`guarded_send`] did not send.
#[derive(Debug)]
pub enum GuardedSendError<E> {
    /// The guard refused.
    Denied(OutboundDenied),
    /// The send itself failed (its partial recipients were committed).
    Send(E),
}

/// `guardedSend(env, db, input, send)`: check, run, commit, or release when
/// `send` fails before anything went out.
pub async fn guarded_send<T, E, F, Fut>(
    guard: &OutboundGuard,
    db: Option<&PgPool>,
    input: &CheckOutboundInput,
    send: F,
) -> Result<T, GuardedSendError<E>>
where
    E: SentRecipients,
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let reservation = check_outbound(guard, db, input)
        .await
        .map_err(GuardedSendError::Denied)?;
    match send().await {
        Ok(result) => {
            commit_outbound(guard, db, &reservation, None).await;
            Ok(result)
        }
        Err(error) => {
            let reached = error.sent_recipients();
            if reached.is_empty() {
                release_outbound(guard, &reservation).await;
            } else {
                commit_outbound(guard, db, &reservation, Some(reached)).await;
            }
            Err(GuardedSendError::Send(error))
        }
    }
}

/// A boxed future for callers that keep the commit in the background.
pub type CommitFuture = BoxFuture<'static, ()>;

#[cfg(test)]
mod tests;
