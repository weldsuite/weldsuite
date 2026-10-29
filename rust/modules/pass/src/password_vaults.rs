//! Password-manager vaults and who may open them (`password-vaults.ts`).
//!
//! - personal vault: its owner, nobody else; `passwords:manage` does not get
//!   in either, the id resolves to nothing.
//! - shared vault: its members at their role; `passwords:manage` sees that it
//!   exists and can fix its membership, but reading an item takes joining.
//!
//! A vault the caller cannot see is a 404, never a 403.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::envelope::{Key, RootKeyring, create_vault_key, unwrap_vault_key};
use crate::{PassError, PassResult, dated, now};

macro_rules! vault_json {
    () => {
        "jsonb_build_object('id', v.id, 'kind', v.kind, 'ownerId', v.owner_id, 'name', v.name, \
         'description', v.description, 'createdBy', v.created_by, 'createdAt', v.created_at, \
         'updatedAt', v.updated_at)"
    };
}

const TIMES: [&str; 2] = ["createdAt", "updatedAt"];

/// A vault's client-safe columns (`vaultColumns`).
#[derive(Debug, Clone)]
pub(crate) struct Vault {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) json: Value,
}

impl Vault {
    fn from_row(row: Value) -> Self {
        let row = dated(row, &TIMES);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            kind: text("kind"),
            name: text("name"),
            json: row,
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
    let row: Option<(Value, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        vault_json!(),
        ", v.owner_id from weldpass_vaults v where v.id = $1 and v.workspace_id = $2 \
         and v.deleted_at is null limit 1"
    ))
    .bind(vault_id)
    .bind(workspace)
    .fetch_optional(db)
    .await?;
    let (row, owner) = row.ok_or_else(|| PassError::not_found("vault", vault_id))?;
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
    let membership: Option<String> = sqlx::query_scalar(
        "select role from weldpass_vault_members where vault_id = $1 and user_id = $2 limit 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(db)
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
    let wrapped: Option<String> =
        sqlx::query_scalar("select kek_wrapped from weldpass_vaults where id = $1 limit 1")
            .bind(vault_id)
            .fetch_optional(db)
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
    let find = || {
        sqlx::query_scalar::<_, String>(
            "select id from weldpass_vaults where workspace_id = $1 and kind = 'personal' \
             and owner_id = $2 and deleted_at is null limit 1",
        )
        .bind(workspace)
        .bind(user_id)
        .fetch_optional(db)
    };
    if find().await?.is_some() {
        return Ok(());
    }
    let id = generate_id("wpk");
    let key = create_vault_key(keyring, &id)?;
    sqlx::query(
        "insert into weldpass_vaults \
         (id, workspace_id, kind, owner_id, name, kek_wrapped, root_key_version, created_by) \
         values ($1, $2, 'personal', $3, 'Personal', $4, $5, $3) on conflict do nothing",
    )
    .bind(&id)
    .bind(workspace)
    .bind(user_id)
    .bind(&key.kek_wrapped)
    .bind(key.root_key_version)
    .execute(db)
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
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        vault_json!(),
        ", m.role from weldpass_vaults v \
         left join weldpass_vault_members m on m.vault_id = v.id and m.user_id = $2 \
         where v.workspace_id = $1 and v.deleted_at is null \
         and ((v.kind = 'personal' and v.owner_id = $2) or (v.kind = 'shared' and ($3 or m.id is not null))) \
         order by v.name asc"
    ))
    .bind(workspace)
    .bind(user_id)
    .bind(can_manage_all)
    .fetch_all(db)
    .await?;
    let ids: Vec<String> = rows
        .iter()
        .map(|(row, _)| row["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    let counts = |sql: &'static str| {
        let ids = ids.clone();
        async move {
            if ids.is_empty() {
                return Ok::<Vec<(String, i64)>, sqlx::Error>(Vec::new());
            }
            sqlx::query_as::<_, (String, i64)>(sql)
                .bind(ids)
                .fetch_all(db)
                .await
        }
    };
    let items = counts(
        "select vault_id, count(*) from weldpass_items where vault_id = any($1) \
         and deleted_at is null group by vault_id",
    )
    .await?;
    let members = counts(
        "select vault_id, count(*) from weldpass_vault_members where vault_id = any($1) group by vault_id",
    )
    .await?;
    let count_of = |list: &[(String, i64)], id: &str| {
        list.iter()
            .find(|(vault, _)| vault == id)
            .map_or(0, |(_, n)| *n)
    };
    let mut summaries: Vec<(bool, Value)> = rows
        .into_iter()
        .map(|(row, role)| {
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
                count_of(&members, &vault.id)
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
    let row: Value = sqlx::query_scalar(concat!(
        "with v as (insert into weldpass_vaults \
         (id, workspace_id, kind, owner_id, name, description, kek_wrapped, root_key_version, created_by) \
         values ($1, $2, 'shared', null, $3, $4, $5, $6, $7) returning *) select ",
        vault_json!(),
        " from v"
    ))
    .bind(&id)
    .bind(workspace)
    .bind(name)
    .bind(description)
    .bind(&key.kek_wrapped)
    .bind(key.root_key_version)
    .bind(created_by)
    .fetch_one(db)
    .await?;
    sqlx::query(
        "insert into weldpass_vault_members (id, vault_id, user_id, role, added_by) \
         values ($1, $2, $3, 'manager', $3)",
    )
    .bind(generate_id("wpm"))
    .bind(&id)
    .bind(created_by)
    .execute(db)
    .await?;
    Ok(Vault::from_row(row))
}

/// `updateVault`: the fields given.
#[allow(clippy::option_option)] // `description`: left out, null, or a text
pub(crate) async fn update_vault(
    db: &PgPool,
    vault_id: &str,
    name: Option<&str>,
    description: Option<Option<&str>>,
) -> PassResult<Vault> {
    let row: Value = sqlx::query_scalar(concat!(
        "with v as (update weldpass_vaults set name = coalesce($2, name), \
         description = case when $3 then $4 else description end, updated_at = $5::timestamptz \
         where id = $1 returning *) select ",
        vault_json!(),
        " from v"
    ))
    .bind(vault_id)
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(Vault::from_row(row))
}

/// `deleteVault`: soft, with its items; the members stay for a restore.
pub(crate) async fn delete_vault(db: &PgPool, vault_id: &str) -> PassResult<()> {
    let now = now();
    sqlx::query(
        "update weldpass_items set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where vault_id = $1 and deleted_at is null",
    )
    .bind(vault_id)
    .bind(&now)
    .execute(db)
    .await?;
    sqlx::query(
        "update weldpass_vaults set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1",
    )
    .bind(vault_id)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

/// `listTeammates`: active, internal workspace members.
pub(crate) async fn list_teammates(db: &PgPool) -> PassResult<Vec<Value>> {
    Ok(sqlx::query_scalar(
        "select jsonb_build_object('userId', w.user_id, 'name', w.name, 'email', w.email, \
         'picture', w.picture) from workspace_members w \
         where w.status = 'ACTIVE' and w.member_type = 'INTERNAL' and w.deleted_at is null \
         order by w.name asc, w.email asc",
    )
    .fetch_all(db)
    .await?)
}

/// `listVaultMembers`: by name, then when they joined.
pub(crate) async fn list_vault_members(db: &PgPool, vault_id: &str) -> PassResult<Vec<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('userId', m.user_id, 'role', m.role, 'name', w.name, \
         'email', w.email, 'picture', w.picture, 'addedBy', m.added_by, 'createdAt', m.created_at) \
         from weldpass_vault_members m left join workspace_members w on w.user_id = m.user_id \
         where m.vault_id = $1 order by w.name asc, m.created_at asc",
    )
    .bind(vault_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| dated(row, &["createdAt"]))
        .collect())
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
    let teammate: Option<String> = sqlx::query_scalar(
        "select user_id from workspace_members where user_id = $1 and status = 'ACTIVE' \
         and member_type = 'INTERNAL' and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if teammate.is_none() {
        return Err(PassError::not_found("vault member", user_id));
    }
    let existing: Option<String> = sqlx::query_scalar(
        "select id from weldpass_vault_members where vault_id = $1 and user_id = $2 limit 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        set_vault_member_role(db, vault_id, user_id, role).await?;
        return Ok(false);
    }
    sqlx::query(
        "insert into weldpass_vault_members (id, vault_id, user_id, role, added_by) \
         values ($1, $2, $3, $4, $5) on conflict do nothing",
    )
    .bind(generate_id("wpm"))
    .bind(vault_id)
    .bind(user_id)
    .bind(role)
    .bind(added_by)
    .execute(db)
    .await?;
    Ok(true)
}

async fn require_membership(
    db: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> PassResult<(String, String)> {
    let row: Option<(String, String)> = sqlx::query_as(
        "select id, role from weldpass_vault_members where vault_id = $1 and user_id = $2 limit 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    row.ok_or_else(|| PassError::not_found("vault member", user_id))
}

/// `assertNotLastManager`: a vault always keeps one manager.
async fn assert_not_last_manager(db: &PgPool, vault_id: &str, user_id: &str) -> PassResult<()> {
    let managers: Vec<String> = sqlx::query_scalar(
        "select user_id from weldpass_vault_members where vault_id = $1 and role = 'manager'",
    )
    .bind(vault_id)
    .fetch_all(db)
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
    sqlx::query(
        "update weldpass_vault_members set role = $2, updated_at = $3::timestamptz where id = $1",
    )
    .bind(&membership)
    .bind(role)
    .bind(now())
    .execute(db)
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
    sqlx::query("delete from weldpass_vault_members where id = $1")
        .bind(&membership)
        .execute(db)
        .await?;
    Ok(())
}
