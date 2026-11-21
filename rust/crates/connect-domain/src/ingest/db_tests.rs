//! Re-importing a store order against the real tenant schema: the items
//! keep their ids (WeldStash pick lists point at them), `fulfilled_quantity`
//! survives, a line the store dropped stays while it was fulfilled or is on
//! a pick list, items imported before line ids were kept are matched and
//! stamped, and the order gets the buyer's party as counterparty once.
//! `sync.test.ts` checks the same through the sync route, on both backends.
//!
//! Needs `WELDSUITE_TEST_TENANT_URL`; skips without it. Rows carry a fresh
//! suffix, so runs share the database with other tests.

#![allow(clippy::unwrap_used, clippy::too_many_lines)]

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

/// `(id, name, quantity, total, fulfilled_quantity, properties)` by name.
type Item = (String, String, i32, String, Option<i32>, Option<Value>);

async fn items(db: &PgPool, order_id: &str) -> Vec<Item> {
    sqlx::query_as(
        "select id, name, quantity, total::text, fulfilled_quantity, properties
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
            ("Cup", 4, Some(json!({ "externalLineId": "7002" }))),
            ("Kettle", 2, Some(json!({ "externalLineId": "7001" }))),
            ("Saucer", 1, Some(json!({ "externalLineId": "7003" }))),
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
    assert_eq!(after[1].5, Some(json!({ "externalLineId": "7001" })));
    assert_eq!(
        (after[2].1.as_str(), after[2].2, after[2].5.clone()),
        ("Lid", 1, Some(json!({ "externalLineId": "7004" })))
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

    let stamped: Vec<(String, i32, Option<i32>, Option<Value>)> = sqlx::query_as(
        "select id, quantity, fulfilled_quantity, properties from order_items
         where order_id = $1 order by created_at, id",
    )
    .bind(&order_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        stamped,
        [
            (
                format!("oitm_1{sfx}"),
                1,
                Some(1),
                Some(json!({ "externalLineId": "8001" }))
            ),
            (
                format!("oitm_2{sfx}"),
                2,
                Some(0),
                Some(json!({ "externalLineId": "8002" }))
            ),
            (
                format!("oitm_3{sfx}"),
                1,
                Some(0),
                Some(json!({ "externalLineId": "8003" }))
            ),
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
