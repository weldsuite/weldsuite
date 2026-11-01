//! The due index on the migrated master schema (master migration 0063).
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set (`scripts/rust-test-db.ts`
//! builds the database; CI's `Rust · checks` sets it), and skips otherwise.

use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};
use weldsuite_db::due_index::{list_due, mark_due, run_sweep, settle};

#[tokio::test]
async fn marks_only_pull_earlier_and_settles_respect_concurrent_writes() {
    let Ok(url) = std::env::var("WELDSUITE_TEST_MASTER_URL") else {
        eprintln!("WELDSUITE_TEST_MASTER_URL not set; skipping");
        return;
    };
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("master database");
    let kind = format!("test_{}", weldsuite_kit::generate_id("k"));
    let now = OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .expect("whole second");

    // A later mark never pushes the due time out.
    mark_due(&pool, &kind, "org_a", now + Duration::hours(2)).await;
    mark_due(&pool, &kind, "org_a", now + Duration::hours(5)).await;
    mark_due(&pool, &kind, "org_b", now - Duration::minutes(1)).await;
    let due = list_due(&pool, &kind, now + Duration::hours(3), 10)
        .await
        .expect("list");
    let ids: Vec<&str> = due.iter().map(|r| r.workspace_id.as_str()).collect();
    assert_eq!(ids, ["org_b", "org_a"], "earliest first");
    assert_eq!(due[1].next_due_at, now + Duration::hours(2));

    // A write after listing wins over the sweep's settle.
    let row = due[0].clone();
    mark_due(&pool, &kind, "org_b", now - Duration::minutes(5)).await;
    assert!(!settle(&pool, &kind, &row, None).await.expect("settle"));

    // The sweep processes due rows and drops the ones with nothing left.
    let result = run_sweep(&pool, &kind, now, 10, None, |workspace, _| async move {
        Ok::<_, String>(if workspace == "org_b" {
            None
        } else {
            Some(now + Duration::days(1))
        })
    })
    .await;
    assert_eq!((result.due, result.processed, result.failed), (1, 1, 0));
    let left = list_due(&pool, &kind, now + Duration::hours(1), 10)
        .await
        .expect("list");
    assert_eq!(left, Vec::new(), "nothing due within the hour");

    sqlx::query("delete from workspace_due_index where kind = $1")
        .bind(&kind)
        .execute(&pool)
        .await
        .expect("cleanup");
}
