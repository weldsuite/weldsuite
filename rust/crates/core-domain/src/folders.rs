//! WeldDrive's folder tree: the parent rule every writer of `folders` checks
//! (`packages/domains/core/src/folders.ts`), and the folder rows behind
//! `/api/folders` and the Drive trash (`apps/workers/app-api/src/services/folders.ts`).

use std::collections::HashSet;

use sea_orm::sea_query::{Expr, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, orm_error};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    docs, document_versions, files as files_table, folders as folders_table, sheets, whiteboards,
};

use crate::drive_access::{
    DriveAccessIndex, DriveFileRef, DriveFolderRef, can_edit, file_role, folder_role,
};
use crate::files::{Change, js, timestamp_of};

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
) -> Result<Option<ParentProblem>, DbErr> {
    let Some(parent_id) = parent_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let folder_id = folder_id.filter(|id| !id.is_empty());
    if folder_id == Some(parent_id) {
        return Ok(Some(ParentProblem::Cycle));
    }
    let db = orm(db);
    let parent: Option<(String, Option<String>)> = folders_table::Entity::find()
        .select_only()
        .columns([folders_table::Column::Id, folders_table::Column::ParentId])
        .filter(folders_table::Column::Id.eq(parent_id))
        .filter(folders_table::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
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
        let row: Option<Option<String>> = folders_table::Entity::find()
            .select_only()
            .column(folders_table::Column::ParentId)
            .filter(folders_table::Column::Id.eq(&id))
            .into_tuple()
            .one(&db)
            .await?;
        current = row.flatten();
    }
    Ok(None)
}

/// The first `folders` row matching `condition`, as Drizzle returns it.
async fn folder_row(db: &DatabaseConnection, condition: Condition) -> Result<Option<Value>, DbErr> {
    folders_table::Entity::find()
        .filter(condition)
        .one(db)
        .await?
        .map(js)
        .transpose()
}

async fn row_by_id(db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
    folder_row(db, Condition::all().add(folders_table::Column::Id.eq(id))).await
}

/// Folder rows as Drizzle returns them, in `order`.
async fn folder_rows(
    db: &PgPool,
    condition: Condition,
    order: (folders_table::Column, sea_orm::Order),
) -> Result<Vec<Value>, DbErr> {
    folders_table::Entity::find()
        .filter(condition)
        .order_by(order.0, order.1)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(js)
        .collect()
}

/// Live folders under `parent_id` (`None`: My Drive), or all of them, by name
/// (`listFolders`).
pub async fn list_folders(
    db: &PgPool,
    parent_id: Option<&str>,
    all: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut condition = Condition::all().add(folders_table::Column::DeletedAt.is_null());
    if !all {
        condition = condition.add(match parent_id.filter(|id| !id.is_empty()) {
            Some(parent_id) => folders_table::Column::ParentId.eq(parent_id),
            None => folders_table::Column::ParentId.is_null(),
        });
    }
    folder_rows(
        db,
        condition,
        (folders_table::Column::Name, sea_orm::Order::Asc),
    )
    .await
}

/// A live folder by id (`getFolder`).
pub async fn live_folder(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    folder_row(
        &orm(db),
        Condition::all()
            .add(folders_table::Column::Id.eq(id))
            .add(folders_table::Column::DeletedAt.is_null()),
    )
    .await
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
pub async fn create_folder(db: &PgPool, folder: &NewFolder, now: &str) -> Result<Value, DbErr> {
    let id = generate_id("fld");
    let text = |value: Option<&String>| truthy(value).map(str::to_owned);
    let now = timestamp_of(now)?;
    let db = orm(db);
    folders_table::Entity::insert(folders_table::ActiveModel {
        id: Set(id.clone()),
        name: Set(folder.name.clone()),
        parent_id: Set(text(folder.parent_id.as_ref())),
        color: Set(text(folder.color.as_ref())),
        icon: Set(text(folder.icon.as_ref())),
        created_by_id: Set(folder.created_by_id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&db)
    .await?;
    Ok(row_by_id(&db, &id).await?.unwrap_or(Value::Null))
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

/// Update a live folder; `None` when there is none (`updateFolder`).
pub async fn update_folder(
    db: &PgPool,
    id: &str,
    update: &FolderUpdate,
    now: &str,
) -> Result<Option<Value>, DbErr> {
    if live_folder(db, id).await?.is_none() {
        return Ok(None);
    }
    let mut query = folders_table::Entity::update_many().col_expr(
        folders_table::Column::UpdatedAt,
        Expr::value(timestamp_of(now)?),
    );
    if let Change::Set(name) = &update.name {
        query = query.col_expr(folders_table::Column::Name, Expr::value(name.as_str()));
    }
    if let Change::Set(parent) = &update.parent_id {
        query = query.col_expr(folders_table::Column::ParentId, Expr::value(parent.clone()));
    }
    if let Change::Set(color) = &update.color {
        query = query.col_expr(folders_table::Column::Color, Expr::value(color.clone()));
    }
    if let Change::Set(icon) = &update.icon {
        query = query.col_expr(folders_table::Column::Icon, Expr::value(icon.clone()));
    }
    if let Change::Set(access) = &update.general_access {
        query = query.col_expr(
            folders_table::Column::GeneralAccess,
            Expr::value(access.as_str()),
        );
    }
    let db = orm(db);
    query
        .filter(folders_table::Column::Id.eq(id))
        .exec(&db)
        .await?;
    row_by_id(&db, id).await
}

/// The live folders under `id` (itself included) and the live files in them,
/// with what the Drive rules read (`listLiveFolderTree`).
pub async fn live_folder_tree(db: &PgPool, id: &str) -> Result<(Vec<Value>, Vec<Value>), DbErr> {
    let folders = live_tree_folders(db, id).await?;
    let folder_ids: Vec<String> = folders
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    if folder_ids.is_empty() {
        return Ok((folders, Vec::new()));
    }
    let rows: Vec<FileAccessRow> = files_table::Entity::find()
        .select_only()
        .columns(FILE_ACCESS_COLUMNS)
        .filter(files_table::Column::FolderId.is_in(&folder_ids))
        .filter(files_table::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let files = rows
        .into_iter()
        .map(
            |(id, uploaded_by_id, folder_id, general_access, entity_type)| {
                json!({
                    "id": id,
                    "uploadedById": uploaded_by_id,
                    "folderId": folder_id,
                    "generalAccess": general_access,
                    "entityType": entity_type,
                })
            },
        )
        .collect();
    Ok((folders, files))
}

/// What the Drive rules read of a file: id, uploader, folder, general access
/// and entity type.
const FILE_ACCESS_COLUMNS: [files_table::Column; 5] = [
    files_table::Column::Id,
    files_table::Column::UploadedById,
    files_table::Column::FolderId,
    files_table::Column::GeneralAccess,
    files_table::Column::EntityType,
];

type FileAccessRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

/// [`FileAccessRow`] with the storage keys: `file_key`, `storage_path`.
type FileRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
);

/// The live folders under `id`, itself included, with what the Drive rules
/// read (`{ id, parentId, createdById, generalAccess }`).
#[allow(
    clippy::disallowed_methods,
    reason = "a recursive walk of the folder tree (WITH RECURSIVE) in one statement"
)]
async fn live_tree_folders(db: &PgPool, id: &str) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(
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
    .await
    .map_err(orm_error)
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
) -> Result<Option<Value>, DbErr> {
    let Some(existing) = live_folder(db, id).await? else {
        return Ok(None);
    };
    let mut folder_ids = contents.folder_ids.clone();
    if !folder_ids.iter().any(|folder| folder == id) {
        folder_ids.insert(0, id.to_owned());
    }
    trash_folders_and_files(db, &folder_ids, &contents.file_ids, now).await?;
    Ok(Some(existing))
}

/// Trash `folder_ids` and `file_ids` (the live ones) at `now`.
#[allow(
    clippy::disallowed_methods,
    reason = "files and folders are trashed in one statement (a data-modifying CTE), \
              so a folder never goes to the trash without its files"
)]
async fn trash_folders_and_files(
    db: &PgPool,
    folder_ids: &[String],
    file_ids: &[String],
    now: &str,
) -> Result<(), DbErr> {
    sqlx::query(
        "with trashed_files as (
             update files set deleted_at = $3::timestamp, updated_at = $3::timestamp
             where id = any($2) and deleted_at is null
         )
         update folders set deleted_at = $3::timestamp, updated_at = $3::timestamp
         where id = any($1) and deleted_at is null",
    )
    .bind(folder_ids)
    .bind(file_ids)
    .bind(now)
    .execute(db)
    .await
    .map_err(orm_error)?;
    Ok(())
}

// ── Trash ──────────────────────────────────────────────────────────────────

/// A trashed folder by id (`getTrashedFolder`).
pub async fn trashed_folder(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    folder_row(
        &orm(db),
        Condition::all()
            .add(folders_table::Column::Id.eq(id))
            .add(folders_table::Column::DeletedAt.is_not_null()),
    )
    .await
}

/// Trashed folders, longest in the trash first (`listTrashedFolders`).
pub async fn list_trashed_folders(db: &PgPool) -> Result<Vec<Value>, DbErr> {
    folder_rows(
        db,
        Condition::all().add(folders_table::Column::DeletedAt.is_not_null()),
        (folders_table::Column::DeletedAt, sea_orm::Order::Asc),
    )
    .await
}

/// Take a folder out of the trash with what went in with it: the folders
/// under it and the files in them trashed at the same instant. Anything
/// trashed on its own before stays in the trash. The row as it was
/// (`restoreFolder`).
pub async fn restore_folder(db: &PgPool, id: &str, now: &str) -> Result<Option<Value>, DbErr> {
    let Some(existing) = trashed_folder(db, id).await? else {
        return Ok(None);
    };
    restore_tree(db, id, now).await?;
    Ok(Some(existing))
}

/// Take `id` and what was trashed with it out of the trash at `now`.
#[allow(
    clippy::disallowed_methods,
    reason = "a recursive walk of the trashed tree (WITH RECURSIVE) that restores its \
              folders and files in one statement"
)]
async fn restore_tree(db: &PgPool, id: &str, now: &str) -> Result<(), DbErr> {
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
    .await
    .map_err(orm_error)?;
    Ok(())
}

/// Every file directly in `folder_ids`, trashed or not, with what the access
/// rules read and the storage keys (`listFilesInFolders`).
pub async fn list_files_in_folders(
    db: &PgPool,
    folder_ids: &[String],
) -> Result<Vec<Value>, DbErr> {
    if folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<FileRow> = files_table::Entity::find()
        .select_only()
        .columns(FILE_ACCESS_COLUMNS)
        .columns([
            files_table::Column::FileKey,
            files_table::Column::StoragePath,
        ])
        .filter(files_table::Column::FolderId.is_in(folder_ids))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                uploaded_by_id,
                folder_id,
                general_access,
                entity_type,
                file_key,
                storage_path,
            )| {
                json!({
                    "id": id,
                    "uploadedById": uploaded_by_id,
                    "folderId": folder_id,
                    "generalAccess": general_access,
                    "entityType": entity_type,
                    "fileKey": file_key,
                    "storagePath": storage_path,
                })
            },
        )
        .collect())
}

/// A trashed folder and the folders under it trashed together with it (the
/// same `deleted_at`), with what the Drive rules read: what restoring it
/// brings back, and so what purging it takes (`loadFolderFilesForPurge`).
#[allow(
    clippy::disallowed_methods,
    reason = "a recursive walk of the trashed tree (WITH RECURSIVE) in one statement"
)]
pub async fn trashed_folder_tree(db: &PgPool, id: &str) -> Result<Vec<Value>, DbErr> {
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
    .map_err(orm_error)
}

/// Delete trashed folders (a purged folder's tree) and every file in them
/// (and the spreadsheet, document or board rows that reference those)
/// (`purgeFolder`).
pub async fn purge_folder(db: &PgPool, folder_ids: &[String]) -> Result<(), DbErr> {
    if folder_ids.is_empty() {
        return Ok(());
    }
    let db = orm(db);
    let in_folders = Condition::all().add(files_table::Column::FolderId.is_in(folder_ids));
    delete_documents_of(&db, &in_folders).await?;
    files_table::Entity::delete_many()
        .filter(in_folders)
        .exec(&db)
        .await?;
    delete_trashed_folders(&db, folder_ids).await
}

/// `select id from files where <files>`.
fn file_ids_where(files: &Condition) -> SelectStatement {
    Query::select()
        .column(files_table::Column::Id)
        .from(files_table::Entity)
        .cond_where(files.clone())
        .to_owned()
}

/// Delete the spreadsheet, board, version and document rows of the files
/// matching `files`, in the TypeScript's order.
async fn delete_documents_of(db: &DatabaseConnection, files: &Condition) -> Result<(), DbErr> {
    sheets::Entity::delete_many()
        .filter(sheets::Column::FileId.in_subquery(file_ids_where(files)))
        .exec(db)
        .await?;
    whiteboards::Entity::delete_many()
        .filter(whiteboards::Column::FileId.in_subquery(file_ids_where(files)))
        .exec(db)
        .await?;
    document_versions::Entity::delete_many()
        .filter(document_versions::Column::FileId.in_subquery(file_ids_where(files)))
        .exec(db)
        .await?;
    docs::Entity::delete_many()
        .filter(docs::Column::FileId.in_subquery(file_ids_where(files)))
        .exec(db)
        .await?;
    Ok(())
}

/// `delete from folders where id = any($1) and deleted_at is not null`.
async fn delete_trashed_folders(
    db: &DatabaseConnection,
    folder_ids: &[String],
) -> Result<(), DbErr> {
    folders_table::Entity::delete_many()
        .filter(folders_table::Column::Id.is_in(folder_ids))
        .filter(folders_table::Column::DeletedAt.is_not_null())
        .exec(db)
        .await?;
    Ok(())
}

/// `(id = any($1) and deleted_at is not null) or folder_id = any($2)`: the
/// trashed files asked for, and every file in the folders asked for.
fn purged_files(file_ids: &[String], folder_ids: &[String]) -> Condition {
    Condition::any()
        .add(
            Condition::all()
                .add(files_table::Column::Id.is_in(file_ids))
                .add(files_table::Column::DeletedAt.is_not_null()),
        )
        .add(files_table::Column::FolderId.is_in(folder_ids))
}

/// Delete trashed files and folders for good; a folder goes with the files
/// in it (`purgeTrashed`). The caller has narrowed the ids to what it may
/// change.
pub async fn purge_trashed(
    db: &PgPool,
    file_ids: &[String],
    folder_ids: &[String],
) -> Result<(), DbErr> {
    let db = orm(db);
    if !file_ids.is_empty() || !folder_ids.is_empty() {
        let files = purged_files(file_ids, folder_ids);
        delete_documents_of(&db, &files).await?;
        files_table::Entity::delete_many()
            .filter(files)
            .exec(&db)
            .await?;
    }
    if !folder_ids.is_empty() {
        delete_trashed_folders(&db, folder_ids).await?;
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
) -> Result<Vec<String>, DbErr> {
    if file_ids.is_empty() && folder_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>, String)> = files_table::Entity::find()
        .select_only()
        .columns([
            files_table::Column::Id,
            files_table::Column::FileKey,
            files_table::Column::StoragePath,
        ])
        .filter(purged_files(file_ids, folder_ids))
        .into_tuple()
        .all(&orm(db))
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
