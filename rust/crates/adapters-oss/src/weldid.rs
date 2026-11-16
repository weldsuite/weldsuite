//! WeldID behind the `Identity` port, in membership mode (self-hosted plan
//! E1, `weldsuite-documentation/plans/weldid-auth-server.md`). WeldID only
//! authenticates people: it knows users and their sessions, never
//! workspaces. So the port's calls split in two:
//!
//! | Port call | Served by |
//! |---|---|
//! | `user_profile`, `users_by_email`, `update_user`, `update_user_metadata`, `delete_user` | WeldID's admin API: `GET`/`PATCH`/`DELETE /admin/v1/users/{id}`, `GET /admin/v1/users?email=` |
//! | `sessions`, `session`, `revoke_session` | `GET /admin/v1/users/{id}/sessions`, `GET`/`DELETE /admin/v1/sessions/{id}` |
//! | `events_after` | `GET /admin/v1/events?after=&limit=` (the outbox) |
//! | `organization`, `memberships`, `user_memberships`, `add_membership`, `set_membership_role`, `remove_membership` | WeldSuite's master database: `workspaces`, `user_workspaces`, `users` |
//! | `create_organization` | nothing at the provider: a new organization id (`org_…`) for `workspaces.clerk_org_id`, after checking the slug is free |
//! | `update_organization`, `update_organization_metadata` | nothing: the routes write `workspaces` themselves, the membership cap is WeldSuite's own seat check, and organization metadata isn't kept |
//! | `delete_organization` | the workspace's `user_workspaces` rows (the route marks the workspace deleted; the `workspace-teardown` sweep drops its database) |
//! | `invitations`, `invitation`, `invite`, `revoke_invitation` | [`IdentityError::Unavailable`] until the master table for pending invitations by email exists |
//!
//! An organization reference (`org`) is what the session layer puts in
//! `org_id`: a workspace's `clerk_org_id`, else its `id`; both are accepted.
//!
//! Every admin call carries an access token of WeldID's platform issuer for
//! the `weldsuite-backend` client: `client_credentials`, authenticated with
//! `private_key_jwt` (an ES256 assertion with `iss` = `sub` = the client id,
//! `aud` = the issuer, a fresh `jti`, valid 60 seconds), asking for
//! [`WELDID_ADMIN_SCOPES`]. The token endpoint comes from the issuer's
//! discovery document; the token is reused until shortly before it expires,
//! and fetched again once when an admin call answers 401.
//!
//! WeldID answers only requests addressed to its public host, so when
//! `WELDID_ADMIN_URL` is an in-cluster address every admin call carries the
//! issuer's host as `Host`. Responses follow WeldSuite's shape (`{ data }`,
//! `{ data, pagination: { hasMore, cursor } }`, `{ error: { code, message } }`);
//! fields are read in camelCase, or snake case.

use std::fmt;
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use reqwest::Method;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{
    BoxFuture, FeedEvent, FeedPage, Identity, IdentityError, IdentityResult, Invitation, ListPage,
    Listing, MemberUser, Membership, NewInvitation, NewMembership, NewOrganization, Organization,
    OrganizationChanges, OrganizationRef, Session, User, UserChanges, UserProfile, merge_metadata,
};

use crate::zitadel_api::safe_path;

/// What the backend client asks WeldID's token endpoint for. `weldid:sso`
/// is for the SSO connections ([`crate::WeldIdSso`]); WeldID leaves out a
/// scope the client isn't allowed (`client_credentials` narrows, it doesn't
/// refuse), so a client without it keeps working and only `/api/sso`'s
/// connection calls are refused.
pub const WELDID_ADMIN_SCOPES: &str =
    "weldid:users.read weldid:users.write weldid:sessions weldid:events.read weldid:sso";

/// How long a client assertion is valid.
const ASSERTION_SECONDS: i64 = 60;

/// Why the invitation calls answer [`IdentityError::Unavailable`].
pub const INVITATIONS_UNAVAILABLE: &str = "invitations in membership mode need the master \
     workspace_invitations table (pending invitations by email), which is not migrated yet";

/// How to reach WeldID.
#[derive(Clone)]
pub struct WeldIdOptions {
    /// `OIDC_ISSUER`: the platform issuer. Its discovery document names the
    /// token endpoint; it is the assertion's audience and, for an in-cluster
    /// admin URL, the `Host` of every admin call.
    pub issuer: String,
    /// `WELDID_ADMIN_URL`: where the admin API is reached (in-cluster).
    pub admin_url: String,
    /// `WELDID_CLIENT_ID`: the confidential `private_key_jwt` client.
    pub client_id: String,
    /// `WELDID_CLIENT_KEY`: its ES256 (P-256) private key, PEM (PKCS#8 or
    /// SEC1); `\n` escapes are read as newlines.
    pub client_key: String,
    /// The token endpoint; `None` reads it from the issuer's discovery
    /// document.
    pub token_endpoint: Option<String>,
}

impl fmt::Debug for WeldIdOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WeldIdOptions")
            .field("issuer", &self.issuer)
            .field("admin_url", &self.admin_url)
            .field("client_id", &self.client_id)
            .field("token_endpoint", &self.token_endpoint)
            .finish_non_exhaustive()
    }
}

/// An admin access token and when to fetch the next one.
struct AccessToken {
    value: String,
    renew_at: Instant,
}

/// The `Identity` port on WeldID and WeldSuite's own memberships.
pub struct WeldIdIdentity {
    issuer: String,
    admin_url: String,
    client_id: String,
    key: EcdsaKeyPair,
    /// `Host` for the admin calls, when the admin URL isn't the issuer's host.
    host: Option<String>,
    master: PgPool,
    client: reqwest::Client,
    token_endpoint: RwLock<Option<String>>,
    token: tokio::sync::Mutex<Option<AccessToken>>,
}

impl fmt::Debug for WeldIdIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WeldIdIdentity")
            .field("issuer", &self.issuer)
            .field("admin_url", &self.admin_url)
            .field("client_id", &self.client_id)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

/// The private key inside a PEM document (the `… PRIVATE KEY` block; an
/// `EC PARAMETERS` block before it is skipped).
fn parse_key(pem: &str) -> Result<EcdsaKeyPair, String> {
    let pem = pem.replace("\\n", "\n");
    let mut body = String::new();
    let mut inside = false;
    for line in pem.lines().map(str::trim) {
        if line.starts_with("-----BEGIN") {
            inside = line.contains("PRIVATE KEY");
        } else if line.starts_with("-----END") {
            if inside {
                break;
            }
        } else if inside {
            body.push_str(line);
        }
    }
    let der = BASE64
        .decode(body.as_bytes())
        .map_err(|_| "WELDID_CLIENT_KEY is not a PEM private key".to_owned())?;
    EcdsaKeyPair::from_private_key_der(&ECDSA_P256_SHA256_FIXED_SIGNING, &der)
        .map_err(|_| "WELDID_CLIENT_KEY is not a P-256 (ES256) private key".to_owned())
}

/// `host[:port]` of a URL.
fn authority(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

pub(crate) fn not_found() -> IdentityError {
    IdentityError::Rejected {
        status: 404,
        code: Some("not_found".to_owned()),
        message: None,
        body: None,
    }
}

fn database(error: &sqlx::Error) -> IdentityError {
    IdentityError::Unavailable(format!("master database: {error}"))
}

fn invitations_unavailable() -> IdentityError {
    IdentityError::Unavailable(INVITATIONS_UNAVAILABLE.to_owned())
}

/// A string field under any of `names` (camelCase first, then snake case),
/// non-empty.
pub(crate) fn field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
}

/// A string or number field as text (WeldID's outbox ids are numbers).
fn id_field(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| match value.get(*name) {
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    })
}

/// A user as WeldID's admin API returns it; `None` for a deleted
/// (anonymised) one, which reads as gone.
fn profile_of(user: &Value, fallback_id: &str) -> Option<UserProfile> {
    let deleted = field(user, &["status"]) == Some("deleted")
        || field(user, &["deletedAt", "deleted_at"]).is_some();
    if deleted {
        return None;
    }
    let email = field(user, &["email"]).map(str::to_owned);
    Some(UserProfile {
        id: field(user, &["id"]).unwrap_or(fallback_id).to_owned(),
        // One address per user: the primary one.
        primary_email_address_id: email.as_ref().map(|_| "email".to_owned()),
        email_addresses: email
            .into_iter()
            .map(|address| ("email".to_owned(), address))
            .collect(),
        first_name: field(user, &["givenName", "given_name"]).map(str::to_owned),
        last_name: field(user, &["familyName", "family_name"]).map(str::to_owned),
        image_url: field(user, &["picture", "pictureUrl", "picture_url"]).map(str::to_owned),
    })
}

/// A session as WeldID's admin API returns it; `None` once revoked.
fn session_of(session: &Value, user_id: Option<&str>) -> Option<Session> {
    if field(session, &["revokedAt", "revoked_at"]).is_some() {
        return None;
    }
    let status = field(session, &["status"]).unwrap_or("active");
    if status != "active" {
        return None;
    }
    Some(Session {
        id: field(session, &["id"])?.to_owned(),
        user_id: field(session, &["userId", "user_id"])
            .or(user_id)
            .unwrap_or_default()
            .to_owned(),
        status: status.to_owned(),
    })
}

fn feed_event(event: &Value) -> Option<FeedEvent> {
    Some(FeedEvent {
        id: id_field(event, &["id"])?,
        kind: field(event, &["kind"])?.to_owned(),
        user_id: field(event, &["userId", "user_id"]).map(str::to_owned),
        at: field(event, &["at"]).map(str::to_owned),
        data: event.get("data").cloned().unwrap_or(Value::Null),
    })
}

/// The `data` array of a list answer.
pub(crate) fn list(body: &Value) -> &[Value] {
    body.get("data")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// A workspace as the organization calls see it.
#[derive(sqlx::FromRow)]
struct WorkspaceRow {
    id: String,
    org: String,
    name: String,
    slug: Option<String>,
}

/// A membership with its user and workspace.
#[derive(sqlx::FromRow)]
struct MemberRow {
    id: String,
    role: String,
    created_ms: Option<i64>,
    user_id: String,
    email: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    image_url: Option<String>,
    org: String,
    org_name: String,
    org_slug: Option<String>,
}

const MEMBER_COLUMNS: &str = "uw.id, uw.role,
       (extract(epoch from uw.created_at) * 1000)::bigint as created_ms,
       uw.user_id, u.email, u.first_name, u.last_name, u.image_url,
       coalesce(w.clerk_org_id, w.id) as org, w.name as org_name, w.slug as org_slug
  from user_workspaces uw
  join workspaces w on w.id = uw.workspace_id
  left join users u on u.id = uw.user_id";

impl MemberRow {
    fn into_membership(self, with_organization: bool) -> Membership {
        Membership {
            id: self.id,
            role: self.role,
            created_at: self.created_ms,
            // Not kept: a guest is marked in the tenant database.
            public_metadata: Value::Null,
            user: MemberUser {
                user_id: self.user_id,
                first_name: self.first_name,
                last_name: self.last_name,
                identifier: self.email.unwrap_or_default(),
                image_url: self.image_url,
            },
            organization: with_organization.then(|| OrganizationRef {
                id: self.org,
                name: self.org_name,
                slug: self.org_slug.unwrap_or_default(),
            }),
        }
    }
}

impl WeldIdIdentity {
    /// Checks the key; connects nothing until the first call.
    pub fn new(options: WeldIdOptions, master: PgPool) -> Result<Self, IdentityError> {
        let key = parse_key(&options.client_key).map_err(IdentityError::Unavailable)?;
        let issuer = options.issuer.trim_end_matches('/').to_owned();
        let admin_url = options.admin_url.trim_end_matches('/').to_owned();
        let issuer_host = authority(&issuer);
        let host = issuer_host.filter(|host| authority(&admin_url).as_ref() != Some(host));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| IdentityError::Unavailable(error.to_string()))?;
        Ok(Self {
            issuer,
            admin_url,
            client_id: options.client_id,
            key,
            host,
            master,
            client,
            token_endpoint: RwLock::new(options.token_endpoint),
            token: tokio::sync::Mutex::new(None),
        })
    }

    // ── the admin token ─────────────────────────────────────────────────

    async fn token_endpoint(&self) -> IdentityResult<String> {
        if let Some(endpoint) = self
            .token_endpoint
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            return Ok(endpoint);
        }
        let url = format!("{}/.well-known/openid-configuration", self.issuer);
        let response = self
            .client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(unreachable)?;
        let status = response.status().as_u16();
        let document: Value = response
            .text()
            .await
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let endpoint = document
            .get("token_endpoint")
            .and_then(Value::as_str)
            .filter(|_| status < 300)
            .ok_or_else(|| {
                IdentityError::Unavailable(format!(
                    "WeldID's discovery document names no token endpoint ({status})"
                ))
            })?
            .to_owned();
        *self
            .token_endpoint
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// The `private_key_jwt` client assertion.
    fn client_assertion(&self) -> IdentityResult<String> {
        let rng = SystemRandom::new();
        let mut jti = [0_u8; 16];
        rng.fill(&mut jti)
            .map_err(|_| IdentityError::Unavailable("no randomness for the assertion".into()))?;
        let now = jiff::Timestamp::now().as_second();
        let header = BASE64URL.encode(json!({ "alg": "ES256", "typ": "JWT" }).to_string());
        let claims = BASE64URL.encode(
            json!({
                "iss": self.client_id,
                "sub": self.client_id,
                "aud": self.issuer,
                "jti": hex::encode(jti),
                "iat": now,
                "exp": now + ASSERTION_SECONDS,
            })
            .to_string(),
        );
        let input = format!("{header}.{claims}");
        let signature = self.key.sign(&rng, input.as_bytes()).map_err(|_| {
            IdentityError::Unavailable("signing the client assertion failed".into())
        })?;
        Ok(format!("{input}.{}", BASE64URL.encode(signature.as_ref())))
    }

    async fn fetch_token(&self) -> IdentityResult<AccessToken> {
        let endpoint = self.token_endpoint().await?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "client_credentials")
            .append_pair("client_id", &self.client_id)
            .append_pair("scope", WELDID_ADMIN_SCOPES)
            .append_pair(
                "client_assertion_type",
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            )
            .append_pair("client_assertion", &self.client_assertion()?)
            .finish();
        let response = self
            .client
            .post(&endpoint)
            .header("content-type", "application/x-www-form-urlencoded")
            .header("accept", "application/json")
            .body(form)
            .send()
            .await
            .map_err(unreachable)?;
        let status = response.status().as_u16();
        let body: Value = response
            .text()
            .await
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        let value = body
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|token| status < 300 && !token.is_empty());
        let Some(value) = value else {
            // Never the body: an error description may echo the request.
            let error = field(&body, &["error"]).unwrap_or("no access token");
            return Err(IdentityError::Unavailable(format!(
                "WeldID refused the admin token ({status}, {error})"
            )));
        };
        let lifetime = body
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(300);
        let margin = (lifetime / 5).min(60);
        Ok(AccessToken {
            value: value.to_owned(),
            renew_at: Instant::now() + Duration::from_secs(lifetime.saturating_sub(margin)),
        })
    }

    /// The cached token, or a new one when it is due or `fresh` asks.
    async fn access_token(&self, fresh: bool) -> IdentityResult<String> {
        let mut slot = self.token.lock().await;
        if !fresh
            && let Some(token) = slot.as_ref()
            && Instant::now() < token.renew_at
        {
            return Ok(token.value.clone());
        }
        let token = self.fetch_token().await?;
        let value = token.value.clone();
        *slot = Some(token);
        Ok(value)
    }

    // ── the admin API ───────────────────────────────────────────────────

    /// `method path?query` on the admin API; a 401 fetches a new token once.
    pub(crate) async fn admin(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> IdentityResult<Value> {
        // Caller ids land in the path, and the request carries the admin
        // token: only plain segments, never `..` or an encoded `/`.
        if !safe_path(path) {
            return Err(not_found());
        }
        let address = format!("{}{path}", self.admin_url);
        let url = if query.is_empty() {
            reqwest::Url::parse(&address)
        } else {
            reqwest::Url::parse_with_params(&address, query)
        }
        .map_err(|error| IdentityError::Unavailable(format!("WeldID admin address: {error}")))?;
        let mut fresh = false;
        loop {
            let token = self.access_token(fresh).await?;
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .bearer_auth(&token)
                .header("accept", "application/json");
            if let Some(host) = &self.host {
                request = request.header("host", host);
            }
            if let Some(body) = body {
                request = request
                    .header("content-type", "application/json")
                    .body(body.to_string());
            }
            let response = request.send().await.map_err(unreachable)?;
            let status = response.status().as_u16();
            let text = response.text().await.map_err(unreachable)?;
            if status == 401 && !fresh {
                fresh = true;
                continue;
            }
            let answer: Value = if text.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()))
            };
            if status < 400 {
                return Ok(answer);
            }
            let error = answer.get("error").unwrap_or(&Value::Null);
            return Err(IdentityError::Rejected {
                status,
                code: field(error, &["code"]).map(str::to_owned),
                message: field(error, &["message"]).map(str::to_owned),
                body: Some(text),
            });
        }
    }

    async fn user_inner(&self, user_id: &str) -> IdentityResult<Value> {
        let found = self
            .admin(
                Method::GET,
                &format!("/admin/v1/users/{user_id}"),
                &[],
                None,
            )
            .await?;
        Ok(found.get("data").cloned().unwrap_or(Value::Null))
    }

    async fn user_profile_inner(&self, user_id: &str) -> IdentityResult<UserProfile> {
        let user = self.user_inner(user_id).await?;
        profile_of(&user, user_id).ok_or_else(not_found)
    }

    async fn users_by_email_inner(&self, email: &str, limit: u32) -> IdentityResult<Vec<User>> {
        let found = self
            .admin(Method::GET, "/admin/v1/users", &[("email", email)], None)
            .await?;
        Ok(list(&found)
            .iter()
            .filter_map(|user| profile_of(user, ""))
            .filter(|profile| !profile.id.is_empty())
            .take(limit as usize)
            .map(|profile| User { id: profile.id })
            .collect())
    }

    async fn update_user_inner(&self, user_id: &str, changes: &UserChanges) -> IdentityResult<()> {
        let mut body = serde_json::Map::new();
        if let Some(given) = &changes.first_name {
            body.insert("givenName".to_owned(), json!(given));
        }
        if let Some(family) = &changes.last_name {
            body.insert("familyName".to_owned(), json!(family));
        }
        if body.is_empty() {
            return Ok(());
        }
        self.admin(
            Method::PATCH,
            &format!("/admin/v1/users/{user_id}"),
            &[],
            Some(&Value::Object(body)),
        )
        .await
        .map(drop)
    }

    /// Clerk's merge, done here: the user's metadata is read, merged and
    /// written back whole.
    async fn update_user_metadata_inner(&self, user_id: &str, patch: &Value) -> IdentityResult<()> {
        let user = self.user_inner(user_id).await?;
        if profile_of(&user, user_id).is_none() {
            return Err(not_found());
        }
        let current = user.get("metadata").cloned().unwrap_or(Value::Null);
        let merged = merge_metadata(&current, patch);
        self.admin(
            Method::PATCH,
            &format!("/admin/v1/users/{user_id}"),
            &[],
            Some(&json!({ "metadata": merged })),
        )
        .await
        .map(drop)
    }

    async fn delete_user_inner(&self, user_id: &str) -> IdentityResult<()> {
        self.admin(
            Method::DELETE,
            &format!("/admin/v1/users/{user_id}"),
            &[],
            None,
        )
        .await
        .map(drop)
    }

    async fn sessions_inner(&self, user_id: &str) -> IdentityResult<Vec<Session>> {
        let found = self
            .admin(
                Method::GET,
                &format!("/admin/v1/users/{user_id}/sessions"),
                &[],
                None,
            )
            .await?;
        Ok(list(&found)
            .iter()
            .filter_map(|session| session_of(session, Some(user_id)))
            .take(100)
            .collect())
    }

    async fn session_inner(&self, session_id: &str) -> IdentityResult<Session> {
        let found = self
            .admin(
                Method::GET,
                &format!("/admin/v1/sessions/{session_id}"),
                &[],
                None,
            )
            .await?;
        found
            .get("data")
            .and_then(|session| session_of(session, None))
            .ok_or_else(not_found)
    }

    async fn revoke_session_inner(&self, session_id: &str) -> IdentityResult<()> {
        self.admin(
            Method::DELETE,
            &format!("/admin/v1/sessions/{session_id}"),
            &[],
            None,
        )
        .await
        .map(drop)
    }

    async fn events_after_inner(
        &self,
        after: Option<&str>,
        limit: u32,
    ) -> IdentityResult<FeedPage> {
        let limit = limit.to_string();
        let mut query = vec![("limit", limit.as_str())];
        if let Some(after) = after {
            query.insert(0, ("after", after));
        }
        let found = self
            .admin(Method::GET, "/admin/v1/events", &query, None)
            .await?;
        let pagination = found.get("pagination").unwrap_or(&Value::Null);
        Ok(FeedPage {
            events: list(&found).iter().filter_map(feed_event).collect(),
            cursor: id_field(pagination, &["cursor"]),
            has_more: pagination
                .get("hasMore")
                .or_else(|| pagination.get("has_more"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    // ── WeldSuite's own workspaces and memberships ──────────────────────

    /// The workspace `org` names (its organization id or its id); a deleted
    /// one only when `deleted` asks.
    async fn workspace(&self, org: &str, deleted: bool) -> IdentityResult<Option<WorkspaceRow>> {
        sqlx::query_as(
            "select id, coalesce(clerk_org_id, id) as org, name, slug from workspaces
              where (id = $1 or clerk_org_id = $1) and ($2 or deleted_at is null)
              order by (id = $1) desc
              limit 1",
        )
        .bind(org)
        .bind(deleted)
        .fetch_optional(&self.master)
        .await
        .map_err(|error| database(&error))
    }

    async fn live_workspace(&self, org: &str) -> IdentityResult<WorkspaceRow> {
        self.workspace(org, false).await?.ok_or_else(not_found)
    }

    async fn organization_inner(&self, org: &str) -> IdentityResult<Organization> {
        let workspace = self.live_workspace(org).await?;
        Ok(Organization {
            id: workspace.org,
            name: workspace.name,
            slug: workspace.slug,
            // The seat limit is WeldSuite's own check, not a provider cap.
            max_memberships: None,
            public_metadata: Value::Null,
            private_metadata: Value::Null,
        })
    }

    async fn update_organization_inner(&self, org: &str) -> IdentityResult<()> {
        // The routes wrote `workspaces` already; nothing is kept elsewhere.
        self.live_workspace(org).await.map(drop)
    }

    async fn delete_organization_inner(&self, org: &str) -> IdentityResult<()> {
        let workspace = self.workspace(org, true).await?.ok_or_else(not_found)?;
        sqlx::query("delete from user_workspaces where workspace_id = $1")
            .bind(&workspace.id)
            .execute(&self.master)
            .await
            .map_err(|error| database(&error))?;
        tracing::info!(
            workspace_id = workspace.id,
            "weldid: the workspace's memberships are removed"
        );
        Ok(())
    }

    async fn memberships_inner(
        &self,
        org: &str,
        page: ListPage,
    ) -> IdentityResult<Listing<Membership>> {
        let workspace = self.live_workspace(org).await?;
        let rows: Vec<MemberRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {MEMBER_COLUMNS}
              where uw.workspace_id = $1 and uw.status = 'ACTIVE'
              order by uw.created_at, uw.id
              limit $2 offset $3"
        )))
        .bind(&workspace.id)
        .bind(page.limit.map(i64::from))
        .bind(i64::from(page.offset.unwrap_or(0)))
        .fetch_all(&self.master)
        .await
        .map_err(|error| database(&error))?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from user_workspaces where workspace_id = $1 and status = 'ACTIVE'",
        )
        .bind(&workspace.id)
        .fetch_one(&self.master)
        .await
        .map_err(|error| database(&error))?;
        Ok(Listing {
            data: rows
                .into_iter()
                .map(|row| row.into_membership(false))
                .collect(),
            total_count: u64::try_from(total).ok(),
        })
    }

    async fn user_memberships_inner(
        &self,
        user_id: &str,
        limit: u32,
    ) -> IdentityResult<Vec<Membership>> {
        let rows: Vec<MemberRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "select {MEMBER_COLUMNS}
              where uw.user_id = $1 and uw.status = 'ACTIVE' and w.deleted_at is null
              order by uw.created_at, uw.id
              limit $2"
        )))
        .bind(user_id)
        .bind(i64::from(limit))
        .fetch_all(&self.master)
        .await
        .map_err(|error| database(&error))?;
        Ok(rows
            .into_iter()
            .map(|row| row.into_membership(true))
            .collect())
    }

    /// The master `users` row a membership hangs from, from WeldID's profile
    /// when the user never signed in to WeldSuite yet.
    async fn ensure_user_row(&self, user_id: &str) -> IdentityResult<()> {
        let known: bool = sqlx::query_scalar("select exists (select 1 from users where id = $1)")
            .bind(user_id)
            .fetch_one(&self.master)
            .await
            .map_err(|error| database(&error))?;
        if known {
            return Ok(());
        }
        let profile = self.user_profile_inner(user_id).await?;
        sqlx::query(
            "insert into users (id, email, first_name, last_name, image_url)
             values ($1, $2, $3, $4, $5)
             on conflict (id) do nothing",
        )
        .bind(user_id)
        .bind(profile.primary_email().unwrap_or_default())
        .bind(&profile.first_name)
        .bind(&profile.last_name)
        .bind(&profile.image_url)
        .execute(&self.master)
        .await
        .map_err(|error| database(&error))
        .map(drop)
    }

    async fn add_membership_inner(
        &self,
        org: &str,
        membership: &NewMembership,
    ) -> IdentityResult<Membership> {
        let workspace = self.live_workspace(org).await?;
        let status: Option<String> = sqlx::query_scalar(
            "select status::text from user_workspaces where user_id = $1 and workspace_id = $2",
        )
        .bind(&membership.user_id)
        .bind(&workspace.id)
        .fetch_optional(&self.master)
        .await
        .map_err(|error| database(&error))?;
        if status.as_deref() == Some("ACTIVE") {
            return Err(IdentityError::Rejected {
                status: 400,
                code: Some("already_a_member_in_organization".to_owned()),
                message: None,
                body: None,
            });
        }
        self.ensure_user_row(&membership.user_id).await?;
        let id: String = sqlx::query_scalar(
            "insert into user_workspaces (id, user_id, workspace_id, role, status, joined_at)
             values ($1, $2, $3, $4, 'ACTIVE', now())
             on conflict (user_id, workspace_id) do update
                set role = excluded.role, status = 'ACTIVE',
                    joined_at = coalesce(user_workspaces.joined_at, excluded.joined_at),
                    updated_at = now()
             returning id",
        )
        .bind(weldsuite_kit::generate_id("uw"))
        .bind(&membership.user_id)
        .bind(&workspace.id)
        .bind(&membership.role)
        .fetch_one(&self.master)
        .await
        .map_err(|error| database(&error))?;
        Ok(Membership {
            id,
            role: membership.role.clone(),
            created_at: None,
            public_metadata: membership.public_metadata.clone().unwrap_or(Value::Null),
            user: MemberUser {
                user_id: membership.user_id.clone(),
                ..MemberUser::default()
            },
            organization: None,
        })
    }

    async fn set_membership_role_inner(
        &self,
        org: &str,
        user_id: &str,
        role: &str,
    ) -> IdentityResult<()> {
        let workspace = self.live_workspace(org).await?;
        let changed = sqlx::query(
            "update user_workspaces set role = $3, updated_at = now()
              where workspace_id = $1 and user_id = $2 and status = 'ACTIVE'",
        )
        .bind(&workspace.id)
        .bind(user_id)
        .bind(role)
        .execute(&self.master)
        .await
        .map_err(|error| database(&error))?;
        if changed.rows_affected() == 0 {
            return Err(not_found());
        }
        Ok(())
    }

    async fn remove_membership_inner(&self, org: &str, user_id: &str) -> IdentityResult<()> {
        let workspace = self.live_workspace(org).await?;
        let removed =
            sqlx::query("delete from user_workspaces where workspace_id = $1 and user_id = $2")
                .bind(&workspace.id)
                .bind(user_id)
                .execute(&self.master)
                .await
                .map_err(|error| database(&error))?;
        if removed.rows_affected() == 0 {
            return Err(not_found());
        }
        Ok(())
    }

    /// No provider organization: a fresh id for `workspaces.clerk_org_id`,
    /// once the slug (when one is asked for) is free. Onboarding writes the
    /// workspace and its creator's membership itself.
    async fn create_organization_inner(
        &self,
        organization: &NewOrganization,
    ) -> IdentityResult<Organization> {
        if let Some(slug) = &organization.slug {
            let taken: bool =
                sqlx::query_scalar("select exists (select 1 from workspaces where slug = $1)")
                    .bind(slug)
                    .fetch_one(&self.master)
                    .await
                    .map_err(|error| database(&error))?;
            if taken {
                return Err(IdentityError::Rejected {
                    status: 422,
                    code: Some("form_identifier_exists".to_owned()),
                    message: Some("That slug is taken.".to_owned()),
                    body: None,
                });
            }
        }
        Ok(Organization {
            id: weldsuite_kit::generate_id("org"),
            name: organization.name.clone(),
            slug: organization.slug.clone(),
            max_memberships: None,
            public_metadata: organization.public_metadata.clone().unwrap_or(Value::Null),
            private_metadata: organization.private_metadata.clone().unwrap_or(Value::Null),
        })
    }
}

fn unreachable(error: reqwest::Error) -> IdentityError {
    IdentityError::Unavailable(format!("WeldID: {}", error.without_url()))
}

impl Identity for WeldIdIdentity {
    fn organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<Organization>> {
        Box::pin(self.organization_inner(org))
    }

    fn update_organization<'a>(
        &'a self,
        org: &'a str,
        _changes: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.update_organization_inner(org))
    }

    fn delete_organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.delete_organization_inner(org))
    }

    fn memberships<'a>(
        &'a self,
        org: &'a str,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>> {
        Box::pin(self.memberships_inner(org, page))
    }

    fn add_membership<'a>(
        &'a self,
        org: &'a str,
        membership: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>> {
        Box::pin(self.add_membership_inner(org, membership))
    }

    fn set_membership_role<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
        role: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.set_membership_role_inner(org, user_id, role))
    }

    fn remove_membership<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.remove_membership_inner(org, user_id))
    }

    fn invitations<'a>(
        &'a self,
        _org: &'a str,
        _status: Option<&'a str>,
        _page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        Box::pin(async { Err(invitations_unavailable()) })
    }

    fn invitation<'a>(
        &'a self,
        _org: &'a str,
        _invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(async { Err(invitations_unavailable()) })
    }

    fn invite<'a>(
        &'a self,
        _org: &'a str,
        _invitation: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(async { Err(invitations_unavailable()) })
    }

    fn revoke_invitation<'a>(
        &'a self,
        _org: &'a str,
        _invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async { Err(invitations_unavailable()) })
    }

    fn users_by_email<'a>(
        &'a self,
        email: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<User>>> {
        Box::pin(self.users_by_email_inner(email, limit))
    }

    fn user_memberships<'a>(
        &'a self,
        user_id: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<Membership>>> {
        Box::pin(self.user_memberships_inner(user_id, limit))
    }

    fn delete_user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.delete_user_inner(user_id))
    }

    fn sessions<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<Vec<Session>>> {
        Box::pin(self.sessions_inner(user_id))
    }

    fn session<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, IdentityResult<Session>> {
        Box::pin(self.session_inner(session_id))
    }

    fn revoke_session<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.revoke_session_inner(session_id))
    }

    fn user_profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<UserProfile>> {
        Box::pin(self.user_profile_inner(user_id))
    }

    fn update_user<'a>(
        &'a self,
        user_id: &'a str,
        changes: &'a UserChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.update_user_inner(user_id, changes))
    }

    fn update_user_metadata<'a>(
        &'a self,
        user_id: &'a str,
        public_metadata: &'a Value,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.update_user_metadata_inner(user_id, public_metadata))
    }

    fn create_organization<'a>(
        &'a self,
        organization: &'a NewOrganization,
    ) -> BoxFuture<'a, IdentityResult<Organization>> {
        Box::pin(self.create_organization_inner(organization))
    }

    /// Not kept: the onboarding metadata (`selectedApps`, `country`) travels
    /// in the provisioning job instead.
    fn update_organization_metadata<'a>(
        &'a self,
        _org: &'a str,
        _public_metadata: Option<&'a Value>,
        _private_metadata: Option<&'a Value>,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async { Ok(()) })
    }

    fn events_after<'a>(
        &'a self,
        after: Option<&'a str>,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<FeedPage>> {
        Box::pin(self.events_after_inner(after, limit))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn users_read_in_either_case_and_deleted_ones_are_gone() {
        let camel = json!({
            "id": "usr_1", "email": "ann@acme.test", "givenName": "Ann",
            "familyName": "Smit", "picture": "https://img/1", "status": "active",
        });
        let profile = profile_of(&camel, "x").expect("live");
        assert_eq!(profile.id, "usr_1");
        assert_eq!(profile.primary_email(), Some("ann@acme.test"));
        assert_eq!(profile.first_name.as_deref(), Some("Ann"));
        assert_eq!(profile.image_url.as_deref(), Some("https://img/1"));
        let snake = json!({ "email": "b@acme.test", "given_name": "Bo", "family_name": "K" });
        let profile = profile_of(&snake, "usr_2").expect("live");
        assert_eq!(profile.id, "usr_2");
        assert_eq!(profile.last_name.as_deref(), Some("K"));
        assert!(profile_of(&json!({ "id": "usr_3", "status": "deleted" }), "x").is_none());
        assert!(
            profile_of(
                &json!({ "id": "usr_3", "deletedAt": "2026-01-01T00:00:00Z" }),
                "x"
            )
            .is_none()
        );
    }

    #[test]
    fn sessions_and_events_parse() {
        assert_eq!(
            session_of(&json!({ "id": "ses_1" }), Some("usr_1")),
            Some(Session {
                id: "ses_1".to_owned(),
                user_id: "usr_1".to_owned(),
                status: "active".to_owned()
            })
        );
        assert_eq!(
            session_of(
                &json!({ "id": "ses_1", "revokedAt": "2026-01-01T00:00:00Z" }),
                None
            ),
            None
        );
        let event = feed_event(&json!({ "id": 42, "kind": "user.updated", "userId": "usr_1" }))
            .expect("event");
        assert_eq!(event.id, "42");
        assert_eq!(event.user_id.as_deref(), Some("usr_1"));
        assert!(feed_event(&json!({ "kind": "user.updated" })).is_none());
    }

    #[test]
    fn the_admin_host_is_the_issuers_when_they_differ() {
        assert_eq!(
            authority("https://auth.example.com").as_deref(),
            Some("auth.example.com")
        );
        assert_eq!(
            authority("http://weldid.weldid.svc:8080/").as_deref(),
            Some("weldid.weldid.svc:8080")
        );
        assert!(parse_key("not a key").is_err());
    }
}
