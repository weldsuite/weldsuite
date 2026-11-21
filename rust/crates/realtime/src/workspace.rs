//! The workspace of a socket in membership mode (`OIDC_WORKSPACE_SOURCE=header`).
//!
//! There the identity provider only authenticates: the token names no
//! workspace, and an API request names it in `X-Weld-Workspace`
//! (`weldsuite_db::membership`). A browser can't set a header on a
//! WebSocket, so a socket names it in its URL instead, `?workspace=`, with
//! the references the header takes (`workspaces.id`, the organization id,
//! the slug). The gateway checks the membership the way the header
//! middleware does and fills the session's organization from it, so every
//! gate behind it works as in claim mode:
//!
//! | Socket | Workspace |
//! |---|---|
//! | `?workspace=` a workspace the user is an active member of | that one |
//! | `?workspace=` anything else (not a member, no such workspace, unusable) | 403, as unknown and foreign workspaces answer alike |
//! | no `?workspace=` | the support room's path, else the user's one workspace when they have exactly one, else none (401 "No organization in token") |
//!
//! A deployment in claim mode has no [`WorkspaceChooser`], and a token that
//! names its organization keeps it: the parameter is never read there.

use weldsuite_db::{SoleWorkspace, WorkspaceSelector};
use weldsuite_ports::BoxFuture;

use crate::directory::DirectoryError;

/// The query parameter a socket names its workspace in.
pub const WORKSPACE_PARAM: &str = "workspace";

/// The longest reference a socket may name (the columns are 255 wide).
const MAX_REFERENCE: usize = 255;

/// Which workspace a session without an organization may use.
pub trait WorkspaceChooser: Send + Sync + 'static {
    /// The organization reference (`clerk_org_id`, else `id`) of the live
    /// workspace `reference` names when `user` is an active member of it;
    /// `None` otherwise.
    fn member_workspace<'a>(
        &'a self,
        user: &'a str,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, DirectoryError>>;

    /// The user's one workspace, when they are an active member of exactly
    /// one; `None` for none or several.
    fn sole_workspace<'a>(
        &'a self,
        user: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, DirectoryError>>;
}

impl WorkspaceChooser for WorkspaceSelector {
    fn member_workspace<'a>(
        &'a self,
        user: &'a str,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, DirectoryError>> {
        Box::pin(async move {
            self.resolve(user, reference)
                .await
                .map_err(|error| DirectoryError::Failed(error.to_string()))
        })
    }

    fn sole_workspace<'a>(
        &'a self,
        user: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, DirectoryError>> {
        Box::pin(async move {
            match WorkspaceSelector::sole_workspace(self, user).await {
                Ok(SoleWorkspace::One(org)) => Ok(Some(org)),
                Ok(SoleWorkspace::None | SoleWorkspace::Several) => Ok(None),
                Err(error) => Err(DirectoryError::Failed(error.to_string())),
            }
        })
    }
}

/// A reference as a socket may name one: trimmed, non-empty, at most 255
/// bytes of visible ASCII (the header's rules). `Err(())` for one that is
/// there but unusable; `Ok(None)` for an empty one.
pub(crate) fn workspace_reference(text: &str) -> Result<Option<&str>, ()> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > MAX_REFERENCE || !text.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(());
    }
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_follow_the_header_rules() {
        assert_eq!(workspace_reference("  ws_a "), Ok(Some("ws_a")));
        assert_eq!(workspace_reference("acme-inc"), Ok(Some("acme-inc")));
        assert_eq!(workspace_reference("   "), Ok(None));
        assert_eq!(workspace_reference("ws a"), Err(()));
        assert_eq!(workspace_reference("wé"), Err(()));
        assert_eq!(workspace_reference(&"w".repeat(256)), Err(()));
        assert_eq!(
            workspace_reference(&"w".repeat(255)).map(|r| r.map(str::len)),
            Ok(Some(255))
        );
    }
}
