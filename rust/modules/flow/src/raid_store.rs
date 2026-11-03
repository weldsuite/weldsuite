//! RAID log queries shared by `/api/project-raid` and
//! `/api/project-control-links` (`services/project-raid.ts`): task progress,
//! the objects at the ends of a link, and the links as one object sees them.
//! The rules are `weldsuite_flow_domain::raid` and `::risk`.

use std::collections::HashMap;

use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row, js_timestamp};
use weldsuite_flow_domain::js::millis_of;
use weldsuite_flow_domain::raid::{
    LinkEnd, PROGRESS_RELATIONS, RaidKind, present_control_link, raid_code,
};

use crate::Caller;

/// `liveProjectExists(db, projectId)`.
pub(crate) async fn live_project_exists(
    db: &PgPool,
    project_id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> =
        sqlx::query_scalar("select id from projects where id = $1 and deleted_at is null limit 1")
            .bind(project_id)
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

/// `findRaidItem(db, id)`: a live register item, as Drizzle reads it.
pub(crate) async fn find_raid_item(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        raid_json!("r"),
        " from project_raid_items r where r.id = $1 and r.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `taskProgressFor(db, itemIds)`: per item, the live, non-cancelled tasks
/// linked to it with `mitigates` or `resolves`, as `(done, total)`. An item
/// with none is absent (read it with [`progress_of`]).
pub(crate) async fn task_progress_for(
    db: &PgPool,
    item_ids: &[String],
) -> Result<HashMap<String, (i64, i64)>, sqlx::Error> {
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "select l.to_id, count(*)::int8,
                (count(*) filter (where t.status = 'done'))::int8
         from project_control_links l
         inner join tasks t on t.id = l.from_id
         where l.to_type = 'raid_item' and l.to_id = any($1) and l.from_type = 'task'
           and l.relation = any($2) and t.deleted_at is null and t.status <> 'cancelled'
         group by l.to_id",
    )
    .bind(item_ids)
    .bind(PROGRESS_RELATIONS.as_slice())
    .fetch_all(db)
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
/// items only), title, status, owner, due date as text.
type EndRow = (
    String,
    Option<String>,
    Option<String>,
    Option<i32>,
    String,
    String,
    Option<String>,
    Option<String>,
);

const RAID_ENDS: &str = "select id, project_id, kind, number, title, status, owner_id,
        to_jsonb(due_at) #>> '{}'
    from project_raid_items where id = any($1) and deleted_at is null";
const TASK_ENDS: &str = "select id, project_id, null::text, null::int, title, status,
        assignee_id, to_jsonb(due_date) #>> '{}'
    from tasks where id = any($1) and deleted_at is null";
const MILESTONE_ENDS: &str = "select id, project_id, null::text, null::int, name, status,
        owner_id, to_jsonb(due_date) #>> '{}'
    from milestones where id = any($1) and deleted_at is null";

/// `resolveEnds(db, type, ids)`: live objects of one type by id. A task
/// without a project cannot be part of project control, so it is treated
/// like a missing one.
async fn resolve_ends(
    db: &PgPool,
    link_type: &str,
    ids: &[String],
) -> Result<HashMap<String, ResolvedEnd>, sqlx::Error> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let (link_type, sql) = match link_type {
        "raid_item" => ("raid_item", RAID_ENDS),
        "task" => ("task", TASK_ENDS),
        _ => ("milestone", MILESTONE_ENDS),
    };
    let rows: Vec<EndRow> = sqlx::query_as(sql).bind(ids).fetch_all(db).await?;
    for (id, project_id, kind, number, title, status, owner_id, due) in rows {
        let Some(project_id) = project_id.filter(|p| link_type != "task" || !p.is_empty()) else {
            continue;
        };
        let kind = kind.as_deref().and_then(RaidKind::parse);
        out.insert(
            id.clone(),
            ResolvedEnd {
                link_type,
                id,
                project_id,
                kind,
                title,
                status,
                code: kind
                    .zip(number)
                    .map(|(kind, number)| raid_code(kind, i64::from(number))),
                owner_id,
                due_date: due.as_deref().and_then(js_timestamp),
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
) -> Result<Option<ResolvedEnd>, sqlx::Error> {
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
) -> Result<Vec<Value>, sqlx::Error> {
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
pub(crate) async fn link_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from project_control_links l where l.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `linksOfRaidItem(db, itemId)`: every link with the item at either end,
/// oldest first.
pub(crate) async fn links_of_raid_item(
    db: &PgPool,
    item_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from project_control_links l
         where (l.from_type = 'raid_item' and l.from_id = $1)
            or (l.to_type = 'raid_item' and l.to_id = $1)
         order by l.created_at asc, l.id asc",
    )
    .bind(item_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}
