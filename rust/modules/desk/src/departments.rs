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
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::helpdesk_departments::{self, Column};
use weldsuite_schema::tenant::{desk_conversations, helpdesk_agents, helpdesk_conversations};

use crate::crud::{CursorRow, Slots, before, item_routes, page_list};
use crate::js::{js_limit, query_param, sql_limit};
use crate::library::DEPARTMENTS_CRUD;
use crate::tables::HELPDESK_DEPARTMENTS;
use crate::{Caller, DeskState, Refusal};

/// `recheckEscalations(c, departmentId)`: a team's escalation rules or active
/// flag changed, so its open conversations are looked at by the next SLA
/// sweep, which re-derives when each rule can fire.
pub(crate) async fn recheck_escalations(
    state: &DeskState,
    caller: &Caller,
    department_id: &str,
) -> Result<(), DbErr> {
    let touched = desk_conversations::Entity::update_many()
        .col_expr(
            desk_conversations::Column::EscalationCheckAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(desk_conversations::Column::DepartmentId.eq(department_id))
        .filter(desk_conversations::Column::State.eq("open"))
        .exec(&orm(&caller.db))
        .await?;
    if touched.rows_affected > 0 {
        crate::mark_sla_due(
            state,
            caller,
            Some(weldsuite_desk_domain::realtime::now_ms()),
        );
    }
    Ok(())
}

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([DEPARTMENTS_CRUD.gates.read.to_owned()]);
    item_routes(&DEPARTMENTS_CRUD, gate)
        .route("/", get(list).route_layer(read()))
        .route("/inbox-counts", get(inbox_counts).route_layer(read()))
}

/// The cursor row: `sortOrder ?? 0`, then the keyset's `(createdAt, id)`.
type DepartmentCursor = (i32, CursorRow);

async fn cursor_row(db: &DatabaseConnection, id: &str) -> Result<Option<DepartmentCursor>, DbErr> {
    let row: Option<(Option<i32>, PrimitiveDateTime, String)> =
        helpdesk_departments::Entity::find_by_id(id.to_owned())
            .select_only()
            .column(Column::SortOrder)
            .column(Column::CreatedAt)
            .column(Column::Id)
            .into_tuple()
            .one(db)
            .await?;
    Ok(row.map(|(sort, created_at, id)| {
        // JavaScript reads the stamp to the millisecond.
        let created_at = weldsuite_db::utc_timestamp(created_at.assume_utc());
        (sort.unwrap_or(0), (created_at, id))
    }))
}

/// `coalesce(t.sortOrder, 0)`.
fn sort_order() -> Expr {
    Expr::from(Func::coalesce([Expr::col(Column::SortOrder), Expr::val(0)]))
}

/// The list's conditions the slots keep: live only, the search, `isActive`,
/// then the cursor (after it in `sortOrder`, then newest first).
fn conditions(
    slots: &Slots,
    search: Option<&str>,
    active: Option<bool>,
    cursor: Option<&DepartmentCursor>,
) -> Result<Condition, DbErr> {
    let mut all = Condition::all();
    if !slots.skip[0] {
        all = all.add(Column::DeletedAt.is_null());
    }
    if !slots.skip[1]
        && let Some(search) = search
    {
        all = all.add(
            Condition::any()
                .add(Column::Name.like(search))
                .add(Column::Email.like(search)),
        );
    }
    if !slots.skip[2]
        && let Some(active) = active
    {
        all = all.add(Column::IsActive.eq(active));
    }
    if !slots.skip[3]
        && let Some((sort, keyset)) = cursor
    {
        all = all.add(
            Condition::any()
                .add(sea_orm::ExprTrait::gt(sort_order(), *sort))
                .add(
                    Condition::all()
                        .add(sea_orm::ExprTrait::eq(sort_order(), *sort))
                        .add(before(&HELPDESK_DEPARTMENTS, keyset)?),
                ),
        );
    }
    Ok(all)
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
    let db = orm(&caller.db);
    let cursor = query_param(query, "cursor").filter(|c| !c.is_empty());
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(&db, cursor).await {
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
    match read_list(
        &db,
        &page,
        &count,
        search.as_deref(),
        active,
        cursor_row.as_ref(),
        limit,
    )
    .await
    {
        Ok((rows, total)) => page_list(rows, limit, total),
        Err(error) => Refusal::from(error).respond(message),
    }
}

/// The page (each department with its `agentCount`) and the count.
async fn read_list(
    db: &DatabaseConnection,
    page: &Slots,
    count: &Slots,
    search: Option<&str>,
    active: Option<bool>,
    cursor: Option<&DepartmentCursor>,
    limit: f64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let mut rows = helpdesk_departments::Entity::find()
        .filter(conditions(page, search, active, cursor)?)
        .order_by_asc(sort_order())
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id);
    if let Some(limit) = sql_limit(limit) {
        rows = rows.limit(u64::try_from(limit).unwrap_or(0));
    }
    let rows = rows.all(db).await?;
    let total = helpdesk_departments::Entity::find()
        .filter(conditions(count, search, active, cursor)?)
        .count(db)
        .await?;
    let agents: Vec<(Option<String>, i64)> = helpdesk_agents::Entity::find()
        .select_only()
        .column(helpdesk_agents::Column::DepartmentId)
        .column_as(helpdesk_agents::Column::Id.count(), "count")
        .filter(helpdesk_agents::Column::DeletedAt.is_null())
        .group_by(helpdesk_agents::Column::DepartmentId)
        .into_tuple()
        .all(db)
        .await?;
    let by_department: HashMap<Option<String>, i64> = agents.into_iter().collect();
    let rows = rows
        .into_iter()
        .map(|department| {
            let count = by_department
                .get(&Some(department.id.clone()))
                .copied()
                .unwrap_or(0);
            let mut row =
                serde_json::to_value(department).map_err(|error| DbErr::Json(error.to_string()))?;
            if let Value::Object(fields) = &mut row {
                fields.insert("agentCount".to_owned(), json!(count));
            }
            Ok(row)
        })
        .collect::<Result<_, DbErr>>()?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

async fn inbox_counts(caller: Caller) -> Response {
    let rows: Result<Vec<(Option<String>, i64)>, DbErr> = helpdesk_conversations::Entity::find()
        .select_only()
        .column(helpdesk_conversations::Column::DepartmentId)
        .column_as(helpdesk_conversations::Column::Id.count(), "count")
        .filter(helpdesk_conversations::Column::DeletedAt.is_null())
        .filter(helpdesk_conversations::Column::DepartmentId.is_not_null())
        .filter(helpdesk_conversations::Column::Status.is_not_in(["archived", "closed"]))
        .group_by(helpdesk_conversations::Column::DepartmentId)
        .into_tuple()
        .all(&orm(&caller.db))
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
        Err(error) => Refusal::from(error).respond("Failed to fetch inbox counts"),
    }
}
