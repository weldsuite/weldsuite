//! Enterprise SSO connections at the identity provider: the port behind
//! WeldID's SSO admin API (ADR SEC-019, phase 5a: `OpenID` Connect first).
//! The Global edition keeps its SAML connections at Clerk (ADR SEC-010) and
//! never uses this port; on the Kubernetes editions only WeldID offers it, so
//! `/api/sso` manages connections only when one is configured.
//!
//! A connection belongs to one workspace: every call names its
//! `tenant_ref` (`workspaces.id`), and an adapter answers 404 for a
//! connection of another tenant, whatever the provider answered. A
//! connection serves one or more domains, each proven with the TXT record
//! `_weldsuite-sso.<domain>` that the provider checks (it acts on the
//! result).
//!
//! | Method | WeldID admin API (scope `weldid:sso`) |
//! |---|---|
//! | [`SsoDirectory::connections`] | `GET /admin/v1/tenants/{tenantRef}/sso/connections` |
//! | [`SsoDirectory::create_connection`] | `POST …/connections` |
//! | [`SsoDirectory::update_connection`] | `PATCH …/connections/{id}` |
//! | [`SsoDirectory::delete_connection`] | `DELETE …/connections/{id}` |
//! | [`SsoDirectory::add_domain`] | `POST …/connections/{id}/domains` |
//! | [`SsoDirectory::remove_domain`] | `DELETE …/connections/{id}/domains/{domainId}` |
//! | [`SsoDirectory::verify_domain`] | `POST …/connections/{id}/domains/{domainId}/verify` |
//!
//! The client secret is write-only: [`NewSsoConnection`] and
//! [`SsoConnectionChanges`] carry it to the provider, and [`SsoConnection`]
//! has no field for it, only whether one is set. Failures are
//! [`IdentityError`]s: `Unavailable` when the provider can't be reached,
//! `Rejected` with its status and code otherwise (`not_found` 404,
//! `domain_in_use` 409, `domain_not_verified` 422, `invalid_request`,
//! `invalid_domain` and `public_mailbox_domain` 400).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::BoxFuture;
use crate::identity::{IdentityError, IdentityResult};

/// Where a domain's ownership proof stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SsoDomainStatus {
    /// Added; the TXT record wasn't found yet (or not looked for).
    Pending,
    /// The TXT record was found: sign-ins at the domain go to the connection.
    Verified,
    /// The last check didn't find the record, or it went away after the
    /// domain was verified (WeldID's `suspended`): no sign-ins go to the
    /// connection.
    Failed,
}

impl SsoDomainStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Verified => "verified",
            Self::Failed => "failed",
        }
    }

    /// The provider's word for it; anything unknown is pending.
    pub fn parse(value: &str) -> Self {
        match value {
            "verified" => Self::Verified,
            "failed" | "suspended" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

/// One domain of a connection, with the record that proves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SsoDomain {
    /// The provider's id of the domain, which its domain calls take.
    pub id: Option<String>,
    /// Lowercase, no trailing dot.
    pub name: String,
    pub status: SsoDomainStatus,
    /// RFC 3339.
    pub verified_at: Option<String>,
    /// When the provider last looked for the record (RFC 3339).
    pub checked_at: Option<String>,
    /// `_weldsuite-sso.<domain>`.
    pub txt_name: String,
    /// The value to publish there.
    pub txt_value: String,
}

/// An `OpenID` Connect connection to a workspace's own identity provider.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per setting of the provider's connection, as its admin API has them"
)]
pub struct SsoConnection {
    pub id: String,
    /// `workspaces.id`.
    pub tenant_ref: String,
    pub display_name: String,
    /// The identity provider's issuer URL.
    pub issuer: String,
    pub client_id: String,
    /// A client secret is stored (it is never read back).
    pub has_client_secret: bool,
    /// Scopes asked for besides `openid email profile`.
    pub scopes: Vec<String>,
    /// Emails the identity provider sends count as verified (for providers
    /// that don't say, Microsoft Entra ID among them); still only on the
    /// connection's verified domains.
    pub trust_emails: bool,
    pub enabled: bool,
    /// People at the connection's verified domains can only sign in through it.
    pub enforce_sso: bool,
    /// What the admin registers at their identity provider as the redirect
    /// URI: the provider's callback for this connection, as it reports it.
    pub redirect_uri: Option<String>,
    pub domains: Vec<SsoDomain>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl SsoConnection {
    /// A domain is verified: the connection can sign someone in.
    pub fn has_verified_domain(&self) -> bool {
        self.domains
            .iter()
            .any(|domain| domain.status == SsoDomainStatus::Verified)
    }

    pub fn domain(&self, name: &str) -> Option<&SsoDomain> {
        self.domains.iter().find(|domain| domain.name == name)
    }
}

/// A connection to create.
#[derive(Clone, PartialEq, Eq)]
pub struct NewSsoConnection {
    pub display_name: String,
    pub issuer: String,
    pub client_id: String,
    /// `None`: a public client at the identity provider (PKCE only).
    pub client_secret: Option<String>,
    pub scopes: Vec<String>,
    pub trust_emails: bool,
    pub enabled: bool,
    pub enforce_sso: bool,
}

impl fmt::Debug for NewSsoConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewSsoConnection")
            .field("display_name", &self.display_name)
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("has_client_secret", &self.client_secret.is_some())
            .field("scopes", &self.scopes)
            .field("trust_emails", &self.trust_emails)
            .field("enabled", &self.enabled)
            .field("enforce_sso", &self.enforce_sso)
            .finish_non_exhaustive()
    }
}

/// What [`SsoDirectory::update_connection`] changes; `None` leaves a field.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SsoConnectionChanges {
    pub display_name: Option<String>,
    pub issuer: Option<String>,
    pub client_id: Option<String>,
    /// A new secret; `None` keeps the stored one.
    pub client_secret: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub trust_emails: Option<bool>,
    pub enabled: Option<bool>,
    pub enforce_sso: Option<bool>,
}

impl SsoConnectionChanges {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

impl fmt::Debug for SsoConnectionChanges {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SsoConnectionChanges")
            .field("display_name", &self.display_name)
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("client_secret", &self.client_secret.as_ref().map(|_| "…"))
            .field("scopes", &self.scopes)
            .field("trust_emails", &self.trust_emails)
            .field("enabled", &self.enabled)
            .field("enforce_sso", &self.enforce_sso)
            .finish()
    }
}

/// See the module docs. Object safe: the provider is picked at run time.
pub trait SsoDirectory: Send + Sync {
    /// The tenant's connections (only theirs).
    fn connections<'a>(
        &'a self,
        tenant_ref: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Vec<SsoConnection>>>;

    fn create_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection: &'a NewSsoConnection,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>>;

    fn update_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        changes: &'a SsoConnectionChanges,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>>;

    /// The connection and its domains.
    fn delete_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>>;

    /// The connection after adding `domain` (pending, with its record).
    fn add_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>>;

    fn remove_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>>;

    /// The provider looks for the TXT record now. The connection after the
    /// check, or a refusal (`domain_not_verified`) when it wasn't found.
    fn verify_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>>;
}

// ── the in-memory double ────────────────────────────────────────────────────

fn refused(status: u16, code: &str) -> IdentityError {
    IdentityError::Rejected {
        status,
        code: Some(code.to_owned()),
        message: None,
        body: None,
    }
}

#[derive(Default)]
struct MemoryState {
    connections: BTreeMap<String, SsoConnection>,
    /// The secret of each connection, to check it is written, never read.
    secrets: BTreeMap<String, String>,
    /// Domains whose TXT record is published (`publish_record`).
    published: BTreeSet<String>,
    next: u32,
    unavailable: bool,
}

/// [`SsoDirectory`] in memory, scoped by tenant as WeldID is: a connection
/// of another tenant is a 404; a domain another tenant holds verified can be
/// added but its check is a 409 `domain_in_use`; a record not published
/// (`publish_record`) is a 422.
#[derive(Default)]
pub struct MemorySsoDirectory {
    state: Mutex<MemoryState>,
}

impl MemorySsoDirectory {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, MemoryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The TXT record of `domain` is now in DNS.
    pub fn publish_record(&self, domain: &str) {
        self.lock().published.insert(domain.to_owned());
    }

    /// Every call answers `Unavailable` from now on (or again works).
    pub fn set_unavailable(&self, unavailable: bool) {
        self.lock().unavailable = unavailable;
    }

    /// The stored secret of a connection, for tests.
    pub fn secret_of(&self, connection_id: &str) -> Option<String> {
        self.lock().secrets.get(connection_id).cloned()
    }

    fn check(state: &MemoryState) -> IdentityResult<()> {
        if state.unavailable {
            return Err(IdentityError::Unavailable(
                "SSO directory is down".to_owned(),
            ));
        }
        Ok(())
    }

    fn owned<'s>(
        state: &'s mut MemoryState,
        tenant_ref: &str,
        connection_id: &str,
    ) -> IdentityResult<&'s mut SsoConnection> {
        state
            .connections
            .get_mut(connection_id)
            .filter(|connection| connection.tenant_ref == tenant_ref)
            .ok_or_else(|| refused(404, "not_found"))
    }

    fn create(&self, tenant_ref: &str, new: &NewSsoConnection) -> IdentityResult<SsoConnection> {
        let mut state = self.lock();
        Self::check(&state)?;
        if new.issuer.is_empty() || new.client_id.is_empty() {
            return Err(refused(400, "invalid_request"));
        }
        state.next += 1;
        let id = format!("ssoc_{}", state.next);
        let connection = SsoConnection {
            id: id.clone(),
            tenant_ref: tenant_ref.to_owned(),
            display_name: new.display_name.clone(),
            issuer: new.issuer.clone(),
            client_id: new.client_id.clone(),
            has_client_secret: new.client_secret.is_some(),
            scopes: new.scopes.clone(),
            trust_emails: new.trust_emails,
            enabled: new.enabled,
            enforce_sso: new.enforce_sso,
            redirect_uri: Some(format!("https://auth.example.test/sso/oidc/{id}/callback")),
            domains: Vec::new(),
            created_at: Some("2026-11-16T10:00:00Z".to_owned()),
            updated_at: Some("2026-11-16T10:00:00Z".to_owned()),
        };
        if let Some(secret) = &new.client_secret {
            state.secrets.insert(id.clone(), secret.clone());
        }
        state.connections.insert(id, connection.clone());
        Ok(connection)
    }

    fn update(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        changes: &SsoConnectionChanges,
    ) -> IdentityResult<SsoConnection> {
        let mut state = self.lock();
        Self::check(&state)?;
        if let Some(secret) = &changes.client_secret {
            Self::owned(&mut state, tenant_ref, connection_id)?.has_client_secret = true;
            state
                .secrets
                .insert(connection_id.to_owned(), secret.clone());
        }
        let connection = Self::owned(&mut state, tenant_ref, connection_id)?;
        if let Some(trust) = changes.trust_emails {
            connection.trust_emails = trust;
        }
        if let Some(name) = &changes.display_name {
            connection.display_name.clone_from(name);
        }
        if let Some(issuer) = &changes.issuer {
            connection.issuer.clone_from(issuer);
        }
        if let Some(client_id) = &changes.client_id {
            connection.client_id.clone_from(client_id);
        }
        if let Some(scopes) = &changes.scopes {
            connection.scopes.clone_from(scopes);
        }
        if let Some(enabled) = changes.enabled {
            connection.enabled = enabled;
        }
        if let Some(enforce) = changes.enforce_sso {
            connection.enforce_sso = enforce;
        }
        Ok(connection.clone())
    }

    fn add(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        let mut state = self.lock();
        Self::check(&state)?;
        state.next += 1;
        let id = format!("ssod_{}", state.next);
        let connection = Self::owned(&mut state, tenant_ref, connection_id)?;
        if connection.domain(domain).is_none() {
            connection.domains.push(SsoDomain {
                id: Some(id),
                name: domain.to_owned(),
                status: SsoDomainStatus::Pending,
                verified_at: None,
                checked_at: None,
                txt_name: format!("_weldsuite-sso.{domain}"),
                txt_value: format!("weldsuite-sso-verification={connection_id}-{domain}"),
            });
        }
        Ok(connection.clone())
    }

    fn remove(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        let mut state = self.lock();
        Self::check(&state)?;
        let connection = Self::owned(&mut state, tenant_ref, connection_id)?;
        let before = connection.domains.len();
        connection.domains.retain(|d| d.name != domain);
        if connection.domains.len() == before {
            return Err(refused(404, "not_found"));
        }
        Ok(connection.clone())
    }

    fn verify(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        let mut state = self.lock();
        Self::check(&state)?;
        let published = state.published.contains(domain);
        let in_use = state.connections.values().any(|other| {
            other.tenant_ref != tenant_ref
                && other
                    .domain(domain)
                    .is_some_and(|d| d.status == SsoDomainStatus::Verified)
        });
        let connection = Self::owned(&mut state, tenant_ref, connection_id)?;
        let Some(entry) = connection.domains.iter_mut().find(|d| d.name == domain) else {
            return Err(refused(404, "not_found"));
        };
        entry.checked_at = Some("2026-11-16T10:05:00Z".to_owned());
        if published && in_use {
            return Err(refused(409, "domain_in_use"));
        }
        if !published {
            if entry.status != SsoDomainStatus::Verified {
                entry.status = SsoDomainStatus::Failed;
            }
            return Err(refused(422, "domain_not_verified"));
        }
        entry.status = SsoDomainStatus::Verified;
        entry.verified_at = Some("2026-11-16T10:05:00Z".to_owned());
        Ok(connection.clone())
    }
}

impl SsoDirectory for MemorySsoDirectory {
    fn connections<'a>(
        &'a self,
        tenant_ref: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Vec<SsoConnection>>> {
        let state = self.lock();
        let answer = Self::check(&state).map(|()| {
            state
                .connections
                .values()
                .filter(|connection| connection.tenant_ref == tenant_ref)
                .cloned()
                .collect()
        });
        drop(state);
        Box::pin(std::future::ready(answer))
    }

    fn create_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection: &'a NewSsoConnection,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(std::future::ready(self.create(tenant_ref, connection)))
    }

    fn update_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        changes: &'a SsoConnectionChanges,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(std::future::ready(self.update(
            tenant_ref,
            connection_id,
            changes,
        )))
    }

    fn delete_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        let mut state = self.lock();
        let answer = Self::check(&state)
            .and_then(|()| Self::owned(&mut state, tenant_ref, connection_id).map(drop))
            .map(|()| {
                state.connections.remove(connection_id);
                state.secrets.remove(connection_id);
            });
        drop(state);
        Box::pin(std::future::ready(answer))
    }

    fn add_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(std::future::ready(self.add(
            tenant_ref,
            connection_id,
            domain,
        )))
    }

    fn remove_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(std::future::ready(self.remove(
            tenant_ref,
            connection_id,
            domain,
        )))
    }

    fn verify_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(std::future::ready(self.verify(
            tenant_ref,
            connection_id,
            domain,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_connection() -> NewSsoConnection {
        NewSsoConnection {
            display_name: "Acme Entra".to_owned(),
            issuer: "https://login.example.test/acme/v2.0".to_owned(),
            client_id: "client-1".to_owned(),
            client_secret: Some("s3cret".to_owned()),
            scopes: Vec::new(),
            trust_emails: false,
            enabled: false,
            enforce_sso: false,
        }
    }

    #[tokio::test]
    async fn the_double_scopes_by_tenant_and_checks_the_record() {
        let directory = MemorySsoDirectory::new();
        let created = directory
            .create_connection("ws_a", &new_connection())
            .await
            .expect("created");
        assert!(created.has_client_secret);
        assert!(format!("{:?}", new_connection()).contains("client-1"));
        assert!(!format!("{:?}", new_connection()).contains("s3cret"));
        assert_eq!(
            directory.connections("ws_b").await.expect("list"),
            Vec::new()
        );
        let error = directory
            .update_connection("ws_b", &created.id, &SsoConnectionChanges::default())
            .await
            .expect_err("another tenant's");
        assert!(error.is_not_found());

        directory
            .add_domain("ws_a", &created.id, "acme.test")
            .await
            .expect("added");
        let error = directory
            .verify_domain("ws_a", &created.id, "acme.test")
            .await
            .expect_err("no record yet");
        assert_eq!(error.status(), Some(422));
        directory.publish_record("acme.test");
        let verified = directory
            .verify_domain("ws_a", &created.id, "acme.test")
            .await
            .expect("verified");
        assert!(verified.has_verified_domain());

        let other = directory
            .create_connection("ws_b", &new_connection())
            .await
            .expect("other");
        // Another workspace may add it, but its check finds it in use.
        directory
            .add_domain("ws_b", &other.id, "acme.test")
            .await
            .expect("added elsewhere");
        let error = directory
            .verify_domain("ws_b", &other.id, "acme.test")
            .await
            .expect_err("in use");
        assert_eq!(
            (error.status(), error.code()),
            (Some(409), Some("domain_in_use"))
        );
    }
}
