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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_TEMPLATE_CREATED, PROJECT_TEMPLATE_DELETED, PROJECT_TEMPLATE_INSTANTIATED,
    PROJECT_TEMPLATE_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::blueprint::{Json, blueprint_integrity_error, validate_blueprint};
use weldsuite_flow_domain::js::{contains_pattern, iso_from_millis, js_date_millis, parse_int};
use weldsuite_flow_domain::numbering::{TASK_SEQUENCE, allocate_numbers};
use weldsuite_flow_domain::project_templates::{
    CANNOT_SAVE, INVALID_BLUEPRINT, InstantiateContext, build_blueprint, instantiate_roles_error,
    needed_task_numbers, plan_instantiation, read_blueprint, resolve_copy,
};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::project_templates as templates;

use crate::closing_body::{
    Body, parse_body, read_create_template, read_from_project, read_instantiate,
    read_update_template, template_query,
};
use crate::closing_store::{PROJECT_DENIED, find_live_project};
use crate::reporting_store::instant;
use crate::templates_store::{
    detail_of, find_template, find_visible_template, load_blueprint_source, plan_statements,
    present_template, publish_planned_events, template_event_data, usage_counts,
};
use crate::{
    Caller, FlowState, Refusal, Reply, fetch_limit, json_rows, keyset_before, keyset_cursor_tz,
    outside, page, paged, reply,
};

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
fn template_filters(user_id: &str, shared: Option<bool>, search: Option<&str>) -> Condition {
    use templates::Column;
    let mut all = Condition::all().add(Column::DeletedAt.is_null()).add(
        Condition::any()
            .add(Column::Shared.eq(true))
            .add(Column::CreatedBy.eq(user_id)),
    );
    if let Some(shared) = shared {
        all = all.add(Column::Shared.eq(shared));
    }
    if let Some(search) = search {
        all = all.add(
            Condition::any()
                .add(Column::Name.ilike(search))
                .add(Column::Description.ilike(search)),
        );
    }
    all
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match template_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor_tz(
            &caller.db,
            templates::Column::Id,
            templates::Column::CreatedAt,
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
    cursor: Option<(OffsetDateTime, String)>,
) -> Reply {
    use templates::Column;
    let db = &caller.db;
    let mut found =
        templates::Entity::find().filter(template_filters(&caller.user_id, shared, search));
    if let Some(cursor) = &cursor {
        found = found.filter(keyset_before(Column::Id, Column::CreatedAt, cursor));
    }
    let rows = found
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(fetch_limit(limit)?)
        .all(&orm(db))
        .await?;
    let total = i64::try_from(
        templates::Entity::find()
            .filter(template_filters(&caller.user_id, shared, search))
            .count(&orm(db))
            .await?,
    )
    .unwrap_or(i64::MAX);
    let (rows, has_more, next) = page(json_rows(rows)?, limit);
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
) -> Result<(), DbErr> {
    let now = instant(crate::now_ms());
    templates::Entity::insert(templates::ActiveModel {
        id: Set(id.to_owned()),
        name: Set(text(input, "name").to_owned()),
        description: Set(input
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)),
        blueprint: Set(blueprint.clone()),
        source_project_id: Set(source_project_id.map(str::to_owned)),
        shared: Set(input
            .get("shared")
            .and_then(Value::as_bool)
            .unwrap_or(false)),
        created_by: Set(caller.user_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
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
    use templates::Column;
    let db = &caller.db;
    // Only the keys the body sent; `null` clears.
    let mut update = templates::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(instant(crate::now_ms())));
    for (key, column) in [("name", Column::Name), ("description", Column::Description)] {
        if let Some(value) = input.get(key) {
            update = update.col_expr(column, Expr::value(value.as_str().map(str::to_owned)));
        }
    }
    if let Some(blueprint) = input.get("blueprint") {
        let blueprint = Some(blueprint.clone()).filter(|b| !b.is_null());
        update = update.col_expr(Column::Blueprint, Expr::value(blueprint));
    }
    if let Some(shared) = input.get("shared") {
        update = update.col_expr(Column::Shared, Expr::value(shared.as_bool()));
    }
    update
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .exec(&orm(db))
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
            let now = instant(crate::now_ms());
            templates::Entity::update_many()
                .col_expr(templates::Column::DeletedAt, Expr::value(Some(now)))
                .col_expr(templates::Column::UpdatedAt, Expr::value(now))
                .filter(templates::Column::Id.eq(&id))
                .filter(templates::Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
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
        allocate_numbers(&orm(db), &TASK_SEQUENCE, needed_task_numbers(blueprint, &copy)).await?;
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
