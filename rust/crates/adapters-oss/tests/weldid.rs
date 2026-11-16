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
    INVITATIONS_UNAVAILABLE, WELDID_ADMIN_SCOPES, WeldIdIdentity, WeldIdOptions,
};
use weldsuite_ports::{
    Identity, IdentityError, ListPage, NewInvitation, NewMembership, NewOrganization,
    OrganizationChanges, UserChanges,
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
async fn invitations_wait_for_their_table_and_metadata_is_not_kept() {
    let setup = mock(Some("https://auth.example.test"), |_, _, _| {
        (StatusCode::INTERNAL_SERVER_ERROR, Value::Null)
    })
    .await;
    let identity = &setup.identity;
    let unavailable = |result: Result<(), IdentityError>| match result {
        Err(IdentityError::Unavailable(reason)) => assert_eq!(reason, INVITATIONS_UNAVAILABLE),
        other => panic!("unavailable expected: {other:?}"),
    };
    unavailable(
        identity
            .invite(
                "org_1",
                &NewInvitation {
                    email_address: "new@acme.test".to_owned(),
                    role: "org:member".to_owned(),
                    ..NewInvitation::default()
                },
            )
            .await
            .map(drop),
    );
    unavailable(
        identity
            .invitations("org_1", Some("pending"), ListPage::limit(500))
            .await
            .map(drop),
    );
    unavailable(identity.invitation("org_1", "inv_1").await.map(drop));
    unavailable(identity.revoke_invitation("org_1", "inv_1").await);
    identity
        .update_organization_metadata("org_1", Some(&json!({ "selectedApps": ["crm"] })), None)
        .await
        .expect("accepted, not kept");
    // Nothing reached WeldID.
    assert!(setup.seen.lock().expect("lock").is_empty());
}

const SCHEMA: &str = "
drop table if exists user_workspaces, workspaces, users cascade;
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
