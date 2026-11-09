//! Per-entity access management: the Restricted switch, the member list with
//! a role per member, and the signed-in member's effective access.

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_catalogs::permissions;
use weldsuite_kit::generate_id;

use super::entities::{entity_row, require_entity_row, role_names};
use super::types::{
    EntityMemberRow, EntityRow, LegalEntityAccess, LegalEntityAccessMember,
    LegalEntityEffectiveAccess, SetEntityMember, SetEntityMemberResult,
};
use super::{
    Columns, LegalEntityError, Param, insert_returning, now_iso, read_row, update_returning,
};
use crate::access::{
    EntityAccess, can_see_entity, entity_access_source, entity_role_id, permissions_in_entity,
};

fn member_row(value: Value) -> Result<EntityMemberRow, LegalEntityError> {
    Ok(read_row::<EntityMemberRow>(value)?.0)
}

/// `SYSTEM_ROLES[role.toUpperCase()]?.name`.
fn system_role_name(role: &str) -> Option<String> {
    permissions()
        .system_roles
        .get(&role.to_uppercase())
        .map(|role| role.name.clone())
}

/// A member row of the access list: the `legal_entity_members` columns, then
/// the workspace member's name, email, picture, role and role id.
type AccessRow = (
    String,
    Option<String>,
    Option<String>,
    Value,
    Value,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// `getEntityAccessList`: the Restricted switch and the members with a row,
/// by name, with their workspace role for context.
pub async fn get_entity_access_list(
    db: &PgPool,
    entity_id: &str,
) -> Result<LegalEntityAccess, LegalEntityError> {
    let entity = require_entity_row(db, entity_id).await?;
    let rows: Vec<AccessRow> = sqlx::query_as(
        "select m.user_id, m.role_id, m.granted_by, to_jsonb(m.created_at), to_jsonb(m.updated_at),
                w.name, w.email, w.picture, w.role, w.role_id
         from legal_entity_members m
         left join workspace_members w on w.user_id = m.user_id and w.deleted_at is null
         where m.entity_id = $1
         order by w.name asc, m.created_at asc",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let mut role_ids: Vec<String> = Vec::new();
    for id in rows
        .iter()
        .flat_map(|row| [row.1.clone(), row.9.clone()])
        .flatten()
        .filter(|id| !id.is_empty())
    {
        if !role_ids.contains(&id) {
            role_ids.push(id);
        }
    }
    let names = role_names(db, &role_ids).await?;
    let timestamp = |value: &Value| {
        value
            .as_str()
            .and_then(weldsuite_db::js_timestamp)
            .unwrap_or_default()
    };
    let members = rows
        .into_iter()
        .map(
            |(
                user_id,
                role_id,
                granted_by,
                created_at,
                updated_at,
                name,
                email,
                picture,
                workspace_role,
                workspace_role_id,
            )| {
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
                    created_at: timestamp(&created_at),
                    updated_at: timestamp(&updated_at),
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

/// `setEntityRestricted`: only listed members (plus owners and access
/// managers) see a restricted entity.
pub async fn set_entity_restricted(
    db: &PgPool,
    entity_id: &str,
    restricted: bool,
) -> Result<EntityRow, LegalEntityError> {
    require_entity_row(db, entity_id).await?;
    let mut columns = Columns::default();
    columns.set("access_restricted", Param::Bool(Some(restricted)));
    columns.set("updated_at", Param::Timestamp(Some(now_iso())));
    let row = update_returning(db, "entities", columns, entity_id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Legal entity not found"))?;
    entity_row(row)
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
    let member: Option<(String, Option<String>)> = sqlx::query_as(
        "select status, member_type from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(args.user_id)
    .fetch_optional(db)
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
        let role: Option<(String, bool)> = sqlx::query_as(
            "select name, is_system from roles where id = $1 and deleted_at is null limit 1",
        )
        .bind(role_id)
        .fetch_optional(db)
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

    let existing: Option<String> = sqlx::query_scalar(
        "select id from legal_entity_members where entity_id = $1 and user_id = $2 limit 1",
    )
    .bind(args.entity_id)
    .bind(args.user_id)
    .fetch_optional(db)
    .await?;
    let role_id = Param::Text(args.role_id.map(str::to_owned));
    if let Some(existing) = existing {
        let mut columns = Columns::default();
        columns.set("role_id", role_id);
        columns.set("granted_by", Param::Text(Some(args.granted_by.to_owned())));
        columns.set("updated_at", Param::Timestamp(Some(now_iso())));
        let row = update_returning(db, "legal_entity_members", columns, &existing)
            .await?
            .ok_or_else(|| LegalEntityError::not_found("Member not found"))?;
        return Ok(SetEntityMemberResult {
            created: false,
            member: member_row(row)?,
        });
    }
    let mut columns = Columns::default();
    columns.set("id", Param::Text(Some(generate_id("lem"))));
    columns.set("entity_id", Param::Text(Some(args.entity_id.to_owned())));
    columns.set("user_id", Param::Text(Some(args.user_id.to_owned())));
    columns.set("role_id", role_id);
    columns.set("granted_by", Param::Text(Some(args.granted_by.to_owned())));
    let row = insert_returning(db, "legal_entity_members", columns).await?;
    Ok(SetEntityMemberResult {
        created: true,
        member: member_row(row)?,
    })
}

/// `removeEntityMember`: the removed row, or `None` when the member had none.
pub async fn remove_entity_member(
    db: &PgPool,
    entity_id: &str,
    user_id: &str,
) -> Result<Option<EntityMemberRow>, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "delete from legal_entity_members t where t.entity_id = $1 and t.user_id = $2
         returning to_jsonb(t)",
    )
    .bind(entity_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.map(member_row).transpose()
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
