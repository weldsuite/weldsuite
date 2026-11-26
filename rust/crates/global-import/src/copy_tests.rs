//! The tenant copy on a real Postgres (`WELDSUITE_TEST_DATABASE_URL`, a
//! scratch server the tests may create databases on; skipped without it):
//! two databases with the same schema, one with rows, copied across.
//! The schema has what the tenant schema has: foreign keys in a cycle, a
//! generated column, a trigger that writes elsewhere, sequences, a
//! partitioned table, a materialized view, pgvector, arrays and JSON, and
//! rows its migrations seeded.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::str::FromStr as _;

use sqlx::postgres::PgConnectOptions;
use sqlx::{AssertSqlSafe, ConnectOptions as _, Connection as _, PgConnection};

use crate::tenant::copy_database;

const SCHEMA: &str = r"
create extension if not exists vector;
create table companies (
  id text primary key,
  name text not null,
  parent_id text references companies(id),
  owner_id text,
  search tsvector generated always as (to_tsvector('simple', name)) stored
);
create table people (
  id text primary key,
  company_id text not null references companies(id) on delete cascade,
  embedding vector(3),
  tags text[],
  meta jsonb,
  amount numeric(12, 2),
  seen_at timestamptz,
  photo bytea
);
alter table companies add constraint companies_owner_fk foreign key (owner_id) references people(id);
create table counters (id serial primary key, label text not null);
create table audit (id serial primary key, note text not null);
create function log_person() returns trigger language plpgsql as $$
  begin insert into audit (note) values ('person ' || new.id); return new; end
$$;
create trigger people_audit after insert on people for each row execute function log_person();
create materialized view company_counts as
  select company_id, count(*) as people from people group by company_id with no data;
create table events (id text not null, at date not null, primary key (id, at)) partition by range (at);
create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
create table __drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
";

struct Server {
    admin: PgConnection,
    options: PgConnectOptions,
    names: Vec<String>,
}

impl Server {
    async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
            eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
            return None;
        };
        let options = PgConnectOptions::from_str(&url).expect("url");
        let admin = options.connect().await.expect("admin");
        Some(Self {
            admin,
            options,
            names: Vec::new(),
        })
    }

    async fn database(&mut self, label: &str) -> PgConnection {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .subsec_nanos();
        let name = format!("gi_{label}_{}_{nanos}", std::process::id());
        sqlx::raw_sql(AssertSqlSafe(format!("create database {name}")))
            .execute(&mut self.admin)
            .await
            .expect("create database");
        self.names.push(name.clone());
        self.options
            .clone()
            .database(&name)
            .connect()
            .await
            .expect("connect")
    }

    async fn drop_all(mut self) {
        for name in &self.names {
            let _ = sqlx::raw_sql(AssertSqlSafe(format!(
                "drop database if exists {name} with (force)"
            )))
            .execute(&mut self.admin)
            .await;
        }
    }
}

async fn run(conn: &mut PgConnection, sql: &str) {
    sqlx::raw_sql(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *conn)
        .await
        .expect(sql);
}

async fn text(conn: &mut PgConnection, sql: &str) -> String {
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *conn)
        .await
        .expect(sql)
}

async fn number(conn: &mut PgConnection, sql: &str) -> i64 {
    sqlx::query_scalar(AssertSqlSafe(sql.to_owned()))
        .fetch_one(&mut *conn)
        .await
        .expect(sql)
}

#[tokio::test]
#[allow(
    clippy::too_many_lines,
    reason = "one copy, checked feature by feature"
)]
async fn copies_every_row_and_puts_the_schema_back_as_it_was() {
    let Some(mut server) = Server::new().await else {
        return;
    };
    let mut source = server.database("src").await;
    let mut target = server.database("dst").await;
    run(&mut source, SCHEMA).await;
    run(&mut target, SCHEMA).await;

    // Global's rows: two companies that own each other through people, a
    // counter whose sequence ran ahead of its rows, two events.
    run(
        &mut source,
        r#"
        insert into companies (id, name) values ('c1', 'Acme Holding'), ('c2', 'Acme Retail');
        insert into people values
          ('p1', 'c1', '[1,2,3]', '{a,"b c"}', '{"k": [1, {"x": null}]}', 1234.50, '2026-11-20 10:00:00+00', '\xdeadbeef'),
          ('p2', 'c2', null, '{}', null, null, null, null);
        update companies set owner_id = 'p1', parent_id = null where id = 'c1';
        update companies set owner_id = 'p2', parent_id = 'c1' where id = 'c2';
        insert into counters (label) values ('one'), ('two'), ('three'), ('four');
        delete from counters where label = 'four';
        insert into events values ('e1', '2026-03-01'), ('e2', '2026-09-01');
        insert into __drizzle_migrations (hash, created_at) values ('global', 1);
        "#,
    )
    .await;
    // What the install's migrations seeded, and its own migration row.
    run(
        &mut target,
        "insert into counters (label) values ('seeded'); \
         insert into __drizzle_migrations (hash, created_at) values ('install', 1);",
    )
    .await;

    let copied = copy_database(&mut source, &mut target).await.expect("copy");
    let rows = |table: &str| {
        copied
            .iter()
            .find(|entry| entry.table == table)
            .map(|entry| entry.rows)
    };
    assert_eq!(rows("companies"), Some(2));
    assert_eq!(rows("people"), Some(2));
    assert_eq!(rows("counters"), Some(3));
    assert_eq!(rows("audit"), Some(2), "the trigger's rows, copied once");
    assert_eq!(rows("events"), Some(2), "through the partitioned parent");
    assert_eq!(rows("events_2026"), None, "a partition isn't copied twice");
    assert_eq!(rows("__drizzle_migrations"), None);

    let person = "select row_to_json(p)::text from people p where id = 'p1'";
    assert_eq!(
        text(&mut target, person).await,
        text(&mut source, person).await
    );
    let company = "select string_agg(row_to_json(c)::text, ',' order by id) from companies c";
    assert_eq!(
        text(&mut target, company).await,
        text(&mut source, company).await,
        "the generated column is made again, the same"
    );
    assert_eq!(
        number(&mut target, "select count(*) from audit").await,
        2,
        "the trigger stayed quiet while the rows loaded"
    );
    assert_eq!(
        text(
            &mut target,
            "select string_agg(label, ',' order by id) from counters"
        )
        .await,
        "one,two,three",
        "the seeded row is gone"
    );
    assert_eq!(
        number(
            &mut target,
            "insert into counters (label) values ('five') returning id::bigint"
        )
        .await,
        5,
        "the sequence goes on where Global's was"
    );
    assert_eq!(
        text(
            &mut target,
            "select string_agg(hash, ',') from __drizzle_migrations"
        )
        .await,
        "install",
        "the install keeps its own migration rows"
    );
    assert_eq!(
        number(
            &mut target,
            "select count(*) from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace"
        )
        .await,
        3,
        "every foreign key is back"
    );
    assert_eq!(
        number(
            &mut target,
            "select count(*) from pg_trigger where not tgisinternal and tgenabled = 'O'"
        )
        .await,
        1,
        "the trigger is on again"
    );
    run(
        &mut target,
        "insert into people (id, company_id) values ('p3', 'c2')",
    )
    .await;
    assert_eq!(
        number(&mut target, "select count(*) from audit").await,
        3,
        "and fires"
    );
    let orphan = sqlx::raw_sql("insert into people (id, company_id) values ('p4', 'nope')")
        .execute(&mut target)
        .await;
    assert!(orphan.is_err(), "and the keys hold");

    // The materialized view is refreshed after the copy, by move_tenant.
    let refreshed = crate::tenant::refresh_materialized_views(&mut target)
        .await
        .expect("refresh");
    assert_eq!(refreshed, 1);
    assert_eq!(
        number(
            &mut target,
            "select sum(people)::bigint from company_counts"
        )
        .await,
        3
    );

    let _ = source.close().await;
    let _ = target.close().await;
    server.drop_all().await;
}

#[tokio::test]
async fn a_column_the_install_lacks_stops_the_copy_before_any_write() {
    let Some(mut server) = Server::new().await else {
        return;
    };
    let mut source = server.database("src2").await;
    let mut target = server.database("dst2").await;
    run(
        &mut source,
        "create table notes (id text primary key, body text, extra text);",
    )
    .await;
    run(
        &mut target,
        "create table notes (id text primary key, body text);",
    )
    .await;
    run(
        &mut source,
        "insert into notes values ('n1', 'kept', 'lost?');",
    )
    .await;
    run(&mut target, "insert into notes values ('seed', 'stays');").await;

    let error = copy_database(&mut source, &mut target)
        .await
        .expect_err("refused");
    assert!(error.to_string().contains("notes.extra"), "{error}");
    assert_eq!(
        text(&mut target, "select string_agg(id, ',') from notes").await,
        "seed",
        "nothing written"
    );

    let _ = source.close().await;
    let _ = target.close().await;
    server.drop_all().await;
}
