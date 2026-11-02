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
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    WORKFLOW_CREATED, WORKFLOW_TEMPLATE_CREATED, WORKFLOW_TEMPLATE_DELETED,
    WORKFLOW_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::catalog::{template_locale, templates};
use crate::js::{array, next_cursor, page, page_limit, query_param, query_truthy, total};
use crate::mvp::{Issue, SEQUENCE_WORKFLOW_TAG, is_sequence_workflow, validate_workflow};
use crate::schemas::{json_list, json_tags, template_body};
use crate::sync::SyncContext;
use crate::workflows::{NewWorkflow, create_workflow, get_workflow};
use crate::{Caller, ConnectState, Refusal, internal, now, validate};

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
const ROW: &str = "to_jsonb(t) || jsonb_build_object('rating', t.rating::text)";

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
    const FILTER: &str = "t.deleted_at is null
        and ($1::text is null or (t.name ilike $1 or t.description ilike $1))
        and ($2::text is null or t.category = $2)";
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {ROW} from workflow_templates t where {FILTER} and ($3::text is null or t.id < $3)
         order by t.id desc limit $4"
    )))
    .bind(&pattern)
    .bind(&category)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select count(*) from workflow_templates t where {FILTER}"
    )))
    .bind(&pattern)
    .bind(&category)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (rows, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
            let next = next_cursor(&rows, has_more, "id");
            let mut data: Vec<Value> = if cursor.is_some() {
                vec![]
            } else {
                built_ins.iter().map(|t| built_in_item(t)).collect()
            };
            data.extend(rows.iter().map(workspace_item));
            let total_count = total(count) + built_ins.len() as u64;
            List::new(data, Pagination::new(total_count, has_more, next)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list workflow templates"),
    }
}

async fn categories(caller: Caller) -> Response {
    let rows: Result<Vec<Option<String>>, sqlx::Error> =
        sqlx::query_scalar("select category from workflow_templates where deleted_at is null")
            .fetch_all(&caller.db)
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

async fn template_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "select {ROW} from workflow_templates t where t.id = $1 and t.deleted_at is null limit 1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
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
    let stamp = now();
    let name = opt(&data.name).unwrap_or_default();
    let inserted = sqlx::query(
        "insert into workflow_templates
            (id, name, description, category, difficulty, triggers, steps, settings, tags, icon,
             author_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamp, $12::timestamp)",
    )
    .bind(&id)
    .bind(&name)
    .bind(opt(&data.description))
    .bind(
        opt(&data.category)
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "custom".into()),
    )
    .bind(
        opt(&data.difficulty)
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "beginner".into()),
    )
    .bind(json_list(&data.triggers).unwrap_or_else(|| json!([])))
    .bind(json_list(&data.steps).unwrap_or_else(|| json!([])))
    .bind(data.settings.as_set().cloned().unwrap_or_else(|| json!({})))
    .bind(json_tags(&data.tags).unwrap_or_else(|| json!([])))
    .bind(opt(&data.icon))
    .bind(&caller.user_id)
    .bind(&stamp)
    .execute(&caller.db)
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
        sqlx::query(
            "update workflow_templates set updated_at = $2::timestamp,
                name = case when $3 then $4 else name end,
                description = case when $5 then $6 else description end,
                category = case when $7 then $8 else category end,
                difficulty = case when $9 then $10 else difficulty end,
                triggers = case when $11 then $12 else triggers end,
                steps = case when $13 then $14 else steps end,
                settings = case when $15 then $16 else settings end,
                tags = case when $17 then $18 else tags end,
                icon = case when $19 then $20 else icon end
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(name_set)
        .bind(name)
        .bind(description_set)
        .bind(description)
        .bind(category_set)
        .bind(category)
        .bind(difficulty_set)
        .bind(difficulty)
        .bind(triggers.is_some())
        .bind(&triggers)
        .bind(steps.is_some())
        .bind(&steps)
        .bind(settings.is_some())
        .bind(&settings)
        .bind(tags.is_some())
        .bind(&tags)
        .bind(icon_set)
        .bind(icon)
        .execute(&caller.db)
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
        let stamp = now();
        sqlx::query(
            "update workflow_templates set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
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
        sqlx::query(
            "insert into workflow_templates
                (id, name, description, category, difficulty, triggers, steps, settings, tags,
                 author_id, created_at, updated_at)
             values ($1, $2, $3, $4, 'beginner', $5, $6, $7, $8, $9, $10::timestamp, $10::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&description)
        .bind(category.filter(|c| !c.is_empty()).unwrap_or_else(|| "custom".into()))
        .bind(or("triggers", json!([])))
        .bind(or("steps", json!([])))
        .bind(or("settings", json!({})))
        .bind(or("tags", json!([])))
        .bind(&caller.user_id)
        .bind(now())
        .execute(&caller.db)
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
            sqlx::query(
                "update workflow_templates set usage_count = coalesce(usage_count, 0) + 1,
                    updated_at = $2::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
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
