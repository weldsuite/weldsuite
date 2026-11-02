//! `/api/workflow-versions` (`routes/workflow-versions/index.ts`,
//! `services/workflow-versions.ts`): the version history and restoring a
//! version through the normal save path.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::WORKFLOW_UPDATED;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::{Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{next_cursor, page, page_limit, query_truthy, total};
use crate::sync::SyncContext;
use crate::workflows::{get_workflow, reject_activation, update_workflow};
use crate::{Caller, ConnectState, Refusal, internal, now};

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

/// `snapshotWorkflowVersion(db, input)`: the new version's number.
pub(crate) async fn snapshot(db: &PgPool, input: Snapshot<'_>) -> Result<i64, sqlx::Error> {
    let max: i64 = sqlx::query_scalar(
        "select coalesce(max(version), 0)::bigint from workflow_versions where workflow_id = $1",
    )
    .bind(input.workflow_id)
    .fetch_one(db)
    .await?;
    let version = max + 1;
    sqlx::query(
        "insert into workflow_versions
            (id, workflow_id, version, name, status, triggers, steps, settings, created_by, reason,
             restored_from_version, note, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamp)",
    )
    .bind(generate_id("wfv"))
    .bind(input.workflow_id)
    .bind(i32::try_from(version).unwrap_or(i32::MAX))
    .bind(input.name.as_str())
    .bind(input.status.as_str())
    .bind(or_default(input.triggers, json!([])))
    .bind(or_default(input.steps, json!([])))
    .bind(or_default(input.settings, json!({})))
    .bind(input.created_by)
    .bind(input.reason)
    .bind(input.restored_from.and_then(|v| i32::try_from(v).ok()))
    .bind(input.note)
    .bind(now())
    .execute(db)
    .await?;
    sqlx::query("update workflows set version = $2 where id = $1")
        .bind(input.workflow_id)
        .bind(i32::try_from(version).unwrap_or(i32::MAX))
        .execute(db)
        .await?;
    Ok(version)
}

/// `snapshotWorkflowVersion(...).catch(warn)`.
pub(crate) async fn snapshot_quietly(db: &PgPool, input: Snapshot<'_>) {
    if let Err(error) = snapshot(db, input).await {
        tracing::warn!(%error, "[connect-api/workflows] version snapshot failed");
    }
}

const LIST_ROW: &str =
    "jsonb_build_object('id', v.id, 'workflowId', v.workflow_id, 'version', v.version,
    'name', v.name, 'status', v.status, 'createdBy', v.created_by, 'createdAt', v.created_at,
    'reason', v.reason, 'restoredFromVersion', v.restored_from_version, 'note', v.note)";

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100);
    let workflow_id = query_truthy(query, "workflowId");
    let cursor = query_truthy(query, "cursor")
        .map(|c| weldsuite_kit::validation::js_number(&c))
        .filter(|n| n.is_finite());
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {LIST_ROW} from workflow_versions v
         where ($1::text is null or v.workflow_id = $1) and ($2::float8 is null or v.version < $2)
         order by v.version desc limit $3"
    )))
    .bind(&workflow_id)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(
        "select count(*) from workflow_versions v where ($1::text is null or v.workflow_id = $1)",
    )
    .bind(&workflow_id)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let cursor = next_cursor(&data, has_more, "version");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow versions"),
    }
}

async fn get_version(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(v) from workflow_versions v where v.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
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
