//! Export of the financial reports (`services/accounting-report-export.ts`):
//! a flat table per report, rendered as CSV or as the print-ready document
//! the platform turns into a PDF.

use axum::response::{IntoResponse, Response};
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::number_text;
use weldsuite_books_domain::reports_basis::ReportColumn;

use super::build::{AccountRow, AgedReport, BUCKETS, BalanceSheet, GeneralLedger, ProfitLoss, TrialBalance, ValueSet};
use super::cash_flow::CashFlow;

/// `ReportTableColumn`.
#[derive(Debug, Clone)]
pub(crate) struct TableColumn {
    pub(crate) key: String,
    pub(crate) label: String,
    pub(crate) numeric: bool,
}

impl TableColumn {
    pub(crate) fn new(key: &str, label: &str, numeric: bool) -> Self {
        Self {
            key: key.to_owned(),
            label: label.to_owned(),
            numeric,
        }
    }
}

/// `ReportTableRow`. `code` is absent, `null` or a text.
#[derive(Debug, Clone)]
pub(crate) struct TableRow {
    pub(crate) kind: &'static str,
    pub(crate) depth: usize,
    pub(crate) label: String,
    pub(crate) code: Option<Value>,
    pub(crate) values: Vec<(String, Value)>,
}

impl TableRow {
    pub(crate) fn new(kind: &'static str, depth: usize, label: impl Into<String>) -> Self {
        Self {
            kind,
            depth,
            label: label.into(),
            code: None,
            values: Vec::new(),
        }
    }

    pub(crate) fn code(mut self, code: Value) -> Self {
        self.code = Some(code);
        self
    }

    pub(crate) fn value(mut self, key: &str, value: impl Into<Value>) -> Self {
        let value = value.into();
        if let Some(at) = self.values.iter().position(|(k, _)| k == key) {
            self.values[at].1 = value;
        } else {
            self.values.push((key.to_owned(), value));
        }
        self
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.values.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".to_owned(), json!(self.kind));
        object.insert("depth".to_owned(), json!(self.depth));
        object.insert("label".to_owned(), json!(self.label));
        if let Some(code) = &self.code {
            object.insert("code".to_owned(), code.clone());
        }
        object.insert(
            "values".to_owned(),
            Value::Object(self.values.iter().cloned().collect()),
        );
        Value::Object(object)
    }
}

/// `ReportTable`.
#[derive(Debug, Clone)]
pub(crate) struct Table {
    pub(crate) report: &'static str,
    pub(crate) title: String,
    pub(crate) has_code: bool,
    pub(crate) columns: Vec<TableColumn>,
    pub(crate) rows: Vec<TableRow>,
    pub(crate) notes: Vec<String>,
}

impl Table {
    pub(crate) fn json(&self) -> Value {
        json!({
            "report": self.report,
            "title": self.title,
            "hasCode": self.has_code,
            "columns": self.columns.iter().map(|c| json!({ "key": c.key, "label": c.label, "numeric": c.numeric })).collect::<Vec<_>>(),
            "rows": self.rows.iter().map(TableRow::json).collect::<Vec<_>>(),
            "notes": self.notes,
        })
    }
}

/// `ReportMeta`.
pub(crate) struct Meta<'a> {
    pub(crate) entity_name: &'a str,
    pub(crate) basis: Option<&'a str>,
    pub(crate) period_label: &'a str,
    pub(crate) currency: &'a str,
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

fn is_plain_number(value: &str) -> bool {
    // `/^-?\d+(\.\d+)?$/`
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = match digits.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (digits, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `neutralize(value)`: a text a spreadsheet would run as a formula gets a
/// leading quote.
fn neutralize(value: &str) -> String {
    let risky = value.starts_with(['=', '+', '@', '\t', '\r'])
        || (value.starts_with('-') && !is_plain_number(value));
    if risky {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

fn quote(text: &str) -> String {
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

fn csv_text(value: &str) -> String {
    quote(&neutralize(value))
}

fn csv_cell(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(text)) => csv_text(text),
        Some(other) => csv_text(&other.to_string()),
    }
}

/// `toCsv(table, meta)`.
pub(crate) fn to_csv(table: &Table, meta: &Meta<'_>) -> String {
    let mut lines: Vec<String> = vec![csv_text(&table.title), csv_text(meta.entity_name)];
    if let Some(basis) = meta.basis.filter(|b| !b.is_empty()) {
        lines.push(csv_text(&format!(
            "Basis: {}",
            if basis == "cash" { "Cash" } else { "Accrual" }
        )));
    }
    lines.push(csv_text(meta.period_label));
    lines.push(csv_text(&format!("Amounts in {}", meta.currency)));
    lines.push(String::new());

    let mut header: Vec<String> = Vec::new();
    if table.has_code {
        header.push("Code".to_owned());
    }
    header.push("Name".to_owned());
    header.extend(table.columns.iter().map(|c| c.label.clone()));
    lines.push(
        header
            .iter()
            .map(|h| csv_text(h))
            .collect::<Vec<_>>()
            .join(","),
    );

    for row in &table.rows {
        let indent = "  ".repeat(row.depth);
        let mut cells: Vec<String> = Vec::new();
        if table.has_code {
            let code = match &row.code {
                None | Some(Value::Null) => Value::String(String::new()),
                Some(code) => code.clone(),
            };
            cells.push(csv_cell(Some(&code)));
        }
        cells.push(quote(&format!("{indent}{}", neutralize(&row.label))));
        cells.extend(table.columns.iter().map(|c| csv_cell(row.get(&c.key))));
        lines.push(cells.join(","));
    }

    if !table.notes.is_empty() {
        lines.push(String::new());
        lines.extend(table.notes.iter().map(|n| csv_text(n)));
    }
    format!("\u{feff}{}\r\n", lines.join("\r\n"))
}

/// `csvResponse(csv, filename)`.
pub(crate) fn csv_response(csv: String, filename: &str) -> Response {
    let safe: String = filename
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            let units = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, units)
        })
        .collect();
    (
        [
            (CONTENT_TYPE, "text/csv; charset=utf-8".to_owned()),
            (CONTENT_DISPOSITION, format!("attachment; filename=\"{safe}\"")),
        ],
        csv,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Print document
// ---------------------------------------------------------------------------

/// `printEntity(entity)`: the header a printed report carries; the tax ID as
/// printed on documents (EIN, VAT number), never an SSN.
pub(crate) fn print_entity(entity: &Value) -> Value {
    let ids = entity.get("taxIdentifiers").filter(|v| v.is_object());
    let field = |key: &str| ids.and_then(|ids| ids.get(key));
    let ein = field("einOrSsn")
        .filter(|v| weldsuite_books_domain::js::truthy(Some(v)))
        .and_then(|v| {
            let text = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            let bytes = text.as_bytes();
            let shaped = bytes.len() == 10
                && bytes[2] == b'-'
                && bytes
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 2 || b.is_ascii_digit());
            shaped.then(|| v.clone())
        });
    let tax_id = if entity.get("jurisdictionCode").and_then(Value::as_str) == Some("US") {
        ein.unwrap_or(Value::Null)
    } else {
        field("vatNumber")
            .filter(|v| !v.is_null())
            .or_else(|| field("registrationNumber").filter(|v| !v.is_null()))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let pick = |key: &str| entity.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "name": pick("name"),
        "legalName": pick("legalName"),
        "dba": pick("dba"),
        "address": pick("address"),
        "taxId": tax_id,
        "jurisdictionCode": pick("jurisdictionCode"),
        "locale": pick("locale"),
        "timezone": pick("timezone"),
    })
}

/// `buildPrintDocument(table, meta, entity)`.
pub(crate) fn print_document(table: &Table, meta: &Meta<'_>, entity: &Value) -> Value {
    let us = entity.get("jurisdictionCode").and_then(Value::as_str) == Some("US");
    json!({
        "kind": "report",
        "report": table.report,
        "title": table.title,
        "paper": if us { "letter" } else { "a4" },
        "entity": print_entity(entity),
        "basis": meta.basis,
        "periodLabel": meta.period_label,
        "currency": meta.currency,
        "generatedAt": weldsuite_books_domain::http::now(),
        "table": table.json(),
    })
}

// ---------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------

fn value_columns(columns: &[ReportColumn], with_delta: bool) -> Vec<TableColumn> {
    let mut out: Vec<TableColumn> = columns
        .iter()
        .map(|c| TableColumn::new(&c.key, &c.label, true))
        .collect();
    if with_delta {
        out.push(TableColumn::new("delta", "Change", true));
        out.push(TableColumn::new("deltaPercent", "Change %", true));
    }
    out
}

/// `withDeltaValues(set)`.
pub(crate) fn with_delta_values(set: &ValueSet) -> Vec<(String, Value)> {
    let mut values: Vec<(String, Value)> = set
        .values
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    if let Some(delta) = &set.delta {
        values.retain(|(k, _)| k != "delta" && k != "deltaPercent");
        values.push(("delta".to_owned(), json!(delta.amount)));
        values.push((
            "deltaPercent".to_owned(),
            delta
                .percent
                .map_or(Value::Null, |p| json!(format!("{}%", number_text(p)))),
        ));
    }
    values
}

fn has_delta(columns: &[ReportColumn]) -> bool {
    columns.len() == 2 && columns[1].key == "prior"
}

fn account_line(row: &AccountRow) -> TableRow {
    let mut line = TableRow::new("account", 1, row.account_name.clone()).code(
        if row.account_code.is_empty() {
            Value::Null
        } else {
            json!(row.account_code)
        },
    );
    line.values = with_delta_values(&row.set);
    line
}

fn total_line(kind: &'static str, label: &str, set: &ValueSet) -> TableRow {
    let mut line = TableRow::new(kind, 0, label);
    line.values = with_delta_values(set);
    line
}

fn section_line(label: &str) -> TableRow {
    TableRow::new("section", 0, label)
}

// ---------------------------------------------------------------------------
// Tables per report
// ---------------------------------------------------------------------------

/// `profitLossTable(report)`.
pub(crate) fn profit_loss_table(report: &ProfitLoss) -> Table {
    let mut rows: Vec<TableRow> = Vec::new();
    let all: Vec<&AccountRow> = report.revenue.iter().chain(&report.expenses).collect();
    let has = |section: &str| all.iter().any(|r| r.section == Some(section));
    let block = |rows: &mut Vec<TableRow>, label: &str, section: &str, total_label: &str, total: &ValueSet| {
        let members: Vec<&&AccountRow> = all.iter().filter(|r| r.section == Some(section)).collect();
        if members.is_empty() && section != "income" && section != "expense" {
            return;
        }
        rows.push(section_line(label));
        rows.extend(members.iter().map(|r| account_line(r)));
        rows.push(total_line("subtotal", total_label, total));
    };

    block(&mut rows, "Income", "income", "Total income", report.total("income"));
    block(
        &mut rows,
        "Cost of goods sold",
        "cost_of_goods_sold",
        "Total cost of goods sold",
        report.total("costOfGoodsSold"),
    );
    if has("cost_of_goods_sold") {
        rows.push(total_line("total", "Gross profit", report.total("grossProfit")));
    }
    block(&mut rows, "Expenses", "expense", "Total expenses", report.total("expenses"));
    rows.push(total_line(
        "total",
        "Net operating income",
        report.total("netOperatingIncome"),
    ));
    if has("other_income") || has("other_expense") {
        block(
            &mut rows,
            "Other income",
            "other_income",
            "Total other income",
            report.total("otherIncome"),
        );
        block(
            &mut rows,
            "Other expenses",
            "other_expense",
            "Total other expenses",
            report.total("otherExpenses"),
        );
        rows.push(total_line("total", "Net other income", report.total("netOtherIncome")));
    }
    rows.push(total_line("total", "Net income", report.total("netProfit")));

    Table {
        report: "profit_loss",
        title: "Profit and loss".to_owned(),
        has_code: true,
        columns: value_columns(&report.columns, has_delta(&report.columns)),
        rows,
        notes: Vec::new(),
    }
}

/// `balanceSheetTable(report)`.
pub(crate) fn balance_sheet_table(report: &BalanceSheet) -> Table {
    let mut rows = vec![section_line("Assets")];
    rows.extend(report.assets.iter().map(account_line));
    rows.push(total_line("total", "Total assets", report.total("assets")));
    rows.push(section_line("Liabilities"));
    rows.extend(report.liabilities.iter().map(account_line));
    rows.push(total_line("subtotal", "Total liabilities", report.total("liabilities")));
    rows.push(section_line("Equity"));
    rows.extend(report.equity.iter().map(account_line));
    rows.push(total_line("subtotal", "Total equity", report.total("equity")));
    rows.push(total_line(
        "total",
        "Total liabilities and equity",
        report.total("liabilitiesAndEquity"),
    ));
    let notes = if report.is_balanced {
        Vec::new()
    } else {
        vec![format!(
            "Assets and liabilities plus equity differ by {}.",
            report.difference
        )]
    };
    Table {
        report: "balance_sheet",
        title: "Balance sheet".to_owned(),
        has_code: true,
        columns: value_columns(&report.columns, has_delta(&report.columns)),
        rows,
        notes,
    }
}

/// `trialBalanceTable(report)`.
pub(crate) fn trial_balance_table(report: &TrialBalance) -> Table {
    let comparison = has_delta(&report.columns);
    let columns = if comparison {
        value_columns(&report.columns, true)
    } else {
        vec![
            TableColumn::new("debit", "Debit", true),
            TableColumn::new("credit", "Credit", true),
        ]
    };
    let mut rows: Vec<TableRow> = report
        .accounts
        .iter()
        .map(|a| {
            let mut row = TableRow::new("account", 0, a.account_name.clone()).code(
                if a.account_code.is_empty() {
                    Value::Null
                } else {
                    json!(a.account_code)
                },
            );
            row.values = if comparison {
                with_delta_values(&a.set)
            } else {
                vec![
                    ("debit".to_owned(), json!(a.debit_balance)),
                    ("credit".to_owned(), json!(a.credit_balance)),
                ]
            };
            row
        })
        .collect();
    if !comparison {
        let debit = report.accounts.iter().fold(0.0, |t, a| {
            t + weldsuite_books_domain::js::parse_float(&a.debit_balance)
        });
        let credit = report.accounts.iter().fold(0.0, |t, a| {
            t + weldsuite_books_domain::js::parse_float(&a.credit_balance)
        });
        rows.push(
            TableRow::new("total", 0, "Total")
                .value("debit", weldsuite_books_domain::js::to_fixed(debit, 2))
                .value("credit", weldsuite_books_domain::js::to_fixed(credit, 2)),
        );
    }
    Table {
        report: "trial_balance",
        title: "Trial balance".to_owned(),
        has_code: true,
        columns,
        rows,
        notes: Vec::new(),
    }
}

/// `generalLedgerTable(report)`.
pub(crate) fn general_ledger_table(report: &GeneralLedger) -> Table {
    let columns = vec![
        TableColumn::new("date", "Date", false),
        TableColumn::new("entry", "Entry", false),
        TableColumn::new("debit", "Debit", true),
        TableColumn::new("credit", "Credit", true),
        TableColumn::new("balance", "Balance", true),
    ];
    let mut rows = vec![
        TableRow::new("section", 0, "Opening balance").value("balance", report.opening_balance.clone()),
    ];
    for l in &report.lines {
        rows.push(
            TableRow::new("account", 0, l.description.clone().unwrap_or_default())
                .value(
                    "date",
                    weldsuite_books_domain::reports_basis::iso_day(l.entry_date),
                )
                .value("entry", l.entry_number.clone().unwrap_or_default())
                .value("debit", l.debit.clone())
                .value("credit", l.credit.clone())
                .value("balance", l.running_balance.clone()),
        );
    }
    rows.push(
        TableRow::new("total", 0, "Closing balance")
            .value("debit", report.total_debit.clone())
            .value("credit", report.total_credit.clone())
            .value("balance", report.closing_balance.clone()),
    );
    Table {
        report: "general_ledger",
        title: format!(
            "General ledger: {} {}",
            report.account.1, report.account.2
        )
        .trim()
        .to_owned(),
        has_code: false,
        columns,
        rows,
        notes: if report.has_more {
            vec!["Only the lines of the requested page are listed.".to_owned()]
        } else {
            Vec::new()
        },
    }
}

fn activity_label(activity: &str) -> String {
    match activity {
        "operating" => "Operating activities".to_owned(),
        "investing" => "Investing activities".to_owned(),
        "financing" => "Financing activities".to_owned(),
        other => other.to_owned(),
    }
}

fn category_label(category: &str) -> String {
    match category {
        "customer_receipts" => "Customer receipts",
        "supplier_payments" => "Supplier payments",
        "operating_expenses" => "Operating expenses paid",
        "taxes" => "Taxes",
        "payroll" => "Payroll",
        "other_operating" => "Other operating",
        "fixed_assets" => "Fixed assets",
        "equity" => "Equity",
        "loans" => "Loans",
        other => other,
    }
    .to_owned()
}

/// `cashFlowTable(report)`.
pub(crate) fn cash_flow_table(report: &CashFlow) -> Table {
    let figures = |row: TableRow, f: &super::cash_flow::Figures| {
        row.value("inflows", f.inflows.clone())
            .value("outflows", f.outflows.clone())
            .value("net", f.net.clone())
    };
    let mut rows = vec![
        TableRow::new("subtotal", 0, "Opening cash balance").value("net", report.opening_balance.clone()),
    ];
    for block in &report.activities {
        let active: Vec<_> = block
            .categories
            .iter()
            .filter(|(_, f)| {
                weldsuite_books_domain::js::parse_float(&f.inflows) != 0.0
                    || weldsuite_books_domain::js::parse_float(&f.outflows) != 0.0
            })
            .collect();
        if active.is_empty() {
            continue;
        }
        rows.push(TableRow::new("section", 0, activity_label(block.activity)));
        for (category, f) in active {
            rows.push(figures(TableRow::new("account", 1, category_label(category)), f));
        }
        rows.push(figures(
            TableRow::new("subtotal", 0, format!("Net cash from {} activities", block.activity)),
            &block.figures,
        ));
    }
    rows.push(figures(TableRow::new("total", 0, "Net change in cash"), &report.totals));
    rows.push(TableRow::new("total", 0, "Closing cash balance").value("net", report.closing_balance.clone()));
    if !report.monthly.is_empty() {
        rows.push(TableRow::new("section", 0, "By month"));
        for (month, f) in &report.monthly {
            rows.push(figures(TableRow::new("account", 1, month.clone()), f));
        }
    }
    Table {
        report: "cash_flow",
        title: "Cash flow".to_owned(),
        has_code: false,
        columns: vec![
            TableColumn::new("inflows", "Inflows", true),
            TableColumn::new("outflows", "Outflows", true),
            TableColumn::new("net", "Net", true),
        ],
        rows,
        notes: vec!["Movements on the cash and bank accounts of the ledger, grouped by what the other side of each entry says the money was for.".to_owned()],
    }
}

/// `revenueByCustomerTable(report)`.
pub(crate) fn revenue_by_customer_table(
    customers: &[super::build::CustomerRevenue],
    grand_total: &str,
) -> Table {
    let mut rows: Vec<TableRow> = customers
        .iter()
        .map(|c| {
            TableRow::new(
                "account",
                0,
                c.contact_name.clone().unwrap_or_else(|| c.contact_id.clone()),
            )
            .value("revenue", c.total_revenue.clone())
        })
        .collect();
    rows.push(TableRow::new("total", 0, "Total").value("revenue", grand_total.to_owned()));
    Table {
        report: "revenue_by_customer",
        title: "Revenue by customer".to_owned(),
        has_code: false,
        columns: vec![TableColumn::new("revenue", "Revenue", true)],
        rows,
        notes: Vec::new(),
    }
}

/// `expenseByCategoryTable(report)`.
pub(crate) fn expense_by_category_table(
    categories: &[super::build::ExpenseCategory],
    grand_total: &str,
) -> Table {
    let mut rows: Vec<TableRow> = categories
        .iter()
        .map(|c| {
            TableRow::new("account", 0, c.account_name.clone())
                .code(json!(c.account_code))
                .value("expense", c.total_expense.clone())
        })
        .collect();
    rows.push(TableRow::new("total", 0, "Total").value("expense", grand_total.to_owned()));
    Table {
        report: "expense_by_category",
        title: "Expenses by category".to_owned(),
        has_code: true,
        columns: vec![TableColumn::new("expense", "Expense", true)],
        rows,
        notes: Vec::new(),
    }
}

/// `agedTable(report, kind)`.
pub(crate) fn aged_table(report: &AgedReport, receivables: bool) -> Table {
    let mut columns: Vec<TableColumn> = BUCKETS
        .iter()
        .map(|b| {
            let label = if *b == "current" {
                "Current".to_owned()
            } else {
                format!("{b} days")
            };
            TableColumn {
                key: (*b).to_owned(),
                label,
                numeric: true,
            }
        })
        .collect();
    columns.push(TableColumn::new("total", "Total", true));
    let mut rows: Vec<TableRow> = report
        .contacts
        .iter()
        .map(|c| {
            let label = c.contact_name.clone().unwrap_or_else(|| match &c.contact_id {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            });
            let mut row = TableRow::new("account", 0, label);
            for (bucket, value) in BUCKETS.iter().zip(&c.buckets) {
                row = row.value(bucket, value.clone());
            }
            row.value("total", c.total.clone())
        })
        .collect();
    let mut total = TableRow::new("total", 0, "Total");
    for (bucket, (value, _)) in BUCKETS.iter().zip(&report.buckets) {
        total = total.value(bucket, value.clone());
    }
    rows.push(total.value("total", report.total.clone()));
    Table {
        report: if receivables {
            "aged_receivables"
        } else {
            "aged_payables"
        },
        title: if receivables {
            "Aged receivables"
        } else {
            "Aged payables"
        }
        .to_owned(),
        has_code: false,
        columns,
        rows,
        notes: vec![format!("Open documents as of {}.", report.as_of)],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_guards_formulas_and_quotes() {
        assert_eq!(neutralize("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(neutralize("-12.50"), "-12.50");
        assert_eq!(neutralize("-x"), "'-x");
        assert_eq!(quote("a,b"), "\"a,b\"");
        assert_eq!(quote("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn csv_lays_out_header_rows_and_notes() {
        let table = Table {
            report: "x",
            title: "Title".to_owned(),
            has_code: true,
            columns: vec![TableColumn::new("current", "2026", true)],
            rows: vec![
                TableRow::new("section", 0, "Income"),
                TableRow::new("account", 1, "Sales")
                    .code(json!("8000"))
                    .value("current", "10.00"),
            ],
            notes: vec!["Note".to_owned()],
        };
        let csv = to_csv(
            &table,
            &Meta {
                entity_name: "Acme",
                basis: Some("cash"),
                period_label: "Period: a to b",
                currency: "EUR",
            },
        );
        assert_eq!(
            csv,
            "\u{feff}Title\r\nAcme\r\nBasis: Cash\r\nPeriod: a to b\r\nAmounts in EUR\r\n\r\nCode,Name,2026\r\n,Income,\r\n8000,  Sales,10.00\r\n\r\nNote\r\n"
        );
    }
}
