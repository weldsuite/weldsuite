//! The workspace step of an MCP client's sign-in, on WeldSuite's side:
//! `/api/mcp/workspace-selections/{challenge}`, which the platform's
//! `/auth/mcp-workspace` page calls.
//!
//! In membership mode (WeldID) a token names no workspace, so WeldID sends
//! the browser of a person connecting an MCP client to that page after its
//! consent screen, with a one-time challenge
//! ([`weldsuite_ports::workspace_selection`]). The page asks which workspace
//! the connection is for; WeldID then puts the answer in the grant's access
//! tokens as the `tenant` claim, which [`crate::auth`] checks against the
//! memberships on every request. This way a person in several workspaces
//! connects to the plain `/mcp` and picks the workspace while signing in.
//!
//! | Method | Answer |
//! |---|---|
//! | `GET` | `{ data: { client: { name, host }, workspaces: [{ id, name, slug }], suggestedWorkspaceId } }` |
//! | `POST` `{ workspaceId }` or `{ decision: "deny" }` | `{ data: { redirectTo } }`: where the browser goes on, back to WeldID |
//!
//! Behind the session only (no workspace): the caller's own memberships,
//! like `/api/workspaces`, with no permission of its own. A challenge that
//! is unknown, expired, used or another person's is one 404, so the page
//! can't tell whose it was. `suggestedWorkspaceId` is the workspace a
//! `/mcp/w/<workspace>` resource names, when the caller is in it, else the
//! caller's only workspace; the page continues with it without asking.
//! Without WeldID's tenant selection (another identity provider, or not
//! membership mode) every request is a 404.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderMap, header};
use serde_json::{Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::{MemberWorkspace, WorkspaceSelector};
use weldsuite_kit::validation::json_body;
use weldsuite_kit::{ApiError, Data};
use weldsuite_ports::workspace_selection::is_challenge;
use weldsuite_ports::{WorkspaceSelectionDecision, WorkspaceSelectionRequest, WorkspaceSelections};

use crate::auth::{MCP_PATH, WORKSPACE_PREFIX, is_workspace_segment};

/// The most workspaces offered (the picker tool's limit).
const MAX_LISTED: u64 = crate::picker::MAX_LISTED;

/// What the routes need.
#[derive(Clone)]
pub struct SelectionState {
    /// WeldID's tenant selection; `None` elsewhere.
    pub selections: Option<Arc<dyn WorkspaceSelections>>,
    /// Membership mode's check, which lists the caller's workspaces.
    pub membership: Option<WorkspaceSelector>,
}

impl std::fmt::Debug for SelectionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectionState")
            .field("selections", &self.selections.is_some())
            .field("membership", &self.membership.is_some())
            .finish()
    }
}

/// `/{challenge}`, to nest at `/api/mcp/workspace-selections`.
pub fn selection_router<S>(state: SelectionState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/{challenge}", get(show).post(decide))
        .with_state(state)
}

/// The one 404: the link can't be used (whoever's it was).
fn expired() -> Response {
    ApiError::not_found("Workspace selection", None)
        .with_message(
            "This sign-in link has expired or was already used. Start connecting again from your AI app.",
        )
        .into_response()
}

fn provider_failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "mcp: workspace selection at the identity provider failed");
    ApiError::bad_gateway().into_response()
}

fn lookup_failed(error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "mcp: workspace selection: memberships not read");
    ApiError::internal()
        .with_message("Failed to list workspaces")
        .into_response()
}

/// The sign-in `challenge` names, if it is the caller's.
async fn caller_request(
    selections: &dyn WorkspaceSelections,
    challenge: &str,
    caller: &AuthContext,
) -> Result<WorkspaceSelectionRequest, Response> {
    if !is_challenge(challenge) {
        return Err(expired());
    }
    match selections.request(challenge).await {
        Ok(Some(request)) if request.user_id == caller.user_id => Ok(request),
        Ok(_) => Err(expired()),
        Err(error) => Err(provider_failed(&error)),
    }
}

/// The parts both routes need, or the 404 when this server has no
/// workspace step.
fn parts(
    state: &SelectionState,
) -> Result<(&dyn WorkspaceSelections, &WorkspaceSelector), Response> {
    match (&state.selections, &state.membership) {
        (Some(selections), Some(membership)) => Ok((selections.as_ref(), membership)),
        _ => Err(expired()),
    }
}

/// The workspace a `/mcp/w/<workspace>` resource names, by its URL
/// segment (`workspaces.id`, slug or organization id).
fn resource_workspace(resource: &str) -> Option<&str> {
    let (_, rest) = resource.split_once("://")?;
    let path = &rest[rest.find('/')?..];
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let segment = path
        .strip_prefix(MCP_PATH)?
        .strip_prefix(WORKSPACE_PREFIX)?;
    is_workspace_segment(segment).then_some(segment)
}

/// The workspace the page goes on with unasked: the one the resource
/// names, when the caller is in it, else the caller's only one.
fn suggested(
    request: &WorkspaceSelectionRequest,
    workspaces: &[MemberWorkspace],
) -> Option<String> {
    if let Some(segment) = request.resource.as_deref().and_then(resource_workspace) {
        return workspaces
            .iter()
            .find(|workspace| workspace.id == segment || workspace.slug == segment)
            .map(|workspace| workspace.id.clone());
    }
    match workspaces {
        [only] => Some(only.id.clone()),
        _ => None,
    }
}

async fn show(
    State(state): State<SelectionState>,
    Path(challenge): Path<String>,
    caller: AuthContext,
) -> Response {
    let (selections, membership) = match parts(&state) {
        Ok(parts) => parts,
        Err(refused) => return refused,
    };
    let request = match caller_request(selections, &challenge, &caller).await {
        Ok(request) => request,
        Err(refused) => return refused,
    };
    let workspaces = match membership
        .member_workspace_list(&caller.user_id, MAX_LISTED)
        .await
    {
        Ok(workspaces) => workspaces,
        Err(error) => return lookup_failed(&error),
    };
    let suggested = suggested(&request, &workspaces);
    let listed: Vec<Value> = workspaces
        .iter()
        .map(|workspace| {
            json!({
                "id": workspace.id,
                "name": workspace.name.trim(),
                "slug": workspace.slug,
            })
        })
        .collect();
    Data(json!({
        "client": { "name": request.client_name, "host": request.redirect_host },
        "workspaces": listed,
        "suggestedWorkspaceId": suggested,
    }))
    .into_response()
}

/// What a decision's body may say.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Body {
    Allow(String),
    Deny,
}

/// `{ workspaceId }` or `{ decision: "deny" }`, nothing else.
fn parse_body(body: &Value) -> Result<Body, ApiError> {
    let invalid = || ApiError::bad_request("Send a workspaceId, or decision \"deny\".");
    let object = body.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|key| key != "workspaceId" && key != "decision")
    {
        return Err(invalid());
    }
    match (
        object.get("workspaceId").and_then(Value::as_str),
        object.get("decision").and_then(Value::as_str),
    ) {
        (Some(id), None | Some("allow")) if is_workspace_segment(id) => {
            Ok(Body::Allow(id.to_owned()))
        }
        (None, Some("deny")) if !object.contains_key("workspaceId") => Ok(Body::Deny),
        _ => Err(invalid()),
    }
}

/// Where the browser may be sent: an absolute `https` URL, or `http` on a
/// loopback host (a local WeldID).
fn is_continuation(url: &str) -> bool {
    if let Some(rest) = url.strip_prefix("https://") {
        return !rest.is_empty() && !rest.starts_with('/');
    }
    url.strip_prefix("http://").is_some_and(|rest| {
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
        let host = host.rsplit_once(':').map_or(host, |(name, _)| name);
        matches!(host, "localhost" | "127.0.0.1" | "[::1]") || host.ends_with(".localhost")
    })
}

async fn decide(
    State(state): State<SelectionState>,
    Path(challenge): Path<String>,
    caller: AuthContext,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (selections, membership) = match parts(&state) {
        Ok(parts) => parts,
        Err(refused) => return refused,
    };
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = match json_body(content_type, &body) {
        Ok(body) => body,
        Err(malformed) => return malformed.into_response(),
    };
    let body = match parse_body(&body) {
        Ok(body) => body,
        Err(error) => return error.into_response(),
    };
    if let Err(refused) = caller_request(selections, &challenge, &caller).await {
        return refused;
    }
    let decision = match body {
        Body::Deny => WorkspaceSelectionDecision::Deny,
        Body::Allow(reference) => {
            let workspaces = match membership
                .member_workspace_list(&caller.user_id, MAX_LISTED)
                .await
            {
                Ok(workspaces) => workspaces,
                Err(error) => return lookup_failed(&error),
            };
            // Only one of the caller's workspaces, and always by its id.
            let Some(workspace) = workspaces
                .iter()
                .find(|workspace| workspace.id == reference)
            else {
                return ApiError::forbidden()
                    .with_message("You are not a member of this workspace.")
                    .into_response();
            };
            WorkspaceSelectionDecision::Allow {
                tenant_ref: workspace.id.clone(),
            }
        }
    };
    match selections.decide(&challenge, &decision).await {
        Ok(Some(url)) if is_continuation(&url) => {
            Data(json!({ "redirectTo": url })).into_response()
        }
        Ok(Some(_)) => provider_failed(&"the provider's continuation is not an https URL"),
        Ok(None) => expired(),
        Err(error) => provider_failed(&error),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::body::{Body as HttpBody, to_bytes};
    use http::{Request, StatusCode};
    use tower::ServiceExt;
    use weldsuite_db::{
        MemberWorkspacesFuture, MembershipFuture, MembershipLookup, MembershipsFuture,
        WorkspaceError,
    };
    use weldsuite_ports::{BoxFuture, IdentityResult};

    use super::*;

    const CHALLENGE: &str = "wtc_abc";

    /// One sign-in waiting for `user`, at `resource`; records decisions.
    struct Pending {
        user: &'static str,
        resource: Option<&'static str>,
        decided: Mutex<Vec<WorkspaceSelectionDecision>>,
    }

    impl WorkspaceSelections for Pending {
        fn request<'a>(
            &'a self,
            challenge: &'a str,
        ) -> BoxFuture<'a, IdentityResult<Option<WorkspaceSelectionRequest>>> {
            let answer = (challenge == CHALLENGE && self.decided.lock().expect("lock").is_empty())
                .then(|| WorkspaceSelectionRequest {
                    user_id: self.user.to_owned(),
                    client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata".to_owned(),
                    client_name: "Claude".to_owned(),
                    redirect_host: "claude.ai".to_owned(),
                    resource: self.resource.map(str::to_owned),
                    expires_at: None,
                });
            Box::pin(std::future::ready(Ok(answer)))
        }

        fn decide<'a>(
            &'a self,
            challenge: &'a str,
            decision: &'a WorkspaceSelectionDecision,
        ) -> BoxFuture<'a, IdentityResult<Option<String>>> {
            let mut decided = self.decided.lock().expect("lock");
            let answer = (challenge == CHALLENGE && decided.is_empty()).then(|| {
                decided.push(decision.clone());
                "https://auth.example.eu/tenant?ar=ar_1".to_owned()
            });
            Box::pin(std::future::ready(Ok(answer)))
        }
    }

    /// `user` is in `(id, slug, name)` workspaces.
    struct Memberships(Vec<(&'static str, &'static str, &'static str)>);

    impl MembershipLookup for Memberships {
        fn member_workspace<'a>(&'a self, _: &'a str, _: &'a str) -> MembershipFuture<'a> {
            Box::pin(std::future::ready(Ok(None)))
        }

        fn member_workspaces<'a>(&'a self, _: &'a str, _: u8) -> MembershipsFuture<'a> {
            Box::pin(std::future::ready(Ok(Vec::new())))
        }

        fn member_workspace_list<'a>(
            &'a self,
            user_id: &'a str,
            _: u64,
        ) -> MemberWorkspacesFuture<'a> {
            let listed = if user_id == "usr_me" {
                self.0
                    .iter()
                    .map(|(id, slug, name)| MemberWorkspace {
                        id: (*id).to_owned(),
                        slug: (*slug).to_owned(),
                        name: (*name).to_owned(),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            Box::pin(std::future::ready(Ok::<_, WorkspaceError>(listed)))
        }
    }

    fn app(
        resource: Option<&'static str>,
        workspaces: Vec<(&'static str, &'static str, &'static str)>,
    ) -> (Router, Arc<Pending>) {
        let pending = Arc::new(Pending {
            user: "usr_me",
            resource,
            decided: Mutex::new(Vec::new()),
        });
        let state = SelectionState {
            selections: Some(pending.clone()),
            membership: Some(WorkspaceSelector::new(Arc::new(Memberships(workspaces)))),
        };
        (selection_router(state), pending)
    }

    async fn call(
        app: &Router,
        method: &str,
        user: &str,
        challenge: &str,
        body: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/{challenge}"));
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let mut request = request
            .body(HttpBody::from(body.unwrap_or_default().to_owned()))
            .expect("request");
        request.extensions_mut().insert(AuthContext {
            user_id: user.to_owned(),
            org_id: None,
            session_id: String::new(),
            factor_verification_age: None,
        });
        let response = app.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, value)
    }

    #[tokio::test]
    async fn the_page_gets_the_client_and_the_callers_workspaces() {
        let (app, _) = app(
            Some("https://mcp.example.eu/mcp"),
            vec![("ws_a", "acme", " Acme "), ("ws_b", "beta", "Beta")],
        );
        let (status, body) = call(&app, "GET", "usr_me", CHALLENGE, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["data"],
            json!({
                "client": { "name": "Claude", "host": "claude.ai" },
                "workspaces": [
                    { "id": "ws_a", "name": "Acme", "slug": "acme" },
                    { "id": "ws_b", "name": "Beta", "slug": "beta" },
                ],
                "suggestedWorkspaceId": null,
            })
        );
    }

    #[tokio::test]
    async fn another_persons_or_an_unknown_challenge_is_one_404() {
        let (app, _) = app(None, vec![("ws_a", "acme", "Acme")]);
        for (user, challenge) in [
            ("usr_other", CHALLENGE),
            ("usr_me", "wtc_nope"),
            ("usr_me", "a.b"),
        ] {
            let (status, body) = call(&app, "GET", user, challenge, None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{user} {challenge}: {body}");
            assert_eq!(body["error"]["code"], "NOT_FOUND");
            let (status, _) = call(
                &app,
                "POST",
                user,
                challenge,
                Some(r#"{"workspaceId":"ws_a"}"#),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{user} {challenge}");
        }
    }

    #[tokio::test]
    async fn the_resources_workspace_or_the_only_one_is_suggested() {
        let two = vec![("ws_a", "acme", "Acme"), ("ws_b", "beta", "Beta")];
        let (named, _) = app(Some("https://mcp.example.eu/mcp/w/beta"), two.clone());
        let (_, body) = call(&named, "GET", "usr_me", CHALLENGE, None).await;
        assert_eq!(body["data"]["suggestedWorkspaceId"], "ws_b");
        // A workspace the caller isn't in suggests nothing, even with one.
        let (foreign, _) = app(
            Some("https://mcp.example.eu/mcp/w/other"),
            vec![("ws_a", "acme", "Acme")],
        );
        let (_, body) = call(&foreign, "GET", "usr_me", CHALLENGE, None).await;
        assert_eq!(body["data"]["suggestedWorkspaceId"], Value::Null);
        let (only, _) = app(
            Some("https://mcp.example.eu/mcp"),
            vec![("ws_a", "acme", "Acme")],
        );
        let (_, body) = call(&only, "GET", "usr_me", CHALLENGE, None).await;
        assert_eq!(body["data"]["suggestedWorkspaceId"], "ws_a");
    }

    #[tokio::test]
    async fn a_choice_is_one_of_the_callers_workspaces_by_id() {
        let (app, pending) = app(None, vec![("ws_a", "acme", "Acme")]);
        // Not theirs, or by slug: refused, nothing decided.
        for body in [r#"{"workspaceId":"ws_other"}"#, r#"{"workspaceId":"acme"}"#] {
            let (status, answer) = call(&app, "POST", "usr_me", CHALLENGE, Some(body)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}: {answer}");
        }
        assert!(pending.decided.lock().expect("lock").is_empty());

        let (status, answer) = call(
            &app,
            "POST",
            "usr_me",
            CHALLENGE,
            Some(r#"{"workspaceId":"ws_a"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(
            answer["data"]["redirectTo"],
            "https://auth.example.eu/tenant?ar=ar_1"
        );
        assert_eq!(
            *pending.decided.lock().expect("lock"),
            [WorkspaceSelectionDecision::Allow {
                tenant_ref: "ws_a".to_owned()
            }]
        );
        // Used: the link is gone.
        let (status, _) = call(
            &app,
            "POST",
            "usr_me",
            CHALLENGE,
            Some(r#"{"workspaceId":"ws_a"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_person_can_decline() {
        let (app, pending) = app(None, vec![("ws_a", "acme", "Acme")]);
        let (status, answer) = call(
            &app,
            "POST",
            "usr_me",
            CHALLENGE,
            Some(r#"{"decision":"deny"}"#),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{answer}");
        assert_eq!(
            *pending.decided.lock().expect("lock"),
            [WorkspaceSelectionDecision::Deny]
        );
    }

    #[test]
    fn bodies_say_one_thing() {
        assert_eq!(
            parse_body(&json!({ "workspaceId": "ws_a" })),
            Ok(Body::Allow("ws_a".to_owned()))
        );
        assert_eq!(
            parse_body(&json!({ "workspaceId": "ws_a", "decision": "allow" })),
            Ok(Body::Allow("ws_a".to_owned()))
        );
        assert_eq!(parse_body(&json!({ "decision": "deny" })), Ok(Body::Deny));
        for body in [
            json!({}),
            json!([]),
            json!({ "decision": "allow" }),
            json!({ "workspaceId": "ws_a", "decision": "deny" }),
            json!({ "workspaceId": "a b" }),
            json!({ "workspaceId": 1 }),
            json!({ "workspaceId": "ws_a", "extra": true }),
        ] {
            assert!(parse_body(&body).is_err(), "{body}");
        }
    }

    #[test]
    fn the_browser_only_goes_on_to_https_or_a_local_provider() {
        assert!(is_continuation("https://auth.example.eu/tenant?ar=1"));
        assert!(is_continuation("http://localhost:8080/tenant?ar=1"));
        assert!(is_continuation("http://auth.localhost/tenant"));
        for url in [
            "",
            "https://",
            "https:///x",
            "http://auth.example.eu/tenant",
            "http://localhost.evil.example/x",
            "javascript:alert(1)",
            "//auth.example.eu/x",
        ] {
            assert!(!is_continuation(url), "{url}");
        }
    }

    #[test]
    fn a_resource_names_its_workspace_by_path() {
        assert_eq!(
            resource_workspace("https://mcp.example.eu/mcp/w/acme"),
            Some("acme")
        );
        assert_eq!(
            resource_workspace("https://mcp.example.eu/mcp/w/ws_1?x=1"),
            Some("ws_1")
        );
        for resource in [
            "https://mcp.example.eu/mcp",
            "https://mcp.example.eu/mcp/w/",
            "https://mcp.example.eu/other/w/acme",
            "https://mcp.example.eu",
            "mcp/w/acme",
        ] {
            assert_eq!(resource_workspace(resource), None, "{resource}");
        }
    }
}
