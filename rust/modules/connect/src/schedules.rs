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
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_SCHEDULE_CREATED, WORKFLOW_SCHEDULE_DELETED, WORKFLOW_SCHEDULE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::sync::SyncContext;
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

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

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let enabled = query_param(query, "isEnabled").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    const FILTER: &str = "t.deleted_at is null and ($1::text is null or t.workflow_id = $1)
        and ($2::boolean is null or t.is_enabled = $2)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select to_jsonb(t) from workflow_schedules t where {FILTER} and ($3::text is null or t.id < $3)
         order by t.created_at desc limit $4"
    )))
    .bind(&workflow_id)
    .bind(enabled)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_schedules t where {FILTER}"
    )))
    .bind(&workflow_id)
    .bind(enabled)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow schedules"),
    }
}

pub(crate) async fn get_schedule(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from workflow_schedules t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
    Database(sqlx::Error),
}

impl From<sqlx::Error> for CreateError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `new Date(value)` of a truthy date string, as written.
fn date(value: Option<&str>) -> Result<Option<String>, ()> {
    match value.filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(text) => js_date_iso(text).map(Some).ok_or(()),
    }
}

/// `createSchedule(db, data, userId, sync)`.
pub(crate) async fn create_schedule(
    db: &PgPool,
    ctx: &SyncContext,
    input: NewSchedule,
) -> Result<String, CreateError> {
    let found: Option<String> =
        sqlx::query_scalar("select id from workflows where id = $1 and deleted_at is null limit 1")
            .bind(&input.workflow_id)
            .fetch_optional(db)
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
    sqlx::query(
        "insert into workflow_schedules
            (id, workflow_id, trigger_id, name, cron_expression, timezone, start_date, end_date,
             is_enabled, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8::timestamp, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(&input.workflow_id)
    .bind(&input.trigger_id)
    .bind(&input.name)
    .bind(&input.cron_expression)
    .bind(&timezone)
    .bind(&start)
    .bind(&end)
    .bind(input.is_enabled)
    .bind(now())
    .execute(db)
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
        let when = |field: &Field<String>| -> Result<(bool, Option<String>), Refusal> {
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
        sqlx::query(
            "update workflow_schedules set updated_at = $2::timestamp,
                name = case when $3 then $4 else name end,
                cron_expression = case when $5 then $6 else cron_expression end,
                timezone = case when $7 then $8 else timezone end,
                is_enabled = case when $9 then $10 else is_enabled end,
                start_date = case when $11 then $12::timestamp else start_date end,
                end_date = case when $13 then $14::timestamp else end_date end,
                next_run_at = case when $15 then null else next_run_at end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(!name.is_absent())
        .bind(name.as_set())
        .bind(!cron.is_absent())
        .bind(cron.as_set())
        .bind(!timezone.is_absent())
        .bind(timezone.as_set())
        .bind(!enabled.is_absent())
        .bind(enabled.as_set().copied())
        .bind(start_set)
        .bind(&start)
        .bind(end_set)
        .bind(&end)
        .bind(timing)
        .execute(&caller.db)
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
        sqlx::query(
            "update workflow_schedules set is_enabled = $2, updated_at = $3::timestamp, next_run_at = null
             where id = $1",
        )
        .bind(&id)
        .bind(enabled)
        .bind(now())
        .execute(&caller.db)
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
        let stamp = now();
        sqlx::query(
            "update workflow_schedules set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        caller.publish(&state, WORKFLOW_SCHEDULE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow schedule"))
}
