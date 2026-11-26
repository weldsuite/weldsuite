//! Re-importing a store order against the real tenant schema: the items
//! keep their ids (WeldStash pick lists point at them), `fulfilled_quantity`
//! survives, a line the store dropped stays while it was fulfilled or is on
//! a pick list, items imported before line ids were kept are matched and
//! stamped, and the order gets the buyer's party as counterparty once.
//! `sync.test.ts` checks the same through the sync route, on both backends.
//! Also: which imported Moneybird documents still wait for their files.
//!
//! Needs `WELDSUITE_TEST_TENANT_URL`; skips without it. Rows carry a fresh
//! suffix, so runs share the database with other tests.

#![allow(clippy::unwrap_used, clippy::too_many_lines)]
#![allow(clippy::disallowed_methods, reason = "test fixtures")]

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_events::{EntityEventPublisher, TaskTracker};

use super::{IngestArgs, IngestResult, ingest_records};
use crate::catalog::{get_connector, syncs};

async fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return None;
    };
    Some(
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .unwrap(),
    )
}

fn suffix() -> String {
    weldsuite_kit::generate_id("t")
        .trim_start_matches("t_")
        .chars()
        .rev()
        .take(10)
        .collect()
}

fn orders_sync() -> &'static Value {
    syncs(get_connector("woocommerce").unwrap())
        .iter()
        .find(|s| s["internalEntity"] == "order")
        .unwrap()
}

async fn ingest(db: &PgPool, connection_id: &str, records: Vec<Value>) -> IngestResult {
    let events = EntityEventPublisher::new(None, TaskTracker::new());
    ingest_records(&IngestArgs {
        db,
        http: None,
        events: &events,
        connection_id,
        provider: "woocommerce",
        display_name: Some("Orders shop"),
        store_url: Some("https://orders.example"),
        sync: orders_sync(),
        records,
        owner_id: "user_ingest_test",
        workspace_id: "org_ingest_test",
        entity_id: None,
        force_deleted: false,
        moneybird_files: None,
        stripe_files: None,
        skip_financial_account_ids: &[],
    })
    .await
    .unwrap()
}

fn line(id: u64, name: &str, sku: &str, quantity: u64, price: u64) -> Value {
    json!({
        "id": id,
        "product_id": 0,
        "name": name,
        "sku": sku,
        "quantity": quantity,
        "price": price,
        "total": format!("{}.00", quantity * price),
    })
}

fn order(id: &str, modified: &str, lines: &[Value]) -> Value {
    json!({
        "id": id,
        "number": id,
        "status": "processing",
        "currency": "EUR",
        "total": "100.00",
        "customer_id": 41,
        "date_modified_gmt": modified,
        "billing": { "first_name": "Grace", "last_name": "Hopper", "email": "grace@example.com" },
        "line_items": lines,
    })
}

/// `(id, name, quantity, total, fulfilled_quantity, external_line_id)` by name.
type Item = (String, String, i32, String, Option<i32>, Option<String>);

async fn items(db: &PgPool, order_id: &str) -> Vec<Item> {
    sqlx::query_as(
        "select id, name, quantity, total::text, fulfilled_quantity, external_line_id
         from order_items where order_id = $1 order by name",
    )
    .bind(order_id)
    .fetch_all(db)
    .await
    .unwrap()
}

async fn order_row(db: &PgPool, connection_id: &str, external_id: &str) -> Value {
    sqlx::query_scalar(
        "select to_jsonb(o) from orders o join integration_entity_mappings m
           on m.internal_entity_id = o.id
         where m.connection_id = $1 and m.external_entity_type = 'woocommerce_order'
           and m.external_entity_id = $2",
    )
    .bind(connection_id)
    .bind(external_id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn person_parties(db: &PgPool, person_id: &str) -> Vec<Value> {
    sqlx::query_scalar("select to_jsonb(p) from parties p where person_id = $1")
        .bind(person_id)
        .fetch_all(db)
        .await
        .unwrap()
}

/// A connection with the buyer already imported (`woocommerce_customer` 41).
async fn seed(db: &PgPool, sfx: &str) -> (String, String) {
    let connection_id = format!("ccn_{sfx}");
    let person_id = format!("pers_{sfx}");
    sqlx::query(
        "insert into people (id, display_name, first_name, last_name, email, primary_address)
         values ($1, 'Grace Hopper', 'Grace', 'Hopper', $2, $3)",
    )
    .bind(&person_id)
    .bind(format!("grace+{sfx}@example.com"))
    .bind(json!({ "line1": "Navy Yard 1", "city": "Arlington", "country": "US" }))
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "insert into integration_entity_mappings (id, connection_id, external_entity_type,
           external_entity_id, internal_entity_type, internal_entity_id, sync_checksum, last_synced_at)
         values ($1, $2, 'woocommerce_customer', '41', 'person', $3, 'seen', now())",
    )
    .bind(format!("iem_{sfx}"))
    .bind(&connection_id)
    .bind(&person_id)
    .execute(db)
    .await
    .unwrap();
    (connection_id, person_id)
}

#[tokio::test]
async fn reimport_updates_items_in_place_and_links_the_buyer_once() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let (connection_id, person_id) = seed(&db, &sfx).await;
    let number = format!("601{sfx}");

    let first = ingest(
        &db,
        &connection_id,
        vec![order(
            &number,
            "2026-04-01T10:00:00",
            &[
                line(7001, "Kettle", "KET-1", 2, 30),
                line(7002, "Cup", "CUP-1", 4, 5),
                line(7003, "Saucer", "SAU-1", 1, 3),
            ],
        )],
    )
    .await;
    assert_eq!((first.created, first.failed), (1, 0));
    let created = order_row(&db, &connection_id, &number).await;
    let order_id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["person_id"], json!(person_id));
    assert_eq!(
        (&created["item_count"], &created["total_quantity"]),
        (&json!(3), &json!(7))
    );
    let parties = person_parties(&db, &person_id).await;
    assert_eq!(parties.len(), 1);
    assert_eq!(parties[0]["kind"], "person");
    assert_eq!(parties[0]["role"], "customer");
    assert_eq!(parties[0]["display_name"], "Grace Hopper");
    assert_eq!(parties[0]["billing_address"]["city"], "Arlington");
    assert_eq!(created["counterparty_id"], parties[0]["id"]);

    let before = items(&db, &order_id).await;
    assert_eq!(
        before
            .iter()
            .map(|i| (i.1.as_str(), i.2, i.5.clone()))
            .collect::<Vec<_>>(),
        [
            ("Cup", 4, Some("7002".to_owned())),
            ("Kettle", 2, Some("7001".to_owned())),
            ("Saucer", 1, Some("7003".to_owned())),
        ]
    );
    let (cup, kettle, saucer) = (&before[0].0, &before[1].0, &before[2].0);

    // WeldStash ships two kettles and puts the cups on a pick list; someone
    // then picks another invoice contact for the order.
    sqlx::query("update order_items set fulfilled_quantity = 2 where id = $1")
        .bind(kettle)
        .execute(&db)
        .await
        .unwrap();
    sqlx::query(
        "insert into pick_list_items (id, pick_list_id, order_id, order_item_id, product_id, sku,
           name, quantity_required)
         values ($1, $2, $3, $4, 'prd_reimport', 'CUP-1', 'Cup', 4)",
    )
    .bind(format!("pli_{sfx}"))
    .bind(format!("pl_{sfx}"))
    .bind(&order_id)
    .bind(cup)
    .execute(&db)
    .await
    .unwrap();
    let chosen = format!("party_{sfx}");
    sqlx::query(
        "insert into parties (id, kind, display_name) values ($1, 'company', 'Hopper Holdings')",
    )
    .bind(&chosen)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("update orders set counterparty_id = $1 where id = $2")
        .bind(&chosen)
        .bind(&order_id)
        .execute(&db)
        .await
        .unwrap();

    // The store raises the kettles to three, drops the cups and the saucer
    // and adds a lid.
    let second = ingest(
        &db,
        &connection_id,
        vec![order(
            &number,
            "2026-04-02T10:00:00",
            &[
                line(7001, "Kettle", "KET-1", 3, 30),
                line(7004, "Lid", "LID-1", 1, 2),
            ],
        )],
    )
    .await;
    assert_eq!((second.modified, second.failed), (1, 0));
    let after = items(&db, &order_id).await;
    assert_eq!(after.len(), 3);
    assert_eq!(
        (
            &after[0].0,
            after[0].1.as_str(),
            after[0].2,
            after[0].3.as_str(),
            after[0].4
        ),
        (cup, "Cup", 4, "20.00", Some(0))
    );
    assert_eq!(
        (
            &after[1].0,
            after[1].1.as_str(),
            after[1].2,
            after[1].3.as_str(),
            after[1].4
        ),
        (kettle, "Kettle", 3, "90.00", Some(2))
    );
    assert_eq!(after[1].5, Some("7001".to_owned()));
    assert_eq!(
        (after[2].1.as_str(), after[2].2, after[2].5.clone()),
        ("Lid", 1, Some("7004".to_owned()))
    );
    assert!(![cup, kettle, saucer].contains(&&after[2].0));

    let updated = order_row(&db, &connection_id, &number).await;
    assert_eq!(
        (&updated["item_count"], &updated["total_quantity"]),
        (&json!(3), &json!(8))
    );
    assert_eq!(updated["counterparty_id"], json!(chosen));
    assert_eq!(person_parties(&db, &person_id).await.len(), 1);
}

#[tokio::test]
async fn matches_items_imported_before_line_ids_and_stamps_them() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let (connection_id, person_id) = seed(&db, &sfx).await;
    let number = format!("602{sfx}");
    let order_id = format!("ord_{sfx}");

    // As the import left it before: no line ids on the items.
    sqlx::query(
        "insert into orders (id, order_number, external_order_id, source, status, subtotal, total,
           item_count, total_quantity)
         values ($1, $2, $2, 'woocommerce', 'processing', 0, 0, 3, 3)",
    )
    .bind(&order_id)
    .bind(&number)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query(
        "insert into integration_entity_mappings (id, connection_id, external_entity_type,
           external_entity_id, internal_entity_type, internal_entity_id, sync_checksum, last_synced_at)
         values ($1, $2, 'woocommerce_order', $3, 'order', $4, 'before-line-ids', now())",
    )
    .bind(format!("iem_o{sfx}"))
    .bind(&connection_id)
    .bind(&number)
    .bind(&order_id)
    .execute(&db)
    .await
    .unwrap();
    for (n, sku, name, price, fulfilled) in [
        (1, "MAT-1", "Mat", 10, 1),
        (2, "MAT-1", "Mat", 10, 0),
        (3, "RUG-1", "Rug", 40, 0),
    ] {
        sqlx::query(
            "insert into order_items (id, order_id, sku, name, quantity, unit_price, total,
               fulfilled_quantity, created_at)
             values ($1, $2, $3, $4, 1, $5, $5, $6, timestamp '2026-04-01 10:00:00' + make_interval(secs => $7))",
        )
        .bind(format!("oitm_{n}{sfx}"))
        .bind(&order_id)
        .bind(sku)
        .bind(name)
        .bind(price)
        .bind(fulfilled)
        .bind(f64::from(n))
        .execute(&db)
        .await
        .unwrap();
    }

    let result = ingest(
        &db,
        &connection_id,
        vec![order(
            &number,
            "2026-04-03T10:00:00",
            &[
                line(8001, "Mat", "MAT-1", 1, 10),
                line(8002, "Mat", "MAT-1", 2, 10),
                line(8003, "Rug", "RUG-1", 1, 40),
            ],
        )],
    )
    .await;
    assert_eq!((result.modified, result.failed), (1, 0));

    let stamped: Vec<(String, i32, Option<i32>, Option<String>)> = sqlx::query_as(
        "select id, quantity, fulfilled_quantity, external_line_id from order_items
         where order_id = $1 order by created_at, id",
    )
    .bind(&order_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        stamped,
        [
            (format!("oitm_1{sfx}"), 1, Some(1), Some("8001".to_owned())),
            (format!("oitm_2{sfx}"), 2, Some(0), Some("8002".to_owned())),
            (format!("oitm_3{sfx}"), 1, Some(0), Some("8003".to_owned())),
        ]
    );
    // The TypeScript import also keeps the id in `properties`.
    let props: Vec<Option<Value>> = sqlx::query_scalar(
        "select properties from order_items where order_id = $1 order by created_at, id",
    )
    .bind(&order_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        props,
        [
            Some(json!({ "externalLineId": "8001" })),
            Some(json!({ "externalLineId": "8002" })),
            Some(json!({ "externalLineId": "8003" })),
        ]
    );
    let updated = order_row(&db, &connection_id, &number).await;
    assert_eq!(
        (&updated["item_count"], &updated["total_quantity"]),
        (&json!(3), &json!(4))
    );
    let parties = person_parties(&db, &person_id).await;
    assert_eq!(parties.len(), 1);
    assert_eq!(updated["counterparty_id"], parties[0]["id"]);
}

#[tokio::test]
async fn two_stores_of_one_provider_may_share_an_order_number() {
    let Some(db) = tenant().await else { return };
    // Two WooCommerce stores that both number their orders from the same
    // start: each order imports, and keeps the store's own number.
    let (first_store, _) = seed(&db, &suffix()).await;
    let (second_store, _) = seed(&db, &suffix()).await;
    let number = format!("1001{}", suffix());
    let lines = [line(7101, "Kettle", "KET-2", 1, 30)];

    let first = ingest(
        &db,
        &first_store,
        vec![order(&number, "2026-04-01T10:00:00", &lines)],
    )
    .await;
    let second = ingest(
        &db,
        &second_store,
        vec![order(&number, "2026-04-01T10:00:00", &lines)],
    )
    .await;
    assert_eq!((first.created, first.failed), (1, 0));
    assert_eq!((second.created, second.failed), (1, 0));

    let a = order_row(&db, &first_store, &number).await;
    let b = order_row(&db, &second_store, &number).await;
    assert_ne!(a["id"], b["id"]);
    assert_eq!(
        (&a["order_number"], &b["order_number"]),
        (&json!(number), &json!(number))
    );

    // A later change to the second store's order still syncs.
    let changed = ingest(
        &db,
        &second_store,
        vec![order(
            &number,
            "2026-04-02T10:00:00",
            &[line(7101, "Kettle", "KET-2", 3, 30)],
        )],
    )
    .await;
    assert_eq!(changed.failed, 0);
    assert_eq!(
        order_row(&db, &second_store, &number).await["total_quantity"],
        json!(3)
    );
}

/// A store's orders carry the channel of their connection (ADR COM-011): made
/// on the first order (`type` = the provider, `active`, named after the store,
/// in the order's currency), reused for the next, never with keys or rates.
#[tokio::test]
async fn imported_orders_carry_the_connections_channel() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let (connection_id, _) = seed(&db, &sfx).await;
    let (first, second) = (format!("701{sfx}"), format!("702{sfx}"));

    ingest(
        &db,
        &connection_id,
        vec![order(
            &first,
            "2026-04-01T10:00:00",
            &[line(8001, "Kettle", "KET-9", 1, 30)],
        )],
    )
    .await;
    let created = order_row(&db, &connection_id, &first).await;
    let channel_id = created["channel_id"].as_str().expect("channel").to_owned();
    let channel: Value =
        sqlx::query_scalar("select to_jsonb(c) from commerce_channels c where id = $1")
            .bind(&channel_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(channel["type"], "woocommerce");
    assert_eq!(channel["connection_id"], json!(connection_id));
    assert_eq!(channel["status"], "active");
    assert_eq!(channel["name"], "Orders shop");
    assert_eq!(channel["currency"], "EUR");
    assert_eq!(channel["deleted_at"], json!(null));
    let (keys, rates): (i64, i64) = sqlx::query_as(
        "select (select count(*) from commerce_channel_keys where channel_id = $1),
                (select count(*) from commerce_shipping_rates where channel_id = $1)",
    )
    .bind(&channel_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!((keys, rates), (0, 0));

    // The next order, and a re-import of the first, use the same channel.
    ingest(
        &db,
        &connection_id,
        vec![
            order(
                &second,
                "2026-04-02T10:00:00",
                &[line(8002, "Cup", "CUP-9", 1, 5)],
            ),
            order(
                &first,
                "2026-04-03T10:00:00",
                &[line(8001, "Kettle", "KET-9", 2, 30)],
            ),
        ],
    )
    .await;
    assert_eq!(
        order_row(&db, &connection_id, &second).await["channel_id"],
        json!(channel_id)
    );
    assert_eq!(
        order_row(&db, &connection_id, &first).await["channel_id"],
        json!(channel_id)
    );
    let channels: i64 = sqlx::query_scalar(
        "select count(*) from commerce_channels where connection_id = $1 and deleted_at is null",
    )
    .bind(&connection_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(channels, 1);
}

/// A Moneybird bill of `connection_id` whose files were fetched (`keys`) or
/// never were (`None`).
async fn moneybird_bill(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    sfx: &str,
    keys: Option<Value>,
) {
    let bill_id = format!("bil_{sfx}");
    sqlx::query(
        "insert into bills (id, entity_id, contact_id, issue_date, due_date, attachment_keys)
         values ($1, 'ent_backlog', 'party_backlog', now(), now(), $2)",
    )
    .bind(&bill_id)
    .bind(keys)
    .execute(db)
    .await
    .unwrap();
    sqlx::query(
        "insert into integration_entity_mappings (id, connection_id, external_entity_type,
           external_entity_id, internal_entity_type, internal_entity_id, sync_checksum, last_synced_at)
         values ($1, $2, $3, $4, 'bill', $5, 'seen', now())",
    )
    .bind(format!("iem_{sfx}"))
    .bind(connection_id)
    .bind(external_type)
    .bind(format!("mb_{sfx}"))
    .bind(&bill_id)
    .execute(db)
    .await
    .unwrap();
}

#[tokio::test]
async fn moneybird_documents_without_fetched_files_are_a_backlog() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let connection_id = format!("ccn_mb_{sfx}");
    let backlog = |external_type: Option<&'static str>| {
        let db = db.clone();
        let connection_id = connection_id.clone();
        async move {
            super::moneybird_attachment_backlog(&db, &connection_id, external_type)
                .await
                .unwrap()
        }
    };
    assert!(!backlog(None).await);
    // Fetched, with or without files: no backlog.
    moneybird_bill(
        &db,
        &connection_id,
        "moneybird_purchase_invoice",
        &format!("{sfx}a"),
        Some(json!(["k/attachments/1/a.pdf"])),
    )
    .await;
    moneybird_bill(
        &db,
        &connection_id,
        "moneybird_receipt",
        &format!("{sfx}b"),
        Some(json!([])),
    )
    .await;
    assert!(!backlog(None).await);
    // A receipt the budget left: a backlog for receipts, not for purchase
    // invoices; another connection's doesn't count.
    moneybird_bill(
        &db,
        &connection_id,
        "moneybird_receipt",
        &format!("{sfx}c"),
        None,
    )
    .await;
    moneybird_bill(
        &db,
        &format!("{connection_id}x"),
        "moneybird_purchase_invoice",
        &format!("{sfx}d"),
        None,
    )
    .await;
    assert!(backlog(None).await);
    assert!(backlog(Some("moneybird_receipt")).await);
    assert!(!backlog(Some("moneybird_purchase_invoice")).await);
    assert!(!backlog(Some("moneybird_sales_invoice")).await);
    assert!(!backlog(Some("moneybird_contact")).await);
}

// ── bank accounts get a ledger account ──────────────────────────────────────

fn bank_account_sync(provider: &str) -> &'static Value {
    syncs(get_connector(provider).unwrap())
        .iter()
        .find(|s| s["internalEntity"] == "bank_account")
        .unwrap()
}

async fn ingest_bank_accounts(
    db: &PgPool,
    provider: &str,
    connection_id: &str,
    entity_id: &str,
    records: Vec<Value>,
) -> IngestResult {
    let events = EntityEventPublisher::new(None, TaskTracker::new());
    ingest_records(&IngestArgs {
        db,
        http: None,
        events: &events,
        connection_id,
        provider,
        display_name: Some("Books"),
        store_url: None,
        sync: bank_account_sync(provider),
        records,
        owner_id: "user_ingest_test",
        workspace_id: "org_ingest_test",
        entity_id: Some(entity_id),
        force_deleted: false,
        moneybird_files: None,
        stripe_files: None,
        skip_financial_account_ids: &[],
    })
    .await
    .unwrap()
}

/// An NL book: the template's cash, bank and savings accounts.
async fn nl_book(db: &PgPool, entity_id: &str) {
    sqlx::query(
        "insert into entities (id, name, jurisdiction_code, base_currency)
         values ($1, 'Import BV', 'NL', 'EUR')",
    )
    .bind(entity_id)
    .execute(db)
    .await
    .unwrap();
    for (code, name, subtype) in [
        ("1001", "Kas", "cash"),
        ("1100", "Bank", "bank"),
        ("1200", "Spaarrekening", "bank"),
    ] {
        sqlx::query(
            "insert into accounts (id, entity_id, code, name, type, subtype, normal_side)
             values ($1, $2, $3, $4, 'asset', $5, 'debit')",
        )
        .bind(format!("{entity_id}_{code}"))
        .bind(entity_id)
        .bind(code)
        .bind(name)
        .bind(subtype)
        .execute(db)
        .await
        .unwrap();
    }
}

/// `(bank account id, its ledger account as JSON)` of an imported account.
async fn bank_ledger(
    db: &PgPool,
    connection_id: &str,
    external_id: &str,
) -> (String, Option<Value>) {
    sqlx::query_as(
        "select b.id, to_jsonb(a) from bank_accounts b
           join integration_entity_mappings m on m.internal_entity_id = b.id
           left join accounts a on a.id = b.ledger_account_id
         where m.connection_id = $1 and m.external_entity_id = $2",
    )
    .bind(connection_id)
    .bind(external_id)
    .fetch_one(db)
    .await
    .unwrap()
}

async fn set_ledger(db: &PgPool, bank_account_id: &str, ledger: Option<&str>) {
    sqlx::query("update bank_accounts set ledger_account_id = $2 where id = $1")
        .bind(bank_account_id)
        .bind(ledger)
        .execute(db)
        .await
        .unwrap();
}

#[tokio::test]
async fn imported_moneybird_bank_accounts_get_a_ledger_account() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let connection_id = format!("ccn_mbba_{sfx}");
    let entity_id = format!("ent_mbba_{sfx}");
    nl_book(&db, &entity_id).await;
    let online = json!({
        "id": format!("{sfx}1"), "type": "BankAccount", "name": "Online Betaalmethoden rekening",
        "identifier": "NL91ADYB2006011082", "currency": "EUR", "moneybird_account": true, "active": true,
    });
    let revolut = json!({
        "id": format!("{sfx}2"), "type": "BankAccount", "name": "Revolut",
        "identifier": "NL91 ABNA 0417 1643 00", "currency": "EUR", "moneybird_account": false, "active": true,
    });
    let director = json!({
        "id": format!("{sfx}3"), "type": "PrivateWithdrawalAccount", "name": "Rekening courant directie",
        "identifier": "G. Director", "currency": "EUR", "moneybird_account": false, "active": true,
    });
    let first = ingest_bank_accounts(
        &db,
        "moneybird",
        &connection_id,
        &entity_id,
        vec![online.clone(), revolut.clone(), director.clone()],
    )
    .await;
    assert_eq!(first.created, 3, "{:?}", first.error_samples);

    // Moneybird's own account gets one of its own, even while 1100 is free.
    let (online_id, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}1")).await;
    let ledger = ledger.expect("Moneybird's own account is linked");
    assert_eq!(ledger["code"], json!("1201"));
    assert_eq!(ledger["name"], json!("Online Betaalmethoden rekening"));
    assert_eq!(ledger["type"], json!("asset"));
    assert_eq!(ledger["subtype"], json!("bank"));
    assert_eq!(ledger["entity_id"], json!(entity_id));
    assert_eq!(ledger["currency"], json!("EUR"));
    // The bank account takes the template's 1100 Bank.
    let (revolut_id, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}2")).await;
    assert_eq!(
        ledger.expect("the bank account is linked")["code"],
        json!("1100")
    );
    // The current account with the director is left for a person.
    let (_, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}3")).await;
    assert!(ledger.is_none(), "{ledger:?}");

    // A person's choice stands when the record changes; an account imported
    // before accounts were linked gets one on the next sync, unchanged or not.
    let savings = format!("{entity_id}_1200");
    set_ledger(&db, &online_id, Some(&savings)).await;
    set_ledger(&db, &revolut_id, None).await;
    let mut renamed = online.clone();
    renamed["name"] = json!("Online betaalmethoden");
    let second = ingest_bank_accounts(
        &db,
        "moneybird",
        &connection_id,
        &entity_id,
        vec![renamed, revolut, director],
    )
    .await;
    assert_eq!((second.modified, second.skipped), (1, 2));
    let (_, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}1")).await;
    assert_eq!(ledger.unwrap()["id"], json!(savings));
    let (_, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}2")).await;
    assert_eq!(ledger.unwrap()["code"], json!("1100"));
    let (_, ledger) = bank_ledger(&db, &connection_id, &format!("{sfx}3")).await;
    assert!(ledger.is_none(), "{ledger:?}");
}

#[tokio::test]
async fn a_stripe_balance_gets_a_ledger_account_of_its_own() {
    let Some(db) = tenant().await else { return };
    let sfx = suffix();
    let connection_id = format!("ccn_stba_{sfx}");
    let entity_id = format!("ent_stba_{sfx}");
    nl_book(&db, &entity_id).await;
    let result = ingest_bank_accounts(
        &db,
        "stripe",
        &connection_id,
        &entity_id,
        vec![json!({ "id": format!("bal_{sfx}"), "currency": "eur", "available": 1000, "pending": 0 })],
    )
    .await;
    assert_eq!(result.created, 1, "{:?}", result.error_samples);
    let (_, ledger) = bank_ledger(&db, &connection_id, &format!("bal_{sfx}")).await;
    let ledger = ledger.expect("the Stripe balance is linked");
    assert_eq!(ledger["code"], json!("1201"));
    assert_eq!(ledger["name"], json!("Stripe balance (EUR)"));
}
