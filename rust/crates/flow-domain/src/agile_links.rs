//! The epic links of tasks against the database (EU and self-hosted only,
//! ADR FLOW-023): whether a task may point at an epic, what a PATCH does to
//! a kept link, and the members a container lets go of when its type
//! changes. The rules themselves are [`crate::agile`]'s; the flow module's
//! task writes and the public API's `/v1/tasks` both apply them here.
//!
//! An item points at its epic (or feature) with `tasks.epic_id`; that is not
//! the subtask tree, so the item stays a top-level task.

use std::collections::HashMap;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::tasks::{self, Column as Task};

use crate::agile::{
    EpicTarget, FEATURE, LinkedItem, MemberClear, epic_link_error, members_to_clear,
};

/// The project, type and liveness of the task an epic id names.
async fn epic_target(
    db: &PgPool,
    epic_id: &str,
) -> Result<Option<(Option<String>, Option<String>, bool)>, DbErr> {
    let row: Option<(Option<String>, Option<String>, Option<PrimitiveDateTime>)> =
        tasks::Entity::find()
            .select_only()
            .columns([Task::ProjectId, Task::Type, Task::DeletedAt])
            .filter(Task::Id.eq(epic_id))
            .into_tuple()
            .one(&orm(db))
            .await?;
    Ok(row.map(|(project, kind, deleted)| (project, kind, deleted.is_none())))
}

/// Why `item` may not belong to `epic_id`, or `None`.
pub async fn epic_error(
    db: &PgPool,
    item: &LinkedItem<'_>,
    epic_id: &str,
) -> Result<Option<String>, DbErr> {
    let target = epic_target(db, epic_id).await?;
    let target = target.as_ref().map(|(project, kind, live)| EpicTarget {
        project_id: project.as_deref(),
        kind: kind.as_deref(),
        live: *live,
    });
    Ok(epic_link_error(item, epic_id, target.as_ref()))
}

/// A string field of a row, `None` when absent, null or empty.
fn text_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// What a PATCH does to the task's epic link.
#[derive(Debug, Default, PartialEq, Eq)]
pub enum EpicChange {
    /// Nothing beyond what the body sent.
    #[default]
    Keep,
    /// The kept link no longer holds (the task became an epic or a
    /// subtask, or a feature in a feature): it is cleared.
    Clear,
}

/// What a PATCH body sends for one of the fields the epic rules read.
pub type Sent<'a> = Field<&'a str>;

/// A body field as [`Sent`]: `Absent` when the key is left out, `Set` for a
/// non-empty string, `Null` for anything else (`null`, an empty string).
pub fn sent_text<'a>(value: Option<&'a Value>) -> Sent<'a> {
    match value {
        None => Field::Absent,
        Some(Value::String(text)) if !text.is_empty() => Field::Set(text.as_str()),
        Some(_) => Field::Null,
    }
}

/// The value a sent field leaves, `existing` when it was left out.
fn after<'a>(sent: &Sent<'a>, existing: Option<&'a str>) -> Option<&'a str> {
    match sent {
        Field::Set(value) => Some(*value),
        Field::Null => None,
        Field::Absent => existing,
    }
}

/// The epic checks of a PATCH: a link the body sets must hold (`Err` with
/// the 400's message), and a kept link the change breaks is cleared. `task`
/// is the stored row (`id`, `projectId`, `type`, `parentTaskId`, `epicId`).
/// Each `Sent` is `Absent` when the body leaves the key out, `Null` for
/// `null` or an empty string.
pub async fn patch_epic(
    db: &PgPool,
    task: &Value,
    sent_epic: &Sent<'_>,
    sent_type: &Sent<'_>,
    sent_parent: &Sent<'_>,
) -> Result<Result<EpicChange, String>, DbErr> {
    let existing = text_of(task, "epicId");
    let item = LinkedItem {
        id: text_of(task, "id"),
        project_id: text_of(task, "projectId"),
        kind: after(sent_type, text_of(task, "type")),
        parent_task_id: after(sent_parent, text_of(task, "parentTaskId")),
    };
    match sent_epic {
        Field::Set(epic) if Some(*epic) != existing => {
            return Ok(match epic_error(db, &item, epic).await? {
                Some(message) => Err(message),
                None => Ok(EpicChange::Keep),
            });
        }
        Field::Null => return Ok(Ok(EpicChange::Keep)),
        _ => {}
    }
    let Some(kept) = existing else {
        return Ok(Ok(EpicChange::Keep));
    };
    let type_changed = !sent_type.is_absent() && item.kind != text_of(task, "type");
    let parent_changed =
        !sent_parent.is_absent() && item.parent_task_id != text_of(task, "parentTaskId");
    if !type_changed && !parent_changed {
        return Ok(Ok(EpicChange::Keep));
    }
    Ok(Ok(if epic_error(db, &item, kept).await?.is_some() {
        EpicChange::Clear
    } else {
        EpicChange::Keep
    }))
}

/// The epic column a PATCH writes: `Set` to link, `Null` to unlink (an empty
/// or null `epicId`, or a kept link the change breaks), `Absent` to leave it
/// as it is.
pub fn epic_write<'a>(sent_epic: &Sent<'a>, change: &EpicChange) -> Sent<'a> {
    if sent_epic.is_absent() && *change == EpicChange::Clear {
        Field::Null
    } else {
        sent_epic.clone()
    }
}

/// Write task `id`'s epic link as [`epic_write`] decided it (no `updatedAt`:
/// the caller's write sets it). `Absent` writes nothing.
pub async fn set_epic<C: ConnectionTrait>(
    conn: &C,
    id: &str,
    epic: &Sent<'_>,
) -> Result<(), DbErr> {
    let value = match epic {
        Field::Absent => return Ok(()),
        Field::Set(epic) => Some((*epic).to_owned()),
        Field::Null => None,
    };
    tasks::Entity::update_many()
        .col_expr(Task::EpicId, Expr::value(value))
        .filter(Task::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(())
}

/// The epic each of `ids` points at, for the tasks that have one.
pub async fn epic_ids(db: &PgPool, ids: &[&str]) -> Result<HashMap<String, String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> = tasks::Entity::find()
        .select_only()
        .columns([Task::Id, Task::EpicId])
        .filter(Task::Id.is_in(ids.iter().copied()))
        .filter(Task::EpicId.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, epic)| Some((id, epic?)))
        .collect())
}

/// Unlink the members a task can no longer hold after its type went from
/// `old` to `new`.
pub async fn clear_members(
    db: &PgPool,
    id: &str,
    old: Option<&str>,
    new: Option<&str>,
) -> Result<(), DbErr> {
    let only_features = match members_to_clear(old, new) {
        MemberClear::None => return Ok(()),
        MemberClear::All => false,
        MemberClear::FeaturesOnly => true,
    };
    let mut update = tasks::Entity::update_many()
        .col_expr(Task::EpicId, Expr::value(Option::<String>::None))
        .col_expr(Task::UpdatedAt, Expr::value(utc_now()))
        .filter(Task::EpicId.eq(id))
        .filter(Task::DeletedAt.is_null());
    if only_features {
        update = update.filter(Task::Type.eq(FEATURE));
    }
    update.exec(&orm(db)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_body_field_is_absent_set_or_null() {
        let body = json!({ "a": "epic_1", "b": "", "c": null, "d": 3 });
        assert_eq!(sent_text(body.get("a")), Field::Set("epic_1"));
        assert_eq!(sent_text(body.get("b")), Field::Null);
        assert_eq!(sent_text(body.get("c")), Field::Null);
        assert_eq!(sent_text(body.get("d")), Field::Null);
        assert_eq!(sent_text(body.get("missing")), Field::Absent);
    }

    #[test]
    fn a_patch_writes_the_epic_it_sends_or_clears_a_broken_link() {
        let keep = EpicChange::Keep;
        let clear = EpicChange::Clear;
        assert_eq!(
            epic_write(&Field::Set("epic_1"), &keep),
            Field::Set("epic_1")
        );
        assert_eq!(
            epic_write(&Field::Set("epic_1"), &clear),
            Field::Set("epic_1")
        );
        assert_eq!(epic_write(&Field::Null, &keep), Field::Null);
        assert_eq!(epic_write(&Field::Absent, &keep), Field::Absent);
        assert_eq!(epic_write(&Field::Absent, &clear), Field::Null);
    }
}
