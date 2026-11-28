//! `GET /api/accounting-entities/:id/lock-date-suggestion` (Rust only, edition
//! feature `books-questions`): the date a period could be locked at, as
//! Moneybird suggests it, so nothing still to process ends up behind the lock.
//!
//! `{ suggestedDate, reason, blockingItem? }`:
//!
//! - **`suggestedDate`** is the day before the oldest open item, `YYYY-MM-DD`:
//!   an unprocessed bank line (by its date), an unbooked inbox document (by
//!   the day it arrived), a draft invoice or a draft bill (by their issue
//!   date). Those are the To process queries
//!   ([`weldsuite_books_domain::process_queries`]) and the entity's drafts.
//! - With nothing open it is the end of the last full month in the entity's
//!   time zone, reason `end_of_last_month`.
//! - **`reason`**: `oldest_unprocessed_bank_line`, `oldest_unbooked_document`,
//!   `oldest_draft_invoice`, `oldest_draft_bill` or `end_of_last_month`.
//! - **`blockingItem`** (not with `end_of_last_month`): `{ kind, objectType,
//!   objectId, date }`, the item the date is the day before of; `kind` is
//!   `bank_line`, `document`, `draft_invoice` or `draft_bill`, `objectType` the
//!   object panel's type.
//!
//! It only suggests: the lock dates are set with `PATCH /:id/lock-dates`. The
//! route needs `entities:update`, the permission that sets them.

use axum::extract::Path;
use axum::response::Response;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::{Date, Month, PrimitiveDateTime};
use weldsuite_books_domain::http::{Caller, Refusal, Reply, ok, reply};
use weldsuite_books_domain::process_queries::{Scope, bank_lines, unbooked_documents};
use weldsuite_schema::tenant::{bank_transactions, bills, documents, invoices};

use super::find_active;
use crate::entity_setup::today_in;

/// One open item: where it is and when it is dated.
struct Open {
    kind: &'static str,
    object_type: &'static str,
    reason: &'static str,
    id: String,
    date: PrimitiveDateTime,
}

/// `YYYY-MM-DD`.
fn day(date: Date) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

/// The last day of the month before the one `today` (`YYYY-MM-DD`) is in.
fn end_of_last_month(today: &str) -> Option<Date> {
    let mut parts = today.split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let first = Date::from_calendar_date(year, Month::try_from(month).ok()?, 1).ok()?;
    first.previous_day()
}

/// The suggestion for what the open items are (the oldest first wins; on the
/// same day a bank line, then a document, a draft invoice and a draft bill).
fn suggest(open: Vec<Open>, today: &str) -> Option<Value> {
    let oldest = open.into_iter().min_by_key(|item| item.date.date());
    match oldest {
        Some(item) => Some(json!({
            "suggestedDate": day(item.date.date().previous_day()?),
            "reason": item.reason,
            "blockingItem": {
                "kind": item.kind,
                "objectType": item.object_type,
                "objectId": item.id,
                "date": day(item.date.date()),
            },
        })),
        None => Some(json!({
            "suggestedDate": day(end_of_last_month(today)?),
            "reason": "end_of_last_month",
        })),
    }
}

pub(super) async fn lock_date_suggestion(caller: Caller, Path(id): Path<String>) -> Response {
    reply(build(&caller, &id).await, "Failed to suggest a lock date")
}

async fn build(caller: &Caller, id: &str) -> Reply {
    let Some(entity) = find_active(caller, id).await? else {
        return Err(Refusal::not_found("Entity", id));
    };
    let scope = Scope::load(&caller.db, id).await?;
    let db = weldsuite_db::orm(&caller.db);
    let mut open: Vec<Open> = Vec::new();

    let line: Option<(String, PrimitiveDateTime)> = bank_transactions::Entity::find()
        .select_only()
        .columns([
            bank_transactions::Column::Id,
            bank_transactions::Column::Date,
        ])
        .filter(bank_lines(&scope))
        .order_by_asc(bank_transactions::Column::Date)
        .order_by_asc(bank_transactions::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if let Some((id, date)) = line {
        open.push(Open {
            kind: "bank_line",
            object_type: "bank_transaction",
            reason: "oldest_unprocessed_bank_line",
            id,
            date,
        });
    }
    let document: Option<(String, PrimitiveDateTime)> = documents::Entity::find()
        .select_only()
        .columns([documents::Column::Id, documents::Column::CreatedAt])
        .filter(unbooked_documents(&scope))
        .order_by_asc(documents::Column::CreatedAt)
        .order_by_asc(documents::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if let Some((id, date)) = document {
        open.push(Open {
            kind: "document",
            object_type: "accounting_document",
            reason: "oldest_unbooked_document",
            id,
            date,
        });
    }
    let invoice: Option<(String, PrimitiveDateTime)> = invoices::Entity::find()
        .select_only()
        .columns([invoices::Column::Id, invoices::Column::IssueDate])
        .filter(invoices::Column::EntityId.eq(id))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::Status.eq("draft"))
        .order_by_asc(invoices::Column::IssueDate)
        .order_by_asc(invoices::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if let Some((id, date)) = invoice {
        open.push(Open {
            kind: "draft_invoice",
            object_type: "invoice",
            reason: "oldest_draft_invoice",
            id,
            date,
        });
    }
    let bill: Option<(String, PrimitiveDateTime)> = bills::Entity::find()
        .select_only()
        .columns([bills::Column::Id, bills::Column::IssueDate])
        .filter(bills::Column::EntityId.eq(id))
        .filter(bills::Column::DeletedAt.is_null())
        .filter(bills::Column::Status.eq("draft"))
        .order_by_asc(bills::Column::IssueDate)
        .order_by_asc(bills::Column::Id)
        .into_tuple()
        .one(&db)
        .await?;
    if let Some((id, date)) = bill {
        open.push(Open {
            kind: "draft_bill",
            object_type: "bill",
            reason: "oldest_draft_bill",
            id,
            date,
        });
    }
    let today = today_in(entity.get("timezone").and_then(Value::as_str));
    suggest(open, &today)
        .map(ok)
        .ok_or_else(|| Refusal::Database(DbErr::Custom("no date to suggest".to_owned())))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "fixtures")]
mod tests {
    use super::*;

    fn item(kind: &'static str, reason: &'static str, id: &str, at: &str) -> Open {
        let date = Date::parse(
            at,
            &time::macros::format_description!("[year]-[month]-[day]"),
        )
        .unwrap();
        Open {
            kind,
            object_type: "x",
            reason,
            id: id.to_owned(),
            date: PrimitiveDateTime::new(date, time::Time::from_hms(14, 30, 0).unwrap()),
        }
    }

    #[test]
    fn the_day_before_the_oldest_open_item() {
        let out = suggest(
            vec![
                item("document", "oldest_unbooked_document", "d1", "2026-10-20"),
                item(
                    "bank_line",
                    "oldest_unprocessed_bank_line",
                    "b1",
                    "2026-10-03",
                ),
                item("draft_bill", "oldest_draft_bill", "k1", "2026-11-01"),
            ],
            "2026-11-28",
        )
        .unwrap();
        assert_eq!(out["suggestedDate"], "2026-10-02");
        assert_eq!(out["reason"], "oldest_unprocessed_bank_line");
        assert_eq!(out["blockingItem"]["objectId"], "b1");
        assert_eq!(out["blockingItem"]["date"], "2026-10-03");
    }

    #[test]
    fn the_first_of_a_month_suggests_the_last_day_of_the_one_before() {
        let out = suggest(
            vec![item(
                "draft_invoice",
                "oldest_draft_invoice",
                "i1",
                "2026-01-01",
            )],
            "2026-11-28",
        )
        .unwrap();
        assert_eq!(out["suggestedDate"], "2025-12-31");
    }

    #[test]
    fn with_nothing_open_it_is_the_end_of_the_last_full_month() {
        let out = suggest(Vec::new(), "2026-11-28").unwrap();
        assert_eq!(out["suggestedDate"], "2026-10-31");
        assert_eq!(out["reason"], "end_of_last_month");
        assert!(out.get("blockingItem").is_none());
        // Across a year, and in a leap year's March.
        assert_eq!(
            suggest(Vec::new(), "2027-01-05").unwrap()["suggestedDate"],
            "2026-12-31"
        );
        assert_eq!(
            suggest(Vec::new(), "2028-03-01").unwrap()["suggestedDate"],
            "2028-02-29"
        );
    }
}

/// The suggestion against the real tenant schema (`WELDSUITE_TEST_TENANT_URL`;
/// the test returns early without it).
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

    use super::*;

    async fn suggestion(db: &PgPool, entity: &str) -> Value {
        let caller =
            Caller::in_process(db.clone(), "ws_lock", "ws_lock", "user_lock", entity, None);
        let response = reply(build(&caller, entity).await, "Failed");
        assert_eq!(response.status().as_u16(), 200);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice::<Value>(&bytes).unwrap()["data"].clone()
    }

    #[tokio::test]
    async fn the_suggestion_is_the_day_before_the_oldest_open_item() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
            eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
            return;
        };
        let db = weldsuite_db::master_pool(&url, 2).unwrap();
        let entity = generate_id("ent");
        sqlx::query(
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
             values ($1, 'Lock suggestion', 'NL', 'EUR', true)",
        )
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "insert into accounting_entity_settings (id, entity_id, enabled) values ($1, $2, true)",
        )
        .bind(generate_id("aes"))
        .bind(&entity)
        .execute(&db)
        .await
        .ok();

        // Nothing open: the end of the last full month.
        let empty = suggestion(&db, &entity).await;
        assert_eq!(empty["reason"], "end_of_last_month");
        assert!(empty.get("blockingItem").is_none());
        let date = empty["suggestedDate"].as_str().unwrap();
        let today: (String, String) = sqlx::query_as(
            "select to_char(date_trunc('month', now()) - interval '1 day', 'YYYY-MM-DD'), 'x'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(date, today.0);

        // A draft bill dated in 2026-03 and a bank line in 2026-05: the bill is older.
        let bank = generate_id("bac");
        sqlx::query("insert into bank_accounts (id, entity_id, name, currency) values ($1, $2, 'Bank', 'EUR')")
            .bind(&bank)
            .bind(&entity)
            .execute(&db)
            .await
            .unwrap();
        let line = generate_id("btx");
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, status) \
             values ($1, $2, $3, '2026-05-10', '-1.00', 'unreconciled')",
        )
        .bind(&line)
        .bind(&entity)
        .bind(&bank)
        .execute(&db)
        .await
        .unwrap();
        let first = suggestion(&db, &entity).await;
        assert_eq!(first["suggestedDate"], "2026-05-09");
        assert_eq!(first["reason"], "oldest_unprocessed_bank_line");
        assert_eq!(first["blockingItem"]["kind"], "bank_line");
        assert_eq!(first["blockingItem"]["objectType"], "bank_transaction");
        assert_eq!(first["blockingItem"]["objectId"], json!(line));
        assert_eq!(first["blockingItem"]["date"], "2026-05-10");

        let bill = generate_id("bil");
        sqlx::query(
            "insert into bills (id, entity_id, bill_number, type, status, contact_id, contact_name, \
               issue_date, due_date, currency, total, amount_paid, balance_due) \
             values ($1, $2, 'B-1', 'standard', 'draft', 'pty_x', 'Acme', '2026-03-01', '2026-04-01', 'EUR', 1, 0, 1)",
        )
        .bind(&bill)
        .bind(&entity)
        .execute(&db)
        .await
        .unwrap();
        let second = suggestion(&db, &entity).await;
        assert_eq!(second["suggestedDate"], "2026-02-28");
        assert_eq!(second["reason"], "oldest_draft_bill");
        assert_eq!(second["blockingItem"]["objectType"], "bill");

        // Once the bill is booked and the line processed, the older of what is left.
        sqlx::query("update bills set status = 'approved' where id = $1")
            .bind(&bill)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("insert into documents (id, entity_id, type, file_name, file_key, source, status, created_at) values ($1, $2, 'purchase_invoice', 'a.pdf', 'k', 'upload', 'pending', '2026-04-15')")
            .bind(generate_id("doc"))
            .bind(&entity)
            .execute(&db)
            .await
            .unwrap();
        let third = suggestion(&db, &entity).await;
        assert_eq!(third["suggestedDate"], "2026-04-14");
        assert_eq!(third["blockingItem"]["kind"], "document");
        sqlx::query("update bank_transactions set status = 'reconciled' where id = $1")
            .bind(&line)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update documents set status = 'linked' where entity_id = $1")
            .bind(&entity)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            suggestion(&db, &entity).await["reason"],
            "end_of_last_month"
        );
    }
}
