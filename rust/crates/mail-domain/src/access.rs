//! Mailbox access (`@weldsuite/mail-domain/access`, MAIL-003): a mailbox
//! follows sharing and assignment. A shared mailbox is open to every member;
//! an assigned one to its assignees; an unassigned private one to workspace
//! admins and owners.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{mail_accounts, workspace_members};

/// The access fields of a `mail_accounts` row.
#[derive(Debug, Clone, Default)]
pub struct AccountAccess {
    pub is_shared: bool,
    pub assigned_user_ids: Vec<String>,
}

/// `isAdminOrOwner(db, userId)`: the member's role is `OWNER` or `ADMIN`.
pub async fn is_admin_or_owner(db: &PgPool, user_id: &str) -> Result<bool, DbErr> {
    let role: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Role)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let role = role.map(|role| role.to_uppercase());
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
) -> Result<Option<AccountAccess>, DbErr> {
    let row: Option<(Option<bool>, Option<Value>)> = mail_accounts::Entity::find()
        .select_only()
        .columns([
            mail_accounts::Column::IsShared,
            mail_accounts::Column::AssignedUserIds,
        ])
        .filter(mail_accounts::Column::Id.eq(account_id))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
) -> Result<bool, DbErr> {
    let Some(account) = load_access_fields(db, account_id).await? else {
        return Ok(false);
    };
    let admin = is_admin_or_owner(db, user_id).await?;
    Ok(has_access_to_account(&account, user_id, admin))
}

/// `accessibleAccountIds(db, userId)`: the live mailboxes the member may
/// open (`userAccessCondition`), in the database's row order.
pub async fn accessible_account_ids(db: &PgPool, user_id: &str) -> Result<Vec<String>, DbErr> {
    let admin = is_admin_or_owner(db, user_id).await?;
    mail_accounts::Entity::find()
        .select_only()
        .column(mail_accounts::Column::Id)
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .filter(user_access_condition(user_id, admin))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `userAccessCondition(userId, isAdmin)`: shared, assigned to the member
/// (`assigned_user_ids @> [userId]`), or for an admin or owner assigned to
/// nobody (`coalesce(assigned_user_ids, '[]')` is `[]` or JSON `null`).
fn user_access_condition(user_id: &str, admin: bool) -> Condition {
    let assigned = || Expr::col((mail_accounts::Entity, mail_accounts::Column::AssignedUserIds));
    let mut open = Condition::any()
        .add(mail_accounts::Column::IsShared.eq(true))
        .add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            assigned(),
            Expr::val(json!([user_id])),
        ));
    if admin {
        open = open.add(sea_orm::ExprTrait::is_in(
            Expr::from(Func::coalesce([assigned(), Expr::val(json!([]))])),
            [json!([]), Value::Null],
        ));
    }
    open
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
) -> Result<bool, DbErr> {
    let Some(account) = load_access_fields(db, account_id).await? else {
        return Ok(false);
    };
    let admin = is_admin_or_owner(db, user_id).await?;
    Ok(can_manage_account(&account, user_id, admin))
}
