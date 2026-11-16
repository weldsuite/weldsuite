//! Membership mode (self-hosted plan E1, `OIDC_WORKSPACE_SOURCE=header`):
//! the identity provider only authenticates, and a request names its
//! workspace in the `X-Weld-Workspace` header ([`WORKSPACE_HEADER`]). The
//! header takes the same references as the token's organization did
//! (`workspaces.id`, the organization id in `workspaces.clerk_org_id`) and
//! the workspace's slug; the session's user must be an active member of
//! that workspace in WeldSuite's own master `user_workspaces`.
//!
//! [`workspace_from_header`] sits between the session layer and
//! [`crate::workspace_db`] and fills [`AuthContext::org_id`] with the
//! workspace's organization reference (`clerk_org_id`, else `id`: what a
//! token's organization claim carried), so everything behind it (the tenant
//! database, the routes' `org_id`) works as in claim mode:
//!
//! | Request | Strict (routes that need a workspace) | Lenient (session-only routes) |
//! |---|---|---|
//! | no header | no workspace: `workspace_db` answers `ORG_REQUIRED` | no workspace |
//! | a workspace the user is an active member of | that workspace | that workspace |
//! | anything else (not a member, no such workspace, deleted) | 403 `FORBIDDEN` | no workspace |
//!
//! Unknown and foreign workspaces answer alike, so the header can't be used
//! to find out which workspaces exist. A granted membership is reused for
//! [`DEFAULT_MEMBERSHIP_TTL`]: removing a member takes effect within that
//! (and at once for every route behind a permission check, which reads the
//! tenant's member row on each request). Refusals are never cached.

use std::collections::HashMap;
use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use weldsuite_auth::{AuthContext, WORKSPACE_HEADER};
use weldsuite_kit::ApiError;

use crate::workspaces::{WorkspaceError, Workspaces};

/// How long a granted membership is reused.
pub const DEFAULT_MEMBERSHIP_TTL: Duration = Duration::from_secs(30);

/// Cap on cached memberships; past it the cache starts over.
const MAX_CACHED: usize = 10_000;

/// The longest reference a header may carry (the columns are 255 wide).
const MAX_REFERENCE: usize = 255;

/// What [`MembershipLookup::member_workspace`] answers.
pub type MembershipFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<String>, WorkspaceError>> + Send + 'a>>;

/// Whether a user may use a workspace.
pub trait MembershipLookup: Send + Sync {
    /// The organization reference (`clerk_org_id`, else `id`) of the live
    /// workspace `reference` names (its id, organization id or slug) when
    /// `user_id` is an active member of it; `None` otherwise.
    fn member_workspace<'a>(&'a self, user_id: &'a str, reference: &'a str)
    -> MembershipFuture<'a>;
}

/// One master query: the workspace by id, organization id or slug (in that
/// order of preference), joined to the user's active membership.
const SELECT_MEMBER_WORKSPACE: &str = "
    select coalesce(w.clerk_org_id, w.id)
    from workspaces w
    join user_workspaces uw on uw.workspace_id = w.id
    where (w.id = $1 or w.clerk_org_id = $1 or w.slug = $1)
      and uw.user_id = $2
      and uw.status = 'ACTIVE'
      and w.deleted_at is null
    order by case when w.id = $1 then 0 when w.clerk_org_id = $1 then 1 else 2 end
    limit 1";

impl MembershipLookup for Workspaces {
    fn member_workspace<'a>(
        &'a self,
        user_id: &'a str,
        reference: &'a str,
    ) -> MembershipFuture<'a> {
        Box::pin(async move {
            sqlx::query_scalar(SELECT_MEMBER_WORKSPACE)
                .bind(reference)
                .bind(user_id)
                .fetch_optional(self.master())
                .await
                .map_err(WorkspaceError::from)
        })
    }
}

struct Selector {
    lookup: Arc<dyn MembershipLookup>,
    ttl: Duration,
    /// `(user, reference)` → when granted, and the organization reference.
    granted: Mutex<HashMap<(String, String), (Instant, String)>>,
}

/// The state of [`workspace_from_header`]. Clones share the lookup and the
/// cache; [`WorkspaceSelector::lenient`] is the session-only routes' copy.
#[derive(Clone)]
pub struct WorkspaceSelector {
    inner: Arc<Selector>,
    strict: bool,
}

impl fmt::Debug for WorkspaceSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkspaceSelector")
            .field("strict", &self.strict)
            .field("ttl", &self.inner.ttl)
            .finish_non_exhaustive()
    }
}

impl WorkspaceSelector {
    /// Strict: a workspace the user may not use is refused.
    pub fn new(lookup: Arc<dyn MembershipLookup>) -> Self {
        Self {
            inner: Arc::new(Selector {
                lookup,
                ttl: DEFAULT_MEMBERSHIP_TTL,
                granted: Mutex::new(HashMap::new()),
            }),
            strict: true,
        }
    }

    /// How long a granted membership is reused (tests: zero).
    #[must_use]
    pub fn with_ttl(self, ttl: Duration) -> Self {
        let inner = Selector {
            lookup: Arc::clone(&self.inner.lookup),
            ttl,
            granted: Mutex::new(HashMap::new()),
        };
        Self {
            inner: Arc::new(inner),
            strict: self.strict,
        }
    }

    /// The same selector for routes that need no workspace: a header naming
    /// one the user may not use is ignored instead of refused, so a stale
    /// active workspace never blocks accepting an invitation or onboarding.
    #[must_use]
    pub fn lenient(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            strict: false,
        }
    }

    fn cached(&self, key: &(String, String)) -> Option<String> {
        let granted = self
            .inner
            .granted
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        granted
            .get(key)
            .filter(|(at, _)| at.elapsed() < self.inner.ttl)
            .map(|(_, org)| org.clone())
    }

    /// The organization reference for `user_id` in the workspace
    /// `reference` names, or `None` when they may not use it.
    pub async fn resolve(
        &self,
        user_id: &str,
        reference: &str,
    ) -> Result<Option<String>, WorkspaceError> {
        let key = (user_id.to_owned(), reference.to_owned());
        if let Some(org) = self.cached(&key) {
            return Ok(Some(org));
        }
        let found = self
            .inner
            .lookup
            .member_workspace(user_id, reference)
            .await?
            .filter(|org| !org.is_empty());
        if let Some(org) = &found
            && !self.inner.ttl.is_zero()
        {
            let mut granted = self
                .inner
                .granted
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if granted.len() >= MAX_CACHED {
                granted.clear();
            }
            granted.insert(key, (Instant::now(), org.clone()));
        }
        Ok(found)
    }
}

/// The header's reference: trimmed, non-empty, at most 255 bytes of
/// visible ASCII. `Err(())` for a header that is there but unusable.
fn header_reference(request: &Request) -> Result<Option<String>, ()> {
    let Some(value) = request.headers().get(WORKSPACE_HEADER) else {
        return Ok(None);
    };
    let text = value.to_str().map_err(|_| ())?.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_REFERENCE || !text.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(());
    }
    Ok(Some(text.to_owned()))
}

fn not_a_member() -> Response {
    ApiError::forbidden()
        .with_message("You are not a member of this workspace.")
        .into_response()
}

/// Middleware: `axum::middleware::from_fn_with_state(selector, workspace_from_header)`,
/// after the session middleware and before [`crate::workspace_db`]. Sets
/// [`AuthContext::org_id`] from the [`WORKSPACE_HEADER`]; see the module docs.
#[allow(
    clippy::match_same_arms,
    reason = "each \"no workspace\" arm is one row of the module docs' table"
)]
pub async fn workspace_from_header(
    State(selector): State<WorkspaceSelector>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(user_id) = request
        .extensions()
        .get::<AuthContext>()
        .map(|auth| auth.user_id.clone())
    else {
        // No session: the session layer answered already, or the route
        // takes none.
        return next.run(request).await;
    };
    let org = match header_reference(&request) {
        Ok(None) => None,
        Ok(Some(reference)) => match selector.resolve(&user_id, &reference).await {
            Ok(Some(org)) => Some(org),
            Ok(None) if selector.strict => return not_a_member(),
            Ok(None) => None,
            Err(error) => {
                tracing::error!(%error, "workspace header: checking the membership failed");
                if selector.strict {
                    return ApiError::internal().into_response();
                }
                None
            }
        },
        // An unusable header names no workspace the user may use.
        Err(()) if selector.strict => return not_a_member(),
        Err(()) => None,
    };
    if let Some(auth) = request.extensions_mut().get_mut::<AuthContext>() {
        // The header is the only source of the workspace here.
        auth.org_id = org;
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    /// `(user, reference, org)` grants; counts its calls.
    #[derive(Default)]
    struct Grants {
        granted: Vec<(&'static str, &'static str, &'static str)>,
        calls: AtomicUsize,
        fail: bool,
    }

    impl MembershipLookup for Grants {
        fn member_workspace<'a>(
            &'a self,
            user_id: &'a str,
            reference: &'a str,
        ) -> MembershipFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let result = if self.fail {
                Err(WorkspaceError::NoDatabase)
            } else {
                Ok(self
                    .granted
                    .iter()
                    .find(|(user, r, _)| *user == user_id && *r == reference)
                    .map(|(_, _, org)| (*org).to_owned()))
            };
            Box::pin(std::future::ready(result))
        }
    }

    fn grants() -> Arc<Grants> {
        Arc::new(Grants {
            granted: vec![
                ("user_1", "ws_1", "org_1"),
                ("user_1", "acme", "org_1"),
                ("user_1", "org_1", "org_1"),
                ("user_2", "ws_2", "ws_2"),
            ],
            ..Grants::default()
        })
    }

    /// The selector behind a fake session for `user` (with a stale claim
    /// organization, which the header must replace), answering the org it
    /// ends up with.
    fn app(selector: WorkspaceSelector, user: &'static str) -> Router {
        Router::new()
            .route(
                "/",
                get(|auth: AuthContext| async move {
                    auth.org_id.unwrap_or_else(|| "none".to_owned())
                }),
            )
            .layer(axum::middleware::from_fn_with_state(
                selector,
                workspace_from_header,
            ))
            .layer(axum::middleware::from_fn(
                move |mut request: Request, next: Next| async move {
                    request.extensions_mut().insert(AuthContext {
                        user_id: user.to_owned(),
                        org_id: Some("org_from_a_claim".to_owned()),
                        session_id: String::new(),
                        factor_verification_age: None,
                    });
                    next.run(request).await
                },
            ))
    }

    async fn call(app: &Router, header: Option<&str>) -> (u16, String) {
        let mut request = http::Request::builder().uri("/");
        if let Some(value) = header {
            request = request.header("X-Weld-Workspace", value);
        }
        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status().as_u16();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (status, String::from_utf8(body.to_vec()).expect("utf-8"))
    }

    #[tokio::test]
    async fn a_member_gets_the_workspace_by_id_slug_or_organization() {
        let app = app(WorkspaceSelector::new(grants()), "user_1");
        for reference in ["ws_1", "acme", "org_1", " ws_1 "] {
            assert_eq!(
                call(&app, Some(reference)).await,
                (200, "org_1".to_owned()),
                "{reference}"
            );
        }
        // A workspace without an organization id resolves to its own id.
        let app = super::tests::app(WorkspaceSelector::new(grants()), "user_2");
        assert_eq!(call(&app, Some("ws_2")).await, (200, "ws_2".to_owned()));
    }

    #[tokio::test]
    async fn no_header_is_no_workspace_even_with_an_organization_claim() {
        let app = app(WorkspaceSelector::new(grants()), "user_1");
        assert_eq!(call(&app, None).await, (200, "none".to_owned()));
        assert_eq!(call(&app, Some("  ")).await, (200, "none".to_owned()));
    }

    #[tokio::test]
    async fn strict_refuses_what_the_user_may_not_use_and_lenient_ignores_it() {
        let lookup = grants();
        let strict = WorkspaceSelector::new(lookup.clone());
        let app_strict = app(strict.clone(), "user_1");
        let app_lenient = app(strict.lenient(), "user_1");
        for reference in ["ws_2", "ws_unknown", "bad value", &"x".repeat(256)] {
            let (status, body) = call(&app_strict, Some(reference)).await;
            assert_eq!(status, 403, "{reference}");
            assert!(body.contains("\"FORBIDDEN\""), "{body}");
            assert!(body.contains("not a member of this workspace"), "{body}");
            assert_eq!(
                call(&app_lenient, Some(reference)).await,
                (200, "none".to_owned()),
                "{reference}"
            );
        }
    }

    #[tokio::test]
    async fn a_failed_lookup_is_an_error_only_where_a_workspace_is_needed() {
        let lookup = Arc::new(Grants {
            fail: true,
            ..Grants::default()
        });
        let strict = WorkspaceSelector::new(lookup);
        let (status, body) = call(&app(strict.clone(), "user_1"), Some("ws_1")).await;
        assert_eq!(status, 500, "{body}");
        assert_eq!(
            call(&app(strict.lenient(), "user_1"), Some("ws_1")).await,
            (200, "none".to_owned())
        );
    }

    #[tokio::test]
    async fn grants_are_reused_refusals_are_not() {
        let lookup = grants();
        let selector = WorkspaceSelector::new(lookup.clone());
        let app = app(selector.clone(), "user_1");
        call(&app, Some("ws_1")).await;
        call(&app, Some("ws_1")).await;
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 1);
        call(&app, Some("ws_2")).await;
        call(&app, Some("ws_2")).await;
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 3);

        // The lenient copy shares the cache.
        call(
            &super::tests::app(selector.lenient(), "user_1"),
            Some("ws_1"),
        )
        .await;
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 3);

        let uncached = WorkspaceSelector::new(lookup.clone()).with_ttl(Duration::ZERO);
        let app = super::tests::app(uncached, "user_1");
        call(&app, Some("ws_1")).await;
        call(&app, Some("ws_1")).await;
        assert_eq!(lookup.calls.load(Ordering::SeqCst), 5);
    }
}
