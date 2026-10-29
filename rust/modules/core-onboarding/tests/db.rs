//! Onboarding's service, provisioning job, identity sync and sweeps against
//! the real schema (built from the journaled migrations by
//! `scripts/rust-test-db.ts`), with the in-memory identity provider and a
//! provisioner that hands out the test's tenant database.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL`
//! are set; otherwise every test returns early. The tests share one tenant
//! database, so the ones that write its singletons run in one test.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_core_onboarding::{
    IdentitySync, PROVISION_JOB, ProvisionJob, ProvisionPayload, SyncReport, TenantDatabases,
    WATERMARK_KEY, WorkspaceService, sweep_scheduled_deletions, sweep_unfinished_teardowns,
};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner, DatabaseUrl, DynJobs, Identity, IdentityCall, IdentityChange,
    Job, JobContext, JobError, JobRequest, Jobs, MemberUser, Membership, MemoryIdentity,
    Organization, Placement, PortError, ProvisionError, ProvisionRequest, ProvisionedDatabase,
    StepFn, StepRetry, Teardown, UserProfile,
};

fn databases() -> Option<(PgPool, PgPool, String)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        master_pool(&master, 4).expect("master"),
        master_pool(&tenant, 4).expect("tenant"),
        tenant,
    ))
}

/// Runs each step once, as a job's first attempt does.
struct Once;

impl JobContext for Once {
    fn key(&self) -> &'static str {
        "test"
    }

    fn run_step<'s>(
        &'s self,
        _name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        step()
    }
}

/// Records the jobs started.
#[derive(Default)]
struct RecordedJobs(Mutex<Vec<JobRequest>>);

impl Jobs for RecordedJobs {
    fn start(&self, request: JobRequest) -> impl Future<Output = Result<(), PortError>> + Send {
        self.0.lock().expect("lock").push(request);
        std::future::ready(Ok(()))
    }
}

/// Places every workspace on the test's tenant database (a plain URL, as
/// the kind smoke test stores it), or fails when told to.
struct TestProvisioner {
    master: PgPool,
    url: String,
    fail: Mutex<Option<String>>,
}

impl DatabaseProvisioner for TestProvisioner {
    fn provision<'a>(
        &'a self,
        request: &'a ProvisionRequest,
    ) -> BoxFuture<'a, Result<ProvisionedDatabase, ProvisionError>> {
        Box::pin(async move {
            if let Some(message) = self.fail.lock().expect("lock").take() {
                return Err(ProvisionError::Shard(message.into()));
            }
            let ws = &request.workspace_id;
            sqlx::query(
                "update workspaces set neon_project_id = 'cnpg:test', neon_role_name = $2,
                        neon_database_name = $3, database_url = $4 where id = $1",
            )
            .bind(ws)
            .bind(format!("role_{ws}"))
            .bind(format!("ws_{ws}"))
            .bind(&self.url)
            .execute(&self.master)
            .await
            .map_err(|error| ProvisionError::Master(error.into()))?;
            Ok(ProvisionedDatabase {
                workspace_id: ws.clone(),
                placement: placement(ws),
                database_url: DatabaseUrl::new(self.url.clone()),
                created: true,
                migrations_applied: 3,
                schema_version: None,
            })
        })
    }

    fn teardown<'a>(
        &'a self,
        workspace_id: &'a str,
    ) -> BoxFuture<'a, Result<Teardown, ProvisionError>> {
        Box::pin(async move {
            sqlx::query("update workspaces set neon_project_id = null where id = $1")
                .bind(workspace_id)
                .execute(&self.master)
                .await
                .map_err(|error| ProvisionError::Master(error.into()))?;
            Ok(Teardown::Dropped(placement(workspace_id)))
        })
    }
}

fn placement(ws: &str) -> Placement {
    Placement {
        shard_id: "nsp_test".to_owned(),
        shard_name: "test".to_owned(),
        database_name: format!("ws_{ws}"),
        role_name: format!("role_{ws}"),
    }
}

fn tenants(tenant: &PgPool) -> TenantDatabases {
    let tenant = tenant.clone();
    Arc::new(move |_| {
        let tenant = tenant.clone();
        Box::pin(async move { Ok(tenant) })
    })
}

fn profile(id: &str, email: &str, first: &str) -> UserProfile {
    UserProfile {
        id: id.to_owned(),
        email_addresses: vec![("e1".to_owned(), email.to_owned())],
        primary_email_address_id: Some("e1".to_owned()),
        first_name: Some(first.to_owned()),
        last_name: Some("Silva".to_owned()),
        image_url: None,
    }
}

async fn free_plan(master: &PgPool) {
    sqlx::query(
        "insert into plans (id, name, slug, max_users, monthly_credits)
         values ('plan_onb_free', 'Free', 'free', 1, 100)
         on conflict (id) do nothing",
    )
    .execute(master)
    .await
    .expect("plan");
}

async fn workspace_row(master: &PgPool, ws: &str) -> Value {
    sqlx::query_scalar("select to_jsonb(w) from workspaces w where id = $1")
        .bind(ws)
        .fetch_one(master)
        .await
        .expect("workspace")
}

#[tokio::test(flavor = "multi_thread")]
async fn signup_creates_the_organization_the_workspace_and_starts_provisioning() {
    let Some((master, _, _)) = databases() else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / _TENANT_URL not set; skipping");
        return;
    };
    free_plan(&master).await;
    // The in-memory provider numbers its organizations from 1 on every run.
    sqlx::query("delete from workspaces where name like 'Acme %'")
        .execute(&master)
        .await
        .expect("clean");
    let user = format!("user_onbsvc_{}", std::process::id());
    let identity =
        Arc::new(MemoryIdentity::new().with_profile(profile(&user, "ana@acme.test", "Ana")));
    let jobs = Arc::new(RecordedJobs::default());
    let service = WorkspaceService::new(
        master.clone(),
        Arc::clone(&identity) as Arc<dyn Identity>,
        Arc::clone(&jobs) as Arc<dyn DynJobs>,
        None,
    )
    .without_concurrency_pause();
    let name = format!("Acme {}", std::process::id());
    let input = json!({
        "clerkUserId": user,
        "workspaceName": name,
        "firstName": "Ana",
        "selectedApps": ["crm"],
        "country": "NL",
        "initialMember": { "email": "ana@acme.test", "name": "Ana Silva" },
    });
    let first = service.onboard(&input).await;
    assert!(first.success, "{first:?}");
    assert!(!first.ready);
    let org = first.clerk_org_id.clone().expect("org");
    let ws = first.workspace_id.clone().expect("workspace");

    let created = identity.organization_now(&org).expect("org");
    assert_eq!(created.name, name);
    assert_eq!(
        created.public_metadata,
        json!({ "country": "NL", "selectedApps": ["crm"] })
    );
    let row = workspace_row(&master, &ws).await;
    assert_eq!(row["clerk_org_id"], json!(org));
    assert_eq!(row["plan_id"], json!("plan_onb_free"));
    assert_eq!(row["provisioning_status"], json!("pending"));
    assert_eq!(
        row["slug"],
        created.slug.clone().map_or(Value::Null, Value::String)
    );
    // The caller's master rows are written now, not a minute later.
    let membership: (String, String) = sqlx::query_as(
        "select role, status::text from user_workspaces where user_id = $1 and workspace_id = $2",
    )
    .bind(&user)
    .bind(&ws)
    .fetch_one(&master)
    .await
    .expect("membership");
    assert_eq!(membership, ("org:admin".to_owned(), "ACTIVE".to_owned()));
    let email: String = sqlx::query_scalar("select email from users where id = $1")
        .bind(&user)
        .fetch_one(&master)
        .await
        .expect("user");
    assert_eq!(email, "ana@acme.test");

    let started = jobs.0.lock().expect("lock").clone();
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].name, PROVISION_JOB);
    assert_eq!(started[0].key, format!("provision-{ws}"));
    let payload: ProvisionPayload =
        serde_json::from_value(started[0].payload.clone()).expect("payload");
    assert_eq!(payload.initial_member_user_id, user);
    assert_eq!(payload.selected_apps, Some(vec!["crm".to_owned()]));

    // A second submit reuses the organization (signup dedupe) and starts
    // provisioning again under a key of its own.
    let again = service.onboard(&input).await;
    assert_eq!(again.workspace_id.as_deref(), Some(ws.as_str()));
    assert_eq!(again.clerk_org_id.as_deref(), Some(org.as_str()));
    let started = jobs.0.lock().expect("lock").clone();
    assert_eq!(started.len(), 2);
    assert!(started[1].key.starts_with(&format!("provision-{ws}-")));
    assert_eq!(
        identity
            .calls()
            .iter()
            .filter(|call| matches!(call, IdentityCall::CreateOrganization(_)))
            .count(),
        1
    );

    // Invalid input answers like the RPC's schema check.
    let invalid = service.onboard(&json!({ "clerkUserId": user })).await;
    assert_eq!(invalid.error.as_deref(), Some("Validation failed"));
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one workspace's life, in order
async fn provisioning_the_sync_and_the_sweeps() {
    let Some((master, tenant, tenant_url)) = databases() else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / _TENANT_URL not set; skipping");
        return;
    };
    free_plan(&master).await;
    let suffix = std::process::id();
    let ws = format!("ws_onbjob_{suffix}");
    let org = format!("org_onbjob_{suffix}");
    let user = format!("user_onbjob_{suffix}");
    sqlx::raw_sql(
        "delete from workspace_members; delete from workspace_installed_apps;
         delete from task_digest_settings;",
    )
    .execute(&tenant)
    .await
    .ok();
    sqlx::query("delete from system_settings where key = $1")
        .bind(WATERMARK_KEY)
        .execute(&master)
        .await
        .expect("watermark");
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, name, slug, plan_id) values ($1, $2, 'Job Co', $3, 'plan_onb_free')",
    )
    .bind(&ws)
    .bind(&org)
    .bind(format!("job-co-{suffix}"))
    .execute(&master)
    .await
    .expect("workspace");

    let provisioner = Arc::new(TestProvisioner {
        master: master.clone(),
        url: tenant_url.clone(),
        fail: Mutex::new(Some("shard down".to_owned())),
    });
    let identity = Arc::new(
        MemoryIdentity::new()
            .with_organization(Organization {
                id: org.clone(),
                name: "Job Co".to_owned(),
                slug: Some(format!("job-co-{suffix}")),
                ..Organization::default()
            })
            .with_profile(profile(&user, "owner@job.test", "Olga")),
    );
    let job = ProvisionJob::new(
        master.clone(),
        Arc::clone(&provisioner) as Arc<dyn DatabaseProvisioner>,
        tenants(&tenant),
        Some(Arc::clone(&identity) as Arc<dyn Identity>),
    );
    let payload = serde_json::to_value(ProvisionPayload {
        workspace_id: ws.clone(),
        workspace_name: Some("Job Co".to_owned()),
        initial_member_user_id: user.clone(),
        initial_member: Some(weldsuite_core_onboarding::InitialMember {
            email: Some("owner@job.test".to_owned()),
            name: Some("Olga Silva".to_owned()),
            picture: None,
        }),
        selected_apps: Some(vec!["crm".to_owned(), "helpdesk".to_owned()]),
        slug: None,
        seed_sample_data: None,
    })
    .expect("payload");

    // A failed run marks the workspace failed, with the reason.
    assert!(job.run(&Once, payload.clone()).await.is_err());
    let row = workspace_row(&master, &ws).await;
    assert_eq!(row["provisioning_status"], json!("failed"));
    assert!(
        row["provisioning_error"]
            .as_str()
            .is_some_and(|e| e.contains("shard down"))
    );

    // The retry finishes: ready, the owner, the apps, the digest, credits.
    job.run(&Once, payload.clone()).await.expect("provisioned");
    let row = workspace_row(&master, &ws).await;
    assert_eq!(row["provisioning_status"], json!("ready"));
    assert_eq!(row["provisioning_error"], Value::Null);
    assert!(row["database_provisioned_at"].is_string());
    let owner: (String, String, String) =
        sqlx::query_as("select role, status, email from workspace_members where user_id = $1")
            .bind(&user)
            .fetch_one(&tenant)
            .await
            .expect("owner");
    assert_eq!(
        owner,
        (
            "OWNER".to_owned(),
            "ACTIVE".to_owned(),
            "owner@job.test".to_owned()
        )
    );
    let apps: Vec<String> =
        sqlx::query_scalar("select app_code from workspace_installed_apps order by app_code")
            .fetch_all(&tenant)
            .await
            .expect("apps");
    assert_eq!(apps, ["crm", "helpdesk"]);
    let timezone: String =
        sqlx::query_scalar("select timezone from digest_schedules where workspace_id = $1")
            .bind(&ws)
            .fetch_one(&master)
            .await
            .expect("digest");
    assert_eq!(timezone, "Europe/Amsterdam");
    let wallet: (i32, i32) = sqlx::query_as(
        "select current_balance, monthly_allocation from workspace_credits where workspace_id = $1",
    )
    .bind(&ws)
    .fetch_one(&master)
    .await
    .expect("credits");
    assert_eq!(wallet, (100, 100));

    // Running it again changes nothing twice (no second owner, allocation).
    job.run(&Once, payload).await.expect("again");
    let counts: (i64, i64) = sqlx::query_as(
        "select (select count(*) from credit_transactions where workspace_id = $1),
                (select current_balance from workspace_credits where workspace_id = $1)::bigint",
    )
    .bind(&ws)
    .fetch_one(&master)
    .await
    .expect("counts");
    assert_eq!(counts, (1, 100));

    // ── the identity sync ──
    // A teammate joined (their membership), the owner renamed themselves,
    // the organization was renamed.
    let mate = format!("user_onbmate_{suffix}");
    let identity = sync_identity(&org, &user, &mate, suffix);
    let sync = IdentitySync::new(
        master.clone(),
        Arc::clone(&identity) as Arc<dyn Identity>,
        tenants(&tenant),
        Some(Arc::clone(&provisioner) as Arc<dyn DatabaseProvisioner>),
    );
    identity.record_change(
        "2026-10-29T10:00:00.000001Z",
        IdentityChange::User {
            user_id: user.clone(),
            removed: false,
        },
    );
    identity.record_change(
        "2026-10-29T10:00:01Z",
        IdentityChange::Membership {
            org: org.clone(),
            user_id: mate.clone(),
        },
    );
    identity.record_change(
        "2026-10-29T10:00:02Z",
        IdentityChange::Organization {
            org: org.clone(),
            removed: false,
        },
    );
    let report = sync.run().await.expect("sync");
    assert_eq!(
        report,
        SyncReport {
            changes: 3,
            users: 1,
            organizations: 1,
            memberships: 2,
            failed: 0,
            watermark: Some("2026-10-29T10:00:02Z".to_owned()),
        }
    );
    let renamed: String = sqlx::query_scalar("select name from workspaces where id = $1")
        .bind(&ws)
        .fetch_one(&master)
        .await
        .expect("name");
    assert_eq!(renamed, "Job Co Renamed");
    let owner: (String, Option<String>) =
        sqlx::query_as("select role, name from workspace_members where user_id = $1")
            .bind(&user)
            .fetch_one(&tenant)
            .await
            .expect("owner");
    // The owner stays OWNER whatever role the provider has.
    assert_eq!(owner, ("OWNER".to_owned(), Some("Olga Petrova".to_owned())));
    let mate_row: (String, String) =
        sqlx::query_as("select role, status from workspace_members where user_id = $1")
            .bind(&mate)
            .fetch_one(&tenant)
            .await
            .expect("teammate");
    assert_eq!(mate_row, ("MEMBER".to_owned(), "ACTIVE".to_owned()));
    let master_rows: i64 =
        sqlx::query_scalar("select count(*) from user_workspaces where workspace_id = $1")
            .bind(&ws)
            .fetch_one(&master)
            .await
            .expect("memberships");
    assert_eq!(master_rows, 2);
    // Nothing new: the watermark stays, the last change is read again.
    let quiet = sync.run().await.expect("again");
    assert_eq!(quiet.watermark.as_deref(), Some("2026-10-29T10:00:02Z"));

    // The teammate leaves; then the organization is deleted.
    identity.remove_user(&mate);
    identity.record_change(
        "2026-10-29T10:00:03Z",
        IdentityChange::Membership {
            org: org.clone(),
            user_id: mate.clone(),
        },
    );
    sync.run().await.expect("left");
    let left: Option<String> =
        sqlx::query_scalar("select deleted_at::text from workspace_members where user_id = $1")
            .bind(&mate)
            .fetch_one(&tenant)
            .await
            .expect("left");
    assert!(left.is_some());

    identity
        .delete_organization(&org)
        .await
        .expect("org deleted");
    identity.record_change(
        "2026-10-29T10:00:04Z",
        IdentityChange::Organization {
            org: org.clone(),
            removed: true,
        },
    );
    sync.run().await.expect("deleted");
    let row = workspace_row(&master, &ws).await;
    assert_eq!(row["is_active"], json!(false));
    assert!(row["deleted_at"].is_string());
    assert_eq!(
        row["neon_project_id"],
        Value::Null,
        "the database was torn down"
    );

    // ── the sweeps ──
    // The teardown sweep retries an unfinished teardown past its margin.
    sqlx::query("update workspaces set neon_project_id = 'cnpg:test', deleted_at = now() - interval '3 days' where id = $1")
        .bind(&ws)
        .execute(&master)
        .await
        .expect("unfinished");
    let swept = sweep_unfinished_teardowns(
        &master,
        &(Arc::clone(&provisioner) as Arc<dyn DatabaseProvisioner>),
        Duration::from_hours(48),
    )
    .await;
    assert!(swept.succeeded >= 1, "{swept:?}");
    assert_eq!(
        workspace_row(&master, &ws).await["neon_project_id"],
        Value::Null
    );

    // The deletion sweep deletes the organization of a workspace past its
    // scheduled date, and stamps it.
    let due = format!("ws_onbdue_{suffix}");
    let due_org = format!("org_onbdue_{suffix}");
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, name, slug, scheduled_deletion_at)
         values ($1, $2, 'Due Co', $3, now() - interval '1 day')",
    )
    .bind(&due)
    .bind(&due_org)
    .bind(format!("due-co-{suffix}"))
    .execute(&master)
    .await
    .expect("due");
    let deletions =
        sweep_scheduled_deletions(&master, &(Arc::clone(&identity) as Arc<dyn Identity>))
            .await
            .expect("sweep");
    assert!(deletions.succeeded >= 1, "{deletions:?}");
    assert!(
        identity
            .calls()
            .contains(&IdentityCall::DeleteOrganization(due_org.clone()))
    );
    let row = workspace_row(&master, &due).await;
    assert_eq!(row["is_active"], json!(false));
    assert!(row["deleted_at"].is_string());
}

/// The provider after the workspace exists: the owner (renamed) and a
/// teammate, the organization renamed.
fn sync_identity(org: &str, owner: &str, mate: &str, suffix: u32) -> Arc<MemoryIdentity> {
    let member = |user_id: &str, role: &str, email: &str, first: &str| Membership {
        id: format!("mem_{user_id}"),
        role: role.to_owned(),
        user: MemberUser {
            user_id: user_id.to_owned(),
            first_name: Some(first.to_owned()),
            last_name: Some("Petrova".to_owned()),
            identifier: email.to_owned(),
            image_url: None,
        },
        ..Membership::default()
    };
    let mut renamed = profile(owner, "owner@job.test", "Olga");
    renamed.last_name = Some("Petrova".to_owned());
    Arc::new(
        MemoryIdentity::new()
            .with_organization(Organization {
                id: org.to_owned(),
                name: "Job Co Renamed".to_owned(),
                slug: Some(format!("job-co-{suffix}")),
                ..Organization::default()
            })
            .with_membership(org, member(owner, "org:member", "owner@job.test", "Olga"))
            .with_membership(org, member(mate, "org:member", "mate@job.test", "Max"))
            .with_profile(renamed)
            .with_profile(profile(mate, "mate@job.test", "Max")),
    )
}
