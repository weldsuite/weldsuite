//! The hand-written SQL against the real schema: databases built from the
//! journaled Drizzle migrations by `scripts/rust-test-db.ts` (CI does that).
//! `tests/postgres.rs` checks behaviour on a cut-down schema; this checks that
//! every column and table the queries name exists with a usable type, so a
//! migration that renames one fails here before it fails a request.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set; otherwise it returns early.

use weldsuite_db::{
    Keyring, ReadOnlyReason, TenantPermissionQueries, WorkspaceConfig, Workspaces, master_pool,
};
use weldsuite_permissions::resolve_effective_permissions;

#[tokio::test]
async fn master_and_tenant_queries_run_on_the_migrated_schema() {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let master = master_pool(&master_url, 2).expect("master pool");
    let tenant = master_pool(&tenant_url, 2).expect("tenant pool");

    sqlx::raw_sql(
        r"delete from workspace_database_moves where workspace_id = 'ws_schema';
          delete from workspace_licences where workspace_id = 'ws_schema';
          delete from workspaces where id = 'ws_schema';
          delete from partners where id = 'ptr_schema';
          insert into partners (id, name, billing_email, status)
              values ('ptr_schema', 'Schema partner', 'p@example.com', 'active');
          insert into workspaces (id, name, slug, clerk_org_id, billing_mode, partner_id)
              values ('ws_schema', 'Schema check', 'schema-check', 'org_schema', 'partner', 'ptr_schema');
          insert into workspace_licences (id, workspace_id, partner_id, resale_pricing, allowed_apps, status)
              values ('wl_schema', 'ws_schema', 'ptr_schema', '{}', '[]', 'suspended');",
    )
    .execute(&master)
    .await
    .expect("seed master");
    sqlx::query("update workspaces set database_url = $1 where id = 'ws_schema'")
        .bind(&tenant_url)
        .execute(&master)
        .await
        .expect("tenant url");

    sqlx::raw_sql(
        r#"delete from workspace_members where id = 'wm_schema';
          delete from roles where id = 'role_schema';
          insert into roles (id, name, is_system, permissions)
              values ('role_schema', 'Schema', false, '["leads:read"]');
          insert into workspace_members (id, user_id, email, role, role_id, permissions, status)
              values ('wm_schema', 'user_schema', 's@example.com', 'MEMBER', 'role_schema',
                      '["team:read"]', 'ACTIVE');"#,
    )
    .execute(&tenant)
    .await
    .expect("seed tenant");

    let workspaces = Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig::default(),
    );
    let resolved = workspaces.tenant("org_schema").await.expect("resolves");
    assert_eq!(resolved.workspace_id, "ws_schema");
    assert_eq!(
        resolved.read_only_reason(),
        Some(ReadOnlyReason::LicenceInactive)
    );

    let queries = TenantPermissionQueries::new(resolved.db.clone());
    let member = resolve_effective_permissions(&queries, "user_schema")
        .await
        .expect("resolves");
    assert_eq!(member.permissions, ["leads:read", "team:read"]);

    let access = weldsuite_pipeline::read_app_access(&master, "org_schema", "weldreach")
        .await
        .expect("app access reads");
    assert_eq!(access.workspace_id.as_deref(), Some("ws_schema"));
    assert_eq!(access.status, "none");
}
