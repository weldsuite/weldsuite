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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
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
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{invoice_templates, invoices};

use crate::invoices::row_json;
use crate::template_schema::{UpdateTemplate, read_create, read_update};

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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("invoice_templates"), "Invoice template")
                .layer(),
        )
        .with_state(state)
}

/// `findInvoiceTemplate(db, id)`.
pub(crate) async fn find_template(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    invoice_templates::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `templateBelongsToEntity(db, templateId, entityId)`.
pub(crate) async fn template_belongs_to_entity(
    db: &PgPool,
    template_id: &str,
    entity_id: &str,
) -> Result<bool, DbErr> {
    let found: Option<String> = invoice_templates::Entity::find_by_id(template_id.to_owned())
        .select_only()
        .column(invoice_templates::Column::Id)
        .filter(invoice_templates::Column::EntityId.eq(entity_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `resolveInvoiceTemplate(db, { templateId, entityId })`: the invoice's own
/// template when set and of its entity, else the entity's default.
pub(crate) async fn resolve_invoice_template(
    db: &PgPool,
    template_id: Option<&str>,
    entity_id: &str,
) -> Result<Option<Value>, DbErr> {
    if let Some(template_id) = template_id.filter(|t| !t.is_empty())
        && let Some(own) = find_template(db, template_id).await?
        && own["entityId"] == entity_id
    {
        return Ok(Some(own["document"].clone()));
    }
    invoice_templates::Entity::find()
        .select_only()
        .column(invoice_templates::Column::Document)
        .filter(invoice_templates::Column::EntityId.eq(entity_id))
        .filter(invoice_templates::Column::IsDefault.eq(true))
        .into_tuple()
        .one(&orm(db))
        .await
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
async fn unset_other_defaults<C: ConnectionTrait>(
    db: &C,
    entity_id: &str,
    keep_id: &str,
) -> Result<(), DbErr> {
    invoice_templates::Entity::update_many()
        .col_expr(invoice_templates::Column::IsDefault, Expr::value(false))
        .col_expr(invoice_templates::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(invoice_templates::Column::EntityId.eq(entity_id))
        .filter(invoice_templates::Column::IsDefault.eq(true))
        .filter(invoice_templates::Column::Id.ne(keep_id))
        .exec(db)
        .await?;
    Ok(())
}

/// The template's columns the body sent (`coalesce($n, column)` for the
/// rest), and `updatedAt`.
async fn update_template<C: ConnectionTrait>(
    db: &C,
    id: &str,
    input: &UpdateTemplate,
) -> Result<(), DbErr> {
    let mut update = invoice_templates::Entity::update_many()
        .col_expr(invoice_templates::Column::UpdatedAt, Expr::value(utc_now()));
    if let Some(name) = &input.name {
        update = update.col_expr(invoice_templates::Column::Name, Expr::value(name));
    }
    if let Some(flag) = input.is_default {
        update = update.col_expr(invoice_templates::Column::IsDefault, Expr::value(flag));
    }
    if let Some(document) = &input.document {
        update = update.col_expr(
            invoice_templates::Column::Document,
            Expr::value(document.clone()),
        );
        if let Some(paper) = document["paperSize"].as_str() {
            update = update.col_expr(invoice_templates::Column::PaperSize, Expr::value(paper));
        }
    }
    update
        .filter(invoice_templates::Column::Id.eq(id))
        .exec(db)
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
            &OrmConn::new(&mut tx),
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
            let rows: Vec<Value> = invoice_templates::Entity::find()
                .filter(invoice_templates::Column::EntityId.eq(entity_id))
                .order_by_desc(invoice_templates::Column::IsDefault)
                .order_by_asc(invoice_templates::Column::Name)
                .order_by_asc(invoice_templates::Column::Id)
                .all(&orm(&caller.db))
                .await?
                .into_iter()
                .map(|row| row_json(row).map(|row| to_template(&row)))
                .collect::<Result<_, _>>()?;
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
            let count = invoice_templates::Entity::find()
                .filter(invoice_templates::Column::EntityId.eq(input.entity_id.as_str()))
                .count(&orm(db))
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
            {
                let tx = OrmConn::new(&mut tx);
                if input.is_default == Some(true) {
                    unset_other_defaults(
                        &tx,
                        existing["entityId"].as_str().unwrap_or_default(),
                        &id,
                    )
                    .await?;
                }
                update_template(&tx, &id, &input)
                    .await?;
            }
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
            {
                let tx = OrmConn::new(&mut tx);
                invoices::Entity::update_many()
                    .col_expr(invoices::Column::TemplateId, Expr::value(None::<String>))
                    .filter(invoices::Column::TemplateId.eq(id.as_str()))
                    .exec(&tx)
                    .await?;
                invoice_templates::Entity::delete_by_id(id.clone())
                    .exec(&tx)
                    .await?;
            }
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
