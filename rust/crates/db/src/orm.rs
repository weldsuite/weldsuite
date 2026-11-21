//! SeaORM on the pools and connections this crate already hands out, so ORM
//! code and SQL code share connections, PgBouncer settings and transactions
//! while the queries are converted (weldsuite-documentation
//! `plans/rust-schema-orm-and-migrations.md`).
//!
//! - [`orm`]: a pool (master, or a workspace's tenant pool) as a SeaORM
//!   [`DatabaseConnection`]. No new pool: the same connections.
//! - [`OrmConn`]: one sqlx connection as a SeaORM connection. Inside
//!   [`crate::atomically_with`] that connection is the transaction, so ORM
//!   statements commit or roll back with the SQL ones around them.
//!
//! SeaORM can't adopt a transaction sqlx opened (its `DatabaseTransaction`
//! only begins its own, from a pool), and it doesn't hand out the sqlx
//! connection of one it opened. So transactions keep starting here, with
//! `atomically_with`, and ORM code joins them through [`OrmConn`].

use std::sync::Arc;

use sea_orm::sea_query::Values;
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, DbErr, ExecResult, QueryResult, RuntimeErr,
    SqlxPostgresConnector, Statement,
};
use sea_query_sqlx::SqlxValues;
use sqlx::postgres::PgConnection;
use sqlx::{PgPool, Postgres};
use tokio::sync::Mutex;

/// `pool` as a SeaORM connection: queries borrow its connections as sqlx
/// queries do.
pub fn orm(pool: &PgPool) -> DatabaseConnection {
    SqlxPostgresConnector::from_sqlx_postgres_pool(pool.clone())
}

/// One sqlx connection, usually the transaction `atomically_with` hands its
/// closure, as a SeaORM connection:
///
/// ```ignore
/// atomically_with(&tenant.pool, |tx| Box::pin(async move {
///     sqlx::query("UPDATE … ").execute(&mut *tx).await?;
///     let orm = OrmConn::new(tx);
///     people::Entity::insert(person).exec(&orm).await?;
///     Ok(())
/// })).await
/// ```
///
/// Statements run one at a time, in the order they are awaited.
pub struct OrmConn<'c> {
    conn: Mutex<&'c mut PgConnection>,
}

impl<'c> OrmConn<'c> {
    pub fn new(conn: &'c mut PgConnection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }
}

fn query(stmt: &Statement) -> sqlx::query::Query<'_, Postgres, SqlxValues> {
    let values = stmt.values.clone().unwrap_or(Values(Vec::new()));
    sqlx::query_with(sqlx::AssertSqlSafe(stmt.sql.as_str()), SqlxValues(values))
}

fn exec_err(error: sqlx::Error) -> DbErr {
    DbErr::Exec(RuntimeErr::SqlxError(Arc::new(error)))
}

fn query_err(error: sqlx::Error) -> DbErr {
    DbErr::Query(RuntimeErr::SqlxError(Arc::new(error)))
}

#[async_trait::async_trait]
impl ConnectionTrait for OrmConn<'_> {
    fn get_database_backend(&self) -> DbBackend {
        DbBackend::Postgres
    }

    async fn execute_raw(&self, stmt: Statement) -> Result<ExecResult, DbErr> {
        let mut conn = self.conn.lock().await;
        let done = query(&stmt).execute(&mut **conn).await.map_err(exec_err)?;
        Ok(done.into())
    }

    async fn execute_unprepared(&self, sql: &str) -> Result<ExecResult, DbErr> {
        let mut conn = self.conn.lock().await;
        let done = sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&mut **conn)
            .await
            .map_err(exec_err)?;
        Ok(done.into())
    }

    async fn query_one_raw(&self, stmt: Statement) -> Result<Option<QueryResult>, DbErr> {
        let mut conn = self.conn.lock().await;
        let row = query(&stmt)
            .fetch_optional(&mut **conn)
            .await
            .map_err(query_err)?;
        Ok(row.map(Into::into))
    }

    async fn query_all_raw(&self, stmt: Statement) -> Result<Vec<QueryResult>, DbErr> {
        let mut conn = self.conn.lock().await;
        let rows = query(&stmt)
            .fetch_all(&mut **conn)
            .await
            .map_err(query_err)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }
}
