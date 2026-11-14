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

use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
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
    let state: Option<Value> = sqlx::query_scalar(
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
    .await?;
    state.ok_or_else(|| StaffError::Refused("No such workspace.".to_owned()))
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
    let iso = |at: OffsetDateTime| weldsuite_events::iso_timestamp(at);
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
                    sqlx::query_scalar(
                        "select id from plans where (id = $1 or slug = $1) and deleted_at is null limit 1",
                    )
                    .bind(plan)
                    .fetch_optional(master)
                    .await?
                    .ok_or_else(|| StaffError::Refused(format!("No plan \"{plan}\".")))?,
                ),
                None => None,
            };
            // A workspace paying through Mollie keeps its paid plan under a
            // comp (the renewal job then charges nothing until it ends), so
            // the comp can't change plan or seats: uncomp would resume billing
            // the comped plan at the paid plan's seat price.
            let paying: bool = sqlx::query_scalar(
                "select exists (select 1 from billing_accounts
                                where workspace_id = $1 and next_charge_at is not null)",
            )
            .bind(&found.id)
            .fetch_one(master)
            .await?;
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
            sqlx::query(
                "update workspaces set comp_granted_at = $2::timestamp, comp_ends_at = $3::timestamp,
                     comp_granted_by = $4, comp_reason = $5,
                     plan_id = coalesce($6, plan_id),
                     purchased_seats = coalesce($7, purchased_seats),
                     subscription_status = case when $6::text is null then subscription_status else 'active' end,
                     updated_at = now()
                 where id = $1",
            )
            .bind(&found.id)
            .bind(iso(now))
            .bind(ends.as_deref())
            .bind(&actor.email)
            .bind(reason)
            .bind(plan_id.as_deref())
            .bind(seats.map(|n| i32::try_from(n).unwrap_or(i32::MAX)))
            .execute(&mut *tx)
            .await?;
            // A comped workspace's inboxes run, unbilled: resume any a past
            // plan's end paused.
            weldsuite_core_billing::addons::resume_inboxes(&mut tx, &found.id).await?;
            // A comp pays what is open: nothing stays past due under it.
            sqlx::query(
                "update billing_accounts set past_due_since = null, past_due_payment_id = null,
                     dunning_reminded_at = null, updated_at = now()
                 where workspace_id = $1",
            )
            .bind(&found.id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "update workspaces set subscription_status = 'active', updated_at = now()
                 where id = $1 and subscription_status = 'past_due'",
            )
            .bind(&found.id)
            .execute(&mut *tx)
            .await?;
            record_success(&mut *tx, &entry).await?;
            tx.commit().await?;
            Ok(format!("Comped {} ({}): {details}\n", found.name, found.id))
        }
        BillingCommand::Uncomp { workspace } => {
            let found = find_workspace(master, workspace).await?;
            let comped: bool = sqlx::query_scalar(
                "select comp_granted_at is not null from workspaces where id = $1",
            )
            .bind(&found.id)
            .fetch_one(master)
            .await?;
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
            let paying: bool = sqlx::query_scalar(
                "select exists (select 1 from billing_accounts
                                where workspace_id = $1 and next_charge_at is not null)",
            )
            .bind(&found.id)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query(
                "update workspaces set comp_granted_at = null, comp_ends_at = null,
                     comp_granted_by = null, comp_reason = null, updated_at = now()
                 where id = $1",
            )
            .bind(&found.id)
            .execute(&mut *tx)
            .await?;
            record_success(&mut *tx, &entry).await?;
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
                sqlx::query(
                        "update workspaces set plan_id = (select id from plans where slug = 'free' limit 1),
                             purchased_seats = 0, subscription_status = 'canceled', updated_at = now()
                         where id = $1",
                    )
                    .bind(&found.id)
                    .execute(master)
                    .await?;
                Ok(format!(
                    "Ended the comp of {}; it is on Free now.\n",
                    found.name
                ))
            }
        }
        BillingCommand::Refund { charge, amount } => {
            let row: Option<ChargeRow> =
                sqlx::query_as(
                    "select id, workspace_id, provider_payment_id, amount, currency, refunded_amount, status
                     from billing_payments
                     where provider = 'mollie' and (id = $1 or provider_payment_id = $1) limit 1",
                )
                .bind(charge)
                .fetch_optional(master)
                .await?;
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
            sqlx::query(
                "update billing_payments set refunded_amount = refunded_amount + $2, updated_at = now() where id = $1",
            )
            .bind(&row_id)
            .bind(i32::try_from(amount).unwrap_or(i32::MAX))
            .execute(&mut *tx)
            .await?;
            record_success(&mut *tx, &entry).await?;
            tx.commit().await?;
            Ok(format!(
                "Refund {} ({}) started for {} cents of {payment_id}. Make the credit note in WeldBooks, in the issuer workspace.\n",
                refund.id, refund.status, amount
            ))
        }
        BillingCommand::RetryNow { workspace } => {
            let found = find_workspace(master, workspace).await?;
            let open: Option<Option<String>> = sqlx::query_scalar(
                "select past_due_payment_id from billing_accounts where workspace_id = $1",
            )
            .bind(&found.id)
            .fetch_optional(master)
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
            record_success(master, &entry).await?;
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
