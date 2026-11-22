//! `/api/workflow-schedules` (`routes/workflow-schedules/index.ts`,
//! `services/workflow-schedules.ts`). A timing change clears the schedule's
//! `next_run_at` and marks the workspace due for the schedule sweep (the D1
//! schedule index's job on Global, see `sync`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_SCHEDULE_CREATED, WORKFLOW_SCHEDULE_DELETED, WORKFLOW_SCHEDULE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Field, Presence, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_schedules::{self, Column};
use weldsuite_schema::tenant::workflows;

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy};
use crate::sync::SyncContext;
use crate::{Caller, ConnectState, Refusal, internal, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::WORKFLOWS_CREATE])),
        )
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update_route)
                .patch(update_route)
                .route_layer(update()),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete).route_layer(gate.require([perm::WORKFLOWS_DELETE])),
        )
        .route("/{id}/toggle", patch(toggle).route_layer(update()))
}

/// A row as Drizzle returned it.
fn js(model: workflow_schedules::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// The list's filters: not deleted, the `workflowId` and `isEnabled` sent.
fn filtered(workflow_id: Option<&str>, enabled: Option<bool>) -> Select<workflow_schedules::Entity> {
    let mut filter = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(workflow_id) = workflow_id {
        filter = filter.add(Column::WorkflowId.eq(workflow_id));
    }
    if let Some(enabled) = enabled {
        filter = filter.add(Column::IsEnabled.eq(enabled));
    }
    workflow_schedules::Entity::find().filter(filter)
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let enabled = query_param(query, "isEnabled").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    let db = orm(&caller.db);
    let mut rows = filtered(workflow_id.as_deref(), enabled);
    if let Some(cursor) = &cursor {
        rows = rows.filter(Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await;
    let count = filtered(workflow_id.as_deref(), enabled).count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow schedules"),
    }
}

pub(crate) async fn get_schedule(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workflow_schedules::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(js))
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_schedule(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Workflow schedule", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow schedule"),
    }
}

/// `createSchedule`'s input.
pub(crate) struct NewSchedule {
    pub(crate) workflow_id: String,
    pub(crate) trigger_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) cron_expression: String,
    pub(crate) timezone: Option<String>,
    pub(crate) start_date: Option<String>,
    pub(crate) end_date: Option<String>,
    pub(crate) is_enabled: bool,
}

/// Why `createSchedule` did not create one.
pub(crate) enum CreateError {
    WorkflowNotFound,
    /// `new Date(value).toISOString()` threw.
    InvalidDate,
    Database(DbErr),
}

impl From<DbErr> for CreateError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// `new Date(value)` of a truthy date string, as the `timestamp` column
/// stores it (`toISOString()`, read without its `Z`).
fn date(value: Option<&str>) -> Result<Option<PrimitiveDateTime>, ()> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(text) => js_date_iso(text)
            .and_then(|iso| OffsetDateTime::parse(&iso, &Rfc3339).ok())
            .map(|at| Some(utc_timestamp(at)))
            .ok_or(()),
    }
}

/// `createSchedule(db, data, userId, sync)`.
pub(crate) async fn create_schedule(
    db: &PgPool,
    ctx: &SyncContext,
    input: NewSchedule,
) -> Result<String, CreateError> {
    let db = orm(db);
    let found: Option<String> = workflows::Entity::find()
        .select_only()
        .column(workflows::Column::Id)
        .filter(workflows::Column::Id.eq(&input.workflow_id))
        .filter(workflows::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&db)
        .await?;
    if found.is_none() {
        return Err(CreateError::WorkflowNotFound);
    }
    let start = date(input.start_date.as_deref()).map_err(|()| CreateError::InvalidDate)?;
    let end = date(input.end_date.as_deref()).map_err(|()| CreateError::InvalidDate)?;
    let id = generate_id("sched");
    let timezone = input
        .timezone
        .filter(|tz| !tz.is_empty())
        .unwrap_or_else(|| "UTC".into());
    let stamp = utc_now();
    workflow_schedules::Entity::insert(workflow_schedules::ActiveModel {
        id: Set(id.clone()),
        workflow_id: Set(input.workflow_id),
        trigger_id: Set(input.trigger_id),
        name: Set(input.name),
        cron_expression: Set(Some(input.cron_expression)),
        timezone: Set(timezone),
        start_date: Set(start),
        end_date: Set(end),
        is_enabled: Set(input.is_enabled),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    ctx.schedule_due().await;
    Ok(id)
}

async fn create(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let trigger_id = issues
            .text(b, "triggerId", Presence::Nullish, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Required, Some(1), Some(255))
            .into_option();
        let cron = issues
            .text(b, "cronExpression", Presence::Required, None, None)
            .into_option();
        let timezone = issues
            .text(b, "timezone", Presence::Optional, None, None)
            .into_option();
        let start = issues
            .text(b, "startDate", Presence::Optional, None, None)
            .into_option();
        let end = issues
            .text(b, "endDate", Presence::Optional, None, None)
            .into_option();
        let enabled = issues
            .boolean(b, "isEnabled", Presence::Optional)
            .into_option();
        NewSchedule {
            workflow_id: workflow_id.unwrap_or_default(),
            trigger_id,
            name,
            cron_expression: cron.unwrap_or_default(),
            timezone: Some(timezone.unwrap_or_else(|| "UTC".into())),
            start_date: start,
            end_date: end,
            is_enabled: enabled != Some(false),
        }
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to create workflow schedule"),
    };
    let workflow_id = input.workflow_id.clone();
    let ctx = SyncContext::for_caller(&caller, &state);
    match create_schedule(&caller.db, &ctx, input).await {
        Ok(id) => {
            caller.publish(
                &state,
                WORKFLOW_SCHEDULE_CREATED,
                &id,
                &json!({ "id": id, "workflowId": workflow_id }),
            );
            Created(json!({ "id": id })).into_response()
        }
        Err(CreateError::WorkflowNotFound) => {
            ApiError::not_found("Workflow", Some(&workflow_id)).into_response()
        }
        Err(CreateError::InvalidDate) => {
            internal(&"Invalid time value", "Failed to create workflow schedule")
        }
        Err(CreateError::Database(error)) => internal(&error, "Failed to create workflow schedule"),
    }
}

async fn update_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        let name = issues.text(b, "name", Presence::Optional, Some(1), Some(255));
        let cron = issues.text(b, "cronExpression", Presence::Optional, None, None);
        let timezone = issues.text(b, "timezone", Presence::Optional, None, None);
        let start = issues.text(b, "startDate", Presence::Nullish, None, None);
        let end = issues.text(b, "endDate", Presence::Nullish, None, None);
        let enabled = issues.boolean(b, "isEnabled", Presence::Optional);
        (name, cron, timezone, start, end, enabled)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update workflow schedule"),
    };
    let (name, cron, timezone, start, end, enabled) = data;
    let result = async {
        if get_schedule(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow schedule", &id));
        }
        let when = |field: &Field<String>| -> Result<(bool, Option<PrimitiveDateTime>), Refusal> {
            match field {
                Field::Absent => Ok((false, None)),
                Field::Null => Ok((true, None)),
                Field::Set(text) => date(Some(text)).map(|d| (true, d)).map_err(|()| {
                    Refusal::Response(Box::new(internal(
                        &"Invalid time value",
                        "Failed to update workflow schedule",
                    )))
                }),
            }
        };
        let (start_set, start) = when(&start)?;
        let (end_set, end) = when(&end)?;
        let timing = !cron.is_absent()
            || !timezone.is_absent()
            || start_set
            || end_set
            || !enabled.is_absent();
        let mut update = workflow_schedules::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        let texts = [
            (Column::Name, &name),
            (Column::CronExpression, &cron),
            (Column::Timezone, &timezone),
        ];
        for (column, field) in texts {
            if !field.is_absent() {
                update = update.col_expr(column, Expr::value(field.as_set().cloned()));
            }
        }
        if !enabled.is_absent() {
            update = update.col_expr(Column::IsEnabled, Expr::value(enabled.as_set().copied()));
        }
        if start_set {
            update = update.col_expr(Column::StartDate, Expr::value(start));
        }
        if end_set {
            update = update.col_expr(Column::EndDate, Expr::value(end));
        }
        if timing {
            update = update.col_expr(
                Column::NextRunAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            );
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        if timing {
            SyncContext::for_caller(&caller, &state)
                .schedule_due()
                .await;
        }
        caller.publish(&state, WORKFLOW_SCHEDULE_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow schedule"))
}

async fn toggle(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let enabled = match validate(&headers, &body, |issues, b| {
        issues
            .boolean(b, "enabled", Presence::Required)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(enabled) => enabled,
        Err(refusal) => return refusal.respond("Failed to toggle workflow schedule"),
    };
    let result = async {
        if get_schedule(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow schedule", &id));
        }
        workflow_schedules::Entity::update_many()
            .col_expr(Column::IsEnabled, Expr::value(enabled))
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .col_expr(
                Column::NextRunAt,
                Expr::value(Option::<PrimitiveDateTime>::None),
            )
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        SyncContext::for_caller(&caller, &state)
            .schedule_due()
            .await;
        caller.publish(
            &state,
            WORKFLOW_SCHEDULE_UPDATED,
            &id,
            &json!({ "id": id, "isEnabled": enabled }),
        );
        Ok(Data(json!({ "id": id, "isEnabled": enabled })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to toggle workflow schedule"))
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if get_schedule(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow schedule", &id));
        }
        let stamp = utc_now();
        workflow_schedules::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, WORKFLOW_SCHEDULE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow schedule"))
}
