//! The cash flow report, from the ledger (`services/accounting-cash-flow.ts`).
//!
//! The cash accounts are the asset accounts of subtype `bank` or `cash` plus
//! the GL account behind each bank account. An entry that moves one of them
//! is a cash movement; its other lines say what the money was for (direct
//! method): operating (customer receipts, supplier payments, expenses,
//! taxes, payroll, other), investing (fixed assets), financing (equity,
//! loans). Moves between two cash accounts cancel out.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::js::{parse_float, round_money};
use weldsuite_books_domain::reports_basis::{
    DateRange, Edge, iso, money, numeric_compare, parse_report_date,
};

use super::build::Built;

/// `CASH_FLOW_CATEGORIES`, in order, with their activity.
const CATEGORIES: [(&str, &str); 9] = [
    ("customer_receipts", "operating"),
    ("supplier_payments", "operating"),
    ("operating_expenses", "operating"),
    ("taxes", "operating"),
    ("payroll", "operating"),
    ("other_operating", "operating"),
    ("fixed_assets", "investing"),
    ("equity", "financing"),
    ("loans", "financing"),
];

const ACTIVITIES: [&str; 3] = ["operating", "investing", "financing"];

/// `CashFlowFigures`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Figures {
    pub(crate) inflows: String,
    pub(crate) outflows: String,
    pub(crate) net: String,
}

impl Figures {
    fn zero() -> Self {
        Self {
            inflows: "0.00".to_owned(),
            outflows: "0.00".to_owned(),
            net: "0.00".to_owned(),
        }
    }

    fn json_with(&self, key: &str, value: &str) -> Value {
        json!({ key: value, "inflows": self.inflows, "outflows": self.outflows, "net": self.net })
    }

    pub(crate) fn json(&self) -> Value {
        json!({ "inflows": self.inflows, "outflows": self.outflows, "net": self.net })
    }
}

/// `CashFlowActivityBlock`.
#[derive(Debug, Clone)]
pub(crate) struct ActivityBlock {
    pub(crate) activity: &'static str,
    pub(crate) figures: Figures,
    pub(crate) categories: Vec<(&'static str, Figures)>,
}

/// `CashFlowResult`.
#[derive(Debug, Clone)]
pub(crate) struct CashFlow {
    pub(crate) period: DateRange,
    pub(crate) opening_balance: String,
    pub(crate) closing_balance: String,
    pub(crate) monthly: Vec<(String, Figures)>,
    pub(crate) totals: Figures,
    pub(crate) activities: Vec<ActivityBlock>,
    /// `{ accountId, accountCode, accountName, openingBalance, closingBalance, net }`.
    pub(crate) cash_accounts: Vec<Value>,
}

impl CashFlow {
    pub(crate) fn json(&self) -> Value {
        json!({
            "period": self.period.json(),
            "openingBalance": self.opening_balance,
            "closingBalance": self.closing_balance,
            "monthly": self.monthly.iter().map(|(m, f)| f.json_with("month", m)).collect::<Vec<_>>(),
            "totals": self.totals.json(),
            "activities": self.activities.iter().map(|b| {
                let mut block = b.figures.json_with("activity", b.activity);
                block["categories"] = Value::Array(
                    b.categories.iter().map(|(c, f)| f.json_with("category", c)).collect(),
                );
                block
            }).collect::<Vec<_>>(),
            "cashAccounts": self.cash_accounts,
        })
    }
}

/// A counterpart account: type, subtype, name, system role.
struct Counterpart {
    account_type: String,
    subtype: Option<String>,
    name: String,
    system_role: Option<String>,
}

fn matches_ci(value: &str, options: &[&str]) -> bool {
    options.iter().any(|o| value.eq_ignore_ascii_case(o))
}

/// `classifyCounterpart(account)`: what a counterpart account says the money
/// was for.
fn classify(account: &Counterpart) -> &'static str {
    let subtype = account.subtype.as_deref().unwrap_or_default();
    let role = account.system_role.as_deref().unwrap_or_default();
    let role_lower = role.to_ascii_lowercase();
    let name_lower = account.name.to_ascii_lowercase();

    if role_lower.starts_with("payroll") || subtype.eq_ignore_ascii_case("payroll") {
        return "payroll";
    }
    // TAX_SUBTYPE /^(tax|tax_payable|tax_expense)$/i,
    // TAX_ROLE /(?:^tax_|tax_payable|sales_tax|use_tax|vat|backup_withholding)/i
    if matches_ci(subtype, &["tax", "tax_payable", "tax_expense"])
        || role_lower.starts_with("tax_")
        || [
            "tax_payable",
            "sales_tax",
            "use_tax",
            "vat",
            "backup_withholding",
        ]
        .iter()
        .any(|p| role_lower.contains(p))
    {
        return "taxes";
    }
    if account.account_type == "equity" {
        return "equity";
    }
    if account.account_type == "asset"
        && matches_ci(
            subtype,
            &[
                "fixed_asset",
                "fixed_assets",
                "intangible_asset",
                "intangible_assets",
                "property_plant_equipment",
            ],
        )
    {
        return "fixed_assets";
    }
    if account.account_type == "liability"
        && (matches_ci(
            subtype,
            &[
                "long_term_liability",
                "loan",
                "loans",
                "notes_payable",
                "mortgage",
            ],
        ) || ["lening", "loan", "mortgage", "hypotheek", "borrowing"]
            .iter()
            .any(|p| name_lower.contains(p)))
    {
        return "loans";
    }
    if account.account_type == "revenue" {
        return if matches_ci(subtype, &["other_income", "interest_income"]) {
            "other_operating"
        } else {
            "customer_receipts"
        };
    }
    if account.account_type == "expense" {
        return "operating_expenses";
    }
    if subtype == "accounts_receivable"
        || role == "accounts_receivable"
        || role == "undeposited_funds"
    {
        return "customer_receipts";
    }
    if subtype == "accounts_payable"
        || role == "accounts_payable"
        || subtype == "inventory"
        || subtype == "prepaid_expense"
    {
        return "supplier_payments";
    }
    "other_operating"
}

#[derive(Debug, Clone, Copy, Default)]
struct Bucket {
    inflows: f64,
    outflows: f64,
}

impl Bucket {
    fn add(&mut self, amount: f64) {
        if amount > 0.0 {
            self.inflows += amount;
        } else {
            self.outflows -= amount;
        }
    }

    fn figures(self) -> Figures {
        Figures {
            inflows: money(self.inflows),
            outflows: money(self.outflows),
            net: money(self.inflows - self.outflows),
        }
    }
}

fn empty_cash_flow(range: &DateRange) -> CashFlow {
    CashFlow {
        period: range.clone(),
        opening_balance: "0.00".to_owned(),
        closing_balance: "0.00".to_owned(),
        monthly: Vec::new(),
        totals: Figures::zero(),
        activities: ACTIVITIES
            .iter()
            .map(|activity| ActivityBlock {
                activity,
                figures: Figures::zero(),
                categories: CATEGORIES
                    .iter()
                    .filter(|(_, a)| a == activity)
                    .map(|(c, _)| (*c, Figures::zero()))
                    .collect(),
            })
            .collect(),
        cash_accounts: Vec::new(),
    }
}

/// `cashAccountsOf(db, entityId)`: `(id, code, name)` of the cash and bank
/// ledger accounts.
async fn cash_accounts_of(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<(String, String, String)>, sqlx::Error> {
    let linked: Vec<Option<String>> = sqlx::query_scalar(
        "select ledger_account_id from bank_accounts where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let linked: Vec<String> = linked
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .collect();
    let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        "select id, code, name, type, subtype from accounts where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(id, _, _, kind, subtype)| {
            kind == "asset"
                && (matches!(subtype.as_deref(), Some("bank" | "cash")) || linked.contains(id))
        })
        .map(|(id, code, name, _, _)| (id, code, name))
        .collect())
}

type LineRow = (String, i64, String, String, String);

/// id, type, subtype, name, metadata of a counterpart account.
type CounterpartRow = (String, String, Option<String>, String, Option<Value>);

/// An entry's non-cash lines: entry id, date, (account, amount) pairs.
type EntryLines = (String, i64, Vec<(String, f64)>);

/// `buildCashFlow(db, entityId, range)`.
#[allow(clippy::too_many_lines)] // one TypeScript builder with its helpers
pub(crate) async fn build_cash_flow(
    db: &PgPool,
    entity_id: &str,
    range: &DateRange,
) -> Built<CashFlow> {
    let from = parse_report_date(&range.from, Edge::Start)?;
    let to = parse_report_date(&range.to, Edge::End)?;

    let cash_accounts = cash_accounts_of(db, entity_id).await?;
    let cash_ids: Vec<String> = cash_accounts.iter().map(|(id, _, _)| id.clone()).collect();
    if cash_ids.is_empty() {
        return Ok(empty_cash_flow(range));
    }

    // Opening and closing balance per cash account, straight from the ledger.
    let balance_rows: Vec<(String, String, String)> = sqlx::query_as(
        "select jl.account_id, \
         coalesce(sum(case when je.date < $2::timestamp then jl.debit::numeric - jl.credit::numeric else 0 end), 0)::text, \
         coalesce(sum(jl.debit::numeric - jl.credit::numeric), 0)::text \
         from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id \
         where jl.entity_id = $1 and jl.deleted_at is null and je.deleted_at is null \
         and je.status in ('posted', 'reversed') and jl.account_id = any($3::text[]) \
         and je.date <= $4::timestamp group by jl.account_id",
    )
    .bind(entity_id)
    .bind(iso(from))
    .bind(&cash_ids)
    .bind(iso(to))
    .fetch_all(db)
    .await?;
    let balances: HashMap<String, (f64, f64)> = balance_rows
        .iter()
        .map(|(id, opening, closing)| (id.clone(), (parse_float(opening), parse_float(closing))))
        .collect();

    // Every line of every entry in the period that moves a cash account.
    let line_rows: Vec<LineRow> = sqlx::query_as(
        "select je.id, floor(extract(epoch from je.date) * 1000)::bigint, jl.account_id, \
         coalesce(sum(jl.debit::numeric), 0)::text, coalesce(sum(jl.credit::numeric), 0)::text \
         from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id \
         where jl.entity_id = $1 and jl.deleted_at is null and je.deleted_at is null \
         and je.status in ('posted', 'reversed') and je.date >= $2::timestamp and je.date <= $3::timestamp \
         and exists (select 1 from journal_lines as cash_line where cash_line.journal_entry_id = je.id \
         and cash_line.deleted_at is null and cash_line.account_id = any($4::text[])) \
         group by je.id, je.date, jl.account_id",
    )
    .bind(entity_id)
    .bind(iso(from))
    .bind(iso(to))
    .bind(&cash_ids)
    .fetch_all(db)
    .await?;

    let mut counterpart_ids: Vec<String> = Vec::new();
    for (_, _, account_id, _, _) in &line_rows {
        if !cash_ids.contains(account_id) && !counterpart_ids.contains(account_id) {
            counterpart_ids.push(account_id.clone());
        }
    }
    let mut info: HashMap<String, Counterpart> = HashMap::new();
    for chunk in counterpart_ids.chunks(400) {
        let rows: Vec<CounterpartRow> = sqlx::query_as(
            "select id, type, subtype, name, metadata from accounts where id = any($1::text[])",
        )
        .bind(chunk)
        .fetch_all(db)
        .await?;
        for (id, account_type, subtype, name, metadata) in rows {
            let system_role = metadata
                .as_ref()
                .and_then(|m| m.get("systemRole"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            info.insert(
                id,
                Counterpart {
                    account_type,
                    subtype,
                    name,
                    system_role,
                },
            );
        }
    }

    // The non-cash lines of each entry, by entry, in first-seen order.
    let mut entries: Vec<EntryLines> = Vec::new();
    let mut entry_at: HashMap<String, usize> = HashMap::new();
    for (entry_id, date, account_id, debit, credit) in &line_rows {
        if cash_ids.contains(account_id) {
            continue;
        }
        let at = *entry_at.entry(entry_id.clone()).or_insert_with(|| {
            entries.push((entry_id.clone(), *date, Vec::new()));
            entries.len() - 1
        });
        // Positive pays cash in (credit), negative takes it out (debit).
        entries[at].2.push((
            account_id.clone(),
            weldsuite_kit::validation::js_number(credit)
                - weldsuite_kit::validation::js_number(debit),
        ));
    }

    let mut category_totals: HashMap<&'static str, Bucket> = HashMap::new();
    let mut month_totals: Vec<(String, Bucket)> = Vec::new();
    let mut total = Bucket::default();
    for (_, date, lines) in &entries {
        let month: String = iso(*date).chars().take(7).collect();
        // One entry, one category: opposite lines of the same category net off.
        let mut per_category: Vec<(&'static str, f64)> = Vec::new();
        for (account_id, amount) in lines {
            let category = info.get(account_id).map_or("other_operating", classify);
            if let Some(entry) = per_category.iter_mut().find(|(c, _)| *c == category) {
                entry.1 += amount;
            } else {
                per_category.push((category, 0.0 + amount));
            }
        }
        for (category, amount) in per_category {
            let rounded = round_money(amount);
            if rounded.abs() < 0.005 {
                continue;
            }
            category_totals.entry(category).or_default().add(rounded);
            if let Some(entry) = month_totals.iter_mut().find(|(m, _)| *m == month) {
                entry.1.add(rounded);
            } else {
                let mut bucket = Bucket::default();
                bucket.add(rounded);
                month_totals.push((month.clone(), bucket));
            }
            total.add(rounded);
        }
    }

    let activities: Vec<ActivityBlock> = ACTIVITIES
        .iter()
        .map(|activity| {
            let members: Vec<&str> = CATEGORIES
                .iter()
                .filter(|(_, a)| a == activity)
                .map(|(c, _)| *c)
                .collect();
            let categories = members
                .iter()
                .map(|c| {
                    (
                        *c,
                        category_totals
                            .get(c)
                            .copied()
                            .unwrap_or_default()
                            .figures(),
                    )
                })
                .collect();
            let mut block = Bucket::default();
            for c in &members {
                if let Some(t) = category_totals.get(c) {
                    block.inflows += t.inflows;
                    block.outflows += t.outflows;
                }
            }
            ActivityBlock {
                activity,
                figures: block.figures(),
                categories,
            }
        })
        .collect();

    // `[...balances.values()]` follows the query's row order.
    let opening = balance_rows.iter().fold(0.0, |sum, (id, _, _)| {
        sum + balances.get(id).map_or(0.0, |b| b.0)
    });
    let closing = balance_rows.iter().fold(0.0, |sum, (id, _, _)| {
        sum + balances.get(id).map_or(0.0, |b| b.1)
    });

    month_totals.sort_by(|a, b| weldsuite_books_domain::js::locale_compare(&a.0, &b.0));
    let mut cash_rows: Vec<(String, String, String, f64, f64)> = cash_accounts
        .into_iter()
        .map(|(id, code, name)| {
            let (o, c) = balances.get(&id).copied().unwrap_or((0.0, 0.0));
            (id, code, name, o, c)
        })
        .collect();
    cash_rows.sort_by(|a, b| numeric_compare(&a.1, &b.1));

    Ok(CashFlow {
        period: range.clone(),
        opening_balance: money(opening),
        closing_balance: money(closing),
        monthly: month_totals
            .into_iter()
            .map(|(month, bucket)| (month, bucket.figures()))
            .collect(),
        totals: total.figures(),
        activities,
        cash_accounts: cash_rows
            .into_iter()
            .map(|(id, code, name, o, c)| {
                json!({
                    "accountId": id,
                    "accountCode": code,
                    "accountName": name,
                    "openingBalance": money(o),
                    "closingBalance": money(c),
                    "net": money(c - o),
                })
            })
            .collect(),
    })
}
