//! Epics and features (EU and self-hosted only, ADR FLOW-023): `GET
//! /api/tasks/epics`. An item points at its epic (or feature) with
//! `tasks.epic_id`; that is not the subtask tree, so the item stays a
//! top-level task. The rules are [`weldsuite_flow_domain::agile`]'s, and the
//! checks the task writes apply are [`weldsuite_flow_domain::agile_links`]'s,
//! which the public API's `/v1/tasks` shares.

use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::orm;
use weldsuite_flow_domain::agile::{EPIC, EpicMember, FEATURE, epic_rollups};
use weldsuite_kit::Data;
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
