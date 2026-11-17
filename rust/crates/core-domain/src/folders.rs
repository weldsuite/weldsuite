//! WeldDrive's folder tree: the parent rule every writer of `folders` checks
//! (`packages/domains/core/src/folders.ts`), and the folder rows behind
//! `/api/folders` and the Drive trash (`apps/workers/app-api/src/services/folders.ts`).

use std::collections::HashSet;

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::drive_access::{
    DriveAccessIndex, DriveFileRef, DriveFolderRef, can_edit, file_role, folder_role,
};
use crate::files::Change;

/// Ancestors walked before giving up; guards against a loop in the data.
const MAX_FOLDER_DEPTH: usize = 64;

/// Why a folder may not live under a parent (`FolderParentCheck`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentProblem {
    NotFound,
    Cycle,
}

impl ParentProblem {
    /// The message the routes answer with (`FOLDER_PARENT_ERRORS`).
    pub fn message(self) -> &'static str {
        match self {
            Self::NotFound => "The destination folder does not exist",
            Self::Cycle => "A folder cannot be moved into itself or one of its subfolders",
        }
    }
}

/// May folder `folder_id` (`None` for one still to be created) live under
/// `parent_id` (`None` for My Drive)? The parent has to be a live folder, and
/// not the folder itself or one of its subfolders (`checkFolderParent`).
pub async fn check_folder_parent(
    db: &PgPool,
    folder_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<Option<ParentProblem>, sqlx::Error> {
    let Some(parent_id) = parent_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let folder_id = folder_id.filter(|id| !id.is_empty());
    if folder_id == Some(parent_id) {
        return Ok(Some(ParentProblem::Cycle));
    }
    let parent: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, parent_id from folders where id = $1 and deleted_at is null limit 1",
    )
    .bind(parent_id)
    .fetch_optional(db)
    .await?;
    let Some((parent, mut current)) = parent else {
        return Ok(Some(ParentProblem::NotFound));
    };
    let Some(folder_id) = folder_id else {
        return Ok(None);
    };
    let mut seen = HashSet::from([parent]);
    for _ in 0..MAX_FOLDER_DEPTH {
        let Some(id) = current.filter(|id| !id.is_empty()) else {
            break;
        };
        if id == folder_id {
            return Ok(Some(ParentProblem::Cycle));
        }
        if !seen.insert(id.clone()) {
            break;
        }
        let row: Option<Option<String>> =
            sqlx::query_scalar("select parent_id from folders where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(db)
                .await?;
        current = row.flatten();
    }
    Ok(None)
}

async fn row_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(f) from folders f where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// Live folders under `parent_id` (`None`: My Drive), or all of them, by name
/// (`listFolders`).
pub async fn list_folders(
    db: &PgPool,
    parent_id: Option<&str>,
    all: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from folders f
         where deleted_at is null
           and ($2 or (case when $1::text is null then parent_id is null else parent_id = $1 end))
         order by name asc",
    )
    .bind(parent_id.filter(|id| !id.is_empty()))
    .bind(all)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// A live folder by id (`getFolder`).
pub async fn live_folder(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from folders f where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// What `createFolder` stores.
#[derive(Debug, Clone, Default)]
pub struct NewFolder {
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub created_by_id: Option<String>,
}

fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// Insert a folder (`createFolder`).
pub async fn create_folder(
    db: &PgPool,
    folder: &NewFolder,
    now: &str,
) -> Result<Value, sqlx::Error> {
    let id = generate_id("fld");
    sqlx::query(
        "insert into folders (id, name, parent_id, color, icon, created_by_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)",
    )
    .bind(&id)
    .bind(&folder.name)
    .bind(truthy(folder.parent_id.as_ref()))
    .bind(truthy(folder.color.as_ref()))
    .bind(truthy(folder.icon.as_ref()))
    .bind(folder.created_by_id.as_deref())
    .bind(now)
    .execute(db)
    .await?;
    Ok(row_by_id(db, &id).await?.unwrap_or(Value::Null))
}

/// What `updateFolder` changes.
#[derive(Debug, Clone, Default)]
pub struct FolderUpdate {
    pub name: Change<String>,
    pub parent_id: Change<Option<String>>,
    pub color: Change<Option<String>>,
    pub icon: Change<Option<String>>,
    pub general_access: Change<String>,
}

fn split<T: Clone + Default>(change: &Change<T>) -> (bool, T) {
    match change {
        Change::Set(value) => (true, value.clone()),
        Change::Keep => (false, T::default()),
    }
}

/// Update a live folder; `None` when there is none (`updateFolder`).
pub async fn update_folder(
    db: &PgPool,
    id: &str,
    update: &FolderUpdate,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if live_folder(db, id).await?.is_none() {
        return Ok(None);
    }
    let (name_set, name) = split(&update.name);
    let (parent_set, parent) = split(&update.parent_id);
    let (color_set, color) = split(&update.color);
    let (icon_set, icon) = split(&update.icon);
    let (access_set, access) = split(&update.general_access);
    sqlx::query(
        "update folders set
             updated_at = $2::timestamp,
             name = case when $3 then $4 else name end,
             parent_id = case when $5 then $6 else parent_id end,
             color = case when $7 then $8 else color end,
             icon = case when $9 then $10 else icon end,
             general_access = case when $11 then $12 else general_access end
         where id = $1",
    )
    .bind(id)
    .bind(now)
    .bind(name_set)
    .bind(name)
    .bind(parent_set)
    .bind(parent)
    .bind(color_set)
    .bind(color)
    .bind(icon_set)
    .bind(icon)
    .bind(access_set)
    .bind(access)
    .execute(db)
    .await?;
    row_by_id(db, id).await
}

/// The live folders under `id` (itself included) and the live files in them,
/// with what the Drive rules read (`listLiveFolderTree`).
pub async fn live_folder_tree(
    db: &PgPool,
    id: &str,
) -> Result<(Vec<Value>, Vec<Value>), sqlx::Error> {
    let folders: Vec<Value> = sqlx::query_scalar(
        "with recursive tree as (
             select id from folders where id = $1 and deleted_at is null
             union
             select f.id from folders f join tree on f.parent_id = tree.id where f.deleted_at is null
         )
         select jsonb_build_object('id', f.id, 'parentId', f.parent_id,
                'createdById', f.created_by_id, 'generalAccess', f.general_access)
         from folders f where f.id in (select id from tree)",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let folder_ids: Vec<String> = folders
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    if folder_ids.is_empty() {
        return Ok((folders, Vec::new()));
    }
    let files: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'uploadedById', uploaded_by_id,
                'folderId', folder_id, 'generalAccess', general_access, 'entityType', entity_type)
         from files where folder_id = any($1) and deleted_at is null",
    )
    .bind(&folder_ids)
    .fetch_all(db)
    .await?;
    Ok((folders, files))
}

/// What trashing a folder takes with it (`FolderTrashContents`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FolderTrashContents {
    /// The folder itself first, then the folders under it that go too.
    pub folder_ids: Vec<String>,
    pub file_ids: Vec<String>,
}

/// What trashing `root_id` takes with it (`trashableContents`): the folders
/// under it the caller may change (one they may not stays live, with
/// everything in it), and the files in the folders taken that the caller may
/// change. A restricted file the caller cannot see stays where it is: the
/// same rule that refuses the purge.
pub fn trashable_contents(
    access: &DriveAccessIndex,
    root_id: &str,
    folders: &[Value],
    files: &[Value],
) -> FolderTrashContents {
    let refs: Vec<DriveFolderRef> = folders.iter().map(DriveFolderRef::from_row).collect();
    let mut folder_ids = vec![root_id.to_owned()];
    let mut taken: HashSet<String> = folder_ids.iter().cloned().collect();
    let mut next = 0;
    while next < folder_ids.len() {
        let parent = folder_ids[next].clone();
        next += 1;
        for child in refs
            .iter()
            .filter(|folder| folder.parent_id.as_deref() == Some(parent.as_str()))
        {
            if taken.contains(&child.id) || !can_edit(folder_role(access, child)) {
                continue;
            }
            taken.insert(child.id.clone());
            folder_ids.push(child.id.clone());
        }
    }
    let file_ids = files
        .iter()
        .map(DriveFileRef::from_row)
        .filter(|file| {
            file.folder_id.as_ref().is_some_and(|id| taken.contains(id))
                && can_edit(file_role(access, file))
        })
        .map(|file| file.id)
        .collect();
    FolderTrashContents {
        folder_ids,
        file_ids,
    }
}

/// Trash a live folder with what `contents` says goes with it
/// ([`trashable_contents`]), all with the same `deleted_at` and in one
/// statement, so [`restore_folder`] brings back exactly what went with it.
/// The row as it was (`softDeleteFolder`).
pub async fn soft_delete_folder(
    db: &PgPool,
    id: &str,
    contents: &FolderTrashContents,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(existing) = live_folder(db, id).await? else {
        return Ok(None);
    };
    let mut folder_ids = contents.folder_ids.clone();
    if !folder_ids.iter().any(|folder| folder == id) {
        folder_ids.insert(0, id.to_owned());
    }
    sqlx::query(
        "with trashed_files as (
             update files set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = any($2) and deleted_at is null
         )
         update folders set deleted_at = $3::timestamp, updated_at = $3::timestamp
         where id = any($1) and deleted_at is null",
    )
    .bind(&folder_ids)
    .bind(&contents.file_ids)
    .bind(now)
    .execute(db)
    .await?;
    Ok(Some(existing))
}

// ── Trash ──────────────────────────────────────────────────────────────────

/// A trashed folder by id (`getTrashedFolder`).
pub async fn trashed_folder(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from folders f where id = $1 and deleted_at is not null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// Trashed folders, longest in the trash first (`listTrashedFolders`).
pub async fn list_trashed_folders(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from folders f where deleted_at is not null order by deleted_at",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

/// Take a folder out of the trash with what went in with it: the folders
/// under it and the files in them trashed at the same instant. Anything
/// trashed on its own before stays in the trash. The row as it was
/// (`restoreFolder`).
pub async fn restore_folder(
    db: &PgPool,
    id: &str,
    now: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(existing) = trashed_folder(db, id).await? else {
        return Ok(None);
    };
    sqlx::query(
        "with recursive tree as (
             select id, deleted_at from folders where id = $1
             union
             select f.id, f.deleted_at from folders f join tree on f.parent_id = tree.id
             where f.deleted_at = tree.deleted_at
         ),
         restored_files as (
             update files set deleted_at = null, updated_at = $2::timestamp
             where folder_id in (select id from tree)
               and deleted_at = (select deleted_at from folders where id = $1)
         )
         update folders set deleted_at = null, updated_at = $2::timestamp
         where id in (select id from tree)",
    )
    .bind(id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(Some(existing))
}

/// Every file directly in `folder_ids`, trashed or not, with what the access
/// rules read and the storage keys (`listFilesInFolders`).
pub async fn list_files_in_folders(
    db: &PgPool,
    folder_ids: &[String],
) -> Result<Vec<Value>, sqlx::Error> {
    if folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'uploadedById', uploaded_by_id,
                'folderId', folder_id, 'generalAccess', general_access,
                'entityType', entity_type, 'fileKey', file_key, 'storagePath', storage_path)
         from files where folder_id = any($1)",
    )
    .bind(folder_ids)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// A trashed folder and the folders under it trashed together with it (the
/// same `deleted_at`), with what the Drive rules read: what restoring it
/// brings back, and so what purging it takes (`loadFolderFilesForPurge`).
pub async fn trashed_folder_tree(db: &PgPool, id: &str) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "with recursive tree as (
             select id, deleted_at from folders where id = $1 and deleted_at is not null
             union
             select f.id, f.deleted_at from folders f join tree on f.parent_id = tree.id
             where f.deleted_at = tree.deleted_at
         )
         select jsonb_build_object('id', f.id, 'parentId', f.parent_id,
                'createdById', f.created_by_id, 'generalAccess', f.general_access)
         from folders f where f.id in (select id from tree)",
    )
    .bind(id)
    .fetch_all(db)
    .await
}

/// Delete trashed folders (a purged folder's tree) and every file in them
/// (and the spreadsheet, document or board rows that reference those)
/// (`purgeFolder`).
pub async fn purge_folder(db: &PgPool, folder_ids: &[String]) -> Result<(), sqlx::Error> {
    if folder_ids.is_empty() {
        return Ok(());
    }
    for statement in [
        "delete from sheets where file_id in (select id from files where folder_id = any($1))",
        "delete from whiteboards where file_id in (select id from files where folder_id = any($1))",
        "delete from document_versions where file_id in (select id from files where folder_id = any($1))",
        "delete from docs where file_id in (select id from files where folder_id = any($1))",
        "delete from files where folder_id = any($1)",
        "delete from folders where id = any($1) and deleted_at is not null",
    ] {
        sqlx::query(statement).bind(folder_ids).execute(db).await?;
    }
    Ok(())
}

/// Delete trashed files and folders for good; a folder goes with the files
/// in it (`purgeTrashed`). The caller has narrowed the ids to what it may
/// change.
pub async fn purge_trashed(
    db: &PgPool,
    file_ids: &[String],
    folder_ids: &[String],
) -> Result<(), sqlx::Error> {
    if !file_ids.is_empty() || !folder_ids.is_empty() {
        for statement in [
            "delete from sheets where file_id in (select id from files
              where (id = any($1) and deleted_at is not null) or folder_id = any($2))",
            "delete from whiteboards where file_id in (select id from files
              where (id = any($1) and deleted_at is not null) or folder_id = any($2))",
            "delete from document_versions where file_id in (select id from files
              where (id = any($1) and deleted_at is not null) or folder_id = any($2))",
            "delete from docs where file_id in (select id from files
              where (id = any($1) and deleted_at is not null) or folder_id = any($2))",
        ] {
            sqlx::query(statement)
                .bind(file_ids)
                .bind(folder_ids)
                .execute(db)
                .await?;
        }
        sqlx::query(
            "delete from files where (id = any($1) and deleted_at is not null) or folder_id = any($2)",
        )
        .bind(file_ids)
        .bind(folder_ids)
        .execute(db)
        .await?;
    }
    if !folder_ids.is_empty() {
        sqlx::query("delete from folders where id = any($1) and deleted_at is not null")
            .bind(folder_ids)
            .execute(db)
            .await?;
    }
    Ok(())
}

/// The storage keys of what [`purge_trashed`] removes: the files, and the
/// snapshots of the spreadsheets and documents among them
/// (`listPurgedFileKeys`).
pub async fn list_purged_file_keys(
    db: &PgPool,
    file_ids: &[String],
    folder_ids: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    if file_ids.is_empty() && folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "select id, file_key, storage_path from files
         where (id = any($1) and deleted_at is not null) or folder_id = any($2)",
    )
    .bind(file_ids)
    .bind(folder_ids)
    .fetch_all(db)
    .await?;
    let mut keys: Vec<String> = rows
        .iter()
        .filter_map(|(_, file_key, storage_path)| {
            file_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .or(Some(storage_path.as_str()).filter(|k| !k.is_empty()))
                .map(str::to_owned)
        })
        .collect();
    let ids: Vec<String> = rows.into_iter().map(|(id, _, _)| id).collect();
    keys.extend(crate::files::list_document_snapshot_keys(db, &ids).await?);
    Ok(keys)
}
