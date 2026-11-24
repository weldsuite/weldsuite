//! The writes the conformance suite cannot reach on Rust, against the real
//! tenant schema (`scripts/rust-test-db.ts`): a GET that writes runs on
//! TypeScript first in conformance mode, so Rust only ever finds what
//! TypeScript made. Here Rust makes it: the personal vault created on first
//! use, and the legacy checksum a reveal upgrades. And the devices' offline
//! copy (ADR PASS-010), which only Rust serves.
//!
//! Run when `WELDSUITE_TEST_TENANT_URL` is set; otherwise they return early.

#![allow(clippy::disallowed_methods, reason = "test fixtures")]

use serde_json::{Value, json};
use weldsuite_db::master_pool;

use crate::devices::{
    find_device, list_devices, offline_copies, register_device, revoke_device, set_offline_copies,
    sync_copy,
};
use crate::envelope::{
    RootKeyring, SecretLocation, checksum_for, create_vault_key, seal_secret, sha256_hex,
    unwrap_vault_key,
};
use crate::password_items::{create_items, delete_item};
use crate::password_vaults::{
    create_shared_vault, delete_vault, ensure_personal_vault, list_vaults, open_password_vault,
    require_vault_access,
};
use crate::schemas::{ItemDocument, parse_item};
use crate::secrets::reveal_secret;

const ROOT: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

/// The devices test's own workspace, cleaned at its start.
const DEVICES_WORKSPACE: &str = "org_db_tests_devices";
const OWNER: &str = "user_device_owner";
const SEED: &str = "JBSWY3DPEHPK3PXP";

fn tenant() -> Option<sqlx::PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
    master_pool(&url, 2).ok()
}

#[tokio::test]
async fn creates_the_personal_vault_once() {
    let Some(db) = tenant() else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    sqlx::query("delete from weldpass_vaults where workspace_id = 'org_db_tests'")
        .execute(&db)
        .await
        .expect("clean");
    let keyring = RootKeyring::from_values(Some(ROOT), None);
    ensure_personal_vault(&db, Some("org_db_tests"), &keyring, "user_first")
        .await
        .expect("created");
    ensure_personal_vault(&db, Some("org_db_tests"), &keyring, "user_first")
        .await
        .expect("found");
    let vaults = list_vaults(&db, Some("org_db_tests"), "user_first", false)
        .await
        .expect("listed");
    assert_eq!(vaults.len(), 1);
    assert_eq!(vaults[0]["kind"], "personal");
    assert_eq!(vaults[0]["name"], "Personal");
    assert_eq!(vaults[0]["role"], "manager");
    assert_eq!(vaults[0]["memberCount"], 1);

    let id = vaults[0]["id"].as_str().expect("id");
    let wrapped: String =
        sqlx::query_scalar("select kek_wrapped from weldpass_vaults where id = $1")
            .bind(id)
            .fetch_one(&db)
            .await
            .expect("wrapped");
    assert!(unwrap_vault_key(&keyring, id, &wrapped).is_ok());

    let access = require_vault_access(&db, Some("org_db_tests"), "user_first", id, false)
        .await
        .expect("owner");
    assert_eq!(access.role.as_deref(), Some("manager"));
    assert!(
        require_vault_access(&db, Some("org_db_tests"), "user_other", id, true)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_reveal_upgrades_a_legacy_checksum() {
    let Some(db) = tenant() else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let keyring = RootKeyring::from_values(Some(ROOT), None);
    let wrapped = create_vault_key(&keyring, "wpp_db_tests").expect("kek");
    let kek = unwrap_vault_key(&keyring, "wpp_db_tests", &wrapped.kek_wrapped).expect("kek");
    let location = SecretLocation::new("wpp_db_tests", "wpe_db_tests", "OLD");
    let sealed = seal_secret(&kek, &location, "old-value").expect("seal");
    sqlx::query("delete from weldpass_secrets where id = 'wps_db_tests'")
        .execute(&db)
        .await
        .expect("clean");
    sqlx::query(
        "insert into weldpass_secrets (id, project_id, environment_id, key, ciphertext, dek_wrapped, checksum) \
         values ('wps_db_tests', 'wpp_db_tests', 'wpe_db_tests', 'OLD', $1, $2, $3)",
    )
    .bind(&sealed.ciphertext)
    .bind(&sealed.dek_wrapped)
    .bind(sha256_hex("old-value"))
    .execute(&db)
    .await
    .expect("seed");

    let (secret, value) = reveal_secret(&db, &kek, "wpe_db_tests", "wps_db_tests")
        .await
        .expect("revealed");
    assert_eq!(value, "old-value");
    let keyed = checksum_for(&kek, &location, "old-value").expect("keyed");
    assert_eq!(secret.json["checksum"], keyed.as_str());
    let stored: String =
        sqlx::query_scalar("select checksum from weldpass_secrets where id = 'wps_db_tests'")
            .fetch_one(&db)
            .await
            .expect("stored");
    assert_eq!(stored, keyed);
}

/// Drop what an earlier run of the devices test left in its workspace.
async fn clean_devices_workspace(db: &sqlx::PgPool) {
    for statement in [
        "delete from weldpass_item_versions where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_items where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vault_members where vault_id in \
         (select id from weldpass_vaults where workspace_id = $1)",
        "delete from weldpass_vaults where workspace_id = $1",
        "delete from weldpass_devices where workspace_id = $1",
    ] {
        sqlx::query(statement)
            .bind(DEVICES_WORKSPACE)
            .execute(db)
            .await
            .expect("clean");
    }
}

/// An item as the routes take it.
fn document(item: &Value) -> ItemDocument {
    parse_item(&item.to_string()).expect("an item")
}

/// One vault of a sync's answer.
fn synced<'a>(result: &'a Value, vault_id: &str) -> &'a Value {
    result["vaults"]
        .as_array()
        .and_then(|vaults| vaults.iter().find(|vault| vault["vault"]["id"] == vault_id))
        .expect("the vault was synced")
}

/// The ids of a list of items.
fn ids(items: &Value) -> Vec<String> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

/// Register, sync whole, sync from a cursor (a write, a deletion), lose a
/// vault, switch offline copies off, revoke. One test: the setting is the
/// tenant's, so a second test syncing at the same time would see it off.
#[tokio::test]
#[allow(clippy::too_many_lines)] // one flow, step by step
async fn a_device_keeps_its_copy_in_sync() {
    let Some(db) = tenant() else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    clean_devices_workspace(&db).await;
    let ws = Some(DEVICES_WORKSPACE);
    let keyring = RootKeyring::from_values(Some(ROOT), None);
    set_offline_copies(&db, true).await.expect("switched on");

    ensure_personal_vault(&db, ws, &keyring, OWNER)
        .await
        .expect("personal");
    let personal = list_vaults(&db, ws, OWNER, false).await.expect("listed")[0]["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let personal_key = open_password_vault(&db, &keyring, &personal)
        .await
        .expect("key");
    let shared = create_shared_vault(&db, ws, &keyring, "Team", None, OWNER)
        .await
        .expect("shared");
    let shared_key = open_password_vault(&db, &keyring, &shared.id)
        .await
        .expect("key");
    let mail = create_items(
        &db,
        &personal_key,
        &personal,
        &[document(&json!({
            "type": "login",
            "title": "Mail",
            "url": "https://mail.example.com",
            "fields": { "username": "me", "password": "pw-mail", "totp": SEED },
        }))],
        OWNER,
    )
    .await
    .expect("created")
    .remove(0);
    create_items(
        &db,
        &shared_key,
        &shared.id,
        &[document(&json!({
            "type": "login",
            "title": "Router",
            "fields": { "username": "admin", "password": "pw-router", "totp": SEED },
        }))],
        OWNER,
    )
    .await
    .expect("created");

    let registered = register_device(&db, ws, OWNER, "Test phone", "ios", Some("1.0.0"))
        .await
        .expect("registered");
    assert_eq!(registered["platform"], "ios");
    assert_eq!(registered["appVersion"], "1.0.0");
    assert!(registered["lastSyncAt"].is_null());
    assert!(registered["revokedAt"].is_null());
    let device_id = registered["id"].as_str().expect("id").to_owned();
    let device = find_device(&db, ws, &device_id)
        .await
        .expect("read")
        .expect("found");
    assert!(!device.revoked);
    assert!(
        find_device(&db, Some("org_elsewhere"), &device_id)
            .await
            .expect("read")
            .is_none()
    );

    // The first sync: every vault whole, a shared vault's 2FA seed held back.
    let first = sync_copy(&db, &keyring, ws, &device, &[])
        .await
        .expect("synced");
    assert_eq!(first.json["wipe"], false);
    assert!(first.json["reason"].is_null());
    assert_eq!(first.json["removedVaultIds"], json!([]));
    let mine = synced(&first.json, &personal);
    assert_eq!(mine["full"], true);
    assert_eq!(ids(&mine["items"]), vec![mail.id.clone()]);
    assert_eq!(mine["items"][0]["fields"]["totp"], SEED);
    assert_eq!(mine["items"][0]["fields"]["password"], "pw-mail");
    let team = synced(&first.json, &shared.id);
    assert_eq!(team["vault"]["kind"], "shared");
    assert_eq!(team["items"][0]["hasTotp"], true);
    assert_eq!(team["items"][0]["fields"]["totp"], "");
    assert_eq!(team["items"][0]["fields"]["password"], "pw-router");
    assert_eq!(first.sent.len(), 2);
    let listed = list_devices(&db, ws, OWNER).await.expect("listed");
    assert!(listed[0]["lastSyncAt"].is_string());

    // From a cursor: only what changed after it.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let mark = weldsuite_events::iso_timestamp(crate::now());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let wifi = create_items(
        &db,
        &personal_key,
        &personal,
        &[document(&json!({
            "type": "note",
            "title": "Wifi",
            "fields": { "content": "hunter2" },
        }))],
        OWNER,
    )
    .await
    .expect("created")
    .remove(0);
    let cursors = [
        (personal.clone(), mark.clone()),
        (shared.id.clone(), mark.clone()),
    ];
    let second = sync_copy(&db, &keyring, ws, &device, &cursors)
        .await
        .expect("synced");
    let mine = synced(&second.json, &personal);
    assert_eq!(mine["full"], false);
    assert_eq!(ids(&mine["items"]), vec![wifi.id.clone()]);
    assert_eq!(mine["deletedIds"], json!([]));
    assert_eq!(synced(&second.json, &shared.id)["items"], json!([]));
    assert_eq!(second.sent.len(), 1);
    assert_eq!(second.sent[0].vault_id, personal);
    assert!(!second.sent[0].full);
    assert_eq!(second.sent[0].items, 1);

    // A deletion since the cursor.
    delete_item(&db, &personal, &wifi.id, OWNER)
        .await
        .expect("deleted");
    let third = sync_copy(&db, &keyring, ws, &device, &cursors)
        .await
        .expect("synced");
    let mine = synced(&third.json, &personal);
    assert_eq!(mine["items"], json!([]));
    assert_eq!(mine["deletedIds"], json!([wifi.id]));

    // A cursor this server did not write: that vault whole again.
    let garbled = [(personal.clone(), "not a cursor".to_owned())];
    let again = sync_copy(&db, &keyring, ws, &device, &garbled)
        .await
        .expect("synced");
    let mine = synced(&again.json, &personal);
    assert_eq!(mine["full"], true);
    assert_eq!(ids(&mine["items"]), vec![mail.id.clone()]);

    // A vault the person can no longer read: the device drops it.
    delete_vault(&db, &shared.id).await.expect("deleted");
    let fourth = sync_copy(&db, &keyring, ws, &device, &cursors)
        .await
        .expect("synced");
    assert_eq!(fourth.json["removedVaultIds"], json!([shared.id]));
    assert_eq!(fourth.json["vaults"].as_array().map(Vec::len), Some(1));

    // Offline copies switched off: the copy is wiped.
    set_offline_copies(&db, false).await.expect("switched off");
    assert!(!offline_copies(&db).await.expect("read"));
    let off = sync_copy(&db, &keyring, ws, &device, &cursors)
        .await
        .expect("synced");
    assert_eq!(off.json["wipe"], true);
    assert_eq!(off.json["reason"], "disabled");
    assert_eq!(off.json["vaults"], json!([]));
    set_offline_copies(&db, true).await.expect("switched on");
    assert!(offline_copies(&db).await.expect("read"));

    // Revoked: wiped; revoking again keeps the first revocation.
    revoke_device(&db, Some("org_elsewhere"), &device_id, "user_stranger")
        .await
        .expect("nothing to revoke");
    assert!(
        !find_device(&db, ws, &device_id)
            .await
            .expect("read")
            .expect("found")
            .revoked
    );
    revoke_device(&db, ws, &device_id, "user_admin")
        .await
        .expect("revoked");
    revoke_device(&db, ws, &device_id, OWNER)
        .await
        .expect("revoked again");
    let device = find_device(&db, ws, &device_id)
        .await
        .expect("read")
        .expect("found");
    assert!(device.revoked);
    let wiped = sync_copy(&db, &keyring, ws, &device, &cursors)
        .await
        .expect("synced");
    assert_eq!(wiped.json["wipe"], true);
    assert_eq!(wiped.json["reason"], "revoked");
    assert_eq!(wiped.json["removedVaultIds"], json!([]));
    assert!(wiped.sent.is_empty());
    let listed = list_devices(&db, ws, OWNER).await.expect("listed");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["revokedBy"], "user_admin");
}
