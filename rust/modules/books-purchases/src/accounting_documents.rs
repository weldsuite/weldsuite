//! `/api/accounting-documents` (`routes/accounting-documents/index.ts`): the
//! WeldBooks document inbox (uploaded purchase invoices, receipts and other
//! files), linked to a bill or rejected. Every state change is written to
//! the accounting audit log.
//!
//! OCR (`POST /:id/process`) runs on Workers AI on Global, which the
//! Kubernetes editions don't have (`books-ocr` in `unavailableFeatures`): the
//! route keeps its refusals (no session ids, unknown document, a tax form)
//! and answers 503 where it would call the model. Matching a stored OCR
//! result to a contact (`/rematch`) needs no AI and is served.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::tables::DOCUMENTS;
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_DOCUMENT_CREATED, ACCOUNTING_DOCUMENT_DELETED, ACCOUNTING_DOCUMENT_UPDATED,
};
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ocr::match_vendor_to_contact;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("invoices:read")))
        .route("/", post(create).route_layer(need("invoices:create")))
        .route("/stats", get(stats).route_layer(need("invoices:read")))
        .route("/{id}", get(detail).route_layer(need("invoices:read")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("invoices:delete")),
        )
        .route(
            "/{id}/process",
            post(process).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/rematch",
            post(rematch).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/create-bill",
            post(create_bill).route_layer(need("invoices:create")),
        )
        .route(
            "/{id}/link",
            patch(link).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/reject",
            patch(reject).route_layer(need("invoices:update")),
        )
        .with_state(state)
}

/// The live document `id`, as Drizzle returns it.
pub(crate) async fn find_document(
    db: &sqlx::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(documents),
        " from documents t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DOCUMENTS.js(row)))
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `isWorkspaceObjectKey(key, org)`: a safe key under `workspaces/<org>/`.
fn is_workspace_object_key(key: &str, org: Option<&str>) -> bool {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(owner), Some(_)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let valid_owner = !owner.is_empty()
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    weldsuite_ports::is_safe_key(key) && valid_owner && org.is_some_and(|org| org == owner)
}

// ── GET /, GET /stats, GET /:id ─────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let result: Reply = async {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(documents),
            " from documents t where t.deleted_at is null \
             and ($1::text is null or t.status = $1) and ($2::text is null or t.type = $2) \
             and ($3::text is null or t.source = $3) order by t.created_at desc limit 100"
        ))
        .bind(q.present("status"))
        .bind(q.present("type"))
        .bind(q.present("source"))
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(DOCUMENTS.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch documents")
}

async fn stats(caller: Caller) -> Response {
    let result: Reply = async {
        let rows: Vec<(Option<String>, i32)> = sqlx::query_as(
            "select status, count(*)::int from documents where deleted_at is null group by status",
        )
        .fetch_all(&caller.db)
        .await?;
        let rows = rows
            .into_iter()
            .map(|(status, count)| json!({ "status": status, "count": count }))
            .collect();
        Ok(ok(Value::Array(rows)))
    }
    .await;
    reply(result, "Failed to fetch document stats")
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        match find_document(&caller.db, &id).await? {
            Some(doc) => Ok(ok(doc)),
            None => Err(Refusal::not_found("Document", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch document")
}

// ── POST / ──────────────────────────────────────────────────────────────────

const TYPES: [&str; 7] = [
    "purchase_invoice",
    "receipt",
    "bank_statement",
    "contract",
    "expense_report",
    "tax_form",
    "other",
];

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        let optional = Presence::Optional;
        let text = |issues: &mut weldsuite_kit::validation::Issues, key: &str| {
            issues.text(body, key, optional, None, None).into_option()
        };
        let doc_type = issues.choice(body, "type", optional, &TYPES).into_option();
        let file_name = issues.text(body, "fileName", Presence::Required, Some(1), None);
        let original = text(issues, "originalFileName");
        let file_key = issues.text(body, "fileKey", Presence::Required, Some(1), None);
        let size = issues.number(body, "fileSize", optional, Number::default());
        let mime = text(issues, "mimeType");
        let source = issues
            .choice(
                body,
                "source",
                optional,
                &["upload", "email", "scan", "api"],
            )
            .into_option();
        let email_from = text(issues, "emailFrom");
        let email_subject = text(issues, "emailSubject");
        let message_id = text(issues, "emailMessageId");
        let filled = |v: Option<String>| v.filter(|s| !s.is_empty());
        let mut doc = Map::new();
        doc.insert("id".into(), json!(generate_id("doc")));
        doc.insert(
            "type".into(),
            json!(filled(doc_type).unwrap_or_else(|| "purchase_invoice".to_owned())),
        );
        doc.insert("fileName".into(), json!(file_name.into_option()));
        doc.insert("originalFileName".into(), json!(filled(original)));
        doc.insert("fileKey".into(), json!(file_key.into_option()));
        doc.insert(
            "fileSize".into(),
            match size {
                Field::Set(n) if n != 0.0 => weldsuite_books_domain::js::number_value(n),
                _ => Value::Null,
            },
        );
        doc.insert("mimeType".into(), json!(filled(mime)));
        doc.insert(
            "source".into(),
            json!(filled(source).unwrap_or_else(|| "upload".to_owned())),
        );
        doc.insert("status".into(), json!("pending"));
        doc.insert("emailFrom".into(), json!(filled(email_from)));
        doc.insert("emailSubject".into(), json!(filled(email_subject)));
        doc.insert("emailMessageId".into(), json!(filled(message_id)));
        doc
    }) {
        Ok(doc) => doc,
        Err(refusal) => return refusal.respond(""),
    };
    let file_key = text(&Value::Object(body.clone()), "fileKey")
        .unwrap_or_default()
        .to_owned();
    if !is_workspace_object_key(&file_key, caller.clerk_org_id.as_deref()) {
        return Refusal::bad_request("fileKey is not a file of this workspace").respond("");
    }
    let result: Reply = async {
        let mut doc = body;
        let now = now();
        doc.insert(
            "createdBy".into(),
            caller.user().map_or(Value::Null, |u| json!(u)),
        );
        doc.insert("createdAt".into(), json!(now));
        doc.insert("updatedAt".into(), json!(now));
        DOCUMENTS
            .insert_raw(&caller.db, DOCUMENTS.values(&doc))
            .await?;
        let id = text(&Value::Object(doc.clone()), "id")
            .unwrap_or_default()
            .to_owned();
        caller.publish(
            &state,
            ACCOUNTING_DOCUMENT_CREATED,
            &id,
            Value::Object(doc.clone()),
        );
        Ok(created(Value::Object(doc)))
    }
    .await;
    reply(result, "Failed to create document")
}

// ── POST /:id/process (OCR) ─────────────────────────────────────────────────

/// `isTaxFormDocument(db, doc)`: filed as a tax form, or attached to a
/// vendor's W-9 or a customer's exemption certificate.
async fn is_tax_form_document(db: &sqlx::PgPool, doc: &Value) -> Result<bool, sqlx::Error> {
    if text(doc, "type") == Some("tax_form") {
        return Ok(true);
    }
    let id = text(doc, "id").unwrap_or_default();
    let found: bool = sqlx::query_scalar(
        "select exists (select 1 from parties where w9->>'documentId' = $1) \
         or exists (select 1 from exemption_certificates where document_id = $1)",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    Ok(found)
}

async fn process(caller: Caller, Path(id): Path<String>) -> Response {
    if caller.clerk_org_id.is_none() || caller.user().is_none() {
        return Refusal::from(ApiError::unauthorized()).respond("");
    }
    let result: Reply = async {
        let Some(doc) = find_document(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        if is_tax_form_document(&caller.db, &doc).await? {
            return Err(Refusal::bad_request(
                "Tax forms such as W-9s and exemption certificates are never sent to OCR.",
            ));
        }
        // The model runs on Workers AI (Global only): see the module docs.
        Err(Refusal::unavailable(
            "Document OCR is not available in this edition of WeldSuite.",
        ))
    }
    .await;
    reply(result, "Failed to process document")
}

// ── POST /:id/rematch, /:id/create-bill ─────────────────────────────────────

async fn rematch(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(doc) = find_document(db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        let Some(ocr) = doc.get("ocrResult").filter(|v| !v.is_null()) else {
            return Err(Refusal::bad_request(
                "Document has no OCR result to match against",
            ));
        };
        let matched = match_vendor_to_contact(db, ocr).await?;
        sqlx::query("update documents set matched_contact_id = $2, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(&matched)
            .bind(now())
            .execute(db)
            .await?;
        Ok(ok(json!({ "id": id, "matchedContactId": matched })))
    }
    .await;
    reply(result, "Failed to rematch document")
}

async fn create_bill() -> Response {
    Refusal::bad_request("Use POST /api/bills/from-document/:documentId instead").respond("")
}

// ── PATCH /:id/link, /:id/reject, DELETE /:id ───────────────────────────────

fn audit<'a>(
    doc: &'a Value,
    id: &'a str,
    action: &'a str,
    changes: Option<Map<String, Value>>,
) -> AuditInput<'a> {
    AuditInput {
        accounting_entity_id: text(doc, "entityId"),
        entity_type: "accounting_document",
        entity_id: id,
        action,
        changes,
    }
}

fn change(old: Option<&Value>, new: &Value) -> Value {
    json!({ "old": old.cloned().unwrap_or(Value::Null), "new": new })
}

async fn link(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        let kind = issues.one_of(
            body,
            "linkedEntityType",
            &["bill", "invoice", "journal_entry", "expense"],
        );
        let target = issues.string(body, "linkedEntityId", true, Some(1), None);
        (kind.unwrap_or_default(), target.unwrap_or_default())
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let (kind, target) = body;
    let result: Reply = async {
        let db = &caller.db;
        let Some(doc) = find_document(db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        sqlx::query(
            "update documents set linked_entity_type = $2, linked_entity_id = $3, status = 'linked', \
             updated_at = $4::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&kind)
        .bind(&target)
        .bind(now())
        .execute(db)
        .await?;
        let mut changes = Map::new();
        changes.insert("status".into(), change(doc.get("status"), &json!("linked")));
        changes.insert(
            "linkedEntityType".into(),
            change(doc.get("linkedEntityType"), &json!(kind)),
        );
        changes.insert(
            "linkedEntityId".into(),
            change(doc.get("linkedEntityId"), &json!(target)),
        );
        write_accounting_audit(&caller, db, audit(&doc, &id, "linked", Some(changes))).await;
        caller.publish(
            &state,
            ACCOUNTING_DOCUMENT_UPDATED,
            &id,
            json!({ "id": id, "status": "linked", "linkedEntityType": kind, "linkedEntityId": target }),
        );
        Ok(ok(json!({ "id": id, "status": "linked" })))
    }
    .await;
    reply(result, "Failed to link document")
}

async fn reject(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(doc) = find_document(db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        sqlx::query(
            "update documents set status = 'rejected', updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(db)
        .await?;
        let mut changes = Map::new();
        changes.insert(
            "status".into(),
            change(doc.get("status"), &json!("rejected")),
        );
        write_accounting_audit(&caller, db, audit(&doc, &id, "rejected", Some(changes))).await;
        caller.publish(
            &state,
            ACCOUNTING_DOCUMENT_UPDATED,
            &id,
            json!({ "id": id, "status": "rejected" }),
        );
        Ok(ok(json!({ "message": "Document rejected" })))
    }
    .await;
    reply(result, "Failed to reject document")
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(doc) = find_document(db, &id).await? else {
            return Err(Refusal::not_found("Document", &id));
        };
        let now = now();
        sqlx::query("update documents set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(db)
            .await?;
        write_accounting_audit(&caller, db, audit(&doc, &id, "deleted", None)).await;
        caller.publish(&state, ACCOUNTING_DOCUMENT_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete document")
}
