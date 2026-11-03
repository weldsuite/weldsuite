//! Sequential numbers (`@weldsuite/flow-domain/task-numbering`), allocated
//! from `task_number_sequences` and shown as plain numbers (1042) or with a
//! prefix (RSK-4).
//!
//! Tasks share one workspace-wide sequence (scope `task`). Other objects use
//! a scope of their own: the RAID register numbers per project and kind
//! (`rsk:<projectId>`, see [`crate::raid`]). Every scope is its own row, so
//! one counter never touches another.
//!
//! Allocation is race-free: one upsert bumps `next_value` atomically and
//! `returning` hands back the post-increment value.

use std::borrow::Cow;

use sqlx::PgExecutor;
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;

/// One counter (`NumberSequence`): its scope key (unique per row) and the
/// prefix of the display code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumberSequence {
    pub scope: Cow<'static, str>,
    pub prefix: &'static str,
}

/// `TASK_SEQUENCE`: the workspace-wide task sequence.
pub const TASK_SEQUENCE: NumberSequence = NumberSequence {
    scope: Cow::Borrowed("task"),
    prefix: "TASK-",
};

/// `allocateNumbers(db, sequence, count)`: `count` consecutive numbers from
/// the sequence, ascending, in one atomic bump. The sequence row is created
/// on first use, with the prefix given then.
pub async fn allocate_numbers<'e>(
    db: impl PgExecutor<'e>,
    sequence: &NumberSequence,
    count: i64,
) -> Result<Vec<i64>, sqlx::Error> {
    if count <= 0 {
        return Ok(Vec::new());
    }
    let next: i32 = sqlx::query_scalar(
        "insert into task_number_sequences (id, scope, prefix, next_value)
         values ($1, $4, $5, $2 + 1)
         on conflict (scope) do update set
             next_value = task_number_sequences.next_value + $2,
             updated_at = $3::timestamp
         returning next_value",
    )
    .bind(weldsuite_kit::generate_id("seq"))
    .bind(i32::try_from(count).unwrap_or(i32::MAX))
    .bind(iso_timestamp(OffsetDateTime::now_utc()))
    .bind(sequence.scope.as_ref())
    .bind(sequence.prefix)
    .fetch_one(db)
    .await?;
    let end = i64::from(next) - 1;
    let start = end - count + 1;
    Ok((0..count).map(|i| start + i).collect())
}

/// `allocateNumber(db, sequence)`: one number from the sequence.
pub async fn allocate_number<'e>(
    db: impl PgExecutor<'e>,
    sequence: &NumberSequence,
) -> Result<i64, sqlx::Error> {
    let numbers = allocate_numbers(db, sequence, 1).await?;
    numbers.first().copied().ok_or_else(|| {
        sqlx::Error::Protocol(format!(
            "Failed to allocate a number for scope {}",
            sequence.scope
        ))
    })
}

/// `allocateTaskNumbers(db, count)`: `count` consecutive task numbers, ascending.
pub async fn allocate_task_numbers<'e>(
    db: impl PgExecutor<'e>,
    count: i64,
) -> Result<Vec<i64>, sqlx::Error> {
    allocate_numbers(db, &TASK_SEQUENCE, count).await
}

/// `allocateTaskNumber(db)`.
pub async fn allocate_task_number<'e>(db: impl PgExecutor<'e>) -> Result<i64, sqlx::Error> {
    let numbers = allocate_task_numbers(db, 1).await?;
    numbers
        .first()
        .copied()
        .ok_or_else(|| sqlx::Error::Protocol("Failed to allocate a task number".to_owned()))
}
