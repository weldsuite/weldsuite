//! Conformance mode's third-party calls: the [`Identity`] port as Clerk's
//! Backend API, sent through the test harness's outbound bridge
//! (`packages/core/worker-kit/src/testing/outbound-bridge.ts`), which replays
//! each call into the test's own `fetch` stub. Both backends then get the same
//! answers from the same stub, and the harness compares the calls each made.
//!
//! This is test infrastructure, not a Clerk adapter for the Kubernetes
//! editions (they get Zitadel in P5, ADR SEC-012): its job is to make exactly
//! the requests the TypeScript routes make, so a port that drifts shows up as
//! a side-effect difference.
//!
//! `<METHOD> {bridge}/fetch?url=<the Clerk URL>`; the bridge answers with the
//! stub's status and body, or 502 with `x-outbound-error` when the stub threw.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex, PoisonError};

use reqwest::{Client, Method};
use serde_json::{Map, Value, json};
use weldsuite_ports::{
    BoxFuture, Identity, IdentityError, IdentityResult, Invitation, ListPage, Listing, MemberUser,
    Membership, NewInvitation, NewMembership, Organization, OrganizationChanges, OrganizationRef,
    User,
};

const CLERK_API: &str = "https://api.clerk.com/v1";

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `?limit=…&offset=…` (after `prefix`, the parameters already there), in
/// the order the workers write them.
fn query(prefix: &[(&str, String)], page: ListPage) -> String {
    let mut parts: Vec<String> = prefix.iter().map(|(k, v)| format!("{k}={v}")).collect();
    if let Some(limit) = page.limit {
        parts.push(format!("limit={limit}"));
    }
    if let Some(offset) = page.offset {
        parts.push(format!("offset={offset}"));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("?{}", parts.join("&"))
    }
}

/// Clerk's Backend API through the bridge.
pub(crate) struct BridgedClerk {
    bridge: String,
    client: Client,
}

impl BridgedClerk {
    fn new(bridge: &str, client: Client) -> Self {
        Self {
            bridge: bridge.trim_end_matches('/').to_owned(),
            client,
        }
    }

    /// One call; `Ok(body)` on a 2xx (`Value::Null` when empty or not JSON).
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> IdentityResult<Value> {
        let url = format!("{CLERK_API}{path}");
        let encoded: String = form_urlencoded::byte_serialize(url.as_bytes()).collect();
        let mut request = self
            .client
            .request(method, format!("{}/fetch?url={encoded}", self.bridge))
            .header("authorization", "Bearer conformance");
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|error| IdentityError::Unavailable(error.to_string()))?;
        if response.headers().contains_key("x-outbound-error") {
            return Err(IdentityError::Unavailable(
                "the test's fetch stub threw".to_owned(),
            ));
        }
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| IdentityError::Unavailable(error.to_string()))?;
        let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(json);
        }
        let first = &json["errors"][0];
        Err(IdentityError::Rejected {
            status: status.as_u16(),
            code: first["code"].as_str().map(str::to_owned),
            message: first["long_message"]
                .as_str()
                .or_else(|| first["message"].as_str())
                .map(str::to_owned),
        })
    }
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn optional_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn organization_from(value: &Value) -> Organization {
    Organization {
        id: text(&value["id"]),
        name: text(&value["name"]),
        slug: optional_text(&value["slug"]),
        max_memberships: value["max_allowed_memberships"].as_i64(),
    }
}

fn membership_from(value: &Value) -> Membership {
    let user = &value["public_user_data"];
    let organization = &value["organization"];
    Membership {
        id: text(&value["id"]),
        role: text(&value["role"]),
        created_at: value["created_at"].as_i64(),
        public_metadata: value["public_metadata"].clone(),
        user: MemberUser {
            user_id: text(&user["user_id"]),
            first_name: optional_text(&user["first_name"]),
            last_name: optional_text(&user["last_name"]),
            identifier: text(&user["identifier"]),
            image_url: optional_text(&user["image_url"]),
        },
        organization: organization.is_object().then(|| OrganizationRef {
            id: text(&organization["id"]),
            name: text(&organization["name"]),
            slug: text(&organization["slug"]),
        }),
    }
}

fn invitation_from(value: &Value) -> Invitation {
    Invitation {
        id: text(&value["id"]),
        email_address: text(&value["email_address"]),
        role: text(&value["role"]),
        status: text(&value["status"]),
        public_metadata: value["public_metadata"].clone(),
        created_at: value["created_at"].as_i64(),
        expires_at: value["expires_at"].as_i64(),
    }
}

fn listing<T>(body: &Value, item: fn(&Value) -> T) -> Listing<T> {
    Listing {
        data: body["data"]
            .as_array()
            .map(|items| items.iter().map(item).collect())
            .unwrap_or_default(),
        total_count: body["total_count"].as_u64(),
    }
}

impl Identity for BridgedClerk {
    fn organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<Organization>> {
        Box::pin(async move {
            let body = self
                .call(Method::GET, &format!("/organizations/{org}"), None)
                .await?;
            Ok(organization_from(&body))
        })
    }

    fn update_organization<'a>(
        &'a self,
        org: &'a str,
        changes: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let mut body = Map::new();
            if let Some(name) = &changes.name {
                body.insert("name".to_owned(), json!(name));
            }
            if let Some(slug) = &changes.slug {
                body.insert("slug".to_owned(), json!(slug));
            }
            if let Some(cap) = changes.max_memberships {
                body.insert(
                    "max_allowed_memberships".to_owned(),
                    if cap > 0 { json!(cap) } else { Value::Null },
                );
            }
            self.call(
                Method::PATCH,
                &format!("/organizations/{org}"),
                Some(Value::Object(body)),
            )
            .await
            .map(|_| ())
        })
    }

    fn delete_organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            self.call(Method::DELETE, &format!("/organizations/{org}"), None)
                .await
                .map(|_| ())
        })
    }

    fn memberships<'a>(
        &'a self,
        org: &'a str,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>> {
        Box::pin(async move {
            let path = format!("/organizations/{org}/memberships{}", query(&[], page));
            let body = self.call(Method::GET, &path, None).await?;
            Ok(listing(&body, membership_from))
        })
    }

    fn add_membership<'a>(
        &'a self,
        org: &'a str,
        membership: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>> {
        Box::pin(async move {
            let mut body = json!({ "user_id": membership.user_id, "role": membership.role });
            if let Some(metadata) = &membership.public_metadata {
                body["public_metadata"] = metadata.clone();
            }
            let created = self
                .call(
                    Method::POST,
                    &format!("/organizations/{org}/memberships"),
                    Some(body),
                )
                .await?;
            Ok(membership_from(&created))
        })
    }

    fn set_membership_role<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
        role: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let path = format!(
                "/organizations/{org}/memberships/{}",
                encode_uri_component(user_id)
            );
            self.call(Method::PATCH, &path, Some(json!({ "role": role })))
                .await
                .map(|_| ())
        })
    }

    fn remove_membership<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let path = format!(
                "/organizations/{org}/memberships/{}",
                encode_uri_component(user_id)
            );
            self.call(Method::DELETE, &path, None).await.map(|_| ())
        })
    }

    fn invitations<'a>(
        &'a self,
        org: &'a str,
        status: Option<&'a str>,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        Box::pin(async move {
            let prefix: Vec<(&str, String)> = status
                .map(|status| vec![("status", status.to_owned())])
                .unwrap_or_default();
            let path = format!("/organizations/{org}/invitations{}", query(&prefix, page));
            let body = self.call(Method::GET, &path, None).await?;
            Ok(listing(&body, invitation_from))
        })
    }

    fn invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(async move {
            let path = format!("/organizations/{org}/invitations/{invitation_id}");
            let body = self.call(Method::GET, &path, None).await?;
            Ok(invitation_from(&body))
        })
    }

    fn invite<'a>(
        &'a self,
        org: &'a str,
        invitation: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        Box::pin(async move {
            let mut body = json!({
                "email_address": invitation.email_address,
                "role": invitation.role,
            });
            if let Some(redirect) = &invitation.redirect_url {
                body["redirect_url"] = json!(redirect);
            }
            if let Some(metadata) = &invitation.public_metadata {
                body["public_metadata"] = metadata.clone();
            }
            let created = self
                .call(
                    Method::POST,
                    &format!("/organizations/{org}/invitations"),
                    Some(body),
                )
                .await?;
            Ok(invitation_from(&created))
        })
    }

    fn revoke_invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            let path = format!("/organizations/{org}/invitations/{invitation_id}/revoke");
            self.call(Method::POST, &path, Some(json!({})))
                .await
                .map(|_| ())
        })
    }

    fn users_by_email<'a>(
        &'a self,
        email: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<User>>> {
        Box::pin(async move {
            let path = format!(
                "/users?email_address={}&limit={limit}",
                encode_uri_component(email)
            );
            let body = self.call(Method::GET, &path, None).await?;
            Ok(body
                .as_array()
                .map(|users| {
                    users
                        .iter()
                        .map(|user| User {
                            id: text(&user["id"]),
                        })
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    fn user_memberships<'a>(
        &'a self,
        user_id: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<Membership>>> {
        Box::pin(async move {
            let path = format!("/users/{user_id}/organization_memberships?limit={limit}");
            let body = self.call(Method::GET, &path, None).await?;
            Ok(listing(&body, membership_from).data)
        })
    }

    fn delete_user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(async move {
            self.call(Method::DELETE, &format!("/users/{user_id}"), None)
                .await
                .map(|_| ())
        })
    }
}

/// Expo's push API through the bridge: the POST goes to the test's fetch
/// stub, which answers for Expo.
pub(crate) struct BridgedExpo {
    bridge: String,
    client: Client,
}

impl weldsuite_core_team::ExpoTransport for BridgedExpo {
    fn post<'a>(
        &'a self,
        url: &'a str,
        body: String,
    ) -> BoxFuture<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            let encoded: String = form_urlencoded::byte_serialize(url.as_bytes()).collect();
            let response = self
                .client
                .post(format!("{}/fetch?url={encoded}", self.bridge))
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            if response.headers().contains_key("x-outbound-error") {
                return Err("the test's fetch stub threw".to_owned());
            }
            let status = response.status().as_u16();
            let text = response.text().await.map_err(|error| error.to_string())?;
            Ok((status, text))
        })
    }
}

/// The bridged providers by bridge URL, made once per test process.
#[derive(Default)]
pub(crate) struct OutboundBridges {
    identities: Mutex<HashMap<String, Arc<dyn Identity>>>,
    client: Client,
}

impl OutboundBridges {
    /// Expo's push API behind the test's bridge.
    pub(crate) fn expo(&self, bridge: &str) -> weldsuite_core_team::ExpoGateway {
        weldsuite_core_team::ExpoGateway(Arc::new(BridgedExpo {
            bridge: bridge.trim_end_matches('/').to_owned(),
            client: self.client.clone(),
        }))
    }

    /// The [`Identity`] provider behind the test's bridge.
    pub(crate) fn identity(&self, bridge: &str) -> Arc<dyn Identity> {
        let mut identities = self
            .identities
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        Arc::clone(
            identities
                .entry(bridge.to_owned())
                .or_insert_with(|| Arc::new(BridgedClerk::new(bridge, self.client.clone()))),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("user_1"), "user_1");
        assert_eq!(encode_uri_component("a b+c@d.e"), "a%20b%2Bc%40d.e");
        assert_eq!(encode_uri_component("é!*'()~"), "%C3%A9!*'()~");
    }

    #[test]
    fn queries_keep_the_workers_order() {
        assert_eq!(query(&[], ListPage::default()), "");
        assert_eq!(query(&[], ListPage::limit(500)), "?limit=500");
        assert_eq!(
            query(&[("status", "pending".to_owned())], ListPage::at(100, 0)),
            "?status=pending&limit=100&offset=0"
        );
    }
}
