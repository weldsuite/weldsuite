//! Who a message is for (MAIL-002): the master `mail_account_registry`,
//! exact addresses first, then the `*@domain` catch-all sentinel, each
//! registry row resolved to its mailbox and the members to notify
//! (`findRecipientAccounts`, `collectRecipientEmails`, `selectNotifyMembers`).

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::catch_all::{expand_catch_all_candidates, is_catch_all_registry_email};
use crate::context::InboundContext;
use crate::mime::js_trim;
use crate::parsed::ParsedEmail;

/// `collectRecipientEmails(email)`: the envelope recipients, then `To`
/// and `Cc`, trimmed, lower-cased, once each.
pub fn collect_recipient_emails(email: &ParsedEmail) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let all = email
        .envelope_to
        .iter()
        .map(String::as_str)
        .chain(email.to.iter().map(|t| t.email.as_str()))
        .chain(email.cc.iter().map(|t| t.email.as_str()));
    for address in all {
        let normalized = js_trim(address).to_lowercase();
        if !normalized.is_empty() && !out.contains(&normalized) {
            out.push(normalized);
        }
    }
    out
}

/// One active registry row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryRow {
    pub email: String,
    pub account_id: String,
    pub tenant_kind: String,
    pub workspace_id: Option<String>,
    pub personal_account_id: Option<String>,
}

/// A registry row as read.
type RawRegistryRow = (String, String, String, Option<String>, Option<String>);

/// `selectRegistryRows(masterDb, emails)`: active rows for the addresses.
pub async fn registry_rows(
    master: &PgPool,
    emails: &[String],
) -> Result<Vec<RegistryRow>, sqlx::Error> {
    if emails.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<RawRegistryRow> = sqlx::query_as(
        "select email, account_id, tenant_kind::text, workspace_id, personal_account_id
         from mail_account_registry
         where email = any($1) and is_active = true",
    )
    .bind(emails)
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(email, account_id, tenant_kind, workspace_id, personal_account_id)| RegistryRow {
                email,
                account_id,
                tenant_kind,
                workspace_id,
                personal_account_id,
            },
        )
        .collect())
}

/// How a `RCPT TO` address matched the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientMatch {
    /// An active mailbox (or helpdesk / accounting inbox) has the address.
    Exact,
    /// No mailbox has it, but its custom domain has catch-all on.
    CatchAll,
}

impl RecipientMatch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::CatchAll => "catch-all",
        }
    }
}

/// The `RCPT TO` check (MAIL-010): the registry lookup of MAIL-002 for one
/// address, live (an address created a second ago already receives). Only
/// workspace rows count: consumer WeldMail is not part of the Kubernetes
/// editions.
pub async fn lookup_recipient(
    master: &PgPool,
    address: &str,
) -> Result<Option<RecipientMatch>, sqlx::Error> {
    let normalized = js_trim(address).to_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }
    let exact = registry_rows(master, std::slice::from_ref(&normalized)).await?;
    if exact.iter().any(|r| r.workspace_id.is_some()) {
        return Ok(Some(RecipientMatch::Exact));
    }
    let candidates = expand_catch_all_candidates(std::slice::from_ref(&normalized), &[]);
    let catch_all = registry_rows(master, &candidates).await?;
    Ok(catch_all
        .iter()
        .any(|r| r.workspace_id.is_some())
        .then_some(RecipientMatch::CatchAll))
}

/// A member to notify.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub user_id: String,
    pub email: Option<String>,
}

/// `RecipientAccount` (workspace mailboxes; consumer WeldMail is not part
/// of the Kubernetes editions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientAccount {
    pub account_id: String,
    pub account_email: String,
    pub is_shared: bool,
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub members: Vec<Member>,
}

/// `selectNotifyMembers(account, members)`: everyone for a shared mailbox,
/// the assignees of a private one, admins and owners when it has none.
pub fn select_notify_members<'a>(
    is_shared: bool,
    assigned: &[String],
    members: &'a [(String, Option<String>, Option<String>)],
) -> Vec<&'a (String, Option<String>, Option<String>)> {
    if is_shared {
        return members.iter().collect();
    }
    if assigned.is_empty() {
        return members
            .iter()
            .filter(|(_, _, role)| {
                matches!(
                    role.as_deref().map(str::to_uppercase).as_deref(),
                    Some("OWNER" | "ADMIN")
                )
            })
            .collect();
    }
    members
        .iter()
        .filter(|(user, _, _)| assigned.contains(user))
        .collect()
}

/// `resolveWorkspaceRecipient(env, masterDb, reg)`.
async fn resolve_workspace(
    ctx: &InboundContext,
    reg: &RegistryRow,
) -> Result<Option<RecipientAccount>, Box<dyn std::error::Error + Send + Sync>> {
    let Some(workspace_id) = &reg.workspace_id else {
        tracing::warn!(email = %reg.email, "[Recipients] Workspace registry row missing workspaceId");
        return Ok(None);
    };
    let workspace: Option<(String, Option<String>)> =
        sqlx::query_as("select id, clerk_org_id from workspaces where id = $1 limit 1")
            .bind(workspace_id)
            .fetch_optional(&ctx.master)
            .await?;
    let Some((_, clerk_org_id)) = workspace else {
        tracing::warn!(workspace_id, "[Recipients] Workspace not found");
        return Ok(None);
    };
    let db = ctx.tenants.tenant_db(workspace_id).await?;
    let members: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select user_id, email, role from workspace_members
         where deleted_at is null and status = 'ACTIVE'",
    )
    .fetch_all(&db)
    .await?;
    let access: Option<(String, Option<bool>, Option<Value>)> = sqlx::query_as(
        "select email, is_shared, assigned_user_ids from mail_accounts
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(&reg.account_id)
    .fetch_optional(&db)
    .await?;
    let Some((account_email, is_shared, assigned)) = access else {
        tracing::warn!(account = %reg.account_id, "[Recipients] Mail account not found or deleted");
        return Ok(None);
    };
    let assigned: Vec<String> = assigned
        .as_ref()
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let eligible = select_notify_members(is_shared == Some(true), &assigned, &members);
    // `new Map(eligible.map(m => [m.userId, …]))`: first position, last value.
    let mut unique: Vec<Member> = Vec::new();
    for (user_id, email, _) in eligible {
        if let Some(slot) = unique.iter_mut().find(|m| m.user_id == *user_id) {
            slot.email.clone_from(email);
        } else {
            unique.push(Member {
                user_id: user_id.clone(),
                email: email.clone(),
            });
        }
    }
    let account_email = if is_catch_all_registry_email(&reg.email) {
        account_email
    } else {
        reg.email.clone()
    };
    let Some(clerk_org_id) = clerk_org_id else {
        tracing::warn!(
            workspace_id,
            "[Recipients] Workspace has no clerkOrgId — realtime events will be skipped"
        );
        return Ok(None);
    };
    if members.is_empty() {
        return Ok(None);
    }
    Ok(Some(RecipientAccount {
        account_id: reg.account_id.clone(),
        account_email,
        is_shared: is_shared == Some(true),
        workspace_id: workspace_id.clone(),
        clerk_org_id,
        members: unique,
    }))
}

/// `findRecipientAccounts(env, recipientEmails)`: exact registry matches
/// first, then catch-all sentinels; one account once.
pub async fn find_recipient_accounts(
    ctx: &InboundContext,
    recipient_emails: &[String],
) -> Result<Vec<RecipientAccount>, sqlx::Error> {
    let mut normalized: Vec<String> = Vec::new();
    for email in recipient_emails {
        let e = js_trim(email).to_lowercase();
        if !e.is_empty() && !normalized.contains(&e) {
            normalized.push(e);
        }
    }
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let exact = registry_rows(&ctx.master, &normalized).await?;
    let matched: Vec<String> = exact.iter().map(|r| r.email.to_lowercase()).collect();
    let candidates = expand_catch_all_candidates(&normalized, &matched);
    let catch_all = if candidates.is_empty() {
        Vec::new()
    } else {
        registry_rows(&ctx.master, &candidates).await?
    };
    let mut results: Vec<RecipientAccount> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for reg in exact.iter().chain(catch_all.iter()) {
        if seen.contains(&reg.account_id) {
            continue;
        }
        if reg.tenant_kind == "personal" && reg.personal_account_id.is_some() {
            tracing::warn!(
                email = %reg.email,
                "[Recipients] Consumer WeldMail is not part of this edition; skipping a personal mailbox"
            );
            continue;
        }
        match resolve_workspace(ctx, reg).await {
            Ok(Some(account)) => {
                seen.push(reg.account_id.clone());
                results.push(account);
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(account = %reg.account_id, %error, "[Recipients] Error resolving account");
            }
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(user: &str, role: &str) -> (String, Option<String>, Option<String>) {
        (user.to_owned(), None, Some(role.to_owned()))
    }

    #[test]
    fn notify_members() {
        let members = vec![
            member("u1", "MEMBER"),
            member("u2", "admin"),
            member("u3", "OWNER"),
        ];
        assert_eq!(select_notify_members(true, &[], &members).len(), 3);
        let admins: Vec<&str> = select_notify_members(false, &[], &members)
            .iter()
            .map(|m| m.0.as_str())
            .collect();
        assert_eq!(admins, ["u2", "u3"]);
        let assigned: Vec<&str> = select_notify_members(false, &["u1".to_owned()], &members)
            .iter()
            .map(|m| m.0.as_str())
            .collect();
        assert_eq!(assigned, ["u1"]);
    }
}
