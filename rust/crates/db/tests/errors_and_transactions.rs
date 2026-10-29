//! Postgres error classification and `atomically` against a real Postgres:
//! the SQLSTATEs sqlx hands back for the cases the predicates name, the
//! "workspace moved" answers, and all-or-nothing commits.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a throwaway database (CI
//! starts one); otherwise each test returns early. The role test needs a
//! superuser, which the CI database's user is. Each test uses its own tables,
//! since the tests of one file run in parallel.

use std::str::FromStr;

use http::StatusCode;
use sqlx::Connection;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use weldsuite_db::{
    Keyring, MovedDatabaseFailure, PgPool, WorkspaceConfig, Workspaces, atomically,
    atomically_with, classify_moved_database_error, database_error, is_foreign_key_violation,
    is_missing_table, is_password_auth_failure, is_read_only_transaction, is_unique_violation,
    pg_error_code,
};
use weldsuite_kit::ApiError;

fn database_url() -> Option<String> {
    let url = std::env::var("WELDSUITE_TEST_DATABASE_URL").ok();
    if url.is_none() {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
    }
    url
}

async fn pool(url: &str) -> PgPool {
    PgPoolOptions::new()
        .max_connections(3)
        .connect(url)
        .await
        .expect("connect")
}

#[tokio::test]
async fn constraint_violations_carry_their_sqlstate() {
    let Some(url) = database_url() else { return };
    let pool = pool(&url).await;
    sqlx::raw_sql(
        "drop table if exists kit_codes_children, kit_codes_parents;
         create table kit_codes_parents (id text primary key);
         create table kit_codes_children (
             id text primary key,
             parent_id text not null references kit_codes_parents (id)
         );
         insert into kit_codes_parents values ('p1');",
    )
    .execute(&pool)
    .await
    .expect("schema");

    let duplicate = sqlx::query("insert into kit_codes_parents values ($1)")
        .bind("p1")
        .execute(&pool)
        .await
        .expect_err("duplicate key");
    assert!(is_unique_violation(&duplicate));
    assert!(!is_foreign_key_violation(&duplicate));
    assert_eq!(pg_error_code(&duplicate).as_deref(), Some("23505"));

    let orphan = sqlx::query("insert into kit_codes_children values ($1, $2)")
        .bind("c1")
        .bind("p_missing")
        .execute(&pool)
        .await
        .expect_err("missing parent");
    assert!(is_foreign_key_violation(&orphan));
    assert!(!is_unique_violation(&orphan));

    let missing = sqlx::query("select 1 from kit_codes_nowhere")
        .execute(&pool)
        .await
        .expect_err("missing table");
    assert!(is_missing_table(&missing));

    // A route that did not expect it answers onError's 500.
    for err in [&duplicate, &orphan, &missing] {
        assert_eq!(classify_moved_database_error(err), None);
        let answer = database_error(err);
        assert_eq!(answer.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(answer.message(), "An unexpected error occurred");
    }
}

#[tokio::test]
async fn a_read_only_database_is_a_moving_workspace() {
    let Some(url) = database_url() else { return };
    let pool = pool(&url).await;
    sqlx::raw_sql(
        "drop table if exists kit_ro_notes; create table kit_ro_notes (body text not null);",
    )
    .execute(&pool)
    .await
    .expect("schema");

    // What a moved source does to every write once it is locked.
    let refused = atomically_with(&pool, |conn| {
        Box::pin(async move {
            sqlx::query("set transaction read only")
                .execute(&mut *conn)
                .await?;
            sqlx::query("insert into kit_ro_notes values ($1)")
                .bind("password authentication failed")
                .execute(&mut *conn)
                .await?;
            Ok::<_, sqlx::Error>(())
        })
    })
    .await
    .expect_err("read-only transaction");
    assert_eq!(pg_error_code(&refused).as_deref(), Some("25006"));
    assert!(is_read_only_transaction(&refused));
    // The bound value says otherwise, and is never part of the error.
    assert!(!is_password_auth_failure(&refused));
    assert_eq!(
        classify_moved_database_error(&refused),
        Some(MovedDatabaseFailure::ReadOnly)
    );
    assert_eq!(database_error(&refused), ApiError::workspace_moving());
}

const MASTER_SCHEMA: &str = "
create table if not exists partners (id varchar(30) primary key, status varchar(20) not null default 'active');
create table if not exists workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    database_url text,
    is_active boolean not null default true,
    billing_mode varchar(20) not null default 'direct',
    partner_id varchar(30)
);
create table if not exists workspace_licences (
    workspace_id varchar(255) not null unique,
    allowed_apps jsonb not null default '[]',
    status varchar(20) not null default 'active'
);
create table if not exists workspace_database_moves (
    workspace_id varchar(255) not null,
    status varchar(20) not null default 'queued'
);
delete from workspaces where id = 'ws_kit_rotated';
drop role if exists kit_rotated;
create role kit_rotated login password 'before-the-move';
";

#[tokio::test]
async fn a_rotated_password_is_a_moving_workspace_and_drops_the_cached_one() {
    let Some(url) = database_url() else { return };
    let master = pool(&url).await;
    sqlx::raw_sql(MASTER_SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, database_url) values ('ws_kit_rotated', 'org_kit_rotated', $1)",
    )
    .bind(&url)
    .execute(&master)
    .await
    .expect("workspace");

    // A tenant pool holding the role's URL from before the move.
    let options = PgConnectOptions::from_str(&url)
        .expect("url")
        .username("kit_rotated")
        .password("before-the-move");
    let before = sqlx::PgConnection::connect_with(&options)
        .await
        .expect("the old password works");
    before.close().await.expect("close");

    sqlx::query("alter role kit_rotated password 'after-the-move'")
        .execute(&master)
        .await
        .expect("rotate");
    let tenant_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy_with(options);
    let rotated = sqlx::query("select 1")
        .execute(&tenant_pool)
        .await
        .expect_err("the old password is refused");
    assert_eq!(pg_error_code(&rotated).as_deref(), Some("28P01"));
    assert!(is_password_auth_failure(&rotated));
    assert_eq!(
        classify_moved_database_error(&rotated),
        Some(MovedDatabaseFailure::PasswordRotated)
    );

    // The resolved workspace is cached; a change on master is not seen ...
    let workspaces = Workspaces::new(
        master.clone(),
        Keyring::default(),
        WorkspaceConfig::default(),
    );
    let tenant = workspaces.tenant("org_kit_rotated").await.expect("tenant");
    assert!(!tenant.suspended);
    sqlx::query("update workspaces set is_active = false where id = 'ws_kit_rotated'")
        .execute(&master)
        .await
        .expect("suspend");
    assert!(
        !workspaces
            .tenant("org_kit_rotated")
            .await
            .expect("cached")
            .suspended
    );

    // ... until the rotated password drops the entry.
    let answer = workspaces.database_error(&tenant, &rotated);
    assert_eq!(answer, ApiError::workspace_moving());
    assert!(
        workspaces
            .tenant("org_kit_rotated")
            .await
            .expect("re-read")
            .suspended
    );

    // A read-only source keeps the cached entry: its URL still works.
    sqlx::query("update workspaces set is_active = true where id = 'ws_kit_rotated'")
        .execute(&master)
        .await
        .expect("resume");
    let read_only =
        sqlx::Error::Protocol("cannot execute INSERT in a read-only transaction".into());
    assert_eq!(
        workspaces.database_error(&tenant, &read_only),
        ApiError::workspace_moving()
    );
    assert!(
        workspaces
            .tenant("org_kit_rotated")
            .await
            .expect("cached")
            .suspended
    );

    tenant_pool.close().await;
    sqlx::raw_sql("delete from workspaces where id = 'ws_kit_rotated'; drop role kit_rotated;")
        .execute(&master)
        .await
        .expect("clean up");
}

async fn notes(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar("select body from kit_atomic_notes order by body")
        .fetch_all(pool)
        .await
        .expect("notes")
}

fn assert_send<T: Send>(_: &T) {}

/// A handler's own error type, which takes the database's errors in.
#[derive(Debug)]
enum Refusal {
    Database(#[allow(dead_code)] sqlx::Error),
    ChangedMyMind,
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

#[tokio::test]
async fn atomically_commits_all_or_nothing() {
    let Some(url) = database_url() else { return };
    let pool = pool(&url).await;
    sqlx::raw_sql(
        "drop table if exists kit_atomic_notes; create table kit_atomic_notes (body text primary key);",
    )
    .execute(&pool)
    .await
    .expect("schema");

    // Every statement runs, in order, and commits.
    let results = atomically(
        &pool,
        ["a", "b"].map(|body| sqlx::query("insert into kit_atomic_notes values ($1)").bind(body)),
    )
    .await
    .expect("batch");
    assert_eq!(
        results
            .iter()
            .map(sqlx::postgres::PgQueryResult::rows_affected)
            .collect::<Vec<_>>(),
        [1, 1]
    );
    assert_eq!(notes(&pool).await, ["a", "b"]);

    // One failing statement undoes the ones before it.
    let failed = atomically(
        &pool,
        ["c", "a"].map(|body| sqlx::query("insert into kit_atomic_notes values ($1)").bind(body)),
    )
    .await
    .expect_err("duplicate");
    assert!(is_unique_violation(&failed));
    assert_eq!(notes(&pool).await, ["a", "b"]);

    // On a connection, too.
    let mut conn = pool.acquire().await.expect("acquire");
    atomically(
        &mut *conn,
        [sqlx::query("insert into kit_atomic_notes values ($1)").bind("d")],
    )
    .await
    .expect("on a connection");
    drop(conn);
    assert_eq!(notes(&pool).await, ["a", "b", "d"]);

    // The interactive form reads between writes and returns its value.
    let count = atomically_with(&pool, |conn| {
        Box::pin(async move {
            sqlx::query("insert into kit_atomic_notes values ($1)")
                .bind("e")
                .execute(&mut *conn)
                .await?;
            sqlx::query_scalar::<_, i64>("select count(*) from kit_atomic_notes")
                .fetch_one(&mut *conn)
                .await
        })
    })
    .await
    .expect("interactive");
    assert_eq!(count, 4);

    // An error of the caller's own rolls back too, and comes back unchanged.
    let refused: Result<(), Refusal> = atomically_with(&pool, |conn| {
        Box::pin(async move {
            sqlx::query("insert into kit_atomic_notes values ($1)")
                .bind("f")
                .execute(&mut *conn)
                .await?;
            Err(Refusal::ChangedMyMind)
        })
    })
    .await;
    assert!(matches!(refused, Err(Refusal::ChangedMyMind)));
    assert_eq!(notes(&pool).await, ["a", "b", "d", "e"]);

    // Both futures can run on a multi-threaded runtime, as handlers do.
    let batch = atomically(&pool, Vec::new());
    assert_send(&batch);
    batch.await.expect("empty batch");
    let interactive = atomically_with(&pool, |_conn| Box::pin(async { Ok::<_, sqlx::Error>(()) }));
    assert_send(&interactive);
    interactive.await.expect("empty transaction");
}
