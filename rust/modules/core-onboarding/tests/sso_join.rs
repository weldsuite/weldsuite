//! The identity sync's SSO joins (ADR SEC-019 phase 5a) on WeldID's event
//! feed, against the real schema (built by `scripts/rust-test-db.ts`) with
//! the in-memory identity provider: someone who signs in through a
//! workspace's SSO connection joins it with the workspace's default role,
//! once; an existing member keeps their role; a run that stopped halfway is
//! finished; a workspace that is gone and a user deleted in the same page
//! are skipped.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are
//! set; otherwise it returns early.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_core_onboarding::{
    FEED_WATERMARK_KEY, IdentitySync, SSO_SIGNED_IN, SyncReport, TenantDatabases,
};
use weldsuite_db::sso_settings::set_sso_default_role;
use weldsuite_db::{PgPool, master_pool};
use weldsuite_ports::{Identity, MemoryIdentity, UserProfile};

const WS: &str = "ws_ssojoin";

fn databases() -> Option<(PgPool, PgPool)> {
    let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    Some((
        master_pool(&master, 4).expect("master"),
        master_pool(&tenant, 4).expect("tenant"),
    ))
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
        last_name: Some("Jansen".to_owned()),
        image_url: None,
    }
}

fn signed_in(tenant_ref: &str) -> Value {
    json!({ "tenantRef": tenant_ref, "connectionId": "ssoc_1", "email": "x@acme.test", "created": true, "linked": false })
}

/// The tenant members of `user`: (role, status), live ones only.
async fn members(tenant: &PgPool, user: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "select role, status from workspace_members where user_id = $1 and deleted_at is null",
    )
    .bind(user)
    .fetch_all(tenant)
    .await
    .expect("members")
}

async fn master_role(master: &PgPool, user: &str) -> Option<(String, String)> {
    sqlx::query_as(
        "select role, status::text from user_workspaces where user_id = $1 and workspace_id = $2",
    )
    .bind(user)
    .bind(WS)
    .fetch_optional(master)
    .await
    .expect("membership")
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn sso_sign_ins_join_the_workspace_once_with_its_default_role() {
    let Some((master, tenant)) = databases() else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / _TENANT_URL not set; skipping");
        return;
    };
    let (new, existing, deleted) = ("usr_ssojoin_new", "usr_ssojoin_old", "usr_ssojoin_del");
    for user in [new, existing, deleted] {
        sqlx::query("delete from user_workspaces where user_id = $1")
            .bind(user)
            .execute(&master)
            .await
            .expect("clean memberships");
        sqlx::query("delete from users where id = $1")
            .bind(user)
            .execute(&master)
            .await
            .expect("clean users");
        sqlx::query(
            "delete from workspace_members where user_id = $1 or email like '%@ssojoin.test'",
        )
        .bind(user)
        .execute(&tenant)
        .await
        .expect("clean members");
    }
    sqlx::query("delete from system_settings where key = $1")
        .bind(FEED_WATERMARK_KEY)
        .execute(&master)
        .await
        .expect("watermark");
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id) values ($1, 'SSO join', $1, 'org_ssojoin')
         on conflict (id) do update set deleted_at = null",
    )
    .bind(WS)
    .execute(&master)
    .await
    .expect("workspace");
    set_sso_default_role(&tenant, "VIEWER", "wset_ssojoin")
        .await
        .expect("default role");

    // Someone already in, as an admin.
    sqlx::query("insert into users (id, email) values ($1, 'old@ssojoin.test')")
        .bind(existing)
        .execute(&master)
        .await
        .expect("existing user");
    sqlx::query(
        "insert into user_workspaces (id, user_id, workspace_id, role, status)
         values ('uw_ssojoin_old', $1, $2, 'org:admin', 'ACTIVE')",
    )
    .bind(existing)
    .bind(WS)
    .execute(&master)
    .await
    .expect("existing membership");
    sqlx::query(
        "insert into workspace_members (id, user_id, email, role, status)
         values ('mbr_ssojoin_old', $1, 'old@ssojoin.test', 'ADMIN', 'ACTIVE')",
    )
    .bind(existing)
    .execute(&tenant)
    .await
    .expect("existing member");

    let weldid = Arc::new(
        MemoryIdentity::new()
            .with_profile(profile(new, "new@ssojoin.test", "Noor"))
            .with_profile(profile(existing, "old@ssojoin.test", "Otto"))
            .with_profile(profile(deleted, "del@ssojoin.test", "Dirk")),
    );
    weldid.record_event("user.created", new);
    weldid.record_event_with(SSO_SIGNED_IN, new, signed_in(WS));
    weldid.record_event_with(SSO_SIGNED_IN, new, signed_in(WS));
    weldid.record_event_with(SSO_SIGNED_IN, existing, signed_in(WS));
    // A workspace that is gone, and someone deleted right after signing in.
    weldid.record_event_with(SSO_SIGNED_IN, existing, signed_in("ws_ssojoin_gone"));
    weldid.record_event_with(SSO_SIGNED_IN, deleted, signed_in(WS));
    weldid.record_event("user.deleted", deleted);
    let sync = IdentitySync::new(
        master.clone(),
        Arc::clone(&weldid) as Arc<dyn Identity>,
        tenants(&tenant),
        None,
    );
    let report = sync.run_feed().await.expect("feed");
    assert_eq!(
        report,
        SyncReport {
            changes: 7,
            users: 3,
            organizations: 0,
            memberships: 3,
            failed: 0,
            watermark: Some("7".to_owned()),
        }
    );
    // The newcomer joined as the workspace's SSO role; the admin stayed one.
    assert_eq!(
        members(&tenant, new).await,
        [("VIEWER".to_owned(), "ACTIVE".to_owned())]
    );
    assert_eq!(
        master_role(&master, new).await,
        Some(("org:member".to_owned(), "ACTIVE".to_owned()))
    );
    let name: Option<String> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1")
            .bind(new)
            .fetch_one(&tenant)
            .await
            .expect("name");
    assert_eq!(name.as_deref(), Some("Noor Jansen"));
    assert_eq!(
        members(&tenant, existing).await,
        [("ADMIN".to_owned(), "ACTIVE".to_owned())]
    );
    assert_eq!(
        master_role(&master, existing).await,
        Some(("org:admin".to_owned(), "ACTIVE".to_owned()))
    );
    assert_eq!(members(&tenant, deleted).await, Vec::new());
    assert_eq!(master_role(&master, deleted).await, None);

    // Signing in again changes nothing, even after the default role moved.
    set_sso_default_role(&tenant, "ADMIN", "wset_ssojoin")
        .await
        .expect("new default");
    weldid.record_event_with(SSO_SIGNED_IN, new, signed_in(WS));
    let again = sync.run_feed().await.expect("again");
    assert_eq!((again.memberships, again.failed), (1, 0));
    assert_eq!(
        members(&tenant, new).await,
        [("VIEWER".to_owned(), "ACTIVE".to_owned())]
    );

    // A run that stopped between the tenant and the master is finished,
    // with the role the member already has.
    sqlx::query("delete from user_workspaces where user_id = $1")
        .bind(new)
        .execute(&master)
        .await
        .expect("half");
    weldid.record_event_with(SSO_SIGNED_IN, new, signed_in(WS));
    sync.run_feed().await.expect("finish");
    assert_eq!(
        master_role(&master, new).await,
        Some(("org:member".to_owned(), "ACTIVE".to_owned()))
    );
    assert_eq!(
        members(&tenant, new).await,
        [("VIEWER".to_owned(), "ACTIVE".to_owned())]
    );
}
