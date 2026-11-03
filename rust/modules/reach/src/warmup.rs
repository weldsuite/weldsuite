//! reach-api's hourly and daily crons (`cron/warmup-sweep.ts`,
//! `services/warmup.ts`, `cron/slot-reconciliation.ts`, `services/slots.ts`)
//! as `weldsuite cron reach-warmup-sweep` and
//! `weldsuite cron reach-slot-reconciliation`.
//!
//! The warmup sweep visits only the workspaces the master due index lists
//! (kind `reach_warmup`, which a mailbox create marks): it reads how far the
//! warmup network has warmed each mailbox (the master pool) and moves it
//! along (`provisioning` -> `warming` -> `active` through the health gate),
//! ramps an active mailbox's daily cap, takes a mailbox out of use when the
//! network cannot log in to it or its placement drops, and pauses mailboxes
//! whose WeldHost domain lapsed. Each visit stores when the workspace next
//! needs one.
//!
//! The slot reconciliation reads only the master database: it gives back
//! Mailpool slots beyond what the active mailboxes need and logs drift.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, REACH_MAILBOX_SUSPENDED, REACH_MAILBOX_UPDATED,
};
use weldsuite_db::Keyring;
use weldsuite_db::due_index::{self, SweepResult};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource};
use weldsuite_ports::OutboundHttp;
use weldsuite_reach_domain::access::{utc_day_start, utc_tomorrow};
use weldsuite_reach_domain::credentials::{open, seal};
use weldsuite_reach_domain::mailboxes::{has_login_error, without_credentials};
use weldsuite_reach_domain::schemas::{WELDREACH_APP_CODE, sending};
use weldsuite_reach_domain::warmup::gate;
use weldsuite_reach_domain::warmup_pool::{self, PoolView};
use weldsuite_reach_domain::{ReachError, ReachResult, epoch_ms, int, iso, parse_iso, text};

use crate::mailboxes::{PoolDeps, register_in_pool};
use crate::mailpool::{Mailpool, imap_credentials_of, smtp_credentials_of};

/// The due-index kind.
pub const WARMUP_DUE_KIND: &str = "reach_warmup";
/// A workspace that failed is retried after this.
const RETRY_AFTER: time::Duration = time::Duration::hours(6);
/// Workspaces per run (`MAX_WORKSPACES_PER_RUN`); the rest stay due.
pub const MAX_WORKSPACES_PER_RUN: i64 = 40;

const LOGIN_FAILED: &str = "login_failed";
const LOW_INBOX_RATE: &str = "low_inbox_rate";
const DOMAIN_INACTIVE: &str = "domain_inactive";
const LOGIN_FAILED_MESSAGE: &str = "The warmup network could not sign in to this mailbox. Check the mailbox login at your provider.";

/// A workspace's tenant, by `workspaces.id` or Clerk org id.
pub struct WarmupTenant {
    pub db: PgPool,
    pub workspace_id: String,
    pub clerk_org_id: Option<String>,
}

pub type WarmupTenants = Arc<
    dyn Fn(String) -> weldsuite_ports::BoxFuture<'static, Result<WarmupTenant, String>>
        + Send
        + Sync,
>;

/// What the crons need.
pub struct WarmupEngine {
    pub master: PgPool,
    pub tenants: WarmupTenants,
    pub keyring: Keyring,
    /// `WELDREACH_WARMUP_KEY`: seals logins for the pool.
    pub warmup_key: Option<String>,
    /// `MAILPOOL_API_KEY` and `MAILPOOL_API_URL`, over this client.
    pub mailpool_key: Option<String>,
    pub mailpool_url: Option<String>,
    pub http: OutboundHttp,
    pub events: EntityEventPublisher,
}

impl WarmupEngine {
    fn mailpool(&self) -> Option<Mailpool> {
        Mailpool::new(
            self.mailpool_key.clone(),
            self.mailpool_url.clone(),
            self.http.clone(),
        )
    }
}

/// One workspace's pass (`WorkspaceWarmupDeps`).
struct Pass<'a> {
    engine: &'a WarmupEngine,
    db: &'a PgPool,
    mailpool: Option<&'a Mailpool>,
    clerk_org_id: String,
    workspace_id: String,
    now: OffsetDateTime,
    domains: HashMap<String, Value>,
    hosts: HashMap<String, Value>,
    pool: HashMap<String, PoolView>,
}

/// `runWarmupSweep(env, deps)`.
pub async fn run_warmup_sweep(engine: &WarmupEngine, now: OffsetDateTime) -> SweepResult {
    let mailpool = engine.mailpool();
    if mailpool.is_none() {
        tracing::warn!(
            "[ReachWarmupSweep] MAILPOOL_API_KEY is not set; mailboxes still provisioning wait"
        );
    }
    let result = due_index::run_sweep(
        &engine.master,
        WARMUP_DUE_KIND,
        now,
        MAX_WORKSPACES_PER_RUN,
        Some(RETRY_AFTER),
        |workspace, at| {
            let mailpool = mailpool.as_ref();
            async move { visit(engine, mailpool, &workspace, at).await }
        },
    )
    .await;
    if result.due > 0 || result.failed > 0 {
        tracing::info!(
            due = result.due,
            processed = result.processed,
            failed = result.failed,
            "[ReachWarmupSweep]"
        );
    }
    result
}

async fn visit(
    engine: &WarmupEngine,
    mailpool: Option<&Mailpool>,
    workspace: &str,
    at: OffsetDateTime,
) -> Result<Option<OffsetDateTime>, String> {
    // Master read only: a workspace that lost access costs no tenant wake-up.
    let access = weldsuite_pipeline::read_app_access(&engine.master, workspace, WELDREACH_APP_CODE)
        .await
        .map_err(|e| e.to_string())?;
    if access.status == "suspended" {
        return Ok(Some(utc_tomorrow(at)));
    }
    if access.status != "approved" || access.workspace_id.is_none() {
        return Ok(None);
    }
    let tenant = (engine.tenants)(workspace.to_owned()).await?;
    process_workspace(engine, mailpool, &tenant, at)
        .await
        .map_err(|e| e.message)
}

/// `processWorkspaceWarmup(deps)`: when the workspace next needs a visit.
async fn process_workspace(
    engine: &WarmupEngine,
    mailpool: Option<&Mailpool>,
    tenant: &WarmupTenant,
    now: OffsetDateTime,
) -> ReachResult<Option<OffsetDateTime>> {
    let db = &tenant.db;
    let mailboxes: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_mailboxes t
         where t.deleted_at is null and t.status in ('provisioning', 'warming', 'active', 'paused', 'error')",
    )
    .fetch_all(db)
    .await?;
    if mailboxes.is_empty() {
        return Ok(None);
    }
    let mailboxes: Vec<Value> = mailboxes.into_iter().map(weldsuite_db::js_row).collect();
    let domain_ids: Vec<String> = weldsuite_reach_domain::unique(
        &mailboxes
            .iter()
            .map(|m| text(m, "domainId").unwrap_or_default().to_owned())
            .collect::<Vec<_>>(),
    );
    let domains: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_domains t where t.id = any($1)")
            .bind(&domain_ids)
            .fetch_all(db)
            .await?;
    let domains: Vec<Value> = domains.into_iter().map(weldsuite_db::js_row).collect();
    let host_ids: Vec<String> = weldsuite_reach_domain::unique(
        &domains
            .iter()
            .map(|d| text(d, "hostDomainId").unwrap_or_default().to_owned())
            .collect::<Vec<_>>(),
    );
    let hosts: Vec<Value> = if host_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar("select to_jsonb(t) from domains t where t.id = any($1)")
            .bind(&host_ids)
            .fetch_all(db)
            .await?
    };
    let clerk_org_id = tenant
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| tenant.workspace_id.clone());
    // One master read per workspace; a failure fails the visit.
    let pool = warmup_pool::read_pool(&engine.master, &clerk_org_id).await?;
    let pass = Pass {
        engine,
        db,
        mailpool,
        clerk_org_id,
        workspace_id: tenant.workspace_id.clone(),
        now,
        domains: domains
            .into_iter()
            .map(|d| (text(&d, "id").unwrap_or_default().to_owned(), d))
            .collect(),
        hosts: hosts
            .into_iter()
            .map(weldsuite_db::js_row)
            .map(|h| (text(&h, "id").unwrap_or_default().to_owned(), h))
            .collect(),
        pool: pool
            .into_iter()
            .map(|p| (p.tenant_mailbox_id.clone(), p))
            .collect(),
    };
    let mut done = Vec::with_capacity(mailboxes.len());
    for mailbox in mailboxes {
        match advance_mailbox(&pass, &mailbox).await {
            Ok(row) => done.push(row),
            Err(error) => {
                // One mailbox's trouble must not stop the rest.
                tracing::error!(error = %error.message, mailbox = text(&mailbox, "id"), "[reach-warmup] mailbox failed");
                done.push(mailbox);
            }
        }
    }
    Ok(next_visit(&done, &pass))
}

/// `hostLapsed(host, now)`.
fn host_lapsed(host: Option<&Value>, now: OffsetDateTime) -> bool {
    let Some(host) = host else {
        return true;
    };
    if host.get("deletedAt").is_some_and(|v| !v.is_null()) || text(host, "status") != Some("active")
    {
        return true;
    }
    text(host, "expiresAt")
        .and_then(parse_iso)
        .is_some_and(|expires| epoch_ms(expires) <= epoch_ms(now))
}

async fn advance_mailbox(pass: &Pass<'_>, mailbox: &Value) -> ReachResult<Value> {
    let id = text(mailbox, "id").unwrap_or_default();
    let domain = pass
        .domains
        .get(text(mailbox, "domainId").unwrap_or_default());
    let lapsed = domain.is_some_and(|d| {
        host_lapsed(
            pass.hosts.get(text(d, "hostDomainId").unwrap_or_default()),
            pass.now,
        )
    });
    let pool = pass.pool.get(id);
    let status = text(mailbox, "status").unwrap_or_default();
    if status == "error" {
        return advance_login_error(pass, mailbox, pool).await;
    }
    if lapsed && status != "paused" {
        warmup_pool::pause(&pass.engine.master, &pass.clerk_org_id, id, DOMAIN_INACTIVE).await?;
        return save(
            pass,
            mailbox,
            json!({ "status": "paused", "pausedReason": DOMAIN_INACTIVE }),
            REACH_MAILBOX_UPDATED,
        )
        .await;
    }
    if status == "paused" {
        let unusable = lapsed || domain.and_then(|d| text(d, "status")) != Some("active");
        return advance_paused(pass, mailbox, pool, unusable).await;
    }
    match status {
        "provisioning" => advance_provisioning(pass, mailbox).await,
        "warming" | "active" => advance_from_pool(pass, mailbox, pool).await,
        _ => Ok(mailbox.clone()),
    }
}

/// `save(deps, mailbox, patch, action)`: persist, and publish when the
/// status changed.
async fn save(
    pass: &Pass<'_>,
    mailbox: &Value,
    patch: Value,
    event: EventName,
) -> ReachResult<Value> {
    if patch.as_object().is_none_or(Map::is_empty) {
        return Ok(mailbox.clone());
    }
    let row: Option<Value> = sqlx::query_scalar(
        "update reach_mailboxes m set
             status = case when $2::jsonb ? 'status' then $2::jsonb->>'status' else m.status end,
             paused_reason = case when $2::jsonb ? 'pausedReason' then $2::jsonb->>'pausedReason' else m.paused_reason end,
             last_error = case when $2::jsonb ? 'lastError' then $2::jsonb->>'lastError' else m.last_error end,
             smtp_credentials = case when $2::jsonb ? 'smtpCredentials' then $2::jsonb->>'smtpCredentials' else m.smtp_credentials end,
             imap_credentials = case when $2::jsonb ? 'imapCredentials' then $2::jsonb->>'imapCredentials' else m.imap_credentials end,
             warmup_started_at = case when $2::jsonb ? 'warmupStartedAt' then ($2::jsonb->>'warmupStartedAt')::timestamptz else m.warmup_started_at end,
             warmup_status = case when $2::jsonb ? 'warmupStatus' then $2::jsonb->>'warmupStatus' else m.warmup_status end,
             warmup_day = case when $2::jsonb ? 'warmupDay' then ($2::jsonb->>'warmupDay')::int else m.warmup_day end,
             warmup_inbox_rate = case when $2::jsonb ? 'warmupInboxRate' then ($2::jsonb->>'warmupInboxRate')::numeric else m.warmup_inbox_rate end,
             ramp_current = case when $2::jsonb ? 'rampCurrent' then ($2::jsonb->>'rampCurrent')::int else m.ramp_current end,
             ramp_updated_at = case when $2::jsonb ? 'rampUpdatedAt' then ($2::jsonb->>'rampUpdatedAt')::timestamptz else m.ramp_updated_at end,
             updated_at = $3::timestamptz
         where m.id = $1 returning to_jsonb(m)",
    )
    .bind(text(mailbox, "id"))
    .bind(&patch)
    .bind(iso(pass.now))
    .fetch_optional(pass.db)
    .await?;
    let row = row.map_or_else(|| mailbox.clone(), weldsuite_db::js_row);
    if text(&row, "status") != text(mailbox, "status") {
        let context = EventContext::new(pass.clerk_org_id.as_str(), "system", EventSource::System);
        pass.engine.events.publish(
            &context,
            EntityEvent::new(
                event,
                text(&row, "id").unwrap_or_default(),
                without_credentials(&row),
            ),
        );
    }
    Ok(row)
}

/// `resumeStatusFor(mailbox)`.
fn resume_status_for(mailbox: &Value) -> &'static str {
    match gate(
        int(mailbox, "warmupDay"),
        mailbox.get("warmupInboxRate").and_then(Value::as_f64),
        false,
    ) {
        None => "active",
        Some(_) => "warming",
    }
}

fn pool_is_running(pool: &PoolView) -> bool {
    matches!(pool.status.as_str(), "warming" | "maintaining" | "waiting")
}

async fn advance_paused(
    pass: &Pass<'_>,
    mailbox: &Value,
    pool: Option<&PoolView>,
    domain_unusable: bool,
) -> ReachResult<Value> {
    if domain_unusable {
        return Ok(mailbox.clone());
    }
    let id = text(mailbox, "id").unwrap_or_default();
    match text(mailbox, "pausedReason") {
        Some(DOMAIN_INACTIVE) => {
            warmup_pool::resume(&pass.engine.master, &pass.clerk_org_id, id).await?;
            save(
                pass,
                mailbox,
                json!({ "status": resume_status_for(mailbox), "pausedReason": null }),
                REACH_MAILBOX_UPDATED,
            )
            .await
        }
        Some(LOW_INBOX_RATE) if pool.is_some_and(pool_is_running) => {
            let warming = save(
                pass,
                mailbox,
                json!({ "status": "warming", "pausedReason": null }),
                REACH_MAILBOX_UPDATED,
            )
            .await?;
            advance_from_pool(pass, &warming, pool).await
        }
        _ => Ok(mailbox.clone()),
    }
}

async fn advance_login_error(
    pass: &Pass<'_>,
    mailbox: &Value,
    pool: Option<&PoolView>,
) -> ReachResult<Value> {
    let Some(pool) = pool else {
        return Ok(mailbox.clone());
    };
    if text(mailbox, "pausedReason") != Some(LOGIN_FAILED)
        || pool.status == "error"
        || has_login_error(pool)
    {
        return Ok(mailbox.clone());
    }
    let warming = save(
        pass,
        mailbox,
        json!({ "status": "warming", "pausedReason": null, "lastError": null }),
        REACH_MAILBOX_UPDATED,
    )
    .await?;
    advance_from_pool(pass, &warming, Some(pool)).await
}

/// `roundRate(rate)`: four decimals (`Math.round(rate * 10000) / 10000`).
fn round_rate(rate: Option<f64>) -> Option<f64> {
    rate.map(|r| (r * 10_000.0 + 0.5).floor() / 10_000.0)
}

fn inbox_rate_of(pool: &PoolView) -> Option<f64> {
    pool.stats
        .as_ref()
        .and_then(|s| s.get("inboxRate3d"))
        .and_then(Value::as_f64)
}

/// `poolSyncPatch(mailbox, pool)`: only where they differ.
fn pool_sync_patch(mailbox: &Value, pool: &PoolView) -> Map<String, Value> {
    let mut patch = Map::new();
    let rate = round_rate(inbox_rate_of(pool));
    if int(mailbox, "warmupDay") != pool.ramp_day {
        patch.insert("warmupDay".to_owned(), json!(pool.ramp_day));
    }
    if text(mailbox, "warmupStatus") != Some(pool.status.as_str()) {
        patch.insert("warmupStatus".to_owned(), json!(pool.status));
    }
    if mailbox.get("warmupInboxRate").and_then(Value::as_f64) != rate {
        patch.insert("warmupInboxRate".to_owned(), json!(rate));
    }
    patch
}

/// `rampPatch(mailbox, now)`.
fn ramp_patch(mailbox: &Value, now: OffsetDateTime) -> Map<String, Value> {
    let cap = int(mailbox, "dailyCap");
    let current = int(mailbox, "rampCurrent");
    let mut ramp = current;
    let ramped_today = text(mailbox, "rampUpdatedAt")
        .and_then(parse_iso)
        .is_some_and(|at| epoch_ms(at) >= epoch_ms(utc_day_start(now)));
    if ramp > cap {
        ramp = cap;
    } else if ramp < cap && !ramped_today {
        ramp = cap.min(ramp + sending::RAMP_STEP);
    }
    let mut patch = Map::new();
    if ramp != current {
        patch.insert("rampCurrent".to_owned(), json!(ramp));
        patch.insert("rampUpdatedAt".to_owned(), json!(iso(now)));
    }
    patch
}

fn merged(mut a: Map<String, Value>, b: Value) -> Value {
    if let Value::Object(b) = b {
        a.extend(b);
    }
    Value::Object(a)
}

async fn advance_from_pool(
    pass: &Pass<'_>,
    mailbox: &Value,
    pool: Option<&PoolView>,
) -> ReachResult<Value> {
    let active = text(mailbox, "status") == Some("active");
    let Some(pool) = pool else {
        tracing::warn!(
            mailbox = text(mailbox, "id"),
            "[reach-warmup] mailbox is not in the warmup pool"
        );
        if active {
            return save(
                pass,
                mailbox,
                Value::Object(ramp_patch(mailbox, pass.now)),
                REACH_MAILBOX_UPDATED,
            )
            .await;
        }
        return Ok(mailbox.clone());
    };
    let sync = pool_sync_patch(mailbox, pool);
    let failing = |reason: &str| pool.paused_reason.as_deref() == Some(reason);
    if pool.status == "error" && failing(LOGIN_FAILED) {
        let patch = merged(
            sync,
            json!({ "status": "error", "pausedReason": LOGIN_FAILED, "lastError": LOGIN_FAILED_MESSAGE }),
        );
        return save(pass, mailbox, patch, REACH_MAILBOX_SUSPENDED).await;
    }
    if pool.status == "paused" && failing(LOW_INBOX_RATE) {
        let patch = merged(
            sync,
            json!({ "status": "paused", "pausedReason": LOW_INBOX_RATE }),
        );
        return save(pass, mailbox, patch, REACH_MAILBOX_UPDATED).await;
    }
    if active {
        let patch = merged(sync, Value::Object(ramp_patch(mailbox, pass.now)));
        return save(pass, mailbox, patch, REACH_MAILBOX_UPDATED).await;
    }
    if gate(pool.ramp_day, inbox_rate_of(pool), has_login_error(pool)).is_some() {
        return save(pass, mailbox, Value::Object(sync), REACH_MAILBOX_UPDATED).await;
    }
    let patch = merged(
        sync,
        json!({
            "status": "active",
            "rampCurrent": sending::RAMP_START.min(int(mailbox, "dailyCap")),
            "rampUpdatedAt": iso(pass.now),
        }),
    );
    save(pass, mailbox, patch, REACH_MAILBOX_UPDATED).await
}

async fn advance_provisioning(pass: &Pass<'_>, mailbox: &Value) -> ReachResult<Value> {
    let (Some(mailpool_id), Some(mailpool)) = (text(mailbox, "mailpoolMailboxId"), pass.mailpool)
    else {
        return Ok(mailbox.clone());
    };
    let remote = mailpool
        .get_mailbox(mailpool_id)
        .await
        .map_err(|e| ReachError::unexpected(&format!("{e:?}")))?;
    match text(&remote, "status") {
        Some("inactive") => {
            let message = remote
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The mailbox provider disabled this mailbox.");
            save(
                pass,
                mailbox,
                json!({ "status": "error", "lastError": message }),
                REACH_MAILBOX_UPDATED,
            )
            .await
        }
        Some("active") => begin_warming(pass, mailbox, &remote).await,
        _ => Ok(mailbox.clone()),
    }
}

/// `beginWarming(deps, mailbox, remote)`: store the logins, register the
/// mailbox in the pool and move it to `warming`. Without usable logins it
/// stays `provisioning` for the next pass.
async fn begin_warming(pass: &Pass<'_>, mailbox: &Value, remote: &Value) -> ReachResult<Value> {
    let keyring = &pass.engine.keyring;
    let smtp =
        smtp_credentials_of(remote).or_else(|| open(keyring, text(mailbox, "smtpCredentials")));
    let imap =
        imap_credentials_of(remote).or_else(|| open(keyring, text(mailbox, "imapCredentials")));
    let (Some(smtp), Some(imap)) = (smtp, imap) else {
        return Ok(mailbox.clone());
    };
    let deps = PoolDeps {
        db: pass.db,
        master: &pass.engine.master,
        warmup_key: pass.engine.warmup_key.clone(),
        clerk_org_id: &pass.clerk_org_id,
        workspace_id: &pass.workspace_id,
    };
    register_in_pool(&deps, mailbox, smtp.clone(), imap.clone(), None).await?;
    let mut patch = json!({
        "status": "warming",
        "warmupStartedAt": text(mailbox, "warmupStartedAt").map_or_else(|| iso(pass.now), str::to_owned),
        "warmupStatus": "waiting",
        "pausedReason": null,
        "lastError": null,
    });
    let sealed = |c| seal(keyring, c).map_err(|e| ReachError::unexpected(&e));
    if text(mailbox, "smtpCredentials").is_none() {
        patch["smtpCredentials"] = json!(sealed(&smtp)?);
    }
    if text(mailbox, "imapCredentials").is_none() {
        patch["imapCredentials"] = json!(sealed(&imap)?);
    }
    save(pass, mailbox, patch, REACH_MAILBOX_UPDATED).await
}

/// `nextVisit(mailboxes, ctx, now)`.
fn next_visit(mailboxes: &[Value], pass: &Pass<'_>) -> Option<OffsetDateTime> {
    let tomorrow = utc_tomorrow(pass.now);
    let mut next: Option<OffsetDateTime> = None;
    let mut consider = |at: OffsetDateTime| {
        if next.is_none_or(|current| at < current) {
            next = Some(at);
        }
    };
    for m in mailboxes {
        let status = text(m, "status").unwrap_or_default();
        let reason = text(m, "pausedReason");
        let progressing = matches!(status, "provisioning" | "warming")
            || (status == "active" && int(m, "rampCurrent") < int(m, "dailyCap"))
            || (status == "paused" && matches!(reason, Some(DOMAIN_INACTIVE | LOW_INBOX_RATE)))
            || (status == "error" && reason == Some(LOGIN_FAILED));
        if progressing {
            consider(tomorrow);
        }
        if matches!(status, "active" | "warming" | "provisioning") {
            let expires = pass
                .domains
                .get(text(m, "domainId").unwrap_or_default())
                .and_then(|d| pass.hosts.get(text(d, "hostDomainId").unwrap_or_default()))
                .and_then(|h| text(h, "expiresAt"))
                .and_then(parse_iso);
            if let Some(expires) = expires
                && epoch_ms(expires) > epoch_ms(pass.now)
            {
                consider(expires);
            }
        }
    }
    next
}

// ---------------------------------------------------------------------------
// Mailpool slots
// ---------------------------------------------------------------------------

/// Slots beyond what is in use that the reconciliation leaves alone.
pub const SLOT_SURPLUS_TOLERANCE: i64 = 2;
const SLOT_TYPES: [&str; 4] = ["google", "shared", "private", "outlook"];
/// What a mailbox costs WeldSuite per month at Mailpool, by type.
const MAILPOOL_COST_CENTS: [(&str, i64); 2] = [("shared", 300), ("google", 400)];
const INBOX_PRICE_CENTS: i64 = 500;

/// `SlotAdjustment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotAdjustment {
    pub kind: String,
    pub need: i64,
    pub slots: i64,
    pub used_at_mailpool: Option<i64>,
    pub surplus: i64,
    pub decrease_by: i64,
    pub drift: bool,
}

/// `computeSlotAdjustments(need, mailpool)`: per type Mailpool reports
/// slots for, give back a surplus above the tolerance; a shortage is drift.
#[allow(clippy::implicit_hasher, reason = "the counts come from one query")]
pub fn compute_slot_adjustments(
    need: &HashMap<String, i64>,
    mailboxes: &Value,
    slots: &Value,
) -> Vec<SlotAdjustment> {
    let Some(slots) = slots.as_object() else {
        return Vec::new();
    };
    slots
        .iter()
        .filter(|(kind, _)| SLOT_TYPES.contains(&kind.as_str()))
        .filter_map(|(kind, count)| {
            let slots = count
                .as_i64()
                .or_else(|| count.as_f64().map(|f| f as i64))?;
            let wanted = need.get(kind).copied().unwrap_or(0);
            let surplus = slots - wanted;
            let used = mailboxes.get(kind).and_then(Value::as_i64);
            Some(SlotAdjustment {
                kind: kind.clone(),
                need: wanted,
                slots,
                used_at_mailpool: used,
                surplus,
                decrease_by: if surplus > SLOT_SURPLUS_TOLERANCE {
                    surplus
                } else {
                    0
                },
                drift: surplus < 0 || used.is_some_and(|u| u != wanted),
            })
        })
        .collect()
}

/// `runSlotReconciliation(env)`: the report, or `None` without Mailpool.
pub async fn run_slot_reconciliation(engine: &WarmupEngine) -> Result<Option<Value>, String> {
    let Some(mailpool) = engine.mailpool() else {
        tracing::warn!("[ReachSlots] MAILPOOL_API_KEY is not set; skipping");
        return Ok(None);
    };
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "select mailbox_type, count(*) from reach_routes
         where kind = 'mailpool_mailbox' and status = 'active' and mailbox_type is not null
         group by mailbox_type",
    )
    .fetch_all(&engine.master)
    .await
    .map_err(|e| e.to_string())?;
    let need: HashMap<String, i64> = rows.into_iter().collect();
    let (mailboxes, slots) = mailpool.get_slots().await.map_err(|e| format!("{e:?}"))?;
    let adjustments = compute_slot_adjustments(&need, &mailboxes, &slots);
    let mut decreased = Map::new();
    let mut failed = Vec::new();
    for a in &adjustments {
        if a.drift {
            tracing::warn!(kind = a.kind, need = a.need, slots = a.slots, used_at_mailpool = ?a.used_at_mailpool, "[ReachSlots] drift");
        }
        if a.decrease_by <= 0 {
            continue;
        }
        match mailpool.decrease_slots(&a.kind, a.decrease_by).await {
            Ok(()) => {
                decreased.insert(a.kind.clone(), json!(a.decrease_by));
                tracing::info!(
                    kind = a.kind,
                    by = a.decrease_by,
                    need = a.need,
                    had = a.slots,
                    "[ReachSlots] gave back slots"
                );
            }
            Err(error) => {
                failed.push(a.kind.clone());
                tracing::error!(
                    ?error,
                    kind = a.kind,
                    by = a.decrease_by,
                    "[ReachSlots] could not decrease slots"
                );
            }
        }
    }
    let cost: i64 = need
        .iter()
        .map(|(kind, n)| {
            n * MAILPOOL_COST_CENTS
                .iter()
                .find(|(k, _)| k == kind)
                .map_or(0, |(_, c)| *c)
        })
        .sum();
    let total: i64 = need.values().sum();
    let revenue = total * INBOX_PRICE_CENTS;
    tracing::info!(
        mailboxes = total,
        mailpool_cost_cents = cost,
        revenue_cents = revenue,
        "[ReachSlots]"
    );
    Ok(Some(json!({
        "need": need,
        "adjustments": adjustments.iter().map(|a| json!({
            "type": a.kind, "need": a.need, "slots": a.slots, "usedAtMailpool": a.used_at_mailpool,
            "surplus": a.surplus, "decreaseBy": a.decrease_by, "drift": a.drift,
        })).collect::<Vec<_>>(),
        "decreased": decreased,
        "failed": failed,
        "monthlyCostCents": cost,
        "monthlyRevenueCents": revenue,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_adjustments() {
        let need = HashMap::from([("google".to_owned(), 3), ("shared".to_owned(), 1)]);
        let adjustments = compute_slot_adjustments(
            &need,
            &json!({ "google": 3, "private": 1 }),
            &json!({ "google": 7, "private": 1, "outlook": 0, "weird": 9 }),
        );
        let google = adjustments
            .iter()
            .find(|a| a.kind == "google")
            .expect("google");
        assert_eq!(
            (google.surplus, google.decrease_by, google.drift),
            (4, 4, false)
        );
        let private = adjustments
            .iter()
            .find(|a| a.kind == "private")
            .expect("private");
        assert_eq!(
            (private.surplus, private.decrease_by, private.drift),
            (1, 0, true)
        );
        assert!(adjustments.iter().all(|a| a.kind != "weird"));
    }

    #[test]
    fn ramps_once_a_day_up_to_the_cap() {
        let now = parse_iso("2026-10-12T10:00:00.000Z").expect("now");
        let m = json!({ "dailyCap": 30, "rampCurrent": 10, "rampUpdatedAt": "2026-10-11T09:00:00.000Z" });
        assert_eq!(ramp_patch(&m, now).get("rampCurrent"), Some(&json!(15)));
        let today = json!({ "dailyCap": 30, "rampCurrent": 10, "rampUpdatedAt": "2026-10-12T01:00:00.000Z" });
        assert!(ramp_patch(&today, now).is_empty());
        let over = json!({ "dailyCap": 20, "rampCurrent": 25, "rampUpdatedAt": null });
        assert_eq!(ramp_patch(&over, now).get("rampCurrent"), Some(&json!(20)));
        assert_eq!(round_rate(Some(0.876_54)), Some(0.8765));
    }
}
