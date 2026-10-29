//! Flags from the master database's `feature_flag_overrides`, against a real
//! Postgres.
//!
//! Runs when `WELDSUITE_TEST_DATABASE_URL` points at a throwaway database (the
//! same one the `weldsuite-db` tests use); otherwise it returns early. The
//! table is created here, in the shape documented on `MasterDbFlagSource`.

use std::time::Duration;

use serde_json::json;
use sqlx::PgPool;
use weldsuite_adapters_oss::MasterDbFlagSource;
use weldsuite_catalogs::flags::{HELLO_WORLD, WELDMAIL_OUTBOUND_GUARD, WELDREACH_SENDING};
use weldsuite_ports::{FlagContext, FlagSourceExt};

const SCHEMA: &str = "
drop table if exists feature_flag_overrides;
create table feature_flag_overrides (
    id varchar(30) primary key,
    flag_key varchar(100) not null,
    workspace_id varchar(255),
    value jsonb not null,
    updated_at timestamptz not null default now(),
    unique nulls not distinct (flag_key, workspace_id)
);
insert into feature_flag_overrides (id, flag_key, workspace_id, value) values
    ('ffo_1', 'weldmail-outbound-guard', null, '\"off\"'),
    ('ffo_2', 'weldmail-outbound-guard', 'org_1', '\"enforce\"'),
    ('ffo_3', 'hello-world', 'ws_2', 'true'),
    ('ffo_4', 'weldreach-sending', null, '\"not a boolean\"');
";

fn context(workspace_id: &str, clerk_org_id: Option<&str>) -> FlagContext {
    FlagContext {
        workspace_id: workspace_id.to_owned(),
        clerk_org_id: clerk_org_id.map(str::to_owned),
        user_id: "user_1".to_owned(),
    }
}

#[tokio::test]
async fn overrides_resolve_per_workspace_and_refresh() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL is not set; skipping");
        return;
    };
    let pool = PgPool::connect(&url).await.expect("connects");
    sqlx::raw_sql(SCHEMA).execute(&pool).await.expect("schema");

    let flags = MasterDbFlagSource::new(pool.clone(), Duration::from_millis(200));
    let ws1 = context("ws_1", Some("org_1"));
    let ws2 = context("ws_2", Some("org_2"));

    // A workspace row (by Clerk org id here) beats the row for everyone.
    assert_eq!(
        flags.string_value(WELDMAIL_OUTBOUND_GUARD, &ws1).await,
        "enforce"
    );
    assert_eq!(
        flags.string_value(WELDMAIL_OUTBOUND_GUARD, &ws2).await,
        "off"
    );
    // A row by workspaces.id; no row means the catalog default.
    assert!(flags.is_on(HELLO_WORLD, &ws2).await);
    assert!(!flags.is_on(HELLO_WORLD, &ws1).await);
    // A value of the wrong type falls back to the default.
    assert!(flags.is_on(WELDREACH_SENDING, &ws1).await);

    // Changes show after the refresh period, or at once after invalidate().
    sqlx::query("update feature_flag_overrides set value = $1 where id = 'ffo_1'")
        .bind(json!("shadow"))
        .execute(&pool)
        .await
        .expect("update");
    assert_eq!(
        flags.string_value(WELDMAIL_OUTBOUND_GUARD, &ws2).await,
        "off"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        flags.string_value(WELDMAIL_OUTBOUND_GUARD, &ws2).await,
        "shadow"
    );

    sqlx::query("delete from feature_flag_overrides where id = 'ffo_3'")
        .execute(&pool)
        .await
        .expect("delete");
    flags.invalidate();
    assert!(!flags.is_on(HELLO_WORLD, &ws2).await);

    // With the table gone, the last values keep being served.
    sqlx::raw_sql("drop table feature_flag_overrides")
        .execute(&pool)
        .await
        .expect("drop");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        flags.string_value(WELDMAIL_OUTBOUND_GUARD, &ws1).await,
        "enforce"
    );

    // And a fresh source with no previous read falls back to the defaults.
    let cold = MasterDbFlagSource::new(pool, Duration::from_secs(30));
    assert_eq!(
        cold.string_value(WELDMAIL_OUTBOUND_GUARD, &ws1).await,
        "shadow"
    );
}
