//! Who may see, read, write and manage which space
//! (`packages/domains/know/src/access.ts`):
//!
//! - **personal**: its owner, and nobody else. Not even a workspace admin
//!   holding `knowledge:manage`; to them the id resolves to nothing.
//! - **open**: everyone (with `knowledge:read`) sees and reads it. Joining
//!   makes you an editor.
//! - **closed**: everyone sees that it exists; only members read it. An owner
//!   adds people.
//! - **private**: only members know it exists.
//!
//! Members act at their role: viewer reads, editor also writes pages, owner
//! also changes the teamspace's settings and members. `knowledge:manage`
//! (`can_manage_all`) makes every teamspace visible and manageable, but
//! reading a closed or private one still takes joining it. A space the caller
//! cannot see is a 404, never a 403.
//!
//! The TypeScript module also answers for workspace API keys (external-api,
//! mcp-server: open teamspaces only). know-api always has a user, and so does
//! this port; the key path comes with external-api.

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::KnowError;

// Who a teamspace can be shared with, in every query below: workspace members
// that are ACTIVE, INTERNAL and not deleted. sqlx takes literal SQL only, so
// the condition is written out each time.

/// What the caller may do to one space.
#[derive(Debug, Clone)]
pub(crate) struct SpaceAccess {
    /// The `knowledge_spaces` row as Drizzle returns it.
    pub(crate) space: Value,
    /// The caller's membership role; `owner` for their own personal space.
    pub(crate) role: Option<String>,
    pub(crate) can_read: bool,
    pub(crate) can_write: bool,
    /// Edit settings, manage members, delete.
    pub(crate) can_manage: bool,
}

impl SpaceAccess {
    pub(crate) fn id(&self) -> &str {
        text(&self.space, "id")
    }

    pub(crate) fn kind(&self) -> &str {
        text(&self.space, "kind")
    }

    pub(crate) fn is_personal(&self) -> bool {
        self.kind() == "personal"
    }
}

/// A string column of a row, `""` when null.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// What this caller may do to `space` given their active membership role;
/// `None` when the space is invisible to them (`accessFor`).
pub(crate) fn access_for(
    space: Value,
    role: Option<String>,
    user_id: &str,
    can_manage_all: bool,
) -> Option<SpaceAccess> {
    if text(&space, "kind") == "personal" {
        if space["ownerId"].as_str() != Some(user_id) {
            return None;
        }
        return Some(SpaceAccess {
            space,
            role: Some("owner".to_owned()),
            can_read: true,
            can_write: true,
            can_manage: false,
        });
    }
    if let Some(role) = role {
        return Some(SpaceAccess {
            space,
            can_read: true,
            can_write: role != "viewer",
            can_manage: role == "owner" || can_manage_all,
            role: Some(role),
        });
    }
    let visibility = text(&space, "visibility").to_owned();
    if visibility == "private" && !can_manage_all {
        return None;
    }
    Some(SpaceAccess {
        space,
        role: None,
        can_read: visibility == "open",
        can_write: false,
        can_manage: can_manage_all,
    })
}

/// A live space for this caller, or a 404 (`requireSpace`).
pub(crate) async fn require_space(
    db: &PgPool,
    user_id: &str,
    space_id: &str,
    can_manage_all: bool,
) -> Result<SpaceAccess, KnowError> {
    let space: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from knowledge_spaces s where id = $1 and deleted_at is null limit 1",
    )
    .bind(space_id)
    .fetch_optional(db)
    .await?;
    let Some(space) = space.map(js_row) else {
        return Err(KnowError::not_found("Space", space_id));
    };
    let role = if text(&space, "kind") == "team" {
        sqlx::query_scalar(
            "select role from knowledge_space_members
             where space_id = $1 and user_id = $2 and left_at is null limit 1",
        )
        .bind(space_id)
        .bind(user_id)
        .fetch_optional(db)
        .await?
    } else {
        None
    };
    access_for(space, role, user_id, can_manage_all)
        .ok_or_else(|| KnowError::not_found("Space", space_id))
}

pub(crate) fn assert_can_read(access: &SpaceAccess) -> Result<(), KnowError> {
    if access.can_read {
        Ok(())
    } else {
        Err(KnowError::Forbidden(
            "You are not a member of this teamspace. Join it to read its pages.",
        ))
    }
}

pub(crate) fn assert_can_write(access: &SpaceAccess) -> Result<(), KnowError> {
    assert_can_read(access)?;
    if access.can_write {
        Ok(())
    } else {
        Err(KnowError::Forbidden(
            "This needs the editor role in the teamspace.",
        ))
    }
}

pub(crate) fn assert_can_manage(access: &SpaceAccess) -> Result<(), KnowError> {
    if access.is_personal() {
        return Err(KnowError::Forbidden(
            "Your private space cannot be renamed, shared or deleted.",
        ));
    }
    if access.can_manage {
        Ok(())
    } else {
        Err(KnowError::Forbidden(
            "This needs the owner role in the teamspace.",
        ))
    }
}

/// Every space the caller can see, with what they may do in each
/// (`listSpaces`): the space row plus `role`, `isMember`, `canRead`,
/// `canWrite`, `canManage` and `memberCount`.
pub(crate) async fn list_spaces(
    db: &PgPool,
    user_id: &str,
    can_manage_all: bool,
) -> Result<Vec<Value>, KnowError> {
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(
        "select to_jsonb(s), m.role
         from knowledge_spaces s
         left join knowledge_space_members m
           on m.space_id = s.id and m.user_id = $1 and m.left_at is null
         where s.deleted_at is null
         order by s.sort_order asc, s.created_at asc",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let visible: Vec<SpaceAccess> = rows
        .into_iter()
        .filter_map(|(space, role)| access_for(js_row(space), role, user_id, can_manage_all))
        .collect();

    let teams: Vec<String> = visible
        .iter()
        .filter(|access| !access.is_personal())
        .map(|access| access.id().to_owned())
        .collect();
    let counts: Vec<(String, i64)> = if teams.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select space_id, count(*) from knowledge_space_members
             where space_id = any($1) and left_at is null group by space_id",
        )
        .bind(&teams)
        .fetch_all(db)
        .await?
    };

    Ok(visible
        .into_iter()
        .map(|access| {
            let member_count = if access.is_personal() {
                1
            } else {
                counts
                    .iter()
                    .find(|(id, _)| id == access.id())
                    .map_or(0, |(_, total)| *total)
            };
            let mut summary = match access.space {
                Value::Object(columns) => columns,
                _ => Map::new(),
            };
            summary.insert("role".to_owned(), json!(access.role));
            summary.insert("isMember".to_owned(), json!(access.role.is_some()));
            summary.insert("canRead".to_owned(), json!(access.can_read));
            summary.insert("canWrite".to_owned(), json!(access.can_write));
            summary.insert("canManage".to_owned(), json!(access.can_manage));
            summary.insert("memberCount".to_owned(), json!(member_count));
            Value::Object(summary)
        })
        .collect())
}

/// Ids of the spaces whose pages the caller may read (`readableSpaceIds`).
pub(crate) async fn readable_space_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, KnowError> {
    space_ids_where(db, user_id, "canRead").await
}

/// Ids of the spaces the caller may write pages in (`writableSpaceIds`).
pub(crate) async fn writable_space_ids(
    db: &PgPool,
    user_id: &str,
) -> Result<Vec<String>, KnowError> {
    space_ids_where(db, user_id, "canWrite").await
}

async fn space_ids_where(db: &PgPool, user_id: &str, flag: &str) -> Result<Vec<String>, KnowError> {
    Ok(list_spaces(db, user_id, false)
        .await?
        .iter()
        .filter(|space| space[flag] == true)
        .map(|space| text(space, "id").to_owned())
        .collect())
}

// ── Personal space and default teamspaces ──────────────────────────────────

/// The caller's personal space, created on first use. Two tabs can race
/// here; the partial unique index on the owner lets one insert win.
pub(crate) async fn ensure_personal_space(
    db: &PgPool,
    user_id: &str,
    now: &str,
) -> Result<(), KnowError> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from knowledge_spaces
         where kind = 'personal' and owner_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Ok(());
    }
    sqlx::query(
        "insert into knowledge_spaces
             (id, name, kind, owner_id, visibility, sort_order, created_by, created_at, updated_at)
         values ($1, 'Private', 'personal', $2, 'private', -1, $2, $3::timestamp, $3::timestamp)
         on conflict do nothing",
    )
    .bind(generate_id("kspc"))
    .bind(user_id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Add an editor membership; an existing row (even a left one) wins.
async fn insert_editor(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    added_by: Option<&str>,
    now: &str,
) -> Result<(), KnowError> {
    sqlx::query(
        "insert into knowledge_space_members
             (id, space_id, user_id, role, added_by, created_at, updated_at)
         values ($1, $2, $3, 'editor', $4, $5::timestamp, $5::timestamp)
         on conflict do nothing",
    )
    .bind(generate_id("kspm"))
    .bind(space_id)
    .bind(user_id)
    .bind(added_by)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Add the caller to every default teamspace they have never been in
/// (`joinDefaultSpaces`). Someone who left keeps their `left_at` row and is
/// not pulled back; only shareable members are added.
pub(crate) async fn join_default_spaces(
    db: &PgPool,
    user_id: &str,
    now: &str,
) -> Result<(), KnowError> {
    let eligible: Option<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where user_id = $1 and status = 'ACTIVE' and member_type = 'INTERNAL' and deleted_at is null
         limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if eligible.is_none() {
        return Ok(());
    }
    let missing: Vec<String> = sqlx::query_scalar(
        "select s.id from knowledge_spaces s
         where s.kind = 'team' and s.is_default = true and s.deleted_at is null
           and not exists (
             select 1 from knowledge_space_members m where m.space_id = s.id and m.user_id = $1
           )",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    for space_id in missing {
        insert_editor(db, &space_id, user_id, None, now).await?;
    }
    Ok(())
}

/// Add every shareable workspace member who has never been in the space
/// (`addEveryoneToSpace`).
pub(crate) async fn add_everyone_to_space(
    db: &PgPool,
    space_id: &str,
    added_by: &str,
    now: &str,
) -> Result<(), KnowError> {
    let people: Vec<String> = sqlx::query_scalar(
        "select wm.user_id from workspace_members wm
         where wm.status = 'ACTIVE' and wm.member_type = 'INTERNAL' and wm.deleted_at is null
           and not exists (
             select 1 from knowledge_space_members m where m.space_id = $1 and m.user_id = wm.user_id
           )",
    )
    .bind(space_id)
    .fetch_all(db)
    .await?;
    for user_id in people {
        insert_editor(db, space_id, &user_id, Some(added_by), now).await?;
    }
    Ok(())
}

// ── Members ────────────────────────────────────────────────────────────────

/// People a teamspace can be shared with (`listTeammates`).
pub(crate) async fn list_teammates(db: &PgPool) -> Result<Vec<Value>, KnowError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('userId', user_id, 'name', name, 'email', email, 'picture', picture)
         from workspace_members
         where status = 'ACTIVE' and member_type = 'INTERNAL' and deleted_at is null
         order by name asc, email asc",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// A teamspace's active members with their names (`listSpaceMembers`).
pub(crate) async fn list_space_members(
    db: &PgPool,
    space_id: &str,
) -> Result<Vec<Value>, KnowError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                  'userId', m.user_id, 'role', m.role, 'name', wm.name, 'email', wm.email,
                  'picture', wm.picture, 'addedBy', m.added_by, 'createdAt', m.created_at)
         from knowledge_space_members m
         left join workspace_members wm on wm.user_id = m.user_id
         where m.space_id = $1 and m.left_at is null
         order by wm.name asc, m.created_at asc",
    )
    .bind(space_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// Add a teammate (or bring back someone who left), or change their role if
/// they are in already (`addSpaceMember`). `true` when they were added.
pub(crate) async fn add_space_member(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    role: &str,
    added_by: &str,
    now: &str,
) -> Result<bool, KnowError> {
    let teammate: Option<String> = sqlx::query_scalar(
        "select user_id from workspace_members
         where user_id = $1 and status = 'ACTIVE' and member_type = 'INTERNAL' and deleted_at is null
         limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if teammate.is_none() {
        return Err(KnowError::not_found("Teammate", user_id));
    }

    let existing: Option<(String, bool)> = sqlx::query_as(
        "select id, left_at is not null from knowledge_space_members
         where space_id = $1 and user_id = $2 limit 1",
    )
    .bind(space_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    match existing {
        Some((_, false)) => {
            set_space_member_role(db, space_id, user_id, role, now).await?;
            Ok(false)
        }
        Some((id, true)) => {
            sqlx::query(
                "update knowledge_space_members
                 set role = $2, left_at = null, added_by = $3, updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(id)
            .bind(role)
            .bind(added_by)
            .bind(now)
            .execute(db)
            .await?;
            Ok(true)
        }
        None => {
            sqlx::query(
                "insert into knowledge_space_members
                     (id, space_id, user_id, role, added_by, created_at, updated_at)
                 values ($1, $2, $3, $4, $5, $6::timestamp, $6::timestamp)
                 on conflict do nothing",
            )
            .bind(generate_id("kspm"))
            .bind(space_id)
            .bind(user_id)
            .bind(role)
            .bind(added_by)
            .bind(now)
            .execute(db)
            .await?;
            Ok(true)
        }
    }
}

/// The active membership row: its id and role, or a 404.
async fn require_membership(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
) -> Result<(String, String), KnowError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "select id, role from knowledge_space_members
         where space_id = $1 and user_id = $2 and left_at is null limit 1",
    )
    .bind(space_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.ok_or_else(|| KnowError::not_found("Member", user_id))
}

/// A teamspace always keeps one owner, or nobody in it could manage it again.
async fn assert_not_last_owner(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
) -> Result<(), KnowError> {
    let owners: Vec<String> = sqlx::query_scalar(
        "select user_id from knowledge_space_members
         where space_id = $1 and role = 'owner' and left_at is null",
    )
    .bind(space_id)
    .fetch_all(db)
    .await?;
    if owners.len() == 1 && owners[0] == user_id {
        return Err(KnowError::Conflict(
            "This is the teamspace\u{2019}s only owner. Make someone else an owner first.",
        ));
    }
    Ok(())
}

pub(crate) async fn set_space_member_role(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    role: &str,
    now: &str,
) -> Result<(), KnowError> {
    let (id, previous) = require_membership(db, space_id, user_id).await?;
    if previous == "owner" && role != "owner" {
        assert_not_last_owner(db, space_id, user_id).await?;
    }
    sqlx::query(
        "update knowledge_space_members set role = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(role)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Leave, or be removed from, a teamspace. The row stays with `left_at` set.
pub(crate) async fn remove_space_member(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    now: &str,
) -> Result<(), KnowError> {
    let (id, role) = require_membership(db, space_id, user_id).await?;
    if role == "owner" {
        assert_not_last_owner(db, space_id, user_id).await?;
    }
    sqlx::query(
        "update knowledge_space_members
         set left_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Join an open teamspace (or, for an admin, any teamspace) as an editor.
pub(crate) async fn join_space(
    db: &PgPool,
    access: &SpaceAccess,
    user_id: &str,
    now: &str,
) -> Result<(), KnowError> {
    if access.is_personal() {
        return Err(KnowError::Forbidden("You cannot join a private space."));
    }
    if access.role.is_some() {
        return Ok(());
    }
    if text(&access.space, "visibility") != "open" && !access.can_manage {
        return Err(KnowError::Forbidden(
            "Ask an owner of this teamspace to add you.",
        ));
    }
    add_space_member(db, access.id(), user_id, "editor", user_id, now).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn space(kind: &str, visibility: &str, owner: Option<&str>) -> Value {
        json!({ "id": "kspc_1", "kind": kind, "visibility": visibility, "ownerId": owner })
    }

    fn flags(access: Option<SpaceAccess>) -> Option<(Option<String>, bool, bool, bool)> {
        access.map(|a| (a.role, a.can_read, a.can_write, a.can_manage))
    }

    #[test]
    fn personal_spaces_open_for_their_owner_only() {
        let mine = space("personal", "private", Some("alice"));
        assert_eq!(
            flags(access_for(mine.clone(), None, "alice", false)),
            Some((Some("owner".into()), true, true, false))
        );
        assert!(access_for(mine.clone(), None, "bob", false).is_none());
        assert!(access_for(mine, None, "admin", true).is_none());
    }

    #[test]
    fn teamspaces_follow_visibility_and_role() {
        let open = space("team", "open", None);
        assert_eq!(
            flags(access_for(open.clone(), None, "bob", false)),
            Some((None, true, false, false))
        );
        assert_eq!(
            flags(access_for(open, Some("viewer".into()), "bob", false)),
            Some((Some("viewer".into()), true, false, false))
        );
        let closed = space("team", "closed", None);
        assert_eq!(
            flags(access_for(closed, None, "bob", false)),
            Some((None, false, false, false))
        );
        let private = space("team", "private", None);
        assert!(access_for(private.clone(), None, "bob", false).is_none());
        assert_eq!(
            flags(access_for(private.clone(), None, "admin", true)),
            Some((None, false, false, true))
        );
        assert_eq!(
            flags(access_for(private, Some("editor".into()), "admin", true)),
            Some((Some("editor".into()), true, true, true))
        );
    }
}
