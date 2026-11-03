//! `/api/invoice-templates` (`routes/invoice-templates/index.ts`,
//! `services/invoice-templates.ts`): the invoice designer's stored layouts.
//! At most one default per entity (the first template becomes it; making
//! one the default unsets the others in the same write); deleting a
//! template detaches it from invoices and promotes nothing.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::{entity_exists, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::js::slice_utf16;
use weldsuite_books_domain::tables::INVOICE_TEMPLATES;
use weldsuite_catalogs::entity_events::{
    INVOICE_TEMPLATE_CREATED, INVOICE_TEMPLATE_DELETED, INVOICE_TEMPLATE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::template_schema::{read_create, read_update};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("invoices:read")))
        .route("/", post(create).route_layer(need("accounts:create")))
        .route("/{id}", get(detail).route_layer(need("invoices:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("accounts:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("accounts:delete")),
        )
        .route(
            "/{id}/duplicate",
            post(duplicate).route_layer(need("accounts:create")),
        )
        .with_state(state)
}

/// `findInvoiceTemplate(db, id)`.
pub(crate) async fn find_template(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoice_templates),
        " from invoice_templates t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| INVOICE_TEMPLATES.js(r)))
}

/// `templateBelongsToEntity(db, templateId, entityId)`.
pub(crate) async fn template_belongs_to_entity(
    db: &PgPool,
    template_id: &str,
    entity_id: &str,
) -> Result<bool, sqlx::Error> {
    let found: Option<String> = sqlx::query_scalar(
        "select id from invoice_templates where id = $1 and entity_id = $2 limit 1",
    )
    .bind(template_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `resolveInvoiceTemplate(db, { templateId, entityId })`: the invoice's own
/// template when set and of its entity, else the entity's default.
pub(crate) async fn resolve_invoice_template(
    db: &PgPool,
    template_id: Option<&str>,
    entity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if let Some(template_id) = template_id.filter(|t| !t.is_empty())
        && let Some(own) = find_template(db, template_id).await?
        && own["entityId"] == entity_id
    {
        return Ok(Some(own["document"].clone()));
    }
    let fallback: Option<Value> = sqlx::query_scalar(
        "select document from invoice_templates where entity_id = $1 and is_default = true limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(fallback)
}

/// `toInvoiceTemplate(row)`.
fn to_template(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "entityId": row["entityId"],
        "name": row["name"],
        "isDefault": row["isDefault"],
        "document": row["document"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// The event payload: the document belongs to the template, not the event.
fn event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "entityId": row["entityId"],
        "name": row["name"],
        "isDefault": row["isDefault"],
        "paperSize": row["paperSize"],
    })
}

async fn audit(
    caller: &Caller,
    row: &Value,
    id: &str,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: row["entityId"].as_str(),
            entity_type: "invoice_template",
            entity_id: id,
            action,
            changes,
        },
    )
    .await;
}

/// Unsets the default flag of the entity's other templates.
async fn unset_other_defaults<'e>(
    db: impl sqlx::PgExecutor<'e>,
    entity_id: &str,
    keep_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update invoice_templates set is_default = false, updated_at = $1::timestamp \
         where entity_id = $2 and is_default = true and id <> $3",
    )
    .bind(now())
    .bind(entity_id)
    .bind(keep_id)
    .execute(db)
    .await?;
    Ok(())
}

async fn insert_template(
    db: &PgPool,
    row: &Map<String, Value>,
    unset_defaults: bool,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    if unset_defaults {
        unset_other_defaults(
            &mut *tx,
            row["entityId"].as_str().unwrap_or_default(),
            row["id"].as_str().unwrap_or_default(),
        )
        .await?;
    }
    INVOICE_TEMPLATES
        .insert_raw(&mut *tx, INVOICE_TEMPLATES.values(row))
        .await?;
    tx.commit().await
}

async fn list(caller: Caller) -> Response {
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Ok(all_rows(Vec::new()));
            };
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(invoice_templates),
                " from invoice_templates t where t.entity_id = $1 order by t.is_default desc, t.name asc, t.id asc"
            ))
            .bind(&entity_id)
            .fetch_all(&caller.db)
            .await?;
            let rows: Vec<Value> = INVOICE_TEMPLATES
                .js_rows(rows)
                .iter()
                .map(to_template)
                .collect();
            Ok(all_rows(rows))
        }
        .await,
        "Failed to fetch invoice templates",
    )
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            match find_template(&caller.db, &id).await? {
                Some(row) => Ok(ok(to_template(&row))),
                None => Err(Refusal::not_found("Invoice template", &id)),
            }
        }
        .await,
        "Failed to fetch invoice template",
    )
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_create) {
        Ok(Some(input)) => input,
        Ok(None) => {
            return Refusal::Internal("body".into()).respond("Failed to create invoice template");
        }
        Err(refusal) => return refusal.respond("Failed to create invoice template"),
    };
    reply(
        async {
            let db = &caller.db;
            if !entity_exists(db, &input.entity_id).await? {
                return Err(Refusal::bad_request("Accounting entity not found"));
            }
            let count: i32 = sqlx::query_scalar(
                "select count(*)::int from invoice_templates where entity_id = $1",
            )
            .bind(&input.entity_id)
            .fetch_one(db)
            .await?;
            let is_default = input.is_default == Some(true) || count == 0;
            let at = now();
            let id = generate_id("itpl");
            let mut row = Map::new();
            row.insert("id".into(), json!(id));
            row.insert("createdAt".into(), json!(at));
            row.insert("updatedAt".into(), json!(at));
            row.insert("entityId".into(), json!(input.entity_id));
            row.insert("name".into(), json!(input.name));
            row.insert("isDefault".into(), json!(is_default));
            row.insert("paperSize".into(), input.document["paperSize"].clone());
            row.insert("document".into(), input.document.clone());
            row.insert("createdBy".into(), json!(caller.user()));
            insert_template(db, &row, is_default).await?;
            let row = Value::Object(row);
            audit(&caller, &row, &id, "created", None).await;
            caller.publish(&state, INVOICE_TEMPLATE_CREATED, &id, event_data(&row));
            Ok(created(to_template(&row)))
        }
        .await,
        "Failed to create invoice template",
    )
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_update) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to update invoice template"),
    };
    reply(
        async {
            let db = &caller.db;
            let Some(existing) = find_template(db, &id).await? else {
                return Err(Refusal::not_found("Invoice template", &id));
            };
            let mut tx = db.begin().await?;
            if input.is_default == Some(true) {
                unset_other_defaults(
                    &mut *tx,
                    existing["entityId"].as_str().unwrap_or_default(),
                    &id,
                )
                .await?;
            }
            sqlx::query(
                "update invoice_templates set updated_at = $1::timestamp, \
                 name = coalesce($2, name), is_default = coalesce($3, is_default), \
                 document = coalesce($4, document), paper_size = coalesce($5, paper_size) \
                 where id = $6",
            )
            .bind(now())
            .bind(input.name.as_deref())
            .bind(input.is_default)
            .bind(input.document.as_ref())
            .bind(
                input
                    .document
                    .as_ref()
                    .and_then(|d| d["paperSize"].as_str()),
            )
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            let Some(row) = find_template(db, &id).await? else {
                return Err(Refusal::not_found("Invoice template", &id));
            };
            // The document is not diffed into the audit trail: it is a whole page layout.
            let mut changes = Map::new();
            if let Some(name) = &input.name {
                changes.insert("name".into(), json!({ "new": name }));
            }
            if let Some(flag) = input.is_default {
                changes.insert("isDefault".into(), json!({ "new": flag }));
            }
            audit(&caller, &row, &id, "updated", Some(changes)).await;
            caller.publish(&state, INVOICE_TEMPLATE_UPDATED, &id, event_data(&row));
            Ok(ok(to_template(&row)))
        }
        .await,
        "Failed to update invoice template",
    )
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let Some(existing) = find_template(db, &id).await? else {
                return Err(Refusal::not_found("Invoice template", &id));
            };
            let mut tx = db.begin().await?;
            sqlx::query("update invoices set template_id = null where template_id = $1")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("delete from invoice_templates where id = $1")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            audit(&caller, &existing, &id, "deleted", None).await;
            caller.publish(&state, INVOICE_TEMPLATE_DELETED, &id, json!({ "id": id }));
            Ok(no_content())
        }
        .await,
        "Failed to delete invoice template",
    )
}

async fn duplicate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(source) = find_template(db, &id).await? else {
            return Err(Refusal::not_found("Invoice template", &id));
        };
        let suffix = " (copy)";
        let at = now();
        let new_id = generate_id("itpl");
        let mut row = Map::new();
        row.insert("id".into(), json!(new_id));
        row.insert("createdAt".into(), json!(at));
        row.insert("updatedAt".into(), json!(at));
        row.insert("entityId".into(), source["entityId"].clone());
        row.insert(
            "name".into(),
            json!(format!(
                "{}{suffix}",
                slice_utf16(
                    source["name"].as_str().unwrap_or_default(),
                    120 - suffix.len()
                )
            )),
        );
        row.insert("isDefault".into(), json!(false));
        row.insert("paperSize".into(), source["paperSize"].clone());
        row.insert("document".into(), source["document"].clone());
        row.insert("createdBy".into(), json!(caller.user()));
        insert_template(db, &row, false).await?;
        let row = Value::Object(row);
        audit(&caller, &row, &new_id, "created", None).await;
        caller.publish(&state, INVOICE_TEMPLATE_CREATED, &new_id, event_data(&row));
        Ok(created(to_template(&row)))
    }
    .await;
    reply(result, "Failed to duplicate invoice template")
}
