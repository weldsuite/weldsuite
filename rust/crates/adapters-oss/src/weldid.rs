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
//! | `invitations`, `invitation`, `invite`, `revoke_invitation`, `find_invitation` | WeldSuite's master `workspace_invitations`: one pending invitation per address and workspace, open [`INVITATION_DAYS`] days. `invite` emails it in WeldSuite's template (the platform's `/invite` with `invitation_id`) |
//! | `accept_invitation` | the invitee's address at WeldID's admin API (`GET /admin/v1/users/{id}`): it must be verified (`emailVerified`) and the invited one; then `user_workspaces` gets the membership in the statement that marks the invitation accepted |
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
use std::sync::Arc;
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, Instant};

use aws_lc_rs::rand::{SecureRandom, SystemRandom};
use aws_lc_rs::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD as BASE64URL};
use reqwest::Method;
use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait,
    FromQueryResult, JoinType, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Select,
};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use unicode_normalization::UnicodeNormalization;
use weldsuite_db::{OrmConn, PgPool, is_unique_violation, orm, orm_error, utc_now};
use weldsuite_ports::{
    BoxFuture, FeedEvent, FeedPage, Identity, IdentityError, IdentityResult, Invitation,
    InvitationEmail, InvitationMailer, ListPage, Listing, MemberUser, Membership, NewInvitation,
    NewMembership, NewOrganization, Organization, OrganizationChanges, OrganizationRef, Session,
    User, UserChanges, UserProfile, merge_metadata,
};

use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, users, workspace_invitations, workspaces};

use crate::zitadel::person_name;
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

/// How long an invitation stays open. Resending makes a new one.
pub const INVITATION_DAYS: i32 = 14;

/// The refusal codes of [`Identity::accept_invitation`].
pub const INVITATION_EXPIRED: &str = "invitation_expired";
pub const INVITATION_EMAIL_MISMATCH: &str = "invitation_email_mismatch";
pub const INVITATION_EMAIL_UNVERIFIED: &str = "invitation_email_unverified";

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
    /// Sends the invitation email in WeldSuite's template. `None`: the
    /// invitation is kept, and nobody is emailed.
    pub invitation_mailer: Option<Arc<dyn InvitationMailer>>,
}

impl fmt::Debug for WeldIdOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WeldIdOptions")
            .field("issuer", &self.issuer)
            .field("admin_url", &self.admin_url)
            .field("client_id", &self.client_id)
            .field("token_endpoint", &self.token_endpoint)
            .field("invitation_mailer", &self.invitation_mailer.is_some())
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
    mailer: Option<Arc<dyn InvitationMailer>>,
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

fn database(error: &DbErr) -> IdentityError {
    IdentityError::Unavailable(format!("master database: {error}"))
}

fn refused(status: u16, code: &str, message: &str) -> IdentityError {
    IdentityError::Rejected {
        status,
        code: Some(code.to_owned()),
        message: Some(message.to_owned()),
        body: None,
    }
}

/// An address as WeldID compares them: NFKC, then lowercase, trimmed.
fn normalize_email(email: &str) -> String {
    email.trim().nfkc().collect::<String>().to_lowercase()
}

/// `inv_` and 26 Crockford base32 characters of 128 random bits: the
/// invitation's id and the token in its link.
fn invitation_id() -> IdentityResult<String> {
    const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
    let mut bytes = [0_u8; 17];
    SystemRandom::new()
        .fill(&mut bytes[..16])
        .map_err(|_| IdentityError::Unavailable("no randomness for an invitation id".into()))?;
    // 26 groups of 5 bits from the 128 (the last group is zero-padded).
    let mut id = String::from("inv_");
    for group in 0..26 {
        let bit = group * 5;
        let pair = (u16::from(bytes[bit / 8]) << 8) | u16::from(bytes[bit / 8 + 1]);
        let index = (pair >> (11 - bit % 8)) & 0x1f;
        id.push(char::from(ALPHABET[usize::from(index)]));
    }
    Ok(id)
}

/// The address of a WeldID user when WeldID verified it (`emailVerified`,
/// set only by a code check on that address).
fn verified_email(user: &Value) -> Option<&str> {
    let verified = ["emailVerified", "email_verified"]
        .iter()
        .find_map(|name| user.get(*name).and_then(Value::as_bool))
        .unwrap_or(false);
    verified.then(|| field(user, &["email"])).flatten()
}

/// The invitation link: the platform's `/invite` (`redirect_url`) with the
/// invitation, the invited address and the workspace's name added.
fn accept_link(redirect_url: &str, id: &str, email: &str, workspace_name: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(redirect_url).ok()?;
    url.query_pairs_mut()
        .append_pair("invitation_id", id)
        .append_pair("email", email)
        .append_pair("org_name", workspace_name);
    Some(url.into())
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

/// `(extract(epoch from <column>) * 1000)::bigint`: milliseconds since the
/// epoch of a moment Postgres holds to the microsecond, rounded half away
/// from zero as Postgres casts `numeric` to `bigint`.
fn epoch_ms(at: OffsetDateTime) -> i64 {
    let micros = at.unix_timestamp() * 1_000_000 + i64::from(at.microsecond());
    if micros >= 0 {
        (micros + 500) / 1000
    } else {
        (micros - 500) / 1000
    }
}

/// The same for a `timestamp` column, whose epoch is taken as UTC.
fn timestamp_epoch_ms(at: PrimitiveDateTime) -> i64 {
    epoch_ms(at.assume_utc())
}

/// `coalesce(w.clerk_org_id, w.id)`: the organization id the session layer
/// knows a workspace by.
fn organization_id() -> Expr {
    Func::coalesce([
        Expr::col((workspaces::Entity, workspaces::Column::ClerkOrgId)),
        Expr::col((workspaces::Entity, workspaces::Column::Id)),
    ])
    .into()
}

/// A workspace as the organization calls see it.
#[derive(FromQueryResult)]
struct WorkspaceRow {
    id: String,
    org: String,
    name: String,
    slug: Option<String>,
}

/// A membership with its user and workspace.
#[derive(FromQueryResult)]
struct MemberRow {
    id: String,
    role: String,
    created_at: PrimitiveDateTime,
    user_id: String,
    email: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    image_url: Option<String>,
    org: String,
    org_name: String,
    org_slug: Option<String>,
}

/// Active memberships (`user_workspaces`) with their workspace and, when
/// WeldSuite has it, their user, oldest first.
fn active_members() -> Select<user_workspaces::Entity> {
    use user_workspaces::Column;
    user_workspaces::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Role, Column::CreatedAt, Column::UserId])
        .column_as(users::Column::Email, "email")
        .column_as(users::Column::FirstName, "first_name")
        .column_as(users::Column::LastName, "last_name")
        .column_as(users::Column::ImageUrl, "image_url")
        .column_as(organization_id(), "org")
        .column_as(workspaces::Column::Name, "org_name")
        .column_as(workspaces::Column::Slug, "org_slug")
        .join(
            JoinType::InnerJoin,
            user_workspaces::Entity::belongs_to(workspaces::Entity)
                .from(Column::WorkspaceId)
                .to(workspaces::Column::Id)
                .into(),
        )
        .join(
            JoinType::LeftJoin,
            user_workspaces::Entity::belongs_to(users::Entity)
                .from(Column::UserId)
                .to(users::Column::Id)
                .into(),
        )
        .filter(Column::Status.eq(MembershipStatus::ACTIVE))
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
}

impl MemberRow {
    fn into_membership(self, with_organization: bool) -> Membership {
        Membership {
            id: self.id,
            role: self.role,
            created_at: Some(timestamp_epoch_ms(self.created_at)),
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
            mailer: options.invitation_mailer,
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
        use sea_orm::ExprTrait as _;
        use workspaces::Column;
        let mut query = workspaces::Entity::find()
            .select_only()
            .column(Column::Id)
            .column_as(organization_id(), "org")
            .columns([Column::Name, Column::Slug])
            .filter(
                Condition::any()
                    .add(Column::Id.eq(org))
                    .add(Column::ClerkOrgId.eq(org)),
            );
        if !deleted {
            query = query.filter(Column::DeletedAt.is_null());
        }
        // The workspace whose id it is before one whose organization id it is.
        query
            .order_by_desc(Expr::col((workspaces::Entity, Column::Id)).eq(org))
            .into_model()
            .one(&orm(&self.master))
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
        user_workspaces::Entity::delete_many()
            .filter(user_workspaces::Column::WorkspaceId.eq(workspace.id.as_str()))
            .exec(&orm(&self.master))
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
        use user_workspaces::Column;
        let workspace = self.live_workspace(org).await?;
        let db = orm(&self.master);
        let rows: Vec<MemberRow> = active_members()
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .limit(page.limit.map(u64::from))
            .offset(u64::from(page.offset.unwrap_or(0)))
            .into_model()
            .all(&db)
            .await
            .map_err(|error| database(&error))?;
        let total = user_workspaces::Entity::find()
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(Column::Status.eq(MembershipStatus::ACTIVE))
            .count(&db)
            .await
            .map_err(|error| database(&error))?;
        Ok(Listing {
            data: rows
                .into_iter()
                .map(|row| row.into_membership(false))
                .collect(),
            total_count: Some(total),
        })
    }

    async fn user_memberships_inner(
        &self,
        user_id: &str,
        limit: u32,
    ) -> IdentityResult<Vec<Membership>> {
        let rows: Vec<MemberRow> = active_members()
            .filter(user_workspaces::Column::UserId.eq(user_id))
            .filter(workspaces::Column::DeletedAt.is_null())
            .limit(u64::from(limit))
            .into_model()
            .all(&orm(&self.master))
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
        let db = orm(&self.master);
        let known: Option<String> = users::Entity::find_by_id(user_id.to_owned())
            .select_only()
            .column(users::Column::Id)
            .into_tuple()
            .one(&db)
            .await
            .map_err(|error| database(&error))?;
        if known.is_some() {
            return Ok(());
        }
        let profile = self.user_profile_inner(user_id).await?;
        users::Entity::insert(users::ActiveModel {
            id: Set(user_id.to_owned()),
            email: Set(profile.primary_email().unwrap_or_default().to_owned()),
            first_name: Set(profile.first_name.clone()),
            last_name: Set(profile.last_name.clone()),
            image_url: Set(profile.image_url.clone()),
            ..Default::default()
        })
        .on_conflict(OnConflict::column(users::Column::Id).do_nothing().to_owned())
        .exec_without_returning(&db)
        .await
        .map_err(|error| database(&error))
        .map(drop)
    }

    async fn add_membership_inner(
        &self,
        org: &str,
        membership: &NewMembership,
    ) -> IdentityResult<Membership> {
        use user_workspaces::Column;
        let workspace = self.live_workspace(org).await?;
        let status: Option<MembershipStatus> = user_workspaces::Entity::find()
            .select_only()
            .column(Column::Status)
            .filter(Column::UserId.eq(membership.user_id.as_str()))
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .into_tuple()
            .one(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        if status == Some(MembershipStatus::ACTIVE) {
            return Err(IdentityError::Rejected {
                status: 400,
                code: Some("already_a_member_in_organization".to_owned()),
                message: None,
                body: None,
            });
        }
        self.ensure_user_row(&membership.user_id).await?;
        let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
        let current = |column: Column| Expr::col((user_workspaces::Entity, column));
        let rejoin = OnConflict::columns([Column::UserId, Column::WorkspaceId])
            .update_column(Column::Role)
            .value(
                Column::Status,
                Column::Status.save_as(Expr::value(MembershipStatus::ACTIVE)),
            )
            .value(
                Column::JoinedAt,
                Func::coalesce([current(Column::JoinedAt), excluded(Column::JoinedAt)]),
            )
            .value(Column::UpdatedAt, Expr::current_timestamp())
            .to_owned();
        let id = user_workspaces::Entity::insert(user_workspaces::ActiveModel {
            id: Set(weldsuite_kit::generate_id("uw")),
            user_id: Set(membership.user_id.clone()),
            workspace_id: Set(workspace.id.clone()),
            role: Set(membership.role.clone()),
            status: Set(MembershipStatus::ACTIVE),
            joined_at: Set(Some(utc_now())),
            ..Default::default()
        })
        .on_conflict(rejoin)
        .exec_with_returning(&orm(&self.master))
        .await
        .map_err(|error| database(&error))?
        .id;
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
        use user_workspaces::Column;
        let workspace = self.live_workspace(org).await?;
        let changed = user_workspaces::Entity::update_many()
            .col_expr(Column::Role, Expr::value(role))
            .col_expr(Column::UpdatedAt, Expr::current_timestamp())
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(Column::UserId.eq(user_id))
            .filter(Column::Status.eq(MembershipStatus::ACTIVE))
            .exec(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        if changed.rows_affected == 0 {
            return Err(not_found());
        }
        Ok(())
    }

    async fn remove_membership_inner(&self, org: &str, user_id: &str) -> IdentityResult<()> {
        use user_workspaces::Column;
        let workspace = self.live_workspace(org).await?;
        let removed = user_workspaces::Entity::delete_many()
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(Column::UserId.eq(user_id))
            .exec(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        if removed.rows_affected == 0 {
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
            let taken: Option<String> = workspaces::Entity::find()
                .select_only()
                .column(workspaces::Column::Id)
                .filter(workspaces::Column::Slug.eq(slug.as_str()))
                .into_tuple()
                .one(&orm(&self.master))
                .await
                .map_err(|error| database(&error))?;
            if taken.is_some() {
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

    // ── WeldSuite's own invitations (master `workspace_invitations`) ────

    async fn invitations_inner(
        &self,
        org: &str,
        status: Option<&str>,
        page: ListPage,
    ) -> IdentityResult<Listing<Invitation>> {
        use sea_orm::ExprTrait as _;
        use workspace_invitations::Column;
        let workspace = self.live_workspace(org).await?;
        let mut filter = Condition::all().add(Column::WorkspaceId.eq(workspace.id.as_str()));
        if let Some(status) = status {
            filter = filter.add(invitation_status().eq(status));
        }
        let db = orm(&self.master);
        let rows: Vec<InvitationRow> = invitation_rows()
            .filter(filter.clone())
            .order_by_desc(Column::CreatedAt)
            .order_by_asc(Column::Id)
            .limit(page.limit.map(u64::from))
            .offset(u64::from(page.offset.unwrap_or(0)))
            .into_model()
            .all(&db)
            .await
            .map_err(|error| database(&error))?;
        let total = workspace_invitations::Entity::find()
            .filter(filter)
            .count(&db)
            .await
            .map_err(|error| database(&error))?;
        Ok(Listing {
            data: rows
                .into_iter()
                .map(InvitationRow::into_invitation)
                .collect(),
            total_count: Some(total),
        })
    }

    async fn invitation_inner(&self, org: &str, invitation_id: &str) -> IdentityResult<Invitation> {
        use workspace_invitations::Column;
        let workspace = self.live_workspace(org).await?;
        let row: Option<InvitationRow> = invitation_rows()
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(Column::Id.eq(invitation_id))
            .into_model()
            .one(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        row.map(InvitationRow::into_invitation)
            .ok_or_else(not_found)
    }

    /// Records the invitation, then emails it. An expired invitation to the
    /// same address is revoked first, so it doesn't block a new one; a
    /// pending one is a `duplicate_record` refusal (the route's conflict).
    async fn invite_inner(
        &self,
        org: &str,
        invitation: &NewInvitation,
    ) -> IdentityResult<Invitation> {
        let workspace = self.live_workspace(org).await?;
        let email = invitation.email_address.trim();
        if email.is_empty() {
            return Err(refused(
                422,
                "form_param_missing",
                "An email address is required.",
            ));
        }
        let normalized = normalize_email(email);
        let id = invitation_id()?;
        let mut tx = self
            .master
            .begin()
            .await
            .map_err(|error| database(&orm_error(error)))?;
        let inserted = {
            let db = OrmConn::new(&mut tx);
            revoke_expired(&db, &workspace.id, &normalized)
                .await
                .map_err(|error| database(&error))?;
            let new = NewInvitationRow {
                id: &id,
                workspace_id: &workspace.id,
                email,
                normalized: &normalized,
                invitation,
            };
            insert_invitation(&db, &new).await
        };
        let row = match inserted {
            Ok(row) => row,
            Err(error) if is_unique_violation(&error) => {
                return Err(refused(
                    422,
                    "duplicate_record",
                    "An invitation for this email address is already pending.",
                ));
            }
            Err(error) => return Err(database(&error)),
        };
        tx.commit()
            .await
            .map_err(|error| database(&orm_error(error)))?;
        self.send_invitation_email(&workspace, invitation, &row)
            .await;
        Ok(row.into_invitation())
    }

    /// WeldSuite's invitation email; a failure is logged, the invitation
    /// stays (resending sends it again).
    async fn send_invitation_email(
        &self,
        workspace: &WorkspaceRow,
        invitation: &NewInvitation,
        row: &InvitationRow,
    ) {
        let Some(mailer) = &self.mailer else {
            tracing::warn!("weldid: no invitation mailer, the invitation is not emailed");
            return;
        };
        let Some(accept_url) = invitation
            .redirect_url
            .as_deref()
            .and_then(|url| accept_link(url, &row.id, &row.email, &workspace.name))
        else {
            tracing::error!(
                "weldid: no invitation link (redirect_url), the invitation is not emailed"
            );
            return;
        };
        let (inviter_name, inviter_email) = self.inviter(invitation).await;
        let message = InvitationEmail {
            to: row.email.clone(),
            inviter_name,
            inviter_email,
            workspace_name: Some(workspace.name.clone()).filter(|name| !name.is_empty()),
            role: row.role.clone(),
            accept_url,
        };
        if let Err(error) = mailer.send(&message).await {
            tracing::error!(%error, "weldid: invitation email not sent");
        }
    }

    /// The inviter's name and address for the email, from WeldSuite's
    /// `users` (a name in `invitedByName` metadata before the address).
    async fn inviter(&self, invitation: &NewInvitation) -> (Option<String>, Option<String>) {
        let named = invitation
            .public_metadata
            .as_ref()
            .and_then(|metadata| metadata.get("invitedByName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned);
        let Some(user_id) = invitation
            .invited_by
            .as_deref()
            .or(invitation.inviter_user_id.as_deref())
        else {
            return (named, None);
        };
        let found: Result<Option<Inviter>, DbErr> = users::Entity::find_by_id(user_id.to_owned())
            .select_only()
            .columns([
                users::Column::FirstName,
                users::Column::LastName,
                users::Column::Email,
            ])
            .into_tuple()
            .one(&orm(&self.master))
            .await;
        match found {
            Ok(Some((first, last, email))) => {
                let email = email.filter(|email| !email.is_empty());
                let name = person_name(first.as_deref(), last.as_deref());
                (name.or(named).or_else(|| email.clone()), email)
            }
            Ok(None) => (named, None),
            Err(error) => {
                tracing::warn!(%error, "weldid: inviter not read for the invitation");
                (named, None)
            }
        }
    }

    async fn revoke_invitation_inner(&self, org: &str, invitation_id: &str) -> IdentityResult<()> {
        use workspace_invitations::Column;
        let workspace = self.live_workspace(org).await?;
        let revoked = workspace_invitations::Entity::update_many()
            .col_expr(Column::Status, Expr::value("revoked"))
            .col_expr(Column::RevokedAt, Expr::current_timestamp())
            .filter(Column::WorkspaceId.eq(workspace.id.as_str()))
            .filter(Column::Id.eq(invitation_id))
            .filter(Column::Status.eq("pending"))
            .exec(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        if revoked.rows_affected == 0 {
            return Err(not_found());
        }
        Ok(())
    }

    async fn find_invitation_inner(
        &self,
        invitation_id: &str,
    ) -> IdentityResult<(OrganizationRef, Invitation)> {
        let found: Option<FoundInvitation> = invitation_rows()
            .column_as(organization_id(), "org")
            .column_as(workspaces::Column::Name, "org_name")
            .column_as(workspaces::Column::Slug, "org_slug")
            .join(JoinType::InnerJoin, live_workspace_of_invitation())
            .filter(workspaces::Column::DeletedAt.is_null())
            .filter(workspace_invitations::Column::Id.eq(invitation_id))
            .into_model()
            .one(&orm(&self.master))
            .await
            .map_err(|error| database(&error))?;
        let found = found.ok_or_else(not_found)?;
        Ok((
            OrganizationRef {
                id: found.org,
                name: found.org_name,
                slug: found.org_slug.unwrap_or_default(),
            },
            found.invitation.into_invitation(),
        ))
    }

    /// Membership mode's acceptance: the invitation must be pending and
    /// unexpired, its workspace live, and `user_id`'s address at WeldID
    /// verified and the invited one. The membership is made in the same
    /// statement that marks the invitation accepted, so two acceptances
    /// can't both win. An active member keeps their role.
    async fn accept_invitation_inner(
        &self,
        invitation_id: &str,
        user_id: &str,
    ) -> IdentityResult<Membership> {
        let state = self
            .invitation_state(invitation_id)
            .await
            .map_err(|error| database(&error))?;
        let Some((status, expired, invited, workspace_id)) = state else {
            return Err(not_found());
        };
        if status != "pending" {
            return Err(not_found());
        }
        if expired {
            return Err(refused(
                410,
                INVITATION_EXPIRED,
                "This invitation has expired.",
            ));
        }
        let user = self.user_inner(user_id).await?;
        let profile = profile_of(&user, user_id).ok_or_else(not_found)?;
        let Some(email) = verified_email(&user) else {
            return Err(refused(
                403,
                INVITATION_EMAIL_UNVERIFIED,
                "Verify your email address before accepting the invitation.",
            ));
        };
        if normalize_email(email) != invited {
            return Err(refused(
                403,
                INVITATION_EMAIL_MISMATCH,
                "This invitation is for another email address.",
            ));
        }
        self.ensure_user_row(user_id).await?;
        let joined = self
            .claim_invitation(invitation_id, user_id)
            .await
            .map_err(|error| database(&error))?;
        // Accepted, revoked or expired in the meantime.
        let (id, role, created_at) = joined.ok_or_else(not_found)?;
        let workspace = self.live_workspace(&workspace_id).await?;
        tracing::info!(workspace_id, "weldid: an invitation was accepted");
        Ok(Membership {
            id,
            role,
            created_at,
            public_metadata: Value::Null,
            user: MemberUser {
                user_id: user_id.to_owned(),
                first_name: profile.first_name,
                last_name: profile.last_name,
                identifier: email.to_owned(),
                image_url: profile.image_url,
            },
            organization: Some(OrganizationRef {
                id: workspace.org,
                name: workspace.name,
                slug: workspace.slug.unwrap_or_default(),
            }),
        })
    }

    /// The invitation's status, whether it has expired (`expires_at <= now()`),
    /// its address and its workspace, when the workspace is live.
    async fn invitation_state(
        &self,
        invitation_id: &str,
    ) -> Result<Option<(String, bool, String, String)>, DbErr> {
        use sea_orm::ExprTrait as _;
        use workspace_invitations::Column;
        workspace_invitations::Entity::find()
            .select_only()
            .column(Column::Status)
            .column_as(
                Expr::col((workspace_invitations::Entity, Column::ExpiresAt))
                    .lte(Expr::current_timestamp()),
                "expired",
            )
            .columns([Column::EmailNormalized, Column::WorkspaceId])
            .join(JoinType::InnerJoin, live_workspace_of_invitation())
            .filter(workspaces::Column::DeletedAt.is_null())
            .filter(Column::Id.eq(invitation_id))
            .into_tuple()
            .one(&orm(&self.master))
            .await
    }

    /// Marks the invitation accepted and makes (or reactivates) the membership
    /// from it, in one statement: `None` when it was no longer pending and
    /// unexpired. An active member keeps their role.
    #[allow(
        clippy::disallowed_methods,
        reason = "a claim: the invitation is marked accepted and the membership written \
                  in one statement, so two acceptances can't both win"
    )]
    async fn claim_invitation(
        &self,
        invitation_id: &str,
        user_id: &str,
    ) -> Result<Option<(String, String, Option<i64>)>, DbErr> {
        sqlx::query_as(
            "with accepted as (
               update workspace_invitations
                  set status = 'accepted', accepted_by = $2, accepted_at = now()
                where id = $1 and status = 'pending' and expires_at > now()
               returning workspace_id, role, invited_by, created_at
             )
             insert into user_workspaces
                  (id, user_id, workspace_id, role, status, invited_by, invited_at, joined_at)
             select $3, $2, a.workspace_id, a.role, 'ACTIVE'::membership_status,
                    a.invited_by, a.created_at, now()
               from accepted a
             on conflict (user_id, workspace_id) do update
                set role = case when user_workspaces.status = 'ACTIVE'
                                then user_workspaces.role else excluded.role end,
                    status = 'ACTIVE',
                    invited_by = coalesce(user_workspaces.invited_by, excluded.invited_by),
                    invited_at = coalesce(user_workspaces.invited_at, excluded.invited_at),
                    joined_at = coalesce(user_workspaces.joined_at, excluded.joined_at),
                    updated_at = now()
             returning id, role, (extract(epoch from created_at) * 1000)::bigint",
        )
        .bind(invitation_id)
        .bind(user_id)
        .bind(weldsuite_kit::generate_id("uw"))
        .fetch_optional(&self.master)
        .await
        .map_err(orm_error)
    }
}

/// Expired invitations to the address in the workspace, still `pending`,
/// become `revoked`, so they don't block a new one.
async fn revoke_expired(
    db: &OrmConn<'_>,
    workspace_id: &str,
    normalized: &str,
) -> Result<(), DbErr> {
    use sea_orm::ExprTrait as _;
    use workspace_invitations::Column;
    workspace_invitations::Entity::update_many()
        .col_expr(Column::Status, Expr::value("revoked"))
        .col_expr(Column::RevokedAt, Expr::current_timestamp())
        .filter(Column::WorkspaceId.eq(workspace_id))
        .filter(Column::EmailNormalized.eq(normalized))
        .filter(Column::Status.eq("pending"))
        .filter(
            Expr::col((workspace_invitations::Entity, Column::ExpiresAt))
                .lte(Expr::current_timestamp()),
        )
        .exec(db)
        .await
        .map(drop)
}

/// What [`insert_invitation`] writes.
struct NewInvitationRow<'a> {
    id: &'a str,
    workspace_id: &'a str,
    email: &'a str,
    normalized: &'a str,
    invitation: &'a NewInvitation,
}

/// The new invitation, `pending`, open [`INVITATION_DAYS`] days from the
/// database's `now()`; `invited_by` only when WeldSuite knows that user.
async fn insert_invitation(
    db: &OrmConn<'_>,
    new: &NewInvitationRow<'_>,
) -> Result<InvitationRow, DbErr> {
    use sea_orm::ExprTrait as _;
    use workspace_invitations::Column;
    let inviter = new
        .invitation
        .invited_by
        .as_deref()
        .or(new.invitation.inviter_user_id.as_deref());
    // `(select id from users where id = $7)`.
    let known_inviter = Query::select()
        .column(users::Column::Id)
        .from(users::Entity)
        .and_where(users::Column::Id.eq(inviter.map(str::to_owned)))
        .to_owned();
    // `now() + make_interval(days => $8)`.
    let expires_at = Expr::current_timestamp().add(Func::cust("make_interval").args([
        Expr::val(0),
        Expr::val(0),
        Expr::val(0),
        Expr::val(INVITATION_DAYS),
    ]));
    let mut insert = Query::insert();
    insert
        .into_table(workspace_invitations::Entity)
        .columns([
            Column::Id,
            Column::WorkspaceId,
            Column::Email,
            Column::EmailNormalized,
            Column::Role,
            Column::PublicMetadata,
            Column::InvitedBy,
            Column::ExpiresAt,
        ])
        .values([
            Expr::val(new.id),
            Expr::val(new.workspace_id),
            Expr::val(new.email),
            Expr::val(new.normalized),
            Expr::val(new.invitation.role.as_str()),
            Expr::val(
                new.invitation
                    .public_metadata
                    .clone()
                    .unwrap_or_else(|| json!({})),
            ),
            known_inviter.into(),
            expires_at,
        ])
        .map_err(|error| DbErr::Custom(error.to_string()))?
        .returning_all();
    let row = db
        .query_one(&insert)
        .await?
        .ok_or(DbErr::RecordNotInserted)?;
    // A new invitation is `pending` and open for days, so its status reads
    // as stored (the list's `expired` doesn't apply yet).
    InvitationRow::from_query_result(&row, "")
}

/// An inviter's first name, last name and address in `users`.
type Inviter = (Option<String>, Option<String>, Option<String>);

/// `pending` reads as `expired` once its time is up; never stored so.
fn invitation_status() -> Expr {
    use sea_orm::ExprTrait as _;
    use workspace_invitations::Column;
    let column = |column: Column| Expr::col((workspace_invitations::Entity, column));
    Expr::case(
        column(Column::Status)
            .eq("pending")
            .and(column(Column::ExpiresAt).lte(Expr::current_timestamp())),
        Expr::val("expired"),
    )
    .finally(column(Column::Status))
    .into()
}

/// The `workspace_invitations` columns [`InvitationRow`] reads, the status as
/// [`invitation_status`] says.
fn invitation_rows() -> Select<workspace_invitations::Entity> {
    use workspace_invitations::Column;
    workspace_invitations::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Email, Column::Role])
        .column_as(invitation_status(), "status")
        .columns([Column::PublicMetadata, Column::CreatedAt, Column::ExpiresAt])
}

/// `join workspaces w on w.id = i.workspace_id` (the callers add
/// `w.deleted_at is null`).
fn live_workspace_of_invitation() -> sea_orm::RelationDef {
    workspace_invitations::Entity::belongs_to(workspaces::Entity)
        .from(workspace_invitations::Column::WorkspaceId)
        .to(workspaces::Column::Id)
        .into()
}

/// An invitation and its workspace, for [`Identity::find_invitation`].
#[derive(FromQueryResult)]
struct FoundInvitation {
    #[sea_orm(nested)]
    invitation: InvitationRow,
    org: String,
    org_name: String,
    org_slug: Option<String>,
}

/// A `workspace_invitations` row as the port's calls see it.
#[derive(FromQueryResult)]
struct InvitationRow {
    id: String,
    email: String,
    role: String,
    status: String,
    public_metadata: Value,
    created_at: OffsetDateTime,
    expires_at: OffsetDateTime,
}

impl InvitationRow {
    fn into_invitation(self) -> Invitation {
        Invitation {
            id: self.id,
            email_address: self.email,
            role: self.role,
            status: self.status,
            public_metadata: self.public_metadata,
            created_at: Some(epoch_ms(self.created_at)),
            expires_at: Some(epoch_ms(self.expires_at)),
        }
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
        org: &'a str,
        status: Option<&'a str>,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        Box::pin(self.invitations_inner(org, status, page))
    }

    fn invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(self.invitation_inner(org, invitation_id))
    }

    fn invite<'a>(
        &'a self,
        org: &'a str,
        invitation: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(self.invite_inner(org, invitation))
    }

    fn revoke_invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.revoke_invitation_inner(org, invitation_id))
    }

    fn find_invitation<'a>(
        &'a self,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Option<(OrganizationRef, Invitation)>>> {
        Box::pin(async move { self.find_invitation_inner(invitation_id).await.map(Some) })
    }

    fn accept_invitation<'a>(
        &'a self,
        invitation_id: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Option<Membership>>> {
        Box::pin(async move {
            self.accept_invitation_inner(invitation_id, user_id)
                .await
                .map(Some)
        })
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

    #[test]
    fn invitation_ids_carry_128_random_bits() {
        let ids: std::collections::HashSet<String> =
            (0..1000).map(|_| invitation_id().expect("id")).collect();
        assert_eq!(ids.len(), 1000);
        for id in &ids {
            let token = id.strip_prefix("inv_").expect("prefix");
            assert_eq!(token.len(), 26, "{id}");
            assert!(
                token
                    .bytes()
                    .all(|b| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&b)),
                "{id}"
            );
        }
        // Every one of the 26 characters varies (the last holds 3 bits).
        for position in 0..26 {
            let seen: std::collections::HashSet<u8> =
                ids.iter().map(|id| id.as_bytes()[4 + position]).collect();
            assert!(seen.len() > 4, "position {position}: {seen:?}");
        }
    }

    #[test]
    fn addresses_compare_as_weldid_compares_them() {
        assert_eq!(normalize_email("  Ann@Acme.TEST "), "ann@acme.test");
        // NFKC: full-width letters are the ASCII ones.
        assert_eq!(normalize_email("ＡＮＮ@acme.test"), "ann@acme.test");
    }

    #[test]
    fn only_a_verified_address_counts() {
        assert_eq!(
            verified_email(&json!({ "email": "a@b.test", "emailVerified": true })),
            Some("a@b.test")
        );
        assert_eq!(
            verified_email(&json!({ "email": "a@b.test", "email_verified": true })),
            Some("a@b.test")
        );
        for user in [
            json!({ "email": "a@b.test", "emailVerified": false }),
            json!({ "email": "a@b.test" }),
            json!({ "email": "a@b.test", "emailVerified": "true" }),
            json!({ "emailVerified": true }),
        ] {
            assert_eq!(verified_email(&user), None, "{user}");
        }
    }

    #[test]
    fn the_link_keeps_the_platforms_query_and_adds_the_invitation() {
        assert_eq!(
            accept_link(
                "https://app.example.test/invite?org_id=org_1",
                "inv_x",
                "a+b@acme.test",
                "Acme & Co"
            )
            .as_deref(),
            Some(
                "https://app.example.test/invite?org_id=org_1&invitation_id=inv_x&email=a%2Bb%40acme.test&org_name=Acme+%26+Co"
            )
        );
        assert_eq!(accept_link("not a url", "inv_x", "a@b.test", "A"), None);
    }
}

#[cfg(test)]
mod sql_preview_tmp {
    use super::*;
    use sea_orm::{DbBackend, QueryTrait};

    #[test]
    fn preview() {
        use sea_orm::ExprTrait as _;
        let pg = DbBackend::Postgres;
        {
            use workspaces::Column;
            let org = "org_1";
            let query = workspaces::Entity::find()
                .select_only()
                .column(Column::Id)
                .column_as(organization_id(), "org")
                .columns([Column::Name, Column::Slug])
                .filter(
                    Condition::any()
                        .add(Column::Id.eq(org))
                        .add(Column::ClerkOrgId.eq(org)),
                )
                .filter(Column::DeletedAt.is_null())
                .order_by_desc(Expr::col((workspaces::Entity, Column::Id)).eq(org))
                .limit(1);
            println!("WORKSPACE: {}\n", query.build(pg));
        }
        let q = active_members()
            .filter(user_workspaces::Column::WorkspaceId.eq("ws"))
            .limit(Some(5u64))
            .offset(0u64);
        println!("MEMBERS: {}\n", q.build(pg));
        let q = active_members()
            .filter(user_workspaces::Column::WorkspaceId.eq("ws"))
            .limit(None::<u64>)
            .offset(3u64);
        println!("MEMBERS nolimit: {}\n", q.build(pg));
        let q = user_workspaces::Entity::find()
            .select_only()
            .column(user_workspaces::Column::Status)
            .filter(user_workspaces::Column::UserId.eq("u"));
        println!("STATUS: {}\n", q.build(pg));
        {
            use user_workspaces::Column;
            let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
            let current = |column: Column| Expr::col((user_workspaces::Entity, column));
            let rejoin = OnConflict::columns([Column::UserId, Column::WorkspaceId])
                .update_column(Column::Role)
                .value(
                    Column::Status,
                    Column::Status.save_as(Expr::value(MembershipStatus::ACTIVE)),
                )
                .value(
                    Column::JoinedAt,
                    Func::coalesce([current(Column::JoinedAt), excluded(Column::JoinedAt)]),
                )
                .value(Column::UpdatedAt, Expr::current_timestamp())
                .to_owned();
            let ins = user_workspaces::Entity::insert(user_workspaces::ActiveModel {
                id: Set("uw_1".to_owned()),
                user_id: Set("u".to_owned()),
                workspace_id: Set("w".to_owned()),
                role: Set("org:member".to_owned()),
                status: Set(MembershipStatus::ACTIVE),
                joined_at: Set(Some(utc_now())),
                ..Default::default()
            })
            .on_conflict(rejoin);
            println!("UPSERT: {}\n", ins.build(pg));
            let upd = user_workspaces::Entity::update_many()
                .col_expr(Column::Role, Expr::value("r"))
                .col_expr(Column::UpdatedAt, Expr::current_timestamp())
                .filter(Column::WorkspaceId.eq("w"))
                .filter(Column::Status.eq(MembershipStatus::ACTIVE));
            println!("SETROLE: {}\n", upd.build(pg));
        }
        {
            use workspace_invitations::Column;
            let filter = Condition::all()
                .add(Column::WorkspaceId.eq("w"))
                .add(invitation_status().eq("expired"));
            let q = invitation_rows()
                .filter(filter.clone())
                .order_by_desc(Column::CreatedAt)
                .order_by_asc(Column::Id)
                .limit(Some(5u64))
                .offset(0u64);
            println!("INVITATIONS: {}\n", q.build(pg));
            println!(
                "INVCOUNT: {}\n",
                workspace_invitations::Entity::find().filter(filter).build(pg)
            );
            let q = invitation_rows()
                .column_as(organization_id(), "org")
                .column_as(workspaces::Column::Name, "org_name")
                .column_as(workspaces::Column::Slug, "org_slug")
                .join(JoinType::InnerJoin, live_workspace_of_invitation())
                .filter(workspaces::Column::DeletedAt.is_null())
                .filter(workspace_invitations::Column::Id.eq("inv"));
            println!("FIND: {}\n", q.build(pg));
            let q = workspace_invitations::Entity::find()
                .select_only()
                .column(Column::Status)
                .column_as(
                    Expr::col((workspace_invitations::Entity, Column::ExpiresAt))
                        .lte(Expr::current_timestamp()),
                    "expired",
                )
                .columns([Column::EmailNormalized, Column::WorkspaceId])
                .join(JoinType::InnerJoin, live_workspace_of_invitation())
                .filter(workspaces::Column::DeletedAt.is_null())
                .filter(Column::Id.eq("inv"));
            println!("STATE: {}\n", q.build(pg));
            let upd = workspace_invitations::Entity::update_many()
                .col_expr(Column::Status, Expr::value("revoked"))
                .col_expr(Column::RevokedAt, Expr::current_timestamp())
                .filter(Column::WorkspaceId.eq("w"))
                .filter(Column::Status.eq("pending"))
                .filter(
                    Expr::col((workspace_invitations::Entity, Column::ExpiresAt))
                        .lte(Expr::current_timestamp()),
                );
            println!("REVOKE: {}\n", upd.build(pg));
            let inviter: Option<&str> = None;
            let known_inviter = Query::select()
                .column(users::Column::Id)
                .from(users::Entity)
                .and_where(users::Column::Id.eq(inviter.map(str::to_owned)))
                .to_owned();
            let expires_at = Expr::current_timestamp().add(Func::cust("make_interval").args([
                Expr::val(0),
                Expr::val(0),
                Expr::val(0),
                Expr::val(INVITATION_DAYS),
            ]));
            let mut insert = Query::insert();
            insert
                .into_table(workspace_invitations::Entity)
                .columns([Column::Id, Column::InvitedBy, Column::ExpiresAt, Column::PublicMetadata])
                .values([Expr::val("i"), known_inviter.into(), expires_at, Expr::val(json!({}))])
                .unwrap()
                .returning_all();
            println!("INSERT: {}\n", pg.build(&insert));
        }
        {
            let ins = users::Entity::insert(users::ActiveModel {
                id: Set("u".to_owned()),
                email: Set("e".to_owned()),
                first_name: Set(None),
                last_name: Set(None),
                image_url: Set(None),
                ..Default::default()
            })
            .on_conflict(OnConflict::column(users::Column::Id).do_nothing().to_owned());
            println!("USERINS: {}\n", ins.build(pg));
        }
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(1_500_000).unwrap()) == 2);
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(1_499_000).unwrap()) == 1);
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(-1_500_000).unwrap()) == -2);
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(-1_499_000).unwrap()) == -1);
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(-500_000).unwrap()) == -1);
        assert!(epoch_ms(OffsetDateTime::from_unix_timestamp_nanos(1_700_000_000_123_456_000).unwrap()) == 1_700_000_000_123);
    }
}
