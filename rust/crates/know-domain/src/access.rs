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
//! A workspace API key (the public API, `user_id` `None`) has no user: it
//! reaches open teamspaces only, and acts in them as an owner would. know-api
//! always has a user.

use std::collections::HashMap;

use sea_orm::sea_query::{Expr, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    knowledge_space_members as members, knowledge_spaces as spaces, workspace_members as people,
};

use crate::{KnowError, row};

/// Who a teamspace can be shared with, in every query below: workspace
/// members that are ACTIVE, INTERNAL and not deleted.
fn shareable() -> sea_orm::Condition {
    sea_orm::Condition::all()
        .add(people::Column::Status.eq("ACTIVE"))
        .add(people::Column::MemberType.eq("INTERNAL"))
        .add(people::Column::DeletedAt.is_null())
}

/// What the caller may do to one space.
#[derive(Debug, Clone)]
pub struct SpaceAccess {
    /// The `knowledge_spaces` row as Drizzle returns it.
    pub space: Value,
    /// The caller's membership role; `owner` for their own personal space.
    pub role: Option<String>,
    pub can_read: bool,
    pub can_write: bool,
    /// Edit settings, manage members, delete.
    pub can_manage: bool,
}

impl SpaceAccess {
    pub fn id(&self) -> &str {
        text(&self.space, "id")
    }

    pub fn kind(&self) -> &str {
        text(&self.space, "kind")
    }

    pub fn is_personal(&self) -> bool {
        self.kind() == "personal"
    }
}

/// A string column of a row, `""` when null.
pub fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// What this caller may do to `space` given their active membership role;
/// `None` when the space is invisible to them (`accessFor`).
#[must_use]
pub fn access_for(
    space: Value,
    role: Option<String>,
    user_id: Option<&str>,
    can_manage_all: bool,
) -> Option<SpaceAccess> {
    let Some(user_id) = user_id else {
        if text(&space, "kind") != "team" || text(&space, "visibility") != "open" {
            return None;
        }
        return Some(SpaceAccess {
            space,
            role: None,
            can_read: true,
            can_write: true,
            can_manage: true,
        });
    };
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
pub async fn require_space(
    db: &PgPool,
    user_id: Option<&str>,
    space_id: &str,
    can_manage_all: bool,
) -> Result<SpaceAccess, KnowError> {
    let db = orm(db);
    let space = spaces::Entity::find_by_id(space_id.to_owned())
        .filter(spaces::Column::DeletedAt.is_null())
        .one(&db)
        .await?;
    let Some(space) = space.map(row) else {
        return Err(KnowError::not_found("Space", space_id));
    };
    let role = if let (true, Some(user_id)) = (text(&space, "kind") == "team", user_id) {
        members::Entity::find()
            .select_only()
            .column(members::Column::Role)
            .filter(members::Column::SpaceId.eq(space_id))
            .filter(members::Column::UserId.eq(user_id))
            .filter(members::Column::LeftAt.is_null())
            .into_tuple::<String>()
            .one(&db)
            .await?
    } else {
        None
    };
    access_for(space, role, user_id, can_manage_all)
        .ok_or_else(|| KnowError::not_found("Space", space_id))
}

pub fn assert_can_read(access: &SpaceAccess) -> Result<(), KnowError> {
    if access.can_read {
        Ok(())
    } else {
        Err(KnowError::Forbidden(
            "You are not a member of this teamspace. Join it to read its pages.",
        ))
    }
}

pub fn assert_can_write(access: &SpaceAccess) -> Result<(), KnowError> {
    assert_can_read(access)?;
    if access.can_write {
        Ok(())
    } else {
        Err(KnowError::Forbidden(
            "This needs the editor role in the teamspace.",
        ))
    }
}

pub fn assert_can_manage(access: &SpaceAccess) -> Result<(), KnowError> {
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
pub async fn list_spaces(
    db: &PgPool,
    user_id: Option<&str>,
    can_manage_all: bool,
) -> Result<Vec<Value>, KnowError> {
    let db = orm(db);
    let rows = spaces::Entity::find()
        .filter(spaces::Column::DeletedAt.is_null())
        .order_by_asc(spaces::Column::SortOrder)
        .order_by_asc(spaces::Column::CreatedAt)
        .all(&db)
        .await?;
    // The caller's active roles; a key (no user) is in no teamspace. A person
    // is in a space once (`knowledge_space_members_space_user_idx`).
    let roles: HashMap<String, String> = match user_id {
        Some(user_id) => members::Entity::find()
            .select_only()
            .column(members::Column::SpaceId)
            .column(members::Column::Role)
            .filter(members::Column::UserId.eq(user_id))
            .filter(members::Column::LeftAt.is_null())
            .into_tuple::<(String, String)>()
            .all(&db)
            .await?
            .into_iter()
            .collect(),
        None => HashMap::new(),
    };
    let visible: Vec<SpaceAccess> = rows
        .into_iter()
        .filter_map(|space| {
            let role = roles.get(&space.id).cloned();
            access_for(row(space), role, user_id, can_manage_all)
        })
        .collect();

    let teams: Vec<String> = visible
        .iter()
        .filter(|access| !access.is_personal())
        .map(|access| access.id().to_owned())
        .collect();
    let counts: Vec<(String, i64)> = if teams.is_empty() {
        Vec::new()
    } else {
        members::Entity::find()
            .select_only()
            .column(members::Column::SpaceId)
            .column_as(members::Column::Id.count(), "count")
            .filter(members::Column::SpaceId.is_in(teams))
            .filter(members::Column::LeftAt.is_null())
            .group_by(members::Column::SpaceId)
            .into_tuple()
            .all(&db)
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
pub async fn readable_space_ids(
    db: &PgPool,
    user_id: Option<&str>,
) -> Result<Vec<String>, KnowError> {
    space_ids_where(db, user_id, "canRead").await
}

/// Ids of the spaces the caller may write pages in (`writableSpaceIds`).
pub async fn writable_space_ids(
    db: &PgPool,
    user_id: Option<&str>,
) -> Result<Vec<String>, KnowError> {
    space_ids_where(db, user_id, "canWrite").await
}

async fn space_ids_where(
    db: &PgPool,
    user_id: Option<&str>,
    flag: &str,
) -> Result<Vec<String>, KnowError> {
    Ok(list_spaces(db, user_id, false)
        .await?
        .iter()
        .filter(|space| space[flag] == true)
        .map(|space| text(space, "id").to_owned())
        .collect())
}

// ── Personal space and default teamspaces ──────────────────────────────────

/// `ON CONFLICT DO NOTHING`: any unique index may refuse the row.
fn on_any_conflict_do_nothing() -> OnConflict {
    OnConflict::new().do_nothing().to_owned()
}

/// The caller's personal space, created on first use. Two tabs can race
/// here; the partial unique index on the owner lets one insert win.
pub async fn ensure_personal_space(
    db: &PgPool,
    user_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    let db = orm(db);
    let existing = spaces::Entity::find()
        .select_only()
        .column(spaces::Column::Id)
        .filter(spaces::Column::Kind.eq("personal"))
        .filter(spaces::Column::OwnerId.eq(user_id))
        .filter(spaces::Column::DeletedAt.is_null())
        .into_tuple::<String>()
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    spaces::Entity::insert(spaces::ActiveModel {
        id: Set(generate_id("kspc")),
        name: Set("Private".to_owned()),
        kind: Set("personal".to_owned()),
        owner_id: Set(Some(user_id.to_owned())),
        visibility: Set("private".to_owned()),
        sort_order: Set(-1),
        created_by: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(on_any_conflict_do_nothing())
    .exec_without_returning(&db)
    .await?;
    Ok(())
}

/// A new membership row; an existing one (even a left one) wins.
async fn insert_member(
    db: &sea_orm::DatabaseConnection,
    space_id: &str,
    user_id: &str,
    role: &str,
    added_by: Option<&str>,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    members::Entity::insert(members::ActiveModel {
        id: Set(generate_id("kspm")),
        space_id: Set(space_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        role: Set(role.to_owned()),
        added_by: Set(added_by.map(str::to_owned)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .on_conflict(on_any_conflict_do_nothing())
    .exec_without_returning(db)
    .await?;
    Ok(())
}

/// The user, when they are someone a teamspace can be shared with.
async fn shareable_person(
    db: &sea_orm::DatabaseConnection,
    user_id: &str,
) -> Result<Option<String>, KnowError> {
    Ok(people::Entity::find()
        .select_only()
        .column(people::Column::UserId)
        .filter(people::Column::UserId.eq(user_id))
        .filter(shareable())
        .into_tuple::<String>()
        .one(db)
        .await?)
}

/// Add the caller to every default teamspace they have never been in
/// (`joinDefaultSpaces`). Someone who left keeps their `left_at` row and is
/// not pulled back; only shareable members are added.
pub async fn join_default_spaces(
    db: &PgPool,
    user_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    let db = orm(db);
    if shareable_person(&db, user_id).await?.is_none() {
        return Ok(());
    }
    let ever_in = Query::select()
        .column(members::Column::SpaceId)
        .from(members::Entity)
        .and_where(members::Column::UserId.eq(user_id))
        .to_owned();
    let missing: Vec<String> = spaces::Entity::find()
        .select_only()
        .column(spaces::Column::Id)
        .filter(spaces::Column::Kind.eq("team"))
        .filter(spaces::Column::IsDefault.eq(true))
        .filter(spaces::Column::DeletedAt.is_null())
        .filter(spaces::Column::Id.not_in_subquery(ever_in))
        .into_tuple()
        .all(&db)
        .await?;
    for space_id in missing {
        insert_member(&db, &space_id, user_id, "editor", None, now).await?;
    }
    Ok(())
}

/// Add every shareable workspace member who has never been in the space
/// (`addEveryoneToSpace`).
pub async fn add_everyone_to_space(
    db: &PgPool,
    space_id: &str,
    added_by: &str,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    let db = orm(db);
    let ever_in = Query::select()
        .column(members::Column::UserId)
        .from(members::Entity)
        .and_where(members::Column::SpaceId.eq(space_id))
        .to_owned();
    let people: Vec<String> = people::Entity::find()
        .select_only()
        .column(people::Column::UserId)
        .filter(shareable())
        .filter(people::Column::UserId.not_in_subquery(ever_in))
        .into_tuple()
        .all(&db)
        .await?;
    for user_id in people {
        insert_member(&db, space_id, &user_id, "editor", Some(added_by), now).await?;
    }
    Ok(())
}

// ── Members ────────────────────────────────────────────────────────────────

/// One person a teamspace can be shared with.
#[derive(Serialize)]
struct Teammate {
    #[serde(rename = "userId")]
    user_id: String,
    name: Option<String>,
    email: Option<String>,
    picture: Option<String>,
}

/// People a teamspace can be shared with (`listTeammates`), with their
/// account pictures (`master`).
pub async fn list_teammates(db: &PgPool, master: Option<&PgPool>) -> Result<Vec<Value>, KnowError> {
    let found: Vec<(String, Option<String>, Option<String>)> = people::Entity::find()
        .select_only()
        .column(people::Column::UserId)
        .column(people::Column::Name)
        .column(people::Column::Email)
        .filter(shareable())
        .order_by_asc(people::Column::Name)
        .order_by_asc(people::Column::Email)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut rows: Vec<Value> = found
        .into_iter()
        .map(|(user_id, name, email)| {
            row(Teammate {
                user_id,
                name,
                email,
                picture: None,
            })
        })
        .collect();
    weldsuite_db::overlay_account_pictures(master, &mut rows, "userId", "picture").await;
    Ok(rows)
}

/// One active member of a teamspace, with their name.
#[derive(FromQueryResult, Serialize)]
struct SpaceMember {
    #[serde(rename = "userId")]
    user_id: String,
    role: String,
    name: Option<String>,
    email: Option<String>,
    #[serde(rename = "addedBy")]
    added_by: Option<String>,
    #[serde(rename = "createdAt", with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
}

/// A teamspace's active members with their names (`listSpaceMembers`) and
/// account pictures (`master`).
pub async fn list_space_members(
    db: &PgPool,
    master: Option<&PgPool>,
    space_id: &str,
) -> Result<Vec<Value>, KnowError> {
    let person = members::Entity::belongs_to(people::Entity)
        .from(members::Column::UserId)
        .to(people::Column::UserId)
        .into();
    let found: Vec<SpaceMember> = members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .column(members::Column::Role)
        .column_as(people::Column::Name, "name")
        .column_as(people::Column::Email, "email")
        .column(members::Column::AddedBy)
        .column(members::Column::CreatedAt)
        .join(JoinType::LeftJoin, person)
        .filter(members::Column::SpaceId.eq(space_id))
        .filter(members::Column::LeftAt.is_null())
        .order_by_asc(people::Column::Name)
        .order_by_asc(members::Column::CreatedAt)
        .into_model()
        .all(&orm(db))
        .await?;
    let mut rows: Vec<Value> = found
        .into_iter()
        .map(|member| {
            let mut member = row(member);
            // Filled in from the account pictures, when there are any.
            member["picture"] = Value::Null;
            member
        })
        .collect();
    weldsuite_db::overlay_account_pictures(master, &mut rows, "userId", "picture").await;
    Ok(rows)
}

/// Add a teammate (or bring back someone who left), or change their role if
/// they are in already (`addSpaceMember`). `true` when they were added.
pub async fn add_space_member(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    role: &str,
    added_by: &str,
    now: PrimitiveDateTime,
) -> Result<bool, KnowError> {
    let orm_db = orm(db);
    if shareable_person(&orm_db, user_id).await?.is_none() {
        return Err(KnowError::not_found("Teammate", user_id));
    }

    let existing: Option<(String, Option<PrimitiveDateTime>)> = members::Entity::find()
        .select_only()
        .column(members::Column::Id)
        .column(members::Column::LeftAt)
        .filter(members::Column::SpaceId.eq(space_id))
        .filter(members::Column::UserId.eq(user_id))
        .into_tuple()
        .one(&orm_db)
        .await?;
    match existing {
        Some((_, None)) => {
            set_space_member_role(db, space_id, user_id, role, now).await?;
            Ok(false)
        }
        Some((id, Some(_))) => {
            members::Entity::update_many()
                .col_expr(members::Column::Role, Expr::value(role))
                .col_expr(
                    members::Column::LeftAt,
                    Expr::value(None::<PrimitiveDateTime>),
                )
                .col_expr(members::Column::AddedBy, Expr::value(added_by))
                .col_expr(members::Column::UpdatedAt, Expr::value(now))
                .filter(members::Column::Id.eq(id))
                .exec(&orm_db)
                .await?;
            Ok(true)
        }
        None => {
            insert_member(&orm_db, space_id, user_id, role, Some(added_by), now).await?;
            Ok(true)
        }
    }
}

/// The active membership row: its id and role, or a 404.
async fn require_membership(
    db: &sea_orm::DatabaseConnection,
    space_id: &str,
    user_id: &str,
) -> Result<(String, String), KnowError> {
    let row: Option<(String, String)> = members::Entity::find()
        .select_only()
        .column(members::Column::Id)
        .column(members::Column::Role)
        .filter(members::Column::SpaceId.eq(space_id))
        .filter(members::Column::UserId.eq(user_id))
        .filter(members::Column::LeftAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    row.ok_or_else(|| KnowError::not_found("Member", user_id))
}

/// A teamspace always keeps one owner, or nobody in it could manage it again.
async fn assert_not_last_owner(
    db: &sea_orm::DatabaseConnection,
    space_id: &str,
    user_id: &str,
) -> Result<(), KnowError> {
    let owners: Vec<String> = members::Entity::find()
        .select_only()
        .column(members::Column::UserId)
        .filter(members::Column::SpaceId.eq(space_id))
        .filter(members::Column::Role.eq("owner"))
        .filter(members::Column::LeftAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    if owners.len() == 1 && owners[0] == user_id {
        return Err(KnowError::Conflict(
            "This is the teamspace\u{2019}s only owner. Make someone else an owner first.",
        ));
    }
    Ok(())
}

pub async fn set_space_member_role(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    role: &str,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    let db = orm(db);
    let (id, previous) = require_membership(&db, space_id, user_id).await?;
    if previous == "owner" && role != "owner" {
        assert_not_last_owner(&db, space_id, user_id).await?;
    }
    members::Entity::update_many()
        .col_expr(members::Column::Role, Expr::value(role))
        .col_expr(members::Column::UpdatedAt, Expr::value(now))
        .filter(members::Column::Id.eq(id))
        .exec(&db)
        .await?;
    Ok(())
}

/// Leave, or be removed from, a teamspace. The row stays with `left_at` set.
pub async fn remove_space_member(
    db: &PgPool,
    space_id: &str,
    user_id: &str,
    now: PrimitiveDateTime,
) -> Result<(), KnowError> {
    let db = orm(db);
    let (id, role) = require_membership(&db, space_id, user_id).await?;
    if role == "owner" {
        assert_not_last_owner(&db, space_id, user_id).await?;
    }
    members::Entity::update_many()
        .col_expr(members::Column::LeftAt, Expr::value(now))
        .col_expr(members::Column::UpdatedAt, Expr::value(now))
        .filter(members::Column::Id.eq(id))
        .exec(&db)
        .await?;
    Ok(())
}

/// Join an open teamspace (or, for an admin, any teamspace) as an editor.
pub async fn join_space(
    db: &PgPool,
    access: &SpaceAccess,
    user_id: &str,
    now: PrimitiveDateTime,
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
            flags(access_for(mine.clone(), None, Some("alice"), false)),
            Some((Some("owner".into()), true, true, false))
        );
        assert!(access_for(mine.clone(), None, Some("bob"), false).is_none());
        assert!(access_for(mine, None, Some("admin"), true).is_none());
    }

    #[test]
    fn teamspaces_follow_visibility_and_role() {
        let open = space("team", "open", None);
        assert_eq!(
            flags(access_for(open.clone(), None, Some("bob"), false)),
            Some((None, true, false, false))
        );
        assert_eq!(
            flags(access_for(open, Some("viewer".into()), Some("bob"), false)),
            Some((Some("viewer".into()), true, false, false))
        );
        let closed = space("team", "closed", None);
        assert_eq!(
            flags(access_for(closed, None, Some("bob"), false)),
            Some((None, false, false, false))
        );
        let private = space("team", "private", None);
        assert!(access_for(private.clone(), None, Some("bob"), false).is_none());
        assert_eq!(
            flags(access_for(private.clone(), None, Some("admin"), true)),
            Some((None, false, false, true))
        );
        assert_eq!(
            flags(access_for(
                private,
                Some("editor".into()),
                Some("admin"),
                true
            )),
            Some((Some("editor".into()), true, true, true))
        );
    }

    #[test]
    fn a_key_reaches_open_teamspaces_only() {
        assert_eq!(
            flags(access_for(space("team", "open", None), None, None, false)),
            Some((None, true, true, true))
        );
        assert!(access_for(space("team", "closed", None), None, None, true).is_none());
        assert!(access_for(space("team", "private", None), None, None, true).is_none());
        assert!(access_for(space("personal", "open", Some("alice")), None, None, false).is_none());
    }
}
