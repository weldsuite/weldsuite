//! The `auth` block `/config.json` sends with an OIDC provider (ADR SEC-012,
//! self-hosted plan E2): what the platform and the mobile apps sign in with
//! (`packages/clients/app-api-client/src/schemas/runtime-config.ts`).
//!
//! | Field | Claim mode (Zitadel) | Header mode (WeldID, a customer's own provider) |
//! |---|---|---|
//! | `scopes` | `openid profile email offline_access urn:zitadel:iam:org:projects:roles` | `openid profile email offline_access` |
//! | `audienceScope` | `urn:zitadel:iam:org:project:id:{audience}:aud` | `null` (none) |
//! | `organizationScope` | `urn:zitadel:iam:org:roles:id:{orgId}` | `null` (none: switching workspace never signs in again) |
//! | `accountUrl` | `null` | WeldID: `{issuer}/account`; otherwise `null` |
//! | `identityProvider` | `null` | WeldID: `weldid`; otherwise `null` |
//! | `workspaceSource` | `claim` | `header`: every request names its workspace in `X-Weld-Workspace` |
//! | `orgClaim` | `OIDC_ORG_CLAIM` | `null`: no claim names the workspace |
//!
//! Either mode: `clientId`, `mobileClientId` and `desktopClientId` are the
//! platform's, the mobile apps' and the desktop app's clients
//! (`OIDC_WEB_CLIENT_ID`, `OIDC_MOBILE_CLIENT_ID`, `OIDC_DESKTOP_CLIENT_ID`).
//!
//! The claim mode values are the ones the clients used before the server
//! sent any (`DEFAULT_OIDC_SCOPES`, `ZITADEL_AUDIENCE_SCOPE` and
//! `ZITADEL_ORG_ROLES_SCOPE` in `oidc-claims.ts`), so a Zitadel install signs
//! in as before. `null` means "no such scope"; a client that finds the field
//! missing falls back to Zitadel's.

use serde_json::{Value, json};
use weldsuite_auth::{OidcSettings, WorkspaceSource};

/// The scopes every OIDC sign-in asks for.
pub(crate) const OIDC_SCOPES: [&str; 4] = ["openid", "profile", "email", "offline_access"];
/// Zitadel's scope for the project roles claim, which names the workspaces.
pub(crate) const ZITADEL_ROLES_SCOPE: &str = "urn:zitadel:iam:org:projects:roles";
/// Zitadel's scope that puts the project (the audience) in `aud`.
pub(crate) const ZITADEL_AUDIENCE_SCOPE: &str = "urn:zitadel:iam:org:project:id:{audience}:aud";
/// Zitadel's scope that narrows the roles claim to the active workspace.
pub(crate) const ZITADEL_ORGANIZATION_SCOPE: &str = "urn:zitadel:iam:org:roles:id:{orgId}";

/// Everything the block says about an OIDC sign-in.
pub(crate) struct OidcClients<'a> {
    pub(crate) settings: &'a OidcSettings,
    /// `OIDC_WEB_CLIENT_ID`.
    pub(crate) web_client_id: Option<&'a str>,
    /// `OIDC_MOBILE_CLIENT_ID`.
    pub(crate) mobile_client_id: Option<&'a str>,
    /// `OIDC_DESKTOP_CLIENT_ID`: the desktop app, which signs in through the
    /// system browser with a loopback redirect (RFC 8252).
    pub(crate) desktop_client_id: Option<&'a str>,
    /// `OIDC_SIGN_IN=platform`.
    pub(crate) platform_sign_in: bool,
    /// `IDENTITY_PROVIDER=weldid`: WeldID's account pages exist.
    pub(crate) weldid: bool,
}

/// The `auth` block of `/config.json`.
pub(crate) fn oidc_public_auth(clients: &OidcClients<'_>) -> Value {
    let settings = clients.settings;
    let header = settings.workspace_source == WorkspaceSource::Header;
    let scopes: Vec<&str> = if header {
        OIDC_SCOPES.to_vec()
    } else {
        OIDC_SCOPES
            .iter()
            .copied()
            .chain([ZITADEL_ROLES_SCOPE])
            .collect()
    };
    let zitadel_scope = |scope: &str| {
        if header { Value::Null } else { json!(scope) }
    };
    let account_url = clients
        .weldid
        .then(|| format!("{}/account", settings.issuer.trim_end_matches('/')));
    let mut public = json!({
        "provider": "oidc",
        "issuer": settings.issuer,
        "clientId": clients.web_client_id,
        // The mobile apps' native client (weldsuite-documentation/plans/mobile-server-choice.md).
        "mobileClientId": clients.mobile_client_id,
        // The desktop app's native client (apps/desktop/docs/auth-handoff.md).
        "desktopClientId": clients.desktop_client_id,
        "audience": settings.audiences.first(),
        // Header mode reads no organization claim.
        "orgClaim": (!header).then_some(settings.org_claim.as_str()),
        "scopes": scopes,
        "audienceScope": zitadel_scope(ZITADEL_AUDIENCE_SCOPE),
        "organizationScope": zitadel_scope(ZITADEL_ORGANIZATION_SCOPE),
        "accountUrl": account_url,
        // WeldSuite's own provider: the platform says the account lives in
        // WeldID, not with "your organization's identity provider".
        "identityProvider": clients.weldid.then_some("weldid"),
        "workspaceSource": settings.workspace_source.as_str(),
    });
    if clients.platform_sign_in {
        // The platform shows its own sign-in screens (ADR SEC-016).
        public["signIn"] = json!("platform");
    }
    public
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(source: WorkspaceSource) -> OidcSettings {
        OidcSettings {
            workspace_source: source,
            ..OidcSettings::new("https://auth.eu.example/", vec!["300100".to_owned()])
        }
    }

    #[test]
    fn claim_mode_sends_zitadels_scopes_as_the_clients_default_to() {
        let settings = settings(WorkspaceSource::Claim);
        let public = oidc_public_auth(&OidcClients {
            settings: &settings,
            web_client_id: Some("300300"),
            mobile_client_id: None,
            desktop_client_id: None,
            platform_sign_in: true,
            weldid: false,
        });
        assert_eq!(
            public,
            json!({
                "provider": "oidc",
                "issuer": "https://auth.eu.example/",
                "clientId": "300300",
                "mobileClientId": null,
                "desktopClientId": null,
                "audience": "300100",
                "orgClaim": "urn:zitadel:iam:org:id",
                "scopes": ["openid", "profile", "email", "offline_access", "urn:zitadel:iam:org:projects:roles"],
                "audienceScope": "urn:zitadel:iam:org:project:id:{audience}:aud",
                "organizationScope": "urn:zitadel:iam:org:roles:id:{orgId}",
                "accountUrl": null,
                "identityProvider": null,
                "workspaceSource": "claim",
                "signIn": "platform",
            })
        );
    }

    #[test]
    fn weldid_names_no_scopes_beyond_oidcs_and_its_account_pages() {
        let settings = settings(WorkspaceSource::Header);
        let public = oidc_public_auth(&OidcClients {
            settings: &settings,
            web_client_id: Some("weldsuite-web"),
            mobile_client_id: Some("weldsuite-mobile"),
            desktop_client_id: Some("weldsuite-desktop"),
            platform_sign_in: false,
            weldid: true,
        });
        assert_eq!(
            public["scopes"],
            json!(["openid", "profile", "email", "offline_access"])
        );
        assert_eq!(public["audienceScope"], Value::Null);
        assert_eq!(public["organizationScope"], Value::Null);
        assert_eq!(public["orgClaim"], Value::Null);
        assert_eq!(public["accountUrl"], "https://auth.eu.example/account");
        assert_eq!(public["identityProvider"], "weldid");
        assert_eq!(public["workspaceSource"], "header");
        assert_eq!(public["desktopClientId"], "weldsuite-desktop");
        assert!(public.get("signIn").is_none());

        // A customer's own provider in membership mode: no account pages.
        let byo = oidc_public_auth(&OidcClients {
            settings: &settings,
            web_client_id: None,
            mobile_client_id: None,
            desktop_client_id: None,
            platform_sign_in: false,
            weldid: false,
        });
        assert_eq!(byo["accountUrl"], Value::Null);
        assert_eq!(byo["identityProvider"], Value::Null);
        assert_eq!(byo["workspaceSource"], "header");
    }
}
