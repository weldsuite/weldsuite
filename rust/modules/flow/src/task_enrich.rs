//! What the task lists add to each row (`routes/tasks/index.ts`): the
//! assignees' display fields, the scheduled calendar slot, the linked CRM
//! company or person, custom fields, subtask counts or the whole subtask
//! tree, and attachment counts. My Tasks shares it.

// The handlers follow the TypeScript route bodies one to one (long
// functions, `data`/`date`-style names from the original), and the list
// queries bind tuples of optional columns.
#![allow(
    clippy::similar_names,
    clippy::too_many_lines,
    clippy::items_after_statements,
    clippy::type_complexity,
    clippy::struct_excessive_bools,
    clippy::ref_option,
    clippy::cast_sign_loss
)]

use std::collections::HashMap;

use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::task_tree::MAX_SUBTASK_DEPTH;
use weldsuite_schema::tenant::tasks::{self, Column as Task};
use weldsuite_schema::tenant::{companies, files, people, workspace_members};

use crate::tasks::row_json;
use crate::{FlowState, Refusal, custom_values};

/// The custom fields' entity type of a task.
pub(crate) const TASK_ENTITY: &str = "task";

/// The assignees of a row: `assigneeIds` when non-empty, else `assigneeId`.
pub(crate) fn assignee_ids_of(row: &Value) -> Vec<String> {
    if let Some(Value::Array(ids)) = row.get("assigneeIds")
        && !ids.is_empty()
    {
        return ids
            .iter()
            .map(|id| id.as_str().map_or_else(|| id.to_string(), str::to_owned))
            .collect();
    }
    match row.get("assigneeId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => vec![id.to_owned()],
        _ => Vec::new(),
    }
}

/// `fetchAssigneeMap`: the members the rows' assignee fields name.
pub(crate) async fn assignee_map(
    db: &PgPool,
    master: Option<&PgPool>,
    rows: &[Value],
) -> Result<HashMap<String, Value>, DbErr> {
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        if let Some(id) = row.get("assigneeId").and_then(Value::as_str)
            && !id.is_empty()
            && !ids.iter().any(|x| x == id)
        {
            ids.push(id.to_owned());
        }
        if let Some(Value::Array(list)) = row.get("assigneeIds") {
            for id in list.iter().filter_map(Value::as_str) {
                if !ids.iter().any(|x| x == id) {
                    ids.push(id.to_owned());
                }
            }
        }
    }
    member_map(db, master, &ids).await
}

/// The members with these user ids, keyed by user id (the last row wins).
/// `avatar` is the account picture (`master`), not the member row's copy.
pub(crate) async fn member_map(
    db: &PgPool,
    master: Option<&PgPool>,
    ids: &[String],
) -> Result<HashMap<String, Value>, DbErr> {
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let members: Vec<(String, Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .column(workspace_members::Column::Name)
        .column(workspace_members::Column::Email)
        .filter(workspace_members::Column::UserId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let pictures = weldsuite_db::AccountPictures::load(
        master,
        members.iter().map(|(user_id, ..)| user_id.as_str()),
    )
    .await;
    for (user_id, name, email) in members {
        let avatar = pictures.value(Some(&user_id));
        map.insert(
            user_id.clone(),
            json!({ "id": user_id, "name": name, "email": email, "avatar": avatar }),
        );
    }
    Ok(map)
}

/// `fetchAssigneeNames`: display names for the audit line.
pub(crate) async fn assignee_names(
    db: &PgPool,
    ids: &[String],
) -> Result<HashMap<String, String>, DbErr> {
    // Names only: no account pictures needed.
    let members = member_map(db, None, ids).await?;
    Ok(members
        .into_iter()
        .filter_map(|(id, member)| {
            member["name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(|name| (id, name.to_owned()))
        })
        .collect())
}

/// `{ id, name, avatar }` of the live companies or people named by `key`:
/// `select id, display_name, avatar_url … where id = any(ids) and
/// deleted_at is null` over `select`.
async fn linked_map<E: EntityTrait>(
    db: &PgPool,
    rows: &[Value],
    key: &str,
    select: impl FnOnce(Vec<String>) -> Select<E>,
) -> Result<HashMap<String, Value>, DbErr> {
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        if let Some(id) = row.get(key).and_then(Value::as_str)
            && !id.is_empty()
            && !ids.iter().any(|x| x == id)
        {
            ids.push(id.to_owned());
        }
    }
    let mut map = HashMap::new();
    if ids.is_empty() {
        return Ok(map);
    }
    let found: Vec<(String, Option<String>, Option<String>)> =
        select(ids).into_tuple().all(&orm(db)).await?;
    for (id, name, avatar) in found {
        map.insert(
            id.clone(),
            json!({ "id": id, "name": name, "avatar": avatar }),
        );
    }
    Ok(map)
}

/// `enrichTasksWithAssignees(db, rows)`.
pub(crate) async fn enrich(
    state: &FlowState,
    db: &PgPool,
    master: Option<&PgPool>,
    rows: Vec<Value>,
) -> Result<Vec<Value>, Refusal> {
    if rows.is_empty() {
        return Ok(rows);
    }
    let members = assignee_map(db, master, &rows).await?;
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let slots = state
        .calendar
        .scheduled_slots(db, &ids)
        .await
        .map_err(Refusal::Internal)?;
    let companies = linked_map(db, &rows, "customerId", |ids| {
        use companies::Column;
        companies::Entity::find()
            .select_only()
            .columns([Column::Id, Column::DisplayName, Column::AvatarUrl])
            .filter(Column::Id.is_in(ids))
            .filter(Column::DeletedAt.is_null())
    })
    .await?;
    let people = linked_map(db, &rows, "personId", |ids| {
        use people::Column;
        people::Entity::find()
            .select_only()
            .columns([Column::Id, Column::DisplayName, Column::AvatarUrl])
            .filter(Column::Id.is_in(ids))
            .filter(Column::DeletedAt.is_null())
    })
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let assignees: Vec<Value> = assignee_ids_of(&row)
                .iter()
                .filter_map(|id| members.get(id).cloned())
                .collect();
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let slot = slots.get(id);
            let link = |key: &str, map: &HashMap<String, Value>| {
                row.get(key)
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .map_or(Value::Null, |id| {
                        map.get(id).cloned().unwrap_or(Value::Null)
                    })
            };
            let linked_company = link("customerId", &companies);
            let linked_person = link("personId", &people);
            let mut out = match row {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            out.insert(
                "assignee".to_owned(),
                assignees.first().cloned().unwrap_or(Value::Null),
            );
            out.insert("assignees".to_owned(), Value::Array(assignees));
            out.insert(
                "scheduledStart".to_owned(),
                slot.and_then(|s| s.start_time.clone())
                    .map_or(Value::Null, Value::String),
            );
            out.insert(
                "scheduledEnd".to_owned(),
                slot.and_then(|s| s.end_time.clone())
                    .map_or(Value::Null, Value::String),
            );
            out.insert(
                "autoScheduled".to_owned(),
                slot.map_or(Value::Null, |s| Value::Bool(s.auto_scheduled)),
            );
            out.insert("linkedCompany".to_owned(), linked_company);
            out.insert("linkedPerson".to_owned(), linked_person);
            Value::Object(out)
        })
        .collect())
}

/// `hydrateCustomFields(db, 'task', rows)`.
pub(crate) async fn hydrate(db: &PgPool, rows: Vec<Value>) -> Result<Vec<Value>, Refusal> {
    Ok(custom_values::hydrate(db, TASK_ENTITY, rows).await?)
}

/// `count(*)::int` of the rows a group holds.
fn count_int() -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::from(Func::count(Expr::col(Asterisk))).cast_as("int")
}

/// `{ total, completed }` live children per parent id.
pub(crate) async fn subtask_counts(
    db: &PgPool,
    parent_ids: &[String],
) -> Result<HashMap<String, (i64, i64)>, DbErr> {
    use sea_orm::ExprTrait as _;
    // `count(*) filter (where status = 'done')`: the rows the case keeps.
    let done = Expr::from(Func::count(Expr::case(Task::Status.eq("done"), 1))).cast_as("int");
    let rows: Vec<(Option<String>, i32, i32)> = tasks::Entity::find()
        .select_only()
        .column(Task::ParentTaskId)
        .column_as(count_int(), "total")
        .column_as(done, "done")
        .filter(Task::ParentTaskId.is_in(parent_ids.iter().map(String::as_str)))
        .filter(Task::DeletedAt.is_null())
        .group_by(Task::ParentTaskId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(parent, total, done)| {
            parent.map(|parent| (parent, (i64::from(total), i64::from(done))))
        })
        .collect())
}

fn ids_of(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn set(row: &mut Value, key: &str, value: Value) {
    if let Value::Object(map) = row {
        map.insert(key.to_owned(), value);
    }
}

/// `attachSubtaskCounts`: each row's own live children.
pub(crate) async fn attach_subtask_counts(
    db: &PgPool,
    rows: &mut [Value],
) -> Result<(), DbErr> {
    let counts = subtask_counts(db, &ids_of(rows)).await?;
    for row in rows.iter_mut() {
        let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
        let (total, done) = counts.get(id).copied().unwrap_or((0, 0));
        set(row, "subtaskCount", json!(total));
        set(row, "completedSubtaskCount", json!(done));
    }
    Ok(())
}

/// `attachAttachmentCounts`: one count over every row (`files` with
/// `entityType = 'task'`).
pub(crate) async fn attach_attachment_counts(
    db: &PgPool,
    rows: &mut [Value],
) -> Result<(), DbErr> {
    if rows.is_empty() {
        return Ok(());
    }
    let found: Vec<(Option<String>, i32)> = files::Entity::find()
        .select_only()
        .column(files::Column::EntityId)
        .column_as(count_int(), "count")
        .filter(files::Column::EntityType.eq("task"))
        .filter(files::Column::EntityId.is_in(ids_of(rows)))
        .filter(files::Column::DeletedAt.is_null())
        .group_by(files::Column::EntityId)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let counts: HashMap<String, i32> = found
        .into_iter()
        .filter_map(|(id, n)| id.map(|id| (id, n)))
        .collect();
    for row in rows.iter_mut() {
        let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
        let n = counts.get(id).copied().unwrap_or(0);
        set(row, "attachmentsCount", json!(n));
    }
    Ok(())
}

/// `loadEnrichedDescendants(db, projectId, roots)`: the roots' subtask
/// trees, level by level (oldest first within a level), enriched and
/// hydrated.
pub(crate) async fn load_descendants(
    state: &FlowState,
    db: &PgPool,
    master: Option<&PgPool>,
    project_id: Option<&str>,
    roots: &[Value],
) -> Result<Vec<Value>, Refusal> {
    let mut frontier = ids_of(roots);
    let mut seen: Vec<String> = Vec::new();
    let mut all: Vec<Value> = Vec::new();
    for _ in 0..MAX_SUBTASK_DEPTH {
        if frontier.is_empty() {
            break;
        }
        let mut select = tasks::Entity::find();
        if let Some(project_id) = project_id {
            select = select.filter(Task::ProjectId.eq(project_id));
        }
        let children: Vec<Value> = select
            .filter(Task::ParentTaskId.is_in(frontier.iter().map(String::as_str)))
            .filter(Task::DeletedAt.is_null())
            .order_by_asc(Task::Position)
            .order_by_asc(Task::CreatedAt)
            .order_by_asc(Task::Id)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(row_json)
            .collect::<Result<_, DbErr>>()?;
        let fresh: Vec<Value> = children
            .into_iter()
            .filter(|child| {
                child
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !seen.iter().any(|s| s == id))
            })
            .collect();
        if fresh.is_empty() {
            break;
        }
        frontier = ids_of(&fresh);
        seen.extend(frontier.iter().cloned());
        all.extend(fresh);
    }
    if all.is_empty() {
        return Ok(all);
    }
    let enriched = enrich(state, db, master, all).await?;
    hydrate(db, enriched).await
}

/// `attachSubtaskTree(roots, descendants)`: `children`, `subtaskCount` and
/// `completedSubtaskCount` on every node.
pub(crate) fn attach_subtask_tree(roots: &mut [Value], descendants: &[Value]) {
    let mut by_parent: HashMap<String, Vec<Value>> = HashMap::new();
    for row in descendants {
        if let Some(parent) = row
            .get("parentTaskId")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        {
            by_parent
                .entry(parent.to_owned())
                .or_default()
                .push(row.clone());
        }
    }
    fn attach(node: &mut Value, by_parent: &HashMap<String, Vec<Value>>, depth: usize) {
        let id = node
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut kids = by_parent.get(&id).cloned().unwrap_or_default();
        let total = kids.len();
        let done = kids
            .iter()
            .filter(|kid| kid.get("status").and_then(Value::as_str) == Some("done"))
            .count();
        // A parent cycle would recurse for ever in TypeScript (a stack
        // overflow, a 500); stop well past any real tree instead.
        if depth < 64 {
            for kid in &mut kids {
                attach(kid, by_parent, depth + 1);
            }
        }
        set(node, "children", Value::Array(kids));
        set(node, "subtaskCount", json!(total));
        set(node, "completedSubtaskCount", json!(done));
    }
    for root in roots.iter_mut() {
        attach(root, &by_parent, 0);
    }
}

/// `attachSubtaskTreeAcrossProjects(db, roots)` (My Tasks).
pub(crate) async fn attach_tree_across_projects(
    state: &FlowState,
    db: &PgPool,
    master: Option<&PgPool>,
    roots: &mut [Value],
) -> Result<(), Refusal> {
    if roots.is_empty() {
        return Ok(());
    }
    let descendants = load_descendants(state, db, master, None, roots).await?;
    attach_subtask_tree(roots, &descendants);
    Ok(())
}
