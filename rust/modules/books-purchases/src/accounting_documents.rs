//! `/api/accounting-documents` (`routes/accounting-documents/index.ts`): the
//! WeldBooks document inbox (uploaded purchase invoices, receipts and other
//! files), linked to a bill or rejected. Every state change is written to
//! the accounting audit log.
//!
//! OCR (`POST /:id/process`) reads the stored file through `weldsuite_ai`
//! under the `books-ocr` feature (`crate::ocr`): Mistral OCR on the EU
//! edition, the workspace's opted-in provider when its admin routed the
//! feature there. Without an AI provider (`books-ocr` is then listed in
//! `unavailableFeatures`) the route keeps its refusals (no session ids,
//! unknown document, a tax form) and answers 503 `ai_unavailable` where it
//! would call the model. Matching a stored OCR result to a contact
//! (`/rematch`) needs no AI.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, Feature, Task, Tier};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::tables::DOCUMENTS;
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_DOCUMENT_CREATED, ACCOUNTING_DOCUMENT_DELETED, ACCOUNTING_DOCUMENT_UPDATED,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{documents, exemption_certificates, parties};

use crate::document_booking;
use crate::ocr::{OCR_OP, OcrFailure, load_ocr_file, match_vendor_to_contact, read_document};
use crate::rows::{js, js_rows};

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
        // Rust only (edition feature `books-receipts`): booking a document in
        // one call, the bank lines that could have paid it, duplicates, and
        // what the review form starts from.
        .route(
            "/{id}/book",
            post(document_booking::book)
                .route_layer(need("bills:update"))
                .route_layer(need("bills:create")),
        )
        .route(
            "/{id}/bank-candidates",
            get(document_booking::bank_candidates)
                .route_layer(need("banking:read"))
                .route_layer(need("invoices:read")),
        )
        .route(
            "/{id}/duplicates",
            get(document_booking::duplicates).route_layer(need("invoices:read")),
        )
        .route(
            "/{id}/prefill",
            get(document_booking::prefill).route_layer(need("invoices:read")),
        )
        .route(
            "/{id}/link",
            patch(link).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/reject",
            patch(reject).route_layer(need("invoices:update")),
        )
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(EntityRecordGuard::table(EntityTable::new("documents"), "Document").layer())
        .with_state(state)
}

/// The live document `id`, as Drizzle returns it.
pub(crate) async fn find_document(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    documents::Entity::find()
        .filter(documents::Column::Id.eq(id))
        .filter(documents::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|row| js!(row))
        .transpose()
}

/// `update documents set …, updatedAt = now where id = …`.
async fn update_document(
    db: &PgPool,
    id: &str,
    changes: &[(documents::Column, Expr)],
) -> Result<(), DbErr> {
    let mut update = documents::Entity::update_many();
    for (column, value) in changes {
        update = update.col_expr(*column, value.clone());
    }
    update
        .col_expr(documents::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(documents::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
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

/// The documents of the request's legal entity (Rust only, `scope=entity`):
/// its own, and for the default entity the ones with no entity.
async fn entity_scope(caller: &Caller) -> Result<sea_orm::Condition, Refusal> {
    let Some(entity_id) = weldsuite_books_domain::entity_context::resolve_entity_id(caller).await?
    else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let default = weldsuite_legal_entities::default_entity_id_for(
        &caller.db,
        Some(weldsuite_legal_entities::LegalEntityApp::Weldbooks),
    )
    .await?;
    let mut entity =
        sea_orm::Condition::any().add(documents::Column::EntityId.eq(entity_id.as_str()));
    if default.as_deref() == Some(entity_id.as_str()) {
        entity = entity.add(documents::Column::EntityId.is_null());
    }
    Ok(entity)
}

/// Whether the request asks for the entity's documents (`scope=entity`).
fn scoped(q: &Query) -> bool {
    q.present("scope") == Some("entity")
}

/// `GET /`: the first 100 documents, as ever. Rust only, optional: `scope=entity`
/// lists the request's legal entity's documents (those with no entity count
/// for the default entity), and `page` / `pageSize` (default 1 and 25, at
/// most 100) page the list with `pagination.totalCount`. Without any of them
/// the answer is the worker's.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let paging = scoped(&q) || q.present("page").is_some() || q.present("pageSize").is_some();
    let result: Reply = async {
        let mut listed = documents::Entity::find().filter(documents::Column::DeletedAt.is_null());
        if scoped(&q) {
            listed = listed.filter(entity_scope(&caller).await?);
        }
        if let Some(status) = q.present("status") {
            listed = listed.filter(documents::Column::Status.eq(status));
        }
        if let Some(kind) = q.present("type") {
            listed = listed.filter(documents::Column::Type.eq(kind));
        }
        if let Some(source) = q.present("source") {
            listed = listed.filter(documents::Column::Source.eq(source));
        }
        if paging {
            use sea_orm::PaginatorTrait as _;
            let page_size: u64 = q
                .present("pageSize")
                .and_then(|v| v.parse().ok())
                .map_or(25, |n: u64| n.clamp(1, 100));
            let page: u64 = q
                .present("page")
                .and_then(|v| v.parse().ok())
                .map_or(1, |n: u64| n.max(1));
            let total = listed.clone().count(&orm(&caller.db)).await?;
            let rows = listed
                .order_by_desc(documents::Column::CreatedAt)
                .order_by_desc(documents::Column::Id)
                .limit(page_size)
                .offset((page - 1) * page_size)
                .all(&orm(&caller.db))
                .await?;
            let shown = (page - 1) * page_size + u64::try_from(rows.len()).unwrap_or(0);
            return Ok(weldsuite_books_domain::http::paged(
                js_rows!(rows)?,
                i64::try_from(total).unwrap_or(i64::MAX),
                shown < total,
                None,
            ));
        }
        let rows = listed
            .order_by_desc(documents::Column::CreatedAt)
            .limit(100)
            .all(&orm(&caller.db))
            .await?;
        Ok(ok(Value::Array(js_rows!(rows)?)))
    }
    .await;
    reply(result, "Failed to fetch documents")
}

/// `GET /stats`: the documents per status. `scope=entity` (Rust only,
/// optional) counts the request's legal entity's documents only.
async fn stats(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    use sea_orm::ExprTrait as _;
    let q = Query::parse(raw.as_deref());
    let result: Reply = async {
        let mut counted = documents::Entity::find().filter(documents::Column::DeletedAt.is_null());
        if scoped(&q) {
            counted = counted.filter(entity_scope(&caller).await?);
        }
        let rows: Vec<(Option<String>, i32)> = counted
            .select_only()
            .column(documents::Column::Status)
            .column_as(
                Expr::from(Func::count(Expr::col(Asterisk))).cast_as("int"),
                "count",
            )
            .group_by(documents::Column::Status)
            .into_tuple()
            .all(&orm(&caller.db))
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
        // The inbox is per legal entity: the document belongs to the entity
        // the upload was made in. Written after the insert, so the answer and
        // the event stay the worker's.
        if let Some(entity_id) =
            weldsuite_books_domain::entity_context::resolve_entity_id(&caller).await?
        {
            documents::Entity::update_many()
                .col_expr(documents::Column::EntityId, Expr::value(entity_id))
                .filter(documents::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
        }
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
pub(crate) async fn is_tax_form_document(db: &PgPool, doc: &Value) -> Result<bool, DbErr> {
    use sea_orm::ExprTrait as _;
    if text(doc, "type") == Some("tax_form") {
        return Ok(true);
    }
    let id = text(doc, "id").unwrap_or_default();
    let w9 = sea_orm::sea_query::Query::select()
        .expr(Expr::val(1))
        .from(parties::Entity)
        .and_where(pg::PgExpr::cast_json_field(Expr::col(parties::Column::W9), "documentId").eq(id))
        .to_owned();
    let certificate = sea_orm::sea_query::Query::select()
        .expr(Expr::val(1))
        .from(exemption_certificates::Entity)
        .and_where(exemption_certificates::Column::DocumentId.eq(id))
        .to_owned();
    let found = sea_orm::sea_query::Query::select()
        .expr_as(Expr::exists(w9).or(Expr::exists(certificate)), "found")
        .to_owned();
    let row = orm(db).query_one(&found).await?;
    match row {
        Some(row) => row.try_get_by_index(0),
        None => Ok(false),
    }
}

/// Sets the document's status (the `processing` mark, the `failed` one).
async fn set_status(db: &PgPool, id: &str, status: &str) -> Result<(), DbErr> {
    update_document(db, id, &[(documents::Column::Status, Expr::value(status))]).await
}

async fn process(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
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
        // No AI provider on this install: see the module docs.
        let Some(ai) = caller.ai(&state) else {
            return Err(AiError::Unavailable.into_api_error().into());
        };
        set_status(&caller.db, &id, "processing").await?;
        match read_and_store(&caller, &state, &ai, &doc, &id).await {
            Ok(response) => Ok(response),
            Err(failure) => {
                set_status(&caller.db, &id, "failed").await?;
                Err(failure.into_api_error().into())
            }
        }
    }
    .await;
    reply(result, "Failed to process document")
}

/// The inner `try` of `POST /:id/process`: read the file, store the result
/// and the matched contact, audit and announce it. `meta.ai` names the
/// model that read it.
async fn read_and_store(
    caller: &Caller,
    state: &BooksState,
    ai: &Ai,
    doc: &Value,
    id: &str,
) -> Result<Response, OcrFailure> {
    let failed = |error: DbErr| OcrFailure::Failed(error.to_string());
    let db = &caller.db;
    let file = load_ocr_file(
        &caller.buckets(state),
        text(doc, "fileKey").unwrap_or_default(),
        text(doc, "mimeType"),
        &[
            caller.clerk_org_id.as_deref(),
            Some(caller.workspace_id.as_str()),
        ],
    )
    .await?;
    let call = AiCall::new(
        caller.workspace_id.as_str(),
        Feature::BooksOcr,
        Task::Ocr,
        Tier::Free,
    )
    .user(caller.user_id.as_str())
    .tenant(db.clone())
    .master(caller.master(state))
    .op(OCR_OP)
    .reference(id);
    let (ocr_result, served) = read_document(ai, &call, file, text(doc, "fileName")).await?;
    let matched = match_vendor_to_contact(db, &ocr_result)
        .await
        .map_err(failed)?;
    let at = utc_now();
    documents::Entity::update_many()
        .col_expr(documents::Column::Status, Expr::value("processed"))
        .col_expr(
            documents::Column::OcrResult,
            Expr::value(ocr_result.clone()),
        )
        .col_expr(documents::Column::OcrProcessedAt, Expr::value(at))
        .col_expr(
            documents::Column::OcrModel,
            Expr::value(served.model.clone()),
        )
        .col_expr(
            documents::Column::MatchedContactId,
            Expr::value(matched.clone()),
        )
        .col_expr(documents::Column::UpdatedAt, Expr::value(at))
        .filter(documents::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map_err(failed)?;
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(doc.get("status"), &json!("processed")),
    );
    changes.insert(
        "matchedContactId".into(),
        change(doc.get("matchedContactId"), &json!(matched)),
    );
    write_accounting_audit(caller, db, audit(doc, id, "processed", Some(changes))).await;
    caller.publish(
        state,
        ACCOUNTING_DOCUMENT_UPDATED,
        id,
        json!({ "id": id, "status": "processed", "matchedContactId": matched }),
    );
    Ok(axum::Json(json!({
        "data": {
            "id": id,
            "status": "processed",
            "ocrResult": ocr_result,
            "matchedContactId": matched,
        },
        "meta": { "ai": served.meta() },
    }))
    .into_response())
}

// ── OCR on arrival (Rust only, edition feature `books-receipts`) ────────────

/// What reading a document that just arrived came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Scan {
    /// Nothing to do, and why (the setting is off, no AI, already read, …).
    Skipped(&'static str),
    /// Read and stored, as `POST /:id/process` does.
    Done,
    /// A refusal of the file or the credits: the document is `failed`; a
    /// person can look at it and process it again.
    Failed(String),
    /// The provider or the database failed: the document is `pending` again
    /// and the event is delivered once more.
    Retry(String),
}

/// `autoScanEnabled` of the workspace's accounting settings: set when the
/// inbox is registered, and read by nothing before this.
async fn auto_scan_enabled(db: &PgPool) -> Result<bool, DbErr> {
    let settings: Option<Option<Value>> = weldsuite_schema::tenant::settings::Entity::find()
        .select_only()
        .column(weldsuite_schema::tenant::settings::Column::EmailSettings)
        .filter(weldsuite_schema::tenant::settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(settings
        .flatten()
        .and_then(|email| email.get("autoScanEnabled").and_then(Value::as_bool))
        .unwrap_or(false))
}

/// Read a document that was just created, when `autoScanEnabled` is on: the
/// same read, the same credit charge and the same result as
/// `POST /:id/process`, but after the request that made the document and
/// off the inbound mail path (the `books-ocr` consumer of
/// `accounting_document:created`).
///
/// **Idempotent:** the document is taken with one conditional write
/// (`pending` and no result to `processing`), so a redelivered event, or a
/// person pressing "scan" at the same moment, finds it taken and does
/// nothing: it is never read, or charged, twice. **No timer:** it runs for
/// the one workspace the event came from, never over the workspaces.
pub(crate) async fn scan_on_arrival(caller: &Caller, state: &BooksState, id: &str) -> Scan {
    let db = &caller.db;
    let scan = async {
        let Some(doc) = find_document(db, id).await? else {
            return Ok::<Scan, DbErr>(Scan::Skipped("the document is gone"));
        };
        if text(&doc, "status") != Some("pending")
            || doc.get("ocrResult").is_some_and(|v| !v.is_null())
        {
            return Ok(Scan::Skipped("the document is not waiting to be read"));
        }
        if !auto_scan_enabled(db).await? {
            return Ok(Scan::Skipped("autoScanEnabled is off"));
        }
        if let Some(mime) = text(&doc, "mimeType")
            && !(mime == "application/pdf"
                || mime.starts_with("image/")
                || mime == "application/octet-stream")
        {
            return Ok(Scan::Skipped("OCR reads PDF files and images only"));
        }
        if is_tax_form_document(db, &doc).await? {
            return Ok(Scan::Skipped("a tax form is never sent to OCR"));
        }
        let Some(ai) = caller.ai(state) else {
            return Ok(Scan::Skipped("no AI provider"));
        };
        let taken = documents::Entity::update_many()
            .col_expr(documents::Column::Status, Expr::value("processing"))
            .col_expr(documents::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(documents::Column::Id.eq(id))
            .filter(documents::Column::Status.eq("pending"))
            .filter(documents::Column::OcrResult.is_null())
            .filter(documents::Column::DeletedAt.is_null())
            .exec(&orm(db))
            .await?;
        if taken.rows_affected != 1 {
            return Ok(Scan::Skipped("another read has the document"));
        }
        Ok(match read_and_store(caller, state, &ai, &doc, id).await {
            Ok(_) => Scan::Done,
            Err(failure) => {
                let transient = matches!(failure, OcrFailure::Upstream(_) | OcrFailure::Failed(_));
                let message = format!("{failure:?}");
                set_status(db, id, if transient { "pending" } else { "failed" }).await?;
                if transient {
                    Scan::Retry(message)
                } else {
                    Scan::Failed(message)
                }
            }
        })
    }
    .await;
    scan.unwrap_or_else(|error| Scan::Retry(error.to_string()))
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
        update_document(
            db,
            &id,
            &[(
                documents::Column::MatchedContactId,
                Expr::value(matched.clone()),
            )],
        )
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
        update_document(
            db,
            &id,
            &[
                (
                    documents::Column::LinkedEntityType,
                    Expr::value(kind.as_str()),
                ),
                (
                    documents::Column::LinkedEntityId,
                    Expr::value(target.as_str()),
                ),
                (documents::Column::Status, Expr::value("linked")),
            ],
        )
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
        update_document(
            db,
            &id,
            &[(documents::Column::Status, Expr::value("rejected"))],
        )
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
        let at = utc_now();
        documents::Entity::update_many()
            .col_expr(documents::Column::DeletedAt, Expr::value(at))
            .col_expr(documents::Column::UpdatedAt, Expr::value(at))
            .filter(documents::Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        write_accounting_audit(&caller, db, audit(&doc, &id, "deleted", None)).await;
        caller.publish(
            &state,
            ACCOUNTING_DOCUMENT_DELETED,
            &id,
            json!({ "id": id }),
        );
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete document")
}

/// The inbox against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`; each
/// test returns early without it): the list and stats scoped to the legal
/// entity on request, paged, and the OCR on arrival.
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::int_plus_one,
    clippy::cloned_ref_to_slice_refs,
    clippy::len_zero,
    clippy::ignored_unit_patterns,
    clippy::unused_async,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]
mod tests {
    use std::sync::Arc;

    use axum::extract::RawQuery;
    use serde_json::json;
    use weldsuite_ai::config::Endpoint;
    use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};
    use weldsuite_ports::{DynFileStore, FileStores, MemoryFileStore, PutOptions};

    use super::*;
    use crate::test_support::{
        DEFAULT_ENTITY, World, answer_of, company, document, fresh, row_of, supplier, text as field,
    };

    fn query(raw: &str) -> RawQuery {
        RawQuery(Some(raw.to_owned()))
    }

    fn ids(body: &Value) -> Vec<String> {
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[tokio::test]
    async fn the_list_and_stats_are_scoped_to_the_entity_on_request_and_paged() {
        let Some(world) = World::new() else {
            return;
        };
        let _default = DEFAULT_ENTITY.lock().await;
        let a = company(&world.db, "NL91ABNA0417164300").await;
        let b = company(&world.db, "NL12ABNA0000000002").await;
        sqlx::query("update entities set is_default = false where is_default")
            .execute(&world.db)
            .await
            .unwrap();
        sqlx::query("update entities set is_default = true where id = $1")
            .bind(&a.entity)
            .execute(&world.db)
            .await
            .unwrap();
        let a1 = document(&world.db, Some(&a.entity), "a1.pdf", 1, "pending", None).await;
        let a2 = document(&world.db, Some(&a.entity), "a2.pdf", 2, "processed", None).await;
        let b1 = document(&world.db, Some(&b.entity), "b1.pdf", 3, "pending", None).await;
        let loose = document(&world.db, None, "loose.pdf", 4, "pending", None).await;
        // Slow the rows apart so the order is the order made.
        for (id, offset) in [(&a1, 4), (&a2, 3), (&b1, 2), (&loose, 1)] {
            sqlx::query("update documents set created_at = now() + ($2 || ' seconds')::interval where id = $1")
                .bind(id)
                .bind(offset.to_string())
                .execute(&world.db)
                .await
                .unwrap();
        }

        // Without the new parameters the answer is the worker's: every
        // entity's documents, no pagination block.
        let (status, all) = answer_of(
            list(
                world.caller(&a.entity),
                query("status=pending&source=upload"),
            )
            .await,
        )
        .await;
        assert_eq!(status, 200);
        assert!(all.get("pagination").is_none());
        let all_ids = ids(&all);
        for id in [&a1, &b1, &loose] {
            assert!(all_ids.contains(id), "{all_ids:?}");
        }

        // scope=entity: the entity's own, and for the default entity the loose ones.
        let (_, mine) =
            answer_of(list(world.caller(&a.entity), query("scope=entity&pageSize=100")).await)
                .await;
        let mine_ids = ids(&mine);
        assert!(mine_ids.contains(&a1) && mine_ids.contains(&a2) && mine_ids.contains(&loose));
        assert!(!mine_ids.contains(&b1));
        assert!(mine["pagination"]["totalCount"].as_i64().unwrap() >= 3);
        let (_, theirs) =
            answer_of(list(world.caller(&b.entity), query("scope=entity&pageSize=100")).await)
                .await;
        assert_eq!(
            ids(&theirs),
            [b1.clone()],
            "the other entity: its own, not the loose ones"
        );
        assert_eq!(theirs["pagination"]["totalCount"], json!(1));

        // Paging: newest first, with the total and whether there is more.
        let (_, page1) = answer_of(
            list(
                world.caller(&a.entity),
                query("scope=entity&page=1&pageSize=2"),
            )
            .await,
        )
        .await;
        assert_eq!(page1["data"].as_array().unwrap().len(), 2);
        assert_eq!(page1["pagination"]["hasMore"], json!(true));
        let (_, page2) = answer_of(
            list(
                world.caller(&a.entity),
                query("scope=entity&page=2&pageSize=2"),
            )
            .await,
        )
        .await;
        assert!(page2["data"].as_array().unwrap().len() >= 1);
        let first: Vec<String> = ids(&page1);
        assert!(
            ids(&page2).iter().all(|id| !first.contains(id)),
            "pages do not overlap"
        );
        let total = page1["pagination"]["totalCount"].as_i64().unwrap();
        let last_page = (total + 1) / 2;
        let (_, last) = answer_of(
            list(
                world.caller(&a.entity),
                query(&format!("scope=entity&page={last_page}&pageSize=2")),
            )
            .await,
        )
        .await;
        assert_eq!(last["pagination"]["hasMore"], json!(false));
        // Plain paging, with no scope, is every entity's.
        let (_, unscoped) =
            answer_of(list(world.caller(&a.entity), query("page=1&pageSize=1")).await).await;
        assert!(unscoped["pagination"]["totalCount"].as_i64().unwrap() >= total + 1);

        // The stats count the same documents.
        let counts = |body: &Value| -> (i64, i64) {
            let of = |status: &str| {
                body["data"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|row| row["status"] == json!(status))
                    .map_or(0, |row| row["count"].as_i64().unwrap())
            };
            (of("pending"), of("processed"))
        };
        let (_, stats_b) =
            answer_of(stats(world.caller(&b.entity), query("scope=entity")).await).await;
        assert_eq!(counts(&stats_b), (1, 0));
        let (_, stats_a) =
            answer_of(stats(world.caller(&a.entity), query("scope=entity")).await).await;
        let (pending, processed) = counts(&stats_a);
        assert!(pending >= 2 && processed >= 1);
        let (_, stats_all) = answer_of(stats(world.caller(&a.entity), RawQuery(None)).await).await;
        assert!(
            counts(&stats_all).0 > pending,
            "unscoped counts the other entities too"
        );
        sqlx::query("update entities set is_default = false where id = $1")
            .bind(&a.entity)
            .execute(&world.db)
            .await
            .unwrap();
    }

    fn fields(name: &str, iban: &str) -> Value {
        json!({
            "vendor": { "name": name, "iban": iban },
            "invoiceNumber": "AH-77",
            "invoiceDate": "2026-11-20",
            "currency": "EUR",
            "lineItems": [],
            "taxBreakdown": [{ "rate": 9, "taxableAmount": 11.47, "taxAmount": 1.03 }],
            "totalTax": 1.03,
            "total": 12.5,
            "documentKind": "receipt",
            "paid": true,
            "paymentMethod": "pin",
            "confidence": { "overall": 0.9 },
        })
    }

    /// A world that reads documents: a fake model, and a store with a PDF.
    async fn reading_world(fake: &FakeProvider) -> (World, Arc<MemoryFileStore>) {
        let mut world = World::new().unwrap();
        let store = Arc::new(MemoryFileStore::default());
        world.state.files = Some(FileStores {
            private: Arc::clone(&store) as Arc<dyn DynFileStore>,
            public: None,
        });
        world.state.ai = Some(Ai::fake(
            AiConfig {
                default_provider: Some(ProviderId::Mistral),
                mistral: Endpoint {
                    base_url: "https://api.mistral.ai/v1".to_owned(),
                    api_key: Some("key".to_owned()),
                },
                ..AiConfig::default()
            },
            fake.clone(),
        ));
        (world, store)
    }

    async fn put_pdf(store: &MemoryFileStore, key: &str) {
        store
            .put_boxed(
                key,
                b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n".to_vec(),
                &PutOptions::default(),
            )
            .await
            .unwrap();
    }

    async fn auto_scan(db: &PgPool, on: Option<bool>) {
        sqlx::query("delete from settings")
            .execute(db)
            .await
            .unwrap();
        if let Some(on) = on {
            sqlx::query("insert into settings (id, email_settings) values ($1, $2)")
                .bind(fresh("acs"))
                .bind(json!({ "autoScanEnabled": on }))
                .execute(db)
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn a_document_is_read_on_arrival_once_when_the_setting_is_on() {
        // This run's own supplier: the database is shared with earlier runs.
        let (name, iban) = (fresh("Shop"), fresh("NL91TEST"));
        let fake = FakeProvider::new().reply_json(&fields(&name, &iban));
        if World::new().is_none() {
            return;
        }
        let (world, store) = reading_world(&fake).await;
        let _settings = DEFAULT_ENTITY.lock().await;
        let co = company(&world.db, "NL91ABNA0417164300").await;
        let ah = supplier(&world.db, &name, Some(&iban)).await;
        let key = format!(
            "workspaces/ws_p3_test/accounting/inbox/{}/bon.pdf",
            fresh("m")
        );
        put_pdf(&store, &key).await;
        let doc = document(&world.db, Some(&co.entity), "bon.pdf", 60, "pending", None).await;
        sqlx::query("update documents set file_key = $2 where id = $1")
            .bind(&doc)
            .bind(&key)
            .execute(&world.db)
            .await
            .unwrap();
        let caller = world.caller(&co.entity);

        // The setting is off, or was never there: the document waits.
        auto_scan(&world.db, Some(false)).await;
        assert_eq!(
            scan_on_arrival(&caller, &world.state, &doc).await,
            Scan::Skipped("autoScanEnabled is off")
        );
        auto_scan(&world.db, None).await;
        assert!(matches!(
            scan_on_arrival(&caller, &world.state, &doc).await,
            Scan::Skipped(_)
        ));
        assert_eq!(
            field(&row_of(&world.db, "documents", &doc).await, "status"),
            "pending"
        );
        assert!(fake.calls().is_empty(), "nothing was sent to the model");

        // On: read as `POST /:id/process` reads it, and the supplier matched.
        auto_scan(&world.db, Some(true)).await;
        world.events().await;
        assert_eq!(
            scan_on_arrival(&caller, &world.state, &doc).await,
            Scan::Done
        );
        let row = row_of(&world.db, "documents", &doc).await;
        assert_eq!(field(&row, "status"), "processed");
        assert_eq!(field(&row, "matched_contact_id"), ah);
        assert_eq!(row["ocr_result"]["documentKind"], json!("receipt"));
        assert_eq!(row["ocr_result"]["paid"], json!(true));
        assert_eq!(row["ocr_result"]["paymentMethod"], json!("card"));
        assert_eq!(row["ocr_result"]["invoiceDate"], json!("2026-11-20"));
        assert!(!row["ocr_model"].is_null() && !row["ocr_processed_at"].is_null());
        let events = world.events().await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "accounting_document.updated");
        assert_eq!(fake.calls().len(), 1);

        // A redelivered event, or a second pass: nothing is read, or charged, again.
        assert_eq!(
            scan_on_arrival(&caller, &world.state, &doc).await,
            Scan::Skipped("the document is not waiting to be read")
        );
        assert_eq!(fake.calls().len(), 1);
        assert!(world.events().await.is_empty());

        // A document being read by someone else is left to them.
        let busy = document(
            &world.db,
            Some(&co.entity),
            "busy.pdf",
            61,
            "processing",
            None,
        )
        .await;
        assert!(matches!(
            scan_on_arrival(&caller, &world.state, &busy).await,
            Scan::Skipped(_)
        ));

        // A file that is not there is a failure to look at, not a retry.
        let lost = document(&world.db, Some(&co.entity), "lost.pdf", 62, "pending", None).await;
        sqlx::query("update documents set file_key = 'workspaces/ws_p3_test/accounting/inbox/none/x.pdf' where id = $1")
            .bind(&lost)
            .execute(&world.db)
            .await
            .unwrap();
        assert!(matches!(
            scan_on_arrival(&caller, &world.state, &lost).await,
            Scan::Failed(_)
        ));
        assert_eq!(
            field(&row_of(&world.db, "documents", &lost).await, "status"),
            "failed"
        );

        // An e-mail body is not read (a model reads files); no model, no read.
        let html = document(
            &world.db,
            Some(&co.entity),
            "mail.html",
            63,
            "pending",
            None,
        )
        .await;
        sqlx::query("update documents set mime_type = 'text/html' where id = $1")
            .bind(&html)
            .execute(&world.db)
            .await
            .unwrap();
        assert_eq!(
            scan_on_arrival(&caller, &world.state, &html).await,
            Scan::Skipped("OCR reads PDF files and images only")
        );
        let (bare, _) = (World::new().unwrap(), ());
        let waiting = document(&bare.db, Some(&co.entity), "wait.pdf", 64, "pending", None).await;
        assert_eq!(
            scan_on_arrival(&bare.caller(&co.entity), &bare.state, &waiting).await,
            Scan::Skipped("no AI provider")
        );
        assert_eq!(
            field(&row_of(&bare.db, "documents", &waiting).await, "status"),
            "pending"
        );
        auto_scan(&world.db, None).await;
    }

    /// The consumer: only `accounting_document:created` is read, and the
    /// workspace of the event is the only one opened.
    #[tokio::test]
    async fn the_consumer_ignores_other_events() {
        use weldsuite_ports::{BatchHandler, Delivery, Disposition};
        use weldsuite_subscribers::tenants::{ResolvedTenant, TenantError, Tenants};

        struct Nowhere;
        impl Tenants for Nowhere {
            fn tenant<'a>(
                &'a self,
                _: &'a str,
            ) -> weldsuite_ports::BoxFuture<'a, Result<ResolvedTenant, TenantError>> {
                Box::pin(async { Err(TenantError::NotFound) })
            }
            fn hub_key<'a>(
                &'a self,
                reference: &'a str,
            ) -> weldsuite_ports::BoxFuture<'a, Result<String, TenantError>> {
                Box::pin(async move { Ok(reference.to_owned()) })
            }
        }
        let Some(world) = World::new() else {
            return;
        };
        let subscriber = crate::OcrOnArrivalSubscriber::new(Arc::new(Nowhere), world.state.clone());
        let delivery = |event_type: &str| Delivery {
            subject: "entity-events.accounting_document.created".to_owned(),
            payload: serde_json::to_vec(&json!({
                "id": "evt_1",
                "eventType": event_type,
                "entityType": "accounting_document",
                "entityId": "doc_1",
                "action": "created",
                "metadata": { "workspaceId": "ws_gone", "timestamp": "2026-11-27T10:00:00.000Z" },
            }))
            .unwrap(),
            attempt: 1,
            deferrals: 0,
        };
        let batch = [
            delivery("accounting_document:created"),
            delivery("accounting_document:updated"),
            Delivery {
                payload: b"not json".to_vec(),
                ..delivery("x")
            },
        ];
        // A workspace that is gone, another event, and a payload that is not
        // one: all done with, none retried.
        assert_eq!(
            subscriber.handle(&batch).await,
            vec![Disposition::Ack, Disposition::Ack, Disposition::Ack]
        );
        assert_eq!(crate::BOOKS_OCR_TOPICS, ["accounting_document:created"]);
    }
}
