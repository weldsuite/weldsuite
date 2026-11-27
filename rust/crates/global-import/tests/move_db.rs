//! The move end to end on a real Postgres (`WELDSUITE_TEST_DATABASE_URL`, a
//! scratch server the tests may create databases and roles on; skipped
//! without it): a Global master at the schema it stopped at (migration
//! 0072), a Global tenant two migrations behind, and an install with the
//! whole journal and a CloudNativePG shard on the same server. Check, copy
//! the master rows, move the tenant, run it again, verify.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::str::FromStr as _;
use std::sync::atomic::{AtomicU32, Ordering};

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, ConnectOptions as _, Connection as _, PgConnection, PgPool};
use weldsuite_adapters_oss::{CnpgOptions, CnpgProvisioner, CnpgShard};
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces};
use weldsuite_global_import::tenant::DUE_KINDS;
use weldsuite_global_import::{
    CheckOptions, Global, LevelProvisioner, MasterOptions, PlanMap, TenantOptions, check, master,
    move_tenant, plan_names, select, verify,
};
use weldsuite_migrations::{Folder, Journal, migrate};
use weldsuite_ports::{
    BoxFuture, DatabaseProvisioner as _, DatabaseUrl, ProvisionError, ProvisionRequest,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn unique(label: &str) -> String {
    format!(
        "{label}{}x{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn keyring() -> Keyring {
    Keyring {
        v1: Some("11".repeat(32)),
        v2: Some("22".repeat(32)),
    }
}

/// `url` naming the database `name` instead (its query string kept).
fn with_database(url: &str, name: &str) -> String {
    let (base, query) = url
        .split_once('?')
        .map_or((url, None), |(b, q)| (b, Some(q)));
    let authority_end = base.find("://").map_or(0, |scheme| {
        scheme
            + 3
            + base[scheme + 3..]
                .find('/')
                .unwrap_or(base.len() - scheme - 3)
    });
    let mut out = format!("{}/{name}", &base[..authority_end]);
    if let Some(query) = query {
        out.push('?');
        out.push_str(query);
    }
    out
}

#[test]
fn swaps_the_database_of_a_url() {
    assert_eq!(
        with_database("postgres://u:p@127.0.0.1:5432/scratch", "other"),
        "postgres://u:p@127.0.0.1:5432/other"
    );
    assert_eq!(
        with_database("postgres://u:p@h/scratch?sslmode=disable", "x"),
        "postgres://u:p@h/x?sslmode=disable"
    );
    assert_eq!(with_database("postgres://u:p@h", "x"), "postgres://u:p@h/x");
}

/// Global's master stopped migrating at 0072 (ADR DATA-019).
const GLOBAL_MASTER_MIGRATIONS: usize = 73;

struct Levels {
    master: PgPool,
    options: CnpgOptions,
}

impl Levels {
    fn provisioner(&self, journal: Option<&'static Journal>) -> CnpgProvisioner {
        let provisioner =
            CnpgProvisioner::new(self.master.clone(), self.options.clone()).expect("options");
        match journal {
            Some(journal) => provisioner.with_journal(journal),
            None => provisioner,
        }
    }
}

impl LevelProvisioner for Levels {
    fn provision_at<'a>(
        &'a self,
        workspace_id: &'a str,
        journal: &'static Journal,
    ) -> BoxFuture<'a, Result<DatabaseUrl, ProvisionError>> {
        Box::pin(async move {
            Ok(self
                .provisioner(Some(journal))
                .provision(&ProvisionRequest::new(workspace_id))
                .await?
                .database_url)
        })
    }

    fn teardown<'a>(&'a self, workspace_id: &'a str) -> BoxFuture<'a, Result<(), ProvisionError>> {
        Box::pin(async move {
            self.provisioner(None)
                .teardown(workspace_id)
                .await
                .map(drop)
        })
    }
}

async fn run(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(pool)
        .await
        .expect(sql);
}

async fn scalar<T>(pool: &PgPool, sql: &str, bind: &str) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .bind(bind)
        .fetch_one(pool)
        .await
        .expect(sql)
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one move, step by step
async fn moves_a_workspace_from_global_into_the_install() {
    let Ok(admin_url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let options = PgConnectOptions::from_str(&admin_url).expect("admin url");
    let mut admin = options.connect().await.expect("admin");
    let names = [
        unique("gi_global_master_"),
        unique("gi_global_tenant_"),
        unique("gi_install_master_"),
    ];
    for name in &names {
        sqlx::raw_sql(AssertSqlSafe(format!("create database {name}")))
            .execute(&mut admin)
            .await
            .expect("create database");
    }
    let connect = |name: &str| options.clone().database(name);
    let pool = |name: &str| {
        PgPoolOptions::new()
            .max_connections(4)
            .connect_lazy_with(connect(name))
    };

    // Global: its master at 0072, a tenant two migrations behind.
    let tenant_journal = Journal::embedded(Folder::Tenant);
    let behind = tenant_journal.truncated(tenant_journal.migrations().len() - 2);
    let mut conn = connect(&names[0]).connect().await.expect("global master");
    migrate(
        &mut conn,
        &Journal::embedded(Folder::Master).truncated(GLOBAL_MASTER_MIGRATIONS),
    )
    .await
    .expect("global master schema");
    conn.close().await.expect("close");
    let mut conn: PgConnection = connect(&names[1]).connect().await.expect("global tenant");
    migrate(&mut conn, &behind)
        .await
        .expect("global tenant schema");
    conn.close().await.expect("close");
    let mut conn = connect(&names[2]).connect().await.expect("install master");
    migrate(&mut conn, Journal::embedded(Folder::Master))
        .await
        .expect("install master schema");
    conn.close().await.expect("close");

    let global_master = pool(&names[0]);
    let global_tenant = pool(&names[1]);
    let install = pool(&names[2]);
    let workspace = unique("ws_gi");
    let org = unique("org_gi");
    // Global stores a plain URL for this one: the scratch server's, with the
    // tenant's database.
    let tenant_url = with_database(&admin_url, &names[1]);
    run(
        &global_master,
        &format!(
            "insert into plans (id, name, slug) values ('gp_free', 'Free', 'free'), ('gp_scale', 'Scale', 'scale');
             insert into workspaces (id, clerk_org_id, name, slug, plan_id, database_url,
                 purchased_seats, subscription_status, subscription_cycle,
                 subscription_current_period_start, subscription_current_period_end)
               values ('{workspace}', '{org}', 'Acme', '{workspace}', 'gp_scale', '{tenant_url}',
                 3, 'active', 'monthly', '2026-11-14 10:00:00', '2026-12-14 10:00:00');
             insert into workspaces (id, clerk_org_id, name, slug, deleted_at)
               values ('{workspace}_gone', '{org}_gone', 'Gone', '{workspace}-gone', now());
             insert into users (id, email) values ('user_{workspace}_1', 'one@example.com'),
                                                  ('user_{workspace}_2', 'two@example.com');
             insert into user_workspaces (id, user_id, workspace_id, status) values
               ('uw_{workspace}_1', 'user_{workspace}_1', '{workspace}', 'ACTIVE'),
               ('uw_{workspace}_2', 'user_{workspace}_2', '{workspace}', 'ACTIVE');"
        ),
    )
    .await;
    run(
        &global_tenant,
        "insert into integration_connections (id, provider, status) values ('ic_gi_1', 'github', 'active');",
    )
    .await;
    run(
        &install,
        "insert into plans (id, name, slug, currency) values
           ('plan_gi_free', 'Free', 'free', 'EUR'), ('plan_gi_business', 'Business', 'business', 'EUR');",
    )
    .await;

    let global = Global::new(global_master.clone(), keyring(), None);
    let selection = select(global.workspaces().await.expect("workspaces"), &[]).expect("select");
    assert_eq!(selection.moving.len(), 1);
    assert_eq!(selection.staying.len(), 1);
    assert_eq!(selection.staying[0].reason, "deleted on Global");

    // Scale has no counterpart until it is mapped.
    let unmapped = PlanMap::build(
        &plan_names(&global_master).await.expect("plans"),
        &plan_names(&install).await.expect("plans"),
        &[],
    )
    .expect("map");
    let install_keys = Keyring::default();
    let options_with = |plans| CheckOptions {
        plans,
        install_keyring: &install_keys,
        probe_tenants: true,
    };
    let report = check(&global, &install, &selection, options_with(&unmapped))
        .await
        .expect("check");
    assert!(!report.ok());
    let plans = PlanMap::build(
        &plan_names(&global_master).await.expect("plans"),
        &plan_names(&install).await.expect("plans"),
        &[("scale".to_owned(), "business".to_owned())],
    )
    .expect("map");
    let report = check(&global, &install, &selection, options_with(&plans))
        .await
        .expect("check");
    assert!(report.ok(), "{report:#?}");
    let probed = &report.moving[0];
    assert_eq!(probed.level.as_deref(), behind.latest_tag());
    assert_eq!(probed.gaps, 0);

    // The master rows.
    let copied = master::copy(
        &global,
        &install,
        &selection.moving,
        &MasterOptions {
            plans: &plans,
            replace: false,
            dry_run: false,
        },
    )
    .await
    .expect("master copy");
    assert_eq!(copied.users, 2);
    let (plan, status, placement): (Option<String>, String, Option<String>) = sqlx::query_as(
        "select plan_id, provisioning_status, neon_project_id from workspaces where id = $1",
    )
    .bind(&workspace)
    .fetch_one(&install)
    .await
    .expect("workspace");
    assert_eq!(plan.as_deref(), Some("plan_gi_business"));
    assert_eq!(status, "provisioning");
    assert_eq!(placement, None);
    let members: i64 = scalar(
        &install,
        "select count(*) from user_workspaces where workspace_id = $1",
        &workspace,
    )
    .await;
    assert_eq!(members, 2, "both memberships");

    // The tenant, on a shard of the same server.
    let mut cnpg = CnpgOptions::new(
        vec![CnpgShard {
            name: unique("gi"),
            admin_url: admin_url.clone(),
            pooler_host: options.get_host().to_owned(),
            pooler_port: options.get_port(),
            url_options: String::new(),
            max_databases: 50,
        }],
        keyring(),
    );
    "test".clone_into(&mut cnpg.region);
    cnpg.aad_writes = true;
    let levels = Levels {
        master: install.clone(),
        options: cnpg,
    };
    let moved = move_tenant(
        &global,
        &install,
        &levels,
        &selection.moving[0],
        TenantOptions {
            replace: false,
            actor: "tests@example.com",
        },
    )
    .await
    .expect("move the tenant");
    assert!(moved.copied);
    assert_eq!(moved.level.as_deref(), behind.latest_tag());
    assert_eq!(moved.migrations_after.len(), 2, "{moved:?}");
    assert_eq!(moved.outside_eu, ["github"]);
    assert!(
        moved
            .tables
            .iter()
            .any(|t| t.table == "integration_connections" && t.rows == 1)
    );

    let status: String = scalar(
        &install,
        "select provisioning_status from workspaces where id = $1",
        &workspace,
    )
    .await;
    assert_eq!(status, "ready");
    let finished: String = scalar(
        &install,
        "select status from workspace_database_moves where workspace_id = $1 and kind = 'import_global'",
        &workspace,
    )
    .await;
    assert_eq!(finished, "completed");
    let due: i64 = scalar(
        &install,
        "select count(*) from workspace_due_index where workspace_id = $1",
        &workspace,
    )
    .await;
    assert_eq!(usize::try_from(due).expect("count"), DUE_KINDS.len());

    // Run again: nothing to do without --replace.
    let again = move_tenant(
        &global,
        &install,
        &levels,
        &selection.moving[0],
        TenantOptions {
            replace: false,
            actor: "tests@example.com",
        },
    )
    .await
    .expect("again");
    assert!(!again.copied);

    // With --replace: the earlier copy is dropped and made again.
    run(
        &global_tenant,
        "insert into integration_connections (id, provider, status) values ('ic_gi_2', 'attio', 'active');",
    )
    .await;
    let replaced = move_tenant(
        &global,
        &install,
        &levels,
        &selection.moving[0],
        TenantOptions {
            replace: true,
            actor: "tests@example.com",
        },
    )
    .await
    .expect("replace");
    assert!(replaced.copied);
    assert!(
        replaced
            .tables
            .iter()
            .any(|t| t.table == "integration_connections" && t.rows == 2)
    );
    assert_eq!(replaced.outside_eu, ["attio", "github"]);
    let status: String = scalar(
        &install,
        "select provisioning_status from workspaces where id = $1",
        &workspace,
    )
    .await;
    assert_eq!(status, "ready");
    let completed_moves: i64 = scalar(
        &install,
        "select count(*) from workspace_database_moves where workspace_id = $1 and status = 'completed'",
        &workspace,
    )
    .await;
    assert_eq!(completed_moves, 2);

    let tenants = Workspaces::new(install.clone(), keyring(), WorkspaceConfig::default());
    let counted = verify(&global, &install, &tenants, &selection.moving[0])
        .await
        .expect("verify");
    assert!(counted.master.is_empty(), "{counted:#?}");
    assert!(counted.tenant_tables.is_some_and(|tables| tables > 100));
    assert!(counted.only_on_one_side.is_empty(), "{counted:#?}");

    levels
        .teardown(&workspace)
        .await
        .expect("drop the moved database");
    global_master.close().await;
    global_tenant.close().await;
    install.close().await;
    for name in &names {
        let _ = sqlx::raw_sql(AssertSqlSafe(format!(
            "drop database if exists {name} with (force)"
        )))
        .execute(&mut admin)
        .await;
    }
}

/// Workspaces moved in batches (`--workspace`) that installed the same app:
/// the second batch keeps the app the first one brought, and copying the
/// first again (`--replace`) leaves the second one's install alone.
#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // three runs of the master step
async fn moves_workspaces_in_batches_that_share_an_app() {
    let Ok(admin_url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let options = PgConnectOptions::from_str(&admin_url).expect("admin url");
    let mut admin = options.connect().await.expect("admin");
    let names = [unique("gi_batch_global_"), unique("gi_batch_install_")];
    for name in &names {
        sqlx::raw_sql(AssertSqlSafe(format!("create database {name}")))
            .execute(&mut admin)
            .await
            .expect("create database");
    }
    let connect = |name: &str| options.clone().database(name);
    let mut conn = connect(&names[0]).connect().await.expect("global master");
    migrate(
        &mut conn,
        &Journal::embedded(Folder::Master).truncated(GLOBAL_MASTER_MIGRATIONS),
    )
    .await
    .expect("global master schema");
    conn.close().await.expect("close");
    let mut conn = connect(&names[1]).connect().await.expect("install master");
    migrate(&mut conn, Journal::embedded(Folder::Master))
        .await
        .expect("install master schema");
    conn.close().await.expect("close");
    let pool = |name: &str| {
        PgPoolOptions::new()
            .max_connections(4)
            .connect_lazy_with(connect(name))
    };
    let global_master = pool(&names[0]);
    let install = pool(&names[1]);

    // A and B installed app X, which a deleted workspace owns; A owns app Y.
    let a = unique("ws_ba");
    let b = unique("ws_bb");
    let gone = unique("ws_bgone");
    let url = with_database(&admin_url, &names[0]);
    run(
        &global_master,
        &format!(
            "insert into workspaces (id, clerk_org_id, name, slug, database_url) values
               ('{a}', 'org_{a}', 'A', '{a}', '{url}'), ('{b}', 'org_{b}', 'B', '{b}', '{url}');
             insert into workspaces (id, clerk_org_id, name, slug, deleted_at)
               values ('{gone}', 'org_{gone}', 'Gone', '{gone}', now());
             insert into user_apps (id, code, name, owner_workspace_id, created_by) values
               ('app_x_{a}', 'x-{a}', 'X', '{gone}', 'user_x'),
               ('app_y_{a}', 'y-{a}', 'Y', '{a}', 'user_y');
             insert into user_app_installs (id, app_id, workspace_id, installed_by) values
               ('ins_ax_{a}', 'app_x_{a}', '{a}', 'user_x'),
               ('ins_ay_{a}', 'app_y_{a}', '{a}', 'user_y'),
               ('ins_bx_{a}', 'app_x_{a}', '{b}', 'user_x');"
        ),
    )
    .await;

    let global = Global::new(global_master.clone(), keyring(), None);
    let plans = PlanMap::default();
    let copy = |workspace: String, replace: bool| {
        let global = &global;
        let install = &install;
        let plans = &plans;
        async move {
            let selection = select(
                global.workspaces().await.expect("workspaces"),
                std::slice::from_ref(&workspace),
            )
            .expect("select");
            master::copy(
                global,
                install,
                &selection.moving,
                &MasterOptions {
                    plans,
                    replace,
                    dry_run: false,
                },
            )
            .await
        }
    };
    let installs = |workspace: String| {
        let install = &install;
        async move {
            scalar::<i64>(
                install,
                "select count(*) from user_app_installs where workspace_id = $1",
                &workspace,
            )
            .await
        }
    };

    copy(a.clone(), false).await.expect("first batch");
    assert_eq!(installs(a.clone()).await, 2);

    // Global still serves B and the app's owner: both apps change there.
    run(
        &global_master,
        &format!(
            "update user_apps set name = name || ' (new)' where id in ('app_x_{a}', 'app_y_{a}');"
        ),
    )
    .await;
    copy(b.clone(), false)
        .await
        .expect("the second batch keeps the app the first brought");
    assert_eq!(installs(b.clone()).await, 1);
    let x_name: String = scalar(
        &install,
        "select name from user_apps where id = $1",
        &format!("app_x_{a}"),
    )
    .await;
    assert_eq!(
        x_name, "X",
        "an app another workspace brought stays as it is"
    );

    copy(a.clone(), true).await.expect("first batch again");
    assert_eq!(installs(a.clone()).await, 2);
    assert_eq!(
        installs(b.clone()).await,
        1,
        "B's install of the shared app survives A's --replace"
    );
    let y_name: String = scalar(
        &install,
        "select name from user_apps where id = $1",
        &format!("app_y_{a}"),
    )
    .await;
    assert_eq!(y_name, "Y (new)", "A's own app is brought up to date");

    global_master.close().await;
    install.close().await;
    for name in &names {
        let _ = sqlx::raw_sql(AssertSqlSafe(format!(
            "drop database if exists {name} with (force)"
        )))
        .execute(&mut admin)
        .await;
    }
}
