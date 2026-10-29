//! S3: do sqlx's prepared statements survive `PgBouncer` in transaction mode?
//!
//! Many client connections share a few server connections, so consecutive
//! statements of one client land on different backends. Each client runs the
//! query shapes of `crates/db` (`query_as` with binds + `fetch_optional`, a
//! transaction) plus a stream of distinct statements that overflows both the
//! sqlx statement cache and `PgBouncer`'s `max_prepared_statements`. Every
//! result is checked, so a statement bound on the wrong backend shows up as
//! a wrong answer, not only as an error.

use std::error::Error;
use std::str::FromStr;
use std::time::Instant;

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, PgPool};

use crate::args::Args;
use crate::stats::Errors;

const TENANT_DB: &str = "s3_tenant";

const SCHEMA: &str = "
drop table if exists workspace_members, roles, notes;
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
create table notes (id bigint primary key, client int not null, body text not null);
insert into roles (id, name, permissions)
    select 'role_' || g, 'Role ' || g, '[\"leads:*\"]' from generate_series(0, 4) g;
insert into workspace_members (id, user_id, role_id)
    select 'mem_' || g, 'user_' || g, 'role_' || (g % 5) from generate_series(0, 99) g;
";

#[derive(sqlx::FromRow)]
struct Member {
    id: String,
    role_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Role {
    name: String,
    is_system: bool,
}

pub(crate) async fn run(args: &Args) -> Result<(), Box<dyn Error>> {
    let direct = args.string("direct")?;
    let pooled = args.string("pooled")?;
    let clients: u32 = args.get("clients", 40)?;
    let iterations: u32 = args.get("iterations", 300)?;
    let cache: usize = args.get("cache", 100)?;
    let persistent: bool = args.get("persistent", true)?;
    let distinct: u32 = args.get("distinct", 250)?;

    // Setup straight on Postgres, not through the pooler.
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&direct)
        .await?;
    let exists: bool =
        sqlx::query_scalar("select exists (select 1 from pg_database where datname = $1)")
            .bind(TENANT_DB)
            .fetch_one(&admin)
            .await?;
    if !exists {
        sqlx::raw_sql("create database s3_tenant")
            .execute(&admin)
            .await?;
    }
    admin.close().await;
    let tenant_direct = PgConnectOptions::from_str(&direct)?.database(TENANT_DB);
    let setup = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(tenant_direct)
        .await?;
    sqlx::raw_sql(SCHEMA).execute(&setup).await?;
    setup.close().await;

    let options = PgConnectOptions::from_str(&pooled)?
        .database(TENANT_DB)
        .statement_cache_capacity(cache);
    let pool = PgPoolOptions::new()
        .max_connections(clients)
        .min_connections(clients)
        .connect_with(options)
        .await?;

    let started = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for client in 0..clients {
        let pool = pool.clone();
        tasks.spawn(
            async move { client_loop(&pool, client, iterations, persistent, distinct).await },
        );
    }
    let mut errors = Errors::default();
    let mut ok = 0u64;
    let mut wrong = 0u64;
    while let Some(result) = tasks.join_next().await {
        let (client_ok, client_wrong, client_errors) = result?;
        ok += client_ok;
        wrong += client_wrong;
        errors.merge(client_errors);
    }
    println!(
        "s3 cache={cache} persistent={persistent} clients={clients} iterations={iterations} distinct={distinct}: \
         ok={ok} wrong={wrong} errors={} in {:.1}s",
        errors.total(),
        started.elapsed().as_secs_f64()
    );
    print!("{errors}");
    pool.close().await;
    Ok(())
}

/// One client: `iterations` rounds of the four operations. Returns
/// (operations that returned the right answer, wrong answers, errors).
async fn client_loop(
    pool: &PgPool,
    client: u32,
    iterations: u32,
    persistent: bool,
    distinct: u32,
) -> (u64, u64, Errors) {
    let mut ok = 0u64;
    let mut wrong = 0u64;
    let mut errors = Errors::default();
    for i in 0..iterations {
        let n = (client * 7 + i) % 100;
        let results = [
            member(pool, n, persistent).await,
            role(pool, n % 5, persistent).await,
            note(pool, client, i, persistent).await,
            churn(
                pool,
                i64::from(n),
                (client + i) % distinct.max(1),
                persistent,
            )
            .await,
        ];
        for result in results {
            match result {
                Ok(true) => ok += 1,
                Ok(false) => wrong += 1,
                Err(error) => errors.add(&error.to_string()),
            }
        }
    }
    (ok, wrong, errors)
}

/// `TenantPermissionQueries::get_member`.
async fn member(pool: &PgPool, n: u32, persistent: bool) -> Result<bool, sqlx::Error> {
    let row: Option<Member> = sqlx::query_as(
        "select id, role, role_id, permissions, permission_denies, member_type
         from workspace_members
         where user_id = $1 and deleted_at is null and status = 'ACTIVE'
         limit 1",
    )
    .bind(format!("user_{n}"))
    .persistent(persistent)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some_and(|m| {
        m.id == format!("mem_{n}") && m.role_id == Some(format!("role_{}", n % 5))
    }))
}

/// `TenantPermissionQueries::get_role_permissions`.
async fn role(pool: &PgPool, r: u32, persistent: bool) -> Result<bool, sqlx::Error> {
    let row: Option<Role> = sqlx::query_as(
        "select permissions, is_system, name from roles
         where id = $1 and deleted_at is null
         limit 1",
    )
    .bind(format!("role_{r}"))
    .persistent(persistent)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some_and(|role| role.name == format!("Role {r}") && !role.is_system))
}

/// A write in a transaction, read back inside it.
async fn note(pool: &PgPool, client: u32, i: u32, persistent: bool) -> Result<bool, sqlx::Error> {
    let id = i64::from(client) * 1_000_000 + i64::from(i);
    let body = format!("note {client}/{i}");
    let mut tx = pool.begin().await?;
    sqlx::query("insert into notes (id, client, body) values ($1, $2, $3) on conflict (id) do update set body = excluded.body")
        .bind(id)
        .bind(i32::try_from(client).unwrap_or(i32::MAX))
        .bind(&body)
        .persistent(persistent)
        .execute(&mut *tx)
        .await?;
    let read: Option<String> = sqlx::query_scalar("select body from notes where id = $1")
        .bind(id)
        .persistent(persistent)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(read.as_deref() == Some(body.as_str()))
}

/// One of `distinct` statement texts, so the caches turn over.
async fn churn(pool: &PgPool, n: i64, k: u32, persistent: bool) -> Result<bool, sqlx::Error> {
    // Built from an integer only; sqlx refuses non-literal SQL unless told so.
    let sql = format!("select $1::int8 + {k}");
    let value: i64 = sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(n)
        .persistent(persistent)
        .fetch_one(pool)
        .await?;
    Ok(value == n + i64::from(k))
}
