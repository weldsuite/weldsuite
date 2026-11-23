//! Mail folders (`@weldsuite/mail-domain/folders`): a mailbox's IMAP-style
//! folder tree, beside its labels. System folders (`isSystem`) can be
//! recoloured, repositioned or hidden, but keep their name, type, parent and
//! path, which provider sync matches on, and cannot be deleted.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder,
};
use serde_json::Value;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{enums, mail_folders};

/// `MailFolderError`.
#[derive(Debug)]
pub enum MailFolderError {
    NotFound,
    /// `SYSTEM_FOLDER_IMMUTABLE`, with its message.
    SystemFolderImmutable(String),
    Db(DbErr),
}

impl From<DbErr> for MailFolderError {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

fn js(model: mail_folders::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// A position as the `integer` column holds it; out of range is Postgres's
/// error in TypeScript.
fn position(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Custom(format!("position {value} out of range")))
}

/// `listFolders(db, accountId, accessibleAccountIds)`: by position, then
/// name. `accessible` restricts the list to those mailboxes (an empty list
/// is none).
pub async fn list_folders(
    db: &PgPool,
    account_id: Option<&str>,
    accessible: Option<&[String]>,
) -> Result<Vec<Value>, DbErr> {
    use mail_folders::Column;
    let mut conditions = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(account) = account_id.filter(|a| !a.is_empty()) {
        conditions = conditions.add(Column::AccountId.eq(account));
    }
    if let Some(accessible) = accessible {
        conditions = if accessible.is_empty() {
            conditions.add(Expr::cust("false"))
        } else {
            conditions.add(Column::AccountId.is_in(accessible.iter().map(String::as_str)))
        };
    }
    let rows = mail_folders::Entity::find()
        .filter(conditions)
        .order_by_asc(Column::Position)
        .order_by_asc(Column::Name)
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().map(js).collect())
}

async fn live_folder(db: &PgPool, id: &str) -> Result<Option<mail_folders::Model>, DbErr> {
    mail_folders::Entity::find()
        .filter(mail_folders::Column::Id.eq(id))
        .filter(mail_folders::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// `getFolder(db, id)`: a live folder.
pub async fn get_folder(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(live_folder(db, id).await?.map(js))
}

/// `FolderInput` (a custom folder: the public API creates no other kind).
#[derive(Debug, Clone, Default)]
pub struct NewFolder {
    pub account_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub path: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub position: Option<i64>,
}

/// `createFolder(db, { ...data, type: 'custom' })`.
pub async fn create_folder(db: &PgPool, data: &NewFolder) -> Result<Value, DbErr> {
    let id = generate_id("mfld");
    let now = utc_now();
    let conn = orm(db);
    mail_folders::Entity::insert(mail_folders::ActiveModel {
        id: Set(id.clone()),
        account_id: Set(data.account_id.clone()),
        name: Set(data.name.clone()),
        type_: Set(enums::MailFolderType::Custom),
        parent_id: Set(data.parent_id.clone()),
        path: Set(data.path.clone()),
        color: Set(data.color.clone()),
        icon: Set(data.icon.clone()),
        position: Set(position(data.position.unwrap_or(0))?),
        is_selectable: Set(true),
        is_system: Set(Some(false)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&conn)
    .await?;
    mail_folders::Entity::find_by_id(id)
        .one(&conn)
        .await?
        .map(js)
        .ok_or_else(|| DbErr::RecordNotFound("the folder just created".to_owned()))
}

/// `Partial<FolderInput>` as the public API patches it: `None` is left out.
#[derive(Debug, Clone, Default)]
pub struct FolderPatch {
    pub name: Option<String>,
    pub parent_id: Option<String>,
    pub path: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub position: Option<i64>,
}

/// `updateFolder(db, id, data)`: the folder after the update.
pub async fn update_folder(
    db: &PgPool,
    id: &str,
    patch: &FolderPatch,
) -> Result<Value, MailFolderError> {
    use mail_folders::Column;
    let Some(existing) = live_folder(db, id).await? else {
        return Err(MailFolderError::NotFound);
    };
    if existing.is_system == Some(true) {
        let locked = [
            ("name", patch.name.is_some()),
            ("type", false),
            ("parentId", patch.parent_id.is_some()),
            ("path", patch.path.is_some()),
        ];
        if let Some((key, _)) = locked.iter().find(|(_, set)| *set) {
            return Err(MailFolderError::SystemFolderImmutable(format!(
                "Field \"{key}\" cannot be changed on a system folder."
            )));
        }
    }
    let conn = orm(db);
    let mut update = mail_folders::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
        .filter(Column::Id.eq(id));
    if let Some(name) = &patch.name {
        update = update.col_expr(Column::Name, Expr::value(name.clone()));
    }
    if let Some(parent) = &patch.parent_id {
        update = update.col_expr(Column::ParentId, Expr::value(parent.clone()));
    }
    if let Some(path) = &patch.path {
        update = update.col_expr(Column::Path, Expr::value(path.clone()));
    }
    if let Some(color) = &patch.color {
        update = update.col_expr(Column::Color, Expr::value(color.clone()));
    }
    if let Some(icon) = &patch.icon {
        update = update.col_expr(Column::Icon, Expr::value(icon.clone()));
    }
    if let Some(value) = patch.position {
        update = update.col_expr(Column::Position, Expr::value(position(value)?));
    }
    update.exec(&conn).await?;
    let after = mail_folders::Entity::find_by_id(id.to_owned())
        .one(&conn)
        .await?
        .ok_or(MailFolderError::NotFound)?;
    Ok(js(after))
}

/// `softDeleteFolder(db, id)`: the folder as it was, `None` when there was
/// no live one.
pub async fn soft_delete_folder(db: &PgPool, id: &str) -> Result<Option<Value>, MailFolderError> {
    use mail_folders::Column;
    let Some(existing) = live_folder(db, id).await? else {
        return Ok(None);
    };
    if existing.is_system == Some(true) {
        return Err(MailFolderError::SystemFolderImmutable(
            "System folders cannot be deleted.".to_owned(),
        ));
    }
    let now = utc_now();
    mail_folders::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(Some(now)))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(Some(js(existing)))
}
