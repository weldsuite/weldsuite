//! `/api/mail-rules` (`routes/mail-rules/index.ts`, `services/mail/rules.ts`):
//! a mailbox's filter rules (conditions and actions), their order, toggling
//! and copies.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EMAIL_RULE_CREATED, EMAIL_RULE_DELETED, EMAIL_RULE_DISABLED, EMAIL_RULE_ENABLED,
    EMAIL_RULE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE,
};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{MailRuleMatchType, MailRuleScope};
use weldsuite_schema::tenant::mail_rules;

use crate::routes::mail_labels::NO_ACCESS;
use crate::util::{MailError, answer, unhandled, validate, validate_query};
use crate::{Caller, MailState};

const FIELDS: [&str; 10] = [
    "from",
    "to",
    "cc",
    "subject",
    "body",
    "has_attachment",
    "size",
    "date",
    "is_spam",
    "priority",
];
const OPERATORS: [&str; 10] = [
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "starts_with",
    "ends_with",
    "greater_than",
    "less_than",
    "is_true",
    "is_false",
];
const ACTIONS: [&str; 13] = [
    "move_to_folder",
    "copy_to_folder",
    "delete",
    "mark_as_read",
    "mark_as_unread",
    "star",
    "add_label",
    "remove_label",
    "forward_to",
    "auto_reply",
    "flag",
    "archive",
    "mark_as_spam",
];

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let update_gate = || gate.require([ACCOUNTS_UPDATE]);
    let read = || gate.require([ACCOUNTS_READ]);
    let create_gate = || gate.require([ACCOUNTS_CREATE]);
    Router::new()
        .route("/mail-rules", get(list).route_layer(read()))
        .route(
            "/mail-rules/reorder",
            post(reorder).route_layer(update_gate()),
        )
        .route("/mail-rules/{id}", get(detail).route_layer(read()))
        .route("/mail-rules", post(create).route_layer(create_gate()))
        .route(
            "/mail-rules/{id}",
            patch(update).put(update).route_layer(update_gate()),
        )
        .route(
            "/mail-rules/{id}",
            axum::routing::delete(remove).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .route(
            "/mail-rules/{id}/toggle",
            post(toggle).route_layer(update_gate()),
        )
        .route(
            "/mail-rules/{id}/duplicate",
            post(duplicate).route_layer(create_gate()),
        )
        .with_state(state)
}

/// A rule row as Drizzle returns it.
fn js(rule: mail_rules::Model) -> Result<Value, DbErr> {
    serde_json::to_value(rule).map_err(|error| DbErr::Json(error.to_string()))
}

async fn rule_row(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = mail_rules::Entity::find_by_id(id.to_owned())
        .filter(mail_rules::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(js).transpose()
}

/// The rule `id`, deleted or not; a missing one is an error.
async fn model_by_id(caller: &Caller, id: &str) -> Result<mail_rules::Model, DbErr> {
    mail_rules::Entity::find_by_id(id.to_owned())
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("mail rule {id}")))
}

async fn row_by_id(caller: &Caller, id: &str) -> Result<Value, DbErr> {
    js(model_by_id(caller, id).await?)
}

/// A `matchType` the body chose (`all` or `any`).
fn match_type(kind: &str) -> Result<MailRuleMatchType, DbErr> {
    MailRuleMatchType::try_from_value(&kind.to_owned())
}

/// A `scope` the body chose.
fn scope(scope: &str) -> Result<MailRuleScope, DbErr> {
    MailRuleScope::try_from_value(&scope.to_owned())
}

fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "accountId": row["accountId"], "name": row["name"], "isActive": row["isActive"] })
}

/// `GET /` (`listRules`): one mailbox's rules, or every rule.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let account = issues.text(q, "accountId", Presence::Optional, None, None);
        // `z.coerce.boolean()`: any non-empty text is true.
        let active = q.get("isActive").map(|v| match v {
            Value::String(s) => !s.is_empty(),
            Value::Bool(b) => *b,
            _ => true,
        });
        (account.into_option(), active)
    });
    let (account, active) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = account.filter(|a| !a.is_empty());
        if let Some(account) = &account
            && !check_account_access(&caller.db, account, &caller.user_id).await?
        {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let mut find = mail_rules::Entity::find().filter(mail_rules::Column::DeletedAt.is_null());
        if let Some(account) = &account {
            find = find.filter(mail_rules::Column::AccountId.eq(account));
        }
        if let Some(active) = active {
            find = find.filter(mail_rules::Column::IsActive.eq(active));
        }
        let rows = find
            .order_by_asc(mail_rules::Column::Priority)
            .order_by_asc(mail_rules::Column::CreatedAt)
            .all(&orm(&caller.db))
            .await?;
        let rows = rows.into_iter().map(js).collect::<Result<Vec<_>, _>>()?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to list rules")
}

/// `POST /reorder` (`reorderRules`): the first priority given for an id wins.
async fn reorder(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "rules",
                Presence::Required,
                Some(1),
                Some(500),
                |issues, item| {
                    let fields = issues.object(item)?;
                    let id = issues.text(fields, "id", Presence::Required, None, None);
                    let priority = issues.whole_number(
                        fields,
                        "priority",
                        Presence::Required,
                        Number {
                            int: true,
                            ..Number::default()
                        },
                    );
                    Some((id.into_option()?, priority.into_option()?))
                },
            )
            .into_option()
            .unwrap_or_default()
    });
    let rules = match input {
        Ok(rules) => rules,
        Err(error) => return error.respond(""),
    };
    let result = async {
        // One statement: `case when id = … then … end`, the first priority
        // given for an id first (Postgres casts it to the `integer` column).
        let mut first: Vec<(String, i64)> = Vec::new();
        for (id, priority) in rules {
            if !first.iter().any(|(seen, _)| *seen == id) {
                first.push((id, priority));
            }
        }
        let Some(((head_id, head_priority), rest)) = first.split_first() else {
            return Ok(Data(json!({ "updated": 0 })).into_response());
        };
        let mut priority = Expr::case(
            mail_rules::Column::Id.eq(head_id),
            Expr::value(*head_priority),
        );
        for (id, value) in rest {
            priority = priority.case(mail_rules::Column::Id.eq(id), Expr::value(*value));
        }
        let ids = first.iter().map(|(id, _)| id.clone());
        let updated = mail_rules::Entity::update_many()
            .col_expr(
                mail_rules::Column::Priority,
                priority
                    .finally(Expr::col(mail_rules::Column::Priority))
                    .into(),
            )
            .col_expr(mail_rules::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mail_rules::Column::Id.is_in(ids))
            .filter(mail_rules::Column::DeletedAt.is_null())
            .exec(&orm(&caller.db))
            .await?;
        Ok(Data(json!({ "updated": updated.rows_affected })).into_response())
    }
    .await;
    answer(result, "Failed to reorder rules")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = rule_row(&caller, &id).await? else {
            return Err(MailError::not_found("Rule", Some(&id)));
        };
        let account = row["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch rule")
}

/// Zod's name for a value's type (`received`).
fn zod_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `z.union([z.string(), z.array(z.string())])` at `value`.
fn string_or_strings(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Value> {
    let value = fields.get("value");
    match value {
        Some(Value::String(_)) => return value.cloned(),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => return value.cloned(),
        _ => {}
    }
    let path = issues.path_of("value");
    let received = zod_type(value);
    let type_issue = |expected: &str, path: &Value| {
        let message = if received == "undefined" {
            "Required".to_owned()
        } else {
            format!("Expected {expected}, received {received}")
        };
        json!({ "code": "invalid_type", "expected": expected, "received": received, "path": path, "message": message })
    };
    let array_issues: Vec<Value> = match value {
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.is_string())
            .map(|(i, item)| {
                let mut item_path = path.as_array().cloned().unwrap_or_default();
                item_path.push(json!(i));
                let received = zod_type(Some(item));
                json!({
                    "code": "invalid_type", "expected": "string", "received": received,
                    "path": item_path, "message": format!("Expected string, received {received}"),
                })
            })
            .collect(),
        _ => vec![type_issue("array", &path)],
    };
    issues.push_issue(
        "value",
        json!({
            "code": "invalid_union",
            "unionErrors": [
                { "issues": [type_issue("string", &path)], "name": "ZodError" },
                { "issues": array_issues, "name": "ZodError" },
            ],
            "message": "Invalid input",
        }),
    );
    None
}

/// `baseBody` (create) or its `.omit({ accountId }).partial()` (update).
#[allow(clippy::too_many_lines)] // one reader per schema field, in order
fn read_rule(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> Map<String, Value> {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let mut out = Map::new();
    if create
        && let Some(v) = issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
    {
        out.insert("accountId".into(), Value::String(v));
    }
    if let Some(v) = issues
        .text(body, "name", required, Some(1), Some(255))
        .into_option()
    {
        out.insert("name".into(), Value::String(v));
    }
    if let Some(v) = issues
        .text(body, "description", Presence::Optional, None, None)
        .into_option()
    {
        out.insert("description".into(), Value::String(v));
    }
    let conditions = issues.list(
        body,
        "conditions",
        required,
        Some(1),
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let before = issues.count();
            let field = issues.choice(fields, "field", Presence::Required, &FIELDS);
            let operator = issues.choice(fields, "operator", Presence::Required, &OPERATORS);
            let value = string_or_strings(issues, fields);
            if issues.count() > before {
                return None;
            }
            Some(json!({
                "field": field.into_option(),
                "operator": operator.into_option(),
                "value": value,
            }))
        },
    );
    if let Some(v) = conditions.into_option() {
        out.insert("conditions".into(), Value::Array(v));
    }
    if let Some(v) = issues
        .choice(body, "matchType", Presence::Optional, &["all", "any"])
        .into_option()
    {
        out.insert("matchType".into(), Value::String(v));
    }
    let actions = issues.list(body, "actions", required, Some(1), None, |issues, item| {
        let fields = issues.object(item)?;
        let before = issues.count();
        let mut action = Map::new();
        if let Some(kind) = issues
            .choice(fields, "type", Presence::Required, &ACTIONS)
            .into_option()
        {
            action.insert("type".into(), Value::String(kind));
        }
        for key in ["value", "folderId", "labelId"] {
            if let Some(v) = issues
                .text(fields, key, Presence::Optional, None, None)
                .into_option()
            {
                action.insert(key.into(), Value::String(v));
            }
        }
        if let Some(v) = issues
            .text_with(
                fields,
                "email",
                Presence::Optional,
                Text {
                    format: Some(Format::Email),
                    ..Text::default()
                },
            )
            .into_option()
        {
            action.insert("email".into(), Value::String(v));
        }
        if let Some(v) = issues
            .text(fields, "templateId", Presence::Optional, None, None)
            .into_option()
        {
            action.insert("templateId".into(), Value::String(v));
        }
        (issues.count() == before).then_some(Value::Object(action))
    });
    if let Some(v) = actions.into_option() {
        out.insert("actions".into(), Value::Array(v));
    }
    for key in ["isActive", "stopProcessing"] {
        if let Some(v) = issues.boolean(body, key, Presence::Optional).into_option() {
            out.insert(key.into(), Value::Bool(v));
        }
    }
    if let Some(v) = issues
        .whole_number(
            body,
            "priority",
            Presence::Optional,
            Number {
                int: true,
                ..Number::default()
            },
        )
        .into_option()
    {
        out.insert("priority".into(), json!(v));
    }
    if let Some(v) = issues
        .boolean(body, "applyToExisting", Presence::Optional)
        .into_option()
    {
        out.insert("applyToExisting".into(), Value::Bool(v));
    }
    if let Some(v) = issues
        .choice(
            body,
            "scope",
            Presence::Optional,
            &["incoming", "outgoing", "all"],
        )
        .into_option()
    {
        out.insert("scope".into(), Value::String(v));
    }
    if let Some(v) = issues
        .list(
            body,
            "folders",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
    {
        out.insert("folders".into(), json!(v));
    }
    out
}

fn text<'a>(data: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    data.get(key).and_then(Value::as_str)
}

fn flag(data: &Map<String, Value>, key: &str) -> Option<bool> {
    data.get(key).and_then(Value::as_bool)
}

/// `POST /` (`createRule`).
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_rule(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let account = text(&data, "accountId").unwrap_or_default().to_owned();
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let id = generate_id("rule");
        // An `integer` column: what Postgres refuses ("out of range") stays
        // the route's 500.
        let priority = i32::try_from(data.get("priority").and_then(Value::as_i64).unwrap_or(0))
            .map_err(|_| DbErr::Custom("priority: integer out of range".to_owned()))?;
        let at = utc_now();
        mail_rules::Entity::insert(mail_rules::ActiveModel {
            id: Set(id.clone()),
            account_id: Set(account.clone()),
            name: Set(text(&data, "name").unwrap_or_default().to_owned()),
            description: Set(text(&data, "description").map(str::to_owned)),
            // Both required by `createBody`.
            conditions: Set(data.get("conditions").cloned().unwrap_or_default()),
            match_type: Set(match_type(text(&data, "matchType").unwrap_or("all"))?),
            actions: Set(data.get("actions").cloned().unwrap_or_default()),
            is_active: Set(flag(&data, "isActive").unwrap_or(true)),
            stop_processing: Set(Some(flag(&data, "stopProcessing").unwrap_or(false))),
            priority: Set(Some(priority)),
            apply_to_existing: Set(Some(flag(&data, "applyToExisting").unwrap_or(false))),
            scope: Set(Some(scope(text(&data, "scope").unwrap_or("incoming"))?)),
            folders: Set(data.get("folders").cloned()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        let row = row_by_id(&caller, &id).await?;
        caller.publish(&state, EMAIL_RULE_CREATED, &id, &event(&row, &id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create rule")
}

/// A live rule the caller may reach, outside the route's try/catch.
async fn reachable(caller: &Caller, id: &str) -> Result<Value, Response> {
    let row = match rule_row(caller, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Err(MailError::not_found("Rule", Some(id)).respond("")),
        Err(error) => return Err(unhandled(error.into())),
    };
    let account = row["accountId"].as_str().unwrap_or_default();
    match check_account_access(&caller.db, account, &caller.user_id).await {
        Ok(true) => Ok(row),
        Ok(false) => Err(MailError::forbidden(NO_ACCESS).respond("")),
        Err(error) => Err(unhandled(error.into())),
    }
}

/// `PUT|PATCH /:id` (`updateRule`).
async fn update(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_rule(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = reachable(&caller, &id).await {
        return response;
    }
    let result = async {
        if rule_row(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Rule", None));
        }
        write_update(&caller, &id, &data).await?;
        let after = row_by_id(&caller, &id).await?;
        caller.publish(&state, EMAIL_RULE_UPDATED, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update rule")
}

/// `updateRule`'s write: the fields the body sent, and `updatedAt`.
async fn write_update(caller: &Caller, id: &str, data: &Map<String, Value>) -> Result<(), DbErr> {
    let mut update = mail_rules::Entity::update_many()
        .col_expr(mail_rules::Column::UpdatedAt, Expr::value(utc_now()));
    for (key, column) in [
        ("name", mail_rules::Column::Name),
        ("description", mail_rules::Column::Description),
    ] {
        if let Some(value) = text(data, key) {
            update = update.col_expr(column, Expr::value(value.to_owned()));
        }
    }
    for (key, column) in [
        ("conditions", mail_rules::Column::Conditions),
        ("actions", mail_rules::Column::Actions),
        ("folders", mail_rules::Column::Folders),
    ] {
        if let Some(value) = data.get(key) {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    if let Some(kind) = text(data, "matchType") {
        update = update.col_expr(
            mail_rules::Column::MatchType,
            mail_rules::Column::MatchType.save_as(Expr::value(match_type(kind)?)),
        );
    }
    for (key, column) in [
        ("isActive", mail_rules::Column::IsActive),
        ("stopProcessing", mail_rules::Column::StopProcessing),
        ("applyToExisting", mail_rules::Column::ApplyToExisting),
    ] {
        if let Some(value) = flag(data, key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(priority) = data.get("priority").and_then(Value::as_i64) {
        update = update.col_expr(mail_rules::Column::Priority, Expr::value(priority));
    }
    if let Some(value) = text(data, "scope") {
        update = update.col_expr(
            mail_rules::Column::Scope,
            mail_rules::Column::Scope.save_as(Expr::value(scope(value)?)),
        );
    }
    update
        .filter(mail_rules::Column::Id.eq(id))
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `DELETE /:id` (`softDeleteRule`).
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = rule_row(&caller, &id).await? else {
            return Err(MailError::not_found("Rule", Some(&id)));
        };
        let account = existing["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let at = utc_now();
        mail_rules::Entity::update_many()
            .col_expr(mail_rules::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_rules::Column::UpdatedAt, Expr::value(at))
            .filter(mail_rules::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, EMAIL_RULE_DELETED, &id, &event(&existing, &id));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete rule")
}

/// `POST /:id/toggle` (`toggleRule`).
async fn toggle(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = rule_row(&caller, &id).await? else {
            return Err(MailError::not_found("Rule", Some(&id)));
        };
        let account = existing["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let next = !existing["isActive"].as_bool().unwrap_or(false);
        mail_rules::Entity::update_many()
            .col_expr(mail_rules::Column::IsActive, Expr::value(next))
            .col_expr(mail_rules::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mail_rules::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let after = row_by_id(&caller, &id).await?;
        let action = if after["isActive"].as_bool() == Some(true) {
            EMAIL_RULE_ENABLED
        } else {
            EMAIL_RULE_DISABLED
        };
        caller.publish(&state, action, &id, &event(&after, &id));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to toggle rule")
}

/// `POST /:id/duplicate` (`duplicateRule`): a disabled copy.
async fn duplicate(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = rule_row(&caller, &id).await? else {
            return Err(MailError::not_found("Rule", Some(&id)));
        };
        let account = existing["accountId"].as_str().unwrap_or_default();
        if !check_account_access(&caller.db, account, &caller.user_id).await? {
            return Err(MailError::forbidden(NO_ACCESS));
        }
        let new_id = generate_id("rule");
        // The source row as stored, copied disabled.
        let source = model_by_id(&caller, &id).await?;
        let at = utc_now();
        mail_rules::Entity::insert(mail_rules::ActiveModel {
            id: Set(new_id.clone()),
            account_id: Set(source.account_id),
            name: Set(format!("{} (Copy)", source.name)),
            description: Set(source.description),
            conditions: Set(source.conditions),
            match_type: Set(source.match_type),
            actions: Set(source.actions),
            is_active: Set(false),
            stop_processing: Set(source.stop_processing),
            priority: Set(source.priority),
            apply_to_existing: Set(Some(false)),
            scope: Set(source.scope),
            folders: Set(source.folders),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        let row = row_by_id(&caller, &new_id).await?;
        caller.publish(&state, EMAIL_RULE_CREATED, &new_id, &event(&row, &new_id));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to duplicate rule")
}
