//! `GET /api/vat-returns/:id/checks` (Rust only, edition feature
//! `books-questions`): the loose ends of a return's period, listed in its
//! Check step before filing. Warnings only: nothing here blocks filing.
//!
//! One answer per check, `{ count, amount?, sampleIds[] }` (the sample is the
//! five oldest rows):
//!
//! | Key | What it counts |
//! |---|---|
//! | `unprocessed_bank_lines` | lines dated in the period still to book (a flagged duplicate is its own check) |
//! | `unbooked_documents` | inbox documents that arrived by the period end and are not booked |
//! | `missing_receipts` | lines in the period booked to an expense with VAT and no receipt |
//! | `possible_duplicates` | lines in the period flagged as a possible duplicate |
//! | `draft_invoices_in_period` | draft invoices dated in the period |
//! | `open_transfers` | transfers in transit not zero at the period end: lines booked to the transit account by the period end whose opposite amount is not booked |
//!
//! The first four are the To process queries
//! ([`weldsuite_books_domain::process_queries`]), so the two never disagree.
//! `amount` is the sum in the entity's base currency (bank lines have no rate:
//! only those on a base-currency account are summed; `mixedCurrency` says some
//! are not). A check the caller may not read (`banking:read` for the bank
//! lines and transfers, `invoices:read` for documents and drafts) answers
//! `{ count: 0, sampleIds: [], restricted: true }`.

use std::collections::HashMap;

use axum::extract::Path;
use axum::response::Response;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Condition, Expr};
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    Select,
};
use serde_json::{Map, Value, json};
use time::{Duration, PrimitiveDateTime, Time};
use weldsuite_books_domain::http::{Caller, Refusal, Reply, ok, reply};
use weldsuite_books_domain::posting::{account_for_role, load_entity_accounts};
use weldsuite_books_domain::process_queries::{
    Scope, Tally, aggregate, bank_line_amounts, duplicates, in_base, missing_receipts, to_book,
    unbooked_documents,
};
use weldsuite_books_domain::system_accounts::TRANSFERS_IN_TRANSIT;
use weldsuite_db::orm;
use weldsuite_schema::tenant::{bank_transactions, documents, invoices, vat_returns};

/// Ids in a check's sample.
const SAMPLE: u64 = 5;

/// One check's answer.
struct Check {
    count: i64,
    amount: Option<BigDecimal>,
    mixed: bool,
    sample_ids: Vec<String>,
}

impl Check {
    fn json(&self, base: &str) -> Value {
        let mut out = json!({ "count": self.count, "sampleIds": self.sample_ids });
        if let Some(amount) = &self.amount {
            out["amount"] = json!(amount.with_scale(2).to_plain_string());
            out["currency"] = json!(base);
            out["mixedCurrency"] = json!(self.mixed);
        }
        out
    }
}

fn restricted() -> Value {
    json!({ "count": 0, "sampleIds": [], "restricted": true })
}

/// The tally and the oldest rows of a selection.
async fn check_of<E: EntityTrait>(
    orm: &DatabaseConnection,
    rows: Select<E>,
    id: E::Column,
    order: E::Column,
    amount: Option<Expr>,
    foreign: Option<Expr>,
) -> Result<Check, DbErr> {
    let Tally {
        count,
        amount,
        mixed,
    } = aggregate(orm, rows.clone(), amount, foreign).await?;
    let sample_ids = rows
        .select_only()
        .column(id)
        .order_by_asc(order)
        .order_by_asc(id)
        .limit(SAMPLE)
        .into_tuple::<String>()
        .all(orm)
        .await?;
    Ok(Check {
        count,
        amount,
        mixed,
        sample_ids,
    })
}

/// The period as the columns hold it: from the start's midnight to the end of
/// the end day.
fn bounds(
    start: PrimitiveDateTime,
    end: PrimitiveDateTime,
) -> (PrimitiveDateTime, PrimitiveDateTime) {
    let from = PrimitiveDateTime::new(start.date(), Time::MIDNIGHT);
    let until = PrimitiveDateTime::new(end.date(), Time::MIDNIGHT) + Duration::days(1);
    (from, until)
}

fn dated_in(from: PrimitiveDateTime, until: PrimitiveDateTime) -> Condition {
    Condition::all()
        .add(bank_transactions::Column::Date.gte(from))
        .add(bank_transactions::Column::Date.lt(until))
}

/// Transfers booked to the transit account by `until` whose other half is not:
/// the lines are paired by opposite amounts (the way the transfer's two halves
/// are found), and the ones left over are open. The transit account's balance
/// at the period end is what they leave.
async fn open_transfers(
    db: &sea_orm::DatabaseConnection,
    pool: &sqlx::PgPool,
    entity_id: &str,
    until: PrimitiveDateTime,
) -> Result<Check, DbErr> {
    let none = Check {
        count: 0,
        amount: None,
        mixed: false,
        sample_ids: Vec::new(),
    };
    let accounts = load_entity_accounts(pool, entity_id).await?;
    let Some(transit) = account_for_role(&accounts, TRANSFERS_IN_TRANSIT, &[])
        .and_then(|account| account["id"].as_str())
    else {
        return Ok(none);
    };
    let lines: Vec<(String, BigDecimal, PrimitiveDateTime)> = bank_transactions::Entity::find()
        .select_only()
        .columns([
            bank_transactions::Column::Id,
            bank_transactions::Column::Amount,
            bank_transactions::Column::Date,
        ])
        .filter(bank_transactions::Column::EntityId.eq(entity_id))
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .filter(bank_transactions::Column::Status.eq("reconciled"))
        .filter(bank_transactions::Column::CategoryAccountId.eq(transit))
        .filter(bank_transactions::Column::Date.lt(until))
        .order_by_asc(bank_transactions::Column::Date)
        .order_by_asc(bank_transactions::Column::Id)
        .into_tuple()
        .all(db)
        .await?;
    // By absolute amount in cents: the lines out and the lines in.
    type Sides = (Vec<(String, BigDecimal)>, Vec<(String, BigDecimal)>);
    let mut by_amount: HashMap<String, Sides> = HashMap::new();
    let zero = BigDecimal::from(0);
    for (id, amount, _) in lines {
        let key = amount.abs().with_scale(2).to_plain_string();
        let sides = by_amount.entry(key).or_default();
        if amount < zero {
            sides.0.push((id, amount.abs()));
        } else {
            sides.1.push((id, amount));
        }
    }
    let mut open: Vec<(String, BigDecimal)> = Vec::new();
    for (mut out, mut incoming) in by_amount.into_values() {
        let paired = out.len().min(incoming.len());
        out.drain(..paired);
        incoming.drain(..paired);
        open.extend(out);
        open.extend(incoming);
    }
    // The oldest first, as the other checks' samples are: ids are time-ordered
    // enough for a sample, and the order is stable.
    open.sort_by(|a, b| a.0.cmp(&b.0));
    let total = open
        .iter()
        .fold(BigDecimal::from(0), |sum, (_, amount)| sum + amount);
    Ok(Check {
        count: i64::try_from(open.len()).unwrap_or(i64::MAX),
        amount: (!open.is_empty()).then_some(total),
        mixed: false,
        sample_ids: open
            .into_iter()
            .take(usize::try_from(SAMPLE).unwrap_or(5))
            .map(|(id, _)| id)
            .collect(),
    })
}

pub(crate) async fn checks(caller: Caller, Path(id): Path<String>) -> Response {
    reply(build(&caller, &id).await, "Failed to check the VAT return")
}

async fn build(caller: &Caller, id: &str) -> Reply {
    let db = orm(&caller.db);
    let Some(ret) = vat_returns::Entity::find()
        .filter(vat_returns::Column::Id.eq(id))
        .filter(vat_returns::Column::DeletedAt.is_null())
        .one(&db)
        .await?
    else {
        return Err(Refusal::not_found("VAT return", id));
    };
    let entity_id = ret.entity_id.clone();
    let base = crate::vat_returns::entity_row(&caller.db, &entity_id, true)
        .await?
        .and_then(|entity| entity["baseCurrency"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let scope = Scope::load(&caller.db, &entity_id).await?;
    let (from, until) = bounds(ret.period_start, ret.period_end);
    let banking = caller.can("banking:read");
    let invoicing = caller.can("invoices:read");

    let mut out = Map::new();
    let lines = |condition: Condition| {
        bank_transactions::Entity::find().filter(condition.add(dated_in(from, until)))
    };
    let (amount, foreign) = bank_line_amounts(&base);
    out.insert(
        "unprocessed_bank_lines".to_owned(),
        if banking {
            check_of(
                &db,
                lines(to_book(&scope)),
                bank_transactions::Column::Id,
                bank_transactions::Column::Date,
                Some(amount.clone()),
                Some(foreign.clone()),
            )
            .await?
            .json(&base)
        } else {
            restricted()
        },
    );
    out.insert(
        "unbooked_documents".to_owned(),
        if invoicing {
            check_of(
                &db,
                documents::Entity::find()
                    .filter(unbooked_documents(&scope).add(documents::Column::CreatedAt.lt(until))),
                documents::Column::Id,
                documents::Column::CreatedAt,
                None,
                None,
            )
            .await?
            .json(&base)
        } else {
            restricted()
        },
    );
    out.insert(
        "missing_receipts".to_owned(),
        if banking {
            check_of(
                &db,
                lines(missing_receipts(&scope)),
                bank_transactions::Column::Id,
                bank_transactions::Column::Date,
                Some(amount.clone()),
                Some(foreign.clone()),
            )
            .await?
            .json(&base)
        } else {
            restricted()
        },
    );
    out.insert(
        "possible_duplicates".to_owned(),
        if banking {
            check_of(
                &db,
                lines(duplicates(&scope)),
                bank_transactions::Column::Id,
                bank_transactions::Column::Date,
                Some(amount),
                Some(foreign),
            )
            .await?
            .json(&base)
        } else {
            restricted()
        },
    );
    out.insert(
        "draft_invoices_in_period".to_owned(),
        if invoicing {
            check_of(
                &db,
                invoices::Entity::find()
                    .filter(invoices::Column::EntityId.eq(entity_id.as_str()))
                    .filter(invoices::Column::DeletedAt.is_null())
                    .filter(invoices::Column::Status.eq("draft"))
                    .filter(invoices::Column::IssueDate.gte(from))
                    .filter(invoices::Column::IssueDate.lt(until)),
                invoices::Column::Id,
                invoices::Column::IssueDate,
                Some(in_base("invoices", "invoices.total", &base)),
                None,
            )
            .await?
            .json(&base)
        } else {
            restricted()
        },
    );
    out.insert(
        "open_transfers".to_owned(),
        if banking {
            open_transfers(&db, &caller.db, &entity_id, until)
                .await?
                .json(&base)
        } else {
            restricted()
        },
    );
    Ok(ok(Value::Object(out)))
}

/// The checks against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`,
/// built by `scripts/rust-test-db.ts`; the test returns early without it).
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "test fixtures are written in SQL; one scenario read top to bottom"
)]
mod db_tests {
    use sqlx::PgPool;
    use weldsuite_kit::generate_id;
    use weldsuite_permissions::{Permissions, ResolvedPermissions};

    use super::*;

    fn caller(db: &PgPool, entity: &str, keys: &[&str]) -> Caller {
        let mut caller =
            Caller::in_process(db.clone(), "ws_vat", "ws_vat", "user_vat", entity, None);
        caller.permissions = Permissions::new(
            ResolvedPermissions {
                permissions: keys.iter().map(|k| (*k).to_owned()).collect(),
                ..ResolvedPermissions::default()
            },
            None,
            false,
            "user_vat".to_owned(),
        );
        caller
    }

    async fn run(db: &PgPool, sql: &'static str, binds: &[&str]) {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(*bind);
        }
        query.execute(db).await.unwrap();
    }

    async fn answer(caller: &Caller, id: &str) -> (u16, Value) {
        let response = reply(build(caller, id).await, "Failed");
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn a_return_lists_the_loose_ends_of_its_period_as_warnings() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let db = weldsuite_db::master_pool(&url, 2).unwrap();
        let entity = generate_id("ent");
        let other = generate_id("ent");
        for id in [&entity, &other] {
            run(
                &db,
                "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
                 values ($1, 'VAT check', 'NL', 'EUR', true)",
                &[id],
            )
            .await;
        }
        let bank = generate_id("bac");
        run(
            &db,
            "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')",
            &[&bank, &entity],
        )
        .await;
        let transit = generate_id("acc");
        sqlx::query(
            "insert into accounts (id, entity_id, code, name, type, normal_side, metadata) \
             values ($1, $2, '1250', 'Kruisposten', 'asset', 'debit', '{\"systemRole\":\"transfers_in_transit\"}'::jsonb)",
        )
        .bind(&transit)
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        // The period is a quarter that ended 10 days ago.
        let vat = generate_id("vat");
        sqlx::query(
            "insert into vat_returns (id, entity_id, period_type, period_start, period_end, period_label, status) \
             values ($1, $2, 'quarterly', current_date - 100, current_date - 10, 'Q', 'calculated')",
        )
        .bind(&vat)
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        let line = async |days: i32,
                          amount: &str,
                          status: &str,
                          duplicate: bool,
                          category: Option<&str>| {
            let id = generate_id("btx");
            let original = duplicate.then(|| generate_id("btx"));
            sqlx::query(
                "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
                   status, possible_duplicate_of_id, category_account_id) \
                 values ($1, $2, $3, current_date + $4::int, $5::numeric, 'x', $6, $7, $8)",
            )
            .bind(&id)
            .bind(&entity)
            .bind(&bank)
            .bind(days)
            .bind(amount)
            .bind(status)
            .bind(original)
            .bind(category)
            .execute(&db)
            .await
            .unwrap();
            id
        };
        let early = line(-50, "-10.00", "unreconciled", false, None).await;
        let late = line(-20, "-5.50", "unreconciled", false, None).await;
        // After the period.
        line(-5, "-99.00", "unreconciled", false, None).await;
        let duplicate = line(-30, "-7.00", "unreconciled", true, None).await;
        // Transfers: a pair that nets to zero, and a half still in transit.
        line(-60, "-50.00", "reconciled", false, Some(&transit)).await;
        line(-59, "50.00", "reconciled", false, Some(&transit)).await;
        let half = line(-40, "-30.00", "reconciled", false, Some(&transit)).await;
        sqlx::query(
            "insert into documents (id, entity_id, type, file_name, file_key, source, status, created_at) \
             values ($1, $2, 'purchase_invoice', 'a.pdf', 'k', 'upload', 'pending', current_date - 30)",
        )
        .bind(generate_id("doc"))
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        // A document that arrived after the period end is the next period's.
        run(
            &db,
            "insert into documents (id, entity_id, type, file_name, file_key, source, status) \
             values ($1, $2, 'purchase_invoice', 'b.pdf', 'k', 'upload', 'pending')",
            &[&generate_id("doc"), &entity],
        )
        .await;
        let draft = generate_id("inv");
        sqlx::query(
            "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
               issue_date, due_date, currency, total, amount_paid, balance_due) \
             values ($1, $2, 'D-1', 'standard', 'draft', 'pty_x', 'Acme', current_date - 40, current_date, 'EUR', 121, 0, 121)",
        )
        .bind(&draft)
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        run(
            &db,
            "insert into invoices (id, entity_id, invoice_number, type, status, contact_id, contact_name, \
               issue_date, due_date, currency, total, amount_paid, balance_due) \
             values ($1, $2, 'D-2', 'standard', 'draft', 'pty_x', 'Acme', current_date, current_date, 'EUR', 5, 0, 5)",
            &[&generate_id("inv"), &entity],
        )
        .await;
        // The same loose ends in another entity stay out.
        let other_bank = generate_id("bac");
        run(
            &db,
            "insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')",
            &[&other_bank, &other],
        )
        .await;
        run(
            &db,
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, status) \
             values ($1, $2, $3, current_date - 50, '-1.00', 'unreconciled')",
            &[&generate_id("btx"), &other, &other_bank],
        )
        .await;

        let all = ["reports:read", "banking:read", "invoices:read"];
        let (status, out) = answer(&caller(&db, &entity, &all), &vat).await;
        assert_eq!(status, 200, "{out}");
        let checks = &out["data"];
        let count = |key: &str| checks[key]["count"].as_i64().unwrap();
        assert_eq!(count("unprocessed_bank_lines"), 2);
        assert_eq!(
            checks["unprocessed_bank_lines"]["sampleIds"],
            json!([early, late])
        );
        assert_eq!(checks["unprocessed_bank_lines"]["amount"], "15.50");
        assert_eq!(checks["unprocessed_bank_lines"]["currency"], "EUR");
        assert_eq!(count("possible_duplicates"), 1);
        assert_eq!(
            checks["possible_duplicates"]["sampleIds"],
            json!([duplicate])
        );
        assert_eq!(count("unbooked_documents"), 1);
        assert!(checks["unbooked_documents"].get("amount").is_none());
        assert_eq!(count("missing_receipts"), 0);
        assert_eq!(checks["missing_receipts"]["sampleIds"], json!([]));
        assert_eq!(count("draft_invoices_in_period"), 1);
        assert_eq!(
            checks["draft_invoices_in_period"]["sampleIds"],
            json!([draft])
        );
        assert_eq!(checks["draft_invoices_in_period"]["amount"], "121.00");
        assert_eq!(count("open_transfers"), 1);
        assert_eq!(checks["open_transfers"]["sampleIds"], json!([half]));
        assert_eq!(checks["open_transfers"]["amount"], "30.00");

        // What the caller may not read is marked, not counted.
        let (_, narrow) = answer(
            &caller(&db, &entity, &["reports:read", "invoices:read"]),
            &vat,
        )
        .await;
        assert_eq!(narrow["data"]["unprocessed_bank_lines"]["restricted"], true);
        assert_eq!(narrow["data"]["open_transfers"]["count"], 0);
        assert_eq!(narrow["data"]["unbooked_documents"]["count"], 1);
        // An unknown return is a 404.
        let (status, _) = answer(&caller(&db, &entity, &all), "vat_missing").await;
        assert_eq!(status, 404);
    }
}
