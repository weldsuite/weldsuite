//! WeldReach inboxes on the plan's charge (ADR BILL-014): €8.00 each per
//! month, before VAT. Only a workspace with a paid plan on Mollie has them:
//!
//! - **On each anchor** the renewal job bills every live inbox for the coming
//!   month ([`inbox_line`], through the binary's [`crate::AddonSource`]), the
//!   plan's yearly months included.
//! - **An inbox added between anchors** is charged at once on the mandate for
//!   the rest of the month, today included ([`charge_inbox_added`]). A slot
//!   already paid this month is reused: delete an inbox and add another, and
//!   nothing more is charged before the anchor.
//! - **A deleted inbox** isn't refunded; the next anchor bills one fewer, as
//!   fewer seats do.
//!
//! A comped or partner-billed workspace isn't charged for inboxes; one on the
//! Free plan is refused (402 `PAID_PLAN_REQUIRED`).

use http::StatusCode;
use time::OffsetDateTime;
use weldsuite_kit::ApiError;
use weldsuite_mollie::PaymentStatus;

use crate::account::Account;
use crate::engine::{http_of, mark_applied, recurring_payment, unreachable};
use crate::lines::{Charge, Line, LineKind};
use crate::period::{add_months_on_anchor, iso, parse_iso, prorate};
use crate::plans::CURRENCY;
use crate::store::{ChargeMeta, ChargeRow, Purpose, status_of};
use crate::workspace::Workspace;
use crate::{BillingError, BillingResult, BillingState, Language, buyer};

/// `Line.addon` of an inbox line.
pub const WELDREACH_INBOX: &str = "weldreach_inbox";

/// €8.00 per inbox per month, before VAT (owner decision 2026-11-14; Global
/// charges $8.00 through Stripe).
pub const WELDREACH_INBOX_CENTS: i64 = 800;

/// `WeldReach inboxes`.
pub fn inbox_description(language: Language) -> &'static str {
    match language {
        Language::Nl => "WeldReach-inboxen",
        Language::En => "WeldReach inboxes",
    }
}

/// The renewal's line for `count` inboxes over `period` (anchor to anchor).
pub fn inbox_line(
    count: i64,
    period: (OffsetDateTime, OffsetDateTime),
    language: Language,
) -> Line {
    Line {
        kind: LineKind::Addon,
        description: inbox_description(language).to_owned(),
        quantity: count,
        unit_amount: WELDREACH_INBOX_CENTS,
        amount: count * WELDREACH_INBOX_CENTS,
        period_start: Some(iso(period.0)),
        period_end: Some(iso(period.1)),
        plan_id: None,
        addon: Some(WELDREACH_INBOX.to_owned()),
    }
}

/// What adding an inbox did to the bill.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboxCharge {
    /// Charged for the rest of the month, on this charge row.
    Charged { charge_id: String },
    /// This month already pays for it (a slot freed by a deleted inbox).
    Covered,
    /// Comped, or billed by a partner: inboxes aren't charged.
    NotBilled,
}

/// What `GET /api/reach/billing/status` says about inbox billing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxBilling {
    /// `none` (no paid plan), `active` or `past_due`.
    pub status: &'static str,
    pub has_payment_method: bool,
    /// The next anchor, when the inboxes are next billed.
    pub period_end: Option<String>,
}

fn paid_plan_required() -> BillingError {
    ApiError::new(
        StatusCode::PAYMENT_REQUIRED,
        "PAID_PLAN_REQUIRED",
        "Inboxes are billed with your plan. Subscribe to a paid plan to add one.",
    )
    .into()
}

/// The workspace's running Mollie subscription, or why it has none.
async fn running(
    state: &BillingState,
    workspace_id: &str,
    now: OffsetDateTime,
) -> BillingResult<(Workspace, Option<Account>)> {
    let Some(workspace) = Workspace::load(&state.master, workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    let account = Account::load(&state.master, &workspace.id)
        .await?
        .filter(|a| a.next_charge_at.is_some() && workspace.has_running_subscription(now));
    Ok((workspace, account))
}

/// Inbox billing at a glance, for the WeldReach settings.
pub async fn inbox_billing(
    state: &BillingState,
    workspace_id: &str,
    now: OffsetDateTime,
) -> BillingResult<InboxBilling> {
    let (workspace, account) = running(state, workspace_id, now).await?;
    let free = workspace.is_partner() || workspace.comp_active(now);
    Ok(match account {
        Some(account) => InboxBilling {
            status: if account.past_due_payment_id.is_some() {
                "past_due"
            } else {
                "active"
            },
            has_payment_method: account.can_charge(),
            period_end: account.next_charge().map(iso),
        },
        None => InboxBilling {
            status: if free { "active" } else { "none" },
            has_payment_method: false,
            period_end: None,
        },
    })
}

/// Inboxes already paid for the month ending at `end`: the renewal's line and
/// the charges for inboxes added since, paid or under way.
async fn paid_inboxes(
    state: &BillingState,
    workspace_id: &str,
    end: OffsetDateTime,
) -> BillingResult<i64> {
    let rows: Vec<serde_json::Value> = sqlx::query_scalar(
        "select metadata from billing_payments
         where workspace_id = $1 and provider = 'mollie'
           and status in ('succeeded', 'processing') and metadata is not null
           and created_at > $2::timestamp - interval '45 days'",
    )
    .bind(workspace_id)
    .bind(iso(end))
    .fetch_all(&state.master)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|metadata| serde_json::from_value::<ChargeMeta>(metadata).ok())
        .flat_map(|meta| meta.charge.lines)
        .filter(|line| {
            line.addon.as_deref() == Some(WELDREACH_INBOX)
                && line.period_end.as_deref().and_then(parse_iso) == Some(end)
        })
        .map(|line| line.quantity)
        .sum())
}

/// An inbox is being added, `inboxes_after` live inboxes with it: charges
/// what this month doesn't pay for yet, for the rest of the month. `Err`
/// refuses the inbox (no paid plan, no payment method, a charge outstanding,
/// the mandate refused).
pub async fn charge_inbox_added(
    state: &BillingState,
    workspace_id: &str,
    user_id: Option<&str>,
    mailbox_id: &str,
    inboxes_after: i64,
    now: OffsetDateTime,
) -> BillingResult<InboxCharge> {
    let (workspace, account) = running(state, workspace_id, now).await?;
    if workspace.is_partner() || workspace.comp_active(now) {
        return Ok(InboxCharge::NotBilled);
    }
    let Some(account) = account else {
        return Err(paid_plan_required());
    };
    if account.past_due_payment_id.is_some() {
        return Err(ApiError::new(
            StatusCode::PAYMENT_REQUIRED,
            "PAYMENT_OUTSTANDING",
            "A payment is outstanding. Pay it on the billing page, then add the inbox.",
        )
        .into());
    }
    if !account.can_charge() {
        return Err(ApiError::new(
            StatusCode::PAYMENT_REQUIRED,
            "PAYMENT_METHOD_REQUIRED",
            "A payment method is required before adding inboxes",
        )
        .into());
    }
    let Some(end) = account.next_charge() else {
        return Err(paid_plan_required());
    };
    let start = add_months_on_anchor(end, -1, account.anchor());
    let extra = inboxes_after - paid_inboxes(state, &workspace.id, end).await?;
    let per_inbox = prorate(WELDREACH_INBOX_CENTS, start, end, now);
    if extra <= 0 || per_inbox <= 0 {
        return Ok(InboxCharge::Covered);
    }
    let Some(details) = crate::renewals::details_for(state, &workspace).await? else {
        return Err(buyer::details_required(&[
            "legalName",
            "addressLine1",
            "postalCode",
            "city",
            "country",
        ])
        .into());
    };
    let http = http_of(state, None)?;
    let vat = buyer::vat_for(Some(&http), &state.settings.seller_country, &details).await;
    let language = details.language();
    let description = match language {
        Language::Nl => "WeldReach-inbox, rest van de maand",
        Language::En => "WeldReach inbox, rest of the month",
    };
    let charge = Charge::new(
        CURRENCY,
        vec![Line {
            kind: LineKind::Addon,
            description: description.to_owned(),
            quantity: extra,
            unit_amount: per_inbox,
            amount: extra * per_inbox,
            period_start: Some(iso(now)),
            period_end: Some(iso(end)),
            plan_id: None,
            addon: Some(WELDREACH_INBOX.to_owned()),
        }],
        vat,
    );
    let meta = ChargeMeta {
        purpose: Purpose::Addon,
        charge: charge.clone(),
        plan_id: None,
        seats: None,
        cycle: None,
        unit_amount: Some(WELDREACH_INBOX_CENTS),
        period_start: Some(iso(now)),
        period_end: Some(iso(end)),
        settles: None,
        user_id: user_id.map(str::to_owned),
        language: Some(language.as_str().to_owned()),
        customer: Some(details),
        applied: None,
        charged_back: None,
        credits: None,
        package_id: None,
    };
    // One row per inbox: a retry of the same create reuses its payment.
    let row = ChargeRow::create(
        &state.master,
        &workspace.id,
        &format!("addon:{}:{WELDREACH_INBOX}:{mailbox_id}", workspace.id),
        &meta,
    )
    .await?;
    if row.provider_payment_id.is_none() {
        collect(state, &http, &account, &row, &charge, now).await?;
        tracing::info!(workspace = %workspace.id, row = %row.id, extra, per_inbox, "billing: inbox charged for the rest of the month");
    }
    Ok(InboxCharge::Charged { charge_id: row.id })
}

/// Charges `row` on the mandate. The inbox is granted once Mollie accepts
/// the payment; a refusal, or a payment failed at once, refuses it.
async fn collect(
    state: &BillingState,
    http: &weldsuite_ports::OutboundHttp,
    account: &Account,
    row: &ChargeRow,
    charge: &Charge,
    now: OffsetDateTime,
) -> BillingResult<()> {
    let payment = match recurring_payment(state, &state.master, http, account, row, charge).await {
        Ok(payment) => payment,
        Err(error) if error.is_refusal() => {
            tracing::warn!(%error, workspace = %row.workspace_id, "billing: mandate refused an inbox charge");
            return Err(payment_refused());
        }
        Err(error) => return Err(unreachable(error)),
    };
    if !payment.status.is_accepted() {
        // Failed at once: recorded, and the inbox isn't added.
        crate::settle::settle_payment(state, &payment, now).await?;
        return Err(payment_refused());
    }
    // Granted now: a later failure (SEPA) makes the account past due.
    let mut tx = state.master.begin().await?;
    mark_applied(&mut tx, &row.id).await?;
    if payment.status != PaymentStatus::Paid {
        ChargeRow::record(
            &mut tx,
            &row.id,
            status_of(&payment.status),
            &payment.details,
            None,
            None,
            0,
        )
        .await?;
    }
    tx.commit().await?;
    if payment.status == PaymentStatus::Paid {
        crate::settle::settle_payment(state, &payment, now).await?;
    }
    Ok(())
}

fn payment_refused() -> BillingError {
    ApiError::new(
        StatusCode::PAYMENT_REQUIRED,
        "PAYMENT_FAILED",
        "Your payment method was refused. Update it on the billing page, then add the inbox.",
    )
    .into()
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn an_anchor_bills_every_inbox_for_the_month() {
        let line = inbox_line(
            3,
            (
                datetime!(2026-11-14 10:00 UTC),
                datetime!(2026-12-14 10:00 UTC),
            ),
            Language::Nl,
        );
        assert_eq!(line.kind, LineKind::Addon);
        assert_eq!(
            (line.quantity, line.unit_amount, line.amount),
            (3, 800, 2400)
        );
        assert_eq!(line.description, "WeldReach-inboxen");
        assert_eq!(line.addon.as_deref(), Some(WELDREACH_INBOX));
        assert_eq!(
            line.period_end.as_deref().and_then(parse_iso),
            Some(datetime!(2026-12-14 10:00 UTC))
        );
        assert_eq!(inbox_description(Language::En), "WeldReach inboxes");
    }

    #[test]
    fn an_inbox_added_mid_month_pays_the_days_left() {
        // Day 11 of a 30-day month: 20 of 30 days, €5.33.
        let start = datetime!(2026-11-14 10:00 UTC);
        let end = datetime!(2026-12-14 10:00 UTC);
        assert_eq!(
            prorate(
                WELDREACH_INBOX_CENTS,
                start,
                end,
                datetime!(2026-11-24 09:00 UTC)
            ),
            533
        );
        // On the anchor's own day: the whole month; the last day: one day.
        assert_eq!(prorate(WELDREACH_INBOX_CENTS, start, end, start), 800);
        assert_eq!(
            prorate(
                WELDREACH_INBOX_CENTS,
                start,
                end,
                datetime!(2026-12-13 12:00 UTC)
            ),
            27
        );
    }
}
