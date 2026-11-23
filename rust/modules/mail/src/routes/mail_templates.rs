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
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    EMAIL_TEMPLATE_CREATED, EMAIL_TEMPLATE_DELETED, EMAIL_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    TEMPLATES_CREATE, TEMPLATES_DELETE, TEMPLATES_READ, TEMPLATES_UPDATE,
};
use weldsuite_core_domain::js::{Js, as_text, parse_body};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::MailTemplateType;
use weldsuite_schema::tenant::mail_templates::{self, Column};

use crate::util::{
    MailError, MailResult, answer, list_response, page, strings, validate, validate_query,
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
        .route(
            "/mail-templates/categories",
            get(categories).route_layer(read()),
        )
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
        .route(
            "/mail-templates/{id}/render",
            post(render).route_layer(read()),
        )
        .with_state(state)
}

/// A template row as the routes return it (`to_jsonb(t)`).
fn template_json(row: mail_templates::Model) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

async fn template_row(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    mail_templates::Entity::find_by_id(id)
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(template_json)
        .transpose()
}

/// The row just written, deleted or not (a missing row is the route's 500).
async fn row_by_id(caller: &Caller, id: &str) -> Result<Value, DbErr> {
    let row = mail_templates::Entity::find_by_id(id)
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail_templates {id}")))?;
    template_json(row)
}

/// A `type` from the body or query (already one of [`TYPES`]).
fn template_type(kind: &str) -> Result<MailTemplateType, DbErr> {
    MailTemplateType::try_from_value(&kind.to_owned())
}

/// `GET /categories` (`listTemplateCategories`).
async fn categories(caller: Caller) -> Response {
    let result = async {
        let rows: Vec<Option<String>> = mail_templates::Entity::find()
            .select_only()
            .column(Column::Category)
            .filter(Column::DeletedAt.is_null())
            .filter(Column::Category.is_not_null())
            .group_by(Column::Category)
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        let rows: Vec<String> = rows
            .into_iter()
            .flatten()
            .filter(|c| !c.is_empty())
            .collect();
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
        let kind = kind.as_deref().map(template_type).transpose()?;
        let mut filters = Condition::all().add(Column::DeletedAt.is_null());
        if let Some(kind) = kind {
            filters = filters.add(Column::Type.eq(kind));
        }
        if let Some(category) = category {
            filters = filters.add(Column::Category.eq(category));
        }
        if let Some(active) = active {
            filters = filters.add(Column::IsActive.eq(active));
        }
        let cursor = match cursor.as_deref().filter(|c| !c.is_empty()) {
            Some(cursor) => cursor_position(&caller, cursor).await?,
            None => None,
        };
        let mut rows = mail_templates::Entity::find().filter(filters.clone());
        if let Some((at, id)) = cursor {
            rows = rows.filter(
                Condition::any().add(Column::CreatedAt.lt(at)).add(
                    Condition::all()
                        .add(Column::CreatedAt.eq(at))
                        .add(Column::Id.lt(id)),
                ),
            );
        }
        let rows = rows
            .order_by_desc(Column::CreatedAt)
            .order_by_desc(Column::Id)
            .limit(u64::try_from(limit + 1).unwrap_or(0))
            .all(&orm(&caller.db))
            .await?;
        let total = mail_templates::Entity::find()
            .filter(filters)
            .count(&orm(&caller.db))
            .await?;
        let rows = rows
            .into_iter()
            .map(template_json)
            .collect::<Result<Vec<_>, _>>()?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, "Failed to list templates")
}

/// The cursor row's `created_at` (to the millisecond, as
/// `to_char(created_at, '…MS')` printed it) and id.
async fn cursor_position(
    caller: &Caller,
    cursor: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = mail_templates::Entity::find_by_id(cursor)
        .select_only()
        .columns([Column::CreatedAt, Column::Id])
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(row.map(|(at, id)| {
        (
            at.replace_millisecond(at.millisecond()).unwrap_or(at),
            id,
        )
    }))
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
#[allow(clippy::too_many_lines)] // one reader per schema field, in order
fn read_template(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
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
    put(
        "name",
        s(issues
            .text(body, "name", required, Some(1), Some(255))
            .into_option()),
        &mut out,
    );
    put(
        "subject",
        s(issues
            .text(body, "subject", required, Some(1), Some(998))
            .into_option()),
        &mut out,
    );
    put(
        "htmlContent",
        s(issues
            .text(body, "htmlContent", required, Some(1), None)
            .into_option()),
        &mut out,
    );
    put(
        "textContent",
        s(issues
            .text(body, "textContent", Presence::Optional, None, None)
            .into_option()),
        &mut out,
    );
    put(
        "category",
        s(issues
            .text(body, "category", Presence::Optional, None, Some(100))
            .into_option()),
        &mut out,
    );
    put(
        "description",
        s(issues
            .text(body, "description", Presence::Optional, None, None)
            .into_option()),
        &mut out,
    );
    put(
        "type",
        s(issues
            .choice(body, "type", Presence::Optional, &TYPES)
            .into_option()),
        &mut out,
    );
    put(
        "purpose",
        s(issues
            .text(body, "purpose", Presence::Optional, None, Some(255))
            .into_option()),
        &mut out,
    );
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
            if let Some(name) = issues
                .text(fields, "name", Presence::Required, None, None)
                .into_option()
            {
                variable.insert("name".into(), Value::String(name));
            }
            if let Some(kind) = issues
                .choice(
                    fields,
                    "type",
                    Presence::Required,
                    &["text", "number", "date", "boolean", "list"],
                )
                .into_option()
            {
                variable.insert("type".into(), Value::String(kind));
            }
            if let Some(required) = issues
                .boolean(fields, "required", Presence::Optional)
                .into_option()
            {
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
    put(
        "variables",
        variables.into_option().map(Value::Array),
        &mut out,
    );
    let strings_list = |issues: &mut Issues, key: &str| {
        issues
            .list(body, key, Presence::Optional, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
            .into_option()
            .map(|v| json!(v))
    };
    put(
        "requiredVariables",
        strings_list(issues, "requiredVariables"),
        &mut out,
    );
    put("tags", strings_list(issues, "tags"), &mut out);
    for key in ["isActive", "isDefault"] {
        put(
            key,
            issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::Bool),
            &mut out,
        );
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
    let data = match validate(&headers, &body, |issues, body| {
        read_template(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let id = generate_id("tpl");
        let owned = |key: &str| text(&data, key).map(str::to_owned);
        let at = utc_now();
        mail_templates::Entity::insert(mail_templates::ActiveModel {
            id: Set(id.clone()),
            name: Set(owned("name").unwrap_or_default()),
            subject: Set(owned("subject").unwrap_or_default()),
            html_content: Set(owned("htmlContent").unwrap_or_default()),
            text_content: Set(owned("textContent")),
            category: Set(owned("category")),
            description: Set(owned("description")),
            type_: Set(template_type(text(&data, "type").unwrap_or("custom"))?),
            purpose: Set(owned("purpose")),
            variables: Set(data.get("variables").cloned()),
            required_variables: Set(data.get("requiredVariables").cloned()),
            tags: Set(data.get("tags").cloned()),
            is_active: Set(flag(&data, "isActive").unwrap_or(true)),
            is_default: Set(Some(flag(&data, "isDefault").unwrap_or(false))),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
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
    let data = match validate(&headers, &body, |issues, body| {
        read_template(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if template_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Template", None));
        }
        update_template(&caller, &id, &data).await?;
        let after = row_by_id(&caller, &id).await?;
        caller.publish(&state, EMAIL_TEMPLATE_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update template")
}

/// `updateTemplate`'s write: `updated_at`, and each field the body sent.
async fn update_template(caller: &Caller, id: &str, data: &Map<String, Value>) -> Result<(), DbErr> {
    let mut update = mail_templates::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()));
    for (key, column) in [
        ("name", Column::Name),
        ("subject", Column::Subject),
        ("htmlContent", Column::HtmlContent),
        ("textContent", Column::TextContent),
        ("category", Column::Category),
        ("description", Column::Description),
        ("purpose", Column::Purpose),
    ] {
        if let Some(value) = text(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(kind) = text(data, "type") {
        // The value as the `mail_template_type` enum.
        update = update.col_expr(
            Column::Type,
            Column::Type.save_as(Expr::val(template_type(kind)?)),
        );
    }
    for (key, column) in [
        ("variables", Column::Variables),
        ("requiredVariables", Column::RequiredVariables),
        ("tags", Column::Tags),
    ] {
        if let Some(value) = data.get(key) {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    for (key, column) in [
        ("isActive", Column::IsActive),
        ("isDefault", Column::IsDefault),
    ] {
        if let Some(value) = flag(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    update
        .filter(Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `DELETE /:id` (`softDeleteTemplate`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = template_row(&caller, &id).await? else {
            return Err(MailError::not_found("Template", Some(&id)));
        };
        let at = utc_now();
        mail_templates::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, EMAIL_TEMPLATE_DELETED, &id, &event(&existing, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete template")
}

/// `POST /:id/duplicate` (`duplicateTemplate`).
async fn duplicate(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        if template_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Template", None));
        }
        let new_id = generate_id("tpl");
        copy_template(&caller, &id, &new_id).await?;
        let row = row_by_id(&caller, &new_id).await?;
        caller.publish(
            &state,
            EMAIL_TEMPLATE_CREATED,
            &new_id,
            &event(&row, &new_id),
        );
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to duplicate template")
}

/// `insert … select` from the template: its copy, named `<name> (Copy)`,
/// never the default.
async fn copy_template(caller: &Caller, id: &str, new_id: &str) -> Result<(), DbErr> {
    let at = utc_now();
    let copied = [
        Column::Subject,
        Column::HtmlContent,
        Column::TextContent,
        Column::Category,
        Column::Description,
        Column::Variables,
        Column::RequiredVariables,
        Column::Type,
        Column::Purpose,
        Column::Tags,
        Column::IsActive,
    ];
    let source = Query::select()
        .expr(Expr::val(new_id))
        .expr(sea_orm::sea_query::extension::postgres::PgExpr::concat(
            Expr::col(Column::Name),
            Expr::val(" (Copy)"),
        ))
        .columns(copied)
        .expr(Expr::val(false))
        .expr(Expr::val(at))
        .expr(Expr::val(at))
        .from(mail_templates::Entity)
        .and_where(Column::Id.eq(id))
        .to_owned();
    let insert = Query::insert()
        .into_table(mail_templates::Entity)
        .columns(
            [Column::Id, Column::Name]
                .into_iter()
                .chain(copied)
                .chain([Column::IsDefault, Column::CreatedAt, Column::UpdatedAt]),
        )
        .select_from(source)
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .to_owned();
    orm(&caller.db).execute(&insert).await?;
    Ok(())
}

static VARIABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}").expect("the variable pattern compiles")
});

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
async fn render(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
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
        let subject = substitute(
            template["subject"].as_str().unwrap_or_default(),
            &vars,
            false,
        );
        let html = substitute(
            template["htmlContent"].as_str().unwrap_or_default(),
            &vars,
            true,
        );
        let text = template["textContent"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(|t| substitute(t, &vars, false));
        let at = utc_now();
        mail_templates::Entity::update_many()
            .col_expr(
                Column::UsageCount,
                sea_orm::ExprTrait::add(
                    Expr::from(Func::coalesce([
                        Expr::col(Column::UsageCount),
                        Expr::val(0),
                    ])),
                    1,
                ),
            )
            .col_expr(Column::LastUsedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(
            Data(json!({ "subject": subject, "htmlContent": html, "textContent": text }))
                .into_response(),
        )
    }
    .await;
    answer(result, "Failed to render template")
}
