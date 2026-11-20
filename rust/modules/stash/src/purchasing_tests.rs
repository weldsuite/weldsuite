//! The purchasing services the routes don't reach on their own (incoming
//! stock, purchase order numbers, totals of a missing purchase order) and
//! the ledger's refusals for a warehouse another system owns, on the real
//! tenant schema. Skipped without `WELDSUITE_TEST_TENANT_URL`. The database
//! is shared: fresh ids, nothing truncated or assumed empty.

use serde_json::json;
use weldsuite_db::PgPool;

use crate::incoming::{
    Incoming, IncomingQuery, VariantFilter, incoming, incoming_lines, parse_date,
};
use crate::ledger::{
    Endpoint, Issue, LedgerError, StockChange, Transfer, WAREHOUSE_MANAGED, allocate_stock,
    apply_stock_change, check_receipt, issue_allocated_stock, release_allocation, transfer_stock,
};
use crate::po_number::{generate_po_number, generate_po_numbers, po_number_prefix};
use crate::po_totals::recompute_po_totals;

fn tenant() -> Option<PgPool> {
    let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return None;
    };
    Some(weldsuite_db::master_pool(&url, 2).expect("tenant pool"))
}

struct Fx {
    db: PgPool,
    tag: String,
}

impl Fx {
    fn new(db: &PgPool) -> Self {
        Self {
            db: db.clone(),
            tag: weldsuite_kit::generate_id(""),
        }
    }

    fn id(&self, key: &str) -> String {
        format!("{key}_{}", self.tag)
    }

    async fn run(&self, sql: &'static str, binds: &[Option<&str>]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(&self.db).await.expect(sql);
    }

    async fn product(&self, key: &str, lots: bool) -> String {
        let id = self.id(key);
        let lots = if lots { "true" } else { "false" };
        self.run(
            "insert into products (id, name, slug, sku, track_lots) values ($1, $1, $1, $1, $2::boolean)",
            &[Some(&id), Some(lots)],
        )
        .await;
        id
    }

    async fn warehouse(&self, key: &str, managed: bool) -> String {
        let id = self.id(key);
        let connection = managed.then(|| self.id("conn"));
        self.run(
            "insert into warehouses (id, name, managed_by_connection_id) values ($1, $1, $2)",
            &[Some(&id), connection.as_deref()],
        )
        .await;
        id
    }

    /// A purchase order; `deleted` soft-deletes it.
    async fn order(
        &self,
        key: &str,
        status: &str,
        warehouse: Option<&str>,
        expected: Option<&str>,
        deleted: bool,
    ) -> String {
        let id = self.id(key);
        self.run(
            "insert into purchase_orders (id, po_number, status, warehouse_id, expected_date, deleted_at) \
             values ($1, $1, $2, $3, $4::timestamp, case when $5::boolean then now() else null end)",
            &[
                Some(&id),
                Some(status),
                warehouse,
                expected,
                Some(if deleted { "true" } else { "false" }),
            ],
        )
        .await;
        id
    }

    /// A line: ordered, received, rejected.
    async fn line(
        &self,
        key: &str,
        order: &str,
        product: Option<&str>,
        variant: Option<&str>,
        units: (i32, i32, i32),
    ) -> String {
        let id = self.id(key);
        sqlx::query(
            "insert into purchase_order_items (id, purchase_order_id, product_id, variant_id, name, \
             quantity_ordered, quantity_received, quantity_rejected, unit_price, total) \
             values ($1, $2, $3, $4, $1, $5, $6, $7, 1, 1)",
        )
        .bind(&id)
        .bind(order)
        .bind(product)
        .bind(variant)
        .bind(units.0)
        .bind(units.1)
        .bind(units.2)
        .execute(&self.db)
        .await
        .expect("line");
        id
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // every filter on one set of purchase orders
async fn incoming_sums_the_open_lines_per_item() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let (w1, w2) = (
        fx.warehouse("w1", false).await,
        fx.warehouse("w2", false).await,
    );
    let (p1, p2) = (fx.product("p1", false).await, fx.product("p2", false).await);
    let variant = fx.id("v");
    fx.run(
        "insert into product_variants (id, product_id, name) values ($1, $2, $1)",
        &[Some(&variant), Some(&p1)],
    )
    .await;

    let a = fx
        .order(
            "a",
            "approved",
            Some(&w1),
            Some("2026-12-10T08:00:00"),
            false,
        )
        .await;
    let a1 = fx.line("a1", &a, Some(&p1), None, (10, 3, 1)).await;
    fx.line("a2", &a, Some(&p1), Some(&variant), (5, 0, 0))
        .await;
    fx.line("a3", &a, None, None, (4, 0, 0)).await;
    fx.line("a4", &a, Some(&p2), None, (2, 2, 0)).await;
    let b = fx
        .order(
            "b",
            "ordered",
            Some(&w1),
            Some("2026-12-05T00:00:00"),
            false,
        )
        .await;
    let b1 = fx.line("b1", &b, Some(&p1), Some(""), (4, 0, 0)).await;
    let c = fx.order("c", "partial", Some(&w2), None, false).await;
    let c1 = fx.line("c1", &c, Some(&p1), None, (3, 0, 0)).await;
    // Not on their way: a draft, a cancelled, a received, a deleted order,
    // one without a warehouse.
    for (key, status, warehouse, deleted) in [
        ("d", "draft", Some(w1.as_str()), false),
        ("e", "cancelled", Some(w1.as_str()), false),
        ("f", "received", Some(w1.as_str()), false),
        ("g", "approved", Some(w1.as_str()), true),
        ("h", "approved", None, false),
    ] {
        let order = fx.order(key, status, warehouse, None, deleted).await;
        fx.line(&format!("{key}1"), &order, Some(&p1), None, (100, 0, 0))
            .await;
    }

    let both = Some(vec![p1.clone(), p2.clone()]);
    let all = incoming(
        &db,
        &IncomingQuery {
            product_ids: both.clone(),
            ..IncomingQuery::default()
        },
    )
    .await
    .expect("incoming");
    let item =
        |variant: Option<&str>, warehouse: &str, quantity: i64, next: Option<&str>| Incoming {
            product_id: p1.clone(),
            variant_id: variant.map(str::to_owned),
            warehouse_id: warehouse.to_owned(),
            quantity,
            next_expected_date: next.map(str::to_owned),
        };
    assert_eq!(
        all,
        [
            item(None, &w1, 10, Some("2026-12-05T00:00:00.000Z")),
            item(None, &w2, 3, None),
            item(Some(&variant), &w1, 5, Some("2026-12-10T08:00:00.000Z")),
        ]
    );
    assert_eq!(
        all[0].to_json(),
        json!({ "productId": p1, "variantId": null, "warehouseId": w1, "quantity": 10, "nextExpectedDate": "2026-12-05T00:00:00.000Z" })
    );

    let without_variant = incoming(
        &db,
        &IncomingQuery {
            product_ids: both.clone(),
            variant: VariantFilter::None,
            warehouse_id: None,
        },
    )
    .await
    .expect("incoming");
    assert_eq!(
        without_variant,
        [
            item(None, &w1, 10, Some("2026-12-05T00:00:00.000Z")),
            item(None, &w2, 3, None)
        ]
    );
    let only_variant = incoming(
        &db,
        &IncomingQuery {
            product_ids: both.clone(),
            variant: VariantFilter::Only(variant.clone()),
            warehouse_id: None,
        },
    )
    .await
    .expect("incoming");
    assert_eq!(
        only_variant,
        [item(
            Some(&variant),
            &w1,
            5,
            Some("2026-12-10T08:00:00.000Z")
        )]
    );
    let in_w2 = incoming(
        &db,
        &IncomingQuery {
            product_ids: both.clone(),
            variant: VariantFilter::Any,
            warehouse_id: Some(w2.clone()),
        },
    )
    .await
    .expect("incoming");
    assert_eq!(in_w2, [item(None, &w2, 3, None)]);
    let p2_only = incoming(
        &db,
        &IncomingQuery {
            product_ids: Some(vec![p2.clone()]),
            ..IncomingQuery::default()
        },
    )
    .await
    .expect("incoming");
    assert!(p2_only.is_empty(), "a fully received line brings nothing");

    let lines = incoming_lines(
        &db,
        &IncomingQuery {
            product_ids: Some(vec![p1.clone()]),
            variant: VariantFilter::None,
            warehouse_id: None,
        },
    )
    .await
    .expect("lines");
    let summary: Vec<_> = lines
        .iter()
        .map(|line| {
            (
                line.item_id.as_str(),
                line.warehouse_id.as_str(),
                line.quantity,
                line.expected_date,
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            (b1.as_str(), w1.as_str(), 4, parse_date("2026-12-05")),
            (a1.as_str(), w1.as_str(), 6, parse_date("2026-12-10")),
            (c1.as_str(), w2.as_str(), 3, None),
        ]
    );
    assert_eq!(lines[0].purchase_order_id, b);
    assert_eq!(lines[0].variant_id, None, "an empty variant is none");
}

#[tokio::test]
async fn po_numbers_are_new_and_well_formed() {
    let Some(db) = tenant() else {
        return;
    };
    let prefix = po_number_prefix(time::OffsetDateTime::now_utc().date());
    let numbers = generate_po_numbers(&db, 3).await.expect("numbers");
    assert_eq!(numbers.len(), 3);
    for number in &numbers {
        assert!(number.starts_with(&prefix), "{number}");
        assert_eq!(number.len(), prefix.len() + 4, "{number}");
        let used: i64 =
            sqlx::query_scalar("select count(*) from purchase_orders where po_number = $1")
                .bind(number)
                .fetch_one(&db)
                .await
                .expect("count");
        assert_eq!(used, 0);
    }
    assert_ne!(numbers[0], numbers[1]);
    assert_ne!(numbers[1], numbers[2]);
    assert_eq!(
        generate_po_numbers(&db, 0).await.expect("none"),
        Vec::<String>::new()
    );
    assert!(
        generate_po_number(&db)
            .await
            .expect("one")
            .starts_with(&prefix)
    );
}

#[tokio::test]
async fn totals_of_a_missing_purchase_order_are_none() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let gone = fx.order("gone", "draft", None, None, true).await;
    for id in [gone, fx.id("never")] {
        let row = recompute_po_totals(&db, &id, &crate::now())
            .await
            .expect("recompute");
        assert!(row.is_none(), "{id}");
    }
}

fn code(error: LedgerError) -> &'static str {
    match error {
        LedgerError::Stock { code, .. } => code,
        LedgerError::Database(error) => panic!("database: {error}"),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // every ledger entry point
async fn the_ledger_refuses_a_managed_warehouse_before_writing() {
    let Some(db) = tenant() else {
        return;
    };
    let fx = Fx::new(&db);
    let managed = fx.warehouse("wm", true).await;
    let open = fx.warehouse("wu", false).await;
    let product = fx.product("p", false).await;
    let lots = fx.product("pl", true).await;
    let bucket = fx.id("inv");
    fx.run(
        "insert into inventory (id, product_id, warehouse_id, quantity_on_hand, quantity_allocated, \
         quantity_available) values ($1, $2, $3, 10, 2, 8)",
        &[Some(&bucket), Some(&product), Some(&managed)],
    )
    .await;
    let change = |warehouse: &str, product: &str, delta: i64| StockChange {
        product_id: product.to_owned(),
        warehouse_id: warehouse.to_owned(),
        delta,
        kind: "received".to_owned(),
        ..StockChange::default()
    };

    let refused = [
        code(
            apply_stock_change(&db, &change(&managed, &product, 5))
                .await
                .expect_err("apply"),
        ),
        code(
            apply_stock_change(&db, &change(&managed, &product, -1))
                .await
                .expect_err("apply out"),
        ),
        code(
            check_receipt(&db, &change(&managed, &product, 5))
                .await
                .expect_err("check"),
        ),
        code(allocate_stock(&db, &bucket, 1).await.expect_err("allocate")),
        code(
            release_allocation(&db, &bucket, 1)
                .await
                .expect_err("release"),
        ),
        code(
            issue_allocated_stock(
                &db,
                &Issue {
                    inventory_id: &bucket,
                    quantity: 1,
                    source_id: "pl_x",
                    source_number: "PL-X",
                    reason: "ship".to_owned(),
                    performed_by: None,
                },
            )
            .await
            .expect_err("issue"),
        ),
        code(
            transfer_stock(
                &db,
                &Transfer {
                    product_id: product.clone(),
                    variant_id: None,
                    quantity: 1,
                    from: Endpoint {
                        warehouse_id: managed.clone(),
                        location_id: None,
                        lot_number: None,
                    },
                    to: Endpoint {
                        warehouse_id: open.clone(),
                        location_id: None,
                        lot_number: None,
                    },
                    reason: None,
                    notes: None,
                    performed_by: None,
                },
            )
            .await
            .err()
            .expect("transfer refused"),
        ),
    ];
    assert!(
        refused.iter().all(|code| *code == WAREHOUSE_MANAGED),
        "{refused:?}"
    );
    let left: (i32, i32) =
        sqlx::query_as("select quantity_on_hand, quantity_allocated from inventory where id = $1")
            .bind(&bucket)
            .fetch_one(&db)
            .await
            .expect("bucket");
    assert_eq!(left, (10, 2));
    let audit: i64 =
        sqlx::query_scalar("select count(*) from stock_adjustments where product_id = $1")
            .bind(&product)
            .fetch_one(&db)
            .await
            .expect("audit");
    assert_eq!(audit, 0);

    // An open warehouse: the receipt checks are the ledger's own.
    assert!(
        check_receipt(&db, &change(&open, &product, 5))
            .await
            .is_ok()
    );
    assert_eq!(
        code(
            check_receipt(&db, &change(&open, &lots, 5))
                .await
                .expect_err("lot")
        ),
        "LOT_REQUIRED"
    );
    assert_eq!(
        code(
            check_receipt(&db, &change(&open, &fx.id("nope"), 5))
                .await
                .expect_err("product")
        ),
        "PRODUCT_NOT_FOUND"
    );
    let posted = apply_stock_change(&db, &change(&open, &product, 5))
        .await
        .expect("open warehouse");
    assert_eq!(posted.new_quantity, 5);
}
