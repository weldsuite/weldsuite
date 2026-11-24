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

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::postgres::PgConnection;
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, orm_error};
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner, Identity, Job, JobContext, JobError, ListPage, NewInvitation,
    ProvisionRequest, StepRetry, step,
};
use weldsuite_schema::master::{
    credit_transactions, digest_schedules, plans, workspace_credits, workspace_licences, workspaces,
};
use weldsuite_schema::tenant::{
    task_digest_settings, workspace_installed_apps, workspace_members, workspace_settings,
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

fn db(error: DbErr) -> JobError {
    JobError::failed(error)
}

/// `provisioning_status = 'provisioning'`, or once the database is ready
/// `database_provisioned_at = now()` and `'ready'`; the error cleared.
async fn mark_workspace(master: &PgPool, workspace_id: &str, ready: bool) -> Result<(), DbErr> {
    use workspaces::Column;
    let mut update = workspaces::Entity::update_many();
    if ready {
        update = update.col_expr(Column::DatabaseProvisionedAt, Expr::current_timestamp());
    }
    let status = if ready { "ready" } else { "provisioning" };
    update
        .col_expr(Column::ProvisioningStatus, Expr::value(status))
        .col_expr(
            Column::ProvisioningError,
            Expr::value(Option::<String>::None),
        )
        .col_expr(Column::UpdatedAt, Expr::current_timestamp())
        .filter(Column::Id.eq(workspace_id))
        .exec(&orm(master))
        .await
        .map(drop)
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
            mark_workspace(&self.master, ws, true).await.map_err(db)?;
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
        let org: Option<Option<String>> = workspaces::Entity::find()
            .select_only()
            .column(workspaces::Column::ClerkOrgId)
            .filter(workspaces::Column::Id.eq(workspace_id))
            .into_tuple()
            .one(&orm(&self.master))
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
                        invited_by: None,
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
        use workspaces::Column;
        let message: String = error.to_string().chars().take(1000).collect();
        let status = Expr::case(Column::DatabaseProvisionedAt.is_null(), "failed")
            .finally(Expr::col((workspaces::Entity, Column::ProvisioningStatus)));
        let recorded = workspaces::Entity::update_many()
            .col_expr(Column::ProvisioningStatus, status.into())
            .col_expr(Column::ProvisioningError, Expr::value(message))
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::Id.eq(workspace_id))
            .exec(&orm(&self.master))
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
                mark_workspace(&self.master, ws, false).await.map_err(db)?;
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
) -> Result<Option<PartnerContext>, DbErr> {
    let db = orm(master);
    let mode: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::BillingMode)
        .filter(workspaces::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&db)
        .await?;
    if mode.as_deref() != Some("partner") {
        return Ok(None);
    }
    let licence: Option<(Value, i32, i32)> = workspace_licences::Entity::find()
        .select_only()
        .columns([
            workspace_licences::Column::AllowedApps,
            workspace_licences::Column::MonthlyCredits,
            workspace_licences::Column::CreditRolloverCap,
        ])
        .filter(workspace_licences::Column::WorkspaceId.eq(workspace_id))
        .into_tuple()
        .one(&db)
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
) -> Result<bool, DbErr> {
    let db = orm(tenant);
    let existing: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::Id)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(false);
    }
    // No picture: avatars are the account's (master `users.image_url`).
    workspace_members::Entity::insert(workspace_members::ActiveModel {
        id: Set(weldsuite_kit::generate_id("mbr")),
        user_id: Set(user_id.to_owned()),
        email: Set(member.and_then(|m| m.email.clone())),
        name: Set(member.and_then(|m| m.name.clone())),
        role: Set("OWNER".to_owned()),
        status: Set("ACTIVE".to_owned()),
        accepted_at: Set(Some(OffsetDateTime::now_utc())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(true)
}

/// One conflict-tolerant insert per app; a failing one is logged.
async fn install_apps(tenant: &PgPool, apps: &[String], user_id: &str) -> Result<usize, DbErr> {
    let db = orm(tenant);
    for app in apps {
        let installed =
            workspace_installed_apps::Entity::insert(workspace_installed_apps::ActiveModel {
                id: Set(weldsuite_kit::generate_id("app")),
                app_code: Set(app.clone()),
                is_active: Set(true),
                display_order: Set(Some(0)),
                installed_at: Set(Some(OffsetDateTime::now_utc())),
                installed_by: Set(Some(user_id.to_owned())),
                ..Default::default()
            })
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(&db)
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
) -> Result<String, DbErr> {
    let tenant = orm(tenant);
    let existing: Option<String> = task_digest_settings::Entity::find()
        .select_only()
        .column(task_digest_settings::Column::Id)
        .into_tuple()
        .one(&tenant)
        .await?;
    if existing.is_none() {
        task_digest_settings::Entity::insert(task_digest_settings::ActiveModel {
            id: Set(weldsuite_kit::generate_id("tds")),
            enabled: Set(true),
            send_hour: Set(8),
            task_types: Set(json!({ "projectTasks": true, "personalTasks": true })),
            sections: Set(json!({ "overdue": true, "dueToday": true, "dueThisWeek": true })),
            ..Default::default()
        })
        .exec_without_returning(&tenant)
        .await?;
    }
    let timezone: Option<Option<String>> = workspace_settings::Entity::find()
        .select_only()
        .column(workspace_settings::Column::Timezone)
        .into_tuple()
        .one(&tenant)
        .await?;
    let timezone = timezone
        .flatten()
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "Europe/Amsterdam".to_owned());
    digest_schedules::Entity::insert(digest_schedules::ActiveModel {
        id: Set(weldsuite_kit::generate_id("ds")),
        workspace_id: Set(workspace_id.to_owned()),
        enabled: Set(true),
        send_hour: Set(8),
        timezone: Set(timezone.clone()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(master))
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

/// A moment as the old SQL bound it (`toISOString()` text): to the
/// millisecond.
fn to_millis(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

/// The plan's monthly credits as the wallet's first allocation. Unlike the
/// workers, the transaction row is written only by the call that created
/// the wallet, so a re-run never books the allocation twice.
async fn initialize_plan_credits(master: &PgPool, workspace_id: &str) -> Result<i32, DbErr> {
    // `p.monthly_credits` read as an integer: a plan without one fails the
    // step, as it did.
    let credits: Option<i32> = workspaces::Entity::find()
        .select_only()
        .column(plans::Column::MonthlyCredits)
        .join(
            JoinType::InnerJoin,
            workspaces::Entity::belongs_to(plans::Entity)
                .from(workspaces::Column::PlanId)
                .to(plans::Column::Id)
                .into(),
        )
        .filter(workspaces::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&orm(master))
        .await?;
    let credits = credits.unwrap_or(0);
    if credits <= 0 {
        return Ok(0);
    }
    let now = OffsetDateTime::now_utc();
    let (start, end) = month_period(now);
    let mut tx = master.begin().await.map_err(orm_error)?;
    {
        let db = OrmConn::new(&mut tx);
        let created = workspace_credits::Entity::insert(workspace_credits::ActiveModel {
            id: Set(weldsuite_kit::generate_id("crd")),
            workspace_id: Set(workspace_id.to_owned()),
            current_balance: Set(credits),
            plan_credits: Set(credits),
            subscribed_credits: Set(0),
            monthly_allocation: Set(credits),
            rolled_over_credits: Set(0),
            rollover_cap: Set(None),
            period_start: Set(start),
            period_end: Set(end),
            last_reset_at: Set(Some(to_millis(now))),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&db)
        .await?;
        if created == 1 {
            credit_transactions::Entity::insert(credit_transactions::ActiveModel {
                id: Set(weldsuite_kit::generate_id("ctx")),
                workspace_id: Set(workspace_id.to_owned()),
                type_: Set("monthly_allocation".to_owned()),
                amount: Set(credits),
                balance_after: Set(credits),
                description: Set(Some(format!(
                    "Initial credit allocation of {credits} credits"
                ))),
                metadata: Set(Some(
                    json!({ "reason": "workspace_creation", "planCredits": credits }),
                )),
                ..Default::default()
            })
            .exec_without_returning(&db)
            .await?;
        }
    }
    tx.commit().await.map_err(orm_error)?;
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
) -> Result<i32, DbErr> {
    use workspace_credits::{ActiveModel, Column, Entity};
    let now = OffsetDateTime::now_utc();
    let (start, end) = month_period(now);
    let mut tx = master.begin().await.map_err(orm_error)?;
    {
        let db = OrmConn::new(&mut tx);
        Entity::insert(ActiveModel {
            id: Set(weldsuite_kit::generate_id("wcr")),
            workspace_id: Set(workspace_id.to_owned()),
            current_balance: Set(0),
            plan_credits: Set(0),
            subscribed_credits: Set(0),
            monthly_allocation: Set(0),
            rolled_over_credits: Set(0),
            rollover_cap: Set(None),
            period_start: Set(start),
            period_end: Set(end),
            last_reset_at: Set(None),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&db)
        .await?;
        Entity::update_many()
            .col_expr(Column::PlanCredits, Expr::value(context.monthly_credits))
            .col_expr(Column::SubscribedCredits, Expr::value(0))
            .col_expr(
                Column::MonthlyAllocation,
                Expr::value(context.monthly_credits),
            )
            .col_expr(
                Column::RolloverCap,
                Expr::value(context.credit_rollover_cap),
            )
            .col_expr(Column::PeriodStart, Expr::value(start))
            .col_expr(Column::PeriodEnd, Expr::value(end))
            .col_expr(Column::LastResetAt, Expr::value(to_millis(now)))
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::WorkspaceId.eq(workspace_id))
            .exec(&db)
            .await?;
    }
    let (remaining, days) = month_remainder(now);
    let amount = i32::try_from(i64::from(context.monthly_credits) * remaining / days).unwrap_or(0);
    let mut granted = 0;
    if amount > 0 && grant_licence_remainder(&mut tx, workspace_id, context, amount).await? == 1 {
        granted = amount;
    }
    tx.commit().await.map_err(orm_error)?;
    Ok(granted)
}

/// The rest of this month's licensed allowance, once
/// (`partner_licence:init:<workspace>`): the wallet's top-up and its ledger
/// row. Answers the rows inserted.
#[allow(
    clippy::disallowed_methods,
    reason = "a guarded grant: the wallet top-up and its ledger row are one data-modifying \
              statement, the idempotency key checked in the same statement"
)]
async fn grant_licence_remainder(
    conn: &mut PgConnection,
    workspace_id: &str,
    context: &PartnerContext,
    amount: i32,
) -> Result<u64, DbErr> {
    let key = format!("partner_licence:init:{workspace_id}");
    sqlx::query(
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
    .bind(format!(
        "Licensed monthly credits, rest of the month: +{amount}"
    ))
    .bind(json!({
        "reason": "partner_licence",
        "changeId": format!("init:{workspace_id}"),
        "delta": context.monthly_credits,
        "prorated": amount,
    }))
    .execute(conn)
    .await
    .map(|done| done.rows_affected())
    .map_err(orm_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn iso(at: OffsetDateTime) -> String {
        weldsuite_events::iso_timestamp(at)
    }

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
