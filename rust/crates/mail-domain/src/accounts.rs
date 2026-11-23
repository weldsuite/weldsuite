//! Mail accounts as seen from outside the platform
//! (`@weldsuite/mail-domain/accounts`): the public API's one shape for a
//! mailbox, and the sender-domain rule the public API sends under.
//!
//! Read-only on purpose: creating, connecting and configuring a mailbox stays
//! in WeldMail. The column projection is explicit and must stay that way:
//! `mail_accounts` holds `accessToken`, `refreshToken`, `apiKey` and
//! `passwordHash`, and none of them may leave the platform.

use std::collections::HashSet;

use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{enums, mail_accounts, mail_domains};

use crate::access::{MailPrincipal, can_open_account, is_admin_or_owner};
use crate::text::js_trim;

/// The columns any public surface may return (`PUBLIC_COLUMNS`), as Drizzle
/// reads them. Never the credential columns.
#[derive(Debug, Clone, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRow {
    id: String,
    name: String,
    email: String,
    display_name: Option<String>,
    provider: enums::MailProvider,
    status: enums::MailAccountStatus,
    is_default: Option<bool>,
    is_shared: Option<bool>,
    sync_enabled: bool,
    sync_status: Option<enums::MailSyncStatus>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    last_sync_at: Option<time::PrimitiveDateTime>,
    daily_send_limit: Option<i32>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: time::PrimitiveDateTime,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    updated_at: time::PrimitiveDateTime,
}

const PUBLIC_COLUMNS: [mail_accounts::Column; 14] = [
    mail_accounts::Column::Id,
    mail_accounts::Column::Name,
    mail_accounts::Column::Email,
    mail_accounts::Column::DisplayName,
    mail_accounts::Column::Provider,
    mail_accounts::Column::Status,
    mail_accounts::Column::IsDefault,
    mail_accounts::Column::IsShared,
    mail_accounts::Column::SyncEnabled,
    mail_accounts::Column::SyncStatus,
    mail_accounts::Column::LastSyncAt,
    mail_accounts::Column::DailySendLimit,
    mail_accounts::Column::CreatedAt,
    mail_accounts::Column::UpdatedAt,
];

/// `emailDomain(email)`: the domain part, lower-cased; empty for a malformed
/// address.
pub fn email_domain(email: &str) -> String {
    match email.rfind('@') {
        Some(at) => js_trim(&email[at + 1..]).to_lowercase(),
        None => String::new(),
    }
}

/// `verifiedDomains(db, domains)`: the verified WeldMail domains among
/// `domains`, lower-cased. Verified means the domain's DNS (SPF, DKIM)
/// passed in WeldMail, so mail sent from it authenticates.
pub async fn verified_domains(db: &PgPool, domains: &[String]) -> Result<HashSet<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    let mut wanted: Vec<&str> = Vec::new();
    for domain in domains.iter().map(String::as_str).filter(|d| !d.is_empty()) {
        if !wanted.contains(&domain) {
            wanted.push(domain);
        }
    }
    if wanted.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = mail_domains::Entity::find()
        .select_only()
        .column(mail_domains::Column::DomainName)
        .filter(Expr::from(Func::lower(Expr::col(mail_domains::Column::DomainName))).is_in(wanted))
        .filter(mail_domains::Column::DnsStatus.eq(enums::MailDomainDnsStatus::Verified))
        .filter(mail_domains::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(|name| name.to_lowercase()).collect())
}

/// `isSenderDomainVerified(db, email)`: whether `email` is on a verified
/// WeldMail domain of this workspace.
pub async fn is_sender_domain_verified(db: &PgPool, email: &str) -> Result<bool, DbErr> {
    let domain = email_domain(email);
    if domain.is_empty() {
        return Ok(false);
    }
    Ok(verified_domains(db, std::slice::from_ref(&domain))
        .await?
        .contains(&domain))
}

/// `principalAccessCondition(db, caller)` on `mail_accounts`.
async fn principal_condition(db: &PgPool, principal: &MailPrincipal) -> Result<Condition, DbErr> {
    let user = match principal {
        MailPrincipal::Workspace => {
            return Ok(Condition::all().add(mail_accounts::Column::IsShared.eq(true)));
        }
        MailPrincipal::User(user) => user,
    };
    let admin = is_admin_or_owner(db, user).await?;
    let mut any = Condition::any()
        .add(mail_accounts::Column::IsShared.eq(true))
        .add(PgExpr::contains(
            Expr::col(mail_accounts::Column::AssignedUserIds),
            json!([user]),
        ));
    if admin {
        any = any.add(Expr::cust(
            "coalesce(\"mail_accounts\".\"assigned_user_ids\", '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb)",
        ));
    }
    Ok(any)
}

/// `%term%` with LIKE's wildcards escaped.
fn contains_pattern(term: &str) -> String {
    let mut pattern = String::with_capacity(term.len() + 2);
    pattern.push('%');
    for c in term.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

/// `withSendability(db, rows)`: each row with `canSendViaApi`.
async fn with_sendability(db: &PgPool, rows: Vec<PublicRow>) -> Result<Vec<Value>, DbErr> {
    let domains: Vec<String> = rows.iter().map(|row| email_domain(&row.email)).collect();
    let verified = verified_domains(db, &domains).await?;
    Ok(rows
        .into_iter()
        .zip(domains)
        .map(|(row, domain)| {
            let mut value = serde_json::to_value(row).unwrap_or(Value::Null);
            value["canSendViaApi"] = json!(verified.contains(&domain));
            value
        })
        .collect())
}

/// `ListPublicAccountsFilters`.
#[derive(Debug, Clone, Default)]
pub struct PublicAccountFilters {
    pub search: Option<String>,
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

/// One page of [`list_public_mail_accounts`].
#[derive(Debug, Clone, Default)]
pub struct PublicAccountPage {
    pub data: Vec<Value>,
    pub has_more: bool,
    pub cursor: Option<String>,
    pub total_count: i64,
}

/// `listPublicMailAccounts(db, caller, filters)`: the principal's mailboxes,
/// newest first, cursor-paginated by id. The workspace sees shared mailboxes
/// only.
pub async fn list_public_mail_accounts(
    db: &PgPool,
    principal: &MailPrincipal,
    filters: &PublicAccountFilters,
) -> Result<PublicAccountPage, DbErr> {
    use mail_accounts::Column;
    let limit = filters.limit.unwrap_or(50).clamp(1, 200);
    let mut conditions = Condition::all()
        .add(Column::DeletedAt.is_null())
        .add(principal_condition(db, principal).await?);
    if let Some(search) = filters.search.as_deref().filter(|s| !s.is_empty()) {
        let pattern = contains_pattern(search);
        conditions = conditions.add(
            Condition::any()
                .add(PgExpr::ilike(Expr::col(Column::Name), pattern.as_str()))
                .add(PgExpr::ilike(Expr::col(Column::Email), pattern.as_str()))
                .add(PgExpr::ilike(
                    Expr::col(Column::DisplayName),
                    pattern.as_str(),
                )),
        );
    }
    if let Some(status) = filters.status.as_deref().filter(|s| !s.is_empty()) {
        // An unknown status is Postgres's enum error in TypeScript: a 500.
        let status =
            <enums::MailAccountStatus as sea_orm::ActiveEnum>::try_from_value(&status.to_owned())
                .map_err(|_| DbErr::Custom(format!("invalid mail account status {status:?}")))?;
        conditions = conditions.add(Column::Status.eq(status));
    }
    let conn = orm(db);
    let mut page_conditions = conditions.clone();
    if let Some(cursor) = filters.cursor.as_deref().filter(|c| !c.is_empty()) {
        let found: Option<(time::PrimitiveDateTime, String)> = mail_accounts::Entity::find()
            .select_only()
            .column(Column::CreatedAt)
            .column(Column::Id)
            .filter(Column::Id.eq(cursor))
            .into_tuple()
            .one(&conn)
            .await?;
        if let Some((created_at, id)) = found {
            page_conditions = page_conditions.add(
                Condition::any().add(Column::CreatedAt.lt(created_at)).add(
                    Condition::all()
                        .add(Column::CreatedAt.eq(created_at))
                        .add(Column::Id.lt(id)),
                ),
            );
        }
    }
    let mut rows: Vec<PublicRow> = mail_accounts::Entity::find()
        .select_only()
        .columns(PUBLIC_COLUMNS)
        .filter(page_conditions)
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(1))
        .into_model()
        .all(&conn)
        .await?;
    let total = mail_accounts::Entity::find()
        .filter(conditions)
        .count(&conn)
        .await?;
    let has_more = rows.len() > usize::try_from(limit).unwrap_or(usize::MAX);
    rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    let cursor = if has_more {
        rows.last().map(|row| row.id.clone())
    } else {
        None
    };
    Ok(PublicAccountPage {
        data: with_sendability(db, rows).await?,
        has_more,
        cursor,
        total_count: i64::try_from(total).unwrap_or(i64::MAX),
    })
}

/// `getPublicMailAccount(db, caller, id)`: one mailbox, or `None` when it
/// does not exist or the principal may not open it.
pub async fn get_public_mail_account(
    db: &PgPool,
    principal: &MailPrincipal,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    if !can_open_account(db, id, principal).await? {
        return Ok(None);
    }
    let row: Option<PublicRow> = mail_accounts::Entity::find()
        .select_only()
        .columns(PUBLIC_COLUMNS)
        .filter(mail_accounts::Column::Id.eq(id))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_model()
        .one(&orm(db))
        .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(with_sendability(db, vec![row]).await?.pop())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_come_from_the_last_at() {
        assert_eq!(email_domain("Team@Mailtest.DEV "), "mailtest.dev");
        assert_eq!(email_domain("a@b@c.io"), "c.io");
        assert_eq!(email_domain("nobody"), "");
    }

    #[test]
    fn search_patterns_escape_wildcards() {
        assert_eq!(contains_pattern("50%_a\\"), "%50\\%\\_a\\\\%");
    }
}
