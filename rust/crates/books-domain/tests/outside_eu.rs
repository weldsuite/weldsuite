//! Bank feeds on the EU edition (ADR OPS-026): Plaid is outside the EU, so
//! with the switches enforced a workspace that hasn't switched it on is
//! never called for. A new link is refused with the typed error, a sync (the
//! sweeps' and webhooks' path) is skipped without a single call to Plaid,
//! and once the workspace switches Plaid on the same sync reaches it. A
//! disconnect revokes the item at Plaid whatever the switch: revoking is
//! what stops the data leaving the EU.
//!
//! Its own test binary: it installs the process-wide enforcement, which no
//! other test of the crate expects. Runs on the real tenant schema when
//! `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early. Only the
//! `plaid` switch is touched (other test binaries share the database).

#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

use std::sync::{Arc, Mutex};

use serde_json::json;
use weldsuite_books_domain::bank_feeds::connections::{
    LinkSessionArgs, create_link_session, disconnect,
};
use weldsuite_books_domain::bank_feeds::sync::sync_connection;
use weldsuite_books_domain::bank_feeds::{FeedConfig, FeedContext, ServiceError};
use weldsuite_db::{Keyring, master_pool};
use weldsuite_kit::generate_id;
use weldsuite_outside_eu::store::{Change, SettingsSnapshot, Via, set};
use weldsuite_outside_eu::{Enforcement, OutsideEuError, ServiceId};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

/// Plaid's sandbox as a sync reads it; every call is kept.
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
                    "added": [], "modified": [], "removed": [],
                    "next_cursor": "cur-oeu", "has_more": false,
                }),
                "/item/remove" => json!({ "request_id": "req_oeu" }),
                "/accounts/get" => json!({
                    "item": { "item_id": "item_oeu" },
                    "accounts": [{ "account_id": "chk", "type": "depository", "balances": { "current": 10, "iso_currency_code": "USD" } }],
                }),
                _ => json!({ "error_code": "NOT_FOUND" }),
            };
            Ok(HttpResponse::new(200, body.to_string().into_bytes()))
        })
    }
}

fn switch(enabled: bool) -> Change<'static> {
    Change {
        service: ServiceId::Plaid,
        enabled,
        actor: "user_oeu_test",
        via: Via::Admin,
        acknowledged: enabled,
        reason: None,
        at: "2026-11-20T10:00:00.000Z",
    }
}

/// CI runs every crate's database tests on one database: `workspace_settings`
/// goes back as it was after the test, even when it panics, so no other
/// crate's test (billing reads the oldest settings row) sees its row.
#[tokio::test]
async fn plaid_is_called_only_once_the_workspace_switched_it_on() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let snapshot = SettingsSnapshot::take(&db).await.expect("snapshot");
    let outcome = tokio::spawn(plaid_follows_the_switch(db.clone())).await;
    snapshot.restore(&db).await.expect("restore");
    if let Err(error) = outcome {
        std::panic::resume_unwind(error.into_panic());
    }
}

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn plaid_follows_the_switch(db: weldsuite_db::PgPool) {
    Enforcement::Enforced.install();
    assert!(weldsuite_outside_eu::enforced());
    set(&db, &switch(false)).await.expect("plaid off");

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
        clerk_org_id: "org_oeu".to_owned(),
        auto_reconcile: false,
    };

    let entity = generate_id("ent");
    sqlx::query("insert into entities (id, name, jurisdiction_code, base_currency) values ($1, 'Outside EU Inc', 'US', 'USD')")
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
    let credentials = ctx
        .seal(&json!({ "accessToken": "access-oeu" }))
        .expect("sealed");
    sqlx::query(
        "insert into bank_connections (id, entity_id, provider, provider_connection_id, status, credentials_encrypted, metadata) \
         values ($1, $2, 'plaid', $3, 'active', $4, $5)",
    )
    .bind(&connection)
    .bind(&entity)
    .bind(generate_id("item"))
    .bind(&credentials)
    .bind(json!({ "feedAccounts": [
        { "providerAccountId": "chk", "name": "Checking", "type": "depository", "currency": "USD", "fingerprint": "oeu1", "status": "active" },
    ] }))
    .execute(&db)
    .await
    .expect("connection");
    sqlx::query(
        "insert into bank_accounts (id, entity_id, name, currency, ledger_account_id, feed_connection_id, feed_provider, \
         feed_account_id, feed_status) values ($1, $2, 'Operating', 'USD', $3, $4, 'plaid', 'chk', 'active')",
    )
    .bind(generate_id("ba"))
    .bind(&entity)
    .bind(&ledger)
    .bind(&connection)
    .execute(&db)
    .await
    .expect("bank account");

    // Off: a new link is refused with the typed error, before any call.
    let refused = create_link_session(
        &ctx,
        LinkSessionArgs {
            provider_id: "plaid".to_owned(),
            mode: "create".to_owned(),
            connection_id: None,
            workspace_id: "ws_oeu".to_owned(),
            redirect_url: "https://app.example.test/books/banking".to_owned(),
            institution: None,
            psu_type: None,
        },
    )
    .await
    .expect_err("plaid is off");
    let ServiceError::OutsideEu(OutsideEuError::Off(service)) = refused else {
        panic!("expected the outside-EU refusal, got {refused:?}");
    };
    assert_eq!(service, ServiceId::Plaid);
    let api = OutsideEuError::Off(service).to_api_error();
    assert_eq!(api.status(), http::StatusCode::FORBIDDEN);
    assert_eq!(api.code(), weldsuite_outside_eu::OFF_CODE);

    // Off: the sync the sweeps and webhooks run is skipped, Plaid untouched.
    let skipped = sync_connection(&ctx, &connection, false)
        .await
        .expect("sync");
    assert_eq!(skipped.skipped, Some("outside_eu"));
    assert!(plaid.calls.lock().expect("calls").is_empty());

    // On: the same sync reaches Plaid.
    let (_, on) = set(&db, &switch(true)).await.expect("plaid on");
    assert!(on.enabled);
    let synced = sync_connection(&ctx, &connection, false)
        .await
        .expect("sync");
    assert_eq!(synced.skipped, None, "{:?}", synced.error);
    assert!(!plaid.calls.lock().expect("calls").is_empty());

    // Off again: the calls stop.
    set(&db, &switch(false)).await.expect("plaid off");
    plaid.calls.lock().expect("calls").clear();
    let stopped = sync_connection(&ctx, &connection, false)
        .await
        .expect("sync");
    assert_eq!(stopped.skipped, Some("outside_eu"));
    assert!(plaid.calls.lock().expect("calls").is_empty());

    // Off, a disconnect still revokes the item at Plaid: revoking is what
    // stops the bank data leaving the EU, and the credentials go after it.
    disconnect(&ctx, &connection, None)
        .await
        .expect("disconnect while off");
    assert_eq!(
        *plaid.calls.lock().expect("calls"),
        vec!["/item/remove".to_owned()]
    );
}
