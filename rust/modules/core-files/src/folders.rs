//! `/api/folders` (`apps/workers/app-api/src/routes/folders/index.ts`): the
//! Drive folder tree. A folder's sharing reaches everything in it. A folder
//! the caller cannot see is a 404.
//!
//! Entity events: `folder:created | updated | deleted | shared | unshared`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    FOLDER_CREATED, FOLDER_DELETED, FOLDER_SHARED, FOLDER_UNSHARED, FOLDER_UPDATED,
};
use weldsuite_catalogs::permission_keys::FOLDERS_UPDATE;
use weldsuite_core_domain::drive_access::{
    DriveAccessIndex, DriveFolderRef, DriveGeneralAccess, DriveRole, can_edit, folder_role,
    is_shareable_member,
};
use weldsuite_core_domain::drive_sharing::{
    DriveItem, NewShare, SharingTarget, describe_sharing, remove_share, upsert_share,
    with_folder_access,
};
use weldsuite_core_domain::files::Change;
use weldsuite_core_domain::folders::{self as folders_db, FolderUpdate, NewFolder};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Issues, Presence};

use crate::drive::DRIVE_VIEW_ONLY;
use crate::files::{check_destination, read_share_role};
use crate::names::drive_name;
use crate::{
    Caller, CoreFilesState, Fail, answer, created, forbidden, not_found, now, ok, text, validate,
};

struct OpenedFolder {
    row: Value,
    access: DriveAccessIndex,
    role: DriveRole,
}

/// Load a live folder and the caller's role on it (`openFolder`).
async fn open_folder(caller: &Caller, id: &str, edit: bool) -> Result<OpenedFolder, Fail> {
    let Some(row) = folders_db::live_folder(&caller.db, id).await? else {
        return Err(not_found("Folder", id));
    };
    let access = caller.drive_access().await?;
    let Some(role) = folder_role(&access, &DriveFolderRef::from_row(&row)) else {
        return Err(not_found("Folder", id));
    };
    if edit && !can_edit(Some(role)) {
        return Err(forbidden(DRIVE_VIEW_ONLY));
    }
    Ok(OpenedFolder { row, access, role })
}

/// Who an opened folder is open to (`folderSharing`).
async fn folder_sharing(caller: &Caller, opened: &OpenedFolder) -> Result<Value, Fail> {
    let row = &opened.row;
    let target = SharingTarget {
        item: DriveItem::Folder(text(row, "id").unwrap_or_default()),
        owner_id: text(row, "createdById"),
        general_access: DriveGeneralAccess::parse(text(row, "generalAccess").unwrap_or_default()),
        parent_id: text(row, "parentId"),
    };
    Ok(describe_sharing(&caller.db, &opened.access, target, opened.role).await?)
}

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let values = weldsuite_kit::validation::query_values(query.as_deref());
    let mut issues = Issues::default();
    let parent_id = issues
        .text(&values, "parentId", Presence::Optional, None, None)
        .into_option();
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    // `z.coerce.boolean()`: any non-empty value is true, `"false"` included.
    let all = match values.get("all") {
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
        None => false,
    };
    answer(
        async {
            let rows = folders_db::list_folders(&caller.db, parent_id.as_deref(), all).await?;
            let access = caller.drive_access().await?;
            ok(Value::Array(with_folder_access(&access, rows)))
        }
        .await,
        "Failed to list folders",
    )
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let opened = open_folder(&caller, &id, false).await?;
            let row = with_folder_access(&opened.access, vec![opened.row])
                .pop()
                .unwrap_or(Value::Null);
            ok(row)
        }
        .await,
        "Failed to fetch folder",
    )
}

/// `createFolderSchema`.
fn read_new_folder(issues: &mut Issues, body: &Map<String, Value>) -> NewFolder {
    let name = drive_name(issues, body, "name", Presence::Required)
        .into_option()
        .unwrap_or_default();
    let parent_id = issues
        .text(body, "parentId", Presence::Nullish, None, None)
        .into_option();
    let color = issues
        .text(body, "color", Presence::Optional, None, None)
        .into_option();
    let icon = issues
        .text(body, "icon", Presence::Optional, None, None)
        .into_option();
    NewFolder {
        name,
        parent_id,
        color,
        icon,
        created_by_id: None,
    }
}

pub(crate) async fn create(
    State(state): State<CoreFilesState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let mut folder = validate(&headers, &body, read_new_folder)?;
            if let Some(problem) =
                folders_db::check_folder_parent(&caller.db, None, folder.parent_id.as_deref())
                    .await?
            {
                return Err(ApiError::bad_request(problem.message()).into());
            }
            check_destination(&caller.drive_access().await?, folder.parent_id.as_deref())?;
            folder.created_by_id.clone_from(&caller.user_id);
            let row = folders_db::create_folder(&caller.db, &folder, &now()).await?;
            caller.publish(
                &state,
                FOLDER_CREATED,
                text(&row, "id").unwrap_or_default(),
                &json!({ "id": row["id"], "name": row["name"], "parentId": row["parentId"] }),
            );
            created(row)
        }
        .await,
        "Failed to create folder",
    )
}

/// `updateDriveFolderSchema`.
fn read_folder_update(issues: &mut Issues, body: &Map<String, Value>) -> FolderUpdate {
    let nullable = |field: Field<String>| match field {
        Field::Set(value) => Change::Set(Some(value)),
        Field::Null => Change::Set(None),
        Field::Absent => Change::Keep,
    };
    let set = |field: Field<String>| match field {
        Field::Set(value) => Change::Set(value),
        _ => Change::Keep,
    };
    let name = set(drive_name(issues, body, "name", Presence::Optional));
    let parent_id = nullable(issues.text(body, "parentId", Presence::Nullish, None, None));
    let color = nullable(issues.text(body, "color", Presence::Nullish, None, None));
    let icon = nullable(issues.text(body, "icon", Presence::Nullish, None, None));
    let general_access = set(issues.choice(
        body,
        "generalAccess",
        Presence::Optional,
        &["workspace_edit", "workspace_view", "restricted"],
    ));
    FolderUpdate {
        name,
        parent_id,
        color,
        icon,
        general_access,
    }
}

pub(crate) async fn update(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let update = validate(&headers, &body, read_folder_update)?;
            let opened = open_folder(&caller, &id, true).await?;
            // A parent inside the folder would cut it off from My Drive.
            let parent = match &update.parent_id {
                Change::Set(parent) => parent.as_deref(),
                Change::Keep => None,
            };
            if let Some(problem) =
                folders_db::check_folder_parent(&caller.db, Some(&id), parent).await?
            {
                return Err(ApiError::bad_request(problem.message()).into());
            }
            if let Change::Set(parent) = &update.parent_id
                && parent.as_deref() != text(&opened.row, "parentId")
            {
                check_destination(&opened.access, parent.as_deref())?;
            }
            let Some(row) = folders_db::update_folder(&caller.db, &id, &update, &now()).await?
            else {
                return Err(not_found("Folder", &id));
            };
            caller.publish(
                &state,
                FOLDER_UPDATED,
                text(&row, "id").unwrap_or_default(),
                &json!({
                    "id": row["id"], "name": row["name"], "parentId": row["parentId"],
                    "generalAccess": row["generalAccess"],
                }),
            );
            ok(row)
        }
        .await,
        "Failed to update folder",
    )
}

pub(crate) async fn remove(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            open_folder(&caller, &id, true).await?;
            let Some(deleted) = folders_db::soft_delete_folder(&caller.db, &id, &now()).await?
            else {
                return Err(not_found("Folder", &id));
            };
            caller.publish(
                &state,
                FOLDER_DELETED,
                &id,
                &json!({ "id": id, "name": deleted["name"], "parentId": deleted["parentId"] }),
            );
            ok(json!({ "deleted": true }))
        }
        .await,
        "Failed to delete folder",
    )
}

pub(crate) async fn sharing(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let opened = open_folder(&caller, &id, false).await?;
            ok(folder_sharing(&caller, &opened).await?)
        }
        .await,
        "Failed to load sharing",
    )
}

pub(crate) async fn share(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path((id, target_user)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let role = validate(&headers, &body, read_share_role)?;
            let Some(user_id) = caller.user_id.clone() else {
                return Err(ApiError::unauthorized().into());
            };
            let opened = open_folder(&caller, &id, true).await?;
            let row = &opened.row;
            if target_user == user_id {
                return Err(
                    ApiError::bad_request("You cannot share a folder with yourself").into(),
                );
            }
            if Some(target_user.as_str()) == text(row, "createdById") {
                return Err(
                    ApiError::bad_request("The owner already has access to this folder").into(),
                );
            }
            if !is_shareable_member(&caller.db, &target_user).await? {
                return Err(ApiError::bad_request(
                    "Folders can only be shared with active members of this workspace",
                )
                .into());
            }
            let previous = upsert_share(
                &caller.db,
                DriveItem::Folder(&id),
                NewShare {
                    user_id: &target_user,
                    role: &role,
                    shared_by: &user_id,
                    now: &now(),
                },
            )
            .await?;
            caller.publish(
                &state,
                FOLDER_SHARED,
                &id,
                &json!({
                    "id": id, "name": row["name"], "parentId": row["parentId"],
                    "userId": target_user, "role": role, "previousRole": previous,
                }),
            );
            ok(folder_sharing(&caller, &opened).await?)
        }
        .await,
        "Failed to share folder",
    )
}

pub(crate) async fn unshare(
    State(state): State<CoreFilesState>,
    caller: Caller,
    Path((id, target_user)): Path<(String, String)>,
) -> Response {
    let Some(user_id) = caller.user_id.clone() else {
        return ApiError::unauthorized().into_response();
    };
    answer(
        async {
            let leaving = target_user == user_id;
            let opened = open_folder(&caller, &id, !leaving).await?;
            if !leaving && !caller.can(FOLDERS_UPDATE) {
                return Err(forbidden("Missing permission: folders:update"));
            }
            let Some(removed) =
                remove_share(&caller.db, DriveItem::Folder(&id), &target_user).await?
            else {
                return Err(not_found("Share", &target_user));
            };
            caller.publish(
                &state,
                FOLDER_UNSHARED,
                &id,
                &json!({
                    "id": id, "name": opened.row["name"], "parentId": opened.row["parentId"],
                    "userId": target_user, "role": removed,
                }),
            );
            let after = match open_folder(&caller, &id, false).await {
                Ok(after) => folder_sharing(&caller, &after).await?,
                Err(Fail::Response(_)) => Value::Null,
                Err(other) => return Err(other),
            };
            ok(after)
        }
        .await,
        "Failed to stop sharing folder",
    )
}
