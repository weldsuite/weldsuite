//! WeldDrive access rules (`packages/domains/core/src/drive-access.ts`), the
//! same rules every worker reading Drive items applies.
//!
//! `files:*` / `folders:*` open the door to Drive. Which items a caller sees
//! inside it, and at what role, is decided here:
//!
//! - the uploader of a file, or the creator of a folder, owns it;
//! - whoever owns a folder edits everything inside it;
//! - a share (`drive_shares`) on the item or on a folder above it gives its
//!   role; the highest role wins;
//! - `general_access` opens the item to the rest of the workspace. The
//!   strictest setting on the way up the folder tree applies, so a file in a
//!   restricted folder is restricted too;
//! - workspace OWNER / ADMIN open every item at editor, so a former member's
//!   restricted files stay reachable;
//! - a caller with no person behind it (a workspace API key) sees items that
//!   are not restricted only.
//!
//! Files a module keeps for one of its records (`entity_type` set) are outside
//! these rules: their module decides who opens them. An item the caller
//! cannot see answers 404, never 403.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};

/// Folders walked up from an item before giving up; guards against a loop
/// already in the data.
const MAX_FOLDER_DEPTH: usize = 64;

/// A caller's role on a Drive item. `Owner` and `Editor` change and share it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DriveRole {
    Owner,
    Editor,
    Viewer,
}

impl DriveRole {
    fn rank(self) -> u8 {
        match self {
            Self::Viewer => 1,
            Self::Editor => 2,
            Self::Owner => 3,
        }
    }

    /// `owner`, `editor`, `viewer`: the wire form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }

    /// A `drive_shares.role` (`viewer` | `editor`); `None` for anything else.
    pub fn from_share(role: &str) -> Option<Self> {
        match role {
            "viewer" => Some(Self::Viewer),
            "editor" => Some(Self::Editor),
            _ => None,
        }
    }
}

/// `general_access` on a file or folder (`DriveGeneralAccess`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DriveGeneralAccess {
    Restricted,
    WorkspaceView,
    WorkspaceEdit,
}

impl DriveGeneralAccess {
    fn rank(self) -> u8 {
        match self {
            Self::Restricted => 0,
            Self::WorkspaceView => 1,
            Self::WorkspaceEdit => 2,
        }
    }

    /// The column value. Anything unknown reads as `restricted`: the column
    /// is an enum the app writes, and an unexpected value fails closed.
    pub fn parse(value: &str) -> Self {
        match value {
            "workspace_edit" => Self::WorkspaceEdit,
            "workspace_view" => Self::WorkspaceView,
            _ => Self::Restricted,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restricted => "restricted",
            Self::WorkspaceView => "workspace_view",
            Self::WorkspaceEdit => "workspace_edit",
        }
    }
}

/// Who is asking (`DriveCaller`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveCaller {
    /// The person asking, or `None` for a workspace API key.
    pub user_id: Option<String>,
    /// Workspace OWNER / ADMIN: opens every item at editor.
    pub is_admin: bool,
}

/// The fields of a `folders` row the rules read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFolderRef {
    pub id: String,
    pub parent_id: Option<String>,
    pub created_by_id: Option<String>,
    pub general_access: DriveGeneralAccess,
}

/// The fields of a `files` row the rules read. `general_access` is `NOT NULL`
/// in the schema, so it is the enum rather than an optional string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFileRef {
    pub id: String,
    pub uploaded_by_id: Option<String>,
    pub folder_id: Option<String>,
    pub general_access: DriveGeneralAccess,
    pub entity_type: Option<String>,
}

/// What the rules need to answer for one caller: every folder (the tree is
/// small next to the files in it) and the caller's own shares. Load it once
/// per request with [`load_drive_access`], then ask about as many items as
/// needed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveAccessIndex {
    pub caller: DriveCaller,
    /// By id. Trashed folders too: a trashed file is judged by the tree it
    /// was in.
    pub folders: BTreeMap<String, DriveFolderRef>,
    pub file_shares: HashMap<String, DriveRole>,
    pub folder_shares: HashMap<String, DriveRole>,
}

/// The index for `caller` (`loadDriveAccess`).
pub async fn load_drive_access(
    db: &PgPool,
    caller: DriveCaller,
) -> Result<DriveAccessIndex, sqlx::Error> {
    let rows: Vec<(String, Option<String>, Option<String>, String)> =
        sqlx::query_as("select id, parent_id, created_by_id, general_access from folders")
            .fetch_all(db)
            .await?;
    let folders = rows
        .into_iter()
        .map(|(id, parent_id, created_by_id, general_access)| {
            let folder = DriveFolderRef {
                id: id.clone(),
                parent_id,
                created_by_id,
                general_access: DriveGeneralAccess::parse(&general_access),
            };
            (id, folder)
        })
        .collect();

    let mut file_shares = HashMap::new();
    let mut folder_shares = HashMap::new();
    if let Some(user_id) = &caller.user_id {
        let shares: Vec<(Option<String>, Option<String>, String)> =
            sqlx::query_as("select file_id, folder_id, role from drive_shares where user_id = $1")
                .bind(user_id)
                .fetch_all(db)
                .await?;
        for (file_id, folder_id, role) in shares {
            let Some(role) = DriveRole::from_share(&role) else {
                continue;
            };
            if let Some(file_id) = file_id {
                file_shares.insert(file_id, role);
            } else if let Some(folder_id) = folder_id {
                folder_shares.insert(folder_id, role);
            }
        }
    }
    Ok(DriveAccessIndex {
        caller,
        folders,
        file_shares,
        folder_shares,
    })
}

fn higher(a: Option<DriveRole>, b: Option<DriveRole>) -> Option<DriveRole> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(if a.rank() >= b.rank() { a } else { b }),
    }
}

fn stricter(a: DriveGeneralAccess, b: DriveGeneralAccess) -> DriveGeneralAccess {
    if a.rank() <= b.rank() { a } else { b }
}

fn workspace_role(access: DriveGeneralAccess) -> Option<DriveRole> {
    match access {
        DriveGeneralAccess::WorkspaceEdit => Some(DriveRole::Editor),
        DriveGeneralAccess::WorkspaceView => Some(DriveRole::Viewer),
        DriveGeneralAccess::Restricted => None,
    }
}

/// An item's own grants, before the folders above it are walked.
struct ItemGrants<'a> {
    owner_id: Option<&'a str>,
    general_access: DriveGeneralAccess,
    share: Option<DriveRole>,
    parent_id: Option<&'a str>,
}

/// What the folders from `folder_id` up give to everything inside it.
struct ContainerChain {
    /// The caller's own role from the chain: owning a folder in it (editor),
    /// or a share on one.
    grant: Option<DriveRole>,
    /// The strictest general access on the chain; My Drive itself is open.
    general: DriveGeneralAccess,
}

/// The folders from `folder_id` up, nearest first, stopping at a missing
/// folder, a loop or [`MAX_FOLDER_DEPTH`].
fn chain<'a>(
    index: &'a DriveAccessIndex,
    folder_id: Option<&'a str>,
) -> impl Iterator<Item = &'a DriveFolderRef> {
    let mut seen = HashSet::new();
    let mut current = folder_id;
    std::iter::from_fn(move || {
        let id = current.filter(|id| !id.is_empty())?;
        if seen.len() >= MAX_FOLDER_DEPTH || !seen.insert(id) {
            return None;
        }
        let folder = index.folders.get(id)?;
        current = folder.parent_id.as_deref();
        Some(folder)
    })
}

fn container_chain(index: &DriveAccessIndex, folder_id: Option<&str>) -> ContainerChain {
    let user_id = index.caller.user_id.as_deref();
    let mut grant = None;
    let mut general = DriveGeneralAccess::WorkspaceEdit;
    for folder in chain(index, folder_id) {
        if user_id.is_some() && folder.created_by_id.as_deref() == user_id {
            grant = higher(grant, Some(DriveRole::Editor));
        }
        grant = higher(grant, index.folder_shares.get(&folder.id).copied());
        general = stricter(general, folder.general_access);
    }
    ContainerChain { grant, general }
}

fn role_for(index: &DriveAccessIndex, item: &ItemGrants<'_>) -> Option<DriveRole> {
    let user_id = index.caller.user_id.as_deref();
    if user_id.is_some() && item.owner_id == user_id {
        return Some(DriveRole::Owner);
    }
    let chain = container_chain(index, item.parent_id);
    let mut role = higher(item.share, chain.grant);
    role = higher(
        role,
        workspace_role(stricter(item.general_access, chain.general)),
    );
    if index.caller.is_admin {
        role = higher(role, Some(DriveRole::Editor));
    }
    role
}

/// True for a file a module keeps for one of its records, which these rules
/// leave alone (`isModuleFile`: a non-empty `entity_type`).
pub fn is_module_file(entity_type: Option<&str>) -> bool {
    entity_type.is_some_and(|entity| !entity.is_empty())
}

/// The caller's role on a file, or `None` when they may not see it.
pub fn file_role(index: &DriveAccessIndex, file: &DriveFileRef) -> Option<DriveRole> {
    let user_id = index.caller.user_id.as_deref();
    if is_module_file(file.entity_type.as_deref()) {
        let mine = user_id.is_some() && file.uploaded_by_id.as_deref() == user_id;
        return Some(if mine {
            DriveRole::Owner
        } else {
            DriveRole::Editor
        });
    }
    role_for(
        index,
        &ItemGrants {
            owner_id: file.uploaded_by_id.as_deref(),
            general_access: file.general_access,
            share: index.file_shares.get(&file.id).copied(),
            parent_id: file.folder_id.as_deref(),
        },
    )
}

/// The caller's role on a folder (and so on what is in it), or `None` when
/// they may not see it.
pub fn folder_role(index: &DriveAccessIndex, folder: &DriveFolderRef) -> Option<DriveRole> {
    role_for(
        index,
        &ItemGrants {
            owner_id: folder.created_by_id.as_deref(),
            general_access: folder.general_access,
            share: index.folder_shares.get(&folder.id).copied(),
            parent_id: folder.parent_id.as_deref(),
        },
    )
}

/// The caller's role on whatever goes into `folder_id`: a new file or
/// subfolder. My Drive (`None`) is open to all.
pub fn container_role(index: &DriveAccessIndex, folder_id: Option<&str>) -> Option<DriveRole> {
    let Some(folder_id) = folder_id.filter(|id| !id.is_empty()) else {
        return Some(DriveRole::Editor);
    };
    index
        .folders
        .get(folder_id)
        .and_then(|folder| folder_role(index, folder))
}

/// May this role change the item and its sharing?
pub fn can_edit(role: Option<DriveRole>) -> bool {
    matches!(role, Some(DriveRole::Owner | DriveRole::Editor))
}

/// The general access in force for a file, once the folders above it are
/// counted.
pub fn effective_file_access(index: &DriveAccessIndex, file: &DriveFileRef) -> DriveGeneralAccess {
    if is_module_file(file.entity_type.as_deref()) {
        return DriveGeneralAccess::WorkspaceEdit;
    }
    stricter(
        file.general_access,
        container_chain(index, file.folder_id.as_deref()).general,
    )
}

/// The general access in force for a folder, once the folders above it are
/// counted.
pub fn effective_folder_access(
    index: &DriveAccessIndex,
    folder: &DriveFolderRef,
) -> DriveGeneralAccess {
    stricter(
        folder.general_access,
        container_chain(index, folder.parent_id.as_deref()).general,
    )
}

/// The ids of the folders the caller may see, by id (the TypeScript returns
/// them in the database's row order, which is unspecified).
pub fn visible_folder_ids(index: &DriveAccessIndex) -> Vec<String> {
    index
        .folders
        .values()
        .filter(|folder| folder_role(index, folder).is_some())
        .map(|folder| folder.id.clone())
        .collect()
}

/// The folders above `parent_id`, nearest first.
pub fn ancestor_folder_ids(index: &DriveAccessIndex, parent_id: Option<&str>) -> Vec<String> {
    chain(index, parent_id)
        .map(|folder| folder.id.clone())
        .collect()
}

// ── Callers ────────────────────────────────────────────────────────────────

/// Is `user_id` a workspace OWNER or ADMIN (`isWorkspaceAdmin`)?
pub async fn is_workspace_admin(db: &PgPool, user_id: &str) -> Result<bool, sqlx::Error> {
    let role: Option<Option<String>> = sqlx::query_scalar(
        "select role from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let role = role.flatten().map(|role| role.to_uppercase());
    Ok(matches!(role.as_deref(), Some("OWNER" | "ADMIN")))
}

/// The rules for a caller known only by id: a person (admin looked up here),
/// or `None` for a workspace API key (`loadDriveAccessForUser`).
pub async fn load_drive_access_for_user(
    db: &PgPool,
    user_id: Option<&str>,
) -> Result<DriveAccessIndex, sqlx::Error> {
    let is_admin = match user_id {
        Some(user_id) => is_workspace_admin(db, user_id).await?,
        None => false,
    };
    load_drive_access(
        db,
        DriveCaller {
            user_id: user_id.map(str::to_owned),
            is_admin,
        },
    )
    .await
}

/// May `user_id` be shared with: an active member of this workspace
/// (`isShareableMember`)?
pub async fn is_shareable_member(db: &PgPool, user_id: &str) -> Result<bool, sqlx::Error> {
    let member: Option<String> = sqlx::query_scalar(
        "select id from workspace_members
         where user_id = $1 and status = 'ACTIVE' and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(member.is_some())
}

// ── Files ──────────────────────────────────────────────────────────────────

/// A live `files` row (`getFile` in `packages/domains/core/src/files.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct DriveFile {
    /// The row as Drizzle returns it: camelCase keys, ISO timestamps.
    pub row: Value,
    /// What the access rules read.
    pub r#ref: DriveFileRef,
    pub file_name: String,
}

impl DriveFile {
    /// Build from a [`js_row`] of `files`.
    pub fn from_row(row: Value) -> Self {
        let text = |key: &str| row[key].as_str().map(str::to_owned);
        let r#ref = DriveFileRef {
            id: text("id").unwrap_or_default(),
            uploaded_by_id: text("uploadedById"),
            folder_id: text("folderId"),
            general_access: DriveGeneralAccess::parse(
                row["generalAccess"].as_str().unwrap_or_default(),
            ),
            entity_type: text("entityType"),
        };
        let file_name = text("fileName").unwrap_or_default();
        Self {
            row,
            r#ref,
            file_name,
        }
    }
}

/// A live (not deleted) file by id, or `None`.
pub async fn get_file(db: &PgPool, file_id: &str) -> Result<Option<DriveFile>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(f) from files f where id = $1 and deleted_at is null limit 1",
    )
    .bind(file_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| DriveFile::from_row(js_row(row))))
}

#[cfg(test)]
mod tests {
    //! The cases of `drive-access.test.ts`, on an index built by hand.

    use serde_json::json;

    use super::*;

    const ANN: &str = "user_ann";
    const BOB: &str = "user_bob";
    const CAROL: &str = "user_carol";
    const ADMIN: &str = "user_admin";

    use DriveGeneralAccess::{Restricted, WorkspaceEdit, WorkspaceView};

    fn folder(
        id: &str,
        parent: Option<&str>,
        owner: &str,
        access: DriveGeneralAccess,
    ) -> DriveFolderRef {
        DriveFolderRef {
            id: id.to_owned(),
            parent_id: parent.map(str::to_owned),
            created_by_id: Some(owner.to_owned()),
            general_access: access,
        }
    }

    fn file(
        id: &str,
        folder: Option<&str>,
        owner: Option<&str>,
        access: DriveGeneralAccess,
    ) -> DriveFileRef {
        DriveFileRef {
            id: id.to_owned(),
            uploaded_by_id: owner.map(str::to_owned),
            folder_id: folder.map(str::to_owned),
            general_access: access,
            entity_type: None,
        }
    }

    /// The test file's drive: My Drive files, a restricted HR folder with a
    /// subfolder, a view-only folder, and a folder Bob owns inside HR.
    fn index(user_id: Option<&str>, is_admin: bool) -> DriveAccessIndex {
        let folders = [
            folder("fld_hr", None, ANN, Restricted),
            folder("fld_hr_2026", Some("fld_hr"), ANN, WorkspaceEdit),
            folder("fld_policies", None, ANN, WorkspaceView),
            folder("fld_bob_inside", Some("fld_hr"), BOB, WorkspaceEdit),
        ]
        .into_iter()
        .map(|f| (f.id.clone(), f))
        .collect();
        let mut file_shares = HashMap::new();
        let mut folder_shares = HashMap::new();
        match user_id {
            Some(BOB) => {
                file_shares.insert("fil_private_shared".to_owned(), DriveRole::Viewer);
            }
            Some(CAROL) => {
                folder_shares.insert("fld_hr_2026".to_owned(), DriveRole::Editor);
            }
            _ => {}
        }
        DriveAccessIndex {
            caller: DriveCaller {
                user_id: user_id.map(str::to_owned),
                is_admin,
            },
            folders,
            file_shares,
            folder_shares,
        }
    }

    fn files() -> HashMap<&'static str, DriveFileRef> {
        let mut module = file("fil_module", None, Some(ANN), Restricted);
        module.entity_type = Some("project".to_owned());
        [
            ("fil_open", file("fil_open", None, Some(ANN), WorkspaceEdit)),
            (
                "fil_readonly",
                file("fil_readonly", None, Some(ANN), WorkspaceView),
            ),
            (
                "fil_private",
                file("fil_private", None, Some(ANN), Restricted),
            ),
            (
                "fil_private_shared",
                file("fil_private_shared", None, Some(ANN), Restricted),
            ),
            ("fil_module", module),
            ("fil_orphan", file("fil_orphan", None, None, Restricted)),
            (
                "fil_in_hr",
                file("fil_in_hr", Some("fld_hr"), Some(ANN), WorkspaceEdit),
            ),
            (
                "fil_in_hr_2026",
                file(
                    "fil_in_hr_2026",
                    Some("fld_hr_2026"),
                    Some(ANN),
                    WorkspaceEdit,
                ),
            ),
            (
                "fil_policy",
                file("fil_policy", Some("fld_policies"), Some(ANN), WorkspaceEdit),
            ),
            (
                "fil_ann_in_bob_folder",
                file(
                    "fil_ann_in_bob_folder",
                    Some("fld_bob_inside"),
                    Some(ANN),
                    WorkspaceEdit,
                ),
            ),
        ]
        .into_iter()
        .collect()
    }

    fn on_file(user: Option<&str>, admin: bool, id: &str) -> Option<DriveRole> {
        file_role(&index(user, admin), &files()[id])
    }

    fn on_folder(user: Option<&str>, id: &str) -> Option<DriveRole> {
        let index = index(user, false);
        folder_role(&index, &index.folders[id])
    }

    use DriveRole::{Editor, Owner, Viewer};

    #[test]
    fn file_roles_follow_ownership_shares_and_general_access() {
        assert_eq!(on_file(Some(ANN), false, "fil_private"), Some(Owner));
        assert_eq!(on_file(Some(CAROL), false, "fil_open"), Some(Editor));
        assert_eq!(on_file(Some(CAROL), false, "fil_readonly"), Some(Viewer));
        assert_eq!(on_file(Some(CAROL), false, "fil_private"), None);
        assert_eq!(
            on_file(Some(BOB), false, "fil_private_shared"),
            Some(Viewer)
        );
        assert_eq!(on_file(Some(CAROL), false, "fil_private_shared"), None);
    }

    #[test]
    fn folders_restrict_and_grant_all_the_way_down() {
        assert_eq!(on_file(Some(BOB), false, "fil_in_hr"), None);
        assert_eq!(on_file(Some(BOB), false, "fil_in_hr_2026"), None);
        assert_eq!(on_file(Some(CAROL), false, "fil_in_hr_2026"), Some(Editor));
        assert_eq!(on_file(Some(CAROL), false, "fil_in_hr"), None);
        assert_eq!(
            on_file(Some(BOB), false, "fil_ann_in_bob_folder"),
            Some(Editor)
        );
        assert_eq!(on_file(Some(CAROL), false, "fil_policy"), Some(Viewer));
    }

    #[test]
    fn admins_modules_and_workspace_keys() {
        assert_eq!(on_file(Some(ADMIN), true, "fil_private"), Some(Editor));
        assert_eq!(on_file(Some(ADMIN), true, "fil_orphan"), Some(Editor));
        assert_eq!(on_file(Some(CAROL), false, "fil_module"), Some(Editor));
        assert_eq!(on_file(Some(ANN), false, "fil_module"), Some(Owner));
        assert_eq!(on_file(None, false, "fil_open"), Some(Editor));
        assert_eq!(on_file(None, false, "fil_readonly"), Some(Viewer));
        assert_eq!(on_file(None, false, "fil_private"), None);
        assert_eq!(on_file(None, false, "fil_in_hr"), None);
    }

    #[test]
    fn folder_and_container_roles() {
        assert_eq!(on_folder(Some(BOB), "fld_hr"), None);
        assert_eq!(on_folder(Some(CAROL), "fld_hr"), None);
        assert_eq!(on_folder(Some(CAROL), "fld_hr_2026"), Some(Editor));

        let carol = index(Some(CAROL), false);
        assert_eq!(container_role(&carol, None), Some(Editor));
        assert_eq!(container_role(&carol, Some("fld_policies")), Some(Viewer));
        assert_eq!(container_role(&carol, Some("fld_hr")), None);
        assert_eq!(container_role(&carol, Some("fld_hr_2026")), Some(Editor));
        assert_eq!(container_role(&carol, Some("fld_missing")), None);
        assert!(can_edit(container_role(&carol, Some("fld_hr_2026"))));
        assert!(!can_edit(container_role(&carol, Some("fld_policies"))));
        assert!(!can_edit(None));

        assert_eq!(visible_folder_ids(&carol), ["fld_hr_2026", "fld_policies"]);
    }

    #[test]
    fn effective_access_and_ancestors() {
        let carol = index(Some(CAROL), false);
        let files = files();
        assert_eq!(
            effective_file_access(&carol, &files["fil_in_hr_2026"]),
            Restricted
        );
        assert_eq!(
            effective_file_access(&carol, &files["fil_policy"]),
            WorkspaceView
        );
        assert_eq!(
            effective_file_access(&carol, &files["fil_module"]),
            WorkspaceEdit
        );
        assert_eq!(
            effective_folder_access(&carol, &carol.folders["fld_bob_inside"]),
            Restricted
        );
        assert_eq!(
            ancestor_folder_ids(&carol, Some("fld_hr_2026")),
            ["fld_hr_2026", "fld_hr"]
        );
        assert_eq!(ancestor_folder_ids(&carol, None), Vec::<String>::new());
    }

    #[test]
    fn a_folder_loop_ends_the_walk() {
        let mut looped = index(Some(CAROL), false);
        looped.folders.get_mut("fld_hr").expect("folder").parent_id =
            Some("fld_hr_2026".to_owned());
        assert_eq!(
            ancestor_folder_ids(&looped, Some("fld_hr_2026")),
            ["fld_hr_2026", "fld_hr"]
        );
        assert_eq!(file_role(&looped, &files()["fil_in_hr_2026"]), Some(Editor));
    }

    #[test]
    fn file_rows_read_like_drizzle_rows() {
        let file = DriveFile::from_row(json!({
            "id": "fil_1", "fileName": "a.pdf", "folderId": null, "uploadedById": "user_ann",
            "generalAccess": "workspace_view", "entityType": null
        }));
        assert_eq!(file.file_name, "a.pdf");
        assert_eq!(file.r#ref.general_access, WorkspaceView);
        assert_eq!(file.r#ref.uploaded_by_id.as_deref(), Some(ANN));
        assert!(!is_module_file(Some("")));
        assert!(is_module_file(Some("project")));
        assert_eq!(DriveGeneralAccess::parse("nonsense"), Restricted);
    }
}
