//! `weldsuite admin access` and `staff` against the real schema: the master
//! and tenant databases CI builds from the journaled migrations.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set (CI's `Rust · checks`); otherwise it returns early. The databases are
//! shared with other tests, so every row here has its own ids and is deleted
//! at the end.

use serde_json::json;
use sqlx::PgPool;
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_reach_domain::schemas::Limits;
use weldsuite_staff_domain::StaffError;
use weldsuite_staff_domain::access::{
    self, AccessAction, AccessFilter, Decision, Effects, LimitsPatch, LimitsRequest,
};
use weldsuite_staff_domain::staff::{self, NewStaff, StaffRole};

struct Fixture {
    master: PgPool,
    tenant: PgPool,
    tenant_url: String,
    suffix: String,
    staff: String,
    viewer: String,
    superadmin: String,
    app: String,
    /// This test added the weldreach catalog row, so it removes it again.
    added_weldreach: bool,
}

impl Fixture {
    fn workspace(&self, name: &str) -> String {
        format!("ws_{name}_{}", self.suffix)
    }

    async fn add_workspace(&self, name: &str, requested: Option<&str>) {
        let id = self.workspace(name);
        sqlx::query(
            "insert into workspaces (id, name, slug, database_url) values ($1, $2, $1, $3)",
        )
        .bind(&id)
        .bind(format!("Acme {name}"))
        .bind(&self.tenant_url)
        .execute(&self.master)
        .await
        .expect("workspace");
        if let Some(app) = requested {
            sqlx::query(
                "insert into workspace_app_access
                     (id, workspace_id, app_code, status, request, requested_by, requested_at)
                 values ($1, $2, $3, 'requested', $4, $5, now())",
            )
            .bind(generate_id("waa"))
            .bind(&id)
            .bind(app)
            .bind(json!({
                "companyName": format!("Acme {name}"),
                "contactEmail": format!("contact-{}@example.com", self.suffix),
                "contactName": "Lisa",
            }))
            .bind(format!("user_{}", self.suffix))
            .execute(&self.master)
            .await
            .expect("request");
        }
    }

    /// The catalog rows approvals need: weldreach, and an app of this run.
    async fn add_catalog(&mut self) {
        for code in ["weldreach".to_owned(), self.app.clone()] {
            let added = sqlx::query(
                "insert into app_catalog (id, code, name, description, icon, category, path)
                 values ($1, $2, $2, 'test', 'Mail', 'test', '/test')
                 on conflict (code) do nothing",
            )
            .bind(generate_id("app"))
            .bind(&code)
            .execute(&self.master)
            .await
            .expect("catalog")
            .rows_affected();
            if code == "weldreach" {
                self.added_weldreach = added == 1;
            }
        }
    }

    async fn status(&self, workspace: &str, app: &str) -> Option<String> {
        sqlx::query_scalar(
            "select status from workspace_app_access where workspace_id = $1 and app_code = $2",
        )
        .bind(self.workspace(workspace))
        .bind(app)
        .fetch_optional(&self.master)
        .await
        .expect("status")
    }

    async fn audit(&self, workspace: &str, action: &str, outcome: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*) from admin_audit_events
             where workspace_id = $1 and action = $2 and outcome = $3 and actor_user_id = 'cli'",
        )
        .bind(self.workspace(workspace))
        .bind(action)
        .bind(outcome)
        .fetch_one(&self.master)
        .await
        .expect("audit")
    }

    async fn clean_up(&self) {
        let pattern = format!("%{}%", self.suffix);
        for statement in [
            "delete from workspace_app_access where workspace_id like $1",
            "delete from admin_audit_events where workspace_id like $1 or target_id like $1",
            "delete from workspaces where id like $1",
            "delete from users where id like $1",
            "delete from admin_users where email like $1",
            "delete from app_catalog where code like $1",
        ] {
            sqlx::query(statement)
                .bind(&pattern)
                .execute(&self.master)
                .await
                .expect(statement);
        }
        if self.added_weldreach {
            sqlx::query("delete from app_catalog where code = 'weldreach'")
                .execute(&self.master)
                .await
                .expect("catalog clean-up");
        }
        sqlx::query("delete from workspace_installed_apps where app_code = $1")
            .bind(&self.app)
            .execute(&self.tenant)
            .await
            .expect("tenant clean-up");
    }
}

fn decision<'a>(workspace: &'a str, app_code: &'a str, action: AccessAction) -> Decision<'a> {
    Decision {
        workspace,
        app_code,
        action,
        reason: "B2B, own customer list",
        dry_run: false,
    }
}

async fn fixture() -> Option<Fixture> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL are not set; skipping");
        return None;
    };
    let master = master_pool(&master_url, 4).expect("master pool");
    let tenant = PgPool::connect(&tenant_url).await.expect("tenant");
    let suffix = generate_id("").to_lowercase();
    let fixture = Fixture {
        staff: format!("staff-{suffix}@weldsuite.org"),
        viewer: format!("viewer-{suffix}@weldsuite.org"),
        superadmin: format!("super-{suffix}@weldsuite.org"),
        app: format!("tapp-{suffix}"),
        master,
        tenant,
        tenant_url,
        suffix,
        added_weldreach: false,
    };
    for (email, role) in [
        (&fixture.staff, "admin"),
        (&fixture.viewer, "viewer"),
        (&fixture.superadmin, "superadmin"),
    ] {
        sqlx::query("insert into admin_users (id, email, role) values ($1, $2, $3::admin_role)")
            .bind(generate_id("adm"))
            .bind(email)
            .bind(role)
            .execute(&fixture.master)
            .await
            .expect("staff");
    }
    sqlx::query("insert into users (id, email) values ($1, $2)")
        .bind(format!("user_{}", fixture.suffix))
        .bind(format!("requester-{}@example.com", fixture.suffix))
        .execute(&fixture.master)
        .await
        .expect("user");
    Some(fixture)
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one walk through every action on shared fixtures"
)]
async fn staff_decide_access_with_an_audit_row_each() {
    let Some(mut f) = fixture().await else { return };
    f.add_catalog().await;
    f.add_workspace("reach", Some("weldreach")).await;
    f.add_workspace("tapp", Some(&f.app)).await;
    f.add_workspace("grant", None).await;

    // Only active, non-viewer staff write.
    assert!(matches!(
        staff::writer(&f.master, &f.viewer).await,
        Err(StaffError::Refused(_))
    ));
    assert!(
        staff::actor(&f.master, "nobody@weldsuite.org")
            .await
            .is_err()
    );
    let actor = staff::writer(&f.master, &f.staff.to_uppercase())
        .await
        .expect("staff");
    assert_eq!(actor.role, StaffRole::Admin);

    let reach = f.workspace("reach");
    let reach = reach.as_str();

    // A dry run plans and writes nothing.
    let planned = access::decide(
        &f.master,
        &actor,
        Decision {
            dry_run: true,
            ..decision(reach, "weldreach", AccessAction::Approve)
        },
        Effects::default(),
    )
    .await
    .expect("dry run");
    assert!(!planned.applied);
    assert_eq!(planned.update.limits, Some(Limits::default()));
    assert_eq!(
        f.status("reach", "weldreach").await.as_deref(),
        Some("requested")
    );

    // Approve: status, reviewer, WeldReach's default limits, the audit row.
    // No mail transport and no tenant access here: both are warnings.
    let approved = access::decide(
        &f.master,
        &actor,
        decision(reach, "weldreach", AccessAction::Approve),
        Effects::default(),
    )
    .await
    .expect("approve");
    assert!(approved.applied);
    let row = approved.access.expect("row");
    assert_eq!(
        (row.status.as_str(), row.reviewed_by.as_deref()),
        ("approved", Some(f.staff.as_str()))
    );
    assert!(!row.limits_unset);
    assert_eq!(row.limits.max_mailboxes, 10);
    assert_eq!(approved.warnings.len(), 2, "{:?}", approved.warnings);
    assert_eq!(f.audit("reach", "app_access.approve", "success").await, 1);

    // A refused transition is a failure row and changes nothing.
    let refused = access::decide(
        &f.master,
        &actor,
        decision(reach, "weldreach", AccessAction::Reject),
        Effects::default(),
    )
    .await;
    match refused {
        Err(StaffError::Refused(message)) => {
            assert_eq!(message, "Cannot reject access that is approved.");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(f.audit("reach", "app_access.reject", "failure").await, 1);

    // Suspend with a reason the workspace sees; unsuspend clears it; revoke.
    let suspended = access::decide(
        &f.master,
        &actor,
        decision(reach, "weldreach", AccessAction::Suspend),
        Effects::default(),
    )
    .await
    .expect("suspend");
    assert_eq!(
        suspended.access.and_then(|a| a.suspended_reason).as_deref(),
        Some("B2B, own customer list")
    );
    let unsuspended = access::decide(
        &f.master,
        &actor,
        decision(reach, "weldreach", AccessAction::Unsuspend),
        Effects::default(),
    )
    .await
    .expect("unsuspend");
    assert_eq!(unsuspended.access.and_then(|a| a.suspended_reason), None);

    // Limits: only what is named changes, and it is recorded.
    let patch = LimitsPatch {
        max_mailboxes: Some("25".to_owned()),
        ..LimitsPatch::default()
    };
    let limits = access::set_limits(
        &f.master,
        &actor,
        LimitsRequest {
            workspace: reach,
            app_code: "weldreach",
            patch: &patch,
            reason: "More inboxes for the launch",
            dry_run: false,
        },
    )
    .await
    .expect("limits");
    assert_eq!(
        (limits.before.max_mailboxes, limits.after.max_mailboxes),
        (10, 25)
    );
    assert_eq!(limits.after.max_domains, 3);
    let stored: serde_json::Value =
        sqlx::query_scalar("select limits from workspace_app_access where workspace_id = $1")
            .bind(reach)
            .fetch_one(&f.master)
            .await
            .expect("limits row");
    assert_eq!(stored["maxMailboxes"], 25);
    assert_eq!(
        f.audit("reach", "app_access.limits_update", "success")
            .await,
        1
    );

    access::decide(
        &f.master,
        &actor,
        decision(reach, "weldreach", AccessAction::Revoke),
        Effects::default(),
    )
    .await
    .expect("revoke");
    assert_eq!(
        f.status("reach", "weldreach").await.as_deref(),
        Some("revoked")
    );

    // Approval installs the app in the workspace's own database.
    let tenants = Workspaces::new(
        f.master.clone(),
        Keyring::default(),
        WorkspaceConfig::default(),
    );
    let tapp = f.workspace("tapp");
    let (tapp, app) = (tapp.as_str(), f.app.as_str());
    let installed = access::decide(
        &f.master,
        &actor,
        decision(tapp, app, AccessAction::Approve),
        Effects {
            tenants: Some(&tenants),
            ..Effects::default()
        },
    )
    .await
    .expect("approve with install");
    assert_eq!(
        installed.warnings.len(),
        1,
        "only the email: {:?}",
        installed.warnings
    );
    assert_eq!(installed.update.limits, None, "no limits for another app");
    let active: Option<bool> =
        sqlx::query_scalar("select is_active from workspace_installed_apps where app_code = $1")
            .bind(&f.app)
            .fetch_optional(&f.tenant)
            .await
            .expect("installed");
    assert_eq!(active, Some(true));

    // Staff may grant without a request, but not for an unknown app, and
    // nothing but approval starts a row.
    let grant = f.workspace("grant");
    let grant = grant.as_str();
    let unknown = access::decide(
        &f.master,
        &actor,
        decision(grant, "no-such-app", AccessAction::Approve),
        Effects::default(),
    )
    .await;
    assert!(matches!(unknown, Err(StaffError::Refused(m)) if m.contains("Unknown app")));
    let not_asked = access::decide(
        &f.master,
        &actor,
        decision(grant, "weldreach", AccessAction::Suspend),
        Effects::default(),
    )
    .await;
    assert!(matches!(not_asked, Err(StaffError::Refused(m)) if m.contains("has not asked")));
    let granted = access::decide(
        &f.master,
        &actor,
        decision(grant, "weldreach", AccessAction::Approve),
        Effects::default(),
    )
    .await
    .expect("grant");
    assert_eq!(granted.from, "none");
    assert_eq!(
        granted.warnings.len(),
        1,
        "no email without a request: {:?}",
        granted.warnings
    );

    // The list finds rows by slug.
    let listed = access::list(
        &f.master,
        &AccessFilter {
            search: Some(&f.suffix),
            ..AccessFilter::default()
        },
    )
    .await
    .expect("list");
    assert_eq!(listed.len(), 3);

    assert!(
        access::find_workspace(&f.master, "ws_nope_nope")
            .await
            .is_err()
    );
    f.clean_up().await;
}

#[tokio::test]
async fn only_a_superadmin_changes_the_staff_list() {
    let Some(f) = fixture().await else { return };
    let admin = staff::writer(&f.master, &f.staff).await.expect("admin");
    let superadmin = staff::writer(&f.master, &f.superadmin)
        .await
        .expect("superadmin");
    let newcomer = format!("new-{}@weldsuite.org", f.suffix);
    let new = NewStaff {
        email: &newcomer,
        role: StaffRole::Admin,
        name: Some("New Person"),
    };

    assert!(
        staff::add(&f.master, Some(&admin), &new, "joins support", false)
            .await
            .is_err()
    );
    // Rows exist, so nobody acting is refused: bootstrap is for an empty list.
    assert!(
        staff::add(&f.master, None, &new, "joins support", false)
            .await
            .is_err()
    );

    let added = staff::add(&f.master, Some(&superadmin), &new, "joins support", false)
        .await
        .expect("add");
    assert!(added.applied && added.after.is_active);
    assert_eq!(added.after.role, StaffRole::Admin);
    assert!(staff::writer(&f.master, &newcomer).await.is_ok());

    let removed = staff::remove(&f.master, &superadmin, &newcomer, "left the team", false)
        .await
        .expect("remove");
    assert!(!removed.after.is_active);
    assert!(staff::actor(&f.master, &newcomer).await.is_err());
    let rows: i64 = sqlx::query_scalar(
        "select count(*) from admin_audit_events where target_id = $1 and action in ('staff.add', 'staff.remove')",
    )
    .bind(&newcomer)
    .fetch_one(&f.master)
    .await
    .expect("audit");
    assert_eq!(rows, 2);
    f.clean_up().await;
}
