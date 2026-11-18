//! WeldID's enterprise SSO connections behind the [`SsoDirectory`] port
//! (ADR SEC-019, phase 5a: `OpenID` Connect connections, managed from the
//! platform's SSO settings). It rides on [`WeldIdIdentity`]'s admin client:
//! the same `private_key_jwt` token, which also asks for `weldid:sso`.
//!
//! WeldID's admin API (`weldid-server::admin::sso`), every path under
//! `/admin/v1/tenants/{tenantRef}/sso` with `tenantRef` = `workspaces.id`:
//!
//! | Port call | Request |
//! |---|---|
//! | `connections` | `GET …/connections` |
//! | `create_connection` | `POST …/connections` `{ protocol: "oidc", displayName, issuer, clientId, clientSecret?, scopes, trustEmails, enabled, enforceSso }`, or `{ protocol: "saml", displayName, metadataXml or metadataUrl, trustEmails, enabled, enforceSso }` (201) |
//! | `update_connection` | `PATCH …/connections/{id}` with the changed fields only (`clientSecret` only when replaced; `metadataXml` or `metadataUrl` for SAML) |
//! | `delete_connection` | `DELETE …/connections/{id}` (204, its domains go with it) |
//! | `add_domain` | `POST …/connections/{id}/domains` `{ domain }` (201, the domain) |
//! | `remove_domain` | `DELETE …/connections/{id}/domains/{domainId}` (204) |
//! | `verify_domain` | `POST …/connections/{id}/domains/{domainId}/verify` (200, the domain after the check; 409 `domain_in_use`) |
//!
//! A connection reads as `{ id, tenantRef, protocol, displayName, issuer,
//! clientId, hasClientSecret, scopes, trustEmails, enabled, enforceSso,
//! redirectUri, saml, domains, createdAt, updatedAt }` (`saml`: null, or
//! `{ entityId, acsUrl, metadataUrl, idpEntityId, idpSsoUrl, idpMetadataUrl,
//! idpCertificates: [{ sha256, subject, notBefore, notAfter }] }`); a domain as `{ id, domain,
//! status: pending|verified|suspended, recordName, recordValue, lastCheck:
//! found|missing|mismatch|lookup_failed, checkedAt, verifiedAt }`. WeldID
//! refuses unknown body fields, so only those are sent.
//!
//! What the adapter makes sure of itself, whatever WeldID answers:
//!
//! - **Tenant scoping.** A connection whose `tenantRef` is another
//!   workspace's is dropped from a list and is a 404 for a write, which
//!   reads the connection first.
//! - **The secret is write-only.** [`SsoConnection`] has no field for it; an
//!   answer that carries one is never read.
//! - **Domains by name.** The port names a domain; its WeldID id comes from
//!   the connection read before the call. Domain writes answer the
//!   connection read again, and a check that leaves the domain unverified
//!   is a 422 `domain_not_verified`.
//! - Only `oidc` and `saml` connections are read; one of another protocol
//!   is skipped.

use std::sync::Arc;

use reqwest::Method;
use serde_json::{Map, Value, json};
use weldsuite_ports::{
    BoxFuture, IdentityError, IdentityResult, NewSsoConnection, SamlCertificate, SamlDetails,
    SamlMetadata, SsoConnection, SsoConnectionChanges, SsoDirectory, SsoDomain, SsoDomainStatus,
    SsoProtocol,
};

use crate::weldid::{WeldIdIdentity, field, list, not_found};

/// Where a workspace's SSO admin routes are: `{prefix}/{tenantRef}/sso`.
pub const WELDID_SSO_TENANTS_PATH: &str = "/admin/v1/tenants";

/// The [`SsoDirectory`] port on WeldID's admin API.
pub struct WeldIdSso {
    weldid: Arc<WeldIdIdentity>,
}

impl std::fmt::Debug for WeldIdSso {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WeldIdSso")
            .field("weldid", &self.weldid)
            .finish()
    }
}

fn boolean(value: &Value, names: &[&str]) -> Option<bool> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_bool))
}

/// A domain's status: a check that didn't find the record leaves WeldID's
/// `pending` with `lastCheck` other than `found`, which reads as failed.
fn domain_status(domain: &Value, verified_at: Option<&str>) -> SsoDomainStatus {
    match field(domain, &["status"]) {
        Some("pending") => match field(domain, &["lastCheck", "last_check"]) {
            Some(check) if check != "found" => SsoDomainStatus::Failed,
            _ => SsoDomainStatus::Pending,
        },
        Some(status) => SsoDomainStatus::parse(status),
        None if verified_at.is_some() => SsoDomainStatus::Verified,
        None => SsoDomainStatus::Pending,
    }
}

fn domain_of(domain: &Value) -> Option<SsoDomain> {
    let name = field(domain, &["domain", "name"])?.to_ascii_lowercase();
    let verified_at = field(domain, &["verifiedAt", "verified_at"]).map(str::to_owned);
    Some(SsoDomain {
        id: field(domain, &["id"]).map(str::to_owned),
        status: domain_status(domain, verified_at.as_deref()),
        verified_at,
        checked_at: field(domain, &["checkedAt", "checked_at"]).map(str::to_owned),
        txt_name: field(domain, &["recordName", "record_name"])
            .map_or_else(|| format!("_weldsuite-sso.{name}"), str::to_owned),
        txt_value: field(domain, &["recordValue", "record_value"])
            .unwrap_or_default()
            .to_owned(),
        name,
    })
}

/// A SAML connection's `saml` block: what to register at the identity
/// provider, and what WeldID took from its metadata. `None` without the
/// service provider's side, which the admin can't do without.
fn saml_of(saml: &Value) -> Option<SamlDetails> {
    let text = |names: &[&str]| field(saml, names).map(str::to_owned);
    let entity_id = text(&["entityId", "entity_id"])?;
    let certificates = saml
        .get("idpCertificates")
        .and_then(Value::as_array)
        .map(|certificates| {
            certificates
                .iter()
                .filter_map(|certificate| {
                    Some(SamlCertificate {
                        sha256: field(certificate, &["sha256"])?.to_owned(),
                        subject: field(certificate, &["subject"]).map(str::to_owned),
                        not_after: field(certificate, &["notAfter", "not_after"])
                            .map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(SamlDetails {
        metadata_url: text(&["metadataUrl", "metadata_url"]).unwrap_or_else(|| entity_id.clone()),
        entity_id,
        acs_url: text(&["acsUrl", "acs_url"])?,
        idp_entity_id: text(&["idpEntityId", "idp_entity_id"]),
        idp_sso_url: text(&["idpSsoUrl", "idp_sso_url"]),
        idp_metadata_url: text(&["idpMetadataUrl", "idp_metadata_url"]),
        idp_certificates: certificates,
    })
}

/// `metadataXml` or `metadataUrl` into `body`.
fn put_metadata(body: &mut Map<String, Value>, metadata: &SamlMetadata) {
    match metadata {
        SamlMetadata::Xml(xml) => body.insert("metadataXml".to_owned(), json!(xml)),
        SamlMetadata::Url(url) => body.insert("metadataUrl".to_owned(), json!(url)),
    };
}

/// A connection as WeldID answers it, if it is an OIDC or SAML connection of
/// `tenant_ref` (an answer without a `tenantRef` is taken as the
/// requested tenant's: every path names it).
fn connection_of(connection: &Value, tenant_ref: &str) -> Option<SsoConnection> {
    let tenant = field(connection, &["tenantRef", "tenant_ref"]).unwrap_or(tenant_ref);
    if tenant != tenant_ref {
        return None;
    }
    // A connection without a protocol predates SAML: `OpenID` Connect.
    let protocol = match field(connection, &["protocol"]) {
        None => SsoProtocol::Oidc,
        Some(protocol) => SsoProtocol::parse(protocol)?,
    };
    let scopes = match connection.get("scopes") {
        Some(Value::Array(scopes)) => scopes
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::String(scopes)) => scopes.split_whitespace().map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let domains = connection
        .get("domains")
        .and_then(Value::as_array)
        .map(|domains| domains.iter().filter_map(domain_of).collect())
        .unwrap_or_default();
    Some(SsoConnection {
        id: field(connection, &["id"])?.to_owned(),
        tenant_ref: tenant.to_owned(),
        protocol,
        saml: match protocol {
            SsoProtocol::Saml => connection.get("saml").and_then(saml_of),
            SsoProtocol::Oidc => None,
        },
        display_name: field(connection, &["displayName", "display_name"])
            .unwrap_or_default()
            .to_owned(),
        issuer: field(connection, &["issuer"])
            .unwrap_or_default()
            .to_owned(),
        client_id: field(connection, &["clientId", "client_id"])
            .unwrap_or_default()
            .to_owned(),
        has_client_secret: boolean(connection, &["hasClientSecret", "has_client_secret"])
            .unwrap_or(false),
        scopes,
        trust_emails: boolean(connection, &["trustEmails", "trust_emails"]).unwrap_or(false),
        enabled: boolean(connection, &["enabled"]).unwrap_or(false),
        enforce_sso: boolean(connection, &["enforceSso", "enforce_sso"]).unwrap_or(false),
        redirect_uri: field(connection, &["redirectUri", "redirect_uri"]).map(str::to_owned),
        domains,
        created_at: field(connection, &["createdAt", "created_at"]).map(str::to_owned),
        updated_at: field(connection, &["updatedAt", "updated_at"]).map(str::to_owned),
    })
}

/// A check that left the domain unverified.
fn not_verified() -> IdentityError {
    IdentityError::Rejected {
        status: 422,
        code: Some("domain_not_verified".to_owned()),
        message: None,
        body: None,
    }
}

fn odd_answer(what: &str) -> IdentityError {
    IdentityError::Unavailable(format!("WeldID answered {what} without a connection"))
}

/// The body of `POST …/connections`: an `OpenID` Connect connection's
/// client, or a SAML connection's metadata (WeldID refuses the other
/// protocol's fields).
fn create_body(new: &NewSsoConnection) -> Value {
    let mut body = Map::new();
    body.insert("protocol".to_owned(), json!(new.protocol.as_str()));
    body.insert("displayName".to_owned(), json!(new.display_name));
    match new.protocol {
        SsoProtocol::Oidc => {
            body.insert("issuer".to_owned(), json!(new.issuer));
            body.insert("clientId".to_owned(), json!(new.client_id));
            body.insert("scopes".to_owned(), json!(new.scopes));
            if let Some(secret) = &new.client_secret {
                body.insert("clientSecret".to_owned(), json!(secret));
            }
        }
        SsoProtocol::Saml => {
            if let Some(metadata) = &new.saml_metadata {
                put_metadata(&mut body, metadata);
            }
        }
    }
    body.insert("trustEmails".to_owned(), json!(new.trust_emails));
    body.insert("enabled".to_owned(), json!(new.enabled));
    body.insert("enforceSso".to_owned(), json!(new.enforce_sso));
    Value::Object(body)
}

/// The body of `PATCH …/connections/{id}`: only what changes.
fn changes_body(changes: &SsoConnectionChanges) -> Value {
    let mut body = Map::new();
    let mut put = |key: &str, value: Value| {
        body.insert(key.to_owned(), value);
    };
    if let Some(name) = &changes.display_name {
        put("displayName", json!(name));
    }
    if let Some(issuer) = &changes.issuer {
        put("issuer", json!(issuer));
    }
    if let Some(client_id) = &changes.client_id {
        put("clientId", json!(client_id));
    }
    if let Some(secret) = &changes.client_secret {
        put("clientSecret", json!(secret));
    }
    if let Some(scopes) = &changes.scopes {
        put("scopes", json!(scopes));
    }
    if let Some(trust) = changes.trust_emails {
        put("trustEmails", json!(trust));
    }
    if let Some(enabled) = changes.enabled {
        put("enabled", json!(enabled));
    }
    if let Some(enforce) = changes.enforce_sso {
        put("enforceSso", json!(enforce));
    }
    if let Some(metadata) = &changes.saml_metadata {
        put_metadata(&mut body, metadata);
    }
    Value::Object(body)
}

impl WeldIdSso {
    pub fn new(weldid: Arc<WeldIdIdentity>) -> Self {
        Self { weldid }
    }

    fn connections_path(tenant_ref: &str) -> String {
        format!("{WELDID_SSO_TENANTS_PATH}/{tenant_ref}/sso/connections")
    }

    fn connection_path(tenant_ref: &str, connection_id: &str) -> String {
        format!("{}/{connection_id}", Self::connections_path(tenant_ref))
    }

    /// The path of a domain of `connection`, by its WeldID id (its name when
    /// WeldID gave none); a 404 when the connection doesn't list it.
    fn domain_path(connection: &SsoConnection, domain: &str) -> IdentityResult<String> {
        let entry = connection.domain(domain).ok_or_else(not_found)?;
        let key = entry.id.as_deref().unwrap_or(&entry.name);
        Ok(format!(
            "{}/domains/{key}",
            Self::connection_path(&connection.tenant_ref, &connection.id)
        ))
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> IdentityResult<Value> {
        // Every id lands in the path; `admin` refuses anything but plain
        // segments, so a tenant or id can't climb out of the tenant's tree.
        self.weldid.admin(method, path, &[], body).await
    }

    async fn connections_inner(&self, tenant_ref: &str) -> IdentityResult<Vec<SsoConnection>> {
        let found = self
            .call(Method::GET, &Self::connections_path(tenant_ref), None)
            .await?;
        Ok(list(&found)
            .iter()
            .filter_map(|connection| connection_of(connection, tenant_ref))
            .collect())
    }

    /// The connection, if it is `tenant_ref`'s; a 404 otherwise.
    async fn owned(&self, tenant_ref: &str, connection_id: &str) -> IdentityResult<SsoConnection> {
        let found = self
            .call(
                Method::GET,
                &Self::connection_path(tenant_ref, connection_id),
                None,
            )
            .await?;
        found
            .get("data")
            .and_then(|connection| connection_of(connection, tenant_ref))
            .filter(|connection| connection.id == connection_id)
            .ok_or_else(not_found)
    }

    /// A write's answer as the connection, else the connection read again.
    async fn answered(
        &self,
        tenant_ref: &str,
        connection_id: Option<&str>,
        answer: &Value,
    ) -> IdentityResult<SsoConnection> {
        if let Some(connection) = answer
            .get("data")
            .and_then(|connection| connection_of(connection, tenant_ref))
            .filter(|connection| connection_id.is_none_or(|id| connection.id == id))
        {
            return Ok(connection);
        }
        let Some(connection_id) = connection_id else {
            return Err(odd_answer("a new connection"));
        };
        self.owned(tenant_ref, connection_id).await
    }

    async fn create_inner(
        &self,
        tenant_ref: &str,
        new: &NewSsoConnection,
    ) -> IdentityResult<SsoConnection> {
        let answer = self
            .call(
                Method::POST,
                &Self::connections_path(tenant_ref),
                Some(&create_body(new)),
            )
            .await?;
        self.answered(tenant_ref, None, &answer).await
    }

    async fn update_inner(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        changes: &SsoConnectionChanges,
    ) -> IdentityResult<SsoConnection> {
        let current = self.owned(tenant_ref, connection_id).await?;
        if changes.is_empty() {
            return Ok(current);
        }
        let answer = self
            .call(
                Method::PATCH,
                &Self::connection_path(tenant_ref, connection_id),
                Some(&changes_body(changes)),
            )
            .await?;
        self.answered(tenant_ref, Some(connection_id), &answer)
            .await
    }

    async fn delete_inner(&self, tenant_ref: &str, connection_id: &str) -> IdentityResult<()> {
        self.owned(tenant_ref, connection_id).await?;
        self.call(
            Method::DELETE,
            &Self::connection_path(tenant_ref, connection_id),
            None,
        )
        .await
        .map(drop)
    }

    async fn add_domain_inner(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        self.owned(tenant_ref, connection_id).await?;
        self.call(
            Method::POST,
            &format!(
                "{}/domains",
                Self::connection_path(tenant_ref, connection_id)
            ),
            Some(&json!({ "domain": domain })),
        )
        .await?;
        self.owned(tenant_ref, connection_id).await
    }

    async fn remove_domain_inner(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        let current = self.owned(tenant_ref, connection_id).await?;
        let path = Self::domain_path(&current, domain)?;
        self.call(Method::DELETE, &path, None).await?;
        self.owned(tenant_ref, connection_id).await
    }

    async fn verify_domain_inner(
        &self,
        tenant_ref: &str,
        connection_id: &str,
        domain: &str,
    ) -> IdentityResult<SsoConnection> {
        let current = self.owned(tenant_ref, connection_id).await?;
        let path = Self::domain_path(&current, domain)?;
        self.call(Method::POST, &format!("{path}/verify"), None)
            .await?;
        let after = self.owned(tenant_ref, connection_id).await?;
        let verified = after
            .domain(domain)
            .is_some_and(|entry| entry.status == SsoDomainStatus::Verified);
        if verified {
            Ok(after)
        } else {
            Err(not_verified())
        }
    }
}

impl SsoDirectory for WeldIdSso {
    fn connections<'a>(
        &'a self,
        tenant_ref: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Vec<SsoConnection>>> {
        Box::pin(self.connections_inner(tenant_ref))
    }

    fn create_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection: &'a NewSsoConnection,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(self.create_inner(tenant_ref, connection))
    }

    fn update_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        changes: &'a SsoConnectionChanges,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(self.update_inner(tenant_ref, connection_id, changes))
    }

    fn delete_connection<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        Box::pin(self.delete_inner(tenant_ref, connection_id))
    }

    fn add_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(self.add_domain_inner(tenant_ref, connection_id, domain))
    }

    fn remove_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(self.remove_domain_inner(tenant_ref, connection_id, domain))
    }

    fn verify_domain<'a>(
        &'a self,
        tenant_ref: &'a str,
        connection_id: &'a str,
        domain: &'a str,
    ) -> BoxFuture<'a, IdentityResult<SsoConnection>> {
        Box::pin(self.verify_domain_inner(tenant_ref, connection_id, domain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_read_as_weldid_answers_them_without_the_secret() {
        let answer = json!({
            "id": "ssoc_1", "tenantRef": "ws_a", "protocol": "oidc",
            "displayName": "Entra", "issuer": "https://login.example.test/v2.0",
            "clientId": "abc", "clientSecret": "must-not-be-read", "hasClientSecret": true,
            "scopes": ["groups"], "trustEmails": true, "enabled": true, "enforceSso": false,
            "redirectUri": "https://auth.example.test/sso/ssoc_1/callback",
            "domains": [
                { "id": "ssod_1", "domain": "Acme.test", "status": "pending",
                  "recordName": "_weldsuite-sso.acme.test",
                  "recordValue": "weldsuite-sso-verification=t1", "lastCheck": null },
                { "id": "ssod_2", "domain": "acme.example", "status": "verified",
                  "verifiedAt": "2026-11-16T10:00:00Z", "lastCheck": "found",
                  "recordName": "_weldsuite-sso.acme.example",
                  "recordValue": "weldsuite-sso-verification=t2" },
                { "id": "ssod_3", "domain": "acme.org", "status": "pending", "lastCheck": "missing" },
                { "id": "ssod_4", "domain": "acme.net", "status": "suspended", "lastCheck": "missing" },
            ],
        });
        let connection = connection_of(&answer, "ws_a").expect("read");
        assert!(connection.has_client_secret);
        assert!(connection.trust_emails);
        assert!(!format!("{connection:?}").contains("must-not-be-read"));
        assert_eq!(connection.scopes, ["groups"]);
        let statuses: Vec<_> = connection.domains.iter().map(|d| d.status).collect();
        assert_eq!(
            statuses,
            [
                SsoDomainStatus::Pending,
                SsoDomainStatus::Verified,
                SsoDomainStatus::Failed,
                SsoDomainStatus::Failed,
            ]
        );
        assert_eq!(connection.domains[0].name, "acme.test");
        assert_eq!(connection.domains[0].id.as_deref(), Some("ssod_1"));
        assert_eq!(
            connection.domains[1].txt_value,
            "weldsuite-sso-verification=t2"
        );
        assert_eq!(connection.domains[2].txt_name, "_weldsuite-sso.acme.org");
        assert!(connection.has_verified_domain());
        assert_eq!(
            WeldIdSso::domain_path(&connection, "acme.org").expect("path"),
            "/admin/v1/tenants/ws_a/sso/connections/ssoc_1/domains/ssod_3"
        );
        assert!(
            WeldIdSso::domain_path(&connection, "other.test")
                .expect_err("not listed")
                .is_not_found()
        );

        assert!(connection_of(&answer, "ws_b").is_none(), "another tenant's");
        assert_eq!(connection.protocol, SsoProtocol::Oidc);
        assert_eq!(connection.saml, None);
        assert!(
            connection_of(&json!({ "id": "c", "protocol": "ldap" }), "ws_a").is_none(),
            "an unknown protocol is skipped"
        );
    }

    #[test]
    fn saml_connections_read_both_sides() {
        let answer = json!({
            "id": "ssc_2", "tenantRef": "ws_a", "protocol": "saml", "displayName": "Entra SAML",
            "issuer": null, "clientId": null, "hasClientSecret": false, "scopes": [],
            "trustEmails": true, "enabled": false, "enforceSso": false, "redirectUri": null,
            "saml": {
                "entityId": "https://auth.example.test/sso/ssc_2/saml/metadata",
                "acsUrl": "https://auth.example.test/sso/ssc_2/saml/acs",
                "metadataUrl": "https://auth.example.test/sso/ssc_2/saml/metadata",
                "idpEntityId": "https://sts.windows.net/t/",
                "idpSsoUrl": "https://login.microsoftonline.com/t/saml2",
                "idpMetadataUrl": null,
                "idpCertificates": [{ "sha256": "AB:CD", "subject": "CN=Microsoft Azure Federated SSO Certificate", "notBefore": "2026-01-01T00:00:00Z", "notAfter": "2029-01-01T00:00:00Z" }],
            },
            "domains": [],
        });
        let connection = connection_of(&answer, "ws_a").expect("read");
        assert_eq!(connection.protocol, SsoProtocol::Saml);
        assert_eq!(connection.issuer, "");
        let saml = connection.saml.expect("the SAML side");
        assert_eq!(saml.acs_url, "https://auth.example.test/sso/ssc_2/saml/acs");
        assert_eq!(
            saml.idp_entity_id.as_deref(),
            Some("https://sts.windows.net/t/")
        );
        assert_eq!(saml.idp_metadata_url, None);
        assert_eq!(saml.idp_certificates[0].sha256, "AB:CD");
        assert_eq!(
            saml.idp_certificates[0].not_after.as_deref(),
            Some("2029-01-01T00:00:00Z")
        );
    }

    #[test]
    fn saml_bodies_carry_the_metadata_and_no_oidc_fields() {
        let new = NewSsoConnection {
            protocol: SsoProtocol::Saml,
            display_name: "Google Workspace".to_owned(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret: None,
            scopes: Vec::new(),
            trust_emails: true,
            enabled: false,
            enforce_sso: false,
            saml_metadata: Some(SamlMetadata::Url(
                "https://idp.example.test/metadata.xml".to_owned(),
            )),
        };
        assert_eq!(
            create_body(&new),
            json!({
                "protocol": "saml", "displayName": "Google Workspace",
                "metadataUrl": "https://idp.example.test/metadata.xml",
                "trustEmails": true, "enabled": false, "enforceSso": false,
            })
        );
        let body = changes_body(&SsoConnectionChanges {
            saml_metadata: Some(SamlMetadata::Xml("<md:EntityDescriptor/>".to_owned())),
            ..SsoConnectionChanges::default()
        });
        assert_eq!(body, json!({ "metadataXml": "<md:EntityDescriptor/>" }));
        assert!(!format!("{:?}", SamlMetadata::Xml("<secret-ish/>".to_owned())).contains("secret"));
    }

    #[test]
    fn only_known_fields_are_sent() {
        let body = changes_body(&SsoConnectionChanges {
            enforce_sso: Some(true),
            ..SsoConnectionChanges::default()
        });
        assert_eq!(body, json!({ "enforceSso": true }));
        let body = changes_body(&SsoConnectionChanges {
            display_name: Some("Okta".to_owned()),
            client_secret: Some("new".to_owned()),
            scopes: Some(vec!["groups".to_owned()]),
            trust_emails: Some(false),
            ..SsoConnectionChanges::default()
        });
        assert_eq!(
            body,
            json!({ "displayName": "Okta", "clientSecret": "new", "scopes": ["groups"], "trustEmails": false })
        );
        let new = NewSsoConnection {
            protocol: SsoProtocol::Oidc,
            display_name: "Okta".to_owned(),
            issuer: "https://acme.okta.test".to_owned(),
            client_id: "c".to_owned(),
            client_secret: None,
            scopes: Vec::new(),
            trust_emails: false,
            enabled: false,
            enforce_sso: false,
            saml_metadata: None,
        };
        let body = create_body(&new);
        assert_eq!(body["protocol"], "oidc");
        assert!(body.get("clientSecret").is_none(), "a public client");
        assert!(body.get("tenantRef").is_none(), "the tenant is in the path");
    }
}
