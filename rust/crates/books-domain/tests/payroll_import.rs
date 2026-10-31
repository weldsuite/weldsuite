//! `payroll::post_weldhr_import` on the real tenant schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`): what hr's in-process
//! call does in place of `POST /internal/payroll/imports`. A pay run posts
//! one balanced entry and one import row, a second post of the same run is a
//! duplicate, a reversed run can't post again, and the refusals answer as the
//! internal route does.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use serde_json::Value;
use weldsuite_books_domain::payroll::{
    WeldHrImport, WeldHrReply, WeldHrTotals, post_weldhr_import, reverse_payroll_import,
};
use weldsuite_db::master_pool;
use weldsuite_kit::generate_id;

fn run(entity_id: &str, external_id: &str) -> WeldHrImport {
    WeldHrImport {
        entity_id: entity_id.to_owned(),
        external_id: external_id.to_owned(),
        pay_date: "2026-04-25".to_owned(),
        period_start: Some("2026-04-01".to_owned()),
        period_end: Some("2026-04-30".to_owned()),
        description: "Salarisrun april".to_owned(),
        us: false,
        totals: WeldHrTotals {
            gross_wages: 5000.0,
            employer_taxes: 900.0,
            employer_benefits: 0.0,
            reimbursements: 25.5,
            employee_taxes: 1500.0,
            employee_deductions: 100.0,
            net_pay: 3400.0,
        },
        mapping: Vec::new(),
        posted_by: Some("user_hr".to_owned()),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn a_weldhr_pay_run_posts_once() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    let entity = generate_id("ent");
    let account = |code: &str| format!("{entity}_{code}");
    sqlx::query("insert into entities (id, name, jurisdiction_code, base_currency) values ($1, 'Loon BV', 'NL', 'EUR')")
        .bind(&entity)
        .execute(&db)
        .await
        .expect("entity");
    for (code, kind, subtype, role) in [
        (
            "4110",
            "expense",
            "operating_expense",
            Some("payroll_wages_expense"),
        ),
        (
            "4120",
            "expense",
            "operating_expense",
            Some("payroll_tax_expense"),
        ),
        (
            "4600",
            "expense",
            "operating_expense",
            Some("general_expense"),
        ),
        ("1800", "liability", "tax", Some("payroll_liabilities")),
        ("1100", "asset", "bank", None),
    ] {
        let metadata = role.map(|r| serde_json::json!({ "systemRole": r }));
        sqlx::query(
            "insert into accounts (id, entity_id, code, name, type, subtype, normal_side, metadata) \
             values ($1, $2, $3, $3, $4, $5, 'debit', $6)",
        )
        .bind(account(code))
        .bind(&entity)
        .bind(code)
        .bind(kind)
        .bind(subtype)
        .bind(metadata)
        .execute(&db)
        .await
        .expect("account");
    }

    let external = generate_id("prun");
    let reply = post_weldhr_import(&db, run(&entity, &external), Some("system"))
        .await
        .expect("posted");
    let WeldHrReply::Created { body, event } = reply else {
        panic!("expected a new import, got {reply:?}");
    };
    assert_eq!(body["duplicate"], Value::Bool(false));
    assert_eq!(event["source"], "weldhr");
    let import_id = body["importId"].as_str().expect("import id").to_owned();
    let entry_id = body["journalEntryId"]
        .as_str()
        .expect("entry id")
        .to_owned();

    let lines: Vec<(String, String, String)> = sqlx::query_as(
        "select account_id, debit::text, credit::text from journal_lines where journal_entry_id = $1 order by sort_order",
    )
    .bind(&entry_id)
    .fetch_all(&db)
    .await
    .expect("lines");
    let line = |code: &str| {
        lines
            .iter()
            .find(|(id, _, _)| *id == account(code))
            .map(|(_, d, c)| (d.clone(), c.clone()))
    };
    assert_eq!(
        line("4110"),
        Some(("5000.00".to_owned(), "0.00".to_owned()))
    );
    assert_eq!(line("4120"), Some(("900.00".to_owned(), "0.00".to_owned())));
    assert_eq!(line("4600"), Some(("25.50".to_owned(), "0.00".to_owned())));
    assert_eq!(
        line("1800"),
        Some(("0.00".to_owned(), "2500.00".to_owned()))
    );
    assert_eq!(
        line("1100"),
        Some(("0.00".to_owned(), "3425.50".to_owned()))
    );
    let (status, source): (String, String) =
        sqlx::query_as("select status, source from payroll_imports where id = $1")
            .bind(&import_id)
            .fetch_one(&db)
            .await
            .expect("import row");
    assert_eq!((status.as_str(), source.as_str()), ("posted", "weldhr"));

    // The same run again is a duplicate, not a second entry.
    let again = post_weldhr_import(&db, run(&entity, &external), Some("system"))
        .await
        .expect("duplicate");
    let WeldHrReply::Duplicate(body) = again else {
        panic!("expected a duplicate, got {again:?}");
    };
    assert_eq!(body["importId"], import_id.as_str());
    assert_eq!(body["journalEntryId"], entry_id.as_str());
    assert_eq!(body["status"], "posted");

    // Reversed in WeldBooks: not posted, and it can't be posted again.
    reverse_payroll_import(&db, &import_id, Some("user_books".to_owned()), None)
        .await
        .expect("reversed");
    let reversed = post_weldhr_import(&db, run(&entity, &external), Some("system"))
        .await
        .expect("refused");
    assert!(matches!(reversed, WeldHrReply::Reversed { .. }));

    // Refusals: unbalanced totals, an account of another entity, an unknown entity.
    let mut unbalanced = run(&entity, &generate_id("prun"));
    unbalanced.totals.net_pay = 3000.0;
    let refused = post_weldhr_import(&db, unbalanced, None)
        .await
        .expect("refused");
    assert!(
        matches!(refused, WeldHrReply::BadRequest(message) if message.starts_with("The payroll does not balance"))
    );
    let mut foreign = run(&entity, &generate_id("prun"));
    foreign.mapping = vec![("net_pay".to_owned(), "acc_elsewhere".to_owned())];
    let refused = post_weldhr_import(&db, foreign, None)
        .await
        .expect("refused");
    assert_eq!(
        refused,
        WeldHrReply::BadRequest(
            "The account mapped to net_pay does not belong to this accounting entity".to_owned()
        )
    );
    let missing = post_weldhr_import(&db, run("ent_missing", "prun_x"), None)
        .await
        .expect("refused");
    assert_eq!(missing, WeldHrReply::EntityNotFound);
}
