//! The workspace step of an MCP client's sign-in, at the identity provider:
//! the port behind WeldID's tenant selection (ADR SEC-019 as amended for
//! MCP). WeldID knows people, not workspaces, so when an MCP client signs in
//! for WeldSuite's MCP server (an authorization request with an RFC 8707
//! `resource`), WeldID sends the browser to the platform's page with a
//! one-time challenge after the consent screen. The page asks which
//! workspace the connection is for, and records the answer through this
//! port; WeldID then puts it in the grant's access tokens as the `tenant`
//! claim (`workspaces.id`), which the MCP server checks against WeldSuite's
//! memberships on every request.
//!
//! | Method | WeldID admin API (scope `weldid:tenants`) |
//! |---|---|
//! | [`WorkspaceSelections::request`] | `GET /admin/v1/tenant-selections/{challenge}` |
//! | [`WorkspaceSelections::decide`] | `POST /admin/v1/tenant-selections/{challenge}` `{ decision: "allow", tenantRef }` or `{ decision: "deny" }` |
//!
//! A challenge is short-lived and single use. One that is unknown, expired,
//! already decided or whose sign-in ended reads as `None`, never as an
//! error: the person only needs to start connecting again.

use crate::{BoxFuture, IdentityResult};

/// The longest challenge the port passes on. WeldID's are far shorter.
pub const MAX_CHALLENGE_LENGTH: usize = 128;

/// Whether `challenge` can be one: 1 to [`MAX_CHALLENGE_LENGTH`] of
/// `[A-Za-z0-9_-]` (base64url with a prefix), so it is a plain path
/// segment.
pub fn is_challenge(challenge: &str) -> bool {
    !challenge.is_empty()
        && challenge.len() <= MAX_CHALLENGE_LENGTH
        && challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// The sign-in waiting for its workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceSelectionRequest {
    /// The person signing in (the token's `sub`).
    pub user_id: String,
    pub client_id: String,
    /// The client's name as the consent screen showed it (the client's own
    /// for a self-registered client).
    pub client_name: String,
    /// The host of the client's redirect URI.
    pub redirect_host: String,
    /// The resource (the MCP server URL) the client signs in for.
    pub resource: Option<String>,
    /// RFC 3339.
    pub expires_at: Option<String>,
}

/// The answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceSelectionDecision {
    /// This workspace (`workspaces.id`).
    Allow { tenant_ref: String },
    /// None: the client gets `access_denied`.
    Deny,
}

/// See the module docs. Object safe: the provider is picked at run time.
pub trait WorkspaceSelections: Send + Sync {
    /// The sign-in `challenge` belongs to, or `None` when it can't be used.
    fn request<'a>(
        &'a self,
        challenge: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Option<WorkspaceSelectionRequest>>>;

    /// Record the answer. `Some(url)`: where the browser goes on (back to the
    /// provider, which issues the client its code); `None` when the
    /// challenge can't be used.
    fn decide<'a>(
        &'a self,
        challenge: &'a str,
        decision: &'a WorkspaceSelectionDecision,
    ) -> BoxFuture<'a, IdentityResult<Option<String>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_challenge_is_one_plain_segment() {
        assert!(is_challenge("wtc_AbC-123_x"));
        assert!(is_challenge(&"a".repeat(MAX_CHALLENGE_LENGTH)));
        for challenge in [
            "",
            "a/b",
            "a..b",
            "a%2Fb",
            "a b",
            "a=",
            &"a".repeat(MAX_CHALLENGE_LENGTH + 1),
        ] {
            assert!(!is_challenge(challenge), "{challenge}");
        }
    }
}
