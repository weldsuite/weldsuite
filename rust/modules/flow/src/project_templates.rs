//! `/api/project-templates` (`routes/project-templates/index.ts`): project
//! templates in `project_templates` (design:
//! weldflow-delivery-and-portfolio.md, "Create from a template"; ADR FLOW-021).
//!
//! ```text
//! GET    /                         the templates this person may use (shared, or their own)
//! GET    /:id                      one template with its blueprint
//! POST   /                         a template from a blueprint in the body
//! PATCH  /:id                      edit
//! DELETE /:id                      soft delete
//! POST   /from-project/:projectId  "Save as template": a blueprint built from a project
//! POST   /:id/instantiate          "Create project": the whole project in one batch
//! ```
//!
//! The checks run in TypeScript's order: permission, then the template (404),
//! then project access (403), then the body (400), then the rules.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_TEMPLATE_CREATED, PROJECT_TEMPLATE_DELETED, PROJECT_TEMPLATE_INSTANTIATED,
    PROJECT_TEMPLATE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::blueprint::{Json, blueprint_integrity_error, validate_blueprint};
use weldsuite_flow_domain::js::{contains_pattern, iso_from_millis, js_date_millis, parse_int};
use weldsuite_flow_domain::numbering::{TASK_SEQUENCE, allocate_numbers};
use weldsuite_flow_domain::project_templates::{
    CANNOT_SAVE, INVALID_BLUEPRINT, InstantiateContext, build_blueprint, instantiate_roles_error,
    needed_task_numbers, plan_instantiation, read_blueprint, resolve_copy,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::closing_body::{
    Body, parse_body, read_create_template, read_from_project, read_instantiate,
    read_update_template, template_query,
};
use crate::closing_store::{PROJECT_DENIED, find_live_project};
use crate::templates_store::{
    detail_of, find_template, find_visible_template, load_blueprint_source, plan_statements,
    present_template, publish_planned_events, template_event_data, usage_counts,
};
use crate::{Caller, FlowState, Refusal, Reply, keyset_cursor, outside, page, paged, reply};

const TEMPLATE_LABEL: &str = "Template";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    // `requirePermission('projects:create', 'project_templates:manage')`: any of the two.
    let use_templates = || gate.require(["projects:create", "project_templates:manage"]);
    Router::new()
        .route("/", get(list).route_layer(use_templates()))
        .route(
            "/",
            post(create).route_layer(need("project_templates:manage")),
        )
        .route(
            "/from-project/{projectId}",
            post(from_project).route_layer(need("project_templates:manage")),
        )
        .route("/{id}", get(detail).route_layer(use_templates()))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("project_templates:manage")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("project_templates:manage")),
        )
        .route(
            "/{id}/instantiate",
            post(instantiate).route_layer(need("projects:create")),
        )
        .with_state(state)
}

fn text<'a>(body: &'a Body, key: &str) -> &'a str {
    body.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `parseLimit(raw, fallback, max)`.
fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

fn publish_template(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    caller.publish(
        state,
        event,
        row.text("id").unwrap_or_default(),
        &template_event_data(row),
    );
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// The list's `where`, without the cursor: not deleted, shared or the caller's own, the filters.
macro_rules! template_filters {
    () => {
        concat!(
            "t.deleted_at is null and (t.shared = true or t.created_by = $1)",
            " and ($2::bool is null or t.shared = $2)",
            " and ($3::text is null or t.name ilike $3 or t.description ilike $3)"
        )
    };
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match template_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_templates where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    let limit = parse_limit(q.limit.as_deref(), 50, 100);
    let search = q.search.as_deref().map(contains_pattern);
    reply(
        list_templates(&caller, q.shared, search.as_deref(), limit, cursor).await,
        "Failed to list templates",
    )
}

async fn list_templates(
    caller: &Caller,
    shared: Option<bool>,
    search: Option<&str>,
    limit: i64,
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(t) from project_templates t where ",
        template_filters!(),
        " and ($4::timestamptz is null or t.created_at < $4::timestamptz",
        " or (t.created_at = $4::timestamptz and t.id < $5))",
        " order by t.created_at desc, t.id desc limit $6"
    ))
    .bind(&caller.user_id)
    .bind(shared)
    .bind(search)
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_templates t where ",
        template_filters!()
    ))
    .bind(&caller.user_id)
    .bind(shared)
    .bind(search)
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
    let ids: Vec<String> = rows
        .iter()
        .map(|row| row.text("id").unwrap_or_default().to_owned())
        .collect();
    let usage = usage_counts(db, &ids).await?;
    let templates = rows
        .iter()
        .zip(&ids)
        .map(|(row, id)| present_template(row, usage.get(id).copied().unwrap_or(0)))
        .collect();
    Ok(paged(templates, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(row) = find_visible_template(&caller.db, &id, &caller.user_id).await? else {
                return Err(Refusal::not_found(TEMPLATE_LABEL, &id));
            };
            let Some(detail) = detail_of(&caller.db, &row).await? else {
                return Err(Refusal::conflict(INVALID_BLUEPRINT));
            };
            Ok(Data(detail).into_response())
        }
        .await,
        "Failed to fetch template",
    )
}

// ── POST /from-project/:projectId ───────────────────────────────────────────

async fn from_project(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(project) = find_live_project(&caller.db, &project_id).await? else {
            return Err(Refusal::not_found("Project", &project_id));
        };
        if !caller.can_access(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        let input = parse_body(&body, read_from_project)?;
        Ok((project, input))
    }
    .await;
    let (project, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        save_template(&state, &caller, &project, &input).await,
        "Failed to save the template",
    )
}

async fn save_template(state: &FlowState, caller: &Caller, project: &Value, input: &Body) -> Reply {
    let db = &caller.db;
    let labels: HashMap<String, String> = input
        .get("roleLabels")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect();
    let blueprint = build_blueprint(&load_blueprint_source(db, project).await?, &labels);
    // What the builder made has to be something the schema and the rules accept, or it could never be used.
    let valid =
        validate_blueprint(&blueprint).is_some_and(|b| blueprint_integrity_error(&b).is_none());
    if !valid {
        return Err(Refusal::bad_request(CANNOT_SAVE));
    }
    let id = generate_id("tpl");
    insert_template(caller, &id, input, &blueprint, project.text("id")).await?;
    let Some(row) = find_template(db, &id, false).await? else {
        return Err(Refusal::Internal("the new template is missing".to_owned()));
    };
    publish_template(state, caller, PROJECT_TEMPLATE_CREATED, &row);
    let Some(detail) = detail_of(db, &row).await? else {
        return Err(Refusal::Internal(
            "the new template is not valid".to_owned(),
        ));
    };
    Ok(Created(detail).into_response())
}

async fn insert_template(
    caller: &Caller,
    id: &str,
    input: &Body,
    blueprint: &Value,
    source_project_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into project_templates (id, name, description, blueprint, source_project_id,
             shared, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz)",
    )
    .bind(id)
    .bind(text(input, "name"))
    .bind(input.get("description").and_then(Value::as_str))
    .bind(blueprint)
    .bind(source_project_id)
    .bind(
        input
            .get("shared")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
    .bind(&caller.user_id)
    .bind(crate::now())
    .execute(&caller.db)
    .await?;
    Ok(())
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = (|| -> Result<Body, Refusal> {
        let input = parse_body(&body, read_create_template)?;
        if let Some(broken) =
            blueprint_integrity_error(input.get("blueprint").unwrap_or(&Value::Null))
        {
            return Err(Refusal::bad_request(broken));
        }
        Ok(input)
    })();
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        async {
            let id = generate_id("tpl");
            let blueprint = input.get("blueprint").cloned().unwrap_or(Value::Null);
            insert_template(&caller, &id, &input, &blueprint, None).await?;
            let Some(row) = find_template(&caller.db, &id, false).await? else {
                return Err(Refusal::Internal("the new template is missing".to_owned()));
            };
            publish_template(&state, &caller, PROJECT_TEMPLATE_CREATED, &row);
            let Some(detail) = detail_of(&caller.db, &row).await? else {
                return Err(Refusal::Internal(
                    "the new template is not valid".to_owned(),
                ));
            };
            Ok(Created(detail).into_response())
        }
        .await,
        "Failed to create template",
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        if find_visible_template(&caller.db, &id, &caller.user_id)
            .await?
            .is_none()
        {
            return Err(Refusal::not_found(TEMPLATE_LABEL, &id));
        }
        let input = parse_body(&body, read_update_template)?;
        if let Some(blueprint) = input.get("blueprint")
            && let Some(broken) = blueprint_integrity_error(blueprint)
        {
            return Err(Refusal::bad_request(broken));
        }
        Ok(input)
    }
    .await;
    let input = match checked {
        Ok(input) => input,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_template(&state, &caller, &id, &input).await,
        "Failed to update template",
    )
}

async fn update_template(state: &FlowState, caller: &Caller, id: &str, input: &Body) -> Reply {
    let db = &caller.db;
    sqlx::query(concat!(
        "update project_templates set updated_at = $2::timestamptz, ",
        set_text!("name", "name"),
        ", ",
        set_text!("description", "description"),
        ", ",
        set_json!("blueprint", "blueprint"),
        ", ",
        set_bool!("shared", "shared"),
        " where id = $3 and deleted_at is null"
    ))
    .bind(Value::Object(input.clone()))
    .bind(crate::now())
    .bind(id)
    .execute(db)
    .await?;
    let Some(row) = find_template(db, id, false).await? else {
        return Err(Refusal::not_found(TEMPLATE_LABEL, id));
    };
    publish_template(state, caller, PROJECT_TEMPLATE_UPDATED, &row);
    let Some(detail) = detail_of(db, &row).await? else {
        return Err(Refusal::conflict(INVALID_BLUEPRINT));
    };
    Ok(Data(detail).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(existing) = find_visible_template(&caller.db, &id, &caller.user_id).await?
            else {
                return Err(Refusal::not_found(TEMPLATE_LABEL, &id));
            };
            sqlx::query(
                "update project_templates
                 set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(crate::now())
            .execute(&caller.db)
            .await?;
            publish_template(&state, &caller, PROJECT_TEMPLATE_DELETED, &existing);
            Ok(NoContent.into_response())
        }
        .await,
        "Failed to delete template",
    )
}

// ── POST /:id/instantiate ───────────────────────────────────────────────────

async fn instantiate(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let Some(template) = find_visible_template(&caller.db, &id, &caller.user_id).await? else {
            return Err(Refusal::not_found(TEMPLATE_LABEL, &id));
        };
        let input = parse_body(&body, read_instantiate)?;
        let blueprint = read_blueprint(template.at("blueprint")).map_err(Refusal::conflict)?;
        let empty = Map::new();
        let roles = input
            .get("roles")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        if let Some(message) = instantiate_roles_error(&blueprint, roles) {
            return Err(Refusal::bad_request(message));
        }
        Ok((template, input, blueprint))
    }
    .await;
    let (template, input, blueprint) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_project(&state, &caller, &template, &input, &blueprint).await,
        "Failed to create the project",
    )
}

async fn create_project(
    state: &FlowState,
    caller: &Caller,
    template: &Value,
    input: &Body,
    blueprint: &Value,
) -> Reply {
    let db: &PgPool = &caller.db;
    let now_ms = crate::now_ms();
    let copy = resolve_copy(input.get("copy"));
    // The only counter every project shares: its numbers are allocated up front, in one step.
    let task_numbers =
        allocate_numbers(db, &TASK_SEQUENCE, needed_task_numbers(blueprint, &copy)).await?;
    let start_ms = js_date_millis(&format!("{}T00:00:00.000Z", text(input, "startDate")))
        .ok_or_else(|| Refusal::Internal("the start date does not parse".to_owned()))?;
    let roles: HashMap<String, String> = input
        .get("roles")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(role, person)| Some((role.clone(), person.as_str()?.to_owned())))
        .collect();
    let plan = plan_instantiation(
        blueprint,
        &InstantiateContext {
            project_id: generate_id("prj"),
            user_id: caller.user_id.clone(),
            now_ms,
            name: text(input, "name").to_owned(),
            start_ms,
            client_id: input
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            roles,
            copy,
            template_id: template.text("id").unwrap_or_default().to_owned(),
            new_id: &|prefix| generate_id(prefix),
            task_numbers,
        },
    );
    weldsuite_db::atomically(db, plan_statements(&plan)).await?;

    // A project made with a report schedule is drafted from the next tick on, like one
    // whose schedule was set through PUT /api/project-status-reports/settings/:projectId.
    if plan
        .project
        .at("settings")
        .get("statusReport")
        .is_some_and(|report| !report.is_null())
        && let Some(master) = caller.master(state)
    {
        weldsuite_db::due_index::mark_due(
            &master,
            "status_report_due",
            &caller.workspace_id,
            OffsetDateTime::now_utc(),
        )
        .await;
    }

    publish_planned_events(state, caller, &plan).await?;
    let mut data = crate::templates_store::template_event_data(template);
    data["projectId"] = json!(plan.project_id);
    caller.publish(
        state,
        PROJECT_TEMPLATE_INSTANTIATED,
        template.text("id").unwrap_or_default(),
        &data,
    );
    Ok(Created(json!({
        "project": {
            "id": plan.project_id,
            "name": text(input, "name"),
            "startDate": iso_from_millis(start_ms),
            "endDate": iso_from_millis(plan.end_ms),
            "projectManagerId": plan.project.at("projectManagerId"),
        },
        "counts": plan.counts,
    }))
    .into_response())
}
