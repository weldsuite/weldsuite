//! The report builders (`services/accounting-reports.ts`): ledger totals
//! laid out as the JSON the report routes return.
//!
//! Every report has columns (`current`; `current` + `prior`; a column per
//! month or quarter + `total`). Each row carries `values` by column key;
//! comparative rows also carry `delta`. The scalar fields older clients read
//! (`balance`, `totalRevenue`, …) are the primary column: `current`, else
//! `total`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::dates::{add_days, diff_days};
use weldsuite_books_domain::js::{locale_compare, math_round, number_value, parse_float};
use weldsuite_books_domain::reports_basis::{
    AggregateOptions, AggregateRow, DateRange, Edge, Ledger, LedgerAccount, LedgerRange,
    ReportColumn, ReportInputError, money, parse_report_date,
};

/// What a builder can fail with: a bad parameter (400) or the database (500).
#[derive(Debug)]
pub(crate) enum BuildError {
    Input(ReportInputError),
    Database(sqlx::Error),
    Internal(String),
}

impl From<ReportInputError> for BuildError {
    fn from(error: ReportInputError) -> Self {
        Self::Input(error)
    }
}

impl From<sqlx::Error> for BuildError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

pub(crate) type Built<T> = Result<T, BuildError>;

/// Amounts by column key, in column order.
pub(crate) type Amounts = Vec<(String, f64)>;

fn amount_of(amounts: &Amounts, key: &str) -> f64 {
    amounts
        .iter()
        .find(|(k, _)| k == key)
        .map_or(0.0, |(_, v)| *v)
}

/// `Delta`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Delta {
    pub(crate) amount: String,
    pub(crate) percent: Option<f64>,
}

impl Delta {
    pub(crate) fn json(&self) -> Value {
        json!({ "amount": self.amount, "percent": self.percent.map(number_value) })
    }
}

/// `deltaOf(current, prior)`.
pub(crate) fn delta_of(current: f64, prior: f64) -> Delta {
    Delta {
        amount: money(current - prior),
        percent: (prior.abs() >= 0.005)
            .then(|| math_round(((current - prior) / prior.abs()) * 1000.0) / 10.0),
    }
}

/// `ValueSet`: `values` by column (money strings) and the comparison delta.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ValueSet {
    pub(crate) values: Vec<(String, String)>,
    pub(crate) delta: Option<Delta>,
}

impl ValueSet {
    pub(crate) fn value(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// `Number(set.values[key])`.
    pub(crate) fn number(&self, key: &str) -> f64 {
        self.value(key).map_or(f64::NAN, parse_float)
    }

    fn values_json(&self) -> Value {
        Value::Object(
            self.values
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect(),
        )
    }

    /// `{ values, delta? }` into an object.
    pub(crate) fn write(&self, object: &mut Map<String, Value>) {
        object.insert("values".to_owned(), self.values_json());
        if let Some(delta) = &self.delta {
            object.insert("delta".to_owned(), delta.json());
        }
    }

    pub(crate) fn json(&self) -> Value {
        let mut object = Map::new();
        self.write(&mut object);
        Value::Object(object)
    }
}

/// `columnRange(column)`.
pub(crate) fn column_range(column: &ReportColumn) -> Built<LedgerRange> {
    Ok(LedgerRange {
        from: column
            .from
            .as_deref()
            .map(|from| parse_report_date(from, Edge::Start))
            .transpose()?,
        to: parse_report_date(&column.to, Edge::End)?,
    })
}

/// `primaryColumn(columns)`: `current`, else `total`, else the first.
pub(crate) fn primary_column(columns: &[ReportColumn]) -> &ReportColumn {
    columns
        .iter()
        .find(|c| c.key == "current")
        .or_else(|| columns.iter().find(|c| c.key == "total"))
        .unwrap_or(&columns[0])
}

/// `isComparison(columns)`.
pub(crate) fn is_comparison(columns: &[ReportColumn]) -> bool {
    columns.len() == 2 && columns[1].key == "prior"
}

/// `latestDate(columns)`: the latest instant any column reaches.
pub(crate) fn latest_date(columns: &[ReportColumn]) -> Built<i64> {
    let mut latest: Option<i64> = None;
    for column in columns {
        let to = column_range(column)?.to;
        latest = Some(latest.map_or(to, |l| l.max(to)));
    }
    latest.ok_or_else(|| BuildError::Internal("no columns".to_owned()))
}

fn columns_json(columns: &[ReportColumn]) -> Value {
    Value::Array(columns.iter().map(ReportColumn::json).collect())
}

type Totals = HashMap<String, (f64, f64)>;

/// `totalsByColumn(ledger, columns, opts)`: per column, debit and credit by
/// account; and the account ids in first-seen order (`accountIdsOf`).
async fn totals_by_column(
    ledger: &Ledger,
    columns: &[ReportColumn],
    account_types: &[&str],
) -> Built<(HashMap<String, Totals>, Vec<String>)> {
    let mut by_column = HashMap::new();
    let mut ids: Vec<String> = Vec::new();
    for column in columns {
        let rows = ledger
            .aggregate(
                column_range(column)?,
                AggregateOptions::types(account_types),
            )
            .await?;
        let mut totals = Totals::new();
        for row in rows {
            if !ids.contains(&row.account_id) {
                ids.push(row.account_id.clone());
            }
            totals.insert(row.account_id, (row.debit, row.credit));
        }
        by_column.insert(column.key.clone(), totals);
    }
    Ok((by_column, ids))
}

fn totals_of<'a>(
    by_column: &'a HashMap<String, Totals>,
    key: &str,
    account_id: &str,
) -> Option<&'a (f64, f64)> {
    by_column.get(key).and_then(|t| t.get(account_id))
}

/// `valueSet(columns, amounts)`.
pub(crate) fn value_set(columns: &[ReportColumn], amounts: &Amounts) -> ValueSet {
    ValueSet {
        values: columns
            .iter()
            .map(|c| (c.key.clone(), money(amount_of(amounts, &c.key))))
            .collect(),
        delta: is_comparison(columns)
            .then(|| delta_of(amount_of(amounts, "current"), amount_of(amounts, "prior"))),
    }
}

/// `byCode(a, b)`: code numerically, then name.
pub(crate) fn by_code(a: &LedgerAccount, b: &LedgerAccount) -> std::cmp::Ordering {
    weldsuite_books_domain::reports_basis::numeric_compare(&a.code, &b.code)
        .then_with(|| locale_compare(&a.name, &b.name))
}

fn sorted_accounts<'a>(ledger: &'a Ledger, ids: &[String]) -> Vec<&'a LedgerAccount> {
    let mut accounts: Vec<&LedgerAccount> =
        ids.iter().filter_map(|id| ledger.account(id)).collect();
    accounts.sort_by(|a, b| by_code(a, b));
    accounts
}

/// `AccountRow`.
#[derive(Debug, Clone)]
pub(crate) struct AccountRow {
    pub(crate) account_id: Option<String>,
    pub(crate) account_code: String,
    pub(crate) account_name: String,
    pub(crate) account_type: String,
    pub(crate) account_subtype: Option<String>,
    pub(crate) normal_side: &'static str,
    pub(crate) section: Option<&'static str>,
    pub(crate) is_virtual: bool,
    pub(crate) total_debit: String,
    pub(crate) total_credit: String,
    pub(crate) balance: String,
    pub(crate) set: ValueSet,
}

impl AccountRow {
    pub(crate) fn json(&self) -> Value {
        let mut object = Map::new();
        object.insert("accountId".to_owned(), json!(self.account_id));
        object.insert("accountCode".to_owned(), json!(self.account_code));
        object.insert("accountName".to_owned(), json!(self.account_name));
        object.insert("accountType".to_owned(), json!(self.account_type));
        object.insert("accountSubtype".to_owned(), json!(self.account_subtype));
        object.insert("normalSide".to_owned(), json!(self.normal_side));
        if let Some(section) = self.section {
            object.insert("section".to_owned(), json!(section));
        }
        if self.is_virtual {
            object.insert("virtual".to_owned(), json!(true));
        }
        object.insert("totalDebit".to_owned(), json!(self.total_debit));
        object.insert("totalCredit".to_owned(), json!(self.total_credit));
        object.insert("balance".to_owned(), json!(self.balance));
        self.set.write(&mut object);
        Value::Object(object)
    }
}

/// `accountRow(account, columns, totals, balanceOf)`.
fn account_row(
    account: &LedgerAccount,
    columns: &[ReportColumn],
    by_column: &HashMap<String, Totals>,
    balance_of: impl Fn(Option<&(f64, f64)>) -> f64,
) -> AccountRow {
    let primary = primary_column(columns);
    let own = totals_of(by_column, &primary.key, &account.id);
    let amounts: Amounts = columns
        .iter()
        .map(|c| {
            (
                c.key.clone(),
                balance_of(totals_of(by_column, &c.key, &account.id)),
            )
        })
        .collect();
    AccountRow {
        account_id: Some(account.id.clone()),
        account_code: account.code.clone(),
        account_name: account.name.clone(),
        account_type: account.account_type.clone(),
        account_subtype: account.subtype.clone(),
        normal_side: account.normal_side,
        section: None,
        is_virtual: false,
        total_debit: money(own.map_or(0.0, |t| t.0)),
        total_credit: money(own.map_or(0.0, |t| t.1)),
        balance: money(amount_of(&amounts, &primary.key)),
        set: value_set(columns, &amounts),
    }
}

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------

fn matches_any(subtype: &str, options: &[&str]) -> bool {
    options.iter().any(|o| subtype.eq_ignore_ascii_case(o))
}

/// `profitLossSection(account)`.
pub(crate) fn profit_loss_section(account_type: &str, subtype: Option<&str>) -> &'static str {
    let subtype = subtype.unwrap_or_default();
    if account_type == "revenue" {
        return if matches_any(subtype, &["other_income", "interest_income"]) {
            "other_income"
        } else {
            "income"
        };
    }
    if matches_any(
        subtype,
        &[
            "cost_of_goods_sold",
            "cost_of_goods",
            "cost_of_sales",
            "cogs",
        ],
    ) {
        return "cost_of_goods_sold";
    }
    if matches_any(subtype, &["other_expense", "tax_expense"]) {
        "other_expense"
    } else {
        "expense"
    }
}

/// `ProfitLossReport`.
pub(crate) struct ProfitLoss {
    pub(crate) basis: &'static str,
    pub(crate) period: DateRange,
    pub(crate) columns: Vec<ReportColumn>,
    pub(crate) revenue: Vec<AccountRow>,
    pub(crate) expenses: Vec<AccountRow>,
    pub(crate) total_revenue: String,
    pub(crate) total_expenses: String,
    pub(crate) net_profit: String,
    /// `totals`, by key in the TypeScript order.
    pub(crate) totals: Vec<(&'static str, ValueSet)>,
}

impl ProfitLoss {
    pub(crate) fn total(&self, key: &str) -> &ValueSet {
        &self
            .totals
            .iter()
            .find(|(k, _)| *k == key)
            .expect("a profit and loss total")
            .1
    }

    pub(crate) fn json(&self) -> Value {
        json!({
            "basis": self.basis,
            "period": self.period.json(),
            "columns": columns_json(&self.columns),
            "revenue": self.revenue.iter().map(AccountRow::json).collect::<Vec<_>>(),
            "expenses": self.expenses.iter().map(AccountRow::json).collect::<Vec<_>>(),
            "totalRevenue": self.total_revenue,
            "totalExpenses": self.total_expenses,
            "netProfit": self.net_profit,
            "totals": Value::Object(self.totals.iter().map(|(k, v)| ((*k).to_owned(), v.json())).collect()),
        })
    }
}

/// `buildProfitLoss(ledger, columns, period)`.
pub(crate) async fn build_profit_loss(
    ledger: &Ledger,
    columns: &[ReportColumn],
    period: &DateRange,
) -> Built<ProfitLoss> {
    let (by_column, ids) = totals_by_column(ledger, columns, &["revenue", "expense"]).await?;
    let rows: Vec<AccountRow> = sorted_accounts(ledger, &ids)
        .into_iter()
        .map(|account| {
            let revenue = account.account_type == "revenue";
            let mut row = account_row(account, columns, &by_column, |t| match t {
                Some((debit, credit)) if revenue => credit - debit,
                Some((debit, credit)) => debit - credit,
                None => 0.0,
            });
            row.section = Some(profit_loss_section(
                &account.account_type,
                account.subtype.as_deref(),
            ));
            row
        })
        .collect();

    let sum = |sections: &[&str]| -> Amounts {
        columns
            .iter()
            .map(|c| {
                let total = rows
                    .iter()
                    .filter(|r| r.section.is_some_and(|s| sections.contains(&s)))
                    .fold(0.0, |total, r| total + r.set.number(&c.key));
                (c.key.clone(), total)
            })
            .collect()
    };
    let combine = |a: &Amounts, b: &Amounts, f: fn(f64, f64) -> f64| -> Amounts {
        columns
            .iter()
            .map(|c| (c.key.clone(), f(amount_of(a, &c.key), amount_of(b, &c.key))))
            .collect()
    };
    let diff = |a: &Amounts, b: &Amounts| combine(a, b, |x, y| x - y);
    let add = |a: &Amounts, b: &Amounts| combine(a, b, |x, y| x + y);

    let income = sum(&["income"]);
    let cogs = sum(&["cost_of_goods_sold"]);
    let expenses = sum(&["expense"]);
    let other_income = sum(&["other_income"]);
    let other_expenses = sum(&["other_expense"]);
    let gross_profit = diff(&income, &cogs);
    let net_operating = diff(&gross_profit, &expenses);
    let net_other = diff(&other_income, &other_expenses);
    let total_revenue = add(&income, &other_income);
    let total_expenses = add(&add(&cogs, &expenses), &other_expenses);
    let net_profit = diff(&total_revenue, &total_expenses);

    let primary = primary_column(columns).key.clone();
    let (revenue, expense_rows): (Vec<AccountRow>, Vec<AccountRow>) = (
        rows.iter()
            .filter(|r| r.account_type == "revenue")
            .cloned()
            .collect(),
        rows.iter()
            .filter(|r| r.account_type == "expense")
            .cloned()
            .collect(),
    );
    Ok(ProfitLoss {
        basis: ledger.basis.as_str(),
        period: period.clone(),
        columns: columns.to_vec(),
        revenue,
        expenses: expense_rows,
        total_revenue: money(amount_of(&total_revenue, &primary)),
        total_expenses: money(amount_of(&total_expenses, &primary)),
        net_profit: money(amount_of(&net_profit, &primary)),
        totals: vec![
            ("income", value_set(columns, &income)),
            ("costOfGoodsSold", value_set(columns, &cogs)),
            ("grossProfit", value_set(columns, &gross_profit)),
            ("expenses", value_set(columns, &expenses)),
            ("netOperatingIncome", value_set(columns, &net_operating)),
            ("otherIncome", value_set(columns, &other_income)),
            ("otherExpenses", value_set(columns, &other_expenses)),
            ("netOtherIncome", value_set(columns, &net_other)),
            ("totalRevenue", value_set(columns, &total_revenue)),
            ("totalExpenses", value_set(columns, &total_expenses)),
            ("netProfit", value_set(columns, &net_profit)),
        ],
    })
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

/// `BalanceSheetReport`.
pub(crate) struct BalanceSheet {
    pub(crate) basis: &'static str,
    pub(crate) as_of: String,
    pub(crate) columns: Vec<ReportColumn>,
    pub(crate) assets: Vec<AccountRow>,
    pub(crate) liabilities: Vec<AccountRow>,
    pub(crate) equity: Vec<AccountRow>,
    pub(crate) total_assets: String,
    pub(crate) total_liabilities: String,
    pub(crate) total_equity: String,
    pub(crate) total_liabilities_and_equity: String,
    pub(crate) difference: String,
    pub(crate) is_balanced: bool,
    pub(crate) totals: Vec<(&'static str, ValueSet)>,
}

impl BalanceSheet {
    pub(crate) fn total(&self, key: &str) -> &ValueSet {
        &self
            .totals
            .iter()
            .find(|(k, _)| *k == key)
            .expect("a balance sheet total")
            .1
    }

    pub(crate) fn json(&self) -> Value {
        let rows = |list: &[AccountRow]| list.iter().map(AccountRow::json).collect::<Vec<_>>();
        json!({
            "basis": self.basis,
            "asOf": self.as_of,
            "columns": columns_json(&self.columns),
            "assets": rows(&self.assets),
            "liabilities": rows(&self.liabilities),
            "equity": rows(&self.equity),
            "totalAssets": self.total_assets,
            "totalLiabilities": self.total_liabilities,
            "totalEquity": self.total_equity,
            "totalLiabilitiesAndEquity": self.total_liabilities_and_equity,
            "difference": self.difference,
            "isBalanced": self.is_balanced,
            "totals": Value::Object(self.totals.iter().map(|(k, v)| ((*k).to_owned(), v.json())).collect()),
        })
    }
}

/// Income minus expense: revenue credit-positive, expense debit-negative.
fn earnings_of(rows: &[AggregateRow]) -> f64 {
    rows.iter()
        .fold(0.0, |total, r| total + (r.credit - r.debit))
}

/// `buildBalanceSheet(ledger, columns, fiscalYearStartOf)`: the sheet as of
/// each column's end; profit and loss never closed to equity shows as two
/// calculated equity rows (earlier fiscal years, this fiscal year).
#[allow(clippy::too_many_lines)] // one TypeScript builder
pub(crate) async fn build_balance_sheet(
    ledger: &Ledger,
    columns: &[ReportColumn],
    fiscal_year_start_of: impl Fn(&str) -> Result<String, ReportInputError>,
) -> Built<BalanceSheet> {
    let (by_column, ids) =
        totals_by_column(ledger, columns, &["asset", "liability", "equity"]).await?;

    let mut earnings: Vec<(String, f64, f64)> = Vec::new();
    for column in columns {
        let year_start = fiscal_year_start_of(&column.to)?;
        let before = add_days(&year_start, -1)
            .ok_or_else(|| ReportInputError::new(format!("Invalid date '{year_start}'")))?;
        let prior = ledger
            .aggregate(
                LedgerRange {
                    from: None,
                    to: parse_report_date(&before, Edge::End)?,
                },
                AggregateOptions::types(&["revenue", "expense"]),
            )
            .await?;
        let current = ledger
            .aggregate(
                LedgerRange {
                    from: Some(parse_report_date(&year_start, Edge::Start)?),
                    to: parse_report_date(&column.to, Edge::End)?,
                },
                AggregateOptions::types(&["revenue", "expense"]),
            )
            .await?;
        earnings.push((
            column.key.clone(),
            earnings_of(&prior),
            earnings_of(&current),
        ));
    }

    let rows: Vec<AccountRow> = sorted_accounts(ledger, &ids)
        .into_iter()
        .map(|account| {
            let debit_positive =
                account.account_type == "asset" || account.account_type == "expense";
            account_row(account, columns, &by_column, |t| match t {
                Some((debit, credit)) if debit_positive => debit - credit,
                Some((debit, credit)) => credit - debit,
                None => 0.0,
            })
        })
        .collect();

    let primary = primary_column(columns).clone();
    let calculated = |name: &str, subtype: &str, prior: bool| -> AccountRow {
        let amounts: Amounts = columns
            .iter()
            .map(|c| {
                let e = earnings.iter().find(|(k, _, _)| *k == c.key);
                (
                    c.key.clone(),
                    e.map_or(0.0, |(_, p, cur)| if prior { *p } else { *cur }),
                )
            })
            .collect();
        AccountRow {
            account_id: None,
            account_code: String::new(),
            account_name: name.to_owned(),
            account_type: "equity".to_owned(),
            account_subtype: Some(subtype.to_owned()),
            normal_side: "credit",
            section: None,
            is_virtual: true,
            total_debit: "0.00".to_owned(),
            total_credit: money(amount_of(&amounts, &primary.key)),
            balance: money(amount_of(&amounts, &primary.key)),
            set: value_set(columns, &amounts),
        }
    };

    let assets: Vec<AccountRow> = rows
        .iter()
        .filter(|r| r.account_type == "asset")
        .cloned()
        .collect();
    let liabilities: Vec<AccountRow> = rows
        .iter()
        .filter(|r| r.account_type == "liability")
        .cloned()
        .collect();
    let mut equity: Vec<AccountRow> = rows
        .iter()
        .filter(|r| r.account_type == "equity")
        .cloned()
        .collect();
    equity.push(calculated(
        "Retained earnings (earlier years)",
        "calculated_retained_earnings",
        true,
    ));
    equity.push(calculated(
        "Net income (this fiscal year)",
        "calculated_net_income",
        false,
    ));

    let sum_rows = |list: &[AccountRow]| -> Amounts {
        columns
            .iter()
            .map(|c| {
                (
                    c.key.clone(),
                    list.iter()
                        .fold(0.0, |total, r| total + r.set.number(&c.key)),
                )
            })
            .collect()
    };
    let total_assets = sum_rows(&assets);
    let total_liabilities = sum_rows(&liabilities);
    let total_equity = sum_rows(&equity);
    let liabilities_and_equity: Amounts = columns
        .iter()
        .map(|c| {
            (
                c.key.clone(),
                amount_of(&total_liabilities, &c.key) + amount_of(&total_equity, &c.key),
            )
        })
        .collect();

    let difference =
        amount_of(&total_assets, &primary.key) - amount_of(&liabilities_and_equity, &primary.key);
    Ok(BalanceSheet {
        basis: ledger.basis.as_str(),
        as_of: primary.to.clone(),
        columns: columns.to_vec(),
        assets,
        liabilities,
        equity,
        total_assets: money(amount_of(&total_assets, &primary.key)),
        total_liabilities: money(amount_of(&total_liabilities, &primary.key)),
        total_equity: money(amount_of(&total_equity, &primary.key)),
        total_liabilities_and_equity: money(amount_of(&liabilities_and_equity, &primary.key)),
        difference: money(difference),
        is_balanced: difference.abs() < 0.01,
        totals: vec![
            ("assets", value_set(columns, &total_assets)),
            ("liabilities", value_set(columns, &total_liabilities)),
            ("equity", value_set(columns, &total_equity)),
            (
                "liabilitiesAndEquity",
                value_set(columns, &liabilities_and_equity),
            ),
        ],
    })
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

/// `TrialBalanceRow`.
pub(crate) struct TrialBalanceRow {
    pub(crate) account_id: String,
    pub(crate) account_code: String,
    pub(crate) account_name: String,
    pub(crate) account_type: String,
    pub(crate) total_debit: String,
    pub(crate) total_credit: String,
    pub(crate) debit_balance: String,
    pub(crate) credit_balance: String,
    pub(crate) set: ValueSet,
}

/// `TrialBalanceReport`.
pub(crate) struct TrialBalance {
    pub(crate) basis: &'static str,
    pub(crate) period: DateRange,
    pub(crate) columns: Vec<ReportColumn>,
    pub(crate) accounts: Vec<TrialBalanceRow>,
    pub(crate) total_debit: String,
    pub(crate) total_credit: String,
    pub(crate) is_balanced: bool,
}

impl TrialBalance {
    pub(crate) fn json(&self) -> Value {
        let accounts: Vec<Value> = self
            .accounts
            .iter()
            .map(|a| {
                let mut object = Map::new();
                object.insert("accountId".to_owned(), json!(a.account_id));
                object.insert("accountCode".to_owned(), json!(a.account_code));
                object.insert("accountName".to_owned(), json!(a.account_name));
                object.insert("accountType".to_owned(), json!(a.account_type));
                object.insert("totalDebit".to_owned(), json!(a.total_debit));
                object.insert("totalCredit".to_owned(), json!(a.total_credit));
                object.insert("debitBalance".to_owned(), json!(a.debit_balance));
                object.insert("creditBalance".to_owned(), json!(a.credit_balance));
                a.set.write(&mut object);
                Value::Object(object)
            })
            .collect();
        json!({
            "basis": self.basis,
            "period": self.period.json(),
            "columns": columns_json(&self.columns),
            "accounts": accounts,
            "totalDebit": self.total_debit,
            "totalCredit": self.total_credit,
            "isBalanced": self.is_balanced,
        })
    }
}

/// `buildTrialBalance(ledger, columns, period)`.
pub(crate) async fn build_trial_balance(
    ledger: &Ledger,
    columns: &[ReportColumn],
    period: &DateRange,
) -> Built<TrialBalance> {
    let (by_column, ids) = totals_by_column(ledger, columns, &[]).await?;
    let primary = primary_column(columns);
    let rows: Vec<TrialBalanceRow> = sorted_accounts(ledger, &ids)
        .into_iter()
        .map(|account| {
            let own = totals_of(&by_column, &primary.key, &account.id);
            let net = own.map_or(0.0, |t| t.0) - own.map_or(0.0, |t| t.1);
            let amounts: Amounts = columns
                .iter()
                .map(|c| {
                    let t = totals_of(&by_column, &c.key, &account.id);
                    (
                        c.key.clone(),
                        t.map_or(0.0, |t| t.0) - t.map_or(0.0, |t| t.1),
                    )
                })
                .collect();
            TrialBalanceRow {
                account_id: account.id.clone(),
                account_code: account.code.clone(),
                account_name: account.name.clone(),
                account_type: account.account_type.clone(),
                total_debit: money(own.map_or(0.0, |t| t.0)),
                total_credit: money(own.map_or(0.0, |t| t.1)),
                debit_balance: money(if net > 0.0 { net } else { 0.0 }),
                credit_balance: money(if net < 0.0 { -net } else { 0.0 }),
                set: value_set(columns, &amounts),
            }
        })
        .collect();
    let total_debit = rows
        .iter()
        .fold(0.0, |t, r| t + parse_float(&r.total_debit));
    let total_credit = rows
        .iter()
        .fold(0.0, |t, r| t + parse_float(&r.total_credit));
    Ok(TrialBalance {
        basis: ledger.basis.as_str(),
        period: period.clone(),
        columns: columns.to_vec(),
        accounts: rows,
        total_debit: money(total_debit),
        total_credit: money(total_credit),
        is_balanced: (total_debit - total_credit).abs() < 0.01,
    })
}

// ---------------------------------------------------------------------------
// General ledger
// ---------------------------------------------------------------------------

/// A general ledger line as the report lists it.
pub(crate) struct GeneralLedgerLine {
    pub(crate) id: String,
    pub(crate) journal_entry_id: Option<String>,
    pub(crate) entry_number: Option<String>,
    pub(crate) entry_date: i64,
    pub(crate) entry_status: String,
    pub(crate) description: Option<String>,
    pub(crate) source_type: Option<String>,
    pub(crate) contact_id: Option<String>,
    pub(crate) payment_id: Option<String>,
    pub(crate) debit: String,
    pub(crate) credit: String,
    pub(crate) running_balance: String,
}

/// `GeneralLedgerReport`.
pub(crate) struct GeneralLedger {
    pub(crate) basis: &'static str,
    pub(crate) account: (String, String, String, &'static str),
    pub(crate) period: DateRange,
    pub(crate) opening_balance: String,
    pub(crate) closing_balance: String,
    pub(crate) total_debit: String,
    pub(crate) total_credit: String,
    pub(crate) lines: Vec<GeneralLedgerLine>,
    pub(crate) page: i64,
    pub(crate) page_size: i64,
    pub(crate) total_count: i64,
    pub(crate) total_pages: i64,
    pub(crate) has_more: bool,
}

impl GeneralLedger {
    pub(crate) fn json(&self) -> Value {
        let lines: Vec<Value> = self
            .lines
            .iter()
            .map(|l| {
                json!({
                    "id": l.id,
                    "journalEntryId": l.journal_entry_id,
                    "entryNumber": l.entry_number,
                    "entryDate": weldsuite_books_domain::reports_basis::iso(l.entry_date),
                    "entryStatus": l.entry_status,
                    "description": l.description,
                    "sourceType": l.source_type,
                    "contactId": l.contact_id,
                    "paymentId": l.payment_id,
                    "debit": l.debit,
                    "credit": l.credit,
                    "runningBalance": l.running_balance,
                })
            })
            .collect();
        json!({
            "basis": self.basis,
            "account": {
                "id": self.account.0,
                "code": self.account.1,
                "name": self.account.2,
                "normalSide": self.account.3,
            },
            "period": self.period.json(),
            "openingBalance": self.opening_balance,
            "closingBalance": self.closing_balance,
            "totalDebit": self.total_debit,
            "totalCredit": self.total_credit,
            "lines": lines,
            "pagination": {
                "page": self.page,
                "pageSize": self.page_size,
                "totalCount": self.total_count,
                "totalPages": self.total_pages,
                "hasMore": self.has_more,
            },
        })
    }
}

/// `buildGeneralLedger(ledger, accountId, period, paging)`; `None` when the
/// account isn't the entity's.
pub(crate) async fn build_general_ledger(
    ledger: &Ledger,
    account_id: &str,
    period: &DateRange,
    page: i64,
    page_size: i64,
) -> Built<Option<GeneralLedger>> {
    let Some(account) = ledger.account(account_id) else {
        return Ok(None);
    };
    let from = parse_report_date(&period.from, Edge::Start)?;
    let to = parse_report_date(&period.to, Edge::End)?;
    let before = ledger
        .aggregate(
            LedgerRange {
                from: None,
                to: from - 1,
            },
            AggregateOptions {
                account_ids: &[account_id],
                ..AggregateOptions::default()
            },
        )
        .await?;
    let opening = before
        .iter()
        .fold(0.0, |total, r| total + r.debit - r.credit);
    let all = ledger
        .account_lines(
            account_id,
            LedgerRange {
                from: Some(from),
                to,
            },
        )
        .await?;

    let mut running = opening;
    let mut with_balance: Vec<(usize, f64)> = Vec::with_capacity(all.len());
    for (i, line) in all.iter().enumerate() {
        running = weldsuite_books_domain::js::round_money(running + line.debit - line.credit);
        with_balance.push((i, running));
    }
    let total_debit = all.iter().fold(0.0, |t, l| t + l.debit);
    let total_credit = all.iter().fold(0.0, |t, l| t + l.credit);

    let total_count = i64::try_from(all.len()).unwrap_or(i64::MAX);
    // `Math.ceil(totalCount / pageSize)`.
    let total_pages = if total_count == 0 {
        0
    } else {
        (total_count - 1) / page_size + 1
    };
    let start = usize::try_from((page - 1).saturating_mul(page_size)).unwrap_or(usize::MAX);
    let end = usize::try_from(page.saturating_mul(page_size)).unwrap_or(usize::MAX);
    let lines = with_balance
        .iter()
        .skip(start)
        .take(end.saturating_sub(start))
        .map(|&(i, balance)| {
            let line = &all[i];
            GeneralLedgerLine {
                id: line.id.clone(),
                journal_entry_id: line.journal_entry_id.clone(),
                entry_number: line.entry_number.clone(),
                entry_date: line.entry_date,
                entry_status: line.entry_status.clone(),
                description: line.description.clone(),
                source_type: line.source_type.clone(),
                contact_id: line.contact_id.clone(),
                payment_id: line.payment_id.clone(),
                debit: money(line.debit),
                credit: money(line.credit),
                running_balance: money(balance),
            }
        })
        .collect();

    Ok(Some(GeneralLedger {
        basis: ledger.basis.as_str(),
        account: (
            account.id.clone(),
            account.code.clone(),
            account.name.clone(),
            account.normal_side,
        ),
        period: period.clone(),
        opening_balance: money(opening),
        closing_balance: money(opening + total_debit - total_credit),
        total_debit: money(total_debit),
        total_credit: money(total_credit),
        lines,
        page,
        page_size,
        total_count,
        total_pages,
        has_more: page < total_pages,
    }))
}

// ---------------------------------------------------------------------------
// Revenue by customer, expense by category
// ---------------------------------------------------------------------------

/// A customer's revenue: `{ contactId, contactName, totalRevenue }`.
pub(crate) struct CustomerRevenue {
    pub(crate) contact_id: String,
    pub(crate) contact_name: Option<String>,
    pub(crate) total_revenue: String,
}

/// `buildRevenueByCustomer(db, ledger, range)`.
pub(crate) async fn build_revenue_by_customer(
    db: &PgPool,
    ledger: &Ledger,
    range: LedgerRange,
) -> Built<(Vec<CustomerRevenue>, String)> {
    let rows = ledger
        .aggregate(
            range,
            AggregateOptions {
                account_types: &["revenue"],
                by_contact: true,
                ..AggregateOptions::default()
            },
        )
        .await?;
    let mut by_contact: Vec<(String, f64)> = Vec::new();
    for r in rows {
        let Some(contact_id) = r.contact_id.filter(|id| !id.is_empty()) else {
            continue;
        };
        if let Some(entry) = by_contact.iter_mut().find(|(id, _)| *id == contact_id) {
            entry.1 = entry.1 + r.credit - r.debit;
        } else {
            by_contact.push((contact_id, 0.0 + r.credit - r.debit));
        }
    }
    let ids: Vec<String> = by_contact.iter().map(|(id, _)| id.clone()).collect();
    let mut names: HashMap<String, Option<String>> = HashMap::new();
    for chunk in ids.chunks(400) {
        let parties: Vec<(String, Option<String>)> =
            sqlx::query_as("select id, display_name from parties where id = any($1::text[])")
                .bind(chunk)
                .fetch_all(db)
                .await?;
        names.extend(parties);
    }
    let mut customers: Vec<CustomerRevenue> = by_contact
        .iter()
        .map(|(contact_id, total)| CustomerRevenue {
            contact_name: names.get(contact_id).cloned().flatten(),
            contact_id: contact_id.clone(),
            total_revenue: money(*total),
        })
        .collect();
    customers.sort_by(|a, b| {
        parse_float(&b.total_revenue)
            .partial_cmp(&parse_float(&a.total_revenue))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let grand_total = by_contact.iter().fold(0.0, |t, (_, v)| t + v);
    Ok((customers, money(grand_total)))
}

/// An expense account's total: `{ accountId, accountCode, accountName, totalExpense }`.
pub(crate) struct ExpenseCategory {
    pub(crate) account_id: String,
    pub(crate) account_code: String,
    pub(crate) account_name: String,
    pub(crate) total_expense: String,
}

/// `buildExpenseByCategory(ledger, range)`.
pub(crate) async fn build_expense_by_category(
    ledger: &Ledger,
    range: LedgerRange,
) -> Built<(Vec<ExpenseCategory>, String)> {
    let rows = ledger
        .aggregate(range, AggregateOptions::types(&["expense"]))
        .await?;
    let mut categories = Vec::with_capacity(rows.len());
    for r in &rows {
        // `ledger.accounts.get(r.accountId)!`: a deleted account throws.
        let account = ledger.account(&r.account_id).ok_or_else(|| {
            BuildError::Internal(format!("account {} is not in the chart", r.account_id))
        })?;
        categories.push(ExpenseCategory {
            account_id: r.account_id.clone(),
            account_code: account.code.clone(),
            account_name: account.name.clone(),
            total_expense: money(r.debit - r.credit),
        });
    }
    categories.sort_by(|a, b| {
        parse_float(&b.total_expense)
            .partial_cmp(&parse_float(&a.total_expense))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let grand_total = rows.iter().fold(0.0, |t, r| t + r.debit - r.credit);
    Ok((categories, money(grand_total)))
}

// ---------------------------------------------------------------------------
// Aged receivables and payables
// ---------------------------------------------------------------------------

pub(crate) const BUCKETS: [&str; 5] = ["current", "1-30", "31-60", "61-90", "90+"];

/// `bucketOf(daysPastDue)`.
fn bucket_of(days_past_due: i64) -> &'static str {
    match days_past_due {
        i64::MIN..=0 => "current",
        1..=30 => "1-30",
        31..=60 => "31-60",
        61..=90 => "61-90",
        _ => "90+",
    }
}

/// `AgedDocument`.
pub(crate) struct AgedDocument {
    pub(crate) id: String,
    pub(crate) number: Option<String>,
    pub(crate) contact_id: Value,
    pub(crate) contact_name: Option<String>,
    pub(crate) issue_date: String,
    pub(crate) due_date: String,
    pub(crate) days_past_due: i64,
    pub(crate) bucket: &'static str,
    pub(crate) balance: String,
}

/// An aged contact: totals by bucket.
pub(crate) struct AgedContact {
    pub(crate) contact_id: Value,
    pub(crate) contact_name: Option<String>,
    pub(crate) total: String,
    pub(crate) buckets: [String; 5],
}

/// `AgedReport`.
pub(crate) struct AgedReport {
    pub(crate) as_of: String,
    pub(crate) buckets: [(String, i64); 5],
    pub(crate) total: String,
    pub(crate) contacts: Vec<AgedContact>,
    pub(crate) documents: Vec<AgedDocument>,
}

impl AgedReport {
    pub(crate) fn documents_json(&self) -> Value {
        Value::Array(
            self.documents
                .iter()
                .map(|d| {
                    json!({
                        "id": d.id,
                        "number": d.number,
                        "contactId": d.contact_id,
                        "contactName": d.contact_name,
                        "issueDate": d.issue_date,
                        "dueDate": d.due_date,
                        "daysPastDue": d.days_past_due,
                        "bucket": d.bucket,
                        "balance": d.balance,
                    })
                })
                .collect(),
        )
    }

    /// The buckets in their order (clients read `Object.keys`), each laid
    /// out by `pick(total, count)`.
    pub(crate) fn buckets_ordered(
        &self,
        pick: impl Fn(&str, i64) -> Value,
    ) -> crate::ordered::Json {
        crate::ordered::Json::object(
            BUCKETS
                .iter()
                .zip(&self.buckets)
                .map(|(b, (total, count))| (*b, crate::ordered::Json::from(pick(total, *count)))),
        )
    }

    /// `{ current: { total, count }, '1-30': … }`, in bucket order.
    pub(crate) fn aging(&self) -> crate::ordered::Json {
        self.buckets_ordered(|total, count| json!({ "total": total, "count": count }))
    }

    fn contacts_ordered(&self) -> crate::ordered::Json {
        use crate::ordered::Json;
        Json::Array(
            self.contacts
                .iter()
                .map(|c| {
                    let mut entries = vec![
                        ("contactId", Json::from(c.contact_id.clone())),
                        ("contactName", Json::from(json!(c.contact_name))),
                        ("total", Json::from(json!(c.total))),
                    ];
                    for (bucket, value) in BUCKETS.iter().zip(&c.buckets) {
                        entries.push((bucket, Json::from(json!(value))));
                    }
                    Json::object(entries)
                })
                .collect(),
        )
    }

    pub(crate) fn json(&self) -> crate::ordered::Json {
        use crate::ordered::Json;
        Json::object([
            ("asOf", Json::from(json!(self.as_of))),
            ("buckets", self.aging()),
            ("total", Json::from(json!(self.total))),
            ("contacts", self.contacts_ordered()),
            ("documents", Json::from(self.documents_json())),
        ])
    }
}

/// `balanceInBase(balance, doc, baseCurrency)`: foreign units per base unit,
/// so base = balance / rate.
pub(crate) fn balance_in_base(
    balance: f64,
    currency: Option<&str>,
    exchange_rate: Option<&str>,
    base_currency: &str,
) -> f64 {
    match currency {
        None | Some("") => return balance,
        Some(c) if c == base_currency => return balance,
        Some(_) => {}
    }
    let rate = parse_float(exchange_rate.unwrap_or("1"));
    if rate.is_finite() && rate > 0.0 {
        weldsuite_books_domain::currency::to_base_currency(balance, rate)
    } else {
        balance
    }
}

fn day_of(row: &Value, key: &str) -> Built<String> {
    row.get(key)
        .and_then(Value::as_str)
        .map(|iso| iso.chars().take(10).collect())
        .ok_or_else(|| BuildError::Internal(format!("{key} is not a date")))
}

/// `buildAgedReport(db, entityId, kind, asOf)`: open invoices (receivables)
/// or bills (payables) aged by due date, in the entity's base currency.
#[allow(clippy::too_many_lines)] // one TypeScript builder
pub(crate) async fn build_aged_report(
    db: &PgPool,
    entity_id: &str,
    receivables: bool,
    as_of: &str,
) -> Built<AgedReport> {
    let base: Option<String> =
        sqlx::query_scalar("select base_currency from entities where id = $1 limit 1")
            .bind(entity_id)
            .fetch_optional(db)
            .await?;
    let base_currency = base.unwrap_or_else(|| "EUR".to_owned());

    let rows: Vec<Value> = if receivables {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(invoices),
            " from invoices t where t.entity_id = $1 and t.deleted_at is null \
             and t.status not in ('draft', 'cancelled', 'void', 'paid', 'uncollectible', 'written_off') \
             and t.type not in ('proforma') and t.balance_due::numeric <> 0 order by t.due_date"
        ))
        .bind(entity_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|row| weldsuite_books_domain::tables::INVOICES.js(row))
        .collect()
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bills),
            " from bills t where t.entity_id = $1 and t.deleted_at is null \
             and t.status not in ('draft', 'cancelled', 'void', 'paid', 'uncollectible', 'written_off') \
             and t.balance_due::numeric <> 0 order by t.due_date"
        ))
        .bind(entity_id)
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|row| weldsuite_books_domain::tables::BILLS.js(row))
        .collect()
    };
    let rows = weldsuite_books_domain::contacts::with_contact_names(db, rows).await?;

    let number_key = if receivables {
        "invoiceNumber"
    } else {
        "billNumber"
    };
    let mut documents = Vec::with_capacity(rows.len());
    for r in &rows {
        let sign = if r.get("type").and_then(Value::as_str) == Some("credit_note") {
            -1.0
        } else {
            1.0
        };
        let due_date = day_of(r, "dueDate")?;
        let days = diff_days(&due_date, as_of)
            .ok_or_else(|| BuildError::Internal(format!("Invalid date '{due_date}'")))?;
        let balance_due = parse_float(r.get("balanceDue").and_then(Value::as_str).unwrap_or("0"));
        documents.push(AgedDocument {
            id: r["id"].as_str().unwrap_or_default().to_owned(),
            number: r.get(number_key).and_then(Value::as_str).map(str::to_owned),
            contact_id: r.get("contactId").cloned().unwrap_or(Value::Null),
            contact_name: r
                .get("contactName")
                .and_then(Value::as_str)
                .map(str::to_owned),
            issue_date: day_of(r, "issueDate")?,
            due_date,
            days_past_due: days,
            bucket: bucket_of(days),
            balance: money(
                sign * balance_in_base(
                    balance_due,
                    r.get("currency").and_then(Value::as_str),
                    r.get("exchangeRate").and_then(Value::as_str),
                    &base_currency,
                ),
            ),
        });
    }

    let mut bucket_totals = [(0.0_f64, 0_i64); 5];
    let mut contacts: Vec<(Value, Option<String>, f64, [f64; 5])> = Vec::new();
    for d in &documents {
        let amount = parse_float(&d.balance);
        let at = BUCKETS.iter().position(|b| *b == d.bucket).unwrap_or(0);
        bucket_totals[at].0 += amount;
        bucket_totals[at].1 += 1;
        let index = contacts.iter().position(|c| c.0 == d.contact_id);
        let i = index.unwrap_or_else(|| {
            contacts.push((d.contact_id.clone(), d.contact_name.clone(), 0.0, [0.0; 5]));
            contacts.len() - 1
        });
        let contact = &mut contacts[i];
        contact.3[at] += amount;
        contact.2 += amount;
    }
    contacts.sort_by(|a, b| {
        locale_compare(
            a.1.as_deref().unwrap_or_default(),
            b.1.as_deref().unwrap_or_default(),
        )
    });

    let total = bucket_totals.iter().fold(0.0, |t, (v, _)| t + v);
    Ok(AgedReport {
        as_of: as_of.to_owned(),
        buckets: bucket_totals.map(|(total, count)| (money(total), count)),
        total: money(total),
        contacts: contacts
            .into_iter()
            .map(|(contact_id, contact_name, total, buckets)| AgedContact {
                contact_id,
                contact_name,
                total: money(total),
                buckets: buckets.map(money),
            })
            .collect(),
        documents,
    })
}
