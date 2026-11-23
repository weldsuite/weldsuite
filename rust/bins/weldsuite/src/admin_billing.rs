//! `weldsuite admin billing …`: staff work on plan billing (ADR BILL-014,
//! "Staff tools"), audited in `admin_audit_events` like the rest of
//! `weldsuite admin` (ADR SEC-014):
//!
//! - `show <workspace>`: plan, seats, period, the Mollie account, and the
//!   latest charges and invoices.
//! - `comp <workspace> [--plan <id|slug>] [--seats <n>] [--until <date>]`:
//!   a complimentary plan (BILL-011): the renewal job charges nothing and
//!   still grants the plan's credits; it ends the comp on `--until`.
//! - `uncomp <workspace>`: ends the comp now; without a paid subscription
//!   under it the workspace goes to Free.
//! - `refund <charge> [--amount <cents>]`: refunds a paid charge (its
//!   `bpy_` id or the Mollie `tr_` id) through Mollie, in full by default.
//!   The credit note is made in WeldBooks, in the issuer workspace.
//! - `retry-now <workspace>`: charges a past-due workspace's open charge on
//!   its mandate again.

use sea_orm::sea_query::{Alias, Expr, Func, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, orm, orm_error, utc_timestamp};
use weldsuite_schema::master::{billing_accounts, billing_payments, plans, workspaces};
use weldsuite_staff_domain::access::find_workspace;
use weldsuite_staff_domain::audit::{AuditEntry, record_failure, record_success};
use weldsuite_staff_domain::staff;
use weldsuite_staff_domain::{StaffError, StaffResult};

/// A charge as `refund` reads it: id, workspace, Mollie payment, amount,
/// currency, refunded so far, status.
type ChargeRow = (String, String, Option<String>, i32, String, i32, String);

/// One billing command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BillingCommand {
    Show {
        workspace: String,
    },
    Comp {
        workspace: String,
        plan: Option<String>,
        seats: Option<i64>,
        until: Option<String>,
    },
    Uncomp {
        workspace: String,
    },
    Refund {
        charge: String,
        amount: Option<i64>,
    },
    RetryNow {
        workspace: String,
    },
}

impl BillingCommand {
    pub(crate) fn writes(&self) -> bool {
        !matches!(self, Self::Show { .. })
    }

    /// From `billing <action> <target>` and the flags the parser left.
    pub(crate) fn parse(
        action: Option<&str>,
        target: Option<&str>,
        take: &mut dyn FnMut(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let target = |what: &str| {
            target
                .map(str::to_owned)
                .ok_or_else(|| format!("name the {what}"))
        };
        let number = |flag: &str, value: Option<String>| {
            value
                .map(|v| {
                    v.parse::<i64>()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| format!("{flag} is a whole number above 0"))
                })
                .transpose()
        };
        Ok(match action {
            Some("show") => Self::Show {
                workspace: target("workspace")?,
            },
            Some("comp") => {
                let until = take("--until");
                if let Some(until) = &until
                    && until != "none"
                    && time::Date::parse(
                        until,
                        &time::format_description::well_known::Iso8601::DATE,
                    )
                    .is_err()
                {
                    return Err("--until is a date (YYYY-MM-DD) or none".to_owned());
                }
                Self::Comp {
                    workspace: target("workspace")?,
                    plan: take("--plan"),
                    seats: number("--seats", take("--seats"))?,
                    until: until.filter(|u| u != "none"),
                }
            }
            Some("uncomp") => Self::Uncomp {
                workspace: target("workspace")?,
            },
            Some("refund") => Self::Refund {
                charge: target("charge (bpy_… or tr_…)")?,
                amount: number("--amount", take("--amount"))?,
            },
            Some("retry-now") => Self::RetryNow {
                workspace: target("workspace")?,
            },
            Some(other) => return Err(format!("unknown billing action {other}")),
            None => return Err("billing needs an action".to_owned()),
        })
    }
}

/// Plan billing from the environment, for the actions that call Mollie.
fn billing(master: &PgPool) -> StaffResult<weldsuite_core_billing::BillingState> {
    let settings =
        weldsuite_core_billing::BillingSettings::from_lookup(&|name| std::env::var(name).ok())
            .map_err(StaffError::Refused)?
            .ok_or_else(|| {
                StaffError::Refused(
                    "Plan billing is off on this install (BILLING_PROVIDER is not mollie)."
                        .to_owned(),
                )
            })?;
    let keyring = weldsuite_db::Keyring {
        v1: std::env::var("DATABASE_ENCRYPTION_KEY").ok(),
        v2: std::env::var("DATABASE_ENCRYPTION_KEY_V2").ok(),
    };
    let workspaces = std::sync::Arc::new(weldsuite_db::Workspaces::new(
        master.clone(),
        keyring,
        weldsuite_db::WorkspaceConfig::default(),
    ));
    Ok(crate::billing::build(
        master.clone(),
        workspaces,
        settings,
        None,
        None,
        None,
    ))
}

async fn summary(master: &PgPool, workspace_id: &str) -> StaffResult<Value> {
    let state = summary_document(master, workspace_id)
        .await
        .map_err(orm_error)?;
    state.ok_or_else(|| StaffError::Refused("No such workspace.".to_owned()))
}

/// The workspace's billing as one `jsonb` document: the workspace and its
/// plan, its billing account (less its id) and its latest ten charges and
/// invoices, printed as Postgres writes them.
#[allow(
    clippy::disallowed_methods,
    reason = "one jsonb report over four tables (nested `jsonb_agg` of the latest rows, a row \
              less a key), printed with Postgres's own keys, key order and timestamp text"
)]
async fn summary_document(master: &PgPool, workspace_id: &str) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar(
        "select jsonb_build_object(
             'workspace', jsonb_build_object('id', w.id, 'name', w.name, 'slug', w.slug,
                 'plan', p.slug, 'purchasedSeats', w.purchased_seats,
                 'status', w.subscription_status, 'cycle', w.subscription_cycle,
                 'periodStart', w.subscription_current_period_start,
                 'periodEnd', w.subscription_current_period_end,
                 'cancelAtPeriodEnd', w.subscription_cancel_at_period_end,
                 'compGrantedAt', w.comp_granted_at, 'compEndsAt', w.comp_ends_at,
                 'compGrantedBy', w.comp_granted_by, 'compReason', w.comp_reason),
             'account', (select to_jsonb(a) - 'id' from billing_accounts a where a.workspace_id = w.id),
             'charges', coalesce((select jsonb_agg(c order by c.created_at desc) from (
                 select id, kind, status, amount, currency, provider_payment_id, invoice_id,
                        refunded_amount, failure_message, created_at, paid_at
                 from billing_payments where workspace_id = w.id and provider = 'mollie'
                 order by created_at desc limit 10) c), '[]'::jsonb),
             'invoices', coalesce((select jsonb_agg(i order by i.created_at desc) from (
                 select id, number, amount_paid, tax_amount, currency, customer_tax_exempt,
                        provider_payment_id, created_at
                 from billing_invoices where workspace_id = w.id
                 order by created_at desc limit 10) i), '[]'::jsonb))
         from workspaces w left join plans p on p.id = w.plan_id
         where w.id = $1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await
}

/// `select exists (select 1 from billing_accounts where workspace_id = $1
/// and next_charge_at is not null)`: whether the workspace pays for its plan
/// through Mollie.
async fn pays_through_mollie<C: ConnectionTrait>(
    db: &C,
    workspace_id: &str,
) -> Result<bool, DbErr> {
    use billing_accounts::{Column, Entity};
    let account = Query::select()
        .expr(Expr::val(1))
        .from(Entity)
        .cond_where(
            Condition::all()
                .add(Column::WorkspaceId.eq(workspace_id))
                .add(Column::NextChargeAt.is_not_null()),
        )
        .to_owned();
    let mut select = Query::select();
    select.expr_as(Expr::exists(account), Alias::new("paying"));
    let row = db
        .query_one(&select)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("select exists".to_owned()))?;
    row.try_get("", "paying")
}

/// The comp's writes to the workspace (`update workspaces set comp_… where
/// id = $1`): a plan given moves the workspace to it, active.
async fn grant_comp(
    db: &OrmConn<'_>,
    workspace_id: &str,
    comp: (OffsetDateTime, Option<&str>, &str, &str),
    plan_id: Option<&str>,
    seats: Option<i64>,
) -> Result<(), DbErr> {
    use workspaces::{Column, Entity};
    let (granted_at, ends, granted_by, reason) = comp;
    // `comp_ends_at = $3::timestamp`: the end as the text the details show.
    let ends = Func::cast_as(Expr::val(ends), Alias::new("timestamp"));
    let mut update = Entity::update_many()
        .col_expr(
            Column::CompGrantedAt,
            Expr::value(utc_timestamp(granted_at)),
        )
        .col_expr(Column::CompEndsAt, ends.into())
        .col_expr(Column::CompGrantedBy, Expr::value(granted_by))
        .col_expr(Column::CompReason, Expr::value(reason));
    // `plan_id = coalesce($6, plan_id)`, with `subscription_status = 'active'`.
    if let Some(plan_id) = plan_id {
        update = update
            .col_expr(Column::PlanId, Expr::value(plan_id))
            .col_expr(Column::SubscriptionStatus, Expr::value("active"));
    }
    // `purchased_seats = coalesce($7, purchased_seats)`.
    if let Some(seats) = seats {
        update = update.col_expr(
            Column::PurchasedSeats,
            Expr::value(i32::try_from(seats).unwrap_or(i32::MAX)),
        );
    }
    update
        .col_expr(Column::UpdatedAt, Expr::current_timestamp())
        .filter(Column::Id.eq(workspace_id))
        .exec(db)
        .await?;
    Ok(())
}

fn pretty(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    text
}

/// Runs `command`; writes need `actor` (an active non-viewer staff row) and
/// `reason`.
#[allow(clippy::too_many_lines)] // one arm per action
pub(crate) async fn execute(
    master: &PgPool,
    command: &BillingCommand,
    actor: Option<&str>,
    reason: &str,
    dry_run: bool,
) -> StaffResult<String> {
    if let BillingCommand::Show { workspace } = command {
        let found = find_workspace(master, workspace).await?;
        return Ok(pretty(&summary(master, &found.id).await?));
    }
    let actor = staff::writer(master, actor.unwrap_or_default()).await?;
    if reason.trim().chars().count() < 3 {
        return Err(StaffError::Refused(
            "--reason is required (at least 3 characters).".to_owned(),
        ));
    }
    let now = OffsetDateTime::now_utc();
    match command {
        BillingCommand::Show { .. } => unreachable!("handled above"),
        BillingCommand::Comp {
            workspace,
            plan,
            seats,
            until,
        } => {
            let found = find_workspace(master, workspace).await?;
            let plan_id: Option<String> = match plan {
                Some(plan) => Some(
                    plans::Entity::find()
                        .select_only()
                        .column(plans::Column::Id)
                        .filter(
                            Condition::any()
                                .add(plans::Column::Id.eq(plan))
                                .add(plans::Column::Slug.eq(plan)),
                        )
                        .filter(plans::Column::DeletedAt.is_null())
                        .into_tuple()
                        .one(&orm(master))
                        .await?
                        .ok_or_else(|| StaffError::Refused(format!("No plan \"{plan}\".")))?,
                ),
                None => None,
            };
            // A workspace paying through Mollie keeps its paid plan under a
            // comp (the renewal job then charges nothing until it ends), so
            // the comp can't change plan or seats: uncomp would resume billing
            // the comped plan at the paid plan's seat price.
            let paying = pays_through_mollie(&orm(master), &found.id).await?;
            if paying && (plan_id.is_some() || seats.is_some()) {
                return Err(StaffError::Refused(format!(
                    "{} pays for its plan through Mollie. Comp it without --plan and --seats \
                     (it then pays nothing until the comp ends), or have its plan changed first.",
                    found.name
                )));
            }
            let ends = until.as_ref().map(|date| format!("{date}T23:59:59.999Z"));
            let details = json!({ "plan": plan_id, "seats": seats, "until": ends });
            if dry_run {
                return Ok(format!(
                    "Would comp {} ({}): {details}\n",
                    found.name, found.id
                ));
            }
            let entry = AuditEntry {
                workspace_id: Some(&found.id),
                target_type: "workspace",
                target_id: &found.id,
                action: "workspace.billing.comp",
                actor_email: &actor.email,
                reason: Some(reason),
                details: Some(details.clone()),
            };
            let mut tx = master.begin().await?;
            grant_comp(
                &OrmConn::new(&mut tx),
                &found.id,
                (now, ends.as_deref(), &actor.email, reason),
                plan_id.as_deref(),
                *seats,
            )
            .await?;
            // A comped workspace's inboxes run, unbilled: resume any a past
            // plan's end paused.
            weldsuite_core_billing::addons::resume_inboxes(&mut tx, &found.id).await?;
            let db = OrmConn::new(&mut tx);
            // A comp pays what is open: nothing stays past due under it.
            billing_accounts::Entity::update_many()
                .col_expr(
                    billing_accounts::Column::PastDueSince,
                    Expr::value(Option::<time::PrimitiveDateTime>::None),
                )
                .col_expr(
                    billing_accounts::Column::PastDuePaymentId,
                    Expr::value(Option::<String>::None),
                )
                .col_expr(
                    billing_accounts::Column::DunningRemindedAt,
                    Expr::value(Option::<time::PrimitiveDateTime>::None),
                )
                .col_expr(
                    billing_accounts::Column::UpdatedAt,
                    Expr::current_timestamp(),
                )
                .filter(billing_accounts::Column::WorkspaceId.eq(&found.id))
                .exec(&db)
                .await?;
            workspaces::Entity::update_many()
                .col_expr(
                    workspaces::Column::SubscriptionStatus,
                    Expr::value("active"),
                )
                .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                .filter(workspaces::Column::Id.eq(&found.id))
                .filter(workspaces::Column::SubscriptionStatus.eq("past_due"))
                .exec(&db)
                .await?;
            record_success(&db, &entry).await?;
            tx.commit().await?;
            Ok(format!("Comped {} ({}): {details}\n", found.name, found.id))
        }
        BillingCommand::Uncomp { workspace } => {
            let found = find_workspace(master, workspace).await?;
            let comped: bool = workspaces::Entity::find()
                .select_only()
                .expr_as(
                    sea_orm::ExprTrait::is_not_null(Expr::col(workspaces::Column::CompGrantedAt)),
                    "comped",
                )
                .filter(workspaces::Column::Id.eq(&found.id))
                .into_tuple()
                .one(&orm(master))
                .await?
                .ok_or_else(|| DbErr::RecordNotFound("workspaces".to_owned()))?;
            if !comped {
                return Err(StaffError::Refused(format!(
                    "{} has no comp plan.",
                    found.name
                )));
            }
            if dry_run {
                return Ok(format!(
                    "Would end the comp of {} ({}).\n",
                    found.name, found.id
                ));
            }
            let entry = AuditEntry {
                workspace_id: Some(&found.id),
                target_type: "workspace",
                target_id: &found.id,
                action: "workspace.billing.uncomp",
                actor_email: &actor.email,
                reason: Some(reason),
                details: None,
            };
            let mut tx = master.begin().await?;
            let db = OrmConn::new(&mut tx);
            let paying = pays_through_mollie(&db, &found.id).await?;
            let no_time = || Expr::value(Option::<time::PrimitiveDateTime>::None);
            let no_text = || Expr::value(Option::<String>::None);
            workspaces::Entity::update_many()
                .col_expr(workspaces::Column::CompGrantedAt, no_time())
                .col_expr(workspaces::Column::CompEndsAt, no_time())
                .col_expr(workspaces::Column::CompGrantedBy, no_text())
                .col_expr(workspaces::Column::CompReason, no_text())
                .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                .filter(workspaces::Column::Id.eq(&found.id))
                .exec(&db)
                .await?;
            record_success(&db, &entry).await?;
            tx.commit().await?;
            if paying {
                return Ok(format!(
                    "Ended the comp of {}; its paid subscription goes on.\n",
                    found.name
                ));
            }
            if let Ok(state) = billing(master) {
                weldsuite_core_billing::engine::end_subscription(&state, master, &found.id, now)
                    .await
                    .map_err(|error| StaffError::Refused(format!("{error:?}")))?;
                Ok(format!(
                    "Ended the comp of {}; it is on Free now.\n",
                    found.name
                ))
            } else {
                // `plan_id = (select id from plans where slug = 'free' limit 1)`.
                let free = Query::select()
                    .column(plans::Column::Id)
                    .from(plans::Entity)
                    .and_where(plans::Column::Slug.eq("free"))
                    .limit(1)
                    .to_owned();
                workspaces::Entity::update_many()
                    .col_expr(workspaces::Column::PlanId, Expr::from(free))
                    .col_expr(workspaces::Column::PurchasedSeats, Expr::value(0))
                    .col_expr(
                        workspaces::Column::SubscriptionStatus,
                        Expr::value("canceled"),
                    )
                    .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                    .filter(workspaces::Column::Id.eq(&found.id))
                    .exec(&orm(master))
                    .await?;
                Ok(format!(
                    "Ended the comp of {}; it is on Free now.\n",
                    found.name
                ))
            }
        }
        BillingCommand::Refund { charge, amount } => {
            let row: Option<ChargeRow> = {
                use billing_payments::{Column, Entity};
                Entity::find()
                    .select_only()
                    .columns([
                        Column::Id,
                        Column::WorkspaceId,
                        Column::ProviderPaymentId,
                        Column::Amount,
                        Column::Currency,
                        Column::RefundedAmount,
                        Column::Status,
                    ])
                    .filter(Column::Provider.eq("mollie"))
                    .filter(
                        Condition::any()
                            .add(Column::Id.eq(charge))
                            .add(Column::ProviderPaymentId.eq(charge)),
                    )
                    .into_tuple()
                    .one(&orm(master))
                    .await?
            };
            let Some((row_id, workspace_id, payment_id, paid, currency, refunded, status)) = row
            else {
                return Err(StaffError::Refused(format!(
                    "No Mollie charge \"{charge}\"."
                )));
            };
            let Some(payment_id) =
                payment_id.filter(|_| status == "succeeded" || status == "duplicate")
            else {
                return Err(StaffError::Refused(
                    "Only a paid charge can be refunded.".to_owned(),
                ));
            };
            let open = i64::from(paid) - i64::from(refunded);
            let amount = amount.unwrap_or(open);
            if amount <= 0 || amount > open {
                return Err(StaffError::Refused(format!(
                    "Between 1 and {open} cents of this charge can still be refunded."
                )));
            }
            let details = json!({ "charge": row_id, "payment": payment_id, "amount": amount, "currency": currency });
            if dry_run {
                return Ok(format!("Would refund: {details}\n"));
            }
            let entry = AuditEntry {
                workspace_id: Some(&workspace_id),
                target_type: "workspace",
                target_id: &workspace_id,
                action: "workspace.billing.refund",
                actor_email: &actor.email,
                reason: Some(reason),
                details: Some(details.clone()),
            };
            let state = billing(master)?;
            let http = state
                .http
                .clone()
                .ok_or_else(|| StaffError::Refused("No outbound HTTP client.".to_owned()))?;
            let money = weldsuite_mollie::Money::from_cents(&currency, amount);
            let refund = match state
                .mollie
                .refund(
                    &http,
                    &payment_id,
                    &money,
                    &format!("Refund {row_id}"),
                    &format!("refund:{row_id}:{}", i64::from(refunded) + amount),
                )
                .await
            {
                Ok(refund) => refund,
                Err(error) => {
                    let message = error.to_string();
                    record_failure(master, &entry, &message).await;
                    return Err(StaffError::Refused(format!(
                        "Mollie refused the refund: {message}"
                    )));
                }
            };
            let mut tx = master.begin().await?;
            let db = OrmConn::new(&mut tx);
            billing_payments::Entity::update_many()
                .col_expr(
                    billing_payments::Column::RefundedAmount,
                    sea_orm::ExprTrait::add(
                        Expr::col(billing_payments::Column::RefundedAmount),
                        i32::try_from(amount).unwrap_or(i32::MAX),
                    ),
                )
                .col_expr(
                    billing_payments::Column::UpdatedAt,
                    Expr::current_timestamp(),
                )
                .filter(billing_payments::Column::Id.eq(&row_id))
                .exec(&db)
                .await?;
            record_success(&db, &entry).await?;
            tx.commit().await?;
            Ok(format!(
                "Refund {} ({}) started for {} cents of {payment_id}. Make the credit note in WeldBooks, in the issuer workspace.\n",
                refund.id, refund.status, amount
            ))
        }
        BillingCommand::RetryNow { workspace } => {
            let found = find_workspace(master, workspace).await?;
            let open: Option<Option<String>> = billing_accounts::Entity::find()
                .select_only()
                .column(billing_accounts::Column::PastDuePaymentId)
                .filter(billing_accounts::Column::WorkspaceId.eq(&found.id))
                .into_tuple()
                .one(&orm(master))
                .await?;
            let Some(open) = open.flatten() else {
                return Err(StaffError::Refused(format!(
                    "{} has nothing past due.",
                    found.name
                )));
            };
            if dry_run {
                return Ok(format!("Would charge {open} again for {}.\n", found.name));
            }
            let entry = AuditEntry {
                workspace_id: Some(&found.id),
                target_type: "workspace",
                target_id: &found.id,
                action: "workspace.billing.retry",
                actor_email: &actor.email,
                reason: Some(reason),
                details: Some(json!({ "charge": open })),
            };
            let state = billing(master)?;
            let accepted =
                weldsuite_core_billing::renewals::retry_open_charge(&state, &found.id, &open, now)
                    .await
                    .map_err(|error| StaffError::Refused(format!("{error:?}")))?;
            record_success(&orm(master), &entry).await?;
            Ok(if accepted {
                format!(
                    "Mollie took the charge for {} on; the webhook settles it.\n",
                    found.name
                )
            } else {
                format!(
                    "The mandate of {} was refused again; it stays past due.\n",
                    found.name
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(
        action: &str,
        target: Option<&str>,
        flags: &[(&str, &str)],
    ) -> Result<BillingCommand, String> {
        let mut flags: Vec<(String, String)> = flags
            .iter()
            .map(|(f, v)| ((*f).to_owned(), (*v).to_owned()))
            .collect();
        let mut take = |flag: &str| {
            flags
                .iter()
                .position(|(f, _)| f == flag)
                .map(|index| flags.remove(index).1)
        };
        BillingCommand::parse(Some(action), target, &mut take)
    }

    #[test]
    fn parses_the_billing_actions() {
        assert_eq!(
            parse("show", Some("acme"), &[]),
            Ok(BillingCommand::Show {
                workspace: "acme".to_owned()
            })
        );
        assert_eq!(
            parse(
                "comp",
                Some("acme"),
                &[
                    ("--plan", "business"),
                    ("--seats", "10"),
                    ("--until", "2027-06-30")
                ]
            ),
            Ok(BillingCommand::Comp {
                workspace: "acme".to_owned(),
                plan: Some("business".to_owned()),
                seats: Some(10),
                until: Some("2027-06-30".to_owned()),
            })
        );
        assert!(parse("comp", Some("acme"), &[("--until", "next week")]).is_err());
        assert_eq!(
            parse("comp", Some("acme"), &[("--until", "none")]),
            Ok(BillingCommand::Comp {
                workspace: "acme".to_owned(),
                plan: None,
                seats: None,
                until: None
            })
        );
        assert_eq!(
            parse("refund", Some("tr_abc"), &[("--amount", "500")]),
            Ok(BillingCommand::Refund {
                charge: "tr_abc".to_owned(),
                amount: Some(500)
            })
        );
        assert!(parse("refund", Some("tr_abc"), &[("--amount", "0")]).is_err());
        assert!(parse("refund", None, &[]).is_err());
        assert!(parse("cancel", Some("acme"), &[]).is_err());
        assert!(
            !BillingCommand::Show {
                workspace: String::new()
            }
            .writes()
        );
        assert!(
            BillingCommand::RetryNow {
                workspace: String::new()
            }
            .writes()
        );
    }
}
