//! The Zitadel identity adapter against a mock of Zitadel's API (always), and
//! against a real Zitadel when `WELDSUITE_TEST_ZITADEL_URL`,
//! `WELDSUITE_TEST_ZITADEL_TOKEN` (a service user's PAT with `IAM_OWNER`) and
//! `WELDSUITE_TEST_ZITADEL_PROJECT_ID` are set; the live test makes its own
//! organization and project grant.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use weldsuite_adapters_oss::{ZitadelIdentity, ZitadelOptions};
use weldsuite_ports::{
    Identity, IdentityChange, IdentityError, ListPage, NewInvitation, NewMembership,
    NewOrganization, OrganizationChanges, UserChanges,
};

const PROJECT: &str = "397239406596980739";
const ORG: &str = "397239406747975683";

/// One request the mock received.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    org: Option<String>,
    body: Value,
}

type Responder = dyn Fn(&str, &str, &Value) -> (StatusCode, Value) + Send + Sync;

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
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    assert_eq!(
        headers.get("authorization").and_then(|v| v.to_str().ok()),
        Some("Bearer pat-test"),
        "every call carries the service token"
    );
    mock.seen.lock().expect("lock").push(Seen {
        method: method.to_string(),
        path: uri.path().to_owned(),
        org: headers
            .get("x-zitadel-orgid")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
        body: body.clone(),
    });
    let (status, answer) = (mock.respond)(method.as_str(), uri.path(), &body);
    (status, answer.to_string())
}

async fn mock(
    respond: impl Fn(&str, &str, &Value) -> (StatusCode, Value) + Send + Sync + 'static,
) -> (ZitadelIdentity, Arc<Mutex<Vec<Seen>>>) {
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
    let identity = ZitadelIdentity::new(ZitadelOptions {
        api_url: format!("http://{address}/"),
        token: "pat-test".to_owned(),
        project_id: PROJECT.to_owned(),
        invite_url_template: Some(
            "https://app.eu.example/invite?user={{.UserID}}&code={{.Code}}".to_owned(),
        ),
        application_name: "WeldSuite".to_owned(),
        host: None,
    })
    .expect("client");
    (identity, seen)
}

fn calls(seen: &Arc<Mutex<Vec<Seen>>>) -> Vec<String> {
    seen.lock()
        .expect("lock")
        .iter()
        .map(|s| format!("{} {}", s.method, s.path))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn inviting_a_new_person_creates_the_user_sends_the_code_and_grants_the_role() {
    let (identity, seen) = mock(|method, path, _| match (method, path) {
        ("POST", "/v2/users") => (StatusCode::OK, json!({ "details": {}, "result": [] })),
        ("POST", "/v2/users/human") => (StatusCode::OK, json!({ "userId": "500" })),
        ("POST", "/v2/users/500/invite_code") => (StatusCode::OK, json!({ "details": {} })),
        ("POST", "/management/v1/granted_projects/_search") => (
            StatusCode::OK,
            json!({ "result": [{ "grantId": "pg-1", "projectId": PROJECT }] }),
        ),
        ("POST", "/management/v1/users/500/grants") => {
            (StatusCode::OK, json!({ "userGrantId": "g-9" }))
        }
        _ => (
            StatusCode::NOT_FOUND,
            json!({ "code": 5, "message": "Not Found" }),
        ),
    })
    .await;

    let invitation = identity
        .invite(
            ORG,
            &NewInvitation {
                email_address: "ann@acme.test".to_owned(),
                role: "org:admin".to_owned(),
                ..NewInvitation::default()
            },
        )
        .await
        .expect("invited");
    assert_eq!(invitation.id, "500:g-9");
    assert_eq!(invitation.status, "pending");
    assert_eq!(invitation.role, "org:admin");
    assert_eq!(
        calls(&seen),
        [
            "POST /v2/users",
            "POST /v2/users/human",
            "POST /v2/users/500/invite_code",
            "POST /management/v1/granted_projects/_search",
            "POST /management/v1/users/500/grants",
        ]
    );
    let seen = seen.lock().expect("lock").clone();
    assert_eq!(
        seen[0].body["queries"][0]["emailQuery"]["method"],
        "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE"
    );
    assert_eq!(seen[1].body["organization"]["orgId"], ORG);
    assert_eq!(seen[1].body["email"]["returnCode"], json!({}));
    assert!(
        seen[2].body["sendCode"]["urlTemplate"]
            .as_str()
            .is_some_and(|t| t.contains("{{.Code}}"))
    );
    assert_eq!(seen[3].org.as_deref(), Some(ORG));
    assert_eq!(
        seen[4].body,
        json!({ "projectId": PROJECT, "projectGrantId": "pg-1", "roleKeys": ["admin"] })
    );
    assert_eq!(seen[4].org.as_deref(), Some(ORG));
}

#[tokio::test(flavor = "multi_thread")]
async fn members_and_pending_invitations_split_on_email_verification() {
    let (identity, _) = mock(|method, path, _| match (method, path) {
        ("POST", "/management/v1/users/grants/_search") => (
            StatusCode::OK,
            json!({ "result": [
                { "id": "g-1", "userId": "501", "roleKeys": ["admin"], "userType": "TYPE_HUMAN",
                  "email": "bob@acme.test", "firstName": "Bob", "lastName": "B",
                  "details": { "creationDate": "2026-10-29T10:18:57.5Z" } },
                { "id": "g-2", "userId": "502", "roleKeys": ["member"], "userType": "TYPE_HUMAN",
                  "email": "cat@acme.test", "details": {} },
                { "id": "g-3", "userId": "503", "roleKeys": ["member"], "userType": "TYPE_MACHINE",
                  "preferredLoginName": "bot", "details": {} },
            ] }),
        ),
        ("POST", "/v2/users") => (
            StatusCode::OK,
            json!({ "result": [
                { "userId": "501", "human": { "email": { "email": "bob@acme.test", "isVerified": true },
                  "profile": { "avatarUrl": "https://img/bob" } } },
                { "userId": "502", "human": { "email": { "email": "cat@acme.test" } } },
            ] }),
        ),
        _ => (StatusCode::NOT_FOUND, json!({})),
    })
    .await;

    let members = identity
        .memberships(ORG, ListPage::default())
        .await
        .expect("members");
    assert_eq!(members.total_count, Some(2));
    assert_eq!(members.data[0].user.user_id, "501");
    assert_eq!(members.data[0].role, "org:admin");
    assert_eq!(members.data[0].user.identifier, "bob@acme.test");
    assert_eq!(
        members.data[0].user.image_url.as_deref(),
        Some("https://img/bob")
    );
    assert_eq!(members.data[0].created_at, Some(1_793_269_137_500));
    assert_eq!(members.data[1].user.identifier, "bot");

    let pending = identity
        .invitations(ORG, Some("pending"), ListPage::limit(10))
        .await
        .expect("pending");
    assert_eq!(pending.data.len(), 1);
    assert_eq!(pending.data[0].id, "502:g-2");
    assert_eq!(pending.data[0].email_address, "cat@acme.test");
    assert_eq!(pending.data[0].status, "pending");
    let revoked = identity
        .invitations(ORG, Some("revoked"), ListPage::default())
        .await
        .expect("revoked");
    assert_eq!(revoked.data.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn roles_change_and_members_leave_by_user_id() {
    let (identity, seen) = mock(|method, path, body| match (method, path) {
        ("POST", "/management/v1/users/grants/_search") => {
            let user = body["queries"][1]["userIdQuery"]["userId"]
                .as_str()
                .unwrap_or("");
            if user == "501" {
                (
                    StatusCode::OK,
                    json!({ "result": [{ "id": "g-1", "userId": "501", "roleKeys": ["member"] }] }),
                )
            } else {
                (StatusCode::OK, json!({ "details": {} }))
            }
        }
        ("PUT" | "DELETE", "/management/v1/users/501/grants/g-1") => (StatusCode::OK, json!({})),
        _ => (StatusCode::NOT_FOUND, json!({})),
    })
    .await;

    identity
        .set_membership_role(ORG, "501", "org:admin")
        .await
        .expect("role");
    identity
        .remove_membership(ORG, "501")
        .await
        .expect("removed");
    let error = identity
        .remove_membership(ORG, "999")
        .await
        .expect_err("not a member");
    assert!(error.is_not_found());
    let seen = seen.lock().expect("lock").clone();
    assert_eq!(seen[1].method, "PUT");
    assert_eq!(seen[1].body, json!({ "roleKeys": ["admin"] }));
    assert_eq!(seen[3].method, "DELETE");
}

#[tokio::test(flavor = "multi_thread")]
async fn organizations_keep_slug_and_cap_in_metadata() {
    let (identity, seen) = mock(|method, path, _| match (method, path) {
        ("GET", "/management/v1/orgs/me") => (
            StatusCode::OK,
            json!({ "org": { "id": ORG, "name": "Acme", "state": "ORG_STATE_ACTIVE" } }),
        ),
        ("POST", "/management/v1/metadata/_search") => (
            StatusCode::OK,
            json!({ "result": [
                { "key": "weldsuite.slug", "value": "YWNtZQ==" },
                { "key": "weldsuite.max_memberships", "value": "MTA=" },
            ] }),
        ),
        ("PUT", "/management/v1/orgs/me")
        | ("POST", "/management/v1/metadata/weldsuite.slug")
        | ("DELETE", "/management/v1/metadata/weldsuite.max_memberships") => {
            (StatusCode::OK, json!({}))
        }
        _ => (StatusCode::NOT_FOUND, json!({})),
    })
    .await;

    let organization = identity.organization(ORG).await.expect("org");
    assert_eq!(organization.name, "Acme");
    assert_eq!(organization.slug.as_deref(), Some("acme"));
    assert_eq!(organization.max_memberships, Some(10));

    identity
        .update_organization(
            ORG,
            &OrganizationChanges {
                name: Some("Acme Inc".to_owned()),
                slug: Some("acme-inc".to_owned()),
                max_memberships: Some(0),
            },
        )
        .await
        .expect("updated");
    let seen = seen.lock().expect("lock").clone();
    assert_eq!(seen[2].body, json!({ "name": "Acme Inc" }));
    // A rename that Zitadel took drops the stored name (weldsuite.name).
    assert_eq!(
        (seen[3].method.as_str(), seen[3].path.as_str()),
        ("DELETE", "/management/v1/metadata/weldsuite.name")
    );
    assert_eq!(seen[4].body, json!({ "value": "YWNtZS1pbmM=" }));
    assert_eq!(seen[5].method, "DELETE", "a cap of 0 removes it");
    assert!(seen.iter().all(|s| s.org.as_deref() == Some(ORG)));
}

#[tokio::test(flavor = "multi_thread")]
async fn errors_keep_the_status_and_a_missing_org_is_a_404() {
    let (identity, _) = mock(|_, _, _| {
        (
            StatusCode::FORBIDDEN,
            json!({ "code": 7, "message": "Organisation doesn't exist (AUTH-Bs7Ds)",
                    "details": [{ "id": "AUTH-Bs7Ds" }] }),
        )
    })
    .await;
    let error = identity.organization("1").await.expect_err("missing");
    assert!(error.is_not_found());
    assert_eq!(error.code(), Some("AUTH-Bs7Ds"));

    let unreachable = ZitadelIdentity::new(ZitadelOptions {
        api_url: "http://127.0.0.1:1".to_owned(),
        token: "pat-test".to_owned(),
        project_id: PROJECT.to_owned(),
        invite_url_template: None,
        application_name: "WeldSuite".to_owned(),
        host: None,
    })
    .expect("client");
    assert!(matches!(
        unreachable.delete_user("1").await,
        Err(IdentityError::Unavailable(_))
    ));
}

// ── against a real Zitadel ───────────────────────────────────────────────────

struct Live {
    base: String,
    token: String,
    project: String,
    identity: ZitadelIdentity,
}

fn live() -> Option<Live> {
    let base = std::env::var("WELDSUITE_TEST_ZITADEL_URL").ok()?;
    let token = std::env::var("WELDSUITE_TEST_ZITADEL_TOKEN").ok()?;
    let project = std::env::var("WELDSUITE_TEST_ZITADEL_PROJECT_ID").ok()?;
    let identity = ZitadelIdentity::new(ZitadelOptions {
        api_url: base.clone(),
        token: token.clone(),
        project_id: project.clone(),
        invite_url_template: None,
        application_name: "WeldSuite".to_owned(),
        host: None,
    })
    .expect("client");
    Some(Live {
        base,
        token,
        project,
        identity,
    })
}

impl Live {
    /// A raw call for the test's own setup.
    async fn raw(&self, path: &str, body: Value) -> Value {
        let response = reqwest::Client::new()
            .post(format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("call");
        let status = response.status();
        let text = response.text().await.expect("body");
        assert!(status.is_success(), "{path}: {status} {text}");
        serde_json::from_str(&text).unwrap_or(Value::Null)
    }

    /// A new organization with the project granted to it, as workspace
    /// provisioning will make one.
    async fn workspace(&self, name: &str) -> String {
        let org = self.raw("/v2/organizations", json!({ "name": name })).await;
        let org = org["organizationId"].as_str().expect("org id").to_owned();
        self.raw(
            &format!("/management/v1/projects/{}/grants", self.project),
            json!({ "grantedOrgId": org, "roleKeys": ["admin", "member"] }),
        )
        .await;
        org
    }
}

/// Zitadel's read side catches up asynchronously: retry until `f` answers.
async fn eventually<T>(mut f: impl AsyncFnMut() -> Option<T>) -> T {
    for _ in 0..50 {
        if let Some(value) = f().await {
            return value;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    panic!("Zitadel never showed the change");
}

#[tokio::test(flavor = "multi_thread")]
async fn live_zitadel_organization_metadata_and_deletion() {
    let Some(live) = live() else {
        eprintln!("WELDSUITE_TEST_ZITADEL_* not set; skipping");
        return;
    };
    let identity = &live.identity;
    let org = live
        .workspace(&format!("Live org {}", std::process::id()))
        .await;
    identity
        .update_organization(
            &org,
            &OrganizationChanges {
                name: Some(format!("Live org {} renamed", std::process::id())),
                slug: Some("live".to_owned()),
                max_memberships: Some(5),
            },
        )
        .await
        .expect("metadata");
    let organization = identity.organization(&org).await.expect("org");
    assert!(organization.name.ends_with("renamed"));
    assert_eq!(organization.slug.as_deref(), Some("live"));
    assert_eq!(organization.max_memberships, Some(5));

    identity.delete_organization(&org).await.expect("deleted");
    let error = eventually(async || identity.organization(&org).await.err()).await;
    assert!(error.is_not_found(), "{error}");
}

#[tokio::test(flavor = "multi_thread")]
async fn live_zitadel_invite_member_role_and_revoke() {
    let Some(live) = live() else {
        eprintln!("WELDSUITE_TEST_ZITADEL_* not set; skipping");
        return;
    };
    let identity = &live.identity;
    let suffix = std::process::id();
    let org = live.workspace(&format!("Live test {suffix}")).await;

    let email = format!("invitee-{suffix}@example.test");
    let invitation = identity
        .invite(
            &org,
            &NewInvitation {
                email_address: email.clone(),
                role: "org:member".to_owned(),
                ..NewInvitation::default()
            },
        )
        .await
        .expect("invite");
    assert_eq!(invitation.status, "pending");
    let read = identity
        .invitation(&org, &invitation.id)
        .await
        .expect("read");
    assert_eq!(
        (read.email_address.as_str(), read.role.as_str()),
        (email.as_str(), "org:member")
    );
    let pending = eventually(async || {
        let list = identity
            .invitations(&org, Some("pending"), ListPage::default())
            .await
            .ok()?;
        (list.data.len() == 1).then_some(list)
    })
    .await;
    assert_eq!(pending.data[0].id, invitation.id);
    let user_id = invitation.id.split(':').next().expect("user").to_owned();
    let found = identity
        .users_by_email(&email.to_uppercase(), 5)
        .await
        .expect("by email");
    assert_eq!(found.first().map(|u| u.id.as_str()), Some(user_id.as_str()));

    // The same person in a second workspace, with another role.
    let other = live.workspace(&format!("Live test {suffix} b")).await;
    identity
        .add_membership(
            &other,
            &NewMembership {
                user_id: user_id.clone(),
                role: "org:admin".to_owned(),
                public_metadata: None,
            },
        )
        .await
        .expect("membership");
    let orgs = eventually(async || {
        let list = identity.user_memberships(&user_id, 10).await.ok()?;
        (list.len() == 2).then_some(list)
    })
    .await;
    assert!(orgs.iter().any(|m| m.role == "org:admin"
        && m.organization.as_ref().map(|o| o.id.as_str()) == Some(other.as_str())));
    eventually(async || {
        identity
            .set_membership_role(&other, &user_id, "org:member")
            .await
            .ok()
    })
    .await;
    identity
        .remove_membership(&other, &user_id)
        .await
        .expect("removed");

    // Revoking deletes the grant and the never-signed-in user it created.
    identity
        .revoke_invitation(&org, &invitation.id)
        .await
        .expect("revoked");
    eventually(async || {
        identity
            .users_by_email(&email, 5)
            .await
            .ok()
            .filter(Vec::is_empty)
    })
    .await;
    identity.delete_organization(&other).await.expect("deleted");
    identity.delete_organization(&org).await.expect("deleted");
}

/// Onboarding's calls: a new workspace's organization (with the project
/// grant, metadata and its creator as an admin), a name another
/// organization has, the user's name and metadata, and the change feed the
/// identity sync polls.
#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::too_many_lines)] // one scenario, in order
async fn live_zitadel_onboarding_and_the_change_feed() {
    let Some(live) = live() else {
        eprintln!("WELDSUITE_TEST_ZITADEL_* not set; skipping");
        return;
    };
    let identity = &live.identity;
    let suffix = std::process::id();
    let since = jiff::Timestamp::now().to_string();

    // The creator: a signed-up (verified) person.
    let email = format!("founder-{suffix}@example.test");
    let created = live
        .raw(
            "/v2/users/human",
            json!({
                "username": email,
                "profile": { "givenName": "Ana", "familyName": "Silva" },
                "email": { "email": email, "isVerified": true },
            }),
        )
        .await;
    let user = created["userId"].as_str().expect("user id").to_owned();

    let name = format!("Onboarded {suffix}");
    let new = NewOrganization {
        name: name.clone(),
        slug: Some(format!("onboarded-{suffix}")),
        created_by: Some(user.clone()),
        public_metadata: Some(json!({ "selectedApps": ["crm"], "region": null })),
        private_metadata: Some(json!({ "partnerOwnerInvite": { "email": "o@example.test" } })),
    };
    let org = identity.create_organization(&new).await.expect("created");
    assert_eq!(org.name, name);
    let read = identity.organization(&org.id).await.expect("read");
    assert_eq!(read.name, name);
    assert_eq!(
        read.slug.as_deref(),
        Some(format!("onboarded-{suffix}").as_str())
    );
    assert_eq!(read.public_metadata, json!({ "selectedApps": ["crm"] }));
    assert_eq!(
        read.private_metadata,
        json!({ "partnerOwnerInvite": { "email": "o@example.test" } })
    );
    let members = eventually(async || {
        let list = identity
            .memberships(&org.id, ListPage::default())
            .await
            .ok()?;
        (list.data.len() == 1).then_some(list)
    })
    .await;
    assert_eq!(members.data[0].user.user_id, user);
    assert_eq!(members.data[0].role, "org:admin");

    // Merging metadata: a key replaced, one removed, the rest kept.
    identity
        .update_organization_metadata(
            &org.id,
            Some(&json!({ "country": "NL", "selectedApps": null })),
            Some(&json!({ "partnerOwnerInvite": null })),
        )
        .await
        .expect("org metadata");
    let read = identity.organization(&org.id).await.expect("read");
    assert_eq!(read.public_metadata, json!({ "country": "NL" }));
    assert_eq!(read.private_metadata, Value::Null);

    // Zitadel's names are unique per instance: the second keeps its own name
    // in metadata and shows Zitadel `Name (slug)`.
    let twin = identity
        .create_organization(&NewOrganization {
            name: name.clone(),
            slug: Some(format!("twin-{suffix}")),
            ..NewOrganization::default()
        })
        .await
        .expect("twin");
    assert_ne!(twin.id, org.id);
    assert_eq!(
        identity.organization(&twin.id).await.expect("twin").name,
        name
    );

    // The user's name and metadata.
    identity
        .update_user(
            &user,
            &UserChanges {
                first_name: Some("Ana Maria".to_owned()),
                last_name: Some(String::new()),
            },
        )
        .await
        .expect("name");
    identity
        .update_user_metadata(&user, &json!({ "primaryRole": "cto", "phone": "+31" }))
        .await
        .expect("metadata");
    identity
        .update_user_metadata(&user, &json!({ "phone": null, "productUpdates": false }))
        .await
        .expect("metadata merge");
    let profile = identity.user_profile(&user).await.expect("profile");
    assert_eq!(profile.first_name.as_deref(), Some("Ana Maria"));
    // An empty name is left as it was (Zitadel needs one).
    assert_eq!(profile.last_name.as_deref(), Some("Silva"));
    assert_eq!(profile.primary_email(), Some(email.as_str()));

    // The change feed names the organization, the user and the membership.
    let changes = eventually(async || {
        let changes = identity.changes_since(Some(&since), 1000).await.ok()?;
        changes
            .iter()
            .any(|c| {
                matches!(&c.change, IdentityChange::Membership { org: o, user_id: u }
                    if *o == org.id && *u == user)
            })
            .then_some(changes)
    })
    .await;
    assert!(changes.iter().any(|c| c.change
        == IdentityChange::Organization {
            org: org.id.clone(),
            removed: false
        }));
    assert!(changes.iter().any(|c| c.change
        == IdentityChange::User {
            user_id: user.clone(),
            removed: false
        }));
    assert!(changes.windows(2).all(|pair| pair[0].at <= pair[1].at));
    // `since` is inclusive: the newest change is seen again from its own time.
    let last = changes.last().expect("a change").clone();
    let again = identity
        .changes_since(Some(&last.at), 1000)
        .await
        .expect("again");
    assert!(again.contains(&last));

    identity
        .delete_organization(&twin.id)
        .await
        .expect("deleted");
    identity
        .delete_organization(&org.id)
        .await
        .expect("deleted");
    identity.delete_user(&user).await.expect("user deleted");
    let removed = eventually(async || {
        let changes = identity.changes_since(Some(&last.at), 1000).await.ok()?;
        changes.into_iter().find(|c| {
            c.change
                == IdentityChange::User {
                    user_id: user.clone(),
                    removed: true,
                }
        })
    })
    .await;
    assert!(removed.at >= last.at);
}
