//! A paid plan without a payment method (ADR BILL-014; the Global retirement,
//! ADR OPS-025). Card mandates can't move from Stripe, so every paying
//! workspace that moves from Global arrives with its plan, seats and next
//! charge but no Mollie mandate. At its first renewal after the move it adds
//! one through Mollie:
//!
//! - **Before the renewal** (`BILLING_RENEWAL_NOTICE_DAYS`, 14): the billing
//!   owners get one email per renewal (the renewal job's
//!   `warn_without_payment_method`), and members who manage billing see a
//!   banner (`paymentMethodRequired` on `GET /api/billing/subscription`).
//! - **At the renewal** the charge is refused for want of a mandate: past
//!   due, with the grace period (`BILLING_GRACE_DAYS`); the failure email and
//!   its reminder ask for a payment method rather than say a payment was
//!   refused, and the banner stays until the grace period ends the plan.
//!
//! Saving a payment method ends both: a new mandate takes it out of this
//! check, and settling it charges a past-due renewal on it at once.

use time::OffsetDateTime;

use crate::account::Account;
use crate::plans::Plan;
use crate::workspace::{RUNNING_STATUSES, Workspace};

/// A workspace that has to add a payment method, and by when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PaymentMethodNeeded {
    /// Add one before this: the renewal, or the end of the grace period
    /// once the renewal was refused.
    pub(crate) due_at: OffsetDateTime,
    /// The renewal was refused already: the plan runs on its grace period.
    pub(crate) past_due: bool,
}

/// When `workspace` must add a payment method at `now`, or `None`: it has a
/// mandate renewals can charge, or nothing will be charged (Free, a comp, a
/// partner's workspace, a plan cancelled to its period end, a price of
/// nothing), or the renewal is further away than `notice_days`.
pub(crate) fn payment_method_needed(
    workspace: &Workspace,
    account: &Account,
    plan: Option<&Plan>,
    now: OffsetDateTime,
    notice_days: i64,
    grace_days: i64,
) -> Option<PaymentMethodNeeded> {
    if account.can_charge()
        || workspace.is_partner()
        || workspace.comp_active(now)
        || !RUNNING_STATUSES.contains(&workspace.subscription_status.as_deref().unwrap_or_default())
    {
        return None;
    }
    let plan = plan.filter(|plan| !plan.is_free())?;
    if account.past_due_payment_id.is_some()
        && let Some(since) = account.past_due_since()
    {
        return Some(PaymentMethodNeeded {
            due_at: since + time::Duration::days(grace_days),
            past_due: true,
        });
    }
    if workspace.cancel_at_period_end || account.next_charge().is_none() {
        return None;
    }
    let (_, renews_at) = workspace.period()?;
    let unit = account
        .unit_amount
        .map(i64::from)
        .or_else(|| plan.unit_amount(workspace.cycle()))
        .unwrap_or(0);
    if unit <= 0 || workspace.purchased_seats <= 0 {
        return None;
    }
    (renews_at <= now + time::Duration::days(notice_days)).then_some(PaymentMethodNeeded {
        due_at: renews_at,
        past_due: false,
    })
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;
    use crate::period::iso;

    const RENEWAL: OffsetDateTime = datetime!(2026-12-14 10:00:00 UTC);

    fn plan(slug: &str, monthly: &str) -> Plan {
        Plan {
            id: format!("plan_{slug}"),
            name: slug.to_owned(),
            slug: slug.to_owned(),
            description: None,
            price_monthly: monthly.to_owned(),
            price_yearly: "0".to_owned(),
            currency: "EUR".to_owned(),
            included_users: Some(0),
            monthly_credits: Some(0),
            features: None,
            max_users: None,
            max_custom_domains: None,
            remove_branding: false,
            is_active: true,
            is_default: false,
            has_api_access: false,
            sort_order: 1,
            badge: None,
        }
    }

    /// A workspace moved from Global: Business, 3 seats, renewing on the
    /// 14th of December.
    fn moved() -> (Workspace, Account) {
        let workspace = Workspace {
            id: "ws_moved".to_owned(),
            clerk_org_id: None,
            name: "Moved".to_owned(),
            plan_id: Some("plan_business".to_owned()),
            purchased_seats: 3,
            subscription_status: Some("active".to_owned()),
            subscription_cycle: Some("monthly".to_owned()),
            period_start: Some(iso(datetime!(2026-11-14 10:00:00 UTC))),
            period_end: Some(iso(RENEWAL)),
            cancel_at_period_end: false,
            billing_mode: "direct".to_owned(),
            is_active: true,
            paid_plan_required: false,
            trial_expired_at: None,
            scheduled_deletion_at: None,
            comp_granted_at: None,
            comp_ends_at: None,
        };
        let account = Account {
            id: "bac_moved".to_owned(),
            customer_id: None,
            mandate_id: None,
            unit_amount: Some(2500),
            currency: "EUR".to_owned(),
            anchor_day: Some(14),
            next_charge_at: Some(iso(RENEWAL)),
            scheduled_plan_id: None,
            scheduled_seats: None,
            scheduled_cycle: None,
            past_due_since: None,
            past_due_payment_id: None,
        };
        (workspace, account)
    }

    fn needed(
        workspace: &Workspace,
        account: &Account,
        plan: &Plan,
        now: OffsetDateTime,
    ) -> Option<PaymentMethodNeeded> {
        payment_method_needed(workspace, account, Some(plan), now, 14, 14)
    }

    #[test]
    fn the_notice_starts_fourteen_days_before_the_renewal() {
        let (workspace, account) = moved();
        let business = plan("business", "25.00");
        assert_eq!(
            needed(
                &workspace,
                &account,
                &business,
                datetime!(2026-11-30 09:59:00 UTC)
            ),
            None,
            "a minute too early"
        );
        let expected = Some(PaymentMethodNeeded {
            due_at: RENEWAL,
            past_due: false,
        });
        assert_eq!(
            needed(
                &workspace,
                &account,
                &business,
                datetime!(2026-11-30 10:00:00 UTC)
            ),
            expected
        );
        assert_eq!(
            needed(
                &workspace,
                &account,
                &business,
                datetime!(2026-12-14 09:00:00 UTC)
            ),
            expected
        );
        // A shorter notice starts later.
        assert_eq!(
            payment_method_needed(
                &workspace,
                &account,
                Some(&business),
                datetime!(2026-11-30 10:00:00 UTC),
                7,
                14
            ),
            None
        );
    }

    #[test]
    fn a_refused_renewal_needs_one_until_the_grace_period_ends() {
        let (workspace, mut account) = moved();
        account.past_due_payment_id = Some("bpy_open".to_owned());
        account.past_due_since = Some(iso(datetime!(2026-12-14 10:30:00 UTC)));
        account.next_charge_at = Some(iso(datetime!(2027-01-14 10:00:00 UTC)));
        let mut past_due = workspace.clone();
        past_due.subscription_status = Some("past_due".to_owned());
        assert_eq!(
            needed(
                &past_due,
                &account,
                &plan("business", "25.00"),
                datetime!(2026-12-20 10:00:00 UTC)
            ),
            Some(PaymentMethodNeeded {
                due_at: datetime!(2026-12-28 10:30:00 UTC),
                past_due: true,
            })
        );
    }

    #[test]
    fn nothing_to_add_when_nothing_will_be_charged_or_a_mandate_is_there() {
        let now = datetime!(2026-12-01 10:00:00 UTC);
        let business = plan("business", "25.00");
        let (workspace, account) = moved();
        assert!(needed(&workspace, &account, &business, now).is_some());

        // A mandate renewals can charge.
        let mut with_mandate = account.clone();
        with_mandate.customer_id = Some("cst_1".to_owned());
        with_mandate.mandate_id = Some("mdt_1".to_owned());
        assert_eq!(needed(&workspace, &with_mandate, &business, now), None);
        // A customer alone is not a payment method.
        let mut customer_only = account.clone();
        customer_only.customer_id = Some("cst_1".to_owned());
        assert!(needed(&workspace, &customer_only, &business, now).is_some());

        // Free.
        assert_eq!(needed(&workspace, &account, &plan("free", "0"), now), None);
        assert_eq!(
            payment_method_needed(&workspace, &account, None, now, 14, 14),
            None
        );

        // A comp pays the plan; one that has ended doesn't.
        let mut comped = workspace.clone();
        comped.comp_granted_at = Some(iso(datetime!(2026-11-01 00:00:00 UTC)));
        assert_eq!(needed(&comped, &account, &business, now), None);
        comped.comp_ends_at = Some(iso(datetime!(2026-11-20 00:00:00 UTC)));
        assert!(needed(&comped, &account, &business, now).is_some());

        // Cancelled to its period end: nothing renews.
        let mut cancelled = workspace.clone();
        cancelled.cancel_at_period_end = true;
        assert_eq!(needed(&cancelled, &account, &business, now), None);

        // A plan already ended, or billed by a partner.
        let mut ended = workspace.clone();
        ended.subscription_status = Some("canceled".to_owned());
        assert_eq!(needed(&ended, &account, &business, now), None);
        let mut partner = workspace.clone();
        partner.billing_mode = "partner".to_owned();
        assert_eq!(needed(&partner, &account, &business, now), None);

        // No next charge, or a price of nothing (sold through sales).
        let mut unscheduled = account.clone();
        unscheduled.next_charge_at = None;
        assert_eq!(needed(&workspace, &unscheduled, &business, now), None);
        let mut free_seats = account.clone();
        free_seats.unit_amount = Some(0);
        assert_eq!(needed(&workspace, &free_seats, &business, now), None);
        let mut unpriced = account;
        unpriced.unit_amount = None;
        assert_eq!(
            needed(&workspace, &unpriced, &plan("enterprise", "0"), now),
            None
        );
        assert!(needed(&workspace, &unpriced, &business, now).is_some());
    }
}
