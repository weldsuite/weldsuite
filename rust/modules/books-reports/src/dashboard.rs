//! `/api/accounting-dashboard` (`routes/accounting-dashboard/index.ts`): the
//! WeldBooks dashboard's figures for one entity, in its base currency.
//! Revenue, expenses and profit (and the 12- and 24-month trends) are the
//! ledger's profit and loss on the entity's basis; receivables and payables
//! are the aged documents. Read-only.

use std::sync::Arc;

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};
use weldsuite_books_domain::dates::last_day_of_month;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now_ms, reply};
use weldsuite_books_domain::js::{days_from_civil, parse_float};
use weldsuite_books_domain::reports_basis::{
    DateRange, LedgerFilters, ReportColumn, create_ledger, iso, money, resolve_basis, today_for,
};
use weldsuite_books_domain::tables::{ENTITIES, INVOICES, PAYMENTS};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ordered::Json;
use crate::reports::build::{self, BuildError, balance_in_base};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(dashboard).route_layer(gate.require(["reports:read".to_owned()])),
        )
        .with_state(state)
}

/// `monthColumns(today, count)`: `YYYY-MM` columns for the last `count`
/// calendar months, ending with the month of `today`.
fn month_columns(today: &str, count: i64) -> Vec<ReportColumn> {
    let year: i64 = today.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = today.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    (0..count)
        .rev()
        .map(|i| {
            let index = year * 12 + (month - 1 - i);
            let (y, m) = (index.div_euclid(12), index.rem_euclid(12) + 1);
            let key = format!("{y:04}-{m:02}");
            ReportColumn {
                label: key.clone(),
                from: Some(format!("{key}-01")),
                to: last_day_of_month(y, m),
                key,
            }
        })
        .collect()
}

/// `{ id, name, iban, currentBalance, currency }` of a bank account.
type BankAccountRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn refusal(error: BuildError) -> Refusal {
    match error {
        BuildError::Input(error) => Refusal::Internal(error.0),
        BuildError::Database(error) => Refusal::Database(error),
        BuildError::Internal(error) => Refusal::Internal(error),
    }
}

async fn dashboard(caller: Caller) -> Response {
    reply(
        build_dashboard(&caller).await,
        "Failed to fetch dashboard data",
    )
}

#[allow(clippy::too_many_lines)] // the route's one handler
async fn build_dashboard(caller: &Caller) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let entity: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&entity_id)
    .fetch_optional(db)
    .await?;
    let Some(entity) = entity.map(|row| ENTITIES.js(row)) else {
        return Err(Refusal::not_found("Accounting entity", &entity_id));
    };
    let base_currency = entity
        .get("baseCurrency")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let now = now_ms();
    let today = today_for(entity.get("timezone").and_then(Value::as_str), now);
    let year: i64 = today.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = today.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    let month_start = days_from_civil(year, month, 1) * 86_400_000;

    // Revenue, expenses and profit: the ledger's profit and loss. The trend
    // runs 24 months so the dashboard can compare any range with the one
    // before it.
    let trend = month_columns(&today, 24);
    let year_column = ReportColumn {
        key: "year".to_owned(),
        label: year.to_string(),
        from: Some(format!("{year}-01-01")),
        to: format!("{year}-12-31"),
    };
    let basis = resolve_basis(
        db,
        entity.get("accountingMethod").and_then(Value::as_str),
        None,
    )
    .await?;
    let year_end = days_from_civil(year, 12, 31) * 86_400_000 + 86_399_999;
    let ledger = create_ledger(db, &entity_id, basis, LedgerFilters::default(), year_end).await?;
    let mut columns = trend.clone();
    columns.push(year_column.clone());
    let profit_loss = build::build_profit_loss(
        &ledger,
        &columns,
        &DateRange {
            from: trend[0].from.clone().unwrap_or_default(),
            to: year_column.to.clone(),
        },
    )
    .await
    .map_err(refusal)?;
    let revenue = profit_loss.total("totalRevenue");
    let expenses = profit_loss.total("totalExpenses");
    let profit = profit_loss.total("netProfit");
    let current_month = &trend[trend.len() - 1].key;

    // Posted standard invoices issued this month.
    let issued_this_month: i32 = sqlx::query_scalar(
        "select count(*)::int from invoices where entity_id = $1 and deleted_at is null \
         and issue_date >= $2::timestamp and type = 'standard' \
         and status not in ('draft', 'cancelled', 'void')",
    )
    .bind(&entity_id)
    .bind(iso(month_start))
    .fetch_one(db)
    .await?;

    // Receivables and payables: the aged reports' documents, in base currency.
    let aged_receivables = build::build_aged_report(db, &entity_id, true, &today)
        .await
        .map_err(refusal)?;
    let aged_payables = build::build_aged_report(db, &entity_id, false, &today)
        .await
        .map_err(refusal)?;
    let summarize = |report: &build::AgedReport| {
        let overdue: Vec<&build::AgedDocument> = report
            .documents
            .iter()
            .filter(|d| d.days_past_due > 0 && parse_float(&d.balance) > 0.0)
            .collect();
        Json::object([
            ("outstanding", Json::from(json!(report.total))),
            (
                "outstandingCount",
                Json::from(json!(report.documents.len())),
            ),
            (
                "overdue",
                Json::from(json!(money(
                    overdue.iter().fold(0.0, |t, d| t + parse_float(&d.balance))
                ))),
            ),
            ("overdueCount", Json::from(json!(overdue.len()))),
            ("aging", report.aging()),
        ])
    };

    // Bank balances (entity-scoped).
    let bank_accounts: Vec<BankAccountRow> = sqlx::query_as(
        "select id, name, iban, current_balance::text, currency from bank_accounts \
             where entity_id = $1 and deleted_at is null and is_active = true",
    )
    .bind(&entity_id)
    .fetch_all(db)
    .await?;

    // Recent payments (last 10).
    let recent_payments: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.entity_id = $1 and t.deleted_at is null \
         order by t.date desc limit 10"
    ))
    .bind(&entity_id)
    .fetch_all(db)
    .await?;

    // Upcoming due invoices (next 30 days): posted, no credit notes, in base
    // currency.
    let upcoming: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoices),
        " from invoices t where t.entity_id = $1 and t.deleted_at is null \
         and t.balance_due::numeric > 0 \
         and t.status not in ('draft', 'cancelled', 'void', 'paid', 'uncollectible', 'written_off') \
         and t.type not in ('credit_note', 'proforma') \
         and t.due_date <= $2::timestamp and t.due_date >= $3::timestamp \
         order by t.due_date limit 10"
    ))
    .bind(&entity_id)
    .bind(iso(now + 30 * 24 * 60 * 60 * 1000))
    .bind(iso(now))
    .fetch_all(db)
    .await?;
    let upcoming_due: Vec<Value> = upcoming
        .into_iter()
        .map(|row| {
            let row = INVOICES.js(row);
            let balance = weldsuite_books_domain::js::numeric(&row["balanceDue"]);
            json!({
                "id": row["id"],
                "invoiceNumber": row["invoiceNumber"],
                "contactName": row["contactName"],
                "dueDate": row["dueDate"],
                "balanceDue": money(balance_in_base(
                    balance,
                    row["currency"].as_str(),
                    row["exchangeRate"].as_str(),
                    &base_currency,
                )),
            })
        })
        .collect();

    // Pending documents.
    let pending_documents: i32 = sqlx::query_scalar(
        "select count(*)::int from documents where entity_id = $1 and deleted_at is null \
         and status in ('pending', 'processing', 'processed')",
    )
    .bind(&entity_id)
    .fetch_one(db)
    .await?;

    let value = |set: &build::ValueSet, key: &str| set.value(key).map_or(Value::Null, |v| json!(v));
    let last_twelve = &trend[trend.len() - 12..];
    let mut data = Json::from(json!({
        "currency": base_currency,
        "revenue": {
            "month": value(revenue, current_month),
            "year": value(revenue, "year"),
            "invoiceCount": issued_this_month,
        },
        "expenses": {
            "month": value(expenses, current_month),
            "year": value(expenses, "year"),
        },
        "profit": {
            "month": value(profit, current_month),
            "year": value(profit, "year"),
        },
        "bankAccounts": bank_accounts.into_iter().map(|(id, name, iban, balance, currency)| json!({
            "id": id,
            "name": name,
            "iban": iban,
            "currentBalance": balance,
            "currency": currency,
        })).collect::<Vec<_>>(),
        "recentPayments": PAYMENTS.js_rows(recent_payments),
        "upcomingDue": upcoming_due,
        "pendingDocuments": pending_documents,
        "monthlyRevenue": last_twelve.iter().map(|c| json!({
            "month": c.key,
            "total": value(revenue, &c.key),
        })).collect::<Vec<_>>(),
        "monthlyTrend": trend.iter().map(|c| json!({
            "month": c.key,
            "revenue": value(revenue, &c.key),
            "expenses": value(expenses, &c.key),
            "profit": value(profit, &c.key),
        })).collect::<Vec<_>>(),
    }));
    data.set("receivables", summarize(&aged_receivables));
    data.set("payables", summarize(&aged_payables));
    Ok(crate::ordered::ok(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_columns_end_with_this_month() {
        let columns = month_columns("2026-02-14", 3);
        let keys: Vec<&str> = columns.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["2025-12", "2026-01", "2026-02"]);
        assert_eq!(columns[2].to, "2026-02-28");
    }
}
