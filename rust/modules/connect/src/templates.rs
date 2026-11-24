//! `/api/workflow-templates` (`routes/workflow-templates/index.ts`,
//! `services/workflow-templates.ts`): the gallery of built-in templates
//! (code, `catalog::templates`) and the workspace's own, "save as template"
//! and "use template".

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Select,
};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_CREATED, WORKFLOW_TEMPLATE_CREATED, WORKFLOW_TEMPLATE_DELETED,
    WORKFLOW_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::workflow_templates::{self, Column};

use crate::catalog::{template_locale, templates};
use crate::js::{array, next_cursor, page, page_limit, query_param, query_truthy};
use crate::mvp::{Issue, SEQUENCE_WORKFLOW_TAG, is_sequence_workflow, validate_workflow};
use crate::schemas::{json_list, json_tags, template_body};
use crate::sync::SyncContext;
use crate::workflows::{NewWorkflow, create_workflow, get_workflow};
use crate::{Caller, ConnectState, Refusal, internal, validate};

const BUILT_IN_READ_ONLY: &str =
    "Built-in templates cannot be changed. Use the template to make your own copy.";

const CATEGORIES: &[&str] = &[
    "sales",
    "marketing",
    "support",
    "operations",
    "finance",
    "hr",
    "development",
    "productivity",
    "communication",
    "data",
    "custom",
];

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WORKFLOW_TEMPLATES_READ]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::WORKFLOW_TEMPLATES_CREATE])),
        )
        .route("/categories", get(categories).route_layer(read()))
        .route("/{id}", get(get_one).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(gate.require([perm::WORKFLOW_TEMPLATES_UPDATE])),
        )
        .route(
            "/{id}",
            axum::routing::delete(delete)
                .route_layer(gate.require([perm::WORKFLOW_TEMPLATES_DELETE])),
        )
        .route(
            "/from-workflow/{workflow_id}",
            post(from_workflow)
                .route_layer(gate.require([perm::WORKFLOWS_READ]))
                .route_layer(gate.require([perm::WORKFLOW_TEMPLATES_CREATE])),
        )
        .route(
            "/{id}/use",
            post(use_template)
                .route_layer(gate.require([perm::WORKFLOWS_CREATE]))
                .route_layer(read()),
        )
}

fn is_built_in(id: &str) -> bool {
    id.starts_with("builtin_")
}

/// `templateProviders(steps)`.
fn providers(steps: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for step in array(Some(steps)) {
        let kind = step.get("type").and_then(Value::as_str).unwrap_or_default();
        if let Some(dot) = kind.find('.').filter(|d| *d > 0) {
            let provider = kind[..dot].to_owned();
            if !out.contains(&provider) {
                out.push(provider);
            }
        }
    }
    out
}

fn setup_issues(triggers: &Value, steps: &Value) -> Vec<Value> {
    validate_workflow(Some(triggers), Some(steps), None)
        .iter()
        .map(Issue::to_json)
        .collect()
}

fn built_in_item(template: &Value) -> Value {
    let triggers = template["triggers"].clone();
    let steps = template["steps"].clone();
    json!({
        "id": template["id"],
        "source": "builtin",
        "name": template["name"],
        "description": template["description"],
        "category": template["category"],
        "icon": template["icon"],
        "requiredIntegrations": providers(&steps),
        "setupIssues": setup_issues(&triggers, &steps),
        "triggers": triggers,
        "steps": steps,
        "usageCount": 0,
        "authorId": null,
        "createdAt": null,
        "updatedAt": null,
    })
}

fn as_array(value: &Value) -> Value {
    if value.is_array() {
        value.clone()
    } else {
        json!([])
    }
}

fn workspace_item(row: &Value) -> Value {
    let triggers = as_array(&row["triggers"]);
    let steps = as_array(&row["steps"]);
    json!({
        "id": row["id"],
        "source": "workspace",
        "name": row["name"],
        "description": row["description"],
        "category": row["category"],
        "icon": row["icon"],
        "requiredIntegrations": providers(&steps),
        "setupIssues": setup_issues(&triggers, &steps),
        "triggers": triggers,
        "steps": steps,
        "usageCount": row["usageCount"].as_i64().unwrap_or(0),
        "authorId": row["authorId"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// A `workflow_templates` row as Drizzle reads it (`numeric` as text).
fn js(model: workflow_templates::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// The list's filters: not deleted, `name` or `description` `ilike
/// %search%`, the `category` sent.
fn filtered(pattern: Option<&str>, category: Option<&str>) -> Select<workflow_templates::Entity> {
    let mut filter = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(pattern) = pattern {
        filter = filter.add(
            Condition::any()
                .add(Column::Name.ilike(pattern))
                .add(Column::Description.ilike(pattern)),
        );
    }
    if let Some(category) = category {
        filter = filter.add(Column::Category.eq(category));
    }
    workflow_templates::Entity::find().filter(filter)
}

fn matches_search(template: &Value, search: Option<&str>) -> bool {
    let Some(search) = search else { return true };
    let needle = search.to_lowercase();
    let has = |key: &str| {
        template[key]
            .as_str()
            .is_some_and(|text| text.to_lowercase().contains(&needle))
    };
    has("name") || has("description")
}

/// The built-ins in `locale`, as `resolveBuiltIn` finds one by id.
fn built_in(id: &str, locale: Option<&str>) -> Option<&'static Value> {
    templates(template_locale(locale))
        .iter()
        .find(|t| t["id"].as_str() == Some(id))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let limit = page_limit(query, 25, 100).clamp(1, 100);
    let search = query_truthy(query, "search");
    let category = query_truthy(query, "category");
    let source = query_param(query, "source");
    let locale = query_param(query, "locale");
    let cursor = query_truthy(query, "cursor");
    let built_ins: Vec<&Value> = if source.as_deref() == Some("workspace") {
        vec![]
    } else {
        templates(template_locale(locale.as_deref()))
            .iter()
            .filter(|t| {
                category
                    .as_deref()
                    .is_none_or(|c| t["category"].as_str() == Some(c))
            })
            .filter(|t| matches_search(t, search.as_deref()))
            .collect()
    };
    if source.as_deref() == Some("builtin") {
        let data: Vec<Value> = built_ins.iter().map(|t| built_in_item(t)).collect();
        let count = data.len() as u64;
        return List::new(data, Pagination::new(count, false, None)).into_response();
    }
    let pattern = search.as_ref().map(|s| format!("%{s}%"));
    let db = orm(&caller.db);
    let mut rows = filtered(pattern.as_deref(), category.as_deref());
    if let Some(cursor) = &cursor {
        rows = rows.filter(Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await;
    let count = filtered(pattern.as_deref(), category.as_deref())
        .count(&db)
        .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (rows, has_more) = page(rows.into_iter().map(js).collect(), limit);
            let next = next_cursor(&rows, has_more, "id");
            let mut data: Vec<Value> = if cursor.is_some() {
                vec![]
            } else {
                built_ins.iter().map(|t| built_in_item(t)).collect()
            };
            data.extend(rows.iter().map(workspace_item));
            let total_count = count + built_ins.len() as u64;
            List::new(data, Pagination::new(total_count, has_more, next)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow templates"),
    }
}

async fn categories(caller: Caller) -> Response {
    let rows: Result<Vec<Option<String>>, DbErr> = workflow_templates::Entity::find()
        .select_only()
        .column(Column::Category)
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to get template categories"),
    };
    let mut counts: Vec<(String, i64)> = Vec::new();
    let built_in = templates("en")
        .iter()
        .map(|t| t["category"].as_str().map(str::to_owned));
    for category in built_in.chain(rows) {
        let key = category
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "custom".into());
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 += 1,
            None => counts.push((key, 1)),
        }
    }
    let data: Vec<Value> = counts
        .into_iter()
        .map(|(id, count)| {
            let mut chars = id.chars();
            let name = match chars.next() {
                Some(first) => format!(
                    "{}{}",
                    first.to_uppercase(),
                    chars.as_str().replace('_', " ")
                ),
                None => String::new(),
            };
            json!({ "id": id, "name": name, "count": count })
        })
        .collect();
    Data(data).into_response()
}

async fn template_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = workflow_templates::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(js))
}

async fn get_one(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    if is_built_in(&id) {
        let locale = query_param(query.as_deref(), "locale");
        return match built_in(&id, locale.as_deref()) {
            Some(template) => Data(built_in_item(template)).into_response(),
            None => ApiError::not_found("Workflow template", Some(&id)).into_response(),
        };
    }
    match template_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(workspace_item(&row)).into_response(),
        Ok(None) => ApiError::not_found("Workflow template", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch workflow template"),
    }
}

fn opt(field: &Field<String>) -> Option<String> {
    field.as_set().cloned()
}

async fn create(
    State(state): State<ConnectState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| template_body(issues, b, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create workflow template"),
    };
    let id = generate_id("tmpl");
    let stamp = utc_now();
    let name = opt(&data.name).unwrap_or_default();
    let inserted = workflow_templates::Entity::insert(workflow_templates::ActiveModel {
        id: Set(id.clone()),
        name: Set(name.clone()),
        description: Set(opt(&data.description)),
        category: Set(opt(&data.category)
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "custom".into())),
        difficulty: Set(Some(
            opt(&data.difficulty)
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "beginner".into()),
        )),
        triggers: Set(Some(json_list(&data.triggers).unwrap_or_else(|| json!([])))),
        steps: Set(Some(json_list(&data.steps).unwrap_or_else(|| json!([])))),
        settings: Set(Some(
            data.settings.as_set().cloned().unwrap_or_else(|| json!({})),
        )),
        tags: Set(Some(json_tags(&data.tags).unwrap_or_else(|| json!([])))),
        icon: Set(opt(&data.icon)),
        author_id: Set(Some(caller.user_id.clone())),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await;
    if let Err(error) = inserted {
        return internal(&error, "Failed to create workflow template");
    }
    caller.publish(
        &state,
        WORKFLOW_TEMPLATE_CREATED,
        &id,
        &json!({ "id": id, "name": name }),
    );
    Created(json!({ "id": id })).into_response()
}

async fn update(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| template_body(issues, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update workflow template"),
    };
    if is_built_in(&id) {
        return ApiError::forbidden()
            .with_message(BUILT_IN_READ_ONLY)
            .into_response();
    }
    let result = async {
        if template_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow template", &id));
        }
        let text = |f: &Field<String>| (!f.is_absent(), f.as_set().cloned());
        let (name_set, name) = text(&data.name);
        let (description_set, description) = text(&data.description);
        let (category_set, category) = text(&data.category);
        let (difficulty_set, difficulty) = text(&data.difficulty);
        let (icon_set, icon) = text(&data.icon);
        let triggers = json_list(&data.triggers);
        let steps = json_list(&data.steps);
        let settings = data.settings.as_set().cloned();
        let tags = json_tags(&data.tags);
        let mut update = workflow_templates::Entity::update_many()
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
        let texts = [
            (Column::Name, name_set, name),
            (Column::Description, description_set, description),
            (Column::Category, category_set, category),
            (Column::Difficulty, difficulty_set, difficulty),
        ];
        for (column, set, value) in texts {
            if set {
                update = update.col_expr(column, Expr::value(value));
            }
        }
        let documents = [
            (Column::Triggers, triggers),
            (Column::Steps, steps),
            (Column::Settings, settings),
            (Column::Tags, tags),
        ];
        for (column, value) in documents {
            if let Some(value) = value {
                update = update.col_expr(column, Expr::value(value));
            }
        }
        if icon_set {
            update = update.col_expr(Column::Icon, Expr::value(icon));
        }
        update
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, WORKFLOW_TEMPLATE_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to update workflow template"))
}

async fn delete(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    if is_built_in(&id) {
        return ApiError::forbidden()
            .with_message(BUILT_IN_READ_ONLY)
            .into_response();
    }
    let result = async {
        if template_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Workflow template", &id));
        }
        let stamp = utc_now();
        workflow_templates::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(stamp))
            .col_expr(Column::UpdatedAt, Expr::value(stamp))
            .filter(Column::Id.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, WORKFLOW_TEMPLATE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to delete workflow template"))
}

fn trimmed(
    issues: &mut weldsuite_kit::validation::Issues,
    b: &serde_json::Map<String, Value>,
) -> Option<String> {
    issues
        .text_with(
            b,
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option()
}

async fn from_workflow(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(workflow_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, description, category) = match validate(&headers, &body, |issues, b| {
        let name = trimmed(issues, b);
        let description = issues
            .text(b, "description", Presence::Optional, None, Some(5000))
            .into_option();
        let category = issues
            .choice(b, "category", Presence::Optional, CATEGORIES)
            .into_option();
        (name, description, category)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to create template from workflow"),
    };
    let result = async {
        let Some(workflow) = get_workflow(&caller.db, &workflow_id).await? else {
            return Err(Refusal::not_found("Workflow", &workflow_id));
        };
        if is_sequence_workflow(workflow.get("tags")) {
            return Err(Refusal::bad_request(
                "CRM sequences cannot be saved as WeldConnect templates",
            ));
        }
        let id = generate_id("tmpl");
        let name = name
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| workflow["name"].as_str().unwrap_or_default().to_owned());
        let description =
            description.or_else(|| workflow["description"].as_str().map(str::to_owned));
        let or = |key: &str, fallback: Value| match &workflow[key] {
            Value::Null => fallback,
            other => other.clone(),
        };
        let stamp = utc_now();
        workflow_templates::Entity::insert(workflow_templates::ActiveModel {
            id: Set(id.clone()),
            name: Set(name.clone()),
            description: Set(description),
            category: Set(category
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "custom".into())),
            difficulty: Set(Some("beginner".to_owned())),
            triggers: Set(Some(or("triggers", json!([])))),
            steps: Set(Some(or("steps", json!([])))),
            settings: Set(Some(or("settings", json!({})))),
            tags: Set(Some(or("tags", json!([])))),
            author_id: Set(Some(caller.user_id.clone())),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        caller.publish(
            &state,
            WORKFLOW_TEMPLATE_CREATED,
            &id,
            &json!({ "id": id, "name": name, "fromWorkflow": workflow_id }),
        );
        Ok(Created(json!({ "id": id, "name": name })).into_response())
    };
    result.await.unwrap_or_else(|refusal: Refusal| {
        refusal.respond("Failed to create template from workflow")
    })
}

async fn use_template(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (name, description, locale) = match validate(&headers, &body, |issues, b| {
        let name = trimmed(issues, b);
        let description = issues
            .text(b, "description", Presence::Optional, None, Some(5000))
            .into_option();
        let locale = issues
            .text(b, "locale", Presence::Optional, None, Some(16))
            .into_option();
        (name, description, locale)
    }) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to use template"),
    };
    let result = async {
        let source = if is_built_in(&id) {
            let Some(template) = built_in(&id, locale.as_deref()) else {
                return Err(Refusal::not_found("Workflow template", &id));
            };
            (
                template["name"].as_str().unwrap_or_default().to_owned(),
                template["description"].as_str().map(str::to_owned),
                template["triggers"].clone(),
                template["steps"].clone(),
                json!({}),
                json!([]),
            )
        } else {
            let Some(row) = template_row(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Workflow template", &id));
            };
            let tags: Vec<Value> = array(row.get("tags"))
                .iter()
                .filter(|t| t.as_str() != Some(SEQUENCE_WORKFLOW_TAG))
                .cloned()
                .collect();
            (
                row["name"].as_str().unwrap_or_default().to_owned(),
                row["description"].as_str().map(str::to_owned),
                as_array(&row["triggers"]),
                as_array(&row["steps"]),
                match &row["settings"] {
                    Value::Null => json!({}),
                    other => other.clone(),
                },
                Value::Array(tags),
            )
        };
        let (source_name, source_description, triggers, steps, settings, tags) = source;
        let name = name.filter(|n| !n.is_empty()).unwrap_or(source_name);
        let ctx = SyncContext::for_caller(&caller, &state);
        let workflow_id = create_workflow(
            &caller.db,
            &ctx,
            NewWorkflow {
                name: name.clone(),
                description: description.or(source_description),
                status: "draft".into(),
                triggers,
                steps,
                settings,
                tags,
                folder_id: None,
                template_id: Some(id.clone()),
            },
            &caller.user_id,
        )
        .await?;
        if !is_built_in(&id) {
            // `usage_count = coalesce(usage_count, 0) + 1`.
            let used = sea_orm::ExprTrait::add(
                Func::coalesce([Expr::col(Column::UsageCount), Expr::val(0)]),
                1,
            );
            workflow_templates::Entity::update_many()
                .col_expr(Column::UsageCount, used)
                .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
                .filter(Column::Id.eq(&id))
                .exec(&orm(&caller.db))
                .await?;
        }
        caller.publish(
            &state,
            WORKFLOW_CREATED,
            &workflow_id,
            &json!({ "id": workflow_id, "name": name, "status": "draft" }),
        );
        Ok(Created(json!({ "id": workflow_id, "templateId": id, "name": name })).into_response())
    };
    result
        .await
        .unwrap_or_else(|refusal: Refusal| refusal.respond("Failed to use template"))
}
