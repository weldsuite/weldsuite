//! What the WeldPanel store's integration tests share: a scratch master
//! database with every master migration applied (so the catalog's and the
//! ledger's tables are the migration's), and the store on it with its
//! tables in a temp dir. They run against throwaway services and skip
//! without them: `WELDSUITE_TEST_DATABASE_URL` (a role that may create
//! databases), and for the writer `WELDSUITE_TEST_NATS_URL` (with `JetStream`)
//! and `WELDSUITE_TEST_VALKEY_URL`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::{Connection, PgConnection};
use weldsuite_db::PgPool;
use weldsuite_lakehouse::{Lakehouse, LakehouseConfig};
use weldsuite_migrations::{Folder, Journal, migrate};

/// A name no other test run uses.
pub(crate) fn unique(label: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or_default();
    format!(
        "{label}{}x{}x{nanos}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// A master database made for one test, migrated, and a store on it.
pub(crate) struct ScratchPanel {
    pub(crate) master: PgPool,
    pub(crate) lake: Lakehouse,
    admin: String,
    database: String,
    dir: PathBuf,
}

impl ScratchPanel {
    /// `None` (the test skips) without `WELDSUITE_TEST_DATABASE_URL`.
    pub(crate) async fn new() -> Option<Self> {
        let Ok(admin) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
            eprintln!("skipped: WELDSUITE_TEST_DATABASE_URL is not set");
            return None;
        };
        let database = unique("wspanel_");
        let mut conn = PgConnection::connect(&admin)
            .await
            .expect("the admin database");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"create database "{database}""#
        )))
        .execute(&mut conn)
        .await
        .expect("a scratch database");
        let url = with_database(&admin, &database);
        let mut scratch = PgConnection::connect(&url)
            .await
            .expect("the scratch database");
        migrate(&mut scratch, Journal::embedded(Folder::Master))
            .await
            .expect("the master migrations");
        let master = sqlx::postgres::PgPoolOptions::new()
            .max_connections(4)
            .connect(&url)
            .await
            .expect("a pool");
        let dir = std::env::temp_dir().join(unique("weldsuite-panel-"));
        std::fs::create_dir_all(dir.join("warehouse")).expect("a temp dir");
        let lake = Lakehouse::new(
            master.clone(),
            &LakehouseConfig {
                catalog_name: weldsuite_lakehouse::CATALOG_NAME.to_owned(),
                warehouse: file_url(&dir.join("warehouse")),
                storage: HashMap::new(),
            },
        )
        .expect("the store");
        lake.ensure_tables().await.expect("the tables");
        Some(Self {
            master,
            lake,
            admin,
            database,
            dir,
        })
    }

    /// The tables' temp dir.
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    /// Drops the database and the files.
    pub(crate) async fn finish(self) {
        self.master.close().await;
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Ok(mut conn) = PgConnection::connect(&self.admin).await {
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                r#"drop database if exists "{}" with (force)"#,
                self.database
            )))
            .execute(&mut conn)
            .await;
        }
    }

    /// Rows in a table, by the live files' record counts.
    pub(crate) async fn rows(&self, table: weldsuite_lakehouse::PanelTable) -> u64 {
        self.lake
            .live_data_files(table)
            .await
            .expect("the files")
            .iter()
            .map(weldsuite_lakehouse::DataFile::record_count)
            .sum()
    }
}

/// The tenant schema (`WELDSUITE_TEST_TENANT_URL`: a database built from
/// the journaled migrations by `scripts/rust-test-db.ts`, shared by the
/// tests). Tests keep to projects of their own.
pub(crate) struct ScratchTenant {
    pub(crate) pool: PgPool,
}

impl ScratchTenant {
    /// `None` (the test skips) without `WELDSUITE_TEST_TENANT_URL`.
    pub(crate) async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("skipped: WELDSUITE_TEST_TENANT_URL is not set");
            return None;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(8)
            .connect(&url)
            .await
            .expect("the tenant database");
        Some(Self { pool })
    }

    /// Closes the pool.
    pub(crate) async fn finish(self) {
        self.pool.close().await;
    }
}

/// `url` with its database replaced by `name`.
fn with_database(url: &str, name: &str) -> String {
    let (base, query) = url
        .split_once('?')
        .map_or((url, None), |(b, q)| (b, Some(q)));
    let (server, _) = base.rsplit_once('/').unwrap_or((base, ""));
    match query {
        Some(query) => format!("{server}/{name}?{query}"),
        None => format!("{server}/{name}"),
    }
}

/// A `file:` URL the tables name their files by.
pub(crate) fn file_url(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.starts_with('/') {
        format!("file:{text}")
    } else {
        format!("file:/{text}")
    }
}

/// One `events_v1` row of `workspace`/`project` at `ts` (ISO 8601).
pub(crate) fn event(
    workspace: &str,
    project: &str,
    id: &str,
    person: &str,
    session: &str,
    ts: &str,
) -> serde_json::Value {
    serde_json::json!({
        "event_id": id,
        "workspace_id": workspace,
        "project_id": project,
        "name": "$pageview",
        "ts": ts,
        "received_at": ts,
        "distinct_id": person,
        "anon_id": person,
        "user_id": serde_json::Value::Null,
        "session_id": session,
        "cookieless": false,
        "url": "https://shop.example/",
        "host": "shop.example",
        "path": "/",
        "properties": "{}",
        "lib": "web",
        "lib_version": "0.1.0",
    })
}
