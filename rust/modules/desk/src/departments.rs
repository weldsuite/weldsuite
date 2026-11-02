//! `/api/helpdesk-departments` (`routes/helpdesk-departments/index.ts`): the
//! department list (user order, with each department's agent count) and
//! the per-department count of open conversations; the rest is the plain
//! CRUD of [`crate::library::DEPARTMENTS_CRUD`].
//! Permissions `departments:read|create|update|delete`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::RawQuery;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{Slots, item_routes, page_list};
use crate::js::{js_limit, query_param, sql_limit};
use crate::library::DEPARTMENTS_CRUD;
use crate::tables::HELPDESK_DEPARTMENTS;
use crate::{Caller, DeskState, Refusal};

/// `$1` live-only skip, `($2, $3)` search, `($4, $5)` isActive, the cursor
/// `($6, $7 sortOrder, $8 createdAt, $9 id)`, `$10` the limit.
const LIST: &str = "select to_jsonb(t) from helpdesk_departments t
    where ($1::boolean or t.deleted_at is null)
      and ($2::boolean or (t.name like $3::text or t.email like $3::text))
      and ($4::boolean or t.is_active = $5::boolean)
      and ($6::boolean or (coalesce(t.sort_order, 0) > $7::integer
           or (coalesce(t.sort_order, 0) = $7::integer
               and (t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9::text)))))
    order by coalesce(t.sort_order, 0), t.created_at desc, t.id desc limit $10";

const COUNT: &str = "select count(*) from helpdesk_departments t
    where ($1::boolean or t.deleted_at is null)
      and ($2::boolean or (t.name like $3::text or t.email like $3::text))
      and ($4::boolean or t.is_active = $5::boolean)
      and ($6::boolean or (coalesce(t.sort_order, 0) > $7::integer
           or (coalesce(t.sort_order, 0) = $7::integer
               and (t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9::text)))))";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([DEPARTMENTS_CRUD.gates.read.to_owned()]);
    item_routes(&DEPARTMENTS_CRUD, gate)
        .route("/", get(list).route_layer(read()))
        .route("/inbox-counts", get(inbox_counts).route_layer(read()))
}

/// The cursor row: `(sortOrder ?? 0, createdAt, id)`.
type CursorRow = (i32, String, String);

async fn cursor_row(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<CursorRow>, sqlx::Error> {
    let row: Option<(Option<i32>, Option<String>, String)> = sqlx::query_as(
        "select sort_order, to_jsonb(created_at)#>>'{}', id from helpdesk_departments where id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(sort, created_at, id)| {
        created_at
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .map(|stamp| (sort.unwrap_or(0), stamp, id))
    }))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let active = query_param(query, "isActive").and_then(|v| match v.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    });
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(&caller.db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "desk: department cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let message = "Failed to list departments";
    let active_slots = [
        true,
        search.is_some(),
        active.is_some(),
        cursor_row.is_some(),
    ];
    let (page, count) = Slots::page_and_count(&active_slots, cursor.is_some());
    let (sort, created_at, id) = match &cursor_row {
        Some((sort, created_at, id)) => (Some(*sort), Some(created_at.as_str()), Some(id.as_str())),
        None => (None, None, None),
    };
    let rows: Result<Vec<Value>, _> = sqlx::query_scalar(LIST)
        .bind(page.skip[0])
        .bind(page.skip[1])
        .bind(search.as_deref())
        .bind(page.skip[2])
        .bind(active)
        .bind(page.skip[3])
        .bind(sort)
        .bind(created_at)
        .bind(id)
        .bind(sql_limit(limit))
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, _> = sqlx::query_scalar(COUNT)
        .bind(count.skip[0])
        .bind(count.skip[1])
        .bind(search.as_deref())
        .bind(count.skip[2])
        .bind(active)
        .bind(count.skip[3])
        .bind(sort)
        .bind(created_at)
        .bind(id)
        .fetch_one(&caller.db)
        .await;
    let agents: Result<Vec<(Option<String>, i32)>, _> = sqlx::query_as(
        "select department_id, count(*)::int from helpdesk_agents
         where deleted_at is null group by department_id",
    )
    .fetch_all(&caller.db)
    .await;
    let (rows, total, agents) = match (rows, total, agents) {
        (Ok(rows), Ok(total), Ok(agents)) => (rows, total, agents),
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            return Refusal::Database(error).respond(message);
        }
    };
    let by_department: HashMap<Option<String>, i32> = agents.into_iter().collect();
    let rows = rows
        .into_iter()
        .map(|row| {
            let mut row = HELPDESK_DEPARTMENTS.js(row);
            let count = row
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| by_department.get(&Some(id.to_owned())))
                .copied()
                .unwrap_or(0);
            if let Value::Object(fields) = &mut row {
                fields.insert("agentCount".to_owned(), json!(count));
            }
            row
        })
        .collect();
    page_list(rows, limit, total)
}

async fn inbox_counts(caller: Caller) -> Response {
    let rows: Result<Vec<(Option<String>, i32)>, _> = sqlx::query_as(
        "select department_id, count(*)::int from helpdesk_conversations
         where deleted_at is null and department_id is not null
           and status not in ('archived', 'closed')
         group by department_id",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter()
                .map(|(department_id, active)| {
                    json!({ "departmentId": department_id, "activeCount": active })
                })
                .collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch inbox counts"),
    }
}
