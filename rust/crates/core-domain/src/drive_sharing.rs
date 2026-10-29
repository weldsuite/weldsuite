//! Who a WeldDrive item is open to, and the per-person shares behind it
//! (the "Shares" half of `packages/domains/core/src/drive-access.ts`): the
//! Share dialog's summary, sharing and unsharing, "Shared with me", and the
//! access fields every Drive read adds to its rows.

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::drive_access::{
    DriveAccessIndex, DriveFile, DriveFileRef, DriveFolderRef, DriveGeneralAccess, DriveRole,
    ancestor_folder_ids, effective_file_access, effective_folder_access, effective_general_access,
    file_role, folder_role,
};

impl DriveFolderRef {
    /// Build from a [`js_row`] of `folders`.
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
    /// Build from a [`js_row`] of `files` (or any row with its camelCase keys).
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

/// The people an item is shared with directly, oldest first
/// (`listItemShares`).
pub async fn list_item_shares(db: &PgPool, item: DriveItem<'_>) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                'userId', ds.user_id, 'role', ds.role, 'sharedBy', ds.shared_by,
                'createdAt', ds.created_at, 'name', wm.name, 'email', wm.email,
                'picture', wm.picture)
         from drive_shares ds
         left join workspace_members wm on wm.user_id = ds.user_id and wm.deleted_at is null
         where ($1::text is null or ds.file_id = $1) and ($2::text is null or ds.folder_id = $2)
         order by ds.created_at",
    )
    .bind(item.file_id())
    .bind(item.folder_id())
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// The people who reach an item through a share on a folder above it
/// (`listInheritedShares`).
pub async fn list_inherited_shares(
    db: &PgPool,
    folder_ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                'userId', ds.user_id, 'role', ds.role, 'sharedBy', ds.shared_by,
                'createdAt', ds.created_at, 'name', wm.name, 'email', wm.email,
                'picture', wm.picture, 'folderId', ds.folder_id, 'folderName', f.name)
         from drive_shares ds
         join folders f on f.id = ds.folder_id
         left join workspace_members wm on wm.user_id = ds.user_id and wm.deleted_at is null
         where ds.folder_id = any($1)
         order by ds.created_at",
    )
    .bind(folder_ids)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
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
) -> Result<Option<String>, sqlx::Error> {
    let existing: Option<(String, String)> = sqlx::query_as(
        "select id, role from drive_shares
         where ($1::text is null or file_id = $1) and ($2::text is null or folder_id = $2)
           and user_id = $3
         limit 1",
    )
    .bind(item.file_id())
    .bind(item.folder_id())
    .bind(share.user_id)
    .fetch_optional(db)
    .await?;
    if let Some((id, role)) = existing {
        if role != share.role {
            sqlx::query(
                "update drive_shares set role = $2, updated_at = $3::timestamptz where id = $1",
            )
            .bind(&id)
            .bind(share.role)
            .bind(share.now)
            .execute(db)
            .await?;
        }
        return Ok(Some(role));
    }
    sqlx::query(
        "insert into drive_shares
             (id, file_id, folder_id, user_id, role, shared_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)",
    )
    .bind(generate_id("dsh"))
    .bind(item.file_id())
    .bind(item.folder_id())
    .bind(share.user_id)
    .bind(share.role)
    .bind(share.shared_by)
    .bind(share.now)
    .execute(db)
    .await?;
    Ok(None)
}

/// Stop sharing an item with `user_id`: the role they had, or `None` when it
/// was not shared with them (`removeShare`).
pub async fn remove_share(
    db: &PgPool,
    item: DriveItem<'_>,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let removed: Option<String> = sqlx::query_scalar(
        "delete from drive_shares
         where ($1::text is null or file_id = $1) and ($2::text is null or folder_id = $2)
           and user_id = $3
         returning role",
    )
    .bind(item.file_id())
    .bind(item.folder_id())
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(removed)
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

async fn member_person(db: &PgPool, user_id: &str) -> Result<Value, sqlx::Error> {
    let member: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "select name, email, picture from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (name, email, picture) = member.unwrap_or_default();
    Ok(json!({ "userId": user_id, "name": name, "email": email, "picture": picture }))
}

/// Who an item is open to, for a caller whose role on it is `access_role`
/// (`describeSharing`).
pub async fn describe_sharing(
    db: &PgPool,
    index: &DriveAccessIndex,
    target: SharingTarget<'_>,
    access_role: DriveRole,
) -> Result<Value, sqlx::Error> {
    let shares = list_item_shares(db, target.item).await?;
    let inherited =
        list_inherited_shares(db, &ancestor_folder_ids(index, target.parent_id)).await?;
    let owner = match target.owner_id.filter(|id| !id.is_empty()) {
        Some(owner_id) => member_person(db, owner_id).await?,
        None => Value::Null,
    };
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

fn shared_items(rows: Vec<Value>) -> Vec<SharedItem> {
    let mut items: Vec<SharedItem> = rows
        .into_iter()
        .map(|row| {
            let share = js_row(row["share"].clone());
            let text = |key: &str| share[key].as_str().unwrap_or_default().to_owned();
            SharedItem {
                row: js_row(row["item"].clone()),
                role: text("role"),
                shared_by: text("sharedBy"),
                shared_at: text("sharedAt"),
            }
        })
        .collect();
    // Oldest share first in SQL, then reversed: newest first.
    items.reverse();
    items
}

/// What "Shared with me" lists: live items someone else shared with
/// `user_id`, newest share first (`listSharedWithUser`).
pub async fn list_shared_with_user(
    db: &PgPool,
    user_id: &str,
) -> Result<(Vec<SharedItem>, Vec<SharedItem>), sqlx::Error> {
    let files: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('item', to_jsonb(f), 'share', jsonb_build_object(
                'role', ds.role, 'sharedBy', ds.shared_by, 'sharedAt', ds.created_at))
         from drive_shares ds
         join files f on f.id = ds.file_id
         where ds.user_id = $1 and ds.shared_by <> $1 and f.deleted_at is null
         order by ds.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let folders: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('item', to_jsonb(f), 'share', jsonb_build_object(
                'role', ds.role, 'sharedBy', ds.shared_by, 'sharedAt', ds.created_at))
         from drive_shares ds
         join folders f on f.id = ds.folder_id
         where ds.user_id = $1 and ds.shared_by <> $1 and f.deleted_at is null
         order by ds.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
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
        let rows = vec![
            json!({ "item": { "id": "a" }, "share": { "role": "viewer", "sharedBy": "u",
                    "sharedAt": "2026-10-29T07:00:00+00:00" } }),
            json!({ "item": { "id": "b" }, "share": { "role": "editor", "sharedBy": "u",
                    "sharedAt": "2026-10-29T08:00:00.5+00:00" } }),
        ];
        let items = shared_items(rows);
        assert_eq!(items[0].row["id"], "b");
        assert_eq!(items[0].shared_at, "2026-10-29T08:00:00.500Z");
        let row = with_share_fields(json!({ "id": "b" }), &items[0]);
        assert_eq!(row["sharedRole"], "editor");
    }
}
