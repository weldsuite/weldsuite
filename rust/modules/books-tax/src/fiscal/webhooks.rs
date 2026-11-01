//! `/public/fiscal-webhooks/:token` (`routes/public-fiscal-webhooks`):
//! Focus NFe's call when a document changed. No session: the token in the
//! path finds the workspace through the cache (`fiscalhook:<hash>`), the
//! secret Focus echoes is checked against its hash, and the payload only
//! names the reference: the status comes from a fresh read, after the
//! answer. Unknown tokens 404, a wrong secret 401, an unknown reference 200
//! with nothing done; bodies over 64 KB 413.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderValue, StatusCode};
use serde_json::{Value, json};
use weldsuite_books_domain::guards::{AuditInput, change, write_audit};
use weldsuite_books_domain::http::BooksState;
use weldsuite_books_domain::tables::FISCAL_DOCUMENTS;
use weldsuite_books_domain::vendor_tax::sha256_hex;
use weldsuite_catalogs::entity_events::{FISCAL_DOCUMENT_CANCELLED, FISCAL_DOCUMENT_UPDATED};
use weldsuite_db::{Keyring, Tenant, Workspaces};
use weldsuite_events::{EntityEvent, EventContext, EventSource};
use weldsuite_kit::RequestEnv;
use weldsuite_ports::{DynCache, OutboundHttp, RequestCache};

use super::documents::{event_data, refresh_document};
use super::settings::{hook_key, timing_safe_equal_hex};

/// `FISCAL_WEBHOOK_MAX_BODY_BYTES`.
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Clone)]
struct PublicState {
    books: BooksState,
    workspaces: Option<Arc<Workspaces>>,
}

/// The webhook route at its full path.
pub fn public_router<S>(state: &BooksState, workspaces: Option<Arc<Workspaces>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let routes = Router::new()
        .route("/{token}", post(deliver))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES * 4))
        .layer(axum::middleware::map_response(no_store))
        .with_state(PublicState {
            books: state.clone(),
            workspaces,
        });
    Router::new().nest("/public/fiscal-webhooks", routes)
}

async fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(http::header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    response
}

fn answer(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// What the request carries in place of a session (conformance: the test's
/// tenant, cache, env and outbound HTTP).
struct Shared {
    tenant: Option<Tenant>,
    cache: Option<RequestCache>,
    env: Option<RequestEnv>,
    http: Option<OutboundHttp>,
}

impl Shared {
    fn cache(&self, state: &PublicState) -> Option<Arc<dyn DynCache>> {
        self.cache
            .as_ref()
            .map(|cache| Arc::clone(&cache.0))
            .or_else(|| state.books.cache.clone())
    }

    fn keyring(&self, state: &PublicState) -> Keyring {
        match &self.env {
            Some(env) => Keyring {
                v1: env
                    .get("DATABASE_ENCRYPTION_KEY")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
                v2: env
                    .get("DATABASE_ENCRYPTION_KEY_V2")
                    .filter(|k| !k.is_empty())
                    .map(str::to_owned),
            },
            None => state.books.keyring.clone(),
        }
    }
}

/// The secret Focus echoes, without a `Bearer ` prefix.
fn echoed_secret(parts: &Parts) -> String {
    let raw = parts
        .headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let space = weldsuite_books_domain::jurisdictions::is_js_space;
    let rest = match (raw.get(..6), raw.get(6..)) {
        (Some(prefix), Some(rest)) if prefix.eq_ignore_ascii_case("bearer") && rest.starts_with(space) => {
            rest.trim_start_matches(space)
        }
        _ => raw,
    };
    weldsuite_books_domain::jurisdictions::js_trim(rest).to_owned()
}

async fn deliver(
    State(state): State<PublicState>,
    Path(token): Path<String>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let declared = parts
        .headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map_or(0.0, weldsuite_kit::validation::js_number);
    #[allow(clippy::cast_precision_loss)]
    if declared > MAX_BODY_BYTES as f64 {
        return answer(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "The payload is too large");
    }
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES * 4).await else {
        return answer(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "The payload is too large");
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() > MAX_BODY_BYTES {
        return answer(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE", "The payload is too large");
    }
    let shared = Shared {
        tenant: parts.extensions.get::<Tenant>().cloned(),
        cache: parts.extensions.get::<RequestCache>().cloned(),
        env: parts.extensions.get::<RequestEnv>().cloned(),
        http: parts
            .extensions
            .get::<OutboundHttp>()
            .cloned()
            .or_else(|| state.books.http.clone()),
    };

    let token_hash = sha256_hex(&token);
    let entry = match shared.cache(&state) {
        Some(cache) => cache.get_boxed(&hook_key(&token_hash)).await.ok().flatten(),
        None => None,
    };
    let entry: Value = entry
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    let field = |key: &str| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let (Some(org_id), Some(entity_id), Some(secret_hash)) =
        (field("orgId"), field("entityId"), field("secretHash"))
    else {
        return answer(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found");
    };
    if !timing_safe_equal_hex(&sha256_hex(&echoed_secret(&parts)), &secret_hash) {
        return answer(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Unauthorized");
    }
    let reference = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| body.get("ref").and_then(Value::as_str).map(str::to_owned))
        .filter(|r| !r.is_empty());
    if let Some(reference) = reference {
        let environment = entry
            .get("environment")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let keyring = shared.keyring(&state);
        let http = shared.http.clone();
        let tenant = shared.tenant.clone();
        let workspaces = state.workspaces.clone();
        let books = state.books.clone();
        let ip = parts
            .headers
            .get("cf-connecting-ip")
            .or_else(|| parts.headers.get("x-forwarded-for"))
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        state.books.events.tracker().spawn(async move {
            let tenant = match tenant {
                Some(tenant) => Some(tenant),
                None => match &workspaces {
                    Some(workspaces) => workspaces.tenant(&org_id).await.ok(),
                    None => None,
                },
            };
            let Some(tenant) = tenant else {
                tracing::error!("[books-api/public-fiscal-webhooks] refresh failed: no tenant");
                return;
            };
            refresh_from_webhook(&books, &tenant, &keyring, http, &entity_id, environment.as_deref(), &reference, ip.as_deref()).await;
        });
    }
    (StatusCode::OK, axum::Json(json!({ "data": { "received": true } }))).into_response()
}

/// `refreshFromWebhook(...)`: re-read the document behind `ref` and publish
/// what changed. Never fails: the delivery is already answered.
#[allow(clippy::too_many_arguments)]
async fn refresh_from_webhook(
    books: &BooksState,
    tenant: &Tenant,
    keyring: &Keyring,
    http: Option<OutboundHttp>,
    entity_id: &str,
    environment: Option<&str>,
    reference: &str,
    ip: Option<&str>,
) {
    if tenant.suspended {
        return;
    }
    let db = &tenant.db;
    let doc: Result<Option<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fiscal_documents),
        " from fiscal_documents t where t.entity_id = $1 and t.provider = 'focus_nfe' \
         and t.provider_ref = $2 and t.environment = $3 limit 1"
    ))
    .bind(entity_id)
    .bind(reference)
    .bind(environment)
    .fetch_optional(db)
    .await;
    let doc = match doc {
        Ok(Some(row)) => FISCAL_DOCUMENTS.js(row),
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%error, "[books-api/public-fiscal-webhooks] refresh failed");
            return;
        }
    };
    let refreshed = match refresh_document(db, keyring, http, &doc).await {
        Ok(refreshed) => refreshed,
        Err(_) => {
            tracing::error!("[books-api/public-fiscal-webhooks] refresh failed");
            return;
        }
    };
    if !refreshed.changed {
        return;
    }
    let document = refreshed.document;
    let id = document["id"].as_str().unwrap_or_default().to_owned();
    let mut changes = serde_json::Map::new();
    changes.insert(
        "status".into(),
        change(json!(refreshed.previous_status), document["status"].clone()),
    );
    write_audit(
        db,
        AuditInput {
            accounting_entity_id: document["entityId"].as_str(),
            entity_type: "fiscal_document",
            entity_id: &id,
            action: "refreshed",
            changes: Some(changes),
        },
        None,
        ip,
    )
    .await;
    let event = if document["status"].as_str() == Some("cancelled") {
        FISCAL_DOCUMENT_CANCELLED
    } else {
        FISCAL_DOCUMENT_UPDATED
    };
    let context = EventContext::new(tenant.workspace_id.clone(), "fiscal-webhook", EventSource::Api);
    books
        .events
        .publish_and_wait(&context, EntityEvent::new(event, &id, event_data(&document)))
        .await;
}
