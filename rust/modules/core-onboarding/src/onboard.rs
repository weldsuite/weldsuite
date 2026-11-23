//! The onboard service: the workspace worker's `runOnboard`
//! (`apps/workers/workspace-worker/src/routes/onboard.ts`), in process.
//!
//! 1. A best-effort lock in the cache against double submits.
//! 2. Unless a new organization is asked for, reuse the caller's first
//!    organization (signup dedupe): rename it and refresh its metadata.
//! 3. Otherwise create the organization with a slug of the workspace's name
//!    (a slug refusal is retried with a random suffix, then without one);
//!    the identity provider makes the caller its first admin.
//! 4. The workspace row on the Free plan (or the existing one), the plan's
//!    seat cap on the organization, and, unlike Global, the caller's
//!    `users` and `user_workspaces` rows inline: Clerk's webhooks write them
//!    there, the identity sync here, a minute later, so the first request
//!    after signup would otherwise find no membership.
//! 5. Start the `workspace.provision` job ([`crate::ProvisionJob`]). There
//!    is no warm pool (a CloudNativePG database takes seconds), so a new
//!    workspace is never `ready` at once: the client polls
//!    `/database-status`.
//!
//! Skipped from Global: the `{slug}.weldmail.com` mail domain (Cloudflare).

use std::sync::Arc;
use std::time::Duration;

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_ports::{
    Cache, DynCache, DynJobs, Identity, JobRequest, Jobs, NewOrganization, OrganizationChanges,
};
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{plans, user_workspaces, users, workspaces};

use crate::provision::{PROVISION_JOB, ProvisionPayload};
use crate::slug::{
    pick_new_org_slug, resolve_unique_slug, slugify_workspace_name, with_random_suffix,
};

/// The plan every new workspace starts on (`DEFAULT_PLAN_SLUG`).
pub(crate) const DEFAULT_PLAN_SLUG: &str = "free";

const ORG_FAILED: &str = "Failed to create organization. Please try again or contact support.";
const SOMETHING_WRONG: &str =
    "Something went wrong while setting up your workspace. Please try again or contact support.";

/// The workspace's first member (`initialMember`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialMember {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
}

/// `onboardSchema`, read from the loose object app-api builds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OnboardInput {
    pub(crate) clerk_user_id: String,
    pub(crate) workspace_name: String,
    pub(crate) region: Option<String>,
    pub(crate) organization_type: Option<String>,
    pub(crate) organization_size: Option<String>,
    pub(crate) referral_source: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) selected_apps: Option<Vec<String>>,
    pub(crate) initial_member: Option<InitialMember>,
    pub(crate) create_new_org: bool,
    pub(crate) seed_sample_data: Option<bool>,
}

impl OnboardInput {
    /// `onboardSchema.safeParse(input)`; `None` is "Validation failed".
    /// `firstName`, `lastName`, `productUpdates` and `role` are checked like
    /// the schema checks them, and not used further (nor are they there).
    pub(crate) fn parse(input: &Value) -> Option<Self> {
        let fields = input.as_object()?;
        let text = |key: &str| -> Result<Option<String>, ()> {
            match fields.get(key) {
                None => Ok(None),
                Some(Value::String(s)) => Ok(Some(s.clone())),
                Some(_) => Err(()),
            }
        };
        let flag = |key: &str| -> Result<Option<bool>, ()> {
            match fields.get(key) {
                None => Ok(None),
                Some(Value::Bool(b)) => Ok(Some(*b)),
                Some(_) => Err(()),
            }
        };
        let clerk_user_id = text("clerkUserId").ok()??;
        let workspace_name = text("workspaceName").ok()??;
        if clerk_user_id.is_empty() || workspace_name.is_empty() {
            return None;
        }
        for key in ["firstName", "lastName", "role"] {
            text(key).ok()?;
        }
        flag("productUpdates").ok()?;
        let selected_apps = match fields.get("selectedApps") {
            None => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
            ),
            Some(_) => return None,
        };
        let initial_member = match fields.get("initialMember") {
            None => None,
            Some(Value::Object(member)) => {
                let part = |key: &str| match member.get(key) {
                    None => Some(None),
                    Some(Value::String(s)) => Some(Some(s.clone())),
                    Some(_) => None,
                };
                Some(InitialMember {
                    email: part("email")?,
                    name: part("name")?,
                    picture: part("picture")?,
                })
            }
            Some(_) => return None,
        };
        Some(Self {
            clerk_user_id,
            workspace_name,
            region: text("region").ok()?,
            organization_type: text("organizationType").ok()?,
            organization_size: text("organizationSize").ok()?,
            referral_source: text("referralSource").ok()?,
            country: text("country").ok()?,
            selected_apps,
            initial_member,
            create_new_org: flag("createNewOrg").ok()?.unwrap_or(false),
            seed_sample_data: flag("seedSampleData").ok()?,
        })
    }

    /// The organization's public metadata: the fields that were sent
    /// (`JSON.stringify` drops the others).
    fn org_metadata(&self) -> Value {
        let mut metadata = Map::new();
        for (key, value) in [
            ("region", &self.region),
            ("country", &self.country),
            ("organizationType", &self.organization_type),
            ("organizationSize", &self.organization_size),
            ("referralSource", &self.referral_source),
        ] {
            if let Some(value) = value {
                metadata.insert(key.to_owned(), json!(value));
            }
        }
        if let Some(apps) = &self.selected_apps {
            metadata.insert("selectedApps".to_owned(), json!(apps));
        }
        Value::Object(metadata)
    }
}

/// `OnboardResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnboardOutcome {
    pub success: bool,
    pub workspace_id: Option<String>,
    pub clerk_org_id: Option<String>,
    pub already_provisioned: bool,
    pub ready: bool,
    pub error: Option<String>,
}

impl OnboardOutcome {
    fn failed(error: &str) -> Self {
        Self {
            error: Some(error.to_owned()),
            ..Self::default()
        }
    }
}

/// Creates workspaces: see the module docs.
pub struct WorkspaceService {
    master: PgPool,
    identity: Arc<dyn Identity>,
    jobs: Arc<dyn DynJobs>,
    cache: Option<Arc<dyn DynCache>>,
    /// How long a concurrent onboarding is given to register its
    /// organization (1.5 s, as the workers wait).
    concurrency_pause: Duration,
}

impl std::fmt::Debug for WorkspaceService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceService").finish_non_exhaustive()
    }
}

/// Why a step failed: logged, answered with [`SOMETHING_WRONG`].
type Failure = Box<dyn std::error::Error + Send + Sync>;

/// The organization's workspace: `id, neon_project_id, neon_role_name,
/// database_provisioned_at`.
type WorkspaceRow = (
    String,
    Option<String>,
    Option<String>,
    Option<PrimitiveDateTime>,
);

impl WorkspaceService {
    pub fn new(
        master: PgPool,
        identity: Arc<dyn Identity>,
        jobs: Arc<dyn DynJobs>,
        cache: Option<Arc<dyn DynCache>>,
    ) -> Self {
        Self {
            master,
            identity,
            jobs,
            cache,
            concurrency_pause: Duration::from_millis(1500),
        }
    }

    /// No pause before the dedupe (tests).
    #[must_use]
    pub fn without_concurrency_pause(mut self) -> Self {
        self.concurrency_pause = Duration::ZERO;
        self
    }

    /// `WORKSPACE_WORKER.onboard(input)`.
    pub async fn onboard(&self, input: &Value) -> OnboardOutcome {
        let Some(data) = OnboardInput::parse(input) else {
            tracing::error!("onboard: validation failed");
            return OnboardOutcome::failed("Validation failed");
        };
        let lock_key = format!("onboard:inflight:{}", data.clerk_user_id);
        let held = self.acquire_lock(&lock_key).await;
        let outcome = match self.run(&data).await {
            Ok(outcome) => outcome,
            Err(error) => {
                tracing::error!(%error, "onboard: failed");
                OnboardOutcome::failed(SOMETHING_WRONG)
            }
        };
        if held && let Some(cache) = &self.cache {
            let _ = cache.delete(&lock_key).await;
        }
        outcome
    }

    /// `acquireOnboardLock`: fails open.
    async fn acquire_lock(&self, key: &str) -> bool {
        let Some(cache) = &self.cache else {
            return false;
        };
        match cache.get(key).await {
            Ok(Some(_)) => {
                tracing::warn!("onboard: concurrent onboarding; waiting before dedupe");
                tokio::time::sleep(self.concurrency_pause).await;
                false
            }
            Ok(None) => cache
                .put(key, "1", Some(Duration::from_secs(120)))
                .await
                .is_ok(),
            Err(error) => {
                tracing::warn!(%error, "onboard: concurrency guard unavailable (proceeding)");
                false
            }
        }
    }

    async fn run(&self, data: &OnboardInput) -> Result<OnboardOutcome, Failure> {
        if !data.create_new_org
            && let Ok(memberships) = self.identity.user_memberships(&data.clerk_user_id, 1).await
            && let Some(existing) = memberships
                .into_iter()
                .find_map(|m| m.organization.map(|o| (o, m.role)))
        {
            let (org, role) = existing;
            self.update_existing_org(data, &org.id).await;
            return self
                .upsert_and_provision(data, &org.id, &org.slug, &role)
                .await;
        }

        let slug = pick_new_org_slug(&self.master, &data.workspace_name).await?;
        let metadata = data.org_metadata();
        let mut created = None;
        for attempt in [Some(slug.clone()), Some(with_random_suffix(&slug)), None] {
            let request = NewOrganization {
                name: data.workspace_name.clone(),
                slug: attempt.clone(),
                created_by: Some(data.clerk_user_id.clone()),
                public_metadata: Some(metadata.clone()),
                private_metadata: None,
            };
            match self.identity.create_organization(&request).await {
                Ok(org) => {
                    created = Some((org, attempt));
                    break;
                }
                Err(error) if attempt.is_some() && error.is_slug_error() => {
                    tracing::warn!(%error, "onboard: the provider refused the slug, retrying");
                }
                Err(error) => {
                    tracing::error!(%error, "onboard: failed to create the organization");
                    return Ok(OnboardOutcome::failed(ORG_FAILED));
                }
            }
        }
        let Some((org, attempt)) = created else {
            return Ok(OnboardOutcome::failed(ORG_FAILED));
        };
        let org_slug = org.slug.clone().or(attempt).unwrap_or_default();
        self.upsert_and_provision(data, &org.id, &org_slug, "org:admin")
            .await
    }

    /// `updateExistingClerkOrg`: the name, then the metadata (merged).
    /// Failures are logged; onboarding goes on.
    async fn update_existing_org(&self, data: &OnboardInput, org: &str) {
        let rename = OrganizationChanges {
            name: Some(data.workspace_name.clone()),
            ..OrganizationChanges::default()
        };
        if let Err(error) = self.identity.update_organization(org, &rename).await {
            tracing::warn!(%error, "onboard: could not rename the organization");
        }
        let metadata = data.org_metadata();
        if let Err(error) = self
            .identity
            .update_organization_metadata(org, Some(&metadata), None)
            .await
        {
            tracing::error!(%error, "onboard: could not update the organization's metadata");
        }
    }

    /// `upsertAndProvision`.
    async fn upsert_and_provision(
        &self,
        data: &OnboardInput,
        org: &str,
        org_slug: &str,
        role: &str,
    ) -> Result<OnboardOutcome, Failure> {
        let master = orm(&self.master);
        let existing: Option<WorkspaceRow> = workspaces::Entity::find()
            .select_only()
            .columns([
                workspaces::Column::Id,
                workspaces::Column::NeonProjectId,
                workspaces::Column::NeonRoleName,
                workspaces::Column::DatabaseProvisionedAt,
            ])
            .filter(workspaces::Column::ClerkOrgId.eq(org))
            .into_tuple()
            .one(&master)
            .await?;
        // A row that never finished provisioning starts it again (recovery).
        let workspace_id = if let Some((id, project, role_name, provisioned_at)) = existing {
            if project.is_some() && role_name.is_some() && provisioned_at.is_some() {
                self.record_membership(data, &id, role).await;
                return Ok(OnboardOutcome {
                    success: true,
                    workspace_id: Some(id),
                    clerk_org_id: Some(org.to_owned()),
                    already_provisioned: true,
                    ready: true,
                    error: None,
                });
            }
            workspaces::Entity::update_many()
                .col_expr(
                    workspaces::Column::Name,
                    Expr::value(data.workspace_name.as_str()),
                )
                .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                .filter(workspaces::Column::Id.eq(&id))
                .exec(&master)
                .await?;
            (id, true)
        } else {
            (self.create_workspace_row(data, org, org_slug).await?, false)
        };
        let (workspace_id, restart) = workspace_id;
        self.record_membership(data, &workspace_id, role).await;
        self.start_provisioning(data, &workspace_id, org_slug, restart)
            .await?;
        Ok(OnboardOutcome {
            success: true,
            workspace_id: Some(workspace_id),
            clerk_org_id: Some(org.to_owned()),
            already_provisioned: false,
            ready: false,
            error: None,
        })
    }

    /// `createWorkspaceRow`: on the Free plan, with the plan's seat cap
    /// synced to the organization (in the background, failures logged).
    async fn create_workspace_row(
        &self,
        data: &OnboardInput,
        org: &str,
        org_slug: &str,
    ) -> Result<String, Failure> {
        let master = orm(&self.master);
        let plan: Option<(String, Option<i32>)> = plans::Entity::find()
            .select_only()
            .columns([plans::Column::Id, plans::Column::MaxUsers])
            .filter(plans::Column::Slug.eq(DEFAULT_PLAN_SLUG))
            .filter(plans::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&master)
            .await?;
        let workspace_id = weldsuite_kit::generate_id("ws");
        let base = if org_slug.is_empty() {
            slugify_workspace_name(&data.workspace_name)
        } else {
            org_slug.to_owned()
        };
        let slug = resolve_unique_slug(&self.master, &base, &workspace_id).await?;
        workspaces::Entity::insert(workspaces::ActiveModel {
            id: Set(workspace_id.clone()),
            clerk_org_id: Set(Some(org.to_owned())),
            name: Set(data.workspace_name.clone()),
            slug: Set(slug),
            plan_id: Set(plan.as_ref().map(|(id, _)| id.clone())),
            is_active: Set(true),
            paid_plan_required: Set(false),
            ..Default::default()
        })
        .exec_without_returning(&master)
        .await?;
        tracing::info!(workspace_id, org, "onboard: created the workspace");
        if let Some(max) = plan.and_then(|(_, max)| max).filter(|max| *max > 0) {
            let identity = Arc::clone(&self.identity);
            let org = org.to_owned();
            tokio::spawn(async move {
                let cap = OrganizationChanges {
                    max_memberships: Some(i64::from(max)),
                    ..OrganizationChanges::default()
                };
                if let Err(error) = identity.update_organization(&org, &cap).await {
                    tracing::warn!(%error, "onboard: could not set the seat cap (non-blocking)");
                }
            });
        }
        Ok(workspace_id)
    }

    /// The caller's master rows, written now instead of by the identity
    /// sync: `users` (from the provider's profile, else what onboarding
    /// knows) and `user_workspaces`. Failures are logged: the sync writes
    /// them a minute later.
    async fn record_membership(&self, data: &OnboardInput, workspace_id: &str, role: &str) {
        let profile = self.identity.user_profile(&data.clerk_user_id).await.ok();
        let member = data.initial_member.clone().unwrap_or_default();
        let email = profile
            .as_ref()
            .and_then(|p| p.primary_email().map(str::to_owned))
            .or(member.email)
            .unwrap_or_default();
        let written = async {
            users::Entity::insert(users::ActiveModel {
                id: Set(data.clerk_user_id.clone()),
                email: Set(email),
                first_name: Set(profile.as_ref().and_then(|p| p.first_name.clone())),
                last_name: Set(profile.as_ref().and_then(|p| p.last_name.clone())),
                image_url: Set(profile
                    .as_ref()
                    .and_then(|p| p.image_url.clone())
                    .or(member.picture)),
                ..Default::default()
            })
            .on_conflict(
                OnConflict::column(users::Column::Id)
                    .do_nothing()
                    .to_owned(),
            )
            .exec_without_returning(&orm(&self.master))
            .await?;
            upsert_user_workspace(&self.master, &data.clerk_user_id, workspace_id, None, role).await
        };
        if let Err(error) = written.await {
            tracing::warn!(%error, workspace_id, "onboard: could not record the membership yet");
        }
    }

    /// Start (or restart) the provisioning job. A failure to start is
    /// recorded as `failed` so the onboarding screen offers a retry.
    pub(crate) async fn start_provisioning(
        &self,
        data: &OnboardInput,
        workspace_id: &str,
        slug: &str,
        retry: bool,
    ) -> Result<(), Failure> {
        let payload = ProvisionPayload {
            workspace_id: workspace_id.to_owned(),
            workspace_name: Some(data.workspace_name.clone()),
            initial_member_user_id: data.clerk_user_id.clone(),
            initial_member: data.initial_member.clone(),
            selected_apps: data.selected_apps.clone(),
            slug: Some(slug.to_owned()).filter(|s| !s.is_empty()),
            seed_sample_data: data.seed_sample_data,
        };
        // One run per key: the first start is keyed by the workspace; a retry
        // after a failed run needs a key of its own.
        let key = if retry {
            format!(
                "provision-{workspace_id}-{}",
                time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
            )
        } else {
            format!("provision-{workspace_id}")
        };
        let started = match JobRequest::new(PROVISION_JOB, key, &payload) {
            Ok(request) => self.jobs.start(request).await,
            Err(error) => Err(error),
        };
        if let Err(error) = started {
            let message: String = format!("{error}").chars().take(1000).collect();
            tracing::error!(%error, workspace_id, "onboard: provisioning failed to start");
            workspaces::Entity::update_many()
                .col_expr(
                    workspaces::Column::ProvisioningStatus,
                    Expr::value("failed"),
                )
                .col_expr(workspaces::Column::ProvisioningError, Expr::value(message))
                .col_expr(workspaces::Column::UpdatedAt, Expr::current_timestamp())
                .filter(workspaces::Column::Id.eq(workspace_id))
                .exec(&orm(&self.master))
                .await?;
        }
        Ok(())
    }
}

/// `upsertMasterUserWorkspace`: the master membership row, active. An
/// existing row keeps its membership id when none is given, and its
/// `joined_at`.
pub(crate) async fn upsert_user_workspace(
    master: &PgPool,
    user_id: &str,
    workspace_id: &str,
    membership_id: Option<&str>,
    role: &str,
) -> Result<(), DbErr> {
    use user_workspaces::Column;
    let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
    let current = |column: Column| Expr::col((user_workspaces::Entity, column));
    let merge = OnConflict::columns([Column::UserId, Column::WorkspaceId])
        .value(
            Column::ClerkMembershipId,
            Func::coalesce([
                excluded(Column::ClerkMembershipId),
                current(Column::ClerkMembershipId),
            ]),
        )
        .value(Column::Role, excluded(Column::Role))
        // The value as the `membership_status` enum.
        .value(
            Column::Status,
            Column::Status.save_as(Expr::value(MembershipStatus::ACTIVE)),
        )
        .value(
            Column::JoinedAt,
            Func::coalesce([current(Column::JoinedAt), excluded(Column::JoinedAt)]),
        )
        .value(Column::UpdatedAt, Expr::current_timestamp())
        .to_owned();
    user_workspaces::Entity::insert(user_workspaces::ActiveModel {
        id: Set(weldsuite_kit::generate_id("uw")),
        user_id: Set(user_id.to_owned()),
        workspace_id: Set(workspace_id.to_owned()),
        clerk_membership_id: Set(membership_id.map(str::to_owned)),
        role: Set(role.to_owned()),
        status: Set(MembershipStatus::ACTIVE),
        joined_at: Set(Some(utc_now())),
        ..Default::default()
    })
    .on_conflict(merge)
    .exec_without_returning(&orm(master))
    .await
    .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_input_follows_the_onboard_schema() {
        let parsed = OnboardInput::parse(&json!({
            "clerkUserId": "user_1",
            "workspaceName": "Acme",
            "firstName": "Ana",
            "selectedApps": ["crm"],
            "initialMember": { "email": "a@b.test", "name": "Ana" },
            "createNewOrg": true,
        }))
        .expect("valid");
        assert!(parsed.create_new_org);
        assert_eq!(parsed.selected_apps, Some(vec!["crm".to_owned()]));
        assert_eq!(parsed.org_metadata(), json!({ "selectedApps": ["crm"] }));
        for invalid in [
            json!(null),
            json!({ "clerkUserId": "u", "workspaceName": "" }),
            json!({ "clerkUserId": "u" }),
            json!({ "clerkUserId": "u", "workspaceName": "A", "region": 1 }),
            json!({ "clerkUserId": "u", "workspaceName": "A", "selectedApps": [1] }),
            json!({ "clerkUserId": "u", "workspaceName": "A", "productUpdates": "yes" }),
        ] {
            assert_eq!(OnboardInput::parse(&invalid), None, "{invalid}");
        }
    }
}
