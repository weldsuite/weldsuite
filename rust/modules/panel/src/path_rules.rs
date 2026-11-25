//! `/api/panel/path-rules` (`routes/path-rules/index.ts`,
//! `services/definitions.ts`): regular expressions on the URL path and
//! their replacements (`^/users/\d+` → `/users/:id`), applied in order
//! wherever reports group or show by path.
//!
//!   GET  /        → ?projectId: the project's rules in order
//!   PUT  /        → ?projectId, `{ rules }` (≤ 30): replaces the list
//!   POST /test    → `{ rules? | projectId?, paths }`: the cleaned paths
//!
//! `panel_reports:read` to read and test; replacing needs
//! `panel_reports:update`, plus `:create` when it adds rules and `:delete`
//! when it removes some. One entity event per rule created, changed or
//! removed.

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_PATH_RULE_CREATED, PANEL_PATH_RULE_DELETED, PANEL_PATH_RULE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{PANEL_REPORTS_CREATE, PANEL_REPORTS_DELETE};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_panel_domain::schemas::{PathRule, apply_panel_path_rules};
use weldsuite_permissions::Permissions;
use weldsuite_schema::tenant::panel_path_rules::{self, Column};

use crate::saved::{PROJECT_QUERY, field, js_rows, project_exists, text};
use crate::schemas_gen::{SET_PANEL_PATH_RULES, TEST_PANEL_PATH_RULES};
use crate::{Caller, PanelState, unexpected};

/// `toPathRuleDto(r)`.
fn dto(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "position": field(row, "position"),
        "pattern": field(row, "pattern"),
        "replacement": field(row, "replacement"),
        "description": field(row, "description"),
        "createdByUserId": field(row, "createdByUserId"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `pathRuleEventData(r)`.
fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "position": field(row, "position"),
        "pattern": field(row, "pattern"),
        "replacement": field(row, "replacement"),
    })
}

fn publish(caller: &Caller, state: &PanelState, rule: &Value, event: EventName) {
    caller.publish(state, event, text(rule, "id"), &event_data(rule));
}

/// `listPathRules(db, projectId)`: in order.
async fn list_rules(db: &impl ConnectionTrait, project_id: &str) -> Result<Vec<Value>, DbErr> {
    let found = panel_path_rules::Entity::find()
        .filter(Column::ProjectId.eq(project_id))
        .order_by_asc(Column::Position)
        .order_by_asc(Column::Id)
        .all(db)
        .await?;
    js_rows(found)
}

fn list_response(rules: &[Value]) -> Response {
    let dtos: Vec<Value> = rules.iter().map(dto).collect();
    let count = dtos.len() as u64;
    List::new(dtos, Pagination::new(count, false, None)).into_response()
}

/// `GET /`.
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    match list_rules(
        &orm(&caller.db),
        query.text("projectId").unwrap_or_default(),
    )
    .await
    {
        Ok(rules) => list_response(&rules),
        Err(error) => unexpected(&error, "list path rules"),
    }
}

/// A rule's description as stored (`rule.description ?? null`).
fn description(rule: &Value) -> Option<&str> {
    rule.get("description").and_then(Value::as_str)
}

/// What a replacement did, rule by rule (`PathRulesChange`).
struct Change {
    rules: Vec<Value>,
    created: Vec<Value>,
    updated: Vec<Value>,
    deleted: Vec<Value>,
}

/// `replacePathRules`: the project's rules become `rules`, in that order, in
/// one transaction; matched by position, a changed rule keeps its id.
async fn replace(
    db: &PgPool,
    project_id: &str,
    rules: &[Value],
    existing: &[Value],
    user_id: &str,
) -> Result<Change, DbErr> {
    let mut created_ids: Vec<String> = Vec::new();
    let mut updated_ids: Vec<String> = Vec::new();
    let deleted: Vec<Value> = existing.iter().skip(rules.len()).cloned().collect();
    let tx = orm(db).begin().await?;
    for (position, rule) in rules.iter().enumerate() {
        let position_number = i32::try_from(position).unwrap_or(i32::MAX);
        let Some(before) = existing.get(position) else {
            let id = weldsuite_kit::id::generate_id("pnpr");
            panel_path_rules::Entity::insert(panel_path_rules::ActiveModel {
                id: Set(id.clone()),
                project_id: Set(project_id.to_owned()),
                position: Set(position_number),
                pattern: Set(text(rule, "pattern").to_owned()),
                replacement: Set(text(rule, "replacement").to_owned()),
                description: Set(description(rule).map(str::to_owned)),
                created_by_user_id: Set(user_id.to_owned()),
                ..Default::default()
            })
            .exec_without_returning(&tx)
            .await?;
            created_ids.push(id);
            continue;
        };
        let unchanged = text(before, "pattern") == text(rule, "pattern")
            && text(before, "replacement") == text(rule, "replacement")
            && description(before) == description(rule)
            && before.get("position").and_then(Value::as_i64) == Some(i64::from(position_number));
        if unchanged {
            continue;
        }
        panel_path_rules::Entity::update_many()
            .col_expr(Column::Position, Expr::value(position_number))
            .col_expr(Column::Pattern, Expr::value(text(rule, "pattern")))
            .col_expr(Column::Replacement, Expr::value(text(rule, "replacement")))
            .col_expr(Column::Description, Expr::value(description(rule)))
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::Id.eq(text(before, "id")))
            .filter(Column::ProjectId.eq(project_id))
            .exec(&tx)
            .await?;
        updated_ids.push(text(before, "id").to_owned());
    }
    if !deleted.is_empty() {
        panel_path_rules::Entity::delete_many()
            .filter(Column::ProjectId.eq(project_id))
            .filter(Column::Id.is_in(deleted.iter().map(|r| text(r, "id"))))
            .exec(&tx)
            .await?;
    }
    let after = list_rules(&tx, project_id).await?;
    tx.commit().await?;
    let pick = |ids: &[String]| -> Vec<Value> {
        after
            .iter()
            .filter(|r| ids.iter().any(|id| id == text(r, "id")))
            .cloned()
            .collect()
    };
    Ok(Change {
        created: pick(&created_ids),
        updated: pick(&updated_ids),
        rules: after,
        deleted,
    })
}

/// `PUT /?projectId=`.
pub(crate) async fn set(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let query = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let input = match weldsuite_zod::json(&SET_PANEL_PATH_RULES, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let project_id = query.text("projectId").unwrap_or_default().to_owned();
    match project_exists(&caller.db, &project_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "set path rules"),
    }
    let rules = input
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing = match list_rules(&orm(&caller.db), &project_id).await {
        Ok(existing) => existing,
        Err(error) => return unexpected(&error, "set path rules"),
    };
    // `planPathRules`: what the replacement creates and deletes.
    if rules.len() > existing.len() && !permissions.has_any(&[PANEL_REPORTS_CREATE]) {
        return ApiError::forbidden()
            .with_message(format!("Missing permission: {PANEL_REPORTS_CREATE}"))
            .into_response();
    }
    if existing.len() > rules.len() && !permissions.has_any(&[PANEL_REPORTS_DELETE]) {
        return ApiError::forbidden()
            .with_message(format!("Missing permission: {PANEL_REPORTS_DELETE}"))
            .into_response();
    }
    let change = match replace(&caller.db, &project_id, &rules, &existing, &caller.user_id).await {
        Ok(change) => change,
        Err(error) => return unexpected(&error, "set path rules"),
    };
    for rule in &change.created {
        publish(&caller, &state, rule, PANEL_PATH_RULE_CREATED);
    }
    for rule in &change.updated {
        publish(&caller, &state, rule, PANEL_PATH_RULE_UPDATED);
    }
    for rule in &change.deleted {
        publish(&caller, &state, rule, PANEL_PATH_RULE_DELETED);
    }
    list_response(&change.rules)
}

/// `POST /test`: rules (given, or the project's saved ones) applied to
/// sample paths, in order.
pub(crate) async fn test(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match weldsuite_zod::json(&TEST_PANEL_PATH_RULES, &headers, &body) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let rules: Vec<Value> = if let Some(rules) = input.get("rules").and_then(Value::as_array) {
        rules.clone()
    } else {
        let project_id = input.text("projectId").unwrap_or_default().to_owned();
        match project_exists(&caller.db, &project_id).await {
            Ok(true) => {}
            Ok(false) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
            Err(error) => return unexpected(&error, "test path rules"),
        }
        match list_rules(&orm(&caller.db), &project_id).await {
            Ok(rules) => rules,
            Err(error) => return unexpected(&error, "test path rules"),
        }
    };
    let rules: Vec<PathRule> = rules
        .iter()
        .map(|rule| PathRule {
            pattern: text(rule, "pattern").to_owned(),
            replacement: text(rule, "replacement").to_owned(),
        })
        .collect();
    let paths = input
        .get("paths")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let results: Vec<Value> = paths
        .iter()
        .map(|path| {
            let path = path.as_str().unwrap_or_default();
            let applied = apply_panel_path_rules(path, &rules);
            json!({ "path": path, "cleaned": applied.cleaned, "matched": applied.matched })
        })
        .collect();
    Data(json!({ "results": results })).into_response()
}
