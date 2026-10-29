//! Mailbox access (`@weldsuite/mail-domain/access`, MAIL-003): a mailbox
//! follows sharing and assignment. A shared mailbox is open to every member;
//! an assigned one to its assignees; an unassigned private one to workspace
//! admins and owners.

use serde_json::Value;
use weldsuite_db::PgPool;

/// The access fields of a `mail_accounts` row.
#[derive(Debug, Clone, Default)]
pub struct AccountAccess {
    pub is_shared: bool,
    pub assigned_user_ids: Vec<String>,
}

/// `isAdminOrOwner(db, userId)`: the member's role is `OWNER` or `ADMIN`.
pub async fn is_admin_or_owner(db: &PgPool, user_id: &str) -> Result<bool, sqlx::Error> {
    let role: Option<Option<String>> = sqlx::query_scalar(
        "select role from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let role = role.flatten().map(|role| role.to_uppercase());
    Ok(matches!(role.as_deref(), Some("OWNER" | "ADMIN")))
}

/// `hasAccessToAccount(account, userId, isAdmin)`.
pub fn has_access_to_account(account: &AccountAccess, user_id: &str, is_admin: bool) -> bool {
    if account.is_shared {
        return true;
    }
    if account.assigned_user_ids.is_empty() {
        return is_admin;
    }
    account.assigned_user_ids.iter().any(|id| id == user_id)
}

/// `loadAccessFields(db, accountId)`: a live mailbox's access fields.
pub async fn load_access_fields(
    db: &PgPool,
    account_id: &str,
) -> Result<Option<AccountAccess>, sqlx::Error> {
    let row: Option<(Option<bool>, Option<Value>)> = sqlx::query_as(
        "select is_shared, assigned_user_ids from mail_accounts
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(is_shared, assigned)| AccountAccess {
        is_shared: is_shared.unwrap_or(false),
        assigned_user_ids: assigned
            .and_then(|value| match value {
                Value::Array(items) => Some(
                    items
                        .into_iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default(),
    }))
}

/// `checkAccountAccess(db, accountId, userId)`: whether `user_id` may open
/// the mailbox. `false` for a missing or deleted one, so a caller cannot
/// tell the two apart.
pub async fn check_account_access(
    db: &PgPool,
    account_id: &str,
    user_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(account) = load_access_fields(db, account_id).await? else {
        return Ok(false);
    };
    let admin = is_admin_or_owner(db, user_id).await?;
    Ok(has_access_to_account(&account, user_id, admin))
}

/// `accessibleAccountIds(db, userId)`: the live mailboxes the member may
/// open (`userAccessCondition`), in the database's row order.
pub async fn accessible_account_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let admin = is_admin_or_owner(db, user_id).await?;
    sqlx::query_scalar(
        "select id from mail_accounts
         where deleted_at is null and (
           is_shared = true
           or assigned_user_ids @> jsonb_build_array($1::text)
           or ($2 and coalesce(assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)))",
    )
    .bind(user_id)
    .bind(admin)
    .fetch_all(db)
    .await
}

/// `canManageAccount(account, userId, isAdmin)`.
pub fn can_manage_account(account: &AccountAccess, user_id: &str, is_admin: bool) -> bool {
    is_admin || has_access_to_account(account, user_id, false)
}

/// `checkAccountManageAccess(db, accountId, userId)`: whether `user_id` may
/// change the mailbox's settings (admins may, without opening it).
pub async fn check_account_manage_access(
    db: &PgPool,
    account_id: &str,
    user_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(account) = load_access_fields(db, account_id).await? else {
        return Ok(false);
    };
    let admin = is_admin_or_owner(db, user_id).await?;
    Ok(can_manage_account(&account, user_id, admin))
}
