//! The balance sheet of a jaarrekening, from the ledger: every asset,
//! liability and equity account's balance at the year end, sorted into the
//! publication's lines, with the profit and loss never closed to equity as
//! the result for the year (this financial year) and other reserves (earlier
//! years).
//!
//! The chart carries account types and subtypes but no RGS codes, so the
//! finer lines (intangible against tangible fixed assets, provisions, long
//! against short term debt, the equity reserves) come from the Dutch chart's
//! code ranges and the account names. The figures are a proposal: the user
//! reviews them, and every line can be corrected before filing.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};
use weldsuite_books_domain::reports_basis::{
    AggregateOptions, AggregateRow, Edge, Ledger, LedgerAccount, LedgerRange, ReportInputError,
    parse_report_date,
};

/// A line of the publication balance sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Item {
    IntangibleAssets,
    TangibleAssets,
    FinancialAssets,
    Inventories,
    Receivables,
    Securities,
    Cash,
    ShareCapital,
    SharePremium,
    RevaluationReserve,
    LegalReserves,
    StatutoryReserves,
    OtherReserves,
    ResultForTheYear,
    Provisions,
    LongTermLiabilities,
    CurrentLiabilities,
}

impl Item {
    pub(crate) const ALL: [Item; 17] = [
        Self::IntangibleAssets,
        Self::TangibleAssets,
        Self::FinancialAssets,
        Self::Inventories,
        Self::Receivables,
        Self::Securities,
        Self::Cash,
        Self::ShareCapital,
        Self::SharePremium,
        Self::RevaluationReserve,
        Self::LegalReserves,
        Self::StatutoryReserves,
        Self::OtherReserves,
        Self::ResultForTheYear,
        Self::Provisions,
        Self::LongTermLiabilities,
        Self::CurrentLiabilities,
    ];

    /// The line's key in `figures.current` / `figures.prior`.
    pub(crate) fn key(self) -> &'static str {
        match self {
            Self::IntangibleAssets => "intangibleAssets",
            Self::TangibleAssets => "tangibleAssets",
            Self::FinancialAssets => "financialAssets",
            Self::Inventories => "inventories",
            Self::Receivables => "receivables",
            Self::Securities => "securities",
            Self::Cash => "cash",
            Self::ShareCapital => "shareCapital",
            Self::SharePremium => "sharePremium",
            Self::RevaluationReserve => "revaluationReserve",
            Self::LegalReserves => "legalReserves",
            Self::StatutoryReserves => "statutoryReserves",
            Self::OtherReserves => "otherReserves",
            Self::ResultForTheYear => "resultForTheYear",
            Self::Provisions => "provisions",
            Self::LongTermLiabilities => "longTermLiabilities",
            Self::CurrentLiabilities => "currentLiabilities",
        }
    }

    pub(crate) fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.key() == key)
    }
}

/// The amount of every line, in euros.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Lines(pub BTreeMap<Item, f64>);

/// Rounds to cents.
fn cents(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

impl Lines {
    pub(crate) fn get(&self, item: Item) -> f64 {
        self.0.get(&item).copied().unwrap_or(0.0)
    }

    fn add(&mut self, item: Item, amount: f64) {
        *self.0.entry(item).or_insert(0.0) += amount;
    }

    pub(crate) fn sum(&self, items: &[Item]) -> f64 {
        items.iter().map(|item| self.get(*item)).sum()
    }

    pub(crate) fn fixed_assets(&self) -> f64 {
        self.sum(&[
            Item::IntangibleAssets,
            Item::TangibleAssets,
            Item::FinancialAssets,
        ])
    }

    pub(crate) fn current_assets(&self) -> f64 {
        self.sum(&[
            Item::Inventories,
            Item::Receivables,
            Item::Securities,
            Item::Cash,
        ])
    }

    pub(crate) fn assets(&self) -> f64 {
        self.fixed_assets() + self.current_assets()
    }

    pub(crate) fn equity(&self) -> f64 {
        self.sum(&[
            Item::ShareCapital,
            Item::SharePremium,
            Item::RevaluationReserve,
            Item::LegalReserves,
            Item::StatutoryReserves,
            Item::OtherReserves,
            Item::ResultForTheYear,
        ])
    }

    pub(crate) fn liabilities(&self) -> f64 {
        self.sum(&[Item::LongTermLiabilities, Item::CurrentLiabilities])
    }

    pub(crate) fn equity_and_liabilities(&self) -> f64 {
        self.equity() + self.get(Item::Provisions) + self.liabilities()
    }

    /// Every line (zeros too), as `{ key: amount }`.
    pub(crate) fn to_json(&self) -> Value {
        Value::Object(
            Item::ALL
                .into_iter()
                .map(|item| (item.key().to_owned(), json!(cents(self.get(item)))))
                .collect(),
        )
    }

    /// The lines of a stored `figures.current` / `.prior`; unknown keys and
    /// non-numbers are skipped.
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let mut lines = Self::default();
        for (key, amount) in object {
            if let (Some(item), Some(amount)) = (Item::from_key(key), amount.as_f64())
                && amount.is_finite()
            {
                lines.0.insert(item, amount);
            }
        }
        Some(lines)
    }

    /// Whole euros, as the publication states them, with the rounding
    /// difference (at most half a euro per line) taken into other reserves so
    /// the sheet still balances.
    pub(crate) fn rounded(&self) -> Self {
        let mut rounded = Self(
            self.0
                .iter()
                .map(|(item, amount)| (*item, amount.round()))
                .collect(),
        );
        let balanced = (self.assets() - self.equity_and_liabilities()).abs() < 0.005;
        let difference = rounded.assets() - rounded.equity_and_liabilities();
        if balanced && difference != 0.0 {
            rounded.add(Item::OtherReserves, difference);
        }
        rounded
    }
}

/// Lower case for the name checks.
fn named(account: &LedgerAccount, words: &[&str]) -> bool {
    let name = account.name.to_lowercase();
    words.iter().any(|word| name.contains(word))
}

/// The line an account's balance goes to; `None` for revenue and expense
/// accounts (they make up the result).
pub(crate) fn classify(account: &LedgerAccount) -> Option<Item> {
    let code = account.code.as_str();
    let subtype = account.subtype.as_deref().unwrap_or_default();
    match account.account_type.as_str() {
        "asset" => Some(match subtype {
            "bank" | "cash" => Item::Cash,
            "fixed_assets" | "fixed_asset" | "non_current_assets" => {
                if code.starts_with("01") || named(account, &["immateri", "intangible", "goodwill"])
                {
                    Item::IntangibleAssets
                } else if code.starts_with("03")
                    || named(account, &["financi", "deelneming", "participation"])
                {
                    Item::FinancialAssets
                } else {
                    Item::TangibleAssets
                }
            }
            _ if named(
                account,
                &[
                    "voorraad",
                    "inventor",
                    "stock",
                    "onderhanden werk",
                    "work in progress",
                ],
            ) || code.starts_with("150")
                || code.starts_with("151") =>
            {
                Item::Inventories
            }
            _ if named(account, &["effecten", "securities"]) => Item::Securities,
            _ => Item::Receivables,
        }),
        "liability" => Some(if named(account, &["voorziening", "provision"]) {
            Item::Provisions
        } else if code.starts_with('2')
            || named(
                account,
                &["langlopend", "long-term", "long term", "non-current"],
            )
            || subtype == "long_term_liabilities"
        {
            Item::LongTermLiabilities
        } else {
            Item::CurrentLiabilities
        }),
        "equity" => Some(
            if named(
                account,
                &[
                    "aandelenkapitaal",
                    "share capital",
                    "geplaatst kapitaal",
                    "gestort kapitaal",
                ],
            ) || code == "0510"
            {
                Item::ShareCapital
            } else if named(account, &["agio", "share premium"]) {
                Item::SharePremium
            } else if named(account, &["herwaardering", "revaluation"]) {
                Item::RevaluationReserve
            } else if named(account, &["wettelijke reserve", "legal reserve"]) {
                Item::LegalReserves
            } else if named(account, &["statutaire reserve", "statutory reserve"]) {
                Item::StatutoryReserves
            } else {
                Item::OtherReserves
            },
        ),
        _ => None,
    }
}

/// One account's part of a line, for the review screen.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AccountAmount {
    pub item: Item,
    pub account_id: String,
    pub code: String,
    pub name: String,
    pub amount: f64,
}

/// `credit - debit` over rows: the result of revenue and expense rows.
fn result_of(rows: &[AggregateRow]) -> f64 {
    rows.iter()
        .fold(0.0, |total, r| total + (r.credit - r.debit))
}

/// The balance sheet at `end`, for the financial year that started on
/// `start` (both `YYYY-MM-DD`).
pub(crate) async fn balance_sheet(
    ledger: &Ledger,
    start: &str,
    end: &str,
) -> Result<(Lines, Vec<AccountAmount>), BalanceError> {
    let to = parse_report_date(end, Edge::End)?;
    let rows = ledger
        .aggregate(
            LedgerRange { from: None, to },
            AggregateOptions::types(&["asset", "liability", "equity"]),
        )
        .await?;
    let mut lines = Lines::default();
    let mut accounts = Vec::new();
    for row in rows {
        let Some(account) = ledger.account(&row.account_id) else {
            continue;
        };
        let Some(item) = classify(account) else {
            continue;
        };
        let amount = if account.account_type == "asset" {
            row.debit - row.credit
        } else {
            row.credit - row.debit
        };
        if amount.abs() < 0.005 {
            continue;
        }
        lines.add(item, amount);
        accounts.push(AccountAmount {
            item,
            account_id: account.id.clone(),
            code: account.code.clone(),
            name: account.name.clone(),
            amount: cents(amount),
        });
    }
    // Profit and loss never closed to equity: earlier years into other
    // reserves, this year as the result for the year.
    let year_start = parse_report_date(start, Edge::Start)?;
    let earlier = ledger
        .aggregate(
            LedgerRange {
                from: None,
                to: year_start - 1,
            },
            AggregateOptions::types(&["revenue", "expense"]),
        )
        .await?;
    let this_year = ledger
        .aggregate(
            LedgerRange {
                from: Some(year_start),
                to,
            },
            AggregateOptions::types(&["revenue", "expense"]),
        )
        .await?;
    lines.add(Item::OtherReserves, result_of(&earlier));
    lines.add(Item::ResultForTheYear, result_of(&this_year));
    for amount in lines.0.values_mut() {
        *amount = cents(*amount);
    }
    accounts.sort_by(|a, b| a.item.cmp(&b.item).then_with(|| a.code.cmp(&b.code)));
    Ok((lines, accounts))
}

/// Why the balance sheet couldn't be read.
#[derive(Debug)]
pub(crate) enum BalanceError {
    Input(ReportInputError),
    Database(sqlx::Error),
}

impl From<ReportInputError> for BalanceError {
    fn from(error: ReportInputError) -> Self {
        Self::Input(error)
    }
}

impl From<sqlx::Error> for BalanceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `figures`: this year and the year before (`null` when the ledger has
/// nothing at that date, as on a first filing), with the accounts behind
/// each line.
pub(crate) fn figures_json(
    current: &Lines,
    prior: Option<&Lines>,
    current_accounts: &[AccountAmount],
    prior_accounts: &[AccountAmount],
    computed_at: &str,
) -> Value {
    let mut by_account: BTreeMap<(Item, String), Map<String, Value>> = BTreeMap::new();
    for (column, list) in [("current", current_accounts), ("prior", prior_accounts)] {
        for account in list {
            let entry = by_account
                .entry((
                    account.item,
                    account.code.clone() + "\u{0}" + &account.account_id,
                ))
                .or_insert_with(|| {
                    let mut entry = Map::new();
                    entry.insert("item".into(), json!(account.item.key()));
                    entry.insert("accountId".into(), json!(account.account_id));
                    entry.insert("code".into(), json!(account.code));
                    entry.insert("name".into(), json!(account.name));
                    entry.insert("current".into(), json!(0.0));
                    entry.insert("prior".into(), json!(0.0));
                    entry
                });
            entry.insert(column.into(), json!(account.amount));
        }
    }
    json!({
        "current": current.to_json(),
        "prior": prior.map(Lines::to_json),
        "accounts": by_account.into_values().map(Value::Object).collect::<Vec<_>>(),
        "computedAt": computed_at,
        "edited": false,
    })
}

/// Whether nothing was booked: every line zero.
pub(crate) fn is_empty(lines: &Lines) -> bool {
    lines.0.values().all(|amount| amount.abs() < 0.005)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(code: &str, name: &str, account_type: &str, subtype: &str) -> LedgerAccount {
        LedgerAccount {
            id: format!("acc_{code}"),
            code: code.to_owned(),
            name: name.to_owned(),
            account_type: account_type.to_owned(),
            subtype: Some(subtype.to_owned()),
            normal_side: "debit",
            is_active: true,
            tax_line: None,
            form_1099_box: None,
            virtual_account: false,
        }
    }

    #[test]
    fn sorts_the_dutch_chart_into_the_publication_lines() {
        let cases = [
            (
                "0100",
                "Immateriële vaste activa",
                "asset",
                "fixed_assets",
                Item::IntangibleAssets,
            ),
            (
                "0200",
                "Materiële vaste activa",
                "asset",
                "fixed_assets",
                Item::TangibleAssets,
            ),
            (
                "0290",
                "Cumulatieve afschrijvingen",
                "asset",
                "fixed_assets",
                Item::TangibleAssets,
            ),
            (
                "0300",
                "Financiële vaste activa",
                "asset",
                "fixed_assets",
                Item::FinancialAssets,
            ),
            ("1100", "Bank", "asset", "bank", Item::Cash),
            (
                "1300",
                "Debiteuren",
                "asset",
                "accounts_receivable",
                Item::Receivables,
            ),
            (
                "1500",
                "Voorraad",
                "asset",
                "current_assets",
                Item::Inventories,
            ),
            (
                "1510",
                "Onderhanden werk",
                "asset",
                "current_assets",
                Item::Inventories,
            ),
            (
                "1400",
                "Vooruitbetaalde bedragen",
                "asset",
                "current_assets",
                Item::Receivables,
            ),
            ("1520", "BTW te vorderen", "asset", "tax", Item::Receivables),
            (
                "1600",
                "Crediteuren",
                "liability",
                "accounts_payable",
                Item::CurrentLiabilities,
            ),
            (
                "1730",
                "BTW voorbelasting",
                "liability",
                "tax",
                Item::CurrentLiabilities,
            ),
            (
                "2000",
                "Langlopende leningen",
                "liability",
                "accounts_payable",
                Item::LongTermLiabilities,
            ),
            (
                "0700",
                "Voorziening groot onderhoud",
                "liability",
                "accounts_payable",
                Item::Provisions,
            ),
            (
                "0510",
                "Aandelenkapitaal",
                "equity",
                "capital",
                Item::ShareCapital,
            ),
            (
                "0520",
                "Reserves",
                "equity",
                "retained_earnings",
                Item::OtherReserves,
            ),
            (
                "0530",
                "Onverdeelde winst",
                "equity",
                "retained_earnings",
                Item::OtherReserves,
            ),
            (
                "0525",
                "Agioreserve",
                "equity",
                "capital",
                Item::SharePremium,
            ),
        ];
        for (code, name, kind, subtype, item) in cases {
            assert_eq!(
                classify(&account(code, name, kind, subtype)),
                Some(item),
                "{code} {name}"
            );
        }
        assert_eq!(
            classify(&account("8000", "Omzet", "revenue", "sales")),
            None
        );
    }

    #[test]
    fn totals_and_rounds_without_losing_the_balance() {
        let mut lines = Lines::default();
        lines.add(Item::TangibleAssets, 1000.4);
        lines.add(Item::Cash, 500.4);
        lines.add(Item::ShareCapital, 100.0);
        lines.add(Item::ResultForTheYear, 900.8);
        lines.add(Item::CurrentLiabilities, 500.0);
        assert!((lines.assets() - lines.equity_and_liabilities()).abs() < 0.005);
        let rounded = lines.rounded();
        assert_eq!(rounded.get(Item::TangibleAssets), 1000.0);
        assert_eq!(rounded.get(Item::Cash), 500.0);
        assert_eq!(rounded.get(Item::ResultForTheYear), 901.0);
        // 1500 against 1501: the euro goes to other reserves.
        assert_eq!(rounded.get(Item::OtherReserves), -1.0);
        assert_eq!(rounded.assets(), rounded.equity_and_liabilities());
        let parsed = Lines::from_json(&lines.to_json()).expect("lines");
        assert_eq!(parsed.get(Item::Cash), 500.4);
        assert!(!is_empty(&lines));
        assert!(is_empty(&Lines::default()));
    }

    #[test]
    fn writes_figures_with_the_accounts_behind_them() {
        let mut lines = Lines::default();
        lines.add(Item::Cash, 10.0);
        let account = AccountAmount {
            item: Item::Cash,
            account_id: "acc_1100".to_owned(),
            code: "1100".to_owned(),
            name: "Bank".to_owned(),
            amount: 10.0,
        };
        let figures = figures_json(&lines, None, &[account], &[], "2026-01-15T00:00:00.000Z");
        assert_eq!(figures["current"]["cash"], 10.0);
        assert_eq!(figures["prior"], Value::Null);
        assert_eq!(figures["accounts"][0]["code"], "1100");
        assert_eq!(figures["accounts"][0]["prior"], 0.0);
    }
}
