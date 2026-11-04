//! WeldKnow rules shared by the know API (`modules/know`) and the public API
//! (`modules/external-api`): `@weldsuite/know-domain`.
//!
//! [`access`] is who may see, read, write and manage which space; a
//! workspace API key (no user) reaches open teamspaces only.

pub mod access;
pub mod pages;

use axum::response::{IntoResponse, Response};
use weldsuite_kit::ApiError;

/// What the access rules and the routes refuse with, mapped onto the
/// envelope by [`KnowError::respond`] (`accessError`).
#[derive(Debug)]
pub enum KnowError {
    /// 404: `<resource> with ID '<id>' not found`.
    NotFound {
        resource: &'static str,
        id: String,
    },
    /// 403 with the message.
    Forbidden(&'static str),
    /// 409 with the message.
    Conflict(&'static str),
    Database(sqlx::Error),
}

impl KnowError {
    #[must_use]
    pub fn not_found(resource: &'static str, id: &str) -> Self {
        Self::NotFound {
            resource,
            id: id.to_owned(),
        }
    }

    /// The response; anything unexpected is logged and answered with a 500
    /// carrying `fallback`.
    #[must_use]
    pub fn respond(self, fallback: &'static str) -> Response {
        match self {
            Self::NotFound { resource, id } => {
                ApiError::not_found(resource, Some(&id)).into_response()
            }
            Self::Forbidden(message) => ApiError::forbidden().with_message(message).into_response(),
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Database(error) => {
                tracing::error!(%error, "[know-api/knowledge] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for KnowError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}
