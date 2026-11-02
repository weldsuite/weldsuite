//! Workspace-wide sequential task numbers (`@weldsuite/flow-domain/task-numbering`).
//!
//! Allocation is race-free: one upsert bumps `next_value` atomically and
//! `returning` hands back the post-increment value.

use sqlx::PgExecutor;
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;

/// `allocateTaskNumbers(db, count)`: `count` consecutive numbers, ascending.
pub async fn allocate_task_numbers<'e>(
    db: impl PgExecutor<'e>,
    count: i64,
) -> Result<Vec<i64>, sqlx::Error> {
    if count <= 0 {
        return Ok(Vec::new());
    }
    let next: i32 = sqlx::query_scalar(
        "insert into task_number_sequences (id, scope, prefix, next_value)
         values ($1, 'task', 'TASK-', $2 + 1)
         on conflict (scope) do update set
             next_value = task_number_sequences.next_value + $2,
             updated_at = $3::timestamp
         returning next_value",
    )
    .bind(weldsuite_kit::generate_id("seq"))
    .bind(i32::try_from(count).unwrap_or(i32::MAX))
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .fetch_one(db)
    .await?;
    let end = i64::from(next) - 1;
    let start = end - count + 1;
    Ok((0..count).map(|i| start + i).collect())
}

/// `allocateTaskNumber(db)`.
pub async fn allocate_task_number<'e>(db: impl PgExecutor<'e>) -> Result<i64, sqlx::Error> {
    let numbers = allocate_task_numbers(db, 1).await?;
    numbers
        .first()
        .copied()
        .ok_or_else(|| sqlx::Error::Protocol("Failed to allocate a task number".to_owned()))
}
