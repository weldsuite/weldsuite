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
//! | user | profile → `users` and the member rows' name and picture (`user.created`/`updated`); gone → deactivated, memberships removed (`user.deleted`); and each of the user's memberships, below (an accepted invitation shows up as the user verifying their email) |
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
//! name, picture and email; `user.deleted` deactivates the user and removes
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

use serde::Serialize;
use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_ports::{
    DatabaseProvisioner, FeedEvent, Identity, IdentityChange, IdentityError, ListPage, Membership,
    Teardown, UserProfile,
};

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

/// A tenant member row, as the reconcile reads it.
#[derive(Debug, sqlx::FromRow)]
struct Member {
    id: String,
    role: String,
    #[sqlx(rename = "member_type")]
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

    async fn watermark(&self, key: &str) -> Result<Option<String>, sqlx::Error> {
        let value: Option<Option<Value>> =
            sqlx::query_scalar("select value from system_settings where key = $1 limit 1")
                .bind(key)
                .fetch_optional(&self.master)
                .await?;
        Ok(value
            .flatten()
            .and_then(|value| value.as_str().map(str::to_owned)))
    }

    async fn store_watermark(&self, key: &str, at: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "insert into system_settings (id, key, category, value, description, data_type)
             values ($1, $2, 'integrations', $3, 'The identity sync has handled the provider''s changes up to here', 'string')
             on conflict (key) do update set value = excluded.value, updated_at = now()",
        )
        .bind(weldsuite_kit::generate_id("sset"))
        .bind(key)
        .bind(Value::String(at.to_owned()))
        .execute(&self.master)
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
                let _ = sqlx::query(
                    "update workspace_members set email = $2, updated_at = now()
                      where user_id = $1 and deleted_at is null and email is distinct from $2",
                )
                .bind(user_id)
                .bind(email)
                .execute(&tenant)
                .await;
            }
        }
        Outcome::Done
    }

    /// An SSO sign-in's join: the workspace's tenant member with the default
    /// role for SSO members, then the master membership. Someone already in
    /// keeps their role; a workspace that is gone is skipped.
    async fn sso_join(&self, join: &SsoJoin) -> Outcome {
        let workspace: Result<Option<(String, Option<String>)>, sqlx::Error> = sqlx::query_as(
            "select id, clerk_org_id from workspaces
              where (id = $1 or clerk_org_id = $1) and deleted_at is null
              order by (id = $1) desc limit 1",
        )
        .bind(&join.tenant_ref)
        .fetch_optional(&self.master)
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
        let master_role: Result<Option<(String, String)>, sqlx::Error> = sqlx::query_as(
            "select status::text, role from user_workspaces where user_id = $1 and workspace_id = $2",
        )
        .bind(&join.user_id)
        .bind(&workspace_id)
        .fetch_optional(&self.master)
        .await;
        let master_role = match master_role {
            Ok(row) => row
                .filter(|(status, _)| status == "ACTIVE")
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
                Err(error) => return error.into(),
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
        let stored: Option<Person> = sqlx::query_as(
            "select email, first_name, last_name, image_url from users where id = $1",
        )
        .bind(user_id)
        .fetch_optional(&self.master)
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
            image_url: profile.image_url,
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
    /// member rows' name and picture.
    async fn store_profile(&self, user_id: &str, profile: &UserProfile) -> Result<(), Outcome> {
        let email = profile.primary_email().unwrap_or_default().to_owned();
        sqlx::query(
            "insert into users (id, email, first_name, last_name, image_url)
             values ($1, $2, $3, $4, $5)
             on conflict (id) do update
                set email = case when excluded.email <> '' then excluded.email else users.email end,
                    first_name = excluded.first_name, last_name = excluded.last_name,
                    image_url = excluded.image_url, updated_at = now()",
        )
        .bind(user_id)
        .bind(&email)
        .bind(&profile.first_name)
        .bind(&profile.last_name)
        .bind(&profile.image_url)
        .execute(&self.master)
        .await
        .map_err(Outcome::from)?;
        let full_name = [profile.first_name.as_deref(), profile.last_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        self.update_member_names(user_id, &full_name, profile.image_url.as_deref())
            .await;
        Ok(())
    }

    /// `handleUserUpdated`'s tenant half: only values the provider has
    /// (early events carry empty names), best effort per workspace.
    async fn update_member_names(&self, user_id: &str, name: &str, picture: Option<&str>) {
        let picture = picture.filter(|p| !p.is_empty());
        if name.is_empty() && picture.is_none() {
            return;
        }
        for (workspace, org) in self.workspaces_of(user_id).await {
            let Ok(tenant) = (self.tenants)(org.unwrap_or(workspace)).await else {
                continue;
            };
            let _ = sqlx::query(
                "update workspace_members
                    set name = case when $2 <> '' then $2 else name end,
                        picture = coalesce($3, picture), updated_at = now()
                  where user_id = $1 and deleted_at is null",
            )
            .bind(user_id)
            .bind(name)
            .bind(picture)
            .execute(&tenant)
            .await;
        }
    }

    async fn workspaces_of(&self, user_id: &str) -> Vec<(String, Option<String>)> {
        sqlx::query_as(
            "select w.id, w.clerk_org_id from user_workspaces uw
               join workspaces w on w.id = uw.workspace_id
              where uw.user_id = $1",
        )
        .bind(user_id)
        .fetch_all(&self.master)
        .await
        .unwrap_or_default()
    }

    /// `handleUserDeleted`.
    async fn user_deleted(&self, user_id: &str) -> Result<(), sqlx::Error> {
        let workspaces = self.workspaces_of(user_id).await;
        sqlx::query("update users set is_active = false, updated_at = now() where id = $1")
            .bind(user_id)
            .execute(&self.master)
            .await?;
        sqlx::query("delete from user_workspaces where user_id = $1")
            .bind(user_id)
            .execute(&self.master)
            .await?;
        for (workspace, org) in workspaces {
            if let Ok(tenant) = (self.tenants)(org.unwrap_or(workspace)).await {
                let _ = sqlx::query(
                    "update workspace_members set deleted_at = now(), updated_at = now()
                      where user_id = $1 and deleted_at is null",
                )
                .bind(user_id)
                .execute(&tenant)
                .await;
            }
        }
        Ok(())
    }

    // ── organizations ───────────────────────────────────────────────────

    async fn organization(&self, org: &str) -> Outcome {
        let workspace: Result<Option<(String, Option<String>)>, sqlx::Error> =
            sqlx::query_as("select id, slug from workspaces where clerk_org_id = $1 limit 1")
                .bind(org)
                .fetch_optional(&self.master)
                .await;
        let workspace = match workspace {
            Ok(Some(workspace)) => workspace,
            Ok(None) => return Outcome::Done,
            Err(error) => return error.into(),
        };
        match self.identity.organization(org).await {
            // `handleOrganizationUpdated`: the slug only when the provider
            // keeps one.
            Ok(organization) => sqlx::query(
                "update workspaces set name = $2, slug = coalesce($3, slug), updated_at = now()
                  where id = $1",
            )
            .bind(&workspace.0)
            .bind(&organization.name)
            .bind(organization.slug.filter(|s| !s.is_empty()))
            .execute(&self.master)
            .await
            .map_or_else(Outcome::from, |_| Outcome::Done),
            Err(error) if error.is_not_found() => self.organization_deleted(&workspace.0).await,
            Err(error) => retry_unless_refused(error),
        }
    }

    /// `handleOrganizationDeleted`: marked deleted (an earlier stamp kept),
    /// memberships removed, then the database torn down. A database move in
    /// progress defers it all; a failed teardown is retried by the next run
    /// (the teardown sweep is the backstop).
    async fn organization_deleted(&self, workspace_id: &str) -> Outcome {
        let moving: Result<bool, sqlx::Error> = sqlx::query_scalar(
            "select exists (select 1 from workspace_database_moves
                             where workspace_id = $1 and status = any($2))",
        )
        .bind(workspace_id)
        .bind(crate::sweeps::active_move_statuses())
        .fetch_one(&self.master)
        .await;
        match moving {
            Ok(false) => {}
            Ok(true) => return Outcome::Retry("a database move is in progress".into()),
            Err(error) => return error.into(),
        }
        let marked = async {
            sqlx::query(
                "update workspaces set is_active = false, deleted_at = coalesce(deleted_at, now()),
                        updated_at = now() where id = $1",
            )
            .bind(workspace_id)
            .execute(&self.master)
            .await?;
            sqlx::query("delete from user_workspaces where workspace_id = $1")
                .bind(workspace_id)
                .execute(&self.master)
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
        let workspace: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
            "select id from workspaces where clerk_org_id = $1 and deleted_at is null limit 1",
        )
        .bind(org)
        .fetch_optional(&self.master)
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
            sqlx::query(
                "insert into users (id, email, first_name, last_name, image_url)
                 values ($1, $2, $3, $4, $5) on conflict (id) do nothing",
            )
            .bind(user_id)
            .bind(&membership.user.identifier)
            .bind(&membership.user.first_name)
            .bind(&membership.user.last_name)
            .bind(&membership.user.image_url)
            .execute(&self.master)
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
            picture: membership.user.image_url.as_deref(),
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
        let existing: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
            "select id from workspace_members
              where lower(email) = lower($1)
                and (status = 'PENDING' or user_id like 'pending_clerk_%' or user_id like 'invited_%')
                and deleted_at is null
              limit 1",
        )
        .bind(email)
        .fetch_optional(&tenant)
        .await;
        let written = match existing {
            Ok(Some(id)) => {
                sqlx::query(
                    "update workspace_members
                        set clerk_invitation_id = $2,
                            invited_at = coalesce(invited_at, now()), updated_at = now(),
                            role = case when role = 'OWNER' then role else $3 end
                      where id = $1",
                )
                .bind(id)
                .bind(invitation_id)
                .bind(role)
                .execute(&tenant)
                .await
            }
            Ok(None) => {
                sqlx::query(
                    "insert into workspace_members
                       (id, user_id, email, role, status, clerk_invitation_id, invited_at)
                     values ($1, $2, $3, $4, 'PENDING', $5, now())",
                )
                .bind(weldsuite_kit::generate_id("mbr"))
                .bind(format!("pending_clerk_{invitation_id}"))
                .bind(email)
                .bind(role)
                .bind(invitation_id)
                .execute(&tenant)
                .await
            }
            Err(error) => Err(error),
        };
        written.map_or_else(Outcome::from, |_| Outcome::Done)
    }

    /// `handleMembershipDeleted` (and a revoked invitation's PENDING row).
    async fn membership_removed(&self, workspace_id: &str, org: &str, user_id: &str) -> Outcome {
        let removed =
            sqlx::query("delete from user_workspaces where user_id = $1 and workspace_id = $2")
                .bind(user_id)
                .bind(workspace_id)
                .execute(&self.master)
                .await;
        if let Err(error) = removed {
            return error.into();
        }
        let Ok(tenant) = (self.tenants)(org.to_owned()).await else {
            return Outcome::Done;
        };
        let pending = format!("{user_id}:%");
        sqlx::query(
            "update workspace_members set deleted_at = now(), updated_at = now()
              where deleted_at is null
                and (user_id = $1 or (status = 'PENDING' and clerk_invitation_id like $2))",
        )
        .bind(user_id)
        .bind(pending)
        .execute(&tenant)
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

/// What a membership says about its member.
struct MemberIdentity<'a> {
    user_id: &'a str,
    email: &'a str,
    name: Option<String>,
    picture: Option<&'a str>,
    role: &'static str,
    membership_id: &'a str,
}

const MEMBER_COLUMNS: &str = "id, role, member_type";

async fn active_member(tenant: &PgPool, user_id: &str) -> Result<Option<Member>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select {MEMBER_COLUMNS} from workspace_members
          where user_id = $1 and deleted_at is null limit 1"
    )))
    .bind(user_id)
    .fetch_optional(tenant)
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
) -> Result<(), sqlx::Error> {
    if let Some(existing) = existing {
        sqlx::query(
            "update workspace_members
                set email = $2, name = coalesce($3, name), picture = coalesce($4, picture),
                    role = $5, status = 'ACTIVE', clerk_membership_id = $6, updated_at = now()
              where id = $1",
        )
        .bind(&existing.id)
        .bind(identity.email)
        .bind(&identity.name)
        .bind(identity.picture)
        .bind(preserved_role(&existing, identity.role))
        .bind(identity.membership_id)
        .execute(tenant)
        .await?;
        return Ok(());
    }
    let pending: Option<Member> = if identity.email.is_empty() {
        None
    } else {
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {MEMBER_COLUMNS} from workspace_members
              where lower(email) = lower($1)
                and (status = 'PENDING' or user_id like 'pending_clerk_%' or user_id like 'invited_%')
                and deleted_at is null
              limit 1"
        )))
        .bind(identity.email)
        .fetch_optional(tenant)
        .await?
    };
    release_removed_user_id(tenant, identity.user_id).await?;
    if let Some(pending) = pending {
        sqlx::query(
            "update workspace_members
                set user_id = $2, name = coalesce($3, name), picture = coalesce($4, picture),
                    role = $5, status = 'ACTIVE', clerk_membership_id = $6,
                    accepted_at = coalesce(accepted_at, now()), updated_at = now()
              where id = $1",
        )
        .bind(&pending.id)
        .bind(identity.user_id)
        .bind(&identity.name)
        .bind(identity.picture)
        .bind(preserved_role(&pending, identity.role))
        .bind(identity.membership_id)
        .execute(tenant)
        .await?;
        return Ok(());
    }
    let count: i64 =
        sqlx::query_scalar("select count(*) from workspace_members where deleted_at is null")
            .fetch_one(tenant)
            .await?;
    let role = if count == 0 { "OWNER" } else { identity.role };
    sqlx::query(
        "insert into workspace_members
           (id, user_id, email, name, picture, role, status, clerk_membership_id)
         values ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)",
    )
    .bind(weldsuite_kit::generate_id("mbr"))
    .bind(identity.user_id)
    .bind(identity.email)
    .bind(&identity.name)
    .bind(identity.picture)
    .bind(role)
    .bind(identity.membership_id)
    .execute(tenant)
    .await
    .map(drop)
}

/// `mapRoleToClerk`: the master row's role for a workspace role.
fn provider_role(role: &str) -> &'static str {
    if role.eq_ignore_ascii_case("ADMIN") || role.eq_ignore_ascii_case("OWNER") {
        "org:admin"
    } else {
        "org:member"
    }
}

/// Who signed in, from the master `users` row.
#[derive(Debug, sqlx::FromRow)]
struct Person {
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    image_url: Option<String>,
}

/// The tenant member of an SSO join: a pending row for the email (an
/// invitation from before) becomes them and keeps its role; otherwise a new
/// active member with `role`. Never the owner, even in an empty workspace.
async fn add_sso_member(
    tenant: &PgPool,
    user_id: &str,
    person: &Person,
    role: &str,
) -> Result<(), sqlx::Error> {
    let name = [person.first_name.as_deref(), person.last_name.as_deref()]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let name = Some(name).filter(|name| !name.is_empty());
    release_removed_user_id(tenant, user_id).await?;
    let pending: Option<String> = sqlx::query_scalar(
        "select id from workspace_members
          where lower(email) = lower($1)
            and (status = 'PENDING' or user_id like 'pending_clerk_%' or user_id like 'invited_%')
            and deleted_at is null
          limit 1",
    )
    .bind(&person.email)
    .fetch_optional(tenant)
    .await?;
    if let Some(id) = pending {
        sqlx::query(
            "update workspace_members
                set user_id = $2, name = coalesce($3, name), picture = coalesce($4, picture),
                    status = 'ACTIVE', accepted_at = coalesce(accepted_at, now()), updated_at = now()
              where id = $1",
        )
        .bind(id)
        .bind(user_id)
        .bind(&name)
        .bind(&person.image_url)
        .execute(tenant)
        .await?;
        return Ok(());
    }
    sqlx::query(
        "insert into workspace_members (id, user_id, email, name, picture, role, status)
         values ($1, $2, $3, $4, $5, $6, 'ACTIVE')",
    )
    .bind(weldsuite_kit::generate_id("mbr"))
    .bind(user_id)
    .bind(&person.email)
    .bind(&name)
    .bind(&person.image_url)
    .bind(role)
    .execute(tenant)
    .await
    .map(drop)
}

/// `releaseRemovedMemberUserId`: a removed row that still holds the user id
/// gives it up, so the user's new row can take it.
async fn release_removed_user_id(tenant: &PgPool, user_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update workspace_members set user_id = 'removed_' || id
          where user_id = $1 and deleted_at is not null",
    )
    .bind(user_id)
    .execute(tenant)
    .await
    .map(drop)
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
