//! `/api/workflow-versions` (`routes/workflow-versions/index.ts`,
//! `services/workflow-versions.ts`): the version history and restoring a
//! version through the normal save path.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::WORKFLOW_UPDATED;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::{Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_versions::{self, Column};
use weldsuite_schema::tenant::workflows;

use crate::js::{next_cursor, page, page_limit, query_truthy};
use crate::sync::SyncContext;
use crate::workflows::{get_workflow, reject_activation, update_workflow};
use crate::{Caller, ConnectState, Refusal, internal};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOWS_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}/restore",
            post(restore).route_layer(gate.require([perm::WORKFLOWS_UPDATE])),
        )
}

/// `SnapshotWorkflowVersionInput`.
pub(crate) struct Snapshot<'a> {
    pub(crate) workflow_id: &'a str,
    pub(crate) name: &'a Value,
    pub(crate) status: &'a Value,
    pub(crate) triggers: Option<&'a Value>,
    pub(crate) steps: Option<&'a Value>,
    pub(crate) settings: Option<&'a Value>,
    pub(crate) created_by: Option<&'a str>,
    pub(crate) reason: &'a str,
    pub(crate) restored_from: Option<i64>,
    pub(crate) note: Option<&'a str>,
}

fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    }
}

/// A NOT NULL `varchar` the snapshot writes: a JSON string, else the insert
/// fails as Postgres refuses the NULL Drizzle writes for `undefined`.
fn text_column<'a>(value: &'a Value, column: &str) -> Result<&'a str, DbErr> {
    value
        .as_str()
        .ok_or_else(|| DbErr::Custom(format!("workflow_versions.{column} is not a string")))
}

/// `snapshotWorkflowVersion(db, input)`: the new version's number.
pub(crate) async fn snapshot(db: &PgPool, input: Snapshot<'_>) -> Result<i64, DbErr> {
    let db = orm(db);
    // `coalesce(max(version), 0)`.
    let max: Option<Option<i32>> = workflow_versions::Entity::find()
        .select_only()
        .column_as(Column::Version.max(), "max")
        .filter(Column::WorkflowId.eq(input.workflow_id))
        .into_tuple()
        .one(&db)
        .await?;
    let version = i64::from(max.flatten().unwrap_or(0)) + 1;
    let number = i32::try_from(version).unwrap_or(i32::MAX);
    workflow_versions::Entity::insert(workflow_versions::ActiveModel {
        id: Set(generate_id("wfv")),
        workflow_id: Set(input.workflow_id.to_owned()),
        version: Set(number),
        name: Set(text_column(input.name, "name")?.to_owned()),
        status: Set(text_column(input.status, "status")?.to_owned()),
        triggers: Set(Some(or_default(input.triggers, json!([])))),
        steps: Set(Some(or_default(input.steps, json!([])))),
        settings: Set(Some(or_default(input.settings, json!({})))),
        created_by: Set(input.created_by.map(str::to_owned)),
        reason: Set(input.reason.to_owned()),
        restored_from_version: Set(input.restored_from.and_then(|v| i32::try_from(v).ok())),
        note: Set(input.note.map(str::to_owned)),
        created_at: Set(utc_now()),
    })
    .exec_without_returning(&db)
    .await?;
    workflows::Entity::update_many()
        .col_expr(workflows::Column::Version, Expr::value(number))
        .filter(workflows::Column::Id.eq(input.workflow_id))
        .exec(&db)
        .await?;
    Ok(version)
}

/// `snapshotWorkflowVersion(...).catch(warn)`.
pub(crate) async fn snapshot_quietly(db: &PgPool, input: Snapshot<'_>) {
    if let Err(error) = snapshot(db, input).await {
        tracing::warn!(%error, "[connect-api/workflows] version snapshot failed");
    }
}

/// A row of the history (`listWorkflowVersions`' columns).
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    id: String,
    workflow_id: String,
    version: i32,
    name: String,
    status: String,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    reason: String,
    restored_from_version: Option<i32>,
    note: Option<String>,
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let cursor = query_truthy(query, "cursor")
        .map(|c| weldsuite_kit::validation::js_number(&c))
        .filter(|n| n.is_finite());
    let db = orm(&caller.db);
    let mut rows = workflow_versions::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::WorkflowId,
            Column::Version,
            Column::Name,
            Column::Status,
            Column::CreatedBy,
            Column::CreatedAt,
            Column::Reason,
            Column::RestoredFromVersion,
            Column::Note,
        ]);
    if let Some(workflow_id) = &workflow_id {
        rows = rows.filter(Column::WorkflowId.eq(workflow_id));
    }
    if let Some(cursor) = cursor {
        rows = rows.filter(Column::Version.lt(cursor));
    }
    let rows = rows
        .order_by_desc(Column::Version)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .into_model::<Summary>()
        .all(&db)
        .await;
    let mut count = workflow_versions::Entity::find();
    if let Some(workflow_id) = &workflow_id {
        count = count.filter(Column::WorkflowId.eq(workflow_id));
    }
    let count = count.count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let rows = rows
                .iter()
                .map(|row| serde_json::to_value(row).unwrap_or(Value::Null))
                .collect();
            let (data, has_more) = page(rows, limit);
            let cursor = next_cursor(&data, has_more, "version");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow versions"),
    }
}

async fn get_version(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workflow_versions::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| serde_json::to_value(row).unwrap_or(Value::Null)))
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match get_version(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => {
            weldsuite_kit::ApiError::not_found("Workflow version", Some(&id)).into_response()
        }
        Err(error) => internal(&error, "Failed to fetch workflow version"),
    }
}

async fn restore(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(snap) = get_version(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Workflow version", &id));
        };
        let workflow_id = snap["workflowId"].as_str().unwrap_or_default().to_owned();
        let Some(existing) = get_workflow(&caller.db, &workflow_id).await? else {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        };
        if existing["status"].as_str() == Some("active")
            && let Some(rejection) = reject_activation(
                &caller.db,
                snap.get("triggers"),
                snap.get("steps"),
                existing.get("tags"),
                Some(&workflow_id),
            )
            .await?
        {
            return Err(rejection.into());
        }
        let mut data = Map::new();
        for key in ["name", "triggers", "steps", "settings"] {
            data.insert(key.to_owned(), snap[key].clone());
        }
        let ctx = SyncContext::for_caller(&caller, &state);
        if !update_workflow(&caller.db, &ctx, &workflow_id, &data).await? {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        }
        let after = get_workflow(&caller.db, &workflow_id).await?;
        let pick = |key: &str| -> Value {
            match after
                .as_ref()
                .and_then(|a| a.get(key))
                .filter(|v| !v.is_null())
            {
                Some(value) => value.clone(),
                None => snap[key].clone(),
            }
        };
        let name = pick("name");
        let status = match after
            .as_ref()
            .map(|a| &a["status"])
            .filter(|v| !v.is_null())
        {
            Some(status) => status.clone(),
            None => existing["status"].clone(),
        };
        let (triggers, steps, settings) = (pick("triggers"), pick("steps"), pick("settings"));
        let restored_from = snap["version"].as_i64();
        let note = format!("Restored from version {}", snap["version"]);
        let version = snapshot(
            &caller.db,
            Snapshot {
                workflow_id: &workflow_id,
                name: &name,
                status: &status,
                triggers: Some(&triggers),
                steps: Some(&steps),
                settings: Some(&settings),
                created_by: Some(&caller.user_id),
                reason: "restored",
                restored_from,
                note: Some(&note),
            },
        )
        .await?;
        let event_status = after.as_ref().map_or(Value::Null, |a| a["status"].clone());
        caller.publish(
            &state,
            WORKFLOW_UPDATED,
            &workflow_id,
            &json!({ "id": workflow_id, "name": name, "status": event_status }),
        );
        Ok(Data(json!({
            "workflowId": workflow_id,
            "version": version,
            "restoredFromVersion": snap["version"],
        }))
        .into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to restore workflow version"))
}
