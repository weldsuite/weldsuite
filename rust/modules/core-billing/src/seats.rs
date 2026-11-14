//! Seats on Zitadel (ADR BILL-014, decision 9): WeldSuite's invite check is
//! the gate, and for a workspace billed through Mollie it allows exactly the
//! seats bought (`weldsuite-core-team`'s seat limit reads `billing_accounts`).
//! The identity provider's membership cap is still written whenever plan or
//! seats change, so the cap and `/api/member-limits` agree.

use std::sync::Arc;

use weldsuite_ports::{Identity, ListPage, OrganizationChanges};

use crate::plans::Plan;

/// The cap for `seats` bought on `plan`: the seats, within the plan's
/// ceiling. Free (no seats bought) keeps the plan's own `max_users`; 0
/// clears the cap.
pub(crate) fn seat_cap(plan: &Plan, seats: i64) -> i64 {
    let ceiling = plan.max_users.filter(|max| *max > 0).map(i64::from);
    if seats > 0 && !plan.is_free() {
        return ceiling.map_or(seats, |max| seats.min(max));
    }
    ceiling.unwrap_or(0)
}

/// Writes the cap; failures are logged (the invite check is the gate).
pub(crate) async fn write_cap(identity: Option<&Arc<dyn Identity>>, organization: &str, cap: i64) {
    let Some(identity) = identity else {
        return;
    };
    let changes = OrganizationChanges {
        max_memberships: Some(cap),
        ..OrganizationChanges::default()
    };
    if let Err(error) = identity.update_organization(organization, &changes).await {
        tracing::warn!(%error, organization, "billing: the membership cap wasn't written");
    }
}

/// Invitations still open, which hold a seat (0 when the provider can't
/// be asked).
pub(crate) async fn pending_invitations(
    identity: Option<&Arc<dyn Identity>>,
    organization: &str,
) -> i64 {
    let Some(identity) = identity else {
        return 0;
    };
    match identity
        .invitations(organization, Some("pending"), ListPage::limit(1))
        .await
    {
        Ok(listing) => listing
            .total_count
            .map_or(0, |total| i64::try_from(total).unwrap_or(i64::MAX)),
        Err(error) => {
            tracing::warn!(%error, organization, "billing: pending invitations unknown");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(slug: &str, max_users: Option<i32>) -> Plan {
        Plan {
            id: format!("plan_{slug}"),
            name: slug.to_owned(),
            slug: slug.to_owned(),
            description: None,
            price_monthly: "12.00".to_owned(),
            price_yearly: "0".to_owned(),
            currency: "EUR".to_owned(),
            included_users: Some(0),
            monthly_credits: None,
            features: None,
            max_users,
            max_custom_domains: None,
            remove_branding: false,
            is_active: true,
            is_default: false,
            has_api_access: false,
            sort_order: 1,
            badge: None,
        }
    }

    #[test]
    fn the_cap_is_the_seats_bought_within_the_plan() {
        assert_eq!(seat_cap(&plan("starter", Some(10)), 3), 3);
        assert_eq!(seat_cap(&plan("starter", Some(10)), 12), 10);
        assert_eq!(seat_cap(&plan("business", None), 25), 25);
        assert_eq!(seat_cap(&plan("free", Some(1)), 0), 1);
        assert_eq!(seat_cap(&plan("free", None), 0), 0);
    }
}
