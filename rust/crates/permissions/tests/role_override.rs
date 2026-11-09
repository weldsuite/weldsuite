//! `resolve_permissions_with_role`: a member's permissions with another role
//! in place of their workspace role (a legal entity's per-entity role).
// The fakes answer synchronously; the trait is async for the database.
#![allow(clippy::unused_async_trait_impl)]

use std::convert::Infallible;

use weldsuite_permissions::{
    MemberRow, PermissionQueries, resolve_effective_permissions, resolve_permissions_with_role,
};

struct Members;

impl PermissionQueries for Members {
    type Error = Infallible;

    async fn get_member(&self, user_id: &str) -> Result<Option<MemberRow>, Infallible> {
        let member = |role: &str, member_type: &str| MemberRow {
            id: format!("wm_{user_id}"),
            role: role.to_owned(),
            role_id: None,
            permissions: Some(vec!["invoices:create".to_owned()]),
            permission_denies: Some(vec!["invoices:delete".to_owned()]),
            member_type: Some(member_type.to_owned()),
        };
        Ok(match user_id {
            "u_member" => Some(member("MEMBER", "INTERNAL")),
            "u_owner" => Some(member("OWNER", "INTERNAL")),
            "u_employee" => Some(member("MEMBER", "EMPLOYEE")),
            _ => None,
        })
    }

    async fn get_role_permissions(&self, role_id: &str) -> Result<Option<Vec<String>>, Infallible> {
        Ok((role_id == "role_viewer").then(|| vec!["invoices:read".to_owned()]))
    }

    async fn get_team_permissions(&self, _: &str) -> Result<Vec<Vec<String>>, Infallible> {
        Ok(vec![vec!["bills:read".to_owned()]])
    }
}

#[tokio::test]
async fn the_role_is_swapped_and_extras_teams_and_denies_are_kept() {
    let Ok(resolved) = resolve_permissions_with_role(&Members, "u_member", "role_viewer").await;
    assert_eq!(
        resolved.permissions,
        ["invoices:read", "bills:read", "invoices:create"]
    );
    assert_eq!(resolved.denies, ["invoices:delete"]);
    assert_eq!(resolved.role, "MEMBER");
    assert_eq!(resolved.role_id.as_deref(), Some("role_viewer"));
    assert!(!resolved.is_owner);
}

#[tokio::test]
async fn an_owner_acts_as_admin_with_the_role() {
    let Ok(resolved) = resolve_permissions_with_role(&Members, "u_owner", "role_viewer").await;
    assert!(!resolved.is_owner);
    assert_eq!(resolved.role, "ADMIN");
    assert!(resolved.permissions.contains(&"invoices:read".to_owned()));
    assert!(!resolved.permissions.contains(&"*".to_owned()));
}

#[tokio::test]
async fn an_employee_keeps_the_fixed_set_and_strangers_get_nothing() {
    let Ok(with_role) = resolve_permissions_with_role(&Members, "u_employee", "role_viewer").await;
    let Ok(workspace) = resolve_effective_permissions(&Members, "u_employee").await;
    assert_eq!(with_role.permissions, workspace.permissions);
    let Ok(nobody) = resolve_permissions_with_role(&Members, "u_nobody", "role_viewer").await;
    assert_eq!(nobody.permissions, Vec::<String>::new());
    assert_eq!(nobody.role, "");
}
