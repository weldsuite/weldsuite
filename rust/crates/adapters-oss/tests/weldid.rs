//! The WeldID identity adapter against a mock of WeldID (discovery, the
//! token endpoint with `private_key_jwt`, the admin API), and its membership
//! half against a real Postgres when `WELDSUITE_TEST_DATABASE_URL` points at a
//! throwaway database (otherwise that test returns early).

use std::sync::{Arc, Mutex};

use aws_lc_rs::rand::SystemRandom;
use aws_lc_rs::signature::{
    ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair,
    UnparsedPublicKey,
};
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use weldsuite_adapters_oss::{
    INVITATION_DAYS, INVITATION_EMAIL_MISMATCH, INVITATION_EMAIL_UNVERIFIED, INVITATION_EXPIRED,
    WELDID_ADMIN_SCOPES, WeldIdIdentity, WeldIdOptions, WeldIdSso,
};
use weldsuite_ports::{
    BoxFuture, Identity, IdentityError, InvitationEmail, InvitationMailer, ListPage, NewInvitation,
    NewMembership, NewOrganization, NewSsoConnection, OrganizationChanges, PortError,
    SsoConnectionChanges, SsoDirectory, SsoDomainStatus, UserChanges,
};

const CLIENT: &str = "weldsuite-backend";

/// One request the mock received.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    query: String,
    host: Option<String>,
    authorization: Option<String>,
    body: String,
}

type Responder = dyn Fn(&str, &str, &str) -> (StatusCode, Value) + Send + Sync;

#[derive(Clone)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
    respond: Arc<Responder>,
}

async fn handle(
    State(mock): State<Mock>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let seen = Seen {
        method: method.to_string(),
        path: uri.path().to_owned(),
        query: uri.query().unwrap_or_default().to_owned(),
        host: header("host"),
        authorization: header("authorization"),
        body: String::from_utf8(body.to_vec()).expect("utf-8"),
    };
    mock.seen.lock().expect("lock").push(seen.clone());
    // Discovery, as WeldID answers it, naming the mock's own token endpoint.
    if seen.path == "/.well-known/openid-configuration" {
        let host = seen.host.clone().unwrap_or_default();
        let document = json!({
            "issuer": format!("http://{host}"),
            "token_endpoint": format!("http://{host}/oauth/token"),
        });
        return (StatusCode::OK, document.to_string());
    }
    let (status, answer) = (mock.respond)(&seen.method, &seen.path, &seen.query);
    if answer.is_null() {
        return (status, String::new());
    }
    (status, answer.to_string())
}

/// A P-256 key as WeldID's backend client holds it, and its public point.
fn client_key() -> (String, Vec<u8>) {
    let rng = SystemRandom::new();
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("generate");
    let pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref()).expect("parse");
    let encoded = STANDARD.encode(pkcs8.as_ref());
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(64)
        .map(|chunk| std::str::from_utf8(chunk).expect("ascii"))
        .collect();
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        lines.join("\n")
    );
    (pem, pair.public_key().as_ref().to_vec())
}

struct Setup {
    identity: WeldIdIdentity,
    seen: Arc<Mutex<Vec<Seen>>>,
    base: String,
    public_key: Vec<u8>,
}

/// The mock on a free port; the issuer is the mock itself unless `issuer`
/// names another host (then the token endpoint is given, not discovered).
async fn mock(
    issuer: Option<&str>,
    respond: impl Fn(&str, &str, &str) -> (StatusCode, Value) + Send + Sync + 'static,
) -> Setup {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let state = Mock {
        seen: Arc::clone(&seen),
        respond: Arc::new(respond),
    };
    let app = Router::new().fallback(handle).with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    let base = format!("http://{address}");
    let (pem, public_key) = client_key();
    let master =
        weldsuite_db::master_pool("postgres://weldsuite:x@127.0.0.1:1/none", 1).expect("lazy pool");
    let identity = WeldIdIdentity::new(
        WeldIdOptions {
            issuer: issuer.map_or_else(|| format!("{base}/"), str::to_owned),
            admin_url: format!("{base}/"),
            client_id: CLIENT.to_owned(),
            // As a Kubernetes Secret often holds it: one line, escaped.
            client_key: pem.replace('\n', "\\n"),
            token_endpoint: issuer.map(|_| format!("{base}/oauth/token")),
            invitation_mailer: None,
        },
        master,
    )
    .expect("adapter");
    Setup {
        identity,
        seen,
        base,
        public_key,
    }
}

/// The form fields of a token request.
fn form(body: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn form_field(fields: &[(String, String)], name: &str) -> String {
    fields
        .iter()
        .find(|(k, _)| k == name)
        .map_or_else(|| panic!("no {name}"), |(_, v)| v.clone())
}

fn calls(seen: &Arc<Mutex<Vec<Seen>>>, path: &str) -> Vec<Seen> {
    seen.lock()
        .expect("lock")
        .iter()
        .filter(|s| s.path == path)
        .cloned()
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn users_and_sessions_go_through_the_admin_api_with_one_cached_token() {
    let tokens = Mutex::new(0_u32);
    let setup = mock(None, move |method, path, query| {
        match (method, path, query) {
            ("POST", "/oauth/token", _) => {
                let mut count = tokens.lock().expect("lock");
                *count += 1;
                (
                    StatusCode::OK,
                    json!({ "access_token": format!("at-{count}"), "token_type": "Bearer", "expires_in": 600 }),
                )
            }
            ("GET", "/admin/v1/users/usr_1", _) => (
                StatusCode::OK,
                json!({ "data": {
                    "id": "usr_1", "email": "ann@acme.test", "emailVerified": true,
                    "name": "Ann Smit", "givenName": "Ann", "familyName": "Smit",
                    "picture": "https://img.test/ann.png", "status": "active",
                    "metadata": { "role": "founder", "keep": 1 },
                } }),
            ),
            ("GET", "/admin/v1/users", "email=ann%40acme.test") => (
                StatusCode::OK,
                json!({ "data": [
                    { "id": "usr_1", "email": "ann@acme.test", "status": "active" },
                    { "id": "usr_9", "email": "ann@acme.test", "status": "deleted" },
                ], "pagination": { "hasMore": false, "cursor": null } }),
            ),
            ("PATCH", "/admin/v1/users/usr_1", _) => (StatusCode::OK, json!({ "data": {} })),
            ("GET", "/admin/v1/users/usr_1/sessions", _) => (
                StatusCode::OK,
                json!({ "data": [
                    { "id": "ses_1", "userId": "usr_1", "createdAt": "2026-11-01T10:00:00Z" },
                    { "id": "ses_2", "userId": "usr_1", "revokedAt": "2026-11-02T10:00:00Z" },
                ] }),
            ),
            ("GET", "/admin/v1/sessions/ses_1", _) => (
                StatusCode::OK,
                json!({ "data": { "id": "ses_1", "userId": "usr_1" } }),
            ),
            ("DELETE", "/admin/v1/sessions/ses_1" | "/admin/v1/users/usr_1", _) => {
                (StatusCode::NO_CONTENT, Value::Null)
            }
            ("GET", "/admin/v1/users/usr_404", _) => (
                StatusCode::NOT_FOUND,
                json!({ "error": { "code": "NOT_FOUND", "message": "User not found" } }),
            ),
            _ => (
                StatusCode::IM_A_TEAPOT,
                json!({ "unexpected": [method, path, query] }),
            ),
        }
    })
    .await;
    let identity = &setup.identity;

    let profile = identity.user_profile("usr_1").await.expect("profile");
    assert_eq!(profile.primary_email(), Some("ann@acme.test"));
    assert_eq!(profile.first_name.as_deref(), Some("Ann"));
    assert_eq!(profile.last_name.as_deref(), Some("Smit"));
    assert_eq!(
        profile.image_url.as_deref(),
        Some("https://img.test/ann.png")
    );

    let users = identity
        .users_by_email("ann@acme.test", 5)
        .await
        .expect("users");
    assert_eq!(
        users.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
        ["usr_1"],
        "a deleted user is not found by email"
    );

    identity
        .update_user(
            "usr_1",
            &UserChanges {
                first_name: Some("Anna".to_owned()),
                last_name: None,
            },
        )
        .await
        .expect("update");
    identity
        .update_user_metadata(
            "usr_1",
            &json!({ "role": "owner", "keep": null, "new": true }),
        )
        .await
        .expect("metadata");

    let sessions = identity.sessions("usr_1").await.expect("sessions");
    assert_eq!(sessions.len(), 1, "revoked sessions are left out");
    assert_eq!(sessions[0].id, "ses_1");
    assert_eq!(
        identity.session("ses_1").await.expect("session").user_id,
        "usr_1"
    );
    identity.revoke_session("ses_1").await.expect("revoke");
    identity.delete_user("usr_1").await.expect("delete");

    let missing = identity.user_profile("usr_404").await.expect_err("missing");
    assert!(missing.is_not_found());
    assert_eq!(missing.code(), Some("NOT_FOUND"));
    // An id that isn't a plain path segment never reaches WeldID.
    assert!(
        identity
            .user_profile("../sessions/ses_1")
            .await
            .expect_err("refused")
            .is_not_found()
    );

    // One discovery, one token, reused for every admin call.
    assert_eq!(
        calls(&setup.seen, "/.well-known/openid-configuration").len(),
        1
    );
    let tokens = calls(&setup.seen, "/oauth/token");
    assert_eq!(tokens.len(), 1);
    let admin: Vec<Seen> = setup
        .seen
        .lock()
        .expect("lock")
        .iter()
        .filter(|s| s.path.starts_with("/admin/"))
        .cloned()
        .collect();
    assert!(admin.len() >= 10, "{admin:?}");
    assert!(
        admin
            .iter()
            .all(|s| s.authorization.as_deref() == Some("Bearer at-1"))
    );
    // Same host for issuer and admin URL: no Host rewrite.
    let expected_host = setup.base.trim_start_matches("http://");
    assert!(
        admin
            .iter()
            .all(|s| s.host.as_deref() == Some(expected_host))
    );

    // The updates: camelCase names, and the metadata merged like Clerk's.
    let patches = calls(&setup.seen, "/admin/v1/users/usr_1")
        .into_iter()
        .filter(|s| s.method == "PATCH")
        .map(|s| serde_json::from_str::<Value>(&s.body).expect("json"))
        .collect::<Vec<_>>();
    assert_eq!(patches[0], json!({ "givenName": "Anna" }));
    assert_eq!(
        patches[1],
        json!({ "metadata": { "role": "owner", "new": true } })
    );

    // The token request: client credentials with a signed ES256 assertion.
    let fields = form(&tokens[0].body);
    assert_eq!(form_field(&fields, "grant_type"), "client_credentials");
    assert_eq!(form_field(&fields, "client_id"), CLIENT);
    assert_eq!(form_field(&fields, "scope"), WELDID_ADMIN_SCOPES);
    assert_eq!(
        form_field(&fields, "client_assertion_type"),
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    );
    let assertion = form_field(&fields, "client_assertion");
    let parts: Vec<&str> = assertion.split('.').collect();
    assert_eq!(parts.len(), 3);
    let decode = |part: &str| -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).expect("base64url")).expect("json")
    };
    assert_eq!(decode(parts[0])["alg"], "ES256");
    let claims = decode(parts[1]);
    assert_eq!(claims["iss"], CLIENT);
    assert_eq!(claims["sub"], CLIENT);
    assert_eq!(
        claims["aud"],
        setup.base.as_str(),
        "the issuer, without its slash"
    );
    assert_eq!(
        claims["exp"].as_i64().expect("exp") - claims["iat"].as_i64().expect("iat"),
        60
    );
    assert_eq!(claims["jti"].as_str().map(str::len), Some(32));
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &setup.public_key)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &URL_SAFE_NO_PAD.decode(parts[2]).expect("signature"),
        )
        .expect("the assertion is signed with the client key");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_token_is_fetched_once_more() {
    let refused = Mutex::new(false);
    let setup = mock(
        Some("https://auth.example.test"),
        move |method, path, _| match (method, path) {
            ("POST", "/oauth/token") => (
                StatusCode::OK,
                json!({ "access_token": "fresh", "expires_in": 600 }),
            ),
            ("GET", "/admin/v1/users/usr_1") => {
                let mut once = refused.lock().expect("lock");
                if *once {
                    (
                        StatusCode::OK,
                        json!({ "data": { "id": "usr_1", "email": "a@b.test" } }),
                    )
                } else {
                    *once = true;
                    (
                        StatusCode::UNAUTHORIZED,
                        json!({ "error": { "code": "UNAUTHORIZED", "message": "expired" } }),
                    )
                }
            }
            _ => (StatusCode::NOT_FOUND, Value::Null),
        },
    )
    .await;
    let profile = setup.identity.user_profile("usr_1").await.expect("retried");
    assert_eq!(profile.primary_email(), Some("a@b.test"));
    assert_eq!(calls(&setup.seen, "/oauth/token").len(), 2);
    // The token endpoint was given: no discovery.
    assert!(calls(&setup.seen, "/.well-known/openid-configuration").is_empty());
    // An in-cluster admin URL carries the issuer's host.
    let admin = calls(&setup.seen, "/admin/v1/users/usr_1");
    assert!(
        admin
            .iter()
            .all(|s| s.host.as_deref() == Some("auth.example.test"))
    );
    let assertion = form_field(
        &form(&calls(&setup.seen, "/oauth/token")[0].body),
        "client_assertion",
    );
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(assertion.split('.').nth(1).expect("claims"))
            .expect("base64url"),
    )
    .expect("json");
    assert_eq!(claims["aud"], "https://auth.example.test");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_endpoint_refusal_is_unavailable_and_never_leaks_the_assertion() {
    let setup = mock(
        Some("https://auth.example.test"),
        |method, path, _| match (method, path) {
            ("POST", "/oauth/token") => (
                StatusCode::BAD_REQUEST,
                json!({ "error": "invalid_client", "error_description": "bad assertion" }),
            ),
            _ => (StatusCode::OK, json!({ "data": {} })),
        },
    )
    .await;
    let error = setup.identity.sessions("usr_1").await.expect_err("refused");
    let IdentityError::Unavailable(reason) = &error else {
        panic!("unavailable expected: {error:?}");
    };
    assert!(reason.contains("invalid_client"), "{reason}");
    assert!(!reason.contains("eyJ"), "{reason}");
    assert!(calls(&setup.seen, "/admin/v1/users/usr_1/sessions").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_outbox_is_read_after_a_cursor() {
    let setup = mock(Some("https://auth.example.test"), |method, path, query| {
        match (method, path) {
            ("POST", "/oauth/token") => (
                StatusCode::OK,
                json!({ "access_token": "t", "expires_in": 600 }),
            ),
            ("GET", "/admin/v1/events") if query == "after=41&limit=2" => (
                StatusCode::OK,
                json!({
                    "data": [
                        { "id": 42, "at": "2026-11-16T10:00:00Z", "kind": "user.updated", "userId": "usr_1", "data": {} },
                        { "id": 43, "at": "2026-11-16T10:00:01Z", "kind": "session.revoked", "userId": "usr_1", "data": { "sessionId": "ses_1" } },
                    ],
                    "pagination": { "hasMore": true, "cursor": "43" },
                }),
            ),
            ("GET", "/admin/v1/events") if query == "limit=2" => (
                StatusCode::OK,
                json!({ "data": [], "pagination": { "hasMore": false, "cursor": null } }),
            ),
            _ => (StatusCode::NOT_FOUND, Value::Null),
        }
    })
    .await;
    let page = setup
        .identity
        .events_after(Some("41"), 2)
        .await
        .expect("page");
    assert!(page.has_more);
    assert_eq!(page.next_cursor(), Some("43"));
    assert_eq!(page.events[0].id, "42");
    assert_eq!(page.events[0].kind, "user.updated");
    assert_eq!(page.events[1].user_id.as_deref(), Some("usr_1"));
    assert_eq!(page.events[1].data["sessionId"], "ses_1");
    let empty = setup.identity.events_after(None, 2).await.expect("page");
    assert_eq!(empty.events, Vec::new());
    assert!(!empty.has_more);
}

#[tokio::test(flavor = "multi_thread")]
async fn organization_metadata_is_not_kept() {
    let setup = mock(Some("https://auth.example.test"), |_, _, _| {
        (StatusCode::INTERNAL_SERVER_ERROR, Value::Null)
    })
    .await;
    setup
        .identity
        .update_organization_metadata("org_1", Some(&json!({ "selectedApps": ["crm"] })), None)
        .await
        .expect("accepted, not kept");
    // Nothing reached WeldID.
    assert!(setup.seen.lock().expect("lock").is_empty());
}

/// The database tests reset the same tables: one at a time.
static DATABASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const SCHEMA: &str = "
drop table if exists workspace_invitations, user_workspaces, workspaces, users cascade;
drop type if exists membership_status;
create type membership_status as enum ('ACTIVE', 'PENDING');
create table users (
    id varchar(255) primary key,
    email varchar(255) not null,
    first_name varchar(255),
    last_name varchar(255),
    image_url varchar(500),
    is_active boolean not null default true,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);
create table workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    name varchar(255) not null,
    slug varchar(255) not null unique,
    deleted_at timestamp
);
create table user_workspaces (
    id varchar(30) primary key,
    user_id varchar(255) not null references users (id),
    workspace_id varchar(255) not null references workspaces (id) on delete cascade,
    clerk_membership_id varchar(255),
    role varchar(50) not null default 'org:member',
    status membership_status not null default 'ACTIVE',
    invited_by varchar(255),
    invited_at timestamp,
    joined_at timestamp,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);
create unique index user_workspaces_user_workspace_idx on user_workspaces (user_id, workspace_id);
-- As master migration 0070 makes it.
create table workspace_invitations (
    id varchar(30) primary key,
    workspace_id varchar(255) not null references workspaces (id) on delete cascade,
    email varchar(320) not null,
    email_normalized varchar(320) not null,
    role varchar(50) not null,
    public_metadata jsonb not null default '{}'::jsonb,
    status varchar(20) not null default 'pending',
    invited_by varchar(255) references users (id) on delete set null,
    accepted_by varchar(255) references users (id) on delete set null,
    created_at timestamp with time zone not null default now(),
    expires_at timestamp with time zone not null,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    constraint workspace_invitations_status_check check (status in ('pending', 'accepted', 'revoked'))
);
create unique index workspace_invitations_pending_email_uidx
    on workspace_invitations (workspace_id, email_normalized) where status = 'pending';
insert into users (id, email, first_name, last_name) values
    ('usr_owner', 'owner@acme.test', 'Olga', 'Owner');
insert into workspaces (id, clerk_org_id, name, slug) values
    ('ws_acme', 'org_acme', 'Acme', 'acme'),
    ('ws_old', null, 'Old', 'old');
insert into user_workspaces (id, user_id, workspace_id, role, created_at) values
    ('uw_1', 'usr_owner', 'ws_acme', 'org:admin', '2026-01-01T00:00:00'),
    ('uw_2', 'usr_owner', 'ws_old', 'org:member', '2026-01-02T00:00:00');
";

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn organizations_and_memberships_are_weldsuites_own() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let _one_at_a_time = DATABASE.lock().await;
    let master = weldsuite_db::master_pool(&url, 2).expect("pool");
    sqlx::raw_sql(SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    // WeldID knows the guest, who never signed in to WeldSuite.
    let setup = mock(Some("https://auth.example.test"), |method, path, _| {
        match (method, path) {
            ("POST", "/oauth/token") => (
                StatusCode::OK,
                json!({ "access_token": "t", "expires_in": 600 }),
            ),
            ("GET", "/admin/v1/users/usr_guest") => (
                StatusCode::OK,
                json!({ "data": { "id": "usr_guest", "email": "guest@else.test", "givenName": "Gus" } }),
            ),
            _ => (StatusCode::NOT_FOUND, Value::Null),
        }
    })
    .await;
    let (pem, _) = client_key();
    let identity = WeldIdIdentity::new(
        WeldIdOptions {
            issuer: "https://auth.example.test".to_owned(),
            admin_url: format!("{}/", setup.base),
            client_id: CLIENT.to_owned(),
            client_key: pem,
            token_endpoint: Some(format!("{}/oauth/token", setup.base)),
            invitation_mailer: None,
        },
        master.clone(),
    )
    .expect("adapter");

    // By organization id or workspace id; the reference is the org id.
    for reference in ["org_acme", "ws_acme"] {
        let organization = identity.organization(reference).await.expect("found");
        assert_eq!(organization.id, "org_acme");
        assert_eq!(organization.name, "Acme");
        assert_eq!(organization.slug.as_deref(), Some("acme"));
        assert_eq!(organization.max_memberships, None);
    }
    assert_eq!(
        identity.organization("ws_old").await.expect("found").id,
        "ws_old",
        "no organization id: the workspace id"
    );
    assert!(
        identity
            .organization("org_none")
            .await
            .expect_err("gone")
            .is_not_found()
    );
    identity
        .update_organization("org_acme", &OrganizationChanges::default())
        .await
        .expect("nothing to sync");

    let mine = identity
        .user_memberships("usr_owner", 10)
        .await
        .expect("mine");
    assert_eq!(mine.len(), 2);
    let first = mine[0].organization.clone().expect("organization");
    assert_eq!(
        (first.id.as_str(), first.slug.as_str()),
        ("org_acme", "acme")
    );
    assert_eq!(mine[0].role, "org:admin");
    assert_eq!(mine[0].user.identifier, "owner@acme.test");

    // A guest with a WeldID account joins: their users row comes from WeldID.
    let added = identity
        .add_membership(
            "org_acme",
            &NewMembership {
                user_id: "usr_guest".to_owned(),
                role: "org:member".to_owned(),
                public_metadata: Some(json!({ "member_type": "EXTERNAL_GUEST" })),
            },
        )
        .await
        .expect("added");
    assert!(added.id.starts_with("uw_"));
    let again = identity
        .add_membership(
            "org_acme",
            &NewMembership {
                user_id: "usr_guest".to_owned(),
                role: "org:member".to_owned(),
                public_metadata: None,
            },
        )
        .await
        .expect_err("already a member");
    assert_eq!(again.code(), Some("already_a_member_in_organization"));
    let email: String = sqlx::query_scalar("select email from users where id = 'usr_guest'")
        .fetch_one(&master)
        .await
        .expect("users row");
    assert_eq!(email, "guest@else.test");

    let members = identity
        .memberships("org_acme", ListPage::limit(1))
        .await
        .expect("members");
    assert_eq!(members.total_count, Some(2));
    assert_eq!(members.data.len(), 1);
    assert_eq!(members.data[0].user.user_id, "usr_owner");
    let all = identity
        .memberships("ws_acme", ListPage::default())
        .await
        .expect("members");
    assert_eq!(all.data.len(), 2);

    identity
        .set_membership_role("org_acme", "usr_guest", "org:admin")
        .await
        .expect("role");
    identity
        .remove_membership("org_acme", "usr_guest")
        .await
        .expect("removed");
    assert!(
        identity
            .remove_membership("org_acme", "usr_guest")
            .await
            .expect_err("not a member")
            .is_not_found()
    );
    assert!(
        identity
            .set_membership_role("org_acme", "usr_guest", "org:admin")
            .await
            .expect_err("not a member")
            .is_not_found()
    );

    // A new organization is only an id, once the slug is free.
    let taken = identity
        .create_organization(&NewOrganization {
            name: "Acme 2".to_owned(),
            slug: Some("acme".to_owned()),
            ..NewOrganization::default()
        })
        .await
        .expect_err("taken");
    assert!(taken.is_slug_error());
    let created = identity
        .create_organization(&NewOrganization {
            name: "Beta".to_owned(),
            slug: Some("beta".to_owned()),
            created_by: Some("usr_owner".to_owned()),
            ..NewOrganization::default()
        })
        .await
        .expect("created");
    assert!(created.id.starts_with("org_"));
    assert_eq!(created.slug.as_deref(), Some("beta"));

    // Deleting the organization removes the workspace's memberships.
    identity
        .delete_organization("org_acme")
        .await
        .expect("deleted");
    let left: i64 =
        sqlx::query_scalar("select count(*) from user_workspaces where workspace_id = 'ws_acme'")
            .fetch_one(&master)
            .await
            .expect("count");
    assert_eq!(left, 0);
    assert_eq!(
        identity
            .user_memberships("usr_owner", 10)
            .await
            .expect("mine")
            .len(),
        1
    );
}

/// Records the invitation emails instead of sending them.
#[derive(Default)]
struct Outbox(Mutex<Vec<InvitationEmail>>);

impl InvitationMailer for Outbox {
    fn send<'a>(&'a self, email: &'a InvitationEmail) -> BoxFuture<'a, Result<(), PortError>> {
        self.0.lock().expect("lock").push(email.clone());
        Box::pin(async { Ok(()) })
    }
}

fn refusal(error: &IdentityError) -> (Option<u16>, Option<&str>) {
    (error.status(), error.code())
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn invitations_are_weldsuites_own_and_need_the_verified_address() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let _one_at_a_time = DATABASE.lock().await;
    let master = weldsuite_db::master_pool(&url, 4).expect("pool");
    sqlx::raw_sql(SCHEMA)
        .execute(&master)
        .await
        .expect("schema");
    // WeldID's users: who they say they are, and whether WeldID verified it.
    let setup = mock(Some("https://auth.example.test"), |method, path, _| {
        let user = |id: &str, email: &str, verified: bool| {
            (
                StatusCode::OK,
                json!({ "data": { "id": id, "email": email, "emailVerified": verified, "givenName": "Nia", "familyName": "New" } }),
            )
        };
        match (method, path) {
            ("POST", "/oauth/token") => (
                StatusCode::OK,
                json!({ "access_token": "t", "expires_in": 600 }),
            ),
            ("GET", "/admin/v1/users/usr_new") => user("usr_new", "New@Acme.test", true),
            ("GET", "/admin/v1/users/usr_late") => user("usr_late", "late@acme.test", false),
            ("GET", "/admin/v1/users/usr_other") => user("usr_other", "other@acme.test", true),
            ("GET", "/admin/v1/users/usr_owner") => user("usr_owner", "owner@acme.test", true),
            ("GET", "/admin/v1/users/usr_twin") => user("usr_twin", "twin@acme.test", true),
            _ => (StatusCode::NOT_FOUND, Value::Null),
        }
    })
    .await;
    let outbox = Arc::new(Outbox::default());
    let (pem, _) = client_key();
    let identity = WeldIdIdentity::new(
        WeldIdOptions {
            issuer: "https://auth.example.test".to_owned(),
            admin_url: format!("{}/", setup.base),
            client_id: CLIENT.to_owned(),
            client_key: pem,
            token_endpoint: Some(format!("{}/oauth/token", setup.base)),
            invitation_mailer: Some(Arc::clone(&outbox) as Arc<dyn InvitationMailer>),
        },
        master.clone(),
    )
    .expect("adapter");
    let invite = |email: &str, role: &str| NewInvitation {
        email_address: email.to_owned(),
        role: role.to_owned(),
        redirect_url: Some("https://app.example.test/invite?org_id=org_acme".to_owned()),
        invited_by: Some("usr_owner".to_owned()),
        ..NewInvitation::default()
    };

    // Inviting: a 128-bit id, open 14 days, emailed with the link.
    let invited = identity
        .invite("org_acme", &invite(" new@acme.test ", "org:member"))
        .await
        .expect("invited");
    assert!(
        invited.id.starts_with("inv_") && invited.id.len() == 30,
        "{}",
        invited.id
    );
    assert_eq!(invited.email_address, "new@acme.test");
    assert_eq!(invited.status, "pending");
    let open = invited.expires_at.expect("expires") - invited.created_at.expect("created");
    assert!(
        (open - i64::from(INVITATION_DAYS) * 86_400_000).abs() < 5_000,
        "{open}"
    );
    let sent = outbox.0.lock().expect("lock").clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "new@acme.test");
    assert_eq!(sent[0].inviter_name.as_deref(), Some("Olga Owner"));
    assert_eq!(sent[0].inviter_email.as_deref(), Some("owner@acme.test"));
    assert_eq!(sent[0].workspace_name.as_deref(), Some("Acme"));
    assert_eq!(sent[0].role, "org:member");
    assert_eq!(
        sent[0].accept_url,
        format!(
            "https://app.example.test/invite?org_id=org_acme&invitation_id={}&email=new%40acme.test&org_name=Acme",
            invited.id
        )
    );

    // One pending invitation per address, whatever its case.
    let twice = identity
        .invite("ws_acme", &invite("NEW@acme.test", "org:admin"))
        .await
        .expect_err("pending already");
    assert_eq!(refusal(&twice), (Some(422), Some("duplicate_record")));

    // Listed and found in its workspace; by id from anywhere.
    let pending = identity
        .invitations("org_acme", Some("pending"), ListPage::limit(1))
        .await
        .expect("listed");
    assert_eq!(pending.total_count, Some(1));
    assert_eq!(pending.data[0].id, invited.id);
    assert_eq!(
        identity
            .invitation("ws_acme", &invited.id)
            .await
            .expect("found")
            .email_address,
        "new@acme.test"
    );
    assert!(
        identity
            .invitation("ws_old", &invited.id)
            .await
            .expect_err("another workspace's")
            .is_not_found()
    );
    let (organization, found) = identity
        .find_invitation(&invited.id)
        .await
        .expect("found")
        .expect("kept here");
    assert_eq!(
        (organization.id.as_str(), organization.name.as_str()),
        ("org_acme", "Acme")
    );
    assert_eq!(found.id, invited.id);
    assert!(
        identity
            .find_invitation("inv_none")
            .await
            .expect_err("none")
            .is_not_found()
    );

    // Accepting takes the invited address, verified at WeldID.
    let other = identity
        .accept_invitation(&invited.id, "usr_other")
        .await
        .expect_err("another address");
    assert_eq!(
        refusal(&other),
        (Some(403), Some(INVITATION_EMAIL_MISMATCH))
    );
    let late = identity
        .invite("org_acme", &invite("late@acme.test", "org:member"))
        .await
        .expect("invited");
    let unverified = identity
        .accept_invitation(&late.id, "usr_late")
        .await
        .expect_err("unverified");
    assert_eq!(
        refusal(&unverified),
        (Some(403), Some(INVITATION_EMAIL_UNVERIFIED))
    );
    let membership = identity
        .accept_invitation(&invited.id, "usr_new")
        .await
        .expect("accepted")
        .expect("a membership");
    assert_eq!(membership.role, "org:member");
    assert_eq!(membership.user.user_id, "usr_new");
    assert_eq!(membership.user.identifier, "New@Acme.test");
    assert_eq!(membership.user.first_name.as_deref(), Some("Nia"));
    let organization = membership.organization.expect("organization");
    assert_eq!(
        (organization.id.as_str(), organization.name.as_str()),
        ("org_acme", "Acme")
    );
    let (status, invited_by): (String, Option<String>) = sqlx::query_as(
        "select status::text, invited_by from user_workspaces
          where user_id = 'usr_new' and workspace_id = 'ws_acme'",
    )
    .fetch_one(&master)
    .await
    .expect("membership row");
    assert_eq!(
        (status.as_str(), invited_by.as_deref()),
        ("ACTIVE", Some("usr_owner"))
    );
    assert_eq!(
        identity
            .invitation("org_acme", &invited.id)
            .await
            .expect("kept")
            .status,
        "accepted"
    );
    assert!(
        identity
            .user_memberships("usr_new", 10)
            .await
            .expect("theirs")
            .iter()
            .any(|m| m.organization.as_ref().is_some_and(|o| o.id == "org_acme"))
    );
    // Once.
    assert!(
        identity
            .accept_invitation(&invited.id, "usr_new")
            .await
            .expect_err("used")
            .is_not_found()
    );

    // An active member keeps their role.
    let owner = identity
        .invite("org_acme", &invite("owner@acme.test", "org:member"))
        .await
        .expect("invited");
    let kept = identity
        .accept_invitation(&owner.id, "usr_owner")
        .await
        .expect("accepted")
        .expect("a membership");
    assert_eq!(kept.role, "org:admin");

    // Revoking: once, and only a pending one.
    identity
        .revoke_invitation("org_acme", &late.id)
        .await
        .expect("revoked");
    assert!(
        identity
            .revoke_invitation("org_acme", &late.id)
            .await
            .expect_err("revoked already")
            .is_not_found()
    );
    assert_eq!(
        identity
            .invitation("org_acme", &late.id)
            .await
            .expect("kept")
            .status,
        "revoked"
    );

    // Expired: read as expired, refused as gone, left out of the pending
    // count, and no obstacle to a new invitation.
    sqlx::query(
        "insert into workspace_invitations
             (id, workspace_id, email, email_normalized, role, expires_at, created_at)
         values ('inv_old', 'ws_acme', 'old@acme.test', 'old@acme.test', 'org:member',
                 now() - interval '1 day', now() - interval '15 days')",
    )
    .execute(&master)
    .await
    .expect("an old invitation");
    assert_eq!(
        identity
            .invitation("org_acme", "inv_old")
            .await
            .expect("kept")
            .status,
        "expired"
    );
    let gone = identity
        .accept_invitation("inv_old", "usr_new")
        .await
        .expect_err("expired");
    assert_eq!(refusal(&gone), (Some(410), Some(INVITATION_EXPIRED)));
    assert_eq!(
        identity
            .invitations("org_acme", Some("pending"), ListPage::default())
            .await
            .expect("listed")
            .total_count,
        Some(0)
    );
    assert_eq!(
        identity
            .invitations("org_acme", Some("expired"), ListPage::default())
            .await
            .expect("listed")
            .total_count,
        Some(1)
    );
    let again = identity
        .invite("org_acme", &invite("old@acme.test", "org:member"))
        .await
        .expect("a new invitation");
    assert_eq!(again.status, "pending");
    assert_eq!(
        identity
            .invitation("org_acme", "inv_old")
            .await
            .expect("kept")
            .status,
        "revoked"
    );

    // Two acceptances at once: exactly one joins.
    let twin = identity
        .invite("org_acme", &invite("twin@acme.test", "org:member"))
        .await
        .expect("invited");
    let (first, second) = tokio::join!(
        identity.accept_invitation(&twin.id, "usr_twin"),
        identity.accept_invitation(&twin.id, "usr_twin"),
    );
    let joined = [first.is_ok(), second.is_ok()];
    assert_eq!(joined.iter().filter(|ok| **ok).count(), 1, "{joined:?}");
    let members: i64 = sqlx::query_scalar(
        "select count(*) from user_workspaces where user_id = 'usr_twin' and workspace_id = 'ws_acme'",
    )
    .fetch_one(&master)
    .await
    .expect("count");
    assert_eq!(members, 1);

    // A deleted workspace's invitations are gone with it.
    sqlx::query("update workspaces set deleted_at = now() where id = 'ws_acme'")
        .execute(&master)
        .await
        .expect("deleted");
    assert!(
        identity
            .find_invitation(&again.id)
            .await
            .expect_err("workspace gone")
            .is_not_found()
    );
    assert!(
        identity
            .accept_invitation(&again.id, "usr_new")
            .await
            .expect_err("workspace gone")
            .is_not_found()
    );
}

/// A connection as the fake WeldID keeps it (`weldid-server::admin::sso`).
fn fake_connection(id: &str, tenant: &str, domains: &Value) -> Value {
    json!({
        "id": id, "tenantRef": tenant, "protocol": "oidc", "displayName": "Acme Entra",
        "issuer": "https://login.example.test/acme/v2.0", "clientId": "client-1",
        // A careless WeldID echoing the secret: the adapter never reads it.
        "clientSecret": "echoed", "hasClientSecret": true,
        "scopes": ["groups"], "trustEmails": false, "enabled": false, "enforceSso": false,
        "redirectUri": format!("https://auth.example.test/sso/{id}/callback"),
        "domains": domains,
        "createdAt": "2026-11-16T10:00:00Z", "updatedAt": "2026-11-16T10:00:00Z",
    })
}

const A: &str = "/admin/v1/tenants/ws_a/sso/connections";

/// The fake WeldID's SSO admin API: the domains of `ssoc_1` and whether its
/// TXT record is up are its state; `ssoc_b` is another tenant's, which this
/// fake wrongly answers under `ws_a` too.
fn fake_sso(
    domains: &Mutex<Value>,
    record_up: &Mutex<bool>,
    method: &str,
    path: &str,
) -> (StatusCode, Value) {
    let current = domains.lock().expect("lock").clone();
    let ssoc_1 = format!("{A}/ssoc_1");
    match (method, path) {
        ("POST", "/oauth/token") => (
            StatusCode::OK,
            json!({ "access_token": "at-sso", "token_type": "Bearer", "expires_in": 600 }),
        ),
        ("GET", A) => (
            StatusCode::OK,
            json!({ "data": [
                fake_connection("ssoc_1", "ws_a", &current),
                fake_connection("ssoc_b", "ws_b", &json!([])),
                { "id": "ssoc_saml", "tenantRef": "ws_a", "protocol": "saml" },
            ], "pagination": { "hasMore": false, "cursor": null } }),
        ),
        ("POST", A) => (
            StatusCode::CREATED,
            json!({ "data": fake_connection("ssoc_1", "ws_a", &json!([])) }),
        ),
        ("GET", p) if p == ssoc_1 => (
            StatusCode::OK,
            json!({ "data": fake_connection("ssoc_1", "ws_a", &current) }),
        ),
        ("GET", p) if p == format!("{A}/ssoc_b") => (
            StatusCode::OK,
            json!({ "data": fake_connection("ssoc_b", "ws_b", &json!([])) }),
        ),
        ("PATCH", p) if p == ssoc_1 => {
            let mut connection = fake_connection("ssoc_1", "ws_a", &current);
            connection["enforceSso"] = json!(true);
            (StatusCode::OK, json!({ "data": connection }))
        }
        ("POST", p) if p == format!("{ssoc_1}/domains") => {
            let domain = json!({
                "id": "ssod_1", "domain": "acme.test", "status": "pending",
                "recordName": "_weldsuite-sso.acme.test",
                "recordValue": "weldsuite-sso-verification=tok1",
                "lastCheck": null, "checkedAt": null, "verifiedAt": null,
            });
            *domains.lock().expect("lock") = json!([domain.clone()]);
            // Answers the domain only: the adapter reads the connection again.
            (StatusCode::CREATED, json!({ "data": domain }))
        }
        ("POST", p) if p == format!("{ssoc_1}/domains/ssod_1/verify") => {
            let up = *record_up.lock().expect("lock");
            let mut list = domains.lock().expect("lock");
            list[0]["checkedAt"] = json!("2026-11-16T10:05:00Z");
            if up {
                list[0]["status"] = json!("verified");
                list[0]["lastCheck"] = json!("found");
                list[0]["verifiedAt"] = json!("2026-11-16T10:05:00Z");
            } else {
                list[0]["lastCheck"] = json!("missing");
            }
            (StatusCode::OK, json!({ "data": list[0].clone() }))
        }
        ("DELETE", p) if p == format!("{ssoc_1}/domains/ssod_1") => {
            *domains.lock().expect("lock") = json!([]);
            (StatusCode::NO_CONTENT, Value::Null)
        }
        ("DELETE", p) if p == ssoc_1 => (StatusCode::NO_CONTENT, Value::Null),
        _ => (
            StatusCode::IM_A_TEAPOT,
            json!({ "unexpected": [method, path] }),
        ),
    }
}

/// SSO connections through WeldID's admin API: one token asking for
/// `weldid:sso`, every path under the tenant, another tenant's connection
/// invisible (dropped from a list, a 404 before any write), the secret
/// written once and never read back, only known fields sent, domains
/// addressed by their WeldID id, and a check that finds nothing a 422.
#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn sso_connections_go_through_the_admin_api_scoped_by_tenant() {
    let domains = Arc::new(Mutex::new(json!([])));
    let record_up = Arc::new(Mutex::new(false));
    let (state_domains, state_record) = (Arc::clone(&domains), Arc::clone(&record_up));
    let setup = mock(None, move |method, path, _query| {
        fake_sso(&state_domains, &state_record, method, path)
    })
    .await;
    let seen = Arc::clone(&setup.seen);
    let sso = WeldIdSso::new(Arc::new(setup.identity));

    // Only ws_a's connections are listed, OpenID Connect and SAML.
    let listed = sso.connections("ws_a").await.expect("list");
    assert_eq!(
        listed.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["ssoc_1", "ssoc_saml"]
    );
    assert_eq!(listed[1].protocol, weldsuite_ports::SsoProtocol::Saml);
    let token = calls(&seen, "/oauth/token");
    assert!(
        form_field(&form(&token[0].body), "scope")
            .split(' ')
            .any(|scope| scope == "weldid:sso")
    );

    // Created with the secret, which never comes back.
    let created = sso
        .create_connection(
            "ws_a",
            &NewSsoConnection {
                protocol: weldsuite_ports::SsoProtocol::Oidc,
                saml_metadata: None,
                display_name: "Acme Entra".to_owned(),
                issuer: "https://login.example.test/acme/v2.0".to_owned(),
                client_id: "client-1".to_owned(),
                client_secret: Some("s3cret".to_owned()),
                scopes: vec!["groups".to_owned()],
                trust_emails: false,
                enabled: false,
                enforce_sso: false,
            },
        )
        .await
        .expect("created");
    assert!(created.has_client_secret);
    assert_eq!(
        created.redirect_uri.as_deref(),
        Some("https://auth.example.test/sso/ssoc_1/callback")
    );
    assert!(!format!("{created:?}").contains("s3cret"));
    let posted: Value = serde_json::from_str(
        &calls(&seen, A)
            .into_iter()
            .find(|s| s.method == "POST")
            .expect("posted")
            .body,
    )
    .expect("json");
    assert_eq!(
        posted,
        json!({
            "protocol": "oidc", "displayName": "Acme Entra",
            "issuer": "https://login.example.test/acme/v2.0", "clientId": "client-1",
            "clientSecret": "s3cret", "scopes": ["groups"], "trustEmails": false,
            "enabled": false, "enforceSso": false,
        })
    );

    // Another tenant's connection: a 404, and nothing is written.
    let error = sso
        .update_connection(
            "ws_a",
            "ssoc_b",
            &SsoConnectionChanges {
                enabled: Some(true),
                ..SsoConnectionChanges::default()
            },
        )
        .await
        .expect_err("another tenant's");
    assert!(error.is_not_found());
    assert!(
        calls(&seen, &format!("{A}/ssoc_b"))
            .iter()
            .all(|s| s.method == "GET")
    );

    // Only the changes are sent.
    let updated = sso
        .update_connection(
            "ws_a",
            "ssoc_1",
            &SsoConnectionChanges {
                enforce_sso: Some(true),
                ..SsoConnectionChanges::default()
            },
        )
        .await
        .expect("updated");
    assert!(updated.enforce_sso);
    let patch = calls(&seen, &format!("{A}/ssoc_1"))
        .into_iter()
        .find(|s| s.method == "PATCH")
        .expect("patched");
    assert_eq!(patch.body, json!({ "enforceSso": true }).to_string());

    // A domain, its record, a check that finds nothing, then one that does.
    let with_domain = sso
        .add_domain("ws_a", "ssoc_1", "acme.test")
        .await
        .expect("added");
    let domain = with_domain.domain("acme.test").expect("domain");
    assert_eq!(domain.status, SsoDomainStatus::Pending);
    assert_eq!(domain.txt_name, "_weldsuite-sso.acme.test");
    assert_eq!(domain.txt_value, "weldsuite-sso-verification=tok1");
    let error = sso
        .verify_domain("ws_a", "ssoc_1", "acme.test")
        .await
        .expect_err("no record yet");
    assert_eq!(
        (error.status(), error.code()),
        (Some(422), Some("domain_not_verified"))
    );
    let after_miss = sso.connections("ws_a").await.expect("list");
    assert_eq!(after_miss[0].domains[0].status, SsoDomainStatus::Failed);
    *record_up.lock().expect("lock") = true;
    let verified = sso
        .verify_domain("ws_a", "ssoc_1", "acme.test")
        .await
        .expect("verified");
    assert!(verified.has_verified_domain());

    let without = sso
        .remove_domain("ws_a", "ssoc_1", "acme.test")
        .await
        .expect("removed");
    assert_eq!(without.domains, Vec::new());
    assert!(
        sso.remove_domain("ws_a", "ssoc_1", "acme.test")
            .await
            .expect_err("gone")
            .is_not_found()
    );
    sso.delete_connection("ws_a", "ssoc_1")
        .await
        .expect("deleted");
    assert!(
        sso.delete_connection("ws_a", "ssoc_b")
            .await
            .expect_err("another tenant's")
            .is_not_found()
    );
    // Every SSO call stayed under the tenant, without a query.
    assert!(
        seen.lock()
            .expect("lock")
            .iter()
            .filter(|s| s.path.starts_with("/admin/"))
            .all(|s| s.path.starts_with(A) && s.query.is_empty())
    );
}
