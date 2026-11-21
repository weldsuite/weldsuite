//! Per-entity access (`access.ts`; "Per-entity access" in
//! `weldsuite-documentation/plans/legal-entities.md`).
//!
//! Who sees a legal entity, and which role they act with inside it:
//!
//! ```text
//! owner, or holds `legal_entities:manage` → every entity, workspace role
//! has a `legal_entity_members` row        → that entity, the row's role
//!                                           (null = workspace role)
//! no row, entity not restricted           → that entity, workspace role
//! no row, entity restricted               → not visible
//! ```
//!
//! One snapshot per request ([`load_entity_access`]), loaded with a single
//! query and computed from the member's WORKSPACE permissions, before any
//! entity role is swapped in.

use std::collections::HashMap;

use serde::Serialize;
use sqlx::PgPool;
use weldsuite_catalogs::permission_keys;
use weldsuite_db::TenantPermissionQueries;
use weldsuite_permissions::{PermissionQueries, ResolvedPermissions, check_app_permission};

/// The permission that sees every entity and manages who sees which.
pub const LEGAL_ENTITIES_MANAGE: &str = permission_keys::LEGAL_ENTITIES_MANAGE;

/// The member's standing on one live entity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityAccessEntry {
    pub restricted: bool,
    /// The member's row on this entity (`Some(role_id)`, the role being
    /// `None` for "their workspace role"), or `None` when they have none.
    pub member: Option<Option<String>>,
}

/// One row the loader reads: a live entity and the member's row on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityAccessRow {
    pub id: String,
    pub access_restricted: bool,
    pub is_member: bool,
    pub member_role_id: Option<String>,
}

impl EntityAccessRow {
    /// A row for tests and callers that build a snapshot by hand.
    pub fn new(
        id: &str,
        access_restricted: bool,
        is_member: bool,
        member_role_id: Option<&str>,
    ) -> Self {
        Self {
            id: id.to_owned(),
            access_restricted,
            is_member,
            member_role_id: member_role_id.map(str::to_owned),
        }
    }
}

/// Where the caller's access to an entity comes from (`LegalEntityAccessSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntityAccessSource {
    Owner,
    Manager,
    Member,
    Open,
}

impl EntityAccessSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Manager => "manager",
            Self::Member => "member",
            Self::Open => "open",
        }
    }
}

/// A member's access to the workspace's entities (`EntityAccess`).
#[derive(Debug, Clone)]
pub struct EntityAccess {
    pub user_id: String,
    pub is_owner: bool,
    /// Owner or `legal_entities:manage`: every entity, with the workspace role.
    pub sees_all: bool,
    /// Access is the same in every entity (sees all, or no restricted entity
    /// and no entity role): record checks can pass without comparing entities.
    pub uniform: bool,
    /// The member's workspace permissions, before any entity role swap.
    pub workspace_permissions: ResolvedPermissions,
    /// Live entities, in the order the loader read them.
    entities: Vec<(String, EntityAccessEntry)>,
    index: HashMap<String, usize>,
}

impl EntityAccess {
    /// The member's standing on a live entity; `None` for an unknown or
    /// deleted id.
    pub fn entry(&self, entity_id: &str) -> Option<&EntityAccessEntry> {
        self.index
            .get(entity_id)
            .and_then(|&at| self.entities.get(at))
            .map(|(_, entry)| entry)
    }

    /// Every live entity of the workspace with the member's standing on it
    /// (`access.entities`), visible or not.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &EntityAccessEntry)> {
        self.entities.iter().map(|(id, entry)| (id.as_str(), entry))
    }

    /// Ids of every live entity, visible or not (`access.entities.keys()`).
    pub fn entity_ids(&self) -> impl Iterator<Item = &str> {
        self.entities.iter().map(|(id, _)| id.as_str())
    }
}

/// Pure: build the snapshot from the rows the loader reads (`buildEntityAccess`).
pub fn build_entity_access(
    user_id: &str,
    workspace_permissions: ResolvedPermissions,
    rows: impl IntoIterator<Item = EntityAccessRow>,
) -> EntityAccess {
    let is_owner = workspace_permissions.is_owner;
    // Workspace-level key (registered in no app), deny-aware.
    let sees_all = is_owner
        || check_app_permission(&workspace_permissions, LEGAL_ENTITIES_MANAGE, None).allowed;
    let mut entities: Vec<(String, EntityAccessEntry)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut any_restricted = false;
    let mut any_role = false;
    for row in rows {
        if row.access_restricted {
            any_restricted = true;
        }
        if row.is_member
            && row
                .member_role_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
        {
            any_role = true;
        }
        let entry = EntityAccessEntry {
            restricted: row.access_restricted,
            member: row.is_member.then_some(row.member_role_id),
        };
        // A Map: a repeated id keeps its first position and its last value.
        if let Some(&at) = index.get(&row.id) {
            if let Some(slot) = entities.get_mut(at) {
                slot.1 = entry;
            }
        } else {
            index.insert(row.id.clone(), entities.len());
            entities.push((row.id, entry));
        }
    }
    EntityAccess {
        user_id: user_id.to_owned(),
        is_owner,
        sees_all,
        uniform: sees_all || (!any_restricted && !any_role),
        workspace_permissions,
        entities,
        index,
    }
}

/// Whether the member sees this entity at all (`canSeeEntity`). Unknown or
/// deleted ids are never visible.
pub fn can_see_entity(access: &EntityAccess, entity_id: Option<&str>) -> bool {
    let Some(entity_id) = entity_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    let Some(entry) = access.entry(entity_id) else {
        return false;
    };
    if access.sees_all {
        return true;
    }
    entry.member.is_some() || !entry.restricted
}

/// The role the member acts with inside a visible entity (`entityRoleId`): a
/// `roles.id`, or `None` for their workspace role. Owners and managers always
/// keep their workspace role.
pub fn entity_role_id<'a>(access: &'a EntityAccess, entity_id: Option<&str>) -> Option<&'a str> {
    let entity_id = entity_id.filter(|id| !id.is_empty())?;
    if access.sees_all {
        return None;
    }
    access
        .entry(entity_id)
        .and_then(|entry| entry.member.as_ref())
        .and_then(Option::as_deref)
        .filter(|id| !id.is_empty())
}

/// `entityAccessSource`.
pub fn entity_access_source(access: &EntityAccess, entity_id: &str) -> EntityAccessSource {
    if access.is_owner {
        return EntityAccessSource::Owner;
    }
    if access.sees_all {
        return EntityAccessSource::Manager;
    }
    if access
        .entry(entity_id)
        .is_some_and(|entry| entry.member.is_some())
    {
        EntityAccessSource::Member
    } else {
        EntityAccessSource::Open
    }
}

/// Ids of every entity the member sees (`visibleEntityIds`), in load order.
pub fn visible_entity_ids(access: &EntityAccess) -> Vec<String> {
    access
        .entity_ids()
        .filter(|id| can_see_entity(access, Some(id)))
        .map(str::to_owned)
        .collect()
}

/// Load the snapshot (`loadEntityAccess`). One query: the live entities
/// left-joined with the member's rows.
pub async fn load_entity_access(
    db: &PgPool,
    user_id: &str,
    workspace_permissions: ResolvedPermissions,
) -> Result<EntityAccess, sqlx::Error> {
    let rows: Vec<(String, bool, bool, Option<String>)> = sqlx::query_as(
        "select e.id, e.access_restricted, m.id is not null, m.role_id
         from entities e
         left join legal_entity_members m on m.entity_id = e.id and m.user_id = $1
         where e.deleted_at is null",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(build_entity_access(
        user_id,
        workspace_permissions,
        rows.into_iter()
            .map(
                |(id, access_restricted, is_member, member_role_id)| EntityAccessRow {
                    id,
                    access_restricted,
                    is_member,
                    member_role_id,
                },
            ),
    ))
}

/// The member's permissions as if their workspace role were `role_id`
/// (`resolvePermissionsWithRole`): that role's permissions ∪ team
/// permissions ∪ personal extras, personal denies still applied. EMPLOYEE
/// members keep their fixed set. Not cached.
pub async fn resolve_permissions_with_role(
    db: &PgPool,
    user_id: &str,
    role_id: &str,
) -> Result<ResolvedPermissions, sqlx::Error> {
    weldsuite_permissions::resolve_permissions_with_role(
        &TenantPermissionQueries::new(db.clone()),
        user_id,
        role_id,
    )
    .await
}

/// The effective permissions inside one entity (`permissionsInEntity`): the
/// workspace result, or the entity role's.
pub async fn permissions_in_entity(
    db: &PgPool,
    access: &EntityAccess,
    entity_id: &str,
) -> Result<ResolvedPermissions, sqlx::Error> {
    permissions_in_entity_with(&TenantPermissionQueries::new(db.clone()), access, entity_id).await
}

/// [`permissions_in_entity`] through any [`PermissionQueries`] (a module's
/// permission gate's).
pub async fn permissions_in_entity_with<Q: PermissionQueries + ?Sized>(
    queries: &Q,
    access: &EntityAccess,
    entity_id: &str,
) -> Result<ResolvedPermissions, Q::Error> {
    match entity_role_id(access, Some(entity_id)) {
        None => Ok(access.workspace_permissions.clone()),
        Some(role_id) => {
            weldsuite_permissions::resolve_permissions_with_role(queries, &access.user_id, role_id)
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    //! `access.test.ts`.

    use super::*;

    fn resolved(
        permissions: &[&str],
        denies: &[&str],
        role: &str,
        is_owner: bool,
    ) -> ResolvedPermissions {
        ResolvedPermissions {
            permissions: permissions.iter().map(|p| (*p).to_owned()).collect(),
            denies: denies.iter().map(|p| (*p).to_owned()).collect(),
            role: role.to_owned(),
            role_id: None,
            is_owner,
        }
    }

    fn member() -> ResolvedPermissions {
        resolved(&["invoices:read"], &[], "MEMBER", false)
    }

    fn owner() -> ResolvedPermissions {
        resolved(&["*"], &[], "OWNER", true)
    }

    fn manager() -> ResolvedPermissions {
        resolved(&["legal_entities:manage"], &[], "MEMBER", false)
    }

    fn rows() -> Vec<EntityAccessRow> {
        vec![
            EntityAccessRow::new("open", false, false, None),
            EntityAccessRow::new("restricted", true, false, None),
            EntityAccessRow::new("restricted_listed", true, true, None),
            EntityAccessRow::new("open_with_role", false, true, Some("role_viewer")),
        ]
    }

    #[test]
    fn hides_a_restricted_entity_from_a_member_without_a_row() {
        let access = build_entity_access("u1", member(), rows());
        assert!(!can_see_entity(&access, Some("restricted")));
        assert_eq!(
            visible_entity_ids(&access),
            ["open", "restricted_listed", "open_with_role"]
        );
        assert!(!access.uniform);
    }

    #[test]
    fn shows_a_restricted_entity_to_a_listed_member_with_their_workspace_role() {
        let access = build_entity_access("u1", member(), rows());
        assert!(can_see_entity(&access, Some("restricted_listed")));
        assert_eq!(entity_role_id(&access, Some("restricted_listed")), None);
        assert_eq!(
            entity_access_source(&access, "restricted_listed"),
            EntityAccessSource::Member
        );
        assert_eq!(
            entity_access_source(&access, "open"),
            EntityAccessSource::Open
        );
    }

    #[test]
    fn applies_the_row_role_in_an_open_entity() {
        let access = build_entity_access("u1", member(), rows());
        assert_eq!(
            entity_role_id(&access, Some("open_with_role")),
            Some("role_viewer")
        );
    }

    #[test]
    fn owners_and_access_managers_see_everything_with_their_workspace_role() {
        for permissions in [owner(), manager()] {
            let access = build_entity_access("u1", permissions, rows());
            assert!(access.sees_all);
            assert!(access.uniform);
            assert_eq!(visible_entity_ids(&access).len(), 4);
            assert_eq!(entity_role_id(&access, Some("open_with_role")), None);
        }
        assert_eq!(
            entity_access_source(&build_entity_access("u1", owner(), rows()), "open"),
            EntityAccessSource::Owner
        );
        assert_eq!(
            entity_access_source(&build_entity_access("u1", manager(), rows()), "open"),
            EntityAccessSource::Manager
        );
    }

    #[test]
    fn honours_a_personal_deny_on_legal_entities_manage() {
        let denied = resolved(
            &["legal_entities:manage"],
            &["legal_entities:manage"],
            "MEMBER",
            false,
        );
        let access = build_entity_access("u1", denied, rows());
        assert!(!access.sees_all);
        assert!(!can_see_entity(&access, Some("restricted")));
    }

    #[test]
    fn is_uniform_when_nothing_is_restricted_and_no_entity_role_is_set() {
        let access = build_entity_access(
            "u1",
            member(),
            vec![
                EntityAccessRow::new("a", false, false, None),
                EntityAccessRow::new("b", false, true, None),
            ],
        );
        assert!(access.uniform);
    }

    #[test]
    fn never_sees_an_unknown_or_deleted_id() {
        let access = build_entity_access("u1", owner(), rows());
        assert!(!can_see_entity(&access, Some("gone")));
        assert!(!can_see_entity(&access, None));
        assert!(!can_see_entity(&access, Some("")));
    }

    #[test]
    fn a_wildcard_grant_is_a_manager() {
        let admin = resolved(&["*"], &[], "ADMIN", false);
        let access = build_entity_access("u1", admin, rows());
        assert!(access.sees_all);
        assert_eq!(
            entity_access_source(&access, "restricted"),
            EntityAccessSource::Manager
        );
    }
}
