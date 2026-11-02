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

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{
    Cache, DynCache, DynJobs, Identity, JobRequest, Jobs, NewOrganization, OrganizationChanges,
};

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
        let existing: Option<(String, Option<String>, Option<String>, bool)> = sqlx::query_as(
            "select id, neon_project_id, neon_role_name, database_provisioned_at is not null
               from workspaces where clerk_org_id = $1 limit 1",
        )
        .bind(org)
        .fetch_optional(&self.master)
        .await?;
        // A row that never finished provisioning starts it again (recovery).
        let workspace_id = if let Some((id, project, role_name, provisioned)) = existing {
            if project.is_some() && role_name.is_some() && provisioned {
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
            sqlx::query("update workspaces set name = $2, updated_at = now() where id = $1")
                .bind(&id)
                .bind(&data.workspace_name)
                .execute(&self.master)
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
        let plan: Option<(String, Option<i32>)> = sqlx::query_as(
            "select id, max_users from plans where slug = $1 and deleted_at is null limit 1",
        )
        .bind(DEFAULT_PLAN_SLUG)
        .fetch_optional(&self.master)
        .await?;
        let workspace_id = weldsuite_kit::generate_id("ws");
        let base = if org_slug.is_empty() {
            slugify_workspace_name(&data.workspace_name)
        } else {
            org_slug.to_owned()
        };
        let slug = resolve_unique_slug(&self.master, &base, &workspace_id).await?;
        sqlx::query(
            "insert into workspaces (id, clerk_org_id, name, slug, plan_id, is_active, paid_plan_required)
             values ($1, $2, $3, $4, $5, true, false)",
        )
        .bind(&workspace_id)
        .bind(org)
        .bind(&data.workspace_name)
        .bind(&slug)
        .bind(plan.as_ref().map(|(id, _)| id.as_str()))
        .execute(&self.master)
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
            sqlx::query(
                "insert into users (id, email, first_name, last_name, image_url)
                 values ($1, $2, $3, $4, $5)
                 on conflict (id) do nothing",
            )
            .bind(&data.clerk_user_id)
            .bind(&email)
            .bind(profile.as_ref().and_then(|p| p.first_name.clone()))
            .bind(profile.as_ref().and_then(|p| p.last_name.clone()))
            .bind(
                profile
                    .as_ref()
                    .and_then(|p| p.image_url.clone())
                    .or(member.picture),
            )
            .execute(&self.master)
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
            sqlx::query(
                "update workspaces set provisioning_status = 'failed', provisioning_error = $2,
                        updated_at = now() where id = $1",
            )
            .bind(workspace_id)
            .bind(message)
            .execute(&self.master)
            .await?;
        }
        Ok(())
    }
}

/// `upsertMasterUserWorkspace`: the master membership row, active.
pub(crate) async fn upsert_user_workspace(
    master: &PgPool,
    user_id: &str,
    workspace_id: &str,
    membership_id: Option<&str>,
    role: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into user_workspaces (id, user_id, workspace_id, clerk_membership_id, role, status, joined_at)
         values ($1, $2, $3, $4, $5, 'ACTIVE', now())
         on conflict (user_id, workspace_id) do update
            set clerk_membership_id = coalesce(excluded.clerk_membership_id, user_workspaces.clerk_membership_id),
                role = excluded.role, status = 'ACTIVE',
                joined_at = coalesce(user_workspaces.joined_at, excluded.joined_at),
                updated_at = now()",
    )
    .bind(weldsuite_kit::generate_id("uw"))
    .bind(user_id)
    .bind(workspace_id)
    .bind(membership_id)
    .bind(role)
    .execute(master)
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
