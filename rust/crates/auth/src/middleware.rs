use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use weldsuite_kit::ApiError;

use crate::{AuthContext, ClerkVerifier};

/// Middleware: `axum::middleware::from_fn_with_state(verifier, clerk_auth)`.
/// Verifies the bearer token and puts the [`AuthContext`] in the request
/// extensions, or answers 401 as `clerkMiddleware` does.
pub async fn clerk_auth(
    State(verifier): State<Arc<ClerkVerifier>>,
    mut request: Request,
    next: Next,
) -> Response {
    let authorization = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    match verifier.authenticate(authorization, now) {
        Ok(context) => {
            request.extensions_mut().insert(context);
            next.run(request).await
        }
        Err(error) => error.into_response(),
    }
}

/// Handlers take `AuthContext` as an argument. Without [`clerk_auth`] in
/// front of the route there is none, which answers 401.
impl<S: Send + Sync> FromRequestParts<S> for AuthContext {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        // Reading the extensions needs no await.
        std::future::ready(
            parts
                .extensions
                .get::<AuthContext>()
                .cloned()
                .ok_or_else(ApiError::unauthorized),
        )
    }
}
