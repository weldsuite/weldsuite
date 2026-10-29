//! The runner against a real Postgres.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a server where that role
//! may create databases (CI's scratch database, as a superuser: the tenant
//! journal creates the pgvector extension, so use the `pgvector/pgvector`
//! image); otherwise each test returns early. Every test makes its own
//! databases and drops them.
//!
//! Parity with the TypeScript runners (identical `pg_dump --schema-only` and
//! `__drizzle_migrations` rows, either runner finishing what the other
//! started) was checked by running both; see the module docs of `apply.rs`.

use std::sync::atomic::{AtomicU32, Ordering};

use sqlx::{Connection, PgConnection};
use weldsuite_db::{Keyring, encrypt_field, encrypt_workspace_database_url};
use weldsuite_migrations::{
    DatabaseOptions, Folder, Journal, MigrateError, Migration, check_journal, list_tenants,
    migrate, migrate_database, migrate_tenants, pending, recorded,
};

/// No tags.
const NONE: [String; 0] = [];

/// A database made for one test.
struct Scratch {
    admin: String,
    name: String,
    url: String,
}

impl Scratch {
    async fn new(label: &str) -> Option<Self> {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let Ok(admin) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
            eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
            return None;
        };
        let name = format!(
            "wsmig_{label}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let mut conn = PgConnection::connect(&admin)
            .await
            .expect("admin connection");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(r#"create database "{name}""#)))
            .execute(&mut conn)
            .await
            .expect("create database");
        let url = with_database(&admin, &name);
        Some(Self { admin, name, url })
    }

    async fn connect(&self) -> PgConnection {
        PgConnection::connect(&self.url).await.expect("connect")
    }

    async fn drop(self) {
        let mut conn = PgConnection::connect(&self.admin)
            .await
            .expect("admin connection");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"drop database if exists "{}" with (force)"#,
            self.name
        )))
        .execute(&mut conn)
        .await
        .expect("drop database");
    }
}

/// `url` with its database replaced by `name`.
fn with_database(url: &str, name: &str) -> String {
    let (base, query) = url
        .split_once('?')
        .map_or((url, None), |(b, q)| (b, Some(q)));
    let scheme_end = base.find("://").map_or(0, |i| i + 3);
    let path_start = base[scheme_end..]
        .find('/')
        .map_or(base.len(), |i| scheme_end + i);
    let mut out = format!("{}/{name}", &base[..path_start]);
    if let Some(query) = query {
        out.push('?');
        out.push_str(query);
    }
    out
}

fn synthetic(migrations: &[(&'static str, i64, &'static str)]) -> Journal {
    Journal::new(
        Folder::Tenant,
        migrations
            .iter()
            .map(|(tag, when, sql)| Migration::new(*tag, *when, *sql))
            .collect(),
    )
}

async fn table_exists(conn: &mut PgConnection, schema: &str, table: &str) -> bool {
    sqlx::query_scalar(
        "select exists (select 1 from information_schema.tables where table_schema = $1 and table_name = $2)",
    )
    .bind(schema)
    .bind(table)
    .fetch_one(conn)
    .await
    .expect("information_schema")
}

#[tokio::test]
async fn a_fresh_tenant_database_reaches_the_journal_level_with_drizzles_rows() {
    let Some(db) = Scratch::new("fresh").await else {
        return;
    };
    let journal = Journal::embedded(Folder::Tenant);
    let outcome = migrate_database(&db.url, journal, DatabaseOptions::default())
        .await
        .expect("migrate");
    assert_eq!(outcome.applied.len(), journal.migrations().len());
    assert_eq!(outcome.journal_gap, None);

    let mut conn = db.connect().await;
    let rows = recorded(&mut conn, Folder::Tenant).await.expect("rows");
    assert_eq!(rows.len(), journal.migrations().len());
    for (row, migration) in rows.iter().zip(journal.migrations()) {
        assert_eq!(row.tag, None, "Drizzle's migrator records no tag");
        assert_eq!(row.hash.as_deref(), Some(migration.hash()));
        assert_eq!(row.created_at, Some(migration.when().to_string()));
    }
    assert!(!table_exists(&mut conn, "drizzle", "__drizzle_migrations").await);
    assert_eq!(pending(&mut conn, journal).await.expect("pending"), NONE);

    // A second run applies nothing.
    let again = migrate(&mut conn, journal).await.expect("rerun");
    assert_eq!(again, NONE);
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn the_master_keeps_its_rows_in_the_drizzle_schema() {
    let Some(db) = Scratch::new("master").await else {
        return;
    };
    let journal = Journal::embedded(Folder::Master);
    let mut conn = db.connect().await;
    assert_eq!(
        pending(&mut conn, journal).await.expect("pending").len(),
        journal.migrations().len()
    );
    let applied = migrate(&mut conn, journal).await.expect("migrate");
    assert_eq!(applied.len(), journal.migrations().len());
    assert!(table_exists(&mut conn, "drizzle", "__drizzle_migrations").await);
    assert!(!table_exists(&mut conn, "public", "__drizzle_migrations").await);
    assert!(table_exists(&mut conn, "public", "workspaces").await);
    assert!(
        check_journal(&mut conn, journal)
            .await
            .expect("check")
            .is_at_journal_level()
    );
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn an_older_releases_database_gets_the_rest() {
    let Some(db) = Scratch::new("partial").await else {
        return;
    };
    let journal = Journal::embedded(Folder::Tenant);
    let older = journal.truncated(100);
    let mut conn = db.connect().await;
    assert_eq!(migrate(&mut conn, &older).await.expect("older").len(), 100);
    let rest = pending(&mut conn, journal).await.expect("pending");
    assert_eq!(rest.len(), journal.migrations().len() - 100);
    assert_eq!(rest[0], journal.migrations()[100].tag());

    let applied = migrate(&mut conn, journal).await.expect("rest");
    assert_eq!(applied, rest);
    assert!(
        check_journal(&mut conn, journal)
            .await
            .expect("check")
            .is_at_journal_level()
    );
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn a_migration_merged_with_an_older_timestamp_is_reported_and_applied_on_request() {
    let Some(db) = Scratch::new("skipped").await else {
        return;
    };
    let before = synthetic(&[
        ("0000_a", 100, "CREATE TABLE a (id int);"),
        ("0002_c", 300, "CREATE TABLE c (id int);"),
    ]);
    let after = synthetic(&[
        ("0000_a", 100, "CREATE TABLE a (id int);"),
        (
            "0001_b",
            200,
            "CREATE TABLE b (id int);--> statement-breakpoint\nINSERT INTO b VALUES (1);",
        ),
        ("0002_c", 300, "CREATE TABLE c (id int);"),
    ]);
    migrate_database(&db.url, &before, DatabaseOptions::default())
        .await
        .expect("before");

    // Drizzle's rule: 0001_b is older than the newest row, so it is skipped
    // for good, and the journal check says so.
    let outcome = migrate_database(&db.url, &after, DatabaseOptions::default())
        .await
        .expect("after");
    assert_eq!(outcome.applied, NONE);
    assert_eq!(
        outcome.journal_gap.as_deref(),
        Some("1 migration(s) missing (0001_b)")
    );

    // --check-journal changes nothing.
    let checked = migrate_database(
        &db.url,
        &after,
        DatabaseOptions {
            apply_skipped: true,
            check_only: true,
        },
    )
    .await
    .expect("check");
    assert_eq!(checked.applied_skipped, NONE);
    assert!(checked.journal_gap.is_some());

    // --apply-skipped applies it and records it with its tag.
    let fixed = migrate_database(
        &db.url,
        &after,
        DatabaseOptions {
            apply_skipped: true,
            check_only: false,
        },
    )
    .await
    .expect("apply skipped");
    assert_eq!(fixed.applied_skipped, ["0001_b"]);
    assert_eq!(fixed.journal_gap, None);
    let mut conn = db.connect().await;
    let rows = recorded(&mut conn, Folder::Tenant).await.expect("rows");
    assert_eq!(
        rows.last().and_then(|row| row.tag.as_deref()),
        Some("0001_b")
    );
    let b: i64 = sqlx::query_scalar("select count(*) from b")
        .fetch_one(&mut conn)
        .await
        .expect("b");
    assert_eq!(b, 1);
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn a_failing_migration_rolls_back_the_whole_run() {
    let Some(db) = Scratch::new("failing").await else {
        return;
    };
    let journal = synthetic(&[
        ("0000_a", 100, "CREATE TABLE a (id int);"),
        (
            "0001_b",
            200,
            "CREATE TABLE b (id int);--> statement-breakpoint\nCREATE TABLE a (id int);",
        ),
    ]);
    let error = migrate_database(&db.url, &journal, DatabaseOptions::default())
        .await
        .expect_err("0001_b fails");
    assert!(matches!(error, MigrateError::Migration { .. }), "{error:?}");
    assert_eq!(error.tag(), Some("0001_b"));
    assert_eq!(error.sql_state().as_deref(), Some("42P07"));
    assert_eq!(
        error.to_string(),
        r#"migration 0001_b failed (2 statements in one transaction, SQLSTATE 42P07): relation "a" already exists"#
    );

    // One transaction: nothing of 0000_a either. The bookkeeping table stays,
    // as Drizzle creates it before its transaction.
    let mut conn = db.connect().await;
    assert!(!table_exists(&mut conn, "public", "a").await);
    assert!(table_exists(&mut conn, "public", "__drizzle_migrations").await);
    assert_eq!(
        recorded(&mut conn, Folder::Tenant)
            .await
            .expect("rows")
            .len(),
        0
    );
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn two_runners_on_one_database_take_turns() {
    let Some(db) = Scratch::new("concurrent").await else {
        return;
    };
    let journal = synthetic(&[
        (
            "0000_a",
            100,
            "CREATE TABLE a (id int);--> statement-breakpoint\nSELECT pg_sleep(0.3);",
        ),
        ("0001_b", 200, "CREATE TABLE b (id int);"),
    ]);
    let (first, second) = tokio::join!(
        migrate_database(&db.url, &journal, DatabaseOptions::default()),
        migrate_database(&db.url, &journal, DatabaseOptions::default()),
    );
    let mut applied = [
        first.expect("first").applied.len(),
        second.expect("second").applied.len(),
    ];
    applied.sort_unstable();
    assert_eq!(applied, [0, 2], "one applied everything, the other nothing");
    let mut conn = db.connect().await;
    assert_eq!(
        recorded(&mut conn, Folder::Tenant)
            .await
            .expect("rows")
            .len(),
        2
    );
    conn.close().await.expect("close");
    db.drop().await;
}

#[tokio::test]
async fn lists_the_tenants_the_typescript_runner_would_migrate() {
    let Some(master) = Scratch::new("tenants").await else {
        return;
    };
    let mut conn = master.connect().await;
    migrate(&mut conn, Journal::embedded(Folder::Master))
        .await
        .expect("master schema");

    let keyring = Keyring {
        v1: Some("11".repeat(32)),
        v2: Some("22".repeat(32)),
    };
    let url = |name: &str| format!("postgres://role:pw@tenants-1-pooler:5432/{name}");
    let v2 = encrypt_field(&url("f"), &keyring).expect("v2");
    let v3_elsewhere =
        encrypt_workspace_database_url(&url("g"), "ws_other", &keyring, true).expect("v3");
    let rows: [(&str, bool, Option<&str>, Option<String>); 7] = [
        ("ws_a", true, Some("cnpg:tenants-1"), Some(url("a"))),
        ("ws_b", false, Some("cnpg:tenants-1"), Some(url("b"))),
        ("ws_c", true, None, Some(url("c"))),
        ("ws_d", true, Some("cnpg:tenants-1"), Some(url("d"))),
        ("ws_e", true, Some("cnpg:tenants-1"), None),
        ("ws_f", true, Some("cnpg:tenants-1"), Some(v2)),
        ("ws_g", true, Some("cnpg:tenants-1"), Some(v3_elsewhere)),
    ];
    for (id, active, placement, database_url) in rows {
        sqlx::query(
            "insert into workspaces (id, name, slug, is_active, neon_project_id, database_url)
             values ($1, $1, $1, $2, $3, $4)",
        )
        .bind(id)
        .bind(active)
        .bind(placement)
        .bind(database_url)
        .execute(&mut conn)
        .await
        .expect("workspace");
    }
    sqlx::query(
        "insert into workspace_database_moves
             (id, workspace_id, kind, status, requested_target, source_neon_project_id,
              source_neon_branch_id, source_database_name, source_role_name, started_by)
         values ('mv_1', 'ws_d', 'shard_to_dedicated', 'copying', 'dedicated', 'p', 'b', 'd', 'r', 'ops'),
                ('mv_2', 'ws_a', 'shard_to_dedicated', 'completed', 'dedicated', 'p', 'b', 'd', 'r', 'ops')",
    )
    .execute(&mut conn)
    .await
    .expect("moves");

    let list = list_tenants(&mut conn, &keyring, None).await.expect("list");
    let ids = |refs: Vec<&str>| refs.into_iter().map(str::to_owned).collect::<Vec<_>>();
    let mut databases: Vec<(String, String)> = list
        .databases
        .iter()
        .map(|db| (db.workspace.id.clone(), db.database_url().to_owned()))
        .collect();
    databases.sort();
    assert_eq!(
        databases,
        [("ws_a".to_owned(), url("a")), ("ws_f".to_owned(), url("f"))]
    );
    assert_eq!(
        list.moving.iter().map(|w| w.id.clone()).collect::<Vec<_>>(),
        ids(vec!["ws_d"])
    );
    assert_eq!(
        list.without_url
            .iter()
            .map(|w| w.id.clone())
            .collect::<Vec<_>>(),
        ids(vec!["ws_e"])
    );
    assert_eq!(list.unresolvable.len(), 1);
    assert_eq!(list.unresolvable[0].0.id, "ws_g");
    assert!(
        !format!("{:?}", list.databases).contains("pw@"),
        "Debug hides URLs"
    );

    let only = list_tenants(&mut conn, &keyring, Some("ws_f"))
        .await
        .expect("only");
    assert_eq!(only.databases.len(), 1);
    assert!(only.moving.is_empty() && only.without_url.is_empty());
    let none = list_tenants(&mut conn, &keyring, Some("ws_b"))
        .await
        .expect("inactive");
    assert!(none.databases.is_empty());

    conn.close().await.expect("close");
    master.drop().await;
}

#[tokio::test]
async fn migrates_tenants_concurrently_and_reports_each_in_order() {
    let (Some(one), Some(two)) = (Scratch::new("run_one").await, Scratch::new("run_two").await)
    else {
        return;
    };
    let journal: &'static Journal = Box::leak(Box::new(synthetic(&[(
        "0000_a",
        100,
        "CREATE TABLE a (id int);",
    )])));
    let workspace = |id: &str| weldsuite_migrations::WorkspaceRef {
        id: id.to_owned(),
        name: id.to_owned(),
    };
    let databases = vec![
        weldsuite_migrations::TenantDatabase::new(workspace("ws_1"), one.url.clone()),
        weldsuite_migrations::TenantDatabase::new(
            workspace("ws_2"),
            with_database(&one.url, "wsmig_does_not_exist"),
        ),
        weldsuite_migrations::TenantDatabase::new(workspace("ws_3"), two.url.clone()),
    ];
    let mut seen = Vec::new();
    let results = migrate_tenants(
        databases,
        journal,
        DatabaseOptions::default(),
        3,
        |index, _| {
            seen.push(index);
        },
    )
    .await;
    seen.sort_unstable();
    assert_eq!(seen, [0, 1, 2]);
    let ids: Vec<&str> = results.iter().map(|r| r.workspace.id.as_str()).collect();
    assert_eq!(ids, ["ws_1", "ws_2", "ws_3"]);
    assert_eq!(results[0].outcome.as_ref().map(|o| o.applied.len()), Ok(1));
    assert!(
        results[1].outcome.is_err(),
        "one failure never stops the others"
    );
    assert_eq!(results[2].outcome.as_ref().map(|o| o.applied.len()), Ok(1));
    one.drop().await;
    two.drop().await;
}
