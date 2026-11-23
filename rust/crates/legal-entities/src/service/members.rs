//! Per-entity access management: the Restricted switch, the member list with
//! a role per member, and the signed-in member's effective access.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_catalogs::permissions;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{entities, legal_entity_members, roles, workspace_members};

use super::entities::{require_entity_row, role_names, update_entity_row};
use super::types::{
    EntityMemberRow, EntityRow, LegalEntityAccess, LegalEntityAccessMember,
    LegalEntityEffectiveAccess, SetEntityMember, SetEntityMemberResult,
};
use super::{LegalEntityError, iso, read_model};
use crate::access::{
    EntityAccess, can_see_entity, entity_access_source, entity_role_id, permissions_in_entity,
};

fn member_row(model: &legal_entity_members::Model) -> Result<EntityMemberRow, LegalEntityError> {
    Ok(read_model::<_, EntityMemberRow>(model)?.0)
}

/// `SYSTEM_ROLES[role.toUpperCase()]?.name`.
fn system_role_name(role: &str) -> Option<String> {
    permissions()
        .system_roles
        .get(&role.to_uppercase())
        .map(|role| role.name.clone())
}

/// A member row of the access list: the `legal_entity_members` columns, then
/// the workspace member's name, email, role and role id.
#[derive(Debug, FromQueryResult)]
struct AccessRow {
    user_id: String,
    role_id: Option<String>,
    granted_by: Option<String>,
    created_at: PrimitiveDateTime,
    updated_at: PrimitiveDateTime,
    name: Option<String>,
    email: Option<String>,
    workspace_role: Option<String>,
    workspace_role_id: Option<String>,
}

/// `getEntityAccessList`: the Restricted switch and the members with a row,
/// by name, with their workspace role for context. `picture` is the account
/// picture, read from `master`.
pub async fn get_entity_access_list(
    db: &PgPool,
    master: Option<&PgPool>,
    entity_id: &str,
) -> Result<LegalEntityAccess, LegalEntityError> {
    let entity = require_entity_row(db, entity_id).await?;
    let rows = access_rows(db, entity_id).await?;
    let pictures =
        weldsuite_db::AccountPictures::load(master, rows.iter().map(|row| row.user_id.as_str()))
            .await;
    let mut role_ids: Vec<String> = Vec::new();
    for id in rows
        .iter()
        .flat_map(|row| [row.role_id.clone(), row.workspace_role_id.clone()])
        .flatten()
        .filter(|id| !id.is_empty())
    {
        if !role_ids.contains(&id) {
            role_ids.push(id);
        }
    }
    let names = role_names(db, &role_ids).await?;
    let members = rows
        .into_iter()
        .map(
            |AccessRow {
                 user_id,
                 role_id,
                 granted_by,
                 created_at,
                 updated_at,
                 name,
                 email,
                 workspace_role,
                 workspace_role_id,
             }| {
                let picture = pictures.get(&user_id).map(str::to_owned);
                let workspace_role = workspace_role.unwrap_or_default();
                // `(id && names.get(id)) || systemRoleName(role)`: an empty
                // name falls through too.
                let workspace_role_name = workspace_role_id
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .and_then(|id| names.get(id))
                    .filter(|name| !name.is_empty())
                    .cloned()
                    .or_else(|| system_role_name(&workspace_role));
                let role_name = role_id
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .and_then(|id| names.get(id).cloned());
                LegalEntityAccessMember {
                    user_id,
                    name,
                    email,
                    picture,
                    workspace_role,
                    workspace_role_name,
                    role_id,
                    role_name,
                    granted_by,
                    created_at: iso(created_at),
                    updated_at: iso(updated_at),
                }
            },
        )
        .collect();
    Ok(LegalEntityAccess {
        entity_id: entity_id.to_owned(),
        restricted: entity.access_restricted,
        members,
    })
}

/// The entity's member rows with the workspace member each names, by name
/// (`legal_entity_members m left join workspace_members w on w.user_id =
/// m.user_id and w.deleted_at is null … order by w.name, m.created_at`).
async fn access_rows(db: &PgPool, entity_id: &str) -> Result<Vec<AccessRow>, sea_orm::DbErr> {
    legal_entity_members::Entity::find()
        .select_only()
        .columns([
            legal_entity_members::Column::UserId,
            legal_entity_members::Column::RoleId,
            legal_entity_members::Column::GrantedBy,
            legal_entity_members::Column::CreatedAt,
            legal_entity_members::Column::UpdatedAt,
        ])
        .column(workspace_members::Column::Name)
        .column(workspace_members::Column::Email)
        .column_as(workspace_members::Column::Role, "workspace_role")
        .column_as(workspace_members::Column::RoleId, "workspace_role_id")
        .join(
            JoinType::LeftJoin,
            legal_entity_members::Entity::belongs_to(workspace_members::Entity)
                .from(legal_entity_members::Column::UserId)
                .to(workspace_members::Column::UserId)
                .on_condition(|_, member| {
                    sea_orm::ExprTrait::is_null(Expr::col((
                        member,
                        workspace_members::Column::DeletedAt,
                    )))
                    .into()
                })
                .into(),
        )
        .filter(legal_entity_members::Column::EntityId.eq(entity_id))
        .order_by_asc(workspace_members::Column::Name)
        .order_by_asc(legal_entity_members::Column::CreatedAt)
        .into_model()
        .all(&orm(db))
        .await
}

/// `setEntityRestricted`: only listed members (plus owners and access
/// managers) see a restricted entity.
pub async fn set_entity_restricted(
    db: &PgPool,
    entity_id: &str,
    restricted: bool,
) -> Result<EntityRow, LegalEntityError> {
    require_entity_row(db, entity_id).await?;
    update_entity_row(
        db,
        entity_id,
        entities::ActiveModel {
            access_restricted: Set(restricted),
            updated_at: Set(utc_now()),
            ..Default::default()
        },
    )
    .await
}

/// `setEntityMember`: add a member to an entity or change their role there.
/// The user must be an active internal member (EMPLOYEE members only have
/// My HR, guests none); the role must be a live role of the workspace and
/// never Owner. All refusals are `BAD_REQUEST`.
pub async fn set_entity_member(
    db: &PgPool,
    args: SetEntityMember<'_>,
) -> Result<SetEntityMemberResult, LegalEntityError> {
    require_entity_row(db, args.entity_id).await?;
    let member: Option<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::Status,
            workspace_members::Column::MemberType,
        ])
        .filter(workspace_members::Column::UserId.eq(args.user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some((_, member_type)) = member.filter(|(status, _)| status == "ACTIVE") else {
        return Err(LegalEntityError::bad_request(
            "This person is not an active member of the workspace",
        ));
    };
    if matches!(member_type.as_deref(), Some("EMPLOYEE" | "EXTERNAL_GUEST")) {
        return Err(LegalEntityError::bad_request(
            "Employee members and guests cannot be given access to a legal entity",
        ));
    }
    if let Some(role_id) = args.role_id.filter(|id| !id.is_empty()) {
        let role: Option<(String, bool)> = roles::Entity::find()
            .select_only()
            .columns([roles::Column::Name, roles::Column::IsSystem])
            .filter(roles::Column::Id.eq(role_id))
            .filter(roles::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        let Some((name, is_system)) = role else {
            return Err(LegalEntityError::bad_request("Role not found"));
        };
        if is_system && name.to_uppercase() == "OWNER" {
            return Err(LegalEntityError::bad_request(
                "The Owner role cannot be given per legal entity",
            ));
        }
    }

    let existing: Option<String> = legal_entity_members::Entity::find()
        .select_only()
        .column(legal_entity_members::Column::Id)
        .filter(legal_entity_members::Column::EntityId.eq(args.entity_id))
        .filter(legal_entity_members::Column::UserId.eq(args.user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let role_id = Set(args.role_id.map(str::to_owned));
    let granted_by = Set(Some(args.granted_by.to_owned()));
    if let Some(existing) = existing {
        let row = legal_entity_members::Entity::update_many()
            .set(legal_entity_members::ActiveModel {
                role_id,
                granted_by,
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .filter(legal_entity_members::Column::Id.eq(existing))
            .exec_with_returning(&orm(db))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| LegalEntityError::not_found("Member not found"))?;
        return Ok(SetEntityMemberResult {
            created: false,
            member: member_row(&row)?,
        });
    }
    let row = legal_entity_members::Entity::insert(legal_entity_members::ActiveModel {
        id: Set(generate_id("lem")),
        entity_id: Set(args.entity_id.to_owned()),
        user_id: Set(args.user_id.to_owned()),
        role_id,
        granted_by,
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(SetEntityMemberResult {
        created: true,
        member: member_row(&row)?,
    })
}

/// `removeEntityMember`: the removed row, or `None` when the member had none.
pub async fn remove_entity_member(
    db: &PgPool,
    entity_id: &str,
    user_id: &str,
) -> Result<Option<EntityMemberRow>, LegalEntityError> {
    let row = legal_entity_members::Entity::delete_many()
        .filter(legal_entity_members::Column::EntityId.eq(entity_id))
        .filter(legal_entity_members::Column::UserId.eq(user_id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    row.as_ref().map(member_row).transpose()
}

/// `myEffectiveAccess`: the signed-in member's effective access inside one
/// entity, or `None` when they do not see it.
pub async fn my_effective_access(
    db: &PgPool,
    access: &EntityAccess,
    entity_id: &str,
) -> Result<Option<LegalEntityEffectiveAccess>, LegalEntityError> {
    if !can_see_entity(access, Some(entity_id)) {
        return Ok(None);
    }
    let role_id = entity_role_id(access, Some(entity_id)).map(str::to_owned);
    let resolved = permissions_in_entity(db, access, entity_id).await?;
    let names = role_names(db, role_id.as_slice()).await?;
    Ok(Some(LegalEntityEffectiveAccess {
        entity_id: entity_id.to_owned(),
        source: entity_access_source(access, entity_id),
        role_name: role_id.as_ref().and_then(|id| names.get(id).cloned()),
        role_id,
        permissions: resolved.permissions,
        denies: resolved.denies,
        is_owner: resolved.is_owner,
    }))
}
