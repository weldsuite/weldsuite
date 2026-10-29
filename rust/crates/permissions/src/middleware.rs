//! The request side (`server/middleware.ts`, `server/app-context.ts`):
//!
//! - [`app_context`] reads `X-Weld-App` into an [`AppContext`];
//! - [`PermissionGate::require`] is `requirePermission(...)`: a route layer
//!   that resolves the caller's permissions once per request and answers 403
//!   unless one of the keys is allowed in the request's app;
//! - [`Permissions`] is the extractor for checks inside a handler
//!   (`hasContextPermission`), available behind any gate layer.

use std::collections::HashSet;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};

use axum::extract::{FromRequestParts, Request};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{Extensions, StatusCode};
use serde_json::json;
use tower::{Layer, Service};
use weldsuite_auth::AuthContext;
use weldsuite_kit::{ApiError, log_safe};

use crate::app_scope::{AppCheckMode, check_app_permission};
use crate::apps::{APP_CONTEXT_HEADER, WORKSPACE_APP_CONTEXT, normalize_app_code};
use crate::resolver::{PermissionQueries, ResolvedPermissions, resolve_effective_permissions};

/// The request's canonical app code, from `X-Weld-App`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppContext(pub &'static str);

/// Middleware: `axum::middleware::from_fn(app_context)`. A missing header,
/// `workspace` or an unknown code leaves no [`AppContext`], which makes checks
/// fall back to "allowed in any app"; naming another app could never unlock
/// more than that.
pub async fn app_context(mut request: Request, next: Next) -> Response {
    let raw = request
        .headers()
        .get(APP_CONTEXT_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|raw| !raw.trim().eq_ignore_ascii_case(WORKSPACE_APP_CONTEXT))
        .filter(|raw| !raw.is_empty());
    if let Some(raw) = raw {
        if let Some(app) = normalize_app_code(raw) {
            request.extensions_mut().insert(AppContext(app));
        } else {
            tracing::warn!(
                value = %log_safe(raw),
                "permissions: ignoring unknown {APP_CONTEXT_HEADER} value"
            );
        }
    }
    next.run(request).await
}

/// Builds the per-request lookups from the request extensions (where the
/// tenant database handle lives).
type MakeQueries<Q> = dyn Fn(&Extensions) -> Result<Q, ApiError> + Send + Sync;

/// Shared configuration of the permission layers.
pub struct PermissionGate<Q> {
    make_queries: Box<MakeQueries<Q>>,
    app_enforced: bool,
}

impl<Q> std::fmt::Debug for PermissionGate<Q> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PermissionGate")
            .field("app_enforced", &self.app_enforced)
            .finish_non_exhaustive()
    }
}

impl<Q: PermissionQueries + 'static> PermissionGate<Q> {
    pub fn new(
        make_queries: impl Fn(&Extensions) -> Result<Q, ApiError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            make_queries: Box::new(make_queries),
            app_enforced: false,
        }
    }

    /// Enforce per-app refusals (`PERMISSIONS_APP_ENFORCE=true`). Off, a key
    /// refused in the request's app but granted in another app goes through
    /// with a warning, so the rollout can't lock anyone out.
    #[must_use]
    pub fn app_enforced(mut self, enforced: bool) -> Self {
        self.app_enforced = enforced;
        self
    }

    /// `requirePermission(...keys)`: the caller needs at least one of `keys`.
    pub fn require<K: Into<String>>(
        self: &Arc<Self>,
        keys: impl IntoIterator<Item = K>,
    ) -> PermissionLayer<Q> {
        PermissionLayer {
            gate: Arc::clone(self),
            required: Some(keys.into_iter().map(Into::into).collect()),
        }
    }

    /// Resolve the caller's permissions without requiring any key, for
    /// routes that only check inside the handler (`ensurePermissionsResolved`).
    pub fn resolve(self: &Arc<Self>) -> PermissionLayer<Q> {
        PermissionLayer {
            gate: Arc::clone(self),
            required: None,
        }
    }

    /// The request's [`Permissions`], resolved now or taken from an earlier
    /// layer on the same request.
    async fn permissions_for(&self, request: &mut Request) -> Result<Permissions, Box<Response>> {
        if let Some(permissions) = request.extensions().get::<Permissions>() {
            return Ok(permissions.clone());
        }
        let Some(user_id) = request
            .extensions()
            .get::<AuthContext>()
            .map(|auth| auth.user_id.clone())
        else {
            return Err(Box::new(envelope(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authentication required",
            )));
        };
        let queries = (self.make_queries)(request.extensions())
            .map_err(|error| Box::new(error.into_response()))?;
        let resolved = resolve_effective_permissions(&queries, &user_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, "permissions: resolving the member failed");
                Box::new(ApiError::internal().into_response())
            })?;
        let permissions = Permissions {
            resolved: Arc::new(resolved),
            app: request.extensions().get::<AppContext>().map(|app| app.0),
            app_enforced: self.app_enforced,
            user_id,
        };
        request.extensions_mut().insert(permissions.clone());
        Ok(permissions)
    }
}

/// The 401/403 body `requirePermission` sends, `success: false` included.
fn envelope(status: StatusCode, code: &str, message: &str) -> Response {
    let body = json!({ "success": false, "error": { "code": code, "message": message } });
    (status, axum::Json(body)).into_response()
}

/// The caller's resolved permissions in this request's app context.
#[derive(Debug, Clone)]
pub struct Permissions {
    resolved: Arc<ResolvedPermissions>,
    app: Option<&'static str>,
    app_enforced: bool,
    user_id: String,
}

impl Permissions {
    /// Permissions resolved elsewhere: by a test harness (conformance mode)
    /// or by a caller that already holds them. Inserted into the request
    /// extensions, a gate layer uses them instead of resolving again.
    pub fn new(
        resolved: ResolvedPermissions,
        app: Option<&'static str>,
        app_enforced: bool,
        user_id: String,
    ) -> Self {
        Self {
            resolved: Arc::new(resolved),
            app,
            app_enforced,
            user_id,
        }
    }

    pub fn resolved(&self) -> &ResolvedPermissions {
        &self.resolved
    }

    /// The request's app, if it named one.
    pub fn app(&self) -> Option<&'static str> {
        self.app
    }

    /// Whether per-app refusals are enforced; `/me/permissions` reports it so
    /// the UI applies the same rule.
    pub fn app_enforced(&self) -> bool {
        self.app_enforced
    }

    /// Is at least one of `required` allowed here (`hasContextPermission`)?
    pub fn has_any<R: AsRef<str>>(&self, required: &[R]) -> bool {
        evaluate_in_app_context(
            &self.resolved,
            required,
            self.app,
            self.app_enforced,
            &self.user_id,
        )
    }
}

/// Available behind [`PermissionGate::require`] or [`PermissionGate::resolve`];
/// without one there is nothing to read, which is a routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Permissions {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(parts.extensions.get::<Self>().cloned().ok_or_else(|| {
            tracing::error!("permissions: Permissions extracted on a route without a gate layer");
            ApiError::internal()
        }))
    }
}

/// "Any of `required`" in the app context, including the log-only
/// pass-through (`evaluateInAppContext`).
fn evaluate_in_app_context<R: AsRef<str>>(
    resolved: &ResolvedPermissions,
    required: &[R],
    app: Option<&str>,
    app_enforced: bool,
    user_id: &str,
) -> bool {
    let mut refused_in_app: Option<&str> = None;
    for key in required.iter().map(AsRef::as_ref) {
        let check = check_app_permission(resolved, key, app);
        if check.object_not_in_app {
            warn_once(&format!("nia|{app:?}|{key}"), || {
                tracing::warn!(
                    key,
                    app,
                    "permissions: object is not registered in the app; checked across all apps"
                );
            });
        }
        if check.allowed {
            return true;
        }
        if check.mode == AppCheckMode::App
            && refused_in_app.is_none()
            && check_app_permission(resolved, key, None).allowed
        {
            refused_in_app = Some(key);
        }
    }

    match refused_in_app {
        Some(key) if !app_enforced => {
            warn_once(&format!("ref|{app:?}|{key}|{user_id}"), || {
                tracing::warn!(
                    key,
                    app,
                    user_id,
                    "permissions: not granted in this app; allowed (log-only mode)"
                );
            });
            true
        }
        _ => false,
    }
}

/// Log each distinct warning once per process, as the workers do per isolate.
fn warn_once(key: &str, log: impl FnOnce()) {
    static WARNED: Mutex<Option<HashSet<String>>> = Mutex::new(None);
    let mut warned = WARNED.lock().unwrap_or_else(PoisonError::into_inner);
    let warned = warned.get_or_insert_with(HashSet::new);
    if warned.contains(key) {
        return;
    }
    if warned.len() > 5000 {
        warned.clear();
    }
    warned.insert(key.to_owned());
    log();
}

/// The layer [`PermissionGate::require`] and [`PermissionGate::resolve`]
/// return; add it with `route_layer`.
pub struct PermissionLayer<Q> {
    gate: Arc<PermissionGate<Q>>,
    required: Option<Arc<[String]>>,
}

impl<Q> Clone for PermissionLayer<Q> {
    fn clone(&self) -> Self {
        Self {
            gate: Arc::clone(&self.gate),
            required: self.required.clone(),
        }
    }
}

impl<S, Q> Layer<S> for PermissionLayer<Q> {
    type Service = PermissionService<S, Q>;

    fn layer(&self, inner: S) -> Self::Service {
        PermissionService {
            inner,
            layer: self.clone(),
        }
    }
}

/// The service behind [`PermissionLayer`].
pub struct PermissionService<S, Q> {
    inner: S,
    layer: PermissionLayer<Q>,
}

impl<S: Clone, Q> Clone for PermissionService<S, Q> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            layer: self.layer.clone(),
        }
    }
}

impl<S, Q> Service<Request> for PermissionService<S, Q>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
    Q: PermissionQueries + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request) -> Self::Future {
        // The clone that was polled ready handles this request.
        let clone = self.inner.clone();
        let mut inner = std::mem::replace(&mut self.inner, clone);
        let layer = self.layer.clone();
        Box::pin(async move {
            let permissions = match layer.gate.permissions_for(&mut request).await {
                Ok(permissions) => permissions,
                Err(response) => return Ok(*response),
            };
            if let Some(required) = &layer.required
                && !permissions.has_any(required)
            {
                return Ok(envelope(
                    StatusCode::FORBIDDEN,
                    "FORBIDDEN",
                    "You do not have permission to perform this action",
                ));
            }
            inner.call(request).await
        })
    }
}
