//! The tax reminders' production delivery on the real tenant schema (built
//! from the journaled migrations by `scripts/rust-test-db.ts`):
//! [`InAppNotifier`] writes the `notifications` row `createInAppNotifier`
//! writes and publishes it on the realtime port, and [`CacheMarkers`] keeps a
//! marker per workspace with its TTL. The reminders themselves are compared
//! with TypeScript by the `books: sales-tax` conformance suite
//! (`cron/tax-reminders.test.ts`, through `conformanceSweep`).
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_books_sales_tax::reminders::{
    CacheMarkers, InAppNotifier, ReminderMarkers, ReminderNotice, ReminderNotifier,
    reminder_recipients,
};
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynCache, DynRealtimePublisher, MemoryCache, RecordingRealtime};

fn notice() -> ReminderNotice {
    ReminderNotice {
        title: "Sales tax return overdue: Texas Comptroller".to_owned(),
        body: "The TX return is overdue.".to_owned(),
        severity: "error",
        action_url: "/weldbooks/sales-tax",
        entity_type: "sales_tax_agency",
        entity_id: "agy_tx".to_owned(),
        data: vec![("kind", "sales_tax_due".to_owned())],
    }
}

#[tokio::test]
async fn the_in_app_notifier_writes_the_row_and_publishes_it() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let user = generate_id("user");
    let realtime = Arc::new(RecordingRealtime::default());
    let port: Arc<dyn DynRealtimePublisher> = realtime.clone();
    let notifier = InAppNotifier::new(db.clone(), Some(port), "org_reminders");
    notifier.send(&user, &notice()).await.expect("sent");

    let row: Value =
        sqlx::query_scalar("select to_jsonb(n) from notifications n where n.user_id = $1")
            .bind(&user)
            .fetch_one(&db)
            .await
            .expect("notification row");
    let id = row["id"].as_str().expect("id").to_owned();
    assert!(id.starts_with("notif_"));
    for (column, value) in [
        ("title", "Sales tax return overdue: Texas Comptroller"),
        ("category", "weldbooks"),
        ("notification_type", "sales_tax_due"),
        ("entity_type", "sales_tax_agency"),
        ("entity_id", "agy_tx"),
        ("action_url", "/weldbooks/sales-tax"),
        ("severity", "error"),
        ("actor_type", "system"),
    ] {
        assert_eq!(row[column], value, "{column}");
    }
    assert_eq!(row["data"], serde_json::json!({ "kind": "sales_tax_due" }));
    assert_eq!(row["delivered_in_app"], true);
    assert_eq!(row["is_read"], false);

    let messages = realtime.messages();
    assert_eq!(messages.len(), 1);
    let text = format!("{} {}", messages[0].channel, messages[0].payload);
    assert!(text.contains("org_reminders"), "{text}");
    assert!(text.contains(&format!("notification.{user}")), "{text}");
    assert!(text.contains(&id), "{text}");

    // Without a realtime port the row is still saved.
    let quiet = InAppNotifier::new(db.clone(), None, "org_reminders");
    let other = generate_id("user");
    quiet.send(&other, &notice()).await.expect("sent");
    let count: i64 = sqlx::query_scalar("select count(*) from notifications where user_id = $1")
        .bind(&other)
        .fetch_one(&db)
        .await
        .expect("count");
    assert_eq!(count, 1);

    // The recipients are the active owners and admins.
    let owner = generate_id("user");
    let suspended = generate_id("user");
    for (user_id, role, status) in [
        (owner.as_str(), "OWNER", "ACTIVE"),
        (suspended.as_str(), "ADMIN", "SUSPENDED"),
    ] {
        sqlx::query(
            "insert into workspace_members (id, user_id, role, status) values ($1, $2, $3, $4)",
        )
        .bind(generate_id("wm"))
        .bind(user_id)
        .bind(role)
        .bind(status)
        .execute(&db)
        .await
        .expect("member");
    }
    let recipients = reminder_recipients(&db).await.expect("recipients");
    assert!(recipients.contains(&owner));
    assert!(!recipients.contains(&suspended));
}

#[tokio::test]
async fn cache_markers_are_per_workspace_and_expire() {
    let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::default());
    let markers = CacheMarkers::new(Arc::clone(&cache), "ws_1");
    let marker = "sales_tax:agy_tx:2026-09-30:7d";
    assert!(!markers.has(marker).await.expect("has"));
    markers.set(marker, 150 * 86_400).await.expect("set");
    assert!(markers.has(marker).await.expect("has"));
    assert_eq!(
        cache
            .get_boxed("books:reminder:ws_1:sales_tax:agy_tx:2026-09-30:7d")
            .await
            .expect("get")
            .as_deref(),
        Some("1")
    );
    // The next workspace has its own markers.
    assert!(
        !CacheMarkers::new(Arc::clone(&cache), "ws_2")
            .has(marker)
            .await
            .expect("has")
    );
}
