//! `/api/sso` when WeldID is the identity provider (ADR SEC-019, phase 5):
//! the workspace's connection lives at WeldID, over `OpenID` Connect (5a) or
//! SAML 2.0 (5b), managed through its admin API ([`SsoDirectory`], scoped by
//! `tenant_ref` = `workspaces.id`). The paths and the view stay Global's
//! where they map; the view adds `mode: "weldid"` and an `oidc` block (named
//! for the first protocol; it holds a SAML connection too, with
//! `protocol: "saml"` and its `saml` details):
//!
//! | Route | WeldID mode |
//! |---|---|
//! | `GET /` | entitlement, the first domain as `domain`, `connection: null` (Global's Clerk SAML shape), and `oidc`: the connection (never its secret), every domain with its TXT record, the default role |
//! | `PUT /connection` | create the connection (`protocol` `oidc`: display name, issuer, client id and secret, extra scopes; `saml`: display name and the identity provider's `metadataXml` or `metadataUrl`; both: whether to trust its emails) or change it (a SAML connection takes new metadata; the protocol doesn't change: remove the connection to switch); also `enforceSso` and `defaultRole` |
//! | `DELETE /connection` | the connection and its domains |
//! | `POST /connection/activate`, `/deactivate` | `enabled`; on needs the entitlement and a verified domain |
//! | `POST /domains`, `DELETE /domains/{domain}`, `POST /domains/{domain}/verify` | the connection's domains (WeldID runs the DNS check) |
//! | `PUT /domain`, `DELETE /domain`, `POST /domain/verify` | Global's single domain: add one, and remove or verify the one `domain` shows |
//!
//! The default role is WeldSuite's (`weldsuite_db::sso_settings`, the tenant's
//! `workspace_settings`): the identity sync gives it to someone who joins
//! through the connection. Every write answers the configuration after it
//! and publishes `workspace_settings.updated` (`field: 'sso'`), with no
//! identity provider details.

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::WORKSPACE_SETTINGS_UPDATED;
use weldsuite_db::PgPool;
use weldsuite_db::sso_settings::{SSO_DEFAULT_ROLES, set_sso_default_role, sso_default_role};
use weldsuite_kit::validation::{Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_ports::{
    IdentityError, NewSsoConnection, SamlMetadata, SsoConnection, SsoConnectionChanges,
    SsoDirectory, SsoProtocol,
};

use super::{
    Context, HTTPS_URL, PUBLIC_EMAIL_DOMAINS, Workspace, WorkspaceRow, changed_meanwhile,
    domain_in_use, domain_not_verified, normalize_sso_domain, refusal, require_entitled,
};
use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, validate};

/// `mode` in the view.
const MODE: &str = "weldid";
/// The largest identity provider metadata document taken (WeldID's limit).
const MAX_METADATA_XML: usize = 256 * 1024;

// ── State ───────────────────────────────────────────────────────────────────

/// What a WeldID-mode answer is built from.
struct Loaded {
    ctx: Context,
    connection: Option<SsoConnection>,
    default_role: &'static str,
}

/// `loadSsoContext` by `workspaces.id` (the tenant WeldID knows).
async fn context_by_id(master: &PgPool, workspace_id: &str) -> PlatformResult<Context> {
    let workspace: Option<WorkspaceRow> = sqlx::query_as(
        "select id, clerk_org_id, plan_id, is_active, deleted_at is not null
         from workspaces where id = $1 limit 1",
    )
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    let Some((id, clerk_org_id, plan_id, is_active, deleted)) = workspace else {
        return Err(refusal(
            StatusCode::NOT_FOUND,
            "WORKSPACE_NOT_FOUND",
            "Workspace not found.",
        ));
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from workspace_sso s where workspace_id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(master)
    .await?;
    let plan_includes_sso = super::plan_includes_sso(master, plan_id.as_deref()).await?;
    Ok(Context {
        workspace: Workspace {
            id,
            clerk_org_id,
            is_active,
            deleted,
        },
        row: row.map(|row| super::SsoRow::from_row(&weldsuite_db::js_row(row))),
        plan_includes_sso,
    })
}

async fn load(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
) -> PlatformResult<Loaded> {
    let master = caller.master(state);
    let ctx = context_by_id(&master, &caller.workspace_id).await?;
    let connection = directory
        .connections(&ctx.workspace.id)
        .await
        .map_err(|error| failure(&error, Step::Read))?
        .into_iter()
        .next();
    let default_role = sso_default_role(&caller.db).await?;
    Ok(Loaded {
        ctx,
        connection,
        default_role,
    })
}

// ── Refusals ────────────────────────────────────────────────────────────────

/// What was being done when WeldID refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Read,
    Connection,
    AddDomain,
    RemoveDomain,
    Verify,
}

fn unavailable(error: &IdentityError, step: Step) -> PlatformError {
    tracing::error!(%error, ?step, "sso: WeldID's SSO admin API failed");
    refusal(
        StatusCode::BAD_GATEWAY,
        "SSO_PROVIDER_UNAVAILABLE",
        "Single sign-on could not be updated right now. Try again later.",
    )
}

/// WeldID's own reason for refusing the identity provider details (issuer
/// discovery failed, …), shown as Global shows Clerk's; never the body.
fn idp_rejected(error: &IdentityError) -> PlatformError {
    let message = match error {
        IdentityError::Rejected {
            message: Some(message),
            ..
        } => js_trim(message).chars().take(300).collect::<String>(),
        _ => String::new(),
    };
    let message = if message.is_empty() {
        "The identity provider details were not accepted.".to_owned()
    } else {
        message
    };
    PlatformError::api(ApiError::new(
        StatusCode::BAD_REQUEST,
        "SSO_IDP_REJECTED",
        message,
    ))
}

/// A refusal of WeldID's as the route's own.
fn failure(error: &IdentityError, step: Step) -> PlatformError {
    let IdentityError::Rejected { status, code, .. } = error else {
        return unavailable(error, step);
    };
    match (*status, code.as_deref(), step) {
        // The connection or the domain went between reading and writing.
        (404, _, Step::Connection | Step::AddDomain | Step::RemoveDomain | Step::Verify) => {
            changed_meanwhile()
        }
        // The record is there, but another workspace holds the domain verified.
        (409, Some("domain_in_use"), _) => domain_in_use(),
        // `domain_exists`, `changed_meanwhile`.
        (409, _, _) => changed_meanwhile(),
        (400 | 422, _, Step::Verify) => refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SSO_DOMAIN_NOT_VERIFIED",
            "The TXT record was not found yet. DNS changes can take a while to show up; try again later.",
        ),
        (400 | 422, _, Step::Connection) => idp_rejected(error),
        (400, Some("public_mailbox_domain"), Step::AddDomain) => refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_PUBLIC",
            "Use your company domain, not a public email provider.",
        ),
        // `invalid_domain`, `public_suffix`, too many domains.
        (400 | 422, _, Step::AddDomain) => refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_INVALID",
            "Enter a domain like acme.com.",
        ),
        // 401/403 (the client lacks `weldid:sso`), 5xx and the rest.
        _ => unavailable(error, step),
    }
}

fn connection_missing() -> PlatformError {
    refusal(
        StatusCode::CONFLICT,
        "SSO_CONNECTION_MISSING",
        "Connect your identity provider first.",
    )
}

fn domain_missing() -> PlatformError {
    refusal(
        StatusCode::CONFLICT,
        "SSO_DOMAIN_MISSING",
        "Add your domain first.",
    )
}

// ── View ────────────────────────────────────────────────────────────────────

fn domain_view(domain: &weldsuite_ports::SsoDomain) -> Value {
    let verified = domain.status == weldsuite_ports::SsoDomainStatus::Verified;
    json!({
        "name": domain.name,
        "status": domain.status.as_str(),
        "verified": verified,
        "verifiedAt": domain.verified_at,
        "checkedAt": domain.checked_at,
        "dnsRecord": { "type": "TXT", "name": domain.txt_name, "value": domain.txt_value },
    })
}

/// The configuration: Global's fields where they map, and `oidc`.
fn view(loaded: &Loaded, can_manage: bool) -> Value {
    let (entitled, source) = loaded.ctx.entitlement();
    let connection = loaded.connection.as_ref();
    let domains: Vec<Value> = connection
        .map(|c| c.domains.iter().map(domain_view).collect())
        .unwrap_or_default();
    // Global's single domain: the first one, in its shape.
    let domain = domains.first().map(|first| {
        json!({
            "name": first["name"],
            "verified": first["verified"],
            "verifiedAt": first["verifiedAt"],
            "dnsRecord": first["dnsRecord"],
        })
    });
    let oidc_connection = connection.map(|c| {
        json!({
            "id": c.id,
            "protocol": c.protocol.as_str(),
            "saml": c.saml.as_ref().map(|saml| json!({
                "entityId": saml.entity_id,
                "acsUrl": saml.acs_url,
                "metadataUrl": saml.metadata_url,
                "idpEntityId": saml.idp_entity_id,
                "idpSsoUrl": saml.idp_sso_url,
                "idpMetadataUrl": saml.idp_metadata_url,
                "idpCertificates": saml.idp_certificates.iter().map(|certificate| json!({
                    "sha256": certificate.sha256,
                    "subject": certificate.subject,
                    "notAfter": certificate.not_after,
                })).collect::<Vec<_>>(),
            })),
            "displayName": c.display_name,
            "issuer": c.issuer,
            "clientId": c.client_id,
            "hasClientSecret": c.has_client_secret,
            "scopes": c.scopes,
            "trustEmails": c.trust_emails,
            "enabled": c.enabled,
            "enforceSso": c.enforce_sso,
            // From WeldID's answer: the callback of this connection.
            "redirectUri": c.redirect_uri,
            "updatedAt": c.updated_at,
        })
    });
    let active = connection.is_some_and(|c| c.enabled && c.has_verified_domain()) && entitled;
    json!({
        "entitlement": { "entitled": entitled, "source": source },
        "domain": domain,
        "connection": Value::Null,
        "canManage": can_manage,
        "mode": MODE,
        "oidc": {
            "connection": oidc_connection,
            "domains": domains,
            "defaultRole": loaded.default_role,
            "active": active,
        },
    })
}

/// `GET /`.
pub(super) async fn show(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
) -> PlatformResult<Response> {
    let loaded = load(state, caller, directory).await?;
    Ok(Data(view(&loaded, caller.can("sso:manage"))).into_response())
}

/// After a write: the configuration as `after`, recorded as
/// `workspace_settings.updated`.
fn changed(state: &CorePlatformState, caller: &Caller, kind: &str, after: &Loaded) -> Response {
    let connection = after.connection.as_ref();
    let first = connection.and_then(|c| c.domains.first());
    let data = json!({
        "id": after.ctx.workspace.id,
        "field": "sso",
        "change": kind,
        "domain": first.map(|d| d.name.as_str()),
        "domainVerified": first.is_some_and(|d| d.status == weldsuite_ports::SsoDomainStatus::Verified),
        "provider": connection.map(|c| c.protocol.as_str()),
        "enabled": connection.is_some_and(|c| c.enabled),
        "enforceSso": connection.is_some_and(|c| c.enforce_sso),
        "defaultRole": after.default_role,
    });
    caller.publish(
        state,
        WORKSPACE_SETTINGS_UPDATED,
        &after.ctx.workspace.id,
        &data,
    );
    Data(view(after, caller.can("sso:manage"))).into_response()
}

// ── Connection ──────────────────────────────────────────────────────────────

/// An OAuth scope token (RFC 6749 §3.3): printable ASCII but space, `"`, `\`.
fn scope_token(scope: &str) -> bool {
    !scope.is_empty()
        && scope
            .bytes()
            .all(|b| matches!(b, 0x21 | 0x23..=0x5B | 0x5D..=0x7E))
}

/// The protocols `PUT /connection` takes.
const PROTOCOLS: [&str; 2] = ["oidc", "saml"];

/// `ssoOidcConnectionInputSchema`: every field optional, so a toggle sends
/// only itself; creating an `OpenID` Connect connection needs the display
/// name, issuer and client id, a SAML one the display name and the metadata.
#[derive(Debug, Default)]
struct ConnectionInput {
    protocol: Option<String>,
    /// The identity provider's metadata (SAML), uploaded or by URL.
    metadata_xml: Option<String>,
    metadata_url: Option<String>,
    display_name: Option<String>,
    issuer: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    scopes: Option<Vec<String>>,
    trust_emails: Option<bool>,
    enforce_sso: Option<bool>,
    default_role: Option<String>,
}

fn read_connection_input(issues: &mut Issues, fields: &Map<String, Value>) -> ConnectionInput {
    let display_name = issues
        .text_with(
            fields,
            "displayName",
            Presence::Optional,
            Text::trimmed(Some(1), Some(64)),
        )
        .into_option();
    let issuer_url = issues
        .text_with(fields, "issuer", Presence::Optional, HTTPS_URL)
        .into_option();
    let client_id = issues
        .text_with(
            fields,
            "clientId",
            Presence::Optional,
            Text::trimmed(Some(1), Some(512)),
        )
        .into_option();
    let client_secret = issues
        .text_with(
            fields,
            "clientSecret",
            Presence::Optional,
            Text::trimmed(Some(1), Some(1024)),
        )
        .into_option();
    let scopes = issues
        .list(
            fields,
            "scopes",
            Presence::Optional,
            None,
            Some(20),
            |issues, item| {
                issues.item_pattern(
                    item,
                    Text::trimmed(Some(1), Some(100)),
                    |raw| scope_token(js_trim(raw)),
                    "Not a valid scope",
                )
            },
        )
        .into_option();
    let trust_emails = issues
        .boolean(fields, "trustEmails", Presence::Optional)
        .into_option();
    let enforce_sso = issues
        .boolean(fields, "enforceSso", Presence::Optional)
        .into_option();
    let default_role = issues
        .choice(
            fields,
            "defaultRole",
            Presence::Optional,
            &SSO_DEFAULT_ROLES,
        )
        .into_option();
    if let Some(Value::String(text)) = fields.get("issuer")
        && !js_trim(text).starts_with("https://")
    {
        issues.custom("issuer", "Use an https:// URL");
    }
    let protocol = issues
        .choice(fields, "protocol", Presence::Optional, &PROTOCOLS)
        .into_option();
    let metadata_xml = issues
        .text_with(
            fields,
            "metadataXml",
            Presence::Optional,
            Text::trimmed(Some(1), Some(MAX_METADATA_XML)),
        )
        .into_option();
    let metadata_url = issues
        .text_with(fields, "metadataUrl", Presence::Optional, HTTPS_URL)
        .into_option();
    if let Some(Value::String(text)) = fields.get("metadataUrl")
        && !js_trim(text).starts_with("https://")
    {
        issues.custom("metadataUrl", "Use an https:// URL");
    }
    if fields.contains_key("metadataXml") && fields.contains_key("metadataUrl") {
        issues.custom("metadataUrl", "Give the metadata or its URL, not both");
    }
    ConnectionInput {
        protocol,
        metadata_xml,
        metadata_url,
        display_name,
        issuer: issuer_url,
        client_id,
        client_secret,
        scopes,
        trust_emails,
        enforce_sso,
        default_role,
    }
}

/// The connection a first `PUT /connection` creates: `OpenID` Connect from
/// the name, issuer and client id (without a secret WeldID is a public
/// client at the identity provider, PKCE only), or SAML from the name and
/// the metadata; disabled until switched on.
fn new_connection(
    input: &ConnectionInput,
    metadata: Option<SamlMetadata>,
    oidc_fields: bool,
) -> PlatformResult<NewSsoConnection> {
    let saml = input.protocol.as_deref() == Some("saml");
    let incomplete =
        |message: &'static str| refusal(StatusCode::BAD_REQUEST, "SSO_IDP_INCOMPLETE", message);
    if saml {
        let (Some(display_name), Some(metadata), false) =
            (input.display_name.clone(), metadata, oidc_fields)
        else {
            return Err(incomplete(
                "Enter the identity provider's name and its SAML metadata (a file or its URL).",
            ));
        };
        return Ok(NewSsoConnection {
            protocol: SsoProtocol::Saml,
            display_name,
            issuer: String::new(),
            client_id: String::new(),
            client_secret: None,
            scopes: Vec::new(),
            trust_emails: input.trust_emails.unwrap_or(false),
            enabled: false,
            enforce_sso: input.enforce_sso.unwrap_or(false),
            saml_metadata: Some(metadata),
        });
    }
    let (Some(display_name), Some(issuer), Some(client_id), None) = (
        input.display_name.clone(),
        input.issuer.clone(),
        input.client_id.clone(),
        metadata,
    ) else {
        return Err(incomplete(
            "Enter the identity provider's name, issuer URL and client ID.",
        ));
    };
    Ok(NewSsoConnection {
        protocol: SsoProtocol::Oidc,
        display_name,
        issuer,
        client_id,
        client_secret: input.client_secret.clone(),
        scopes: input.scopes.clone().unwrap_or_default(),
        trust_emails: input.trust_emails.unwrap_or(false),
        enabled: false,
        enforce_sso: input.enforce_sso.unwrap_or(false),
        saml_metadata: None,
    })
}

/// `PUT /connection`.
pub(super) async fn save_connection(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
    headers: &HeaderMap,
    body: &Bytes,
) -> PlatformResult<Response> {
    let input = validate(headers, body, read_connection_input)?;
    let mut loaded = load(state, caller, directory).await?;
    let tenant = loaded.ctx.workspace.id.clone();
    let oidc_fields = input.issuer.is_some()
        || input.client_id.is_some()
        || input.client_secret.is_some()
        || input.scopes.is_some();
    let metadata = match (input.metadata_xml.clone(), input.metadata_url.clone()) {
        (Some(xml), _) => Some(SamlMetadata::Xml(xml)),
        (None, Some(url)) => Some(SamlMetadata::Url(url)),
        (None, None) => None,
    };
    let identity_changes = input.display_name.is_some()
        || oidc_fields
        || metadata.is_some()
        || input.trust_emails.is_some();
    let kind = match &loaded.connection {
        None => {
            require_entitled(&loaded.ctx)?;
            let new = new_connection(&input, metadata, oidc_fields)?;
            let created = directory
                .create_connection(&tenant, &new)
                .await
                .map_err(|error| failure(&error, Step::Connection))?;
            loaded.connection = Some(created);
            "connection_created"
        }
        Some(current) => {
            // The protocol is the connection's for good: switching means
            // removing it and connecting again.
            let protocol_mismatch = match current.protocol {
                SsoProtocol::Oidc => {
                    metadata.is_some() || input.protocol.as_deref() == Some("saml")
                }
                SsoProtocol::Saml => oidc_fields || input.protocol.as_deref() == Some("oidc"),
            };
            if protocol_mismatch {
                return Err(refusal(
                    StatusCode::CONFLICT,
                    "SSO_PROTOCOL_MISMATCH",
                    "Remove the connection to switch between OpenID Connect and SAML.",
                ));
            }
            // Changing the identity provider needs the entitlement; the
            // switches and the role don't (they only narrow sign-in).
            if identity_changes {
                require_entitled(&loaded.ctx)?;
            }
            let changes = SsoConnectionChanges {
                display_name: input.display_name.clone(),
                issuer: input.issuer.clone(),
                client_id: input.client_id.clone(),
                client_secret: input.client_secret.clone(),
                scopes: input.scopes.clone(),
                trust_emails: input.trust_emails,
                enabled: None,
                enforce_sso: input.enforce_sso,
                saml_metadata: metadata,
            };
            if !changes.is_empty() {
                let updated = directory
                    .update_connection(&tenant, &current.id, &changes)
                    .await
                    .map_err(|error| failure(&error, Step::Connection))?;
                loaded.connection = Some(updated);
            }
            "connection_updated"
        }
    };
    if let Some(role) = &input.default_role {
        set_sso_default_role(&caller.db, role, &generate_id("ws")).await?;
        loaded.default_role = sso_default_role(&caller.db).await?;
    }
    Ok(changed(state, caller, kind, &loaded))
}

/// `DELETE /connection`: the connection and its domains, at WeldID.
pub(super) async fn remove_connection(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
) -> PlatformResult<Response> {
    let mut loaded = load(state, caller, directory).await?;
    if let Some(connection) = loaded.connection.take() {
        directory
            .delete_connection(&loaded.ctx.workspace.id, &connection.id)
            .await
            .map_err(|error| failure(&error, Step::Connection))?;
    }
    Ok(changed(state, caller, "connection_removed", &loaded))
}

/// `POST /connection/activate|deactivate`: on needs the entitlement and a
/// verified domain; off always works.
pub(super) async fn set_enabled(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
    enabled: bool,
) -> PlatformResult<Response> {
    let mut loaded = load(state, caller, directory).await?;
    let Some(connection) = loaded.connection.as_ref() else {
        return Err(connection_missing());
    };
    if enabled {
        require_entitled(&loaded.ctx)?;
        if !connection.has_verified_domain() {
            return Err(domain_not_verified());
        }
    }
    if connection.enabled != enabled {
        let updated = directory
            .update_connection(
                &loaded.ctx.workspace.id,
                &connection.id,
                &SsoConnectionChanges {
                    enabled: Some(enabled),
                    ..SsoConnectionChanges::default()
                },
            )
            .await
            .map_err(|error| failure(&error, Step::Connection))?;
        loaded.connection = Some(updated);
    }
    let kind = if enabled { "enabled" } else { "disabled" };
    Ok(changed(state, caller, kind, &loaded))
}

// ── Domains ─────────────────────────────────────────────────────────────────

/// `{ domain }` of `POST /domains` and `PUT /domain`.
pub(super) fn read_domain(headers: &HeaderMap, body: &Bytes) -> PlatformResult<String> {
    validate(headers, body, |issues, fields| {
        issues
            .text_with(
                fields,
                "domain",
                Presence::Required,
                Text::trimmed(Some(1), Some(300)),
            )
            .into_option()
            .unwrap_or_default()
    })
}

/// A domain as typed, normalised, or why it is refused.
fn domain_name(input: &str) -> PlatformResult<String> {
    let Some(domain) = normalize_sso_domain(input) else {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_INVALID",
            "Enter a domain like acme.com.",
        ));
    };
    if PUBLIC_EMAIL_DOMAINS.contains(&domain.as_str()) {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_PUBLIC",
            "Use your company domain, not a public email provider.",
        ));
    }
    Ok(domain)
}

/// `POST /domains` (and `PUT /domain`): the domain joins the connection,
/// pending until its TXT record is found. Adding it again changes nothing.
pub(super) async fn add_domain(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
    input: &str,
) -> PlatformResult<Response> {
    let domain = domain_name(input)?;
    let mut loaded = load(state, caller, directory).await?;
    let Some(connection) = loaded.connection.as_ref() else {
        return Err(connection_missing());
    };
    if connection.domain(&domain).is_none() {
        let updated = directory
            .add_domain(&loaded.ctx.workspace.id, &connection.id, &domain)
            .await
            .map_err(|error| failure(&error, Step::AddDomain))?;
        loaded.connection = Some(updated);
    }
    Ok(changed(state, caller, "domain_claimed", &loaded))
}

/// Which domain a route means: the one named, else (Global's single-domain
/// paths) the first, as the view's `domain` shows it.
fn pick<'c>(connection: &'c SsoConnection, name: Option<&str>) -> PlatformResult<&'c str> {
    let found = match name {
        Some(name) => {
            let name = normalize_sso_domain(name).unwrap_or_default();
            connection.domains.iter().find(|d| d.name == name)
        }
        None => connection.domains.first(),
    };
    found.map(|d| d.name.as_str()).ok_or_else(domain_missing)
}

/// `DELETE /domains/{domain}` (and `DELETE /domain`, the first). Sign-ins
/// at the domain stop going to the identity provider.
pub(super) async fn remove_domain(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
    name: Option<&str>,
) -> PlatformResult<Response> {
    let mut loaded = load(state, caller, directory).await?;
    if let Some(connection) = loaded.connection.as_ref() {
        // Global's `DELETE /domain` without a domain is a no-op too.
        if name.is_some() || !connection.domains.is_empty() {
            let domain = pick(connection, name)?.to_owned();
            let updated = directory
                .remove_domain(&loaded.ctx.workspace.id, &connection.id, &domain)
                .await
                .map_err(|error| failure(&error, Step::RemoveDomain))?;
            loaded.connection = Some(updated);
        }
    } else if name.is_some() {
        return Err(domain_missing());
    }
    Ok(changed(state, caller, "domain_removed", &loaded))
}

/// `POST /domains/{domain}/verify` (and `POST /domain/verify`, the first):
/// WeldID looks for the TXT record now.
pub(super) async fn verify_domain(
    state: &CorePlatformState,
    caller: &Caller,
    directory: &dyn SsoDirectory,
    name: Option<&str>,
) -> PlatformResult<Response> {
    let mut loaded = load(state, caller, directory).await?;
    let Some(connection) = loaded.connection.as_ref() else {
        return Err(domain_missing());
    };
    let domain = pick(connection, name)?;
    let already = connection
        .domain(domain)
        .is_some_and(|d| d.status == weldsuite_ports::SsoDomainStatus::Verified);
    if !already {
        let updated = directory
            .verify_domain(&loaded.ctx.workspace.id, &connection.id, domain)
            .await
            .map_err(|error| failure(&error, Step::Verify))?;
        loaded.connection = Some(updated);
    }
    Ok(changed(state, caller, "domain_verified", &loaded))
}

/// The plural `/domains` routes outside WeldID mode: Global has none.
pub(super) fn not_offered() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_tokens_follow_rfc_6749() {
        assert!(scope_token("groups"));
        assert!(scope_token("api://acme/.default"));
        assert!(!scope_token(""));
        assert!(!scope_token("two words"));
        assert!(!scope_token("quo\"te"));
        assert!(!scope_token("back\\slash"));
    }

    #[test]
    fn refusals_map_to_the_routes_codes() {
        let rejected = |status: u16| IdentityError::Rejected {
            status,
            code: None,
            message: Some("  Issuer discovery failed  ".to_owned()),
            body: Some("secret-bearing body".to_owned()),
        };
        let code = |error: PlatformError| match error {
            PlatformError::Response(response) => response.status(),
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        assert_eq!(
            code(failure(&rejected(422), Step::Verify)),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            code(failure(&rejected(409), Step::AddDomain)),
            StatusCode::CONFLICT
        );
        assert_eq!(
            code(failure(&rejected(400), Step::Connection)),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            code(failure(&rejected(403), Step::Read)),
            StatusCode::BAD_GATEWAY
        );
        assert_eq!(
            code(failure(
                &IdentityError::Unavailable("down".to_owned()),
                Step::Read
            )),
            StatusCode::BAD_GATEWAY
        );
    }
}
