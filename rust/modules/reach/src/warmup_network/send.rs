//! `send.ts`, the sender (queue `reach-warmup-send`): sends one scheduled
//! warmup email over the sender mailbox's own SMTP login.
//!
//! The message carries nothing that says "warmup": plain text from the
//! corpus with the pair's names filled in, the stored Message-ID, and the
//! usual In-Reply-To / References on a reply.
//!
//! - ok: `sent`, engagement scheduled 10-120 minutes later
//! - login rejected: sender mailbox `error` (`login_failed`), message `failed`
//! - delivery uncertain: treated as sent (the engager finds it or marks it
//!   missing)
//! - anything else: `failed` with the reason, never retried
//!
//! An `Err` (a database error, or the transport failing outright) retries
//! the queue message.

use weldsuite_reach_domain::from_epoch_ms;
use weldsuite_reach_domain::smtp::{
    MailAddress, OutgoingMessage, SmtpConfig, SmtpEnvelope, SmtpSendResult, build_mime_message,
};

use super::WarmupNetwork;
use super::clock::{MINUTE_MS, Rng, js_date, random_between};
use super::corpus::{find_thread, render_corpus_message};
use super::db::{
    PoolMailbox, WarmupMessage, clip_error, is_eligible, load_mailboxes, load_message, open_login,
    take_claim, ts,
};
use super::pool_state::{pause_for_credentials, record_login_failure, record_login_success};

/// Engagement follows the send by this many minutes.
pub const ENGAGE_DELAY_MIN_MINUTES: f64 = 10.0;
pub const ENGAGE_DELAY_MAX_MINUTES: f64 = 120.0;

/// `SendOutcome`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    Sent,
    Uncertain,
    Failed(String),
    Paused(String),
    Skipped(String),
}

#[allow(clippy::needless_pass_by_value)] // map_err hands it over
fn db(error: sqlx::Error) -> String {
    error.to_string()
}

/// `settle(ctx, id, patch)` for a failure: free the claim and record it.
/// Only touches a row that is still `scheduled`.
async fn fail(net: &WarmupNetwork, id: &str, error: &str) -> Result<SendOutcome, String> {
    let text = clip_error(error);
    sqlx::query(
        "update reach_warmup_messages set status = 'failed', error = $2, claimed_at = null
         where id = $1 and status = 'scheduled'",
    )
    .bind(id)
    .bind(&text)
    .execute(&net.master)
    .await
    .map_err(db)?;
    Ok(SendOutcome::Failed(text))
}

/// `recordSent(ctx, id, uncertain)`.
async fn record_sent(
    net: &WarmupNetwork,
    id: &str,
    uncertain: bool,
    now: i64,
    rng: Rng<'_>,
) -> Result<(), String> {
    let delay =
        random_between(rng, ENGAGE_DELAY_MIN_MINUTES, ENGAGE_DELAY_MAX_MINUTES) * MINUTE_MS as f64;
    sqlx::query(
        "update reach_warmup_messages set status = 'sent', sent_at = $2::timestamptz,
           engage_at = $3::timestamptz, error = $4, claimed_at = null
         where id = $1 and status = 'scheduled'",
    )
    .bind(id)
    .bind(ts(now))
    .bind(ts(js_date(now as f64 + delay)))
    .bind(uncertain.then_some("delivery_uncertain"))
    .execute(&net.master)
    .await
    .map_err(db)?;
    Ok(())
}

/// `describeFailure(result)`. lettre's text already carries the reply code.
fn describe_failure(result: &SmtpSendResult) -> String {
    format!("smtp {}: {}", result.stage, result.response)
}

/// `referenceList(row)`.
fn reference_list(row: &WarmupMessage) -> Vec<String> {
    row.references
        .as_deref()
        .unwrap_or_default()
        .split(' ')
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `loadParties(ctx, row)`: both mailboxes, or `None` when one is gone.
async fn load_parties(
    net: &WarmupNetwork,
    row: &WarmupMessage,
) -> Result<Option<(PoolMailbox, PoolMailbox)>, String> {
    let rows = load_mailboxes(
        &net.master,
        &[row.from_mailbox_id.clone(), row.to_mailbox_id.clone()],
    )
    .await
    .map_err(db)?;
    let find = |id: &str| rows.iter().find(|m| m.id == id).cloned();
    Ok(find(&row.from_mailbox_id).zip(find(&row.to_mailbox_id)))
}

fn address(mailbox: &PoolMailbox) -> MailAddress {
    let name = mailbox.display_name();
    MailAddress {
        email: mailbox.email.clone(),
        name: (!name.is_empty()).then_some(name),
    }
}

/// `processSend(env, messageId, ctx)`.
pub async fn process_send(
    net: &WarmupNetwork,
    message_id: &str,
    now: i64,
    rng: Rng<'_>,
) -> Result<SendOutcome, String> {
    let Some(row) = load_message(&net.master, message_id).await.map_err(db)? else {
        return Ok(SendOutcome::Skipped("not_scheduled".to_owned()));
    };
    if row.status != "scheduled" {
        return Ok(SendOutcome::Skipped("not_scheduled".to_owned()));
    }
    if !take_claim(&net.master, &row, "scheduled", now)
        .await
        .map_err(db)?
    {
        return Ok(SendOutcome::Skipped("claim_lost".to_owned()));
    }

    let parties = load_parties(net, &row).await?;
    let Some((sender, recipient)) =
        parties.filter(|(s, r)| is_eligible(&s.status) && is_eligible(&r.status))
    else {
        return fail(net, &row.id, "mailbox_inactive").await;
    };

    let Some(smtp) = open_login(net.warmup_key.as_deref(), &sender.smtp_credentials) else {
        pause_for_credentials(&net.master, &sender, now)
            .await
            .map_err(db)?;
        sqlx::query(
            "update reach_warmup_messages set status = 'failed', error = 'credentials_unavailable', claimed_at = null
             where id = $1 and status = 'scheduled'",
        )
        .bind(&row.id)
        .execute(&net.master)
        .await
        .map_err(db)?;
        return Ok(SendOutcome::Paused("credentials_unavailable".to_owned()));
    };

    let Some(thread) = find_thread(&row.corpus_thread_id) else {
        return fail(net, &row.id, "corpus_thread_missing").await;
    };
    let text = match render_corpus_message(
        thread,
        i64::from(row.step),
        &sender.person(),
        &recipient.person(),
    ) {
        Ok(rendered) => rendered.text,
        Err(error) => return fail(net, &row.id, &format!("render_failed: {error}")).await,
    };

    let raw = build_mime_message(&OutgoingMessage {
        from: address(&sender),
        to: vec![address(&recipient)],
        reply_to: None,
        subject: row.subject.clone(),
        text,
        html: None,
        message_id: row.message_id_header.clone(),
        in_reply_to: row.in_reply_to.clone(),
        references: reference_list(&row),
        headers: Vec::new(),
        date: from_epoch_ms(now),
    })?;
    let result = net
        .smtp
        .send(
            SmtpConfig {
                host: smtp.host.clone(),
                port: smtp.port,
                secure: smtp.port == 465,
                username: smtp.username.clone(),
                password: smtp.password.clone(),
            },
            SmtpEnvelope {
                from: sender.email.clone(),
                to: vec![recipient.email.clone()],
            },
            raw,
        )
        .await?;

    if result.ok {
        record_login_success(&net.master, &sender, now)
            .await
            .map_err(db)?;
        record_sent(net, &row.id, false, now, rng).await?;
        return Ok(SendOutcome::Sent);
    }
    if result.auth_failed {
        record_login_failure(&net.master, &sender, "smtp", &result.response, now)
            .await
            .map_err(db)?;
        return fail(net, &row.id, &describe_failure(&result)).await;
    }
    if result.delivery_uncertain {
        record_sent(net, &row.id, true, now, rng).await?;
        return Ok(SendOutcome::Uncertain);
    }
    fail(net, &row.id, &describe_failure(&result)).await
}
