//! The identity sync: what Clerk's webhooks do on Global
//! (`apps/workers/workspace-worker/src/routes/webhooks/clerk.ts`), for a
//! provider that keeps a change feed instead (Zitadel's event store).
//! `weldsuite cron identity-sync` runs [`IdentitySync::run`] every minute.
//!
//! Each run reads the changes since the watermark (master `system_settings`,
//! key [`WATERMARK_KEY`]) and marks what they name as dirty; then it
//! reconciles each dirty user, organization and membership against the
//! provider's current state, so a change seen twice, late or out of order
//! does no harm:
//!
//! | Dirty | Reconcile (webhook it stands for) |
//! |---|---|
//! | user | profile → `users` and the member rows' name (`user.created`/`updated`); gone → deactivated, memberships removed (`user.deleted`); and each of the user's memberships, below (an accepted invitation shows up as the user verifying their email) |
//! | organization | name and slug → `workspaces` (`organization.updated`); gone → the workspace is deleted and its database torn down (`organization.deleted`) |
//! | membership | a member → `user_workspaces` and the tenant member, OWNER kept (`organizationMembership.created`/`updated`); a pending invitee → the PENDING member row (`organizationInvitation.created`); neither → removed (`organizationMembership.deleted`, `organizationInvitation.revoked`) |
//!
//! Onboarding and `POST /api/invitations/accept` write what the user needs
//! next themselves, so the lag stays off the user's path. Organizations the
//! master has no workspace for (created in Zitadel's console) are left
//! alone: workspaces are made by onboarding. The watermark only moves when
//! every reconcile of the batch either worked or was refused for good; a
//! provider or database that can't be reached leaves it, and the next run
//! does the batch again.
//!
//! Not here: the invitation email (Zitadel sends its own invite code), the
//! permission-cache bump (the Rust backend keeps no permission cache), and
//! WeldChat's auto-join (not ported).
//!
//! WeldID (membership mode) keeps no organizations or memberships, only
//! users, and offers an ordered event feed instead of a change feed:
//! [`IdentitySync::run_feed`] reads `Identity::events_after` from its own
//! watermark ([`FEED_WATERMARK_KEY`], the last event id handled) and
//! reconciles only users, the same way: `user.created`, `user.updated` and
//! `user.email_changed` read the profile into `users` and the member rows'
//! name and email (the picture stays on the account, `users.image_url`);
//! `user.deleted` deactivates the user and removes
//! their memberships (WeldID keeps an anonymised row, so the profile isn't
//! asked); `session.revoked` needs nothing here.
//!
//! `sso.signed_in` ([`SSO_SIGNED_IN`], ADR SEC-019 phase 5a) is the one
//! automatic way into a workspace in membership mode (invitations are not
//! served yet): someone signed in through a workspace's SSO connection, and
//! its data names the workspace (`tenantRef`, `workspaces.id`) and the
//! connection. Besides the profile refresh, the person joins that workspace
//! with its default role for SSO members (`weldsuite_db::sso_settings`) when
//! they aren't a member yet: the tenant member first, then the master row,
//! so a run that stops halfway is finished by the next one. An existing
//! member's role is never changed, and a user the same page deletes doesn't
//! join. Like the other membership reconciles here it publishes no entity
//! event (the catalog has no member events; Clerk's webhooks publish none
//! either).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, Order,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde::Serialize;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, orm_error};
use weldsuite_ports::{
    DatabaseProvisioner, FeedEvent, Identity, IdentityChange, IdentityError, ListPage, Membership,
    Teardown, UserProfile,
};
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{system_settings, user_workspaces, users, workspaces};
use weldsuite_schema::tenant::workspace_members as members;

use crate::TenantDatabases;
use crate::onboard::upsert_user_workspace;

/// The `system_settings` key of the watermark: the time of the newest change
/// handled (RFC 3339, as a JSON string).
pub const WATERMARK_KEY: &str = "identity_sync.watermark";

/// The `system_settings` key of the event feed's watermark
/// ([`IdentitySync::run_feed`]): the id of the last event handled (a JSON
/// string).
pub const FEED_WATERMARK_KEY: &str = "identity_sync.weldid_watermark";

/// What a feed event asks of a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FeedAction {
    /// Read the profile again.
    Refresh,
    /// The user is gone.
    Delete,
}

/// The feed event of a sign-in through a workspace's SSO connection.
pub const SSO_SIGNED_IN: &str = "sso.signed_in";

/// The action an event of `kind` asks for; `None` for kinds with nothing to
/// do here (`session.revoked`, and kinds this build doesn't know). An SSO
/// sign-in also refreshes the profile (WeldID may have just created the
/// person); the join itself is [`sso_joins`]'.
pub fn feed_action(kind: &str) -> Option<FeedAction> {
    match kind {
        "user.created" | "user.updated" | "user.email_changed" | SSO_SIGNED_IN => {
            Some(FeedAction::Refresh)
        }
        "user.deleted" => Some(FeedAction::Delete),
        _ => None,
    }
}

/// Someone signed in through a workspace's SSO connection
/// ([`SSO_SIGNED_IN`]): they join that workspace if they aren't a member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoJoin {
    pub user_id: String,
    /// `workspaces.id` (an organization id is accepted too).
    pub tenant_ref: String,
    pub connection_id: Option<String>,
}

/// A string field of an event's data, camelCase or snake case, non-empty.
fn data_field<'a>(data: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| data.get(*name).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
}

/// The joins a batch of events asks for, once per user and workspace, in
/// feed order. An event without a user or a workspace is skipped.
pub fn sso_joins<'a>(events: impl IntoIterator<Item = &'a FeedEvent>) -> Vec<SsoJoin> {
    let mut joins: Vec<SsoJoin> = Vec::new();
    for event in events {
        if event.kind != SSO_SIGNED_IN {
            continue;
        }
        let user = event
            .user_id
            .as_deref()
            .filter(|user| !user.is_empty())
            .or_else(|| data_field(&event.data, &["userId", "user_id"]));
        let tenant = data_field(&event.data, &["tenantRef", "tenant_ref"]);
        let (Some(user), Some(tenant)) = (user, tenant) else {
            tracing::warn!(
                event = event.id,
                "identity sync: an SSO sign-in without a user or workspace"
            );
            continue;
        };
        if joins
            .iter()
            .any(|join| join.user_id == user && join.tenant_ref == tenant)
        {
            continue;
        }
        joins.push(SsoJoin {
            user_id: user.to_owned(),
            tenant_ref: tenant.to_owned(),
            connection_id: data_field(&event.data, &["connectionId", "connection_id"])
                .map(str::to_owned),
        });
    }
    joins
}

/// One action per user for a batch of events: a deletion wins over a
/// refresh (ids are never reused).
pub fn feed_actions<'a>(
    events: impl IntoIterator<Item = &'a FeedEvent>,
) -> BTreeMap<String, FeedAction> {
    let mut actions = BTreeMap::new();
    for event in events {
        let (Some(action), Some(user)) = (feed_action(&event.kind), event.user_id.as_deref())
        else {
            continue;
        };
        if user.is_empty() {
            continue;
        }
        actions
            .entry(user.to_owned())
            .and_modify(|current: &mut FeedAction| *current = (*current).max(action))
            .or_insert(action);
    }
    actions
}

/// Changes read per page, and pages per run.
const PAGE: u32 = 500;
const MAX_PAGES: usize = 20;

/// What one run did.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub changes: usize,
    pub users: usize,
    pub organizations: usize,
    pub memberships: usize,
    /// Reconciles that failed and are left for the next run.
    pub failed: usize,
    pub watermark: Option<String>,
}

type Failure = Box<dyn std::error::Error + Send + Sync>;

/// Whether a failed reconcile should be retried by the next run.
enum Outcome {
    Done,
    Retry(Failure),
}

impl<E: Into<Failure>> From<E> for Outcome {
    fn from(error: E) -> Self {
        Self::Retry(error.into())
    }
}

/// See the module docs.
pub struct IdentitySync {
    master: PgPool,
    identity: Arc<dyn Identity>,
    tenants: TenantDatabases,
    provisioner: Option<Arc<dyn DatabaseProvisioner>>,
}

/// A tenant member row, as the reconcile reads it ([`member_rows`]).
#[derive(Debug, FromQueryResult)]
struct Member {
    id: String,
    role: String,
    #[sea_orm(from_alias = "member_type")]
    kind: String,
}

impl IdentitySync {
    pub fn new(
        master: PgPool,
        identity: Arc<dyn Identity>,
        tenants: TenantDatabases,
        provisioner: Option<Arc<dyn DatabaseProvisioner>>,
    ) -> Self {
        Self {
            master,
            identity,
            tenants,
            provisioner,
        }
    }

    async fn watermark(&self, key: &str) -> Result<Option<String>, DbErr> {
        let value: Option<Option<Value>> = system_settings::Entity::find()
            .select_only()
            .column(system_settings::Column::Value)
            .filter(system_settings::Column::Key.eq(key))
            .into_tuple()
            .one(&orm(&self.master))
            .await?;
        Ok(value
            .flatten()
            .and_then(|value| value.as_str().map(str::to_owned)))
    }

    async fn store_watermark(&self, key: &str, at: &str) -> Result<(), DbErr> {
        use system_settings::Column;
        system_settings::Entity::insert(system_settings::ActiveModel {
            id: Set(weldsuite_kit::generate_id("sset")),
            key: Set(key.to_owned()),
            category: Set("integrations".to_owned()),
            value: Set(Some(Value::String(at.to_owned()))),
            description: Set(Some(
                "The identity sync has handled the provider's changes up to here".to_owned(),
            )),
            data_type: Set(Some("string".to_owned())),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(Column::Key)
                .update_column(Column::Value)
                .value(Column::UpdatedAt, Expr::current_timestamp())
                .to_owned(),
        )
        .exec_without_returning(&orm(&self.master))
        .await
        .map(drop)
    }

    /// One run on an event feed (WeldID's outbox): read the events after the
    /// watermark, reconcile their users, move the watermark. A page whose
    /// reconciles didn't all work leaves the watermark, and the next run
    /// reads it again.
    pub async fn run_feed(&self) -> Result<SyncReport, Failure> {
        let mut after = self.watermark(FEED_WATERMARK_KEY).await?;
        let mut report = SyncReport::default();
        for _ in 0..MAX_PAGES {
            let page = self.identity.events_after(after.as_deref(), PAGE).await?;
            if page.events.is_empty() {
                break;
            }
            report.changes += page.events.len();
            let mut failed = 0;
            let actions = feed_actions(&page.events);
            for (user_id, action) in &actions {
                report.users += 1;
                let outcome = match action {
                    FeedAction::Refresh => self.feed_user(user_id).await,
                    FeedAction::Delete => self
                        .user_deleted(user_id)
                        .await
                        .map_or_else(Outcome::from, |()| Outcome::Done),
                };
                if let Outcome::Retry(error) = outcome {
                    tracing::warn!(%error, "identity sync: a user is left for the next run");
                    failed += 1;
                }
            }
            for join in sso_joins(&page.events) {
                // Deleted in this page: gone, whatever came before.
                if actions.get(&join.user_id) == Some(&FeedAction::Delete) {
                    continue;
                }
                report.memberships += 1;
                if let Outcome::Retry(error) = self.sso_join(&join).await {
                    tracing::warn!(%error, "identity sync: an SSO join is left for the next run");
                    failed += 1;
                }
            }
            if failed > 0 {
                report.failed += failed;
                break;
            }
            let Some(next) = page.next_cursor().map(str::to_owned) else {
                break;
            };
            self.store_watermark(FEED_WATERMARK_KEY, &next).await?;
            let unchanged = after.as_deref() == Some(next.as_str());
            after = Some(next);
            if !page.has_more || unchanged {
                break;
            }
        }
        report.watermark = after;
        Ok(report)
    }

    /// A user an event named: the profile into `users` and the member rows
    /// (their email too: `user.email_changed`), or their deletion.
    async fn feed_user(&self, user_id: &str) -> Outcome {
        let profile = match self.identity.user_profile(user_id).await {
            Ok(profile) => profile,
            Err(error) if error.is_not_found() => {
                return self
                    .user_deleted(user_id)
                    .await
                    .map_or_else(Outcome::from, |()| Outcome::Done);
            }
            Err(error) => return retry_unless_refused(error),
        };
        if let Err(outcome) = self.store_profile(user_id, &profile).await {
            return outcome;
        }
        let email = profile.primary_email().unwrap_or_default();
        if !email.is_empty() {
            for (workspace, org) in self.workspaces_of(user_id).await {
                let Ok(tenant) = (self.tenants)(org.unwrap_or(workspace)).await else {
                    continue;
                };
                let _ = members::Entity::update_many()
                    .col_expr(members::Column::Email, Expr::value(email))
                    .col_expr(members::Column::UpdatedAt, Expr::current_timestamp())
                    .filter(members::Column::UserId.eq(user_id))
                    .filter(members::Column::DeletedAt.is_null())
                    // `email is distinct from $2`, `$2` never null here.
                    .filter(
                        Condition::any()
                            .add(members::Column::Email.is_null())
                            .add(members::Column::Email.ne(email)),
                    )
                    .exec(&orm(&tenant))
                    .await;
            }
        }
        Outcome::Done
    }

    /// An SSO sign-in's join: the workspace's tenant member with the default
    /// role for SSO members, then the master membership. Someone already in
    /// keeps their role; a workspace that is gone is skipped.
    async fn sso_join(&self, join: &SsoJoin) -> Outcome {
        let master = orm(&self.master);
        let workspace: Result<Option<(String, Option<String>)>, DbErr> = workspaces::Entity::find()
            .select_only()
            .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
            .filter(
                Condition::any()
                    .add(workspaces::Column::Id.eq(&join.tenant_ref))
                    .add(workspaces::Column::ClerkOrgId.eq(&join.tenant_ref)),
            )
            .filter(workspaces::Column::DeletedAt.is_null())
            .order_by(workspaces::Column::Id.eq(&join.tenant_ref), Order::Desc)
            .into_tuple()
            .one(&master)
            .await;
        let (workspace_id, org) = match workspace {
            Ok(Some(workspace)) => workspace,
            Ok(None) => {
                tracing::info!(
                    tenant_ref = join.tenant_ref,
                    "identity sync: an SSO sign-in for a workspace that is gone; skipped"
                );
                return Outcome::Done;
            }
            Err(error) => return error.into(),
        };
        let master_role: Result<Option<(MembershipStatus, String)>, DbErr> =
            user_workspaces::Entity::find()
                .select_only()
                .columns([
                    user_workspaces::Column::Status,
                    user_workspaces::Column::Role,
                ])
                .filter(user_workspaces::Column::UserId.eq(&join.user_id))
                .filter(user_workspaces::Column::WorkspaceId.eq(&workspace_id))
                .into_tuple()
                .one(&master)
                .await;
        let master_role = match master_role {
            Ok(row) => row
                .filter(|(status, _)| *status == MembershipStatus::ACTIVE)
                .map(|(_, role)| role),
            Err(error) => return error.into(),
        };
        let tenant = match (self.tenants)(org.unwrap_or_else(|| workspace_id.clone())).await {
            Ok(tenant) => tenant,
            Err(error) => return Outcome::Retry(error.into()),
        };
        let existing = match active_member(&tenant, &join.user_id).await {
            Ok(existing) => existing,
            Err(error) => return error.into(),
        };
        if master_role.is_some() && existing.is_some() {
            return Outcome::Done;
        }
        // The role they have, else the one the workspace gives SSO members.
        let role = match (&existing, &master_role) {
            (Some(member), _) => member.role.clone(),
            (None, Some(master)) => display_role(master).to_owned(),
            (None, None) => match weldsuite_db::sso_settings::sso_default_role(&tenant).await {
                Ok(role) => role.to_owned(),
                Err(error) => return orm_error(error).into(),
            },
        };
        let person = match self.sso_person(&join.user_id).await {
            Ok(Some(person)) => person,
            Ok(None) => return Outcome::Done,
            Err(outcome) => return outcome,
        };
        if existing.is_none()
            && let Err(error) = add_sso_member(&tenant, &join.user_id, &person, &role).await
        {
            return error.into();
        }
        if master_role.is_none()
            && let Err(error) = upsert_user_workspace(
                &self.master,
                &join.user_id,
                &workspace_id,
                None,
                provider_role(&role),
            )
            .await
        {
            return error.into();
        }
        tracing::info!(
            workspace_id,
            user_id = join.user_id,
            role,
            connection_id = join.connection_id.as_deref(),
            "identity sync: joined the workspace through SSO"
        );
        Outcome::Done
    }

    /// The `users` row of someone who signed in through SSO (read from the
    /// provider when this run hasn't stored it yet); `None` when the
    /// provider no longer knows them.
    async fn sso_person(&self, user_id: &str) -> Result<Option<Person>, Outcome> {
        let person = |row: Option<Person>| row.filter(|p| !p.email.is_empty());
        let stored: Option<Person> = users::Entity::find()
            .select_only()
            .columns([
                users::Column::Email,
                users::Column::FirstName,
                users::Column::LastName,
            ])
            .filter(users::Column::Id.eq(user_id))
            .into_model()
            .one(&orm(&self.master))
            .await
            .map_err(Outcome::from)?;
        if let Some(found) = person(stored) {
            return Ok(Some(found));
        }
        let profile = match self.identity.user_profile(user_id).await {
            Ok(profile) => profile,
            Err(error) if error.is_not_found() => return Ok(None),
            Err(error) => return Err(retry_unless_refused(error)),
        };
        self.store_profile(user_id, &profile).await?;
        Ok(Some(Person {
            email: profile.primary_email().unwrap_or_default().to_owned(),
            first_name: profile.first_name,
            last_name: profile.last_name,
        }))
    }

    /// One run: read the feed, reconcile, move the watermark.
    pub async fn run(&self) -> Result<SyncReport, Failure> {
        let mut since = self.watermark(WATERMARK_KEY).await?;
        let mut report = SyncReport::default();
        for _ in 0..MAX_PAGES {
            let changes = self.identity.changes_since(since.as_deref(), PAGE).await?;
            let full = changes.len() >= PAGE as usize;
            let Some(last) = changes.last().map(|change| change.at.clone()) else {
                break;
            };
            report.changes += changes.len();
            let failed = self
                .reconcile(changes.into_iter().map(|c| c.change), &mut report)
                .await;
            if failed > 0 {
                report.failed += failed;
                break;
            }
            // A full page of one instant would be read again for ever: step
            // past it (more than a page of changes in one microsecond).
            let next = if full && since.as_deref() == Some(last.as_str()) {
                step_past(&last)
            } else {
                last
            };
            self.store_watermark(WATERMARK_KEY, &next).await?;
            let unchanged = since.as_deref() == Some(next.as_str());
            since = Some(next);
            if !full || unchanged {
                break;
            }
        }
        report.watermark = since;
        Ok(report)
    }

    /// Reconcile what `changes` name; answers how many failed.
    pub async fn reconcile(
        &self,
        changes: impl IntoIterator<Item = IdentityChange>,
        report: &mut SyncReport,
    ) -> usize {
        let mut users = BTreeSet::new();
        let mut orgs = BTreeSet::new();
        let mut memberships = BTreeSet::new();
        for change in changes {
            match change {
                IdentityChange::User { user_id, .. } => {
                    users.insert(user_id);
                }
                IdentityChange::Organization { org, .. } => {
                    orgs.insert(org);
                }
                IdentityChange::Membership { org, user_id } => {
                    memberships.insert((org, user_id));
                }
            }
        }
        let mut failed = 0;
        let mut tally = |outcome: Outcome, what: &str| {
            if let Outcome::Retry(error) = outcome {
                tracing::warn!(%error, what, "identity sync: left for the next run");
                failed += 1;
            }
        };
        for org in &orgs {
            report.organizations += 1;
            tally(self.organization(org).await, "organization");
        }
        for user in &users {
            report.users += 1;
            match self.user(user).await {
                Ok(orgs) => {
                    for org in orgs {
                        memberships.insert((org, user.clone()));
                    }
                }
                Err(outcome) => tally(outcome, "user"),
            }
        }
        for (org, user) in &memberships {
            report.memberships += 1;
            tally(self.membership(org, user).await, "membership");
        }
        failed
    }

    // ── users ───────────────────────────────────────────────────────────

    /// A user's profile, or their deletion. Answers the organizations they
    /// are in, provider side, for the membership reconcile.
    async fn user(&self, user_id: &str) -> Result<Vec<String>, Outcome> {
        match self.identity.user_profile(user_id).await {
            Ok(profile) => {
                self.store_profile(user_id, &profile).await?;
                match self.identity.user_memberships(user_id, 100).await {
                    Ok(memberships) => Ok(memberships
                        .into_iter()
                        .filter_map(|m| m.organization.map(|o| o.id))
                        .collect()),
                    Err(error) => Err(retry_unless_refused(error)),
                }
            }
            Err(error) if error.is_not_found() => {
                self.user_deleted(user_id).await.map_err(Outcome::from)?;
                Ok(Vec::new())
            }
            Err(error) => Err(retry_unless_refused(error)),
        }
    }

    /// `handleUserCreated` / `handleUserUpdated`: the `users` row, then the
    /// member rows' name. The picture stays on the account (`users.image_url`,
    /// ADR SEC-020): members keep no copy.
    async fn store_profile(&self, user_id: &str, profile: &UserProfile) -> Result<(), Outcome> {
        let email = profile.primary_email().unwrap_or_default().to_owned();
        users::Entity::insert(users::ActiveModel {
            id: Set(user_id.to_owned()),
            email: Set(email),
            first_name: Set(profile.first_name.clone()),
            last_name: Set(profile.last_name.clone()),
            image_url: Set(profile.image_url.clone()),
            ..Default::default()
        })
        .on_conflict(profile_merge())
        .exec_without_returning(&orm(&self.master))
        .await
        .map_err(Outcome::from)?;
        let full_name = [profile.first_name.as_deref(), profile.last_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        self.update_member_names(user_id, &full_name).await;
        Ok(())
    }

    /// `handleUserUpdated`'s tenant half: the name, only when the provider has
    /// one (early events carry empty names), best effort per workspace.
    async fn update_member_names(&self, user_id: &str, name: &str) {
        if name.is_empty() {
            return;
        }
        for (workspace, org) in self.workspaces_of(user_id).await {
            let Ok(tenant) = (self.tenants)(org.unwrap_or(workspace)).await else {
                continue;
            };
            let _ = members::Entity::update_many()
                .col_expr(members::Column::Name, Expr::value(name))
                .col_expr(members::Column::UpdatedAt, Expr::current_timestamp())
                .filter(members::Column::UserId.eq(user_id))
                .filter(members::Column::DeletedAt.is_null())
                .exec(&orm(&tenant))
                .await;
        }
    }

    /// The workspaces a user is in (`user_workspaces` joined to
    /// `workspaces`); none when the master can't be read.
    async fn workspaces_of(&self, user_id: &str) -> Vec<(String, Option<String>)> {
        user_workspaces::Entity::find()
            .select_only()
            .columns([workspaces::Column::Id, workspaces::Column::ClerkOrgId])
            .join(
                JoinType::InnerJoin,
                user_workspaces::Entity::belongs_to(workspaces::Entity)
                    .from(user_workspaces::Column::WorkspaceId)
                    .to(workspaces::Column::Id)
                    .into(),
            )
            .filter(user_workspaces::Column::UserId.eq(user_id))
            .into_tuple()
            .all(&orm(&self.master))
            .await
            .unwrap_or_default()
    }

    /// `handleUserDeleted`.
    async fn user_deleted(&self, user_id: &str) -> Result<(), DbErr> {
        let joined = self.workspaces_of(user_id).await;
        let master = orm(&self.master);
        users::Entity::update_many()
            .col_expr(users::Column::IsActive, Expr::value(false))
            .col_expr(users::Column::UpdatedAt, Expr::current_timestamp())
            .filter(users::Column::Id.eq(user_id))
            .exec(&master)
            .await?;
        user_workspaces::Entity::delete_many()
            .filter(user_workspaces::Column::UserId.eq(user_id))
            .exec(&master)
            .await?;
        for (workspace, org) in joined {
            if let Ok(tenant) = (self.tenants)(org.unwrap_or(workspace)).await {
                let _ = members::Entity::update_many()
                    .col_expr(members::Column::DeletedAt, Expr::current_timestamp())
                    .col_expr(members::Column::UpdatedAt, Expr::current_timestamp())
                    .filter(members::Column::UserId.eq(user_id))
                    .filter(members::Column::DeletedAt.is_null())
                    .exec(&orm(&tenant))
                    .await;
            }
        }
        Ok(())
    }

    // ── organizations ───────────────────────────────────────────────────

    async fn organization(&self, org: &str) -> Outcome {
        use workspaces::Column;
        let master = orm(&self.master);
        let workspace: Result<Option<String>, DbErr> = workspaces::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::ClerkOrgId.eq(org))
            .into_tuple()
            .one(&master)
            .await;
        let workspace = match workspace {
            Ok(Some(workspace)) => workspace,
            Ok(None) => return Outcome::Done,
            Err(error) => return error.into(),
        };
        match self.identity.organization(org).await {
            // `handleOrganizationUpdated`: the slug only when the provider
            // keeps one (`slug = coalesce($3, slug)`).
            Ok(organization) => {
                let mut update = workspaces::Entity::update_many()
                    .col_expr(Column::Name, Expr::value(organization.name));
                if let Some(slug) = organization.slug.filter(|s| !s.is_empty()) {
                    update = update.col_expr(Column::Slug, Expr::value(slug));
                }
                update
                    .col_expr(Column::UpdatedAt, Expr::current_timestamp())
                    .filter(Column::Id.eq(&workspace))
                    .exec(&master)
                    .await
                    .map_or_else(Outcome::from, |_| Outcome::Done)
            }
            Err(error) if error.is_not_found() => self.organization_deleted(&workspace).await,
            Err(error) => retry_unless_refused(error),
        }
    }

    /// `handleOrganizationDeleted`: marked deleted (an earlier stamp kept),
    /// memberships removed, then the database torn down. A database move in
    /// progress defers it all; a failed teardown is retried by the next run
    /// (the teardown sweep is the backstop).
    async fn organization_deleted(&self, workspace_id: &str) -> Outcome {
        use workspaces::Column;
        match crate::sweeps::has_active_move(&self.master, workspace_id).await {
            Ok(false) => {}
            Ok(true) => return Outcome::Retry("a database move is in progress".into()),
            Err(error) => return error.into(),
        }
        let master = orm(&self.master);
        let marked = async {
            workspaces::Entity::update_many()
                .col_expr(Column::IsActive, Expr::value(false))
                // An earlier stamp is kept: `coalesce(deleted_at, now())`.
                .col_expr(
                    Column::DeletedAt,
                    Func::coalesce([
                        Expr::col((workspaces::Entity, Column::DeletedAt)),
                        Expr::current_timestamp(),
                    ])
                    .into(),
                )
                .col_expr(Column::UpdatedAt, Expr::current_timestamp())
                .filter(Column::Id.eq(workspace_id))
                .exec(&master)
                .await?;
            user_workspaces::Entity::delete_many()
                .filter(user_workspaces::Column::WorkspaceId.eq(workspace_id))
                .exec(&master)
                .await
        };
        if let Err(error) = marked.await {
            return error.into();
        }
        tracing::info!(workspace_id, "identity sync: workspace deleted");
        let Some(provisioner) = &self.provisioner else {
            return Outcome::Done;
        };
        match provisioner.teardown(workspace_id).await {
            // A Neon database is not this provisioner's: nothing to do here.
            Ok(Teardown::Dropped(_) | Teardown::NothingToDrop)
            | Err(weldsuite_ports::ProvisionError::ForeignPlacement(_)) => Outcome::Done,
            Err(error) => Outcome::Retry(Box::new(error)),
        }
    }

    // ── memberships ─────────────────────────────────────────────────────

    async fn membership(&self, org: &str, user_id: &str) -> Outcome {
        let workspace: Result<Option<String>, DbErr> = workspaces::Entity::find()
            .select_only()
            .column(workspaces::Column::Id)
            .filter(workspaces::Column::ClerkOrgId.eq(org))
            .filter(workspaces::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&self.master))
            .await;
        let workspace = match workspace {
            Ok(Some(workspace)) => workspace,
            Ok(None) => return Outcome::Done,
            Err(error) => return error.into(),
        };
        let members = match self.identity.memberships(org, ListPage::default()).await {
            Ok(members) => members,
            Err(error) if error.is_not_found() => return Outcome::Done,
            Err(error) => return retry_unless_refused(error),
        };
        if let Some(member) = members.data.into_iter().find(|m| m.user.user_id == user_id) {
            return self.member(&workspace, org, &member).await;
        }
        let invited = match self
            .identity
            .invitations(org, Some("pending"), ListPage::default())
            .await
        {
            Ok(invited) => invited,
            Err(error) => return retry_unless_refused(error),
        };
        let prefix = format!("{user_id}:");
        if let Some(invitation) = invited.data.into_iter().find(|i| i.id.starts_with(&prefix)) {
            return self
                .invitee(
                    org,
                    &invitation.id,
                    &invitation.email_address,
                    &invitation.role,
                )
                .await;
        }
        self.membership_removed(&workspace, org, user_id).await
    }

    /// `handleMembershipCreated` / `handleMembershipUpdated`: the master
    /// row (an OWNER stays `org:admin`), then the tenant member.
    async fn member(&self, workspace_id: &str, org: &str, membership: &Membership) -> Outcome {
        let user_id = membership.user.user_id.as_str();
        let tenant = match (self.tenants)(org.to_owned()).await {
            Ok(tenant) => Some(tenant),
            Err(error) => {
                tracing::warn!(%error, org, "identity sync: no tenant database (yet)");
                None
            }
        };
        let existing = match &tenant {
            Some(tenant) => match active_member(tenant, user_id).await {
                Ok(existing) => existing,
                Err(error) => return error.into(),
            },
            None => None,
        };
        let is_owner = existing.as_ref().is_some_and(|m| m.role == "OWNER");
        let master_role = if is_owner {
            "org:admin"
        } else {
            membership.role.as_str()
        };
        // The master's `users` row is the membership's parent.
        let written = async {
            users::Entity::insert(users::ActiveModel {
                id: Set(user_id.to_owned()),
                email: Set(membership.user.identifier.clone()),
                first_name: Set(membership.user.first_name.clone()),
                last_name: Set(membership.user.last_name.clone()),
                image_url: Set(membership.user.image_url.clone()),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::column(users::Column::Id)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(&orm(&self.master))
            .await?;
            upsert_user_workspace(
                &self.master,
                user_id,
                workspace_id,
                Some(&membership.id),
                master_role,
            )
            .await
        };
        if let Err(error) = written.await {
            return error.into();
        }
        let Some(tenant) = tenant else {
            // The provisioning job inserts the owner; anyone else is synced
            // once the database exists (the next change, or a re-run).
            return Outcome::Done;
        };
        let name = [
            membership.user.first_name.as_deref(),
            membership.user.last_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        let identity = MemberIdentity {
            user_id,
            email: &membership.user.identifier,
            name: Some(name).filter(|n| !n.is_empty()),
            role: display_role(&membership.role),
            membership_id: &membership.id,
        };
        sync_tenant_member(&tenant, existing, &identity)
            .await
            .map_or_else(Outcome::from, |()| Outcome::Done)
    }

    /// `handleInvitationCreated`'s row: the PENDING member for the email,
    /// whichever path made it.
    async fn invitee(&self, org: &str, invitation_id: &str, email: &str, role: &str) -> Outcome {
        let Ok(tenant) = (self.tenants)(org.to_owned()).await else {
            return Outcome::Done;
        };
        let role = display_role(role);
        let tenant = orm(&tenant);
        let existing: Result<Option<String>, DbErr> = members::Entity::find()
            .select_only()
            .column(members::Column::Id)
            .filter(pending_for(email))
            .into_tuple()
            .one(&tenant)
            .await;
        let written = match existing {
            Ok(Some(id)) => {
                use members::Column;
                let current = |column: Column| Expr::col((members::Entity, column));
                // `case when role = 'OWNER' then role else $3 end`.
                let kept = Expr::case(Column::Role.eq("OWNER"), current(Column::Role))
                    .finally(Expr::val(role));
                members::Entity::update_many()
                    .col_expr(Column::ClerkInvitationId, Expr::value(invitation_id))
                    .col_expr(
                        Column::InvitedAt,
                        Func::coalesce([current(Column::InvitedAt), Expr::current_timestamp()])
                            .into(),
                    )
                    .col_expr(Column::UpdatedAt, Expr::current_timestamp())
                    .col_expr(Column::Role, kept.into())
                    .filter(Column::Id.eq(id))
                    .exec(&tenant)
                    .await
                    .map(drop)
            }
            Ok(None) => members::Entity::insert(members::ActiveModel {
                id: Set(weldsuite_kit::generate_id("mbr")),
                user_id: Set(format!("pending_clerk_{invitation_id}")),
                email: Set(Some(email.to_owned())),
                role: Set(role.to_owned()),
                status: Set("PENDING".to_owned()),
                clerk_invitation_id: Set(Some(invitation_id.to_owned())),
                invited_at: Set(Some(OffsetDateTime::now_utc())),
                ..Default::default()
            })
            .exec_without_returning(&tenant)
            .await
            .map(drop),
            Err(error) => Err(error),
        };
        written.map_or_else(Outcome::from, |()| Outcome::Done)
    }

    /// `handleMembershipDeleted` (and a revoked invitation's PENDING row).
    async fn membership_removed(&self, workspace_id: &str, org: &str, user_id: &str) -> Outcome {
        let removed = user_workspaces::Entity::delete_many()
            .filter(user_workspaces::Column::UserId.eq(user_id))
            .filter(user_workspaces::Column::WorkspaceId.eq(workspace_id))
            .exec(&orm(&self.master))
            .await;
        if let Err(error) = removed {
            return error.into();
        }
        let Ok(tenant) = (self.tenants)(org.to_owned()).await else {
            return Outcome::Done;
        };
        let pending = format!("{user_id}:%");
        members::Entity::update_many()
            .col_expr(members::Column::DeletedAt, Expr::current_timestamp())
            .col_expr(members::Column::UpdatedAt, Expr::current_timestamp())
            .filter(members::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(members::Column::UserId.eq(user_id))
                    .add(
                        Condition::all()
                            .add(members::Column::Status.eq("PENDING"))
                            .add(members::Column::ClerkInvitationId.like(pending.as_str())),
                    ),
            )
            .exec(&orm(&tenant))
            .await
            .map_or_else(Outcome::from, |_| Outcome::Done)
    }
}

/// A refusal other than "gone" is final for this change (logged); a
/// provider that can't be reached is retried.
fn retry_unless_refused(error: IdentityError) -> Outcome {
    match error {
        IdentityError::Unavailable(_) => Outcome::Retry(Box::new(error)),
        IdentityError::Rejected { .. } => {
            tracing::warn!(%error, "identity sync: the provider refused; skipped");
            Outcome::Done
        }
    }
}

/// The time a microsecond after `at` (RFC 3339), or `at` itself when it
/// doesn't parse.
fn step_past(at: &str) -> String {
    time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
        .ok()
        .and_then(|time| time.checked_add(time::Duration::microseconds(1)))
        .and_then(|time| {
            time.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(|| at.to_owned())
}

/// `mapClerkRoleToDisplay`.
fn display_role(role: &str) -> &'static str {
    if role == "org:admin" {
        "ADMIN"
    } else {
        "MEMBER"
    }
}

/// What a membership says about its member. No picture: avatars are the
/// account's (master `users.image_url`), members keep no copy.
struct MemberIdentity<'a> {
    user_id: &'a str,
    email: &'a str,
    name: Option<String>,
    role: &'static str,
    membership_id: &'a str,
}

/// The member rows as [`Member`] reads them: `id, role, member_type`.
fn member_rows() -> Select<members::Entity> {
    members::Entity::find().select_only().columns([
        members::Column::Id,
        members::Column::Role,
        members::Column::MemberType,
    ])
}

/// The invitation row for an email: `lower(email) = lower($1) and (status =
/// 'PENDING' or user_id like 'pending_clerk_%' or user_id like 'invited_%')
/// and deleted_at is null`.
fn pending_for(email: &str) -> Condition {
    Condition::all()
        .add(sea_orm::ExprTrait::eq(
            Expr::expr(Func::lower(Expr::col((
                members::Entity,
                members::Column::Email,
            )))),
            Func::lower(Expr::val(email)),
        ))
        .add(
            Condition::any()
                .add(members::Column::Status.eq("PENDING"))
                .add(members::Column::UserId.like("pending_clerk_%"))
                .add(members::Column::UserId.like("invited_%")),
        )
        .add(members::Column::DeletedAt.is_null())
}

async fn active_member(tenant: &PgPool, user_id: &str) -> Result<Option<Member>, DbErr> {
    member_rows()
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::DeletedAt.is_null())
        .into_model()
        .one(&orm(tenant))
        .await
}

/// `resolvePreservedRole`: an OWNER stays OWNER; guests and employees keep
/// their stored role.
fn preserved_role(existing: &Member, role: &'static str) -> String {
    if existing.role == "OWNER" {
        return "OWNER".to_owned();
    }
    if existing.kind == "EXTERNAL_GUEST" || existing.kind == "EMPLOYEE" {
        return existing.role.clone();
    }
    role.to_owned()
}

/// `syncTenantMemberForMembership`: the user's row, else the invitation
/// row for their email, else a new member (the first one is the OWNER).
async fn sync_tenant_member(
    tenant: &PgPool,
    existing: Option<Member>,
    identity: &MemberIdentity<'_>,
) -> Result<(), DbErr> {
    use members::Column;
    let db = orm(tenant);
    if let Some(existing) = existing {
        member_update(identity.name.as_deref())
            .col_expr(Column::Email, Expr::value(identity.email))
            .col_expr(
                Column::Role,
                Expr::value(preserved_role(&existing, identity.role)),
            )
            .col_expr(Column::Status, Expr::value("ACTIVE"))
            .col_expr(
                Column::ClerkMembershipId,
                Expr::value(identity.membership_id),
            )
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::Id.eq(existing.id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let pending: Option<Member> = if identity.email.is_empty() {
        None
    } else {
        member_rows()
            .filter(pending_for(identity.email))
            .into_model()
            .one(&db)
            .await?
    };
    release_removed_user_id(tenant, identity.user_id).await?;
    if let Some(pending) = pending {
        member_update(identity.name.as_deref())
            .col_expr(Column::UserId, Expr::value(identity.user_id))
            .col_expr(
                Column::Role,
                Expr::value(preserved_role(&pending, identity.role)),
            )
            .col_expr(Column::Status, Expr::value("ACTIVE"))
            .col_expr(
                Column::ClerkMembershipId,
                Expr::value(identity.membership_id),
            )
            .col_expr(Column::AcceptedAt, accepted_now())
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::Id.eq(pending.id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let count = members::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    let role = if count == 0 { "OWNER" } else { identity.role };
    members::Entity::insert(members::ActiveModel {
        id: Set(weldsuite_kit::generate_id("mbr")),
        user_id: Set(identity.user_id.to_owned()),
        email: Set(Some(identity.email.to_owned())),
        name: Set(identity.name.clone()),
        role: Set(role.to_owned()),
        status: Set("ACTIVE".to_owned()),
        clerk_membership_id: Set(Some(identity.membership_id.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await
    .map(drop)
}

/// An update of member rows that sets `name = coalesce($name, name)`: the
/// name only when there is one.
fn member_update(name: Option<&str>) -> sea_orm::UpdateMany<members::Entity> {
    let update = members::Entity::update_many();
    match name {
        Some(name) => update.col_expr(members::Column::Name, Expr::value(name)),
        None => update,
    }
}

/// `accepted_at = coalesce(accepted_at, now())`: an earlier acceptance is
/// kept.
fn accepted_now() -> Expr {
    Func::coalesce([
        Expr::col((members::Entity, members::Column::AcceptedAt)),
        Expr::current_timestamp(),
    ])
    .into()
}

/// `mapRoleToClerk`: the master row's role for a workspace role.
fn provider_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("ADMIN") || role.eq_ignore_ascii_case("OWNER") {
        "org:admin"
    } else {
        "org:member"
    }
}

/// Who signed in, from the master `users` row. No picture: the member row
/// keeps none (avatars are the account's, `users.image_url`).
#[derive(Debug, FromQueryResult)]
struct Person {
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
}

/// The tenant member of an SSO join: a pending row for the email (an
/// invitation from before) becomes them and keeps its role; otherwise a new
/// active member with `role`. Never the owner, even in an empty workspace.
async fn add_sso_member(
    tenant: &PgPool,
    user_id: &str,
    person: &Person,
    role: &str,
) -> Result<(), DbErr> {
    use members::Column;
    let name = [person.first_name.as_deref(), person.last_name.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name = Some(name).filter(|name| !name.is_empty());
    release_removed_user_id(tenant, user_id).await?;
    let db = orm(tenant);
    let pending: Option<String> = members::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(pending_for(&person.email))
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = pending {
        member_update(name.as_deref())
            .col_expr(Column::UserId, Expr::value(user_id))
            .col_expr(Column::Status, Expr::value("ACTIVE"))
            .col_expr(Column::AcceptedAt, accepted_now())
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::Id.eq(id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    members::Entity::insert(members::ActiveModel {
        id: Set(weldsuite_kit::generate_id("mbr")),
        user_id: Set(user_id.to_owned()),
        email: Set(Some(person.email.clone())),
        name: Set(name),
        role: Set(role.to_owned()),
        status: Set("ACTIVE".to_owned()),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await
    .map(drop)
}

/// `releaseRemovedMemberUserId`: a removed row that still holds the user id
/// gives it up (`user_id = 'removed_' || id`), so the user's new row can
/// take it.
async fn release_removed_user_id(tenant: &PgPool, user_id: &str) -> Result<(), DbErr> {
    use members::Column;
    members::Entity::update_many()
        .col_expr(
            Column::UserId,
            sea_orm::sea_query::extension::postgres::PgExpr::concat(
                Expr::val("removed_"),
                Expr::col((members::Entity, Column::Id)),
            ),
        )
        .filter(Column::UserId.eq(user_id))
        .filter(Column::DeletedAt.is_not_null())
        .exec(&orm(tenant))
        .await
        .map(drop)
}

/// `on conflict (id) do update` of the profile: the email unless the
/// provider's is empty, the names, the picture, `updated_at`.
fn profile_merge() -> OnConflict {
    use sea_orm::sea_query::extension::postgres::PgExpr;
    use users::Column;
    let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
    let current = |column: Column| Expr::col((users::Entity, column));
    // `case when excluded.email <> '' then excluded.email else users.email end`.
    let email = Expr::case(
        sea_orm::ExprTrait::ne(excluded(Column::Email), ""),
        excluded(Column::Email),
    )
    .finally(current(Column::Email));
    // A picture uploaded in WeldSuite (`PUT /settings/profile/avatar`, stored
    // as `…/avatars/<user id>_<ms>.<ext>`) is never on the provider: it wins
    // until the user uploads another (`strpos(coalesce(users.image_url, ''),
    // '/avatars/' || users.id || '_') > 0`). Otherwise the provider's
    // picture, when it has one (`coalesce(nullif(excluded.image_url, ''),
    // users.image_url)`).
    let marker = PgExpr::concat(
        PgExpr::concat(Expr::val("/avatars/"), current(Column::Id)),
        Expr::val("_"),
    );
    let uploaded = sea_orm::ExprTrait::gt(
        Expr::expr(Func::cust("strpos").args([
            Expr::expr(Func::coalesce([current(Column::ImageUrl), Expr::val("")])),
            marker,
        ])),
        0,
    );
    let provider = Func::coalesce([
        Expr::expr(Func::cust("nullif").args([excluded(Column::ImageUrl), Expr::val("")])),
        current(Column::ImageUrl),
    ]);
    let image = Expr::case(uploaded, current(Column::ImageUrl)).finally(provider);
    OnConflict::column(Column::Id)
        .value(Column::Email, email)
        .update_columns([Column::FirstName, Column::LastName])
        .value(Column::ImageUrl, image)
        .value(Column::UpdatedAt, Expr::current_timestamp())
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_events_become_one_action_per_user() {
        let event = |id: &str, kind: &str, user: Option<&str>| FeedEvent {
            id: id.to_owned(),
            kind: kind.to_owned(),
            user_id: user.map(str::to_owned),
            at: None,
            data: Value::Null,
        };
        let events = [
            event("1", "user.created", Some("usr_a")),
            event("2", "user.email_changed", Some("usr_a")),
            event("3", "user.updated", Some("usr_b")),
            event("4", "user.deleted", Some("usr_b")),
            event("5", "user.updated", Some("usr_b")),
            event("6", "session.revoked", Some("usr_c")),
            event("7", "user.renamed", Some("usr_d")),
            event("8", "user.updated", None),
            event("9", "user.updated", Some("")),
        ];
        let actions = feed_actions(&events);
        assert_eq!(
            actions.into_iter().collect::<Vec<_>>(),
            [
                ("usr_a".to_owned(), FeedAction::Refresh),
                ("usr_b".to_owned(), FeedAction::Delete),
            ]
        );
        assert_eq!(feed_action("session.revoked"), None);
        assert_eq!(feed_action("user.deleted"), Some(FeedAction::Delete));
    }

    #[test]
    fn sso_sign_ins_become_one_join_per_user_and_workspace() {
        let event = |id: &str, kind: &str, user: Option<&str>, data: Value| FeedEvent {
            id: id.to_owned(),
            kind: kind.to_owned(),
            user_id: user.map(str::to_owned),
            at: None,
            data,
        };
        let events = [
            event(
                "1",
                SSO_SIGNED_IN,
                Some("usr_a"),
                serde_json::json!({ "tenantRef": "ws_1", "connectionId": "ssoc_1", "created": true }),
            ),
            event(
                "2",
                SSO_SIGNED_IN,
                Some("usr_a"),
                serde_json::json!({ "tenantRef": "ws_1", "connectionId": "ssoc_1" }),
            ),
            event(
                "3",
                SSO_SIGNED_IN,
                None,
                serde_json::json!({ "user_id": "usr_b", "tenant_ref": "ws_1", "connection_id": "ssoc_1" }),
            ),
            event("4", SSO_SIGNED_IN, Some("usr_c"), Value::Null),
            event(
                "5",
                "user.created",
                Some("usr_d"),
                serde_json::json!({ "tenantRef": "ws_1" }),
            ),
        ];
        let joins = sso_joins(&events);
        assert_eq!(
            joins,
            [
                SsoJoin {
                    user_id: "usr_a".to_owned(),
                    tenant_ref: "ws_1".to_owned(),
                    connection_id: Some("ssoc_1".to_owned()),
                },
                SsoJoin {
                    user_id: "usr_b".to_owned(),
                    tenant_ref: "ws_1".to_owned(),
                    connection_id: Some("ssoc_1".to_owned()),
                },
            ]
        );
        assert_eq!(feed_action(SSO_SIGNED_IN), Some(FeedAction::Refresh));
        assert_eq!(provider_role("ADMIN"), "org:admin");
        assert_eq!(provider_role("VIEWER"), "org:member");
    }

    #[test]
    fn stepping_past_an_instant() {
        assert_eq!(
            step_past("2026-10-29T14:33:56.944508Z"),
            "2026-10-29T14:33:56.944509Z"
        );
        assert_eq!(step_past("nonsense"), "nonsense");
        assert_eq!(display_role("org:admin"), "ADMIN");
        assert_eq!(display_role("org:viewer"), "MEMBER");
    }
}
