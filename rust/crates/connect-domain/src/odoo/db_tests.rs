//! The Odoo syncs against the real tenant schema, over the fake Odoo:
//! what lands in each table, the managed warehouse, the stock refresh and
//! roll-ups, the purchase order status, sales demand, and what an
//! incremental pass changes (zeroed stock, a cancelled line removed, a
//! deleted vendor line released).
//!
//! Needs `WELDSUITE_TEST_TENANT_URL`; skips without it. Rows carry a fresh
//! suffix, so runs share the database with other tests.

#![allow(
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::many_single_char_names,
    clippy::type_complexity
)]

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_db::Keyring;
use weldsuite_events::{EntityEventPublisher, TaskTracker};

use super::fake::FakeOdoo;
use crate::sync::{SyncArgs, SyncEnv, Trigger, sync_connection};

async fn tenant() -> Option<PgPool> {
    let url = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
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

async fn connection(db: &PgPool, id: &str, settings: &Value) -> Value {
    // One live connection per provider and account: a host per test.
    let url = format!("https://{}.odoo.com", id.replace('_', "-"));
    sqlx::query(
        "insert into connector_connections (id, provider, display_name, status, credentials,
           external_account_id, enabled_syncs, settings, connected_at)
         values ($1, 'odoo', 'Odoo test', 'active', $2, $5, $3, $4, now())",
    )
    .bind(id)
    .bind(json!({ "url": url, "database": "acme", "login": "api@acme.test", "apiKey": "secret" }))
    .bind(json!([
        "warehouses",
        "products",
        "suppliers",
        "productSuppliers",
        "inventory",
        "purchaseOrders",
        "sales"
    ]))
    .bind(settings)
    .bind(&url)
    .execute(db)
    .await
    .unwrap();
    reload(db, id).await
}

async fn reload(db: &PgPool, id: &str) -> Value {
    sqlx::query_scalar("select to_jsonb(c) from connector_connections c where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

fn env(fake: &Arc<FakeOdoo>) -> SyncEnv {
    SyncEnv {
        keyring: Keyring::default(),
        stripe_secret_key: None,
        storage: None,
        http: Some(fake.http()),
        events: EntityEventPublisher::new(None, TaskTracker::new()),
        due: None,
    }
}

async fn sync(
    db: &PgPool,
    env: &SyncEnv,
    connection: &Value,
    syncs: Option<Vec<String>>,
) -> Vec<String> {
    sync_connection(&SyncArgs {
        db,
        env,
        connection,
        owner_id: "user_odoo_test",
        workspace_id: "org_odoo_test",
        trigger: Trigger::Manual,
        full: false,
        syncs,
    })
    .await
    .unwrap()
}

/// [`sync`] as a full sync (`full`: every record read again, from the start).
async fn full_sync(db: &PgPool, env: &SyncEnv, connection: &Value, syncs: Vec<String>) {
    sync_connection(&SyncArgs {
        db,
        env,
        connection,
        owner_id: "user_odoo_test",
        workspace_id: "org_odoo_test",
        trigger: Trigger::Manual,
        full: true,
        syncs: Some(syncs),
    })
    .await
    .unwrap();
}

async fn mapping(db: &PgPool, connection: &str, kind: &str, odoo_id: i64) -> Option<String> {
    sqlx::query_scalar(
        "select internal_entity_id from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3",
    )
    .bind(connection)
    .bind(kind)
    .bind(odoo_id.to_string())
    .fetch_optional(db)
    .await
    .unwrap()
}

async fn mapped(db: &PgPool, connection: &str, kind: &str, odoo_id: i64) -> String {
    sqlx::query_scalar(
        "select internal_entity_id from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3",
    )
    .bind(connection)
    .bind(kind)
    .bind(odoo_id.to_string())
    .fetch_one(db)
    .await
    .unwrap()
}

async fn row(db: &PgPool, sql: &'static str, id: &str) -> Value {
    sqlx::query_scalar(sql)
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

fn seed(fake: &FakeOdoo, s: &str) {
    let at = "2026-11-01 10:00:00";
    fake.add("stock.warehouse", vec![json!({
        "id": 1, "name": format!("San Francisco {s}"), "code": "WH", "active": true,
        "lot_stock_id": [8, "WH/Stock"], "in_type_id": [1, "San Francisco: Receipts"], "write_date": at,
    })]);
    let product = |id: i64, name: &str, code: String, tmpl: i64, count: i64, values: Vec<i64>| {
        json!({
            "id": id, "name": name, "display_name": format!("[{code}] {name}"), "default_code": code,
            "barcode": false, "product_tmpl_id": [tmpl, name], "product_variant_count": count,
            "standard_price": 9.5, "lst_price": 39.0, "list_price": 39.0, "weight": 1.2, "active": true,
            "uom_id": [1, "Units"], "product_template_attribute_value_ids": values, "type": "product",
            "write_date": at,
        })
    };
    fake.add(
        "product.product",
        vec![
            product(
                10,
                &format!("Desk lamp {s}"),
                format!("LAMP-{s}"),
                5,
                1,
                vec![],
            ),
            product(
                11,
                &format!("Shade {s}"),
                format!("SHADE-R-{s}"),
                6,
                2,
                vec![3],
            ),
            product(
                12,
                &format!("Shade {s}"),
                format!("SHADE-B-{s}"),
                6,
                2,
                vec![4],
            ),
        ],
    );
    fake.add(
        "product.template",
        vec![
            json!({ "id": 5, "write_date": "2026-11-01 09:00:00", "uom_id": [1, "Units"] }),
            json!({ "id": 6, "write_date": "2026-11-02 08:00:00", "uom_id": [1, "Units"] }),
        ],
    );
    fake.add(
        "product.template.attribute.value",
        vec![
            json!({ "id": 3, "name": "Red" }),
            json!({ "id": 4, "name": "Blue" }),
        ],
    );
    fake.add("res.partner", vec![
        json!({ "id": 14, "name": format!("Azure {s}"), "ref": format!("AZ-{s}"), "supplier_rank": 2, "active": true,
                "email": "buy@azure.example", "country_code": "US", "property_purchase_currency_id": [1, "EUR"], "write_date": at }),
        // Not a vendor yet: the vendor line below brings it in.
        json!({ "id": 15, "name": format!("Brass {s}"), "ref": false, "supplier_rank": 0, "active": true, "write_date": at }),
    ]);
    fake.add("product.supplierinfo", vec![
        json!({ "id": 3, "partner_id": [14, "Azure"], "product_tmpl_id": [5, "Desk lamp"], "product_id": false,
                "product_code": "AZ-L", "product_name": false, "price": 120.0, "currency_id": [1, "EUR"],
                "min_qty": 1.0, "delay": 7, "sequence": 1, "date_end": false, "product_uom": [2, "Dozens"], "write_date": at }),
        json!({ "id": 4, "partner_id": [15, "Brass"], "product_tmpl_id": [6, "Shade"], "product_id": [11, "Shade (Red)"],
                "product_code": false, "product_name": "Red shade", "price": 10.0, "currency_id": [1, "EUR"],
                "min_qty": 0.0, "delay": 3, "sequence": 1, "date_end": false, "product_uom": [1, "Units"], "write_date": at }),
    ]);
    fake.add(
        "uom.uom",
        vec![
            json!({ "id": 1, "factor": 1.0 }),
            json!({ "id": 2, "factor": 1.0 / 12.0 }),
        ],
    );
    fake.add("stock.quant", vec![
        json!({ "id": 100, "product_id": [10, "Lamp"], "location_id": [8, "WH/Stock"], "warehouse_id": [1, "WH"], "quantity": 5.0, "reserved_quantity": 1.0, "write_date": at }),
        json!({ "id": 101, "product_id": [10, "Lamp"], "location_id": [9, "WH/Stock/Shelf"], "warehouse_id": [1, "WH"], "quantity": 2.5, "reserved_quantity": 0.0, "write_date": at }),
        json!({ "id": 102, "product_id": [11, "Shade (Red)"], "location_id": [8, "WH/Stock"], "warehouse_id": [1, "WH"], "quantity": 3.0, "reserved_quantity": 0.0, "write_date": at }),
        json!({ "id": 103, "product_id": [999, "Unknown"], "location_id": [8, "WH/Stock"], "warehouse_id": [1, "WH"], "quantity": 9.0, "reserved_quantity": 0.0, "write_date": at }),
    ]);
    fake.add(
        "stock.picking.type",
        vec![json!({ "id": 1, "warehouse_id": [1, "San Francisco"] })],
    );
    fake.add("purchase.order", vec![json!({
        "id": 50, "name": format!("P{s}"), "partner_id": [14, "Azure"], "state": "purchase",
        "date_order": "2026-11-01 08:00:00", "date_approve": "2026-11-01 09:00:00", "date_planned": "2026-11-20 10:00:00",
        "currency_id": [1, "EUR"], "picking_type_id": [1, "San Francisco: Receipts"],
        "amount_untaxed": 240.0, "amount_tax": 50.4, "amount_total": 290.4, "write_date": at,
    })]);
    fake.add("purchase.order.line", vec![json!({
        "id": 60, "order_id": [50, "P"], "product_id": [10, format!("[LAMP-{s}] Desk lamp")], "name": "[LAMP] Desk lamp",
        "product_qty": 2.0, "product_uom_qty": 24.0, "qty_received": 1.0, "price_unit": 120.0,
        "price_tax": 50.4, "price_total": 290.4, "discount": 0.0, "display_type": false, "write_date": at,
    })]);
    fake.add("sale.order", vec![json!({ "id": 90, "date_order": "2026-10-01 10:00:00", "state": "sale", "warehouse_id": [1, "SF"], "write_date": at })]);
    let line = |id: i64, product: i64, qty: f64, uom: i64, state: &str| {
        json!({ "id": id, "order_id": [90, "S00090"], "product_id": [product, "x"], "product_uom_qty": qty,
                "product_uom": [uom, "u"], "state": state, "display_type": false, "is_downpayment": false,
                "warehouse_id": [1, "SF"], "write_date": at })
    };
    fake.add(
        "sale.order.line",
        vec![
            line(91, 10, 2.0, 2, "sale"),
            line(92, 11, 1.0, 1, "cancel"),
            line(93, 12, 4.0, 1, "sale"),
        ],
    );
}

#[tokio::test]
async fn odoo_17_syncs_into_weldstash() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    let ran = sync(&db, &env, &connection, None).await;
    assert_eq!(ran.len(), 7);

    let runs: Vec<(String, String, String)> = sqlx::query_as(
        "select sync_name, status, sync_type from connector_sync_runs where connection_id = $1 order by started_at, sync_name",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(runs.len(), 7);
    assert!(
        runs.iter()
            .all(|(_, status, kind)| status == "success" && kind == "INITIAL"),
        "{runs:?}"
    );

    // The warehouse is managed by the connection.
    let warehouse = mapped(&db, &conn_id, "odoo_warehouse", 1).await;
    let w = row(
        &db,
        "select to_jsonb(w) from warehouses w where id = $1",
        &warehouse,
    )
    .await;
    assert_eq!(w["managed_by_connection_id"], json!(conn_id));
    assert_eq!(w["code"], json!("WH"));
    assert_eq!(w["metadata"]["odoo"]["inTypeId"], json!(1));

    // A single-variant product, and a product with two variants.
    let lamp = mapped(&db, &conn_id, "odoo_product", 10).await;
    let p = row(
        &db,
        "select to_jsonb(p) from products p where id = $1",
        &lamp,
    )
    .await;
    assert_eq!(p["sku"], json!(format!("LAMP-{s}")));
    assert_eq!(p["cost_price"], json!(9.5));
    assert_eq!(p["status"], json!("active"));
    assert_eq!(p["inventory_quantity"], json!(8));
    let red = mapped(&db, &conn_id, "odoo_product", 11).await;
    let v = row(
        &db,
        "select to_jsonb(v) from product_variants v where id = $1",
        &red,
    )
    .await;
    assert_eq!(v["name"], json!("Red"));
    assert_eq!(v["sku"], json!(format!("SHADE-R-{s}")));
    assert_eq!(v["inventory_quantity"], json!(3));
    let shade = v["product_id"].as_str().unwrap().to_owned();
    let parent = row(
        &db,
        "select to_jsonb(p) from products p where id = $1",
        &shade,
    )
    .await;
    assert_eq!(parent["has_variants"], json!(true));
    assert_eq!(parent["variant_count"], json!(2));
    assert_eq!(
        mapped(&db, &conn_id, "odoo_product_template", 6).await,
        shade
    );

    // Vendors, the second one brought in by its vendor line.
    let azure = mapped(&db, &conn_id, "odoo_supplier", 14).await;
    let a = row(
        &db,
        "select to_jsonb(s) from suppliers s where id = $1",
        &azure,
    )
    .await;
    assert_eq!(a["code"], json!(format!("AZ-{s}")));
    assert_eq!(a["currency"], json!("EUR"));
    let brass = mapped(&db, &conn_id, "odoo_supplier", 15).await;

    // Vendor prices per product unit: 120 a dozen is 10 a unit, a minimum
    // of one dozen is 12 units.
    let lamp_supplier = mapped(&db, &conn_id, "odoo_supplierinfo", 3).await;
    let ps = row(&db, "select to_jsonb(p) || jsonb_build_object('unit_cost', p.unit_cost::text) from product_suppliers p where id = $1", &lamp_supplier).await;
    assert_eq!(ps["product_id"], json!(lamp));
    assert_eq!(ps["supplier_id"], json!(azure));
    assert_eq!(ps["unit_cost"], json!("10.0000"));
    assert_eq!(ps["min_order_qty"], json!(12));
    assert_eq!(ps["lead_time_days"], json!(7));
    assert_eq!(ps["currency"], json!("EUR"));
    assert_eq!(ps["supplier_sku"], json!("AZ-L"));
    assert_eq!(ps["is_preferred"], json!(true));
    let red_supplier = mapped(&db, &conn_id, "odoo_supplierinfo", 4).await;
    let rs = row(
        &db,
        "select to_jsonb(p) from product_suppliers p where id = $1",
        &red_supplier,
    )
    .await;
    assert_eq!(rs["variant_id"], json!(red));
    assert_eq!(rs["supplier_id"], json!(brass));
    assert_eq!(rs["min_order_qty"], Value::Null);

    // One bucket per item in the managed warehouse, quantities summed and rounded.
    let buckets: Vec<(String, Option<String>, i32, Option<i32>, Option<i32>)> = sqlx::query_as(
        "select product_id, variant_id, quantity_on_hand, quantity_allocated, quantity_available
         from inventory where warehouse_id = $1 and deleted_at is null order by product_id, variant_id",
    )
    .bind(&warehouse)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(buckets.len(), 2, "{buckets:?}");
    assert!(buckets.contains(&(lamp.clone(), None, 8, Some(1), Some(7))));
    assert!(buckets.contains(&(shade.clone(), Some(red.clone()), 3, Some(0), Some(3))));

    // The purchase order: half received.
    let po = mapped(&db, &conn_id, "odoo_purchase_order", 50).await;
    let order = row(
        &db,
        "select to_jsonb(p) from purchase_orders p where id = $1",
        &po,
    )
    .await;
    assert_eq!(order["po_number"], json!(format!("P{s}")));
    assert_eq!(order["status"], json!("partial"));
    assert_eq!(order["supplier_id"], json!(azure));
    assert_eq!(order["warehouse_id"], json!(warehouse));
    assert_eq!(order["total_quantity_ordered"], json!(24));
    assert_eq!(order["total_quantity_received"], json!(12));
    assert_eq!(
        order["metadata"]["odoo"],
        json!({ "id": 50, "name": format!("P{s}") })
    );
    let items: Vec<(Option<String>, i32, Option<i32>, Option<i32>, String)> = sqlx::query_as(
        "select product_id, quantity_ordered, quantity_received, quantity_pending, unit_price::text
         from purchase_order_items where purchase_order_id = $1",
    )
    .bind(&po)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].0.as_deref(), Some(lamp.as_str()));
    assert_eq!(
        (items[0].1, items[0].2, items[0].3),
        (24, Some(12), Some(12))
    );
    assert!(items[0].4.starts_with("10"), "{}", items[0].4);

    // Sales demand: two dozen lamps are 24, the cancelled line is not there.
    let sales: Vec<(String, String, Option<String>, Option<String>, i32)> = sqlx::query_as(
        "select external_ref, date::text, variant_id, warehouse_id, quantity from stash_sales_history
         where connection_id = $1 and source = 'odoo' order by external_ref",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        sales,
        vec![
            (
                "91".to_owned(),
                "2026-10-01".to_owned(),
                None,
                Some(warehouse.clone()),
                24
            ),
            (
                "93".to_owned(),
                "2026-10-01".to_owned(),
                Some(mapped(&db, &conn_id, "odoo_product", 12).await),
                Some(warehouse.clone()),
                4
            ),
        ]
    );

    // The watermarks: the newest change plus a second.
    let connection = reload(&db, &conn_id).await;
    assert_eq!(
        connection["sync_watermarks"]["OdooProduct"],
        json!("2026-11-02 08:00:01")
    );
    assert_eq!(
        connection["sync_watermarks"]["OdooStockQuant"],
        json!("2026-11-01 10:00:01")
    );
    assert_eq!(connection["status"], json!("active"));

    // ── an incremental pass ────────────────────────────────────────────
    let later = "2026-11-18 11:00:00";
    fake.remove("stock.quant", 100);
    fake.remove("stock.quant", 101);
    fake.update(
        "sale.order.line",
        91,
        &json!({ "state": "cancel", "write_date": later }),
    );
    fake.update(
        "purchase.order.line",
        60,
        &json!({ "qty_received": 2.0, "write_date": later }),
    );
    fake.update(
        "product.product",
        10,
        &json!({ "standard_price": 11.0, "write_date": later }),
    );
    fake.remove("product.supplierinfo", 3);
    sync(&db, &env, &connection, None).await;

    let p = row(
        &db,
        "select to_jsonb(p) from products p where id = $1",
        &lamp,
    )
    .await;
    assert_eq!(p["cost_price"], json!(11.0));
    assert_eq!(p["inventory_quantity"], json!(0));
    let lamp_bucket: (i32, Option<i32>) = sqlx::query_as(
        "select quantity_on_hand, quantity_allocated from inventory
         where warehouse_id = $1 and product_id = $2 and variant_id is null and deleted_at is null",
    )
    .bind(&warehouse)
    .bind(&lamp)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(lamp_bucket, (0, Some(0)));
    let order = row(
        &db,
        "select to_jsonb(p) from purchase_orders p where id = $1",
        &po,
    )
    .await;
    assert_eq!(order["status"], json!("received"));
    assert!(order["received_date"].is_string());
    let item_count: i64 = sqlx::query_scalar(
        "select count(*) from purchase_order_items where purchase_order_id = $1",
    )
    .bind(&po)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(item_count, 1);
    let lines: Vec<String> = sqlx::query_scalar(
        "select external_ref from stash_sales_history where connection_id = $1 order by external_ref",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(lines, vec!["93".to_owned()]);
    let released: Option<String> =
        sqlx::query_scalar("select deleted_at::text from product_suppliers where id = $1")
            .bind(&lamp_supplier)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(released.is_some());
    let incremental: i64 = sqlx::query_scalar(
        "select count(*) from connector_sync_runs where connection_id = $1 and sync_type = 'INCREMENTAL' and status = 'success'",
    )
    .bind(&conn_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(incremental, 7);
    // Nothing was duplicated.
    let warehouses: i64 =
        sqlx::query_scalar("select count(*) from warehouses where managed_by_connection_id = $1")
            .bind(&conn_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(warehouses, 1);
}

#[tokio::test]
async fn odoo_19_syncs_over_json_2() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo2_{s}");
    let fake = Arc::new(FakeOdoo::new(19));
    seed(&fake, &s);
    // Odoo 18+: storable is a flag, not a product type.
    for id in [10, 11, 12] {
        fake.update(
            "product.product",
            id,
            &json!({ "type": "consu", "is_storable": id != 12 }),
        );
    }
    let connection = connection(&db, &conn_id, &json!({})).await;
    let env = env(&fake);
    sync(
        &db,
        &env,
        &connection,
        Some(vec!["warehouses".to_owned(), "products".to_owned()]),
    )
    .await;
    assert!(
        fake.calls()
            .iter()
            .any(|(model, method)| model == "product.product" && method == "search_read")
    );
    let requests = fake.requests.lock().unwrap().clone();
    assert!(requests.iter().skip(1).all(|r| r.url.contains("/json/2/")));
    let lamp = mapped(&db, &conn_id, "odoo_product", 10).await;
    let p = row(
        &db,
        "select to_jsonb(p) from products p where id = $1",
        &lamp,
    )
    .await;
    assert_eq!(p["sku"], json!(format!("LAMP-{s}")));
    let blue: Option<String> = sqlx::query_scalar(
        "select internal_entity_id from integration_entity_mappings where connection_id = $1 and external_entity_id = '12'",
    )
    .bind(&conn_id)
    .fetch_optional(&db)
    .await
    .unwrap();
    assert_eq!(blue, None, "a product that keeps no stock is not synced");
}

#[tokio::test]
async fn a_rejected_key_marks_the_connection() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo3_{s}");
    let fake = Arc::new(FakeOdoo {
        reject_key: true,
        ..FakeOdoo::new(17)
    });
    let connection = connection(&db, &conn_id, &json!({})).await;
    let env = env(&fake);
    let result = sync_connection(&SyncArgs {
        db: &db,
        env: &env,
        connection: &connection,
        owner_id: "user_odoo_test",
        workspace_id: "org_odoo_test",
        trigger: Trigger::Schedule,
        full: false,
        syncs: None,
    })
    .await;
    assert!(result.is_err());
    let connection = reload(&db, &conn_id).await;
    assert_eq!(connection["status"], json!("auth_error"));
    assert_eq!(
        connection["last_error"],
        json!(
            "Odoo rejected the login or API key. On Odoo Online, external API access needs the Custom plan."
        )
    );
    let runs: i64 = sqlx::query_scalar(
        "select count(*) from connector_sync_runs where connection_id = $1 and status = 'error'",
    )
    .bind(&conn_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(runs, 1, "the first sync's failure ends the run");
}

#[tokio::test]
async fn an_order_received_short_and_closed_is_received() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo4_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    // 12 of 24 arrived, validated with "No backorder": Odoo calls it full.
    fake.update("purchase.order", 50, &json!({ "receipt_status": "full" }));
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    sync(&db, &env(&fake), &connection, None).await;
    let po = mapped(&db, &conn_id, "odoo_purchase_order", 50).await;
    let order = row(
        &db,
        "select to_jsonb(p) from purchase_orders p where id = $1",
        &po,
    )
    .await;
    assert_eq!(order["status"], json!("received"));
    assert_eq!(order["total_quantity_received"], json!(12));
    let item: (i32, Option<i32>, Option<i32>) = sqlx::query_as(
        "select quantity_ordered, quantity_received, quantity_pending from purchase_order_items
         where purchase_order_id = $1",
    )
    .bind(&po)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(item, (24, Some(12), Some(0)));
    // Incoming counts approved, ordered and partial orders only.
    let incoming: i64 = sqlx::query_scalar(
        "select count(*) from purchase_orders where id = $1
           and status = any(array['approved', 'ordered', 'partial'])",
    )
    .bind(&po)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(incoming, 0);
}

#[tokio::test]
async fn dependent_syncs_wait_for_the_product_scan() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    // Two records a page, one page a run: the three products take two runs.
    super::sync::TEST_LIMITS.with(|limits| limits.set(Some((2, 1))));
    let s = suffix();
    let conn_id = format!("conn_odoo5_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    sync(&db, &env, &connection, None).await;

    let runs: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select sync_name, status, error from connector_sync_runs where connection_id = $1",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    for name in [
        "odoo-product-suppliers",
        "odoo-stock",
        "odoo-purchase-orders",
        "odoo-sales",
    ] {
        let run = runs.iter().find(|(n, ..)| n == name).unwrap();
        assert_eq!(run.1, "partial", "{name}");
        assert_eq!(
            run.2.as_deref(),
            Some("Waiting for odoo-products to finish; this sync runs on the next pass"),
            "{name}"
        );
    }
    let connection = reload(&db, &conn_id).await;
    assert_eq!(
        connection["sync_watermarks"]["OdooProduct__cursor"],
        json!("11")
    );
    assert!(
        connection["sync_watermarks"]
            .get("OdooSaleOrderLine")
            .is_none()
    );
    let sales: i64 =
        sqlx::query_scalar("select count(*) from stash_sales_history where connection_id = $1")
            .bind(&conn_id)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(sales, 0, "nothing read before the products are mapped");

    // The next pass finishes the products, then runs the rest.
    sync(&db, &env, &connection, None).await;
    let lamp = mapped(&db, &conn_id, "odoo_product", 10).await;
    let blue = mapped(&db, &conn_id, "odoo_product", 12).await;
    let sales: Vec<(String, Option<String>)> = sqlx::query_as(
        "select external_ref, variant_id from stash_sales_history where connection_id = $1 order by external_ref",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        sales,
        vec![("91".to_owned(), None), ("93".to_owned(), Some(blue))]
    );
    let po = mapped(&db, &conn_id, "odoo_purchase_order", 50).await;
    let product: Option<String> = sqlx::query_scalar(
        "select product_id from purchase_order_items where purchase_order_id = $1",
    )
    .bind(&po)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(product, Some(lamp));
}

#[tokio::test]
async fn a_line_for_a_product_not_synced_yet_is_read_again() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo6_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    sync(&db, &env, &connection, None).await;

    // A product made in Odoo after the product sync ran, already sold; and
    // a service, which keeps no stock.
    let later = "2026-11-18 11:00:00";
    fake.add("product.product", vec![
        json!({ "id": 13, "name": format!("Floor lamp {s}"), "default_code": format!("FLOOR-{s}"),
                "product_tmpl_id": [7, "Floor lamp"], "product_variant_count": 1, "type": "product",
                "uom_id": [1, "Units"], "active": true, "write_date": later }),
        json!({ "id": 14, "name": "Installation", "product_tmpl_id": [8, "Installation"],
                "product_variant_count": 1, "type": "service", "uom_id": [1, "Units"], "active": true, "write_date": later }),
    ]);
    fake.add(
        "product.template",
        vec![
            json!({ "id": 7, "write_date": later, "uom_id": [1, "Units"] }),
            json!({ "id": 8, "write_date": later, "uom_id": [1, "Units"] }),
        ],
    );
    let line = |id: i64, product: i64| {
        json!({ "id": id, "order_id": [90, "S00090"], "product_id": [product, "x"], "product_uom_qty": 2.0,
                "product_uom": [1, "u"], "state": "sale", "display_type": false, "is_downpayment": false,
                "warehouse_id": [1, "SF"], "write_date": later })
    };
    fake.add("sale.order.line", vec![line(94, 13), line(95, 14)]);
    let connection = reload(&db, &conn_id).await;
    let before = connection["sync_watermarks"]["OdooSaleOrderLine"].clone();
    sync(&db, &env, &connection, Some(vec!["sales".to_owned()])).await;
    let run: (String, Option<String>, Option<Value>) = sqlx::query_as(
        "select status, error, error_samples from connector_sync_runs
         where connection_id = $1 and sync_name = 'odoo-sales' order by started_at desc limit 1",
    )
    .bind(&conn_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(run.0, "partial");
    assert_eq!(run.1.as_deref(), Some("1 record(s) failed to import"));
    assert_eq!(
        run.2,
        Some(
            json!([{ "externalId": "94", "message": "Odoo product 13 is not synced yet; read again on the next pass" }])
        )
    );
    let connection = reload(&db, &conn_id).await;
    assert_eq!(
        connection["sync_watermarks"]["OdooSaleOrderLine"], before,
        "the watermark waits"
    );

    // Products first, then the line comes in; the service line never does.
    sync(
        &db,
        &env,
        &connection,
        Some(vec!["products".to_owned(), "sales".to_owned()]),
    )
    .await;
    let refs: Vec<String> = sqlx::query_scalar(
        "select external_ref from stash_sales_history where connection_id = $1 order by external_ref",
    )
    .bind(&conn_id)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(
        refs,
        vec!["91".to_owned(), "93".to_owned(), "94".to_owned()]
    );
}

#[tokio::test]
async fn a_failure_before_the_page_ceiling_is_read_again() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo7_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    sync(&db, &env, &connection, None).await;

    // A vendor line for a product made after the product sync ran (it waits
    // for it), then one that imports.
    let later = "2026-11-18 11:00:00";
    fake.add("product.product", vec![
        json!({ "id": 13, "name": format!("Floor lamp {s}"), "default_code": format!("FLOOR-{s}"),
                "product_tmpl_id": [7, "Floor lamp"], "product_variant_count": 1, "type": "product",
                "uom_id": [1, "Units"], "active": true, "write_date": later }),
    ]);
    fake.add(
        "product.template",
        vec![json!({ "id": 7, "write_date": later, "uom_id": [1, "Units"] })],
    );
    let line = |id: i64, partner: i64, template: i64, product: i64| {
        json!({ "id": id, "partner_id": [partner, "Vendor"], "product_tmpl_id": [template, "t"],
                "product_id": [product, "p"], "product_code": false, "product_name": false, "price": 50.0,
                "currency_id": [1, "EUR"], "min_qty": 0.0, "delay": 5, "sequence": 1, "date_end": false,
                "product_uom": [1, "Units"], "write_date": later })
    };
    fake.add(
        "product.supplierinfo",
        vec![line(5, 14, 7, 13), line(6, 15, 5, 10)],
    );
    let before = reload(&db, &conn_id).await["sync_watermarks"]["OdooSupplierInfo"].clone();

    // One line a page, one page a run: line 5 fails on the first run, which
    // the ceiling cuts short; line 6 comes on the second; the third completes
    // the scan.
    super::sync::TEST_LIMITS.with(|limits| limits.set(Some((1, 1))));
    let only = || Some(vec!["productSuppliers".to_owned()]);
    let connection = reload(&db, &conn_id).await;
    sync(&db, &env, &connection, only()).await;
    let marks = reload(&db, &conn_id).await["sync_watermarks"].clone();
    assert_eq!(marks["OdooSupplierInfo__cursor"], json!("5"));
    assert_eq!(marks["OdooSupplierInfo__failed"], json!("true"));
    for _ in 0..2 {
        let connection = reload(&db, &conn_id).await;
        sync(&db, &env, &connection, only()).await;
    }
    let marks = reload(&db, &conn_id).await["sync_watermarks"].clone();
    assert!(marks.get("OdooSupplierInfo__cursor").is_none(), "{marks}");
    assert!(marks.get("OdooSupplierInfo__failed").is_none(), "{marks}");
    assert_eq!(
        marks["OdooSupplierInfo"], before,
        "the watermark stays before the line that failed"
    );
    assert!(
        mapping(&db, &conn_id, "odoo_supplierinfo", 6)
            .await
            .is_some()
    );
    assert!(
        mapping(&db, &conn_id, "odoo_supplierinfo", 5)
            .await
            .is_none()
    );

    // Products first, then the line that waited comes in.
    super::sync::TEST_LIMITS.with(|limits| limits.set(None));
    let connection = reload(&db, &conn_id).await;
    sync(
        &db,
        &env,
        &connection,
        Some(vec!["products".to_owned(), "productSuppliers".to_owned()]),
    )
    .await;
    assert!(
        mapping(&db, &conn_id, "odoo_supplierinfo", 5)
            .await
            .is_some()
    );
}

#[tokio::test]
async fn a_vendor_line_that_expires_unread_releases_its_row() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo8_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    sync(&db, &env, &connection, None).await;
    let red_supplier = mapped(&db, &conn_id, "odoo_supplierinfo", 4).await;
    let lamp_supplier = mapped(&db, &conn_id, "odoo_supplierinfo", 3).await;

    // Line 4's end date passes; nothing in Odoo changes its `write_date`.
    fake.update(
        "product.supplierinfo",
        4,
        &json!({ "date_end": "2020-01-31" }),
    );
    let connection = reload(&db, &conn_id).await;
    sync(
        &db,
        &env,
        &connection,
        Some(vec!["productSuppliers".to_owned()]),
    )
    .await;
    assert!(
        supplier_deleted_at(&db, &red_supplier).await.is_some(),
        "the expired line's row is released"
    );
    assert!(
        mapping(&db, &conn_id, "odoo_supplierinfo", 4)
            .await
            .is_none()
    );
    assert!(
        supplier_deleted_at(&db, &lamp_supplier).await.is_none(),
        "a line without an end date stays"
    );
}

async fn supplier_deleted_at(db: &PgPool, id: &str) -> Option<String> {
    sqlx::query_scalar("select deleted_at::text from product_suppliers where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_full_sync_refills_a_row_its_owner_released() {
    let Some(db) = tenant().await else {
        eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
        return;
    };
    let s = suffix();
    let conn_id = format!("conn_odoo9_{s}");
    let fake = Arc::new(FakeOdoo::new(17));
    seed(&fake, &s);
    // A quantity break for the lamp from the same vendor: line 3 (from one
    // dozen) ranks first and owns the row; line 5 (from ten) is mapped to it.
    fake.add("product.supplierinfo", vec![
        json!({ "id": 5, "partner_id": [14, "Azure"], "product_tmpl_id": [5, "Desk lamp"], "product_id": false,
                "product_code": "AZ-L", "product_name": false, "price": 108.0, "currency_id": [1, "EUR"],
                "min_qty": 10.0, "delay": 9, "sequence": 1, "date_end": false, "product_uom": [2, "Dozens"],
                "write_date": "2026-11-01 10:00:00" }),
    ]);
    let connection = connection(&db, &conn_id, &json!({ "importStartDate": "2026-01-01" })).await;
    let env = env(&fake);
    sync(&db, &env, &connection, None).await;
    let shared = mapped(&db, &conn_id, "odoo_supplierinfo", 3).await;
    assert_eq!(mapped(&db, &conn_id, "odoo_supplierinfo", 5).await, shared);

    // Line 3 is deleted in Odoo: its row goes with it.
    fake.remove("product.supplierinfo", 3);
    let connection = reload(&db, &conn_id).await;
    sync(
        &db,
        &env,
        &connection,
        Some(vec!["productSuppliers".to_owned()]),
    )
    .await;
    assert!(supplier_deleted_at(&db, &shared).await.is_some());

    // A full sync reads line 5 again, unchanged: it fills the row.
    let connection = reload(&db, &conn_id).await;
    full_sync(&db, &env, &connection, vec!["productSuppliers".to_owned()]).await;
    let lamp = mapped(&db, &conn_id, "odoo_product", 10).await;
    let azure = mapped(&db, &conn_id, "odoo_supplier", 14).await;
    let live: Vec<(String, Option<i32>, Option<i32>)> = sqlx::query_as(
        "select id, min_order_qty, lead_time_days from product_suppliers
         where product_id = $1 and variant_id is null and supplier_id = $2 and deleted_at is null",
    )
    .bind(&lamp)
    .bind(&azure)
    .fetch_all(&db)
    .await
    .unwrap();
    assert_eq!(live.len(), 1, "{live:?}");
    assert_ne!(live[0].0, shared);
    assert_eq!((live[0].1, live[0].2), (Some(120), Some(9)));
    assert_eq!(
        mapped(&db, &conn_id, "odoo_supplierinfo", 5).await,
        live[0].0
    );
}
