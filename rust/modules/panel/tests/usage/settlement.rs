//! `services/usage-settlement.test.ts`: settlement of WeldPanel usage
//! against the credit wallet (ADR PANEL-007) on the real master schema. The
//! totals only grow, each overage block is charged once whatever the
//! retries, an empty wallet blocks recordings at once and events past the
//! 10% grace, a top-up lifts the block, the quota state reaches the cache,
//! and each usage notice is claimed once per threshold per month.
//!
//! Runs when `WELDSUITE_TEST_MASTER_URL` is set; otherwise every test
//! returns early. The tests share the database, and one of them sets the
//! global price list, so they run one at a time.

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::{Arc, LazyLock};

use serde_json::{Value, json};
use weldsuite_core_domain::credits::{GrantKind, LedgerEntry, grant_credits};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_panel::usage_mail::{Recipient, send_usage_notice};
use weldsuite_panel::usage_settlement::{
    Settled, Settlement, SettlementInput, UsageMonth, UsageNotice, quota_cache_key, settle_usage,
    usage_row,
};
use weldsuite_panel_domain::js;
use weldsuite_ports::{Cache, DynCache, MemoryCache, RecordingSystemMail};

const MONTH: &str = "2026-11";
const PRICING_KEY: &str = "weldpanel.pricing";

fn at(iso: &str) -> i64 {
    js::parse_iso(iso).expect("a time")
}

fn now() -> i64 {
    at("2026-11-14T10:00:00.000Z")
}

static SERIAL: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// The master database, held for one test at a time.
struct Db {
    master: PgPool,
    _turn: tokio::sync::MutexGuard<'static, ()>,
}

async fn db() -> Option<Db> {
    let url = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
    let turn = SERIAL.lock().await;
    Some(Db {
        master: master_pool(&url, 4).expect("master"),
        _turn: turn,
    })
}

fn kv() -> Arc<dyn DynCache> {
    Arc::new(MemoryCache::new())
}

/// The plan with `slug`, as the price list knows it (Free, Business).
async fn plan(master: &PgPool, slug: &str) -> String {
    sqlx::query(
        "insert into plans (id, name, slug) values ($1, $2, $2) on conflict (slug) do nothing",
    )
    .bind(generate_id("plan"))
    .bind(slug)
    .execute(master)
    .await
    .expect("plan");
    sqlx::query_scalar("select id from plans where slug = $1")
        .bind(slug)
        .fetch_one(master)
        .await
        .expect("plan id")
}

/// A plan of its own whose `features` override the allowances.
async fn plan_with(master: &PgPool, features: Value) -> String {
    let id = generate_id("plan");
    sqlx::query("insert into plans (id, name, slug, features) values ($1, $1, $1, $2)")
        .bind(&id)
        .bind(features)
        .execute(master)
        .await
        .expect("plan");
    id
}

/// A fresh workspace on `plan`, its wallet holding `credits`.
async fn workspace(master: &PgPool, plan: Option<&str>, credits: i64) -> String {
    let id = generate_id("ws");
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, name, slug, plan_id) values ($1, $2, $3, $1, $4)",
    )
    .bind(&id)
    .bind(format!("org_settle_{id}"))
    .bind(format!("Acme {id}"))
    .bind(plan)
    .execute(master)
    .await
    .expect("workspace");
    if credits > 0 {
        top_up(master, &id, credits).await;
    }
    id
}

async fn top_up(master: &PgPool, workspace_id: &str, credits: i64) {
    let entry = LedgerEntry {
        workspace_id,
        amount: credits,
        service_type: None,
        idempotency_key: None,
        reference_id: None,
        reference_type: None,
        description: Some("test".to_owned()),
        metadata: None,
    };
    grant_credits(master, &entry, GrantKind::Bonus, None)
        .await
        .expect("credits");
}

async fn balance(master: &PgPool, workspace_id: &str) -> i64 {
    let balance: Option<i32> =
        sqlx::query_scalar("select current_balance from workspace_credits where workspace_id = $1")
            .bind(workspace_id)
            .fetch_optional(master)
            .await
            .expect("balance");
    balance.map_or(0, i64::from)
}

/// No consumption.
const NO_CHARGES: Vec<(i32, Option<String>, Option<String>)> = Vec::new();

/// The consumptions: amount, service type, idempotency key.
async fn charges(
    master: &PgPool,
    workspace_id: &str,
) -> Vec<(i32, Option<String>, Option<String>)> {
    sqlx::query_as(
        "select amount, service_type, idempotency_key from credit_transactions
         where workspace_id = $1 and type = 'consumption' order by created_at, id",
    )
    .bind(workspace_id)
    .fetch_all(master)
    .await
    .expect("charges")
}

async fn row(master: &PgPool, workspace_id: &str, month: &str) -> UsageMonth {
    usage_row(master, workspace_id, month)
        .await
        .expect("row")
        .expect("a row")
}

/// One settlement where plans are billed.
async fn settle_at(
    master: &PgPool,
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    events: i64,
    recordings: i64,
    now: i64,
    month: &str,
) -> Option<Settled> {
    settle_usage(
        &Settlement {
            master,
            cache: Some(cache),
            now,
            bill: true,
        },
        &SettlementInput {
            workspace_id: workspace_id.to_owned(),
            month: month.to_owned(),
            events,
            recordings,
        },
    )
    .await
    .expect("settles")
}

async fn settle(
    master: &PgPool,
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    events: i64,
    recordings: i64,
) -> Option<Settled> {
    settle_at(
        master,
        cache,
        workspace_id,
        events,
        recordings,
        now(),
        MONTH,
    )
    .await
}

async fn quota_state(cache: &Arc<dyn DynCache>, workspace_id: &str) -> Option<String> {
    cache
        .get(&quota_cache_key(workspace_id))
        .await
        .expect("quota")
}

fn kinds(notices: &[UsageNotice]) -> Vec<&'static str> {
    notices.iter().map(|n| n.kind).collect()
}

/// Settles in turn, keeping the notices claimed.
async fn notices_of(
    master: &PgPool,
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    totals: &[(i64, i64)],
) -> Vec<UsageNotice> {
    let mut notices = Vec::new();
    for (events, recordings) in totals {
        if let Some(notice) = settle(master, cache, workspace_id, *events, *recordings)
            .await
            .and_then(|settled| settled.notice)
        {
            notices.push(notice);
        }
    }
    notices
}

// ── inside the allowance ────────────────────────────────────────────────

#[tokio::test]
async fn stores_the_totals_charges_nothing_and_leaves_the_collector_unblocked() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 500).await;

    let result = settle(&db.master, &cache, &ws, 50_000, 500)
        .await
        .expect("settled");

    assert_eq!(result.quota, "ok");
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (
            stored.events,
            stored.recordings,
            stored.event_blocks_charged,
            stored.recording_blocks_charged
        ),
        (50_000, 500, 0, 0)
    );
    assert_eq!(charges(&db.master, &ws).await, NO_CHARGES);
    assert_eq!(balance(&db.master, &ws).await, 500);
    assert_eq!(quota_state(&cache, &ws).await, None);
}

#[tokio::test]
async fn answers_none_and_stores_nothing_for_a_workspace_that_does_not_exist() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let nobody = generate_id("ws");
    assert!(settle(&db.master, &cache, &nobody, 10, 0).await.is_none());
    assert_eq!(
        usage_row(&db.master, &nobody, MONTH).await.expect("row"),
        None
    );
}

#[tokio::test]
async fn takes_a_workspace_without_a_plan_as_free() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let ws = workspace(&db.master, None, 100).await;
    let result = settle(&db.master, &cache, &ws, 50_001, 0)
        .await
        .expect("settled");
    assert_eq!(result.workspace.limits.events, 50_000);
    assert_eq!(row(&db.master, &ws, MONTH).await.event_blocks_charged, 1);
}

// ── overage blocks ──────────────────────────────────────────────────────

#[tokio::test]
async fn charges_the_first_block_past_the_allowance_at_the_pricing_rate() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    settle(&db.master, &cache, &ws, 50_001, 0).await;

    // 10 credits per 10,000 events.
    assert_eq!(balance(&db.master, &ws).await, 90);
    assert_eq!(
        charges(&db.master, &ws).await,
        [(
            -10,
            Some("panel_events".to_owned()),
            Some(format!("weldpanel:{ws}:{MONTH}:events:1"))
        )]
    );
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (stored.event_blocks_charged, stored.event_credits_charged),
        (1, 10)
    );
}

#[tokio::test]
async fn charges_every_block_reached_events_and_recordings_each_at_their_own_rate() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 1_000).await;
    // 3 event blocks (the 60k, 70k and 80k boundaries), 3 recording blocks.
    let result = settle(&db.master, &cache, &ws, 75_000, 701)
        .await
        .expect("settled");

    assert_eq!(result.quota, "ok");
    let mut keys: Vec<String> = charges(&db.master, &ws)
        .await
        .into_iter()
        .filter_map(|(_, _, key)| key)
        .collect();
    keys.sort();
    let mut expected: Vec<String> = (1..=3)
        .flat_map(|n| {
            [
                format!("weldpanel:{ws}:{MONTH}:events:{n}"),
                format!("weldpanel:{ws}:{MONTH}:recordings:{n}"),
            ]
        })
        .collect();
    expected.sort();
    assert_eq!(keys, expected);
    assert_eq!(balance(&db.master, &ws).await, 1_000 - 3 * 10 - 3 * 20);
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (
            stored.event_blocks_charged,
            stored.recording_blocks_charged,
            stored.event_credits_charged,
            stored.recording_credits_charged
        ),
        (3, 3, 30, 60)
    );
}

#[tokio::test]
async fn charges_a_block_once_however_often_the_same_totals_arrive_and_as_more_of_it_fills() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    for events in [50_001, 50_001, 55_000, 60_000] {
        settle(&db.master, &cache, &ws, events, 0).await;
    }

    assert_eq!(charges(&db.master, &ws).await.len(), 1);
    assert_eq!(balance(&db.master, &ws).await, 90);
}

#[tokio::test]
async fn does_not_charge_twice_when_the_row_fell_behind_the_ledger() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    settle(&db.master, &cache, &ws, 50_001, 0).await;
    // A crash between the charge and the row update.
    sqlx::query(
        "update panel_usage_monthly set event_blocks_charged = 0, event_credits_charged = 0 where workspace_id = $1",
    )
    .bind(&ws)
    .execute(&db.master)
    .await
    .expect("rewind");

    settle(&db.master, &cache, &ws, 50_001, 0).await;

    assert_eq!(charges(&db.master, &ws).await.len(), 1);
    assert_eq!(balance(&db.master, &ws).await, 90);
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (stored.event_blocks_charged, stored.event_credits_charged),
        (1, 10)
    );
}

#[tokio::test]
async fn charges_once_when_settlements_run_at_the_same_time() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    tokio::join!(
        settle(&db.master, &cache, &ws, 50_001, 0),
        settle(&db.master, &cache, &ws, 50_001, 0),
        settle(&db.master, &cache, &ws, 50_001, 0),
    );

    assert_eq!(charges(&db.master, &ws).await.len(), 1);
    assert_eq!(balance(&db.master, &ws).await, 90);
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (stored.event_blocks_charged, stored.event_credits_charged),
        (1, 10)
    );
}

#[tokio::test]
async fn keeps_the_totals_when_an_older_lower_report_arrives_later() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    settle(&db.master, &cache, &ws, 51_000, 40).await;
    settle(&db.master, &cache, &ws, 49_000, 10).await;

    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!((stored.events, stored.recordings), (51_000, 40));
}

#[tokio::test]
async fn uses_the_plans_allowance_including_a_feature_override() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let business_plan = plan(&db.master, "business").await;
    let business = workspace(&db.master, Some(&business_plan), 100).await;
    settle(&db.master, &cache, &business, 1_000_000, 0).await;
    assert_eq!(charges(&db.master, &business).await, NO_CHARGES);
    settle(&db.master, &cache, &business, 1_000_001, 0).await;
    assert_eq!(charges(&db.master, &business).await.len(), 1);

    // A plan overriding its events to 100,000.
    let overridden = plan_with(&db.master, json!({ "panelEventsPerMonth": 100_000 })).await;
    let scale = workspace(&db.master, Some(&overridden), 100).await;
    settle(&db.master, &cache, &scale, 100_000, 0).await;
    assert_eq!(charges(&db.master, &scale).await, NO_CHARGES);
    settle(&db.master, &cache, &scale, 100_001, 0).await;
    assert_eq!(charges(&db.master, &scale).await.len(), 1);
}

#[tokio::test]
async fn reads_the_price_from_the_pricing_row_and_falls_back_to_the_defaults_without_one() {
    let Some(db) = db().await else { return };
    let setting = generate_id("set");
    sqlx::query(
        "insert into system_settings (id, key, category, value) values ($1, $2, 'billing', $3)",
    )
    .bind(&setting)
    .bind(PRICING_KEY)
    .bind(json!({ "eventsCreditsPer10k": 7, "recordingsCreditsPer100": 13 }))
    .execute(&db.master)
    .await
    .expect("pricing");
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    settle(&db.master, &kv(), &ws, 50_001, 501).await;
    let priced = balance(&db.master, &ws).await;

    sqlx::query("delete from system_settings where key = $1")
        .bind(PRICING_KEY)
        .execute(&db.master)
        .await
        .expect("delete pricing");
    assert_eq!(priced, 100 - 7 - 13);
    let other = workspace(&db.master, Some(&free), 100).await;
    settle(&db.master, &kv(), &other, 50_001, 0).await;
    assert_eq!(balance(&db.master, &other).await, 90);
}

// ── when the wallet cannot pay ──────────────────────────────────────────

#[tokio::test]
async fn blocks_recordings_at_once_and_keeps_events_inside_the_grace_counted_from_the_allowance() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    // Over the allowance, exactly at the allowance plus 10%.
    let result = settle(&db.master, &cache, &ws, 55_000, 0)
        .await
        .expect("settled");

    assert_eq!(result.quota, "replay_blocked");
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("replay_blocked")
    );
    assert_eq!(charges(&db.master, &ws).await, NO_CHARGES);
    assert_eq!(row(&db.master, &ws, MONTH).await.event_blocks_charged, 0);
}

#[tokio::test]
async fn drops_events_once_they_pass_the_allowance_plus_ten_percent() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    let result = settle(&db.master, &cache, &ws, 55_001, 0)
        .await
        .expect("settled");

    assert_eq!(result.quota, "events_blocked");
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("events_blocked")
    );
}

#[tokio::test]
async fn blocks_recordings_alone_when_only_a_recording_block_is_unpaid() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    let result = settle(&db.master, &cache, &ws, 1_000, 501)
        .await
        .expect("settled");

    assert_eq!(result.quota, "replay_blocked");
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("replay_blocked")
    );
}

#[tokio::test]
async fn pays_the_blocks_it_can_and_blocks_on_the_first_it_cannot() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    // One event block (10) and not the second.
    let ws = workspace(&db.master, Some(&free), 15).await;
    // 3 blocks needed, 40% over: past the grace.
    let result = settle(&db.master, &cache, &ws, 70_001, 0)
        .await
        .expect("settled");

    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (stored.event_blocks_charged, stored.event_credits_charged),
        (1, 10)
    );
    assert_eq!(balance(&db.master, &ws).await, 5);
    assert_eq!(result.quota, "events_blocked");
}

#[tokio::test]
async fn lifts_the_block_by_itself_after_a_top_up() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    settle(&db.master, &cache, &ws, 70_001, 501).await;
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("events_blocked")
    );

    top_up(&db.master, &ws, 500).await;
    // The same totals charge the unpaid blocks and clear the state.
    let result = settle(&db.master, &cache, &ws, 70_001, 501)
        .await
        .expect("settled");

    assert_eq!(result.quota, "ok");
    assert_eq!(quota_state(&cache, &ws).await, None);
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (stored.event_blocks_charged, stored.recording_blocks_charged),
        (3, 1)
    );
    assert_eq!(balance(&db.master, &ws).await, 500 - 3 * 10 - 20);
}

#[tokio::test]
async fn starts_clean_in_a_new_month_zero_totals_settle_to_ok_and_clear_the_old_state() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    settle(&db.master, &cache, &ws, 70_001, 0).await;
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("events_blocked")
    );

    let december = at("2026-12-01T00:05:00.000Z");
    let result = settle_at(&db.master, &cache, &ws, 0, 0, december, "2026-12")
        .await
        .expect("settled");
    assert_eq!(result.quota, "ok");
    assert_eq!(quota_state(&cache, &ws).await, None);
}

#[tokio::test]
async fn charges_a_late_report_for_a_finished_month_but_leaves_the_collectors_state_alone() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    cache
        .put(&quota_cache_key(&ws), "replay_blocked", None)
        .await
        .expect("quota");
    settle_at(&db.master, &cache, &ws, 50_001, 0, now(), "2026-10").await;

    assert_eq!(charges(&db.master, &ws).await.len(), 1);
    assert_eq!(
        quota_state(&cache, &ws).await.as_deref(),
        Some("replay_blocked")
    );
}

#[tokio::test]
async fn without_billing_nothing_is_charged_the_quota_stays_ok_and_no_notice_is_claimed() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    let settled = settle_usage(
        &Settlement {
            master: &db.master,
            cache: Some(&cache),
            now: now(),
            bill: false,
        },
        &SettlementInput {
            workspace_id: ws.clone(),
            month: MONTH.to_owned(),
            events: 90_000,
            recordings: 900,
        },
    )
    .await
    .expect("settles")
    .expect("settled");

    assert_eq!(settled.quota, "ok");
    assert_eq!(settled.notice, None);
    assert_eq!(quota_state(&cache, &ws).await, None);
    assert_eq!(charges(&db.master, &ws).await, NO_CHARGES);
    let stored = row(&db.master, &ws, MONTH).await;
    assert_eq!(
        (
            stored.events,
            stored.recordings,
            stored.event_blocks_charged
        ),
        (90_000, 900, 0)
    );
    assert_eq!(stored.notified, Vec::<String>::new());
}

// ── usage emails ────────────────────────────────────────────────────────

#[tokio::test]
async fn sends_nothing_below_80_percent() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    assert_eq!(
        notices_of(&db.master, &cache, &ws, &[(39_999, 399)]).await,
        Vec::<UsageNotice>::new()
    );
}

#[tokio::test]
async fn sends_the_80_percent_notice_once_however_often_the_totals_are_settled() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let notices = notices_of(
        &db.master,
        &cache,
        &ws,
        &[(40_000, 0), (41_000, 0), (49_000, 0)],
    )
    .await;

    assert_eq!(notices.len(), 1);
    let notice = &notices[0];
    assert_eq!(
        (
            notice.workspace_id.as_str(),
            notice.kind,
            notice.month.as_str()
        ),
        (ws.as_str(), "near", MONTH)
    );
    assert_eq!(
        (notice.events, notice.recordings),
        ((40_000, 50_000), (0, 500))
    );
    assert!(notice.workspace_name.starts_with("Acme"));
    assert!(
        notice
            .clerk_org_id
            .as_deref()
            .is_some_and(|org| org.starts_with("org_settle_"))
    );
}

#[tokio::test]
async fn reaches_80_percent_through_recordings_as_well() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let notices = notices_of(&db.master, &cache, &ws, &[(10, 400)]).await;
    assert_eq!(kinds(&notices), ["near"]);
}

#[tokio::test]
async fn sends_100_percent_after_80_percent_once_each() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let notices = notices_of(
        &db.master,
        &cache,
        &ws,
        &[(41_000, 0), (50_000, 0), (50_001, 0), (50_500, 0)],
    )
    .await;
    assert_eq!(kinds(&notices), ["near", "full"]);
}

#[tokio::test]
async fn sends_one_mail_for_the_highest_threshold_crossed_at_once_and_none_for_the_lower_ones_later()
 {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let notices = notices_of(&db.master, &cache, &ws, &[(52_000, 0), (53_000, 0)]).await;
    assert_eq!(kinds(&notices), ["full"]);
}

#[tokio::test]
async fn warns_when_recordings_stop_and_again_when_events_are_dropped() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    // Over, the wallet empty, inside the grace: recordings stop; then past
    // the grace: events are dropped.
    let notices = notices_of(
        &db.master,
        &cache,
        &ws,
        &[(53_000, 0), (53_500, 0), (56_000, 0), (57_000, 0)],
    )
    .await;
    assert_eq!(kinds(&notices), ["replay_blocked", "events_blocked"]);
}

#[tokio::test]
async fn warns_about_dropped_events_at_once_when_the_wallet_is_empty_and_the_jump_is_large() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 0).await;
    let notices = notices_of(&db.master, &cache, &ws, &[(90_000, 0)]).await;
    assert_eq!(kinds(&notices), ["events_blocked"]);
}

#[tokio::test]
async fn sends_the_same_threshold_again_in_a_new_month() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let november = settle(&db.master, &cache, &ws, 41_000, 0)
        .await
        .and_then(|s| s.notice);
    let december = settle_at(
        &db.master,
        &cache,
        &ws,
        41_000,
        0,
        at("2026-12-02T00:00:00.000Z"),
        "2026-12",
    )
    .await
    .and_then(|s| s.notice);

    let sent: Vec<String> = [november, december]
        .into_iter()
        .flatten()
        .map(|n| format!("{}:{}", n.month, n.kind))
        .collect();
    assert_eq!(sent, ["2026-11:near", "2026-12:near"]);
}

#[tokio::test]
async fn sends_nothing_for_a_late_report_about_a_finished_month() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let settled = settle_at(&db.master, &cache, &ws, 45_000, 0, now(), "2026-10")
        .await
        .expect("settled");
    assert_eq!(settled.notice, None);
}

#[tokio::test]
async fn sends_one_mail_when_settlements_run_at_the_same_time() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let (a, b, c) = tokio::join!(
        settle(&db.master, &cache, &ws, 41_000, 0),
        settle(&db.master, &cache, &ws, 41_000, 0),
        settle(&db.master, &cache, &ws, 41_000, 0),
    );
    let claimed = [a, b, c]
        .into_iter()
        .flatten()
        .filter(|settled| settled.notice.is_some())
        .count();
    assert_eq!(claimed, 1);
}

#[tokio::test]
async fn keeps_the_settlement_when_the_mail_fails() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&free), 100).await;
    let result = settle(&db.master, &cache, &ws, 51_000, 0)
        .await
        .expect("settled");
    let notice = result.notice.clone().expect("a notice is due");

    let to = [Recipient {
        email: "owner@acme.test".to_owned(),
        name: None,
    }];
    let sent = send_usage_notice(&RecordingSystemMail::failing(), &to, &notice, None).await;

    assert_eq!(sent, 0);
    assert_eq!(result.quota, "ok");
    assert_eq!(row(&db.master, &ws, MONTH).await.event_blocks_charged, 1);
}

// ── the replay tier ─────────────────────────────────────────────────────

/// A workspace's live project with a record in the cache, as the registry
/// writes it (without a tier: `30d`). Answers its record's cache key.
async fn project(master: &PgPool, cache: &Arc<dyn DynCache>, ws: &str, deleted: bool) -> String {
    let project_id = generate_id("pnp");
    let token = format!("wpk_{project_id}");
    sqlx::query(
        "insert into panel_project_registry (project_id, token, workspace_id, status, settings, deleted_at)
         values ($1, $2, $3, 'active', '{}'::jsonb, case when $4 then now() end)",
    )
    .bind(&project_id)
    .bind(&token)
    .bind(ws)
    .bind(deleted)
    .execute(master)
    .await
    .expect("a registry row");
    let key = format!("panel:project:{token}");
    let record = json!({ "v": 1, "projectId": project_id, "workspaceId": ws, "status": "active", "allowedDomains": [], "settings": {} });
    cache
        .put(&key, &record.to_string(), None)
        .await
        .expect("a record");
    key
}

async fn record(cache: &Arc<dyn DynCache>, key: &str) -> Value {
    let raw = cache.get(key).await.expect("the cache").expect("a record");
    serde_json::from_str(&raw).expect("json")
}

/// Global's settlement moves the collector's records to the plan's replay
/// tier (`applyReplayTier`): `90d` written on Scale, left out otherwise;
/// deleted projects are left alone, and a late report for a finished month
/// moves nothing.
#[tokio::test]
async fn moves_the_collectors_records_to_the_plans_replay_tier_for_the_current_month() {
    let Some(db) = db().await else { return };
    let cache = kv();
    let scale = plan(&db.master, "scale").await;
    let free = plan(&db.master, "free").await;
    let ws = workspace(&db.master, Some(&scale), 100).await;
    let live = project(&db.master, &cache, &ws, false).await;
    let gone = project(&db.master, &cache, &ws, true).await;

    settle_at(&db.master, &cache, &ws, 10, 0, now(), "2026-10").await;
    assert!(record(&cache, &live).await.get("replayTier").is_none());

    settle(&db.master, &cache, &ws, 10, 0).await;
    assert_eq!(record(&cache, &live).await["replayTier"], "90d");
    assert!(record(&cache, &gone).await.get("replayTier").is_none());
    assert_eq!(
        cache
            .get(&format!("panel:tier:{ws}"))
            .await
            .expect("the cache")
            .as_deref(),
        Some("90d")
    );

    sqlx::query("update workspaces set plan_id = $2 where id = $1")
        .bind(&ws)
        .bind(&free)
        .execute(&db.master)
        .await
        .expect("a downgrade");
    settle(&db.master, &cache, &ws, 11, 0).await;
    assert!(record(&cache, &live).await.get("replayTier").is_none());
}
