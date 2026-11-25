//! Epics and features (EU and self-hosted only, ADR FLOW-023): `GET
//! /api/tasks/epics`, and the epic rules the task writes apply. An item
//! points at its epic (or feature) with `tasks.epic_id`; that is not the
//! subtask tree, so the item stays a top-level task. The rules themselves
//! are [`weldsuite_flow_domain::agile`]'s.

use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_flow_domain::agile::{
    EPIC, EpicMember, EpicTarget, FEATURE, LinkedItem, MemberClear, epic_link_error, epic_rollups,
    members_to_clear,
};
use weldsuite_kit::Data;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::tasks::{self, Column as Task};

use crate::tasks::PROJECT_MEMBER_DENIED;
use crate::{Caller, Query, Refusal, Reply, reply, row_json};

const PROJECT_REQUIRED: &str = "projectId is required";

/// A member as the roll-up reads it: `(epicId, type, status, storyPoints)`.
type MemberRow = (Option<String>, Option<String>, String, Option<i32>);

// ── GET /epics ──────────────────────────────────────────────────────────────

pub(crate) async fn epics(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_epics(&caller, q.present("projectId")).await,
        "Failed to list epics",
    )
}

/// The project's live epics and features, by position, each with the
/// roll-up of its items.
async fn list_epics(caller: &Caller, project_id: Option<&str>) -> Reply {
    let Some(project_id) = project_id else {
        return Err(Refusal::bad_request(PROJECT_REQUIRED));
    };
    if !caller.can_access(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_MEMBER_DENIED));
    }
    let db = &orm(&caller.db);
    let containers = tasks::Entity::find()
        .filter(Task::ProjectId.eq(project_id))
        .filter(Task::DeletedAt.is_null())
        .filter(Task::Type.is_in([EPIC, FEATURE]))
        .order_by_asc(Task::Position)
        .order_by_asc(Task::CreatedAt)
        .order_by_asc(Task::Id)
        .all(db)
        .await?;
    let members: Vec<MemberRow> = if containers.is_empty() {
        Vec::new()
    } else {
        tasks::Entity::find()
            .select_only()
            .columns([Task::EpicId, Task::Type, Task::Status, Task::StoryPoints])
            .filter(Task::EpicId.is_in(containers.iter().map(|c| c.id.as_str())))
            .filter(Task::DeletedAt.is_null())
            .filter(Task::Status.ne("cancelled"))
            .into_tuple()
            .all(db)
            .await?
    };
    let members: Vec<EpicMember> = members
        .into_iter()
        .filter_map(|(epic, kind, status, points)| {
            Some(EpicMember {
                epic_id: epic?,
                kind,
                status,
                points: i64::from(points.unwrap_or(0)),
            })
        })
        .collect();
    let shape: Vec<(String, Option<String>, Option<String>)> = containers
        .iter()
        .map(|c| (c.id.clone(), c.type_.clone(), c.epic_id.clone()))
        .collect();
    let rollups = epic_rollups(&shape, &members);
    let mut rows = Vec::with_capacity(containers.len());
    for container in containers {
        let rollup = rollups.get(&container.id).copied().unwrap_or_default();
        let epic_id = if container.type_.as_deref() == Some(EPIC) {
            None
        } else {
            container.epic_id.clone()
        };
        let row = row_json(container)?;
        let at = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        rows.push(json!({
            "id": at("id"),
            "number": at("number"),
            "title": at("title"),
            "type": at("type"),
            "status": at("status"),
            "priority": at("priority"),
            "epicId": epic_id,
            "position": at("position"),
            "assigneeId": at("assigneeId"),
            "dueDate": at("dueDate"),
            "items": rollup.items,
            "done": rollup.done,
            "points": rollup.points,
            "donePoints": rollup.done_points,
        }));
    }
    Ok(Data(Value::Array(rows)).into_response())
}

// ── The rules on writes ─────────────────────────────────────────────────────

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
pub(crate) async fn epic_error(
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
pub(crate) enum EpicChange {
    /// Nothing beyond what the body sent.
    #[default]
    Keep,
    /// The kept link no longer holds (the task became an epic or a
    /// subtask, or a feature in a feature): it is cleared.
    Clear,
}

/// What a PATCH body sends for one of the fields the epic rules read.
pub(crate) type Sent<'a> = Field<&'a str>;

/// The value a sent field leaves, `existing` when it was left out.
fn after<'a>(sent: &Sent<'a>, existing: Option<&'a str>) -> Option<&'a str> {
    match sent {
        Field::Set(value) => Some(*value),
        Field::Null => None,
        Field::Absent => existing,
    }
}

/// The epic checks of a PATCH: a link the body sets must hold (`Err` with
/// the 400's message), and a kept link the change breaks is cleared. Each
/// `Sent` is `Absent` when the body leaves the key out, `Null` for `null`
/// or an empty string.
pub(crate) async fn patch_epic(
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

/// Unlink the members a task can no longer hold after its type went from
/// `old` to `new`.
pub(crate) async fn clear_members(
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
