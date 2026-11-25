//! `/api/workflow-triggers` (`routes/workflow-triggers/index.ts`): the
//! standalone `workflow_triggers` rows (entity and schedule shortcuts
//! included).

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
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_TRIGGER_CREATED, WORKFLOW_TRIGGER_DELETED, WORKFLOW_TRIGGER_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_triggers::{self, Column};
use weldsuite_schema::tenant::workflows;

use crate::js::{next_cursor, page, page_limit, query_param, query_truthy};
use crate::schedules::{CreateError, NewSchedule, create_schedule};
use crate::sync::SyncContext;
use crate::{Caller, ConnectState, Refusal, internal, validate};

const CATEGORIES: &[&str] = &["schedule", "entity_event", "webhook", "manual", "api"];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    let create = || gate.require([perm::WORKFLOWS_CREATE]);
    let update = || gate.require([perm::WORKFLOWS_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create_route).route_layer(create()))
        .route("/entity", post(create_entity).route_layer(create()))
        .route(
            "/schedule",
            post(create_schedule_trigger).route_layer(create()),
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
        .route("/{id}/enable", patch(enable).route_layer(update()))
        .route("/{id}/disable", patch(disable).route_layer(update()))
}

/// A row as Drizzle returned it.
fn js(model: workflow_triggers::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// `leftJoin(workflows, eq(workflowTriggers.workflowId, workflows.id))`.
fn workflow() -> RelationDef {
    workflow_triggers::Entity::belongs_to(workflows::Entity)
        .from(Column::WorkflowId)
        .to(workflows::Column::Id)
        .into()
}

/// A trigger with its workflow's name.
#[derive(FromQueryResult)]
struct Joined {
    #[sea_orm(nested)]
    trigger: workflow_triggers::Model,
    workflow_name: Option<String>,
}

impl Joined {
    fn query() -> sea_orm::Select<workflow_triggers::Entity> {
        workflow_triggers::Entity::find()
            .column_as(workflows::Column::Name, "workflow_name")
            .join(JoinType::LeftJoin, workflow())
    }

    /// `{ ...trigger, workflowName }`: the row read as Drizzle reads it.
    fn into_json(self) -> Value {
        let mut row = js(self.trigger);
        if let Value::Object(map) = &mut row {
            map.insert("workflowName".into(), json!(self.workflow_name));
        }
        row
    }
}

/// The list's filters: not deleted, the `workflowId`, `category` and
/// `isEnabled` sent.
fn filtered(workflow_id: Option<&str>, category: Option<&str>, enabled: Option<bool>) -> Condition {
    let mut filter = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(workflow_id) = workflow_id {
        filter = filter.add(Column::WorkflowId.eq(workflow_id));
    }
    if let Some(category) = category {
        filter = filter.add(Column::Category.eq(category));
    }
    if let Some(enabled) = enabled {
        filter = filter.add(Column::IsEnabled.eq(enabled));
    }
    filter
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let category = query_truthy(query, "category");
    let enabled = query_param(query, "isEnabled").map(|v| v == "true");
    let cursor = query_truthy(query, "cursor");
    let filters = || filtered(workflow_id.as_deref(), category.as_deref(), enabled);
    let db = orm(&caller.db);
    let mut rows = Joined::query().filter(filters());
    if let Some(cursor) = &cursor {
        rows = rows.filter(Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .into_model::<Joined>()
        .all(&db)
        .await;
    let count = workflow_triggers::Entity::find()
        .filter(filters())
        .count(&db)
        .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(Joined::into_json).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow triggers"),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    let row = Joined::query()
        .filter(Column::Id.eq(&id))
        .filter(Column::DeletedAt.is_null())
        .into_model::<Joined>()
        .one(&orm(&caller.db))
        .await;
    match row {
        Ok(Some(row)) => Data(row.into_json()).into_response(),
        Ok(None) => ApiError::not_found("Workflow trigger", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow trigger"),
    }
}

async fn trigger_row(db: &PgPool, id: &str, live: bool) -> Result<Option<Value>, DbErr> {
    let mut row = workflow_triggers::Entity::find_by_id(id.to_owned());
    if live {
        row = row.filter(Column::DeletedAt.is_null());
    }
    Ok(row.one(&orm(db)).await?.map(js))
}

async fn workflow_exists(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = workflows::Entity::find()
        .select_only()
        .column(workflows::Column::Id)
        .filter(workflows::Column::Id.eq(id))
        .filter(workflows::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

fn record(issues: &mut Issues, b: &Map<String, Value>, key: &str) -> Field<Value> {
    issues.nested(b, key, Presence::Optional, |_, fields| {
        Value::Object(fields.clone())
    })
}

async fn insert_trigger(
    db: &PgPool,
    workflow_id: &str,
    name: &str,
    category: &str,
    config: &Value,
    enabled: bool,
) -> Result<String, DbErr> {
    let id = generate_id("trg");
    let stamp = utc_now();
    workflow_triggers::Entity::insert(workflow_triggers::ActiveModel {
        id: Set(id.clone()),
        workflow_id: Set(workflow_id.to_owned()),
        name: Set(name.to_owned()),
        category: Set(category.to_owned()),
        config: Set(config.clone()),
        is_enabled: Set(enabled),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(id)
}

async fn create_route(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Required, Some(1), Some(255))
            .into_option();
        let category = issues
            .choice(b, "category", Presence::Required, CATEGORIES)
            .into_option();
        let config = record(issues, b, "config").into_option();
        let enabled = issues
            .boolean(b, "isEnabled", Presence::Optional)
            .into_option();
        (
            workflow_id.unwrap_or_default(),
            name.unwrap_or_default(),
            category.unwrap_or_default(),
            config,
            enabled,
        )
    });
    let (workflow_id, name, category, config, enabled) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create workflow trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let config = config.unwrap_or_else(|| json!({}));
        let id = insert_trigger(
            &caller.db,
            &workflow_id,
            &name,
            &category,
            &config,
            enabled.unwrap_or(true),
        )
        .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id, "category": category }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create workflow trigger"))
}

async fn create_entity(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Optional, None, None)
            .into_option();
        let entity_type = issues
            .text(b, "entityType", Presence::Required, None, None)
            .into_option();
        let event_type = issues
            .text(b, "eventType", Presence::Required, None, None)
            .into_option();
        let filters = record(issues, b, "filters").into_option();
        (
            workflow_id.unwrap_or_default(),
            name,
            entity_type,
            event_type,
            filters,
        )
    });
    let (workflow_id, name, entity_type, event_type, filters) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create entity trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let mut config = json!({ "entityType": entity_type, "eventType": event_type });
        if let Some(filters) = filters {
            config["filters"] = filters;
        }
        let name = name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Entity Event Trigger".into());
        let id = insert_trigger(
            &caller.db,
            &workflow_id,
            &name,
            "entity_event",
            &config,
            true,
        )
        .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &id,
            &json!({ "id": id, "workflowId": workflow_id, "category": "entity_event" }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create entity trigger"))
}

async fn create_schedule_trigger(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let workflow_id = issues
            .text(b, "workflowId", Presence::Required, None, None)
            .into_option();
        let name = issues
            .text(b, "name", Presence::Optional, None, None)
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
        (
            workflow_id.unwrap_or_default(),
            name,
            cron.unwrap_or_default(),
            timezone,
            start,
            end,
        )
    });
    let (workflow_id, name, cron, timezone, start, end) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create schedule trigger"),
    };
    let result = async {
        if !workflow_exists(&caller.db, &workflow_id).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let timezone = timezone
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "UTC".into());
        let mut config = json!({ "cronExpression": cron, "timezone": timezone });
        if let Some(start) = &start {
            config["startDate"] = json!(start);
        }
        if let Some(end) = &end {
            config["endDate"] = json!(end);
        }
        let trigger_name = name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Schedule Trigger".into());
        let trigger_id = insert_trigger(
            &caller.db,
            &workflow_id,
            &trigger_name,
            "schedule",
            &config,
            true,
        )
        .await?;
        let ctx = SyncContext::for_caller(&caller, &state);
        let created = create_schedule(
            &caller.db,
            &ctx,
            NewSchedule {
                workflow_id: workflow_id.clone(),
                trigger_id: Some(trigger_id.clone()),
                name: Some(
                    name.filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "Schedule".into()),
                ),
                cron_expression: cron,
                timezone: Some(timezone),
                start_date: start,
                end_date: end,
                is_enabled: true,
            },
        )
        .await;
        let schedule_id = match created {
            Ok(id) => id,
            Err(CreateError::WorkflowNotFound) => {
                return Err(Refusal::not_found("Workflow", &workflow_id));
            }
            Err(CreateError::InvalidDate) => {
                return Err(Refusal::Response(Box::new(internal(
                    &"Invalid time value",
                    "Failed to create schedule trigger",
                ))));
            }
            Err(CreateError::Database(error)) => return Err(error.into()),
        };
        let trigger = trigger_row(&caller.db, &trigger_id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_CREATED,
            &trigger_id,
            &json!({ "id": trigger_id, "workflowId": workflow_id, "category": "schedule", "scheduleId": schedule_id }),
        );
        Ok(Created(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to create schedule trigger"))
}

async fn update_route(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = validate(&headers, &body, |issues, b| {
        let name = issues.text(b, "name", Presence::Optional, Some(1), Some(255));
        let category = issues.choice(b, "category", Presence::Optional, CATEGORIES);
        let config = record(issues, b, "config");
        let enabled = issues.boolean(b, "isEnabled", Presence::Optional);
        (name, category, config, enabled)
    });
    let (name, category, config, enabled) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to update workflow trigger"),
    };
    let result = async {
        let Some(existing) = trigger_row(&caller.db, &id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", &id));
        };
        let mut update = workflow_triggers::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        if !name.is_absent() {
            update = update.col_expr(Column::Name, Expr::value(name.as_set().cloned()));
        }
        if !category.is_absent() {
            update = update.col_expr(Column::Category, Expr::value(category.as_set().cloned()));
        }
        if !config.is_absent() {
            update = update.col_expr(Column::Config, Expr::value(config.as_set().cloned()));
        }
        if !enabled.is_absent() {
            update = update.col_expr(Column::IsEnabled, Expr::value(enabled.as_set().copied()));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let trigger = trigger_row(&caller.db, &id, false).await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_UPDATED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(Data(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow trigger"))
}

async fn set_enabled(state: &ConnectState, caller: &Caller, id: &str, enabled: bool) -> Response {
    let result = async {
        let Some(existing) = trigger_row(&caller.db, id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", id));
        };
        workflow_triggers::Entity::update_many()
            .col_expr(Column::IsEnabled, Expr::value(enabled))
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(id))
            .exec(&orm(&caller.db))
            .await?;
        let trigger = trigger_row(&caller.db, id, false).await?;
        caller.publish(
            state,
            WORKFLOW_TRIGGER_UPDATED,
            id,
            &json!({ "id": id, "workflowId": existing["workflowId"], "isEnabled": enabled }),
        );
        Ok(Data(trigger).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to toggle workflow trigger"))
}

async fn enable(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_enabled(&state, &caller, &id, true).await
}

async fn disable(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    set_enabled(&state, &caller, &id, false).await
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = trigger_row(&caller.db, &id, true).await? else {
            return Err(Refusal::not_found("Workflow trigger", &id));
        };
        let stamp = utc_now();
        workflow_triggers::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            WORKFLOW_TRIGGER_DELETED,
            &id,
            &json!({ "id": id, "workflowId": existing["workflowId"] }),
        );
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow trigger"))
}
