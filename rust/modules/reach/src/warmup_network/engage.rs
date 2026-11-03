//! `engage.ts`, the engager (queue `reach-warmup-engage`): acts on one sent
//! warmup email in the recipient's mailbox, over IMAP.
//!
//! 1. find it by Message-ID in INBOX, else in the Junk folder (SPECIAL-USE
//!    or a well-known name); a hit in Junk is moved to INBOX
//! 2. record where it landed (`inbox` / `spam`): the inbox-placement signal
//! 3. open it: `\Seen`, and `\Flagged` on about one in five
//! 4. maybe reply: a new scheduled message in the same thread, sent the
//!    other way with In-Reply-To / References
//!
//! Not found anywhere: again in 2 hours, and after 3 attempts the message
//! is `missing`. A rejected login takes the recipient mailbox out
//! (`error`, `login_failed`) and the message is tried again 6 hours later
//! without counting. Other IMAP failures retry sooner and end as `failed`,
//! never as `missing`: only a clean search that finds nothing says the
//! email did not arrive.

use serde_json::{Map, Value, json};
use weldsuite_kit::generate_id;
use weldsuite_ports::{ImapConfig, ImapError, ImapSession, SpecialUse};
use weldsuite_reach_domain::smtp::generate_message_id;
use weldsuite_reach_domain::warmup::{WARMUP_REPLY_RATE_MAX, WARMUP_REPLY_RATE_MIN};

use super::WarmupNetwork;
use super::clock::{HOUR_MS, MINUTE_MS, Rng, chance, into_business_hours, js_date, random_between};
use super::corpus::{find_thread, render_corpus_message};
use super::db::{
    PoolMailbox, WarmupMessage, clip_error, is_eligible, load_mailboxes, load_message, open_login,
    take_claim, ts,
};
use super::dispatch::MAX_ENGAGE_ATTEMPTS;
use super::pool_state::{pause_for_credentials, record_login_failure, record_login_success};

/// Share of received emails that also get `\Flagged`.
pub const FLAG_RATE: f64 = 0.2;
/// Chance that a thread continues after its first reply.
pub const CONTINUE_RATE: f64 = 0.5;
/// A reply goes out this long after the engagement (then into the
/// replier's business hours).
pub const REPLY_DELAY_MIN_MINUTES: f64 = 20.0;
pub const REPLY_DELAY_MAX_MINUTES: f64 = 4.0 * 60.0;
/// Wait before searching again after a clean miss.
pub const NOT_FOUND_RETRY_MS: i64 = 2 * HOUR_MS;
/// Wait after the recipient's login was rejected or its mailbox is parked.
pub const LOGIN_RETRY_MS: i64 = 6 * HOUR_MS;
/// Wait after a connection error or timeout.
pub const TRANSIENT_RETRY_MS: i64 = 30 * MINUTE_MS;
/// A message whose recipient stays parked longer than this is given up on.
pub const INACTIVE_GIVE_UP_MS: i64 = 48 * HOUR_MS;

/// `EngageOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngageOutcome {
    Engaged {
        placement: &'static str,
        reply_scheduled: bool,
    },
    Missing,
    Deferred(String),
    Failed(String),
    Skipped(String),
}

/// What can stop an engagement: the mailbox (IMAP) or our own database.
enum Stop {
    Imap(ImapError),
    Fatal(String),
}

impl From<ImapError> for Stop {
    fn from(error: ImapError) -> Self {
        Self::Imap(error)
    }
}

impl From<sqlx::Error> for Stop {
    fn from(error: sqlx::Error) -> Self {
        Self::Fatal(error.to_string())
    }
}

#[allow(clippy::needless_pass_by_value)] // map_err hands it over
fn db(error: sqlx::Error) -> String {
    error.to_string()
}

/// What `settle` writes; `None` leaves a column as it is (no patch sets one
/// to null).
#[derive(Default)]
struct Patch {
    status: Option<&'static str>,
    engage_at: Option<i64>,
    engage_attempts: Option<i32>,
    engaged_at: Option<i64>,
    placement: Option<&'static str>,
    actions: Option<Value>,
    error: Option<String>,
}

/// `settle(ctx, id, patch)`: free the claim and record the new state. Only
/// touches a row that is still `sent`.
async fn settle(net: &WarmupNetwork, id: &str, patch: Patch) -> sqlx::Result<()> {
    sqlx::query(
        "update reach_warmup_messages set
           status = coalesce($2, status),
           engage_at = coalesce($3::timestamptz, engage_at),
           engage_attempts = coalesce($4::int4, engage_attempts),
           engaged_at = coalesce($5::timestamptz, engaged_at),
           placement = coalesce($6, placement),
           actions = coalesce($7::jsonb, actions),
           error = coalesce($8, error),
           claimed_at = null
         where id = $1 and status = 'sent'",
    )
    .bind(id)
    .bind(patch.status)
    .bind(patch.engage_at.map(ts))
    .bind(patch.engage_attempts)
    .bind(patch.engaged_at.map(ts))
    .bind(patch.placement)
    .bind(patch.actions.map(|actions| actions.to_string()))
    .bind(patch.error)
    .execute(&net.master)
    .await?;
    Ok(())
}

/// `deferEngagement(ctx, id, afterMs, { engageAttempts })`.
async fn defer(
    net: &WarmupNetwork,
    id: &str,
    now: i64,
    after_ms: i64,
    attempts: Option<i32>,
) -> sqlx::Result<()> {
    let patch = Patch {
        engage_at: Some(now + after_ms),
        engage_attempts: attempts,
        ..Patch::default()
    };
    settle(net, id, patch).await
}

/// `giveUp(ctx, id, error)`.
async fn give_up(net: &WarmupNetwork, id: &str, error: &str) -> sqlx::Result<EngageOutcome> {
    let text = clip_error(error);
    let patch = Patch {
        status: Some("failed"),
        error: Some(text.clone()),
        ..Patch::default()
    };
    settle(net, id, patch).await?;
    Ok(EngageOutcome::Failed(text))
}

struct Located {
    placement: &'static str,
    /// UIDs of the message in INBOX (after a move out of Junk).
    uids: Vec<u32>,
    moved_from_spam: bool,
}

/// `locateMessage(session, messageId)`: INBOX first; then the Junk folder,
/// rescuing the message into INBOX. `None`: not there.
async fn locate(
    session: &mut dyn ImapSession,
    message_id: &str,
) -> Result<Option<Located>, ImapError> {
    session.select("INBOX").await?;
    let in_inbox = session.search_by_message_id(message_id).await?;
    if !in_inbox.is_empty() {
        return Ok(Some(Located {
            placement: "inbox",
            uids: in_inbox,
            moved_from_spam: false,
        }));
    }
    let Some(junk) = session.find_special_use(SpecialUse::Junk).await? else {
        return Ok(None);
    };
    session.select(&junk).await?;
    let in_junk = session.search_by_message_id(message_id).await?;
    if in_junk.is_empty() {
        return Ok(None);
    }
    session.move_messages(&in_junk, "INBOX").await?;
    session.select("INBOX").await?;
    Ok(Some(Located {
        placement: "spam",
        uids: session.search_by_message_id(message_id).await?,
        moved_from_spam: true,
    }))
}

/// `markOpened(session, uids, rng)`: `\Seen`, now and then `\Flagged`.
async fn mark_opened(
    session: &mut dyn ImapSession,
    uids: &[u32],
    rng: Rng<'_>,
) -> Result<bool, ImapError> {
    if uids.is_empty() {
        return Ok(false);
    }
    let flagged = chance(rng, FLAG_RATE);
    let flags: &[&str] = if flagged {
        &["\\Seen", "\\Flagged"]
    } else {
        &["\\Seen"]
    };
    session.add_flags(uids, flags).await?;
    Ok(flagged)
}

/// `wantsReply(row, rng)`: the first reply at the 30-45% rate, later ones
/// continue 50/50.
fn wants_reply(row: &WarmupMessage, rng: Rng<'_>) -> bool {
    if row.step > 0 {
        return chance(rng, CONTINUE_RATE);
    }
    let rate = random_between(&mut *rng, WARMUP_REPLY_RATE_MIN, WARMUP_REPLY_RATE_MAX);
    chance(rng, rate)
}

/// `referenceChain(row)`.
fn reference_chain(row: &WarmupMessage) -> String {
    let mut ids: Vec<&str> = row
        .references
        .as_deref()
        .unwrap_or_default()
        .split(' ')
        .filter(|id| !id.is_empty())
        .collect();
    ids.push(&row.message_id_header);
    ids.join(" ")
}

/// `scheduleReply(ctx, row, sender, recipient)`: the next step of the
/// thread, from the recipient back to the sender, 20 minutes to 4 hours
/// from now, inside the replier's business hours where possible. A retry of
/// an already handled email finds its reply and adds none.
async fn schedule_reply(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    sender: &PoolMailbox,
    recipient: &PoolMailbox,
    now: i64,
    rng: Rng<'_>,
) -> sqlx::Result<bool> {
    let Some(thread) = find_thread(&row.corpus_thread_id) else {
        return Ok(false);
    };
    let step = i64::from(row.step);
    if step >= thread.messages.len() as i64 - 1 {
        return Ok(false);
    }
    if !is_eligible(&sender.status) || !wants_reply(row, &mut *rng) {
        return Ok(false);
    }
    let existing: Option<String> =
        sqlx::query_scalar("select id from reach_warmup_messages where in_reply_to = $1 limit 1")
            .bind(&row.message_id_header)
            .fetch_optional(&net.master)
            .await?;
    if existing.is_some() {
        return Ok(true);
    }
    let next = step + 1;
    let subject = match render_corpus_message(thread, next, &recipient.person(), &sender.person()) {
        Ok(rendered) => rendered.subject,
        Err(error) => {
            tracing::warn!(id = row.id, %error, "[reach-warmup] engage: no reply");
            return Ok(false);
        }
    };
    let Ok(message_id_header) = generate_message_id(&recipient.domain) else {
        return Ok(false);
    };
    let delay = random_between(&mut *rng, REPLY_DELAY_MIN_MINUTES, REPLY_DELAY_MAX_MINUTES)
        * MINUTE_MS as f64;
    let scheduled_at = into_business_hours(js_date(now as f64 + delay), &recipient.timezone, rng);
    sqlx::query(
        "insert into reach_warmup_messages (id, thread_id, step, from_mailbox_id, to_mailbox_id,
           corpus_thread_id, message_id_header, in_reply_to, \"references\", subject, status, scheduled_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled', $11::timestamptz)",
    )
    .bind(generate_id("rwms"))
    .bind(&row.thread_id)
    .bind(i32::try_from(next).unwrap_or(i32::MAX))
    .bind(&recipient.id)
    .bind(&sender.id)
    .bind(&row.corpus_thread_id)
    .bind(message_id_header)
    .bind(&row.message_id_header)
    .bind(reference_chain(row))
    .bind(subject)
    .bind(ts(scheduled_at))
    .execute(&net.master)
    .await?;
    Ok(true)
}

/// `recordEngaged(...)`.
async fn record_engaged(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    found: &Located,
    flagged: bool,
    reply_scheduled: bool,
    now: i64,
) -> sqlx::Result<()> {
    let mut actions = Map::new();
    actions.insert("seen".to_owned(), json!(!found.uids.is_empty()));
    if flagged {
        actions.insert("flagged".to_owned(), json!(true));
    }
    if found.moved_from_spam {
        actions.insert("movedFromSpam".to_owned(), json!(true));
    }
    if reply_scheduled {
        actions.insert("replyScheduled".to_owned(), json!(true));
    }
    let patch = Patch {
        status: Some("engaged"),
        engaged_at: Some(now),
        placement: Some(found.placement),
        actions: Some(Value::Object(actions)),
        ..Patch::default()
    };
    settle(net, &row.id, patch).await
}

/// `recordNotFound(ctx, row)`: a clean search found nothing.
async fn record_not_found(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    now: i64,
) -> sqlx::Result<EngageOutcome> {
    let attempts = row.engage_attempts + 1;
    if attempts >= MAX_ENGAGE_ATTEMPTS {
        let patch = Patch {
            status: Some("missing"),
            placement: Some("missing"),
            engage_attempts: Some(attempts),
            ..Patch::default()
        };
        settle(net, &row.id, patch).await?;
        return Ok(EngageOutcome::Missing);
    }
    defer(net, &row.id, now, NOT_FOUND_RETRY_MS, Some(attempts)).await?;
    Ok(EngageOutcome::Deferred("not_found".to_owned()))
}

/// `recordTransientFailure(ctx, row, error)`: count the attempt, try again
/// soon, never conclude `missing`.
async fn record_transient_failure(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    error: &ImapError,
    now: i64,
) -> sqlx::Result<EngageOutcome> {
    let attempts = row.engage_attempts + 1;
    let kind = error.kind.as_str();
    if attempts >= MAX_ENGAGE_ATTEMPTS {
        return give_up(net, &row.id, &format!("imap_{kind}: {}", error.message)).await;
    }
    defer(net, &row.id, now, TRANSIENT_RETRY_MS, Some(attempts)).await?;
    Ok(EngageOutcome::Deferred(format!("imap_{kind}")))
}

/// `checkRecipient(...)`: whether to attempt now. A parked recipient
/// defers the message; one that stays parked too long ends it.
async fn check_recipient(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    recipient: Option<&PoolMailbox>,
    now: i64,
) -> sqlx::Result<Option<EngageOutcome>> {
    let Some(recipient) = recipient.filter(|r| r.status != "removed") else {
        return give_up(net, &row.id, "mailbox_inactive").await.map(Some);
    };
    if is_eligible(&recipient.status) {
        return Ok(None);
    }
    let sent_at = row.sent_at.unwrap_or(row.created_at);
    if now - sent_at > INACTIVE_GIVE_UP_MS {
        return give_up(net, &row.id, "mailbox_inactive").await.map(Some);
    }
    defer(net, &row.id, now, LOGIN_RETRY_MS, None).await?;
    Ok(Some(EngageOutcome::Deferred("mailbox_inactive".to_owned())))
}

/// `engageViaImap(...)`, after the login was recorded as working.
async fn engage_in_session(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    sender: Option<&PoolMailbox>,
    recipient: &PoolMailbox,
    session: &mut dyn ImapSession,
    now: i64,
    rng: Rng<'_>,
) -> Result<EngageOutcome, Stop> {
    record_login_success(&net.master, recipient, now).await?;
    let Some(found) = locate(session, &row.message_id_header).await? else {
        return Ok(record_not_found(net, row, now).await?);
    };
    let flagged = mark_opened(session, &found.uids, &mut *rng).await?;
    let reply_scheduled = match sender {
        Some(sender) => schedule_reply(net, row, sender, recipient, now, rng).await?,
        None => false,
    };
    record_engaged(net, row, &found, flagged, reply_scheduled, now).await?;
    Ok(EngageOutcome::Engaged {
        placement: found.placement,
        reply_scheduled,
    })
}

/// A failed login or command: a rejected login takes the recipient out and
/// waits 6 hours; anything else is transient.
async fn imap_failed(
    net: &WarmupNetwork,
    row: &WarmupMessage,
    recipient: &PoolMailbox,
    error: &ImapError,
    now: i64,
) -> Result<EngageOutcome, String> {
    if error.auth_failed() {
        record_login_failure(&net.master, recipient, "imap", error.detail(), now)
            .await
            .map_err(db)?;
        defer(net, &row.id, now, LOGIN_RETRY_MS, None)
            .await
            .map_err(db)?;
        return Ok(EngageOutcome::Deferred("login_failed".to_owned()));
    }
    record_transient_failure(net, row, error, now)
        .await
        .map_err(db)
}

/// `processEngage(env, messageId, ctx)`. An `Err` retries the queue message.
pub async fn process_engage(
    net: &WarmupNetwork,
    message_id: &str,
    now: i64,
    rng: Rng<'_>,
) -> Result<EngageOutcome, String> {
    let Some(row) = load_message(&net.master, message_id).await.map_err(db)? else {
        return Ok(EngageOutcome::Skipped("not_sent".to_owned()));
    };
    if row.status != "sent" {
        return Ok(EngageOutcome::Skipped("not_sent".to_owned()));
    }
    if !take_claim(&net.master, &row, "sent", now)
        .await
        .map_err(db)?
    {
        return Ok(EngageOutcome::Skipped("claim_lost".to_owned()));
    }

    let rows = load_mailboxes(
        &net.master,
        &[row.from_mailbox_id.clone(), row.to_mailbox_id.clone()],
    )
    .await
    .map_err(db)?;
    let sender = rows.iter().find(|m| m.id == row.from_mailbox_id);
    let recipient = rows.iter().find(|m| m.id == row.to_mailbox_id);
    if let Some(blocked) = check_recipient(net, &row, recipient, now)
        .await
        .map_err(db)?
    {
        return Ok(blocked);
    }
    let Some(recipient) = recipient else {
        return Ok(EngageOutcome::Skipped("no_recipient".to_owned()));
    };

    let Some(login) = open_login(net.warmup_key.as_deref(), &recipient.imap_credentials) else {
        pause_for_credentials(&net.master, recipient, now)
            .await
            .map_err(db)?;
        defer(net, &row.id, now, LOGIN_RETRY_MS, None)
            .await
            .map_err(db)?;
        return Ok(EngageOutcome::Deferred(
            "credentials_unavailable".to_owned(),
        ));
    };

    let config = ImapConfig::new(&login.host, login.port, &login.username, &login.password);
    let mut session = match net.imap.connect(&config).await {
        Ok(session) => session,
        Err(error) => return imap_failed(net, &row, recipient, &error, now).await,
    };
    let result = engage_in_session(net, &row, sender, recipient, session.as_mut(), now, rng).await;
    session.logout().await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(Stop::Imap(error)) => imap_failed(net, &row, recipient, &error, now).await,
        Err(Stop::Fatal(error)) => Err(error),
    }
}
