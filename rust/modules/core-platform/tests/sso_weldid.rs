//! `/api/sso` in WeldID mode (ADR SEC-019 phase 5a): the router with the
//! permission gate and the session and tenant layers a request carries in
//! the server, WeldID's SSO admin API in memory (`MemorySsoDirectory`) and a
//! recording event bus.
//!
//! The permission checks run without a database (a member is refused before
//! any query). The rest runs on the real master and tenant schema (built by
//! `scripts/rust-test-db.ts`) when `WELDSUITE_TEST_MASTER_URL` and
//! `WELDSUITE_TEST_TENANT_URL` are set, and returns early otherwise: the
//! connection is created and changed through WeldID with its secret never
//! answered or published, another workspace's connection is invisible, a
//! domain is verified only once its record is up, switching on needs a
//! verified domain, the default role is kept in the tenant's settings, and
//! a workspace without the entitlement can't connect.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_core_platform::{AuditStreamGateway, AuditStreamTest, CorePlatformState};
use weldsuite_db::{PgPool, Tenant, WorkspaceRestrictions, master_pool};
use weldsuite_events::{EntityEventPublisher, TaskTracker};
use weldsuite_permissions::ResolvedPermissions;
use weldsuite_permissions::{MemberRow, PermissionGate, PermissionQueries, Permissions};
use weldsuite_ports::{
    BoxFuture, DynEventBus, MemorySsoDirectory, NewSsoConnection, RecordingEventBus, SsoDirectory,
};

const SECRET: &str = "s3cret-client-value";

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
        unreachable!("not used by SSO")
    }
}

struct Harness {
    app: Router,
    bus: Arc<RecordingEventBus>,
    tracker: TaskTracker,
}

/// The router as the server serves it in WeldID mode, for `user` in
/// `workspace` with `permissions`.
fn harness(
    directory: &Arc<MemorySsoDirectory>,
    (tenant, master): (PgPool, PgPool),
    workspace: &str,
    permissions: &[&str],
) -> Harness {
    let bus = Arc::new(RecordingEventBus::new());
    let tracker = TaskTracker::new();
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
        ai: None,
        mail: None,
        sso: Some(Arc::clone(directory) as Arc<dyn SsoDirectory>),
    };
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let resolved = ResolvedPermissions {
        permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
        ..ResolvedPermissions::default()
    };
    let workspace = workspace.to_owned();
    let app = weldsuite_core_platform::sso(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            let auth = AuthContext {
                user_id: "user_admin".to_owned(),
                org_id: None,
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            };
            let tenant = Tenant {
                workspace_id: workspace.clone(),
                clerk_org_id: Some(format!("org_{workspace}")),
                db: tenant.clone(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            };
            let permissions =
                Permissions::new(resolved.clone(), None, false, "user_admin".to_owned());
            request.extensions_mut().insert(auth);
            request.extensions_mut().insert(tenant);
            request.extensions_mut().insert(permissions);
            next.run(request)
        },
    ));
    Harness { app, bus, tracker }
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
async fn only_sso_managers_change_it_and_nobody_without_read_sees_it() {
    let directory = Arc::new(MemorySsoDirectory::new());
    let reader = harness(
        &directory,
        (lazy_pool(), lazy_pool()),
        "ws_a",
        &["sso:read"],
    );
    for (method, path, body) in [
        (
            "PUT",
            "/connection",
            Some(json!({ "displayName": "Entra", "clientSecret": SECRET })),
        ),
        ("DELETE", "/connection", None),
        ("POST", "/connection/activate", None),
        ("POST", "/connection/deactivate", None),
        ("POST", "/domains", Some(json!({ "domain": "acme.test" }))),
        ("DELETE", "/domains/acme.test", None),
        ("POST", "/domains/acme.test/verify", None),
        ("PUT", "/domain", Some(json!({ "domain": "acme.test" }))),
    ] {
        let (status, _, text) = call(&reader.app, method, path, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {text}");
        assert!(!text.contains(SECRET));
    }
    let nobody = harness(&directory, (lazy_pool(), lazy_pool()), "ws_a", &[]);
    let (status, _, _) = call(&nobody.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    reader.tracker.close();
    reader.tracker.wait().await;
    assert_eq!(reader.bus.messages().len(), 0);

    // A manager's bad body is refused before any query.
    let manager = harness(
        &directory,
        (lazy_pool(), lazy_pool()),
        "ws_a",
        &["sso:manage"],
    );
    for body in [
        json!({ "issuer": "http://login.example.test" }),
        json!({ "scopes": ["two words"] }),
        json!({ "defaultRole": "OWNER" }),
        json!({ "enforceSso": "yes" }),
    ] {
        let (status, _, text) = call(&manager.app, "PUT", "/connection", Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {text}");
    }
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

/// A workspace; `free` grants SSO at no charge (a staff price of 0).
async fn workspace(master: &PgPool, id: &str, free: bool) {
    sqlx::query("delete from workspace_sso where workspace_id = $1")
        .bind(id)
        .execute(master)
        .await
        .expect("clean sso");
    sqlx::query(
        "insert into workspaces (id, name, slug, clerk_org_id) values ($1, $1, $1, 'org_' || $1)
         on conflict (id) do nothing",
    )
    .bind(id)
    .execute(master)
    .await
    .expect("workspace");
    if free {
        sqlx::query(
            "insert into workspace_sso (id, workspace_id, clerk_org_id, price_override_cents)
             values ('wsso_' || $1, $1, 'org_' || $1, 0)",
        )
        .bind(id)
        .execute(master)
        .await
        .expect("free sso");
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn weldid_connections_on_the_real_schema() {
    let Some((tenant, master)) = pools() else {
        return;
    };
    sqlx::query("update workspace_settings set custom_settings = custom_settings - 'sso'")
        .execute(&tenant)
        .await
        .expect("clean settings");
    workspace(&master, "ws_sso_a", true).await;
    workspace(&master, "ws_sso_b", true).await;
    workspace(&master, "ws_sso_poor", false).await;
    let directory = Arc::new(MemorySsoDirectory::new());
    let admin = harness(
        &directory,
        (tenant.clone(), master.clone()),
        "ws_sso_a",
        &["sso:read", "sso:manage"],
    );

    // Nothing yet: WeldID mode, no connection, members join as MEMBER.
    let (status, view, _) = call(&admin.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["mode"], "weldid");
    assert_eq!(view["data"]["oidc"]["connection"], Value::Null);
    assert_eq!(view["data"]["oidc"]["defaultRole"], "MEMBER");
    assert_eq!(view["data"]["entitlement"]["source"], "free");
    assert_eq!(view["data"]["canManage"], true);

    // Domains need a connection first; creating one needs all four fields.
    let (status, view, _) = call(
        &admin.app,
        "POST",
        "/domains",
        Some(json!({ "domain": "acme.test" })),
    )
    .await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::CONFLICT, &json!("SSO_CONNECTION_MISSING"))
    );
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "displayName": "Entra" })),
    )
    .await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("SSO_IDP_INCOMPLETE"))
    );

    let (status, view, text) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({
            "displayName": "Acme Entra",
            "issuer": "https://login.example.test/acme/v2.0",
            "clientId": "client-1",
            "clientSecret": SECRET,
            "scopes": ["groups"],
            "trustEmails": true,
            "defaultRole": "VIEWER",
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert!(!text.contains(SECRET), "the secret is never answered");
    let connection = &view["data"]["oidc"]["connection"];
    assert_eq!(connection["hasClientSecret"], true);
    assert_eq!(connection["scopes"], json!(["groups"]));
    assert_eq!(connection["trustEmails"], true);
    assert_eq!(connection["enabled"], false);
    let id = connection["id"].as_str().expect("id").to_owned();
    assert_eq!(
        connection["redirectUri"],
        json!(format!("https://auth.example.test/sso/oidc/{id}/callback"))
    );
    assert_eq!(view["data"]["oidc"]["defaultRole"], "VIEWER");
    assert_eq!(directory.secret_of(&id).as_deref(), Some(SECRET));
    let stored: Option<String> = sqlx::query_scalar(
        "select custom_settings -> 'sso' ->> 'defaultRole' from workspace_settings
          where custom_settings ? 'sso' limit 1",
    )
    .fetch_one(&tenant)
    .await
    .expect("stored role");
    assert_eq!(stored.as_deref(), Some("VIEWER"));

    // Renaming leaves the secret alone.
    let (status, _, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "displayName": "Entra ID" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(directory.secret_of(&id).as_deref(), Some(SECRET));

    // Switching on needs a verified domain.
    let (status, view, _) = call(&admin.app, "POST", "/connection/activate", None).await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::CONFLICT, &json!("SSO_DOMAIN_NOT_VERIFIED"))
    );
    let (status, _, _) = call(
        &admin.app,
        "POST",
        "/domains",
        Some(json!({ "domain": "gmail.com" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, view, _) = call(
        &admin.app,
        "POST",
        "/domains",
        Some(json!({ "domain": "https://www.Acme.test/" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let domain = &view["data"]["oidc"]["domains"][0];
    assert_eq!(domain["name"], "acme.test");
    assert_eq!(domain["status"], "pending");
    assert_eq!(domain["dnsRecord"]["name"], "_weldsuite-sso.acme.test");
    assert_eq!(view["data"]["domain"]["name"], "acme.test");
    let (status, view, _) = call(&admin.app, "POST", "/domains/acme.test/verify", None).await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("SSO_DOMAIN_NOT_VERIFIED")
        )
    );
    directory.publish_record("acme.test");
    let (status, view, _) = call(&admin.app, "POST", "/domains/acme.test/verify", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["oidc"]["domains"][0]["verified"], true);
    let (status, view, _) = call(&admin.app, "POST", "/connection/activate", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["oidc"]["connection"]["enabled"], true);
    assert_eq!(view["data"]["oidc"]["active"], true);
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "enforceSso": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["oidc"]["connection"]["enforceSso"], true);

    // Another workspace never sees it, and can't claim the verified domain.
    let other = harness(
        &directory,
        (tenant.clone(), master.clone()),
        "ws_sso_b",
        &["sso:read", "sso:manage"],
    );
    let (status, view, _) = call(&other.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["oidc"]["connection"], Value::Null);
    let (status, view, _) = call(&other.app, "DELETE", "/domains/acme.test", None).await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::CONFLICT, &json!("SSO_DOMAIN_MISSING"))
    );
    let (status, view, _) = call(&other.app, "POST", "/connection/deactivate", None).await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::CONFLICT, &json!("SSO_CONNECTION_MISSING"))
    );
    directory
        .create_connection(
            "ws_sso_b",
            &NewSsoConnection {
                protocol: weldsuite_ports::SsoProtocol::Oidc,
                saml_metadata: None,
                display_name: "B".to_owned(),
                issuer: "https://idp.b.test".to_owned(),
                client_id: "b".to_owned(),
                client_secret: Some("b-secret".to_owned()),
                scopes: Vec::new(),
                trust_emails: false,
                enabled: false,
                enforce_sso: false,
            },
        )
        .await
        .expect("b's connection");
    // B may add A's domain (it would need the record), but not verify it.
    let (status, _, _) = call(
        &other.app,
        "POST",
        "/domains",
        Some(json!({ "domain": "acme.test" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, view, _) = call(&other.app, "POST", "/domains/acme.test/verify", None).await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::CONFLICT, &json!("SSO_DOMAIN_IN_USE"))
    );
    let (_, view, _) = call(&admin.app, "GET", "/", None).await;
    assert_eq!(
        view["data"]["oidc"]["connection"]["id"],
        json!(id),
        "A still sees only its own"
    );

    // A reader sees it all, without the secret, and can't change it.
    let reader = harness(
        &directory,
        (tenant.clone(), master.clone()),
        "ws_sso_a",
        &["sso:read"],
    );
    let (status, view, text) = call(&reader.app, "GET", "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["canManage"], false);
    assert!(!text.contains(SECRET));

    // No entitlement, no connection.
    let poor = harness(
        &directory,
        (tenant.clone(), master.clone()),
        "ws_sso_poor",
        &["sso:read", "sso:manage"],
    );
    let (status, view, _) = call(
        &poor.app,
        "PUT",
        "/connection",
        Some(json!({ "displayName": "X", "issuer": "https://idp.x.test", "clientId": "x", "clientSecret": "y" })),
    )
    .await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::PAYMENT_REQUIRED, &json!("SSO_NOT_ENTITLED"))
    );

    // Every change was published, without the identity provider's details.
    admin.tracker.close();
    admin.tracker.wait().await;
    let messages = admin.bus.messages();
    assert!(messages.len() >= 6, "{} events", messages.len());
    for message in &messages {
        let text = String::from_utf8_lossy(&message.payload);
        assert!(
            message.subject.contains("workspace_settings"),
            "{}",
            message.subject
        );
        assert!(!text.contains(SECRET), "{text}");
        assert!(!text.contains("login.example.test"), "{text}");
    }

    // Removing it takes the domains along.
    let (status, view, _) = call(&admin.app, "DELETE", "/connection", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["data"]["oidc"]["connection"], Value::Null);
    assert_eq!(view["data"]["domain"], Value::Null);
    assert_eq!(
        directory.connections("ws_sso_a").await.expect("list"),
        Vec::new()
    );
}

#[tokio::test]
async fn without_weldid_the_domains_routes_do_not_exist() {
    let gate = Arc::new(PermissionGate::new(|_| Ok(NoQueries)));
    let state = CorePlatformState {
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        realtime: None,
        cache: None,
        master: lazy_pool(),
        identity: None,
        audit_streams: Arc::new(NoAudit),
        top_up: None,
        ai: None,
        mail: None,
        sso: None,
    };
    let resolved = ResolvedPermissions {
        permissions: vec!["sso:manage".to_owned()],
        ..ResolvedPermissions::default()
    };
    let app = weldsuite_core_platform::sso(state, &gate).layer(axum::middleware::from_fn(
        move |mut request: axum::extract::Request, next: axum::middleware::Next| {
            request.extensions_mut().insert(AuthContext {
                user_id: "user_admin".to_owned(),
                org_id: Some("org_a".to_owned()),
                session_id: "sess_1".to_owned(),
                factor_verification_age: None,
            });
            request.extensions_mut().insert(Tenant {
                workspace_id: "ws_a".to_owned(),
                clerk_org_id: Some("org_a".to_owned()),
                db: lazy_pool(),
                suspended: false,
                restrictions: WorkspaceRestrictions::default(),
            });
            request.extensions_mut().insert(Permissions::new(
                resolved.clone(),
                None,
                false,
                "user_admin".to_owned(),
            ));
            next.run(request)
        },
    ));
    let (status, _, _) = call(&app, "POST", "/domains/acme.test/verify", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn weldid_saml_connections_on_the_real_schema() {
    let Some((tenant, master)) = pools() else {
        return;
    };
    workspace(&master, "ws_saml_a", true).await;
    let directory = Arc::new(MemorySsoDirectory::new());
    let admin = harness(
        &directory,
        (tenant.clone(), master.clone()),
        "ws_saml_a",
        &["sso:read", "sso:manage"],
    );
    let metadata = r#"<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.test/saml"><md:IDPSSODescriptor/></md:EntityDescriptor>"#;

    // A SAML connection needs its metadata, a file or a URL, not both, and
    // takes none of OpenID Connect's fields.
    for body in [
        json!({ "protocol": "saml", "displayName": "Entra SAML" }),
        json!({ "protocol": "saml", "displayName": "Entra SAML", "metadataXml": metadata, "issuer": "https://idp.example.test" }),
    ] {
        let (status, view, _) = call(&admin.app, "PUT", "/connection", Some(body)).await;
        assert_eq!(
            (status, &view["error"]["code"]),
            (StatusCode::BAD_REQUEST, &json!("SSO_IDP_INCOMPLETE"))
        );
    }
    let (status, _, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "protocol": "saml", "displayName": "Entra SAML", "metadataXml": metadata, "metadataUrl": "https://idp.example.test/m.xml" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "protocol": "saml", "displayName": "Entra SAML", "metadataUrl": "http://idp.example.test/m.xml" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "https only");

    // WeldID's refusal of the metadata is shown as WeldID wrote it.
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "protocol": "saml", "displayName": "Entra SAML", "metadataXml": "<x/>" })),
    )
    .await;
    assert_eq!(
        (status, &view["error"]["code"]),
        (StatusCode::BAD_REQUEST, &json!("SSO_IDP_REJECTED"))
    );
    assert!(
        view["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("no SAML 2.0 identity provider"),
        "{view}"
    );

    // Created from the metadata: the view says what to register at the
    // identity provider.
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "protocol": "saml", "displayName": "Entra SAML", "metadataXml": metadata, "trustEmails": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    let connection = &view["data"]["oidc"]["connection"];
    assert_eq!(connection["protocol"], "saml");
    assert_eq!(connection["trustEmails"], true);
    assert_eq!(connection["enabled"], false);
    let saml = &connection["saml"];
    assert!(
        saml["entityId"]
            .as_str()
            .unwrap_or_default()
            .ends_with("/saml/metadata")
    );
    assert!(
        saml["acsUrl"]
            .as_str()
            .unwrap_or_default()
            .ends_with("/saml/acs")
    );
    assert_eq!(saml["idpMetadataUrl"], Value::Null);
    assert_eq!(saml["idpCertificates"][0]["sha256"], "AB:CD");

    // New metadata by URL; OpenID Connect fields or a protocol switch are
    // refused (remove the connection to switch).
    let (status, view, _) = call(
        &admin.app,
        "PUT",
        "/connection",
        Some(json!({ "metadataUrl": "https://idp.example.test/metadata.xml" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(
        view["data"]["oidc"]["connection"]["saml"]["idpMetadataUrl"],
        "https://idp.example.test/metadata.xml"
    );
    for body in [json!({ "clientId": "abc" }), json!({ "protocol": "oidc" })] {
        let (status, view, _) = call(&admin.app, "PUT", "/connection", Some(body)).await;
        assert_eq!(
            (status, &view["error"]["code"]),
            (StatusCode::CONFLICT, &json!("SSO_PROTOCOL_MISMATCH"))
        );
    }
    let (status, _, _) = call(&admin.app, "DELETE", "/connection", None).await;
    assert_eq!(status, StatusCode::OK);

    // The changes were published with the protocol, never the metadata.
    admin.tracker.close();
    admin.tracker.wait().await;
    let payloads: Vec<String> = admin
        .bus
        .messages()
        .iter()
        .map(|message| String::from_utf8_lossy(&message.payload).into_owned())
        .collect();
    assert!(
        payloads
            .iter()
            .any(|text| text.contains("connection_created") && text.contains("\"saml\"")),
        "{payloads:?}"
    );
    assert!(
        payloads
            .iter()
            .all(|text| !text.contains("EntityDescriptor"))
    );
}
