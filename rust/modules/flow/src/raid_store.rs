//! RAID log queries shared by `/api/project-raid` and
//! `/api/project-control-links` (`services/project-raid.ts`): task progress,
//! the objects at the ends of a link, and the links as one object sees them.
//! The rules are `weldsuite_flow_domain::raid` and `::risk`.

use std::collections::HashMap;

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_flow_domain::benefits::benefit_code;
use weldsuite_flow_domain::decisions::decision_code;
use weldsuite_flow_domain::deliverables::deliverable_code;
use weldsuite_flow_domain::js::millis_of;
use weldsuite_flow_domain::raid::{
    LinkEnd, PROGRESS_RELATIONS, RaidKind, present_control_link, raid_code,
};
use weldsuite_schema::tenant::{
    milestones, project_benefits, project_change_requests, project_control_links as links,
    project_decisions, project_deliverables, project_raid_items, projects, tasks,
};

use crate::Caller;

/// A row as the route returns it: the entity serializes as Drizzle returned
/// the row.
pub(crate) fn model_json<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `liveProjectExists(db, projectId)`.
pub(crate) async fn live_project_exists(db: &PgPool, project_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `findRaidItem(db, id)`: a live register item, as Drizzle reads it.
pub(crate) async fn find_raid_item(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = project_raid_items::Entity::find()
        .filter(project_raid_items::Column::Id.eq(id))
        .filter(project_raid_items::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    row.map(model_json).transpose()
}

/// `taskProgressFor(db, itemIds)`: per item, the live, non-cancelled tasks
/// linked to it with `mitigates` or `resolves`, as `(done, total)`. An item
/// with none is absent (read it with [`progress_of`]).
pub(crate) async fn task_progress_for(
    db: &PgPool,
    item_ids: &[String],
) -> Result<HashMap<String, (i64, i64)>, DbErr> {
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // `count(*) filter (where t.status = 'done')`: the rows the case keeps.
    let done = Func::count(Expr::case(tasks::Column::Status.eq("done"), 1));
    let rows: Vec<(String, i64, i64)> = links::Entity::find()
        .select_only()
        .column(links::Column::ToId)
        .column_as(Func::count(Expr::col(Asterisk)), "total")
        .column_as(done, "done")
        .join(
            JoinType::InnerJoin,
            links::Entity::belongs_to(tasks::Entity)
                .from(links::Column::FromId)
                .to(tasks::Column::Id)
                .into(),
        )
        .filter(links::Column::ToType.eq("raid_item"))
        .filter(links::Column::ToId.is_in(item_ids))
        .filter(links::Column::FromType.eq("task"))
        .filter(links::Column::Relation.is_in(PROGRESS_RELATIONS))
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(tasks::Column::Status.ne("cancelled"))
        .group_by(links::Column::ToId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, total, done)| (id, (done, total)))
        .collect())
}

/// `progress.get(id) ?? { done: 0, total: 0 }`.
pub(crate) fn progress_of(progress: &HashMap<String, (i64, i64)>, id: &str) -> (i64, i64) {
    progress.get(id).copied().unwrap_or((0, 0))
}

/// The object at one end of a link, as far as the UI shows it (`ResolvedEnd`).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedEnd {
    pub(crate) link_type: &'static str,
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) kind: Option<RaidKind>,
    title: String,
    status: String,
    code: Option<String>,
    owner_id: Option<String>,
    due_date: Option<String>,
}

impl ResolvedEnd {
    /// The end as the link rules see it.
    pub(crate) fn as_link_end(&self) -> LinkEnd<'_> {
        LinkEnd {
            link_type: self.link_type,
            id: &self.id,
            project_id: &self.project_id,
            kind: self.kind,
        }
    }

    /// `presentTarget(end)`.
    fn target(&self) -> Value {
        json!({
            "type": self.link_type,
            "id": self.id,
            "projectId": self.project_id,
            "title": self.title,
            "status": self.status,
            "code": self.code,
            "ownerId": self.owner_id,
            "dueDate": self.due_date,
        })
    }
}

/// One end as each table answers it: id, project, kind and number (register
/// items only), title, status, owner, due date as `toISOString()`.
struct EndRow {
    id: String,
    project_id: Option<String>,
    kind: Option<String>,
    number: Option<i32>,
    title: String,
    status: String,
    owner_id: Option<String>,
    due: Option<String>,
}

/// A `timestamptz` as Drizzle's `Date` prints it.
fn iso_tz(at: OffsetDateTime) -> String {
    iso_timestamp(at)
}

/// A `timestamp` (UTC) as Drizzle's `Date` prints it.
fn iso_ts(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// The live rows of one table by id, each as an [`EndRow`].
#[allow(clippy::too_many_lines)] // one select per table
async fn end_rows(db: &PgPool, link_type: &str, ids: &[String]) -> Result<Vec<EndRow>, DbErr> {
    let db = &orm(db);
    Ok(match link_type {
        "raid_item" => {
            use project_raid_items::{Column, Entity};
            let rows: Vec<(
                String,
                String,
                String,
                i32,
                String,
                String,
                Option<String>,
                Option<OffsetDateTime>,
            )> = Entity::find()
                .select_only()
                .columns([
                    Column::Id,
                    Column::ProjectId,
                    Column::Kind,
                    Column::Number,
                    Column::Title,
                    Column::Status,
                    Column::OwnerId,
                    Column::DueAt,
                ])
                .filter(Column::Id.is_in(ids))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .all(db)
                .await?;
            rows.into_iter()
                .map(
                    |(id, project_id, kind, number, title, status, owner_id, due)| EndRow {
                        id,
                        project_id: Some(project_id),
                        kind: Some(kind),
                        number: Some(number),
                        title,
                        status,
                        owner_id,
                        due: due.map(iso_tz),
                    },
                )
                .collect()
        }
        "task" => {
            use tasks::{Column, Entity};
            let rows: Vec<(
                String,
                Option<String>,
                String,
                String,
                Option<String>,
                Option<PrimitiveDateTime>,
            )> = Entity::find()
                .select_only()
                .columns([
                    Column::Id,
                    Column::ProjectId,
                    Column::Title,
                    Column::Status,
                    Column::AssigneeId,
                    Column::DueDate,
                ])
                .filter(Column::Id.is_in(ids))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .all(db)
                .await?;
            rows.into_iter()
                .map(|(id, project_id, title, status, owner_id, due)| EndRow {
                    id,
                    project_id,
                    kind: None,
                    number: None,
                    title,
                    status,
                    owner_id,
                    due: due.map(iso_ts),
                })
                .collect()
        }
        "decision" => {
            use project_decisions::{Column, Entity};
            let rows: Vec<(
                String,
                String,
                i32,
                String,
                String,
                Option<String>,
                Option<String>,
                Option<OffsetDateTime>,
            )> = Entity::find()
                .select_only()
                .columns([
                    Column::Id,
                    Column::ProjectId,
                    Column::Number,
                    Column::Title,
                    Column::Status,
                    Column::DeciderId,
                    Column::DecidedBy,
                    Column::DecisionDueAt,
                ])
                .filter(Column::Id.is_in(ids))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .all(db)
                .await?;
            rows.into_iter()
                .map(
                    |(id, project_id, number, title, status, decider, decided_by, due)| EndRow {
                        id,
                        project_id: Some(project_id),
                        kind: None,
                        number: Some(number),
                        title,
                        status,
                        // `coalesce(decider_id, decided_by)`.
                        owner_id: decider.or(decided_by),
                        due: due.map(iso_tz),
                    },
                )
                .collect()
        }
        "change_request" => {
            use project_change_requests::{Column, Entity};
            let rows: Vec<(String, String, i32, String, String, Option<String>)> =
                Entity::find()
                    .select_only()
                    .columns([
                        Column::Id,
                        Column::ProjectId,
                        Column::Number,
                        Column::Title,
                        Column::Status,
                        Column::RequestedBy,
                    ])
                    .filter(Column::Id.is_in(ids))
                    .filter(Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(db)
                    .await?;
            rows.into_iter()
                .map(|(id, project_id, number, title, status, owner_id)| EndRow {
                    id,
                    project_id: Some(project_id),
                    kind: None,
                    number: Some(number),
                    title,
                    status,
                    owner_id,
                    due: None,
                })
                .collect()
        }
        "deliverable" => {
            use project_deliverables::{Column, Entity};
            numbered_ends(
                Entity::find()
                    .select_only()
                    .columns([
                        Column::Id,
                        Column::ProjectId,
                        Column::Number,
                        Column::Title,
                        Column::Status,
                        Column::OwnerId,
                        Column::PlannedEnd,
                    ])
                    .filter(Column::Id.is_in(ids))
                    .filter(Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(db)
                    .await?,
            )
        }
        "benefit" => {
            use project_benefits::{Column, Entity};
            numbered_ends(
                Entity::find()
                    .select_only()
                    .columns([
                        Column::Id,
                        Column::ProjectId,
                        Column::Number,
                        Column::Title,
                        Column::Status,
                        Column::OwnerId,
                        Column::RealiseBy,
                    ])
                    .filter(Column::Id.is_in(ids))
                    .filter(Column::DeletedAt.is_null())
                    .into_tuple()
                    .all(db)
                    .await?,
            )
        }
        _ => {
            use milestones::{Column, Entity};
            let rows: Vec<(
                String,
                String,
                String,
                String,
                Option<String>,
                PrimitiveDateTime,
            )> = Entity::find()
                .select_only()
                .columns([
                    Column::Id,
                    Column::ProjectId,
                    Column::Name,
                    Column::Status,
                    Column::OwnerId,
                    Column::DueDate,
                ])
                .filter(Column::Id.is_in(ids))
                .filter(Column::DeletedAt.is_null())
                .into_tuple()
                .all(db)
                .await?;
            rows.into_iter()
                .map(|(id, project_id, title, status, owner_id, due)| EndRow {
                    id,
                    project_id: Some(project_id),
                    kind: None,
                    number: None,
                    title,
                    status,
                    owner_id,
                    due: Some(iso_ts(due)),
                })
                .collect()
        }
    })
}

/// Deliverables and benefits: id, project, number, title, status, owner and
/// a `timestamptz` due date.
fn numbered_ends(
    rows: Vec<(
        String,
        String,
        i32,
        String,
        String,
        Option<String>,
        Option<OffsetDateTime>,
    )>,
) -> Vec<EndRow> {
    rows.into_iter()
        .map(
            |(id, project_id, number, title, status, owner_id, due)| EndRow {
                id,
                project_id: Some(project_id),
                kind: None,
                number: Some(number),
                title,
                status,
                owner_id,
                due: due.map(iso_tz),
            },
        )
        .collect()
}

/// `resolveEnds(db, type, ids)`: live objects of one type by id. A task
/// without a project cannot be part of project control, so it is treated
/// like a missing one.
async fn resolve_ends(
    db: &PgPool,
    link_type: &str,
    ids: &[String],
) -> Result<HashMap<String, ResolvedEnd>, DbErr> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let link_type = match link_type {
        "raid_item" => "raid_item",
        "task" => "task",
        "decision" => "decision",
        "change_request" => "change_request",
        "deliverable" => "deliverable",
        "benefit" => "benefit",
        _ => "milestone",
    };
    for row in end_rows(db, link_type, ids).await? {
        let Some(project_id) = row
            .project_id
            .filter(|p| link_type != "task" || !p.is_empty())
        else {
            continue;
        };
        let kind = row.kind.as_deref().and_then(RaidKind::parse);
        let number = row.number;
        out.insert(
            row.id.clone(),
            ResolvedEnd {
                link_type,
                id: row.id,
                project_id,
                kind,
                title: row.title,
                status: row.status,
                code: match link_type {
                    "raid_item" => kind
                        .zip(number)
                        .map(|(kind, number)| raid_code(kind, i64::from(number))),
                    "decision" => number.map(|number| decision_code(i64::from(number))),
                    "change_request" => number.map(|number| format!("CR-{number}")),
                    "deliverable" => number.map(|number| deliverable_code(i64::from(number))),
                    "benefit" => number.map(|number| benefit_code(i64::from(number))),
                    _ => None,
                },
                owner_id: row.owner_id,
                due_date: row.due,
            },
        );
    }
    Ok(out)
}

/// `resolveEnd(db, type, id)`: one live object, or `None`.
pub(crate) async fn resolve_end(
    db: &PgPool,
    link_type: &str,
    id: &str,
) -> Result<Option<ResolvedEnd>, DbErr> {
    Ok(resolve_ends(db, link_type, &[id.to_owned()])
        .await?
        .remove(id))
}

/// Which way a link is seen: `outgoing` from its `from` end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Outgoing,
    Incoming,
}

impl Direction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Outgoing => "outgoing",
            Self::Incoming => "incoming",
        }
    }
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// The object at the other end of a link, seen in `direction`.
fn other_end(row: &Value, direction: Direction) -> (&str, &str) {
    match direction {
        Direction::Outgoing => (text(row, "toType"), text(row, "toId")),
        Direction::Incoming => (text(row, "fromType"), text(row, "fromId")),
    }
}

/// `presentLinkedObjects(db, rows, directionOf, canRead)`: each link with
/// its direction and the object at the other end, oldest link first. A link
/// is left out when its other end no longer exists or sits in a project the
/// caller cannot read.
pub(crate) async fn present_linked_objects(
    caller: &Caller,
    rows: Vec<Value>,
    direction_of: impl Fn(&Value) -> Direction,
) -> Result<Vec<Value>, DbErr> {
    // `loadOtherEnds`: the ids wanted per type, in the order first seen.
    let mut wanted: Vec<(String, Vec<String>)> = Vec::new();
    for row in &rows {
        let (link_type, id) = other_end(row, direction_of(row));
        match wanted.iter_mut().find(|(t, _)| t == link_type) {
            Some((_, ids)) => {
                if !ids.iter().any(|known| known == id) {
                    ids.push(id.to_owned());
                }
            }
            None => wanted.push((link_type.to_owned(), vec![id.to_owned()])),
        }
    }
    let mut ends: HashMap<String, ResolvedEnd> = HashMap::new();
    for (link_type, ids) in &wanted {
        for (id, end) in resolve_ends(&caller.db, link_type, ids).await? {
            ends.insert(format!("{link_type}:{id}"), end);
        }
    }

    let mut sorted = rows;
    sorted.sort_by(|a, b| {
        let at = |row: &Value| millis_of(text(row, "createdAt"));
        at(a)
            .cmp(&at(b))
            .then_with(|| text(a, "id").cmp(text(b, "id")))
    });
    let mut readable: HashMap<String, bool> = HashMap::new();
    let mut out = Vec::new();
    for row in &sorted {
        let direction = direction_of(row);
        let (link_type, id) = other_end(row, direction);
        let Some(end) = ends.get(&format!("{link_type}:{id}")) else {
            continue;
        };
        let may_read = if let Some(known) = readable.get(&end.project_id) {
            *known
        } else {
            let known = caller.can_access(&end.project_id).await?;
            readable.insert(end.project_id.clone(), known);
            known
        };
        if !may_read {
            continue;
        }
        let mut linked = present_control_link(row);
        if let Value::Object(fields) = &mut linked {
            fields.insert("direction".to_owned(), json!(direction.as_str()));
            fields.insert("target".to_owned(), end.target());
        }
        out.push(linked);
    }
    Ok(out)
}

/// A `project_control_links` row by id, as Drizzle reads it.
pub(crate) async fn link_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = links::Entity::find()
        .filter(links::Column::Id.eq(id))
        .one(&orm(db))
        .await?;
    row.map(model_json).transpose()
}

/// `linksOfObject(db, type, id)`: every link with the object at either end,
/// oldest first.
pub(crate) async fn links_of_object(
    db: &PgPool,
    link_type: &str,
    id: &str,
) -> Result<Vec<Value>, DbErr> {
    let rows = links::Entity::find()
        .filter(
            sea_orm::Condition::any()
                .add(
                    sea_orm::Condition::all()
                        .add(links::Column::FromType.eq(link_type))
                        .add(links::Column::FromId.eq(id)),
                )
                .add(
                    sea_orm::Condition::all()
                        .add(links::Column::ToType.eq(link_type))
                        .add(links::Column::ToId.eq(id)),
                ),
        )
        .order_by_asc(links::Column::CreatedAt)
        .order_by_asc(links::Column::Id)
        .all(&orm(db))
        .await?;
    rows.into_iter().map(model_json).collect()
}

/// `linksOfRaidItem(db, itemId)`: every link with the item at either end,
/// oldest first.
pub(crate) async fn links_of_raid_item(db: &PgPool, item_id: &str) -> Result<Vec<Value>, DbErr> {
    links_of_object(db, "raid_item", item_id).await
}
