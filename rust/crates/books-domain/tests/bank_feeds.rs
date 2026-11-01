//! `bank_feeds` on the real tenant schema (built from the journaled
//! migrations by `scripts/rust-test-db.ts`), through the calls the
//! integration workers make on Global (`/internal/bank-connections/events`
//! and `/:connectionId/sync`), which the conformance suite cannot reach:
//! provider events rolling up into the connection's status (scoped to some
//! accounts, soft statuses never hiding a harder one, stale events ignored),
//! a `sync_available` event running a sync against Plaid (answered by a fake
//! outbound client), the sync lock, and a deleted connection.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use weldsuite_books_domain::bank_feeds::events::{FeedEvent, apply_events, apply_feed_event};
use weldsuite_books_domain::bank_feeds::sync::sync_connection;
use weldsuite_books_domain::bank_feeds::{FeedConfig, FeedContext};
use weldsuite_db::{Keyring, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

/// Plaid's sandbox, as far as a sync reads it; every call is kept.
#[derive(Default)]
struct FakePlaid {
    calls: Mutex<Vec<String>>,
}

impl DynOutboundHttp for FakePlaid {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        Box::pin(async move {
            let path = request
                .url
                .trim_start_matches("https://sandbox.plaid.com")
                .to_owned();
            self.calls.lock().expect("calls").push(path.clone());
            let body = match path.as_str() {
                "/transactions/sync" => json!({
                    "added": [{
                        "transaction_id": "tx_rent", "account_id": "chk", "amount": 1200,
                        "date": "2026-10-01", "name": "Rent October", "iso_currency_code": "USD",
                    }],
                    "modified": [], "removed": [], "next_cursor": "cur-1", "has_more": false,
                }),
                "/accounts/get" => json!({
                    "item": { "item_id": "item_feeds" },
                    "accounts": [{ "account_id": "chk", "type": "depository", "balances": { "current": 800, "iso_currency_code": "USD" } }],
                }),
                _ => json!({ "error_code": "NOT_FOUND" }),
            };
            Ok(HttpResponse {
                status: 200,
                body: body.to_string().into_bytes(),
            })
        })
    }
}

fn event(kind: &str, accounts: Option<&[&str]>) -> FeedEvent {
    FeedEvent {
        kind: kind.to_owned(),
        provider_connection_id: "item_feeds".to_owned(),
        account_ids: accounts.map(|ids| ids.iter().map(|id| (*id).to_owned()).collect()),
        expires_at: None,
        message: None,
    }
}

async fn status_of(db: &sqlx::PgPool, id: &str) -> (String, Value, Option<String>) {
    sqlx::query_as("select status, metadata, last_error from bank_connections where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .expect("connection")
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn bank_feeds_on_the_real_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let plaid = Arc::new(FakePlaid::default());
    let config = FeedConfig::from_env(|name| match name {
        "PLAID_CLIENT_ID" => Some("cid".to_owned()),
        "PLAID_SECRET" => Some("secret".to_owned()),
        _ => None,
    });
    let ctx = FeedContext {
        db: db.clone(),
        keyring: Keyring {
            v1: Some(format!("{}1", "0".repeat(63))),
            v2: None,
        },
        master: None,
        config,
        http: Some(OutboundHttp(Arc::clone(&plaid) as Arc<dyn DynOutboundHttp>)),
        ponto_http: None,
        clerk_org_id: "org_feeds".to_owned(),
        auto_reconcile: true,
    };

    let entity = generate_id("ent");
    sqlx::query("insert into entities (id, name, jurisdiction_code, base_currency) values ($1, 'Feeds Inc', 'US', 'USD')")
        .bind(&entity)
        .execute(&db)
        .await
        .expect("entity");
    let ledger = generate_id("acc");
    sqlx::query(
        "insert into accounts (id, entity_id, code, name, type, subtype, normal_side) \
         values ($1, $2, '1000', 'Checking', 'asset', 'bank', 'debit')",
    )
    .bind(&ledger)
    .bind(&entity)
    .execute(&db)
    .await
    .expect("ledger account");
    let connection = generate_id("bkc");
    let provider_connection = generate_id("item");
    let credentials = ctx
        .seal(&json!({ "accessToken": "access-feeds" }))
        .expect("sealed");
    let feed_accounts = json!([
        { "providerAccountId": "chk", "name": "Checking", "type": "depository", "currency": "USD", "fingerprint": "f1", "status": "active" },
        { "providerAccountId": "sav", "name": "Saving", "type": "depository", "currency": "USD", "fingerprint": "f2", "status": "active" },
    ]);
    sqlx::query(
        "insert into bank_connections (id, entity_id, provider, provider_connection_id, status, credentials_encrypted, metadata) \
         values ($1, $2, 'plaid', $3, 'active', $4, $5)",
    )
    .bind(&connection)
    .bind(&entity)
    .bind(&provider_connection)
    .bind(&credentials)
    .bind(json!({ "feedAccounts": feed_accounts }))
    .execute(&db)
    .await
    .expect("connection");
    let bank = generate_id("ba");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency, ledger_account_id, feed_connection_id, feed_provider, \
         feed_account_id, feed_status) values ($1, $2, 'Operating', 'USD', $3, $4, 'plaid', 'chk', 'active')",
    )
    .bind(&bank)
    .bind(&entity)
    .bind(&ledger)
    .bind(&connection)
    .execute(&db)
    .await
    .expect("bank account");

    // `sync_available` only says a sync is worth running.
    let available = apply_feed_event(&ctx, &connection, &event("sync_available", None))
        .await
        .expect("event");
    assert!(available.needs_sync && !available.changed && !available.missing);

    // An unmapped account expiring: the account changes, the connection (rolled
    // up over the mapped accounts) stays active.
    let expiring = apply_feed_event(&ctx, &connection, &event("expiring", Some(&["sav"])))
        .await
        .expect("event");
    assert_eq!(expiring.status, "active");
    assert!(expiring.changed);
    let (status, metadata, _) = status_of(&db, &connection).await;
    assert_eq!(status, "active");
    assert_eq!(metadata["feedAccounts"][1]["status"], "expiring");

    // Events for accounts a relink replaced are stale.
    let stale = apply_feed_event(&ctx, &connection, &event("revoked", Some(&["gone"])))
        .await
        .expect("event");
    assert!(!stale.changed);
    assert_eq!(stale.status, "active");

    // The bank wants a new sign-in: every account, the bank account too.
    let reauth = apply_feed_event(&ctx, &connection, &event("reauth_required", None))
        .await
        .expect("event");
    assert_eq!(reauth.status, "reauth_required");
    let (status, _, last_error) = status_of(&db, &connection).await;
    assert_eq!(status, "reauth_required");
    assert_eq!(
        last_error.as_deref(),
        Some("The bank needs you to sign in again.")
    );
    let feed_status: Option<String> =
        sqlx::query_scalar("select feed_status from bank_accounts where id = $1")
            .bind(&bank)
            .fetch_one(&db)
            .await
            .expect("bank account");
    assert_eq!(feed_status.as_deref(), Some("reauth_required"));

    // "Error" never hides the harder state the account is in.
    let soft = apply_feed_event(&ctx, &connection, &event("error", None))
        .await
        .expect("event");
    assert_eq!(soft.status, "reauth_required");
    assert!(!soft.changed);

    // A held lock: the sync is skipped, nothing is asked of Plaid.
    sqlx::query(
        "update bank_connections set metadata = metadata || jsonb_build_object('syncLockUntil', (now() + interval '1 minute')::text) \
         where id = $1",
    )
    .bind(&connection)
    .execute(&db)
    .await
    .expect("lock");
    let locked = sync_connection(&ctx, &connection, false)
        .await
        .expect("sync");
    assert_eq!(locked.skipped, Some("in_progress"));
    assert!(plaid.calls.lock().expect("calls").is_empty());
    sqlx::query("update bank_connections set metadata = metadata - 'syncLockUntil' where id = $1")
        .bind(&connection)
        .execute(&db)
        .await
        .expect("unlock");

    // New data waiting: the delivery syncs, and a clean read clears the sign-in problem.
    let delivered = apply_events(&ctx, &connection, &[event("sync_available", None)])
        .await
        .expect("events");
    let outcome = delivered.outcome.as_ref().expect("synced");
    assert_eq!(delivered.applied, 1);
    assert_eq!(outcome.status, "active");
    assert_eq!((outcome.added, outcome.pending), (1, 0));
    assert_eq!(delivered.to_json()["synced"], true);
    assert_eq!(
        *plaid.calls.lock().expect("calls"),
        vec!["/transactions/sync".to_owned(), "/accounts/get".to_owned()]
    );
    let (status, metadata, _) = status_of(&db, &connection).await;
    assert_eq!(status, "active");
    assert!(metadata.get("syncLockUntil").is_none());
    assert_eq!(metadata["lastSync"]["added"], 1);
    let line: (String, String, String) = sqlx::query_as(
        "select amount::text, source, status from bank_transactions where bank_account_id = $1 and provider_transaction_id = 'tx_rent'",
    )
    .bind(&bank)
    .fetch_one(&db)
    .await
    .expect("feed line");
    assert_eq!(
        line,
        (
            "-1200.00".to_owned(),
            "feed".to_owned(),
            "unreconciled".to_owned()
        )
    );
    let balance: String =
        sqlx::query_scalar("select current_balance::text from bank_accounts where id = $1")
            .bind(&bank)
            .fetch_one(&db)
            .await
            .expect("balance");
    assert_eq!(balance, "800.00");

    // The same page again adds nothing: rows are unique per provider id.
    sqlx::query("update bank_connections set sync_cursor = null where id = $1")
        .bind(&connection)
        .execute(&db)
        .await
        .expect("cursor");
    let again = sync_connection(&ctx, &connection, false)
        .await
        .expect("sync");
    assert_eq!((again.added, again.updated), (0, 0));

    // A deleted connection: the delivery is answered as missing.
    let missing = apply_events(&ctx, "bkc_gone", &[event("revoked", None)])
        .await
        .expect("events");
    assert!(missing.missing);
    assert_eq!(
        missing.to_json(),
        json!({ "applied": 0, "synced": false, "missing": true })
    );
    let skipped = sync_connection(&ctx, "bkc_gone", false)
        .await
        .expect("sync");
    assert_eq!(skipped.skipped, Some("not_found"));
}
