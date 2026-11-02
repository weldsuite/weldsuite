//! The Drive queries against the real tenant schema (a database built from
//! the journaled migrations by `scripts/rust-test-db.ts`, as CI does): an
//! index loaded from seeded rows answers like the hand-built one in the unit
//! tests.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use weldsuite_core_domain::drive_access::{
    DriveCaller, DriveGeneralAccess, DriveRole, container_role, file_role, get_file,
    is_shareable_member, is_workspace_admin, load_drive_access, load_drive_access_for_user,
};
use weldsuite_db::master_pool;

#[tokio::test]
async fn drive_access_loads_from_the_migrated_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");

    sqlx::raw_sql(
        r"delete from drive_shares where id like 'dsh_drv_%';
          delete from files where id like 'fil_drv_%';
          delete from folders where id like 'fld_drv_%';
          delete from workspace_members where id like 'wm_drv_%';
          insert into workspace_members (id, user_id, email, role, status) values
              ('wm_drv_ann', 'user_drv_ann', 'ann@example.com', 'MEMBER', 'ACTIVE'),
              ('wm_drv_carol', 'user_drv_carol', 'carol@example.com', 'MEMBER', 'ACTIVE'),
              ('wm_drv_admin', 'user_drv_admin', 'admin@example.com', 'ADMIN', 'ACTIVE');
          insert into folders (id, name, parent_id, created_by_id, general_access) values
              ('fld_drv_hr', 'HR', null, 'user_drv_ann', 'restricted'),
              ('fld_drv_hr_2026', '2026', 'fld_drv_hr', 'user_drv_ann', 'workspace_edit');
          insert into files (id, file_name, mime_type, file_size, storage_path, folder_id,
                             uploaded_by_id, general_access, deleted_at) values
              ('fil_drv_open', 'open.txt', 'text/plain', 1, 'w/open', null, 'user_drv_ann', 'workspace_edit', null),
              ('fil_drv_hr', 'hr.txt', 'text/plain', 1, 'w/hr', 'fld_drv_hr_2026', 'user_drv_ann', 'workspace_edit', null),
              ('fil_drv_gone', 'gone.txt', 'text/plain', 1, 'w/gone', null, 'user_drv_ann', 'workspace_edit', now());
          insert into drive_shares (id, folder_id, user_id, role, shared_by) values
              ('dsh_drv_1', 'fld_drv_hr_2026', 'user_drv_carol', 'editor', 'user_drv_ann');",
    )
    .execute(&db)
    .await
    .expect("seed");

    assert!(
        is_workspace_admin(&db, "user_drv_admin")
            .await
            .expect("admin")
    );
    assert!(
        !is_workspace_admin(&db, "user_drv_carol")
            .await
            .expect("member")
    );
    assert!(
        is_shareable_member(&db, "user_drv_carol")
            .await
            .expect("member")
    );
    assert!(
        get_file(&db, "fil_drv_gone")
            .await
            .expect("query")
            .is_none()
    );

    let hr = get_file(&db, "fil_drv_hr")
        .await
        .expect("query")
        .expect("live");
    assert_eq!(hr.file_name, "hr.txt");
    assert_eq!(hr.row["folderId"], "fld_drv_hr_2026");
    assert_eq!(hr.r#ref.general_access, DriveGeneralAccess::WorkspaceEdit);

    let carol = load_drive_access(
        &db,
        DriveCaller {
            user_id: Some("user_drv_carol".to_owned()),
            is_admin: false,
        },
    )
    .await
    .expect("index");
    assert_eq!(file_role(&carol, &hr.r#ref), Some(DriveRole::Editor));
    assert_eq!(container_role(&carol, Some("fld_drv_hr")), None);

    let admin = load_drive_access_for_user(&db, Some("user_drv_admin"))
        .await
        .expect("index");
    assert!(admin.caller.is_admin);
    assert_eq!(file_role(&admin, &hr.r#ref), Some(DriveRole::Editor));

    let key = load_drive_access_for_user(&db, None).await.expect("index");
    assert_eq!(file_role(&key, &hr.r#ref), None);
    let open = get_file(&db, "fil_drv_open")
        .await
        .expect("query")
        .expect("live");
    assert_eq!(file_role(&key, &open.r#ref), Some(DriveRole::Editor));
}
