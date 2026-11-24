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

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ConnectionTrait, DbErr, EntityTrait};
use weldsuite_db::utc_now;
use weldsuite_schema::tenant::task_number_sequences as sequences;

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
pub async fn allocate_numbers(
    db: &impl ConnectionTrait,
    sequence: &NumberSequence,
    count: i64,
) -> Result<Vec<i64>, DbErr> {
    if count <= 0 {
        return Ok(Vec::new());
    }
    let step = i32::try_from(count).unwrap_or(i32::MAX);
    // `insert … on conflict (scope) do update set next_value = next_value + step
    // returning next_value`: one statement, so two callers never get the same numbers.
    let bumped = sequences::Entity::insert(sequences::ActiveModel {
        id: Set(weldsuite_kit::generate_id("seq")),
        scope: Set(sequence.scope.clone().into_owned()),
        prefix: Set(sequence.prefix.to_owned()),
        next_value: Set(step.saturating_add(1)),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::column(sequences::Column::Scope)
            .value(
                sequences::Column::NextValue,
                sea_orm::ExprTrait::add(
                    Expr::col((sequences::Entity, sequences::Column::NextValue)),
                    step,
                ),
            )
            .value(sequences::Column::UpdatedAt, utc_now())
            .to_owned(),
    )
    .exec_with_returning(db)
    .await?;
    let end = i64::from(bumped.next_value) - 1;
    let start = end - count + 1;
    Ok((0..count).map(|i| start + i).collect())
}

/// `allocateNumber(db, sequence)`: one number from the sequence.
pub async fn allocate_number(
    db: &impl ConnectionTrait,
    sequence: &NumberSequence,
) -> Result<i64, DbErr> {
    let numbers = allocate_numbers(db, sequence, 1).await?;
    numbers.first().copied().ok_or_else(|| {
        DbErr::Custom(format!(
            "Failed to allocate a number for scope {}",
            sequence.scope
        ))
    })
}

/// `allocateTaskNumbers(db, count)`: `count` consecutive task numbers, ascending.
pub async fn allocate_task_numbers(
    db: &impl ConnectionTrait,
    count: i64,
) -> Result<Vec<i64>, DbErr> {
    allocate_numbers(db, &TASK_SEQUENCE, count).await
}

/// `allocateTaskNumber(db)`.
pub async fn allocate_task_number(db: &impl ConnectionTrait) -> Result<i64, DbErr> {
    let numbers = allocate_task_numbers(db, 1).await?;
    numbers
        .first()
        .copied()
        .ok_or_else(|| DbErr::Custom("Failed to allocate a task number".to_owned()))
}
