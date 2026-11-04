//! `/api/project-baselines` (`routes/project-baselines/index.ts`, FLOW-012):
//! immutable baseline versions in `project_baselines`. v1 is signed off by the
//! project manager; every later version comes from an approved change request.
//!
//! ```text
//! GET    /                                  list (projectId optional, cursor), newest first
//! GET    /compare                           variance between two versions, or one and the live plan
//! GET    /{id}                              one version
//! POST   /projects/{projectId}/initial      sign off v1 from the current plan (once)
//! ```
//!
//! Check order as in TypeScript: permission, the record (404), project access
//! (403), the query (400), then the rules.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::PROJECT_BASELINE_CREATED;
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::baselines::{
    baseline_event_data, baseline_is_empty, build_snapshot, compare_snapshots, find_baseline,
    latest_baseline, load_plan_state, messages, present_baseline,
};
use weldsuite_flow_domain::changes::{change_code, list_pending_changes};
use weldsuite_flow_domain::js::{iso_from_millis, js_date, parse_int};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::approvals::find_live_project;
use crate::raid_body::read_query;
use crate::{
    Caller, FlowState, Refusal, access_scope, keyset_cursor, now_ms, outside, page, paged, reply,
};

const PROJECT_DENIED: &str = "You are not a member of this project";
const PROJECT_EDIT_DENIED: &str =
    "You must be a project owner, admin, or manager to edit this project";
const ITEM_LABEL: &str = "Baseline";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/compare", get(compare).route_layer(need("projects:read")))
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route(
            "/projects/{project_id}/initial",
            post(sign_off).route_layer(need("projects:update")),
        )
        .with_state(state)
}

/// The code and title of the change request behind each baseline, by baseline id.
async fn changes_of(
    db: &PgPool,
    rows: &[Value],
) -> Result<HashMap<String, (String, String)>, sqlx::Error> {
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| r["changeRequestId"].as_str().map(str::to_owned))
        .collect();
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let found: Vec<(String, i32, String)> =
        sqlx::query_as("select id, number, title from project_change_requests where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    for row in rows {
        let change = row["changeRequestId"]
            .as_str()
            .and_then(|cid| found.iter().find(|(id, ..)| id == cid));
        if let (Some((_, number, title)), Some(id)) = (change, row["id"].as_str()) {
            out.insert(
                id.to_owned(),
                (change_code(i64::from(*number)), title.clone()),
            );
        }
    }
    Ok(out)
}

async fn present_one(db: &PgPool, row: &Value) -> Result<Value, sqlx::Error> {
    let changes = changes_of(db, std::slice::from_ref(row)).await?;
    let change = row["id"].as_str().and_then(|id| changes.get(id));
    Ok(present_baseline(
        row,
        change.map(|(c, t)| (c.as_str(), t.as_str())),
    ))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match read_query(raw.as_deref(), |issues, f| {
        let mut text = |key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        (text("projectId"), text("cursor"), text("limit"))
    }) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let (project_id, cursor_id, limit_raw) = q;
    let limit = match limit_raw.as_deref().and_then(parse_int) {
        Some(n) if n >= 1 => n.min(100),
        _ => 25,
    };
    let scope = async {
        if let Some(project_id) = &project_id {
            if !caller.can_access(project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            return Ok((true, Vec::new()));
        }
        Ok(access_scope(&caller).await?)
    }
    .await;
    let (all, ids) = match scope {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &cursor_id {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_baselines where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        async {
            let filter = concat!(
                "($1::text is null or t.project_id = $1) and ($1::text is not null or ",
                in_accessible!("t.project_id", "$2", "$3"),
                ")"
            );
            let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select to_jsonb(t) from project_baselines t where {filter}
                 and ($4::timestamptz is null or t.created_at < $4::timestamptz
                      or (t.created_at = $4::timestamptz and t.id < $5))
                 order by t.created_at desc, t.id desc limit $6"
            )))
            .bind(project_id.as_deref())
            .bind(all)
            .bind(&ids)
            .bind(cursor.as_ref().map(|c| c.0.as_str()))
            .bind(cursor.as_ref().map(|c| c.1.as_str()))
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
            let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
                "select count(*)::int8 from project_baselines t where {filter}"
            )))
            .bind(project_id.as_deref())
            .bind(all)
            .bind(&ids)
            .fetch_one(&caller.db)
            .await?;
            let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
            let changes = changes_of(&caller.db, &rows).await?;
            let items = rows
                .iter()
                .map(|row| {
                    let change = row["id"].as_str().and_then(|id| changes.get(id));
                    present_baseline(row, change.map(|(c, t)| (c.as_str(), t.as_str())))
                })
                .collect();
            Ok(paged(items, total, has_more, next))
        }
        .await,
        "Failed to list baselines",
    )
}

// ── GET /compare ────────────────────────────────────────────────────────────

fn iso(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(js_date)
        .map_or(Value::Null, Value::String)
}

#[allow(clippy::too_many_lines)]
async fn compare(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match read_query(raw.as_deref(), |issues, f| {
        let mut text = |key: &str| {
            issues
                .text_with(f, key, Presence::Optional, Text::default())
                .into_option()
        };
        (text("projectId"), text("from"), text("to"))
    }) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let (project_id, from_id, to_id) = q;
    if project_id.is_none() && from_id.is_none() {
        return outside(Err(Refusal::bad_request(messages::NEEDS_PROJECT_OR_FROM)));
    }
    reply(
        async {
            let db = &caller.db;
            let from = if let Some(from_id) = &from_id {
                find_baseline(db, from_id)
                    .await?
                    .ok_or_else(|| Refusal::not_found(ITEM_LABEL, from_id))?
            } else {
                let project = project_id.clone().unwrap_or_default();
                if !caller.can_access(&project).await? {
                    return Err(Refusal::forbidden(PROJECT_DENIED));
                }
                let Some(found) = latest_baseline(db, &project).await? else {
                    return Err(Refusal::from(weldsuite_kit::ApiError::not_found(ITEM_LABEL, None)));
                };
                found
            };
            let from_project = from["projectId"].as_str().unwrap_or_default().to_owned();
            if !caller.can_access(&from_project).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let to = match to_id.as_deref() {
                Some(id) if id != "current" => {
                    let found = find_baseline(db, id)
                        .await?
                        .ok_or_else(|| Refusal::not_found(ITEM_LABEL, id))?;
                    if found["projectId"] != from["projectId"] {
                        return Err(Refusal::bad_request(messages::DIFFERENT_PROJECTS));
                    }
                    Some(found)
                }
                _ => None,
            };
            let plan = if to.is_some() { None } else { load_plan_state(db, &from_project).await? };
            let to_snapshot = match (&to, &plan) {
                (Some(to), _) => to["snapshot"].clone(),
                (None, Some(plan)) => build_snapshot(plan),
                (None, None) => {
                    let mut empty = from["snapshot"].clone();
                    if let Value::Object(map) = &mut empty {
                        map.insert("milestones".to_owned(), json!([]));
                        map.insert("deliverables".to_owned(), json!([]));
                    }
                    empty
                }
            };

            // What open change requests would do to the live plan, for the dashed previews.
            let mut pending = Vec::new();
            if let (None, Some(plan)) = (&to, &plan) {
                for change in list_pending_changes(db, &from_project).await? {
                    let changes = change.get("planChanges").cloned().unwrap_or(Value::Null);
                    let milestones: Vec<Value> = changes["milestones"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|mv| {
                            let id = mv["milestoneId"].as_str()?;
                            let current = plan.milestones.iter().find(|m| m.id == id)?;
                            Some(json!({
                                "milestoneId": id, "name": current.name,
                                "from": js_date(&current.due_date), "to": iso(mv.get("to")),
                            }))
                        })
                        .collect();
                    let deliverables: Vec<Value> = changes["deliverables"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|mv| {
                            let current = plan
                                .deliverables
                                .iter()
                                .find(|d| Some(d.id.as_str()) == mv["deliverableId"].as_str());
                            let pick = |key: &str, now: Option<&String>| {
                                if mv.get(key).is_some() {
                                    iso(mv.get(key))
                                } else {
                                    now.and_then(|n| js_date(n)).map_or(Value::Null, Value::String)
                                }
                            };
                            json!({
                                "deliverableId": mv["deliverableId"],
                                "plannedStart": pick("plannedStart", current.and_then(|d| d.planned_start.as_ref())),
                                "plannedEnd": pick("plannedEnd", current.and_then(|d| d.planned_end.as_ref())),
                            })
                        })
                        .collect();
                    pending.push(json!({
                        "changeRequestId": change["id"],
                        "code": change_code(change["number"].as_i64().unwrap_or(0)),
                        "title": change["title"],
                        "status": change["status"],
                        "milestones": milestones,
                        "deliverables": deliverables,
                        "goLive": iso(changes.get("goLive")),
                    }));
                }
            }
            let to_json = match &to {
                Some(to) => present_one(db, to).await?,
                None => Value::Null,
            };
            Ok(Data(json!({
                "from": present_one(db, &from).await?,
                "to": to_json,
                "toSnapshot": to_snapshot,
                "diff": compare_snapshots(&from["snapshot"], &to_snapshot),
                "pending": pending,
            }))
            .into_response())
        }
        .await,
        "Failed to compare baselines",
    )
}

// ── GET /{id} ───────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let row = find_baseline(&caller.db, &id)
                .await?
                .ok_or_else(|| Refusal::not_found(ITEM_LABEL, &id))?;
            if !caller
                .can_access(row["projectId"].as_str().unwrap_or_default())
                .await?
            {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            Ok(Data(present_one(&caller.db, &row).await?).into_response())
        }
        .await,
        "Failed to fetch baseline",
    )
}

// ── POST /projects/{projectId}/initial ──────────────────────────────────────

async fn sign_off(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
) -> Response {
    let checked = async {
        if find_live_project(&caller.db, &project_id).await?.is_none() {
            return Err(Refusal::not_found("Project", &project_id));
        }
        if !caller.can_manage(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_EDIT_DENIED));
        }
        Ok(())
    }
    .await;
    if let Err(refused) = checked {
        return outside(Err(refused));
    }
    reply(
        async {
            let db = &caller.db;
            if latest_baseline(db, &project_id).await?.is_some() {
                return Err(Refusal::conflict(messages::ALREADY_BASELINED));
            }
            let Some(plan) = load_plan_state(db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if baseline_is_empty(&plan) {
                return Err(Refusal::bad_request(messages::NOTHING_TO_BASELINE));
            }
            let id = generate_id("bsl");
            let row = json!({
                "id": id, "project_id": project_id, "version": 1, "change_request_id": null,
                "snapshot": build_snapshot(&plan), "created_by": caller.user_id,
                "created_at": iso_from_millis(now_ms()),
            });
            sqlx::query(
                "insert into project_baselines (id, project_id, version, change_request_id, snapshot, created_by, created_at)
                 select p.id, p.project_id, p.version, p.change_request_id, p.snapshot, p.created_by, p.created_at
                 from jsonb_populate_record(null::project_baselines, $1) p",
            )
            .bind(row)
            .execute(db)
            .await?;
            let Some(created) = find_baseline(db, &id).await? else {
                return Err(Refusal::Internal("the baseline is missing".to_owned()));
            };
            caller.publish(&state, PROJECT_BASELINE_CREATED, &id, &baseline_event_data(&created));
            Ok(Created(present_baseline(&created, None)).into_response())
        }
        .await,
        "Failed to sign off the baseline",
    )
}
