//! Seat limits (`services/seat-limits.ts`, `member-count.ts`,
//! `clerk-seat-cap.ts`): how many members a workspace may have, how many
//! seats are in use, and keeping the identity provider's membership cap in
//! step with the plan. Shared by `/api/member-limits` and the invite route.
//!
//! The provider (Clerk in the Global edition) is the source of truth for
//! membership; the master database's `user_workspaces` is the fallback when
//! it can't be read, and is re-synced in the background when it drifts.
//!
//! Billing (Stripe) is not involved: the workers only read the plan and the
//! purchased seats here, which the master database holds on every edition.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, Identity, IdentityError, IdentityResult, Invitation, ListPage, Listing, Membership,
    NewInvitation, NewMembership, Organization, OrganizationChanges, User,
};

use crate::{Caller, CoreTeamState, now};

/// `SeatLimit`: `limit` null is unlimited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SeatLimit {
    pub(crate) limit: Option<i64>,
    pub(crate) current: i64,
    pub(crate) at_limit: bool,
    pub(crate) plan_name: String,
    /// The partner whose licence sets the limit.
    pub(crate) managed_by: Option<String>,
}

impl SeatLimit {
    pub(crate) fn to_json(&self) -> Value {
        let mut body = json!({
            "limit": self.limit,
            "current": self.current,
            "atLimit": self.at_limit,
            "planName": self.plan_name,
        });
        if let Some(partner) = &self.managed_by {
            body["managedBy"] = json!(partner);
        }
        body
    }
}

/// The provider, or one that is never reachable (the workers' `fetch`
/// throwing) when none is configured.
pub(crate) fn identity(caller: &Caller, state: &CoreTeamState) -> Arc<dyn Identity> {
    caller
        .identity(state)
        .unwrap_or_else(|| Arc::new(Unconfigured))
}

struct Unconfigured;

fn unconfigured<'a, T: Send + 'a>() -> BoxFuture<'a, IdentityResult<T>> {
    Box::pin(std::future::ready(Err(IdentityError::Unavailable(
        "no identity provider is configured".to_owned(),
    ))))
}

impl Identity for Unconfigured {
    fn organization<'a>(&'a self, _: &'a str) -> BoxFuture<'a, IdentityResult<Organization>> {
        unconfigured()
    }
    fn update_organization<'a>(
        &'a self,
        _: &'a str,
        _: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
    fn delete_organization<'a>(&'a self, _: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
    fn memberships<'a>(
        &'a self,
        _: &'a str,
        _: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>> {
        unconfigured()
    }
    fn add_membership<'a>(
        &'a self,
        _: &'a str,
        _: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>> {
        unconfigured()
    }
    fn set_membership_role<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
    fn remove_membership<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
    fn invitations<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        unconfigured()
    }
    fn invitation<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        unconfigured()
    }
    fn invite<'a>(
        &'a self,
        _: &'a str,
        _: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        unconfigured()
    }
    fn revoke_invitation<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
    fn users_by_email<'a>(
        &'a self,
        _: &'a str,
        _: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<User>>> {
        unconfigured()
    }
    fn user_memberships<'a>(
        &'a self,
        _: &'a str,
        _: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<Membership>>> {
        unconfigured()
    }
    fn delete_user<'a>(&'a self, _: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        unconfigured()
    }
}

/// `public_metadata.member_type === 'EXTERNAL_GUEST'`.
pub(crate) fn is_guest(public_metadata: &Value) -> bool {
    public_metadata["member_type"] == "EXTERNAL_GUEST"
}

/// `planSeatLimit`: a hard cap wins; a per-seat plan is limited by what it
/// paid for; otherwise unlimited.
fn plan_seat_limit(
    max_users: Option<i32>,
    price_per_user: Option<&str>,
    included_users: Option<i32>,
    purchased_seats: Option<i32>,
) -> Option<i64> {
    if let Some(max) = max_users.filter(|max| *max > 0) {
        return Some(i64::from(max));
    }
    let price = price_per_user.map_or(0.0, parse_float);
    if price > 0.0 {
        return Some(
            i64::from(included_users.unwrap_or(1)) + i64::from(purchased_seats.unwrap_or(0)),
        );
    }
    None
}

/// `Number.parseFloat` for a `numeric` column's text: the leading number, or
/// NaN (which is not > 0).
fn parse_float(text: &str) -> f64 {
    let text = text.trim_start();
    let end = text
        .char_indices()
        .take_while(|(i, c)| {
            c.is_ascii_digit() || *c == '.' || (*i == 0 && (*c == '-' || *c == '+'))
        })
        .map(|(i, c)| i + c.len_utf8())
        .last()
        .unwrap_or(0);
    text[..end].parse().unwrap_or(f64::NAN)
}

/// `workspaces`: id, plan, purchased seats, billing mode, partner.
type WorkspaceRow = (String, Option<String>, i32, String, Option<String>);
/// `plans`: name, max users, price per user, included users.
type PlanRow = (String, Option<i32>, Option<String>, Option<i32>);

/// `getWorkspaceSeatLimit(env, orgId)`: `None` when no workspace matches
/// `org_ref` (its id or its Clerk org id).
pub(crate) async fn workspace_seat_limit(
    caller: &Caller,
    state: &CoreTeamState,
    org_ref: &str,
) -> Result<Option<SeatLimit>, sqlx::Error> {
    let master = caller.master(state);
    let workspace: Option<WorkspaceRow> = sqlx::query_as(
        "select id, plan_id, purchased_seats, billing_mode, partner_id from workspaces
         where id = $1 or clerk_org_id = $1",
    )
    .bind(org_ref)
    .fetch_optional(&master)
    .await?;
    let Some((workspace_id, plan_id, purchased_seats, billing_mode, partner_id)) = workspace else {
        return Ok(None);
    };

    let mut limit = None;
    let mut plan_name = "Free".to_owned();
    let mut managed_by = None;
    if billing_mode == "partner" {
        let licence: Option<Option<i32>> =
            sqlx::query_scalar("select max_seats from workspace_licences where workspace_id = $1")
                .bind(&workspace_id)
                .fetch_optional(&master)
                .await?;
        limit = licence.flatten().map(i64::from);
        "Licence".clone_into(&mut plan_name);
        if let Some(partner_id) = partner_id.filter(|id| !id.is_empty()) {
            managed_by = sqlx::query_scalar("select name from partners where id = $1")
                .bind(partner_id)
                .fetch_optional(&master)
                .await?;
        }
    } else if let Some(plan_id) = plan_id.filter(|id| !id.is_empty()) {
        let plan: Option<PlanRow> = sqlx::query_as(
            "select name, max_users, price_per_user::text, included_users from plans where id = $1",
        )
        .bind(plan_id)
        .fetch_optional(&master)
        .await?;
        if let Some((name, max_users, price_per_user, included_users)) = plan {
            plan_name = name;
            limit = plan_seat_limit(
                max_users,
                price_per_user.as_deref(),
                included_users,
                Some(purchased_seats),
            );
        }
    }

    let idp = identity(caller, state);
    let members = accurate_member_count(caller, state, &*idp, org_ref, &workspace_id).await?;
    let pending = pending_seat_invitations(&*idp, org_ref).await;
    let current = members + pending.unwrap_or(0);
    Ok(Some(SeatLimit {
        limit,
        current,
        at_limit: limit.is_some_and(|limit| current >= limit),
        plan_name,
        managed_by: managed_by.filter(|name: &String| !name.is_empty()),
    }))
}

/// A `user_workspaces` row, as the member count and its re-sync read it.
#[derive(Debug, Clone)]
struct SeatRow {
    id: String,
    user_id: String,
    status: String,
}

/// `getAccurateMemberCount`: the provider's count without members WeldSuite
/// already removed (who are taken out of the provider), else the DB's.
pub(crate) async fn accurate_member_count(
    caller: &Caller,
    state: &CoreTeamState,
    idp: &dyn Identity,
    org: &str,
    workspace_id: &str,
) -> Result<i64, sqlx::Error> {
    let master = caller.master(state);
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "select id, user_id, status::text from user_workspaces where workspace_id = $1",
    )
    .bind(workspace_id)
    .fetch_all(&master)
    .await?;
    let rows: Vec<SeatRow> = rows
        .into_iter()
        .map(|(id, user_id, status)| SeatRow {
            id,
            user_id,
            status,
        })
        .collect();
    let db_count = count_i64(
        rows.iter()
            .filter(|r| r.status == "ACTIVE" || r.status == "PENDING")
            .count(),
    );

    let Ok(listing) = idp.memberships(org, ListPage::limit(500)).await else {
        tracing::warn!("member count: the identity provider could not be read, using the DB count");
        return Ok(db_count);
    };
    let fetched = listing.data.len();
    let seats = drop_removed_memberships(caller, idp, org, listing.data).await;
    let total = listing.total_count.map_or_else(
        || count_i64(fetched),
        |total| i64::try_from(total).unwrap_or(i64::MAX),
    );
    let clerk_count = total - (count_i64(fetched) - count_i64(seats.len()));
    if clerk_count == db_count {
        return Ok(clerk_count);
    }
    tracing::warn!(
        db_count,
        clerk_count,
        "member count: DB and identity provider differ, re-syncing"
    );
    let workspace_id = workspace_id.to_owned();
    state.events.tracker().spawn(async move {
        if let Err(error) = sync_user_workspaces(&master, &workspace_id, &rows, &seats).await {
            tracing::error!(%error, "member count: background member sync failed");
        }
    });
    Ok(clerk_count)
}

fn count_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `dropRemovedMemberships`: memberships of people with a removed member row
/// and no live one (by user id or email) are not seats; they are removed
/// from the provider, best effort. When the tenant DB can't be read, every
/// membership counts.
async fn drop_removed_memberships(
    caller: &Caller,
    idp: &dyn Identity,
    org: &str,
    memberships: Vec<Membership>,
) -> Vec<Membership> {
    if memberships.is_empty() {
        return memberships;
    }
    let user_ids: Vec<String> = memberships.iter().map(|m| m.user.user_id.clone()).collect();
    let emails: Vec<String> = memberships
        .iter()
        .map(|m| m.user.identifier.to_lowercase())
        .filter(|email| !email.is_empty())
        .collect();
    let refs: Result<Vec<(String, Option<String>, bool)>, sqlx::Error> = sqlx::query_as(
        "select user_id, email, deleted_at is not null from workspace_members
         where user_id = any($1) or (cardinality($2::text[]) > 0 and lower(email) = any($2))",
    )
    .bind(&user_ids)
    .bind(&emails)
    .fetch_all(&caller.db)
    .await;
    let refs = match refs {
        Ok(refs) => refs,
        Err(error) => {
            tracing::warn!(%error, "member count: could not check memberships against the tenant DB");
            return memberships;
        }
    };
    let mut live_users = HashSet::new();
    let mut live_emails = HashSet::new();
    let mut removed_users = HashSet::new();
    for (user_id, email, deleted) in refs {
        if deleted {
            removed_users.insert(user_id);
        } else {
            live_users.insert(user_id);
            if let Some(email) = email.filter(|e| !e.is_empty()) {
                live_emails.insert(email.to_lowercase());
            }
        }
    }
    let (removed, seats): (Vec<Membership>, Vec<Membership>) =
        memberships.into_iter().partition(|m| {
            let email = m.user.identifier.to_lowercase();
            removed_users.contains(&m.user.user_id)
                && !live_users.contains(&m.user.user_id)
                && (email.is_empty() || !live_emails.contains(&email))
        });
    if !removed.is_empty() {
        tracing::warn!(
            count = removed.len(),
            "member count: removed members still in the identity provider, removing"
        );
        for membership in &removed {
            if let Err(error) = idp.remove_membership(org, &membership.user.user_id).await
                && !error.is_not_found()
            {
                tracing::error!(%error, "member count: membership delete failed");
            }
        }
    }
    seats
}

/// `syncUserWorkspacesFromClerk`: add the provider's members `user_workspaces`
/// misses, re-activate the ones it has otherwise, drop ACTIVE rows the
/// provider no longer lists.
async fn sync_user_workspaces(
    master: &PgPool,
    workspace_id: &str,
    rows: &[SeatRow],
    memberships: &[Membership],
) -> Result<(), sqlx::Error> {
    let existing: HashMap<&str, &SeatRow> = rows.iter().map(|r| (r.user_id.as_str(), r)).collect();
    let mut provider_users = HashSet::new();
    for membership in memberships {
        let user_id = membership.user.user_id.as_str();
        provider_users.insert(user_id);
        match existing.get(user_id) {
            None => {
                sqlx::query(
                    "insert into users (id, email, first_name, last_name) values ($1, $2, $3, $4)
                     on conflict do nothing",
                )
                .bind(user_id)
                .bind(&membership.user.identifier)
                .bind(&membership.user.first_name)
                .bind(&membership.user.last_name)
                .execute(master)
                .await?;
                // `new Date(created_at)`; without one Drizzle throws here.
                let Some(joined) = membership.created_at.and_then(|ms| {
                    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()
                }) else {
                    return Ok(());
                };
                sqlx::query(
                    "insert into user_workspaces
                         (id, user_id, workspace_id, clerk_membership_id, role, status, joined_at)
                     values ($1, $2, $3, $4, $5, 'ACTIVE', $6::timestamp)
                     on conflict do nothing",
                )
                .bind(generate_id("uw"))
                .bind(user_id)
                .bind(workspace_id)
                .bind(&membership.id)
                .bind(&membership.role)
                .bind(weldsuite_events::iso_timestamp(joined))
                .execute(master)
                .await?;
            }
            Some(row) if row.status != "ACTIVE" => {
                sqlx::query(
                    "update user_workspaces
                     set status = 'ACTIVE', clerk_membership_id = $2, updated_at = $3::timestamp
                     where id = $1",
                )
                .bind(&row.id)
                .bind(&membership.id)
                .bind(now())
                .execute(master)
                .await?;
            }
            Some(_) => {}
        }
    }
    for row in rows {
        if row.status == "ACTIVE" && !provider_users.contains(row.user_id.as_str()) {
            sqlx::query("delete from user_workspaces where id = $1")
                .bind(&row.id)
                .execute(master)
                .await?;
        }
    }
    Ok(())
}

/// Guests and everyone else in one of the provider's lists.
#[derive(Debug, Default, Clone, Copy)]
struct ListCount {
    guests: i64,
    others: i64,
}

const PAGE_SIZE: u32 = 100;

/// `countClerkList` over the organization's memberships.
async fn count_memberships(idp: &dyn Identity, org: &str) -> IdentityResult<ListCount> {
    let mut count = ListCount::default();
    let mut offset = 0u32;
    loop {
        let page = idp
            .memberships(org, ListPage::at(PAGE_SIZE, offset))
            .await?;
        for item in &page.data {
            tally(&mut count, &item.public_metadata);
        }
        if advance(&mut offset, page.data.len(), page.total_count) {
            return Ok(count);
        }
    }
}

/// `countClerkList` over the organization's pending invitations.
async fn count_pending_invitations(idp: &dyn Identity, org: &str) -> IdentityResult<ListCount> {
    let mut count = ListCount::default();
    let mut offset = 0u32;
    loop {
        let page = idp
            .invitations(org, Some("pending"), ListPage::at(PAGE_SIZE, offset))
            .await?;
        for item in &page.data {
            tally(&mut count, &item.public_metadata);
        }
        if advance(&mut offset, page.data.len(), page.total_count) {
            return Ok(count);
        }
    }
}

fn tally(count: &mut ListCount, metadata: &Value) {
    if is_guest(metadata) {
        count.guests += 1;
    } else {
        count.others += 1;
    }
}

/// Move past a page; `true` when it was the last one.
fn advance(offset: &mut u32, items: usize, total: Option<u64>) -> bool {
    *offset += u32::try_from(items).unwrap_or(u32::MAX);
    items < PAGE_SIZE as usize || u64::from(*offset) >= total.unwrap_or(0)
}

/// `countPendingSeatInvitations`: pending invitations that will take a paid
/// seat; `None` when the provider can't be read.
pub(crate) async fn pending_seat_invitations(idp: &dyn Identity, org: &str) -> Option<i64> {
    match count_pending_invitations(idp, org).await {
        Ok(count) => Some(count.others),
        Err(error) => {
            tracing::warn!(%error, "seat cap: could not count pending invitations");
            None
        }
    }
}

/// `clerkCapForPlan`: the cap to write so the provider allows what the plan
/// allows, or `None` when it already does. Only ever raises.
fn cap_for_plan(cap: Option<i64>, paid_limit: Option<i64>, guest_slots: i64) -> Option<i64> {
    let cap = cap.filter(|cap| *cap > 0)?;
    let Some(paid) = paid_limit else {
        return Some(0);
    };
    let needed = paid + guest_slots;
    (cap < needed).then_some(needed)
}

/// `syncClerkSeatLimit`: write the cap (0 clears it); failures are logged.
pub(crate) async fn set_seat_cap(idp: &dyn Identity, org: &str, cap: i64) {
    let changes = OrganizationChanges {
        max_memberships: Some(cap),
        ..OrganizationChanges::default()
    };
    if let Err(error) = idp.update_organization(org, &changes).await {
        tracing::error!(%error, "seat cap: failed to update the membership cap");
    }
}

/// `alignClerkCapWithPlan`: raise the provider's cap to what the plan
/// allows, so a stale cap can't refuse a seat the plan has. Best effort.
pub(crate) async fn align_cap_with_plan(idp: &dyn Identity, org: &str, paid_limit: Option<i64>) {
    let Ok(organization) = idp.organization(org).await else {
        return;
    };
    let cap = organization.max_memberships;
    if cap.is_none_or(|cap| cap <= 0) {
        return;
    }
    let mut guest_slots = 0;
    if paid_limit.is_some() {
        // Both lists are read (as `Promise.all` does) before either failure counts.
        let members = count_memberships(idp, org).await;
        let invitations = count_pending_invitations(idp, org).await;
        match (members, invitations) {
            (Ok(members), Ok(invitations)) => guest_slots = members.guests + invitations.guests,
            (Err(error), _) | (_, Err(error)) => {
                tracing::error!(%error, "seat cap: could not align the cap with the plan");
                return;
            }
        }
    }
    if let Some(next) = cap_for_plan(cap, paid_limit, guest_slots) {
        tracing::warn!(
            next,
            "seat cap: the provider's cap is below the plan, raising it"
        );
        set_seat_cap(idp, org, next).await;
    }
}

/// `clerkListTotal`: a list's total, `Ok(None)` on a refusal, `Err` when the
/// provider can't be reached (the workers' `fetch` throwing).
fn list_total<T>(result: IdentityResult<Listing<T>>) -> Result<Option<i64>, IdentityError> {
    match result {
        Ok(listing) => Ok(listing
            .total_count
            .map(|total| i64::try_from(total).unwrap_or(i64::MAX))),
        Err(IdentityError::Rejected { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `clerkCapWithRoomForOne`.
fn cap_with_room_for_one(cap: Option<i64>, occupied: i64) -> Option<i64> {
    let cap = cap.filter(|cap| *cap > 0)?;
    (occupied >= cap).then_some(occupied + 1)
}

/// `makeClerkRoomForGuest`: guests take no paid seat but count against the
/// provider's cap, so a full organization's cap goes up by one first. Best
/// effort.
pub(crate) async fn make_room_for_guest(idp: &dyn Identity, org: &str) {
    let Ok(organization) = idp.organization(org).await else {
        return;
    };
    if organization.max_memberships.is_none_or(|cap| cap <= 0) {
        return;
    }
    let members = list_total(idp.memberships(org, ListPage::limit(1)).await);
    let pending = list_total(
        idp.invitations(org, Some("pending"), ListPage::limit(1))
            .await,
    );
    let (Ok(members), Ok(pending)) = (members, pending) else {
        tracing::error!("team members: could not make room for a guest in the identity provider");
        return;
    };
    let Some(members) = members else {
        return;
    };
    if let Some(next) =
        cap_with_room_for_one(organization.max_memberships, members + pending.unwrap_or(0))
    {
        set_seat_cap(idp, org, next).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_limits_like_plan_seat_limit() {
        assert_eq!(
            plan_seat_limit(Some(1), Some("10.00"), Some(5), Some(3)),
            Some(1)
        );
        assert_eq!(
            plan_seat_limit(Some(0), Some("12.00"), Some(2), Some(3)),
            Some(5)
        );
        assert_eq!(plan_seat_limit(None, Some("12.00"), None, None), Some(1));
        assert_eq!(plan_seat_limit(None, Some("0.00"), Some(2), Some(3)), None);
        assert_eq!(plan_seat_limit(None, None, Some(2), Some(3)), None);
    }

    #[test]
    fn caps_only_go_up() {
        assert_eq!(cap_for_plan(None, Some(5), 0), None);
        assert_eq!(cap_for_plan(Some(0), Some(5), 0), None);
        assert_eq!(cap_for_plan(Some(3), None, 0), Some(0));
        assert_eq!(cap_for_plan(Some(1), Some(5), 1), Some(6));
        assert_eq!(cap_for_plan(Some(10), Some(5), 1), None);
        assert_eq!(cap_with_room_for_one(Some(1), 1), Some(2));
        assert_eq!(cap_with_room_for_one(Some(3), 1), None);
        assert_eq!(cap_with_room_for_one(None, 9), None);
    }

    #[test]
    fn parse_float_reads_the_leading_number() {
        assert!((parse_float("12.50") - 12.5).abs() < f64::EPSILON);
        assert!(parse_float("abc").is_nan());
    }
}
