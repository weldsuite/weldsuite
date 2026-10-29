//! The WeldMail "email read" push (`lib/read-push.ts` and
//! `@weldsuite/mail-domain/read-push`): after a route took messages out of
//! the unread inbox, every member's WeldMail devices that can open the
//! mailbox get a silent push with the ids and their new inbox badge. Runs in
//! the background (`waitUntil`); a failure is only logged.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_mail_domain::access::{AccountAccess, accessible_account_ids, has_access_to_account};
use weldsuite_mail_domain::messages::message_stats;
use weldsuite_ports::OutboundHttp;

use crate::util::{now, strings};
use crate::{Caller, MailState};

/// `IDS_PER_PUSH`.
const IDS_PER_PUSH: usize = 40;

/// `clearsUnreadBanner(update)`.
pub(crate) fn clears_unread_banner(
    is_read: Option<bool>,
    is_trash: Option<bool>,
    is_spam: Option<bool>,
    labels: Option<&[String]>,
) -> bool {
    is_read == Some(true)
        || is_trash == Some(true)
        || is_spam == Some(true)
        || labels.is_some_and(|labels| !labels.iter().any(|l| l == "INBOX"))
}

/// `queueMailReadPush(c, accountId, emailIds)`.
pub(crate) fn queue_mail_read_push(
    state: &MailState,
    caller: &Caller,
    account_id: &str,
    email_ids: Vec<String>,
) {
    if email_ids.is_empty() {
        return;
    }
    let db = caller.db.clone();
    let http = caller.bindings.http(state);
    let account_id = account_id.to_owned();
    state.events.tracker().spawn(async move {
        send_workspace_mail_read_push(&db, http.as_ref(), &account_id, &email_ids).await;
    });
}

/// `buildMailReadPushMessages(tokens, content)`.
fn build_messages(tokens: &[String], email_ids: &[String], inbox_unread: Option<i64>) -> Vec<Value> {
    let mut ids: Vec<&String> = Vec::new();
    for id in email_ids.iter().filter(|id| !id.is_empty()) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for to in tokens {
        for chunk in ids.chunks(IDS_PER_PUSH) {
            let joined = chunk.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(",");
            let mut data = json!({
                "type": "email_read",
                "emailIds": joined,
                "tenantKind": "workspace",
            });
            let mut message = json!({
                "to": to,
                "_contentAvailable": true,
                "priority": "normal",
            });
            if let Some(unread) = inbox_unread {
                message["badge"] = json!(unread);
                data["inboxUnread"] = Value::String(unread.to_string());
            }
            message["data"] = data;
            out.push(message);
        }
    }
    out
}

/// `sendWorkspaceMailReadPush(db, { accountId, emailIds }, { store })`.
async fn send_workspace_mail_read_push(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    account_id: &str,
    email_ids: &[String],
) {
    let run = async {
        let account: Option<(Option<bool>, Option<Value>)> = sqlx::query_as(
            "select is_shared, assigned_user_ids from mail_accounts where id = $1 limit 1",
        )
        .bind(account_id)
        .fetch_optional(db)
        .await?;
        let Some((is_shared, assigned)) = account else {
            return Ok::<(), sqlx::Error>(());
        };
        let account = AccountAccess {
            is_shared: is_shared.unwrap_or(false),
            assigned_user_ids: assigned.as_ref().map(strings).unwrap_or_default(),
        };
        let rows: Vec<(String, String)> = sqlx::query_as(
            "select user_id, token from device_tokens where app_code = 'weldmail' and is_active is null",
        )
        .fetch_all(db)
        .await?;
        let mut by_user: Vec<(String, Vec<String>)> = Vec::new();
        for (user, token) in rows {
            match by_user.iter_mut().find(|(u, _)| *u == user) {
                Some((_, tokens)) => tokens.push(token),
                None => by_user.push((user, vec![token])),
            }
        }
        if by_user.is_empty() {
            return Ok(());
        }
        let users: Vec<String> = by_user.iter().map(|(u, _)| u.clone()).collect();
        let members: Vec<(String, Option<String>)> = sqlx::query_as(
            "select user_id, role from workspace_members
             where user_id = any($1::text[]) and deleted_at is null and status = 'ACTIVE'",
        )
        .bind(&users)
        .fetch_all(db)
        .await?;
        let mut messages: Vec<Value> = Vec::new();
        for (user, tokens) in &by_user {
            // `new Map(rows)`: a later row wins.
            let Some(role) = members.iter().rev().find(|(u, _)| u == user).map(|(_, r)| r) else {
                continue;
            };
            let is_admin = role
                .as_deref()
                .is_some_and(|r| matches!(r.to_uppercase().as_str(), "OWNER" | "ADMIN"));
            if !has_access_to_account(&account, user, is_admin) {
                continue;
            }
            let unread = match inbox_unread(db, user).await {
                Ok(unread) => Some(unread),
                Err(error) => {
                    tracing::error!(%error, "[MailReadPush] Failed to count unread inbox messages");
                    None
                }
            };
            messages.extend(build_messages(tokens, email_ids, unread));
        }
        if messages.is_empty() {
            return Ok(());
        }
        let result = weldsuite_notifications::send_expo_push(http, messages).await;
        let mut invalid: Vec<String> = Vec::new();
        for token in result.invalid_tokens.into_iter().filter(|t| !t.is_empty()) {
            if !invalid.contains(&token) {
                invalid.push(token);
            }
        }
        for token in invalid {
            if let Err(error) = sqlx::query(
                "update device_tokens set is_active = $2::timestamp where token = $1",
            )
            .bind(&token)
            .bind(now())
            .execute(db)
            .await
            {
                tracing::error!(%error, "[MailReadPush] Failed to deactivate token");
            }
        }
        Ok(())
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[MailReadPush] Workspace push failed for account {account_id}");
    }
}

/// The member's unread inbox count across the mailboxes they may open.
async fn inbox_unread(db: &PgPool, user_id: &str) -> Result<i64, sqlx::Error> {
    let accounts = accessible_account_ids(db, user_id).await?;
    let stats = message_stats(db, &accounts).await?;
    Ok(stats["inboxUnread"].as_i64().unwrap_or(0))
}
