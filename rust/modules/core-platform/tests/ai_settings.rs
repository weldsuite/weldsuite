//! `/api/ai-settings` through its router, with the permission gate and the
//! session and tenant layers a request carries in the server, a scripted
//! model provider (`FakeProvider`), a recording event bus and a recording
//! system mail.
//!
//! The permission checks run without a database (a member is refused before
//! any query). The rest runs on the real tenant and master schema (built
//! from the journaled migrations by `scripts/rust-test-db.ts`, as CI does)
//! when `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set,
//! and returns early otherwise: a member reads but cannot write, `ai:manage`
//! can, enabling a provider outside the EU needs the acknowledgement and
//! emails the owners once, key answers carry the hint only and a copied
//! ciphertext fails to open, events carry no key, and overrides are refused
//! for fixed features and for disabled providers.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_ai::config::{Endpoint, KeySources};
use weldsuite_ai::settings::open_key;
use weldsuite_ai::{Ai, AiConfig, FakeProvider, ProviderId};
use weldsuite_auth::AuthContext;
use weldsuite_core_platform::{AuditStreamGateway, AuditStreamTest, CorePlatformState};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::{MemberRow, ResolvedPermissions};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{
    BoxFuture, DynEventBus, DynSystemMail, RecordingEventBus, RecordingSystemMail,
};

const WORKSPACE: &str = "ws_ai_settings_test";
const SECRET: [u8; 32] = [3; 32];
const API_KEY: &str = "sk-ant-test-secret-9f8e7d6c5b4a";

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

struct NoAudit;

impl AuditStreamGateway for NoAudit {
    fn check_url(&self, raw: &str) -> Result<String, String> {
        Ok(raw.to_owned())
    }

    fn send_test<'a>(
        &'a self,
        _test: AuditStreamTest<'a>,
    ) -> BoxFuture<'a, weldsuite_core_platform::AuditStreamTestResult> {
        unreachable!("not used by AI settings")
    }
}

fn config() -> AiConfig {
    let endpoint = |key: &str| Endpoint {
        base_url: "https://example.test/v1".to_owned(),
        api_key: Some(key.to_owned()),
    };
    AiConfig {
        default_provider: Some(ProviderId::Mistral),
        mistral: endpoint("mistral-key"),
        anthropic: endpoint("anthropic-key"),
        opt_in: BTreeMap::from([(
            ProviderId::Anthropic,
            KeySources {
                weldsuite: true,
                own: true,
            },
        )]),
        keys_encryption_key: Some(SECRET),
        ..AiConfig::default()
    }
}

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    mail: Arc<RecordingSystemMail>,
    tracker: TaskTracker,
    fake: FakeProvider,
}

/// The router as the server serves it for a caller with `permissions`.
fn harness(tenant: PgPool, master: PgPool, user: &str, permissions: &[&str]) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let mail = Arc::new(RecordingSystemMail::new());
    let tracker = TaskTracker::new();
    let fake = FakeProvider::new();
    let state = CorePlatformState {
        events: EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            tracker.clone(),
        ),
        realtime: None,
        cache: None,
        master: master.clone(),
        identity: None,
        audit_streams: Arc::new(NoAudit),
        top_up: None,
        ai: Some(Ai::fake(config(), fake.clone())),
        mail: Some(Arc::clone(&mail) as Arc<dyn DynSystemMail>),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let user_id = user.to_owned();
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let app = weldsuite_core_platform::ai_settings(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            let auth = AuthContext {
                user_id: user_id.clone(),
                org_id: Some("org_test".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            };
            let tenant = Tenant {
                workspace_id: WORKSPACE.to_owned(),
                clerk_org_id: Some("org_test".to_owned()),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            };
            let permissions = Permissions::new(resolved.clone(), None, false, user_id.clone());
            request.extensions_mut().insert(auth);
            request.extensions_mut().insert(tenant);
            request.extensions_mut().insert(permissions);
            request
                .extensions_mut()
                .insert(weldsuite_db::MasterDb(master.clone()));
            next.run(request)
        },
    ));
    Harness {
        app,
        bus,
        mail,
        tracker,
        fake,
    }
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (StatusCode, Value, String) {
    let mut request = Request::builder().method(method).uri(path);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let json = serde_json::from_str(&text).unwrap_or(Value::Null);
    (status, json, text)
}

fn lazy_pool() -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(200))
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .expect("lazy pool")
}

#[tokio::test]
async fn a_member_cannot_write_and_never_reaches_the_database() {
    let member = harness(lazy_pool(), lazy_pool(), "user_member", &["leads:read"]);
    let enable = json!({ "providers": { "anthropic": { "enabled": true, "keySource": "weldsuite" } }, "acknowledgedOutsideEu": true });
    for (method, path, body) in [
        ("PUT", "/", Some(enable)),
        ("PUT", "/keys/anthropic", Some(json!({ "apiKey": API_KEY }))),
        ("POST", "/keys/anthropic/test", None),
        ("DELETE", "/keys/anthropic", None),
        ("GET", "/usage", None),
    ] {
        let (status, _, text) = call(&member.app, method, path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {text}");
    }
    assert_eq!(member.mail.sent().len(), 0);
    member.tracker.close();
    member.tracker.wait().await;
    assert_eq!(member.bus.messages().len(), 0);

    // A manager's bad body is refused before any query.
    let manager = harness(lazy_pool(), lazy_pool(), "user_admin", &["ai:manage"]);
    let (status, _, _) = call(
        &manager.app,
        "PUT",
        "/",
        Some(json!({ "providers": { "mistral": { "enabled": false, "keySource": "weldsuite" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = call(
        &manager.app,
        "PUT",
        "/keys/anthropic",
        Some(json!({ "apiKey": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = call(
        &manager.app,
        "PUT",
        "/keys/mistral",
        Some(json!({ "apiKey": API_KEY })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

fn pools() -> Option<(PgPool, PgPool)> {
    let (Ok(master_url), Ok(tenant_url)) = (
        std::env::var("WELDSUITE_TEST_MASTER_URL"),
        std::env::var("WELDSUITE_TEST_TENANT_URL"),
    ) else {
        eprintln!("WELDSUITE_TEST_MASTER_URL / WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    let master = master_pool(&master_url, 2).expect("master pool");
    let tenant = if tenant_url == master_url {
        master.clone()
    } else {
        master_pool(&tenant_url, 2).expect("tenant pool")
    };
    Some((tenant, master))
}

fn provider<'a>(view: &'a Value, id: &str) -> &'a Value {
    view["data"]["providers"]
        .as_array()
        .expect("providers")
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("provider {id}"))
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn settings_keys_events_and_the_owners_email_on_the_real_schema() {
    let Some((tenant, master)) = pools() else {
        return;
    };
    sqlx::raw_sql(
        "delete from ai_provider_keys; delete from ai_settings; delete from workspace_members where id in ('mbr_o1', 'mbr_o2', 'mbr_a1', 'mbr_m1');",
    )
    .execute(&tenant)
    .await
    .expect("clean tenant");
    sqlx::query("insert into workspaces (id, name, slug) values ($1, 'Acme', $1) on conflict (id) do nothing")
        .bind(WORKSPACE)
        .execute(&master)
        .await
        .expect("workspace");
    for (id, user, email, name, role) in [
        (
            "mbr_o1",
            "user_owner1",
            "owner1@example.test",
            "Olivia Owner",
            "OWNER",
        ),
        (
            "mbr_o2",
            "user_owner2",
            "owner2@example.test",
            "Omar Owner",
            "OWNER",
        ),
        (
            "mbr_a1",
            "user_admin",
            "admin@example.test",
            "Ada Admin",
            "ADMIN",
        ),
        (
            "mbr_m1",
            "user_member",
            "member@example.test",
            "Mia Member",
            "MEMBER",
        ),
    ] {
        sqlx::query(
            "insert into workspace_members (id, user_id, email, name, role, status, accepted_at)
             values ($1, $2, $3, $4, $5, 'ACTIVE', now())",
        )
        .bind(id)
        .bind(user)
        .bind(email)
        .bind(name)
        .bind(role)
        .execute(&tenant)
        .await
        .expect("member");
    }

    let member = harness(tenant.clone(), master.clone(), "user_member", &[]);
    let admin = harness(tenant.clone(), master.clone(), "user_admin", &["ai:manage"]);

    // A member reads the effective policy, with no key status.
    let (status, view, _) = call(&member.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["canManage"], false);
    assert_eq!(view["data"]["installProvider"], "mistral");
    assert_eq!(provider(&view, "mistral")["install"], true);
    assert_eq!(provider(&view, "anthropic")["enabled"], false);
    assert!(provider(&view, "anthropic").get("key").is_none());
    assert_ne!(
        view["data"]["features"].as_array().expect("features").len(),
        0
    );

    // Enabling outside the EU without the acknowledgement is refused.
    let enable = |ack: bool| {
        json!({
            "providers": { "anthropic": { "enabled": true, "keySource": "own" } },
            "acknowledgedOutsideEu": ack
        })
    };
    let (status, refusal, _) = call(&admin.app, "PUT", "/", Some(enable(false))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(refusal["error"]["code"], "OUTSIDE_EU_NOT_ACKNOWLEDGED");
    assert_eq!(admin.mail.sent().len(), 0);

    // With it: saved, the answer is the new policy, the owners are told once.
    let (status, view, _) = call(&admin.app, "PUT", "/", Some(enable(true))).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["data"]["canManage"], true);
    let anthropic = provider(&view, "anthropic");
    assert_eq!(anthropic["enabled"], true);
    assert_eq!(anthropic["keySource"], "own");
    assert_eq!(anthropic["enabledBy"], "user_admin");
    // Own keys, none stored yet: enabled, but not routed to.
    assert_eq!(anthropic["available"], false);
    let mails = admin.mail.sent();
    // Every owner once (the shared test database may hold others).
    for owner in ["owner1@example.test", "owner2@example.test"] {
        let count = mails.iter().filter(|m| m.to[0].email == owner).count();
        assert_eq!(count, 1, "{owner}");
    }
    assert!(mails.iter().all(|m| m.to[0].email != "admin@example.test"));
    let told = mails.len();
    assert!(
        mails
            .iter()
            .all(|m| m.text.contains("Ada Admin") && m.text.contains("Anthropic"))
    );
    // Saving again changes nothing that needs telling.
    let (status, _, _) = call(&admin.app, "PUT", "/", Some(enable(true))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(admin.mail.sent().len(), told);

    // A key: the answer carries the hint only; the provider is checked first.
    let (status, set, text) = call(
        &admin.app,
        "PUT",
        "/keys/anthropic",
        Some(json!({ "apiKey": API_KEY })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(set["data"]["status"], "ok");
    assert!(
        set["data"]["hint"]
            .as_str()
            .expect("hint")
            .ends_with("5b4a")
    );
    assert!(!text.contains(API_KEY));
    let ciphertext: String =
        sqlx::query_scalar("select ciphertext from ai_provider_keys where provider = 'anthropic'")
            .fetch_one(&tenant)
            .await
            .expect("stored");
    assert!(!ciphertext.contains(API_KEY));
    assert_eq!(
        open_key(&SECRET, WORKSPACE, ProviderId::Anthropic, &ciphertext).expect("opens"),
        API_KEY
    );
    // Copied onto another workspace, or relabelled, it fails to open.
    assert!(open_key(&SECRET, "ws_other", ProviderId::Anthropic, &ciphertext).is_err());
    assert!(open_key(&SECRET, WORKSPACE, ProviderId::OpenAi, &ciphertext).is_err());

    // Admins see the key status, members do not.
    let (_, view, text) = call(&admin.app, "GET", "/", None).await;
    assert_eq!(provider(&view, "anthropic")["key"]["status"], "ok");
    assert_eq!(provider(&view, "anthropic")["available"], true);
    assert!(!text.contains(API_KEY));
    let (_, view, text) = call(&member.app, "GET", "/", None).await;
    assert!(provider(&view, "anthropic").get("key").is_none());
    assert!(!text.contains("hint"));

    // A key the provider refuses is a 422 and replaces nothing.
    let rejecting = harness(tenant.clone(), master.clone(), "user_admin", &["ai:manage"]);
    let _ = rejecting
        .fake
        .clone()
        .reply_status(401, "invalid x-api-key");
    let (status, refused, text) = call(
        &rejecting.app,
        "PUT",
        "/keys/anthropic",
        Some(json!({ "apiKey": "sk-ant-wrong-0000000000" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{text}");
    assert_eq!(refused["error"]["code"], "AI_KEY_REJECTED");
    assert!(!text.contains("sk-ant-wrong"));

    // Testing the key again, and without one.
    let (status, tested, _) = call(&admin.app, "POST", "/keys/anthropic/test", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tested["data"]["status"], "ok");
    let (status, _, _) = call(&admin.app, "POST", "/keys/openai/test", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Overrides: fixed features and disabled providers are refused, an
    // enabled provider's model is accepted and shows as the feature's target.
    let (status, _, _) = call(
        &admin.app,
        "PUT",
        "/",
        Some(json!({ "featureOverrides": { "search-index": { "provider": "mistral" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = call(
        &admin.app,
        "PUT",
        "/",
        Some(json!({ "featureOverrides": { "mail": { "provider": "openai" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/",
        Some(json!({ "featureOverrides": { "mail": { "provider": "anthropic", "model": "anthropic/claude-sonnet-5-5" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    let mail_feature = view["data"]["features"]
        .as_array()
        .expect("features")
        .iter()
        .find(|f| f["id"] == "mail")
        .expect("mail");
    assert_eq!(mail_feature["override"]["provider"], "anthropic");
    assert_eq!(
        mail_feature["effective"]["model"],
        "anthropic/claude-sonnet-5-5"
    );
    assert_eq!(mail_feature["effective"]["region"], "outside-eu");

    // Disabling keeps the key and tells nobody.
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/",
        Some(json!({ "providers": { "anthropic": { "enabled": false, "keySource": "own" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(provider(&view, "anthropic")["enabled"], false);
    assert_eq!(provider(&view, "anthropic")["key"]["status"], "ok");
    assert_eq!(admin.mail.sent().len(), told);

    // Removing the key: 204, then 404.
    let (status, _, _) = call(&admin.app, "DELETE", "/keys/anthropic", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = call(&admin.app, "DELETE", "/keys/anthropic", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Usage: two months, the current one first.
    let (status, usage, _) = call(&admin.app, "GET", "/usage", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(usage["data"]["months"].as_array().expect("months").len(), 2);

    // Events: the settings, the key set and removed; never the key.
    admin.tracker.close();
    admin.tracker.wait().await;
    let subjects: Vec<String> = admin
        .bus
        .messages()
        .into_iter()
        .map(|m| m.subject)
        .collect();
    assert!(
        subjects.contains(&"entity-events.ai_settings.updated".to_owned()),
        "{subjects:?}"
    );
    assert!(
        subjects.contains(&"entity-events.ai_provider_key.set".to_owned()),
        "{subjects:?}"
    );
    assert!(
        subjects.contains(&"entity-events.ai_provider_key.removed".to_owned()),
        "{subjects:?}"
    );
    for payload in admin.bus.payloads() {
        let text = payload.to_string();
        assert!(!text.contains(API_KEY), "{text}");
        assert!(!text.contains("ciphertext"), "{text}");
    }
}
