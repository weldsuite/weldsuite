//! A member's effective permissions (`server/resolver.ts`):
//!
//! ```text
//! permissions = role ∪ teams ∪ member extras      (an OWNER: ["*"];
//!                                                   an EMPLOYEE: the fixed set)
//! denies      = member denies, applied at check time; a deny always wins
//! ```
//!
//! The lookups are a trait, so the resolver knows nothing about the database;
//! `weldsuite-db` implements it against the tenant database.

use std::collections::HashSet;
use std::future::Future;

use serde::Serialize;
use weldsuite_catalogs::permissions;

use crate::app_scope::PermissionSubject;

/// The `workspace_members` columns the resolver reads, for an ACTIVE,
/// non-deleted member.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemberRow {
    pub id: String,
    pub role: String,
    pub role_id: Option<String>,
    /// Per-member extra grants.
    pub permissions: Option<Vec<String>>,
    pub permission_denies: Option<Vec<String>>,
    /// `INTERNAL`, `EXTERNAL_GUEST` or `EMPLOYEE`.
    pub member_type: Option<String>,
}

/// The lookups behind [`resolve_effective_permissions`] (`PermissionDbQuery`).
pub trait PermissionQueries: Send + Sync {
    type Error: std::fmt::Display + Send;

    /// The ACTIVE, non-deleted member for a user, if any.
    fn get_member(
        &self,
        user_id: &str,
    ) -> impl Future<Output = Result<Option<MemberRow>, Self::Error>> + Send;

    /// A non-deleted role's permissions, through
    /// [`crate::role_row_permissions`].
    fn get_role_permissions(
        &self,
        role_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<String>>, Self::Error>> + Send;

    /// The non-empty permission lists of the member's non-deleted teams.
    fn get_team_permissions(
        &self,
        member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, Self::Error>> + Send;
}

/// A member's resolved access; the JSON shape of `ResolvedPermissions`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPermissions {
    /// Grants, wildcards included, without duplicates.
    pub permissions: Vec<String>,
    /// Per-member denies; a deny always wins.
    pub denies: Vec<String>,
    /// The member's role name; empty when the user is not a member.
    pub role: String,
    pub role_id: Option<String>,
    pub is_owner: bool,
}

impl PermissionSubject for ResolvedPermissions {
    fn permissions(&self) -> &[String] {
        &self.permissions
    }

    fn denies(&self) -> &[String] {
        &self.denies
    }
}

/// Resolve a user's effective permissions (`resolveEffectivePermissions`).
pub async fn resolve_effective_permissions<Q: PermissionQueries + ?Sized>(
    queries: &Q,
    user_id: &str,
) -> Result<ResolvedPermissions, Q::Error> {
    let Some(member) = queries.get_member(user_id).await? else {
        return Ok(ResolvedPermissions::default());
    };

    // The owner can never be restricted, so no denies.
    if member.role == "OWNER" {
        return Ok(ResolvedPermissions {
            permissions: vec!["*".to_owned()],
            denies: Vec::new(),
            role: member.role,
            role_id: member.role_id,
            is_owner: true,
        });
    }

    let denies = member.permission_denies.unwrap_or_default();

    // EMPLOYEE members get a fixed set; their role, teams and extras are
    // ignored so nothing widens them by accident. Denies still apply.
    if member.member_type.as_deref() == Some("EMPLOYEE") {
        return Ok(ResolvedPermissions {
            permissions: permissions().employee_member_permissions.clone(),
            denies,
            role: member.role,
            role_id: member.role_id,
            is_owner: false,
        });
    }

    let role_permissions = match &member.role_id {
        Some(role_id) => queries
            .get_role_permissions(role_id)
            .await?
            .unwrap_or_default(),
        None => permissions()
            .system_roles
            .get(&member.role)
            .map(|role| role.permissions.clone())
            .unwrap_or_default(),
    };
    let team_permissions = queries.get_team_permissions(&member.id).await?;

    let mut seen = HashSet::new();
    let merged = role_permissions
        .into_iter()
        .chain(team_permissions.into_iter().flatten())
        .chain(member.permissions.unwrap_or_default())
        .filter(|key| seen.insert(key.clone()))
        .collect();

    Ok(ResolvedPermissions {
        permissions: merged,
        denies,
        role: member.role,
        role_id: member.role_id,
        is_owner: false,
    })
}
