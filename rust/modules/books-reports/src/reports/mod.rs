//! `/api/accounting-reports` (`routes/accounting-reports/index.ts`): the
//! financial reports of one accounting entity, from posted journal entries,
//! on accrual or cash basis, as JSON, CSV or a print document. Read-only.
//!
//! Shared query parameters: `basis`, `from` / `to` / `asOf`, `compare`,
//! `periods` (profit and loss), `classId` / `locationId`, `format`.

pub(crate) mod build;
pub(crate) mod cash_flow;
pub(crate) mod export;
pub(crate) mod worksheet;

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Query, Refusal, ok};
use weldsuite_books_domain::js::{parse_float, parse_int};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::reports_basis::{
    Basis, CompareMode, DateRange, Edge, LedgerFilters, LedgerRange, ReportInputError,
    create_ledger, fiscal_year_containing, fiscal_year_named, money, parse_basis, parse_compare,
    parse_periods, parse_report_date, period_columns, point_in_time_columns, prior_period_of,
    prior_year_of, require_iso_date, resolve_basis, resolve_period, split_columns, today_for,
};
use weldsuite_books_domain::tables::ENTITIES;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use build::{BuildError, delta_of, latest_date};
use export::{Meta, Table, TableColumn, TableRow};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["reports:read".to_owned()]);
    Router::new()
        .route("/profit-loss", get(profit_loss).route_layer(read()))
        .route("/balance-sheet", get(balance_sheet).route_layer(read()))
        .route("/trial-balance", get(trial_balance).route_layer(read()))
        .route(
            "/aged-receivables",
            get(aged_receivables).route_layer(read()),
        )
        .route("/aged-payables", get(aged_payables).route_layer(read()))
        .route("/vat-summary", get(vat_summary).route_layer(read()))
        .route("/general-ledger", get(general_ledger).route_layer(read()))
        .route("/cash-flow", get(cash_flow_report).route_layer(read()))
        .route(
            "/revenue-by-customer",
            get(revenue_by_customer).route_layer(read()),
        )
        .route(
            "/expense-by-category",
            get(expense_by_category).route_layer(read()),
        )
        .route("/tax-worksheet", get(tax_worksheet).route_layer(read()))
        .with_state(state)
}

/// Why a report was not built: the route's `failure(c, err, name)`.
enum Failure {
    Input(String),
    EntityNotFound(String),
    Refusal(Refusal),
}

impl From<ReportInputError> for Failure {
    fn from(error: ReportInputError) -> Self {
        Self::Input(error.0)
    }
}

impl From<BuildError> for Failure {
    fn from(error: BuildError) -> Self {
        match error {
            BuildError::Input(error) => Self::Input(error.0),
            BuildError::Database(error) => Self::Refusal(Refusal::Database(error)),
            BuildError::Internal(error) => Self::Refusal(Refusal::Internal(error)),
        }
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<Refusal> for Failure {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

fn answer(result: Result<Response, Failure>, name: &str) -> Response {
    match result {
        Ok(response) => response,
        Err(Failure::Input(message)) => Refusal::bad_request(message).respond(""),
        Err(Failure::EntityNotFound(id)) => Refusal::not_found("Entity", &id).respond(""),
        Err(Failure::Refusal(refusal)) => {
            refusal.respond(&format!("Failed to generate {name} report"))
        }
    }
}

/// `Format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    Csv,
    Print,
}

/// `ReportContext`.
struct Context {
    entity: Value,
    entity_id: String,
    basis: Basis,
    format: Format,
    filters: LedgerFilters,
    query: Query,
    /// `Date.now()` of the request (the test's faked clock in conformance).
    now: i64,
}

impl Context {
    fn get(&self, key: &str) -> Option<&str> {
        self.query.get(key)
    }

    fn entity_text(&self, key: &str) -> Option<&str> {
        self.entity.get(key).and_then(Value::as_str)
    }

    fn timezone(&self) -> Option<&str> {
        self.entity_text("timezone")
    }

    fn today(&self) -> String {
        today_for(self.timezone(), self.now)
    }
}

/// `reportContext(c, { basis })`.
async fn report_context(caller: &Caller, with_basis: bool) -> Result<Context, Failure> {
    let db = &caller.db;
    let query = caller.query();
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Failure::Input("No accounting entity resolved".to_owned()));
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
        return Err(Failure::EntityNotFound(entity_id));
    };
    let format = match query.get("format").unwrap_or("json") {
        "json" => Format::Json,
        "csv" => Format::Csv,
        "print" => Format::Print,
        _ => {
            return Err(Failure::Input(
                "format must be 'json', 'csv' or 'print'".to_owned(),
            ));
        }
    };
    let basis = if with_basis {
        let requested = parse_basis(query.get("basis"))?;
        resolve_basis(
            db,
            entity.get("accountingMethod").and_then(Value::as_str),
            requested,
        )
        .await?
    } else {
        Basis::Accrual
    };
    let filters = LedgerFilters {
        class_id: query.present("classId").map(str::to_owned),
        location_id: query.present("locationId").map(str::to_owned),
    };
    Ok(Context {
        now: caller.now_ms(),
        entity,
        entity_id,
        basis,
        format,
        filters,
        query,
    })
}

/// What `respond(c, ctx, args)` lays out.
struct Answer<'a> {
    table: &'a dyn Fn() -> Table,
    period_label: String,
    filename: String,
    json: crate::ordered::Json,
    show_basis: bool,
}

/// `respond(c, ctx, args)`: the JSON, the CSV download or the print document.
fn respond(ctx: &Context, answer: &Answer<'_>) -> Response {
    if ctx.format == Format::Json {
        return crate::ordered::ok(&answer.json);
    }
    let table = (answer.table)();
    let meta = Meta {
        entity_name: ctx.entity_text("name").unwrap_or_default(),
        basis: answer.show_basis.then(|| ctx.basis.as_str()),
        period_label: &answer.period_label,
        currency: ctx.entity_text("baseCurrency").unwrap_or_default(),
    };
    if ctx.format == Format::Csv {
        return export::csv_response(
            export::to_csv(&table, &meta),
            &format!("{}.csv", answer.filename),
        );
    }
    ok(export::print_document(&table, &meta, &ctx.entity))
}

fn range_label(range: &DateRange) -> String {
    format!("Period: {} to {}", range.from, range.to)
}

async fn ledger_for(
    ctx: &Context,
    caller: &Caller,
    up_to: i64,
) -> Result<weldsuite_books_domain::reports_basis::Ledger, Failure> {
    Ok(create_ledger(
        &caller.db,
        &ctx.entity_id,
        ctx.basis,
        ctx.filters.clone(),
        up_to,
    )
    .await?)
}

/// `periodArgs(entity, query, { periods })`.
fn period_args(
    ctx: &Context,
    allow_periods: bool,
) -> Result<
    (
        DateRange,
        Vec<weldsuite_books_domain::reports_basis::ReportColumn>,
    ),
    Failure,
> {
    let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
    let compare = parse_compare(ctx.get("compare"))?;
    let periods = if allow_periods {
        parse_periods(ctx.get("periods"))?
    } else {
        None
    };
    if compare.is_some() && periods.is_some() {
        return Err(Failure::Input(
            "Use either compare or periods, not both".to_owned(),
        ));
    }
    let columns = match periods {
        Some(mode) => split_columns(&ctx.entity, &range, mode)?,
        None => period_columns(&ctx.entity, &range, compare)?,
    };
    Ok((range, columns))
}

// ── GET /profit-loss ─────────────────────────────────────────────────────────

async fn profit_loss(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let (range, columns) = period_args(&ctx, true)?;
        let ledger = ledger_for(&ctx, &caller, latest_date(&columns)?).await?;
        let report = build::build_profit_loss(&ledger, &columns, &range).await?;
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::profit_loss_table(&report),
                period_label: range_label(&range),
                filename: format!("profit-and-loss-{}_{}", range.from, range.to),
                json: report.json().into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "profit & loss")
}

// ── GET /balance-sheet ───────────────────────────────────────────────────────

async fn balance_sheet(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let as_of = match ctx.query.present("asOf") {
            Some(value) => require_iso_date(value, "asOf")?,
            None => ctx.today(),
        };
        let compare = parse_compare(ctx.get("compare"))?;
        let period_start = ctx
            .query
            .present("from")
            .map(|value| require_iso_date(value, "from"))
            .transpose()?;
        let columns = point_in_time_columns(&as_of, compare, period_start.as_deref())?;
        let ledger = ledger_for(&ctx, &caller, latest_date(&columns)?).await?;
        let report = build::build_balance_sheet(&ledger, &columns, |date| {
            fiscal_year_containing(&ctx.entity, date).map(|r| r.from)
        })
        .await?;
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::balance_sheet_table(&report),
                period_label: format!("As of {as_of}"),
                filename: format!("balance-sheet-{as_of}"),
                json: report.json().into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "balance sheet")
}

// ── GET /trial-balance ───────────────────────────────────────────────────────

async fn trial_balance(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let (range, columns) = period_args(&ctx, false)?;
        let ledger = ledger_for(&ctx, &caller, latest_date(&columns)?).await?;
        let report = build::build_trial_balance(&ledger, &columns, &range).await?;
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::trial_balance_table(&report),
                period_label: range_label(&range),
                filename: format!("trial-balance-{}_{}", range.from, range.to),
                json: report.json().into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "trial balance")
}

// ── GET /aged-receivables, /aged-payables ────────────────────────────────────

async fn aged_receivables(caller: Caller) -> Response {
    answer(aged(&caller, true).await, "aged receivables")
}

async fn aged_payables(caller: Caller) -> Response {
    answer(aged(&caller, false).await, "aged payables")
}

async fn aged(caller: &Caller, receivables: bool) -> Result<Response, Failure> {
    let ctx = report_context(caller, false).await?;
    let as_of = match ctx.query.present("asOf") {
        Some(value) => require_iso_date(value, "asOf")?,
        None => ctx.today(),
    };
    let report = build::build_aged_report(&caller.db, &ctx.entity_id, receivables, &as_of).await?;
    let mut json = report.json();
    if !receivables {
        // Aged payables answer plain strings per bucket, the counts next to them.
        json.set("buckets", report.buckets_ordered(|total, _| json!(total)));
        json.set(
            "bucketCounts",
            report.buckets_ordered(|_, count| json!(count)),
        );
    }
    let kind = if receivables {
        "receivables"
    } else {
        "payables"
    };
    Ok(respond(
        &ctx,
        &Answer {
            table: &|| export::aged_table(&report, receivables),
            period_label: format!("As of {as_of}"),
            filename: format!("aged-{kind}-{as_of}"),
            json,
            show_basis: false,
        },
    ))
}

// ── GET /vat-summary ─────────────────────────────────────────────────────────

type TaxRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Value>,
    String,
);

async fn vat_summary(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, false).await?;
        let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
        let from = parse_report_date(&range.from, Edge::Start)?;
        let to = parse_report_date(&range.to, Edge::End)?;
        let rows: Vec<TaxRow> = sqlx::query_as(
            "select jl.tax_rate_id, tr.name, tr.rate::text, tr.tax_category_code, \
             tr.jurisdiction_metadata, coalesce(sum(jl.tax_amount::numeric), 0)::text \
             from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id \
             left join tax_rates tr on jl.tax_rate_id = tr.id \
             where jl.entity_id = $1 and jl.deleted_at is null \
             and je.status in ('posted', 'reversed') and je.date >= $2::timestamp \
             and je.date <= $3::timestamp and jl.tax_rate_id is not null \
             group by jl.tax_rate_id, tr.name, tr.rate, tr.tax_category_code, tr.jurisdiction_metadata",
        )
        .bind(&ctx.entity_id)
        .bind(weldsuite_books_domain::reports_basis::iso(from))
        .bind(weldsuite_books_domain::reports_basis::iso(to))
        .fetch_all(&caller.db)
        .await?;
        let table = || Table {
            report: "tax_summary",
            title: "Tax summary".to_owned(),
            has_code: false,
            columns: vec![
                TableColumn::new("rate", "Rate", true),
                TableColumn::new("tax", "Tax", true),
            ],
            rows: rows
                .iter()
                .map(|(id, name, rate, _, _, total)| {
                    TableRow::new(
                        "account",
                        0,
                        name.clone().or_else(|| id.clone()).unwrap_or_default(),
                    )
                    .value("rate", rate.clone().map_or(Value::Null, Value::String))
                    .value("tax", money(parse_float(total)))
                })
                .collect(),
            notes: Vec::new(),
        };
        let breakdown: Vec<Value> = rows
            .iter()
            .map(|(id, name, rate, category, metadata, total)| {
                json!({
                    "taxRateId": id,
                    "taxRateName": name,
                    "rate": rate,
                    "taxCategoryCode": category,
                    "jurisdictionMetadata": metadata,
                    "totalTax": total,
                })
            })
            .collect();
        Ok(respond(
            &ctx,
            &Answer {
                table: &table,
                period_label: range_label(&range),
                filename: format!("tax-summary-{}_{}", range.from, range.to),
                json: json!({ "period": range.json(), "breakdown": breakdown }).into(),
                show_basis: false,
            },
        ))
    }
    .await;
    answer(result, "tax summary")
}

// ── GET /general-ledger ──────────────────────────────────────────────────────

async fn general_ledger(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let Some(account_id) = ctx.query.present("accountId").map(str::to_owned) else {
            return Err(Failure::Input("accountId is required".to_owned()));
        };
        let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
        let exporting = ctx.format != Format::Json;
        // `Number.parseInt(x ?? 'n', 10) || n`: NaN and 0 fall back.
        let int_or = |key: &str, fallback: i64| {
            parse_int(ctx.get(key).unwrap_or(&fallback.to_string()))
                .filter(|n| *n != 0)
                .unwrap_or(fallback)
        };
        let (page, page_size) = if exporting {
            (1, 9_007_199_254_740_991)
        } else {
            (
                int_or("page", 1).max(1),
                int_or("pageSize", 50).clamp(1, 500),
            )
        };
        let ledger = ledger_for(&ctx, &caller, parse_report_date(&range.to, Edge::End)?).await?;
        let Some(report) =
            build::build_general_ledger(&ledger, &account_id, &range, page, page_size).await?
        else {
            return Err(Failure::Refusal(Refusal::not_found("Account", &account_id)));
        };
        let code = if report.account.1.is_empty() {
            "account".to_owned()
        } else {
            report.account.1.clone()
        };
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::general_ledger_table(&report),
                period_label: range_label(&range),
                filename: format!("general-ledger-{code}-{}_{}", range.from, range.to),
                json: report.json().into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "general ledger")
}

// ── GET /cash-flow ───────────────────────────────────────────────────────────

async fn cash_flow_report(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, false).await?;
        let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
        let compare = parse_compare(ctx.get("compare"))?;
        let report = cash_flow::build_cash_flow(&caller.db, &ctx.entity_id, &range).await?;
        let mut json = report.json();
        if let Some(compare) = compare {
            let prior_range = match compare {
                CompareMode::PriorYear => prior_year_of(&ctx.entity, &range)?,
                CompareMode::PriorPeriod => prior_period_of(&range)?,
            };
            let prior =
                cash_flow::build_cash_flow(&caller.db, &ctx.entity_id, &prior_range).await?;
            let mut comparison = prior.json();
            comparison["mode"] = json!(compare.as_str());
            let delta = |current: &str, prior: &str| {
                delta_of(
                    weldsuite_kit::validation::js_number(current),
                    weldsuite_kit::validation::js_number(prior),
                )
                .json()
            };
            comparison["delta"] = json!({
                "inflows": delta(&report.totals.inflows, &prior.totals.inflows),
                "outflows": delta(&report.totals.outflows, &prior.totals.outflows),
                "net": delta(&report.totals.net, &prior.totals.net),
            });
            json["comparison"] = comparison;
        }
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::cash_flow_table(&report),
                period_label: range_label(&range),
                filename: format!("cash-flow-{}_{}", range.from, range.to),
                json: json.into(),
                show_basis: false,
            },
        ))
    }
    .await;
    answer(result, "cash flow")
}

// ── GET /revenue-by-customer ─────────────────────────────────────────────────

async fn revenue_by_customer(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
        let ledger = ledger_for(&ctx, &caller, parse_report_date(&range.to, Edge::End)?).await?;
        let (customers, grand_total) = build::build_revenue_by_customer(
            &caller.db,
            &ledger,
            LedgerRange {
                from: Some(parse_report_date(&range.from, Edge::Start)?),
                to: parse_report_date(&range.to, Edge::End)?,
            },
        )
        .await?;
        let json = json!({
            "basis": ctx.basis.as_str(),
            "period": range.json(),
            "customers": customers.iter().map(|c| json!({
                "contactId": c.contact_id,
                "contactName": c.contact_name,
                "totalRevenue": c.total_revenue,
            })).collect::<Vec<_>>(),
            "grandTotal": grand_total,
        });
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::revenue_by_customer_table(&customers, &grand_total),
                period_label: range_label(&range),
                filename: format!("revenue-by-customer-{}_{}", range.from, range.to),
                json: json.into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "revenue by customer")
}

// ── GET /expense-by-category ─────────────────────────────────────────────────

async fn expense_by_category(caller: Caller) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        let range = resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?;
        let ledger = ledger_for(&ctx, &caller, parse_report_date(&range.to, Edge::End)?).await?;
        let (categories, grand_total) = build::build_expense_by_category(
            &ledger,
            LedgerRange {
                from: Some(parse_report_date(&range.from, Edge::Start)?),
                to: parse_report_date(&range.to, Edge::End)?,
            },
        )
        .await?;
        let json = json!({
            "basis": ctx.basis.as_str(),
            "period": range.json(),
            "categories": categories.iter().map(|c| json!({
                "accountId": c.account_id,
                "accountCode": c.account_code,
                "accountName": c.account_name,
                "totalExpense": c.total_expense,
            })).collect::<Vec<_>>(),
            "grandTotal": grand_total,
        });
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| export::expense_by_category_table(&categories, &grand_total),
                period_label: range_label(&range),
                filename: format!("expenses-by-category-{}_{}", range.from, range.to),
                json: json.into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "expense by category")
}

// ── GET /tax-worksheet ───────────────────────────────────────────────────────

async fn tax_worksheet(caller: Caller, State(_state): State<BooksState>) -> Response {
    let result = async {
        let ctx = report_context(&caller, true).await?;
        if ctx.entity_text("jurisdictionCode") != Some("US") {
            return Err(Failure::Input(
                "The tax return worksheet is available for US entities".to_owned(),
            ));
        }
        let range = if ctx.query.present("from").is_some() || ctx.query.present("to").is_some() {
            resolve_period(&ctx.entity, ctx.get("from"), ctx.get("to"), &ctx.today())?
        } else if let Some(year) = ctx.query.present("year") {
            let year = parse_int(year)
                .filter(|y| (2000..=2100).contains(y))
                .ok_or_else(|| ReportInputError::new("year must be a four-digit year"))?;
            fiscal_year_named(&ctx.entity, year)?
        } else {
            fiscal_year_containing(&ctx.entity, &ctx.today())?
        };
        let form = us::tax_form_for_entity(
            ctx.entity_text("entityType"),
            ctx.entity_text("taxClassification"),
        );
        let ledger = ledger_for(&ctx, &caller, parse_report_date(&range.to, Edge::End)?).await?;
        let sheet = worksheet::build_tax_worksheet(
            &ledger,
            ctx.entity.clone(),
            form,
            &range,
            ctx.get("includeZero") == Some("true"),
        )
        .await?;
        Ok(respond(
            &ctx,
            &Answer {
                table: &|| worksheet::tax_worksheet_table(&sheet),
                period_label: format!("{}, {}", sheet.form_label, range_label(&range)),
                filename: format!("tax-worksheet-{form}-{}_{}", range.from, range.to),
                json: sheet.json().into(),
                show_basis: true,
            },
        ))
    }
    .await;
    answer(result, "tax worksheet")
}

#[cfg(test)]
mod tests {
    #[test]
    fn deltas_round_to_a_tenth_of_a_percent() {
        let d = super::build::delta_of(150.0, 100.0);
        assert_eq!(d.amount, "50.00");
        assert_eq!(d.percent, Some(50.0));
        assert_eq!(super::build::delta_of(1.0, 0.0).percent, None);
    }
}
