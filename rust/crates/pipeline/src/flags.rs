//! `featureFlagsMiddleware` (`worker-kit/src/middleware/feature-flags.ts`):
//! a flag evaluator for the request, for routes to gate behaviour on.
//!
//! Test-only override: `X-Test-Flags: a,b` turns those flags on, only when
//! `ENVIRONMENT` is `development` or `test` and `X-Test-Token` matches
//! `TEST_FIXTURES_TOKEN` (compared in constant time). Inert in production and
//! un-spoofable without the token, as in the workers.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{FromRequestParts, Request, State};
use axum::middleware::Next;
use axum::response::Response;
use http::request::Parts;
use serde_json::Value;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::flags::BoolFlag;
use weldsuite_db::Tenant;
use weldsuite_kit::ApiError;
use weldsuite_ports::{DynFlagSource, FlagContext, FlagSource, FlagSourceExt};

/// The request's flag evaluator (`c.get('flags')`).
#[derive(Clone)]
pub struct Flags {
    source: Arc<dyn DynFlagSource>,
    context: FlagContext,
    forced: Arc<HashSet<String>>,
}

impl std::fmt::Debug for Flags {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Flags")
            .field("context", &self.context)
            .field("forced", &self.forced)
            .finish_non_exhaustive()
    }
}

impl Flags {
    pub fn new(source: Arc<dyn DynFlagSource>, context: FlagContext) -> Self {
        Self {
            source,
            context,
            forced: Arc::new(HashSet::new()),
        }
    }

    /// `isOn`.
    pub async fn is_on(&self, flag: BoolFlag) -> bool {
        if self.forced.contains(flag.key) {
            return true;
        }
        self.source.is_on(flag, &self.context).await
    }

    /// The raw configured value of any flag (`getValue` without the typing),
    /// `true` for a forced one; `None` means the catalog default.
    pub async fn value(&self, key: &str) -> Option<Value> {
        if self.forced.contains(key) {
            return Some(Value::Bool(true));
        }
        self.source.value(key, &self.context).await.ok().flatten()
    }
}

/// Configuration of the flag layer.
pub struct FlagGate {
    source: Arc<dyn DynFlagSource>,
    /// `ENVIRONMENT`; the test override works only in `development` and `test`.
    environment: String,
    /// `TEST_FIXTURES_TOKEN`; without it the override never applies.
    test_token: Option<String>,
}

impl std::fmt::Debug for FlagGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlagGate")
            .field("environment", &self.environment)
            .field("test_token", &self.test_token.as_ref().map(|_| "<set>"))
            .finish_non_exhaustive()
    }
}

impl FlagGate {
    pub fn new(
        source: Arc<dyn DynFlagSource>,
        environment: impl Into<String>,
        test_token: Option<String>,
    ) -> Self {
        Self {
            source,
            environment: environment.into(),
            test_token,
        }
    }

    fn forced(&self, request: &Request) -> HashSet<String> {
        let header = |name: &str| {
            request
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
        };
        let Some(list) = header("x-test-flags") else {
            return HashSet::new();
        };
        let test_environment = matches!(self.environment.as_str(), "development" | "test");
        if !test_environment || !secret_matches(header("x-test-token"), self.test_token.as_deref())
        {
            return HashSet::new();
        }
        list.split(',')
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

/// `secretMatches`: both present, equal, compared without an early exit.
fn secret_matches(given: Option<&str>, expected: Option<&str>) -> bool {
    let (Some(given), Some(expected)) = (given, expected) else {
        return false;
    };
    if expected.is_empty() || given.len() != expected.len() {
        return false;
    }
    given
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Middleware: `from_fn_with_state(gate, feature_flags)`, after `workspace_db`.
/// A request carrying [`Flags`] already (conformance mode) keeps them.
pub async fn feature_flags(
    State(gate): State<Arc<FlagGate>>,
    mut request: Request,
    next: Next,
) -> Response {
    if request.extensions().get::<Flags>().is_none() {
        let context = FlagContext {
            workspace_id: request
                .extensions()
                .get::<Tenant>()
                .map(|tenant| tenant.workspace_id.clone())
                .unwrap_or_default(),
            clerk_org_id: request
                .extensions()
                .get::<Tenant>()
                .and_then(|tenant| tenant.clerk_org_id.clone()),
            user_id: request
                .extensions()
                .get::<AuthContext>()
                .map(|auth| auth.user_id.clone())
                .unwrap_or_default(),
        };
        let mut flags = Flags::new(Arc::clone(&gate.source), context);
        flags.forced = Arc::new(gate.forced(&request));
        request.extensions_mut().insert(flags);
    }
    next.run(request).await
}

/// Handlers behind [`feature_flags`] take [`Flags`] as an argument.
impl<S: Send + Sync> FromRequestParts<S> for Flags {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(parts.extensions.get::<Self>().cloned().ok_or_else(|| {
            tracing::error!("flags: Flags extracted on a route without feature_flags");
            ApiError::internal()
        }))
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use weldsuite_ports::DefaultFlags;

    use super::*;

    fn request(flags: &str, token: &str) -> Request {
        http::Request::builder()
            .header("x-test-flags", flags)
            .header("x-test-token", token)
            .body(Body::empty())
            .expect("request")
    }

    #[test]
    fn the_test_override_needs_a_test_environment_and_the_token() {
        let gate = |env: &str| FlagGate::new(Arc::new(DefaultFlags), env, Some("tok".to_owned()));
        let forced = gate("test").forced(&request(" upgrade-button, ,x ", "tok"));
        assert_eq!(forced.len(), 2);
        assert!(forced.contains("upgrade-button"));
        assert!(gate("production").forced(&request("x", "tok")).is_empty());
        assert!(gate("test").forced(&request("x", "nope")).is_empty());
        let untokened = FlagGate::new(Arc::new(DefaultFlags), "test", None);
        assert!(untokened.forced(&request("x", "")).is_empty());
    }
}
