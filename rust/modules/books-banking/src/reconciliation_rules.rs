//! `/api/reconciliation-rules` (`routes/reconciliation-rules/index.ts`):
//! entity-scoped rule CRUD (match mode, field/operator/value conditions,
//! actions, priority). Every mutation is written to the accounting audit
//! log.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::tables::RECONCILIATION_RULES;
use weldsuite_catalogs::entity_events::{
    RECONCILIATION_RULE_CREATED, RECONCILIATION_RULE_DELETED, RECONCILIATION_RULE_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, string_or_number_issue};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::text;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route("/", post(create).route_layer(need("banking:create")))
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route("/{id}", put(update).route_layer(need("banking:update")))
        .route("/{id}", patch(update).route_layer(need("banking:update")))
        .route("/{id}", delete(remove).route_layer(need("banking:delete")))
        .with_state(state)
}

const FIELDS: [&str; 5] = [
    "description",
    "counterpartyName",
    "counterpartyIban",
    "amount",
    "reference",
];
const OPERATORS: [&str; 7] = [
    "contains",
    "equals",
    "starts_with",
    "ends_with",
    "greater_than",
    "less_than",
    "between",
];

/// `createRuleSchema`, `.partial()` when `partial`: the parsed body in the
/// schema's order (unknown keys stripped, nested ones too).
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut unions: Vec<Value> = Vec::new();
    let out = read_fields(issues, body, partial, &mut unions);
    // A failed union settles after the synchronous checks.
    let failed = !unions.is_empty();
    for issue in unions {
        issues.push_raw(issue);
    }
    if failed { Map::new() } else { out }
}

fn read_fields(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
    unions: &mut Vec<Value>,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    if let Field::Set(name) = issues.text(body, "name", required, Some(1), Some(255)) {
        out.insert("name".to_owned(), Value::String(name));
    }
    if issues
        .number(body, "priority", Presence::Optional, Number::default())
        .as_set()
        .is_some()
        && let Some(priority) = body.get("priority")
    {
        out.insert("priority".to_owned(), priority.clone());
    }
    if let Field::Set(mode) = issues.choice(body, "matchMode", Presence::Optional, &["all", "any"])
    {
        out.insert("matchMode".to_owned(), Value::String(mode));
    }
    let conditions = issues.list(body, "conditions", required, None, None, |issues, item| {
        let fields = issues.object(item)?;
        let start = issues.count();
        let mut condition = Map::new();
        if let Field::Set(field) = issues.choice(fields, "field", Presence::Required, &FIELDS) {
            condition.insert("field".to_owned(), Value::String(field));
        }
        if let Field::Set(operator) =
            issues.choice(fields, "operator", Presence::Required, &OPERATORS)
        {
            condition.insert("operator".to_owned(), Value::String(operator));
        }
        match fields.get("value") {
            Some(value @ (Value::String(_) | Value::Number(_))) => {
                condition.insert("value".to_owned(), value.clone());
            }
            value => unions.push(string_or_number_issue(&issues.path_of("value"), value)),
        }
        if issues
            .number(fields, "value2", Presence::Optional, Number::default())
            .as_set()
            .is_some()
            && let Some(value2) = fields.get("value2")
        {
            condition.insert("value2".to_owned(), value2.clone());
        }
        (issues.count() == start).then_some(Value::Object(condition))
    });
    if let Field::Set(conditions) = conditions {
        out.insert("conditions".to_owned(), Value::Array(conditions));
    }
    let actions = issues.nested(body, "actions", required, |issues, fields| {
        let mut actions = Map::new();
        for key in ["categoryAccountId", "taxRateId", "contactId", "description"] {
            if let Field::Set(value) = issues.text(fields, key, Presence::Optional, None, None) {
                actions.insert(key.to_owned(), Value::String(value));
            }
        }
        Value::Object(actions)
    });
    if let Field::Set(actions) = actions {
        out.insert("actions".to_owned(), actions);
    }
    out
}

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    RECONCILIATION_RULES.find_live(&caller.db, id).await
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(reconciliation_rules),
            " from reconciliation_rules t where t.deleted_at is null and t.entity_id = $1 \
             order by t.priority desc"
        ))
        .bind(&entity_id)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(RECONCILIATION_RULES.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch rules")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Rule", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch rule")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create rule"),
    };
    reply(
        create_rule(&caller, &state, data).await,
        "Failed to create rule",
    )
}

async fn create_rule(caller: &Caller, state: &BooksState, data: Map<String, Value>) -> Reply {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let stamp = now();
    let id = generate_id("rr");
    // `{ id, entityId, ...data, isActive, matchCount, createdBy, createdAt, updatedAt }`
    let mut rule = Map::new();
    rule.insert("id".to_owned(), json!(id));
    rule.insert("entityId".to_owned(), json!(entity_id));
    rule.extend(data);
    rule.insert("isActive".to_owned(), json!(true));
    rule.insert("matchCount".to_owned(), json!(0));
    rule.insert("createdBy".to_owned(), json!(caller.user_id));
    rule.insert("createdAt".to_owned(), json!(stamp));
    rule.insert("updatedAt".to_owned(), json!(stamp));
    RECONCILIATION_RULES
        .insert_raw(&caller.db, RECONCILIATION_RULES.values(&rule))
        .await?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "reconciliation_rule",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    let rule = Value::Object(rule);
    caller.publish(state, RECONCILIATION_RULE_CREATED, &id, rule.clone());
    Ok(created(rule))
}

// ── PUT|PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update rule"),
    };
    let result = async {
        let Some(rule) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Rule", &id));
        };
        let mut values = RECONCILIATION_RULES.values(&data);
        RECONCILIATION_RULES.set(&mut values, "updatedAt", json!(now()));
        RECONCILIATION_RULES
            .patch_raw(&caller.db, &id, values, false)
            .await?;
        let changes: Map<String, Value> = data
            .iter()
            .map(|(key, value)| {
                let old = rule.get(key).cloned().unwrap_or(Value::Null);
                (key.clone(), change(old, value.clone()))
            })
            .collect();
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&rule, "entityId"),
                entity_type: "reconciliation_rule",
                entity_id: &id,
                action: "updated",
                changes: Some(changes),
            },
        )
        .await;
        let mut merged = rule.as_object().cloned().unwrap_or_default();
        merged.extend(data);
        let merged = Value::Object(merged);
        caller.publish(&state, RECONCILIATION_RULE_UPDATED, &id, merged.clone());
        Ok(ok(merged))
    }
    .await;
    reply(result, "Failed to update rule")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(rule) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Rule", &id));
        };
        let stamp = now();
        sqlx::query(
            "update reconciliation_rules set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&rule, "entityId"),
                entity_type: "reconciliation_rule",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, RECONCILIATION_RULE_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete rule")
}
