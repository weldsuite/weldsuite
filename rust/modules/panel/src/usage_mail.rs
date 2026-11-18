//! The usage notice email (`services/usage-mail.ts`): `panel.usage` to the
//! workspace's owners, from WeldSuite's address under WeldPanel's name. The
//! owners are read from the workspace's tenant database
//! (`workspace_members`); a workspace whose owners have no address falls
//! back to its admins. Mail never fails a settlement: a failure is logged.
//!
//! The notice itself is claimed by the settlement ([`crate::usage_settlement`],
//! `usage-notices.ts`), once per threshold per month; this sends it.

use std::sync::Arc;

use sqlx::PgConnection;
use weldsuite_db::PgPool;
use weldsuite_emails::panel::{Meter, PanelUsage, UsageKind, usage};
use weldsuite_emails::{
    EmailBrand, EmailLocale, SystemEmail, send_system_email, workspace_app_url,
};
use weldsuite_ports::{BoxFuture, DynSystemMail};

use crate::public_share::WorkspaceTenants;
use crate::usage_settlement::{UsageNotice, next_month_start};

/// The platform's origin without `PLATFORM_URL`.
const DEFAULT_PLATFORM_URL: &str = "https://app.weldsuite.org";

/// Someone a notice goes to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub email: String,
    pub name: Option<String>,
}

/// `membersWithRole(env, workspaceId, roles)`: the members with one of
/// `roles` and an address.
async fn members_with_role(
    tenant: &mut PgConnection,
    roles: &[&str],
) -> Result<Vec<Recipient>, sqlx::Error> {
    let roles: Vec<String> = roles.iter().map(|role| (*role).to_owned()).collect();
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select email, name from workspace_members where role = any($1) and deleted_at is null",
    )
    .bind(roles)
    .fetch_all(&mut *tenant)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(email, name)| {
            email
                .filter(|email| !email.is_empty())
                .map(|email| Recipient { email, name })
        })
        .collect())
}

/// `noticeRecipients`: the owners with an address, else the admins with one,
/// read on a connection to the workspace's tenant database.
pub async fn notice_recipients(tenant: &mut PgConnection) -> Result<Vec<Recipient>, sqlx::Error> {
    let owners = members_with_role(tenant, &["OWNER"]).await?;
    if !owners.is_empty() {
        return Ok(owners);
    }
    members_with_role(tenant, &["ADMIN"]).await
}

/// `usageUrl(env, clerkOrgId)`: where the usage is shown in the platform.
pub fn usage_url(platform_url: Option<&str>, clerk_org_id: Option<&str>) -> String {
    let base = platform_url
        .filter(|url| !url.is_empty())
        .unwrap_or(DEFAULT_PLATFORM_URL);
    let base = base.strip_suffix('/').unwrap_or(base);
    workspace_app_url(base, clerk_org_id, "/weldpanel/settings?tab=usage")
}

/// `sendUsageNotice`, once the recipients are known: mails each of `to`,
/// going on past one that fails. Returns how many were mailed.
pub async fn send_usage_notice(
    transport: &dyn DynSystemMail,
    to: &[Recipient],
    notice: &UsageNotice,
    platform_url: Option<&str>,
) -> usize {
    if to.is_empty() {
        return 0;
    }
    let Some(resets_at) = next_month_start(&notice.month) else {
        tracing::error!(workspace = %notice.workspace_id, month = %notice.month, "[panel-api] usage mail for a malformed month");
        return 0;
    };
    let brand = EmailBrand::weldsuite("WeldPanel");
    let props = PanelUsage {
        workspace_name: notice.workspace_name.clone(),
        kind: UsageKind::parse(notice.kind).unwrap_or_default(),
        events: Meter {
            used: notice.events.0,
            allowance: notice.events.1,
        },
        recordings: Meter {
            used: notice.recordings.0,
            allowance: notice.recordings.1,
        },
        resets_at,
        url: usage_url(platform_url, notice.clerk_org_id.as_deref()),
    };
    // `resolveEmailLocale(null)`: panel-api knows no owner's language.
    let rendered = match usage(EmailLocale::En, &brand, &props) {
        Ok(rendered) => rendered,
        Err(error) => {
            tracing::error!(%error, workspace = %notice.workspace_id, "[panel-api] usage mail failed");
            return 0;
        }
    };
    let mut sent = 0;
    for recipient in to {
        let email = SystemEmail::to(rendered.clone(), brand.clone(), &recipient.email);
        match send_system_email(transport, email).await {
            Ok(_) => sent += 1,
            Err(error) => {
                tracing::error!(%error, workspace = %notice.workspace_id, "[panel-api] usage mail failed");
            }
        }
    }
    sent
}

/// Reads the owners from the workspace's tenant database and mails them.
/// A failed read is logged and mails no one.
pub async fn mail_notice(
    transport: &dyn DynSystemMail,
    tenant: &PgPool,
    notice: &UsageNotice,
    platform_url: Option<&str>,
) -> usize {
    let recipients = match tenant.acquire().await {
        Ok(mut connection) => notice_recipients(&mut connection).await,
        Err(error) => Err(error),
    };
    match recipients {
        Ok(to) => send_usage_notice(transport, &to, notice, platform_url).await,
        Err(error) => {
            tracing::error!(%error, workspace = %notice.workspace_id, "[panel-api] usage notice failed");
            0
        }
    }
}

/// Mails what a settlement claimed ([`crate::usage_sweep`]); returns how
/// many were mailed.
pub trait NoticeSender: Send + Sync {
    fn send<'a>(&'a self, notice: &'a UsageNotice) -> BoxFuture<'a, usize>;
}

/// [`NoticeSender`] through the install's mail, the owners read from the
/// workspace's tenant database, opened only for a notice.
pub struct MailNotices {
    pub transport: Arc<dyn DynSystemMail>,
    pub tenants: Arc<dyn WorkspaceTenants>,
    /// `PLATFORM_URL`.
    pub platform_url: Option<String>,
}

impl NoticeSender for MailNotices {
    fn send<'a>(&'a self, notice: &'a UsageNotice) -> BoxFuture<'a, usize> {
        Box::pin(async move {
            let opened = match self.tenants.open(&notice.workspace_id).await {
                Ok(Some(opened)) => opened,
                Ok(None) => return 0,
                Err(error) => {
                    tracing::error!(%error, workspace = %notice.workspace_id, "[panel-api] usage notice failed");
                    return 0;
                }
            };
            mail_notice(
                self.transport.as_ref(),
                &opened.db,
                notice,
                self.platform_url.as_deref(),
            )
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_go_into_the_workspace_or_to_the_platform() {
        assert_eq!(
            usage_url(Some("https://app-test.weldsuite.org"), Some("org_alpha")),
            "https://app-test.weldsuite.org/w/org_alpha/weldpanel/settings?tab=usage"
        );
        assert_eq!(
            usage_url(None, None),
            "https://app.weldsuite.org/weldpanel/settings?tab=usage"
        );
        assert_eq!(
            usage_url(Some(""), None),
            "https://app.weldsuite.org/weldpanel/settings?tab=usage"
        );
    }
}
