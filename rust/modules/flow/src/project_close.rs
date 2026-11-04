//! `/api/project-close` (`routes/project-close/index.ts`): closing a project
//! (design: weldflow-delivery-and-portfolio.md, "Close a project").
//!
//! ```text
//! GET  /:projectId            the close checklist, computed from the project's tables
//! POST /:projectId/handover   new owners for open RAID items and for benefits
//! POST /:projectId/request    ask the sponsor to sign the project off (approval
//!                             subject `project_close`, rule `close`)
//! ```
//!
//! The sponsor answers through My reviews (`/api/approvals`). The checks run in
//! TypeScript's order: permission, then the project (404), then project access
//! (403), then the body (400), then the rules.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    FLOW_APPROVAL_REQUESTED, PROJECT_BENEFIT_UPDATED, PROJECT_RAID_ITEM_UPDATED, PROJECT_UPDATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::blueprint::Json;
use weldsuite_flow_domain::js::iso_from_millis;
use weldsuite_flow_domain::project_closing::{
    ALREADY_CLOSED, ALREADY_REQUESTED, CHECKLIST_OPEN, HANDOVER_BENEFIT, HANDOVER_RAID_ITEM,
    NO_SPONSOR, NOTHING_TO_HAND_OVER,
};
use weldsuite_flow_domain::raid::raid_event_data;
use weldsuite_kit::{Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::approvals_adapter::{
    ApproverInput, Requested, cancel_pending_approvals, list_subject_approvals, request_approvals,
    sponsor_of,
};
use crate::closing_body::{Body, parse_body, read_handover, read_request_close};
use crate::closing_store::{
    PROJECT_DENIED, PROJECT_MANAGE_DENIED, approval_event_data, find_live_project, load_checklist,
};
use crate::{Caller, FlowState, Refusal, Reply, outside, reply};

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{projectId}",
            get(checklist).route_layer(need("projects:read")),
        )
        .route(
            "/{projectId}/handover",
            post(handover).route_layer(need("projects:update")),
        )
        .route(
            "/{projectId}/request",
            post(request).route_layer(need("projects:update")),
        )
        .with_state(state)
}

/// Final cost amounts are for managers and for members with `projects:finance`.
async fn amounts_visible(caller: &Caller, project_id: &str) -> Result<bool, sqlx::Error> {
    Ok(caller.can_manage(project_id).await? || caller.can("projects:finance"))
}

/// The live project the caller manages, or the 404 and 403.
async fn managed_project(caller: &Caller, project_id: &str) -> Result<Value, Refusal> {
    let Some(project) = find_live_project(&caller.db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    if !caller.can_manage(project_id).await? {
        return Err(Refusal::forbidden(PROJECT_MANAGE_DENIED));
    }
    Ok(project)
}

// ── GET /:projectId ─────────────────────────────────────────────────────────

async fn checklist(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        async {
            let Some(project) = find_live_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let visible = amounts_visible(&caller, &project_id).await?;
            Ok(Data(load_checklist(&caller.db, &project, visible).await?).into_response())
        }
        .await,
        "Failed to load the close checklist",
    )
}

// ── POST /:projectId/handover ───────────────────────────────────────────────

/// The `{ id, ownerId }` entries of a list, the last owner named for an id
/// winning, in the order each id first appeared (a `Map` of the entries).
fn owners(body: &Body, key: &str) -> Vec<(String, String)> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for entry in body
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let id = entry.text("id").unwrap_or_default().to_owned();
        let owner = entry.text("ownerId").unwrap_or_default().to_owned();
        if let Some(at) = index.get(&id) {
            order[*at].1 = owner;
        } else {
            index.insert(id.clone(), order.len());
            order.push((id, owner));
        }
    }
    order
}

async fn handover(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let project = managed_project(&caller, &project_id).await?;
        let input = parse_body(&body, read_handover)?;
        let (raid, benefits) = (owners(&input, "raidItems"), owners(&input, "benefits"));
        let given = |key: &str| input.get(key).and_then(Value::as_array).map_or(0, Vec::len);
        if given("raidItems") + given("benefits") == 0 {
            return Err(Refusal::bad_request(NOTHING_TO_HAND_OVER));
        }
        Ok((project, raid, benefits))
    }
    .await;
    let (project, raid, benefits) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        hand_over(&state, &caller, &project, &raid, &benefits).await,
        "Failed to hand over the items",
    )
}

/// Every id has to be a live, open item of this project: the rows by id.
async fn open_rows(
    caller: &Caller,
    sql: &'static str,
    project_id: &str,
    owners: &[(String, String)],
) -> Result<Vec<Value>, sqlx::Error> {
    if owners.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = owners.iter().map(|(id, _)| id.as_str()).collect();
    let rows: Vec<Value> = sqlx::query_scalar(sql)
        .bind(&ids)
        .bind(project_id)
        .fetch_all(&caller.db)
        .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

fn by_id(rows: Vec<Value>) -> HashMap<String, Value> {
    rows.into_iter()
        .map(|row| (row.text("id").unwrap_or_default().to_owned(), row))
        .collect()
}

#[allow(clippy::too_many_lines)] // the hand-over's steps, in the TypeScript order
async fn hand_over(
    state: &FlowState,
    caller: &Caller,
    project: &Value,
    raid: &[(String, String)],
    benefits: &[(String, String)],
) -> Reply {
    let db = &caller.db;
    let project_id = project.text("id").unwrap_or_default();
    let raid_rows = open_rows(
        caller,
        concat!(
            "select ",
            raid_json!("r"),
            " from project_raid_items r where r.id = any($1) and r.project_id = $2",
            " and r.deleted_at is null and r.closed_at is null"
        ),
        project_id,
        raid,
    )
    .await?;
    if raid_rows.len() != raid.len() {
        return Err(Refusal::bad_request(HANDOVER_RAID_ITEM));
    }
    let benefit_rows = open_rows(
        caller,
        "select to_jsonb(b) from project_benefits b where b.id = any($1) and b.project_id = $2
         and b.deleted_at is null and b.status <> 'closed'",
        project_id,
        benefits,
    )
    .await?;
    if benefit_rows.len() != benefits.len() {
        return Err(Refusal::bad_request(HANDOVER_BENEFIT));
    }

    let now_ms = crate::now_ms();
    let now = iso_from_millis(now_ms).unwrap_or_default();
    let mut handovers = project
        .at("settings")
        .at("closing")
        .at("handovers")
        .as_object()
        .cloned()
        .unwrap_or_default();
    for (id, owner) in raid {
        handovers.insert(
            id.clone(),
            json!({ "ownerId": owner, "by": caller.user_id, "at": now }),
        );
    }

    let mut statements = Vec::new();
    for (id, owner) in raid {
        statements.push(
            sqlx::query(
                "update project_raid_items set owner_id = $2, updated_at = $3::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.clone())
            .bind(owner.clone())
            .bind(now.clone()),
        );
    }
    for (id, owner) in benefits {
        statements.push(
            sqlx::query(
                "update project_benefits set owner_id = $2, updated_at = $3::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.clone())
            .bind(owner.clone())
            .bind(now.clone()),
        );
    }
    // Merge, never replace: only the `closing` key of the settings is written.
    if !raid.is_empty() {
        statements.push(
            sqlx::query(
                "update projects set
                     settings = coalesce(settings, '{}'::jsonb)
                         || jsonb_build_object('closing', $2::jsonb),
                     updated_at = $3::timestamp
                 where id = $1",
            )
            .bind(project_id.to_owned())
            .bind(json!({ "handovers": handovers }))
            .bind(now.clone()),
        );
    }
    weldsuite_db::atomically(db, statements).await?;

    // In the order the request named them; an owner that did not change publishes nothing.
    let raid_before = by_id(raid_rows);
    for (id, owner) in raid {
        let Some(before) = raid_before.get(id) else {
            continue;
        };
        if before.text("ownerId") == Some(owner.as_str()) {
            continue;
        }
        let mut after = before.clone();
        after["ownerId"] = json!(owner);
        caller.publish(
            state,
            PROJECT_RAID_ITEM_UPDATED,
            id,
            &raid_event_data(&after),
        );
    }
    let benefit_before = by_id(benefit_rows);
    for (id, owner) in benefits {
        let Some(before) = benefit_before.get(id) else {
            continue;
        };
        if before.text("ownerId") == Some(owner.as_str()) {
            continue;
        }
        let number = before.int("number").unwrap_or(0);
        caller.publish(
            state,
            PROJECT_BENEFIT_UPDATED,
            id,
            &json!({
                "id": id, "projectId": project_id, "number": number, "code": format!("B-{number}"),
                "title": before.at("title"), "status": before.at("status"), "ownerId": owner,
            }),
        );
    }
    if !raid.is_empty()
        && let Some(updated) = find_live_project(db, project_id).await?
        && let Some(fields) = updated.as_object()
    {
        caller.publish(
            state,
            PROJECT_UPDATED,
            project_id,
            &crate::projects::analytics_payload(fields),
        );
    }

    let Some(fresh) = find_live_project(db, project_id).await? else {
        return Err(Refusal::not_found("Project", project_id));
    };
    Ok(Data(load_checklist(db, &fresh, true).await?).into_response())
}

// ── POST /:projectId/request ────────────────────────────────────────────────

async fn request(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let project = managed_project(&caller, &project_id).await?;
        parse_body(&body, read_request_close)?;
        Ok(project)
    }
    .await;
    let project = match checked {
        Ok(project) => project,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        request_sign_off(&state, &caller, &project).await,
        "Failed to request sign-off",
    )
}

async fn request_sign_off(state: &FlowState, caller: &Caller, project: &Value) -> Reply {
    let db = &caller.db;
    let project_id = project.text("id").unwrap_or_default();
    if project.text("status") == Some("Closed") {
        return Err(Refusal::conflict(ALREADY_CLOSED));
    }
    let checklist = load_checklist(db, project, true).await?;
    if checklist["signOff"]["state"] == "pending" {
        return Err(Refusal::conflict(ALREADY_REQUESTED));
    }
    if !checklist.flag("canRequest") {
        return Err(Refusal::conflict(CHECKLIST_OPEN));
    }
    let Some(sponsor) = sponsor_of(project.at("settings"), project.text("projectManagerId")) else {
        return Err(Refusal::bad_request(NO_SPONSOR));
    };

    // A request the sponsor declined starts over from scratch.
    let now_ms = crate::now_ms();
    if !list_subject_approvals(db, "project_close", project_id)
        .await?
        .is_empty()
    {
        cancel_pending_approvals(db, "project_close", project_id, true, now_ms).await?;
    }
    let requested = request_approvals(
        db,
        project_id,
        "project_close",
        project_id,
        &caller.user_id,
        &[ApproverInput {
            approver_id: sponsor,
            role_label: Some("Sponsor".to_owned()),
            step: 1,
            rule_code: "close".to_owned(),
        }],
        now_ms,
    )
    .await?;
    let rows = match requested {
        Requested::Rows(rows) => rows,
        Requested::Refused(message) => return Err(Refusal::conflict(message)),
    };
    for row in &rows {
        caller.publish(
            state,
            FLOW_APPROVAL_REQUESTED,
            row.text("id").unwrap_or_default(),
            &approval_event_data(row),
        );
    }
    Ok(Created(load_checklist(db, project, true).await?).into_response())
}
