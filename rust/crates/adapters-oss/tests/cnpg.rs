//! The CloudNativePG provisioner against a real Postgres.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a server where that role
//! is a superuser (CI's scratch database; the `pgvector/pgvector` image, since
//! the tenant schema needs pgvector); otherwise each test returns early. The
//! "shard" is that server, reached directly where a cluster would put its
//! pooler. Every test makes its own master database, workspaces and roles,
//! and drops them.

use std::str::FromStr;
use std::sync::atomic::{AtomicU32, Ordering};

use sqlx::postgres::PgConnectOptions;
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool};
use weldsuite_adapters_oss::{CnpgOptions, CnpgProvisioner, CnpgShard};
use weldsuite_db::{Keyring, decrypt_workspace_database_url};
use weldsuite_migrations::{Folder, Journal, Migration, migrate};
use weldsuite_ports::{
    DatabaseProvisioner, ProvisionError, ProvisionRequest, ProvisionedDatabase, Teardown,
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

/// A tenant journal that is quick to apply and needs both extensions.
fn small_journal() -> &'static Journal {
    Box::leak(Box::new(Journal::new(
        Folder::Tenant,
        vec![
            Migration::new(
                "0000_people",
                100,
                "CREATE TABLE people (id text PRIMARY KEY, name text, embedding vector(3));",
            ),
            Migration::new(
                "0001_trgm",
                200,
                "CREATE INDEX people_name_trgm ON people USING gin (name gin_trgm_ops);",
            ),
        ],
    )))
}

/// The server the tests run on, a master database on it, and a superuser
/// connection for checks.
struct Fixture {
    admin_url: String,
    host: String,
    port: u16,
    master_name: String,
    master: PgPool,
    admin: PgConnection,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let Ok(admin_url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
            eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
            return None;
        };
        let options = PgConnectOptions::from_str(&admin_url).expect("admin url");
        let mut admin = PgConnection::connect(&admin_url).await.expect("admin");
        let master_name = unique("cnpg_master_");
        run(&mut admin, &format!("create database {master_name}")).await;
        let master_options = options.clone().database(&master_name);
        let mut conn = PgConnection::connect_with(&master_options)
            .await
            .expect("master");
        migrate(&mut conn, Journal::embedded(Folder::Master))
            .await
            .expect("master schema");
        conn.close().await.expect("close");
        let master = PgPool::connect_with(master_options).await.expect("pool");
        Some(Self {
            host: options.get_host().to_owned(),
            port: options.get_port(),
            admin_url,
            master_name,
            master,
            admin,
        })
    }

    fn shard(&self, name: &str, admin_url: &str, max_databases: i16) -> CnpgShard {
        CnpgShard {
            name: name.to_owned(),
            admin_url: admin_url.to_owned(),
            pooler_host: self.host.clone(),
            pooler_port: self.port,
            url_options: String::new(),
            max_databases,
        }
    }

    fn provisioner(&self, shards: Vec<CnpgShard>, journal: &'static Journal) -> CnpgProvisioner {
        let mut options = CnpgOptions::new(shards, keyring());
        "test".clone_into(&mut options.region);
        options.aad_writes = true;
        CnpgProvisioner::new(self.master.clone(), options)
            .expect("options")
            .with_journal(journal)
    }

    async fn workspace(&self, label: &str) -> String {
        let id = unique(&format!("ws_{label}"));
        sqlx::query("insert into workspaces (id, name, slug) values ($1, $1, $1)")
            .bind(&id)
            .execute(&self.master)
            .await
            .expect("workspace");
        id
    }

    async fn exists(&mut self, catalog: &'static str, name: &str) -> bool {
        sqlx::query_scalar(catalog)
            .bind(name)
            .fetch_one(&mut self.admin)
            .await
            .expect("catalog")
    }

    async fn database_exists(&mut self, name: &str) -> bool {
        self.exists(
            "select exists (select 1 from pg_database where datname = $1)",
            name,
        )
        .await
    }

    async fn role_exists(&mut self, name: &str) -> bool {
        self.exists(
            "select exists (select 1 from pg_roles where rolname = $1)",
            name,
        )
        .await
    }

    async fn shard_count(&self, key: &str) -> (i16, String) {
        sqlx::query_as(
            "select database_count, status::text from neon_shared_projects where neon_project_id = $1",
        )
        .bind(key)
        .fetch_one(&self.master)
        .await
        .expect("shard row")
    }

    async fn finish(mut self) {
        self.master.close().await;
        run(
            &mut self.admin,
            &format!("drop database if exists {} with (force)", self.master_name),
        )
        .await;
    }
}

async fn run(conn: &mut PgConnection, statement: &str) {
    sqlx::raw_sql(AssertSqlSafe(statement.to_owned()))
        .execute(conn)
        .await
        .unwrap_or_else(|error| panic!("{statement}: {error}"));
}

/// The master row, as the TypeScript provisioning records a shard database.
async fn assert_master_row(fx: &Fixture, workspace: &str, key: &str, made: &ProvisionedDatabase) {
    let (project, database, branch, role, region, shard_id, sealed): (
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
    ) = sqlx::query_as(
        "select neon_project_id, neon_database_name, neon_branch_id, neon_role_name, neon_region,
                shared_project_id, database_url
         from workspaces where id = $1",
    )
    .bind(workspace)
    .fetch_one(&fx.master)
    .await
    .expect("row");
    assert_eq!(project, key);
    assert_eq!(database, made.placement.database_name);
    assert_eq!(branch, None, "a shard has no Neon branch");
    assert_eq!(role, made.placement.role_name);
    assert_eq!(region, "test");
    assert_eq!(shard_id, made.placement.shard_id);
    assert!(sealed.starts_with("v3:"), "sealed as v3 with AAD writes on");
    assert_eq!(
        decrypt_workspace_database_url(&sealed, workspace, &keyring()).as_deref(),
        Ok(made.database_url.expose())
    );
}

/// The workspace's own role logs in, owns its database, and finds the
/// extensions and the migrated schema.
async fn assert_tenant_database(made: &ProvisionedDatabase) {
    let mut tenant = PgConnection::connect(made.database_url.expose())
        .await
        .expect("tenant login");
    let (user, owner): (String, String) = sqlx::query_as(
        "select current_user::text, pg_get_userbyid(datdba)::text
         from pg_database where datname = current_database()",
    )
    .fetch_one(&mut tenant)
    .await
    .expect("whoami");
    assert_eq!(user, made.placement.role_name);
    assert_eq!(owner, made.placement.role_name);
    let extensions: Vec<String> =
        sqlx::query_scalar("select extname::text from pg_extension order by 1")
            .fetch_all(&mut tenant)
            .await
            .expect("extensions");
    assert!(
        extensions.contains(&"vector".to_owned()) && extensions.contains(&"pg_trgm".to_owned())
    );
    let members: i64 = sqlx::query_scalar("select count(*) from workspace_members")
        .fetch_one(&mut tenant)
        .await
        .expect("tenant schema");
    assert_eq!(members, 0);
    tenant.close().await.expect("close");
}

#[tokio::test]
async fn provisions_migrates_records_and_tears_down_a_workspace_database() {
    let Some(mut fx) = Fixture::new().await else {
        return;
    };
    let shard = fx.shard(&unique("tenants-a"), &fx.admin_url.clone(), 10);
    let key = shard.key();
    // The real tenant journal, through the runner's library function.
    let provisioner = fx.provisioner(vec![shard], Journal::embedded(Folder::Tenant));
    let workspace = fx.workspace("full").await;
    let request = ProvisionRequest::new(&workspace);

    let made = provisioner.provision(&request).await.expect("provision");
    assert!(made.created);
    let tenant_journal = Journal::embedded(Folder::Tenant);
    assert_eq!(made.migrations_applied, tenant_journal.migrations().len());
    assert_eq!(made.schema_version.as_deref(), tenant_journal.latest_tag());
    assert_eq!(made.placement.database_name, format!("ws_{workspace}"));
    assert_eq!(made.placement.role_name, format!("role_{workspace}"));
    assert_master_row(&fx, &workspace, &key, &made).await;
    assert_eq!(fx.shard_count(&key).await, (1, "active".to_owned()));
    assert_tenant_database(&made).await;

    // Again: found, not made; nothing to migrate; the same URL; one slot.
    let again = provisioner.provision(&request).await.expect("again");
    assert!(!again.created);
    assert_eq!(again.migrations_applied, 0);
    assert_eq!(again.database_url, made.database_url);
    assert_eq!(fx.shard_count(&key).await.0, 1);

    // Teardown: database, role and slot gone, placement cleared.
    assert_eq!(
        provisioner.teardown(&workspace).await.expect("teardown"),
        Teardown::Dropped(made.placement.clone())
    );
    assert!(!fx.database_exists(&made.placement.database_name).await);
    assert!(!fx.role_exists(&made.placement.role_name).await);
    assert_eq!(fx.shard_count(&key).await.0, 0);
    let cleared: Option<String> =
        sqlx::query_scalar("select neon_project_id from workspaces where id = $1")
            .bind(&workspace)
            .fetch_one(&fx.master)
            .await
            .expect("row");
    assert_eq!(cleared, None);
    assert_eq!(
        provisioner.teardown(&workspace).await.expect("again"),
        Teardown::NothingToDrop
    );
    fx.finish().await;
}

#[tokio::test]
async fn one_workspace_cannot_reach_anothers_database() {
    let Some(fx) = Fixture::new().await else {
        return;
    };
    let shard = fx.shard(&unique("tenants-b"), &fx.admin_url.clone(), 10);
    let provisioner = fx.provisioner(vec![shard], small_journal());
    let first = fx.workspace("one").await;
    let second = fx.workspace("two").await;
    let one = provisioner
        .provision(&ProvisionRequest::new(&first))
        .await
        .expect("one");
    let two = provisioner
        .provision(&ProvisionRequest::new(&second))
        .await
        .expect("two");

    // Role two, with its own password, against database one.
    let crossed = two
        .database_url
        .expose()
        .replace(&two.placement.database_name, &one.placement.database_name);
    let error = PgConnection::connect(&crossed)
        .await
        .expect_err("PUBLIC has no CONNECT");
    assert_eq!(
        error
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .as_deref(),
        Some("42501")
    );

    for workspace in [&first, &second] {
        provisioner.teardown(workspace).await.expect("teardown");
    }
    fx.finish().await;
}

#[tokio::test]
async fn a_retry_after_a_lost_url_gives_the_role_a_new_password() {
    let Some(mut fx) = Fixture::new().await else {
        return;
    };
    let shard = fx.shard(&unique("tenants-c"), &fx.admin_url.clone(), 10);
    let provisioner = fx.provisioner(vec![shard], small_journal());
    let workspace = fx.workspace("retry").await;
    let request = ProvisionRequest::new(&workspace);
    let first = provisioner.provision(&request).await.expect("first");

    // As if the call had stopped between CREATE ROLE and storing the URL.
    sqlx::query("update workspaces set database_url = null where id = $1")
        .bind(&workspace)
        .execute(&fx.master)
        .await
        .expect("forget");
    let retried = provisioner.provision(&request).await.expect("retry");
    assert!(!retried.created);
    assert_ne!(retried.database_url, first.database_url);
    assert!(
        PgConnection::connect(retried.database_url.expose())
            .await
            .is_ok()
    );
    assert!(
        PgConnection::connect(first.database_url.expose())
            .await
            .is_err(),
        "the old password no longer works"
    );

    // As if it had stopped after the role and before the database.
    run(
        &mut fx.admin,
        &format!(
            "drop database {} with (force)",
            retried.placement.database_name
        ),
    )
    .await;
    let rebuilt = provisioner.provision(&request).await.expect("rebuild");
    assert!(rebuilt.created);
    assert_eq!(rebuilt.migrations_applied, 2);
    assert_eq!(rebuilt.database_url, retried.database_url);

    provisioner.teardown(&workspace).await.expect("teardown");
    fx.finish().await;
}

#[tokio::test]
async fn concurrent_calls_make_one_database() {
    let Some(fx) = Fixture::new().await else {
        return;
    };
    let shard = fx.shard(&unique("tenants-d"), &fx.admin_url.clone(), 10);
    let key = shard.key();
    let provisioner = fx.provisioner(vec![shard], small_journal());
    let workspace = fx.workspace("race").await;
    let request = ProvisionRequest::new(&workspace);
    let (a, b) = tokio::join!(
        provisioner.provision(&request),
        provisioner.provision(&request)
    );
    let (a, b) = (a.expect("a"), b.expect("b"));
    assert_eq!(a.placement, b.placement);
    assert_eq!(a.database_url, b.database_url);
    assert_eq!(
        u8::from(a.created) + u8::from(b.created),
        1,
        "one made it, the other found it"
    );
    assert_eq!(
        fx.shard_count(&key).await.0,
        1,
        "one slot, the loser's given back"
    );
    provisioner.teardown(&workspace).await.expect("teardown");
    fx.finish().await;
}

#[tokio::test]
async fn placement_follows_capacity_pins_and_never_touches_foreign_databases() {
    let Some(fx) = Fixture::new().await else {
        return;
    };
    let small = fx.shard(&unique("tenants-e"), &fx.admin_url.clone(), 1);
    let other = fx.shard(&unique("tenants-f"), &fx.admin_url.clone(), 1);
    let (small_key, other_key) = (small.key(), other.key());
    let small_name = small.name.clone();
    let provisioner = fx.provisioner(vec![small, other], small_journal());

    // Pinned to a shard: there; that shard is then full.
    let pinned = fx.workspace("pinned").await;
    let made = provisioner
        .provision(&ProvisionRequest::new(&pinned).on_shard(&small_name))
        .await
        .expect("pinned");
    assert_eq!(made.placement.shard_name, small_name);
    assert_eq!(fx.shard_count(&small_key).await, (1, "full".to_owned()));
    let refused = fx.workspace("refused").await;
    assert!(matches!(
        provisioner
            .provision(&ProvisionRequest::new(&refused).on_shard(&small_name))
            .await,
        Err(ProvisionError::NoCapacity)
    ));
    // Unpinned: the shard with room.
    let elsewhere = provisioner
        .provision(&ProvisionRequest::new(&refused))
        .await
        .expect("other shard");
    assert_eq!(
        elsewhere.placement.shard_name,
        other_key.trim_start_matches("cnpg:")
    );
    // Everything full now.
    let third = fx.workspace("third").await;
    assert!(matches!(
        provisioner.provision(&ProvisionRequest::new(&third)).await,
        Err(ProvisionError::NoCapacity)
    ));
    assert!(matches!(
        provisioner
            .provision(&ProvisionRequest::new(&third).on_shard("nowhere"))
            .await,
        Err(ProvisionError::UnknownShard(_))
    ));
    assert!(matches!(
        provisioner
            .provision(&ProvisionRequest::new("ws_missing"))
            .await,
        Err(ProvisionError::WorkspaceNotFound)
    ));

    // A database on Neon (or a shard this provisioner does not manage).
    let neon = fx.workspace("neon").await;
    sqlx::query(
        "update workspaces set neon_project_id = 'cool-neon-123', neon_database_name = 'neondb',
                neon_role_name = 'neondb_owner' where id = $1",
    )
    .bind(&neon)
    .execute(&fx.master)
    .await
    .expect("neon placement");
    assert!(matches!(
        provisioner.provision(&ProvisionRequest::new(&neon)).await,
        Err(ProvisionError::ForeignPlacement(_))
    ));
    assert!(matches!(
        provisioner.teardown(&neon).await,
        Err(ProvisionError::ForeignPlacement(_))
    ));

    // Teardown opens the full shard again.
    provisioner.teardown(&pinned).await.expect("teardown");
    assert_eq!(fx.shard_count(&small_key).await, (0, "active".to_owned()));
    provisioner.teardown(&refused).await.expect("teardown");
    fx.finish().await;
}

#[tokio::test]
async fn works_with_an_admin_that_has_createdb_and_createrole_only() {
    let Some(mut fx) = Fixture::new().await else {
        return;
    };
    // The Flux clusters' setup: a CREATEDB CREATEROLE owner role, and the
    // extensions in the template (pgvector is not a trusted extension).
    let admin_role = unique("cnpg_admin_");
    let template = unique("cnpg_tpl_");
    run(
        &mut fx.admin,
        &format!("create role {admin_role} login createdb createrole password 'admin-pw'"),
    )
    .await;
    run(&mut fx.admin, &format!("create database {template}")).await;
    let template_options = PgConnectOptions::from_str(&fx.admin_url)
        .expect("url")
        .database(&template);
    let mut tpl = PgConnection::connect_with(&template_options)
        .await
        .expect("template");
    run(
        &mut tpl,
        "create extension vector; create extension pg_trgm",
    )
    .await;
    tpl.close().await.expect("close");
    run(
        &mut fx.admin,
        &format!("alter database {template} is_template true"),
    )
    .await;

    let admin_url = format!(
        "postgres://{admin_role}:admin-pw@{}:{}/postgres",
        fx.host, fx.port
    );
    let shard = fx.shard(&unique("tenants-g"), &admin_url, 10);
    let mut options = CnpgOptions::new(vec![shard], keyring());
    "test".clone_into(&mut options.region);
    options.template = Some(template.clone());
    let provisioner = CnpgProvisioner::new(fx.master.clone(), options)
        .expect("options")
        .with_journal(small_journal());

    let workspace = fx.workspace("nonsuper").await;
    let made = provisioner
        .provision(&ProvisionRequest::new(&workspace))
        .await
        .expect("a non-superuser admin provisions");
    assert_eq!(made.migrations_applied, 2);
    let sealed: String = sqlx::query_scalar("select database_url from workspaces where id = $1")
        .bind(&workspace)
        .fetch_one(&fx.master)
        .await
        .expect("row");
    assert!(sealed.starts_with("v2:"), "AAD writes off: v2");
    assert_eq!(
        provisioner.teardown(&workspace).await.expect("and drops"),
        Teardown::Dropped(made.placement.clone())
    );
    assert!(!fx.database_exists(&made.placement.database_name).await);
    assert!(!fx.role_exists(&made.placement.role_name).await);

    run(
        &mut fx.admin,
        &format!("alter database {template} is_template false"),
    )
    .await;
    run(&mut fx.admin, &format!("drop database {template}")).await;
    run(&mut fx.admin, &format!("drop role {admin_role}")).await;
    fx.finish().await;
}
