//! Workspace resolution and the permission lookups against a real Postgres.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a throwaway database (CI
//! starts one); otherwise each test returns early. The tables are the columns
//! this crate reads, cut down from the Drizzle schema in
//! `packages/core/db/src/schema/`; master and tenant tables share the one
//! database, since their names don't collide.

use weldsuite_db::{
    Keyring, ReadOnlyReason, TenantPermissionQueries, WorkspaceConfig, WorkspaceError, Workspaces,
    master_pool,
};
use weldsuite_permissions::resolve_effective_permissions;

const SCHEMA: &str = "
drop table if exists workspaces, workspace_licences, partners, workspace_database_moves,
    workspace_members, roles cascade;
create table partners (id varchar(30) primary key, status varchar(20) not null default 'active');
create table workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    database_url text,
    is_active boolean not null default true,
    billing_mode varchar(20) not null default 'direct',
    partner_id varchar(30)
);
create table workspace_licences (
    workspace_id varchar(255) not null unique,
    allowed_apps jsonb not null default '[]',
    status varchar(20) not null default 'active'
);
create table workspace_database_moves (
    workspace_id varchar(255) not null,
    status varchar(20) not null default 'queued'
);
create table roles (
    id varchar(30) primary key,
    name varchar(100) not null,
    is_system boolean not null default false,
    permissions jsonb default '[]',
    deleted_at timestamptz
);
create table workspace_members (
    id varchar(30) primary key,
    user_id varchar(255) not null,
    role varchar(20) not null default 'MEMBER',
    role_id varchar(30),
    permissions jsonb default '[]',
    permission_denies jsonb default '[]',
    status varchar(20) not null default 'ACTIVE',
    member_type varchar(20) not null default 'INTERNAL',
    deleted_at timestamptz
);
";

async fn setup() -> Option<Workspaces> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return None;
    };
    let master = master_pool(&url, 2).expect("pool");
    sqlx::raw_sql(SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    sqlx::raw_sql(
        r#"insert into partners values ('ptr_1', 'suspended');
         insert into workspaces (id, clerk_org_id, database_url) values ('ws_direct', 'org_direct', 'TENANT_URL');
         insert into workspaces (id, clerk_org_id, database_url, billing_mode, partner_id)
             values ('ws_partner', 'org_partner', 'TENANT_URL', 'partner', 'ptr_1');
         insert into workspace_licences values ('ws_partner', '["weldcrm"]', 'active');
         insert into workspaces (id, clerk_org_id, database_url, is_active)
             values ('ws_moving', 'org_moving', 'TENANT_URL', false);
         insert into workspace_database_moves values ('ws_moving', 'copying');
         insert into workspaces (id, clerk_org_id) values ('ws_nodb', 'org_nodb');
         insert into roles values ('role_sales', 'Sales', false, '["leads:*"]', null);
         insert into roles values ('role_admin', 'admin', true, '["ignored:read"]', null);
         insert into workspace_members (id, user_id, role, role_id, permissions, permission_denies)
             values ('mem_1', 'user_1', 'MEMBER', 'role_sales', '["team:read", 7]', '["leads:delete"]');
         insert into workspace_members (id, user_id, role, role_id)
             values ('mem_2', 'user_2', 'ADMIN', 'role_admin');
         insert into workspace_members (id, user_id, status) values ('mem_3', 'user_3', 'SUSPENDED');"#,
    )
    .execute(&master)
    .await
    .expect("seed");
    // The tenant tables live in this same database.
    sqlx::query("update workspaces set database_url = $1 where database_url = 'TENANT_URL'")
        .bind(&url)
        .execute(&master)
        .await
        .expect("tenant url");

    Some(Workspaces::new(
        master,
        Keyring::default(),
        WorkspaceConfig::default(),
    ))
}

#[tokio::test]
async fn resolution_and_permissions() {
    let Some(workspaces) = setup().await else {
        return;
    };

    // Either identifier finds the workspace.
    let direct = workspaces.tenant("org_direct").await.expect("by org id");
    assert_eq!(direct.workspace_id, "ws_direct");
    assert_eq!(direct.licensed_apps(), None);
    assert_eq!(
        workspaces
            .tenant("ws_direct")
            .await
            .expect("by id")
            .clerk_org_id
            .as_deref(),
        Some("org_direct")
    );

    let partner = workspaces.tenant("org_partner").await.expect("partner");
    assert_eq!(partner.licensed_apps(), Some(&["weldcrm".to_owned()][..]));
    assert_eq!(
        partner.read_only_reason(),
        Some(ReadOnlyReason::PartnerSuspended)
    );

    let moving = workspaces.tenant("ws_moving").await.expect("moving");
    assert!(moving.suspended);
    assert_eq!(
        moving.read_only_reason(),
        Some(ReadOnlyReason::DatabaseMove)
    );

    assert!(matches!(
        workspaces.tenant("org_nobody").await,
        Err(WorkspaceError::NotFound)
    ));
    assert!(matches!(
        workspaces.tenant("org_nodb").await,
        Err(WorkspaceError::NoDatabase)
    ));

    let queries = TenantPermissionQueries::new(direct.db.clone());
    let member = resolve_effective_permissions(&queries, "user_1")
        .await
        .expect("resolves");
    assert_eq!(member.permissions, ["leads:*", "team:read"]);
    assert_eq!(member.denies, ["leads:delete"]);
    assert_eq!(member.role_id.as_deref(), Some("role_sales"));

    // A system role row takes its permissions from code, not its column.
    let admin = resolve_effective_permissions(&queries, "user_2")
        .await
        .expect("resolves");
    assert!(!admin.permissions.contains(&"ignored:read".to_owned()));
    assert_ne!(admin.permissions, Vec::<String>::new());

    // Suspended members and strangers resolve to nothing.
    for user in ["user_3", "user_nobody"] {
        let none = resolve_effective_permissions(&queries, user)
            .await
            .expect("resolves");
        assert_eq!(none.permissions, Vec::<String>::new(), "{user}");
    }
}
