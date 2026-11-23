//! Who a WeldDrive item is open to, and the per-person shares behind it
//! (the "Shares" half of `packages/domains/core/src/drive-access.ts`): the
//! Share dialog's summary, sharing and unsharing, "Shared with me", and the
//! access fields every Drive read adds to its rows.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QueryOrder, QuerySelect, RelationDef, Select,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{drive_shares, files, folders, workspace_members};

use crate::drive_access::{
    DriveAccessIndex, DriveFile, DriveFileRef, DriveFolderRef, DriveGeneralAccess, DriveRole,
    ancestor_folder_ids, effective_file_access, effective_folder_access, effective_general_access,
    file_role, folder_role,
};
use crate::files::{js, timestamptz_of};

impl DriveFolderRef {
    /// Build from a `folders` row as Drizzle returns it.
    pub fn from_row(row: &Value) -> Self {
        let text = |key: &str| row[key].as_str().map(str::to_owned);
        Self {
            id: text("id").unwrap_or_default(),
            parent_id: text("parentId"),
            created_by_id: text("createdById"),
            general_access: DriveGeneralAccess::parse(
                row["generalAccess"].as_str().unwrap_or_default(),
            ),
        }
    }
}

impl DriveFileRef {
    /// Build from a `files` row as Drizzle returns it (or any row with its
    /// camelCase keys).
    pub fn from_row(row: &Value) -> Self {
        DriveFile::from_row(row.clone()).r#ref
    }
}

fn with_access(mut row: Value, role: DriveRole, effective: DriveGeneralAccess) -> Value {
    if let Value::Object(fields) = &mut row {
        fields.insert("accessRole".to_owned(), json!(role.as_str()));
        fields.insert("effectiveAccess".to_owned(), json!(effective.as_str()));
    }
    row
}

/// `rows` the caller may see, each with their role on it and the access in
/// force (`withFileAccess`).
pub fn with_file_access(index: &DriveAccessIndex, rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .filter_map(|row| {
            let file = DriveFileRef::from_row(&row);
            let role = file_role(index, &file)?;
            Some(with_access(row, role, effective_file_access(index, &file)))
        })
        .collect()
}

/// `rows` the caller may see, each with their role on it and the access in
/// force (`withFolderAccess`).
pub fn with_folder_access(index: &DriveAccessIndex, rows: Vec<Value>) -> Vec<Value> {
    rows.into_iter()
        .filter_map(|row| {
            let folder = DriveFolderRef::from_row(&row);
            let role = folder_role(index, &folder)?;
            Some(with_access(
                row,
                role,
                effective_folder_access(index, &folder),
            ))
        })
        .collect()
}

/// A Drive item addressed by kind and id (`DriveItemRef`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveItem<'a> {
    File(&'a str),
    Folder(&'a str),
}

impl<'a> DriveItem<'a> {
    fn file_id(self) -> Option<&'a str> {
        match self {
            Self::File(id) => Some(id),
            Self::Folder(_) => None,
        }
    }

    fn folder_id(self) -> Option<&'a str> {
        match self {
            Self::Folder(id) => Some(id),
            Self::File(_) => None,
        }
    }
}

/// `ds.file_id = $1` or `ds.folder_id = $1`: the shares on `item`.
fn on_item(item: DriveItem<'_>) -> Condition {
    Condition::all().add(match item {
        DriveItem::File(id) => drive_shares::Column::FileId.eq(id),
        DriveItem::Folder(id) => drive_shares::Column::FolderId.eq(id),
    })
}

/// `left join workspace_members wm on wm.user_id = ds.user_id and
/// wm.deleted_at is null`: the person a share is with.
fn member() -> RelationDef {
    drive_shares::Entity::belongs_to(workspace_members::Entity)
        .from(drive_shares::Column::UserId)
        .to(workspace_members::Column::UserId)
        .on_condition(|_, member| {
            Condition::all().add(sea_orm::ExprTrait::is_null(Expr::col((
                member,
                workspace_members::Column::DeletedAt,
            ))))
        })
        .into()
}

/// A share with its person: `userId`, `role`, `sharedBy`, `createdAt`,
/// `name`, `email`, then (inherited shares) `folderId` and `folderName`.
#[derive(Debug, FromQueryResult)]
struct ShareRow {
    user_id: String,
    role: String,
    shared_by: String,
    created_at: OffsetDateTime,
    name: Option<String>,
    email: Option<String>,
}

impl ShareRow {
    /// The share's columns and its person's, oldest share first.
    fn select() -> Select<drive_shares::Entity> {
        drive_shares::Entity::find()
            .select_only()
            .columns([
                drive_shares::Column::UserId,
                drive_shares::Column::Role,
                drive_shares::Column::SharedBy,
                drive_shares::Column::CreatedAt,
            ])
            .columns([
                workspace_members::Column::Name,
                workspace_members::Column::Email,
            ])
            .join(JoinType::LeftJoin, member())
            .order_by_asc(drive_shares::Column::CreatedAt)
    }

    /// `jsonb_build_object('userId', …, 'picture', null)`.
    fn into_json(self) -> Map<String, Value> {
        let mut row = Map::new();
        row.insert("userId".to_owned(), json!(self.user_id));
        row.insert("role".to_owned(), json!(self.role));
        row.insert("sharedBy".to_owned(), json!(self.shared_by));
        row.insert("createdAt".to_owned(), json!(iso_timestamp(self.created_at)));
        row.insert("name".to_owned(), json!(self.name));
        row.insert("email".to_owned(), json!(self.email));
        row.insert("picture".to_owned(), Value::Null);
        row
    }
}

/// An inherited share: [`ShareRow`] and the folder it is on.
#[derive(Debug, FromQueryResult)]
struct InheritedShareRow {
    #[sea_orm(nested)]
    share: ShareRow,
    folder_id: Option<String>,
    folder_name: String,
}

/// The people an item is shared with directly, oldest first
/// (`listItemShares`). `picture` is null here: avatars are account pictures,
/// which [`describe_sharing`] resolves.
pub async fn list_item_shares(db: &PgPool, item: DriveItem<'_>) -> Result<Vec<Value>, DbErr> {
    let rows = ShareRow::select()
        .filter(on_item(item))
        .into_model::<ShareRow>()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| Value::Object(row.into_json()))
        .collect())
}

/// The people who reach an item through a share on a folder above it
/// (`listInheritedShares`). `picture` is null here, as in
/// [`list_item_shares`].
pub async fn list_inherited_shares(
    db: &PgPool,
    folder_ids: &[String],
) -> Result<Vec<Value>, DbErr> {
    if folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = ShareRow::select()
        .column_as(drive_shares::Column::FolderId, "folder_id")
        .column_as(folders::Column::Name, "folder_name")
        .join(
            JoinType::InnerJoin,
            drive_shares::Entity::belongs_to(folders::Entity)
                .from(drive_shares::Column::FolderId)
                .to(folders::Column::Id)
                .into(),
        )
        .filter(drive_shares::Column::FolderId.is_in(folder_ids))
        .into_model::<InheritedShareRow>()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut share = row.share.into_json();
            share.insert("folderId".to_owned(), json!(row.folder_id));
            share.insert("folderName".to_owned(), json!(row.folder_name));
            Value::Object(share)
        })
        .collect())
}

/// What [`upsert_share`] is given.
#[derive(Debug, Clone, Copy)]
pub struct NewShare<'a> {
    pub user_id: &'a str,
    pub role: &'a str,
    pub shared_by: &'a str,
    /// `new Date()` as an ISO string.
    pub now: &'a str,
}

/// Share an item with `share.user_id` at `share.role`, or change the role
/// they already have. The role they had before, `None` for a new share
/// (`upsertShare`).
pub async fn upsert_share(
    db: &PgPool,
    item: DriveItem<'_>,
    share: NewShare<'_>,
) -> Result<Option<String>, DbErr> {
    let db = orm(db);
    let existing: Option<(String, String)> = drive_shares::Entity::find()
        .select_only()
        .columns([drive_shares::Column::Id, drive_shares::Column::Role])
        .filter(on_item(item).add(drive_shares::Column::UserId.eq(share.user_id)))
        .into_tuple()
        .one(&db)
        .await?;
    if let Some((id, role)) = existing {
        if role != share.role {
            drive_shares::Entity::update_many()
                .col_expr(drive_shares::Column::Role, Expr::value(share.role))
                .col_expr(
                    drive_shares::Column::UpdatedAt,
                    Expr::value(timestamptz_of(share.now)?),
                )
                .filter(drive_shares::Column::Id.eq(id))
                .exec(&db)
                .await?;
        }
        return Ok(Some(role));
    }
    let now = timestamptz_of(share.now)?;
    drive_shares::Entity::insert(drive_shares::ActiveModel {
        id: Set(generate_id("dsh")),
        file_id: Set(item.file_id().map(str::to_owned)),
        folder_id: Set(item.folder_id().map(str::to_owned)),
        user_id: Set(share.user_id.to_owned()),
        role: Set(share.role.to_owned()),
        shared_by: Set(share.shared_by.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
    })
    .exec_without_returning(&db)
    .await?;
    Ok(None)
}

/// Stop sharing an item with `user_id`: the role they had, or `None` when it
/// was not shared with them (`removeShare`).
pub async fn remove_share(
    db: &PgPool,
    item: DriveItem<'_>,
    user_id: &str,
) -> Result<Option<String>, DbErr> {
    let removed = drive_shares::Entity::delete_many()
        .filter(on_item(item).add(drive_shares::Column::UserId.eq(user_id)))
        .exec_with_returning(&orm(db))
        .await?;
    Ok(removed.into_iter().next().map(|share| share.role))
}

/// A Drive item with the fields its sharing summary needs
/// (`DriveSharingTarget`).
#[derive(Debug, Clone, Copy)]
pub struct SharingTarget<'a> {
    pub item: DriveItem<'a>,
    pub owner_id: Option<&'a str>,
    pub general_access: DriveGeneralAccess,
    pub parent_id: Option<&'a str>,
}

async fn member_person(db: &PgPool, user_id: &str) -> Result<Value, DbErr> {
    let member: Option<(Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::Name,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let (name, email) = member.unwrap_or_default();
    Ok(json!({ "userId": user_id, "name": name, "email": email, "picture": null }))
}

/// Who an item is open to, for a caller whose role on it is `access_role`
/// (`describeSharing`). Everyone's `picture` is their account picture,
/// read from `master` in one lookup.
pub async fn describe_sharing(
    db: &PgPool,
    master: Option<&PgPool>,
    index: &DriveAccessIndex,
    target: SharingTarget<'_>,
    access_role: DriveRole,
) -> Result<Value, DbErr> {
    let mut shares = list_item_shares(db, target.item).await?;
    let mut inherited =
        list_inherited_shares(db, &ancestor_folder_ids(index, target.parent_id)).await?;
    let mut owner = match target.owner_id.filter(|id| !id.is_empty()) {
        Some(owner_id) => member_person(db, owner_id).await?,
        None => Value::Null,
    };
    let pictures = weldsuite_db::AccountPictures::load(
        master,
        shares
            .iter()
            .chain(&inherited)
            .chain(std::iter::once(&owner))
            .filter_map(|person| person["userId"].as_str()),
    )
    .await;
    pictures.apply_all(
        shares.iter_mut().chain(inherited.iter_mut()),
        "userId",
        "picture",
    );
    if owner.is_object() {
        pictures.apply(&mut owner, "userId", "picture");
    }
    let effective = effective_general_access(index, target.general_access, target.parent_id);
    Ok(json!({
        "owner": owner,
        "generalAccess": target.general_access.as_str(),
        "effectiveGeneralAccess": effective.as_str(),
        "accessRole": access_role.as_str(),
        "shares": shares,
        "inherited": inherited,
    }))
}

/// One item of "Shared with me": the row and the share that brought it.
#[derive(Debug, Clone, PartialEq)]
pub struct SharedItem {
    /// The `files` or `folders` row, as Drizzle returns it.
    pub row: Value,
    pub role: String,
    pub shared_by: String,
    /// `toISOString()` of the share's `created_at`.
    pub shared_at: String,
}

/// The share that brought an item to "Shared with me".
#[derive(Debug, FromQueryResult)]
struct ShareOf {
    #[sea_orm(alias = "share_role")]
    role: String,
    #[sea_orm(alias = "share_shared_by")]
    shared_by: String,
    #[sea_orm(alias = "share_created_at")]
    created_at: OffsetDateTime,
}

impl ShareOf {
    /// `ds.role`, `ds.shared_by` and `ds.created_at` next to the item's
    /// columns.
    fn columns<E: EntityTrait>(select: Select<E>) -> Select<E> {
        select
            .column_as(drive_shares::Column::Role, "share_role")
            .column_as(drive_shares::Column::SharedBy, "share_shared_by")
            .column_as(drive_shares::Column::CreatedAt, "share_created_at")
    }

    /// `ds.user_id = $1 and ds.shared_by <> $1`, oldest share first.
    fn with(user_id: &str) -> Condition {
        Condition::all()
            .add(drive_shares::Column::UserId.eq(user_id))
            .add(drive_shares::Column::SharedBy.ne(user_id))
    }

    fn item(self, row: Value) -> SharedItem {
        SharedItem {
            row,
            role: self.role,
            shared_by: self.shared_by,
            shared_at: iso_timestamp(self.created_at),
        }
    }
}

#[derive(Debug, FromQueryResult)]
struct SharedFile {
    #[sea_orm(nested)]
    item: files::Model,
    #[sea_orm(nested)]
    share: ShareOf,
}

#[derive(Debug, FromQueryResult)]
struct SharedFolder {
    #[sea_orm(nested)]
    item: folders::Model,
    #[sea_orm(nested)]
    share: ShareOf,
}

/// Oldest share first in SQL, then reversed: newest first.
fn shared_items(mut items: Vec<SharedItem>) -> Vec<SharedItem> {
    items.reverse();
    items
}

/// What "Shared with me" lists: live items someone else shared with
/// `user_id`, newest share first (`listSharedWithUser`).
pub async fn list_shared_with_user(
    db: &PgPool,
    user_id: &str,
) -> Result<(Vec<SharedItem>, Vec<SharedItem>), DbErr> {
    let db = orm(db);
    let files = ShareOf::columns(files::Entity::find())
        .join(
            JoinType::InnerJoin,
            files::Entity::belongs_to(drive_shares::Entity)
                .from(files::Column::Id)
                .to(drive_shares::Column::FileId)
                .into(),
        )
        .filter(ShareOf::with(user_id).add(files::Column::DeletedAt.is_null()))
        .order_by_asc(drive_shares::Column::CreatedAt)
        .into_model::<SharedFile>()
        .all(&db)
        .await?
        .into_iter()
        .map(|row| Ok(row.share.item(js(row.item)?)))
        .collect::<Result<Vec<_>, DbErr>>()?;
    let folders = ShareOf::columns(folders::Entity::find())
        .join(
            JoinType::InnerJoin,
            folders::Entity::belongs_to(drive_shares::Entity)
                .from(folders::Column::Id)
                .to(drive_shares::Column::FolderId)
                .into(),
        )
        .filter(ShareOf::with(user_id).add(folders::Column::DeletedAt.is_null()))
        .order_by_asc(drive_shares::Column::CreatedAt)
        .into_model::<SharedFolder>()
        .all(&db)
        .await?
        .into_iter()
        .map(|row| Ok(row.share.item(js(row.item)?)))
        .collect::<Result<Vec<_>, DbErr>>()?;
    Ok((shared_items(files), shared_items(folders)))
}

/// The share fields "Shared with me" adds to a row.
pub fn with_share_fields(mut row: Value, item: &SharedItem) -> Value {
    if let Value::Object(fields) = &mut row {
        let mut extra = Map::new();
        extra.insert("sharedRole".to_owned(), json!(item.role));
        extra.insert("sharedBy".to_owned(), json!(item.shared_by));
        extra.insert("sharedAt".to_owned(), json!(item.shared_at));
        fields.extend(extra);
    }
    row
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use super::*;
    use crate::drive_access::DriveCaller;

    fn index() -> DriveAccessIndex {
        let folder = DriveFolderRef {
            id: "fld_1".to_owned(),
            parent_id: None,
            created_by_id: Some("user_ann".to_owned()),
            general_access: DriveGeneralAccess::Restricted,
        };
        DriveAccessIndex {
            caller: DriveCaller {
                user_id: Some("user_bob".to_owned()),
                is_admin: false,
            },
            folders: BTreeMap::from([(folder.id.clone(), folder)]),
            file_shares: HashMap::from([("fil_shared".to_owned(), DriveRole::Viewer)]),
            folder_shares: HashMap::new(),
        }
    }

    #[test]
    fn rows_get_their_access_fields_and_hidden_rows_go() {
        let rows = vec![
            json!({ "id": "fil_open", "uploadedById": "user_ann", "folderId": null,
                    "generalAccess": "workspace_view", "entityType": null }),
            json!({ "id": "fil_hidden", "uploadedById": "user_ann", "folderId": "fld_1",
                    "generalAccess": "workspace_edit", "entityType": null }),
            json!({ "id": "fil_shared", "uploadedById": "user_ann", "folderId": null,
                    "generalAccess": "restricted", "entityType": null }),
        ];
        let out = with_file_access(&index(), rows);
        let ids: Vec<&str> = out.iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids, ["fil_open", "fil_shared"]);
        assert_eq!(out[0]["accessRole"], "viewer");
        assert_eq!(out[0]["effectiveAccess"], "workspace_view");
        assert_eq!(out[1]["effectiveAccess"], "restricted");

        let folders = with_folder_access(
            &index(),
            vec![
                json!({ "id": "fld_1", "parentId": null, "createdById": "user_ann",
                         "generalAccess": "restricted" }),
            ],
        );
        assert_eq!(folders, Vec::<Value>::new());
    }

    #[test]
    fn shared_items_come_newest_first() {
        let share = |role: &str, at: &str| ShareOf {
            role: role.to_owned(),
            shared_by: "u".to_owned(),
            created_at: OffsetDateTime::parse(
                at,
                &time::format_description::well_known::Rfc3339,
            )
            .expect("a timestamp"),
        };
        let items = shared_items(vec![
            share("viewer", "2026-10-29T07:00:00+00:00").item(json!({ "id": "a" })),
            share("editor", "2026-10-29T09:00:00.5123+01:00").item(json!({ "id": "b" })),
        ]);
        assert_eq!(items[0].row["id"], "b");
        assert_eq!(items[0].shared_at, "2026-10-29T08:00:00.512Z");
        let row = with_share_fields(json!({ "id": "b" }), &items[0]);
        assert_eq!(row["sharedRole"], "editor");
    }
}
