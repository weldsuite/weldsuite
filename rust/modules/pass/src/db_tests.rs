//! The writes the conformance suite cannot reach on Rust, against the real
//! tenant schema (`scripts/rust-test-db.ts`): a GET that writes runs on
//! TypeScript first in conformance mode, so Rust only ever finds what
//! TypeScript made. Here Rust makes it: the personal vault created on first
//! use, and the legacy checksum a reveal upgrades.
//!
//! Run when `WELDSUITE_TEST_TENANT_URL` is set; otherwise they return early.

use weldsuite_db::master_pool;

use crate::envelope::{
    RootKeyring, SecretLocation, checksum_for, create_vault_key, seal_secret, sha256_hex,
    unwrap_vault_key,
};
use crate::password_vaults::{ensure_personal_vault, list_vaults, require_vault_access};
use crate::secrets::reveal_secret;

const ROOT: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

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
