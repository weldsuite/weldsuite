//! `weldsuite cron billing-renewals` (hourly, ADR BILL-014): WeldSuite's own
//! scheduler for plan billing. Each run:
//!
//! 1. ends comps whose `comp_ends_at` passed (BILL-011) and plans past due
//!    beyond the grace period (Free, and an email);
//! 2. reminds billing owners halfway through the grace period;
//! 3. charges every account whose anchor (`next_charge_at`) has come: the
//!    plan when its period ends (after the change scheduled for then, or the
//!    end of a cancelled plan), the monthly add-ons always, and grants the
//!    plan's monthly credits. Accounts are claimed one at a time with
//!    `FOR UPDATE SKIP LOCKED`, and a renewal's charge row is keyed on
//!    (workspace, anchor), so overlapping runs never charge twice. The period
//!    moves forward when the charge is made; a refusal makes the account past
//!    due, and the plan keeps working through the grace period;
//! 4. emails the invoices whose email is still due (no mailer when they were
//!    issued, or nobody took it), then issues the invoices of paid charges
//!    the issuer couldn't take earlier, emailing each as it is issued.

use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Expr, LockBehavior, LockType, Query};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{OrmConn, PgPool, orm, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_mollie::PaymentStatus;
use weldsuite_schema::master::{billing_accounts, billing_payments, workspaces};

use crate::account::{self, Account};
use crate::buyer::{self, BillingDetails};
use crate::engine::{self, plan_line, recurring_payment};
use crate::lines::Charge;
use crate::notify::BillingMailKind;
use crate::period::{add_months_on_anchor, anchor_on_or_before, iso};
use crate::plans::{CURRENCY, Plan};
use crate::settle::{self, go_past_due};
use crate::store::{ChargeMeta, ChargeRow, Purpose, status_of};
use crate::workspace::Workspace;
use crate::{BillingError, BillingResult, BillingState, credits, seats};

/// At most this many anchors per run; the rest wait for the next hour.
const BATCH: usize = 200;

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RenewalReport {
    pub charged: usize,
    pub credited_only: usize,
    pub ended: usize,
    pub past_due: usize,
    pub reminded: usize,
    pub comps_ended: usize,
    pub invoices_issued: usize,
    pub invoices_mailed: usize,
    pub failed: usize,
}

impl RenewalReport {
    pub fn to_json(&self) -> Value {
        json!({
            "charged": self.charged,
            "creditedOnly": self.credited_only,
            "ended": self.ended,
            "pastDue": self.past_due,
            "reminded": self.reminded,
            "compsEnded": self.comps_ended,
            "invoicesIssued": self.invoices_issued,
            "invoicesMailed": self.invoices_mailed,
            "failed": self.failed,
        })
    }
}

/// One run at `now`.
pub async fn run_renewals(state: &BillingState, now: OffsetDateTime) -> RenewalReport {
    let mut report = RenewalReport::default();
    if let Err(error) = end_comps(state, now, &mut report).await {
        tracing::error!(?error, "billing-renewals: comps not swept");
        report.failed += 1;
    }
    if let Err(error) = sweep_past_due(state, now, &mut report).await {
        tracing::error!(?error, "billing-renewals: past-due accounts not swept");
        report.failed += 1;
    }
    if let Err(error) = resend_unsent(state, now, &mut report).await {
        tracing::error!(?error, "billing-renewals: unsent renewals not resent");
        report.failed += 1;
    }
    for _ in 0..BATCH {
        match renew_next(state, now).await {
            Ok(Some(outcome)) => match outcome {
                Outcome::Charged => report.charged += 1,
                Outcome::CreditedOnly => report.credited_only += 1,
                Outcome::Ended => report.ended += 1,
                Outcome::PastDue => {
                    report.charged += 1;
                    report.past_due += 1;
                }
                Outcome::Skipped => {}
            },
            Ok(None) => break,
            Err(error) => {
                tracing::error!(?error, "billing-renewals: an anchor failed");
                report.failed += 1;
                break;
            }
        }
    }
    // Before the invoices below, so one whose email nobody takes now waits
    // an hour instead of being tried again at once.
    if state.mailer.is_some() {
        match ChargeRow::invoice_mail_due(&state.master, 50).await {
            Ok(ids) => {
                for id in ids {
                    if settle::mail_invoice(state, &id).await {
                        report.invoices_mailed += 1;
                    }
                }
            }
            Err(error) => {
                tracing::error!(%error, "billing-renewals: unsent invoice emails unreadable");
                report.failed += 1;
            }
        }
    }
    match ChargeRow::paid_without_invoice(&state.master, 50).await {
        Ok(rows) => {
            for row in rows {
                settle::issue_invoice(state, &row).await;
                if let Ok(Some(row)) = ChargeRow::load(&state.master, &row.id).await
                    && row.invoice_id.is_some()
                {
                    report.invoices_issued += 1;
                    if row.invoice_mail() == Some("sent") {
                        report.invoices_mailed += 1;
                    }
                }
            }
        }
        Err(error) => {
            tracing::error!(%error, "billing-renewals: uninvoiced charges unreadable");
            report.failed += 1;
        }
    }
    report
}

/// BILL-011: a comp whose end passed is cleared; without a paid
/// subscription under it, the plan ends.
async fn end_comps(
    state: &BillingState,
    now: OffsetDateTime,
    report: &mut RenewalReport,
) -> BillingResult<()> {
    let ended = clear_ended_comps(&state.master, now).await?;
    for (workspace_id, paying) in ended {
        report.comps_ended += 1;
        if !paying {
            engine::end_subscription(state, &state.master, &workspace_id, now).await?;
        }
    }
    Ok(())
}

/// Clears every comp whose `comp_ends_at` passed, in one statement, and
/// says for each workspace whether a paid subscription runs under it (a
/// `billing_accounts` row with a next charge).
async fn clear_ended_comps(
    master: &PgPool,
    now: OffsetDateTime,
) -> Result<Vec<(String, bool)>, DbErr> {
    use workspaces::Column as W;
    let paying = Query::select()
        .column((billing_accounts::Entity, billing_accounts::Column::Id))
        .from(billing_accounts::Entity)
        .and_where(sea_orm::ExprTrait::equals(
            Expr::col((
                billing_accounts::Entity,
                billing_accounts::Column::WorkspaceId,
            )),
            (workspaces::Entity, W::Id),
        ))
        .and_where(billing_accounts::Column::NextChargeAt.is_not_null())
        .to_owned();
    let update = Query::update()
        .table(workspaces::Entity)
        .value(W::CompGrantedAt, Expr::null())
        .value(W::CompEndsAt, Expr::null())
        .value(W::CompGrantedBy, Expr::null())
        .value(W::CompReason, Expr::null())
        .value(W::UpdatedAt, Expr::current_timestamp())
        .and_where(W::CompGrantedAt.is_not_null())
        .and_where(W::CompEndsAt.is_not_null())
        .and_where(W::CompEndsAt.lte(utc_timestamp(now)))
        .returning(
            Query::returning()
                .exprs([Expr::col((workspaces::Entity, W::Id)), Expr::exists(paying)]),
        )
        .to_owned();
    orm(master)
        .query_all(&update)
        .await?
        .iter()
        .map(|row| Ok((row.try_get_by_index(0)?, row.try_get_by_index(1)?)))
        .collect()
}

/// Past due beyond the grace period: the plan ends. Halfway: a reminder.
async fn sweep_past_due(
    state: &BillingState,
    now: OffsetDateTime,
    report: &mut RenewalReport,
) -> BillingResult<()> {
    let grace = time::Duration::days(state.settings.grace_days);
    // `exists (select 1 from workspaces w where w.id = a.workspace_id and
    // w.comp_granted_at is not null and (w.comp_ends_at is null or
    // w.comp_ends_at > now))`: a comp in force pays what is open.
    let comped = Query::select()
        .column((workspaces::Entity, workspaces::Column::Id))
        .from(workspaces::Entity)
        .cond_where(
            Condition::all()
                .add(sea_orm::ExprTrait::equals(
                    Expr::col((workspaces::Entity, workspaces::Column::Id)),
                    (
                        billing_accounts::Entity,
                        billing_accounts::Column::WorkspaceId,
                    ),
                ))
                .add(workspaces::Column::CompGrantedAt.is_not_null())
                .add(
                    Condition::any()
                        .add(workspaces::Column::CompEndsAt.is_null())
                        .add(workspaces::Column::CompEndsAt.gt(utc_timestamp(now))),
                ),
        )
        .to_owned();
    let expired: Vec<(String, Option<String>)> = billing_accounts::Entity::find()
        .select_only()
        .columns([
            billing_accounts::Column::WorkspaceId,
            billing_accounts::Column::PastDuePaymentId,
        ])
        .filter(billing_accounts::Column::PastDueSince.is_not_null())
        .filter(billing_accounts::Column::PastDueSince.lte(utc_timestamp(now - grace)))
        .filter(Expr::not_exists(comped))
        .into_tuple()
        .all(&orm(&state.master))
        .await?;
    for (workspace_id, open) in expired {
        engine::end_subscription(state, &state.master, &workspace_id, now).await?;
        report.ended += 1;
        if let Some(open) = open {
            let _ =
                settle::mail(state, &workspace_id, &open, BillingMailKind::PlanEnded, now).await;
        }
    }
    let due: Vec<(String, String)> = billing_accounts::Entity::update_many()
        .col_expr(
            billing_accounts::Column::DunningRemindedAt,
            Expr::value(utc_timestamp(now)),
        )
        .col_expr(
            billing_accounts::Column::UpdatedAt,
            Expr::current_timestamp(),
        )
        .filter(billing_accounts::Column::PastDueSince.is_not_null())
        .filter(billing_accounts::Column::PastDuePaymentId.is_not_null())
        .filter(billing_accounts::Column::DunningRemindedAt.is_null())
        .filter(billing_accounts::Column::PastDueSince.lte(utc_timestamp(now - grace / 2)))
        .exec_with_returning(&orm(&state.master))
        .await?
        .into_iter()
        .filter_map(|account| Some((account.workspace_id, account.past_due_payment_id?)))
        .collect();
    for (workspace_id, open) in due {
        let _ = settle::mail(
            state,
            &workspace_id,
            &open,
            BillingMailKind::PaymentReminder,
            now,
        )
        .await;
        report.reminded += 1;
    }
    Ok(())
}

/// What one anchor came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Charged,
    CreditedOnly,
    Ended,
    PastDue,
    Skipped,
}

/// The billing details of `workspace`: its current ones, else those of its
/// last charge.
pub(crate) async fn details_for(
    state: &BillingState,
    workspace: &Workspace,
) -> BillingResult<Option<BillingDetails>> {
    if let Some(tenants) = &state.tenants {
        match tenants(workspace.id.clone()).await {
            Ok(tenant) => {
                if let Ok(details) = buyer::load(&tenant, &workspace.name).await? {
                    return Ok(Some(details));
                }
            }
            Err(error) => {
                tracing::warn!(%error, workspace = %workspace.id, "billing-renewals: tenant unreachable, using the last details");
            }
        }
    }
    // `metadata ? 'customer'` on the object: the key is there.
    let customer =
        || pg::PgExpr::get_json_field(Expr::col(billing_payments::Column::Metadata), "customer");
    let last: Option<Value> = billing_payments::Entity::find()
        .select_only()
        .column_as(customer(), "customer")
        .filter(billing_payments::Column::WorkspaceId.eq(&workspace.id))
        .filter(billing_payments::Column::Provider.eq("mollie"))
        .filter(sea_orm::ExprTrait::is_not_null(customer()))
        .order_by_desc(billing_payments::Column::CreatedAt)
        .into_tuple()
        .one(&orm(&state.master))
        .await?;
    Ok(last.and_then(|value| serde_json::from_value(value).ok()))
}

/// `select workspace_id from billing_accounts where next_charge_at <= now
/// order by next_charge_at limit 1 for update skip locked`: the next due
/// account, claimed for the rest of `tx`.
async fn claim_due(
    tx: &impl ConnectionTrait,
    now: OffsetDateTime,
) -> Result<Option<String>, DbErr> {
    billing_accounts::Entity::find()
        .select_only()
        .column(billing_accounts::Column::WorkspaceId)
        .filter(billing_accounts::Column::NextChargeAt.is_not_null())
        .filter(billing_accounts::Column::NextChargeAt.lte(utc_timestamp(now)))
        .order_by_asc(billing_accounts::Column::NextChargeAt)
        .lock_with_behavior(LockType::Update, LockBehavior::SkipLocked)
        .into_tuple()
        .one(tx)
        .await
}

/// Claims the next due account and renews it. `None`: nothing due.
#[allow(clippy::too_many_lines)] // one anchor, one place
async fn renew_next(state: &BillingState, now: OffsetDateTime) -> BillingResult<Option<Outcome>> {
    let master = &state.master;
    let mut tx = master.begin().await?;
    let workspace_id = claim_due(&OrmConn::new(&mut tx), now).await?;
    let Some(workspace_id) = workspace_id else {
        return Ok(None);
    };
    let Some(account) = Account::lock(&OrmConn::new(&mut tx), &workspace_id).await? else {
        return Ok(Some(Outcome::Skipped));
    };
    let Some(anchor_at) = account.next_charge() else {
        return Ok(Some(Outcome::Skipped));
    };
    let anchor = account.anchor();
    let Some(workspace) = Workspace::lock(&OrmConn::new(&mut tx), &workspace_id).await? else {
        account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, None).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    };
    let running = crate::workspace::RUNNING_STATUSES
        .contains(&workspace.subscription_status.as_deref().unwrap_or_default());
    if !running {
        account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, None).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    }
    // The anchor on the period's grid this run bills, and the one after it,
    // taken from the period, never from when the run happened: a late run,
    // or one put off a day at a time, stays on the anchor day.
    let (due, next_anchor) = match workspace.period() {
        Some((_, end)) => {
            let due = anchor_on_or_before(end, anchor_at, anchor);
            (due, add_months_on_anchor(due, 1, anchor))
        }
        None => (anchor_at, add_months_on_anchor(anchor_at, 1, anchor)),
    };
    let current_plan = match &workspace.plan_id {
        Some(id) => Plan::load(master, id).await?,
        None => None,
    };
    let plan_credits =
        |plan: Option<&Plan>| plan.and_then(|p| p.monthly_credits).map_or(0, i64::from);

    // A comp pays the plan: no charge, credits still come.
    if workspace.comp_active(now) {
        credits::grant_monthly(
            &OrmConn::new(&mut tx),
            &workspace_id,
            plan_credits(current_plan.as_ref()),
            due,
            next_anchor,
        )
        .await?;
        // The comp covers the period that ends on this anchor: move it on
        // the grid as a paid renewal would, so the subscription keeps
        // running through the comp and the first charge after it bills the
        // period that starts then, not one the comp already covered.
        if let Some((_, end)) = workspace.period()
            && end <= anchor_at + time::Duration::minutes(1)
        {
            let renewed = add_months_on_anchor(end, workspace.cycle().months(), anchor);
            workspaces::Entity::update_many()
                .col_expr(
                    workspaces::Column::SubscriptionCurrentPeriodStart,
                    Expr::value(utc_timestamp(end)),
                )
                .col_expr(
                    workspaces::Column::SubscriptionCurrentPeriodEnd,
                    Expr::value(utc_timestamp(renewed)),
                )
                .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                .filter(workspaces::Column::Id.eq(&workspace_id))
                .exec(&OrmConn::new(&mut tx))
                .await?;
        }
        account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, Some(next_anchor)).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::CreditedOnly));
    }
    // Past due: nothing new is charged until the open charge is paid or the
    // grace period ends the plan.
    if account.past_due_payment_id.is_some() {
        account::set_next_charge(
            &OrmConn::new(&mut tx),
            &workspace_id,
            Some(anchor_at + time::Duration::days(1)),
        )
        .await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    }
    let Some((_, period_end)) = workspace.period() else {
        account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, None).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    };
    let plan_due = period_end <= anchor_at + time::Duration::minutes(1);
    if plan_due && workspace.cancel_at_period_end {
        tx.commit().await?;
        engine::end_subscription(state, master, &workspace_id, now).await?;
        return Ok(Some(Outcome::Ended));
    }

    // What the next period bills: the scheduled change applies now.
    let scheduled = account.scheduled();
    let mut plan = current_plan.clone();
    let mut seats_count = i64::from(workspace.purchased_seats);
    let mut cycle = workspace.cycle();
    let mut unit = account.unit_amount.map(i64::from);
    if plan_due && let Some(change) = &scheduled {
        if let Some(plan_id) = &change.plan_id {
            plan = Plan::load(master, plan_id).await?;
            unit = None;
        }
        if let Some(seats) = change.seats {
            seats_count = seats;
        }
        if let Some(new_cycle) = change.cycle {
            if new_cycle != cycle {
                unit = None;
            }
            cycle = new_cycle;
        }
    }
    let Some(plan) = plan else {
        tracing::error!(workspace = %workspace_id, "billing-renewals: the plan is gone");
        account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, None).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    };
    let unit = unit.or_else(|| plan.unit_amount(cycle)).unwrap_or(0);
    let new_period = (
        period_end,
        add_months_on_anchor(period_end, cycle.months(), anchor),
    );

    let Some(details) = details_for(state, &workspace).await? else {
        tracing::error!(workspace = %workspace_id, "billing-renewals: no billing details to invoice, retried tomorrow");
        account::set_next_charge(
            &OrmConn::new(&mut tx),
            &workspace_id,
            Some(anchor_at + time::Duration::days(1)),
        )
        .await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Skipped));
    };
    let language = details.language();
    let mut lines = Vec::new();
    if plan_due && unit > 0 && seats_count > 0 {
        lines.push(plan_line(
            &plan,
            seats_count,
            cycle,
            unit,
            Some(new_period),
            language,
        ));
    }
    if let Some(addons) = &state.addons {
        match addons
            .lines(&workspace_id, (anchor_at, next_anchor), language)
            .await
        {
            Ok(mut extra) => lines.append(&mut extra),
            Err(error) => {
                tracing::warn!(%error, workspace = %workspace_id, "billing-renewals: add-ons unreadable");
            }
        }
    }

    // Advance first (in this transaction): plan, period and anchor.
    if plan_due {
        crate::workspace::set_subscription(
            &OrmConn::new(&mut tx),
            &workspace_id,
            &plan.id,
            seats_count,
            "active",
            cycle,
            new_period,
            now,
        )
        .await?;
        account::set_unit_amount(&OrmConn::new(&mut tx), &workspace_id, unit).await?;
        account::schedule(&OrmConn::new(&mut tx), &workspace_id, None).await?;
    }
    credits::grant_monthly(
        &OrmConn::new(&mut tx),
        &workspace_id,
        plan_credits(Some(&plan)),
        due,
        next_anchor,
    )
    .await?;
    account::set_next_charge(&OrmConn::new(&mut tx), &workspace_id, Some(next_anchor)).await?;

    if lines.is_empty() {
        tx.commit().await?;
        return Ok(Some(Outcome::CreditedOnly));
    }
    let http = state.http.clone();
    let vat = buyer::vat_for(http.as_ref(), &state.settings.seller_country, &details).await;
    let charge = Charge::new(CURRENCY, lines, vat);
    let meta = ChargeMeta {
        purpose: Purpose::Renewal,
        charge: charge.clone(),
        plan_id: Some(plan.id.clone()),
        seats: Some(seats_count),
        cycle: Some(cycle.as_str().to_owned()),
        unit_amount: Some(unit),
        period_start: Some(iso(due)),
        period_end: Some(iso(next_anchor)),
        settles: None,
        user_id: None,
        language: Some(language.as_str().to_owned()),
        customer: Some(details.clone()),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
    };
    // The charge row commits with the period it pays for: if Mollie can't
    // be reached, or this run stops before the call, `resend_unsent` sends it.
    let key = format!("renewal:{workspace_id}:{}", iso(due));
    let row = ChargeRow::create_in(&OrmConn::new(&mut tx), &workspace_id, &key, &meta).await?;
    tx.commit().await?;
    if plan_due
        && scheduled
            .as_ref()
            .is_some_and(|s| s.seats.is_some() || s.plan_id.is_some())
    {
        seats::write_cap(
            state.identity.as_ref(),
            workspace.organization(),
            seats::seat_cap(&plan, seats_count),
        )
        .await;
    }

    if row.provider_payment_id.is_some() {
        // Sent by an earlier run that stopped halfway: settle what Mollie has.
        if let Some(http) = &http {
            settle::refresh(state, http, &row, now).await?;
        }
        return Ok(Some(Outcome::Charged));
    }
    charge_row(state, &workspace_id, &row, &charge, now).await
}

/// Renewal rows that were written with their period but never reached
/// Mollie. Mollie keeps an idempotency key for an hour only, so before a row
/// is sent again its payment is looked for among the customer's payments (by
/// `metadata.paymentRowId`): a payment whose answer was lost is settled, not
/// charged a second time.
async fn resend_unsent(
    state: &BillingState,
    now: OffsetDateTime,
    report: &mut RenewalReport,
) -> BillingResult<()> {
    let master = &state.master;
    let Some(http) = state.http.clone() else {
        return Ok(());
    };
    let before = now - time::Duration::minutes(5);
    for row in ChargeRow::unsent_renewals(master, before, 50).await? {
        let Some(meta) = row.meta() else {
            continue;
        };
        let customer = Account::load(master, &row.workspace_id)
            .await?
            .and_then(|account| account.customer_id);
        if let Some(customer) = customer {
            let payments = state
                .mollie
                .customer_payments(&http, &customer)
                .await
                .map_err(|error| BillingError::internal("Failed to list Mollie payments", error))?;
            if let Some(payment) = payments.into_iter().find(|payment| {
                payment.metadata.get("paymentRowId").and_then(Value::as_str)
                    == Some(row.id.as_str())
            }) {
                ChargeRow::set_payment(master, &row.id, &payment.id).await?;
                settle::settle_payment(state, &payment, now).await?;
                report.charged += 1;
                continue;
            }
        }
        match charge_row(state, &row.workspace_id, &row, &meta.charge, now).await? {
            Some(Outcome::PastDue) => {
                report.charged += 1;
                report.past_due += 1;
            }
            Some(_) => report.charged += 1,
            None => {}
        }
    }
    Ok(())
}

/// Charges `row` on the mandate: accepted, or past due.
async fn charge_row(
    state: &BillingState,
    workspace_id: &str,
    row: &ChargeRow,
    charge: &Charge,
    now: OffsetDateTime,
) -> BillingResult<Option<Outcome>> {
    let master = &state.master;
    let account = Account::load(master, workspace_id).await?;
    let attempt = match (&state.http, &account) {
        (Some(http), Some(account)) if account.can_charge() => {
            Some(recurring_payment(state, master, http, account, row, charge).await)
        }
        _ => None,
    };
    let refused = match attempt {
        Some(Ok(payment)) if payment.status.is_accepted() => {
            if payment.status == PaymentStatus::Paid {
                // Settled here, invoice included.
                settle::settle_payment(state, &payment, now).await?;
            } else {
                let mut tx = master.begin().await?;
                ChargeRow::record(
                    &OrmConn::new(&mut tx),
                    &row.id,
                    status_of(&payment.status),
                    &payment.details,
                    None,
                    None,
                    0,
                )
                .await?;
                tx.commit().await?;
            }
            return Ok(Some(Outcome::Charged));
        }
        Some(Ok(payment)) => payment
            .failure_reason
            .unwrap_or_else(|| payment.status.as_str().to_owned()),
        Some(Err(error)) if error.is_refusal() => error.to_string(),
        Some(Err(error)) => {
            // Mollie unreachable: the row stays unsent, and the next run's
            // `resend_unsent` looks for its payment at Mollie, then sends it.
            return Err(BillingError::internal(
                "Failed to charge the renewal",
                error,
            ));
        }
        None => "no mandate to charge".to_owned(),
    };
    tracing::warn!(workspace = workspace_id, row = %row.id, reason = %refused, "billing-renewals: charge refused, past due");
    let mut tx = master.begin().await?;
    billing_payments::Entity::update_many()
        .col_expr(billing_payments::Column::Status, Expr::value("failed"))
        .col_expr(
            billing_payments::Column::FailureMessage,
            Expr::value(refused.clone()),
        )
        .col_expr(
            billing_payments::Column::UpdatedAt,
            Expr::current_timestamp(),
        )
        .filter(billing_payments::Column::Id.eq(&row.id))
        .exec(&OrmConn::new(&mut tx))
        .await?;
    go_past_due(&OrmConn::new(&mut tx), workspace_id, &row.id, now).await?;
    tx.commit().await?;
    settle::notify_failed(state, workspace_id, &row.id, now).await;
    Ok(Some(Outcome::PastDue))
}

/// Charges the open (past-due) charge again on the account's current
/// mandate: after a new payment method was saved, or from staff tools.
pub async fn retry_open_charge(
    state: &BillingState,
    workspace_id: &str,
    open_row_id: &str,
    _now: OffsetDateTime,
) -> BillingResult<bool> {
    let master = &state.master;
    let Some(open) = ChargeRow::load(master, open_row_id).await? else {
        return Ok(false);
    };
    let Some(open_meta) = open.meta() else {
        return Ok(false);
    };
    let meta = ChargeMeta {
        purpose: Purpose::PayLink,
        settles: Some(open.id.clone()),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
        ..open_meta.clone()
    };
    let row = ChargeRow::create(
        master,
        workspace_id,
        &format!("retry:{}:{}", open.id, generate_id("rty")),
        &meta,
    )
    .await?;
    let Some(account) = Account::load(master, workspace_id).await? else {
        return Ok(false);
    };
    let Some(http) = &state.http else {
        return Ok(false);
    };
    match recurring_payment(state, master, http, &account, &row, &open_meta.charge).await {
        // The webhook settles it (not here: settling a saved mandate is what
        // called this).
        Ok(payment) if payment.status.is_accepted() => Ok(true),
        Ok(_) => Ok(false),
        Err(error) if error.is_refusal() => Ok(false),
        Err(error) => Err(BillingError::internal("Failed to retry the charge", error)),
    }
}
