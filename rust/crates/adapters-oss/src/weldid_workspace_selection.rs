//! WeldID's tenant selection behind the [`WorkspaceSelections`] port: the
//! workspace step of an MCP client's sign-in (ADR SEC-019 as amended for
//! MCP). It rides on [`WeldIdIdentity`]'s admin client: the same
//! `private_key_jwt` token, which also asks for `weldid:tenants`.
//!
//! | Port call | Request |
//! |---|---|
//! | `request` | `GET /admin/v1/tenant-selections/{challenge}` → `{ userId, clientId, clientName, redirectHost, resource, expiresAt }` |
//! | `decide` | `POST /admin/v1/tenant-selections/{challenge}` `{ decision: "allow", tenantRef }` or `{ decision: "deny" }` → `{ redirectTo }` |
//!
//! WeldID answers 404 for a challenge that is unknown, expired, already
//! decided or whose sign-in ended; the adapter reads that as `None`. A
//! challenge that can't be a path segment is never sent.

use std::sync::Arc;

use reqwest::Method;
use serde_json::{Value, json};
use weldsuite_ports::workspace_selection::is_challenge;
use weldsuite_ports::{
    BoxFuture, IdentityError, IdentityResult, WorkspaceSelectionDecision,
    WorkspaceSelectionRequest, WorkspaceSelections,
};

use crate::weldid::{WeldIdIdentity, field};

/// Where the admin routes are: `{prefix}/{challenge}`.
pub const WELDID_TENANT_SELECTIONS_PATH: &str = "/admin/v1/tenant-selections";

/// The [`WorkspaceSelections`] port on WeldID's admin API.
pub struct WeldIdWorkspaceSelections {
    weldid: Arc<WeldIdIdentity>,
}

impl std::fmt::Debug for WeldIdWorkspaceSelections {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WeldIdWorkspaceSelections")
            .field("weldid", &self.weldid)
            .finish()
    }
}

/// The sign-in as WeldID answers it; `None` without a user or client.
fn request_of(answer: &Value) -> Option<WorkspaceSelectionRequest> {
    let text = |names: &[&str]| field(answer, names).map(str::to_owned);
    let client_id = text(&["clientId", "client_id"])?;
    Some(WorkspaceSelectionRequest {
        user_id: text(&["userId", "user_id"])?,
        client_name: text(&["clientName", "client_name"]).unwrap_or_else(|| client_id.clone()),
        client_id,
        redirect_host: text(&["redirectHost", "redirect_host"]).unwrap_or_default(),
        resource: text(&["resource"]),
        expires_at: text(&["expiresAt", "expires_at"]),
    })
}

/// The body of a decision.
fn decision_body(decision: &WorkspaceSelectionDecision) -> Value {
    match decision {
        WorkspaceSelectionDecision::Allow { tenant_ref } => {
            json!({ "decision": "allow", "tenantRef": tenant_ref })
        }
        WorkspaceSelectionDecision::Deny => json!({ "decision": "deny" }),
    }
}

/// A 404 is a challenge that can't be used, not a failure.
fn unless_not_found<T>(result: IdentityResult<T>) -> IdentityResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(IdentityError::Rejected { status: 404, .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

impl WeldIdWorkspaceSelections {
    pub fn new(weldid: Arc<WeldIdIdentity>) -> Self {
        Self { weldid }
    }

    async fn request_inner(
        &self,
        challenge: &str,
    ) -> IdentityResult<Option<WorkspaceSelectionRequest>> {
        if !is_challenge(challenge) {
            return Ok(None);
        }
        let path = format!("{WELDID_TENANT_SELECTIONS_PATH}/{challenge}");
        let answer = unless_not_found(self.weldid.admin(Method::GET, &path, &[], None).await)?;
        match answer {
            None => Ok(None),
            Some(answer) => request_of(&answer).map(Some).ok_or_else(|| {
                IdentityError::Unavailable("WeldID tenant selection without a user".to_owned())
            }),
        }
    }

    async fn decide_inner(
        &self,
        challenge: &str,
        decision: &WorkspaceSelectionDecision,
    ) -> IdentityResult<Option<String>> {
        if !is_challenge(challenge) {
            return Ok(None);
        }
        let path = format!("{WELDID_TENANT_SELECTIONS_PATH}/{challenge}");
        let body = decision_body(decision);
        let answer = unless_not_found(
            self.weldid
                .admin(Method::POST, &path, &[], Some(&body))
                .await,
        )?;
        match answer {
            None => Ok(None),
            Some(answer) => field(&answer, &["redirectTo", "redirect_to"])
                .map(|url| Some(url.to_owned()))
                .ok_or_else(|| {
                    IdentityError::Unavailable(
                        "WeldID tenant selection answered no redirectTo".to_owned(),
                    )
                }),
        }
    }
}

impl WorkspaceSelections for WeldIdWorkspaceSelections {
    fn request<'a>(
        &'a self,
        challenge: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Option<WorkspaceSelectionRequest>>> {
        Box::pin(self.request_inner(challenge))
    }

    fn decide<'a>(
        &'a self,
        challenge: &'a str,
        decision: &'a WorkspaceSelectionDecision,
    ) -> BoxFuture<'a, IdentityResult<Option<String>>> {
        Box::pin(self.decide_inner(challenge, decision))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sign_in_reads_as_weldid_answers_it() {
        let answer = json!({
            "userId": "usr_1", "clientId": "https://claude.ai/oauth/mcp-oauth-client-metadata",
            "clientName": "Claude", "redirectHost": "claude.ai",
            "resource": "https://mcp.example.eu/mcp", "expiresAt": "2026-11-24T10:10:00Z",
        });
        assert_eq!(
            request_of(&answer),
            Some(WorkspaceSelectionRequest {
                user_id: "usr_1".to_owned(),
                client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata".to_owned(),
                client_name: "Claude".to_owned(),
                redirect_host: "claude.ai".to_owned(),
                resource: Some("https://mcp.example.eu/mcp".to_owned()),
                expires_at: Some("2026-11-24T10:10:00Z".to_owned()),
            })
        );
        // No name: the client id stands in. No user: unusable.
        let unnamed = request_of(&json!({ "userId": "usr_1", "clientId": "dcr_1" })).expect("read");
        assert_eq!(unnamed.client_name, "dcr_1");
        assert_eq!(request_of(&json!({ "clientId": "dcr_1" })), None);
    }

    #[test]
    fn decisions_are_sent_as_weldid_takes_them() {
        assert_eq!(
            decision_body(&WorkspaceSelectionDecision::Allow {
                tenant_ref: "ws_1".to_owned()
            }),
            json!({ "decision": "allow", "tenantRef": "ws_1" })
        );
        assert_eq!(
            decision_body(&WorkspaceSelectionDecision::Deny),
            json!({ "decision": "deny" })
        );
    }

    #[test]
    fn only_a_404_reads_as_an_unusable_challenge() {
        let rejected = |status| IdentityError::Rejected {
            status,
            code: None,
            message: None,
            body: None,
        };
        assert_eq!(unless_not_found::<u8>(Err(rejected(404))), Ok(None));
        assert!(unless_not_found::<u8>(Err(rejected(403))).is_err());
        assert_eq!(unless_not_found(Ok(1_u8)), Ok(Some(1)));
    }
}
