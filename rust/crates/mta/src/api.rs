//! The MTA's HTTP API (private network, `Authorization: Bearer
//! <MTA_API_SECRET>`): sending domains and queue counts for the server, and
//! health for the probes. Shapes: the contract in
//! `docs/plans/eu-mail-service.md`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::crypto::Keys;
use crate::domains::{self, DomainError, DomainView, Signers};
use crate::store::Store;

#[derive(Clone)]
pub struct ApiState {
    pub store: Store,
    pub keys: Keys,
    pub secret: Arc<str>,
    pub signers: Arc<Signers>,
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn authorized(state: &ApiState, headers: &HeaderMap) -> bool {
    let Some(value) = headers.get("authorization").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    let expected = state.secret.as_bytes();
    token.len() == expected.len()
        && token
            .bytes()
            .zip(expected)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

macro_rules! guard {
    ($state:expr, $headers:expr) => {
        if !authorized(&$state, &$headers) {
            return error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "bearer token required",
            );
        }
    };
}

fn domain_failure(failure: &DomainError) -> Response {
    match failure {
        DomainError::Invalid(message) => error(StatusCode::BAD_REQUEST, "invalid_domain", message),
        other => {
            tracing::error!(error = %other, "domain operation failed");
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "try again later",
            )
        }
    }
}

#[derive(Debug, Deserialize)]
struct CreateDomain {
    domain: String,
    #[serde(default)]
    pools: Vec<String>,
}

async fn create_domain(
    State(state): State<ApiState>,
    headers: HeaderMap,
    body: Result<Json<CreateDomain>, axum::extract::rejection::JsonRejection>,
) -> Response {
    guard!(state, headers);
    let Ok(Json(body)) = body else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_body",
            "expected {\"domain\", \"pools\"}",
        );
    };
    match domains::register(&state.store, &state.keys, &body.domain, &body.pools).await {
        Ok((view, created)) => {
            state.signers.forget(&view.domain);
            let status = if created {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            };
            (status, Json(view)).into_response()
        }
        Err(failure) => domain_failure(&failure),
    }
}

async fn list_domains(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    guard!(state, headers);
    match state.store.domains().await {
        Ok(rows) => Json(json!({ "data": rows.iter().map(DomainView::from).collect::<Vec<_>>() }))
            .into_response(),
        Err(failure) => domain_failure(&DomainError::Store(failure)),
    }
}

async fn get_domain(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(domain): Path<String>,
) -> Response {
    guard!(state, headers);
    match state.store.domain(&domain).await {
        Ok(Some(row)) => Json(DomainView::from(&row)).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found", "domain not registered"),
        Err(failure) => domain_failure(&DomainError::Store(failure)),
    }
}

async fn delete_domain(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Path(domain): Path<String>,
) -> Response {
    guard!(state, headers);
    match state.store.delete_domain(&domain).await {
        Ok(true) => {
            state.signers.forget(&domain);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "domain not registered"),
        Err(failure) => domain_failure(&DomainError::Store(failure)),
    }
}

async fn queue(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    guard!(state, headers);
    match state.store.stats().await {
        Ok(counts) => Json(json!({ "data": counts })).into_response(),
        Err(failure) => domain_failure(&DomainError::Store(failure)),
    }
}

async fn healthz() -> &'static str {
    "ok"
}

async fn readyz(State(state): State<ApiState>) -> Response {
    match state.store.ping().await {
        Ok(()) => "ready".into_response(),
        Err(_) => (StatusCode::SERVICE_UNAVAILABLE, "database unavailable").into_response(),
    }
}

pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/v1/domains", get(list_domains).post(create_domain))
        .route(
            "/v1/domains/{domain}",
            get(get_domain).delete(delete_domain),
        )
        .route("/v1/queue", get(queue))
        .with_state(state)
}
