//! `atomically` (`worker-kit/src/atomically.ts`): commit related writes as one
//! unit.
//!
//! In TypeScript the tenant database is neon-http, which has no interactive
//! transactions, so `atomically` takes a list of statements built up front
//! and sends them as one `db.batch()`: Neon runs them in order in a single
//! transaction, in one HTTP request. [`atomically`] keeps that shape: the
//! statements are built before anything runs, and they run in order in one
//! transaction that commits only if every one succeeds.
//!
//! The differences on a TCP connection: each statement is its own round trip
//! inside `BEGIN … COMMIT` on one pooled connection (the batch was one
//! request), and a failed statement rolls back explicitly before the error is
//! returned. The isolation level is Postgres's default, READ COMMITTED, as in
//! a Neon batch. Over TCP a transaction can also be interactive, reading
//! between writes; [`atomically_with`] is that form, which TypeScript cannot
//! offer.

use std::pin::Pin;

use sqlx::postgres::{PgArguments, PgConnection, PgQueryResult};
use sqlx::query::Query;
use sqlx::{Acquire, Postgres};

/// What [`atomically_with`]'s closure returns: the work, borrowing the
/// transaction's connection.
pub type TransactionFuture<'c, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'c>>;

/// Run `statements` in order in one transaction: all of them commit, or none
/// does. Returns each statement's result in order. `db` is a `&PgPool`, a
/// connection, or a transaction (the statements then run in a savepoint).
pub async fn atomically<'a, 'q, A>(
    db: A,
    statements: impl IntoIterator<Item = Query<'q, Postgres, PgArguments>>,
) -> Result<Vec<PgQueryResult>, sqlx::Error>
where
    A: Acquire<'a, Database = Postgres>,
{
    let mut tx = db.begin().await?;
    let mut results = Vec::new();
    for statement in statements {
        match statement.execute(&mut *tx).await {
            Ok(result) => results.push(result),
            Err(error) => {
                rollback(tx).await;
                return Err(error);
            }
        }
    }
    tx.commit().await?;
    Ok(results)
}

/// Run `work` in one transaction: commit when it returns `Ok`, roll back
/// when it returns `Err` (the error is passed on unchanged).
///
/// ```ignore
/// atomically_with(&pool, |conn| Box::pin(async move {
///     let parent: (String,) = sqlx::query_as("select id from parents where id = $1")
///         .bind(id).fetch_one(&mut *conn).await?;
///     sqlx::query("insert into children (parent_id) values ($1)")
///         .bind(parent.0).execute(&mut *conn).await?;
///     Ok::<_, sqlx::Error>(())
/// })).await?;
/// ```
pub async fn atomically_with<'a, A, T, E, F>(db: A, work: F) -> Result<T, E>
where
    A: Acquire<'a, Database = Postgres>,
    E: From<sqlx::Error>,
    F: for<'c> FnOnce(&'c mut PgConnection) -> TransactionFuture<'c, T, E>,
{
    let mut tx = db.begin().await?;
    match work(&mut tx).await {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            rollback(tx).await;
            Err(error)
        }
    }
}

/// Roll back, keeping the error that caused it. A failed rollback leaves
/// nothing committed either: a transaction that never reaches COMMIT is
/// discarded with its connection.
async fn rollback(tx: sqlx::Transaction<'_, Postgres>) {
    if let Err(error) = tx.rollback().await {
        tracing::warn!(%error, "atomically: rollback failed");
    }
}
