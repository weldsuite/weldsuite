//! The file store, folder tree and sharing queries against the real tenant
//! schema (built from the journaled migrations by `scripts/rust-test-db.ts`).
//! The conformance suite runs the same SQL on pglite; this checks it on
//! Postgres itself.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use serde_json::json;
use weldsuite_core_domain::drive_access::{
    DriveCaller, DriveGeneralAccess, DriveRole, load_drive_access,
};
use weldsuite_core_domain::drive_sharing::{
    DriveItem, NewShare, SharingTarget, describe_sharing, list_shared_with_user, remove_share,
    upsert_share,
};
use weldsuite_core_domain::files::{
    self, Change, FileUpdate, ListFiles, MovedFile, NewFile, UpdatedFile,
};
use weldsuite_core_domain::folders::{self, NewFolder, ParentProblem};
use weldsuite_db::master_pool;

const NOW: &str = "2026-10-29T07:00:00.123Z";

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn files_folders_and_shares_on_the_migrated_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    sqlx::raw_sql(
        r"delete from drive_shares where user_id like 'user_fs_%';
          delete from files where uploaded_by_id like 'user_fs_%';
          delete from folders where created_by_id like 'user_fs_%';
          delete from workspace_members where id like 'wm_fs_%';
          insert into workspace_members (id, user_id, email, name, role, status) values
              ('wm_fs_ann', 'user_fs_ann', 'ann@example.com', 'Ann', 'MEMBER', 'ACTIVE'),
              ('wm_fs_bob', 'user_fs_bob', 'bob@example.com', 'Bob', 'MEMBER', 'ACTIVE');",
    )
    .execute(&db)
    .await
    .expect("seed");

    let folder = folders::create_folder(
        &db,
        &NewFolder {
            name: "FS reports".to_owned(),
            created_by_id: Some("user_fs_ann".to_owned()),
            ..NewFolder::default()
        },
        NOW,
    )
    .await
    .expect("folder");
    let folder_id = folder["id"].as_str().expect("id").to_owned();
    assert_eq!(folder["createdAt"], NOW);
    assert_eq!(
        folders::check_folder_parent(&db, Some(&folder_id), Some(&folder_id))
            .await
            .expect("check"),
        Some(ParentProblem::Cycle)
    );
    assert_eq!(
        folders::check_folder_parent(&db, None, Some("fld_fs_missing"))
            .await
            .expect("check"),
        Some(ParentProblem::NotFound)
    );

    let new_file = |name: &str| NewFile {
        file_name: name.to_owned(),
        mime_type: "text/plain".to_owned(),
        file_size: 3,
        storage_path: format!("workspaces/org_fs/{name}"),
        folder_id: Some(folder_id.clone()),
        metadata: Some(json!({ "source": "test" })),
        uploaded_by_id: "user_fs_ann".to_owned(),
        ..NewFile::default()
    };
    let first = files::create_file(&db, &new_file("a.txt"), NOW)
        .await
        .expect("file");
    let second = files::create_file(&db, &new_file("A.TXT"), NOW)
        .await
        .expect("file");
    assert_eq!(second["fileName"], "A (1).TXT");
    let first_id = first["id"].as_str().expect("id").to_owned();

    let listed = files::list_files(
        &db,
        &ListFiles {
            folder_id: Some(&folder_id),
            ..ListFiles::default()
        },
    )
    .await
    .expect("list");
    assert_eq!(listed.len(), 2);

    let update = FileUpdate {
        description: Change::Set(Some("<p>Hi</p>".to_owned())),
        general_access: Change::Set("restricted".to_owned()),
        ..FileUpdate::default()
    };
    let UpdatedFile::Updated { row, previous } = files::update_file(&db, &first_id, &update, NOW)
        .await
        .expect("update")
    else {
        panic!("not updated");
    };
    assert_eq!(
        row["metadata"],
        json!({ "source": "test", "description": "<p>Hi</p>" })
    );
    assert_eq!(previous["generalAccess"], "workspace_edit");
    let rename = FileUpdate {
        file_name: Change::Set("a (1).txt".to_owned()),
        ..FileUpdate::default()
    };
    assert_eq!(
        files::update_file(&db, &first_id, &rename, NOW)
            .await
            .expect("update"),
        UpdatedFile::NameConflict
    );

    let (starred, _) = files::toggle_star(&db, &first_id, NOW)
        .await
        .expect("star")
        .expect("file");
    assert!(starred);
    let (pinned, pinned_row) = files::toggle_pin(&db, &first_id, "user_fs_ann", NOW)
        .await
        .expect("pin")
        .expect("file");
    assert!(pinned);
    assert_eq!(pinned_row["isPinned"], true);
    assert!(matches!(
        files::move_file(&db, &first_id, Some("fld_fs_missing"), NOW)
            .await
            .expect("move"),
        MovedFile::FolderNotFound
    ));
    assert!(matches!(
        files::move_file(&db, &first_id, None, NOW)
            .await
            .expect("move"),
        MovedFile::Moved(_)
    ));

    // Sharing the folder reaches Bob; the summary lists the share.
    assert_eq!(
        upsert_share(
            &db,
            DriveItem::Folder(&folder_id),
            NewShare {
                user_id: "user_fs_bob",
                role: "viewer",
                shared_by: "user_fs_ann",
                now: NOW,
            },
        )
        .await
        .expect("share"),
        None
    );
    let index = load_drive_access(
        &db,
        DriveCaller {
            user_id: Some("user_fs_ann".to_owned()),
            is_admin: false,
        },
    )
    .await
    .expect("index");
    let sharing = describe_sharing(
        &db,
        &index,
        SharingTarget {
            item: DriveItem::Folder(&folder_id),
            owner_id: Some("user_fs_ann"),
            general_access: DriveGeneralAccess::WorkspaceEdit,
            parent_id: None,
        },
        DriveRole::Owner,
    )
    .await
    .expect("sharing");
    assert_eq!(sharing["owner"]["name"], "Ann");
    assert_eq!(sharing["shares"][0]["userId"], "user_fs_bob");
    assert_eq!(sharing["shares"][0]["createdAt"], NOW);
    let (_, shared_folders) = list_shared_with_user(&db, "user_fs_bob")
        .await
        .expect("shared");
    assert_eq!(shared_folders.len(), 1);
    assert_eq!(shared_folders[0].shared_at, NOW);
    assert_eq!(
        remove_share(&db, DriveItem::Folder(&folder_id), "user_fs_bob")
            .await
            .expect("unshare")
            .as_deref(),
        Some("viewer")
    );

    // Trash: the file comes back, the folder goes with what is in it.
    files::soft_delete_file(&db, &first_id, NOW)
        .await
        .expect("trash")
        .expect("file");
    let trashed = files::list_trashed_files(&db).await.expect("trash");
    assert!(trashed.iter().any(|row| row["id"] == first_id.as_str()));
    files::restore_file(&db, &first_id, NOW)
        .await
        .expect("restore")
        .expect("file");
    folders::soft_delete_folder(&db, &folder_id, NOW)
        .await
        .expect("trash")
        .expect("folder");
    let keys = folders::list_purged_file_keys(&db, &[], std::slice::from_ref(&folder_id))
        .await
        .expect("keys");
    assert_eq!(keys, ["workspaces/org_fs/A.TXT"]);
    folders::purge_trashed(&db, &[], std::slice::from_ref(&folder_id))
        .await
        .expect("purge");
    assert!(
        folders::trashed_folder(&db, &folder_id)
            .await
            .expect("gone")
            .is_none()
    );
    assert!(
        files::live_file(&db, &first_id)
            .await
            .expect("kept")
            .is_some()
    );
}
