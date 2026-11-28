//! `/public/weldbooks/documents/:token`: what the pay portal calls on behalf
//! of a customer who opened the link in an e-mail (ADR BOOKS-014). No
//! session: the signed token is the credential and leads to the workspace
//! and the document ([`weldsuite_books_domain::document_token`]).
//!
//! - `GET /:token`: the document as the portal's contract describes it
//!   (`apps/web/pay-portal/lib/contract.ts`). The first opening sets
//!   `viewed_at`; an invoice's openings are also recorded in `email_history`
//!   and announced as `invoice.viewed`, at most once an hour.
//! - `GET /:token/pdf`: `application/pdf`.
//! - `POST /:token/pay`: 503 until online payment is built (phase 4b).
//! - `POST /:token/accept`: `{ name, email, agree: true }` accepts a quote.
//!
//! Unknown, tampered, revoked and draft documents answer the same 404.
//! Requests are counted per address and per token in the workspace cache
//! (in memory without one) and answer 429 past the limit. Every answer is
//! never cached, never indexed, and carries no referrer.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, StatusCode};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::document_token::{self, DocumentToken};
use weldsuite_books_domain::guards::{AuditInput, change, write_audit};
use weldsuite_books_domain::http::{BooksState, now, now_ms};
use weldsuite_books_domain::simple_pdf;
use weldsuite_books_domain::vendor_tax::sha256_hex;
use weldsuite_catalogs::entity_events::{INVOICE_VIEWED, QUOTE_ACCEPTED};
use weldsuite_db::{PgPool, Tenant, Workspaces, orm, utc_now};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_ports::{DynCache, MemoryCache, RequestCache};
use weldsuite_schema::tenant::{crm_quotes, invoices};

use super::view::{self, Document};
use super::{Links, append_history, entry, history_of, link_nonce, should_record_view};
use crate::finalize::{load_invoice, load_items};
use crate::persist::{owned, text};

/// Requests per minute from one address, and for one document.
const IP_LIMIT: i64 = 120;
const TOKEN_LIMIT: i64 = 60;
/// Writes (accepting, paying) are counted on their own.
const WRITE_LIMIT: i64 = 20;
const MAX_BODY_BYTES: usize = 10 * 1024;

#[derive(Clone)]
struct PublicState {
    books: BooksState,
    workspaces: Option<Arc<Workspaces>>,
}

/// The public routes at their full path. `workspaces` opens the tenant a
/// token leads to.
pub fn public_router<S>(state: &BooksState, workspaces: Option<Arc<Workspaces>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let routes = Router::new()
        .route("/{token}", get(document))
        .route("/{token}/pdf", get(pdf))
        .route("/{token}/pay", post(pay))
        .route("/{token}/accept", post(accept))
        .layer(axum::middleware::map_response(private_headers))
        .with_state(PublicState {
            books: state.clone(),
            workspaces: workspaces.clone(),
        });
    Router::new()
        .nest("/public/weldbooks/documents", routes)
        // Mollie's webhook and the OAuth callback (edition feature
        // `books-online-payments`).
        .merge(crate::online_payments::public_routes(state, workspaces))
}

async fn private_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    headers.insert(
        http::header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

pub(crate) fn answer(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn not_found() -> Response {
    answer(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found")
}

fn conflict(message: &str) -> Response {
    answer(StatusCode::CONFLICT, "CONFLICT", message)
}

fn server_error() -> Response {
    answer(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_ERROR",
        "Something went wrong",
    )
}

/// The caller: the `X-Forwarded-For` entry `trusted_proxies` from the right,
/// when it looks like an address.
pub(crate) fn client_ip(headers: &HeaderMap, trusted_proxies: usize) -> Option<String> {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .filter(|ip| {
            (2..=45).contains(&ip.len())
                && ip
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || matches!(b, b'.' | b':'))
        })
        .map(|ip| (*ip).to_owned())
}

fn fallback_cache() -> Arc<dyn DynCache> {
    static CACHE: OnceLock<Arc<MemoryCache>> = OnceLock::new();
    Arc::clone(CACHE.get_or_init(|| Arc::new(MemoryCache::new()))) as Arc<dyn DynCache>
}

/// The 429, when this address or this document has used up its minute.
pub(crate) async fn limited(
    cache: Option<Arc<dyn DynCache>>,
    ip: Option<&str>,
    token: &str,
    write: bool,
) -> Option<Response> {
    let cache = cache.unwrap_or_else(fallback_cache);
    let minute = now_ms().div_euclid(60_000);
    let token_key: String = sha256_hex(token).chars().take(16).collect();
    let scope = if write { "w" } else { "r" };
    let checks = [
        (
            format!("rl:bd:ip:{scope}:{}:{minute}", ip.unwrap_or("unknown")),
            if write { WRITE_LIMIT } else { IP_LIMIT },
        ),
        (
            format!("rl:bd:tok:{scope}:{token_key}:{minute}"),
            if write { WRITE_LIMIT } else { TOKEN_LIMIT },
        ),
    ];
    for (key, limit) in checks {
        match cache
            .increment_boxed(&key, 1, Some(Duration::from_secs(120)))
            .await
        {
            Ok(count) if count > limit => {
                let mut response = answer(
                    StatusCode::TOO_MANY_REQUESTS,
                    "RATE_LIMITED",
                    "Too many requests",
                );
                if let Ok(value) = HeaderValue::from_str(
                    &(60 - now_ms().div_euclid(1000).rem_euclid(60)).to_string(),
                ) {
                    response.headers_mut().insert("retry-after", value);
                }
                return Some(response);
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "[books-api/public-documents] rate limit failed"),
        }
    }
    None
}

/// A document a token leads to.
pub(crate) struct Opened {
    pub db: PgPool,
    /// The id events carry: the organization's where there is one.
    pub event_workspace_id: String,
    pub token: DocumentToken,
    /// The invoice or quote row.
    pub row: Value,
}

/// The row a verified token names, when it is still the document's current
/// link: the invoice's last `link` entry or the quote's `sent_at` made it.
pub(crate) async fn open_document(
    db: &PgPool,
    secret: &[u8],
    token: &DocumentToken,
) -> Result<Option<Value>, sea_orm::DbErr> {
    match token.t.as_str() {
        "invoice" => {
            let Some(invoice) = load_invoice(db, &token.id).await? else {
                return Ok(None);
            };
            let current = link_nonce(&history_of(&invoice));
            let sent = !matches!(text(&invoice, "status"), Some("draft") | None);
            Ok((sent && current.as_deref() == Some(token.n.as_str())).then_some(invoice))
        }
        "quote" => {
            let Some(quote) = load_quote(db, &token.id).await? else {
                return Ok(None);
            };
            let sent_at = text(&quote, "sentAt").and_then(weldsuite_books_domain::js::millis_of);
            Ok(sent_at
                .filter(|at| document_token::quote_nonce(secret, &token.id, *at) == token.n)
                .map(|_| quote))
        }
        _ => Ok(None),
    }
}

/// The live quote `id`, as the CRM's JSON.
pub(crate) async fn load_quote(db: &PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    crm_quotes::Entity::find_by_id(id.to_owned())
        .filter(crm_quotes::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|row| serde_json::to_value(row).map_err(|e| sea_orm::DbErr::Json(e.to_string())))
        .transpose()
}

fn shared_tenant(parts: &Parts) -> Option<Tenant> {
    parts.extensions.get::<Tenant>().cloned()
}

/// Resolve a token to its document, or the answer to give instead.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn resolve(
    state: &PublicState,
    parts: &Parts,
    text: &str,
    write: bool,
) -> Result<Opened, Response> {
    let ip = client_ip(&parts.headers, state.books.trusted_proxies);
    let cache = parts
        .extensions
        .get::<RequestCache>()
        .map(|c| Arc::clone(&c.0))
        .or_else(|| state.books.cache.clone());
    if let Some(refusal) = limited(cache, ip.as_deref(), text, write).await {
        return Err(refusal);
    }
    let Some(secret) = Links::secret(&state.books) else {
        tracing::error!("[books-api/public-documents] no signing key is configured");
        return Err(not_found());
    };
    let Ok(token) = document_token::verify(&secret, text) else {
        return Err(not_found());
    };
    let tenant = if let Some(tenant) = shared_tenant(parts) {
        tenant
    } else {
        let Some(workspaces) = &state.workspaces else {
            return Err(not_found());
        };
        workspaces.tenant(&token.ws).await.map_err(|error| {
            tracing::warn!(?error, "[books-api/public-documents] workspace not found");
            not_found()
        })?
    };
    // A token only opens the workspace it names.
    if tenant.suspended || tenant.workspace_id != token.ws {
        return Err(not_found());
    }
    let row = open_document(&tenant.db, &secret, &token)
        .await
        .map_err(|error| {
            tracing::error!(%error, "[books-api/public-documents] load failed");
            server_error()
        })?;
    let Some(row) = row else {
        return Err(not_found());
    };
    Ok(Opened {
        db: tenant.db.clone(),
        event_workspace_id: tenant
            .clerk_org_id
            .clone()
            .unwrap_or_else(|| tenant.workspace_id.clone()),
        token,
        row,
    })
}

fn parts_of(request: axum::extract::Request) -> (Parts, Bytes) {
    let (parts, _) = request.into_parts();
    (parts, Bytes::new())
}

// ── GET /:token ─────────────────────────────────────────────────────────────

async fn document(
    State(state): State<PublicState>,
    Path(text): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, _) = parts_of(request);
    let opened = match resolve(&state, &parts, &text, false).await {
        Ok(opened) => opened,
        Err(response) => return response,
    };
    let ip = client_ip(&parts.headers, state.books.trusted_proxies);
    match read(&opened, &state.books, ip.as_deref()).await {
        Ok(Some(doc)) => (StatusCode::OK, axum::Json(json!({ "data": doc.json }))).into_response(),
        Ok(None) => not_found(),
        Err(error) => {
            tracing::error!(%error, "[books-api/public-documents] read failed");
            server_error()
        }
    }
}

/// The default legal entity quotes are shown from.
async fn quote_entity(db: &PgPool) -> Result<Option<String>, sea_orm::DbErr> {
    default_entity_id_for(db, Some(LegalEntityApp::Weldbooks)).await
}

/// The document of an opened token, recording the opening.
pub(crate) async fn read(
    opened: &Opened,
    books: &BooksState,
    _ip: Option<&str>,
) -> Result<Option<Document>, sea_orm::DbErr> {
    let now = now_ms();
    let Some(doc) = build(opened, books, now).await? else {
        return Ok(None);
    };
    let id = &opened.token.id;
    if opened.token.t == "invoice" {
        let history = history_of(&opened.row);
        if should_record_view(&history, now) {
            let first = opened.row.get("viewedAt").is_none_or(Value::is_null);
            let touch = if first {
                vec![(invoices::Column::ViewedAt, Expr::value(utc_now()))]
            } else {
                Vec::new()
            };
            append_history(&opened.db, id, entry("viewed", json!({})), touch).await?;
            announce(
                books,
                opened,
                EntityEvent::new(
                    INVOICE_VIEWED,
                    id,
                    json!({
                        "id": id,
                        "invoiceNumber": opened.row["invoiceNumber"],
                        "status": opened.row["status"],
                        "contactId": opened.row["contactId"],
                    }),
                ),
            );
        }
    } else if opened.row.get("viewedAt").is_none_or(Value::is_null) {
        crm_quotes::Entity::update_many()
            .col_expr(crm_quotes::Column::ViewedAt, Expr::value(utc_now()))
            .filter(crm_quotes::Column::Id.eq(id.as_str()))
            .filter(crm_quotes::Column::ViewedAt.is_null())
            .exec(&orm(&opened.db))
            .await?;
    }
    Ok(Some(doc))
}

/// The customer's view of the opened document (`None`: nothing to show).
pub(crate) async fn build(
    opened: &Opened,
    books: &BooksState,
    now_ms: i64,
) -> Result<Option<Document>, sea_orm::DbErr> {
    if opened.token.t == "invoice" {
        let items = load_items(&opened.db, &opened.token.id, true).await?;
        let doc =
            view::invoice_document(&opened.db, &books.keyring, &opened.row, &items, now_ms).await?;
        // With Mollie connected, the page shows what can be paid online and
        // whether a payment is under way (edition feature `books-online-payments`).
        let Some(mut doc) = doc else {
            return Ok(None);
        };
        let status = doc.json["status"].as_str().unwrap_or_default().to_owned();
        if let Some(payment) =
            crate::online_payments::pay::document_payment(books, &opened.db, &opened.row, &status)
                .await?
        {
            doc.json["payment"] = payment;
        }
        Ok(Some(doc))
    } else {
        let Some(entity) = quote_entity(&opened.db).await? else {
            return Ok(None);
        };
        view::quote_document(&opened.db, &books.keyring, &opened.row, &entity, now_ms).await
    }
}

fn announce(books: &BooksState, opened: &Opened, event: EntityEvent) {
    let context = EventContext::new(
        opened.event_workspace_id.clone(),
        "pay-portal",
        EventSource::Api,
    );
    let publisher = books.events.clone();
    books.events.tracker().spawn(async move {
        publisher.publish_and_wait(&context, event).await;
    });
}

// ── GET /:token/pdf ─────────────────────────────────────────────────────────

async fn pdf(
    State(state): State<PublicState>,
    Path(text): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, _) = parts_of(request);
    let opened = match resolve(&state, &parts, &text, false).await {
        Ok(opened) => opened,
        Err(response) => return response,
    };
    match build(&opened, &state.books, now_ms()).await {
        Ok(Some(doc)) => {
            let safe: String = doc
                .number
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                        c
                    } else {
                        '-'
                    }
                })
                .collect();
            let mut response = (StatusCode::OK, simple_pdf::render(&doc.pdf)).into_response();
            let headers = response.headers_mut();
            headers.insert(
                http::header::CONTENT_TYPE,
                HeaderValue::from_static("application/pdf"),
            );
            if let Ok(value) = HeaderValue::from_str(&format!("inline; filename=\"{safe}.pdf\"")) {
                headers.insert(http::header::CONTENT_DISPOSITION, value);
            }
            response
        }
        Ok(None) => not_found(),
        Err(error) => {
            tracing::error!(%error, "[books-api/public-documents] pdf failed");
            server_error()
        }
    }
}

// ── POST /:token/pay ────────────────────────────────────────────────────────

/// `{ returnUrl }`: the portal's page the customer comes back to. Answers
/// `{ data: { checkoutUrl } }`; 409 when nothing is open to pay, 503 when
/// online payment is not set up for the entity or the invoice.
async fn pay(
    State(state): State<PublicState>,
    Path(text): Path<String>,
    request: axum::extract::Request,
) -> Response {
    use crate::online_payments::pay::{Outcome, start};
    let (parts, body) = request.into_parts();
    let opened = match resolve(&state, &parts, &text, true).await {
        Ok(opened) => opened,
        Err(response) => return response,
    };
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES + 1).await else {
        return answer(
            StatusCode::PAYLOAD_TOO_LARGE,
            "VALIDATION_ERROR",
            "The request is too large",
        );
    };
    let return_url = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|body| {
            body.get("returnUrl")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let Some(return_url) = return_url else {
        return answer(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "returnUrl is required",
        );
    };
    match start(&state.books, &opened, &return_url).await {
        Ok(Outcome::Checkout(url)) => (
            StatusCode::OK,
            axum::Json(json!({ "data": { "checkoutUrl": url } })),
        )
            .into_response(),
        Ok(Outcome::NothingToPay) => conflict("There is nothing to pay on this invoice"),
        Ok(Outcome::Unavailable(message)) => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "PAYMENT_UNAVAILABLE",
            message,
        ),
        Ok(Outcome::Invalid(message)) => {
            answer(StatusCode::BAD_REQUEST, "VALIDATION_ERROR", message)
        }
        Err(crate::online_payments::PayError::Refused(why)) => {
            tracing::warn!(%why, "[books-api/public-documents] Mollie refused the payment");
            answer(
                StatusCode::SERVICE_UNAVAILABLE,
                "PAYMENT_UNAVAILABLE",
                "Online payment is not available for this invoice",
            )
        }
        Err(crate::online_payments::PayError::Transient(why)) => {
            tracing::error!(%why, "[books-api/public-documents] Mollie could not be reached");
            answer(
                StatusCode::BAD_GATEWAY,
                "PROVIDER_ERROR",
                "The payment provider could not be reached",
            )
        }
        Err(crate::online_payments::PayError::NotConnected) => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "PAYMENT_UNAVAILABLE",
            "Online payment is not set up",
        ),
        Err(error) => {
            tracing::error!(%error, "[books-api/public-documents] pay failed");
            server_error()
        }
    }
}

// ── POST /:token/accept ─────────────────────────────────────────────────────

/// What the portal sends to accept.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Acceptance {
    pub name: String,
    pub email: String,
}

/// The checked body, or why it is not one.
pub(crate) fn read_acceptance(body: &[u8]) -> Result<Acceptance, &'static str> {
    if body.len() > MAX_BODY_BYTES {
        return Err("The request is too large");
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| "The body must be JSON")?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let email = value
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("name is required (at most 200 characters)");
    }
    let at = email.find('@');
    if email.len() > 320
        || email.contains(char::is_whitespace)
        || !at.is_some_and(|i| i > 0 && email[i + 1..].contains('.') && !email.ends_with('.'))
    {
        return Err("email must be an address");
    }
    if value.get("agree") != Some(&Value::Bool(true)) {
        return Err("agree must be true");
    }
    Ok(Acceptance {
        name: name.to_owned(),
        email: email.to_owned(),
    })
}

async fn accept(
    State(state): State<PublicState>,
    Path(text): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let opened = match resolve(&state, &parts, &text, true).await {
        Ok(opened) => opened,
        Err(response) => return response,
    };
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES + 1).await else {
        return answer(
            StatusCode::PAYLOAD_TOO_LARGE,
            "VALIDATION_ERROR",
            "The request is too large",
        );
    };
    let acceptance = match read_acceptance(&bytes) {
        Ok(acceptance) => acceptance,
        Err(message) => return answer(StatusCode::BAD_REQUEST, "VALIDATION_ERROR", message),
    };
    let ip = client_ip(&parts.headers, state.books.trusted_proxies);
    match accept_quote(&opened, &state.books, &acceptance, ip.as_deref()).await {
        Ok(Some((at, by))) => (
            StatusCode::OK,
            axum::Json(json!({ "data": { "acceptedAt": at, "acceptedBy": by } })),
        )
            .into_response(),
        Ok(None) => conflict("This quote cannot be accepted"),
        Err(error) => {
            tracing::error!(%error, "[books-api/public-documents] accept failed");
            server_error()
        }
    }
}

/// Accept the opened quote: `(acceptedAt, acceptedBy)`, or `None` when it
/// is not a quote that can be accepted (or was accepted in the meantime).
pub(crate) async fn accept_quote(
    opened: &Opened,
    books: &BooksState,
    acceptance: &Acceptance,
    ip: Option<&str>,
) -> Result<Option<(String, String)>, sea_orm::DbErr> {
    if opened.token.t != "quote" {
        return Ok(None);
    }
    let (_, can_accept) = view::quote_status(&opened.row, now_ms());
    if !can_accept {
        return Ok(None);
    }
    let id = opened.token.id.as_str();
    let at = now();
    let stamp = utc_now();
    // The e-mail and address have no column: they go into the internal notes.
    let note = format!(
        "Accepted online by {} <{}> from {} at {at}",
        acceptance.name,
        acceptance.email,
        ip.unwrap_or("an unknown address")
    );
    let notes = match owned(&opened.row, "internalNotes").filter(|n| !n.is_empty()) {
        Some(existing) => format!("{existing}\n{note}"),
        None => note,
    };
    let updated = crm_quotes::Entity::update_many()
        .col_expr(crm_quotes::Column::Status, Expr::value("accepted"))
        .col_expr(
            crm_quotes::Column::SignedBy,
            Expr::value(acceptance.name.clone()),
        )
        .col_expr(crm_quotes::Column::SignedAt, Expr::value(stamp))
        .col_expr(crm_quotes::Column::InternalNotes, Expr::value(notes))
        .col_expr(crm_quotes::Column::UpdatedAt, Expr::value(stamp))
        .filter(crm_quotes::Column::Id.eq(id))
        .filter(crm_quotes::Column::SignedAt.is_null())
        .filter(crm_quotes::Column::Status.ne("accepted"))
        .filter(crm_quotes::Column::DeletedAt.is_null())
        .exec(&orm(&opened.db))
        .await?;
    if updated.rows_affected == 0 {
        return Ok(None);
    }
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(opened.row["status"].clone(), json!("accepted")),
    );
    changes.insert(
        "signedBy".into(),
        change(Value::Null, json!(acceptance.name)),
    );
    write_audit(
        &opened.db,
        AuditInput {
            accounting_entity_id: None,
            entity_type: "quote",
            entity_id: id,
            action: "accepted",
            changes: Some(changes),
        },
        None,
        ip,
    )
    .await;
    announce(
        books,
        opened,
        EntityEvent::new(
            QUOTE_ACCEPTED,
            id,
            json!({
                "id": id,
                "quoteNumber": opened.row["quoteNumber"],
                "status": "accepted",
                "total": opened.row["total"],
                "currency": opened.row["currency"],
                "signedBy": acceptance.name,
            }),
        ),
    );
    Ok(Some((at, acceptance.name.clone())))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    #[test]
    fn an_acceptance_needs_a_name_an_address_and_the_tick() {
        let ok = br#"{"name":" Piet Jansen ","email":"piet@example.com","agree":true}"#;
        assert_eq!(
            read_acceptance(ok),
            Ok(Acceptance {
                name: "Piet Jansen".into(),
                email: "piet@example.com".into()
            })
        );
        for bad in [
            &br#"{"name":"","email":"a@b.nl","agree":true}"#[..],
            br#"{"name":"P","email":"nope","agree":true}"#,
            br#"{"name":"P","email":"a b@c.nl","agree":true}"#,
            br#"{"name":"P","email":"a@b.nl","agree":false}"#,
            br#"{"name":"P","email":"a@b.nl"}"#,
            br#"{"name":"P","email":"a@b.nl","agree":"true"}"#,
            b"not json",
        ] {
            assert!(
                read_acceptance(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        assert!(read_acceptance(&vec![b' '; MAX_BODY_BYTES + 1]).is_err());
    }

    #[test]
    fn the_caller_is_the_address_the_ingress_appended() {
        let mut headers = HeaderMap::new();
        assert_eq!(client_ip(&headers, 1), None);
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 203.0.113.9"),
        );
        assert_eq!(client_ip(&headers, 1).as_deref(), Some("203.0.113.9"));
        assert_eq!(client_ip(&headers, 2).as_deref(), Some("6.6.6.6"));
    }

    #[tokio::test]
    async fn requests_are_counted_per_address_and_per_token() {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        for _ in 0..TOKEN_LIMIT {
            assert!(
                limited(Some(Arc::clone(&cache)), Some("1.1.1.1"), "tok", false)
                    .await
                    .is_none()
            );
        }
        let refused = limited(Some(Arc::clone(&cache)), Some("1.1.1.1"), "tok", false)
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        // Another document from another address is not affected.
        assert!(
            limited(Some(Arc::clone(&cache)), Some("2.2.2.2"), "other", false)
                .await
                .is_none()
        );
        // Writes are counted apart.
        assert!(
            limited(Some(cache), Some("1.1.1.1"), "tok", true)
                .await
                .is_none()
        );
    }
}
