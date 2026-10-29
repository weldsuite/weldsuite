//! `/api/mail-templates` (`routes/mail-templates/index.ts`,
//! `services/mail/templates.ts`): the workspace's email templates, their
//! categories, copies, and rendering with `{{variable}}` substitution.

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EMAIL_TEMPLATE_CREATED, EMAIL_TEMPLATE_DELETED, EMAIL_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    TEMPLATES_CREATE, TEMPLATES_DELETE, TEMPLATES_READ, TEMPLATES_UPDATE,
};
use weldsuite_core_domain::js::{Js, as_text, parse_body};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{
    MailError, MailResult, answer, list_response, now, page, strings, validate, validate_query,
};
use crate::{Caller, MailState};

const TYPES: [&str; 6] = [
    "marketing",
    "transactional",
    "notification",
    "newsletter",
    "welcome",
    "custom",
];

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([TEMPLATES_READ]);
    let create_gate = || gate.require([TEMPLATES_CREATE]);
    Router::new()
        .route("/mail-templates/categories", get(categories).route_layer(read()))
        .route("/mail-templates", get(list).route_layer(read()))
        .route("/mail-templates/{id}", get(detail).route_layer(read()))
        .route("/mail-templates", post(create).route_layer(create_gate()))
        .route(
            "/mail-templates/{id}",
            patch(update)
                .put(update)
                .route_layer(gate.require([TEMPLATES_UPDATE])),
        )
        .route(
            "/mail-templates/{id}",
            axum::routing::delete(remove).route_layer(gate.require([TEMPLATES_DELETE])),
        )
        .route(
            "/mail-templates/{id}/duplicate",
            post(duplicate).route_layer(create_gate()),
        )
        .route("/mail-templates/{id}/render", post(render).route_layer(read()))
        .with_state(state)
}

async fn template_row(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from mail_templates t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(js_row))
}

async fn row_by_id(caller: &Caller, id: &str) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar("select to_jsonb(t) from mail_templates t where t.id = $1")
        .bind(id)
        .fetch_one(&caller.db)
        .await?;
    Ok(js_row(row))
}

/// `GET /categories` (`listTemplateCategories`).
async fn categories(caller: Caller) -> Response {
    let result = async {
        let rows: Vec<Option<String>> = sqlx::query_scalar(
            "select category from mail_templates
             where deleted_at is null and category is not null group by category",
        )
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<String> = rows.into_iter().flatten().filter(|c| !c.is_empty()).collect();
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to fetch template categories")
}

/// `GET /` (`listTemplates`).
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let kind = issues.choice(q, "type", Presence::Optional, &TYPES);
        let category = issues.text(q, "category", Presence::Optional, None, None);
        // `z.coerce.boolean()`: any non-empty text is true.
        let active = q.get("isActive").map(|v| match v {
            Value::String(s) => !s.is_empty(),
            Value::Array(items) => !items.is_empty(),
            Value::Bool(b) => *b,
            _ => true,
        });
        let limit = issues.whole_number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        (
            kind.into_option(),
            category.into_option(),
            active,
            limit.into_option(),
            cursor.into_option(),
        )
    });
    let (kind, category, active, limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let limit = limit.unwrap_or(50).min(100);
        let category = category.filter(|c| !c.is_empty());
        let cursor_row: Option<(String, String)> =
            match cursor.as_deref().filter(|c| !c.is_empty()) {
                Some(cursor) => {
                    sqlx::query_as(
                        "select to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
                         from mail_templates where id = $1 limit 1",
                    )
                    .bind(cursor)
                    .fetch_optional(&caller.db)
                    .await?
                }
                None => None,
            };
        let (cursor_at, cursor_id) = cursor_row.unzip();
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from mail_templates t
             where t.deleted_at is null
               and ($1::text is null or t.type = $1::mail_template_type)
               and ($2::text is null or t.category = $2)
               and ($3::bool is null or t.is_active = $3)
               and ($4::timestamp is null or (t.created_at < $4::timestamp
                    or (t.created_at = $4::timestamp and t.id < $5)))
             order by t.created_at desc, t.id desc limit $6",
        )
        .bind(&kind)
        .bind(&category)
        .bind(active)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i32 = sqlx::query_scalar(
            "select count(*)::int from mail_templates t
             where t.deleted_at is null
               and ($1::text is null or t.type = $1::mail_template_type)
               and ($2::text is null or t.category = $2)
               and ($3::bool is null or t.is_active = $3)",
        )
        .bind(&kind)
        .bind(&category)
        .bind(active)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, i64::from(total), has_more, next))
    }
    .await;
    answer(result, "Failed to list templates")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match template_row(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(MailError::not_found("Template", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch template")
}

/// `createBody` / `updateBody`.
fn read_template(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let put = |key: &str, value: Option<Value>, out: &mut Map<String, Value>| {
        if let Some(value) = value {
            out.insert(key.into(), value);
        }
    };
    let s = |v: Option<String>| v.map(Value::String);
    put("name", s(issues.text(body, "name", required, Some(1), Some(255)).into_option()), &mut out);
    put("subject", s(issues.text(body, "subject", required, Some(1), Some(998)).into_option()), &mut out);
    put("htmlContent", s(issues.text(body, "htmlContent", required, Some(1), None).into_option()), &mut out);
    put("textContent", s(issues.text(body, "textContent", Presence::Optional, None, None).into_option()), &mut out);
    put("category", s(issues.text(body, "category", Presence::Optional, None, Some(100)).into_option()), &mut out);
    put("description", s(issues.text(body, "description", Presence::Optional, None, None).into_option()), &mut out);
    put("type", s(issues.choice(body, "type", Presence::Optional, &TYPES).into_option()), &mut out);
    put("purpose", s(issues.text(body, "purpose", Presence::Optional, None, Some(255)).into_option()), &mut out);
    let variables = issues.list(
        body,
        "variables",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let mut variable = Map::new();
            let before = issues.count();
            if let Some(name) = issues.text(fields, "name", Presence::Required, None, None).into_option() {
                variable.insert("name".into(), Value::String(name));
            }
            if let Some(kind) = issues
                .choice(fields, "type", Presence::Required, &["text", "number", "date", "boolean", "list"])
                .into_option()
            {
                variable.insert("type".into(), Value::String(kind));
            }
            if let Some(required) = issues.boolean(fields, "required", Presence::Optional).into_option() {
                variable.insert("required".into(), Value::Bool(required));
            }
            if let Some(default) = fields.get("defaultValue") {
                variable.insert("defaultValue".into(), default.clone());
            }
            if let Some(description) = issues
                .text(fields, "description", Presence::Optional, None, None)
                .into_option()
            {
                variable.insert("description".into(), Value::String(description));
            }
            (issues.count() == before).then_some(Value::Object(variable))
        },
    );
    put("variables", variables.into_option().map(Value::Array), &mut out);
    let strings_list = |issues: &mut Issues, key: &str| {
        issues
            .list(body, key, Presence::Optional, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
            .into_option()
            .map(|v| json!(v))
    };
    put("requiredVariables", strings_list(issues, "requiredVariables"), &mut out);
    put("tags", strings_list(issues, "tags"), &mut out);
    for key in ["isActive", "isDefault"] {
        put(key, issues.boolean(body, key, Presence::Optional).into_option().map(Value::Bool), &mut out);
    }
    out
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "name": row["name"], "type": row["type"] })
}

/// `POST /` (`createTemplate`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_template(issues, body, false)) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let id = generate_id("tpl");
        sqlx::query(
            "insert into mail_templates (id, name, subject, html_content, text_content, category,
               description, type, purpose, variables, required_variables, tags, is_active,
               is_default, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::mail_template_type, $9, $10, $11, $12, $13, $14,
               $15::timestamp, $15::timestamp)",
        )
        .bind(&id)
        .bind(text(&data, "name"))
        .bind(text(&data, "subject"))
        .bind(text(&data, "htmlContent"))
        .bind(text(&data, "textContent"))
        .bind(text(&data, "category"))
        .bind(text(&data, "description"))
        .bind(text(&data, "type").unwrap_or("custom"))
        .bind(text(&data, "purpose"))
        .bind(data.get("variables").cloned())
        .bind(data.get("requiredVariables").cloned())
        .bind(data.get("tags").cloned())
        .bind(flag(&data, "isActive").unwrap_or(true))
        .bind(flag(&data, "isDefault").unwrap_or(false))
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row = row_by_id(&caller, &id).await?;
        caller.publish(&state, EMAIL_TEMPLATE_CREATED, &id, &event(&row, &id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create template")
}

/// `PUT|PATCH /:id` (`updateTemplate`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_template(issues, body, true)) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if template_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Template", None));
        }
        sqlx::query(
            "update mail_templates set updated_at = $2::timestamp,
               name = coalesce($3, name), subject = coalesce($4, subject),
               html_content = coalesce($5, html_content), text_content = coalesce($6, text_content),
               category = coalesce($7, category), description = coalesce($8, description),
               type = coalesce($9::mail_template_type, type), purpose = coalesce($10, purpose),
               variables = coalesce($11, variables),
               required_variables = coalesce($12, required_variables), tags = coalesce($13, tags),
               is_active = coalesce($14, is_active), is_default = coalesce($15, is_default)
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .bind(text(&data, "name"))
        .bind(text(&data, "subject"))
        .bind(text(&data, "htmlContent"))
        .bind(text(&data, "textContent"))
        .bind(text(&data, "category"))
        .bind(text(&data, "description"))
        .bind(text(&data, "type"))
        .bind(text(&data, "purpose"))
        .bind(data.get("variables").cloned())
        .bind(data.get("requiredVariables").cloned())
        .bind(data.get("tags").cloned())
        .bind(flag(&data, "isActive"))
        .bind(flag(&data, "isDefault"))
        .execute(&caller.db)
        .await?;
        let after = row_by_id(&caller, &id).await?;
        caller.publish(&state, EMAIL_TEMPLATE_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update template")
}

/// `DELETE /:id` (`softDeleteTemplate`).
async fn remove(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = template_row(&caller, &id).await? else {
            return Err(MailError::not_found("Template", Some(&id)));
        };
        sqlx::query(
            "update mail_templates set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, EMAIL_TEMPLATE_DELETED, &id, &event(&existing, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete template")
}

/// `POST /:id/duplicate` (`duplicateTemplate`).
async fn duplicate(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if template_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Template", None));
        }
        let new_id = generate_id("tpl");
        sqlx::query(
            "insert into mail_templates (id, name, subject, html_content, text_content, category,
               description, variables, required_variables, type, purpose, tags, is_active,
               is_default, created_at, updated_at)
             select $2, name || ' (Copy)', subject, html_content, text_content, category,
               description, variables, required_variables, type, purpose, tags, is_active, false,
               $3::timestamp, $3::timestamp
             from mail_templates where id = $1",
        )
        .bind(&id)
        .bind(&new_id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row = row_by_id(&caller, &new_id).await?;
        caller.publish(&state, EMAIL_TEMPLATE_CREATED, &new_id, &event(&row, &new_id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to duplicate template")
}

static VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}").expect("the variable pattern compiles"));

/// `htmlEscape(s)`.
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `substitute(input, vars, escapeHtml)`.
fn substitute(input: &str, vars: &[(String, Js)], escape: bool) -> String {
    VARIABLE
        .replace_all(input, |caps: &regex::Captures<'_>| {
            let key = &caps[1];
            let raw = match vars.iter().find(|(k, _)| k == key).map(|(_, v)| v) {
                None | Some(Js::Null) => String::new(),
                Some(value) => as_text(value),
            };
            if escape { html_escape(&raw) } else { raw }
        })
        .into_owned()
}

/// `POST /:id/render` (`renderTemplate`): subject, HTML (escaped values) and
/// text with the variables in; the usage counter goes up.
async fn render(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    // `z.record(z.unknown())`: an object.
    let checked = validate(&headers, &body, |issues, body| {
        issues.nested(body, "variables", Presence::Required, |_, _| ());
    });
    if let Err(error) = checked {
        return error.respond("");
    }
    let vars: Vec<(String, Js)> = match parse_body(&body) {
        Js::Object(fields) => match fields.into_iter().find(|(k, _)| k == "variables") {
            Some((_, Js::Object(vars))) => vars,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let result: MailResult<Response> = async {
        let Some(template) = template_row(&caller, &id).await? else {
            return Err(MailError::not_found("Template", None));
        };
        let required = strings(&template["requiredVariables"]);
        let missing: Vec<String> = required
            .into_iter()
            .filter(|v| !vars.iter().any(|(k, _)| k == v))
            .collect();
        if !missing.is_empty() {
            return Err(MailError::api(
                ApiError::bad_request(format!(
                    "Missing required variables: {}",
                    missing.join(", ")
                ))
                .with_details(json!({ "missing": missing })),
            ));
        }
        let subject = substitute(template["subject"].as_str().unwrap_or_default(), &vars, false);
        let html = substitute(template["htmlContent"].as_str().unwrap_or_default(), &vars, true);
        let text = template["textContent"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| substitute(t, &vars, false));
        let at = now();
        sqlx::query(
            "update mail_templates set usage_count = coalesce(usage_count, 0) + 1,
               last_used_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({ "subject": subject, "htmlContent": html, "textContent": text })).into_response())
    }
    .await;
    answer(result, "Failed to render template")
}
