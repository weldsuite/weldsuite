//! `workspace.provision`: the `ProvisionWorkspaceWorkflow`
//! (`apps/workers/workspace-worker/src/workflows/provision-workspace.ts`) on
//! the Jobs port. Steps, each retried on its own:
//!
//! | Step | What |
//! |---|---|
//! | `mark-provisioning` | `provisioning_status = 'provisioning'` |
//! | `load-partner-context` | a partner-managed workspace's licence: its apps, its credits |
//! | `provision-database` | the `DatabaseProvisioner` port: database, role, sealed URL, tenant migrations |
//! | `insert-initial-member` | the OWNER member |
//! | `install-apps` | the selected (or licensed) apps |
//! | `mark-provisioned` | `database_provisioned_at`, `provisioning_status = 'ready'`: the user can enter |
//! | `invite-owner` | partner-managed only: the customer's owner, from the organization's private metadata |
//! | `setup-digest` | the task digest settings, the master digest schedule |
//! | `initialize-credits` | the plan's (or the licence's) first monthly credits |
//!
//! When a step runs out of retries the workspace is marked `failed` (unless
//! it was already ready) so the onboarding screen offers a retry.
//!
//! Left out on the Kubernetes editions: sample data and the default helpdesk
//! workflows (their seeders belong to modules not ported yet), the WeldMail
//! domain and mailbox (Cloudflare), and Stripe billing (Global only).

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner, Identity, Job, JobContext, JobError, ListPage, NewInvitation,
    ProvisionRequest, StepRetry, step,
};

use crate::TenantDatabases;
use crate::onboard::InitialMember;

/// The job's name in the registry.
pub const PROVISION_JOB: &str = "workspace.provision";

/// What the job is started with (`ProvisionWorkspaceParams`, without the
/// database URL: the provisioner makes it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionPayload {
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    /// The OWNER's user id.
    pub initial_member_user_id: String,
    #[serde(default)]
    pub initial_member: Option<InitialMember>,
    #[serde(default)]
    pub selected_apps: Option<Vec<String>>,
    #[serde(default)]
    pub slug: Option<String>,
    /// Kept for parity; there are no seeders yet.
    #[serde(default)]
    pub seed_sample_data: Option<bool>,
}

/// `PartnerProvisionContext`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartnerContext {
    allowed_apps: Vec<String>,
    monthly_credits: i32,
    credit_rollover_cap: i32,
}

fn retries() -> StepRetry {
    StepRetry::exponential(2, Duration::from_secs(5))
}

fn db(error: sqlx::Error) -> JobError {
    JobError::failed(error)
}

/// The job: register one per process.
pub struct ProvisionJob {
    master: PgPool,
    provisioner: Arc<dyn DatabaseProvisioner>,
    tenants: TenantDatabases,
    /// For the partner owner's invitation.
    identity: Option<Arc<dyn Identity>>,
}

impl ProvisionJob {
    pub fn new(
        master: PgPool,
        provisioner: Arc<dyn DatabaseProvisioner>,
        tenants: TenantDatabases,
        identity: Option<Arc<dyn Identity>>,
    ) -> Self {
        Self {
            master,
            provisioner,
            tenants,
            identity,
        }
    }

    async fn tenant(&self, workspace_id: &str) -> Result<PgPool, JobError> {
        (self.tenants)(workspace_id.to_owned())
            .await
            .map_err(JobError::Failed)
    }

    async fn steps(&self, ctx: &dyn JobContext, job: &ProvisionPayload) -> Result<(), JobError> {
        let ws = job.workspace_id.as_str();
        let partner: Option<PartnerContext> =
            step(ctx, "load-partner-context", retries(), || async {
                partner_context(&self.master, ws).await.map_err(db)
            })
            .await?;
        let apps: Vec<String> = match &partner {
            Some(context) => context.allowed_apps.clone(),
            None => job.selected_apps.clone().unwrap_or_default(),
        };

        let applied: usize = step(
            ctx,
            "provision-database",
            StepRetry::exponential(3, Duration::from_secs(10)),
            || async {
                let database = self
                    .provisioner
                    .provision(&ProvisionRequest::new(ws))
                    .await
                    .map_err(JobError::failed)?;
                Ok(database.migrations_applied)
            },
        )
        .await?;
        tracing::info!(workspace_id = ws, applied, "provision: database ready");

        let _: bool = step(ctx, "insert-initial-member", retries(), || async {
            let tenant = self.tenant(ws).await?;
            insert_initial_member(
                &tenant,
                &job.initial_member_user_id,
                job.initial_member.as_ref(),
            )
            .await
            .map_err(db)
        })
        .await?;

        if !apps.is_empty() {
            let _: usize = step(ctx, "install-apps", retries(), || async {
                let tenant = self.tenant(ws).await?;
                install_apps(&tenant, &apps, &job.initial_member_user_id)
                    .await
                    .map_err(db)
            })
            .await?;
        }

        let _: bool = step(ctx, "mark-provisioned", retries(), || async {
            sqlx::query(
                "update workspaces set database_provisioned_at = now(), provisioning_status = 'ready',
                        provisioning_error = null, updated_at = now() where id = $1",
            )
            .bind(ws)
            .execute(&self.master)
            .await
            .map_err(db)?;
            Ok(true)
        })
        .await?;

        if partner.is_some() {
            let invited: Result<bool, JobError> = step(
                ctx,
                "invite-owner",
                StepRetry::exponential(3, Duration::from_secs(5)),
                || async { self.invite_partner_owner(ws).await },
            )
            .await;
            if let Err(error) = invited {
                tracing::error!(%error, workspace_id = ws, "provision: owner invitation failed");
            }
        }

        let _: String = step(ctx, "setup-digest", retries(), || async {
            let tenant = self.tenant(ws).await?;
            setup_digest(&self.master, &tenant, ws).await.map_err(db)
        })
        .await?;

        let _: i32 = step(ctx, "initialize-credits", retries(), || async {
            match &partner {
                Some(context) => initialise_licensed_credits(&self.master, ws, context)
                    .await
                    .map_err(db),
                None => initialize_plan_credits(&self.master, ws).await.map_err(db),
            }
        })
        .await?;
        Ok(())
    }

    /// `ensurePartnerOwnerInvited`: invite the owner the partner named
    /// (`partnerOwnerInvite` in the organization's private metadata) unless
    /// an invitation is pending, then drop the marker.
    async fn invite_partner_owner(&self, workspace_id: &str) -> Result<bool, JobError> {
        let Some(identity) = &self.identity else {
            return Ok(false);
        };
        let org: Option<Option<String>> =
            sqlx::query_scalar("select clerk_org_id from workspaces where id = $1")
                .bind(workspace_id)
                .fetch_optional(&self.master)
                .await
                .map_err(db)?;
        let Some(org) = org.flatten() else {
            return Ok(false);
        };
        let organization = identity
            .organization(&org)
            .await
            .map_err(JobError::failed)?;
        let pending = &organization.private_metadata["partnerOwnerInvite"];
        let Some(email) = pending["email"].as_str().filter(|e| !e.is_empty()) else {
            return Ok(false);
        };
        let existing = identity
            .invitations(&org, Some("pending"), ListPage::limit(500))
            .await
            .map_err(JobError::failed)?;
        let already = existing
            .data
            .iter()
            .any(|i| i.email_address.eq_ignore_ascii_case(email));
        if !already {
            let mut metadata = json!({ "weldRole": "OWNER" });
            if let Some(name) = pending["invitedByName"].as_str().filter(|n| !n.is_empty()) {
                metadata["invitedByName"] = json!(name);
            }
            identity
                .invite(
                    &org,
                    &NewInvitation {
                        email_address: email.to_owned(),
                        role: "org:admin".to_owned(),
                        redirect_url: None,
                        public_metadata: Some(metadata),
                        inviter_user_id: None,
                    },
                )
                .await
                .map_err(JobError::failed)?;
        }
        if let Err(error) = identity
            .update_organization_metadata(&org, None, Some(&json!({ "partnerOwnerInvite": null })))
            .await
        {
            tracing::warn!(%error, "provision: could not clear the owner-invite marker");
        }
        Ok(!already)
    }

    /// A step ran out of retries: `failed`, unless the workspace already
    /// reached ready (a failure in a later step must not send an admitted
    /// user back to a failed onboarding screen); the error is kept.
    async fn record_failure(&self, workspace_id: &str, error: &JobError) {
        let message: String = error.to_string().chars().take(1000).collect();
        let recorded = sqlx::query(
            "update workspaces
                set provisioning_status = case when database_provisioned_at is null
                                               then 'failed' else provisioning_status end,
                    provisioning_error = $2, updated_at = now()
              where id = $1",
        )
        .bind(workspace_id)
        .bind(message)
        .execute(&self.master)
        .await;
        if let Err(error) = recorded {
            tracing::error!(%error, workspace_id, "provision: could not record the failure");
        }
    }
}

impl Job for ProvisionJob {
    fn name(&self) -> &'static str {
        PROVISION_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let job: ProvisionPayload = serde_json::from_value(payload)?;
            let ws = job.workspace_id.as_str();
            tracing::info!(workspace_id = ws, "provision: starting");
            let _: bool = step(ctx, "mark-provisioning", retries(), || async {
                sqlx::query(
                    "update workspaces set provisioning_status = 'provisioning',
                            provisioning_error = null, updated_at = now() where id = $1",
                )
                .bind(ws)
                .execute(&self.master)
                .await
                .map_err(db)?;
                Ok(true)
            })
            .await?;
            let result = self.steps(ctx, &job).await;
            if let Err(error) = &result {
                tracing::error!(%error, workspace_id = ws, "provision: failed");
                self.record_failure(ws, error).await;
            }
            result
        })
    }
}

/// `getPartnerProvisionContext`: `None` for a direct workspace; a partner
/// workspace without a licence row is core-only with no credits.
async fn partner_context(
    master: &PgPool,
    workspace_id: &str,
) -> Result<Option<PartnerContext>, sqlx::Error> {
    let mode: Option<String> =
        sqlx::query_scalar("select billing_mode from workspaces where id = $1 limit 1")
            .bind(workspace_id)
            .fetch_optional(master)
            .await?;
    if mode.as_deref() != Some("partner") {
        return Ok(None);
    }
    let licence: Option<(Value, i32, i32)> = sqlx::query_as(
        "select allowed_apps, monthly_credits, credit_rollover_cap
           from workspace_licences where workspace_id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(Some(licence.map_or(
        PartnerContext {
            allowed_apps: Vec::new(),
            monthly_credits: 0,
            credit_rollover_cap: 0,
        },
        |(apps, monthly, cap)| {
            PartnerContext {
                allowed_apps: apps
                    .as_array()
                    .map(|apps| {
                        apps.iter()
                            .filter_map(|a| a.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                monthly_credits: monthly,
                credit_rollover_cap: cap,
            }
        },
    )))
}

/// The OWNER member, unless the user is already one.
async fn insert_initial_member(
    tenant: &PgPool,
    user_id: &str,
    member: Option<&InitialMember>,
) -> Result<bool, sqlx::Error> {
    let existing: Option<String> =
        sqlx::query_scalar("select id from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(tenant)
            .await?;
    if existing.is_some() {
        return Ok(false);
    }
    sqlx::query(
        "insert into workspace_members (id, user_id, email, name, picture, role, status, accepted_at)
         values ($1, $2, $3, $4, $5, 'OWNER', 'ACTIVE', now())",
    )
    .bind(weldsuite_kit::generate_id("mbr"))
    .bind(user_id)
    .bind(member.and_then(|m| m.email.as_deref()))
    .bind(member.and_then(|m| m.name.as_deref()))
    .bind(member.and_then(|m| m.picture.as_deref()))
    .execute(tenant)
    .await?;
    Ok(true)
}

/// One conflict-tolerant insert per app; a failing one is logged.
async fn install_apps(
    tenant: &PgPool,
    apps: &[String],
    user_id: &str,
) -> Result<usize, sqlx::Error> {
    for app in apps {
        let installed = sqlx::query(
            "insert into workspace_installed_apps (id, app_code, is_active, display_order, installed_at, installed_by)
             values ($1, $2, true, 0, now(), $3)
             on conflict do nothing",
        )
        .bind(weldsuite_kit::generate_id("app"))
        .bind(app)
        .bind(user_id)
        .execute(tenant)
        .await;
        if let Err(error) = installed {
            tracing::warn!(%error, app, "provision: failed to install an app");
        }
    }
    Ok(apps.len())
}

/// The singleton task digest settings, then the master digest schedule in
/// the workspace's timezone (default `Europe/Amsterdam`).
async fn setup_digest(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
) -> Result<String, sqlx::Error> {
    let existing: Option<String> =
        sqlx::query_scalar("select id from task_digest_settings limit 1")
            .fetch_optional(tenant)
            .await?;
    if existing.is_none() {
        sqlx::query(
            "insert into task_digest_settings (id, enabled, send_hour, task_types, sections)
             values ($1, true, 8, $2, $3)",
        )
        .bind(weldsuite_kit::generate_id("tds"))
        .bind(json!({ "projectTasks": true, "personalTasks": true }))
        .bind(json!({ "overdue": true, "dueToday": true, "dueThisWeek": true }))
        .execute(tenant)
        .await?;
    }
    let timezone: Option<Option<String>> =
        sqlx::query_scalar("select timezone from workspace_settings limit 1")
            .fetch_optional(tenant)
            .await?;
    let timezone = timezone
        .flatten()
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "Europe/Amsterdam".to_owned());
    sqlx::query(
        "insert into digest_schedules (id, workspace_id, enabled, send_hour, timezone)
         values ($1, $2, true, 8, $3)
         on conflict do nothing",
    )
    .bind(weldsuite_kit::generate_id("ds"))
    .bind(workspace_id)
    .bind(&timezone)
    .execute(master)
    .await?;
    Ok(timezone)
}

/// The first and next month's UTC midnights.
fn month_period(now: OffsetDateTime) -> (OffsetDateTime, OffsetDateTime) {
    let start = now
        .replace_day(1)
        .unwrap_or(now)
        .replace_time(time::Time::MIDNIGHT);
    let (year, month) = if now.month() == time::Month::December {
        (now.year() + 1, time::Month::January)
    } else {
        (now.year(), now.month().next())
    };
    let end = time::Date::from_calendar_date(year, month, 1).map_or(start, |date| {
        date.with_time(time::Time::MIDNIGHT).assume_utc()
    });
    (start, end)
}

fn iso(at: OffsetDateTime) -> String {
    weldsuite_events::iso_timestamp(at)
}

/// The plan's monthly credits as the wallet's first allocation. Unlike the
/// workers, the transaction row is written only by the call that created
/// the wallet, so a re-run never books the allocation twice.
async fn initialize_plan_credits(master: &PgPool, workspace_id: &str) -> Result<i32, sqlx::Error> {
    let credits: Option<i32> = sqlx::query_scalar(
        "select p.monthly_credits from workspaces w join plans p on p.id = w.plan_id
          where w.id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    let credits = credits.unwrap_or(0);
    if credits <= 0 {
        return Ok(0);
    }
    let now = OffsetDateTime::now_utc();
    let (start, end) = month_period(now);
    let mut tx = master.begin().await?;
    let created = sqlx::query(
        "insert into workspace_credits
           (id, workspace_id, current_balance, plan_credits, subscribed_credits, monthly_allocation,
            rolled_over_credits, rollover_cap, period_start, period_end, last_reset_at)
         values ($1, $2, $3, $3, 0, $3, 0, null, $4::timestamptz, $5::timestamptz, $6::timestamptz)
         on conflict do nothing",
    )
    .bind(weldsuite_kit::generate_id("crd"))
    .bind(workspace_id)
    .bind(credits)
    .bind(iso(start))
    .bind(iso(end))
    .bind(iso(now))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if created == 1 {
        sqlx::query(
            "insert into credit_transactions (id, workspace_id, type, amount, balance_after, description, metadata)
             values ($1, $2, 'monthly_allocation', $3, $3, $4, $5)",
        )
        .bind(weldsuite_kit::generate_id("ctx"))
        .bind(workspace_id)
        .bind(credits)
        .bind(format!("Initial credit allocation of {credits} credits"))
        .bind(json!({ "reason": "workspace_creation", "planCredits": credits }))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(credits)
}

/// `monthRemainder`: the days left in the month, today included, and the
/// month's length.
fn month_remainder(now: OffsetDateTime) -> (i64, i64) {
    let (start, end) = month_period(now);
    let days = (end - start).whole_days();
    (days - i64::from(now.day()) + 1, days)
}

/// `initialiseLicensedCredits` (`applyLicenceCredits` for a first
/// licence): the allocation follows the licence, and the rest of this
/// month's allowance is granted once (`partner_licence:init:<workspace>`).
async fn initialise_licensed_credits(
    master: &PgPool,
    workspace_id: &str,
    context: &PartnerContext,
) -> Result<i32, sqlx::Error> {
    let now = OffsetDateTime::now_utc();
    let (start, end) = month_period(now);
    let mut tx = master.begin().await?;
    sqlx::query(
        "insert into workspace_credits
           (id, workspace_id, current_balance, plan_credits, subscribed_credits, monthly_allocation,
            rolled_over_credits, rollover_cap, period_start, period_end, last_reset_at)
         values ($1, $2, 0, 0, 0, 0, 0, null, $3::timestamptz, $4::timestamptz, null)
         on conflict do nothing",
    )
    .bind(weldsuite_kit::generate_id("wcr"))
    .bind(workspace_id)
    .bind(iso(start))
    .bind(iso(end))
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "update workspace_credits
            set plan_credits = $2, subscribed_credits = 0, monthly_allocation = $2, rollover_cap = $3,
                period_start = $4::timestamptz, period_end = $5::timestamptz,
                last_reset_at = $6::timestamptz, updated_at = now()
          where workspace_id = $1",
    )
    .bind(workspace_id)
    .bind(context.monthly_credits)
    .bind(context.credit_rollover_cap)
    .bind(iso(start))
    .bind(iso(end))
    .bind(iso(now))
    .execute(&mut *tx)
    .await?;
    let (remaining, days) = month_remainder(now);
    let amount = i32::try_from(i64::from(context.monthly_credits) * remaining / days).unwrap_or(0);
    let key = format!("partner_licence:init:{workspace_id}");
    let mut granted = 0;
    if amount > 0 {
        let inserted = sqlx::query(
            "with wallet as (
                update workspace_credits set current_balance = current_balance + $3, updated_at = now()
                 where workspace_id = $2 and not exists (
                   select 1 from credit_transactions where idempotency_key = $4)
                returning current_balance)
             insert into credit_transactions
               (id, workspace_id, type, amount, balance_after, idempotency_key, description, metadata)
             select $1, $2, 'monthly_allocation', $3, current_balance, $4, $5, $6 from wallet",
        )
        .bind(weldsuite_kit::generate_id("ctx"))
        .bind(workspace_id)
        .bind(amount)
        .bind(&key)
        .bind(format!("Licensed monthly credits, rest of the month: +{amount}"))
        .bind(json!({
            "reason": "partner_licence",
            "changeId": format!("init:{workspace_id}"),
            "delta": context.monthly_credits,
            "prorated": amount,
        }))
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 1 {
            granted = amount;
        }
    }
    tx.commit().await?;
    Ok(granted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(year: i32, month: time::Month, day: u8, hour: u8) -> OffsetDateTime {
        time::Date::from_calendar_date(year, month, day)
            .and_then(|date| date.with_hms(hour, 0, 0))
            .expect("date")
            .assume_utc()
    }

    #[test]
    fn months_and_their_remainder() {
        let at = utc(2026, time::Month::December, 30, 13);
        let (start, end) = month_period(at);
        assert_eq!(iso(start), "2026-12-01T00:00:00.000Z");
        assert_eq!(iso(end), "2027-01-01T00:00:00.000Z");
        assert_eq!(month_remainder(at), (2, 31));
        let february = utc(2026, time::Month::February, 1, 0);
        assert_eq!(month_remainder(february), (28, 28));
    }
}
