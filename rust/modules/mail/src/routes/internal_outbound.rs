//! `/internal/outbound` (`routes/internal-outbound/index.ts`): the outbound
//! guard's staff API, called server to server by the admin console. Not
//! behind a session: the console sends `OUTBOUND_ADMIN_SECRET` as
//! `x-admin-secret` and the acting admin as `x-admin-email`
//! (`lib/admin-auth.ts`). It reaches what only the backend can: the ledgers.
//!
//! - `GET  /inspect?workspaceId=`  usage, risk, shadow-mode denials
//! - `POST /refresh  { workspaceId }`  reload the policy now
//! - `POST /review   { workspaceId }`  AI-review today's top template
//! - `GET  /platform`  the platform budget
//! - `POST /sending-events/subscribe { domains }`  backfill the relay's event
//!   subscriptions; on Kubernetes the relay's webhook carries the events, so
//!   every domain answers `false`, as the worker does without Cloudflare
//!   credentials (ADR MAIL-010).

#![allow(clippy::result_large_err)] // the helpers return the response a check ends with

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use weldsuite_kit::validation::{Format, Issues, Presence, Text, json_body};
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::outbound::LedgerSubject;

use crate::MailState;
use crate::caller::{Bindings, Outside};

pub(crate) fn routes<S>(state: MailState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/inspect", get(inspect))
        .route("/refresh", post(refresh))
        .route("/review", post(review))
        .route("/platform", get(platform))
        .route("/sending-events/subscribe", post(subscribe))
        .with_state(state)
}

/// A short secret is a misconfiguration, not a credential.
const MIN_SECRET_LENGTH: usize = 32;

fn error(status: StatusCode, code: &'static str, message: &str) -> Response {
    ApiError::new(status, code, message).into_response()
}

/// `adminAuth()`: 503 when the secret isn't configured (or is short), 401 on
/// a wrong or missing one, 400 without the acting admin. The admin's email
/// on success.
fn admin_auth(
    state: &MailState,
    bindings: &Bindings,
    headers: &HeaderMap,
) -> Result<String, Response> {
    let expected = bindings
        .env_value(state, "OUTBOUND_ADMIN_SECRET")
        .filter(|secret| secret.chars().map(char::len_utf16).sum::<usize>() >= MIN_SECRET_LENGTH);
    let Some(expected) = expected else {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NOT_CONFIGURED",
            "The admin API is not configured",
        ));
    };
    let provided = headers
        .get("x-admin-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // Constant time: both sides hashed to equal length first.
    let (a, b) = (
        Sha256::digest(provided.as_bytes()),
        Sha256::digest(expected.as_bytes()),
    );
    let diff = a
        .iter()
        .zip(b.iter())
        .fold(0_u8, |acc, (x, y)| acc | (x ^ y));
    if diff != 0 {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Unauthorized",
        ));
    }
    let email = headers
        .get("x-admin-email")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim().to_lowercase())
        .filter(|email| is_admin_email(email));
    email.ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "x-admin-email must identify the acting admin",
        )
    })
}

/// `z.string().email().max(255)`.
fn is_admin_email(email: &str) -> bool {
    if email.is_empty() {
        return false;
    }
    let mut body = Map::new();
    body.insert("email".to_owned(), Value::from(email));
    let mut issues = Issues::default();
    issues.text_with(
        &body,
        "email",
        Presence::Required,
        Text {
            format: Some(Format::Email),
            ..Text::length(None, Some(255))
        },
    );
    issues.is_empty()
}

/// `workspaceSubject(env, workspaceId)`: the master workspace, or `None`.
async fn workspace_subject(
    state: &MailState,
    bindings: &Bindings,
    workspace_id: &str,
) -> Result<Option<LedgerSubject>, Response> {
    let Some(master) = bindings.master(state) else {
        return Err(ApiError::internal().into_response());
    };
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("select id, clerk_org_id from workspaces where id = $1 limit 1")
            .bind(workspace_id)
            .fetch_optional(&master)
            .await
            .map_err(|error| {
                tracing::error!(%error, "[internal-outbound] workspace lookup failed");
                ApiError::internal().into_response()
            })?;
    Ok(row.map(|(id, clerk_org_id)| LedgerSubject::Workspace {
        workspace_id: id,
        clerk_org_id,
    }))
}

fn no_ledger() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "NOT_CONFIGURED",
        "No ledger binding",
    )
}

/// `{ workspaceId: z.string().min(1).max(255) }`.
fn workspace_body(headers: &HeaderMap, body: &Bytes) -> Result<String, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let value = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let workspace_id = issues.object(&value).map(|object| {
        issues.text(
            object,
            "workspaceId",
            Presence::Required,
            Some(1),
            Some(255),
        )
    });
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(workspace_id
        .and_then(weldsuite_kit::validation::Field::into_option)
        .unwrap_or_default())
}

/// `GET /inspect`.
async fn inspect(
    State(state): State<MailState>,
    Outside(bindings): Outside,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(response) = admin_auth(&state, &bindings, &headers) {
        return response;
    }
    let Some(workspace_id) = query.get("workspaceId").filter(|id| !id.is_empty()) else {
        return ApiError::bad_request("workspaceId is required").into_response();
    };
    let Some(ledger) = bindings.outbound(&state).ledger else {
        return no_ledger();
    };
    let subject = match workspace_subject(&state, &bindings, workspace_id).await {
        Ok(Some(subject)) => subject,
        Ok(None) => return ApiError::not_found("Workspace", Some(workspace_id)).into_response(),
        Err(response) => return response,
    };
    match ledger.inspect(&subject.ledger_key(), &subject).await {
        Ok(inspection) => Data(inspection).into_response(),
        Err(error) => {
            tracing::error!(%error, "[internal-outbound] inspect failed");
            ApiError::internal().into_response()
        }
    }
}

/// The admin, the body and the ledger of a staff POST.
async fn staff_post(
    state: &MailState,
    bindings: &Bindings,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(String, LedgerSubject), Response> {
    let admin = admin_auth(state, bindings, headers)?;
    let workspace_id = workspace_body(headers, body)?;
    if bindings.outbound(state).ledger.is_none() {
        return Err(no_ledger());
    }
    match workspace_subject(state, bindings, &workspace_id).await? {
        Some(subject) => Ok((admin, subject)),
        None => Err(ApiError::not_found("Workspace", None).into_response()),
    }
}

/// `POST /refresh`.
async fn refresh(
    State(state): State<MailState>,
    Outside(bindings): Outside,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (admin, subject) = match staff_post(&state, &bindings, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let Some(ledger) = bindings.outbound(&state).ledger else {
        return no_ledger();
    };
    if let Err(error) = ledger.refresh_policy(&subject.ledger_key()).await {
        tracing::error!(%error, "[internal-outbound] refresh failed");
        return ApiError::internal().into_response();
    }
    tracing::info!(
        "{}",
        json!({ "event": "outbound_policy_refreshed", "workspaceId": subject.workspace_id(), "by": admin })
    );
    Data(json!({ "ok": true })).into_response()
}

/// `POST /review`.
async fn review(
    State(state): State<MailState>,
    Outside(bindings): Outside,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (admin, subject) = match staff_post(&state, &bindings, &headers, &body).await {
        Ok(found) => found,
        Err(response) => return response,
    };
    let Some(ledger) = bindings.outbound(&state).ledger else {
        return no_ledger();
    };
    match ledger.request_review(&subject.ledger_key(), &subject).await {
        Ok(queued) => {
            tracing::info!(
                "{}",
                json!({ "event": "outbound_review_requested", "workspaceId": subject.workspace_id(), "by": admin, "queued": queued })
            );
            Data(json!({ "queued": queued })).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "[internal-outbound] review failed");
            ApiError::internal().into_response()
        }
    }
}

/// `GET /platform`.
async fn platform(
    State(state): State<MailState>,
    Outside(bindings): Outside,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = admin_auth(&state, &bindings, &headers) {
        return response;
    }
    let Some(platform) = bindings.outbound(&state).platform else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "NOT_CONFIGURED",
            "No platform budget binding",
        );
    };
    match platform.status().await {
        Ok(status) => Data(status).into_response(),
        Err(error) => {
            tracing::error!(%error, "[internal-outbound] platform status failed");
            ApiError::internal().into_response()
        }
    }
}

/// `POST /sending-events/subscribe { domains }`.
async fn subscribe(
    State(state): State<MailState>,
    Outside(bindings): Outside,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = admin_auth(&state, &bindings, &headers) {
        return response;
    }
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let value = match json_body(content_type, &body) {
        Ok(value) => value,
        Err(malformed) => return malformed.into_response(),
    };
    let mut issues = Issues::default();
    let domains = issues.object(&value).map(|object| {
        let rules = Text {
            trim: true,
            lowercase: true,
            ..Text::length(Some(3), Some(253))
        };
        issues.list(
            object,
            "domains",
            Presence::Required,
            Some(1),
            Some(100),
            |issues, item| issues.item_text(item, rules),
        )
    });
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let mut results = Map::new();
    for domain in domains
        .and_then(weldsuite_kit::validation::Field::into_option)
        .unwrap_or_default()
    {
        // No Cloudflare queue subscriptions here: the relay's webhook
        // delivers the events.
        results.insert(domain, Value::Bool(false));
    }
    Data(json!({ "results": results })).into_response()
}
