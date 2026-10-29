//! Zitadel behind the `Identity` port (ADR SEC-012), for the EU edition and
//! the bundled self-host. Checked against Zitadel v4.19 (the version the Flux
//! setup pins); every call is authenticated with a service user's personal
//! access token.
//!
//! How Clerk's model maps onto Zitadel's:
//!
//! | Clerk | Zitadel |
//! |---|---|
//! | organization (a workspace) | organization; its id is what `workspaces.clerk_org_id` holds on Kubernetes |
//! | slug, membership cap | organization metadata `weldsuite.slug`, `weldsuite.max_memberships` |
//! | membership with a role | an authorization (user grant) on the WeldSuite project in that organization, role key without `org:` (`org:admin` → `admin`) |
//! | invitation | a user grant on a human user who hasn't verified their email yet; the user is created in the organization and Zitadel sends the invite (`invite_code`) |
//! | invitation id | `{userId}:{grantId}` |
//!
//! So `memberships` lists the grants of signed-up users and `invitations`
//! (status `pending`) those of users who haven't accepted yet; an accepted
//! invitation turns into a membership by itself. Revoked and expired
//! invitations aren't kept: a revoked invitation's grant is deleted, with the
//! user when the invitation created it and they never signed in.
//!
//! What Zitadel doesn't have: per-membership metadata (`public_metadata`
//! comes back null and is not stored; a guest is marked in the tenant
//! database), and an email to an existing user added to another organization
//! (the workspace sends its own notification). The membership cap is stored
//! but not enforced by Zitadel; the seat check happens in WeldSuite.
//!
//! APIs used: Management API v1 for organizations, metadata and user grants
//! (`x-zitadel-orgid` selects the organization), User API v2 for users and
//! invite codes, and the Authorization API v2beta for one user's grants
//! across organizations. Zitadel's read side is eventually consistent: a
//! grant may take a moment to show up in a list after it was made.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::Method;
use serde_json::{Value, json};
use weldsuite_ports::{
    BoxFuture, Identity, IdentityError, IdentityResult, Invitation, ListPage, Listing, MemberUser,
    Membership, NewInvitation, NewMembership, Organization, OrganizationChanges, OrganizationRef,
    User,
};

const SLUG_KEY: &str = "weldsuite.slug";
const CAP_KEY: &str = "weldsuite.max_memberships";
const NAME_KEY: &str = "weldsuite.name";
const PUBLIC_METADATA_KEY: &str = "weldsuite.public_metadata";
const PRIVATE_METADATA_KEY: &str = "weldsuite.private_metadata";
/// Grants fetched per list call; a workspace's members fit many times over.
const LIST_LIMIT: u32 = 1000;

/// How to reach Zitadel.
#[derive(Clone)]
pub struct ZitadelOptions {
    /// `ZITADEL_API_URL`: the instance's address (its external domain, or the
    /// in-cluster Service with the external domain as `Host`).
    pub api_url: String,
    /// `ZITADEL_SERVICE_TOKEN`: a personal access token of a service user
    /// with the `ORG_OWNER` manager role on every workspace organization
    /// (simplest: `IAM_OWNER`).
    pub token: String,
    /// `ZITADEL_PROJECT_ID`: the WeldSuite project whose roles are the
    /// membership roles.
    pub project_id: String,
    /// `ZITADEL_INVITE_URL_TEMPLATE`: where the invite email links to, with
    /// Zitadel's `{{.UserID}}`, `{{.Code}}` and `{{.OrgID}}` placeholders.
    /// Unset: Zitadel's own login.
    pub invite_url_template: Option<String>,
    /// The sender name in Zitadel's invite email.
    pub application_name: String,
    /// `Host` header for every call, when `api_url` is an in-cluster address
    /// (Zitadel picks the instance by host).
    pub host: Option<String>,
}

impl std::fmt::Debug for ZitadelOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZitadelOptions")
            .field("api_url", &self.api_url)
            .field("project_id", &self.project_id)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

/// The `Identity` port on Zitadel.
pub struct ZitadelIdentity {
    options: ZitadelOptions,
    client: reqwest::Client,
    /// Organization → its grant of the project (`None`: it owns the project).
    project_grants: Mutex<HashMap<String, Option<String>>>,
}

impl std::fmt::Debug for ZitadelIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZitadelIdentity")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

/// One grant of the project in an organization, as the lists return it.
struct Grant {
    id: String,
    user_id: String,
    role: String,
    created_at: Option<i64>,
    machine: bool,
    email: Option<String>,
    login_name: String,
    first_name: Option<String>,
    last_name: Option<String>,
}

/// The parts of a v2 user the port needs.
struct UserInfo {
    resource_owner: Option<String>,
    email: Option<String>,
    email_verified: bool,
    machine: bool,
    avatar_url: Option<String>,
}

impl ZitadelIdentity {
    pub fn new(options: ZitadelOptions) -> Result<Self, IdentityError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|error| IdentityError::Unavailable(error.to_string()))?;
        Ok(Self {
            options: ZitadelOptions {
                api_url: options.api_url.trim_end_matches('/').to_owned(),
                ..options
            },
            client,
            project_grants: Mutex::new(HashMap::new()),
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        org: Option<&str>,
        body: Option<Value>,
    ) -> IdentityResult<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.options.api_url))
            .bearer_auth(&self.options.token)
            .header("accept", "application/json");
        if let Some(org) = org {
            request = request.header("x-zitadel-orgid", org);
        }
        if let Some(host) = &self.options.host {
            request = request.header("host", host);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|error| IdentityError::Unavailable(error.without_url().to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .await
            .map_err(|error| IdentityError::Unavailable(error.to_string()))?;
        let body: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if status < 400 {
            return Ok(body);
        }
        let code = body
            .get("details")
            .and_then(Value::as_array)
            .and_then(|details| details.first())
            .and_then(|detail| detail.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        // An organization header naming no organization is refused as
        // permission denied; it is a missing organization.
        let status = if code.as_deref() == Some("AUTH-Bs7Ds") {
            404
        } else {
            status
        };
        Err(IdentityError::Rejected {
            status,
            code,
            message: body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// The organization's grant of the project, or `None` when it owns the
    /// project. An organization without the project is refused as 404.
    async fn project_grant(&self, org: &str) -> IdentityResult<Option<String>> {
        if let Some(grant) = self
            .project_grants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(org)
        {
            return Ok(grant.clone());
        }
        let granted = self
            .call(
                Method::POST,
                "/management/v1/granted_projects/_search",
                Some(org),
                Some(json!({})),
            )
            .await?;
        let grant = results(&granted)
            .iter()
            .find(|project| str_field(project, "projectId") == Some(&self.options.project_id))
            .and_then(|project| str_field(project, "grantId").map(str::to_owned));
        if grant.is_none() {
            // Not granted: fine when the organization owns the project.
            self.call(
                Method::GET,
                &format!("/management/v1/projects/{}", self.options.project_id),
                Some(org),
                None,
            )
            .await
            .map_err(|_| IdentityError::Rejected {
                status: 404,
                code: Some("project_not_granted".to_owned()),
                message: Some(
                    "the WeldSuite project is not granted to this organization".to_owned(),
                ),
            })?;
        }
        self.project_grants
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(org.to_owned(), grant.clone());
        Ok(grant)
    }

    /// The project's grants in `org`, optionally of one user.
    async fn grants(&self, org: &str, user_id: Option<&str>) -> IdentityResult<Vec<Grant>> {
        let mut queries =
            vec![json!({ "projectIdQuery": { "projectId": self.options.project_id } })];
        if let Some(user_id) = user_id {
            queries.push(json!({ "userIdQuery": { "userId": user_id } }));
        }
        let found = self
            .call(
                Method::POST,
                "/management/v1/users/grants/_search",
                Some(org),
                Some(json!({ "query": { "limit": LIST_LIMIT }, "queries": queries })),
            )
            .await?;
        Ok(results(&found).iter().map(grant_from).collect())
    }

    async fn users(&self, ids: &[&str]) -> IdentityResult<HashMap<String, UserInfo>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let found = self
            .call(
                Method::POST,
                "/v2/users",
                None,
                Some(json!({
                    "query": { "limit": LIST_LIMIT },
                    "queries": [{ "inUserIdsQuery": { "userIds": ids } }],
                })),
            )
            .await?;
        Ok(results(&found)
            .iter()
            .filter_map(|user| Some((str_field(user, "userId")?.to_owned(), user_info(user))))
            .collect())
    }

    async fn user(&self, user_id: &str) -> IdentityResult<UserInfo> {
        let found = self
            .call(Method::GET, &format!("/v2/users/{user_id}"), None, None)
            .await?;
        Ok(user_info(found.get("user").unwrap_or(&Value::Null)))
    }

    /// The grants of `org`, split into members and pending invitees.
    async fn split(&self, org: &str) -> IdentityResult<(Vec<Membership>, Vec<Invitation>)> {
        let grants = self.grants(org, None).await?;
        let ids: Vec<&str> = grants
            .iter()
            .filter(|grant| !grant.machine)
            .map(|grant| grant.user_id.as_str())
            .collect();
        let users = self.users(&ids).await?;
        let mut members = Vec::new();
        let mut invited = Vec::new();
        for grant in grants {
            let user = users.get(&grant.user_id);
            let pending = !grant.machine && user.is_some_and(|user| !user.email_verified);
            if pending {
                invited.push(invitation_from(&grant, user, "pending"));
            } else {
                members.push(membership_from(&grant, user));
            }
        }
        Ok((members, invited))
    }

    async fn set_metadata(&self, org: &str, key: &str, value: Option<&str>) -> IdentityResult<()> {
        match value {
            Some(value) => self
                .call(
                    Method::POST,
                    &format!("/management/v1/metadata/{key}"),
                    Some(org),
                    Some(json!({ "value": BASE64.encode(value) })),
                )
                .await
                .map(drop),
            None => match self
                .call(
                    Method::DELETE,
                    &format!("/management/v1/metadata/{key}"),
                    Some(org),
                    None,
                )
                .await
            {
                Err(error) if error.is_not_found() => Ok(()),
                result => result.map(drop),
            },
        }
    }

    async fn find_grant(&self, org: &str, user_id: &str) -> IdentityResult<Grant> {
        self.grants(org, Some(user_id))
            .await?
            .into_iter()
            .find(|grant| grant.user_id == user_id)
            .ok_or_else(not_found)
    }

    async fn users_by_email_inner(&self, email: &str, limit: u32) -> IdentityResult<Vec<User>> {
        let found = self
            .call(
                Method::POST,
                "/v2/users",
                None,
                Some(json!({
                    "query": { "limit": limit },
                    "queries": [{ "emailQuery": {
                        "emailAddress": email,
                        "method": "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE",
                    } }],
                })),
            )
            .await?;
        Ok(results(&found)
            .iter()
            .filter_map(|user| str_field(user, "userId"))
            .map(|id| User { id: id.to_owned() })
            .collect())
    }

    async fn add_grant(&self, org: &str, user_id: &str, role: &str) -> IdentityResult<String> {
        let mut body = json!({
            "projectId": self.options.project_id,
            "roleKeys": [role_key(role)],
        });
        if let Some(grant) = self.project_grant(org).await? {
            body["projectGrantId"] = json!(grant);
        }
        let created = self
            .call(
                Method::POST,
                &format!("/management/v1/users/{user_id}/grants"),
                Some(org),
                Some(body),
            )
            .await?;
        str_field(&created, "userGrantId")
            .map(str::to_owned)
            .ok_or_else(|| IdentityError::Unavailable("no userGrantId in the answer".to_owned()))
    }

    async fn invite_inner(
        &self,
        org: &str,
        invitation: &NewInvitation,
    ) -> IdentityResult<Invitation> {
        let email = invitation.email_address.trim();
        let existing = self.users_by_email_inner(email, 1).await?;
        let (user_id, pending) = if let Some(user) = existing.into_iter().next() {
            let info = self.user(&user.id).await?;
            (user.id, !info.machine && !info.email_verified)
        } else {
            let local = email.split('@').next().unwrap_or(email);
            let created = self
                .call(
                    Method::POST,
                    "/v2/users/human",
                    None,
                    Some(json!({
                        "organization": { "orgId": org },
                        "username": email,
                        "profile": { "givenName": local, "familyName": local },
                        // The invite code verifies the email; no second mail.
                        "email": { "email": email, "returnCode": {} },
                    })),
                )
                .await?;
            let user_id = str_field(&created, "userId")
                .map(str::to_owned)
                .ok_or_else(|| IdentityError::Unavailable("no userId in the answer".to_owned()))?;
            let mut send = json!({ "applicationName": self.options.application_name });
            if let Some(template) = &self.options.invite_url_template {
                send["urlTemplate"] = json!(template);
            }
            self.call(
                Method::POST,
                &format!("/v2/users/{user_id}/invite_code"),
                None,
                Some(json!({ "sendCode": send })),
            )
            .await?;
            (user_id, true)
        };
        let grant_id = self.add_grant(org, &user_id, &invitation.role).await?;
        Ok(Invitation {
            id: format!("{user_id}:{grant_id}"),
            email_address: email.to_owned(),
            role: invitation.role.clone(),
            status: if pending { "pending" } else { "accepted" }.to_owned(),
            public_metadata: Value::Null,
            created_at: None,
            expires_at: None,
        })
    }

    async fn invitation_inner(&self, org: &str, id: &str) -> IdentityResult<Invitation> {
        let (user_id, grant_id) = split_invitation_id(id)?;
        let found = self
            .call(
                Method::GET,
                &format!("/management/v1/users/{user_id}/grants/{grant_id}"),
                Some(org),
                None,
            )
            .await?;
        let grant = grant_from(found.get("userGrant").unwrap_or(&Value::Null));
        let user = self.user(user_id).await?;
        let status = if user.email_verified || user.machine {
            "accepted"
        } else {
            "pending"
        };
        Ok(invitation_from(
            &Grant {
                id: grant_id.to_owned(),
                user_id: user_id.to_owned(),
                ..grant
            },
            Some(&user),
            status,
        ))
    }

    async fn revoke_inner(&self, org: &str, id: &str) -> IdentityResult<()> {
        let (user_id, grant_id) = split_invitation_id(id)?;
        self.call(
            Method::DELETE,
            &format!("/management/v1/users/{user_id}/grants/{grant_id}"),
            Some(org),
            None,
        )
        .await?;
        // A user this organization's invitation created, who never signed in.
        let user = self.user(user_id).await?;
        if !user.machine && !user.email_verified && user.resource_owner.as_deref() == Some(org) {
            self.call(Method::DELETE, &format!("/v2/users/{user_id}"), None, None)
                .await?;
        }
        Ok(())
    }

    async fn organization_inner(&self, org: &str) -> IdentityResult<Organization> {
        let found = self
            .call(Method::GET, "/management/v1/orgs/me", Some(org), None)
            .await?;
        let organization = found.get("org").unwrap_or(&Value::Null);
        // A removed organization still answers, without an active or
        // inactive state.
        if !matches!(
            str_field(organization, "state"),
            Some("ORG_STATE_ACTIVE" | "ORG_STATE_INACTIVE")
        ) {
            return Err(not_found());
        }
        let metadata = self
            .call(
                Method::POST,
                "/management/v1/metadata/_search",
                Some(org),
                Some(json!({})),
            )
            .await?;
        let value = |key: &str| {
            results(&metadata)
                .iter()
                .find(|entry| str_field(entry, "key") == Some(key))
                .and_then(|entry| str_field(entry, "value"))
                .and_then(|value| BASE64.decode(value).ok())
                .and_then(|bytes| String::from_utf8(bytes).ok())
        };
        let json_value = |key: &str| {
            value(key)
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .unwrap_or(Value::Null)
        };
        Ok(Organization {
            id: str_field(organization, "id").unwrap_or(org).to_owned(),
            // The workspace's own name when Zitadel's had to differ (names
            // are unique per instance in Zitadel, not in WeldSuite).
            name: value(NAME_KEY)
                .or_else(|| str_field(organization, "name").map(str::to_owned))
                .unwrap_or_default(),
            slug: value(SLUG_KEY),
            max_memberships: value(CAP_KEY).and_then(|cap| cap.parse().ok()),
            public_metadata: json_value(PUBLIC_METADATA_KEY),
            private_metadata: json_value(PRIVATE_METADATA_KEY),
        })
    }

    /// Rename the organization: `name`, or when another organization has
    /// that name already, `name (suffix)`, with the name itself kept in
    /// metadata (`weldsuite.name`) for [`Identity::organization`].
    async fn rename(&self, org: &str, name: &str, suffix: &str) -> IdentityResult<()> {
        let renamed = self
            .call(
                Method::PUT,
                "/management/v1/orgs/me",
                Some(org),
                Some(json!({ "name": name })),
            )
            .await;
        match renamed {
            Ok(_) => self.set_metadata(org, NAME_KEY, None).await,
            Err(error) if error.status() == Some(409) => {
                self.call(
                    Method::PUT,
                    "/management/v1/orgs/me",
                    Some(org),
                    Some(json!({ "name": format!("{name} ({suffix})") })),
                )
                .await?;
                self.set_metadata(org, NAME_KEY, Some(name)).await
            }
            // Renaming to its own name: nothing changed.
            Err(error) if error.status() == Some(400) && error.code() == Some("ORG-4VSdf") => {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    async fn update_organization_inner(
        &self,
        org: &str,
        changes: &OrganizationChanges,
    ) -> IdentityResult<()> {
        if let Some(name) = &changes.name {
            self.rename(org, name, changes.slug.as_deref().unwrap_or(org))
                .await?;
        }
        if let Some(slug) = &changes.slug {
            self.set_metadata(org, SLUG_KEY, Some(slug)).await?;
        }
        if let Some(cap) = changes.max_memberships {
            let value = (cap > 0).then(|| cap.to_string());
            self.set_metadata(org, CAP_KEY, value.as_deref()).await?;
        }
        Ok(())
    }

    async fn user_memberships_inner(
        &self,
        user_id: &str,
        limit: u32,
    ) -> IdentityResult<Vec<Membership>> {
        let found = self
            .call(
                Method::POST,
                "/v2beta/authorizations/search",
                None,
                Some(json!({
                    "pagination": { "limit": limit },
                    "filters": [
                        { "userId": { "id": user_id } },
                        { "projectId": { "id": self.options.project_id } },
                    ],
                })),
            )
            .await?;
        let mut memberships = Vec::new();
        for authorization in found
            .get("authorizations")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            let Some(org) = str_field(authorization, "organizationId") else {
                continue;
            };
            let organization = self.organization_inner(org).await?;
            let user = authorization.get("user").unwrap_or(&Value::Null);
            memberships.push(Membership {
                id: str_field(authorization, "id")
                    .unwrap_or_default()
                    .to_owned(),
                role: clerk_role(
                    authorization
                        .get("roles")
                        .and_then(Value::as_array)
                        .and_then(|roles| roles.first())
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                ),
                created_at: str_field(authorization, "creationDate").and_then(millis),
                public_metadata: Value::Null,
                user: MemberUser {
                    user_id: user_id.to_owned(),
                    identifier: str_field(user, "preferredLoginName")
                        .unwrap_or_default()
                        .to_owned(),
                    ..MemberUser::default()
                },
                organization: Some(OrganizationRef {
                    id: organization.id,
                    name: organization.name,
                    slug: organization.slug.unwrap_or_default(),
                }),
            });
        }
        memberships.truncate(limit as usize);
        Ok(memberships)
    }
}

impl Identity for ZitadelIdentity {
    fn organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<Organization>> {
        Box::pin(self.organization_inner(org))
    }

    fn update_organization<'a>(
        &'a self,
        org: &'a str,
        changes: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.update_organization_inner(org, changes))
    }

    fn delete_organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            self.call(Method::DELETE, "/management/v1/orgs/me", Some(org), None)
                .await?;
            self.project_grants
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(org);
            Ok(())
        })
    }

    fn memberships<'a>(
        &'a self,
        org: &'a str,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>> {
        Box::pin(async move { Ok(page_of(self.split(org).await?.0, page)) })
    }

    fn add_membership<'a>(
        &'a self,
        org: &'a str,
        membership: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>> {
        Box::pin(async move {
            if self.find_grant(org, &membership.user_id).await.is_ok() {
                return Err(IdentityError::Rejected {
                    status: 400,
                    code: Some("already_a_member_in_organization".to_owned()),
                    message: None,
                });
            }
            let id = self
                .add_grant(org, &membership.user_id, &membership.role)
                .await?;
            Ok(Membership {
                id,
                role: membership.role.clone(),
                created_at: None,
                public_metadata: Value::Null,
                user: MemberUser {
                    user_id: membership.user_id.clone(),
                    ..MemberUser::default()
                },
                organization: None,
            })
        })
    }

    fn set_membership_role<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
        role: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let grant = self.find_grant(org, user_id).await?;
            self.call(
                Method::PUT,
                &format!("/management/v1/users/{user_id}/grants/{}", grant.id),
                Some(org),
                Some(json!({ "roleKeys": [role_key(role)] })),
            )
            .await
            .map(drop)
        })
    }

    fn remove_membership<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let grant = self.find_grant(org, user_id).await?;
            self.call(
                Method::DELETE,
                &format!("/management/v1/users/{user_id}/grants/{}", grant.id),
                Some(org),
                None,
            )
            .await
            .map(drop)
        })
    }

    fn invitations<'a>(
        &'a self,
        org: &'a str,
        status: Option<&'a str>,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        Box::pin(async move {
            // Only pending invitations exist as such (module docs).
            if status.is_some_and(|status| status != "pending") {
                return Ok(page_of(Vec::new(), page));
            }
            Ok(page_of(self.split(org).await?.1, page))
        })
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
        Box::pin(self.revoke_inner(org, invitation_id))
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
        Box::pin(async move {
            self.call(Method::DELETE, &format!("/v2/users/{user_id}"), None, None)
                .await
                .map(drop)
        })
    }
}

fn not_found() -> IdentityError {
    IdentityError::Rejected {
        status: 404,
        code: Some("resource_not_found".to_owned()),
        message: None,
    }
}

/// `org:admin` → `admin`: Zitadel project role keys.
fn role_key(role: &str) -> &str {
    role.strip_prefix("org:").unwrap_or(role)
}

/// `admin` → `org:admin`, the port's (Clerk's) role keys.
fn clerk_role(key: &str) -> String {
    if key.is_empty() {
        "org:member".to_owned()
    } else {
        format!("org:{key}")
    }
}

fn split_invitation_id(id: &str) -> IdentityResult<(&str, &str)> {
    id.split_once(':')
        .filter(|(user, grant)| !user.is_empty() && !grant.is_empty())
        .ok_or_else(not_found)
}

fn results(value: &Value) -> &[Value] {
    value
        .get("result")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

fn str_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// An RFC 3339 time as milliseconds since the epoch.
fn millis(time: &str) -> Option<i64> {
    time.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

fn grant_from(grant: &Value) -> Grant {
    let text = |name: &str| str_field(grant, name).map(str::to_owned);
    Grant {
        id: text("id").unwrap_or_default(),
        user_id: text("userId").unwrap_or_default(),
        role: grant
            .get("roleKeys")
            .and_then(Value::as_array)
            .and_then(|roles| roles.first())
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        created_at: grant
            .get("details")
            .and_then(|details| str_field(details, "creationDate"))
            .and_then(millis),
        machine: str_field(grant, "userType") == Some("TYPE_MACHINE"),
        email: text("email"),
        login_name: text("preferredLoginName")
            .or_else(|| text("userName"))
            .unwrap_or_default(),
        first_name: text("firstName"),
        last_name: text("lastName"),
    }
}

fn user_info(user: &Value) -> UserInfo {
    let human = user.get("human");
    let email = human.and_then(|human| human.get("email"));
    UserInfo {
        resource_owner: user
            .get("details")
            .and_then(|details| str_field(details, "resourceOwner"))
            .map(str::to_owned),
        email: email
            .and_then(|email| str_field(email, "email"))
            .map(str::to_owned),
        email_verified: email
            .and_then(|email| email.get("isVerified"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        machine: human.is_none() && user.get("machine").is_some(),
        avatar_url: human
            .and_then(|human| human.get("profile"))
            .and_then(|profile| str_field(profile, "avatarUrl"))
            .map(str::to_owned),
    }
}

fn membership_from(grant: &Grant, user: Option<&UserInfo>) -> Membership {
    Membership {
        id: grant.id.clone(),
        role: clerk_role(&grant.role),
        created_at: grant.created_at,
        public_metadata: Value::Null,
        user: MemberUser {
            user_id: grant.user_id.clone(),
            first_name: grant.first_name.clone(),
            last_name: grant.last_name.clone(),
            identifier: grant
                .email
                .clone()
                .unwrap_or_else(|| grant.login_name.clone()),
            image_url: user.and_then(|user| user.avatar_url.clone()),
        },
        organization: None,
    }
}

fn invitation_from(grant: &Grant, user: Option<&UserInfo>, status: &str) -> Invitation {
    Invitation {
        id: format!("{}:{}", grant.user_id, grant.id),
        email_address: grant
            .email
            .clone()
            .or_else(|| user.and_then(|user| user.email.clone()))
            .unwrap_or_else(|| grant.login_name.clone()),
        role: clerk_role(&grant.role),
        status: status.to_owned(),
        public_metadata: Value::Null,
        created_at: grant.created_at,
        expires_at: None,
    }
}

fn page_of<T>(items: Vec<T>, page: ListPage) -> Listing<T> {
    let total = items.len() as u64;
    let offset = page.offset.unwrap_or(0) as usize;
    let limit = page.limit.map_or(usize::MAX, |limit| limit as usize);
    Listing {
        data: items.into_iter().skip(offset).take(limit).collect(),
        total_count: Some(total),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_and_invitation_ids() {
        assert_eq!(role_key("org:admin"), "admin");
        assert_eq!(role_key("member"), "member");
        assert_eq!(clerk_role("admin"), "org:admin");
        assert_eq!(clerk_role(""), "org:member");
        assert_eq!(split_invitation_id("1:2").expect("ok"), ("1", "2"));
        assert!(split_invitation_id("12").is_err());
        assert!(split_invitation_id(":2").is_err());
        assert_eq!(millis("1970-01-01T00:00:01.5Z"), Some(1500));
    }
}
