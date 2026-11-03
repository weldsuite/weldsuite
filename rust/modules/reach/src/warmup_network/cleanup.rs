//! `cleanup.ts` (daily): warmup mail older than `WARMUP_CLEANUP_AFTER_DAYS`
//! is deleted from the mailboxes it sits in, so they stay light.
//!
//! Each engaged / missing message is removed from the recipient's INBOX and
//! the sender's Sent folder, found by Message-ID over IMAP (moved to Trash
//! and deleted there, so Gmail really drops it instead of archiving it).
//! One IMAP session per mailbox, at most [`CLEANUP_MAX_MAILBOXES`] mailboxes
//! per run; the rest follows on later days. `cleaned_at` is set only for
//! messages cleaned on both sides. The message rows themselves are kept
//! [`ROW_RETENTION_DAYS`] and then deleted; the inbound filter reads them
//! until then.

use std::collections::{BTreeMap, HashSet};

use sqlx::PgPool;
use weldsuite_ports::{ImapConfig, ImapError, ImapSession, SpecialUse};
use weldsuite_reach_domain::warmup::WARMUP_CLEANUP_AFTER_DAYS;

use super::WarmupNetwork;
use super::clock::DAY_MS;
use super::db::{PoolMailbox, load_mailboxes, open_login, ts};
use super::pool_state::{record_login_failure, record_login_success};

pub const CLEANUP_MAX_MAILBOXES: usize = 30;
/// Message-IDs searched per mailbox per run.
pub const CLEANUP_MAX_IDS_PER_MAILBOX: usize = 60;
pub const CLEANUP_CANDIDATE_LIMIT: i64 = 500;
pub const ROW_RETENTION_DAYS: i64 = 30;

/// `CleanupCandidate`.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct CleanupCandidate {
    pub id: String,
    pub from_mailbox_id: String,
    pub to_mailbox_id: String,
    pub message_id_header: String,
}

/// `MailboxWork`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MailboxWork {
    /// Message-IDs to delete from INBOX (as recipient).
    pub inbox: Vec<String>,
    /// Message-IDs to delete from the Sent folder (as sender).
    pub sent: Vec<String>,
}

impl MailboxWork {
    fn ids(&self) -> usize {
        self.inbox.len() + self.sent.len()
    }
}

/// `CleanupPlan`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupPlan {
    pub work: BTreeMap<String, MailboxWork>,
    /// The messages this run takes on, whole (both sides).
    pub selected: Vec<CleanupCandidate>,
}

/// `planCleanup(candidates, maxMailboxes, maxIds)`: whole messages (oldest
/// first) while the mailboxes they touch stay within `max_mailboxes` and
/// each mailbox within `max_ids` Message-IDs.
pub fn plan_cleanup(
    candidates: &[CleanupCandidate],
    max_mailboxes: usize,
    max_ids: usize,
) -> CleanupPlan {
    let mut plan = CleanupPlan::default();
    for candidate in candidates {
        let mut touched = vec![candidate.from_mailbox_id.as_str()];
        if candidate.to_mailbox_id != candidate.from_mailbox_id {
            touched.push(candidate.to_mailbox_id.as_str());
        }
        let new_mailboxes = touched
            .iter()
            .filter(|id| !plan.work.contains_key(**id))
            .count();
        let fits = touched
            .iter()
            .all(|id| plan.work.get(*id).map_or(0, MailboxWork::ids) < max_ids);
        if plan.work.len() + new_mailboxes > max_mailboxes || !fits {
            continue;
        }
        plan.work
            .entry(candidate.to_mailbox_id.clone())
            .or_default()
            .inbox
            .push(candidate.message_id_header.clone());
        plan.work
            .entry(candidate.from_mailbox_id.clone())
            .or_default()
            .sent
            .push(candidate.message_id_header.clone());
        plan.selected.push(candidate.clone());
    }
    plan
}

async fn find_uids(session: &mut dyn ImapSession, ids: &[String]) -> Result<Vec<u32>, ImapError> {
    let mut uids = Vec::new();
    for id in ids {
        uids.extend(session.search_by_message_id(id).await?);
    }
    Ok(uids)
}

/// `deleteByMessageId(...)`: Gmail's IMAP only archives a message deleted
/// from INBOX, so with a Trash folder the mail is moved there first and
/// deleted from Trash. Without one it is deleted in place.
async fn delete_by_message_id(
    session: &mut dyn ImapSession,
    mailbox: &str,
    ids: &[String],
    trash: Option<&str>,
) -> Result<(), ImapError> {
    session.select(mailbox).await?;
    let uids = find_uids(session, ids).await?;
    if uids.is_empty() {
        return Ok(());
    }
    let Some(trash) = trash.filter(|t| *t != mailbox) else {
        return session.delete_messages(&uids).await;
    };
    session.move_messages(&uids, trash).await?;
    session.select(trash).await?;
    let trashed = find_uids(session, ids).await?;
    if !trashed.is_empty() {
        session.delete_messages(&trashed).await?;
    }
    Ok(())
}

async fn clean_one_mailbox(
    session: &mut dyn ImapSession,
    work: &MailboxWork,
) -> Result<(), ImapError> {
    let trash = session.find_special_use(SpecialUse::Trash).await?;
    if !work.inbox.is_empty() {
        delete_by_message_id(session, "INBOX", &work.inbox, trash.as_deref()).await?;
    }
    if work.sent.is_empty() {
        return Ok(());
    }
    if let Some(sent) = session.find_special_use(SpecialUse::Sent).await? {
        delete_by_message_id(session, &sent, &work.sent, trash.as_deref()).await?;
    }
    Ok(())
}

/// `cleanMailbox(...)`: `true` when the mailbox is clean, `false` when it
/// has to wait for a later run.
async fn clean_mailbox(
    net: &WarmupNetwork,
    mailbox: &PoolMailbox,
    work: &MailboxWork,
    now: i64,
) -> bool {
    let Some(login) = open_login(net.warmup_key.as_deref(), &mailbox.imap_credentials) else {
        return false;
    };
    let config = ImapConfig::new(&login.host, login.port, &login.username, &login.password);
    let mut session = match net.imap.connect(&config).await {
        Ok(session) => session,
        Err(error) => {
            if error.auth_failed() {
                if let Err(db) =
                    record_login_failure(&net.master, mailbox, "imap", error.detail(), now).await
                {
                    tracing::warn!(id = mailbox.id, %db, "[reach-warmup] cleanup: skipped");
                }
            } else {
                tracing::warn!(id = mailbox.id, %error, "[reach-warmup] cleanup: skipped");
            }
            return false;
        }
    };
    let cleaned = match record_login_success(&net.master, mailbox, now).await {
        Ok(()) => clean_one_mailbox(session.as_mut(), work)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    session.logout().await;
    match cleaned {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(id = mailbox.id, error, "[reach-warmup] cleanup: skipped");
            false
        }
    }
}

/// `CleanupResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CleanupResult {
    /// Messages cleaned on both sides and marked.
    pub cleaned: usize,
    pub mailboxes_visited: usize,
    /// Rows older than the retention deleted.
    pub rows_deleted: u64,
}

/// `settleRemovedMailboxes(...)`: old messages whose mailbox is gone cannot
/// be cleaned; mark them done.
async fn settle_removed_mailboxes(master: &PgPool, now: i64) -> sqlx::Result<()> {
    sqlx::query(
        "update reach_warmup_messages set cleaned_at = $1::timestamptz
         where status in ('engaged', 'missing') and cleaned_at is null and sent_at < $2::timestamptz
           and (from_mailbox_id in (select id from reach_warmup_mailboxes where status = 'removed')
             or to_mailbox_id in (select id from reach_warmup_mailboxes where status = 'removed'))",
    )
    .bind(ts(now))
    .bind(ts(now - WARMUP_CLEANUP_AFTER_DAYS * DAY_MS))
    .execute(master)
    .await?;
    Ok(())
}

/// `loadCandidates(...)`: a mailbox in `error` cannot be logged in to
/// until someone fixes it, so its messages are left out.
async fn load_candidates(master: &PgPool, now: i64) -> sqlx::Result<Vec<CleanupCandidate>> {
    sqlx::query_as(
        "select id, from_mailbox_id, to_mailbox_id, message_id_header from reach_warmup_messages
         where status in ('engaged', 'missing') and cleaned_at is null and sent_at < $1::timestamptz
           and from_mailbox_id in (select id from reach_warmup_mailboxes where status in ('waiting', 'warming', 'maintaining', 'paused'))
           and to_mailbox_id in (select id from reach_warmup_mailboxes where status in ('waiting', 'warming', 'maintaining', 'paused'))
         order by sent_at asc limit $2",
    )
    .bind(ts(now - WARMUP_CLEANUP_AFTER_DAYS * DAY_MS))
    .bind(CLEANUP_CANDIDATE_LIMIT)
    .fetch_all(master)
    .await
}

/// `runCleanup(env, master, now)`. Mailboxes are cleaned one after the
/// other (the Worker ran three at a time within its connection limit).
pub async fn run_cleanup(net: &WarmupNetwork, now: i64) -> sqlx::Result<CleanupResult> {
    let master = &net.master;
    settle_removed_mailboxes(master, now).await?;
    let plan = plan_cleanup(
        &load_candidates(master, now).await?,
        CLEANUP_MAX_MAILBOXES,
        CLEANUP_MAX_IDS_PER_MAILBOX,
    );
    let mut cleaned = 0;
    if !plan.selected.is_empty() {
        let ids: Vec<String> = plan.work.keys().cloned().collect();
        let mailboxes = load_mailboxes(master, &ids).await?;
        let mut clean: HashSet<String> = HashSet::new();
        for (id, work) in &plan.work {
            let Some(mailbox) = mailboxes.iter().find(|m| &m.id == id) else {
                continue;
            };
            if clean_mailbox(net, mailbox, work, now).await {
                clean.insert(id.clone());
            }
        }
        let done: Vec<String> = plan
            .selected
            .iter()
            .filter(|m| clean.contains(&m.from_mailbox_id) && clean.contains(&m.to_mailbox_id))
            .map(|m| m.id.clone())
            .collect();
        if !done.is_empty() {
            sqlx::query(
                "update reach_warmup_messages set cleaned_at = $1::timestamptz where id = any($2)",
            )
            .bind(ts(now))
            .bind(&done)
            .execute(master)
            .await?;
        }
        cleaned = done.len();
    }
    let rows_deleted =
        sqlx::query("delete from reach_warmup_messages where created_at < $1::timestamptz")
            .bind(ts(now - ROW_RETENTION_DAYS * DAY_MS))
            .execute(master)
            .await?
            .rows_affected();
    Ok(CleanupResult {
        cleaned,
        mailboxes_visited: plan.work.len(),
        rows_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, from: &str, to: &str) -> CleanupCandidate {
        CleanupCandidate {
            id: id.to_owned(),
            from_mailbox_id: from.to_owned(),
            to_mailbox_id: to.to_owned(),
            message_id_header: format!("{id}@x"),
        }
    }

    #[test]
    fn whole_messages_within_the_limits() {
        let candidates = [
            candidate("m1", "a", "b"),
            candidate("m2", "b", "c"),
            candidate("m3", "c", "d"),
            candidate("m4", "a", "c"),
        ];
        let plan = plan_cleanup(&candidates, 3, 60);
        let ids: Vec<&str> = plan.selected.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m2", "m4"]);
        assert_eq!(plan.work["a"].sent, ["m1@x", "m4@x"]);
        assert_eq!(plan.work["c"].inbox, ["m2@x", "m4@x"]);

        let tight = plan_cleanup(&candidates, 30, 1);
        let ids: Vec<&str> = tight.selected.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m1", "m3"]);
    }
}
