//! Spikes S5 and S7 of the ORM plan against the real tenant schema
//! (`rust/docs/spikes.md`): SeaORM statements share a transaction with sqlx
//! ones, and an entity serializes to the JSON `js_row` gives the same row.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` points at a database built by
//! `pnpm exec tsx scripts/rust-test-db.ts`; skipped otherwise.

#![allow(clippy::unwrap_used)]

use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_db::{OrmConn, atomically_with, js_row, orm};
use weldsuite_schema::tenant::people;

async fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(PgPool::connect(&url).await.expect("tenant database"))
}

fn person(id: &str) -> people::ActiveModel {
    people::ActiveModel {
        id: Set(id.to_owned()),
        display_name: Set(format!("Spike {id}")),
        ..Default::default()
    }
}

async fn exists(pool: &PgPool, id: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM people WHERE id = $1)")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// The variants' errors are only read through `Debug`, in assertion messages.
#[allow(dead_code)]
#[derive(Debug)]
enum Failure {
    Sql(sqlx::Error),
    Orm(sea_orm::DbErr),
    Abort,
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<sea_orm::DbErr> for Failure {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Orm(error)
    }
}

/// S5: an ORM insert inside `atomically_with` rolls back with the SQL insert
/// before it, and commits with it.
#[tokio::test]
async fn orm_statements_join_the_sqlx_transaction() {
    let Some(pool) = tenant().await else { return };
    sqlx::query("DELETE FROM people WHERE id LIKE 'spike_s5_%'")
        .execute(&pool)
        .await
        .unwrap();

    // Rolled back: neither the SQL row nor the ORM row is left.
    let result = atomically_with(&pool, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO people (id, display_name) VALUES ('spike_s5_sql_1', 'SQL')")
                .execute(&mut *tx)
                .await?;
            let orm_tx = OrmConn::new(tx);
            person("spike_s5_orm_1").insert(&orm_tx).await?;
            // The ORM sees the SQL row in the same transaction.
            let seen = people::Entity::find_by_id("spike_s5_sql_1".to_owned())
                .one(&orm_tx)
                .await?;
            assert!(seen.is_some(), "the ORM reads the transaction's own write");
            Err::<(), _>(Failure::Abort)
        })
    })
    .await;
    assert!(matches!(result, Err(Failure::Abort)));
    assert!(!exists(&pool, "spike_s5_sql_1").await);
    assert!(!exists(&pool, "spike_s5_orm_1").await);

    // Committed: both rows are there, and SQL after the ORM still runs on the connection.
    atomically_with(&pool, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO people (id, display_name) VALUES ('spike_s5_sql_2', 'SQL')")
                .execute(&mut *tx)
                .await?;
            {
                let orm_tx = OrmConn::new(&mut *tx);
                person("spike_s5_orm_2").insert(&orm_tx).await?;
            }
            sqlx::query("UPDATE people SET title = 'after' WHERE id = 'spike_s5_orm_2'")
                .execute(&mut *tx)
                .await?;
            Ok::<_, Failure>(())
        })
    })
    .await
    .unwrap();
    assert!(exists(&pool, "spike_s5_sql_2").await);
    let orm_row = people::Entity::find_by_id("spike_s5_orm_2".to_owned())
        .one(&orm(&pool))
        .await
        .unwrap()
        .expect("committed");
    assert_eq!(orm_row.title.as_deref(), Some("after"));

    // A failing ORM statement rolls the SQL one back too.
    let result = atomically_with(&pool, |tx| {
        Box::pin(async move {
            sqlx::query("INSERT INTO people (id, display_name) VALUES ('spike_s5_sql_3', 'SQL')")
                .execute(&mut *tx)
                .await?;
            let orm_tx = OrmConn::new(tx);
            // Duplicate primary key.
            person("spike_s5_orm_2").insert(&orm_tx).await?;
            Ok::<_, Failure>(())
        })
    })
    .await;
    assert!(matches!(result, Err(Failure::Orm(_))), "{result:?}");
    assert!(!exists(&pool, "spike_s5_sql_3").await);
}

/// S7 (part): the entity's JSON is the `js_row` JSON of the same row.
#[tokio::test]
async fn an_entity_serializes_like_js_row() {
    let Some(pool) = tenant().await else { return };
    sqlx::query("DELETE FROM people WHERE id = 'spike_s7_1'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO people (id, display_name, first_name, alternate_emails, date_of_birth, created_at)
         VALUES ('spike_s7_1', 'Ada', 'Ada', '[\"a@example.com\"]', '1990-02-03', '2026-10-29 07:00:00.123456')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let from_sql: Value =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM people p WHERE id = 'spike_s7_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let from_sql = js_row(from_sql);
    let from_orm = serde_json::to_value(
        people::Entity::find_by_id("spike_s7_1".to_owned())
            .one(&orm(&pool))
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();

    let (Value::Object(sql), Value::Object(entity)) = (&from_sql, &from_orm) else {
        panic!("rows are objects");
    };
    let mut differences = Vec::new();
    for (key, value) in sql {
        if entity.get(key) != Some(value) {
            differences.push(format!(
                "{key}: js_row {value} / entity {:?}",
                entity.get(key)
            ));
        }
    }
    for key in entity.keys() {
        if !sql.contains_key(key) {
            differences.push(format!("{key}: only in the entity"));
        }
    }
    assert!(differences.is_empty(), "{differences:#?}");
}
