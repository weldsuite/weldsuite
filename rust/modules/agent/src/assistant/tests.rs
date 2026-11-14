//! `/api/ai` through its router, with the permission gate and the session and
//! tenant layers a request carries in the server, and a scripted model
//! (`FakeProvider`).
//!
//! The refusals before the model (a bad body, a missing permission, AI off)
//! run without a database. The model flows read the workspace's AI settings
//! from the tenant schema (built from the journaled migrations by
//! `scripts/rust-test-db.ts`, as CI does), so they run when
//! `WELDSUITE_TEST_TENANT_URL` is set and return early otherwise.

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_ai::config::Endpoint;
use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};
use weldsuite_auth::AuthContext;
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{
    MemberRow, PermissionGate, PermissionQueries, Permissions, ResolvedPermissions,
};

use crate::AgentState;

mod sheets_tests;

struct NoQueries;

impl PermissionQueries for NoQueries {
    type Error = String;

    fn get_member(
        &self,
        _user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_role_permissions(
        &self,
        _role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(None))
    }

    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}

fn config() -> AiConfig {
    AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: Endpoint {
            base_url: "https://example.test/v1".to_owned(),
            api_key: Some("mistral-key".to_owned()),
        },
        ..AiConfig::default()
    }
}

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

/// The router as the server serves it for a caller with `permissions`; `ai`
/// is the install's AI (`None`: off).
fn app(tenant: PgPool, ai: Option<Ai>, permissions: &[&str]) -> Router {
    let state = AgentState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        ai,
        sandbox: false,
        default_model: String::new(),
        master: None,
        realtime: None,
        sandboxes: None,
    };
    let gate = std::sync::Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    super::router(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: "user_me".to_owned(),
                org_id: Some("org_test".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: "ws_assistant_test".to_owned(),
                clerk_org_id: Some("org_test".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            });
            request.extensions_mut().insert(Permissions::new(
                resolved.clone(),
                None,
                false,
                "user_me".to_owned(),
            ));
            next.run(request)
        },
    ))
}

async fn post(app: &Router, path: &str, body: &Value) -> (StatusCode, String, Option<String>) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (
        status,
        String::from_utf8_lossy(&bytes).into_owned(),
        content_type,
    )
}

fn json_of(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

const USE: [&str; 2] = ["agents:read", "weldagent:use"];

fn hello() -> Value {
    json!({ "messages": [{ "role": "user", "content": "Hello" }] })
}

#[tokio::test]
async fn a_bad_body_is_refused_before_the_model() {
    let router = app(
        lazy_pool(),
        Some(Ai::fake(config(), FakeProvider::new())),
        &USE,
    );
    for (path, body) in [
        ("/ai/generate", json!({ "prompt": "" })),
        ("/ai/chat", json!({ "messages": [] })),
        (
            "/ai/chat",
            json!({ "messages": [{ "role": "robot", "content": "x" }] }),
        ),
        (
            "/ai/chat/stream",
            json!({ "messages": [{ "role": "user", "content": "x" }], "temperature": 3 }),
        ),
    ] {
        // `/ai/generate` needs `agents:create`; the others are validated first.
        let router = if path == "/ai/generate" {
            app(lazy_pool(), None, &["agents:create"])
        } else {
            router.clone()
        };
        let (status, text, _) = post(&router, path, &body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}: {text}");
    }
    // Only system turns leave nothing to answer.
    let (status, text, _) = post(
        &router,
        "/ai/chat",
        &json!({ "messages": [{ "role": "system", "content": "Be brief" }] }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        text.contains("At least one user message is required"),
        "{text}"
    );
}

#[tokio::test]
async fn the_routes_need_their_permissions() {
    let none = app(lazy_pool(), None, &["leads:read"]);
    for path in ["/ai/generate", "/ai/chat", "/ai/chat/stream"] {
        let (status, _, _) = post(&none, path, &json!({ "prompt": "x" })).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
    }
}

#[tokio::test]
async fn without_a_provider_the_assistant_says_ai_is_unavailable() {
    let router = app(
        lazy_pool(),
        None,
        &["agents:read", "weldagent:use", "agents:create"],
    );
    for (path, body) in [
        ("/ai/generate", json!({ "prompt": "Hi" })),
        ("/ai/chat", hello()),
        ("/ai/chat/stream", hello()),
    ] {
        let (status, text, _) = post(&router, path, &body).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert_eq!(json_of(&text)["error"]["code"], "ai_unavailable");
    }
}

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&url)
            .expect("tenant pool"),
    )
}

fn tool_names(call: &weldsuite_ai::fake::FakeCall) -> Vec<String> {
    call.body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn a_chat_answers_with_the_models_text_and_who_answered() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new().reply_text("Hi there");
    let router = app(tenant, Some(Ai::fake(config(), fake.clone())), &USE);
    let (status, text, _) = post(&router, "/ai/chat", &hello()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let body = json_of(&text);
    assert_eq!(body["data"]["text"], "Hi there");
    assert_eq!(body["data"]["finishReason"], "stop");
    assert_eq!(body["data"]["usage"]["inputTokens"], 12);
    assert_eq!(body["meta"]["ai"]["provider"], "mistral");
    // Nothing to look up for this caller: no tools, and the prompt says so.
    let call = &fake.calls()[0];
    assert_eq!(tool_names(call), Vec::<String>::new());
    assert!(
        call.body["messages"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("no lookup tools for this user")
    );
}

#[tokio::test]
async fn a_tool_call_runs_and_its_answer_goes_back_to_the_model() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new()
        .reply_tool_call("list_projects", &json!({}))
        .reply_text("You have no projects.");
    let router = app(
        tenant,
        Some(Ai::fake(config(), fake.clone())),
        &["agents:read", "weldagent:use", "projects:read"],
    );
    let (status, text, _) = post(&router, "/ai/chat", &hello()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(json_of(&text)["data"]["text"], "You have no projects.");

    let calls = fake.calls();
    assert_eq!(calls.len(), 2);
    let mut offered = tool_names(&calls[0]);
    offered.sort();
    assert_eq!(offered, ["get_project", "list_projects"]);
    // The second request carries the tool's call and its result.
    let second = calls[1].body["messages"].to_string();
    assert!(second.contains("list_projects"), "{second}");
    assert!(second.contains("\"role\":\"tool\""), "{second}");
    // Usage adds up both requests.
    assert_eq!(json_of(&text)["data"]["usage"]["inputTokens"], 24);
}

#[tokio::test]
async fn the_stream_is_plain_text_and_ends_with_the_whole_reply() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new().reply_text("Hello there");
    let router = app(tenant, Some(Ai::fake(config(), fake.clone())), &USE);
    let (status, text, content_type) = post(&router, "/ai/chat/stream", &hello()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(content_type.unwrap_or_default().starts_with("text/plain"));
    assert_eq!(text, "Hello there");
    assert_eq!(fake.calls()[0].body["stream"], true);
}

#[tokio::test]
async fn an_empty_stream_becomes_an_apology() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new().reply_text("");
    let router = app(tenant, Some(Ai::fake(config(), fake)), &USE);
    let (_, text, _) = post(&router, "/ai/chat/stream", &hello()).await;
    assert_eq!(text, super::persona::FALLBACK_TEXT);
}

#[tokio::test]
async fn a_model_the_policy_refuses_is_a_422() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new();
    let router = app(tenant, Some(Ai::fake(config(), fake.clone())), &USE);
    let body =
        json!({ "messages": [{ "role": "user", "content": "Hello" }], "model": "openai/gpt-5" });
    for path in ["/ai/chat", "/ai/chat/stream"] {
        let (status, text, _) = post(&router, path, &body).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{path}: {text}");
        assert_eq!(json_of(&text)["error"]["code"], "AI_MODEL_NOT_ALLOWED");
    }
    assert!(fake.calls().is_empty(), "a refused model is never called");
}

#[tokio::test]
async fn generate_answers_with_text_and_credits() {
    let Some(tenant) = tenant() else { return };
    let fake = FakeProvider::new().reply_text("Once upon a time");
    let router = app(
        tenant,
        Some(Ai::fake(config(), fake.clone())),
        &["agents:create"],
    );
    let (status, text, _) = post(
        &router,
        "/ai/generate",
        &json!({ "prompt": "Tell a story", "system": "Be brief", "maxTokens": 50 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let body = json_of(&text);
    assert_eq!(body["data"]["text"], "Once upon a time");
    assert_eq!(body["data"]["creditsUsed"], 0);
    assert_eq!(body["meta"]["ai"]["provider"], "mistral");
    let call = &fake.calls()[0];
    assert_eq!(call.body["max_tokens"], 50);
    assert_eq!(call.body["messages"][0]["role"], "system");
}

#[tokio::test]
async fn an_agent_id_that_does_not_exist_is_a_404() {
    let Some(tenant) = tenant() else { return };
    let router = app(
        tenant,
        Some(Ai::fake(config(), FakeProvider::new())),
        &["agents:read", "weldagent:use"],
    );
    let (status, text, _) = post(
        &router,
        "/ai/chat",
        &json!({ "messages": [{ "role": "user", "content": "Hi" }], "agentId": "agt_missing" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{text}");
}
