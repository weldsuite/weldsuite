//! `backfillChecksums` against the real tenant schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`): legacy SHA-256
//! checksums on current and history rows become keyed ones, a row that will
//! not open is counted, and a second run changes nothing.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use weldsuite_db::master_pool;
use weldsuite_pass::envelope::{SecretLocation, checksum_for, seal_secret, sha256_hex};
use weldsuite_pass::{
    Backfilled, RootKeyring, backfill_checksums, create_vault_key, unwrap_vault_key,
};

const ROOT: &str = "abababababababababababababababababababababababababababababababab";

#[tokio::test]
async fn rekeys_legacy_checksums_once() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let keyring = RootKeyring::from_values(Some(ROOT), None);
    let project = "wpp_backfill_t";
    let wrapped = create_vault_key(&keyring, project).expect("vault key");
    let kek = unwrap_vault_key(&keyring, project, &wrapped.kek_wrapped).expect("kek");
    sqlx::raw_sql(
        "delete from weldpass_secret_versions where project_id = 'wpp_backfill_t';
         delete from weldpass_secrets where project_id = 'wpp_backfill_t';",
    )
    .execute(&db)
    .await
    .expect("clean");

    let seed = |id: &'static str, key: &'static str, value: &'static str| {
        let location = SecretLocation::new(project, "wpe_backfill_t", key);
        let sealed = seal_secret(&kek, &location, value).expect("seal");
        (id, key, value, sealed)
    };
    let rows = [
        seed("wps_backfill_1", "LEGACY", "legacy-value"),
        seed("wps_backfill_2", "KEYED", "keyed-value"),
    ];
    for (index, (id, key, value, sealed)) in rows.iter().enumerate() {
        let checksum = if index == 0 {
            sha256_hex(value)
        } else {
            sealed.checksum.clone()
        };
        sqlx::query(
            "insert into weldpass_secrets (id, project_id, environment_id, key, ciphertext, dek_wrapped, checksum) \
             values ($1, $2, 'wpe_backfill_t', $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(project)
        .bind(key)
        .bind(&sealed.ciphertext)
        .bind(&sealed.dek_wrapped)
        .bind(&checksum)
        .execute(&db)
        .await
        .expect("secret");
        sqlx::query(
            "insert into weldpass_secret_versions (id, secret_id, project_id, version, action, ciphertext, dek_wrapped, checksum) \
             values ($1, $2, $3, 1, 'created', $4, $5, $6)",
        )
        .bind(format!("wpv_backfill_{index}"))
        .bind(id)
        .bind(project)
        .bind(&sealed.ciphertext)
        .bind(&sealed.dek_wrapped)
        .bind(&checksum)
        .execute(&db)
        .await
        .expect("version");
    }
    // A history row whose secret is gone cannot be located: counted as failed.
    sqlx::query(
        "insert into weldpass_secret_versions (id, secret_id, project_id, version, action, ciphertext, dek_wrapped, checksum) \
         values ('wpv_backfill_x', 'wps_backfill_gone', $1, 1, 'created', 'v1:00:00', 'v1:00:00', 'abc')",
    )
    .bind(project)
    .execute(&db)
    .await
    .expect("orphan");

    let first = backfill_checksums(&db, &kek, project)
        .await
        .expect("backfill");
    assert_eq!(
        first,
        Backfilled {
            secrets: 1,
            versions: 1,
            failed: 1
        }
    );
    let stored: String =
        sqlx::query_scalar("select checksum from weldpass_secrets where id = 'wps_backfill_1'")
            .fetch_one(&db)
            .await
            .expect("checksum");
    let location = SecretLocation::new(project, "wpe_backfill_t", "LEGACY");
    assert_eq!(
        stored,
        checksum_for(&kek, &location, "legacy-value").expect("keyed")
    );

    let second = backfill_checksums(&db, &kek, project).await.expect("again");
    assert_eq!(
        second,
        Backfilled {
            secrets: 0,
            versions: 0,
            failed: 1
        }
    );
}
