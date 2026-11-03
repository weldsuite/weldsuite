//! The bridge between the `/v1` routes' coarse scopes and the permission
//! catalog (`lib/permissions.ts`): the check is made by the request's method,
//! so a member granted only `leads:create` cannot delete leads through an
//! assistant, and a few routes pin their own permission.

use http::Method;
use weldsuite_external_api::MemberScopeRule;
pub use weldsuite_permissions::Grants;
use weldsuite_permissions::has_app_permission;

/// Route resources whose name differs from the catalog object.
fn catalog_object(scope: &str) -> &str {
    let object = scope.split(':').next().unwrap_or_default();
    match object {
        "drive" => "files",
        "members" => "team",
        "workflows" => "helpdesk-workflows",
        "user-apps" => "weldapps",
        "goals" | "sprints" | "whiteboards" => "projects",
        "mail_accounts" | "mail_labels" | "mail_folders" => "accounts",
        "mail_messages" | "mail_drafts" | "mail_attachments" => "messages",
        other => other,
    }
}

/// Routes whose permission is not the one their method implies
/// (`ROUTE_PERMISSIONS`), by method and Hono pattern.
pub fn route_permission(method: &Method, route: Option<&str>) -> Option<&'static str> {
    let route = route?;
    ROUTE_PERMISSIONS
        .iter()
        .find(|(want_method, want_route, _)| {
            *want_method == method.as_str() && *want_route == route
        })
        .map(|(_, _, permission)| *permission)
}

/// `ROUTE_PERMISSIONS`: method, route, the permission it pins.
const ROUTE_PERMISSIONS: [(&str, &str, &str); 13] = [
    ("POST", "/v1/reach/campaigns", "reach_campaigns:create"),
    (
        "POST",
        "/v1/reach/campaigns/:id/prospects",
        "reach_campaigns:update",
    ),
    (
        "DELETE",
        "/v1/reach/campaigns/:id/enrollments/:enrollmentId",
        "reach_campaigns:update",
    ),
    (
        "POST",
        "/v1/reach/campaigns/:id/launch",
        "reach_campaigns:update",
    ),
    (
        "POST",
        "/v1/reach/campaigns/:id/pause",
        "reach_campaigns:update",
    ),
    (
        "POST",
        "/v1/reach/campaigns/:id/resume",
        "reach_campaigns:update",
    ),
    ("POST", "/v1/reach/prospects", "reach_prospects:create"),
    (
        "POST",
        "/v1/reach/prospects/import",
        "reach_prospects:create",
    ),
    ("POST", "/v1/reach/lists", "reach_prospects:create"),
    (
        "POST",
        "/v1/reach/lists/:id/members",
        "reach_prospects:update",
    ),
    (
        "POST",
        "/v1/reach/lists/:id/members/remove",
        "reach_prospects:update",
    ),
    ("POST", "/v1/reach/suppressions", "reach_settings:update"),
    (
        "DELETE",
        "/v1/reach/suppressions/:id",
        "reach_settings:update",
    ),
];

/// A scope verb outside `read`/`write` names a catalog action directly.
fn literal_verb(verb: Option<&str>) -> Option<&str> {
    match verb {
        None | Some("read" | "write") => None,
        Some(verb) => Some(verb),
    }
}

/// `hasPermission(grants, key)`: any app's grant counts (MCP has no app
/// context); wildcards and member denies as everywhere.
pub fn has_permission(grants: &Grants, key: &str) -> bool {
    has_app_permission(grants, key, None)
}

/// `canPerform(grants, scope, method, route)`: may the member run this
/// request?
pub fn can_perform(grants: &Grants, scope: &str, method: &Method, route: Option<&str>) -> bool {
    let object = catalog_object(scope);
    if object.is_empty() {
        return false;
    }
    if let Some(pinned) = route_permission(method, route) {
        return has_permission(grants, pinned);
    }
    if let Some(verb) = literal_verb(scope.split(':').nth(1)) {
        return has_permission(grants, &format!("{object}:{verb}"));
    }
    let actions: &[&str] = match method.as_str() {
        "GET" | "HEAD" => &["read"],
        "POST" => &["create", "update"],
        "PATCH" | "PUT" => &["update"],
        "DELETE" => &["delete"],
        _ => return false,
    };
    actions
        .iter()
        .any(|action| has_permission(grants, &format!("{object}:{action}")))
}

/// `canUseScope(grants, scope)`: is the tool worth offering?
pub fn can_use_scope(grants: &Grants, scope: &str) -> bool {
    let object = catalog_object(scope);
    if object.is_empty() {
        return false;
    }
    let raw_verb = scope.split(':').nth(1);
    if let Some(verb) = literal_verb(raw_verb) {
        return has_permission(grants, &format!("{object}:{verb}"));
    }
    let actions: &[&str] = if raw_verb == Some("read") {
        &["read"]
    } else {
        &["create", "update", "delete"]
    };
    actions
        .iter()
        .any(|action| has_permission(grants, &format!("{object}:{action}")))
}

/// The member's rule on `/v1` (`src/api/lib/scopes.ts`).
#[derive(Debug, Clone)]
pub struct MemberRule(pub Grants);

impl MemberScopeRule for MemberRule {
    fn require(&self, scope: &str, method: &Method, route: Option<&str>) -> Result<(), String> {
        if can_perform(&self.0, scope, method, route) {
            return Ok(());
        }
        let named = route_permission(method, route).unwrap_or(scope);
        Err(format!("Missing required permission for: {named}"))
    }

    fn holds(&self, scope: &str) -> bool {
        can_use_scope(&self.0, scope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grants(permissions: &[&str]) -> Grants {
        Grants {
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            denies: Vec::new(),
        }
    }

    #[test]
    fn methods_pick_the_action() {
        let create_only = grants(&["leads:create"]);
        assert!(can_perform(
            &create_only,
            "leads:write",
            &Method::POST,
            None
        ));
        assert!(!can_perform(
            &create_only,
            "leads:write",
            &Method::DELETE,
            None
        ));
        assert!(can_use_scope(&create_only, "leads:write"));
        assert!(!can_use_scope(&create_only, "leads:read"));
        let drive = grants(&["files:read"]);
        assert!(can_use_scope(&drive, "drive:read"));
        let update = grants(&["reach_campaigns:update"]);
        assert!(can_perform(
            &update,
            "reach_campaigns:write",
            &Method::POST,
            Some("/v1/reach/campaigns/:id/launch")
        ));
        assert!(!can_perform(
            &update,
            "reach_campaigns:write",
            &Method::POST,
            Some("/v1/reach/campaigns")
        ));
        assert!(can_use_scope(
            &grants(&["weldapps:manage"]),
            "user-apps:manage"
        ));
        assert!(can_use_scope(&grants(&["*"]), "custom-objects:read"));
    }
}
