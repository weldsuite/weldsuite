//! Password-manager vaults and who may open them (`password-vaults.ts`).
//!
//! - personal vault: its owner, nobody else; `passwords:manage` does not get
//!   in either, the id resolves to nothing.
//! - shared vault: its members at their role; `passwords:manage` sees that it
//!   exists and can fix its membership, but reading an item takes joining.
//!
//! A vault the caller cannot see is a 404, never a 403.

use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Unchanged, ColumnTrait, Condition, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QueryOrder, QuerySelect, RelationDef, Select, Set,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    weldpass_items, weldpass_vault_members as members, weldpass_vaults as vaults, workspace_members,
};

use crate::envelope::{Key, RootKeyring, create_vault_key, unwrap_vault_key};
use crate::projects::workspace_of;
use crate::{PassError, PassResult, now, row_json};

use members::Column as M;
use vaults::Column as V;

/// `vaultColumns`: never the wrapped key.
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultRow {
    id: String,
    kind: String,
    owner_id: Option<String>,
    name: String,
    description: Option<String>,
    created_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    updated_at: OffsetDateTime,
}

impl VaultRow {
    fn select() -> Select<vaults::Entity> {
        vaults::Entity::find().select_only().columns([
            V::Id,
            V::Kind,
            V::OwnerId,
            V::Name,
            V::Description,
            V::CreatedBy,
            V::CreatedAt,
            V::UpdatedAt,
        ])
    }
}

impl From<vaults::Model> for VaultRow {
    fn from(row: vaults::Model) -> Self {
        Self {
            id: row.id,
            kind: row.kind,
            owner_id: row.owner_id,
            name: row.name,
            description: row.description,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

/// A vault and the caller's membership role (`listVaults`' left join).
#[derive(Debug, FromQueryResult)]
struct VaultWithRole {
    #[sea_orm(nested)]
    vault: VaultRow,
    role: Option<String>,
}

/// A vault's client-safe columns (`vaultColumns`).
#[derive(Debug, Clone)]
pub(crate) struct Vault {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) json: Value,
}

impl Vault {
    fn from_row(row: VaultRow) -> Self {
        Self {
            json: row_json(&row),
            id: row.id,
            kind: row.kind,
            name: row.name,
        }
    }

    pub(crate) fn is_personal(&self) -> bool {
        self.kind == "personal"
    }
}

/// `VaultAccess`: the vault and the caller's role, `None` for a workspace
/// admin looking at a shared vault they are not in.
#[derive(Debug, Clone)]
pub(crate) struct VaultAccess {
    pub(crate) vault: Vault,
    pub(crate) role: Option<String>,
}

impl VaultAccess {
    /// `{ ...vault, role }`.
    pub(crate) fn json(&self) -> Value {
        let mut json = self.vault.json.clone();
        json["role"] = self.role.clone().map_or(Value::Null, Value::String);
        json
    }
}

fn rank(role: &str) -> u8 {
    match role {
        "viewer" => 1,
        "editor" => 2,
        "manager" => 3,
        _ => 0,
    }
}

/// `requireVaultAccess`.
pub(crate) async fn require_vault_access(
    db: &PgPool,
    workspace: Option<&str>,
    user_id: &str,
    vault_id: &str,
    can_manage_all: bool,
) -> PassResult<VaultAccess> {
    let db = orm(db);
    let row = VaultRow::select()
        .filter(V::Id.eq(vault_id))
        .filter(V::WorkspaceId.eq(workspace))
        .filter(V::DeletedAt.is_null())
        .into_model::<VaultRow>()
        .one(&db)
        .await?
        .ok_or_else(|| PassError::not_found("vault", vault_id))?;
    let owner = row.owner_id.clone();
    let vault = Vault::from_row(row);
    if vault.is_personal() {
        if owner.as_deref() != Some(user_id) {
            return Err(PassError::not_found("vault", vault_id));
        }
        return Ok(VaultAccess {
            vault,
            role: Some("manager".to_owned()),
        });
    }
    let membership: Option<String> = members::Entity::find()
        .select_only()
        .column(M::Role)
        .filter(M::VaultId.eq(vault_id))
        .filter(M::UserId.eq(user_id))
        .into_tuple()
        .one(&db)
        .await?;
    match membership {
        Some(role) => Ok(VaultAccess {
            vault,
            role: Some(role),
        }),
        None if can_manage_all => Ok(VaultAccess { vault, role: None }),
        None => Err(PassError::not_found("vault", vault_id)),
    }
}

/// `assertVaultRole`: at least `minimum` (403 otherwise).
pub(crate) fn assert_vault_role(access: &VaultAccess, minimum: &str) -> PassResult<()> {
    let Some(role) = &access.role else {
        return Err(PassError::Forbidden(
            "You are not a member of this vault. Add yourself as a member to open it.".to_owned(),
        ));
    };
    if rank(role) < rank(minimum) {
        return Err(PassError::Forbidden(format!(
            "This needs the {minimum} role on the vault."
        )));
    }
    Ok(())
}

/// `assertVaultAdmin`: rename, delete or change who is in it.
pub(crate) fn assert_vault_admin(access: &VaultAccess, can_manage_all: bool) -> PassResult<()> {
    if access.vault.is_personal() {
        return Err(personal_vault_error());
    }
    if access.role.as_deref() != Some("manager") && !can_manage_all {
        return Err(PassError::Forbidden(
            "This needs the manager role on the vault.".to_owned(),
        ));
    }
    Ok(())
}

pub(crate) fn personal_vault_error() -> PassError {
    PassError::Forbidden("A personal vault cannot be shared, renamed or deleted.".to_owned())
}

/// `openPasswordVault`: the vault's KEK for one request.
pub(crate) async fn open_password_vault(
    db: &PgPool,
    keyring: &RootKeyring,
    vault_id: &str,
) -> PassResult<Key> {
    let wrapped: Option<String> = vaults::Entity::find()
        .select_only()
        .column(V::KekWrapped)
        .filter(V::Id.eq(vault_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let wrapped = wrapped.ok_or_else(|| PassError::not_found("vault", vault_id))?;
    Ok(unwrap_vault_key(keyring, vault_id, &wrapped)?)
}

/// `ensurePersonalVault`: created on first use; two racing requests both
/// end up with the one row the partial unique index lets in.
pub(crate) async fn ensure_personal_vault(
    db: &PgPool,
    workspace: Option<&str>,
    keyring: &RootKeyring,
    user_id: &str,
) -> PassResult<()> {
    let db = orm(db);
    let find = || {
        vaults::Entity::find()
            .select_only()
            .column(V::Id)
            .filter(V::WorkspaceId.eq(workspace))
            .filter(V::Kind.eq("personal"))
            .filter(V::OwnerId.eq(user_id))
            .filter(V::DeletedAt.is_null())
            .into_tuple::<String>()
            .one(&db)
    };
    if find().await?.is_some() {
        return Ok(());
    }
    let id = generate_id("wpk");
    let key = create_vault_key(keyring, &id)?;
    vaults::Entity::insert(vaults::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_of(workspace, "weldpass_vaults")?),
        kind: Set("personal".to_owned()),
        owner_id: Set(Some(user_id.to_owned())),
        name: Set("Personal".to_owned()),
        kek_wrapped: Set(key.kek_wrapped),
        root_key_version: Set(key.root_key_version.to_owned()),
        created_by: Set(Some(user_id.to_owned())),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&db)
    .await?;
    if find().await?.is_none() {
        return Err(PassError::not_found("vault", &id));
    }
    Ok(())
}

/// `listVaults`: personal first, then by name; with `passwords:manage`
/// every shared vault, the ones the caller is not in with a null role.
pub(crate) async fn list_vaults(
    db: &PgPool,
    workspace: Option<&str>,
    user_id: &str,
    can_manage_all: bool,
) -> PassResult<Vec<Value>> {
    let db = orm(db);
    let member = user_id.to_owned();
    // `m.vault_id = v.id and m.user_id = $2`.
    let membership: RelationDef = vaults::Entity::belongs_to(members::Entity)
        .from(V::Id)
        .to(M::VaultId)
        .on_condition(move |_, _| Condition::all().add(M::UserId.eq(member.clone())))
        .into();
    let rows = VaultRow::select()
        .column(M::Role)
        .join(JoinType::LeftJoin, membership)
        .filter(V::WorkspaceId.eq(workspace))
        .filter(V::DeletedAt.is_null())
        .filter(
            Condition::any()
                .add(
                    Condition::all()
                        .add(V::Kind.eq("personal"))
                        .add(V::OwnerId.eq(user_id)),
                )
                .add(
                    Condition::all().add(V::Kind.eq("shared")).add(
                        Condition::any()
                            .add(Expr::val(can_manage_all))
                            .add(M::Id.is_not_null()),
                    ),
                ),
        )
        .order_by_asc(V::Name)
        .into_model::<VaultWithRole>()
        .all(&db)
        .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.vault.id.clone()).collect();
    let (items, memberships) = if ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let items: Vec<(String, i64)> = weldpass_items::Entity::find()
            .select_only()
            .column(weldpass_items::Column::VaultId)
            .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
            .filter(weldpass_items::Column::VaultId.is_in(ids.clone()))
            .filter(weldpass_items::Column::DeletedAt.is_null())
            .group_by(weldpass_items::Column::VaultId)
            .into_tuple()
            .all(&db)
            .await?;
        let memberships: Vec<(String, i64)> = members::Entity::find()
            .select_only()
            .column(M::VaultId)
            .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
            .filter(M::VaultId.is_in(ids))
            .group_by(M::VaultId)
            .into_tuple()
            .all(&db)
            .await?;
        (items, memberships)
    };
    let count_of = |list: &[(String, i64)], id: &str| {
        list.iter()
            .find(|(vault, _)| vault == id)
            .map_or(0, |(_, n)| *n)
    };
    let mut summaries: Vec<(bool, Value)> = rows
        .into_iter()
        .map(|VaultWithRole { vault: row, role }| {
            let vault = Vault::from_row(row);
            let personal = vault.is_personal();
            let mut json = vault.json;
            json["role"] = if personal {
                json!("manager")
            } else {
                role.map_or(Value::Null, Value::String)
            };
            json["itemCount"] = json!(count_of(&items, &vault.id));
            json["memberCount"] = json!(if personal {
                1
            } else {
                count_of(&memberships, &vault.id)
            });
            (personal, json)
        })
        .collect();
    // A stable sort: personal first, the rest stay by name.
    summaries.sort_by_key(|(personal, _)| !*personal);
    Ok(summaries.into_iter().map(|(_, json)| json).collect())
}

/// `createSharedVault`: its creator is its first manager.
pub(crate) async fn create_shared_vault(
    db: &PgPool,
    workspace: Option<&str>,
    keyring: &RootKeyring,
    name: &str,
    description: Option<&str>,
    created_by: &str,
) -> PassResult<Vault> {
    let id = generate_id("wpk");
    let key = create_vault_key(keyring, &id)?;
    let db = orm(db);
    let row = vaults::Entity::insert(vaults::ActiveModel {
        id: Set(id.clone()),
        workspace_id: Set(workspace_of(workspace, "weldpass_vaults")?),
        kind: Set("shared".to_owned()),
        owner_id: Set(None),
        name: Set(name.to_owned()),
        description: Set(description.map(str::to_owned)),
        kek_wrapped: Set(key.kek_wrapped),
        root_key_version: Set(key.root_key_version.to_owned()),
        created_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&db)
    .await?;
    members::Entity::insert(members::ActiveModel {
        id: Set(generate_id("wpm")),
        vault_id: Set(id),
        user_id: Set(created_by.to_owned()),
        role: Set("manager".to_owned()),
        added_by: Set(Some(created_by.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(Vault::from_row(row.into()))
}

/// `updateVault`: the fields given.
#[allow(clippy::option_option)] // `description`: left out, null, or a text
pub(crate) async fn update_vault(
    db: &PgPool,
    vault_id: &str,
    name: Option<&str>,
    description: Option<Option<&str>>,
) -> PassResult<Vault> {
    let mut patch = vaults::ActiveModel {
        id: Unchanged(vault_id.to_owned()),
        ..Default::default()
    };
    if let Some(name) = name {
        patch.name = Set(name.to_owned());
    }
    if let Some(description) = description {
        patch.description = Set(description.map(str::to_owned));
    }
    patch.updated_at = Set(now());
    let row = vaults::Entity::update(patch).exec(&orm(db)).await?;
    Ok(Vault::from_row(row.into()))
}

/// `deleteVault`: soft, with its items; the members stay for a restore.
pub(crate) async fn delete_vault(db: &PgPool, vault_id: &str) -> PassResult<()> {
    let now = now();
    let db = orm(db);
    weldpass_items::Entity::update_many()
        .col_expr(weldpass_items::Column::DeletedAt, Expr::value(now))
        .col_expr(weldpass_items::Column::UpdatedAt, Expr::value(now))
        .filter(weldpass_items::Column::VaultId.eq(vault_id))
        .filter(weldpass_items::Column::DeletedAt.is_null())
        .exec(&db)
        .await?;
    vaults::Entity::update_many()
        .col_expr(V::DeletedAt, Expr::value(now))
        .col_expr(V::UpdatedAt, Expr::value(now))
        .filter(V::Id.eq(vault_id))
        .exec(&db)
        .await?;
    Ok(())
}

/// An active, internal workspace member (`status = 'ACTIVE'`,
/// `memberType = 'INTERNAL'`, not deleted).
fn teammate() -> Condition {
    use workspace_members::Column as W;
    Condition::all()
        .add(W::Status.eq("ACTIVE"))
        .add(W::MemberType.eq("INTERNAL"))
        .add(W::DeletedAt.is_null())
}

/// A vault member as `listVaultMembers` returns it: the picture is filled in
/// from the account afterwards.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberRow {
    user_id: String,
    role: String,
    name: Option<String>,
    email: Option<String>,
    #[sea_orm(skip)]
    picture: Option<String>,
    added_by: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
}

/// `listTeammates`: active, internal workspace members, with their account
/// pictures (`master`).
pub(crate) async fn list_teammates(db: &PgPool, master: Option<&PgPool>) -> PassResult<Vec<Value>> {
    use workspace_members::Column as W;
    let teammates: Vec<(String, Option<String>, Option<String>)> =
        workspace_members::Entity::find()
            .select_only()
            .columns([W::UserId, W::Name, W::Email])
            .filter(teammate())
            .order_by_asc(W::Name)
            .order_by_asc(W::Email)
            .into_tuple()
            .all(&orm(db))
            .await?;
    let mut rows: Vec<Value> = teammates
        .into_iter()
        .map(|(user_id, name, email)| {
            json!({ "userId": user_id, "name": name, "email": email, "picture": null })
        })
        .collect();
    weldsuite_db::overlay_account_pictures(master, &mut rows, "userId", "picture").await;
    Ok(rows)
}

/// `firstNonTeammate`: the first of `user_ids` a vault cannot be shared
/// with, or `None` when all of them are teammates.
pub(crate) async fn first_non_teammate(
    db: &PgPool,
    user_ids: &[String],
) -> PassResult<Option<String>> {
    if user_ids.is_empty() {
        return Ok(None);
    }
    let found: Vec<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.is_in(user_ids.iter().map(String::as_str)))
        .filter(teammate())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(user_ids.iter().find(|id| !found.contains(id)).cloned())
}

/// `listVaultMembers`: by name, then when they joined, with their account
/// pictures (`master`).
pub(crate) async fn list_vault_members(
    db: &PgPool,
    master: Option<&PgPool>,
    vault_id: &str,
) -> PassResult<Vec<Value>> {
    let rows = members::Entity::find()
        .select_only()
        .columns([M::UserId, M::Role])
        .columns([
            workspace_members::Column::Name,
            workspace_members::Column::Email,
        ])
        .columns([M::AddedBy, M::CreatedAt])
        .join(
            JoinType::LeftJoin,
            members::Entity::belongs_to(workspace_members::Entity)
                .from(M::UserId)
                .to(workspace_members::Column::UserId)
                .into(),
        )
        .filter(M::VaultId.eq(vault_id))
        .order_by_asc(workspace_members::Column::Name)
        .order_by_asc(M::CreatedAt)
        .into_model::<MemberRow>()
        .all(&orm(db))
        .await?;
    let mut rows: Vec<Value> = rows.iter().map(row_json).collect();
    weldsuite_db::overlay_account_pictures(master, &mut rows, "userId", "picture").await;
    Ok(rows)
}

/// `addVaultMember`: a teammate of this workspace, or their new role if
/// they are in already. `true` when added.
pub(crate) async fn add_vault_member(
    db: &PgPool,
    vault_id: &str,
    user_id: &str,
    role: &str,
    added_by: &str,
) -> PassResult<bool> {
    let pool = db;
    let db = orm(pool);
    let teammate: Option<String> = workspace_members::Entity::find()
        .select_only()
        .column(workspace_members::Column::UserId)
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(teammate())
        .into_tuple()
        .one(&db)
        .await?;
    if teammate.is_none() {
        return Err(PassError::not_found("vault member", user_id));
    }
    let existing: Option<String> = members::Entity::find()
        .select_only()
        .column(M::Id)
        .filter(M::VaultId.eq(vault_id))
        .filter(M::UserId.eq(user_id))
        .into_tuple()
        .one(&db)
        .await?;
    if existing.is_some() {
        set_vault_member_role(pool, vault_id, user_id, role).await?;
        return Ok(false);
    }
    members::Entity::insert(members::ActiveModel {
        id: Set(generate_id("wpm")),
        vault_id: Set(vault_id.to_owned()),
        user_id: Set(user_id.to_owned()),
        role: Set(role.to_owned()),
        added_by: Set(Some(added_by.to_owned())),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&db)
    .await?;
    Ok(true)
}

async fn require_membership(
    db: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> PassResult<(String, String)> {
    let row: Option<(String, String)> = members::Entity::find()
        .select_only()
        .columns([M::Id, M::Role])
        .filter(M::VaultId.eq(vault_id))
        .filter(M::UserId.eq(user_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    row.ok_or_else(|| PassError::not_found("vault member", user_id))
}

/// `assertNotLastManager`: a vault always keeps one manager.
async fn assert_not_last_manager(db: &PgPool, vault_id: &str, user_id: &str) -> PassResult<()> {
    let managers: Vec<String> = members::Entity::find()
        .select_only()
        .column(M::UserId)
        .filter(M::VaultId.eq(vault_id))
        .filter(M::Role.eq("manager"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    if managers.len() == 1 && managers[0] == user_id {
        return Err(PassError::Conflict(
            "This is the vault’s only manager. Make someone else a manager first.".to_owned(),
        ));
    }
    Ok(())
}

/// `setVaultMemberRole`: the role before.
pub(crate) async fn set_vault_member_role(
    db: &PgPool,
    vault_id: &str,
    user_id: &str,
    role: &str,
) -> PassResult<String> {
    let (membership, previous) = require_membership(db, vault_id, user_id).await?;
    if previous == "manager" && role != "manager" {
        assert_not_last_manager(db, vault_id, user_id).await?;
    }
    members::Entity::update_many()
        .col_expr(M::Role, Expr::value(role))
        .col_expr(M::UpdatedAt, Expr::value(now()))
        .filter(M::Id.eq(membership))
        .exec(&orm(db))
        .await?;
    Ok(previous)
}

/// `removeVaultMember`.
pub(crate) async fn remove_vault_member(
    db: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> PassResult<()> {
    let (membership, role) = require_membership(db, vault_id, user_id).await?;
    if role == "manager" {
        assert_not_last_manager(db, vault_id, user_id).await?;
    }
    members::Entity::delete_many()
        .filter(M::Id.eq(membership))
        .exec(&orm(db))
        .await?;
    Ok(())
}
